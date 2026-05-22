import { app, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const appDisplayName = '老九的工资系统'
export const dataRoot = 'D:\\laojiu\\gzxt\\data'
export const desktopInstallRoot = 'D:\\laojiu\\gzxt\\desktop'
export const importFolder = 'D:\\laojiu\\工资导入'
export const archiveRoot = join(dataRoot, '工资存档')

export function getDataPath(...segments: string[]): string {
  return join(dataRoot, ...segments)
}

export function getImportPath(...segments: string[]): string {
  return join(importFolder, ...segments)
}

export function ensureBusinessFolders(): void {
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
