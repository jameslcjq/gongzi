import {
  all,
  getDatabase,
  loadPersonnelStatusIdentitySets,
  refreshWorksheetPersonnelStatus,
  run,
  runWithLastId
} from '../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import type {
  TeacherDetailMasterSyncApplyResult,
  TeacherDetailMasterSyncChange,
  TeacherDetailMasterSyncDiff,
  TeacherDetailMasterSyncPreview,
  MasterSyncSelectionItem,
  WorksheetMeta,
  WorksheetRecordValue
} from '../../shared/types'
import { getWorksheetByName, tableNameOf, tryFindColumnByName } from './worksheetTable'
import { resolvePersonnelStatus } from './personnelStatus'

type Row = Record<string, WorksheetRecordValue | number | undefined>

type SheetCtx = {
  worksheet: WorksheetMeta
  tableName: string
  columns: Map<string, string>
}

const sourceName = '在编教职工基本信息'
const masterName = '人事信息'
const idCardField = '身份证号码'
const excludedCompareFields = new Set(['序号', '备注'])

export async function previewTeacherDetailMasterSync(): Promise<TeacherDetailMasterSyncPreview> {
  return buildTeacherDetailMasterSyncPreview()
}

export async function applyTeacherDetailMasterSync(
  selections?: MasterSyncSelectionItem[]
): Promise<TeacherDetailMasterSyncApplyResult> {
  const preview = filterPreview(buildSelectionSet(selections), await buildTeacherDetailMasterSyncPreview())
  const database = await getDatabase()
  const master = getSheetCtx(masterName)
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

  await refreshWorksheetPersonnelStatus(database, master.worksheet, activeIds, retiredIds, otherIds)

  return {
    insertedRows,
    updatedRows,
    affectedRows: insertedRows + updatedRows
  }
}

