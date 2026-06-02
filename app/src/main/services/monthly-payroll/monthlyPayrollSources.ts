import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Database } from 'sqlite3'
import { all, getDatabase, run } from '../../db/connection'
import { getTempPath } from '../../config/paths'
import type {
  MonthlyPayrollSourceKind,
  MonthlyPayrollSourceVersion,
  MonthlyPayrollWorkflowInput
} from '../../../shared/types'
import type { SalarySummary, SocialSecuritySummary, TaxSummary } from './monthlyPayrollTypes'
import { normalizeMonthlyPayrollDataSourceMode } from './monthlyPayrollRuns'
import { num, roundMoney } from './monthlyPayrollUtils'

type ParsedSourceSummaries = {
  salary?: SalarySummary
  socialSecurity?: SocialSecuritySummary
  tax?: TaxSummary
}

type SourceCandidate = {
  kind: MonthlyPayrollSourceKind
  filePath: string
  rowCount: number
  totalAmount: number
  summary: Record<string, unknown>
}

export async function registerMonthlyPayrollSources(
  input: MonthlyPayrollWorkflowInput,
  summaries: ParsedSourceSummaries = {}
): Promise<void> {
  const year = Number(input.year)
  const month = Number(input.month)
  if (!Number.isInteger(year) || !Number.isInteger(month)) return

  const candidates = buildSourceCandidates(input, summaries)
  if (candidates.length === 0) return

  const database = await getDatabase()
  for (const candidate of candidates) {
    const file = await fileSnapshot(candidate.filePath)
    const current = await all<{ id: number; sha256: string; archive_path: string | null }>(
      database,
      `SELECT id, sha256, archive_path
         FROM monthly_payroll_source_versions
        WHERE year = ? AND month = ? AND kind = ? AND status = 'current'
        ORDER BY created_at DESC LIMIT 1`,
      [year, month, candidate.kind]
    )
    if (current[0]?.sha256 === file.sha256) {
      if (!current[0].archive_path || !existsSync(current[0].archive_path)) {
        const archivePath = await copySourceVersionFile(
          year,
          month,
          candidate.kind,
          candidate.filePath,
          file.sha256
        )
        await run(
          database,
          `UPDATE monthly_payroll_source_versions SET archive_path = ? WHERE id = ?`,
          [archivePath, current[0].id]
        )
      }
      continue
    }

    const existingSameHash = await all<Record<string, unknown>>(
      database,
      `SELECT *
         FROM monthly_payroll_source_versions
        WHERE year = ? AND month = ? AND kind = ? AND sha256 = ?
        ORDER BY created_at DESC LIMIT 1`,
      [year, month, candidate.kind, file.sha256]
    )
    const existingArchivePath = String(existingSameHash[0]?.archive_path ?? '')
    const archivePath =
      existingArchivePath && existsSync(existingArchivePath)
        ? existingArchivePath
        : await copySourceVersionFile(
            year,
            month,
            candidate.kind,
            candidate.filePath,
            file.sha256
          )

    await run(database, 'BEGIN TRANSACTION')
    try {
      await run(
        database,
        `UPDATE monthly_payroll_source_versions
            SET status = 'replaced', replaced_at = ?
          WHERE year = ? AND month = ? AND kind = ? AND status = 'current'`,
        [new Date().toISOString(), year, month, candidate.kind]
      )
      if (existingSameHash[0]) {
        await run(
          database,
          `UPDATE monthly_payroll_source_versions
              SET status = 'current',
                  replaced_at = NULL,
                  file_path = ?,
                  archive_path = ?,
                  file_name = ?,
                  file_size = ?,
                  row_count = ?,
                  total_amount = ?,
                  summary_json = ?
            WHERE id = ?`,
          [
            candidate.filePath,
            archivePath,
            basename(candidate.filePath),
            file.size,
            candidate.rowCount,
            candidate.totalAmount,
            JSON.stringify(candidate.summary),
            Number(existingSameHash[0].id)
          ]
        )
      } else {
        await run(
          database,
          `INSERT INTO monthly_payroll_source_versions
            (year, month, kind, file_path, archive_path, file_name, file_size, sha256, row_count, total_amount, summary_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current')`,
          [
            year,
            month,
            candidate.kind,
            candidate.filePath,
            archivePath,
            basename(candidate.filePath),
            file.size,
            file.sha256,
            candidate.rowCount,
            candidate.totalAmount,
            JSON.stringify(candidate.summary)
          ]
        )
      }
      await markMonthlyPayrollRunsOutdatedForSourceChange(database, year, month, candidate.kind)
      await run(database, 'COMMIT')
    } catch (error) {
      await run(database, 'ROLLBACK')
      throw error
    }
  }
}

