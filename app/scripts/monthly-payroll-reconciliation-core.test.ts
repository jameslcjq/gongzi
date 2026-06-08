import assert from 'node:assert/strict'
import type { MonthlyPayrollReportSheet } from '../src/shared/types'
import type { SalarySummary } from '../src/main/services/monthly-payroll/monthlyPayrollTypes'
import { reconcileActiveBackpayPeople } from '../src/main/services/monthly-payroll/monthlyPayrollReconciliationCore'

const idCard = '320000197001010000'

const salary: SalarySummary = {
  active: {},
  survivor: {},
  activePeople: [
    {
      idCard,
      name: '杨翠红',
      account: '',
      rowNumber: 2,
      values: {
        基本补发: 0,
        绩效补发: -4600,
        当月个人所得税: 17.78
      }
    }
  ],
  survivorPeople: []
}

const backpaySheet: MonthlyPayrollReportSheet = {
  name: '补发工资',
  columns: [],
  rows: [[idCard, 6, '杨翠红', '事业', 2026, '', '', '', -4600, -17.78]],
  showColumnHeader: false
}

const missingBackpay = reconcileActiveBackpayPeople({
  salary,
  dataSourceMode: 'salary-workbook',
  sheets: [backpaySheet],
  activeRows: [
    {
      idCard,
      name: '杨翠红',
      values: {
        补发工资: 0,
        补扣工资: 17.78
      }
    }
  ]
})

assert.equal(missingBackpay.check.checkedCount, 1)
const missingBackpayIssue = missingBackpay.issues.find((issue) => issue.fieldName === '补扣工资')
assert.ok(missingBackpayIssue)
assert.equal(missingBackpayIssue.sourceValue, 4617.78)
assert.equal(missingBackpayIssue.databaseValue, 17.78)
assert.equal(missingBackpayIssue.difference, 4600)

const matchedBackpay = reconcileActiveBackpayPeople({
  salary,
  dataSourceMode: 'salary-workbook',
  sheets: [backpaySheet],
  activeRows: [
    {
      idCard,
      name: '杨翠红',
      values: {
        补发工资: 0,
        补扣工资: 4617.78
      }
    }
  ]
})

assert.deepEqual(matchedBackpay.issues, [])

console.log('monthly payroll reconciliation core tests passed')
