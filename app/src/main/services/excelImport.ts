import { dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import * as XLSX from 'xlsx'
import {
  all,
  backfillHrBankFieldsFromBudget,
  get,
  getDatabase,
  loadPersonnelStatusIdentitySets,
  refreshAllPersonnelStatuses,
  run,
  runWithLastId
} from '../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import { readWorksheetMetadata } from '../db/metadata'
import {
  getHeaderAliases,
  getMultiRowConfig,
  getSplitConfig,
  inferWorksheet,
  type SplitConfig
} from './worksheetInference'
import {
  findSheetForWorksheet,
  isNumericCell,
  readBudgetWorkbookImports,
  readWorkbookRows,
  shouldUseMultiRowConfig
} from './excelWorkbookRows'
import { normalizeTownshipAllowanceImportedRows } from './township-allowance/townshipAllowance'
import {
  normalizeRankResumeImportedRows,
  type RankResumeImportAdjustment
} from './rankResumeImport'
import { readUnitSettings } from './unitSettings'
import { readMonthlyPayrollSettings } from './monthly-payroll/monthlyPayrollSettings'
import { applyIntegratedComputedFieldsToRows } from './monthly-payroll/integratedPayrollRules'
import { createOperationBatch, logRowsBeforeDelete } from './operationLog'
import { parseEducationCell, parseWorkHistoryLine } from './hrDetailChildParsers'
import {
  getIdentityColumnName,
  getPersonnelStatusColumnName,
  isPersonnelStatusTargetWorksheet,
  resolveBudgetWorksheetStatus,
  resolvePersonnelStatus
} from './personnelStatus'
import type {
  ImportBatchSummary,
  ImportPreview,
  ImportPreviewChange,
  ImportPreviewDiff,
  ImportPreviewRow,
  WorksheetMeta,
  WorksheetRecordValue
} from '../../shared/types'

type CommitExcelImportOptions = {
  confirmUpdates?: boolean
}

type ImportRowPlan = {
  row: Record<string, WorksheetRecordValue>
  rowNumber?: number
  uniqueKey?: string
  partitionKey?: string
  action: 'insert' | 'update' | 'unchanged'
  recordId?: number
  previousValues?: Record<string, WorksheetRecordValue>
  changedValues?: Record<string, WorksheetRecordValue>
  changes: ImportPreviewChange[]
}

const budgetDraftRetainedFieldNames = new Map<string, Set<string>>([
  [
    '预算在职',
    new Set([
      '序号',
      '单位代码*',
      '单位名称*',
      '人员序号*',
      '姓名*',
      '证件类型*',
      '证件号码*',
      '性别*',
      '民族*',
      '参加工作时间*',
      '人员状态*',
      '进入本单位时间*',
      '是否在编',
      '人员身份*',
      '在职人员来源*',
      '是否工资统发',
      '在编类别*',
      '工资卡开户银行*',
      '工资卡卡号*',
      '备注'
    ])
  ],
  [
    '预算退休',
    new Set([
      '序号',
      '单位代码*',
      '单位名称*',
      '人员序号*',
      '姓名*',
      '证件类型*',
      '证件号码*',
      '学历*',
      '参加工作时间*',
      '退休时间*',
      '工龄（年）*',
      '进入本单位时间*',
      '工资卡开户银行*',
      '工资卡卡号*',
      '备注'
    ])
  ],
  [
    '预算其他',
    new Set([
      '序号',
      '单位代码*',
      '单位名称*',
      '人员序号',
      '姓名*',
      '证件类型',
      '证件号码',
      '学历',
      '进入本单位时间',
      '工资卡开户银行',
      '工资卡卡号',
      '备注'
    ])
  ],
  [
    '工资年报',
    new Set([
      '姓名',
      '身份证号',
      '不计算工龄的大专以上学龄（年）'
    ])
  ]
])

const identityFieldNames = new Set([
  '\u8bc1\u4ef6\u53f7\u7801*',
  '\u8bc1\u4ef6\u53f7\u7801',
  '\u8eab\u4efd\u8bc1\u53f7',
  '\u8eab\u4efd\u8bc1\u53f7\u7801'
])

const worksheetUniqueFieldNames = new Map<string, string>([
  ['\u5c97\u4f4d\u5de5\u8d44\u5bf9\u7167', '\u91d1\u989d'],
  ['\u85aa\u7ea7\u5de5\u8d44\u5bf9\u7167', '\u85aa\u7ea7\u5de5\u8d44'],
  ['\u4e61\u9547\u5de5\u4f5c\u5e74\u9650\u5bf9\u7167', '\u91d1\u989d']
])

const worksheetsWithoutIdentityDedupe = new Set(['\u804c\u7ea7\u7b80\u5386'])

const unitNameHeaderNames = new Set([
  '单位名称',
  '单位名称*',
  '单位全称',
  '预算单位名称',
  '预算单位全称'
])

const unitCodeHeaderNames = new Set([
  '单位代码',
  '单位代码*',
  '单位编码',
  '单位预算编码',
  '预算单位编码',
  '预算单位代码'
])

// \u540c\u4e00\u8868\u5185\uff0c\u9664\u552f\u4e00\u5217\u5916\u8fd8\u9700\u4f5c\u4e3a\u53bb\u91cd\u7ef4\u5ea6\u7684\u5b57\u6bb5\u3002
// \u4f8b\uff1a\u4e00\u4f53\u5316\u5728\u804c \u540c\u4e00\u4eba\u4f1a\u540c\u65f6\u5b58\u5728 \u5de5\u8d44\u6279\u6b21 001/002 \u4e24\u7b14\u8bb0\u5f55\uff0c\u53bb\u91cd\u5fc5\u987b\u6309 (\u8bc1\u4ef6\u53f7\u7801, \u5de5\u8d44\u6279\u6b21) \u800c\u975e\u4ec5 \u8bc1\u4ef6\u53f7\u7801\u3002
const worksheetPartitionFieldNames = new Map<string, string[]>([
  ['\u4e00\u4f53\u5316\u5728\u804c', ['\u5de5\u8d44\u6279\u6b21']],
  ['在职工资', ['工资批次编码']],
  ['退休工资', ['工资批次编码']],
  ['其他工资', ['工资批次编码']]
])

export async function chooseExcelFile(): Promise<{ filePath: string; fileName: string } | null> {
  const result = await dialog.showOpenDialog({
    title: '选择要导入的 Excel 文件',
    properties: ['openFile'],
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] }]
  })

  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]
  return { filePath, fileName: basename(filePath) }
}

export async function previewExcelFile(
  filePath: string,
  worksheetIdOverride?: string
): Promise<ImportPreview> {
  let worksheet: WorksheetMeta | undefined
  if (worksheetIdOverride) {
    worksheet = readWorksheetMetadata().find((item) => item.worksheetId === worksheetIdOverride)
    if (!worksheet) throw new Error(`未找到工作表：${worksheetIdOverride}`)
  } else {
    const result = inferWorksheet(filePath)
    if (!result.worksheet) {
      throw new Error(result.reason || '表头未匹配任何工作表')
    }
    worksheet = result.worksheet
  }

  const rawRows = await readWorkbookRows(filePath, worksheet, { allowUnknownHeaders: true })
  const columns = getWorksheetLocalColumns(worksheet)
  const headerMap = new Map<string, { columnName: string; fieldName: string }>()
  const columnHeaderMap = new Map<string, string>()

  for (const column of columns) {
    headerMap.set(normalizeHeader(column.field.name), {
      columnName: column.columnName,
      fieldName: column.field.name
    })
    columnHeaderMap.set(normalizeHeader(column.field.name), column.columnName)
    headerMap.set(normalizeHeader(column.columnName), {
      columnName: column.columnName,
      fieldName: column.field.name
    })
    columnHeaderMap.set(normalizeHeader(column.columnName), column.columnName)
  }

  const aliases = getHeaderAliases(worksheet.name)
  for (const [aliasHeader, targetFieldName] of Object.entries(aliases)) {
    const target = columns.find((column) => column.field.name === targetFieldName)
    if (!target) continue
    headerMap.set(normalizeHeader(aliasHeader), {
      columnName: target.columnName,
      fieldName: target.field.name
    })
    columnHeaderMap.set(normalizeHeader(aliasHeader), target.columnName)
  }

  const matchedHeaders: ImportPreview['matchedHeaders'] = []
  const unknownHeaderSet = new Set<string>()
  const seenHeaderKeys = new Set<string>()

  const previewRows: ImportPreviewRow[] = rawRows.slice(0, 50).map((row, index) => {
    const values: Record<string, WorksheetRecordValue> = {}
    const warnings: string[] = []

    for (const [source, raw] of Object.entries(row)) {
      const normalized = normalizeHeader(source)
      const matched = headerMap.get(normalized)
      if (!matched) {
        unknownHeaderSet.add(source)
        continue
      }
      if (!seenHeaderKeys.has(matched.columnName)) {
        seenHeaderKeys.add(matched.columnName)
        matchedHeaders.push({
          source,
          columnName: matched.columnName,
          fieldName: matched.fieldName
        })
      }
      values[matched.columnName] = coerceValue(raw)
    }

    if (Object.keys(values).length === 0) {
      warnings.push('该行没有匹配到任何字段')
    }

    return { rowNumber: index + 2, values, warnings }
  })

  const database = await getDatabase()
  await validateImportedUnitIdentity(basename(filePath), worksheet, rawRows, columns, columnHeaderMap)
  const uniqueColumnName = findUniqueColumnName(worksheet.name, columns)
  const partitionColumnNames = findPartitionColumnNames(worksheet.name, columns)
  let sanitizedRows = dedupeRowsByUniqueKey(rawRows, columnHeaderMap, uniqueColumnName, partitionColumnNames)
  await applyTownshipIdCardsToRows(database, worksheet, columns, sanitizedRows)
  sanitizedRows = dedupeMappedRowsByUniqueKey(sanitizedRows, uniqueColumnName, partitionColumnNames)
  applyHrDetailDerivedFields(worksheet, columns, sanitizedRows)
  await applyTownshipUnitFullNames(database, worksheet, columns, sanitizedRows)
  sanitizeBudgetDraftRows(worksheet, columns, sanitizedRows)
  await applyPersonnelStatusToRows(database, worksheet, sanitizedRows)
  const monthlyPayrollSettings = await readMonthlyPayrollSettings()
  applyIntegratedComputedFieldsToRows(worksheet, sanitizedRows, monthlyPayrollSettings.taxField)
  const diff = await buildImportDiff(database, worksheet, columns, sanitizedRows, uniqueColumnName, partitionColumnNames)

  return {
    worksheetId: worksheet.worksheetId,
    worksheetName: worksheet.name,
    matchedHeaders,
    unknownHeaders: Array.from(unknownHeaderSet),
    rows: previewRows,
    totalRows: rawRows.length,
    diff
  }
}

