import type { RuleResult } from '../../shared/types'

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
