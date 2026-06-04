# 09 · 分阶段整改计划

> 总原则：**不做一次性大重构**。每项给出影响范围与验证方式；改动以"能 typecheck + build + 冒烟"为单位推进，可随时回滚。
> 验证基线命令（在 `app/` 下）：`npm run typecheck` → `npm run build`，必要时 `npm run dist` 出包冒烟。

## P0 · 决策结果（2026-06-04 已定）

| 编号 | 事项 | 决策 | 落地 |
|---|---|---|---|
| P0-1 | 录制工具 | **正式包保留录制** | 已改 `feature-guide.md`/`maintenance-guide.md`；代码无需改（已在挂载） |
| P0-2 | 在职工资 001/002 视图 | **要显示** | 已修 `appApi.ts getVisibleViews`（改判 `在职工资`），typecheck 通过；待人工确认 tab |

## P1 · 低风险清理：先文档、后死码

| 编号 | 任务 | 影响范围 | 验证方式 |
|---|---|---|---|
| P1-1 | 刷新过期文档（`retained-worksheets.md`/`sqlite-schema-retained.md`/`development-plan.md` 的表清单·表名·技术栈·登录页） | 纯 `docs/`，零代码风险 | 文档表名/数量与 `worksheets-retained.json`、`App.vue modules` 对齐 |
| P1-2 | 删确认死的暴露 API：`licenseGetServerUrl`、`license:setServerUrl`、`generateMonthlyPayrollReportView`、`generatePerformancePayroll`（基础版）、`worksheetDisplayNames` 恒等映射 | `preload.ts`、`appApi.ts`/`licenseApi.ts`、`App.vue`；逐个删 | 每删一个跑 typecheck+build；冒烟授权/绩效/报账 |
| P1-3 | 统一 `\uXXXX` 转义为中文字面量（`appApi.ts` getVisibleViews、`connection.ts` identity 常量） | 文本等价替换 | typecheck 通过、运行行为不变 |

## P2 · 一致性与防护

| 编号 | 任务 | 影响范围 | 验证方式 |
|---|---|---|---|
| P2-1 | 邮件"下载规则"二选一：补 UI+补 `MailDownloadRule` 字段（`fromContains/targetDir/saveSubdir/folder`）、补 `mail_download_records.rule_id`；或删该子功能 | `MailAttachmentPage.vue`、`mailApi.ts`、`types.ts`、(可能)`connection.ts` | 按规则下载一封测试邮件；或确认面板无残留 |
| P2-2 | 统一 IPC 错误约定（业务可恢复→`{ok,reason}`，系统→`throw`；license 包装单列） | 分模块逐个对齐 | 前端错误提示路径不变、无未捕获 reject |
| P2-3 | 门户 IP 等硬编码纳入 env（`config/paths.ts`/`main.ts`） | 配置层 | 改 env 指向新地址生效 |
| P2-4 | ✅ 已完成（2026-06-04）：`getVisibleViews` 改判 `在职工资` | `appApi.ts` 一处 | typecheck 通过；待人工确认 tab 显示与筛选 |

## P3 · 长期

| 编号 | 任务 | 影响范围 | 验证方式 |
|---|---|---|---|
| P3-1 | 引入 `vitest` + `"test"` 脚本，先覆盖 4 个 fixture 的纯函数路径 | 新增 devDep + 测试文件，不动业务码 | `npm test` 跑通 4 个 fixture 断言 |
| P3-2 | 扩展测试到所属期校验、同月重生成、月结/取消月结、导入回滚 | 测试侧 | 用例通过 |
| P3-3 | 只读核对疑似遗留字段（`field_mappings`/`retired_housing`/`rule_id`），再决定是否清理 | 先只读 | 出具结论，不直接删列 |

## 推进顺序建议

1. 回答 P0-1、P0-2。
2. 做 P1-1（文档）→ P1-2（死码）→ P1-3（编码风格），把"代码-文档-接口"对齐到可信基线。
3. 视需要做 P2、P3。
4. **进入任何"删/改"动作前，就该处业务规则先与用户确认，不替用户猜口径。**
