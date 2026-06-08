import { get, getDatabase, run } from '../db/connection'
import type { MonthlyPayrollPrintSettings } from '../../shared/types'

const STORAGE_KEY = 'monthlyPayrollPrintSettings'
const VOUCHER_OFFSET_PRESET_VERSION = 1
const DEFAULT_VOUCHER_OFFSET_MM = 10

export const defaultMonthlyPayrollPrintSettings: MonthlyPayrollPrintSettings = {
  reportPrinterName: '',
  voucherPrinterName: '',
  voucherOffsetX: DEFAULT_VOUCHER_OFFSET_MM,
  voucherOffsetY: DEFAULT_VOUCHER_OFFSET_MM,
  voucherOffsetPresetVersion: VOUCHER_OFFSET_PRESET_VERSION
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
    return normalizeMonthlyPayrollPrintSettings(parsed)
  } catch {
    return { ...defaultMonthlyPayrollPrintSettings }
  }
}

export async function writeMonthlyPayrollPrintSettings(
  settings: MonthlyPayrollPrintSettings
): Promise<MonthlyPayrollPrintSettings> {
  const database = await getDatabase()
  const merged = normalizeMonthlyPayrollPrintSettings(settings, true)
  await run(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [STORAGE_KEY, JSON.stringify(merged)]
  )
  return merged
}

function normalizeMonthlyPayrollPrintSettings(
  settings: Partial<MonthlyPayrollPrintSettings>,
  preserveExplicitOffsets = false
): MonthlyPayrollPrintSettings {
  const merged: MonthlyPayrollPrintSettings = {
    ...defaultMonthlyPayrollPrintSettings,
    ...settings,
    voucherOffsetX: Number(settings.voucherOffsetX ?? defaultMonthlyPayrollPrintSettings.voucherOffsetX),
    voucherOffsetY: Number(settings.voucherOffsetY ?? defaultMonthlyPayrollPrintSettings.voucherOffsetY),
    voucherOffsetPresetVersion: VOUCHER_OFFSET_PRESET_VERSION
  }

  if (
    !preserveExplicitOffsets &&
    settings.voucherOffsetPresetVersion !== VOUCHER_OFFSET_PRESET_VERSION &&
    Number(settings.voucherOffsetX ?? 0) === 0 &&
    Number(settings.voucherOffsetY ?? 0) === 0
  ) {
    merged.voucherOffsetX = DEFAULT_VOUCHER_OFFSET_MM
    merged.voucherOffsetY = DEFAULT_VOUCHER_OFFSET_MM
  }

  return merged
}
