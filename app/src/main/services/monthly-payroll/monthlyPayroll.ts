import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as XLSX from 'xlsx'
import { all, getDatabase, run } from '../../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../../db/schema'
import { failRule, okRule } from '../ruleResult'
import { findColumnByName, getWorksheetByName, tableNameOf } from '../worksheetTable'
import type {
  MonthlyPayrollReportResult,
  MonthlyPayrollReportSheet,
  MonthlyPayrollArchiveResult,
  MonthlyPayrollRun,
  MonthlyPayrollWorkflowInput,
  MonthlyPayrollWriteBackPreview,
  RuleResult,
  UnitSettings
} from '../../../shared/types'
import { readUnitSettings } from '../unitSettings'

type CellValue = string | number | boolean | Date | null | undefined

type SalarySummary = {
  active: Record<string, number>
  survivor: Record<string, number>
  activePeople: PayrollPerson[]
  survivorPeople: PayrollPerson[]
}

type PayrollPerson = {
  idCard: string
  name: string
  account: string
  rowNumber: number
  values: Record<string, number | string>
}

type SocialSecuritySummary = {
  byItem: Record<string, number>
  rowCount: number
}

type PersonalInsuranceTotals = {
  pension: number
  annuity: number
  medical: number
  unemployment: number
  total: number
}

type TaxSummary = {
  totalTax: number
  rows: TaxPerson[]
  missingIdCards: TaxPerson[]
}

type TaxPerson = {
  idCard: string
  name: string
  taxAmount: number
  rowNumber: number
}

type RetiredSummary = {
  count: number
  housing: number
}

type RetiredHousingPerson = {
  name: string
  idCard: string
  unitName: string
  housing: number
  backpay: number
  payable: number
  actualPay: number
}

type CompareSummary = {
  sourceName: string
  targetName: string
  sourceRows: number
  targetRows: number
  added: number
  removed: number
  changed: number
  changedExamples: string[]
}

type IntegratedWriteBackUpdate = {
  rowId: number
  value: number
}

type IntegratedWriteBackChange = {
  worksheetName: string
  idCard: string
  name: string
  fieldName: string
  sourceValue: number
  targetValue: number
  batchCode: string
  reason: string
  updates: IntegratedWriteBackUpdate[]
}

type IntegratedManualDifference = {
  worksheetName: string
  idCard: string
  name: string
  fieldName: string
  sourceValue: number
  targetValue: number
  reason: string
}

type IntegratedWriteBackPlan = {
  changes: IntegratedWriteBackChange[]
  manual: IntegratedManualDifference[]
}

type IntegratedRow = {
  idCard: string
  name: string
  rowId: number
  values: Record<string, string | number>
}

const workflowName = '月度工资报账预处理'
const generateWorkflowName = '月度工资报账汇总生成'

const activeSalaryFields = [
  '岗位工资',
  '薪级工资',
  '基本补发',
  '应发基础工资',
  '教龄津贴',
  '岗位津贴',
  '生活补贴',
  '绩效补发',
  '基础性绩效',
  '乡镇补贴',
  '边远乡镇补贴',
  '住房补贴',
  '交通补贴',
  '应发工资合计',
  '养老保险',
  '职业年金',
  '医保大病统筹',
  '失业保险',
  '住房公积金',
  '个税',
  '扣款补发',
  '补扣工资',
  '五险一金',
  '实发工资合计'
]

const activeCompareFields: Array<[string, string]> = [
  ['姓名', 'name'],
  ['岗位工资', '岗位工资'],
  ['薪级工资', '薪级工资'],
  ['岗位津贴', '岗位津贴'],
  ['生活补贴', '生活补贴'],
  ['其他一', '其他一'],
  ['教（工）龄补贴', '教（工）龄补贴'],
  ['住房补贴', '住房补贴'],
  ['交通费', '交通费'],
  ['养老保险缴费', '养老保险缴费'],
  ['职业年金缴费', '职业年金缴费'],
  ['医疗保险', '医疗保险'],
  ['失业保险', '失业保险'],
  ['公积金', '公积金'],
  ['补扣工资', '当月个人所得税']
]

const survivorCompareFields: Array<[string, string]> = [
  ['姓名', 'name'],
  ['应发工资小计', '应发工资小计'],
  ['实发合计', '实发合计']
]

const INTEGRATED_ACTIVE_PAY_FIELDS = [
  '岗位工资',
  '薪级工资',
  '岗位津贴',
  '生活补贴',
  '绩效工资',
  '工作性津贴',
  '教（工）龄补贴',
  '特岗性津补贴',
  '交通费',
  '公车补贴',
  '住房补贴',
  '基础绩效奖',
  '补发工资',
  '其他一'
]

const INTEGRATED_ACTIVE_DEDUCT_FIELDS = [
  '公积金',
  '养老保险缴费',
  '职业年金缴费',
  '医疗保险',
  '失业保险'
]

const INTEGRATED_NUMERIC_REPRESENTATIVE_FIELDS = new Set([
  '月份',
  '部门内序号',
  '业务年度',
  '序号',
  '人数',
  '年龄',
  '工龄（年）',
  '参加工作时间'
])

type IntegratedActiveRecomputeResult = {
  rowCount: number
  taxApplied: number
  taxMissing: number
  payableTotal: number
  actualPayTotal: number
}

