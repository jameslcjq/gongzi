import { app, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import * as XLSX from 'xlsx'
import { all, getDatabase, run } from '../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import { readUnitSettings } from './unitSettings'
import { getWorksheetByName, tableNameOf } from './worksheetTable'
import { getDataPath, getMonthlyOutputPath } from '../config/paths'
import { parseSalaryWorkbook } from './monthly-payroll/monthlyPayrollParsers'
import { writeSalaryImportWorkbook } from './monthly-payroll/salaryImportWorkbook'
import type {
  AnnualAdjustmentApplyInput,
  AnnualAdjustmentApplyResult,
  AnnualAdjustmentChooseFilesRequest,
  AnnualAdjustmentFilePick,
  AnnualAdjustmentPreview,
  AnnualAdjustmentPreviewInput,
  AnnualAdjustmentPreviewSummary,
  AnnualAdjustmentSourceRow,
  AnnualIntegratedChangePreview,
  PersonalTaxImportGenerateInput,
  PersonalTaxImportGenerateResult,
  SocialInsuranceBaseExportInput,
  SocialInsuranceBaseExportResult
} from '../../shared/types'

type ReadSourcesResult = {
  unitName: string
  salaryRows: AnnualSalaryRow[]
  housingRows: AnnualHousingAccountRow[]
  insuranceRows: AnnualInsuranceSourceRow[]
}

type AnnualSalaryRow = {
  rowNumber: number
  idCard: string
  name: string
  housing: number
}

type AnnualHousingAccountRow = {
  idCard: string
  name: string
  account: string
  base: number
}

type AnnualInsuranceSourceRow = {
  sourceFile: string
  rowNumber: number
  idCard: string
  name: string
  rate: string
  amount: number
}

type AnnualSourcePerson = {
  idCard: string
  name: string
  values: Record<string, number>
}

type IntegratedUpdate = {
  rowId: number
  value: number
}

type IntegratedChange = AnnualIntegratedChangePreview & {
  updates: IntegratedUpdate[]
}

type IntegratedPlan = {
  changes: IntegratedChange[]
  manual: AnnualIntegratedChangePreview[]
  missing: AnnualIntegratedChangePreview[]
}

type PersonalTaxRow = {
  idCard: string
  name: string
  income: number
  pension: number
  medical: number
  unemployment: number
  housing: number
  annuity: number
}

type SocialInsuranceBaseRow = {
  idCard: string
  name: string
  base: number
}

const INSURANCE_RATE_FIELDS: Record<string, string> = {
  // 社保明细文件用缴费比例表达项目，写回在职工资时必须转成一体化字段名。
  '8%': '养老保险缴费',
  '4%': '职业年金缴费',
  '2%': '医疗保险',
  '0.5%': '失业保险',
  '100%': '医疗保险'
}

const INTEGRATED_FIELDS = ['公积金', '养老保险缴费', '职业年金缴费', '医疗保险', '失业保险']

const TAX_HEADERS = [
  '工号',
  '*姓名',
  '*证件类型',
  '*证件号码',
  '本期收入',
  '本期免税收入',
  '基本养老保险费',
  '基本医疗保险费',
  '失业保险费',
  '住房公积金',
  '累计子女教育',
  '累计继续教育',
  '累计住房贷款利息',
  '累计住房租金',
  '累计赡养老人',
  '累计3岁以下婴幼儿照护',
  '累计个人养老金',
  '企业(职业)年金',
  '商业健康保险',
  '税延养老保险',
  '公务交通费用',
  '通讯费用',
  '律师办案费用',
  '西藏附加减除费用',
  '其他',
  '准予扣除的捐赠额',
  '减免税额',
  '备注'
]

const SOCIAL_BASE_INSURANCE_HEADERS = [
  '120|机关事业单位养老保险',
  '180|职业年金',
  '210|失业保险',
  '310|职工基本医疗保险',
  '330|大额医疗费用补助',
  '410|工伤保险',
  '510|生育保险'
]

export async function chooseAnnualAdjustmentFiles(
  request: AnnualAdjustmentChooseFilesRequest
): Promise<AnnualAdjustmentFilePick[] | null> {
  const result = await dialog.showOpenDialog({
    title: request.title || '选择 Excel 文件',
    properties: request.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'Excel 文件', extensions: ['xls', 'xlsx'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths.map((filePath) => ({ filePath, fileName: basename(filePath) }))
}

export async function previewAnnualAdjustment(
  input: AnnualAdjustmentPreviewInput
): Promise<AnnualAdjustmentPreview> {
  validateAnnualInput(input)
  const sources = await readAnnualSources(input)
  const prepared = prepareAnnualSources(sources)
  const integratedPlan = await buildAnnualIntegratedPlan(prepared.people)
  return {
    unitName: sources.unitName,
    summary: buildPreviewSummary(sources, prepared, integratedPlan),
    sourceRows: prepared.sourceRows.slice(0, 200),
    integratedChanges: integratedPlan.changes.slice(0, 100),
    manualIntegratedChanges: integratedPlan.manual.slice(0, 100)
  }
}

export async function applyAnnualAdjustment(
  input: AnnualAdjustmentApplyInput
): Promise<AnnualAdjustmentApplyResult> {
  validateAnnualInput(input)
  const sources = await readAnnualSources(input)
  const prepared = prepareAnnualSources(sources)
  const integratedPlan = await buildAnnualIntegratedPlan(prepared.people)
  const outputDir = getMonthlyOutputPath()
  mkdirSync(outputDir, { recursive: true })
  const stamp = timestamp()

  const salaryOutputPath = join(
    outputDir,
    `社保个税_${safeFileStem(input.salaryWorkbookPath)}_年初调整_${stamp}${extname(input.salaryWorkbookPath) || '.xlsx'}`
  )
  const salaryApplied = await writeAnnualValuesToSalaryWorkbook({
    salaryWorkbookPath: input.salaryWorkbookPath,
    outputPath: salaryOutputPath,
    people: prepared.people
  })

  let salaryImportPath: string | undefined
  const salaryImportWarnings: string[] = []
  try {
    const salaryImportSource = await parseSalaryWorkbook(salaryOutputPath)
    const candidatePath = join(outputDir, `社保个税_工资导入_年初调整_${stamp}.xls`)
    await writeSalaryImportWorkbook(candidatePath, salaryImportSource)
    salaryImportPath = candidatePath
  } catch (error) {
    salaryImportWarnings.push(
      `工资导入文件生成失败：${error instanceof Error ? error.message : String(error)}`
    )
  }

  let housingDeclarationPath: string | undefined
  let housingMissingLogPath: string | undefined
  if (input.housingAccountWorkbookPath) {
    const housingOutput = writeHousingDeclarationWorkbook({
      outputDir,
      stamp,
      unitName: sources.unitName,
      salaryRows: sources.salaryRows,
      housingByIdCard: prepared.housingByIdCard
    })
    housingDeclarationPath = housingOutput.workbookPath
    housingMissingLogPath = housingOutput.missingLogPath
  }

  let integratedApplied = 0
  if (input.confirmIntegratedWriteBack) {
    await applyIntegratedPlan(integratedPlan)
    integratedApplied = integratedPlan.changes.length
  }

  return {
    ok: true,
    message: `已生成年初调整工资表，工资表写回 ${salaryApplied} 人${integratedApplied ? `，在职工资回写 ${integratedApplied} 项` : ''}`,
    salaryOutputPath,
    salaryImportPath,
    housingDeclarationPath,
    housingMissingLogPath,
    salaryApplied,
    integratedApplied,
    integratedManualCount: integratedPlan.manual.length,
    warnings: [
      ...prepared.warnings,
      ...salaryImportWarnings,
      ...buildMissingIntegratedWarnings(integratedPlan.missing),
      ...(integratedPlan.manual.length
        ? [`在职工资有 ${integratedPlan.manual.length} 项需要人工判断，未自动回写`]
        : [])
    ]
  }
}

export async function generatePersonalTaxImportWorkbook(
  input: PersonalTaxImportGenerateInput
): Promise<PersonalTaxImportGenerateResult> {
  if (input.incomeFields.length === 0) throw new Error('请至少选择一个计入本期收入的工资字段')
  const rows = await buildPersonalTaxRows(input.incomeFields)
  if (rows.length === 0) throw new Error('在职工资没有可导出的人员')

  const outputDir = getMonthlyOutputPath()
  mkdirSync(outputDir, { recursive: true })
  const filePath = join(outputDir, `社保个税_正常工资薪金所得_${timestamp()}.xls`)
  await writePersonalTaxWorkbook(
    filePath,
    input.templateWorkbookPath ?? resolveBuiltinTemplatePath('正常工资薪金所得.xls'),
    rows
  )

  const sum = (field: keyof PersonalTaxRow): number =>
    roundMoney(rows.reduce((total, row) => total + num(row[field]), 0))

  return {
    ok: true,
    filePath,
    rowCount: rows.length,
    incomeTotal: sum('income'),
    pensionTotal: sum('pension'),
    medicalTotal: sum('medical'),
    unemploymentTotal: sum('unemployment'),
    housingTotal: sum('housing'),
    annuityTotal: sum('annuity')
  }
}

export async function exportSocialInsuranceBaseWorkbook(
  input: SocialInsuranceBaseExportInput
): Promise<SocialInsuranceBaseExportResult> {
  if (input.baseFields.length === 0) throw new Error('请至少选择一个计入社保基数的工资字段')
  const rows = await buildSocialInsuranceBaseRows(input.baseFields)
  if (rows.length === 0) throw new Error('在职工资没有可导出的人员')

  const outputDir = getMonthlyOutputPath()
  mkdirSync(outputDir, { recursive: true })
  const stamp = timestamp()
  const filePath = join(outputDir, `社保个税_参保职工列表_社保基数_${stamp}.xlsx`)
  await writeSocialInsuranceBaseWorkbook(
    filePath,
    input.templateWorkbookPath ?? resolveBuiltinTemplatePath('参保职工列表模板.xlsx'),
    rows,
    stamp
  )

  return {
    ok: true,
    filePath,
    rowCount: rows.length,
    baseTotal: roundMoney(rows.reduce((total, row) => total + row.base, 0))
  }
}

async function buildPersonalTaxRows(incomeFields: string[]): Promise<PersonalTaxRow[]> {
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const colByField = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const idColumn = colByField.get('证件号码')
  const nameColumn = colByField.get('姓名')
  const batchColumn = colByField.get('工资批次编码')
  if (!idColumn || !nameColumn) throw new Error('在职工资缺少姓名或证件号码字段')

  const missingIncomeFields = incomeFields.filter((field) => !colByField.has(field))
  if (missingIncomeFields.length > 0) {
    throw new Error(`在职工资缺少字段：${missingIncomeFields.join('、')}`)
  }

  const database = await getDatabase()
  const rawRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ${tableNameOf(worksheet)}`
  )

  const latestByIdBatch = new Map<string, Record<string, unknown>>()
  for (const row of rawRows) {
    const idCard = normalizeIdCard(row[idColumn])
    if (!idCard) continue
    const key = batchColumn ? `${idCard}\u0000${text(row[batchColumn])}` : idCard
    const previous = latestByIdBatch.get(key)
    if (!previous || num(row.id) > num(previous.id)) latestByIdBatch.set(key, row)
  }

  const byIdCard = new Map<string, Record<string, unknown>[]>()
  for (const row of latestByIdBatch.values()) {
    const idCard = normalizeIdCard(row[idColumn])
    const grouped = byIdCard.get(idCard) ?? []
    grouped.push(row)
    byIdCard.set(idCard, grouped)
  }

  const taxRows: PersonalTaxRow[] = []
  for (const [idCard, personRows] of byIdCard.entries()) {
    const representative = personRows.reduce((best, row) => (num(row.id) > num(best.id) ? row : best))
    const sumField = (fieldName: string): number => {
      const columnName = colByField.get(fieldName)
      if (!columnName) return 0
      return roundMoney(personRows.reduce((sum, row) => sum + num(row[columnName]), 0))
    }
    const income = roundMoney(incomeFields.reduce((sum, field) => sum + sumField(field), 0))
    taxRows.push({
      idCard,
      name: text(representative[nameColumn]),
      income,
      pension: sumField('养老保险缴费'),
      medical: sumField('医疗保险'),
      unemployment: sumField('失业保险'),
      housing: sumField('公积金'),
      annuity: sumField('职业年金缴费')
    })
  }

  return taxRows
    .filter((row) => row.name && row.idCard)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

async function buildSocialInsuranceBaseRows(baseFields: string[]): Promise<SocialInsuranceBaseRow[]> {
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const colByField = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const idColumn = colByField.get('证件号码')
  const nameColumn = colByField.get('姓名')
  const batchColumn = colByField.get('工资批次编码')
  if (!idColumn || !nameColumn) throw new Error('在职工资缺少姓名或证件号码字段')

  const missingBaseFields = baseFields.filter((field) => !colByField.has(field))
  if (missingBaseFields.length > 0) {
    throw new Error(`在职工资缺少字段：${missingBaseFields.join('、')}`)
  }

  const database = await getDatabase()
  const rawRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM ${tableNameOf(worksheet)}`
  )

  const latestByIdBatch = new Map<string, Record<string, unknown>>()
  for (const row of rawRows) {
    const idCard = normalizeIdCard(row[idColumn])
    if (!idCard) continue
    const key = batchColumn ? `${idCard}\u0000${text(row[batchColumn])}` : idCard
    const previous = latestByIdBatch.get(key)
    if (!previous || num(row.id) > num(previous.id)) latestByIdBatch.set(key, row)
  }

  const byIdCard = new Map<string, Record<string, unknown>[]>()
  for (const row of latestByIdBatch.values()) {
    const idCard = normalizeIdCard(row[idColumn])
    const grouped = byIdCard.get(idCard) ?? []
    grouped.push(row)
    byIdCard.set(idCard, grouped)
  }

  const rows: SocialInsuranceBaseRow[] = []
  for (const [idCard, personRows] of byIdCard.entries()) {
    const representative = personRows.reduce((best, row) => (num(row.id) > num(best.id) ? row : best))
    const sumField = (fieldName: string): number => {
      const columnName = colByField.get(fieldName)
      if (!columnName) return 0
      return roundMoney(personRows.reduce((sum, row) => sum + num(row[columnName]), 0))
    }
    rows.push({
      idCard,
      name: text(representative[nameColumn]),
      base: roundMoney(baseFields.reduce((sum, field) => sum + sumField(field), 0))
    })
  }

  return rows
    .filter((row) => row.name && row.idCard)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

async function writePersonalTaxWorkbook(
  filePath: string,
  templateWorkbookPath: string | undefined,
  rows: PersonalTaxRow[]
): Promise<void> {
  if (templateWorkbookPath && existsForRead(templateWorkbookPath)) {
    const stamp = timestamp()
    const dataPath = join(dirname(filePath), `个税导入数据_${stamp}.json`)
    writeFileSync(dataPath, JSON.stringify(rows), 'utf8')
    try {
      await runPowerShellScript(
        buildWritePersonalTaxTemplateScript({
          templateWorkbookPath,
          outputPath: filePath,
          dataPath
        }),
        '写入个税导入模板失败'
      )
    } finally {
      try {
        unlinkSync(dataPath)
      } catch {
        // best-effort cleanup
      }
    }
    return
  }

  const workbook = templateWorkbookPath && existsForRead(templateWorkbookPath)
    ? XLSX.readFile(templateWorkbookPath, { cellDates: false })
    : XLSX.utils.book_new()

  const sheetName = workbook.SheetNames.includes('正常工资薪金收入')
    ? '正常工资薪金收入'
    : workbook.SheetNames[0] || '正常工资薪金收入'

  const data: Array<Array<string | number>> = [
    TAX_HEADERS,
    ...rows.map((row) => [
      '',
      row.name,
      '居民身份证',
      row.idCard,
      row.income,
      0,
      row.pension,
      row.medical,
      row.unemployment,
      row.housing,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      row.annuity,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ''
    ])
  ]
  const sheet = XLSX.utils.aoa_to_sheet(data)
  sheet['!cols'] = TAX_HEADERS.map((header) => ({ wch: Math.max(12, header.length + 4) }))

  workbook.Sheets[sheetName] = sheet
  if (!workbook.SheetNames.includes(sheetName)) workbook.SheetNames.unshift(sheetName)
  if (!workbook.SheetNames.includes('填表说明')) {
    const instruction = XLSX.utils.aoa_to_sheet([
      ['注意事项：模板中带 * 的栏目为必填项，导入时不能为空。'],
      ['证照类型填写范围'],
      ['居民身份证']
    ])
    XLSX.utils.book_append_sheet(workbook, instruction, '填表说明')
  }

  writeFileSync(filePath, XLSX.write(workbook, { bookType: 'xls', type: 'buffer' }))
}

async function writeSocialInsuranceBaseWorkbook(
  filePath: string,
  templateWorkbookPath: string | undefined,
  rows: SocialInsuranceBaseRow[],
  stamp: string
): Promise<void> {
  if (templateWorkbookPath && existsForRead(templateWorkbookPath)) {
    const dataPath = join(dirname(filePath), `社保基数数据_${stamp}.json`)
    writeFileSync(dataPath, JSON.stringify(rows), 'utf8')
    try {
      await runPowerShellScript(
        buildWriteSocialBaseTemplateScript({
          templateWorkbookPath,
          outputPath: filePath,
          dataPath
        }),
        '写入社保基数模板失败'
      )
    } finally {
      try {
        unlinkSync(dataPath)
      } catch {
        // best-effort cleanup
      }
    }
    return
  }

  const workbook = XLSX.utils.book_new()
  const rowsData: Array<Array<string | number>> = [
    ['单位社保费缴费工资年度申报', '', '', '', '', '', '', '', '', '', ''],
    ['*缴费人识别号：', '', '', '', ...SOCIAL_BASE_INSURANCE_HEADERS],
    ['*姓名', '*身份证件类型代码', '*身份证件号码', '分组', ...SOCIAL_BASE_INSURANCE_HEADERS.map(() => '缴费工资')],
    ...rows.map((row) => [
      row.name,
      '201',
      row.idCard,
      '',
      row.base,
      row.base,
      row.base,
      row.base,
      row.base,
      row.base,
      row.base
    ])
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rowsData)
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
    { s: { r: 1, c: 1 }, e: { r: 1, c: 3 } }
  ]
  sheet['!cols'] = Array.from({ length: 11 }, () => ({ wch: 20 }))
  XLSX.utils.book_append_sheet(workbook, sheet, '缴费工资申报数据')
  const instruction = XLSX.utils.aoa_to_sheet([
    ['1、简要说明'],
    ['按照该模板标准将员工工资信息编辑好，将该模板导入系统后即可申报。'],
    ['身份证件类型默认居民身份证代码 201。']
  ])
  XLSX.utils.book_append_sheet(workbook, instruction, '填表说明')
  writeFileSync(filePath, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }))
}

function existsForRead(path: string): boolean {
  try {
    return Boolean(path && existsSync(path))
  } catch {
    return false
  }
}

function resolveBuiltinTemplatePath(fileName: string): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'dist', 'templates', fileName),
    join(app.getAppPath(), 'public', 'templates', fileName),
    join(process.cwd(), 'dist', 'templates', fileName),
    join(process.cwd(), 'public', 'templates', fileName)
  ]
  const source = candidates.find((candidate) => existsForRead(candidate))
  if (!source) return undefined
  const targetDir = getDataPath('内置模板')
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, fileName)
  copyFileSync(source, target)
  return target
}

