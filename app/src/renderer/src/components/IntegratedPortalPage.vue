<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Close,
  Download,
  Link,
  Plus,
  Refresh
} from '@element-plus/icons-vue'
import { buildVoucherMergeScript } from '../integration/voucherMergeScript'
import {
  buildSalaryExportScript,
  buildSalaryExportFeedbackScript
} from '../integration/salaryExportScript'
import {
  buildOpenSalaryPlanInputScript,
  buildSalaryPlanInputScript
} from '../integration/salaryPlanInputScript'
import { buildAutoVoucherEntryScript } from '../integration/autoVoucherEntryScript'
import { buildSalaryQuotaMatchScript } from '../integration/salaryQuotaMatchScript'
import { buildSalarySystemImportScript } from '../integration/salarySystemImportScript'
// 预算 xls 改成被动模式：用户在内网手动点导出，文件按"人员信息"名字拦截 → 预览确认后入库
import { buildPushInsuranceScript } from '../integration/pushInsuranceScript'
import { buildPushVoucherScript } from '../integration/pushVoucherScript'
import { pendingPushQueue, type PushStep } from '../integration/insurancePushQueue'
import { appendPushLogLine, openPushLogFolder } from '../integration/pushLogger'
import { buildPortalDiagnosticsScript } from '../integration/portalDiagnosticsScript'
import {
  buildIntegrationPushPreflightScript,
  type IntegrationPushPreflightResult,
  type IntegrationPushPreflightUnit
} from '../integration/integrationPushPreflightScript'
import {
  buildOpenIntegrationModuleScript,
  type IntegrationModuleNavigationResult,
  type IntegrationModuleTarget
} from '../integration/integrationModuleNavigationScript'
import type { BudgetImportResult, MonthlyPayrollPushStatus } from '@shared/types'

const portalUrl = 'http://172.24.147.202/portal/login'

type SalaryExportFile = {
  filename: string
  base64: string
  size: number
  agency: string
  saltype: string
  salbatch: string
}
type SalaryExportSkip = { agency: string; saltype: string; salbatch: string; reason: string }
type SalaryExportFail = { agency: string; saltype: string; salbatch: string; reason: string }
type SalaryExportScriptResult =
  | {
      ok: true
      files: SalaryExportFile[]
      skipped: SalaryExportSkip[]
      failed: SalaryExportFail[]
    }
  | { ok: false; error: string }

type SalaryPlanInputOpenResult = {
  ok: boolean
  message?: string
}

type PortalWebview = HTMLElement & {
  executeJavaScript: (code: string) => Promise<unknown>
  getURL: () => string
  getTitle?: () => string
  getWebContentsId: () => number
  reload: () => void
  loadURL: (url: string) => Promise<void>
  src: string
}

type WebviewNewWindowEvent = {
  url: string
  frameName?: string
  disposition?: string
  preventDefault?: () => void
}

type Tab = {
  id: string
  title: string
  url: string
  loading: boolean
}

const webviewMap = new Map<string, PortalWebview>()
function bindWebview(id: string) {
  return (el: unknown): void => {
    if (el) webviewMap.set(id, el as PortalWebview)
    else webviewMap.delete(id)
  }
}

let tabSeq = 0
function nextTabId(): string {
  tabSeq += 1
  return `tab-${Date.now().toString(36)}-${tabSeq}`
}

const tabs = ref<Tab[]>([
  { id: nextTabId(), title: '一体化系统', url: portalUrl, loading: true }
])
const activeTabId = ref<string>(tabs.value[0].id)
const salaryExporting = ref(false)
// 预算 xls 改成被动模式：不再有 toolbar 按钮、不模拟点击、不自动跳转。
// 用户在内网手动点系统的导出按钮 → main 进程 will-download 按文件名 "人员信息"
// 判定为预算文件 → 落入 预算导出/ 子目录 → 立即调 budgetExcelImport 入库。

const activeTab = computed<Tab | undefined>(() =>
  tabs.value.find((t) => t.id === activeTabId.value)
)
function activeWebview(): PortalWebview | undefined {
  return webviewMap.get(activeTabId.value)
}

async function waitForWebview(tabId: string, maxWait = 30000): Promise<PortalWebview | undefined> {
  const deadline = Date.now() + maxWait
  while (Date.now() < deadline) {
    const wv = webviewMap.get(tabId)
    if (wv) {
      try {
        wv.getWebContentsId()
        return wv
      } catch {}
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250))
  }
  return webviewMap.get(tabId)
}

async function waitForActiveWebview(maxWait = 15000): Promise<PortalWebview | undefined> {
  const deadline = Date.now() + maxWait
  while (Date.now() < deadline) {
    const wv = activeWebview()
    if (wv) {
      try {
        wv.getWebContentsId()
        return wv
      } catch {}
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250))
  }
  return activeWebview()
}

function findTabById(id: string): Tab | undefined {
  return tabs.value.find((t) => t.id === id)
}

function activateTab(id: string): void {
  if (findTabById(id)) activeTabId.value = id
}

function openNewTab(url: string, makeActive = true): string {
  const id = nextTabId()
  tabs.value.push({ id, title: '新页签', url, loading: true })
  if (makeActive) activeTabId.value = id
  return id
}

function closeTab(id: string): void {
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx < 0) return
  webviewMap.delete(id)
  for (const target of ['budget', 'accounting'] as const) {
    if (pushTabIds[target] === id) delete pushTabIds[target]
  }
  if (tabs.value.length === 1) {
    // 不能没有标签 —— 重置成首页
    tabs.value = [{ id: nextTabId(), title: '一体化系统', url: portalUrl, loading: true }]
    activeTabId.value = tabs.value[0].id
    return
  }
  tabs.value.splice(idx, 1)
  if (activeTabId.value === id) {
    const fallback = tabs.value[Math.max(0, idx - 1)] || tabs.value[0]
    activeTabId.value = fallback.id
  }
}

