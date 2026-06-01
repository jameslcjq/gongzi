import { get, getDatabase } from '../../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../../db/schema'
import type {
  MonthlyPayrollTaxField,
  WorksheetMeta,
  WorksheetRecordValue
} from '../../../shared/types'
import { num, roundMoney } from './monthlyPayrollUtils'

type WorksheetColumn = {
  field: WorksheetMeta['fields'][number]
  columnName: string
}

export const integratedActivePayFields = [
  '岗位工资',
  '薪级工资',
  '岗位津贴',
  '生活补贴',
  '绩效工资',
  '工作性津贴',
  '教（工）龄补贴',
  '特岗性津补贴',
  '交通费',
  '公车补贴',
  '住房补贴',
  '基础绩效奖',
  '补发工资',
  '其他一',
  '其他二',
  '其他三'
]

export const integratedActiveInsuranceFields = [
  '公积金',
  '养老保险缴费',
  '职业年金缴费',
  '医疗保险',
  '失业保险'
]

export const integratedActiveOtherDeductFields = [
  '支出一',
  '支出二',
  '支出三',
  '代扣工资'
]

export const integratedSimplePayFields = ['住房补贴', '补发工资', '其他一']

const integratedComputedWorksheetNames = new Set([
  '在职工资',
  '退休工资',
  '其他工资'
])

export type IntegratedComputedFieldSummary = {
  recalculatedRows: number
  mismatchRows: number
  mismatchExamples: string[]
}

export function isIntegratedComputedWorksheet(worksheetName: string): boolean {
  return integratedComputedWorksheetNames.has(worksheetName)
}

export async function applyIntegratedComputedFieldsForUpdate(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: WorksheetMeta,
  recordId: number,
  values: Record<string, WorksheetRecordValue>,
  taxField: MonthlyPayrollTaxField
): Promise<void> {
  if (!isIntegratedComputedWorksheet(worksheet.name)) return
  const columns = getWorksheetLocalColumns(worksheet)
  const table = quoteIdentifier(worksheet.name)
  const existing = await get<Record<string, WorksheetRecordValue>>(
    database,
    `SELECT * FROM ${table} WHERE "id" = ? LIMIT 1`,
    [recordId]
  )
  const merged = { ...(existing ?? {}), ...values }
  applyIntegratedComputedFieldsToRow(worksheet.name, columns, merged, taxField)
  for (const [, columnName] of computedFieldColumns(worksheet.name, columns)) {
    values[columnName] = merged[columnName] ?? null
  }
}

export function applyIntegratedComputedFieldsToRows(
  worksheet: WorksheetMeta,
  rows: Array<Record<string, WorksheetRecordValue>>,
  taxField: MonthlyPayrollTaxField
): IntegratedComputedFieldSummary {
  const summary: IntegratedComputedFieldSummary = {
    recalculatedRows: 0,
    mismatchRows: 0,
    mismatchExamples: []
  }
  if (!isIntegratedComputedWorksheet(worksheet.name)) return summary

  const columns = getWorksheetLocalColumns(worksheet)
  for (const [index, row] of rows.entries()) {
    const previous = snapshotComputedValues(worksheet.name, columns, row)
    const changed = applyIntegratedComputedFieldsToRow(worksheet.name, columns, row, taxField)
    if (!changed) continue
    summary.recalculatedRows += 1
    const mismatches = compareComputedSnapshot(previous, snapshotComputedValues(worksheet.name, columns, row))
    if (mismatches.length > 0) {
      summary.mismatchRows += 1
      if (summary.mismatchExamples.length < 5) {
        summary.mismatchExamples.push(`第 ${index + 1} 行：${mismatches.join('，')}`)
      }
    }
  }
  return summary
}

export function applyIntegratedComputedFieldsToRow(
  worksheetName: string,
  columns: WorksheetColumn[],
  row: Record<string, WorksheetRecordValue>,
  taxField: MonthlyPayrollTaxField
): boolean {
  if (worksheetName === '在职工资') {
    return applyIntegratedActiveComputedFields(columns, row, taxField)
  }
  if (worksheetName === '退休工资' || worksheetName === '其他工资') {
    return applyIntegratedSimpleComputedFields(columns, row)
  }
  return false
}

