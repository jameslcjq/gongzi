import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { session, type Session } from 'electron'
import * as XLSX from 'xlsx'
import { getMonthlyOutputPath, portalPartitionPrefix } from '../config/paths'
import { portalBaseUrl } from '../../shared/portalHost'
import { readUnitSettings } from './unitSettings'
import type {
  IntegratedHistorySalaryDataset,
  IntegratedHistorySalaryPeriod,
  IntegratedHistorySalaryPerson,
  PerformancePayrollGenerateInput,
  PerformancePayrollGenerateResult,
  PerformancePayrollHistoryGenerateInput,
  PerformancePayrollLocalGenerateInput,
  SalaryExportSaltype
} from '../../shared/types'

type OutputRow = {
  name: string
  idCard: string
  jobSalary: number | ''
  salaryLevel: number | ''
  baseSubtotal: number | ''
  postAllowance: number
  livingAllowance: number
  ruralTeacherAllowance: ''
  monthlyStandardSubtotal: number
  months: number | ''
  annualAmount: number | ''
  remark: string
}

const headers = [
  '姓名',
  '证件号码',
  '岗位工资',
  '薪级工资',
  '小计',
  '岗位津贴',
  '生活补贴',
  '农村学校教师补贴',
  '月标准小计',
  '计发月份',
  '全年金额',
  '备注'
]

const portalBase = portalBaseUrl(process.env)
const historyMenuId = 'ede8c46b689746e48544943b30fb6772'

type HistoryAgency = {
  agencyId: string
  agencyCode: string
  agencyName: string
}

type HistoryColumn = {
  code: string
  name: string
}

type HistoryColumnMap = {
  name: string
  idCard: string
  jobSalary: string
  salaryLevel: string
  postAllowance: string
  livingAllowance: string
}

export async function generatePerformancePayrollFromHistory(
  input: PerformancePayrollHistoryGenerateInput
): Promise<PerformancePayrollGenerateResult> {
  if (samePeriod(input.firstPeriod, input.secondPeriod)) {
    throw new Error('请选择两个不同月份')
  }

  const unit = await readUnitSettings()
  const saltype = pickPerformanceSaltype(unit.salaryExportSaltypes)
  const portalSession = session.fromPartition(integratedPortalPartition(unit.unitImportCode, '0101'))

  await preheatHistoryContext(portalSession)
  const agencies = await loadHistoryAgencies(portalSession)
  const agency = chooseAgency(agencies, unit.unitFullName)

  const first = await loadHistoryDataset(portalSession, agency, saltype, input.firstPeriod)
  const second = await loadHistoryDataset(portalSession, agency, saltype, input.secondPeriod)

  return generatePerformancePayroll({
    unitName: unit.unitFullName,
    first,
    second
  })
}

function integratedPortalPartition(unitCode: string, suffix: '0101' | '0201'): string {
  const normalizedUnit = String(unitCode || '').replace(/\D/g, '').slice(0, 6) || 'unit'
  return `persist:${portalPartitionPrefix}-${normalizedUnit}-${suffix}`
}

export async function generatePerformancePayrollFromLocal(
  input: PerformancePayrollLocalGenerateInput
): Promise<PerformancePayrollGenerateResult> {
  if (samePeriod(input.firstPeriod, input.secondPeriod)) {
    throw new Error('请选择两个不同月份')
  }
  const unit = await readUnitSettings()
  const first = readLocalHistoryWorkbook(input.firstWorkbookPath, input.firstPeriod)
  const second = readLocalHistoryWorkbook(input.secondWorkbookPath, input.secondPeriod)
  return generatePerformancePayroll({
    unitName: unit.unitFullName,
    first,
    second
  })
}

