/**
 * 一体化预算导出 xls 预览 / 确认入库。
 *
 * xls 是多 sheet 多行表头的"江苏省预算编制人员信息表"模板，包含 6 张可见 sheet：
 *   综合信息情况表（一）  ← 跳过，不入库
 *   行政在职在编人员信息情况表  → 预算行政在职
 *   事业在职在编人员信息情况表  → 预算在职
 *   行政离退休人员信息情况表    → 预算行政离退休
 *   事业退休人员信息情况表      → 预算退休
 *   其他人员表                  → 预算其他
 *
 * 列匹配通过 worksheet field 的 importSource 与 xls 表头全限定名一一对应，
 * 见 docs/data/worksheets-retained.json 与 scripts/generateBudgetImportSource.js。
 *
 * 主键策略：以 "证件号码*"（或归一化后等价的字段）做 upsert key —— 同人不同次导入会更新覆盖。
 */

import { readFileSync } from 'node:fs'
import * as xlsx from 'xlsx'
import type { Database } from 'sqlite3'
import { getDatabase, run, get } from '../db/connection'
import { readWorksheetMetadata } from '../db/metadata'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import type { WorksheetMeta } from '../../shared/types'
import { createOperationBatch, logRecordSnapshots } from './operationLog'

export const BUDGET_SHEET_TO_WORKSHEET: Record<string, string> = {
  '行政在职在编人员信息情况表': '预算行政在职',
  '事业在职在编人员信息情况表': '预算在职',
  '行政离退休人员信息情况表': '预算行政离退休',
  '事业退休人员信息情况表': '预算退休',
  '其他人员表': '预算其他'
}
const BUDGET_SHEET_SKIP = new Set(['综合信息情况表（一）'])

export type BudgetSheetImportResult = {
  sheetName: string
  worksheetName: string
  inserted: number
  updated: number
  skipped: number
  status: 'ok' | 'no-target-worksheet' | 'empty' | 'no-key' | 'error'
  message?: string
}

export type BudgetImportResult = {
  ok: boolean
  filePath: string
  sheets: BudgetSheetImportResult[]
  totalInserted: number
  totalUpdated: number
  totalSkipped: number
  message?: string
}

function normalize(s: string): string {
  return String(s || '')
    .replace(/[*＊]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

function detectFirstDataRow(rows: unknown[][]): number {
  for (let r = 2; r < Math.min(15, rows.length); r++) {
    const row = (rows[r] || []) as unknown[]
    const col0 = String(row[0] || '').trim()
    if (col0 === '合计' || /^\d+$/.test(col0)) return r
    const numericCount = row.filter((c) => {
      const s = String(c || '').trim()
      return s.length > 0 && /^[\d,.]+$/.test(s)
    }).length
    if (numericCount > row.length * 0.3) return r
  }
  return 6
}

function extractFullNames(sheet: xlsx.WorkSheet): string[] {
  const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  const firstDataRow = detectFirstDataRow(rows)
  const headerRows: unknown[][] = []
  for (let r = 2; r < firstDataRow; r++) headerRows.push((rows[r] || []) as unknown[])
  const width = Math.max(...headerRows.map((r) => r.length), 0)
  const raw: string[] = []
  for (let i = 0; i < width; i++) {
    const segments = headerRows
      .map((row) => String((row as unknown[])[i] || '').trim())
      .filter((s) => s.length > 0)
    const deduped: string[] = []
    for (const s of segments) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== s) deduped.push(s)
    }
    raw.push(deduped.join('_'))
  }
  // 同 sheet 内全限定名去重
  const counts = new Map<string, number>()
  return raw.map((n) => {
    const c = (counts.get(n) || 0) + 1
    counts.set(n, c)
    return c === 1 ? n : `${n}#${c}`
  })
}

function findKeyColumnIndex(fullNames: string[]): number {
  // 优先 "证件号码*" / "证件号码" 等；归一化匹配
  const candidates = ['证件号码', '身份证号', '身份证号码']
  for (let i = 0; i < fullNames.length; i++) {
    const leaf = fullNames[i].split('_').pop() || ''
    const norm = normalize(leaf)
    if (candidates.some((c) => normalize(c) === norm)) return i
  }
  return -1
}

