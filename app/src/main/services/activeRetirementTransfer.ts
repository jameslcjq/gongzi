import type { Database } from 'sqlite3'
import {
  all,
  get,
  getDatabase,
  refreshAllPersonnelStatuses,
  run
} from '../db/connection'
import { readWorksheetMetadata } from '../db/metadata'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import type {
  ActiveRetirementTransferPreview,
  ActiveRetirementTransferResult,
  WorksheetMeta,
  WorksheetRecordValue
} from '../../shared/types'
import { createOperationBatch, logRowsBeforeDelete } from './operationLog'
import {
  getWorksheetByName,
  tryFindColumnByName
} from './worksheetTable'
import { readMonthlyPayrollSettings } from './monthly-payroll/monthlyPayrollSettings'
import { applyIntegratedComputedFieldsToRows } from './monthly-payroll/integratedPayrollRules'
import {
  getIdentityColumnName,
  getPersonnelStatusColumnName,
  retiredPersonnelStatus,
  normalizeIdentityValue
} from './personnelStatus'

type WorksheetRow = Record<string, unknown>

type RetiredSalaryType = {
  code: string
  name: string
}

type ActiveRetirementPlan = ActiveRetirementTransferPreview & {
  activeWorksheet: WorksheetMeta
  retiredWorksheet: WorksheetMeta
  activeRows: WorksheetRow[]
  targetRows: Array<Record<string, WorksheetRecordValue>>
  activeRecordIds: number[]
}

const activeWorksheetName = '在职工资'
const retiredWorksheetName = '退休工资'
const amountFieldsToClear = new Set([
  '住房补贴',
  '补发工资',
  '其他一',
  '应发工资小计',
  '代扣工资',
  '实发合计'
])

export async function previewActiveRetirementTransfer(
  selectedRecordId: number
): Promise<ActiveRetirementTransferPreview> {
  const database = await getDatabase()
  const plan = await buildActiveRetirementPlan(database, selectedRecordId)
  return toPreview(plan)
}

export async function retireActiveEmployee(
  selectedRecordId: number
): Promise<ActiveRetirementTransferResult> {
  const database = await getDatabase()
  const plan = await buildActiveRetirementPlan(database, selectedRecordId)

  if (!plan.canApply) {
    throw new Error(plan.message || '该人员暂不能转入退休工资')
  }

  const activeTable = quoteIdentifier(plan.activeWorksheet.name)
  const now = new Date().toISOString()

  await run(database, 'BEGIN TRANSACTION')
  try {
    const batchId = await createOperationBatch(database, {
      kind: 'worksheet.retire-active-employee',
      targetType: 'worksheet',
      targetName: `${activeWorksheetName}->${retiredWorksheetName}`,
      reason: '在职工资人员转入退休工资',
      meta: {
        selectedRecordId,
        idCard: plan.idCard,
        name: plan.name,
        activeRecordIds: plan.activeRecordIds,
        batches: plan.batches
      }
    })

    const idPlaceholders = plan.activeRecordIds.map(() => '?').join(', ')
    await logRowsBeforeDelete(database, {
      batchId,
      tableName: plan.activeWorksheet.name,
      worksheetName: plan.activeWorksheet.name,
      action: 'delete',
      whereSql: `"id" IN (${idPlaceholders})`,
      params: plan.activeRecordIds
    })

    for (const values of plan.targetRows) {
      const columns = Object.keys(values)
      const placeholders = columns.map(() => '?').join(', ')
      await run(
        database,
        `INSERT INTO ${quoteIdentifier(plan.retiredWorksheet.name)}
          (${columns.map(quoteIdentifier).join(', ')}, "md_created_at", "md_updated_at")
         VALUES (${placeholders}, ?, ?)`,
        [...columns.map((column) => values[column]), now, now]
      )
    }

    await run(
      database,
      `DELETE FROM import_batch_rows
        WHERE worksheet_name = ?
          AND record_id IN (${idPlaceholders})`,
      [plan.activeWorksheet.name, ...plan.activeRecordIds]
    )
    await run(
      database,
      `DELETE FROM ${activeTable} WHERE "id" IN (${idPlaceholders})`,
      plan.activeRecordIds
    )
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK').catch(() => undefined)
    throw error
  }

  await refreshAllPersonnelStatuses(database)
  const statusUpdatedRows = await markPersonnelRetiredAcrossWorksheets(database, plan.idCard)

  return {
    ...toPreview(plan),
    insertedRows: plan.targetRows.length,
    deletedRows: plan.activeRecordIds.length,
    statusUpdatedRows,
    affectedRows: plan.activeRecordIds.length
  }
}

