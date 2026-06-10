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
import {
  buildBudgetProjectCodeScript,
  type BudgetProjectCodeResult
} from '../integration/budgetProjectCodeScript'
import { buildSalaryQuotaMatchScript } from '../integration/salaryQuotaMatchScript'
import { buildSalarySendReviewScript } from '../integration/salarySendReviewScript'
import { buildSalarySystemImportScript } from '../integration/salarySystemImportScript'
// 预算 xls 改成被动模式：用户在内网手动点导出，文件按"人员信息"名字拦截 → 预览确认后入库
import { buildPushInsuranceScript } from '../integration/pushInsuranceScript'
import { buildPushVoucherScript } from '../integration/pushVoucherScript'
import {
  pendingPushAutomation,
  pendingPushQueue,
  pushInProgress,
  type PushQueueAutomation,
  type PushStep
} from '../integration/insurancePushQueue'
import { appendPushLogLine, openPushLogFolder } from '../integration/pushLogger'
import { internalToolsEnabled } from '../internalToolsMode'
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
import type {
  BudgetImportResult,
  MonthlyPayrollPushStatus,
  MonthlyPayrollPushTarget,
  MonthlyPayrollRun,
  SalaryQuotaMatchLocalSummary,
  UnitSettings
} from '@shared/types'
import { isRunnerFlavor } from '@shared/appFlavor'
import { PORTAL_HOST } from '@shared/portalHost'
import {
  assemblePushSteps,
  canPushAll,
  confirmPushTargets,
  enqueueIntegratedPush,
  historyPushLabel,
  pushTargetsForRow
} from '../integration/integratedPushController'
import { importExchangePackageInteractive } from '../integration/exchangePackageImport'
import {
  archiveRunInteractive,
  buildReceiptInteractive,
  canArchiveRun
} from '../integration/monthlyRunLifecycle'

const portalUrl = `http://${PORTAL_HOST}/portal/login`
const showInternalTools = internalToolsEnabled

// ===== 内网执行端：一体化工具栏直接推送 =====
// 以"当前任务（已导入的报账记录）"为上下文，复用工资业务页同款组装逻辑（integratedPushController）。
// 仅 runner 版渲染相关工具栏，完整版原有推送路径不受影响。
const runnerTasks = ref<MonthlyPayrollRun[]>([])
const currentRunnerTaskId = ref<number | null>(null)
const runnerTasksLoading = ref(false)
const runnerPushing = ref(false)
const runnerImporting = ref(false)
const runnerArchiving = ref(false)
const runnerReceiptBuilding = ref(false)

async function runnerImportPackage(): Promise<void> {
  runnerImporting.value = true
  try {
    if (await importExchangePackageInteractive()) {
      await loadRunnerTasks()
    }
  } finally {
    runnerImporting.value = false
  }
}

async function runnerArchive(): Promise<void> {
  const row = currentRunnerTask.value
  if (!row) {
    ElMessage.warning('请先选择当前任务')
    return
  }
  runnerArchiving.value = true
  try {
    if (await archiveRunInteractive(row)) await loadRunnerTasks()
  } finally {
    runnerArchiving.value = false
  }
}

async function runnerBuildReceipt(): Promise<void> {
  const row = currentRunnerTask.value
  if (!row) {
    ElMessage.warning('请先选择当前任务')
    return
  }
  runnerReceiptBuilding.value = true
  try {
    await buildReceiptInteractive(row)
    await loadRunnerTasks()
  } finally {
    runnerReceiptBuilding.value = false
  }
}
const currentRunnerTask = computed(
  () => runnerTasks.value.find((task) => task.id === currentRunnerTaskId.value) ?? null
)

async function loadRunnerTasks(): Promise<void> {
  runnerTasksLoading.value = true
  try {
    const runs = await window.salaryApi.listMonthlyPayrollRuns()
    runnerTasks.value = runs.filter((run: MonthlyPayrollRun) => !run.isOutdated)
    if (
      currentRunnerTaskId.value === null ||
      !runnerTasks.value.some((task) => task.id === currentRunnerTaskId.value)
    ) {
      currentRunnerTaskId.value = runnerTasks.value[0]?.id ?? null
    }
  } catch (error) {
    ElMessage.error('加载任务列表失败：' + (error instanceof Error ? error.message : String(error)))
  } finally {
    runnerTasksLoading.value = false
  }
}

async function runnerPush(targets: MonthlyPayrollPushTarget[]): Promise<void> {
  const row = currentRunnerTask.value
  if (!row) {
    ElMessage.warning('请先选择当前任务')
    return
  }
  if (!targets.length) {
    ElMessage.warning('该任务没有可推送的文件')
    return
  }
  if (pushInProgress.value || pendingPushQueue.value.length > 0) {
    ElMessage.warning('正在推送中，请等待当前推送完成后再试')
    return
  }
  if (!(await confirmPushTargets(row, targets))) return
  runnerPushing.value = true
  try {
    const label = historyPushLabel(row)
    const { steps, stepHints } = await assemblePushSteps(row, targets, label)
    enqueueIntegratedPush(
      steps,
      stepHints,
      targets.length > 1 ? '全部推送' : '推送',
      targets.length > 1
        ? { mode: 'full-auto', label, runId: row.id, month: row.month }
        : undefined
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    setTimeout(() => {
      runnerPushing.value = false
    }, 800)
  }
}

function runnerPushAll(): void {
  const row = currentRunnerTask.value
  void runnerPush(row ? pushTargetsForRow(row) : [])
}

onMounted(() => {
  if (isRunnerFlavor) void loadRunnerTasks()
})

// 推送结束后刷新任务推送状态标签
watch(pushInProgress, (current, previous) => {
  if (previous && !current && isRunnerFlavor) void loadRunnerTasks()
})

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
  partition: string
  keySuffix?: PortalKeySuffix
  keyRole?: string
  keySerial?: string
  fixedKey?: boolean
}

type PortalKeySuffix = '0101' | '0201'

const businessKeySuffix: PortalKeySuffix = '0101'
const reviewKeySuffix: PortalKeySuffix = '0201'
const portalPartitionPrefix = window.salaryApi.appInstance.portalPartitionPrefix
const portalUnitCode = ref('')

