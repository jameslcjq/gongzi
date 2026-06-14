import { app, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as XLSX from 'xlsx'
import { all, getDatabase, refreshAllPersonnelStatuses, run, runWithLastId } from '../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import { readUnitSettings } from './unitSettings'
import { getWorksheetByName, tableNameOf } from './worksheetTable'
import { getDataPath, getMonthlyOutputPath } from '../config/paths'
import { parseSalaryWorkbook } from './monthly-payroll/monthlyPayrollParsers'
import { writeSalaryImportWorkbook } from './monthly-payroll/salaryImportWorkbook'
import { readMonthlyPayrollSettings } from './monthly-payroll/monthlyPayrollSettings'
import {
  applyIntegratedComputedFieldsForUpdate,
  applyIntegratedComputedFieldsToRows
} from './monthly-payroll/integratedPayrollRules'
import { activeBackpayAdjustmentTotals } from './monthly-payroll/salaryBackpayAdjustments'
import type { PayrollPerson, SalarySummary } from './monthly-payroll/monthlyPayrollTypes'
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
  SocialBaseApplyInput,
  SocialBaseApplyResult,
  SocialBaseBatchSelection,
  SocialBaseChangeRow,
  SocialBaseManualChange,
  SocialBasePreview,
  SocialBasePreviewInput,
  SocialInsuranceBaseExportInput,
  SocialInsuranceBaseExportResult,
  WorksheetRecordValue
} from '../../shared/types'

type ReadSourcesResult = {
  unitName: string
  salaryRows: AnnualSalaryRow[]
  housingRows: AnnualHousingAccountRow[]
  insuranceFiles: AnnualInsuranceFile[]
  insuranceRows: AnnualInsuranceSourceRow[]
}

type AnnualSalaryRow = {
  rowNumber: number
  idCard: string
  name: string
  housing: number
  socialBase: number
  pension: number
  annuity: number
  medical: number
  unemployment: number
}

type AnnualHousingAccountRow = {
  idCard: string
  name: string
  account: string
  base: number
}

type AnnualInsuranceSourceRow = {
  sourceFile: string
  sourceIndex: number
  sourceKind: AnnualInsuranceKind
  rowNumber: number
  idCard: string
  name: string
  rate: string
  amount: number
}

type AnnualInsuranceFile = {
  sourceFile: string
  sourceIndex: number
}

type AnnualInsuranceKind =
  | 'pension'
  | 'annuity'
  | 'unemployment'
  | 'medical-basic'
  | 'medical-large'
  | 'unknown'

type AnnualSourcePerson = {
  idCard: string
  name: string
  values: Record<string, number>
}

