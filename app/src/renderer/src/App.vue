<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Bell,
  CircleCheck,
  CircleClose,
  Lock,
  Setting,
  Tickets,
  Upload,
  User
} from '@element-plus/icons-vue'
import { setSwitchToIntegration } from './integration/insurancePushQueue'
import FieldStructureDialog from './components/FieldStructureDialog.vue'
import ImportDialog from './components/ImportDialog.vue'
import IntegratedPortalPage from './components/IntegratedPortalPage.vue'
import AnnualAdjustmentPage from './components/AnnualAdjustmentPage.vue'
import MonthlyPayrollPage from './components/MonthlyPayrollPage.vue'
import PerformancePayrollPage from './components/PerformancePayrollPage.vue'
import PivotPage from './components/PivotPage.vue'
import StatReportPage from './components/StatReportPage.vue'
import RecordFormDialog from './components/RecordFormDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import WorksheetView from './components/WorksheetView.vue'
import type {
  AnnualReportWorkflowInput,
  AppSummary,
  BudgetActiveMasterSyncPreview,
  ExcelImportLog,
  HrMasterSyncPreview,
  ImportBatchSummary,
  ImportWatcherStatus,
  LookupFailureEntry,
  MasterSyncSelectionItem,
  TeacherDetailMasterSyncPreview,
  TownshipIdCardFillResult,
  TownshipMasterSyncPreview,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowRunPayload,
  WorksheetField,
  WorksheetRecord,
  WorksheetRecordValue,
  WorksheetRecordsResult
} from '@shared/types'

type ModuleGroup = {
  key: string
  label: string
  tables: string[]
  hidden?: boolean
}

type IpcResponse<T> = {
  success: boolean
  data?: T
  error?: string
}

type LicenseStatus = {
  valid: boolean
  source?: 'online' | 'offline' | 'cache'
  product_key?: string
  product_name?: string
  license_key?: string
  customer_name?: string
  expires_at?: string
  seats?: number
  used_seats?: number
  reason?: string
  message?: string
  cached?: boolean
  checkedAt?: string
  device_id?: string
}

type LicenseDeviceInfo = {
  product_key: string
  license_key?: string
  device_id: string
  device_name: string
  app_version: string
  hardware: string
}

const modules: ModuleGroup[] = [
  { key: 'integration', label: '一体化对接', tables: [] },
  { key: 'integrated', label: '工资数据', tables: ['在职工资', '退休工资', '其他工资'] },
  { key: 'payroll', label: '工资业务', tables: [] },
  { key: 'budget', label: '预算', tables: ['预算在职', '预算退休', '预算其他'] },
  { key: 'annual', label: '工资年报', tables: ['工资年报', '绩效工资'] },
  { key: 'township', label: '乡镇补贴', tables: ['乡镇补贴'] },
  {
    key: 'housing',
    label: '退休房补',
    tables: ['人员明细导出', '新房补']
  },
  { key: 'pivot', label: '统计分析', tables: [] },
  {
    key: 'hr',
    label: '人事管理',
    tables: [
      '人事信息',
      '在编教职工基本信息',
      '教职工学历',
      '教职工教师资格',
      '教职工任教信息',
      '教职工工作履历',
      '职级简历'
    ]
  }
]

const visibleModules = modules.filter((module) => !module.hidden)
const worksheetDisplayNames: Record<string, string> = {
  在职工资: '在职工资',
  退休工资: '退休工资',
  其他工资: '其他工资'
}

function displayWorksheetName(name: string) {
  return worksheetDisplayNames[name] ?? name
}

const summary = ref<AppSummary | null>(null)
const error = ref('')
const loginStorageKey = 'salary-system:logged-in'
const loginStorageValue = 'admin-auth-v1'
const loginUsername = 'admin'
const loginPassword = '123456'
const isLoggedIn = ref(localStorage.getItem(loginStorageKey) === loginStorageValue)
const loginForm = ref({
  username: loginUsername,
  password: ''
})
const loginRemember = ref(true)
const licenseStatus = ref<LicenseStatus | null>(null)
const licenseDevice = ref<LicenseDeviceInfo | null>(null)
const licenseKey = ref('')
const licenseLoading = ref(false)
const appVersion = ref('dev')
const activeModuleKey = ref(modules[0].key)
const selectedWorksheetId = ref('')
const worksheetRecords = ref<WorksheetRecordsResult | null>(null)
const recordsLoading = ref(false)
const search = ref('')
const activeView = ref('')
const page = ref(1)
const pageSize = ref(100)
const ALL_PAGE_SIZE = 100000

const workflows = ref<WorkflowDefinition[]>([])
const workflowRunningKey = ref('')
const annualReportDialogVisible = ref(false)
const annualReportForm = ref<AnnualReportWorkflowInput>({
  totalPerformance: 0,
  totalHeadTeacher: 0,
  totalOvertime: 0
})

const importWatcher = ref<ImportWatcherStatus | null>(null)
const importWatcherLoading = ref(false)
const workflowNoticeLogs = ref<ExcelImportLog[]>([])
const seenImportLogKeys = new Set<string>()
let importWatcherInitialized = false
let importWatcherTimer: ReturnType<typeof setInterval> | undefined
let hrMasterSyncPrompting = false
let townshipSyncPrompting = false
let budgetActiveSyncPrompting = false
let teacherDetailSyncPrompting = false

type SyncDiffTableRow = MasterSyncSelectionItem & {
  key: string
  sourceName: string
  name: string
  action: 'insert' | 'update'
  fieldName: string
  currentValue: string
  nextValue: string
  selected: boolean
}

const syncDiffDialogVisible = ref(false)
const syncDiffDialogTitle = ref('')
const syncDiffDialogSummary = ref('')
const syncDiffRows = ref<SyncDiffTableRow[]>([])
let syncDiffResolver: ((value: MasterSyncSelectionItem[] | null) => void) | undefined

const syncDiffSelectedCount = computed(
  () => syncDiffRows.value.filter((row) => row.selected).length
)
const syncDiffAllSelected = computed(
  () => syncDiffRows.value.length > 0 && syncDiffRows.value.every((row) => row.selected)
)

const importDialogVisible = ref(false)
const settingsDialogVisible = ref(false)
const fieldDialogVisible = ref(false)
const fieldSaving = ref(false)
const recordDialogVisible = ref(false)
const recordDialogMode = ref<'create' | 'edit'>('create')
const recordDialogInitial = ref<WorksheetRecord | undefined>(undefined)
const recordSaving = ref(false)
const editingRecordId = ref<number | null>(null)
const lookupFailureDialogVisible = ref(false)
const lookupFailureLoading = ref(false)
const lookupFailureTitle = ref('')
const lookupFailureRows = ref<LookupFailureEntry[]>([])
const pivotSubTab = ref<'reports' | 'pivot'>('reports')
const payrollSubTab = ref<'monthly' | 'performance' | 'annualAdjustment'>('monthly')
const monthlyPayrollRefreshKey = ref(0)

const activeModule = computed(
  () => modules.find((item) => item.key === activeModuleKey.value) ?? visibleModules[0]
)

const isLicenseValid = computed(() => licenseStatus.value?.valid === true)

const tablesInModule = computed(() => {
  const all = summary.value?.worksheets ?? []
  const inModule = activeModule.value.tables
  return inModule
    .map((name) => all.find((item) => item.name === name))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
})

const selectedWorksheet = computed(() =>
  summary.value?.worksheets.find((item) => item.worksheetId === selectedWorksheetId.value)
)

const importLogs = computed(() => [...workflowNoticeLogs.value, ...(importWatcher.value?.logs ?? [])])

