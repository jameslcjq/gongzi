import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Database } from 'sqlite3'
import { quoteIdentifier } from '../db/schema'
import { all, get, getDatabase, refreshAllPersonnelStatuses, run, runWithLastId } from '../db/connection'
import type { RecycleBinBatch, RecycleBinRecord, RecycleBinRestoreResult } from '../../shared/types'

export type OperationBatchInput = {
  kind: string
  targetType?: string
  targetName?: string
  reason?: string
  meta?: Record<string, unknown>
}

export async function createOperationBatch(
  database: Database,
  input: OperationBatchInput
): Promise<number> {
  const { lastId } = await runWithLastId(
    database,
    `INSERT INTO operation_batches (kind, target_type, target_name, reason, meta_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.kind,
      input.targetType ?? null,
      input.targetName ?? null,
      input.reason ?? null,
      input.meta ? JSON.stringify(input.meta) : null
    ]
  )
  return lastId
}

export async function logRecordSnapshots(
  database: Database,
  input: {
    batchId: number
    tableName: string
    worksheetName?: string
    action: 'delete' | 'clear' | 'wipe' | 'update' | 'archive' | 'cancel-archive' | 'restore'
    rows: Array<Record<string, unknown>>
    afterValues?: Record<string, unknown> | null
  }
): Promise<void> {
  for (const row of input.rows) {
    await run(
      database,
      `INSERT INTO record_change_logs
        (batch_id, table_name, worksheet_name, record_id, action, before_values, after_values)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.batchId,
        input.tableName,
        input.worksheetName ?? null,
        Number(row.id ?? 0) || null,
        input.action,
        JSON.stringify(row),
        input.afterValues ? JSON.stringify(input.afterValues) : null
      ]
    )
  }
}

export async function logRowsBeforeDelete(
  database: Database,
  input: {
    batchId: number
    tableName: string
    worksheetName?: string
    action: 'delete' | 'clear' | 'wipe'
    whereSql?: string
    params?: unknown[]
  }
): Promise<number> {
  const where = input.whereSql ? ` WHERE ${input.whereSql}` : ''
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ${quoteIdentifier(input.tableName)}${where}`,
    input.params ?? []
  )
  await logRecordSnapshots(database, {
    batchId: input.batchId,
    tableName: input.tableName,
    worksheetName: input.worksheetName,
    action: input.action,
    rows
  })
  return rows.length
}

export async function logFileOperation(
  database: Database,
  input: {
    batchId: number
    action: string
    filePath: string
    fileLabel?: string
    error?: unknown
  }
): Promise<void> {
  const snapshot = await safeFileSnapshot(input.filePath)
  await run(
    database,
    `INSERT INTO file_operation_logs
      (batch_id, action, file_path, file_label, existed, file_size, sha256, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.batchId,
      input.action,
      input.filePath,
      input.fileLabel ?? null,
      snapshot.existed ? 1 : 0,
      snapshot.size ?? null,
      snapshot.sha256 ?? null,
      input.error ? String(input.error instanceof Error ? input.error.message : input.error) : snapshot.error ?? null
    ]
  )
}

export async function listRecycleBinBatches(limit = 100): Promise<RecycleBinBatch[]> {
  const database = await getDatabase()
  const safeLimit = normalizeLimit(limit, 500)
  const rows = await all<{
    id: number
    kind: string
    targetType: string | null
    targetName: string | null
    reason: string | null
    recordCount: number
    createdAt: string
  }>(
    database,
    `SELECT b.id,
            b.kind,
            b.target_type AS targetType,
            b.target_name AS targetName,
            b.reason,
            COUNT(l.id) AS recordCount,
            b.created_at AS createdAt
       FROM operation_batches b
       JOIN record_change_logs l ON l.batch_id = b.id
      WHERE l.action IN ('delete', 'clear', 'wipe')
        AND l.before_values IS NOT NULL
      GROUP BY b.id
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?`,
    [safeLimit]
  )
  return rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind ?? ''),
    targetType: row.targetType ?? null,
    targetName: row.targetName ?? null,
    reason: row.reason ?? null,
    recordCount: Number(row.recordCount ?? 0),
    createdAt: String(row.createdAt ?? '')
  }))
}

