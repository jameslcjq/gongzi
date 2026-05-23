<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Delete,
  Download,
  FolderOpened,
  Link,
  Plus,
  Refresh,
  VideoPause,
  VideoPlay
} from '@element-plus/icons-vue'
import type {
  MailAccountView,
  MailCheckProgress,
  MailDownloadLog,
  MailDownloadRecord
} from '@shared/types'

// ===== 邮箱账号 =====
const accounts = ref<MailAccountView[]>([])
const accountsLoading = ref(false)
const accountDialogVisible = ref(false)
const accountDialogMode = ref<'create' | 'edit'>('create')
const accountForm = ref({
  id: undefined as number | undefined,
  email: '',
  imapHost: 'imap.163.com',
  imapPort: 993,
  username: '',
  authCodeEncrypted: '',
  displayName: '',
  folder: '',
  fromFilter: 'miaojirong3550327@163.com'
})
const accountSaving = ref(false)
const accountTesting = ref(false)
const accountFolders = ref<string[]>([])
const accountFoldersLoading = ref(false)

const imapPresets = [
  { label: '163 邮箱 (imap.163.com)', value: 'imap.163.com' },
  { label: '126 邮箱 (imap.126.com)', value: 'imap.126.com' },
  { label: 'QQ 邮箱 (imap.qq.com)', value: 'imap.qq.com' },
  { label: '自定义', value: '' }
]

function openCreateAccount() {
  accountDialogMode.value = 'create'
  accountForm.value = {
    id: undefined, email: '', imapHost: 'imap.163.com', imapPort: 993,
    username: '', authCodeEncrypted: '', displayName: '',
    folder: '', fromFilter: 'miaojirong3550327@163.com'
  }
  accountDialogVisible.value = true
  accountFolders.value = []
}

function openEditAccount(row: MailAccountView) {
  accountDialogMode.value = 'edit'
  accountForm.value = {
    id: row.id, email: row.email, imapHost: row.imapHost, imapPort: row.imapPort,
    username: row.username, authCodeEncrypted: '', displayName: row.displayName ?? '',
    folder: row.folder ?? '', fromFilter: row.fromFilter ?? 'miaojirong3550327@163.com'
  }
  accountDialogVisible.value = true
  accountFolders.value = []
}

async function loadAccounts() {
  accountsLoading.value = true
  try {
    accounts.value = await window.salaryApi.listMailAccounts()
  } catch (e) {
    ElMessage.error('加载邮箱账号失败')
  } finally {
    accountsLoading.value = false
  }
}

async function saveAccount() {
  if (!accountForm.value.email || !accountForm.value.authCodeEncrypted) {
    ElMessage.warning('请填写邮箱地址和授权码')
    return
  }
  accountSaving.value = true
  try {
    await window.salaryApi.saveMailAccount({
      id: accountForm.value.id,
      email: accountForm.value.email,
      imapHost: accountForm.value.imapHost || 'imap.163.com',
      imapPort: accountForm.value.imapPort || 993,
      username: accountForm.value.username || accountForm.value.email,
      authCodeEncrypted: accountForm.value.authCodeEncrypted,
      displayName: accountForm.value.displayName || undefined,
      folder: accountForm.value.folder || undefined,
      fromFilter: accountForm.value.fromFilter || undefined
    })
    ElMessage.success(accountForm.value.id ? '账号已更新' : '账号已添加')
    accountDialogVisible.value = false
    await loadAccounts()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    accountSaving.value = false
  }
}

async function testAccount() {
  if (!accountForm.value.email || !accountForm.value.authCodeEncrypted) {
    ElMessage.warning('请填写邮箱地址和授权码')
    return
  }
  accountTesting.value = true
  try {
    const result = await window.salaryApi.testMailAccount({
      imapHost: accountForm.value.imapHost || 'imap.163.com',
      imapPort: accountForm.value.imapPort || 993,
      username: accountForm.value.username || accountForm.value.email,
      authCodeEncrypted: accountForm.value.authCodeEncrypted
    })
    if (result.ok) {
      ElMessage.success(result.message)
      if (accountForm.value.imapHost === 'imap.126.com' && result.message.includes('失败')) {
        ElMessage.warning('126 邮箱连接失败，可以尝试使用 imap.163.com 作为服务器')
      }
    } else {
      ElMessage.error(result.message)
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '测试失败')
  } finally {
    accountTesting.value = false
  }
}

