import type {
  MonthlyPayrollDataSourceMode,
  MonthlyPayrollReconciliationCheck,
  MonthlyPayrollReconciliationIssue,
  MonthlyPayrollReconciliationResult,
  MonthlyPayrollReportSheet
} from '../../../shared/types'
import { loadIntegratedRows } from './integratedPayroll'
import {
  loadIntegratedActiveAggregates,
  loadIntegratedSimpleAggregates
} from './monthlyPayrollDataLoaders'
import type {
  IntegratedActiveAggregates,
  IntegratedSimpleAggregates,
  SalarySummary,
  SocialSecuritySummary,
  TaxSummary
} from './monthlyPayrollTypes'
import { reconcileActiveBackpayPeople } from './monthlyPayrollReconciliationCore'
import { formatMoney, num, roundMoney, text } from './monthlyPayrollUtils'

type ReconcileInput = {
  salary?: SalarySummary
  socialSecurity?: SocialSecuritySummary
  tax?: TaxSummary
  dataSourceMode: MonthlyPayrollDataSourceMode
  allowIdentityFallback?: boolean
  sheets: MonthlyPayrollReportSheet[]
  integratedActiveAggregates?: IntegratedActiveAggregates
  integratedRetiredAggregates?: IntegratedSimpleAggregates
  integratedOtherAggregates?: IntegratedSimpleAggregates
}

type CheckResult = Omit<MonthlyPayrollReconciliationCheck, 'issueCount' | 'status'>

const MONEY_TOLERANCE = 0.01

export async function reconcileMonthlyPayrollReport(
  input: ReconcileInput
): Promise<MonthlyPayrollReconciliationResult> {
  const [
    activeRows,
    activeAggregates,
    retiredAggregates,
    otherAggregates
  ] = await Promise.all([
    loadIntegratedRows('在职工资').catch(() => []),
    Promise.resolve(input.integratedActiveAggregates ?? loadIntegratedActiveAggregates()),
    Promise.resolve(input.integratedRetiredAggregates ?? loadIntegratedSimpleAggregates('退休工资')),
    Promise.resolve(input.integratedOtherAggregates ?? loadIntegratedSimpleAggregates('其他工资'))
  ])

  const issues: MonthlyPayrollReconciliationIssue[] = []
  const checks: MonthlyPayrollReconciliationCheck[] = []
  const pushCheck = (
    check: CheckResult,
    checkIssues: MonthlyPayrollReconciliationIssue[] = []
  ): void => {
    issues.push(...checkIssues)
    const hasError = checkIssues.some((issue) => issue.severity === 'error')
    const hasWarning = checkIssues.some((issue) => issue.severity === 'warning')
    checks.push({
      ...check,
      issueCount: checkIssues.length,
      status: hasError ? 'failed' : hasWarning ? 'warning' : check.checkedCount > 0 ? 'passed' : 'not_run'
    })
  }

  const backpay = reconcileActiveBackpayPeople({
    salary: input.salary,
    dataSourceMode: input.dataSourceMode,
    allowIdentityFallback: input.allowIdentityFallback,
    sheets: input.sheets,
    activeRows
  })
  pushCheck(backpay.check, backpay.issues)

  const activeTotal = reconcileActiveActualPay(input.salary, activeAggregates)
  pushCheck(activeTotal.check, activeTotal.issues)

  const voucherTotal = reconcileSalaryVoucherActualPay(
    input,
    activeAggregates,
    retiredAggregates,
    otherAggregates
  )
  pushCheck(voucherTotal.check, voucherTotal.issues)

  const taxTotal = reconcileBackpayTaxTotal(input.tax, input.sheets)
  pushCheck(taxTotal.check, taxTotal.issues)

  const socialTotal = reconcileInsuranceVoucherTotal(
    input.socialSecurity,
    input.tax,
    input.sheets,
    activeAggregates
  )
  pushCheck(socialTotal.check, socialTotal.issues)

  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const status = errorCount > 0 ? 'failed' : warningCount > 0 ? 'warning' : 'passed'
  return {
    status,
    generatedAt: new Date().toISOString(),
    summary: status === 'passed'
      ? `自动复核通过：${checks.filter((check) => check.status === 'passed').length} 项关卡已通过`
      : `自动复核未通过：发现 ${errorCount} 项错误、${warningCount} 项提醒`,
    checks,
    issues
  }
}

function reconcileActiveActualPay(
  salary: SalarySummary | undefined,
  activeAggregates: IntegratedActiveAggregates
): { check: CheckResult; issues: MonthlyPayrollReconciliationIssue[] } {
  const checkName = '在职实发总额核对'
  const checkKey = 'active-actual-pay-total'
  const issues: MonthlyPayrollReconciliationIssue[] = []
  if (!salary) {
    return {
      check: {
        key: checkKey,
        name: checkName,
        checkedCount: 0,
        summary: '一体化模式无工资表源，跳过工资表在职实发总额核对'
      },
      issues
    }
  }
  pushDifferenceIssue(issues, {
    checkKey,
    checkName,
    category: '实发合计',
    fieldName: '在职实发合计',
    sourceValue: roundMoney(num(salary.active['实发工资合计'])),
    databaseValue: roundMoney(activeAggregates.实发合计)
  })
  return {
    check: {
      key: checkKey,
      name: checkName,
      checkedCount: 1,
      summary: '已核对工资表在职实发合计与本地在职工资表实发合计'
    },
    issues
  }
}