let importQueue: Promise<unknown> = Promise.resolve()

export function commitExcelImport(
  filePath: string,
  worksheetId: string,
  options: CommitExcelImportOptions = {}
): Promise<ImportBatchSummary> {
  const next = importQueue.then(
    () => commitExcelImportWithLog(filePath, worksheetId, options),
    () => commitExcelImportWithLog(filePath, worksheetId, options)
  )
  importQueue = next.catch(() => undefined)
  return next
}

async function commitExcelImportWithLog(
  filePath: string,
  worksheetId: string,
  options: CommitExcelImportOptions = {}
): Promise<ImportBatchSummary> {
  try {
    return await commitExcelImportInternal(filePath, worksheetId, options)
  } catch (error) {
    // 将失败记录写入 import_logs，使通知区域能显示本次失败
    const sourceName = basename(filePath)
    const errMsg = error instanceof Error ? error.message : '导入失败'
    const worksheetName =
      readWorksheetMetadata().find((item) => item.worksheetId === worksheetId)?.name ?? worksheetId
    try {
      const database = await getDatabase()
      await run(
        database,
        `INSERT INTO import_logs (file_name, worksheet_name, ok, imported_rows, message) VALUES (?, ?, 0, 0, ?)`,
        [sourceName, worksheetName, errMsg]
      )
    } catch {
      // best-effort，不影响主流程抛出原始错误
    }
    throw error
  }
}

async function commitExcelImportInternal(
  filePath: string,
  worksheetId: string,
  options: CommitExcelImportOptions = {}
): Promise<ImportBatchSummary> {
  const worksheets = readWorksheetMetadata()
  const worksheet = worksheets.find((item) => item.worksheetId === worksheetId)
  if (!worksheet) throw new Error(`未找到工作表：${worksheetId}`)

  const sourceName = basename(filePath)

  const budgetWorkbookImports = await readBudgetWorkbookImports(filePath, worksheet, worksheets)
  if (budgetWorkbookImports.length > 1) {
    const summaries: ImportBatchSummary[] = []
    for (const item of budgetWorkbookImports) {
      summaries.push(await insertRowsAsBatch(sourceName, item.worksheet, item.rows, options))
    }
    const database = await getDatabase()
    await refreshAllPersonnelStatuses(database)

    const primary =
      summaries.find((item) => item.worksheetName === worksheet.name) ?? summaries[0]
    const totalRows = summaries.reduce((total, item) => total + item.rowCount, 0)
    primary.rowCount = totalRows
    primary.message = summaries
      .map((item) => `${item.worksheetName} ${item.rowCount} \u884c`)
      .join('\uff1b')
    return primary
  }

  const rows = await readWorkbookRows(filePath, worksheet)
  const splitConfig = getSplitConfig(worksheet.name)

  if (!splitConfig) {
    const summary = await insertRowsAsBatch(sourceName, worksheet, rows, options)
    if (worksheet.worksheetId === 'local-hr-detail') {
      try {
        await extractAndInsertHrDetailChildRows(filePath, worksheet, summary.id)
      } catch (err) {
        // 子表写入失败不影响主表导入结果，但记录日志
        console.error('[hr-detail child import]', err instanceof Error ? err.message : err)
      }
    }
    return summary
  }

  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const target = pickSplitTarget(row, splitConfig)
    if (!target) continue
    const list = groups.get(target) ?? []
    list.push(row)
    groups.set(target, list)
  }

  const summaries: ImportBatchSummary[] = []
  for (const [targetName, targetRows] of groups) {
    const targetWorksheet = worksheets.find((item) => item.name === targetName)
    if (!targetWorksheet || targetRows.length === 0) continue
    const summary = await insertRowsAsBatch(sourceName, targetWorksheet, targetRows, options)
    summaries.push(summary)
  }

  if (summaries.length === 0) {
    throw new Error(`分流后没有可导入的行（依据字段：${splitConfig.field}）`)
  }

  const primary =
    summaries.find((item) => item.worksheetName === worksheet.name) ?? summaries[0]
  const others = summaries.filter((item) => item.id !== primary.id)
  if (others.length > 0) {
    const extra = others
      .map((item) => `${item.worksheetName} ${item.rowCount} 行（批次 #${item.id}）`)
      .join('；')
    primary.message = `${primary.message ?? ''}；分流另导入 ${extra}`
  }
  return primary
}

function pickSplitTarget(
  row: Record<string, unknown>,
  config: SplitConfig
): string | undefined {
  const raw = row[config.field]
  const value = raw === null || raw === undefined ? '' : String(raw).trim()
  for (const rule of config.rules) {
    if (rule.match === 'empty' && value === '') return rule.target
    if (rule.match === 'non-empty' && value !== '') return rule.target
    if (rule.match === 'equals' && value === (rule.value ?? '')) return rule.target
  }
  return undefined
}

async function validateImportedUnitIdentity(
  sourceName: string,
  worksheet: WorksheetMeta,
  rows: Array<Record<string, unknown>>,
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  headerMap: Map<string, string>
): Promise<void> {
  if (rows.length === 0) return

  const unitNameValues = new Map<string, { label: string; rows: number[] }>()
  const unitCodeValues = new Map<string, { label: string; rows: number[] }>()
  const fieldNameByColumn = new Map(columns.map((column) => [column.columnName, column.field.name]))

  rows.forEach((row, rowIndex) => {
    for (const [sourceHeader, rawValue] of Object.entries(row)) {
      const value = cleanText(rawValue)
      if (!value) continue

      const matchedColumn = headerMap.get(normalizeHeader(sourceHeader))
      const semanticName = matchedColumn ? fieldNameByColumn.get(matchedColumn) : undefined
      const headerKind = resolveUnitIdentityHeaderKind(sourceHeader) ?? resolveUnitIdentityHeaderKind(semanticName)
      if (!headerKind) continue

      const targetMap = headerKind === 'name' ? unitNameValues : unitCodeValues
      const normalized = headerKind === 'name' ? normalizeUnitName(value) : normalizeUnitCode(value)
      if (!normalized) continue
      const entry = targetMap.get(normalized) ?? { label: value, rows: [] }
      if (entry.rows.length < 5) entry.rows.push(rowIndex + 1)
      targetMap.set(normalized, entry)
    }
  })

  if (unitNameValues.size === 0 && unitCodeValues.size === 0) return

  const settings = await readUnitSettings()
  const expectedName = normalizeUnitName(settings.unitFullName)
  const expectedCode = normalizeUnitCode(settings.unitImportCode)
  const errors: string[] = []

  if (unitNameValues.size > 0 && !expectedName) {
    errors.push('系统设置中未填写单位全称')
  } else {
    for (const [value, entry] of unitNameValues) {
      if (value === expectedName) continue
      errors.push(`单位名称为"${entry.label}"，系统设置为"${settings.unitFullName || '未填写'}"`)
    }
  }

  if (unitCodeValues.size > 0 && !expectedCode) {
    errors.push('系统设置中未填写预算单位编码')
  } else {
    for (const [value, entry] of unitCodeValues) {
      if (value === expectedCode) continue
      errors.push(`单位预算编码为"${entry.label}"，系统设置为"${settings.unitImportCode || '未填写'}"`)
    }
  }

  if (errors.length === 0) return

  const shownErrors = errors.slice(0, 6)
  const rest = errors.length > shownErrors.length ? `等 ${errors.length} 项` : ''
  throw new Error(
    [
      `导入已暂停：${sourceName} 的单位信息与系统设置不一致，不能导入 ${worksheet.name}。`,
      ...shownErrors.map((item) => `- ${item}`),
      rest,
      '请确认文件单位和「系统设置 → 单位信息」一致后再导入。'
    ].filter(Boolean).join('\n')
  )
}