async function fetchAccountFolders() {
  if (!accountForm.value.id) {
    ElMessage.warning('请先保存账号后再获取文件夹列表')
    return
  }
  accountFoldersLoading.value = true
  try {
    accountFolders.value = await window.salaryApi.listMailFolders(accountForm.value.id)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '获取文件夹失败')
  } finally {
    accountFoldersLoading.value = false
  }
}

async function deleteAccount(row: MailAccountView) {
  try {
    await ElMessageBox.confirm(`确认删除邮箱账号 ${row.email}？相关下载记录也将被删除`, '确认删除', {
      type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消'
    })
  } catch { return }
  try {
    await window.salaryApi.deleteMailAccount(row.id)
    ElMessage.success('已删除')
    await loadAccounts()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败')
  }
}

// ===== 手动下载 =====
const checkAccountId = ref<number | null>(null)
const checkDays = ref(30)
const checkRunning = ref(false)
const checkProgress = ref<MailCheckProgress | null>(null)
let cleanupProgress: (() => void) | undefined

const checkDaysOptions = [
  { label: '最近 7 天', value: 7 },
  { label: '最近 30 天', value: 30 },
  { label: '全部（最多90天）', value: 90 }
]

async function startCheck() {
  checkRunning.value = true
  checkProgress.value = null
  try {
    const result = await window.salaryApi.startMailCheck({
      accountId: checkAccountId.value ?? undefined,
      daysBack: checkDays.value
    })
    if (!result.ok && result.reason) ElMessage.warning(result.reason)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '检查失败')
  } finally {
    checkRunning.value = false
  }
}

async function stopCheck() {
  await window.salaryApi.stopMailCheck()
}

async function clearRecords() {
  try {
    await ElMessageBox.confirm('清除所有下载记录后，再次检查邮件时会重新下载之前的附件。确认清除？', '确认清除', {
      type: 'warning', confirmButtonText: '确认清除', cancelButtonText: '取消'
    })
  } catch { return }
  try {
    await window.salaryApi.clearMailRecords()
    ElMessage.success('下载记录已清除，可以重新下载')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '清除失败')
  }
}

function onProgress(p: MailCheckProgress) {
  checkProgress.value = p
  if (p.phase === 'done') {
    checkRunning.value = false
    if (p.message) {
      if (p.message.includes('失败')) ElMessage.error(p.message)
      else ElMessage.success(p.message)
    }
    loadLogs()
  }
}

// ===== 下载日志 =====
const logs = ref<MailDownloadLog[]>([])
const logsLoading = ref(false)
const logFilterLevel = ref('')

const logLevelOptions = [
  { label: '全部', value: '' },
  { label: '信息', value: 'info' },
  { label: '警告', value: 'warn' },
  { label: '错误', value: 'error' }
]

async function loadLogs() {
  logsLoading.value = true
  try {
    logs.value = await window.salaryApi.listMailLogs(undefined, logFilterLevel.value || undefined, 50, 0)
  } catch (e) {
    ElMessage.error('加载日志失败')
  } finally {
    logsLoading.value = false
  }
}

async function clearLogs() {
  try {
    await ElMessageBox.confirm('确认清空所有下载日志？', '确认清空', {
      type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消'
    })
  } catch { return }
  try {
    await window.salaryApi.clearMailLogs()
    ElMessage.success('日志已清空')
    await loadLogs()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '清空失败')
  }
}

async function openSavedDir(row: MailDownloadLog) {
  if (row.detail) {
    const match = row.detail.match(/保存到 (.+)/)
    if (match) {
      const filePath = match[1].trim()
      const dir = filePath.substring(0, filePath.lastIndexOf('\\'))
      if (dir) await window.salaryApi.openMailDir(dir)
    }
  }
}

function logLevelTag(level: string) {
  if (level === 'error') return 'danger'
  if (level === 'warn') return 'warning'
  return 'info'
}

