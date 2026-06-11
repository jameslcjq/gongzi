import type { SalaryQuotaMatchLocalSummary } from '../../../shared/types'
import {
  loadActiveActualPayTotalsByBatch,
  loadIntegratedActiveAggregates,
  loadIntegratedSimpleAggregates,
  loadTraffic002Total
} from './monthlyPayrollDataLoaders'
import { listMonthlyPayrollRuns } from './monthlyPayrollRuns'

const EMPTY_SUMMARY: SalaryQuotaMatchLocalSummary = {
  ok: false,
  activeOtherOneTotal: 0,
  activeBasicPerformanceTotal: 0,
  activeHousingTotal: 0,
  activeAllowanceTotal: 0,
  retiredHousingTotal: 0,
  retiredBackpayTotal: 0,
  retiredActualPayTotal: 0,
  otherActualPayTotal: 0,
  actualPayTotal: 0,
  traffic002Total: 0
}

/**
 * 计算额度匹配所需的本地工资汇总。
 *
 * 数据来源是本机明细表（在职/退休/其他工资 + 002 交通费）与当月最新报账记录，
 * 因此只能在持有这些明细的外网主程序上算。供两处复用：
 *   - IPC `salary-quota-match:local-summary`（完整模式注入额度匹配脚本时取）。
 *   - 生成内网交换包时算好打包带给内网执行端（内网无明细表，无法现算）。
 */
export async function computeSalaryQuotaMatchLocalSummary(): Promise<SalaryQuotaMatchLocalSummary> {
  try {
    const now = new Date()
    const [active, retired, other, traffic002Total, runs, activeBatchActualPayTotals] =
      await Promise.all([
        loadIntegratedActiveAggregates({ batchCode: '001' }),
        loadIntegratedSimpleAggregates('退休工资'),
        loadIntegratedSimpleAggregates('其他工资'),
        loadTraffic002Total(),
        listMonthlyPayrollRuns(),
        loadActiveActualPayTotalsByBatch()
      ])
    // 实发合计 = 在职实发 + 遗补实发 + 退休房补实发，取当月最新且未过期的报账记录（与历史报表口径一致）。
    const currentRun = runs.find(
      (run) => run.year === now.getFullYear() && run.month === now.getMonth() + 1 && !run.isOutdated
    )
    const actualPayTotal = currentRun
      ? Math.round(
          (currentRun.activeActualPay + currentRun.survivorActualPay + currentRun.retiredHousingActualPay) * 100
        ) / 100
      : 0
    return {
      ok: true,
      activeOtherOneTotal: active.其他一,
      activeBasicPerformanceTotal: active.基础性绩效,
      activeHousingTotal: active.住房补贴,
      activeAllowanceTotal: active.教龄津贴,
      retiredHousingTotal: retired.住房补贴,
      retiredBackpayTotal: retired.补发工资,
      retiredActualPayTotal: retired.实发合计,
      otherActualPayTotal: other.实发合计,
      actualPayTotal,
      traffic002Total,
      activeBatchActualPayTotals
    }
  } catch (error) {
    return {
      ...EMPTY_SUMMARY,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
