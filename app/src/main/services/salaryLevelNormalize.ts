const chineseDigits = new Map<string, number>([
  ['一', 1],
  ['二', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['七', 7],
  ['八', 8],
  ['九', 9],
  ['十', 10],
  ['十一', 11],
  ['十二', 12],
  ['十三', 13],
  ['十四', 14],
  ['十五', 15],
  ['十六', 16],
  ['十七', 17],
  ['十八', 18],
  ['十九', 19],
  ['二十', 20]
])

const chineseByNumber = new Map([...chineseDigits.entries()].map(([key, value]) => [value, key]))

export type JobLevelKind = 'professional' | 'technicalWorker' | 'management' | 'unknown'

export type NormalizedJobLevel = {
  kind: JobLevelKind
  level: number
}

export function parseJobLevel(value: unknown): NormalizedJobLevel | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const normalized = raw.replace(/\s+/g, '')
  const level = parseLevelNumber(normalized)
  if (!level) return undefined

  let kind: JobLevelKind = 'unknown'
  if (/专技|专业技术/.test(normalized)) kind = 'professional'
  else if (/技工|技术工|工勤|普技/.test(normalized)) kind = 'technicalWorker'
  else if (/管理|职员/.test(normalized)) kind = 'management'

  return { kind, level }
}

export function normalizeJobLevelForCompare(value: unknown): string {
  const parsed = parseJobLevel(value)
  if (!parsed) return normalizePlain(value)
  if (parsed.kind === 'unknown') return `LEVEL:${parsed.level}`
  return `${parsed.kind}:${parsed.level}`
}

export function jobLevelsEquivalent(left: unknown, right: unknown): boolean {
  const leftParsed = parseJobLevel(left)
  const rightParsed = parseJobLevel(right)
  if (!leftParsed || !rightParsed) {
    return normalizePlain(left) === normalizePlain(right)
  }
  if (leftParsed.level !== rightParsed.level) return false
  return leftParsed.kind === rightParsed.kind || leftParsed.kind === 'unknown' || rightParsed.kind === 'unknown'
}

export function normalizeJobLevelForDisplay(value: unknown, fallback = ''): string {
  const parsed = parseJobLevel(value)
  if (!parsed) return text(value) || fallback
  const cn = chineseByNumber.get(parsed.level) ?? String(parsed.level)
  if (parsed.kind === 'professional') return `专技${cn}级`
  if (parsed.kind === 'technicalWorker') return `技术工${cn}级`
  if (parsed.kind === 'management') return `管理${cn}级`
  return `${cn}级`
}

export function parseSalaryGrade(value: unknown): number | undefined {
  const raw = text(value)
  if (!raw) return undefined
  const digit = raw.match(/\d+/)
  if (digit) {
    const parsed = Number(digit[0])
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
  return parseChineseNumber(raw.replace(/\s+/g, ''))
}

export function normalizeSalaryGradeForCompare(value: unknown): string {
  const grade = parseSalaryGrade(value)
  return grade ? String(grade) : normalizePlain(value)
}

export function salaryGradesEquivalent(left: unknown, right: unknown): boolean {
  return normalizeSalaryGradeForCompare(left) === normalizeSalaryGradeForCompare(right)
}

export function normalizeSalaryGradeForBudget(value: unknown): string {
  const grade = parseSalaryGrade(value)
  return grade ? `${grade}档` : text(value)
}

export function normalizeSalaryGradeForDisplay(value: unknown): string {
  const grade = parseSalaryGrade(value)
  return grade ? String(grade) : text(value)
}

function parseLevelNumber(value: string): number | undefined {
  const digit = value.match(/(\d{1,2})/)
  if (digit) {
    const parsed = Number(digit[1])
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }

  const matchedChinese = [...chineseDigits.keys()]
    .sort((left, right) => right.length - left.length)
    .find((item) => value.includes(item))
  return matchedChinese ? chineseDigits.get(matchedChinese) : undefined
}

function parseChineseNumber(value: string): number | undefined {
  const matchedChinese = [...chineseDigits.keys()]
    .sort((left, right) => right.length - left.length)
    .find((item) => value.includes(item))
  return matchedChinese ? chineseDigits.get(matchedChinese) : undefined
}

function normalizePlain(value: unknown): string {
  return text(value).replace(/\s+/g, '').toUpperCase()
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}
