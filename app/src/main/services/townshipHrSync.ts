import {
  all,
  getDatabase,
  loadPersonnelStatusIdentitySets,
  refreshWorksheetPersonnelStatus,
  run
} from '../db/connection'
import { quoteIdentifier } from '../db/schema'
import type {
  TownshipIdCardFillResult,
  TownshipMasterSyncApplyResult,
  TownshipMasterSyncChange,
  TownshipMasterSyncDiff,
  TownshipMasterSyncPreview,
  TownshipNameIssue,
  MasterSyncSelectionItem,
  WorksheetRecordValue
} from '../../shared/types'
import { getWorksheetByName, tableNameOf, tryFindColumnByName } from './worksheetTable'

type Row = Record<string, WorksheetRecordValue | number | undefined>

type SheetCtx = {
  tableName: string
  columns: Map<string, string>
}

type NameIdentityMatch = {
  idCard: string
}

const townshipName = '乡镇补贴'
const masterName = '人事信息'

const masterFieldPairs: Array<{
  source: TownshipMasterSyncChange['sourceFieldName']
  target: TownshipMasterSyncChange['fieldName']
}> = [
  { source: '工作时间', target: '参加工作时间' },
  { source: '工龄', target: '工龄' },
  { source: '乡镇工作年限', target: '乡镇工作年限' }
]

export async function fillTownshipIdCardsByHrName(): Promise<TownshipIdCardFillResult> {
  const database = await getDatabase()
  const township = getSheetCtx(townshipName)
  const master = getSheetCtx(masterName)
  const integratedActive = getSheetCtx('在职工资')
  const integratedRetired = getSheetCtx('退休工资')
  const townshipRows = await all<Row>(database, `SELECT * FROM ${township.tableName}`)
  const masterRows = await all<Row>(database, `SELECT * FROM ${master.tableName}`)
  const integratedActiveRows = await all<Row>(database, `SELECT * FROM ${integratedActive.tableName}`)
  const integratedRetiredRows = await all<Row>(database, `SELECT * FROM ${integratedRetired.tableName}`)
  const identityByName = buildIdentityNameIndex([
    { sheet: master, rows: masterRows, idFieldName: '身份证号码' },
    { sheet: integratedActive, rows: integratedActiveRows, idFieldName: '证件号码' },
    { sheet: integratedRetired, rows: integratedRetiredRows, idFieldName: '证件号码' }
  ])
  const idCardColumn = requireColumn(township, '身份证号')
  const issues: TownshipNameIssue[] = []
  let updatedRows = 0

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const row of townshipRows) {
      const rowId = numberOrZero(row.id)
      const name = normalizeName(readValue(township, row, '姓名'))
      if (!name) continue

      const matched = identityByName.get(name) ?? []
      if (matched.length === 0) {
        issues.push({ name, rowId, reason: 'not-found', matchedCount: 0 })
        continue
      }
      if (matched.length > 1) {
        issues.push({ name, rowId, reason: 'duplicate', matchedCount: matched.length })
        continue
      }

      const idCard = matched[0].idCard
      if (!idCard) {
        issues.push({ name, rowId, reason: 'not-found', matchedCount: 1 })
        continue
      }

      const current = normalizeIdCard(readValue(township, row, '身份证号'))
      if (current === idCard) continue
      await run(
        database,
        `UPDATE ${township.tableName} SET ${quoteIdentifier(idCardColumn)} = ?, "md_updated_at" = ? WHERE "id" = ?`,
        [idCard, new Date().toISOString(), rowId]
      )
      updatedRows += 1
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  if (updatedRows > 0) {
    const { activeIds, retiredIds, otherIds } = await loadPersonnelStatusIdentitySets(database)
    await refreshWorksheetPersonnelStatus(database, getWorksheetByName(townshipName), activeIds, retiredIds, otherIds)
  }

  return {
    updatedRows,
    notFoundRows: issues.filter((issue) => issue.reason === 'not-found').length,
    duplicateRows: issues.filter((issue) => issue.reason === 'duplicate').length,
    issues
  }
}

export async function previewTownshipMasterSync(): Promise<TownshipMasterSyncPreview> {
  return buildTownshipMasterSyncPreview()
}