export async function applyTaxAndRecomputeIntegratedActive(
  taxByIdCard: Record<string, number>
): Promise<IntegratedActiveRecomputeResult> {
  const worksheet = getWorksheetByName('一体化在职')
  const idCardCol = findColumnByName(worksheet, '证件号码')
  const deductCol = findColumnByName(worksheet, '补扣工资')
  const payableCol = findColumnByName(worksheet, '应发工资')
  const actualCol = findColumnByName(worksheet, '实发合计')
  const payCols = INTEGRATED_ACTIVE_PAY_FIELDS.map((name) => findColumnByName(worksheet, name))
  const deductionCols = INTEGRATED_ACTIVE_DEDUCT_FIELDS.map((name) => findColumnByName(worksheet, name))
  const columns = getWorksheetLocalColumns(worksheet)
  const batchColumn = columns.find((column) => column.field.name === '工资批次')?.columnName
  const table = tableNameOf(worksheet)
  const database = await getDatabase()

  const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${table}`)
  const latestByIdBatch = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idCardCol])
    if (!idCard) continue
    const key = integratedCurrentRowKey(idCard, row, batchColumn)
    const previous = latestByIdBatch.get(key)
    if (!previous || num(row.id) > num(previous.id)) latestByIdBatch.set(key, row)
  }

  const rowsByIdCard = new Map<string, Record<string, unknown>[]>()
  for (const row of latestByIdBatch.values()) {
    const idCard = normalizeIdCard(row[idCardCol])
    const grouped = rowsByIdCard.get(idCard) ?? []
    grouped.push(row)
    rowsByIdCard.set(idCard, grouped)
  }

  let taxApplied = 0
  let taxMissing = 0
  for (const idCard of Object.keys(taxByIdCard)) {
    if (!rowsByIdCard.has(idCard)) taxMissing += 1
  }

  let payableTotal = 0
  let actualPayTotal = 0
  const now = new Date().toISOString()

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const [idCard, personRows] of rowsByIdCard.entries()) {
      const overrideTax = taxByIdCard[idCard]
      if (overrideTax !== undefined) taxApplied += 1

      const taxCarrier = selectIntegratedRepresentativeRow(personRows, batchColumn)
      for (const row of personRows) {
        const receivesOverrideTax = overrideTax !== undefined && num(row.id) === num(taxCarrier.id)
        const deductAmount = overrideTax !== undefined
          ? (receivesOverrideTax ? overrideTax : 0)
          : num(row[deductCol])
        const payable = payCols.reduce((sum, col) => sum + num(row[col]), 0)
        const deductionsSum = deductionCols.reduce((sum, col) => sum + num(row[col]), 0)
        const actual = roundMoney(payable - deductionsSum - deductAmount)
        const payableRounded = roundMoney(payable)

        await run(
          database,
          `UPDATE ${table}
             SET ${quoteIdentifier(deductCol)} = ?,
                 ${quoteIdentifier(payableCol)} = ?,
                 ${quoteIdentifier(actualCol)} = ?,
                 "md_updated_at" = ?
           WHERE "id" = ?`,
          [deductAmount, payableRounded, actual, now, row.id]
        )

        payableTotal = roundMoney(payableTotal + payableRounded)
        actualPayTotal = roundMoney(actualPayTotal + actual)
      }
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  return {
    rowCount: rowsByIdCard.size,
    taxApplied,
    taxMissing,
    payableTotal,
    actualPayTotal
  }
}

async function summarizeIntegratedActive(
  taxByIdCard: Record<string, number>
): Promise<IntegratedActiveRecomputeResult> {
  const rows = await loadIntegratedRows('一体化在职')
  const idCards = new Set(rows.map((row) => row.idCard))
  let taxApplied = 0
  let taxMissing = 0
  for (const idCard of Object.keys(taxByIdCard)) {
    if (idCards.has(idCard)) taxApplied += 1
    else taxMissing += 1
  }
  return {
    rowCount: rows.length,
    taxApplied,
    taxMissing,
    payableTotal: roundMoney(rows.reduce((sum, row) => sum + num(row.values['应发工资']), 0)),
    actualPayTotal: roundMoney(rows.reduce((sum, row) => sum + num(row.values['实发合计']), 0))
  }
}

function buildTaxByIdCardFromSummary(tax: TaxSummary | undefined): Record<string, number> {
  const map: Record<string, number> = {}
  if (!tax) return map
  for (const row of tax.rows) {
    if (!row.idCard) continue
    map[row.idCard] = row.taxAmount
  }
  return map
}

function applyTaxToSalarySummary(
  salary: SalarySummary,
  taxByIdCard: Record<string, number>
): SalarySummary {
  if (Object.keys(taxByIdCard).length === 0) return salary

  let oldTaxTotal = 0
  let nextTaxTotal = 0
  const activePeople = salary.activePeople.map((person) => {
    const currentTax = num(person.values['当月个人所得税'])
    const hasOverride = Object.prototype.hasOwnProperty.call(taxByIdCard, person.idCard)
    const nextTax = hasOverride ? roundMoney(taxByIdCard[person.idCard]) : currentTax
    oldTaxTotal = roundMoney(oldTaxTotal + currentTax)
    nextTaxTotal = roundMoney(nextTaxTotal + nextTax)
    if (nextTax === currentTax) return person

    const values = { ...person.values }
    values['当月个人所得税'] = nextTax
    values['代扣合计'] = roundMoney(num(values['代扣合计']) - currentTax + nextTax)
    values['实发合计'] = roundMoney(num(values['实发合计']) + currentTax - nextTax)
    return { ...person, values }
  })

  const delta = roundMoney(nextTaxTotal - oldTaxTotal)
  return {
    ...salary,
    active: {
      ...salary.active,
      个税: roundMoney(num(salary.active['个税']) + delta),
      五险一金: roundMoney(num(salary.active['五险一金']) + delta),
      实发工资合计: roundMoney(num(salary.active['实发工资合计']) - delta)
    },
    activePeople
  }
}

export async function preprocessMonthlyPayroll(
  payload?: { monthlyPayroll?: MonthlyPayrollWorkflowInput }
): Promise<RuleResult> {
  try {
    const input = payload?.monthlyPayroll
    const targetDate = resolvePayrollPeriod(input)
    if (await isMonthlyPayrollMonthArchived(targetDate.year, targetDate.month)) {
      return {
        ok: false,
        affectedRows: 0,
        messages: [],
        warnings: [`${targetDate.year}年${targetDate.month}月工资已月结，不能再次开始预处理。请在历史报表中查看月结记录。`]
      }
    }
    if (!input?.salaryWorkbookPath) {
      return {
        ok: false,
        affectedRows: 0,
        messages: [],
        warnings: [
          '月度工资报账需要先在监控文件夹中放入本月工资表。社保每月都要处理；个税按单位实际情况处理。'
        ]
      }
    }

    const [socialSecurity, tax] = await Promise.all([
      input.socialSecurityWorkbookPath
        ? parseSocialSecurityWorkbook(input.socialSecurityWorkbookPath)
        : Promise.resolve<SocialSecuritySummary | undefined>(undefined),
      input.taxWorkbookPath
        ? parseTaxWorkbook(input.taxWorkbookPath)
        : Promise.resolve<TaxSummary | undefined>(undefined)
    ])
    const taxByIdCard = buildTaxByIdCardFromSummary(tax)

    const salary = applyTaxToSalarySummary(
      await parseSalaryWorkbook(input.salaryWorkbookPath),
      taxByIdCard
    )
    let activeWriteBackPlan = await buildIntegratedActiveWriteBackPlan(salary.activePeople)
    let survivorWriteBackPlan = await buildIntegratedOtherWriteBackPlan(salary.survivorPeople)
    let writeBackPlan = mergeIntegratedWriteBackPlans(activeWriteBackPlan, survivorWriteBackPlan)
    let writeBackPreview = buildMonthlyPayrollWriteBackPreview(writeBackPlan, {
      requiresConfirmation: writeBackPlan.changes.length > 0 && !input.confirmWriteBack,
      applied: false
    })

    if (writeBackPlan.changes.length > 0 && !input.confirmWriteBack) {
      const result = okRule(
        workflowName,
        salary.activePeople.length + salary.survivorPeople.length + (socialSecurity?.rowCount ?? 0) + (tax?.rows.length ?? 0),
        [
          `发现工资表与一体化工资表有 ${writeBackPlan.changes.length} 项金额差异可自动回写，涉及 ${writeBackPreview.personCount} 人`,
          ...writeBackPreview.examples.map((item) => `可回写：${item}`),
          ...(writeBackPlan.manual.length > 0
            ? [`另有 ${writeBackPlan.manual.length} 项差异需要人工判断，自动回写后会继续复核`]
            : [])
        ],
        ['请确认是否将工资表中的可回写金额同步到一体化工资表；确认后系统会自动复核，仍有差异则停止生成报表。']
      )
      result.monthlyPayrollWriteBack = writeBackPreview
      return result
    }

    let integratedActiveRecompute: IntegratedActiveRecomputeResult
    if (writeBackPlan.changes.length > 0 && input.confirmWriteBack) {
      const appliedPlan = writeBackPlan
      await applyIntegratedWriteBackPlan(writeBackPlan)
      integratedActiveRecompute = activeWriteBackPlan.changes.length > 0
        ? await applyTaxAndRecomputeIntegratedActive(taxByIdCard)
        : await summarizeIntegratedActive(taxByIdCard)
      activeWriteBackPlan = await buildIntegratedActiveWriteBackPlan(salary.activePeople)
      survivorWriteBackPlan = await buildIntegratedOtherWriteBackPlan(salary.survivorPeople)
      writeBackPlan = mergeIntegratedWriteBackPlans(activeWriteBackPlan, survivorWriteBackPlan)
      writeBackPreview = mergeAppliedWriteBackPreview(appliedPlan, writeBackPlan)
    } else {
      integratedActiveRecompute = await summarizeIntegratedActive(taxByIdCard)
    }

    const [activeCompare, survivorCompare, integratedPersonalInsurance] = await Promise.all([
      comparePayrollPeople('公办在职', salary.activePeople, '一体化在职', activeCompareFields),
      comparePayrollPeople('遗补', salary.survivorPeople, '一体化其他', survivorCompareFields),
      loadIntegratedActivePersonalInsuranceTotals()
    ])
    const insuranceCheck = buildPersonalInsuranceCheck(socialSecurity, salary, integratedPersonalInsurance)

    const salaryActualPay = num(salary.active['实发工资合计'])
    const actualPayDiff = roundMoney(salaryActualPay - integratedActiveRecompute.actualPayTotal)
    const actualPayMatched = Math.abs(actualPayDiff) < 0.01

    const mode = socialSecurity ? '工资+社保' : '只报工资'
    const messages = [
      `报账模式：${mode}${tax ? '，包含个税扣款' : '，不处理个税'}`,
      `工资表：在职 ${salary.activePeople.length} 人，遗补 ${salary.survivorPeople.length} 人`,
      formatCompareMessage(activeCompare),
      formatCompareMessage(survivorCompare),
      socialSecurity
        ? `社保：读取 ${socialSecurity.rowCount} 行，按征收品目汇总 ${Object.keys(socialSecurity.byItem).length} 类`
        : '社保：未检测到社保文件，本次不生成社保相关报账；社保属于每月必办，请补齐文件后单独处理社保',
      tax
        ? `个税：读取 ${tax.rows.length} 人，总额 ${formatMoney(tax.totalTax)}，${writeBackPreview.applied ? '已回写到' : '已核对到'}一体化在职 ${integratedActiveRecompute.taxApplied} 人${integratedActiveRecompute.taxMissing ? `，库中缺失 ${integratedActiveRecompute.taxMissing} 人` : ''}`
        : '个税：未检测到个税文件，本次跳过个税扣款和补发工资；如本单位无个税或个税另行代收，可继续不提供个税文件',
      ...(writeBackPreview.applied
        ? [`工资表金额差异已自动回写 ${writeBackPreview.syncableCount} 项，复核后${activeCompare.changed === 0 ? '一体化在职已一致' : `仍有 ${activeCompare.changed} 人存在差异`}`]
        : []),
      `${writeBackPreview.applied ? '一体化在职已按公式重算' : '一体化在职当前汇总'} ${integratedActiveRecompute.rowCount} 人：应发合计 ${formatMoney(integratedActiveRecompute.payableTotal)}，实发合计 ${formatMoney(integratedActiveRecompute.actualPayTotal)}`,
      actualPayMatched
        ? `实发核对：工资表 ${formatMoney(salaryActualPay)} 与 一体化在职 ${formatMoney(integratedActiveRecompute.actualPayTotal)} 一致`
        : `实发核对：工资表 ${formatMoney(salaryActualPay)} 与 一体化在职 ${formatMoney(integratedActiveRecompute.actualPayTotal)} 差 ${formatMoney(actualPayDiff)}`,
      ...insuranceCheck.messages
    ]
    const warnings = [
      ...(activeCompare.added + activeCompare.removed + activeCompare.changed > 0
        ? [formatCompareWarning(activeCompare)]
        : []),
      ...(survivorCompare.added + survivorCompare.removed + survivorCompare.changed > 0
        ? [formatCompareWarning(survivorCompare)]
        : []),
      ...(tax?.missingIdCards.length
        ? [`个税表有 ${tax.missingIdCards.length} 行缺少身份证号，需要人工核对`]
        : []),
      ...(integratedActiveRecompute.taxMissing > 0
        ? [`个税表有 ${integratedActiveRecompute.taxMissing} 人在一体化在职中找不到对应记录，未回写`]
        : []),
      ...(writeBackPreview.applied && activeCompare.changed > 0
        ? ['自动回写后工资表与一体化在职仍有差异，请人工介入；本次不会自动生成报表']
        : []),
      ...(actualPayMatched
        ? []
        : [`工资表实发合计 ${formatMoney(salaryActualPay)} 与一体化在职实发合计 ${formatMoney(integratedActiveRecompute.actualPayTotal)} 不一致（差 ${formatMoney(actualPayDiff)}），请先排查后再生成报表`]),
      ...insuranceCheck.warnings
    ]

    const result = okRule(
      workflowName,
      salary.activePeople.length + salary.survivorPeople.length + (socialSecurity?.rowCount ?? 0) + (tax?.rows.length ?? 0),
      messages,
      warnings
    )
    result.monthlyPayrollWriteBack = writeBackPreview
    return result
  } catch (error) {
    return failRule(workflowName, error)
  }
}

export async function generateMonthlyPayrollReports(
  payload?: { monthlyPayroll?: MonthlyPayrollWorkflowInput }
): Promise<RuleResult> {
  try {
    const input = payload?.monthlyPayroll
    const targetDate = resolvePayrollPeriod(input)
    if (await isMonthlyPayrollMonthArchived(targetDate.year, targetDate.month)) {
      return {
        ok: false,
        affectedRows: 0,
        messages: [],
        warnings: [`${targetDate.year}年${targetDate.month}月工资已月结，不能重新生成报表。请在历史报表中查看月结记录。`]
      }
    }
    if (!input?.salaryWorkbookPath) {
      return {
        ok: false,
        affectedRows: 0,
        messages: [],
        warnings: ['请先在监控文件夹中放入本月工资表，并完成预处理校验。']
      }
    }

    const [rawSalary, socialSecurity, tax] = await Promise.all([
      parseSalaryWorkbook(input.salaryWorkbookPath),
      input.socialSecurityWorkbookPath
        ? parseSocialSecurityWorkbook(input.socialSecurityWorkbookPath)
        : Promise.resolve<SocialSecuritySummary | undefined>(undefined),
      input.taxWorkbookPath
        ? parseTaxWorkbook(input.taxWorkbookPath)
        : Promise.resolve<TaxSummary | undefined>(undefined)
    ])
    const salary = applyTaxToSalarySummary(rawSalary, buildTaxByIdCardFromSummary(tax))

    const activeTotal = salary.active
    const survivorTotal = salary.survivor
    const integratedPersonalInsurance = await loadIntegratedActivePersonalInsuranceTotals()
    const insuranceCheck = buildPersonalInsuranceCheck(socialSecurity, salary, integratedPersonalInsurance)
    const socialTotal = socialSecurity
      ? roundMoney(Object.values(socialSecurity.byItem).reduce((sum, value) => sum + value, 0))
      : 0
    const taxTotal = tax?.totalTax ?? 0
    const salaryBackpayRows = salary.activePeople.filter(
      (person) => num(person.values['基本补发']) !== 0 || num(person.values['绩效补发']) !== 0
    )
    const socialItems = socialSecurity
      ? Object.entries(socialSecurity.byItem)
          .sort((left, right) => right[1] - left[1])
          .slice(0, 8)
          .map(([item, amount]) => `${item} ${formatMoney(amount)}`)
      : []

    const messages = [
      `工资报账汇总已生成预览：在职 ${salary.activePeople.length} 人，遗补 ${salary.survivorPeople.length} 人`,
      `工资汇总：岗位工资 ${formatMoney(activeTotal['岗位工资'])}，薪级工资 ${formatMoney(activeTotal['薪级工资'])}，岗位津贴 ${formatMoney(activeTotal['岗位津贴'])}，生活补贴 ${formatMoney(activeTotal['生活补贴'])}`,
      `补贴汇总：乡镇补贴 ${formatMoney(activeTotal['乡镇补贴'])}，住房补贴 ${formatMoney(activeTotal['住房补贴'])}，交通补贴 ${formatMoney(activeTotal['交通补贴'])}`,
      `遗补汇总：人数 ${formatMoney(survivorTotal['人数'] ?? 0)}，金额 ${formatMoney(survivorTotal['合计'] ?? 0)}`,
      socialSecurity
        ? `社保汇总：${socialSecurity.rowCount} 行，合计 ${formatMoney(socialTotal)}；${socialItems.join('；')}`
        : '社保汇总：未检测到社保文件，本次不生成社保报账；社保属于每月必办，请补齐文件后单独处理社保',
      tax
        ? `个税汇总：${tax.rows.length} 人，合计 ${formatMoney(taxTotal)}，扣税金额将在补发工资文件中按人写入岗位工资列为负数`
        : '个税汇总：未检测到个税文件，本次不生成扣税补发工资；如本单位无个税或个税另行代收，可继续不提供个税文件',
      salaryBackpayRows.length
        ? `工资表补发：${salaryBackpayRows.length} 人，基本补发写入岗位工资列，绩效补发写入薪级工资列`
        : '工资表补发：未检测到基本补发或绩效补发',
      ...insuranceCheck.messages
    ]

    return okRule(
      generateWorkflowName,
      salary.activePeople.length + salary.survivorPeople.length + (socialSecurity?.rowCount ?? 0) + (tax?.rows.length ?? 0),
      messages,
      insuranceCheck.warnings
    )
  } catch (error) {
    return failRule(generateWorkflowName, error)
  }
}

export async function generateMonthlyPayrollReportView(
  input?: MonthlyPayrollWorkflowInput
): Promise<MonthlyPayrollReportResult> {
  if (!input?.salaryWorkbookPath) {
    throw new Error('请先在监控文件夹中放入本月工资表')
  }
  const targetDate = resolvePayrollPeriod(input)
  if (await isMonthlyPayrollMonthArchived(targetDate.year, targetDate.month)) {
    throw new Error(`${targetDate.year}年${targetDate.month}月工资已月结，不能重新生成报表。请在历史报表中查看月结记录。`)
  }

  const [rawSalary, socialSecurity, tax] = await Promise.all([
    parseSalaryWorkbook(input.salaryWorkbookPath),
    input.socialSecurityWorkbookPath
      ? parseSocialSecurityWorkbook(input.socialSecurityWorkbookPath)
      : Promise.resolve<SocialSecuritySummary | undefined>(undefined),
    input.taxWorkbookPath
      ? parseTaxWorkbook(input.taxWorkbookPath)
      : Promise.resolve<TaxSummary | undefined>(undefined)
  ])
  const salary = applyTaxToSalarySummary(rawSalary, buildTaxByIdCardFromSummary(tax))

  const [retired, retiredHousingPeople, unit, integratedActiveHousingFund] = await Promise.all([
    loadRetiredSummary(),
    loadRetiredHousingDetails(),
    readUnitSettings(),
    loadIntegratedActiveHousingFund()
  ])
  const sheets = buildReportSheets(
    salary,
    socialSecurity,
    tax,
    retired,
    unit,
    integratedActiveHousingFund,
    retiredHousingPeople
  )
  const reportFingerprint = fingerprintReportSheets(sheets)
  const period = resolvePayrollPeriod(input)
  const previousRun = await findSameMonthlyPayrollRun(
    period.year,
    period.month,
    reportFingerprint
  )
  if (previousRun) {
    return {
      ok: true,
      message: '本次报表内容无变化，未重新生成文件，已沿用上次输出结果',
      insuranceImportPath: previousRun.insuranceImportPath ?? undefined,
      payrollBackpayPath: previousRun.payrollBackpayPath ?? undefined,
      voucherImportPath: previousRun.voucherImportPath ?? undefined,
      sheets
    }
  }

  const outputDir = join(app.getPath('userData'), '工资报账输出')
  mkdirSync(outputDir, { recursive: true })
  const stamp = timestamp()
  const insuranceImportPath = socialSecurity ? join(outputDir, `保险导入_${stamp}.xlsx`) : undefined
  const backpaySheet = sheets.find((sheet) => sheet.name === '补发工资')
  const hasBackpayRows = Boolean(backpaySheet?.rows.length)
  const payrollBackpayPath = hasBackpayRows ? join(outputDir, `补发工资_${stamp}.xls`) : undefined
  const voucherSheet = sheets.find((sheet) => sheet.name === '凭证')
  const voucherImportPath = voucherSheet ? join(outputDir, `凭证_${stamp}.xlsx`) : undefined

  if (insuranceImportPath) {
    const insuranceSheet = sheets.find((sheet) => sheet.name === '保险导入')
    if (insuranceSheet) writeWorkbook(insuranceImportPath, [{ ...insuranceSheet, name: 'Sheet1' }])
  }
  if (voucherImportPath && voucherSheet) {
    writeWorkbook(voucherImportPath, [voucherSheet])
  }
  if (payrollBackpayPath) {
    if (backpaySheet) {
      writeWorkbook(
        payrollBackpayPath,
        [
          backpaySheet,
          {
            name: '工资类别',
            columns: ['A'],
            showColumnHeader: false,
            rows: [['行政'], ['事业'], ['行政离休'], ['行政退休'], ['事业离休'], ['事业退休'], ['司法']]
          }
        ],
        'xls'
      )
    }
  }

  const outputMessages = [
    insuranceImportPath ? '保险导入文件' : '',
    payrollBackpayPath ? '补发工资文件' : '',
    voucherImportPath ? '凭证导入文件' : ''
  ].filter(Boolean)

  await persistMonthlyPayrollRun({
    year: period.year,
    month: period.month,
    unitFullName: unit.unitFullName,
    activeCount: salary.activePeople.length,
    survivorCount: salary.survivorPeople.length,
    salaryTotal: num(salary.active['应发工资合计']),
    withholdingTotal: num(salary.active['五险一金']),
    taxTotal: tax?.totalTax ?? num(salary.active['个税']) ?? 0,
    actualPay: roundMoney(
      num(salary.active['实发工资合计']) + num(salary.survivor['合计']) + retired.housing
    ),
    retiredHousing: retired.housing,
    sourceSalaryPath: input.salaryWorkbookPath ?? null,
    sourceSocialPath: input.socialSecurityWorkbookPath ?? null,
    sourceTaxPath: input.taxWorkbookPath ?? null,
    insuranceImportPath: insuranceImportPath ?? null,
    voucherImportPath: voucherImportPath ?? null,
    payrollBackpayPath: payrollBackpayPath ?? null,
    reportFingerprint,
    reportSnapshot: {
      ok: true,
      message: `已生成 ${sheets.length} 张报表预览${outputMessages.length ? `，并输出${outputMessages.join('、')}` : ''}`,
      insuranceImportPath,
      payrollBackpayPath,
      voucherImportPath,
      sheets
    }
  })

  return {
    ok: true,
    message: `已生成 ${sheets.length} 张报表预览${outputMessages.length ? `，并输出${outputMessages.join('、')}` : ''}`,
    insuranceImportPath,
    payrollBackpayPath,
    voucherImportPath,
    sheets
  }
}

type MonthlyPayrollRunInput = Omit<
  MonthlyPayrollRun,
  'id' | 'createdAt' | 'archivedAt' | 'archiveDir' | 'archiveManifest'
>

async function persistMonthlyPayrollRun(payload: MonthlyPayrollRunInput): Promise<void> {
  const database = await getDatabase()
  await run(
    database,
    `INSERT INTO monthly_payroll_runs (
      year, month, unit_full_name,
      active_count, survivor_count,
      salary_total, withholding_total, tax_total, actual_pay, retired_housing,
      source_salary_path, source_social_path, source_tax_path,
      insurance_import_path, voucher_import_path, payroll_backpay_path, report_fingerprint, report_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.year,
      payload.month,
      payload.unitFullName,
      payload.activeCount,
      payload.survivorCount,
      payload.salaryTotal,
      payload.withholdingTotal,
      payload.taxTotal,
      payload.actualPay,
      payload.retiredHousing,
      payload.sourceSalaryPath,
      payload.sourceSocialPath,
      payload.sourceTaxPath,
      payload.insuranceImportPath,
      payload.voucherImportPath,
      payload.payrollBackpayPath,
      payload.reportFingerprint,
      payload.reportSnapshot ? JSON.stringify(payload.reportSnapshot) : null
    ]
  )
}

