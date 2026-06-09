import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import * as XLSX from 'xlsx'
import { all, getDatabase, run } from '../../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../../db/schema'
import { getPeriodOutputPath } from '../../config/paths'
import type {
  MonthlyPayrollArchiveResult,
  MonthlyPayrollDataSourceMode,
  MonthlyPayrollExchangeStatus,
  MonthlyPayrollPushGuardResult,
  MonthlyPayrollPushStatus,
  MonthlyPayrollPushTarget,
  MonthlyPayrollReportResult,
  MonthlyPayrollReportSheet,
  MonthlyPayrollRun,
  MonthlyPayrollVoucherPageCounts,
  MonthlyPayrollWorkflowInput,
  SalaryQuotaMatchLocalSummary
} from '../../../shared/types'
import { normalizeMonthlyPayrollTaxField } from './monthlyPayrollSettings'
import { readMonthlyPayrollPrintSettings } from '../printSettings'
import { getSalaryWorkbookPrintPageSummary } from './printSalaryViaExcel'
import { createOperationBatch, logFileOperation, logRecordSnapshots, logRowsBeforeDelete } from '../operationLog'
import { getWorksheetByName } from '../worksheetTable'
import { applyTaxAndRecomputeIntegratedActive, recomputeIntegratedOtherLikeWorksheet } from './integratedPayroll'

export type MonthlyPayrollRunInput = Omit<
  MonthlyPayrollRun,
  | 'id'
  | 'createdAt'
  | 'archivedAt'
  | 'archiveDir'
  | 'archiveManifest'
  | 'isOutdated'
  | 'outdatedAt'
  | 'outdatedReason'
  | 'insurancePushStatus'
  | 'voucherPushStatus'
  | 'salaryPushStatus'
  | 'insurancePushedAt'
  | 'voucherPushedAt'
  | 'salaryPushedAt'
  | 'exchangePackageId'
  | 'exchangePackageStatus'
  | 'exchangeReceiptId'
  | 'exchangeReceiptAt'
  | 'exchangeReceiptPath'
>

const monthCloseAdjustmentWorksheetNames = ['在职工资', '退休工资', '其他工资'] as const
const monthCloseAdjustmentFieldNames = ['补发工资', '补扣工资'] as const

export async function persistMonthlyPayrollRun(payload: MonthlyPayrollRunInput): Promise<void> {
  const database = await getDatabase()
  const outdatedAt = new Date().toISOString()
  // 同月重新生成不是覆盖旧记录，而是标记旧结果过期，便于追溯并提醒已推送结果需要重推。
  const oldRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
      WHERE year = ? AND month = ? AND archived_at IS NULL AND is_outdated = 0`,
    [payload.year, payload.month]
  )
  const oldRuns = oldRows.map(mapRunRow)
  await run(
    database,
    `UPDATE monthly_payroll_runs
        SET is_outdated = 1,
            outdated_at = COALESCE(outdated_at, ?),
            outdated_reason = COALESCE(outdated_reason, ?),
            insurance_push_status = CASE WHEN insurance_push_status = 'success' THEN 'needs-repush' ELSE insurance_push_status END,
            voucher_push_status = CASE WHEN voucher_push_status = 'success' THEN 'needs-repush' ELSE voucher_push_status END,
            salary_push_status = CASE WHEN salary_push_status = 'success' THEN 'needs-repush' ELSE salary_push_status END
      WHERE year = ? AND month = ? AND archived_at IS NULL AND is_outdated = 0`,
    [
      outdatedAt,
      '同月已重新生成工资报账结果',
      payload.year,
      payload.month
    ]
  )
  const outdatedRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
      WHERE year = ? AND month = ? AND archived_at IS NULL AND is_outdated = 1`,
    [payload.year, payload.month]
  )
  const outdatedRuns = outdatedRows.map(mapRunRow)
  if (outdatedRuns.length > 0) {
    const batchId = await createOperationBatch(database, {
      kind: 'monthly-payroll.replace-generated-files',
      targetType: 'monthly-payroll',
      targetName: `${payload.year}-${String(payload.month).padStart(2, '0')}`,
      reason: '同月重新生成工资报账结果，清理旧导出文件',
      meta: { year: payload.year, month: payload.month, replacedRunIds: oldRuns.map((run) => run.id) }
    })
    await cleanupMonthlyPayrollGeneratedFiles(database, batchId, outdatedRuns)
    await run(
      database,
      `UPDATE monthly_payroll_runs
          SET insurance_import_path = NULL,
              salary_import_path = NULL,
              payroll_backpay_path = NULL,
              voucher_import_path = NULL
        WHERE year = ? AND month = ? AND archived_at IS NULL AND is_outdated = 1`,
      [payload.year, payload.month]
    )
  }
  await run(
    database,
    `INSERT INTO monthly_payroll_runs (
      year, month, unit_full_name,
      active_count, survivor_count, retired_housing_count,
      salary_total, withholding_total, tax_total, actual_pay,
      active_actual_pay, survivor_actual_pay, retired_housing_actual_pay, retired_housing,
      source_salary_path, source_social_path, source_tax_path,
      insurance_import_path, voucher_import_path, salary_import_path, payroll_backpay_path,
      report_fingerprint, tax_field, data_source_mode, report_snapshot,
      quota_match_local_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.year,
      payload.month,
      payload.unitFullName,
      payload.activeCount,
      payload.survivorCount,
      payload.retiredHousingCount,
      payload.salaryTotal,
      payload.withholdingTotal,
      payload.taxTotal,
      payload.actualPay,
      payload.activeActualPay,
      payload.survivorActualPay,
      payload.retiredHousingActualPay,
      payload.retiredHousing,
      payload.sourceSalaryPath,
      payload.sourceSocialPath,
      payload.sourceTaxPath,
      payload.insuranceImportPath,
      payload.voucherImportPath,
      payload.salaryImportPath,
      payload.payrollBackpayPath,
      payload.reportFingerprint,
      payload.taxField,
      payload.dataSourceMode,
      payload.reportSnapshot ? JSON.stringify(payload.reportSnapshot) : null,
      payload.quotaMatchLocalSummary ? JSON.stringify(payload.quotaMatchLocalSummary) : null
    ]
  )
}

export async function listMonthlyPayrollRuns(): Promise<MonthlyPayrollRun[]> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT id, year, month, unit_full_name, active_count, survivor_count, retired_housing_count,
      salary_total, withholding_total, tax_total, actual_pay,
      active_actual_pay, survivor_actual_pay, retired_housing_actual_pay, retired_housing,
      source_salary_path, source_social_path, source_tax_path,
      insurance_import_path, voucher_import_path, salary_import_path, payroll_backpay_path,
      report_fingerprint, tax_field, data_source_mode, archived_at, archive_dir, archive_manifest,
      is_outdated, outdated_at, outdated_reason,
      insurance_push_status, voucher_push_status, salary_push_status,
      insurance_pushed_at, voucher_pushed_at, salary_pushed_at,
      exchange_package_id, exchange_package_status, exchange_receipt_id,
      exchange_receipt_at, exchange_receipt_path,
      report_snapshot,
      quota_match_local_summary,
      created_at
     FROM monthly_payroll_runs ORDER BY created_at DESC`
  )
  return rows.map(mapRunRow)
}

