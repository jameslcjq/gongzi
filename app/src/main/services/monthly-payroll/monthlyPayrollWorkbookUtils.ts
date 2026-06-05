import { writeFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import type { MonthlyPayrollReportSheet } from '../../../shared/types'

export function writeWorkbook(
  filePath: string,
  sheets: MonthlyPayrollReportSheet[],
  bookType: XLSX.BookType = 'xlsx'
): void {
  const workbook = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const data = sheet.showColumnHeader === false ? sheet.rows : [sheet.columns, ...sheet.rows]
    const worksheet = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName(sheet.name))
  }
  writeFileSync(filePath, XLSX.write(workbook, { bookType, type: 'buffer' }))
}

export function gridColumns(count: number): string[] {
  return Array.from({ length: count }, (_, index) => columnLabel(index))
}

export function removeIndexes<T>(items: T[], indexes: number[]): T[] {
  const hidden = new Set(indexes)
  return items.filter((_, index) => !hidden.has(index))
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

function safeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet1'
}

export function timestamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function dateStamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}
