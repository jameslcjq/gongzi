import type { MonthlyPayrollReportSheet, UnitSettings } from '../../../shared/types'
import { canonicalInsuranceItemName, sumSocialByCanonicalName } from './socialSecuritySummary'
import { formatMoney, num, roundMoney } from './monthlyPayrollUtils'

type VoucherSocialSecuritySummary = {
  byItem: Record<string, number>
  rowCount: number
}

type VoucherInput = {
  unit: UnitSettings
  today: Date
  active: Record<string, number>
  socialSecurity?: VoucherSocialSecuritySummary
  activeTax: number
  actualPay: number
  basicActual: number
  teachingAge: number
  ruralTotal: number
  housing: number
  performance: number
  traffic: number
  survivorTotal: number
  retiredHousing: number
  salaryReimburseTotal: number
  insuranceVoucherTotal: number
  withholdingTotal: number
  activeInsurance: number
}

type VoucherEntry = {
  voucherNo: '1' | '2'
  subjectCode: string
  subjectName: string
  debit?: number
  credit?: number
  attachmentCount?: number
  summary: string
  partyCode?: string | number
  partyName?: string
  budgetCode?: string
  budgetName?: string
  functionCode?: string
  functionName?: string
  fundCode?: string
  fundName?: string
  econCode?: string
  econName?: string
  hasDifference?: boolean
}

type VoucherBuildOptions = {
  includeSalaryVoucher: boolean
  includeInsuranceVoucher: boolean
}

const VOUCHER_COLUMNS = [
  '凭证日期', '凭证类型', '凭证号', '会计科目编码', '会计科目名称', '借方金额', '贷方金额',
  '摘要', '附件数', '结算号', '辅助摘要', '往来编码', '往来名称', '预算项目编码', '预算项目名称',
  '部门编码', '部门名称', '支出功能分类编码', '支出功能分类名称', '收入功能分类（账务）编码',
  '收入功能分类（账务）名称', '基建项目编码', '基建项目名称', 'PPP项目编码', 'PPP项目名称',
  '资金性质编码', '资金性质名称', '往来时间编码', '往来时间名称', '投资对象编码', '投资对象名称',
  '物品各类编码', '物品各类名称', '开户银行编码', '开户银行名称', '费用用途编码', '费用用途名称',
  '差异项编码', '差异项名称', '资金往来对象类别编码', '资金往来对象类别名称', '收款账户编码',
  '收款账户名称', '收款人名称编码', '收款人名称名称', '项目类别编码', '项目类别名称',
  '单位核算自建项目编码', '单位核算自建项目名称', '部门支出经济分类（账务）编码',
  '部门支出经济分类（账务）名称'
]

const INSURANCE_VOUCHER_ATTACHMENT_COUNT = 7

function lastDayOfPayrollMonth(today: Date): Date {
  return new Date(today.getFullYear(), today.getMonth() + 1, 0)
}

