<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Clock, DocumentChecked, FolderOpened, Printer, Refresh, VideoPlay } from '@element-plus/icons-vue'
import { pushInProgress, type PushStep } from '../integration/insurancePushQueue'
import {
  appendInsurancePushStep,
  appendSalaryPushSteps,
  appendVoucherPushStep,
  canPushAll,
  confirmPushTargets,
  enqueueIntegratedPush,
  historyPushLabel,
  pushStatusForTarget,
  pushTargetText,
  pushTargetsForRow,
  reconciliationGuardMessage
} from '../integration/integratedPushController'
import { importExchangePackageInteractive } from '../integration/exchangePackageImport'
import {
  archiveRunInteractive,
  buildReceiptInteractive,
  canArchiveRun
} from '../integration/monthlyRunLifecycle'
import {
  cachedMonthlyPayrollPrintersFallback,
  loadCachedMonthlyPayrollPrintOptions,
  updateCachedMonthlyPayrollPrintOptions
} from '../monthly-payroll/printOptionsCache'
import {
  buildMergeMap,
  colWidthPercents,
  formatCurrency,
  isCustomStyledSheet,
  isRetiredHousingSheetName,
  isSalaryVoucher,
  mergeFor,
  reportSheetClass,
  rowHeightStyle,
  voucherAmount,
  voucherUpperAmount,
  voucherUsageLines,
  type MergeEntry
} from '../monthly-payroll/reportPresentation'
import type {
  ImportWatcherStatus,
  MonthlyPayrollDataSourceMode,
  MonthlyPayrollExchangeStatus,
  MonthlyPayrollSettings,
  MonthlyPayrollPushGuardResult,
  MonthlyPayrollReconciliationResult,
  MonthlyPayrollReportResult,
  MonthlyPayrollReportSheet,
  MonthlyPayrollPrintSettings,
  MonthlyPayrollRun,
  MonthlyPayrollSalaryPrintPageSummary,
  MonthlyPayrollSourcePeriodInspection,
  MonthlyPayrollSourceKind,
  MonthlyPayrollSourceVersion,
  MonthlyPayrollPushTarget,
  MonthlyPayrollWriteBackPreview,
  PrintRequest,
  PrinterSummary,
  WorkflowRunPayload,
  WorkflowRunResult
} from '@shared/types'

const props = defineProps<{
  importWatcher?: ImportWatcherStatus | null
  loading?: boolean
  refreshKey?: number
}>()

const emit = defineEmits<{
  refresh: []
  workflowNotice: [result: WorkflowRunResult]
}>()

const running = ref(false)
const generating = ref(false)
const result = ref<WorkflowRunResult | null>(null)
const generateResult = ref<WorkflowRunResult | null>(null)
const report = ref<MonthlyPayrollReportResult | null>(null)
const activeReportSheet = ref('')
const printPageRangeText = ref('')
const showA4DebugBorder = ref(false)
const history = ref<MonthlyPayrollRun[]>([])
const historyLoading = ref(false)
const sourceVersions = ref<MonthlyPayrollSourceVersion[]>([])
const switchingSourceVersionId = ref<number | null>(null)
const selectedReportRunId = ref<number | null>(null)
const archivingId = ref<number | null>(null)
const cancelingMonthCloseId = ref<number | null>(null)
const buildingExchangePackageId = ref<number | null>(null)
const buildingExchangeReceiptId = ref<number | null>(null)
const importingExchangePackage = ref(false)
const printers = ref<PrinterSummary[]>([])
const printSettings = ref<MonthlyPayrollPrintSettings>({
  reportPrinterName: '',
  reportOffsetX: 3,
  voucherPrinterName: '',
  voucherOffsetX: 10,
  voucherOffsetY: 10,
  voucherOffsetPresetVersion: 1
})
const payrollSettings = reactive<MonthlyPayrollSettings>({
  taxField: '补扣工资'
})
const payrollSettingsSaving = ref(false)
const printing = ref(false)
const voucherPrintTotalPages = ref<number | null>(null)
const voucherPrintTotalPagesLoading = ref(false)
// 与后端凭证规则一致：保险固定 7 页，报销凭证里的“附件页数”在导出表第 15 列。
const INSURANCE_VOUCHER_ATTACHMENT_PAGES = 7
const VOUCHER_ATTACHMENT_PAGES_INDEX = 14

onMounted(() => {
  void refreshHistory({ autoOpenCurrentMonth: true })
  void loadPrintOptions()
  void loadMonthlyPayrollSettings()
})

watch(
  () => props.refreshKey,
  () => {
    void refreshHistory()
  }
)

// 推送在"一体化"页执行并把状态写入数据库；推送结束（pushInProgress 由真转假）后
// 自动刷新历史，确保报表里的"凭证/保险/工资 推送状态"及时反映出来。
watch(pushInProgress, (current, previous) => {
  if (previous && !current) void refreshHistory()
})

function applyPrintOptions(nextPrinters: PrinterSummary[], settings: MonthlyPayrollPrintSettings) {
  printers.value = nextPrinters
  printSettings.value = {
    reportPrinterName: settings.reportPrinterName || nextPrinters.find((item: PrinterSummary) => item.isDefault)?.name || '',
    reportOffsetX: Number(settings.reportOffsetX ?? 3),
    voucherPrinterName: settings.voucherPrinterName || '',
    voucherOffsetX: Number(settings.voucherOffsetX ?? 0),
    voucherOffsetY: Number(settings.voucherOffsetY ?? 0)
  }
}

async function loadPrintOptions() {
  const options = await loadCachedMonthlyPayrollPrintOptions(() =>
    Promise.all([
      window.salaryApi.listPrinters(),
      window.salaryApi.getMonthlyPayrollPrintSettings()
    ]).then(([nextPrinters, settings]) => ({
      printers: nextPrinters,
      settings
    }))
  )
  applyPrintOptions(options.printers, options.settings)
}

async function savePrintSettings() {
  const settings = await window.salaryApi.setMonthlyPayrollPrintSettings({
    ...printSettings.value
  })
  const options = updateCachedMonthlyPayrollPrintOptions({
    printers: cachedMonthlyPayrollPrintersFallback(printers.value),
    settings
  })
  applyPrintOptions(options.printers, settings)
}

async function loadMonthlyPayrollSettings(): Promise<void> {
  try {
    const next = await window.salaryApi.getMonthlyPayrollSettings()
    Object.assign(payrollSettings, next)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '读取个税规则设置失败')
  }
}

async function saveTaxRuleSettings(): Promise<void> {
  payrollSettingsSaving.value = true
  try {
    const next = await window.salaryApi.setMonthlyPayrollSettings({
      taxField: payrollSettings.taxField
    })
    Object.assign(payrollSettings, next)
    ElMessage.success('个税规则设置已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存个税规则设置失败')
  } finally {
    payrollSettingsSaving.value = false
  }
}

async function refreshHistory(options: { autoOpenCurrentMonth?: boolean } = {}): Promise<MonthlyPayrollRun[]> {
  historyLoading.value = true
  try {
    const nextHistory = await window.salaryApi.listMonthlyPayrollRuns()
    history.value = nextHistory
    await refreshSourceVersions()
    if (options.autoOpenCurrentMonth) {
      await openLatestSelectedMonthReport(nextHistory)
    }
    return nextHistory
  } finally {
    historyLoading.value = false
  }
}

async function refreshSourceVersions(): Promise<void> {
  try {
    const period = selectedPeriod.value
    sourceVersions.value = await window.salaryApi.listMonthlyPayrollSourceVersions(
      period.year,
      period.month
    )
  } catch (error) {
    console.warn('读取本月数据源版本失败', error)
  }
}

async function openHistoryFile(path: string | null) {
  if (!path) return
  const err = await window.salaryApi.openLocalPath(path)
  if (err) ElMessage.error(`无法打开：${err}`)
}

async function buildExchangePackageForRun(row: MonthlyPayrollRun): Promise<void> {
  if (row.archivedAt || row.isOutdated) {
    ElMessage.warning('已月结或已过期记录不能生成内网业务包')
    return
  }
  buildingExchangePackageId.value = row.id
  try {
    const result = await window.salaryApi.buildMonthlyPayrollExchangePackage(row.id)
    ElMessage.success(result.copiedToMedia ? `已生成并复制到摆渡目录：${result.packageId}` : `已生成内网业务包：${result.packageId}`)
    if (result.warnings.length > 0) {
      await ElMessageBox.alert(result.warnings.join('\n'), '业务包生成提醒', {
        type: 'warning',
        confirmButtonText: '知道了'
      })
    }
    await refreshHistory({ autoOpenCurrentMonth: true })
    await window.salaryApi.openLocalPath((result.mediaPath || result.packagePath).replace(/[\\/][^\\/]*$/, ''))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生成内网业务包失败')
  } finally {
    buildingExchangePackageId.value = null
  }
}

async function buildExchangeReceiptForRun(row: MonthlyPayrollRun): Promise<void> {
  buildingExchangeReceiptId.value = row.id
  try {
    if (await buildReceiptInteractive(row)) {
      await refreshHistory({ autoOpenCurrentMonth: true })
    }
  } finally {
    buildingExchangeReceiptId.value = null
  }
}

async function chooseAndImportExchangePackage(): Promise<void> {
  importingExchangePackage.value = true
  try {
    if (await importExchangePackageInteractive()) {
      await refreshHistory({ autoOpenCurrentMonth: true })
    }
  } finally {
    importingExchangePackage.value = false
  }
}

const pushingInsuranceRunId = ref<number | null>(null)
const pushingVoucherRunId = ref<number | null>(null)
const pushingSalaryRunId = ref<number | null>(null)
const pushingAllRunId = ref<number | null>(null)

async function pushAllToIntegrated(row: MonthlyPayrollRun): Promise<void> {
  const targets = pushTargetsForRow(row)
  if (!targets.length) {
    ElMessage.warning('该记录没有可推送到一体化的文件')
    return
  }
  if (!(await confirmPushTargets(row, targets))) return
  pushingAllRunId.value = row.id
  try {
    const label = historyPushLabel(row)
    const steps: PushStep[] = []
    const stepHints: string[] = []
    await appendInsurancePushStep(row, label, steps, stepHints)
    await appendSalaryPushSteps(row, label, steps, stepHints)
    await appendVoucherPushStep(row, label, steps, stepHints)
    enqueueIntegratedPush(steps, stepHints, '全部推送', {
      mode: 'full-auto',
      label,
      runId: row.id,
      month: row.month
    })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    setTimeout(() => {
      if (pushingAllRunId.value === row.id) pushingAllRunId.value = null
    }, 800)
  }
}

async function pushInsuranceToIntegrated(row: MonthlyPayrollRun): Promise<void> {
  if (!row.insuranceImportPath) {
    ElMessage.warning('该记录没有保险导入文件可推送')
    return
  }
  if (!(await confirmPushTargets(row, ['insurance']))) return
  pushingInsuranceRunId.value = row.id
  try {
    const label = historyPushLabel(row)
    const steps: PushStep[] = []
    const stepHints: string[] = []
    await appendInsurancePushStep(row, label, steps, stepHints)
    enqueueIntegratedPush(steps, stepHints, '保险推送')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    setTimeout(() => {
      if (pushingInsuranceRunId.value === row.id) pushingInsuranceRunId.value = null
    }, 800)
  }
}

async function pushVoucherToIntegrated(row: MonthlyPayrollRun): Promise<void> {
  if (!row.voucherImportPath) {
    ElMessage.warning('该记录没有凭证文件可推送')
    return
  }
  if (!(await confirmPushTargets(row, ['voucher']))) return
  pushingVoucherRunId.value = row.id
  try {
    const label = historyPushLabel(row)
    const steps: PushStep[] = []
    const stepHints: string[] = []
    await appendVoucherPushStep(row, label, steps, stepHints)
    enqueueIntegratedPush(steps, stepHints, '凭证推送')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    setTimeout(() => {
      if (pushingVoucherRunId.value === row.id) pushingVoucherRunId.value = null
    }, 800)
  }
}

async function pushSalaryImportsToIntegrated(row: MonthlyPayrollRun): Promise<void> {
  if (!row.salaryImportPath && !row.payrollBackpayPath) {
    ElMessage.warning('该记录没有工资导入/补发工资文件可推送')
    return
  }
  if (!(await confirmPushTargets(row, ['salary']))) return
  pushingSalaryRunId.value = row.id
  try {
    const label = historyPushLabel(row)
    const steps: PushStep[] = []
    const stepHints: string[] = []
    await appendSalaryPushSteps(row, label, steps, stepHints)
    enqueueIntegratedPush(steps, stepHints, '工资推送')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    setTimeout(() => {
      if (pushingSalaryRunId.value === row.id) pushingSalaryRunId.value = null
    }, 800)
  }
}

