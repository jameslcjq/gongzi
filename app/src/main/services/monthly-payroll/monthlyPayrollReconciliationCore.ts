import type {
  MonthlyPayrollDataSourceMode,
  MonthlyPayrollReconciliationIssue,
  MonthlyPayrollReportSheet
} from '../../../shared/types'
import type { SalarySummary } from './monthlyPayrollTypes'
import { activeBackpayAdjustmentTotals } from './salaryBackpayAdjustments'
import { formatMoney, normalizeIdCard, num, roundMoney, text } from './monthlyPayrollUtils'

export type ActiveBackpayRow = {
  idCard: string
  name: string
  values: Record<string, string | number>
}

export type ActiveBackpayCheckResult = {
  check: {
    key: string
    name: string
    checkedCount: number
    summary: string
  }
  issues: MonthlyPayrollReconciliationIssue[]
}

const MONEY_TOLERANCE = 0.01

export function reconcileActiveBackpayPeople(input: {
  salary?: SalarySummary
  dataSourceMode: MonthlyPayrollDataSourceMode
  allowIdentityFallback?: boolean
  sheets: MonthlyPayrollReportSheet[]
  activeRows: ActiveBackpayRow[]
}): ActiveBackpayCheckResult {
  const checkName = '按人核对在职补发补扣'
  const checkKey = 'active-person-backpay'
  const issues: MonthlyPayrollReconciliationIssue[] = []
  const activeById = new Map(input.activeRows.map((row) => [normalizeIdCard(row.idCard), row]))
  const activeByName = buildActiveRowsByName(input.activeRows)
  const reportById = indexBackpaySheetRows(input.sheets)

  if (!input.salary) {
    const checkedCount = input.dataSourceMode === 'integrated' ? reportById.size : 0
    for (const [idCard, reportRow] of reportById.entries()) {
      const dbRow = activeById.get(idCard)
      if (!dbRow) continue
      const reportTotals = backpayReportTotals(reportRow)
      const dbIncrease = roundMoney(num(dbRow.values['补发工资']))
      const dbDeduction = roundMoney(num(dbRow.values['补扣工资']))
      pushDifferenceIssue(issues, {
        checkKey,
        checkName,
        category: '补发补扣',
        name: text(dbRow.name || reportRow[2]),
        idCard,
        fieldName: '补发工资',
        databaseValue: dbIncrease,
        reportValue: reportTotals.increaseTotal
      })
      pushDifferenceIssue(issues, {
        checkKey,
        checkName,
        category: '补发补扣',
        name: text(dbRow.name || reportRow[2]),
        idCard,
        fieldName: '补扣工资',
        databaseValue: dbDeduction,
        reportValue: reportTotals.deductionTotal
      })
    }
    return {
      check: {
        key: checkKey,
        name: checkName,
        checkedCount,
        summary: checkedCount > 0
          ? `一体化模式已核对 ${checkedCount} 条补发工资明细与本地在职工资表`
          : '一体化模式无工资表源，跳过工资表逐人源值核对'
      },
      issues
    }
  }

  let checkedCount = 0
  for (const person of input.salary.activePeople) {
    const idCard = normalizeIdCard(person.idCard)
    const source = activeBackpayAdjustmentTotals(person)
    if (!idCard || (source.increaseTotal === 0 && source.deductionTotal === 0)) continue
    checkedCount += 1
    const dbRow = activeById.get(idCard) ??
      (input.allowIdentityFallback ? uniqueActiveRowByName(activeByName, person.name) : undefined)
    const reportRow = reportById.get(idCard)
    const reportTotals = reportRow ? backpayReportTotals(reportRow) : { increaseTotal: 0, deductionTotal: 0 }
    if (!dbRow) {
      issues.push({
        severity: 'error',
        checkKey,
        checkName,
        category: '补发补扣',
        name: person.name,
        idCard,
        message: `${person.name} 的工资表有补发/补扣，但本地在职工资表找不到该人员，不能推送。`,
        suggestion: '请先导入或修正本地在职工资数据。'
      })
    }
    pushDifferenceIssue(issues, {
      checkKey,
      checkName,
      category: '补发补扣',
      name: person.name,
      idCard,
      fieldName: '补发工资',
      sourceValue: source.increaseTotal,
      databaseValue: dbRow ? roundMoney(num(dbRow.values['补发工资'])) : 0
    })
    pushDifferenceIssue(issues, {
      checkKey,
      checkName,
      category: '补发补扣',
      name: person.name,
      idCard,
      fieldName: '补扣工资',
      sourceValue: source.deductionTotal,
      databaseValue: dbRow ? roundMoney(num(dbRow.values['补扣工资'])) : 0
    })
    pushDifferenceIssue(issues, {
      checkKey,
      checkName,
      category: '补发补扣',
      name: person.name,
      idCard,
      fieldName: '补发工资明细-补发',
      sourceValue: source.increaseTotal,
      reportValue: reportTotals.increaseTotal
    })
    pushDifferenceIssue(issues, {
      checkKey,
      checkName,
      category: '补发补扣',
      name: person.name,
      idCard,
      fieldName: '补发工资明细-补扣',
      sourceValue: source.deductionTotal,
      reportValue: reportTotals.deductionTotal
    })
  }

  return {
    check: {
      key: checkKey,
      name: checkName,
      checkedCount,
      summary: checkedCount > 0
        ? `已逐人核对 ${checkedCount} 条工资表补发补扣、在职工资表和补发工资明细`
        : '工资表未发现本月补发补扣人员'
    },
    issues
  }
}