export async function listMonthlyPayrollRuns(): Promise<MonthlyPayrollRun[]> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT id, year, month, unit_full_name, active_count, survivor_count,
      salary_total, withholding_total, tax_total, actual_pay, retired_housing,
      source_salary_path, source_social_path, source_tax_path,
      insurance_import_path, voucher_import_path, payroll_backpay_path,
      report_fingerprint, archived_at, archive_dir, archive_manifest, created_at
     FROM monthly_payroll_runs ORDER BY created_at DESC`
  )
  return rows.map(mapRunRow)
}

export async function archiveMonthlyPayrollRun(id: number): Promise<MonthlyPayrollArchiveResult> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  const runRow = rows[0]
  if (!runRow) throw new Error('未找到要月结的工资报账记录')

  const existingRun = mapRunRow(runRow)
  if (existingRun.archivedAt && existingRun.archiveDir) {
    return {
      run: existingRun,
      archiveDir: existingRun.archiveDir,
      files: existingRun.archiveManifest
    }
  }

  const archiveDir = monthlyPayrollArchiveDir(existingRun)
  mkdirSync(archiveDir, { recursive: true })
  const archiveDate = dateStamp()

  const archivedFiles = (
    await Promise.all([
      moveArchiveFile(existingRun.sourceSalaryPath, archiveDir, '工资表', archiveDate),
      moveArchiveFile(existingRun.sourceSocialPath, archiveDir, '社保', archiveDate),
      moveArchiveFile(existingRun.sourceTaxPath, archiveDir, '个税', archiveDate),
      copyArchiveFile(existingRun.insuranceImportPath, archiveDir, '保险导入', archiveDate),
      copyArchiveFile(existingRun.payrollBackpayPath, archiveDir, '补发工资', archiveDate),
      copyArchiveFile(existingRun.voucherImportPath, archiveDir, '凭证', archiveDate)
    ])
  ).filter((item): item is string => Boolean(item))

  const archivedAt = new Date().toISOString()
  const manifestPath = uniqueArchivePath(archiveDir, `月结清单_${archiveDate}.json`)
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        year: existingRun.year,
        month: existingRun.month,
        unitFullName: existingRun.unitFullName,
        archivedAt,
        archiveDir,
        files: archivedFiles,
        totals: {
          activeCount: existingRun.activeCount,
          survivorCount: existingRun.survivorCount,
          salaryTotal: existingRun.salaryTotal,
          withholdingTotal: existingRun.withholdingTotal,
          taxTotal: existingRun.taxTotal,
          actualPay: existingRun.actualPay,
          retiredHousing: existingRun.retiredHousing
        }
      },
      null,
      2
    ),
    'utf8'
  )
  archivedFiles.push(manifestPath)

  await run(
    database,
    `UPDATE monthly_payroll_runs
       SET archived_at = ?, archive_dir = ?, archive_manifest = ?
     WHERE id = ?`,
    [archivedAt, archiveDir, JSON.stringify(archivedFiles), id]
  )

  const updatedRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  return {
    run: mapRunRow(updatedRows[0]),
    archiveDir,
    files: archivedFiles
  }
}

export async function cancelMonthlyPayrollMonthClose(id: number): Promise<MonthlyPayrollRun> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  if (!rows[0]) throw new Error('未找到要取消月结的工资报账记录')
  const targetRun = mapRunRow(rows[0])
  const monthRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
     WHERE year = ? AND month = ? AND archived_at IS NOT NULL`,
    [targetRun.year, targetRun.month]
  )
  await restoreMonthlyPayrollSourceFiles(monthRows.map(mapRunRow))

  await run(
    database,
    `UPDATE monthly_payroll_runs
       SET archived_at = NULL, archive_dir = NULL, archive_manifest = NULL
     WHERE year = ? AND month = ?`,
    [targetRun.year, targetRun.month]
  )

  const updatedRows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  return mapRunRow(updatedRows[0])
}

export async function deleteMonthlyPayrollRun(id: number): Promise<boolean> {
  const database = await getDatabase()
  const rows = await all<{ id: number }>(
    database,
    `SELECT id FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  if (!rows.length) return false
  await run(database, `DELETE FROM monthly_payroll_runs WHERE id = ?`, [id])
  return true
}

export async function getMonthlyPayrollRunReport(
  id: number
): Promise<MonthlyPayrollReportResult | null> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs WHERE id = ? LIMIT 1`,
    [id]
  )
  const run = rows[0] ? mapRunRow(rows[0]) : null
  if (!run) return null
  if (run.reportSnapshot) return run.reportSnapshot

  const sheets = loadHistoryExportSheets(run)
  if (sheets.length === 0) return null
  return {
    ok: true,
    message: '该历史记录没有完整报表快照，已从已导出的文件恢复可查看表格',
    insuranceImportPath: run.insuranceImportPath ?? undefined,
    payrollBackpayPath: run.payrollBackpayPath ?? undefined,
    voucherImportPath: run.voucherImportPath ?? undefined,
    sheets
  }
}

function loadHistoryExportSheets(run: MonthlyPayrollRun): MonthlyPayrollReportSheet[] {
  const sheets: MonthlyPayrollReportSheet[] = []
  if (run.voucherImportPath) sheets.push(...readExportWorkbookSheets(run.voucherImportPath, '凭证'))
  if (run.insuranceImportPath) sheets.push(...readExportWorkbookSheets(run.insuranceImportPath, '保险导入'))
  if (run.payrollBackpayPath) sheets.push(...readExportWorkbookSheets(run.payrollBackpayPath, '补发工资'))
  return sheets
}

function readExportWorkbookSheets(filePath: string, fallbackName: string): MonthlyPayrollReportSheet[] {
  if (!existsSync(filePath)) return []
  try {
    const workbook = XLSX.readFile(filePath, { cellDates: false })
    return workbook.SheetNames.flatMap((name, index) => {
      const worksheet = workbook.Sheets[name]
      if (!worksheet) return []
      const rows = XLSX.utils.sheet_to_json<Array<string | number>>(worksheet, {
        header: 1,
        defval: '',
        raw: false
      })
      if (rows.length === 0) return []
      const columns = rows[0].map((cell, columnIndex) => text(cell) || columnLabel(columnIndex))
      return [{
        name: index === 0 ? fallbackName : name,
        columns,
        rows: rows.slice(1).map((row) => row.map((cell) => {
          const value = text(cell)
          const numberText = value.replace(/,/g, '')
          return /^-?\d+(\.\d+)?$/.test(numberText) ? Number(numberText) : value
        }))
      }]
    })
  } catch {
    return []
  }
}

function mapRunRow(row: Record<string, unknown>): MonthlyPayrollRun {
  return {
    id: Number(row.id),
    year: Number(row.year),
    month: Number(row.month),
    unitFullName: String(row.unit_full_name ?? ''),
    activeCount: Number(row.active_count ?? 0),
    survivorCount: Number(row.survivor_count ?? 0),
    salaryTotal: Number(row.salary_total ?? 0),
    withholdingTotal: Number(row.withholding_total ?? 0),
    taxTotal: Number(row.tax_total ?? 0),
    actualPay: Number(row.actual_pay ?? 0),
    retiredHousing: Number(row.retired_housing ?? 0),
    sourceSalaryPath: (row.source_salary_path as string) ?? null,
    sourceSocialPath: (row.source_social_path as string) ?? null,
    sourceTaxPath: (row.source_tax_path as string) ?? null,
    insuranceImportPath: (row.insurance_import_path as string) ?? null,
    voucherImportPath: (row.voucher_import_path as string) ?? null,
    payrollBackpayPath: (row.payroll_backpay_path as string) ?? null,
    reportFingerprint: (row.report_fingerprint as string) ?? null,
    archivedAt: (row.archived_at as string) ?? null,
    archiveDir: (row.archive_dir as string) ?? null,
    archiveManifest: parseArchiveManifest(row.archive_manifest),
    reportSnapshot: parseReportSnapshot(row.report_snapshot),
    createdAt: String(row.created_at ?? '')
  }
}

function parseArchiveManifest(value: unknown): string[] {
  if (!value || typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseReportSnapshot(value: unknown): MonthlyPayrollReportResult | null {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value) as MonthlyPayrollReportResult
  } catch {
    return null
  }
}

function resolvePayrollPeriod(input?: MonthlyPayrollWorkflowInput): { year: number; month: number } {
  const today = new Date()
  return {
    year: input?.year ?? today.getFullYear(),
    month: input?.month ?? today.getMonth() + 1
  }
}

