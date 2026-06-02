import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sqlite3 from 'sqlite3'
import { getDataPath } from '../config/paths'
import { readWorksheetMetadata } from './metadata'
import {
  getSqlType,
  getWorksheetLocalColumns,
  quoteIdentifier,
  readRetainedSchemaSql
} from './schema'
import {
  activePersonnelStatus,
  getIdentityColumnName,
  getPersonnelStatusColumnName,
  isPersonnelStatusSourceWorksheet,
  isPersonnelStatusTargetWorksheet,
  normalizeIdentityValue,
  otherPersonnelStatus,
  retiredPersonnelStatus,
  resolveBudgetWorksheetStatus,
  resolvePersonnelStatus
} from '../services/personnelStatus'
import { ensurePackagedLookupSeeds } from '../services/lookupSeeds'

let db: sqlite3.Database | undefined
let databasePath = ''

export async function getDatabase(): Promise<sqlite3.Database> {
  if (db) return db

  databasePath = getDataPath('salary-system.sqlite')
  await mkdir(dirname(databasePath), { recursive: true })

  db = await openDatabase(databasePath)
  await exec(db, `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -8000;
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
  `)
  await exec(db, readRetainedSchemaSql())
  await ensureSystemTables(db)
  await syncWorksheetColumns(db)
  await ensurePackagedLookupSeeds(db)
  await backfillHrBankFieldsFromBudget(db)
  await ensureBudgetStatusColumns(db)
  await refreshAllPersonnelStatuses(db)
  await ensurePerformanceIndexes(db)
  await ensureIdentityUniqueIndexes(db)

  return db
}

async function ensureBudgetStatusColumns(database: sqlite3.Database): Promise<void> {
  const targets = ['预算在职', '预算退休', '预算其他']
  const statusColumns = [
    { name: 'md_status', definition: 'TEXT' },
    { name: 'md_status_changed_at', definition: 'TEXT' },
    { name: 'md_status_reason', definition: 'TEXT' }
  ]
  for (const tableName of targets) {
    const existing = await all<{ name: string }>(
      database,
      `PRAGMA table_info(${quoteIdentifier(tableName)})`
    )
    if (existing.length === 0) continue
    const existingNames = new Set(existing.map((column) => column.name))
    for (const column of statusColumns) {
      if (!existingNames.has(column.name)) {
        await exec(
          database,
          `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(column.name)} ${column.definition}`
        )
      }
    }
  }
}

async function syncWorksheetColumns(database: sqlite3.Database): Promise<void> {
  const worksheets = readWorksheetMetadata()
  for (const worksheet of worksheets) {
    const tableName = quoteIdentifier(worksheet.name)
    const existingColumns = await all<{ name: string }>(
      database,
      `PRAGMA table_info(${tableName})`
    )
    const existingNames = new Set(existingColumns.map((column) => column.name))
    for (const column of getWorksheetLocalColumns(worksheet)) {
      if (!existingNames.has(column.columnName)) {
        await exec(
          database,
          `ALTER TABLE ${tableName} ADD COLUMN ${quoteIdentifier(column.columnName)} ${getSqlType(column.field)}`
        )
      }
    }
  }
}

