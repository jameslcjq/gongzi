import type sqlite3 from 'sqlite3'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { quoteIdentifier } from '../db/schema'

type LookupSeedFile = {
  version?: number
  generatedAt?: string
  tables?: Record<string, Array<Record<string, unknown>>>
}

const baseLookupTables = ['岗位工资对照', '薪级工资对照', '乡镇工作年限对照', '学校对照表']

export async function ensurePackagedLookupSeeds(database: sqlite3.Database): Promise<void> {
  const seedPath = resolveLookupSeedPath()
  if (!seedPath) return

  const seed = JSON.parse(readFileSync(seedPath, 'utf-8')) as LookupSeedFile
  const tables = seed.tables ?? {}

  for (const tableName of baseLookupTables) {
    const rows = tables[tableName] ?? []
    if (rows.length === 0) continue
    if (!(await tableExists(database, tableName))) continue

    const count = await tableRowCount(database, tableName)
    if (count > 0) continue

    await insertSeedRows(database, tableName, rows)
  }
}

function resolveLookupSeedPath(): string | undefined {
  const candidates = [
    join(process.resourcesPath ?? '', 'lookup-seeds.json'),
    resolve(process.cwd(), 'installer/resources/lookup-seeds.json'),
    resolve(process.cwd(), 'resources/lookup-seeds.json'),
    resolve(dirname(process.cwd()), 'installer/resources/lookup-seeds.json'),
    resolve(__dirname, '../../installer/resources/lookup-seeds.json')
  ]
  return candidates.find((item) => existsSync(item))
}

async function tableExists(database: sqlite3.Database, tableName: string): Promise<boolean> {
  const row = await get<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [tableName]
  )
  return (row?.count ?? 0) > 0
}

async function tableRowCount(database: sqlite3.Database, tableName: string): Promise<number> {
  const row = await get<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`
  )
  return row?.count ?? 0
}

async function insertSeedRows(
  database: sqlite3.Database,
  tableName: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  const columns = await all<{ name: string }>(database, `PRAGMA table_info(${quoteIdentifier(tableName)})`)
  const columnNames = new Set(columns.map((column) => column.name).filter((name) => name !== 'id'))
  const table = quoteIdentifier(tableName)
  const now = new Date().toISOString()

  await run(database, 'BEGIN TRANSACTION')
  try {
    for (const row of rows) {
      const seeded = { ...row }
      if (columnNames.has('md_created_at') && !seeded.md_created_at) seeded.md_created_at = now
      if (columnNames.has('md_updated_at') && !seeded.md_updated_at) seeded.md_updated_at = now

      const keys = Object.keys(seeded).filter((key) => columnNames.has(key))
      if (keys.length === 0) continue

      const placeholders = keys.map(() => '?').join(', ')
      const sql = `INSERT INTO ${table} (${keys.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`
      await run(
        database,
        sql,
        keys.map((key) => seeded[key] ?? null)
      )
    }
    await run(database, 'COMMIT')
  } catch (error) {
    await run(database, 'ROLLBACK')
    throw error
  }
}

function all<T>(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows: T[]) => {
      if (error) reject(error)
      else resolve(rows)
    })
  })
}

function get<T>(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row: T | undefined) => {
      if (error) reject(error)
      else resolve(row)
    })
  })
}

function run(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