async function viewHistoryReport(row: MonthlyPayrollRun) {
  await loadHistoryReport(row, true)
}

async function loadHistoryReport(row: MonthlyPayrollRun, showMessage: boolean) {
  const snapshot = await window.salaryApi.getMonthlyPayrollRunReport(row.id)
  if (!snapshot) {
    if (showMessage) ElMessage.warning('这条历史记录没有可查看的报表快照，且导出文件不存在')
    return
  }
  showReportSnapshot(snapshot)
  selectedMonth.value = `${row.year}-${String(row.month).padStart(2, '0')}`
  selectedReportRunId.value = row.id
  if (showMessage) ElMessage.success('已打开历史报表视图')
}

function showReportSnapshot(snapshot: MonthlyPayrollReportResult): void {
  report.value = snapshot
  activeReportSheet.value = firstVisibleSheetName(snapshot.sheets)
}

function firstVisibleSheetName(sheets: MonthlyPayrollReportSheet[]): string {
  return sheets.find((sheet) => !HIDDEN_TAB_SHEETS.has(sheet.name))?.name ?? sheets[0]?.name ?? ''
}

async function openLatestSelectedMonthReport(rows: MonthlyPayrollRun[]) {
  if (report.value || running.value || generating.value) return
  const period = selectedPeriod.value
  const latest = pickLatestMonthRun(
    rows.filter((row) => row.year === period.year && row.month === period.month)
  )
  if (latest) {
    await loadHistoryReport(latest, false)
  }
}

async function deleteHistoryRun(row: MonthlyPayrollRun) {
  try {
    await ElMessageBox.confirm(
      '只删除这条历史记录，不会删除已导出的 Excel 文件。',
      '删除历史记录',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
    const removed = await window.salaryApi.deleteMonthlyPayrollRun(row.id)
    if (removed) {
      ElMessage.success('历史记录已删除')
      await refreshHistory()
    }
  } catch {
    // 用户取消
  }
}

function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const detected = computed(() => props.importWatcher?.monthlyPayroll)
type ProcessMode = 'salary' | 'salary-social'

watch(
  () => report.value,
  () => {
    const first = firstVisibleSheetName(visibleSheets.value)
    if (!first) return
    if (!visibleSheets.value.some((sheet) => sheet.name === activeReportSheet.value)) {
      activeReportSheet.value = first
    }
  }
)

const currentPeriodKey = computed(() => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
})

const selectedMonth = ref<string>(currentPeriodKey.value)

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

function parsePeriodKey(key: string): { year: number; month: number } {
  const [yearText, monthText] = key.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const now = new Date()
  return {
    year: Number.isInteger(year) && year > 1900 ? year : now.getFullYear(),
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : now.getMonth() + 1
  }
}

function pickLatestMonthRun(rows: MonthlyPayrollRun[]): MonthlyPayrollRun | null {
  return [...rows].sort((a, b) => {
    const archivedDelta = Number(Boolean(b.archivedAt)) - Number(Boolean(a.archivedAt))
    if (archivedDelta) return archivedDelta
    return b.id - a.id
  })[0] ?? null
}

const selectedPeriod = computed(() => parsePeriodKey(selectedMonth.value || currentPeriodKey.value))
const selectedMonthLabel = computed(() => periodKey(selectedPeriod.value.year, selectedPeriod.value.month))
const selectedMonthDisplay = computed(() => `${selectedPeriod.value.year}年${selectedPeriod.value.month}月`)
watch(selectedMonth, () => {
  void refreshSourceVersions()
})
const isSelectedMonthCurrent = computed(() => selectedMonthLabel.value === currentPeriodKey.value)
const selectedMonthRuns = computed(() =>
  history.value.filter((row) => row.year === selectedPeriod.value.year && row.month === selectedPeriod.value.month)
)
const historyActionRowKeys = computed(() => selectedMonthRuns.value.map((row) => row.id))
const selectedReportRun = computed(() =>
  selectedReportRunId.value
    ? selectedMonthRuns.value.find((row) => row.id === selectedReportRunId.value) ?? null
    : null
)
const selectedHistoryRun = computed(() => selectedReportRun.value ?? pickLatestMonthRun(selectedMonthRuns.value))
const selectedMonthArchivedRun = computed(() => selectedMonthRuns.value.find((row) => row.archivedAt) ?? null)
const isSelectedMonthArchived = computed(() => Boolean(selectedMonthArchivedRun.value))
const selectedMonthStatus = computed(() => {
  if (selectedMonthArchivedRun.value) return '已月结'
  if (!isSelectedMonthCurrent.value) return '仅可查看'
  if (selectedHistoryRun.value) return '可处理'
  return '未生成'
})
const selectedMonthFileCount = computed(() => {
  const row = selectedHistoryRun.value
  if (!row) return 0
  return [
    row.salaryImportPath,
    row.payrollBackpayPath,
    row.insuranceImportPath,
    row.voucherImportPath,
    row.archiveDir
  ].filter(Boolean).length
})

function dataSourceModeText(mode?: MonthlyPayrollDataSourceMode | null): string {
  return mode === 'integrated' ? '本地工资数据' : '工资表 Excel 兼容模式'
}

function dataSourceModeTagType(mode?: MonthlyPayrollDataSourceMode | null): 'success' | 'warning' {
  return mode === 'integrated' ? 'success' : 'warning'
}

function reconciliationOfRun(
  row: MonthlyPayrollRun
): MonthlyPayrollReconciliationResult | null {
  return row.reportSnapshot?.reconciliation ?? null
}

function reconciliationStatusText(
  status?: MonthlyPayrollReconciliationResult['status'] | null
): string {
  if (status === 'passed') return '通过'
  if (status === 'failed') return '未通过'
  if (status === 'warning') return '有提醒'
  return '未复核'
}

function reconciliationTagType(
  status?: MonthlyPayrollReconciliationResult['status'] | null
): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'passed') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'warning') return 'warning'
  return 'info'
}

function pushStatusText(status: MonthlyPayrollRun['insurancePushStatus']): string {
  if (status === 'queued') return '推送中'
  if (status === 'success') return '已推送'
  if (status === 'failed') return '推送失败'
  if (status === 'needs-repush') return '需重推'
  return '未推送'
}

function pushStatusTagType(
  status: MonthlyPayrollRun['insurancePushStatus']
): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'success') return 'success'
  if (status === 'queued' || status === 'needs-repush') return 'warning'
  if (status === 'failed') return 'danger'
  return 'info'
}

function exchangeStatusText(status: MonthlyPayrollExchangeStatus | null): string {
  if (status === 'package-built') return '包已生成'
  if (status === 'copied-to-media') return '包已摆渡'
  if (status === 'receipt-received') return '内网已归档'
  if (status === 'receipt-error') return '回执异常'
  return ''
}

function exchangeStatusTagType(
  status: MonthlyPayrollExchangeStatus | null
): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'receipt-received') return 'success'
  if (status === 'copied-to-media') return 'warning'
  if (status === 'receipt-error') return 'danger'
  return 'info'
}

const salarySourcePath = computed(() => effectiveSourcePath('salary', detected.value?.salaryWorkbookPath))
const socialSourcePath = computed(() => effectiveSourcePath('social', detected.value?.socialSecurityWorkbookPath))
const taxSourcePath = computed(() => effectiveSourcePath('tax', detected.value?.taxWorkbookPath))
const effectiveDataSourceMode = computed<MonthlyPayrollDataSourceMode>(() =>
  salarySourcePath.value ? 'salary-workbook' : 'integrated'
)
const effectiveProcessScope = computed<ProcessMode>(() =>
  socialSourcePath.value ? 'salary-social' : 'salary'
)
const selectedDataSourceModeText = computed(() => dataSourceModeText(effectiveDataSourceMode.value))
const canRun = computed(() => !isSelectedMonthArchived.value && isSelectedMonthCurrent.value)

const modeText = computed(() => {
  const scope = ['工资', socialSourcePath.value ? '社保' : '', taxSourcePath.value ? '个税' : '']
    .filter(Boolean)
    .join('+')
  return `${effectiveDataSourceMode.value === 'salary-workbook' ? 'Excel' : '本地'}：${scope}`
})

function currentSourceVersion(kind: MonthlyPayrollSourceKind): MonthlyPayrollSourceVersion | null {
  return sourceVersions.value.find((item) => item.kind === kind && item.status === 'current') ?? null
}

function sourceVersionPath(version: MonthlyPayrollSourceVersion): string {
  return version.archivePath || version.filePath
}

function effectiveSourcePath(kind: MonthlyPayrollSourceKind, detectedPath?: string): string | undefined {
  const version = currentSourceVersion(kind)
  return detectedPath || (version ? sourceVersionPath(version) : undefined) || undefined
}

function effectiveSourceName(kind: MonthlyPayrollSourceKind, detectedName?: string): string | undefined {
  return detectedName || currentSourceVersion(kind)?.fileName || undefined
}

function sourceVersionHint(kind: MonthlyPayrollSourceKind, fallback: string, detectedPath?: string): string {
  if (detectedPath) return fallback
  const version = currentSourceVersion(kind)
  if (!version) return fallback
  return `当前有效版本：${version.fileName}，${version.rowCount} 行，合计 ${formatMoney(version.totalAmount)}`
}

function sourceKindText(kind: MonthlyPayrollSourceKind): string {
  if (kind === 'social') return '社保'
  if (kind === 'tax') return '个税'
  return '工资表'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function canSwitchSourceVersion(version: MonthlyPayrollSourceVersion): boolean {
  return version.status === 'replaced' && isSelectedMonthCurrent.value && !isSelectedMonthArchived.value
}

async function switchSourceVersion(version: MonthlyPayrollSourceVersion): Promise<void> {
  if (!canSwitchSourceVersion(version)) return
  try {
    await ElMessageBox.confirm(
      `切回 ${sourceKindText(version.kind)} 的历史版本后，本月已生成的工资报账记录会标记为过期，需要重新生成并重新推送。`,
      '切回源文件版本',
      {
        type: 'warning',
        confirmButtonText: '切回',
        cancelButtonText: '取消'
      }
    )
  } catch {
    return
  }

  switchingSourceVersionId.value = version.id
  try {
    await window.salaryApi.setMonthlyPayrollSourceVersionCurrent(version.id)
    ElMessage.success('已切回源文件版本')
    await refreshHistory()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '切回失败')
  } finally {
    switchingSourceVersionId.value = null
  }
}

const fileRows = computed(() => [
  {
    label: '工资表 Excel',
    required: false,
    name: effectiveSourceName('salary', detected.value?.salaryWorkbookName),
    path: salarySourcePath.value,
    hint: sourceVersionHint('salary',
      salarySourcePath.value
        ? '检测到工资表，本月按 Excel 兼容模式校准本地工资数据'
        : '未检测到工资表，本月按本地在职工资、退休工资、其他工资生成',
      detected.value?.salaryWorkbookPath
    )
  },
  {
    label: '社保未申报汇总',
    required: true,
    name: effectiveSourceName('social', detected.value?.socialSecurityWorkbookName),
    path: socialSourcePath.value,
    hint: sourceVersionHint('social',
      socialSourcePath.value
        ? '社保每月必办，已纳入本次最终候选结果'
        : '社保每月必办；未补齐前只能生成阶段结果，不能月结',
      detected.value?.socialSecurityWorkbookPath
    )
  },
  {
    label: '个税计算表',
    required: false,
    name: effectiveSourceName('tax', detected.value?.taxWorkbookName),
    path: taxSourcePath.value,
    hint: sourceVersionHint('tax', '未检测到时跳过个税扣款和补发工资', detected.value?.taxWorkbookPath)
  }
])

