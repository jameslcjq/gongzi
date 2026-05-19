import { all, get, getDatabase, refreshAllPersonnelStatuses, run, runWithLastId } from '../db/connection'
import { readWorksheetMetadata } from '../db/metadata'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import {
  getPersonnelStatusViewCondition,
  isPersonnelStatusSourceWorksheet,
  isPersonnelStatusTargetWorksheet
} from './personnelStatus'
import type {
  WorksheetMeta,
  WorksheetMutationResult,
  WorksheetRecord,
  WorksheetRecordValue
} from '../../shared/types'
import { getWorksheetById } from './worksheetTable'

export async function createRecord(
  worksheetId: string,
  values: Record<string, WorksheetRecordValue>,
  options?: { batchId?: number }
): Promise<WorksheetMutationResult & { recordId: number }> {
  const worksheet = getWorksheetById(worksheetId)
  const tableName = quoteIdentifier(worksheet.name)
  const sanitized = sanitizeValues(worksheet, values)
  applyManualBudgetStatusCreateValues(worksheet, sanitized)

  if (Object.keys(sanitized).length === 0) {
    throw new Error('没有可写入的字段')
  }

  const columns = Object.keys(sanitized)
  const placeholders = columns.map(() => '?').join(', ')
  const sql = `INSERT INTO ${tableName} (${columns.map(quoteIdentifier).join(', ')}, "md_created_at", "md_updated_at") VALUES (${placeholders}, ?, ?)`
  const now = new Date().toISOString()
  const params = [...columns.map((column) => sanitized[column]), now, now]

  const database = await getDatabase()
  const { lastId } = await runWithLastId(database, sql, params)

  if (options?.batchId) {
    await run(
      database,
      `INSERT INTO import_batch_rows (batch_id, worksheet_name, record_id) VALUES (?, ?, ?)`,
      [options.batchId, worksheet.name, lastId]
    )
  }
  await refreshPersonnelStatusesForWorksheet(database, worksheet)

  return {
    worksheetId: worksheet.worksheetId,
    worksheetName: worksheet.name,
    affectedRows: 1,
    recordId: lastId
  }
}

export async function updateRecord(
  worksheetId: string,
  recordId: number,
  values: Record<string, WorksheetRecordValue>
): Promise<WorksheetMutationResult> {
  const worksheet = getWorksheetById(worksheetId)
  const tableName = quoteIdentifier(worksheet.name)
  const sanitized = sanitizeValues(worksheet, values)
  const database = await getDatabase()
  await applyManualBudgetStatusUpdateValues(database, worksheet, recordId, sanitized)

  if (Object.keys(sanitized).length === 0) {
    throw new Error('没有可更新的字段')
  }

  const columns = Object.keys(sanitized)
  const assignments = columns.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')
  const sql = `UPDATE ${tableName} SET ${assignments}, "md_updated_at" = ? WHERE "id" = ?`
  const params = [...columns.map((column) => sanitized[column]), new Date().toISOString(), recordId]

  await run(database, sql, params)
  await refreshPersonnelStatusesForWorksheet(database, worksheet)

  return {
    worksheetId: worksheet.worksheetId,
    worksheetName: worksheet.name,
    affectedRows: 1
  }
}

export async function deleteRecord(
  worksheetId: string,
  recordId: number
): Promise<WorksheetMutationResult> {
  const worksheet = getWorksheetById(worksheetId)
  const tableName = quoteIdentifier(worksheet.name)
  const database = await getDatabase()
  await run(database, `DELETE FROM ${tableName} WHERE "id" = ?`, [recordId])
  await refreshPersonnelStatusesForWorksheet(database, worksheet)

  return {
    worksheetId: worksheet.worksheetId,
    worksheetName: worksheet.name,
    affectedRows: 1
  }
}

