import { getDatabase, all, get, run } from '../../db/connection'
import type { MailDownloadRecord } from '../../../shared/types'

interface RecordRow {
  id: number
  account_id: number
  message_uid: number
  message_id: string | null
  message_date: string | null
  from_address: string | null
  subject: string | null
  attachment_filename: string
  attachment_size: number
  attachment_hash: string | null
  saved_path: string
  created_at: string | null
}

export async function mailAttachmentAlreadyDownloaded(
  accountId: number,
  messageUid: number,
  attachmentFilename: string,
  attachmentSize: number
): Promise<boolean> {
  const database = await getDatabase()
  const row = await get<{ id: number }>(
    database,
    `SELECT id FROM mail_download_records
     WHERE account_id = ? AND message_uid = ? AND attachment_filename = ? AND attachment_size = ?`,
    [accountId, messageUid, attachmentFilename, attachmentSize]
  )
  return !!row
}

export async function insertMailDownloadRecord(data: {
  accountId: number
  messageUid: number
  messageId?: string
  messageDate?: string
  fromAddress?: string
  subject?: string
  attachmentFilename: string
  attachmentSize: number
  attachmentHash?: string
  savedPath: string
}): Promise<void> {
  const database = await getDatabase()
  await run(
    database,
    `INSERT INTO mail_download_records
     (account_id, message_uid, message_id, message_date, from_address, subject,
      attachment_filename, attachment_size, attachment_hash, saved_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.accountId, data.messageUid, data.messageId ?? null,
      data.messageDate ?? null, data.fromAddress ?? null, data.subject ?? null,
      data.attachmentFilename, data.attachmentSize, data.attachmentHash ?? null,
      data.savedPath
    ]
  )
}

export async function listMailDownloadRecords(
  limit: number = 200,
  offset: number = 0
): Promise<MailDownloadRecord[]> {
  const database = await getDatabase()
  const rows = await all<RecordRow>(
    database,
    'SELECT * FROM mail_download_records ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  )
  return rows.map((r) => ({
    id: r.id,
    messageUid: r.message_uid,
    messageId: r.message_id ?? undefined,
    messageDate: r.message_date ?? '',
    fromAddress: r.from_address ?? '',
    subject: r.subject ?? '',
    attachmentFilename: r.attachment_filename,
    attachmentSize: r.attachment_size,
    savedPath: r.saved_path,
    accountId: r.account_id,
    createdAt: r.created_at ?? undefined
  }))
}

export async function clearMailDownloadRecords(accountId?: number): Promise<number> {
  const database = await getDatabase()
  if (accountId != null) {
    await run(database, 'DELETE FROM mail_download_records WHERE account_id = ?', [accountId])
  } else {
    await run(database, 'DELETE FROM mail_download_records')
  }
  return 0
}
