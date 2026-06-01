import { all, getDatabase, refreshAllPersonnelStatuses, run } from '../../db/connection'
import { quoteIdentifier } from '../../db/schema'
import { normalizeEducationForAnnualReport } from '../educationNormalize'
import { normalizeJobLevelForDisplay, normalizeSalaryGradeForDisplay } from '../salaryLevelNormalize'
import { findColumnByName, getWorksheetByName, tableNameOf, tryFindColumnByName } from '../worksheetTable'

type Row = Record<string, string | number | null>
type Value = string | number | null

export type GenerateAnnualReportFromIntegratedInput = {
  totalPerformance: number
  totalHeadTeacher: number
  totalOvertime: number
}

export type GenerateAnnualReportFromIntegratedResult = {
  staffCount: number
  totalPerformance: number
  totalOvertime: number
  warnings: string[]
}

type SheetCtx = {
  table: string
  columns: Map<string, string>
}

type LookupCtx = {
  jobByAmount: Map<number, Row>
  salaryByAmount: Map<number, Row>
  townshipYearsByAmount: Map<number, Row>
  hrInfoByIdCard: Map<string, Row>
  educationByIdCard: Map<string, Row>
}

export async function generateAnnualReportFromIntegrated(
  input: GenerateAnnualReportFromIntegratedInput
): Promise<GenerateAnnualReportFromIntegratedResult> {
  const sourceWorksheet = getWorksheetByName('在职工资')
  const targetWorksheet = getWorksheetByName('工资年报')
  const source: SheetCtx = {
    table: tableNameOf(sourceWorksheet),
    columns: new Map(sourceWorksheet.fields.map((field) => [field.name, findColumnByName(sourceWorksheet, field.name)]))
  }
  const target: SheetCtx = {
    table: tableNameOf(targetWorksheet),
    columns: new Map(targetWorksheet.fields.map((field) => [field.name, findColumnByName(targetWorksheet, field.name)]))
  }

  const database = await getDatabase()
  const sourceRows = await all<Row>(database, `SELECT * FROM ${source.table}`)
  const rows = pickLatestRowsByPerson(sourceRows, {
    idCard: findColumnByName(sourceWorksheet, '证件号码'),
    name: findColumnByName(sourceWorksheet, '姓名'),
    year: tryFindColumnByName(sourceWorksheet, '业务年度'),
    month: tryFindColumnByName(sourceWorksheet, '月份'),
    batch: tryFindColumnByName(sourceWorksheet, '工资批次')
  })
  if (rows.length === 0) throw new Error('在职工资没有可生成工资年报的数据')

  const lookups = await loadLookups()
  const warnings = buildAnnualReportLookupWarnings(rows, source, lookups)
  const totalPerformance = Math.trunc(
    Number(input.totalPerformance || 0) + Number(input.totalHeadTeacher || 0)
  )
  const totalOvertime = Math.trunc(Number(input.totalOvertime || 0))
  const performanceValues = distributeAmount(totalPerformance, rows.length)
  const overtimeValues = distributeNonNegativeAmount(totalOvertime, rows.length)

  await run(database, 'BEGIN TRANSACTION')
  try {
    await run(database, `DELETE FROM ${target.table}`)
    await run(database, `DELETE FROM import_batch_rows WHERE worksheet_name = ?`, [targetWorksheet.name])
    for (const [index, sourceRow] of rows.entries()) {
      await insertTargetRow(
        target,
        buildAnnualReportRow({
          source,
          target,
          sourceRow,
          index,
          lookups,
          performance: performanceValues[index] ?? 0,
          overtime: overtimeValues[index] ?? 0
        })
      )
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  await refreshAllPersonnelStatuses(database)

  return { staffCount: rows.length, totalPerformance, totalOvertime, warnings }
}

function buildAnnualReportRow(args: {
  source: SheetCtx
  target: SheetCtx
  sourceRow: Row
  index: number
  lookups: LookupCtx
  performance: number
  overtime: number
}): Row {
  const { source, target, sourceRow, index, lookups, performance, overtime } = args
  const get = sourceGetter(source, sourceRow)
  const idCard = text(get('证件号码'))
  const job = lookupByAmount(lookups.jobByAmount, get('岗位工资'))
  const salary = lookupByAmount(lookups.salaryByAmount, get('薪级工资'))
  const townshipAmount = townshipAllowance(get)
  const township = lookupByAmount(lookups.townshipYearsByAmount, townshipAmount)
  const normalizedIdCard = normalizeIdCard(idCard)
  const hrInfo = lookups.hrInfoByIdCard.get(normalizedIdCard)
  const educationInfo = lookups.educationByIdCard.get(normalizedIdCard)

  return byTarget(target, {
    '序号': index + 1,
    '姓名': get('姓名'),
    '身份证号': idCard,
    '性别': genderFromIdCard(idCard),
    '民族': '汉',
    '出生年月': birthMonthFromIdCard(idCard),
    '学历': normalizeEducationForAnnualReport(pick(hrInfo, '最高学历') || pick(educationInfo, '学历')),
    '是否在编': '是',
    '人员类别': '教学人员',
    '学科门类(选填)': '教育学',
    '是否从事基础研究': '否',
    '领取工资月数': 12,
    '12月份是否在岗': '是',
    '参加工作时间': pick(hrInfo, '参加工作时间'),
    '乡镇工作年限（年）': pick(hrInfo, '乡镇工作年限') || pick(township, '乡镇工作年限') || '',
    '工龄(年）': pick(hrInfo, '工龄'),
    '不计算工龄的大专以上学龄（年）': pick(hrInfo, '应计学龄') || 0,
    '职务名称': '',
    '是否军转干部': '否',
    '执行基本工资对应岗位': pick(job, '执行基本工资对应岗位') || normalizeJobLevelForDisplay(pick(job, '级别')),
    '执行基本工资对应岗位聘用起始时间': pick(hrInfo, '在现单位任现职时间'),
    '薪级（含浮动薪级和浮动改固定薪级）': normalizeSalaryGradeForDisplay(pick(salary, '薪级')),
    '是否属于义务教育教师': '是',
    '是否属于护士或教师基本工资标准提高13%': '否',
    '是否属于地质、测绘行业野外工作人员': '否',
    '岗位工资（试用期工资）': get('岗位工资'),
    '薪级工资': get('薪级工资'),
    '岗位津贴': get('岗位津贴'),
    '生活补贴': get('生活补贴'),
    '农村学校教师补贴': '',
    '基层卫技人员补贴': '',
    '奖励性绩效工资': performance,
    '教龄津贴': townshipAmount || num(get('教（工）龄补贴')) ? '教龄津贴' : '',
    '教龄津贴金额': get('教（工）龄补贴'),
    '乡镇工作补贴（元/月）': townshipAmount,
    '教师课后延时补贴（元/年）': Math.max(0, overtime),
    '单位缴存的住房公积金（元/月）': get('公积金'),
    '住房补贴 （元/月）': get('住房补贴'),
    '上下班交通费补贴（元/月）': trafficAllowance(get),
    '公务用车改革补贴（元/月）': get('公车补贴'),
    '备注': cleanRemark(get('备注') || get('备注一') || get('备注二') || get('备注三')),
    '说明': ''
  })
}

async function insertTargetRow(target: SheetCtx, values: Row): Promise<void> {
  const entries = Object.entries(values)
  const now = new Date().toISOString()
  const database = await getDatabase()
  await run(
    database,
    `INSERT INTO ${target.table} (${entries.map(([column]) => quoteIdentifier(column)).join(', ')}, "md_created_at", "md_updated_at")
     VALUES (${entries.map(() => '?').join(', ')}, ?, ?)`,
    [...entries.map(([, value]) => value), now, now]
  )
}

async function loadLookups(): Promise<LookupCtx> {
  return {
    jobByAmount: await loadLookupByAmount('岗位工资对照', '金额'),
    salaryByAmount: await loadLookupByAmount('薪级工资对照', '薪级工资'),
    townshipYearsByAmount: await loadLookupByAmount('乡镇工作年限对照', '金额'),
    hrInfoByIdCard: await loadRowsByIdCard('人事信息'),
    educationByIdCard: await loadRowsByIdCard('教职工学历')
  }
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

function pickLatestRowsByPerson(
  rows: Row[],
  columns: { idCard: string; name: string; year?: string; month?: string; batch?: string }
): Row[] {
  const latest = new Map<string, Row>()
  for (const row of rows) {
    const idCard = text(row[columns.idCard])
    const name = text(row[columns.name])
    if (!idCard && !name) continue
    const key = idCard || name
    const previous = latest.get(key)
    if (!previous || compareIntegratedRow(row, previous, columns) > 0) latest.set(key, row)
  }
  return Array.from(latest.values()).sort((a, b) =>
    text(a[columns.name]).localeCompare(text(b[columns.name]), 'zh-Hans-CN')
  )
}

// 同一人同一年月可能并存 001 工资 / 002 数币 两行；只有 001 含完整字段（如 交通费），优先取 001。
function batchPreferenceRank(value: Value): number {
  const code = text(value).trim()
  if (code === '001') return 2
  if (code === '002') return 1
  return 0
}

function compareIntegratedRow(
  a: Row,
  b: Row,
  columns: { year?: string; month?: string; batch?: string }
): number {
  const aYear = columns.year ? num(a[columns.year]) : 0
  const bYear = columns.year ? num(b[columns.year]) : 0
  if (aYear !== bYear) return aYear - bYear
  const aMonth = columns.month ? num(a[columns.month]) : 0
  const bMonth = columns.month ? num(b[columns.month]) : 0
  if (aMonth !== bMonth) return aMonth - bMonth
  if (columns.batch) {
    const aBatch = batchPreferenceRank(a[columns.batch])
    const bBatch = batchPreferenceRank(b[columns.batch])
    if (aBatch !== bBatch) return aBatch - bBatch
  }
  return num(a.id) - num(b.id)
}

function distributeAmount(total: number, count: number): number[] {
  if (count <= 0) return []
  const avg = Math.round(total / count)
  const values: number[] = []
  let sum = 0
  for (let index = 0; index < count - 1; index += 1) {
    const value = Math.trunc(avg + Math.floor(Math.random() * 10001) - 5000)
    values.push(value)
    sum += value
  }
  values.push(Math.trunc(total - sum))
  return values
}

function distributeNonNegativeAmount(total: number, count: number): number[] {
  if (count <= 0) return []
  const normalizedTotal = Math.max(0, Math.trunc(total))
  const base = Math.floor(normalizedTotal / count)
  const remainder = normalizedTotal - base * count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

function byTarget(target: SheetCtx, values: Record<string, Value | undefined>): Row {
  const result: Row = {}
  for (const [fieldName, value] of Object.entries(values)) {
    const column = target.columns.get(fieldName)
    if (!column || value === undefined) continue
    result[column] = value
  }
  return result
}

function sourceGetter(source: SheetCtx, row: Row): (fieldName: string) => Value {
  return (fieldName: string) => {
    const column = source.columns.get(fieldName)
    return column ? row[column] ?? null : null
  }
}

function lookupByAmount(lookup: Map<number, Row>, value: Value): Row | undefined {
  return lookup.get(num(value))
}

function pick(row: Row | undefined, fieldName: string): Value {
  if (!row) return null
  return row[fieldName] ?? null
}

function buildAnnualReportLookupWarnings(
  rows: Row[],
  source: SheetCtx,
  lookups: LookupCtx
): string[] {
  return [
    ...buildMissingIdCardLookupWarnings(rows, source, lookups.hrInfoByIdCard, '人事信息'),
    ...buildMissingIdCardLookupWarnings(rows, source, lookups.educationByIdCard, '教职工学历')
  ]
}

function buildMissingIdCardLookupWarnings(
  rows: Row[],
  source: SheetCtx,
  lookup: Map<string, Row>,
  lookupName: string
): string[] {
  const missing = rows
    .map((row) => {
      const idCard = normalizeIdCard(readSourceValue(source, row, '证件号码'))
      const name = text(readSourceValue(source, row, '姓名'))
      return {
        idCard,
        label: name ? `${name}(${idCard})` : idCard
      }
    })
    .filter((item) => item.idCard && !lookup.has(item.idCard))

  if (missing.length === 0) return []
  return [
    `生成工资年报时有 ${missing.length} 人按身份证在${lookupName}中未找到，相关字段已留空。${formatExamples(missing.map((item) => item.label))}`
  ]
}

function readSourceValue(source: SheetCtx, row: Row, fieldName: string): Value {
  const column = source.columns.get(fieldName)
  return column ? row[column] ?? null : null
}

function formatExamples(items: string[]): string {
  const examples = items.filter(Boolean).slice(0, 8)
  if (examples.length === 0) return ''
  const suffix = items.length > examples.length ? `等 ${items.length} 人` : ''
  return `示例：${examples.join('、')}${suffix ? `，${suffix}` : ''}`
}

async function loadRowsByIdCard(worksheetName: string): Promise<Map<string, Row>> {
  const worksheet = getWorksheetByName(worksheetName)
  const source: SheetCtx = {
    table: tableNameOf(worksheet),
    columns: new Map(worksheet.fields.map((field) => [field.name, findColumnByName(worksheet, field.name)]))
  }
  const idCardColumn = findIdCardColumn(source)
  const database = await getDatabase()
  const rows = await all<Row>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
  const result = new Map<string, Row>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idCardColumn])
    if (!idCard) continue
    const previous = result.get(idCard)
    if (!previous || num(row.id) > num(previous.id)) result.set(idCard, row)
  }
  return result
}

function townshipAllowance(get: (fieldName: string) => Value): number {
  const slots = [
    ['其他一', '备注一'],
    ['其他二', '备注二'],
    ['其他三', '备注三']
  ] as const
  for (const [amountField, remarkField] of slots) {
    const remark = text(get(remarkField))
    if (remark.includes('乡镇')) return num(get(amountField))
  }
  return 0
}

function trafficAllowance(get: (fieldName: string) => Value): number {
  const value = num(get('交通费'))
  return value > 0 ? value : 300
}

function cleanRemark(value: Value): string {
  const remark = text(value)
  return remark === '乡镇补贴' ? '' : remark
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

function findIdCardColumn(source: SheetCtx): string {
  return (
    source.columns.get('身份证号码') ??
    source.columns.get('身份证号') ??
    source.columns.get('证件号码') ??
    source.columns.get('证件号码*') ??
    source.columns.get('教职工身份证号') ??
    '身份证号码'
  )
}

function genderFromIdCard(idCard: string): string {
  if (!/^\d{17}[\dXx]$/.test(idCard)) return ''
  return Number(idCard[16]) % 2 === 1 ? '男' : '女'
}

function birthMonthFromIdCard(idCard: string): string {
  if (!/^\d{17}[\dXx]$/.test(idCard)) return ''
  return `${idCard.slice(6, 10)}${idCard.slice(10, 12)}`
}