function formatDate(s?: string) {
  if (!s) return ''
  return s.replace('T', ' ').slice(0, 19)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

onMounted(async () => {
  await loadAccounts()
  cleanupProgress = window.salaryApi.onMailCheckProgress(onProgress)
})

onUnmounted(() => {
  if (cleanupProgress) cleanupProgress()
})
</script>

<template>
  <div class="mail-settings">
    <!-- 账号列表 -->
    <div class="mail-section">
      <div class="mail-section-header">
        <strong>邮箱账号</strong>
        <span style="flex:1" />
        <el-button size="small" :icon="Plus" @click="openCreateAccount">添加</el-button>
        <el-button size="small" :icon="Refresh" :loading="accountsLoading" @click="loadAccounts">刷新</el-button>
      </div>
      <el-table :data="accounts" border stripe size="small" v-loading="accountsLoading" empty-text="暂无邮箱账号" max-height="260">
        <el-table-column prop="email" label="邮箱地址" min-width="180" />
        <el-table-column label="服务器" width="160">
          <template #default="{ row }">{{ row.imapHost }}:{{ row.imapPort }}</template>
        </el-table-column>
        <el-table-column label="文件夹" width="100">
          <template #default="{ row }">{{ row.folder || '收件箱' }}</template>
        </el-table-column>
        <el-table-column prop="fromFilter" label="发件人筛选" width="190" show-overflow-tooltip />
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openEditAccount(row)">编辑</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="deleteAccount(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 手动下载 -->
    <div class="mail-section">
      <div class="mail-section-header"><strong>检查邮件</strong></div>
      <div class="mail-download-bar">
        <el-select v-model="checkAccountId" placeholder="全部邮箱账号" clearable size="small" style="width: 220px">
          <el-option v-for="a in accounts" :key="a.id" :label="a.displayName || a.email" :value="a.id" />
        </el-select>
        <el-select v-model="checkDays" size="small" style="width: 150px; margin-left: 8px">
          <el-option v-for="opt in checkDaysOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button type="primary" size="small" :icon="VideoPlay" :loading="checkRunning" :disabled="accounts.length === 0" @click="startCheck" style="margin-left: 8px">
          开始检查
        </el-button>
        <el-button type="danger" size="small" :icon="VideoPause" :disabled="!checkRunning" @click="stopCheck" style="margin-left: 4px">
          停止
        </el-button>
        <span style="flex:1" />
        <el-button size="small" type="warning" text @click="clearRecords">清除下载记录</el-button>
      </div>
      <div v-if="checkProgress" class="mail-progress">
        <div class="mail-progress-phase">
          <el-tag size="small" :type="checkProgress.phase === 'done' ? 'success' : 'warning'">
            {{ checkProgress.phase === 'connecting' ? '连接中' : checkProgress.phase === 'scanning' ? '搜索中' : checkProgress.phase === 'downloading' ? '下载中' : '完成' }}
          </el-tag>
          <span v-if="checkProgress.accountEmail" style="margin-left:8px;font-size:13px;color:var(--text-2)">{{ checkProgress.accountEmail }}</span>
          <span v-if="checkProgress.message" style="margin-left:8px;font-size:12px;color:var(--text-3)">{{ checkProgress.message }}</span>
        </div>
        <el-progress
          v-if="checkProgress.totalMessages && checkProgress.totalMessages > 0"
          :percentage="Math.round(((checkProgress.scannedMessages ?? 0) / checkProgress.totalMessages) * 100)"
          :stroke-width="6"
          style="margin: 8px 0"
        />
        <div class="mail-progress-stats" v-if="checkProgress.totalMessages">
          <span class="mail-stat">扫描：{{ checkProgress.scannedMessages ?? 0 }}/{{ checkProgress.totalMessages }}</span>
          <span class="mail-stat mail-stat-ok">下载：{{ checkProgress.downloadedCount ?? 0 }}</span>
          <span class="mail-stat mail-stat-skip">跳过：{{ checkProgress.skippedCount ?? 0 }}</span>
          <span v-if="checkProgress.errorCount" class="mail-stat mail-stat-err">失败：{{ checkProgress.errorCount }}</span>
        </div>
        <div v-if="checkProgress.currentFilename" class="mail-current-file">正在处理：{{ checkProgress.currentFilename }}</div>
      </div>
    </div>

    <!-- 下载日志 -->
    <div class="mail-section">
      <div class="mail-section-header">
        <strong>下载日志</strong>
        <span style="flex:1" />
        <el-select v-model="logFilterLevel" size="small" style="width: 90px; margin-right: 8px">
          <el-option v-for="opt in logLevelOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button size="small" :icon="Refresh" @click="loadLogs">刷新</el-button>
        <el-button size="small" type="danger" text @click="clearLogs">清空</el-button>
      </div>
      <el-table :data="logs" border stripe size="small" v-loading="logsLoading" empty-text="暂无日志" max-height="280">
        <el-table-column label="时间" width="140">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="级别" width="60">
          <template #default="{ row }">
            <el-tag size="small" :type="logLevelTag(row.level)">{{ row.level === 'info' ? '信息' : row.level === 'warn' ? '警告' : '错误' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="内容" min-width="200" show-overflow-tooltip />
        <el-table-column prop="detail" label="详情" min-width="200" show-overflow-tooltip />
        <el-table-column label="操作" width="60" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.detail && row.detail.includes('保存到')" size="small" text type="primary" :icon="FolderOpened" @click="openSavedDir(row)" />
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- ===== 账号编辑对话框 ===== -->
    <el-dialog
      v-model="accountDialogVisible"
      :title="accountDialogMode === 'create' ? '添加邮箱账号' : '编辑邮箱账号'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-form label-width="110px" label-position="right" size="small">
        <el-form-item label="邮箱地址" required>
          <el-input v-model="accountForm.email" placeholder="user@163.com" />
        </el-form-item>
        <el-form-item label="IMAP 服务器">
          <el-select v-model="accountForm.imapHost" style="width:100%">
            <el-option v-for="opt in imapPresets" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="!accountForm.imapHost" label="自定义服务器">
          <el-input v-model="accountForm.imapHost" placeholder="imap.example.com" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input-number v-model="accountForm.imapPort" :min="1" :max="65535" style="width:100%" />
        </el-form-item>
        <el-form-item label="用户名">
          <el-input v-model="accountForm.username" placeholder="默认使用邮箱地址" />
        </el-form-item>
        <el-form-item label="授权码" required>
          <el-input v-model="accountForm.authCodeEncrypted" type="password" show-password placeholder="邮箱授权码（非登录密码）" />
          <div class="mail-form-hint">请使用邮箱授权码，不是邮箱登录密码。请在网页邮箱设置中开启 IMAP 服务获取。</div>
        </el-form-item>
        <el-form-item label="IMAP 文件夹">
          <div style="display:flex;gap:6px;width:100%">
            <el-select v-model="accountForm.folder" filterable clearable placeholder="收件箱（默认）" style="flex:1">
              <el-option v-for="f in accountFolders" :key="f" :label="f" :value="f" />
            </el-select>
            <el-button :loading="accountFoldersLoading" @click="fetchAccountFolders">获取</el-button>
          </div>
          <div class="mail-form-hint">留空=收件箱。编辑已有账号时可点击"获取"列出所有文件夹</div>
        </el-form-item>
        <el-form-item label="发件人筛选">
          <el-input v-model="accountForm.fromFilter" placeholder="miaojirong3550327@163.com" />
          <div class="mail-form-hint">只下载这些发件人的附件，多个用逗号分隔。留空=不筛选发件人</div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="accountForm.displayName" placeholder="例如：单位邮箱" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="accountDialogVisible = false">取消</el-button>
        <el-button :loading="accountTesting" @click="testAccount">
          <el-icon style="margin-right:4px"><Link /></el-icon>测试连接
        </el-button>
        <el-button type="primary" :loading="accountSaving" @click="saveAccount">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mail-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mail-section {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}

.mail-section-header {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
  gap: 6px;
}

.mail-section-header strong {
  font-size: 13px;
  color: var(--text);
}

.mail-download-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mail-progress {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  margin-top: 10px;
}

.mail-progress-phase {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mail-progress-stats {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.mail-stat {
  font-size: 12px;
  color: var(--text-2);
}

.mail-stat-ok {
  color: var(--success);
  font-weight: 500;
}

.mail-stat-skip {
  color: var(--warn);
}

.mail-stat-err {
  color: var(--danger);
  font-weight: 500;
}

.mail-current-file {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-muted);
  font-family: var(--mono);
}

.mail-form-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  line-height: 1.4;
}
</style>