export async function deleteRecords(
  worksheetId: string,
  recordIds: number[]
): Promise<WorksheetMutationResult> {
  const worksheet = getWorksheetById(worksheetId)
  if (recordIds.length === 0) {
    return { worksheetId: worksheet.worksheetId, worksheetName: worksheet.name, affectedRows: 0 }
  }
  const tableName = quoteIdentifier(worksheet.name)
  const database = await getDatabase()

  await run(database, 'BEGIN TRANSACTION')
  try {
    const placeholders = recordIds.map(() => '?').join(', ')
    await run(database, `DELETE FROM ${tableName} WHERE "id" IN (${placeholders})`, recordIds)
    await run(
      database,
      `DELETE FROM import_batch_rows WHERE worksheet_name = ? AND record_id IN (${placeholders})`,
      [worksheet.name, ...recordIds]
    )
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }
  await refreshPersonnelStatusesForWorksheet(database, worksheet)

  return {
    worksheetId: worksheet.worksheetId,
    worksheetName: worksheet.name,
    affectedRows: recordIds.length
  }
}

export async function clearWorksheet(
  worksheetId: string
): Promise<WorksheetMutationResult> {
  const worksheet = getWorksheetById(worksheetId)
  const tableName = quoteIdentifier(worksheet.name)
  const database = await getDatabase()

  const totalRow = await get<{ total: number }>(
    database,
    `SELECT COUNT(*) AS total FROM ${tableName}`
  )
  const total = totalRow?.total ?? 0

  await run(database, 'BEGIN TRANSACTION')
  try {
    await run(database, `DELETE FROM ${tableName}`)
    await run(database, `DELETE FROM import_batch_rows WHERE worksheet_name = ?`, [worksheet.name])
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }
  await refreshPersonnelStatusesForWorksheet(database, worksheet)

  return {
    worksheetId: worksheet.worksheetId,
    worksheetName: worksheet.name,
    affectedRows: total
  }
}

export async function wipeAllWorksheetData(): Promise<{ tables: number; rows: number }> {
  const database = await getDatabase()
  const worksheets = readWorksheetMetadata()
  const retainedBaseTables = new Set(['岗位工资对照', '薪级工资对照', '乡镇工作年限对照'])

  let totalRows = 0
  let clearedTables = 0
  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const worksheet of worksheets) {
      if (retainedBaseTables.has(worksheet.name)) continue
      const tableName = quoteIdentifier(worksheet.name)
      const totalRow = await get<{ total: number }>(
        database,
        `SELECT COUNT(*) AS total FROM ${tableName}`
      )
      totalRows += totalRow?.total ?? 0
      clearedTables += 1
      await run(database, `DELETE FROM ${tableName}`)
    }
    await run(database, `DELETE FROM import_batch_rows`)
    await run(database, `DELETE FROM import_batches`)
    await run(database, `DELETE FROM import_logs`)
    await run(database, `DELETE FROM workflow_runs`)
    await run(database, `DELETE FROM operation_logs`)
    await run(database, `DELETE FROM personnel_status_index`)
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  return { tables: clearedTables, rows: totalRows }
}

async function refreshPersonnelStatusesForWorksheet(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: WorksheetMeta
): Promise<void> {
  if (!isPersonnelStatusSourceWorksheet(worksheet.name) && !isPersonnelStatusTargetWorksheet(worksheet)) return
  await refreshAllPersonnelStatuses(database)
}

