import { simpleParser, type ParsedMail, type Attachment } from 'mailparser'
import { existsSync, mkdirSync, createWriteStream, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { mailAttachmentAlreadyDownloaded, insertMailDownloadRecord } from './downloadRecordService'
import { appendMailLog } from './downloadLogService'
import { getDatabase, all, get } from '../../db/connection'

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.vbs', '.js', '.ps1', '.msi', '.scr', '.com'
])

const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024 // 100 MB
const ALLOWED_EXTENSIONS_DEFAULT = ['.xls', '.xlsx', '.pdf', '.ofd', '.zip', '.rar', '.doc', '.docx', '.csv']

interface ProcessParams {
  accountId: number
  messageUid: number
  messageDate: string
  fromAddress: string
  subject: string
  messageSource: Buffer | string
  targetDirBase: string
  saveSubdir: string
  extensionFilter?: string
}

export async function processAttachmentsFromMessage(params: ProcessParams): Promise<{
  total: number
  downloaded: number
  skipped: number
  errored: number
  errors: string[]
}> {
  const result = { total: 0, downloaded: 0, skipped: 0, errored: 0, errors: [] as string[] }

  const sourceSize = Buffer.isBuffer(params.messageSource)
    ? params.messageSource.length
    : typeof params.messageSource === 'string'
      ? params.messageSource.length
      : 0
  console.log(`[mail] 解析邮件: "${params.subject}" 源码大小=${sourceSize}`)

  let parsed: ParsedMail
  try {
    parsed = await simpleParser(params.messageSource)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    result.errors.push(`解析邮件失败: ${msg}`)
    result.errored++
    console.log(`[mail] 解析失败: "${params.subject}" — ${msg}`)
    return result
  }

  const attachments = parsed.attachments || []
  result.total = attachments.length
  console.log(`[mail] 附件数=${attachments.length} 主题="${params.subject}"`, attachments.map(a => a.filename).join(', '))

  if (attachments.length === 0) {
    await appendMailLog({
      accountId: params.accountId,
      level: 'info',
      message: `无附件：${params.subject}`,
      detail: `发件人：${params.fromAddress}，源码大小=${sourceSize}，Content-Type=${parsed.headers?.get('content-type') || '?'}`
    })
    return result
  }

  const allowedExts = parseExtensionFilter(params.extensionFilter)

  for (const attachment of attachments) {
    try {
      const safeName = sanitizeFilename(attachment.filename || `attachment_${Date.now()}`)
      const ext = extname(safeName).toLowerCase()

      console.log(`[mail] 附件: ${safeName} ext=${ext} size=${attachment.size} allowedExts=${allowedExts.join(',')}`)

      // Safety: block executable types
      if (BLOCKED_EXTENSIONS.has(ext)) {
        result.skipped++
        console.log(`[mail] 跳过危险附件: ${safeName}`)
        await appendMailLog({
          accountId: params.accountId,
          level: 'warn',
          message: `跳过危险附件：${safeName}`,
          detail: `发件人：${params.fromAddress}，标题：${params.subject}`
        })
        continue
      }

      // Filter by allowed extensions
      if (allowedExts.length > 0 && !allowedExts.includes(ext)) {
        result.skipped++
        console.log(`[mail] 附件不在允许列表: ${safeName} ext=${ext}`)
        continue
      }

      // Size check
      const attSize = attachment.size || 0
      if (attSize > MAX_ATTACHMENT_SIZE) {
        result.skipped++
        await appendMailLog({
          accountId: params.accountId,
          level: 'warn',
          message: `附件过大：${safeName} (${formatSize(attSize)})`,
          detail: `超过 ${formatSize(MAX_ATTACHMENT_SIZE)} 限制`
        })
        continue
      }

      // Dedup check
      const alreadyExists = await mailAttachmentAlreadyDownloaded(
        params.accountId, params.messageUid, safeName, attSize
      )
      if (alreadyExists) {
        result.skipped++
        continue
      }

      // Save directly to target dir, no subdirectories
      const saveDir = params.targetDirBase
      mkdirSync(saveDir, { recursive: true })

      const desiredName = safeName
      const finalPath = resolveConflict(saveDir, desiredName)

      // Save attachment
      if (attachment.content instanceof Readable || Buffer.isBuffer(attachment.content)) {
        if (attachment.content instanceof Readable) {
          const writeStream = createWriteStream(finalPath)
          await pipeline(attachment.content, writeStream)
        } else {
          writeFileSync(finalPath, attachment.content as Buffer)
        }
      } else {
        // content is a string
        writeFileSync(finalPath, String(attachment.content), 'utf-8')
      }

      // Record download
      await insertMailDownloadRecord({
        accountId: params.accountId,
        messageUid: params.messageUid,
        messageId: parsed.messageId || undefined,
        messageDate: params.messageDate,
        fromAddress: params.fromAddress,
        subject: params.subject,
        attachmentFilename: safeName,
        attachmentSize: attSize,
        savedPath: finalPath
      })

      await appendMailLog({
        accountId: params.accountId,
        level: 'info',
        message: `下载成功：${safeName}`,
        detail: `保存到 ${finalPath}`
      })

      result.downloaded++

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      result.errors.push(`${attachment.filename}: ${msg}`)
      result.errored++
      await appendMailLog({
        accountId: params.accountId,
        level: 'error',
        message: `下载失败：${attachment.filename}`,
        detail: msg
      })
    }
  }

  return result
}

