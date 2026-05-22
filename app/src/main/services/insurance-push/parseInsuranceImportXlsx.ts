/**
 * 解析"保险导入_*.xlsx"（月结时自动生成的那个），输出可直接 POST 给
 *   /pay-voucher-server/grp/fes/pay/raw/savePayRawData
 * 的 JSON 数组。
 *
 * xls 表头（单 sheet，row 0 表头，row 1+ 数据）：
 *   *单位代码 *单位名称 *部门经济科目代码 *部门经济科目名称 摘要 *金额
 *   *收款账户名称 *收款账户开户行 *收款账户账号 经办人 审核人 支付业务类型 确认不是政府采购项目支付
 *
 * 字段映射（参照抓包真实请求体）：
 *   xls 列 0..12 → JSON {agency_code, agency_code_name, dep_bgt_eco_code, dep_bgt_eco_code_name,
 *                       use_des, pay_sum_amt, payee_acct_name, payee_acct_bank_name, payee_acct_no,
 *                       operate_user, audit_user, hold1, is_gov_pur_pay}
 *
 *   "确认不是政府采购项目支付" 列的值是 "是" / "否"，API 期待 "2"=是 / "1"=否
 */

import { readFileSync } from 'node:fs'
import * as xlsx from 'xlsx'

export type InsuranceImportRecord = {
  agency_code: string
  agency_code_name: string
  dep_bgt_eco_code: string
  dep_bgt_eco_code_name: string
  use_des: string
  pay_sum_amt: string
  payee_acct_name: string
  payee_acct_bank_name: string
  payee_acct_no: string
  operate_user: string
  audit_user: string
  hold1: string
  is_gov_pur_pay: string
}

function asStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') {
    // 防止 Excel 数字溢出科学计数法（账号常 20+ 位）
    return String(v)
  }
  return String(v).trim()
}

export function parseInsuranceImportXlsx(filePath: string): InsuranceImportRecord[] {
  // 用 fs.readFileSync 拿 buffer，再 xlsx.read，避免 xlsx.readFile 对中文 Windows 路径报
  // "Cannot access file" 的问题
  const buffer = readFileSync(filePath)
  const wb = xlsx.read(buffer, { type: 'buffer', raw: true, cellDates: false })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return []
  const sheet = wb.Sheets[sheetName]
  const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  if (rows.length < 2) return []

  // row 0 = header；row 1+ = data
  const dataRows = rows
    .slice(1)
    .filter((row) => (row as unknown[]).some((c) => asStr(c).length > 0))

  return dataRows.map((rawRow) => {
    const row = rawRow as unknown[]
    const govPurRaw = asStr(row[12])
    const isGovPurPay = /是|✓|y|yes|true|2/i.test(govPurRaw) ? '2' : '1'
    return {
      agency_code: asStr(row[0]),
      agency_code_name: asStr(row[1]),
      dep_bgt_eco_code: asStr(row[2]),
      dep_bgt_eco_code_name: asStr(row[3]),
      use_des: asStr(row[4]),
      pay_sum_amt: asStr(row[5]) || '0',
      payee_acct_name: asStr(row[6]),
      payee_acct_bank_name: asStr(row[7]),
      payee_acct_no: asStr(row[8]),
      operate_user: asStr(row[9]),
      audit_user: asStr(row[10]),
      hold1: asStr(row[11]),
      is_gov_pur_pay: isGovPurPay
    }
  })
}