async function isMonthlyPayrollMonthArchived(year: number, month: number): Promise<boolean> {
  const database = await getDatabase()
  const rows = await all<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count
       FROM monthly_payroll_runs
      WHERE year = ? AND month = ? AND archived_at IS NOT NULL`,
    [year, month]
  )
  return (rows[0]?.count ?? 0) > 0
}

function monthlyPayrollArchiveDir(run: MonthlyPayrollRun): string {
  const yearDir = join(monthlyPayrollArchiveRoot(), String(run.year))
  return join(yearDir, `${run.year}-${String(run.month).padStart(2, '0')}_工资报账月结`)
}

function monthlyPayrollArchiveRoot(): string {
  const candidates = [
    process.cwd(),
    dirname(process.cwd()),
    app.getAppPath(),
    dirname(app.getAppPath())
  ]
  const existing = candidates.find((candidate) => existsSync(join(candidate, '工资存档')))
  if (existing) return join(existing, '工资存档')

  const cwd = process.cwd()
  const workspaceRoot = basename(cwd).toLowerCase() === 'app' ? dirname(cwd) : cwd
  return join(workspaceRoot, '工资存档')
}

async function copyArchiveFile(
  sourcePath: string | null,
  targetDir: string,
  label: string,
  archiveDate: string
): Promise<string | null> {
  if (!sourcePath || !existsSync(sourcePath)) return null
  mkdirSync(targetDir, { recursive: true })
  const targetPath = uniqueArchivePath(targetDir, archiveFileName(label, archiveDate, sourcePath))
  await copyFile(sourcePath, targetPath)
  return targetPath
}

async function moveArchiveFile(
  sourcePath: string | null,
  targetDir: string,
  label: string,
  archiveDate: string
): Promise<string | null> {
  if (!sourcePath || !existsSync(sourcePath)) return null
  mkdirSync(targetDir, { recursive: true })
  const targetPath = uniqueArchivePath(targetDir, archiveFileName(label, archiveDate, sourcePath))
  try {
    await rename(sourcePath, targetPath)
  } catch {
    await copyFile(sourcePath, targetPath)
    await unlink(sourcePath)
  }
  return targetPath
}

function archiveFileName(label: string, archiveDate: string, sourcePath: string): string {
  return `${label}_${archiveDate}_${basename(sourcePath)}`
}

async function restoreMonthlyPayrollSourceFiles(runs: MonthlyPayrollRun[]): Promise<void> {
  const restoredTargets = new Set<string>()
  for (const run of runs) {
    await restoreArchiveSourceFile(run, run.sourceSalaryPath, '工资表', restoredTargets)
    await restoreArchiveSourceFile(run, run.sourceSocialPath, '社保', restoredTargets)
    await restoreArchiveSourceFile(run, run.sourceTaxPath, '个税', restoredTargets)
  }
}

async function restoreArchiveSourceFile(
  run: MonthlyPayrollRun,
  originalPath: string | null,
  label: string,
  restoredTargets: Set<string>
): Promise<void> {
  if (!originalPath || restoredTargets.has(originalPath) || existsSync(originalPath)) return
  const archivedPath = findArchivedSourcePath(run, originalPath, label)
  if (!archivedPath || !existsSync(archivedPath)) return

  mkdirSync(dirname(originalPath), { recursive: true })
  const targetPath = uniqueArchivePath(dirname(originalPath), basename(originalPath))
  try {
    await rename(archivedPath, targetPath)
  } catch {
    await copyFile(archivedPath, targetPath)
    await unlink(archivedPath)
  }
  restoredTargets.add(originalPath)
}

function findArchivedSourcePath(
  run: MonthlyPayrollRun,
  originalPath: string,
  label: string
): string | null {
  const originalName = basename(originalPath)
  const match = run.archiveManifest.find((filePath) => {
    const name = basename(filePath)
    return (
      name === `${label}_${originalName}` ||
      (name.startsWith(`${label}_`) && name.endsWith(`_${originalName}`))
    )
  })
  return match ?? null
}

function uniqueArchivePath(targetDir: string, fileName: string): string {
  let candidate = join(targetDir, fileName)
  if (!existsSync(candidate)) return candidate

  const dotIndex = fileName.lastIndexOf('.')
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : ''
  for (let index = 2; ; index += 1) {
    candidate = join(targetDir, `${stem}_${index}${extension}`)
    if (!existsSync(candidate)) return candidate
  }
}

const FINGERPRINT_SKIP_SHEETS = new Set(['一体化退休'])

function fingerprintReportSheets(sheets: MonthlyPayrollReportSheet[]): string {
  const stable = sheets
    .filter((sheet) => !FINGERPRINT_SKIP_SHEETS.has(sheet.name))
    .map((sheet) => ({
      name: sheet.name,
      columns: sheet.columns,
      rows: sheet.rows,
      showColumnHeader: sheet.showColumnHeader ?? true,
      merges: sheet.merges ?? [],
      columnWidths: sheet.columnWidths ?? [],
      rowHeights: sheet.rowHeights ?? []
    }))
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

async function findSameMonthlyPayrollRun(
  year: number,
  month: number,
  reportFingerprint: string
): Promise<MonthlyPayrollRun | null> {
  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(
    database,
    `SELECT * FROM monthly_payroll_runs
     WHERE year = ? AND month = ? AND report_fingerprint = ?
     ORDER BY created_at DESC LIMIT 1`,
    [year, month, reportFingerprint]
  )
  return rows[0] ? mapRunRow(rows[0]) : null
}

export async function parseSalaryWorkbook(filePath: string): Promise<SalarySummary> {
  const workbook = await readWorkbook(filePath)
  const activeSheet = workbook.Sheets['公办在职']
  if (!activeSheet) throw new Error('工资表缺少“公办在职”工作表')

  const survivorSheet = workbook.Sheets['遗补'] ?? workbook.Sheets['遗属补助']
  const activeRows = sheetToAoa(activeSheet)
  const survivorRows = survivorSheet ? sheetToAoa(survivorSheet) : []

  return {
    active: parseActiveSummary(activeRows),
    survivor: survivorRows.length ? parseSurvivorSummary(survivorRows) : {},
    activePeople: parseActivePeople(activeRows),
    survivorPeople: survivorRows.length ? parseSurvivorPeople(survivorRows) : []
  }
}

export async function parseSocialSecurityWorkbook(filePath: string): Promise<SocialSecuritySummary> {
  const workbook = await readWorkbook(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('社保文件没有可读取的工作表')

  const rows = sheetToAoa(sheet)
  const headerIndex = findSocialSecurityHeaderRow(rows)
  if (headerIndex < 0) throw new Error('社保文件缺少“征收品目/征收项目”或“应补（退）费额(元)”表头')

  const headers = rows[headerIndex].map((cell) => normalizeHeader(text(cell)))
  const itemIndexes = findSocialSecurityItemIndexes(headers)
  const amountIndex = findHeaderIndex(headers, [
    '应补（退）费额(元)',
    '应补(退)费额(元)',
    '应补（退）费额',
    '应补(退)费额',
    '应缴费额(元)',
    '应缴费额'
  ])
  if (itemIndexes.some((index) => index < 0) || amountIndex < 0) {
    throw new Error('社保文件缺少可识别的征收项目或金额列')
  }
  const byItem = new Map<string, number>()
  let rowCount = 0

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]
    const item = itemIndexes.map((itemIndex) => text(row[itemIndex])).filter(Boolean).join(' ')
    if (!item) continue
    byItem.set(item, roundMoney((byItem.get(item) ?? 0) + num(row[amountIndex])))
    rowCount += 1
  }

  return { byItem: Object.fromEntries(byItem), rowCount }
}

export async function parseTaxWorkbook(filePath: string): Promise<TaxSummary> {
  const workbook = await readWorkbook(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('个税文件没有可读取的工作表')

  const rows = sheetToAoa(sheet)
  const headerIndex = findHeaderRow(rows, ['姓名', '证件号码'])
  if (headerIndex < 0) throw new Error('个税文件缺少“姓名”或“证件号码”表头')

  const headers = rows[headerIndex].map((cell) => normalizeHeader(text(cell)))
  const nameIndex = headers.indexOf(normalizeHeader('姓名'))
  const idIndex = headers.indexOf(normalizeHeader('证件号码'))
  const amountIndex = findTaxAmountColumn(headers)
  const taxRows: TaxPerson[] = []
  const missingIdCards: TaxPerson[] = []

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]
    const taxAmount = num(row[amountIndex])
    if (taxAmount === 0) continue
    const item = {
      idCard: normalizeIdCard(row[idIndex]),
      name: text(row[nameIndex]),
      taxAmount: roundMoney(taxAmount),
      rowNumber: index + 1
    }
    taxRows.push(item)
    if (!item.idCard) missingIdCards.push(item)
  }

  return {
    totalTax: roundMoney(taxRows.reduce((sum, row) => sum + row.taxAmount, 0)),
    rows: taxRows,
    missingIdCards
  }
}

function parseActiveSummary(rows: CellValue[][]): Record<string, number> {
  const totalRow = findTotalRow(rows, 4)
  if (!totalRow) throw new Error('公办在职表未找到“合计”行')

  const result: Record<string, number> = {}
  activeSalaryFields.forEach((field, offset) => {
    result[field] = num(totalRow[5 + offset])
  })
  result['人数'] = num(totalRow[0])
  return result
}

function parseSurvivorSummary(rows: CellValue[][]): Record<string, number> {
  const totalRow = findTotalRow(rows, 4)
  if (!totalRow) throw new Error('遗补表未找到“合计”行')
  return {
    人数: num(totalRow[16]) || num(totalRow[0]),
    遗属补助: num(totalRow[17]),
    补发数: num(totalRow[18]),
    合计: num(totalRow[28])
  }
}

function parseActivePeople(rows: CellValue[][]): PayrollPerson[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => text(row[4]) && !text(row[4]).includes('合计') && isValidIdCard(row[2]))
    .map(({ row, index }) => ({
      idCard: normalizeIdCard(row[2]),
      name: text(row[4]),
      account: text(row[3]),
      rowNumber: index + 1,
      values: {
        岗位工资: num(row[5]),
        薪级工资: num(row[6]),
        岗位津贴: num(row[10]),
        生活补贴: num(row[11]),
        基本补发: num(row[7]),
        绩效补发: num(row[12]),
        基础性绩效工资: num(row[13]),
        '教（工）龄补贴': num(row[9]),
        乡镇补贴: num(row[14]),
        农村教师补贴: num(row[14]),
        住房补贴: num(row[16]),
        边远补贴: num(row[15]),
        边远乡镇补贴: num(row[15]),
        其他一: roundMoney(num(row[14]) + num(row[15])),
        交通费: num(row[17]),
        应发工资: num(row[18]),
        养老保险缴费: num(row[19]),
        职业年金缴费: num(row[20]),
        医疗保险: num(row[21]),
        失业保险: num(row[22]),
        公积金: num(row[23]),
        当月个人所得税: num(row[24]),
        代扣合计: num(row[27]),
        实发合计: num(row[28])
      }
    }))
}

function parseSurvivorPeople(rows: CellValue[][]): PayrollPerson[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => text(row[4]) && !text(row[4]).includes('合计') && isValidIdCard(row[2]))
    .map(({ row, index }) => ({
      idCard: normalizeIdCard(row[2]),
      name: text(row[4]),
      account: text(row[3]),
      rowNumber: index + 1,
      values: {
        人数: num(row[16]),
        遗属补助: num(row[17]),
        补发数: num(row[18]),
        应发工资小计: num(row[28]),
        实发合计: num(row[28])
      }
    }))
}

function buildReportSheets(
  salary: SalarySummary,
  socialSecurity: SocialSecuritySummary | undefined,
  tax: TaxSummary | undefined,
  retired: RetiredSummary = { count: 0, housing: 0 },
  unit: UnitSettings,
  integratedActiveHousingFund = 0,
  retiredHousingPeople: RetiredHousingPerson[] = []
): MonthlyPayrollReportSheet[] {
  const active = { ...salary.active }
  const survivor = salary.survivor
  const socialRows = socialSecurity
    ? Object.entries(socialSecurity.byItem).map(([item, amount]) => [item, amount] as [string, number])
    : []
  const socialTotal = roundMoney(socialRows.reduce((sum, [, amount]) => sum + amount, 0))
  const taxTotal = tax?.totalTax ?? 0
  active['住房公积金'] = resolveHousingFund(salary, integratedActiveHousingFund)
  active['个税'] = tax ? taxTotal : num(active['个税'])
  const salaryTotal = num(active['应发工资合计'])
  const survivorTotal = num(survivor['合计'])
  const retiredHousing = retired.housing
  const activeInsurance = num(active['五险一金'])
  const activeTax = num(active['个税'])
  const activeInsuranceWithoutTax = roundMoney(
    num(active['养老保险']) +
      num(active['职业年金']) +
      num(active['医保大病统筹']) +
      num(active['失业保险']) +
      num(active['住房公积金'])
  )
  const basicActual = roundMoney(num(active['应发基础工资']) - activeInsuranceWithoutTax)
  const salaryReimburseTotal = roundMoney(salaryTotal + survivorTotal + retiredHousing)
  const actualPay = roundMoney(num(active['实发工资合计']) + survivorTotal + retiredHousing)
  const withholdingTotal = activeInsurance
  const salaryBudgetTotal = roundMoney(
    num(active['应发基础工资']) +
      num(active['教龄津贴']) +
      num(active['乡镇补贴']) +
      num(active['边远乡镇补贴']) +
      num(active['住房补贴']) +
      num(active['基础性绩效'])
  )
  const salaryBudgetGrandTotal = roundMoney(salaryBudgetTotal + num(active['交通补贴']) + survivorTotal)
  const salaryBudgetActual = roundMoney(salaryBudgetGrandTotal - withholdingTotal)
  const insuranceVoucherTotal = roundMoney(socialTotal + activeTax + num(active['住房公积金']) * 2)
  const payrollMonth = `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`
  const today = new Date()
  const unitCode = text(unit.unitImportCode)
  const summaryMonth = `${today.getMonth() + 1}月份`
  const summaryUnitName = shortInsuranceSummaryUnitName(unit.unitFullName)

  const titleAuto = `${unit.unitFullName}${payrollMonth}工资发放汇总表`
  const subtitleLeft = '       （自动生成表）                单位：元'
  const subtitleRight = '（自动生成表）                            单位：元'
  const housing = num(active['住房补贴'])
  const teachingAge = num(active['教龄津贴'])
  const traffic = num(active['交通补贴'])
  const performance = num(active['基础性绩效'])
  const ruralTotal = roundMoney(num(active['乡镇补贴']) + num(active['边远乡镇补贴']))
  const middlePayBasicEtc = roundMoney(basicActual + teachingAge + housing + performance + activeInsurance)
  const middleBorrowTotal = roundMoney(
    middlePayBasicEtc + traffic + ruralTotal + survivorTotal + retiredHousing
  )
  const leftTotal = roundMoney(
    basicActual + teachingAge + traffic + performance + ruralTotal + housing + survivorTotal + retiredHousing
  )
  const payrollSummaryTitle = `${unit.unitFullName}${payrollMonth}工资发放汇总表`
  const payrollSummaryFooter = `本月应发：${formatVoucherAmount(salaryBudgetGrandTotal)}，  代扣未发：${formatVoucherAmount(withholdingTotal)}，  实发：${formatVoucherAmount(actualPay)}。`

  const sheets: MonthlyPayrollReportSheet[] = [
    {
      name: '自动生成',
      columns: gridColumns(12),
      showColumnHeader: false,
      columnWidths: [5.16, 16.5, 19.5, 27.75, 1.25, 26.5, 8.5, 7.5, 1.5, 26.5, 9, 9],
      rowHeights: [27, null, null, 21, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15],
      merges: ['A1:D1', 'F1:L1', 'C2:D2', 'F2:L2', 'F3:H3', 'J3:L3', 'I3:I19', 'A13:C13'],
      rows: [
        [titleAuto, '', '', '', '', titleAuto, '', '', '', '', '', ''],
        ['', '', subtitleLeft, '', '', subtitleRight, '', '', '', '', '', ''],
        ['', '', '', '', '', '财务会计', '', '', '', '预算会计', '', ''],
        ['序号', '项目', '账户', '金额', '', '项目', '借方金额', '贷方金额', '', '项目', '借方金额', '贷方金额'],
        [1, '基本工资', '其他应解汇款', basicActual, '', '付基本工资、津补贴、绩效等', middlePayBasicEtc, '', '', '付基本工资', basicActual, ''],
        [2, '教龄津贴、交通补贴', '其他应解汇款', roundMoney(teachingAge + traffic), '', '付交通补贴', traffic, '', '', '付教龄津贴', teachingAge, ''],
        [3, '基础性绩效', '其他应解汇款', performance, '', '付农村工作补贴(含边远)', ruralTotal, '', '', '付农村补贴（含边远）', ruralTotal, ''],
        [4, '乡镇补贴（含边远）', '其他应解汇款', ruralTotal, '', '付遗属补助发放', survivorTotal, '', '', '付住房补贴', housing, ''],
        [5, '住房补贴', '其他应解汇款', housing, '', '付退休人员房补', retiredHousing, '', '', '付绩效工资', performance, ''],
        [6, '遗属补助', '其他应解汇款', survivorTotal, '', '付合同教师工资', 0, '', '', '付交通补贴', traffic, ''],
        [7, '退休人员房补', '其他应解汇款', retiredHousing, '', '代扣养老保险', '', num(active['养老保险']), '', '付遗属补助', survivorTotal, ''],
        [8, '合同教师', '其他应解汇款', 0, '', '代扣职业年金', '', num(active['职业年金']), '', '付退休人员房补', retiredHousing, ''],
        ['合计：', '', '', leftTotal, '', '代扣医疗保险', '', num(active['医保大病统筹']), '', '付合同教师', 0, ''],
        ['', '', '', '', '', '代扣失业保险', '', num(active['失业保险']), '', '付工资', '', leftTotal],
        ['', '', '', '', '', '代扣住房公积金', '', num(active['住房公积金']), '', '', '', ''],
        ['', '', '', '', '', '代扣个人所得税', '', activeTax, '', '', '', ''],
        ['', '', '', '', '', '代扣"合同教师保险"', '', 0, '', '', '', ''],
        ['', '', '', '', '', '付工资', '', leftTotal, '', '', '', ''],
        ['', '', '', '', '', '合计', middleBorrowTotal, middleBorrowTotal, '', '合计', leftTotal, leftTotal]
      ]
    },
    {
      name: '工退遗汇总',
      columns: gridColumns(27),
      showColumnHeader: false,
      columnWidths: [4.5, 6.5, 4.5, 5.25, 3.5, 4.5, 4.5, 5.25, 6.5, 5.25, 4.5, 4.5, 4.5, 3.5, 3.5, 6.5, 4.5, 6.5, 6.5, 5.75, 5.75, 5.16, 4.5, 6.5, 7.25, 7.25, 7.5],
      rowHeights: [29.65, 17.25, 21, 21.75, 43.5, 44.25, 23],
      merges: [
        'A1:AA1',
        'A2:F2', 'Y2:AA2',
        'A3:A5', 'B3:B5', 'C3:Q3', 'R3:Y4', 'Z3:Z5', 'AA3:AA5',
        'C4:J4', 'K4:K5', 'L4:M4', 'N4:O4', 'P4:P5', 'Q4:Q5',
        'A7:AA7'
      ],
      rows: [
        [payrollSummaryTitle],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '单位：人、元 ', '', ''],
        ['序号', '学校', '财政补助支出', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '代    扣    款', '', '', '', '', '', '', '', '实发数', '退休房补'],
        ['', '', '在职人员', '', '', '', '', '', '', '', '交通\n补贴', '遗属补助', '', '民办合同', '', '其中在职补发数', '合   计', '', '', '', '', '', '', '', '', '', ''],
        ['', '', '人数', '基本\n工资', '教龄\n津贴', '农村\n补贴', '边远乡镇补贴', '住房\n补贴', '基础性\n绩效工资', '小计', '', '人数', '金额', '人数', '金额', '', '', '养老\n保险', '职业\n年金', '医保\n大病统筹', '失业\n保险 ', '住房\n公积金', '个税', '合同代扣"五险"', '小计', '', ''],
        [
          '',
          unit.unitFullName,
          salary.activePeople.length,
          num(active['应发基础工资']),
          teachingAge,
          num(active['乡镇补贴']),
          num(active['边远乡镇补贴']),
          housing,
          performance,
          salaryBudgetTotal,
          traffic,
          salary.survivorPeople.length,
          survivorTotal,
          0,
          0,
          0,
          salaryBudgetGrandTotal,
          num(active['养老保险']),
          num(active['职业年金']),
          num(active['医保大病统筹']),
          num(active['失业保险']),
          num(active['住房公积金']),
          activeTax,
          0,
          withholdingTotal,
          salaryBudgetActual,
          retiredHousing
        ],
        [payrollSummaryFooter]
      ]
    },
    {
      name: '报销凭证',
      columns: ['项目', '报账单位', '报销金额', '未报销金额', '实际付款金额', '支付令', '同城转账', '支付方式', '用途', '大写金额', '年', '月', '日', '未报销大写'],
      rows: [
        ...(socialSecurity
          ? [[
              '五险一金',
              unit.unitFullName,
              insuranceVoucherTotal,
              '',
              insuranceVoucherTotal,
              unitCode,
              '',
              '转账支票',
              buildInsuranceVoucherUsage(active, socialSecurity, activeTax, insuranceVoucherTotal),
              toChineseRmb(insuranceVoucherTotal),
              today.getFullYear(),
              today.getMonth() + 1,
              today.getDate(),
              ''
            ] as Array<string | number>]
          : []),
        [
          'C1工资遗补房补',
          unit.unitFullName,
          salaryReimburseTotal,
          activeInsurance,
          actualPay,
          unitCode,
          '',
          '转账支票',
          buildSalaryVoucherUsage(active, survivorTotal, retiredHousing, basicActual, activeInsurance, salaryReimburseTotal),
          toChineseRmb(salaryReimburseTotal),
          today.getFullYear(),
          today.getMonth() + 1,
          today.getDate(),
          toChineseRmb(activeInsurance)
        ]
      ]
    },
    {
      name: '补发工资',
      columns: [
        '证件号码',
        '月份',
        '姓名',
        '工资类别',
        '业务年度',
        '岗位工资',
        '薪级工资',
        '岗位津贴',
        '生活补贴',
        '绩效工资',
        '工作性津贴',
        '教（工）龄补贴',
        '特岗性津补贴',
        '交通费',
        '公车补贴',
        '住房补贴',
        '基础绩效奖',
        '补发工资',
        '补扣工资',
        '其他一',
        '其他二',
        '其他三',
        '当月个人所得税',
        '支出一'
      ],
      columnWidths: [20, 6, 10, 9, 10, 10, 10, 10, 10, 10, 11, 12, 12, 9, 9, 10, 11, 10, 10, 9, 9, 9, 13, 9],
      rows: buildBackpayRows(salary, tax)
    }
  ]

  const voucherSheet = buildVoucherSheet({
    unit,
    today,
    active,
    socialSecurity,
    activeTax,
    actualPay,
    basicActual,
    teachingAge: num(active['教龄津贴']),
    ruralTotal: roundMoney(num(active['乡镇补贴']) + num(active['边远乡镇补贴'])),
    housing: num(active['住房补贴']),
    performance: num(active['基础性绩效']),
    traffic: num(active['交通补贴']),
    survivorTotal,
    retiredHousing,
    salaryReimburseTotal,
    insuranceVoucherTotal,
    withholdingTotal,
    activeInsurance
  })
  sheets.splice(sheets.findIndex((s) => s.name === '报销凭证') + 1, 0, voucherSheet)

  if (socialSecurity) {
    const insurancePersonalPension = sumSocialByCanonicalName(socialSecurity, '养老保险个人')
    const insuranceUnitPension = sumSocialByCanonicalName(socialSecurity, '养老保险单位')
    const insurancePersonalAnnuity = sumSocialByCanonicalName(socialSecurity, '职业年金个人')
    const insuranceUnitAnnuity = sumSocialByCanonicalName(socialSecurity, '职业年金单位')
    const insurancePersonalMedical = sumSocialByCanonicalName(socialSecurity, '医保个人')
    const insuranceUnitMedical = sumSocialByCanonicalName(socialSecurity, '医保单位')
    const insuranceMaternity = sumSocialByCanonicalName(socialSecurity, '生育保险')
    const insurancePersonalUnemployment = sumSocialByCanonicalName(socialSecurity, '失业保险个人')
    const insuranceUnitUnemployment = roundMoney(
      sumSocialByCanonicalName(socialSecurity, '失业保险单位') +
        sumSocialByCanonicalName(socialSecurity, '工伤保险')
    )
    const titleInsurance = `${unit.unitFullName}${payrollMonth}五险一金明细`
    sheets.splice(1, 0, {
      name: '五险一金',
      columns: gridColumns(7),
      showColumnHeader: false,
      columnWidths: [25.75, 9.16, 8, 1.75, 26.25, 9.16, 9.16],
      rowHeights: [27, null, 22.5, 21, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      merges: ['A1:G1', 'A2:G2', 'A3:C3', 'E3:G3', 'D3:D21'],
      rows: [
        [titleInsurance, '', '', '', '', '', ''],
        [subtitleRight, '', '', '', '', '', ''],
        ['财务会计', '', '', '', '预算会计', '', ''],
        ['项目', '借方金额', '贷方金额', '', '项目', '借方金额', '贷方金额'],
        ['养老保险', roundMoney(insurancePersonalPension + insuranceUnitPension), '', '', '养老保险（个人）', insurancePersonalPension, ''],
        ['职业年金', roundMoney(insurancePersonalAnnuity + insuranceUnitAnnuity), '', '', '养老保险（单位）', insuranceUnitPension, ''],
        ['医保', roundMoney(insurancePersonalMedical + insuranceUnitMedical), '', '', '职业年金（个人）', insurancePersonalAnnuity, ''],
        ['生育保险', insuranceMaternity, '', '', '职业年金（单位）', insuranceUnitAnnuity, ''],
        ['工伤失业', roundMoney(insurancePersonalUnemployment + insuranceUnitUnemployment), '', '', '医保等（个人）', insurancePersonalMedical, ''],
        ['住房公积金（个人）', num(active['住房公积金']), '', '', '医保等（单位）', insuranceUnitMedical, ''],
        ['住房公积金（单位）', num(active['住房公积金']), '', '', '生育保险', insuranceMaternity, ''],
        ['个税', activeTax, '', '', '工伤失业（个人）', insurancePersonalUnemployment, ''],
        ['补缴养老保险', 0, '', '', '工伤失业（单位）', insuranceUnitUnemployment, ''],
        ['补缴职业年金', 0, '', '', '住房公积金（个人）', num(active['住房公积金']), ''],
        ['补缴医保、工伤失业等', 0, '', '', '住房公积金（单位）', num(active['住房公积金']), ''],
        ['付五险一金、个税等（零余额）', '', roundMoney(insuranceVoucherTotal), '', '个税', activeTax, ''],
        ['付补交各类保险等（9674银行存款）', '', 0, '', '补缴养老保险', 0, ''],
        ['', '', '', '', '补缴职业年金', 0, ''],
        ['', '', '', '', '补缴医保、工伤失业等', 0, ''],
        ['', '', '', '', '付五险一金、个税等（零余额）', '', insuranceVoucherTotal],
        ['', '', '', '', '付补交各类保险等（9674银行存款）', '', 0]
      ]
    })
    sheets.push({
      name: '保险导入',
      columns: [
        '*单位代码',
        '*单位名称',
        '*部门经济科目代码',
        '*部门经济科目名称',
        '摘要',
        '*金额',
        '*收款账户名称',
        '*收款账户开户行',
        '*收款账户账号',
        '经办人',
        '审核人',
        '支付业务类型',
        '确认不是政府采购项目支付'
      ],
      columnWidths: [12, 18, 14, 18, 28, 12, 22, 22, 22, 10, 10, 14, 22],
      rows: buildInsuranceImportItems(socialSecurity, active, activeTax).map(([item, amount]) => {
        const isHousing = item.includes('公积金')
        const economicSubject = departmentEconomicSubjectForSocialItem(item)
        return [
          unitCode,
          unit.unitFullName,
          economicSubject.code,
          economicSubject.name,
          `${summaryUnitName}${summaryMonth}${item}`,
          amount,
          isHousing ? unit.housingPayeeName : unit.socialPayeeName,
          isHousing ? unit.housingPayeeBank : unit.socialPayeeBank,
          isHousing ? unit.housingPayeeAccount : unit.socialPayeeAccount,
          '',
          '',
          '',
          '是'
        ]
      })
    })
  }

  if (retiredHousingPeople.length > 0) {
    const integratedTitle = `${unit.unitFullName}${payrollMonth}一体化退休`
    const integratedRows = retiredHousingPeople.map((row, index) => [
      index + 1,
      row.name,
      row.idCard,
      row.housing,
      row.backpay,
      row.payable,
      row.actualPay
    ])
    const integratedSums = {
      housing: roundMoney(retiredHousingPeople.reduce((s, r) => s + r.housing, 0)),
      backpay: roundMoney(retiredHousingPeople.reduce((s, r) => s + r.backpay, 0)),
      payable: roundMoney(retiredHousingPeople.reduce((s, r) => s + r.payable, 0)),
      actualPay: roundMoney(retiredHousingPeople.reduce((s, r) => s + r.actualPay, 0))
    }
    sheets.push({
      name: '一体化退休',
      columns: gridColumns(7),
      showColumnHeader: false,
      columnWidths: [6, 12, 22, 12, 12, 14, 14],
      merges: ['A1:G1'],
      rows: [
        [integratedTitle, '', '', '', '', '', ''],
        ['序号', '姓名', '证件号码', '住房补贴', '补发工资', '应发工资小计', '实发合计'],
        ...integratedRows,
        ['合计', '', '', integratedSums.housing, integratedSums.backpay, integratedSums.payable, integratedSums.actualPay]
      ]
    })
  }

  return sheets
}

function buildBackpayRows(
  salary: SalarySummary,
  tax: TaxSummary | undefined
): Array<Array<string | number>> {
  const year = new Date().getFullYear()
  const month = new Date().getMonth() + 1
  const rowsById = new Map<string, Array<string | number>>()
  const rowsWithoutId: Array<Array<string | number>> = []

  const ensureRow = (idCard: string, name: string): Array<string | number> => {
    const key = normalizeIdCard(idCard)
    const existing = rowsById.get(key)
    if (existing) return existing
    const row = createBackpayRow(key, name, year, month)
    rowsById.set(key, row)
    return row
  }

  for (const person of salary.activePeople) {
    const basicBackpay = num(person.values['基本补发'])
    const performanceBackpay = num(person.values['绩效补发'])
    if (basicBackpay === 0 && performanceBackpay === 0) continue
    const row = ensureRow(person.idCard, person.name)
    row[5] = roundMoney(num(row[5]) + basicBackpay)
    row[6] = roundMoney(num(row[6]) + performanceBackpay)
  }

  for (const item of tax?.rows ?? []) {
    const taxBackpay = -item.taxAmount
    if (!item.idCard) {
      const row = createBackpayRow('', item.name, year, month)
      row[5] = taxBackpay
      rowsWithoutId.push(row)
      continue
    }
    const row = ensureRow(item.idCard, item.name)
    row[5] = roundMoney(num(row[5]) + taxBackpay)
  }

  return [...rowsById.values(), ...rowsWithoutId].filter(
    (row) => num(row[5]) !== 0 || num(row[6]) !== 0
  )
}

function createBackpayRow(
  idCard: string,
  name: string,
  year: number,
  month: number
): Array<string | number> {
  return [
    idCard,
    month,
    name,
    '事业',
    year,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    ''
  ]
}

function resolveHousingFund(salary: SalarySummary, integratedActiveHousingFund: number): number {
  const peopleTotal = roundMoney(
    salary.activePeople.reduce((sum, person) => sum + num(person.values['公积金']), 0)
  )
  return peopleTotal || num(salary.active['住房公积金']) || roundMoney(integratedActiveHousingFund)
}

function shortInsuranceSummaryUnitName(unitFullName: string): string {
  return text(unitFullName).replace(/^沭阳县/, '')
}

function buildInsuranceImportItems(
  socialSecurity: SocialSecuritySummary,
  active: Record<string, number>,
  activeTax: number
): Array<[string, number]> {
  const housingFund = num(active['住房公积金'])
  const socialPersonal = socialPersonalInsuranceTotals(socialSecurity)
  return [
    ['养老保险个人', socialPersonal.pension],
    ['养老保险单位', sumSocialByCanonicalName(socialSecurity, '养老保险单位')],
    ['职业年金个人', socialPersonal.annuity],
    ['职业年金单位', sumSocialByCanonicalName(socialSecurity, '职业年金单位')],
    ['医保个人', socialPersonal.medical],
    ['医保单位', sumSocialByCanonicalName(socialSecurity, '医保单位')],
    ['生育保险', sumSocialByCanonicalName(socialSecurity, '生育保险')],
    ['失业保险个人', socialPersonal.unemployment],
    ['失业保险单位', sumSocialByCanonicalName(socialSecurity, '失业保险单位')],
    ['工伤保险', sumSocialByCanonicalName(socialSecurity, '工伤保险')],
    ['住房公积金个人', housingFund],
    ['住房公积金单位', housingFund],
    ['个人所得税', activeTax]
  ].filter(([, amount]) => num(amount) !== 0) as Array<[string, number]>
}

function buildPersonalInsuranceCheck(
  socialSecurity: SocialSecuritySummary | undefined,
  salary: SalarySummary,
  integrated: PersonalInsuranceTotals
): { messages: string[]; warnings: string[] } {
  if (!socialSecurity) return { messages: [], warnings: [] }
  const social = socialPersonalInsuranceTotals(socialSecurity)
  const salaryTotals = salaryPersonalInsuranceTotals(salary)
  const salaryDiffs = diffPersonalInsuranceTotals(social, salaryTotals, '工资表')
  const integratedDiffs = diffPersonalInsuranceTotals(social, integrated, '一体化在职')
  const messages = [
    `个人四险核对：社保文件四项合计 ${formatMoney(social.total)}，工资表 ${formatMoney(salaryTotals.total)}，一体化在职 ${formatMoney(integrated.total)}`
  ]
  const warnings = [
    ...(salaryDiffs.length ? [`社保个人四险与工资表不一致：${salaryDiffs.join('；')}`] : []),
    ...(integratedDiffs.length ? [`社保个人四险与一体化在职不一致：${integratedDiffs.join('；')}`] : [])
  ]
  if (warnings.length === 0) messages.push('个人四险核对：社保文件、工资表、一体化在职金额一致')
  return { messages, warnings }
}

function socialPersonalInsuranceTotals(socialSecurity: SocialSecuritySummary): PersonalInsuranceTotals {
  return personalInsuranceTotals({
    pension: sumSocialByCanonicalName(socialSecurity, '养老保险个人'),
    annuity: sumSocialByCanonicalName(socialSecurity, '职业年金个人'),
    medical: sumSocialByCanonicalName(socialSecurity, '医保个人'),
    unemployment: sumSocialByCanonicalName(socialSecurity, '失业保险个人')
  })
}

function salaryPersonalInsuranceTotals(salary: SalarySummary): PersonalInsuranceTotals {
  return personalInsuranceTotals({
    pension: num(salary.active['养老保险']),
    annuity: num(salary.active['职业年金']),
    medical: num(salary.active['医保大病统筹']),
    unemployment: num(salary.active['失业保险'])
  })
}

function personalInsuranceTotals(
  values: Omit<PersonalInsuranceTotals, 'total'>
): PersonalInsuranceTotals {
  return {
    ...values,
    total: roundMoney(values.pension + values.annuity + values.medical + values.unemployment)
  }
}

function diffPersonalInsuranceTotals(
  social: PersonalInsuranceTotals,
  target: PersonalInsuranceTotals,
  targetName: string
): string[] {
  const items: Array<[keyof PersonalInsuranceTotals, string]> = [
    ['pension', '养老保险个人'],
    ['annuity', '职业年金个人'],
    ['medical', '医保个人'],
    ['unemployment', '失业保险个人'],
    ['total', '四项合计']
  ]
  return items.flatMap(([key, label]) => {
    const difference = roundMoney(social[key] - target[key])
    if (Math.abs(difference) < 0.01) return []
    return `${label} 社保=${formatMoney(social[key])} / ${targetName}=${formatMoney(target[key])} / 差额=${formatMoney(difference)}`
  })
}

function sumSocialByAnyKeywordGroups(
  socialSecurity: SocialSecuritySummary,
  keywordGroups: string[][]
): number {
  const groups = keywordGroups.map((group) => group.map((item) => item.replace(/\s+/g, '')))
  return roundMoney(
    Object.entries(socialSecurity.byItem).reduce((sum, [item, amount]) => {
      const normalized = item.replace(/\s+/g, '')
      if (groups.some((group) => group.every((keyword) => normalized.includes(keyword)))) {
        return sum + amount
      }
      return sum
    }, 0)
  )
}

function sumSocialByCanonicalName(
  socialSecurity: SocialSecuritySummary,
  canonicalName: string
): number {
  return roundMoney(
    Object.entries(socialSecurity.byItem).reduce((sum, [item, amount]) => {
      return canonicalInsuranceItemName(item) === canonicalName ? sum + amount : sum
    }, 0)
  )
}

function canonicalInsuranceItemName(item: string): string {
  const normalized = item.replace(/\s+/g, '')
  const candidates: Array<[string[], string]> = [
    [['养老', '个人'], '养老保险个人'],
    [['养老', '单位'], '养老保险单位'],
    [['职业年金', '个人'], '职业年金个人'],
    [['职业年金', '单位'], '职业年金单位'],
    [['生育'], '生育保险'],
    [['医疗', '个人'], '医保个人'],
    [['医保', '个人'], '医保个人'],
    [['医疗', '单位'], '医保单位'],
    [['医保', '单位'], '医保单位'],
    [['失业', '个人'], '失业保险个人'],
    [['失业', '单位'], '失业保险单位'],
    [['工伤'], '工伤保险'],
    [['公积金', '个人'], '住房公积金个人'],
    [['公积金', '单位'], '住房公积金单位'],
    [['个人所得税'], '个人所得税'],
    [['个税'], '个人所得税']
  ]
  return candidates.find(([keywords]) => keywords.every((keyword) => normalized.includes(keyword)))?.[1] ?? item
}

const VOUCHER_COLUMNS = [
  '凭证日期', '凭证类型', '凭证号', '会计科目编码', '会计科目名称', '借方金额', '贷方金额',
  '摘要', '附件数', '结算号', '辅助摘要', '往来编码', '往来名称', '预算项目编码', '预算项目名称',
  '部门编码', '部门名称', '支出功能分类编码', '支出功能分类名称', '收入功能分类（账务）编码',
  '收入功能分类（账务）名称', '基建项目编码', '基建项目名称', 'PPP项目编码', 'PPP项目名称',
  '资金性质编码', '资金性质名称', '往来时间编码', '往来时间名称', '投资对象编码', '投资对象名称',
  '物品各类编码', '物品各类名称', '开户银行编码', '开户银行名称', '费用用途编码', '费用用途名称',
  '差异项编码', '差异项名称', '资金往来对象类别编码', '资金往来对象类别名称', '收款账户编码',
  '收款账户名称', '收款人名称编码', '收款人名称名称', '项目类别编码', '项目类别名称',
  '单位核算自建项目编码', '单位核算自建项目名称', '部门支出经济分类（账务）编码',
  '部门支出经济分类（账务）名称'
]

type VoucherInput = {
  unit: UnitSettings
  today: Date
  active: Record<string, number>
  socialSecurity?: SocialSecuritySummary
  activeTax: number
  actualPay: number
  basicActual: number
  teachingAge: number
  ruralTotal: number
  housing: number
  performance: number
  traffic: number
  survivorTotal: number
  retiredHousing: number
  salaryReimburseTotal: number
  insuranceVoucherTotal: number
  withholdingTotal: number
  activeInsurance: number
}

type VoucherEntry = {
  voucherNo: '1' | '2'
  subjectCode: string
  subjectName: string
  debit?: number
  credit?: number
  summary: string
  partyCode?: string | number
  partyName?: string
  budgetCode?: string
  budgetName?: string
  functionCode?: string
  functionName?: string
  fundCode?: string
  fundName?: string
  econCode?: string
  econName?: string
  hasDifference?: boolean
}

function lastDayOfPayrollMonth(today: Date): Date {
  return new Date(today.getFullYear(), today.getMonth() + 1, 0)
}

function buildVoucherSheet(input: VoucherInput): MonthlyPayrollReportSheet {
  const { unit, today, active, socialSecurity, activeTax } = input
  const date = lastDayOfPayrollMonth(today)
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

  const insurancePersonalPension = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '养老保险个人') : 0
  const insuranceUnitPension = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '养老保险单位') : 0
  const insurancePersonalAnnuity = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '职业年金个人') : 0
  const insuranceUnitAnnuity = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '职业年金单位') : 0
  const insurancePersonalMedical = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '医保个人') : 0
  const insuranceUnitMedical = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '医保单位') : 0
  const insuranceMaternity = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '生育保险') : 0
  const insurancePersonalUnemployment = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '失业保险个人') : 0
  const insuranceUnitUnemployment = socialSecurity
    ? roundMoney(
        sumSocialByCanonicalName(socialSecurity, '工伤保险') +
          sumSocialByCanonicalName(socialSecurity, '失业保险单位')
      )
    : 0
  const housingFund = num(active['住房公积金'])

  const entries: VoucherEntry[] = [
    // 凭证 1：本月工资发放
    { voucherNo: '1', subjectCode: '500101', subjectName: '工资福利费用', debit: roundMoney(input.basicActual + input.teachingAge + input.housing + input.performance + input.activeInsurance), summary: '本月工资', hasDifference: true },
    { voucherNo: '1', subjectCode: '500101', subjectName: '工资福利费用', debit: input.ruralTotal, summary: '农村补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '500101', subjectName: '工资福利费用', debit: input.traffic, summary: '交通补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '500103', subjectName: '对个人和家庭的补助费用', debit: input.survivorTotal, summary: '遗补', hasDifference: true },
    { voucherNo: '1', subjectCode: '500103', subjectName: '对个人和家庭的补助费用', debit: input.retiredHousing, summary: '退休房补', hasDifference: true },
    { voucherNo: '1', subjectCode: '400101', subjectName: '一般公共预算财政拨款', credit: input.actualPay, summary: '本月工资', hasDifference: true },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: num(active['养老保险']), summary: '代扣养老保险', partyCode: '999', partyName: '新养老保险' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: num(active['职业年金']), summary: '代扣职业年金', partyCode: '998', partyName: '新职业年金' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: num(active['医保大病统筹']), summary: '代扣医疗保险', partyCode: '997', partyName: '新四险' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: num(active['失业保险']), summary: '代扣失业保险', partyCode: '997', partyName: '新四险' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: housingFund, summary: '代扣住房公积金', partyCode: '996', partyName: '扣住房公积金' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: activeTax, summary: '代扣个人所得税', partyCode: 994, partyName: '扣个人所得税' },
    // 平行预算会计 (在职工资)
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.basicActual, summary: '基本工资', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.teachingAge, summary: '教龄津贴', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30102', econName: '津贴补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.ruralTotal, summary: '农村补贴', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30102', econName: '其他对个人和家庭的补助', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.housing, summary: '住房补贴', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30102', econName: '津贴补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.performance, summary: '绩效工资', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30107', econName: '绩效工资', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.traffic, summary: '交通补贴', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30102', econName: '津贴补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.survivorTotal, summary: '遗补', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30305', econName: '生活补助', hasDifference: true },
    { voucherNo: '1', subjectCode: '60010101', subjectName: '财政拨款预算收入', credit: roundMoney(input.basicActual + input.teachingAge + input.ruralTotal + input.housing + input.performance + input.traffic + input.survivorTotal), summary: '本月工资', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', hasDifference: true },
    // 平行预算会计 (退休房补)
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.retiredHousing, summary: '退休房补', budgetCode: unit.budgetRetiredCode, budgetName: '人员支出', functionCode: unit.retiredFunctionCode, functionName: unit.retiredFunctionName, fundCode: '111', fundName: '一般公共预算资金', econCode: '30302', econName: '退休费', hasDifference: true },
    { voucherNo: '1', subjectCode: '60010101', subjectName: '财政拨款预算收入', credit: input.retiredHousing, summary: '退休房补', budgetCode: unit.budgetRetiredCode, budgetName: '人员支出', functionCode: unit.retiredFunctionCode, functionName: unit.retiredFunctionName, fundCode: '111', fundName: '一般公共预算资金', hasDifference: true }
  ]

  if (socialSecurity) {
    entries.push(
    // 凭证 2：五险一金缴纳
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: insurancePersonalPension, summary: '养老保险（个人）', partyCode: '999', partyName: '新养老保险' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceUnitPension, summary: '养老保险（单位）', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: insurancePersonalAnnuity, summary: '职业年金（个人）', partyCode: '998', partyName: '新职业年金' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceUnitAnnuity, summary: '职业年金（单位）', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: insurancePersonalMedical, summary: '医保（个人）', partyCode: '997', partyName: '新四险' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceUnitMedical, summary: '医保（单位）', hasDifference: true },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceMaternity, summary: '生育保险', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: insurancePersonalUnemployment, summary: '工伤失业（个人）', partyCode: '997', partyName: '新四险' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceUnitUnemployment, summary: '工伤失业(单位)', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: housingFund, summary: '住房公积金（个人）', partyCode: '996', partyName: '扣住房公积金' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: housingFund, summary: '住房公积金（单位）', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: activeTax, summary: '个人所得税', partyCode: 994, partyName: '扣个人所得税' },
    { voucherNo: '2', subjectCode: '400101', subjectName: '一般公共预算财政拨款', credit: input.insuranceVoucherTotal, summary: '五险一金、个税等', hasDifference: true },
    // 平行预算会计
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insurancePersonalPension, summary: '养老保险（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceUnitPension, summary: '养老保险（单位）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30108', econName: '机关事业单位基本养老保险缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insurancePersonalAnnuity, summary: '职业年金（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceUnitAnnuity, summary: '职业年金（单位）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30109', econName: '职业年金缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insurancePersonalMedical, summary: '医保（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceUnitMedical, summary: '医保（单位）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30110', econName: '职工基本医疗保险缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceMaternity, summary: '生育保险', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30110', econName: '职工基本医疗保险缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insurancePersonalUnemployment, summary: '工伤失业（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceUnitUnemployment, summary: '工伤失业(单位)', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30112', econName: '其他社会保障缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: housingFund, summary: '住房公积金（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: housingFund, summary: '住房公积金（单位）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30113', econName: '住房公积金', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: activeTax, summary: '个人所得税', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '60010101', subjectName: '财政拨款预算收入', credit: input.insuranceVoucherTotal, summary: '五险一金、个税等', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', hasDifference: true }
    )
  }

  const rows = entries.map((e) => voucherRow(e, dateStr))
  return { name: '凭证', columns: VOUCHER_COLUMNS, rows }
}

function voucherRow(e: VoucherEntry, dateStr: string): Array<string | number> {
  const row: Array<string | number> = new Array(VOUCHER_COLUMNS.length).fill('')
  row[0] = dateStr
  row[1] = '记账'
  row[2] = e.voucherNo
  row[3] = e.subjectCode
  row[4] = e.subjectName
  row[5] = e.debit ?? 0
  row[6] = e.credit ?? 0
  row[7] = e.summary
  row[8] = e.voucherNo === '1' ? 14 : 5
  row[9] = ''
  row[10] = e.summary
  if (e.partyCode !== undefined) row[11] = e.partyCode
  if (e.partyName) row[12] = e.partyName
  if (e.budgetCode) row[13] = e.budgetCode
  if (e.budgetName) row[14] = e.budgetName
  if (e.functionCode) row[17] = e.functionCode
  if (e.functionName) row[18] = e.functionName
  if (e.fundCode) row[25] = e.fundCode
  if (e.fundName) row[26] = e.fundName
  if (e.hasDifference) {
    row[37] = '0'
    row[38] = '无差异'
  }
  if (e.econCode) row[49] = e.econCode
  if (e.econName) row[50] = e.econName
  return row
}

function writeWorkbook(
  filePath: string,
  sheets: MonthlyPayrollReportSheet[],
  bookType: XLSX.BookType = 'xlsx'
): void {
  const workbook = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const data = sheet.showColumnHeader === false ? sheet.rows : [sheet.columns, ...sheet.rows]
    const worksheet = XLSX.utils.aoa_to_sheet(data)
    XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName(sheet.name))
  }
  writeFileSync(filePath, XLSX.write(workbook, { bookType, type: 'buffer' }))
}

async function loadRetiredSummary(): Promise<RetiredSummary> {
  try {
    const worksheet = getWorksheetByName('一体化退休')
    const columns = getWorksheetLocalColumns(worksheet)
    const idColumn = columns.find((column) => column.field.name === '证件号码')?.columnName
    const housingColumn = columns.find((column) => column.field.name === '住房补贴')?.columnName
    if (!idColumn || !housingColumn) return { count: 0, housing: 0 }
    const database = await getDatabase()
    const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
    const latestById = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const idCard = normalizeIdCard(row[idColumn])
      if (!isValidIdCard(idCard)) continue
      const previous = latestById.get(idCard)
      if (!previous || num(row.id) > num(previous.id)) latestById.set(idCard, row)
    }
    const latest = Array.from(latestById.values())
    return {
      count: latest.length,
      housing: roundMoney(latest.reduce((sum, row) => sum + num(row[housingColumn]), 0))
    }
  } catch {
    return { count: 0, housing: 0 }
  }
}

async function loadRetiredHousingDetails(): Promise<RetiredHousingPerson[]> {
  try {
    const worksheet = getWorksheetByName('一体化退休')
    const columns = getWorksheetLocalColumns(worksheet)
    const colByName = (name: string): string | undefined =>
      columns.find((column) => column.field.name === name)?.columnName
    const idColumn = colByName('证件号码')
    const nameColumn = colByName('姓名')
    const unitColumn = colByName('单位名称')
    const housingColumn = colByName('住房补贴')
    const backpayColumn = colByName('补发工资')
    const payableColumn = colByName('应发工资小计')
    const actualPayColumn = colByName('实发合计')
    if (!idColumn || !housingColumn) return []
    const database = await getDatabase()
    const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
    const latestById = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const idCard = normalizeIdCard(row[idColumn])
      if (!isValidIdCard(idCard)) continue
      const previous = latestById.get(idCard)
      if (!previous || num(row.id) > num(previous.id)) latestById.set(idCard, row)
    }
    return Array.from(latestById.values()).map((row) => ({
      name: nameColumn ? text(row[nameColumn]) : '',
      idCard: normalizeIdCard(row[idColumn]),
      unitName: unitColumn ? text(row[unitColumn]) : '',
      housing: roundMoney(num(row[housingColumn])),
      backpay: roundMoney(backpayColumn ? num(row[backpayColumn]) : 0),
      payable: roundMoney(payableColumn ? num(row[payableColumn]) : 0),
      actualPay: roundMoney(actualPayColumn ? num(row[actualPayColumn]) : 0)
    }))
  } catch {
    return []
  }
}

async function loadIntegratedActiveHousingFund(): Promise<number> {
  try {
    const rows = await loadIntegratedRows('一体化在职')
    return roundMoney(rows.reduce((sum, row) => sum + num(row.values['公积金']), 0))
  } catch {
    return 0
  }
}

async function loadIntegratedActivePersonalInsuranceTotals(): Promise<PersonalInsuranceTotals> {
  try {
    const rows = await loadIntegratedRows('一体化在职')
    return personalInsuranceTotals({
      pension: roundMoney(rows.reduce((sum, row) => sum + num(row.values['养老保险缴费']), 0)),
      annuity: roundMoney(rows.reduce((sum, row) => sum + num(row.values['职业年金缴费']), 0)),
      medical: roundMoney(rows.reduce((sum, row) => sum + num(row.values['医疗保险']), 0)),
      unemployment: roundMoney(rows.reduce((sum, row) => sum + num(row.values['失业保险']), 0))
    })
  } catch {
    return personalInsuranceTotals({
      pension: 0,
      annuity: 0,
      medical: 0,
      unemployment: 0
    })
  }
}

function gridColumns(count: number): string[] {
  return Array.from({ length: count }, (_, index) => columnLabel(index))
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

function sumSocialByKeyword(
  socialSecurity: SocialSecuritySummary,
  keywordGroups: string[]
): number {
  const keywords = keywordGroups.map((item) => item.replace(/\s+/g, ''))
  return roundMoney(
    Object.entries(socialSecurity.byItem).reduce((sum, [item, amount]) => {
      const normalized = item.replace(/\s+/g, '')
      if (keywords.every((keyword) => normalized.includes(keyword))) return sum + amount
      return sum
    }, 0)
  )
}

function departmentEconomicSubjectForSocialItem(item: string): { code: string; name: string } {
  const normalized = canonicalInsuranceItemName(item).replace(/\s+/g, '')
  const isPersonal = normalized.includes('个人')
  if (isPersonal) return { code: '30101', name: '基本工资' }
  if (normalized.includes('公积金')) return { code: '30113', name: '住房公积金' }
  if (normalized.includes('职业年金')) return { code: '30109', name: '职业年金缴费' }
  if (normalized.includes('养老')) return { code: '30108', name: '机关事业单位基本养老保险缴费' }
  if (normalized.includes('医疗') || normalized.includes('医保') || normalized.includes('大额') || normalized.includes('生育')) {
    return { code: '30110', name: '职工基本医疗保险缴费' }
  }
  if (normalized.includes('失业') || normalized.includes('工伤')) {
    return { code: '30112', name: '其他社会保障缴费' }
  }
  return { code: '', name: item }
}

function buildInsuranceVoucherUsage(
  active: Record<string, number>,
  socialSecurity: SocialSecuritySummary | undefined,
  activeTax: number,
  total: number
): string {
  const social = socialSecurity ?? { byItem: {}, rowCount: 0 }
  return [
    ['职业年金（单位）', sumSocialByCanonicalName(social, '职业年金单位')],
    ['职业年金（个人）', sumSocialByCanonicalName(social, '职业年金个人')],
    ['养老保险费（单位）', sumSocialByCanonicalName(social, '养老保险单位')],
    ['养老保险费（个人）', sumSocialByCanonicalName(social, '养老保险个人')],
    ['医疗保险（个人）', sumSocialByCanonicalName(social, '医保个人')],
    ['医疗保险（单位）', sumSocialByCanonicalName(social, '医保单位')],
    ['生育保险', sumSocialByCanonicalName(social, '生育保险')],
    ['失业保险（单位）', sumSocialByCanonicalName(social, '失业保险单位')],
    ['失业保险（个人）', sumSocialByCanonicalName(social, '失业保险个人')],
    ['工伤保险', sumSocialByCanonicalName(social, '工伤保险')],
    ['公积金（个人）', num(active['住房公积金'])],
    ['公积金（单位）', num(active['住房公积金'])],
    ['个税', activeTax],
    ['合计', total],
    ['补缴养老保险', 0],
    ['补缴职业年金', 0],
    ['补缴医保、工伤失业等', 0]
  ].map(([label, amount]) => `${label}${formatVoucherAmount(Number(amount))}`).join('\n')
}

function buildSalaryVoucherUsage(
  active: Record<string, number>,
  survivorTotal: number,
  retiredHousing: number,
  basicActual: number,
  activeInsurance: number,
  total: number
): string {
  return [
    ['退休房补', retiredHousing],
    ['遗属补助', survivorTotal],
    ['基本工资', basicActual],
    ['基础性绩效', num(active['基础性绩效'])],
    ['农村教师补贴', num(active['乡镇补贴'])],
    ['边远补贴', num(active['边远乡镇补贴'])],
    ['交通补贴', num(active['交通补贴'])],
    ['教龄津贴', num(active['教龄津贴'])],
    ['住房补贴', num(active['住房补贴'])],
    ['五险一金', activeInsurance],
    ['合计', total]
  ].map(([label, amount]) => `${label}${formatVoucherAmount(Number(amount))}`).join('\n')
}

function formatVoucherAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : formatMoney(value).replace(/,/g, '')
}

function toChineseRmb(value: number): string {
  if (value === 0) return '零元整'
  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const units = ['', '拾', '佰', '仟']
  const bigUnits = ['', '万', '亿', '兆']
  const integer = Math.floor(Math.abs(value))
  const cents = Math.round((Math.abs(value) - integer) * 100)
  const integerText = integerToChinese(integer, digits, units, bigUnits)
  const jiao = Math.floor(cents / 10)
  const fen = cents % 10
  const decimalText = jiao || fen
    ? `${jiao ? `${digits[jiao]}角` : ''}${fen ? `${digits[fen]}分` : ''}`
    : '整'
  return `${value < 0 ? '负' : ''}${integerText}元${decimalText}`
}

function integerToChinese(
  value: number,
  digits: string[],
  units: string[],
  bigUnits: string[]
): string {
  if (value === 0) return digits[0]
  const groups: number[] = []
  let current = value
  while (current > 0) {
    groups.push(current % 10000)
    current = Math.floor(current / 10000)
  }
  let result = ''
  let pendingZero = false
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (group === 0) {
      pendingZero = result.length > 0
      continue
    }
    if (pendingZero || (result && group < 1000)) result += digits[0]
    result += smallIntegerToChinese(group, digits, units) + bigUnits[index]
    pendingZero = group < 1000
  }
  return result.replace(/零+/g, '零').replace(/零$/g, '')
}

function smallIntegerToChinese(value: number, digits: string[], units: string[]): string {
  let result = ''
  let pendingZero = false
  const values = [
    Math.floor(value / 1000) % 10,
    Math.floor(value / 100) % 10,
    Math.floor(value / 10) % 10,
    value % 10
  ]
  for (let index = 0; index < values.length; index += 1) {
    const digit = values[index]
    const unit = units[values.length - 1 - index]
    if (digit === 0) {
      pendingZero = result.length > 0
      continue
    }
    if (pendingZero) result += digits[0]
    result += digits[digit] + unit
    pendingZero = false
  }
  return result
}

function safeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet1'
}

function timestamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function dateStamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

async function comparePayrollPeople(
  sourceName: string,
  sourcePeople: PayrollPerson[],
  targetWorksheetName: string,
  compareFields: Array<[string, string]>
): Promise<CompareSummary> {
  const targetRows = await loadIntegratedRows(targetWorksheetName)
  const sourceById = new Map(sourcePeople.map((person) => [person.idCard, person]))
  const targetById = new Map(targetRows.map((row) => [row.idCard, row]))
  let added = 0
  let removed = 0
  let changed = 0
  const changedExamples: string[] = []

  for (const person of sourcePeople) {
    const target = targetById.get(person.idCard)
    if (!target) {
      added += 1
      continue
    }
    const changes = getPayrollPersonChanges(person, target, compareFields)
    if (changes.length > 0) {
      changed += 1
      if (changedExamples.length < 5) {
        changedExamples.push(`${person.name || person.idCard}：${changes.slice(0, 3).join('；')}`)
      }
    }
  }

  for (const target of targetRows) {
    if (!sourceById.has(target.idCard)) removed += 1
  }

  return {
    sourceName,
    targetName: targetWorksheetName,
    sourceRows: sourcePeople.length,
    targetRows: targetRows.length,
    added,
    removed,
    changed,
    changedExamples
  }
}

async function buildIntegratedActiveWriteBackPlan(
  sourcePeople: PayrollPerson[]
): Promise<IntegratedWriteBackPlan> {
  return buildIntegratedWorksheetWriteBackPlan(
    sourcePeople,
    '一体化在职',
    activeCompareFields,
    '一体化在职 缺少证件号码字段',
    (targetFieldName) => targetFieldName === '补扣工资' ? '001' : undefined
  )
}

async function buildIntegratedOtherWriteBackPlan(
  sourcePeople: PayrollPerson[]
): Promise<IntegratedWriteBackPlan> {
  return buildIntegratedWorksheetWriteBackPlan(
    sourcePeople,
    '一体化其他',
    survivorCompareFields,
    '一体化其他 缺少证件号码字段'
  )
}

async function buildIntegratedWorksheetWriteBackPlan(
  sourcePeople: PayrollPerson[],
  worksheetName: string,
  compareFields: Array<[string, string]>,
  missingIdCardMessage: string,
  fallbackBatchHint?: (targetFieldName: string) => string | undefined
): Promise<IntegratedWriteBackPlan> {
  const worksheet = getWorksheetByName(worksheetName)
  const columns = getWorksheetLocalColumns(worksheet)
  const idColumn = columns.find((column) => column.field.name === '证件号码')?.columnName
  const nameColumn = columns.find((column) => column.field.name === '姓名')?.columnName
  const batchColumn = columns.find((column) => column.field.name === '工资批次')?.columnName
  if (!idColumn) throw new Error(missingIdCardMessage)

  const fieldColumns = new Map(columns.map((column) => [column.field.name, column]))
  const writableFields = compareFields.flatMap(([targetFieldName, sourceFieldName]) => {
    if (sourceFieldName === 'name') return []
    const column = fieldColumns.get(targetFieldName)
    if (!column || !shouldAggregateIntegratedField(column.field)) return []
    return [{ targetFieldName, sourceFieldName, column }]
  })

  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
  const latestByIdBatch = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idColumn])
    if (!idCard) continue
    const key = integratedCurrentRowKey(idCard, row, batchColumn)
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

  const batchHintByField = new Map<string, string>()
  for (const item of writableFields) {
    const hint = inferIntegratedFieldBatch(rowsByIdCard, item.column.columnName, batchColumn)
    if (hint) batchHintByField.set(item.targetFieldName, hint)
  }

  const changes: IntegratedWriteBackChange[] = []
  const manual: IntegratedManualDifference[] = []
  for (const person of sourcePeople) {
    const personRows = rowsByIdCard.get(person.idCard)
    if (!personRows) continue

    for (const item of writableFields) {
      const sourceValue = roundMoney(num(person.values[item.sourceFieldName]))
      const targetValue = roundMoney(
        personRows.reduce((sum, row) => sum + num(row[item.column.columnName]), 0)
      )
      if (roundMoney(sourceValue - targetValue) === 0) continue

      const decision = decideIntegratedFieldWriteBack({
        personRows,
        fieldColumn: item.column.columnName,
        sourceValue,
        targetValue,
        batchColumn,
        batchHint: batchHintByField.get(item.targetFieldName) ?? fallbackBatchHint?.(item.targetFieldName)
      })
      if (decision.ok) {
        changes.push({
          worksheetName,
          idCard: person.idCard,
          name: person.name || (nameColumn ? text(personRows[0]?.[nameColumn]) : ''),
          fieldName: item.targetFieldName,
          sourceValue,
          targetValue,
          batchCode: decision.batchCode,
          reason: decision.reason,
          updates: decision.updates
        })
      } else {
        manual.push({
          worksheetName,
          idCard: person.idCard,
          name: person.name || (nameColumn ? text(personRows[0]?.[nameColumn]) : ''),
          fieldName: item.targetFieldName,
          sourceValue,
          targetValue,
          reason: decision.reason
        })
      }
    }
  }

  return { changes, manual }
}

function mergeIntegratedWriteBackPlans(...plans: IntegratedWriteBackPlan[]): IntegratedWriteBackPlan {
  return {
    changes: plans.flatMap((plan) => plan.changes),
    manual: plans.flatMap((plan) => plan.manual)
  }
}

async function applyIntegratedWriteBackPlan(plan: IntegratedWriteBackPlan): Promise<void> {
  if (plan.changes.length === 0) return
  const worksheetCache = new Map<string, {
    table: string
    fieldColumns: Map<string, string>
  }>()
  const resolveTarget = (worksheetName: string): { table: string; fieldColumns: Map<string, string> } => {
    const existing = worksheetCache.get(worksheetName)
    if (existing) return existing
    const worksheet = getWorksheetByName(worksheetName)
    const columns = getWorksheetLocalColumns(worksheet)
    const target = {
      table: tableNameOf(worksheet),
      fieldColumns: new Map(columns.map((column) => [column.field.name, column.columnName]))
    }
    worksheetCache.set(worksheetName, target)
    return target
  }
  const database = await getDatabase()
  const now = new Date().toISOString()

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const change of plan.changes) {
      const target = resolveTarget(change.worksheetName)
      const columnName = target.fieldColumns.get(change.fieldName)
      if (!columnName) continue
      for (const update of change.updates) {
        await run(
          database,
          `UPDATE ${target.table}
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

function buildMonthlyPayrollWriteBackPreview(
  plan: IntegratedWriteBackPlan,
  state: { requiresConfirmation: boolean; applied: boolean }
): MonthlyPayrollWriteBackPreview {
  return {
    requiresConfirmation: state.requiresConfirmation,
    applied: state.applied,
    syncableCount: plan.changes.length,
    manualCount: plan.manual.length,
    personCount: new Set(plan.changes.map((item) => item.idCard)).size,
    examples: plan.changes.slice(0, 5).map(formatIntegratedWriteBackChange),
    manualExamples: plan.manual.slice(0, 5).map(formatIntegratedManualDifference)
  }
}

function mergeAppliedWriteBackPreview(
  appliedPlan: IntegratedWriteBackPlan,
  remainingPlan: IntegratedWriteBackPlan
): MonthlyPayrollWriteBackPreview {
  return {
    ...buildMonthlyPayrollWriteBackPreview(appliedPlan, {
      requiresConfirmation: false,
      applied: true
    }),
    manualCount: remainingPlan.manual.length,
    manualExamples: remainingPlan.manual.slice(0, 5).map(formatIntegratedManualDifference)
  }
}

function formatIntegratedWriteBackChange(change: IntegratedWriteBackChange): string {
  const batch = change.batchCode ? `批次 ${change.batchCode}` : '当前行'
  return `${change.worksheetName} ${change.name || change.idCard} ${change.fieldName} ${formatMoney(change.targetValue)} -> ${formatMoney(change.sourceValue)}（${batch}，${change.reason}）`
}

function formatIntegratedManualDifference(change: IntegratedManualDifference): string {
  return `${change.worksheetName} ${change.name || change.idCard} ${change.fieldName} 工资表=${formatMoney(change.sourceValue)} / 一体化=${formatMoney(change.targetValue)}（${change.reason}）`
}

function inferIntegratedFieldBatch(
  rowsByIdCard: Map<string, Record<string, unknown>[]>,
  fieldColumn: string,
  batchColumn: string | undefined
): string | undefined {
  if (!batchColumn) return undefined
  const counts = new Map<string, number>()
  for (const personRows of rowsByIdCard.values()) {
    for (const row of personRows) {
      if (num(row[fieldColumn]) === 0) continue
      const batchCode = text(row[batchColumn])
      if (!batchCode) continue
      counts.set(batchCode, (counts.get(batchCode) ?? 0) + 1)
    }
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return undefined
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return undefined
  return ranked[0][0]
}

function decideIntegratedFieldWriteBack(input: {
  personRows: Record<string, unknown>[]
  fieldColumn: string
  sourceValue: number
  targetValue: number
  batchColumn: string | undefined
  batchHint: string | undefined
}): { ok: true; batchCode: string; reason: string; updates: IntegratedWriteBackUpdate[] } | { ok: false; reason: string } {
  const nonZeroRows = input.personRows.filter((row) => num(row[input.fieldColumn]) !== 0)

  if (input.sourceValue === 0) {
    return {
      ok: true,
      batchCode: '',
      reason: '工资表为 0，清空该字段现有批次金额',
      updates: input.personRows.map((row) => ({ rowId: num(row.id), value: 0 }))
    }
  }

  if (nonZeroRows.length === 1) {
    const row = nonZeroRows[0]
    return {
      ok: true,
      batchCode: batchCodeOf(row, input.batchColumn),
      reason: '沿用该字段已有承载批次',
      updates: [{ rowId: num(row.id), value: input.sourceValue }]
    }
  }

  if (nonZeroRows.length > 1) {
    return {
      ok: false,
      reason: '该字段在多个批次都有金额，无法自动判断拆分方式'
    }
  }

  const hintedRow = input.batchHint
    ? input.personRows.find((row) => batchCodeOf(row, input.batchColumn) === input.batchHint)
    : undefined
  if (hintedRow) {
    return {
      ok: true,
      batchCode: input.batchHint ?? '',
      reason: '按该字段在一体化中的常用批次写入',
      updates: [{ rowId: num(hintedRow.id), value: input.sourceValue }]
    }
  }

  if (input.personRows.length === 1) {
    const row = input.personRows[0]
    return {
      ok: true,
      batchCode: batchCodeOf(row, input.batchColumn),
      reason: '该人员只有一个批次行',
      updates: [{ rowId: num(row.id), value: input.sourceValue }]
    }
  }

  return {
    ok: false,
    reason: input.batchHint
      ? `推断该字段常用批次为 ${input.batchHint}，但该人员没有对应批次行`
      : '该字段当前为 0，且无法推断应写入 001 还是 002'
  }
}

function batchCodeOf(row: Record<string, unknown>, batchColumn: string | undefined): string {
  return batchColumn ? text(row[batchColumn]) : ''
}

async function loadIntegratedRows(worksheetName: string): Promise<IntegratedRow[]> {
  const worksheet = getWorksheetByName(worksheetName)
  const columns = getWorksheetLocalColumns(worksheet)
  const idColumn = columns.find((column) => column.field.name === '证件号码')?.columnName
  const nameColumn = columns.find((column) => column.field.name === '姓名')?.columnName
  const batchColumn = columns.find((column) => column.field.name === '工资批次')?.columnName
  if (!idColumn) throw new Error(`${worksheetName} 缺少证件号码字段`)

  const database = await getDatabase()
  const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
  const latestByIdBatch = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idColumn])
    if (!idCard) continue
    const key = integratedCurrentRowKey(idCard, row, batchColumn)
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

  return Array.from(rowsByIdCard.entries()).map(([idCard, personRows]) => {
    const representative = selectIntegratedRepresentativeRow(personRows, batchColumn)
    return {
      idCard,
      name: nameColumn ? text(representative[nameColumn]) : '',
      rowId: num(representative.id),
      values: Object.fromEntries(
        columns.map((column) => {
          const value = shouldAggregateIntegratedField(column.field)
            ? roundMoney(personRows.reduce((sum, row) => sum + num(row[column.columnName]), 0))
            : coerceComparableValue(representative[column.columnName])
          return [column.field.name, value]
        })
      )
    }
  })
}