interface ParsedParams {
  accountId: number
  messageUid: number
  messageDate: string
  fromAddress: string
  subject: string
  parsed: ParsedMail
  targetDirBase: string
  saveSubdir: string
  extensionFilter?: string
}

export async function processAttachmentsFromParsed(params: ParsedParams): Promise<{
  total: number
  downloaded: number
  skipped: number
  errored: number
  errors: string[]
}> {
  const result = { total: 0, downloaded: 0, skipped: 0, errored: 0, errors: [] as string[] }
  const attachments = params.parsed.attachments || []
  result.total = attachments.length

  console.log(`[mail] 附件数=${attachments.length} 主题="${params.subject}"`, attachments.map(a => a.filename).join(', '))

  if (attachments.length === 0) {
    await appendMailLog({
      accountId: params.accountId,
      level: 'info',
      message: `无附件：${params.subject}`,
      detail: `发件人：${params.fromAddress}`
    })
    return result
  }

  const allowedExts = parseExtensionFilter(params.extensionFilter)

  for (const attachment of attachments) {
    try {
      const safeName = sanitizeFilename(attachment.filename || `attachment_${Date.now()}`)
      const ext = extname(safeName).toLowerCase()

      console.log(`[mail] 附件: ${safeName} ext=${ext} size=${attachment.size} allowedExts=${allowedExts.join(',')}`)

      if (BLOCKED_EXTENSIONS.has(ext)) {
        result.skipped++
        console.log(`[mail] 跳过危险附件: ${safeName}`)
        await appendMailLog({
          accountId: params.accountId,
          level: 'warn',
          message: `跳过危险附件：${safeName}`,
          detail: `发件人：${params.fromAddress}，标题：${params.subject}`
        })
        continue
      }

      if (allowedExts.length > 0 && !allowedExts.includes(ext)) {
        result.skipped++
        console.log(`[mail] 附件不在允许列表: ${safeName} ext=${ext}`)
        continue
      }

      const attSize = attachment.size || 0
      if (attSize > MAX_ATTACHMENT_SIZE) {
        result.skipped++
        await appendMailLog({
          accountId: params.accountId,
          level: 'warn',
          message: `附件过大：${safeName} (${formatSize(attSize)})`,
          detail: `超过 ${formatSize(MAX_ATTACHMENT_SIZE)} 限制`
        })
        continue
      }

      const alreadyExists = await mailAttachmentAlreadyDownloaded(
        params.accountId, params.messageUid, safeName, attSize
      )
      if (alreadyExists) {
        result.skipped++
        continue
      }

      const saveDir = params.targetDirBase
      mkdirSync(saveDir, { recursive: true })

      const desiredName = safeName
      const finalPath = resolveConflict(saveDir, desiredName)

      if (attachment.content instanceof Readable) {
        const writeStream = createWriteStream(finalPath)
        await pipeline(attachment.content, writeStream)
      } else if (Buffer.isBuffer(attachment.content)) {
        writeFileSync(finalPath, attachment.content as Buffer)
      } else {
        writeFileSync(finalPath, String(attachment.content || ''), 'utf-8')
      }

      await insertMailDownloadRecord({
        accountId: params.accountId,
        messageUid: params.messageUid,
        messageId: params.parsed.messageId || undefined,
        messageDate: params.messageDate,
        fromAddress: params.fromAddress,
        subject: params.subject,
        attachmentFilename: safeName,
        attachmentSize: attSize,
        savedPath: finalPath
      })

      await appendMailLog({
        accountId: params.accountId,
        level: 'info',
        message: `下载成功：${safeName}`,
        detail: `保存到 ${finalPath}`
      })

      result.downloaded++

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      result.errors.push(`${attachment.filename}: ${msg}`)
      result.errored++
      await appendMailLog({
        accountId: params.accountId,
        level: 'error',
        message: `下载失败：${attachment.filename}`,
        detail: msg
      })
    }
  }

  return result
}

function parseExtensionFilter(filter?: string): string[] {
  if (!filter) return ALLOWED_EXTENSIONS_DEFAULT
  return filter
    .split(/[,，\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.startsWith('.') ? e : `.${e}`))
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned || 'unnamed_attachment'
}

function formatDateFolder(dateStr: string): string {
  const d = dateStr ? new Date(dateStr) : new Date()
  if (isNaN(d.getTime())) {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function resolveConflict(dir: string, desiredName: string): string {
  const candidate = join(dir, desiredName)
  if (!existsSync(candidate)) return candidate

  const ext = extname(desiredName)
  const stem = basename(desiredName, ext)
  let counter = 2
  while (true) {
    const next = join(dir, `${stem}_${counter}${ext}`)
    if (!existsSync(next)) return next
    counter++
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
