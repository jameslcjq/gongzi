import { getDatabase, all, get, run, runWithLastId } from '../../db/connection'
export type { MailDownloadRule } from '../../../shared/types'

import type { MailDownloadRule } from '../../../shared/types'

interface RuleRow {
  id: number
  account_id: number
  enabled: number
  subject_contains: string | null
  extension_filter: string | null
  only_unread: number
  mark_seen: number
  created_at: string | null
  updated_at: string | null
}

function rowToRule(row: RuleRow): MailDownloadRule {
  return {
    id: row.id,
    enabled: row.enabled === 1,
    accountId: row.account_id,
    subjectContains: row.subject_contains ?? undefined,
    extensionFilter: row.extension_filter ?? undefined,
    onlyUnread: row.only_unread === 1,
    markSeen: row.mark_seen === 1,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined
  }
}

export async function listMailRules(accountId?: number): Promise<MailDownloadRule[]> {
  const database = await getDatabase()
  const sql = accountId != null
    ? 'SELECT * FROM mail_download_rules WHERE account_id = ? ORDER BY id ASC'
    : 'SELECT * FROM mail_download_rules ORDER BY id ASC'
  const params = accountId != null ? [accountId] : []
  const rows = await all<RuleRow>(database, sql, params)
  return rows.map(rowToRule)
}

export async function saveMailRule(data: Partial<MailDownloadRule> & { accountId: number }): Promise<MailDownloadRule> {
  const database = await getDatabase()
  const enabled = data.enabled !== false ? 1 : 0
  const onlyUnread = data.onlyUnread ? 1 : 0
  const markSeen = data.markSeen ? 1 : 0

  if (data.id) {
    await run(
      database,
      `UPDATE mail_download_rules SET account_id=?, enabled=?, subject_contains=?, extension_filter=?,
       only_unread=?, mark_seen=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [data.accountId, enabled, data.subjectContains ?? null, data.extensionFilter ?? null,
       onlyUnread, markSeen, data.id]
    )
    const row = await get<RuleRow>(database, 'SELECT * FROM mail_download_rules WHERE id = ?', [data.id])
    return rowToRule(row!)
  }

  const result = await runWithLastId(
    database,
    `INSERT INTO mail_download_rules (account_id, enabled, subject_contains, extension_filter, only_unread, mark_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.accountId, enabled, data.subjectContains ?? null, data.extensionFilter ?? null, onlyUnread, markSeen]
  )
  const row = await get<RuleRow>(database, 'SELECT * FROM mail_download_rules WHERE id = ?', [result.lastId])
  return rowToRule(row!)
}

export async function deleteMailRule(ruleId: number): Promise<void> {
  const database = await getDatabase()
  await run(database, 'DELETE FROM mail_download_rules WHERE id = ?', [ruleId])
}