type AnnualNameIdCardMismatch = {
  sourceFile: string
  rowNumber: number
  name: string
  idCard: string
  targetIdCard: string
  fieldName: string
  amount: number
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
  existingRowCount: number
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

type HousingDeclarationWriteResult = {
  workbookPath: string
  missingLogPath?: string
  rowCount: number
  amountTotal: number
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
const SOCIAL_BASE_FORMULA_FIELDS = ['岗位工资', '薪级工资', '教（工）龄补贴', '岗位津贴', '生活补贴']
const HOUSING_FUND_FORMULA_FIELDS = [...SOCIAL_BASE_FORMULA_FIELDS, '住房补贴', '交通费']

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
  const prepared = prepareAnnualSources(sources, {
    confirmNameIdCardMismatch: Boolean(input.confirmNameIdCardMismatch)
  })
  if (prepared.nameIdCardMismatches.length > 0 && !input.confirmNameIdCardMismatch) {
    throw new Error(
      `发现 ${prepared.nameIdCardMismatches.length} 条同名但身份证不同的五险一金明细，需要人工确认后再继续。`
    )
  }
  const integratedPlan = await buildAnnualIntegratedPlan(prepared.people)
  const outputDir = getMonthlyOutputPath()
  mkdirSync(outputDir, { recursive: true })
  const stamp = timestamp()

  const salaryBackupPath = join(
    outputDir,
    `社保个税_${safeFileStem(input.salaryWorkbookPath)}_原始备份_${stamp}${extname(input.salaryWorkbookPath) || '.xlsx'}`
  )
  copyFileSync(input.salaryWorkbookPath, salaryBackupPath)
  const salaryOutputPath = input.salaryWorkbookPath
  const salaryApplied = await writeAnnualValuesToSalaryWorkbook({
    salaryWorkbookPath: salaryBackupPath,
    outputPath: salaryOutputPath,
    people: prepared.people
  })

  let salaryImportSource: SalarySummary | undefined
  const readUpdatedSalary = async (): Promise<SalarySummary> => {
    salaryImportSource ??= await parseSalaryWorkbook(salaryOutputPath)
    return salaryImportSource
  }
  validateUpdatedSalaryInsuranceTotals(prepared.people, await readUpdatedSalary())

  let integratedApplied = 0
  let integratedInserted = 0
  let integratedUnitNameUpdated = 0
  if (input.confirmIntegratedWriteBack) {
    if (integratedPlan.existingRowCount === 0) {
      integratedInserted = await seedIntegratedActiveFromSalarySummary(await readUpdatedSalary(), prepared.people)
    } else {
      await applyIntegratedPlan(integratedPlan)
      integratedApplied = integratedPlan.changes.length
      integratedUnitNameUpdated = await syncIntegratedUnitNameForPeople(prepared.people)
    }
  }

  let salaryImportPath: string | undefined
  const salaryImportWarnings: string[] = []
  try {
    const salaryImportSource = await readUpdatedSalary()
    const candidatePath = join(outputDir, `社保个税_工资导入_五险一金_${stamp}.xls`)
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
    const housingOutput = await writeHousingDeclarationWorkbook({
      outputDir,
      stamp,
      unitName: sources.unitName,
      templateWorkbookPath: resolveBuiltinTemplatePath('grjcjsList.xls'),
      salaryRows: sources.salaryRows,
      housingByIdCard: prepared.housingByIdCard
    })
    housingDeclarationPath = housingOutput.workbookPath
    housingMissingLogPath = housingOutput.missingLogPath
  }

  const integratedMessages: string[] = []
  if (integratedInserted) {
    integratedMessages.push(`在职工资新增 ${integratedInserted} 人`)
  } else {
    if (integratedApplied) integratedMessages.push(`在职工资回写 ${integratedApplied} 项`)
    if (integratedUnitNameUpdated) integratedMessages.push(`单位名称修正 ${integratedUnitNameUpdated} 行`)
  }
  const integratedMessage = integratedMessages.length ? `，${integratedMessages.join('，')}` : ''

  return {
    ok: true,
    message: `已更新五险一金工资表，工资表写回 ${salaryApplied} 人${integratedMessage}`,
    salaryOutputPath,
    salaryBackupPath,
    salaryImportPath,
    housingDeclarationPath,
    housingMissingLogPath,
    salaryApplied,
    integratedApplied,
    integratedInserted,
    integratedManualCount: integratedPlan.manual.length,
    warnings: [
      ...prepared.warnings,
      ...salaryImportWarnings,
      ...(integratedInserted ? [] : buildMissingIntegratedWarnings(integratedPlan.missing)),
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
  const taxUnitStem = ((await readUnitSettings()).unitFullName || '').replace(/[\\/:*?"<>|\s]/g, '')
  const filePath = join(
    outputDir,
    taxUnitStem ? `${taxUnitStem}个税导入.xls` : `个税导入_${timestamp()}.xls`
  )
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

  const outputDir = getMonthlyOutputPath()
  mkdirSync(outputDir, { recursive: true })
  const stamp = timestamp()

  let salaryRows: AnnualSalaryRow[]
  let housingByIdCard = new Map<string, AnnualHousingAccountRow>()
  let unitName = ''
  let salaryOutputPath: string | undefined
  let salaryBackupPath: string | undefined
  let salaryApplied: number | undefined
  const warnings: string[] = []

  if (input.salaryWorkbookPath) {
    const sources = await readAnnualSources({
      salaryWorkbookPath: input.salaryWorkbookPath,
      housingAccountWorkbookPath: input.housingAccountWorkbookPath,
      insuranceDetailWorkbookPaths: input.insuranceDetailWorkbookPaths ?? []
    })
    const prepared = prepareAnnualSources(sources)
    salaryRows = sources.salaryRows
    housingByIdCard = prepared.housingByIdCard
    unitName = sources.unitName
    warnings.push(...prepared.warnings)
    if (prepared.nameIdCardMismatches.length > 0) {
      warnings.push(
        `有 ${prepared.nameIdCardMismatches.length} 条五险明细同名但身份证不同，已跳过这些明细的工资表回写。`
      )
    }

    const writeBack = await writeAnnualValuesBackToSalaryWorkbook({
      salaryWorkbookPath: input.salaryWorkbookPath,
      outputDir,
      stamp,
      people: prepared.people
    })
    salaryOutputPath = writeBack.salaryOutputPath
    salaryBackupPath = writeBack.salaryBackupPath
    salaryApplied = writeBack.salaryApplied
    validateUpdatedSalaryInsuranceTotals(prepared.people, await parseSalaryWorkbook(writeBack.salaryOutputPath))
  } else {
    warnings.push(
      '未检测到工资表，本次仅用本地「在职工资」数据生成社保基数/公积金导入，未回写五险一金到工资表。请确认导入文件夹中有工资表后刷新重试。'
    )
    salaryRows = await buildAnnualSalaryRowsFromActiveWorksheet()
    if (input.housingAccountWorkbookPath) {
      housingByIdCard = await readHousingAccountRowsFromWorkbook(input.housingAccountWorkbookPath)
    }
    const settings = await readUnitSettings()
    unitName = settings.unitFullName || ''
  }

  const rows = socialBaseRowsFromSalaryRows(salaryRows)
  if (rows.length === 0) throw new Error('在职工资没有可导出的人员')

  const filePath = join(outputDir, `社保个税_参保职工列表_社保基数_${stamp}.xlsx`)
  await writeSocialInsuranceBaseWorkbook(
    filePath,
    input.templateWorkbookPath ?? resolveBuiltinTemplatePath('参保职工列表模板.xlsx'),
    rows
  )

  let housingDeclarationPath: string | undefined
  let housingMissingLogPath: string | undefined
  let housingRowCount: number | undefined
  let housingAmountTotal: number | undefined
  if (input.housingAccountWorkbookPath) {
    const housingOutput = await writeHousingDeclarationWorkbook({
      outputDir,
      stamp,
      unitName,
      templateWorkbookPath: resolveBuiltinTemplatePath('grjcjsList.xls'),
      salaryRows,
      housingByIdCard
    })
    housingDeclarationPath = housingOutput.workbookPath
    housingMissingLogPath = housingOutput.missingLogPath
    housingRowCount = housingOutput.rowCount
    housingAmountTotal = housingOutput.amountTotal
    // 公积金导入已生成，grxxlist.xls 归档到 imported/，避免再次被识别。
    const archived = archiveConsumedImportFile(input.housingAccountWorkbookPath)
    if (archived) warnings.push(`grxxlist.xls 已归档到 imported 文件夹：${archived}`)
  }

  return {
    ok: true,
    filePath,
    housingDeclarationPath,
    housingMissingLogPath,
    salaryOutputPath,
    salaryBackupPath,
    salaryApplied,
    rowCount: rows.length,
    baseTotal: roundMoney(rows.reduce((total, row) => total + row.base, 0)),
    housingRowCount,
    housingAmountTotal,
    warnings
  }
}

// ===================== 社保基数两阶段流程（数据源 + 预览确认 + 回写） =====================

type SocialBaseManualResolvable = SocialBaseManualChange & {
  batchRows: Array<{ batchCode: string; rowId: number }>
}

type SocialBasePlan = {
  autoChanges: IntegratedChange[]
  manual: SocialBaseManualResolvable[]
  missing: AnnualIntegratedChangePreview[]
  existingRowCount: number
}

type SocialBaseResolvedSource = {
  salaryRows: AnnualSalaryRow[]
  people: AnnualSourcePerson[]
  housingByIdCard: Map<string, AnnualHousingAccountRow>
  unitName: string
  canWriteSalaryWorkbook: boolean
  warnings: string[]
}

function peopleFromSalaryRows(salaryRows: AnnualSalaryRow[]): AnnualSourcePerson[] {
  return salaryRows
    .filter((row) => row.idCard && row.name)
    .map((row) => ({
      idCard: row.idCard,
      name: row.name,
      values: {
        公积金: roundMoney(row.housing),
        养老保险缴费: roundMoney(row.pension),
        职业年金缴费: roundMoney(row.annuity),
        医疗保险: roundMoney(row.medical),
        失业保险: roundMoney(row.unemployment)
      }
    }))
}

async function resolveSocialBaseSource(input: SocialBasePreviewInput): Promise<SocialBaseResolvedSource> {
  const warnings: string[] = []
  if (input.dataSourceMode === 'salary-workbook') {
    if (!input.salaryWorkbookPath) throw new Error('数据源为工资表，但未检测到工资表文件，请确认导入文件夹后刷新重试')
    const sources = await readAnnualSources({
      salaryWorkbookPath: input.salaryWorkbookPath,
      housingAccountWorkbookPath: input.housingAccountWorkbookPath,
      insuranceDetailWorkbookPaths: []
    })
    const prepared = prepareAnnualSources(sources)
    warnings.push(...prepared.warnings)
    if (prepared.nameIdCardMismatches.length > 0) {
      warnings.push(`有 ${prepared.nameIdCardMismatches.length} 条五险明细同名但身份证不同，已跳过这些明细的工资表回写。`)
    }
    return {
      salaryRows: sources.salaryRows,
      people: prepared.people,
      housingByIdCard: prepared.housingByIdCard,
      unitName: sources.unitName,
      canWriteSalaryWorkbook: true,
      warnings
    }
  }

  const salaryRows = await buildAnnualSalaryRowsFromActiveWorksheet()
  const housingByIdCard = input.housingAccountWorkbookPath
    ? await readHousingAccountRowsFromWorkbook(input.housingAccountWorkbookPath)
    : new Map<string, AnnualHousingAccountRow>()
  const settings = await readUnitSettings()
  return {
    salaryRows,
    people: peopleFromSalaryRows(salaryRows),
    housingByIdCard,
    unitName: settings.unitFullName || '',
    canWriteSalaryWorkbook: false,
    warnings
  }
}

// 与 buildAnnualIntegratedPlan 同源分组，但对多批次歧义项额外暴露可选批次，供用户选目标批次（默认 001）。
async function buildSocialBaseIntegratedPlan(sourcePeople: AnnualSourcePerson[]): Promise<SocialBasePlan> {
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const idColumn = columns.find((column) => column.field.name === '证件号码')?.columnName
  const nameColumn = columns.find((column) => column.field.name === '姓名')?.columnName
  const batchColumn = columns.find((column) => column.field.name === '工资批次编码')?.columnName
  if (!idColumn) throw new Error('在职工资缺少证件号码字段')
  const fieldColumns = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
  if (rows.length === 0) {
    return { autoChanges: [], manual: [], missing: [], existingRowCount: 0 }
  }

  const latestByIdBatch = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idColumn])
    if (!idCard) continue
    const key = batchColumn ? `${idCard}::${text(row[batchColumn])}` : idCard
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

  const autoChanges: IntegratedChange[] = []
  const manual: SocialBaseManualResolvable[] = []
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
      const base = {
        idCard: person.idCard,
        name: person.name || (nameColumn ? text(personRows[0]?.[nameColumn]) : ''),
        fieldName,
        sourceValue,
        targetValue
      }
      if (decision.ok) {
        autoChanges.push({ ...base, reason: decision.reason, updates: decision.updates })
      } else {
        const batchRows = personRows.map((row) => ({
          batchCode: (batchColumn ? text(row[batchColumn]) : '') || '(无批次)',
          rowId: num(row.id),
          currentValue: roundMoney(num(row[columnName]))
        }))
        const defaultBatchCode = batchRows.find((row) => row.batchCode === '001')?.batchCode ?? batchRows[0]?.batchCode ?? '001'
        manual.push({
          ...base,
          reason: decision.reason,
          batchOptions: batchRows.map((row) => ({ batchCode: row.batchCode, currentValue: row.currentValue })),
          defaultBatchCode,
          batchRows: batchRows.map((row) => ({ batchCode: row.batchCode, rowId: row.rowId }))
        })
      }
    }
  }
  return { autoChanges, manual, missing, existingRowCount: rows.length }
}

function resolveSocialBaseManual(
  manual: SocialBaseManualResolvable[],
  batchSelections: SocialBaseBatchSelection[]
): IntegratedChange[] {
  const selectionByKey = new Map(
    batchSelections.map((selection) => [`${selection.idCard}::${selection.fieldName}`, selection.batchCode])
  )
  return manual.map((item) => {
    const chosen = selectionByKey.get(`${item.idCard}::${item.fieldName}`) ?? item.defaultBatchCode
    return {
      idCard: item.idCard,
      name: item.name,
      fieldName: item.fieldName,
      sourceValue: item.sourceValue,
      targetValue: item.targetValue,
      reason: `多批次已选批次 ${chosen}`,
      updates: item.batchRows.map((row) => ({
        rowId: row.rowId,
        value: row.batchCode === chosen ? item.sourceValue : 0
      }))
    }
  })
}

function changedIdsFromPlan(plan: SocialBasePlan): { changed: Set<string>; manual: Set<string> } {
  const changed = new Set<string>()
  const manual = new Set<string>()
  for (const change of plan.autoChanges) changed.add(change.idCard)
  for (const item of plan.manual) {
    changed.add(item.idCard)
    manual.add(item.idCard)
  }
  return { changed, manual }
}

export async function previewSocialInsuranceBase(input: SocialBasePreviewInput): Promise<SocialBasePreview> {
  const source = await resolveSocialBaseSource(input)
  const baseRows = socialBaseRowsFromSalaryRows(source.salaryRows)
  if (baseRows.length === 0) throw new Error('没有可导出的人员（数据源中缺少可计算社保基数的工资字段）')
  const plan = await buildSocialBaseIntegratedPlan(source.people)
  const { changed } = changedIdsFromPlan(plan)
  const housingAmountTotal = roundMoney(
    source.salaryRows.reduce((total, row) => total + roundWholeMoney(row.housing), 0)
  )
  const warnings = [...source.warnings]
  if (plan.existingRowCount === 0) {
    warnings.push('在职工资当前为空，确认后将按数据源人员直接写入在职工资。')
  }
  return {
    dataSourceMode: input.dataSourceMode,
    unitName: source.unitName,
    personCount: baseRows.length,
    changedPeopleCount: changed.size,
    baseTotal: roundMoney(baseRows.reduce((total, row) => total + row.base, 0)),
    housingAmountTotal,
    autoChanges: plan.autoChanges.map(({ updates: _updates, ...rest }) => rest).slice(0, 500),
    manualChanges: plan.manual
      .map(({ batchRows: _batchRows, ...rest }) => rest)
      .slice(0, 500),
    missing: plan.missing.slice(0, 5000),
    canWriteSalaryWorkbook: source.canWriteSalaryWorkbook,
    housingAccountAvailable: Boolean(input.housingAccountWorkbookPath),
    warnings
  }
}

export async function applySocialInsuranceBase(input: SocialBaseApplyInput): Promise<SocialBaseApplyResult> {
  const source = await resolveSocialBaseSource(input)
  const baseRows = socialBaseRowsFromSalaryRows(source.salaryRows)
  if (baseRows.length === 0) throw new Error('没有可导出的人员（数据源中缺少可计算社保基数的工资字段）')

  const outputDir = getMonthlyOutputPath()
  mkdirSync(outputDir, { recursive: true })
  const stamp = timestamp()
  const warnings = [...source.warnings]

  // 算一次计划：既用于 DB 回写，也用于变动明细的"变动人员"判定
  const plan = await buildSocialBaseIntegratedPlan(source.people)
  const { changed: changedIds, manual: manualIds } = changedIdsFromPlan(plan)

  // 1) 回写花名册（可叠加，仅工资表数据源）+ 复核闸门（五险一金合计一致）
  let salaryOutputPath: string | undefined
  let salaryBackupPath: string | undefined
  let salaryApplied: number | undefined
  if (source.canWriteSalaryWorkbook && input.salaryWorkbookPath) {
    const writeBack = await writeAnnualValuesBackToSalaryWorkbook({
      salaryWorkbookPath: input.salaryWorkbookPath,
      outputDir,
      stamp,
      people: source.people
    })
    salaryOutputPath = writeBack.salaryOutputPath
    salaryBackupPath = writeBack.salaryBackupPath
    salaryApplied = writeBack.salaryApplied
    validateUpdatedSalaryInsuranceTotals(source.people, await parseSalaryWorkbook(writeBack.salaryOutputPath))
  }

  // 2) 回写数据库在职工资（可叠加，按批次；applyIntegratedPlan 内部按公式重算应发/扣款/实发）
  let integratedApplied = 0
  if (input.writeDatabase) {
    if (plan.existingRowCount === 0) {
      if (salaryOutputPath) {
        integratedApplied = await seedIntegratedActiveFromSalarySummary(
          await parseSalaryWorkbook(salaryOutputPath),
          source.people
        )
      } else {
        warnings.push('在职工资为空且无工资表可作为种子数据，已跳过数据库回写。')
      }
    } else {
      const changes = [...plan.autoChanges, ...resolveSocialBaseManual(plan.manual, input.batchSelections)]
      await applyIntegratedPlan({ changes, manual: [], missing: [], existingRowCount: plan.existingRowCount })
      integratedApplied = changes.length
    }
  } else if (plan.manual.length > 0 || plan.autoChanges.length > 0) {
    warnings.push('本次未勾选回写数据库，五险一金未写入在职工资（仅生成导入表/变动明细）。')
  }

  // 3) 导入表：社保基数、公积金（个税由其独立按钮生成，不在此流程）
  const unitStem = (source.unitName || '').replace(/[\\/:*?"<>|\s]/g, '')
  const socialBasePath = join(
    outputDir,
    unitStem ? `${unitStem}社保基数调整.xlsx` : `社保基数调整_${stamp}.xlsx`
  )
  await writeSocialInsuranceBaseWorkbook(
    socialBasePath,
    input.socialBaseTemplatePath ?? resolveBuiltinTemplatePath('参保职工列表模板.xlsx'),
    baseRows
  )

  let housingDeclarationPath: string | undefined
  let housingMissingLogPath: string | undefined
  let housingAmountTotal: number | undefined
  if (input.housingAccountWorkbookPath) {
    const housingOutput = await writeHousingDeclarationWorkbook({
      outputDir,
      stamp,
      unitName: source.unitName,
      templateWorkbookPath: input.housingTemplatePath ?? resolveBuiltinTemplatePath('grjcjsList.xls'),
      salaryRows: source.salaryRows,
      housingByIdCard: source.housingByIdCard
    })
    housingDeclarationPath = housingOutput.workbookPath
    housingMissingLogPath = housingOutput.missingLogPath
    housingAmountTotal = housingOutput.amountTotal
    const archived = archiveConsumedImportFile(input.housingAccountWorkbookPath)
    if (archived) warnings.push(`grxxlist.xls 已归档到 imported 文件夹：${archived}`)
  }

  // 4) 变动明细表（只列五险一金有变动的人，数值为变动后新值）
  let changeDetailPath: string | undefined
  const changeRows = buildSocialBaseChangeRows(source.people, changedIds, manualIds)
  if (changeRows.length > 0) {
    changeDetailPath = join(outputDir, `社保个税_五险一金变动明细_${stamp}.xlsx`)
    writeChangeDetailWorkbook(changeDetailPath, source.unitName, changeRows)
  }

  const messages = [`社保基数 ${baseRows.length} 人，五险一金变动 ${changedIds.size} 人`]
  if (salaryApplied) messages.push(`工资表回写 ${salaryApplied} 人`)
  if (integratedApplied) messages.push(`在职工资回写 ${integratedApplied} 项`)

  return {
    ok: true,
    message: `已生成：${messages.join('，')}`,
    socialBasePath,
    housingDeclarationPath,
    housingMissingLogPath,
    changeDetailPath,
    changedPeopleCount: changedIds.size,
    salaryOutputPath,
    salaryBackupPath,
    salaryApplied,
    integratedApplied,
    baseTotal: roundMoney(baseRows.reduce((total, row) => total + row.base, 0)),
    housingAmountTotal,
    warnings
  }
}

function buildSocialBaseChangeRows(
  people: AnnualSourcePerson[],
  changedIds: Set<string>,
  manualIds: Set<string>
): SocialBaseChangeRow[] {
  return people
    .filter((person) => changedIds.has(person.idCard))
    .map((person) => {
      const housing = roundMoney(num(person.values['公积金']))
      const pension = roundMoney(num(person.values['养老保险缴费']))
      const annuity = roundMoney(num(person.values['职业年金缴费']))
      const medical = roundMoney(num(person.values['医疗保险']))
      const unemployment = roundMoney(num(person.values['失业保险']))
      return {
        idCard: person.idCard,
        name: person.name,
        pension,
        annuity,
        medical,
        unemployment,
        housing,
        deductionTotal: roundMoney(pension + annuity + medical + unemployment + housing),
        netPay: 0,
        batchNote: manualIds.has(person.idCard) ? '多批次已选批次' : ''
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

// 变动明细表是内部留痕/核对用，不导内网系统，故自排版即可，不套政府模板。
function writeChangeDetailWorkbook(filePath: string, unitName: string, rows: SocialBaseChangeRow[]): void {
  const title = `${unitName || ''}五险一金变动明细（仅变动人员，数值为变动后新值）`.trim()
  const header = ['序号', '姓名', '证件号码', '公积金', '养老保险', '职业年金', '医疗保险', '失业保险', '五险一金合计', '备注']
  const aoa: Array<Array<string | number>> = [
    [title, '', '', '', '', '', '', '', '', ''],
    header,
    ...rows.map((row, index) => [
      index + 1,
      row.name,
      row.idCard,
      row.housing,
      row.pension,
      row.annuity,
      row.medical,
      row.unemployment,
      row.deductionTotal,
      row.batchNote ?? ''
    ])
  ]
  const sheet = XLSX.utils.aoa_to_sheet([aoa[0], header])
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }]
  sheet['!cols'] = [6, 10, 20, 10, 10, 10, 10, 10, 12, 16].map((wch) => ({ wch }))
  aoa.slice(2).forEach((row, index) => {
    const rowIndex = index + 2
    writeRowValues(sheet, rowIndex, row)
    setCellAsText(sheet, rowIndex, 2)
  })
  setSheetRef(sheet, Math.max(getSheetLastRow(sheet), aoa.length - 1), header.length - 1)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '五险一金变动明细')
  writeWorkbook(filePath, workbook, 'xlsx')
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
  const canCalculateHousingFund = HOUSING_FUND_FORMULA_FIELDS.every((field) => colByField.has(field))

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
    const housing = sumField('公积金') || (canCalculateHousingFund ? calculateHousingFundAmount(sumField) : 0)
    taxRows.push({
      idCard,
      name: text(representative[nameColumn]),
      income,
      pension: sumField('养老保险缴费'),
      medical: sumField('医疗保险'),
      unemployment: sumField('失业保险'),
      housing,
      annuity: sumField('职业年金缴费')
    })
  }

  return taxRows
    .filter((row) => row.name && row.idCard)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

async function buildAnnualSalaryRowsFromActiveWorksheet(): Promise<AnnualSalaryRow[]> {
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const colByField = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const idColumn = colByField.get('证件号码')
  const nameColumn = colByField.get('姓名')
  const batchColumn = colByField.get('工资批次编码')
  if (!idColumn || !nameColumn) throw new Error('在职工资缺少姓名或证件号码字段')

  const missingBaseFields = SOCIAL_BASE_FORMULA_FIELDS.filter((field) => !colByField.has(field))
  if (missingBaseFields.length > 0) {
    throw new Error(`在职工资缺少五险基数字段：${missingBaseFields.join('、')}`)
  }
  const canCalculateHousingFund = HOUSING_FUND_FORMULA_FIELDS.every((field) => colByField.has(field))
  const housingColumn = colByField.get('公积金')

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

  const rows: AnnualSalaryRow[] = []
  for (const [idCard, personRows] of byIdCard.entries()) {
    const representative = personRows.reduce((best, row) => (num(row.id) > num(best.id) ? row : best))
    const sumField = (fieldName: string): number => {
      const columnName = colByField.get(fieldName)
      if (!columnName) return 0
      return roundMoney(personRows.reduce((sum, row) => sum + num(row[columnName]), 0))
    }
    rows.push({
      rowNumber: num(representative.id) || rows.length + 1,
      idCard,
      name: text(representative[nameColumn]),
      housing: canCalculateHousingFund
        ? calculateHousingFundAmount(sumField)
        : roundMoney(personRows.reduce((sum, row) => sum + num(housingColumn ? row[housingColumn] : 0), 0)),
      socialBase: calculateSocialInsuranceBase(sumField),
      ...calculatePersonalInsuranceAmounts(sumField)
    })
  }

  return rows
    .filter((row) => row.name && row.idCard)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

function socialBaseRowsFromSalaryRows(salaryRows: AnnualSalaryRow[]): SocialInsuranceBaseRow[] {
  return salaryRows
    .map((row) => ({
      idCard: row.idCard,
      name: row.name,
      base: row.socialBase
    }))
    .filter((row) => row.name && row.idCard && row.base > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

function calculateSocialInsuranceBase(sumField: (fieldName: string) => number): number {
  return roundUpWholeMoney(calculateSocialInsuranceBaseRaw(sumField))
}

function calculateSocialInsuranceBaseRaw(sumField: (fieldName: string) => number): number {
  const postAllowance = sumField('岗位津贴')
  const livingAllowance = sumField('生活补贴')
  return (
    sumField('岗位工资') +
    sumField('薪级工资') +
    sumField('教（工）龄补贴') +
    postAllowance +
    livingAllowance +
    ((postAllowance + livingAllowance) * 3) / 7
  )
}

function calculateHousingFundAmount(sumField: (fieldName: string) => number): number {
  const basicSalary = sumField('岗位工资')
  const salaryGrade = sumField('薪级工资')
  const base =
    calculateSocialInsuranceBaseRaw(sumField) +
    sumField('住房补贴') +
    sumField('交通费') +
    (basicSalary + salaryGrade) / 12
  return roundWholeMoney(base * 0.12)
}

function calculatePersonalInsuranceAmounts(
  sumField: (fieldName: string) => number
): Pick<AnnualSalaryRow, 'pension' | 'annuity' | 'medical' | 'unemployment'> {
  const rawBase = calculateSocialInsuranceBaseRaw(sumField)
  return {
    pension: roundMoney(rawBase * 0.08),
    annuity: roundMoney(rawBase * 0.04),
    medical: roundMoney(rawBase * 0.02 + 5),
    unemployment: roundMoney(rawBase * 0.005)
  }
}

async function writePersonalTaxWorkbook(
  filePath: string,
  templateWorkbookPath: string | undefined,
  rows: PersonalTaxRow[]
): Promise<void> {
  if (canFillTemplateViaExcel(templateWorkbookPath)) {
    await fillTemplateViaExcel(
      (dataPath) =>
        buildWritePersonalTaxTemplateScript({ templateWorkbookPath, outputPath: filePath, dataPath }),
      rows,
      '写入个税导入模板失败'
    )
    return
  }

  const workbook = templateWorkbookPath && existsForRead(templateWorkbookPath)
    ? readWorkbookFromFile(templateWorkbookPath)
    : XLSX.utils.book_new()

  const sheetName = workbook.SheetNames.includes('正常工资薪金收入')
    ? '正常工资薪金收入'
    : workbook.SheetNames[0] || '正常工资薪金收入'

  const dataRows = rows.map((row) => [
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

  let sheet = workbook.Sheets[sheetName]
  if (!sheet) {
    sheet = XLSX.utils.aoa_to_sheet([TAX_HEADERS])
    sheet['!cols'] = TAX_HEADERS.map((header) => ({ wch: Math.max(12, header.length + 4) }))
    workbook.Sheets[sheetName] = sheet
  } else {
    writeRowValues(sheet, 0, TAX_HEADERS)
    clearSheetRange(sheet, 1, 0, getSheetLastRow(sheet), TAX_HEADERS.length - 1)
  }
  dataRows.forEach((row, index) => writeRowValues(sheet, index + 1, row))
  setSheetRef(sheet, Math.max(getSheetLastRow(sheet), rows.length), Math.max(getSheetLastColumn(sheet), TAX_HEADERS.length - 1))
  if (!workbook.SheetNames.includes(sheetName)) workbook.SheetNames.unshift(sheetName)
  if (!workbook.SheetNames.includes('填表说明')) {
    const instruction = XLSX.utils.aoa_to_sheet([
      ['注意事项：模板中带 * 的栏目为必填项，导入时不能为空。'],
      ['证照类型填写范围'],
      ['居民身份证']
    ])
    XLSX.utils.book_append_sheet(workbook, instruction, '填表说明')
  }

  writeWorkbook(filePath, workbook, 'xls')
}

async function writeSocialInsuranceBaseWorkbook(
  filePath: string,
  templateWorkbookPath: string | undefined,
  rows: SocialInsuranceBaseRow[]
): Promise<void> {
  if (canFillTemplateViaExcel(templateWorkbookPath)) {
    await fillTemplateViaExcel(
      (dataPath) =>
        buildWriteSocialBaseTemplateScript({ templateWorkbookPath, outputPath: filePath, dataPath }),
      rows,
      '写入社保基数模板失败'
    )
    return
  }

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
  const workbook = templateWorkbookPath && existsForRead(templateWorkbookPath)
    ? readWorkbookFromFile(templateWorkbookPath)
    : XLSX.utils.book_new()
  const sheetName = workbook.SheetNames.includes('缴费工资申报数据')
    ? '缴费工资申报数据'
    : workbook.SheetNames[0] || '缴费工资申报数据'
  let sheet = workbook.Sheets[sheetName]
  if (!sheet) {
    sheet = XLSX.utils.aoa_to_sheet(rowsData.slice(0, 3))
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
      { s: { r: 1, c: 1 }, e: { r: 1, c: 3 } }
    ]
    sheet['!cols'] = Array.from({ length: 11 }, () => ({ wch: 20 }))
    workbook.Sheets[sheetName] = sheet
  }
  rowsData.slice(0, 3).forEach((row, index) => writeRowValues(sheet, index, row))
  clearSheetRange(sheet, 3, 0, getSheetLastRow(sheet), 10)
  rowsData.slice(3).forEach((row, index) => writeRowValues(sheet, index + 3, row))
  setSheetRef(sheet, Math.max(getSheetLastRow(sheet), rows.length + 2), Math.max(getSheetLastColumn(sheet), 10))
  if (!workbook.SheetNames.includes(sheetName)) workbook.SheetNames.unshift(sheetName)
  if (!workbook.SheetNames.includes('填表说明')) {
    const instruction = XLSX.utils.aoa_to_sheet([
      ['1、简要说明'],
      ['按照该模板标准将员工工资信息编辑好，将该模板导入系统后即可申报。'],
      ['身份证件类型默认居民身份证代码 201。']
    ])
    XLSX.utils.book_append_sheet(workbook, instruction, '填表说明')
  }
  writeWorkbook(filePath, workbook, 'xlsx')
}

function writeWorkbook(filePath: string, workbook: XLSX.WorkBook, fallbackBookType: 'xls' | 'xlsx'): void {
  const extension = extname(filePath).toLowerCase()
  const bookType = (extension === '.xlsx' ? 'xlsx' : extension === '.xls' ? 'xls' : fallbackBookType) as XLSX.BookType
  writeFileSync(filePath, XLSX.write(workbook, { bookType, type: 'buffer' }))
}

function readWorkbookFromFile(filePath: string): XLSX.WorkBook {
  return XLSX.read(readFileSync(filePath), { type: 'buffer', cellDates: false })
}

function writeRowValues(sheet: XLSX.WorkSheet, rowIndex: number, values: Array<string | number | boolean>): void {
  values.forEach((value, columnIndex) => setCellValue(sheet, rowIndex, columnIndex, value))
}

function setCellValue(
  sheet: XLSX.WorkSheet,
  rowIndex: number,
  columnIndex: number,
  value: string | number | boolean
): void {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
  const cell = { ...(sheet[address] ?? {}) } as XLSX.CellObject
  delete cell.f
  delete cell.w
  delete cell.h
  delete cell.r
  if (typeof value === 'number') {
    cell.t = 'n'
    cell.v = Number.isFinite(value) ? value : 0
  } else if (typeof value === 'boolean') {
    cell.t = 'b'
    cell.v = value
  } else {
    cell.t = 's'
    cell.v = value
  }
  sheet[address] = cell
}

function setCellAsText(sheet: XLSX.WorkSheet, rowIndex: number, columnIndex: number): void {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
  const cell = sheet[address]
  if (!cell) return
  cell.t = 's'
  cell.z = '@'
  cell.v = text(cell.v)
}

function clearSheetRange(
  sheet: XLSX.WorkSheet,
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number
): void {
  if (endRow < startRow || endColumn < startColumn) return
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    for (let columnIndex = startColumn; columnIndex <= endColumn; columnIndex += 1) {
      delete sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })]
    }
  }
}

function getSheetRange(sheet: XLSX.WorkSheet): XLSX.Range {
  return sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }
}

function getSheetLastRow(sheet: XLSX.WorkSheet): number {
  return getSheetRange(sheet).e.r
}

function getSheetLastColumn(sheet: XLSX.WorkSheet): number {
  return getSheetRange(sheet).e.c
}

function setSheetRef(sheet: XLSX.WorkSheet, lastRow: number, lastColumn: number): void {
  const range = getSheetRange(sheet)
  sheet['!ref'] = XLSX.utils.encode_range({
    s: range.s,
    e: {
      r: Math.max(range.e.r, lastRow),
      c: Math.max(range.e.c, lastColumn)
    }
  })
}

function existsForRead(path: string): boolean {
  try {
    return Boolean(path && existsSync(path))
  } catch {
    return false
  }
}

// 把已消费的导入文件（如 grxxlist.xls）移到同目录的 imported/ 归档，避免再次被识别。
// imported/ 子目录已被导入监控忽略，移动是 best-effort，失败不阻断主流程。
function archiveConsumedImportFile(filePath: string | undefined): string | undefined {
  if (!filePath || !existsForRead(filePath)) return undefined
  try {
    const importedDir = join(dirname(filePath), 'imported')
    mkdirSync(importedDir, { recursive: true })
    const ext = extname(filePath)
    const targetPath = join(importedDir, `${basename(filePath, ext)}_${Date.now()}${ext}`)
    renameSync(filePath, targetPath)
    return targetPath
  } catch {
    return undefined
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
  const salarySource = readAnnualSalaryRowsFromWorkbook(input.salaryWorkbookPath)
  const settings = await readUnitSettings()
  const insuranceFiles = input.insuranceDetailWorkbookPaths.map((filePath, sourceIndex) => {
    const sourceFile = basename(filePath)
    return { sourceFile, sourceIndex }
  })
  const insuranceRows = input.insuranceDetailWorkbookPaths.flatMap((filePath, sourceIndex) =>
    readAnnualInsuranceRowsFromWorkbook(filePath, sourceIndex)
  )
  return {
    unitName: settings.unitFullName || salarySource.unitName || '',
    salaryRows: salarySource.salaryRows,
    housingRows: input.housingAccountWorkbookPath
      ? Array.from(readHousingAccountRowsFromWorkbook(input.housingAccountWorkbookPath).values())
      : [],
    insuranceFiles,
    insuranceRows
  }
}

function readAnnualSalaryRowsFromWorkbook(filePath: string): { unitName: string; salaryRows: AnnualSalaryRow[] } {
  const workbook = readWorkbookFromFile(filePath)
  const unitName = workbook.Sheets['汇总'] ? text(workbook.Sheets['汇总']['A4']?.v) : ''
  const sheet = workbook.Sheets['公办在职'] ?? workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('工资表没有可读取的工作表')
  const rows = sheetToRows(sheet)
  const salaryRows = readAnnualSalaryRowsByHeader(rows)
  const fixedRows = salaryRows.length ? salaryRows : readAnnualSalaryRowsByFixedColumns(rows)
  if (fixedRows.length === 0) throw new Error('工资表未读取到公办在职人员')
  return { unitName, salaryRows: fixedRows }
}

function readAnnualSalaryRowsByHeader(rows: Array<Array<unknown>>): AnnualSalaryRow[] {
  const header = findWorksheetHeader(rows, [['证件号码', '身份证号', '身份证'], ['姓名']])
  if (!header) return []
  const idColumn = findHeaderColumn(header.normalizedHeaders, ['证件号码', '身份证号', '身份证'])
  const nameColumn = findHeaderColumn(header.normalizedHeaders, ['姓名'])
  const housingColumn = findColumnNearby(rows, header.rowIndex, ['住房公积金', '公积金'])
  const salaryRows: AnnualSalaryRow[] = []
  for (let rowIndex = header.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? []
    const idCard = normalizeIdCard(row[idColumn])
    const name = text(row[nameColumn])
    if (!looksLikeIdCard(idCard) || !name || name.includes('合计')) continue
    const sumField = salaryRowFieldReader(rows, rowIndex, header.rowIndex)
    const hasSocialBase = SOCIAL_BASE_FORMULA_FIELDS.every((field) => sumField(field) !== undefined)
    const hasHousing = HOUSING_FUND_FORMULA_FIELDS.every((field) => sumField(field) !== undefined)
    const getField = (fieldName: string): number => sumField(fieldName) ?? 0
    salaryRows.push({
      rowNumber: rowIndex + 1,
      idCard,
      name,
      housing: hasHousing
        ? calculateHousingFundAmount(getField)
        : roundMoney(num(housingColumn >= 0 ? row[housingColumn] : 0)),
      socialBase: hasSocialBase ? calculateSocialInsuranceBase(getField) : 0,
      ...calculatePersonalInsuranceAmounts(getField)
    })
  }
  return salaryRows
}

function readAnnualSalaryRowsByFixedColumns(rows: Array<Array<unknown>>): AnnualSalaryRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => looksLikeIdCard(row[2]) && text(row[4]) && !text(row[4]).includes('合计'))
    .map(({ row, index }) => {
      const sumField = (fieldName: string): number => {
        switch (fieldName) {
          case '岗位工资':
            return num(row[5])
          case '薪级工资':
            return num(row[6])
          case '教（工）龄补贴':
            return num(row[9])
          case '岗位津贴':
            return num(row[10])
          case '生活补贴':
            return num(row[11])
          case '住房补贴':
            return num(row[16])
          case '交通费':
            return num(row[17])
          default:
            return 0
        }
      }
      return {
        rowNumber: index + 1,
        idCard: normalizeIdCard(row[2]),
        name: text(row[4]),
        housing: calculateHousingFundAmount(sumField),
        socialBase: calculateSocialInsuranceBase(sumField),
        ...calculatePersonalInsuranceAmounts(sumField)
      }
    })
}

function salaryRowFieldReader(
  rows: Array<Array<unknown>>,
  rowIndex: number,
  headerRowIndex: number
): (fieldName: string) => number | undefined {
  const row = rows[rowIndex] ?? []
  const aliases: Record<string, string[]> = {
    岗位工资: ['岗位工资'],
    薪级工资: ['薪级工资'],
    '教（工）龄补贴': ['教龄津贴', '教（工）龄补贴', '教工龄补贴'],
    岗位津贴: ['岗位津贴'],
    生活补贴: ['生活补贴'],
    住房补贴: ['住房补贴'],
    交通费: ['交通补贴', '交通费']
  }
  const cache = new Map<string, number>()
  return (fieldName: string): number | undefined => {
    if (cache.has(fieldName)) return num(row[cache.get(fieldName)!])
    const column = findColumnNearby(rows, headerRowIndex, aliases[fieldName] ?? [fieldName])
    if (column < 0) return undefined
    cache.set(fieldName, column)
    return num(row[column])
  }
}

function readAnnualInsuranceRowsFromWorkbook(filePath: string, sourceIndex: number): AnnualInsuranceSourceRow[] {
  const workbook = readWorkbookFromFile(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error(`五险明细没有可读取的工作表：${basename(filePath)}`)
  const rows = sheetToRows(sheet)
  const header = findWorksheetHeader(rows, [
    ['姓名'],
    ['证件号码', '身份证号', '身份证'],
    ['费率'],
    ['应补(退)费额', '应补（退）费额', '应补退费额', '应补(退)费额(元)', '应补（退）费额(元)']
  ])
  if (!header) throw new Error(`五险明细找不到姓名、证件号码、费率、应补(退)费额表头：${basename(filePath)}`)
  const nameColumn = findHeaderColumn(header.normalizedHeaders, ['姓名'])
  const idColumn = findHeaderColumn(header.normalizedHeaders, ['证件号码', '身份证号', '身份证'])
  const rateColumn = findHeaderColumn(header.normalizedHeaders, ['费率'])
  const amountColumn = findHeaderColumn(header.normalizedHeaders, [
    '应补(退)费额',
    '应补（退）费额',
    '应补退费额',
    '应补(退)费额(元)',
    '应补（退）费额(元)'
  ])
  const sourceFile = basename(filePath)
  const result: AnnualInsuranceSourceRow[] = []
  for (let rowIndex = header.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? []
    const idCard = normalizeIdCard(row[idColumn])
    const name = text(row[nameColumn])
    const amount = roundMoney(num(row[amountColumn]))
    if ((!idCard && !name) || amount <= 0) continue
    const rate = normalizeInsuranceRate(text(row[rateColumn]))
    result.push({
      sourceFile,
      sourceIndex,
      sourceKind: inferInsuranceKindFromRate(rate),
      rowNumber: rowIndex + 1,
      idCard,
      name,
      rate,
      amount
    })
  }
  return result
}

function sheetToRows(sheet: XLSX.WorkSheet): Array<Array<unknown>> {
  return XLSX.utils.sheet_to_json<Array<unknown>>(sheet, {
    header: 1,
    raw: false,
    defval: ''
  })
}

function findWorksheetHeader(
  rows: Array<Array<unknown>>,
  requiredAliases: string[][]
): { rowIndex: number; normalizedHeaders: string[] } | undefined {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 30); rowIndex += 1) {
    const normalizedHeaders = (rows[rowIndex] ?? []).map((value) => normalizeHeaderText(value))
    const ok = requiredAliases.every((aliases) => findHeaderColumn(normalizedHeaders, aliases) >= 0)
    if (ok) return { rowIndex, normalizedHeaders }
  }
  return undefined
}

function findColumnNearby(rows: Array<Array<unknown>>, headerRowIndex: number, aliases: string[]): number {
  const normalizedAliases = aliases.map((alias) => normalizeHeaderText(alias))
  const lastColumn = Math.max(...rows.slice(headerRowIndex, headerRowIndex + 3).map((row) => row?.length ?? 0), 0)
  for (let rowIndex = headerRowIndex; rowIndex <= Math.min(rows.length - 1, headerRowIndex + 2); rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < lastColumn; columnIndex += 1) {
      if (normalizedAliases.includes(normalizeHeaderText(rows[rowIndex]?.[columnIndex]))) return columnIndex
    }
  }
  return -1
}

