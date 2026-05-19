import {
  all,
  getDatabase,
  loadPersonnelStatusIdentitySets,
  refreshWorksheetPersonnelStatus,
  run,
  runWithLastId
} from '../db/connection'
import { quoteIdentifier } from '../db/schema'
import type {
  BudgetActiveMasterSyncApplyResult,
  BudgetActiveMasterSyncChange,
  BudgetActiveMasterSyncDiff,
  BudgetActiveMasterSyncPreview,
  MasterSyncSelectionItem,
  WorksheetRecordValue
} from '../../shared/types'
import { getWorksheetByName, tableNameOf, tryFindColumnByName } from './worksheetTable'
import { resolvePersonnelStatus } from './personnelStatus'

type Row = Record<string, WorksheetRecordValue | number | undefined>

type SheetCtx = {
  tableName: string
  columns: Map<string, string>
}

const sourceName = '预算在职'
const masterName = '人事信息'

const fieldPairs: Array<{
  source: BudgetActiveMasterSyncChange['sourceFieldName']
  target: BudgetActiveMasterSyncChange['fieldName']
}> = [
  { source: '性别*', target: '性别' },
  { source: '民族*', target: '民族' },
  { source: '参加工作时间*', target: '参加工作时间' }
]

export async function previewBudgetActiveMasterSync(): Promise<BudgetActiveMasterSyncPreview> {
  return buildBudgetActiveMasterSyncPreview()
}

export async function applyBudgetActiveMasterSync(
  selections?: MasterSyncSelectionItem[]
): Promise<BudgetActiveMasterSyncApplyResult> {
  const preview = filterPreview(buildSelectionSet(selections), await buildBudgetActiveMasterSyncPreview())
  const database = await getDatabase()
  const master = getSheetCtx(masterName)
  const masterWorksheet = getWorksheetByName(masterName)
  const { activeIds, retiredIds, otherIds } = await loadPersonnelStatusIdentitySets(database)
  const now = new Date().toISOString()
  let insertedRows = 0
  let updatedRows = 0

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const diff of preview.diffs) {
      const values = valuesFromDiff(master, diff, activeIds, retiredIds, otherIds)
      const columns = Object.keys(values)
      if (columns.length === 0) continue

      if (diff.action === 'insert') {
        const placeholders = columns.map(() => '?').join(', ')
        await runWithLastId(
          database,
          `INSERT INTO ${master.tableName} (${columns.map(quoteIdentifier).join(', ')}, "md_created_at", "md_updated_at") VALUES (${placeholders}, ?, ?)`,
          [...columns.map((column) => values[column]), now, now]
        )
        insertedRows += 1
      } else if (diff.masterRecordId) {
        const assignments = columns.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')
        await run(
          database,
          `UPDATE ${master.tableName} SET ${assignments}, "md_updated_at" = ? WHERE "id" = ?`,
          [...columns.map((column) => values[column]), now, diff.masterRecordId]
        )
        updatedRows += 1
      }
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  await refreshWorksheetPersonnelStatus(database, masterWorksheet, activeIds, retiredIds, otherIds)

  return {
    insertedRows,
    updatedRows,
    affectedRows: insertedRows + updatedRows
  }
}

function filterPreview(
  selectionSet: Set<string> | undefined,
  preview: BudgetActiveMasterSyncPreview
): BudgetActiveMasterSyncPreview {
  if (!selectionSet) return preview
  const diffs = preview.diffs
    .map((diff) => ({
      ...diff,
      changes: diff.changes.filter((change) =>
        selectionSet.has(selectionKey(diff.budgetRecordId, diff.idCard, change.fieldName))
      )
    }))
    .filter((diff) => diff.changes.length > 0)
  return {
    ...preview,
    diffs,
    updatableRows: diffs.length,
    insertRows: diffs.filter((diff) => diff.action === 'insert').length,
    updateRows: diffs.filter((diff) => diff.action === 'update').length
  }
}

function buildSelectionSet(selections?: MasterSyncSelectionItem[]): Set<string> | undefined {
  if (!selections) return undefined
  return new Set(
    selections.map((item) => selectionKey(item.sourceRecordId, item.idCard, item.fieldName))
  )
}

function selectionKey(sourceRecordId: number | undefined, idCard: string, fieldName: string): string {
  return `${sourceRecordId ?? ''}|${normalizeIdCard(idCard)}|${fieldName}`
}

