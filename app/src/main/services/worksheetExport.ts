import { dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import { all, getDatabase } from '../db/connection'
import { getWorksheetLocalColumns } from '../db/schema'
import { getWorksheetById, tableNameOf } from './worksheetTable'
import { getViewCondition } from './worksheetRecords'

export async function exportWorksheetToExcel(
  worksheetId: string,
  view = ''
): Promise<{ filePath: string; rowCount: number } | null> {
  const worksheet = getWorksheetById(worksheetId)
  const localColumns = getWorksheetLocalColumns(worksheet)
  const columns = worksheet.fields
    .map((field, index) => ({
      field,
      column: localColumns[index],
      displayOrder: field.displayOrder ?? index
    }))
    .filter((item) => !item.field.hidden)
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((item) => item.column)
    .filter((column): column is NonNullable<typeof column> => Boolean(column))
  const dialogResult = await dialog.showSaveDialog({
    title: `导出${worksheet.name}`,
    defaultPath: `${worksheet.name}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  })
  if (dialogResult.canceled || !dialogResult.filePath) return null

  const database = await getDatabase()
  const viewCondition = getViewCondition(worksheet, view.trim())
  const whereClause = viewCondition ? ` WHERE ${viewCondition}` : ''
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ${tableNameOf(worksheet)}${whereClause} ORDER BY "id" ASC`
  )
  const sheet = XLSX.utils.aoa_to_sheet([
    columns.map((column) => column.field.name),
    ...rows.map((row) => columns.map((column) => row[column.columnName] ?? ''))
  ])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName(worksheet.name))
  writeFileSync(dialogResult.filePath, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }))

  return { filePath: dialogResult.filePath, rowCount: rows.length }
}

function safeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet1'
}
