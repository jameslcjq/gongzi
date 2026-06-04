# 06 · 旧逻辑 / 废弃逻辑清单

> 处置建议：清理前逐项确认；删除以小步、可 typecheck/build 验证为前提（见 09）。

## A. 工作表改名留下的 dead code

| 项 | 位置 | 现象 | 建议 |
|---|---|---|---|
| `getVisibleViews` 旧名分支 | `app/src/main/ipc/appApi.ts:1213-1232` | 用旧名判断视图，表已改名 → 分支不可达 | ✅ "在职工资"一支已于 2026-06-04 改判修复；`一体化退休/其他` 两支仍死但落到等价结果（只显示"全部"），暂无害，后续可清 |
| `worksheetDisplayNames` | `app/src/renderer/src/App.vue:116-120` | `在职工资→在职工资` 恒等映射，改名后无意义 | 删除 vestigial 映射 |

## B. 疑似未使用的暴露接口（preload 有、渲染端无引用）

| 接口 | 判断 | 建议 |
|---|---|---|
| `licenseGetServerUrl` | 死 | 删 |
| `license:setServerUrl`（主进程注册、永远失败、preload 未暴露） | 死通道 | 删 |
| `generateMonthlyPayrollReportView` | 被 `runWorkflow('monthly-payroll.generate')` 取代 | 删 handler + preload |
| `generatePerformancePayroll`（基础版） | 只用 `…FromHistory/…FromLocal` | 删或确认保留 |
| `listMailRules / saveMailRule / deleteMailRule` | 邮件规则 UI 未接 | 见 D，决定补 UI 或删 |
| `listMailRecords / chooseMailDir` | 渲染端未用 | 删或补 UI |
| `getPortalToken / savePortalDomRecord` | 渲染端未用 | 确认是否门户内部流程需要 |
| `detectIdCardField / listRecycleBinRecords` | 渲染端未用 | 待确认（可能预留） |

## C. 已删除的工作表（旧流程线索，勿再引用）

`人员待遇申领明细`、`职称信息表`、`姓名`、`补发工资`、`绩效工资过渡表`（`docs/retained-worksheets.md` 列为删除；现 `worksheets-retained.json` 已无）。
> 依赖"局工资表/职称信息表"的旧明道云工作流逻辑若仍有残留引用，需核对（`development-plan.md` 提到过）。

## D. 半成品 / 后端有前端没接

| 功能 | 后端 | 前端 | 状态 |
|---|---|---|---|
| 邮件"下载规则" | `mail_download_rules` 表 + `mailRuleService.ts` + `mail:rule-*` 三 IPC | `MailAttachmentPage.vue` 不调用 | 半成品；且 `MailDownloadRule` 类型缺 `fromContains/targetDir/saveSubdir/folder` |
| 邮件"下载记录列表" | `mail:record-list` | 未调用 | 半成品 |

## E. 文档漂移（doc drift，影响维护判断，非代码 bug）

| 文档 | 写的 | 实际 |
|---|---|---|
| `development-plan.md` | better-sqlite3 + Kysely + 无登录页 | sqlite3 + 手写 SQL + 有登录页 |
| `retained-worksheets.md` / `sqlite-schema-retained.md` / `worksheet-fields-retained.md`（04-30） | 16 张表、旧表名 | ~28 张表、新表名 |
| `feature-guide.md` / `maintenance-guide.md` | （原）录制不进正式包 | ✅ 已于 2026-06-04 改为"正式包保留录制"，文档与代码一致 |
| `README.md` | 提到 `UI/` 目录（早期原型） | 仓库根目录**无 `UI/`** |

## F. 编码风格残留

- 同仓库混用中文字面量与 `\uXXXX` 转义（如 `appApi.ts:1213` getVisibleViews、`connection.ts:686` identity 常量是转义；其余多为字面量）。换 AI 的痕迹，影响搜索与可读性。建议统一为中文字面量（纯文本等价替换，可 typecheck 验证）。

## G. 数据库疑似遗留字段

- `field_mappings` 表：无写入逻辑，疑明道云迁移期遗留。
- `monthly_payroll_runs.retired_housing` 与 `retired_housing_actual_pay`：并存 + `mapRunRow` 回退兜底，疑半重复。
- `mail_download_records.rule_id`：类型有、表无对应列。

> 以上 G 项**先只读核对，不直接删列**（SQLite 删列有风险，且月结归档逻辑读这些字段）。
