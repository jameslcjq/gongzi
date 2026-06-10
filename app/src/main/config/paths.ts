import { app, shell } from 'electron'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import {
  buildPayrollInstanceSummary,
  resolvePayrollInstanceId
} from '../../shared/payrollInstance'

export const laojiuRoot = 'D:\\laojiu'
// 业务数据与安装目录在开发版/正式版分开，避免调试时污染正式工资库。
export const isDevelopmentDataMode = !app.isPackaged
export const payrollInstance = buildPayrollInstanceSummary({
  id: resolvePayrollInstanceId({
    env: process.env,
    argv: process.argv,
    execPath: process.execPath,
    appName: app.getName()
  }),
  isDevelopment: isDevelopmentDataMode,
  env: process.env
})
if (payrollInstance.userDataRoot) {
  mkdirSync(payrollInstance.userDataRoot, { recursive: true })
  app.setPath('userData', payrollInstance.userDataRoot)
}
export const appDisplayName = payrollInstance.displayName
export const dataRoot = payrollInstance.dataRoot
export const desktopInstallRoot = payrollInstance.installRoot
export const importFolder = payrollInstance.importFolder
export const outputRoot = payrollInstance.outputRoot
export const tempRoot = payrollInstance.tempRoot
export const archiveRoot = outputRoot
export const exchangeRoot = payrollInstance.exchangeRoot
export const portalPartitionPrefix = payrollInstance.portalPartitionPrefix
export const exchangeInboxFolder = join(exchangeRoot, 'inbox')
export const exchangeImportedFolder = join(exchangeRoot, 'imported')
export const exchangeFailedFolder = join(exchangeRoot, 'failed')
export const exchangeQuarantineFolder = join(exchangeRoot, 'quarantine')
export const exchangeOutboxFolder = join(exchangeRoot, 'outbox')
export const exchangeTempFolder = join(exchangeRoot, 'temp')
export const automationDebugRoot =
  process.env.PAYROLL_AUTOMATION_DEBUG_ROOT || join(dataRoot, 'debug', 'automation')

// 文件读取类 IPC 的路径白名单：只允许读业务目录树内的文件，
// 防止任意盘符路径经渲染层（或未来被误暴露的通道）外带文件内容。
const businessReadRoots = [dataRoot, importFolder, outputRoot, tempRoot, exchangeRoot]

export function assertInsideBusinessRoots(filePath: string, label = '文件'): void {
  const normalized = normalize(filePath || '').toLowerCase()
  const ok = businessReadRoots.some((root) => {
    const prefix = normalize(root).toLowerCase()
    return normalized === prefix || normalized.startsWith(prefix + '\\') || normalized.startsWith(prefix + '/')
  })
  if (!ok) {
    throw new Error(
      `${label}路径不在业务目录内，已拒绝读取：${filePath}。允许的根目录：数据目录、工资导入、工资数据、temp、交换目录`
    )
  }
}

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
  const importSuffix = payrollInstance.shortcutSuffix
  const outputSuffix = payrollInstance.shortcutSuffix || (isDevelopmentDataMode ? '-开发' : '')
  ensureDesktopShortcut(
    join(desktop, `工资导入${importSuffix}.lnk`),
    importFolder,
    `打开${appDisplayName}工资导入文件夹`
  )
  ensureDesktopShortcut(
    join(desktop, `工资数据${outputSuffix}.lnk`),
    outputRoot,
    `打开${appDisplayName}工资数据文件夹`
  )
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
