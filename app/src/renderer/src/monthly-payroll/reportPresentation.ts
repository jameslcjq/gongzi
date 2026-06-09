export function reportSheetClass(name: string): string {
  if (name === '自动生成') return 'sheet-auto'
  if (name === '五险一金') return 'sheet-insurance'
  if (name === '工退遗汇总') return 'sheet-summary'
  if (name === '报销凭证') return 'sheet-voucher'
  if (isRetiredHousingSheetName(name)) return 'sheet-retired-housing sheet-integrated-retired'
  if (name === '补发工资') return 'sheet-wide sheet-backpay'
  if (name === '保险导入') return 'sheet-wide sheet-insurance-import'
  return 'sheet-standard'
}

export function isRetiredHousingSheetName(name: string | undefined): boolean {
  return name === '退休房补' || name === '退休工资'
}

export function formatCurrency(value: unknown): string {
  const amount = Number(value || 0)
  return `¥${amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

export function voucherUsageLines(row: unknown[]): string[] {
  const usage = String(row[8] ?? '')
  const lines = usage.split('\n').filter(Boolean)
  if (!isSalaryVoucher(row)) return lines
  return lines.map((line) => line.replace(/^五险一金(?!、个税)(?=-?[\d,])/, '五险一金、个税'))
}

export function isSalaryVoucher(row: unknown[]): boolean {
  return String(row[0] ?? '').includes('工资')
}

export function voucherAmount(value: unknown): string {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n === 0) return ''
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function voucherUpperAmount(row: unknown[], amountIndex: number): string {
  if (amountIndex === 2) return String(row[9] ?? '')
  if (amountIndex === 3) return String(row[13] ?? '')
  return toChineseRmb(Number(row[amountIndex] || 0))
}

function toChineseRmb(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '零元整'
  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const convert4 = (num: number): string => {
    const q = Math.floor(num / 1000)
    const b = Math.floor((num % 1000) / 100)
    const s = Math.floor((num % 100) / 10)
    const g = num % 10
    let out = ''
    if (q > 0) out += `${digits[q]}仟`
    if (b > 0) out += `${digits[b]}佰`
    else if (q > 0 && (s > 0 || g > 0)) out += '零'
    if (s > 0) out += `${digits[s]}拾`
    else if ((q > 0 || b > 0) && g > 0 && !out.endsWith('零')) out += '零'
    if (g > 0) out += digits[g]
    return out
  }
  const convertInteger = (num: number): string => {
    const yi = Math.floor(num / 100000000)
    const wan = Math.floor((num % 100000000) / 10000)
    const yuan = num % 10000
    let out = ''
    if (yi > 0) {
      out += `${convert4(yi)}亿`
      if (wan === 0 && yuan > 0) out += '零'
      else if (wan > 0 && wan < 1000) out += '零'
    }
    if (wan > 0) {
      out += `${convert4(wan)}万`
      if (yuan > 0 && yuan < 1000) out += '零'
    }
    if (yuan > 0) out += convert4(yuan)
    return out || '零'
  }
  const sign = value < 0 ? '负' : ''
  const rounded = Math.abs(Math.round(value * 100) / 100)
  const integer = Math.floor(rounded)
  const cents = Math.round((rounded - integer) * 100)
  const jiao = Math.floor(cents / 10)
  const fen = cents % 10
  let out = `${sign}${convertInteger(integer)}元`
  if (jiao > 0) out += `${digits[jiao]}角`
  else if (fen > 0) out += '零'
  out += fen > 0 ? `${digits[fen]}分` : '整'
  return out
}

type MergeSpan = { colspan: number, rowspan: number }
export type MergeEntry = { master?: MergeSpan, covered?: boolean }

function refToRowCol(ref: string): { r: number, c: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)
  if (!match) return { r: 0, c: 0 }
  let col = 0
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { r: parseInt(match[2], 10), c: col }
}

export function buildMergeMap(merges: string[] | undefined): Map<string, MergeEntry> {
  const map = new Map<string, MergeEntry>()
  if (!merges) return map
  for (const range of merges) {
    const [a, b] = range.split(':')
    const { r: r1, c: c1 } = refToRowCol(a)
    const { r: r2, c: c2 } = refToRowCol(b)
    map.set(`${r1},${c1}`, { master: { colspan: c2 - c1 + 1, rowspan: r2 - r1 + 1 } })
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        if (r === r1 && c === c1) continue
        map.set(`${r},${c}`, { covered: true })
      }
    }
  }
  return map
}

export function mergeFor(map: Map<string, MergeEntry>, r: number, c: number): MergeEntry | undefined {
  return map.get(`${r},${c}`)
}

export function colWidthPercents(widths: number[] | undefined, fallbackCount: number): string[] {
  const list = widths && widths.length ? widths : Array(fallbackCount).fill(1)
  const total = list.reduce((s, w) => s + (w || 0), 0) || list.length
  return list.map((w) => `${(((w || 0) / total) * 100).toFixed(3)}%`)
}

export function rowHeightStyle(heights: Array<number | null> | undefined, index: number): string {
  const h = heights?.[index]
  return h ? `height:${h}pt` : ''
}

export function isCustomStyledSheet(name: string): boolean {
  return (
    name === '自动生成' ||
    name === '五险一金' ||
    name === '工退遗汇总' ||
    isRetiredHousingSheetName(name)
  )
}
