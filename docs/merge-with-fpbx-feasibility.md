# 工资系统 × 账务辅助 合并可行性分析报告

更新时间：2026-06-23（含"统一平台 + 两业务模块"补充修订，见第 8、9 节）
基座决策：以**工资系统（gongzi）**为合并基座，账务辅助（fpbx）迁入。
范围说明：本文只做分析与方案论证，**不含落地改动**；账务辅助的 Rust/Tauri 重写线本次**不做处置决定**。

---

## 1. 结论摘要

- **业务上完全应该合并**：两者是**同一个一体化财政门户（`172.24.147.202`）**的姊妹工具，分工互补。当前用户要装两个程序、对同一门户登录两次、领两套授权码——合并后可共用一个门户窗口、一套授权、一个安装包。
- **架构上比想象中可行**：两边**门户嵌入机制完全一致**（`<webview>` + `PortalWebview` + `IntegratedPortalPage` + webviewMap），preload 桥**命名不冲突**（`window.api` vs `window.salaryApi`），IPC 命名空间基本不重叠。真正的合并成本不在"接口打架"，而在**基础设施版本与原生库统一**。
- **推荐路径**：分两步。先做"共享层抽取 + 基础设施统一"（低风险、快收益），再演进到"单一应用、单一安装包"（高收益、需统一原生库）。
- **最大技术风险点**：两边用了**不同的 SQLite 原生库**（better-sqlite3 同步 vs sqlite3 异步）和**不同的 Excel 库**（exceljs vs xlsx）。这两项是合并到单进程时必须先收敛的硬骨头。
- **合并形态定性**：做成"**统一平台（壳/核心层）+ 两个业务模块（工资 / 报账）**"的**模块化单体**，而不是把两份代码硬拼。模块边界、数据边界清晰，公共注入引擎与门户适配层下沉共享（详见第 8 节）。
- **必须澄清的语境**：这是**单机、单操作员（代账会计）的桌面工具**，不是多租户 Web 平台。因此"SSO / 组织架构 / RBAC 角色权限矩阵 / 内部审批流引擎"等通用合并建议在此**基本不适用**——真正的隔离手段是**双数据库 + 数据目录隔离 + 授权(license)按模块开关**，不是用户角色权限（详见第 9 节）。

---

## 1.5 决策记录（2026-06-23 第二轮，已拍板）

| 决策项 | 结论 | 影响 |
|---|---|---|
| 基座 | **工资系统（gongzi）** | 账务辅助迁入 |
| Rust/Tauri 线 | **本轮冻结不动** | 方向走 Electron |
| 产品命名/安装形态 | **新名字统一品牌**（一个程序、一个新 appId、一个安装包） | 老用户需重装并重新授权；需另定具体名称与 appId（见第 7 节）|
| SQLite 原生库 | **第一阶段就统一**（不走"先并存"） | 统一到 **better-sqlite3**，改造收敛在 `connection.ts`，见第 5、6 节 |
| 账务侧重资产 | **全部完整迁入**（OCR、微信小程序扫码、手机同步 server 都要） | 打包体积/依赖变大；OCR 备注见下 |
| 发票识别口径 | 以**二维码识别为主**，发票 OCR 作为补充/交叉验证 | 与现状一致（QR 主、OCR 兜底）；迁移时优先保证二维码链路 |
| 当前推进节奏 | **继续只完善规划**，暂不动代码 | 本文持续细化，不落地改动 |

> 备注：用户对"模块取舍"的原话含"OCR识别 只要识别二维码"，结合现状（jsQR/zxing 识别发票二维码为主、RapidOCR/百度 OCR 仅在二维码识别不足或需交叉验证时触发）理解为：**完整迁入识别能力，但二维码识别是主路径**。若理解有偏差请纠正。

---

## 2. 两个项目的本质关系

