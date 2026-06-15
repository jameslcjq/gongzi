import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { all, getDatabase, run } from '../../db/connection'
import { quoteIdentifier } from '../../db/schema'
import * as XLSX from 'xlsx'
import type { RuleResult } from '../../../shared/types'
import { failRule, okRule } from '../ruleResult'
import { findColumnByName, getWorksheetByName, tableNameOf } from '../worksheetTable'
import { getMonthlyOutputPath } from '../../config/paths'

const N = {
  integratedActive: '\u5728\u804c\u5de5\u8d44',
  integratedRetired: '\u9000\u4f11\u5de5\u8d44',
  allowance: '\u4e61\u9547\u8865\u8d34',
  lookup: '\u4e61\u9547\u5de5\u4f5c\u5e74\u9650\u5bf9\u7167',
  adjustWorkflow: '\u8c03\u6574\u4e61\u9547\u8865\u8d34',
  fillIdCardWorkflow: '\u8865\u5168\u8eab\u4efd\u8bc1\u53f7'
}

const F = {
  name: '\u59d3\u540d',
  idCard: '\u8eab\u4efd\u8bc1\u53f7',
  certificateNo: '\u8bc1\u4ef6\u53f7\u7801',
  workYears: '\u5de5\u9f84',
  townshipYears: '\u4e61\u9547\u5de5\u4f5c\u5e74\u9650',
  newStandard: '\u65b0\u6807\u51c6',
  oldStandard: '\u539f\u6807\u51c6',
  effectiveTime: '\u6267\u884c\u65f6\u95f4',
  lookupAmount: '\u91d1\u989d'
}

const annualIncreaseSettingKey = 'township_allowance_last_annual_increase_year'

export async function applyAnnualTownshipYearIncreaseIfNeeded(
  now = new Date()
): Promise<{ applied: boolean; year: number; affectedRows: number; messages: string[]; warnings: string[] }> {
  const year = now.getFullYear()
  const database = await getDatabase()
  const setting = await all<{ value: string | null }>(
    database,
    `SELECT value FROM app_settings WHERE key = ?`,
    [annualIncreaseSettingKey]
  )
  const lastAppliedYear = Number(setting[0]?.value ?? 0)
  if (Number.isFinite(lastAppliedYear) && lastAppliedYear >= year) {
    return { applied: false, year, affectedRows: 0, messages: [], warnings: [] }
  }

  const result = await increaseTownshipYears(now)
  if (!result.ok) {
    throw new Error([...result.messages, ...result.warnings].join('；') || '乡镇补贴年度递增失败')
  }

  await run(
    database,
    `
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `,
    [annualIncreaseSettingKey, String(year)]
  )

  return {
    applied: true,
    year,
    affectedRows: result.affectedRows,
    messages: result.messages,
    warnings: result.warnings
  }
}

export async function onTownshipAllowanceChanged(): Promise<RuleResult> {
  try {
    const result = await applyTownshipAllowanceFromLookup()
    return okRule(
      N.adjustWorkflow,
      result.affectedRows,
      [
        '\u6309\u4e61\u9547\u5de5\u4f5c\u5e74\u9650\u53d6\u5bf9\u7167\u8868\u4e2d\u5c0f\u4e8e\u7b49\u4e8e\u5f53\u524d\u5e74\u9650\u7684\u6700\u9ad8\u6863\u4f4d\uff0c\u56de\u5199\u65b0\u6807\u51c6'
      ],
      result.warnings
    )
  } catch (error) {
    return failRule(N.adjustWorkflow, error)
  }
}

export async function fillTownshipAllowanceIdCards(): Promise<RuleResult> {
  try {
    const result = await applyTownshipAllowanceIdCards()
    const messages = [
      `\u5df2\u8865\u5168\u8eab\u4efd\u8bc1\u53f7 ${result.updatedRows} \u6761`,
      `\u5df2\u8df3\u8fc7\u5df2\u6709\u8eab\u4efd\u8bc1\u53f7 ${result.skippedExistingRows} \u6761`
    ]
    if (result.reportPath) {
      messages.push(`\u5f02\u5e38\u540d\u5355\u5df2\u5bfc\u51fa\uff1a${result.reportPath}`)
    }
    return okRule(N.fillIdCardWorkflow, result.updatedRows, messages, result.warnings)
  } catch (error) {
    return failRule(N.fillIdCardWorkflow, error)
  }
}