function applyIntegratedActiveComputedFields(
  columns: WorksheetColumn[],
  row: Record<string, WorksheetRecordValue>,
  taxField: MonthlyPayrollTaxField
): boolean {
  const fieldToColumn = fieldColumnMap(columns)
  const payableColumn = fieldToColumn.get('应发工资')
  const withholdingColumn = fieldToColumn.get('代扣合计')
  const actualColumn = fieldToColumn.get('实发合计')
  if (!payableColumn && !withholdingColumn && !actualColumn) return false

  const payable = sumFields(row, fieldToColumn, integratedActivePayFields)
  const tax = valueOf(row, fieldToColumn, taxField)
  const withholding = roundMoney(
    sumFields(row, fieldToColumn, integratedActiveInsuranceFields) +
      sumFields(row, fieldToColumn, integratedActiveOtherDeductFields) +
      tax
  )
  const actual = roundMoney(payable - withholding)

  if (payableColumn) row[payableColumn] = payable
  if (withholdingColumn) row[withholdingColumn] = withholding
  if (actualColumn) row[actualColumn] = actual
  return true
}

function applyIntegratedSimpleComputedFields(
  columns: WorksheetColumn[],
  row: Record<string, WorksheetRecordValue>
): boolean {
  const fieldToColumn = fieldColumnMap(columns)
  const payableColumn = fieldToColumn.get('应发工资小计')
  const actualColumn = fieldToColumn.get('实发合计')
  if (!payableColumn && !actualColumn) return false

  const payable = sumFields(row, fieldToColumn, integratedSimplePayFields)
  const actual = roundMoney(payable - valueOf(row, fieldToColumn, '代扣工资'))

  if (payableColumn) row[payableColumn] = payable
  if (actualColumn) row[actualColumn] = actual
  return true
}

function computedFieldColumns(
  worksheetName: string,
  columns: WorksheetColumn[]
): Array<[string, string]> {
  const names = worksheetName === '在职工资'
    ? ['应发工资', '代扣合计', '实发合计']
    : ['应发工资小计', '实发合计']
  const byField = fieldColumnMap(columns)
  return names
    .map((name) => [name, byField.get(name)] as [string, string | undefined])
    .filter((item): item is [string, string] => Boolean(item[1]))
}

function snapshotComputedValues(
  worksheetName: string,
  columns: WorksheetColumn[],
  row: Record<string, WorksheetRecordValue>
): Array<[string, number]> {
  return computedFieldColumns(worksheetName, columns)
    .map(([fieldName, columnName]) => [fieldName, num(row[columnName])] as [string, number])
}

function compareComputedSnapshot(
  previous: Array<[string, number]>,
  next: Array<[string, number]>
): string[] {
  const nextByField = new Map(next)
  const messages: string[] = []
  for (const [fieldName, previousValue] of previous) {
    const nextValue = nextByField.get(fieldName) ?? 0
    if (Math.abs(roundMoney(previousValue - nextValue)) >= 0.01) {
      messages.push(`${fieldName} 原 ${formatComputedValue(previousValue)} / 重算 ${formatComputedValue(nextValue)}`)
    }
  }
  return messages
}

function fieldColumnMap(columns: WorksheetColumn[]): Map<string, string> {
  return new Map(columns.map((column) => [column.field.name, column.columnName]))
}

function sumFields(
  row: Record<string, WorksheetRecordValue>,
  fieldToColumn: Map<string, string>,
  fieldNames: string[]
): number {
  return roundMoney(
    fieldNames.reduce((sum, fieldName) => sum + valueOf(row, fieldToColumn, fieldName), 0)
  )
}

function valueOf(
  row: Record<string, WorksheetRecordValue>,
  fieldToColumn: Map<string, string>,
  fieldName: string
): number {
  const columnName = fieldToColumn.get(fieldName)
  return columnName ? num(row[columnName]) : 0
}

function formatComputedValue(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
