import { describe, expect, it } from 'vitest'
import {
  coerceComparableValue,
  formatMoney,
  isValidIdCard,
  normalizeHeader,
  normalizeIdCard,
  num,
  roundMoney,
  text
} from '../../src/main/services/monthly-payroll/monthlyPayrollUtils'

describe('num：金额解析', () => {
  it('数字原样返回，非法数字归零', () => {
    expect(num(1234.56)).toBe(1234.56)
    expect(num(Number.NaN)).toBe(0)
    expect(num(Infinity)).toBe(0)
  })
  it('千分位字符串可解析', () => {
    expect(num('1,234.56')).toBe(1234.56)
    expect(num(' 1,000 ')).toBe(1000)
  })
  it('空值/垃圾文本归零', () => {
    expect(num('')).toBe(0)
    expect(num(null)).toBe(0)
    expect(num(undefined)).toBe(0)
    expect(num('abc')).toBe(0)
  })
  it('负数与小数', () => {
    expect(num('-4,600')).toBe(-4600)
    expect(num('17.78')).toBe(17.78)
  })
})

describe('roundMoney：金额四舍五入到分', () => {
  it('两位小数', () => {
    expect(roundMoney(1.005)).toBe(1.01)
    expect(roundMoney(1.004)).toBe(1.0)
    expect(roundMoney(-4600.005)).toBe(-4600)
  })
  it('浮点累加误差被压平', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3)
  })
})

describe('formatMoney：金额格式化', () => {
  it('千分位 + 两位小数', () => {
    expect(formatMoney(1234567.8)).toBe('1,234,567.80')
    expect(formatMoney(0)).toBe('0.00')
  })
})

describe('身份证号处理', () => {
  it('normalizeIdCard 去空格/逗号并大写', () => {
    expect(normalizeIdCard(' 32000019700101000x ')).toBe('32000019700101000X')
    expect(normalizeIdCard('320,000,197001010000')).toBe('320000197001010000')
  })
  it('isValidIdCard 18 位校验', () => {
    expect(isValidIdCard('320000197001010000')).toBe(true)
    expect(isValidIdCard('32000019700101000X')).toBe(true)
    expect(isValidIdCard('32000019700101000')).toBe(false)
    expect(isValidIdCard('3200001970010100001')).toBe(false)
    expect(isValidIdCard('')).toBe(false)
    expect(isValidIdCard(null)).toBe(false)
  })
})

describe('normalizeHeader：表头归一化', () => {
  it('去空白、半角括号转全角、转小写', () => {
    expect(normalizeHeader('岗位 工资')).toBe('岗位工资')
    expect(normalizeHeader('补贴(元)')).toBe('补贴（元）')
    expect(normalizeHeader('Tax Amount')).toBe('taxamount')
  })
})

describe('coerceComparableValue：对账值归一', () => {
  it('数字文本转数字（含千分位）', () => {
    expect(coerceComparableValue('1,234.50')).toBe(1234.5)
    expect(coerceComparableValue('-17.78')).toBe(-17.78)
  })
  it('非数字文本保留 trim 后原文', () => {
    expect(coerceComparableValue(' 事业 ')).toBe('事业')
  })
  it('空值归空串、数字原样', () => {
    expect(coerceComparableValue(null)).toBe('')
    expect(coerceComparableValue(42)).toBe(42)
  })
})

describe('text：文本归一', () => {
  it('null/undefined 归空串，其余 String+trim', () => {
    expect(text(null)).toBe('')
    expect(text(undefined)).toBe('')
    expect(text(' 张三 ')).toBe('张三')
    expect(text(0)).toBe('0')
  })
})