export async function increaseTownshipYears(now = new Date()): Promise<RuleResult> {
  try {
    const allowance = getWorksheetByName(N.allowance)
    const workYearsColumn = findColumnByName(allowance, F.workYears)
    const yearsColumn = findColumnByName(allowance, F.townshipYears)
    const standardColumn = findColumnByName(allowance, F.newStandard)
    const oldStandardColumn = findColumnByName(allowance, F.oldStandard)
    const effectiveTimeColumn = findColumnByName(allowance, F.effectiveTime)
    const tableName = tableNameOf(allowance)
    const currentYear = now.getFullYear()
    const currentEffectiveTime = `${currentYear}.01`
    const effectiveYear = `CAST(substr(TRIM(CAST(${quoteIdentifier(effectiveTimeColumn)} AS TEXT)), 1, 4) AS INTEGER)`
    const yearDelta = `(${currentYear} - ${effectiveYear})`

    const database = await getDatabase()
    const adjusted = await all<{ count: number }>(
      database,
      `
        SELECT COUNT(*) AS count FROM ${tableName}
        WHERE ${effectiveYear} BETWEEN 1900 AND ${currentYear - 1}
      `
    )
    const alreadyCurrent = await all<{ count: number }>(
      database,
      `
        SELECT COUNT(*) AS count FROM ${tableName}
        WHERE ${effectiveYear} >= ${currentYear}
      `
    )
    const missingEffectiveTime = await all<{ count: number }>(
      database,
      `
        SELECT COUNT(*) AS count FROM ${tableName}
        WHERE ${effectiveYear} IS NULL OR ${effectiveYear} NOT BETWEEN 1900 AND 2100
      `
    )

    await run(database, 'BEGIN TRANSACTION')
    try {
      await run(
        database,
        `
          UPDATE ${tableName}
          SET
            ${quoteIdentifier(oldStandardColumn)} = ${quoteIdentifier(standardColumn)},
            ${quoteIdentifier(workYearsColumn)} = COALESCE(CAST(NULLIF(${quoteIdentifier(workYearsColumn)}, '') AS REAL), 0) + ${yearDelta},
            ${quoteIdentifier(yearsColumn)} = COALESCE(CAST(NULLIF(${quoteIdentifier(yearsColumn)}, '') AS REAL), 0) + ${yearDelta},
            ${quoteIdentifier(effectiveTimeColumn)} = ?,
            "md_updated_at" = ?
          WHERE ${effectiveYear} BETWEEN 1900 AND ${currentYear - 1}
        `,
        [currentEffectiveTime, now.toISOString()]
      )
      await run(database, 'COMMIT')
    } catch (error) {
      await run(database, 'ROLLBACK')
      throw error
    }

    const result = await applyTownshipAllowanceFromLookup()
    const adjustedRows = adjusted[0]?.count ?? 0
    const alreadyCurrentRows = alreadyCurrent[0]?.count ?? 0
    const missingEffectiveTimeRows = missingEffectiveTime[0]?.count ?? 0
    const warnings = [...result.warnings]
    if (alreadyCurrentRows > 0) {
      warnings.push(`有 ${alreadyCurrentRows} 条乡镇补贴记录执行时间已是 ${currentYear} 年或以后，本次未递增`)
    }
    if (missingEffectiveTimeRows > 0) {
      warnings.push(`有 ${missingEffectiveTimeRows} 条乡镇补贴记录缺少有效执行时间，本次未自动递增`)
    }

    return okRule(
      N.adjustWorkflow,
      adjustedRows,
      [
        adjustedRows > 0
          ? `已按执行时间递增 ${adjustedRows} 条乡镇补贴记录的工龄、乡镇工作年限，并联动刷新新标准 ${result.affectedRows} 条`
          : `乡镇补贴执行时间已是 ${currentYear} 年，本次无需递增`
      ],
      warnings
    )
  } catch (error) {
    return failRule(N.adjustWorkflow, error)
  }
}