function openHomeTab(): void {
  openNewTab(portalUrl)
}

// ---------------------------------------------------------------------------
// webview 事件
// ---------------------------------------------------------------------------
// 注：webview 标签的 @new-window 在带 allowpopups 时只是通知用，无法真正阻止默认弹窗。
// 我们改在主进程 setWindowOpenHandler 拦截、通过 IPC 推给宿主开新标签 —— 见 onMounted。

// 兼容：万一某些版本/路径还是触发了 @new-window，也把它接住
function onNewWindow(tabId: string, event: WebviewNewWindowEvent): void {
  event.preventDefault?.()
  if (event.url && event.url !== 'about:blank') {
    openNewTab(event.url)
  }
  void tabId
}

// 主进程通过 IPC 通知"webview 内有弹窗请求"
let stopOpenTabListener: (() => void) | null = null
let stopDownloadDoneListener: (() => void) | null = null
let stopRecorderDevTools: (() => void) | null = null
// 保险/凭证推送队列：MonthlyPayrollPage 把多步任务塞进 pendingPushQueue。
// 这里按目标模块复用专用 webview 页签，避免工资报账/历史报表当前页影响推送定位。
const processingPushQueue = ref(false)
const pushTabIds: Partial<Record<IntegrationModuleTarget, string>> = {}

// ---------------------------------------------------------------------------
// 推送过程日志：把"切模块 / 等页面 / 上传 / 回写状态"每一步显式记录下来，
// 让"点了推送没跳转"从黑盒变成可定位。注意：这里只做可观察性，不改导航逻辑。
// ---------------------------------------------------------------------------
type PushLogLevel = 'info' | 'ok' | 'warn' | 'err'
type PushLogEntry = {
  id: number
  runId: number
  ts: number
  level: PushLogLevel
  phase: string
  target?: string
  message: string
}
const pushRunLog = ref<PushLogEntry[]>([])
const pushPanelOpen = ref(false)
let pushRunSeq = 0
let pushLogSeq = 0
let currentPushRunId = 0

function logPush(
  runId: number,
  level: PushLogLevel,
  phase: string,
  message: string,
  target?: string
): void {
  pushLogSeq += 1
  pushRunLog.value.push({ id: pushLogSeq, runId, ts: Date.now(), level, phase, target, message })
  // 只保留最近 200 条，避免长时间运行后越积越多
  if (pushRunLog.value.length > 200) {
    pushRunLog.value.splice(0, pushRunLog.value.length - 200)
  }
  // 出问题或新一轮开始时自动展开，其余 info 不打扰已收起面板的用户
  if (level === 'err' || level === 'warn' || phase === '准备') pushPanelOpen.value = true
  const tag = `[push#${runId}][${phase}]${target ? '[' + target + ']' : ''}`
  if (level === 'err') console.error(tag, message)
  else if (level === 'warn') console.warn(tag, message)
  else console.log(tag, message)
  // 落盘到持久日志文件（全程留痕，供内网排查）
  appendPushLogLine(`#${runId} [${phase}]${target ? '[' + target + ']' : ''} ${level.toUpperCase()} ${message}`)
}

// 把推送脚本（保险/凭证/工资）内部的导航/上传 trace 也写进面板和日志文件，
// 这样"卡在哪一步菜单/哪一次上传"都能在文件里看到。
function logStepTrace(runId: number, kindLabel: string, trace: unknown): void {
  if (!Array.isArray(trace)) return
  for (const raw of trace) {
    const line = String(raw ?? '').trim()
    if (line) logPush(runId, 'info', '脚本', `${kindLabel}｜${line}`)
  }
}

async function revealPushLogFolder(): Promise<void> {
  try {
    await openPushLogFolder()
  } catch (error) {
    ElMessage.error(`打开日志文件夹失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function clearPushLog(): void {
  pushRunLog.value = []
}

function pushLogTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

async function copyPushLog(): Promise<void> {
  const text = pushRunLog.value
    .map(
      (e) =>
        `#${e.runId} ${pushLogTime(e.ts)} [${e.phase}]${e.target ? '[' + e.target + ']' : ''} ${e.level.toUpperCase()} ${e.message}`
    )
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('推送调试信息已复制到剪贴板')
  } catch (error) {
    console.warn('复制推送日志失败', error)
    ElMessage.warning('复制失败，请手动选择面板内容复制')
  }
}

function moduleDisplayName(target: IntegrationModuleTarget): string {
  return target === 'accounting' ? '中科单位核算' : '预算执行'
}

function describeWebviewState(wv: PortalWebview): { url: string; looksLikeLogin: boolean } {
  let url = ''
  try {
    url = wv.getURL()
  } catch {}
  const looksLikeLogin = /\/login|\/sso|passport|signin/i.test(url)
  return { url, looksLikeLogin }
}

function stepKindLabel(step: PushStep): string {
  if (step.kind === 'insurance') return '保险'
  if (step.kind === 'voucher') return '凭证'
  return step.mode === 'backpay' ? '补发工资' : '工资'
}

function stepDetail(step: PushStep): string {
  if (step.kind === 'insurance') return `${step.records.length} 条`
  return step.fileName
}

// 单步注入脚本的最长执行时间。超时即判失败并抛出，确保 processingPushQueue 能在 finally 里复位，
// 避免页面跳转导致 executeJavaScript 永不 resolve 而把整条推送队列（含后续保险/工资）永久卡死。
const PUSH_SCRIPT_TIMEOUT_MS = 180000

// 切模块（buildOpenIntegrationModuleScript）同样可能因页面跳转而卡住 executeJavaScript（曾导致保险推送整条队列冻结、后续无任何日志）。
// 给它单独一个较短超时；超时则记一条并继续交给页面脚本自己导航，绝不拖垮队列。
const MODULE_TARGET_TIMEOUT_MS = 90000

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer)
  })
}