function validateAnnualInput(input: AnnualAdjustmentPreviewInput): void {
  if (!input.salaryWorkbookPath) throw new Error('请选择工资表')
  if (!input.housingAccountWorkbookPath && input.insuranceDetailWorkbookPaths.length === 0) {
    throw new Error('请至少选择 grxxlist 或五险明细文件')
  }
}

async function readAnnualSources(input: AnnualAdjustmentPreviewInput): Promise<ReadSourcesResult> {
  const script = buildReadSourcesScript(input)
  const output = await runPowerShellScript(script, '读取年初调整来源表失败')
  const jsonLine = output.trim().split(/\r?\n/).find((line) => line.trim().startsWith('{'))
  if (!jsonLine) throw new Error('读取年初调整来源表失败：未返回数据')
  const result = JSON.parse(jsonLine) as ReadSourcesResult
  if (!result.unitName) {
    const settings = await readUnitSettings()
    result.unitName = settings.unitFullName
  }
  return result
}

function prepareAnnualSources(sources: ReadSourcesResult): {
  people: AnnualSourcePerson[]
  sourceRows: AnnualAdjustmentSourceRow[]
  warnings: string[]
  housingByIdCard: Map<string, AnnualHousingAccountRow>
} {
  const salaryById = new Map(sources.salaryRows.map((row) => [row.idCard, row]))
  const salaryNameToId = new Map<string, string>()
  for (const row of sources.salaryRows) {
    if (row.name && row.idCard && !salaryNameToId.has(row.name)) salaryNameToId.set(row.name, row.idCard)
  }

  const housingByIdCard = new Map(sources.housingRows.map((row) => [row.idCard, row]))
  const sourceRows: AnnualAdjustmentSourceRow[] = []
  const warnings: string[] = []
  const insuranceById = new Map<string, Record<string, number>>()

  for (const row of sources.insuranceRows) {
    const fieldName = INSURANCE_RATE_FIELDS[row.rate]
    const salaryRow = salaryById.get(row.idCard)
    if (!fieldName) {
      warnings.push(`${row.sourceFile} 第 ${row.rowNumber} 行费率 ${row.rate || '空'} 未识别，已跳过`)
      sourceRows.push({ ...row, fieldName: '未识别', status: 'skipped', reason: '费率未识别' })
      continue
    }
    if (!salaryRow) {
      const sameNameId = row.name ? salaryNameToId.get(row.name) : undefined
      sourceRows.push({
        ...row,
        fieldName,
        status: sameNameId ? 'id-conflict' : 'missing',
        reason: sameNameId ? `工资表同名人员身份证为 ${sameNameId}` : '工资表未找到该人员'
      })
      continue
    }

    const values = insuranceById.get(row.idCard) ?? {}
    values[fieldName] = roundMoney((values[fieldName] ?? 0) + row.amount)
    insuranceById.set(row.idCard, values)
    sourceRows.push({ ...row, fieldName, status: 'matched', reason: '' })
  }

  const people: AnnualSourcePerson[] = sources.salaryRows.map((row) => ({
    idCard: row.idCard,
    name: row.name,
    values: {
      公积金: roundMoney(row.housing),
      ...(insuranceById.get(row.idCard) ?? {})
    }
  }))

  return { people, sourceRows, warnings, housingByIdCard }
}

