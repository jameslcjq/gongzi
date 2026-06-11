import { describe, expect, it } from 'vitest'
import {
  normalizeBatchCode,
  sumLatestAmountByBatch
} from '../../src/main/services/monthly-payroll/batchTotals'

describe('normalizeBatchCode：批次编码归一', () => {
  it('提取 3 位数字', () => {
    expect(normalizeBatchCode('001')).toBe('001')
    expect(normalizeBatchCode('[002]数币')).toBe('002')
    expect(normalizeBatchCode(' 001 工资 ')).toBe('001')
  })
  it('空值归 001 主批次', () => {
    expect(normalizeBatchCode('')).toBe('001')
    expect(normalizeBatchCode(null)).toBe('001')
    expect(normalizeBatchCode(undefined)).toBe('001')
  })
  it('无 3 位数字时保留原文', () => {
    expect(normalizeBatchCode('数币')).toBe('数币')
  })
})

describe('sumLatestAmountByBatch：按批次汇总实发', () => {
  const id1 = '320000197001010000'
  const id2 = '320000198002020000'

  it('同一人在 001/002 各有一行时分别计入两个批次', () => {
    const rows = [
      { id: 1, 证件号码: id1, 批次: '001', 实发: 5000 },
      { id: 2, 证件号码: id1, 批次: '002', 实发: 300 },
      { id: 3, 证件号码: id2, 批次: '001', 实发: 4000 }
    ]
    expect(sumLatestAmountByBatch(rows, '证件号码', '批次', '实发')).toEqual({
      '001': 9000,
      '002': 300
    })
  })

  it('同一人同批次多行只取 id 最大的最新行（重复导入去重）', () => {
    const rows = [
      { id: 1, 证件号码: id1, 批次: '001', 实发: 5000 },
      { id: 9, 证件号码: id1, 批次: '001', 实发: 5200 },
      { id: 5, 证件号码: id1, 批次: '001', 实发: 5100 }
    ]
    expect(sumLatestAmountByBatch(rows, '证件号码', '批次', '实发')).toEqual({ '001': 5200 })
  })

  it('批次列缺失时全部归入 001', () => {
    const rows = [
      { id: 1, 证件号码: id1, 实发: 5000 },
      { id: 2, 证件号码: id2, 实发: 4000 }
    ]
    expect(sumLatestAmountByBatch(rows, '证件号码', undefined, '实发')).toEqual({ '001': 9000 })
  })

  it('批次编码带杂质时按归一后编码归集；空编码归 001', () => {
    const rows = [
      { id: 1, 证件号码: id1, 批次: '[002]数币', 实发: 300 },
      { id: 2, 证件号码: id2, 批次: '', 实发: 4000 }
    ]
    expect(sumLatestAmountByBatch(rows, '证件号码', '批次', '实发')).toEqual({
      '002': 300,
      '001': 4000
    })
  })

  it('无效证件号码的行被跳过；金额千分位字符串可解析；分账后两位小数', () => {
    const rows = [
      { id: 1, 证件号码: '', 批次: '001', 实发: 999999 },
      { id: 2, 证件号码: id1, 批次: '001', 实发: '1,234.56' },
      { id: 3, 证件号码: id2, 批次: '001', 实发: 0.1 },
      { id: 4, 证件号码: '32000019900303000X', 批次: '001', 实发: 0.2 }
    ]
    expect(sumLatestAmountByBatch(rows, '证件号码', '批次', '实发')).toEqual({ '001': 1234.86 })
  })
})
