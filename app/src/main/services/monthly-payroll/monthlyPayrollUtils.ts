export function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const raw = text(value).replace(/,/g, '')
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

export function coerceComparableValue(value: unknown): string | number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const raw = text(value)
  if (!raw) return ''
  const numberText = raw.replace(/,/g, '')
  if (/^-?\d+(\.\d+)?$/.test(numberText)) return Number(numberText)
  return raw
}

export function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

export function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, '').replace(/[()]/g, (match) => (match === '(' ? '（' : '）')).toLowerCase()
}

export function normalizeIdCard(value: unknown): string {
  return text(value).replace(/[\s,]/g, '').toUpperCase()
}

export function isValidIdCard(value: unknown): boolean {
  return /^\d{17}[\dX]$/.test(normalizeIdCard(value))
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}