function buildPreviewSummary(
  sources: ReadSourcesResult,
  prepared: ReturnType<typeof prepareAnnualSources>,
  plan: IntegratedPlan
): AnnualAdjustmentPreviewSummary {
  const matchedInsuranceRows = prepared.sourceRows.filter((row) => row.status === 'matched').length
  return {
    salaryPeople: sources.salaryRows.length,
    housingAccountRows: sources.housingRows.length,
    insuranceRows: sources.insuranceRows.length,
    matchedInsuranceRows,
    blockedInsuranceRows: prepared.sourceRows.length - matchedInsuranceRows,
    integratedChangeCount: plan.changes.length,
    integratedManualCount: plan.manual.length,
    warnings: [
      ...prepared.warnings,
      ...buildMissingIntegratedWarnings(plan.missing)
    ]
  }
}

function writeHousingDeclarationWorkbook(input: {
  outputDir: string
  stamp: string
  unitName: string
  salaryRows: AnnualSalaryRow[]
  housingByIdCard: Map<string, AnnualHousingAccountRow>
}): { workbookPath: string; missingLogPath?: string } {
  const rows: Array<Array<string | number>> = [
    ['缴存基数调整列表', '', '', '', '', '', '', '', ''],
    ['证件号码', '姓名', '调整前缴存基数', '调整后缴存基数', '调整后单位月缴存额', '调整后个人月缴存额', '调整后月缴存额', '调整后住房补贴月缴存额', '个人账号']
  ]
  const missing: string[] = []
  for (const row of input.salaryRows) {
    const matched = input.housingByIdCard.get(row.idCard)
    const amount = roundMoney(row.housing)
    if (!matched?.account) missing.push(`第 ${row.rowNumber} 行 | 姓名：${row.name} | 证件号码：${row.idCard}`)
    rows.push([
      row.idCard,
      row.name,
      matched?.base ?? 0,
      amount ? roundMoney(amount / 0.12) : 0,
      amount,
      amount,
      roundMoney(amount * 2),
      0,
      matched?.account ?? ''
    ])
  }

  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }]
  sheet['!cols'] = [20, 12, 16, 16, 18, 18, 16, 22, 16].map((wch) => ({ wch }))
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
  const workbookPath = join(
    input.outputDir,
    `${safeFileStem(input.unitName || '公积金申报')}_公积金申报_${input.stamp}.xls`
  )
  writeFileSync(workbookPath, XLSX.write(workbook, { bookType: 'xls', type: 'buffer' }))

  let missingLogPath: string | undefined
  if (missing.length > 0) {
    missingLogPath = join(input.outputDir, `未查到公积金账号_${input.stamp}.txt`)
    writeFileSync(
      missingLogPath,
      `以下人员未查到公积金账号：\r\n生成时间：${new Date().toLocaleString()}\r\n${'-'.repeat(30)}\r\n${missing.join('\r\n')}`,
      'utf16le'
    )
  }

  return { workbookPath, missingLogPath }
}

