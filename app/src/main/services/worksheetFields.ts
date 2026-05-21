import { all, exec, getDatabase } from '../db/connection'
import { getSqlType, getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import { readWorksheetMetadata, writeWorksheetMetadata } from '../db/metadata'
import type { WorksheetField, WorksheetMeta } from '../../shared/types'

export async function saveWorksheetFields(
  worksheetId: string,
  fields: WorksheetField[]
): Promise<WorksheetMeta> {
  const worksheets = readWorksheetMetadata()
  const worksheetIndex = worksheets.findIndex((item) => item.worksheetId === worksheetId)
  if (worksheetIndex < 0) throw new Error(`未找到工作表：${worksheetId}`)

  const worksheet = worksheets[worksheetIndex]
  const nextFields = normalizeFields(fields, worksheet)
  worksheet.fields = nextFields
  ;(worksheet as WorksheetMeta & { fieldCount?: number }).fieldCount = nextFields.length
  writeWorksheetMetadata(worksheets)

  await ensureWorksheetColumns(worksheet)
  return worksheet
}

function normalizeFields(fields: WorksheetField[], worksheet: WorksheetMeta): WorksheetField[] {
  const existingById = new Map(
    worksheet.fields.filter((field) => field.fieldId).map((field) => [field.fieldId, field])
  )
  const incomingById = new Map(
    fields.filter((field) => field.fieldId).map((field) => [field.fieldId, field])
  )
  const newFields = fields.filter((field) => !field.fieldId)

  const retainedFields = worksheet.fields.map((existing, index) => {
    const incoming = incomingById.get(existing.fieldId)
    const isCustom = Boolean(existing.custom)
    const controlType = isCustom
      ? Number(incoming?.controlType || existing.controlType || 2)
      : Number(existing.controlType || 2)
    return {
      ...existing,
      name: isCustom ? normalizeFieldName(incoming?.name || existing.name) : existing.name,
      type: isCustom ? (incoming?.type || existing.type || typeNameOf(controlType)) : existing.type,
      controlType,
      desc: isCustom ? (incoming?.desc || existing.desc || descOf(controlType)) : existing.desc,
      options: isCustom ? normalizeOptions(incoming?.options ?? existing.options) : existing.options,
      hidden: Boolean(incoming?.hidden),
      displayOrder: Number.isFinite(Number(incoming?.displayOrder))
        ? Number(incoming?.displayOrder)
        : (existing.displayOrder ?? index),
      custom: isCustom || undefined
    }
  })

  const appendedFields = newFields.map((field, index) => {
    const name = normalizeFieldName(field.name)

    const existing = existingById.get(field.fieldId)
    const controlType = Number(field.controlType || existing?.controlType || 2)
    return {
      fieldId:
        field.fieldId ||
        existing?.fieldId ||
        `custom_${worksheet.worksheetId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}_${Date.now()}_${index}`,
      name,
      type: field.type || existing?.type || typeNameOf(controlType),
      controlType,
      desc: field.desc || existing?.desc || descOf(controlType),
      options: normalizeOptions(field.options ?? existing?.options),
      hidden: Boolean(field.hidden),
      displayOrder: Number.isFinite(Number(field.displayOrder))
        ? Number(field.displayOrder)
        : worksheet.fields.length + index,
      custom: true
    }
  })

  const normalized = [...retainedFields, ...appendedFields]
  assertFieldNamesAreSafe(normalized)
  return normalized
}

function normalizeFieldName(name: string | undefined): string {
  const normalized = String(name ?? '').trim()
  if (!normalized) throw new Error('字段名称不能为空')
  return normalized
}

function assertFieldNamesAreSafe(fields: WorksheetField[]): void {
  const seen = new Set<string>()
  for (const field of fields) {
    const name = normalizeFieldName(field.name)
    const key = name.replace(/\s+/g, '').toLowerCase()
    if (seen.has(key)) throw new Error(`字段名称重复：${name}`)
    seen.add(key)
    if (/^(id|md_|rowid$)/i.test(name)) {
      throw new Error(`字段名称 ${name} 与系统字段保留字冲突，请换一个名称`)
    }
  }
}

function normalizeOptions(options: string[] | undefined): string[] | undefined {
  const normalized = [...new Set((options ?? []).map((option) => option.trim()).filter(Boolean))]
  return normalized.length > 0 ? normalized : undefined
}

async function ensureWorksheetColumns(worksheet: WorksheetMeta): Promise<void> {
  const database = await getDatabase()
  const tableName = quoteIdentifier(worksheet.name)
  const existingColumns = await all<{ name: string }>(database, `PRAGMA table_info(${tableName})`)
  const existingNames = new Set(existingColumns.map((column) => column.name))

  for (const column of getWorksheetLocalColumns(worksheet)) {
    if (existingNames.has(column.columnName)) continue
    await exec(
      database,
      `ALTER TABLE ${tableName} ADD COLUMN ${quoteIdentifier(column.columnName)} ${getSqlType(column.field)}`
    )
  }
}

function typeNameOf(controlType: number): string {
  if (controlType === 6) return '数值'
  if (controlType === 7) return '证件'
  return '文本框'
}

function descOf(controlType: number): string {
  if (controlType === 6) return 'Double number'
  return 'String text'
}