export function buildVoucherSheet(
  input: VoucherInput,
  options: VoucherBuildOptions
): MonthlyPayrollReportSheet {
  const { unit, today, active, socialSecurity, activeTax } = input
  const date = lastDayOfPayrollMonth(today)
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const salaryAttachmentCount = options.includeSalaryVoucher ? 14 : 5

  const insurancePersonalPension = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '养老保险个人') : 0
  const insuranceUnitPension = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '养老保险单位') : 0
  const insurancePersonalAnnuity = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '职业年金个人') : 0
  const insuranceUnitAnnuity = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '职业年金单位') : 0
  const insurancePersonalMedical = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '医保个人') : 0
  const insuranceUnitMedical = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '医保单位') : 0
  const insuranceMaternity = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '生育保险') : 0
  const insurancePersonalUnemployment = socialSecurity ? sumSocialByCanonicalName(socialSecurity, '失业保险个人') : 0
  const insuranceUnitUnemployment = socialSecurity
    ? roundMoney(
        sumSocialByCanonicalName(socialSecurity, '工伤保险') +
          sumSocialByCanonicalName(socialSecurity, '失业保险单位')
      )
    : 0
  const housingFund = num(active['住房公积金'])

  const entries: VoucherEntry[] = []

  if (options.includeSalaryVoucher) {
    entries.push(
    // 凭证 1：本月工资发放
    { voucherNo: '1', subjectCode: '500101', subjectName: '工资福利费用', debit: roundMoney(input.basicActual + input.teachingAge + input.housing + input.performance + input.activeInsurance), summary: '本月工资', hasDifference: true },
    { voucherNo: '1', subjectCode: '500101', subjectName: '工资福利费用', debit: input.ruralTotal, summary: '农村补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '500101', subjectName: '工资福利费用', debit: input.traffic, summary: '交通补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '500103', subjectName: '对个人和家庭的补助费用', debit: input.survivorTotal, summary: '遗补', hasDifference: true },
    { voucherNo: '1', subjectCode: '500103', subjectName: '对个人和家庭的补助费用', debit: input.retiredHousing, summary: '退休房补', hasDifference: true },
    { voucherNo: '1', subjectCode: '400101', subjectName: '一般公共预算财政拨款', credit: input.actualPay, summary: '本月工资', hasDifference: true },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: num(active['养老保险']), summary: '代扣养老保险', partyCode: '999', partyName: '新养老保险' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: num(active['职业年金']), summary: '代扣职业年金', partyCode: '998', partyName: '新职业年金' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: num(active['医保大病统筹']), summary: '代扣医疗保险', partyCode: '997', partyName: '新四险' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: num(active['失业保险']), summary: '代扣失业保险', partyCode: '997', partyName: '新四险' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: housingFund, summary: '代扣住房公积金', partyCode: '996', partyName: '扣住房公积金' },
    { voucherNo: '1', subjectCode: '2307', subjectName: '其他应付款', credit: activeTax, summary: '代扣个人所得税', partyCode: 994, partyName: '扣个人所得税' },
    // 平行预算会计 (在职工资)
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.basicActual, summary: '基本工资', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.teachingAge, summary: '教龄津贴', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30102', econName: '津贴补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.ruralTotal, summary: '农村补贴', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30102', econName: '其他对个人和家庭的补助', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.housing, summary: '住房补贴', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30102', econName: '津贴补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.performance, summary: '绩效工资', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30107', econName: '绩效工资', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.traffic, summary: '交通补贴', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30102', econName: '津贴补贴', hasDifference: true },
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.survivorTotal, summary: '遗补', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30305', econName: '生活补助', hasDifference: true },
    { voucherNo: '1', subjectCode: '60010101', subjectName: '财政拨款预算收入', credit: roundMoney(input.basicActual + input.teachingAge + input.ruralTotal + input.housing + input.performance + input.traffic + input.survivorTotal), summary: '本月工资', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', hasDifference: true },
    // 平行预算会计 (退休房补)
    { voucherNo: '1', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: input.retiredHousing, summary: '退休房补', budgetCode: unit.budgetRetiredCode, budgetName: '人员支出', functionCode: unit.retiredFunctionCode, functionName: unit.retiredFunctionName, fundCode: '111', fundName: '一般公共预算资金', econCode: '30302', econName: '退休费', hasDifference: true },
    { voucherNo: '1', subjectCode: '60010101', subjectName: '财政拨款预算收入', credit: input.retiredHousing, summary: '退休房补', budgetCode: unit.budgetRetiredCode, budgetName: '人员支出', functionCode: unit.retiredFunctionCode, functionName: unit.retiredFunctionName, fundCode: '111', fundName: '一般公共预算资金', hasDifference: true }
    )
  }

  if (options.includeInsuranceVoucher && socialSecurity) {
    entries.push(
    // 凭证 2：五险一金缴纳
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: insurancePersonalPension, summary: '养老保险（个人）', partyCode: '999', partyName: '新养老保险' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceUnitPension, summary: '养老保险（单位）', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: insurancePersonalAnnuity, summary: '职业年金（个人）', partyCode: '998', partyName: '新职业年金' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceUnitAnnuity, summary: '职业年金（单位）', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: insurancePersonalMedical, summary: '医保（个人）', partyCode: '997', partyName: '新四险' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceUnitMedical, summary: '医保（单位）', hasDifference: true },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceMaternity, summary: '生育保险', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: insurancePersonalUnemployment, summary: '工伤失业（个人）', partyCode: '997', partyName: '新四险' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: insuranceUnitUnemployment, summary: '工伤失业(单位)', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: housingFund, summary: '住房公积金（个人）', partyCode: '996', partyName: '扣住房公积金' },
    { voucherNo: '2', subjectCode: '500101', subjectName: '工资福利费用', debit: housingFund, summary: '住房公积金（单位）', hasDifference: true },
    { voucherNo: '2', subjectCode: '2307', subjectName: '其他应付款', debit: activeTax, summary: '个人所得税', partyCode: 994, partyName: '扣个人所得税' },
    { voucherNo: '2', subjectCode: '400101', subjectName: '一般公共预算财政拨款', credit: input.insuranceVoucherTotal, summary: '五险一金、个税等', hasDifference: true },
    // 平行预算会计
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insurancePersonalPension, summary: '养老保险（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceUnitPension, summary: '养老保险（单位）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30108', econName: '机关事业单位基本养老保险缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insurancePersonalAnnuity, summary: '职业年金（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceUnitAnnuity, summary: '职业年金（单位）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30109', econName: '职业年金缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insurancePersonalMedical, summary: '医保（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceUnitMedical, summary: '医保（单位）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30110', econName: '职工基本医疗保险缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceMaternity, summary: '生育保险', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30110', econName: '职工基本医疗保险缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insurancePersonalUnemployment, summary: '工伤失业（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: insuranceUnitUnemployment, summary: '工伤失业(单位)', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30112', econName: '其他社会保障缴费', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: housingFund, summary: '住房公积金（个人）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: housingFund, summary: '住房公积金（单位）', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30113', econName: '住房公积金', hasDifference: true },
    { voucherNo: '2', subjectCode: '7201010101', subjectName: '财政拨款支出', debit: activeTax, summary: '个人所得税', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', econCode: '30101', econName: '基本工资', hasDifference: true },
    { voucherNo: '2', subjectCode: '60010101', subjectName: '财政拨款预算收入', credit: input.insuranceVoucherTotal, summary: '五险一金、个税等', budgetCode: unit.budgetActiveCode, budgetName: '人员支出', functionCode: unit.functionCode, functionName: unit.schoolLevel, fundCode: '111', fundName: '一般公共预算资金', hasDifference: true }
    )
  }

  const rows = entries.map((e) =>
    voucherRow(
      {
        ...e,
        attachmentCount:
          e.attachmentCount ??
          (e.voucherNo === '2' ? INSURANCE_VOUCHER_ATTACHMENT_COUNT : salaryAttachmentCount)
      },
      dateStr
    )
  )
  return { name: '凭证', columns: VOUCHER_COLUMNS, rows }
}

