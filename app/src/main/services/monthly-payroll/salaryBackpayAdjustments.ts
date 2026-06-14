import type { PayrollPerson } from './monthlyPayrollTypes'
import { num, roundMoney } from './monthlyPayrollUtils'

export type ActiveBackpayAdjustmentTotals = {
  increaseTotal: number
  deductionTotal: number
}

export function activeBackpayAdjustmentTotals(
  person: PayrollPerson
): ActiveBackpayAdjustmentTotals {
  const basicBackpay = roundMoney(num(person.values['基本补发']))
  const performanceBackpay = roundMoney(num(person.values['绩效补发']))

  // 补扣只算补发负数；当月个税以个税文件为权威，统一在重算时叠加进补扣工资
  // （见 applyTaxAndRecomputeIntegratedActive：补扣工资 = 补发负数 + 个税文件值）
  return {
    increaseTotal: roundMoney(Math.max(basicBackpay, 0) + Math.max(performanceBackpay, 0)),
    deductionTotal: roundMoney(Math.max(-basicBackpay, 0) + Math.max(-performanceBackpay, 0))
  }
}