export function generatePerformancePayroll(
  input: PerformancePayrollGenerateInput
): PerformancePayrollGenerateResult {
  const warnings = [...input.first.warnings, ...input.second.warnings]
  const firstPeople = normalizeDataset(input.first, `${periodLabel(input.first)} 第一份`, warnings)
  const secondPeople = normalizeDataset(input.second, `${periodLabel(input.second)} 第二份`, warnings)
  const secondById = new Map(secondPeople.map((person) => [person.idCard, person]))

  const outputRows: OutputRow[] = []
  let matchedCount = 0
  let changedCount = 0
  let secondMissingCount = 0

  for (const first of firstPeople) {
    const second = secondById.get(first.idCard)
    if (!second) {
      secondMissingCount += 1
      outputRows.push(toOutputRow(first, '', '退休/调出'))
      continue
    }

    matchedCount += 1
    if (roundMoney(first.jobSalary - second.jobSalary) !== 0) {
      changedCount += 1
      outputRows.push(toOutputRow(first, '', '晋级/小档'))
      outputRows.push(toOutputRow(second, '', '晋级/小档'))
    } else {
      outputRows.push(toOutputRow(first, 12, ''))
    }
    secondById.delete(first.idCard)
  }

  let firstMissingCount = 0
  for (const second of secondById.values()) {
    firstMissingCount += 1
    outputRows.push(toSpecialOutputRow(second, 4, '新进/调入'))
  }

  const unitName = sanitizeFileName(input.unitName || input.first.agencyName || input.second.agencyName || '结果表')
  const outputDir = getMonthlyOutputPath()
  mkdirSync(outputDir, { recursive: true })
  const filePath = join(
    outputDir,
    `${unitName}绩效工资_${periodLabel(input.first)}_${periodLabel(input.second)}_${stamp()}.xlsx`
  )

  writePerformanceWorkbook(filePath, outputRows)

  return {
    ok: true,
    filePath,
    rowCount: outputRows.length,
    matchedCount,
    changedCount,
    firstMissingCount,
    secondMissingCount,
    warnings
  }
}

function readLocalHistoryWorkbook(
  filePath: string,
  period: IntegratedHistorySalaryPeriod
): IntegratedHistorySalaryDataset {
  const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer', cellDates: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error(`工资表没有工作表：${filePath}`)
  const rows = XLSX.utils.sheet_to_json<Array<string | number | null>>(workbook.Sheets[sheetName], {
    header: 1,
    defval: null,
    raw: false
  })
  const people = parseLocalSalaryRows(rows)
  return {
    ...period,
    agencyId: '',
    agencyName: '',
    saltypeId: '',
    saltypeName: '',
    salbatchId: '',
    salbatchName: '',
    people,
    warnings: []
  }
}

function parseLocalSalaryRows(rows: Array<Array<string | number | null>>): IntegratedHistorySalaryPerson[] {
  const headerIndex = findLocalHeaderRow(rows)
  const people: IntegratedHistorySalaryPerson[] = []
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 1
  const indexes = headerIndex >= 0
    ? buildLocalHeaderIndexes(rows[headerIndex].map((cell) => text(cell)))
    : { name: 6, idCard: 7, jobSalary: 12, salaryLevel: 13, postAllowance: 14, livingAllowance: 15 }

  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index]
    const idCard = normalizeIdCard(row[indexes.idCard])
    if (!idCard) continue
    people.push({
      name: text(row[indexes.name]),
      idCard,
      jobSalary: roundMoney(num(row[indexes.jobSalary])),
      salaryLevel: roundMoney(num(row[indexes.salaryLevel])),
      postAllowance: roundMoney(num(row[indexes.postAllowance])),
      livingAllowance: roundMoney(num(row[indexes.livingAllowance])),
      rowNumber: index + 1
    })
  }
  return people
}

function findLocalHeaderRow(rows: Array<Array<string | number | null>>): number {
  return rows.findIndex((row) => {
    const headers = row.map((cell) => normalizeFieldName(text(cell)))
    return headers.includes('姓名') &&
      headers.some((header) => ['证件号码', '身份证号', '身份证号码'].includes(header)) &&
      headers.includes('岗位工资')
  })
}

function buildLocalHeaderIndexes(headers: string[]): {
  name: number
  idCard: number
  jobSalary: number
  salaryLevel: number
  postAllowance: number
  livingAllowance: number
} {
  return {
    name: findHeaderIndex(headers, ['姓名', '人员姓名', '职工姓名']),
    idCard: findHeaderIndex(headers, ['证件号码', '身份证号', '身份证号码', '身份证件号码']),
    jobSalary: findHeaderIndex(headers, ['岗位工资']),
    salaryLevel: findHeaderIndex(headers, ['薪级工资']),
    postAllowance: findHeaderIndex(headers, ['岗位津贴']),
    livingAllowance: findHeaderIndex(headers, ['生活补贴'])
  }
}

