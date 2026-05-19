import type { RuleResult } from '../../../shared/types'
import { notImplementedRule } from '../ruleResult'

export async function onBudgetRetiredCreated(): Promise<RuleResult> {
  return notImplementedRule(
    '更新退休信息',
    '需要补充新增预算退休后的下游字段更新规则（待人工补充）'
  )
}

export async function updateRetiredPensionAndHousingSubsidy(): Promise<RuleResult> {
  return notImplementedRule(
    '更新预算养老金和房补',
    '需要补充退休养老金、新房补与预算退休的同步字段（待人工补充）'
  )
}
