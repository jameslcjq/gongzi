<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ConsistencyAuditPage from './ConsistencyAuditPage.vue'
import type { BackupSummary, ImportWatcherStatus, MonthlyPayrollRun, UnitSettings } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  importWatcher: ImportWatcherStatus | null
  databasePath: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'changed'): void
  (event: 'openWorksheet', worksheetName: string): void
}>()

const backups = ref<BackupSummary[]>([])
const backupsLoading = ref(false)
const creatingBackup = ref(false)
const wiping = ref(false)
const monthCloseRuns = ref<MonthlyPayrollRun[]>([])
const monthCloseLoading = ref(false)
const cancelingMonthCloseId = ref<number | null>(null)
const activeTab = ref('unit')

const unitForm = reactive<UnitSettings>({
  unitFullName: '',
  unitImportCode: '',
  schoolLevel: '小学教育',
  functionCode: '2050202',
  retiredFunctionCode: '2210202',
  retiredFunctionName: '退休提租补贴',
  budgetActiveCode: '',
  budgetRetiredCode: '',
  socialPayeeName: '',
  socialPayeeBank: '',
  socialPayeeAccount: '',
  housingPayeeName: '',
  housingPayeeBank: '',
  housingPayeeAccount: ''
})
const unitSaving = ref(false)

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      void refreshBackups()
      void refreshMonthCloseRuns()
      void loadUnitSettings()
    }
  }
)

async function loadUnitSettings() {
  const settings = await window.salaryApi.getUnitSettings()
  Object.assign(unitForm, settings)
}

async function saveUnitSettings() {
  unitSaving.value = true
  try {
    const next = await window.salaryApi.setUnitSettings({ ...unitForm })
    Object.assign(unitForm, next)
    ElMessage.success('单位设置已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    unitSaving.value = false
  }
}

async function refreshBackups() {
  backupsLoading.value = true
  try {
    backups.value = await window.salaryApi.listBackups()
  } finally {
    backupsLoading.value = false
  }
}

async function refreshMonthCloseRuns() {
  monthCloseLoading.value = true
  try {
    const runs = await window.salaryApi.listMonthlyPayrollRuns()
    monthCloseRuns.value = runs.filter((item: MonthlyPayrollRun) => item.archivedAt)
  } finally {
    monthCloseLoading.value = false
  }
}

async function openMonthCloseFolder(row: MonthlyPayrollRun) {
  if (!row.archiveDir) return
  const err = await window.salaryApi.openLocalPath(row.archiveDir)
  if (err) ElMessage.error(`无法打开：${err}`)
}

async function cancelMonthClose(row: MonthlyPayrollRun) {
  try {
    await ElMessageBox.confirm(
      `取消 ${row.year}年${row.month}月 的月结后，该月所有历史记录都会解除月结锁定，可以重新预处理和生成报表；已经移入月结目录的源文件不会自动放回监控文件夹。`,
      '取消月结',
      {
        type: 'warning',
        confirmButtonText: '取消月结',
        cancelButtonText: '保留月结',
        confirmButtonClass: 'el-button--danger'
      }
    )
  } catch {
    return
  }

  cancelingMonthCloseId.value = row.id
  try {
    await window.salaryApi.cancelMonthlyPayrollMonthClose(row.id)
    ElMessage.success('已取消月结')
    await refreshMonthCloseRuns()
    emit('changed')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '取消月结失败')
  } finally {
    cancelingMonthCloseId.value = null
  }
}

async function createBackup() {
  creatingBackup.value = true
  try {
    const summary = await window.salaryApi.createBackup()
    ElMessage.success(`已备份：${summary.fileName}`)
    await refreshBackups()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '备份失败')
  } finally {
    creatingBackup.value = false
  }
}

