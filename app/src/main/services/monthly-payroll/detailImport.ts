import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import * as XLSX from 'xlsx'
import { all, getDatabase, run } from '../../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../../db/schema'
import { getWorksheetByName, tableNameOf } from '../worksheetTable'
import { createOperationBatch, logRowsBeforeDelete } from '../operationLog'

type CellValue = string | number | boolean | Date | null | undefined

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value).trim()
}

function num(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const cleaned = String(value).replace(/,/g, '').replace(/\s+/g, '')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeHeader(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[（(][^（）()]*[）)]/g, '')
    .replace(/[（）()]/g, '')
}

function sheetToAoa(sheet: XLSX.WorkSheet): CellValue[][] {
  return XLSX.utils.sheet_to_json<CellValue[]>(sheet, { header: 1, defval: null, raw: false })
}

async function readWorkbook(filePath: string): Promise<XLSX.WorkBook> {
  const buffer = await readFile(filePath)
  return XLSX.read(buffer, { cellDates: false, type: 'buffer' })
}

function findHeaderRow(rows: CellValue[][], requiredHeaders: string[]): number {
  const required = requiredHeaders.map(normalizeHeader)
  return rows.findIndex((row) => {
    const present = new Set(row.map((cell) => normalizeHeader(text(cell))))
    return required.every((header) => present.has(header))
  })
}

function buildHeaderIndex(headers: string[]): Map<string, number> {
  const map = new Map<string, number>()
  headers.forEach((header, index) => {
    const key = normalizeHeader(text(header))
    if (key && !map.has(key)) map.set(key, index)
  })
  return map
}

function valueAt(row: CellValue[], headerIndex: Map<string, number>, ...aliases: string[]): unknown {
  for (const alias of aliases) {
    const idx = headerIndex.get(normalizeHeader(alias))
    if (idx !== undefined && row[idx] !== undefined && row[idx] !== null && row[idx] !== '') {
      return row[idx]
    }
  }
  return undefined
}

type ImportResult = { rowsInserted: number }

