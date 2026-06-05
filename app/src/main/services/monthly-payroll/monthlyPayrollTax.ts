import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { getMonthlyPayrollTempPath } from '../../config/paths'
import { writeTaxToSalaryWorkbookViaExcel } from './printSalaryViaExcel'
import type { SalarySummary, TaxSummary } from './monthlyPayrollTypes'
import { num, roundMoney } from './monthlyPayrollUtils'

export function buildTaxByIdCardFromSummary(tax: TaxSummary | undefined): Record<string, number> {
  const map: Record<string, number> = {}
  if (!tax) return map
  for (const row of tax.rows) {
    if (!row.idCard) continue
    map[row.idCard] = row.taxAmount
  }
  return map
}

export function applyTaxToSalarySummary(
  salary: SalarySummary,
  taxByIdCard: Record<string, number>,
  options: { clearTaxWhenMissing?: boolean } = {}
): SalarySummary {
  // 个税表是本月扣税来源；未提供个税表时可按业务口径把本月扣税清零重新算实发。
  if (Object.keys(taxByIdCard).length === 0 && !options.clearTaxWhenMissing) return salary

  let oldTaxTotal = 0
  let nextTaxTotal = 0
  const activePeople = salary.activePeople.map((person) => {
    const currentTax = num(person.values['当月个人所得税'])
    const hasOverride = Object.prototype.hasOwnProperty.call(taxByIdCard, person.idCard)
    const nextTax = hasOverride
      ? roundMoney(taxByIdCard[person.idCard])
      : options.clearTaxWhenMissing ? 0 : currentTax
    oldTaxTotal = roundMoney(oldTaxTotal + currentTax)
    nextTaxTotal = roundMoney(nextTaxTotal + nextTax)
    if (nextTax === currentTax) return person

    const values = { ...person.values }
    values['当月个人所得税'] = nextTax
    values['代扣合计'] = roundMoney(num(values['代扣合计']) - currentTax + nextTax)
    values['实发合计'] = roundMoney(num(values['实发合计']) + currentTax - nextTax)
    return { ...person, values }
  })

  const delta = roundMoney(nextTaxTotal - oldTaxTotal)
  return {
    ...salary,
    active: {
      ...salary.active,
      个税: roundMoney(num(salary.active['个税']) + delta),
      五险一金: roundMoney(num(salary.active['五险一金']) + delta),
      实发工资合计: roundMoney(num(salary.active['实发工资合计']) - delta)
    },
    activePeople
  }
}

export async function backupAndWriteTaxToSalaryWorkbook(
  salaryWorkbookPath: string,
  salary: SalarySummary,
  taxByIdCard: Record<string, number>,
  period: { year: number; month: number },
  stamp: string,
  existingOriginalPath: string | null = null
): Promise<string | null> {
  if (!salaryWorkbookNeedsTaxWrite(salary, taxByIdCard)) return null
  const backupPath = existingOriginalPath && existsSync(existingOriginalPath)
    ? existingOriginalPath
    : backupSalaryWorkbookBeforeTaxWrite(salaryWorkbookPath, period, stamp)
  await writeTaxToSalaryWorkbookViaExcel({
    salaryWorkbookPath,
    taxByIdCard
  })
  return backupPath
}

function salaryWorkbookNeedsTaxWrite(
  salary: SalarySummary,
  taxByIdCard: Record<string, number>
): boolean {
  if (Object.keys(taxByIdCard).length === 0) return false
  return salary.activePeople.some((person) => {
    if (!Object.prototype.hasOwnProperty.call(taxByIdCard, person.idCard)) return false
    return num(person.values['当月个人所得税']) !== roundMoney(taxByIdCard[person.idCard])
  })
}

function backupSalaryWorkbookBeforeTaxWrite(
  salaryWorkbookPath: string,
  period: { year: number; month: number },
  stamp: string
): string {
  const backupDir = getMonthlyPayrollTempPath(period.year, period.month, '工资表回写备份')
  mkdirSync(backupDir, { recursive: true })
  const extension = extname(salaryWorkbookPath) || '.xlsx'
  const baseName = basename(salaryWorkbookPath, extension).replace(/[<>:"/\\|?*]+/g, '_') || '工资表'
  const backupPath = uniqueLocalPath(backupDir, `个税回写前_${stamp}_${baseName}${extension}`)
  copyFileSync(salaryWorkbookPath, backupPath)
  return backupPath
}

function uniqueLocalPath(targetDir: string, fileName: string): string {
  let candidate = join(targetDir, fileName)
  if (!existsSync(candidate)) return candidate

  const dotIndex = fileName.lastIndexOf('.')
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : ''
  for (let index = 2; ; index += 1) {
    candidate = join(targetDir, `${stem}_${index}${extension}`)
    if (!existsSync(candidate)) return candidate
  }
}