function resolveUnitIdentityHeaderKind(value: string | undefined): 'name' | 'code' | undefined {
  const normalized = normalizeUnitIdentityHeader(value)
  if (!normalized) return undefined
  if (unitNameHeaderNames.has(normalized)) return 'name'
  if (unitCodeHeaderNames.has(normalized)) return 'code'
  if (normalized.includes('单位') && normalized.includes('名称')) return 'name'
  if (normalized.includes('单位') && normalized.includes('全称')) return 'name'
  if (normalized.includes('单位') && normalized.includes('编码')) return 'code'
  if (normalized.includes('单位') && normalized.includes('代码')) return 'code'
  return undefined
}

function normalizeUnitIdentityHeader(value: string | undefined): string {
  return String(value ?? '').trim().replace(/\s+/g, '')
}

function normalizeUnitName(value: unknown): string {
  return cleanText(value).replace(/\s+/g, '')
}

function normalizeUnitCode(value: unknown): string {
  const raw = cleanText(value).replace(/[,\s]+/g, '')
  if (!raw) return ''
  if (/^\d+(\.0+)?$/.test(raw)) {
    const digits = raw.replace(/\.0+$/, '')
    return digits.length < 6 ? digits.padStart(6, '0') : digits
  }
  return raw.toUpperCase()
}

async function insertRowsAsBatch(
  sourceName: string,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  rows: Array<Record<string, unknown>>,
  options: CommitExcelImportOptions = {}
): Promise<ImportBatchSummary> {
  const columns = getWorksheetLocalColumns(worksheet)
  const headerMap = new Map<string, string>()
  for (const column of columns) {
    headerMap.set(normalizeHeader(column.field.name), column.columnName)
    headerMap.set(normalizeHeader(column.columnName), column.columnName)
  }
  const aliases = getHeaderAliases(worksheet.name)
  for (const [aliasHeader, targetFieldName] of Object.entries(aliases)) {
    const target = columns.find((column) => column.field.name === targetFieldName)
    if (target) headerMap.set(normalizeHeader(aliasHeader), target.columnName)
  }
  await validateImportedUnitIdentity(sourceName, worksheet, rows, columns, headerMap)
  const uniqueColumnName = findUniqueColumnName(worksheet.name, columns)
  const partitionColumnNames = findPartitionColumnNames(worksheet.name, columns)
  const rankResumeAdjustment =
    worksheet.name === '\u804c\u7ea7\u7b80\u5386'
      ? await normalizeRankResumeImportedRows(rows)
      : undefined
  const tableName = quoteIdentifier(worksheet.name)
  const database = await getDatabase()
  let sanitizedRows = dedupeRowsByUniqueKey(rows, headerMap, uniqueColumnName, partitionColumnNames)
  await applyTownshipIdCardsToRows(database, worksheet, columns, sanitizedRows)
  sanitizedRows = dedupeMappedRowsByUniqueKey(sanitizedRows, uniqueColumnName, partitionColumnNames)
  applyHrDetailDerivedFields(worksheet, columns, sanitizedRows)
  await applyTownshipUnitFullNames(database, worksheet, columns, sanitizedRows)
  const budgetDraftCleanup = sanitizeBudgetDraftRows(worksheet, columns, sanitizedRows)
  const budgetAlignmentMessages = await buildBudgetAlignmentMessages(database, worksheet, sanitizedRows)
  await applyPersonnelStatusToRows(database, worksheet, sanitizedRows)
  const monthlyPayrollSettings = await readMonthlyPayrollSettings()
  const integratedComputedSummary = applyIntegratedComputedFieldsToRows(
    worksheet,
    sanitizedRows,
    monthlyPayrollSettings.taxField
  )
  const importPlan = await buildImportPlan(database, worksheet, columns, sanitizedRows, uniqueColumnName, partitionColumnNames)
  const diff = summarizeImportPlan(worksheet, columns, uniqueColumnName, importPlan)
  if (diff.missingKeyRows > 0 && uniqueColumnName) {
    const fieldName = columns.find((column) => column.columnName === uniqueColumnName)?.field.name ?? uniqueColumnName
    throw new Error(`导入已暂停：${worksheet.name} 有 ${diff.missingKeyRows} 行缺少 ${fieldName}，无法按身份证/唯一键判断是否更新。`)
  }
  if (diff.updatedRows > 0 && !options.confirmUpdates) {
    const examples = diff.examples
      .filter((item) => item.action === 'update')
      .slice(0, 5)
      .map((item) => `${item.key}：${item.changes.map((change) => `${change.fieldName} ${formatValueForMessage(change.currentValue)} → ${formatValueForMessage(change.nextValue)}`).join('，')}`)
      .join('\n')
    throw new Error(
      [
        `导入已暂停：${worksheet.name} 有 ${diff.updatedRows} 行存在字段变化，需要人工确认后才能更新。`,
        examples ? `示例：\n${examples}` : '',
        '请在导入预览中确认差异后重新执行导入。'
      ].filter(Boolean).join('\n')
    )
  }

  const { lastId: batchId } = await runWithLastId(
    database,
    `INSERT INTO import_batches (source_name, worksheet_id, worksheet_name, status) VALUES (?, ?, ?, 'pending')`,
    [sourceName, worksheet.worksheetId, worksheet.name]
  )

  let insertedRows = 0
  let updatedRows = 0
  const unchangedRows = diff.unchangedRows
  let transactionStarted = false
  let townshipAdjustment:
    | Awaited<ReturnType<typeof normalizeTownshipAllowanceImportedRows>>
    | undefined
  try {
    await run(database, 'BEGIN TRANSACTION')
    transactionStarted = true
    // 批量 INSERT：每批最多 200 行
    const BATCH_SIZE = 200
    const now = new Date().toISOString()
    const rowsToInsert = importPlan.filter((item) => item.action === 'insert').map((item) => item.row)
    for (let batchStart = 0; batchStart < rowsToInsert.length; batchStart += BATCH_SIZE) {
      const batch = rowsToInsert.slice(batchStart, batchStart + BATCH_SIZE)

      // 收集本批次所有列名的超集
      const allColumnNamesSet = new Set<string>()
      for (const row of batch) {
        for (const key of Object.keys(row)) allColumnNamesSet.add(key)
      }
      const allColumnNames = Array.from(allColumnNamesSet)

      // 构建多行 INSERT 语句
      const columnList = [...allColumnNames.map(quoteIdentifier), '"md_created_at"', '"md_updated_at"'].join(', ')
      const singleRowPlaceholders = `(${[...allColumnNames.map(() => '?'), '?', '?'].join(', ')})`
      const allPlaceholders = batch.map(() => singleRowPlaceholders).join(', ')
      const sql = `INSERT INTO ${tableName} (${columnList}) VALUES ${allPlaceholders}`

      const params: unknown[] = []
      for (const row of batch) {
        for (const colName of allColumnNames) {
          params.push(row[colName] ?? null)
        }
        params.push(now, now)
      }

      const { lastId } = await runWithLastId(database, sql, params)
      // lastId 是最后一行的 id，倒推本批次所有 id
      const firstId = lastId - batch.length + 1
      // 批量插入 import_batch_rows
      if (batch.length > 0) {
        const batchRowPlaceholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ')
        const batchRowParams: unknown[] = []
        for (let i = 0; i < batch.length; i++) {
          batchRowParams.push(batchId, worksheet.name, firstId + i, 'insert', null)
        }
        await run(
          database,
          `INSERT INTO import_batch_rows (batch_id, worksheet_name, record_id, action, previous_values) VALUES ${batchRowPlaceholders}`,
          batchRowParams
        )
      }
      insertedRows += batch.length
    }

    for (const item of importPlan.filter((row) => row.action === 'update')) {
      if (!item.recordId || !item.changedValues || Object.keys(item.changedValues).length === 0) continue
      const changedColumns = Object.keys(item.changedValues)
      const assignments = changedColumns
        .map((column) => `${quoteIdentifier(column)} = ?`)
        .concat('"md_updated_at" = ?')
        .join(', ')
      const params = [
        ...changedColumns.map((column) => item.changedValues?.[column] ?? null),
        now,
        item.recordId
      ]
      await run(database, `UPDATE ${tableName} SET ${assignments} WHERE "id" = ?`, params)
      await run(
        database,
        `INSERT INTO import_batch_rows (batch_id, worksheet_name, record_id, action, previous_values) VALUES (?, ?, ?, 'update', ?)`,
        [batchId, worksheet.name, item.recordId, JSON.stringify(item.previousValues ?? {})]
      )
      updatedRows += 1
    }

    if (insertedRows > 0 || updatedRows > 0) {
      await backfillHrBankFieldsFromImportedBudgetRows(database, worksheet, columns, sanitizedRows)
    }
    if (worksheet.name === '\u4e61\u9547\u8865\u8d34') {
      townshipAdjustment = await normalizeTownshipAllowanceImportedRows(batchId)
    }
    await run(database, 'COMMIT')
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) {
      await run(database, 'ROLLBACK').catch(() => undefined)
    }
    await run(
      database,
      `UPDATE import_batches SET status = 'failed', message = ? WHERE id = ?`,
      [error instanceof Error ? error.message : '导入失败', batchId]
    )
    throw error
  }

  if (budgetDraftCleanup) {
    await backfillHrBankFieldsFromBudget(database)
  }

  const message = buildImportMessage(
    worksheet.name,
    insertedRows + updatedRows,
    townshipAdjustment,
    rankResumeAdjustment,
    budgetDraftCleanup,
    [
      ...budgetAlignmentMessages,
      ...buildIntegratedComputedMessages(integratedComputedSummary)
    ]
  )
  const finalMessage = [
    message,
    `新增 ${insertedRows} 行，更新 ${updatedRows} 行，未变化跳过 ${unchangedRows} 行`
  ].filter(Boolean).join('\uff1b')

  await run(
    database,
    `UPDATE import_batches SET status = 'imported', row_count = ?, message = ? WHERE id = ?`,
    [insertedRows + updatedRows, finalMessage, batchId]
  )
  await run(
    database,
    `INSERT INTO import_logs (file_name, worksheet_name, ok, imported_rows, message, batch_id) VALUES (?, ?, 1, ?, ?, ?)`,
    [
      sourceName,
      worksheet.name,
      insertedRows + updatedRows,
      finalMessage,
      batchId
    ]
  )

  await refreshAllPersonnelStatuses(database)

  return {
    id: batchId,
    sourceName,
    worksheetName: worksheet.name,
    worksheetId: worksheet.worksheetId,
    status: 'imported',
    rowCount: insertedRows + updatedRows,
    insertedRows,
    updatedRows,
    unchangedRows,
    message: finalMessage,
    createdAt: new Date().toISOString()
  }
}

