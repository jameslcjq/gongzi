export type CellValue = string | number | boolean | Date | null | undefined

export type SalarySummary = {
  active: Record<string, number>
  survivor: Record<string, number>
  activePeople: PayrollPerson[]
  survivorPeople: PayrollPerson[]
}

export type PayrollPerson = {
  idCard: string
  name: string
  account: string
  rowNumber: number
  values: Record<string, number | string>
}

export type SocialSecuritySummary = {
  byItem: Record<string, number>
  rowCount: number
  periods: PayrollPeriodRange[]
}

export type TaxSummary = {
  totalTax: number
  rows: TaxPerson[]
  missingIdCards: TaxPerson[]
  periods: PayrollPeriodRange[]
}

export type PayrollPeriodRange = {
  startMonth: string
  endMonth: string
  rowCount: number
}

export type TaxPerson = {
  idCard: string
  name: string
  taxAmount: number
  rowNumber: number
}

export type PersonalInsuranceTotals = {
  pension: number
  annuity: number
  medical: number
  unemployment: number
  housing: number
  total: number
}

export type RetiredSummary = {
  count: number
  housing: number
  payable: number
  actualPay: number
}

export type RetiredHousingPerson = {
  name: string
  idCard: string
  unitName: string
  housing: number
  backpay: number
  payable: number
  actualPay: number
}

export type IntegratedActiveAggregates = {
  count: number
  基本工资: number
  教龄津贴: number
  其他一: number
  住房补贴: number
  基础性绩效: number
  交通补贴: number
  绩效工资: number
  工作性津贴: number
  特岗性津补贴: number
  补发工资: number
  其他二: number
  其他三: number
  应发工资: number
  个税: number
  实发合计: number
  养老保险: number
  职业年金: number
  医疗保险: number
  失业保险: number
  公积金: number
  五险一金合计: number
}

export type IntegratedSimpleAggregates = {
  count: number
  住房补贴: number
  补发工资: number
  应发工资小计: number
  实发合计: number
}
