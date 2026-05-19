import { all, get, getDatabase, run, runWithLastId } from '../db/connection'
import { readWorksheetMetadata } from '../db/metadata'
import { getWorksheetLocalColumns, quoteIdentifier } from '../db/schema'
import type {
  PivotConfig,
  PivotFilterOp,
  PivotResult,
  WorksheetMeta
} from '../../shared/types'

export type PivotConfigSummary = {
  id: number
  name: string
  primaryWorksheetId: string
  primaryWorksheetName: string
  createdAt: string
  updatedAt: string
}

const idCardFieldCandidates = ['证件号码*', '证件号码', '身份证号', '身份证号码']

export function detectIdCardField(worksheet: WorksheetMeta): string | undefined {
  const byCtrlType = worksheet.fields.find((field) => field.controlType === 7)
  if (byCtrlType) return byCtrlType.name
  for (const candidate of idCardFieldCandidates) {
    const field = worksheet.fields.find((item) => item.name === candidate)
    if (field) return field.name
  }
  return undefined
}

export async function listPivotConfigs(): Promise<PivotConfigSummary[]> {
  const database = await getDatabase()
  const worksheets = readWorksheetMetadata()
  const rows = await all<{
    id: number
    name: string
    primary_worksheet_id: string
    created_at: string
    updated_at: string
  }>(
    database,
    `SELECT id, name, primary_worksheet_id, created_at, updated_at
     FROM pivot_configs ORDER BY id DESC`
  )

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    primaryWorksheetId: row.primary_worksheet_id,
    primaryWorksheetName:
      worksheets.find((item) => item.worksheetId === row.primary_worksheet_id)?.name ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

export async function getPivotConfig(id: number): Promise<PivotConfig | undefined> {
  const database = await getDatabase()
  const row = await get<{
    id: number
    name: string
    primary_worksheet_id: string
    config_json: string
    created_at: string
    updated_at: string
  }>(database, `SELECT * FROM pivot_configs WHERE id = ?`, [id])
  if (!row) return undefined

  const parsed = JSON.parse(row.config_json) as Omit<PivotConfig, 'id' | 'name' | 'primaryWorksheetId' | 'createdAt' | 'updatedAt'>
  return {
    id: row.id,
    name: row.name,
    primaryWorksheetId: row.primary_worksheet_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...parsed
  }
}

export async function savePivotConfig(config: PivotConfig): Promise<PivotConfig> {
  const database = await getDatabase()
  const stripped = stripConfig(config)
  const json = JSON.stringify(stripped)

  if (config.id) {
    await run(
      database,
      `UPDATE pivot_configs SET name = ?, primary_worksheet_id = ?, config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [config.name, config.primaryWorksheetId, json, config.id]
    )
    const next = await getPivotConfig(config.id)
    if (!next) throw new Error('保存后读取失败')
    return next
  }

  const result = await runWithLastId(
    database,
    `INSERT INTO pivot_configs (name, primary_worksheet_id, config_json) VALUES (?, ?, ?)`,
    [config.name, config.primaryWorksheetId, json]
  )
  const next = await getPivotConfig(result.lastId)
  if (!next) throw new Error('保存后读取失败')
  return next
}

export async function deletePivotConfig(id: number): Promise<void> {
  const database = await getDatabase()
  await run(database, `DELETE FROM pivot_configs WHERE id = ?`, [id])
}

function stripConfig(config: PivotConfig) {
  return {
    joins: config.joins,
    rows: config.rows,
    columns: config.columns,
    values: config.values,
    filters: config.filters,
    showRowSubtotal: config.showRowSubtotal,
    showRowGrandTotal: config.showRowGrandTotal,
    showColumnGrandTotal: config.showColumnGrandTotal
  }
}

export async function runPivot(config: PivotConfig): Promise<PivotResult> {
  const worksheets = readWorksheetMetadata()
  const primary = worksheets.find((item) => item.worksheetId === config.primaryWorksheetId)
  if (!primary) throw new Error('未找到主表')

  const aliasByWorksheetId = new Map<string, string>()
  aliasByWorksheetId.set(primary.worksheetId, 'T0')
  config.joins.forEach((join, index) => {
    aliasByWorksheetId.set(join.worksheetId, `T${index + 1}`)
  })

  const columnRefByWorksheetId = new Map<string, Map<string, string>>()
  for (const worksheet of worksheets) {
    const columns = getWorksheetLocalColumns(worksheet)
    const map = new Map<string, string>()
    for (const column of columns) {
      map.set(column.field.name, column.columnName)
    }
    columnRefByWorksheetId.set(worksheet.worksheetId, map)
  }

  function resolveColumn(worksheetId: string, fieldName: string): string {
    const alias = aliasByWorksheetId.get(worksheetId)
    if (!alias) throw new Error(`字段所在表未参与查询：${fieldName}`)
    const columnMap = columnRefByWorksheetId.get(worksheetId)
    const localColumn = columnMap?.get(fieldName)
    if (!localColumn) throw new Error(`字段不存在：${fieldName}`)
    return `${alias}.${quoteIdentifier(localColumn)}`
  }

  const rowExpressions = config.rows.map((row) => ({
    expr: resolveColumn(row.worksheetId, row.fieldName),
    alias: rowAliasFor(row.fieldName)
  }))
  const columnExpressions = config.columns.map((col) => ({
    expr: resolveColumn(col.worksheetId, col.fieldName),
    alias: rowAliasFor(col.fieldName)
  }))
  const valueExpressions = config.values.map((value, index) => {
    const ref = resolveColumn(value.worksheetId, value.fieldName)
    const aggExpr = buildAggregation(ref, value.agg)
    return {
      expr: aggExpr,
      alias: value.alias?.trim() || `${value.agg}_${value.fieldName}_${index}`
    }
  })

  const dimensionSelects = [...rowExpressions, ...columnExpressions].map(
    (item) => `${item.expr} AS ${quoteIdentifier(item.alias)}`
  )
  const valueSelects = valueExpressions.map(
    (item) => `${item.expr} AS ${quoteIdentifier(item.alias)}`
  )
  const groupBy = [...rowExpressions, ...columnExpressions].map((item) => item.expr)

  const fromClause = `${quoteIdentifier(primary.name)} AS T0`
  const joinClauses: string[] = []
  for (const join of config.joins) {
    const joinedWorksheet = worksheets.find((item) => item.worksheetId === join.worksheetId)
    if (!joinedWorksheet) throw new Error('关联表未找到')
    const alias = aliasByWorksheetId.get(joinedWorksheet.worksheetId)
    if (!alias) continue
    const primaryIdField = detectIdCardField(primary)
    const joinedIdField = detectIdCardField(joinedWorksheet)
    if (!primaryIdField || !joinedIdField) {
      throw new Error(`「${joinedWorksheet.name}」缺少身份证字段，无法关联`)
    }
    const onClause = `T0.${quoteIdentifier(columnRefByWorksheetId.get(primary.worksheetId)?.get(primaryIdField) ?? '')} = ${alias}.${quoteIdentifier(columnRefByWorksheetId.get(joinedWorksheet.worksheetId)?.get(joinedIdField) ?? '')}`
    const type = join.joinType === 'inner' ? 'INNER' : 'LEFT'
    joinClauses.push(
      `${type} JOIN ${quoteIdentifier(joinedWorksheet.name)} AS ${alias} ON ${onClause}`
    )
  }

  const params: unknown[] = []
  const whereParts: string[] = []
  for (const filter of config.filters) {
    const expr = resolveColumn(filter.worksheetId, filter.fieldName)
    const fragment = buildFilterFragment(expr, filter.op, filter.values, params)
    if (fragment) whereParts.push(fragment)
  }

  const sql = `
    SELECT ${[...dimensionSelects, ...valueSelects].join(', ')}
    FROM ${fromClause}
    ${joinClauses.join('\n')}
    ${whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : ''}
    ${groupBy.length ? 'GROUP BY ' + groupBy.join(', ') : ''}
    ORDER BY ${groupBy.length ? groupBy.join(', ') : '1'}
    LIMIT 5000
  `

  const database = await getDatabase()
  const rows = await all<Record<string, string | number | null>>(database, sql, params)

  return {
    rowDimensions: rowExpressions.map((item) => item.alias),
    columnDimensions: columnExpressions.map((item) => item.alias),
    valueAliases: valueExpressions.map((item) => item.alias),
    rows,
    totalRows: rows.length
  }
}

function rowAliasFor(fieldName: string): string {
  return fieldName
}

function buildAggregation(columnExpr: string, agg: PivotConfig['values'][number]['agg']): string {
  const numericExpr = `CAST(${columnExpr} AS REAL)`
  switch (agg) {
    case 'sum':
      return `COALESCE(SUM(${numericExpr}), 0)`
    case 'count':
      return `COUNT(${columnExpr})`
    case 'count_distinct':
      return `COUNT(DISTINCT ${columnExpr})`
    case 'avg':
      return `AVG(${numericExpr})`
    case 'max':
      return `MAX(${numericExpr})`
    case 'min':
      return `MIN(${numericExpr})`
    default:
      return `COUNT(${columnExpr})`
  }
}

function buildFilterFragment(
  expr: string,
  op: PivotFilterOp,
  values: string[],
  params: unknown[]
): string | undefined {
  switch (op) {
    case 'eq':
      if (values.length === 0) return undefined
      params.push(values[0])
      return `${expr} = ?`
    case 'ne':
      if (values.length === 0) return undefined
      params.push(values[0])
      return `${expr} <> ?`
    case 'contains':
      if (values.length === 0) return undefined
      params.push(`%${values[0]}%`)
      return `${expr} LIKE ?`
    case 'is_null':
      return `(${expr} IS NULL OR ${expr} = '')`
    case 'not_null':
      return `(${expr} IS NOT NULL AND ${expr} <> '')`
    case 'between': {
      if (values.length < 2) return undefined
      params.push(values[0], values[1])
      return `CAST(${expr} AS REAL) BETWEEN CAST(? AS REAL) AND CAST(? AS REAL)`
    }
    case 'in': {
      if (values.length === 0) return undefined
      const placeholders = values.map(() => '?').join(', ')
      params.push(...values)
      return `${expr} IN (${placeholders})`
    }
    default:
      return undefined
  }
}