export async function normalizeTownshipAllowanceImportedRows(
  batchId: number,
  now = new Date()
): Promise<{ adjustedRows: number; refreshedRows: number }> {
  const allowance = getWorksheetByName(N.allowance)
  const lookup = getWorksheetByName(N.lookup)

  const workYearsColumn = findColumnByName(allowance, F.workYears)
  const yearsColumn = findColumnByName(allowance, F.townshipYears)
  const standardColumn = findColumnByName(allowance, F.newStandard)
  const oldStandardColumn = findColumnByName(allowance, F.oldStandard)
  const effectiveTimeColumn = findColumnByName(allowance, F.effectiveTime)
  const lookupYearsColumn = findColumnByName(lookup, F.townshipYears)
  const lookupAmountColumn = findColumnByName(lookup, F.lookupAmount)

  const allowanceTable = tableNameOf(allowance)
  const lookupTable = tableNameOf(lookup)
  const currentYear = now.getFullYear()
  const effectiveYear = `CAST(substr(TRIM(CAST(${quoteIdentifier(effectiveTimeColumn)} AS TEXT)), 1, 4) AS INTEGER)`
  const yearDelta = `CASE WHEN ${currentYear} > ${effectiveYear} THEN ${currentYear} - ${effectiveYear} ELSE 0 END`
  const batchFilter = `
    "id" IN (
      SELECT record_id FROM import_batch_rows
      WHERE batch_id = ${Number(batchId)} AND worksheet_name = '${N.allowance.replaceAll("'", "''")}'
    )
  `

  const database = await getDatabase()
  const adjusted = await all<{ count: number }>(
    database,
    `
      SELECT COUNT(*) AS count FROM ${allowanceTable}
      WHERE ${batchFilter}
        AND ${effectiveYear} BETWEEN 1900 AND ${currentYear}
        AND ${yearDelta} > 0
    `
  )

  await run(
    database,
    `
      UPDATE ${allowanceTable}
      SET
        ${quoteIdentifier(oldStandardColumn)} = ${quoteIdentifier(standardColumn)},
        ${quoteIdentifier(workYearsColumn)} =
          COALESCE(CAST(NULLIF(${quoteIdentifier(workYearsColumn)}, '') AS REAL), 0) + ${yearDelta},
        ${quoteIdentifier(yearsColumn)} =
          COALESCE(CAST(NULLIF(${quoteIdentifier(yearsColumn)}, '') AS REAL), 0) + ${yearDelta}
      WHERE ${batchFilter}
        AND ${effectiveYear} BETWEEN 1900 AND ${currentYear}
        AND ${yearDelta} > 0
    `
  )

  const refreshed = await refreshTownshipStandards({
    allowanceTable,
    lookupTable,
    yearsColumn,
    standardColumn,
    lookupYearsColumn,
    lookupAmountColumn,
    filter: batchFilter
  })

  return { adjustedRows: adjusted[0]?.count ?? 0, refreshedRows: refreshed }
}

async function applyTownshipAllowanceFromLookup(): Promise<{
  affectedRows: number
  warnings: string[]
}> {
  const allowance = getWorksheetByName(N.allowance)
  const lookup = getWorksheetByName(N.lookup)

  const yearsColumn = findColumnByName(allowance, F.townshipYears)
  const standardColumn = findColumnByName(allowance, F.newStandard)
  const lookupYearsColumn = findColumnByName(lookup, F.townshipYears)
  const lookupAmountColumn = findColumnByName(lookup, F.lookupAmount)

  const allowanceTable = tableNameOf(allowance)
  const lookupTable = tableNameOf(lookup)

  const database = await getDatabase()
  await refreshTownshipStandards({
    allowanceTable,
    lookupTable,
    yearsColumn,
    standardColumn,
    lookupYearsColumn,
    lookupAmountColumn
  })

  const matched = await all<{ count: number }>(
    database,
    `
      SELECT COUNT(*) AS count FROM ${allowanceTable}
      WHERE ${quoteIdentifier(yearsColumn)} IS NOT NULL AND ${quoteIdentifier(yearsColumn)} <> ''
        AND EXISTS (
          SELECT 1 FROM ${lookupTable}
          WHERE CAST(${lookupTable}.${quoteIdentifier(lookupYearsColumn)} AS REAL) <=
                CAST(${allowanceTable}.${quoteIdentifier(yearsColumn)} AS REAL)
        )
    `
  )
  const totalWithYears = await all<{ count: number }>(
    database,
    `
      SELECT COUNT(*) AS count FROM ${allowanceTable}
      WHERE ${quoteIdentifier(yearsColumn)} IS NOT NULL AND ${quoteIdentifier(yearsColumn)} <> ''
    `
  )

  const matchedCount = matched[0]?.count ?? 0
  const totalCount = totalWithYears[0]?.count ?? 0
  const warnings: string[] = []
  if (matchedCount < totalCount) {
    warnings.push(
      `\u6709 ${totalCount - matchedCount} \u6761\u8bb0\u5f55\u5728"\u4e61\u9547\u5de5\u4f5c\u5e74\u9650\u5bf9\u7167"\u4e2d\u672a\u627e\u5230\u5339\u914d\u5e74\u9650\u6bb5\uff0c\u8bf7\u8865\u5145\u5bf9\u7167\u8868`
    )
  }

  return { affectedRows: matchedCount, warnings }
}

