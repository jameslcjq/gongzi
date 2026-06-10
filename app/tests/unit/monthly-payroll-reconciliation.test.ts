import { describe, it } from 'vitest'

// 既有断言脚本（node:assert/strict，导入即执行全部断言）。
// 断言失败会抛错 → 本用例失败。覆盖：在职补发/补扣对账核心 reconcileActiveBackpayPeople。
describe('月度报账对账核心', () => {
  it('补发/补扣人员对账断言全部通过', async () => {
    await import('../../scripts/monthly-payroll-reconciliation-core.test')
  })
})
