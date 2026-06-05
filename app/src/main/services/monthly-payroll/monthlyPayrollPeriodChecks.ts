import type {
  MonthlyPayrollSourcePeriodInspection,
  MonthlyPayrollWorkflowInput
} from '../../../shared/types'
import { parseSocialSecurityWorkbook, parseTaxWorkbook } from './monthlyPayrollParsers'
import { normalizeMonthlyPayrollDataSourceMode, resolvePayrollPeriod } from './monthlyPayrollRuns'
import type { PayrollPeriodRange, SocialSecuritySummary, TaxSummary } from './monthlyPayrollTypes'
import { text } from './monthlyPayrollUtils'

// 业务口径：有工资表 Excel 时走兼容模式，用它校准本地工资数据；没有工资表时以本地工资表为权威来源。
export function normalizeMonthlyPayrollInput(
  input?: MonthlyPayrollWorkflowInput
): MonthlyPayrollWorkflowInput {
  const hasSalaryWorkbook = Boolean(input?.salaryWorkbookPath)
  const hasSocialSecurityWorkbook = Boolean(input?.socialSecurityWorkbookPath)
  const normalized: MonthlyPayrollWorkflowInput = {
    ...(input ?? {}),
    dataSourceMode: hasSalaryWorkbook ? 'salary-workbook' : 'integrated',
    processScope: hasSocialSecurityWorkbook ? 'salary-social' : 'salary'
  }
  if (!hasSocialSecurityWorkbook) {
    return { ...normalized, socialSecurityWorkbookPath: undefined }
  }
  return normalized
}

export function isIntegratedDataSource(input: MonthlyPayrollWorkflowInput | undefined): boolean {
  return normalizeMonthlyPayrollDataSourceMode(input?.dataSourceMode) === 'integrated'
}

export function missingSourceMessage(input: MonthlyPayrollWorkflowInput | undefined): string | null {
  if (!input) return '月度工资报账需要先选择处理月份。'
  return null
}