function applyHrDetailDerivedFields(
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  rows: Array<Record<string, WorksheetRecordValue>>
): void {
  if (worksheet.worksheetId !== 'local-hr-detail' && worksheet.name !== '在编教职工基本信息') return

  const idColumn = columns.find((column) => column.field.name === '身份证号码')?.columnName
  const birthDateColumn = columns.find((column) => column.field.name === '出生日期')?.columnName
  if (!idColumn || !birthDateColumn) return

  for (const row of rows) {
    if (cleanText(row[birthDateColumn])) continue
    const birthDate = birthDateFromIdentity(row[idColumn])
    if (birthDate) row[birthDateColumn] = birthDate
  }
}

function birthDateFromIdentity(value: unknown): string {
  const normalized = cleanText(value).replace(/[\s,]/g, '').toUpperCase()
  const match = normalized.match(/^\d{6}(\d{8})\d{3}[\dX]$/)
  if (!match) return ''
  const date = match[1]
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(4, 6))
  const day = Number(date.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return ''
  }
  return date
}

function cleanText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

type TownshipUnitNameLookup = {
  byIdCard: Map<string, string>
  byName: Map<string, { unitName: string; ambiguous: boolean }>
}

async function applyTownshipUnitFullNames(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  rows: Array<Record<string, WorksheetRecordValue>>
): Promise<void> {
  if (worksheet.name !== '乡镇补贴' || rows.length === 0) return

  const unitColumn = columns.find((column) => column.field.name === '单位')?.columnName
  const idColumn = columns.find((column) => column.field.name === '身份证号')?.columnName
  const nameColumn = columns.find((column) => column.field.name === '姓名')?.columnName
  if (!unitColumn || (!idColumn && !nameColumn)) return

  const lookup = await loadTownshipUnitNameLookup(database)
  for (const row of rows) {
    const idCard = idColumn ? normalizeUniqueValue(row[idColumn]) : ''
    const name = nameColumn ? normalizePersonName(row[nameColumn]) : ''
    const unitName =
      (idCard ? lookup.byIdCard.get(idCard) : undefined) ??
      (name ? uniqueNameUnit(lookup.byName.get(name)) : undefined)
    if (unitName) row[unitColumn] = unitName
  }
}

async function applyTownshipIdCardsToRows(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  rows: Array<Record<string, WorksheetRecordValue>>
): Promise<void> {
  if (worksheet.name !== '乡镇补贴' || rows.length === 0) return

  const idColumn = findColumnByFieldName(columns, ['身份证号', '身份证号码', '证件号码', '证件号码*'])
  const nameColumn = findColumnByFieldName(columns, ['姓名', '姓名*'])
  if (!idColumn || !nameColumn) return

  const idCardsByName = await loadTownshipIdCardsByName(database)
  for (const row of rows) {
    if (normalizeUniqueValue(row[idColumn])) continue
    const name = normalizePersonName(row[nameColumn])
    if (!name) continue

    const matched = Array.from(idCardsByName.get(name) ?? [])
    if (matched.length === 1) row[idColumn] = matched[0]
  }
}

async function loadTownshipIdCardsByName(
  database: Awaited<ReturnType<typeof getDatabase>>
): Promise<Map<string, Set<string>>> {
  const worksheets = readWorksheetMetadata()
  const sources = [
    {
      worksheetName: '在职工资',
      idFields: ['证件号码'],
      nameFields: ['姓名', '姓名*']
    },
    {
      worksheetName: '人事信息',
      idFields: ['身份证号码', '身份证号'],
      nameFields: ['姓名']
    },
    {
      worksheetName: '退休工资',
      idFields: ['证件号码'],
      nameFields: ['姓名', '姓名*']
    }
  ]
  const result = new Map<string, Set<string>>()

  for (const source of sources) {
    const sourceWorksheet = worksheets.find((item) => item.name === source.worksheetName)
    if (!sourceWorksheet) continue
    const sourceColumns = getWorksheetLocalColumns(sourceWorksheet)
    const idColumn = findColumnByFieldName(sourceColumns, source.idFields)
    const nameColumn = findColumnByFieldName(sourceColumns, source.nameFields)
    if (!idColumn || !nameColumn) continue

    const sourceRows = await all<{ name_value: unknown; id_value: unknown }>(
      database,
      `SELECT ${quoteIdentifier(nameColumn)} AS name_value,
              ${quoteIdentifier(idColumn)} AS id_value
       FROM ${quoteIdentifier(sourceWorksheet.name)}`
    )
    for (const sourceRow of sourceRows) {
      const name = normalizePersonName(sourceRow.name_value)
      const idCard = normalizeUniqueValue(sourceRow.id_value as WorksheetRecordValue | undefined)
      if (!name || !idCard) continue
      const bucket = result.get(name) ?? new Set<string>()
      bucket.add(idCard)
      result.set(name, bucket)
    }
  }

  return result
}

async function loadTownshipUnitNameLookup(
  database: Awaited<ReturnType<typeof getDatabase>>
): Promise<TownshipUnitNameLookup> {
  const worksheets = readWorksheetMetadata()
  const sources = [
    {
      worksheetName: '在职工资',
      idFields: ['证件号码'],
      unitFields: ['单位名称', '单位名称*', '单位全称', '单位'],
      nameFields: ['姓名', '姓名*']
    },
    {
      worksheetName: '退休工资',
      idFields: ['证件号码'],
      unitFields: ['单位名称', '单位名称*', '单位全称', '单位'],
      nameFields: ['姓名', '姓名*']
    },
    {
      worksheetName: '人事信息',
      idFields: ['身份证号码', '身份证号'],
      unitFields: ['单位名称', '单位全称', '单位'],
      nameFields: ['姓名']
    }
  ]
  const byIdCard = new Map<string, string>()
  const byName = new Map<string, { unitName: string; ambiguous: boolean }>()

  for (const source of sources) {
    const sourceWorksheet = worksheets.find((item) => item.name === source.worksheetName)
    if (!sourceWorksheet) continue
    const sourceColumns = getWorksheetLocalColumns(sourceWorksheet)
    const idColumn = findColumnByFieldName(sourceColumns, source.idFields)
    const unitColumn = findColumnByFieldName(sourceColumns, source.unitFields)
    const nameColumn = findColumnByFieldName(sourceColumns, source.nameFields)
    if (!idColumn || !unitColumn) continue

    const nameExpr = nameColumn ? quoteIdentifier(nameColumn) : `''`
    const sourceRows = await all<{ id_value: unknown; name_value: unknown; unit_value: unknown }>(
      database,
      `SELECT ${quoteIdentifier(idColumn)} AS id_value,
              ${nameExpr} AS name_value,
              ${quoteIdentifier(unitColumn)} AS unit_value
       FROM ${quoteIdentifier(sourceWorksheet.name)}`
    )
    for (const sourceRow of sourceRows) {
      const unitName = cleanText(sourceRow.unit_value)
      if (!unitName) continue
      const idCard = normalizeUniqueValue(sourceRow.id_value as WorksheetRecordValue | undefined)
      if (idCard && !byIdCard.has(idCard)) byIdCard.set(idCard, unitName)

      const name = normalizePersonName(sourceRow.name_value)
      if (!name) continue
      const existing = byName.get(name)
      if (!existing) {
        byName.set(name, { unitName, ambiguous: false })
      } else if (existing.unitName !== unitName) {
        existing.ambiguous = true
      }
    }
  }

  return { byIdCard, byName }
}

function findColumnByFieldName(
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  fieldNames: string[]
): string | undefined {
  return fieldNames.map((fieldName) => columns.find((column) => column.field.name === fieldName)?.columnName)
    .find((columnName): columnName is string => Boolean(columnName))
}

function uniqueNameUnit(entry: { unitName: string; ambiguous: boolean } | undefined): string | undefined {
  return entry && !entry.ambiguous ? entry.unitName : undefined
}

function normalizePersonName(value: unknown): string {
  return cleanText(value).replace(/\s+/g, '')
}