export async function listRecords(
  worksheetId: string,
  options: {
    limit?: number
    offset?: number
    search?: string
    view?: string
    sortColumn?: string
    sortOrder?: 'asc' | 'desc'
  } = {}
): Promise<{
  worksheetId: string
  worksheetName: string
  total: number
  limit: number
  offset: number
  rows: WorksheetRecord[]
}> {
  const worksheet = getWorksheetById(worksheetId)
  const tableName = quoteIdentifier(worksheet.name)
  const limit = clamp(options.limit ?? 100, 1, 100000)
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const search = (options.search ?? '').trim()
  const view = (options.view ?? '').trim()

  const localColumns = getWorksheetLocalColumns(worksheet).map((column) => column.columnName)
  const params: unknown[] = []
  const conditions: string[] = []

  if (search && localColumns.length > 0) {
    const searchConditions = localColumns
      .map((column) => `${quoteIdentifier(column)} LIKE ?`)
      .join(' OR ')
    conditions.push(`(${searchConditions})`)
    for (let index = 0; index < localColumns.length; index += 1) {
      params.push(`%${search}%`)
    }
  }
  const viewCondition = getViewCondition(worksheet, view)
  if (viewCondition) conditions.push(viewCondition)

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''

  let orderBy = `ORDER BY "id" DESC`
  const requestedSort = (options.sortColumn ?? '').trim()
  if (requestedSort && localColumns.includes(requestedSort)) {
    const direction = options.sortOrder === 'asc' ? 'ASC' : 'DESC'
    orderBy = `ORDER BY ${quoteIdentifier(requestedSort)} ${direction}, "id" DESC`
  }

  const database = await getDatabase()
  const rows = await all<WorksheetRecord>(
    database,
    `SELECT * FROM ${tableName}${whereClause} ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )
  const totalRow = await get<{ total: number }>(
    database,
    `SELECT COUNT(*) AS total FROM ${tableName}${whereClause}`,
    params
  )

  return {
    worksheetId: worksheet.worksheetId,
    worksheetName: worksheet.name,
    total: totalRow?.total ?? 0,
    limit,
    offset,
    rows
  }
}

export function getViewCondition(worksheet: WorksheetMeta, view: string): string {
  const personnelCondition = getPersonnelStatusViewCondition(worksheet, view)
  if (personnelCondition) return personnelCondition

  const budgetCondition = getBudgetStatusViewCondition(worksheet, view)
  if (budgetCondition) return budgetCondition

  const integratedBatchCondition = getIntegratedBatchViewCondition(worksheet, view)
  if (integratedBatchCondition) return integratedBatchCondition

  if (worksheet.name !== '\u4e61\u9547\u8865\u8d34' || view !== '\u5f53\u5e74\u5e94\u8c03\u6574') {
    return ''
  }
  const columns = getWorksheetLocalColumns(worksheet)
  const townshipYears = columns.find((column) => column.field.name === '\u4e61\u9547\u5de5\u4f5c\u5e74\u9650')
  const lookup = readWorksheetMetadata().find(
    (item) => item.name === '\u4e61\u9547\u5de5\u4f5c\u5e74\u9650\u5bf9\u7167'
  )
  if (!townshipYears || !lookup) return ''

  const lookupYears = getWorksheetLocalColumns(lookup).find(
    (column) => column.field.name === '\u4e61\u9547\u5de5\u4f5c\u5e74\u9650'
  )
  if (!lookupYears) return ''

  const allowanceTable = quoteIdentifier(worksheet.name)
  const lookupTable = quoteIdentifier(lookup.name)
  const allowanceYears = `${allowanceTable}.${quoteIdentifier(townshipYears.columnName)}`
  const lookupYearsColumn = `${lookupTable}.${quoteIdentifier(lookupYears.columnName)}`

  return `
    EXISTS (
      SELECT 1 FROM ${lookupTable}
      WHERE CAST(${lookupYearsColumn} AS REAL) = CAST(${allowanceYears} AS REAL)
        AND CAST(${lookupYearsColumn} AS REAL) > 1
    )
  `
}

function getIntegratedBatchViewCondition(worksheet: WorksheetMeta, view: string): string {
  if (worksheet.name !== '一体化在职') return ''
  if (!view || view === '全部') return ''
  const batchCodeByView: Record<string, string> = {
    '工资(001)': '001',
    '数币(002)': '002'
  }
  const code = batchCodeByView[view]
  if (!code) return ''
  const batchColumn = getWorksheetLocalColumns(worksheet).find(
    (column) => column.field.name === '工资批次'
  )
  if (!batchColumn) return ''
  return `${quoteIdentifier(batchColumn.columnName)} = '${code}'`
}

function getBudgetStatusViewCondition(worksheet: WorksheetMeta, view: string): string {
  if (!view || view === '全部') return ''
  const budgetStatusViews = new Map<string, Map<string, string>>([
    [
      '预算在职',
      new Map([
        ['正常', '正常'],
        ['调出人员', '调出人员']
      ])
    ],
    [
      '预算退休',
      new Map([
        ['正常', '正常'],
        ['去世', '去世']
      ])
    ],
    [
      '预算其他',
      new Map([
        ['正常', '正常'],
        ['去世', '去世']
      ])
    ]
  ])
  const status = budgetStatusViews.get(worksheet.name)?.get(view)
  if (!status) return ''

  if (status === '正常') {
    return `("md_status" IS NULL OR "md_status" = '' OR "md_status" = '正常')`
  }
  return `"md_status" = '${status.replaceAll("'", "''")}'`
}

export type PersonnelChildRecords = {
  worksheetName: string
  fields: Array<{ name: string; columnName: string }>
  rows: WorksheetRecord[]
}

export async function listPersonnelChildRecords(
  idCardValue: string
): Promise<PersonnelChildRecords[]> {
  if (!idCardValue) return []

  const childIds = ['local-hr-edu', 'local-hr-cert', 'local-hr-teach', 'local-hr-work']
  const allWorksheets = readWorksheetMetadata()
  const database = await getDatabase()
  const results: PersonnelChildRecords[] = []

  for (const childId of childIds) {
    const worksheet = allWorksheets.find((item) => item.worksheetId === childId)
    if (!worksheet) continue

    const columns = getWorksheetLocalColumns(worksheet)
    const idColumn = columns.find((column) => column.field.name === '教职工身份证号')
    if (!idColumn) continue

    const tableName = quoteIdentifier(worksheet.name)
    const rows = await all<WorksheetRecord>(
      database,
      `SELECT * FROM ${tableName} WHERE ${quoteIdentifier(idColumn.columnName)} = ? ORDER BY "id"`,
      [idCardValue]
    )

    const fields = columns
      .filter((column) => column.field.name !== '教职工身份证号')
      .map((column) => ({ name: column.field.name, columnName: column.columnName }))

    results.push({ worksheetName: worksheet.name, fields, rows })
  }

  return results
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function sanitizeValues(
  worksheet: WorksheetMeta,
  values: Record<string, WorksheetRecordValue>
): Record<string, WorksheetRecordValue> {
  const allowed = new Set(getWorksheetLocalColumns(worksheet).map((column) => column.columnName))
  if (isBudgetStatusWorksheet(worksheet.name)) allowed.add('md_status')
  const result: Record<string, WorksheetRecordValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) continue
    if (value === undefined) continue
    result[key] = value === '' ? null : value
  }
  return result
}

