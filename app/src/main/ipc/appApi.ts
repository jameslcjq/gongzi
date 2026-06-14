import { app, ipcMain as electronIpcMain, shell, type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { assertTrustedIpcSender } from './ipcGuard'
import { getDatabase, getDatabasePath, run } from '../db/connection'
import { readWorksheetMetadata } from '../db/metadata'
import {
  createBackup,
  createFullBackup,
  listBackups,
  listFullBackups,
  restoreBackup,
  restoreFullBackup
} from '../services/backup'
import { applyConsistencyAuditUpdates, runConsistencyAudit } from '../services/consistencyAudit'
import {
  chooseExcelFile,
  commitExcelImport,
  listImportBatches,
  previewExcelFile,
  rollbackImportBatch
} from '../services/excelImport'
import {
  clearImportWatcherLogs,
  chooseImportWatcherFolder,
  getImportWatcherStatus,
  openImportWatcherFolder,
  startExcelImportWatcher
} from '../services/excelImportWatcher'
import { getExchangeStatus } from '../services/exchange/exchangeStatus'
import {
  chooseExchangePackageFile,
  previewExchangePackage,
  previewExchangeReceipt
} from '../services/exchange/exchangePackagePreview'
import {
  buildMonthlyPayrollExchangePackage,
  buildMonthlyPayrollExchangeReceipt,
  importMonthlyPayrollExchangePackage,
  importMonthlyPayrollExchangeReceipt,
  syncExchangeMedia
} from '../services/exchange/exchangePackageService'
import {
  deletePivotConfig,
  detectIdCardField,
  getPivotConfig,
  listPivotConfigs,
  runPivot,
  savePivotConfig,
  type PivotConfigSummary
} from '../services/pivot'
import { exportPivotToExcel } from '../services/pivotExport'
import {
  listLookupFailures,
  type LookupFailureQuery
} from '../services/budget/archiveQueries'
import { listWorkflows, runWorkflow } from '../services/workflowRegistry'
import {
  archiveMonthlyPayrollRun,
  assertMonthlyPayrollRunPushable,
  cancelMonthlyPayrollMonthClose,
  deleteMonthlyPayrollRun,
  generateMonthlyPayrollReportView,
  getMonthlyPayrollRunReport,
  inspectMonthlyPayrollSourcePeriods,
  listMonthlyPayrollRuns,
  updateMonthlyPayrollPushStatus
} from '../services/monthly-payroll/monthlyPayroll'
import {
  getSalaryWorkbookPrintPageSummary,
  printSalaryWorkbookViaExcel
} from '../services/monthly-payroll/printSalaryViaExcel'
import {
  loadIntegratedActiveAggregates,
  loadIntegratedSimpleAggregates,
  loadTraffic002Total
} from '../services/monthly-payroll/monthlyPayrollDataLoaders'
import { computeSalaryQuotaMatchLocalSummary } from '../services/monthly-payroll/quotaMatchLocalSummary'
import { assertInsideBusinessRoots, payrollInstance } from '../config/paths'
import type { PayrollInstanceSummary } from '../../shared/payrollInstance'
import {
  applyAnnualAdjustment,
  applySocialInsuranceBase,
  chooseAnnualAdjustmentFiles,
  exportSocialInsuranceBaseWorkbook,
  generatePersonalTaxImportWorkbook,
  previewAnnualAdjustment,
  previewSocialInsuranceBase
} from '../services/annualAdjustment'
import {
  generatePerformancePayroll,
  generatePerformancePayrollFromHistory,
  generatePerformancePayrollFromLocal
} from '../services/performancePayroll'
import { getUnitSettingsLockState, readUnitSettings, writeUnitSettings } from '../services/unitSettings'
import { resolveSchoolUnitSettings } from '../services/schoolLookup'
import { appendPushLog, ensurePushLogDir } from '../services/pushLog'
import { appendMainLog } from '../services/mainLog'
import {
  readMonthlyPayrollPrintSettings,
  writeMonthlyPayrollPrintSettings
} from '../services/printSettings'
import {
  readMonthlyPayrollSettings,
  writeMonthlyPayrollSettings
} from '../services/monthly-payroll/monthlyPayrollSettings'
import {
  listMonthlyPayrollSourceVersions,
  setMonthlyPayrollSourceVersionCurrent
} from '../services/monthly-payroll/monthlyPayrollSources'
import {
  listRecycleBinBatches,
  listRecycleBinRecords,
  restoreRecycleBinBatch
} from '../services/operationLog'
import { getCachedLicenseStatus } from '../services/licenseService'
import {
  collectIntegrationLoginKey,
  getAutomationHelperStatus,
  openAutomationDebugFolder,
  switchIntegrationLoginKey
} from '../services/automation/automationHelper'
import { getPersonnelStatusViews } from '../services/personnelStatus'
import { exportWorksheetToExcel } from '../services/worksheetExport'
import { saveWorksheetFields } from '../services/worksheetFields'
import {
  applyHrMasterSyncFromIntegrated,
  previewHrMasterSyncFromIntegrated
} from '../services/hrMasterSync'
import {
  applyBudgetActiveMasterSync,
  previewBudgetActiveMasterSync
} from '../services/budgetActiveHrSync'
import { readPersonnelExpensePlanPrefill } from '../services/budget/personnelExpensePlanPrefill'
import { importBudgetXls, previewBudgetXls } from '../services/budgetExcelImport'
import {
  applyTeacherDetailMasterSync,
  previewTeacherDetailMasterSync
} from '../services/teacherDetailHrSync'
import {
  applyTownshipMasterSync,
  fillTownshipIdCardsByHrName,
  previewTownshipMasterSync
} from '../services/townshipHrSync'
import {
  drillStatReport,
  exportStatReport,
  runStatReport,
  STAT_REPORT_DEFS
} from '../services/statReports'
import {
  clearWorksheet,
  createRecord,
  deleteRecord,
  deleteRecords,
  listPersonnelChildRecords,
  listRecords,
  updateRecord,
  wipeAllWorksheetData,
  type PersonnelChildRecords
} from '../services/worksheetRecords'
import type {
  AppSummary,
  BackupSummary,
  ConsistencyAuditApplyDirection,
  ConsistencyAuditApplyResult,
  ConsistencyAuditIssue,
  ConsistencyAuditResult,
  ImportBatchSummary,
  ImportPreview,
  ImportWatcherStatus,
  HrMasterSyncApplyResult,
  HrMasterSyncPreview,
  MasterSyncSelectionItem,
  StatReportDef,
  StatReportDrillResult,
  StatReportFilterClause,
  StatReportResult,
  BudgetActiveMasterSyncApplyResult,
  BudgetActiveMasterSyncPreview,
  TeacherDetailMasterSyncApplyResult,
  TeacherDetailMasterSyncPreview,
  TownshipIdCardFillResult,
  TownshipMasterSyncApplyResult,
  TownshipMasterSyncPreview,
  PivotConfig,
  PivotResult,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowRunPayload,
  MonthlyPayrollReportResult,
  MonthlyPayrollArchiveResult,
  WorksheetMutationResult,
  WorksheetMeta,
  WorksheetRecordValue,
  WorksheetRecordsQuery,
  WorksheetRecordsResult,
  WorksheetField,
  LookupFailureEntry,
  MonthlyPayrollRun,
  MonthlyPayrollPushGuardResult,
  MonthlyPayrollPushStatus,
  MonthlyPayrollPushTarget,
  MonthlyPayrollSourceVersion,
  MonthlyPayrollSalaryPrintPageSummary,
  MonthlyPayrollPrintSettings,
  MonthlyPayrollSettings,
  RecycleBinBatch,
  RecycleBinRecord,
  RecycleBinRestoreResult,
  PrintRequest,
  PrinterSummary,
  UnitSettings,
  AnnualAdjustmentApplyInput,
  AnnualAdjustmentApplyResult,
  AnnualAdjustmentChooseFilesRequest,
  AnnualAdjustmentFilePick,
  AnnualAdjustmentPreview,
  AnnualAdjustmentPreviewInput,
  SocialBasePreviewInput,
  SocialBasePreview,
  SocialBaseApplyInput,
  SocialBaseApplyResult,
  ExchangeStatus,
  FullBackupSummary,
  ExchangePackagePreview,
  ExchangePackageBuildResult,
  ExchangePackageImportResult,
  ExchangeReceiptBuildResult,
  ExchangeReceiptImportResult,
  AutomationCaptureResult,
  AutomationHelperStatus,
  PerformancePayrollGenerateInput,
  PerformancePayrollGenerateResult,
  PerformancePayrollHistoryGenerateInput,
  PerformancePayrollLocalGenerateInput,
  PersonalTaxImportGenerateInput,
  PersonalTaxImportGenerateResult,
  PersonnelExpensePlanPrefillResult,
  LocalFileBase64,
  SalaryQuotaMatchLocalSummary,
  SocialInsuranceBaseExportInput,
  SocialInsuranceBaseExportResult
} from '../../shared/types'

const LICENSE_FREE_CHANNELS = new Set([
  // 授权门禁页仍需要读取基础状态、单位设置和备份列表；业务写入类 IPC 继续走授权拦截。
  'app:get-version',
  'app:get-instance',
  'app:get-summary',
  'app:list-workflows',
  'import-watcher:get-status',
  'import-watcher:choose-folder',
  'import-watcher:open-folder',
  'import-watcher:clear-logs',
  'integration:capture-recording-screenshot',
  'integration:drain-all-frames',
  'integration:exec-in-all-frames',
  'integration:native-recorder-start',
  'integration:native-recorder-drain',
  'integration:native-recorder-stop',
  'integration:save-recording',
  'portal-recorder:save',
  'salary-quota-match:local-summary',
  'app-log:append',
  'unit-settings:get',
  'unit-settings:lock-state',
  'unit-settings:set',
  'unit-settings:resolve-school',
  'backup:list',
  'backup:list-full',
  'monthly-payroll:list-runs'
])

async function assertLicenseForChannel(channel: string): Promise<void> {
  if (LICENSE_FREE_CHANNELS.has(channel)) return
  const status = await getCachedLicenseStatus()
  if (status.valid) return
  throw new Error(status.message || '授权无效，请先完成授权校验')
}

export function createLicensedIpcMain(): Pick<IpcMain, 'handle'> {
  return {
    handle(channel, listener) {
      electronIpcMain.handle(channel, async (event, ...args) => {
        assertTrustedIpcSender(event)
        await assertLicenseForChannel(channel)
        return listener(event, ...args)
      })
    }
  }
}

function sanitizeRecordingPathSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'recording'
}

