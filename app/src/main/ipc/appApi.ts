import { app, ipcMain as electronIpcMain, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron'
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
  startExcelImportWatcher
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
  listLookupFailures,
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
import {
  getSalaryWorkbookPrintPageSummary,
  printSalaryWorkbookViaExcel
} from '../services/monthly-payroll/printSalaryViaExcel'
import {
  loadIntegratedActiveAggregates,
  loadIntegratedSimpleAggregates
} from '../services/monthly-payroll/monthlyPayrollDataLoaders'
import {
  applyAnnualAdjustment,
  chooseAnnualAdjustmentFiles,
  exportSocialInsuranceBaseWorkbook,
  generatePersonalTaxImportWorkbook,
  previewAnnualAdjustment
} from '../services/annualAdjustment'
import {
  generatePerformancePayroll,
  generatePerformancePayrollFromHistory,
  generatePerformancePayrollFromLocal
} from '../services/performancePayroll'
import { getUnitSettingsLockState, readUnitSettings, writeUnitSettings } from '../services/unitSettings'
import { resolveSchoolUnitSettings } from '../services/schoolLookup'
import {
  readMonthlyPayrollPrintSettings,
  writeMonthlyPayrollPrintSettings
} from '../services/printSettings'
import {
  readMonthlyPayrollSettings,
  writeMonthlyPayrollSettings
} from '../services/monthly-payroll/monthlyPayrollSettings'
import { getCachedLicenseStatus } from '../services/licenseService'
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
  MonthlyPayrollSalaryPrintPageSummary,
  MonthlyPayrollPrintSettings,
  MonthlyPayrollSettings,
  PrintRequest,
  PrinterSummary,
  UnitSettings,
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
  PersonnelExpensePlanPrefillResult,
  LocalFileBase64,
  SalaryQuotaMatchLocalSummary,
  SocialInsuranceBaseExportInput,
  SocialInsuranceBaseExportResult
} from '../../shared/types'

const LICENSE_FREE_CHANNELS = new Set([
  'app:get-version',
  'app:get-summary',
  'app:list-workflows',
  'import-watcher:get-status',
  'import-watcher:choose-folder',
  'import-watcher:open-folder',
  'import-watcher:clear-logs',
  'unit-settings:get',
  'unit-settings:lock-state',
  'unit-settings:set',
  'unit-settings:resolve-school',
  'backup:list',
  'monthly-payroll:list-runs'
])

async function assertLicenseForChannel(channel: string): Promise<void> {
  if (LICENSE_FREE_CHANNELS.has(channel)) return
  const status = await getCachedLicenseStatus()
  if (status.valid) return
  throw new Error(status.message || '授权无效，请先完成授权校验')
}

function createLicensedIpcMain(): Pick<IpcMain, 'handle'> {
  return {
    handle(channel, listener) {
      electronIpcMain.handle(channel, async (event, ...args) => {
        await assertLicenseForChannel(channel)
        return listener(event, ...args)
      })
    }
  }
}

export function registerAppIpc(): void {
  const ipcMain = createLicensedIpcMain()

  ipcMain.handle('app:get-version', (): string => app.getVersion())

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
    'personnel-expense-plan:prefill',
    async (): Promise<PersonnelExpensePlanPrefillResult> => {
      const status = await getImportWatcherStatus()
      return readPersonnelExpensePlanPrefill(status.folderPath)
    }
  )

  ipcMain.handle(
    'salary-quota-match:local-summary',
    async (): Promise<SalaryQuotaMatchLocalSummary> => {
      try {
        const [active, retired, other] = await Promise.all([
          loadIntegratedActiveAggregates(),
          loadIntegratedSimpleAggregates('一体化退休'),
          loadIntegratedSimpleAggregates('一体化其他')
        ])
        return {
          ok: true,
          activeOtherOneTotal: active.其他一,
          activeBasicPerformanceTotal: active.基础性绩效,
          retiredHousingTotal: retired.住房补贴,
          retiredActualPayTotal: retired.实发合计,
          otherActualPayTotal: other.实发合计
        }
      } catch (error) {
        return {
          ok: false,
          activeOtherOneTotal: 0,
          activeBasicPerformanceTotal: 0,
          retiredHousingTotal: 0,
          retiredActualPayTotal: 0,
          otherActualPayTotal: 0,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
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

  ipcMain.handle('integration:open-external', async (_event, url: string): Promise<void> => {
    await shell.openExternal(url)
  })

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
    'integration:save-recording',
    async (
      _event,
      payload: { json: string; defaultFileName?: string }
    ): Promise<{ ok: true; path: string } | { ok: false; reason: string; canceled?: boolean }> => {
      try {
        const { dialog } = await import('electron')
        const { writeFileSync } = await import('node:fs')
        const def = payload.defaultFileName || `一体化录制_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
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
            pageRanges: request.pageRanges,
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