function readHousingAccountRowsFromWorkbook(filePath: string): Map<string, AnnualHousingAccountRow> {
  const workbook = readWorkbookFromFile(filePath)
  const sheetName = workbook.SheetNames[0]
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined
  if (!sheet) throw new Error('公积金账号表没有可读取的工作表')
  const rows = XLSX.utils.sheet_to_json<Array<unknown>>(sheet, {
    header: 1,
    raw: false,
    defval: ''
  })
  const headerInfo = findHousingAccountHeader(rows)
  const result = new Map<string, AnnualHousingAccountRow>()
  for (let rowIndex = headerInfo.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? []
    const idCard = normalizeIdCard(row[headerInfo.idColumn])
    if (!idCard) continue
    result.set(idCard, {
      idCard,
      name: text(row[headerInfo.nameColumn]),
      account: text(row[headerInfo.accountColumn]),
      base: num(row[headerInfo.baseColumn])
    })
  }
  return result
}

function findHousingAccountHeader(
  rows: Array<Array<unknown>>
): { rowIndex: number; idColumn: number; nameColumn: number; accountColumn: number; baseColumn: number } {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 30); rowIndex += 1) {
    const normalized = (rows[rowIndex] ?? []).map((value) => normalizeHeaderText(value))
    const idColumn = findHeaderColumn(normalized, ['证件号码', '身份证号', '身份证'])
    const nameColumn = findHeaderColumn(normalized, ['姓名'])
    const accountColumn = findHeaderColumn(normalized, ['个人账号'])
    const baseColumn = findHeaderColumn(normalized, ['个人缴存基数', '缴存基数'])
    if (idColumn >= 0 && nameColumn >= 0 && accountColumn >= 0 && baseColumn >= 0) {
      return { rowIndex, idColumn, nameColumn, accountColumn, baseColumn }
    }
  }
  throw new Error('公积金账号表找不到证件号码、姓名、个人账号、个人缴存基数表头')
}