export async function archiveMonthlyPayrollRun(id: number): Promise<MonthlyPayrollArchiveResult> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  const runRow = rows[0]
  if (!runRow) throw new Error('未找到要月结的工资报账记录')

  const requestedRun = mapRunRow(runRow)
  if (requestedRun.archivedAt && requestedRun.archiveDir) {
    return {
      run: requestedRun,
      archiveDir: requestedRun.archiveDir,
      files: requestedRun.archiveManifest
    }
  }
  const archivedMonthRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
      WHERE year = ? AND month = ? AND archived_at IS NOT NULL
      ORDER BY archived_at DESC, created_at DESC LIMIT 1`,
    [requestedRun.year, requestedRun.month]
  )
  const archivedMonthRun = archivedMonthRows[0] ? mapRunRow(archivedMonthRows[0]) : null
  if (archivedMonthRun?.archiveDir) {
    return {
      run: archivedMonthRun,
      archiveDir: archivedMonthRun.archiveDir,
      files: archivedMonthRun.archiveManifest
    }
  }

  const finalRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
      WHERE year = ? AND month = ? AND archived_at IS NULL AND COALESCE(is_outdated, 0) = 0
      ORDER BY created_at DESC LIMIT 1`,
    [requestedRun.year, requestedRun.month]
  )
  const finalRun = finalRows[0] ? mapRunRow(finalRows[0]) : requestedRun
  if (!finalRun.sourceSocialPath || !finalRun.insuranceImportPath) {
    // 社保每月必办；只有工资阶段结果时不允许月结，避免把半成品锁成最终档案。
    throw new Error(`${finalRun.year}年${finalRun.month}月社保文件未补齐，当前只是工资阶段结果，不能月结。`)
  }
  const archiveDir = monthlyPayrollArchiveDir(finalRun)
  mkdirSync(archiveDir, { recursive: true })
  const archiveDate = dateStamp()
  const monthRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
     WHERE year = ? AND month = ? AND archived_at IS NULL`,
    [finalRun.year, finalRun.month]
  )
  const monthRuns = monthRows.map(mapRunRow)
  const outdatedRuns = monthRuns.filter((run) => run.id !== finalRun.id)
  const operationBatchId = await createOperationBatch(database, {
    kind: 'monthly-payroll.archive-month',
    targetType: 'monthly-payroll',
    targetName: `${finalRun.year}-${String(finalRun.month).padStart(2, '0')}`,
    reason: '工资报账月结归档',
    meta: { id: finalRun.id, requestedId: id, year: finalRun.year, month: finalRun.month, archiveDir }
  })
  await logRecordSnapshots(database, {
    batchId: operationBatchId,
    tableName: 'monthly_payroll_runs',
    action: 'archive',
    rows: monthRows
  })
  await cleanupMonthlyPayrollGeneratedFiles(database, operationBatchId, outdatedRuns)

  const [
    archivedOriginalSalaryPath,
    archivedSalaryPath,
    archivedSocialPath,
    archivedTaxPath,
    archivedInsuranceImportPath,
    archivedSalaryImportPath,
    archivedPayrollBackpayPath,
    archivedVoucherImportPath
  ] = await Promise.all([
    moveArchiveFile(
      database,
      operationBatchId,
      finalRun.reportSnapshot?.sourceSalaryOriginalPath ?? null,
      archiveDir,
      '原始工资表',
      archiveDate,
      finalRun.sourceSalaryPath ?? undefined
    ),
    moveArchiveFile(
      database,
      operationBatchId,
      finalRun.sourceSalaryPath,
      archiveDir,
      finalRun.reportSnapshot?.sourceSalaryOriginalPath ? '写入个税工资表' : '工资表',
      archiveDate
    ),
    moveArchiveFile(database, operationBatchId, finalRun.sourceSocialPath, archiveDir, '社保', archiveDate),
    moveArchiveFile(database, operationBatchId, finalRun.sourceTaxPath, archiveDir, '个税', archiveDate),
    moveArchiveFile(database, operationBatchId, finalRun.insuranceImportPath, archiveDir, '保险导入', archiveDate),
    moveArchiveFile(database, operationBatchId, finalRun.salaryImportPath, archiveDir, '工资导入', archiveDate),
    moveArchiveFile(database, operationBatchId, finalRun.payrollBackpayPath, archiveDir, '补发工资', archiveDate),
    moveArchiveFile(database, operationBatchId, finalRun.voucherImportPath, archiveDir, '凭证', archiveDate)
  ])
  const archivedFiles = [
    archivedOriginalSalaryPath,
    archivedSalaryPath,
    archivedSocialPath,
    archivedTaxPath,
    archivedInsuranceImportPath,
    archivedSalaryImportPath,
    archivedPayrollBackpayPath,
    archivedVoucherImportPath
  ].filter((item): item is string => Boolean(item))
  const archivedGeneratedPaths = {
    insuranceImportPath: archivedInsuranceImportPath ?? finalRun.insuranceImportPath,
    salaryImportPath: archivedSalaryImportPath ?? finalRun.salaryImportPath,
    payrollBackpayPath: archivedPayrollBackpayPath ?? finalRun.payrollBackpayPath,
    voucherImportPath: archivedVoucherImportPath ?? finalRun.voucherImportPath,
    sourceSalaryOriginalPath: archivedOriginalSalaryPath ?? finalRun.reportSnapshot?.sourceSalaryOriginalPath ?? null
  }

  const archivedAt = new Date().toISOString()
  const manifestPath = uniqueArchivePath(archiveDir, `工资报账月结_清单_${archiveDate}.json`)
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        year: finalRun.year,
        month: finalRun.month,
        unitFullName: finalRun.unitFullName,
        archivedAt,
        archiveDir,
        files: archivedFiles,
        totals: {
          activeCount: finalRun.activeCount,
          survivorCount: finalRun.survivorCount,
          retiredHousingCount: finalRun.retiredHousingCount,
          salaryTotal: finalRun.salaryTotal,
          withholdingTotal: finalRun.withholdingTotal,
          taxTotal: finalRun.taxTotal,
          actualPay: finalRun.actualPay,
          activeActualPay: finalRun.activeActualPay,
          survivorActualPay: finalRun.survivorActualPay,
          retiredHousingActualPay: finalRun.retiredHousingActualPay,
          retiredHousing: finalRun.retiredHousing
        }
      },
      null,
      2
    ),
    'utf8'
  )
  archivedFiles.push(manifestPath)

  await clearMonthCloseAdjustmentFields(database, operationBatchId)

  await run(
    database,
    `UPDATE monthly_payroll_runs
       SET archived_at = ?,
           archive_dir = ?,
           archive_manifest = ?,
           insurance_import_path = ?,
           salary_import_path = ?,
           payroll_backpay_path = ?,
           voucher_import_path = ?,
           report_snapshot = ?
     WHERE id = ?`,
    [
      archivedAt,
      archiveDir,
      JSON.stringify(archivedFiles),
      archivedGeneratedPaths.insuranceImportPath,
      archivedGeneratedPaths.salaryImportPath,
      archivedGeneratedPaths.payrollBackpayPath,
      archivedGeneratedPaths.voucherImportPath,
      stringifyReportSnapshotWithArchivePaths(finalRun.reportSnapshot, archivedGeneratedPaths),
      finalRun.id
    ]
  )
  await run(
    database,
    `UPDATE monthly_payroll_runs
        SET insurance_import_path = NULL,
            salary_import_path = NULL,
            payroll_backpay_path = NULL,
            voucher_import_path = NULL
      WHERE year = ? AND month = ? AND archived_at IS NULL AND is_outdated = 1`,
    [finalRun.year, finalRun.month]
  )

  const updatedRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [finalRun.id]
  )
  return {
    run: mapRunRow(updatedRows[0]),
    archiveDir,
    files: archivedFiles
  }
}

export async function cancelMonthlyPayrollMonthClose(id: number): Promise<MonthlyPayrollRun> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  if (!rows[0]) throw new Error('未找到要取消月结的工资报账记录')
  const targetRun = mapRunRow(rows[0])
  const monthRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
     WHERE year = ? AND month = ? AND archived_at IS NOT NULL`,
    [targetRun.year, targetRun.month]
  )
  const monthRunList = monthRows.map(mapRunRow)
  const operationBatchId = await createOperationBatch(database, {
    kind: 'monthly-payroll.cancel-month-close',
    targetType: 'monthly-payroll',
    targetName: `${targetRun.year}-${String(targetRun.month).padStart(2, '0')}`,
    reason: '取消月结并清理生成文件',
    meta: { id, year: targetRun.year, month: targetRun.month }
  })
  await logRecordSnapshots(database, {
    batchId: operationBatchId,
    tableName: 'monthly_payroll_runs',
    action: 'cancel-archive',
    rows: monthRows
  })
  await restoreMonthlyPayrollSourceFiles(monthRunList)
  await cleanupMonthlyPayrollGeneratedFiles(database, operationBatchId, monthRunList)
  await restoreMonthCloseAdjustmentFields(database, operationBatchId, targetRun.year, targetRun.month)

  await run(
    database,
    `UPDATE monthly_payroll_runs
       SET archived_at = NULL, archive_dir = NULL, archive_manifest = NULL,
           insurance_import_path = NULL, salary_import_path = NULL,
           payroll_backpay_path = NULL, voucher_import_path = NULL
     WHERE year = ? AND month = ?`,
    [targetRun.year, targetRun.month]
  )

  const updatedRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  return mapRunRow(updatedRows[0])
}

