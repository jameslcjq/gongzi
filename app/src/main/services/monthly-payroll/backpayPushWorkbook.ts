import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import * as XLSX from 'xlsx'
import { assertInsideBusinessRoots } from '../../config/paths'
import type { BackpaySplitFile, LocalFileBase64 } from '../../../shared/types'

function readBackpayFileBase64(filePath: string): LocalFileBase64 {
  if (!filePath) throw new Error('文件路径为空')
  const ext = extname(filePath).toLowerCase()
  if (!['.xls', '.xlsx'].includes(ext)) {
    throw new Error('只允许拆分 Excel 补发工资文件')
  }
  assertInsideBusinessRoots(filePath, '补发工资文件')
  const buffer = readFileSync(filePath)
  const stat = statSync(filePath)
  return {
    filePath,
    fileName: basename(filePath),
    base64: buffer.toString('base64'),
    size: stat.size
  }
}

export function splitBackpayWorkbookBySalaryType(filePath: string): BackpaySplitFile[] {
  const file = readBackpayFileBase64(filePath)
  try {
    const workbook = XLSX.read(file.base64, { type: 'base64' })
    const firstSheetName = workbook.SheetNames[0]
    if (!firstSheetName) return [{ ...file, salaryType: '未识别', rowCount: 0 }]
    const backpaySheetName =
      workbook.SheetNames.find((name) => name === '补发工资') ?? firstSheetName
    const backpaySheet = workbook.Sheets[backpaySheetName]
    if (!backpaySheet) return [{ ...file, salaryType: '未识别', rowCount: 0 }]

    const rows = XLSX.utils.sheet_to_json<Array<string | number>>(backpaySheet, {
      header: 1,
      defval: '',
      blankrows: false
    })
    if (rows.length <= 1) return [{ ...file, salaryType: '未识别', rowCount: 0 }]

    const header = rows[0]
    const dataRows = rows
      .slice(1)
      .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    const grouped = new Map<string, Array<Array<string | number>>>()
    for (const row of dataRows) {
      const salaryType = String(row[3] ?? '').trim() || '未填工资类别'
      const items = grouped.get(salaryType) ?? []
      items.push(row)
      grouped.set(salaryType, items)
    }
    if (grouped.size <= 1) {
      const salaryType = grouped.keys().next().value ?? '未识别'
      return [{ ...file, salaryType, rowCount: dataRows.length }]
    }

    const bookType = workbookBookType(file.fileName)
    const result: BackpaySplitFile[] = []
    for (const [salaryType, salaryRows] of grouped.entries()) {
      const out = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(
        out,
        XLSX.utils.aoa_to_sheet([header, ...salaryRows]),
        backpaySheetName.slice(0, 31) || '补发工资'
      )
      for (const sheetName of workbook.SheetNames) {
        if (sheetName === backpaySheetName) continue
        const sheet = workbook.Sheets[sheetName]
        if (sheet) XLSX.utils.book_append_sheet(out, sheet, safeSheetName(sheetName))
      }
      const base64 = XLSX.write(out, { bookType, type: 'base64' }) as string
      result.push({
        ...file,
        base64,
        fileName: withFileSuffix(file.fileName, salaryType),
        size: base64ByteLength(base64),
        salaryType,
        rowCount: salaryRows.length
      })
    }
    return result
  } catch (error) {
    console.warn('拆分补发工资文件失败，改用原文件推送', error)
    return [{ ...file, salaryType: '未拆分', rowCount: 0 }]
  }
}

function workbookBookType(fileName: string): XLSX.BookType {
  return /\.xlsx$/i.test(fileName) ? 'xlsx' : 'xls'
}

function withFileSuffix(fileName: string, suffix: string): string {
  const safeSuffix = safeFileNamePart(suffix)
  const match = /^(.*?)(\.[^.\\/]*)?$/.exec(fileName)
  const base = match?.[1] || fileName
  const extension = match?.[2] || '.xls'
  return `${base}_${safeSuffix}${extension}`
}

function safeFileNamePart(value: string): string {
  return (value || '未填工资类别').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 24)
}

function safeSheetName(value: string): string {
  return value.replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet1'
}

function base64ByteLength(base64: string): number {
  const normalized = base64.replace(/\s+/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}
