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
  MonthlyPayrollWriteBackPreview,
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
const history = ref<MonthlyPayrollRun[]>([])
const historyLoading = ref(false)
const archivingId = ref<number | null>(null)
const printers = ref<PrinterSummary[]>([])
const printSettings = ref<MonthlyPayrollPrintSettings>({
  reportPrinterName: '',
  voucherPrinterName: ''
})
const printing = ref(false)

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
    voucherPrinterName: settings.voucherPrinterName || ''
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
const canRun = computed(() => Boolean(detected.value?.salaryWorkbookPath) && !isCurrentMonthArchived.value)

const modeText = computed(() => {
  switch (detected.value?.mode) {
    case 'salary-social-tax':
      return '工资 + 社保 + 个税'
    case 'salary-social':
      return '工资 + 社保'
    case 'salary-tax':
      return '工资 + 个税'
    case 'salary-only':
      return '本次只报工资'
    default:
      return '等待工资表'
  }
})

const fileRows = computed(() => [
  {
    label: '本月工资表',
    required: true,
    name: detected.value?.salaryWorkbookName,
    path: detected.value?.salaryWorkbookPath,
    hint: '工资表是必需文件，例如 512扎下小学--2026年5月份工资表.xlsx'
  },
  {
    label: '社保未申报汇总',
    required: true,
    name: detected.value?.socialSecurityWorkbookName,
    path: detected.value?.socialSecurityWorkbookPath,
    hint: '社保每月都要处理；未检测到时本次只报工资，社保可补齐后再处理'
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
  const hasSocial = Boolean(files?.socialSecurityWorkbookPath)
  const hasTax = Boolean(files?.taxWorkbookPath)
  const mode = hasSocial
    ? hasTax
      ? '本次将处理：工资报账、社保报账、个税扣款。'
      : '本次将处理：工资报账、社保报账；未检测到个税文件，本次不处理个税。'
    : hasTax
      ? '本次将处理：工资报账、个税扣款；未检测到社保文件，本次不生成社保报账。'
      : '本次将处理：工资报账；未检测到社保和个税文件，本次不生成社保报账，也不处理个税。'
  const socialLine = hasSocial
    ? `社保文件：已检测到「${files?.socialSecurityWorkbookName}」。`
    : '社保文件：未检测到。社保属于每月必办事项，请确认本次先只报工资，后续补齐社保文件后再单独处理社保。'
  const taxLine = hasTax
    ? `个税文件：已检测到「${files?.taxWorkbookName}」。`
    : '个税文件：未检测到。个税按单位实际情况处理；没有个税或由其他渠道代收时，可以不放个税文件。'

  try {
    await ElMessageBox.confirm(
      `${mode}\n\n工资表：${files?.salaryWorkbookName ?? '已检测'}。\n${socialLine}\n${taxLine}`,
      '确认本月工资处理方式',
      {
        type: hasSocial ? 'info' : 'warning',
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
  if (!detected.value?.salaryWorkbookPath) return null
  const now = new Date()
  return {
    monthlyPayroll: {
      salaryWorkbookPath: detected.value.salaryWorkbookPath,
      socialSecurityWorkbookPath: detected.value.socialSecurityWorkbookPath,
      taxWorkbookPath: detected.value.taxWorkbookPath,
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      confirmWriteBack: options.confirmWriteBack
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
  if (!detected.value?.salaryWorkbookPath) {
    ElMessage.warning('请先把本月工资表放入监控文件夹')
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
  if (!detected.value?.salaryWorkbookPath) {
    ElMessage.warning('请先把本月工资表放入监控文件夹')
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

async function printCurrentReport(): Promise<void> {
  if (!activeSheet.value) return
  const printerName = currentPrinterName.value
  if (!printerName) {
    ElMessage.warning(isVoucherPrintSheet(activeSheet.value.name) ? '请先选择报销凭证打印机' : '请先选择报表打印机')
    return
  }
  printing.value = true
  try {
    await window.salaryApi.printCurrentView({ printerName })
    ElMessage.success('已发送到打印机')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打印失败')
  } finally {
    printing.value = false
  }
}

const HIDDEN_TAB_SHEETS = new Set<string>()

const visibleSheets = computed(() =>
  report.value?.sheets.filter((sheet) => !HIDDEN_TAB_SHEETS.has(sheet.name)) ?? []
)

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
  PRINT_ALL_SHEETS.filter((name) => report.value?.sheets.some((sheet) => sheet.name === name))
)

const canPrintAll = computed(() => {
  const hasSalary = Boolean(detected.value?.salaryWorkbookPath)
  if (availablePrintAllSheets.value.length === 0 && !hasSalary) return false
  const needsReport =
    hasSalary || availablePrintAllSheets.value.some((name) => !isVoucherPrintSheet(name))
  const needsVoucher = availablePrintAllSheets.value.some((name) => isVoucherPrintSheet(name))
  if (needsReport && !printSettings.value.reportPrinterName) return false
  if (needsVoucher && !printSettings.value.voucherPrinterName) return false
  return true
})

async function printAllReports(): Promise<void> {
  const targets = availablePrintAllSheets.value
  const salaryPath = detected.value?.salaryWorkbookPath
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
      await window.salaryApi.printCurrentView({ printerName })
      count += 1
    }
    ElMessage.success(`已发送 ${count} 项到打印机`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打印失败')
  } finally {
    printing.value = false
  }
}

const printButtonText = computed(() =>
  activeSheet.value?.name === '报销凭证' ? '打印报销凭证' : '打印当前视图'
)

const currentPrinterLabel = computed(() =>
  isVoucherPrintSheet(activeSheet.value?.name) ? '票据打印机' : '报表打印机'
)

const activeSheet = computed(() =>
  report.value?.sheets.find((sheet) => sheet.name === activeReportSheet.value)
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

    <div class="rule-note">
      <strong>自动判断规则</strong>
      <p>工资表和社保属于每月必办；监控文件夹只有工资表时，可先只报工资，社保文件补齐后再处理社保。个税按单位实际情况处理，未检测到个税文件时跳过个税扣款和补发工资。</p>
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
        <el-table-column label="应发" width="120" align="right">
          <template #default="{ row }">{{ formatMoney(row.salaryTotal) }}</template>
        </el-table-column>
        <el-table-column label="代扣" width="110" align="right">
          <template #default="{ row }">{{ formatMoney(row.withholdingTotal) }}</template>
        </el-table-column>
        <el-table-column label="个税" width="100" align="right">
          <template #default="{ row }">{{ formatMoney(row.taxTotal) }}</template>
        </el-table-column>
        <el-table-column label="实发" width="120" align="right">
          <template #default="{ row }">{{ formatMoney(row.actualPay) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="360" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              type="primary"
              @click="viewHistoryReport(row)"
            >查看</el-button>
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
              v-if="!row.archivedAt"
              size="small"
              text
              type="danger"
              @click="deleteHistoryRun(row)"
            >删除</el-button>
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
        >
          <span class="voucher-item voucher-label pay-method-label">支付方式</span>
          <span class="voucher-item voucher-label pay-amount-label">支付金额</span>
          <span class="voucher-item voucher-label pay-order-label">支付令</span>
          <span class="voucher-item voucher-label transfer-label">转账支票</span>
          <span class="voucher-item pay-order-top">{{ row[5] }}</span>
          <span class="voucher-item pay-amount-top">{{ voucherAmount(row[4]) }}</span>
          <span class="voucher-item transfer-top">{{ row[6] }}</span>

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
  max-width: 1200px;
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

.rule-note,
.result-panel {
  max-width: 1200px;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

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
  max-width: 1200px;
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.history-panel {
  max-width: 1200px;
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

.printer-selects label {
  display: grid;
  gap: 4px;
}

.printer-selects span {
  color: var(--text-3);
  font-size: 12px;
}

.printer-selects .el-select {
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

/* 工退遗汇总 — rows 1-2 (title + unit) borderless; rows 3-6 (three-tier header + data row) borders;
   row 7 (summary narrative "本月应发…实发…") borderless. */
.sheet-summary .report-table tr:nth-child(-n+2) td,
.sheet-summary .report-table tr:nth-child(7) td {
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

/* 工退遗汇总 — wide cross-tab, 27 narrow columns, three-tier header */
.sheet-summary {
  padding-top: 14mm;
}

.sheet-summary .print-area {
  width: 200mm;
  margin: 0 auto;
}

.sheet-summary .report-table {
  table-layout: fixed;
  font-size: 7pt;
}

.sheet-summary .report-table td {
  padding: 1px 1px;
  text-align: center;
  word-break: break-all;
  line-height: 1.05;
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

.sheet-summary .report-table tr:nth-child(7) td {
  font-size: 9pt;
  word-break: keep-all;
  white-space: nowrap;
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
  overflow: hidden;
  background: #fff;
  color: #000;
  font-family: SimSun, 'Songti SC', serif;
  font-size: 15pt;
  page-break-after: always;
}

.voucher-item {
  position: absolute;
  display: block;
  color: #000;
  font-family: SimSun, 'Songti SC', serif;
  font-size: 11pt;
  line-height: 1.1;
  white-space: nowrap;
  overflow: visible;
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
  font-size: 10pt;
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
  top: 40.22mm;
  width: 37.04mm;
}

.voucher-year {
  left: 109.80mm;
  top: 40.22mm;
  width: 9.26mm;
}

.voucher-month {
  left: 127.53mm;
  top: 40.22mm;
  width: 9.26mm;
}

.voucher-day {
  left: 140.23mm;
  top: 40.22mm;
  width: 9.26mm;
}

.amount-upper {
  left: 66.15mm;
  width: 60.85mm;
}

.amount-number {
  left: 129.65mm;
  width: 26.46mm;
}

.reimburse-upper,
.reimburse-number {
  top: 55.83mm;
}

.unpaid-upper,
.unpaid-number {
  top: 80.96mm;
}

.actual-upper,
.actual-number {
  top: 88.90mm;
}

.order-upper,
.order-number {
  top: 97.90mm;
}

.transfer-upper,
.transfer-number {
  top: 105.57mm;
}

.voucher-usage-print {
  left: 160.34mm;
  top: 65.35mm;
  width: 64.03mm;
  height: 59.53mm;
  font-family: FangSong, STFangsong, SimSun, serif;
  font-size: 11pt;
  line-height: 1.08;
  white-space: pre-line;
}

.salary-voucher .amount-upper {
  width: 62mm;
  font-size: 9.5pt;
  line-height: 1;
}

.salary-voucher .amount-number {
  font-size: 10.5pt;
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
