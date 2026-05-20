import { getDatabase, get, run } from '../db/connection'
import type { SalaryExportTarget, UnitSettings } from '../../shared/types'

const STORAGE_KEY = 'unit'

export const defaultSalaryExportTargets: SalaryExportTarget[] = [
  { saltype_id: '2', saltype_name: '002事业', salbatch_id: '1', salbatch_name: '批次001' },
  { saltype_id: '2', saltype_name: '002事业', salbatch_id: '2', salbatch_name: '批次002' },
  { saltype_id: '6', saltype_name: '006事业退休', salbatch_id: '1', salbatch_name: '批次001' }
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
  salaryExportTargets: defaultSalaryExportTargets.map((t) => ({ ...t }))
}

export async function readUnitSettings(): Promise<UnitSettings> {
  const database = await getDatabase()
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
  const merged: UnitSettings = { ...defaultUnitSettings, ...settings }
  await run(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [STORAGE_KEY, JSON.stringify(merged)]
  )
  return merged
}
