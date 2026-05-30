<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Close,
  Download,
  Link,
  Money,
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
import {
  buildAutoVoucherEntryScript,
  buildStartAutoVoucherEntryScript
} from '../integration/autoVoucherEntryScript'
import {
  buildSalaryQuotaMatchScript,
  buildStartSalaryQuotaMatchScript
} from '../integration/salaryQuotaMatchScript'
import { buildSalarySystemImportScript } from '../integration/salarySystemImportScript'
// 预算 xls 改成被动模式：用户在内网手动点导出，文件按"人员信息"名字拦截 → 自动入库
import { buildPushInsuranceScript } from '../integration/pushInsuranceScript'
import { buildPushVoucherScript } from '../integration/pushVoucherScript'
import { pendingPushQueue, type PushStep } from '../integration/insurancePushQueue'

const portalUrl = 'http://172.24.147.202/portal/login'
const salaryGiveOutUrl =
  'http://172.24.147.202/salary-pro-web/grp/salaryNanJ/html/audit/salaryGiveOut/salSalaryAuditSCZF.html?menuid=c2745ee50aba4be1a31742d37274990d&moduleid=c2745ee50aba4be1a31742d37274990d&myMenuid=2020120628499'

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
const autoVoucherEntryRunning = ref(false)
// 预算 xls 改成被动模式：不再有 toolbar 按钮、不模拟点击、不自动跳转。
// 用户在内网手动点系统的导出按钮 → main 进程 will-download 按文件名 "人员信息"
// 判定为预算文件 → 落入 预算导出/ 子目录 → 立即调 budgetExcelImport 入库。

