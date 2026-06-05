import type {
  BudgetActiveMasterSyncPreview,
  HrMasterSyncPreview,
  MasterSyncSelectionItem,
  TeacherDetailMasterSyncPreview,
  TownshipMasterSyncPreview
} from '@shared/types'
import { displayWorksheetName } from './appModules'

export type SyncDiffTableRow = MasterSyncSelectionItem & {
  key: string
  sourceName: string
  name: string
  action: 'insert' | 'update'
  fieldName: string
  currentValue: string
  nextValue: string
  selected: boolean
}

export function flattenSyncDiffRows(
  sourceName: string,
  diffs: Array<{
    idCard: string
    name: string
    action?: 'insert' | 'update'
    changes: Array<{ fieldName: string; currentValue: string; nextValue: string }>
    sourceRecordId?: number
    budgetRecordId?: number
    townshipRecordId?: number
  }>,
  sourceRecordKey: 'sourceRecordId' | 'budgetRecordId' | 'townshipRecordId'
): SyncDiffTableRow[] {
  return diffs.flatMap((diff) => {
    const sourceRecordId = diff[sourceRecordKey]
    return diff.changes.map((change) => ({
      key: `${sourceName}|${sourceRecordId ?? ''}|${diff.idCard}|${change.fieldName}`,
      sourceName,
      sourceRecordId,
      idCard: diff.idCard,
      name: diff.name,
      action: diff.action ?? 'update',
      fieldName: change.fieldName,
      currentValue: change.currentValue,
      nextValue: change.nextValue,
      selected: true
    }))
  })
}

export function buildHrMasterSyncWarnings(preview: HrMasterSyncPreview): string[] {
  return [
    ...(preview.missingIdCardRows
      ? [`${displayWorksheetName('在职工资')}有 ${preview.missingIdCardRows} 条缺少证件号码，未纳入人事信息匹配。`]
      : []),
    ...(preview.missingLookupRows
      ? [`${displayWorksheetName('在职工资')}有 ${preview.missingLookupRows} 条按工资金额未匹配到岗位/薪级对照，未纳入本次更新。`]
      : [])
  ]
}

export function buildBudgetActiveMasterSyncWarnings(preview: BudgetActiveMasterSyncPreview): string[] {
  return preview.missingIdCardRows
    ? [`预算在职有 ${preview.missingIdCardRows} 条缺少证件号码，未纳入人事信息匹配。`]
    : []
}

export function buildTeacherDetailMasterSyncWarnings(preview: TeacherDetailMasterSyncPreview): string[] {
  return preview.missingIdCardRows
    ? [`在编教职工基本信息有 ${preview.missingIdCardRows} 条缺少身份证号码，未纳入人事信息匹配。`]
    : []
}

export function buildTownshipMasterSyncWarnings(preview: TownshipMasterSyncPreview): string[] {
  return preview.missingMasterRows
    ? [`乡镇补贴有 ${preview.missingMasterRows} 条身份证号在人事信息中未匹配到，未纳入本次更新。`]
    : []
}

export function appendSyncSummaryWarnings(summary: string, warnings: string[]): string {
  if (warnings.length === 0) return summary
  return `${summary}；${warnings.join('；')}`
}
