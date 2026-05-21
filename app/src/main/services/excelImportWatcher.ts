import { app, dialog, shell } from 'electron'
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { all, get, getDatabase, run } from '../db/connection'
import type {
  AnnualAdjustmentDetectedFiles,
  ExcelImportLog,
  ImportWatcherStatus,
  MonthlyPayrollDetectedFiles
} from '../../shared/types'
import { commitExcelImport } from './excelImport'
import { inferWorksheet } from './worksheetInference'
import { isPersonnelExpensePlanWorkbook } from './budget/personnelExpensePlanPrefill'

const importableExtensions = new Set(['.xlsx', '.xls', '.csv'])
const memoryLogs: ExcelImportLog[] = []

let importQueue: Promise<unknown> = Promise.resolve()

function enqueueImport<T>(task: () => Promise<T>): Promise<T> {
  const next = importQueue.then(task, task)
  importQueue = next.catch(() => undefined)
  return next
}
const preferredImportFolder = 'D:\\laojiu\\Import'
const importFolderSettingKey = 'excel_import_folder'

let watcher: FSWatcher | undefined
let folderPath = ''
let running = false

export async function startExcelImportWatcher(customFolderPath?: string): Promise<ImportWatcherStatus> {
  if (customFolderPath) {
    folderPath = customFolderPath
    await persistImportFolder(folderPath)
  } else if (!folderPath) {
    folderPath = (await readPersistedImportFolder()) || resolveDefaultFolder()
  }

  ensureImportFolders(folderPath)

  if (watcher) {
    await watcher.close()
  }

  watcher = chokidar.watch(folderPath, {
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1200,
      pollInterval: 250
    },
    ignored: (path) =>
      path.includes(`${folderPath}\\imported`) ||
      path.includes(`${folderPath}\\failed`) ||
      path.includes(`${folderPath}/imported`) ||
      path.includes(`${folderPath}/failed`)
  })

  watcher.on('add', (filePath) => {
    void enqueueImport(() => importExcelFile(filePath))
  })

  running = true
  return getImportWatcherStatus()
}

export async function stopExcelImportWatcher(): Promise<ImportWatcherStatus> {
  if (watcher) {
    await watcher.close()
    watcher = undefined
  }

  running = false
  return getImportWatcherStatus()
}

export async function getImportWatcherStatus(): Promise<ImportWatcherStatus> {
  if (!folderPath) {
    folderPath = (await readPersistedImportFolder()) || resolveDefaultFolder()
  }
  ensureImportFolders(folderPath)

  return {
    folderPath,
    templateFolderPath: getTemplateFolderPath(),
    running,
    logs: await readRecentImportLogs(),
    monthlyPayroll: detectMonthlyPayrollFiles(folderPath),
    annualAdjustment: detectAnnualAdjustmentFiles(folderPath)
  }
}

export async function clearImportWatcherLogs(): Promise<ImportWatcherStatus> {
  memoryLogs.splice(0)
  const database = await getDatabase()
  await run(database, `DELETE FROM import_logs`)
  return getImportWatcherStatus()
}

export async function openImportWatcherFolder(): Promise<ImportWatcherStatus> {
  if (!folderPath) {
    folderPath = (await readPersistedImportFolder()) || resolveDefaultFolder()
  }
  ensureImportFolders(folderPath)
  await shell.openPath(folderPath)
  return getImportWatcherStatus()
}

