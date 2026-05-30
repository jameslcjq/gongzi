import { all, getDatabase } from '../../db/connection'
import { getWorksheetLocalColumns } from '../../db/schema'
import { readUnitSettings } from '../unitSettings'
import { getWorksheetByName, tableNameOf } from '../worksheetTable'
import type { MonthlyPayrollWorkflowInput } from '../../../shared/types'
import {
  importHousingFundDetail,
  importSocialSecurityDetail,
  importTaxDetail,
  type HousingFundDetailRow
} from './detailImport'
import { loadIntegratedRows } from './integratedPayroll'
import { readMonthlyPayrollSettings } from './monthlyPayrollSettings'
import { resolvePayrollPeriod } from './monthlyPayrollRuns'
import type {
  IntegratedActiveAggregates,
  IntegratedSimpleAggregates,
  PersonalInsuranceTotals,
  RetiredHousingPerson,
  RetiredSummary,
  SalarySummary
} from './monthlyPayrollTypes'
import {
  isValidIdCard,
  normalizeIdCard,
  num,
  roundMoney,
  text
} from './monthlyPayrollUtils'

const integratedActivePayableFields = [
  '岗位工资',
  '薪级工资',
  '岗位津贴',
  '生活补贴',
  '绩效工资',
  '工作性津贴',
  '教（工）龄补贴',
  '特岗性津补贴',
  '交通费',
  '公车补贴',
  '住房补贴',
  '基础绩效奖',
  '补发工资',
  '其他一',
  '其他二',
  '其他三'
]

export async function loadRetiredSummary(): Promise<RetiredSummary> {
  try {
    const worksheet = getWorksheetByName('一体化退休')
    const columns = getWorksheetLocalColumns(worksheet)
    const idColumn = columns.find((column) => column.field.name === '证件号码')?.columnName
    const housingColumn = columns.find((column) => column.field.name === '住房补贴')?.columnName
    if (!idColumn || !housingColumn) return { count: 0, housing: 0 }
    const database = await getDatabase()
    const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
    const latestById = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const idCard = normalizeIdCard(row[idColumn])
      if (!isValidIdCard(idCard)) continue
      const previous = latestById.get(idCard)
      if (!previous || num(row.id) > num(previous.id)) latestById.set(idCard, row)
    }
    const latest = Array.from(latestById.values())
    return {
      count: latest.length,
      housing: roundMoney(latest.reduce((sum, row) => sum + num(row[housingColumn]), 0))
    }
  } catch {
    return { count: 0, housing: 0 }
  }
}

export async function loadRetiredHousingDetails(): Promise<RetiredHousingPerson[]> {
  try {
    const worksheet = getWorksheetByName('一体化退休')
    const columns = getWorksheetLocalColumns(worksheet)
    const colByName = (name: string): string | undefined =>
      columns.find((column) => column.field.name === name)?.columnName
    const idColumn = colByName('证件号码')
    const nameColumn = colByName('姓名')
    const unitColumn = colByName('单位名称')
    const housingColumn = colByName('住房补贴')
    const backpayColumn = colByName('补发工资')
    const otherOneColumn = colByName('其他一')
    const deductionColumn = colByName('代扣工资')
    if (!idColumn || !housingColumn) return []
    const database = await getDatabase()
    const rows = await all<Record<string, unknown>>(database, `SELECT * FROM ${tableNameOf(worksheet)}`)
    const latestById = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const idCard = normalizeIdCard(row[idColumn])
      if (!isValidIdCard(idCard)) continue
      const previous = latestById.get(idCard)
      if (!previous || num(row.id) > num(previous.id)) latestById.set(idCard, row)
    }
    return Array.from(latestById.values()).map((row) => {
      const housing = roundMoney(num(row[housingColumn]))
      const backpay = roundMoney(backpayColumn ? num(row[backpayColumn]) : 0)
      const payable = roundMoney(
        num(row[housingColumn]) +
          (backpayColumn ? num(row[backpayColumn]) : 0) +
          (otherOneColumn ? num(row[otherOneColumn]) : 0)
      )
      const deduction = deductionColumn ? num(row[deductionColumn]) : 0
      return {
        name: nameColumn ? text(row[nameColumn]) : '',
        idCard: normalizeIdCard(row[idColumn]),
        unitName: unitColumn ? text(row[unitColumn]) : '',
        housing,
        backpay,
        payable,
        actualPay: roundMoney(payable - deduction)
      }
    })
  } catch {
    return []
  }
}

