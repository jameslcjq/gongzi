# 一体化推送链路梳理与稳定性改进

分析时间：2026-06-05  
当前目标：先把“推送相关代码”完整找出来，并分析为什么会出现“点击推送后有时没有跳转到对应页面”的问题。本文只做梳理和改进建议，不改变现有推送逻辑。

## 1. 当前推送入口总览

当前系统里，“推送”不是一个单独模块，而是由业务页面把待推送任务放进共享队列，再切到“一体化对接”页面，由 WebView 注入脚本完成导航、上传、状态回写。

```mermaid
flowchart LR
  A["月度工资报账 / 年初调整页面"] --> B["组装 PushStep 队列"]
  B --> C["requestSwitchToIntegration()"]
  C --> D["App.vue 切换到一体化对接模块"]
  D --> E["IntegratedPortalPage.vue 获取当前 WebView"]
  E --> F["按步骤执行：工资 / 保险 / 凭证"]
  F --> G["WebView 内注入脚本"]
  G --> H["一体化页面导航 + 接口上传"]
  H --> I["回写推送状态"]
```

当前推送类型：

| 推送类型 | PushStep.kind | 目标模块 | 当前行为 |
| --- | --- | --- | --- |
| 工资导入 | `salary-system-import` | `budget` | 主要通过工资系统导入接口上传，页面跳转感不强 |
| 补发工资导入 | `salary-system-import` | `budget` | 同上，使用补发导入接口 |
| 保险推送 | `insurance` | `budget` | 尝试进入预算执行、集中支付、直接支付外部数据，再上传 |
| 凭证推送 | `voucher` | `accounting` | 尝试进入中科单位核算、凭证管理、凭证录入，再上传 |
| 全部推送 | 多个 PushStep | 按步骤决定 | 当前顺序：工资、保险、凭证 |

## 2. 推送相关代码清单

