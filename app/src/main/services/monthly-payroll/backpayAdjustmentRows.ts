import { num, roundMoney } from './monthlyPayrollUtils'

export const backpayAdjustmentChannels = {
  basicIncrease: { index: 5, label: '岗位工资' },
  performanceIncrease: { index: 6, label: '薪级工资' },
  basicDeduction: { index: 7, label: '岗位津贴' },
  performanceDeduction: { index: 8, label: '生活补贴' },
  taxDeduction: { index: 9, label: '绩效工资' },
  retiredBackpay: { index: 17, label: '补发工资' },
  retiredDeduction: { index: 18, label: '补扣工资' }
} as const

export type BackpayAdjustmentChannel = keyof typeof backpayAdjustmentChannels

export function createBackpayAdjustmentRow(
  idCard: string,
  name: string,
  year: number,
  month: number,
  salaryType = '事业'
): Array<string | number> {
  const row: Array<string | number> = Array.from({ length: 24 }, () => '')
  row[0] = idCard
  row[1] = month
  row[2] = name
  row[3] = salaryType
  row[4] = year
  return row
}

export function addBackpayAdjustment(
  row: Array<string | number>,
  channel: BackpayAdjustmentChannel,
  amount: number
): void {
  const rounded = roundMoney(amount)
  if (rounded === 0) return
  const index = backpayAdjustmentChannels[channel].index
  row[index] = roundMoney(num(row[index]) + rounded)
}

export function addSignedBackpayAdjustment(
  row: Array<string | number>,
  amount: number,
  increaseChannel: BackpayAdjustmentChannel,
  deductionChannel: BackpayAdjustmentChannel
): void {
  const rounded = roundMoney(amount)
  if (rounded > 0) {
    addBackpayAdjustment(row, increaseChannel, rounded)
  } else if (rounded < 0) {
    addBackpayAdjustment(row, deductionChannel, rounded)
  }
}

export function hasBackpayAdjustments(row: Array<string | number>): boolean {
  return Object.values(backpayAdjustmentChannels).some((channel) => num(row[channel.index]) !== 0)
}