function voucherRow(e: VoucherEntry, dateStr: string): Array<string | number> {
  const row: Array<string | number> = new Array(VOUCHER_COLUMNS.length).fill('')
  row[0] = dateStr
  row[1] = '记账'
  row[2] = e.voucherNo
  row[3] = e.subjectCode
  row[4] = e.subjectName
  row[5] = e.debit ?? 0
  row[6] = e.credit ?? 0
  row[7] = e.summary
  row[8] = e.attachmentCount ?? 0
  row[9] = ''
  row[10] = e.summary
  if (e.partyCode !== undefined) row[11] = e.partyCode
  if (e.partyName) row[12] = e.partyName
  if (e.budgetCode) row[13] = e.budgetCode
  if (e.budgetName) row[14] = e.budgetName
  if (e.functionCode) row[17] = e.functionCode
  if (e.functionName) row[18] = e.functionName
  if (e.fundCode) row[25] = e.fundCode
  if (e.fundName) row[26] = e.fundName
  if (e.hasDifference) {
    row[37] = '0'
    row[38] = '无差异'
  }
  if (e.econCode) row[49] = e.econCode
  if (e.econName) row[50] = e.econName
  return row
}

export function departmentEconomicSubjectForSocialItem(item: string): { code: string; name: string } {
  const normalized = canonicalInsuranceItemName(item).replace(/\s+/g, '')
  const isPersonal = normalized.includes('个人')
  if (isPersonal) return { code: '30101', name: '基本工资' }
  if (normalized.includes('公积金')) return { code: '30113', name: '住房公积金' }
  if (normalized.includes('职业年金')) return { code: '30109', name: '职业年金缴费' }
  if (normalized.includes('养老')) return { code: '30108', name: '机关事业单位基本养老保险缴费' }
  if (normalized.includes('医疗') || normalized.includes('医保') || normalized.includes('大额') || normalized.includes('生育')) {
    return { code: '30110', name: '职工基本医疗保险缴费' }
  }
  if (normalized.includes('失业') || normalized.includes('工伤')) {
    return { code: '30112', name: '其他社会保障缴费' }
  }
  return { code: '', name: item }
}