type NativeRecorderEvent = {
  t: number
  kind: string
  webContentsId: number
  url?: string
  title?: string
  [key: string]: unknown
}

type NativeRecorderSession = {
  sessionId: string
  startedAt: number
  events: NativeRecorderEvent[]
  detachByWebContentsId: Map<number, () => void>
}

const nativeRecorderSessions = new Map<string, NativeRecorderSession>()

function nativeRecorderEventBase(session: NativeRecorderSession, wc: WebContents): NativeRecorderEvent {
  let url = ''
  let title = ''
  try {
    url = wc.getURL()
  } catch {}
  try {
    title = wc.getTitle()
  } catch {}
  return {
    t: Date.now() - session.startedAt,
    kind: 'native',
    webContentsId: wc.id,
    url,
    title
  }
}

function pushNativeRecorderEvent(
  session: NativeRecorderSession,
  wc: WebContents,
  kind: string,
  data: Record<string, unknown> = {}
): void {
  if (wc.isDestroyed()) return
  session.events.push({
    ...nativeRecorderEventBase(session, wc),
    kind,
    ...data
  })
  if (session.events.length > 12000) {
    session.events = session.events.slice(-6000)
  }
}

function sanitizeNativeInput(input: Record<string, unknown>): Record<string, unknown> {
  const key = typeof input.key === 'string' ? input.key : undefined
  return {
    type: input.type,
    key: key && key.length === 1 ? '<char>' : key,
    code: input.code,
    button: input.button,
    x: input.x,
    y: input.y,
    globalX: input.globalX,
    globalY: input.globalY,
    modifiers: input.modifiers
  }
}

