import { get, getDatabase, run } from '../db/connection'
import type { MonthlyPayrollPrintSettings } from '../../shared/types'

const STORAGE_KEY = 'monthlyPayrollPrintSettings'

export const defaultMonthlyPayrollPrintSettings: MonthlyPayrollPrintSettings = {
  reportPrinterName: '',
  voucherPrinterName: '',
  voucherOffsetX: 0,
  voucherOffsetY: 0
}

export async function readMonthlyPayrollPrintSettings(): Promise<MonthlyPayrollPrintSettings> {
  const database = await getDatabase()
  const row = await get<{ value: string }>(
    database,
    'SELECT value FROM app_settings WHERE key = ?',
    [STORAGE_KEY]
  )
  if (!row?.value) return { ...defaultMonthlyPayrollPrintSettings }
  try {
    const parsed = JSON.parse(row.value) as Partial<MonthlyPayrollPrintSettings>
    return { ...defaultMonthlyPayrollPrintSettings, ...parsed }
  } catch {
    return { ...defaultMonthlyPayrollPrintSettings }
  }
}

export async function writeMonthlyPayrollPrintSettings(
  settings: MonthlyPayrollPrintSettings
): Promise<MonthlyPayrollPrintSettings> {
  const database = await getDatabase()
  const merged: MonthlyPayrollPrintSettings = {
    ...defaultMonthlyPayrollPrintSettings,
    ...settings
  }
  await run(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [STORAGE_KEY, JSON.stringify(merged)]
  )
  return merged
}
