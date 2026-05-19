import type { RuleResult } from '../../../shared/types'
import { notImplementedRule } from '../ruleResult'

export async function updatePerformanceSalaryIdCard(): Promise<RuleResult> {
  return notImplementedRule(
    '更新身份证',
    '需要补充姓名 → 身份证号的反查规则（待人工补充）'
  )
}
