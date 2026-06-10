import { describe, it } from 'vitest'

// 既有断言脚本（node:assert/strict，导入即执行全部断言）。覆盖：凭证表生成。
describe('月度报账凭证表', () => {
  it('凭证表生成断言全部通过', async () => {
    await import('../../scripts/monthly-payroll-voucher-sheet.test')
  })
})
