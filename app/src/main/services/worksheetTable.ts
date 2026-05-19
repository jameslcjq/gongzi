import { readWorksheetMetadata } from '../db/metadata'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import type { WorksheetMeta } from '../../shared/types'

export function getWorksheetByName(name: string): WorksheetMeta {
  const worksheet = readWorksheetMetadata().find((item) => item.name === name)
  if (!worksheet) throw new Error(`未找到工作表：${name}`)
  return worksheet
}

export function getWorksheetById(worksheetId: string): WorksheetMeta {
  const worksheet = readWorksheetMetadata().find((item) => item.worksheetId === worksheetId)
  if (!worksheet) throw new Error(`未找到工作表：${worksheetId}`)
  return worksheet
}

export function findColumnByName(worksheet: WorksheetMeta, fieldName: string): string {
  const columns = getWorksheetLocalColumns(worksheet)
  const matched = columns.find((column) => column.field.name === fieldName)
  if (!matched) {
    throw new Error(`工作表 "${worksheet.name}" 缺少字段 "${fieldName}"`)
  }
  return matched.columnName
}

export function tryFindColumnByName(
  worksheet: WorksheetMeta,
  fieldName: string
): string | undefined {
  const columns = getWorksheetLocalColumns(worksheet)
  return columns.find((column) => column.field.name === fieldName)?.columnName
}

export function tableNameOf(worksheet: WorksheetMeta): string {
  return quoteIdentifier(worksheet.name)
}