function execStepScript(wv: PortalWebview, code: string, label: string): Promise<unknown> {
  return withTimeout(
    wv.executeJavaScript(code),
    PUSH_SCRIPT_TIMEOUT_MS,
    `${label}脚本执行超时（${Math.round(PUSH_SCRIPT_TIMEOUT_MS / 1000)}s，可能页面发生跳转导致上下文丢失），已停止本步`
  )
}

async function runOneStep(
  wv: PortalWebview,
  step: PushStep,
  runId = currentPushRunId
): Promise<void> {
  if (step.kind === 'insurance') {
    ElMessage.info(`【保险】开始：${step.label}（${step.records.length} 条）`)
    const r = (await execStepScript(wv, buildPushInsuranceScript(step.records), '保险')) as {
      ok: boolean
      reason?: string
      recordCount?: number
      trace?: string[]
    }
    logStepTrace(runId, '保险', r?.trace)
    if (r?.ok) {
      ElMessage.success(`✅ 保险已推送 ${r.recordCount} 条 / ${step.label}`)
    } else {
      throw new Error(`保险推送失败：${r?.reason || '未知错误'}`)
    }
  } else if (step.kind === 'voucher') {
    ElMessage.info(`【凭证】开始：${step.label}（${step.fileName}）`)
    const r = (await execStepScript(
      wv,
      buildPushVoucherScript(step.fileName, step.fileBase64, step.label),
      '凭证'
    )) as { ok: boolean; reason?: string; trace?: string[] }
    logStepTrace(runId, '凭证', r?.trace)
    if (r?.ok) {
      ElMessage.success(`✅ 凭证已导入 / ${step.label}`)
    } else {
      throw new Error(`凭证推送失败：${r?.reason || '未知错误'}`)
    }
  } else if (step.kind === 'salary-system-import') {
    const name = step.mode === 'backpay' ? '补发工资' : '工资导入'
    // 工资走后台接口推送（不跳转页面），明确告知用户，避免被当成"没反应"。
    ElMessage.info(`【${name}】后台接口推送（无需跳转页面）：${step.label}（${step.fileName}）`)
    let filterUnitName = ''
    try {
      const unit = await window.salaryApi.getUnitSettings()
      filterUnitName = (unit.unitFullName || '').trim()
      const filterUnitCode = (unit.unitImportCode || '').trim()
      const r = (await execStepScript(
        wv,
        buildSalarySystemImportScript({
          mode: step.mode,
          file: {
            fileName: step.fileName,
            base64: step.fileBase64,
            size: step.fileSize
          },
          filterUnitName,
          filterUnitCode,
          month: step.month
        }),
        name
      )) as SalarySystemImportResult | undefined
      logStepTrace(runId, name, r?.trace)
      if (r?.ok) {
        ElMessage.success(`✅ ${name}已导入 / ${step.label}`)
      } else {
        throw new Error(`${name}失败：${r?.message || '未知错误'}`)
      }
      return
    } catch (error) {
      if (filterUnitName) throw error
      console.warn('读取单位设置失败，继续由一体化单位列表判断', error)
    }
    const r = (await execStepScript(
      wv,
      buildSalarySystemImportScript({
        mode: step.mode,
        file: {
          fileName: step.fileName,
          base64: step.fileBase64,
          size: step.fileSize
        },
        filterUnitName,
        month: step.month
      }),
      name
    )) as SalarySystemImportResult | undefined
    logStepTrace(runId, name, r?.trace)
    if (r?.ok) ElMessage.success(`✅ ${name}已导入 / ${step.label}`)
    else throw new Error(`${name}失败：${r?.message || '未知错误'}`)
  }
}

async function markPushStatus(step: PushStep, status: MonthlyPayrollPushStatus): Promise<void> {
  if (!step.runId || !step.pushTarget) return
  try {
    await window.salaryApi.updateMonthlyPayrollPushStatus(step.runId, step.pushTarget, status)
  } catch (error) {
    console.warn('更新推送状态失败', error)
  }
}

function moduleTargetForStep(step: PushStep): IntegrationModuleTarget | null {
  if (step.kind === 'voucher') return 'accounting'
  if (step.kind === 'insurance') return 'budget'
  // 工资/补发工资是后台接口导入（discoverAgency → 上传），不依赖打开"预算执行"页面，
  // 因此不强制模块跳转，避免被当成"没反应"或误判失败。
  return null
}

function moduleTabTitle(target: IntegrationModuleTarget): string {
  return target === 'accounting' ? '核算凭证推送' : '预算执行推送'
}

function tabLooksLikeModule(tab: Tab, target: IntegrationModuleTarget): boolean {
  return (tab.title || '') === moduleTabTitle(target)
}

function findModuleTabId(target: IntegrationModuleTarget): string | null {
  const remembered = pushTabIds[target]
  if (remembered && findTabById(remembered)) return remembered
  const matched = tabs.value.find((tab) => tabLooksLikeModule(tab, target))
  return matched?.id || null
}

async function ensureModuleTarget(
  wv: PortalWebview,
  target: IntegrationModuleTarget,
  runId = currentPushRunId
): Promise<void> {
  const name = moduleDisplayName(target)
  let result: IntegrationModuleNavigationResult | undefined
  try {
    result = (await withTimeout(
      wv.executeJavaScript(buildOpenIntegrationModuleScript(target)),
      MODULE_TARGET_TIMEOUT_MS,
      `「${name}」切换超时（${Math.round(MODULE_TARGET_TIMEOUT_MS / 1000)}s，可能页面正在跳转导致上下文丢失）`
    )) as IntegrationModuleNavigationResult | undefined
  } catch (error) {
    // 关键：切模块卡住绝不能拖垮整条队列（曾导致保险推送后续无任何日志）。超时/异常即记录并继续，交给页面脚本自己导航。
    logPush(
      runId,
      'warn',
      '切换模块',
      `「${name}」切换未完成：${error instanceof Error ? error.message : String(error)}（继续交给页面脚本自动导航）`,
      name
    )
    return
  }
  if (!result?.ok) {
    // 仍按原逻辑"继续交给页面脚本自动导航"，只是把失败显式记录，
    // 方便区分"没找到入口 / 页面未登录 / 页面未加载完成"。
    logPush(
      runId,
      'warn',
      '切换模块',
      `「${name}」未确认打开：${result?.message || '未知原因'}（继续交给页面脚本自动导航）`,
      name
    )
    console.warn('一体化模块切换未完成，继续交由页面脚本自动导航', result?.message)
    return
  }
  if (result.changed) {
    logPush(runId, 'info', '切换模块', result.message, name)
    ElMessage.info(result.message)
  } else {
    logPush(runId, 'info', '切换模块', `已在「${name}」模块`, name)
  }
}

