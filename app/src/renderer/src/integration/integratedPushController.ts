// 一体化推送组装与入队的共享逻辑。
//
// 原本内嵌在 MonthlyPayrollPage.vue 里，现抽出为独立模块，供两处复用：
//   - 工资业务页（MonthlyPayrollPage）的历史记录推送按钮（完整版）。
//   - 一体化对接页（IntegratedPortalPage）工具栏的推送按钮（内网执行端）。
// 同一份组装逻辑，永不分叉。

import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pendingPushQueue,
  pendingPushAutomation,
  pushInProgress,
  requestSwitchToIntegration,
  type PushQueueAutomation,
  type PushStep
} from './insurancePushQueue'
import { appendPushLogLine } from './pushLogger'
import type { InsuranceRecord } from './pushInsuranceScript'
import type {
  MonthlyPayrollRun,
  MonthlyPayrollPushTarget,
  MonthlyPayrollPushGuardResult
} from '@shared/types'

export function historyPushLabel(row: MonthlyPayrollRun): string {
  return `${row.year}-${String(row.month).padStart(2, '0')} ${row.unitFullName}`
}

export function pushStatusForTarget(
  row: MonthlyPayrollRun,
  target: MonthlyPayrollPushTarget
): MonthlyPayrollRun['insurancePushStatus'] {
  if (target === 'voucher') return row.voucherPushStatus
  if (target === 'salary') return row.salaryPushStatus
  return row.insurancePushStatus
}

export function pushTargetText(target: MonthlyPayrollPushTarget): string {
  if (target === 'voucher') return '凭证'
  if (target === 'salary') return '工资'
  return '保险'
}

export function pushTargetsForRow(row: MonthlyPayrollRun): MonthlyPayrollPushTarget[] {
  const targets: MonthlyPayrollPushTarget[] = []
  if (row.salaryImportPath || row.payrollBackpayPath) targets.push('salary')
  if (row.insuranceImportPath) targets.push('insurance')
  if (row.voucherImportPath) targets.push('voucher')
  return targets
}

export function canPushAll(row: MonthlyPayrollRun): boolean {
  return pushTargetsForRow(row).length > 0
}

export function reconciliationGuardMessage(guard: MonthlyPayrollPushGuardResult): string {
  if (guard.ok) return ''
  const issues = guard.reconciliation?.issues ?? []
  const detailLines = issues.slice(0, 6).map((issue) => `· ${issue.message}`)
  const suffix = issues.length > detailLines.length
    ? [`· 还有 ${issues.length - detailLines.length} 条差异，请打开报表复核详情查看`]
    : []
  return [guard.reason, ...detailLines, ...suffix].join('\n')
}

export function enqueueIntegratedPush(
  steps: PushStep[],
  stepHints: string[],
  label: string,
  automation?: PushQueueAutomation
): void {
  if (!steps.length) {
    ElMessage.warning('没有可推送的文件')
    return
  }
  // 正在推送时拒绝再次点击，避免覆盖当前队列、打断进行中的推送
  if (pushInProgress.value || pendingPushQueue.value.length > 0) {
    ElMessage.warning('正在推送中，请等待当前推送完成后再试')
    return
  }
  ElMessage.info(
    `已准备 ${steps.length} 步${label}（${stepHints.join('、')}），正在跳转到"一体化对接"...`
  )
  appendPushLogLine(
    `==== 触发${label}：准备 ${steps.length} 步（${stepHints.join('、')}），切换到一体化对接 ====`
  )
  requestSwitchToIntegration()
  const queuedSteps = steps.slice()
  window.setTimeout(() => {
    pendingPushAutomation.value = automation ?? null
    pendingPushQueue.value = queuedSteps
  }, 600)
}

export async function appendInsurancePushStep(
  row: MonthlyPayrollRun,
  label: string,
  steps: PushStep[],
  stepHints: string[]
): Promise<void> {
  if (!row.insuranceImportPath) return
  const parsed = await window.salaryApi.parseInsuranceImportXlsx(row.insuranceImportPath)
  if (!parsed.ok) {
    throw new Error('解析保险 xlsx 失败：' + parsed.reason)
  }
  if (!parsed.records.length) return
  steps.push({
    kind: 'insurance',
    records: parsed.records as InsuranceRecord[],
    label,
    runId: row.id,
    pushTarget: 'insurance'
  })
  stepHints.push(`保险 ${parsed.records.length} 条`)
}

