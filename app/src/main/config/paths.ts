import { app, shell } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const appDisplayName = '老九的工资系统'
export const dataRoot = 'D:\\laojiu\\gzdata'
export const legacyDataRoot = 'D:\\laojiu\\gzxt\\data'
export const desktopInstallRoot = 'D:\\laojiu\\gzxt'
export const importFolder = 'D:\\laojiu\\工资导入'
export const archiveRoot = join(dataRoot, '工资存档')

export function getDataPath(...segments: string[]): string {
  return join(dataRoot, ...segments)
}

export function getImportPath(...segments: string[]): string {
  return join(importFolder, ...segments)
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

export function ensureBusinessFolders(): void {
  migrateLegacyDataRoot()

  for (const folder of [
    dataRoot,
    desktopInstallRoot,
    importFolder,
    archiveRoot,
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
  const shortcutPath = join(desktop, '工资导入.lnk')

  if (existsSync(shortcutPath)) return

  shell.writeShortcutLink(shortcutPath, {
    target: importFolder,
    cwd: dirname(importFolder),
    description: '打开老九的工资系统工资导入文件夹'
  })
}
