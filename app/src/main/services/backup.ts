import { app, dialog } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import {
  dataRoot,
  exchangeRoot,
  ensureBusinessFolders,
  importFolder,
  payrollInstance
} from '../config/paths'
import { closeDatabase, exec, getDatabase, getDatabasePath } from '../db/connection'
import { getCachedLicenseStatus } from './licenseService'
import type { BackupSummary, FullBackupSummary } from '../../shared/types'

type BackupRootKey = 'data' | 'import' | 'exchange'

type FullBackupFileEntry = {
  root: BackupRootKey
  relativePath: string
  zipPath: string
  sizeBytes: number
  sha256: string
}

type FullBackupManifest = {
  format: typeof FULL_BACKUP_FORMAT
  version: 1
  appName: string
  appVersion: string
  createdAt: string
  sourceInstance: {
    id: string
    displayName: string
    dataRoot: string
    importFolder: string
    exchangeRoot: string
  }
  contains: {
    database: boolean
    dataFiles: number
    importFiles: number
    exchangeFiles: number
  }
  excluded: string[]
  files: FullBackupFileEntry[]
}

const FULL_BACKUP_FORMAT = 'laojiu.salary-system.full-backup'
const FULL_BACKUP_EXTENSION = 'ljgzbackup'
const FULL_BACKUP_FILTER = { name: '老九工资系统完整备份', extensions: [FULL_BACKUP_EXTENSION] }
const DATA_ROOT_EXCLUDED_NAMES = new Set(['backups', 'license', 'userdata', 'temp', 'debug'])
const BACKUP_FILE_EXTENSIONS = new Set(['.ljgzbackup'])
const SQLITE_VOLATILE_FILES = new Set(['salary-system.sqlite-wal', 'salary-system.sqlite-shm'])

export function getBackupFolder(): string {
  const folder = join(dataRoot, 'backups')
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
  const source = await checkpointDatabase()
  const folder = getBackupFolder()
  const stamp = buildTimestamp()
  const fileName = `salary-system-${stamp}.sqlite`
  const filePath = join(folder, fileName)
  await copyFile(source, filePath)
  const fileStat = await stat(filePath)

  return {
    fileName,
    filePath,
    sizeBytes: fileStat.size,
    createdAt: fileStat.mtime.toISOString()
  }
}

// 每日自动备份（R-10）：启动时检查，最近 24 小时内没有备份就自动建一份；
// 并把数据库备份裁剪到最近 keep 份（手动备份与自动备份同等对待，只按时间排序）。
export async function runDailyAutoBackup(keep = 14): Promise<BackupSummary | null> {
  const backups = listBackups()
  const newest = backups[0]
  const dayMs = 24 * 60 * 60 * 1000
  let created: BackupSummary | null = null
  if (!newest || Date.now() - new Date(newest.createdAt).getTime() > dayMs) {
    created = await createBackup()
    console.info(`每日自动备份完成：${created.fileName}`)
  }
  const afterList = listBackups()
  for (const extra of afterList.slice(keep)) {
    try {
      await rm(extra.filePath, { force: true })
    } catch {
      /* 清理失败不影响业务 */
    }
  }
  return created
}

export async function restoreBackup(fileName: string): Promise<BackupSummary> {
  const folder = getBackupFolder()
  const sourcePath = join(folder, fileName)
  if (!existsSync(sourcePath)) {
    throw new Error('备份文件不存在')
  }

  await getDatabase()
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

  // 恢复前先给"当前库"留快照（R-10）：万一选错了备份文件，这一步是唯一的后悔药。
  const preRestoreName = `salary-system-恢复前快照-${buildTimestamp()}.sqlite`
  try {
    const checkpointed = await checkpointDatabase()
    await copyFile(checkpointed, join(folder, preRestoreName))
  } catch (error) {
    console.warn('恢复前快照创建失败（继续恢复）', error)
  }

  await closeDatabase()
  await copyFile(sourcePath, target)
  const fileStat = await stat(target)
  relaunchSoon()

  return {
    fileName,
    filePath: sourcePath,
    sizeBytes: fileStat.size,
    createdAt: fileStat.mtime.toISOString()
  }
}