export async function deleteMonthlyPayrollRun(id: number): Promise<boolean> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  if (!rows.length) return false
  await run(database, 'BEGIN TRANSACTION')
  try {
    const batchId = await createOperationBatch(database, {
      kind: 'monthly-payroll.delete-run',
      targetType: 'monthly-payroll-run',
      targetName: String(id),
      reason: '删除工资报账历史记录',
      meta: { id }
    })
    await logRowsBeforeDelete(database, {
      batchId,
      tableName: 'monthly_payroll_runs',
      action: 'delete',
      whereSql: '"id" = ?',
      params: [id]
    })
    await run(database, `DELETE FROM monthly_payroll_runs WHERE id = ?`, [id])
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }
  return true
}

export async function updateMonthlyPayrollPushStatus(
  id: number,
  target: MonthlyPayrollPushTarget,
  status: MonthlyPayrollPushStatus
): Promise<MonthlyPayrollRun> {
  const database = await getDatabase()
  const columns: Record<MonthlyPayrollPushTarget, { status: string; pushedAt: string }> = {
    insurance: { status: 'insurance_push_status', pushedAt: 'insurance_pushed_at' },
    voucher: { status: 'voucher_push_status', pushedAt: 'voucher_pushed_at' },
    salary: { status: 'salary_push_status', pushedAt: 'salary_pushed_at' }
  }
  const { status: statusColumn, pushedAt: pushedAtColumn } = columns[target]
  const pushedAt = status === 'success' ? new Date().toISOString() : null
  await run(
    database,
    `UPDATE monthly_payroll_runs
        SET ${statusColumn} = ?,
            ${pushedAtColumn} = CASE WHEN ? IS NULL THEN ${pushedAtColumn} ELSE ? END
      WHERE id = ?`,
    [status, pushedAt, pushedAt, id]
  )
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  if (!rows[0]) throw new Error('未找到工资报账记录')
  return mapRunRow(rows[0])
}