const importNotifications = computed(() => {
  const failed = importLogs.value.filter((log) => !log.ok)
  const succeeded = importLogs.value.filter((log) => log.ok)
  return [...failed, ...succeeded].slice(0, 12)
})

const latestImportLog = computed(() => importLogs.value[0])

const failedImportCount = computed(
  () => importLogs.value.filter((log) => !log.ok).length
)

function noticeKindText(log: ExcelImportLog): string {
  if (log.worksheetName === '工作流') return log.ok ? '工作流完成' : '系统提醒'
  return log.ok ? '导入成功' : '导入失败'
}

watch(activeModuleKey, () => {
  const tables = tablesInModule.value
  if (tables.length > 0) {
    selectedWorksheetId.value = tables[0].worksheetId
  }
})

const defaultViewByWorksheet: Record<string, string> = {
  '预算在职': '全部',
  '预算退休': '全部',
  '预算其他': '全部',
  '在职工资': '全部'
}

// 使用标志位防止级联触发 loadRecords 多次
let suppressRecordLoad = false

watch(selectedWorksheetId, () => {
  suppressRecordLoad = true
  search.value = ''
  const name = selectedWorksheet.value?.name ?? ''
  activeView.value = selectedWorksheet.value?.views?.some((view) => view.name === '在职')
    ? '在职'
    : defaultViewByWorksheet[name] ?? ''
  page.value = 1
  sortState.value = null
  suppressRecordLoad = false
  void loadRecords()
})

watch(page, () => {
  if (!suppressRecordLoad) void loadRecords()
})

watch(search, () => {
  if (suppressRecordLoad) return
  page.value = 1
  void loadRecords()
})

watch(activeView, () => {
  if (suppressRecordLoad) return
  page.value = 1
  void loadRecords()
})

watch(isLicenseValid, (valid) => {
  if (!valid) {
    worksheetRecords.value = null
    return
  }
  void loadRecords()
})

async function loadSummary() {
  try {
    const next = await window.salaryApi.getSummary()
    summary.value = next

    if (!selectedWorksheetId.value) {
      const firstTable = tablesInModule.value[0]
      if (firstTable) selectedWorksheetId.value = firstTable.worksheetId
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取本地数据库失败'
  }
}

const sortState = ref<{ column: string; order: 'asc' | 'desc' } | null>(null)

async function loadRecords() {
  if (!isLicenseValid.value) return
  if (!selectedWorksheetId.value) return
  recordsLoading.value = true
  try {
    worksheetRecords.value = await window.salaryApi.listWorksheetRecords(
      selectedWorksheetId.value,
      {
        limit: pageSize.value,
        offset: (page.value - 1) * pageSize.value,
        search: search.value,
        view: activeView.value,
        sortColumn: sortState.value?.column,
        sortOrder: sortState.value?.order
      }
    )
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '读取记录失败')
    worksheetRecords.value = null
  } finally {
    recordsLoading.value = false
  }
}

function onSortChange(value: { column: string; order: 'asc' | 'desc' } | null) {
  sortState.value = value
  page.value = 1
  void loadRecords()
}

function onPageSizeChange(value: number) {
  pageSize.value = value
  page.value = 1
  void loadRecords()
}

async function loadWorkflows() {
  workflows.value = await window.salaryApi.listWorkflows()
}

async function saveFields(fields: WorksheetField[]) {
  if (!selectedWorksheetId.value) return
  fieldSaving.value = true
  try {
    summary.value = await window.salaryApi.saveWorksheetFields(selectedWorksheetId.value, fields)
    ElMessage.success('字段结构已保存')
    fieldDialogVisible.value = false
    await loadRecords()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存字段结构失败')
  } finally {
    fieldSaving.value = false
  }
}

async function refreshImportWatcher() {
  importWatcherLoading.value = true
  try {
    const next = await window.salaryApi.getImportWatcherStatus()
    await handleImportWatcherNotifications(next)
    importWatcher.value = next
  } finally {
    importWatcherLoading.value = false
  }
}

async function openImportWatcherFolder() {
  try {
    const next = await window.salaryApi.openImportWatcherFolder()
    importWatcher.value = next
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '打开监控文件夹失败')
  }
}

async function clearImportNotifications() {
  try {
    const next = await window.salaryApi.clearImportWatcherLogs()
    workflowNoticeLogs.value = []
    seenImportLogKeys.clear()
    next.logs.forEach((log: ExcelImportLog) => seenImportLogKeys.add(getImportLogKey(log)))
    importWatcherInitialized = true
    importWatcher.value = next
    ElMessage.success('导入通知已清空')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '清空导入通知失败')
  }
}

function getImportLogKey(log: ExcelImportLog): string {
  return `${log.createdAt}|${log.fileName}|${log.ok ? '1' : '0'}|${log.message}`
}

async function handleImportWatcherNotifications(next: ImportWatcherStatus) {
  const logs = next.logs ?? []
  if (!importWatcherInitialized) {
    logs.forEach((log) => seenImportLogKeys.add(getImportLogKey(log)))
    importWatcherInitialized = true
    return
  }

  const freshLogs = logs.filter((log) => !seenImportLogKeys.has(getImportLogKey(log)))
  if (freshLogs.length === 0) return

  freshLogs
    .slice()
    .reverse()
    .forEach((log) => {
      seenImportLogKeys.add(getImportLogKey(log))
      ElMessage({
        type: log.ok ? 'success' : 'error',
        message: log.ok
          ? `导入成功：${log.fileName}，${log.importedRows} 行`
          : `导入失败：${log.fileName}：${log.message}`,
        duration: log.ok ? 3500 : 7000,
        showClose: true
      })
    })

  if (freshLogs.some((log) => log.ok)) {
    await loadRecords()
  }

  for (const log of freshLogs) {
    if (!log.ok) continue
    await handleImportedWorksheetName(log.worksheetName)
  }
}

async function runWorkflow(workflowKey: string, payload?: WorkflowRunPayload) {
  if (workflowKey === 'annual-report.generate' && !payload?.annualReport) {
    annualReportDialogVisible.value = true
    return
  }

  workflowRunningKey.value = workflowKey
  try {
    const result = await window.salaryApi.runWorkflow(workflowKey, payload)
    pushWorkflowNotice(result)
    if (result.ok && result.warnings.length === 0) {
      ElMessage.success(`${result.workflowName}执行完成，影响 ${result.affectedRows} 行`)
    }
    await loadRecords()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '工作流执行失败')
  } finally {
    workflowRunningKey.value = ''
  }
}

function pushWorkflowNotice(result: WorkflowRunResult) {
  if (result.ok && result.warnings.length === 0) return
  const message = [...result.warnings, ...result.messages].filter(Boolean).join('；')
  const notice: ExcelImportLog = {
    fileName: result.workflowName,
    worksheetName: '工作流',
    ok: false,
    importedRows: result.affectedRows,
    message: message || '工作流执行完成，但存在需要处理的提示',
    createdAt: new Date().toISOString()
  }
  workflowNoticeLogs.value = [notice, ...workflowNoticeLogs.value].slice(0, 20)
  ElMessage({
    type: result.ok ? 'warning' : 'error',
    message: `${result.workflowName}：${notice.message}`,
    duration: 8000,
    showClose: true
  })
}

async function showLookupFailureDetails(log: ExcelImportLog) {
  if (!log.ok) {
    if (log.worksheetName === '工作流') {
      await ElMessageBox.alert(
        formatNotificationDetails(log.message || '无详细提醒内容'),
        `${log.fileName}详情`,
        { type: 'warning', confirmButtonText: '关闭', customClass: 'import-error-dialog' }
      )
    } else {
      // 普通 Excel 导入失败：直接展示错误信息
      await ElMessageBox.alert(
        log.message || '无详细错误信息',
        `导入失败：${log.fileName}`,
        { type: 'error', confirmButtonText: '关闭', customClass: 'import-error-dialog' }
      )
    }
  }
}