export async function loadIntegratedActiveHousingFund(): Promise<number> {
  try {
    const rows = await loadIntegratedRows('一体化在职')
    return roundMoney(rows.reduce((sum, row) => sum + num(row.values['公积金']), 0))
  } catch {
    return 0
  }
}

export async function loadIntegratedActiveAggregates(): Promise<IntegratedActiveAggregates> {
  const empty: IntegratedActiveAggregates = {
    count: 0,
    基本工资: 0,
    教龄津贴: 0,
    其他一: 0,
    住房补贴: 0,
    基础性绩效: 0,
    交通补贴: 0,
    绩效工资: 0,
    工作性津贴: 0,
    特岗性津补贴: 0,
    补发工资: 0,
    其他二: 0,
    其他三: 0,
    应发工资: 0,
    个税: 0,
    实发合计: 0,
    养老保险: 0,
    职业年金: 0,
    医疗保险: 0,
    失业保险: 0,
    公积金: 0,
    五险一金合计: 0
  }
  try {
    const rows = await loadIntegratedRows('一体化在职')
    const { taxField } = await readMonthlyPayrollSettings()
    const sumField = (name: string): number =>
      rows.reduce((sum, row) => sum + num(row.values[name]), 0)
    const result: IntegratedActiveAggregates = {
      count: rows.length,
      基本工资: roundMoney(sumField('岗位工资') + sumField('薪级工资')),
      教龄津贴: roundMoney(sumField('教（工）龄补贴')),
      其他一: roundMoney(sumField('其他一')),
      住房补贴: roundMoney(sumField('住房补贴')),
      基础性绩效: roundMoney(sumField('岗位津贴') + sumField('生活补贴')),
      交通补贴: roundMoney(sumField('交通费') + sumField('公车补贴')),
      绩效工资: roundMoney(sumField('绩效工资')),
      工作性津贴: roundMoney(sumField('工作性津贴')),
      特岗性津补贴: roundMoney(sumField('特岗性津补贴')),
      补发工资: roundMoney(sumField('补发工资')),
      其他二: roundMoney(sumField('其他二')),
      其他三: roundMoney(sumField('其他三')),
      应发工资: roundMoney(
        integratedActivePayableFields.reduce((sum, name) => sum + sumField(name), 0)
      ),
      个税: roundMoney(sumField(taxField)),
      实发合计: roundMoney(sumField('实发合计')),
      养老保险: roundMoney(sumField('养老保险缴费')),
      职业年金: roundMoney(sumField('职业年金缴费')),
      医疗保险: roundMoney(sumField('医疗保险')),
      失业保险: roundMoney(sumField('失业保险')),
      公积金: roundMoney(sumField('公积金')),
      五险一金合计: roundMoney(
        sumField('养老保险缴费') +
          sumField('职业年金缴费') +
          sumField('医疗保险') +
          sumField('失业保险') +
          sumField('公积金')
      )
    }
    return result
  } catch {
    return empty
  }
}

export async function loadIntegratedActiveBackpayRows(): Promise<Array<Array<string | number>>> {
  try {
    const rows = await loadIntegratedRows('一体化在职')
    const { taxField } = await readMonthlyPayrollSettings()
    const year = new Date().getFullYear()
    const month = new Date().getMonth() + 1
    return rows
      .filter((row) => {
        const backpay = num(row.values['补发工资'])
        const tax = num(row.values[taxField])
        return backpay !== 0 || tax !== 0
      })
      .map((row) => {
        const out = createIntegratedBackpayRow(row.idCard, row.name, year, month)
        out[17] = roundMoney(num(row.values['补发工资']))
        const tax = roundMoney(num(row.values[taxField]))
        out[taxField === '补扣工资' ? 18 : 22] = tax
        return out
      })
  } catch {
    return []
  }
}

