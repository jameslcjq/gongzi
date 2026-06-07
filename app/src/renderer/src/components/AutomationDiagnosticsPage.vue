<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  AutomationCaptureResult,
  AutomationHelperStatus,
  AutomationKeyCandidateSummary,
  AutomationKeySwitchResult
} from '@shared/types'

const status = ref<AutomationHelperStatus | null>(null)
const result = ref<AutomationCaptureResult | null>(null)
const loadingStatus = ref(false)
const collecting = ref(false)
const activeAction = ref<string | null>(null)
const pinCode = ref('')
const lastSwitch = ref<AutomationKeySwitchResult | null>(null)

const keyCandidates = computed<AutomationKeyCandidateSummary[]>(() => {
  const next = result.value
  if (!next) return []

  const comboItems = uniqueStrings(next.combos?.flatMap((combo) => combo.items ?? []) ?? [])
  if (comboItems.length > 0) {
    return comboItems.map((text, index) => ({
      text,
      index,
      controlType: 'ComboBoxItem',
      source: 'ComboBox',
      isSelected: next.combos?.some((combo) => combo.name === text) ?? false,
      patterns: [],
      roleGuess: 'unknown',
      score: 90
    }))
  }

  const raw = next.keyCandidates ?? []
  const listItems = raw.filter((item) => item.controlType === 'ListItem' || item.score >= 60)
  return listItems.length > 0 ? listItems : raw
})

onMounted(() => {
  void refreshStatus()
})

async function refreshStatus(): Promise<void> {
  loadingStatus.value = true
  try {
    status.value = await window.salaryApi.getAutomationHelperStatus()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '读取采集助手状态失败')
  } finally {
    loadingStatus.value = false
  }
}

async function startCollect(): Promise<void> {
  try {
    await ElMessageBox.alert(
      '请在确认后 20 秒内点击一体化网页的登录按钮。采集助手只读取弹窗、下拉候选项和截图，不会点击“确定”。',
      '开始采集登录 Key 弹窗',
      { confirmButtonText: '开始采集' }
    )
  } catch {
    return
  }

  collecting.value = true
  try {
    const next = await window.salaryApi.collectIntegrationLoginKey()
    result.value = next
    if (next.ok) {
      const count = countRealKeyOptions(next)
      ElMessage.success(count > 0 ? `采集完成，读取到 ${count} 个候选 Key` : '采集完成')
    } else {
      ElMessage.warning(next.reason || next.errors[0] || '采集未完成')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '采集失败')
  } finally {
    collecting.value = false
    void refreshStatus()
  }
}

async function openDebugFolder(): Promise<void> {
  const err = await window.salaryApi.openAutomationDebugFolder()
  if (err) ElMessage.warning(err)
}

async function openPath(path?: string): Promise<void> {
  if (!path) return
  const err = await window.salaryApi.openLocalPath(path)
  if (err) ElMessage.warning(err)
}

async function switchKey(row: AutomationKeyCandidateSummary, confirm = false): Promise<void> {
  if (confirm && !pinCode.value.trim()) {
    ElMessage.warning('请输入 PIN 码')
    return
  }

  const actionId = `${row.text}:${confirm ? 'confirm' : 'switch'}`
  activeAction.value = actionId
  try {
    const next = await window.salaryApi.switchIntegrationLoginKey(row.text, row.index, {
      pin: confirm ? pinCode.value : undefined,
      confirm
    })
    lastSwitch.value = next
    if (next.ok) {
      applySwitchResult(next)
      ElMessage.success(confirm
        ? `已选择 ${next.selectedText || row.text} 并点击确定`
        : `已切换到 ${next.afterCurrentKey || next.selectedText || row.text}`)
    } else {
      ElMessage.warning(next.reason || next.errors[0] || '切换 Key 失败')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '切换 Key 失败')
  } finally {
    activeAction.value = null
  }
}

function applySwitchResult(next: AutomationKeySwitchResult): void {
  if (!result.value) return
  const currentKey = next.afterCurrentKey || next.selectedText
  const sourceCombos = next.combos?.length ? next.combos : result.value.combos
  const combos = sourceCombos?.map((combo, index) => (
    index === 0 && currentKey ? { ...combo, name: currentKey } : combo
  ))
  result.value = {
    ...result.value,
    matchedWindow: next.matchedWindow ?? result.value.matchedWindow,
    combos,
    keyCandidates: next.keyCandidates?.length ? next.keyCandidates : result.value.keyCandidates,
    warnings: uniqueStrings([...result.value.warnings, ...next.warnings]),
    errors: uniqueStrings([...result.value.errors, ...next.errors])
  }
}

function parentDir(path?: string): string | undefined {
  if (!path) return undefined
  const next = path.replace(/[\\/][^\\/]*$/, '')
  return next === path ? undefined : next
}

function roleText(role: string): string {
  if (role === 'operator') return '经办'
  if (role === 'reviewer') return '审核'
  return '未判断'
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)))
}

function countRealKeyOptions(next: AutomationCaptureResult): number {
  const comboItems = uniqueStrings(next.combos?.flatMap((combo) => combo.items ?? []) ?? [])
  if (comboItems.length > 0) return comboItems.length
  const raw = next.keyCandidates ?? []
  return raw.filter((item) => item.controlType === 'ListItem' || item.score >= 60).length || raw.length
}
</script>

