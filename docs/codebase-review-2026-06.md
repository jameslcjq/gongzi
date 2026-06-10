# 工资系统代码审查报告（2026-06）

- 审查日期：2026-06-10
- 审查基线：main 分支 `c911999`
- 方法：**不参考任何既有文档**，直接通读代码得出结论。每条发现标注文件与行号。
- 规模：`app/src` 约 5.8 万行（main 32k / renderer 24.8k / preload 0.6k / shared 1.5k）。

---

## 1. 架构地图（从代码还原）

```
Electron 主进程 (src/main)
├─ main.ts                 窗口/webview 下载拦截/启动序列
├─ config/paths.ts         实例化路径体系（多实例 userData/数据根隔离）
├─ db/connection.ts        sqlite3 + WAL；启动时建表/补列/重建人员状态索引
├─ ipc/appApi.ts (1613行)  ~100 个 IPC 通道，统一授权拦截(LICENSE_FREE_CHANNELS 白名单)
├─ ipc/licenseApi.ts / mailApi.ts
└─ services/               业务全在这层：excelImport(WatchER)、monthly-payroll 套件、
                           exchange 摆渡包、budget、mail、license、backup、自动化 helper…

渲染进程 (src/renderer)
├─ App.vue (2340行)        登录软门 + 左侧导航 + 页面切换（无 vue-router / 无 pinia）
├─ components/             巨型页面组件：MonthlyPayrollPage 3491行、IntegratedPortalPage 2459行
└─ integration/            ~6000 行"注入脚本"：以 TS 函数返回巨型模板字符串，
                           executeJavaScript 注入一体化 webview（额度匹配/凭证/送审/录制…）

preload.ts                 contextBridge 白名单暴露 window.salaryApi（typed）
webview                    一体化内网页，独立 partition，无 preload、allowpopups
构建变体                    __APP_FLAVOR__ (full/runner) 由 Vite define 烘焙；4 个安装包变体
```

---

## 2. 总体评价：做得好的地方（先说优点，都有代码依据）

| # | 优点 | 证据 |
|---|---|---|
| 1 | **SQL 注入防护扎实**：取值全参数化；标识符统一 `quoteIdentifier`；排序列名先对白名单校验 | worksheetRecords.ts:354-356、connection.ts 全文 |
| 2 | **算钱路径普遍用事务**：30+ 处 `BEGIN TRANSACTION`（导入/同步/年度调整/月度报账） | excelImport.ts:604 等 grep 证实 |
| 3 | **备份设计合格**：备份前 WAL checkpoint；恢复需确认+重启；完整备份带 manifest+sha256、恢复校验授权 | backup.ts:92,119-135,159-174 |
| 4 | **敏感凭据用 safeStorage**：邮箱授权码 DPAPI 加密，旧 XOR 仅作历史数据解密回退 | mail/encryption.ts |
| 5 | **Electron 安全基线正确**：contextIsolation、无 nodeIntegration；**webview 不带 preload** → 内网页面无法触达 IPC | main.ts:124-130、IntegratedPortalPage.vue:2072-2089 |
| 6 | **导入监听稳健**：串行队列防并发导入、awaitWriteFinish 防半截文件、按内容而非文件名分类 | excelImportWatcher.ts:24-31,55-67 |
| 7 | **多实例路径隔离**：实例1/实例2/执行端各有 userData、数据根、桌面快捷方式后缀 | config/paths.ts:12-42 |
| 8 | **类型纪律好**：`strict: true`，全仓 `as any` 为 0 | tsconfig.json、grep 证实 |
| 9 | **可回滚意识**：导入批次回滚、回收站(操作批次+变更日志)、来源文件版本表 | operationLog.ts、connection.ts:555-595 |
| 10 | 授权体系完整：在线+离线 RSA 签名+缓存，IPC 统一拦截 | licenseService.ts、appApi.ts:262-278 |

**结论先行**：这个代码库的"地基"（数据层、安全基线、可回滚）比一般 AI 接力项目好得多；主要短板集中在**工程保障（测试/日志/单实例）**和**两类巨型单体（注入脚本、页面组件）**。

---

## 3. 问题清单（按严重程度）

