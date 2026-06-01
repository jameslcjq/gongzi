import { readWorksheetMetadata } from '../db/metadata'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import type { WorksheetMeta } from '../../shared/types'

const worksheetNameAliases = new Map<string, string>([
  ['一体化在职', '在职工资'],
  ['一体化退休', '退休工资'],
  ['一体化其他', '其他工资'],
  ['在职工资', '一体化在职'],
  ['退休工资', '一体化退休'],
  ['其他工资', '一体化其他']
])

export function getWorksheetByName(name: string): WorksheetMeta {
  const candidates = [name, worksheetNameAliases.get(name)].filter((item): item is string => Boolean(item))
  const worksheet = readWorksheetMetadata().find((item) => candidates.includes(item.name))
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