async function importOneSheet(
  database: Database,
  sheet: xlsx.WorkSheet,
  sheetName: string,
  worksheet: WorksheetMeta,
  options: { commit: boolean; batchId?: number }
): Promise<BudgetSheetImportResult> {
  const result: BudgetSheetImportResult = {
    sheetName,
    worksheetName: worksheet.name,
    inserted: 0,
    updated: 0,
    skipped: 0,
    status: 'ok'
  }

  const xlsFullNames = extractFullNames(sheet)
  const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  const firstDataRow = detectFirstDataRow(rows)
  const dataRows = rows.slice(firstDataRow) as unknown[][]

  // 过滤 "合计" 行和空行
  const cleanRows = dataRows.filter((row) => {
    const col0 = String(row[0] || '').trim()
    if (col0 === '合计' || col0 === '小计' || col0 === '总计') return false
    return row.some((c) => String(c || '').trim().length > 0)
  })

  if (cleanRows.length === 0) {
    result.status = 'empty'
    result.message = '无有效数据行'
    return result
  }

  // 找 key 列
  const keyXlsCol = findKeyColumnIndex(xlsFullNames)
  if (keyXlsCol < 0) {
    result.status = 'no-key'
    result.message = '未在 xls 表头找到 "证件号码" 列，无法做 upsert'
    result.skipped = cleanRows.length
    return result
  }

  // 建立 importSource → (field, columnName) 映射
  const wsCols = getWorksheetLocalColumns(worksheet)
  const importSourceToCol = new Map<string, { columnName: string }>()
  for (const c of wsCols) {
    const src = c.field.importSource
    if (src) importSourceToCol.set(src, { columnName: c.columnName })
  }

  // 对每个 xls 列，找对应 worksheet 列
  const colMappings: Array<{ xlsCol: number; columnName: string } | null> = xlsFullNames.map(
    (name, idx) => {
      const m = importSourceToCol.get(name)
      if (!m) return null
      return { xlsCol: idx, columnName: m.columnName }
    }
  )
  const matchedCount = colMappings.filter(Boolean).length

  // worksheet 的 key 列名 = xls keyXlsCol 对应的 mapping.columnName
  const keyMapping = colMappings[keyXlsCol]
  if (!keyMapping) {
    result.status = 'no-key'
    result.message = 'xls 证件号码列在 worksheet 里找不到对应字段，无法 upsert'
    result.skipped = cleanRows.length
    return result
  }
  const keyColumnName = keyMapping.columnName
  const tableName = worksheet.name

  // 准备 INSERT/UPDATE 语句模板
  const allColumnNames = colMappings
    .filter((m): m is { xlsCol: number; columnName: string } => m !== null)
    .map((m) => m.columnName)
  const placeholders = allColumnNames.map(() => '?').join(',')
  const insertCols = allColumnNames.map(quoteIdentifier).join(',')

  // 逐行 upsert
  for (const row of cleanRows) {
    const keyValue = String(row[keyXlsCol] || '').trim()
    if (!keyValue) {
      result.skipped++
      continue
    }

    // 检查是否已存在
    const existing = await get<{ id: number }>(
      database,
      `SELECT id FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(keyColumnName)} = ? LIMIT 1`,
      [keyValue]
    )

    const values = colMappings
      .filter((m): m is { xlsCol: number; columnName: string } => m !== null)
      .map((m) => {
        const v = row[m.xlsCol]
        if (v === null || v === undefined || v === '') return null
        if (typeof v === 'number') return v
        return String(v)
      })

    if (existing) {
      // UPDATE
      const setClause = allColumnNames
        .filter((c) => c !== keyColumnName) // 不更新 key 自己
        .map((c) => `${quoteIdentifier(c)} = ?`)
        .join(',')
      const updateValues = colMappings
        .filter((m): m is { xlsCol: number; columnName: string } => m !== null)
        .filter((m) => m.columnName !== keyColumnName)
        .map((m) => {
          const v = row[m.xlsCol]
          if (v === null || v === undefined || v === '') return null
          if (typeof v === 'number') return v
          return String(v)
        })
      if (!setClause) {
        result.skipped++
        continue
      }
      if (options.commit) {
        if (options.batchId) {
          const before = await get<Record<string, unknown>>(
            database,
            `SELECT * FROM ${quoteIdentifier(tableName)} WHERE id = ? LIMIT 1`,
            [existing.id]
          )
          if (before) {
            await logRecordSnapshots(database, {
              batchId: options.batchId,
              tableName,
              worksheetName: worksheet.name,
              action: 'update',
              rows: [before]
            })
          }
        }
        await run(
          database,
          `UPDATE ${quoteIdentifier(tableName)}
           SET ${setClause}, "md_updated_at" = datetime('now')
           WHERE id = ?`,
          [...updateValues, existing.id]
        )
      }
      result.updated++
    } else {
      // INSERT
      if (options.commit) {
        await run(
          database,
          `INSERT INTO ${quoteIdentifier(tableName)}
           ("md_row_id", "md_created_at", "md_updated_at", ${insertCols})
           VALUES (?, datetime('now'), datetime('now'), ${placeholders})`,
          [keyValue, ...values]
        )
      }
      result.inserted++
    }
  }

  result.message = `匹配 ${matchedCount}/${xlsFullNames.length} 列；${options.commit ? '插入' : '将插入'} ${result.inserted}，${options.commit ? '更新' : '将更新'} ${result.updated}，跳过 ${result.skipped}`
  return result
}