export async function backfillHrBankFieldsFromBudget(database: sqlite3.Database): Promise<void> {
  const worksheets = readWorksheetMetadata()
  const hr = worksheets.find((item) => item.name === '人事信息')
  if (!hr) return

  const hrIdColumn = worksheetColumnName(hr, '身份证号码')
  const hrBankNameColumn = worksheetColumnName(hr, '工资卡开户银行')
  const hrBankCardColumn = worksheetColumnName(hr, '工资卡卡号')
  if (!hrIdColumn || !hrBankNameColumn || !hrBankCardColumn) return
  if (!(await hasColumns(database, hr.name, [hrIdColumn, hrBankNameColumn, hrBankCardColumn]))) return

  const bankByIdCard = new Map<string, { bankName: string; bankCard: string }>()
  const sources = [
    { name: '预算在职', idField: '证件号码*', bankNameField: '工资卡开户银行*', bankCardField: '工资卡卡号*' },
    { name: '预算退休', idField: '证件号码*', bankNameField: '工资卡开户银行*', bankCardField: '工资卡卡号*' },
    { name: '预算其他', idField: '证件号码', bankNameField: '工资卡开户银行', bankCardField: '工资卡卡号' }
  ]

  for (const source of sources) {
    const worksheet = worksheets.find((item) => item.name === source.name)
    if (!worksheet) continue
    const idColumn = worksheetColumnName(worksheet, source.idField)
    const bankNameColumn = worksheetColumnName(worksheet, source.bankNameField)
    const bankCardColumn = worksheetColumnName(worksheet, source.bankCardField)
    if (!idColumn || !bankNameColumn || !bankCardColumn) continue
    if (!(await hasColumns(database, worksheet.name, [idColumn, bankNameColumn, bankCardColumn]))) continue

    const rows = await all<Record<string, unknown>>(
      database,
      `SELECT "id", ${quoteIdentifier(idColumn)} AS id_card,
              ${quoteIdentifier(bankNameColumn)} AS bank_name,
              ${quoteIdentifier(bankCardColumn)} AS bank_card
       FROM ${quoteIdentifier(worksheet.name)}
       ORDER BY "id" ASC`
    )
    for (const row of rows) {
      const idCard = normalizeIdentityValue(row.id_card)
      if (!idCard) continue
      const existing = bankByIdCard.get(idCard) ?? { bankName: '', bankCard: '' }
      const bankName = String(row.bank_name ?? '').trim()
      const bankCard = String(row.bank_card ?? '').trim()
      bankByIdCard.set(idCard, {
        bankName: bankName || existing.bankName,
        bankCard: bankCard || existing.bankCard
      })
    }
  }

  if (bankByIdCard.size === 0) return

  const hrRows = await all<Record<string, unknown>>(
    database,
    `SELECT "id", ${quoteIdentifier(hrIdColumn)} AS id_card,
            ${quoteIdentifier(hrBankNameColumn)} AS bank_name,
            ${quoteIdentifier(hrBankCardColumn)} AS bank_card
     FROM ${quoteIdentifier(hr.name)}`
  )
  for (const row of hrRows) {
    const idCard = normalizeIdentityValue(row.id_card)
    const bank = idCard ? bankByIdCard.get(idCard) : undefined
    if (!bank) continue
    const currentBankName = String(row.bank_name ?? '').trim()
    const currentBankCard = String(row.bank_card ?? '').trim()
    const nextBankName = currentBankName || bank.bankName
    const nextBankCard = currentBankCard || bank.bankCard
    if (nextBankName === currentBankName && nextBankCard === currentBankCard) continue
    await run(
      database,
      `UPDATE ${quoteIdentifier(hr.name)}
       SET ${quoteIdentifier(hrBankNameColumn)} = ?,
           ${quoteIdentifier(hrBankCardColumn)} = ?,
           "md_updated_at" = ?
       WHERE "id" = ?`,
      [nextBankName, nextBankCard, new Date().toISOString(), row.id]
    )
  }
}

function worksheetColumnName(
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  fieldName: string
): string | undefined {
  return getWorksheetLocalColumns(worksheet).find((column) => column.field.name === fieldName)?.columnName
}

async function hasColumns(
  database: sqlite3.Database,
  tableName: string,
  columnNames: string[]
): Promise<boolean> {
  const existing = await all<{ name: string }>(
    database,
    `PRAGMA table_info(${quoteIdentifier(tableName)})`
  )
  const existingNames = new Set(existing.map((column) => column.name))
  return columnNames.every((columnName) => existingNames.has(columnName))
}


export function getDatabasePath(): string {
  return databasePath
}

function openDatabase(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path, (error) => {
      if (error) reject(error)
      else resolve(database)
    })
  })
}

export function exec(database: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export function all<T>(
  database: sqlite3.Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows: T[]) => {
      if (error) reject(error)
      else resolve(rows)
    })
  })
}

export function get<T>(
  database: sqlite3.Database,
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row: T | undefined) => {
      if (error) reject(error)
      else resolve(row)
    })
  })
}

export function run(
  database: sqlite3.Database,
  sql: string,
  params: unknown[] = []
): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export function runWithLastId(
  database: sqlite3.Database,
  sql: string,
  params: unknown[] = []
): Promise<{ lastId: number; changes: number }> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (error) {
      if (error) reject(error)
      else resolve({ lastId: this.lastID, changes: this.changes })
    })
  })
}

