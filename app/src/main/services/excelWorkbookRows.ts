import { readFile } from 'node:fs/promises'
import * as XLSX from 'xlsx'
import { getWorksheetLocalColumns } from '../db/schema'
import { getHeaderAliases, getMultiRowConfig } from './worksheetInference'
import type { WorksheetMeta } from '../../shared/types'

type ReadWorkbookRowsOptions = {
  allowUnknownHeaders?: boolean
}

const budgetWorkbookWorksheetNames = new Set([
  '预算在职',
  '预算退休',
  '预算其他'
])

export async function readWorkbookRows(
  filePath: string,
  worksheet: WorksheetMeta,
  options: ReadWorkbookRowsOptions = {}
): Promise<Array<Record<string, unknown>>> {
  const buffer = await readFile(filePath)
  const workbook = XLSX.read(buffer, { cellDates: false, type: 'buffer' })
  return readWorkbookRowsFromWorkbook(workbook, worksheet, options)
}

export async function readBudgetWorkbookImports(
  filePath: string,
  selectedWorksheet: WorksheetMeta,
  worksheets: WorksheetMeta[]
): Promise<Array<{ worksheet: WorksheetMeta; rows: Array<Record<string, unknown>> }>> {
  if (!budgetWorkbookWorksheetNames.has(selectedWorksheet.name)) return []

  const buffer = await readFile(filePath)
  const workbook = XLSX.read(buffer, { cellDates: false, type: 'buffer' })
  const imports: Array<{ worksheet: WorksheetMeta; rows: Array<Record<string, unknown>> }> = []
  for (const worksheetName of budgetWorkbookWorksheetNames) {
    const worksheet = worksheets.find((item) => item.name === worksheetName)
    if (!worksheet) continue
    const sheet = findSheetForWorksheet(workbook, worksheet, true)
    if (!sheet) continue
    const rows = readWorkbookRowsFromSheet(sheet, worksheet)
    if (rows.length > 0) imports.push({ worksheet, rows })
  }
  return imports
}

function readWorkbookRowsFromWorkbook(
  workbook: XLSX.WorkBook,
  worksheet: WorksheetMeta,
  options: ReadWorkbookRowsOptions = {}
): Array<Record<string, unknown>> {
  const sheet = findSheetForWorksheet(workbook, worksheet)
  if (!sheet) throw new Error('Excel 中没有可读取的工作表')
  return readWorkbookRowsFromSheet(sheet, worksheet, options)
}

export function findSheetForWorksheet(
  workbook: XLSX.WorkBook,
  worksheet: WorksheetMeta,
  requireWorksheetMatch = false
): XLSX.WorkSheet | undefined {
  const multiConfig = getMultiRowConfig(worksheet.name)
  if (multiConfig) {
    const matchedSheetName = workbook.SheetNames.find((name) => {
      const sheet = workbook.Sheets[name]
      return sheet ? shouldUseMultiRowConfig(sheet, multiConfig) : false
    })
    if (matchedSheetName) return workbook.Sheets[matchedSheetName]
  }

  if (requireWorksheetMatch) {
    const exactSheetName = workbook.SheetNames.find((name) => name === worksheet.name)
    return exactSheetName ? workbook.Sheets[exactSheetName] : undefined
  }

  const sheetName =
    workbook.SheetNames.find((name) => name === worksheet.name) || workbook.SheetNames[0]
  return workbook.Sheets[sheetName]
}

function readWorkbookRowsFromSheet(
  sheet: XLSX.WorkSheet,
  worksheet: WorksheetMeta,
  options: ReadWorkbookRowsOptions = {}
): Array<Record<string, unknown>> {
  const multiConfig = getMultiRowConfig(worksheet.name)
  if (multiConfig && shouldUseMultiRowConfig(sheet, multiConfig)) {
    return readMultiRowSheet(sheet, worksheet, multiConfig)
  }

  return readSimpleSheet(sheet, worksheet, options)
}

export function shouldUseMultiRowConfig(
  sheet: XLSX.WorkSheet,
  config: ReturnType<typeof getMultiRowConfig> & object
): boolean {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false
  })
  const titleRow = aoa[config.titleRow] as unknown[] | undefined
  if (!titleRow) return false
  return titleRow.map((value) => normalizeCell(value)).join('').includes(config.titleKeyword)
}

function readMultiRowSheet(
  sheet: XLSX.WorkSheet,
  worksheet: WorksheetMeta,
  config: ReturnType<typeof getMultiRowConfig> & object
): Array<Record<string, unknown>> {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false
  })

  let headers: string[]
  if (config.hardcodedHeaders) {
    headers = config.hardcodedHeaders
  } else if (config.useWorksheetFields) {
    headers = getWorksheetLocalColumns(worksheet)
      .slice(0, config.dataColumnCount ?? worksheet.fields.length)
      .map((column) => column.columnName)
  } else {
    const headerRow = aoa[config.leafHeaderRow] as unknown[] | undefined
    if (!headerRow) {
      throw new Error(`未找到第 ${config.leafHeaderRow + 1} 行表头`)
    }
    headers = trimEmptyHeaders(headerRow.map((value) => normalizeCell(value)))
    headers = alignHeadersToWorksheetColumns(headers, worksheet)
  }

  const rows: Array<Record<string, unknown>> = []
  for (let r = config.dataStartRow; r < aoa.length; r += 1) {
    const row = aoa[r]
    if (!row) continue
    if (config.firstColumnMustBeNumeric && !isNumericCell(row[0])) continue
    const obj: Record<string, unknown> = {}
    let hasValue = false
    for (let c = 0; c < headers.length; c += 1) {
      if (!headers[c]) continue
      const value = row[c]
      if (value !== null && value !== undefined && value !== '') {
        obj[headers[c]] = value
        hasValue = true
      }
    }
    if (hasValue) rows.push(obj)
  }
  return rows
}