async function applyPersonnelStatusToRows(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  rows: Array<Record<string, WorksheetRecordValue>>
): Promise<void> {
  if (!isPersonnelStatusTargetWorksheet(worksheet) || rows.length === 0) return

  const identityColumn = getIdentityColumnName(worksheet)
  const statusColumn = getPersonnelStatusColumnName(worksheet)
  if (!identityColumn || !statusColumn) return

  const { activeIds, retiredIds, otherIds } = await loadPersonnelStatusIdentitySets(database)
  const now = new Date().toISOString()
  for (const row of rows) {
    const budgetStatus = resolveBudgetWorksheetStatus(
      worksheet.name,
      row[identityColumn],
      activeIds,
      retiredIds,
      otherIds
    )
    if (budgetStatus) {
      row.md_status = budgetStatus
      row.md_status_changed_at = now
      row.md_status_reason = '按三张工资表刷新人员状态'
    } else {
      row[statusColumn] = resolvePersonnelStatus(row[identityColumn], activeIds, retiredIds, otherIds)
    }
  }
}

type BudgetDraftCleanup = {
  retainedFieldCount: number
  clearedFieldCount: number
}

const budgetDraftForcedValues = new Map<string, Array<{ fieldName: string; value: WorksheetRecordValue }>>([
  [
    '预算其他',
    [
      { fieldName: '是否参加养老保险*', value: '否' },
      { fieldName: '国家规定工资津贴', value: 0 },
      { fieldName: '其他收入', value: 0 },
      { fieldName: '实际执行工资', value: 0 }
    ]
  ]
])

function sanitizeBudgetDraftRows(
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  rows: Array<Record<string, WorksheetRecordValue>>
): BudgetDraftCleanup | undefined {
  const retainedFields = budgetDraftRetainedFieldNames.get(worksheet.name)
  if (!retainedFields) return undefined

  const retainedColumns = new Set(
    columns
      .filter((column) => retainedFields.has(column.field.name))
      .map((column) => column.columnName)
  )

  for (const row of rows) {
    for (const columnName of Object.keys(row)) {
      if (!retainedColumns.has(columnName)) delete row[columnName]
    }
  }

  const forced = budgetDraftForcedValues.get(worksheet.name)
  if (forced) {
    const forcedColumns = forced
      .map((entry) => {
        const column = columns.find((column) => column.field.name === entry.fieldName)
        return column ? { columnName: column.columnName, value: entry.value } : undefined
      })
      .filter((entry): entry is { columnName: string; value: WorksheetRecordValue } => Boolean(entry))
    for (const row of rows) {
      for (const entry of forcedColumns) {
        row[entry.columnName] = entry.value
      }
    }
  }

  return {
    retainedFieldCount: retainedColumns.size,
    clearedFieldCount: Math.max(0, columns.length - retainedColumns.size)
  }
}

async function backfillHrBankFieldsFromImportedBudgetRows(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  rows: Array<Record<string, WorksheetRecordValue>>
): Promise<void> {
  if (!budgetDraftRetainedFieldNames.has(worksheet.name) || rows.length === 0) return

  const idColumn = findIdentityColumnFromColumns(columns)
  const bankNameColumn = columns.find((column) =>
    column.field.name === '工资卡开户银行*' || column.field.name === '工资卡开户银行'
  )?.columnName
  const bankCardColumn = columns.find((column) =>
    column.field.name === '工资卡卡号*' || column.field.name === '工资卡卡号'
  )?.columnName
  if (!idColumn || !bankNameColumn || !bankCardColumn) return

  const worksheets = readWorksheetMetadata()
  const hr = worksheets.find((item) => item.name === '人事信息')
  if (!hr) return
  const hrColumns = getWorksheetLocalColumns(hr)
  const hrIdColumn = hrColumns.find((column) => column.field.name === '身份证号码')?.columnName
  const hrBankNameColumn = hrColumns.find((column) => column.field.name === '工资卡开户银行')?.columnName
  const hrBankCardColumn = hrColumns.find((column) => column.field.name === '工资卡卡号')?.columnName
  if (!hrIdColumn || !hrBankNameColumn || !hrBankCardColumn) return

  const bankByIdCard = new Map<string, { bankName: string; bankCard: string }>()
  for (const row of rows) {
    const idCard = normalizeUniqueValue(row[idColumn])
    if (!idCard) continue
    const bankName = String(row[bankNameColumn] ?? '').trim()
    const bankCard = String(row[bankCardColumn] ?? '').trim()
    if (!bankName && !bankCard) continue
    const current = bankByIdCard.get(idCard) ?? { bankName: '', bankCard: '' }
    bankByIdCard.set(idCard, {
      bankName: bankName || current.bankName,
      bankCard: bankCard || current.bankCard
    })
  }
  if (bankByIdCard.size === 0) return

  const hrRows = await all<Record<string, unknown>>(
    database,
    `SELECT "id", ${quoteIdentifier(hrIdColumn)} AS id_card,
            ${quoteIdentifier(hrBankNameColumn)} AS bank_name,
            ${quoteIdentifier(hrBankCardColumn)} AS bank_card
     FROM ${quoteIdentifier(hr.name)}`
  )
  for (const row of hrRows) {
    const idCard = normalizeUniqueValue(row.id_card as WorksheetRecordValue | undefined)
    const bank = idCard ? bankByIdCard.get(idCard) : undefined
    if (!bank) continue
    const currentBankName = String(row.bank_name ?? '').trim()
    const currentBankCard = String(row.bank_card ?? '').trim()
    const nextBankName = currentBankName || bank.bankName
    const nextBankCard = currentBankCard || bank.bankCard
    if (nextBankName === currentBankName && nextBankCard === currentBankCard) continue
    await run(
      database,
      `UPDATE ${quoteIdentifier(hr.name)}
       SET ${quoteIdentifier(hrBankNameColumn)} = ?,
           ${quoteIdentifier(hrBankCardColumn)} = ?,
           "md_updated_at" = ?
       WHERE "id" = ?`,
      [nextBankName, nextBankCard, new Date().toISOString(), row.id]
    )
  }
}

async function buildBudgetAlignmentMessages(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  rows: Array<Record<string, WorksheetRecordValue>>
): Promise<string[]> {
  if (!budgetDraftRetainedFieldNames.has(worksheet.name)) return []

  const worksheets = readWorksheetMetadata()
  const columns = getWorksheetLocalColumns(worksheet)
  const idColumn = findIdentityColumnFromColumns(columns)
  if (!idColumn) return ['人员对齐：预算底稿缺少证件号码字段，未执行校验']

  const budgetIds = new Set(
    rows
      .map((row) => normalizeUniqueValue(row[idColumn]))
      .filter((value): value is string => Boolean(value))
  )
  if (budgetIds.size === 0) return ['人员对齐：预算底稿没有可识别的证件号码，未执行校验']

  if (worksheet.name === '预算在职') {
    const activeIds = await loadWorksheetIdentitySet(database, worksheets, '在职工资')
    const retiredIds = await loadWorksheetIdentitySet(database, worksheets, '退休工资')
    const otherIds = await loadWorksheetIdentitySet(database, worksheets, '其他工资')
    if (activeIds.size === 0) return ['人员对齐：未检测到在职工资数据，预算在职底稿暂未校验']

    const newInIntegrated = countMissing(activeIds, budgetIds)
    const movedToRetired = countWhere(budgetIds, (id) => !activeIds.has(id) && retiredIds.has(id))
    const movedToOther = countWhere(budgetIds, (id) => !activeIds.has(id) && otherIds.has(id))
    const notFound = countWhere(
      budgetIds,
      (id) => !activeIds.has(id) && !retiredIds.has(id) && !otherIds.has(id)
    )
    if (newInIntegrated === 0 && movedToRetired === 0 && movedToOther === 0 && notFound === 0) {
      return ['人员对齐：预算在职底稿与在职工资一致']
    }
    return [
      `人员对齐：在职工资新增 ${newInIntegrated} 人；底稿中 ${movedToRetired} 人已在退休工资、${movedToOther} 人已在其他工资、${notFound} 人未在三张工资表找到`
    ]
  }

  if (worksheet.name === '预算退休' || worksheet.name === '预算其他') {
    const activeIds = await loadWorksheetIdentitySet(database, worksheets, '在职工资')
    const retiredIds = await loadWorksheetIdentitySet(database, worksheets, '退休工资')
    const otherIds = await loadWorksheetIdentitySet(database, worksheets, '其他工资')
    const sourceName = worksheet.name === '预算退休' ? '退休工资' : '其他工资'
    const sourceIds = worksheet.name === '预算退休' ? retiredIds : otherIds
    const wrongActive = countWhere(budgetIds, (id) => !sourceIds.has(id) && activeIds.has(id))
    const wrongRetired =
      worksheet.name === '预算退休'
        ? 0
        : countWhere(budgetIds, (id) => !sourceIds.has(id) && retiredIds.has(id))
    const wrongOther =
      worksheet.name === '预算其他'
        ? 0
        : countWhere(budgetIds, (id) => !sourceIds.has(id) && otherIds.has(id))

    if (sourceIds.size === 0) return [`人员对齐：未检测到${sourceName}数据，${worksheet.name}底稿暂未校验`]

    const newInIntegrated = countMissing(sourceIds, budgetIds)
    const notFound = countWhere(
      budgetIds,
      (id) => !activeIds.has(id) && !retiredIds.has(id) && !otherIds.has(id)
    )
    if (newInIntegrated === 0 && wrongActive === 0 && wrongRetired === 0 && wrongOther === 0 && notFound === 0) {
      return [`人员对齐：${worksheet.name}底稿与${sourceName}一致`]
    }
    return [
      `人员对齐：${sourceName}新增 ${newInIntegrated} 人；底稿中 ${wrongActive} 人已在在职工资、${wrongRetired} 人已在退休工资、${wrongOther} 人已在其他工资、${notFound} 人未在三张工资表找到`
    ]
  }

  return []
}

