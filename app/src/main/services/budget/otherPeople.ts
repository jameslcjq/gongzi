import type { RuleResult } from '../../../shared/types'
import { notImplementedRule } from '../ruleResult'

export async function verifyOtherPeople(): Promise<RuleResult> {
  return notImplementedRule(
    '核对预算其他',
    '需要补充预算其他与一体化其他的核对字段映射（待人工补充）'
  )
}