function findHeaderColumn(normalizedHeaders: string[], aliases: string[]): number {
  const normalizedAliases = aliases.map((alias) => normalizeHeaderText(alias))
  return normalizedHeaders.findIndex((header) => normalizedAliases.includes(header))
}

function normalizeHeaderText(value: unknown): string {
  return text(value).replace(/\s+/g, '').replace(/[（）()]/g, '')
}

function prepareAnnualSources(
  sources: ReadSourcesResult,
  options: { confirmNameIdCardMismatch?: boolean } = {}
): {
  people: AnnualSourcePerson[]
  sourceRows: AnnualAdjustmentSourceRow[]
  warnings: string[]
  housingByIdCard: Map<string, AnnualHousingAccountRow>
  nameIdCardMismatches: AnnualNameIdCardMismatch[]
} {
  const salaryById = new Map(sources.salaryRows.map((row) => [row.idCard, row]))
  const salaryRowsByName = new Map<string, AnnualSalaryRow[]>()
  for (const row of sources.salaryRows) {
    if (!row.name || !row.idCard) continue
    const rows = salaryRowsByName.get(row.name) ?? []
    rows.push(row)
    salaryRowsByName.set(row.name, rows)
  }

  const housingByIdCard = new Map(sources.housingRows.map((row) => [row.idCard, row]))
  const sourceRows: AnnualAdjustmentSourceRow[] = []
  const warnings: string[] = []
  const nameIdCardMismatches: AnnualNameIdCardMismatch[] = []
  const insuranceById = new Map<string, Record<string, number>>()
  const hasLargeMedicalRows = sources.insuranceRows.some((row) => row.sourceKind === 'medical-large')
  const basicMedicalMatchedIds = new Set<string>()

  for (const row of sources.insuranceRows) {
    const fieldName = inferInsuranceField(row)
    let salaryRow = salaryById.get(row.idCard)
    let targetIdCard = row.idCard
    let matchReason = ''
    if (!fieldName) {
      warnings.push(`${row.sourceFile} 第 ${row.rowNumber} 行文件类型未识别，已跳过`)
      sourceRows.push({ ...row, fieldName: '未识别', status: 'skipped', reason: '文件类型未识别' })
      continue
    }
    if (!salaryRow) {
      const sameNameRows = row.name ? salaryRowsByName.get(row.name) ?? [] : []
      if (sameNameRows.length === 1) {
        salaryRow = sameNameRows[0]
        targetIdCard = salaryRow.idCard
        nameIdCardMismatches.push({
          sourceFile: row.sourceFile,
          rowNumber: row.rowNumber,
          name: row.name,
          idCard: row.idCard,
          targetIdCard,
          fieldName,
          amount: row.amount
        })
        if (!options.confirmNameIdCardMismatch) {
          sourceRows.push({
            ...row,
            targetIdCard,
            fieldName,
            status: 'id-conflict',
            reason: `身份证不一致，工资表唯一同名身份证为 ${targetIdCard}，需人工确认`
          })
          continue
        }
        matchReason = `身份证不一致，来源 ${row.idCard}，工资表 ${targetIdCard}，已人工确认按唯一姓名匹配`
        warnings.push(`${row.sourceFile} 第 ${row.rowNumber} 行 ${row.name} 身份证不一致，已人工确认写入工资表身份证 ${targetIdCard}`)
      }
    }
    if (!salaryRow) {
      const sameNameRows = row.name ? salaryRowsByName.get(row.name) ?? [] : []
      sourceRows.push({
        ...row,
        fieldName,
        targetIdCard: sameNameRows.length === 1 ? sameNameRows[0].idCard : undefined,
        status: sameNameRows.length ? 'id-conflict' : 'missing',
        reason: sameNameRows.length
          ? `工资表有 ${sameNameRows.length} 个同名人员，无法自动判断身份证`
          : '工资表未找到该人员'
      })
      continue
    }

    const values = insuranceById.get(targetIdCard) ?? {}
    values[fieldName] = roundMoney((values[fieldName] ?? 0) + row.amount)
    insuranceById.set(targetIdCard, values)
    if (row.sourceKind === 'medical-basic') basicMedicalMatchedIds.add(targetIdCard)
    sourceRows.push({ ...row, fieldName, status: 'matched', reason: matchReason })
  }

  if (!hasLargeMedicalRows) {
    for (const idCard of basicMedicalMatchedIds) {
      const values = insuranceById.get(idCard) ?? {}
      values['医疗保险'] = roundMoney((values['医疗保险'] ?? 0) + 5)
      insuranceById.set(idCard, values)
    }
  }

  const people: AnnualSourcePerson[] = sources.salaryRows.map((row) => ({
    idCard: row.idCard,
    name: row.name,
    values: {
      公积金: roundMoney(row.housing),
      养老保险缴费: roundMoney(row.pension),
      职业年金缴费: roundMoney(row.annuity),
      医疗保险: roundMoney(row.medical),
      失业保险: roundMoney(row.unemployment),
      ...(insuranceById.get(row.idCard) ?? {})
    }
  }))

  return { people, sourceRows, warnings, housingByIdCard, nameIdCardMismatches }
}

