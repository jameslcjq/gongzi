import { app, shell } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

export const appDisplayName = '老九的工资系统'
export const laojiuRoot = 'D:\\laojiu'
export const isDevelopmentDataMode = !app.isPackaged
export const dataRoot = process.env.PAYROLL_DATA_ROOT ||
  join(laojiuRoot, isDevelopmentDataMode ? 'gzdata-dev' : 'gzdata')
export const legacyDataRoot = join(laojiuRoot, 'gzxt', 'data')
export const desktopInstallRoot = join(laojiuRoot, isDevelopmentDataMode ? 'gzxt-dev' : 'gzxt')
export const importFolder = process.env.PAYROLL_IMPORT_ROOT || join(laojiuRoot, '工资导入')
export const legacyImportFolders = [join(laojiuRoot, '工资导入-dev')]
export const outputRoot = process.env.PAYROLL_OUTPUT_ROOT || join(dataRoot, '工资数据')
export const legacyOutputRoot = join(dataRoot, '数据输出')
export const archiveRoot = outputRoot

const legacyAppDataFolderNames = [
  'salary-system-electron',
  appDisplayName
]

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

export function getLegacyDatabasePaths(): string[] {
  const appDataRoot = app.getPath('appData')
  return [
    join(legacyDataRoot, 'salary-system.sqlite'),
    ...legacyAppDataFolderNames.map((name) => join(appDataRoot, name, 'salary-system.sqlite'))
  ].filter((filePath, index, items) =>
    filePath !== getDataPath('salary-system.sqlite') && items.indexOf(filePath) === index
  )
}

function copyMissingData(source: string, target: string): void {
  if (!existsSync(source)) return

  mkdirSync(target, { recursive: true })

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)

    if (entry.isDirectory()) {
      copyMissingData(sourcePath, targetPath)
      continue
    }

    if (!entry.isFile() || existsSync(targetPath)) continue

    try {
      if (statSync(sourcePath).size >= 0) {
        cpSync(sourcePath, targetPath, { force: false, errorOnExist: false })
      }
    } catch {
      // 数据迁移是兜底保护，单个文件失败不阻止程序启动。
    }
  }
}

export function migrateLegacyDataRoot(): void {
  if (!existsSync(legacyDataRoot)) return
  copyMissingData(legacyDataRoot, dataRoot)
}

export function migrateLegacyOutputRoot(): void {
  if (process.env.PAYROLL_OUTPUT_ROOT || !existsSync(legacyOutputRoot)) return
  copyMissingData(legacyOutputRoot, outputRoot)
}

export function ensureBusinessFolders(): void {
  migrateLegacyDataRoot()
  migrateLegacyOutputRoot()

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
  removeObsoleteDesktopShortcut(join(desktop, '工资导入-开发.lnk'))
  removeObsoleteDesktopShortcut(join(desktop, '数据输出-开发.lnk'))
  removeObsoleteDesktopShortcut(join(desktop, '数据输出.lnk'))
  const outputSuffix = isDevelopmentDataMode ? '-开发' : ''
  ensureDesktopShortcut(join(desktop, '工资导入.lnk'), importFolder, '打开老九的工资系统工资导入文件夹')
  ensureDesktopShortcut(join(desktop, `工资数据${outputSuffix}.lnk`), outputRoot, '打开老九的工资系统工资数据文件夹')
}

function removeObsoleteDesktopShortcut(shortcutPath: string): void {
  if (!existsSync(shortcutPath)) return

  try {
    unlinkSync(shortcutPath)
  } catch {
    // 删除旧快捷方式只是整理桌面，失败不影响主流程。
  }
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
