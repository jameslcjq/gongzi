import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { all, getDatabase } from '../db/connection'
import { quoteIdentifier } from '../db/schema'
import { educationRank, isEducationBucket, normalizeEducationForCompare } from './educationNormalize'
import { normalizeJobLevelForDisplay, normalizeSalaryGradeForDisplay } from './salaryLevelNormalize'
import type {
  StatReportColumn,
  StatReportDef,
  StatReportDrillResult,
  StatReportFilterClause,
  StatReportResult,
  StatReportRow
} from '../../shared/types'
import { getDataPath } from '../config/paths'

const HR_TABLE = '人事信息'

export const STAT_REPORT_DEFS: StatReportDef[] = [
  {
    id: 'gov-2-staff-basic',
    name: '表(2) 事业单位工作人员基本情况',
    category: '政府样表',
    description: '按岗位类别、职级、学历、年龄、党员、性别、民族统计',
    sourceTable: HR_TABLE
  },
  {
    id: 'gov-3-classification',
    name: '表(3) 事业单位工作人员分类情况',
    category: '政府样表',
    description: '按管理、专技、工勤各岗位等级横向展开',
    sourceTable: HR_TABLE
  },
  {
    id: 'gov-5-tech',
    name: '表(5) 专业技术人员分类情况',
    category: '政府样表',
    description: '专业技术人员按职称类别统计',
    sourceTable: HR_TABLE
  },
  {
    id: 'gov-8-position',
    name: '表(8) 岗位设置实施情况',
    category: '政府样表',
    description: '按岗位类别和等级统计实有人数',
    sourceTable: HR_TABLE
  },
  {
    id: 'gov-1201-skilled',
    name: '表(1201) 机关工勤技能人员基本情况',
    category: '政府样表',
    description: '工勤技能人员按等级、学历、年龄统计',
    sourceTable: HR_TABLE
  },
  {
    id: 'gov-1208-senior-title',
    name: '表(1208) 取得高级职称工作人员情况',
    category: '政府样表',
    description: '正高、副高职称人数统计',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-unit',
    name: '按单位统计',
    category: '自由统计',
    description: '按人事信息中的单位名称分组',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-post-level',
    name: '按职级统计',
    category: '自由统计',
    description: '按人事信息中的职级分组',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-title',
    name: '按职称统计',
    category: '自由统计',
    description: '按人事信息中的职称分组',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-salary-grade',
    name: '按薪级统计',
    category: '自由统计',
    description: '按人事信息中的薪级分组',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-education',
    name: '按学历统计',
    category: '自由统计',
    description: '按人事信息中的最高学历分组',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-political',
    name: '按政治面貌统计',
    category: '自由统计',
    description: '按人事信息中的政治面貌分组',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-gender',
    name: '按性别统计',
    category: '自由统计',
    description: '按人事信息中的性别分组',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-ethnic',
    name: '按民族统计',
    category: '自由统计',
    description: '按人事信息中的民族分组',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-age',
    name: '按年龄段统计',
    category: '自由统计',
    description: '按人事信息中的出生日期推算年龄段',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-tenure',
    name: '按工龄段统计',
    category: '自由统计',
    description: '按人事信息中的工龄分段',
    sourceTable: HR_TABLE
  },
  {
    id: 'by-township-years',
    name: '按乡镇工作年限统计',
    category: '自由统计',
    description: '按人事信息中的乡镇工作年限分段',
    sourceTable: HR_TABLE
  }
]

type RawRow = Record<string, string | number | null>
type PostCategory = '管理人员' | '专业技术人员' | '工勤技能人员' | '其他'

const LEVEL_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三']
const PARTY_KEYWORDS = ['中共党员', '中共预备党员', '党员']

const MASTER_FIELDS = [
  '序号',
  '单位名称',
  '姓名',
  '性别',
  '身份证号码',
  '民族',
  '籍贯',
  '政治面貌',
  '入党时间',
  '出生日期',
  '联系电话',
  '现住址',
  '最高学历',
  '参加工作时间',
  '工龄',
  '乡镇工作年限',
  '本县入编时间',
  '职称',
  '职级',
  '职称学科',
  '职称获得时间',
  '薪级',
  '岗位职务',
  '任命单位',
  '批复文号',
  '在现单位任现职时间',
  '备注'
]

const METRIC_COLUMNS: StatReportColumn[] = [
  { key: '合计', label: '合计', width: 70 },
  { key: '男', label: '男', width: 60 },
  { key: '女', label: '女', width: 60 },
  { key: '汉族', label: '汉族', width: 70 },
  { key: '少数民族', label: '少数民族', width: 80 },
  { key: '党员', label: '党员', width: 70 },
  { key: '非党员', label: '非党员', width: 70 }
]