function integratedCurrentRowKey(
  idCard: string,
  row: Record<string, unknown>,
  batchColumn: string | undefined
): string {
  return batchColumn ? `${idCard}\u0000${text(row[batchColumn])}` : idCard
}

function selectIntegratedRepresentativeRow(
  rows: Record<string, unknown>[],
  batchColumn: string | undefined
): Record<string, unknown> {
  return rows.reduce((best, row) => {
    const currentRank = integratedBatchRank(row, batchColumn)
    const bestRank = integratedBatchRank(best, batchColumn)
    if (currentRank !== bestRank) return currentRank > bestRank ? row : best
    return num(row.id) > num(best.id) ? row : best
  })
}

function integratedBatchRank(row: Record<string, unknown>, batchColumn: string | undefined): number {
  if (!batchColumn) return 0
  const code = text(row[batchColumn])
  if (code === '001') return 2
  if (code === '002') return 1
  return 0
}

function shouldAggregateIntegratedField(field: { name: string; controlType: number }): boolean {
  return [6, 31].includes(field.controlType) && !INTEGRATED_NUMERIC_REPRESENTATIVE_FIELDS.has(field.name)
}

function getPayrollPersonChanges(
  source: PayrollPerson,
  target: IntegratedRow,
  compareFields: Array<[string, string]>
): string[] {
  const changes: string[] = []
  for (const [targetFieldName, sourceFieldName] of compareFields) {
    const sourceValue = sourceFieldName === 'name' ? source.name : source.values[sourceFieldName]
    const targetValue = targetFieldName === '姓名' ? target.name : target.values[targetFieldName]
    if (sourceValue === undefined || targetValue === undefined) continue
    if (targetFieldName === '交通费' && num(targetValue) === 0) {
      continue
    }
    if (typeof sourceValue === 'number' || typeof targetValue === 'number') {
      if (roundMoney(num(sourceValue) - num(targetValue)) !== 0) {
        changes.push(`${targetFieldName} 工资表=${formatCompareValue(sourceValue)} / 系统=${formatCompareValue(targetValue)}`)
      }
    } else if (text(sourceValue) !== text(targetValue)) {
      changes.push(`${targetFieldName} 工资表=${formatCompareValue(sourceValue)} / 系统=${formatCompareValue(targetValue)}`)
    }
  }
  return changes
}

