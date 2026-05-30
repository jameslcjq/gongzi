import { roundMoney } from './monthlyPayrollUtils'

type SocialSecurityItemSummary = {
  byItem: Record<string, number>
}

export function sumSocialByKeyword(
  socialSecurity: SocialSecurityItemSummary,
  keywordGroups: string[]
): number {
  const keywords = keywordGroups.map((item) => item.replace(/\s+/g, ''))
  return roundMoney(
    Object.entries(socialSecurity.byItem).reduce((sum, [item, amount]) => {
      const normalized = item.replace(/\s+/g, '')
      if (keywords.every((keyword) => normalized.includes(keyword))) return sum + amount
      return sum
    }, 0)
  )
}

export function sumSocialByCanonicalName(
  socialSecurity: SocialSecurityItemSummary,
  canonicalName: string
): number {
  return roundMoney(
    Object.entries(socialSecurity.byItem).reduce((sum, [item, amount]) => {
      return canonicalInsuranceItemName(item) === canonicalName ? sum + amount : sum
    }, 0)
  )
}

export function canonicalInsuranceItemName(item: string): string {
  const normalized = item.replace(/\s+/g, '')
  const candidates: Array<[string[], string]> = [
    [['养老', '个人'], '养老保险个人'],
    [['养老', '单位'], '养老保险单位'],
    [['职业年金', '个人'], '职业年金个人'],
    [['职业年金', '单位'], '职业年金单位'],
    [['生育'], '生育保险'],
    [['医疗', '个人'], '医保个人'],
    [['医保', '个人'], '医保个人'],
    [['医疗', '单位'], '医保单位'],
    [['医保', '单位'], '医保单位'],
    [['失业', '个人'], '失业保险个人'],
    [['失业', '单位'], '失业保险单位'],
    [['工伤'], '工伤保险'],
    [['公积金', '个人'], '住房公积金个人'],
    [['公积金', '单位'], '住房公积金单位'],
    [['个人所得税'], '个人所得税'],
    [['个税'], '个人所得税']
  ]
  return candidates.find(([keywords]) => keywords.every((keyword) => normalized.includes(keyword)))?.[1] ?? item
}
