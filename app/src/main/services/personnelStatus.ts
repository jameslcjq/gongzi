import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import type { WorksheetMeta, WorksheetRecordValue } from '../../shared/types'

export const personnelStatusFieldName = '人员状态'
export const activePersonnelStatus = '在职'
export const retiredPersonnelStatus = '退休'
export const otherPersonnelStatus = '其他'
export const transferredPersonnelStatus = '调出'

const sourceWorksheetNames = new Set(['一体化在职', '一体化退休', '一体化其他'])
const budgetWorksheetNames = new Set(['预算在职', '预算退休', '预算其他'])
const identityFieldNames = new Set([
  '证件号码*',
  '证件号码',
  '身份证号',
  '身份证号码',
  '身份证号码*',
  '教职工身份证号'
])
const statusFieldNames = new Set(['人员状态', '人员状态*', '状态', '状态*'])

export function isPersonnelStatusSourceWorksheet(worksheetName: string): boolean {
  return sourceWorksheetNames.has(worksheetName)
}

export function getIdentityColumnName(worksheet: WorksheetMeta): string | undefined {
  const columns = getWorksheetLocalColumns(worksheet)
  return columns.find((column) => identityFieldNames.has(column.field.name))?.columnName
}

export function getPersonnelStatusColumnName(worksheet: WorksheetMeta): string | undefined {
  return getWorksheetLocalColumns(worksheet).find((column) => statusFieldNames.has(column.field.name))
    ?.columnName
}

export function isPersonnelStatusTargetWorksheet(worksheet: WorksheetMeta): boolean {
  return (
    !isPersonnelStatusSourceWorksheet(worksheet.name) &&
    Boolean(getIdentityColumnName(worksheet)) &&
    Boolean(getPersonnelStatusColumnName(worksheet))
  )
}

export function normalizeIdentityValue(value: WorksheetRecordValue | unknown): string {
  if (value === undefined || value === null) return ''
  return String(value).trim().replace(/[,\s]+/g, '').toUpperCase()
}

export function resolvePersonnelStatus(
  idValue: WorksheetRecordValue | unknown,
  activeIds: Set<string>,
  retiredIds: Set<string>,
  otherIds: Set<string> = new Set()
): string {
  const normalized = normalizeIdentityValue(idValue)
  if (normalized && activeIds.has(normalized)) return activePersonnelStatus
  if (normalized && retiredIds.has(normalized)) return retiredPersonnelStatus
  if (normalized && otherIds.has(normalized)) return otherPersonnelStatus
  return transferredPersonnelStatus
}

export function resolveBudgetWorksheetStatus(
  worksheetName: string,
  idValue: WorksheetRecordValue | unknown,
  activeIds: Set<string>,
  retiredIds: Set<string>,
  otherIds: Set<string> = new Set()
): string | undefined {
  if (!budgetWorksheetNames.has(worksheetName)) return undefined
  const personnelStatus = resolvePersonnelStatus(idValue, activeIds, retiredIds, otherIds)
  if (worksheetName === '预算在职') return personnelStatus === activePersonnelStatus ? '正常' : '调出人员'
  if (worksheetName === '预算退休') return personnelStatus === retiredPersonnelStatus ? '正常' : '去世'
  if (worksheetName === '预算其他') return personnelStatus === otherPersonnelStatus ? '正常' : '去世'
  return undefined
}

export function getPersonnelStatusViews(
  worksheet: WorksheetMeta
): Array<{ viewId?: string; name?: string }> {
  if (!isPersonnelStatusTargetWorksheet(worksheet)) return worksheet.views ?? []
  if (budgetWorksheetNames.has(worksheet.name)) return worksheet.views ?? []

  const preferred = [
    { viewId: 'personnel-active', name: activePersonnelStatus },
    { viewId: 'personnel-retired', name: retiredPersonnelStatus },
    { viewId: 'personnel-other', name: otherPersonnelStatus },
    { viewId: 'personnel-transferred', name: transferredPersonnelStatus }
  ]
  const merged = [...preferred, { viewId: 'all', name: '全部' }]
  const seen = new Set<string>()
  return merged.filter((view) => {
    const name = view.name ?? ''
    if (!name || seen.has(name)) return false
    seen.add(name)
    return true
  })
}

export function getPersonnelStatusViewCondition(worksheet: WorksheetMeta, view: string): string {
  if (!isPersonnelStatusTargetWorksheet(worksheet)) return ''
  const statusColumn = getPersonnelStatusColumnName(worksheet)
  if (!statusColumn) return ''

  const quotedColumn = quoteIdentifier(statusColumn)
  if (
    view === activePersonnelStatus ||
    view === retiredPersonnelStatus ||
    view === otherPersonnelStatus ||
    view === transferredPersonnelStatus
  ) {
    return `${quotedColumn} = '${view}'`
  }
  return ''
}
