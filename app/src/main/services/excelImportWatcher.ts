import { shell } from 'electron'
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import * as XLSX from 'xlsx'
import { all, getDatabase, run } from '../db/connection'
import type {
  AnnualAdjustmentDetectedFiles,
  ExcelImportLog,
  ImportWatcherStatus,
  MonthlyPayrollDetectedFiles
} from '../../shared/types'
import { commitExcelImport } from './excelImport'
import { inferWorksheet } from './worksheetInference'
import { isPersonnelExpensePlanWorkbook } from './budget/personnelExpensePlanPrefill'
import { importFolder } from '../config/paths'
import { isValidIdCard, normalizeHeader, text } from './monthly-payroll/monthlyPayrollUtils'

const importableExtensions = new Set(['.xlsx', '.xls', '.csv'])
const memoryLogs: ExcelImportLog[] = []
type MonthlyPayrollFileKind = 'salary' | 'social' | 'tax'

let importQueue: Promise<unknown> = Promise.resolve()

function enqueueImport<T>(task: () => Promise<T>): Promise<T> {
  const next = importQueue.then(task, task)
  importQueue = next.catch(() => undefined)
  return next
}
const fixedImportFolder = importFolder

let watcher: FSWatcher | undefined
let folderPath = ''
let running = false

/**
 * 同步取当前监控文件夹路径（不存在则回退到默认值）。
 * 用于 will-download 等必须同步获取的场景（异步获取会让保存对话框先弹出来）。
 */
export function getCachedImportFolder(): string {
  return folderPath || resolveDefaultFolder()
}

export async function startExcelImportWatcher(_customFolderPath?: string): Promise<ImportWatcherStatus> {
  folderPath = resolveDefaultFolder()

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
    folderPath = resolveDefaultFolder()
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
    folderPath = resolveDefaultFolder()
  }
  ensureImportFolders(folderPath)
  await shell.openPath(folderPath)
  return getImportWatcherStatus()
}

export async function chooseImportWatcherFolder(): Promise<ImportWatcherStatus> {
  return openImportWatcherFolder()
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
  const reservedWorkflowName = reservedWorkflowWorksheetName(filePath)
  if (reservedWorkflowName) {
    pushMemoryLog({
      fileName: basename(filePath),
      worksheetName: reservedWorkflowName,
      ok: true,
      importedRows: 0,
      message: '已识别为专项处理文件，保留在监控文件夹供业务模块使用',
      createdAt: new Date().toISOString()
    })
    return
  }

  let commitFailureLogged = false
  try {
    const result = inferWorksheet(filePath)
    if (!result.worksheet) {
      throw new Error(result.reason || '未匹配到工作表')
    }
    const worksheet = result.worksheet

    let summary: Awaited<ReturnType<typeof commitExcelImport>>
    try {
      summary = await commitExcelImport(filePath, worksheet.worksheetId)
    } catch (error) {
      commitFailureLogged = true
      throw error
    }
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
    if (!commitFailureLogged) {
      await persistFailedLog(basename(filePath), message)
    }
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
  if (canUseFolder(fixedImportFolder)) return fixedImportFolder
  return fixedImportFolder
}

function canUseFolder(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    return true
  } catch {
    return false
  }
}

function getTemplateFolderPath(): string {
  return join(folderPath || resolveDefaultFolder(), 'templates')
}