function formatNotificationDetails(message: string): string {
  return message
    .split('；')
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n')
}

async function showAllLookupFailures() {
  await loadLookupFailureDetails('全部失败日志')
}

async function loadLookupFailureDetails(title: string, workflow?: string) {
  lookupFailureDialogVisible.value = true
  lookupFailureLoading.value = true
  lookupFailureTitle.value = title
  try {
    const result = await window.salaryApi.listLookupFailures({
      workflow,
      limit: 500,
      offset: 0
    })
    lookupFailureRows.value = result.rows
    if (result.rows.length === 0) {
      ElMessage.info('没有查到该工作流的失败明细')
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '读取失败日志失败')
    lookupFailureRows.value = []
  } finally {
    lookupFailureLoading.value = false
  }
}

async function submitAnnualReport() {
  annualReportDialogVisible.value = false
  await runWorkflow('annual-report.generate', {
    annualReport: {
      ...annualReportForm.value,
      totalPerformance: Number(annualReportForm.value.totalPerformance) || 0,
      totalHeadTeacher: Number(annualReportForm.value.totalHeadTeacher) || 0,
      totalOvertime: Number(annualReportForm.value.totalOvertime) || 0
    }
  })
}

function openCreateDialog() {
  if (!selectedWorksheet.value) return
  recordDialogMode.value = 'create'
  recordDialogInitial.value = undefined
  editingRecordId.value = null
  recordDialogVisible.value = true
}

function changeView(viewName: string) {
  activeView.value = viewName
}

function openEditDialog(record: WorksheetRecord) {
  if (!selectedWorksheet.value) return
  recordDialogMode.value = 'edit'
  recordDialogInitial.value = record
  editingRecordId.value = typeof record.id === 'number' ? record.id : Number(record.id)
  recordDialogVisible.value = true
}

async function submitRecord(values: Record<string, WorksheetRecordValue>) {
  if (!selectedWorksheetId.value) return
  recordSaving.value = true
  try {
    if (recordDialogMode.value === 'create') {
      await window.salaryApi.createWorksheetRecord(selectedWorksheetId.value, values)
      ElMessage.success('已新增')
    } else if (editingRecordId.value !== null) {
      await window.salaryApi.updateWorksheetRecord(
        selectedWorksheetId.value,
        editingRecordId.value,
        values
      )
      ElMessage.success('已更新')
    }
    recordDialogVisible.value = false
    await loadRecords()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    recordSaving.value = false
  }
}

