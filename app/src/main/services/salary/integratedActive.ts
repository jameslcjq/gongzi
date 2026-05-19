import type { RuleResult } from '../../../shared/types'
import { blockedBySourceRule, notImplementedRule } from '../ruleResult'

export async function syncIntegratedActiveSalary(): Promise<RuleResult> {
  return blockedBySourceRule(
    '更新工资信息',
    '原流程依赖已删除的"局工资表"，请先确认新的取数来源后再启用'
  )
}

export async function verifyBudgetActiveEmployee(): Promise<RuleResult> {
  return notImplementedRule(
    '核对预算人员',
    '需要补充一体化在职与预算在职的核对字段映射（待人工补充）'
  )
}
