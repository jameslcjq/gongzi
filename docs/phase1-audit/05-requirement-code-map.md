# 05 · 需求-代码对照表

> 需求来源：`docs/feature-guide.md`（16 个功能区，2026-06-01）+ 代码核对。
> 状态：✅ 完整 / 🟡 部分或有疑点 / ⛔ 缺口。风险：🔴高 🟠中 🟢低。

| 需求/功能 | 流程 | 前端文件 | 后端文件 | 数据库表 | 状态 | 风险 | 待确认 |
|---|---|---|---|---|---|---|---|
| 登录/授权 | 本地登录→license 校验 | `App.vue`、`SettingsDialog.vue` | `ipc/licenseApi.ts`、`services/licenseService.ts`、`hardwareFingerprint.ts` | `app_settings` | 🟡 | 🟠 | 登录写死 admin/123456；`unit-settings:set` 免授权 |
| 单位设置/数据目录 | 设置面板填写 | `SettingsDialog.vue` | `services/unitSettings.ts`、`schoolLookup.ts`、`config/paths.ts` | `app_settings`、学校对照表 | ✅ | 🟢 | — |
| 工资数据工作表 | 列表/CRUD/导出 | `App.vue`、`WorksheetView.vue`、`RecordFormDialog.vue` | `worksheetRecords.ts`、`worksheetExport.ts` | 在职/退休/其他工资 等 | 🟡 | 🟠 | 在职工资 `工资(001)/数币(002)` 视图是否仍生效（见 06/07） |
| Excel 导入/监控 | preview→commit→batch；watcher 自动入库 | `ImportDialog.vue` | `excelImport.ts`、`excelImportWatcher.ts`、`budgetExcelImport.ts`、`worksheetInference.ts` | `import_batches/_rows`、`import_logs` | ✅ | 🟢 | — |
| 一体化对接/推送 | 队列→webview 注入→POST→回写 | `IntegratedPortalPage.vue`、`integration/*` | `ipc/appApi.ts`(integration)、`main.ts` | `monthly_payroll_runs`(状态) | 🟡 | 🔴 | 录制是否进正式包；门户 IP 硬编码 |
| 月度工资报账 | preprocess/generate/月结/取消月结 | `MonthlyPayrollPage.vue` | `monthly-payroll/monthlyPayroll.ts`、`monthlyPayrollRuns.ts`、`integratedPayroll.ts`、`voucherSheet.ts` | `monthly_payroll_runs`、`_source_versions` | ✅ | 🔴 | 无自动测试；`retired_housing` 字段重复 |
| 绩效工资 | 两期对比 | `PerformancePayrollPage.vue` | `performancePayroll.ts` | 读历史/Excel | 🟡 | 🟠 | 基础版 `generatePerformancePayroll` 未用 |
| 年初调整 | 选文件→预览→应用回写 | `AnnualAdjustmentPage.vue` | `annualAdjustment.ts` | 在职工资 等 | ✅ | 🟠 | 社保比例→一体化字段映射靠约定（8%养老/4%职业年金） |
| 保险/凭证推送 | 队列两步（保险+凭证） | `IntegratedPortalPage.vue`、`pushInsuranceScript.ts`、`pushVoucherScript.ts` | `appApi.ts`、`monthlyPayrollRuns.ts` | `monthly_payroll_runs` | ✅ | 🟠 | — |
| 预算 | 下载→预览→入库/同步 | `IntegratedPortalPage.vue` | `budgetExcelImport.ts`、`budget/integratedBudgetSync.ts`、`budgetActiveHrSync.ts` | 预算在职/退休/其他、预算行政* | ✅ | 🟠 | 预算行政表/退休养老金无 UI 入口？ |
| 工资年报 | 生成年报 | `App.vue`(工资年报模块) | `annual-report/annualReport.ts`、`generateFromIntegrated.ts` | 工资年报、在职工资 等 | ✅ | 🟢 | 年报 28 字段映射是否完整（plan 未完成项） |
| 统计报表/透视 | 运行/下钻/导出 | `StatReportPage.vue`、`PivotPage.vue` | `statReports.ts`、`pivot.ts`、`pivotExport.ts` | 多表 join | ✅ | 🟢 | `detectIdCardField` 未在前端用 |
| 乡镇补贴 | 分段算/补全身份证/同步 | `App.vue`(乡镇补贴模块) | `township-allowance/townshipAllowance.ts`、`townshipHrSync.ts` | 乡镇补贴、对照表 | ✅ | 🟠 | 启动时年度递增（`main.ts` `applyAnnualTownshipYearIncreaseIfNeeded`） |
| 退休房补 | 核算新房补/写回退休 | `App.vue`(退休房补模块) | `housing-subsidy/newHousingSubsidy.ts` | 人员明细导出、新房补、退休工资 | ✅ | 🟠 | — |
| 人事管理/一致性 | 维护人事/主数据同步/审计 | `App.vue`(人事模块)、`ConsistencyAuditPage.vue` | `consistencyAudit.ts`、`hrMasterSync.ts`、`teacherDetailHrSync.ts`、`rankResumeImport.ts` | 人事信息、教职工系列、职级简历 | ✅ | 🟢 | — |
| 邮件附件下载 | IMAP 扫描下载 | `MailAttachmentPage.vue` | `mail/*`、`ipc/mailApi.ts` | `mail_*` 四表 | 🟡 | 🟠 | **下载规则 UI 缺失**；类型/DB 字段不齐 |
| 备份/恢复/月结 | WAL checkpoint→备份；月结锁月 | `SettingsDialog.vue`、`MonthlyPayrollPage.vue` | `backup.ts`、`monthlyPayrollRuns.ts` | 整库 | ✅ | 🟢 | — |
| 回收站/操作日志 | 批次快照→恢复 | `SettingsDialog.vue` | `operationLog.ts` | `operation_batches`、`record_change_logs`、`file_operation_logs` | 🟡 | 🟢 | `listRecycleBinRecords` 前端未用 |
| 工作流（6 个） | runWorkflow 执行 | `App.vue`、`MonthlyPayrollPage.vue` | `workflowRegistry.ts` | `workflow_runs` | 🟡 | 🟠 | 计划 ~10 个只接 6 个（见 06） |
| 正式包/开发版差异 | isPackaged 区分 | — | `config/paths.ts`、`package.json`、`installer/installer.nsh` | — | 🟡 | 🔴 | 录制工具未按文档从正式包剔除 |

## 已登记的工作流（`workflowRegistry.ts`，仅 6 个）

| key | 名称 | 模块 |
|---|---|---|
| `annual-report.generate` | 生成工资年报 | 工资年报 |
| `budget-all.sync-from-integrated` | 更新预算 | 预算 |
| `housing-subsidy.prepare-new` | 核算新房补 | 退休房补 |
| `housing-subsidy.write-back-retired` | 执行新退休房补 | 退休房补 |
| `monthly-payroll.preprocess` | 月度工资报账预处理 | 工资报账 |
| `monthly-payroll.generate` | 月度工资报账汇总生成 | 工资报账 |

> `development-plan.md` 另列了 `updateSalaryGrade / increaseSalaryGrade / calculateBudgetActiveBaseSalary / updateAnnualReportPerformanceSalary / updateTownshipYearsForAnnualReport / increaseTownshipYears` 等函数——未进入工作流注册表，是被并入别处还是未接 **待确认**。