function inferInsuranceField(row: AnnualInsuranceSourceRow): string | undefined {
  switch (row.sourceKind) {
    case 'pension':
      return '养老保险缴费'
    case 'annuity':
      return '职业年金缴费'
    case 'unemployment':
      return '失业保险'
    case 'medical-basic':
    case 'medical-large':
      return '医疗保险'
    default:
      return undefined
  }
}

function inferInsuranceKindFromRate(value: string): AnnualInsuranceKind {
  switch (normalizeInsuranceRate(value)) {
    case '8%':
      return 'pension'
    case '4%':
      return 'annuity'
    case '0.5%':
      return 'unemployment'
    case '2%':
      return 'medical-basic'
    case '100%':
      return 'medical-large'
    default:
      return 'unknown'
  }
}

function normalizeInsuranceRate(value: string): string {
  const normalized = text(value).replace(/\s+/g, '')
  const match = normalized.match(/^(\d+(?:\.\d+)?)%$/)
  if (!match) return normalized
  const rate = Number(match[1])
  return Number.isFinite(rate) ? `${Number(rate.toFixed(4))}%` : normalized
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
      ...(plan.existingRowCount === 0 ? ['在职工资当前为空，执行更新时会按工资表人员直接写入在职工资。'] : []),
      ...buildMissingIntegratedWarnings(plan.missing)
    ]
  }
}

