import { readFile } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import type {
  CellValue,
  PayrollPeriodRange,
  PayrollPerson,
  SalarySummary,
  SocialSecuritySummary,
  TaxPerson,
  TaxSummary
} from './monthlyPayrollTypes'
import {
  isValidIdCard,
  normalizeHeader,
  normalizeIdCard,
  num,
  roundMoney,
  text
} from './monthlyPayrollUtils'

const activeSalaryFields = [
  '岗位工资',
  '薪级工资',
  '基本补发',
  '应发基础工资',
  '教龄津贴',
  '岗位津贴',
  '生活补贴',
  '绩效补发',
  '基础性绩效',
  '乡镇补贴',
  '边远乡镇补贴',
  '住房补贴',
  '交通补贴',
  '应发工资合计',
  '养老保险',
  '职业年金',
  '医保大病统筹',
  '失业保险',
  '住房公积金',
  '个税',
  '扣款补发',
  '补扣工资',
  '五险一金',
  '实发工资合计'
]

export async function parseSalaryWorkbook(filePath: string): Promise<SalarySummary> {
  const workbook = await readWorkbook(filePath)
  const activeSheet = workbook.Sheets['公办在职']
  if (!activeSheet) throw new Error('工资表缺少“公办在职”工作表')

  const survivorSheet = workbook.Sheets['遗补'] ?? workbook.Sheets['遗属补助']
  const activeRows = sheetToAoa(activeSheet)
  const survivorRows = survivorSheet ? sheetToAoa(survivorSheet) : []

  return {
    active: parseActiveSummary(activeRows),
    survivor: survivorRows.length ? parseSurvivorSummary(survivorRows) : {},
    activePeople: parseActivePeople(activeRows),
    survivorPeople: survivorRows.length ? parseSurvivorPeople(survivorRows) : []
  }
}

export async function parseSocialSecurityWorkbook(filePath: string): Promise<SocialSecuritySummary> {
  const workbook = await readWorkbook(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('社保文件没有可读取的工作表')

  const rows = sheetToAoa(sheet)
  const headerIndex = findSocialSecurityHeaderRow(rows)
  if (headerIndex < 0) throw new Error('社保文件缺少“征收品目/征收项目”或“应补（退）费额(元)”表头')

  const headers = rows[headerIndex].map((cell) => normalizeHeader(text(cell)))
  const itemIndexes = findSocialSecurityItemIndexes(headers)
  const amountIndex = findHeaderIndex(headers, [
    '应补（退）费额(元)',
    '应补(退)费额(元)',
    '应补（退）费额',
    '应补(退)费额',
    '应缴费额(元)',
    '应缴费额'
  ])
  if (itemIndexes.some((index) => index < 0) || amountIndex < 0) {
    throw new Error('社保文件缺少可识别的征收项目或金额列')
  }
  const periodStartIndex = findHeaderIndex(headers, [
    '费款所属期起',
    '费款所属期开始',
    '费款所属期起始',
    '所属期起',
    '所属期开始',
    '所属期起始'
  ])
  const periodEndIndex = findHeaderIndex(headers, [
    '费款所属期止',
    '费款所属期终',
    '费款所属期结束',
    '所属期止',
    '所属期结束'
  ])
  const periodIndex = findHeaderIndex(headers, ['费款所属期', '所属期'])
  const byItem = new Map<string, number>()
  const periods = new Map<string, PayrollPeriodRange>()
  let rowCount = 0

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]
    const item = itemIndexes.map((itemIndex) => text(row[itemIndex])).filter(Boolean).join(' ')
    if (!item) continue
    addPeriodRange(periods, {
      startValue: periodStartIndex >= 0 ? row[periodStartIndex] : periodIndex >= 0 ? row[periodIndex] : undefined,
      endValue: periodEndIndex >= 0 ? row[periodEndIndex] : periodIndex >= 0 ? row[periodIndex] : undefined
    })
    byItem.set(item, roundMoney((byItem.get(item) ?? 0) + num(row[amountIndex])))
    rowCount += 1
  }

  return { byItem: Object.fromEntries(byItem), rowCount, periods: Array.from(periods.values()) }
}