async function loadWorksheetIdentitySet(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheets: ReturnType<typeof readWorksheetMetadata>,
  worksheetName: string
): Promise<Set<string>> {
  const worksheet = worksheets.find((item) => item.name === worksheetName)
  if (!worksheet) return new Set()
  const idColumn = findIdentityColumnFromColumns(getWorksheetLocalColumns(worksheet))
  if (!idColumn) return new Set()
  const rows = await all<{ id_card: unknown }>(
    database,
    `SELECT ${quoteIdentifier(idColumn)} AS id_card FROM ${quoteIdentifier(worksheet.name)}`
  )
  return new Set(
    rows
      .map((row) => normalizeUniqueValue(row.id_card as WorksheetRecordValue | undefined))
      .filter(Boolean)
  )
}

function findIdentityColumnFromColumns(
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>
): string | undefined {
  return columns.find((column) => identityFieldNames.has(column.field.name))?.columnName
}

function countMissing(left: Set<string>, right: Set<string>): number {
  return countWhere(left, (value) => !right.has(value))
}

function countWhere(values: Set<string>, predicate: (value: string) => boolean): number {
  let count = 0
  for (const value of values) {
    if (predicate(value)) count += 1
  }
  return count
}

function buildImportMessage(
  worksheetName: string,
  importedRows: number,
  townshipAdjustment?: { adjustedRows: number; refreshedRows: number },
  rankResumeAdjustment?: RankResumeImportAdjustment,
  budgetDraftCleanup?: BudgetDraftCleanup,
  budgetAlignmentMessages: string[] = []
): string {
  const base = `\u5bfc\u5165 ${importedRows} \u884c\u5230 ${worksheetName}`
  const parts = [base]

  if (budgetDraftCleanup) {
    const label = worksheetName === '工资年报' ? '仅保留指定字段' : '作为预算底稿导入：保留'
    parts.push(
      `${label} ${budgetDraftCleanup.retainedFieldCount} 个字段，清空 ${budgetDraftCleanup.clearedFieldCount} 个字段`
    )
  }


  if (townshipAdjustment) {
    if (townshipAdjustment.adjustedRows > 0) {
      parts.push(
        `\u6309\u6267\u884c\u65f6\u95f4\u81ea\u52a8\u8865\u7b97 ${townshipAdjustment.adjustedRows} \u884c\uff0c\u5237\u65b0\u65b0\u6807\u51c6 ${townshipAdjustment.refreshedRows} \u884c`
      )
    } else {
      parts.push(
        `\u6267\u884c\u65f6\u95f4\u4e3a\u5f53\u5e74\u6216\u65e0\u9700\u52a0\u5e74\uff0c\u5237\u65b0\u65b0\u6807\u51c6 ${townshipAdjustment.refreshedRows} \u884c`
      )
    }
  }

  if (rankResumeAdjustment) {
    const rankParts: string[] = []
    if (rankResumeAdjustment.filledNameRows > 0) {
      rankParts.push(`\u8865\u9f50\u7a7a\u59d3\u540d ${rankResumeAdjustment.filledNameRows} \u884c`)
    }
    if (rankResumeAdjustment.filledIdCardRows > 0) {
      rankParts.push(`\u8865\u5145\u8eab\u4efd\u8bc1\u53f7 ${rankResumeAdjustment.filledIdCardRows} \u884c`)
    }
    if (rankResumeAdjustment.missingNameRows > 0) {
      rankParts.push(`\u7f3a\u5c11\u59d3\u540d ${rankResumeAdjustment.missingNameRows} \u884c`)
    }
    if (rankResumeAdjustment.notFoundRows > 0) {
      rankParts.push(`\u4eba\u4e8b\u4fe1\u606f\u672a\u627e\u5230 ${rankResumeAdjustment.notFoundRows} \u884c`)
    }
    if (rankResumeAdjustment.duplicateRows > 0) {
      rankParts.push(`\u4eba\u4e8b\u4fe1\u606f\u91cd\u540d ${rankResumeAdjustment.duplicateRows} \u884c`)
    }
    if (rankParts.length > 0) {
      parts.push(`\u804c\u7ea7\u7b80\u5386\uff1a${rankParts.join('\uff0c')}`)
    }
  }

  parts.push(...budgetAlignmentMessages)
  return parts.join('\uff1b')
}

function buildIntegratedComputedMessages(summary: {
  recalculatedRows: number
  mismatchRows: number
  mismatchExamples: string[]
}): string[] {
  if (summary.recalculatedRows === 0) return []
  const messages = [`按工资明细重算合计字段 ${summary.recalculatedRows} 行`]
  if (summary.mismatchRows > 0) {
    const examples = summary.mismatchExamples.length
      ? `，示例：${summary.mismatchExamples.join('；')}`
      : ''
    messages.push(`源文件合计与系统重算值不一致 ${summary.mismatchRows} 行${examples}`)
  }
  return messages
}

export async function listImportBatches(limit = 50): Promise<ImportBatchSummary[]> {
  const database = await getDatabase()
  const rows = await all<{
    id: number
    source_name: string
    worksheet_id: string | null
    worksheet_name: string | null
    status: string
    row_count: number
    message: string | null
    created_at: string
  }>(
    database,
    `SELECT id, source_name, worksheet_id, worksheet_name, status, row_count, message, created_at
     FROM import_batches ORDER BY id DESC LIMIT ?`,
    [Math.min(Math.max(limit, 1), 200)]
  )

  return rows.map((row) => ({
    id: row.id,
    sourceName: row.source_name ?? '',
    worksheetId: row.worksheet_id ?? undefined,
    worksheetName: row.worksheet_name ?? undefined,
    status: (row.status as ImportBatchSummary['status']) ?? 'imported',
    rowCount: row.row_count,
    message: row.message ?? undefined,
    createdAt: row.created_at
  }))
}