async function webviewForPushStep(step: PushStep): Promise<PortalWebview | undefined> {
  const target = moduleTargetForStep(step)
  if (!target) return waitForActiveWebview()

  let tabId = findModuleTabId(target)
  if (!tabId) {
    tabId = openNewTab(portalUrl, true)
    pushTabIds[target] = tabId
  } else {
    pushTabIds[target] = tabId
    activateTab(tabId)
  }

  const tab = findTabById(tabId)
  if (tab) tab.title = moduleTabTitle(target)

  const wv = await waitForWebview(tabId, 45000)
  if (!wv) return undefined
  await ensureModuleTarget(wv, target)
  return wv
}

function collectInsuranceUnits(steps: PushStep[]): IntegrationPushPreflightUnit[] {
  const map = new Map<string, IntegrationPushPreflightUnit>()
  for (const step of steps) {
    if (step.kind !== 'insurance') continue
    for (const record of step.records) {
      const code = String(record.agency_code || '').trim()
      const name = String(record.agency_code_name || '').trim()
      const key = `${code}|${name}`
      if (code || name) map.set(key, { code, name })
    }
  }
  return Array.from(map.values())
}

async function markStepsStatus(steps: PushStep[], status: MonthlyPayrollPushStatus): Promise<void> {
  const seen = new Set<string>()
  for (const step of steps) {
    const key = `${step.runId || ''}|${step.pushTarget || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    await markPushStatus(step, status)
  }
}

async function runPushPreflight(wv: PortalWebview, steps: PushStep[]): Promise<boolean> {
  // 真正注入前先在一体化页面核对单位和目标模块，防止把文件推到错误单位或错误页面。
  const needsSalary = steps.some((step) => step.kind === 'salary-system-import')
  const needsInsurance = steps.some((step) => step.kind === 'insurance')
  const needsVoucher = steps.some((step) => step.kind === 'voucher')
  let unitFullName = ''
  let unitImportCode = ''

  try {
    const unit = await window.salaryApi.getUnitSettings()
    unitFullName = (unit.unitFullName || '').trim()
    unitImportCode = (unit.unitImportCode || '').trim()
  } catch (error) {
    ElMessage.error(`读取单位设置失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }

  const result = (await wv.executeJavaScript(
    buildIntegrationPushPreflightScript({
      unitFullName,
      unitImportCode,
      needsSalary,
      needsInsurance,
      needsVoucher,
      insuranceUnits: collectInsuranceUnits(steps)
    })
  )) as IntegrationPushPreflightResult | undefined

  if (result?.ok) {
    const agency = result.matchedAgency
    ElMessage.success(
      agency
        ? `推送前检测通过：${agency.agency_code} ${agency.agency_name}`
        : result.message || '推送前检测通过'
    )
    return true
  }

  const details = result?.details?.filter(Boolean) ?? []
  await ElMessageBox.alert(
    [result?.message || '一体化推送前检测未通过', ...details].join('\n'),
    '推送前检测',
    { type: 'error', confirmButtonText: '知道了' }
  )
  return false
}

async function processPushQueue(): Promise<void> {
  // 推送必须串行：一体化页面保存、弹窗和进度条都依赖当前页面状态，失败后停止后续步骤。
  if (processingPushQueue.value) return
  if (!pendingPushQueue.value.length) return
  processingPushQueue.value = true
  const runId = ++pushRunSeq
  currentPushRunId = runId
  try {
    const queuedSteps = pendingPushQueue.value.slice()
    logPush(runId, 'info', '准备', `推送开始：共 ${queuedSteps.length} 步`)
    ElMessage.info(`一体化推送开始：共 ${queuedSteps.length} 步`)

    logPush(runId, 'info', '等待页面', '等待一体化 webview 就绪 …')
    const wv = await waitForActiveWebview(45000)
    if (!wv) {
      logPush(runId, 'err', '等待页面', '一体化 webview 尚未就绪，推送任务已停止，请重新触发')
      ElMessage.error('一体化 webview 尚未就绪，推送任务已停止，请重新触发')
      pendingPushQueue.value = []
      return
    }
    const state = describeWebviewState(wv)
    if (state.looksLikeLogin) {
      logPush(
        runId,
        'warn',
        '等待页面',
        `当前页面疑似登录页，可能无法跳转，请先登录一体化系统后再推送：${state.url}`
      )
    } else {
      logPush(runId, 'info', '等待页面', `当前页面：${state.url || '未知'}`)
    }

    while (pendingPushQueue.value.length > 0) {
      const step = pendingPushQueue.value.shift() as PushStep
      const name = stepKindLabel(step)
      try {
        await markPushStatus(step, 'queued')
        const target = moduleTargetForStep(step)
        if (target) {
          logPush(
            runId,
            'info',
            '切换模块',
            `${name}：尝试打开「${moduleDisplayName(target)}」`,
            moduleDisplayName(target)
          )
          await ensureModuleTarget(wv, target, runId)
        } else {
          logPush(runId, 'info', '上传', `${name}：后台接口推送，无需跳转页面`, '后台接口')
        }
        logPush(runId, 'info', '上传', `${name}：开始执行（${stepDetail(step)}）`)
        await runOneStep(wv, step, runId)
        await markPushStatus(step, 'success')
        logPush(runId, 'ok', '完成', `${name}：完成`)
      } catch (error) {
        await markPushStatus(step, 'failed')
        const stopped = pendingPushQueue.value.length
        pendingPushQueue.value = []
        const msg = error instanceof Error ? error.message : String(error)
        logPush(runId, 'err', '失败', `${name} 步骤失败，已停止后续 ${stopped} 个步骤：${msg}`)
        ElMessage.error(`执行 ${step.kind} 步骤失败，已停止后续 ${stopped} 个步骤：${msg}`)
        // 失败时自动抓取门户结构快照（只读），便于在看不到内网页面时定位菜单/iframe 布局
        try {
          const diag = (await withTimeout(
            wv.executeJavaScript(buildPortalDiagnosticsScript()),
            15000,
            '门户结构诊断超时'
          )) as unknown
          logStepTrace(runId, '诊断', Array.isArray(diag) ? diag : [String(diag)])
        } catch (diagError) {
          logPush(
            runId,
            'warn',
            '诊断',
            `抓取门户结构失败：${diagError instanceof Error ? diagError.message : String(diagError)}`
          )
        }
        return
      }
      // 步骤间隔，让浮窗状态可读
      await new Promise((r) => window.setTimeout(r, 1200))
    }
    logPush(runId, 'ok', '完成', `一体化推送完成：${queuedSteps.length} 步`)
    ElMessage.success(`一体化推送完成：${queuedSteps.length} 步`)
  } finally {
    processingPushQueue.value = false
  }
}

