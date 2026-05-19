import type { RuleResult } from '../../shared/types'

export function notImplementedRule(name: string, hint?: string): RuleResult {
  return {
    ok: false,
    affectedRows: 0,
    messages: [],
    warnings: [hint ? `${name}：${hint}` : `${name} 需要补充字段映射和业务规则后启用`]
  }
}

export function blockedBySourceRule(name: string, reason: string): RuleResult {
  return {
    ok: false,
    affectedRows: 0,
    messages: [],
    warnings: [`${name} 暂未开放：${reason}`]
  }
}

export function okRule(
  name: string,
  affectedRows: number,
  extraMessages: string[] = [],
  warnings: string[] = []
): RuleResult {
  return {
    ok: true,
    affectedRows,
    messages: [`${name} 执行完成，影响 ${affectedRows} 行`, ...extraMessages],
    warnings
  }
}

export function failRule(name: string, error: unknown): RuleResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    affectedRows: 0,
    messages: [],
    warnings: [`${name} 执行失败：${message}`]
  }
}
