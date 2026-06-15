import type { Database } from 'sqlite3'
import {
  all,
  get,
  getDatabase,
  refreshAllPersonnelStatuses,
  run,
  runWithLastId
} from '../db/connection'
import { readWorksheetMetadata } from '../db/metadata'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import type {
  ActiveRetirementRevertPreview,
  ActiveRetirementRevertResult,
  ActiveRetirementTransferPreview,
  ActiveRetirementTransferResult,
  WorksheetMeta,
  WorksheetRecordValue
} from '../../shared/types'
import { createOperationBatch, logRecordSnapshots, logRowsBeforeDelete } from './operationLog'
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
const retireBatchKind = 'worksheet.retire-active-employee'
const retireRevertBatchKind = 'worksheet.retire-active-employee.revert'
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
    const batchMeta: Record<string, unknown> = {
      selectedRecordId,
      idCard: plan.idCard,
      name: plan.name,
      activeRecordIds: plan.activeRecordIds,
      batches: plan.batches
    }
    const batchId = await createOperationBatch(database, {
      kind: retireBatchKind,
      targetType: 'worksheet',
      targetName: `${activeWorksheetName}->${retiredWorksheetName}`,
      reason: '在职工资人员转入退休工资',
      meta: batchMeta
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

    // 记下本次新建的退休行 id，撤销时据此精确删除，不会误删该人已有的退休记录。
    const insertedRetiredIds: number[] = []
    for (const values of plan.targetRows) {
      const columns = Object.keys(values)
      const placeholders = columns.map(() => '?').join(', ')
      const { lastId } = await runWithLastId(
        database,
        `INSERT INTO ${quoteIdentifier(plan.retiredWorksheet.name)}
          (${columns.map(quoteIdentifier).join(', ')}, "md_created_at", "md_updated_at")
         VALUES (${placeholders}, ?, ?)`,
        [...columns.map((column) => values[column]), now, now]
      )
      if (Number.isFinite(lastId) && lastId > 0) insertedRetiredIds.push(lastId)
    }
    batchMeta.insertedRetiredIds = insertedRetiredIds
    await run(database, `UPDATE operation_batches SET meta_json = ? WHERE id = ?`, [
      JSON.stringify(batchMeta),
      batchId
    ])

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

type RetireBatchInfo = {
  batchId: number
  kind: string
  idCard: string
  name: string
  batches: string[]
  activeRecordIds: number[]
  // null 表示旧版本退休批次未登记退休行，无法自动撤销
  insertedRetiredIds: number[] | null
}

type RetireDeleteSnapshot = {
  id: number
  table_name: string
  worksheet_name: string | null
  record_id: number | null
  before_values: string | null
}

export async function previewActiveRetirementRevert(
  batchId: number
): Promise<ActiveRetirementRevertPreview> {
  const database = await getDatabase()
  const info = await loadRetireBatch(database, batchId)
  const base: ActiveRetirementRevertPreview = {
    batchId,
    canRevert: false,
    idCard: info?.idCard ?? '',
    name: info?.name ?? '',
    batches: info?.batches ?? [],
    activeRowsToRestore: 0,
    retiredRowsToDelete: 0,
    retiredRowsMissing: 0,
    modifiedRetiredRows: 0
  }

  const blockMessage = await resolveRevertBlock(database, info, batchId)
  if (blockMessage) return { ...base, message: blockMessage }

  const insertedRetiredIds = info!.insertedRetiredIds ?? []
  const activeRowsToRestore = await countActiveDeleteSnapshots(database, batchId)
  const retiredStat = await inspectRetiredRows(database, insertedRetiredIds)
  return {
    ...base,
    canRevert: true,
    activeRowsToRestore,
    retiredRowsToDelete: retiredStat.present,
    retiredRowsMissing: retiredStat.missing,
    modifiedRetiredRows: retiredStat.modified
  }
}

export async function revertActiveRetirement(
  batchId: number
): Promise<ActiveRetirementRevertResult> {
  const database = await getDatabase()
  const info = await loadRetireBatch(database, batchId)
  const blockMessage = await resolveRevertBlock(database, info, batchId)
  if (blockMessage) throw new Error(blockMessage)

  const insertedRetiredIds = info!.insertedRetiredIds ?? []
  const snapshots = await all<RetireDeleteSnapshot>(
    database,
    `SELECT id, table_name, worksheet_name, record_id, before_values
       FROM record_change_logs
      WHERE batch_id = ?
        AND table_name = ?
        AND action = 'delete'
        AND before_values IS NOT NULL
      ORDER BY id ASC`,
    [batchId, activeWorksheetName]
  )

  const result: ActiveRetirementRevertResult = {
    batchId,
    revertBatchId: 0,
    idCard: info!.idCard,
    name: info!.name,
    restoredActiveRows: 0,
    conflictActiveRows: 0,
    deletedRetiredRows: 0,
    statusRefreshed: false,
    messages: []
  }

  await run(database, 'BEGIN TRANSACTION')
  try {
    const revertBatchId = await createOperationBatch(database, {
      kind: retireRevertBatchKind,
      targetType: 'worksheet',
      targetName: `${retiredWorksheetName}->${activeWorksheetName}`,
      reason: '撤销人员转退休，恢复为在职',
      meta: {
        sourceBatchId: batchId,
        idCard: info!.idCard,
        name: info!.name,
        batches: info!.batches
      }
    })
    result.revertBatchId = revertBatchId

    // 1) 按原 id 补回在职工资行；若该 id 已被占用则跳过，不覆盖现有数据
    for (const snapshot of snapshots) {
      const status = await restoreActiveRow(database, revertBatchId, snapshot)
      if (status === 'restored') result.restoredActiveRows += 1
      else if (status === 'conflict') result.conflictActiveRows += 1
    }

    // 2) 删除本次退休新建的退休工资行；删除前留快照便于审计（强制撤销，手工改动会一并删除）
    result.deletedRetiredRows = await deleteInsertedRetiredRows(
      database,
      revertBatchId,
      insertedRetiredIds
    )

    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK').catch(() => undefined)
    throw error
  }

  // 人员状态完全由"人员在哪张源表"推导，补回在职 + 删退休后重算即可恢复为在职
  await refreshAllPersonnelStatuses(database)
  result.statusRefreshed = true

  result.messages.push(
    `已恢复在职工资 ${result.restoredActiveRows} 行` +
      (result.conflictActiveRows > 0
        ? `（${result.conflictActiveRows} 行原记录已存在，未覆盖）`
        : '') +
      `，删除退休工资 ${result.deletedRetiredRows} 行，人员状态已刷新为在职`
  )
  return result
}

async function loadRetireBatch(
  database: Database,
  batchId: number
): Promise<RetireBatchInfo | undefined> {
  const row = await get<{ id: number; kind: string; meta_json: string | null }>(
    database,
    `SELECT id, kind, meta_json FROM operation_batches WHERE id = ? LIMIT 1`,
    [batchId]
  )
  if (!row) return undefined
  const meta = parseMetaObject(row.meta_json)
  const insertedRetiredIds = Array.isArray(meta.insertedRetiredIds)
    ? toIdList(meta.insertedRetiredIds)
    : null
  return {
    batchId: Number(row.id),
    kind: normalizeText(row.kind),
    idCard: normalizeText(meta.idCard),
    name: normalizeText(meta.name),
    batches: Array.isArray(meta.batches)
      ? uniqueStrings(meta.batches.map((value) => normalizeText(value)))
      : [],
    activeRecordIds: Array.isArray(meta.activeRecordIds) ? toIdList(meta.activeRecordIds) : [],
    insertedRetiredIds
  }
}

async function resolveRevertBlock(
  database: Database,
  info: RetireBatchInfo | undefined,
  batchId: number
): Promise<string | undefined> {
  if (!info) return '未找到该操作批次'
  if (info.kind !== retireBatchKind) return '该批次不是人员转退休操作'
  if (info.insertedRetiredIds === null) {
    return '此退休记录由旧版本生成，未登记退休行，无法自动撤销，请手工处理'
  }
  const existingRevert = await findExistingRevertBatchId(database, batchId)
  if (existingRevert) return '该退休操作已撤销过，无需重复撤销'
  return undefined
}

async function findExistingRevertBatchId(
  database: Database,
  sourceBatchId: number
): Promise<number | undefined> {
  const rows = await all<{ id: number; meta_json: string | null }>(
    database,
    `SELECT id, meta_json FROM operation_batches WHERE kind = ? ORDER BY id DESC`,
    [retireRevertBatchKind]
  )
  for (const row of rows) {
    const meta = parseMetaObject(row.meta_json)
    if (Number(meta.sourceBatchId) === sourceBatchId) return Number(row.id)
  }
  return undefined
}

async function countActiveDeleteSnapshots(database: Database, batchId: number): Promise<number> {
  const row = await get<{ total: number }>(
    database,
    `SELECT COUNT(*) AS total FROM record_change_logs
      WHERE batch_id = ?
        AND table_name = ?
        AND action = 'delete'
        AND before_values IS NOT NULL`,
    [batchId, activeWorksheetName]
  )
  return Number(row?.total ?? 0)
}

async function inspectRetiredRows(
  database: Database,
  ids: number[]
): Promise<{ present: number; missing: number; modified: number }> {
  const retiredTable = quoteIdentifier(retiredWorksheetName)
  let present = 0
  let missing = 0
  let modified = 0
  for (const id of ids) {
    const row = await get<{ created: unknown; updated: unknown }>(
      database,
      `SELECT "md_created_at" AS created, "md_updated_at" AS updated
         FROM ${retiredTable} WHERE "id" = ? LIMIT 1`,
      [id]
    )
    if (!row) {
      missing += 1
      continue
    }
    present += 1
    // 退休行不参与人员状态刷新，新建时 created==updated；不一致即转入后被手工改过
    if (normalizeText(row.created) !== normalizeText(row.updated)) modified += 1
  }
  return { present, missing, modified }
}

async function restoreActiveRow(
  database: Database,
  revertBatchId: number,
  snapshot: RetireDeleteSnapshot
): Promise<'restored' | 'conflict' | 'skipped'> {
  const beforeValues = parseMetaObject(snapshot.before_values)
  if (Object.keys(beforeValues).length === 0) return 'skipped'

  const columns = await all<{ name: string }>(
    database,
    `PRAGMA table_info(${quoteIdentifier(snapshot.table_name)})`
  )
  if (columns.length === 0) return 'skipped'
  const columnNames = new Set(columns.map((column) => column.name))

  const values: Record<string, unknown> = { ...beforeValues }
  const originalId = Object.prototype.hasOwnProperty.call(values, 'id')
    ? values.id
    : snapshot.record_id
  if (
    columnNames.has('id') &&
    originalId !== null &&
    originalId !== undefined &&
    originalId !== ''
  ) {
    const existing = await get<{ id: number }>(
      database,
      `SELECT "id" FROM ${quoteIdentifier(snapshot.table_name)} WHERE "id" = ? LIMIT 1`,
      [originalId]
    )
    if (existing) return 'conflict'
    values.id = originalId
  }

  const insertColumns = Object.keys(values).filter((column) => columnNames.has(column))
  if (insertColumns.length === 0) return 'skipped'
  const placeholders = insertColumns.map(() => '?').join(', ')
  await run(
    database,
    `INSERT INTO ${quoteIdentifier(snapshot.table_name)}
      (${insertColumns.map(quoteIdentifier).join(', ')})
     VALUES (${placeholders})`,
    insertColumns.map((column) => values[column])
  )

  await logRecordSnapshots(database, {
    batchId: revertBatchId,
    tableName: snapshot.table_name,
    worksheetName: snapshot.worksheet_name ?? snapshot.table_name,
    action: 'restore',
    rows: [{ id: values.id ?? originalId }],
    afterValues: { sourceChangeLogId: snapshot.id }
  })
  return 'restored'
}

async function deleteInsertedRetiredRows(
  database: Database,
  revertBatchId: number,
  ids: number[]
): Promise<number> {
  const retiredTable = quoteIdentifier(retiredWorksheetName)
  let deleted = 0
  for (const id of ids) {
    const row = await get<Record<string, unknown>>(
      database,
      `SELECT * FROM ${retiredTable} WHERE "id" = ? LIMIT 1`,
      [id]
    )
    if (!row) continue
    await logRecordSnapshots(database, {
      batchId: revertBatchId,
      tableName: retiredWorksheetName,
      worksheetName: retiredWorksheetName,
      action: 'archive',
      rows: [row]
    })
    await run(database, `DELETE FROM ${retiredTable} WHERE "id" = ?`, [id])
    deleted += 1
  }
  return deleted
}

function parseMetaObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function toIdList(values: unknown[]): number[] {
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
}