async function confirmMonthlyPayrollPreprocess(): Promise<boolean> {
  // 预处理前把“本次按什么来源、处理哪些文件”说清楚，避免用户误把阶段结果当最终结果。
  const hasSalary = Boolean(salarySourcePath.value)
  const hasSocial = Boolean(socialSourcePath.value)
  const hasTax = Boolean(taxSourcePath.value)
  const includesSalary = true
  const includesSocial = hasSocial
  const includesTax = hasTax
  let periodInspection: MonthlyPayrollSourcePeriodInspection | null = null
  if (hasSocial || hasTax) {
    const payload = currentPayload()
    if (!payload) return false
    try {
      periodInspection = await window.salaryApi.inspectMonthlyPayrollSourcePeriods(payload)
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '社保或个税所属期校验失败')
      return false
    }
  }
  const scope = [
    includesSalary ? '工资' : '',
    includesSocial ? '社保' : '',
    includesTax ? '个税' : ''
  ].filter(Boolean)
  const salarySource = hasSalary
    ? '已检测到工资表 Excel，作为本月权威来源'
    : '未检测到工资表 Excel，使用本地在职工资/退休工资/其他工资'
  const rows = [
    {
      item: '工资',
      detected: salarySource,
      action: hasSalary
        ? '先校准本地工资数据，再生成工资报账'
        : '按本地工资数据生成工资报账'
    },
    {
      item: '社保',
      detected: hasSocial
        ? periodInspection?.socialSecurity?.message ?? '已检测到社保未申报汇总'
        : '未检测到社保文件',
      action: includesSocial ? '生成社保报账' : '先生成工资阶段结果；社保补齐后需重新生成，暂不可月结'
    },
    {
      item: '个税',
      detected: hasTax ? periodInspection?.tax?.message ?? '已检测到个税文件' : '未检测到个税文件',
      action: includesTax ? '生成个税扣款' : '本次不报个税'
    }
  ]
  const tableRows = rows
    .map((row) => (
      `<tr><td>${escapeHtml(row.item)}</td><td>${escapeHtml(row.detected)}</td><td>${escapeHtml(row.action)}</td></tr>`
    ))
    .join('')
  const message =
    `<div class="payroll-confirm-summary">权威来源：${escapeHtml(selectedDataSourceModeText.value)}；本次将处理：${escapeHtml(scope.join('、'))}</div>` +
    '<table class="payroll-confirm-table"><thead><tr><th>项目</th><th>检测结果</th><th>处理方式</th></tr></thead>' +
    `<tbody>${tableRows}</tbody></table>`

  try {
    await ElMessageBox.confirm(
      message,
      '确认工资报账范围',
      {
        type: 'info',
        confirmButtonText: '确认并开始',
        cancelButtonText: '返回检查',
        dangerouslyUseHTMLString: true,
        customClass: 'monthly-payroll-confirm-box'
      }
    )
    return true
  } catch {
    return false
  }
}

function currentPayload(
  options: {
    confirmWriteBack?: boolean
    confirmIdentityFallback?: boolean
    salaryImportFields?: string[]
    salaryImportIdCards?: string[]
  } = {}
): WorkflowRunPayload | null {
  const period = selectedPeriod.value
  const processScope = effectiveProcessScope.value
  return {
    monthlyPayroll: {
      salaryWorkbookPath: salarySourcePath.value,
      socialSecurityWorkbookPath: socialSourcePath.value,
      taxWorkbookPath: taxSourcePath.value,
      year: period.year,
      month: period.month,
      confirmWriteBack: options.confirmWriteBack,
      confirmIdentityFallback: options.confirmIdentityFallback,
      salaryImportFields: options.salaryImportFields,
      salaryImportIdCards: options.salaryImportIdCards,
      processScope,
      dataSourceMode: effectiveDataSourceMode.value
    }
  }
}

function resultLineTooltipLines(
  run: WorkflowRunResult | null,
  text: string
): string[] {
  return run?.messageTooltips?.find((item) => item.message === text)?.lines ?? []
}

function resultLineHasTooltip(
  run: WorkflowRunResult | null,
  text: string
): boolean {
  return resultLineTooltipLines(run, text).length > 0
}

async function confirmMonthlyPayrollWriteBack(
  preview: MonthlyPayrollWriteBackPreview
): Promise<boolean> {
  // 工资表金额写回会改变本地工资数据，必须由用户确认后再复核生成。
  const examples = preview.examples.length
    ? `\n\n示例：\n${preview.examples.map((item) => `- ${item}`).join('\n')}`
    : ''
  const manual = preview.manualCount > 0
    ? `\n\n另有 ${preview.manualCount} 项差异需要人工判断，自动回写后系统会继续复核。`
    : ''
  try {
    await ElMessageBox.confirm(
      `发现 ${preview.syncableCount} 项工资表金额差异可回写到本地工资数据，涉及 ${preview.personCount} 人。确认后会按字段当前承载批次写回，并重新核对。${examples}${manual}`,
      '确认回写本地工资数据',
      {
        type: 'warning',
        confirmButtonText: '确认回写并复核',
        cancelButtonText: '暂不回写'
      }
    )
    return true
  } catch {
    return false
  }
}

async function confirmMonthlyPayrollIdentityFallback(
  preview: MonthlyPayrollWriteBackPreview
): Promise<boolean> {
  if (preview.identityBlockedCount > 0) return false
  const examples = preview.identityReviewExamples.length
    ? `\n\n示例：\n${preview.identityReviewExamples.map((item) => `- ${item}`).join('\n')}`
    : ''
  try {
    await ElMessageBox.confirm(
      `发现 ${preview.identityConfirmableCount} 条工资表与本地工资数据身份证不一致，但姓名唯一匹配。确认后系统会记住这些身份匹配关系，以后工资导入、补发工资和复核都会按同一人处理；不会自动修改原始身份证号。${examples}`,
      '确认身份匹配',
      {
        type: 'warning',
        confirmButtonText: '确认并继续',
        cancelButtonText: '先不继续'
      }
    )
    return true
  } catch {
    return false
  }
}

async function runPreprocess(): Promise<void> {
  if (!isSelectedMonthCurrent.value) {
    ElMessage.warning('工资报账只能处理当月业务，请切回当前月份')
    return
  }
  if (isSelectedMonthArchived.value) {
    ElMessage.warning(`${selectedMonthDisplay.value}已月结，不能再次进行工资报账`)
    return
  }
  if (!canRun.value) {
    ElMessage.warning(isSelectedMonthArchived.value ? `${selectedMonthDisplay.value}已月结` : '当前月份暂不可处理')
    return
  }
  const confirmedMode = await confirmMonthlyPayrollPreprocess()
  if (!confirmedMode) return

  running.value = true
  result.value = null
  generateResult.value = null
  report.value = null
  selectedReportRunId.value = null
  try {
    const payload = currentPayload()
    if (!payload) return
    const next = await window.salaryApi.runWorkflow('monthly-payroll.preprocess', payload)
    result.value = next
    emit('workflowNotice', next)
    await refreshSourceVersions()
    const writeBack = next.monthlyPayrollWriteBack
    if (writeBack?.requiresIdentityConfirmation && writeBack.identityConfirmableCount > 0) {
      const confirmedIdentity = await confirmMonthlyPayrollIdentityFallback(writeBack)
      if (!confirmedIdentity) {
        ElMessage.info('已暂不继续，可核对身份证后再次预处理')
        return
      }
      const identityPayload = currentPayload({ confirmIdentityFallback: true })
      if (!identityPayload) return
      const identityResult = await window.salaryApi.runWorkflow(
        'monthly-payroll.preprocess',
        identityPayload
      )
      result.value = identityResult
      emit('workflowNotice', identityResult)
      await refreshSourceVersions()
      const confirmedWriteBack = identityResult.monthlyPayrollWriteBack
      if (confirmedWriteBack?.requiresConfirmation && confirmedWriteBack.syncableCount > 0) {
        const confirmed = await confirmMonthlyPayrollWriteBack(confirmedWriteBack)
        if (!confirmed) {
          ElMessage.info('已暂不回写，可处理后再次预处理')
          return
        }
        const confirmedPayload = currentPayload({
          confirmIdentityFallback: true,
          confirmWriteBack: true
        })
        if (!confirmedPayload) return
        const confirmedResult = await window.salaryApi.runWorkflow(
          'monthly-payroll.preprocess',
          confirmedPayload
        )
        result.value = confirmedResult
        emit('workflowNotice', confirmedResult)
        await refreshSourceVersions()
        if (confirmedResult.ok && confirmedResult.warnings.length === 0) {
          ElMessage.success('身份与回写复核通过，开始生成报表')
          await runGenerate(confirmedResult.monthlyPayrollWriteBack)
        } else if (confirmedResult.ok) {
          ElMessage.warning('预处理存在提醒，已停止自动生成报表；请查看页面结果或系统通知')
        } else {
          ElMessage.error(confirmedResult.warnings[0] ?? '月度工资报账预处理失败')
        }
        return
      }
      if (identityResult.ok) {
        ElMessage.success('身份确认通过，月度工资报账预处理完成')
        if (identityResult.warnings.length === 0) {
          await runGenerate(identityResult.monthlyPayrollWriteBack)
        } else {
          ElMessage.warning('预处理存在提醒，已停止自动生成报表；请查看页面结果或系统通知')
        }
      } else {
        ElMessage.error(identityResult.warnings[0] ?? '月度工资报账预处理失败')
      }
      return
    }
    if (writeBack?.requiresConfirmation && writeBack.syncableCount > 0) {
      const confirmed = await confirmMonthlyPayrollWriteBack(writeBack)
      if (!confirmed) {
        ElMessage.info('已暂不回写，可处理后再次预处理')
        return
      }
      const confirmedPayload = currentPayload({ confirmWriteBack: true })
      if (!confirmedPayload) return
      const confirmedResult = await window.salaryApi.runWorkflow(
        'monthly-payroll.preprocess',
        confirmedPayload
      )
      result.value = confirmedResult
      emit('workflowNotice', confirmedResult)
      await refreshSourceVersions()
      if (confirmedResult.ok && confirmedResult.warnings.length === 0) {
        ElMessage.success('回写复核通过，开始生成报表')
        await runGenerate(confirmedResult.monthlyPayrollWriteBack)
      } else if (confirmedResult.ok) {
        ElMessage.warning('预处理存在提醒，已停止自动生成报表；请查看页面结果或系统通知')
      } else {
        ElMessage.error(confirmedResult.warnings[0] ?? '月度工资报账预处理失败')
      }
      return
    }
    if (next.ok) {
      ElMessage.success('月度工资报账预处理完成')
      if (next.warnings.length === 0) {
        await runGenerate(next.monthlyPayrollWriteBack)
      } else {
        ElMessage.warning('预处理存在提醒，已停止自动生成报表；请查看页面结果或系统通知')
      }
    } else {
      ElMessage.error(next.warnings[0] ?? '月度工资报账预处理失败')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '月度工资报账预处理失败')
  } finally {
    running.value = false
  }
}

async function runGenerate(writeBack?: MonthlyPayrollWriteBackPreview): Promise<void> {
  if (!isSelectedMonthCurrent.value) {
    ElMessage.warning('工资报账只能处理当月业务，请切回当前月份')
    return
  }
  if (isSelectedMonthArchived.value) {
    ElMessage.warning(`${selectedMonthDisplay.value}已月结，不能重新生成报表`)
    return
  }
  if (!canRun.value) {
    ElMessage.warning(isSelectedMonthArchived.value ? `${selectedMonthDisplay.value}已月结` : '当前月份暂不可处理')
    return
  }
  generating.value = true
  generateResult.value = null
  report.value = null
  selectedReportRunId.value = null
  try {
    const payload = currentPayload({
      confirmIdentityFallback: Boolean(writeBack?.identityReviewCount && writeBack.identityBlockedCount === 0),
      salaryImportFields: writeBack?.salaryImportFields,
      salaryImportIdCards: writeBack?.salaryImportIdCards
    })
    if (!payload) return
    const next = await window.salaryApi.runWorkflow('monthly-payroll.generate', payload)
    generateResult.value = next
    emit('workflowNotice', next)
    if (next.ok) {
      selectedMonth.value = selectedMonthLabel.value
      if (next.monthlyPayrollReport) {
        showReportSnapshot(next.monthlyPayrollReport)
        selectedReportRunId.value = null
        void refreshHistory().then((nextHistory) => {
          const latest = pickLatestMonthRun(
            nextHistory.filter((row) => row.year === selectedPeriod.value.year && row.month === selectedPeriod.value.month)
          )
          selectedReportRunId.value = latest?.id ?? null
        }).catch((error) => {
          console.warn('生成后刷新工资报账历史失败', error)
        })
      } else {
        const nextHistory = await refreshHistory()
        const latest = pickLatestMonthRun(
          nextHistory.filter((row) => row.year === selectedPeriod.value.year && row.month === selectedPeriod.value.month)
        )
        if (latest) {
          await loadHistoryReport(latest, false)
        }
      }
      ElMessage.success(next.messages[0] ?? '月度工资报账汇总生成完成')
    } else {
      ElMessage.error(next.warnings[0] ?? '月度工资报账汇总生成失败')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '月度工资报账汇总生成失败')
  } finally {
    generating.value = false
  }
}