async function writeAnnualValuesToSalaryWorkbook(input: {
  salaryWorkbookPath: string
  outputPath: string
  people: AnnualSourcePerson[]
}): Promise<number> {
  const values: Record<string, Record<string, number>> = {}
  for (const person of input.people) {
    const entries = Object.entries(person.values).filter(([, value]) => value !== undefined && value !== null)
    if (entries.length === 0) continue
    values[person.idCard] = Object.fromEntries(entries)
  }
  const script = buildWriteSalaryScript({
    salaryWorkbookPath: input.salaryWorkbookPath,
    outputPath: input.outputPath,
    values
  })
  const output = await runPowerShellScript(script, '写回年初调整工资表失败')
  const match = output.match(/applied=(\d+)/)
  return match ? Number(match[1]) : 0
}

async function buildAnnualIntegratedPlan(sourcePeople: AnnualSourcePerson[]): Promise<IntegratedPlan> {
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const idColumn = columns.find((column) => column.field.name === '证件号码')?.columnName
  const nameColumn = columns.find((column) => column.field.name === '姓名')?.columnName
  const batchColumn = columns.find((column) => column.field.name === '工资批次编码')?.columnName
  if (!idColumn) throw new Error('在职工资缺少证件号码字段')
  const fieldColumns = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)

  const latestByIdBatch = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idColumn])
    if (!idCard) continue
    const key = batchColumn ? `${idCard}\u0000${text(row[batchColumn])}` : idCard
    const previous = latestByIdBatch.get(key)
    if (!previous || num(row.id) > num(previous.id)) latestByIdBatch.set(key, row)
  }

  const rowsByIdCard = new Map<string, Record<string, unknown>[]>()
  for (const row of latestByIdBatch.values()) {
    const idCard = normalizeIdCard(row[idColumn])
    const grouped = rowsByIdCard.get(idCard) ?? []
    grouped.push(row)
    rowsByIdCard.set(idCard, grouped)
  }

  const changes: IntegratedChange[] = []
  const manual: AnnualIntegratedChangePreview[] = []
  const missing: AnnualIntegratedChangePreview[] = []
  for (const person of sourcePeople) {
    const personRows = rowsByIdCard.get(person.idCard)
    if (!personRows) {
      for (const fieldName of INTEGRATED_FIELDS) {
        if (!(fieldName in person.values)) continue
        missing.push({
          idCard: person.idCard,
          name: person.name,
          fieldName,
          sourceValue: roundMoney(num(person.values[fieldName])),
          targetValue: 0,
          reason: '在职工资中未找到该身份证'
        })
      }
      continue
    }
    for (const fieldName of INTEGRATED_FIELDS) {
      if (!(fieldName in person.values)) continue
      const columnName = fieldColumns.get(fieldName)
      if (!columnName) continue
      const sourceValue = roundMoney(num(person.values[fieldName]))
      const targetValue = roundMoney(personRows.reduce((sum, row) => sum + num(row[columnName]), 0))
      if (roundMoney(sourceValue - targetValue) === 0) continue
      const decision = decideIntegratedUpdate(personRows, columnName, sourceValue, batchColumn)
      const preview = {
        idCard: person.idCard,
        name: person.name || (nameColumn ? text(personRows[0]?.[nameColumn]) : ''),
        fieldName,
        sourceValue,
        targetValue,
        reason: decision.reason
      }
      if (decision.ok) changes.push({ ...preview, updates: decision.updates })
      else manual.push(preview)
    }
  }
  return { changes, manual, missing }
}