async function buildBudgetActiveMasterSyncPreview(): Promise<BudgetActiveMasterSyncPreview> {
  const database = await getDatabase()
  const source = getSheetCtx(sourceName)
  const master = getSheetCtx(masterName)
  const sourceRows = await all<Row>(database, `SELECT * FROM ${source.tableName}`)
  const masterRows = await all<Row>(database, `SELECT * FROM ${master.tableName}`)
  const masterByIdCard = new Map<string, Row>()
  for (const row of masterRows) {
    const idCard = normalizeIdCard(readValue(master, row, '身份证号码'))
    if (idCard) masterByIdCard.set(idCard, row)
  }

  const diffs: BudgetActiveMasterSyncDiff[] = []
  let missingIdCardRows = 0

  for (const row of sourceRows) {
    const idCard = normalizeIdCard(readValue(source, row, '证件号码*'))
    if (!idCard) {
      missingIdCardRows += 1
      continue
    }

    const masterRow = masterByIdCard.get(idCard)
    const changes = buildChanges(source, master, row, masterRow)
    if (changes.length === 0) continue

    diffs.push({
      idCard,
      name: text(readValue(source, row, '姓名*')),
      budgetRecordId: numberOrZero(row.id),
      masterRecordId: typeof masterRow?.id === 'number' ? masterRow.id : numberOrUndefined(masterRow?.id),
      action: masterRow ? 'update' : 'insert',
      changes
    })
  }

  const insertRows = diffs.filter((diff) => diff.action === 'insert').length
  const updateRows = diffs.length - insertRows
  return {
    sourceRows: sourceRows.length,
    masterRows: masterRows.length,
    updatableRows: diffs.length,
    insertRows,
    updateRows,
    missingIdCardRows,
    diffs
  }
}

function buildChanges(
  source: SheetCtx,
  master: SheetCtx,
  sourceRow: Row,
  masterRow: Row | undefined
): BudgetActiveMasterSyncChange[] {
  const changes: BudgetActiveMasterSyncChange[] = []
  for (const pair of fieldPairs) {
    const nextValue = text(readValue(source, sourceRow, pair.source))
    if (!nextValue) continue
    const currentValue = text(masterRow ? readValue(master, masterRow, pair.target) : '')
    if (pair.target === '民族' && normalizeEthnicity(currentValue) === normalizeEthnicity(nextValue)) continue
    if (normalizeCompare(currentValue) === normalizeCompare(nextValue)) continue
    changes.push({
      fieldName: pair.target,
      sourceFieldName: pair.source,
      currentValue,
      nextValue
    })
  }
  return changes
}

function valuesFromDiff(
  master: SheetCtx,
  diff: BudgetActiveMasterSyncDiff,
  activeIds: Set<string>,
  retiredIds: Set<string>,
  otherIds: Set<string>
): Record<string, string> {
  const values: Record<string, string> = {}
  if (diff.action === 'insert') {
    setValue(values, master, '姓名', diff.name)
    setValue(values, master, '身份证号码', diff.idCard)
  }
  setValue(values, master, '人员状态', resolvePersonnelStatus(diff.idCard, activeIds, retiredIds, otherIds))
  for (const change of diff.changes) {
    setValue(values, master, change.fieldName, change.nextValue)
  }
  return values
}

function getSheetCtx(name: string): SheetCtx {
  const worksheet = getWorksheetByName(name)
  const columns = new Map<string, string>()
  for (const field of worksheet.fields) {
    const columnName = tryFindColumnByName(worksheet, field.name)
    if (columnName) columns.set(field.name, columnName)
  }
  return { tableName: tableNameOf(worksheet), columns }
}

function readValue(sheet: SheetCtx, row: Row, fieldName: string): WorksheetRecordValue | undefined {
  const column = sheet.columns.get(fieldName)
  return column ? row[column] : undefined
}

function setValue(values: Record<string, string>, sheet: SheetCtx, fieldName: string, value: string): void {
  const column = sheet.columns.get(fieldName)
  if (column && value) values[column] = value
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function normalizeIdCard(value: unknown): string {
  return text(value).replace(/[\s,]/g, '').toUpperCase()
}

function normalizeCompare(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

function normalizeEthnicity(value: string): string {
  const normalized = value.replace(/\s+/g, '')
  return normalized.endsWith('族') ? normalized.slice(0, -1) : normalized
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