export async function setMonthlyPayrollSourceVersionCurrent(
  id: number
): Promise<MonthlyPayrollSourceVersion> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT *
       FROM monthly_payroll_source_versions
      WHERE id = ? LIMIT 1`,
    [id]
  )
  const target = rows[0] ? mapSourceVersion(rows[0]) : null
  if (!target) throw new Error('未找到源文件版本')

  const usablePath = target.archivePath || target.filePath
  const file = await fileSnapshot(usablePath)
  if (file.sha256 !== target.sha256) {
    throw new Error('源文件版本副本已被修改或损坏，不能切回')
  }

  if (target.status === 'current') return target

  await run(database, 'BEGIN TRANSACTION')
  try {
    await run(
      database,
      `UPDATE monthly_payroll_source_versions
          SET status = 'replaced', replaced_at = ?
        WHERE year = ? AND month = ? AND kind = ? AND status = 'current' AND id <> ?`,
      [new Date().toISOString(), target.year, target.month, target.kind, target.id]
    )
    await run(
      database,
      `UPDATE monthly_payroll_source_versions
          SET status = 'current', replaced_at = NULL
        WHERE id = ?`,
      [target.id]
    )
    await markMonthlyPayrollRunsOutdatedForSourceChange(
      database,
      target.year,
      target.month,
      target.kind,
      `${sourceKindText(target.kind)}源文件已切回历史版本`
    )
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  const updatedRows = await all<Record<string, unknown>>(
    database,
    `SELECT *
       FROM monthly_payroll_source_versions
      WHERE id = ? LIMIT 1`,
    [target.id]
  )
  return mapSourceVersion(updatedRows[0])
}

export async function listMonthlyPayrollSourceVersions(
  year: number,
  month: number
): Promise<MonthlyPayrollSourceVersion[]> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT *
       FROM monthly_payroll_source_versions
      WHERE year = ? AND month = ?
      ORDER BY kind ASC, status ASC, created_at DESC`,
    [year, month]
  )
  return rows.map(mapSourceVersion)
}

function buildSourceCandidates(
  input: MonthlyPayrollWorkflowInput,
  summaries: ParsedSourceSummaries
): SourceCandidate[] {
  const candidates: SourceCandidate[] = []
  const dataSourceMode = normalizeMonthlyPayrollDataSourceMode(input.dataSourceMode)
  if (input.salaryWorkbookPath && summaries.salary && dataSourceMode === 'salary-workbook') {
    candidates.push({
      kind: 'salary',
      filePath: input.salaryWorkbookPath,
      rowCount: summaries.salary.activePeople.length + summaries.salary.survivorPeople.length,
      totalAmount: roundMoney(
        num(summaries.salary.active['实发工资合计']) + num(summaries.salary.survivor['合计'])
      ),
      summary: {
        activePeople: summaries.salary.activePeople.length,
        survivorPeople: summaries.salary.survivorPeople.length,
        activeActualPay: num(summaries.salary.active['实发工资合计']),
        survivorActualPay: num(summaries.salary.survivor['合计'])
      }
    })
  }
  if (input.socialSecurityWorkbookPath && summaries.socialSecurity) {
    const total = roundMoney(
      Object.values(summaries.socialSecurity.byItem).reduce((sum, value) => sum + value, 0)
    )
    candidates.push({
      kind: 'social',
      filePath: input.socialSecurityWorkbookPath,
      rowCount: summaries.socialSecurity.rowCount,
      totalAmount: total,
      summary: {
        rowCount: summaries.socialSecurity.rowCount,
        itemCount: Object.keys(summaries.socialSecurity.byItem).length,
        total
      }
    })
  }
  if (input.taxWorkbookPath && summaries.tax) {
    candidates.push({
      kind: 'tax',
      filePath: input.taxWorkbookPath,
      rowCount: summaries.tax.rows.length,
      totalAmount: summaries.tax.totalTax,
      summary: {
        rowCount: summaries.tax.rows.length,
        missingIdCards: summaries.tax.missingIdCards.length,
        totalTax: summaries.tax.totalTax
      }
    })
  }
  return candidates
}