const activeTab = computed<Tab | undefined>(() =>
  tabs.value.find((t) => t.id === activeTabId.value)
)
function activeWebview(): PortalWebview | undefined {
  return webviewMap.get(activeTabId.value)
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
let stopBudgetImportListener: (() => void) | null = null
let stopRecorderDevTools: (() => void) | null = null
// 保险/凭证推送队列：MonthlyPayrollPage 把多步任务塞进 pendingPushQueue，
// 这里串行处理，每步在 active webview 上跑对应注入脚本
const processingPushQueue = ref(false)

async function runOneStep(wv: PortalWebview, step: PushStep): Promise<void> {
  if (step.kind === 'insurance') {
    ElMessage.info(`【保险】开始：${step.label}（${step.records.length} 条）`)
    const r = (await wv.executeJavaScript(buildPushInsuranceScript(step.records))) as {
      ok: boolean
      reason?: string
      recordCount?: number
    }
    if (r?.ok) {
      ElMessage.success(`✅ 保险已推送 ${r.recordCount} 条 / ${step.label}`)
    } else {
      ElMessage.error(`❌ 保险推送失败：${r?.reason || '未知错误'}`)
    }
  } else if (step.kind === 'voucher') {
    ElMessage.info(`【凭证】开始：${step.label}（${step.fileName}）`)
    const r = (await wv.executeJavaScript(
      buildPushVoucherScript(step.fileName, step.fileBase64, step.label)
    )) as { ok: boolean; reason?: string }
    if (r?.ok) {
      ElMessage.success(`✅ 凭证已导入 / ${step.label}`)
    } else {
      ElMessage.error(`❌ 凭证推送失败：${r?.reason || '未知错误'}`)
    }
  } else if (step.kind === 'salary-system-import') {
    const name = step.mode === 'backpay' ? '补发工资' : '工资导入'
    ElMessage.info(`【${name}】开始：${step.label}（${step.fileName}）`)
    let filterUnitName = ''
    try {
      const unit = await window.salaryApi.getUnitSettings()
      filterUnitName = (unit.unitFullName || '').trim()
    } catch (error) {
      console.warn('读取单位设置失败，继续由一体化单位列表判断', error)
    }
    const r = (await wv.executeJavaScript(
      buildSalarySystemImportScript({
        mode: step.mode,
        file: {
          fileName: step.fileName,
          base64: step.fileBase64,
          size: step.fileSize
        },
        filterUnitName,
        month: step.month
      })
    )) as SalarySystemImportResult | undefined
    if (r?.ok) {
      ElMessage.success(`✅ ${name}已导入 / ${step.label}`)
    } else {
      ElMessage.error(`❌ ${name}失败：${r?.message || '未知错误'}`)
    }
  }
}

async function processPushQueue(): Promise<void> {
  if (processingPushQueue.value) return
  if (!pendingPushQueue.value.length) return
  processingPushQueue.value = true
  try {
    const wv = activeWebview()
    if (!wv) {
      ElMessage.error('一体化 webview 尚未就绪，推送任务已丢弃，请重新触发')
      pendingPushQueue.value = []
      return
    }
    while (pendingPushQueue.value.length > 0) {
      const step = pendingPushQueue.value.shift() as PushStep
      try {
        await runOneStep(wv, step)
      } catch (error) {
        ElMessage.error(
          `执行 ${step.kind} 步骤异常：${error instanceof Error ? error.message : String(error)}`
        )
        // 出错继续做后面的步骤
      }
      // 步骤间隔，让浮窗状态可读
      await new Promise((r) => window.setTimeout(r, 1200))
    }
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
  stopBudgetImportListener = window.salaryApi.onBudgetImportDone(
    (payload: {
      ok: boolean
      savedPath: string
      totalInserted?: number
      totalUpdated?: number
      totalSkipped?: number
      sheets?: Array<{
        sheetName: string
        worksheetName: string
        inserted: number
        updated: number
        skipped: number
        status: string
        message?: string
      }>
      message?: string
    }) => {
      if (payload.ok) {
        const lines = (payload.sheets || [])
          .filter((s) => s.inserted + s.updated > 0)
          .map((s) => `  • ${s.worksheetName}: 新增 ${s.inserted} / 更新 ${s.updated}`)
        ElMessage.success({
          message:
            `✅ 预算 xls 入库完成：插入 ${payload.totalInserted || 0}，更新 ${payload.totalUpdated || 0}\n` +
            (lines.length ? lines.join('\n') : '（所有 sheet 为空或无新增）'),
          duration: 10000
        })
      } else {
        ElMessage.error(`预算入库失败：${payload.message || '未知错误'}`)
      }
    }
  )

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
        ElMessage.success(
          `预算 xls 已存档：${payload.savedPath}；正在自动入库...`
        )
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
  if (stopBudgetImportListener) {
    stopBudgetImportListener()
    stopBudgetImportListener = null
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

  await installPortalAutomationScripts(activeTabId.value)

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
    const result = (await wv.executeJavaScript(
      buildOpenSalaryPlanInputScript(prefill)
    )) as SalaryPlanInputOpenResult
    if (!result?.ok) {
      ElMessage.warning(result?.message || '请先进入“一般用款计划录入”的待录入列表页')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '人员经费录入弹窗打开失败')
  }
}

async function startAutoVoucherEntry(): Promise<void> {
  const wv = activeWebview()
  if (!wv) {
    ElMessage.warning('一体化页面尚未就绪')
    return
  }
  if (autoVoucherEntryRunning.value) return
  autoVoucherEntryRunning.value = true

  try {
    await installPortalAutomationScripts(activeTabId.value)
    const result = (await wv.executeJavaScript(buildStartAutoVoucherEntryScript())) as
      | { ok: true; savedCount?: number; skippedCount?: number }
      | { ok: false; message?: string; savedCount?: number; skippedCount?: number }
      | undefined

    if (result?.ok) {
      ElMessage.success(
        `自动录入完成：保存 ${result.savedCount || 0} 次，跳过 ${result.skippedCount || 0} 条`
      )
    } else {
      ElMessage.warning(result?.message || '请先进入“直接支付外部数据”的列表页')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '自动录入脚本执行失败')
  } finally {
    autoVoucherEntryRunning.value = false
  }
}

async function startSalaryQuotaMatch(): Promise<void> {
  const wv = activeWebview()
  if (!wv) {
    ElMessage.warning('一体化页面尚未就绪')
    return
  }

  await installPortalAutomationScripts(activeTabId.value)

  try {
    const localSummary = await window.salaryApi.getSalaryQuotaMatchLocalSummary()
    const quotaScript = buildSalaryQuotaMatchScript({ autoStart: false, localSummary })
    try {
      const webContentsId = wv.getWebContentsId()
      await window.salaryApi.execInAllPortalFrames(webContentsId, quotaScript)
    } catch (error) {
      console.warn('额度匹配本地汇总跨 frame 更新失败，回退到顶层注入', error)
    }
    await wv.executeJavaScript(quotaScript)

    const result = (await wv.executeJavaScript(buildStartSalaryQuotaMatchScript())) as {
      ok?: boolean
      code?: string
      message?: string
      matchedCount?: number
    }
    if (result?.ok) {
      ElMessage.success(`额度匹配完成${result.matchedCount ? `：${result.matchedCount} 项` : ''}`)
      return
    }

    if (result?.code === 'not-page') {
      openNewTab(salaryGiveOutUrl)
      ElMessage.info('已打开工资发放页面；页面加载后选中工资批次，再点“额度匹配”')
      return
    }

    ElMessage.warning(result?.message || '请先进入“工资发放/生成支付”的额度匹配页面')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '额度匹配脚本执行失败')
  }
}

type SalarySystemImportResult =
  | { ok: true; response?: unknown; agency?: { agency_name?: string }; batchId?: string }
  | { ok: false; message?: string }

// ---------------------------------------------------------------------------
// 一体化页面脚本注入（跨 frame）
// ---------------------------------------------------------------------------
async function installPortalAutomationScripts(tabId: string): Promise<void> {
  const wv = webviewMap.get(tabId)
  if (!wv) return

  const scripts = [
    { name: '凭证按钮', code: buildVoucherMergeScript({ autoStart: false }) },
    { name: '自动录入', code: buildAutoVoucherEntryScript({ autoStart: false }) },
    { name: '额度匹配', code: buildSalaryQuotaMatchScript({ autoStart: false }) },
    { name: '人员经费录入', code: buildSalaryPlanInputScript({ showPageButton: false }) }
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
  try {
    const unit = await window.salaryApi.getUnitSettings()
    saltypes = ((unit.salaryExportSaltypes || []) as SaltypeInput[]).filter(
      (s) => s.saltype_id && s.saltype_name
    )
    filterUnitName = (unit.unitFullName || '').trim()
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
      buildSalaryExportScript({ saltypes, filterUnitName })
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
        <el-button :icon="Money" type="warning" @click="startSalaryQuotaMatch">
          额度匹配
        </el-button>
        <el-button type="primary" @click="openSalaryPlanInput">人员经费录入</el-button>
        <el-button
          type="success"
          :loading="autoVoucherEntryRunning"
          @click="startAutoVoucherEntry"
          >自动录入</el-button
        >
        <el-button
          :icon="Download"
          :loading="salaryExporting"
          @click="exportSalary"
          >导出工资</el-button
        >
        <el-button :icon="Link" @click="openExternal">外部浏览器</el-button>
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
</style>
