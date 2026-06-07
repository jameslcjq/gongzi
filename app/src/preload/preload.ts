import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSummary,
  BackupSummary,
  ConsistencyAuditApplyDirection,
  ConsistencyAuditApplyResult,
  ConsistencyAuditIssue,
  ConsistencyAuditResult,
  ExchangePackageBuildResult,
  ExchangePackageImportResult,
  ExchangePackagePreview,
  ExchangeReceiptBuildResult,
  ExchangeReceiptImportResult,
  ExchangeStatus,
  AutomationCaptureResult,
  AutomationHelperStatus,
  AutomationKeySwitchResult,
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
  LookupFailureEntry,
  PersonnelExpensePlanPrefillResult,
  SalaryQuotaMatchLocalSummary,
  PivotConfig,
  PivotResult,
  WorkflowDefinition,
  MonthlyPayrollReportResult,
  MonthlyPayrollArchiveResult,
  WorkflowRunResult,
  WorkflowRunPayload,
  WorksheetMutationResult,
  WorksheetField,
  WorksheetRecordValue,
  WorksheetRecordsQuery,
  WorksheetRecordsResult,
  MonthlyPayrollRun,
  MonthlyPayrollPushStatus,
  MonthlyPayrollPushTarget,
  MonthlyPayrollSourceVersion,
  MonthlyPayrollSourcePeriodInspection,
  MonthlyPayrollSalaryPrintPageSummary,
  MonthlyPayrollPrintSettings,
  MonthlyPayrollSettings,
  RecycleBinBatch,
  RecycleBinRecord,
  RecycleBinRestoreResult,
  PrintRequest,
  PrinterSummary,
  UnitSettings,
  UnitSettingsLockState,
  AnnualAdjustmentApplyInput,
  AnnualAdjustmentApplyResult,
  AnnualAdjustmentChooseFilesRequest,
  AnnualAdjustmentFilePick,
  AnnualAdjustmentPreview,
  AnnualAdjustmentPreviewInput,
  PerformancePayrollGenerateInput,
  PerformancePayrollGenerateResult,
  PerformancePayrollHistoryGenerateInput,
  PerformancePayrollLocalGenerateInput,
  PersonalTaxImportGenerateInput,
  PersonalTaxImportGenerateResult,
  SocialInsuranceBaseExportInput,
  SocialInsuranceBaseExportResult,
  MailAccountView,
  MailAccount,
  MailDownloadRule,
  MailDownloadLog,
  MailDownloadRecord,
  MailCheckProgress,
  MailCheckResult,
  LocalFileBase64,
  BudgetImportResult
} from '../shared/types'

type PivotConfigSummary = {
  id: number
  name: string
  primaryWorksheetId: string
  primaryWorksheetName: string
  createdAt: string
  updatedAt: string
}

type LookupFailureQuery = {
  workflow?: string
  worksheet?: string
  search?: string
  limit?: number
  offset?: number
}

