import { ImapFlow, type FetchMessageObject } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { getMailAccount, listMailAccounts } from './mailAccountService'
import { listMailRules } from './mailRuleService'
import type { MailDownloadRule } from './mailRuleService'
import { processAttachmentsFromParsed } from './attachmentDownloadService'
import { appendMailLog } from './downloadLogService'
import { importFolder } from '../../config/paths'
import type { MailCheckProgress } from '../../../shared/types'

let abortController: AbortController | null = null

const MAX_DAYS_BACK = 90

export function stopCheck(): void {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
}

function sendProgress(
  push: (progress: MailCheckProgress) => void,
  partial: MailCheckProgress
): void {
  push(partial)
}

export async function connectAndSearch(
  accountId: number,
  daysBack: number,
  push: (progress: MailCheckProgress) => void
): Promise<{
  totalMessages: number
  scannedMessages: number
  foundCount: number
  downloadedCount: number
  skippedCount: number
  errorCount: number
  ruleFiltered: number
  errors: string[]
}> {
  abortController = new AbortController()
  const signal = abortController.signal

  const days = Math.min(Math.max(daysBack, 1), MAX_DAYS_BACK)

  const account = await getMailAccount(accountId)
  if (!account) throw new Error(`邮箱账号 ${accountId} 不存在`)

  const rules = await listMailRules(account.id!)
  const enabledRules = rules.filter((r) => r.enabled)

  const accountEmail = account.email

  const result = {
    totalMessages: 0,
    scannedMessages: 0,
    foundCount: 0,
    downloadedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    ruleFiltered: 0,
    errors: [] as string[]
  }

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.username, pass: account.authCodeEncrypted },
    logger: false
  })

  try {
    sendProgress(push, { phase: 'connecting', accountEmail, message: '正在连接邮箱服务器...' })

    await client.connect()
    // Folder from account config
    const targetFolder = account.folder || 'INBOX'
    console.log(`[mail] 打开文件夹: ${targetFolder}`)
    await client.mailboxOpen(targetFolder)

    const since = new Date()
    since.setDate(since.getDate() - days)
    console.log(`[mail] 搜索范围: ${since.toISOString().slice(0, 10)} ~ 今天, 文件夹=${targetFolder}, 天数=${days}`)

    sendProgress(push, { phase: 'scanning', accountEmail, message: '正在搜索邮件...' })

    const searchRaw = await client.search(
      { since },
      { uid: true }
    )

    if (searchRaw === false) {
      sendProgress(push, { phase: 'done', accountEmail, totalMessages: 0, message: '搜索失败，请检查邮箱配置' })
      return result
    }

    const searchResults = searchRaw as number[]
    result.totalMessages = searchResults.length

    sendProgress(push, {
      phase: 'scanning',
      accountEmail,
      totalMessages: result.totalMessages,
      message: `发现 ${result.totalMessages} 封邮件`
    })

    if (result.totalMessages === 0) {
      console.log(`[mail] 搜索无结果，文件夹=${targetFolder} 中没有符合时间范围的邮件`)
      sendProgress(push, { phase: 'done', accountEmail, totalMessages: 0, message: `文件夹 ${targetFolder} 中没有邮件` })
      return result
    }

    sendProgress(push, {
      phase: 'downloading',
      accountEmail,
      totalMessages: result.totalMessages,
      scannedMessages: 0,
      message: '开始处理邮件...'
    })

    for (let i = 0; i < searchResults.length; i++) {
      if (signal.aborted) {
        sendProgress(push, {
          phase: 'done',
          accountEmail,
          ...result,
          message: `已停止（处理了 ${i}/${result.totalMessages} 封邮件）`
        })
        break
      }

      const uid = searchResults[i]

      try {
        const fetched = await client.fetchOne(
          String(uid),
          { source: true, uid: true },
          { uid: true }
        )

        if (fetched === false) {
          result.scannedMessages++
          continue
        }

        const message = fetched as FetchMessageObject
        result.scannedMessages++

        // Check source first — need full email to parse
        if (!message.source) {
          console.log(`[mail] 缺少源码，跳过 UID=${uid}`)
          await appendMailLog({
            accountId: account.id!,
            level: 'warn',
            message: `邮件无源码，跳过 UID=${uid}`,
            detail: '服务器未返回邮件全文'
          })
          continue
        }

        // Parse email first to get REAL From/Subject (not relying on IMAP envelope)
        let parsed: ParsedMail
        try {
          parsed = await simpleParser(message.source)
        } catch (err) {
          console.log(`[mail] 解析失败 UID=${uid}:`, err)
          result.errorCount++
          continue
        }

        const realSubject = parsed.subject || message.envelope?.subject || '(无标题)'
        const realFrom = parsed.from?.text || message.envelope?.from?.[0]?.address || ''
        const fromAddr = parsed.from?.value?.[0]?.address || ''

        console.log(`[mail] 邮件 #${uid}: "${realSubject}" 来自="${realFrom}"`)

        sendProgress(push, {
          phase: 'downloading',
          accountEmail,
          totalMessages: result.totalMessages,
          scannedMessages: result.scannedMessages,
          foundCount: result.foundCount,
          downloadedCount: result.downloadedCount,
          skippedCount: result.skippedCount,
          errorCount: result.errorCount,
          currentFilename: realSubject
        })

        // Sender filter from account config (comma-separated, match any)
        if (account.fromFilter) {
          const fromLower = (realFrom + ' ' + fromAddr).toLowerCase()
          const filters = account.fromFilter.split(/[,，\s]+/).map((f: string) => f.trim().toLowerCase()).filter(Boolean)
          const matched = filters.some((f: string) => fromLower.includes(f))
          if (!matched) {
            console.log(`[mail] 发件人不匹配: "${realSubject}" from="${realFrom}"`)
            result.ruleFiltered++
            continue
          }
        }

        // Apply rules filter (subject + extension only, sender is account-level)
        const matchingRule = findMatchingRuleParsed(realSubject, enabledRules)

        if (enabledRules.length > 0 && !matchingRule) {
          console.log(`[mail] 规则不匹配: "${realSubject}", 规则=[${enabledRules.map(r => `subject="${r.subjectContains || '无'}"`).join('; ')}]`)
          result.ruleFiltered++
          continue
        }

        // Extract and save attachments to the fixed product import folder.
        const downloadDir = importFolder
        const attachmentResult = await processAttachmentsFromParsed({
          accountId: account.id!,
          messageUid: uid,
          messageDate: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
          fromAddress: realFrom,
          subject: realSubject,
          parsed,
          targetDirBase: downloadDir,
          saveSubdir: '',
          extensionFilter: matchingRule?.extensionFilter
        })

        result.foundCount += attachmentResult.total
        result.downloadedCount += attachmentResult.downloaded
        result.skippedCount += attachmentResult.skipped
        result.errorCount += attachmentResult.errored
        if (attachmentResult.errors.length > 0) result.errors.push(...attachmentResult.errors)

        if (matchingRule?.markSeen) {
          try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } catch { /* */ }
        }

        sendProgress(push, {
          phase: 'downloading',
          accountEmail,
          totalMessages: result.totalMessages,
          scannedMessages: result.scannedMessages,
          foundCount: result.foundCount,
          downloadedCount: result.downloadedCount,
          skippedCount: result.skippedCount,
          errorCount: result.errorCount
        })

      } catch (error) {
        if (signal.aborted) break
        const errMsg = error instanceof Error ? error.message : String(error)
        result.errors.push(`邮件 #${uid}: ${errMsg}`)
        result.errorCount++
        await appendMailLog({
          accountId: account.id!,
          level: 'error',
          message: `处理邮件失败 UID=${uid}`,
          detail: errMsg
        })
      }
    }

    const summaryParts = [`共扫描 ${result.totalMessages} 封`]
    if (result.ruleFiltered > 0) summaryParts.push(`${result.ruleFiltered} 封被规则过滤`)
    if (result.downloadedCount > 0) summaryParts.push(`下载 ${result.downloadedCount} 个附件`)
    if (result.downloadedCount === 0 && result.ruleFiltered === 0) summaryParts.push('未发现附件')
    summaryParts.push(`跳过 ${result.skippedCount} 个`)

    sendProgress(push, {
      phase: 'done',
      accountEmail,
      ...result,
      skippedCount: result.skippedCount + result.ruleFiltered,
      message: `完成！${summaryParts.join('，')}`
    })

  } finally {
    abortController = null
    try { await client.logout() } catch { /* ignore */ }
  }

  return result
}

