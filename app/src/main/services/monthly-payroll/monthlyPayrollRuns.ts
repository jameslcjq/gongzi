import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import * as XLSX from 'xlsx'
import { all, getDatabase, run } from '../../db/connection'
import { archiveRoot } from '../../config/paths'
import type {
  MonthlyPayrollArchiveResult,
  MonthlyPayrollDataSourceMode,
  MonthlyPayrollPushStatus,
  MonthlyPayrollReportResult,
  MonthlyPayrollReportSheet,
  MonthlyPayrollRun,
  MonthlyPayrollVoucherPageCounts,
  MonthlyPayrollWorkflowInput
} from '../../../shared/types'
import { normalizeMonthlyPayrollTaxField } from './monthlyPayrollSettings'
import { readMonthlyPayrollPrintSettings } from '../printSettings'
import { getSalaryWorkbookPrintPageSummary } from './printSalaryViaExcel'
import { createOperationBatch, logFileOperation, logRecordSnapshots, logRowsBeforeDelete } from '../operationLog'

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
  | 'salaryPushStatus'
  | 'insurancePushedAt'
  | 'salaryPushedAt'
>

export async function persistMonthlyPayrollRun(payload: MonthlyPayrollRunInput): Promise<void> {
  const database = await getDatabase()
  const outdatedAt = new Date().toISOString()
  await run(
    database,
    `UPDATE monthly_payroll_runs
        SET is_outdated = 1,
            outdated_at = COALESCE(outdated_at, ?),
            outdated_reason = COALESCE(outdated_reason, ?),
            insurance_push_status = CASE WHEN insurance_push_status = 'success' THEN 'needs-repush' ELSE insurance_push_status END,
            salary_push_status = CASE WHEN salary_push_status = 'success' THEN 'needs-repush' ELSE salary_push_status END
      WHERE year = ? AND month = ? AND archived_at IS NULL AND is_outdated = 0`,
    [
      outdatedAt,
      '同月已重新生成工资报账结果',
      payload.year,
      payload.month
    ]
  )
  await run(
    database,
    `INSERT INTO monthly_payroll_runs (
      year, month, unit_full_name,
      active_count, survivor_count, retired_housing_count,
      salary_total, withholding_total, tax_total, actual_pay,
      active_actual_pay, survivor_actual_pay, retired_housing_actual_pay, retired_housing,
      source_salary_path, source_social_path, source_tax_path,
      insurance_import_path, voucher_import_path, salary_import_path, payroll_backpay_path,
      report_fingerprint, tax_field, data_source_mode, report_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      payload.reportSnapshot ? JSON.stringify(payload.reportSnapshot) : null
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
      insurance_push_status, salary_push_status, insurance_pushed_at, salary_pushed_at,
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

  const existingRun = mapRunRow(runRow)
  if (existingRun.archivedAt && existingRun.archiveDir) {
    return {
      run: existingRun,
      archiveDir: existingRun.archiveDir,
      files: existingRun.archiveManifest
    }
  }

  const archiveDir = monthlyPayrollArchiveDir(existingRun)
  mkdirSync(archiveDir, { recursive: true })
  const archiveDate = dateStamp()
  const monthRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
     WHERE year = ? AND month = ? AND archived_at IS NULL`,
    [existingRun.year, existingRun.month]
  )
  const monthRuns = monthRows.map(mapRunRow)
  const operationBatchId = await createOperationBatch(database, {
    kind: 'monthly-payroll.archive-month',
    targetType: 'monthly-payroll',
    targetName: `${existingRun.year}-${String(existingRun.month).padStart(2, '0')}`,
    reason: '工资报账月结归档',
    meta: { id, year: existingRun.year, month: existingRun.month, archiveDir }
  })
  await logRecordSnapshots(database, {
    batchId: operationBatchId,
    tableName: 'monthly_payroll_runs',
    action: 'archive',
    rows: monthRows
  })

  const archivedFiles = (
    await Promise.all(
      monthRuns.flatMap((run) => [
        moveArchiveFile(database, operationBatchId, run.sourceSalaryPath, archiveDir, '工资表', archiveDate),
        moveArchiveFile(database, operationBatchId, run.sourceSocialPath, archiveDir, '社保', archiveDate),
        moveArchiveFile(database, operationBatchId, run.sourceTaxPath, archiveDir, '个税', archiveDate),
        copyArchiveFile(database, operationBatchId, run.insuranceImportPath, archiveDir, '保险导入', archiveDate),
        copyArchiveFile(database, operationBatchId, run.salaryImportPath, archiveDir, '工资导入', archiveDate),
        copyArchiveFile(database, operationBatchId, run.payrollBackpayPath, archiveDir, '补发工资', archiveDate),
        copyArchiveFile(database, operationBatchId, run.voucherImportPath, archiveDir, '凭证', archiveDate)
      ])
    )
  ).filter((item): item is string => Boolean(item))

  const archivedAt = new Date().toISOString()
  const manifestPath = uniqueArchivePath(archiveDir, `月结清单_${archiveDate}.json`)
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        year: existingRun.year,
        month: existingRun.month,
        unitFullName: existingRun.unitFullName,
        archivedAt,
        archiveDir,
        files: archivedFiles,
        totals: {
          activeCount: existingRun.activeCount,
          survivorCount: existingRun.survivorCount,
          retiredHousingCount: existingRun.retiredHousingCount,
          salaryTotal: existingRun.salaryTotal,
          withholdingTotal: existingRun.withholdingTotal,
          taxTotal: existingRun.taxTotal,
          actualPay: existingRun.actualPay,
          activeActualPay: existingRun.activeActualPay,
          survivorActualPay: existingRun.survivorActualPay,
          retiredHousingActualPay: existingRun.retiredHousingActualPay,
          retiredHousing: existingRun.retiredHousing
        }
      },
      null,
      2
    ),
    'utf8'
  )
  archivedFiles.push(manifestPath)

  await run(
    database,
    `UPDATE monthly_payroll_runs
       SET archived_at = ?, archive_dir = ?, archive_manifest = ?
     WHERE year = ? AND month = ? AND archived_at IS NULL`,
    [archivedAt, archiveDir, JSON.stringify(archivedFiles), existingRun.year, existingRun.month]
  )

  const updatedRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
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
  target: 'insurance' | 'salary',
  status: MonthlyPayrollPushStatus
): Promise<MonthlyPayrollRun> {
  const database = await getDatabase()
  const statusColumn = target === 'insurance' ? 'insurance_push_status' : 'salary_push_status'
  const pushedAtColumn = target === 'insurance' ? 'insurance_pushed_at' : 'salary_pushed_at'
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
  return payrollRun.archiveManifest.filter((filePath) => {
    const name = basename(filePath)
    return name === `工资表_${sourceName}` || (name.startsWith('工资表_') && name.endsWith(`_${sourceName}`))
  })
}