function currentPayrollPeriod(): { year: number; month: number } {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

export function assertCurrentPayrollPeriod(
  input: MonthlyPayrollWorkflowInput | undefined
): { year: number; month: number } {
  // 工资报账只允许当月重新生成，历史月份只能查看归档，防止覆盖已报账结果。
  const target = resolvePayrollPeriod(input)
  const current = currentPayrollPeriod()
  if (target.year !== current.year || target.month !== current.month) {
    throw new Error(`工资报账只能处理当月业务，请切回${current.year}年${current.month}月。`)
  }
  return target
}

function previousPayrollPeriod(period: { year: number; month: number }): { year: number; month: number } {
  return period.month > 1
    ? { year: period.year, month: period.month - 1 }
    : { year: period.year - 1, month: 12 }
}

function periodKey(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`
}

function periodLabelFromKey(key: string): string {
  const [year, month] = key.split('-')
  return `${Number(year)}年${Number(month)}月`
}

function periodRangeCovers(range: PayrollPeriodRange, key: string): boolean {
  const start = range.startMonth <= range.endMonth ? range.startMonth : range.endMonth
  const end = range.startMonth <= range.endMonth ? range.endMonth : range.startMonth
  return start <= key && key <= end
}

function periodRangeEqualsMonth(range: PayrollPeriodRange, key: string): boolean {
  return range.startMonth === key && range.endMonth === key
}

export function normalizeList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => text(value)).filter(Boolean)))
}

function formatPeriodRange(range: PayrollPeriodRange): string {
  const start = periodLabelFromKey(range.startMonth)
  const end = periodLabelFromKey(range.endMonth)
  return range.startMonth === range.endMonth ? start : `${start}至${end}`
}

function formatPeriodRanges(ranges: PayrollPeriodRange[]): string[] {
  return ranges
    .slice()
    .sort((left, right) =>
      left.startMonth.localeCompare(right.startMonth) || left.endMonth.localeCompare(right.endMonth)
    )
    .map(formatPeriodRange)
}

function buildSocialSecurityPeriodSummary(
  targetDate: { year: number; month: number },
  socialSecurity: SocialSecuritySummary
): MonthlyPayrollSourcePeriodInspection['socialSecurity'] {
  const targetKey = periodKey(targetDate)
  const targetLabel = periodLabelFromKey(targetKey)
  const extraPeriods = formatPeriodRanges(
    socialSecurity.periods.filter((range) => !periodRangeCovers(range, targetKey))
  )
  return {
    periods: formatPeriodRanges(socialSecurity.periods),
    message: extraPeriods.length
      ? `已检测到社保所属期：包含${targetLabel}，另含补缴/调整所属期 ${extraPeriods.join('、')}`
      : `已检测到社保所属期：包含${targetLabel}`
  }
}

function buildTaxPeriodSummary(
  targetDate: { year: number; month: number },
  tax: TaxSummary
): MonthlyPayrollSourcePeriodInspection['tax'] {
  const expectedKey = periodKey(previousPayrollPeriod(targetDate))
  return {
    periods: formatPeriodRanges(tax.periods),
    message: `已检测到个税所属期：${formatPeriodRanges(tax.periods).join('、')}（本月应申报${periodLabelFromKey(expectedKey)}个税）`
  }
}

export function validateMonthlyPayrollSourcePeriods(
  targetDate: { year: number; month: number },
  socialSecurity: SocialSecuritySummary | undefined,
  tax: TaxSummary | undefined
): void {
  const targetKey = periodKey(targetDate)
  const targetLabel = periodLabelFromKey(targetKey)

  if (socialSecurity) {
    if (socialSecurity.periods.length === 0) {
      throw new Error('社保文件未识别到“费款所属期起/止”，无法确认是否包含本月，请更换为含所属期列的社保未申报汇总。')
    }
    if (!socialSecurity.periods.some((range) => periodRangeCovers(range, targetKey))) {
      throw new Error(`社保文件必须包含${targetLabel}。当前检测到：${formatPeriodRanges(socialSecurity.periods).join('、')}，请更换文件。`)
    }
  }

  if (tax) {
    const expectedKey = periodKey(previousPayrollPeriod(targetDate))
    const expectedLabel = periodLabelFromKey(expectedKey)
    if (tax.periods.length === 0) {
      throw new Error('个税文件未识别到“税款所属期起/止”，无法确认是否为上月个税，请更换为含所属期列的个税计算表。')
    }
    if (!tax.periods.every((range) => periodRangeEqualsMonth(range, expectedKey))) {
      throw new Error(`个税文件税款所属期应为${expectedLabel}（${targetLabel}申报上月个税）。当前检测到：${formatPeriodRanges(tax.periods).join('、')}，请更换文件。`)
    }
  }
}

export async function inspectMonthlyPayrollSourcePeriods(
  input?: MonthlyPayrollWorkflowInput
): Promise<MonthlyPayrollSourcePeriodInspection> {
  input = normalizeMonthlyPayrollInput(input)
  const targetDate = assertCurrentPayrollPeriod(input)
  const [socialSecurity, tax] = await Promise.all([
    input.socialSecurityWorkbookPath
      ? parseSocialSecurityWorkbook(input.socialSecurityWorkbookPath)
      : Promise.resolve<SocialSecuritySummary | undefined>(undefined),
    input.taxWorkbookPath
      ? parseTaxWorkbook(input.taxWorkbookPath)
      : Promise.resolve<TaxSummary | undefined>(undefined)
  ])
  validateMonthlyPayrollSourcePeriods(targetDate, socialSecurity, tax)
  return {
    socialSecurity: socialSecurity ? buildSocialSecurityPeriodSummary(targetDate, socialSecurity) : undefined,
    tax: tax ? buildTaxPeriodSummary(targetDate, tax) : undefined
  }
}
