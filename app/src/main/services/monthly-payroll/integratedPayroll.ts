import { all, getDatabase, run } from '../../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../../db/schema'
import { findColumnByName, getWorksheetByName, tableNameOf } from '../worksheetTable'
import type {
  MonthlyPayrollIdentityReview,
  MonthlyPayrollWriteBackPreview
} from '../../../shared/types'
import type { PayrollPerson } from './monthlyPayrollTypes'
import { inactiveMonthlyPayrollTaxField, readMonthlyPayrollSettings } from './monthlyPayrollSettings'
import {
  integratedActiveInsuranceFields,
  integratedActivePayFields,
  integratedSimplePayFields
} from './integratedPayrollRules'
import {
  readConfirmedIdentityAliasMap,
  type ConfirmedIdentityAliasMap
} from './monthlyPayrollIdentityAliases'
import { activeBackpayAdjustmentTotals } from './salaryBackpayAdjustments'
import {
  coerceComparableValue,
  formatMoney,
  normalizeIdCard,
  num,
  roundMoney,
  text
} from './monthlyPayrollUtils'

export type IntegratedSimplePaySummary = {
  rowCount: number
  actualPayTotal: number
}

export type CompareSummary = {
  sourceName: string
  targetName: string
  sourceRows: number
  targetRows: number
  added: number
  removed: number
  changed: number
  identityReviewCount: number
  identityReviewExamples: string[]
  changedExamples: string[]
  diffDetails: CompareDiffDetail[]
}