function reconcileSalaryVoucherActualPay(
  input: ReconcileInput,
  activeAggregates: IntegratedActiveAggregates,
  retiredAggregates: IntegratedSimpleAggregates,
  otherAggregates: IntegratedSimpleAggregates
): { check: CheckResult; issues: MonthlyPayrollReconciliationIssue[] } {
  const checkName = '工资报销凭证实付核对'
  const checkKey = 'salary-voucher-actual-pay'
  const issues: MonthlyPayrollReconciliationIssue[] = []
  const row = findVoucherPrintRow(input.sheets, 'C1')
  if (!row) {
    return {
      check: {
        key: checkKey,
        name: checkName,
        checkedCount: 0,
        summary: '未生成工资报销凭证行，跳过工资凭证实付核对'
      },
      issues
    }
  }
  const reportValue = roundMoney(num(row[4]))
  const dbValue = roundMoney(
    activeAggregates.实发合计 +
      retiredAggregates.实发合计 +
      otherAggregates.实发合计
  )
  pushDifferenceIssue(issues, {
    checkKey,
    checkName,
    category: '报销凭证',
    fieldName: 'C1工资遗补房补-实际付款金额',
    databaseValue: dbValue,
    reportValue
  })
  if (input.salary) {
    const sourceValue = roundMoney(
      num(input.salary.active['实发工资合计']) +
        num(input.salary.survivor['合计']) +
        retiredAggregates.实发合计
    )
    pushDifferenceIssue(issues, {
      checkKey,
      checkName,
      category: '报销凭证',
      fieldName: 'C1工资遗补房补-工资表源',
      sourceValue,
      reportValue
    })
  }
  return {
    check: {
      key: checkKey,
      name: checkName,
      checkedCount: 1,
      summary: '已核对报销凭证 C1 实际付款金额与工资数据汇总'
    },
    issues
  }
}

function reconcileBackpayTaxTotal(
  tax: TaxSummary | undefined,
  sheets: MonthlyPayrollReportSheet[]
): { check: CheckResult; issues: MonthlyPayrollReconciliationIssue[] } {
  const checkName = '补发工资个税核对'
  const checkKey = 'backpay-tax-total'
  const issues: MonthlyPayrollReconciliationIssue[] = []
  if (!tax) {
    return {
      check: {
        key: checkKey,
        name: checkName,
        checkedCount: 0,
        summary: '未提供个税文件，跳过补发工资个税核对'
      },
      issues
    }
  }
  const reportTax = roundMoney(
    (findSheet(sheets, '补发工资')?.rows ?? [])
      .reduce((sum, row) => sum + Math.max(-num(row[9]), 0), 0)
  )
  pushDifferenceIssue(issues, {
    checkKey,
    checkName,
    category: '个税',
    fieldName: '补发工资明细个税扣款',
    sourceValue: roundMoney(tax.totalTax),
    reportValue: reportTax
  })
  return {
    check: {
      key: checkKey,
      name: checkName,
      checkedCount: tax.rows.length,
      summary: `已核对 ${tax.rows.length} 条个税记录与补发工资明细个税扣款合计`
    },
    issues
  }
}

function reconcileInsuranceVoucherTotal(
  socialSecurity: SocialSecuritySummary | undefined,
  tax: TaxSummary | undefined,
  sheets: MonthlyPayrollReportSheet[],
  activeAggregates: IntegratedActiveAggregates
): { check: CheckResult; issues: MonthlyPayrollReconciliationIssue[] } {
  const checkName = '保险凭证金额核对'
  const checkKey = 'insurance-voucher-total'
  const issues: MonthlyPayrollReconciliationIssue[] = []
  if (!socialSecurity) {
    return {
      check: {
        key: checkKey,
        name: checkName,
        checkedCount: 0,
        summary: '未提供社保文件，跳过保险凭证金额核对'
      },
      issues
    }
  }
  const row = findVoucherPrintRow(sheets, '五险一金')
  if (!row) {
    return {
      check: {
        key: checkKey,
        name: checkName,
        checkedCount: 0,
        summary: '未生成五险一金报销凭证行，跳过保险凭证金额核对'
      },
      issues
    }
  }
  const sourceValue = roundMoney(
    Object.values(socialSecurity.byItem).reduce((sum, amount) => sum + amount, 0) +
      (tax?.totalTax ?? 0) +
      activeAggregates.公积金 * 2
  )
  pushDifferenceIssue(issues, {
    checkKey,
    checkName,
    category: '报销凭证',
    fieldName: '五险一金-实际付款金额',
    sourceValue,
    reportValue: roundMoney(num(row[4]))
  })
  return {
    check: {
      key: checkKey,
      name: checkName,
      checkedCount: socialSecurity.rowCount,
      summary: `已核对 ${socialSecurity.rowCount} 条社保记录与五险一金凭证金额`
    },
    issues
  }
}

function findSheet(
  sheets: MonthlyPayrollReportSheet[],
  name: string
): MonthlyPayrollReportSheet | undefined {
  return sheets.find((sheet) => sheet.name === name)
}

function findVoucherPrintRow(
  sheets: MonthlyPayrollReportSheet[],
  keyword: string
): Array<string | number> | undefined {
  return (findSheet(sheets, '报销凭证')?.rows ?? [])
    .find((row) => text(row[0]).includes(keyword))
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
