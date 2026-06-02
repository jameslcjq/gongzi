import { writeFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import { all, getDatabase } from '../../db/connection'
import { getWorksheetLocalColumns } from '../../db/schema'
import { getWorksheetByName, tableNameOf } from '../worksheetTable'
import type { SalarySummary } from './monthlyPayrollTypes'
import { num, roundMoney, text } from './monthlyPayrollUtils'

type TemplateColumn = {
  header: string
  columnName: string
  fieldName: string
}

const MIN_SALARY_IMPORT_COLUMNS = 45

export type SalaryImportWorkbookOptions = {
  includedFields?: string[]
}

export async function writeSalaryImportWorkbook(
  filePath: string,
  salary: SalarySummary,
  options: SalaryImportWorkbookOptions = {}
): Promise<number> {
  if (!salary.activePeople.length) return 0

  const template = await loadIntegratedActiveTemplate()
  const includedFields = options.includedFields ? new Set(options.includedFields) : undefined
  const rows = salary.activePeople.map((person, index) => {
    const row = new Array<string | number>(template.headers.length).fill('')
    const assignField = (fieldName: string, columnIndex: number, value: string | number): void => {
      if (!includedFields || includedFields.has(fieldName)) {
        row[columnIndex] = value
      }
    }

    // VBS 原逻辑：A-F、I-J、K-L 沿用一体化导出模板行里的固定单位/批次字段。
    copyCells(template.values, row, 0, 5)
    copyCells(template.values, row, 8, 9)
    copyCells(template.values, row, 10, 11)

    row[6] = person.name
    row[7] = person.idCard
    row[12] = num(person.values['序号']) || index + 1
    assignField('岗位工资', 13, num(person.values['岗位工资']))
    assignField('薪级工资', 14, num(person.values['薪级工资']))
    assignField('岗位津贴', 15, num(person.values['岗位津贴']))
    assignField('生活补贴', 16, num(person.values['生活补贴']))
    assignField('教（工）龄补贴', 19, num(person.values['教（工）龄补贴']))
    assignField('住房补贴', 23, num(person.values['住房补贴']))
    const splitOtherOne = roundMoney(num(person.values['乡镇补贴']) + num(person.values['边远补贴']))
    const otherOne = splitOtherOne || num(person.values['其他一'])
    assignField('其他一', 27, otherOne)
    assignField('公积金', 31, num(person.values['公积金']))
    assignField('养老保险缴费', 32, num(person.values['养老保险缴费']))
    assignField('职业年金缴费', 33, num(person.values['职业年金缴费']))
    assignField('医疗保险', 34, num(person.values['医疗保险']))
    assignField('失业保险', 35, num(person.values['失业保险']))
    if ((!includedFields || includedFields.has('其他一')) && num(row[27]) > 0) row[44] = '乡镇补贴'

    return row
  })

  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.aoa_to_sheet([template.headers, ...rows])
  XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName(text(template.values[2]) || '002'))
  appendLookupSheets(workbook, template.values)
  writeFileSync(filePath, XLSX.write(workbook, { bookType: 'xls', type: 'buffer' }))
  return rows.length
}

async function loadIntegratedActiveTemplate(): Promise<{
  headers: string[]
  values: Array<string | number>
}> {
  const worksheet = getWorksheetByName('在职工资')
  const columns: TemplateColumn[] = getWorksheetLocalColumns(worksheet).map((column) => ({
    header: column.field.importSource || column.field.name,
    columnName: column.columnName,
    fieldName: column.field.name
  }))
  ensureMinimumColumns(columns)

  const batchColumn = columns.find((column) => column.fieldName === '工资批次编码')?.columnName
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ${tableNameOf(worksheet)} ORDER BY "id" DESC LIMIT 200`
  )
  if (!rows.length) {
    throw new Error('在职工资没有可作为工资导入模板的行，请先导入在职工资数据')
  }

  const templateRow = selectTemplateRow(rows, batchColumn)
  return {
    headers: columns.map((column) => column.header),
    values: columns.map((column) => normalizeCell(templateRow[column.columnName]))
  }
}

function ensureMinimumColumns(columns: TemplateColumn[]): void {
  while (columns.length < MIN_SALARY_IMPORT_COLUMNS) {
    const label = columnLabel(columns.length)
    columns.push({ header: label, columnName: label, fieldName: label })
  }
}

function selectTemplateRow(
  rows: Array<Record<string, unknown>>,
  batchColumn: string | undefined
): Record<string, unknown> {
  if (!batchColumn) return rows[0]
  return rows.find((row) => text(row[batchColumn]) === '001') ?? rows[0]
}

function normalizeCell(value: unknown): string | number {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? value : ''
  return text(value)
}

function copyCells(
  source: Array<string | number>,
  target: Array<string | number>,
  fromIndex: number,
  toIndex: number
): void {
  for (let index = fromIndex; index <= toIndex; index += 1) {
    target[index] = source[index] ?? ''
  }
}

function appendLookupSheets(workbook: XLSX.WorkBook, templateValues: Array<string | number>): void {
  appendSingleColumnSheet(workbook, '单位', [text(templateValues[1])].filter(Boolean))
  appendSingleColumnSheet(workbook, '工资类别', ['行政', '事业', '行政离休', '行政退休', '事业离休', '事业退休', '司法'])
  appendSingleColumnSheet(workbook, '工资批次', ['工资', '数币'])
  const remarks = [
    '车补',
    '取暖补助',
    '出勤补助',
    '山区补助',
    '地区差别补助',
    '乡镇补贴',
    '特岗津贴',
    '独生子女费',
    '电话补助',
    '临时补助',
    '其他'
  ]
  appendSingleColumnSheet(workbook, '备注二', remarks)
  appendSingleColumnSheet(workbook, '备注三', remarks)
  appendSingleColumnSheet(workbook, '备注一', remarks)
}

function appendSingleColumnSheet(workbook: XLSX.WorkBook, name: string, values: string[]): void {
  const worksheet = XLSX.utils.aoa_to_sheet(values.map((value) => [value]))
  XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName(name))
}

function safeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet1'
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}