async function processBudgetXls(filePath: string, commit: boolean): Promise<BudgetImportResult> {
  const database = await getDatabase()
  const meta = readWorksheetMetadata()
  const batchId = commit
    ? await createOperationBatch(database, {
        kind: 'budget.import',
        targetType: 'budget-xls',
        targetName: filePath,
        reason: '预算 xls 确认入库',
        meta: { filePath }
      })
    : undefined
  // 中文路径下 xlsx.readFile 偶尔报 Cannot access file，统一走 fs.readFileSync
  const wb = xlsx.read(readFileSync(filePath), { type: 'buffer' })

  const sheets: BudgetSheetImportResult[] = []
  for (const sheetName of wb.SheetNames) {
    if (sheetName.startsWith('sourceElementSheetName')) continue
    if (BUDGET_SHEET_SKIP.has(sheetName)) continue

    const targetWsName = BUDGET_SHEET_TO_WORKSHEET[sheetName]
    if (!targetWsName) continue // 未知 sheet，忽略

    const ws = meta.find((w) => w.name === targetWsName)
    if (!ws) {
      sheets.push({
        sheetName,
        worksheetName: targetWsName,
        inserted: 0,
        updated: 0,
        skipped: 0,
        status: 'no-target-worksheet',
        message: `worksheet "${targetWsName}" 未在元数据找到`
      })
      continue
    }

    try {
      const r = await importOneSheet(database, wb.Sheets[sheetName], sheetName, ws, { commit, batchId })
      sheets.push(r)
    } catch (error) {
      sheets.push({
        sheetName,
        worksheetName: targetWsName,
        inserted: 0,
        updated: 0,
        skipped: 0,
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const totalInserted = sheets.reduce((s, r) => s + r.inserted, 0)
  const totalUpdated = sheets.reduce((s, r) => s + r.updated, 0)
  const totalSkipped = sheets.reduce((s, r) => s + r.skipped, 0)
  const hasError = sheets.some((r) => r.status === 'error')
  return {
    ok: !hasError,
    filePath,
    sheets,
    totalInserted,
    totalUpdated,
    totalSkipped,
    message: hasError ? '部分 sheet 导入失败，详见 sheets' : undefined
  }
}

export async function previewBudgetXls(filePath: string): Promise<BudgetImportResult> {
  return processBudgetXls(filePath, false)
}

export async function importBudgetXls(filePath: string): Promise<BudgetImportResult> {
  return processBudgetXls(filePath, true)
}
