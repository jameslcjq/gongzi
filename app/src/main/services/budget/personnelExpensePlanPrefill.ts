import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import * as XLSX from 'xlsx'
import type {
  PersonnelExpensePlanPrefillResult,
  PersonnelExpensePlanPrefillRow
} from '../../../shared/types'

const importableExtensions = new Set(['.xlsx', '.xls'])

type ColumnDef = {
  key: string
  names: string[]
}

const amountColumns: ColumnDef[] = [
  { key: 'baseSalary', names: ['基本工资'] },
  { key: 'allowance', names: ['津贴补贴'] },
  { key: 'performance', names: ['绩效工资'] },
  { key: 'rentSubsidy', names: ['提租补贴'] },
  { key: 'pension', names: ['养老保险'] },
  { key: 'medical', names: ['医疗保险'] },
  { key: 'otherInsurance', names: ['其他社会保险', '其他社会保障'] },
  { key: 'annuity', names: ['职业年金'] },
  { key: 'housingFund', names: ['住房公积金'] },
  { key: 'contractTeacher', names: ['合同教师'] },
  { key: 'survivorSubsidy', names: ['遗属补助'] },
  { key: 'retiredRentSubsidy', names: ['退休人员提租补贴', '退休提租补贴'] }
]

const requiredAmountColumnKeys = new Set([
  'baseSalary',
  'allowance',
  'performance',
  'rentSubsidy',
  'pension',
  'medical',
  'otherInsurance',
  'annuity',
  'housingFund'
])

type HeaderDetection = {
  headerRowIndex: number
  budgetCodeCol?: number
  unitNameCol: number
  amountCols: Record<string, number>
  score: number
}

export async function readPersonnelExpensePlanPrefill(
  folderPath: string
): Promise<PersonnelExpensePlanPrefillResult> {
  const files = listRootExcelFiles(folderPath)
  const candidates = files
    .map((filePath) => ({ filePath, detection: detectPersonnelExpensePlanWorkbook(filePath) }))
    .filter((item): item is { filePath: string; detection: HeaderDetection } => !!item.detection)
    .sort((left, right) => {
      if (right.detection.score !== left.detection.score) return right.detection.score - left.detection.score
      return safeMtimeMs(right.filePath) - safeMtimeMs(left.filePath)
    })

  const picked = candidates[0]
  if (!picked) {
    return {
      ok: false,
      rows: [],
      message: '监控文件夹未找到必备列完整的人员经费核对表'
    }
  }

  try {
    const rows = readRows(picked.filePath, picked.detection)
    const archivedPath = archivePersonnelExpensePlanWorkbook(folderPath, picked.filePath)
    return {
      ok: true,
      filePath: archivedPath || picked.filePath,
      fileName: basename(picked.filePath),
      rows,
      message: rows.length
        ? `读取 ${rows.length} 个单位，源文件已归档`
        : '人员经费核对表中没有读到单位数据，源文件已归档'
    }
  } catch (error) {
    return {
      ok: false,
      filePath: picked.filePath,
      fileName: basename(picked.filePath),
      rows: [],
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function archivePersonnelExpensePlanWorkbook(folderPath: string, filePath: string): string | undefined {
  try {
    const targetFolder = join(folderPath, 'imported')
    mkdirSync(targetFolder, { recursive: true })
    const extension = extname(filePath)
    const stem = basename(filePath, extension)
    const targetPath = join(targetFolder, `${stem}_人员经费_${Date.now()}${extension}`)
    renameSync(filePath, targetPath)
    return targetPath
  } catch {
    return undefined
  }
}

export function isPersonnelExpensePlanWorkbook(filePath: string): boolean {
  return !!detectPersonnelExpensePlanWorkbook(filePath)
}

function listRootExcelFiles(folderPath: string): string[] {
  try {
    return readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(folderPath, entry.name))
      .filter((filePath) => importableExtensions.has(extname(filePath).toLowerCase()))
      .filter((filePath) => !basename(filePath).startsWith('~$'))
  } catch {
    return []
  }
}

function detectPersonnelExpensePlanWorkbook(filePath: string): HeaderDetection | undefined {
  try {
    const workbook = XLSX.readFile(filePath, { cellDates: false, sheetRows: 30 })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) return undefined
    const sheet = workbook.Sheets[sheetName]
    const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' })

    let best: HeaderDetection | undefined
    table.slice(0, 20).forEach((row, rowIndex) => {
      const cells = row.map((cell) => normalizeHeader(cell))
      const unitNameCol = cells.findIndex((cell) => cell.includes('预算单位'))
      if (unitNameCol < 0) return

      const amountCols: Record<string, number> = {}
      amountColumns.forEach((def) => {
        const col = cells.findIndex((cell) => def.names.some((name) => cell === normalizeHeader(name)))
        if (col >= 0) amountCols[def.key] = col
      })

      const score = Object.keys(amountCols).length
      const missingRequired = Array.from(requiredAmountColumnKeys).filter(
        (key) => amountCols[key] === undefined
      )
      if (missingRequired.length > 0) return

      const budgetCodeCol = cells.findIndex((cell) => cell.includes('预算代码'))
      const detected: HeaderDetection = {
        headerRowIndex: rowIndex,
        budgetCodeCol: budgetCodeCol >= 0 ? budgetCodeCol : undefined,
        unitNameCol,
        amountCols,
        score
      }
      if (!best || detected.score > best.score) best = detected
    })

    return best
  } catch {
    return undefined
  }
}

function readRows(filePath: string, detection: HeaderDetection): PersonnelExpensePlanPrefillRow[] {
  const workbook = XLSX.readFile(filePath, { cellDates: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return []
  const sheet = workbook.Sheets[sheetName]
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' })
  const result: PersonnelExpensePlanPrefillRow[] = []

  for (let rowIndex = detection.headerRowIndex + 1; rowIndex < table.length; rowIndex += 1) {
    const row = table[rowIndex]
    const unitName = cleanText(row[detection.unitNameCol])
    const budgetCode =
      detection.budgetCodeCol === undefined ? undefined : cleanText(row[detection.budgetCodeCol])
    if (!unitName && !budgetCode) continue

    const amounts: Record<string, number> = {}
    Object.entries(detection.amountCols).forEach(([key, col]) => {
      amounts[key] = parseAmount(row[col])
    })

    result.push({
      budgetCode: budgetCode || undefined,
      unitName,
      amounts
    })
  }

  return result
}

function parseAmount(value: unknown): number {
  const text = String(value ?? '')
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .replace(/￥/g, '')
  if (!text) return 0
  const num = Number(text)
  return Number.isFinite(num) ? num : 0
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[()（）]/g, '')
    .trim()
}

function safeMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}