export async function parseTaxWorkbook(filePath: string): Promise<TaxSummary> {
  const workbook = await readWorkbook(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('个税文件没有可读取的工作表')

  const rows = sheetToAoa(sheet)
  const headerIndex = findHeaderRow(rows, ['姓名', '证件号码'])
  if (headerIndex < 0) throw new Error('个税文件缺少“姓名”或“证件号码”表头')

  const headers = rows[headerIndex].map((cell) => normalizeHeader(text(cell)))
  const nameIndex = headers.indexOf(normalizeHeader('姓名'))
  const idIndex = headers.indexOf(normalizeHeader('证件号码'))
  const amountIndex = findTaxAmountColumn(headers)
  const periodStartIndex = findHeaderIndex(headers, ['税款所属期起', '税款所属期开始', '税款所属期起始', '所得期间起'])
  const periodEndIndex = findHeaderIndex(headers, ['税款所属期止', '税款所属期终', '税款所属期结束', '所得期间止'])
  const periodIndex = findHeaderIndex(headers, ['税款所属期', '所得期间'])
  const taxRows: TaxPerson[] = []
  const missingIdCards: TaxPerson[] = []
  const periods = new Map<string, PayrollPeriodRange>()

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]
    if (text(row[nameIndex]) || text(row[idIndex])) {
      addPeriodRange(periods, {
        startValue: periodStartIndex >= 0 ? row[periodStartIndex] : periodIndex >= 0 ? row[periodIndex] : undefined,
        endValue: periodEndIndex >= 0 ? row[periodEndIndex] : periodIndex >= 0 ? row[periodIndex] : undefined
      })
    }
    const taxAmount = num(row[amountIndex])
    if (taxAmount === 0) continue
    const item = {
      idCard: normalizeIdCard(row[idIndex]),
      name: text(row[nameIndex]),
      taxAmount: roundMoney(taxAmount),
      rowNumber: index + 1
    }
    taxRows.push(item)
    if (!item.idCard) missingIdCards.push(item)
  }

  return {
    totalTax: roundMoney(taxRows.reduce((sum, row) => sum + row.taxAmount, 0)),
    rows: taxRows,
    missingIdCards,
    periods: Array.from(periods.values())
  }
}

function parseActiveSummary(rows: CellValue[][]): Record<string, number> {
  const totalRow = findTotalRow(rows, 4)
  if (!totalRow) throw new Error('公办在职表未找到“合计”行')

  const result: Record<string, number> = {}
  activeSalaryFields.forEach((field, offset) => {
    result[field] = num(totalRow[5 + offset])
  })
  result['人数'] = num(totalRow[0])
  return result
}

function parseSurvivorSummary(rows: CellValue[][]): Record<string, number> {
  const totalRow = findTotalRow(rows, 4)
  if (!totalRow) throw new Error('遗补表未找到“合计”行')
  return {
    人数: num(totalRow[16]) || num(totalRow[0]),
    遗属补助: num(totalRow[17]),
    补发数: num(totalRow[18]),
    合计: num(totalRow[28])
  }
}

function parseActivePeople(rows: CellValue[][]): PayrollPerson[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => text(row[4]) && !text(row[4]).includes('合计') && isValidIdCard(row[2]))
    .map(({ row, index }) => ({
      idCard: normalizeIdCard(row[2]),
      name: text(row[4]),
      account: text(row[3]),
      rowNumber: index + 1,
      values: {
        序号: num(row[0]),
        岗位工资: num(row[5]),
        薪级工资: num(row[6]),
        岗位津贴: num(row[10]),
        生活补贴: num(row[11]),
        基本补发: num(row[7]),
        绩效补发: num(row[12]),
        基础性绩效工资: num(row[13]),
        '教（工）龄补贴': num(row[9]),
        乡镇补贴: num(row[14]),
        农村教师补贴: num(row[14]),
        住房补贴: num(row[16]),
        边远补贴: num(row[15]),
        边远乡镇补贴: num(row[15]),
        其他一: roundMoney(num(row[14]) + num(row[15])),
        交通费: num(row[17]),
        应发工资: num(row[18]),
        养老保险缴费: num(row[19]),
        职业年金缴费: num(row[20]),
        医疗保险: num(row[21]),
        失业保险: num(row[22]),
        公积金: num(row[23]),
        当月个人所得税: num(row[24]),
        代扣合计: num(row[27]),
        实发合计: num(row[28])
      }
    }))
}

function parseSurvivorPeople(rows: CellValue[][]): PayrollPerson[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => text(row[4]) && !text(row[4]).includes('合计') && isValidIdCard(row[2]))
    .map(({ row, index }) => ({
      idCard: normalizeIdCard(row[2]),
      name: text(row[4]),
      account: text(row[3]),
      rowNumber: index + 1,
      values: {
        人数: num(row[16]),
        遗属补助: num(row[17]),
        补发数: num(row[18]),
        应发工资小计: num(row[28]),
        实发合计: num(row[28])
      }
    }))
}

