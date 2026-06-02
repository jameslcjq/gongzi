import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import * as XLSX from 'xlsx'
import { readWorksheetMetadata } from '../db/metadata'
import type { WorksheetMeta } from '../../shared/types'

const N = {
  integratedActive: '\u4e00\u4f53\u5316\u5728\u804c',
  integratedRetired: '\u4e00\u4f53\u5316\u9000\u4f11',
  integratedOther: '\u4e00\u4f53\u5316\u5176\u4ed6',
  activeSalary: '\u5728\u804c\u5de5\u8d44',
  retiredSalary: '\u9000\u4f11\u5de5\u8d44',
  otherSalary: '\u5176\u4ed6\u5de5\u8d44',
  budgetActive: '\u9884\u7b97\u5728\u804c',
  budgetRetired: '\u9884\u7b97\u9000\u4f11',
  budgetOther: '\u9884\u7b97\u5176\u4ed6',
  annualReport: '\u5de5\u8d44\u5e74\u62a5',
  townshipAllowance: '\u4e61\u9547\u8865\u8d34',
  hrDetail: '\u5728\u7f16\u6559\u804c\u5de5\u57fa\u672c\u4fe1\u606f',
  hrInfo: '\u4eba\u4e8b\u4fe1\u606f'
}

const F = {
  unitFullName: '\u5355\u4f4d\u5168\u79f0',
  unitName: '\u5355\u4f4d\u540d\u79f0',
  salaryTypeName: '\u5de5\u8d44\u7c7b\u522b\u540d\u79f0',
  salaryBatch: '\u5de5\u8d44\u6279\u6b21',
  salaryBatchCode: '\u5de5\u8d44\u6279\u6b21\u7f16\u7801',
  newRentSubsidyOld: '\u65b0\u804c\u5de5\u9010\u6708\u8865\u8d34',
  newRentSubsidy: '\u65b0\u804c\u5de5\u63d0\u79df\u8865\u8d34',
  postSalaryLevel: '\u5c97\u4f4d\u5de5\u8d44\u7ea7\u522b',
  postSalaryLevelRequired: '\u5c97\u4f4d\u5de5\u8d44\u7ea7\u522b*',
  salaryGrade: '\u5de5\u8d44\u85aa\u7ea7',
  workYears: '\u5de5\u9f84',
  workYearsRequired: '\u5de5\u9f84\uff08\u5e74\uff09*',
  livingSubsidy: '\u751f\u6d3b\u6027\u8865\u8d34',
  retiredSubsidy: '\u9000\u4f11\u8865\u8d34',
  otherSubsidyOld: '\u5176\u4ed6\u8865\u8d34\u52a0\u57fa\u7840\u7ee9\u6548\u5956',
  otherSubsidy: '\u5176\u4ed6\u8865\u8d34',
  remark1: '\u5907\u6ce8\u4e00'
}

const headerAliases: Record<string, Record<string, string>> = {
  [N.integratedActive]: {
    [F.salaryBatchCode]: F.salaryBatch
  },
  [N.integratedRetired]: {
    [F.salaryBatchCode]: F.salaryBatch
  },
  [N.budgetActive]: {
    [F.newRentSubsidyOld]: F.newRentSubsidy,
    [F.postSalaryLevel]: F.postSalaryLevelRequired,
    [F.salaryGrade]: F.salaryGrade,
    [F.workYears]: F.workYearsRequired
  },
  [N.budgetRetired]: {
    [F.livingSubsidy]: F.retiredSubsidy,
    [F.otherSubsidyOld]: F.otherSubsidy,
    [F.workYears]: F.workYearsRequired
  },
  [N.hrDetail]: {
    [F.unitFullName]: F.unitName
  },
  [N.hrInfo]: {
    [F.unitFullName]: F.unitName
  }
}