function findHeaderIndex(headers: string[], labels: string[]): number {
  const normalized = headers.map(normalizeFieldName)
  const wanted = labels.map(normalizeFieldName)
  const exact = normalized.findIndex((header) => wanted.includes(header))
  if (exact >= 0) return exact
  const fuzzy = normalized.findIndex((header) =>
    wanted.some((label) => header.includes(label) || label.includes(header))
  )
  if (fuzzy >= 0) return fuzzy
  throw new Error(`工资表缺少字段：${labels[0]}`)
}

async function preheatHistoryContext(portalSession: Session): Promise<void> {
  await safeFetch(
    portalSession,
    `/salary-pro-web/grp/salaryNanJ/html/historySelect/salAuditHistory.html?menuid=${historyMenuId}&moduleid=${historyMenuId}&myMenuid=2020120628512`
  )
  await safeFetch(
    portalSession,
    `/sal-salary-pro-server/grpSalaryController/getCurrenetSession?menuid=${historyMenuId}`
  )
}

async function safeFetch(portalSession: Session, path: string): Promise<void> {
  try {
    await portalSession.fetch(`${portalBase}${path}`)
  } catch {
    // 预热失败不直接中断，后续核心接口会给出明确错误。
  }
}

async function loadHistoryAgencies(portalSession: Session): Promise<HistoryAgency[]> {
  const data = await fetchJson<{
    data?: Array<Record<string, unknown>>
  }>(
    portalSession,
    `/sal-query-pro-server/salaryQueryController/getAllAgencyHN?ele_code=Agency&menuid=${historyMenuId}&judge=1&_=${Date.now()}`
  )
  return (data.data ?? [])
    .map((item) => ({
      agencyId: text(item.id ?? item.ID),
      agencyCode: text(item.CODE ?? item.code ?? item.agency_code),
      agencyName: text(item.NAME ?? item.name ?? item.CODENAME)
    }))
    .filter((item) => Boolean(item.agencyId))
}

function chooseAgency(agencies: HistoryAgency[], unitName: string): HistoryAgency {
  if (agencies.length === 0) throw new Error('一体化历史工资没有返回可访问单位，请先在“一体化对接”登录')
  const normalizedUnit = text(unitName)
  if (!normalizedUnit) return agencies[0]
  const matched = agencies.find((agency) =>
    agency.agencyName.includes(normalizedUnit) || normalizedUnit.includes(agency.agencyName)
  )
  if (matched) return matched
  throw new Error(
    `按单位“${normalizedUnit}”未匹配到历史工资单位。可用单位：${agencies
      .map((agency) => `${agency.agencyCode} ${agency.agencyName}`.trim())
      .join('、')}`
  )
}

function pickPerformanceSaltype(saltypes: SalaryExportSaltype[] | undefined): SalaryExportSaltype {
  return (
    (saltypes ?? []).find((item) =>
      /事业/.test(item.saltype_name) && !/退休|离休|遗/.test(item.saltype_name)
    ) ?? { saltype_id: '2', saltype_name: '事业' }
  )
}

async function loadHistoryDataset(
  portalSession: Session,
  agency: HistoryAgency,
  saltype: SalaryExportSaltype,
  period: IntegratedHistorySalaryPeriod
): Promise<IntegratedHistorySalaryDataset> {
  const salbatchId = '1'
  const columns = await loadHistoryColumns(portalSession, agency, saltype, salbatchId, period.year)
  const columnMap = buildColumnMap(columns)
  const rows = await loadHistoryRows(portalSession, agency, saltype, salbatchId, period)
  const people: IntegratedHistorySalaryPerson[] = []
  const warnings: string[] = []

  rows.forEach((row, index) => {
    const idCard = normalizeIdCard(row[columnMap.idCard])
    if (!idCard) {
      warnings.push(`${periodLabel(period)} 第 ${index + 1} 行缺少证件号码，已跳过`)
      return
    }
    people.push({
      name: text(row[columnMap.name]),
      idCard,
      jobSalary: roundMoney(num(row[columnMap.jobSalary])),
      salaryLevel: roundMoney(num(row[columnMap.salaryLevel])),
      postAllowance: roundMoney(num(row[columnMap.postAllowance])),
      livingAllowance: roundMoney(num(row[columnMap.livingAllowance])),
      rowNumber: index + 1
    })
  })

  return {
    ...period,
    agencyId: agency.agencyId,
    agencyName: agency.agencyName,
    agencyCode: agency.agencyCode,
    saltypeId: saltype.saltype_id,
    saltypeName: saltype.saltype_name,
    salbatchId,
    salbatchName: '[001]工资',
    people,
    warnings
  }
}