async function deleteRecord(record: WorksheetRecord) {
  if (!selectedWorksheetId.value) return
  const recordId = typeof record.id === 'number' ? record.id : Number(record.id)
  if (!recordId) return

  try {
    await ElMessageBox.confirm('确定删除该条记录吗？', '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  try {
    await window.salaryApi.deleteWorksheetRecord(selectedWorksheetId.value, recordId)
    ElMessage.success('已删除')
    await loadRecords()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

async function deleteRecords(recordIds: number[]) {
  if (!selectedWorksheetId.value || recordIds.length === 0) return

  try {
    await ElMessageBox.confirm(`确定删除选中的 ${recordIds.length} 条记录吗？`, '批量删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  try {
    const result = await window.salaryApi.deleteWorksheetRecords(
      selectedWorksheetId.value,
      recordIds
    )
    ElMessage.success(`已删除 ${result.affectedRows} 条`)
    await loadRecords()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '批量删除失败')
  }
}

async function clearCurrentWorksheet() {
  if (!selectedWorksheet.value) return
  const name = displayWorksheetName(selectedWorksheet.value.name)

  try {
    await ElMessageBox.confirm(
      `确定清空「${name}」表的所有数据吗？此操作不可撤销。`,
      '清空本表',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  try {
    const result = await window.salaryApi.clearWorksheet(selectedWorksheet.value.worksheetId)
    ElMessage.success(`已清空 ${result.affectedRows} 行`)
    await loadRecords()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '清空失败')
  }
}

async function exportCurrentWorksheet() {
  if (!selectedWorksheet.value) return
  try {
    const result = await window.salaryApi.exportWorksheet(
      selectedWorksheet.value.worksheetId,
      activeView.value
    )
    if (!result) return
    ElMessage.success(`已导出 ${result.rowCount} 行`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  }
}

async function onImported(summary?: ImportBatchSummary) {
  await loadRecords()
  if (summary?.status !== 'imported') return
  await handleImportedWorksheetName(summary.worksheetName)
}

async function handleImportedWorksheetName(worksheetName?: string) {
  if (worksheetName === '在职工资') {
    await promptHrMasterSync()
    return
  }
  if (worksheetName === '乡镇补贴') {
    await handleTownshipImported()
    return
  }
  if (worksheetName === '预算在职') {
    await promptBudgetActiveMasterSync()
    return
  }
  if (worksheetName === '在编教职工基本信息') {
    await promptTeacherDetailMasterSync()
  }
}

async function promptHrMasterSync() {
  if (hrMasterSyncPrompting) return
  hrMasterSyncPrompting = true
  try {
    const preview = await window.salaryApi.previewHrMasterSyncFromIntegrated()
    const warnings = buildHrMasterSyncWarnings(preview)
    if (preview.updatableRows === 0) {
      await showIdCardLookupNotice(`${displayWorksheetName('在职工资')}身份证匹配提醒`, warnings)
      return
    }

    const isEmptyMaster = preview.masterRows === 0
    if (isEmptyMaster) {
      const result = await window.salaryApi.applyHrMasterSyncFromIntegrated()
      ElMessage.success(
        `已更新人事信息：新增 ${result.insertedRows} 人，更新 ${result.updatedRows} 人`
      )
      await loadSummary()
      await loadRecords()
      return
    }

    const title = '发现人事信息差异'
    const selections = await openSyncDiffDialog(
      title,
      appendSyncSummaryWarnings(`${displayWorksheetName('在职工资')}：新增 ${preview.insertRows} 人，更新 ${preview.updateRows} 人`, warnings),
      flattenSyncDiffRows(displayWorksheetName('在职工资'), preview.diffs, 'sourceRecordId')
    )
    if (!selections) return

    const result = await window.salaryApi.applyHrMasterSyncFromIntegrated(selections)
    ElMessage.success(
      `已更新人事信息：新增 ${result.insertedRows} 人，更新 ${result.updatedRows} 人`
    )
    await loadSummary()
    await loadRecords()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '人事信息更新失败')
  } finally {
    hrMasterSyncPrompting = false
  }
}

async function promptBudgetActiveMasterSync() {
  if (budgetActiveSyncPrompting) return
  budgetActiveSyncPrompting = true
  try {
    const preview = await window.salaryApi.previewBudgetActiveMasterSync()
    const warnings = buildBudgetActiveMasterSyncWarnings(preview)
    if (preview.updatableRows === 0) {
      await showIdCardLookupNotice('预算在职身份证匹配提醒', warnings)
      return
    }

    const title = preview.masterRows === 0 ? '更新人事信息主表' : '发现人事信息差异'
    const selections = await openSyncDiffDialog(
      title,
      appendSyncSummaryWarnings(`预算在职：新增 ${preview.insertRows} 人，更新 ${preview.updateRows} 人`, warnings),
      flattenSyncDiffRows('预算在职', preview.diffs, 'budgetRecordId')
    )
    if (!selections) return

    const result = await window.salaryApi.applyBudgetActiveMasterSync(selections)
    ElMessage.success(
      `已更新人事信息：新增 ${result.insertedRows} 人，更新 ${result.updatedRows} 人`
    )
    await loadRecords()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '预算在职同步失败')
  } finally {
    budgetActiveSyncPrompting = false
  }
}

async function promptTeacherDetailMasterSync() {
  if (teacherDetailSyncPrompting) return
  teacherDetailSyncPrompting = true
  try {
    const preview = await window.salaryApi.previewTeacherDetailMasterSync()
    const warnings = buildTeacherDetailMasterSyncWarnings(preview)
    if (preview.updatableRows === 0) {
      await showIdCardLookupNotice('在编教职工身份证匹配提醒', warnings)
      return
    }

    const title = preview.masterRows === 0 ? '更新人事信息主表' : '发现人事信息差异'
    const selections = await openSyncDiffDialog(
      title,
      appendSyncSummaryWarnings(`在编教职工基本信息：新增 ${preview.insertRows} 人，更新 ${preview.updateRows} 人`, warnings),
      flattenSyncDiffRows('在编教职工基本信息', preview.diffs, 'sourceRecordId')
    )
    if (!selections) return

    const result = await window.salaryApi.applyTeacherDetailMasterSync(selections)
    ElMessage.success(
      `已更新人事信息：新增 ${result.insertedRows} 人，更新 ${result.updatedRows} 人`
    )
    await loadRecords()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '在编教职工信息同步失败')
  } finally {
    teacherDetailSyncPrompting = false
  }
}

function flattenSyncDiffRows(
  sourceName: string,
  diffs: Array<{
    idCard: string
    name: string
    action?: 'insert' | 'update'
    changes: Array<{ fieldName: string; currentValue: string; nextValue: string }>
    sourceRecordId?: number
    budgetRecordId?: number
    townshipRecordId?: number
  }>,
  sourceRecordKey: 'sourceRecordId' | 'budgetRecordId' | 'townshipRecordId'
): SyncDiffTableRow[] {
  return diffs.flatMap((diff) => {
    const sourceRecordId = diff[sourceRecordKey]
    return diff.changes.map((change) => ({
      key: `${sourceName}|${sourceRecordId ?? ''}|${diff.idCard}|${change.fieldName}`,
      sourceName,
      sourceRecordId,
      idCard: diff.idCard,
      name: diff.name,
      action: diff.action ?? 'update',
      fieldName: change.fieldName,
      currentValue: change.currentValue,
      nextValue: change.nextValue,
      selected: true
    }))
  })
}

function openSyncDiffDialog(
  title: string,
  summaryText: string,
  rows: SyncDiffTableRow[]
): Promise<MasterSyncSelectionItem[] | null> {
  syncDiffDialogTitle.value = title
  syncDiffDialogSummary.value = summaryText
  syncDiffRows.value = rows.map((row) => ({ ...row, selected: true }))
  syncDiffDialogVisible.value = true
  return new Promise((resolve) => {
    syncDiffResolver = resolve
  })
}

function buildHrMasterSyncWarnings(preview: HrMasterSyncPreview): string[] {
  return [
    ...(preview.missingIdCardRows
      ? [`${displayWorksheetName('在职工资')}有 ${preview.missingIdCardRows} 条缺少证件号码，未纳入人事信息匹配。`]
      : []),
    ...(preview.missingLookupRows
      ? [`${displayWorksheetName('在职工资')}有 ${preview.missingLookupRows} 条按工资金额未匹配到岗位/薪级对照，未纳入本次更新。`]
      : [])
  ]
}

function buildBudgetActiveMasterSyncWarnings(preview: BudgetActiveMasterSyncPreview): string[] {
  return preview.missingIdCardRows
    ? [`预算在职有 ${preview.missingIdCardRows} 条缺少证件号码，未纳入人事信息匹配。`]
    : []
}

function buildTeacherDetailMasterSyncWarnings(preview: TeacherDetailMasterSyncPreview): string[] {
  return preview.missingIdCardRows
    ? [`在编教职工基本信息有 ${preview.missingIdCardRows} 条缺少身份证号码，未纳入人事信息匹配。`]
    : []
}

function buildTownshipMasterSyncWarnings(preview: TownshipMasterSyncPreview): string[] {
  return preview.missingMasterRows
    ? [`乡镇补贴有 ${preview.missingMasterRows} 条身份证号在人事信息中未匹配到，未纳入本次更新。`]
    : []
}

function appendSyncSummaryWarnings(summary: string, warnings: string[]): string {
  if (warnings.length === 0) return summary
  return `${summary}；${warnings.join('；')}`
}

async function showIdCardLookupNotice(title: string, warnings: string[]): Promise<void> {
  if (warnings.length === 0) return
  await ElMessageBox.alert(
    warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join(''),
    title,
    {
      type: 'warning',
      confirmButtonText: '知道了',
      dangerouslyUseHTMLString: true
    }
  )
}

function confirmSyncDiffDialog() {
  const selected = syncDiffRows.value.filter((row) => row.selected)
  if (selected.length === 0) {
    ElMessage.warning('请至少勾选一条差异')
    return
  }
  syncDiffDialogVisible.value = false
  syncDiffResolver?.(
    selected.map((row) => ({
      sourceRecordId: row.sourceRecordId,
      idCard: row.idCard,
      fieldName: row.fieldName
    }))
  )
  syncDiffResolver = undefined
}

function cancelSyncDiffDialog() {
  syncDiffDialogVisible.value = false
  syncDiffResolver?.(null)
  syncDiffResolver = undefined
}

function setAllSyncDiffRows(selected: boolean) {
  syncDiffRows.value = syncDiffRows.value.map((row) => ({ ...row, selected }))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function handleTownshipImported() {
  if (townshipSyncPrompting) return
  townshipSyncPrompting = true
  try {
    const fillResult = await window.salaryApi.fillTownshipIdCardsByHrName()
    if (fillResult.updatedRows > 0) {
      ElMessage.success(`已根据人事信息补全乡镇补贴身份证号：${fillResult.updatedRows} 条`)
      await loadRecords()
    }
    if (fillResult.issues.length > 0) {
      await ElMessageBox.alert(buildTownshipNameIssueMessage(fillResult), '乡镇补贴身份证号提醒', {
        type: 'warning',
        confirmButtonText: '知道了',
        dangerouslyUseHTMLString: true
      })
    }

    const preview = await window.salaryApi.previewTownshipMasterSync()
    const warnings = buildTownshipMasterSyncWarnings(preview)
    if (preview.updatableRows === 0) {
      await showIdCardLookupNotice('乡镇补贴身份证匹配提醒', warnings)
      return
    }

    const selections = await openSyncDiffDialog(
      '发现人事信息差异',
      appendSyncSummaryWarnings(`乡镇补贴：更新 ${preview.updatableRows} 人`, warnings),
      flattenSyncDiffRows('乡镇补贴', preview.diffs, 'townshipRecordId')
    )
    if (!selections) return

    const result = await window.salaryApi.applyTownshipMasterSync(selections)
    ElMessage.success(`已更新人事信息：${result.updatedRows} 人`)
    await loadRecords()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '乡镇补贴同步失败')
  } finally {
    townshipSyncPrompting = false
  }
}

function unwrapIpc<T>(response: IpcResponse<T>): T {
  if (!response?.success) throw new Error(response?.error || '授权操作失败')
  return response.data as T
}

function getLicenseReasonText(status: LicenseStatus | null): string {
  if (!status) return '正在读取授权状态'
  if (status.valid) return '授权有效'
  const reasonMap: Record<string, string> = {
    not_found: '授权码不存在',
    expired: '授权已过期',
    disabled: '授权已停用',
    product_disabled: '产品授权已停用',
    missing_product_or_license: '请输入授权码',
    network_error: '无法连接授权中心',
    seats_exceeded: '授权电脑数量已达上限',
    device_mismatch: '授权文件不属于当前电脑',
    license_mismatch: '离线授权文件与当前授权码不一致',
    offline_invalid: '离线授权文件无效',
    offline_key_missing: '缺少离线授权公钥',
    clock_rollback: '检测到本机时间异常'
  }
  return status.message || reasonMap[status.reason || ''] || '授权无效'
}

function getLicenseSourceText(source?: string): string {
  if (source === 'online') return '在线校验'
  if (source === 'offline') return '离线授权'
  if (source === 'cache') return '本地缓存'
  return '未校验'
}

async function refreshLicenseStatus() {
  const status = unwrapIpc<LicenseStatus>(await window.salaryApi.licenseStatus())
  licenseStatus.value = status
  if (status.license_key && !licenseKey.value) licenseKey.value = status.license_key
}

async function refreshLicenseDevice() {
  licenseDevice.value = unwrapIpc<LicenseDeviceInfo>(
    await window.salaryApi.licenseDeviceInfo(licenseKey.value)
  )
}

async function bootstrapLicense() {
  if (!isLoggedIn.value) return
  licenseLoading.value = true
  try {
    licenseKey.value = unwrapIpc<string>(await window.salaryApi.licenseGetKey()) || ''
    await refreshLicenseStatus()
    await refreshLicenseDevice()
    if (licenseStatus.value?.valid !== true) {
      await claimTrialFromSavedUnitSettings(false)
    }
  } catch (error) {
    licenseStatus.value = {
      valid: false,
      reason: 'license_bootstrap_failed',
      message: error instanceof Error ? error.message : '读取授权状态失败'
    }
  } finally {
    licenseLoading.value = false
  }
}

async function claimTrialFromSavedUnitSettings(showMessage: boolean) {
  try {
    const settings = await window.salaryApi.getUnitSettings()
    const unitName = settings.unitFullName.trim()
    if (!unitName) return

    const status = unwrapIpc<LicenseStatus>(
      await window.salaryApi.licenseClaimTrial(unitName, settings.unitImportCode)
    )
    licenseStatus.value = status
    if (status.license_key) licenseKey.value = status.license_key
    await refreshLicenseDevice()
    if (status.valid && showMessage) {
      ElMessage.success('试用授权已自动开通')
    }
  } catch (error) {
    if (showMessage) {
      ElMessage.warning(error instanceof Error ? `自动授权失败：${error.message}` : '自动授权失败')
    }
  }
}

async function checkLicenseOnline() {
  if (!licenseKey.value.trim()) {
    ElMessage.warning('请输入授权码')
    return
  }
  licenseLoading.value = true
  try {
    unwrapIpc<void>(await window.salaryApi.licenseSaveKey(licenseKey.value))
    const status = unwrapIpc<LicenseStatus>(await window.salaryApi.licenseCheck(licenseKey.value))
    licenseStatus.value = status
    await refreshLicenseDevice()
    if (status.valid) {
      ElMessage.success('授权校验成功')
    } else {
      ElMessage.error(getLicenseReasonText(status))
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '授权校验失败')
  } finally {
    licenseLoading.value = false
  }
}

async function exportLicenseMachineRequest() {
  licenseLoading.value = true
  try {
    const result = unwrapIpc<{ canceled?: boolean; filePath?: string }>(
      await window.salaryApi.licenseExportMachineRequest(licenseKey.value)
    )
    if (!result.canceled) ElMessage.success('机器码文件已导出')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导出机器码失败')
  } finally {
    licenseLoading.value = false
  }
}

async function importOfflineLicense() {
  licenseLoading.value = true
  try {
    const result = unwrapIpc<{ canceled?: boolean; status?: LicenseStatus }>(
      await window.salaryApi.licenseImportOffline()
    )
    if (result.canceled) return
    if (result.status) licenseStatus.value = result.status
    await refreshLicenseDevice()
    if (result.status?.valid) {
      ElMessage.success('离线授权已导入')
    } else {
      ElMessage.error(getLicenseReasonText(result.status ?? licenseStatus.value))
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导入离线授权失败')
  } finally {
    licenseLoading.value = false
  }
}

function handleLogin() {
  const username = loginForm.value.username.trim()
  const password = loginForm.value.password.trim()
  if (!username || !password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }
  if (username !== loginUsername || password !== loginPassword) {
    ElMessage.error('用户名或密码错误')
    return
  }
  isLoggedIn.value = true
  if (loginRemember.value) {
    localStorage.setItem(loginStorageKey, loginStorageValue)
  } else {
    localStorage.removeItem(loginStorageKey)
  }
  ElMessage.success('登录成功')
  void bootstrapLicense()
}

async function loadAppVersion() {
  try {
    appVersion.value = await window.salaryApi.getAppVersion()
  } catch {
    appVersion.value = 'dev'
  }
}

function buildTownshipNameIssueMessage(result: TownshipIdCardFillResult): string {
  const rows = result.issues.slice(0, 30).map((issue) => {
    const reason =
      issue.reason === 'duplicate'
        ? `人事信息/${displayWorksheetName('在职工资')}/${displayWorksheetName('退休工资')}中有 ${issue.matchedCount} 个同名不同证件号`
        : `人事信息/${displayWorksheetName('在职工资')}/${displayWorksheetName('退休工资')}中未查到`
    return `<li>${escapeHtml(issue.name || `第 ${issue.rowId} 行`)}：${escapeHtml(reason)}</li>`
  })
  const more = result.issues.length > 30 ? `<p>仅显示前 30 条，另有 ${result.issues.length - 30} 条未展示。</p>` : ''
  return [
    `<p>身份证号已自动更新 ${result.updatedRows} 条；查不到 ${result.notFoundRows} 条，重名 ${result.duplicateRows} 条。</p>`,
    `<ul style="max-height: 280px; overflow: auto; padding-left: 18px; margin: 8px 0;">${rows.join('')}</ul>`,
    more
  ].join('')
}

async function promptPendingMasterSyncs() {
  try {
    const preview = await window.salaryApi.previewHrMasterSyncFromIntegrated()
    if (preview.masterRows === 0 && preview.updatableRows > 0) {
      await promptHrMasterSync()
    }
  } catch {
    // 启动补偿检查只做机会性提醒，缺表或对照数据未准备好时不打断主界面。
  }
  try {
    const preview = await window.salaryApi.previewBudgetActiveMasterSync()
    if (preview.masterRows === 0 && preview.updatableRows > 0) {
      await promptBudgetActiveMasterSync()
    }
  } catch {
    // 同上：预算在职尚未导入时不打断主界面。
  }
  try {
    const preview = await window.salaryApi.previewTeacherDetailMasterSync()
    if (preview.masterRows === 0 && preview.updatableRows > 0) {
      await promptTeacherDetailMasterSync()
    }
  } catch {
    // 同上：在编教职工基本信息尚未导入时不打断主界面。
  }
}

async function onSettingsChanged() {
  await refreshImportWatcher()
  monthlyPayrollRefreshKey.value += 1
  await bootstrapLicense()
  await loadRecords()
}

async function openSettingsWorksheet(name: string) {
  const worksheet = summary.value?.worksheets.find((item) => item.name === name)
  if (!worksheet) {
    ElMessage.error(`未找到工作表：${name}`)
    return
  }
  activeModuleKey.value = 'lookups'
  selectedWorksheetId.value = worksheet.worksheetId
  settingsDialogVisible.value = false
}

const worksheetOptions = computed(() =>
  (summary.value?.worksheets ?? []).map((item) => ({
    worksheetId: item.worksheetId,
    name: displayWorksheetName(item.name)
  }))
)

onMounted(() => {
  void loadAppVersion()
  void bootstrapLicense()
  void loadSummary()
  void loadWorkflows()
  void refreshImportWatcher().then(() => promptPendingMasterSyncs())
  importWatcherTimer = setInterval(() => {
    // 窗口不可见时暂停轮询，节省资源
    if (document.visibilityState === 'hidden') return
    if (!importWatcherLoading.value) void refreshImportWatcher()
  }, 5000)
  // 注册"切换到一体化对接"回调，供 MonthlyPayrollPage 推送队列跳转用
  setSwitchToIntegration(() => {
    activeModuleKey.value = 'integration'
  })
})

onUnmounted(() => {
  setSwitchToIntegration(null)
  if (importWatcherTimer) clearInterval(importWatcherTimer)
})
</script>

<template>
  <section v-if="!isLoggedIn" class="login-container">
    <div class="login-card">
      <div class="login-header">
        <div class="login-mark">资</div>
        <h1>工资系统</h1>
        <p>工资业务与数据管理工作台</p>
      </div>

      <el-form :model="loginForm" label-position="top" autocomplete="on" @submit.prevent="handleLogin">
        <el-form-item label="用户名">
          <el-input
            v-model="loginForm.username"
            :prefix-icon="User"
            name="username"
            autocomplete="username"
            placeholder="请输入用户名"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="loginForm.password"
            :prefix-icon="Lock"
            type="password"
            name="password"
            autocomplete="current-password"
            placeholder="请输入密码"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-checkbox v-model="loginRemember" class="login-remember">保持登录</el-checkbox>
        <el-button type="primary" native-type="submit" class="login-button">立即登录</el-button>
      </el-form>

      <div class="login-footer">
        <p>版本: v{{ appVersion }}</p>
        <p>© 2026 老九 版权所有</p>
        <p>授权单位内部使用</p>
      </div>
    </div>
  </section>

  <div v-else-if="isLicenseValid" class="md-shell">
    <header class="md-topbar">
      <div class="md-brand">
        <div class="md-brand-mark">资</div>
        <div class="md-brand-text">
          <strong>工资系统</strong>
          <small>独立桌面版</small>
        </div>
      </div>

      <nav class="md-modules">
        <button
          v-for="module in modules"
          v-show="!module.hidden"
          :key="module.key"
          class="md-module-tab"
          :class="{ active: activeModuleKey === module.key }"
          @click="activeModuleKey = module.key"
        >
          {{ module.label }}
        </button>
      </nav>

      <div class="md-topbar-actions">
        <span class="md-copyright">© 2026 老九 版权所有</span>
        <el-popover placement="bottom-end" width="420" trigger="click" popper-class="import-notice-popover">
          <template #reference>
            <button class="md-import-notice" :class="{ failed: failedImportCount > 0 }">
              <el-badge :value="failedImportCount || ''" :hidden="failedImportCount === 0" type="danger">
                <el-icon><Bell /></el-icon>
              </el-badge>
              <span v-if="failedImportCount > 0" class="md-import-notice-text">
                {{ failedImportCount }} 个提醒
              </span>
              <span v-else-if="latestImportLog" class="md-import-notice-text">
                {{ noticeKindText(latestImportLog) }}
              </span>
              <span v-else class="md-import-notice-text">系统通知</span>
            </button>
          </template>

          <div class="md-import-popover">
            <div class="md-import-popover-title">
              <strong>系统通知</strong>
              <small v-if="failedImportCount > 0">提醒优先显示</small>
              <button
                class="md-import-clear"
                @click="showAllLookupFailures"
              >
                全部失败日志
              </button>
              <button
                class="md-import-clear"
                :disabled="importNotifications.length === 0"
                @click="clearImportNotifications"
              >
                清空
              </button>
            </div>
            <div v-if="importNotifications.length" class="md-import-popover-list">
              <div
                v-for="log in importNotifications"
                :key="getImportLogKey(log)"
                class="md-import-popover-item"
                :class="{ failed: !log.ok, clickable: !log.ok }"
                @click="showLookupFailureDetails(log)"
              >
                <el-icon>
                  <CircleCheck v-if="log.ok" />
                  <CircleClose v-else />
                </el-icon>
                <div>
                  <strong>
                    {{ log.ok ? '成功' : log.worksheetName === '工作流' ? '提示' : '失败' }} · {{ log.fileName }}
                    <span v-if="!log.ok" class="md-import-hint">点击查看详情</span>
                  </strong>
                  <span>{{ log.message || (log.ok ? `导入 ${log.importedRows} 行` : '导入失败') }}</span>
                </div>
              </div>
            </div>
            <div v-else class="md-import-popover-empty">暂无系统通知</div>
          </div>
        </el-popover>
        <el-tooltip content="Excel 导入" placement="bottom">
          <button class="md-icon-btn" @click="importDialogVisible = true">
            <el-icon><Upload /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="设置 / 备份" placement="bottom">
          <button class="md-icon-btn" @click="settingsDialogVisible = true">
            <el-icon><Setting /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </header>

    <div class="md-main">
      <div v-if="activeModuleKey === 'pivot'" class="md-pivot-wrapper">
        <div class="md-pivot-tabs">
          <button
            class="md-pivot-tab"
            :class="{ active: pivotSubTab === 'reports' }"
            @click="pivotSubTab = 'reports'"
          >
            统计报表
          </button>
          <button
            class="md-pivot-tab"
            :class="{ active: pivotSubTab === 'pivot' }"
            @click="pivotSubTab = 'pivot'"
          >
            自定义透视
          </button>
        </div>
        <StatReportPage v-if="pivotSubTab === 'reports'" />
        <PivotPage v-else :summary="summary" source-worksheet-id="local-hr-info" />
      </div>

      <IntegratedPortalPage v-else-if="activeModuleKey === 'integration'" />

      <template v-else-if="activeModuleKey === 'payroll'">
        <aside class="md-sidebar">
          <div class="md-sidebar-list">
            <div
              class="md-sidebar-item"
              :class="{ active: payrollSubTab === 'monthly' }"
              @click="payrollSubTab = 'monthly'"
            >
              <el-icon><Tickets /></el-icon>
              <span>工资报账</span>
            </div>
            <div
              class="md-sidebar-item"
              :class="{ active: payrollSubTab === 'performance' }"
              @click="payrollSubTab = 'performance'"
            >
              <el-icon><Tickets /></el-icon>
              <span>绩效工资</span>
            </div>
            <div
              class="md-sidebar-item"
              :class="{ active: payrollSubTab === 'annualAdjustment' }"
              @click="payrollSubTab = 'annualAdjustment'"
            >
              <el-icon><Tickets /></el-icon>
              <span>社保个税</span>
            </div>
          </div>
        </aside>
        <main class="md-content">
          <MonthlyPayrollPage
            v-if="payrollSubTab === 'monthly'"
            :import-watcher="importWatcher"
            :loading="importWatcherLoading"
            :refresh-key="monthlyPayrollRefreshKey"
            @refresh="refreshImportWatcher"
            @workflow-notice="pushWorkflowNotice"
          />
          <PerformancePayrollPage v-else-if="payrollSubTab === 'performance'" />
          <AnnualAdjustmentPage
            v-else
            :import-watcher="importWatcher"
            :loading="importWatcherLoading"
            @refresh="refreshImportWatcher"
            @open-folder="openImportWatcherFolder"
          />
        </main>
      </template>

      <template v-if="activeModuleKey !== 'pivot' && activeModuleKey !== 'payroll' && activeModuleKey !== 'integration'">
        <aside class="md-sidebar">
          <div class="md-sidebar-list">
            <div
              v-for="table in tablesInModule"
              :key="table.worksheetId"
              class="md-sidebar-item"
              :class="{ active: selectedWorksheetId === table.worksheetId }"
              @click="selectedWorksheetId = table.worksheetId"
            >
              <el-icon><Tickets /></el-icon>
              <span>{{ displayWorksheetName(table.name) }}</span>
            </div>
            <div v-if="tablesInModule.length === 0" class="md-sidebar-empty">本模块暂无工作表</div>
          </div>
        </aside>

        <main class="md-content">
          <el-alert
            v-if="error"
            type="error"
            :title="error"
            show-icon
            :closable="false"
            style="margin: 12px 16px"
          />

          <WorksheetView
            v-if="selectedWorksheet"
            :worksheet="selectedWorksheet"
            :display-name="displayWorksheetName(selectedWorksheet.name)"
            :records="worksheetRecords"
            :records-loading="recordsLoading"
            :page="page"
            :page-size="pageSize"
            :all-page-size="ALL_PAGE_SIZE"
            :search="search"
            :active-view="activeView"
            :workflows="workflows"
            :workflow-running-key="workflowRunningKey"
            @create="openCreateDialog"
            @edit="openEditDialog"
            @delete="deleteRecord"
            @delete-many="deleteRecords"
            @clear="clearCurrentWorksheet"
            @export="exportCurrentWorksheet"
            @refresh="loadRecords"
            @page-change="(value) => (page = value)"
            @search-change="(value) => (search = value)"
            @view-change="changeView"
            @sort-change="onSortChange"
            @page-size-change="onPageSizeChange"
            @show-fields="fieldDialogVisible = true"
            @run-workflow="runWorkflow"
          />

          <div v-else class="md-empty-main">
            <strong>选择左侧工作表</strong>
          </div>
        </main>
      </template>
    </div>

    <RecordFormDialog
      v-if="selectedWorksheet"
      v-model="recordDialogVisible"
      :worksheet-name="displayWorksheetName(selectedWorksheet.name)"
      :fields="selectedWorksheet.fields"
      :initial-values="recordDialogInitial"
      :mode="recordDialogMode"
      :saving="recordSaving"
      @submit="submitRecord"
    />

    <FieldStructureDialog
      v-if="selectedWorksheet"
      v-model="fieldDialogVisible"
      :worksheet-name="displayWorksheetName(selectedWorksheet.name)"
      :fields="selectedWorksheet.fields"
      :saving="fieldSaving"
      @save="saveFields"
    />

    <ImportDialog
      v-model="importDialogVisible"
      :worksheets="worksheetOptions"
      :preferred-worksheet-id="selectedWorksheetId"
      @imported="onImported"
    />

    <el-dialog
      v-model="syncDiffDialogVisible"
      :title="syncDiffDialogTitle"
      width="1180px"
      :close-on-click-modal="false"
      @closed="cancelSyncDiffDialog"
    >
      <div class="md-sync-diff-toolbar">
        <span>{{ syncDiffDialogSummary }}，共 {{ syncDiffRows.length }} 项差异，已选 {{ syncDiffSelectedCount }} 项</span>
        <div>
          <el-button size="small" @click="setAllSyncDiffRows(true)">全选</el-button>
          <el-button size="small" @click="setAllSyncDiffRows(false)">全不选</el-button>
        </div>
      </div>
      <el-table :data="syncDiffRows" border stripe height="460" size="small">
        <el-table-column width="54" align="center">
          <template #header>
            <el-checkbox
              :model-value="syncDiffAllSelected"
              :indeterminate="syncDiffSelectedCount > 0 && !syncDiffAllSelected"
              @change="(value: boolean) => setAllSyncDiffRows(Boolean(value))"
            />
          </template>
          <template #default="{ row }">
            <el-checkbox v-model="row.selected" />
          </template>
        </el-table-column>
        <el-table-column prop="sourceName" label="来源表" width="150" />
        <el-table-column prop="action" label="操作" width="80">
          <template #default="{ row }">{{ row.action === 'insert' ? '新增' : '更新' }}</template>
        </el-table-column>
        <el-table-column prop="name" label="姓名" width="120" show-overflow-tooltip />
        <el-table-column prop="idCard" label="身份证号" width="190" show-overflow-tooltip />
        <el-table-column prop="fieldName" label="字段" width="140" show-overflow-tooltip />
        <el-table-column prop="currentValue" label="人事信息当前值" min-width="210" show-overflow-tooltip>
          <template #default="{ row }">{{ row.currentValue || '空' }}</template>
        </el-table-column>
        <el-table-column prop="nextValue" label="来源表新值" min-width="210" show-overflow-tooltip />
      </el-table>
      <template #footer>
        <el-button @click="cancelSyncDiffDialog">暂不更新</el-button>
        <el-button
          type="primary"
          :disabled="syncDiffSelectedCount === 0"
          @click="confirmSyncDiffDialog"
        >
          更新已选 {{ syncDiffSelectedCount }} 项
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="annualReportDialogVisible" title="生成工资年报" width="640px">
      <el-form label-width="150px" label-position="right">
        <el-form-item label="奖励性绩效工资总数">
          <el-input-number v-model="annualReportForm.totalPerformance" :min="0" :precision="0" />
        </el-form-item>
        <el-form-item label="班主任费增核总数">
          <el-input-number v-model="annualReportForm.totalHeadTeacher" :min="0" :precision="0" />
        </el-form-item>
        <el-form-item label="延时费总数">
          <el-input-number v-model="annualReportForm.totalOvertime" :min="0" :precision="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="annualReportDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="workflowRunningKey === 'annual-report.generate'" @click="submitAnnualReport">
          生成
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="lookupFailureDialogVisible" :title="lookupFailureTitle" width="980px">
      <el-table
        v-loading="lookupFailureLoading"
        :data="lookupFailureRows"
        border
        stripe
        height="420"
        size="small"
      >
        <el-table-column prop="createdAt" label="时间" width="170" />
        <el-table-column prop="worksheet" label="来源表" width="130" />
        <el-table-column prop="idCard" label="证件号码" width="190" />
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column prop="lookupTable" label="查询表" width="130" />
        <el-table-column prop="lookupKey" label="查询键" width="110" />
        <el-table-column prop="reason" label="原因" min-width="260" show-overflow-tooltip />
      </el-table>
      <template #footer>
        <el-button type="primary" @click="lookupFailureDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>

  </div>

  <section v-else class="login-container license-gate">
    <div class="login-card license-card">
      <div class="login-header">
        <div class="login-mark">资</div>
        <h1>授权校验</h1>
        <p>当前电脑需要有效授权后才能进入业务模块</p>
      </div>

      <el-alert
        class="license-alert"
        :type="licenseStatus?.reason === 'network_error' ? 'warning' : 'error'"
        :title="getLicenseReasonText(licenseStatus)"
        show-icon
        :closable="false"
      />

      <el-form label-position="top" @submit.prevent="checkLicenseOnline">
        <el-form-item label="授权码">
          <el-input
            v-model="licenseKey"
            placeholder="请输入授权码"
            clearable
            @keyup.enter="checkLicenseOnline"
          />
        </el-form-item>

        <div class="license-actions">
          <el-button type="primary" :loading="licenseLoading" native-type="submit">
            在线校验
          </el-button>
          <el-button :loading="licenseLoading" @click="importOfflineLicense">
            导入离线授权
          </el-button>
          <el-button :loading="licenseLoading" @click="exportLicenseMachineRequest">
            导出机器码
          </el-button>
          <el-button :loading="licenseLoading" @click="claimTrialFromSavedUnitSettings(true)">
            自动开通试用
          </el-button>
          <el-button @click="settingsDialogVisible = true">
            单位设置
          </el-button>
        </div>
      </el-form>

      <div class="license-meta">
        <span>校验来源：{{ getLicenseSourceText(licenseStatus?.source) }}</span>
        <span v-if="licenseStatus?.customer_name">授权单位：{{ licenseStatus.customer_name }}</span>
        <span v-if="licenseStatus?.expires_at">到期日期：{{ licenseStatus.expires_at }}</span>
        <span v-if="licenseDevice?.device_id">机器码：{{ licenseDevice.device_id }}</span>
      </div>
    </div>
  </section>

  <SettingsDialog
    v-if="isLoggedIn"
    v-model="settingsDialogVisible"
    :import-watcher="importWatcher"
    :database-path="summary?.databasePath ?? ''"
    @changed="onSettingsChanged"
    @open-worksheet="openSettingsWorksheet"
  />
</template>

<style scoped>
.login-container {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background:
    linear-gradient(180deg, rgba(47, 84, 235, 0.92) 0%, rgba(30, 58, 138, 0.96) 100%),
    var(--bg);
}

.login-card {
  width: 400px;
  padding: 34px 38px 30px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.24);
}

.login-header {
  margin-bottom: 30px;
  text-align: center;
}

.login-mark {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  margin: 0 auto 16px;
  color: #ffffff;
  font-size: 24px;
  font-weight: 800;
  background: #2f54eb;
  border-radius: 6px;
  box-shadow: 0 8px 20px rgba(47, 84, 235, 0.24);
}

.login-header h1 {
  margin: 0 0 8px;
  color: var(--text);
  font-size: 24px;
  font-weight: 700;
}

.login-header p {
  margin: 0;
  color: var(--text-3);
  font-size: 13px;
}

.login-remember {
  margin-top: 2px;
}

.login-button {
  width: 100%;
  height: 38px;
  margin-top: 16px;
}

.login-footer {
  margin-top: 30px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.login-footer p {
  margin: 0;
}

.login-footer p + p {
  margin-top: 6px;
}

.license-gate {
  padding: 24px;
}

.license-card {
  width: min(560px, calc(100vw - 48px));
}

.license-alert {
  margin-bottom: 18px;
}

.license-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}

.license-actions .el-button {
  margin-left: 0;
}

.license-meta {
  display: grid;
  gap: 7px;
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 12.5px;
}

.md-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 1100px;
  background: var(--bg);
}

/* ===== 顶栏：蓝色主色调 ===== */
.md-topbar {
  display: flex;
  align-items: center;
  height: 52px;
  padding: 0 20px;
  background: #2f54eb;
  color: #ffffff;
  position: sticky;
  top: 0;
  z-index: 20;
  flex-shrink: 0;
}

.md-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 180px;
}