| 层级 | 文件 | 关键位置 / 函数 | 职责 | 备注 |
| --- | --- | --- | --- | --- |
| 月度工资入口 | `app/src/renderer/src/components/MonthlyPayrollPage.vue` | `enqueueIntegratedPush` | 把工资、保险、凭证推送步骤写入共享队列，并请求切换到一体化模块 | 当前先 `requestSwitchToIntegration()`，再延时 600ms 写队列 |
| 月度工资入口 | `app/src/renderer/src/components/MonthlyPayrollPage.vue` | `pushAllToIntegrated` | 一键推送全部 | 当前顺序为工资、保险、凭证 |
| 月度工资入口 | `app/src/renderer/src/components/MonthlyPayrollPage.vue` | `pushInsuranceToIntegrated` | 单独推送保险 | 读取保险导入 xlsx 后生成 `insurance` 步骤 |
| 月度工资入口 | `app/src/renderer/src/components/MonthlyPayrollPage.vue` | `pushVoucherToIntegrated` | 单独推送凭证 | 读取凭证 xlsx 后生成 `voucher` 步骤 |
| 月度工资入口 | `app/src/renderer/src/components/MonthlyPayrollPage.vue` | `pushSalaryImportsToIntegrated` | 单独推送工资 / 补发工资 | 读取本地文件 base64 后生成 `salary-system-import` 步骤 |
| 年初调整入口 | `app/src/renderer/src/components/AnnualAdjustmentPage.vue` | `pushAnnualAdjustmentToIntegrated` | 把年初调整生成的工资导入文件推送到一体化 | 只生成一个 `salary-system-import` 步骤 |
| 共享队列 | `app/src/renderer/src/integration/insurancePushQueue.ts` | `pendingPushQueue` | 保存待执行推送步骤 | 名字仍叫 insurance，但实际已经承载工资、保险、凭证三类推送 |
| 共享队列 | `app/src/renderer/src/integration/insurancePushQueue.ts` | `setSwitchToIntegration` / `requestSwitchToIntegration` | 注册并触发模块切换 | 切换动作由 `App.vue` 实现 |
| 模块切换 | `app/src/renderer/src/App.vue` | `setSwitchToIntegration(() => activeModuleKey.value = 'integration')` | 收到推送请求后切换到一体化对接页面 | 只切 App 内模块，不保证 WebView 已经登录或进入正确业务页 |
| 一体化执行页 | `app/src/renderer/src/components/IntegratedPortalPage.vue` | `processPushQueue` | 消费 `pendingPushQueue`，逐条执行推送 | 当前只拿当前可用 WebView，不再跑旧预检 |
| 一体化执行页 | `app/src/renderer/src/components/IntegratedPortalPage.vue` | `runOneStep` | 按 `PushStep.kind` 选择具体注入脚本 | 工资、保险、凭证在这里分发 |
| 一体化执行页 | `app/src/renderer/src/components/IntegratedPortalPage.vue` | `moduleTargetForStep` | 判断步骤应进入预算执行还是单位核算 | 工资/保险到 `budget`，凭证到 `accounting` |
| 一体化执行页 | `app/src/renderer/src/components/IntegratedPortalPage.vue` | `ensureModuleTarget` | 注入模块导航脚本，尝试打开预算执行或单位核算 | 当前导航失败只 `console.warn`，不会强制中断 |
| 一体化执行页 | `app/src/renderer/src/components/IntegratedPortalPage.vue` | `runPushPreflight` 等 | 旧预检逻辑 | 目前已经不在主流程调用，属于遗留代码 |
| 模块导航脚本 | `app/src/renderer/src/integration/integrationModuleNavigationScript.ts` | `buildOpenIntegrationModuleScript` | 在门户里点击“预算执行”或“中科单位核算” | 主要依赖页面文字查找，容易受菜单状态、iframe、页面未加载影响 |
| 保险推送脚本 | `app/src/renderer/src/integration/pushInsuranceScript.ts` | `buildPushInsuranceScript` | 进入直接支付外部数据页面并上传保险数据 | 页面导航和上传都在 WebView 内完成 |
| 保险推送脚本 | `app/src/renderer/src/integration/pushInsuranceScript.ts` | `openDirectPayPage` | 点击预算执行、集中支付、支付管理、直接支付外部数据 | 如果菜单没展开、文字不在当前 DOM、页面慢加载，可能失败 |
| 保险推送脚本 | `app/src/renderer/src/integration/pushInsuranceScript.ts` | `savePayRawData` 上传 | 调用 `/pay-voucher-server/grp/fes/pay/raw/savePayRawData` | 上传后还会轮询进度 |
| 凭证推送脚本 | `app/src/renderer/src/integration/pushVoucherScript.ts` | `buildPushVoucherScript` | 进入凭证录入页面并上传凭证 | 保留了直接 URL 兜底 |
| 凭证推送脚本 | `app/src/renderer/src/integration/pushVoucherScript.ts` | `openVoucherPage` | 点击中科单位核算、凭证管理、凭证录入，失败后尝试直接 URL | 比保险多一层直接 URL 兜底 |
| 凭证推送脚本 | `app/src/renderer/src/integration/pushVoucherScript.ts` | `gl_import_file_json` 上传 | 调用 `/gld-account-server/importAccount/gl_import_file_json` | 表单必须包含 `file` 和 `param` |
| 工资导入脚本 | `app/src/renderer/src/integration/salarySystemImportScript.ts` | `buildSalarySystemImportScript` | 上传工资导入或补发工资导入文件 | 当前偏接口上传，不一定 visibly 跳到工资导入页面 |
| 工资导入脚本 | `app/src/renderer/src/integration/salarySystemImportScript.ts` | `discoverAgency` / `discoverBatch` | 自动发现单位、批次上下文 | 依赖工资系统接口返回 |
| 工资导入脚本 | `app/src/renderer/src/integration/salarySystemImportScript.ts` | `uploadWithFallback` | 上传文件，字段优先 `ImportFile` | 之前 400 错误就是因为字段名不对，当前已优先使用 `ImportFile` |
| 旧预检脚本 | `app/src/renderer/src/integration/integrationPushPreflightScript.ts` | `buildIntegrationPushPreflightScript` | 旧的工资单位/批次预检 | 当前主流程不调用，后续要么删除，要么重构后再接回 |
| 开发油猴脚本生成 | `app/scripts/generate-dev-userscripts.mjs` | push insurance / voucher userscript | 生成内网测试用油猴脚本 | 只用于开发测试，不是 App 正式运行链路 |
| 预加载 API | `app/src/preload/preload.ts` | `readLocalFileBase64` | 给渲染进程读取本地导入文件 | 工资、补发工资上传前使用 |
| 预加载 API | `app/src/preload/preload.ts` | `parseInsuranceImportXlsx` | 给渲染进程解析保险导入文件 | 保险推送前使用 |
| 预加载 API | `app/src/preload/preload.ts` | `readVoucherXlsx` | 给渲染进程读取凭证 xlsx | 凭证推送前使用 |
| 预加载 API | `app/src/preload/preload.ts` | `updateMonthlyPayrollPushStatus` | 回写月度工资推送状态 | 成功 / 失败状态展示用 |
| 主进程 IPC | `app/src/main/ipc/appApi.ts` | `insurance-push:parse-xlsx` | 实际解析保险导入 xlsx | 服务于保险推送 |
| 主进程 IPC | `app/src/main/ipc/appApi.ts` | `voucher-push:read-xlsx` | 实际读取凭证 xlsx | 服务于凭证推送 |
| 主进程 IPC | `app/src/main/ipc/appApi.ts` | `local-file:read-base64` | 实际读取工资导入文件 | 服务于工资 / 补发工资推送 |
| 主进程状态 | `app/src/main/services/monthly-payroll/monthlyPayrollRuns.ts` | `updateMonthlyPayrollPushStatus` | 保存推送状态 | 月度工资行显示状态依赖这里 |
| 类型定义 | `app/src/shared/types.ts` | `MonthlyPayrollPushStatus` | 推送状态类型 | 支持 salary / insurance / voucher 三类状态 |
| 既有文档 | `docs/phase1-audit/01-system-flow.md` | 月度工资流程图 | 旧文档提到“前置校验” | 当前代码已绕过旧预检，这部分文档已经不完全符合现状 |

