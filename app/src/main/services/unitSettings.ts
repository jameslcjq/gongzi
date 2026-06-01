import { getDatabase, get, run } from '../db/connection'
import { readWorksheetMetadata } from '../db/metadata'
import { quoteIdentifier } from '../db/schema'
import type {
  SalaryExportSaltype,
  UnitSettings,
  UnitSettingsLockState
} from '../../shared/types'
import { ensureSchoolLookupSeed } from './schoolLookup'

const STORAGE_KEY = 'unit'
const retainedBaseTables = new Set(['岗位工资对照', '薪级工资对照', '乡镇工作年限对照', '学校对照表'])

export const defaultSalaryExportSaltypes: SalaryExportSaltype[] = [
  { saltype_id: '2', saltype_name: '002事业' },
  // 实测：内网下拉里 "006事业退休" 的真实 saltypeid 是 5
  { saltype_id: '5', saltype_name: '事业退休' }
]

export const defaultUnitSettings: UnitSettings = {
  unitFullName: '',
  unitImportCode: '',
  schoolLevel: '小学教育',
  functionCode: '2050202',
  retiredFunctionCode: '2210202',
  retiredFunctionName: '退休提租补贴',
  budgetActiveCode: '',
  budgetRetiredCode: '',
  socialPayeeName: '',
  socialPayeeBank: '',
  socialPayeeAccount: '',
  housingPayeeName: '',
  housingPayeeBank: '',
  housingPayeeAccount: '',
  salaryExportSaltypes: defaultSalaryExportSaltypes.map((t) => ({ ...t }))
}

export async function readUnitSettings(): Promise<UnitSettings> {
  const database = await getDatabase()
  await ensureSchoolLookupSeed(database)
  const row = await get<{ value: string }>(
    database,
    'SELECT value FROM app_settings WHERE key = ?',
    [STORAGE_KEY]
  )
  if (!row?.value) return { ...defaultUnitSettings }
  try {
    const parsed = JSON.parse(row.value) as Partial<UnitSettings>
    return { ...defaultUnitSettings, ...parsed }
  } catch {
    return { ...defaultUnitSettings }
  }
}

export async function writeUnitSettings(settings: UnitSettings): Promise<UnitSettings> {
  const database = await getDatabase()
  const lockState = await getUnitSettingsLockState()
  if (lockState.locked) {
    const tableNames = lockState.tables.slice(0, 3).map((item) => item.name).join('、')
    throw new Error(`系统已有业务数据（${tableNames}等），不能重新填写单位信息`)
  }
  const merged: UnitSettings = { ...defaultUnitSettings, ...settings }
  await run(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [STORAGE_KEY, JSON.stringify(merged)]
  )
  return merged
}

export async function getUnitSettingsLockState(): Promise<UnitSettingsLockState> {
  const database = await getDatabase()
  await ensureSchoolLookupSeed(database)

  const tables: UnitSettingsLockState['tables'] = []
  for (const worksheet of readWorksheetMetadata()) {
    if (retainedBaseTables.has(worksheet.name)) continue
    const row = await get<{ total: number }>(
      database,
      `SELECT COUNT(*) AS total FROM ${quoteIdentifier(worksheet.name)}`
    )
    const rows = row?.total ?? 0
    if (rows > 0) tables.push({ name: worksheet.name, rows })
  }

  const payrollRuns = await get<{ total: number }>(
    database,
    `SELECT COUNT(*) AS total FROM monthly_payroll_runs`
  )
  if ((payrollRuns?.total ?? 0) > 0) {
    tables.push({ name: '工资报账记录', rows: payrollRuns?.total ?? 0 })
  }

  const rowCount = tables.reduce((sum, item) => sum + item.rows, 0)
  return {
    locked: rowCount > 0,
    rowCount,
    tables
  }
}
