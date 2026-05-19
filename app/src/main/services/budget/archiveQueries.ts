import { all, getDatabase, run } from '../../db/connection'
import type { LookupFailureEntry, PersonnelArchiveEntry } from '../../../shared/types'

export interface ArchiveQuery {
  archiveType?: string
  sourceWorksheet?: string
  search?: string
  limit?: number
  offset?: number
}

export interface LookupFailureQuery {
  workflow?: string
  worksheet?: string
  search?: string
  limit?: number
  offset?: number
}

export async function listPersonnelArchive(query: ArchiveQuery = {}): Promise<{
  total: number
  rows: PersonnelArchiveEntry[]
}> {
  const database = await getDatabase()
  const filters: string[] = []
  const params: unknown[] = []
  if (query.archiveType) {
    filters.push('archive_type = ?')
    params.push(query.archiveType)
  }
  if (query.sourceWorksheet) {
    filters.push('source_worksheet = ?')
    params.push(query.sourceWorksheet)
  }
  if (query.search) {
    filters.push('(id_card LIKE ? OR name LIKE ? OR unit_name LIKE ?)')
    const like = `%${query.search}%`
    params.push(like, like, like)
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(query.limit ?? 50, 500))
  const offset = Math.max(0, query.offset ?? 0)

  const totalRow = await all<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count FROM personnel_archive ${where}`,
    params
  )
  const rows = await all<{
    id: number
    archive_type: string
    source_worksheet: string
    id_card: string
    name: string
    unit_code: string
    unit_name: string
    original_data: string
    reason: string
    archived_at: string
  }>(
    database,
    `SELECT * FROM personnel_archive ${where} ORDER BY archived_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  return {
    total: totalRow[0]?.count ?? 0,
    rows: rows.map((row) => ({
      id: row.id,
      archiveType: row.archive_type,
      sourceWorksheet: row.source_worksheet,
      idCard: row.id_card ?? '',
      name: row.name ?? '',
      unitCode: row.unit_code ?? '',
      unitName: row.unit_name ?? '',
      reason: row.reason ?? '',
      archivedAt: row.archived_at,
      originalData: parseJson(row.original_data)
    }))
  }
}

export async function listLookupFailures(query: LookupFailureQuery = {}): Promise<{
  total: number
  rows: LookupFailureEntry[]
}> {
  const database = await getDatabase()
  const filters: string[] = []
  const params: unknown[] = []
  if (query.workflow) {
    filters.push('workflow = ?')
    params.push(query.workflow)
  }
  if (query.worksheet) {
    filters.push('worksheet = ?')
    params.push(query.worksheet)
  }
  if (query.search) {
    filters.push('(id_card LIKE ? OR name LIKE ? OR lookup_value LIKE ? OR reason LIKE ?)')
    const like = `%${query.search}%`
    params.push(like, like, like, like)
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(query.limit ?? 50, 500))
  const offset = Math.max(0, query.offset ?? 0)

  const totalRow = await all<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count FROM lookup_failures ${where}`,
    params
  )
  const rows = await all<{
    id: number
    workflow: string
    worksheet: string
    id_card: string
    name: string
    lookup_table: string
    lookup_key: string
    lookup_value: string
    reason: string
    created_at: string
  }>(
    database,
    `SELECT * FROM lookup_failures ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  return {
    total: totalRow[0]?.count ?? 0,
    rows: rows.map((row) => ({
      id: row.id,
      workflow: row.workflow ?? '',
      worksheet: row.worksheet ?? '',
      idCard: row.id_card ?? '',
      name: row.name ?? '',
      lookupTable: row.lookup_table ?? '',
      lookupKey: row.lookup_key ?? '',
      lookupValue: row.lookup_value ?? '',
      reason: row.reason ?? '',
      createdAt: row.created_at
    }))
  }
}

export async function clearLookupFailures(workflow?: string): Promise<number> {
  const database = await getDatabase()
  const totalRow = await all<{ count: number }>(
    database,
    workflow
      ? `SELECT COUNT(*) AS count FROM lookup_failures WHERE workflow = ?`
      : `SELECT COUNT(*) AS count FROM lookup_failures`,
    workflow ? [workflow] : []
  )
  const total = totalRow[0]?.count ?? 0
  if (workflow) {
    await run(database, `DELETE FROM lookup_failures WHERE workflow = ?`, [workflow])
  } else {
    await run(database, `DELETE FROM lookup_failures`)
  }
  return total
}

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
