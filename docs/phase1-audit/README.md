# 工资系统第一阶段审计文档集

> 生成时间：2026-06-04　|　阶段：第一阶段（只读分析）+ 两项 P0 决策落地
>
> 本文档集由一次完整的代码审计会话产出，目标是把"当前代码实际是什么样"固定成一份可追溯的基线，供后续维护和 AI 协作使用。
> 凡涉及业务规则、且无法仅从代码确定的，统一标记 **待确认**，不替用户猜口径。

## 决策记录（2026-06-04）

| 项 | 决策 | 落地动作 |
|---|---|---|
| 录制工具是否进正式包 | **正式包保留录制** | 代码已在挂载，无需改；已同步修改 `feature-guide.md`(§5/§16)、`maintenance-guide.md`(§6/§10)，原"正式包不得开放录制"规则作废 |
| 在职工资 `工资(001)/数币(002)` 视图 | **要显示** | 已修 `app/src/main/ipc/appApi.ts` 的 `getVisibleViews`（分支由旧名 `一体化在职` 改判 `在职工资`），`npm run typecheck` 通过；请在"工资数据→在职工资"人工确认三个 tab 出现 |

## 适用范围与免责声明

- 审计对象：`app/src`（约 4.8 万行 TS/Vue）、`docs/`、`tests/`。
- 本阶段除上述两项 P0 决策落地（1 行代码 + 4 处文档）外，未改动其它业务代码；新增了本套 `docs/phase1-audit/` 文档。
- 结论尽量标注文件路径（形如 `app/src/main/main.ts`），可在编辑器中点击跳转。
- 文档反映 2026-06-04 的代码状态；代码再演进时应同步更新本集。

## 文档清单

| 序号 | 文件 | 内容 |
|---|---|---|
| 1 | [01-system-flow.md](01-system-flow.md) | 当前系统实际流程图（总流程 / 月度报账 / 一体化推送 / 导入 / 授权） |
| 2 | [02-module-responsibilities.md](02-module-responsibilities.md) | 当前模块职责图（分层架构 + 各模块职责表） |
| 3 | [03-interface-inventory.md](03-interface-inventory.md) | 当前接口清单（IPC 通道全量 + 权限 + 死接口） |
| 4 | [04-database-guide.md](04-database-guide.md) | 当前数据库使用说明（引擎/迁移/系统表/工作表/索引/疑似废弃字段） |
| 5 | [05-requirement-code-map.md](05-requirement-code-map.md) | 需求-代码对照表 |
| 6 | [06-legacy-deprecated.md](06-legacy-deprecated.md) | 旧逻辑/废弃逻辑清单 |
| 7 | [07-high-risk-issues.md](07-high-risk-issues.md) | 高风险问题清单 |
| 8 | [08-test-gaps.md](08-test-gaps.md) | 测试缺口清单 |
| 9 | [09-remediation-plan.md](09-remediation-plan.md) | 分阶段整改计划 |
| 10 | [10-ai-collaboration-rules.md](10-ai-collaboration-rules.md) | 后续 AI 协作规则 |

## 摘要：最值得先看的 6 个结构性结论

1. **文档与代码已显著脱节**。`docs/` 多数架构/表结构文档停留在 2026-04-30（明道云迁移期），代码已演进到 6 月。例：`development-plan.md` 写 `better-sqlite3 + Kysely + 无登录页`，实际是 `sqlite3(异步) + 手写 SQL + 有登录页`；`retained-worksheets.md` 写 16 张表、旧表名，实际 **~28 张表、已改名**。
2. **工作表整体改名留下 dead code**。`一体化在职/退休/其他` → `在职工资/退休工资/其他工资`，`其他人员` → `预算其他`，`人员待遇申领明细` 已删除；`appApi.ts getVisibleViews` 里按旧名判断的分支多数仍是死分支（其中"在职工资"一支已于 2026-06-04 修复，其余 `一体化退休/其他` 分支因落到等价结果暂无害）。
3. **录制工具策略已定**：经 2026-06-04 决策，**正式包保留录制**，相关文档已同步（原"不得进正式包"作废）。
4. **一批"后端实现了、前端没接"的能力**，最突出是邮件"下载规则"（表 + 服务 + 3 个 IPC 都在，渲染端从不调用）。
5. **没有可执行的自动化测试**。`package.json` 无 test 脚本、无 vitest/jest；`tests/` 只有 4 组 JSON fixture 供人工比对。核心算账逻辑无回归保护。
6. **混合 AI 痕迹明显**。同仓库混用中文字面量与 `\uXXXX` 转义；类型定义、数据库列、实际用法三处对不齐（尤以邮件模块）。

## 两个 P0 决策已闭环

原"需要优先决策的两件事"（录制是否进正式包、001/002 视图是否显示）已于 2026-06-04 决策并落地，详见上方"决策记录"。后续可按 [09 整改计划](09-remediation-plan.md) 从 P1（刷新过期文档 + 删确认死的接口）起步推进。