async function loadHistoryColumns(
  portalSession: Session,
  agency: HistoryAgency,
  saltype: SalaryExportSaltype,
  salbatchId: string,
  year: number
): Promise<HistoryColumn[]> {
  const data = await fetchJson<{
    data?: { itemColList?: Array<Record<string, unknown>> }
  }>(
    portalSession,
    `/sal-config-pro-server/salSalaryItem/loadSalaryCollection?menuid=${historyMenuId}`,
    {
      method: 'POST',
      body: {
        agency_id: agency.agencyId,
        saltype_id: saltype.saltype_id,
        salbatch_id: salbatchId,
        year: String(year)
      }
    }
  )
  return (data.data?.itemColList ?? [])
    .map((item) => ({
      code: text(item.field_code ?? item.item_code ?? item.sal_item_code),
      name: text(item.field_name ?? item.item_name ?? item.sal_item_name)
    }))
    .filter((item) => Boolean(item.code && item.name))
}

async function loadHistoryRows(
  portalSession: Session,
  agency: HistoryAgency,
  saltype: SalaryExportSaltype,
  salbatchId: string,
  period: IntegratedHistorySalaryPeriod
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = []
  const pageSize = 500
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const data = await fetchJson<{
      data?: { pageData?: Array<Record<string, unknown>> }
    }>(
      portalSession,
      `/sal-query-pro-server/salaryQueryController/loadSalaryAll?menuid=${historyMenuId}`,
      {
        method: 'POST',
        body: {
          agency_id: agency.agencyId,
          bdep_id: '0',
          saltype_id: saltype.saltype_id,
          month: String(period.month),
          year: String(period.year),
          salbatch_id: salbatchId,
          ic_id: '',
          name: '',
          pageIndex,
          pageSize
        }
      }
    )
    const pageRows = data.data?.pageData ?? []
    rows.push(...pageRows)
    if (pageRows.length < pageSize) break
  }
  return rows
}