async function writeHousingDeclarationWorkbook(input: {
  outputDir: string
  stamp: string
  unitName: string
  templateWorkbookPath?: string
  salaryRows: AnnualSalaryRow[]
  housingByIdCard: Map<string, AnnualHousingAccountRow>
}): Promise<HousingDeclarationWriteResult> {
  const headerRows: Array<Array<string | number>> = [
    ['缴存基数调整列表', '', '', '', '', '', '', '', ''],
    ['证件号码', '姓名', '调整前缴存基数', '调整后缴存基数', '调整后单位月缴存额', '调整后个人月缴存额', '调整后月缴存额', '调整后住房补贴月缴存额', '个人账号']
  ]
  const dataRows = input.salaryRows.map((row) => {
    const matched = input.housingByIdCard.get(row.idCard)
    const amount = roundWholeMoney(row.housing)
    return {
      rowNumber: row.rowNumber,
      idCard: row.idCard,
      name: row.name,
      account: matched?.account ?? '',
      hasAccount: Boolean(matched?.account),
      beforeBase: matched?.base ?? 0,
      afterBase: amount ? roundMoney(amount / 0.12) : 0,
      unitAmount: amount,
      personalAmount: amount,
      monthlyAmount: roundMoney(amount * 2),
      housingAllowance: 0
    }
  })
  const missing = dataRows
    .filter((row) => !row.hasAccount)
    .map((row) => `第 ${row.rowNumber} 行 | 姓名：${row.name} | 证件号码：${row.idCard}`)
  const amountTotal = dataRows.reduce((total, row) => roundMoney(total + row.unitAmount), 0)

  const workbookPath = join(
    input.outputDir,
    `${safeFileStem(input.unitName || '公积金申报')}_公积金申报_${input.stamp}.xls`
  )

  if (canFillTemplateViaExcel(input.templateWorkbookPath)) {
    await fillTemplateViaExcel(
      (dataPath) =>
        buildWriteHousingDeclarationTemplateScript({
          templateWorkbookPath: input.templateWorkbookPath as string,
          outputPath: workbookPath,
          dataPath
        }),
      dataRows.map(({ rowNumber: _rowNumber, hasAccount: _hasAccount, ...rest }) => rest),
      '写入公积金申报模板失败'
    )
  } else {
    const aoa: Array<Array<string | number>> = [
      ...headerRows,
      ...dataRows.map((row) => [
        row.idCard,
        row.name,
        row.beforeBase,
        row.afterBase,
        row.unitAmount,
        row.personalAmount,
        row.monthlyAmount,
        row.housingAllowance,
        row.account
      ])
    ]
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet(headerRows)
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }]
    sheet['!cols'] = [9.4, 5.4, 15.4, 15.4, 19.4, 19.4, 15.4, 23.4, 9.4].map((wch) => ({ wch }))
    aoa.slice(2).forEach((row, index) => {
      const rowIndex = index + 2
      writeRowValues(sheet, rowIndex, row)
      setCellAsText(sheet, rowIndex, 0)
      setCellAsText(sheet, rowIndex, 8)
    })
    setSheetRef(sheet, Math.max(getSheetLastRow(sheet), aoa.length - 1), 8)
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet 1')
    writeWorkbook(workbookPath, workbook, 'xls')
  }

  let missingLogPath: string | undefined
  if (missing.length > 0) {
    missingLogPath = join(input.outputDir, `未查到公积金账号_${input.stamp}.txt`)
    // UTF-8 + BOM：utf16le 无 BOM 会被记事本按 GBK 误读成乱码。
    writeFileSync(
      missingLogPath,
      `﻿以下人员未查到公积金账号：\r\n生成时间：${new Date().toLocaleString()}\r\n${'-'.repeat(30)}\r\n${missing.join('\r\n')}`,
      'utf8'
    )
  }

  return { workbookPath, missingLogPath, rowCount: input.salaryRows.length, amountTotal }
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
  if (Object.keys(values).length === 0) {
    if (input.salaryWorkbookPath !== input.outputPath) copyFileSync(input.salaryWorkbookPath, input.outputPath)
    return 0
  }

  if (process.platform !== 'win32') {
    throw new Error('工资表原格式回写当前需要 Windows Excel。Linux 版本需要接入 NPOI/LibreOffice helper 后再启用。')
  }

  mkdirSync(dirname(input.outputPath), { recursive: true })
  const dataDir = getDataPath('临时脚本')
  mkdirSync(dataDir, { recursive: true })
  const dataPath = join(dataDir, `annual-values-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(dataPath, JSON.stringify(values), 'utf8')
  try {
    const output = await runPowerShellScript(
      buildWriteSalaryScript({
        salaryWorkbookPath: input.salaryWorkbookPath,
        outputPath: input.outputPath,
        dataPath
      }),
      '写回五险一金工资表失败'
    )
    const match = output.match(/applied=(\d+)/)
    return match ? Number(match[1]) : 0
  } finally {
    try {
      unlinkSync(dataPath)
    } catch {
      // best-effort cleanup
    }
  }
}

function buildWriteSalaryScript(input: {
  salaryWorkbookPath: string
  outputPath: string
  dataPath: string
}): string {
  const salaryPath = psString(input.salaryWorkbookPath)
  const outputPath = psString(input.outputPath)
  const dataPath = psString(input.dataPath)
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$SalaryPath = ${salaryPath}
$OutputPath = ${outputPath}
$DataPath = ${dataPath}

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
    if (($headers.ContainsKey((Norm '证件号码')) -or $headers.ContainsKey((Norm '身份证号')) -or $headers.ContainsKey((Norm '身份证'))) -and $headers.ContainsKey((Norm '姓名'))) {
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
function ColNearby($ws, $h, [string[]]$aliases) {
  $c = Col $h.Headers $aliases
  if ($c -gt 0) { return $c }
  for ($r = $h.Row; $r -le [math]::Min($h.LastRow, $h.Row + 2); $r++) {
    for ($col = 1; $col -le $h.LastCol; $col++) {
      $key = Norm (CellText $ws $r $col)
      foreach ($alias in $aliases) {
        if ($key -eq (Norm $alias)) { return [int]$col }
      }
    }
  }
  return 0
}
function FixedPayrollColumn([string]$field) {
  switch ($field) {
    '养老保险缴费' { return 20 }
    '职业年金缴费' { return 21 }
    '医疗保险' { return 22 }
    '失业保险' { return 23 }
    '公积金' { return 24 }
    default { return 0 }
  }
}

$map = @{}
$obj = Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($prop in $obj.PSObject.Properties) {
  $inner = @{}
  foreach ($p in $prop.Value.PSObject.Properties) { $inner[$p.Name] = [double]$p.Value }
  $map[$prop.Name] = $inner
}

$xl = $null
$wb = $null
try {
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
    '公积金' = ColNearby $ws $h @('公积金','住房公积金')
    '养老保险缴费' = ColNearby $ws $h @('养老保险缴费','养老保险')
    '职业年金缴费' = ColNearby $ws $h @('职业年金缴费','职业年金')
    '医疗保险' = ColNearby $ws $h @('医疗保险','医保大病统筹')
    '失业保险' = ColNearby $ws $h @('失业保险')
  }
  foreach ($field in @($fieldCols.Keys)) {
    if ([int]$fieldCols[$field] -le 0) {
      $fieldCols[$field] = FixedPayrollColumn $field
    }
  }
  $appliedPeople = @{}
  for ($r = $h.Row + 1; $r -le $h.LastRow; $r++) {
    $id = ((CellText $ws $r $idCol).ToUpper() -replace '[,\\s]', '')
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

function canFillTemplateViaExcel(templateWorkbookPath: string | undefined): templateWorkbookPath is string {
  return process.platform === 'win32' && Boolean(templateWorkbookPath) && existsForRead(templateWorkbookPath as string)
}

// 用 Excel COM 打开模板、只覆盖数据行，保留模板的样式/富文本/数据校验下拉，避免 SheetJS 重写丢格式。
async function fillTemplateViaExcel(
  buildScript: (dataPath: string) => string,
  data: unknown,
  errorPrefix: string
): Promise<void> {
  const dataDir = getDataPath('临时脚本')
  mkdirSync(dataDir, { recursive: true })
  const dataPath = join(dataDir, `template-fill-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  writeFileSync(dataPath, JSON.stringify(data), 'utf8')
  try {
    await runPowerShellScript(buildScript(dataPath), errorPrefix)
  } finally {
    try {
      unlinkSync(dataPath)
    } catch {
      // best-effort cleanup
    }
  }
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
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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
  # PS5.1：先赋值再 @() 包裹；@(管道 | ConvertFrom-Json) 会把整个 JSON 数组折叠成单元素，导致所有行被并到一行
  $parsed = (Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  $rows = @($parsed)

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
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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
  # PS5.1：先赋值再 @() 包裹；@(管道 | ConvertFrom-Json) 会把整个 JSON 数组折叠成单元素，导致所有行被并到一行
  $parsed = (Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  $rows = @($parsed)

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
    $ws.Range($ws.Cells.Item(4, 3), $ws.Cells.Item(3 + $count, 3)).NumberFormat = '@'
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

function buildWriteHousingDeclarationTemplateScript(input: {
  templateWorkbookPath: string
  outputPath: string
  dataPath: string
}): string {
  const templatePath = psString(input.templateWorkbookPath)
  const outputPath = psString(input.outputPath)
  const dataPath = psString(input.dataPath)
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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
  # PS5.1：先赋值再 @() 包裹；@(管道 | ConvertFrom-Json) 会把整个 JSON 数组折叠成单元素，导致所有行被并到一行
  $parsed = (Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  $rows = @($parsed)

  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false
  $wb = $xl.Workbooks.Open($OutputPath, 3, $false)
  $ws = $wb.Sheets.Item(1)

  $used = $ws.UsedRange
  $lastRow = [int]($used.Row + $used.Rows.Count - 1)
  if ($lastRow -ge 3) {
    $ws.Range($ws.Cells.Item(3, 1), $ws.Cells.Item($lastRow, 9)).ClearContents() | Out-Null
  }

  $count = [int]$rows.Count
  if ($count -gt 0) {
    $ws.Range($ws.Cells.Item(3, 1), $ws.Cells.Item(2 + $count, 1)).NumberFormat = '@'
    $ws.Range($ws.Cells.Item(3, 9), $ws.Cells.Item(2 + $count, 9)).NumberFormat = '@'
    $data = New-Object 'object[,]' $count, 9
    for ($i = 0; $i -lt $count; $i++) {
      $data[$i, 0] = N $rows[$i].idCard
      $data[$i, 1] = N $rows[$i].name
      $data[$i, 2] = Amount $rows[$i].beforeBase
      $data[$i, 3] = Amount $rows[$i].afterBase
      $data[$i, 4] = Amount $rows[$i].unitAmount
      $data[$i, 5] = Amount $rows[$i].personalAmount
      $data[$i, 6] = Amount $rows[$i].monthlyAmount
      $data[$i, 7] = Amount $rows[$i].housingAllowance
      $data[$i, 8] = N $rows[$i].account
    }
    $target = $ws.Range($ws.Cells.Item(3, 1), $ws.Cells.Item(2 + $count, 9))
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
  const scriptDir = getDataPath('临时脚本')
  try {
    mkdirSync(scriptDir, { recursive: true })
  } catch {
    mkdirSync(tmpdir(), { recursive: true })
  }
  const scriptPath = join(
    existsForRead(scriptDir) ? scriptDir : tmpdir(),
    `annual-adjustment-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`
  )
  writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8')
  return new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      try {
        unlinkSync(scriptPath)
      } catch {
        // best-effort cleanup
      }
    }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
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
      cleanup()
      reject(new Error(`无法启动 PowerShell：${error.message}`))
    })
    child.on('close', (code) => {
      cleanup()
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`${errorPrefix}：${stderr.trim() || `PowerShell 退出码 ${code}`}`))
    })
  })
}