export async function listRecycleBinRecords(
  batchId: number,
  limit = 200
): Promise<RecycleBinRecord[]> {
  const database = await getDatabase()
  const safeLimit = normalizeLimit(limit, 1000)
  const rows = await all<RecycleBinRecordRow>(
    database,
    `SELECT id,
            batch_id,
            table_name,
            worksheet_name,
            record_id,
            action,
            before_values,
            created_at
       FROM record_change_logs
      WHERE batch_id = ?
        AND action IN ('delete', 'clear', 'wipe')
        AND before_values IS NOT NULL
      ORDER BY table_name ASC, id ASC
      LIMIT ?`,
    [batchId, safeLimit]
  )
  return rows.map(mapRecycleBinRecord)
}

export async function restoreRecycleBinBatch(batchId: number): Promise<RecycleBinRestoreResult> {
  const database = await getDatabase()
  const records = await all<RecycleBinRecordRow>(
    database,
    `SELECT id,
            batch_id,
            table_name,
            worksheet_name,
            record_id,
            action,
            before_values,
            created_at
       FROM record_change_logs
      WHERE batch_id = ?
        AND action IN ('delete', 'clear', 'wipe')
        AND before_values IS NOT NULL
      ORDER BY table_name ASC, id ASC`,
    [batchId]
  )

  if (records.length === 0) {
    return {
      batchId,
      restoredRows: 0,
      skippedRows: 0,
      conflictRows: 0,
      failedRows: 0,
      messages: ['该批次没有可恢复的删除快照']
    }
  }

  const result: RecycleBinRestoreResult = {
    batchId,
    restoredRows: 0,
    skippedRows: 0,
    conflictRows: 0,
    failedRows: 0,
    messages: []
  }

  await run(database, 'BEGIN TRANSACTION')
  try {
    const restoreBatchId = await createOperationBatch(database, {
      kind: 'recycle-bin.restore-batch',
      targetType: 'operation-batch',
      targetName: String(batchId),
      reason: '从回收站恢复删除记录',
      meta: { sourceBatchId: batchId }
    })

    for (const row of records) {
      const status = await restoreRecordSnapshot(database, restoreBatchId, row)
      if (status.kind === 'restored') result.restoredRows += 1
      if (status.kind === 'skipped') result.skippedRows += 1
      if (status.kind === 'conflict') result.conflictRows += 1
      if (status.kind === 'failed') result.failedRows += 1
      if (status.message && result.messages.length < 12) result.messages.push(status.message)
    }

    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  if (result.restoredRows > 0) {
    await refreshAllPersonnelStatuses(database)
  }

  if (result.messages.length === 0) {
    result.messages.push(`已恢复 ${result.restoredRows} 行`)
  }
  return result
}

type RecycleBinRecordRow = {
  id: number
  batch_id: number
  table_name: string
  worksheet_name: string | null
  record_id: number | null
  action: string
  before_values: string | null
  created_at: string
}

type TableInfoRow = {
  name: string
  pk: number
}

type RestoreStatus =
  | { kind: 'restored'; message?: string }
  | { kind: 'skipped'; message?: string }
  | { kind: 'conflict'; message?: string }
  | { kind: 'failed'; message?: string }

async function restoreRecordSnapshot(
  database: Database,
  restoreBatchId: number,
  row: RecycleBinRecordRow
): Promise<RestoreStatus> {
  const beforeValues = parseObject(row.before_values)
  if (Object.keys(beforeValues).length === 0) {
    return { kind: 'skipped', message: `日志 ${row.id} 没有可恢复的数据` }
  }

  const tableColumns = await readTableColumns(database, row.table_name)
  if (tableColumns.length === 0) {
    return { kind: 'skipped', message: `表 ${row.table_name} 不存在，已跳过` }
  }

  const columnNames = tableColumns.map((column) => column.name)
  const hasIdColumn = columnNames.includes('id')
  const values: Record<string, unknown> = { ...beforeValues }
  const originalId = hasOwn(values, 'id') ? values.id : row.record_id

  if (hasIdColumn && originalId !== null && originalId !== undefined && originalId !== '') {
    const existing = await get<{ id: number }>(
      database,
      `SELECT "id" FROM ${quoteIdentifier(row.table_name)} WHERE "id" = ? LIMIT 1`,
      [originalId]
    )
    if (existing) {
      return {
        kind: 'conflict',
        message: `${row.table_name} 原记录 ${originalId} 已存在，未覆盖`
      }
    }
    values.id = originalId
  }

  const insertColumns = columnNames.filter((column) => hasOwn(values, column))
  if (insertColumns.length === 0) {
    return { kind: 'skipped', message: `日志 ${row.id} 没有匹配当前表结构的字段` }
  }

  const placeholders = insertColumns.map(() => '?').join(', ')
  const sql = `INSERT INTO ${quoteIdentifier(row.table_name)}
    (${insertColumns.map(quoteIdentifier).join(', ')})
    VALUES (${placeholders})`
  const params = insertColumns.map((column) => values[column])

  try {
    await run(database, sql, params)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isSqliteConstraintError(message)) {
      return {
        kind: 'conflict',
        message: `${row.table_name} 原记录 ${originalId ?? row.record_id ?? row.id} 触发唯一约束，未恢复`
      }
    }
    return {
      kind: 'failed',
      message: `${row.table_name} 日志 ${row.id} 恢复失败：${message}`
    }
  }

  await run(
    database,
    `INSERT INTO record_change_logs
      (batch_id, table_name, worksheet_name, record_id, action, before_values, after_values)
     VALUES (?, ?, ?, ?, 'restore', ?, ?)`,
    [
      restoreBatchId,
      row.table_name,
      row.worksheet_name ?? null,
      Number(values.id ?? row.record_id ?? 0) || null,
      null,
      JSON.stringify({ sourceChangeLogId: row.id, sourceBatchId: row.batch_id, values })
    ]
  )

  return { kind: 'restored' }
}

