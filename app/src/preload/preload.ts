import { contextBridge, ipcRenderer } from 'electron'
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
  LookupFailureEntry,
  PersonnelArchiveEntry,
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
  MonthlyPayrollPrintSettings,
  PrintRequest,
  PrinterSummary,
  UnitSettings
} from '../shared/types'

type PivotConfigSummary = {
  id: number
  name: string
  primaryWorksheetId: string
  primaryWorksheetName: string
  createdAt: string
  updatedAt: string
}

type ArchiveQuery = {
  archiveType?: string
  sourceWorksheet?: string
  search?: string
  limit?: number
  offset?: number
}

type LookupFailureQuery = {
  workflow?: string
  worksheet?: string
  search?: string
  limit?: number
  offset?: number
}

const salaryApi = {
  getSummary: (): Promise<AppSummary> => ipcRenderer.invoke('app:get-summary'),
  runConsistencyAudit: (): Promise<ConsistencyAuditResult> =>
    ipcRenderer.invoke('consistency-audit:run'),
  applyConsistencyAudit: (
    direction: ConsistencyAuditApplyDirection,
    issues: ConsistencyAuditIssue[]
  ): Promise<ConsistencyAuditApplyResult> =>
    ipcRenderer.invoke('consistency-audit:apply', direction, issues),

  getImportWatcherStatus: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:get-status'),
  startImportWatcher: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:start'),
  stopImportWatcher: (): Promise<ImportWatcherStatus> => ipcRenderer.invoke('import-watcher:stop'),
  chooseImportWatcherFolder: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:choose-folder'),
  openImportWatcherFolder: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:open-folder'),
  clearImportWatcherLogs: (): Promise<ImportWatcherStatus> =>
    ipcRenderer.invoke('import-watcher:clear-logs'),

  listWorkflows: (): Promise<WorkflowDefinition[]> => ipcRenderer.invoke('app:list-workflows'),
  runWorkflow: (workflowKey: string, payload?: WorkflowRunPayload): Promise<WorkflowRunResult> =>
    ipcRenderer.invoke('app:run-workflow', workflowKey, payload),
  generateMonthlyPayrollReportView: (
    payload?: WorkflowRunPayload
  ): Promise<MonthlyPayrollReportResult> =>
    ipcRenderer.invoke('monthly-payroll:generate-report-view', payload),
  openIntegrationExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('integration:open-external', url),
  getUnitSettings: (): Promise<UnitSettings> => ipcRenderer.invoke('unit-settings:get'),
  setUnitSettings: (settings: UnitSettings): Promise<UnitSettings> =>
    ipcRenderer.invoke('unit-settings:set', settings),
  listMonthlyPayrollRuns: (): Promise<MonthlyPayrollRun[]> =>
    ipcRenderer.invoke('monthly-payroll:list-runs'),
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
    taxWorkbookPath?: string
    printerName?: string
    invoicePaperName?: string
  }): Promise<void> => ipcRenderer.invoke('monthly-payroll:print-salary-via-excel', request),
  openLocalPath: (path: string): Promise<string> => ipcRenderer.invoke('app:open-path', path),
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
  saveWorksheetFields: (worksheetId: string, fields: WorksheetField[]): Promise<AppSummary> =>
    ipcRenderer.invoke('worksheet:save-fields', worksheetId, fields),

  chooseImportFile: (): Promise<{ filePath: string; fileName: string } | null> =>
    ipcRenderer.invoke('import:choose-file'),
  previewImport: (filePath: string, worksheetId?: string): Promise<ImportPreview> =>
    ipcRenderer.invoke('import:preview', filePath, worksheetId),
  commitImport: (filePath: string, worksheetId: string): Promise<ImportBatchSummary> =>
    ipcRenderer.invoke('import:commit', filePath, worksheetId),
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

  listPersonnelArchive: (
    query?: ArchiveQuery
  ): Promise<{ total: number; rows: PersonnelArchiveEntry[] }> =>
    ipcRenderer.invoke('archive:list-personnel', query ?? {}),
  listLookupFailures: (
    query?: LookupFailureQuery
  ): Promise<{ total: number; rows: LookupFailureEntry[] }> =>
    ipcRenderer.invoke('archive:list-lookup-failures', query ?? {}),
  clearLookupFailures: (workflow?: string): Promise<number> =>
    ipcRenderer.invoke('archive:clear-lookup-failures', workflow),

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
    ipcRenderer.invoke('stat-report:drill', filters, filterDesc, columnKey, columnLabel)
}

contextBridge.exposeInMainWorld('salaryApi', salaryApi)

export type SalaryApi = typeof salaryApi
