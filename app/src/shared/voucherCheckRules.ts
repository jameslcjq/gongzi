export type VoucherCheckLevel = 'error' | 'warn'

export type VoucherCheckRequiredSubject = {
  code: string
  name?: string
  direction?: 'debit' | 'credit' | 'any'
}

export type VoucherKeywordEcoRule = {
  id: string
  type: 'keyword-eco'
  name: string
  enabled: boolean
  level: VoucherCheckLevel
  keywords: string[]
  expectedEcoCode: string
  expectedEcoName?: string
  suggestion?: string
}

export type VoucherKeywordSubjectSetRule = {
  id: string
  type: 'keyword-subject-set'
  name: string
  enabled: boolean
  level: VoucherCheckLevel
  keywords: string[]
  requiredSubjects: VoucherCheckRequiredSubject[]
  expectedBudgetExpenseSubjectCode?: string
  expectedBudgetRevenueSubjectCode?: string
  suggestion?: string
}

export type VoucherFixedAssetCapitalRule = {
  id: string
  type: 'fixed-asset-capital'
  name: string
  enabled: boolean
  level: VoucherCheckLevel
  fixedAssetPrefixes: string[]
  budgetExpensePrefixes: string[]
  allowedEcoCodes: string[]
  suggestion?: string
}

export type VoucherCheckRule =
  | VoucherKeywordEcoRule
  | VoucherKeywordSubjectSetRule
  | VoucherFixedAssetCapitalRule

export type VoucherCheckRuleLibrary = {
  schemaVersion: 1
  rules: VoucherCheckRule[]
  updatedAt?: string
}

export type VoucherCheckRuleFileResult =
  | { ok: true; filePath: string; library: VoucherCheckRuleLibrary }
  | { ok: false; canceled?: boolean; reason: string }

const CAPITAL_EXP_ECO_CODES = [
  '31001', '31002', '31003', '31005', '31006', '31007', '31008', '31009',
  '31010', '31011', '31012', '31013', '31019', '31021', '31022', '31099'
]

export function createDefaultVoucherCheckRuleLibrary(): VoucherCheckRuleLibrary {
  return {
    schemaVersion: 1,
    rules: [
      {
        id: 'R-BANZHUREN-30107',
        type: 'keyword-eco',
        name: '班主任经济分类',
        enabled: true,
        level: 'warn',
        keywords: ['班主任'],
        expectedEcoCode: '30107',
        expectedEcoName: '绩效工资',
        suggestion: '应修改为30107 绩效工资。'
      },
      {
        id: 'R-YANSHI-30107',
        type: 'keyword-eco',
        name: '延时课后服务费经济分类',
        enabled: true,
        level: 'warn',
        keywords: ['延时', '课后'],
        expectedEcoCode: '30107',
        expectedEcoName: '绩效工资',
        suggestion: '应修改为30107 绩效工资。'
      },
      {
        id: 'R-YANSHI-SUBJECTS',
        type: 'keyword-subject-set',
        name: '延时课后服务费科目组合',
        enabled: true,
        level: 'warn',
        keywords: ['延时', '课后'],
        requiredSubjects: [
          { code: '500101', name: '业务活动费用-工资福利费用', direction: 'debit' },
          { code: '4609', name: '其他收入', direction: 'credit' },
          { code: '7201010103', name: '事业支出-基本支出-人员经费-其他资金支出', direction: 'debit' },
          { code: '66090502', name: '其他预算收入-其他预算收入-非专项资金收入', direction: 'credit' }
        ],
        expectedBudgetExpenseSubjectCode: '7201010103',
        expectedBudgetRevenueSubjectCode: '66090502',
        suggestion: '应按图片中的四条分录科目调整。'
      },
      {
        id: 'R-FIXED-ASSET-310',
        type: 'fixed-asset-capital',
        name: '固定资产资本性支出',
        enabled: true,
        level: 'warn',
        fixedAssetPrefixes: ['160101', '160102', '160103', '160104', '160105', '160106'],
        budgetExpensePrefixes: ['720'],
        allowedEcoCodes: CAPITAL_EXP_ECO_CODES,
        suggestion: '应修改为310类资本性支出。'
      }
    ],
    updatedAt: new Date().toISOString()
  }
}