async function ensureSystemTables(database: sqlite3.Database): Promise<void> {
  await exec(
    database,
    `
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT,
      worksheet_id TEXT,
      worksheet_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      row_count INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS import_batch_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      worksheet_name TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES import_batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_import_batch_rows_batch ON import_batch_rows (batch_id);

    CREATE TABLE IF NOT EXISTS monthly_payroll_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      unit_full_name TEXT,
      active_count INTEGER NOT NULL DEFAULT 0,
      survivor_count INTEGER NOT NULL DEFAULT 0,
      retired_housing_count INTEGER NOT NULL DEFAULT 0,
      salary_total REAL NOT NULL DEFAULT 0,
      withholding_total REAL NOT NULL DEFAULT 0,
      tax_total REAL NOT NULL DEFAULT 0,
      actual_pay REAL NOT NULL DEFAULT 0,
      active_actual_pay REAL NOT NULL DEFAULT 0,
      survivor_actual_pay REAL NOT NULL DEFAULT 0,
      retired_housing_actual_pay REAL NOT NULL DEFAULT 0,
      retired_housing REAL NOT NULL DEFAULT 0,
      source_salary_path TEXT,
      source_social_path TEXT,
      source_tax_path TEXT,
      insurance_import_path TEXT,
      voucher_import_path TEXT,
      salary_import_path TEXT,
      payroll_backpay_path TEXT,
      report_fingerprint TEXT,
      tax_field TEXT,
      data_source_mode TEXT,
      archived_at TEXT,
      archive_dir TEXT,
      archive_manifest TEXT,
      report_snapshot TEXT,
      is_outdated INTEGER NOT NULL DEFAULT 0,
      outdated_at TEXT,
      outdated_reason TEXT,
      insurance_push_status TEXT NOT NULL DEFAULT 'not-pushed',
      salary_push_status TEXT NOT NULL DEFAULT 'not-pushed',
      insurance_pushed_at TEXT,
      salary_pushed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_monthly_payroll_runs_ym ON monthly_payroll_runs (year DESC, month DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS monthly_payroll_source_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      archive_path TEXT,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      summary_json TEXT,
      status TEXT NOT NULL DEFAULT 'current',
      replaced_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_monthly_payroll_source_versions_ym
      ON monthly_payroll_source_versions (year DESC, month DESC, kind, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS import_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      worksheet_name TEXT,
      ok INTEGER NOT NULL,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      batch_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_name TEXT NOT NULL,
      ok INTEGER NOT NULL,
      affected_rows INTEGER NOT NULL DEFAULT 0,
      messages TEXT,
      warnings TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS field_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worksheet_id TEXT NOT NULL,
      worksheet_name TEXT NOT NULL,
      field_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      local_column TEXT NOT NULL,
      UNIQUE (worksheet_id, field_id)
    );

    CREATE TABLE IF NOT EXISTS lookup_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow TEXT,
      worksheet TEXT,
      id_card TEXT,
      name TEXT,
      lookup_table TEXT,
      lookup_key TEXT,
      lookup_value TEXT,
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_lookup_failures_workflow ON lookup_failures (workflow);
    CREATE INDEX IF NOT EXISTS idx_lookup_failures_idcard ON lookup_failures (id_card);

    CREATE TABLE IF NOT EXISTS personnel_status_index (
      id_card TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL,
      source_tables TEXT NOT NULL,
      is_conflict INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_personnel_status_index_status ON personnel_status_index (status);
    CREATE INDEX IF NOT EXISTS idx_personnel_status_index_name ON personnel_status_index (name);

    CREATE TABLE IF NOT EXISTS pivot_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      primary_worksheet_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL DEFAULT 993,
      username TEXT NOT NULL,
      auth_code_encrypted TEXT NOT NULL,
      display_name TEXT,
      folder TEXT,
      from_filter TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mail_download_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      from_contains TEXT,
      subject_contains TEXT,
      extension_filter TEXT,
      target_dir TEXT,
      save_subdir TEXT NOT NULL DEFAULT '下载附件',
      folder TEXT,
      only_unread INTEGER DEFAULT 0,
      mark_seen INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mail_download_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      message_uid INTEGER NOT NULL,
      message_id TEXT,
      message_date TEXT,
      from_address TEXT,
      subject TEXT,
      attachment_filename TEXT NOT NULL,
      attachment_size INTEGER NOT NULL DEFAULT 0,
      attachment_hash TEXT,
      saved_path TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_mail_record_dedup
      ON mail_download_records (account_id, message_uid, attachment_filename, attachment_size);

    CREATE TABLE IF NOT EXISTS mail_download_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS operation_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      target_type TEXT,
      target_name TEXT,
      reason TEXT,
      meta_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS record_change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      table_name TEXT NOT NULL,
      worksheet_name TEXT,
      record_id INTEGER,
      action TEXT NOT NULL,
      before_values TEXT,
      after_values TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (batch_id) REFERENCES operation_batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_record_change_logs_batch ON record_change_logs (batch_id);
    CREATE INDEX IF NOT EXISTS idx_record_change_logs_target ON record_change_logs (table_name, record_id);

    CREATE TABLE IF NOT EXISTS file_operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_label TEXT,
      existed INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER,
      sha256 TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (batch_id) REFERENCES operation_batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_file_operation_logs_batch ON file_operation_logs (batch_id);
  `
  )

  await ensureColumns(database, 'import_batches', [
    { name: 'worksheet_id', definition: 'TEXT' },
    { name: 'worksheet_name', definition: 'TEXT' },
    { name: 'row_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'message', definition: 'TEXT' }
  ])
  await ensureColumns(database, 'import_batch_rows', [
    { name: 'action', definition: 'TEXT NOT NULL DEFAULT \'insert\'' },
    { name: 'previous_values', definition: 'TEXT' }
  ])
  await ensureColumns(database, 'import_logs', [{ name: 'batch_id', definition: 'INTEGER' }])
  await ensureColumns(database, 'monthly_payroll_runs', [
    { name: 'retired_housing_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'active_actual_pay', definition: 'REAL NOT NULL DEFAULT 0' },
    { name: 'survivor_actual_pay', definition: 'REAL NOT NULL DEFAULT 0' },
    { name: 'retired_housing_actual_pay', definition: 'REAL NOT NULL DEFAULT 0' },
    { name: 'report_fingerprint', definition: 'TEXT' },
    { name: 'salary_import_path', definition: 'TEXT' },
    { name: 'tax_field', definition: 'TEXT' },
    { name: 'data_source_mode', definition: 'TEXT' },
    { name: 'archived_at', definition: 'TEXT' },
    { name: 'archive_dir', definition: 'TEXT' },
    { name: 'archive_manifest', definition: 'TEXT' },
    { name: 'report_snapshot', definition: 'TEXT' },
    { name: 'is_outdated', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'outdated_at', definition: 'TEXT' },
    { name: 'outdated_reason', definition: 'TEXT' },
    { name: 'insurance_push_status', definition: 'TEXT NOT NULL DEFAULT \'not-pushed\'' },
    { name: 'salary_push_status', definition: 'TEXT NOT NULL DEFAULT \'not-pushed\'' },
    { name: 'insurance_pushed_at', definition: 'TEXT' },
    { name: 'salary_pushed_at', definition: 'TEXT' }
  ])
  await ensureColumns(database, 'monthly_payroll_source_versions', [
    { name: 'archive_path', definition: 'TEXT' }
  ])
  await ensureColumns(database, 'personnel_status_index', [
    { name: 'name', definition: 'TEXT' },
    { name: 'status', definition: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'source_tables', definition: 'TEXT NOT NULL DEFAULT \'\'' },
    { name: 'is_conflict', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'updated_at', definition: 'TEXT' }
  ])
  await ensureColumns(database, 'mail_accounts', [
    { name: 'folder', definition: 'TEXT' },
    { name: 'from_filter', definition: 'TEXT' }
  ])
  await ensureColumns(database, 'mail_download_rules', [
    { name: 'folder', definition: 'TEXT' }
  ])
}

async function ensureColumns(
  database: sqlite3.Database,
  tableName: string,
  expected: Array<{ name: string; definition: string }>
): Promise<void> {
  const existing = await all<{ name: string }>(database, `PRAGMA table_info(${tableName})`)
  const existingNames = new Set(existing.map((column) => column.name))
  for (const column of expected) {
    if (!existingNames.has(column.name)) {
      await exec(database, `ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.definition}`)
    }
  }
}

async function ensurePerformanceIndexes(database: sqlite3.Database): Promise<void> {
  // 给证件号码等 JOIN 关联列创建索引，显著提升透视查询和工作流的关联速度
  const idCardIndexes: Array<{ table: string; column: string }> = [
    { table: '在职工资', column: '证件号码' },
    { table: '退休工资', column: '证件号码' },
    { table: '其他工资', column: '证件号码' },
    { table: '预算在职', column: '证件号码*' },
    { table: '预算退休', column: '证件号码*' },
    { table: '预算其他', column: '证件号码' },
    { table: '工资年报', column: '证件号码*' },
    { table: '绩效工资', column: '证件号码*' },
    { table: '乡镇补贴', column: '证件号码*' },
    { table: '人员明细导出', column: '证件号码*' },
    { table: '新房补', column: '证件号码' }
  ]

  for (const { table, column } of idCardIndexes) {
    const existing = await all<{ name: string }>(
      database,
      `PRAGMA table_info(${quoteIdentifier(table)})`
    )
    const hasColumn = existing.some((col) => col.name === column)
    if (!hasColumn) continue

    const indexName = `idx_${table}_${column}`.replace(/[^a-zA-Z0-9\u4e00-\u9fff_]/g, '_')
    await exec(
      database,
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(table)} (${quoteIdentifier(column)})`
    )
  }

  // 给预算表的 md_status 列加索引（用于视图筛选）
  const statusTables = ['预算在职', '预算退休', '预算其他']
  for (const table of statusTables) {
    const existing = await all<{ name: string }>(
      database,
      `PRAGMA table_info(${quoteIdentifier(table)})`
    )
    if (existing.some((col) => col.name === 'md_status')) {
      await exec(
        database,
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_${table}_md_status`)} ON ${quoteIdentifier(table)} ("md_status")`
      )
    }
  }

  const worksheets = readWorksheetMetadata().filter(isPersonnelStatusTargetWorksheet)
  for (const worksheet of worksheets) {
    const statusColumn = getPersonnelStatusColumnName(worksheet)
    if (!statusColumn) continue
    const existing = await all<{ name: string }>(
      database,
      `PRAGMA table_info(${quoteIdentifier(worksheet.name)})`
    )
    if (!existing.some((col) => col.name === statusColumn)) continue

    const indexName = `idx_${worksheet.name}_${statusColumn}`.replace(/[^a-zA-Z0-9\u4e00-\u9fff_]/g, '_')
    await exec(
      database,
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(worksheet.name)} (${quoteIdentifier(statusColumn)})`
    )
  }
}

