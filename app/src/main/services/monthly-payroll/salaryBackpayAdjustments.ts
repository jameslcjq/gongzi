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
  const taxAmount = roundMoney(num(person.values['当月个人所得税']))

  return {
    increaseTotal: roundMoney(
      Math.max(basicBackpay, 0) +
        Math.max(performanceBackpay, 0)
    ),
    deductionTotal: roundMoney(
      Math.max(-basicBackpay, 0) +
        Math.max(-performanceBackpay, 0) +
        taxAmount
    )
  }
}