function filterPreview(
  selectionSet: Set<string> | undefined,
  preview: TeacherDetailMasterSyncPreview
): TeacherDetailMasterSyncPreview {
  if (!selectionSet) return preview
  const diffs = preview.diffs
    .map((diff) => ({
      ...diff,
      changes: diff.changes.filter((change) =>
        selectionSet.has(selectionKey(diff.sourceRecordId, diff.idCard, change.fieldName))
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

async function buildTeacherDetailMasterSyncPreview(): Promise<TeacherDetailMasterSyncPreview> {
  const database = await getDatabase()
  const source = getSheetCtx(sourceName)
  const master = getSheetCtx(masterName)
  const comparedFields = getCommonFields(source.worksheet, master.worksheet)
  const highestEducationByIdCard = await loadHighestEducationByIdCard(database)
  const sourceRows = await all<Row>(database, `SELECT * FROM ${source.tableName}`)
  const masterRows = await all<Row>(database, `SELECT * FROM ${master.tableName}`)
  const masterByIdCard = new Map<string, Row>()
  for (const row of masterRows) {
    const idCard = normalizeIdCard(readValue(master, row, idCardField))
    if (idCard) masterByIdCard.set(idCard, row)
  }

  const diffs: TeacherDetailMasterSyncDiff[] = []
  let missingIdCardRows = 0

  for (const row of sourceRows) {
    const idCard = normalizeIdCard(readValue(source, row, idCardField))
    if (!idCard) {
      missingIdCardRows += 1
      continue
    }

    const masterRow = masterByIdCard.get(idCard)
    const changes = buildChanges(
      source,
      master,
      row,
      masterRow,
      comparedFields,
      idCard,
      highestEducationByIdCard.get(idCard)
    )
    if (changes.length === 0) continue

    diffs.push({
      idCard,
      name: text(readValue(source, row, '姓名')),
      sourceRecordId: numberOrZero(row.id),
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
    comparedFields,
    updatableRows: diffs.length,
    insertRows,
    updateRows,
    missingIdCardRows,
    diffs
  }
}

function getCommonFields(source: WorksheetMeta, master: WorksheetMeta): string[] {
  const masterFields = new Set(getWorksheetLocalColumns(master).map((column) => column.field.name))
  const fields = getWorksheetLocalColumns(source)
    .map((column) => column.field.name)
    .filter(
      (fieldName) =>
        fieldName !== idCardField && !excludedCompareFields.has(fieldName) && masterFields.has(fieldName)
    )
  for (const derivedField of ['出生日期', '最高学历']) {
    if (masterFields.has(derivedField) && !fields.includes(derivedField)) fields.push(derivedField)
  }
  return fields
}

function buildChanges(
  source: SheetCtx,
  master: SheetCtx,
  sourceRow: Row,
  masterRow: Row | undefined,
  comparedFields: string[],
  idCard: string,
  highestEducation: string | undefined
): TeacherDetailMasterSyncChange[] {
  const changes: TeacherDetailMasterSyncChange[] = []
  for (const fieldName of comparedFields) {
    const nextValue = nextFieldValue(source, sourceRow, fieldName, idCard, highestEducation)
    if (!nextValue) continue
    const currentValue = text(masterRow ? readValue(master, masterRow, fieldName) : '')
    if (equalFieldValue(fieldName, currentValue, nextValue)) continue
    changes.push({ fieldName, currentValue, nextValue })
  }
  return changes
}

function valuesFromDiff(
  master: SheetCtx,
  diff: TeacherDetailMasterSyncDiff,
  activeIds: Set<string>,
  retiredIds: Set<string>,
  otherIds: Set<string>
): Record<string, string> {
  const values: Record<string, string> = {}
  if (diff.action === 'insert') {
    setValue(values, master, idCardField, diff.idCard)
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
  return { worksheet, tableName: tableNameOf(worksheet), columns }
}

function readValue(sheet: SheetCtx, row: Row, fieldName: string): WorksheetRecordValue | undefined {
  const column = sheet.columns.get(fieldName)
  return column ? row[column] : undefined
}

function nextFieldValue(
  source: SheetCtx,
  sourceRow: Row,
  fieldName: string,
  idCard: string,
  highestEducation: string | undefined
): string {
  const sourceValue = text(readValue(source, sourceRow, fieldName))
  if (sourceValue) return sourceValue
  if (fieldName === '出生日期') return birthDateFromIdCard(idCard)
  if (fieldName === '最高学历') return highestEducation ?? ''
  return ''
}

function setValue(values: Record<string, string>, sheet: SheetCtx, fieldName: string, value: string): void {
  const column = sheet.columns.get(fieldName)
  if (column && value) values[column] = value
}

function equalFieldValue(fieldName: string, currentValue: string, nextValue: string): boolean {
  if (fieldName === '民族') return normalizeNation(currentValue) === normalizeNation(nextValue)
  if (fieldName === '出生日期') return normalizeDate(currentValue) === normalizeDate(nextValue)
  return normalizeCompare(currentValue) === normalizeCompare(nextValue)
}

function normalizeNation(value: string): string {
  const normalized = value.replace(/\s+/g, '')
  return normalized.endsWith('族') ? normalized.slice(0, -1) : normalized
}

async function loadHighestEducationByIdCard(
  database: Awaited<ReturnType<typeof getDatabase>>
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  let education: SheetCtx
  try {
    education = getSheetCtx('教职工学历')
  } catch {
    return result
  }
  const idColumn = education.columns.get('教职工身份证号')
  const categoryColumn = education.columns.get('学历类别')
  const educationColumn = education.columns.get('学历')
  if (!idColumn || !categoryColumn || !educationColumn) return result

  const rows = await all<Row>(database, `SELECT * FROM ${education.tableName}`)
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idColumn])
    if (!idCard) continue
    const category = text(row[categoryColumn])
    const value = text(row[educationColumn])
    if (!value || !category.includes('最高')) continue
    result.set(idCard, value)
  }
  return result
}

function birthDateFromIdCard(idCard: string): string {
  const normalized = normalizeIdCard(idCard)
  const birth = normalized.length >= 14 ? normalized.slice(6, 14) : ''
  if (!/^\d{8}$/.test(birth)) return ''
  return birth
}

function normalizeDate(value: string): string {
  const compact = value.replace(/\s+00:00:00$/, '').trim()
  if (/^\d{8}$/.test(compact)) return compact
  const matched = compact.match(/^(\d{4})[年/.-]?(\d{1,2})[月/.-]?(\d{1,2})日?$/)
  if (!matched) return compact.replace(/\s+/g, '').toUpperCase()
  return `${matched[1]}${matched[2].padStart(2, '0')}${matched[3].padStart(2, '0')}`
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

function numberOrZero(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
