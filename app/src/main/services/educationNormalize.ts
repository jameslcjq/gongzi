type EducationGroup =
  | '博士后'
  | '博士'
  | '硕士'
  | '研究生'
  | '大学本科'
  | '大学肄业'
  | '大学专科'
  | '专科肄业'
  | '中专'
  | '高中'
  | '初中'
  | '小学'
  | '文盲或半文盲'
  | '其他'

const annualEducationByGroup: Record<EducationGroup, string> = {
  博士后: '博士研究生',
  博士: '博士研究生',
  硕士: '硕士研究生',
  研究生: '未获硕士学位的研究生',
  大学本科: '大学本科',
  大学肄业: '大学本科',
  大学专科: '大学专科',
  专科肄业: '大学专科',
  中专: '中专',
  高中: '高中',
  初中: '初中',
  小学: '小学',
  文盲或半文盲: '其他',
  其他: '其他'
}

const budgetEducationByGroup: Record<EducationGroup, string> = {
  博士后: '博士后',
  博士: '博士',
  硕士: '硕士',
  研究生: '研究生',
  大学本科: '大学本科',
  大学肄业: '大学肄业',
  大学专科: '专科毕业',
  专科肄业: '专科肄业',
  中专: '中专毕业',
  高中: '高中',
  初中: '初中',
  小学: '小学',
  文盲或半文盲: '文盲或半文盲',
  其他: '其他'
}

const educationGroupByValue = new Map<string, EducationGroup>(
  [
    ['博士后', '博士后'],
    ['博士', '博士'],
    ['博士研究生', '博士'],
    ['硕士', '硕士'],
    ['硕士研究生', '硕士'],
    ['研究生', '研究生'],
    ['未获硕士学位的研究生', '研究生'],
    ['研究生班毕业', '研究生'],
    ['大学本科', '大学本科'],
    ['双学士学位大学本科', '大学本科'],
    ['学制为六年以上的大学本科', '大学本科'],
    ['大学毕业', '大学本科'],
    ['相当大学毕业', '大学本科'],
    ['本科', '大学本科'],
    ['本科毕业', '大学本科'],
    ['大学本科毕业', '大学本科'],
    ['大本', '大学本科'],
    ['国民教育大学本科', '大学本科'],
    ['全日制大学本科', '大学本科'],
    ['全日制本科', '大学本科'],
    ['大学肄业', '大学肄业'],
    ['大学专科和专科学校', '大学专科'],
    ['大学专科', '大学专科'],
    ['专科毕业', '大学专科'],
    ['相当专科毕业', '大学专科'],
    ['专科', '大学专科'],
    ['大专', '大学专科'],
    ['大专毕业', '大学专科'],
    ['全日制大专', '大学专科'],
    ['全日制专科', '大学专科'],
    ['专科肄业', '专科肄业'],
    ['中等专业学校和中等技术学校', '中专'],
    ['中师', '中专'],
    ['中师毕业', '中专'],
    ['中专毕业', '中专'],
    ['中专', '中专'],
    ['中技毕业', '中专'],
    ['中技', '中专'],
    ['相当中专或中技毕业', '中专'],
    ['中专或中技肄业', '中专'],
    ['技工学校', '中专'],
    ['技校毕业', '中专'],
    ['技校肄业', '中专'],
    ['技校', '中专'],
    ['高中', '高中'],
    ['普通高中', '高中'],
    ['高中毕业', '高中'],
    ['普通高中毕业', '高中'],
    ['职高毕业', '高中'],
    ['职高', '高中'],
    ['农业高中毕业', '高中'],
    ['相当高中毕业', '高中'],
    ['高中肄业', '高中'],
    ['初中', '初中'],
    ['初中毕业', '初中'],
    ['职业初中毕业', '初中'],
    ['农业初中毕业', '初中'],
    ['相当初中毕业', '初中'],
    ['初中肄业', '初中'],
    ['小学', '小学'],
    ['小学毕业', '小学'],
    ['相当小学毕业', '小学'],
    ['小学肄业', '小学'],
    ['文盲或半文盲', '文盲或半文盲'],
    ['文盲', '文盲或半文盲'],
    ['半文盲', '文盲或半文盲'],
    ['其他', '其他']
  ].map(([key, value]) => [normalizePlain(key), value as EducationGroup])
)

const annualEducationValues = new Set([
  '博士研究生',
  '硕士研究生',
  '未获硕士学位的研究生',
  '研究生班毕业',
  '双学士学位大学本科',
  '学制为六年以上的大学本科',
  '大学本科',
  '大学专科',
  '中专',
  '技校',
  '高中',
  '初中',
  '小学',
  '其他'
].map(normalizePlain))

const budgetEducationValues = new Set([
  '研究生',
  '博士后',
  '博士',
  '硕士',
  '大学本科',
  '大学毕业',
  '相当大学毕业',
  '大学肄业',
  '大学专科和专科学校',
  '专科毕业',
  '相当专科毕业',
  '专科肄业',
  '中等专业学校和中等技术学校',
  '中专毕业',
  '中技毕业',
  '相当中专或中技毕业',
  '中专或中技肄业',
  '技工学校',
  '技校毕业',
  '技校肄业',
  '高中',
  '高中毕业',
  '职高毕业',
  '农业高中毕业',
  '相当高中毕业',
  '高中肄业',
  '初中',
  '初中毕业',
  '职业初中毕业',
  '农业初中毕业',
  '相当初中毕业',
  '初中肄业',
  '小学',
  '小学毕业',
  '相当小学毕业',
  '小学肄业',
  '文盲或半文盲'
].map(normalizePlain))

export function normalizeEducationForCompare(value: unknown): string {
  const raw = text(value).replace(/^最高/, '')
  if (!raw) return ''
  return resolveEducationGroup(raw) ?? normalizePlain(raw)
}

export function normalizeEducationForAnnualReport(value: unknown): string {
  const raw = text(value).replace(/^最高/, '')
  if (!raw) return ''
  if (annualEducationValues.has(normalizePlain(raw))) return raw
  const group = resolveEducationGroup(raw)
  return group ? annualEducationByGroup[group] : raw
}

export function normalizeEducationForBudget(value: unknown): string {
  const raw = text(value).replace(/^最高/, '')
  if (!raw) return ''
  if (budgetEducationValues.has(normalizePlain(raw))) return raw
  const group = resolveEducationGroup(raw)
  return group ? budgetEducationByGroup[group] : raw
}

export function educationRank(value: unknown): number {
  const group = resolveEducationGroup(value)
  if (group === '博士后') return 7
  if (group === '博士') return 6
  if (group === '硕士' || group === '研究生') return 5
  if (group === '大学本科' || group === '大学肄业') return 4
  if (group === '大学专科' || group === '专科肄业') return 3
  if (group === '中专') return 2
  if (group === '高中' || group === '初中' || group === '小学') return 1
  return 0
}

export function isEducationBucket(value: unknown, bucket: string): boolean {
  const group = normalizeEducationForCompare(value)
  if (bucket === '博士') return group === '博士' || group === '博士后'
  if (bucket === '硕士') return group === '硕士' || group === '研究生'
  if (bucket === '本科') return group === '大学本科' || group === '大学肄业'
  if (bucket === '大专') return group === '大学专科' || group === '专科肄业'
  if (bucket === '中专') return group === '中专'
  if (bucket === '高中及以下') return ['高中', '初中', '小学', '文盲或半文盲'].includes(group)
  return false
}

function resolveEducationGroup(value: unknown): EducationGroup | undefined {
  return educationGroupByValue.get(normalizePlain(text(value).replace(/^最高/, '')))
}

function normalizePlain(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}