function findMatchingRuleParsed(
  subject: string,
  rules: MailDownloadRule[]
): MailDownloadRule | undefined {
  for (const rule of rules) {
    if (rule.subjectContains) {
      const keywords = rule.subjectContains.split(',').map((k: string) => k.trim()).filter(Boolean)
      const subjLower = subject.toLowerCase()
      if (keywords.some((kw: string) => subjLower.includes(kw.toLowerCase()))) return rule
    } else {
      // No subject filter = matches all
      return rule
    }
  }
  if (rules.length === 0) return undefined // no rules = download all
  return undefined
}

// 软件启动时自动检测，不推送进度到前端
export async function startAutoCheck(daysBack: number): Promise<void> {
  console.log('[mail] 自动检测启动...')
  const accounts = await listMailAccounts()
  if (accounts.length === 0) {
    console.log('[mail] 自动检测：没有已配置的邮箱账号，跳过')
    return
  }
  const noop = (_p: MailCheckProgress): void => {}
  for (const account of accounts) {
    try {
      const r = await connectAndSearch(account.id, daysBack, noop)
      console.log(`[mail] 自动检测完成 [${account.email}]: 扫描${r.totalMessages}封, 下载${r.downloadedCount}个, 跳过${r.skippedCount + r.ruleFiltered}个`)
    } catch (error) {
      console.error(`[mail] 自动检测失败 [${account.email}]:`, error instanceof Error ? error.message : String(error))
    }
  }
}