function attachNativeRecorderToWebContents(
  session: NativeRecorderSession,
  wc: WebContents
): boolean {
  if (wc.isDestroyed() || session.detachByWebContentsId.has(wc.id)) return false

  const inputListener = (_event: unknown, input: Record<string, unknown>): void => {
    pushNativeRecorderEvent(session, wc, 'native-input', sanitizeNativeInput(input))
  }
  const beforeInputListener = (_event: unknown, input: Record<string, unknown>): void => {
    const type = String(input.type || '')
    if (!/^key/i.test(type)) return
    pushNativeRecorderEvent(session, wc, 'native-before-input', sanitizeNativeInput(input))
  }
  const startNavigationListener = (details: Record<string, unknown>): void => {
    pushNativeRecorderEvent(session, wc, 'native-navigation-start', {
      navigationUrl: details.url,
      isMainFrame: details.isMainFrame,
      frameProcessId: details.frameProcessId,
      frameRoutingId: details.frameRoutingId
    })
  }
  const navigateListener = (_event: unknown, url: string): void => {
    pushNativeRecorderEvent(session, wc, 'native-navigation', { navigationUrl: url })
  }
  const navigateInPageListener = (_event: unknown, url: string, isMainFrame: boolean): void => {
    pushNativeRecorderEvent(session, wc, 'native-navigation-in-page', { navigationUrl: url, isMainFrame })
  }
  const frameNavigateListener = (
    _event: unknown,
    url: string,
    httpResponseCode: number,
    httpStatusText: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ): void => {
    pushNativeRecorderEvent(session, wc, 'native-frame-navigation', {
      navigationUrl: url,
      httpResponseCode,
      httpStatusText,
      isMainFrame,
      frameProcessId,
      frameRoutingId
    })
  }
  const frameLoadListener = (
    _event: unknown,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ): void => {
    pushNativeRecorderEvent(session, wc, 'native-frame-load', {
      isMainFrame,
      frameProcessId,
      frameRoutingId
    })
  }
  const titleListener = (_event: unknown, title: string): void => {
    pushNativeRecorderEvent(session, wc, 'native-title', { title })
  }
  const destroyedListener = (): void => {
    pushNativeRecorderEvent(session, wc, 'native-destroyed')
    session.detachByWebContentsId.delete(wc.id)
  }

  const wcAny = wc as WebContents & {
    on(event: string, listener: (...args: any[]) => void): WebContents
    off(event: string, listener: (...args: any[]) => void): WebContents
  }
  wcAny.on('input-event', inputListener)
  wcAny.on('before-input-event', beforeInputListener)
  wcAny.on('did-start-navigation', startNavigationListener)
  wcAny.on('did-navigate', navigateListener)
  wcAny.on('did-navigate-in-page', navigateInPageListener)
  wcAny.on('did-frame-navigate', frameNavigateListener)
  wcAny.on('did-frame-finish-load', frameLoadListener)
  wcAny.on('page-title-updated', titleListener)
  wcAny.on('destroyed', destroyedListener)

  session.detachByWebContentsId.set(wc.id, () => {
    wcAny.off('input-event', inputListener)
    wcAny.off('before-input-event', beforeInputListener)
    wcAny.off('did-start-navigation', startNavigationListener)
    wcAny.off('did-navigate', navigateListener)
    wcAny.off('did-navigate-in-page', navigateInPageListener)
    wcAny.off('did-frame-navigate', frameNavigateListener)
    wcAny.off('did-frame-finish-load', frameLoadListener)
    wcAny.off('page-title-updated', titleListener)
    wcAny.off('destroyed', destroyedListener)
  })

  pushNativeRecorderEvent(session, wc, 'native-attached')
  return true
}

function drainNativeRecorderSession(sessionId: string): NativeRecorderEvent[] {
  const session = nativeRecorderSessions.get(sessionId)
  if (!session) return []
  const events = session.events
  session.events = []
  return events
}

function stopNativeRecorderSession(sessionId: string): NativeRecorderEvent[] {
  const session = nativeRecorderSessions.get(sessionId)
  if (!session) return []
  const events = drainNativeRecorderSession(sessionId)
  for (const detach of session.detachByWebContentsId.values()) {
    try {
      detach()
    } catch {}
  }
  nativeRecorderSessions.delete(sessionId)
  return events
}

// 人员经费录入：只保留"单位设置"里配置的那个单位的核对表行（系统有多个单位时，避免录到别的单位）。
// 预算代码(=单位导入编码)优先匹配，其次按单位名称相互包含匹配；匹配不上时保持原样，避免误清空。
async function filterPersonnelExpensePrefillToUnit(
  prefill: PersonnelExpensePlanPrefillResult
): Promise<PersonnelExpensePlanPrefillResult> {
  if (!prefill.ok || prefill.rows.length <= 1) return prefill
  let unit: UnitSettings
  try {
    unit = await readUnitSettings()
  } catch {
    return prefill
  }
  const codeKey = (value: string): string => String(value || '').replace(/\s+/g, '').trim()
  const nameKey = (value: string): string =>
    String(value || '')
      .replace(/\s+/g, '')
      .replace(/^[0-9]{3,}/, '')
      .trim()
  const wantCode = codeKey(unit.unitImportCode)
  const wantName = nameKey(unit.unitFullName)
  if (!wantCode && !wantName) return prefill
  const matched = prefill.rows.filter((row) => {
    const rowCode = codeKey(row.budgetCode || '')
    const rowName = nameKey(row.unitName || '')
    if (wantCode && rowCode && rowCode === wantCode) return true
    if (wantName && rowName && (rowName.includes(wantName) || wantName.includes(rowName))) return true
    return false
  })
  if (matched.length === 0) return prefill
  return {
    ...prefill,
    rows: matched,
    message: (prefill.message ? prefill.message + '；' : '') + '已按单位设置过滤为 ' + matched.length + ' 个单位'
  }
}