<template>
  <div class="automation-page">
    <div class="settings-section">
      <h4>一体化登录 Key 采集</h4>
      <p>用于采集 Windows 原生 Key / 证书选择窗口，并可按候选项自动切换下拉框。</p>
      <div class="toolbar">
        <el-button type="primary" :loading="collecting" @click="startCollect">开始采集登录 Key 弹窗</el-button>
        <el-button :loading="loadingStatus" @click="refreshStatus">刷新状态</el-button>
        <el-button @click="openDebugFolder">打开诊断目录</el-button>
      </div>
    </div>

    <el-descriptions v-if="status" border size="small" :column="1">
      <el-descriptions-item label="助手状态">
        <el-tag :type="status.available ? 'success' : 'danger'">
          {{ status.available ? '已就绪' : '未找到' }}
        </el-tag>
        <span class="inline-path">{{ status.message }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="助手路径">{{ status.helperPath || '-' }}</el-descriptions-item>
      <el-descriptions-item label="诊断目录">{{ status.debugRoot }}</el-descriptions-item>
    </el-descriptions>

    <div v-if="result" class="result-panel">
      <div class="result-header">
        <h4>最近一次采集</h4>
        <div>
          <el-button size="small" :disabled="!result.captureDir" @click="openPath(result.captureDir)">打开本次目录</el-button>
          <el-button
            size="small"
            :disabled="!result.diagnosticZipPath"
            @click="openPath(parentDir(result.diagnosticZipPath))"
          >打开诊断包位置</el-button>
        </div>
      </div>

      <el-descriptions border size="small" :column="2">
        <el-descriptions-item label="结果">
          <el-tag :type="result.ok ? 'success' : 'warning'">{{ result.ok ? '完成' : '未完成' }}</el-tag>
          <span v-if="result.reason" class="inline-path">{{ result.reason }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="候选 Key">{{ keyCandidates.length }}</el-descriptions-item>
        <el-descriptions-item label="窗口标题">{{ result.matchedWindow?.title || '-' }}</el-descriptions-item>
        <el-descriptions-item label="进程">{{ result.matchedWindow?.processName || '-' }}</el-descriptions-item>
        <el-descriptions-item label="窗口类名">{{ result.matchedWindow?.className || '-' }}</el-descriptions-item>
        <el-descriptions-item label="HWND">{{ result.matchedWindow?.hwnd || '-' }}</el-descriptions-item>
        <el-descriptions-item label="本次目录" :span="2">{{ result.captureDir || '-' }}</el-descriptions-item>
        <el-descriptions-item label="诊断包" :span="2">{{ result.diagnosticZipPath || '-' }}</el-descriptions-item>
      </el-descriptions>

      <div v-if="keyCandidates.length" class="pin-row">
        <el-input
          v-model="pinCode"
          type="password"
          show-password
          placeholder="PIN 码"
          maxlength="64"
          class="pin-input"
        />
      </div>

      <el-table v-if="keyCandidates.length" :data="keyCandidates" border size="small" height="220">
        <el-table-column prop="index" label="#" width="60" />
        <el-table-column prop="text" label="候选 Key 文本" min-width="280" show-overflow-tooltip />
        <el-table-column label="当前选中" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.isSelected" size="small" type="success">是</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="90">
          <template #default="{ row }">{{ roleText(row.roleGuess) }}</template>
        </el-table-column>
        <el-table-column prop="score" label="评分" width="80" align="right" />
        <el-table-column prop="source" label="来源" width="130" />
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              :loading="activeAction === `${row.text}:switch`"
              @click="switchKey(row)"
            >切换</el-button>
            <el-button
              size="small"
              type="primary"
              :loading="activeAction === `${row.text}:confirm`"
              @click="switchKey(row, true)"
            >登录</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-alert
        v-if="lastSwitch"
        type="success"
        :closable="false"
        show-icon
        :title="lastSwitch.ok
          ? `最近执行：${lastSwitch.beforeCurrentKey || '-'} -> ${lastSwitch.afterCurrentKey || lastSwitch.selectedText || '-'}${lastSwitch.confirmed ? '，已确定' : ''}`
          : `最近切换失败：${lastSwitch.reason || lastSwitch.errors[0] || '-'}`
        "
      />

      <el-alert
        v-if="result.warnings.length"
        type="warning"
        :closable="false"
        show-icon
        :title="result.warnings.join('；')"
      />
      <el-alert
        v-if="result.errors.length"
        type="error"
        :closable="false"
        show-icon
        :title="result.errors.join('；')"
      />
    </div>
  </div>
</template>

<style scoped>
.automation-page {
  display: grid;
  gap: 14px;
}

.settings-section {
  display: grid;
  gap: 10px;
}

.settings-section h4 {
  margin: 0;
  color: var(--text);
  font-size: 15px;
}

.settings-section p {
  margin: 0;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.6;
}

.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.inline-path {
  margin-left: 8px;
  color: var(--text-3);
  font-size: 12px;
}

.pin-input {
  max-width: 260px;
}

.result-panel {
  display: grid;
  gap: 12px;
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.result-header h4 {
  margin: 0;
  color: var(--text);
  font-size: 15px;
}
</style>
