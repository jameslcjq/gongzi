<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Close, Download, Link, Plus, Refresh } from '@element-plus/icons-vue'
import { buildVoucherMergeScript } from '../integration/voucherMergeScript'
import {
  buildSalaryExportScript,
  buildSalaryExportFeedbackScript
} from '../integration/salaryExportScript'
import {
  buildOpenSalaryPlanInputScript,
  buildSalaryPlanInputScript
} from '../integration/salaryPlanInputScript'

const portalUrl = 'http://172.24.147.202/portal/login'

type SalaryExportFile = {
  filename: string
  base64: string
  size: number
  saltype: string
  salbatch: string
}
type SalaryExportSkip = { saltype: string; salbatch: string; reason: string }
type SalaryExportFail = { saltype: string; salbatch: string; reason: string }
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
  loadURL?: (url: string) => Promise<void>
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
function onNewWindow(tabId: string, event: WebviewNewWindowEvent): void {
  // 阻止 Electron 默认弹外部窗口，把新页面放进新标签
  event.preventDefault?.()
  if (event.url && event.url !== 'about:blank') {
    openNewTab(event.url)
  }
  // 静默吞掉 about:blank 等空地址
  void tabId
}

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

  try {
    const result = (await wv.executeJavaScript(
      buildOpenSalaryPlanInputScript()
    )) as SalaryPlanInputOpenResult
    if (!result?.ok) {
      ElMessage.warning(result?.message || '请先进入“一般用款计划录入”的待录入列表页')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '人员经费录入弹窗打开失败')
  }
}

// ---------------------------------------------------------------------------
// 一体化页面脚本注入（跨 frame）
// ---------------------------------------------------------------------------
async function installPortalAutomationScripts(tabId: string): Promise<void> {
  const wv = webviewMap.get(tabId)
  if (!wv) return

  const scripts = [
    { name: '凭证按钮', code: buildVoucherMergeScript({ autoStart: false }) },
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

  // 读单位设置里的导出组合
  let targets
  try {
    const unit = await window.salaryApi.getUnitSettings()
    targets = unit.salaryExportTargets
  } catch (error) {
    salaryExporting.value = false
    ElMessage.error(`读取单位设置失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!targets || !targets.length) {
    salaryExporting.value = false
    ElMessage.warning('未配置任何"类别+批次"组合，请到系统设置 → 单位信息里维护')
    return
  }

  let result: SalaryExportScriptResult | null = null
  try {
    result = (await wv.executeJavaScript(
      buildSalaryExportScript({ targets })
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

  if (!result.files.length) {
    const skipNote = result.skipped.length
      ? result.skipped
          .map((s) => `${s.saltype} / ${s.salbatch}：${s.reason}`)
          .join('\n')
      : '没有可导出的组合'
    ElMessage.warning(skipNote)
    await wv.executeJavaScript(buildSalaryExportFeedbackScript(false, `⊘ ${skipNote}`))
    salaryExporting.value = false
    return
  }

  const savedPaths: string[] = []
  const savedErrors: string[] = []
  for (const file of result.files) {
    try {
      const saveRes = await window.salaryApi.saveSalaryExportXls(file.filename, file.base64)
      const label = `${file.saltype} / ${file.salbatch}`
      if (saveRes.ok) savedPaths.push(`${label}：${saveRes.path}`)
      else savedErrors.push(`${label}：${saveRes.reason}`)
    } catch (error) {
      savedErrors.push(
        `${file.saltype} / ${file.salbatch}：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  const summaryLines: string[] = []
  summaryLines.push(
    `✅ 落盘 ${savedPaths.length} 个 / 跳过 ${result.skipped.length} / 失败 ${
      result.failed.length + savedErrors.length
    }`
  )
  if (savedPaths.length) {
    summaryLines.push('已入库：')
    savedPaths.forEach((p) => summaryLines.push('  • ' + p))
  }
  if (result.skipped.length) {
    summaryLines.push('跳过：')
    result.skipped.forEach((s) =>
      summaryLines.push(`  ⊘ ${s.saltype} / ${s.salbatch}：${s.reason}`)
    )
  }
  if (result.failed.length) {
    summaryLines.push('失败：')
    result.failed.forEach((f) =>
      summaryLines.push(`  ✗ ${f.saltype} / ${f.salbatch}：${f.reason}`)
    )
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