function isBudgetStatusWorksheet(worksheetName: string): boolean {
  return worksheetName === '预算在职' || worksheetName === '预算退休' || worksheetName === '预算其他'
}

function applyManualBudgetStatusCreateValues(
  worksheet: WorksheetMeta,
  values: Record<string, WorksheetRecordValue>
): void {
  if (!isBudgetStatusWorksheet(worksheet.name) || !hasOwn(values, 'md_status')) return
  values.md_status_changed_at = new Date().toISOString()
  values.md_status_reason = '手工设置'
}

async function applyManualBudgetStatusUpdateValues(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: WorksheetMeta,
  recordId: number,
  values: Record<string, WorksheetRecordValue>
): Promise<void> {
  if (!isBudgetStatusWorksheet(worksheet.name) || !hasOwn(values, 'md_status')) return

  const current = await get<{ md_status: string | null; md_status_reason: string | null }>(
    database,
    `SELECT "md_status", "md_status_reason" FROM ${quoteIdentifier(worksheet.name)} WHERE "id" = ?`,
    [recordId]
  )
  const nextStatus = String(values.md_status ?? '')
  const currentStatus = String(current?.md_status ?? '')
  if (nextStatus === currentStatus) return

  values.md_status_changed_at = new Date().toISOString()
  values.md_status_reason = '手工设置'
}

function hasOwn(values: Record<string, WorksheetRecordValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key)
}