const fileNameAliases: Array<{ keyword: string; worksheetName: string }> = [
  { keyword: '\u4e8b\u4e1a\u5728\u804c\u5728\u7f16\u4eba\u5458\u4fe1\u606f\u60c5\u51b5\u8868', worksheetName: N.budgetActive },
  { keyword: '\u4e8b\u4e1a\u9000\u4f11\u4eba\u5458\u4fe1\u606f\u60c5\u51b5\u8868', worksheetName: N.budgetRetired },
  { keyword: '\u5176\u4ed6\u4eba\u5458', worksheetName: N.budgetOther },
  { keyword: '\u9884\u7b97\u5728\u7f16', worksheetName: N.budgetActive },
  { keyword: '\u9884\u7b97\u9000\u4f11', worksheetName: N.budgetRetired },
  { keyword: '\u9884\u7b97\u5176\u4ed6', worksheetName: N.budgetOther },
  { keyword: '\u5de5\u8d44\u5e74\u62a5', worksheetName: N.annualReport }
]

export type MultiRowConfig = {
  worksheetName: string
  titleRow: number
  titleKeyword: string
  leafHeaderRow: number
  dataStartRow: number
  hardcodedHeaders?: string[]
  useWorksheetFields?: boolean
  dataColumnCount?: number
  firstColumnMustBeNumeric?: boolean
}

