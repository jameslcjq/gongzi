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
  HrMasterSyncApplyResult,
  HrMasterSyncChange,
  HrMasterSyncDiff,
  HrMasterSyncPreview,
  MasterSyncSelectionItem,
  WorksheetRecordValue
} from '../../shared/types'
import { findColumnByName, getWorksheetByName, tableNameOf, tryFindColumnByName } from './worksheetTable'
import { resolvePersonnelStatus } from './personnelStatus'
import {
  jobLevelsEquivalent,
  normalizeJobLevelForDisplay,
  normalizeSalaryGradeForDisplay,
  salaryGradesEquivalent
} from './salaryLevelNormalize'

type Row = Record<string, WorksheetRecordValue | number | undefined>
type FieldName = HrMasterSyncChange['fieldName']

type SheetCtx = {
  name: string
  tableName: string
  columns: Map<string, string>
}

type DerivedHrValues = Partial<Record<FieldName, string>>

const sourceName = '在职工资'
const masterName = '人事信息'

export async function previewHrMasterSyncFromIntegrated(): Promise<HrMasterSyncPreview> {
  return buildHrMasterSyncPreview()
}

export async function applyHrMasterSyncFromIntegrated(
  selections?: MasterSyncSelectionItem[]
): Promise<HrMasterSyncApplyResult> {
  const preview = filterPreview(buildSelectionSet(selections), await buildHrMasterSyncPreview())
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
      const values = valuesFromDiff(diff)
      if (diff.action === 'insert') {
        const columns = Object.keys(values)
        const placeholders = columns.map(() => '?').join(', ')
        await runWithLastId(
          database,
          `INSERT INTO ${master.tableName} (${columns.map(quoteIdentifier).join(', ')}, "md_created_at", "md_updated_at") VALUES (${placeholders}, ?, ?)`,
          [...columns.map((column) => values[column]), now, now]
        )
        insertedRows += 1
      } else if (diff.masterRecordId) {
        const columns = Object.keys(values)
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

  function valuesFromDiff(diff: HrMasterSyncDiff): Record<string, string> {
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
}

async function buildHrMasterSyncPreview(): Promise<HrMasterSyncPreview> {
  const database = await getDatabase()
  const source = getSheetCtx(sourceName)
  const master = getSheetCtx(masterName)
  const jobByAmount = await loadLookupByAmount('岗位工资对照', '金额')
  const salaryByAmount = await loadLookupByAmount('薪级工资对照', '薪级工资')

  const sourceRows = await all<Row>(database, `SELECT * FROM ${source.tableName}`)
  const masterRows = await all<Row>(database, `SELECT * FROM ${master.tableName}`)
  const masterByIdCard = new Map<string, Row>()
  for (const row of masterRows) {
    const idCard = normalizeIdCard(readValue(master, row, '身份证号码'))
    if (idCard) masterByIdCard.set(idCard, row)
  }

  const diffs: HrMasterSyncDiff[] = []
  let missingIdCardRows = 0
  let missingLookupRows = 0

  for (const row of sourceRows) {
    const idCard = normalizeIdCard(readValue(source, row, '证件号码'))
    if (!idCard) {
      missingIdCardRows += 1
      continue
    }

    const derived = deriveHrValues(row, source, jobByAmount, salaryByAmount)
    if (Object.keys(derived).length === 0) {
      missingLookupRows += 1
      continue
    }

    const masterRow = masterByIdCard.get(idCard)
    const changes = buildChanges(master, masterRow, derived)
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
    updatableRows: diffs.length,
    insertRows,
    updateRows,
    missingIdCardRows,
    missingLookupRows,
    diffs
  }
}

function filterPreview(
  selectionSet: Set<string> | undefined,
  preview: HrMasterSyncPreview
): HrMasterSyncPreview {
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

async function loadLookupByAmount(worksheetName: string, amountField: string): Promise<Map<number, Row>> {
  const worksheet = getWorksheetByName(worksheetName)
  const amountColumn = findColumnByName(worksheet, amountField)
  const database = await getDatabase()
  const rows = await all<Row>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
  const result = new Map<number, Row>()
  for (const row of rows) {
    const amount = num(row[amountColumn])
    if (amount > 0) result.set(amount, row)
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
  return { name, tableName: tableNameOf(worksheet), columns }
}

function deriveHrValues(
  row: Row,
  source: SheetCtx,
  jobByAmount: Map<number, Row>,
  salaryByAmount: Map<number, Row>
): DerivedHrValues {
  const job = jobByAmount.get(num(readValue(source, row, '岗位工资')))
  const salary = salaryByAmount.get(num(readValue(source, row, '薪级工资')))
  const values: DerivedHrValues = {}

  const unitName = text(readValue(source, row, '单位名称'))
  const title = text(pick(job, '职称'))
  const level = normalizeJobLevelForDisplay(
    pick(job, '级别') ?? pick(job, '执行基本工资对应岗位') ?? pick(job, '事业人员岗位工资级别') ?? pick(job, '岗位工资级别')
  )
  const salaryGrade = normalizeSalaryGradeForDisplay(
    pick(salary, '薪级') ?? pick(salary, '工资薪级') ?? pick(salary, '薪级级别')
  )

  if (unitName) values.单位名称 = unitName
  if (title) values.职称 = title
  if (level) values.职级 = level
  if (salaryGrade) values.薪级 = salaryGrade
  return values
}

function buildChanges(
  master: SheetCtx,
  masterRow: Row | undefined,
  derived: DerivedHrValues
): HrMasterSyncChange[] {
  const changes: HrMasterSyncChange[] = []
  for (const fieldName of ['单位名称', '职称', '职级', '薪级'] as FieldName[]) {
    const nextValue = text(derived[fieldName])
    if (!nextValue) continue
    const currentValue = text(masterRow ? readValue(master, masterRow, fieldName) : '')
    if (fieldName === '职级' && jobLevelsEquivalent(currentValue, nextValue)) continue
    if (fieldName === '薪级' && salaryGradesEquivalent(currentValue, nextValue)) continue
    if (normalizeCompare(currentValue) === normalizeCompare(nextValue)) continue
    changes.push({ fieldName, currentValue, nextValue })
  }
  return changes
}

function readValue(sheet: SheetCtx, row: Row, fieldName: string): WorksheetRecordValue | undefined {
  const column = sheet.columns.get(fieldName)
  return column ? row[column] : undefined
}

function setValue(values: Record<string, string>, sheet: SheetCtx, fieldName: string, value: string): void {
  const column = sheet.columns.get(fieldName)
  if (column && value) values[column] = value
}

function pick(row: Row | undefined, fieldName: string): WorksheetRecordValue | undefined {
  return row?.[fieldName]
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : 0
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

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