async function markMonthlyPayrollRunsOutdatedForSourceChange(
  database: Database,
  year: number,
  month: number,
  kind: MonthlyPayrollSourceKind,
  reasonOverride?: string
): Promise<void> {
  const reason = reasonOverride ?? (kind === 'salary'
    ? '本月工资表源文件已更新'
    : kind === 'social'
    ? '本月社保源文件已更新'
    : '本月个税源文件已更新')
  await run(
    database,
    `UPDATE monthly_payroll_runs
        SET is_outdated = 1,
            outdated_at = COALESCE(outdated_at, ?),
            outdated_reason = COALESCE(outdated_reason, ?),
            insurance_push_status = CASE WHEN insurance_push_status = 'success' THEN 'needs-repush' ELSE insurance_push_status END,
            voucher_push_status = CASE WHEN voucher_push_status = 'success' THEN 'needs-repush' ELSE voucher_push_status END,
            salary_push_status = CASE WHEN salary_push_status = 'success' THEN 'needs-repush' ELSE salary_push_status END
      WHERE year = ? AND month = ? AND archived_at IS NULL`,
    [new Date().toISOString(), reason, year, month]
  )
}

function mapSourceVersion(row: Record<string, unknown>): MonthlyPayrollSourceVersion {
  return {
    id: Number(row.id),
    year: Number(row.year),
    month: Number(row.month),
    kind: normalizeSourceKind(row.kind),
    filePath: String(row.file_path ?? ''),
    archivePath: row.archive_path ? String(row.archive_path) : null,
    fileName: String(row.file_name ?? ''),
    fileSize: Number(row.file_size ?? 0),
    sha256: String(row.sha256 ?? ''),
    rowCount: Number(row.row_count ?? 0),
    totalAmount: Number(row.total_amount ?? 0),
    summary: parseSummary(row.summary_json),
    status: row.status === 'replaced' ? 'replaced' : 'current',
    replacedAt: (row.replaced_at as string) ?? null,
    createdAt: String(row.created_at ?? '')
  }
}

function normalizeSourceKind(value: unknown): MonthlyPayrollSourceKind {
  return value === 'social' || value === 'tax' ? value : 'salary'
}

function sourceKindText(kind: MonthlyPayrollSourceKind): string {
  if (kind === 'social') return '社保'
  if (kind === 'tax') return '个税'
  return '工资表'
}

function parseSummary(value: unknown): Record<string, unknown> {
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

async function fileSnapshot(filePath: string): Promise<{ size: number; sha256: string }> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error(`源文件不是普通文件：${filePath}`)
  return {
    size: info.size,
    sha256: await hashFile(filePath)
  }
}

async function copySourceVersionFile(
  year: number,
  month: number,
  kind: MonthlyPayrollSourceKind,
  sourcePath: string,
  sha256: string
): Promise<string> {
  const folder = getTempPath(
    'source-versions',
    `${year}-${String(month).padStart(2, '0')}`,
    kind
  )
  await mkdir(folder, { recursive: true })
  const safeName = basename(sourcePath).replace(/[\\/:*?"<>|]/g, '_')
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/[T.]/g, '_')
    .slice(0, 18)
  let targetPath = join(folder, `${stamp}_${sha256.slice(0, 12)}_${safeName}`)
  let index = 1
  while (existsSync(targetPath)) {
    targetPath = join(folder, `${stamp}_${sha256.slice(0, 12)}_${index}_${safeName}`)
    index += 1
  }
  await copyFile(sourcePath, targetPath)
  return targetPath
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