function detectMonthlyPayrollFiles(path: string): MonthlyPayrollDetectedFiles {
  const files = listRootImportableFiles(path)
  const classified = files.map((filePath) => ({
    filePath,
    kind: classifyMonthlyPayrollFile(filePath)
  }))
  const salary =
    pickLatestFile(classified.filter((file) => file.kind === 'salary').map((file) => file.filePath)) ??
    pickFallbackSalaryWorkbook(classified)
  const socialSecurity = pickLatestFile(classified.filter((file) => file.kind === 'social').map((file) => file.filePath))
  const tax = pickLatestFile(classified.filter((file) => file.kind === 'tax').map((file) => file.filePath))

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

function reservedWorkflowWorksheetName(filePath: string): string | undefined {
  if (classifyMonthlyPayrollFile(filePath)) return '工资报账'
  if (isPersonnelExpensePlanWorkbook(filePath)) return '人员经费核对'
  if (isAnnualAdjustmentFile(filePath)) return '社保个税'
  return undefined
}

function isAnnualAdjustmentFile(filePath: string): boolean {
  return (
    isHousingAccountWorkbook(filePath) ||
    isPersonalInsuranceDetailWorkbook(filePath) ||
    isPersonalTaxTemplateWorkbook(filePath) ||
    isSocialBaseTemplateWorkbook(filePath)
  )
}

function classifyMonthlyPayrollFile(filePath: string): MonthlyPayrollFileKind | undefined {
  const workbook = readWorkbookSample(filePath)
  if (workbook) {
    if (looksLikeSalaryWorkbook(workbook)) return 'salary'
    if (looksLikeSocialSecurityWorkbook(workbook)) return 'social'
    if (looksLikeTaxWorkbook(workbook)) return 'tax'
  }
  return classifyMonthlyPayrollFileByName(filePath)
}

function readWorkbookSample(filePath: string): XLSX.WorkBook | undefined {
  try {
    return XLSX.readFile(filePath, {
      cellDates: false,
      sheetRows: 80
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[import-watcher] 无法读取工作簿用于识别：${basename(filePath)}，${message}`)
    return undefined
  }
}

function classifyMonthlyPayrollFileByName(filePath: string): MonthlyPayrollFileKind | undefined {
  const name = normalizedFileBaseName(filePath)
  if (looksLikeSocialSecurityWorkbookName(name)) return 'social'
  if (looksLikeTaxWorkbookName(name)) return 'tax'
  if (looksLikeSalaryWorkbookName(name)) return 'salary'
  return undefined
}

function pickFallbackSalaryWorkbook(
  classified: Array<{ filePath: string; kind: MonthlyPayrollFileKind | undefined }>
): string | undefined {
  const candidates = classified
    .filter((file) => file.kind === undefined)
    .map((file) => file.filePath)
    .filter((filePath) => isFallbackSalaryWorkbookCandidate(filePath))

  if (candidates.length === 1) return candidates[0]

  const namedCandidates = candidates.filter((filePath) => looksLikeSalaryWorkbookName(normalizedFileBaseName(filePath)))
  return pickLatestFile(namedCandidates)
}

function isFallbackSalaryWorkbookCandidate(filePath: string): boolean {
  const name = normalizedFileBaseName(filePath)
  if (looksLikeSocialSecurityWorkbookName(name) || looksLikeTaxWorkbookName(name)) return false
  if (isHousingAccountWorkbook(filePath) || isPersonalInsuranceDetailWorkbook(filePath)) return false
  if (isPersonalTaxTemplateWorkbook(filePath) || isSocialBaseTemplateWorkbook(filePath)) return false
  if (name.includes('人员经费') || name.includes('核对') || name.includes('模板')) return false
  return true
}

function normalizedFileBaseName(filePath: string): string {
  return normalizeHeader(basename(filePath, extname(filePath)))
}

function looksLikeSocialSecurityWorkbookName(name: string): boolean {
  return name.includes('社保费未申报汇总信息') || name.includes('社保未申报汇总') || name.includes('未申报汇总信息')
}

function looksLikeTaxWorkbookName(name: string): boolean {
  return (
    name.includes('税款计算') ||
    name.includes('个税计算') ||
    name.includes('个人所得税') ||
    name.includes('工资薪金所得')
  )
}

function looksLikeSalaryWorkbookName(name: string): boolean {
  if (looksLikeSocialSecurityWorkbookName(name) || looksLikeTaxWorkbookName(name)) return false
  return (
    name.includes('工资表') ||
    name.includes('工资') ||
    name.includes('薪资') ||
    name.includes('薪酬') ||
    /^\d*[\u4e00-\u9fa5]+(小学|中学|学校|幼儿园|中心|学院|职校)/.test(name)
  )
}

function looksLikeSalaryWorkbook(workbook: XLSX.WorkBook): boolean {
  const activeSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === normalizeHeader('公办在职'))
  if (!activeSheetName) return false
  const rows = sheetToRows(workbook.Sheets[activeSheetName])
  const headerRows = rows.slice(0, 12)
  const hasExpectedHeaders = [
    '身份证号',
    '姓名',
    '岗位工资',
    '薪级工资',
    '实发工资合计'
  ].filter((keyword) => rowsContainNormalized(headerRows, keyword)).length >= 4
  const idCardRows = rows.filter((row) => row.some((cell) => isValidIdCard(cell))).length
  return hasExpectedHeaders && idCardRows > 0
}

function looksLikeSocialSecurityWorkbook(workbook: XLSX.WorkBook): boolean {
  return workbook.SheetNames.some((sheetName) => {
    const rows = sheetToRows(workbook.Sheets[sheetName])
    return rows.some((row) => {
      const headers = row.map((cell) => normalizeHeader(text(cell)))
      return hasAnyHeader(headers, [
        '征收品目',
        '征收项目',
        '征收品目名称',
        '征收项目名称',
        '征收子目',
        '征收子目名称'
      ]) && hasAnyHeader(headers, [
        '应补（退）费额(元)',
        '应补(退)费额(元)',
        '应补（退）费额',
        '应补(退)费额',
        '应缴费额(元)',
        '应缴费额'
      ]) && hasAnyHeader(headers, [
        '费款所属期起',
        '费款所属期开始',
        '费款所属期起始',
        '所属期起',
        '所属期开始',
        '所属期起始',
        '费款所属期',
        '所属期'
      ])
    })
  })
}

function looksLikeTaxWorkbook(workbook: XLSX.WorkBook): boolean {
  return workbook.SheetNames.some((sheetName) => {
    const rows = sheetToRows(workbook.Sheets[sheetName])
    return rows.some((row) => {
      const headers = row.map((cell) => normalizeHeader(text(cell)))
      return hasAllHeaders(headers, ['姓名', '证件号码']) &&
        hasAnyHeader(headers, ['应补（退）税额', '应补(退)税额', '本期应补（退）税额', '本期应补(退)税额']) &&
        hasAnyHeader(headers, ['税款所属期起', '税款所属期开始', '税款所属期起始', '所得期间起', '税款所属期', '所得期间'])
    })
  })
}

function sheetToRows(sheet: XLSX.WorkSheet | undefined): unknown[][] {
  if (!sheet) return []
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false
  })
}

function rowsContainNormalized(rows: unknown[][], keyword: string): boolean {
  const expected = normalizeHeader(keyword)
  return rows.some((row) => row.some((cell) => normalizeHeader(text(cell)).includes(expected)))
}

function hasAnyHeader(headers: string[], candidates: string[]): boolean {
  const normalized = candidates.map(normalizeHeader)
  return headers.some((header) => normalized.includes(header))
}

function hasAllHeaders(headers: string[], candidates: string[]): boolean {
  const set = new Set(headers)
  return candidates.map(normalizeHeader).every((header) => set.has(header))
}

function isSalaryWorkbook(filePath: string): boolean {
  return classifyMonthlyPayrollFile(filePath) === 'salary'
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