async function buildActiveRetirementPlan(
  database: Database,
  selectedRecordId: number
): Promise<ActiveRetirementPlan> {
  const activeWorksheet = getWorksheetByName(activeWorksheetName)
  const retiredWorksheet = getWorksheetByName(retiredWorksheetName)
  const activeTable = quoteIdentifier(activeWorksheet.name)
  const retiredTable = quoteIdentifier(retiredWorksheet.name)
  const activeIdColumn = requireColumn(activeWorksheet, '证件号码')
  const retiredIdColumn = requireColumn(retiredWorksheet, '证件号码')
  const activeBatchColumn = requireColumn(activeWorksheet, '工资批次编码')
  const retiredBatchColumn = requireColumn(retiredWorksheet, '工资批次编码')
  const activeNameColumn = tryFindColumnByName(activeWorksheet, '姓名')

  const selectedRow = await get<WorksheetRow>(
    database,
    `SELECT * FROM ${activeTable} WHERE "id" = ? LIMIT 1`,
    [selectedRecordId]
  )
  if (!selectedRow) {
    throw new Error('未找到选中的在职工资记录')
  }

  const idCard = normalizeText(selectedRow[activeIdColumn])
  if (!idCard) {
    throw new Error('选中的在职工资记录缺少证件号码，不能转入退休工资')
  }

  const activeRows = await all<WorksheetRow>(
    database,
    `SELECT * FROM ${activeTable}
      WHERE TRIM(COALESCE(${quoteIdentifier(activeIdColumn)}, '')) = ?
      ORDER BY ${quoteIdentifier(activeBatchColumn)} ASC, "id" ASC`,
    [idCard]
  )
  if (activeRows.length === 0) {
    throw new Error('未找到该人员的在职工资批次记录')
  }

  const retiredRows = await all<WorksheetRow>(
    database,
    `SELECT * FROM ${retiredTable}
      WHERE TRIM(COALESCE(${quoteIdentifier(retiredIdColumn)}, '')) = ?`,
    [idCard]
  )
  const retiredBatchKeys = new Set(
    retiredRows.map((row) => normalizeBatchKey(row[retiredBatchColumn]))
  )
  const duplicateBatches = uniqueStrings(
    activeRows
      .filter((row) => retiredBatchKeys.has(normalizeBatchKey(row[activeBatchColumn])))
      .map((row) => batchLabel(activeWorksheet, row))
  )

  const targetRows = duplicateBatches.length > 0
    ? []
    : await buildRetiredRows(database, activeWorksheet, retiredWorksheet, activeRows)

  const name = activeNameColumn ? normalizeText(selectedRow[activeNameColumn]) : ''
  const activeRecordIds = activeRows
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id) && id > 0)
  const batches = uniqueStrings(activeRows.map((row) => batchLabel(activeWorksheet, row)))
  const canApply = duplicateBatches.length === 0
  const message = canApply
    ? undefined
    : `退休工资已存在同身份证、同批次记录：${duplicateBatches.join('、')}`

  return {
    canApply,
    message,
    sourceWorksheetId: activeWorksheet.worksheetId,
    sourceWorksheetName: activeWorksheet.name,
    targetWorksheetId: retiredWorksheet.worksheetId,
    targetWorksheetName: retiredWorksheet.name,
    idCard,
    name,
    activeRowCount: activeRows.length,
    batches,
    duplicateBatches,
    activeWorksheet,
    retiredWorksheet,
    activeRows,
    targetRows,
    activeRecordIds
  }
}