.md-brand-mark {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.22);
  color: #ffffff;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
}

.md-brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.md-brand-text strong {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  letter-spacing: -0.01em;
}

.md-brand-text small {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.65);
  font-family: var(--mono);
}

/* ===== 模块导航标签 ===== */
.md-modules {
  display: flex;
  flex: 1;
  gap: 0;
  align-items: stretch;
  padding: 0 16px;
  height: 100%;
}

.md-module-tab {
  display: inline-flex;
  align-items: center;
  padding: 0 16px;
  height: 100%;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: rgba(255, 255, 255, 0.72);
  font-size: 13px;
  font: inherit;
  cursor: pointer;
  position: relative;
  transition: color 0.12s;
  white-space: nowrap;
}

.md-module-tab:hover {
  color: #ffffff;
}

.md-module-tab.active {
  color: #ffffff;
  font-weight: 600;
  border-bottom-color: #ffffff;
}

/* ===== 顶栏右侧操作区 ===== */
.md-topbar-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.md-copyright {
  margin-right: 8px;
  color: rgba(255, 255, 255, 0.62);
  font-size: 11.5px;
  white-space: nowrap;
}

.md-import-notice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 160px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: var(--radius);
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  font-size: 12.5px;
  font: inherit;
  transition: background 0.12s;
}

