<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Clock, DocumentChecked, FolderOpened, Printer, Refresh, VideoPlay } from '@element-plus/icons-vue'
import type {
  ImportWatcherStatus,
  MonthlyPayrollReportResult,
  MonthlyPayrollReportSheet,
  MonthlyPayrollPrintSettings,
  MonthlyPayrollRun,
  MonthlyPayrollSalaryPrintPageSummary,
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
  openFolder: []
}>()

const running = ref(false)
const generating = ref(false)
const result = ref<WorkflowRunResult | null>(null)
const generateResult = ref<WorkflowRunResult | null>(null)
const report = ref<MonthlyPayrollReportResult | null>(null)
const activeReportSheet = ref('')
const printPageRangeText = ref('')
const history = ref<MonthlyPayrollRun[]>([])
const historyLoading = ref(false)
const archivingId = ref<number | null>(null)
const printers = ref<PrinterSummary[]>([])
const printSettings = ref<MonthlyPayrollPrintSettings>({
  reportPrinterName: '',
  voucherPrinterName: '',
  voucherOffsetX: 0,
  voucherOffsetY: 0
})
const printing = ref(false)
const voucherPrintTotalPages = ref<number | null>(null)
const voucherPrintTotalPagesLoading = ref(false)

onMounted(() => {
  void refreshHistory({ autoOpenCurrentMonth: true })
  void loadPrintOptions()
})

watch(
  () => props.refreshKey,
  () => {
    void refreshHistory()
  }
)

async function loadPrintOptions() {
  const [nextPrinters, settings] = await Promise.all([
    window.salaryApi.listPrinters(),
    window.salaryApi.getMonthlyPayrollPrintSettings()
  ])
  printers.value = nextPrinters
  printSettings.value = {
    reportPrinterName: settings.reportPrinterName || nextPrinters.find((item: PrinterSummary) => item.isDefault)?.name || '',
    voucherPrinterName: settings.voucherPrinterName || '',
    voucherOffsetX: Number(settings.voucherOffsetX ?? 0),
    voucherOffsetY: Number(settings.voucherOffsetY ?? 0)
  }
}

async function savePrintSettings() {
  printSettings.value = await window.salaryApi.setMonthlyPayrollPrintSettings({
    ...printSettings.value
  })
}

async function refreshHistory(options: { autoOpenCurrentMonth?: boolean } = {}) {
  historyLoading.value = true
  try {
    const nextHistory = await window.salaryApi.listMonthlyPayrollRuns()
    history.value = nextHistory
    if (options.autoOpenCurrentMonth) {
      await openLatestCurrentMonthReport(nextHistory)
    }
  } finally {
    historyLoading.value = false
  }
}

async function openHistoryFile(path: string | null) {
  if (!path) return
  const err = await window.salaryApi.openLocalPath(path)
  if (err) ElMessage.error(`无法打开：${err}`)
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
  report.value = snapshot
  activeReportSheet.value = firstVisibleSheetName(snapshot.sheets)
  selectedMonth.value = `${row.year}-${String(row.month).padStart(2, '0')}`
  if (showMessage) ElMessage.success('已打开历史报表视图')
}

function firstVisibleSheetName(sheets: MonthlyPayrollReportSheet[]): string {
  return sheets.find((sheet) => !HIDDEN_TAB_SHEETS.has(sheet.name))?.name ?? sheets[0]?.name ?? ''
}

