import type { MonthlyPayrollPrintSettings, PrinterSummary } from '@shared/types'

export type CachedMonthlyPayrollPrintOptions = {
  printers: PrinterSummary[]
  settings: MonthlyPayrollPrintSettings
}

let cachedMonthlyPayrollPrintOptions: CachedMonthlyPayrollPrintOptions | null = null
let pendingMonthlyPayrollPrintOptions: Promise<CachedMonthlyPayrollPrintOptions> | null = null

export async function loadCachedMonthlyPayrollPrintOptions(
  loadOptions: () => Promise<CachedMonthlyPayrollPrintOptions>
): Promise<CachedMonthlyPayrollPrintOptions> {
  if (cachedMonthlyPayrollPrintOptions) return cachedMonthlyPayrollPrintOptions

  pendingMonthlyPayrollPrintOptions ??= loadOptions()
  try {
    cachedMonthlyPayrollPrintOptions = await pendingMonthlyPayrollPrintOptions
    return cachedMonthlyPayrollPrintOptions
  } finally {
    pendingMonthlyPayrollPrintOptions = null
  }
}

export function updateCachedMonthlyPayrollPrintOptions(
  options: CachedMonthlyPayrollPrintOptions
): CachedMonthlyPayrollPrintOptions {
  cachedMonthlyPayrollPrintOptions = options
  return cachedMonthlyPayrollPrintOptions
}

export function cachedMonthlyPayrollPrintersFallback(fallback: PrinterSummary[]): PrinterSummary[] {
  return cachedMonthlyPayrollPrintOptions?.printers ?? fallback
}