function normalizePortalUnitCode(value?: string): string {
  const digits = String(value || '').replace(/\D/g, '')
  return digits.length > 6 ? digits.slice(0, 6) : digits
}

function portalKeySerial(suffix: PortalKeySuffix): string {
  return portalUnitCode.value ? `${portalUnitCode.value}-${suffix}` : suffix
}

function portalPartition(suffix: PortalKeySuffix): string {
  const unit = portalUnitCode.value || 'unit'
  return `persist:${portalPartitionPrefix}-${unit}-${suffix}`
}

function portalKeyRole(suffix: PortalKeySuffix): string {
  return suffix === businessKeySuffix ? '业务操作' : '审核'
}

function portalKeyTitle(suffix: PortalKeySuffix): string {
  return `${portalKeyRole(suffix)} ${portalKeySerial(suffix)}`
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

function buildPortalKeyTab(suffix: PortalKeySuffix): Tab {
  return {
    id: nextTabId(),
    title: portalKeyTitle(suffix),
    url: portalUrl,
    loading: true,
    partition: portalPartition(suffix),
    keySuffix: suffix,
    keyRole: portalKeyRole(suffix),
    keySerial: portalKeySerial(suffix),
    fixedKey: true
  }
}

function buildPortalKeyTabs(activeSuffix: PortalKeySuffix = businessKeySuffix): Tab[] {
  const suffixes: PortalKeySuffix[] =
    activeSuffix === reviewKeySuffix ? [businessKeySuffix, reviewKeySuffix] : [businessKeySuffix]
  return suffixes.map((suffix) => buildPortalKeyTab(suffix))
}

const tabs = ref<Tab[]>(buildPortalKeyTabs())
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

function isBusinessPartition(partition?: string): boolean {
  return partition === portalPartition(businessKeySuffix)
}

function findPortalKeyTabId(suffix: PortalKeySuffix): string | null {
  return tabs.value.find((tab) => tab.keySuffix === suffix)?.id || null
}

function openPortalKeyTab(suffix: PortalKeySuffix, makeActive = true): string {
  const existing = findPortalKeyTabId(suffix)
  if (existing) {
    if (makeActive) activeTabId.value = existing
    return existing
  }
  const tab = buildPortalKeyTab(suffix)
  tabs.value.push(tab)
  if (makeActive) activeTabId.value = tab.id
  return tab.id
}

async function ensurePortalKeyWebview(
  suffix: PortalKeySuffix,
  maxWait = 30000
): Promise<PortalWebview | undefined> {
  let tabId = findPortalKeyTabId(suffix)
  if (!tabId) {
    tabId = openPortalKeyTab(suffix, true)
  }
  if (!tabId) return undefined
  activateTab(tabId)
  return waitForWebview(tabId, maxWait)
}

async function ensureBusinessWebview(maxWait = 30000): Promise<PortalWebview | undefined> {
  return ensurePortalKeyWebview(businessKeySuffix, maxWait)
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

function openNewTab(
  url: string,
  makeActive = true,
  options: { partition?: string; title?: string; fixedKey?: boolean } = {}
): string {
  const id = nextTabId()
  tabs.value.push({
    id,
    title: options.title || '新页签',
    url,
    loading: true,
    partition: options.partition || activeTab.value?.partition || portalPartition('0101'),
    fixedKey: options.fixedKey
  })
  if (makeActive) activeTabId.value = id
  return id
}

function resetToPortalKeyTabs(activeSuffix: PortalKeySuffix = '0101'): void {
  webviewMap.clear()
  tabs.value = buildPortalKeyTabs(activeSuffix)
  const active = tabs.value.find((tab) => tab.keySuffix === activeSuffix) || tabs.value[0]
  activeTabId.value = active.id
}

function closeTab(id: string): void {
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx < 0) return
  if (tabs.value[idx].fixedKey) return
  webviewMap.delete(id)
  for (const target of ['budget', 'accounting'] as const) {
    if (pushTabIds[target] === id) delete pushTabIds[target]
  }
  if (tabs.value.length === 1) {
    // 不能没有标签，回到默认 0101 业务操作登录页。
    resetToPortalKeyTabs()
    return
  }
  tabs.value.splice(idx, 1)
  if (activeTabId.value === id) {
    const fallback = tabs.value[Math.max(0, idx - 1)] || tabs.value[0]
    activeTabId.value = fallback.id
  }
}

function openHomeTab(): void {
  openNewTab(portalUrl, true, { partition: activeTab.value?.partition })
}

async function loadPortalUnitSettings(): Promise<void> {
  let settings: UnitSettings | null = null
  try {
    settings = await window.salaryApi.getUnitSettings()
  } catch (error) {
    console.warn('读取单位设置失败，继续使用通用 Key 标签', error)
  }
  const nextCode = normalizePortalUnitCode(settings?.unitImportCode)
  if (!nextCode || nextCode === portalUnitCode.value) {
    refreshFixedKeyTabTitles()
    return
  }

  const activeSuffix = activeTab.value?.keySuffix || '0101'
  const onlyFixedKeyTabs = tabs.value.every((tab) => tab.fixedKey)
  portalUnitCode.value = nextCode
  if (onlyFixedKeyTabs) {
    resetToPortalKeyTabs(activeSuffix)
  } else {
    refreshFixedKeyTabTitles()
  }
}

function refreshFixedKeyTabTitles(): void {
  for (const tab of tabs.value) {
    if (!tab.fixedKey || !tab.keySuffix) continue
    tab.keySerial = portalKeySerial(tab.keySuffix)
    tab.keyRole = portalKeyRole(tab.keySuffix)
    tab.title = portalKeyTitle(tab.keySuffix)
    tab.partition = portalPartition(tab.keySuffix)
  }
}

// ---------------------------------------------------------------------------
// webview 事件
// ---------------------------------------------------------------------------
// 注：webview 标签的 @new-window 在带 allowpopups 时只是通知用，无法真正阻止默认弹窗。
// 我们改在主进程 setWindowOpenHandler 拦截、通过 IPC 推给宿主开新标签 —— 见 onMounted。

// 兼容：万一某些版本/路径还是触发了 @new-window，也把它接住
function onNewWindow(tabId: string, event: WebviewNewWindowEvent): void {
  event.preventDefault?.()
  if (shouldSuppressPopupTab()) {
    if (event.url && event.url !== 'about:blank') {
      logPush(currentPushRunId, 'info', '准备', `已拦截推送中弹出的新窗口（避免开一堆标签）：${String(event.url).slice(0, 100)}`)
    }
    return
  }
  if (event.url && event.url !== 'about:blank') {
    openNewTab(event.url, true, { partition: findTabById(tabId)?.partition })
  }
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
// 推送进度（面板顶部进度条用）：让用户点完按钮一跳过来就能看到"已经开始、第几步"
const pushTotalSteps = ref(0)
const pushCompletedSteps = ref(0)
const pushCurrentLabel = ref('')
const pushProgressPct = computed(() =>
  pushTotalSteps.value > 0
    ? Math.min(100, Math.round((pushCompletedSteps.value / pushTotalSteps.value) * 100))
    : 0
)
let pushRunSeq = 0
let pushLogSeq = 0
let currentPushRunId = 0
// 实时 console 流已为该 runId 落过脚本日志时，结束时就不再重复 dump trace
let liveTraceRunId = 0
// 推送期间（及结束后短暂宽限）抑制"弹窗转新标签"：自动化点门户菜单会被当成新窗口弹出，
// 而推送本身用页内 iframe 完成、并不需要这些弹窗，否则会开出一堆无用标签页。
let suppressPopupsUntil = 0
function shouldSuppressPopupTab(): boolean {
  return pushInProgress.value || Date.now() < suppressPopupsUntil
}

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
function logStepTrace(runId: number, kindLabel: string, trace: unknown, traceText?: unknown): void {
  // 兼容两种回传：数组 trace 或字符串 traceText（字符串通道对 executeJavaScript 序列化最稳）
  let lines: string[] = []
  if (Array.isArray(trace)) lines = trace.map((x) => String(x ?? ''))
  else if (typeof traceText === 'string') lines = traceText.split('\n')
  let any = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line) {
      logPush(runId, 'info', '脚本', `${kindLabel}｜${line}`)
      any = true
    }
  }
  // 脚本应有 trace 却一条没取到 → 留线索（便于发现"返回值里 trace 丢了"这类问题）
  if (!any && trace === undefined && traceText === undefined) {
    logPush(runId, 'warn', '脚本', `${kindLabel}｜未取到脚本内部 trace（返回值缺少 trace 字段）`)
  }
}