async function fetchJson<T>(
  portalSession: Session,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {}
): Promise<T> {
  const response = await portalSession.fetch(`${portalBase}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json;charset=UTF-8' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  if (!response.ok) throw new Error(`一体化接口请求失败：${path} HTTP ${response.status}`)
  const data = (await response.json()) as T & { status_code?: string; reason?: string }
  if (data.status_code && data.status_code !== '1001' && data.status_code !== '0000') {
    throw new Error(`一体化接口返回异常：${data.reason || data.status_code}`)
  }
  return data
}

function buildColumnMap(columns: HistoryColumn[]): HistoryColumnMap {
  const map = {
    name: findColumn(columns, ['姓名', '人员姓名', '职工姓名', '名称']) || 'name',
    idCard: findColumn(columns, ['身份证号', '身份证号码', '证件号码', '身份证件号码', '公民身份号码']) || 'ic_id',
    jobSalary: findColumn(columns, ['岗位工资']),
    salaryLevel: findColumn(columns, ['薪级工资']),
    postAllowance: findColumn(columns, ['岗位津贴']),
    livingAllowance: findColumn(columns, ['生活补贴'])
  }
  const missing: string[] = []
  if (!map.jobSalary) missing.push('岗位工资')
  if (!map.salaryLevel) missing.push('薪级工资')
  if (!map.postAllowance) missing.push('岗位津贴')
  if (!map.livingAllowance) missing.push('生活补贴')
  if (missing.length) {
    throw new Error(
      `历史工资字段定义缺少：${missing.join('、')}。已返回字段：${columns
        .map((column) => column.name)
        .slice(0, 80)
        .join('、')}`
    )
  }
  return map
}

function findColumn(columns: HistoryColumn[], labels: string[]): string {
  const wanted = labels.map(normalizeFieldName)
  const exact = columns.find((column) => wanted.includes(normalizeFieldName(column.name)))
  if (exact) return exact.code
  const fuzzy = columns.find((column) => {
    const current = normalizeFieldName(column.name)
    return wanted.some((label) => current.includes(label) || label.includes(current))
  })
  return fuzzy?.code ?? ''
}

function normalizeDataset(
  dataset: IntegratedHistorySalaryDataset,
  label: string,
  warnings: string[]
): IntegratedHistorySalaryPerson[] {
  const byId = new Map<string, IntegratedHistorySalaryPerson>()
  for (const person of dataset.people) {
    const idCard = normalizeIdCard(person.idCard)
    if (!idCard) continue
    if (byId.has(idCard)) {
      warnings.push(`${label}：${person.name || idCard} 证件号码重复，已保留最后一条`)
    }
    byId.set(idCard, {
      ...person,
      idCard,
      name: text(person.name),
      jobSalary: roundMoney(num(person.jobSalary)),
      salaryLevel: roundMoney(num(person.salaryLevel)),
      postAllowance: roundMoney(num(person.postAllowance)),
      livingAllowance: roundMoney(num(person.livingAllowance))
    })
  }
  return Array.from(byId.values())
}

function toOutputRow(
  person: IntegratedHistorySalaryPerson,
  months: number | '',
  remark: string
): OutputRow {
  const baseSubtotal = months === ''
    ? ''
    : Math.ceil(((person.jobSalary + person.salaryLevel) / 12) * months)
  const monthlyStandardSubtotal = roundMoney(person.postAllowance + person.livingAllowance)
  return {
    name: person.name,
    idCard: person.idCard,
    jobSalary: person.jobSalary,
    salaryLevel: person.salaryLevel,
    baseSubtotal,
    postAllowance: person.postAllowance,
    livingAllowance: person.livingAllowance,
    ruralTeacherAllowance: '',
    monthlyStandardSubtotal,
    months,
    annualAmount: months === '' ? '' : roundMoney(monthlyStandardSubtotal * months),
    remark
  }
}

function toSpecialOutputRow(
  person: IntegratedHistorySalaryPerson,
  months: number,
  remark: string
): OutputRow {
  const monthlyStandardSubtotal = roundMoney(person.postAllowance + person.livingAllowance)
  return {
    name: person.name,
    idCard: person.idCard,
    jobSalary: '',
    salaryLevel: '',
    baseSubtotal: '',
    postAllowance: person.postAllowance,
    livingAllowance: person.livingAllowance,
    ruralTeacherAllowance: '',
    monthlyStandardSubtotal,
    months,
    annualAmount: roundMoney(monthlyStandardSubtotal * months),
    remark
  }
}

function writePerformanceWorkbook(filePath: string, rows: OutputRow[]): void {
  const data = [
    headers,
    ...rows.map((row) => [
      row.name,
      row.idCard,
      row.jobSalary,
      row.salaryLevel,
      row.baseSubtotal,
      row.postAllowance,
      row.livingAllowance,
      row.ruralTeacherAllowance,
      row.monthlyStandardSubtotal,
      row.months,
      row.annualAmount,
      row.remark
    ])
  ]
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet(data)
  sheet['!cols'] = [12, 24, 12, 12, 12, 12, 12, 20, 14, 10, 12, 16].map((wch) => ({ wch }))
  XLSX.utils.book_append_sheet(workbook, sheet, '绩效工资')
  writeFileSync(filePath, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }))
}

function periodLabel(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`
}

function samePeriod(
  first: IntegratedHistorySalaryPeriod,
  second: IntegratedHistorySalaryPeriod
): boolean {
  return first.year === second.year && first.month === second.month
}

function normalizeFieldName(value: string): string {
  return value.replace(/[\s()（）]/g, '').toLowerCase()
}

function sanitizeFileName(value: string): string {
  return text(value).replace(/[\\/:*?"<>|]/g, '_') || '结果表'
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/[T.]/g, '_')
    .slice(0, 17)
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function normalizeIdCard(value: unknown): string {
  return text(value).replace(/[\s,]/g, '').toUpperCase()
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Number(text(value).replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