function formatCompareMessage(summary: CompareSummary): string {
  const totalDiff = summary.added + summary.removed + summary.changed
  if (totalDiff === 0) {
    return `${summary.sourceName} -> ${summary.targetName}：${summary.sourceRows} 人，按映射字段核对未发现差异`
  }
  if (summary.added === 0 && summary.removed === 0) {
    return `${summary.sourceName} -> ${summary.targetName}：人员一致，映射字段变化 ${summary.changed} 人`
  }
  return `${summary.sourceName} -> ${summary.targetName}：新增 ${summary.added} 人，减少 ${summary.removed} 人，映射字段变化 ${summary.changed} 人`
}

function formatCompareWarning(summary: CompareSummary): string {
  const hasPersonDiff = summary.added > 0 || summary.removed > 0
  const lead = hasPersonDiff
    ? `${summary.sourceName}与${summary.targetName}存在人员差异`
    : `${summary.sourceName}与${summary.targetName}人员一致，但映射字段有变化`
  const counts = `新增 ${summary.added} 人，减少 ${summary.removed} 人，字段变化 ${summary.changed} 人`
  const examples = summary.changedExamples.length > 0
    ? `。示例：${summary.changedExamples.join('；')}`
    : ''
  return `${lead}（${counts}）${examples}`
}