export async function createFullBackup(): Promise<FullBackupSummary | null> {
  const stamp = buildTimestamp()
  const defaultPath = join(getBackupFolder(), `工资系统完整备份-${stamp}.${FULL_BACKUP_EXTENSION}`)
  const picked = await dialog.showSaveDialog({
    title: '保存完整数据备份',
    defaultPath,
    filters: [FULL_BACKUP_FILTER, { name: '所有文件', extensions: ['*'] }]
  })
  if (picked.canceled || !picked.filePath) return null

  const destinationPath = ensureBackupExtension(picked.filePath)
  return buildFullBackupPackage(destinationPath)
}

export async function restoreFullBackup(): Promise<FullBackupSummary | null> {
  const picked = await dialog.showOpenDialog({
    title: '选择完整数据备份',
    properties: ['openFile'],
    filters: [FULL_BACKUP_FILTER, { name: '所有文件', extensions: ['*'] }]
  })
  if (picked.canceled || picked.filePaths.length === 0) return null

  const sourcePath = picked.filePaths[0]
  const buffer = await readFile(sourcePath)
  const zip = await JSZip.loadAsync(buffer)
  const manifest = await readFullBackupManifest(zip)
  const targetLicense = await getCachedLicenseStatus()
  if (!targetLicense.valid) {
    throw new Error(targetLicense.message || '当前电脑未完成授权校验，不能恢复完整备份')
  }

  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    title: '恢复完整数据备份',
    message: `将恢复 ${basename(sourcePath)} 中的完整业务数据，确认后程序需要重启。`,
    detail:
      '恢复会覆盖当前业务数据库、工资数据文件夹、工资导入文件夹和交换包文件夹；当前电脑的授权、备份库、登录缓存不会被覆盖。恢复前系统会自动保存一份当前完整备份。',
    buttons: ['确认恢复并重启', '取消'],
    cancelId: 1,
    defaultId: 1
  })
  if (confirmation.response !== 0) {
    throw new Error('用户取消恢复')
  }

  await createPreRestoreFullBackup()
  await closeDatabase()
  await clearDirectoryContents(dataRoot, DATA_ROOT_EXCLUDED_NAMES)
  await clearDirectoryContents(importFolder)
  await clearDirectoryContents(exchangeRoot)

  let restoredFiles = 0
  for (const entry of manifest.files) {
    validateManifestEntry(entry)
    const zipFile = zip.file(entry.zipPath)
    if (!zipFile) throw new Error(`完整备份包缺少文件：${entry.zipPath}`)
    const bytes = await zipFile.async('nodebuffer')
    const actualSha256 = sha256(bytes)
    if (actualSha256 !== entry.sha256) {
      throw new Error(`完整备份包文件校验失败：${entry.relativePath}`)
    }
    const targetPath = resolveManagedRestorePath(entry.root, entry.relativePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, bytes)
    restoredFiles++
  }

  ensureBusinessFolders()
  removeStaleSqliteWalFiles()
  relaunchSoon()

  const fileStat = await stat(sourcePath)
  return {
    fileName: basename(sourcePath),
    filePath: sourcePath,
    sizeBytes: fileStat.size,
    createdAt: fileStat.mtime.toISOString(),
    includedFiles: restoredFiles,
    databaseIncluded: manifest.contains.database,
    importFolderIncluded: manifest.contains.importFiles > 0,
    exchangeFolderIncluded: manifest.contains.exchangeFiles > 0
  }
}

async function checkpointDatabase(): Promise<string> {
  const database = await getDatabase()
  // SQLite 使用 WAL 时，新数据可能还在 -wal 文件中；复制或打包主库前先 checkpoint。
  await exec(database, 'PRAGMA wal_checkpoint(TRUNCATE);')
  const source = getDatabasePath()
  if (!source || !existsSync(source)) {
    throw new Error('数据库尚未初始化，无法备份')
  }
  return source
}

