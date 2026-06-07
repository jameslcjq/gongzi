import { app, shell } from 'electron'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

export const appDisplayName = '老九的工资系统'
export const laojiuRoot = 'D:\\laojiu'
// 业务数据与安装目录在开发版/正式版分开，避免调试时污染正式工资库。
export const isDevelopmentDataMode = !app.isPackaged
export const dataRoot = process.env.PAYROLL_DATA_ROOT ||
  join(laojiuRoot, isDevelopmentDataMode ? 'gzdata-dev' : 'gzdata')
export const desktopInstallRoot = join(laojiuRoot, isDevelopmentDataMode ? 'gzxt-dev' : 'gzxt')
export const importFolder = process.env.PAYROLL_IMPORT_ROOT || join(laojiuRoot, '工资导入')
export const outputRoot = process.env.PAYROLL_OUTPUT_ROOT || join(dataRoot, '工资数据')
export const tempRoot = process.env.PAYROLL_TEMP_ROOT || join(dataRoot, 'temp')
export const archiveRoot = outputRoot
export const exchangeRoot =
  process.env.PAYROLL_EXCHANGE_ROOT || join(laojiuRoot, '交换包', '工资系统')
export const exchangeInboxFolder = join(exchangeRoot, 'inbox')
export const exchangeImportedFolder = join(exchangeRoot, 'imported')
export const exchangeFailedFolder = join(exchangeRoot, 'failed')
export const exchangeQuarantineFolder = join(exchangeRoot, 'quarantine')
export const exchangeOutboxFolder = join(exchangeRoot, 'outbox')
export const exchangeTempFolder = join(exchangeRoot, 'temp')
export const automationDebugRoot =
  process.env.PAYROLL_AUTOMATION_DEBUG_ROOT || join(dataRoot, 'debug', 'automation')

export function getDataPath(...segments: string[]): string {
  return join(dataRoot, ...segments)
}

export function getImportPath(...segments: string[]): string {
  return join(importFolder, ...segments)
}

export function outputMonthKey(year = new Date().getFullYear(), month = new Date().getMonth() + 1): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

export function getOutputPath(...segments: string[]): string {
  return join(outputRoot, ...segments)
}

export function getTempPath(...segments: string[]): string {
  return join(tempRoot, ...segments)
}

export function getExchangePath(...segments: string[]): string {
  return join(exchangeRoot, ...segments)
}

export function getMonthlyOutputPath(...segments: string[]): string {
  return join(outputRoot, outputMonthKey(), ...segments)
}

export function getPeriodOutputPath(year: number, month: number, ...segments: string[]): string {
  return join(outputRoot, outputMonthKey(year, month), ...segments)
}

export function getMonthlyPayrollTempPath(
  year: number,
  month: number,
  ...segments: string[]
): string {
  return join(tempRoot, '工资报账', outputMonthKey(year, month), ...segments)
}

export function ensureBusinessFolders(): void {
  for (const folder of [
    dataRoot,
    desktopInstallRoot,
    importFolder,
    outputRoot,
    tempRoot,
    exchangeRoot,
    exchangeInboxFolder,
    exchangeImportedFolder,
    exchangeFailedFolder,
    exchangeQuarantineFolder,
    exchangeOutboxFolder,
    exchangeTempFolder,
    automationDebugRoot,
    getImportPath('imported'),
    getImportPath('failed'),
    getImportPath('templates')
  ]) {
    mkdirSync(folder, { recursive: true })
  }
}

export function ensureImportFolderDesktopShortcut(): void {
  ensureBusinessFolders()
  const desktop = app.getPath('desktop')
  mkdirSync(desktop, { recursive: true })
  const outputSuffix = isDevelopmentDataMode ? '-开发' : ''
  ensureDesktopShortcut(join(desktop, '工资导入.lnk'), importFolder, '打开老九的工资系统工资导入文件夹')
  ensureDesktopShortcut(join(desktop, `工资数据${outputSuffix}.lnk`), outputRoot, '打开老九的工资系统工资数据文件夹')
}

function ensureDesktopShortcut(shortcutPath: string, target: string, description: string): void {
  if (shortcutTargetMatches(shortcutPath, target)) return

  if (existsSync(shortcutPath)) {
    try {
      unlinkSync(shortcutPath)
    } catch {
      return
    }
  }

  shell.writeShortcutLink(shortcutPath, {
    target,
    cwd: dirname(target),
    description
  })
}

function shortcutTargetMatches(shortcutPath: string, target: string): boolean {
  if (!existsSync(shortcutPath)) return false

  try {
    return normalize(shell.readShortcutLink(shortcutPath).target).toLowerCase() === normalize(target).toLowerCase()
  } catch {
    return false
  }
}