const EDU_BUCKETS = [
  { key: '博士', match: (v: string): boolean => isEducationBucket(v, '博士') },
  { key: '硕士', match: (v: string): boolean => isEducationBucket(v, '硕士') },
  { key: '本科', match: (v: string): boolean => isEducationBucket(v, '本科') },
  { key: '大专', match: (v: string): boolean => isEducationBucket(v, '大专') },
  { key: '中专', match: (v: string): boolean => isEducationBucket(v, '中专') },
  { key: '高中及以下', match: (v: string): boolean => isEducationBucket(v, '高中及以下') }
]

const AGE_BUCKETS: Array<{ key: string; lo: number | null; hi: number | null }> = [
  { key: '30及以下', lo: null, hi: 30 },
  { key: '31-35', lo: 31, hi: 35 },
  { key: '36-40', lo: 36, hi: 40 },
  { key: '41-45', lo: 41, hi: 45 },
  { key: '46-50', lo: 46, hi: 50 },
  { key: '51-55', lo: 51, hi: 55 },
  { key: '56-60', lo: 56, hi: 60 },
  { key: '60以上', lo: 61, hi: null }
]

const YEARS_BUCKETS: Array<{ key: string; lo: number | null; hi: number | null }> = [
  { key: '5年及以下', lo: null, hi: 5 },
  { key: '6-10年', lo: 6, hi: 10 },
  { key: '11-15年', lo: 11, hi: 15 },
  { key: '16-20年', lo: 16, hi: 20 },
  { key: '21-25年', lo: 21, hi: 25 },
  { key: '26-30年', lo: 26, hi: 30 },
  { key: '31年及以上', lo: 31, hi: null }
]

const GOV_COLUMNS: StatReportColumn[] = [
  { key: '合计', label: '合计', width: 60 },
  { key: '女', label: '女', width: 50 },
  { key: '少数民族', label: '少数民族', width: 75 },
  { key: '党员', label: '中共党员', width: 75 },
  { key: '博士', label: '博士', width: 55 },
  { key: '硕士', label: '硕士', width: 55 },
  { key: '本科', label: '本科', width: 55 },
  { key: '大专', label: '大专', width: 55 },
  { key: '中专', label: '中专', width: 55 },
  { key: '高中及以下', label: '高中及以下', width: 85 },
  { key: '30及以下', label: '30及以下', width: 75 },
  { key: '31-35', label: '31-35', width: 60 },
  { key: '36-40', label: '36-40', width: 60 },
  { key: '41-45', label: '41-45', width: 60 },
  { key: '46-50', label: '46-50', width: 60 },
  { key: '51-55', label: '51-55', width: 60 },
  { key: '56-60', label: '56-60', width: 60 },
  { key: '60以上', label: '60以上', width: 65 }
]

let lastLoadedRows: RawRow[] | null = null

async function loadHrRows(): Promise<RawRow[]> {
  const db = await getDatabase()
  const columns = await all<{ name: string }>(db, `PRAGMA table_info(${quoteIdentifier(HR_TABLE)})`)
  const columnNames = new Set(columns.map((column) => column.name))
  const activeOnly = columnNames.has('人员状态')
    ? ` WHERE ${quoteIdentifier('人员状态')} = '在职'`
    : ''
  const rows = await all<RawRow>(
    db,
    `SELECT * FROM ${quoteIdentifier(HR_TABLE)}${activeOnly}`
  )
  await enrichHrRowsForStats(db, rows)
  lastLoadedRows = rows
  return rows
}

async function enrichHrRowsForStats(
  db: Awaited<ReturnType<typeof getDatabase>>,
  rows: RawRow[]
): Promise<void> {
  for (const row of rows) {
    if (!text(row, '出生日期')) {
      const birthday = birthdayFromIdCard(text(row, '身份证号码'))
      if (birthday) row['出生日期'] = birthday
    }
    if (!text(row, '工龄')) {
      const startYear = extractYear(row['参加工作时间'])
      if (startYear) row['工龄'] = Math.max(0, new Date().getFullYear() - startYear)
    }
  }

  await enrichEducationFromChildTable(db, rows)
}

