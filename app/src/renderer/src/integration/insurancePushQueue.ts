import { ref } from 'vue'
import type { InsuranceRecord } from './pushInsuranceScript'

/**
 * 跨页面共享的"推送队列"：MonthlyPayrollPage 把要做的步骤塞进去，
 * IntegratedPortalPage 监听到非空就 active webview 上顺序跑。
 *
 * 支持两种步骤：
 *   - insurance：保险记录数组，POST /pay-voucher-server/.../savePayRawData
 *   - voucher：凭证文件 base64，POST /gld-account-server/.../gl_import_file_json (multipart)
 *
 * 一次塞多步 → 串行处理（先保险再凭证）。一步失败也继续处理后续步骤（独立报错）。
 */
export type InsurancePushStep = {
  kind: 'insurance'
  records: InsuranceRecord[]
  label: string
}

export type VoucherPushStep = {
  kind: 'voucher'
  fileBase64: string
  fileName: string
  label: string
}

export type PushStep = InsurancePushStep | VoucherPushStep

export const pendingPushQueue = ref<PushStep[]>([])

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

// 向后兼容（旧代码引用 pendingInsurancePush 不再有效，留个别名占位）
export const pendingInsurancePush = ref<null>(null) // deprecated
