import { app, shell } from 'electron'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

export const appDisplayName = '老九的工资系统'
export const laojiuRoot = 'D:\\laojiu'
export const isDevelopmentDataMode = !app.isPackaged
export const dataRoot = process.env.PAYROLL_DATA_ROOT ||
  join(laojiuRoot, isDevelopmentDataMode ? 'gzdata-dev' : 'gzdata')
export const desktopInstallRoot = join(laojiuRoot, isDevelopmentDataMode ? 'gzxt-dev' : 'gzxt')
export const importFolder = process.env.PAYROLL_IMPORT_ROOT || join(laojiuRoot, '工资导入')
export const outputRoot = process.env.PAYROLL_OUTPUT_ROOT || join(dataRoot, '工资数据')
export const archiveRoot = outputRoot

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

export function getMonthlyOutputPath(...segments: string[]): string {
  return join(outputRoot, outputMonthKey(), ...segments)
}

export function getPeriodOutputPath(year: number, month: number, ...segments: string[]): string {
  return join(outputRoot, outputMonthKey(year, month), ...segments)
}

export function ensureBusinessFolders(): void {
  for (const folder of [
    dataRoot,
    desktopInstallRoot,
    importFolder,
    outputRoot,
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