const salaryApi = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  licenseStatus: () => ipcRenderer.invoke('license:status'),
  licenseCheck: (licenseKey?: string) => ipcRenderer.invoke('license:check', licenseKey),
  licenseClaimTrial: (customerName: string, customerCode?: string) =>
    ipcRenderer.invoke('license:claimTrial', customerName, customerCode),
  licenseGetKey: () => ipcRenderer.invoke('license:getKey'),
  licenseSaveKey: (licenseKey: string) => ipcRenderer.invoke('license:saveKey', licenseKey),
  licenseGetServerUrl: () => ipcRenderer.invoke('license:getServerUrl'),
  licenseDeviceInfo: (licenseKey?: string) => ipcRenderer.invoke('license:deviceInfo', licenseKey),
  licenseExportMachineRequest: (licenseKey?: string) =>
    ipcRenderer.invoke('license:exportMachineRequest', licenseKey),
  licenseImportOffline: () => ipcRenderer.invoke('license:importOffline'),
  getSummary: (): Promise<AppSummary> => ipcRenderer.invoke('app:get-summary'),
  runConsistencyAudit: (): Promise<ConsistencyAuditResult> =>
    ipcRenderer.invoke('consistency-audit:run'),
  applyConsistencyAudit: (
    direction: ConsistencyAuditApplyDirection,
    issues: ConsistencyAuditIssue[]
  ): Promise<ConsistencyAuditApplyResult> =>
    ipcRenderer.invoke('consistency-audit:apply', direction, issues),
  getAutomationHelperStatus: (): Promise<AutomationHelperStatus> =>
    ipcRenderer.invoke('automation:helper-status'),
  collectIntegrationLoginKey: (): Promise<AutomationCaptureResult> =>
    ipcRenderer.invoke('automation:collect-login-key'),
  switchIntegrationLoginKey: (
    keyText: string,
    index?: number,
    options?: { pin?: string; confirm?: boolean }
  ): Promise<AutomationKeySwitchResult> =>
    ipcRenderer.invoke('automation:switch-login-key', { keyText, index, ...options }),
  openAutomationDebugFolder: (): Promise<string> =>
    ipcRenderer.invoke('automation:open-debug-folder'),

  getImportWatcherStatus: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:get-status'),
  chooseImportWatcherFolder: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:choose-folder'),
  openImportWatcherFolder: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:open-folder'),
  clearImportWatcherLogs: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:clear-logs'),
  getExchangeStatus: (): Promise<ExchangeStatus> =>
    ipcRenderer.invoke('exchange:get-status'),
  scanExchangeMedia: (): Promise<ExchangeStatus> =>
    ipcRenderer.invoke('exchange:scan-media'),
  openExchangeInbox: (): Promise<string> =>
    ipcRenderer.invoke('exchange:open-inbox'),
  openExchangeOutbox: (): Promise<string> =>
    ipcRenderer.invoke('exchange:open-outbox'),
  chooseExchangePackage: (): Promise<{ filePath: string; fileName: string } | null> =>
    ipcRenderer.invoke('exchange:choose-package'),
  previewExchangePackage: (filePath: string): Promise<ExchangePackagePreview> =>
    ipcRenderer.invoke('exchange:preview-package', filePath),
  previewExchangeReceipt: (filePath: string): Promise<ExchangePackagePreview> =>
    ipcRenderer.invoke('exchange:preview-receipt', filePath),
  buildMonthlyPayrollExchangePackage: (runId: number): Promise<ExchangePackageBuildResult> =>
    ipcRenderer.invoke('exchange:build-monthly-package', runId),
  importMonthlyPayrollExchangePackage: (filePath: string): Promise<ExchangePackageImportResult> =>
    ipcRenderer.invoke('exchange:import-monthly-package', filePath),
  buildMonthlyPayrollExchangeReceipt: (runId: number): Promise<ExchangeReceiptBuildResult> =>
    ipcRenderer.invoke('exchange:build-receipt', runId),
  importMonthlyPayrollExchangeReceipt: (filePath: string): Promise<ExchangeReceiptImportResult> =>
    ipcRenderer.invoke('exchange:import-receipt', filePath),
  getPersonnelExpensePlanPrefill: (options?: { archive?: boolean }): Promise<PersonnelExpensePlanPrefillResult> =>
    ipcRenderer.invoke('personnel-expense-plan:prefill', options),
  getSalaryQuotaMatchLocalSummary: (): Promise<SalaryQuotaMatchLocalSummary> =>
    ipcRenderer.invoke('salary-quota-match:local-summary'),
  readLocalFileBase64: (filePath: string): Promise<LocalFileBase64> =>
    ipcRenderer.invoke('local-file:read-base64', filePath),

  listWorkflows: (): Promise<WorkflowDefinition[]> => ipcRenderer.invoke('app:list-workflows'),
  runWorkflow: (workflowKey: string, payload?: WorkflowRunPayload): Promise<WorkflowRunResult> =>
    ipcRenderer.invoke('app:run-workflow', workflowKey, payload),
  generateMonthlyPayrollReportView: (
    payload?: WorkflowRunPayload
  ): Promise<MonthlyPayrollReportResult> =>
    ipcRenderer.invoke('monthly-payroll:generate-report-view', payload),
  inspectMonthlyPayrollSourcePeriods: (
    payload?: WorkflowRunPayload
  ): Promise<MonthlyPayrollSourcePeriodInspection> =>
    ipcRenderer.invoke('monthly-payroll:inspect-source-periods', payload),
  openIntegrationExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('integration:open-external', url),
  execInAllPortalFrames: (
    webContentsId: number,
    code: string
  ): Promise<{ ok: true; count: number } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('integration:exec-in-all-frames', { webContentsId, code }),
  getPortalToken: (
    webContentsId: number
  ): Promise<{ ok: true; token: string; source: string } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('integration:get-portal-token', { webContentsId }),
  drainAllPortalFrames: (
    webContentsId: number,
    code: string
  ): Promise<
    | { ok: true; results: Array<{ frameUrl: string; value: unknown }> }
    | { ok: false; reason: string }
  > => ipcRenderer.invoke('integration:drain-all-frames', { webContentsId, code }),
  savePortalRecording: (
    json: string,
    defaultFileName?: string
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string; canceled?: boolean }> =>
    ipcRenderer.invoke('integration:save-recording', { json, defaultFileName }),
  capturePortalRecordingScreenshot: (
    webContentsId: number,
    options: { sessionId: string; sequence: number; kind?: string }
  ): Promise<{
    ok: true
    path: string
    fileName: string
    folder: string
  } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('integration:capture-recording-screenshot', {
      webContentsId,
      ...options
    }),
  startPortalNativeRecording: (
    sessionId: string,
    webContentsIds: number[]
  ): Promise<{ ok: true; attached: number; tracked: number } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('integration:native-recorder-start', { sessionId, webContentsIds }),
  drainPortalNativeRecording: (
    sessionId: string
  ): Promise<{ ok: true; events: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('integration:native-recorder-drain', { sessionId }),
  stopPortalNativeRecording: (
    sessionId: string
  ): Promise<{ ok: true; events: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('integration:native-recorder-stop', { sessionId }),
  savePortalDomRecord: (
    payload: unknown
  ): Promise<{ ok: true; filePath: string } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('portal-recorder:save', payload),
  onWebviewDownloadDone: (
    handler: (payload: {
      ok: boolean
      state: string
      originalName: string
      savedPath: string
      url: string
      isBudget?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      payload: {
        ok: boolean
        state: string
        originalName: string
        savedPath: string
        url: string
        isBudget?: boolean
      }
    ): void => handler(payload)
    ipcRenderer.on('integration:webview-download-done', listener)
    return () => ipcRenderer.removeListener('integration:webview-download-done', listener)
  },
  onWebviewOpenTabRequest: (
    handler: (payload: { sourceWebContentsId: number; url: string; disposition?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      payload: { sourceWebContentsId: number; url: string; disposition?: string }
    ): void => handler(payload)
    ipcRenderer.on('integration:webview-open-tab', listener)
    return () => ipcRenderer.removeListener('integration:webview-open-tab', listener)
  },
  parseInsuranceImportXlsx: (
    filePath: string
  ): Promise<
    | { ok: true; records: Array<Record<string, string>> }
    | { ok: false; reason: string }
  > => ipcRenderer.invoke('insurance-push:parse-xlsx', { filePath }),
  readVoucherXlsx: (
    filePath: string
  ): Promise<
    | { ok: true; base64: string; fileName: string; size: number }
    | { ok: false; reason: string }
  > => ipcRenderer.invoke('voucher-push:read-xlsx', { filePath }),
  previewBudgetImport: (filePath: string): Promise<BudgetImportResult> =>
    ipcRenderer.invoke('budget-import:preview', filePath),
  commitBudgetImport: (filePath: string): Promise<BudgetImportResult> =>
    ipcRenderer.invoke('budget-import:commit', filePath),
  saveSalaryExportXls: (
    filename: string,
    base64: string
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('salary-export:save-xls', { filename, base64 }),
  getUnitSettings: (): Promise<UnitSettings> => ipcRenderer.invoke('unit-settings:get'),
  getUnitSettingsLockState: (): Promise<UnitSettingsLockState> =>
    ipcRenderer.invoke('unit-settings:lock-state'),
  resolveSchoolUnitSettings: (budgetUnitCode: string): Promise<Partial<UnitSettings> | null> =>
    ipcRenderer.invoke('unit-settings:resolve-school', budgetUnitCode),
  setUnitSettings: (settings: UnitSettings): Promise<UnitSettings> =>
    ipcRenderer.invoke('unit-settings:set', settings),
  getMonthlyPayrollSettings: (): Promise<MonthlyPayrollSettings> =>
    ipcRenderer.invoke('monthly-payroll:settings:get'),
  setMonthlyPayrollSettings: (settings: MonthlyPayrollSettings): Promise<MonthlyPayrollSettings> =>
    ipcRenderer.invoke('monthly-payroll:settings:set', settings),
  listMonthlyPayrollRuns: (): Promise<MonthlyPayrollRun[]> =>
    ipcRenderer.invoke('monthly-payroll:list-runs'),
  listMonthlyPayrollSourceVersions: (
    year: number,
    month: number
  ): Promise<MonthlyPayrollSourceVersion[]> =>
    ipcRenderer.invoke('monthly-payroll:list-source-versions', year, month),
  setMonthlyPayrollSourceVersionCurrent: (id: number): Promise<MonthlyPayrollSourceVersion> =>
    ipcRenderer.invoke('monthly-payroll:set-source-version-current', id),
  updateMonthlyPayrollPushStatus: (
    id: number,
    target: MonthlyPayrollPushTarget,
    status: MonthlyPayrollPushStatus
  ): Promise<MonthlyPayrollRun> =>
    ipcRenderer.invoke('monthly-payroll:update-push-status', id, target, status),
  deleteMonthlyPayrollRun: (id: number): Promise<boolean> =>
    ipcRenderer.invoke('monthly-payroll:delete-run', id),
  archiveMonthlyPayrollRun: (id: number): Promise<MonthlyPayrollArchiveResult> =>
    ipcRenderer.invoke('monthly-payroll:archive-run', id),
  cancelMonthlyPayrollMonthClose: (id: number): Promise<MonthlyPayrollRun> =>
    ipcRenderer.invoke('monthly-payroll:cancel-month-close', id),
  getMonthlyPayrollRunReport: (id: number): Promise<MonthlyPayrollReportResult | null> =>
    ipcRenderer.invoke('monthly-payroll:get-run-report', id),
  printSalaryWorkbookViaExcel: (request: {
    salaryWorkbookPath: string
    salaryWorkbookFallbackPaths?: string[]
    taxWorkbookPath?: string
    printerName?: string
    invoicePaperName?: string
  }): Promise<void> => ipcRenderer.invoke('monthly-payroll:print-salary-via-excel', request),
  getSalaryWorkbookPrintPageSummary: (request: {
    salaryWorkbookPath: string
    salaryWorkbookFallbackPaths?: string[]
    taxWorkbookPath?: string
    printerName?: string
    invoicePaperName?: string
  }): Promise<MonthlyPayrollSalaryPrintPageSummary> =>
    ipcRenderer.invoke('monthly-payroll:salary-print-page-summary', request),
  chooseAnnualAdjustmentFiles: (
    request: AnnualAdjustmentChooseFilesRequest
  ): Promise<AnnualAdjustmentFilePick[] | null> =>
    ipcRenderer.invoke('annual-adjustment:choose-files', request),
  previewAnnualAdjustment: (
    input: AnnualAdjustmentPreviewInput
  ): Promise<AnnualAdjustmentPreview> => ipcRenderer.invoke('annual-adjustment:preview', input),
  applyAnnualAdjustment: (
    input: AnnualAdjustmentApplyInput
  ): Promise<AnnualAdjustmentApplyResult> => ipcRenderer.invoke('annual-adjustment:apply', input),
  generatePersonalTaxImport: (
    input: PersonalTaxImportGenerateInput
  ): Promise<PersonalTaxImportGenerateResult> =>
    ipcRenderer.invoke('personal-tax:generate-import', input),
  exportSocialInsuranceBase: (
    input: SocialInsuranceBaseExportInput
  ): Promise<SocialInsuranceBaseExportResult> =>
    ipcRenderer.invoke('social-insurance:export-base', input),
  generatePerformancePayroll: (
    input: PerformancePayrollGenerateInput
  ): Promise<PerformancePayrollGenerateResult> =>
    ipcRenderer.invoke('performance-payroll:generate', input),
  generatePerformancePayrollFromHistory: (
    input: PerformancePayrollHistoryGenerateInput
  ): Promise<PerformancePayrollGenerateResult> =>
    ipcRenderer.invoke('performance-payroll:generate-from-history', input),
  generatePerformancePayrollFromLocal: (
    input: PerformancePayrollLocalGenerateInput
  ): Promise<PerformancePayrollGenerateResult> =>
    ipcRenderer.invoke('performance-payroll:generate-from-local', input),
  openLocalPath: (path: string): Promise<string> => ipcRenderer.invoke('app:open-path', path),
  appendPushLog: (line: string): Promise<void> => ipcRenderer.invoke('push-log:append', line),
  openPushLogFolder: (): Promise<string> => ipcRenderer.invoke('push-log:open-folder'),
  listPrinters: (): Promise<PrinterSummary[]> => ipcRenderer.invoke('print:list-printers'),
  printCurrentView: (request?: PrintRequest): Promise<void> =>
    ipcRenderer.invoke('print:current-view', request ?? {}),
  getMonthlyPayrollPrintSettings: (): Promise<MonthlyPayrollPrintSettings> =>
    ipcRenderer.invoke('monthly-payroll:print-settings:get'),
  setMonthlyPayrollPrintSettings: (
    settings: MonthlyPayrollPrintSettings
  ): Promise<MonthlyPayrollPrintSettings> =>
    ipcRenderer.invoke('monthly-payroll:print-settings:set', settings),

  listWorksheetRecords: (
    worksheetId: string,
    query?: WorksheetRecordsQuery
  ): Promise<WorksheetRecordsResult> =>
    ipcRenderer.invoke('worksheet:list-records', worksheetId, query),
  createWorksheetRecord: (
    worksheetId: string,
    values: Record<string, WorksheetRecordValue>
  ): Promise<WorksheetMutationResult & { recordId: number }> =>
    ipcRenderer.invoke('worksheet:create-record', worksheetId, values),
  updateWorksheetRecord: (
    worksheetId: string,
    recordId: number,
    values: Record<string, WorksheetRecordValue>
  ): Promise<WorksheetMutationResult> =>
    ipcRenderer.invoke('worksheet:update-record', worksheetId, recordId, values),
  deleteWorksheetRecord: (
    worksheetId: string,
    recordId: number
  ): Promise<WorksheetMutationResult> =>
    ipcRenderer.invoke('worksheet:delete-record', worksheetId, recordId),
  deleteWorksheetRecords: (
    worksheetId: string,
    recordIds: number[]
  ): Promise<WorksheetMutationResult> =>
    ipcRenderer.invoke('worksheet:delete-records', worksheetId, recordIds),
  clearWorksheet: (worksheetId: string): Promise<WorksheetMutationResult> =>
    ipcRenderer.invoke('worksheet:clear', worksheetId),
  listPersonnelChildRecords: (
    idCardValue: string
  ): Promise<Array<{ worksheetName: string; fields: Array<{ name: string; columnName: string }>; rows: Record<string, unknown>[] }>> =>
    ipcRenderer.invoke('worksheet:personnel-child-records', idCardValue),
  exportWorksheet: (
    worksheetId: string,
    view?: string
  ): Promise<{ filePath: string; rowCount: number } | null> =>
    ipcRenderer.invoke('worksheet:export', worksheetId, view),
  wipeAllData: (): Promise<{ tables: number; rows: number }> =>
    ipcRenderer.invoke('system:wipe-all'),
  listRecycleBinBatches: (limit?: number): Promise<RecycleBinBatch[]> =>
    ipcRenderer.invoke('recycle-bin:list-batches', limit),
  listRecycleBinRecords: (batchId: number, limit?: number): Promise<RecycleBinRecord[]> =>
    ipcRenderer.invoke('recycle-bin:list-records', batchId, limit),
  restoreRecycleBinBatch: (batchId: number): Promise<RecycleBinRestoreResult> =>
    ipcRenderer.invoke('recycle-bin:restore-batch', batchId),
  saveWorksheetFields: (worksheetId: string, fields: WorksheetField[]): Promise<AppSummary> =>
    ipcRenderer.invoke('worksheet:save-fields', worksheetId, fields),

  chooseImportFile: (): Promise<{ filePath: string; fileName: string } | null> =>
    ipcRenderer.invoke('import:choose-file'),
  previewImport: (filePath: string, worksheetId?: string): Promise<ImportPreview> =>
    ipcRenderer.invoke('import:preview', filePath, worksheetId),
  commitImport: (
    filePath: string,
    worksheetId: string,
    options?: { confirmUpdates?: boolean }
  ): Promise<ImportBatchSummary> =>
    ipcRenderer.invoke('import:commit', filePath, worksheetId, options),
  listImportBatches: (limit?: number): Promise<ImportBatchSummary[]> =>
    ipcRenderer.invoke('import:list-batches', limit),
  previewHrMasterSyncFromIntegrated: (): Promise<HrMasterSyncPreview> =>
    ipcRenderer.invoke('hr-master-sync:preview-integrated'),
  applyHrMasterSyncFromIntegrated: (
    selections?: MasterSyncSelectionItem[]
  ): Promise<HrMasterSyncApplyResult> =>
    ipcRenderer.invoke('hr-master-sync:apply-integrated', selections),
  previewBudgetActiveMasterSync: (): Promise<BudgetActiveMasterSyncPreview> =>
    ipcRenderer.invoke('budget-active-sync:preview-master'),
  applyBudgetActiveMasterSync: (
    selections?: MasterSyncSelectionItem[]
  ): Promise<BudgetActiveMasterSyncApplyResult> =>
    ipcRenderer.invoke('budget-active-sync:apply-master', selections),
  previewTeacherDetailMasterSync: (): Promise<TeacherDetailMasterSyncPreview> =>
    ipcRenderer.invoke('teacher-detail-sync:preview-master'),
  applyTeacherDetailMasterSync: (
    selections?: MasterSyncSelectionItem[]
  ): Promise<TeacherDetailMasterSyncApplyResult> =>
    ipcRenderer.invoke('teacher-detail-sync:apply-master', selections),
  fillTownshipIdCardsByHrName: (): Promise<TownshipIdCardFillResult> =>
    ipcRenderer.invoke('township-sync:fill-id-cards'),
  previewTownshipMasterSync: (): Promise<TownshipMasterSyncPreview> =>
    ipcRenderer.invoke('township-sync:preview-master'),
  applyTownshipMasterSync: (
    selections?: MasterSyncSelectionItem[]
  ): Promise<TownshipMasterSyncApplyResult> =>
    ipcRenderer.invoke('township-sync:apply-master', selections),
  rollbackImportBatch: (batchId: number): Promise<ImportBatchSummary> =>
    ipcRenderer.invoke('import:rollback-batch', batchId),

  listBackups: (): Promise<BackupSummary[]> => ipcRenderer.invoke('backup:list'),
  createBackup: (): Promise<BackupSummary> => ipcRenderer.invoke('backup:create'),
  restoreBackup: (fileName: string): Promise<BackupSummary> =>
    ipcRenderer.invoke('backup:restore', fileName),

  listPivotConfigs: (): Promise<PivotConfigSummary[]> =>
    ipcRenderer.invoke('pivot:list-configs'),
  getPivotConfig: (id: number): Promise<PivotConfig | undefined> =>
    ipcRenderer.invoke('pivot:get-config', id),
  savePivotConfig: (config: PivotConfig): Promise<PivotConfig> =>
    ipcRenderer.invoke('pivot:save-config', config),
  deletePivotConfig: (id: number): Promise<void> =>
    ipcRenderer.invoke('pivot:delete-config', id),
  runPivot: (config: PivotConfig): Promise<PivotResult> =>
    ipcRenderer.invoke('pivot:run', config),
  exportPivot: (
    config: PivotConfig,
    defaultName: string
  ): Promise<{ filePath: string; rowCount: number } | null> =>
    ipcRenderer.invoke('pivot:export', config, defaultName),
  detectIdCardField: (worksheetId: string): Promise<string | undefined> =>
    ipcRenderer.invoke('pivot:detect-id-card', worksheetId),

  listLookupFailures: (
    query?: LookupFailureQuery
  ): Promise<{ total: number; rows: LookupFailureEntry[] }> =>
    ipcRenderer.invoke('archive:list-lookup-failures', query ?? {}),

  listStatReports: (): Promise<StatReportDef[]> => ipcRenderer.invoke('stat-report:list'),
  runStatReport: (id: string): Promise<StatReportResult> =>
    ipcRenderer.invoke('stat-report:run', id),
  exportStatReport: (
    result: StatReportResult
  ): Promise<{ filePath: string; rowCount: number }> =>
    ipcRenderer.invoke('stat-report:export', result),
  drillStatReport: (
    filters: StatReportFilterClause[],
    filterDesc: string,
    columnKey?: string,
    columnLabel?: string
  ): Promise<StatReportDrillResult> =>
    ipcRenderer.invoke('stat-report:drill', filters, filterDesc, columnKey, columnLabel),

  // === 邮件附件下载 ===
  listMailAccounts: (): Promise<MailAccountView[]> =>
    ipcRenderer.invoke('mail:account-list'),
  saveMailAccount: (data: Partial<MailAccount> & { authCodeEncrypted: string }): Promise<MailAccountView> =>
    ipcRenderer.invoke('mail:account-save', data),
  deleteMailAccount: (id: number): Promise<void> =>
    ipcRenderer.invoke('mail:account-delete', id),
  testMailAccount: (data: { imapHost: string; imapPort: number; username: string; authCodeEncrypted: string }): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('mail:account-test', data),

  listMailRules: (accountId?: number): Promise<MailDownloadRule[]> =>
    ipcRenderer.invoke('mail:rule-list', accountId),
  saveMailRule: (data: Partial<MailDownloadRule> & { accountId: number }): Promise<MailDownloadRule> =>
    ipcRenderer.invoke('mail:rule-save', data),
  deleteMailRule: (id: number): Promise<void> =>
    ipcRenderer.invoke('mail:rule-delete', id),

  listMailFolders: (accountId: number): Promise<string[]> =>
    ipcRenderer.invoke('mail:folder-list', accountId),

  startMailCheck: (request?: { accountId?: number; daysBack?: number }): Promise<{ ok: boolean; reason?: string; downloadedCount?: number; skippedCount?: number; errorCount?: number }> =>
    ipcRenderer.invoke('mail:check', request ?? {}),
  stopMailCheck: (): Promise<void> =>
    ipcRenderer.invoke('mail:check-stop'),

  onMailCheckProgress: (handler: (progress: MailCheckProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: MailCheckProgress): void => handler(progress)
    ipcRenderer.on('mail:check-progress', listener)
    return () => { ipcRenderer.removeListener('mail:check-progress', listener) }
  },

  listMailLogs: (accountId?: number, level?: string, limit?: number, offset?: number): Promise<MailDownloadLog[]> =>
    ipcRenderer.invoke('mail:log-list', accountId, level, limit, offset),
  clearMailLogs: (accountId?: number): Promise<number> =>
    ipcRenderer.invoke('mail:log-clear', accountId),

  chooseMailDir: (): Promise<string | null> =>
    ipcRenderer.invoke('mail:choose-dir'),
  openMailDir: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke('mail:open-dir', dirPath),

  listMailRecords: (limit?: number, offset?: number): Promise<MailDownloadRecord[]> =>
    ipcRenderer.invoke('mail:record-list', limit, offset),

  clearMailRecords: (accountId?: number): Promise<number> =>
    ipcRenderer.invoke('mail:record-clear', accountId)
}

contextBridge.exposeInMainWorld('salaryApi', salaryApi)

export type SalaryApi = typeof salaryApi