export async function assertMonthlyPayrollRunPushable(
  id: number
): Promise<MonthlyPayrollPushGuardResult> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  if (!rows[0]) {
    return { ok: false, reason: '未找到工资报账记录' }
  }
  const run = mapRunRow(rows[0])
  if (run.isOutdated) {
    return { ok: false, reason: '这条报账记录已过期，请使用最新生成的记录重新推送' }
  }
  const reconciliation = run.reportSnapshot?.reconciliation ?? null
  if (!reconciliation) {
    return {
      ok: false,
      reason: '这条报账记录没有自动复核结果，请重新生成报表后再推送。',
      reconciliation
    }
  }
  if (reconciliation.status !== 'passed') {
    const firstIssue = reconciliation.issues.find((issue) => issue.severity === 'error') ??
      reconciliation.issues[0]
    return {
      ok: false,
      reason: firstIssue?.message ?? reconciliation.summary,
      reconciliation
    }
  }
  return { ok: true }
}

export async function getMonthlyPayrollRunReport(
  id: number
): Promise<MonthlyPayrollReportResult | null> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  const payrollRun = rows[0] ? mapRunRow(rows[0]) : null
  if (!payrollRun) return null
  if (payrollRun.reportSnapshot) {
    return ensureReportSnapshotVoucherPages(payrollRun, payrollRun.reportSnapshot)
  }

  const sheets = loadHistoryExportSheets(payrollRun)
  if (sheets.length === 0) return null
  return {
    ok: true,
    message: '该历史记录没有完整报表快照，已从已导出的文件恢复可查看表格',
    insuranceImportPath: payrollRun.insuranceImportPath ?? undefined,
    salaryImportPath: payrollRun.salaryImportPath ?? undefined,
    payrollBackpayPath: payrollRun.payrollBackpayPath ?? undefined,
    voucherImportPath: payrollRun.voucherImportPath ?? undefined,
    sheets
  }
}

export function resolvePayrollPeriod(input?: MonthlyPayrollWorkflowInput): { year: number; month: number } {
  const today = new Date()
  return {
    year: input?.year ?? today.getFullYear(),
    month: input?.month ?? today.getMonth() + 1
  }
}

export async function isMonthlyPayrollMonthArchived(year: number, month: number): Promise<boolean> {
  const database = await getDatabase()
  const rows = await all<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count
       FROM monthly_payroll_runs
      WHERE year = ? AND month = ? AND archived_at IS NOT NULL`,
    [year, month]
  )
  return (rows[0]?.count ?? 0) > 0
}

export function fingerprintReportSheets(sheets: MonthlyPayrollReportSheet[]): string {
  const stable = sheets
    .filter((sheet) => !FINGERPRINT_SKIP_SHEETS.has(sheet.name))
    .map((sheet) => ({
      name: sheet.name,
      columns: sheet.columns,
      rows: sheet.rows,
      showColumnHeader: sheet.showColumnHeader ?? true,
      merges: sheet.merges ?? [],
      columnWidths: sheet.columnWidths ?? [],
      rowHeights: sheet.rowHeights ?? []
    }))
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

export async function findSameMonthlyPayrollRun(
  year: number,
  month: number,
  reportFingerprint: string,
  dataSourceMode?: MonthlyPayrollDataSourceMode
): Promise<MonthlyPayrollRun | null> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
     WHERE year = ? AND month = ? AND report_fingerprint = ?
       AND COALESCE(data_source_mode, 'salary-workbook') = ?
       AND COALESCE(is_outdated, 0) = 0
     ORDER BY created_at DESC LIMIT 1`,
    [year, month, reportFingerprint, normalizeMonthlyPayrollDataSourceMode(dataSourceMode)]
  )
  return rows[0] ? mapRunRow(rows[0]) : null
}

