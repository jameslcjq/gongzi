import type {
  IntegratedActiveAggregates,
  IntegratedSimpleAggregates,
  RetiredSummary,
  SalarySummary
} from './monthlyPayrollTypes'
import type {
  IntegratedActiveRecomputeResult,
  IntegratedSimplePaySummary
} from './integratedPayroll'
import { formatMoney, num } from './monthlyPayrollUtils'

type MonthlyPayrollBusinessSummary = {
  activeCount: number
  activePayableTotal: number
  activeActualPay: number
  survivorCount: number
  survivorActualPay: number
  retiredHousingCount: number
  retiredHousingActualPay: number
}

export function buildBusinessSummary(input: {
  active?: IntegratedActiveRecomputeResult
  survivor?: IntegratedSimplePaySummary
  retiredHousing?: IntegratedSimplePaySummary
}): MonthlyPayrollBusinessSummary {
  return {
    activeCount: input.active?.rowCount ?? 0,
    activePayableTotal: input.active?.payableTotal ?? 0,
    activeActualPay: input.active?.actualPayTotal ?? 0,
    survivorCount: input.survivor?.rowCount ?? 0,
    survivorActualPay: input.survivor?.actualPayTotal ?? 0,
    retiredHousingCount: input.retiredHousing?.rowCount ?? 0,
    retiredHousingActualPay: input.retiredHousing?.actualPayTotal ?? 0
  }
}

export function buildSalaryWorkbookBusinessSummary(
  salary: SalarySummary | undefined,
  retired: RetiredSummary
): MonthlyPayrollBusinessSummary {
  return {
    activeCount: salary?.activePeople.length ?? 0,
    activePayableTotal: salary ? num(salary.active['应发工资合计']) : 0,
    activeActualPay: salary ? num(salary.active['实发工资合计']) : 0,
    survivorCount: salary ? num(salary.survivor['人数']) || salary.survivorPeople.length : 0,
    survivorActualPay: salary ? num(salary.survivor['合计']) : 0,
    retiredHousingCount: retired.count,
    retiredHousingActualPay: retired.housing
  }
}

export function buildSalarySummaryFromIntegratedAggregates(
  active: IntegratedActiveAggregates,
  other: IntegratedSimpleAggregates
): SalarySummary {
  return {
    active: {
      人数: active.count,
      岗位工资: active.基本工资,
      薪级工资: 0,
      基本补发: 0,
      应发基础工资: active.基本工资,
      教龄津贴: active.教龄津贴,
      岗位津贴: active.基础性绩效,
      生活补贴: 0,
      绩效补发: 0,
      基础性绩效: active.基础性绩效,
      乡镇补贴: active.其他一,
      边远乡镇补贴: 0,
      住房补贴: active.住房补贴,
      交通补贴: active.交通补贴,
      应发工资合计: active.应发工资,
      养老保险: active.养老保险,
      职业年金: active.职业年金,
      医保大病统筹: active.医疗保险,
      失业保险: active.失业保险,
      住房公积金: active.公积金,
      个税: active.个税,
      扣款补发: 0,
      补扣工资: active.个税,
      五险一金: active.五险一金合计,
      实发工资合计: active.实发合计
    },
    survivor: {
      人数: other.count,
      遗属补助: other.住房补贴,
      补发数: other.补发工资,
      合计: other.应发工资小计
    },
    activePeople: [],
    survivorPeople: Array.from({ length: other.count }, (_, index) => ({
      idCard: '',
      name: '',
      account: '',
      rowNumber: index + 1,
      values: {}
    }))
  }
}

function buildBusinessSummaryMessages(summary: MonthlyPayrollBusinessSummary): string[] {
  return [
    `在职 ${summary.activeCount} 人，应发 ${formatMoney(summary.activePayableTotal)} 元，实发 ${formatMoney(summary.activeActualPay)} 元`,
    `遗补 ${summary.survivorCount} 人，实发 ${formatMoney(summary.survivorActualPay)} 元`,
    `退休房补 ${summary.retiredHousingCount} 人，实发 ${formatMoney(summary.retiredHousingActualPay)} 元`
  ]
}

export function appendBusinessSummaryMessages(
  messages: string[],
  summary: MonthlyPayrollBusinessSummary
): string[] {
  return [...messages, ...buildBusinessSummaryMessages(summary)]
}
