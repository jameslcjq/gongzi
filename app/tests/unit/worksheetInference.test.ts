import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { getSplitConfig, inferWorksheet } from '../../src/main/services/worksheetInference'

// 这些用例守护 AGENTS.md「按内容而非文件名分类」的工资导入规则，并钉住 inferWorksheet 的
// 已知脆弱点：在职/退休/其他三表表头高度重叠，签名匹配必然三者皆中，最终全靠首行
// 「工资类别名称」区分（inferSalaryWorksheetName）。任何改动若打破这一行为都应让测试变红。

// 退休工资完整表头（20 列）——同时能被在职工资/其他工资签名命中，触发工资表消歧路径。
const RETIRED_HEADERS = [
  '单位编码', '单位名称', '工资类别编码', '工资类别名称', '业务年度', '月份', '姓名', '证件号码',
  '工资批次编码', '工资批次名称', '内设部门编码', '内设部门名称', '住房补贴', '补发工资', '其他一',
  '应发工资小计', '代扣工资', '实发合计', '备注一', '备注'
]

// 在职工资完整表头（50 列）——签名分数最高，无工资类别数据时按最佳匹配落到在职工资。
const ACTIVE_HEADERS = [
  '单位编码', '单位名称', '工资类别编码', '工资类别名称', '业务年度', '月份', '姓名', '证件号码',
  '工资批次编码', '工资批次名称', '内设部门编码', '内设部门名称', '部门内序号', '岗位工资', '薪级工资',
  '岗位津贴', '生活补贴', '绩效工资', '工作性津贴', '教（工）龄补贴', '特岗性津补贴', '交通费', '公车补贴',
  '住房补贴', '基础绩效奖', '补发工资', '补扣工资', '其他一', '其他二', '其他三', '当月个人所得税', '公积金',
  '养老保险缴费', '职业年金缴费', '医疗保险', '失业保险', '支出一', '支出二', '支出三', '代扣工资',
  '代扣合计', '实发合计', '备注二', '备注三', '备注一', '备注', '应发工资', '支出一备注', '支出二备注', '支出三备注'
]

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ws-infer-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeWorkbook(fileName: string, aoa: unknown[][]): string {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet(aoa)
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
  const filePath = join(tmpDir, fileName)
  XLSX.writeFile(workbook, filePath)
  return filePath
}

// 用退休表头 + 指定「工资类别名称」首行值构造工资明细表；文件名故意中性，避免命中文件名别名短路。
function salaryWorkbook(fileName: string, salaryTypeName: string, headers = RETIRED_HEADERS): string {
  const row = headers.map(() => '' as unknown)
  row[headers.indexOf('姓名')] = '张三'
  row[headers.indexOf('证件号码')] = '320000197001010000'
  row[headers.indexOf('工资类别名称')] = salaryTypeName
  return writeWorkbook(fileName, [headers, row])
}

describe('inferWorksheet：一体化工资明细按内容分类（不看文件名）', () => {
  it('工资类别名称含「退休」→ 退休工资', () => {
    const result = inferWorksheet(salaryWorkbook('detail-a.xlsx', '事业单位退休人员'))
    expect(result.worksheet?.name).toBe('退休工资')
  })

  it('工资类别名称含「离休」→ 退休工资', () => {
    const result = inferWorksheet(salaryWorkbook('detail-b.xlsx', '离休'))
    expect(result.worksheet?.name).toBe('退休工资')
  })

  it('工资类别名称含「遗属」→ 走退休工资导入路径（再由拆分规则路由到其他工资）', () => {
    const result = inferWorksheet(salaryWorkbook('detail-c.xlsx', '遗属补助'))
    expect(result.worksheet?.name).toBe('退休工资')
  })

  it('工资类别名称含「其他」→ 走退休工资导入路径', () => {
    const result = inferWorksheet(salaryWorkbook('detail-d.xlsx', '其他人员'))
    expect(result.worksheet?.name).toBe('退休工资')
  })

  it('工资类别名称为在职类 → 在职工资（即使表头是退休形态，也由类别值决定）', () => {
    const result = inferWorksheet(salaryWorkbook('detail-e.xlsx', '事业单位在职人员'))
    expect(result.worksheet?.name).toBe('在职工资')
  })

  it('无工资类别数据时按最佳签名匹配落到在职工资', () => {
    const result = inferWorksheet(writeWorkbook('detail-active-only.xlsx', [ACTIVE_HEADERS]))
    expect(result.worksheet?.name).toBe('在职工资')
  })
})

describe('inferWorksheet：预算多级表头表按标题内容识别', () => {
  it('标题含「事业退休人员」→ 预算退休（文件名不含别名关键字）', () => {
    const aoa = [
      ['沭阳县2026年度事业退休人员信息情况表'],
      [],
      [],
      []
    ]
    const result = inferWorksheet(writeWorkbook('multirow-retired.xlsx', aoa))
    expect(result.worksheet?.name).toBe('预算退休')
  })
})

describe('getSplitConfig：退休工资按备注一拆分到其他工资', () => {
  it('退休工资有拆分规则：备注一非空 → 其他工资，空 → 退休工资', () => {
    const config = getSplitConfig('退休工资')
    expect(config?.field).toBe('备注一')
    const nonEmpty = config?.rules.find((rule) => rule.match === 'non-empty')
    const empty = config?.rules.find((rule) => rule.match === 'empty')
    expect(nonEmpty?.target).toBe('其他工资')
    expect(empty?.target).toBe('退休工资')
  })

  it('在职工资不参与拆分', () => {
    expect(getSplitConfig('在职工资')).toBeUndefined()
  })
})