async function applyTownshipAllowanceIdCards(): Promise<{
  updatedRows: number
  skippedExistingRows: number
  warnings: string[]
  reportPath?: string
}> {
  const allowance = getWorksheetByName(N.allowance)
  const active = getWorksheetByName(N.integratedActive)
  const retired = getWorksheetByName(N.integratedRetired)

  const allowanceNameColumn = findColumnByName(allowance, F.name)
  const allowanceIdCardColumn = findColumnByName(allowance, F.idCard)
  const activeNameColumn = findColumnByName(active, F.name)
  const activeIdCardColumn = findColumnByName(active, F.certificateNo)
  const retiredNameColumn = findColumnByName(retired, F.name)
  const retiredIdCardColumn = findColumnByName(retired, F.certificateNo)

  const allowanceTable = tableNameOf(allowance)
  const activeTable = tableNameOf(active)
  const retiredTable = tableNameOf(retired)
  const database = await getDatabase()

  const identityRows = [
    ...(await loadNameIdentityRows(database, activeTable, activeNameColumn, activeIdCardColumn)),
    ...(await loadNameIdentityRows(database, retiredTable, retiredNameColumn, retiredIdCardColumn))
  ]

  const idCardsByName = new Map<string, Set<string>>()
  for (const row of identityRows) {
    const name = normalizeName(row.name)
    const idCard = normalizeIdCard(row.id_card)
    if (!name || !idCard) continue
    const list = idCardsByName.get(name) ?? new Set<string>()
    list.add(idCard)
    idCardsByName.set(name, list)
  }

  const allowanceRows = await all<{ id: number; name: string | null; id_card: string | null }>(
    database,
    `
      SELECT
        "id" AS id,
        TRIM(CAST(${quoteIdentifier(allowanceNameColumn)} AS TEXT)) AS name,
        TRIM(CAST(${quoteIdentifier(allowanceIdCardColumn)} AS TEXT)) AS id_card
      FROM ${allowanceTable}
      ORDER BY "id"
    `
  )

  let updatedRows = 0
  let skippedExistingRows = 0
  const reportRows: Array<{
    type: string
    name: string
    currentIdCard: string
    matchedIdCards: string
    remark: string
  }> = []

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const row of allowanceRows) {
      const name = normalizeName(row.name)
      const currentIdCard = normalizeIdCard(row.id_card)
      if (currentIdCard) {
        skippedExistingRows += 1
        continue
      }
      if (!name) {
        reportRows.push({
          type: '\u59d3\u540d\u4e3a\u7a7a',
          name: '',
          currentIdCard,
          matchedIdCards: '',
          remark: '\u4e61\u9547\u8865\u8d34\u8bb0\u5f55\u7f3a\u5c11\u59d3\u540d'
        })
        continue
      }

      const matched = Array.from(idCardsByName.get(name) ?? [])
      if (matched.length === 0) {
        reportRows.push({
          type: '\u67e5\u627e\u4e0d\u5230',
          name,
          currentIdCard,
          matchedIdCards: '',
          remark: '\u5728\u804c\u5de5\u8d44\u548c\u9000\u4f11\u5de5\u8d44\u4e2d\u6ca1\u6709\u627e\u5230\u8be5\u59d3\u540d'
        })
        continue
      }
      if (matched.length > 1) {
        reportRows.push({
          type: '\u91cd\u540d',
          name,
          currentIdCard,
          matchedIdCards: matched.join('\u3001'),
          remark: '\u5728\u804c\u5de5\u8d44/\u9000\u4f11\u5de5\u8d44\u4e2d\u540c\u540d\u5bf9\u5e94\u591a\u4e2a\u8bc1\u4ef6\u53f7\u7801'
        })
        continue
      }

      await run(
        database,
        `UPDATE ${allowanceTable} SET ${quoteIdentifier(allowanceIdCardColumn)} = ? WHERE "id" = ?`,
        [matched[0], row.id]
      )
      updatedRows += 1
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }

  const reportPath = reportRows.length > 0 ? writeIdCardReport(reportRows) : undefined
  const warnings =
    reportRows.length > 0
      ? [`\u6709 ${reportRows.length} \u6761\u8bb0\u5f55\u672a\u80fd\u81ea\u52a8\u8865\u5168\uff0c\u8bf7\u67e5\u770b\u62a5\u544a\uff1a${reportPath}`]
      : []

  return { updatedRows, skippedExistingRows, warnings, reportPath }
}