export type CompareDiffDetail = {
  type: 'added' | 'removed' | 'changed'
  name: string
  idCard: string
  changes?: string[]
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

export type IntegratedWriteBackPlan = {
  changes: IntegratedWriteBackChange[]
  manual: IntegratedManualDifference[]
  identityReviews: MonthlyPayrollIdentityReview[]
}

type IntegratedIdentityRowGroup = {
  idCard: string
  name: string
  rows: Record<string, unknown>[]
}

type IntegratedIdentityIndex = {
  byIdCard: Map<string, Record<string, unknown>[]>
  byName: Map<string, IntegratedIdentityRowGroup[]>
}

type IntegratedIdentityResolution = {
  rows?: Record<string, unknown>[]
  review?: MonthlyPayrollIdentityReview
}

type IntegratedIdentityFallbackOptions = {
  allowIdentityFallback?: boolean
  confirmedIdentityAliases?: ConfirmedIdentityAliasMap
}

export type IntegratedIdCardResolver = (idCard: string, name: string) => string

export type IntegratedRow = {
  idCard: string
  name: string
  rowId: number
  values: Record<string, string | number>
}

export const activeCompareFields: Array<[string, string]> = [
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
  ['公积金', '公积金']
]

export function getActiveCompareFields(taxField: string): Array<[string, string]> {
  void taxField
  return activeCompareFields
}

export const survivorCompareFields: Array<[string, string]> = [
  ['姓名', 'name'],
  ['应发工资小计', '应发工资小计'],
  ['实发合计', '实发合计']
]

const INTEGRATED_ACTIVE_PAY_FIELDS = [
  ...integratedActivePayFields
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

export type IntegratedActiveRecomputeResult = {
  rowCount: number
  taxApplied: number
  taxMissing: number
  payableTotal: number
  actualPayTotal: number
}

export async function applyTaxAndRecomputeIntegratedActive(
  taxByIdCard: Record<string, number>,
  options: {
    clearTaxWhenMissing?: boolean
    preserveExistingTaxField?: boolean
    // 工资表口径：补扣工资列 = 补发负数(backpayDeductionByIdCard) + 个税(文件)，每遍重算、幂等。
    // 不传则保持原有税列口径(一体化数据源用)，避免改动整合模式行为。
    recomputeBackpayInTaxCol?: boolean
  } = {},
  backpayDeductionByIdCard: Record<string, number> = {}
): Promise<IntegratedActiveRecomputeResult> {
  const settings = await readMonthlyPayrollSettings()
  const taxField = settings.taxField
  const inactiveTaxField = inactiveMonthlyPayrollTaxField(taxField)
  const hasTaxOverrides = Object.keys(taxByIdCard).length > 0
  const shouldRewriteTax = !options.preserveExistingTaxField &&
    (hasTaxOverrides || Boolean(options.clearTaxWhenMissing))
  const worksheet = getWorksheetByName('在职工资')
  const idCardCol = findColumnByName(worksheet, '证件号码')
  const taxCol = findColumnByName(worksheet, taxField)
  const inactiveTaxCol = findColumnByName(worksheet, inactiveTaxField)
  const payableCol = findColumnByName(worksheet, '应发工资')
  const deductionCol = findColumnByName(worksheet, '代扣工资')
  const withholdingCol = findColumnByName(worksheet, '代扣合计')
  const actualCol = findColumnByName(worksheet, '实发合计')
  const payCols = INTEGRATED_ACTIVE_PAY_FIELDS.map((name) => findColumnByName(worksheet, name))
  const insuranceCols = integratedActiveInsuranceFields.map((name) => findColumnByName(worksheet, name))
  const taxDeductionCol = findColumnByName(worksheet, '补扣工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const batchColumn = columns.find((column) => column.field.name === '工资批次编码')?.columnName
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
    // 业务口径(仅工资表数据源)：补扣工资 = 补发负数 + 当月个税(个税文件为权威)。
    // 因为“补扣工资”这一列同时被配置为个税列(taxField)，若按纯个税列处理，没有个税文件时会被
    // 清零、连补发负数一起丢掉(历史 bug)。这里按“补发负数 + 个税”每遍重算，幂等。
    const recomputeBackpay = options.recomputeBackpayInTaxCol === true && taxDeductionCol === taxCol
    for (const [idCard, personRows] of rowsByIdCard.entries()) {
      const overrideTax = taxByIdCard[idCard]
      if (overrideTax !== undefined) taxApplied += 1
      // 补发负数(整人)：来自工资表，每遍重算，保证幂等
      const personBackpayDeduction = roundMoney(backpayDeductionByIdCard[idCard] ?? 0)

      const taxCarrier = selectIntegratedRepresentativeRow(personRows, batchColumn)
      for (const row of personRows) {
        const isCarrier = num(row.id) === num(taxCarrier.id)
        const receivesOverrideTax = overrideTax !== undefined && isCarrier
        const fileTax = receivesOverrideTax ? overrideTax : 0
        // 工资表口径：补扣工资 = 补发负数 + 个税(文件)，集中落在 taxCarrier 行，其余批次行清 0
        const taxAmount = recomputeBackpay
          ? (isCarrier ? roundMoney(personBackpayDeduction + fileTax) : 0)
          : options.preserveExistingTaxField
            ? num(row[taxCol])
            : overrideTax !== undefined
              ? fileTax
              : options.clearTaxWhenMissing ? 0 : num(row[taxCol])
        const payable = payCols.reduce((sum, col) => sum + num(row[col]), 0)
        const taxDeduction = taxDeductionCol === taxCol
          ? taxAmount
          : shouldRewriteTax && taxDeductionCol === inactiveTaxCol
            ? 0
            : num(row[taxDeductionCol])
        const deduction = roundMoney(
          insuranceCols.reduce((sum, col) => sum + num(row[col]), 0) + taxDeduction
        )
        const actual = roundMoney(payable - deduction)
        const payableRounded = roundMoney(payable)

        const assignments = [
          `${quoteIdentifier(taxCol)} = ?`,
          ...(shouldRewriteTax ? [`${quoteIdentifier(inactiveTaxCol)} = ?`] : []),
          `${quoteIdentifier(payableCol)} = ?`,
          `${quoteIdentifier(deductionCol)} = ?`,
          `${quoteIdentifier(withholdingCol)} = ?`,
          `${quoteIdentifier(actualCol)} = ?`,
          '"md_updated_at" = ?'
        ].join(', ')
        const params: unknown[] = [
          taxAmount,
          ...(shouldRewriteTax ? [0] : []),
          payableRounded,
          deduction,
          0,
          actual,
          now,
          row.id
        ]

        await run(
          database,
          `UPDATE ${table}
             SET ${assignments}
           WHERE "id" = ?`,
          params
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

export async function summarizeIntegratedActive(
  taxByIdCard: Record<string, number>
): Promise<IntegratedActiveRecomputeResult> {
  const rows = await loadIntegratedRows('在职工资')
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

export async function recomputeIntegratedOtherLikeWorksheet(
  worksheetName: '其他工资' | '退休工资'
): Promise<IntegratedSimplePaySummary> {
  const worksheet = getWorksheetByName(worksheetName)
  const columns = getWorksheetLocalColumns(worksheet)
  const colByName = (name: string): string | undefined =>
    columns.find((column) => column.field.name === name)?.columnName
  const idColumn = colByName('证件号码')
  const payableColumn = colByName('应发工资小计')
  const deductionColumn = colByName('代扣工资')
  const actualPayColumn = colByName('实发合计')
  if (!idColumn || !actualPayColumn) {
    throw new Error(`${worksheetName} 缺少证件号码或实发合计字段`)
  }
  const payColumns = integratedSimplePayFields
    .map((name) => colByName(name))
    .filter((column): column is string => Boolean(column))

  const database = await getDatabase()
  const table = tableNameOf(worksheet)
  const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${table}`)
  const latestById = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const idCard = normalizeIdCard(row[idColumn])
    if (!idCard) continue
    const previous = latestById.get(idCard)
    if (!previous || num(row.id) > num(previous.id)) latestById.set(idCard, row)
  }

  const latest = Array.from(latestById.values())
  let actualPayTotal = 0
  const now = new Date().toISOString()
  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const row of latest) {
      const payable = roundMoney(payColumns.reduce((sum, column) => sum + num(row[column]), 0))
      const actual = roundMoney(payable - (deductionColumn ? num(row[deductionColumn]) : 0))
      actualPayTotal = roundMoney(actualPayTotal + actual)
      const assignments = [
        ...(payableColumn ? [`${quoteIdentifier(payableColumn)} = ?`] : []),
        `${quoteIdentifier(actualPayColumn)} = ?`,
        '"md_updated_at" = ?'
      ].join(', ')
      const params = [
        ...(payableColumn ? [payable] : []),
        actual,
        now,
        row.id
      ]
      await run(
        database,
        `UPDATE ${table}
           SET ${assignments}
         WHERE "id" = ?`,
        params
      )
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }
  return {
    rowCount: latest.length,
    actualPayTotal
  }
}

export async function comparePayrollPeople(
  sourceName: string,
  sourcePeople: PayrollPerson[],
  targetWorksheetName: string,
  compareFields: Array<[string, string]>,
  options: IntegratedIdentityFallbackOptions = {}
): Promise<CompareSummary> {
  const targetRows = await loadIntegratedRows(targetWorksheetName)
  const targetById = new Map(targetRows.map((row) => [row.idCard, row]))
  const confirmedIdentityAliases = options.confirmedIdentityAliases ??
    await readConfirmedIdentityAliasMap(targetWorksheetName)
  const targetByName = new Map<string, IntegratedRow[]>()
  for (const target of targetRows) {
    const nameKey = normalizePersonName(target.name)
    if (!nameKey) continue
    const grouped = targetByName.get(nameKey) ?? []
    grouped.push(target)
    targetByName.set(nameKey, grouped)
  }
  const matchedTargetIdCards = new Set<string>()
  let added = 0
  let removed = 0
  let changed = 0
  const changedExamples: string[] = []
  const diffDetails: CompareDiffDetail[] = []
  let identityReviewCount = 0
  const identityReviewExamples: string[] = []

  for (const person of sourcePeople) {
    let target = targetById.get(person.idCard)
    if (!target) {
      const confirmedTargetIdCard = confirmedIdentityAliases.get(normalizeIdCard(person.idCard))
      target = confirmedTargetIdCard ? targetById.get(confirmedTargetIdCard) : undefined
    }
    if (!target) {
      const resolution = resolveIntegratedRowIdentityFallback(
        person,
        targetByName,
        targetById,
        targetWorksheetName,
        options.allowIdentityFallback ?? false,
        confirmedIdentityAliases
      )
      if (resolution.review && identityReviewExamples.length < 5) {
        identityReviewExamples.push(formatIntegratedIdentityReview(resolution.review))
      }
      if (resolution.review) identityReviewCount += 1
      target = resolution.row
      if (!target) {
        added += 1
        diffDetails.push({
          type: 'added',
          name: person.name,
          idCard: person.idCard
        })
        continue
      }
    }
    matchedTargetIdCards.add(target.idCard)
    const changes = getPayrollPersonChanges(person, target, compareFields)
    if (changes.length > 0) {
      changed += 1
      diffDetails.push({
        type: 'changed',
        name: person.name || target.name,
        idCard: person.idCard || target.idCard,
        changes
      })
      if (changedExamples.length < 5) {
        changedExamples.push(`${person.name || person.idCard}：${changes.slice(0, 3).join('；')}`)
      }
    }
  }

  for (const target of targetRows) {
    if (!matchedTargetIdCards.has(target.idCard)) {
      removed += 1
      diffDetails.push({
        type: 'removed',
        name: target.name,
        idCard: target.idCard
      })
    }
  }

  return {
    sourceName,
    targetName: targetWorksheetName,
    sourceRows: sourcePeople.length,
    targetRows: targetRows.length,
    added,
    removed,
    changed,
    identityReviewCount,
    identityReviewExamples,
    changedExamples,
    diffDetails
  }
}

export async function buildIntegratedActiveIdCardResolver(): Promise<IntegratedIdCardResolver> {
  const rows = await loadIntegratedRows('在职工资')
  const byIdCard = new Map(rows.map((row) => [normalizeIdCard(row.idCard), row.idCard]))
  const confirmedIdentityAliases = await readConfirmedIdentityAliasMap('在职工资')

  return (idCard: string, name: string): string => {
    void name
    const normalizedIdCard = normalizeIdCard(idCard)
    const exact = byIdCard.get(normalizedIdCard)
    if (exact) return exact

    const confirmedTargetIdCard = confirmedIdentityAliases.get(normalizedIdCard)
    if (confirmedTargetIdCard && byIdCard.has(confirmedTargetIdCard)) return confirmedTargetIdCard

    return normalizedIdCard || idCard
  }
}

export async function buildIntegratedActiveWriteBackPlan(
  sourcePeople: PayrollPerson[],
  options: IntegratedIdentityFallbackOptions = {}
): Promise<IntegratedWriteBackPlan> {
  const settings = await readMonthlyPayrollSettings()
  const taxField = settings.taxField
  return buildIntegratedWorksheetWriteBackPlan(
    sourcePeople,
    '在职工资',
    getActiveCompareFields(taxField),
    '在职工资 缺少证件号码字段',
    (targetFieldName) => targetFieldName === '交通费' ? '002' : '001',
    options
  )
}

export async function buildIntegratedActiveBackpayAdjustmentPlan(
  sourcePeople: PayrollPerson[],
  options: IntegratedIdentityFallbackOptions = {}
): Promise<IntegratedWriteBackPlan> {
  const worksheet = getWorksheetByName('在职工资')
  const columns = getWorksheetLocalColumns(worksheet)
  const idColumn = findColumnByName(worksheet, '证件号码')
  const nameColumn = findColumnByName(worksheet, '姓名')
  const batchColumn = columns.find((column) => column.field.name === '工资批次编码')?.columnName
  const backpayColumn = findColumnByName(worksheet, '补发工资')
  const deductionColumn = findColumnByName(worksheet, '补扣工资')

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
  const identityIndex = buildIntegratedIdentityIndex(rowsByIdCard, nameColumn, batchColumn)
  const confirmedIdentityAliases = options.confirmedIdentityAliases ??
    await readConfirmedIdentityAliasMap('在职工资')

  const changes: IntegratedWriteBackChange[] = []
  const manual: IntegratedManualDifference[] = []
  const identityReviews: MonthlyPayrollIdentityReview[] = []
  for (const person of sourcePeople) {
    const identity = resolveIntegratedIdentityRows({
      worksheetName: '在职工资',
      person,
      identityIndex,
      allowIdentityFallback: options.allowIdentityFallback ?? false,
      confirmedIdentityAliases
    })
    if (identity.review) identityReviews.push(identity.review)
    const personRows = identity.rows
    if (!personRows) continue

    const name = person.name || text(personRows[0]?.[nameColumn])
    const totals = activeBackpayAdjustmentTotals(person)
    appendActiveBackpayAdjustmentChange({
      changes,
      manual,
      personRows,
      batchColumn,
      fieldColumn: backpayColumn,
      fieldName: '补发工资',
      idCard: person.idCard,
      name,
      sourceValue: totals.increaseTotal,
      reason: '两个补发项目正数汇总'
    })
    appendActiveBackpayAdjustmentChange({
      changes,
      manual,
      personRows,
      batchColumn,
      fieldColumn: deductionColumn,
      fieldName: '补扣工资',
      idCard: person.idCard,
      name,
      sourceValue: totals.deductionTotal,
      reason: '两个补发项目负数与个税汇总'
    })
  }

  return { changes, manual, identityReviews }
}

function appendActiveBackpayAdjustmentChange(input: {
  changes: IntegratedWriteBackChange[]
  manual: IntegratedManualDifference[]
  personRows: Record<string, unknown>[]
  batchColumn: string | undefined
  fieldColumn: string
  fieldName: string
  idCard: string
  name: string
  sourceValue: number
  reason: string
}): void {
  const targetValue = roundMoney(
    input.personRows.reduce((sum, row) => sum + num(row[input.fieldColumn]), 0)
  )
  if (roundMoney(input.sourceValue - targetValue) === 0) return

  const decision = decideIntegratedFieldWriteBack({
    personRows: input.personRows,
    fieldColumn: input.fieldColumn,
    sourceValue: input.sourceValue,
    targetValue,
    batchColumn: input.batchColumn,
    batchHint: '001'
  })
  if (decision.ok) {
    input.changes.push({
      worksheetName: '在职工资',
      idCard: input.idCard,
      name: input.name,
      fieldName: input.fieldName,
      sourceValue: input.sourceValue,
      targetValue,
      batchCode: decision.batchCode,
      reason: input.reason,
      updates: decision.updates
    })
  } else {
    input.manual.push({
      worksheetName: '在职工资',
      idCard: input.idCard,
      name: input.name,
      fieldName: input.fieldName,
      sourceValue: input.sourceValue,
      targetValue,
      reason: `${input.reason}，${decision.reason}`
    })
  }
}

export async function buildIntegratedOtherWriteBackPlan(
  sourcePeople: PayrollPerson[],
  options: IntegratedIdentityFallbackOptions = {}
): Promise<IntegratedWriteBackPlan> {
  return buildIntegratedWorksheetWriteBackPlan(
    sourcePeople,
    '其他工资',
    survivorCompareFields,
    '其他工资 缺少证件号码字段',
    undefined,
    options
  )
}

async function buildIntegratedWorksheetWriteBackPlan(
  sourcePeople: PayrollPerson[],
  worksheetName: string,
  compareFields: Array<[string, string]>,
  missingIdCardMessage: string,
  fallbackBatchHint?: (targetFieldName: string) => string | undefined,
  options: IntegratedIdentityFallbackOptions = {}
): Promise<IntegratedWriteBackPlan> {
  const worksheet = getWorksheetByName(worksheetName)
  const columns = getWorksheetLocalColumns(worksheet)
  const idColumn = columns.find((column) => column.field.name === '证件号码')?.columnName
  const nameColumn = columns.find((column) => column.field.name === '姓名')?.columnName
  const batchColumn = columns.find((column) => column.field.name === '工资批次编码')?.columnName
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
  const identityIndex = buildIntegratedIdentityIndex(rowsByIdCard, nameColumn, batchColumn)
  const confirmedIdentityAliases = options.confirmedIdentityAliases ??
    await readConfirmedIdentityAliasMap(worksheetName)

  const batchHintByField = new Map<string, string>()
  for (const item of writableFields) {
    const hint = inferIntegratedFieldBatch(rowsByIdCard, item.column.columnName, batchColumn)
    if (hint) batchHintByField.set(item.targetFieldName, hint)
  }

  const changes: IntegratedWriteBackChange[] = []
  const manual: IntegratedManualDifference[] = []
  const identityReviews: MonthlyPayrollIdentityReview[] = []
  for (const person of sourcePeople) {
    const identity = resolveIntegratedIdentityRows({
      worksheetName,
      person,
      identityIndex,
      allowIdentityFallback: options.allowIdentityFallback ?? false,
      confirmedIdentityAliases
    })
    if (identity.review) identityReviews.push(identity.review)
    const personRows = identity.rows
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

  return { changes, manual, identityReviews }
}

export function mergeIntegratedWriteBackPlans(...plans: IntegratedWriteBackPlan[]): IntegratedWriteBackPlan {
  return {
    changes: plans.flatMap((plan) => plan.changes),
    manual: plans.flatMap((plan) => plan.manual),
    identityReviews: dedupeIdentityReviews(plans.flatMap((plan) => plan.identityReviews))
  }
}

export async function applyIntegratedWriteBackPlan(plan: IntegratedWriteBackPlan): Promise<void> {
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

export function buildMonthlyPayrollWriteBackPreview(
  plan: IntegratedWriteBackPlan,
  state: { requiresConfirmation: boolean; requiresIdentityConfirmation?: boolean; applied: boolean }
): MonthlyPayrollWriteBackPreview {
  const salaryImportDiff = buildSalaryImportDiff(plan)
  const identityConfirmableCount = plan.identityReviews.filter((review) => review.confirmable).length
  const identityBlockedCount = plan.identityReviews.length - identityConfirmableCount
  const identityReviewExamples = plan.identityReviews
    .slice()
    .sort((left, right) => Number(left.confirmable) - Number(right.confirmable))
    .slice(0, 5)
    .map(formatIntegratedIdentityReview)
  return {
    requiresConfirmation: state.requiresConfirmation,
    requiresIdentityConfirmation: state.requiresIdentityConfirmation ?? false,
    applied: state.applied,
    syncableCount: plan.changes.length,
    manualCount: plan.manual.length,
    identityReviewCount: plan.identityReviews.length,
    identityConfirmableCount,
    identityBlockedCount,
    personCount: new Set(plan.changes.map((item) => item.idCard)).size,
    examples: plan.changes.slice(0, 5).map(formatIntegratedWriteBackChange),
    manualExamples: plan.manual.slice(0, 5).map(formatIntegratedManualDifference),
    identityReviewExamples,
    salaryImportFields: salaryImportDiff.fields,
    salaryImportIdCards: salaryImportDiff.idCards
  }
}

export function mergeAppliedWriteBackPreview(
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

const SALARY_IMPORT_FIELD_ORDER = [
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
  '其他一',
  '其他二',
  '其他三',
  '公积金',
  '养老保险缴费',
  '职业年金缴费',
  '医疗保险',
  '失业保险',
  '支出一',
  '支出二',
  '支出三'
]
const SALARY_IMPORT_FIELD_SET = new Set(SALARY_IMPORT_FIELD_ORDER)

function buildSalaryImportDiff(plan: IntegratedWriteBackPlan): { fields: string[]; idCards: string[] } {
  const fields = new Set<string>()
  const idCards = new Set<string>()
  for (const change of plan.changes) {
    if (change.worksheetName !== '在职工资') continue
    if (!SALARY_IMPORT_FIELD_SET.has(change.fieldName)) continue
    fields.add(change.fieldName)
    idCards.add(change.idCard)
  }
  return {
    fields: SALARY_IMPORT_FIELD_ORDER.filter((field) => fields.has(field)),
    idCards: Array.from(idCards)
  }
}

function formatIntegratedWriteBackChange(change: IntegratedWriteBackChange): string {
  const batch = change.batchCode ? `批次 ${change.batchCode}` : '当前行'
  return `${change.worksheetName} ${change.name || change.idCard} ${change.fieldName} ${formatMoney(change.targetValue)} -> ${formatMoney(change.sourceValue)}（${batch}，${change.reason}）`
}

function formatIntegratedManualDifference(change: IntegratedManualDifference): string {
  return `${change.worksheetName} ${change.name || change.idCard} ${change.fieldName} 工资表=${formatMoney(change.sourceValue)} / 一体化=${formatMoney(change.targetValue)}（${change.reason}）`
}

function formatIntegratedIdentityReview(review: MonthlyPayrollIdentityReview): string {
  const source = `${review.sourceName || '未填姓名'}（工资表身份证 ${review.sourceIdCard || '空'}）`
  const target = review.targetIdCard
    ? `本地 ${review.targetName || review.sourceName || '未填姓名'}（身份证 ${review.targetIdCard}）`
    : '未找到唯一本地人员'
  return `${review.worksheetName} ${source} -> ${target}：${review.reason}`
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

export async function loadIntegratedRows(
  worksheetName: string,
  options: { batchCode?: string } = {}
): Promise<IntegratedRow[]> {
  const worksheet = getWorksheetByName(worksheetName)
  const columns = getWorksheetLocalColumns(worksheet)
  const idColumn = columns.find((column) => column.field.name === '证件号码')?.columnName
  const nameColumn = columns.find((column) => column.field.name === '姓名')?.columnName
  const batchColumn = columns.find((column) => column.field.name === '工资批次编码')?.columnName
  if (!idColumn) throw new Error(`${worksheetName} 缺少证件号码字段`)

  const database = await getDatabase()
  let rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
  if (options.batchCode && batchColumn) {
    rows = rows.filter((row) => text(row[batchColumn]) === options.batchCode)
  }
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

function buildIntegratedIdentityIndex(
  byIdCard: Map<string, Record<string, unknown>[]>,
  nameColumn: string | undefined,
  batchColumn: string | undefined
): IntegratedIdentityIndex {
  const byName = new Map<string, IntegratedIdentityRowGroup[]>()
  if (!nameColumn) return { byIdCard, byName }
  for (const [idCard, rows] of byIdCard.entries()) {
    const representative = selectIntegratedRepresentativeRow(rows, batchColumn)
    const name = text(representative[nameColumn])
    const nameKey = normalizePersonName(name)
    if (!nameKey) continue
    const grouped = byName.get(nameKey) ?? []
    grouped.push({ idCard, name, rows })
    byName.set(nameKey, grouped)
  }
  return { byIdCard, byName }
}

function resolveIntegratedIdentityRows(input: {
  worksheetName: string
  person: PayrollPerson
  identityIndex: IntegratedIdentityIndex
  allowIdentityFallback: boolean
  confirmedIdentityAliases: ConfirmedIdentityAliasMap
}): IntegratedIdentityResolution {
  const idCard = normalizeIdCard(input.person.idCard)
  const exactRows = input.identityIndex.byIdCard.get(idCard)
  if (exactRows) return { rows: exactRows }

  const confirmedTargetIdCard = input.confirmedIdentityAliases.get(idCard)
  if (confirmedTargetIdCard) {
    const confirmedRows = input.identityIndex.byIdCard.get(confirmedTargetIdCard)
    if (confirmedRows) return { rows: confirmedRows }
  }

  const nameKey = normalizePersonName(input.person.name)
  if (!nameKey) return {}
  const candidates = input.identityIndex.byName.get(nameKey) ?? []
  if (candidates.length === 0) return {}
  if (candidates.length > 1) {
    return {
      review: {
        worksheetName: input.worksheetName,
        sourceName: input.person.name,
        sourceIdCard: idCard,
        confirmable: false,
        reason: `姓名重复，对应 ${candidates.map((candidate) => candidate.idCard).join('、')}，需先人工修正`
      }
    }
  }

  const candidate = candidates[0]
  if (confirmedTargetIdCard && confirmedTargetIdCard === candidate.idCard) {
    return { rows: candidate.rows }
  }
  const review: MonthlyPayrollIdentityReview = {
    worksheetName: input.worksheetName,
    sourceName: input.person.name,
    sourceIdCard: idCard,
    targetName: candidate.name,
    targetIdCard: candidate.idCard,
    confirmable: true,
    reason: '身份证不一致，姓名唯一匹配'
  }
  return input.allowIdentityFallback ? { rows: candidate.rows, review } : { review }
}

function resolveIntegratedRowIdentityFallback(
  person: PayrollPerson,
  targetByName: Map<string, IntegratedRow[]>,
  targetById: Map<string, IntegratedRow>,
  worksheetName: string,
  allowIdentityFallback: boolean,
  confirmedIdentityAliases: ConfirmedIdentityAliasMap
): { row?: IntegratedRow; review?: MonthlyPayrollIdentityReview } {
  const sourceIdCard = normalizeIdCard(person.idCard)
  const confirmedTargetIdCard = confirmedIdentityAliases.get(sourceIdCard)
  if (confirmedTargetIdCard) {
    const confirmedRow = targetById.get(confirmedTargetIdCard)
    if (confirmedRow) return { row: confirmedRow }
  }

  const nameKey = normalizePersonName(person.name)
  if (!nameKey) return {}
  const candidates = targetByName.get(nameKey) ?? []
  if (candidates.length === 0) return {}
  if (candidates.length > 1) {
    return {
      review: {
        worksheetName,
        sourceName: person.name,
        sourceIdCard: normalizeIdCard(person.idCard),
        confirmable: false,
        reason: `姓名重复，对应 ${candidates.map((candidate) => candidate.idCard).join('、')}，需先人工修正`
      }
    }
  }
  const candidate = candidates[0]
  if (confirmedTargetIdCard && confirmedTargetIdCard === candidate.idCard) {
    return { row: candidate }
  }
  const review: MonthlyPayrollIdentityReview = {
    worksheetName,
    sourceName: person.name,
    sourceIdCard: normalizeIdCard(person.idCard),
    targetName: candidate.name,
    targetIdCard: candidate.idCard,
    confirmable: true,
    reason: '身份证不一致，姓名唯一匹配'
  }
  return allowIdentityFallback ? { row: candidate, review } : { review }
}

function normalizePersonName(value: unknown): string {
  return text(value).replace(/\s+/g, '')
}

function dedupeIdentityReviews(reviews: MonthlyPayrollIdentityReview[]): MonthlyPayrollIdentityReview[] {
  const seen = new Set<string>()
  const result: MonthlyPayrollIdentityReview[] = []
  for (const review of reviews) {
    const key = [
      review.worksheetName,
      review.sourceName,
      review.sourceIdCard,
      review.targetIdCard ?? '',
      review.confirmable ? 'confirmable' : 'blocked'
    ].join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(review)
  }
  return result
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

export function formatCompareMessage(summary: CompareSummary): string {
  const totalDiff = summary.added + summary.removed + summary.changed
  if (totalDiff === 0) {
    return `${summary.sourceName} -> ${summary.targetName}：${summary.sourceRows} 人，按映射字段核对未发现差异`
  }
  if (summary.added === 0 && summary.removed === 0) {
    return `${summary.sourceName} -> ${summary.targetName}：人员一致，映射字段变化 ${summary.changed} 人`
  }
  return `${summary.sourceName} -> ${summary.targetName}：新增 ${summary.added} 人，减少 ${summary.removed} 人，映射字段变化 ${summary.changed} 人`
}

export function formatCompareWarning(summary: CompareSummary): string {
  const hasPersonDiff = summary.added > 0 || summary.removed > 0
  const lead = hasPersonDiff
    ? `${summary.sourceName}与${summary.targetName}按身份证匹配存在找不到的人员`
    : `${summary.sourceName}与${summary.targetName}人员一致，但映射字段有变化`
  const counts = `新增 ${summary.added} 人，减少 ${summary.removed} 人，字段变化 ${summary.changed} 人`
  const examples = summary.changedExamples.length > 0
    ? `。示例：${summary.changedExamples.join('；')}`
    : ''
  return `${lead}（${counts}）${examples}`
}

export function formatCompareTooltipLines(summary: CompareSummary): string[] {
  const lines: string[] = []
  appendCompareDiffLines(
    lines,
    summary,
    'added',
    `新增 ${summary.added} 人（${summary.sourceName}有，${summary.targetName}找不到）`
  )
  appendCompareDiffLines(
    lines,
    summary,
    'removed',
    `减少 ${summary.removed} 人（${summary.targetName}有，${summary.sourceName}找不到）`
  )
  appendCompareDiffLines(
    lines,
    summary,
    'changed',
    `字段变化 ${summary.changed} 人`
  )
  return lines
}

function appendCompareDiffLines(
  lines: string[],
  summary: CompareSummary,
  type: CompareDiffDetail['type'],
  title: string
): void {
  const details = summary.diffDetails.filter((detail) => detail.type === type)
  if (details.length === 0) return
  lines.push(title)
  details.slice(0, 50).forEach((detail, index) => {
    const identity = `${index + 1}. ${detail.name || '姓名空'} | 身份证号 ${detail.idCard || '空'}`
    const changes = detail.changes?.length
      ? ` | ${detail.changes.join('；')}`
      : ''
    lines.push(`${identity}${changes}`)
  })
  if (details.length > 50) {
    lines.push(`其余 ${details.length - 50} 人未在悬浮窗口中展开`)
  }
}

function formatCompareValue(value: unknown): string {
  if (typeof value === 'number') return formatMoney(value)
  return text(value) || '空'
}
