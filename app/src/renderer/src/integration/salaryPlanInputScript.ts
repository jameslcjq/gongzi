import salaryPlanInputScript from './salaryPlanInput.user.js?raw'
import type { PersonnelExpensePlanPrefillResult } from '@shared/types'

type SalaryPlanInputScriptOptions = {
  showPageButton?: boolean
  prefill?: PersonnelExpensePlanPrefillResult
}

export function buildSalaryPlanInputScript(
  options: SalaryPlanInputScriptOptions = {}
): string {
  const showPageButton = options.showPageButton ?? true
  const prefillJson = JSON.stringify(options.prefill ?? { ok: false, rows: [] })
  return `
window.__SALARY_PLAN_INPUT_SHOW_PAGE_BUTTON = ${showPageButton ? 'true' : 'false'};
window.__SALARY_PLAN_INPUT_PREFILL = ${prefillJson};
${salaryPlanInputScript}
`
}
