import { all, getDatabase } from '../../db/connection'
import type { LookupFailureEntry } from '../../../shared/types'

export interface LookupFailureQuery {
  workflow?: string
  worksheet?: string
  search?: string
  limit?: number
  offset?: number
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