async function buildRetiredRows(
  database: Database,
  activeWorksheet: WorksheetMeta,
  retiredWorksheet: WorksheetMeta,
  activeRows: WorksheetRow[]
): Promise<Array<Record<string, WorksheetRecordValue>>> {
  const activeColumns = getWorksheetLocalColumns(activeWorksheet)
  const retiredColumns = getWorksheetLocalColumns(retiredWorksheet)
  const activeByFieldName = new Map(activeColumns.map((column) => [column.field.name, column]))
  const monthlyPayrollSettings = await readMonthlyPayrollSettings()
  const result: Array<Record<string, WorksheetRecordValue>> = []
  const salaryTypeCache = new Map<string, RetiredSalaryType>()

  for (const sourceRow of activeRows) {
    const targetRow: Record<string, WorksheetRecordValue> = {}
    const retiredSalaryType = await resolveRetiredSalaryType(
      database,
      activeWorksheet,
      retiredWorksheet,
      sourceRow,
      salaryTypeCache
    )

    for (const targetColumn of retiredColumns) {
      const fieldName = targetColumn.field.name
      if (fieldName === '工资类别编码') {
        targetRow[targetColumn.columnName] = retiredSalaryType.code
        continue
      }
      if (fieldName === '工资类别名称') {
        targetRow[targetColumn.columnName] = retiredSalaryType.name
        continue
      }
      if (amountFieldsToClear.has(fieldName)) {
        targetRow[targetColumn.columnName] = 0
        continue
      }

      const sourceColumn = activeByFieldName.get(fieldName)
      targetRow[targetColumn.columnName] = sourceColumn
        ? toWorksheetValue(sourceRow[sourceColumn.columnName])
        : null
    }

    applyIntegratedComputedFieldsToRows(retiredWorksheet, [targetRow], monthlyPayrollSettings.taxField)
    result.push(targetRow)
  }

  return result
}

async function resolveRetiredSalaryType(
  database: Database,
  activeWorksheet: WorksheetMeta,
  retiredWorksheet: WorksheetMeta,
  sourceRow: WorksheetRow,
  cache: Map<string, RetiredSalaryType>
): Promise<RetiredSalaryType> {
  const activeCodeColumn = tryFindColumnByName(activeWorksheet, '工资类别编码')
  const activeNameColumn = tryFindColumnByName(activeWorksheet, '工资类别名称')
  const sourceCode = activeCodeColumn ? normalizeText(sourceRow[activeCodeColumn]) : ''
  const sourceName = activeNameColumn ? normalizeText(sourceRow[activeNameColumn]) : ''
  const targetName = inferRetiredSalaryTypeName(sourceCode, sourceName)
  const cached = cache.get(targetName)
  if (cached) return cached

  const existing = await findExistingRetiredSalaryType(database, retiredWorksheet, targetName)
  const resolved = existing ?? defaultRetiredSalaryType(targetName)
  cache.set(targetName, resolved)
  return resolved
}

async function findExistingRetiredSalaryType(
  database: Database,
  retiredWorksheet: WorksheetMeta,
  targetName: string
): Promise<RetiredSalaryType | undefined> {
  const codeColumn = tryFindColumnByName(retiredWorksheet, '工资类别编码')
  const nameColumn = tryFindColumnByName(retiredWorksheet, '工资类别名称')
  if (!codeColumn || !nameColumn) return undefined

  const row = await get<{ code: unknown; name: unknown }>(
    database,
    `SELECT ${quoteIdentifier(codeColumn)} AS code,
            ${quoteIdentifier(nameColumn)} AS name,
            COUNT(*) AS total
       FROM ${quoteIdentifier(retiredWorksheet.name)}
      WHERE ${quoteIdentifier(nameColumn)} LIKE ?
      GROUP BY ${quoteIdentifier(codeColumn)}, ${quoteIdentifier(nameColumn)}
      ORDER BY total DESC
      LIMIT 1`,
    [`%${targetName}%`]
  )
  const code = normalizeText(row?.code)
  const name = normalizeText(row?.name)
  if (!name) return undefined
  return { code: code || defaultRetiredSalaryType(targetName).code, name }
}