export async function chooseImportWatcherFolder(): Promise<ImportWatcherStatus> {
  const result = await dialog.showOpenDialog({
    title: '选择 Excel 自动导入文件夹',
    properties: ['openDirectory', 'createDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return getImportWatcherStatus()
  }

  return startExcelImportWatcher(result.filePaths[0])
}

async function readRecentImportLogs(): Promise<ExcelImportLog[]> {
  const database = await getDatabase()
  const persistedLogs = await all<{
    file_name: string
    worksheet_name: string | null
    ok: number
    imported_rows: number
    message: string | null
    batch_id: number | null
    created_at: string
  }>(
    database,
    `
      SELECT file_name, worksheet_name, ok, imported_rows, message, batch_id, created_at
      FROM import_logs
      ORDER BY id DESC
      LIMIT 50
    `
  )

  if (persistedLogs.length === 0) return memoryLogs.slice(0, 50)

  return persistedLogs.map((log) => ({
    fileName: log.file_name,
    worksheetName: log.worksheet_name ?? undefined,
    ok: log.ok === 1,
    importedRows: log.imported_rows,
    message: log.message ?? '',
    batchId: log.batch_id ?? undefined,
    createdAt: log.created_at
  }))
}

async function importExcelFile(filePath: string): Promise<void> {
  const extension = extname(filePath).toLowerCase()
  if (!importableExtensions.has(extension) || basename(filePath).startsWith('~$')) return
  if (isReservedWorkflowFile(filePath)) {
    pushMemoryLog({
      fileName: basename(filePath),
      worksheetName: isPersonnelExpensePlanWorkbook(filePath)
        ? '人员经费核对'
        : isAnnualAdjustmentFile(filePath)
          ? '社保个税'
          : '工资报账',
      ok: true,
      importedRows: 0,
      message: '已识别为专项处理文件，保留在监控文件夹供业务模块使用',
      createdAt: new Date().toISOString()
    })
    return
  }

  try {
    const result = inferWorksheet(filePath)
    if (!result.worksheet) {
      throw new Error(result.reason || '未匹配到工作表')
    }
    const worksheet = result.worksheet

    const summary = await commitExcelImport(filePath, worksheet.worksheetId)
    moveProcessedFile(filePath, 'imported')
    pushMemoryLog({
      fileName: basename(filePath),
      worksheetName: worksheet.name,
      ok: true,
      importedRows: summary.rowCount,
      message: summary.message ?? `导入完成：${summary.rowCount} 行`,
      batchId: summary.id,
      createdAt: new Date().toISOString()
    })
  } catch (error) {
    moveProcessedFile(filePath, 'failed')
    const message = error instanceof Error ? error.message : '导入失败'
    pushMemoryLog({
      fileName: basename(filePath),
      ok: false,
      importedRows: 0,
      message,
      createdAt: new Date().toISOString()
    })
    await persistFailedLog(basename(filePath), message)
  }
}

function moveProcessedFile(filePath: string, targetFolderName: 'imported' | 'failed'): void {
  const targetFolder = join(folderPath, targetFolderName)
  mkdirSync(targetFolder, { recursive: true })
  const parsedExtension = extname(filePath)
  const baseName = basename(filePath, parsedExtension)
  const targetPath = join(targetFolder, `${baseName}_${Date.now()}${parsedExtension}`)

  try {
    if (statSync(filePath).isFile()) {
      renameSync(filePath, targetPath)
    }
  } catch {
    // If a user removes the file during import, leave only the log record.
  }
}

function pushMemoryLog(log: ExcelImportLog): void {
  memoryLogs.unshift(log)
  memoryLogs.splice(20)
}

async function persistFailedLog(fileName: string, message: string): Promise<void> {
  try {
    const database = await getDatabase()
    await run(
      database,
      `INSERT INTO import_logs (file_name, worksheet_name, ok, imported_rows, message) VALUES (?, NULL, 0, 0, ?)`,
      [fileName, message]
    )
  } catch {
    // best-effort
  }
}

function ensureImportFolders(path: string): void {
  mkdirSync(path, { recursive: true })
  mkdirSync(join(path, 'imported'), { recursive: true })
  mkdirSync(join(path, 'failed'), { recursive: true })
  mkdirSync(getTemplateFolderPath(), { recursive: true })
}

function resolveDefaultFolder(): string {
  if (canUseFolder(preferredImportFolder)) {
    return preferredImportFolder
  }
  return join(app.getPath('userData'), 'excel-import')
}

function canUseFolder(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    return true
  } catch {
    return false
  }
}

async function readPersistedImportFolder(): Promise<string | undefined> {
  try {
    const database = await getDatabase()
    const row = await get<{ value: string | null }>(
      database,
      `SELECT value FROM app_settings WHERE key = ?`,
      [importFolderSettingKey]
    )
    return row?.value || undefined
  } catch {
    return undefined
  }
}

async function persistImportFolder(value: string): Promise<void> {
  try {
    const database = await getDatabase()
    await run(
      database,
      `
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `,
      [importFolderSettingKey, value]
    )
  } catch {
    // best-effort
  }
}

function getTemplateFolderPath(): string {
  return join(folderPath || resolveDefaultFolder(), 'templates')
}

function detectMonthlyPayrollFiles(path: string): MonthlyPayrollDetectedFiles {
  const files = listRootImportableFiles(path)
  const salary = pickLatestFile(files.filter((filePath) => isSalaryWorkbook(filePath)))
  const socialSecurity = pickLatestFile(files.filter((filePath) => isSocialSecurityWorkbook(filePath)))
  const tax = pickLatestFile(files.filter((filePath) => isTaxWorkbook(filePath)))

  const mode: MonthlyPayrollDetectedFiles['mode'] = salary
    ? socialSecurity && tax
      ? 'salary-social-tax'
      : socialSecurity
        ? 'salary-social'
        : tax
          ? 'salary-tax'
          : 'salary-only'
    : socialSecurity && tax
      ? 'social-tax'
      : socialSecurity
        ? 'social-only'
        : 'missing-source'

  return {
    salaryWorkbookPath: salary,
    salaryWorkbookName: salary ? basename(salary) : undefined,
    socialSecurityWorkbookPath: socialSecurity,
    socialSecurityWorkbookName: socialSecurity ? basename(socialSecurity) : undefined,
    taxWorkbookPath: tax,
    taxWorkbookName: tax ? basename(tax) : undefined,
    mode
  }
}

function detectAnnualAdjustmentFiles(path: string): AnnualAdjustmentDetectedFiles {
  const files = listRootImportableFiles(path)
  const salary = pickLatestFile(files.filter((filePath) => isSalaryWorkbook(filePath)))
  const housingAccount = pickLatestFile(files.filter((filePath) => isHousingAccountWorkbook(filePath)))
  const insuranceDetails = files
    .filter((filePath) => isPersonalInsuranceDetailWorkbook(filePath))
    .map((filePath) => ({ filePath, mtimeMs: safeMtimeMs(filePath) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((item) => item.filePath)
  const taxTemplate = pickLatestFile(files.filter((filePath) => isPersonalTaxTemplateWorkbook(filePath)))
  const socialBaseTemplate = pickLatestFile(files.filter((filePath) => isSocialBaseTemplateWorkbook(filePath)))

  return {
    salaryWorkbookPath: salary,
    salaryWorkbookName: salary ? basename(salary) : undefined,
    housingAccountWorkbookPath: housingAccount,
    housingAccountWorkbookName: housingAccount ? basename(housingAccount) : undefined,
    insuranceDetailWorkbookPaths: insuranceDetails,
    insuranceDetailWorkbookNames: insuranceDetails.map((filePath) => basename(filePath)),
    taxTemplateWorkbookPath: taxTemplate,
    taxTemplateWorkbookName: taxTemplate ? basename(taxTemplate) : undefined,
    socialBaseTemplateWorkbookPath: socialBaseTemplate,
    socialBaseTemplateWorkbookName: socialBaseTemplate ? basename(socialBaseTemplate) : undefined
  }
}

function listRootImportableFiles(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(path, entry.name))
      .filter((filePath) => importableExtensions.has(extname(filePath).toLowerCase()))
      .filter((filePath) => !basename(filePath).startsWith('~$'))
  } catch {
    return []
  }
}

function pickLatestFile(files: string[]): string | undefined {
  return files
    .map((filePath) => ({ filePath, mtimeMs: safeMtimeMs(filePath) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.filePath
}

function safeMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function isReservedWorkflowFile(filePath: string): boolean {
  return (
    isSalaryWorkbook(filePath) ||
    isSocialSecurityWorkbook(filePath) ||
    isTaxWorkbook(filePath) ||
    isAnnualAdjustmentFile(filePath) ||
    isPersonnelExpensePlanWorkbook(filePath)
  )
}

function isAnnualAdjustmentFile(filePath: string): boolean {
  return (
    isHousingAccountWorkbook(filePath) ||
    isPersonalInsuranceDetailWorkbook(filePath) ||
    isPersonalTaxTemplateWorkbook(filePath) ||
    isSocialBaseTemplateWorkbook(filePath)
  )
}

function isSalaryWorkbook(filePath: string): boolean {
  const name = basename(filePath)
  return (
    name.includes('工资表') &&
    !name.includes('税款计算') &&
    !name.includes('补发工资') &&
    !name.includes('工资报账')
  )
}

function isSocialSecurityWorkbook(filePath: string): boolean {
  return basename(filePath).startsWith('社保费未申报汇总信息')
}

function isTaxWorkbook(filePath: string): boolean {
  return basename(filePath).includes('税款计算_工资薪金所得')
}

function isHousingAccountWorkbook(filePath: string): boolean {
  return basename(filePath).toLowerCase().startsWith('grxxlist')
}

function isPersonalInsuranceDetailWorkbook(filePath: string): boolean {
  const name = basename(filePath)
  if (!name.includes('未申报信息明细')) return false
  if (name.startsWith('社保费未申报汇总信息')) return false
  return (
    name.includes('个人缴纳') ||
    name.includes('个人缴费') ||
    name.includes('养老保险费') ||
    name.includes('职业年金') ||
    name.includes('医疗保险') ||
    name.includes('失业保险')
  )
}

function isPersonalTaxTemplateWorkbook(filePath: string): boolean {
  return basename(filePath).includes('正常工资薪金所得')
}

function isSocialBaseTemplateWorkbook(filePath: string): boolean {
  return basename(filePath).includes('参保职工列表模板')
}