export async function rollbackImportBatch(batchId: number): Promise<ImportBatchSummary> {
  const database = await getDatabase()
  const batch = await get<{
    id: number
    source_name: string
    worksheet_id: string | null
    worksheet_name: string | null
    status: string
    row_count: number
    created_at: string
  }>(database, `SELECT * FROM import_batches WHERE id = ?`, [batchId])

  if (!batch) throw new Error(`未找到导入批次：${batchId}`)
  if (batch.status === 'rolled-back') {
    throw new Error('该批次已经回滚')
  }
  if (!batch.worksheet_name) {
    throw new Error('批次缺少目标工作表，无法回滚')
  }

  await run(database, 'BEGIN TRANSACTION')
  let removed = 0
  try {
    const rollbackBatchId = await createOperationBatch(database, {
      kind: 'import.rollback',
      targetType: 'import_batch',
      targetName: String(batchId),
      reason: '回滚导入批次',
      meta: {
        batchId,
        sourceName: batch.source_name,
        worksheetName: batch.worksheet_name
      }
    })
    const rows = await all<{ worksheet_name: string; record_id: number; action: string | null; previous_values: string | null }>(
      database,
      `SELECT worksheet_name, record_id, action, previous_values FROM import_batch_rows WHERE batch_id = ?`,
      [batchId]
    )

    // 新增行仍然删除；更新行按导入时保存的旧值还原，避免回滚时删掉原有人。
    const idsByWorksheet = new Map<string, number[]>()
    for (const row of rows) {
      if ((row.action ?? 'insert') === 'update') continue
      const ids = idsByWorksheet.get(row.worksheet_name) ?? []
      ids.push(row.record_id)
      idsByWorksheet.set(row.worksheet_name, ids)
    }

    for (const row of rows.filter((item) => (item.action ?? 'insert') === 'update')) {
      const previousValues = parsePreviousImportValues(row.previous_values)
      const columnNames = Object.keys(previousValues)
      if (columnNames.length === 0) continue
      const tableName = quoteIdentifier(row.worksheet_name)
      const assignments = columnNames
        .map((column) => `${quoteIdentifier(column)} = ?`)
        .concat('"md_updated_at" = ?')
        .join(', ')
      await run(
        database,
        `UPDATE ${tableName} SET ${assignments} WHERE "id" = ?`,
        [...columnNames.map((column) => previousValues[column]), new Date().toISOString(), row.record_id]
      )
      removed += 1
    }

    for (const [worksheetName, ids] of idsByWorksheet) {
      const tableName = quoteIdentifier(worksheetName)
      for (const chunk of chunkArray(ids, 400)) {
        const placeholders = chunk.map(() => '?').join(', ')
        await logRowsBeforeDelete(database, {
          batchId: rollbackBatchId,
          tableName: worksheetName,
          worksheetName,
          action: 'delete',
          whereSql: `"id" IN (${placeholders})`,
          params: chunk
        })
        await run(database, `DELETE FROM ${tableName} WHERE "id" IN (${placeholders})`, chunk)
        removed += chunk.length
      }
    }
    await run(database, `DELETE FROM import_batch_rows WHERE batch_id = ?`, [batchId])
    await run(
      database,
      `UPDATE import_batches SET status = 'rolled-back', message = ? WHERE id = ?`,
      [`已回滚 ${removed} 行（新增行删除，更新行还原）`, batchId]
    )
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  return {
    id: batch.id,
    sourceName: batch.source_name ?? '',
    worksheetId: batch.worksheet_id ?? undefined,
    worksheetName: batch.worksheet_name ?? undefined,
    status: 'rolled-back',
    rowCount: removed,
    message: `已回滚 ${removed} 行（新增行删除，更新行还原）`,
    createdAt: batch.created_at
  }
}

function parsePreviousImportValues(value: string | null): Record<string, WorksheetRecordValue> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as Record<string, WorksheetRecordValue>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function mapRow(
  row: Record<string, unknown>,
  headerMap: Map<string, string>
): Record<string, WorksheetRecordValue> {
  const result: Record<string, WorksheetRecordValue> = {}
  for (const [source, value] of Object.entries(row)) {
    const columnName = headerMap.get(normalizeHeader(source))
    if (!columnName) continue
    result[columnName] = coerceValue(value)
  }
  return result
}

function findUniqueColumnName(
  worksheetName: string,
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>
): string | undefined {
  if (worksheetsWithoutIdentityDedupe.has(worksheetName)) return undefined
  const configuredFieldName = worksheetUniqueFieldNames.get(worksheetName)
  if (configuredFieldName) {
    return columns.find((column) => column.field.name === configuredFieldName)?.columnName
  }
  return columns.find((column) => identityFieldNames.has(column.field.name))?.columnName
}

function dedupeRowsByUniqueKey(
  rows: Array<Record<string, unknown>>,
  headerMap: Map<string, string>,
  uniqueColumnName?: string,
  partitionColumnNames: string[] = []
): Array<Record<string, WorksheetRecordValue>> {
  const sanitizedRows = rows
    .map((row) => mapRow(row, headerMap))
    .filter((row) => Object.keys(row).length > 0)

  return dedupeMappedRowsByUniqueKey(sanitizedRows, uniqueColumnName, partitionColumnNames)
}

function dedupeMappedRowsByUniqueKey(
  sanitizedRows: Array<Record<string, WorksheetRecordValue>>,
  uniqueColumnName?: string,
  partitionColumnNames: string[] = []
): Array<Record<string, WorksheetRecordValue>> {
  if (!uniqueColumnName) return sanitizedRows

  const keyedRows = new Map<string, Record<string, WorksheetRecordValue>>()
  const rowsWithoutUniqueKey: Array<Record<string, WorksheetRecordValue>> = []
  for (const row of sanitizedRows) {
    const uniqueKey = normalizeUniqueValue(row[uniqueColumnName])
    if (!uniqueKey) {
      rowsWithoutUniqueKey.push(row)
      continue
    }
    const partitionKey = partitionColumnNames
      .map((column) => normalizeUniqueValue(row[column]))
      .join('|')
    keyedRows.set(`${uniqueKey}||${partitionKey}`, row)
  }

  return [...rowsWithoutUniqueKey, ...keyedRows.values()]
}

async function buildImportDiff(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  rows: Array<Record<string, WorksheetRecordValue>>,
  uniqueColumnName?: string,
  partitionColumnNames: string[] = []
): Promise<ImportPreviewDiff> {
  const plan = await buildImportPlan(database, worksheet, columns, rows, uniqueColumnName, partitionColumnNames)
  return summarizeImportPlan(worksheet, columns, uniqueColumnName, plan)
}

async function buildImportPlan(
  database: Awaited<ReturnType<typeof getDatabase>>,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  rows: Array<Record<string, WorksheetRecordValue>>,
  uniqueColumnName?: string,
  partitionColumnNames: string[] = []
): Promise<ImportRowPlan[]> {
  if (!uniqueColumnName) {
    return rows.map((row) => ({ row, action: 'insert', changes: [] }))
  }

  const tableName = quoteIdentifier(worksheet.name)
  const plan: ImportRowPlan[] = []
  for (const row of rows) {
    const uniqueKey = normalizeUniqueValue(row[uniqueColumnName])
    const partitionKey = buildPartitionKey(row, partitionColumnNames)
    if (!uniqueKey) {
      plan.push({ row, action: 'insert', changes: [], partitionKey })
      continue
    }

    const existing = await findExistingImportRow(database, tableName, uniqueColumnName, uniqueKey, row, partitionColumnNames)
    if (!existing) {
      plan.push({ row, uniqueKey, partitionKey, action: 'insert', changes: [] })
      continue
    }

    const changes: ImportPreviewChange[] = []
    const changedValues: Record<string, WorksheetRecordValue> = {}
    const previousValues: Record<string, WorksheetRecordValue> = {}
    for (const columnName of Object.keys(row)) {
      const currentValue = coerceValue(existing[columnName])
      const nextValue = coerceValue(row[columnName])
      if (sameImportValue(currentValue, nextValue)) continue
      const fieldName = columns.find((column) => column.columnName === columnName)?.field.name ?? columnName
      changes.push({ fieldName, columnName, currentValue, nextValue })
      changedValues[columnName] = nextValue
      previousValues[columnName] = currentValue
    }

    if (changes.length === 0) {
      plan.push({ row, uniqueKey, partitionKey, action: 'unchanged', recordId: Number(existing.id), changes: [] })
    } else {
      plan.push({
        row,
        uniqueKey,
        partitionKey,
        action: 'update',
        recordId: Number(existing.id),
        previousValues,
        changedValues,
        changes
      })
    }
  }
  return plan
}

async function findExistingImportRow(
  database: Awaited<ReturnType<typeof getDatabase>>,
  tableName: string,
  uniqueColumnName: string,
  uniqueKey: string,
  row: Record<string, WorksheetRecordValue>,
  partitionColumnNames: string[]
): Promise<Record<string, unknown> | undefined> {
  const normalizedUniqueExpr = `UPPER(REPLACE(REPLACE(TRIM(CAST(${quoteIdentifier(uniqueColumnName)} AS TEXT)), ' ', ''), ',', ''))`
  const partitionPredicates = partitionColumnNames
    .map((column) => `COALESCE(CAST(${quoteIdentifier(column)} AS TEXT), '') = COALESCE(CAST(? AS TEXT), '')`)
    .join(' AND ')
  const whereClause = partitionPredicates
    ? `${normalizedUniqueExpr} = ? AND ${partitionPredicates}`
    : `${normalizedUniqueExpr} = ?`
  const params: unknown[] = [uniqueKey, ...partitionColumnNames.map((column) => row[column] ?? null)]
  return get<Record<string, unknown>>(
    database,
    `SELECT * FROM ${tableName} WHERE ${whereClause} ORDER BY "id" DESC LIMIT 1`,
    params
  )
}

function summarizeImportPlan(
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>,
  uniqueColumnName: string | undefined,
  plan: ImportRowPlan[]
): ImportPreviewDiff {
  const uniqueFieldName = uniqueColumnName
    ? columns.find((column) => column.columnName === uniqueColumnName)?.field.name ?? uniqueColumnName
    : undefined
  const insertedRows = plan.filter((item) => item.action === 'insert' && Boolean(item.uniqueKey || !uniqueColumnName)).length
  const missingKeyRows = uniqueColumnName
    ? plan.filter((item) => item.action === 'insert' && !item.uniqueKey).length
    : 0
  const updatedRows = plan.filter((item) => item.action === 'update').length
  const unchangedRows = plan.filter((item) => item.action === 'unchanged').length
  const changedCells = plan.reduce((total, item) => total + item.changes.length, 0)
  const examples = plan
    .filter((item) => item.action === 'insert' || item.action === 'update')
    .slice(0, 10)
    .map((item) => ({
      key: item.uniqueKey || '缺少唯一键',
      action: item.action as 'insert' | 'update',
      changes: item.changes.slice(0, 8)
    }))
  return {
    uniqueFieldName,
    insertedRows,
    updatedRows,
    unchangedRows,
    missingKeyRows,
    changedCells,
    requiresConfirmation: updatedRows > 0,
    examples
  }
}

function buildPartitionKey(
  row: Record<string, WorksheetRecordValue>,
  partitionColumnNames: string[]
): string | undefined {
  if (partitionColumnNames.length === 0) return undefined
  return partitionColumnNames.map((column) => normalizeUniqueValue(row[column])).join('|')
}

function sameImportValue(left: WorksheetRecordValue, right: WorksheetRecordValue): boolean {
  if (left === null || left === '') return right === null || right === ''
  if (right === null || right === '') return false
  const leftNumber = typeof left === 'number' ? left : Number(String(left).replace(/,/g, ''))
  const rightNumber = typeof right === 'number' ? right : Number(String(right).replace(/,/g, ''))
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return Math.abs(leftNumber - rightNumber) < 0.000001
  }
  return String(left).trim() === String(right).trim()
}

function formatValueForMessage(value: WorksheetRecordValue): string {
  if (value === null || value === '') return '空'
  return String(value)
}

function findPartitionColumnNames(
  worksheetName: string,
  columns: Array<{ field: WorksheetMeta['fields'][number]; columnName: string }>
): string[] {
  const fieldNames = worksheetPartitionFieldNames.get(worksheetName)
  if (!fieldNames || fieldNames.length === 0) return []
  const result: string[] = []
  for (const fieldName of fieldNames) {
    const column = columns.find((item) => item.field.name === fieldName)
    if (column) result.push(column.columnName)
  }
  return result
}

