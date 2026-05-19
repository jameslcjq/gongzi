<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Link, Refresh } from '@element-plus/icons-vue'
import { buildVoucherMergeScript } from '../integration/voucherMergeScript'

const portalUrl = 'http://172.24.147.202/portal/login'
type PortalWebview = HTMLElement & {
  executeJavaScript: (code: string) => Promise<unknown>
  getURL: () => string
  reload: () => void
}

const webviewRef = ref<PortalWebview | null>(null)
const currentUrl = ref(portalUrl)
const webviewReady = ref(false)

function reload(): void {
  webviewRef.value?.reload()
}

async function openExternal(): Promise<void> {
  try {
    await window.salaryApi.openIntegrationExternal(portalUrl)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '外部浏览器打开失败')
  }
}

function markWebviewReady(): void {
  webviewReady.value = true
  const url = webviewRef.value?.getURL?.()
  if (url) currentUrl.value = url
  void installVoucherButton()
}

function markWebviewLoading(): void {
  webviewReady.value = false
}

function updateCurrentUrl(): void {
  const url = webviewRef.value?.getURL?.()
  if (url) currentUrl.value = url
}

async function installVoucherButton(): Promise<void> {
  if (!webviewRef.value) return

  try {
    await webviewRef.value.executeJavaScript(buildVoucherMergeScript({ autoStart: false }))
  } catch (error) {
    console.warn('一体化凭证按钮注入失败', error)
  }
}
</script>

<template>
  <section class="portal-page">
    <header class="portal-toolbar">
      <strong>一体化系统</strong>
      <span>{{ currentUrl }}</span>
      <div class="portal-actions">
        <el-button :icon="Refresh" @click="reload">刷新</el-button>
        <el-button :icon="Link" @click="openExternal">外部浏览器</el-button>
      </div>
    </header>

    <webview
      ref="webviewRef"
      class="portal-webview"
      :src="portalUrl"
      partition="persist:integrated-portal"
      allowpopups
      @dom-ready="markWebviewReady"
      @did-start-loading="markWebviewLoading"
      @did-finish-load="markWebviewReady"
      @did-navigate="updateCurrentUrl"
      @did-navigate-in-page="updateCurrentUrl"
    />
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

.portal-toolbar span {
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

.portal-webview {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
}
</style>