### 🔴 P0（建议立即处理）

**R-01 没有单实例锁** — ✅ 已修复（2026-06-10）
- 证据：全仓无 `requestSingleInstanceLock`（grep 证实）；main.ts 直接 `createWindow()`。
- 影响：同一个安装实例双开 → 同一 SQLite 双进程写、**导入 watcher 双跑（同一文件导两遍）**、自动化可能重复执行推送。多实例隔离（paths.ts）只隔离"不同安装"，挡不住"同一安装开两次"。
- 修复：main.ts 加 `app.requestSingleInstanceLock()`，拿不到锁即退出；二开时还原并聚焦已有窗口（second-instance）。锁按 userData 生效，实例2/执行端互不影响。typecheck 通过；**待下次打包生效**。

**R-02 算钱逻辑零自动化测试** — ✅ 底座已建（2026-06-10），覆盖面持续补
- 证据：package.json 无 test 框架；仅 2 个手跑脚本（`test:monthly-payroll-reconciliation` / `voucher`，node mjs 断言脚本）。monthlyPayroll.ts 1852 行、annualAdjustment.ts 1460 行、integratedPayroll.ts 1332 行的金额计算无任何回归保护。
- 影响：本项目错误的终点是**真实工资和政府平台**，这是全项目最大的业务风险。
- 已落地：vitest + `app/vitest.config.ts`；`app/tests/unit/` 三个用例文件（16 个断言）：既有两个对账/凭证断言脚本接入 vitest，新增 monthlyPayrollUtils 金额解析/取整/身份证/表头归一化全覆盖；`npm test` 一键运行（418ms）；GitHub Actions CI（.github/workflows/ci.yml：npm ci → typecheck → test → check:scripts）。
- 待续：月度报账汇总/拆分、退休→其他分流、额度匹配本地汇总、年度调整的用例（计划 B1）。

**R-03 ~6000 行注入脚本是模板字符串，不可测试不可 lint** — ✅ 阶段1已落地（2026-06-10），全面模块化待 7 月验证后
- 证据：integration/ 下 salaryQuotaMatchScript.ts(1905)、autoVoucherEntryScript.ts(1039)、salarySendReviewScript.ts(754) 等，全部是 `return \`...巨型 JS 字符串...\``。字符串内代码 vue-tsc/eslint 全部失明，正则要双转义。
- 影响：2026-06 额度匹配事故循环（打 7 个包才修好）的工程根源——只能靠真实页面人肉试错。
- 阶段1已落地：`app/scripts/check-injection-scripts.mjs`（`npm run check:scripts`）——构建期实际调用全部 19 个 `build*Script` 生成器 + 7 个离线油猴脚本，逐个 `node --check` 语法校验（26/26 通过），任一语法损坏 CI 即红。模板字符串"语法失明"问题已堵上。
- 阶段2（待 7 月真实页面验证通过后再动，避免重构刚修好的脚本）：①脚本改为真实 TS 模块，esbuild 打包成注入产物（generate-dev-userscripts.mjs 已证明链路可行）；②用已采集的真实 DOM 建**离线仿真页**做行为级回归（计划 A2）。

### 🟠 P1（近期处理）

**R-04 渲染层单体过大** — 📋 定为持续策略（不做一次性重构）
- 证据：App.vue 2340 行（登录+导航+布局+页面开关全在一个文件）；MonthlyPayrollPage.vue 3491 行；IntegratedPortalPage.vue 2459 行。无 vue-router、无 pinia（package.json 证实）。
- 影响：任何小改动都在巨文件里进行，AI/人工修改的回归风险集中；页面间状态靠 props/全局变量传递。
- 策略：**新功能一律拆新组件，巨文件只减不增**；MonthlyPayrollPage 按"报账生成/推送/历史"切三块逐步搬（随迭代进行，不专项排期）。

**R-05 IPC 纵深防御缺一层** — ✅ 已修复（2026-06-10）
- 证据：
  - `local-file:read-base64`：只验扩展名，可读全盘任意 xls/xlsx/csv（appApi.ts）
  - `voucher-push:read-xlsx`：**任意路径**读成 base64，无任何校验（appApi.ts）
  - 全部 ~110 通道无 sender 校验