function findTaxAmountColumn(headers: string[]): number {
  const candidates = [
    '应补（退）税额',
    '应补(退)税额',
    '本期应补（退）税额',
    '本期应补(退)税额'
  ].map(normalizeHeader)
  const matched = headers.findIndex((header) => candidates.includes(header))
  if (matched >= 0) return matched

  throw new Error('个税文件缺少“应补(退)税额”列')
}

function addPeriodRange(
  ranges: Map<string, PayrollPeriodRange>,
  values: { startValue: CellValue; endValue: CellValue }
): void {
  const startMonth = parsePeriodMonth(values.startValue)
  const endMonth = parsePeriodMonth(values.endValue)
  const start = startMonth ?? endMonth
  const end = endMonth ?? startMonth
  if (!start || !end) return
  const key = `${start}|${end}`
  const current = ranges.get(key)
  if (current) {
    current.rowCount += 1
  } else {
    ranges.set(key, { startMonth: start, endMonth: end, rowCount: 1 })
  }
}

function parsePeriodMonth(value: CellValue): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return formatMonthKey(value.getFullYear(), value.getMonth() + 1)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) return formatMonthKey(parsed.y, parsed.m)
  }
  const raw = text(value)
  if (!raw) return undefined
  const chinese = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/)
  if (chinese) return formatMonthKey(Number(chinese[1]), Number(chinese[2]))
  const separated = raw.match(/(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?/)
  if (separated) return formatMonthKey(Number(separated[1]), Number(separated[2]))
  const compact = raw.replace(/\D/g, '').match(/^(\d{4})(\d{2})(?:\d{2})?$/)
  if (compact) return formatMonthKey(Number(compact[1]), Number(compact[2]))
  return undefined
}

function formatMonthKey(year: number, month: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 1900 || month < 1 || month > 12) {
    return undefined
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

function findSocialSecurityHeaderRow(rows: CellValue[][]): number {
  const itemCandidates = [
    '征收品目',
    '征收项目',
    '征收品目名称',
    '征收项目名称',
    '征收子目',
    '征收子目名称'
  ].map(normalizeHeader)
  const amountCandidates = [
    '应补（退）费额(元)',
    '应补(退)费额(元)',
    '应补（退）费额',
    '应补(退)费额',
    '应缴费额(元)',
    '应缴费额'
  ].map(normalizeHeader)
  return rows.findIndex((row) => {
    const normalized = row.map((cell) => normalizeHeader(text(cell)))
    return normalized.some((header) => itemCandidates.includes(header)) &&
      normalized.some((header) => amountCandidates.includes(header))
  })
}

function findSocialSecurityItemIndexes(headers: string[]): number[] {
  const indexes = [
    findHeaderIndex(headers, ['征收品目', '征收品目名称']),
    findHeaderIndex(headers, ['征收项目', '征收项目名称', '征收子目', '征收子目名称'])
  ].filter((index, position, values) => index >= 0 && values.indexOf(index) === position)
  return indexes.length ? indexes : [findHeaderIndex(headers, ['征收品目', '征收项目'])]
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  const normalized = candidates.map(normalizeHeader)
  return headers.findIndex((header) => normalized.includes(header))
}

function findHeaderRow(rows: CellValue[][], requiredHeaders: string[]): number {
  const normalizedRequired = requiredHeaders.map(normalizeHeader)
  return rows.findIndex((row) => {
    const normalized = new Set(row.map((cell) => normalizeHeader(text(cell))))
    return normalizedRequired.every((header) => normalized.has(header))
  })
}

function findTotalRow(rows: CellValue[][], nameColumnIndex: number): CellValue[] | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (text(rows[index][nameColumnIndex]).replace(/\s+/g, '').includes('合计')) {
      return rows[index]
    }
  }
  return undefined
}

async function readWorkbook(filePath: string): Promise<XLSX.WorkBook> {
  const buffer = await readFile(filePath)
  return XLSX.read(buffer, { cellDates: false, type: 'buffer' })
}

function sheetToAoa(sheet: XLSX.WorkSheet): CellValue[][] {
  return XLSX.utils.sheet_to_json<CellValue[]>(sheet, {
    header: 1,
    defval: null,
    raw: false
  })
}