function countRetiredHousingPrintPages(sheets: MonthlyPayrollReportSheet[]): number {
  const sheet = sheets.find((item) => item.name === '一体化退休')
  if (!sheet) return 0
  if (sheet.rows.length === 0) return 0
  if (sheet.rows.length <= 3) return 1
  const dataCount = Math.max(0, sheet.rows.length - 3)
  return Math.max(1, Math.ceil(dataCount / 18))
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
    salaryPushStatus: normalizeMonthlyPayrollPushStatus(row.salary_push_status),
    insurancePushedAt: (row.insurance_pushed_at as string) ?? null,
    salaryPushedAt: (row.salary_pushed_at as string) ?? null,
    createdAt: String(row.created_at ?? '')
  }
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
  const yearDir = join(monthlyPayrollArchiveRoot(), String(run.year))
  return join(yearDir, `${run.year}-${String(run.month).padStart(2, '0')}_工资报账月结`)
}

function monthlyPayrollArchiveRoot(): string {
  return archiveRoot
}

async function copyArchiveFile(
  database: Awaited<ReturnType<typeof getDatabase>>,
  batchId: number,
  sourcePath: string | null,
  targetDir: string,
  label: string,
  archiveDate: string
): Promise<string | null> {
  if (!sourcePath || !existsSync(sourcePath)) return null
  mkdirSync(targetDir, { recursive: true })
  const targetPath = uniqueArchivePath(targetDir, archiveFileName(label, archiveDate, sourcePath))
  await logFileOperation(database, {
    batchId,
    action: 'copy-to-archive',
    filePath: sourcePath,
    fileLabel: label
  })
  await copyFile(sourcePath, targetPath)
  return targetPath
}

async function moveArchiveFile(
  database: Awaited<ReturnType<typeof getDatabase>>,
  batchId: number,
  sourcePath: string | null,
  targetDir: string,
  label: string,
  archiveDate: string
): Promise<string | null> {
  if (!sourcePath || !existsSync(sourcePath)) return null
  mkdirSync(targetDir, { recursive: true })
  const targetPath = uniqueArchivePath(targetDir, archiveFileName(label, archiveDate, sourcePath))
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
  return `${label}_${archiveDate}_${basename(sourcePath)}`
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
    // 取消月结代表当月数据需要重生成，先清理已生成的导入/凭证文件。
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
    await restoreArchiveSourceFile(run, run.sourceSalaryPath, '工资表', restoredTargets)
    await restoreArchiveSourceFile(run, run.sourceSocialPath, '社保', restoredTargets)
    await restoreArchiveSourceFile(run, run.sourceTaxPath, '个税', restoredTargets)
  }
}

async function restoreArchiveSourceFile(
  run: MonthlyPayrollRun,
  originalPath: string | null,
  label: string,
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
  label: string
): string | null {
  const originalName = basename(originalPath)
  const match = run.archiveManifest.find((filePath) => {
    const name = basename(filePath)
    return (
      name === `${label}_${originalName}` ||
      (name.startsWith(`${label}_`) && name.endsWith(`_${originalName}`))
    )
  })
  return match ?? null
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

const FINGERPRINT_SKIP_SHEETS = new Set(['一体化退休'])
const VOUCHER_ATTACHMENT_PAGES_COLUMN = '附件页数'
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