- 修复：①新增 `ipc/ipcGuard.ts` 的 `assertTrustedIpcSender`——非主窗口（如 webview）来源一律拒绝，统一挂在 `createLicensedIpcMain` 包装器（覆盖 app+mail 全部通道）与 licenseApi 的 guarded 包装上；②`config/paths.ts` 新增 `assertInsideBusinessRoots` 路径白名单（dataRoot/工资导入/工资数据/temp/交换目录），套用到上述两个文件读取通道。`app:open-path`/`open-external` 维持现状（打开浏览/资源管理器，风险低、限制易破坏 UX）。

**R-06 登录是装饰性的** — ✅ 已决策（2026-06-10）：**保持现状，密码不变**
- 证据：App.vue:101-103 硬编码 `admin/123456`；登录态= localStorage 写死字符串 `admin-auth-v1`。
- 决策：用户确认登录定位为"防误触的 UI 门"，密码维持 admin/123456 不改。真实门禁依靠 license 授权体系。此条关闭，后续不再按安全缺陷追踪。

**R-07 主进程健壮性与可观测性不足** — ✅ 已修复（2026-06-10）
- 证据：无 `uncaughtException`/`unhandledRejection` 处理；**数据库初始化失败仍继续启动**（之后每个 IPC 散点报错）；主进程 47 处 `console.*` 无落盘——现场排障全靠看不见的控制台。
- 修复：①新增 `services/mainLog.ts`：主进程日志按天落盘到 `<数据目录>/logs/main-YYYY-MM-DD.log`，console.info/warn/error 自动落盘（保留原输出），uncaughtException/unhandledRejection 留痕；②DB 初始化失败 → `dialog.showErrorBox` 明示原因后退出（fail-fast）；③新增 `app-log:append` 通道（免授权）+ 渲染层把 webview 的自动化脚本日志（`[salary-quota-match]` 等 8 个前缀）与 warning/error 级 console **自动转发落盘**（每分钟限 200 行防刷屏）——A3"运行留痕不依赖手动录制"就此闭环。空 catch 的清理随迭代进行。

**R-08 人员状态索引重建：无事务 + 每次启动全量跑** — ✅ 事务化已修（2026-06-10），按需重建后续优化
- 证据：connection.ts `DELETE FROM personnel_status_index` 后逐行 INSERT，无事务包裹；启动链路和工作表变更后都会全量重建。
- 修复：重建包进 BEGIN/COMMIT（崩溃不再留空索引窗口，逐行插入提速一个数量级）。"来源表有变更才重建"涉及触发链路改动，保守起见列入后续（P2）。

**R-09 配置硬编码** — ✅ 已修复（2026-06-10）
- 证据：内网 IP `172.24.147.202` 实码 3 处（main.ts 下载拦截正则、performancePayroll.ts、IntegratedPortalPage.vue）。复查发现：数据根目录**原本就支持** `PAYROLL_DATA_ROOT` 等环境变量（shared/payrollInstance.ts），授权地址可经 license 配置文件覆盖——实际缺口只有门户 IP。
- 修复：新增 `shared/portalHost.ts` + Vite define `__PORTAL_HOST__`。门户地址支持 `PAYROLL_PORTAL_HOST` 覆盖（主进程运行时生效，渲染层打包期生效），默认值不变。dev-userscripts 的 @match 仍硬编码（油猴调试用，影响小）。

**R-10 备份缺两块** — ✅ 已修复（2026-06-10）
- 证据：仅手动备份（无定时器，grep 证实）；`restoreBackup` 直接覆盖当前库，覆盖前不留快照。
- 修复：①`runDailyAutoBackup()`：启动时若 24 小时内无备份则自动建一份，并把备份裁剪到最近 14 份；②恢复前自动给当前库建"恢复前快照"（`salary-system-恢复前快照-时间戳.sqlite`），选错备份文件也有后悔药。

### 🟢 P2（择机处理）

**R-11 IPC 错误约定三种并存**：`{ok,reason}` / throw / 直接返回值，前端需逐通道记忆（appApi.ts 全文可见）。新代码统一 `{ok,reason}`，存量随改随清。