async function enrichEducationFromChildTable(
  db: Awaited<ReturnType<typeof getDatabase>>,
  rows: RawRow[]
): Promise<void> {
  const childTable = '教职工学历'
  const columns = await all<{ name: string }>(
    db,
    `PRAGMA table_info(${quoteIdentifier(childTable)})`
  )
  const columnNames = new Set(columns.map((column) => column.name))
  if (!columnNames.has('教职工身份证号') || !columnNames.has('学历')) return

  const childRows = await all<RawRow>(
    db,
    `SELECT * FROM ${quoteIdentifier(childTable)}`
  )
  const bestByIdCard = new Map<string, string>()
  for (const child of childRows) {
    const idCard = normalizeIdCard(text(child, '教职工身份证号'))
    const education = text(child, '学历')
    if (!idCard || !education) continue

    const category = text(child, '学历类别')
    const current = bestByIdCard.get(idCard) ?? ''
    if (
      category.includes('最高') ||
      educationRank(education) > educationRank(current)
    ) {
      bestByIdCard.set(idCard, education)
    }
  }

  for (const row of rows) {
    if (text(row, '最高学历')) continue
    const education = bestByIdCard.get(normalizeIdCard(text(row, '身份证号码')))
    if (education) row['最高学历'] = education
  }
}

