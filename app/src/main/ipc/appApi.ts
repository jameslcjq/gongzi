import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { getDatabase, getDatabasePath, run } from '../db/connection'
import { readWorksheetMetadata } from '../db/metadata'
import { createBackup, listBackups, restoreBackup } from '../services/backup'
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
  startExcelImportWatcher,
  stopExcelImportWatcher
} from '../services/excelImportWatcher'
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
  clearLookupFailures,
  listLookupFailures,
  listPersonnelArchive,
  type ArchiveQuery,
  type LookupFailureQuery
} from '../services/budget/archiveQueries'
import { listWorkflows, runWorkflow } from '../services/workflowRegistry'
import {
  archiveMonthlyPayrollRun,
  cancelMonthlyPayrollMonthClose,
  deleteMonthlyPayrollRun,
  generateMonthlyPayrollReportView,
  getMonthlyPayrollRunReport,
  listMonthlyPayrollRuns
} from '../services/monthly-payroll/monthlyPayroll'
import { printSalaryWorkbookViaExcel } from '../services/monthly-payroll/printSalaryViaExcel'
import { readUnitSettings, writeUnitSettings } from '../services/unitSettings'
import {
  readMonthlyPayrollPrintSettings,
  writeMonthlyPayrollPrintSettings
} from '../services/printSettings'
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
  PersonnelArchiveEntry,
  MonthlyPayrollRun,
  MonthlyPayrollPrintSettings,
  PrintRequest,
  PrinterSummary,
  UnitSettings
} from '../../shared/types'

export function registerAppIpc(): void {
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

  ipcMain.handle('import-watcher:start', (): Promise<ImportWatcherStatus> => {
    return startExcelImportWatcher()
  })

  ipcMain.handle('import-watcher:stop', (): Promise<ImportWatcherStatus> => {
    return stopExcelImportWatcher()
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

  ipcMain.handle('integration:open-external', async (_event, url: string): Promise<void> => {
    await shell.openExternal(url)
  })

  ipcMain.handle('app:open-path', async (_event, path: string): Promise<string> => {
    return shell.openPath(path)
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
            margins: { marginType: 'none' }
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
        taxWorkbookPath?: string
        printerName?: string
        invoicePaperName?: string
      }
    ): Promise<void> => {
      await printSalaryWorkbookViaExcel(request)
    }
  )

  ipcMain.handle('unit-settings:get', (): Promise<UnitSettings> => readUnitSettings())

  ipcMain.handle(
    'unit-settings:set',
    (_event, settings: UnitSettings): Promise<UnitSettings> => writeUnitSettings(settings)
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
    (_event, filePath: string, worksheetId: string): Promise<ImportBatchSummary> => {
      return commitExcelImport(filePath, worksheetId)
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
  ipcMain.handle('backup:create', (): Promise<BackupSummary> => createBackup())
  ipcMain.handle(
    'backup:restore',
    (_event, fileName: string): Promise<BackupSummary> => restoreBackup(fileName)
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
    'archive:list-personnel',
    (_event, query: ArchiveQuery = {}): Promise<{
      total: number
      rows: PersonnelArchiveEntry[]
    }> => listPersonnelArchive(query)
  )

  ipcMain.handle(
    'archive:list-lookup-failures',
    (_event, query: LookupFailureQuery = {}): Promise<{
      total: number
      rows: LookupFailureEntry[]
    }> => listLookupFailures(query)
  )

  ipcMain.handle(
    'archive:clear-lookup-failures',
    (_event, workflow?: string): Promise<number> => clearLookupFailures(workflow)
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
  if (item.name === '\u4e00\u4f53\u5316\u5728\u804c') {
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