export const multiRowConfigs: MultiRowConfig[] = [
  {
    worksheetName: N.budgetActive,
    titleRow: 0,
    titleKeyword: '\u4e8b\u4e1a\u5728\u804c\u5728\u7f16',
    leafHeaderRow: 6,
    dataStartRow: 7,
    firstColumnMustBeNumeric: true
  },
  {
    worksheetName: N.budgetRetired,
    titleRow: 0,
    titleKeyword: '\u4e8b\u4e1a\u9000\u4f11\u4eba\u5458',
    leafHeaderRow: 4,
    dataStartRow: 5,
    firstColumnMustBeNumeric: true
  },
  {
    worksheetName: N.budgetOther,
    titleRow: 0,
    titleKeyword: '\u5176\u4ed6\u4eba\u5458',
    leafHeaderRow: 3,
    dataStartRow: 4,
    firstColumnMustBeNumeric: true
  },
  {
    worksheetName: N.townshipAllowance,
    titleRow: 0,
    titleKeyword: '\u6cad\u9633\u53bf\u4e61\u9547\u5de5\u4f5c\u8865\u8d34\u5ba1\u6279\u8868',
    leafHeaderRow: 3,
    dataStartRow: 4,
    firstColumnMustBeNumeric: true
  },
  {
    worksheetName: N.annualReport,
    titleRow: 0,
    titleKeyword: '\u4e8b\u4e1a\u5355\u4f4d\u4eba\u5458\u4fe1\u606f\u8868',
    leafHeaderRow: 5,
    dataStartRow: 6,
    useWorksheetFields: true,
    dataColumnCount: 74,
    firstColumnMustBeNumeric: true
  },
  {
    // \u9644\u4ef61\uff1a\u5728\u7f16\u6559\u804c\u5de5\u57fa\u672c\u4fe1\u606f\u767b\u8bb0\u8868
    // \u884c0: "\u9644\u4ef61"\uff0c\u884c1: "\u6cad\u9633\u53bf20xx\u5e74\u5728\u7f16\u6559\u804c\u5de5\u57fa\u672c\u4fe1\u606f\u767b\u8bb0\u8868"\uff0c\u884c2: \u5355\u4f4d\u540d\u79f0
    // \u884c3-5: \u591a\u7ea7\u8868\u5934\uff0c\u884c6: \u5e8f\u53f7\u5217\uff0c\u884c7+: \u6570\u636e
    worksheetName: N.hrDetail,
    titleRow: 1,
    titleKeyword: '\u5728\u7f16\u6559\u804c\u5de5',
    leafHeaderRow: 3,
    dataStartRow: 7,
    firstColumnMustBeNumeric: true,
    hardcodedHeaders: [
      '\u5e8f\u53f7',           // 0
      '\u5355\u4f4d\u5168\u79f0',       // 1
      '\u59d3\u540d',           // 2
      '\u6027\u522b',           // 3
      '\u8eab\u4efd\u8bc1\u53f7\u7801',     // 4
      '\u6c11\u65cf',           // 5
      '\u7c4d\u8d2f',           // 6
      '\u653f\u6cbb\u9762\u8c8c',       // 7
      '\u5165\u515a\u65f6\u95f4',       // 8
      '\u4eba\u5458\u6027\u8d28',       // 9
      '',               // 10 \u5168\u65e5\u5236\u5b66\u5386\u53ca\u4e13\u4e1a\uff08\u4e0d\u5728\u5b57\u6bb5\u5217\u8868\uff09
      '',               // 11 \u6700\u9ad8\u5b66\u5386\u53ca\u4e13\u4e1a\uff08\u4e0d\u5728\u5b57\u6bb5\u5217\u8868\uff09
      '\u672c\u53bf\u5165\u7f16\u65f6\u95f4',   // 12
      '\u804c\u79f0',           // 13
      '\u804c\u79f0\u5b66\u79d1',       // 14 \u804c\u79f0-\u5b66\u79d1
      '\u804c\u79f0\u83b7\u5f97\u65f6\u95f4',   // 15 \u804c\u79f0-\u83b7\u5f97\u65f6\u95f4
      '',               // 16 \u6559\u5e08\u8d44\u683c\u8bc1-\u5b66\u6bb5
      '',               // 17 \u6559\u5e08\u8d44\u683c\u8bc1-\u5b66\u79d1
      '',               // 18 \u6559\u5e08\u8d44\u683c\u8bc1-\u8bc1\u4e66\u53f7\u7801
      '',               // 19 \u6559\u5e08\u8d44\u683c\u8bc1-\u6ce8\u518c\u6709\u6548\u671f
      '\u5c97\u4f4d\u804c\u52a1',       // 20 \u804c\u52a1-\u5c97\u4f4d\u804c\u52a1
      '\u4efb\u547d\u5355\u4f4d',       // 21
      '\u6279\u590d\u6587\u53f7',       // 22
      '\u5728\u73b0\u5355\u4f4d\u4efb\u73b0\u804c\u65f6\u95f4', // 23
      '\u662f\u5426\u5728\u5c97',       // 24
      '\u5c97\u4f4d',           // 25 \u5728\u5c97\u60c5\u51b5-\u5c97\u4f4d
      '',               // 26 \u5728\u5c97\u60c5\u51b5-\u4efb\u6559\u73ed\u7ea7\u5b66\u79d1\u8282\u6570
      '\u603b\u5468\u8bfe\u65f6\u6570',     // 27
      '\u662f\u5426\u4efb\u73ed\u4e3b\u4efb',   // 28
      '\u4e0d\u5728\u5c97\u539f\u56e0',     // 29 \u4e0d\u5728\u5c97\u60c5\u51b5-\u539f\u56e0
      '\u4e0d\u5728\u5c97\u8d77\u59cb\u65f6\u95f4', // 30 \u4e0d\u5728\u5c97\u60c5\u51b5-\u8d77\u59cb\u65f6\u95f4
      '\u4e0d\u5728\u5c97\u73b0\u5728\u4f55\u5904', // 31 \u4e0d\u5728\u5c97\u60c5\u51b5-\u73b0\u5728\u4f55\u5904
      '\u73b0\u4f4f\u5740',         // 32
      '\u8054\u7cfb\u7535\u8bdd',       // 33
      '',               // 34 \u5de5\u4f5c\u5c65\u5386\uff08\u4e0d\u5728\u5b57\u6bb5\u5217\u8868\uff09
      '\u5907\u6ce8'            // 35
    ]
  }
]

const hrDetailMultiRowConfig = multiRowConfigs.find((item) => item.worksheetName === N.hrDetail)
if (hrDetailMultiRowConfig) {
  multiRowConfigs.push({ ...hrDetailMultiRowConfig, worksheetName: N.hrInfo })
}

export function getHeaderAliases(worksheetName: string): Record<string, string> {
  return headerAliases[worksheetName] ?? {}
}

export function getMultiRowConfig(worksheetName: string): MultiRowConfig | undefined {
  return multiRowConfigs.find((item) => item.worksheetName === worksheetName)
}

export type SplitRule = {
  match: 'non-empty' | 'empty' | 'equals'
  value?: string
  target: string
}

export type SplitConfig = {
  worksheetName: string
  field: string
  rules: SplitRule[]
}