function buildMissingIntegratedWarnings(missing: AnnualIntegratedChangePreview[]): string[] {
  const byPerson = new Map<string, AnnualIntegratedChangePreview>()
  for (const item of missing) {
    const key = item.idCard || item.name
    if (key && !byPerson.has(key)) byPerson.set(key, item)
  }
  const people = Array.from(byPerson.values())
  if (people.length === 0) return []
  const examples = people.slice(0, 8).map((item) => item.name ? `${item.name}(${item.idCard})` : item.idCard)
  const suffix = people.length > examples.length ? `，等 ${people.length} 人` : ''
  return [
    `工资表有 ${people.length} 人按身份证在在职工资中未找到，相关年初调整金额未自动回写。示例：${examples.join('、')}${suffix}`
  ]
}

function decideIntegratedUpdate(
  personRows: Record<string, unknown>[],
  fieldColumn: string,
  sourceValue: number,
  batchColumn: string | undefined
): { ok: true; reason: string; updates: IntegratedUpdate[] } | { ok: false; reason: string } {
  const nonZeroRows = personRows.filter((row) => num(row[fieldColumn]) !== 0)
  if (sourceValue === 0) {
    return {
      ok: true,
      reason: '来源为 0，清空该字段现有批次金额',
      updates: personRows.map((row) => ({ rowId: num(row.id), value: 0 }))
    }
  }
  if (nonZeroRows.length === 1) {
    return {
      ok: true,
      reason: `沿用该字段已有批次${batchColumn ? ` ${text(nonZeroRows[0][batchColumn])}` : ''}`,
      updates: [{ rowId: num(nonZeroRows[0].id), value: sourceValue }]
    }
  }
  if (nonZeroRows.length > 1) {
    return { ok: false, reason: '该字段在多个批次都有金额，无法自动判断拆分方式' }
  }
  const preferred = personRows.find((row) => !batchColumn || text(row[batchColumn]) === '001') ?? personRows[0]
  if (!preferred) return { ok: false, reason: '在职工资没有可写入行' }
  return {
    ok: true,
    reason: batchColumn ? `写入批次 ${text(preferred[batchColumn]) || '当前行'}` : '写入当前行',
    updates: [{ rowId: num(preferred.id), value: sourceValue }]
  }
}