export async function importSocialSecurityDetail(
  filePath: string,
  unitCode: string,
  unitName: string
): Promise<ImportResult> {
  const workbook = await readWorkbook(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('社保文件没有可读取的工作表')
  const rows = sheetToAoa(sheet)
  const headerIndex = findHeaderRow(rows, ['征收品目'])
  if (headerIndex < 0) throw new Error('社保文件缺少"征收品目"表头')

  const headers = rows[headerIndex].map((cell) => text(cell))
  const hi = buildHeaderIndex(headers)
  const worksheet = getWorksheetByName('社保明细')
  const columns = getWorksheetLocalColumns(worksheet)
  const colByField = new Map(columns.map((c) => [c.field.name, c.columnName]))
  const table = tableNameOf(worksheet)
  const sourceFile = basename(filePath)
  const importedAt = new Date().toISOString()
  const database = await getDatabase()

  const dataRows: Array<Record<string, unknown>> = []
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i]
    const item = text(valueAt(row, hi, '征收品目'))
    if (!item || item.includes('合计')) continue

    dataRows.push({
      单位编号: text(valueAt(row, hi, '单位编号')),
      费款所属期起: text(valueAt(row, hi, '费款所属期起')),
      费款所属期止: text(valueAt(row, hi, '费款所属期止')),
      缴费人数: num(valueAt(row, hi, '缴费人数')),
      缴费工资合计: num(valueAt(row, hi, '缴费工资合计(元)', '缴费工资合计')),
      缴费基数: num(valueAt(row, hi, '缴费基数(元)', '缴费基数')),
      费率: text(valueAt(row, hi, '费率')),
      应缴费额: num(valueAt(row, hi, '应缴费额(元)', '应缴费额')),
      减免金额: num(valueAt(row, hi, '减免金额(元)', '减免金额')),
      应补退费额: num(valueAt(row, hi, '应补（退）费额(元)', '应补(退)费额(元)', '应补（退）费额', '应补(退)费额')),
      抵缴金额: num(valueAt(row, hi, '抵缴金额(元)', '抵缴金额')),
      实际应缴纳费额: num(valueAt(row, hi, '实际应缴纳费额(元)', '实际应缴纳费额')),
      征收项目: text(valueAt(row, hi, '征收项目')),
      征收品目: item,
      征收子目: text(valueAt(row, hi, '征收子目')),
      数据来源: text(valueAt(row, hi, '数据来源')),
      缴费类型: text(valueAt(row, hi, '缴费类型')),
      主管税务机关: text(valueAt(row, hi, '主管税务机关')),
      社保经办机构: text(valueAt(row, hi, '社保经办机构')),
      社保流水号: text(valueAt(row, hi, '社保流水号')),
      来源文件: sourceFile,
      导入时间: importedAt
    })
  }

  if (dataRows.length === 0) return { rowsInserted: 0 }

  const periods = Array.from(new Set(dataRows.map((r) => r.费款所属期起 as string).filter(Boolean)))
  const units = Array.from(new Set(dataRows.map((r) => r.单位编号 as string).filter(Boolean)))

  await run(database, 'BEGIN TRANSACTION')
  try {
    const deleteBatchId = await createOperationBatch(database, {
      kind: 'monthly-payroll.detail-replace',
      targetType: 'worksheet',
      targetName: worksheet.name,
      reason: '导入社保明细前替换同期间同单位旧明细',
      meta: { sourceFile, periods, units }
    })
    for (const period of periods) {
      for (const unitNum of units) {
        await logRowsBeforeDelete(database, {
          batchId: deleteBatchId,
          tableName: worksheet.name,
          worksheetName: worksheet.name,
          action: 'delete',
          whereSql: `${quoteIdentifier(colByField.get('费款所属期起')!)} = ? AND ${quoteIdentifier(colByField.get('单位编号')!)} = ?`,
          params: [period, unitNum]
        })
        await run(
          database,
          `DELETE FROM ${table} WHERE ${quoteIdentifier(colByField.get('费款所属期起')!)} = ? AND ${quoteIdentifier(colByField.get('单位编号')!)} = ?`,
          [period, unitNum]
        )
      }
    }
    const insertCols = Array.from(colByField.keys())
    const placeholders = insertCols.map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${insertCols.map((f) => quoteIdentifier(colByField.get(f)!)).join(', ')}, "md_created_at", "md_updated_at") VALUES (${placeholders}, ?, ?)`
    for (const r of dataRows) {
      const values = insertCols.map((f) => r[f] ?? '')
      await run(database, sql, [...values, importedAt, importedAt])
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  void unitCode; void unitName
  return { rowsInserted: dataRows.length }
}

export async function importTaxDetail(
  filePath: string,
  unitCode: string,
  unitName: string
): Promise<ImportResult> {
  const workbook = await readWorkbook(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('个税文件没有可读取的工作表')
  const rows = sheetToAoa(sheet)
  const headerIndex = findHeaderRow(rows, ['姓名', '证件号码'])
  if (headerIndex < 0) throw new Error('个税文件缺少"姓名"或"证件号码"表头')
  const headers = rows[headerIndex].map((cell) => text(cell))
  const hi = buildHeaderIndex(headers)
  const worksheet = getWorksheetByName('个税明细')
  const columns = getWorksheetLocalColumns(worksheet)
  const colByField = new Map(columns.map((c) => [c.field.name, c.columnName]))
  const table = tableNameOf(worksheet)
  const sourceFile = basename(filePath)
  const importedAt = new Date().toISOString()
  const database = await getDatabase()

  const fieldAliases: Record<string, string[]> = {
    工号: ['工号'],
    姓名: ['姓名'],
    证件类型: ['证件类型'],
    证件号码: ['证件号码'],
    税款所属期起: ['税款所属期起'],
    税款所属期止: ['税款所属期止'],
    所得项目: ['所得项目'],
    本期收入: ['本期收入'],
    本期费用: ['本期费用'],
    本期免税收入: ['本期免税收入'],
    本期基本养老保险费: ['本期基本养老保险费'],
    本期基本医疗保险费: ['本期基本医疗保险费'],
    本期失业保险费: ['本期失业保险费'],
    本期住房公积金: ['本期住房公积金'],
    本期企业职业年金: ['本期企业(职业)年金', '本期企业（职业）年金', '本期企业职业年金'],
    本期商业健康保险费: ['本期商业健康保险费'],
    本期税延养老保险费: ['本期税延养老保险费'],
    本期公务交通费用: ['本期公务交通费用'],
    本期通讯费用: ['本期通讯费用'],
    本期律师办案费用: ['本期律师办案费用'],
    本期西藏附加减除费用: ['本期西藏附加减除费用'],
    本期展业成本: ['本期展业成本'],
    本期其他扣除: ['本期其他扣除(其他)', '本期其他扣除'],
    累计收入额: ['累计收入额'],
    累计免税收入: ['累计免税收入'],
    累计减除费用: ['累计减除费用'],
    累计专项扣除: ['累计专项扣除'],
    累计子女教育支出扣除: ['累计子女教育支出扣除'],
    累计继续教育支出扣除: ['累计继续教育支出扣除'],
    累计住房贷款利息支出扣除: ['累计住房贷款利息支出扣除'],
    累计住房租金支出扣除: ['累计住房租金支出扣除'],
    累计赡养老人支出扣除: ['累计赡养老人支出扣除'],
    '累计3岁以下婴幼儿照护': ['累计3岁以下婴幼儿照护'],
    累计个人养老金: ['累计个人养老金'],
    累计其他扣除: ['累计其他扣除'],
    累计准予扣除的捐赠: ['累计准予扣除的捐赠'],
    其他单位累计收入: ['其他单位累计收入'],
    其他单位累计扣除: ['其他单位累计扣除'],
    其他单位累计减免税额: ['其他单位累计减免税额'],
    其他单位累计已缴税额: ['其他单位累计已缴税额'],
    累计应纳税所得额: ['累计应纳税所得额'],
    税率: ['税率'],
    速算扣除数: ['速算扣除数'],
    累计应纳税额: ['累计应纳税额'],
    累计减免税额: ['累计减免税额'],
    累计应扣缴税额: ['累计应扣缴税额'],
    已缴税额: ['已缴税额'],
    应补退税额: ['应补(退)税额', '应补（退）税额', '本期应补(退)税额', '本期应补（退）税额'],
    备注: ['备注']
  }

  const textFields = new Set(['工号', '姓名', '证件类型', '证件号码', '税款所属期起', '税款所属期止', '所得项目', '税率', '备注'])

  const dataRows: Array<Record<string, unknown>> = []
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i]
    const idCard = text(valueAt(row, hi, '证件号码'))
    if (!idCard) continue

    const record: Record<string, unknown> = { 单位编码: unitCode, 单位名称: unitName, 来源文件: sourceFile, 导入时间: importedAt }
    for (const [field, aliases] of Object.entries(fieldAliases)) {
      const raw = valueAt(row, hi, ...aliases)
      record[field] = textFields.has(field) ? text(raw) : num(raw)
    }
    dataRows.push(record)
  }

  if (dataRows.length === 0) return { rowsInserted: 0 }

  const periods = Array.from(new Set(dataRows.map((r) => r.税款所属期起 as string).filter(Boolean)))

  await run(database, 'BEGIN TRANSACTION')
  try {
    const deleteBatchId = await createOperationBatch(database, {
      kind: 'monthly-payroll.detail-replace',
      targetType: 'worksheet',
      targetName: worksheet.name,
      reason: '导入个税明细前替换同期间同单位旧明细',
      meta: { sourceFile, periods, unitCode }
    })
    for (const period of periods) {
      await logRowsBeforeDelete(database, {
        batchId: deleteBatchId,
        tableName: worksheet.name,
        worksheetName: worksheet.name,
        action: 'delete',
        whereSql: `${quoteIdentifier(colByField.get('税款所属期起')!)} = ? AND ${quoteIdentifier(colByField.get('单位编码')!)} = ?`,
        params: [period, unitCode]
      })
      await run(
        database,
        `DELETE FROM ${table} WHERE ${quoteIdentifier(colByField.get('税款所属期起')!)} = ? AND ${quoteIdentifier(colByField.get('单位编码')!)} = ?`,
        [period, unitCode]
      )
    }
    const insertCols = Array.from(colByField.keys())
    const placeholders = insertCols.map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${insertCols.map((f) => quoteIdentifier(colByField.get(f)!)).join(', ')}, "md_created_at", "md_updated_at") VALUES (${placeholders}, ?, ?)`
    for (const r of dataRows) {
      const values = insertCols.map((f) => r[f] ?? '')
      await run(database, sql, [...values, importedAt, importedAt])
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  return { rowsInserted: dataRows.length }
}