export const splitConfigs: SplitConfig[] = [
  {
    worksheetName: N.integratedRetired,
    field: F.remark1,
    rules: [
      { match: 'non-empty', target: N.integratedOther },
      { match: 'empty', target: N.integratedRetired }
    ]
  },
  {
    worksheetName: N.retiredSalary,
    field: F.remark1,
    rules: [
      { match: 'non-empty', target: N.otherSalary },
      { match: 'empty', target: N.retiredSalary }
    ]
  }
]

export function getSplitConfig(worksheetName: string): SplitConfig | undefined {
  return splitConfigs.find((item) => item.worksheetName === worksheetName)
}

export type WorksheetInferenceResult =
  | { worksheet: WorksheetMeta; reason?: undefined }
  | { worksheet?: undefined; reason: string }

export function inferWorksheet(filePath: string): WorksheetInferenceResult {
  const worksheets = readWorksheetMetadata()
  const fileName = basename(filePath, extname(filePath))
  const alias = fileNameAliases.find((item) => fileName.includes(item.keyword))
  if (alias) {
    const worksheet = worksheets.find((item) => item.name === alias.worksheetName)
    if (worksheet) return { worksheet }
  }

  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(readFileSync(filePath), { cellDates: false, type: 'buffer' })
  } catch (error) {
    return { reason: `read failed: ${(error as Error).message}` }
  }

  const aoa = readFirstSheetAoa(workbook)
  const multiRowMatch = matchMultiRowForm(aoa, worksheets)
  if (multiRowMatch) return { worksheet: multiRowMatch }

  const headerRow = findBestHeaderRow(aoa, worksheets)
  if (!headerRow) {
    return { reason: 'no matching header row found' }
  }

  const matches = getSignatureMatches(headerRow.headers, worksheets)
  if (matches.length === 1) return { worksheet: matches[0].worksheet }
  if (matches.length > 1) {
    const salaryMatch = pickSalaryWorksheetMatch(fileName, aoa, headerRow, matches)
    if (salaryMatch) return { worksheet: salaryMatch }
    const best = pickUniqueBestMatch(matches)
    if (best) return { worksheet: best }
    return { reason: `header matched multiple worksheets: ${matches.map((item) => item.worksheet.name).join(', ')}` }
  }

  const closest = findClosest(headerRow.headers, worksheets)
  return { reason: buildMismatchReason(headerRow.headers, closest) }
}

function readFirstSheetAoa(workbook: XLSX.WorkBook): unknown[][] {
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return []
  const sheet = workbook.Sheets[sheetName]
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false
  })
}

function findBestHeaderRow(
  aoa: unknown[][],
  worksheets: WorksheetMeta[]
): { rowIndex: number; headers: string[] } | undefined {
  let best: { rowIndex: number; headers: string[]; score: number } | undefined

  aoa.slice(0, 30).forEach((row, rowIndex) => {
    const headers = getHeadersFromRow(row)
    if (headers.length === 0) return
    const closest = findClosest(headers, worksheets)
    const score = closest?.matchedCount ?? 0
    if (!best || score > best.score) {
      best = { rowIndex, headers, score }
    }
  })

  return best && best.score >= 2 ? { rowIndex: best.rowIndex, headers: best.headers } : undefined
}

function getHeadersFromRow(row: unknown[]): string[] {
  return trimTrailing(row).map((value) => normalize(value))
}

function matchMultiRowForm(
  aoa: unknown[][],
  worksheets: WorksheetMeta[]
): WorksheetMeta | undefined {
  for (const config of multiRowConfigs) {
    const titleRow = aoa[config.titleRow]
    if (!titleRow) continue
    const flat = titleRow.map((value) => normalize(value)).join('')
    if (!flat.includes(config.titleKeyword)) continue

    const target = worksheets.find((item) => item.name === config.worksheetName)
    if (target) return target
  }
  return undefined
}

type SignatureMatch = {
  worksheet: WorksheetMeta
  matchedCount: number
}

function getSignatureMatches(headers: string[], worksheets: WorksheetMeta[]): SignatureMatch[] {
  return worksheets
    .map((worksheet) => ({
      worksheet,
      matchedCount: countMatches(headers, worksheet)
    }))
    .filter((match) => {
      return match.matchedCount >= Math.max(2, Math.min(headers.length, match.worksheet.fields.length) * 0.8)
    })
}

