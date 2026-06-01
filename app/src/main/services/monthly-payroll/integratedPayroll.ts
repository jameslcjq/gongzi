import { all, getDatabase, run } from '../../db/connection'
import { getWorksheetLocalColumns, quoteIdentifier } from '../../db/schema'
import { findColumnByName, getWorksheetByName, tableNameOf } from '../worksheetTable'
import type { MonthlyPayrollWriteBackPreview } from '../../../shared/types'
import type { PayrollPerson } from './monthlyPayrollTypes'
import { inactiveMonthlyPayrollTaxField, readMonthlyPayrollSettings } from './monthlyPayrollSettings'
import {
  integratedActiveInsuranceFields,
  integratedActiveOtherDeductFields,
  integratedActivePayFields,
  integratedSimplePayFields
} from './integratedPayrollRules'
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

export type IntegratedWriteBackPlan = {
  changes: IntegratedWriteBackChange[]
  manual: IntegratedManualDifference[]
}

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
  ['公积金', '公积金'],
  ['补扣工资', '当月个人所得税']
]

export function getActiveCompareFields(taxField: string): Array<[string, string]> {
  return activeCompareFields.map(([target, source]) =>
    target === '补扣工资' ? [taxField, source] : [target, source]
  )
}

export const survivorCompareFields: Array<[string, string]> = [
  ['姓名', 'name'],
  ['应发工资小计', '应发工资小计'],
  ['实发合计', '实发合计']
]

const INTEGRATED_ACTIVE_PAY_FIELDS = [
  ...integratedActivePayFields
]

const INTEGRATED_ACTIVE_DEDUCT_FIELDS = [
  ...integratedActiveInsuranceFields,
  ...integratedActiveOtherDeductFields
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
  options: { clearTaxWhenMissing?: boolean } = {}
): Promise<IntegratedActiveRecomputeResult> {
  const settings = await readMonthlyPayrollSettings()
  const taxField = settings.taxField
  const inactiveTaxField = inactiveMonthlyPayrollTaxField(taxField)
  const hasTaxOverrides = Object.keys(taxByIdCard).length > 0
  const shouldRewriteTax = hasTaxOverrides || Boolean(options.clearTaxWhenMissing)
  const worksheet = getWorksheetByName('在职工资')
  const idCardCol = findColumnByName(worksheet, '证件号码')
  const taxCol = findColumnByName(worksheet, taxField)
  const inactiveTaxCol = findColumnByName(worksheet, inactiveTaxField)
  const payableCol = findColumnByName(worksheet, '应发工资')
  const withholdingCol = findColumnByName(worksheet, '代扣合计')
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
        const taxAmount = overrideTax !== undefined
          ? (receivesOverrideTax ? overrideTax : 0)
          : options.clearTaxWhenMissing ? 0 : num(row[taxCol])
        const payable = payCols.reduce((sum, col) => sum + num(row[col]), 0)
        const deductionsSum = deductionCols.reduce((sum, col) => sum + num(row[col]), 0)
        const withholding = roundMoney(deductionsSum + taxAmount)
        const actual = roundMoney(payable - withholding)
        const payableRounded = roundMoney(payable)

        const assignments = [
          `${quoteIdentifier(taxCol)} = ?`,
          ...(shouldRewriteTax ? [`${quoteIdentifier(inactiveTaxCol)} = ?`] : []),
          `${quoteIdentifier(payableCol)} = ?`,
          `${quoteIdentifier(withholdingCol)} = ?`,
          `${quoteIdentifier(actualCol)} = ?`,
          '"md_updated_at" = ?'
        ].join(', ')
        const params: unknown[] = [
          taxAmount,
          ...(shouldRewriteTax ? [0] : []),
          payableRounded,
          withholding,
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
  try {
    const worksheet = getWorksheetByName(worksheetName)
    const columns = getWorksheetLocalColumns(worksheet)
    const colByName = (name: string): string | undefined =>
      columns.find((column) => column.field.name === name)?.columnName
    const idColumn = colByName('证件号码')
    const payableColumn = colByName('应发工资小计')
    const deductionColumn = colByName('代扣工资')
    const actualPayColumn = colByName('实发合计')
    if (!idColumn || !actualPayColumn) return { rowCount: 0, actualPayTotal: 0 }
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
  } catch {
    return { rowCount: 0, actualPayTotal: 0 }
  }
}

export async function comparePayrollPeople(
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

export async function buildIntegratedActiveWriteBackPlan(
  sourcePeople: PayrollPerson[]
): Promise<IntegratedWriteBackPlan> {
  const settings = await readMonthlyPayrollSettings()
  const taxField = settings.taxField
  return buildIntegratedWorksheetWriteBackPlan(
    sourcePeople,
    '在职工资',
    getActiveCompareFields(taxField),
    '在职工资 缺少证件号码字段',
    (targetFieldName) => targetFieldName === taxField ? '001' : undefined
  )
}

export async function buildIntegratedOtherWriteBackPlan(
  sourcePeople: PayrollPerson[]
): Promise<IntegratedWriteBackPlan> {
  return buildIntegratedWorksheetWriteBackPlan(
    sourcePeople,
    '其他工资',
    survivorCompareFields,
    '其他工资 缺少证件号码字段'
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

export function mergeIntegratedWriteBackPlans(...plans: IntegratedWriteBackPlan[]): IntegratedWriteBackPlan {
  return {
    changes: plans.flatMap((plan) => plan.changes),
    manual: plans.flatMap((plan) => plan.manual)
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

export async function loadIntegratedRows(worksheetName: string): Promise<IntegratedRow[]> {
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

function formatCompareValue(value: unknown): string {
  if (typeof value === 'number') return formatMoney(value)
  return text(value) || '空'
}
