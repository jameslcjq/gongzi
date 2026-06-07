import { ref } from 'vue'
import type { InsuranceRecord } from './pushInsuranceScript'
import type { MonthlyPayrollPushTarget } from '@shared/types'

/**
 * 跨页面共享的"推送队列"：MonthlyPayrollPage 把要做的步骤塞进去，
 * IntegratedPortalPage 监听到非空就 active webview 上顺序跑。
 *
 * 支持两种步骤：
 *   - insurance：保险记录数组，POST /pay-voucher-server/.../savePayRawData
 *   - voucher：凭证文件 base64，POST /gld-account-server/.../gl_import_file_json (multipart)
 *   - salary-system-import：工资系统的工资变动/补发工资 Excel 导入
 *
 * 一次塞多步 → 串行处理（先保险再凭证）。一步失败立即停止，避免外部系统半成功。
 */
export type InsurancePushStep = {
  kind: 'insurance'
  records: InsuranceRecord[]
  label: string
  runId?: number
  pushTarget?: MonthlyPayrollPushTarget
}

export type VoucherPushStep = {
  kind: 'voucher'
  fileBase64: string
  fileName: string
  label: string
  runId?: number
  pushTarget?: MonthlyPayrollPushTarget
}

export type SalarySystemImportPushStep = {
  kind: 'salary-system-import'
  mode: 'salary' | 'backpay'
  fileBase64: string
  fileName: string
  fileSize: number
  month?: string
  label: string
  runId?: number
  pushTarget?: MonthlyPayrollPushTarget
}

export type PushStep = InsurancePushStep | VoucherPushStep | SalarySystemImportPushStep

export const pendingPushQueue = ref<PushStep[]>([])

export type PushQueueAutomation = {
  mode: 'full-auto'
  label: string
  runId?: number
  month?: number
}

export const pendingPushAutomation = ref<PushQueueAutomation | null>(null)

/** 一体化页是否正在处理推送队列。入口页据此拒绝重复点击、避免覆盖队列；历史页据此在推送结束后刷新状态。 */
export const pushInProgress = ref(false)

/** App.vue 注入"切到一体化模块"回调 */
type SwitchFn = () => void
let switchToIntegrationFn: SwitchFn | null = null

export function setSwitchToIntegration(fn: SwitchFn | null): void {
  switchToIntegrationFn = fn
}

export function requestSwitchToIntegration(): void {
  if (switchToIntegrationFn) switchToIntegrationFn()
  else console.warn('[push-queue] 切换函数未注册')
}