export async function applyTownshipMasterSync(
  selections?: MasterSyncSelectionItem[]
): Promise<TownshipMasterSyncApplyResult> {
  const preview = filterPreview(buildSelectionSet(selections), await buildTownshipMasterSyncPreview())
  const database = await getDatabase()
  const master = getSheetCtx(masterName)
  let updatedRows = 0

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const diff of preview.diffs) {
      const values: Record<string, string> = {}
      for (const change of diff.changes) {
        const column = master.columns.get(change.fieldName)
        if (column) values[column] = change.nextValue
      }
      const columns = Object.keys(values)
      if (columns.length === 0) continue
      const assignments = columns.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')
      await run(
        database,
        `UPDATE ${master.tableName} SET ${assignments}, "md_updated_at" = ? WHERE "id" = ?`,
        [...columns.map((column) => values[column]), new Date().toISOString(), diff.masterRecordId]
      )
      updatedRows += 1
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  return { updatedRows, affectedRows: updatedRows }
}

function filterPreview(
  selectionSet: Set<string> | undefined,
  preview: TownshipMasterSyncPreview
): TownshipMasterSyncPreview {
  if (!selectionSet) return preview
  const diffs = preview.diffs
    .map((diff) => ({
      ...diff,
      changes: diff.changes.filter((change) =>
        selectionSet.has(selectionKey(diff.townshipRecordId, diff.idCard, change.fieldName))
      )
    }))
    .filter((diff) => diff.changes.length > 0)
  return {
    ...preview,
    diffs,
    updatableRows: diffs.length
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

async function buildTownshipMasterSyncPreview(): Promise<TownshipMasterSyncPreview> {
  const database = await getDatabase()
  const township = getSheetCtx(townshipName)
  const master = getSheetCtx(masterName)
  const townshipRows = await all<Row>(database, `SELECT * FROM ${township.tableName}`)
  const masterRows = await all<Row>(database, `SELECT * FROM ${master.tableName}`)
  const masterByIdCard = new Map<string, Row>()
  for (const row of masterRows) {
    const idCard = normalizeIdCard(readValue(master, row, '身份证号码'))
    if (idCard) masterByIdCard.set(idCard, row)
  }

  const diffs: TownshipMasterSyncDiff[] = []
  let matchedRows = 0
  let missingMasterRows = 0

  for (const row of townshipRows) {
    const idCard = normalizeIdCard(readValue(township, row, '身份证号'))
    if (!idCard) continue
    const masterRow = masterByIdCard.get(idCard)
    if (!masterRow) {
      missingMasterRows += 1
      continue
    }
    matchedRows += 1

    const changes = buildChanges(township, master, row, masterRow)
    if (changes.length === 0) continue
    diffs.push({
      idCard,
      name: text(readValue(township, row, '姓名')) || text(readValue(master, masterRow, '姓名')),
      townshipRecordId: numberOrZero(row.id),
      masterRecordId: numberOrZero(masterRow.id),
      changes
    })
  }

  return {
    sourceRows: townshipRows.length,
    matchedRows,
    missingMasterRows,
    updatableRows: diffs.length,
    diffs
  }
}

function buildChanges(
  township: SheetCtx,
  master: SheetCtx,
  townshipRow: Row,
  masterRow: Row
): TownshipMasterSyncChange[] {
  const changes: TownshipMasterSyncChange[] = []
  for (const pair of masterFieldPairs) {
    const nextValue = text(readValue(township, townshipRow, pair.source))
    if (!nextValue) continue
    const currentValue = text(readValue(master, masterRow, pair.target))
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

function buildIdentityNameIndex(
  sources: Array<{ sheet: SheetCtx; rows: Row[]; idFieldName: string }>
): Map<string, NameIdentityMatch[]> {
  const result = new Map<string, NameIdentityMatch[]>()
  const seen = new Map<string, Set<string>>()
  for (const source of sources) {
    for (const row of source.rows) {
      const name = normalizeName(readValue(source.sheet, row, '姓名'))
      const idCard = normalizeIdCard(readValue(source.sheet, row, source.idFieldName))
      if (!name || !idCard) continue

      const seenKey = idCard
      const seenForName = seen.get(name) ?? new Set<string>()
      if (seenForName.has(seenKey)) continue
      seenForName.add(seenKey)
      seen.set(name, seenForName)

      const bucket = result.get(name) ?? []
      bucket.push({ idCard })
      result.set(name, bucket)
    }
  }
  return result
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

function requireColumn(sheet: SheetCtx, fieldName: string): string {
  const column = sheet.columns.get(fieldName)
  if (!column) throw new Error(`缺少字段：${fieldName}`)
  return column
}

function readValue(sheet: SheetCtx, row: Row, fieldName: string): WorksheetRecordValue | undefined {
  const column = sheet.columns.get(fieldName)
  return column ? row[column] : undefined
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function normalizeName(value: unknown): string {
  return text(value).replace(/\s+/g, '')
}

function normalizeIdCard(value: unknown): string {
  return text(value).replace(/[\s,]/g, '').toUpperCase()
}

function normalizeCompare(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