## 3. 当前执行链路

### 3.1 月度工资推送

1. 用户在月度工资数据行点击“推送全部 / 推送工资 / 推送保险 / 推送凭证”。
2. `MonthlyPayrollPage.vue` 根据按钮类型读取对应文件：
   - 工资、补发工资：读取本地 xls/xlsx/csv 的 base64。
   - 保险：解析保险导入 xlsx，生成 records。
   - 凭证：读取凭证 xlsx 的 base64 和文件名。
3. 页面调用 `enqueueIntegratedPush`：
   - 先把按钮状态改为“排队中”。
   - 调用 `requestSwitchToIntegration()`，要求 App 切到一体化对接模块。
   - 延迟 600ms 后把步骤写进 `pendingPushQueue`。
4. `App.vue` 收到切换请求后，将 `activeModuleKey` 改为 `integration`。
5. `IntegratedPortalPage.vue` 监听到队列有数据后执行 `processPushQueue`。
6. `processPushQueue` 获取当前可用 WebView，并逐个步骤执行：
   - 根据步骤类型判断目标模块。
   - 调用 `ensureModuleTarget` 尝试打开预算执行或单位核算。
   - 调用 `runOneStep` 注入具体推送脚本。
   - 成功后回写状态，失败后停止剩余步骤。

### 3.2 年初调整推送

1. 用户在年初调整页面点击推送。
2. `AnnualAdjustmentPage.vue` 读取年初调整生成的工资导入文件。
3. 生成一个 `salary-system-import` 步骤。
4. 写入 `pendingPushQueue`，并请求切到一体化对接模块。
5. 后续由 `IntegratedPortalPage.vue` 执行工资导入脚本。

### 3.3 三类推送脚本内部行为

| 类型 | 当前内部行为 | 是否强依赖页面跳转 |
| --- | --- | --- |
| 保险 | 先尝试进入直接支付外部数据页面，再上传 `savePayRawData` | 是 |
| 凭证 | 先尝试进入凭证录入页面，再上传 `gl_import_file_json`，并有直接 URL 兜底 | 是 |
| 工资 / 补发工资 | 先发现单位、批次上下文，再调用工资导入接口上传 | 不明显依赖可见页面跳转 |

## 4. “有时没有跳转到对应页面”的可能原因

### 4.1 模块切换和队列启动之间仍有时间假设

`MonthlyPayrollPage.vue` 当前是先请求切到一体化，再延迟 600ms 写队列。这个做法通常能用，但它仍然隐含一个假设：600ms 后一体化页面和 WebView 已经准备好。

如果一体化页面第一次加载较慢、WebView 还在登录页、门户页面还没渲染完，队列可能已经开始执行，但目标页面还没有真正可导航。

### 4.2 `waitForActiveWebview` 只保证拿到 WebView，不保证拿到正确页面

当前 `processPushQueue` 会等待一个可用 WebView，但“有 WebView”不等于：

- 已登录。
- 已在门户首页。
- 已经进入预算执行或单位核算。
- 当前活动页签就是本次推送应该使用的页签。
- 页面 DOM 已经加载完成。

所以代码可能拿到了一个 WebView，却不是一个适合立刻推送的状态。

### 4.3 `ensureModuleTarget` 失败时不会强制中断

`ensureModuleTarget` 会注入 `buildOpenIntegrationModuleScript` 尝试进入预算执行或单位核算。但是当前如果导航结果不是 ok，只是输出 `console.warn`，不会立刻阻止后面的推送脚本执行。