async function loadNameIdentityRows(
  database: Awaited<ReturnType<typeof getDatabase>>,
  tableName: string,
  nameColumn: string,
  idCardColumn: string
): Promise<Array<{ name: string | null; id_card: string | null }>> {
  return all<{ name: string | null; id_card: string | null }>(
    database,
    `
      SELECT
        TRIM(CAST(${quoteIdentifier(nameColumn)} AS TEXT)) AS name,
        TRIM(CAST(${quoteIdentifier(idCardColumn)} AS TEXT)) AS id_card
      FROM ${tableName}
      WHERE ${quoteIdentifier(nameColumn)} IS NOT NULL
        AND ${quoteIdentifier(idCardColumn)} IS NOT NULL
        AND TRIM(CAST(${quoteIdentifier(nameColumn)} AS TEXT)) <> ''
        AND TRIM(CAST(${quoteIdentifier(idCardColumn)} AS TEXT)) <> ''
    `
  )
}

function writeIdCardReport(
  rows: Array<{
    type: string
    name: string
    currentIdCard: string
    matchedIdCards: string
    remark: string
  }>
): string {
  const reportFolder = getMonthlyOutputPath()
  mkdirSync(reportFolder, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = join(reportFolder, `\u4e61\u9547\u8865\u8d34-\u8eab\u4efd\u8bc1\u53f7\u8865\u5168\u63d0\u793a-${stamp}.xlsx`)
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((row) => ({
      '\u7c7b\u578b': row.type,
      '\u59d3\u540d': row.name,
      '\u5f53\u524d\u8eab\u4efd\u8bc1\u53f7': row.currentIdCard,
      '\u5339\u914d\u5230\u7684\u8bc1\u4ef6\u53f7\u7801': row.matchedIdCards,
      '\u5907\u6ce8': row.remark
    }))
  )
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '\u672a\u8865\u5168\u540d\u5355')
  writeFileSync(filePath, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }))
  return filePath
}

function normalizeName(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function normalizeIdCard(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim().toUpperCase()
}

async function refreshTownshipStandards(options: {
  allowanceTable: string
  lookupTable: string
  yearsColumn: string
  standardColumn: string
  lookupYearsColumn: string
  lookupAmountColumn: string
  filter?: string
}): Promise<number> {
  const database = await getDatabase()
  const filter = options.filter ? ` AND ${options.filter}` : ''

  const matched = await all<{ count: number }>(
    database,
    `
      SELECT COUNT(*) AS count FROM ${options.allowanceTable}
      WHERE ${quoteIdentifier(options.yearsColumn)} IS NOT NULL
        AND ${quoteIdentifier(options.yearsColumn)} <> ''
        ${filter}
        AND EXISTS (
          SELECT 1 FROM ${options.lookupTable}
          WHERE CAST(${options.lookupTable}.${quoteIdentifier(options.lookupYearsColumn)} AS REAL) <=
                CAST(${options.allowanceTable}.${quoteIdentifier(options.yearsColumn)} AS REAL)
        )
    `
  )

  await run(
    database,
    `
      UPDATE ${options.allowanceTable}
      SET ${quoteIdentifier(options.standardColumn)} = (
        SELECT ${options.lookupTable}.${quoteIdentifier(options.lookupAmountColumn)}
        FROM ${options.lookupTable}
        WHERE CAST(${options.lookupTable}.${quoteIdentifier(options.lookupYearsColumn)} AS REAL) <=
              CAST(${options.allowanceTable}.${quoteIdentifier(options.yearsColumn)} AS REAL)
        ORDER BY CAST(${options.lookupTable}.${quoteIdentifier(options.lookupYearsColumn)} AS REAL) DESC
        LIMIT 1
      )
      WHERE ${quoteIdentifier(options.yearsColumn)} IS NOT NULL
        AND ${quoteIdentifier(options.yearsColumn)} <> ''
        ${filter}
    `
  )

  return matched[0]?.count ?? 0
}
