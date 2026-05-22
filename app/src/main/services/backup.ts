import { app, dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDataPath } from '../config/paths'
import { exec, getDatabase, getDatabasePath } from '../db/connection'
import type { BackupSummary } from '../../shared/types'

export function getBackupFolder(): string {
  const folder = getDataPath('backups')
  mkdirSync(folder, { recursive: true })
  return folder
}

export function listBackups(): BackupSummary[] {
  const folder = getBackupFolder()
  if (!existsSync(folder)) return []

  return readdirSync(folder)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const filePath = join(folder, name)
      const stat = statSync(filePath)
      return {
        fileName: name,
        filePath,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString()
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function createBackup(): Promise<BackupSummary> {
  const source = getDatabasePath()
  if (!source || !existsSync(source)) {
    throw new Error('数据库尚未初始化，无法备份')
  }

  const database = await getDatabase()
  await exec(database, 'PRAGMA wal_checkpoint(TRUNCATE);')

  const folder = getBackupFolder()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `salary-system-${stamp}.sqlite`
  const filePath = join(folder, fileName)
  copyFileSync(source, filePath)
  const stat = statSync(filePath)

  return {
    fileName,
    filePath,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString()
  }
}

export async function restoreBackup(fileName: string): Promise<BackupSummary> {
  const folder = getBackupFolder()
  const sourcePath = join(folder, fileName)
  if (!existsSync(sourcePath)) {
    throw new Error('备份文件不存在')
  }

  const target = getDatabasePath()
  if (!target) throw new Error('数据库路径未初始化')

  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    title: '恢复备份',
    message: `将用 ${fileName} 覆盖当前数据库，确认后程序需要重启。`,
    buttons: ['确认覆盖并重启', '取消'],
    cancelId: 1,
    defaultId: 1
  })

  if (confirmation.response !== 0) {
    throw new Error('用户取消恢复')
  }

  copyFileSync(sourcePath, target)
  const stat = statSync(target)

  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 200)

  return {
    fileName,
    filePath: sourcePath,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString()
  }
}
