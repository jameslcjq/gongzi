# 03 · 当前接口清单

本应用无 HTTP 服务端；"接口"= Electron IPC 通道。对渲染端只暴露一个对象 `window.salaryApi`（`app/src/preload/preload.ts`），主进程在 `ipc/appApi.ts`、`ipc/licenseApi.ts`、`ipc/mailApi.ts` 注册 handler。

## 1. 权限模型

- `appApi.ts` 用 `createLicensedIpcMain()` 包装：每次调用先 `assertLicenseForChannel(channel)`。
- 白名单 `LICENSE_FREE_CHANNELS`（未授权也能调）：
  `app:get-version`、`app:get-summary`、`app:list-workflows`、`import-watcher:*`、`integration:save-recording`、`portal-recorder:save`、`salary-quota-match:local-summary`、`unit-settings:get`、`unit-settings:lock-state`、**`unit-settings:set`**、`unit-settings:resolve-school`、`backup:list`、`monthly-payroll:list-runs`。
- ⚠ `unit-settings:set` 在白名单里——**未授权即可写单位信息**，是否有意 **待确认**（见 07）。
- `licenseApi.ts` 与 `mailApi.ts` 用裸 `ipcMain.handle`，**不过授权拦截**。

## 2. 授权接口（licenseApi.ts，返回 `{success, data|error}`）

| 通道 | 参数 | 用途 | 渲染端调用 |
|---|---|---|---|
| `license:status` | — | 取缓存授权状态 | ✓ |
| `license:check` | licenseKey? | 在线校验 | ✓ |
| `license:claimTrial` | customerName, customerCode? | 领取试用 | ✓ |
| `license:getKey` / `license:saveKey` | / key | 读/存授权码 | ✓ |
| `license:deviceInfo` | licenseKey? | 设备信息 | ✓ |
| `license:exportMachineRequest` | licenseKey? | 导出机器码 json | ✓ |
| `license:importOffline` | — | 导入 `.lic` 离线授权 | ✓ |
| `license:getServerUrl` | — | 取授权服务器地址 | ❌ 暴露未用（死） |
| `license:setServerUrl` | — | 永远返回失败 | ❌ 未在 preload 暴露（死通道） |

## 3. 业务接口（appApi.ts，按组）

> 完整 ~110 个，下面按分组列出代表通道；调用位置见 [05-requirement-code-map.md](05-requirement-code-map.md)。

| 组 | 通道（节选） | 说明 |
|---|---|---|
| 应用 | `app:get-version`、`app:get-summary`、`app:open-path`、`app:list-workflows`、`app:run-workflow` | 概要/打开路径/工作流 |
| 工作表 | `worksheet:list-records`、`:create-record`、`:update-record`、`:delete-record(s)`、`:clear`、`:export`、`:save-fields`、`:personnel-child-records` | 通用 CRUD/导出 |
| 系统/回收站 | `system:wipe-all`、`recycle-bin:list-batches`、`:list-records`、`:restore-batch` | 清库/回收站 |
| 导入 | `import:choose-file`、`:preview`、`:commit`、`:list-batches`、`:rollback-batch`、`import-watcher:*` | Excel 导入与监控 |
| 月度报账 | `monthly-payroll:generate-report-view`、`:inspect-source-periods`、`:list-runs`、`:list-source-versions`、`:set-source-version-current`、`:update-push-status`、`:delete-run`、`:archive-run`、`:cancel-month-close`、`:get-run-report`、`:print-salary-via-excel`、`:salary-print-page-summary`、`:settings:get/set`、`:print-settings:get/set` | 报账全流程 |
| 年初调整 | `annual-adjustment:choose-files`、`:preview`、`:apply`、`personal-tax:generate-import`、`social-insurance:export-base` | 年初调整 |
| 绩效 | `performance-payroll:generate`、`:generate-from-history`、`:generate-from-local` | 绩效 |
| 一体化 | `integration:open-external`、`:exec-in-all-frames`、`:get-portal-token`、`:drain-all-frames`、`:save-recording`、`:capture-recording-screenshot`、`portal-recorder:save`、`insurance-push:parse-xlsx`、`voucher-push:read-xlsx`、`salary-export:save-xls`、`salary-quota-match:local-summary`、`personnel-expense-plan:prefill`、`local-file:read-base64` | 门户/推送/采集 |
| 预算 | `budget-import:preview`、`:commit` | 预算 xls |
| 主数据同步 | `hr-master-sync:preview/apply-integrated`、`budget-active-sync:preview/apply-master`、`teacher-detail-sync:preview/apply-master`、`township-sync:fill-id-cards/preview-master/apply-master` | 同步 |
| 透视/统计 | `pivot:list/get/save/delete-config`、`:run`、`:export`、`:detect-id-card`、`stat-report:list/run/export/drill` | 分析 |
| 备份 | `backup:list/create/restore` | 备份恢复 |
| 单位设置 | `unit-settings:get/lock-state/resolve-school/set` | 单位 |
| 审计 | `consistency-audit:run/apply`、`archive:list-lookup-failures` | 一致性/查表失败 |
| 打印 | `print:list-printers`、`:current-view` | 打印 |

## 4. 邮件接口（mailApi.ts）

| 通道 | 说明 | 渲染端调用 |
|---|---|---|
| `mail:account-list/save/delete/test` | 账号 | ✓ |
| `mail:rule-list/save/delete` | 下载规则 | ❌ **三者全未调用**（规则 UI 缺失） |
| `mail:check` / `mail:check-stop` | 检查/停止 | ✓ |
| `mail:folder-list` | 文件夹 | ✓ |
| `mail:log-list/clear` | 日志 | ✓ |
| `mail:record-list` | 下载记录 | ❌ 未调用 |
| `mail:record-clear` | 清记录 | ✓ |
| `mail:choose-dir` / `mail:open-dir` | 选/开目录 | choose-dir ❌ / open-dir ✓ |

## 5. 主进程→渲染进程事件（推送，preload 用 `ipcRenderer.on`）

| 事件 | 用途 |
|---|---|
| `integration:webview-download-done` | webview 下载完成回调 |
| `integration:webview-open-tab` | 拦截弹窗转新标签 |
| `mail:check-progress` | 邮件检查进度 |

## 6. 疑似未在使用的暴露接口（preload 有、渲染端无静态引用）

> 经 `salaryApi.<method>` 全量比对得到（结果完整）。

| 接口 | 判断 |
|---|---|
| `licenseGetServerUrl` | 死 API |
| `generateMonthlyPayrollReportView` | 旧流程残留（被 `runWorkflow('monthly-payroll.generate')` 取代） |
| `generatePerformancePayroll`（基础版） | 旧流程残留（只用 `…FromHistory/…FromLocal`） |
| `listMailRules / saveMailRule / deleteMailRule` | 后端有、前端没接（邮件规则 UI 缺失） |
| `listMailRecords / chooseMailDir` | 死 API |
| `getPortalToken / savePortalDomRecord` | 渲染端未用 |
| `detectIdCardField / listRecycleBinRecords` | 待确认（可能预留） |
| `drainAllPortalFrames / savePortalRecording / capturePortalRecordingScreenshot` | 仅 `recorderDevTools.ts` 用（录制专用，正式包策略见 07） |

## 7. 错误返回约定不一致（需注意）

同一套 IPC 存在三种风格，前端需分别处理，易漏：
- `{ ok: false, reason }`：多见于 `integration:*`、`budget-import` 内部分支。
- 直接 `throw`：`worksheet:*`、`monthly-payroll:archive-run` 等。
- `{ success, data | error }`：`licenseApi.ts` 全部。