watch(
  () => pendingPushQueue.value.length,
  (len) => {
    if (len > 0) void processPushQueue()
  },
  { immediate: false }
)

async function confirmBudgetImport(filePath: string): Promise<void> {
  let preview: BudgetImportResult
  try {
    preview = await window.salaryApi.previewBudgetImport(filePath)
  } catch (error) {
    ElMessage.error(`预算 xls 预览失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const summary = formatBudgetImportSummary(preview, false)
  try {
    await ElMessageBox.confirm(
      `${summary}\n\n确认后才会写入预算表。`,
      '确认预算 xls 入库',
      {
        type: preview.ok ? 'warning' : 'error',
        confirmButtonText: '确认入库',
        cancelButtonText: '暂不入库',
        dangerouslyUseHTMLString: false
      }
    )
  } catch {
    ElMessage.info('已取消预算 xls 入库，文件已保留在本地')
    return
  }

  try {
    const result = await window.salaryApi.commitBudgetImport(filePath)
    if (result.ok) {
      ElMessage.success({
        message: formatBudgetImportSummary(result, true),
        duration: 10000
      })
    } else {
      ElMessage.error(`预算入库失败：${result.message || '详见明细'}`)
    }
  } catch (error) {
    ElMessage.error(`预算入库失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function formatBudgetImportSummary(result: BudgetImportResult, committed: boolean): string {
  const action = committed ? '入库完成' : '预览结果'
  const head =
    `预算 xls ${action}：${committed ? '插入' : '将插入'} ${result.totalInserted}，` +
    `${committed ? '更新' : '将更新'} ${result.totalUpdated}，跳过 ${result.totalSkipped}`
  const lines = result.sheets
    .filter((sheet) => sheet.inserted + sheet.updated + sheet.skipped > 0 || sheet.status !== 'empty')
    .map((sheet) => {
      const status = sheet.status === 'ok' ? '' : `（${sheet.message || sheet.status}）`
      return `${sheet.worksheetName}: ${committed ? '新增' : '将新增'} ${sheet.inserted} / ${committed ? '更新' : '将更新'} ${sheet.updated} / 跳过 ${sheet.skipped}${status}`
    })
  return [head, ...lines.slice(0, 8), lines.length > 8 ? `其余 ${lines.length - 8} 张表略` : '']
    .filter(Boolean)
    .join('\n')
}

onMounted(() => {
  if (import.meta.env.DEV) {
    void nextTick(async () => {
      const actions = document.querySelector<HTMLElement>('.portal-actions')
      if (!actions) return
      const mod = await import('../integration/recorderDevTools')
      stopRecorderDevTools = mod.mountPortalRecorderDevTools({
        target: actions,
        activeWebview,
        api: window.salaryApi
      })
    })
  }
  if (pendingPushQueue.value.length > 0) {
    void nextTick(() => {
      window.setTimeout(() => void processPushQueue(), 800)
    })
  }
  stopDownloadDoneListener = window.salaryApi.onWebviewDownloadDone((payload: {
    ok: boolean
    state: string
    originalName: string
    savedPath: string
    url: string
    isBudget?: boolean
  }) => {
    if (payload.ok) {
      if (payload.isBudget) {
        ElMessage.success(`预算 xls 已存档：${payload.savedPath}；等待确认入库`)
        void confirmBudgetImport(payload.savedPath)
      } else {
        ElMessage.success(
          `已自动入库：${payload.originalName} → ${payload.savedPath}（watcher 会自动导入）`
        )
      }
    } else {
      ElMessage.warning(`一体化下载未完成（${payload.state}）：${payload.originalName}`)
    }
  })

  stopOpenTabListener = window.salaryApi.onWebviewOpenTabRequest((payload: { sourceWebContentsId: number; url: string; disposition?: string }) => {
    if (!payload?.url || payload.url === 'about:blank') return
    // 找出请求来源的 tab（仅用于调试日志，开新标签时本身和来源无关）
    let sourceTabTitle = ''
    for (const [id, wv] of webviewMap.entries()) {
      try {
        if (wv.getWebContentsId() === payload.sourceWebContentsId) {
          sourceTabTitle = findTabById(id)?.title || ''
          break
        }
      } catch {}
    }
    console.log(
      '[portal] 拦截弹窗，转新标签 ←',
      sourceTabTitle || payload.sourceWebContentsId,
      payload.url
    )
    openNewTab(payload.url)
  })
})
onBeforeUnmount(() => {
  if (stopOpenTabListener) {
    stopOpenTabListener()
    stopOpenTabListener = null
  }
  if (stopDownloadDoneListener) {
    stopDownloadDoneListener()
    stopDownloadDoneListener = null
  }
  if (stopRecorderDevTools) {
    stopRecorderDevTools()
    stopRecorderDevTools = null
  }
})

function onDomReady(tabId: string): void {
  const t = findTabById(tabId)
  if (!t) return
  t.loading = false
  const wv = webviewMap.get(tabId)
  if (wv) {
    try {
      t.url = wv.getURL()
    } catch {}
    try {
      const title = wv.getTitle?.()
      if (title) t.title = title
    } catch {}
  }
  void installPortalAutomationScripts(tabId)
}

function onStartLoading(tabId: string): void {
  const t = findTabById(tabId)
  if (t) t.loading = true
}

function onFinishLoad(tabId: string): void {
  onDomReady(tabId)
}

function onPageTitleUpdated(
  tabId: string,
  event: { title?: string } | undefined
): void {
  const t = findTabById(tabId)
  if (t && event?.title) t.title = event.title
}

function onDidNavigate(tabId: string, event: { url?: string } | undefined): void {
  const t = findTabById(tabId)
  if (t && event?.url) t.url = event.url
}

function handleDidNavigate(tabId: string, event: unknown): void {
  onDidNavigate(tabId, event as { url?: string } | undefined)
}

function handlePageTitle(tabId: string, event: unknown): void {
  onPageTitleUpdated(tabId, event as { title?: string } | undefined)
}

function handleNewWindow(tabId: string, event: unknown): void {
  onNewWindow(tabId, event as WebviewNewWindowEvent)
}

function onFrameFinishLoad(tabId: string): void {
  void installPortalAutomationScripts(tabId)
}

// ---------------------------------------------------------------------------
// toolbar 操作
// ---------------------------------------------------------------------------
function reload(): void {
  activeWebview()?.reload()
}

async function openExternal(): Promise<void> {
  const url = activeTab.value?.url || portalUrl
  try {
    await window.salaryApi.openIntegrationExternal(url)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '外部浏览器打开失败')
  }
}

async function openSalaryPlanInput(): Promise<void> {
  const wv = activeWebview()
  if (!wv) {
    ElMessage.warning('一体化页面尚未就绪')
    return
  }

  let prefill
  try {
    prefill = await window.salaryApi.getPersonnelExpensePlanPrefill()
  } catch (error) {
    console.warn('读取人员经费核对表失败', error)
    prefill = {
      ok: false,
      rows: [],
      message: error instanceof Error ? error.message : String(error)
    }
  }

  try {
    let result = (await wv.executeJavaScript(
      buildOpenSalaryPlanInputScript(prefill)
    )) as SalaryPlanInputOpenResult
    if (!result?.ok) {
      await installPortalAutomationScripts(activeTabId.value)
      result = (await wv.executeJavaScript(
        buildOpenSalaryPlanInputScript(prefill)
      )) as SalaryPlanInputOpenResult
    }
    if (!result?.ok) {
      ElMessage.warning(result?.message || '请先进入“一般用款计划录入”的待录入列表页')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '人员经费录入弹窗打开失败')
  }
}

type SalarySystemImportResult =
  | { ok: true; response?: unknown; agency?: { agency_name?: string }; batchId?: string; trace?: string[] }
  | { ok: false; message?: string; trace?: string[] }

// ---------------------------------------------------------------------------
// 一体化页面脚本注入（跨 frame）
// ---------------------------------------------------------------------------
async function installPortalAutomationScripts(tabId: string): Promise<void> {
  const wv = webviewMap.get(tabId)
  if (!wv) return

  let salaryQuotaMatchScript = buildSalaryQuotaMatchScript({ autoStart: false })
  try {
    const localSummary = await window.salaryApi.getSalaryQuotaMatchLocalSummary()
    salaryQuotaMatchScript = buildSalaryQuotaMatchScript({ autoStart: false, localSummary })
  } catch (error) {
    console.warn('额度匹配本地汇总读取失败，使用默认脚本配置', error)
    salaryQuotaMatchScript = buildSalaryQuotaMatchScript({
      autoStart: false,
      localSummary: {
        ok: false,
        activeOtherOneTotal: 0,
        activeBasicPerformanceTotal: 0,
        activeHousingTotal: 0,
        activeAllowanceTotal: 0,
        retiredHousingTotal: 0,
        retiredBackpayTotal: 0,
        retiredActualPayTotal: 0,
        otherActualPayTotal: 0,
        actualPayTotal: 0,
        traffic002Total: 0,
        message: error instanceof Error ? error.message : String(error)
      }
    })
  }

  let planUnit = { name: '', code: '' }
  try {
    const unit = await window.salaryApi.getUnitSettings()
    planUnit = { name: (unit.unitFullName || '').trim(), code: (unit.unitImportCode || '').trim() }
  } catch (error) {
    console.warn('读取单位设置失败，人员经费录入暂不按单位过滤', error)
  }
  let salaryPlanInputScript = buildSalaryPlanInputScript({ showPageButton: true, unit: planUnit })
  try {
    const prefill = await window.salaryApi.getPersonnelExpensePlanPrefill({ archive: false })
    salaryPlanInputScript = buildSalaryPlanInputScript({ showPageButton: true, prefill, unit: planUnit })
  } catch (error) {
    console.warn('人员经费核对表读取失败，使用空预填配置', error)
  }

  const scripts = [
    { name: '凭证按钮', code: buildVoucherMergeScript({ autoStart: false }) },
    { name: '自动录入', code: buildAutoVoucherEntryScript({ autoStart: false }) },
    { name: '额度匹配', code: salaryQuotaMatchScript },
    { name: '人员经费录入', code: salaryPlanInputScript }
  ]

  let webContentsId: number
  try {
    webContentsId = wv.getWebContentsId()
  } catch (error) {
    console.warn('获取 webview webContentsId 失败，回退到顶层注入', error)
    for (const script of scripts) {
      try {
        await wv.executeJavaScript(script.code)
      } catch (e) {
        console.warn(`${script.name}注入失败`, e)
      }
    }
    return
  }

  for (const script of scripts) {
    try {
      const res = await window.salaryApi.execInAllPortalFrames(webContentsId, script.code)
      if (!res.ok) {
        console.warn(`${script.name}跨 frame 注入失败：`, res.reason)
      }
    } catch (error) {
      console.warn(`${script.name}注入失败`, error)
    }
    try {
      await wv.executeJavaScript(script.code)
    } catch (error) {
      console.warn(`${script.name}顶层注入失败`, error)
    }
  }
}

// ---------------------------------------------------------------------------
// 工资导出
// ---------------------------------------------------------------------------
async function exportSalary(): Promise<void> {
  const wv = activeWebview()
  if (!wv) {
    ElMessage.warning('一体化页面尚未就绪')
    return
  }
  if (salaryExporting.value) return
  salaryExporting.value = true

  // 读单位设置里的工资类别 + 单位名（用于过滤多单位场景）
  type SaltypeInput = { saltype_id: string; saltype_name: string; onlyFirstBatch?: boolean }
  let saltypes: SaltypeInput[] = []
  let filterUnitName = ''
  let filterUnitCode = ''
  try {
    const unit = await window.salaryApi.getUnitSettings()
    saltypes = ((unit.salaryExportSaltypes || []) as SaltypeInput[]).filter(
      (s) => s.saltype_id && s.saltype_name
    )
    filterUnitName = (unit.unitFullName || '').trim()
    filterUnitCode = (unit.unitImportCode || '').trim()
  } catch (error) {
    salaryExporting.value = false
    ElMessage.error(`读取单位设置失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!saltypes.length) {
    salaryExporting.value = false
    ElMessage.warning('未配置任何工资类别，请到系统设置 → 单位信息 → 一体化工资导出维护')
    return
  }

  // v5：不再用 cookie 读 belongOrgId（某些账号 belongOrgId=0 不可信）
  // 脚本内部走 getAllAgencyHN 自动发现单位，多单位天然支持；同时按 unitFullName 过滤
  let result: SalaryExportScriptResult | null = null
  try {
    result = (await wv.executeJavaScript(
      buildSalaryExportScript({ saltypes, filterUnitName, filterUnitCode })
    )) as SalaryExportScriptResult
  } catch (error) {
    salaryExporting.value = false
    ElMessage.error(error instanceof Error ? error.message : '导出脚本执行失败')
    return
  }

  if (!result || !result.ok) {
    const msg = (result && !result.ok && result.error) || '未知错误'
    ElMessage.error(`导出失败：${msg}`)
    salaryExporting.value = false
    return
  }

  const fmtCombo = (x: {
    agency?: string
    saltype?: string
    salbatch?: string
  }): string => `${x.agency || ''} / ${x.saltype || ''} / ${x.salbatch || ''}`

  if (!result.files.length) {
    const note =
      result.skipped.length || result.failed.length
        ? `本次没有可导出的工资数据（尝试了 ${result.skipped.length + result.failed.length} 个组合）`
        : '没有可导出的组合'
    ElMessage.warning(note)
    await wv.executeJavaScript(buildSalaryExportFeedbackScript(false, `⊘ ${note}`))
    salaryExporting.value = false
    return
  }

  const savedPaths: string[] = []
  const savedErrors: string[] = []
  for (const file of result.files) {
    try {
      const saveRes = await window.salaryApi.saveSalaryExportXls(file.filename, file.base64)
      const label = fmtCombo(file)
      if (saveRes.ok) savedPaths.push(`${label}：${saveRes.path}`)
      else savedErrors.push(`${label}：${saveRes.reason}`)
    } catch (error) {
      savedErrors.push(
        `${fmtCombo(file)}：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const summaryLines: string[] = []
  const realFailed = result.failed.length + savedErrors.length
  summaryLines.push(
    `✅ 落盘 ${savedPaths.length} 个` +
      (result.skipped.length ? `（已自动跳过 ${result.skipped.length} 个无数据组合）` : '') +
      (realFailed ? ` / ❗ 失败 ${realFailed}` : '')
  )
  if (savedPaths.length) {
    summaryLines.push('已入库：')
    savedPaths.forEach((p) => summaryLines.push('  • ' + p))
  }
  // 不再展开跳过细节 —— "没数据自动跳"是预期行为，不打扰
  if (result.failed.length) {
    summaryLines.push('失败：')
    result.failed.forEach((f) => summaryLines.push(`  ✗ ${fmtCombo(f)}：${f.reason}`))
  }
  if (savedErrors.length) {
    summaryLines.push('落盘失败：')
    savedErrors.forEach((e) => summaryLines.push('  ✗ ' + e))
  }
  const summary = summaryLines.join('\n')

  if (savedPaths.length) ElMessage.success(`成功入库 ${savedPaths.length} 个组合`)
  if (savedErrors.length || result.failed.length) ElMessage.error('部分组合失败，详见浮窗')

  await wv.executeJavaScript(
    buildSalaryExportFeedbackScript(savedPaths.length > 0 && savedErrors.length === 0, summary)
  )
  salaryExporting.value = false
}

void nextTick(() => {
  // 占位：触发渲染后建立 ref 映射
})
</script>

<template>
  <section class="portal-page">
    <header class="portal-toolbar">
      <strong>一体化系统</strong>
      <span class="portal-url" :title="activeTab?.url">{{ activeTab?.url }}</span>
      <div class="portal-actions">
        <el-button :icon="Refresh" @click="reload">刷新</el-button>
        <el-button type="primary" @click="openSalaryPlanInput">人员经费录入</el-button>
        <el-button
          :icon="Download"
          :loading="salaryExporting"
          @click="exportSalary"
          >导出工资</el-button
        >
        <el-button :icon="Link" @click="openExternal">外部浏览器</el-button>
        <el-button @click="revealPushLogFolder">推送日志</el-button>
      </div>
    </header>

    <div class="portal-tabbar">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="portal-tab"
        :class="{ active: tab.id === activeTabId }"
        :title="tab.url"
        @click="activateTab(tab.id)"
      >
        <span v-if="tab.loading" class="portal-tab-spin" />
        <span class="portal-tab-title">{{ tab.title || '加载中…' }}</span>
        <button
          class="portal-tab-close"
          title="关闭标签"
          @click.stop="closeTab(tab.id)"
        >
          <el-icon><Close /></el-icon>
        </button>
      </div>
      <button class="portal-tab-add" title="新标签" @click="openHomeTab">
        <el-icon><Plus /></el-icon>
      </button>
    </div>

    <div class="portal-webview-host">
      <webview
        v-for="tab in tabs"
        :key="tab.id"
        :ref="bindWebview(tab.id)"
        class="portal-webview"
        :class="{ active: tab.id === activeTabId }"
        :src="tab.url"
        partition="persist:integrated-portal"
        allowpopups
        @dom-ready="onDomReady(tab.id)"
        @did-start-loading="onStartLoading(tab.id)"
        @did-finish-load="onFinishLoad(tab.id)"
        @did-frame-finish-load="onFrameFinishLoad(tab.id)"
        @did-navigate="handleDidNavigate(tab.id, $event)"
        @did-navigate-in-page="handleDidNavigate(tab.id, $event)"
        @page-title-updated="handlePageTitle(tab.id, $event)"
        @new-window="handleNewWindow(tab.id, $event)"
      />

      <div v-if="pushRunLog.length" class="push-log-panel" :class="{ collapsed: !pushPanelOpen }">
        <div class="push-log-header">
          <strong>推送过程</strong>
          <span class="push-log-spacer" />
          <button class="push-log-btn" title="复制全部日志" @click="copyPushLog">复制</button>
          <button class="push-log-btn" title="打开日志文件夹" @click="revealPushLogFolder">日志文件</button>
          <button class="push-log-btn" title="清空日志" @click="clearPushLog">清空</button>
          <button class="push-log-btn" @click="pushPanelOpen = !pushPanelOpen">
            {{ pushPanelOpen ? '收起' : '展开' }}
          </button>
        </div>
        <div v-show="pushPanelOpen" class="push-log-body">
          <div
            v-for="entry in pushRunLog"
            :key="entry.id"
            class="push-log-row"
            :class="'lvl-' + entry.level"
          >
            <span class="push-log-time">{{ pushLogTime(entry.ts) }}</span>
            <span class="push-log-run">#{{ entry.runId }}</span>
            <span class="push-log-phase">{{ entry.phase }}</span>
            <span class="push-log-msg">{{ entry.message }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.portal-page {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--surface);
}

.portal-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.portal-toolbar strong {
  color: var(--text);
  font-size: 14px;
}

.portal-url {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--text-3);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.portal-actions {
  display: flex;
  gap: 8px;
}

.portal-tabbar {
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  align-items: stretch;
  gap: 2px;
  padding: 4px 8px 0;
  background: var(--surface-2, #f4f4f5);
  border-bottom: 1px solid var(--border);
}

.portal-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.portal-tab:hover {
  background: rgba(0, 0, 0, 0.04);
}

.portal-tab.active {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}

.portal-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.portal-tab-spin {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid var(--text-3);
  border-top-color: transparent;
  border-radius: 50%;
  animation: portal-tab-spin 0.8s linear infinite;
}

@keyframes portal-tab-spin {
  to {
    transform: rotate(360deg);
  }
}

.portal-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-3);
  border-radius: 3px;
  cursor: pointer;
}

.portal-tab-close:hover {
  background: rgba(0, 0, 0, 0.08);
  color: var(--text);
}

.portal-tab-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 2px 0 0 4px;
  padding: 0;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-3);
  border-radius: 4px;
  cursor: pointer;
}

.portal-tab-add:hover {
  color: var(--text);
  border-color: var(--text-3);
}

.portal-webview-host {
  position: relative;
  flex: 1;
  min-height: 0;
}

.portal-webview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  visibility: hidden;
}