async function restore(backup: BackupSummary) {
  try {
    await ElMessageBox.confirm(
      `恢复后会用 ${backup.fileName} 覆盖当前数据库，应用将自动重启，是否继续？`,
      '确认恢复',
      { type: 'warning', confirmButtonText: '恢复并重启', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  try {
    await window.salaryApi.restoreBackup(backup.fileName)
  } catch (error) {
    if (error instanceof Error && error.message === '用户取消恢复') return
    ElMessage.error(error instanceof Error ? error.message : '恢复失败')
  }
}

async function chooseImportFolder() {
  await window.salaryApi.chooseImportWatcherFolder()
  emit('changed')
}

async function wipeAll() {
  try {
    await ElMessageBox.confirm(
      '将清空业务工作表数据 + 导入批次 + 操作日志，三张对照基础表会保留。无法恢复，建议先建一份备份。确定继续吗？',
      '一键清空所有数据',
      {
        type: 'error',
        confirmButtonText: '清空全部',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger'
      }
    )
  } catch {
    return
  }

  let confirmInput: string
  try {
    const result = await ElMessageBox.prompt(
      '请输入「确认清空」四个字以最终确认：',
      '最终确认',
      {
        confirmButtonText: '执行',
        cancelButtonText: '取消',
        inputPattern: /^确认清空$/,
        inputErrorMessage: '输入不正确，操作已取消'
      }
    )
    confirmInput = result.value
  } catch {
    return
  }

  if (confirmInput !== '确认清空') return

  wiping.value = true
  try {
    const summary = await window.salaryApi.wipeAllData()
    ElMessage.success(`已清空 ${summary.tables} 张业务表，共 ${summary.rows} 行，对照基础表已保留`)
    emit('changed')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '清空失败')
  } finally {
    wiping.value = false
  }
}

async function openImportFolder() {
  await window.salaryApi.openImportWatcherFolder()
}

function openLookupWorksheet(name: string) {
  emit('openWorksheet', name)
}

function close() {
  emit('update:modelValue', false)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="系统设置"
    width="1180px"
    :close-on-click-modal="false"
    @update:model-value="close"
  >
    <el-tabs v-model="activeTab" class="settings-tabs">
      <el-tab-pane label="单位信息" name="unit">
        <div class="settings-section">
          <h4>单位信息</h4>
          <p>影响月度工资报账生成的单位名称、会计科目编码等。修改后下次生成报表立即生效。</p>
          <el-form :model="unitForm" label-width="140px" label-position="right" size="small">
            <el-row :gutter="12">
              <el-col :span="24">
                <el-form-item label="单位全称">
                  <el-input v-model="unitForm.unitFullName" placeholder="如：沭阳县扎下中心小学" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="单位代码">
                  <el-input v-model="unitForm.unitImportCode" placeholder="如：019052" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="支出功能分类编码">
                  <el-input v-model="unitForm.functionCode" placeholder="如：2050202" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="支出功能分类名称">
                  <el-input v-model="unitForm.schoolLevel" placeholder="如：小学教育 / 初中教育" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="在职预算项目编码">
                  <el-input v-model="unitForm.budgetActiveCode" placeholder="对应模板中 工资!D25" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="退休预算项目编码">
                  <el-input v-model="unitForm.budgetRetiredCode" placeholder="对应模板中 工资!D26" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="退休功能分类编码">
                  <el-input v-model="unitForm.retiredFunctionCode" placeholder="如：2210202" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="退休功能分类名称">
                  <el-input v-model="unitForm.retiredFunctionName" placeholder="如：退休提租补贴" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-divider content-position="left">五险缴存账户</el-divider>
            <el-row :gutter="12">
              <el-col :span="24">
                <el-form-item label="账户名称">
                  <el-input v-model="unitForm.socialPayeeName" placeholder="如：沭阳县会计核算中心代扣代缴专户" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="开户行">
                  <el-input v-model="unitForm.socialPayeeBank" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="账号">
                  <el-input v-model="unitForm.socialPayeeAccount" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-divider content-position="left">公积金缴存账户</el-divider>
            <el-row :gutter="12">
              <el-col :span="24">
                <el-form-item label="账户名称">
                  <el-input v-model="unitForm.housingPayeeName" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="开户行">
                  <el-input v-model="unitForm.housingPayeeBank" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="账号">
                  <el-input v-model="unitForm.housingPayeeAccount" />
                </el-form-item>
              </el-col>
            </el-row>
            <div>
              <el-button type="primary" :loading="unitSaving" @click="saveUnitSettings">保存单位信息</el-button>
            </div>
          </el-form>
        </div>
      </el-tab-pane>

      <el-tab-pane label="工资月结" name="monthClose">
        <div class="settings-section">
          <h4>工资月结管理</h4>
          <p>取消月结只解除本月锁定，不删除月结目录文件，也不会把源文件自动放回监控文件夹。</p>
          <div>
            <el-button @click="refreshMonthCloseRuns">刷新月结列表</el-button>
          </div>
        </div>

        <el-table :data="monthCloseRuns" v-loading="monthCloseLoading" border size="small" height="420">
          <el-table-column label="年月" width="110">
            <template #default="{ row }">{{ row.year }}-{{ String(row.month).padStart(2, '0') }}</template>
          </el-table-column>
          <el-table-column prop="archivedAt" label="月结时间" min-width="170" />
          <el-table-column prop="unitFullName" label="单位" min-width="180" show-overflow-tooltip />
          <el-table-column label="实发" width="120" align="right">
            <template #default="{ row }">{{ formatMoney(row.actualPay) }}</template>
          </el-table-column>
          <el-table-column prop="archiveDir" label="月结目录" min-width="220" show-overflow-tooltip />
          <el-table-column label="操作" width="180" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.archiveDir"
                size="small"
                text
                type="primary"
                @click="openMonthCloseFolder(row)"
              >打开目录</el-button>
              <el-button
                size="small"
                text
                type="danger"
                :loading="cancelingMonthCloseId === row.id"
                @click="cancelMonthClose(row)"
              >取消月结</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="一致性审计" name="audit">
        <div class="settings-audit-pane">
          <ConsistencyAuditPage />
        </div>
      </el-tab-pane>

      <el-tab-pane label="数据库" name="database">
        <div class="settings-section">
          <h4>数据库</h4>
          <p>{{ databasePath || '初始化中' }}</p>
          <div>
            <el-button type="primary" :loading="creatingBackup" @click="createBackup">立即备份</el-button>
            <el-button @click="refreshBackups">刷新备份列表</el-button>
          </div>
        </div>

        <el-table :data="backups" v-loading="backupsLoading" border size="small" height="420">
          <el-table-column prop="fileName" label="文件名" min-width="240" show-overflow-tooltip />
          <el-table-column label="大小" width="100" align="right">
            <template #default="{ row }">{{ formatSize(row.sizeBytes) }}</template>
          </el-table-column>
          <el-table-column prop="createdAt" label="时间" min-width="200" />
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="restore(row)">恢复</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="导入目录" name="import">
        <div class="settings-section">
          <h4>Excel 自动导入文件夹</h4>
          <p>{{ importWatcher?.folderPath || '未配置' }}</p>
          <p>模板文件夹：{{ importWatcher?.templateFolderPath || '-' }}</p>
          <div>
            <el-button @click="chooseImportFolder">更换目录</el-button>
            <el-button @click="openImportFolder">打开目录</el-button>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="基础对照表" name="lookups">
        <div class="settings-section">
          <h4>基础对照表</h4>
          <p>岗位、薪级、乡镇工作年限对照属于基础数据，一键清空时会自动保留。</p>
          <div class="lookup-actions">
            <el-button @click="openLookupWorksheet('岗位工资对照')">岗位工资对照</el-button>
            <el-button @click="openLookupWorksheet('薪级工资对照')">薪级工资对照</el-button>
            <el-button @click="openLookupWorksheet('乡镇工作年限对照')">乡镇工作年限对照</el-button>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="危险操作" name="danger">
        <div class="settings-section danger-section">
          <h4>危险操作</h4>
          <p>清空后不可恢复，先建一份备份再操作。三张基础对照表会保留。</p>
          <div>
            <el-button type="danger" :loading="wiping" @click="wipeAll">一键清空所有数据</el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <el-button type="primary" @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.settings-tabs {
  min-height: 560px;
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

.lookup-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.danger-section {
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  background: var(--danger-soft);
}

.settings-audit-pane {
  height: 560px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.settings-audit-pane :deep(.audit-page) {
  min-height: 560px;
  padding: 14px;
}

.settings-audit-pane :deep(.audit-header h2) {
  font-size: 18px;
}
</style>