export async function findMonthlyPayrollSourceSalaryOriginalPath(
  year: number,
  month: number,
  sourceSalaryPath: string
): Promise<string | null> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT report_snapshot
       FROM monthly_payroll_runs
      WHERE year = ? AND month = ? AND source_salary_path = ?
        AND report_snapshot IS NOT NULL
      ORDER BY created_at ASC LIMIT 20`,
    [year, month, sourceSalaryPath]
  )
  for (const row of rows) {
    const snapshot = parseReportSnapshot(row.report_snapshot)
    const originalPath = snapshot?.sourceSalaryOriginalPath
    if (originalPath && existsSync(originalPath)) return originalPath
  }
  return null
}

function loadHistoryExportSheets(run: MonthlyPayrollRun): MonthlyPayrollReportSheet[] {
  const sheets: MonthlyPayrollReportSheet[] = []
  if (run.voucherImportPath) sheets.push(...readExportWorkbookSheets(run.voucherImportPath, '凭证'))
  if (run.insuranceImportPath) sheets.push(...readExportWorkbookSheets(run.insuranceImportPath, '保险导入'))
  if (run.salaryImportPath) sheets.push(...readExportWorkbookSheets(run.salaryImportPath, '工资导入'))
  if (run.payrollBackpayPath) sheets.push(...readExportWorkbookSheets(run.payrollBackpayPath, '补发工资'))
  return sheets
}

async function ensureReportSnapshotVoucherPages(
  payrollRun: MonthlyPayrollRun,
  snapshot: MonthlyPayrollReportResult
): Promise<MonthlyPayrollReportResult> {
  const normalizedSnapshot: MonthlyPayrollReportResult = {
    ...snapshot,
    insuranceImportPath: snapshot.insuranceImportPath ?? payrollRun.insuranceImportPath ?? undefined,
    salaryImportPath: snapshot.salaryImportPath ?? payrollRun.salaryImportPath ?? undefined,
    payrollBackpayPath: snapshot.payrollBackpayPath ?? payrollRun.payrollBackpayPath ?? undefined,
    voucherImportPath: snapshot.voucherImportPath ?? payrollRun.voucherImportPath ?? undefined
  }
  if (normalizedSnapshot.voucherPageCounts && hasVoucherPageColumn(normalizedSnapshot.sheets)) {
    return normalizedSnapshot
  }
  const sheets = normalizedSnapshot.sheets.map((sheet) => ({
    ...sheet,
    columns: [...sheet.columns],
    rows: sheet.rows.map((row) => [...row])
  }))
  const voucherPageCounts = await buildSnapshotVoucherPageCounts(payrollRun, sheets)
  applyVoucherPageCounts(sheets, voucherPageCounts)
  const nextSnapshot: MonthlyPayrollReportResult = {
    ...normalizedSnapshot,
    voucherPageCounts,
    sheets
  }
  await saveReportSnapshot(payrollRun.id, nextSnapshot)
  return nextSnapshot
}

function hasVoucherPageColumn(sheets: MonthlyPayrollReportSheet[]): boolean {
  const sheet = sheets.find((item) => item.name === '报销凭证')
  return Boolean(sheet?.columns.includes(VOUCHER_ATTACHMENT_PAGES_COLUMN))
}

async function buildSnapshotVoucherPageCounts(
  payrollRun: MonthlyPayrollRun,
  sheets: MonthlyPayrollReportSheet[]
): Promise<MonthlyPayrollVoucherPageCounts> {
  let salaryWorkbookPages = 0
  let survivorWorkbookPages = 0
  if (payrollRun.sourceSalaryPath) {
    try {
      const printSettings = await readMonthlyPayrollPrintSettings()
      const summary = await getSalaryWorkbookPrintPageSummary({
        salaryWorkbookPath: payrollRun.sourceSalaryPath,
        salaryWorkbookFallbackPaths: archivedSalaryWorkbookPaths(payrollRun),
        taxWorkbookPath: payrollRun.sourceTaxPath ?? undefined,
        printerName: printSettings.reportPrinterName
      })
      salaryWorkbookPages = summary.items.find((item) => item.label === '工资表')?.pages ?? 0
      survivorWorkbookPages = summary.items
        .filter((item) => item.label === '遗补')
        .reduce((sum, item) => sum + item.pages, 0)
    } catch (error) {
      console.warn('历史报表补写工资表页数失败：', error)
    }
  }
  const retiredHousingPages = countRetiredHousingPrintPages(sheets)
  return {
    insuranceAttachmentPages: INSURANCE_VOUCHER_ATTACHMENT_PAGES,
    salaryWorkbookPages,
    survivorWorkbookPages,
    retiredHousingPages,
    salaryAttachmentPages: salaryWorkbookPages + survivorWorkbookPages + retiredHousingPages
  }
}

function archivedSalaryWorkbookPaths(payrollRun: MonthlyPayrollRun): string[] {
  if (!payrollRun.sourceSalaryPath) return []
  const sourceName = basename(payrollRun.sourceSalaryPath)
  return payrollRun.archiveManifest.filter((filePath) =>
    ['写入个税工资表', '工资表'].some((label) =>
      isArchivedFileForLabel(basename(filePath), label, sourceName)
    )
  )
}

function countRetiredHousingPrintPages(sheets: MonthlyPayrollReportSheet[]): number {
  const sheet = sheets.find((item) => RETIRED_HOUSING_REPORT_SHEET_NAMES.has(item.name))
  if (!sheet) return 0
  if (sheet.rows.length === 0) return 0
  if (sheet.rows.length <= 3) return 1
  const dataCount = Math.max(0, sheet.rows.length - 3)
  return Math.max(1, Math.ceil(dataCount / 20))
}

function applyVoucherPageCounts(
  sheets: MonthlyPayrollReportSheet[],
  counts: MonthlyPayrollVoucherPageCounts
): void {
  const sheet = sheets.find((item) => item.name === '报销凭证')
  if (!sheet) return
  let pageColumnIndex = sheet.columns.indexOf(VOUCHER_ATTACHMENT_PAGES_COLUMN)
  if (pageColumnIndex < 0) {
    sheet.columns.push(VOUCHER_ATTACHMENT_PAGES_COLUMN)
    pageColumnIndex = sheet.columns.length - 1
  }
  for (const row of sheet.rows) {
    row[pageColumnIndex] = isSalaryVoucherRow(row)
      ? counts.salaryAttachmentPages
      : counts.insuranceAttachmentPages
  }
}

function isSalaryVoucherRow(row: Array<string | number>): boolean {
  return String(row[0] ?? '').includes('工资')
}

async function saveReportSnapshot(id: number, snapshot: MonthlyPayrollReportResult): Promise<void> {
  const database = await getDatabase()
  await run(database, `UPDATE monthly_payroll_runs SET report_snapshot = ? WHERE id = ?`, [
    JSON.stringify(snapshot),
    id
  ])
}

function readExportWorkbookSheets(filePath: string, fallbackName: string): MonthlyPayrollReportSheet[] {
  if (!existsSync(filePath)) return []
  try {
    const workbook = XLSX.readFile(filePath, { cellDates: false })
    return workbook.SheetNames.flatMap((name, index) => {
      const worksheet = workbook.Sheets[name]
      if (!worksheet) return []
      const rows = XLSX.utils.sheet_to_json<Array<string | number>>(worksheet, {
        header: 1,
        defval: '',
        raw: false
      })
      if (rows.length === 0) return []
      const columns = rows[0].map((cell, columnIndex) => text(cell) || columnLabel(columnIndex))
      return [{
        name: index === 0 ? fallbackName : name,
        columns,
        rows: rows.slice(1).map((row) => row.map((cell) => {
          const value = text(cell)
          const numberText = value.replace(/,/g, '')
          return /^-?\d+(\.\d+)?$/.test(numberText) ? Number(numberText) : value
        }))
      }]
    })
  } catch {
    return []
  }
}

function mapRunRow(row: Record<string, unknown>): MonthlyPayrollRun {
  const reportSnapshot = parseReportSnapshot(row.report_snapshot)
  return {
    id: Number(row.id),
    year: Number(row.year),
    month: Number(row.month),
    unitFullName: String(row.unit_full_name ?? ''),
    activeCount: Number(row.active_count ?? 0),
    survivorCount: Number(row.survivor_count ?? 0),
    retiredHousingCount: Number(row.retired_housing_count ?? 0),
    salaryTotal: Number(row.salary_total ?? 0),
    withholdingTotal: Number(row.withholding_total ?? 0),
    taxTotal: Number(row.tax_total ?? 0),
    actualPay: Number(row.actual_pay ?? 0),
    activeActualPay: Number(row.active_actual_pay ?? 0) || Math.max(0, Number(row.actual_pay ?? 0) - Number(row.retired_housing ?? 0)),
    survivorActualPay: Number(row.survivor_actual_pay ?? 0),
    retiredHousingActualPay: Number(row.retired_housing_actual_pay ?? 0) || Number(row.retired_housing ?? 0),
    retiredHousing: Number(row.retired_housing ?? 0),
    sourceSalaryPath: (row.source_salary_path as string) ?? null,
    sourceSocialPath: (row.source_social_path as string) ?? null,
    sourceTaxPath: (row.source_tax_path as string) ?? null,
    insuranceImportPath: (row.insurance_import_path as string) ?? null,
    voucherImportPath: (row.voucher_import_path as string) ?? null,
    salaryImportPath: (row.salary_import_path as string) ?? null,
    payrollBackpayPath: (row.payroll_backpay_path as string) ?? null,
    reportFingerprint: (row.report_fingerprint as string) ?? null,
    taxField: row.tax_field ? normalizeMonthlyPayrollTaxField(row.tax_field) : null,
    dataSourceMode: normalizeMonthlyPayrollDataSourceMode(row.data_source_mode ?? reportSnapshot?.dataSourceMode),
    archivedAt: (row.archived_at as string) ?? null,
    archiveDir: (row.archive_dir as string) ?? null,
    archiveManifest: parseArchiveManifest(row.archive_manifest),
    reportSnapshot,
    isOutdated: Boolean(Number(row.is_outdated ?? 0)),
    outdatedAt: (row.outdated_at as string) ?? null,
    outdatedReason: (row.outdated_reason as string) ?? null,
    insurancePushStatus: normalizeMonthlyPayrollPushStatus(row.insurance_push_status),
    voucherPushStatus: normalizeMonthlyPayrollPushStatus(row.voucher_push_status),
    salaryPushStatus: normalizeMonthlyPayrollPushStatus(row.salary_push_status),
    insurancePushedAt: (row.insurance_pushed_at as string) ?? null,
    voucherPushedAt: (row.voucher_pushed_at as string) ?? null,
    salaryPushedAt: (row.salary_pushed_at as string) ?? null,
    exchangePackageId: (row.exchange_package_id as string) ?? null,
    exchangePackageStatus: normalizeMonthlyPayrollExchangeStatus(row.exchange_package_status),
    exchangeReceiptId: (row.exchange_receipt_id as string) ?? null,
    exchangeReceiptAt: (row.exchange_receipt_at as string) ?? null,
    exchangeReceiptPath: (row.exchange_receipt_path as string) ?? null,
    quotaMatchLocalSummary: parseQuotaMatchLocalSummary(row.quota_match_local_summary),
    createdAt: String(row.created_at ?? '')
  }
}

function parseQuotaMatchLocalSummary(value: unknown): SalaryQuotaMatchLocalSummary | null {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value) as SalaryQuotaMatchLocalSummary
  } catch {
    return null
  }
}

function normalizeMonthlyPayrollExchangeStatus(value: unknown): MonthlyPayrollExchangeStatus | null {
  if (
    value === 'package-built' ||
    value === 'copied-to-media' ||
    value === 'receipt-received' ||
    value === 'receipt-error'
  ) {
    return value
  }
  return null
}

function normalizeMonthlyPayrollPushStatus(value: unknown): MonthlyPayrollPushStatus {
  return value === 'queued' ||
    value === 'success' ||
    value === 'failed' ||
    value === 'needs-repush'
    ? value
    : 'not-pushed'
}

export function normalizeMonthlyPayrollDataSourceMode(
  value: unknown
): MonthlyPayrollDataSourceMode {
  return value === 'integrated' ? 'integrated' : 'salary-workbook'
}

function parseArchiveManifest(value: unknown): string[] {
  if (!value || typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseReportSnapshot(value: unknown): MonthlyPayrollReportResult | null {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value) as MonthlyPayrollReportResult
  } catch {
    return null
  }
}

function monthlyPayrollArchiveDir(run: MonthlyPayrollRun): string {
  return getPeriodOutputPath(run.year, run.month)
}

async function moveArchiveFile(
  database: Awaited<ReturnType<typeof getDatabase>>,
  batchId: number,
  sourcePath: string | null,
  targetDir: string,
  label: string,
  archiveDate: string,
  archiveNameSourcePath?: string
): Promise<string | null> {
  if (!sourcePath || !existsSync(sourcePath)) return null
  mkdirSync(targetDir, { recursive: true })
  const targetPath = uniqueArchivePath(
    targetDir,
    archiveFileName(label, archiveDate, archiveNameSourcePath ?? sourcePath)
  )
  await logFileOperation(database, {
    batchId,
    action: 'move-to-archive',
    filePath: sourcePath,
    fileLabel: label
  })
  try {
    await rename(sourcePath, targetPath)
  } catch {
    await copyFile(sourcePath, targetPath)
    await unlink(sourcePath)
  }
  return targetPath
}

function archiveFileName(label: string, archiveDate: string, sourcePath: string): string {
  return `工资报账月结_${label}_${archiveDate}_${basename(sourcePath)}`
}

function stringifyReportSnapshotWithArchivePaths(
  snapshot: MonthlyPayrollReportResult | null | undefined,
  paths: {
    insuranceImportPath: string | null
    salaryImportPath: string | null
    payrollBackpayPath: string | null
    voucherImportPath: string | null
    sourceSalaryOriginalPath: string | null
  }
): string | null {
  if (!snapshot) return null
  return JSON.stringify({
    ...snapshot,
    insuranceImportPath: paths.insuranceImportPath ?? snapshot.insuranceImportPath,
    salaryImportPath: paths.salaryImportPath ?? snapshot.salaryImportPath,
    payrollBackpayPath: paths.payrollBackpayPath ?? snapshot.payrollBackpayPath,
    voucherImportPath: paths.voucherImportPath ?? snapshot.voucherImportPath,
    sourceSalaryOriginalPath: paths.sourceSalaryOriginalPath ?? snapshot.sourceSalaryOriginalPath
  })
}

async function cleanupMonthlyPayrollGeneratedFiles(
  database: Awaited<ReturnType<typeof getDatabase>>,
  batchId: number,
  runs: MonthlyPayrollRun[]
): Promise<void> {
  const removedDirs = new Set<string>()
  const removedFiles = new Set<string>()
  const runIds = new Set(runs.map((run) => run.id))
  for (const run of runs) {
    // 重新生成或取消月结时，旧导入/凭证文件不再作为最终结果保留。
    for (const filePath of [
      run.insuranceImportPath,
      run.salaryImportPath,
      run.payrollBackpayPath,
      run.voucherImportPath
    ]) {
      if (!filePath) continue
      if (removedFiles.has(filePath)) continue
      removedFiles.add(filePath)
      if (existsSync(filePath)) {
        try {
          if (await isFileReferencedByOtherRuns(database, filePath, runIds)) {
            await logFileOperation(database, {
              batchId,
              action: 'skip-delete-generated',
              filePath,
              fileLabel: '生成文件',
              error: '文件仍被其他工资报账记录引用'
            })
            continue
          }
          await logFileOperation(database, {
            batchId,
            action: 'delete-generated',
            filePath,
            fileLabel: '生成文件'
          })
          await unlink(filePath)
        } catch (error) {
          console.warn(`删除生成文件失败：${filePath}`, error)
          await logFileOperation(database, {
            batchId,
            action: 'delete-generated-failed',
            filePath,
            fileLabel: '生成文件',
            error
          })
        }
      }
    }
    for (const archivedPath of run.archiveManifest) {
      if (!archivedPath || !existsSync(archivedPath)) continue
      try {
        await logFileOperation(database, {
          batchId,
          action: 'delete-archive-copy',
          filePath: archivedPath,
          fileLabel: '归档副本'
        })
        await unlink(archivedPath)
      } catch (error) {
        console.warn(`删除归档副本失败：${archivedPath}`, error)
        await logFileOperation(database, {
          batchId,
          action: 'delete-archive-copy-failed',
          filePath: archivedPath,
          fileLabel: '归档副本',
          error
        })
      }
    }
    if (run.archiveDir && existsSync(run.archiveDir) && !removedDirs.has(run.archiveDir)) {
      removedDirs.add(run.archiveDir)
      try {
        const remaining = await readdir(run.archiveDir)
        if (remaining.length === 0) {
          await rmdir(run.archiveDir)
        }
      } catch (error) {
        console.warn(`清理归档目录失败：${run.archiveDir}`, error)
      }
    }
  }
}

async function clearMonthCloseAdjustmentFields(
  database: Awaited<ReturnType<typeof getDatabase>>,
  batchId: number
): Promise<void> {
  let touched = false
  const updatedAt = new Date().toISOString()

  for (const worksheetName of monthCloseAdjustmentWorksheetNames) {
    const target = resolveMonthCloseAdjustmentTarget(worksheetName)
    if (!target) continue

    const whereSql = target.columns
      .map((column) => `CAST(COALESCE(${quoteIdentifier(column.columnName)}, 0) AS REAL) <> 0`)
      .join(' OR ')
    const rows = await all<Record<string, unknown>>(
      database,
      `SELECT * FROM ${target.tableName} WHERE ${whereSql}`
    )
    if (rows.length === 0) continue

    await logRecordSnapshots(database, {
      batchId,
      tableName: worksheetName,
      worksheetName,
      action: 'update',
      rows,
      afterValues: Object.fromEntries(target.columns.map((column) => [column.columnName, 0]))
    })

    const assignments = [
      ...target.columns.map((column) => `${quoteIdentifier(column.columnName)} = 0`),
      '"md_updated_at" = ?'
    ].join(', ')
    for (const row of rows) {
      const rowId = Number(row.id)
      if (!Number.isFinite(rowId)) continue
      await run(
        database,
        `UPDATE ${target.tableName}
            SET ${assignments}
          WHERE "id" = ?`,
        [updatedAt, rowId]
      )
      touched = true
    }
  }

  if (touched) {
    await recomputeMonthlyPayrollWorksheetsAfterAdjustmentChange()
  }
}

async function restoreMonthCloseAdjustmentFields(
  database: Awaited<ReturnType<typeof getDatabase>>,
  batchId: number,
  year: number,
  month: number
): Promise<void> {
  const archiveBatch = await latestArchiveOperationBatch(database, year, month)
  if (!archiveBatch) return

  const logs = await all<{
    worksheetName: string | null
    recordId: number | null
    beforeValues: string | null
  }>(
    database,
    `SELECT l.worksheet_name AS worksheetName,
            l.record_id AS recordId,
            l.before_values AS beforeValues
       FROM record_change_logs l
      WHERE l.batch_id = ?
        AND l.action = 'update'
        AND l.worksheet_name IN (${monthCloseAdjustmentWorksheetNames.map(() => '?').join(', ')})
      ORDER BY l.table_name ASC, l.id ASC`,
    [archiveBatch.id, ...monthCloseAdjustmentWorksheetNames]
  )
  if (logs.length === 0) return

  let touched = false
  const updatedAt = new Date().toISOString()
  for (const worksheetName of monthCloseAdjustmentWorksheetNames) {
    const target = resolveMonthCloseAdjustmentTarget(worksheetName)
    if (!target) continue

    const worksheetLogs = logs.filter((log) => log.worksheetName === worksheetName)
    if (worksheetLogs.length === 0) continue
    const currentRows: Record<string, unknown>[] = []

    for (const log of worksheetLogs) {
      const beforeValues = parseJsonObject(log.beforeValues)
      const rowId = Number(beforeValues.id ?? log.recordId)
      if (!Number.isFinite(rowId)) continue

      const current = await all<Record<string, unknown>>(
        database,
        `SELECT * FROM ${target.tableName} WHERE "id" = ? LIMIT 1`,
        [rowId]
      )
      if (!current[0]) continue
      currentRows.push(current[0])

      const restoreColumns = target.columns.filter((column) =>
        Object.prototype.hasOwnProperty.call(beforeValues, column.columnName)
      )
      if (restoreColumns.length === 0) continue

      const assignments = [
        ...restoreColumns.map((column) => `${quoteIdentifier(column.columnName)} = ?`),
        '"md_updated_at" = ?'
      ].join(', ')
      await run(
        database,
        `UPDATE ${target.tableName}
            SET ${assignments}
          WHERE "id" = ?`,
        [
          ...restoreColumns.map((column) => beforeValues[column.columnName]),
          updatedAt,
          rowId
        ]
      )
      touched = true
    }

    if (currentRows.length > 0) {
      await logRecordSnapshots(database, {
        batchId,
        tableName: worksheetName,
        worksheetName,
        action: 'restore',
        rows: currentRows
      })
    }
  }

  if (touched) {
    await recomputeMonthlyPayrollWorksheetsAfterAdjustmentChange()
  }
}

function resolveMonthCloseAdjustmentTarget(
  worksheetName: (typeof monthCloseAdjustmentWorksheetNames)[number]
): {
  tableName: string
  columns: Array<{ fieldName: string; columnName: string }>
} | null {
  try {
    const worksheet = getWorksheetByName(worksheetName)
    const localColumns = getWorksheetLocalColumns(worksheet)
    const columns: Array<{ fieldName: string; columnName: string }> = []
    for (const fieldName of monthCloseAdjustmentFieldNames) {
      const matched = localColumns.find((column) => column.field.name === fieldName)
      if (matched) columns.push({ fieldName, columnName: matched.columnName })
    }
    if (columns.length === 0) return null
    return {
      tableName: quoteIdentifier(worksheet.name),
      columns
    }
  } catch {
    return null
  }
}

async function recomputeMonthlyPayrollWorksheetsAfterAdjustmentChange(): Promise<void> {
  await applyTaxAndRecomputeIntegratedActive({})
  await recomputeIntegratedOtherLikeWorksheet('退休工资')
  await recomputeIntegratedOtherLikeWorksheet('其他工资')
}

async function latestArchiveOperationBatch(
  database: Awaited<ReturnType<typeof getDatabase>>,
  year: number,
  month: number
): Promise<{ id: number } | null> {
  const rows = await all<{ id: number }>(
    database,
    `SELECT id
       FROM operation_batches
      WHERE kind = 'monthly-payroll.archive-month'
        AND target_name = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [monthlyPayrollOperationTargetName(year, month)]
  )
  return rows[0] ?? null
}