function text(row: RawRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function extractYear(value: string | number | null): number | null {
  if (value === null || value === undefined || value === '') return null
  const raw = String(value).replace(/[^\d]/g, '')
  if (raw.length < 4) return null
  const year = Number(raw.slice(0, 4))
  return year >= 1900 && year <= 2100 ? year : null
}

function numberOf(value: string | number | null): number | null {
  if (value === null || value === undefined || value === '') return null
  const match = String(value).match(/\d+(\.\d+)?/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeIdCard(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

function birthdayFromIdCard(value: string): string | null {
  const idCard = normalizeIdCard(value)
  const match18 = idCard.match(/^\d{6}(\d{4})(\d{2})(\d{2})\d{3}[\dX]$/)
  if (match18) return `${match18[1]}-${match18[2]}-${match18[3]}`

  const match15 = idCard.match(/^\d{6}(\d{2})(\d{2})(\d{2})\d{3}$/)
  if (match15) return `19${match15[1]}-${match15[2]}-${match15[3]}`

  return null
}

function isFemale(row: RawRow): boolean {
  const value = text(row, '性别')
  return value === '女' || value.toUpperCase() === 'F'
}

function isMinority(row: RawRow): boolean {
  const value = text(row, '民族')
  return value.length > 0 && value !== '汉' && value !== '汉族'
}

function isPartyMember(row: RawRow): boolean {
  const value = text(row, '政治面貌')
  return PARTY_KEYWORDS.some((keyword) => value.includes(keyword))
}

function ageOf(row: RawRow): number | null {
  const year = extractYear(row['出生日期'])
  return year === null ? null : new Date().getFullYear() - year
}

function tenureOf(row: RawRow): number | null {
  return numberOf(row['工龄'])
}

function townshipYearsOf(row: RawRow): number | null {
  return numberOf(row['乡镇工作年限'])
}

function inRange(value: number | null, lo: number | null, hi: number | null): boolean {
  if (value === null) return false
  if (lo !== null && value < lo) return false
  if (hi !== null && value > hi) return false
  return true
}

function parsePostLevel(row: RawRow): { category: PostCategory; level: number | null } {
  const raw = text(row, '职级')
  const title = text(row, '职称')
  const post = text(row, '岗位职务')
  const combined = `${raw} ${title} ${post}`
  let category: PostCategory = '其他'
  if (/^管理|^管|管理岗位/.test(raw)) category = '管理人员'
  else if (/^专技|^专业技术|专业技术岗位/.test(raw)) category = '专业技术人员'
  else if (/^工勤|工人|普通工|工勤技能/.test(raw)) category = '工勤技能人员'
  else if (/教师|中小学|正高|副高|高级|一级|二级|三级|中级|初级/.test(title)) category = '专业技术人员'
  else if (/教师/.test(post)) category = '专业技术人员'
  else if (/校长|书记|主任|负责人|会计|出纳/.test(post)) category = '管理人员'

  let level: number | null = null
  const cn = combined.match(/(十三|十二|十一|十|九|八|七|六|五|四|三|二|一)级/)
  if (cn) level = LEVEL_NUM.indexOf(cn[1]) + 1
  const digit = combined.match(/(\d{1,2})级/)
  if (level === null && digit) level = Number(digit[1])
  if (level === null && category === '专业技术人员') {
    if (/正高级|正高/.test(title)) level = 4
    else if (/高级|副高/.test(title)) level = 7
    else if (/一级|中级/.test(title)) level = 10
    else if (/二级|初级/.test(title)) level = 12
    else if (/三级/.test(title)) level = 13
  }

  return { category, level }
}

function makeMetrics(rows: RawRow[]): Record<string, number> {
  return {
    合计: rows.length,
    男: rows.filter((row) => text(row, '性别') !== '' && !isFemale(row)).length,
    女: rows.filter(isFemale).length,
    汉族: rows.filter((row) => ['汉', '汉族'].includes(text(row, '民族'))).length,
    少数民族: rows.filter(isMinority).length,
    党员: rows.filter(isPartyMember).length,
    非党员: rows.filter((row) => text(row, '政治面貌') !== '' && !isPartyMember(row)).length
  }
}

function makeGovMetrics(rows: RawRow[]): Record<string, number> {
  const values: Record<string, number> = {
    合计: rows.length,
    女: rows.filter(isFemale).length,
    少数民族: rows.filter(isMinority).length,
    党员: rows.filter(isPartyMember).length
  }
  for (const bucket of EDU_BUCKETS) {
    values[bucket.key] = rows.filter((row) => bucket.match(text(row, '最高学历'))).length
  }
  for (const bucket of AGE_BUCKETS) {
    values[bucket.key] = rows.filter((row) => inRange(ageOf(row), bucket.lo, bucket.hi)).length
  }
  return values
}

function row(
  label: string,
  values: Record<string, number>,
  options: Partial<StatReportRow> = {}
): StatReportRow {
  return {
    label,
    indent: options.indent ?? 0,
    isTotal: Boolean(options.isTotal),
    isSectionHeader: Boolean(options.isSectionHeader),
    values,
    filter: options.filter ?? [],
    filterDesc: options.filterDesc ?? label.trim()
  }
}

function postCategoryFilter(category: PostCategory): StatReportFilterClause {
  return { field: '职级', op: 'computed', computedKind: 'postCategory', values: [category] }
}

function postLevelFilter(category: PostCategory, level: number): StatReportFilterClause[] {
  return [
    postCategoryFilter(category),
    { field: '职级', op: 'computed', computedKind: 'postLevel', values: [String(level)] }
  ]
}

function rowsByPost(rows: RawRow[], category: PostCategory, level?: number): RawRow[] {
  return rows.filter((item) => {
    const parsed = parsePostLevel(item)
    if (parsed.category !== category) return false
    return level === undefined ? true : parsed.level === level
  })
}

async function runGov2StaffBasic(): Promise<StatReportResult> {
  const rows = await loadHrRows()
  const reportRows: StatReportRow[] = [
    row('总计', makeGovMetrics(rows), { isTotal: true, filterDesc: `来源：${HR_TABLE} 在职记录` })
  ]

  const appendCategory = (category: PostCategory, maxLevel: number): void => {
    const categoryRows = rowsByPost(rows, category)
    reportRows.push(
      row(category, makeGovMetrics(categoryRows), {
        indent: 1,
        filter: [postCategoryFilter(category)],
        filterDesc: `职级识别为${category}`
      })
    )
    for (let level = 1; level <= maxLevel; level += 1) {
      const subset = rowsByPost(rows, category, level)
      reportRows.push(
        row(`${LEVEL_NUM[level - 1]}级`, makeGovMetrics(subset), {
          indent: 2,
          isSectionHeader: subset.length === 0,
          filter: postLevelFilter(category, level),
          filterDesc: `${category}${LEVEL_NUM[level - 1]}级`
        })
      )
    }
  }

  appendCategory('管理人员', 10)
  appendCategory('专业技术人员', 13)
  appendCategory('工勤技能人员', 5)

  const otherRows = rowsByPost(rows, '其他')
  if (otherRows.length > 0) {
    reportRows.push(
      row('其他/未识别', makeGovMetrics(otherRows), {
        indent: 1,
        filter: [postCategoryFilter('其他')],
        filterDesc: '职级为空或无法识别'
      })
    )
  }

  return makeResult('gov-2-staff-basic', reportRows, GOV_COLUMNS, rows.length)
}

async function runGov3Classification(): Promise<StatReportResult> {
  const rows = await loadHrRows()
  const columns: StatReportColumn[] = [{ key: '合计', label: '合计', width: 60 }]
  for (let level = 1; level <= 10; level += 1) {
    columns.push({ key: `管理${level}`, label: `管理${LEVEL_NUM[level - 1]}级`, width: 78 })
  }
  for (let level = 1; level <= 13; level += 1) {
    columns.push({ key: `专技${level}`, label: `专技${LEVEL_NUM[level - 1]}级`, width: 78 })
  }
  for (let level = 1; level <= 5; level += 1) {
    columns.push({ key: `工勤${level}`, label: `工勤${LEVEL_NUM[level - 1]}级`, width: 78 })
  }

  const values: Record<string, number> = { 合计: rows.length }
  for (let level = 1; level <= 10; level += 1) values[`管理${level}`] = rowsByPost(rows, '管理人员', level).length
  for (let level = 1; level <= 13; level += 1) values[`专技${level}`] = rowsByPost(rows, '专业技术人员', level).length
  for (let level = 1; level <= 5; level += 1) values[`工勤${level}`] = rowsByPost(rows, '工勤技能人员', level).length

  return makeResult(
    'gov-3-classification',
    [
      row('总计', values, { isTotal: true, filterDesc: `来源：${HR_TABLE} 在职记录` }),
      row('教育', values, { indent: 1, filterDesc: '教育行业，人事信息全体人员' })
    ],
    columns,
    rows.length
  )
}

async function runGov5Tech(): Promise<StatReportResult> {
  const rows = await loadHrRows()
  const professionalRows = rowsByPost(rows, '专业技术人员')
  const categories = [
    { label: '中小学教师', values: ['教师', '中小学', '中学', '小学', '幼儿园'] },
    { label: '高级职称', values: ['高级', '副高', '正高'] },
    { label: '中级职称', values: ['一级', '中级'] },
    { label: '初级职称', values: ['二级', '三级', '初级'] }
  ]
  const reportRows: StatReportRow[] = [
    row('总计', makeGovMetrics(professionalRows), {
      isTotal: true,
      filter: [postCategoryFilter('专业技术人员')],
      filterDesc: '职级识别为专业技术人员'
    })
  ]
  const used = new Set<string>()
  for (const item of categories) {
    const subset = professionalRows.filter((candidate) => {
      const key = text(candidate, '身份证号码') || text(candidate, '姓名')
      if (used.has(key)) return false
      const matched = item.values.some((value) => text(candidate, '职称').includes(value))
      if (matched && key) used.add(key)
      return matched
    })
    reportRows.push(
      row(item.label, makeGovMetrics(subset), {
        indent: 1,
        filter: [
          postCategoryFilter('专业技术人员'),
          { field: '职称', op: 'contains', values: item.values }
        ],
        filterDesc: `专业技术人员，职称包含：${item.values.join('、')}`
      })
    )
  }
  const other = professionalRows.filter((candidate) => {
    const key = text(candidate, '身份证号码') || text(candidate, '姓名')
    return !used.has(key)
  })
  if (other.length > 0) {
    reportRows.push(
      row('其他/未识别', makeGovMetrics(other), {
        indent: 1,
        filter: [postCategoryFilter('专业技术人员')],
        filterDesc: '专业技术人员中未归入上述职称类别'
      })
    )
  }
  return makeResult('gov-5-tech', reportRows, GOV_COLUMNS, professionalRows.length)
}

async function runGov8Position(): Promise<StatReportResult> {
  const rows = await loadHrRows()
  const columns: StatReportColumn[] = [
    { key: '合计', label: '实有人数', width: 85 },
    { key: '教育', label: '教育行业', width: 85 }
  ]
  const reportRows: StatReportRow[] = [
    row('总计', { 合计: rows.length, 教育: rows.length }, { isTotal: true, filterDesc: `来源：${HR_TABLE} 在职记录` })
  ]
  const appendCategory = (category: PostCategory, maxLevel: number): void => {
    const categoryRows = rowsByPost(rows, category)
    reportRows.push(
      row(`${category} 小计`, { 合计: categoryRows.length, 教育: categoryRows.length }, {
        indent: 1,
        filter: [postCategoryFilter(category)],
        filterDesc: `职级识别为${category}`
      })
    )
    for (let level = 1; level <= maxLevel; level += 1) {
      const subset = rowsByPost(rows, category, level)
      reportRows.push(
        row(`${LEVEL_NUM[level - 1]}级`, { 合计: subset.length, 教育: subset.length }, {
          indent: 2,
          isSectionHeader: subset.length === 0,
          filter: postLevelFilter(category, level),
          filterDesc: `${category}${LEVEL_NUM[level - 1]}级`
        })
      )
    }
  }
  appendCategory('管理人员', 10)
  appendCategory('专业技术人员', 13)
  appendCategory('工勤技能人员', 5)
  return makeResult('gov-8-position', reportRows, columns, rows.length)
}

async function runGov1201Skilled(): Promise<StatReportResult> {
  const rows = await loadHrRows()
  const skilled = rowsByPost(rows, '工勤技能人员')
  const reportRows: StatReportRow[] = [
    row('总计', makeGovMetrics(skilled), {
      isTotal: true,
      filter: [postCategoryFilter('工勤技能人员')],
      filterDesc: '职级识别为工勤技能人员'
    })
  ]
  for (let level = 1; level <= 5; level += 1) {
    const subset = rowsByPost(rows, '工勤技能人员', level)
    reportRows.push(
      row(`${LEVEL_NUM[level - 1]}级`, makeGovMetrics(subset), {
        indent: 1,
        isSectionHeader: subset.length === 0,
        filter: postLevelFilter('工勤技能人员', level),
        filterDesc: `工勤技能人员${LEVEL_NUM[level - 1]}级`
      })
    )
  }
  return makeResult('gov-1201-skilled', reportRows, GOV_COLUMNS, skilled.length)
}

async function runGov1208SeniorTitle(): Promise<StatReportResult> {
  const rows = await loadHrRows()
  const zhenggao = rows.filter((item) => seniorTitleKind(item) === '正高')
  const fugao = rows.filter((item) => seniorTitleKind(item) === '副高')
  return makeResult(
    'gov-1208-senior-title',
    [
      row('正高职称', { 合计: zhenggao.length }, {
        filter: [{ field: '职称', op: 'computed', computedKind: 'seniorTitle', values: ['正高'] }],
        filterDesc: '职称识别为正高'
      }),
      row('副高职称', { 合计: fugao.length }, {
        filter: [{ field: '职称', op: 'computed', computedKind: 'seniorTitle', values: ['副高'] }],
        filterDesc: '职称识别为副高'
      })
    ],
    [{ key: '合计', label: '合计', width: 80 }],
    rows.length
  )
}

function seniorTitleKind(row: RawRow): '正高' | '副高' | '' {
  const title = text(row, '职称')
  if (/正高|教授|研究员/.test(title) && !/副/.test(title)) return '正高'
  if (/副高|副教授|副研究员|高级/.test(title) && !/正高/.test(title)) return '副高'
  return ''
}

function groupByField(rows: RawRow[], field: string): Map<string, RawRow[]> {
  const groups = new Map<string, RawRow[]>()
  for (const item of rows) {
    const rawValue = text(item, field)
    const value = normalizeReportFieldValue(field, rawValue) || '（未填）'
    groups.set(value, [...(groups.get(value) ?? []), item])
  }
  return groups
}

function buildSimpleReport(id: string, field: string, rows: RawRow[]): StatReportResult {
  const def = findDef(id)
  const groups = [...groupByField(rows, field).entries()].sort((left, right) => {
    if (left[0] === '（未填）') return 1
    if (right[0] === '（未填）') return -1
    return right[1].length - left[1].length
  })
  const reportRows: StatReportRow[] = [
    row('总计', makeMetrics(rows), { isTotal: true, filterDesc: `来源：${HR_TABLE} 在职记录` })
  ]
  for (const [value, subset] of groups) {
    const empty = value === '（未填）'
    reportRows.push(
      row(value, makeMetrics(subset), {
        indent: 1,
        filter: [empty ? { field, op: 'is_null' } : { field, op: 'eq', values: [value] }],
        filterDesc: empty ? `${field}为空` : `${field} = ${value}`
      })
    )
  }
  return {
    id,
    name: def.name,
    columns: METRIC_COLUMNS,
    rows: reportRows,
    generatedAt: new Date().toLocaleString('zh-CN'),
    dataCount: rows.length
  }
}

async function runByAge(): Promise<StatReportResult> {
  return buildBucketReport('by-age', '出生日期', AGE_BUCKETS, ageOf, 'age')
}

async function runByTenure(): Promise<StatReportResult> {
  return buildBucketReport('by-tenure', '工龄', YEARS_BUCKETS, tenureOf, 'tenure')
}

async function runByTownshipYears(): Promise<StatReportResult> {
  return buildBucketReport('by-township-years', '乡镇工作年限', YEARS_BUCKETS, townshipYearsOf, 'townshipYears')
}

async function buildBucketReport(
  id: string,
  field: string,
  buckets: Array<{ key: string; lo: number | null; hi: number | null }>,
  getter: (row: RawRow) => number | null,
  computedKind: 'age' | 'tenure' | 'townshipYears'
): Promise<StatReportResult> {
  const rows = await loadHrRows()
  const reportRows: StatReportRow[] = [
    row('总计', makeMetrics(rows), { isTotal: true, filterDesc: `来源：${HR_TABLE} 在职记录` })
  ]
  for (const bucket of buckets) {
    const subset = rows.filter((item) => inRange(getter(item), bucket.lo, bucket.hi))
    reportRows.push(
      row(bucket.key, makeMetrics(subset), {
        indent: 1,
        filter: [{ field, op: 'computed', computedKind, computedRange: [bucket.lo, bucket.hi] }],
        filterDesc: `${field}：${bucket.key}`
      })
    )
  }
  const unknown = rows.filter((item) => getter(item) === null)
  if (unknown.length > 0) {
    reportRows.push(
      row(`${field}未填`, makeMetrics(unknown), {
        indent: 1,
        filter: [{ field, op: 'is_null' }],
        filterDesc: `${field}为空`
      })
    )
  }
  const def = findDef(id)
  return {
    id,
    name: def.name,
    columns: METRIC_COLUMNS,
    rows: reportRows,
    generatedAt: new Date().toLocaleString('zh-CN'),
    dataCount: rows.length
  }
}

const RUNNERS: Record<string, () => Promise<StatReportResult>> = {
  'gov-2-staff-basic': runGov2StaffBasic,
  'gov-3-classification': runGov3Classification,
  'gov-5-tech': runGov5Tech,
  'gov-8-position': runGov8Position,
  'gov-1201-skilled': runGov1201Skilled,
  'gov-1208-senior-title': runGov1208SeniorTitle,
  'by-unit': async () => buildSimpleReport('by-unit', '单位名称', await loadHrRows()),
  'by-post-level': async () => buildSimpleReport('by-post-level', '职级', await loadHrRows()),
  'by-title': async () => buildSimpleReport('by-title', '职称', await loadHrRows()),
  'by-salary-grade': async () => buildSimpleReport('by-salary-grade', '薪级', await loadHrRows()),
  'by-education': async () => buildSimpleReport('by-education', '最高学历', await loadHrRows()),
  'by-political': async () => buildSimpleReport('by-political', '政治面貌', await loadHrRows()),
  'by-gender': async () => buildSimpleReport('by-gender', '性别', await loadHrRows()),
  'by-ethnic': async () => buildSimpleReport('by-ethnic', '民族', await loadHrRows()),
  'by-age': runByAge,
  'by-tenure': runByTenure,
  'by-township-years': runByTownshipYears
}

export async function runStatReport(id: string): Promise<StatReportResult> {
  const runner = RUNNERS[id]
  if (!runner) throw new Error(`未知统计报表：${id}`)
  try {
    return await runner()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) {
      const def = findDef(id)
      return {
        id,
        name: def.name,
        columns: [{ key: '提示', label: '提示', width: 240 }],
        rows: [
          {
            label: `请先建立或导入「${HR_TABLE}」`,
            indent: 0,
            isTotal: false,
            isSectionHeader: true,
            values: { 提示: '统计报表只读取人事信息主表' },
            filter: []
          }
        ],
        generatedAt: new Date().toLocaleString('zh-CN'),
        dataCount: 0
      }
    }
    throw error
  }
}

export async function exportStatReport(
  result: StatReportResult
): Promise<{ filePath: string; rowCount: number }> {
  const exportDir = getDataPath('统计报表导出')
  mkdirSync(exportDir, { recursive: true })
  const safeName = result.name.replace(/[\\/:*?"<>|]/g, '_')
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[\/\s:]/g, '').replace(/,/g, '')
  const filePath = join(exportDir, `${safeName}_${stamp}.xlsx`)

  const header = ['项目', ...result.columns.map((column) => column.label), '筛选条件']
  const rows = result.rows.map((item) => [
    item.label,
    ...result.columns.map((column) => item.values[column.key] ?? ''),
    item.filterDesc ?? ''
  ])
  const sheet = XLSX.utils.aoa_to_sheet([
    [result.name],
    [`生成时间：${result.generatedAt}　数据行数：${result.dataCount}　数据源：${HR_TABLE}`],
    [],
    header,
    ...rows
  ])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName(result.name))
  writeFileSync(filePath, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }))
  return { filePath, rowCount: result.rows.length }
}

export async function drillStatReport(
  filters: StatReportFilterClause[],
  filterDesc: string,
  columnKey?: string,
  columnLabel?: string
): Promise<StatReportDrillResult> {
  const rows = lastLoadedRows ?? (await loadHrRows())
  const columnFilter = columnKey ? columnKeyToFilter(columnKey) : []
  const matched = applyFilters(rows, [...filters, ...columnFilter])
  const result: StatReportDrillResult = {
    filterDesc: columnKey && columnLabel ? `${filterDesc} / ${columnLabel}` : filterDesc,
    fields: MASTER_FIELDS,
    rows: matched.map((item) => {
      const output: Record<string, string | number | null> = {}
      for (const field of MASTER_FIELDS) output[field] = toCloneableCellValue(item[field])
      return output
    }),
    totalRows: matched.length
  }
  return JSON.parse(JSON.stringify(result)) as StatReportDrillResult
}

function toCloneableCellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value
  return String(value)
}