async function openLatestCurrentMonthReport(rows: MonthlyPayrollRun[]) {
  if (report.value || running.value || generating.value) return
  const now = new Date()
  const latestCurrentMonth = rows.find((row) =>
    row.year === now.getFullYear() && row.month === now.getMonth() + 1
  )
  if (latestCurrentMonth) {
    await loadHistoryReport(latestCurrentMonth, false)
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
type ProcessMode = 'salary' | 'social' | 'salary-social'
const selectedProcessMode = ref<ProcessMode>('salary')
const processModeTouched = ref(false)

const availableProcessModes = computed<Array<{ label: string; value: ProcessMode }>>(() => {
  const hasSalary = Boolean(detected.value?.salaryWorkbookPath)
  const hasSocial = Boolean(detected.value?.socialSecurityWorkbookPath)
  if (hasSalary && hasSocial) {
    return [
      { label: '工资+社保', value: 'salary-social' },
      { label: '只报工资', value: 'salary' },
      { label: '只报社保', value: 'social' }
    ]
  }
  if (hasSalary) return [{ label: '只报工资', value: 'salary' }]
  if (hasSocial) return [{ label: '只报社保', value: 'social' }]
  return []
})

function defaultProcessMode(): ProcessMode {
  if (detected.value?.salaryWorkbookPath && detected.value?.socialSecurityWorkbookPath) {
    return 'salary-social'
  }
  if (detected.value?.socialSecurityWorkbookPath) return 'social'
  return 'salary'
}

watch(
  detected,
  () => {
    const available = new Set(availableProcessModes.value.map((item) => item.value))
    if (!available.has(selectedProcessMode.value) || !processModeTouched.value) {
      selectedProcessMode.value = defaultProcessMode()
    }
  },
  { immediate: true }
)

function markProcessModeTouched(): void {
  processModeTouched.value = true
}

watch(
  () => [selectedProcessMode.value, report.value] as const,
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
const currentMonthArchivedRun = computed(() =>
  history.value.find((row) =>
    row.year === new Date().getFullYear() &&
    row.month === new Date().getMonth() + 1 &&
    row.archivedAt
  )
)
const isCurrentMonthArchived = computed(() => Boolean(currentMonthArchivedRun.value))
const canRun = computed(() =>
  availableProcessModes.value.some((item) => item.value === selectedProcessMode.value) &&
  !isCurrentMonthArchived.value
)

const modeText = computed(() => {
  const hasTax = Boolean(detected.value?.taxWorkbookPath)
  if (selectedProcessMode.value === 'salary-social') {
    return hasTax ? '工资 + 社保 + 个税' : '工资 + 社保'
  }
  if (selectedProcessMode.value === 'social') {
    return hasTax ? '只报社保 + 个税' : '只报社保'
  }
  if (detected.value?.salaryWorkbookPath) return hasTax ? '只报工资 + 个税' : '只报工资'
  return '等待工资表或社保'
})

const fileRows = computed(() => [
  {
    label: '本月工资表',
    required: selectedProcessMode.value !== 'social',
    name: detected.value?.salaryWorkbookName,
    path: detected.value?.salaryWorkbookPath,
    hint: selectedProcessMode.value === 'social'
      ? '本次只报社保，工资表仅用于同时生成工资凭证'
      : '工资表或社保文件至少需要一个，例如 512扎下小学--2026年5月份工资表.xlsx'
  },
  {
    label: '社保未申报汇总',
    required: selectedProcessMode.value !== 'salary',
    name: detected.value?.socialSecurityWorkbookName,
    path: detected.value?.socialSecurityWorkbookPath,
    hint: selectedProcessMode.value === 'salary'
      ? '本次只报工资，社保后续单独处理'
      : '只处理社保时需要放入社保未申报汇总文件'
  },
  {
    label: '个税计算表',
    required: false,
    name: detected.value?.taxWorkbookName,
    path: detected.value?.taxWorkbookPath,
    hint: '未检测到时跳过个税扣款和补发工资'
  }
])

async function confirmMonthlyPayrollPreprocess(): Promise<boolean> {
  const files = detected.value
  const hasSalary = Boolean(files?.salaryWorkbookPath)
  const hasTax = Boolean(files?.taxWorkbookPath)
  const mode = selectedProcessMode.value === 'salary-social'
    ? hasTax
      ? '本次处理：工资报账、社保报账、个税扣款。'
      : '本次处理：工资报账、社保报账；不报个税。'
    : selectedProcessMode.value === 'social'
      ? hasTax
        ? `本次只打印社保相关报表，并生成工资和社保凭证；包含个税。${hasSalary ? '' : '未检测到工资表，只生成社保凭证。'}`
        : `本次只打印社保相关报表，并生成工资和社保凭证；不报个税。${hasSalary ? '' : '未检测到工资表，只生成社保凭证。'}`
      : hasTax
        ? '本次只处理工资报账和个税扣款；不生成凭证。'
        : '本次只处理工资报账，不报个税。'

  try {
    await ElMessageBox.confirm(
      mode,
      '确认处理范围',
      {
        type: selectedProcessMode.value === 'salary-social' ? 'info' : 'warning',
        confirmButtonText: '继续预处理',
        cancelButtonText: '返回检查',
        dangerouslyUseHTMLString: false
      }
    )
    return true
  } catch {
    return false
  }
}

function currentPayload(options: { confirmWriteBack?: boolean } = {}): WorkflowRunPayload | null {
  if (!detected.value?.salaryWorkbookPath && !detected.value?.socialSecurityWorkbookPath) return null
  const now = new Date()
  const processScope = selectedProcessMode.value
  return {
    monthlyPayroll: {
      salaryWorkbookPath: detected.value.salaryWorkbookPath,
      socialSecurityWorkbookPath: processScope === 'salary' ? undefined : detected.value.socialSecurityWorkbookPath,
      taxWorkbookPath: detected.value.taxWorkbookPath,
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      confirmWriteBack: options.confirmWriteBack,
      processScope
    }
  }
}

async function confirmMonthlyPayrollWriteBack(
  preview: MonthlyPayrollWriteBackPreview
): Promise<boolean> {
  const examples = preview.examples.length
    ? `\n\n示例：\n${preview.examples.map((item) => `- ${item}`).join('\n')}`
    : ''
  const manual = preview.manualCount > 0
    ? `\n\n另有 ${preview.manualCount} 项差异需要人工判断，自动回写后系统会继续复核。`
    : ''
  try {
    await ElMessageBox.confirm(
      `发现 ${preview.syncableCount} 项工资表金额差异可回写到一体化工资表，涉及 ${preview.personCount} 人。确认后会按字段当前承载批次写回，并重新核对。${examples}${manual}`,
      '确认回写一体化工资表',
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

async function runPreprocess(): Promise<void> {
  if (isCurrentMonthArchived.value) {
    ElMessage.warning('本月工资已月结，不能再次开始预处理')
    return
  }
  if (!detected.value?.salaryWorkbookPath && !detected.value?.socialSecurityWorkbookPath) {
    ElMessage.warning('请先把本月工资表或社保未申报汇总放入监控文件夹')
    return
  }
  const confirmedMode = await confirmMonthlyPayrollPreprocess()
  if (!confirmedMode) return

  running.value = true
  result.value = null
  generateResult.value = null
  report.value = null
  try {
    const payload = currentPayload()
    if (!payload) return
    const next = await window.salaryApi.runWorkflow('monthly-payroll.preprocess', payload)
    result.value = next
    const writeBack = next.monthlyPayrollWriteBack
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
      if (confirmedResult.ok && confirmedResult.warnings.length === 0) {
        ElMessage.success('回写复核通过，开始生成报表')
        await runGenerate({ skipWorkflow: true })
      } else if (confirmedResult.ok) {
        ElMessage.warning(confirmedResult.warnings[0] ?? '回写后仍有差异，请人工介入')
      } else {
        ElMessage.error(confirmedResult.warnings[0] ?? '月度工资报账预处理失败')
      }
      return
    }
    if (next.ok) {
      ElMessage.success('月度工资报账预处理完成')
      if (next.warnings.length === 0) {
        await runGenerate({ skipWorkflow: true })
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

async function runGenerate(options: { skipWorkflow?: boolean } = {}): Promise<void> {
  if (isCurrentMonthArchived.value) {
    ElMessage.warning('本月工资已月结，不能重新生成报表')
    return
  }
  if (!detected.value?.salaryWorkbookPath && !detected.value?.socialSecurityWorkbookPath) {
    ElMessage.warning('请先把本月工资表或社保未申报汇总放入监控文件夹')
    return
  }
  generating.value = true
  if (!options.skipWorkflow) generateResult.value = null
  report.value = null
  try {
    const payload = currentPayload()
    if (!payload) return
    const next = options.skipWorkflow
      ? null
      : await window.salaryApi.runWorkflow('monthly-payroll.generate', payload)
    const nextReport = await window.salaryApi.generateMonthlyPayrollReportView(payload)
    if (next) generateResult.value = next
    report.value = nextReport
    activeReportSheet.value = firstVisibleSheetName(nextReport.sheets)
    const now = new Date()
    selectedMonth.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    if (!next || next.ok) {
      ElMessage.success(nextReport.message)
      void refreshHistory()
    } else if (next) {
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
    name === '一体化退休'
  )
}

const PRINT_ALL_SHEETS = [
  '自动生成',
  '五险一金',
  '工退遗汇总',
  '报销凭证',
  '一体化退休'
] as const

const currentPrinterName = computed(() =>
  isVoucherPrintSheet(activeSheet.value?.name)
    ? printSettings.value.voucherPrinterName
    : printSettings.value.reportPrinterName
)

function currentPrintRequest(printerName: string, sheetName = activeSheet.value?.name): PrintRequest {
  const pageRanges = parsePrintPageRanges(printPageRangeText.value)
  if (isVoucherPrintSheet(sheetName)) {
    return {
      printerName,
      scaleFactor: 100,
      pageRanges,
      pageSize: { width: 230000, height: 132000 }
    }
  }
  return { printerName, pageRanges }
}

function parsePrintPageRanges(value: string): PrintRequest['pageRanges'] {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const ranges = trimmed.split(/[,，]/).flatMap((part) => {
    const rangeText = part.trim()
    if (!rangeText) return []
    const [fromText, toText = fromText] = rangeText.split(/[-~～]/).map((item) => item.trim())
    const from = Number(fromText)
    const to = Number(toText)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) return []
    const start = Math.min(from, to) - 1
    const end = Math.max(from, to) - 1
    return [{ from: start, to: end }]
  })
  return ranges.length ? ranges : undefined
}

async function printCurrentViewForSheet(printerName: string, sheetName = activeSheet.value?.name): Promise<void> {
  const removeVoucherPrintStyle = isVoucherPrintSheet(sheetName)
    ? installVoucherPrintPageStyle()
    : undefined
  try {
    await window.salaryApi.printCurrentView(currentPrintRequest(printerName, sheetName))
  } finally {
    removeVoucherPrintStyle?.()
  }
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

const scopedSheets = computed(() =>
  scopeReportSheets(report.value?.sheets ?? [], selectedProcessMode.value)
)

const visibleSheets = computed(() =>
  scopedSheets.value.filter((sheet) => !HIDDEN_TAB_SHEETS.has(sheet.name))
)

function scopeReportSheets(
  sheets: MonthlyPayrollReportSheet[],
  mode: ProcessMode
): MonthlyPayrollReportSheet[] {
  if (mode === 'salary-social') return sheets
  return sheets.flatMap((sheet) => {
    if (mode === 'salary') {
      if (['五险一金', '保险导入', '凭证'].includes(sheet.name)) return []
      if (sheet.name === '报销凭证') {
        const rows = sheet.rows.filter((row) => isSalaryVoucher(row))
        return rows.length ? [{ ...sheet, rows }] : []
      }
      return [sheet]
    }

    if (['自动生成', '工退遗汇总', '补发工资', '一体化退休'].includes(sheet.name)) return []
    if (sheet.name === '报销凭证') {
      const rows = sheet.rows.filter((row) => !isSalaryVoucher(row))
      return rows.length ? [{ ...sheet, rows }] : []
    }
    return [sheet]
  })
}

const availableMonths = computed(() => {
  const seen = new Map<string, { year: number; month: number; latestId: number; archived: boolean }>()
  for (const row of history.value) {
    const key = `${row.year}-${String(row.month).padStart(2, '0')}`
    const existing = seen.get(key)
    const archived = Boolean(row.archivedAt)
    if (
      !existing ||
      (archived && !existing.archived) ||
      (archived === existing.archived && row.id > existing.latestId)
    ) {
      seen.set(key, { year: row.year, month: row.month, latestId: row.id, archived })
    }
  }
  return Array.from(seen.entries())
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.key.localeCompare(a.key))
})

const selectedMonth = ref<string>('')

const selectedHistoryRun = computed(() => {
  const key = selectedMonth.value || currentPeriodKey.value
  const target = availableMonths.value.find((item) => item.key === key)
  if (!target) return null
  return history.value.find((item) => item.id === target.latestId) ?? null
})

async function archiveHistoryRun(row: MonthlyPayrollRun | null): Promise<void> {
  if (!row) {
    ElMessage.warning('请先生成或选择一条历史报表')
    return
  }
  try {
    await ElMessageBox.confirm(
      `${row.year}年${row.month}月结后，本月不能再次开始预处理或重新生成报表；工资、社保、个税源文件会移入同一个年月月结目录，文件名会带上年月日，仍可在历史报表中查看。`,
      '工资月结',
      { type: 'warning', confirmButtonText: '确认月结', cancelButtonText: '取消' }
    )
    archivingId.value = row.id
    const archived = await window.salaryApi.archiveMonthlyPayrollRun(row.id)
    ElMessage.success(`已月结 ${archived.files.length} 个文件`)
    await refreshHistory()
    await loadHistoryReport(archived.run, false)
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message)
  } finally {
    archivingId.value = null
  }
}

async function onMonthChange(key: string): Promise<void> {
  if (!key) {
    report.value = null
    return
  }
  const target = availableMonths.value.find((item) => item.key === key)
  if (!target) return
  const row = history.value.find((item) => item.id === target.latestId)
  if (row) await loadHistoryReport(row, false)
}

const availablePrintAllSheets = computed(() =>
  PRINT_ALL_SHEETS.filter((name) => visibleSheets.value.some((sheet) => sheet.name === name))
)

const canPrintAll = computed(() => {
  const shouldPrintSalaryWorkbook = selectedProcessMode.value !== 'social' && Boolean(detected.value?.salaryWorkbookPath)
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
  const salaryPath = selectedProcessMode.value === 'social' ? undefined : detected.value?.salaryWorkbookPath
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
        taxWorkbookPath: detected.value?.taxWorkbookPath,
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
  const salaryWorkbookPath = detected.value?.salaryWorkbookPath || selectedHistoryRun.value?.sourceSalaryPath || ''
  if (!salaryWorkbookPath) return null
  try {
    return await window.salaryApi.getSalaryWorkbookPrintPageSummary({
      salaryWorkbookPath,
      taxWorkbookPath: detected.value?.taxWorkbookPath || selectedHistoryRun.value?.sourceTaxPath || undefined,
      printerName: printSettings.value.reportPrinterName
    })
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '工资表页数统计失败')
    return null
  }
}

function getRetiredHousingPrintPageCount(): number {
  const sheet = report.value?.sheets.find((item) => item.name === '一体化退休')
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

const activeSheet = computed(() =>
  scopedSheets.value.find((sheet) => sheet.name === activeReportSheet.value)
)

watch(
  () => [
    activeSheet.value?.name,
    detected.value?.salaryWorkbookPath,
    selectedHistoryRun.value?.sourceSalaryPath,
    printSettings.value.reportPrinterName
  ] as const,
  () => {
    if (isVoucherPrintSheet(activeSheet.value?.name)) {
      void refreshVoucherPrintTotalPages()
    } else {
      voucherPrintTotalPages.value = null
    }
  }
)

const activePages = computed<MonthlyPayrollReportSheet[]>(() => {
  const sheet = activeSheet.value
  if (!sheet) return []
  if (sheet.name === '自动生成') return splitAutoSheet(sheet)
  if (sheet.name === '一体化退休') return splitRetiredHousingSheet(sheet)
  return [sheet]
})

function splitRetiredHousingSheet(sheet: MonthlyPayrollReportSheet): MonthlyPayrollReportSheet[] {
  if (sheet.rows.length <= 3) return [sheet]
  const titleRow = sheet.rows[0]
  const headerRow = sheet.rows[1]
  const totalRow = sheet.rows[sheet.rows.length - 1]
  const dataRows = sheet.rows.slice(2, -1)
  const perPage = 18
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

function reportSheetClass(name: string): string {
  if (name === '自动生成') return 'sheet-auto'
  if (name === '五险一金') return 'sheet-insurance'
  if (name === '工退遗汇总') return 'sheet-summary'
  if (name === '报销凭证') return 'sheet-voucher'
  if (name === '一体化退休') return 'sheet-retired-housing sheet-integrated-retired'
  if (name === '补发工资') return 'sheet-wide sheet-backpay'
  if (name === '保险导入') return 'sheet-wide sheet-insurance-import'
  return 'sheet-standard'
}

function formatCurrency(value: unknown): string {
  const amount = Number(value || 0)
  return `¥${amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

function voucherUsageLines(row: unknown[]): string[] {
  return String(row[8] ?? '').split('\n').filter(Boolean)
}

function isSalaryVoucher(row: unknown[]): boolean {
  return String(row[0] ?? '').includes('工资')
}

function voucherUsagePrintText(row: unknown[]): string {
  const lines = voucherUsageLines(row)
  if (!isSalaryVoucher(row)) return lines.join('\n')
  return lines
    .map((line) => line.replace(/(-?\d[\d,]*(?:\.\d+)?)$/, ' $1'))
    .join('\n')
}

function voucherAmount(value: unknown): string {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n === 0) return ''
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function voucherUpperAmount(row: unknown[], amountIndex: number): string {
  if (amountIndex === 2) return String(row[9] ?? '')
  if (amountIndex === 3) return String(row[13] ?? '')
  return toChineseRmb(Number(row[amountIndex] || 0))
}

function toChineseRmb(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '零元整'
  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const convert4 = (num: number): string => {
    const q = Math.floor(num / 1000)
    const b = Math.floor((num % 1000) / 100)
    const s = Math.floor((num % 100) / 10)
    const g = num % 10
    let out = ''
    if (q > 0) out += `${digits[q]}仟`
    if (b > 0) out += `${digits[b]}佰`
    else if (q > 0 && (s > 0 || g > 0)) out += '零'
    if (s > 0) out += `${digits[s]}拾`
    else if ((q > 0 || b > 0) && g > 0 && !out.endsWith('零')) out += '零'
    if (g > 0) out += digits[g]
    return out
  }
  const convertInteger = (num: number): string => {
    const yi = Math.floor(num / 100000000)
    const wan = Math.floor((num % 100000000) / 10000)
    const yuan = num % 10000
    let out = ''
    if (yi > 0) {
      out += `${convert4(yi)}亿`
      if (wan === 0 && yuan > 0) out += '零'
      else if (wan > 0 && wan < 1000) out += '零'
    }
    if (wan > 0) {
      out += `${convert4(wan)}万`
      if (yuan > 0 && yuan < 1000) out += '零'
    }
    if (yuan > 0) out += convert4(yuan)
    return out || '零'
  }
  const sign = value < 0 ? '负' : ''
  const rounded = Math.abs(Math.round(value * 100) / 100)
  const integer = Math.floor(rounded)
  const cents = Math.round((rounded - integer) * 100)
  const jiao = Math.floor(cents / 10)
  const fen = cents % 10
  let out = `${sign}${convertInteger(integer)}元`
  if (jiao > 0) out += `${digits[jiao]}角`
  else if (fen > 0) out += '零'
  out += fen > 0 ? `${digits[fen]}分` : '整'
  return out
}

function formatVoucherCell(value: unknown, colIndex: number): string {
  if (value === '' || value === null || value === undefined) return ''
  if (colIndex === 5 || colIndex === 6) {
    const n = Number(value)
    if (!Number.isFinite(n) || n === 0) return ''
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return String(value)
}

type MergeSpan = { colspan: number, rowspan: number }
type MergeEntry = { master?: MergeSpan, covered?: boolean }

function refToRowCol(ref: string): { r: number, c: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)
  if (!match) return { r: 0, c: 0 }
  let col = 0
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { r: parseInt(match[2], 10), c: col }
}

function buildMergeMap(merges: string[] | undefined): Map<string, MergeEntry> {
  const map = new Map<string, MergeEntry>()
  if (!merges) return map
  for (const range of merges) {
    const [a, b] = range.split(':')
    const { r: r1, c: c1 } = refToRowCol(a)
    const { r: r2, c: c2 } = refToRowCol(b)
    map.set(`${r1},${c1}`, { master: { colspan: c2 - c1 + 1, rowspan: r2 - r1 + 1 } })
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        if (r === r1 && c === c1) continue
        map.set(`${r},${c}`, { covered: true })
      }
    }
  }
  return map
}

function mergeFor(map: Map<string, MergeEntry>, r: number, c: number): MergeEntry | undefined {
  return map.get(`${r},${c}`)
}

function colWidthPercents(widths: number[] | undefined, fallbackCount: number): string[] {
  const list = widths && widths.length ? widths : Array(fallbackCount).fill(1)
  const total = list.reduce((s, w) => s + (w || 0), 0) || list.length
  return list.map((w) => `${(((w || 0) / total) * 100).toFixed(3)}%`)
}

function rowHeightStyle(heights: Array<number | null> | undefined, index: number): string {
  const h = heights?.[index]
  return h ? `height:${h}pt` : ''
}

function isCustomStyledSheet(name: string): boolean {
  return (
    name === '自动生成' ||
    name === '五险一金' ||
    name === '工退遗汇总' ||
    name === '一体化退休'
  )
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
        <el-tag v-if="isCurrentMonthArchived" type="info" effect="plain">本月已月结</el-tag>
        <el-button :icon="Refresh" :loading="loading" @click="emit('refresh')">刷新检测</el-button>
        <el-button :icon="FolderOpened" @click="emit('openFolder')">打开监控文件夹</el-button>
        <el-button
          type="primary"
          :icon="VideoPlay"
          :loading="running"
          :disabled="!canRun"
          @click="runPreprocess"
        >
          {{ isCurrentMonthArchived ? '已月结' : '开始预处理' }}
        </el-button>
      </div>
    </header>

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

    <div v-if="availableProcessModes.length" class="process-mode-panel">
      <strong>处理范围</strong>
      <el-radio-group v-model="selectedProcessMode" size="small" @change="markProcessModeTouched">
        <el-radio-button
          v-for="item in availableProcessModes"
          :key="item.value"
          :label="item.value"
        >
          {{ item.label }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <div class="rule-note">
      <strong>自动判断规则</strong>
      <p>选择“只报工资”时不生成凭证；选择“只报社保”时只打印五险一金等社保相关报表，但会读取工资表一起生成工资凭证和社保凭证。未检测到个税文件时不报个税。</p>
    </div>

    <div v-if="result" class="result-panel" :class="{ failed: !result.ok }">
      <div class="result-title">
        <strong>{{ result.workflowName }}</strong>
        <el-tag :type="result.ok ? 'success' : 'danger'" effect="plain">
          {{ result.ok ? '完成' : '失败' }}
        </el-tag>
      </div>
      <div class="result-lines">
        <p v-for="message in result.messages" :key="message">{{ message }}</p>
        <p v-for="warning in result.warnings" :key="warning" class="warning">{{ warning }}</p>
      </div>
      <div class="next-step">
        <strong>下一步</strong>
        <p v-if="result.warnings.length">
          先处理上面的差异或异常；确认一体化在职、一体化其他、一体化退休都准确后，再进入报表生成。
        </p>
        <template v-else>
          <p>
            本月基础核对通过。系统会自动生成报表预览；如果内容和上次一致，会沿用上次输出文件。
          </p>
          <el-button
            type="default"
            :icon="VideoPlay"
            :loading="generating"
            :disabled="isCurrentMonthArchived"
            @click="() => runGenerate()"
          >
            重新生成
          </el-button>
        </template>
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
        <p v-for="message in generateResult.messages" :key="message">{{ message }}</p>
        <p v-for="warning in generateResult.warnings" :key="warning" class="warning">{{ warning }}</p>
      </div>
    </div>

    <section v-if="history.length || historyLoading" class="history-panel">
      <div class="history-head">
        <strong><el-icon><Clock /></el-icon>历史报表</strong>
        <el-button text size="small" :icon="Refresh" @click="() => refreshHistory()">刷新</el-button>
      </div>
      <el-table :data="history" v-loading="historyLoading" size="small" border stripe :max-height="320">
        <el-table-column label="年月" width="110">
          <template #default="{ row }">{{ row.year }}-{{ String(row.month).padStart(2, '0') }}</template>
        </el-table-column>
        <el-table-column label="生成时间" prop="createdAt" min-width="160" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.archivedAt ? 'info' : 'success'" effect="plain">
              {{ row.archivedAt ? '已月结' : '可处理' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="单位" prop="unitFullName" min-width="180" show-overflow-tooltip />
        <el-table-column label="在职" prop="activeCount" width="70" align="right" />
        <el-table-column label="遗补" prop="survivorCount" width="70" align="right" />
        <el-table-column label="退休" prop="retiredHousingCount" width="70" align="right" />
        <el-table-column label="在职实发" width="120" align="right">
          <template #default="{ row }">{{ formatMoney(row.activeActualPay) }}</template>
        </el-table-column>
        <el-table-column label="遗补实发" width="120" align="right">
          <template #default="{ row }">{{ formatMoney(row.survivorActualPay) }}</template>
        </el-table-column>
        <el-table-column label="退休房补实发" width="140" align="right">
          <template #default="{ row }">{{ formatMoney(row.retiredHousingActualPay) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="430" fixed="right" align="right">
          <template #default="{ row }">
            <div class="history-actions">
              <el-button
                v-if="row.voucherImportPath"
                size="small"
                text
                type="primary"
                @click="openHistoryFile(row.voucherImportPath)"
              >凭证</el-button>
              <el-button
                v-if="row.insuranceImportPath"
                size="small"
                text
                type="primary"
                @click="openHistoryFile(row.insuranceImportPath)"
              >保险导入</el-button>
              <el-button
                v-if="row.payrollBackpayPath"
                size="small"
                text
                type="primary"
                @click="openHistoryFile(row.payrollBackpayPath)"
              >补发工资</el-button>
              <el-button
                v-if="row.archiveDir"
                size="small"
                text
                type="primary"
                @click="openHistoryFile(row.archiveDir)"
              >月结</el-button>
              <el-button
                v-else
                size="small"
                text
                type="warning"
                :loading="archivingId === row.id"
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
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="report || availableMonths.length > 0" class="report-view">
      <div class="report-toolbar">
        <div>
          <div class="report-title-row">
            <strong>报表视图</strong>
            <el-select
              v-model="selectedMonth"
              size="small"
              placeholder="选择月份"
              style="width: 160px"
              clearable
              @change="onMonthChange"
            >
              <el-option
                v-for="item in availableMonths"
                :key="item.key"
                :label="`${item.year}-${String(item.month).padStart(2, '0')}`"
                :value="item.key"
              />
            </el-select>
          </div>
          <p v-if="report">{{ report.message }}</p>
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
              :disabled="!selectedHistoryRun || Boolean(selectedHistoryRun.archivedAt)"
              @click="archiveHistoryRun(selectedHistoryRun)"
            >
              {{ selectedHistoryRun?.archivedAt ? '已月结' : '月结本月' }}
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
                {{ formatVoucherCell(cell, cIdx) }}
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
            v-if="voucherPrintTotalPages !== null && !voucherPrintTotalPagesLoading"
            class="voucher-item voucher-total-pages"
          >
            {{ voucherPrintTotalPages }}
          </span>
          <span class="voucher-item voucher-usage-print">{{ voucherUsagePrintText(row) }}</span>
        </article>
      </div>

      <template v-else-if="activeSheet">
        <div
          v-for="(page, pageIdx) in activePages"
          :key="pageIdx"
          class="print-page"
          :class="[reportSheetClass(activeSheet.name), { 'custom-styled': isCustomStyledSheet(activeSheet.name) }]"
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
.rule-note,
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

.process-mode-panel strong,
.rule-note strong {
  color: var(--text);
  font-size: 14px;
}

.rule-note p {
  margin: 8px 0 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}

.result-panel {
  border-color: var(--success);
  background: var(--success-soft);
}

.result-panel.failed {
  border-color: var(--danger);
  background: var(--danger-soft);
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

.history-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  white-space: nowrap;
}

.history-actions .el-button {
  margin-left: 0;
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

.print-page-range {
  display: grid;
  gap: 4px;
  width: 100%;
}

.printer-selects label,
.voucher-offset-controls label,
.print-page-range {
  display: grid;
  gap: 4px;
}

.printer-selects span,
.voucher-offset-controls span,
.print-page-range span {
  color: var(--text-3);
  font-size: 12px;
}

.printer-selects .el-select,
.voucher-offset-controls .el-input-number,
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
  width: 200mm;
  margin: 0 auto;
}

.sheet-auto .report-table {
  font-size: 10pt;
}

.sheet-auto .report-table td {
  padding: 1px 4px;
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
  font-family: SimSun, 'Songti SC', serif;
  font-size: 15pt;
  page-break-after: always;
  --voucher-offset-x: 0mm;
  --voucher-offset-y: 0mm;
}

.voucher-item {
  position: absolute;
  display: block;
  color: #000;
  font-family: SimSun, 'Songti SC', serif;
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
  left: 42.33mm;
  top: 35.22mm;
  width: 37.04mm;
}

.voucher-year {
  left: 119.80mm;
  top: 35.22mm;
  width: 9.26mm;
}

.voucher-month {
  left: 137.53mm;
  top: 35.22mm;
  width: 9.26mm;
}

.voucher-day {
  left: 150.23mm;
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
  font-family: FangSong, STFangsong, SimSun, serif;
  font-size: 10.5pt;
  line-height: 1.08;
  white-space: pre-line;
  overflow: visible;
}

.voucher-total-pages {
  left: 200.34mm;
  top: 62.35mm;
  width: 45mm;
  font-size: 10.5pt;
  font-family: FangSong, STFangsong, SimSun, serif;
  line-height: 1;
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
  .monthly-grid,
  .process-mode-panel,
  .rule-note,
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
    margin: 0;
    page-break-after: always;
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
  }

  .report-table th,
  .report-table td {
    color: #000;
    border-color: #000;
  }
}
</style>