function indexBackpaySheetRows(
  sheets: MonthlyPayrollReportSheet[]
): Map<string, Array<string | number>> {
  const result = new Map<string, Array<string | number>>()
  for (const row of sheets.find((sheet) => sheet.name === '补发工资')?.rows ?? []) {
    const idCard = normalizeIdCard(row[0])
    if (!idCard) continue
    result.set(idCard, row)
  }
  return result
}

function buildActiveRowsByName(rows: ActiveBackpayRow[]): Map<string, ActiveBackpayRow[]> {
  const result = new Map<string, ActiveBackpayRow[]>()
  for (const row of rows) {
    const name = normalizePersonName(row.name)
    if (!name) continue
    const grouped = result.get(name) ?? []
    grouped.push(row)
    result.set(name, grouped)
  }
  return result
}

function uniqueActiveRowByName(
  rowsByName: Map<string, ActiveBackpayRow[]>,
  name: string
): ActiveBackpayRow | undefined {
  const rows = rowsByName.get(normalizePersonName(name)) ?? []
  return rows.length === 1 ? rows[0] : undefined
}

function normalizePersonName(value: unknown): string {
  return text(value).replace(/\s+/g, '')
}

function backpayReportTotals(row: Array<string | number>): { increaseTotal: number; deductionTotal: number } {
  return {
    increaseTotal: roundMoney(num(row[5]) + num(row[6])),
    deductionTotal: roundMoney(Math.max(-num(row[7]), 0) + Math.max(-num(row[8]), 0) + Math.max(-num(row[9]), 0))
  }
}

function pushDifferenceIssue(
  issues: MonthlyPayrollReconciliationIssue[],
  input: {
    checkKey: string
    checkName: string
    category: string
    fieldName: string
    name?: string
    idCard?: string
    sourceValue?: number
    databaseValue?: number
    reportValue?: number
  }
): void {
  const values = [
    input.sourceValue,
    input.databaseValue,
    input.reportValue
  ].filter((value): value is number => typeof value === 'number')
  if (values.length < 2) return
  const reference = roundMoney(values[0])
  const differentValue = values.find((value) => moneyDiff(reference, value))
  if (differentValue === undefined) return
  const compared = [
    typeof input.sourceValue === 'number' ? `源表 ${formatMoney(input.sourceValue)}` : '',
    typeof input.databaseValue === 'number' ? `本地库 ${formatMoney(input.databaseValue)}` : '',
    typeof input.reportValue === 'number' ? `报表 ${formatMoney(input.reportValue)}` : ''
  ].filter(Boolean).join('，')
  const difference = roundMoney(reference - differentValue)
  const who = input.name ? `${input.name} ` : ''
  issues.push({
    severity: 'error',
    checkKey: input.checkKey,
    checkName: input.checkName,
    category: input.category,
    message: `${who}${input.fieldName} 金额不一致：${compared}，差额 ${formatMoney(difference)}`,
    name: input.name,
    idCard: input.idCard,
    fieldName: input.fieldName,
    sourceValue: input.sourceValue,
    databaseValue: input.databaseValue,
    reportValue: input.reportValue,
    difference,
    suggestion: '请先修正源表或本地工资数据，再重新生成报表。'
  })
}

function moneyDiff(left: number, right: number): boolean {
  return Math.abs(roundMoney(left) - roundMoney(right)) >= MONEY_TOLERANCE
}