async function buildFullBackupPackage(destinationPath: string): Promise<FullBackupSummary> {
  await checkpointDatabase()
  const zip = new JSZip()
  const files: FullBackupFileEntry[] = []

  files.push(
    ...(await appendFolderToZip(zip, 'data', dataRoot, {
      excludeRootNames: DATA_ROOT_EXCLUDED_NAMES,
      excludeFileNames: SQLITE_VOLATILE_FILES
    })),
    ...(await appendFolderToZip(zip, 'import', importFolder)),
    ...(await appendFolderToZip(zip, 'exchange', exchangeRoot, {
      excludeRootNames: new Set(['temp'])
    }))
  )

  const manifest: FullBackupManifest = {
    format: FULL_BACKUP_FORMAT,
    version: 1,
    appName: app.getName(),
    appVersion: app.getVersion(),
    createdAt: new Date().toISOString(),
    sourceInstance: {
      id: payrollInstance.id,
      displayName: payrollInstance.displayName,
      dataRoot,
      importFolder,
      exchangeRoot
    },
    contains: {
      database: files.some((entry) => entry.root === 'data' && entry.relativePath === 'salary-system.sqlite'),
      dataFiles: files.filter((entry) => entry.root === 'data').length,
      importFiles: files.filter((entry) => entry.root === 'import').length,
      exchangeFiles: files.filter((entry) => entry.root === 'exchange').length
    },
    excluded: ['授权文件', '授权缓存', '备份库', '网页登录缓存', '临时文件', '调试日志'],
    files
  }
  zip.file('manifest.json', stableJson(manifest))

  await mkdir(dirname(destinationPath), { recursive: true })
  const packageBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
  await writeFile(destinationPath, packageBuffer)
  const fileStat = await stat(destinationPath)

  return {
    fileName: basename(destinationPath),
    filePath: destinationPath,
    sizeBytes: fileStat.size,
    createdAt: fileStat.mtime.toISOString(),
    includedFiles: files.length,
    databaseIncluded: manifest.contains.database,
    importFolderIncluded: manifest.contains.importFiles > 0,
    exchangeFolderIncluded: manifest.contains.exchangeFiles > 0
  }
}

async function appendFolderToZip(
  zip: JSZip,
  rootKey: BackupRootKey,
  folderPath: string,
  options: {
    excludeRootNames?: Set<string>
    excludeFileNames?: Set<string>
  } = {}
): Promise<FullBackupFileEntry[]> {
  if (!existsSync(folderPath)) return []
  const entries: FullBackupFileEntry[] = []

  async function walk(currentFolder: string, relativeParts: string[]): Promise<void> {
    const children = await readdir(currentFolder, { withFileTypes: true })
    for (const child of children) {
      const lowerName = child.name.toLowerCase()
      if (relativeParts.length === 0 && options.excludeRootNames?.has(lowerName)) continue
      if (child.isDirectory()) {
        await walk(join(currentFolder, child.name), [...relativeParts, child.name])
        continue
      }
      if (!child.isFile()) continue
      if (options.excludeFileNames?.has(lowerName)) continue
      if (isBackupPackageFile(lowerName)) continue

      const sourcePath = join(currentFolder, child.name)
      const relativePath = [...relativeParts, child.name].join('/')
      assertSafeRelativePath(relativePath)
      const fileBuffer = await readFile(sourcePath)
      const fileStat = await stat(sourcePath)
      const zipPath = `${rootKey}/${relativePath}`
      zip.file(zipPath, fileBuffer, { date: fileStat.mtime })
      entries.push({
        root: rootKey,
        relativePath,
        zipPath,
        sizeBytes: fileStat.size,
        sha256: sha256(fileBuffer)
      })
    }
  }

  await walk(folderPath, [])
  return entries
}

async function readFullBackupManifest(zip: JSZip): Promise<FullBackupManifest> {
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile) throw new Error('完整备份包缺少 manifest.json')
  const manifest = JSON.parse(await manifestFile.async('string')) as FullBackupManifest
  if (manifest.format !== FULL_BACKUP_FORMAT) {
    throw new Error('这不是老九工资系统完整备份包')
  }
  if (manifest.version !== 1) {
    throw new Error(`不支持的完整备份版本：${manifest.version}`)
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('完整备份包清单无效')
  }
  for (const entry of manifest.files) validateManifestEntry(entry)
  return manifest
}