.portal-webview.active {
  visibility: visible;
  z-index: 1;
}

/* 推送过程日志面板：浮在 webview 右下角，让"切模块/等页面/上传/回写"每步可见。
   用 fixed 脱离 webview 的层叠上下文，确保盖在内嵌 webview 之上（与全局 toast 一致）。 */
.push-log-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: 420px;
  max-width: calc(100% - 32px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(28, 28, 30, 0.94);
  color: #f5f5f5;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.push-log-panel.collapsed {
  width: auto;
}

.push-log-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  background: rgba(255, 255, 255, 0.06);
}

.push-log-spacer {
  flex: 1;
}

.push-log-btn {
  padding: 2px 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
  background: transparent;
  color: #f5f5f5;
  font-size: 12px;
  cursor: pointer;
}

.push-log-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.push-log-body {
  max-height: 240px;
  padding: 6px 0;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.55;
}

.push-log-row {
  display: flex;
  gap: 8px;
  padding: 2px 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.push-log-time {
  flex: none;
  color: #9aa0a6;
  font-variant-numeric: tabular-nums;
}

.push-log-run {
  flex: none;
  color: #9aa0a6;
}

.push-log-phase {
  flex: none;
  min-width: 56px;
  color: #c0c6cc;
}

.push-log-msg {
  flex: 1;
  min-width: 0;
}

.push-log-row.lvl-ok .push-log-msg {
  color: #7ee2a8;
}

.push-log-row.lvl-warn .push-log-msg {
  color: #ffcf66;
}

.push-log-row.lvl-err .push-log-msg {
  color: #ff8a8a;
}
</style>