export function normalizeVoucherCheckRuleLibrary(input: unknown): VoucherCheckRuleLibrary {
  const fallback = createDefaultVoucherCheckRuleLibrary()
  if (!input || typeof input !== 'object') return fallback
  const source = input as Partial<VoucherCheckRuleLibrary>
  const rawRules = Array.isArray(source.rules) ? source.rules : []
  const rules = rawRules
    .map((rule, index) => normalizeVoucherCheckRule(rule, index))
    .filter((rule): rule is VoucherCheckRule => !!rule)
  return {
    schemaVersion: 1,
    rules: rules.length ? rules : fallback.rules,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString()
  }
}

function normalizeVoucherCheckRule(input: unknown, index: number): VoucherCheckRule | null {
  if (!input || typeof input !== 'object') return null
  const rule = input as Partial<VoucherCheckRule>
  const id = cleanText((rule as { id?: unknown }).id) || `R-${Date.now()}-${index}`
  const name = cleanText((rule as { name?: unknown }).name) || '未命名规则'
  const enabled = (rule as { enabled?: unknown }).enabled !== false
  const level: VoucherCheckLevel = (rule as { level?: unknown }).level === 'error' ? 'error' : 'warn'

  if (rule.type === 'keyword-eco') {
    return {
      id,
      type: 'keyword-eco',
      name,
      enabled,
      level,
      keywords: cleanList(rule.keywords),
      expectedEcoCode: cleanCode(rule.expectedEcoCode),
      expectedEcoName: cleanText(rule.expectedEcoName),
      suggestion: cleanText(rule.suggestion)
    }
  }

  if (rule.type === 'keyword-subject-set') {
    return {
      id,
      type: 'keyword-subject-set',
      name,
      enabled,
      level,
      keywords: cleanList(rule.keywords),
      requiredSubjects: cleanRequiredSubjects(rule.requiredSubjects),
      expectedBudgetExpenseSubjectCode: cleanCode(rule.expectedBudgetExpenseSubjectCode),
      expectedBudgetRevenueSubjectCode: cleanCode(rule.expectedBudgetRevenueSubjectCode),
      suggestion: cleanText(rule.suggestion)
    }
  }

  if (rule.type === 'fixed-asset-capital') {
    return {
      id,
      type: 'fixed-asset-capital',
      name,
      enabled,
      level,
      fixedAssetPrefixes: cleanList(rule.fixedAssetPrefixes).map(cleanCode).filter(Boolean),
      budgetExpensePrefixes: cleanList(rule.budgetExpensePrefixes).map(cleanCode).filter(Boolean),
      allowedEcoCodes: cleanList(rule.allowedEcoCodes).map(cleanCode).filter(Boolean),
      suggestion: cleanText(rule.suggestion)
    }
  }

  return null
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function cleanCode(value: unknown): string {
  return String(value ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase()
}

function cleanList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,\n，、;；]/)
  return Array.from(new Set(raw.map((item) => cleanText(item)).filter(Boolean)))
}

function cleanRequiredSubjects(value: unknown): VoucherCheckRequiredSubject[] {
  if (!Array.isArray(value)) return []
  const subjects: Array<VoucherCheckRequiredSubject | null> = value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const source = item as Partial<VoucherCheckRequiredSubject>
      const code = cleanCode(source.code)
      if (!code) return null
      const direction = source.direction === 'debit' || source.direction === 'credit' ? source.direction : 'any'
      return { code, name: cleanText(source.name), direction }
    })
  return subjects.filter((item): item is VoucherCheckRequiredSubject => !!item)
}