这会导致一个现象：用户看到“没有跳转”，但推送脚本仍继续执行。后续脚本如果也没能自己跳过去，就会失败；如果错误没有清晰展示，用户会感觉像是按钮没反应。

### 4.4 模块导航主要靠文字点击，稳定性不够

`integrationModuleNavigationScript.ts` 主要通过页面文字查找和点击来打开模块。问题是门户页面可能存在：

- 菜单没有展开。
- 文字在 iframe 内，不在当前 document。
- 页面还在加载，文字暂时不存在。
- 同一个文字在多个地方出现，点到了不该点的位置。
- 页面已经显示了某个 readyText，但并不代表业务页真的加载完成。

这种方式适合初步可用，但不是最稳的自动化跳转方式。

### 4.5 保险脚本比凭证脚本更依赖菜单点击

凭证脚本 `pushVoucherScript.ts` 有直接 URL 兜底：如果点击菜单失败，会尝试跳到 `VoucherInput.html`。

保险脚本 `pushInsuranceScript.ts` 主要还是通过菜单进入“直接支付外部数据”相关页面，并校验特定 templateslist URL。只要菜单路径、参数或页面加载方式有一点变化，就更容易出现“没跳过去”。

### 4.6 工资导入本来就不一定跳到可见页面

`salarySystemImportScript.ts` 当前重点是：

1. 预热工资系统上下文。
2. 查询单位和批次。
3. 调用导入接口上传文件。

它不是强制打开某个“工资导入页面”再由页面按钮上传。所以用户点击“推送工资”后，如果期待看到页面跳转，当前代码不一定满足这个视觉预期。这个需要在功能设计上明确：工资导入是后台接口推送，还是也要先跳到工资发放页面让用户看到。

### 4.7 当前活动页签可能不是本次推送应该使用的页签

保守修复后，主流程使用当前活动 WebView，避免之前多页签预检引起的上下文混乱。但如果用户在一体化对接里打开了多个页签，当前活动页签仍可能不是适合推送的页签。

目前代码没有一个明确的“本次推送专用页签状态机”，所以还不能完全避免页签错位。

### 4.8 旧预检代码仍留在项目里，容易造成维护误判

`IntegratedPortalPage.vue` 里仍保留 `runPushPreflight`、`collectInsuranceUnits`、`markStepsStatus`、`webviewForPushStep` 等旧逻辑，但当前主流程已经不调用。

这不会直接导致当前推送失败，但会让后续维护时误以为还有“前置校验”在工作。既有文档里也还有“前置校验”的描述，需要更新或注明已废弃。

## 5. 稳定性改进建议

### 5.1 第一阶段：先把推送过程变成可观察

建议先不大改业务逻辑，而是增加一套推送运行状态：

| 改进项 | 目的 |
| --- | --- |
| 增加 `pushRunId` | 每次点击推送都有唯一编号，避免多次点击混在一起 |
| 记录当前步骤 | 显示正在“切换模块 / 等待页面 / 上传 / 回写状态” |
| 记录目标页面 | 用户能看到系统正在尝试进入哪个页面 |
| 记录导航结果 | 区分“没找到菜单”“页面未登录”“接口失败”“上传失败” |
| 增加复制调试信息 | 内网测试时可以直接复制错误上下文回来分析 |

这样即使仍然失败，也能知道失败发生在“跳转前”“页面识别”“接口上传”还是“状态回写”。

### 5.2 第二阶段：把 `ensureModuleTarget` 升级为强校验状态机

当前的 `ensureModuleTarget` 只负责打开大模块。建议改成更明确的 `ensurePortalPage(targetPage)`：

| targetPage | 目标 |
| --- | --- |
| `insurance-direct-pay` | 预算执行 -> 集中支付 -> 直接支付外部数据 |
| `voucher-input` | 中科单位核算 -> 凭证管理 -> 凭证录入 |
| `salary-import` | 工资发放 / 工资导入相关页面，或明确标记为后台接口推送 |

每个目标页面都应该有完整状态：

1. 确认 WebView 存在。
2. 确认不是登录页。
3. 确认门户主体加载完成。
4. 打开目标大模块。
5. 打开目标业务页。
6. 用 URL、标题、关键 DOM、接口上下文共同确认页面正确。
7. 如果失败，返回结构化错误，并中断本步骤。

关键点：导航失败不能只写 `console.warn`，必须在用户界面上显示出来，并停止继续上传。

### 5.3 第三阶段：减少纯文字点击，增加直接地址和页面身份校验

建议每类推送都形成“菜单点击 + 直接地址兜底 + 页面身份校验”的组合。