function columnKeyToFilter(key: string): StatReportFilterClause[] {
  if (!key || key === '合计' || key === '教育') return []
  if (key === '男' || key === '女') return [{ field: '性别', op: 'eq', values: [key] }]
  if (key === '汉族') return [{ field: '民族', op: 'in', values: ['汉', '汉族'] }]
  if (key === '少数民族') {
    return [
      { field: '民族', op: 'not_null' },
      { field: '民族', op: 'not_in', values: ['汉', '汉族'] }
    ]
  }
  if (key === '党员' || key === '中共党员') {
    return [{ field: '政治面貌', op: 'contains', values: PARTY_KEYWORDS }]
  }
  if (key === '非党员') {
    return [
      { field: '政治面貌', op: 'not_null' },
      { field: '政治面貌', op: 'not_in', values: PARTY_KEYWORDS }
    ]
  }
  const edu = EDU_BUCKETS.find((bucket) => bucket.key === key)
  if (edu) {
    const valuesByKey: Record<string, string[]> = {
      博士: ['博士', '博士后'],
      硕士: ['硕士', '研究生'],
      本科: ['大学本科', '大学肄业'],
      大专: ['大学专科', '专科肄业'],
      中专: ['中专'],
      高中及以下: ['高中', '初中', '小学', '文盲或半文盲']
    }
    return [{ field: '最高学历', op: 'in', values: valuesByKey[key] ?? [key] }]
  }
  const age = AGE_BUCKETS.find((bucket) => bucket.key === key)
  if (age) return [{ field: '出生日期', op: 'computed', computedKind: 'age', computedRange: [age.lo, age.hi] }]
  const years = YEARS_BUCKETS.find((bucket) => bucket.key === key)
  if (years) return [{ field: '工龄', op: 'computed', computedKind: 'tenure', computedRange: [years.lo, years.hi] }]

  const postMatch = key.match(/^(管理|专技|工勤)(\d+)$/)
  if (postMatch) {
    const category =
      postMatch[1] === '管理' ? '管理人员' : postMatch[1] === '专技' ? '专业技术人员' : '工勤技能人员'
    return postLevelFilter(category, Number(postMatch[2]))
  }
  return []
}