function formatCompareValue(value: unknown): string {
  if (typeof value === 'number') return formatMoney(value)
  return text(value) || '空'
}

function findTaxAmountColumn(headers: string[]): number {
  const candidates = [
    '应补（退）税额',
    '应补(退)税额',
    '本期应补（退）税额',
    '本期应补(退)税额'
  ].map(normalizeHeader)
  const matched = headers.findIndex((header) => candidates.includes(header))
  if (matched >= 0) return matched

  throw new Error('个税文件缺少“应补(退)税额”列')
}

function findSocialSecurityHeaderRow(rows: CellValue[][]): number {
  const itemCandidates = [
    '征收品目',
    '征收项目',
    '征收品目名称',
    '征收项目名称',
    '征收子目',
    '征收子目名称'
  ].map(normalizeHeader)
  const amountCandidates = [
    '应补（退）费额(元)',
    '应补(退)费额(元)',
    '应补（退）费额',
    '应补(退)费额',
    '应缴费额(元)',
    '应缴费额'
  ].map(normalizeHeader)
  return rows.findIndex((row) => {
    const normalized = row.map((cell) => normalizeHeader(text(cell)))
    return normalized.some((header) => itemCandidates.includes(header)) &&
      normalized.some((header) => amountCandidates.includes(header))
  })
}