function createIntegratedBackpayRow(
  idCard: string,
  name: string,
  year: number,
  month: number
): Array<string | number> {
  const row: Array<string | number> = Array.from({ length: 24 }, () => '')
  row[0] = idCard
  row[1] = month
  row[2] = name
  row[3] = '事业'
  row[4] = year
  return row
}

export async function loadIntegratedSimpleAggregates(
  worksheetName: '一体化退休' | '一体化其他'
): Promise<IntegratedSimpleAggregates> {
  const empty: IntegratedSimpleAggregates = {
    count: 0,
    住房补贴: 0,
    补发工资: 0,
    应发工资小计: 0,
    实发合计: 0
  }
  try {
    const rows = await loadIntegratedRows(worksheetName)
    const sumField = (name: string): number =>
      rows.reduce((sum, row) => sum + num(row.values[name]), 0)
    return {
      count: rows.length,
      住房补贴: roundMoney(sumField('住房补贴')),
      补发工资: roundMoney(sumField('补发工资')),
      应发工资小计: roundMoney(sumField('应发工资小计')),
      实发合计: roundMoney(sumField('实发合计'))
    }
  } catch {
    return empty
  }
}

export async function runDetailImports(
  input: MonthlyPayrollWorkflowInput,
  salary: SalarySummary | undefined
): Promise<void> {
  const unit = await readUnitSettings()
  const unitCode = text(unit.unitImportCode)
  const unitName = text(unit.unitFullName)

  if (input.socialSecurityWorkbookPath) {
    try {
      await importSocialSecurityDetail(input.socialSecurityWorkbookPath, unitCode, unitName)
    } catch (error) {
      console.warn('社保明细入库失败：', error)
    }
  }
  if (input.taxWorkbookPath) {
    try {
      await importTaxDetail(input.taxWorkbookPath, unitCode, unitName)
    } catch (error) {
      console.warn('个税明细入库失败：', error)
    }
  }
  if (salary && input.salaryWorkbookPath) {
    try {
      const period = resolvePayrollPeriod(input)
      const detailRows: HousingFundDetailRow[] = salary.activePeople
        .filter((person) => person.idCard)
        .map((person) => ({
          idCard: person.idCard,
          name: person.name,
          personal: num(person.values['公积金']),
          unitAmount: num(person.values['公积金'])
        }))
      await importHousingFundDetail(
        detailRows,
        period.year,
        period.month,
        unitCode,
        unitName,
        input.salaryWorkbookPath ? input.salaryWorkbookPath.split(/[/\\]/).pop() ?? '' : ''
      )
    } catch (error) {
      console.warn('公积金明细入库失败：', error)
    }
  }
}

export async function loadIntegratedActivePersonalInsuranceTotals(): Promise<PersonalInsuranceTotals> {
  try {
    const rows = await loadIntegratedRows('一体化在职')
    return personalInsuranceTotals({
      pension: rows.reduce((sum, row) => sum + num(row.values['养老保险缴费']), 0),
      annuity: rows.reduce((sum, row) => sum + num(row.values['职业年金缴费']), 0),
      medical: rows.reduce((sum, row) => sum + num(row.values['医疗保险']), 0),
      unemployment: rows.reduce((sum, row) => sum + num(row.values['失业保险']), 0),
      housing: rows.reduce((sum, row) => sum + num(row.values['公积金']), 0)
    })
  } catch {
    return personalInsuranceTotals({ pension: 0, annuity: 0, medical: 0, unemployment: 0, housing: 0 })
  }
}

function personalInsuranceTotals(
  values: Omit<PersonalInsuranceTotals, 'total'>
): PersonalInsuranceTotals {
  const pension = roundMoney(values.pension)
  const annuity = roundMoney(values.annuity)
  const medical = roundMoney(values.medical)
  const unemployment = roundMoney(values.unemployment)
  const housing = roundMoney(values.housing)
  return {
    pension,
    annuity,
    medical,
    unemployment,
    housing,
    total: roundMoney(pension + annuity + medical + unemployment + housing)
  }
}