function applyFilters(rows: RawRow[], filters: StatReportFilterClause[]): RawRow[] {
  return rows.filter((item) => {
    for (const filter of filters) {
      if (!matchesFilter(item, filter)) return false
    }
    return true
  })
}

function matchesFilter(row: RawRow, filter: StatReportFilterClause): boolean {
  const rawValue = text(row, filter.field)
  const value = normalizeReportFieldValue(filter.field, rawValue)
  const values = (filter.values ?? []).map((item) => normalizeReportFieldValue(filter.field, item))
  if (filter.op === 'eq') return values.includes(value)
  if (filter.op === 'in') return values.some((item) => value === item || value.includes(item))
  if (filter.op === 'not_in') return !values.some((item) => value === item || value.includes(item))
  if (filter.op === 'contains') return values.some((item) => value.includes(item))
  if (filter.op === 'is_null') return value === ''
  if (filter.op === 'not_null') return value !== ''
  if (filter.op !== 'computed') return true

  if (filter.computedKind === 'age') {
    const [lo, hi] = filter.computedRange ?? [null, null]
    return inRange(ageOf(row), lo, hi)
  }
  if (filter.computedKind === 'tenure') {
    const [lo, hi] = filter.computedRange ?? [null, null]
    return inRange(tenureOf(row), lo, hi)
  }
  if (filter.computedKind === 'townshipYears') {
    const [lo, hi] = filter.computedRange ?? [null, null]
    return inRange(townshipYearsOf(row), lo, hi)
  }
  if (filter.computedKind === 'postCategory') {
    return values.includes(parsePostLevel(row).category)
  }
  if (filter.computedKind === 'postLevel') {
    return values.includes(String(parsePostLevel(row).level ?? ''))
  }
  if (filter.computedKind === 'seniorTitle') {
    return values.includes(seniorTitleKind(row))
  }
  return true
}

function normalizeReportFieldValue(field: string, value: unknown): string {
  if (field === '最高学历') return normalizeEducationForCompare(value)
  if (field === '职级') return normalizeJobLevelForDisplay(value)
  if (field === '薪级') return normalizeSalaryGradeForDisplay(value)
  return String(value ?? '').trim()
}

function makeResult(
  id: string,
  rows: StatReportRow[],
  columns: StatReportColumn[],
  dataCount: number
): StatReportResult {
  const def = findDef(id)
  return {
    id,
    name: def.name,
    columns,
    rows,
    generatedAt: new Date().toLocaleString('zh-CN'),
    dataCount
  }
}

function findDef(id: string): StatReportDef {
  const def = STAT_REPORT_DEFS.find((item) => item.id === id)
  if (!def) throw new Error(`未知统计报表：${id}`)
  return def
}

function safeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, '').slice(0, 31) || '统计报表'
}