function findSocialSecurityItemIndexes(headers: string[]): number[] {
  const indexes = [
    findHeaderIndex(headers, ['征收品目', '征收品目名称']),
    findHeaderIndex(headers, ['征收项目', '征收项目名称', '征收子目', '征收子目名称'])
  ].filter((index, position, values) => index >= 0 && values.indexOf(index) === position)
  return indexes.length ? indexes : [findHeaderIndex(headers, ['征收品目', '征收项目'])]
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  const normalized = candidates.map(normalizeHeader)
  return headers.findIndex((header) => normalized.includes(header))
}

function findHeaderRow(rows: CellValue[][], requiredHeaders: string[]): number {
  const normalizedRequired = requiredHeaders.map(normalizeHeader)
  return rows.findIndex((row) => {
    const normalized = new Set(row.map((cell) => normalizeHeader(text(cell))))
    return normalizedRequired.every((header) => normalized.has(header))
  })
}

function findTotalRow(rows: CellValue[][], nameColumnIndex: number): CellValue[] | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (text(rows[index][nameColumnIndex]).replace(/\s+/g, '').includes('合计')) {
      return rows[index]
    }
  }
  return undefined
}

async function readWorkbook(filePath: string): Promise<XLSX.WorkBook> {
  const buffer = await readFile(filePath)
  return XLSX.read(buffer, { cellDates: false, type: 'buffer' })
}

function sheetToAoa(sheet: XLSX.WorkSheet): CellValue[][] {
  return XLSX.utils.sheet_to_json<CellValue[]>(sheet, {
    header: 1,
    defval: null,
    raw: false
  })
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const raw = text(value).replace(/,/g, '')
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function coerceComparableValue(value: unknown): string | number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const raw = text(value)
  if (!raw) return ''
  const numberText = raw.replace(/,/g, '')
  if (/^-?\d+(\.\d+)?$/.test(numberText)) return Number(numberText)
  return raw
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, '').replace(/[()]/g, (match) => (match === '(' ? '（' : '）')).toLowerCase()
}

function normalizeIdCard(value: unknown): string {
  return text(value).replace(/[\s,]/g, '').toUpperCase()
}

function isValidIdCard(value: unknown): boolean {
  return /^\d{17}[\dX]$/.test(normalizeIdCard(value))
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}
