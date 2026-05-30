import { get, getDatabase, run } from '../../db/connection'
import type {
  MonthlyPayrollSettings,
  MonthlyPayrollTaxField
} from '../../../shared/types'

const STORAGE_KEY = 'monthly-payroll'

export const monthlyPayrollTaxFields: MonthlyPayrollTaxField[] = [
  '补扣工资',
  '当月个人所得税'
]

export const defaultMonthlyPayrollSettings: MonthlyPayrollSettings = {
  taxField: '补扣工资'
}

export function normalizeMonthlyPayrollTaxField(value: unknown): MonthlyPayrollTaxField {
  return monthlyPayrollTaxFields.includes(value as MonthlyPayrollTaxField)
    ? value as MonthlyPayrollTaxField
    : defaultMonthlyPayrollSettings.taxField
}

export function inactiveMonthlyPayrollTaxField(
  taxField: MonthlyPayrollTaxField
): MonthlyPayrollTaxField {
  return taxField === '补扣工资' ? '当月个人所得税' : '补扣工资'
}

export async function readMonthlyPayrollSettings(): Promise<MonthlyPayrollSettings> {
  const database = await getDatabase()
  const row = await get<{ value: string }>(
    database,
    'SELECT value FROM app_settings WHERE key = ?',
    [STORAGE_KEY]
  )
  if (!row?.value) return { ...defaultMonthlyPayrollSettings }
  try {
    const parsed = JSON.parse(row.value) as Partial<MonthlyPayrollSettings>
    return {
      ...defaultMonthlyPayrollSettings,
      taxField: normalizeMonthlyPayrollTaxField(parsed.taxField)
    }
  } catch {
    return { ...defaultMonthlyPayrollSettings }
  }
}

export async function writeMonthlyPayrollSettings(
  settings: MonthlyPayrollSettings
): Promise<MonthlyPayrollSettings> {
  const database = await getDatabase()
  const merged: MonthlyPayrollSettings = {
    ...defaultMonthlyPayrollSettings,
    taxField: normalizeMonthlyPayrollTaxField(settings.taxField)
  }
  await run(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [STORAGE_KEY, JSON.stringify(merged)]
  )
  return merged
}