function inferRetiredSalaryTypeName(sourceCode: string, sourceName: string): string {
  const source = `${sourceCode} ${sourceName}`
  if (/行政/.test(source) || sourceCode === '001') return '行政退休'
  if (/事业/.test(source) || sourceCode === '002') return '事业退休'
  return '事业退休'
}

function defaultRetiredSalaryType(targetName: string): RetiredSalaryType {
  if (targetName === '行政退休') return { code: '004', name: '行政退休' }
  return { code: '006', name: '事业退休' }
}

function requireColumn(worksheet: WorksheetMeta, fieldName: string): string {
  const column = tryFindColumnByName(worksheet, fieldName)
  if (!column) throw new Error(`${worksheet.name} 缺少字段：${fieldName}`)
  return column
}

function batchLabel(worksheet: WorksheetMeta, row: WorksheetRow): string {
  const codeColumn = tryFindColumnByName(worksheet, '工资批次编码')
  const nameColumn = tryFindColumnByName(worksheet, '工资批次名称')
  const code = codeColumn ? normalizeText(row[codeColumn]) : ''
  const name = nameColumn ? normalizeText(row[nameColumn]) : ''
  if (code && name) return `${name}(${code})`
  return code || name || '未记录批次'
}

function normalizeBatchKey(value: unknown): string {
  return normalizeText(value) || '__EMPTY_BATCH__'
}

function normalizeText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function toWorksheetValue(value: unknown): WorksheetRecordValue {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number') return value
  return String(value)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function toPreview(plan: ActiveRetirementPlan): ActiveRetirementTransferPreview {
  return {
    canApply: plan.canApply,
    message: plan.message,
    sourceWorksheetId: plan.sourceWorksheetId,
    sourceWorksheetName: plan.sourceWorksheetName,
    targetWorksheetId: plan.targetWorksheetId,
    targetWorksheetName: plan.targetWorksheetName,
    idCard: plan.idCard,
    name: plan.name,
    activeRowCount: plan.activeRowCount,
    batches: plan.batches,
    duplicateBatches: plan.duplicateBatches
  }
}

async function markPersonnelRetiredAcrossWorksheets(
  database: Database,
  idCard: string
): Promise<number> {
  const normalizedIdCard = normalizeIdentityValue(idCard)
  if (!normalizedIdCard) return 0

  let updatedRows = 0
  const now = new Date().toISOString()

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const worksheet of readWorksheetMetadata()) {
      const identityColumn = getIdentityColumnName(worksheet)
      const statusColumn = getPersonnelStatusColumnName(worksheet)
      if (!identityColumn || !statusColumn) continue

      const columns = await all<{ name: string }>(
        database,
        `PRAGMA table_info(${quoteIdentifier(worksheet.name)})`
      )
      const existingColumns = new Set(columns.map((column) => column.name))
      if (!existingColumns.has(identityColumn) || !existingColumns.has(statusColumn)) continue

      const whereSql = `UPPER(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(${quoteIdentifier(identityColumn)}, '')), ' ', ''), CHAR(9), ''), ',', '')) = ?`
      const countRow = await get<{ total: number }>(
        database,
        `SELECT COUNT(*) AS total FROM ${quoteIdentifier(worksheet.name)} WHERE ${whereSql}`,
        [normalizedIdCard]
      )
      const matchedRows = countRow?.total ?? 0
      if (matchedRows === 0) continue

      await run(
        database,
        `UPDATE ${quoteIdentifier(worksheet.name)}
            SET ${quoteIdentifier(statusColumn)} = ?,
                "md_updated_at" = ?
          WHERE ${whereSql}`,
        [retiredPersonnelStatus, now, normalizedIdCard]
      )
      updatedRows += matchedRows
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK').catch(() => undefined)
    throw error
  }

  return updatedRows
}
