# 10 · 后续 AI 协作规则

> 目的：本项目历经多个 AI、多次需求/流程变更，已积累改名 dead code、文档漂移、半成品、无测试等问题（见 06/07/08）。本规则用于约束后续 AI 协作，避免问题继续累积。
> 本规则是对 `docs/maintenance-guide.md` 的补充，二者冲突时以更严格者为准。

## 1. 工作前必读

1. 先读 `docs/phase1-audit/README.md` 与本文件，再读 `docs/feature-guide.md`（最新功能口径）。
2. **不要信任 04-30 的旧文档**（`retained-worksheets.md` 等）作为表结构事实来源；事实源是 `docs/data/worksheets-retained.json` 与 `app/src/main/db/`。
3. 工作目录：Git 操作在 `E:\工资系统\gongzi`；开发/打包在 `E:\工资系统\gongzi\app`。

## 2. 业务规则：不准猜

1. 涉及"算钱/算社保/算个税/凭证页数/所属期/批次(001/002)/字段映射"等口径，**一律先问用户确认**，不得自行假定。
2. 不确定的内容在产出里显式标 **待确认**，不要写成既成事实。
3. 不要把"计划以后做"的注释当现状；过期思路要删不要留。

## 3. 改动纪律

1. **小步改、可回滚**：一个改动一个主题；每改完跑 `npm run typecheck` + `npm run build`，必要时 `npm run dist` 冒烟。
2. 删任何"看起来没用"的代码前，先全局搜索引用（含 `\uXXXX` 转义形式，见第 6 条），确认确实不可达再删，并在提交说明写清依据。
3. 改了用户可见功能/业务口径/一体化注入/数据库结构/授权/打包路径，**必须同步改 `docs/feature-guide.md`，并更新本审计集相关条目**。"代码改了文档没改"是本项目最大隐患。
4. 不提交 `release/`、`dist/`、`dist-electron/`、`node_modules/`、真实 Excel/Word/PDF/压缩包、本地 SQLite。
5. 提交只包含与本次任务相关的文件；先 `git status --short` 看清改动范围。

## 4. 架构边界

1. 计算规则放 `app/src/main/services/`；页面放 `renderer/src/components/`；一体化注入放 `renderer/src/integration/`；共享类型放 `app/src/shared/types.ts`。
2. 渲染进程不直接碰 SQLite，只走 `window.salaryApi`（preload）。
3. 新增 IPC：preload 暴露 + appApi/mailApi/licenseApi 注册 + types 定型，**三处同时改**；并确认是否需要进 `LICENSE_FREE_CHANNELS`（默认不进）。
4. 类型、数据库列、实际用法**三者必须对齐**（本项目邮件模块就是反例）。新增/改字段时三处一起核对。

## 5. 数据库

1. 工作表由元数据驱动建表（`db/schema.ts`），加业务表字段优先改元数据 + `syncWorksheetColumns`，不要手写散落的 `ALTER`。
2. 迁移用 `ensureColumns` 幂等补列模式；**不要删列**（SQLite 删列有风险，且月结归档读历史字段）。要废弃字段先软处理并记录。
3. 改动后确认 `getDatabase()` 启动链路（建表→补列→索引→状态刷新）仍幂等可重入。

## 6. 编码风格

1. 中文一律用**中文字面量**，不要用 `\uXXXX` 转义（历史遗留的转义在清理时一并改回）。
2. 命名跟随周边代码风格；新代码注释密度对齐相邻文件。
3. 注释只写"业务规则不直观处"（如附件页数、所属期、选择器、等待重试的业务原因），不写翻译式废话、不留过期思路。

## 7. 一体化注入与录制

1. 一体化页面选择器/页面身份判断要写来源注释，选择器变化要尽早失败并给明确提示。
2. 录制（`recorderDevTools` 等）**正式包保留**（2026-06-04 P0-1 决策）；改门户工具栏时不要误删录制入口，也不要给它加 dev 守卫。

## 8. 测试与验证

1. 改核心业务（报账/绩效/年初调整/推送）前后，至少跑 `docs/phase1-audit/08-test-gaps.md` 的人工回归清单相关项。
2. 鼓励把改动点补成 `vitest` 用例（喂 `tests/fixtures` 的 `input.json` 比对 `expected.json`）。
3. 新增脱敏样例要彻底脱敏（姓名/证件/卡号/金额按 `maintenance-guide.md` §9 处理）。

## 9. 产出规范

1. 审计/分析类产出统一放 `docs/phase1-audit/`（或后续阶段目录），不散落在仓库根。
2. 相对日期换成绝对日期；引用代码用 `文件:行号` 形式便于跳转。
3. 重要结论附文件路径依据；无依据的推测明确标注。
