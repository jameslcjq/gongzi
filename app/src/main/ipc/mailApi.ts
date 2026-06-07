import { dialog, shell } from 'electron'
import * as accountService from '../services/mail/mailAccountService'
import * as ruleService from '../services/mail/mailRuleService'
import * as imapService from '../services/mail/mailImapService'
import * as logService from '../services/mail/downloadLogService'
import * as recordService from '../services/mail/downloadRecordService'
import { createLicensedIpcMain } from './appApi'
import type { MailAccountView, MailDownloadRule, MailDownloadLog, MailDownloadRecord, MailCheckProgress } from '../../shared/types'

export function registerMailIpc(): void {
  const ipcMain = createLicensedIpcMain()

  // --- 邮箱账号 ---
  ipcMain.handle('mail:account-list', async (): Promise<MailAccountView[]> => {
    return accountService.listMailAccounts()
  })

  ipcMain.handle('mail:account-save', async (_event, data): Promise<MailAccountView> => {
    return accountService.saveMailAccount(data)
  })

  ipcMain.handle('mail:account-delete', async (_event, id: number): Promise<void> => {
    return accountService.deleteMailAccount(id)
  })

  ipcMain.handle('mail:account-test', async (_event, data): Promise<{ ok: boolean; message: string }> => {
    return accountService.testMailAccount(data)
  })

  // --- 下载规则 ---
  ipcMain.handle('mail:rule-list', async (_event, accountId?: number): Promise<MailDownloadRule[]> => {
    return ruleService.listMailRules(accountId)
  })

  ipcMain.handle('mail:rule-save', async (_event, data): Promise<MailDownloadRule> => {
    return ruleService.saveMailRule(data)
  })

  ipcMain.handle('mail:rule-delete', async (_event, id: number): Promise<void> => {
    return ruleService.deleteMailRule(id)
  })

  // --- 检查邮件 ---
  let checkRunning = false

  ipcMain.handle('mail:check', async (event, request?: { accountId?: number; daysBack?: number }) => {
    if (checkRunning) return { ok: false, reason: '已有检查任务正在运行' }
    checkRunning = true

    const daysBack = request?.daysBack ?? 30

    const pushProgress = (progress: MailCheckProgress): void => {
      event.sender.send('mail:check-progress', progress)
    }

    const results: { totalMessages: number; scannedMessages: number; foundCount: number; downloadedCount: number; skippedCount: number; errorCount: number; ruleFiltered: number; errors: string[] } = { totalMessages: 0, scannedMessages: 0, foundCount: 0, downloadedCount: 0, skippedCount: 0, errorCount: 0, ruleFiltered: 0, errors: [] }

    try {
      if (request?.accountId) {
        const r = await imapService.connectAndSearch(request.accountId, daysBack, pushProgress)
        Object.assign(results, r)
      } else {
        const accounts = await accountService.listMailAccounts()
        if (accounts.length === 0) {
          pushProgress({
            phase: 'done',
            message: '没有已配置的邮箱账号，请先添加邮箱账号'
          })
          checkRunning = false
          return { ok: true, totalMessages: 0, scannedMessages: 0, foundCount: 0, downloadedCount: 0, skippedCount: 0, errorCount: 0, errors: [] as string[], ruleFiltered: 0 }
        }
        for (const account of accounts) {
          const r = await imapService.connectAndSearch(account.id, daysBack, pushProgress)
          results.totalMessages += r.totalMessages
          results.scannedMessages += r.scannedMessages
          results.foundCount += r.foundCount
          results.downloadedCount += r.downloadedCount
          results.skippedCount += r.skippedCount
          results.errorCount += r.errorCount
          results.ruleFiltered += r.ruleFiltered
          results.errors.push(...r.errors)
        }
      }
      return { ok: true, ...results }
    } catch (error) {
      console.error('[mail:check]', error)
      let reason: string
      if (error instanceof AggregateError && error.errors.length > 0) {
        reason = error.errors
          .map((e: unknown) => (e instanceof Error ? e.message : String(e)))
          .join('; ')
      } else if (error instanceof Error && error.message) {
        reason = error.message
      } else if (error instanceof Error) {
        reason = `未知错误 (${error.constructor.name})`
      } else if (typeof error === 'string') {
        reason = error
      } else {
        reason = `未知错误 (${Object.prototype.toString.call(error)})`
      }
      pushProgress({
        phase: 'done',
        message: `检查失败：${reason}`
      })
      return { ok: false, reason }
    } finally {
      checkRunning = false
    }
  })

  ipcMain.handle('mail:check-stop', async () => {
    imapService.stopCheck()
  })

  // --- 文件夹列表 ---
  ipcMain.handle('mail:folder-list', async (_event, accountId: number): Promise<string[]> => {
    return accountService.listMailFolders(accountId)
  })

  // --- 下载日志 ---
  ipcMain.handle('mail:log-list', async (_event, accountId?: number, level?: string, limit?: number, offset?: number): Promise<MailDownloadLog[]> => {
    return logService.listMailLogs(accountId, level, limit ?? 200, offset ?? 0)
  })

  ipcMain.handle('mail:log-clear', async (_event, accountId?: number): Promise<number> => {
    return logService.clearMailLogs(accountId)
  })

  // --- 选择/打开目录 ---
  ipcMain.handle('mail:choose-dir', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择附件保存目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('mail:open-dir', async (_event, dirPath: string) => {
    await shell.openPath(dirPath)
  })

  // --- 下载记录 ---
  ipcMain.handle('mail:record-list', async (_event, limit?: number, offset?: number): Promise<MailDownloadRecord[]> => {
    return recordService.listMailDownloadRecords(limit ?? 200, offset ?? 0)
  })

  ipcMain.handle('mail:record-clear', async (_event, accountId?: number): Promise<number> => {
    return recordService.clearMailDownloadRecords(accountId)
  })
}
