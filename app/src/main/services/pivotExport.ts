import { dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import type { PivotConfig, PivotResult } from '../../shared/types'
import { runPivot } from './pivot'

export async function exportPivotToExcel(
  config: PivotConfig,
  defaultName: string
): Promise<{ filePath: string; rowCount: number } | null> {
  const result = await runPivot(config)

  const dialogResult = await dialog.showSaveDialog({
    title: '导出透视结果',
    defaultPath: defaultName,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  })

  if (dialogResult.canceled || !dialogResult.filePath) return null

  const aoa = buildAoa(result, config.name || '透视结果')
  const sheet = XLSX.utils.aoa_to_sheet(aoa)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '透视结果')
  writeFileSync(dialogResult.filePath, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }))

  return { filePath: dialogResult.filePath, rowCount: result.rows.length }
}

function buildAoa(result: PivotResult, title: string): unknown[][] {
  const headers: string[] = [...result.rowDimensions, ...result.columnDimensions, ...result.valueAliases]
  const rows: unknown[][] = [
    [title],
    headers,
    ...result.rows.map((row) => headers.map((header) => row[header] ?? null))
  ]
  return rows
}