export async function appendVoucherPushStep(
  row: MonthlyPayrollRun,
  label: string,
  steps: PushStep[],
  stepHints: string[]
): Promise<void> {
  if (!row.voucherImportPath) return
  const file = await window.salaryApi.readVoucherXlsx(row.voucherImportPath)
  if (!file.ok) {
    throw new Error('读取凭证 xlsx 失败：' + file.reason)
  }
  steps.push({
    kind: 'voucher',
    fileBase64: file.base64,
    fileName: file.fileName,
    label,
    runId: row.id,
    pushTarget: 'voucher'
  })
  stepHints.push(`凭证 ${(file.size / 1024).toFixed(1)} KB`)
}

export async function appendSalaryPushSteps(
  row: MonthlyPayrollRun,
  label: string,
  steps: PushStep[],
  stepHints: string[]
): Promise<void> {
  if (row.salaryImportPath) {
    const file = await window.salaryApi.readLocalFileBase64(row.salaryImportPath)
    steps.push({
      kind: 'salary-system-import',
      mode: 'salary',
      fileBase64: file.base64,
      fileName: file.fileName,
      fileSize: file.size,
      month: String(row.month),
      label,
      runId: row.id,
      pushTarget: 'salary'
    })
    stepHints.push(`工资导入 ${(file.size / 1024).toFixed(1)} KB`)
  }

  if (row.payrollBackpayPath) {
    const file = await window.salaryApi.readLocalFileBase64(row.payrollBackpayPath)
    steps.push({
      kind: 'salary-system-import',
      mode: 'backpay',
      fileBase64: file.base64,
      fileName: file.fileName,
      fileSize: file.size,
      label,
      runId: row.id,
      pushTarget: 'salary'
    })
    stepHints.push(`补发工资 ${(file.size / 1024).toFixed(1)} KB`)
  }
}

/** 按目标顺序组装推送步骤（保险 → 工资 → 凭证，与"全部推送"一致）。 */
export async function assemblePushSteps(
  row: MonthlyPayrollRun,
  targets: MonthlyPayrollPushTarget[],
  label: string
): Promise<{ steps: PushStep[]; stepHints: string[] }> {
  const steps: PushStep[] = []
  const stepHints: string[] = []
  if (targets.includes('insurance')) await appendInsurancePushStep(row, label, steps, stepHints)
  if (targets.includes('salary')) await appendSalaryPushSteps(row, label, steps, stepHints)
  if (targets.includes('voucher')) await appendVoucherPushStep(row, label, steps, stepHints)
  return { steps, stepHints }
}

export async function confirmPushTargets(
  row: MonthlyPayrollRun,
  targets: MonthlyPayrollPushTarget[]
): Promise<boolean> {
  if (row.isOutdated) {
    ElMessage.warning('这条报账记录已过期，请使用最新生成的记录重新推送')
    return false
  }
  const guard = await window.salaryApi.assertMonthlyPayrollRunPushable(row.id)
  if (!guard.ok) {
    await ElMessageBox.alert(
      reconciliationGuardMessage(guard),
      '自动复核未通过',
      { type: 'error', confirmButtonText: '知道了' }
    )
    return false
  }
  const repushTargets = targets.filter((target) => {
    const status = pushStatusForTarget(row, target)
    return status === 'success' || status === 'needs-repush'
  })
  if (!repushTargets.length) return true
  try {
    await ElMessageBox.confirm(
      `${repushTargets.map(pushTargetText).join('、')}已经推送过或标记为需要重推，继续会重新推送并覆盖原推送状态。`,
      '确认重新推送',
      { type: 'warning', confirmButtonText: '重新推送', cancelButtonText: '取消' }
    )
    return true
  } catch {
    return false
  }
}
