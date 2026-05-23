import { getDatabase, all, run } from '../../db/connection'
import type { MailDownloadLog } from '../../../shared/types'

interface LogRow {
  id: number
  account_id: number | null
  level: string
  message: string
  detail: string | null
  created_at: string | null
}

export async function appendMailLog(entry: {
  accountId: number
  level: 'info' | 'warn' | 'error'
  message: string
  detail?: string
}): Promise<void> {
  const database = await getDatabase()
  await run(
    database,
    'INSERT INTO mail_download_logs (account_id, level, message, detail) VALUES (?, ?, ?, ?)',
    [entry.accountId, entry.level, entry.message, entry.detail ?? null]
  )
}

export async function listMailLogs(
  accountId?: number,
  level?: string,
  limit: number = 200,
  offset: number = 0
): Promise<MailDownloadLog[]> {
  const database = await getDatabase()
  let sql = 'SELECT * FROM mail_download_logs WHERE 1=1'
  const params: unknown[] = []
  if (accountId != null) {
    sql += ' AND account_id = ?'
    params.push(accountId)
  }
  if (level) {
    sql += ' AND level = ?'
    params.push(level)
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = await all<LogRow>(database, sql, params)
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id ?? 0,
    level: r.level as MailDownloadLog['level'],
    message: r.message,
    detail: r.detail ?? undefined,
    createdAt: r.created_at ?? undefined
  }))
}

export async function clearMailLogs(accountId?: number): Promise<number> {
  const database = await getDatabase()
  if (accountId != null) {
    await run(database, 'DELETE FROM mail_download_logs WHERE account_id = ?', [accountId])
  } else {
    await run(database, 'DELETE FROM mail_download_logs')
  }
  return 0
}
