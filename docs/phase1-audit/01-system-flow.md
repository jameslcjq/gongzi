# 01 · 当前系统实际流程图

> 本图基于代码实际走向绘制，非设计意图。Mermaid 代码块在支持 Mermaid 的查看器中可渲染为图。

本应用是**学校/教育单位工资业务桌面端**，核心价值：把本地工资数据加工成各类导入文件，并通过内嵌 webview **自动推送到"预算管理一体化"政务平台**（内网 `172.24.147.202`）。

---

## 1. 总流程（用户 → 前端 → 后端 → DB → 第三方）

```mermaid
flowchart TD
  subgraph 输入源
    A1[Excel: 工资表/社保/个税/公积金/预算人员]
    A2[一体化 webview 下载拦截]
    A3[邮件 IMAP 附件下载]
    A4[手工新增/编辑]
  end

  A1 --> IMP[Excel 导入 preview→commit]
  A2 --> IMP
  A3 --> FOLDER[导入文件夹 D:\laojiu\工资导入]
  FOLDER --> WATCH[excelImportWatcher 自动入库]
  WATCH --> DB[(SQLite 工作表)]
  IMP --> DB
  A4 --> DB

  DB --> MP[月度工资报账 preprocess/generate]
  MP -->|生成| F1[保险导入.xlsx]
  MP -->|生成| F2[凭证导入.xlsx]
  MP -->|生成| F3[工资导入/补发.xlsx]

  F1 --> Q[pendingPushQueue 内存队列]
  F2 --> Q
  F3 --> Q
  Q -->|串行| PORTAL[IntegratedPortalPage webview 注入脚本]
  PORTAL -->|HTTP POST| GOV[(一体化平台 172.24.147.202)]
  GOV -->|成功/失败| STATUS[monthly_payroll_runs.*_push_status 回写]
  STATUS --> DB
```

---

## 2. 月度工资报账流程（核心）

入口：`MonthlyPayrollPage.vue` → `salaryApi.runWorkflow('monthly-payroll.preprocess' | '.generate')` → `workflowRegistry.ts` → `monthly-payroll/monthlyPayroll.ts`。

```mermaid
flowchart TD
  S0[选择/检测源文件: 工资表 + 社保 + 个税] --> S1{是否当前月份?}
  S1 -- 否 --> E1[拒绝: 非当前月份]
  S1 -- 是 --> S2{该月是否已月结?}
  S2 -- 是 --> E2[拒绝: 已月结不能重新生成]
  S2 -- 否 --> S3[inspect 源文件所属期]
  S3 --> S4{社保覆盖当月? 个税=上月?}
  S4 -- 否 --> E3[拦截并提示所属期不符]
  S4 -- 是 --> S5[preprocess 预处理: 重算个税/社保]
  S5 --> S6{工资表 vs 本地有可回写差异?}
  S6 -- 有 --> S7[列出差异, 需用户确认]
  S7 --> S8[generate 汇总生成]
  S6 -- 无 --> S8
  S8 --> S9[生成 保险/凭证/工资/补发 文件 + 报表快照]
  S9 --> S10[persistMonthlyPayrollRun 落库]
  S10 --> S11{同月已有未过期记录?}
  S11 -- 有 --> S12[旧记录 is_outdated=1; success→needs-repush; 清理旧文件]
  S11 -- 无 --> END[完成, 等待推送/月结]
  S12 --> END
```

**月结归档（archive）**：`monthlyPayrollRuns.ts` `archiveMonthlyPayrollRun`
- **前置硬条件**：必须有 `sourceSocialPath` 且 `insuranceImportPath`，否则报"社保未补齐，当前只是工资阶段结果，不能月结"。
- 动作：源文件 + 生成文件搬入归档目录 → 写 `工资报账月结_清单_*.json` → **清空"补发工资/补扣工资"调整字段** → 重算工作表。
- 逆操作 `cancelMonthlyPayrollMonthClose`：还原源文件、还原调整字段、清生成文件。

---

## 3. 一体化推送流程

队列：`integration/insurancePushQueue.ts`（`pendingPushQueue = ref<PushStep[]>`）。三种步骤：
- `insurance`：保险记录 → `POST /pay-voucher-server/.../savePayRawData`
- `voucher`：凭证文件 base64 → `POST /gld-account-server/.../gl_import_file_json`（multipart）
- `salary-system-import`：工资变动/补发 Excel 导入

```mermaid
sequenceDiagram
  participant MP as MonthlyPayrollPage
  participant Q as pendingPushQueue
  participant App as App.vue
  participant IP as IntegratedPortalPage
  participant WV as webview 注入脚本
  participant GOV as 一体化平台

  MP->>Q: push 步骤(保险/凭证/工资)
  MP->>App: requestSwitchToIntegration()
  App->>IP: 切到"一体化对接"模块
  IP->>IP: processPushQueue() 串行
  loop 每个步骤
    IP->>WV: 前置校验(单位全称+导入编码匹配)
    alt 校验失败
      WV-->>IP: 停止, 提示原因
      IP->>MP: *_push_status = failed
    else 校验通过
      WV->>GOV: HTTP POST
      GOV-->>WV: 返回结果
      WV-->>IP: ok / fail
      IP->>MP: *_push_status = success / failed
    end
  end
```

**失败路径**：找不到菜单 / 页面未登录 / 单位不匹配 / 文件为空 / 接口返回失败 / 保存后未返回列表 → 停队列并提示。
**异常路径**：webview 跨域 frame 执行失败被吞（`appApi.ts` `exec-in-all-frames` 单 frame 失败不影响其它）；`HWACCESSTOKEN` 未生成时提示"请先手动进一次预算编制页"。

---

## 4. 导入流程（成功/失败/异常）

```mermaid
flowchart LR
  C1[主动: ImportDialog 选文件] --> P[import:preview 解析+表头映射+diff]
  P --> CK{有更新且需确认?}
  CK -- 是 --> CF[用户确认 confirmUpdates]
  CK -- 否 --> CM[import:commit]
  CF --> CM
  CM --> B[(import_batches/_rows 记录)]
  CM --> OK[入库成功]
  CM -. 失败 .-> ROLL[不污染原数据, 可 rollback-batch]

  W1[自动: watcher 监控目录] --> DET[识别目标工作表]
  DET --> CM
  W2[预算 xls] --> PV[budget-import:preview 必须预览]
  PV --> CMB[budget-import:commit 确认入库]
```

- 预算 xls **不允许下载即写库**，必须 `preview` 后 `commit`。
- webview 下载拦截（`main.ts`）只拦"工资导出"与"预算人员信息"两类，其余走系统另存为。

---

## 5. 登录与授权门禁流程

```mermaid
flowchart TD
  L0[打开程序] --> L1{localStorage 已登录?}
  L1 -- 否 --> L2[本地登录页 admin/123456]
  L2 --> L3[写 localStorage 标志]
  L1 -- 是 --> L4
  L3 --> L4{license 有效?}
  L4 -- 否 --> L5[授权校验页: 在线/离线/缓存授权]
  L4 -- 是 --> L6[进入业务模块]
  L5 -->|成功| L6
  L5 -. 失败 .-> L5
```

- 登录是前端 `localStorage` 软门（`App.vue` 写死 `admin/123456`）；真实门禁靠 license（`assertLicenseForChannel`）。
- 未授权时大部分业务 IPC 被拦截，少数白名单通道放行（见 [03-interface-inventory.md](03-interface-inventory.md)）。
- 机器码由硬件指纹生成；离线授权 `.lic` 用公钥验签。