const identityUniqueFieldNames = new Set(['\u8eab\u4efd\u8bc1\u53f7\u7801', '\u8eab\u4efd\u8bc1\u53f7', '\u8bc1\u4ef6\u53f7\u7801*', '\u8bc1\u4ef6\u53f7\u7801'])

const identityNonUniqueWorksheetIds = new Set([
  'local-hr-edu',
  'local-hr-cert',
  'local-hr-teach',
  'local-hr-work'
])

const identityCompositeFieldNames = new Map<string, string[]>([
  ['在职工资', ['\u5de5\u8d44\u6279\u6b21\u7f16\u7801']],
  ['退休工资', ['\u5de5\u8d44\u6279\u6b21\u7f16\u7801']],
  ['其他工资', ['\u5de5\u8d44\u6279\u6b21\u7f16\u7801']]
])

export type IdentityDuplicateIssue = {
  worksheetName: string
  identityFieldName: string
  idCard: string
  count: number
}

async function ensureIdentityUniqueIndexes(database: sqlite3.Database): Promise<void> {
  const worksheets = readWorksheetMetadata()
  for (const worksheet of worksheets) {
    if (identityNonUniqueWorksheetIds.has(worksheet.worksheetId)) continue
    const columns = getWorksheetLocalColumns(worksheet)
    const idColumn = columns.find((column) =>
      identityUniqueFieldNames.has(column.field.name)
    )
    if (!idColumn) continue

    const existingCols = await all<{ name: string }>(
      database,
      `PRAGMA table_info(${quoteIdentifier(worksheet.name)})`
    )
    if (!existingCols.some((col) => col.name === idColumn.columnName)) continue

    const extraFieldNames = identityCompositeFieldNames.get(worksheet.name) ?? []
    const extraColumns = extraFieldNames
      .map((fieldName) => columns.find((column) => column.field.name === fieldName))
      .filter((column): column is NonNullable<typeof column> => Boolean(column))
      .filter((column) => existingCols.some((col) => col.name === column.columnName))

    // \u590d\u5408\u552f\u4e00\u7d22\u5f15\u542f\u7528\u524d\uff0c\u5148\u5220\u9664\u53ef\u80fd\u5b58\u5728\u7684\u65e7\u5355\u5217\u552f\u4e00\u7d22\u5f15\u3002
    if (extraColumns.length > 0) {
      const previousSingleColumnIndexName = `uniq_${worksheet.name}_${idColumn.columnName}`.replace(
        /[^a-zA-Z0-9\u4e00-\u9fff_]/g,
        '_'
      )
      await exec(database, `DROP INDEX IF EXISTS ${quoteIdentifier(previousSingleColumnIndexName)}`)
    }

    const allColumns = [idColumn, ...extraColumns]
    const indexSuffix = allColumns.map((column) => column.columnName).join('_')
    const indexName = `uniq_${worksheet.name}_${indexSuffix}`.replace(
      /[^a-zA-Z0-9\u4e00-\u9fff_]/g,
      '_'
    )
    const quotedColumn = quoteIdentifier(idColumn.columnName)
    const indexColumnsClause = allColumns
      .map((column) => quoteIdentifier(column.columnName))
      .join(', ')
    try {
      await exec(
        database,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)}
         ON ${quoteIdentifier(worksheet.name)} (${indexColumnsClause})
         WHERE ${quotedColumn} IS NOT NULL AND ${quotedColumn} != ''`
      )
    } catch (error) {
      const duplicates = await all<{ id_card: string; cnt: number }>(
        database,
        `SELECT ${quotedColumn} AS id_card, COUNT(*) AS cnt
         FROM ${quoteIdentifier(worksheet.name)}
         WHERE ${quotedColumn} IS NOT NULL AND ${quotedColumn} != ''
         GROUP BY ${indexColumnsClause}
         HAVING cnt > 1
         LIMIT 3`
      )
      const sample = duplicates.map((row) => `${row.id_card}(${row.cnt})`).join('\u3001')
      console.warn(
        `\u65e0\u6cd5\u5728 ${worksheet.name}.${idColumn.columnName} \u521b\u5efa\u8eab\u4efd\u8bc1\u552f\u4e00\u7d22\u5f15\uff0c\u5b58\u5728\u91cd\u590d\u503c\uff08\u793a\u4f8b\uff1a${sample}\uff09\uff0c\u8bf7\u5148\u5728\u8868\u4e2d\u6e05\u7406\uff1a${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

export async function listIdentityDuplicateIssues(): Promise<IdentityDuplicateIssue[]> {
  const database = await getDatabase()
  const issues: IdentityDuplicateIssue[] = []
  const worksheets = readWorksheetMetadata()
  for (const worksheet of worksheets) {
    if (identityNonUniqueWorksheetIds.has(worksheet.worksheetId)) continue
    const columns = getWorksheetLocalColumns(worksheet)
    const idColumn = columns.find((column) => identityUniqueFieldNames.has(column.field.name))
    if (!idColumn) continue

    const existingCols = await all<{ name: string }>(
      database,
      `PRAGMA table_info(${quoteIdentifier(worksheet.name)})`
    )
    if (!existingCols.some((col) => col.name === idColumn.columnName)) continue

    const extraFieldNames = identityCompositeFieldNames.get(worksheet.name) ?? []
    const extraColumns = extraFieldNames
      .map((fieldName) => columns.find((column) => column.field.name === fieldName))
      .filter((column): column is NonNullable<typeof column> => Boolean(column))
      .filter((column) => existingCols.some((col) => col.name === column.columnName))
    const allColumns = [idColumn, ...extraColumns]
    const groupColumns = allColumns.map((column) => quoteIdentifier(column.columnName)).join(', ')
    const rows = await all<{ id_card: string; cnt: number }>(
      database,
      `SELECT ${quoteIdentifier(idColumn.columnName)} AS id_card, COUNT(*) AS cnt
       FROM ${quoteIdentifier(worksheet.name)}
       WHERE ${quoteIdentifier(idColumn.columnName)} IS NOT NULL
         AND ${quoteIdentifier(idColumn.columnName)} != ''
       GROUP BY ${groupColumns}
       HAVING cnt > 1
       LIMIT 20`
    )
    for (const row of rows) {
      issues.push({
        worksheetName: worksheet.name,
        identityFieldName: idColumn.field.name,
        idCard: row.id_card,
        count: row.cnt
      })
    }
  }
  return issues
}

export async function loadPersonnelStatusIdentitySets(
  database: sqlite3.Database
): Promise<{ activeIds: Set<string>; retiredIds: Set<string>; otherIds: Set<string> }> {
  await refreshPersonnelStatusIndex(database)
  const rows = await all<{ id_card: string; status: string }>(
    database,
    `SELECT id_card, status FROM personnel_status_index`
  )

  return {
    activeIds: new Set(
      rows
        .filter((row) => row.status === activePersonnelStatus)
        .map((row) => normalizeIdentityValue(row.id_card))
        .filter(Boolean)
    ),
    retiredIds: new Set(
      rows
        .filter((row) => row.status === retiredPersonnelStatus)
        .map((row) => normalizeIdentityValue(row.id_card))
        .filter(Boolean)
    ),
    otherIds: new Set(
      rows
        .filter((row) => row.status === otherPersonnelStatus)
        .map((row) => normalizeIdentityValue(row.id_card))
        .filter(Boolean)
    )
  }
}

type PersonnelStatusSourceRow = {
  idCard: string
  name: string
}

async function refreshPersonnelStatusIndex(database: sqlite3.Database): Promise<void> {
  const worksheets = readWorksheetMetadata()
  const activeWorksheet = worksheets.find((item) => item.name === '在职工资')
  const retiredWorksheet = worksheets.find((item) => item.name === '退休工资')
  const otherWorksheet = worksheets.find((item) => item.name === '其他工资')
  const activeRows = activeWorksheet ? await loadIdentityRows(database, activeWorksheet) : []
  const retiredRows = retiredWorksheet ? await loadIdentityRows(database, retiredWorksheet) : []
  const otherRows = otherWorksheet ? await loadIdentityRows(database, otherWorksheet) : []
  const entries = new Map<
    string,
    { name: string; inActive: boolean; inRetired: boolean; inOther: boolean; sourceTables: Set<string> }
  >()

  const append = (
    row: PersonnelStatusSourceRow,
    sourceTable: string,
    flag: 'inActive' | 'inRetired' | 'inOther'
  ): void => {
    const idCard = normalizeIdentityValue(row.idCard)
    if (!idCard) return
    const current =
      entries.get(idCard) ?? {
        name: '',
        inActive: false,
        inRetired: false,
        inOther: false,
        sourceTables: new Set<string>()
      }
    if (!current.name && row.name) current.name = row.name
    current[flag] = true
    current.sourceTables.add(sourceTable)
    entries.set(idCard, current)
  }

  for (const row of activeRows) append(row, '在职工资', 'inActive')
  for (const row of retiredRows) append(row, '退休工资', 'inRetired')
  for (const row of otherRows) append(row, '其他工资', 'inOther')

  const now = new Date().toISOString()
  await run(database, `DELETE FROM personnel_status_index`)
  for (const [idCard, entry] of entries) {
    const status = entry.inActive
      ? activePersonnelStatus
      : entry.inRetired
        ? retiredPersonnelStatus
        : otherPersonnelStatus
    await run(
      database,
      `INSERT INTO personnel_status_index (id_card, name, status, source_tables, is_conflict, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        idCard,
        entry.name,
        status,
        Array.from(entry.sourceTables).join(','),
        entry.inActive && entry.inRetired ? 1 : 0,
        now
      ]
    )
  }
}

async function loadIdentityRows(
  database: sqlite3.Database,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number]
): Promise<PersonnelStatusSourceRow[]> {
  const identityColumn = getIdentityColumnName(worksheet)
  if (!identityColumn) return []
  const nameColumn = getNameColumnName(worksheet)

  const existing = await all<{ name: string }>(
    database,
    `PRAGMA table_info(${quoteIdentifier(worksheet.name)})`
  )
  const existingNames = new Set(existing.map((column) => column.name))
  if (!existingNames.has(identityColumn)) return []

  const nameExpr = nameColumn && existingNames.has(nameColumn) ? quoteIdentifier(nameColumn) : `''`
  const rows = await all<{ id_value: unknown; name_value: unknown }>(
    database,
    `SELECT ${quoteIdentifier(identityColumn)} AS id_value, ${nameExpr} AS name_value FROM ${quoteIdentifier(worksheet.name)}`
  )
  return rows
    .map((row) => ({
      idCard: normalizeIdentityValue(row.id_value),
      name: String(row.name_value ?? '').trim()
    }))
    .filter((row) => Boolean(row.idCard))
}

function getNameColumnName(worksheet: ReturnType<typeof readWorksheetMetadata>[number]): string | undefined {
  const columns = getWorksheetLocalColumns(worksheet)
  return columns.find((column) => column.field.name === '姓名' || column.field.name.includes('姓名'))?.columnName
}

export async function refreshAllPersonnelStatuses(database: sqlite3.Database): Promise<void> {
  const worksheets = readWorksheetMetadata()
  const { activeIds, retiredIds, otherIds } = await loadPersonnelStatusIdentitySets(database)

  for (const worksheet of worksheets) {
    if (!isPersonnelStatusTargetWorksheet(worksheet)) continue
    await refreshWorksheetPersonnelStatus(database, worksheet, activeIds, retiredIds, otherIds)
  }
}

export async function refreshWorksheetPersonnelStatus(
  database: sqlite3.Database,
  worksheet: ReturnType<typeof readWorksheetMetadata>[number],
  activeIds: Set<string>,
  retiredIds: Set<string>,
  otherIds: Set<string>
): Promise<void> {
  if (isPersonnelStatusSourceWorksheet(worksheet.name)) return
  const identityColumn = getIdentityColumnName(worksheet)
  const statusColumn = getPersonnelStatusColumnName(worksheet)
  if (!identityColumn || !statusColumn) return

  const existing = await all<{ name: string }>(
    database,
    `PRAGMA table_info(${quoteIdentifier(worksheet.name)})`
  )
  const existingNames = new Set(existing.map((column) => column.name))
  if (!existingNames.has(identityColumn) || !existingNames.has(statusColumn)) return

  const hasBudgetStatus = existingNames.has('md_status')
  const budgetStatusExpr = hasBudgetStatus ? `"md_status" AS current_budget_status` : `NULL AS current_budget_status`
  const budgetStatusReasonExpr = hasBudgetStatus ? `"md_status_reason" AS current_budget_status_reason` : `NULL AS current_budget_status_reason`
  const rows = await all<{
    id: number
    id_value: unknown
    current_status: string | null
    current_budget_status: string | null
    current_budget_status_reason: string | null
  }>(
    database,
    `SELECT "id",
            ${quoteIdentifier(identityColumn)} AS id_value,
            ${quoteIdentifier(statusColumn)} AS current_status,
            ${budgetStatusExpr},
            ${budgetStatusReasonExpr}
     FROM ${quoteIdentifier(worksheet.name)}`
  )
  for (const row of rows) {
    const status = resolvePersonnelStatus(row.id_value, activeIds, retiredIds, otherIds)
    const budgetStatus = resolveBudgetWorksheetStatus(
      worksheet.name,
      row.id_value,
      activeIds,
      retiredIds,
      otherIds
    )
    if (budgetStatus && hasBudgetStatus && row.current_budget_status_reason === '手工设置') {
      continue
    }
    if (budgetStatus && hasBudgetStatus && (row.current_budget_status ?? '') === budgetStatus) {
      continue
    }
    if (!budgetStatus && (row.current_status ?? '') === status) {
      continue
    }
    const assignments: string[] = []
    const params: unknown[] = []
    if (!budgetStatus) {
      assignments.push(`${quoteIdentifier(statusColumn)} = ?`)
      params.push(status)
    }
    if (budgetStatus && hasBudgetStatus) {
      assignments.push(`"md_status" = ?`, `"md_status_changed_at" = ?`, `"md_status_reason" = ?`)
      params.push(budgetStatus, new Date().toISOString(), '按三张工资表刷新人员状态')
    }
    if (assignments.length === 0) continue
    params.push(new Date().toISOString(), row.id)
    await run(
      database,
      `UPDATE ${quoteIdentifier(worksheet.name)} SET ${assignments.join(', ')}, "md_updated_at" = ? WHERE "id" = ?`,
      params
    )
  }
}
