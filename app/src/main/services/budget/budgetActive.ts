import { all, getDatabase, run } from '../../db/connection'
import { quoteIdentifier } from '../../db/schema'
import type { RuleResult } from '../../../shared/types'
import { failRule, okRule } from '../ruleResult'
import {
  findColumnByName,
  getWorksheetByName,
  tableNameOf,
  tryFindColumnByName
} from '../worksheetTable'
import { normalizeSalaryGradeForCompare } from '../salaryLevelNormalize'

export async function updateSalaryGrade(): Promise<RuleResult> {
  try {
    const result = await applySalaryGradeFromLookup()
    return okRule('更新薪级', result.affectedRows, [], result.warnings)
  } catch (error) {
    return failRule('更新薪级', error)
  }
}

export async function increaseSalaryGrade(): Promise<RuleResult> {
  try {
    const budgetActive = getWorksheetByName('预算在职')
    const gradeColumn = findColumnByName(budgetActive, '薪级')
    const tableName = tableNameOf(budgetActive)

    const database = await getDatabase()
    await run(database, 'BEGIN TRANSACTION')
    try {
      await run(
        database,
        `UPDATE ${tableName} SET ${quoteIdentifier(gradeColumn)} = COALESCE(CAST(${quoteIdentifier(gradeColumn)} AS REAL), 0) + 2`
      )
      await run(database, 'COMMIT')
    } catch (error) {
      await run(database, 'ROLLBACK')
      throw error
    }

    const result = await applySalaryGradeFromLookup()
    const total = await countRows(tableName)

    return okRule(
      '增加薪级',
      total,
      [`所有预算在职人员薪级 +2，已联动刷新薪级工资 ${result.affectedRows} 条`],
      result.warnings
    )
  } catch (error) {
    return failRule('增加薪级', error)
  }
}

export async function calculateBudgetActiveBaseSalary(): Promise<RuleResult> {
  try {
    const budgetActive = getWorksheetByName('预算在职')
    const integratedActive = getWorksheetByName('在职工资')

    const idCardColumn = findColumnByName(budgetActive, '证件号码*')
    const allowanceColumn = findColumnByName(budgetActive, '岗位津贴')
    const baseColumn = findColumnByName(budgetActive, '基础性绩效工资')

    const integratedIdColumn = findColumnByName(integratedActive, '证件号码')
    const integratedLivingAllowance = findColumnByName(integratedActive, '生活补贴')

    const budgetTable = tableNameOf(budgetActive)
    const integratedTable = tableNameOf(integratedActive)

    const database = await getDatabase()
    const sql = `
      UPDATE ${budgetTable}
      SET ${quoteIdentifier(baseColumn)} =
        COALESCE(CAST(${quoteIdentifier(allowanceColumn)} AS REAL), 0) +
        COALESCE((
          SELECT CAST(${quoteIdentifier(integratedLivingAllowance)} AS REAL)
          FROM ${integratedTable}
          WHERE ${integratedTable}.${quoteIdentifier(integratedIdColumn)} = ${budgetTable}.${quoteIdentifier(idCardColumn)}
          ORDER BY ${integratedTable}."id" DESC
          LIMIT 1
        ), 0)
      WHERE ${quoteIdentifier(idCardColumn)} IS NOT NULL AND ${quoteIdentifier(idCardColumn)} <> ''
    `
    await run(database, sql)

    const total = await countRows(budgetTable)
    const matchedCount = await all<{ count: number }>(
      database,
      `
        SELECT COUNT(*) AS count FROM ${budgetTable}
        WHERE ${quoteIdentifier(idCardColumn)} IS NOT NULL AND ${quoteIdentifier(idCardColumn)} <> ''
          AND EXISTS (
            SELECT 1 FROM ${integratedTable}
            WHERE ${integratedTable}.${quoteIdentifier(integratedIdColumn)} = ${budgetTable}.${quoteIdentifier(idCardColumn)}
          )
      `
    )

    const matched = matchedCount[0]?.count ?? 0
    const warnings: string[] = []
    if (matched < total) {
      warnings.push(`有 ${total - matched} 条预算在职在"在职工资"中未找到生活补贴，已按 0 计算`)
    }

    return okRule('计算基础性绩效工资', matched, ['基础性绩效工资 = 岗位津贴 + 生活补贴'], warnings)
  } catch (error) {
    return failRule('计算基础性绩效工资', error)
  }
}

async function applySalaryGradeFromLookup(): Promise<{ affectedRows: number; warnings: string[] }> {
  const budgetActive = getWorksheetByName('预算在职')
  const lookup = getWorksheetByName('薪级工资对照')

  const gradeColumn = findColumnByName(budgetActive, '薪级')
  const salaryColumn =
    tryFindColumnByName(budgetActive, '薪级工资*') ?? findColumnByName(budgetActive, '薪级工资')
  const lookupGradeColumn = findColumnByName(lookup, '薪级')
  const lookupSalaryColumn = findColumnByName(lookup, '薪级工资')

  const budgetTable = tableNameOf(budgetActive)
  const lookupTable = tableNameOf(lookup)

  const database = await getDatabase()
  const lookupRows = await all<Record<string, unknown>>(database, `SELECT * FROM ${lookupTable}`)
  const salaryByGrade = new Map<string, unknown>()
  for (const row of lookupRows) {
    const key = normalizeSalaryGradeForCompare(row[lookupGradeColumn])
    if (key) salaryByGrade.set(key, row[lookupSalaryColumn])
  }

  const budgetRows = await all<Record<string, unknown>>(
    database,
    `SELECT "id", ${quoteIdentifier(gradeColumn)} AS grade FROM ${budgetTable}
     WHERE ${quoteIdentifier(gradeColumn)} IS NOT NULL AND ${quoteIdentifier(gradeColumn)} <> ''`
  )

  let matched = 0
  for (const row of budgetRows) {
    const salary = salaryByGrade.get(normalizeSalaryGradeForCompare(row.grade))
    if (salary === undefined) continue
    await run(
      database,
      `UPDATE ${budgetTable} SET ${quoteIdentifier(salaryColumn)} = ?, "md_updated_at" = ? WHERE "id" = ?`,
      [salary, new Date().toISOString(), row.id]
    )
    matched += 1
  }

  const totalGrade = budgetRows.length
  const warnings: string[] = []
  if (matched < totalGrade) {
    warnings.push(`有 ${totalGrade - matched} 条记录在"薪级工资对照"中未找到匹配薪级`)
  }

  return { affectedRows: matched, warnings }
}

async function countRows(tableName: string): Promise<number> {
  const database = await getDatabase()
  const rows = await all<{ count: number }>(database, `SELECT COUNT(*) AS count FROM ${tableName}`)
  return rows[0]?.count ?? 0
}

export const __internal = { applySalaryGradeFromLookup }

void tryFindColumnByName
