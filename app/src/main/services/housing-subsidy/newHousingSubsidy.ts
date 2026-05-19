import { all, getDatabase, run } from '../../db/connection'
import { quoteIdentifier } from '../../db/schema'
import type { RuleResult, WorksheetMeta } from '../../../shared/types'
import { failRule, okRule } from '../ruleResult'
import { findColumnByName, getWorksheetByName, tableNameOf } from '../worksheetTable'

type Row = Record<string, string | number | null>

type SheetCtx = {
  worksheet: WorksheetMeta
  table: string
}

const workflowName = '核算新房补'

export async function prepareNewHousingSubsidy(): Promise<RuleResult> {
  try {
    return await calculateRetiredHousingSubsidy()
  } catch (error) {
    return failRule(workflowName, error)
  }
}

export async function writeBackNewHousingSubsidyToRetired(): Promise<RuleResult> {
  const writeBackWorkflowName = '执行新退休房补'
  try {
    return await writeBackRetiredHousingSubsidy(writeBackWorkflowName)
  } catch (error) {
    return failRule(writeBackWorkflowName, error)
  }
}

async function calculateRetiredHousingSubsidy(): Promise<RuleResult> {
  const source = getSheetCtx('人员明细导出')
  const retired = getSheetCtx('一体化退休')
  const target = getSheetCtx('新房补')

  const sourceColumns = {
    name: findColumnByName(source.worksheet, '姓名'),
    idCard: findColumnByName(source.worksheet, '证件号码'),
    standard: findColumnByName(source.worksheet, '待遇标准')
  }
  const retiredColumns = {
    name: findColumnByName(retired.worksheet, '姓名'),
    idCard: findColumnByName(retired.worksheet, '证件号码'),
    unitName: findColumnByName(retired.worksheet, '单位名称'),
    housing: findColumnByName(retired.worksheet, '住房补贴')
  }
  const targetColumns = {
    name: findColumnByName(target.worksheet, '姓名'),
    idCard: findColumnByName(target.worksheet, '证件号码'),
    subsidy: findColumnByName(target.worksheet, '退休提租补贴'),
    unitName: findColumnByName(target.worksheet, '单位名称')
  }

  const database = await getDatabase()
  const existingTargetRows = await all<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count FROM ${target.table}`
  )
  const existingTargetCount = existingTargetRows[0]?.count ?? 0
  if (existingTargetCount > 0) {
    throw new Error(
      `新房补已有 ${existingTargetCount} 条核定结果。新房补当年原则上只核定一次，为防止重复操作，本次未重新核定；如确需重新核定，请先确认并清空新房补旧结果后再执行。`
    )
  }

  const sourceRows = await all<Row>(database, `SELECT * FROM ${source.table}`)
  const retiredRows = await all<Row>(database, `SELECT * FROM ${retired.table}`)
  const sourceIdCards = new Set<string>()
  const retiredByIdCard = new Map<string, Row>()

  for (const row of retiredRows) {
    const idCard = normalizeIdCard(row[retiredColumns.idCard])
    if (!idCard) continue
    const previous = retiredByIdCard.get(idCard)
    if (!previous || num(row.id) > num(previous.id)) retiredByIdCard.set(idCard, row)
  }

  let generated = 0
  let missingFromRetired = 0
  let missingFromSource = 0
  const now = new Date().toISOString()

  await run(database, `DELETE FROM lookup_failures WHERE workflow = ?`, [workflowName])
  await run(database, 'BEGIN TRANSACTION')
  try {
    await run(database, `DELETE FROM ${target.table}`)
    await run(database, `DELETE FROM import_batch_rows WHERE worksheet_name = ?`, [
      target.worksheet.name
    ])

    for (const row of sourceRows) {
      const idCard = normalizeIdCard(row[sourceColumns.idCard])
      if (!idCard) continue
      sourceIdCards.add(idCard)
      const retiredRow = retiredByIdCard.get(idCard)
      if (!retiredRow) {
        missingFromRetired += 1
        await insertLookupFailure({
          worksheet: source.worksheet.name,
          idCard,
          name: text(row[sourceColumns.name]),
          lookupTable: retired.worksheet.name,
          lookupKey: '证件号码',
          lookupValue: idCard,
          reason: '一体化退休中未找到该证件号码'
        })
        continue
      }

      const standard = num(row[sourceColumns.standard])
      const housing = num(retiredRow[retiredColumns.housing])
      const subsidy = Math.ceil((standard + housing) * 0.2)

      await run(
        database,
        `INSERT INTO ${target.table}
          (${quoteIdentifier(targetColumns.name)}, ${quoteIdentifier(targetColumns.idCard)}, ${quoteIdentifier(targetColumns.subsidy)}, ${quoteIdentifier(targetColumns.unitName)}, "md_created_at", "md_updated_at")
         VALUES (?, ?, ?, ?, ?, ?)`,
        [text(row[sourceColumns.name]), idCard, subsidy, text(retiredRow[retiredColumns.unitName]), now, now]
      )
      generated += 1
    }

    for (const retiredRow of retiredByIdCard.values()) {
      const idCard = normalizeIdCard(retiredRow[retiredColumns.idCard])
      if (!idCard || sourceIdCards.has(idCard)) continue
      missingFromSource += 1
      await insertLookupFailure({
        worksheet: retired.worksheet.name,
        idCard,
        name: text(retiredRow[retiredColumns.name]),
        lookupTable: source.worksheet.name,
        lookupKey: '证件号码',
        lookupValue: idCard,
        reason: '一体化退休中存在该人员，但人员明细导出中未找到该证件号码'
      })
    }

    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  const warnings = [
    ...(missingFromRetired > 0
      ? [`${missingFromRetired} 人在人员明细导出中存在，但未在一体化退休中找到，已写入查询失败日志`]
      : []),
    ...(missingFromSource > 0
      ? [`${missingFromSource} 人在一体化退休中存在，但未在人员明细导出中找到，已写入查询失败日志`]
      : [])
  ]
  return okRule(
    workflowName,
    generated,
    [`已按（待遇标准 + 一体化退休住房补贴）* 0.2 生成退休提租补贴，见分进元`],
    warnings
  )
}

async function writeBackRetiredHousingSubsidy(workflow: string): Promise<RuleResult> {
  const source = getSheetCtx('新房补')
  const retired = getSheetCtx('一体化退休')

  const sourceColumns = {
    name: findColumnByName(source.worksheet, '姓名'),
    idCard: findColumnByName(source.worksheet, '证件号码'),
    subsidy: findColumnByName(source.worksheet, '退休提租补贴')
  }
  const retiredColumns = {
    name: findColumnByName(retired.worksheet, '姓名'),
    idCard: findColumnByName(retired.worksheet, '证件号码'),
    housing: findColumnByName(retired.worksheet, '住房补贴')
  }

  const database = await getDatabase()
  const sourceRows = await all<Row>(database, `SELECT * FROM ${source.table}`)
  const retiredRows = await all<Row>(database, `SELECT * FROM ${retired.table}`)
  const sourceIdCards = new Set<string>()
  const retiredByIdCard = new Map<string, Row>()

  for (const row of retiredRows) {
    const idCard = normalizeIdCard(row[retiredColumns.idCard])
    if (!idCard) continue
    const previous = retiredByIdCard.get(idCard)
    if (!previous || num(row.id) > num(previous.id)) retiredByIdCard.set(idCard, row)
  }

  let updated = 0
  let failures = 0
  const now = new Date().toISOString()

  await run(database, `DELETE FROM lookup_failures WHERE workflow = ?`, [workflow])
  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const row of sourceRows) {
      const idCard = normalizeIdCard(row[sourceColumns.idCard])
      if (!idCard) continue
      sourceIdCards.add(idCard)
      const retiredRow = retiredByIdCard.get(idCard)
      if (!retiredRow) {
        failures += 1
        await insertLookupFailure({
          workflow,
          worksheet: source.worksheet.name,
          idCard,
          name: text(row[sourceColumns.name]),
          lookupTable: retired.worksheet.name,
          lookupKey: '证件号码',
          lookupValue: idCard,
          reason: '一体化退休中未找到该证件号码，无法回写退休房补'
        })
        continue
      }

      await run(
        database,
        `UPDATE ${retired.table}
         SET ${quoteIdentifier(retiredColumns.housing)} = ?, "md_updated_at" = ?
         WHERE "id" = ?`,
        [num(row[sourceColumns.subsidy]), now, retiredRow.id]
      )
      updated += 1
    }

    for (const row of retiredRows) {
      const idCard = normalizeIdCard(row[retiredColumns.idCard])
      if (!idCard || sourceIdCards.has(idCard)) continue
      failures += 1
      await insertLookupFailure({
        workflow,
        worksheet: retired.worksheet.name,
        idCard,
        name: text(row[retiredColumns.name]),
        lookupTable: source.worksheet.name,
        lookupKey: '证件号码',
        lookupValue: idCard,
        reason: '一体化退休中存在该人员，但新房补中未生成对应记录'
      })
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  const warnings = failures > 0 ? [`${failures} 人未在一体化退休中找到，已写入查询失败日志`] : []
  return okRule(workflow, updated, ['已将新房补的退休提租补贴回写到一体化退休住房补贴'], warnings)
}

function getSheetCtx(name: string): SheetCtx {
  const worksheet = getWorksheetByName(name)
  return {
    worksheet,
    table: tableNameOf(worksheet)
  }
}

async function insertLookupFailure(args: {
  workflow?: string
  worksheet: string
  idCard: string
  name: string
  lookupTable: string
  lookupKey: string
  lookupValue: string
  reason: string
}): Promise<void> {
  const database = await getDatabase()
  await run(
    database,
    `
      INSERT INTO lookup_failures
        (workflow, worksheet, id_card, name, lookup_table, lookup_key, lookup_value, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      args.workflow ?? workflowName,
      args.worksheet,
      args.idCard,
      args.name,
      args.lookupTable,
      args.lookupKey,
      args.lookupValue,
      args.reason
    ]
  )
}

function normalizeIdCard(value: unknown): string {
  return text(value).replace(/[\s,]/g, '').toUpperCase()
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}
