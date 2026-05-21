import type { AnnualReportWorkflowInput, RuleResult, WorkflowRunPayload } from '../../../shared/types'
import { failRule, notImplementedRule, okRule } from '../ruleResult'
import { generateAnnualReportFromIntegrated } from './generateFromIntegrated'

export async function generateAnnualSalaryReport(payload?: WorkflowRunPayload): Promise<RuleResult> {
  try {
    const input = payload?.annualReport
    if (!input) {
      throw new Error('缺少年报生成参数，请填写模板、上年表、2025 空表和三项金额')
    }

    const result = await generateAnnualReportFromIntegrated(normalizeAnnualReportInput(input))
    return okRule('生成工资年报', result.staffCount, [
      `奖励性绩效及班主任费合计：${result.totalPerformance}`,
      `延时费合计：${result.totalOvertime}`
    ], result.warnings)
  } catch (error) {
    return failRule('生成工资年报', error)
  }
}

function normalizeAnnualReportInput(input: AnnualReportWorkflowInput): AnnualReportWorkflowInput {
  return {
    totalPerformance: Number(input.totalPerformance) || 0,
    totalHeadTeacher: Number(input.totalHeadTeacher) || 0,
    totalOvertime: Number(input.totalOvertime) || 0
  }
}

export async function updateAnnualReportPerformanceSalary(): Promise<RuleResult> {
  return notImplementedRule(
    '更新绩效工资',
    '需要补充身份证 → 绩效工资的同步规则（待人工补充）'
  )
}

export async function updateTownshipYearsForAnnualReport(): Promise<RuleResult> {
  return notImplementedRule(
    '改乡镇工作年限',
    '需要补充工资年报和乡镇补贴的乡镇工作年限同步规则（待人工补充）'
  )
}
