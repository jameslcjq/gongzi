# 07 · 高风险问题清单

> 每项给出：现象 / 位置 / 影响 / 风险 / 建议 / 待确认。风险：🔴高 🟠中 🟢低。

## H-01 ✅ 录制工具进入正式包（已决策：保留）

> **2026-06-04 决策**：录制工具**正式进包**；已同步改 `feature-guide.md`(§5/§16)、`maintenance-guide.md`(§6/§10)，原"不得进正式包"作废。本条"策略矛盾"已消除，**不加 dev 守卫**。以下为决策前的记录，留作背景。
- 现象：`onMounted` 无条件 `import('../integration/recorderDevTools')` 并挂"开始/停止录制"按钮；`mountPortalRecorderDevTools` 内部也无 dev 守卫。提交 `b62b5a1 正式版启用一体化页面录制`（2026-06-04）显式打开。
- 位置：`app/src/renderer/src/components/IntegratedPortalPage.vue:473-483`、`app/src/renderer/src/integration/recorderDevTools.ts`。
- 与文档冲突：`feature-guide.md` §5/§16、`maintenance-guide.md` §6 均要求"正式包不得开放录制"。
- 影响：正式用户可见录制入口，可能采集/导出页面 DOM 与截图；发布合规与数据安全风险。
- 建议：**先决策**（见下）。若不要→`if (!app.isPackaged)` 守卫包裹挂载；若要→同步改三处文档消除矛盾。
- 待确认：**是有意改策略，还是误开？**（P0 决策项）

## H-02 ✅ 在职工资 001/002 视图（已修复）

> **2026-06-04 决策+修复**：确认需显示 `工资(001)/数币(002)`。已将 `app/src/main/ipc/appApi.ts` 的 `getVisibleViews` 分支由旧名 `一体化在职` 改判 `在职工资`，`npm run typecheck` 通过；请到"工资数据→在职工资"人工确认三个 tab 与筛选。以下为修复前的记录。
- 现象：`getVisibleViews` 仍按旧名 `一体化在职` 返回 `[全部/工资(001)/数币(002)]`；表已改名 `在职工资`，落到默认分支，可能拿不到这三个视图。
- 位置：`app/src/main/ipc/appApi.ts:1223`；`worksheetRecords.ts` 内有 `工资(001)/数币(002)` 过滤逻辑。
- 影响：若失效，用户无法按工资/数币批次筛选在职工资（`pending-features.md` 称该筛选"已支持"，存在自相矛盾）。
- 建议：人工到"工资数据→在职工资"看是否还有三个视图 tab；若无则把分支改判 `在职工资`。
- 待确认：**当前是否仍显示 001/002 视图？**（P0 决策项）

## H-03 🔴 核心算账逻辑无自动化测试
- 现象：`package.json` 无 test 脚本、无 vitest/jest；`tests/` 仅 4 组 JSON fixture 供人工比对。
- 影响：月度报账、绩效、年初调整等"算钱"路径改动后无回归保护，错误可能直达推送到一体化平台。
- 建议：见 [08-test-gaps.md](08-test-gaps.md) + 09 P3。
- 风险：🔴（金额相关）

## H-04 🟠 硬编码：内网 IP / 数据根 / 口令 / 授权地址
- 现象：一体化 IP `172.24.147.202`、`D:\laojiu`、登录 `admin/123456`、license server URL 硬编码散落。
- 位置：`main.ts:49`、`config/paths.ts:6`、`App.vue:130-131`、`licenseService.ts`。
- 影响：换网段/换机/多单位部署需改源码；口令在前端明文。
- 建议：门户 IP 纳入 env（已有 `PAYROLL_*` 先例）；登录口令策略见 H-06。

## H-05 🟠 `unit-settings:set` 在免授权白名单
- 现象：未授权即可写单位信息。
- 位置：`appApi.ts:194-212` `LICENSE_FREE_CHANNELS`。
- 影响：授权门禁前可改单位全称/导入编码，可能影响后续推送前置校验基准。
- 建议：确认是否有意（授权页需要先填单位？）；若否，移出白名单。
- 待确认：是否为授权页流程刻意放行。

## H-06 🟠 登录是前端软门（admin/123456 + localStorage）
- 现象：用户名密码写死在 `App.vue`，登录态存 `localStorage` 静态串 `admin-auth-v1`。
- 影响：任何能打开应用的人改 localStorage 即可绕过登录；真实门禁实际只靠 license。
- 建议：明确"登录只是 UI 软门、license 才是门禁"是否符合预期；若需真实本地账户体系另议。
- 待确认：登录分层是否符合业务预期。

## H-07 🟠 邮件"下载规则"半成品
- 现象：后端表/服务/IPC 齐全，前端未接；类型与 DB 字段不齐（`MailDownloadRule` 缺 `fromContains/targetDir/saveSubdir/folder`；`MailDownloadRecord.ruleId` 无 DB 列）。
- 影响：按规则自动下载这条业务不可用或行为不可预期。
- 建议：二选一——补 UI + 补类型字段，或删除该子功能（见 06-D）。

## H-08 🟠 IPC 错误返回三种约定并存
- 现象：`{ok,reason}` / `throw` / `{success,data|error}` 三种并存。
- 影响：前端处理路径不统一，易漏判失败，错误提示不一致。
- 建议：统一业务可恢复错误用 `{ok,reason}`、系统错误 `throw`；license 包装单独标注。

## H-09 🟢→🟠 数据库疑似遗留字段
- 见 [06-legacy-deprecated.md](06-legacy-deprecated.md) G 项：`field_mappings` 表、`retired_housing` 重复、`rule_id` 缺列。
- 建议：只读核对口径后再处理，**不要轻易删列**（月结归档读这些字段）。

## 风险处置优先级
1. 先做 H-01、H-02 的**决策**（不写码）。
2. 再排期 H-03（测试）、H-07（邮件规则）、H-08（错误约定）。
3. H-04/H-05/H-06 视部署与安全要求决定是否本期处理。