function isVoucherPrintSheet(name: string | undefined): boolean {
  return name === '报销凭证'
}

function isReportPrintSheet(name: string | undefined): boolean {
  return (
    name === '自动生成' ||
    name === '五险一金' ||
    name === '工退遗汇总' ||
    isRetiredHousingSheetName(name)
  )
}

const PRINT_ALL_SHEETS = [
  '自动生成',
  '五险一金',
  '工退遗汇总',
  '报销凭证',
  '退休房补'
] as const

const currentPrinterName = computed(() =>
  isVoucherPrintSheet(activeSheet.value?.name)
    ? printSettings.value.voucherPrinterName
    : printSettings.value.reportPrinterName
)

function currentPrintRequest(printerName: string, sheetName = activeSheet.value?.name): PrintRequest {
  if (isVoucherPrintSheet(sheetName)) {
    return {
      printerName,
      scaleFactor: 100,
      pageSize: { width: 230000, height: 132000 }
    }
  }
  return {
    printerName,
    scaleFactor: 100,
    pageSize: { width: 210000, height: 297000 }
  }
}

type PrintPageSelection =
  | { ok: true; pages?: number[] }
  | { ok: false; message: string }

function parsePrintPageSelection(value: string, totalPages: number): PrintPageSelection {
  const trimmed = value.trim()
  if (!trimmed) return { ok: true }
  if (totalPages <= 0) return { ok: false, message: '当前视图没有可打印页面' }

  const pages = new Set<number>()
  let hasInvalidPart = false
  for (const part of trimmed.split(/[,，]/)) {
    const rangeText = part.trim()
    if (!rangeText) continue
    const [fromText, toText = fromText] = rangeText.split(/[-~～]/).map((item) => item.trim())
    const from = Number(fromText)
    const to = Number(toText)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
      hasInvalidPart = true
      continue
    }
    const start = Math.min(from, to)
    const end = Math.max(from, to)
    if (end > totalPages) {
      return { ok: false, message: `当前视图共 ${totalPages} 页，不能打印第 ${end} 页` }
    }
    for (let page = start; page <= end; page += 1) {
      pages.add(page)
    }
  }

  if (hasInvalidPart || pages.size === 0) {
    return { ok: false, message: '打印页码格式不正确，请输入 1 或 1-2' }
  }

  return { ok: true, pages: Array.from(pages).sort((a, b) => a - b) }
}

async function printCurrentViewForSheet(printerName: string, sheetName = activeSheet.value?.name): Promise<void> {
  const pageSelection = parsePrintPageSelection(printPageRangeText.value, printablePageCountForSheet(sheetName))
  if (!pageSelection.ok) throw new Error(pageSelection.message)
  const removePageSelectionStyle = installPrintPageSelectionStyle(pageSelection.pages, sheetName)
  const removeVoucherPrintStyle = isVoucherPrintSheet(sheetName)
    ? installVoucherPrintPageStyle()
    : undefined
  try {
    await window.salaryApi.printCurrentView(currentPrintRequest(printerName, sheetName))
  } finally {
    removePageSelectionStyle?.()
    removeVoucherPrintStyle?.()
  }
}

function installPrintPageSelectionStyle(pageNumbers: number[] | undefined, sheetName: string | undefined): (() => void) | undefined {
  if (!pageNumbers?.length) return undefined
  const pageSelector = isVoucherPrintSheet(sheetName) ? '.voucher-page' : '.print-page'
  const visibleSelectors = pageNumbers
    .map((page) => `${pageSelector}[data-print-page-index="${page}"]`)
    .join(',\n  ')
  const style = document.createElement('style')
  style.textContent = `
@media print {
  ${pageSelector} {
    display: none !important;
  }
  ${visibleSelectors} {
    display: block !important;
  }
}
`
  document.head.appendChild(style)
  return () => style.remove()
}

function installVoucherPrintPageStyle(): () => void {
  const style = document.createElement('style')
  style.textContent = `
@media print {
  @page {
    size: 230mm 132mm;
    margin: 0;
  }
}
`
  document.head.appendChild(style)
  return () => style.remove()
}

async function printCurrentReport(): Promise<void> {
  if (!activeSheet.value) return
  const printerName = currentPrinterName.value
  if (!printerName) {
    ElMessage.warning(isVoucherPrintSheet(activeSheet.value.name) ? '请先选择报销凭证打印机' : '请先选择报表打印机')
    return
  }
  printing.value = true
  try {
    if (isVoucherPrintSheet(activeSheet.value.name)) {
      await refreshVoucherPrintTotalPages()
    }
    await printCurrentViewForSheet(printerName)
    ElMessage.success('已发送到打印机')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打印失败')
  } finally {
    printing.value = false
  }
}

const HIDDEN_TAB_SHEETS = new Set<string>()

const visibleSheets = computed(() =>
  (report.value?.sheets ?? []).filter((sheet) => !HIDDEN_TAB_SHEETS.has(sheet.name))
)

async function archiveHistoryRun(row: MonthlyPayrollRun | null): Promise<void> {
  if (!row) {
    ElMessage.warning('请先生成或选择一条历史报表')
    return
  }
  archivingId.value = row.id
  try {
    const archivedRun = await archiveRunInteractive(row)
    if (archivedRun) {
      await refreshHistory()
      await loadHistoryReport(archivedRun, false)
    }
  } finally {
    archivingId.value = null
  }
}

async function cancelHistoryMonthClose(row: MonthlyPayrollRun): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `反月结 ${row.year}年${row.month}月 后，该月所有历史记录都会解除月结锁定，工资、社保、个税源文件会放回监控文件夹，可以重新预处理和生成报表。`,
      '反月结',
      {
        type: 'warning',
        confirmButtonText: '确认反月结',
        cancelButtonText: '保留月结',
        confirmButtonClass: 'el-button--danger'
      }
    )
  } catch {
    return
  }

  cancelingMonthCloseId.value = row.id
  try {
    const updated = await window.salaryApi.cancelMonthlyPayrollMonthClose(row.id)
    ElMessage.success('已反月结')
    await refreshHistory()
    await loadHistoryReport(updated, false)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '反月结失败')
  } finally {
    cancelingMonthCloseId.value = null
  }
}

function canArchiveHistoryRun(row: MonthlyPayrollRun | null): boolean {
  return Boolean(row && canArchiveRun(row))
}

async function onMonthChange(): Promise<void> {
  if (!selectedMonth.value) {
    selectedMonth.value = currentPeriodKey.value
    report.value = null
    activeReportSheet.value = ''
    selectedReportRunId.value = null
    return
  }
  const row = selectedHistoryRun.value
  if (row) {
    await loadHistoryReport(row, false)
  } else {
    report.value = null
    activeReportSheet.value = ''
    selectedReportRunId.value = null
  }
}

const availablePrintAllSheets = computed(() =>
  PRINT_ALL_SHEETS.filter((name) => visibleSheets.value.some((sheet) => sheet.name === name))
)

const canPrintAll = computed(() => {
  const shouldPrintSalaryWorkbook = Boolean(salarySourcePath.value)
  if (availablePrintAllSheets.value.length === 0 && !shouldPrintSalaryWorkbook) return false
  const needsReport =
    shouldPrintSalaryWorkbook || availablePrintAllSheets.value.some((name) => !isVoucherPrintSheet(name))
  const needsVoucher = availablePrintAllSheets.value.some((name) => isVoucherPrintSheet(name))
  if (needsReport && !printSettings.value.reportPrinterName) return false
  if (needsVoucher && !printSettings.value.voucherPrinterName) return false
  return true
})

