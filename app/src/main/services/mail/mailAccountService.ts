import { getDatabase, all, get, run, runWithLastId } from '../../db/connection'
import { encryptAuthCode, decryptAuthCode } from './encryption'
import { ImapFlow } from 'imapflow'
import type { MailAccount, MailAccountView } from '../../../shared/types'

interface AccountRow {
  id: number
  email: string
  imap_host: string
  imap_port: number
  username: string
  auth_code_encrypted: string
  display_name: string | null
  folder: string | null
  from_filter: string | null
  enabled: number
  created_at: string | null
  updated_at: string | null
}

function rowToView(row: AccountRow): MailAccountView {
  return {
    id: row.id,
    email: row.email,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    username: row.username,
    displayName: row.display_name ?? undefined,
    authCodeMasked: maskAuthCode(row.auth_code_encrypted),
    folder: row.folder ?? undefined,
    fromFilter: row.from_filter ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined
  }
}

function rowToAccount(row: AccountRow): MailAccount {
  return {
    id: row.id,
    email: row.email,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    username: row.username,
    authCodeEncrypted: decryptAuthCode(row.auth_code_encrypted),
    displayName: row.display_name ?? undefined,
    folder: row.folder ?? undefined,
    fromFilter: row.from_filter ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined
  }
}

export async function listMailAccounts(): Promise<MailAccountView[]> {
  const database = await getDatabase()
  const rows = await all<AccountRow>(
    database,
    'SELECT * FROM mail_accounts WHERE enabled = 1 ORDER BY id ASC'
  )
  return rows.map(rowToView)
}

export async function getMailAccount(accountId: number): Promise<MailAccount | undefined> {
  const database = await getDatabase()
  const row = await get<AccountRow>(
    database,
    'SELECT * FROM mail_accounts WHERE id = ?',
    [accountId]
  )
  return row ? rowToAccount(row) : undefined
}

function maskAuthCode(encrypted: string): string {
  try {
    const plain = decryptAuthCode(encrypted)
    if (plain.length <= 2) return '**'
    if (plain.length <= 4) return plain[0] + '***'
    return plain.slice(0, 2) + '****' + plain.slice(-2)
  } catch {
    return '********'
  }
}

export async function saveMailAccount(data: {
  id?: number
  email: string
  imapHost: string
  imapPort: number
  username: string
  authCodeEncrypted: string
  displayName?: string
  folder?: string
  fromFilter?: string
}): Promise<MailAccountView> {
  const database = await getDatabase()
  const encrypted = encryptAuthCode(data.authCodeEncrypted)
  const imapPort = data.imapPort || 993

  if (data.id) {
    await run(
      database,
      `UPDATE mail_accounts SET email=?, imap_host=?, imap_port=?, username=?,
       auth_code_encrypted=?, display_name=?, folder=?, from_filter=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [data.email, data.imapHost, imapPort, data.username, encrypted, data.displayName ?? null,
       data.folder ?? null, data.fromFilter ?? null, data.id]
    )
    const row = await get<AccountRow>(
      database,
      'SELECT * FROM mail_accounts WHERE id = ?',
      [data.id]
    )
    return rowToView(row!)
  }

  const result = await runWithLastId(
    database,
    `INSERT INTO mail_accounts (email, imap_host, imap_port, username, auth_code_encrypted, display_name, folder, from_filter)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.email, data.imapHost, imapPort, data.username, encrypted, data.displayName ?? null,
     data.folder ?? null, data.fromFilter ?? null]
  )
  const row = await get<AccountRow>(
    database,
    'SELECT * FROM mail_accounts WHERE id = ?',
    [result.lastId]
  )
  return rowToView(row!)
}

export async function deleteMailAccount(accountId: number): Promise<void> {
  const database = await getDatabase()
  await run(database, 'DELETE FROM mail_download_logs WHERE account_id = ?', [accountId])
  await run(database, 'DELETE FROM mail_download_records WHERE account_id = ?', [accountId])
  await run(database, 'DELETE FROM mail_download_rules WHERE account_id = ?', [accountId])
  await run(database, 'DELETE FROM mail_accounts WHERE id = ?', [accountId])
}

export async function testMailAccount(data: {
  imapHost: string
  imapPort: number
  username: string
  authCodeEncrypted: string
}): Promise<{ ok: boolean; message: string }> {
  const client = new ImapFlow({
    host: data.imapHost,
    port: data.imapPort,
    secure: true,
    auth: { user: data.username, pass: data.authCodeEncrypted },
    logger: false
  })
  try {
    await client.connect()
    await client.mailboxOpen('INBOX')
    const mailbox = client.mailbox
    const count = mailbox && typeof mailbox === 'object' ? mailbox.exists : '?'
    return {
      ok: true,
      message: `连接成功！收件箱中共有 ${count} 封邮件`
    }
  } catch (error) {
    let msg: string
    if (error instanceof AggregateError && error.errors.length > 0) {
      msg = error.errors
        .map((e: unknown) => (e instanceof Error ? e.message : String(e)))
        .join('; ')
    } else if (error instanceof Error && error.message) {
      msg = error.message
    } else if (error instanceof Error) {
      msg = `未知错误 (${error.constructor.name})`
    } else {
      msg = String(error)
    }
    return { ok: false, message: `连接失败：${msg}` }
  } finally {
    try { await client.logout() } catch { /* ignore */ }
  }
}

export async function listMailFolders(accountId: number): Promise<string[]> {
  const account = await getMailAccount(accountId)
  if (!account) throw new Error(`邮箱账号 ${accountId} 不存在`)

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.username, pass: account.authCodeEncrypted },
    logger: false
  })
  try {
    await client.connect()
    const folders = await client.list()
    const result: string[] = []
    for (const folder of folders) {
      if (folder.path) result.push(folder.path)
    }
    return result.sort()
  } finally {
    try { await client.logout() } catch { /* ignore */ }
  }
}