const SALARY_FIXED_COLUMNS = {
  gross: 18,
  pension: 19,
  annuity: 20,
  medical: 21,
  unemployment: 22,
  housing: 23,
  deductionTotal: 27,
  net: 28
}

function annualSalaryWriteColumns(rows: Array<Array<unknown>>, headerRowIndex: number): Map<string, number> {
  const pick = (aliases: string[], fallback: number): number => {
    const column = findColumnNearby(rows, headerRowIndex, aliases)
    return column >= 0 ? column : fallback
  }
  return new Map([
    ['公积金', pick(['公积金', '住房公积金'], SALARY_FIXED_COLUMNS.housing)],
    ['养老保险缴费', pick(['养老保险缴费', '养老保险'], SALARY_FIXED_COLUMNS.pension)],
    ['职业年金缴费', pick(['职业年金缴费', '职业年金'], SALARY_FIXED_COLUMNS.annuity)],
    ['医疗保险', pick(['医疗保险', '医保大病统筹'], SALARY_FIXED_COLUMNS.medical)],
    ['失业保险', pick(['失业保险'], SALARY_FIXED_COLUMNS.unemployment)]
  ])
}

function setSheetAndRowValue(
  sheet: XLSX.WorkSheet,
  rows: Array<Array<unknown>>,
  rowIndex: number,
  columnIndex: number,
  value: number
): void {
  setCellValue(sheet, rowIndex, columnIndex, value)
  if (!rows[rowIndex]) rows[rowIndex] = []
  rows[rowIndex][columnIndex] = value
}

function updateSalaryDerivedCells(sheet: XLSX.WorkSheet, rows: Array<Array<unknown>>, rowIndex: number): void {
  const row = rows[rowIndex] ?? []
  const lastColumn = Math.max(row.length - 1, getSheetLastColumn(sheet))
  if (lastColumn < SALARY_FIXED_COLUMNS.deductionTotal) return
  const deductionTotal = roundMoney(
    rangeSum(row, SALARY_FIXED_COLUMNS.pension, Math.min(SALARY_FIXED_COLUMNS.deductionTotal - 1, lastColumn))
  )
  setSheetAndRowValue(sheet, rows, rowIndex, SALARY_FIXED_COLUMNS.deductionTotal, deductionTotal)
  if (lastColumn >= SALARY_FIXED_COLUMNS.net) {
    setSheetAndRowValue(
      sheet,
      rows,
      rowIndex,
      SALARY_FIXED_COLUMNS.net,
      roundMoney(num(row[SALARY_FIXED_COLUMNS.gross]) - deductionTotal)
    )
  }
}

function updateSalaryTotalRow(
  sheet: XLSX.WorkSheet,
  rows: Array<Array<unknown>>,
  personRows: number[],
  writtenColumns: number[]
): void {
  if (personRows.length === 0) return
  const totalRowIndex = findSalaryTotalRowIndex(rows)
  if (totalRowIndex < 0) return
  const columns = Array.from(new Set([
    ...writtenColumns,
    SALARY_FIXED_COLUMNS.deductionTotal,
    SALARY_FIXED_COLUMNS.net
  ])).filter((column) => column >= 0)
  for (const columnIndex of columns) {
    const total = roundMoney(personRows.reduce((sum, rowIndex) => sum + num(rows[rowIndex]?.[columnIndex]), 0))
    setSheetAndRowValue(sheet, rows, totalRowIndex, columnIndex, total)
  }
}

function findSalaryTotalRowIndex(rows: Array<Array<unknown>>): number {
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    if (text(rows[rowIndex]?.[4]).replace(/\s+/g, '').includes('合计')) return rowIndex
  }
  return -1
}

function rangeSum(row: Array<unknown>, startColumn: number, endColumn: number): number {
  let total = 0
  for (let columnIndex = startColumn; columnIndex <= endColumn; columnIndex += 1) {
    total += num(row[columnIndex])
  }
  return total
}

async function writeAnnualValuesBackToSalaryWorkbook(input: {
  salaryWorkbookPath: string
  outputDir: string
  stamp: string
  people: AnnualSourcePerson[]
}): Promise<{ salaryOutputPath: string; salaryBackupPath: string; salaryApplied: number }> {
  // 工资表备份沿用原文件名（放在输出目录，不与导入文件夹里的源文件冲突）
  const salaryBackupPath = join(input.outputDir, basename(input.salaryWorkbookPath))
  copyFileSync(input.salaryWorkbookPath, salaryBackupPath)
  const salaryOutputPath = input.salaryWorkbookPath
  const salaryApplied = await writeAnnualValuesToSalaryWorkbook({
    salaryWorkbookPath: salaryBackupPath,
    outputPath: salaryOutputPath,
    people: input.people
  })
  return { salaryOutputPath, salaryBackupPath, salaryApplied }
}