function readSimpleSheet(
  sheet: XLSX.WorkSheet,
  worksheet: WorksheetMeta,
  options: ReadWorkbookRowsOptions = {}
): Array<Record<string, unknown>> {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false
  })
  const headerRow = aoa[0] as unknown[] | undefined
  if (!headerRow) throw new Error('Excel 中没有可读取的表头')
  validateSimpleSheetHeaders(trimEmptyHeaders(headerRow.map((value) => normalizeCell(value))), worksheet, options)
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false })
}

function validateSimpleSheetHeaders(
  headers: string[],
  worksheet: WorksheetMeta,
  options: ReadWorkbookRowsOptions = {}
): void {
  const unknownHeaders = getUnknownHeaders(headers, worksheet)
  if (unknownHeaders.length === 0 || options.allowUnknownHeaders) return

  const shown = unknownHeaders.slice(0, 20)
  const rest = unknownHeaders.length > shown.length ? `等 ${unknownHeaders.length} 个字段` : ''
  throw new Error(
    [
      `导入已暂停：${worksheet.name} 发现系统未登记字段。`,
      `新增字段：${shown.join('、')}${rest}`,
      `请先到「${worksheet.name} - 字段结构」中新增这些字段后，再重新导入。`
    ].join('\n')
  )
}

function getUnknownHeaders(headers: string[], worksheet: WorksheetMeta): string[] {
  const aliases = getHeaderAliases(worksheet.name)
  const normalizedAliases = new Map(
    Object.entries(aliases).map(([aliasHeader, targetFieldName]) => [
      normalizeHeader(aliasHeader),
      normalizeHeader(targetFieldName)
    ])
  )
  const expected = new Set(worksheet.fields.map((field) => normalizeHeader(field.name)))
  const unknown: string[] = []
  const seen = new Set<string>()

  for (const header of headers) {
    const normalized = normalizeHeader(header)
    if (!normalized) continue
    const actual = normalizedAliases.get(normalized) ?? normalized
    if (expected.has(actual) || seen.has(normalized)) continue
    seen.add(normalized)
    unknown.push(header)
  }

  return unknown
}

function validateHeaderSignature(headers: string[], worksheet: WorksheetMeta): void {
  const aliases = getHeaderAliases(worksheet.name)
  const expected = worksheet.fields.map((field) => field.name)
  const actual = headers.map((header) => aliases[header] ?? header)
  const extra = diffCounts(countValues(actual), countValues(expected))
  const missing = diffCounts(countValues(expected), countValues(actual))
  const issues: string[] = []
  for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
    const actualHeader = actual[index]
    const want = expected[index]
    if (actualHeader === want) continue
    issues.push(`第 ${index + 1} 列：${actualHeader || '空'} -> 应为 ${want}`)
    if (issues.length >= 6) break
  }
  if (extra.length > 0 || missing.length > 0 || issues.length > 0) {
    const parts = [`导入已暂停：${worksheet.name} 的 Excel 表头与系统字段不匹配。`]
    if (extra.length > 0) parts.push(`多出的字段：${extra.slice(0, 12).join('、')}`)
    if (missing.length > 0) parts.push(`缺少的字段：${missing.slice(0, 12).join('、')}`)
    if (issues.length > 0) parts.push(`位置不一致：${issues.join('；')}`)
    parts.push('请确认导入模板与系统字段结构一致后再重新导入。')
    throw new Error(parts.join('\n'))
  }
}

function alignHeadersToWorksheetColumns(headers: string[], worksheet: WorksheetMeta): string[] {
  const aliases = getHeaderAliases(worksheet.name)
  const columns = getWorksheetLocalColumns(worksheet)
  const expected = worksheet.fields.map((field) => field.name)
  const aligned: string[] = []
  let expectedIndex = 0
  let matchedCount = 0

  for (const header of headers) {
    const actual = aliases[header] ?? header
    let matchIndex = -1
    for (let index = expectedIndex; index < expected.length; index += 1) {
      if (expected[index] === actual) {
        matchIndex = index
        break
      }
    }

    if (matchIndex === -1) {
      aligned.push('')
      continue
    }

    aligned.push(columns[matchIndex]?.columnName ?? '')
    expectedIndex = matchIndex + 1
    matchedCount += 1
  }

  const requiredMatches = Math.max(2, Math.min(headers.length, expected.length) * 0.6)
  if (matchedCount < requiredMatches) {
    validateHeaderSignature(headers.slice(0, expected.length), worksheet)
  }

  return aligned
}

function trimEmptyHeaders(headers: string[]): string[] {
  let lastIndex = headers.length - 1
  while (lastIndex >= 0 && headers[lastIndex] === '') lastIndex -= 1
  return headers.slice(0, lastIndex + 1)
}

function countValues(values: string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const value of values) {
    if (!value) continue
    result.set(value, (result.get(value) ?? 0) + 1)
  }
  return result
}

function diffCounts(left: Map<string, number>, right: Map<string, number>): string[] {
  const result: string[] = []
  for (const [key, count] of left) {
    const diff = count - (right.get(key) ?? 0)
    for (let index = 0; index < diff; index += 1) result.push(key)
  }
  return result
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim().replace(/\s+/g, '')
}

export function isNumericCell(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (value === null || value === undefined) return false
  const text = String(value).trim()
  return text !== '' && Number.isFinite(Number(text))
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/g, '').toLowerCase()
}