function pickUniqueBestMatch(matches: SignatureMatch[]): WorksheetMeta | undefined {
  const sorted = [...matches].sort((left, right) => right.matchedCount - left.matchedCount)
  const best = sorted[0]
  const second = sorted[1]
  if (!best) return undefined
  if (!second || second.matchedCount < best.matchedCount) return best.worksheet
  // On a tie, prefer the worksheet that owns a splitConfig — it's the routing source
  const topScore = best.matchedCount
  const tied = sorted.filter((m) => m.matchedCount === topScore)
  const withSplit = tied.find((m) => splitConfigs.some((c) => c.worksheetName === m.worksheet.name))
  if (withSplit) return withSplit.worksheet
  return undefined
}

function pickSalaryWorksheetMatch(
  fileName: string,
  aoa: unknown[][],
  headerRow: { rowIndex: number; headers: string[] },
  matches: SignatureMatch[]
): WorksheetMeta | undefined {
  const salaryMatches = matches.filter((item) =>
    [N.activeSalary, N.retiredSalary, N.otherSalary].includes(item.worksheet.name)
  )
  if (salaryMatches.length < 2) return undefined

  const targetName = inferSalaryWorksheetName(fileName, aoa, headerRow)
  if (!targetName) return undefined
  return salaryMatches.find((item) => item.worksheet.name === targetName)?.worksheet
}

function inferSalaryWorksheetName(
  fileName: string,
  aoa: unknown[][],
  headerRow: { rowIndex: number; headers: string[] }
): string | undefined {
  const fileKey = normalize(fileName)
  if (/退休|离休/.test(fileKey)) return N.retiredSalary
  if (/其他|遗属|遗补/.test(fileKey)) return N.otherSalary

  const typeIndex = headerRow.headers.findIndex((header) => header === normalize(F.salaryTypeName))
  if (typeIndex === -1) return undefined

  for (let rowIndex = headerRow.rowIndex + 1; rowIndex < aoa.length; rowIndex += 1) {
    const salaryTypeName = normalize(aoa[rowIndex]?.[typeIndex])
    if (!salaryTypeName) continue
    if (/退休|离休/.test(salaryTypeName)) return N.retiredSalary
    if (/其他|遗属|遗补/.test(salaryTypeName)) return N.otherSalary
    return N.activeSalary
  }

  return undefined
}

function findClosest(
  headers: string[],
  worksheets: WorksheetMeta[]
): { worksheet: WorksheetMeta; matchedCount: number } | undefined {
  let best: { worksheet: WorksheetMeta; matchedCount: number } | undefined
  for (const worksheet of worksheets) {
    const matchedCount = countMatches(headers, worksheet)
    if (!best || matchedCount > best.matchedCount) {
      best = { worksheet, matchedCount }
    }
  }
  return best
}

function countMatches(headers: string[], worksheet: WorksheetMeta): number {
  const fieldNames = new Set(worksheet.fields.map((field) => normalize(field.name)))
  const aliases = headerAliases[worksheet.name] ?? {}
  let matched = 0

  for (const header of headers) {
    if (fieldNames.has(header)) {
      matched += 1
      continue
    }
    const alias = aliases[header]
    if (alias && fieldNames.has(normalize(alias))) matched += 1
  }
  return matched
}

function buildMismatchReason(
  headers: string[],
  closest: { worksheet: WorksheetMeta; matchedCount: number } | undefined
): string {
  if (!closest || closest.matchedCount === 0) {
    return `no worksheet matched ${headers.length} header columns`
  }
  return `closest worksheet ${closest.worksheet.name} matched ${closest.matchedCount} columns, below threshold`
}

function trimTrailing(row: unknown[]): unknown[] {
  let lastIndex = row.length - 1
  while (lastIndex >= 0) {
    const value = row[lastIndex]
    if (value !== null && value !== undefined && value !== '') break
    lastIndex -= 1
  }
  return row.slice(0, lastIndex + 1)
}

function normalize(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim().replace(/\s+/g, '')
}