async function applyIntegratedPlan(plan: IntegratedPlan): Promise<void> {
  if (plan.changes.length === 0) return
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const fieldColumns = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const table = tableNameOf(worksheet)
  const database = await getDatabase()
  const now = new Date().toISOString()
  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const change of plan.changes) {
      const columnName = fieldColumns.get(change.fieldName)
      if (!columnName) continue
      for (const update of change.updates) {
        await run(
          database,
          `UPDATE ${table}
             SET ${quoteIdentifier(columnName)} = ?,
                 "md_updated_at" = ?
           WHERE "id" = ?`,
          [update.value, now, update.rowId]
        )
      }
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }
}

function buildReadSourcesScript(input: AnnualAdjustmentPreviewInput): string {
  const salaryPath = psString(input.salaryWorkbookPath)
  const housingPath = psString(input.housingAccountWorkbookPath ?? '')
  const insurancePaths = input.insuranceDetailWorkbookPaths.map(psString).join(', ')
  return `
$ErrorActionPreference = 'Stop'
$SalaryPath = ${salaryPath}
$HousingPath = ${housingPath}
$InsurancePaths = @(${insurancePaths})

function N([object]$v) {
  if ($null -eq $v) { return '' }
  return ([string]$v).Trim()
}
function Amount([object]$v) {
  $s = (N $v) -replace ',', '' -replace '\\s+', ''
  $n = 0.0
  if ([double]::TryParse($s, [ref]$n)) { return [math]::Round($n, 2) }
  return 0
}
function Norm([string]$s) {
  if ($null -eq $s) { return '' }
  return (($s -replace '\\s+', '') -replace '[（）()]', '').Trim()
}
function CellText($ws, [int]$r, [int]$c) {
  $v = $ws.Cells.Item($r, $c).Text
  return N $v
}
function FindHeader($ws, [string[][]]$requiredAliases) {
  $used = $ws.UsedRange
  $firstRow = [int]$used.Row
  $lastRow = [int]($used.Row + $used.Rows.Count - 1)
  $firstCol = [int]$used.Column
  $lastCol = [int]($used.Column + $used.Columns.Count - 1)
  for ($r = $firstRow; $r -le [math]::Min($lastRow, $firstRow + 30); $r++) {
    $headers = @{}
    for ($c = $firstCol; $c -le $lastCol; $c++) {
      $key = Norm (CellText $ws $r $c)
      if ($key -and -not $headers.ContainsKey($key)) { $headers[$key] = $c }
    }
    $ok = $true
    foreach ($aliases in $requiredAliases) {
      $found = $false
      foreach ($alias in $aliases) {
        if ($headers.ContainsKey((Norm $alias))) { $found = $true; break }
      }
      if (-not $found) { $ok = $false; break }
    }
    if ($ok) { return @{ Row = $r; Headers = $headers; LastRow = $lastRow; LastCol = $lastCol } }
  }
  throw "找不到表头：" + (($requiredAliases | ForEach-Object { $_[0] }) -join ', ')
}
function Col($headers, [string[]]$aliases) {
  foreach ($alias in $aliases) {
    $key = Norm $alias
    if ($headers.ContainsKey($key)) { return [int]$headers[$key] }
  }
  return 0
}
function SheetOrFirst($wb, [string]$name) {
  if ($name) {
    try { return $wb.Sheets.Item($name) } catch {}
  }
  return $wb.Sheets.Item(1)
}

$xl = $null
try {
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false

  $salaryRows = New-Object System.Collections.Generic.List[object]
  $housingRows = New-Object System.Collections.Generic.List[object]
  $insuranceRows = New-Object System.Collections.Generic.List[object]
  $unitName = ''

  $wb = $xl.Workbooks.Open($SalaryPath, 3, $true)
  try {
    try { $unitName = N $wb.Sheets.Item('汇总').Range('A4').Text } catch {}
    $ws = SheetOrFirst $wb '公办在职'
    $h = FindHeader $ws @(@('证件号码','身份证号','身份证'), @('姓名'), @('住房公积金','公积金'))
    $idCol = Col $h.Headers @('证件号码','身份证号','身份证')
    $nameCol = Col $h.Headers @('姓名')
    $housingCol = Col $h.Headers @('住房公积金','公积金')
    for ($r = $h.Row + 1; $r -le $h.LastRow; $r++) {
      $id = (CellText $ws $r $idCol).ToUpper()
      $name = CellText $ws $r $nameCol
      if (-not $id -or -not $name -or $name.Contains('合计')) { continue }
      $salaryRows.Add([pscustomobject]@{
        rowNumber = $r
        idCard = $id
        name = $name
        housing = Amount (CellText $ws $r $housingCol)
      }) | Out-Null
    }
  } finally {
    $wb.Close($false)
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null
  }

  if ($HousingPath) {
    $wb = $xl.Workbooks.Open($HousingPath, 3, $true)
    try {
      $ws = SheetOrFirst $wb ''
      $h = FindHeader $ws @(@('证件号码','身份证号','身份证'), @('姓名'), @('个人账号'), @('个人缴存基数','缴存基数'))
      $idCol = Col $h.Headers @('证件号码','身份证号','身份证')
      $nameCol = Col $h.Headers @('姓名')
      $accountCol = Col $h.Headers @('个人账号')
      $baseCol = Col $h.Headers @('个人缴存基数','缴存基数')
      for ($r = $h.Row + 1; $r -le $h.LastRow; $r++) {
        $id = (CellText $ws $r $idCol).ToUpper()
        if (-not $id) { continue }
        $housingRows.Add([pscustomobject]@{
          idCard = $id
          name = CellText $ws $r $nameCol
          account = CellText $ws $r $accountCol
          base = Amount (CellText $ws $r $baseCol)
        }) | Out-Null
      }
    } finally {
      $wb.Close($false)
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null
    }
  }

  foreach ($path in $InsurancePaths) {
    if (-not $path) { continue }
    $wb = $xl.Workbooks.Open($path, 3, $true)
    try {
      $ws = SheetOrFirst $wb ''
      $h = FindHeader $ws @(@('姓名'), @('证件号码','身份证号','身份证'), @('费率'), @('应缴费额','应补(退)费额','应补退费额'))
      $nameCol = Col $h.Headers @('姓名')
      $idCol = Col $h.Headers @('证件号码','身份证号','身份证')
      $rateCol = Col $h.Headers @('费率')
      $amountCol = Col $h.Headers @('应缴费额','应补(退)费额','应补退费额')
      for ($r = $h.Row + 1; $r -le $h.LastRow; $r++) {
        $id = (CellText $ws $r $idCol).ToUpper()
        $name = CellText $ws $r $nameCol
        $amount = Amount (CellText $ws $r $amountCol)
        if ((-not $id -and -not $name) -or $amount -le 0) { continue }
        $insuranceRows.Add([pscustomobject]@{
          sourceFile = [System.IO.Path]::GetFileName($path)
          rowNumber = $r
          idCard = $id
          name = $name
          rate = CellText $ws $r $rateCol
          amount = $amount
        }) | Out-Null
      }
    } finally {
      $wb.Close($false)
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null
    }
  }

  $result = [pscustomobject]@{
    unitName = $unitName
    salaryRows = $salaryRows
    housingRows = $housingRows
    insuranceRows = $insuranceRows
  }
  $result | ConvertTo-Json -Depth 8 -Compress
  $xl.Quit()
  exit 0
} catch {
  try { if ($xl) { $xl.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($xl) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`
}