function normalizeUniqueValue(value: WorksheetRecordValue | undefined): string {
  if (value === undefined || value === null) return ''
  return String(value).trim().replace(/[,\s]+/g, '').toUpperCase()
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function coerceValue(value: unknown): WorksheetRecordValue {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return value
  return String(value)
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/g, '').toLowerCase()
}

// ===== 在编教职工基本信息：同步写入四张子表 =====
// Excel 硬编码列位置（0-indexed）：
//  4  身份证号码 (FK)
// 10  全日制学历及专业   → 教职工学历 (学历类别='全日制')
// 11  最高学历及专业     → 教职工学历 (学历类别='最高')
// 16  教师资格证-学段   ⎫
// 17  教师资格证-学科   ⎬ → 教职工教师资格
// 18  教师资格证-证书号码⎭
// 19  教师资格证-注册有效期
// 26  任教班级学科节数   → 教职工任教信息
// 34  工作履历          → 教职工工作履历

type HrChildRow = {
  idCard: string
  name: string
  eduQuan?: string      // col 10
  eduMax?: string       // col 11
  certXueduan?: string  // col 16
  certXueke?: string    // col 17
  certZhengshu?: string // col 18
  certYouxiaoqi?: string// col 19
  renjiaoRaw?: string   // col 26
  lvliRaw?: string      // col 34
}

type HrChildWriteStats = {
  insertedRows: number
  updatedRows: number
  unchangedRows: number
}

async function extractAndInsertHrDetailChildRows(
  filePath: string,
  worksheet: WorksheetMeta,
  batchId: number
): Promise<void> {
  const buffer = await readFile(filePath)
  const workbook = XLSX.read(buffer, { cellDates: false, type: 'buffer' })
  const sheet = findSheetForWorksheet(workbook, worksheet)
  if (!sheet) return

  const multiConfig = getMultiRowConfig(worksheet.name)
  if (!multiConfig || !shouldUseMultiRowConfig(sheet, multiConfig)) return

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false })

  const childRows: HrChildRow[] = []
  for (let r = multiConfig.dataStartRow; r < aoa.length; r++) {
    const row = aoa[r] as unknown[] | undefined
    if (!row) continue
    if (!isNumericCell(row[0])) continue
    const idCard = String(row[4] ?? '').trim().replace(/\s/g, '')
    if (!idCard) continue
    const col = (i: number): string => { const v = row[i]; return v ? String(v).trim() : '' }
    childRows.push({
      idCard,
      name: col(2),
      eduQuan:      col(10) || undefined,
      eduMax:       col(11) || undefined,
      certXueduan:  col(16) || undefined,
      certXueke:    col(17) || undefined,
      certZhengshu: col(18) || undefined,
      certYouxiaoqi:col(19) || undefined,
      renjiaoRaw:   col(26) || undefined,
      lvliRaw:      col(34) || undefined,
    })
  }
  if (childRows.length === 0) return

  const database = await getDatabase()
  const now = new Date().toISOString()
  const { activeIds, retiredIds, otherIds } = await loadPersonnelStatusIdentitySets(database)
  const statusColumnsByTable = new Map(
    readWorksheetMetadata()
      .filter(isPersonnelStatusTargetWorksheet)
      .map((item) => [item.name, getPersonnelStatusColumnName(item)])
      .filter((item): item is [string, string] => Boolean(item[1]))
  )
  const stats: HrChildWriteStats = { insertedRows: 0, updatedRows: 0, unchangedRows: 0 }

  await run(database, 'BEGIN TRANSACTION')
  try {
    const upsertChild = async (tbl: string, vals: Record<string, unknown>, keyFields: string[]): Promise<void> => {
      const statusColumn = statusColumnsByTable.get(tbl)
      if (statusColumn && vals['教职工身份证号'] && !vals[statusColumn]) {
        vals[statusColumn] = resolvePersonnelStatus(vals['教职工身份证号'], activeIds, retiredIds, otherIds)
      }
      const cols = Object.keys(vals).filter(k => vals[k] != null && vals[k] !== '')
      if (!cols.includes('教职工身份证号')) return
      const keyColumns = keyFields.filter((field) => vals[field] != null && vals[field] !== '')
      if (!keyColumns.includes('教职工身份证号')) keyColumns.unshift('教职工身份证号')
      const existing = await findExistingHrChildRow(database, tbl, vals, keyColumns)
      if (!existing) {
        const sql = `INSERT INTO ${quoteIdentifier(tbl)} (${cols.map(quoteIdentifier).join(', ')}, "md_created_at", "md_updated_at") VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`
        const params = [...cols.map(k => vals[k]), now, now]
        const { lastId } = await runWithLastId(database, sql, params)
        await run(
          database,
          `INSERT INTO import_batch_rows (batch_id, worksheet_name, record_id, action, previous_values) VALUES (?, ?, ?, 'insert', NULL)`,
          [batchId, tbl, lastId]
        )
        stats.insertedRows += 1
        return
      }

      const changedValues: Record<string, WorksheetRecordValue> = {}
      const previousValues: Record<string, WorksheetRecordValue> = {}
      for (const col of cols) {
        const currentValue = coerceValue(existing[col])
        const nextValue = coerceValue(vals[col])
        if (sameImportValue(currentValue, nextValue)) continue
        changedValues[col] = nextValue
        previousValues[col] = currentValue
      }
      const changedColumns = Object.keys(changedValues)
      if (changedColumns.length === 0) {
        stats.unchangedRows += 1
        return
      }
      const assignments = changedColumns
        .map((column) => `${quoteIdentifier(column)} = ?`)
        .concat('"md_updated_at" = ?')
        .join(', ')
      await run(
        database,
        `UPDATE ${quoteIdentifier(tbl)} SET ${assignments} WHERE "id" = ?`,
        [...changedColumns.map((column) => changedValues[column]), now, existing.id]
      )
      await run(
        database,
        `INSERT INTO import_batch_rows (batch_id, worksheet_name, record_id, action, previous_values) VALUES (?, ?, ?, 'update', ?)`,
        [batchId, tbl, existing.id, JSON.stringify(previousValues)]
      )
      stats.updatedRows += 1
    }

    for (const row of childRows) {
      // 教职工学历
      if (row.eduQuan) {
        await upsertChild('教职工学历', {
          '教职工身份证号': row.idCard,
          '姓名': row.name,
          '学历类别': '全日制',
          ...parseEducationCell(row.eduQuan)
        }, ['教职工身份证号', '学历类别'])
      }
      if (row.eduMax) {
        await upsertChild('教职工学历', {
          '教职工身份证号': row.idCard,
          '姓名': row.name,
          '学历类别': '最高',
          ...parseEducationCell(row.eduMax)
        }, ['教职工身份证号', '学历类别'])
      }

      // 教职工教师资格
      if (row.certXueduan || row.certXueke || row.certZhengshu || row.certYouxiaoqi) {
        await upsertChild('教职工教师资格', {
          '教职工身份证号': row.idCard,
          '姓名': row.name,
          '学段': row.certXueduan   ?? null,
          '学科': row.certXueke     ?? null,
          '证书号码': row.certZhengshu ?? null,
          '定期注册有效期': row.certYouxiaoqi ?? null,
        }, row.certZhengshu ? ['教职工身份证号', '证书号码'] : ['教职工身份证号', '学段', '学科'])
      }

      // 教职工任教信息（按换行/分号拆分）
      if (row.renjiaoRaw) {
        for (const line of row.renjiaoRaw.split(/[\n；;]/).map(s => s.trim()).filter(Boolean)) {
          await upsertChild('教职工任教信息', { '教职工身份证号': row.idCard, '姓名': row.name, '任教班级': line }, ['教职工身份证号', '任教班级'])
        }
      }

      // 教职工工作履历（按换行/分号拆分，尝试提取年份范围）
      if (row.lvliRaw) {
        for (const line of row.lvliRaw.split(/[\n；;]/).map(s => s.trim()).filter(Boolean)) {
          const parsed = parseWorkHistoryLine(line)
          await upsertChild('教职工工作履历', {
            '教职工身份证号': row.idCard,
            '姓名': row.name,
            ...parsed
          }, ['教职工身份证号', '开始时间', '结束时间', '工作单位', '职务岗位', '说明'])
        }
      }
    }

    await run(database, 'COMMIT')
    if (stats.insertedRows + stats.updatedRows + stats.unchangedRows > 0) {
      console.info(
        `[hr-detail child import] 子表增量写入：新增 ${stats.insertedRows}，更新 ${stats.updatedRows}，未变化 ${stats.unchangedRows}`
      )
    }
  } catch (err) {
    await run(database, 'ROLLBACK')
    throw err
  }
}

async function findExistingHrChildRow(
  database: Awaited<ReturnType<typeof getDatabase>>,
  tableName: string,
  values: Record<string, unknown>,
  keyFields: string[]
): Promise<Record<string, unknown> | undefined> {
  const predicates = keyFields.map((field) => `COALESCE(CAST(${quoteIdentifier(field)} AS TEXT), '') = COALESCE(CAST(? AS TEXT), '')`)
  return get<Record<string, unknown>>(
    database,
    `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${predicates.join(' AND ')} ORDER BY "id" DESC LIMIT 1`,
    keyFields.map((field) => values[field] ?? null)
  )
}