export function buildInsuranceVoucherUsage(
  active: Record<string, number>,
  socialSecurity: VoucherSocialSecuritySummary | undefined,
  activeTax: number,
  total: number
): string {
  const social = socialSecurity ?? { byItem: {}, rowCount: 0 }
  return [
    ['职业年金（单位）', sumSocialByCanonicalName(social, '职业年金单位')],
    ['职业年金（个人）', sumSocialByCanonicalName(social, '职业年金个人')],
    ['养老保险费（单位）', sumSocialByCanonicalName(social, '养老保险单位')],
    ['养老保险费（个人）', sumSocialByCanonicalName(social, '养老保险个人')],
    ['医疗保险（个人）', sumSocialByCanonicalName(social, '医保个人')],
    ['医疗保险（单位）', sumSocialByCanonicalName(social, '医保单位')],
    ['生育保险', sumSocialByCanonicalName(social, '生育保险')],
    ['失业保险（单位）', sumSocialByCanonicalName(social, '失业保险单位')],
    ['失业保险（个人）', sumSocialByCanonicalName(social, '失业保险个人')],
    ['工伤保险', sumSocialByCanonicalName(social, '工伤保险')],
    ['公积金（个人）', num(active['住房公积金'])],
    ['公积金（单位）', num(active['住房公积金'])],
    ['个税', activeTax],
    ['合计', total],
    ['补缴养老保险', 0],
    ['补缴职业年金', 0],
    ['补缴医保、工伤失业等', 0]
  ].map(([label, amount]) => `${label}${formatVoucherAmount(Number(amount))}`).join('\n')
}

export function buildSalaryVoucherUsage(
  active: Record<string, number>,
  survivorTotal: number,
  retiredHousing: number,
  basicActual: number,
  activeInsurance: number,
  total: number
): string {
  return [
    ['退休房补', retiredHousing],
    ['遗属补助', survivorTotal],
    ['基本工资', basicActual],
    ['基础性绩效', num(active['基础性绩效'])],
    ['农村教师补贴', num(active['乡镇补贴'])],
    ['边远补贴', num(active['边远乡镇补贴'])],
    ['交通补贴', num(active['交通补贴'])],
    ['教龄津贴', num(active['教龄津贴'])],
    ['住房补贴', num(active['住房补贴'])],
    ['五险一金', activeInsurance],
    ['合计', total]
  ].map(([label, amount]) => `${label}${formatVoucherAmount(Number(amount))}`).join('\n')
}

export function formatVoucherAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : formatMoney(value).replace(/,/g, '')
}

export function toChineseRmb(value: number): string {
  if (value === 0) return '零元整'
  const digits = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const units = ['', '拾', '佰', '仟']
  const bigUnits = ['', '万', '亿', '兆']
  const integer = Math.floor(Math.abs(value))
  const cents = Math.round((Math.abs(value) - integer) * 100)
  const integerText = integerToChinese(integer, digits, units, bigUnits)
  const jiao = Math.floor(cents / 10)
  const fen = cents % 10
  const decimalText = jiao || fen
    ? `${jiao ? `${digits[jiao]}角` : ''}${fen ? `${digits[fen]}分` : ''}`
    : '整'
  return `${value < 0 ? '负' : ''}${integerText}元${decimalText}`
}

function integerToChinese(
  value: number,
  digits: string[],
  units: string[],
  bigUnits: string[]
): string {
  if (value === 0) return digits[0]
  const groups: number[] = []
  let current = value
  while (current > 0) {
    groups.push(current % 10000)
    current = Math.floor(current / 10000)
  }
  let result = ''
  let pendingZero = false
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (group === 0) {
      pendingZero = result.length > 0
      continue
    }
    if (pendingZero || (result && group < 1000)) result += digits[0]
    result += smallIntegerToChinese(group, digits, units) + bigUnits[index]
    pendingZero = group < 1000
  }
  return result.replace(/零+/g, '零').replace(/零$/g, '')
}

function smallIntegerToChinese(value: number, digits: string[], units: string[]): string {
  let result = ''
  let pendingZero = false
  const values = [
    Math.floor(value / 1000) % 10,
    Math.floor(value / 100) % 10,
    Math.floor(value / 10) % 10,
    value % 10
  ]
  for (let index = 0; index < values.length; index += 1) {
    const digit = values[index]
    const unit = units[values.length - 1 - index]
    if (digit === 0) {
      pendingZero = result.length > 0
      continue
    }
    if (pendingZero) result += digits[0]
    result += digits[digit] + unit
    pendingZero = false
  }
  return result
}