function validateManifestEntry(entry: FullBackupFileEntry): void {
  if (!entry || !['data', 'import', 'exchange'].includes(entry.root)) {
    throw new Error('完整备份包包含无效文件根目录')
  }
  assertSafeRelativePath(entry.relativePath)
  const pathParts = entry.relativePath.split('/')
  const firstPart = pathParts[0]?.toLowerCase() || ''
  const fileName = pathParts[pathParts.length - 1]?.toLowerCase() || ''
  if (entry.root === 'data' && DATA_ROOT_EXCLUDED_NAMES.has(firstPart)) {
    throw new Error('完整备份包不能覆盖授权、备份库或本机缓存目录')
  }
  if (entry.root === 'data' && SQLITE_VOLATILE_FILES.has(fileName)) {
    throw new Error('完整备份包不能包含 SQLite 临时锁文件')
  }
  if (isBackupPackageFile(fileName)) {
    throw new Error('完整备份包不能嵌套其他完整备份包')
  }
  if (entry.zipPath !== `${entry.root}/${entry.relativePath}`) {
    throw new Error('完整备份包文件路径不一致')
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) {
    throw new Error('完整备份包文件校验信息无效')
  }
}

async function createPreRestoreFullBackup(): Promise<void> {
  const stamp = buildTimestamp()
  const destinationPath = join(getBackupFolder(), `恢复前完整备份-${stamp}.${FULL_BACKUP_EXTENSION}`)
  try {
    await buildFullBackupPackage(destinationPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`恢复前自动备份当前数据失败，已停止恢复：${message}`)
  }
}

async function clearDirectoryContents(folderPath: string, preserveNames = new Set<string>()): Promise<void> {
  assertManagedFolder(folderPath)
  await mkdir(folderPath, { recursive: true })
  const children = await readdir(folderPath, { withFileTypes: true })
  for (const child of children) {
    if (preserveNames.has(child.name.toLowerCase())) continue
    await rm(join(folderPath, child.name), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200
    })
  }
}

function resolveManagedRestorePath(rootKey: BackupRootKey, relativePath: string): string {
  const rootPath = rootKey === 'data' ? dataRoot : rootKey === 'import' ? importFolder : exchangeRoot
  const target = resolve(rootPath, ...relativePath.split('/'))
  const normalizedRoot = resolve(rootPath).toLowerCase()
  const normalizedTarget = target.toLowerCase()
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot + sep)) {
    throw new Error('完整备份包包含越界文件路径')
  }
  return target
}

function assertManagedFolder(folderPath: string): void {
  const normalized = resolve(folderPath).toLowerCase()
  const allowed = [dataRoot, importFolder, exchangeRoot].map((item) => resolve(item).toLowerCase())
  if (!allowed.includes(normalized)) {
    throw new Error(`拒绝清理非业务目录：${folderPath}`)
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0')) {
    throw new Error('完整备份包包含无效文件路径')
  }
  if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error('完整备份包包含绝对路径')
  }
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('完整备份包包含越界文件路径')
  }
}

function removeStaleSqliteWalFiles(): void {
  const dbPath = join(dataRoot, 'salary-system.sqlite')
  for (const suffix of ['-wal', '-shm']) {
    const path = `${dbPath}${suffix}`
    if (existsSync(path)) {
      rm(path, { force: true }).catch(() => {})
    }
  }
}

function relaunchSoon(): void {
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 200)
}

function ensureBackupExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith(`.${FULL_BACKUP_EXTENSION}`)
    ? filePath
    : `${filePath}.${FULL_BACKUP_EXTENSION}`
}

function isBackupPackageFile(lowerName: string): boolean {
  return Array.from(BACKUP_FILE_EXTENSIONS).some((extension) => lowerName.endsWith(extension))
}

function buildTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
