import assert from 'node:assert/strict'
import type { UnitSettings } from '../src/shared/types'
import { buildInsuranceVoucherUsage, buildVoucherSheet } from '../src/main/services/monthly-payroll/voucherSheet'

const unit: UnitSettings = {
  unitFullName: '测试单位',
  unitImportCode: '001',
  schoolLevel: '小学教育',
  functionCode: '2050202',
  retiredFunctionCode: '2080502',
  retiredFunctionName: '事业单位离退休',
  budgetActiveCode: '001001',
  budgetRetiredCode: '001002',
  socialPayeeName: '',
  socialPayeeBank: '',
  socialPayeeAccount: '',
  housingPayeeName: '',
  housingPayeeBank: '',
  housingPayeeAccount: ''
}

const sheet = buildVoucherSheet(
  {
    unit,
    today: new Date('2026-06-09T00:00:00'),
    active: {
      养老保险: 100,
      职业年金: 50,
      医保大病统筹: 70,
      失业保险: 10,
      住房公积金: 30,
      个税: 40,
      五险一金: 300
    },
    activeTax: 40,
    actualPay: 1000,
    basicActual: 1000,
    teachingAge: 20,
    ruralTotal: 0,
    housing: 80,
    performance: 400,
    traffic: 0,
    survivorTotal: 0,
    retiredHousing: 0,
    salaryReimburseTotal: 0,
    insuranceVoucherTotal: 0,
    withholdingTotal: 300,
    salaryVoucherInsurance: 260
  },
  { includeSalaryVoucher: true, includeInsuranceVoucher: false }
)

const salaryExpenseRow = sheet.rows.find((row) => row[4] === '工资福利费用' && row[7] === '本月工资')
assert.ok(salaryExpenseRow)
assert.equal(salaryExpenseRow[5], 1760)

const taxWithholdingRow = sheet.rows.find((row) => row[7] === '代扣个人所得税')
assert.ok(taxWithholdingRow)
assert.equal(taxWithholdingRow[6], 40)

assert.equal(buildInsuranceVoucherUsage({}, undefined, 40, 300), '五险一金、个税')

console.log('monthly payroll voucher sheet tests passed')