function monthlyPayrollOperationTargetName(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

async function isFileReferencedByOtherRuns(
  database: Awaited<ReturnType<typeof getDatabase>>,
  filePath: string,
  currentRunIds: Set<number>
): Promise<boolean> {
  const rows = await all<{ id: number }>(
    database,
    `SELECT id FROM monthly_payroll_runs
      WHERE (insurance_import_path = ?
          OR salary_import_path = ?
          OR payroll_backpay_path = ?
          OR voucher_import_path = ?)
      LIMIT 20`,
    [filePath, filePath, filePath, filePath]
  )
  return rows.some((row) => !currentRunIds.has(Number(row.id)))
}

async function restoreMonthlyPayrollSourceFiles(runs: MonthlyPayrollRun[]): Promise<void> {
  const restoredTargets = new Set<string>()
  for (const run of runs) {
    await restoreArchiveSourceFile(run, run.sourceSalaryPath, ['原始工资表', '工资表', '写入个税工资表'], restoredTargets)
    await restoreArchiveSourceFile(run, run.sourceSocialPath, '社保', restoredTargets)
    await restoreArchiveSourceFile(run, run.sourceTaxPath, '个税', restoredTargets)
  }
}

async function restoreArchiveSourceFile(
  run: MonthlyPayrollRun,
  originalPath: string | null,
  label: string | string[],
  restoredTargets: Set<string>
): Promise<void> {
  if (!originalPath || restoredTargets.has(originalPath) || existsSync(originalPath)) return
  const archivedPath = findArchivedSourcePath(run, originalPath, label)
  if (!archivedPath || !existsSync(archivedPath)) return

  mkdirSync(dirname(originalPath), { recursive: true })
  const targetPath = uniqueArchivePath(dirname(originalPath), basename(originalPath))
  try {
    await rename(archivedPath, targetPath)
  } catch {
    await copyFile(archivedPath, targetPath)
    await unlink(archivedPath)
  }
  restoredTargets.add(originalPath)
}

function findArchivedSourcePath(
  run: MonthlyPayrollRun,
  originalPath: string,
  label: string | string[]
): string | null {
  const originalName = basename(originalPath)
  const labels = Array.isArray(label) ? label : [label]
  const match = run.archiveManifest.find((filePath) =>
    labels.some((item) => isArchivedFileForLabel(basename(filePath), item, originalName))
  )
  return match ?? null
}

function isArchivedFileForLabel(name: string, label: string, originalName: string): boolean {
  return (
    name === `${label}_${originalName}` ||
    (name.startsWith(`${label}_`) && name.endsWith(`_${originalName}`)) ||
    (name.startsWith(`工资报账月结_${label}_`) && name.endsWith(`_${originalName}`))
  )
}

function uniqueArchivePath(targetDir: string, fileName: string): string {
  let candidate = join(targetDir, fileName)
  if (!existsSync(candidate)) return candidate

  const dotIndex = fileName.lastIndexOf('.')
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : ''
  for (let index = 2; ; index += 1) {
    candidate = join(targetDir, `${stem}_${index}${extension}`)
    if (!existsSync(candidate)) return candidate
  }
}

const FINGERPRINT_SKIP_SHEETS = new Set(['退休工资', '退休房补'])
const VOUCHER_ATTACHMENT_PAGES_COLUMN = '附件页数'
const RETIRED_HOUSING_REPORT_SHEET_NAMES = new Set(['退休工资', '退休房补'])
// 与 monthlyPayroll.ts 保持一致：保险凭证固定附件页数用于历史快照重建。
const INSURANCE_VOUCHER_ATTACHMENT_PAGES = 7

function dateStamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function columnLabel(index: number): string {
  let label = ''
  let current = index + 1
  while (current > 0) {
    const remainder = (current - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    current = Math.floor((current - 1) / 26)
  }
  return label
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}