| 维度 | 账务辅助 (fpbx) | 工资系统 (gongzi) |
|---|---|---|
| 业务定位 | 发票/支付数据 → 发票&直接支付类**凭证** | 工资/社保/个税 → 工资类**凭证** + 保险推送 |
| 服务对象 | **同一个一体化财政门户 `172.24.147.202`** | **同一个一体化财政门户 `172.24.147.202`** |
| 仓库 | github.com/jameslcjq/**fpbx** | github.com/jameslcjq/**gongzi** |

### 已经共享的代码（最强合并信号）

- `shared/portalHost.ts`：两边**逐字节相同**（同一门户地址、同一 `PAYROLL_PORTAL_HOST` 覆盖逻辑）。
- 门户自动化注入脚本约 12 个**同名同源**：
  `portalDomRecorderScript`、`recorderScript`、`recorderDevTools`、`pushVoucherScript`、
  `voucherCheckScript`、`voucherMergeScript`、`autoVoucherEntryScript`、
  `integrationModuleNavigationScript`、`integrationPushPreflightScript`、
  `portalDiagnosticsScript`、`pushLogger`、`budgetProjectCodeScript`。
- 授权 / 设备基础设施同源：`licenseService`、`hardwareFingerprint`、`pushLog`。
- `shared/voucherCheckRules.ts`：两边都有（**内容已分叉**，需对账）。

> 解读：账务辅助的集成层很可能就是从工资系统 fork 出来的。这意味着"集成/门户"这一层合并后**天然能复用**，重复代码可直接收敛成一份。

---

## 3. 技术栈对比与分歧

| 维度 | 账务辅助 (fpbx) | 工资系统 (gongzi) | 合并影响 |
|---|---|---|---|
| 版本 / 规模 | 0.0.6 · 104 文件 / **30k 行** | 1.26.0 · 146 文件 / **66k 行** | 工资系统是大头，做基座合理 |
| Electron | **40** | 30 | 需统一（建议拉齐到较高版本，注意原生库 ABI） |
| Vite / TS | **8 / 6.0** | 5 / 5.7 | 需统一构建链 |
| UI 框架 | Vue 3.5 + Element Plus | Vue 3.5 + Element Plus | ✅ 一致，几乎无成本 |
| 路由 / 状态 | vue-router 5 + pinia 3 | **无**（自管 `appModules.ts`） | 基座要引入路由分区或保留两套导航 |
| SQLite | **better-sqlite3**（同步原生） | **sqlite3**（异步原生） | ⚠️ **不同库**，单进程合并的硬骨头 |
| Excel | **exceljs** | **xlsx (SheetJS)** | ⚠️ **不同库**，导入导出逻辑需各自保留或择一 |
| 主进程入口 | `dist-electron/main/index.js`（目录式） | `dist-electron/main.js`（单文件） | 入口形态需统一 |
| 源码布局 | 根 `src/` + `electron/` + `shared/` | `app/src/{main,renderer,preload,shared}` | 需统一目录约定 |
| preload 桥 | `window.api` | `window.salaryApi` | ✅ **不冲突**，可共存 |
| IPC 命名 | `crud:` `invoice:` `import:` `export:` `integration:` | `app:` `automation:` `backup:` `consistency-audit:` … | 基本不重叠，仅 `integration:` 需核对 |
| 数据目录 / DB | `D:\laojiu\fpdata\accounting.db` | 工资数据目录 + 本地 sqlite | 双库并存，**不强行合表** |
| 特有组件 | OCR(.ocr-venvs/RapidOCR+百度)、微信小程序、同步 server、**src-tauri(Rust 并行重写)** | .NET 助手(native)、邮件导入(imapflow)、**APP_FLAVOR 多形态机制** | 各自的"重资产"需单独评估 |

---

## 4. 架构契合点（为什么单一应用可行）

1. **门户窗口架构同构**：两边都用 `<webview>` 标签承载门户、`PortalWebview` 类型、`IntegratedPortalPage` 多标签页 + `webviewMap` 管理。合并后**一个门户窗口、一次登录**即可同时承载工资推送和发票推送两类注入脚本。
2. **preload 桥不打架**：`window.api`（账务）与 `window.salaryApi`（工资）命名分离，可在同一渲染进程并存，无需重命名即能共栖。
3. **IPC 约定相同、命名空间分离**：都用 `namespace:action` 冒号风格，命名空间几乎不重叠，合并主进程时碰撞面很小（仅需核对 `integration:` 前缀）。
4. **授权 / 指纹同源**：合并后可做成**一套授权覆盖两个模块**，免去发两套授权码。
5. **工资系统已有多形态机制**：`APP_FLAVOR`（full / runner 内网执行端版）+ 内外网摆渡架构，天然适合再加一个"账务"维度的模块开关。

---

## 5. 主要风险与难点

| 风险 | 说明 | 缓解思路 |
|---|---|---|
| **SQLite 库分叉** | better-sqlite3（同步）vs sqlite3（异步） | **已定：第一阶段统一到 better-sqlite3**。关键利好——工资系统 DB 访问全部走 `db/connection.ts` 的异步助手（`all/get/run/exec/getDatabase`），被 64 个文件调用，但**真正碰驱动的只有 connection.ts 一处**。改造方式：重写 connection.ts 内部用 better-sqlite3，**保留异步助手签名**（同步结果包成 `Promise.resolve`），64 个调用方基本不动；另约 7 个引用 `sqlite3.Database` 类型的文件改类型即可。详见第 6 节阶段 1。`run` 的 `lastID/changes` 语义差异（`info.lastInsertRowid`）需在 `runWithLastId` 内单点适配。 |
| **Excel 库分叉** | exceljs vs xlsx，导入导出实现绑定各自 API | 短期各模块保留各自库（不阻塞合并）；长期统一为一个，建议放到深度收敛阶段 |
| **Electron/Vite/TS 大版本差** | 40/8/6.0 vs 30/5/5.7，原生模块 ABI 受 Electron 版本约束 | 统一到目标 Electron 版本后，对 better-sqlite3 / sqlite3 重新 rebuild |
| **Rust/Tauri 并行线冲突** | 账务辅助 src-tauri 已迁移部分后台能力 | 本次冻结不动；合并方向定为 Electron 后再决定 Rust 线去留 |
| **数据库不可强并表** | 两边业务表语义不同（accounting.db vs 工资库） | **保持双库**，仅在应用层做跨模块数据交换（已有交换包/直接支付导出机制可复用） |
| **OCR/小程序/同步 server/.NET 助手** | 都是各自的重资产，平台依赖强 | 作为可插拔模块迁移，不在第一阶段强行融合 |
| **`voucherCheckRules` 已分叉** | 同名文件内容不一致 | 合并前先 diff 对账，确定唯一权威版本 |

---

## 6. 推荐方案与分阶段路线（按已拍板决策更新）

终点目标：**单一 Electron 应用、单一新品牌安装包、单一授权、共用门户窗口**；以工资系统为基座。

### 阶段 0 — 对账与冻结（仅梳理，无功能改动）
- diff 两边同名文件（`portalHost` 已确认相同；重点核对 `voucherCheckRules`、各 `*Script.ts`），确定权威版本。
- 冻结账务辅助 Rust/Tauri 线，明确本轮只走 Electron。
- 锁定目标基础设施版本（Electron / Vite / TS，统一到工资系统当前或更高）。

### 阶段 1 — 基础设施 + 数据库统一（已拍板第一阶段就做）
- **SQLite 统一到 better-sqlite3**：重写基座 `app/src/main/db/connection.ts` 驱动内部，**保留 `all/get/run/exec/getDatabase` 异步签名**，64 个调用方不动；改约 7 个引用 `sqlite3.Database` 类型的文件；`runWithLastId` 内单点适配 `lastInsertRowid`。账务侧 better-sqlite3 不变。
- 统一 Electron/Vite/TS 版本后，重新 rebuild better-sqlite3（注意 ABI 对应 Electron 版本）。
- 统一源码布局与主进程入口形态（目录式 vs 单文件择一）。

### 阶段 2 — 共享层抽取
- 把 `portalHost`、门户注入脚本、`licenseService`、`hardwareFingerprint`、`pushLog` 收敛为**单一权威来源**（按第 8.1 三层注入引擎组织）。
- 一套授权基础设施覆盖未来两个模块。

### 阶段 3 — 单一应用合并 + 新品牌封装
- 账务辅助 30k 行作为 `reimbursement` 模块迁入基座 `app/src/modules`，导航加"工资 / 报账"切换。
- 重资产**完整迁入**：发票识别（二维码为主 + OCR 兜底）、微信小程序扫码、手机同步 server。同步 server 与小程序作为可独立启停的子服务挂载。
- 合并主进程：两套 IPC 注册并存（命名空间基本分离），`window.api` 与 `window.salaryApi` 共栖。
- 门户窗口合一：一个 `IntegratedPortalPage` 同时承载工资/报账两类推送脚本。
- **新品牌封装**：新 `productName` + 新 `appId` + 单一 electron-builder 配置出一个安装包；一套 license 覆盖两模块（按模块开关）。

### 阶段 4 — 深度收敛（可选，长期）
- Excel 库择一（exceljs / xlsx 统一）。
- 评估 Rust/Tauri 线最终去留。

---

## 7. 决策状态

**已拍板（见第 1.5 节）**：基座=工资系统；Rust 冻结；新品牌统一命名；SQLite 第一阶段统一到 better-sqlite3；账务重资产完整迁入（二维码识别为主）；当前只完善规划。

**仍待细化（不阻塞规划，落地前需定）**：

1. **具体品牌名 + appId + 安装包名**：例如产品名"○○财务业务助手"、appId `com.laojiu.xxx`、NSIS `shortcutName`。直接影响授权绑定与桌面快捷方式。
2. **业务数据库是否仍保持双库**：本文推荐"统一驱动(better-sqlite3) 但**双数据库文件**不并表"——`salary-system.sqlite`（工资）与 `accounting.db`（报账）各自独立，仅应用层做跨模块数据交换。请确认是否接受"同驱动、双库文件"。
3. **手机同步 server / 微信小程序**的运行形态：作为合并程序内置子服务随主程序启停，还是仍独立部署？
4. **数据目录与授权迁移**：新品牌后老用户 `D:\laojiu\fpdata` 与工资数据目录如何沿用/迁移，旧授权码是否需要兼容过渡。

---

## 8. 目标形态：统一平台 + 两业务模块（修订补充）

合并的产品定位：一个"**内网财政业务自动化助手**"，对用户是一个程序、一次登录、一套授权；对研发是模块化单体。

```
统一桌面应用（基座 = 工资系统）
├── core/ 平台核心层（共享，下沉）
│   ├── 门户窗口与多标签（IntegratedPortalPage + webviewMap）
│   ├── 授权 / 硬件指纹（licenseService + hardwareFingerprint，一套覆盖两模块）
│   ├── 日志 / 推送留痕 / 截图（pushLog 等）
│   ├── 业务自动化流程注册（workflowRegistry，注意：是业务流程，非审批流）
│   └── 配置与数据目录解析（portalHost / 路径）
├── modules/ 业务模块（边界清晰、各自数据库）
│   ├── payroll/    工资管理：导入、核对、月结、工资凭证、保险推送（工资库）
│   └── reimbursement/ 报账管理：发票识别、报账批次、直接支付、发票凭证（accounting.db）
├── portal-adapter/ 一体化门户适配层（共享，三层注入引擎，见下）
└── shared/ 通用工具、类型、校验（portalHost / voucherCheckRules 收敛为唯一权威）
```

### 8.1 注入引擎拆成三层（对现有同名脚本的收敛方式）

当前两边各有 ~12 个同名注入脚本。合并时按"通用→平台→业务"三层拆分，避免重复，并为未来第三个模块（如合同/采购）留扩展位：

| 层 | 职责 | 对应现有代码 |
|---|---|---|
| **injector-core** | 打开页面、等元素、输入、点击、上传、截图、重试、异常分类 | `recorderScript` / `recorderDevTools` / `portalDomRecorderScript` / `pushLogger` 的通用部分 |
| **portal-adapter** | 一体化门户登录态、菜单跳转、通用表单、凭证检查/合并、提交 | `integrationModuleNavigationScript` / `integrationPushPreflightScript` / `voucherCheckScript` / `voucherMergeScript` / `portalDiagnosticsScript` |
| **module-scripts** | 各模块业务脚本 | 工资：`pushInsuranceScript` / `salary*Script`；报账：`pushDirectPayExternalDataScript` / `pushVoucherScript`（账务侧） |

### 8.2 抽象边界（什么共享、什么留在模块内）

- **应下沉共享**：门户窗口与注入引擎、授权/指纹、日志/留痕、配置、数据目录解析、通用校验。
- **必须留在各模块**（不要过度抽象成"统一引擎"）：工资计算规则、社保/个税规则、补贴/预算科目规则；发票识别/分类/查重规则、报账批次规则。这些后期会各自演化，强行统一会成为维护负担。

### 8.3 模块级版本化与发布隔离

门户 DOM 经常变动 → 注入脚本需要随时更新。要保证**工资侧门户变更不拖累报账侧发版**，反之亦然：

- 注入脚本按模块独立版本号（如 `payroll.injector.version` / `reimbursement.injector.version`）。
- 模块级开关（沿用工资系统已有的 `APP_FLAVOR` 机制再扩一个"账务"维度），可单独灰度/回滚某个模块。
- core/portal-adapter 稳定发布，模块脚本可独立小步更新。

---

## 9. 对"统一平台"通用建议的取舍（适用 / 不适用）

外部建议默认的是多用户 Web 平台范式；本项目是**单机单操作员桌面工具**，需要逐条甄别：

| 通用建议 | 在本项目是否适用 | 说明 |
|---|---|---|
| 统一平台 + 业务模块化 | ✅ 采纳 | 与本报告"单一应用 + 两模块"一致 |
| 公共注入引擎下沉 + 适配层 | ✅ 采纳 | 即第 8.1 三层注入，本就是最强复用点 |
| 业务数据隔离、不并大表 | ✅ 采纳 | 即"双库不并表"，工资/报账各自库 |
| 模块级灰度 / 版本化 / 回滚 | ✅ 采纳 | 即第 8.3，契合门户频繁变更的现实 |
| 公共逻辑不过度抽象 | ✅ 采纳 | 即第 8.2 抽象边界 |
| **SSO / 统一登录中心** | ❌ 不适用 | 登录是单一本地管理员闸（`LOCAL_ADMIN_USERNAME/PASSWORD`），非多用户 SSO |
| **组织架构 / 用户与岗位体系** | ❌ 不适用 | 无多用户体系，操作员就一个人 |
| **RBAC 角色权限矩阵（`payroll:view` 等）** | ❌ 不适用 | 无角色系统；真正的"准入"是 license + 硬件指纹。隔离靠双库 + 数据目录 + 授权按模块开关 |
| **统一审批流 / 审批节点引擎** | ❌ 不适用 | 审批发生在**外部财政门户**里，app 内只有"送审/推送"注入动作；`workflowRegistry` 是业务自动化流程而非审批引擎。**不要为不存在的审批流造引擎** |
| **微服务 vs 单体取舍** | ❌ 无关 | 都是 Electron 桌面程序，不涉及服务化 |
| **通知 / 待办 / 消息中心** | ⚠️ 谨慎 | 桌面单机场景价值有限，按现有内联提示即可，不新建子系统 |

> 一句话：外部建议的**架构骨架（平台+模块+共享注入+隔离数据）正确且已采纳**；但其**多用户治理那一套（SSO/组织/RBAC/审批引擎）是 Web 范式，在单机桌面工具上属于过度设计，本方案明确不做**。

---

## 附：关键事实索引（便于复核）

- 门户地址常量：`shared/portalHost.ts` → `DEFAULT_PORTAL_HOST = '172.24.147.202'`（两边相同）。
- 账务辅助导航：`src/router/index.ts`（vue-router，`/reimbursement/*` 为主）。
- 工资系统导航：`app/src/renderer/src/appModules.ts`（自管模块组 + `APP_FLAVOR`）。
- 账务辅助 Rust 现状：`docs/rust-rewrite.md`（CRUD/报账/手机同步已迁，OCR/Excel/授权未迁）。
- 工资系统多形态：`app/src/shared/appFlavor.ts`（full / runner）。
- 内外网摆渡架构：`docs/feasibility-outer-process-inner-integration.md`。
- 登录本质：账务辅助 `src/utils/localAuth.ts` 为单一本地管理员（`LOCAL_ADMIN_USERNAME/PASSWORD`），非多用户/SSO。
- 业务自动化流程：工资系统 `app/src/main/services/workflowRegistry.ts`（年报/预算同步/房补/月结），是业务流程注册，**非审批流引擎**。
- 无 RBAC/组织架构：两边代码均无角色/权限矩阵；"准入"由 `licenseService` + `hardwareFingerprint` 控制。