.md-import-notice:hover {
  background: rgba(255, 255, 255, 0.18);
}

.md-import-notice.failed {
  border-color: #fecdca;
  background: rgba(220, 38, 38, 0.4);
  color: #fecaca;
}

.md-import-notice-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.md-import-popover {
  display: grid;
  gap: 10px;
}

.md-import-popover-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.md-import-popover-title strong {
  font-size: 14px;
  flex: 1;
}

.md-import-popover-title small {
  color: var(--text-3);
  font-size: 11.5px;
}

.md-import-clear {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--gray-text);
  cursor: pointer;
  font-size: 11.5px;
  font: inherit;
  transition: background 0.12s;
}

.md-import-clear:hover:not(:disabled) {
  background: var(--gray-soft);
  border-color: var(--primary);
  color: var(--primary);
}

.md-import-clear:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.md-import-popover-list {
  display: grid;
  gap: 0;
  max-height: 320px;
  overflow: auto;
}

.md-import-popover-item {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
  color: var(--success);
}

.md-import-popover-item.failed {
  color: var(--danger);
}

.md-import-popover-item.clickable {
  cursor: pointer;
}

.md-import-popover-item.clickable:hover {
  background: var(--danger-soft);
}

.md-import-popover-item.clickable:hover .md-import-hint {
  display: inline;
}