function buildWriteSalaryScript(input: {
  salaryWorkbookPath: string
  outputPath: string
  values: Record<string, Record<string, number>>
}): string {
  const salaryPath = psString(input.salaryWorkbookPath)
  const outputPath = psString(input.outputPath)
  const valuesJson = psString(JSON.stringify(input.values))
  return `
$ErrorActionPreference = 'Stop'
$SalaryPath = ${salaryPath}
$OutputPath = ${outputPath}
$ValuesJson = ${valuesJson}

function N([object]$v) {
  if ($null -eq $v) { return '' }
  return ([string]$v).Trim()
}
function Norm([string]$s) {
  if ($null -eq $s) { return '' }
  return (($s -replace '\\s+', '') -replace '[（）()]', '').Trim()
}
function CellText($ws, [int]$r, [int]$c) {
  return N $ws.Cells.Item($r, $c).Text
}
function FindHeader($ws) {
  $used = $ws.UsedRange
  $firstRow = [int]$used.Row
  $lastRow = [int]($used.Row + $used.Rows.Count - 1)
  $firstCol = [int]$used.Column
  $lastCol = [int]($used.Column + $used.Columns.Count - 1)
  for ($r = $firstRow; $r -le [math]::Min($lastRow, $firstRow + 30); $r++) {
    $headers = @{}
    for ($c = $firstCol; $c -le $lastCol; $c++) {
      $key = Norm (CellText $ws $r $c)
      if ($key -and -not $headers.ContainsKey($key)) { $headers[$key] = $c }
    }
    if (($headers.ContainsKey((Norm '证件号码')) -or $headers.ContainsKey((Norm '身份证号'))) -and $headers.ContainsKey((Norm '姓名'))) {
      return @{ Row = $r; Headers = $headers; LastRow = $lastRow; LastCol = $lastCol }
    }
  }
  throw "工资表找不到 姓名/证件号码 表头"
}
function Col($headers, [string[]]$aliases) {
  foreach ($alias in $aliases) {
    $key = Norm $alias
    if ($headers.ContainsKey($key)) { return [int]$headers[$key] }
  }
  return 0
}

$map = @{}
$obj = $ValuesJson | ConvertFrom-Json
foreach ($prop in $obj.PSObject.Properties) {
  $inner = @{}
  foreach ($p in $prop.Value.PSObject.Properties) { $inner[$p.Name] = [double]$p.Value }
  $map[$prop.Name] = $inner
}

$xl = $null
$wb = $null
try {
  if (-not (Test-Path (Split-Path -Parent $OutputPath))) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
  }
  Copy-Item -LiteralPath $SalaryPath -Destination $OutputPath -Force
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false
  $wb = $xl.Workbooks.Open($OutputPath, 3, $false)
  try { $ws = $wb.Sheets.Item('公办在职') } catch { $ws = $wb.Sheets.Item(1) }
  $h = FindHeader $ws
  $idCol = Col $h.Headers @('证件号码','身份证号','身份证')
  $fieldCols = @{
    '公积金' = Col $h.Headers @('公积金','住房公积金')
    '养老保险缴费' = Col $h.Headers @('养老保险缴费','养老保险')
    '职业年金缴费' = Col $h.Headers @('职业年金缴费','职业年金')
    '医疗保险' = Col $h.Headers @('医疗保险','医保大病统筹')
    '失业保险' = Col $h.Headers @('失业保险')
  }
  $appliedPeople = @{}
  for ($r = $h.Row + 1; $r -le $h.LastRow; $r++) {
    $id = (CellText $ws $r $idCol).ToUpper()
    if (-not $id -or -not $map.ContainsKey($id)) { continue }
    $person = $map[$id]
    $written = $false
    foreach ($field in $fieldCols.Keys) {
      $c = [int]$fieldCols[$field]
      if ($c -le 0 -or -not $person.ContainsKey($field)) { continue }
      $ws.Cells.Item($r, $c).Value2 = [double]$person[$field]
      $written = $true
    }
    if ($written) { $appliedPeople[$id] = $true }
  }
  $xl.CalculateFull()
  $wb.Save()
  $wb.Close($false)
  $xl.Quit()
  Write-Output ("applied=" + $appliedPeople.Count)
  exit 0
} catch {
  try { if ($wb) { $wb.Close($false) } } catch {}
  try { if ($xl) { $xl.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($wb) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
  if ($xl) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`
}

