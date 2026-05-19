import type { WorksheetField, WorksheetMeta } from '../../shared/types'
import { readWorksheetMetadata } from './metadata'

const systemColumns = `
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "md_row_id" TEXT UNIQUE,
  "md_created_at" TEXT,
  "md_updated_at" TEXT`

export function readRetainedSchemaSql(): string {
  const worksheets = readWorksheetMetadata()
  const tableSql = worksheets.map((worksheet) => {
    const columns = getWorksheetLocalColumns(worksheet).map((column) => {
      return `  ${quoteIdentifier(column.columnName)} ${getSqlType(column.field)}`
    })
    return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(worksheet.name)} (
${systemColumns}${columns.length ? ',\n' + columns.join(',\n') : ''}
);`
  })

  return ['PRAGMA foreign_keys = ON;', ...tableSql].join('\n\n')
}

export function getWorksheetLocalColumns(
  worksheet: WorksheetMeta
): Array<{ field: WorksheetField; columnName: string }> {
  const usedNames = new Map<string, number>()

  return worksheet.fields.map((field) => {
    const columnName = getUniqueColumnName(field.name || field.fieldId, usedNames)
    return { field, columnName }
  })
}

function getUniqueColumnName(name: string, usedNames: Map<string, number>): string {
  const count = usedNames.get(name) ?? 0
  usedNames.set(name, count + 1)
  return count === 0 ? name : `${name}_${count + 1}`
}

export function getSqlType(field: WorksheetField): string {
  if ([6, 31].includes(field.controlType)) return 'REAL'
  return 'TEXT'
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