// 实时流（onConsoleMessage）已覆盖本轮脚本日志时跳过结束 dump，避免重复；否则用返回值兜底
function maybeLogStepTrace(runId: number, kindLabel: string, trace: unknown, traceText?: unknown): void {
  if (liveTraceRunId === runId) return
  logStepTrace(runId, kindLabel, trace, traceText)
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

// 单步失败后自动重试前的等待，给页面/iframe 一点"焐热"时间，把"第一遍常失败、第二遍就行"的冷启动自动化掉。
// 最多尝试 3 次（即首次 + 自动重试 2 次）。
const RETRY_DELAY_MS = 5000
const MAX_STEP_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer)
  })
}

// 轮询一句无害脚本，直到 webview 真正挂载且 dom-ready，注入才不会报
// "The WebView must be attached to the DOM and the dom-ready event emitted..."。
// 页面跳转/重定向期间 executeJavaScript 会抛错或卡住，这里逐次重试直到就绪或超时。
async function waitForWebviewReady(wv: PortalWebview, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await withTimeout(wv.executeJavaScript('1'), 3000, 'probe')
      return true
    } catch {
      await sleep(800)
    }
  }
  return false
}

async function execStepScript(
  wv: PortalWebview,
  code: string,
  label: string,
  timeoutMs = PUSH_SCRIPT_TIMEOUT_MS
): Promise<unknown> {
  // 先确保页面就绪，避免在页面跳转/重载途中注入而直接失败
  if (!(await waitForWebviewReady(wv, 60000))) {
    throw new Error(`${label}：一体化页面未就绪（webview 仍在加载/跳转），已停止本步`)
  }
  return withTimeout(
    wv.executeJavaScript(code),
    timeoutMs,
    `${label}脚本执行超时（${Math.round(timeoutMs / 1000)}s，可能页面发生跳转导致上下文丢失），已停止本步`
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
      traceText?: string
    }
    maybeLogStepTrace(runId, '保险', r?.trace, r?.traceText)
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
    )) as { ok: boolean; reason?: string; trace?: string[]; traceText?: string }
    maybeLogStepTrace(runId, '凭证', r?.trace, r?.traceText)
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
      maybeLogStepTrace(runId, name, r?.trace, r?.traceText)
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
    maybeLogStepTrace(runId, name, r?.trace, r?.traceText)
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
  return isBusinessPartition(tab.partition) && (tab.title || '') === moduleTabTitle(target)
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
    if (!(await waitForWebviewReady(wv, 30000))) {
      logPush(runId, 'warn', '切换模块', `「${name}」跳过：页面未就绪（webview 仍在加载/跳转），交给页面脚本自动导航`, name)
      return
    }
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
  if (!target) return ensureBusinessWebview(45000)

  let tabId = findModuleTabId(target)
  if (!tabId) {
    tabId = openNewTab(portalUrl, true, { partition: portalPartition(businessKeySuffix), title: moduleTabTitle(target) })
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

async function readAutomationUnit(): Promise<{ code: string; name: string }> {
  const unit = await window.salaryApi.getUnitSettings()
  return {
    code: (unit.unitImportCode || '').trim(),
    name: (unit.unitFullName || '').trim()
  }
}

async function runAutomationEntryStep(
  wv: PortalWebview,
  runId: number,
  sourceSteps: PushStep[]
): Promise<void> {
  if (!sourceSteps.some((step) => step.kind === 'insurance')) {
    throw new Error('本次全部推送没有保险数据，不能进入“自动录入保险数据”步骤。')
  }

  pushCurrentLabel.value = '自动录入'
  logPush(runId, 'info', '自动录入准备', '打开“直接支付外部数据”页面（页内 iframe 直达），准备接手自动录入')

  // 沿用推送同款“页内 iframe 直达”打开目标页，不再走门户菜单导航：
  // SmartFin 门户点“预算执行→集中支付”只会狂弹被拦截的新窗口、找不到“集中支付”而失败（见 630.log）；
  // 而保险推送已在该 iframe 内用同一 menuid 成功写库，证明 iframe 上下文可用，自动录入也能在其中完成。
  // 用可见 iframe（visibleFrame）便于用户观察；drainAllPortalFrames 会扫到该 iframe 并在其中启动自动录入。
  const openResult = (await execStepScript(
    wv,
    buildPushInsuranceScript([], { openOnly: true, forceReload: true, visibleFrame: true }),
    '打开直接支付外部数据',
    180000
  )) as { ok?: boolean; reason?: string; trace?: string[]; traceText?: string } | undefined
  maybeLogStepTrace(runId, '自动录入准备', openResult?.trace, openResult?.traceText)
  if (!openResult?.ok) {
    throw new Error(openResult?.reason || '未能打开“直接支付外部数据”页面')
  }

  logPush(runId, 'info', '自动录入', '开始自动录入保险数据')
  // 跨 frame 扫描偶发“命中 0 个”（直达 iframe 的 easyui 表格还没初始化好，自检窗口扑空）。
  // 这种 noFrameHit 情况下脚本没处理任何数据，重试是安全的：等几秒让表格渲染好再扫一次，最多 3 次。
  let result = await runAutoVoucherEntryInTargetFrame(wv, runId)
  maybeLogStepTrace(runId, '自动录入', result?.trace, result?.traceText)
  for (let attempt = 2; result && result.ok === false && result.noFrameHit && attempt <= 3; attempt++) {
    logPush(runId, 'warn', '自动录入', `未命中列表页，${Math.round(RETRY_DELAY_MS / 1000)} 秒后自动第 ${attempt} 次扫描（等表格渲染好）…`)
    await sleep(RETRY_DELAY_MS)
    result = await runAutoVoucherEntryInTargetFrame(wv, runId)
    maybeLogStepTrace(runId, '自动录入', result?.trace, result?.traceText)
  }

  if (!result?.ok) {
    throw new Error(`自动录入失败：${result?.message || '未知错误'}`)
  }
  const saved = Number(result.savedCount || 0)
  const skipped = Number(result.skippedCount || 0)
  if (saved <= 0) {
    throw new Error('自动录入没有保存任何数据，已停止自动送审。')
  }
  if (skipped > 0) {
    throw new Error(`自动录入存在 ${skipped} 条跳过数据，已停止自动送审，请人工复核。`)
  }

  logPush(runId, 'ok', '自动录入', `自动录入完成：保存 ${saved} 次，跳过 ${skipped} 条`)
  ElMessage.success(`自动录入完成：保存 ${saved} 次`)
}

async function runAutoVoucherEntryInTargetFrame(
  wv: PortalWebview,
  runId: number
): Promise<AutoVoucherEntryResult | undefined> {
  const frameScript = buildAutoVoucherEntryScript({
    autoStart: true,
    autoStartTargetOnly: true,
    showPageButton: false,
    requireRows: true,
    maxWaitTime: 120000
  })

  let webContentsId: number | null = null
  try {
    webContentsId = wv.getWebContentsId()
  } catch (error) {
    logPush(runId, 'warn', '自动录入', `获取页面 frame 信息失败，回退到顶层执行：${error instanceof Error ? error.message : String(error)}`)
  }

  if (webContentsId !== null && typeof window.salaryApi.drainAllPortalFrames === 'function') {
    const drained = await window.salaryApi.drainAllPortalFrames(webContentsId, frameScript)
    if (!drained.ok) {
      logPush(runId, 'warn', '自动录入', `跨 frame 启动失败，回退到顶层执行：${drained.reason}`)
    } else {
      const values = (drained.results as PortalFrameScriptResult[])
        .map((item: PortalFrameScriptResult): { frameUrl: string; value: AutoVoucherEntryFrameResult | null } => ({
          frameUrl: item.frameUrl,
          value: asAutoVoucherEntryFrameResult(item.value)
        }))
        .filter((item: { frameUrl: string; value: AutoVoucherEntryFrameResult | null }): item is { frameUrl: string; value: AutoVoucherEntryFrameResult } => Boolean(item.value))
      const started = values.filter((item: { frameUrl: string; value: AutoVoucherEntryFrameResult }) => !item.value.skipped)
      logPush(runId, 'info', '自动录入', `跨 frame 扫描 ${drained.results.length} 个页面，命中 ${started.length} 个直接支付列表页`)

      if (started.length > 0) {
        const chosen = started.find((item: { frameUrl: string; value: AutoVoucherEntryFrameResult }) => item.value.ok) ?? started[0]
        if (chosen.frameUrl) logPush(runId, 'info', '自动录入', `自动录入执行页面：${chosen.frameUrl}`)
        return chosen.value
      }

      const hints = values
        .map((item: { frameUrl: string; value: AutoVoucherEntryFrameResult }) => item.value.frameHref || item.frameUrl)
        .filter(Boolean)
        .slice(0, 5)
        .join('；')
      if (hints) logPush(runId, 'warn', '自动录入', `未命中直接支付列表页，已扫描页面：${hints}`)
      return {
        ok: false,
        noFrameHit: true,
        message: '已打开“直接支付外部数据”，但自动录入没有在任何 frame 中命中直接支付列表页。请刷新该页后重试。'
      }
    }
  }

  return (await execStepScript(
    wv,
    buildAutoVoucherEntryScript({
      autoStart: true,
      showPageButton: false,
      requireRows: true,
      maxWaitTime: 120000
    }),
    '自动录入',
    600000
  )) as AutoVoucherEntryResult | undefined
}

async function runAutomationSendReviewStep(
  wv: PortalWebview,
  runId: number,
  automation: PushQueueAutomation
): Promise<void> {
  pushCurrentLabel.value = '自动送审'
  logPush(runId, 'info', '自动送审', '读取系统设置单位和当月历史报表，准备自动匹配送审单位')

  const [localSummary, unit] = await Promise.all([
    window.salaryApi.getSalaryQuotaMatchLocalSummary(),
    readAutomationUnit()
  ])
  if (!unit.code) {
    throw new Error('系统设置中未配置单位编码，已停止自动送审。')
  }

  const result = (await execStepScript(
    wv,
    buildSalarySendReviewScript({
      localSummary,
      unit,
      month: automation.month,
      autoStart: true,
      headless: true,
      showPageButton: false,
      suppressAlert: true
    }),
    '自动送审',
    300000
  )) as SalarySendReviewResult | undefined
  maybeLogStepTrace(runId, '自动送审', result?.trace, result?.traceText)

  if (!result?.ok) {
    throw new Error(`自动送审失败：${result?.message || '未知错误'}`)
  }

  logPush(runId, 'ok', '自动送审', result.message || '自动送审完成')
  ElMessage.success('自动送审完成')
}

async function runFullAutomationAfterPush(
  wv: PortalWebview,
  runId: number,
  automation: PushQueueAutomation,
  sourceSteps: PushStep[]
): Promise<void> {
  logPush(runId, 'info', '流水线', `${automation.label}：推送已全部成功，开始后续自动录入和自动送审`)

  await runAutomationEntryStep(wv, runId, sourceSteps)
  pushCompletedSteps.value += 1
  await new Promise((r) => window.setTimeout(r, 1200))

  await runAutomationSendReviewStep(wv, runId, automation)
  pushCompletedSteps.value += 1
}

async function processPushQueue(): Promise<void> {
  // 推送串行执行；某一步失败则跳过该步、继续推其余，最后统一汇总成功/失败。
  if (processingPushQueue.value) return
  if (!pendingPushQueue.value.length) return
  processingPushQueue.value = true
  pushInProgress.value = true
  const runId = ++pushRunSeq
  currentPushRunId = runId
  try {
    const queuedSteps = pendingPushQueue.value.slice()
    const automation = pendingPushAutomation.value
    const isFullAutomation = automation?.mode === 'full-auto'
    const automationExtraSteps = isFullAutomation ? 2 : 0
    pushTotalSteps.value = queuedSteps.length + automationExtraSteps
    pushCompletedSteps.value = 0
    pushCurrentLabel.value = '启动中…'
    logPush(
      runId,
      'info',
      '准备',
      isFullAutomation
        ? `全自动流水线开始：推送 ${queuedSteps.length} 步 + 自动录入 + 自动送审`
        : `推送开始：共 ${queuedSteps.length} 步`
    )
    ElMessage.info(
      isFullAutomation
        ? `全自动流水线开始：推送 ${queuedSteps.length} 步后自动录入、自动送审`
        : `一体化推送开始：共 ${queuedSteps.length} 步`
    )

    logPush(runId, 'info', '等待页面', '等待 0101 业务操作 webview 就绪 …')
    const wv = await ensureBusinessWebview(45000)
    if (!wv) {
      logPush(runId, 'err', '等待页面', '0101 业务操作 webview 尚未就绪，推送任务已停止，请重新触发')
      ElMessage.error('0101 业务操作 webview 尚未就绪，推送任务已停止，请重新触发')
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

    if (isFullAutomation && !(await runPushPreflight(wv, queuedSteps))) {
      const msg = '推送前检测未通过，流水线已停止'
      logPush(runId, 'err', '停止', msg)
      ElMessage.error(msg)
      pendingPushQueue.value = []
      return
    }

    const succeeded: string[] = []
    const failed: { name: string; msg: string }[] = []
    let stoppedMessage = ''
    while (pendingPushQueue.value.length > 0) {
      const step = pendingPushQueue.value.shift() as PushStep
      const name = stepKindLabel(step)
      pushCurrentLabel.value = name
      try {
        await markPushStatus(step, 'queued')
        if (step.kind === 'salary-system-import') {
          logPush(runId, 'info', '上传', `${name}：后台接口推送，无需跳转页面`, '后台接口')
        } else {
          // 不再做外层模块切换：保险/凭证脚本内部会自己开模块并带 iframe 兜底；
          // 外层 ensureModuleTarget 只是重复点菜单，既慢（曾空耗 84-90s）又可能把页面切到导航中途、
          // 导致 webview 未就绪而整步失败。
          logPush(runId, 'info', '准备', `${name}：交由页面脚本自行导航到目标页（含 iframe 兜底）`)
        }
        // 自动重试：第一次常因页面/iframe 冷启动失败，等几秒重试，把"第二次才行"自动化
        let attempt = 0
        for (;;) {
          attempt++
          try {
            logPush(
              runId,
              'info',
              '上传',
              `${name}：开始执行${attempt > 1 ? `（自动第 ${attempt} 次）` : ''}（${stepDetail(step)}）`
            )
            await runOneStep(wv, step, runId)
            break
          } catch (stepError) {
            if (attempt >= MAX_STEP_ATTEMPTS) throw stepError
            const m = stepError instanceof Error ? stepError.message : String(stepError)
            logPush(
              runId,
              'warn',
              '上传',
              `${name}：第 ${attempt} 次未成功（${m}），${Math.round(RETRY_DELAY_MS / 1000)} 秒后自动重试 …`
            )
            await new Promise((r) => window.setTimeout(r, RETRY_DELAY_MS))
          }
        }
        await markPushStatus(step, 'success')
        logPush(runId, 'ok', '完成', `${name}：完成`)
        succeeded.push(name)
      } catch (error) {
        await markPushStatus(step, 'failed')
        const msg = error instanceof Error ? error.message : String(error)
        failed.push({ name, msg })
        stoppedMessage = isFullAutomation ? `${name}：推送失败，流水线已停止：${msg}` : ''
        logPush(
          runId,
          'err',
          '失败',
          isFullAutomation
            ? stoppedMessage
            : `${name}：推送失败，已跳过并继续推其余：${msg}`
        )
        // 失败时自动抓取门户结构快照（只读），便于在看不到内网页面时定位菜单/iframe 布局
        try {
          if (await waitForWebviewReady(wv, 15000)) {
            const diag = (await withTimeout(
              wv.executeJavaScript(buildPortalDiagnosticsScript()),
              15000,
              '门户结构诊断超时'
            )) as unknown
            logStepTrace(runId, '诊断', Array.isArray(diag) ? diag : [String(diag)])
          } else {
            logPush(runId, 'warn', '诊断', '页面未就绪，未能抓取门户结构（webview 仍在加载/跳转）')
          }
        } catch (diagError) {
          logPush(
            runId,
            'warn',
            '诊断',
            `抓取门户结构失败：${diagError instanceof Error ? diagError.message : String(diagError)}`
          )
        }
        if (isFullAutomation) {
          pendingPushQueue.value = []
          break
        }
      }
      pushCompletedSteps.value++
      // 步骤间隔，让浮窗状态可读
      await new Promise((r) => window.setTimeout(r, 1200))
    }
    if (stoppedMessage) {
      await ElMessageBox.alert(stoppedMessage, '全自动流水线停止', {
        type: 'error',
        confirmButtonText: '知道了'
      })
      return
    }
    if (isFullAutomation && automation) {
      try {
        await runFullAutomationAfterPush(wv, runId, automation, queuedSteps)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        logPush(runId, 'err', '停止', `全自动流水线停止：${msg}`)
        await ElMessageBox.alert(msg, '全自动流水线停止', {
          type: 'error',
          confirmButtonText: '知道了'
        })
        return
      }
      logPush(runId, 'ok', '完成', '全自动流水线完成：推送、自动录入、自动送审全部成功')
      ElMessage.success('全自动流水线完成')
      // 全流程（含自动送审）成功结束后，打开并切到 0201 审核标签页，供用户登录后审核。
      // openPortalKeyTab 会复用已存在的 0201 标签（没有则新建到登录页）；这是宿主主动开标签，
      // 不是 webview 弹窗，不受推送期间的 suppressPopupsUntil 影响。
      openPortalKeyTab(reviewKeySuffix, true)
      logPush(runId, 'info', '完成', '已打开 0201 审核标签页，请用审核 Key 登录后审核')
      ElMessage.info('已切换到 0201 审核标签页，请登录后审核')
      return
    }
    // 汇总：跳过失败项、继续推其余后，统一报告成功/失败
    if (failed.length === 0) {
      logPush(runId, 'ok', '完成', `一体化推送完成：全部 ${succeeded.length} 项成功`)
      ElMessage.success(`一体化推送完成：全部 ${succeeded.length} 项成功`)
    } else {
      logPush(
        runId,
        'warn',
        '完成',
        `推送结束：成功 ${succeeded.length} 项（${succeeded.join('、') || '无'}），失败 ${failed.length} 项（${failed.map((f) => f.name).join('、')}）`
      )
      void ElMessageBox.alert(
        [
          `成功 ${succeeded.length} 项：${succeeded.join('、') || '无'}`,
          '',
          `失败 ${failed.length} 项：`,
          ...failed.map((f) => `· ${f.name}：${f.msg}`),
          '',
          '可对失败项单独重新推送（失败原因见右下角面板/推送日志）。'
        ].join('\n'),
        '推送结果汇总',
        { type: succeeded.length === 0 ? 'error' : 'warning', confirmButtonText: '知道了' }
      )
    }
  } finally {
    processingPushQueue.value = false
    pushInProgress.value = false
    pendingPushAutomation.value = null
    // 再宽限 8 秒，拦住推送收尾后才迟到弹出的窗口
    suppressPopupsUntil = Date.now() + 8000
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

async function mountRecorderDevTools(): Promise<void> {
  if (stopRecorderDevTools || !showInternalTools.value) return
  await nextTick()
  const actions = document.querySelector<HTMLElement>('.portal-actions')
  if (!actions || !showInternalTools.value || stopRecorderDevTools) return
  const mod = await import('../integration/recorderDevTools')
  if (!showInternalTools.value || stopRecorderDevTools) return
  stopRecorderDevTools = mod.mountPortalRecorderDevTools({
    target: actions,
    activeWebview,
    webviews: () => Array.from(webviewMap.values()),
    api: window.salaryApi
  })
}

function unmountRecorderDevTools(): void {
  if (!stopRecorderDevTools) return
  stopRecorderDevTools()
  stopRecorderDevTools = null
}

onMounted(() => {
  void loadPortalUnitSettings()
  if (showInternalTools.value) void mountRecorderDevTools()
  watch(
    showInternalTools,
    (enabled) => {
      if (enabled) void mountRecorderDevTools()
      else unmountRecorderDevTools()
    }
  )
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
    let sourcePartition = activeTab.value?.partition
    for (const [id, wv] of webviewMap.entries()) {
      try {
        if (wv.getWebContentsId() === payload.sourceWebContentsId) {
          const sourceTab = findTabById(id)
          sourceTabTitle = sourceTab?.title || ''
          sourcePartition = sourceTab?.partition || sourcePartition
          break
        }
      } catch {}
    }
    if (shouldSuppressPopupTab()) {
      logPush(currentPushRunId, 'info', '准备', `已拦截推送中弹出的新窗口（避免开一堆标签）：${String(payload.url).slice(0, 100)}`)
      return
    }
    console.log(
      '[portal] 拦截弹窗，转新标签 ←',
      sourceTabTitle || payload.sourceWebContentsId,
      payload.url
    )
    openNewTab(payload.url, true, { partition: sourcePartition })
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
    unmountRecorderDevTools()
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
      if (title && !t.fixedKey) t.title = title
    } catch {}
  }
  void installPortalAutomationScripts(tabId)
}

function onStartLoading(tabId: string): void {
  const t = findTabById(tabId)
  if (t) t.loading = true
}

// 推送进行中，把推送脚本的 console 日志（[insurance-push]/[voucher-push]/[salary-system-import]）
// 实时转发到面板与日志文件——解决"推送中看不到进度、以为没在工作"。
// 自动化脚本日志前缀：这些 console 输出无论是否在推送流程中，都转发主进程落盘（R-07/A3），
// 现场排障不再依赖看不见的控制台。
const automationLogPrefixes = [
  '[salary-quota-match]',
  '[insurance-push]',
  '[voucher-push]',
  '[salary-system-import]',
  '[auto-voucher-entry]',
  '[salary-send-review]',
  '[salary-export]',
  '[voucher-merge]'
]
let webviewLogWindowStart = 0
let webviewLogWindowCount = 0

function forwardWebviewLogToDisk(raw: string, level: number): void {
  const isAutomation = automationLogPrefixes.some((prefix) => raw.startsWith(prefix))
  if (!isAutomation && level < 2) return
  // 限流：每分钟最多 200 行，防止异常页面刷屏写满磁盘
  const now = Date.now()
  if (now - webviewLogWindowStart > 60000) {
    webviewLogWindowStart = now
    webviewLogWindowCount = 0
  }
  if (webviewLogWindowCount >= 200) return
  webviewLogWindowCount += 1
  void window.salaryApi.appendAppLog('webview', raw.slice(0, 2000)).catch(() => {})
}

function onConsoleMessage(event: { message?: string; level?: number } | undefined): void {
  const rawForDisk = String(event?.message ?? '')
  if (rawForDisk) forwardWebviewLogToDisk(rawForDisk, Number(event?.level ?? 0))
  if (!processingPushQueue.value) return
  const raw = rawForDisk
  let label = ''
  if (raw.startsWith('[insurance-push]')) label = '保险'
  else if (raw.startsWith('[voucher-push]')) label = '凭证'
  else if (raw.startsWith('[salary-system-import]')) label = '工资'
  else if (raw.startsWith('[auto-voucher-entry]')) label = '自动录入'
  else if (raw.startsWith('[salary-send-review]')) label = '自动送审'
  else return
  const text = raw.replace(/^\[[^\]]+\]\s*/, '').trim()
  if (!text) return
  liveTraceRunId = currentPushRunId
  // 一体化返回里出现校验/失败提示时标黄，作为"状态提醒"，避免被绿色"完成"盖住
  const level: PushLogLevel = /校验失败|失败数|请到导入界面|导入日志里查看/.test(text)
    ? 'warn'
    : 'info'
  logPush(currentPushRunId, level, '脚本', `${label}｜${text}`)
}

function onFinishLoad(tabId: string): void {
  onDomReady(tabId)
}

function onPageTitleUpdated(
  tabId: string,
  event: { title?: string } | undefined
): void {
  const t = findTabById(tabId)
  if (t && event?.title && !t.fixedKey) t.title = event.title
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
  const wv = await ensureBusinessWebview(15000)
  if (!wv) {
    ElMessage.warning('0101 业务操作页面尚未就绪')
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
  | {
      ok: true
      response?: unknown
      agency?: { agency_name?: string }
      batchId?: string
      trace?: string[]
      traceText?: string
    }
  | { ok: false; message?: string; trace?: string[]; traceText?: string }

type AutoVoucherEntryResult =
  | { ok: true; message?: string; savedCount?: number; skippedCount?: number; trace?: string[]; traceText?: string }
  | { ok: false; message?: string; savedCount?: number; skippedCount?: number; noFrameHit?: boolean; trace?: string[]; traceText?: string }

type AutoVoucherEntryFrameResult = AutoVoucherEntryResult & {
  skipped?: boolean
  frameHref?: string
}

type PortalFrameScriptResult = {
  frameUrl: string
  value: unknown
}

function asAutoVoucherEntryFrameResult(value: unknown): AutoVoucherEntryFrameResult | null {
  if (!value || typeof value !== 'object') return null
  const maybe = value as { ok?: unknown }
  if (maybe.ok !== true && maybe.ok !== false) return null
  return value as AutoVoucherEntryFrameResult
}

type SalarySendReviewResult =
  | {
      ok: true
      message?: string
      batch001Total?: number
      batch002Total?: number
      trace?: string[]
      traceText?: string
    }
  | { ok: false; message?: string; trace?: string[]; traceText?: string }

// ---------------------------------------------------------------------------
// 一体化页面脚本注入（跨 frame）
// ---------------------------------------------------------------------------
async function installPortalAutomationScripts(tabId: string): Promise<void> {
  const tab = findTabById(tabId)
  if (tab && !isBusinessPartition(tab.partition)) return
  const wv = webviewMap.get(tabId)
  if (!wv) return

  let localSummary: SalaryQuotaMatchLocalSummary = {
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
    message: '尚未读取本地工资汇总'
  }
  // 内网执行端：明细表不在本机，改用当前任务交换包里打包带来的本地工资汇总。
  // 须先在工具栏选好当前任务；页面导航会自然重注入，切任务后再进额度匹配页即可刷新。
  const runnerBundledSummary = isRunnerFlavor ? currentRunnerTask.value?.quotaMatchLocalSummary : null
  if (runnerBundledSummary) {
    localSummary = runnerBundledSummary
  } else {
    try {
      localSummary = await window.salaryApi.getSalaryQuotaMatchLocalSummary()
    } catch (error) {
      console.warn('本地工资汇总读取失败，使用默认脚本配置', error)
      localSummary = {
        ...localSummary,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
  let planUnit = { name: '', code: '' }
  try {
    const unit = await window.salaryApi.getUnitSettings()
    planUnit = { name: (unit.unitFullName || '').trim(), code: (unit.unitImportCode || '').trim() }
  } catch (error) {
    console.warn('读取单位设置失败，人员经费录入暂不按单位过滤', error)
  }
  const salaryQuotaMatchScript = buildSalaryQuotaMatchScript({ autoStart: false, localSummary })
  const salarySendReviewScript = buildSalarySendReviewScript({
    localSummary,
    unit: planUnit
  })
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
    { name: '自动送审', code: salarySendReviewScript },
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
  const wv = await ensureBusinessWebview(15000)
  if (!wv) {
    ElMessage.warning('0101 业务操作页面尚未就绪')
    return
  }
  if (salaryExporting.value) return
  salaryExporting.value = true

  // 读单位名/编码用于过滤多单位场景；工资类别由脚本运行时自动发现。
  let filterUnitName = ''
  let filterUnitCode = ''
  try {
    const unit = await window.salaryApi.getUnitSettings()
    filterUnitName = (unit.unitFullName || '').trim()
    filterUnitCode = (unit.unitImportCode || '').trim()
  } catch (error) {
    salaryExporting.value = false
    ElMessage.error(`读取单位设置失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  // v5：不再用 cookie 读 belongOrgId（某些账号 belongOrgId=0 不可信）
  // 脚本内部走 getAllAgencyHN 自动发现单位，多单位天然支持；同时按 unitFullName 过滤
  let result: SalaryExportScriptResult | null = null
  try {
    result = (await wv.executeJavaScript(
      buildSalaryExportScript({ filterUnitName, filterUnitCode })
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

async function resolveBudgetProjectCodesFromPortal(): Promise<BudgetProjectCodeResult> {
  await loadPortalUnitSettings()
  const wv = await ensureBusinessWebview(30000)
  if (!wv) {
    return { ok: false, message: '0101 业务操作页面尚未就绪，请先打开“一体化系统”页签' }
  }
  try {
    if (!(await waitForWebviewReady(wv, 10000))) {
      return { ok: false, message: '0101 业务操作页面还在加载，请稍后重试' }
    }
    return (await withTimeout(
      wv.executeJavaScript(buildBudgetProjectCodeScript()),
      20000,
      '读取预算项目编码超时，请确认 0101 账号已登录'
    )) as BudgetProjectCodeResult
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '读取预算项目编码失败'
    }
  }
}

defineExpose({
  resolveBudgetProjectCodesFromPortal
})

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
        <el-button
          :icon="Download"
          :loading="salaryExporting"
          @click="exportSalary"
          >导出工资</el-button
        >
        <el-button v-if="showInternalTools" :icon="Link" @click="openExternal">外部浏览器</el-button>
        <el-button v-if="showInternalTools" @click="revealPushLogFolder">推送日志</el-button>
      </div>
    </header>

    <div v-if="isRunnerFlavor" class="portal-runner-bar">
      <el-button
        size="small"
        type="success"
        :icon="Download"
        :loading="runnerImporting"
        @click="runnerImportPackage"
        >导入交换包</el-button
      >
      <span class="portal-runner-sep" />
      <span class="portal-runner-label">当前任务</span>
      <el-select
        v-model="currentRunnerTaskId"
        size="small"
        class="portal-runner-select"
        placeholder="选择已导入的报账任务"
        :loading="runnerTasksLoading"
        no-data-text="暂无已导入任务，请先导入交换包"
      >
        <el-option
          v-for="task in runnerTasks"
          :key="task.id"
          :value="task.id"
          :label="historyPushLabel(task)"
        />
      </el-select>
      <el-button size="small" :icon="Refresh" :loading="runnerTasksLoading" @click="loadRunnerTasks">
        刷新
      </el-button>
      <span class="portal-runner-sep" />
      <el-button
        size="small"
        type="primary"
        :loading="runnerPushing"
        :disabled="!currentRunnerTask || pushInProgress || !canPushAll(currentRunnerTask)"
        @click="runnerPushAll"
        >全部推送</el-button
      >
      <el-button
        size="small"
        :disabled="!currentRunnerTask || pushInProgress || !currentRunnerTask.voucherImportPath"
        @click="runnerPush(['voucher'])"
        >凭证</el-button
      >
      <el-button
        size="small"
        :disabled="!currentRunnerTask || pushInProgress || !currentRunnerTask.insuranceImportPath"
        @click="runnerPush(['insurance'])"
        >保险</el-button
      >
      <el-button
        size="small"
        :disabled="
          !currentRunnerTask ||
          pushInProgress ||
          (!currentRunnerTask.salaryImportPath && !currentRunnerTask.payrollBackpayPath)
        "
        @click="runnerPush(['salary'])"
        >工资</el-button
      >
      <span class="portal-runner-sep" />
      <el-button
        size="small"
        type="warning"
        :loading="runnerArchiving"
        :disabled="!currentRunnerTask || pushInProgress || !canArchiveRun(currentRunnerTask)"
        @click="runnerArchive"
        >月结</el-button
      >
      <el-button
        size="small"
        :loading="runnerReceiptBuilding"
        :disabled="!currentRunnerTask || !currentRunnerTask.archivedAt"
        @click="runnerBuildReceipt"
        >生成回执</el-button
      >
    </div>

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
        <span v-if="tab.keyRole" class="portal-tab-key">{{ tab.keyRole }}</span>
        <span class="portal-tab-title">{{ tab.title || '加载中…' }}</span>
        <button
          v-if="!tab.fixedKey"
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
        :partition="tab.partition"
        allowpopups
        @dom-ready="onDomReady(tab.id)"
        @console-message="onConsoleMessage($event)"
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
        <div v-if="pushTotalSteps > 0" class="push-progress">
          <div class="push-progress-text">
            {{ pushInProgress ? '推送中' : '推送结束' }}
            {{ pushCompletedSteps }}/{{ pushTotalSteps }}{{ pushCurrentLabel ? '：' + pushCurrentLabel : '' }}
          </div>
          <div class="push-progress-track">
            <div
              class="push-progress-fill"
              :class="{ done: !pushInProgress }"
              :style="{ width: pushProgressPct + '%' }"
            />
          </div>
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

.portal-runner-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2, #f4f4f5);
}

.portal-runner-label {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.portal-runner-select {
  min-width: 280px;
}

.portal-runner-sep {
  flex: 0 0 1px;
  align-self: stretch;
  margin: 2px 6px;
  background: var(--border);
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

.portal-tab-key {
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(64, 158, 255, 0.12);
  color: #1d63b7;
  font-size: 12px;
  line-height: 18px;
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

.push-progress {
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.push-progress-text {
  font-size: 12px;
  margin-bottom: 6px;
  color: #ffd27a;
}

.push-progress-track {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.push-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: #409eff;
  transition: width 0.3s ease;
}

.push-progress-fill.done {
  background: #67c23a;
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