async function printAllReports(): Promise<void> {
  const targets = availablePrintAllSheets.value
  const salaryPath = salarySourcePath.value
  if (targets.length === 0 && !salaryPath) {
    ElMessage.warning('没有可打印的报表')
    return
  }
  const needsReport =
    Boolean(salaryPath) || targets.some((name) => !isVoucherPrintSheet(name))
  const needsVoucher = targets.some((name) => isVoucherPrintSheet(name))
  if (needsReport && !printSettings.value.reportPrinterName) {
    ElMessage.warning('请先选择报表打印机')
    return
  }
  if (needsVoucher && !printSettings.value.voucherPrinterName) {
    ElMessage.warning('请先选择报销凭证打印机')
    return
  }
  printing.value = true
  try {
    let count = 0
    if (needsVoucher) {
      await refreshVoucherPrintTotalPages()
    }
    if (salaryPath) {
      await window.salaryApi.printSalaryWorkbookViaExcel({
        salaryWorkbookPath: salaryPath,
        salaryWorkbookFallbackPaths: getArchivedSalaryWorkbookPaths(selectedHistoryRun.value),
        taxWorkbookPath: effectiveSourcePath('tax', detected.value?.taxWorkbookPath),
        printerName: printSettings.value.reportPrinterName
      })
      count += 1
    }
    for (const name of targets) {
      activeReportSheet.value = name
      await nextTick()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const printerName = isVoucherPrintSheet(name)
        ? printSettings.value.voucherPrinterName
        : printSettings.value.reportPrinterName
      await printCurrentViewForSheet(printerName, name)
      count += 1
    }
    ElMessage.success(`已发送 ${count} 项到打印机`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打印失败')
  } finally {
    printing.value = false
  }
}

type VoucherPrintPageSummaryItem = {
  label: string
  pages: number
  note?: string
}

async function refreshVoucherPrintTotalPages(): Promise<void> {
  voucherPrintTotalPagesLoading.value = true
  try {
    const summary = await buildVoucherPrintPageSummary()
    voucherPrintTotalPages.value = summary.totalPages
    await nextTick()
  } finally {
    voucherPrintTotalPagesLoading.value = false
  }
}

async function buildVoucherPrintPageSummary(): Promise<{
  items: VoucherPrintPageSummaryItem[]
  totalPages: number
}> {
  const items: VoucherPrintPageSummaryItem[] = []
  const salarySummary = await getSalaryPrintPageSummary()
  const salaryPages = salarySummary?.items.find((item) => item.label === '工资表')?.pages ?? 0
  const survivorPages = salarySummary?.items
    .filter((item) => item.label === '遗补')
    .reduce((sum, item) => sum + item.pages, 0) ?? 0
  items.push({ label: '工资表', pages: salaryPages })
  items.push({ label: '遗补', pages: survivorPages })
  items.push({ label: '退休教师房补', pages: getRetiredHousingPrintPageCount() })
  return {
    items,
    totalPages: items.reduce((sum, item) => sum + item.pages, 0)
  }
}

async function getSalaryPrintPageSummary(): Promise<MonthlyPayrollSalaryPrintPageSummary | null> {
  const salaryWorkbookPath =
    effectiveSourcePath('salary', detected.value?.salaryWorkbookPath) ||
    selectedHistoryRun.value?.sourceSalaryPath ||
    ''
  if (!salaryWorkbookPath) return null
  try {
    return await window.salaryApi.getSalaryWorkbookPrintPageSummary({
      salaryWorkbookPath,
      salaryWorkbookFallbackPaths: getArchivedSalaryWorkbookPaths(selectedHistoryRun.value),
      taxWorkbookPath:
        effectiveSourcePath('tax', detected.value?.taxWorkbookPath) ||
        selectedHistoryRun.value?.sourceTaxPath ||
        undefined,
      printerName: printSettings.value.reportPrinterName
    })
  } catch (error) {
    ElMessage.warning(cleanRemoteErrorMessage(error, '工资表页数统计失败'))
    return null
  }
}

function getArchivedSalaryWorkbookPaths(run: MonthlyPayrollRun | null): string[] {
  if (!run?.sourceSalaryPath) return []
  const sourceName = fileNameOf(run.sourceSalaryPath)
  return run.archiveManifest.filter((filePath) =>
    ['写入个税工资表', '工资表'].some((label) =>
      isArchivedFileForLabel(fileNameOf(filePath), label, sourceName)
    )
  )
}

function isArchivedFileForLabel(name: string, label: string, originalName: string): boolean {
  return (
    name === `${label}_${originalName}` ||
    (name.startsWith(`${label}_`) && name.endsWith(`_${originalName}`)) ||
    (name.startsWith(`工资报账月结_${label}_`) && name.endsWith(`_${originalName}`))
  )
}

function fileNameOf(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

function cleanRemoteErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback
}

function getRetiredHousingPrintPageCount(): number {
  const sheet = report.value?.sheets.find((item) => isRetiredHousingSheetName(item.name))
  return sheet ? splitRetiredHousingSheet(sheet).length : 0
}

const printButtonText = computed(() =>
  activeSheet.value?.name === '报销凭证' ? '打印报销凭证' : '打印当前视图'
)

const currentPrinterLabel = computed(() =>
  isVoucherPrintSheet(activeSheet.value?.name) ? '票据打印机' : '报表打印机'
)

const voucherPageStyle = computed(() => ({
  '--voucher-offset-x': `${Number(printSettings.value.voucherOffsetX || 0)}mm`,
  '--voucher-offset-y': `${Number(printSettings.value.voucherOffsetY || 0)}mm`
}))

const reportPageStyle = computed(() => ({
  '--report-offset-x': `${Number(printSettings.value.reportOffsetX || 0)}mm`
}))

const activeSheet = computed(() =>
  visibleSheets.value.find((sheet) => sheet.name === activeReportSheet.value)
)

watch(
  () => [
    activeSheet.value?.name,
    detected.value?.salaryWorkbookPath,
    selectedHistoryRun.value?.sourceSalaryPath,
    printSettings.value.reportPrinterName
  ] as const,
  () => {
    if (activeSheet.value?.name === '凭证' || isVoucherPrintSheet(activeSheet.value?.name)) {
      void refreshVoucherPrintTotalPages()
    } else {
      voucherPrintTotalPages.value = null
    }
  }
)

const activePages = computed<MonthlyPayrollReportSheet[]>(() => {
  const sheet = activeSheet.value
  if (!sheet) return []
  return reportPrintPagesForSheet(sheet)
})

function reportPrintPagesForSheet(sheet: MonthlyPayrollReportSheet): MonthlyPayrollReportSheet[] {
  if (sheet.name === '自动生成') return splitAutoSheet(sheet)
  if (isRetiredHousingSheetName(sheet.name)) return splitRetiredHousingSheet(sheet)
  return [sheet]
}

function printablePageCountForSheet(sheetName = activeSheet.value?.name): number {
  const sheet = visibleSheets.value.find((item) => item.name === sheetName)
  if (!sheet) return 0
  if (isVoucherPrintSheet(sheet.name)) return sheet.rows.length
  if (isReportPrintSheet(sheet.name)) return reportPrintPagesForSheet(sheet).length
  return 0
}

function splitRetiredHousingSheet(sheet: MonthlyPayrollReportSheet): MonthlyPayrollReportSheet[] {
  if (sheet.rows.length <= 3) return [sheet]
  const titleRow = sheet.rows[0]
  const headerRow = sheet.rows[1]
  const totalRow = sheet.rows[sheet.rows.length - 1]
  const dataRows = sheet.rows.slice(2, -1)
  const perPage = 20
  if (dataRows.length <= perPage) return [sheet]
  const pages: MonthlyPayrollReportSheet[] = []
  for (let start = 0; start < dataRows.length; start += perPage) {
    const chunk = dataRows.slice(start, start + perPage)
    const isLast = start + perPage >= dataRows.length
    pages.push({
      ...sheet,
      rows: [titleRow, headerRow, ...chunk, ...(isLast ? [totalRow] : [])],
      merges: sheet.merges
    })
  }
  return pages
}

const activePageMergeMaps = computed<Map<string, MergeEntry>[]>(() =>
  activePages.value.map((page) => buildMergeMap(page.merges))
)

function splitAutoSheet(sheet: MonthlyPayrollReportSheet): MonthlyPayrollReportSheet[] {
  const leftRowCount = 13
  const left: MonthlyPayrollReportSheet = {
    ...sheet,
    columns: sheet.columns.slice(0, 4),
    columnWidths: sheet.columnWidths?.slice(0, 4),
    rowHeights: sheet.rowHeights?.slice(0, leftRowCount),
    rows: sheet.rows.slice(0, leftRowCount).map((row) => row.slice(0, 4)),
    merges: ['A1:D1', 'C2:D2', 'A13:C13']
  }
  const right: MonthlyPayrollReportSheet = {
    ...sheet,
    columns: sheet.columns.slice(5, 12),
    columnWidths: sheet.columnWidths?.slice(5, 12),
    rowHeights: sheet.rowHeights,
    rows: sheet.rows.map((row) => row.slice(5, 12)),
    merges: ['A1:G1', 'A2:G2', 'A3:C3', 'E3:G3', 'D3:D19']
  }
  return [left, right]
}

function voucherPrintTotalPagesForRow(row: unknown[]): number | null {
  const savedPages = Number(row[VOUCHER_ATTACHMENT_PAGES_INDEX] ?? 0)
  if (Number.isFinite(savedPages) && savedPages > 0) return savedPages
  if (!isSalaryVoucher(row)) return INSURANCE_VOUCHER_ATTACHMENT_PAGES
  return voucherPrintTotalPages.value
}

function voucherUsagePrintText(row: unknown[]): string {
  const lines = voucherUsageLines(row)
  if (!isSalaryVoucher(row)) return lines.join('\n')
  return lines
    .map((line) => line.replace(/(-?\d[\d,]*(?:\.\d+)?)$/, ' $1'))
    .join('\n')
}

function formatVoucherCell(row: unknown[], value: unknown, colIndex: number): string {
  if (value === '' || value === null || value === undefined) return ''
  if (colIndex === 8 && voucherPrintTotalPages.value !== null) {
    const voucherNo = String(row[2] ?? '')
    if (voucherNo === '2') return String(INSURANCE_VOUCHER_ATTACHMENT_PAGES)
    if (voucherNo === '1') return String(voucherPrintTotalPages.value)
  }
  if (colIndex === 5 || colIndex === 6) {
    const n = Number(value)
    if (!Number.isFinite(n) || n === 0) return ''
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return String(value)
}

</script>

<template>
  <section class="monthly-page">
    <header class="monthly-header">
      <div>
        <h1>工资报账</h1>
        <p>{{ importWatcher?.folderPath || '监控文件夹未初始化' }}</p>
      </div>
      <div class="header-actions">
        <el-tag :type="canRun ? 'success' : 'warning'" effect="plain">{{ modeText }}</el-tag>
        <el-tag v-if="isSelectedMonthArchived" type="info" effect="plain">{{ selectedMonthDisplay }}已月结</el-tag>
        <el-button :icon="Refresh" :loading="loading" @click="emit('refresh')">刷新检测</el-button>
        <el-button
          :icon="FolderOpened"
          :loading="importingExchangePackage"
          @click="chooseAndImportExchangePackage"
        >导入内网业务包</el-button>
        <el-button
          type="primary"
          :icon="VideoPlay"
          :loading="running"
          :disabled="!canRun"
          @click="runPreprocess"
        >
          {{ isSelectedMonthArchived ? '已月结' : '工资报账' }}
        </el-button>
      </div>
    </header>

    <section class="month-overview">
      <div class="month-picker-block">
        <div class="month-picker-line">
          <strong>月份视图</strong>
          <el-date-picker
            v-model="selectedMonth"
            type="month"
            format="YYYY年MM月"
            value-format="YYYY-MM"
            size="small"
            :clearable="false"
            :editable="false"
            @change="onMonthChange"
          />
        </div>
        <div class="month-stats">
          <span>
            <small>历史记录</small>
            <b>{{ selectedMonthRuns.length }}</b>
          </span>
          <span>
            <small>状态</small>
            <b>{{ selectedMonthStatus }}</b>
          </span>
          <span>
            <small>导出文件</small>
            <b>{{ selectedMonthFileCount }}</b>
          </span>
        </div>
      </div>
      <div class="primary-data-source">
        <div>
          <strong>权威来源</strong>
          <p v-if="effectiveDataSourceMode === 'salary-workbook'">检测到工资表 Excel，本月按兼容模式处理：Excel 校准本地在职工资和其他工资。</p>
          <p v-else>未检测到工资表 Excel，本月直接按本地在职工资、退休工资、其他工资生成。</p>
        </div>
        <div class="source-tags">
          <el-tag :type="effectiveDataSourceMode === 'salary-workbook' ? 'warning' : 'success'" effect="plain" size="small">
            {{ selectedDataSourceModeText }}
          </el-tag>
          <el-tag effect="plain" size="small">在职工资</el-tag>
          <el-tag effect="plain" size="small">退休工资</el-tag>
          <el-tag effect="plain" size="small">其他工资</el-tag>
        </div>
      </div>
      <div class="tax-rule-settings">
        <div>
          <strong>个税规则设置</strong>
          <p>个税文件按身份证匹配在职工资后，写入当前启用字段；另一个个税字段写入时清零。</p>
        </div>
        <div class="tax-rule-actions">
          <el-radio-group v-model="payrollSettings.taxField" size="small">
            <el-radio-button label="补扣工资">补扣工资</el-radio-button>
            <el-radio-button label="当月个人所得税">当月个人所得税</el-radio-button>
          </el-radio-group>
          <el-button
            type="primary"
            size="small"
            :loading="payrollSettingsSaving"
            @click="saveTaxRuleSettings"
          >
            保存
          </el-button>
        </div>
      </div>
    </section>

    <div class="monthly-grid">
      <div v-for="slot in fileRows" :key="slot.label" class="file-row" :class="{ missing: !slot.path }">
        <div class="file-icon">
          <el-icon><DocumentChecked /></el-icon>
        </div>
        <div class="file-main">
          <strong>
            {{ slot.label }}
            <span v-if="slot.required">必需</span>
            <span v-else>可选</span>
          </strong>
          <span>{{ slot.name || slot.hint }}</span>
          <small v-if="slot.path">{{ slot.path }}</small>
        </div>
        <el-tag :type="slot.path ? 'success' : slot.required ? 'danger' : 'info'" effect="plain">
          {{ slot.path ? '已检测' : slot.required ? '缺少' : '未检测' }}
        </el-tag>
      </div>
    </div>

    <div v-if="sourceVersions.length" class="source-version-panel">
      <strong>本月数据源版本</strong>
      <div class="source-version-list">
        <div
          v-for="version in sourceVersions"
          :key="version.id"
          class="source-version-item"
          :class="{ replaced: version.status === 'replaced' }"
        >
          <el-tag :type="version.status === 'current' ? 'success' : 'info'" effect="plain">
            {{ sourceKindText(version.kind) }} {{ version.status === 'current' ? '当前' : '已替换' }}
          </el-tag>
          <span class="version-name" :title="sourceVersionPath(version)">{{ version.fileName }}</span>
          <span>{{ version.rowCount }} 行</span>
          <span>{{ formatMoney(version.totalAmount) }}</span>
          <small>{{ version.createdAt }}</small>
          <el-button
            v-if="canSwitchSourceVersion(version)"
            size="small"
            text
            type="primary"
            :loading="switchingSourceVersionId === version.id"
            @click="switchSourceVersion(version)"
          >切回</el-button>
        </div>
      </div>
    </div>

    <div v-if="result && !generateResult" class="result-panel" :class="{ failed: !result.ok, blocked: result.ok && result.warnings.length > 0 }">
      <div class="result-title">
        <strong>{{ result.workflowName }}</strong>
        <el-tag
          :type="result.ok ? (result.warnings.length > 0 ? 'warning' : 'success') : 'danger'"
          effect="plain"
        >
          {{ result.ok ? (result.warnings.length > 0 ? '有提醒' : '完成') : '失败' }}
        </el-tag>
      </div>
      <div class="result-lines">
        <p v-if="result.ok && result.warnings.length > 0" class="warning">
          预处理已完成，但存在需要先处理的提醒，系统未自动生成报表。
        </p>
        <p v-for="message in result.messages" :key="message">
          <el-tooltip
            v-if="resultLineHasTooltip(result, message)"
            placement="top-start"
            effect="light"
            :show-after="200"
            popper-class="payroll-diff-tooltip"
          >
            <template #content>
              <div class="payroll-diff-tooltip__content">
                <div v-for="line in resultLineTooltipLines(result, message)" :key="line">{{ line }}</div>
              </div>
            </template>
            <span class="result-line-tooltip-trigger">{{ message }}</span>
          </el-tooltip>
          <span v-else>{{ message }}</span>
        </p>
        <p v-for="warning in result.warnings" :key="warning" class="warning">
          <el-tooltip
            v-if="resultLineHasTooltip(result, warning)"
            placement="top-start"
            effect="light"
            :show-after="200"
            popper-class="payroll-diff-tooltip"
          >
            <template #content>
              <div class="payroll-diff-tooltip__content">
                <div v-for="line in resultLineTooltipLines(result, warning)" :key="line">{{ line }}</div>
              </div>
            </template>
            <span class="result-line-tooltip-trigger">{{ warning }}</span>
          </el-tooltip>
          <span v-else>{{ warning }}</span>
        </p>
      </div>
    </div>

    <div v-if="generateResult" class="result-panel generated" :class="{ failed: !generateResult.ok }">
      <div class="result-title">
        <strong>{{ generateResult.workflowName }}</strong>
        <el-tag :type="generateResult.ok ? 'success' : 'danger'" effect="plain">
          {{ generateResult.ok ? '完成' : '失败' }}
        </el-tag>
      </div>
      <div class="result-lines">
        <p v-for="message in generateResult.messages" :key="message">
          <el-tooltip
            v-if="resultLineHasTooltip(generateResult, message)"
            placement="top-start"
            effect="light"
            :show-after="200"
            popper-class="payroll-diff-tooltip"
          >
            <template #content>
              <div class="payroll-diff-tooltip__content">
                <div v-for="line in resultLineTooltipLines(generateResult, message)" :key="line">{{ line }}</div>
              </div>
            </template>
            <span class="result-line-tooltip-trigger">{{ message }}</span>
          </el-tooltip>
          <span v-else>{{ message }}</span>
        </p>
        <p v-for="warning in generateResult.warnings" :key="warning" class="warning">
          <el-tooltip
            v-if="resultLineHasTooltip(generateResult, warning)"
            placement="top-start"
            effect="light"
            :show-after="200"
            popper-class="payroll-diff-tooltip"
          >
            <template #content>
              <div class="payroll-diff-tooltip__content">
                <div v-for="line in resultLineTooltipLines(generateResult, warning)" :key="line">{{ line }}</div>
              </div>
            </template>
            <span class="result-line-tooltip-trigger">{{ warning }}</span>
          </el-tooltip>
          <span v-else>{{ warning }}</span>
        </p>
      </div>
    </div>

    <section class="history-panel">
      <div class="history-head">
        <strong><el-icon><Clock /></el-icon>历史报表：{{ selectedMonthDisplay }}</strong>
        <el-button text size="small" :icon="Refresh" @click="() => refreshHistory()">刷新</el-button>
      </div>
      <el-table
        :data="selectedMonthRuns"
        v-loading="historyLoading"
        size="small"
        border
        stripe
        row-key="id"
        :expand-row-keys="historyActionRowKeys"
        :max-height="320"
      >
        <el-table-column type="expand" width="1">
          <template #default="{ row }">
            <div class="history-action-row">
              <span class="history-action-label">操作</span>
              <div class="history-actions">
                <el-button
                  v-if="canPushAll(row)"
                  size="small"
                  text
                  type="success"
                  :loading="pushingAllRunId === row.id"
                  @click="pushAllToIntegrated(row)"
                >全部推送</el-button>
                <el-button
                  v-if="row.voucherImportPath"
                  size="small"
                  text
                  type="primary"
                  @click="openHistoryFile(row.voucherImportPath)"
                >凭证</el-button>
                <el-button
                  v-if="row.voucherImportPath"
                  size="small"
                  text
                  type="success"
                  :loading="pushingVoucherRunId === row.id"
                  @click="pushVoucherToIntegrated(row)"
                >推送凭证</el-button>
                <el-button
                  v-if="row.insuranceImportPath"
                  size="small"
                  text
                  type="primary"
                  @click="openHistoryFile(row.insuranceImportPath)"
                >保险导入</el-button>
                <el-button
                  v-if="row.insuranceImportPath"
                  size="small"
                  text
                  type="success"
                  :loading="pushingInsuranceRunId === row.id"
                  @click="pushInsuranceToIntegrated(row)"
                >推送保险</el-button>
                <el-button
                  v-if="row.salaryImportPath"
                  size="small"
                  text
                  type="primary"
                  @click="openHistoryFile(row.salaryImportPath)"
                >工资导入</el-button>
                <el-button
                  v-if="row.payrollBackpayPath"
                  size="small"
                  text
                  type="primary"
                  @click="openHistoryFile(row.payrollBackpayPath)"
                >补发工资</el-button>
                <el-button
                  v-if="row.salaryImportPath || row.payrollBackpayPath"
                  size="small"
                  text
                  type="success"
                  :loading="pushingSalaryRunId === row.id"
                  @click="pushSalaryImportsToIntegrated(row)"
                >推送工资</el-button>
                <el-button
                  v-if="!row.archivedAt && !row.isOutdated"
                  size="small"
                  text
                  type="warning"
                  :loading="buildingExchangePackageId === row.id"
                  @click="buildExchangePackageForRun(row)"
                >生成内网包</el-button>
                <el-button
                  v-if="row.archivedAt"
                  size="small"
                  text
                  type="warning"
                  :loading="buildingExchangeReceiptId === row.id"
                  @click="buildExchangeReceiptForRun(row)"
                >生成回执</el-button>
                <el-button
                  v-if="row.archiveDir"
                  size="small"
                  text
                  type="danger"
                  :loading="cancelingMonthCloseId === row.id"
                  @click="cancelHistoryMonthClose(row)"
                >反月结</el-button>
                <el-button
                  v-else
                  size="small"
                  text
                  type="warning"
                  :loading="archivingId === row.id"
                  :disabled="!canArchiveHistoryRun(row)"
                  @click="archiveHistoryRun(row)"
                >月结</el-button>
                <el-button
                  size="small"
                  text
                  type="primary"
                  @click="viewHistoryReport(row)"
                >查看</el-button>
                <el-button
                  v-if="!row.archivedAt"
                  size="small"
                  text
                  type="danger"
                  @click="deleteHistoryRun(row)"
                >删除</el-button>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="年月" width="110">
          <template #default="{ row }">{{ row.year }}-{{ String(row.month).padStart(2, '0') }}</template>
        </el-table-column>
        <el-table-column label="生成时间" prop="createdAt" min-width="160" />
        <el-table-column label="单位" prop="unitFullName" min-width="180" show-overflow-tooltip />
        <el-table-column label="在职" prop="activeCount" width="70" align="right" />
        <el-table-column label="遗补" prop="survivorCount" width="70" align="right" />
        <el-table-column label="退休房补" prop="retiredHousingCount" width="90" align="right" />
        <el-table-column label="实发合计" width="120" align="right">
          <!-- 实发合计 = 在职实发 + 遗补实发 + 退休房补实发；额度匹配前置总额校验基准（网页工资项总额 = 实发合计 - 002交通费） -->
          <template #default="{ row }">{{
            formatMoney(
              (Number(row.activeActualPay) || 0) +
                (Number(row.survivorActualPay) || 0) +
                (Number(row.retiredHousingActualPay) || 0)
            )
          }}</template>
        </el-table-column>
        <el-table-column label="在职实发" width="120" align="right">
          <template #default="{ row }">{{ formatMoney(row.activeActualPay) }}</template>
        </el-table-column>
        <el-table-column label="遗补实发" width="120" align="right">
          <template #default="{ row }">{{ formatMoney(row.survivorActualPay) }}</template>
        </el-table-column>
        <el-table-column label="退休房补实发" width="140" align="right">
          <template #default="{ row }">{{ formatMoney(row.retiredHousingActualPay) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="180">
          <template #default="{ row }">
            <div class="status-tags">
              <el-tag :type="row.archivedAt ? 'info' : row.isOutdated ? 'warning' : 'success'" effect="plain">
                {{ row.archivedAt ? '已月结' : row.isOutdated ? '已过期' : '可处理' }}
              </el-tag>
              <el-tag
                :type="reconciliationTagType(reconciliationOfRun(row)?.status)"
                effect="plain"
              >
                复核 {{ reconciliationStatusText(reconciliationOfRun(row)?.status) }}
              </el-tag>
              <el-tag
                v-if="row.exchangePackageStatus"
                :type="exchangeStatusTagType(row.exchangePackageStatus)"
                effect="plain"
              >
                {{ exchangeStatusText(row.exchangePackageStatus) }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="推送" width="220">
          <template #default="{ row }">
            <div class="status-tags">
              <el-tag :type="pushStatusTagType(row.voucherPushStatus)" effect="plain">
                凭证 {{ pushStatusText(row.voucherPushStatus) }}
              </el-tag>
              <el-tag :type="pushStatusTagType(row.insurancePushStatus)" effect="plain">
                保险 {{ pushStatusText(row.insurancePushStatus) }}
              </el-tag>
              <el-tag :type="pushStatusTagType(row.salaryPushStatus)" effect="plain">
                工资 {{ pushStatusText(row.salaryPushStatus) }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="数据来源" width="120">
          <template #default="{ row }">
            <el-tag :type="dataSourceModeTagType(row.dataSourceMode)" effect="plain">
              {{ dataSourceModeText(row.dataSourceMode) }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="report" class="report-view">
      <div class="report-toolbar">
        <div>
          <div class="report-title-row">
            <strong>报表视图</strong>
            <el-tag size="small" effect="plain">{{ selectedMonthDisplay }}</el-tag>
            <el-tag
              size="small"
              :type="dataSourceModeTagType(report.dataSourceMode ?? selectedHistoryRun?.dataSourceMode)"
              effect="plain"
            >
              {{ dataSourceModeText(report.dataSourceMode ?? selectedHistoryRun?.dataSourceMode) }}
            </el-tag>
            <el-tag
              v-if="report.reconciliation"
              size="small"
              :type="reconciliationTagType(report.reconciliation.status)"
              effect="plain"
            >
              自动复核 {{ reconciliationStatusText(report.reconciliation.status) }}
            </el-tag>
          </div>
          <p v-if="report">{{ report.message }}</p>
          <p
            v-if="report.reconciliation"
            class="reconciliation-summary"
            :class="{ failed: report.reconciliation.status !== 'passed' }"
          >
            {{ report.reconciliation.summary }}
          </p>
          <small
            v-for="issue in report.reconciliation?.issues.slice(0, 4) ?? []"
            :key="`${issue.checkKey}-${issue.message}`"
            class="reconciliation-issue"
          >复核差异：{{ issue.message }}</small>
          <small v-if="report?.salaryImportPath">工资导入：{{ report.salaryImportPath }}</small>
          <small v-if="report?.payrollBackpayPath">补发工资：{{ report.payrollBackpayPath }}</small>
          <small v-if="report?.insuranceImportPath">保险导入：{{ report.insuranceImportPath }}</small>
          <small v-if="report?.voucherImportPath">凭证导入：{{ report.voucherImportPath }}</small>
          <small v-if="selectedHistoryRun?.archiveDir">月结目录：{{ selectedHistoryRun.archiveDir }}</small>
        </div>
        <div class="print-controls">
          <div class="printer-selects">
            <label>
              <span>报表打印机</span>
              <el-select
                v-model="printSettings.reportPrinterName"
                size="small"
                filterable
                placeholder="选择打印机"
                @change="savePrintSettings"
              >
                <el-option
                  v-for="printer in printers"
                  :key="printer.name"
                  :label="`${printer.displayName}${printer.isDefault ? '（默认）' : ''}`"
                  :value="printer.name"
                />
              </el-select>
            </label>
            <label>
              <span>票据打印机</span>
              <el-select
                v-model="printSettings.voucherPrinterName"
                size="small"
                filterable
                placeholder="选择打印机"
                @change="savePrintSettings"
              >
                <el-option
                  v-for="printer in printers"
                  :key="printer.name"
                  :label="`${printer.displayName}${printer.isDefault ? '（默认）' : ''}`"
                  :value="printer.name"
                />
              </el-select>
            </label>
          </div>
          <div v-if="activeSheet?.name === '报销凭证'" class="voucher-offset-controls">
            <label>
              <span>横向偏移 mm</span>
              <el-input-number
                v-model="printSettings.voucherOffsetX"
                size="small"
                :min="-30"
                :max="30"
                :step="0.5"
                :precision="1"
                controls-position="right"
                @change="savePrintSettings"
              />
            </label>
            <label>
              <span>纵向偏移 mm</span>
              <el-input-number
                v-model="printSettings.voucherOffsetY"
                size="small"
                :min="-30"
                :max="30"
                :step="0.5"
                :precision="1"
                controls-position="right"
                @change="savePrintSettings"
              />
            </label>
          </div>
          <div v-else-if="activeSheet" class="report-offset-controls">
            <label>
              <span>报表横向偏移 mm</span>
              <el-input-number
                v-model="printSettings.reportOffsetX"
                size="small"
                :min="-20"
                :max="20"
                :step="0.5"
                :precision="1"
                controls-position="right"
                @change="savePrintSettings"
              />
            </label>
            <label class="a4-debug-toggle">
              <span>A4边框</span>
              <el-switch v-model="showA4DebugBorder" size="small" />
            </label>
          </div>
          <label class="print-page-range">
            <span>打印页码</span>
            <el-input
              v-model="printPageRangeText"
              size="small"
              clearable
              placeholder="全部，例如 1 或 1-2"
            />
          </label>
          <div class="print-button-row">
            <el-button
              :icon="FolderOpened"
              :loading="selectedHistoryRun ? archivingId === selectedHistoryRun.id : false"
              :disabled="!canArchiveHistoryRun(selectedHistoryRun)"
              @click="archiveHistoryRun(selectedHistoryRun)"
            >
              {{ selectedHistoryRun?.archivedAt ? '已月结' : '月结该月' }}
            </el-button>
            <el-button
              :icon="Printer"
              :loading="printing"
              :disabled="!activeSheet || (!isReportPrintSheet(activeSheet.name) && !isVoucherPrintSheet(activeSheet.name))"
              @click="printCurrentReport"
            >
              {{ printButtonText }}
            </el-button>
            <el-button
              type="primary"
              :icon="Printer"
              :loading="printing"
              :disabled="!canPrintAll"
              @click="printAllReports"
            >
              全部打印
            </el-button>
          </div>
          <small>{{ currentPrinterLabel }}：{{ currentPrinterName || '未选择' }}</small>
        </div>
      </div>

      <el-tabs v-model="activeReportSheet" class="report-tabs">
        <el-tab-pane
          v-for="sheet in visibleSheets"
          :key="sheet.name"
          :label="sheet.name"
          :name="sheet.name"
        />
      </el-tabs>

      <div v-if="activeSheet?.name === '凭证'" class="voucher-table-wrap">
        <table class="voucher-table">
          <thead>
            <tr>
              <th v-for="(col, idx) in activeSheet.columns" :key="idx">{{ col }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rIdx) in activeSheet.rows" :key="rIdx">
              <td v-for="(cell, cIdx) in row" :key="cIdx" :class="{ 'col-money': cIdx === 5 || cIdx === 6 }">
                {{ formatVoucherCell(row, cell, cIdx) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="activeSheet?.name === '报销凭证'" class="voucher-stack">
        <article
          v-for="(row, index) in activeSheet.rows"
          :key="index"
          class="voucher-page"
          :class="{ 'salary-voucher': isSalaryVoucher(row) }"
          :data-print-page-index="index + 1"
          :style="voucherPageStyle"
        >
          <span class="voucher-item unit-name">{{ row[1] }}</span>
          <span class="voucher-item voucher-year">{{ row[10] }}</span>
          <span class="voucher-item voucher-month">{{ row[11] }}</span>
          <span class="voucher-item voucher-day">{{ row[12] }}</span>

          <span class="voucher-item amount-upper reimburse-upper">{{ voucherUpperAmount(row, 2) }}</span>
          <span class="voucher-item amount-number reimburse-number">{{ voucherAmount(row[2]) }}</span>
          <span class="voucher-item amount-upper unpaid-upper">{{ voucherUpperAmount(row, 3) }}</span>
          <span class="voucher-item amount-number unpaid-number">{{ voucherAmount(row[3]) }}</span>
          <span class="voucher-item amount-upper actual-upper">{{ voucherUpperAmount(row, 4) }}</span>
          <span class="voucher-item amount-number actual-number">{{ voucherAmount(row[4]) }}</span>
          <span class="voucher-item amount-upper order-upper">{{ voucherUpperAmount(row, 4) }}</span>
          <span class="voucher-item amount-number order-number">{{ voucherAmount(row[4]) }}</span>
          <span class="voucher-item amount-upper transfer-upper">{{ Number(row[6] || 0) ? voucherUpperAmount(row, 6) : '' }}</span>
          <span class="voucher-item amount-number transfer-number">{{ voucherAmount(row[6]) }}</span>

          <span
            v-if="voucherPrintTotalPagesForRow(row) !== null"
            class="voucher-item voucher-total-pages"
          >
            {{ voucherPrintTotalPagesForRow(row) }}
          </span>
          <span class="voucher-item voucher-usage-print">{{ voucherUsagePrintText(row) }}</span>
        </article>
      </div>

      <template v-else-if="activeSheet">
        <div
          v-for="(page, pageIdx) in activePages"
          :key="pageIdx"
          class="print-page"
          :class="[
            reportSheetClass(activeSheet.name),
            {
              'custom-styled': isCustomStyledSheet(activeSheet.name),
              'a4-debug': showA4DebugBorder
            }
          ]"
          :data-print-page-index="pageIdx + 1"
          :style="reportPageStyle"
        >
          <div class="print-area">
            <table class="report-table">
              <colgroup>
                <col
                  v-for="(width, colIdx) in colWidthPercents(page.columnWidths, page.columns.length)"
                  :key="colIdx"
                  :style="`width:${width}`"
                />
              </colgroup>
              <thead v-if="page.showColumnHeader !== false">
                <tr>
                  <th v-for="(column, index) in page.columns" :key="`${column}-${index}`">
                    {{ column }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <template v-for="(row, rowIndex) in page.rows" :key="rowIndex">
                  <tr :style="rowHeightStyle(page.rowHeights, rowIndex)">
                    <template v-for="(cell, cellIndex) in row" :key="cellIndex">
                      <td
                        v-if="!mergeFor(activePageMergeMaps[pageIdx], rowIndex + 1, cellIndex + 1)?.covered"
                        :colspan="mergeFor(activePageMergeMaps[pageIdx], rowIndex + 1, cellIndex + 1)?.master?.colspan"
                        :rowspan="mergeFor(activePageMergeMaps[pageIdx], rowIndex + 1, cellIndex + 1)?.master?.rowspan"
                      >{{ cell }}</td>
                    </template>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </section>
  </section>
</template>

<style scoped>
.monthly-page {
  flex: 1;
  min-width: 0;
  padding: 18px;
  background: var(--surface);
  overflow: auto;
}

.monthly-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.monthly-header h1 {
  margin: 0;
  color: var(--text);
  font-size: 20px;
  font-weight: 650;
}

.monthly-header p {
  margin: 6px 0 0;
  color: var(--text-3);
  font-size: 13px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.month-overview {
  display: grid;
  grid-template-columns: minmax(300px, 0.8fr) minmax(360px, 1fr) minmax(360px, 1fr);
  gap: 12px;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.month-picker-block {
  display: grid;
  gap: 12px;
}

.month-picker-line {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.month-picker-line strong,
.primary-data-source strong,
.tax-rule-settings strong {
  color: var(--text);
  font-size: 14px;
}

.month-picker-line .el-date-editor {
  width: 168px;
}

.month-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.month-stats span {
  display: grid;
  gap: 4px;
  min-height: 42px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
}

.month-stats small {
  color: var(--text-3);
  font-size: 12px;
}

.month-stats b {
  color: var(--text);
  font-size: 18px;
  font-weight: 650;
  line-height: 1;
}

.primary-data-source {
  display: grid;
  align-content: center;
  gap: 10px;
  min-width: 0;
}

.primary-data-source p {
  margin: 6px 0 0;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.5;
}

.source-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tax-rule-settings {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  min-width: 0;
}

.tax-rule-settings p {
  margin: 6px 0 0;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.5;
}

.tax-rule-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 1360px) {
  .month-overview {
    grid-template-columns: 1fr;
  }

  .tax-rule-settings {
    align-items: flex-start;
  }
}

@media (max-width: 720px) {
  .month-stats {
    grid-template-columns: 1fr;
  }

  .tax-rule-settings,
  .tax-rule-actions {
    align-items: flex-start;
    justify-content: flex-start;
  }
}

.monthly-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  max-width: none;
  margin-top: 16px;
}

@media (max-width: 960px) {
  .monthly-grid {
    grid-template-columns: 1fr;
  }
}

.file-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 80px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.file-row .el-tag {
  align-self: flex-start;
  flex-shrink: 0;
}

.file-row.missing {
  background: var(--surface-2);
}

.file-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius);
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 19px;
}

.file-main {
  display: grid;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.file-main strong {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 14px;
}

.file-main strong span {
  color: var(--text-3);
  font-size: 12px;
  font-weight: 400;
}

.file-main > span,
.file-main small {
  overflow: hidden;
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-main > span {
  font-size: 13px;
}

.file-main small {
  font-size: 12px;
}

.process-mode-panel,
.result-panel {
  max-width: none;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.process-mode-panel {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}

.process-mode-panel strong {
  color: var(--text);
  font-size: 14px;
}

:global(.monthly-payroll-confirm-box) {
  max-width: 620px;
}

:global(.payroll-confirm-summary) {
  margin-bottom: 12px;
  color: #1f2937;
  font-weight: 600;
}

:global(.payroll-confirm-table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

:global(.payroll-confirm-table th),
:global(.payroll-confirm-table td) {
  padding: 8px 10px;
  border: 1px solid #d8dee8;
  text-align: left;
  vertical-align: top;
}

:global(.payroll-confirm-table th) {
  background: #f4f7fb;
  color: #374151;
  font-weight: 600;
}

:global(.payroll-confirm-table td) {
  color: #4b5563;
}

.result-panel {
  border-color: var(--success);
  background: var(--success-soft);
}

.result-panel.failed {
  border-color: var(--danger);
  background: var(--danger-soft);
}

.result-panel.blocked {
  border-color: #f59e0b;
  background: #fffbeb;
}

.result-panel.generated {
  background: var(--surface);
}

.result-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.result-lines {
  display: grid;
  gap: 4px;
  margin-top: 10px;
}

.result-lines p {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
}

.result-lines .warning {
  color: #b45309;
}

.result-line-tooltip-trigger {
  cursor: help;
  text-decoration: underline dotted currentColor;
  text-underline-offset: 3px;
}

:global(.payroll-diff-tooltip) {
  max-width: 560px;
}

:global(.payroll-diff-tooltip__content) {
  display: grid;
  gap: 4px;
  line-height: 1.6;
  white-space: normal;
}

.result-panel.failed .result-lines .warning {
  color: var(--danger);
}

.next-step {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.next-step strong {
  color: var(--text);
  font-size: 13px;
}

.next-step p {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}

.next-step .el-button {
  margin-top: 10px;
}

.report-view {
  max-width: none;
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.history-panel {
  max-width: none;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.history-head strong {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 14px;
}

.history-panel :deep(.el-table__expand-column .cell) {
  display: none;
}

.history-panel :deep(.el-table__expanded-cell) {
  padding: 6px 10px 8px;
  background: #fbfcff;
}

.history-action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
}

.history-action-label {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.history-actions {
  display: flex;
  align-items: center;
  flex: 1;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 8px;
}

.history-actions .el-button {
  margin-left: 0;
}

.status-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.source-version-panel {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #f8fafc;
}

.source-version-panel > strong {
  display: block;
  margin-bottom: 8px;
  color: var(--text);
  font-size: 13px;
}

.source-version-list {
  display: grid;
  gap: 6px;
}

.source-version-item {
  display: grid;
  grid-template-columns: 92px minmax(160px, 1fr) 70px 110px 155px 56px;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  color: var(--text-2);
  font-size: 12px;
}

.source-version-item.replaced {
  color: var(--text-3);
}

.version-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
  border-bottom: 1px solid var(--border);
}

.report-toolbar p,
.report-toolbar small {
  display: block;
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 12.5px;
}

.report-toolbar .reconciliation-summary {
  color: var(--success);
  font-weight: 600;
}

.report-toolbar .reconciliation-summary.failed,
.report-toolbar .reconciliation-issue {
  color: var(--danger);
}

.print-controls {
  display: grid;
  justify-items: end;
  gap: 8px;
  min-width: 460px;
}

.printer-selects {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  width: 100%;
}

.voucher-offset-controls {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  width: 100%;
}

.report-offset-controls {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: end;
  gap: 8px;
  width: 100%;
}

.a4-debug-toggle {
  min-width: 88px;
}

.a4-debug-toggle .el-switch {
  justify-self: start;
}

.print-page-range {
  display: grid;
  gap: 4px;
  width: 100%;
}

.printer-selects label,
.voucher-offset-controls label,
.report-offset-controls label,
.print-page-range {
  display: grid;
  gap: 4px;
}

.printer-selects span,
.voucher-offset-controls span,
.report-offset-controls span,
.print-page-range span {
  color: var(--text-3);
  font-size: 12px;
}

.printer-selects .el-select,
.voucher-offset-controls .el-input-number,
.report-offset-controls .el-input-number,
.print-page-range .el-input {
  width: 100%;
}

.report-tabs {
  padding: 0 14px;
}

.print-page {
  width: 210mm;
  min-height: 297mm;
  margin: 0 auto 18px;
  padding-top: 18mm;
  background: #fff;
  box-sizing: border-box;
}

.print-page.a4-debug {
  outline: 1px dashed #8a8f98;
  outline-offset: -1px;
}

.print-area {
  overflow: visible;
  box-sizing: border-box;
}

.sheet-standard .print-area {
  width: 182mm;
  margin: 0 auto;
}

.sheet-wide {
  width: max-content;
  min-width: 210mm;
  min-height: auto;
  padding: 14mm 12mm;
}

.sheet-wide .print-area {
  width: max-content;
  margin: 0 auto;
}

.sheet-wide .report-table {
  width: auto;
  table-layout: auto;
  font-size: 10pt;
}

.sheet-wide .report-table th,
.sheet-wide .report-table td {
  padding: 4px 8px;
  white-space: nowrap;
  word-break: keep-all;
  overflow: visible;
}

.sheet-backpay .report-table {
  min-width: 430mm;
}

.sheet-insurance-import .report-table {
  min-width: 330mm;
}

.report-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
}

.report-table th,
.report-table td {
  padding: 4px 6px;
  border: 1px solid #000;
  color: #000;
  text-align: left;
  white-space: normal;
  word-break: keep-all;
  line-height: 1.18;
  overflow: hidden;
}

.report-table th {
  background: #fff;
  font-weight: 400;
  text-align: center;
}

/* Three custom-styled sheets (自动生成 / 五险一金 / 工退遗汇总):
   data area has black 1px borders; title/subtitle/unit rows stay borderless. */

/* 自动生成 — rows 1-3 (title, subtitle, 财务/预算 band) borderless;
   row 4+ (column headers + data) gets borders. */
.sheet-auto .report-table tr:nth-child(-n+3) td {
  border: 0;
}

/* 五险一金 — same pattern: rows 1-3 borderless, row 4+ borders. */
.sheet-insurance .report-table tr:nth-child(-n+3) td {
  border: 0;
}

/* 工退遗汇总 — title/unit/blank/footer borderless; sections are rendered as two stacked bands. */
.sheet-summary .report-table tr:nth-child(-n+2) td,
.sheet-summary .report-table tr:nth-child(6) td,
.sheet-summary .report-table tr:nth-child(10) td {
  border: 0;
}

/* 自动生成 — 12-column three-band layout (left summary, middle 财务会计, right 预算会计) */
.sheet-auto .print-area {
  width: 206mm;
  margin: 0 auto;
}

.sheet-auto .report-table {
  font-size: 10pt;
}

.sheet-auto .report-table td {
  padding: 1px 3px;
  vertical-align: middle;
}

.sheet-auto .report-table tr:nth-child(1) td {
  font-size: 16pt;
  font-weight: 700;
  text-align: center;
}

.sheet-auto .report-table tr:nth-child(2) td {
  font-size: 12pt;
  text-align: right;
}

.sheet-auto .report-table tr:nth-child(3) td {
  font-size: 12pt;
  text-align: center;
}

.sheet-auto .report-table tr:nth-child(4) td {
  font-size: 11pt;
  text-align: center;
}

.sheet-auto .report-table tr:nth-child(13) td:first-child {
  text-align: center;
}

.sheet-auto .report-table tr:nth-child(19) td {
  text-align: left;
}

/* 五险一金 — 7-column two-band layout */
.sheet-insurance .print-area {
  width: 182mm;
  margin: 0 auto;
}

.sheet-insurance .report-table {
  font-size: 9pt;
}

.sheet-insurance .report-table td {
  padding: 1px 4px;
  vertical-align: middle;
}

.sheet-insurance .report-table tr:nth-child(1) td {
  font-size: 16pt;
  font-weight: 700;
  text-align: center;
}

.sheet-insurance .report-table tr:nth-child(2) td {
  font-size: 12pt;
  text-align: right;
}

.sheet-insurance .report-table tr:nth-child(3) td,
.sheet-insurance .report-table tr:nth-child(4) td {
  font-size: 9pt;
  text-align: center;
}

/* 工退遗汇总 — portrait A4 summary table */
.sheet-summary {
  width: 210mm;
  min-height: 297mm;
  padding-top: 14mm;
}

.sheet-summary .print-area {
  width: 200mm;
  margin: 0 auto;
}

.sheet-summary .report-table {
  table-layout: fixed;
  font-size: 8pt;
}

.sheet-summary .report-table td {
  padding: 2px 2px;
  text-align: center;
  word-break: break-all;
  line-height: 1.12;
  vertical-align: middle;
  white-space: pre-line;
}

.sheet-summary .report-table tr:nth-child(1) td {
  font-size: 18pt;
  word-break: keep-all;
  white-space: nowrap;
}

.sheet-summary .report-table tr:nth-child(2) td {
  font-size: 9pt;
}

.sheet-summary .report-table tr:nth-child(3) td,
.sheet-summary .report-table tr:nth-child(7) td {
  font-size: 11pt;
  font-weight: 600;
  text-align: center;
  word-break: keep-all;
  white-space: nowrap;
}

.sheet-summary .report-table tr:nth-child(10) td {
  font-size: 9pt;
  word-break: keep-all;
  white-space: nowrap;
}

.sheet-summary .report-table tr:nth-child(4) td,
.sheet-summary .report-table tr:nth-child(8) td {
  font-size: 7.6pt;
  line-height: 1.08;
}

.sheet-summary .report-table tr:nth-child(5) td,
.sheet-summary .report-table tr:nth-child(9) td {
  padding: 2px 1px;
  font-size: 7.6pt;
  overflow: visible;
  white-space: nowrap;
  word-break: keep-all;
}

/* 退休房补 — 6-column simple list: title + header + data + total */
.sheet-retired-housing .print-area {
  width: 200mm;
  margin: 0 auto;
}

.sheet-retired-housing .report-table {
  font-size: 10pt;
}

.sheet-retired-housing .report-table td {
  padding: 1px 4px;
  vertical-align: middle;
  text-align: center;
}

.sheet-retired-housing .report-table tr:nth-child(1) td {
  font-size: 16pt;
  font-weight: 700;
  text-align: center;
  border: 0;
}

.sheet-retired-housing .report-table tr:nth-child(2) td {
  font-weight: 600;
  text-align: center;
}

.print-button-row {
  display: flex;
  gap: 8px;
}

.report-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.voucher-table-wrap {
  width: 100%;
  max-height: 70vh;
  overflow: auto;
  padding: 12px 14px 18px;
  background: #fff;
}

.voucher-table {
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}

.voucher-table th,
.voucher-table td {
  padding: 4px 8px;
  border: 1px solid var(--border);
  color: #000;
}

.voucher-table th {
  position: sticky;
  top: 0;
  background: var(--surface-2, #f5f5f5);
  font-weight: 600;
  z-index: 1;
}

.voucher-table td.col-money {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.voucher-stack {
  display: grid;
  gap: 18px;
  background: #fff;
}

.voucher-page {
  position: relative;
  width: 230mm;
  height: 132mm;
  margin: 0 auto;
  overflow: visible;
  background: #fff;
  color: #000;
  font-family: 'Microsoft YaHei', 'Microsoft YaHei UI', SimHei, sans-serif;
  font-size: 15pt;
  page-break-after: always;
  --voucher-offset-x: 0mm;
  --voucher-offset-y: 0mm;
}

.voucher-item {
  position: absolute;
  display: block;
  color: #000;
  font-family: 'Microsoft YaHei', 'Microsoft YaHei UI', SimHei, sans-serif;
  font-size: 12pt;
  line-height: 1.1;
  white-space: nowrap;
  overflow: visible;
  transform: translate(var(--voucher-offset-x), var(--voucher-offset-y));
}

.voucher-label {
  font-size: 12pt;
}

.pay-method-label {
  left: 151.08mm;
  top: 3.44mm;
}

.pay-amount-label {
  left: 189.44mm;
  top: 3.18mm;
}

.pay-order-label {
  left: 151.08mm;
  top: 9.79mm;
}

.transfer-label {
  left: 151.08mm;
  top: 16.40mm;
}

.pay-order-top {
  left: 164.84mm;
  top: 10.32mm;
  width: 22.49mm;
  font-size: 12pt;
}

.pay-amount-top {
  left: 189.44mm;
  top: 9.79mm;
  width: 22.49mm;
  font-size: 12pt;
}

.transfer-top {
  left: 189.44mm;
  top: 16.67mm;
  width: 22.49mm;
  font-size: 12pt;
}

.unit-name {
  left: 40.33mm;
  top: 35.22mm;
  width: 37.04mm;
}

.voucher-year {
  left: 122.80mm;
  top: 35.22mm;
  width: 9.26mm;
}

.voucher-month {
  left: 141.53mm;
  top: 35.22mm;
  width: 9.26mm;
}

.voucher-day {
  left: 155.23mm;
  top: 35.22mm;
  width: 9.26mm;
}

.amount-upper {
  left: 66.15mm;
  width: 60.85mm;
}

.amount-number {
  left: 144.65mm;
  width: 26.46mm;
}

.reimburse-upper,
.reimburse-number {
  top: 55.83mm;
}

.unpaid-upper,
.unpaid-number {
  top: 83.96mm;
}

.actual-upper,
.actual-number {
  top: 93.90mm;
}

.order-upper,
.order-number {
  top: 107.90mm;
}

.transfer-upper,
.transfer-number {
  top: 105.57mm;
}

.voucher-usage-print {
  left: 180.34mm;
  top: 70.35mm;
  width: 88mm;
  height: 59.53mm;
  font-family: 'Microsoft YaHei', 'Microsoft YaHei UI', SimHei, sans-serif;
  font-size: 10.5pt;
  line-height: 1.08;
  white-space: pre-line;
  overflow: visible;
}

.voucher-total-pages {
  left: 215.34mm;
  top: 51.35mm;
  width: 45mm;
  font-size: 10.5pt;
  font-family: 'Microsoft YaHei', 'Microsoft YaHei UI', SimHei, sans-serif;
  line-height: 1;
  z-index: 2;
}

.salary-voucher .amount-upper {
  width: 62mm;
  font-size: 12pt;
  line-height: 1;
}

.salary-voucher .amount-number {
  font-size: 12pt;
}

.salary-voucher .voucher-usage-print {
  font-size: 10.5pt;
  line-height: 1.18;
}

@media print {
  @page {
    size: A4 portrait;
    margin: 0;
  }

  @page voucher-slip {
    size: 230mm 132mm;
    margin: 0;
  }

  .voucher-table-wrap {
    display: none !important;
  }

  :global(.md-topbar),
  :global(.md-sidebar),
  .monthly-header,
  .month-overview,
  .monthly-grid,
  .source-version-panel,
  .process-mode-panel,
  .result-panel,
  .report-toolbar,
  .report-tabs,
  .history-panel {
    display: none !important;
  }

  .monthly-page,
  .report-view {
    padding: 0;
    border: 0;
    margin: 0;
    overflow: visible;
    background: #fff;
  }

  .report-view {
    max-width: none;
  }

  .print-page {
    width: 210mm;
    height: 297mm;
    min-height: 297mm;
    margin: 0 auto;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    page-break-after: always;
  }

  .print-page.a4-debug {
    outline: 0 !important;
  }

  .print-page.sheet-auto,
  .print-page.sheet-insurance,
  .print-page.sheet-summary,
  .print-page.sheet-retired-housing,
  .print-page.sheet-standard {
    width: 210mm;
    height: 130mm;
    min-height: 130mm;
    max-height: 130mm;
    padding-top: 6mm;
    overflow: hidden;
  }

  .voucher-stack {
    gap: 0;
  }

  .voucher-page {
    page: voucher-slip;
    width: 230mm;
    height: 132mm;
    margin: 0;
    page-break-after: always;
  }

  .voucher-page:last-child {
    page-break-after: auto;
  }

  .print-area {
    border: 0;
    overflow: visible;
    box-sizing: border-box;
    transform: translateX(var(--report-offset-x, 0mm));
    transform-origin: top center;
  }

  .report-table th,
  .report-table td {
    color: #000;
    border-color: #000;
  }
}
</style>
