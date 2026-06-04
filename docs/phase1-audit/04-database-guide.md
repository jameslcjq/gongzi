# 04 · 当前数据库使用说明

## 1. 引擎与位置

- 引擎：`sqlite3` 6.0（**异步回调**驱动；非 `better-sqlite3`，与 `development-plan.md` 设计不符）。
- 访问封装：`app/src/main/db/connection.ts` 手写 Promise 包装 `exec/all/get/run/runWithLastId`。
- 数据库文件：`getDataPath('salary-system.sqlite')`
  - 正式版：`D:\laojiu\gzdata\salary-system.sqlite`
  - 开发版：`D:\laojiu\gzdata-dev\salary-system.sqlite`（由 `app.isPackaged` 区分，`config/paths.ts`）
  - 可用 env `PAYROLL_DATA_ROOT` 覆盖。
- PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`cache_size=-8000`、`foreign_keys=ON`、`temp_store=MEMORY`。

## 2. 建表与迁移机制

启动时 `getDatabase()` 顺序执行（`connection.ts:29-53`）：
1. `readRetainedSchemaSql()`：**按元数据 `docs/data/worksheets-retained.json` 动态建工作表**（`db/schema.ts`，列名=字段名，数值型 controlType 6/31→REAL，其余 TEXT）。
2. `ensureSystemTables()`：建系统表 + `ensureColumns()` 增量补列（这是项目的"迁移"方式，无版本号迁移文件）。
3. `syncWorksheetColumns()`：元数据新增字段时 `ALTER TABLE ADD COLUMN`。
4. `ensurePackagedLookupSeeds()`、`backfillHrBankFieldsFromBudget()`、`ensureBudgetStatusColumns()`、`refreshAllPersonnelStatuses()`、`ensurePerformanceIndexes()`、`ensureIdentityUniqueIndexes()`。

> 迁移特点：幂等、靠 `PRAGMA table_info` 比对补列；**没有 down 迁移、没有版本表**。改字段类型/删列不在此机制覆盖范围内。

## 3. 系统表（手写，`connection.ts:274-538`）

| 表 | 用途 | 被谁用 | 备注/疑似废弃 |
|---|---|---|---|
| `app_settings` | KV：单位信息/打印/月度设置/当前年度 | unitSettings、printSettings、monthlyPayrollSettings | — |
| `import_batches` / `import_batch_rows` | 导入批次 + 行级回滚（`action`/`previous_values`） | excelImport | — |
| `import_logs` | 导入日志 | watcher/通知 | — |
| `monthly_payroll_runs` | 报账历史：金额汇总、源/生成文件路径、`report_snapshot`、`is_outdated`、三个 `*_push_status`/`*_pushed_at`、归档字段 | monthly-payroll | `retired_housing` 与 `retired_housing_actual_pay` 并存，`mapRunRow` 有回退兜底，疑半重复 **待确认** |
| `monthly_payroll_source_versions` | 源文件版本（`current/replaced`、`sha256`、`summary_json`） | monthlyPayrollSources | — |
| `workflow_runs` | 工作流执行记录 | runWorkflow | — |
| `field_mappings` | 明道云字段→本地列映射（`UNIQUE(worksheet_id,field_id)`） | — | ⚠ 表在、**未见写入逻辑**，疑迁移期遗留 **待确认** |
| `lookup_failures` | 查表失败明细 | 工作流/年报 | — |
| `personnel_status_index` | 由三张工资表派生在职/退休/其他状态 + 冲突标记 | personnelStatus | — |
| `pivot_configs` | 透视配置 | pivot | — |
| `mail_accounts` | 邮箱账号（`auth_code_encrypted` 加密存） | mail | — |
| `mail_download_rules` | 下载规则 | mail（后端） | 列 `from_contains/target_dir/save_subdir/folder` **前端类型未暴露、UI 未接** |
| `mail_download_records` | 下载记录（去重唯一索引） | mail | 类型有 `ruleId` 但**表无 `rule_id` 列** |
| `mail_download_logs` | 下载日志 | mail | — |
| `operation_batches` / `record_change_logs` / `file_operation_logs` | 操作审计 + 回收站底座 | operationLog、monthly-payroll | — |

## 4. 工作表（实际 ~28 张，元数据驱动）

> 与 `docs/retained-worksheets.md`（写 16 张）**严重不符**，以 `docs/data/worksheets-retained.json` 为准。

业务表（worksheetId 为明道云原 id）：
`在职工资、退休工资、其他工资、预算在职、预算退休、预算其他、退休养老金、工资年报、绩效工资、乡镇补贴、岗位工资对照、薪级工资对照、乡镇工作年限对照、人员明细导出、新房补`

本地表（worksheetId 形如 `local-*` / `budget_gov_*`，后加）：
`学校对照表、在编教职工基本信息、人事信息、教职工学历、教职工教师资格、教职工任教信息、教职工工作履历、职级简历、社保明细、个税明细、公积金明细、预算行政在职、预算行政离退休`

**演进痕迹**：
- 改名（worksheetId 不变，可证同表）：`一体化在职/退休/其他`→`在职工资/退休工资/其他工资`；`其他人员`→`预算其他`。
- 删除：`人员待遇申领明细`、`职称信息表`、`姓名`、`补发工资`、`绩效工资过渡表`。

## 5. 关系与索引

- **核心关联键**：`证件号码` / `证件号码*` / `身份证号码`（几乎所有跨表匹配、工作流、透视都靠它）。
- 唯一索引：`ensureIdentityUniqueIndexes` 给各表证件号建唯一索引；`在职/退休/其他工资`用 `(证件号码, 工资批次编码)` 复合唯一（同人可有 001 工资 + 002 数币两批次）。`local-hr-edu/cert/teach/work` 等多值表豁免唯一约束。
- 性能索引：`ensurePerformanceIndexes` 给各表证件号、预算表 `md_status`、人员状态列建索引。
- 系统列：每张工作表带 `id`(PK)、`md_row_id`(UNIQUE)、`md_created_at`、`md_updated_at`。
- 预算表额外列：`md_status`、`md_status_changed_at`、`md_status_reason`（人员状态，`手工设置`原因会被保护不被自动覆盖）。

## 6. 备份与恢复

- 备份前执行 WAL checkpoint，避免漏掉 WAL 中数据（`backup.ts`）。
- 恢复会覆盖当前库并重启程序。
- 月结归档把当月源/生成文件搬入 `工资数据/<年-月>/` 目录并写 manifest。

## 7. 疑似废弃/需核对字段汇总

| 位置 | 现象 | 处置建议 |
|---|---|---|
| `field_mappings` 表 | 无写入逻辑 | 先只读确认是否仍需要，再决定删表 |
| `monthly_payroll_runs.retired_housing` vs `retired_housing_actual_pay` | 并存 + 兜底回退 | 核对口径，可能合并 |
| `mail_download_records.rule_id` | 类型有列无 | 补列或删类型字段 |
| `mail_download_rules` 多列 | DB 有、前端未用 | 取决于"下载规则"是否要做 |