| 类型 | 当前情况 | 建议 |
| --- | --- | --- |
| 凭证 | 已有直接 URL 兜底 | 保留，并把页面校验结果显示出来 |
| 保险 | 主要靠菜单点击 | 尽量补充已知 URL 或菜单参数兜底 |
| 工资 | 主要接口上传 | 明确是否需要可见页面跳转；如果需要，就增加工资页面导航 |

页面身份校验不要只看文字，最好同时看：

- URL path。
- `menuid` / `moduleid` / `viewCode` 等关键参数。
- 页面标题或 Tab 标题。
- 页面内必须存在的按钮、表格、接口上下文。

### 5.4 第四阶段：明确 WebView 页签策略

当前最稳的方向有两个，需要二选一：

| 策略 | 优点 | 风险 |
| --- | --- | --- |
| 使用当前可见 WebView | 用户能看见系统正在做什么，实现较保守 | 多页签时可能拿到错误页签 |
| 为每类目标维护专用页签 | 页面状态更可控 | 需要更完整的页签管理，之前上下文混乱问题不能重复 |

建议短期继续使用“当前可见 WebView”，但加上强页面校验。等页面校验稳定后，再考虑是否恢复“专用页签”。

### 5.5 第五阶段：按推送类型细化成功判断

| 类型 | 建议判断方式 |
| --- | --- |
| 保险 | 上传成功后，如果进度轮询超时，不要简单等同于失败；可以显示“已提交，未确认完成”，或者增加结果查询 |
| 凭证 | 保持 `file + param` 合同，解析接口返回的成功/失败明细 |
| 工资 | 保持 `ImportFile` 字段优先；HTTP 200 空返回可视为成功，但 HTML 返回必须判失败 |

### 5.6 第六阶段：清理或隔离旧预检代码

当前旧预检代码已经不在主链路中。建议后续做一个明确处理：

| 选择 | 说明 |
| --- | --- |
| 删除旧预检函数 | 最干净，避免维护误判 |
| 改名并注释为“暂不使用” | 如果还想保留作为参考 |
| 重构后接入新状态机 | 只在它不再阻塞无关推送时接回 |

不建议直接把旧预检恢复到主流程，因为之前它容易因为工资上下文影响保险、凭证推送。

## 6. 推荐的下一步改法

建议按下面顺序改，风险最小：

| 顺序 | 改动 | 目的 |
| --- | --- | --- |
| 1 | 在一体化对接页面增加推送过程日志和当前动作显示 | 先让失败位置可见 |
| 2 | `ensureModuleTarget` 失败时改为结构化失败，不再静默继续 | 避免“没跳转还继续上传” |
| 3 | 把目标从 `budget/accounting` 升级为具体业务页 | 不只打开大模块，还要确认业务页 |
| 4 | 给保险页面补充更稳的直接地址或参数兜底 | 解决保险最容易不跳转的问题 |
| 5 | 明确工资推送是否需要可见跳转 | 避免用户认为“没跳转就是没执行” |
| 6 | 清理旧预检代码和旧文档描述 | 降低后续维护误判 |

## 7. 建议测试矩阵

每次改完推送稳定性后，建议至少测这些场景：

| 场景 | 需要确认 |
| --- | --- |
| 登录页状态点击推送 | 能提示“请先登录”或自动等待登录 |
| 门户首页点击推送保险 | 能进入预算执行和直接支付外部数据 |
| 已在预算执行首页点击推送保险 | 能继续进入直接支付外部数据 |
| 已在凭证录入页点击推送凭证 | 不重复乱跳，直接上传 |
| 已在单位核算首页点击推送凭证 | 能进入凭证录入 |
| 多页签打开时点击推送 | 明确使用哪个页签，并能显示当前目标 |
| 单独推送工资 | 用户能看到是后台接口上传，或能跳到工资页面 |
| 推送全部 | 工资、保险、凭证顺序正确，某一步失败后剩余步骤不误执行 |
| 连续推送两次 | 第二次没有上一次的残留步骤或状态 |
| 网络慢 / 页面慢加载 | 能等待、重试，并显示失败原因 |

## 8. 结论

当前推送失败的核心不是单一接口问题，而是“页面导航状态不够确定”。代码已经能把文件、数据和上传脚本串起来，但在 WebView 里打开哪个模块、哪个页签、哪个业务页，目前还缺少强校验和用户可见的失败说明。

最保守、最稳的改进方向是：先保留现有上传接口和数据格式不动，只增强推送前的页面导航状态机、页面身份校验、失败提示和过程日志。这样不会破坏已经成功过的工资、保险、凭证上传合同，同时能把“有时没跳转”的问题从黑盒变成可定位的问题。