export function registerAppIpc(): void {
  const ipcMain = createLicensedIpcMain()

  ipcMain.handle('app:get-version', (): string => app.getVersion())
  ipcMain.handle('app:get-instance', (): PayrollInstanceSummary => payrollInstance)

  ipcMain.handle('app:get-summary', async (): Promise<AppSummary> => {
    await getDatabase()
    const worksheets = readWorksheetMetadata()

    const visibleWorksheets = worksheets.map((item) => {
      const views = getVisibleViews(item)
      return {
        name: item.name,
        worksheetId: item.worksheetId,
        fieldCount: item.fields.length,
        viewCount: views.length,
        fields: item.fields,
        views
      }
    })

    return {
      tableCount: worksheets.length,
      fieldCount: worksheets.reduce((total, item) => total + item.fields.length, 0),
      databasePath: getDatabasePath(),
      worksheets: visibleWorksheets
    }
  })

  ipcMain.handle('app:list-workflows', (): WorkflowDefinition[] => listWorkflows())

  ipcMain.handle('automation:helper-status', (): AutomationHelperStatus => {
    return getAutomationHelperStatus()
  })

  ipcMain.handle('automation:collect-login-key', (): Promise<AutomationCaptureResult> => {
    return collectIntegrationLoginKey()
  })

  ipcMain.handle('automation:switch-login-key', (_event, input: { keyText?: string; index?: number; pin?: string; confirm?: boolean }) => {
    return switchIntegrationLoginKey(input ?? {})
  })

  ipcMain.handle('automation:open-debug-folder', (): Promise<string> => {
    return openAutomationDebugFolder()
  })

  ipcMain.handle('consistency-audit:run', (): Promise<ConsistencyAuditResult> => {
    return runConsistencyAudit()
  })

  ipcMain.handle(
    'consistency-audit:apply',
    (
      _event,
      direction: ConsistencyAuditApplyDirection,
      issues: ConsistencyAuditIssue[]
    ): Promise<ConsistencyAuditApplyResult> => {
      return applyConsistencyAuditUpdates(direction, issues)
    }
  )

  ipcMain.handle('import-watcher:get-status', (): Promise<ImportWatcherStatus> => {
    return getImportWatcherStatus()
  })

  ipcMain.handle('import-watcher:choose-folder', (): Promise<ImportWatcherStatus> => {
    return chooseImportWatcherFolder()
  })

  ipcMain.handle('import-watcher:open-folder', (): Promise<ImportWatcherStatus> => {
    return openImportWatcherFolder()
  })

  ipcMain.handle('import-watcher:clear-logs', (): Promise<ImportWatcherStatus> => {
    return clearImportWatcherLogs()
  })

  ipcMain.handle('exchange:get-status', (): ExchangeStatus => {
    return getExchangeStatus()
  })

  ipcMain.handle('exchange:scan-media', (): Promise<ExchangeStatus> => {
    return syncExchangeMedia()
  })

  ipcMain.handle('exchange:open-inbox', async (): Promise<string> => {
    return shell.openPath(getExchangeStatus().paths.inbox)
  })

  ipcMain.handle('exchange:open-outbox', async (): Promise<string> => {
    return shell.openPath(getExchangeStatus().paths.outbox)
  })

  ipcMain.handle('exchange:choose-package', (): Promise<{ filePath: string; fileName: string } | null> => {
    return chooseExchangePackageFile()
  })

  ipcMain.handle('exchange:preview-package', (_event, filePath: string): Promise<ExchangePackagePreview> => {
    return previewExchangePackage(filePath)
  })

  ipcMain.handle('exchange:preview-receipt', (_event, filePath: string): Promise<ExchangePackagePreview> => {
    return previewExchangeReceipt(filePath)
  })

  ipcMain.handle('exchange:build-monthly-package', (_event, runId: number): Promise<ExchangePackageBuildResult> => {
    return buildMonthlyPayrollExchangePackage(runId)
  })

  ipcMain.handle('exchange:import-monthly-package', (_event, filePath: string): Promise<ExchangePackageImportResult> => {
    return importMonthlyPayrollExchangePackage(filePath)
  })

  ipcMain.handle('exchange:build-receipt', (_event, runId: number): Promise<ExchangeReceiptBuildResult> => {
    return buildMonthlyPayrollExchangeReceipt(runId)
  })

  ipcMain.handle('exchange:import-receipt', (_event, filePath: string): Promise<ExchangeReceiptImportResult> => {
    return importMonthlyPayrollExchangeReceipt(filePath)
  })

  ipcMain.handle(
    'personnel-expense-plan:prefill',
    async (
      _event,
      options?: { archive?: boolean }
    ): Promise<PersonnelExpensePlanPrefillResult> => {
      const status = await getImportWatcherStatus()
      const prefill = await readPersonnelExpensePlanPrefill(status.folderPath, options)
      return filterPersonnelExpensePrefillToUnit(prefill)
    }
  )

  ipcMain.handle(
    'salary-quota-match:local-summary',
    (): Promise<SalaryQuotaMatchLocalSummary> => computeSalaryQuotaMatchLocalSummary()
  )

  ipcMain.handle(
    'local-file:read-base64',
    async (_event, filePath: string): Promise<LocalFileBase64> => {
      const { readFileSync, statSync } = await import('node:fs')
      const { basename, extname } = await import('node:path')
      if (!filePath) throw new Error('文件路径为空')
      const ext = extname(filePath).toLowerCase()
      if (!['.xls', '.xlsx', '.csv'].includes(ext)) {
        throw new Error('只允许读取 Excel/CSV 导入文件')
      }
      assertInsideBusinessRoots(filePath, '导入文件')
      const buffer = readFileSync(filePath)
      const stat = statSync(filePath)
      return {
        filePath,
        fileName: basename(filePath),
        base64: buffer.toString('base64'),
        size: stat.size
      }
    }
  )

  ipcMain.handle(
    'app:run-workflow',
    async (_event, workflowKey: string, payload?: WorkflowRunPayload): Promise<WorkflowRunResult> => {
      const database = await getDatabase()
      const result = await runWorkflow(workflowKey, payload)

      await run(
        database,
        `
          INSERT INTO workflow_runs (workflow_name, ok, affected_rows, messages, warnings)
          VALUES (?, ?, ?, ?, ?)
        `,
        [
          result.workflowName,
          result.ok ? 1 : 0,
          result.affectedRows,
          JSON.stringify(result.messages),
          JSON.stringify(result.warnings)
        ]
      )

      return result
    }
  )

  ipcMain.handle(
    'monthly-payroll:generate-report-view',
    (_event, payload?: WorkflowRunPayload): Promise<MonthlyPayrollReportResult> => {
      return generateMonthlyPayrollReportView(payload?.monthlyPayroll)
    }
  )

  ipcMain.handle(
    'monthly-payroll:inspect-source-periods',
    (_event, payload?: WorkflowRunPayload) => {
      return inspectMonthlyPayrollSourcePeriods(payload?.monthlyPayroll)
    }
  )

  ipcMain.handle('integration:open-external', async (_event, url: string): Promise<void> => {
    await shell.openExternal(url)
  })

  ipcMain.handle(
    'portal-recorder:save',
    async (_event, payload: unknown): Promise<{ ok: true; filePath: string } | { ok: false; reason: string }> => {
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const status = await getImportWatcherStatus()
        const folder = join(status.folderPath, '一体化页面采集')
        await mkdir(folder, { recursive: true })

        const now = new Date()
        const pad = (value: number): string => String(value).padStart(2, '0')
        const timestamp = [
          now.getFullYear(),
          pad(now.getMonth() + 1),
          pad(now.getDate())
        ].join('') + '-' + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('')
        const filePath = join(folder, `一体化页面采集-${timestamp}.json`)
        await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
        return { ok: true, filePath }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'integration:native-recorder-start',
    async (
      _event,
      payload: { sessionId: string; webContentsIds: number[] }
    ): Promise<{ ok: true; attached: number; tracked: number } | { ok: false; reason: string }> => {
      try {
        const { webContents } = await import('electron')
        const sessionId = sanitizeRecordingPathSegment(payload.sessionId || '一体化录制')
        let session = nativeRecorderSessions.get(sessionId)
        if (!session) {
          session = {
            sessionId,
            startedAt: Date.now(),
            events: [],
            detachByWebContentsId: new Map()
          }
          nativeRecorderSessions.set(sessionId, session)
        }

        let attached = 0
        const ids = Array.from(new Set((payload.webContentsIds || []).filter(Number.isFinite)))
        for (const id of ids) {
          const wc = webContents.fromId(id)
          if (!wc || wc.isDestroyed()) continue
          if (attachNativeRecorderToWebContents(session, wc)) attached += 1
        }
        return { ok: true, attached, tracked: session.detachByWebContentsId.size }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'integration:native-recorder-drain',
    (_event, payload: { sessionId: string }): { ok: true; events: NativeRecorderEvent[] } => {
      return { ok: true, events: drainNativeRecorderSession(sanitizeRecordingPathSegment(payload.sessionId || '一体化录制')) }
    }
  )

  ipcMain.handle(
    'integration:native-recorder-stop',
    (_event, payload: { sessionId: string }): { ok: true; events: NativeRecorderEvent[] } => {
      return { ok: true, events: stopNativeRecorderSession(sanitizeRecordingPathSegment(payload.sessionId || '一体化录制')) }
    }
  )

  ipcMain.handle(
    'integration:save-recording',
    async (
      _event,
      payload: { json: string; defaultFileName?: string }
    ): Promise<{ ok: true; path: string } | { ok: false; reason: string; canceled?: boolean }> => {
      try {
        const { dialog } = await import('electron')
        const { writeFileSync } = await import('node:fs')
        const def =
          payload.defaultFileName ||
          `一体化录制_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
        const res = await dialog.showSaveDialog({
          title: '保存录制文件',
          defaultPath: def,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (res.canceled || !res.filePath) {
          return { ok: false, reason: '用户取消', canceled: true }
        }
        writeFileSync(res.filePath, payload.json, 'utf-8')
        return { ok: true, path: res.filePath }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'integration:capture-recording-screenshot',
    async (
      _event,
      payload: {
        webContentsId: number
        sessionId: string
        sequence: number
        kind?: string
      }
    ): Promise<{
      ok: true
      path: string
      fileName: string
      folder: string
    } | { ok: false; reason: string }> => {
      try {
        const { webContents } = await import('electron')
        const { mkdir, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const wc = webContents.fromId(payload.webContentsId)
        if (!wc || wc.isDestroyed()) return { ok: false, reason: '找不到 webContents' }

        const status = await getImportWatcherStatus()
        const sessionId = sanitizeRecordingPathSegment(payload.sessionId || '一体化录制')
        const kind = sanitizeRecordingPathSegment(payload.kind || 'step')
        const folder = join(status.folderPath, '一体化页面采集', `${sessionId}-screenshots`)
        await mkdir(folder, { recursive: true })

        const sequence = Number.isFinite(payload.sequence) && payload.sequence > 0
          ? Math.floor(payload.sequence)
          : 1
        const fileName = `${String(sequence).padStart(4, '0')}-${kind}.png`
        const filePath = join(folder, fileName)
        const image = await wc.capturePage()
        if (image.isEmpty()) return { ok: false, reason: '截图为空' }

        await writeFile(filePath, image.toPNG())
        return { ok: true, path: filePath, fileName, folder }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'integration:drain-all-frames',
    async (
      _event,
      payload: { webContentsId: number; code: string }
    ): Promise<{
      ok: true
      results: Array<{ frameUrl: string; value: unknown }>
    } | { ok: false; reason: string }> => {
      try {
        const { webContents } = await import('electron')
        const wc = webContents.fromId(payload.webContentsId)
        if (!wc) return { ok: false, reason: '找不到 webContents' }
        const frames = wc.mainFrame.framesInSubtree
        const results: Array<{ frameUrl: string; value: unknown }> = []
        await Promise.all(
          frames.map(async (frame) => {
            try {
              const v = await frame.executeJavaScript(payload.code, false)
              results.push({ frameUrl: frame.url, value: v })
            } catch (error) {
              results.push({ frameUrl: frame.url, value: { __error: String(error) } })
            }
          })
        )
        return { ok: true, results }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'integration:get-portal-token',
    async (
      _event,
      payload: { webContentsId: number }
    ): Promise<{ ok: true; token: string; source: string } | { ok: false; reason: string }> => {
      try {
        const { webContents } = await import('electron')
        const wc = webContents.fromId(payload.webContentsId)
        if (!wc) return { ok: false, reason: '找不到 webContents' }
        const urls: string[] = []
        try {
          urls.push(wc.getURL())
          for (const f of wc.mainFrame.framesInSubtree) {
            if (f.url) urls.push(f.url)
          }
        } catch {}
        // 严格只接受带 HWACCESSTOKEN- 前缀的 token（BIM 模块用的，跟 uportal 普通 token 不同）
        for (const u of urls) {
          const m = /[?&]tokenid=(HWACCESSTOKEN[^&#]+)/i.exec(u)
          if (m && m[1]) return { ok: true, token: decodeURIComponent(m[1]), source: 'url' }
        }
        // cookie 兜底（捕获嵌在 cookie 值里的 HWACCESSTOKEN-xxx 串）
        const cookies = await wc.session.cookies.get({})
        for (const c of cookies) {
          if (!c.value) continue
          const m = /HWACCESSTOKEN-[A-Za-z0-9]+/.exec(c.value)
          if (m) return { ok: true, token: m[0], source: 'cookie' }
        }
        return {
          ok: false,
          reason:
            'HWACCESSTOKEN 还未生成（预算模块未激活）。请在一体化系统里手动点开一次"预算编制 → 人员信息查看"页面（让系统完成授权 + 颁 token），然后再点"预算导出"。\n后续同一登录会话内 token 会保留，不用重复手动进。'
        }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'integration:exec-in-all-frames',
    async (
      _event,
      payload: { webContentsId: number; code: string }
    ): Promise<{ ok: true; count: number } | { ok: false; reason: string }> => {
      try {
        const { webContents } = await import('electron')
        const wc = webContents.fromId(payload.webContentsId)
        if (!wc) return { ok: false, reason: '找不到 webContents' }

        const frames = wc.mainFrame.framesInSubtree
        let count = 0
        await Promise.all(
          frames.map(async (frame) => {
            try {
              await frame.executeJavaScript(payload.code, false)
              count += 1
            } catch (error) {
              // 跨域 / 已销毁的 frame 会抛错，单个 frame 失败不影响其他
            }
          })
        )
        return { ok: true, count }
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  ipcMain.handle(
    'voucher-push:read-xlsx',
    async (
      _event,
      payload: { filePath: string }
    ): Promise<
      | { ok: true; base64: string; fileName: string; size: number }
      | { ok: false; reason: string }
    > => {
      try {
        const { readFileSync } = await import('node:fs')
        const { basename } = await import('node:path')
        assertInsideBusinessRoots(payload.filePath, '凭证文件')
        const buf = readFileSync(payload.filePath)
        return {
          ok: true,
          base64: buf.toString('base64'),
          fileName: basename(payload.filePath),
          size: buf.length
        }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'insurance-push:parse-xlsx',
    async (
      _event,
      payload: { filePath: string }
    ): Promise<
      | {
          ok: true
          records: Array<Record<string, string>>
        }
      | { ok: false; reason: string }
    > => {
      try {
        const { parseInsuranceImportXlsx } = await import(
          '../services/insurance-push/parseInsuranceImportXlsx'
        )
        const records = parseInsuranceImportXlsx(payload.filePath)
        return { ok: true, records }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle(
    'budget-import:preview',
    (_event, filePath: string) => previewBudgetXls(filePath)
  )

  ipcMain.handle(
    'budget-import:commit',
    (_event, filePath: string) => importBudgetXls(filePath)
  )

  ipcMain.handle(
    'salary-export:save-xls',
    async (
      _event,
      payload: { filename: string; base64: string }
    ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
      try {
        const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')
        // 复用 watcher 当前监控的文件夹；watcher 一旦 add 就自动入库
        const status = await getImportWatcherStatus()
        const folder = status.folderPath
        if (!folder) return { ok: false, reason: '导入文件夹未配置（请先在"导入监视"里设置）' }
        if (!existsSync(folder)) mkdirSync(folder, { recursive: true })

        // 文件名做时间戳防冲突，扩展名保持 .xls
        const safeBase = (payload.filename || 'salary-export.xls').replace(/[\\/:*?"<>|]/g, '_')
        const ts = new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/[T.]/g, '_')
          .slice(0, 17)
        const dotIdx = safeBase.lastIndexOf('.')
        const stem = dotIdx > 0 ? safeBase.slice(0, dotIdx) : safeBase
        const ext = dotIdx > 0 ? safeBase.slice(dotIdx) : '.xls'
        const finalName = `${stem}_${ts}${ext}`
        const fullPath = join(folder, finalName)

        const buf = Buffer.from(payload.base64, 'base64')
        writeFileSync(fullPath, buf)
        return { ok: true, path: fullPath }
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  ipcMain.handle('app:open-path', async (_event, path: string): Promise<string> => {
    return shell.openPath(path)
  })

  // 渲染层/webview 自动化日志统一落盘到主进程日志文件（R-07/A3）
  ipcMain.handle('app-log:append', (_event, source: string, line: string): void => {
    appendMainLog('info', `renderer:${String(source || 'unknown').slice(0, 40)}`, String(line ?? '').slice(0, 2000))
  })

  // 一体化推送过程日志：渲染进程逐行写入，按天分文件，便于内网排查
  ipcMain.handle('push-log:append', async (_event, line: string): Promise<void> => {
    try {
      await appendPushLog(String(line ?? ''))
    } catch (error) {
      console.warn('写入推送日志失败', error)
    }
  })

  ipcMain.handle('push-log:open-folder', async (): Promise<string> => {
    const dir = await ensurePushLogDir()
    return shell.openPath(dir)
  })

  ipcMain.handle(
    'print:list-printers',
    async (event: IpcMainInvokeEvent): Promise<PrinterSummary[]> => {
      const printers = await event.sender.getPrintersAsync()
      return printers.map((printer) => ({
        name: printer.name,
        displayName: printer.displayName || printer.name,
        isDefault: Boolean(printer.isDefault),
        status: printer.status ? String(printer.status) : undefined
      }))
    }
  )

  ipcMain.handle(
    'monthly-payroll:print-settings:get',
    (): Promise<MonthlyPayrollPrintSettings> => readMonthlyPayrollPrintSettings()
  )

  ipcMain.handle(
    'monthly-payroll:print-settings:set',
    (_event, settings: MonthlyPayrollPrintSettings): Promise<MonthlyPayrollPrintSettings> =>
      writeMonthlyPayrollPrintSettings(settings)
  )

  ipcMain.handle(
    'print:current-view',
    async (event: IpcMainInvokeEvent, request: PrintRequest = {}): Promise<void> => {
      const deviceName = request.printerName?.trim()
      await new Promise<void>((resolve, reject) => {
        event.sender.print(
          {
            silent: Boolean(deviceName),
            deviceName,
            printBackground: true,
            margins: { marginType: 'none' },
            landscape: request.landscape,
            scaleFactor: request.scaleFactor,
            pageSize: request.pageSize
          },
          (success, failureReason) => {
            if (success) resolve()
            else reject(new Error(failureReason || '打印失败'))
          }
        )
      })
    }
  )

  ipcMain.handle('monthly-payroll:list-runs', (): Promise<MonthlyPayrollRun[]> =>
    listMonthlyPayrollRuns()
  )

  ipcMain.handle(
    'monthly-payroll:list-source-versions',
    (_event, year: number, month: number): Promise<MonthlyPayrollSourceVersion[]> =>
      listMonthlyPayrollSourceVersions(year, month)
  )

  ipcMain.handle(
    'monthly-payroll:set-source-version-current',
    (_event, id: number): Promise<MonthlyPayrollSourceVersion> =>
      setMonthlyPayrollSourceVersionCurrent(id)
  )

  ipcMain.handle(
    'monthly-payroll:update-push-status',
    (
      _event,
      id: number,
      target: MonthlyPayrollPushTarget,
      status: MonthlyPayrollPushStatus
    ): Promise<MonthlyPayrollRun> => updateMonthlyPayrollPushStatus(id, target, status)
  )

  ipcMain.handle(
    'monthly-payroll:assert-pushable',
    (_event, id: number): Promise<MonthlyPayrollPushGuardResult> =>
      assertMonthlyPayrollRunPushable(id)
  )

  ipcMain.handle('monthly-payroll:delete-run', (_event, id: number): Promise<boolean> =>
    deleteMonthlyPayrollRun(id)
  )

  ipcMain.handle(
    'monthly-payroll:archive-run',
    (_event, id: number): Promise<MonthlyPayrollArchiveResult> =>
      archiveMonthlyPayrollRun(id)
  )

  ipcMain.handle(
    'monthly-payroll:cancel-month-close',
    (_event, id: number): Promise<MonthlyPayrollRun> =>
      cancelMonthlyPayrollMonthClose(id)
  )

  ipcMain.handle(
    'monthly-payroll:get-run-report',
    (_event, id: number): Promise<MonthlyPayrollReportResult | null> =>
      getMonthlyPayrollRunReport(id)
  )

  ipcMain.handle(
    'monthly-payroll:print-salary-via-excel',
    async (
      _event,
      request: {
        salaryWorkbookPath: string
        salaryWorkbookFallbackPaths?: string[]
        taxWorkbookPath?: string
        printerName?: string
        invoicePaperName?: string
      }
    ): Promise<void> => {
      await printSalaryWorkbookViaExcel(request)
    }
  )

  ipcMain.handle(
    'monthly-payroll:salary-print-page-summary',
    async (
      _event,
      request: {
        salaryWorkbookPath: string
        salaryWorkbookFallbackPaths?: string[]
        taxWorkbookPath?: string
        printerName?: string
        invoicePaperName?: string
      }
    ): Promise<MonthlyPayrollSalaryPrintPageSummary> => {
      return getSalaryWorkbookPrintPageSummary(request)
    }
  )

  ipcMain.handle(
    'annual-adjustment:choose-files',
    (_event, request: AnnualAdjustmentChooseFilesRequest): Promise<AnnualAdjustmentFilePick[] | null> =>
      chooseAnnualAdjustmentFiles(request)
  )

  ipcMain.handle(
    'annual-adjustment:preview',
    (_event, input: AnnualAdjustmentPreviewInput): Promise<AnnualAdjustmentPreview> =>
      previewAnnualAdjustment(input)
  )

  ipcMain.handle(
    'annual-adjustment:apply',
    (_event, input: AnnualAdjustmentApplyInput): Promise<AnnualAdjustmentApplyResult> =>
      applyAnnualAdjustment(input)
  )

  ipcMain.handle(
    'personal-tax:generate-import',
    (_event, input: PersonalTaxImportGenerateInput): Promise<PersonalTaxImportGenerateResult> =>
      generatePersonalTaxImportWorkbook(input)
  )

  ipcMain.handle(
    'social-insurance:export-base',
    (_event, input: SocialInsuranceBaseExportInput): Promise<SocialInsuranceBaseExportResult> =>
      exportSocialInsuranceBaseWorkbook(input)
  )

  ipcMain.handle(
    'social-base:preview',
    (_event, input: SocialBasePreviewInput): Promise<SocialBasePreview> =>
      previewSocialInsuranceBase(input)
  )

  ipcMain.handle(
    'social-base:apply',
    (_event, input: SocialBaseApplyInput): Promise<SocialBaseApplyResult> =>
      applySocialInsuranceBase(input)
  )

  ipcMain.handle(
    'performance-payroll:generate',
    (_event, input: PerformancePayrollGenerateInput): PerformancePayrollGenerateResult =>
      generatePerformancePayroll(input)
  )

  ipcMain.handle(
    'performance-payroll:generate-from-history',
    (_event, input: PerformancePayrollHistoryGenerateInput): Promise<PerformancePayrollGenerateResult> =>
      generatePerformancePayrollFromHistory(input)
  )

  ipcMain.handle(
    'performance-payroll:generate-from-local',
    (_event, input: PerformancePayrollLocalGenerateInput): Promise<PerformancePayrollGenerateResult> =>
      generatePerformancePayrollFromLocal(input)
  )

  ipcMain.handle('unit-settings:get', (): Promise<UnitSettings> => readUnitSettings())

  ipcMain.handle('unit-settings:lock-state', () => getUnitSettingsLockState())

  ipcMain.handle(
    'unit-settings:resolve-school',
    async (_event, budgetUnitCode: string): Promise<Partial<UnitSettings> | null> => {
      const database = await getDatabase()
      const lockState = await getUnitSettingsLockState()
      if (lockState.locked) throw new Error('系统已有业务数据，不能重新填写单位信息')
      return resolveSchoolUnitSettings(database, budgetUnitCode)
    }
  )

  ipcMain.handle(
    'unit-settings:set',
    (_event, settings: UnitSettings): Promise<UnitSettings> => writeUnitSettings(settings)
  )

  ipcMain.handle(
    'monthly-payroll:settings:get',
    (): Promise<MonthlyPayrollSettings> => readMonthlyPayrollSettings()
  )

  ipcMain.handle(
    'monthly-payroll:settings:set',
    (_event, settings: MonthlyPayrollSettings): Promise<MonthlyPayrollSettings> =>
      writeMonthlyPayrollSettings(settings)
  )

  ipcMain.handle(
    'worksheet:list-records',
    async (
      _event,
      worksheetId: string,
      query: WorksheetRecordsQuery = {}
    ): Promise<WorksheetRecordsResult> => {
      return listRecords(worksheetId, query)
    }
  )

  ipcMain.handle(
    'worksheet:save-fields',
    async (_event, worksheetId: string, fields: WorksheetField[]): Promise<AppSummary> => {
      await saveWorksheetFields(worksheetId, fields)
      const worksheets = readWorksheetMetadata()
      const visibleWorksheets = worksheets.map((item) => {
        const views = getVisibleViews(item)
        return {
          name: item.name,
          worksheetId: item.worksheetId,
          fieldCount: item.fields.length,
          viewCount: views.length,
          fields: item.fields,
          views
        }
      })

      return {
        tableCount: worksheets.length,
        fieldCount: worksheets.reduce((total, item) => total + item.fields.length, 0),
        databasePath: getDatabasePath(),
        worksheets: visibleWorksheets
      }
    }
  )

  ipcMain.handle(
    'worksheet:create-record',
    (
      _event,
      worksheetId: string,
      values: Record<string, WorksheetRecordValue>
    ): Promise<WorksheetMutationResult & { recordId: number }> => {
      return createRecord(worksheetId, values)
    }
  )

  ipcMain.handle(
    'worksheet:update-record',
    (
      _event,
      worksheetId: string,
      recordId: number,
      values: Record<string, WorksheetRecordValue>
    ): Promise<WorksheetMutationResult> => {
      return updateRecord(worksheetId, recordId, values)
    }
  )

  ipcMain.handle(
    'worksheet:delete-record',
    (_event, worksheetId: string, recordId: number): Promise<WorksheetMutationResult> => {
      return deleteRecord(worksheetId, recordId)
    }
  )

  ipcMain.handle(
    'worksheet:delete-records',
    (_event, worksheetId: string, recordIds: number[]): Promise<WorksheetMutationResult> => {
      return deleteRecords(worksheetId, recordIds)
    }
  )

  ipcMain.handle(
    'worksheet:clear',
    (_event, worksheetId: string): Promise<WorksheetMutationResult> => {
      return clearWorksheet(worksheetId)
    }
  )

  ipcMain.handle(
    'worksheet:personnel-child-records',
    (_event, idCardValue: string): Promise<PersonnelChildRecords[]> => {
      return listPersonnelChildRecords(idCardValue)
    }
  )

  ipcMain.handle(
    'worksheet:export',
    (
      _event,
      worksheetId: string,
      view?: string
    ): Promise<{ filePath: string; rowCount: number } | null> => {
      return exportWorksheetToExcel(worksheetId, view)
    }
  )

  ipcMain.handle(
    'system:wipe-all',
    (): Promise<{ tables: number; rows: number }> => wipeAllWorksheetData()
  )

  ipcMain.handle('recycle-bin:list-batches', (_event, limit?: number): Promise<RecycleBinBatch[]> => {
    return listRecycleBinBatches(limit)
  })

  ipcMain.handle(
    'recycle-bin:list-records',
    (_event, batchId: number, limit?: number): Promise<RecycleBinRecord[]> => {
      return listRecycleBinRecords(batchId, limit)
    }
  )

  ipcMain.handle(
    'recycle-bin:restore-batch',
    (_event, batchId: number): Promise<RecycleBinRestoreResult> => {
      return restoreRecycleBinBatch(batchId)
    }
  )

  ipcMain.handle(
    'import:choose-file',
    (): Promise<{ filePath: string; fileName: string } | null> => {
      return chooseExcelFile()
    }
  )

  ipcMain.handle(
    'import:preview',
    (_event, filePath: string, worksheetId?: string): Promise<ImportPreview> => {
      return previewExcelFile(filePath, worksheetId)
    }
  )

  ipcMain.handle(
    'import:commit',
    (_event, filePath: string, worksheetId: string, options?: { confirmUpdates?: boolean }): Promise<ImportBatchSummary> => {
      return commitExcelImport(filePath, worksheetId, options)
    }
  )

  ipcMain.handle('import:list-batches', (_event, limit?: number): Promise<ImportBatchSummary[]> => {
    return listImportBatches(limit)
  })

  ipcMain.handle(
    'hr-master-sync:preview-integrated',
    (): Promise<HrMasterSyncPreview> => previewHrMasterSyncFromIntegrated()
  )

  ipcMain.handle(
    'hr-master-sync:apply-integrated',
    (_event, selections?: MasterSyncSelectionItem[]): Promise<HrMasterSyncApplyResult> =>
      applyHrMasterSyncFromIntegrated(selections)
  )

  ipcMain.handle(
    'budget-active-sync:preview-master',
    (): Promise<BudgetActiveMasterSyncPreview> => previewBudgetActiveMasterSync()
  )

  ipcMain.handle(
    'budget-active-sync:apply-master',
    (_event, selections?: MasterSyncSelectionItem[]): Promise<BudgetActiveMasterSyncApplyResult> =>
      applyBudgetActiveMasterSync(selections)
  )

  ipcMain.handle(
    'teacher-detail-sync:preview-master',
    (): Promise<TeacherDetailMasterSyncPreview> => previewTeacherDetailMasterSync()
  )

  ipcMain.handle(
    'teacher-detail-sync:apply-master',
    (_event, selections?: MasterSyncSelectionItem[]): Promise<TeacherDetailMasterSyncApplyResult> =>
      applyTeacherDetailMasterSync(selections)
  )

  ipcMain.handle(
    'township-sync:fill-id-cards',
    (): Promise<TownshipIdCardFillResult> => fillTownshipIdCardsByHrName()
  )

  ipcMain.handle(
    'township-sync:preview-master',
    (): Promise<TownshipMasterSyncPreview> => previewTownshipMasterSync()
  )

  ipcMain.handle(
    'township-sync:apply-master',
    (_event, selections?: MasterSyncSelectionItem[]): Promise<TownshipMasterSyncApplyResult> =>
      applyTownshipMasterSync(selections)
  )

  ipcMain.handle(
    'import:rollback-batch',
    (_event, batchId: number): Promise<ImportBatchSummary> => {
      return rollbackImportBatch(batchId)
    }
  )

  ipcMain.handle('backup:list', (): BackupSummary[] => listBackups())
  ipcMain.handle('backup:list-full', (): BackupSummary[] => listFullBackups())
  ipcMain.handle('backup:create', (): Promise<BackupSummary> => createBackup())
  ipcMain.handle(
    'backup:restore',
    (_event, fileName: string): Promise<BackupSummary> => restoreBackup(fileName)
  )
  ipcMain.handle('backup:create-full', (): Promise<FullBackupSummary | null> => createFullBackup())
  ipcMain.handle(
    'backup:restore-full',
    (_event, fileName?: string): Promise<FullBackupSummary | null> => restoreFullBackup(fileName)
  )

  ipcMain.handle('pivot:list-configs', (): Promise<PivotConfigSummary[]> => listPivotConfigs())

  ipcMain.handle(
    'pivot:get-config',
    (_event, id: number): Promise<PivotConfig | undefined> => getPivotConfig(id)
  )

  ipcMain.handle(
    'pivot:save-config',
    (_event, config: PivotConfig): Promise<PivotConfig> => savePivotConfig(config)
  )

  ipcMain.handle(
    'pivot:delete-config',
    (_event, id: number): Promise<void> => deletePivotConfig(id)
  )

  ipcMain.handle(
    'pivot:run',
    (_event, config: PivotConfig): Promise<PivotResult> => runPivot(config)
  )

  ipcMain.handle(
    'pivot:export',
    (
      _event,
      config: PivotConfig,
      defaultName: string
    ): Promise<{ filePath: string; rowCount: number } | null> =>
      exportPivotToExcel(config, defaultName)
  )

  ipcMain.handle(
    'pivot:detect-id-card',
    (_event, worksheetId: string): string | undefined => {
      const worksheet = readWorksheetMetadata().find((item) => item.worksheetId === worksheetId)
      if (!worksheet) return undefined
      return detectIdCardField(worksheet)
    }
  )

  ipcMain.handle(
    'archive:list-lookup-failures',
    (_event, query: LookupFailureQuery = {}): Promise<{
      total: number
      rows: LookupFailureEntry[]
    }> => listLookupFailures(query)
  )

  ipcMain.handle('stat-report:list', (): StatReportDef[] => STAT_REPORT_DEFS)

  ipcMain.handle(
    'stat-report:run',
    (_event, id: string): Promise<StatReportResult> => runStatReport(id)
  )

  ipcMain.handle(
    'stat-report:export',
    (_event, result: StatReportResult): Promise<{ filePath: string; rowCount: number }> =>
      exportStatReport(result)
  )

  ipcMain.handle(
    'stat-report:drill',
    (
      _event,
      filters: StatReportFilterClause[],
      filterDesc: string,
      columnKey?: string,
      columnLabel?: string
    ): Promise<StatReportDrillResult> =>
      drillStatReport(filters, filterDesc, columnKey, columnLabel)
  )
}

function getVisibleViews(item: WorksheetMeta): Array<{
  viewId?: string
  name?: string
}> {
  const allOnlyWorksheetNames = new Set([
    '\u4e00\u4f53\u5316\u9000\u4f11',
    '\u4e00\u4f53\u5316\u5176\u4ed6',
    '\u7ee9\u6548\u5de5\u8d44',
    '\u4eba\u5458\u660e\u7ec6\u5bfc\u51fa',
    '\u65b0\u623f\u8865'
  ])
  if (item.name === '\u5de5\u8d44\u5e74\u62a5') {
    return getOrderedViews(item, ['\u5728\u804c'])
  }
  if (item.name === '\u5728\u804c\u5de5\u8d44') {
    return getOrderedViews(item, ['\u5168\u90e8', '\u5de5\u8d44(001)', '\u6570\u5e01(002)'])
  }
  if (allOnlyWorksheetNames.has(item.name)) {
    return getOrderedViews(item, ['\u5168\u90e8'])
  }
  if (item.name === '\u4e61\u9547\u8865\u8d34') {
    return getOrderedViews(item, ['\u5728\u804c', '\u5f53\u5e74\u5e94\u8c03\u6574', '\u5168\u90e8'])
  }
  return getPersonnelStatusViews(item).filter((view) => !view.name?.includes('\u590d\u5236'))
}

function getOrderedViews(
  item: WorksheetMeta,
  names: string[]
): Array<{ viewId?: string; name?: string }> {
  const source = [...getPersonnelStatusViews(item), ...(item.views ?? [])]
  const existingByName = new Map(source.map((view) => [view.name, view]))
  return names.map((name) => ({
    ...existingByName.get(name),
    name
  }))
}