function validateUpdatedSalaryInsuranceTotals(
  people: AnnualSourcePerson[],
  salary: SalarySummary
): void {
  const mappings: Array<[string, string, string]> = [
    ['养老保险缴费', '养老保险', '养老保险'],
    ['职业年金缴费', '职业年金', '职业年金'],
    ['医疗保险', '医保大病统筹', '医疗保险'],
    ['失业保险', '失业保险', '失业保险']
  ]
  const messages: string[] = []
  for (const [sourceField, salarySummaryField, label] of mappings) {
    if (!people.some((person) => Object.prototype.hasOwnProperty.call(person.values, sourceField))) continue
    const expected = roundMoney(people.reduce((sum, person) => sum + num(person.values[sourceField]), 0))
    const actual = roundMoney(num(salary.active[salarySummaryField]))
    if (Math.abs(roundMoney(expected - actual)) >= 0.01) {
      messages.push(`${label} 来源合计 ${expected.toFixed(2)} / 工资表合计 ${actual.toFixed(2)}`)
    }
  }
  if (messages.length > 0) {
    throw new Error(`五险一金写入后合计不一致：${messages.join('；')}`)
  }
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
  if (rows.length === 0) {
    return { changes: [], manual: [], missing: [], existingRowCount: 0 }
  }

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
  return { changes, manual, missing, existingRowCount: rows.length }
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
    `工资表有 ${people.length} 人按身份证在在职工资中未找到，相关五险一金金额未自动回写。示例：${examples.join('、')}${suffix}`
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

const ACTIVE_SEED_FIELD_SOURCES: Array<[string, string[]]> = [
  ['岗位工资', ['岗位工资']],
  ['薪级工资', ['薪级工资']],
  ['岗位津贴', ['岗位津贴']],
  ['生活补贴', ['生活补贴']],
  ['绩效工资', ['绩效工资']],
  ['工作性津贴', ['工作性津贴']],
  ['教（工）龄补贴', ['教（工）龄补贴']],
  ['特岗性津补贴', ['特岗性津补贴']],
  ['交通费', ['交通费']],
  ['公车补贴', ['公车补贴']],
  ['住房补贴', ['住房补贴']],
  ['基础绩效奖', ['基础绩效奖', '基础性绩效工资']],
  ['其他一', ['其他一']],
  ['其他二', ['其他二']],
  ['其他三', ['其他三']],
  ['当月个人所得税', ['当月个人所得税']],
  ['公积金', ['公积金']],
  ['养老保险缴费', ['养老保险缴费']],
  ['职业年金缴费', ['职业年金缴费']],
  ['医疗保险', ['医疗保险']],
  ['失业保险', ['失业保险']],
  ['支出一', ['支出一']],
  ['支出二', ['支出二']],
  ['支出三', ['支出三']]
]

async function seedIntegratedActiveFromSalarySummary(
  salary: SalarySummary,
  sourcePeople: AnnualSourcePerson[]
): Promise<number> {
  if (salary.activePeople.length === 0) return 0
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const table = tableNameOf(worksheet)
  const database = await getDatabase()
  const countRows = await all<{ total: number }>(database, `SELECT COUNT(*) AS total FROM ${table}`)
  if ((countRows[0]?.total ?? 0) > 0) return 0

  const fieldColumns = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const idColumn = fieldColumns.get('证件号码')
  if (!idColumn) throw new Error('在职工资缺少证件号码字段')

  const unitSettings = await readUnitSettings()
  const salaryType = unitSettings.salaryExportSaltypes?.[0]
  const sourceByIdCard = new Map(sourcePeople.map((person) => [person.idCard, person]))
  const rows = salary.activePeople
    .map((person, index) =>
      buildIntegratedActiveSeedRow(person, index, fieldColumns, {
        unitCode: unitSettings.unitImportCode,
        unitName: unitSettings.unitFullName,
        salaryTypeCode: salaryType?.saltype_id ?? '2',
        salaryTypeName: salaryType?.saltype_name ?? '002事业',
        source: sourceByIdCard.get(person.idCard)
      })
    )
    .filter((row) => text(row[idColumn]))
  if (rows.length === 0) return 0

  const settings = await readMonthlyPayrollSettings()
  applyIntegratedComputedFieldsToRows(worksheet, rows, settings.taxField)

  const { lastId: batchId } = await runWithLastId(
    database,
    `INSERT INTO import_batches (source_name, worksheet_id, worksheet_name, status) VALUES (?, ?, ?, 'pending')`,
    ['五险一金更新自动写入', worksheet.worksheetId, worksheet.name]
  )

  await run(database, 'BEGIN TRANSACTION')
  let insertedRows = 0
  try {
    const now = new Date().toISOString()
    const batchSize = 200
    for (let batchStart = 0; batchStart < rows.length; batchStart += batchSize) {
      const batch = rows.slice(batchStart, batchStart + batchSize)
      const allColumnNames = Array.from(new Set(batch.flatMap((row) => Object.keys(row))))
      const columnList = [...allColumnNames.map(quoteIdentifier), '"md_created_at"', '"md_updated_at"'].join(', ')
      const singleRowPlaceholders = `(${[...allColumnNames.map(() => '?'), '?', '?'].join(', ')})`
      const allPlaceholders = batch.map(() => singleRowPlaceholders).join(', ')
      const params: unknown[] = []
      for (const row of batch) {
        for (const columnName of allColumnNames) params.push(row[columnName] ?? null)
        params.push(now, now)
      }
      const { lastId } = await runWithLastId(
        database,
        `INSERT INTO ${table} (${columnList}) VALUES ${allPlaceholders}`,
        params
      )
      const firstId = lastId - batch.length + 1
      const rowPlaceholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ')
      const rowParams: unknown[] = []
      for (let index = 0; index < batch.length; index += 1) {
        rowParams.push(batchId, worksheet.name, firstId + index, 'insert', null)
      }
      await run(
        database,
        `INSERT INTO import_batch_rows (batch_id, worksheet_name, record_id, action, previous_values) VALUES ${rowPlaceholders}`,
        rowParams
      )
      insertedRows += batch.length
    }

    const message = `五险一金更新：在职工资为空，已按更新后的工资表新增 ${insertedRows} 人`
    await run(
      database,
      `UPDATE import_batches SET status = 'imported', row_count = ?, message = ? WHERE id = ?`,
      [insertedRows, message, batchId]
    )
    await run(
      database,
      `INSERT INTO import_logs (file_name, worksheet_name, ok, imported_rows, message, batch_id) VALUES (?, ?, 1, ?, ?, ?)`,
      ['五险一金更新自动写入', worksheet.name, insertedRows, message, batchId]
    )
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    await run(
      database,
      `UPDATE import_batches SET status = 'failed', message = ? WHERE id = ?`,
      [error instanceof Error ? error.message : '五险一金写入在职工资失败', batchId]
    )
    throw error
  }

  await refreshAllPersonnelStatuses(database)
  return insertedRows
}

function buildIntegratedActiveSeedRow(
  person: PayrollPerson,
  index: number,
  fieldColumns: Map<string, string>,
  defaults: {
    unitCode: string
    unitName: string
    salaryTypeCode: string
    salaryTypeName: string
    source?: AnnualSourcePerson
  }
): Record<string, WorksheetRecordValue> {
  const row: Record<string, WorksheetRecordValue> = {}
  const assign = (fieldName: string, value: WorksheetRecordValue | undefined): void => {
    const columnName = fieldColumns.get(fieldName)
    if (!columnName || value === undefined) return
    row[columnName] = value === '' ? null : value
  }
  const assignNumber = (fieldName: string, sourceNames: string[]): void => {
    assign(fieldName, salaryPersonNumber(person, sourceNames))
  }

  const now = new Date()
  assign('单位编码', defaults.unitCode)
  assign('单位名称', defaults.unitName)
  assign('工资类别编码', defaults.salaryTypeCode)
  assign('工资类别名称', defaults.salaryTypeName)
  assign('业务年度', now.getFullYear())
  assign('月份', now.getMonth() + 1)
  assign('姓名', person.name)
  assign('证件号码', person.idCard)
  assign('工资批次编码', '001')
  assign('工资批次名称', '工资')
  assign('部门内序号', num(person.values['序号']) || index + 1)
  for (const [fieldName, sourceNames] of ACTIVE_SEED_FIELD_SOURCES) assignNumber(fieldName, sourceNames)
  for (const fieldName of INTEGRATED_FIELDS) {
    if (defaults.source && Object.prototype.hasOwnProperty.call(defaults.source.values, fieldName)) {
      assign(fieldName, roundMoney(num(defaults.source.values[fieldName])))
    }
  }
  const backpay = activeBackpayAdjustmentTotals(person)
  assign('补发工资', backpay.increaseTotal)
  assign('补扣工资', backpay.deductionTotal)
  return row
}

function salaryPersonNumber(person: PayrollPerson, sourceNames: string[]): number {
  for (const sourceName of sourceNames) {
    if (Object.prototype.hasOwnProperty.call(person.values, sourceName)) {
      return roundMoney(num(person.values[sourceName]))
    }
  }
  return 0
}

async function applyIntegratedPlan(plan: IntegratedPlan): Promise<void> {
  if (plan.changes.length === 0) return
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const fieldColumns = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const table = tableNameOf(worksheet)
  const database = await getDatabase()
  const settings = await readMonthlyPayrollSettings()
  const now = new Date().toISOString()
  const updatesByRow = new Map<number, Record<string, WorksheetRecordValue>>()
  for (const change of plan.changes) {
    const columnName = fieldColumns.get(change.fieldName)
    if (!columnName) continue
    for (const update of change.updates) {
      const values = updatesByRow.get(update.rowId) ?? {}
      values[columnName] = update.value
      updatesByRow.set(update.rowId, values)
    }
  }

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const [rowId, values] of updatesByRow.entries()) {
      await applyIntegratedComputedFieldsForUpdate(database, worksheet, rowId, values, settings.taxField)
      const columnNames = Object.keys(values)
      if (columnNames.length === 0) continue
      const assignments = columnNames
        .map((columnName) => `${quoteIdentifier(columnName)} = ?`)
        .concat('"md_updated_at" = ?')
        .join(', ')
      await run(
        database,
        `UPDATE ${table} SET ${assignments} WHERE "id" = ?`,
        [...columnNames.map((columnName) => values[columnName]), now, rowId]
      )
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }
}

async function syncIntegratedUnitNameForPeople(sourcePeople: AnnualSourcePerson[]): Promise<number> {
  const unitSettings = await readUnitSettings()
  const unitName = text(unitSettings.unitFullName)
  if (!unitName) return 0
  const idCards = Array.from(new Set(sourcePeople.map((person) => person.idCard).filter(Boolean)))
  if (idCards.length === 0) return 0

  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const fieldColumns = new Map(columns.map((column) => [column.field.name, column.columnName]))
  const idColumn = fieldColumns.get('证件号码')
  const unitNameColumn = fieldColumns.get('单位名称')
  if (!idColumn || !unitNameColumn) return 0

  const database = await getDatabase()
  const table = tableNameOf(worksheet)
  const normalizedIdExpression = `UPPER(REPLACE(REPLACE(TRIM(CAST(${quoteIdentifier(idColumn)} AS TEXT)), ' ', ''), ',', ''))`
  const now = new Date().toISOString()
  let updated = 0
  for (let start = 0; start < idCards.length; start += 400) {
    const batch = idCards.slice(start, start + 400)
    const placeholders = batch.map(() => '?').join(', ')
    const result = await runWithLastId(
      database,
      `UPDATE ${table}
         SET ${quoteIdentifier(unitNameColumn)} = ?,
             "md_updated_at" = ?
       WHERE ${normalizedIdExpression} IN (${placeholders})
         AND COALESCE(CAST(${quoteIdentifier(unitNameColumn)} AS TEXT), '') <> ?`,
      [unitName, now, ...batch, unitName]
    )
    updated += result.changes
  }
  return updated
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
  return text(value).replace(/[\s,]/g, '').toUpperCase()
}

function looksLikeIdCard(value: unknown): boolean {
  const normalized = normalizeIdCard(value)
  return /^\d{15}$/.test(normalized) || /^\d{17}[\dX]$/.test(normalized)
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function roundWholeMoney(value: number): number {
  return Math.round(value + Number.EPSILON)
}

function roundUpWholeMoney(value: number): number {
  return Math.ceil(value - 1e-9)
}

function timestamp(): string {
  const d = new Date()
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`
}

function safeFileStem(value: string): string {
  const raw = basename(value, extname(value)) || value || '五险一金'
  const cleaned = raw.replace(/[\\/:*?"<>|\s]/g, '')
  if (cleaned) return cleaned
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}

function psString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}
