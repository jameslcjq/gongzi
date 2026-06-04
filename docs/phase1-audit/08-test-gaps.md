# 08 · 测试缺口清单

## 1. 现状

- `app/package.json` **无 `test` 脚本**，**无 vitest / jest / mocha** 依赖。
- 唯一的"发布前检查"是 `npm run typecheck`（`vue-tsc --noEmit`）与 `npm run build`，二者只查类型与编译，不验业务正确性。
- `tests/` 目录只有 **4 组** `input.json` / `expected.json`，按 `maintenance-guide.md` 是供**人工比对**的脱敏样例，不是可执行用例：
  - `tests/fixtures/monthly-payroll/basic-integrated/`
  - `tests/fixtures/performance-payroll/two-period-change/`
  - `tests/fixtures/annual-adjustment/basic/`
  - `tests/fixtures/integration-push/insurance-voucher-queue/`
- `tests/expected/` 在 `maintenance-guide.md` 中规划过，但当前仅有 `fixtures/`。

## 2. 覆盖矩阵（按业务重要度）

| 业务 | 风险 | 现有 fixture | 自动化用例 | 缺口 |
|---|---|---|---|---|
| 月度报账 generate（算金额） | 🔴 | 有(JSON) | ❌ | 无 runner，无断言 |
| 月度报账 所属期校验（社保/个税） | 🔴 | ❌ | ❌ | 全缺 |
| 月度报账 同月重生成→outdated/needs-repush | 🔴 | ❌ | ❌ | 全缺 |
| 月结归档/取消月结（文件搬移+字段清空/还原） | 🔴 | ❌ | ❌ | 全缺 |
| 绩效 两期对比 | 🟠 | 有(JSON) | ❌ | 无断言 |
| 年初调整 | 🟠 | 有(JSON) | ❌ | 无断言 |
| 一体化推送队列 串行/失败停止 | 🟠 | 有(JSON) | ❌ | 无断言 |
| Excel 导入 diff/回滚/不污染原数据 | 🟠 | ❌ | ❌ | 全缺 |
| 身份证唯一约束/重复拦截 | 🟠 | ❌ | ❌ | 全缺 |
| 个税/社保所属期解析 | 🟠 | ❌ | ❌ | 全缺 |
| 凭证附件页数（保险固定 7、工资动态） | 🟠 | ❌ | ❌ | 全缺 |
| 授权 在线/离线/缓存/换机 | 🟠 | ❌ | ❌ | 仅人工 |
| 一体化注入脚本（选择器/页面身份） | 🟠 | ❌ | ❌ | 难自动化，需录制回归 |

## 3. 建议的最小自动化起步（不动业务码）

1. 加 `vitest` 到 devDependencies，加 `"test": "vitest run"`。
2. 优先给**纯函数**路径配用例（不依赖 Electron/DB）：
   - 月度报账金额汇总（喂 `monthly-payroll/basic-integrated/input.json`，断言 `expected.json` 字段：人数、凭证数、保险附件页=7、warnings）。
   - 绩效两期对比（`performance-payroll/two-period-change`）。
   - 年初调整（`annual-adjustment/basic`）。
   - 推送队列串行/失败停止（`integration-push/insurance-voucher-queue`）。
3. 把这些函数从大文件里**保持原样**，仅在测试侧 import；如确需抽纯函数再单独评估（属第二阶段改造，需确认）。

## 4. 人工回归清单（沿用 `maintenance-guide.md` §10，作为自动化补齐前的兜底）

- 月度工资：能导工资表；能从一体化来源生成；历史月份不能误重新生成；社保不含当月所属期必须拦截、含当月+补缴月应通过；个税非上月必须拦截；预处理结果符合预期；凭证/保险附件页数符合规则。
- 绩效：能识别人员；能区分晋级/小档/退休/调出/新进/调入；差额与备注正确。
- 一体化门户：进对页才显示按钮；顶部无重复按钮；批量推送失败能指出哪一条；保存后能继续下一条。
- 授权：未授权不能进；在线/离线授权成功能进；离线校验失败不能绕过；换机硬件指纹符合预期。
- 打包：安装包能生成/能打开；数据目录不被覆盖；**正式包保留一体化录制入口**（2026-06-04 决策）；其它纯开发入口（如自动 DevTools）不出现。