**R-12 邮件下载规则缺管理界面** — ✅ 已决策（2026-06-10）：**维持现状（B）**。复查修正：并非死代码——后端完整且真实生效（mailImapService.ts:51-233 每次收件加载规则按"主题包含+扩展名"过滤），preload 已暴露接口，唯独无管理 UI → 规则表恒空 → 实际只有账号级过滤（发件人 from_filter + 文件夹）。用户确认账号级过滤够用，不补 UI、后端保留。此条关闭；将来若出现"同一发件人多种邮件"需求再补 UI（约半天）。

**R-13 版本标识混乱** — ✅ 已修复（2026-06-11）：package.json version 升至 `1.13.0` 作为唯一来源；4 个安装包配置的 artifactName 全部改为 `${version}` 模板（如 `老九的工资系统安装包-1.13.0.exe`），重打包自动跟随版本，不再手写。后续每次发布只需 bump 一处 version。

**R-14 dev-userscripts 生成漂移** — ✅ 已修复（2026-06-11）：03/04 重生成并与源 TS 对齐提交；验证二次生成零 diff（幂等）。生成器临时目录已加 .gitignore。

**R-15 getDatabase 并发竞态**：connection.ts:29-54 无 in-flight Promise 守卫，理论上并发首调会 double-open。首调在启动序列，实际风险低，顺手修（memo promise）。

**R-16 文档与代码漂移**：docs/ 下大量早期文档已与实现不符（用户已确认）。建议每篇头部标注"历史/有效"，新事实只进有效文档。

---

## 4. 建议汇总（按投入产出排序）

| 优先级 | 动作 | 对应问题 | 状态 |
|---|---|---|---|
| 立即 | 单实例锁 | R-01 | ✅ 2026-06-10 |
| 立即 | vitest 底座 + 16 用例 + CI | R-02 | ✅ 2026-06-10，覆盖面续补 |
| 立即 | 注入脚本构建期语法校验（26 个脚本，接入 CI） | R-03 阶段1 | ✅ 2026-06-10 |
| 立即 | DB 初始化失败弹窗退出 + 全局异常兜底 | R-07 | ✅ 2026-06-10 |
| 立即 | 主进程日志落盘 + webview 自动化日志转发落盘 | R-07 | ✅ 2026-06-10 |
| 立即 | 恢复前自动快照 + 每日自动备份（保留14份） | R-10 | ✅ 2026-06-10 |
| 立即 | IPC sender 守卫 + 文件读取路径白名单 | R-05 | ✅ 2026-06-10 |
| 立即 | 人员状态索引事务化 | R-08 | ✅ 2026-06-10（按需重建列 P2） |
| 立即 | 门户地址外置（PAYROLL_PORTAL_HOST） | R-09 | ✅ 2026-06-10 |
| 立即 | 版本号治理（version 单一来源 + ${version} 模板×4） | R-13 | ✅ 2026-06-11 |
| 立即 | dev-userscripts 漂移对齐 + 幂等验证 | R-14 | ✅ 2026-06-11 |
| 7月验证后 | 注入脚本模块化 + 离线仿真页 | R-03 阶段2 | 3~5 天 |
| 决策 | 登录定位（装饰门 or 真账户） | R-06 | ✅ 已决策：保持现状，密码不变 |
| 决策 | 邮件规则补完或删除 | R-12 | ✅ 已决策：维持现状，后端保留不补 UI |
| 持续 | 巨型组件只拆不增、错误约定统一 | R-04/11 | 随迭代 |

> 注：以上修复均通过 `npm run typecheck`、`npm test`(16/16)、`npm run check:scripts`(26/26)，**待下次打包后在生产生效**。

## 5. 与开发计划的衔接

本报告与 [development-plan-2026H2.md](development-plan-2026H2.md) 的对应：R-02→计划 B1/B3；R-03→A2；R-07→A3（范围从"自动化日志"扩大为"主进程日志落盘"）；R-09→D1；R-12→E1；R-13→C1。**新增且计划未覆盖的是 R-01（单实例锁）、R-08、R-10、R-15**，建议并入里程碑 M1（本周）：R-01、R-07、R-10 都是小改动大收益。