export type HousingFundDetailRow = {
  idCard: string
  name: string
  personal: number
  unitAmount: number
}

export async function importHousingFundDetail(
  rows: HousingFundDetailRow[],
  year: number,
  month: number,
  unitCode: string,
  unitName: string,
  sourceFile: string
): Promise<ImportResult> {
  if (rows.length === 0) return { rowsInserted: 0 }
  const worksheet = getWorksheetByName('公积金明细')
  const columns = getWorksheetLocalColumns(worksheet)
  const colByField = new Map(columns.map((c) => [c.field.name, c.columnName]))
  const table = tableNameOf(worksheet)
  const importedAt = new Date().toISOString()
  const database = await getDatabase()

  await run(database, 'BEGIN TRANSACTION')
  try {
    const deleteBatchId = await createOperationBatch(database, {
      kind: 'monthly-payroll.detail-replace',
      targetType: 'worksheet',
      targetName: worksheet.name,
      reason: '导入公积金明细前替换同年月同单位旧明细',
      meta: { sourceFile, year, month, unitCode }
    })
    await logRowsBeforeDelete(database, {
      batchId: deleteBatchId,
      tableName: worksheet.name,
      worksheetName: worksheet.name,
      action: 'delete',
      whereSql: `${quoteIdentifier(colByField.get('年')!)} = ? AND ${quoteIdentifier(colByField.get('月')!)} = ? AND ${quoteIdentifier(colByField.get('单位编码')!)} = ?`,
      params: [year, month, unitCode]
    })
    await run(
      database,
      `DELETE FROM ${table} WHERE ${quoteIdentifier(colByField.get('年')!)} = ? AND ${quoteIdentifier(colByField.get('月')!)} = ? AND ${quoteIdentifier(colByField.get('单位编码')!)} = ?`,
      [year, month, unitCode]
    )
    const insertCols = Array.from(colByField.keys())
    const placeholders = insertCols.map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${insertCols.map((f) => quoteIdentifier(colByField.get(f)!)).join(', ')}, "md_created_at", "md_updated_at") VALUES (${placeholders}, ?, ?)`
    for (const row of rows) {
      const record: Record<string, unknown> = {
        单位编码: unitCode,
        单位名称: unitName,
        年: year,
        月: month,
        证件号码: row.idCard,
        姓名: row.name,
        个人金额: row.personal,
        单位金额: row.unitAmount,
        来源文件: sourceFile,
        导入时间: importedAt
      }
      const values = insertCols.map((f) => record[f] ?? '')
      await run(database, sql, [...values, importedAt, importedAt])
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  return { rowsInserted: rows.length }
}

// 留出聚合接口，方便后续报表读取
export async function sumSocialDetailByPeriod(
  period: string,
  unitCode: string
): Promise<Record<string, number>> {
  const worksheet = getWorksheetByName('社保明细')
  const columns = getWorksheetLocalColumns(worksheet)
  const colByField = new Map(columns.map((c) => [c.field.name, c.columnName]))
  const table = tableNameOf(worksheet)
  const database = await getDatabase()
  const rows = await all<{ 征收品目: string; 应补退费额: number }>(
    database,
    `SELECT ${quoteIdentifier(colByField.get('征收品目')!)} AS "征收品目",
            ${quoteIdentifier(colByField.get('应补退费额')!)} AS "应补退费额"
       FROM ${table}
      WHERE ${quoteIdentifier(colByField.get('费款所属期起')!)} = ?
        AND ${quoteIdentifier(colByField.get('单位编号')!)} = ?`,
    [period, unitCode]
  )
  const totals: Record<string, number> = {}
  for (const row of rows) {
    totals[row.征收品目] = (totals[row.征收品目] ?? 0) + Number(row.应补退费额 ?? 0)
  }
  return totals
}

export async function sumTaxDetailByPeriod(
  period: string,
  unitCode: string
): Promise<{ total: number; rowCount: number; byIdCard: Record<string, number> }> {
  const worksheet = getWorksheetByName('个税明细')
  const columns = getWorksheetLocalColumns(worksheet)
  const colByField = new Map(columns.map((c) => [c.field.name, c.columnName]))
  const table = tableNameOf(worksheet)
  const database = await getDatabase()
  const rows = await all<{ 证件号码: string; 应补退税额: number }>(
    database,
    `SELECT ${quoteIdentifier(colByField.get('证件号码')!)} AS "证件号码",
            ${quoteIdentifier(colByField.get('应补退税额')!)} AS "应补退税额"
       FROM ${table}
      WHERE ${quoteIdentifier(colByField.get('税款所属期起')!)} = ?
        AND ${quoteIdentifier(colByField.get('单位编码')!)} = ?`,
    [period, unitCode]
  )
  const byIdCard: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    const amount = Number(row.应补退税额 ?? 0)
    if (row.证件号码) byIdCard[row.证件号码] = (byIdCard[row.证件号码] ?? 0) + amount
    total += amount
  }
  return { total, rowCount: rows.length, byIdCard }
}