async function readTableColumns(database: Database, tableName: string): Promise<TableInfoRow[]> {
  try {
    return await all<TableInfoRow>(database, `PRAGMA table_info(${quoteIdentifier(tableName)})`)
  } catch {
    return []
  }
}

function mapRecycleBinRecord(row: RecycleBinRecordRow): RecycleBinRecord {
  const action: RecycleBinRecord['action'] =
    row.action === 'clear' || row.action === 'wipe' ? row.action : 'delete'
  return {
    id: Number(row.id),
    batchId: Number(row.batch_id),
    tableName: String(row.table_name ?? ''),
    worksheetName: row.worksheet_name ?? null,
    recordId: row.record_id === null || row.record_id === undefined ? null : Number(row.record_id),
    action,
    beforeValues: parseObject(row.before_values),
    createdAt: String(row.created_at ?? '')
  }
}

function parseObject(value: unknown): Record<string, unknown> {
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

function normalizeLimit(value: number, max: number): number {
  const next = Math.trunc(Number(value))
  if (!Number.isFinite(next) || next <= 0) return Math.min(100, max)
  return Math.min(next, max)
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key)
}

function isSqliteConstraintError(message: string): boolean {
  return /SQLITE_CONSTRAINT|UNIQUE constraint|PRIMARY KEY/i.test(message)
}

async function safeFileSnapshot(
  filePath: string
): Promise<{ existed: boolean; size?: number; sha256?: string; error?: string }> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return { existed: true, size: info.size, error: 'not-a-file' }
    return {
      existed: true,
      size: info.size,
      sha256: await hashFile(filePath)
    }
  } catch (error) {
    return {
      existed: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
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