.md-import-hint {
  display: none;
  font-size: 11px;
  color: var(--danger);
  margin-left: 4px;
}

.md-import-popover-item div {
  min-width: 0;
}

.md-import-popover-item strong,
.md-import-popover-item span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.md-import-popover-item strong {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.md-import-popover-item span {
  margin-top: 2px;
  color: var(--text-3);
  font-size: 12px;
}

.md-import-popover-empty {
  padding: 20px 0;
  color: var(--text-muted);
  text-align: center;
  font-size: 12.5px;
}

:global(.import-error-dialog .el-message-box__message) {
  white-space: pre-line;
}

.md-icon-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: var(--radius);
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  font-size: 16px;
  transition: background 0.12s;
}

.md-icon-btn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

/* ===== 主体区域 ===== */
.md-main {
  display: flex;
  flex: 1;
  min-height: 0;
  background: var(--bg);
}

.md-sync-diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--text-2);
  font-size: 13px;
}

/* ===== 左侧工作表列表 ===== */
.md-sidebar {
  flex: 0 0 200px;
  border-right: 1px solid var(--border);
  background: var(--surface);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.md-sidebar-list {
  padding: 8px 0;
  flex: 1;
}

.md-sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  color: var(--text-2);
  cursor: pointer;
  font-size: 13px;
  user-select: none;
  border-left: 3px solid transparent;
  transition: background 0.1s;
}

.md-sidebar-item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.md-sidebar-item.active {
  background: var(--primary-soft);
  color: var(--primary-text);
  font-weight: 500;
  border-left-color: var(--primary);
}

.md-sidebar-empty {
  padding: 14px 14px;
  color: var(--text-muted);
  font-size: 12.5px;
}

/* ===== 内容区 ===== */
.md-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}

.md-empty-main {
  display: grid;
  place-content: center;
  flex: 1;
  color: var(--text-muted);
  font-size: 13px;
}

.md-pivot-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.md-pivot-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 16px 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

.md-pivot-tab {
  padding: 7px 18px;
  border: 0;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font: inherit;
  position: relative;
}

.md-pivot-tab:hover {
  color: var(--text);
  background: var(--gray-soft);
}

.md-pivot-tab.active {
  color: var(--primary);
  font-weight: 600;
  background: var(--primary-soft);
}

.md-pivot-tab.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--primary);
}
</style>