function buildWritePersonalTaxTemplateScript(input: {
  templateWorkbookPath: string
  outputPath: string
  dataPath: string
}): string {
  const templatePath = psString(input.templateWorkbookPath)
  const outputPath = psString(input.outputPath)
  const dataPath = psString(input.dataPath)
  return `
$ErrorActionPreference = 'Stop'
$TemplatePath = ${templatePath}
$OutputPath = ${outputPath}
$DataPath = ${dataPath}

function N([object]$v) {
  if ($null -eq $v) { return '' }
  return ([string]$v).Trim()
}
function Amount([object]$v) {
  $n = 0.0
  if ([double]::TryParse((N $v), [ref]$n)) { return [math]::Round($n, 2) }
  return 0
}

$xl = $null
$wb = $null
try {
  if (-not (Test-Path (Split-Path -Parent $OutputPath))) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
  }
  Copy-Item -LiteralPath $TemplatePath -Destination $OutputPath -Force
  $rows = @(Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json)

  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false
  $wb = $xl.Workbooks.Open($OutputPath, 3, $false)
  try { $ws = $wb.Sheets.Item('正常工资薪金收入') } catch { $ws = $wb.Sheets.Item(1) }

  $used = $ws.UsedRange
  $lastRow = [int]($used.Row + $used.Rows.Count - 1)
  if ($lastRow -ge 2) {
    $ws.Range($ws.Cells.Item(2, 1), $ws.Cells.Item($lastRow, 28)).ClearContents() | Out-Null
  }

  $count = [int]$rows.Count
  if ($count -gt 0) {
    $data = New-Object 'object[,]' $count, 28
    for ($i = 0; $i -lt $count; $i++) {
      $data[$i, 0] = ''
      $data[$i, 1] = N $rows[$i].name
      $data[$i, 2] = '居民身份证'
      $data[$i, 3] = N $rows[$i].idCard
      $data[$i, 4] = Amount $rows[$i].income
      $data[$i, 5] = 0
      $data[$i, 6] = Amount $rows[$i].pension
      $data[$i, 7] = Amount $rows[$i].medical
      $data[$i, 8] = Amount $rows[$i].unemployment
      $data[$i, 9] = Amount $rows[$i].housing
      $data[$i, 10] = 0
      $data[$i, 11] = 0
      $data[$i, 12] = 0
      $data[$i, 13] = 0
      $data[$i, 14] = 0
      $data[$i, 15] = 0
      $data[$i, 16] = 0
      $data[$i, 17] = Amount $rows[$i].annuity
      $data[$i, 18] = 0
      $data[$i, 19] = 0
      $data[$i, 20] = 0
      $data[$i, 21] = 0
      $data[$i, 22] = 0
      $data[$i, 23] = 0
      $data[$i, 24] = 0
      $data[$i, 25] = 0
      $data[$i, 26] = 0
      $data[$i, 27] = ''
    }
    $target = $ws.Range($ws.Cells.Item(2, 1), $ws.Cells.Item(1 + $count, 28))
    $target.Value2 = $data
  }

  $xl.CalculateFull()
  $wb.Save()
  $wb.Close($false)
  $xl.Quit()
  exit 0
} catch {
  try { if ($wb) { $wb.Close($false) } } catch {}
  try { if ($xl) { $xl.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($wb) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
  if ($xl) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`
}

function buildWriteSocialBaseTemplateScript(input: {
  templateWorkbookPath: string
  outputPath: string
  dataPath: string
}): string {
  const templatePath = psString(input.templateWorkbookPath)
  const outputPath = psString(input.outputPath)
  const dataPath = psString(input.dataPath)
  return `
$ErrorActionPreference = 'Stop'
$TemplatePath = ${templatePath}
$OutputPath = ${outputPath}
$DataPath = ${dataPath}

function N([object]$v) {
  if ($null -eq $v) { return '' }
  return ([string]$v).Trim()
}
function Amount([object]$v) {
  $n = 0.0
  if ([double]::TryParse((N $v), [ref]$n)) { return [math]::Round($n, 2) }
  return 0
}

$xl = $null
$wb = $null
try {
  if (-not (Test-Path (Split-Path -Parent $OutputPath))) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
  }
  Copy-Item -LiteralPath $TemplatePath -Destination $OutputPath -Force
  $rows = @(Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json)

  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false
  $wb = $xl.Workbooks.Open($OutputPath, 3, $false)
  try { $ws = $wb.Sheets.Item('缴费工资申报数据') } catch { $ws = $wb.Sheets.Item(1) }

  $used = $ws.UsedRange
  $lastRow = [int]($used.Row + $used.Rows.Count - 1)
  if ($lastRow -ge 4) {
    $ws.Range($ws.Cells.Item(4, 1), $ws.Cells.Item($lastRow, 11)).ClearContents() | Out-Null
  }

  $count = [int]$rows.Count
  if ($count -gt 0) {
    $data = New-Object 'object[,]' $count, 11
    for ($i = 0; $i -lt $count; $i++) {
      $base = Amount $rows[$i].base
      $data[$i, 0] = N $rows[$i].name
      $data[$i, 1] = '201'
      $data[$i, 2] = N $rows[$i].idCard
      $data[$i, 3] = ''
      for ($c = 4; $c -le 10; $c++) { $data[$i, $c] = $base }
    }
    $target = $ws.Range($ws.Cells.Item(4, 1), $ws.Cells.Item(3 + $count, 11))
    $target.Value2 = $data
  }

  $xl.CalculateFull()
  $wb.Save()
  $wb.Close($false)
  $xl.Quit()
  exit 0
} catch {
  try { if ($wb) { $wb.Close($false) } } catch {}
  try { if ($xl) { $xl.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($wb) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
  if ($xl) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`
}

async function runPowerShellScript(script: string, errorPrefix: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      reject(new Error(`无法启动 PowerShell：${error.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`${errorPrefix}：${stderr.trim() || `PowerShell 退出码 ${code}`}`))
    })
  })
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function num(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(String(value).replace(/,/g, '').replace(/\s+/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeIdCard(value: unknown): string {
  return text(value).toUpperCase()
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function timestamp(): string {
  const d = new Date()
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`
}

function safeFileStem(value: string): string {
  const raw = basename(value, extname(value)) || value || '年初调整'
  const cleaned = raw.replace(/[\\/:*?"<>|\s]/g, '')
  if (cleaned) return cleaned
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}

function psString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}
