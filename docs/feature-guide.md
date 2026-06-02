# 工资系统功能说明

更新时间：2026-06-01

本文写给后续维护和业务核对使用。它描述的是当前代码实际提供的功能入口、数据来源、输出结果和维护注意点；如果以后用户操作步骤或业务口径变化，应同步更新本文。

## 1. 登录与授权

入口位置：

- 打开程序后先进入本地登录页。
- 当前本地登录账号为 `admin`，密码为 `123456`。
- 登录后如果授权无效，会进入授权校验页。

解决什么事：

- 防止未登录用户直接进入业务模块。
- 通过在线授权、离线授权或缓存授权控制软件可用性。

数据来源：

- 授权码由用户输入或本地配置读取。
- 机器码由本机硬件指纹生成。
- 在线授权调用授权中心。
- 离线授权读取 `.lic` 文件并用公钥校验签名。

生成结果：

- 授权成功后进入业务模块。
- 授权失败时停留在授权页，并显示失败原因。
- 可导出机器码给授权中心生成离线授权。

关键业务规则：

- 未授权时，大部分业务 IPC 会被拦截。
- 单位设置、授权校验、备份列表、历史工资报账列表等少量基础能力允许在未授权状态访问。
- 授权码会保存到本机配置中，离线授权文件保存到数据目录的授权子目录。

失败时会看到什么：

- 授权码为空、授权过期、机器不匹配、离线文件无效、网络错误等提示。

相关代码：

- `app/src/renderer/src/App.vue`
- `app/src/main/ipc/licenseApi.ts`
- `app/src/main/services/licenseService.ts`
- `app/src/main/services/hardwareFingerprint.ts`
- `app/src/main/ipc/appApi.ts`

回归样例：

- 暂以人工验证为主：无授权、在线授权成功、离线授权成功、离线授权机器不匹配。

## 2. 单位设置与数据目录

入口位置：

- 顶部设置按钮。
- 授权页中的“单位设置”按钮。

解决什么事：

- 维护单位名称、单位导入编码、功能分类、预算项目、收款信息等基础参数。
- 控制工资报账、凭证、保险导入、一体化推送时使用的单位信息。

数据来源：

- 用户在设置界面填写。
- 部分字段可通过学校名称查找或解析。

生成结果：

- 设置保存到本地数据库或本地配置。
- 工资报账、一体化推送、凭证生成会读取这些设置。

关键业务规则：

- 单位全称和单位导入编码是门户推送前置校验的重要依据。
- 收款信息会进入保险、住房等相关输出。
- 数据目录和导入目录默认在 `D:\laojiu` 下。

相关代码：

- `app/src/renderer/src/components/SettingsDialog.vue`
- `app/src/main/services/unitSettings.ts`
- `app/src/main/config/paths.ts`

## 3. 工资数据工作表

入口位置：

- 顶部模块中的“工资数据”。
- 左侧工作表包括“在职工资”“退休工资”“其他工资”。

解决什么事：

- 保存本地工资基础数据。
- 为月度工资报账、绩效工资、年初调整、统计报表等功能提供本地权威数据。

数据来源：

- 手工新增、编辑。
- Excel 导入。
- 一体化导出文件自动导入。
- 月度工资报账或年初调整中的写回逻辑。

生成结果：

- 本地 SQLite 表数据。
- 可导出当前工作表。
- 可参与统计分析和报账生成。

关键业务规则：

- 身份证号或证件号码是多表匹配的核心键。
- 关键流程执行前会检查身份证/唯一键重复，发现重复会阻止执行。
- 部分字段会按工资报账设置重算，例如个税使用“补扣工资”或“当月个人所得税”。

相关代码：

- `app/src/main/services/worksheetRecords.ts`
- `app/src/main/services/worksheetExport.ts`
- `app/src/main/services/monthly-payroll/integratedPayroll.ts`
- `app/src/main/db/connection.ts`

## 4. Excel 导入与导入监控

入口位置：

- 顶部导入按钮。
- 工资导入文件夹快捷方式。
- 一体化 webview 下载拦截。

解决什么事：

- 把业务 Excel 导入到对应工作表。
- 监控导入文件夹，自动识别新文件并入库。
- 保存导入批次，支持失败提示和部分回滚。

数据来源：

- 用户选择的 Excel。
- `D:\laojiu\工资导入` 下的文件。
- 一体化系统下载的预算或工资相关文件。

生成结果：

- 导入批次记录。
- 成功或失败通知。
- 入库后的工作表数据。

关键业务规则：

- 文件名、表头和字段映射共同决定目标工作表。
- 预算 xls 采用预览确认后入库，不能下载后直接写库。
- 导入失败不能污染原数据。

相关代码：

- `app/src/main/services/excelImport.ts`
- `app/src/main/services/excelImportWatcher.ts`
- `app/src/main/services/budgetExcelImport.ts`
- `app/src/renderer/src/components/ImportDialog.vue`

## 5. 一体化对接

入口位置：

- 顶部模块“一体化对接”。

解决什么事：

- 在软件内打开一体化系统。
- 支持一体化多标签页。
- 承接工资导出、预算 xls 下载、保险推送、凭证推送、工资导入、补发工资导入、指标匹配、计划录入、自动录入等自动化动作。

数据来源：

- 一体化系统页面。
- 月度工资报账生成的保险导入、凭证导入、工资导入、补发工资文件。
- 单位设置中的单位名称和导入编码。

生成结果：

- 下载文件自动进入导入目录。
- 保险、凭证、工资导入等任务推送到一体化页面。
- 推送状态写回工资报账历史记录。

关键业务规则：

- 推送前必须做单位和页面前置检查。
- 推送队列串行执行，任一步失败都会停止后续步骤。
- 页面按钮应只出现在对应页面，不能重复加全局按钮。
- “开始录制/停止录制”属于开发调试能力，正式包不得开放。

失败时会看到什么：

- 找不到菜单、页面未登录、单位不匹配、文件为空、接口返回失败、保存后未返回列表等提示。

相关代码：

- `app/src/renderer/src/components/IntegratedPortalPage.vue`
- `app/src/renderer/src/integration/*`
- `app/src/main/main.ts`
- `app/src/main/ipc/appApi.ts`

回归样例：

- `tests/fixtures/integration-push/insurance-voucher-queue/`

## 6. 月度工资报账

入口位置：

- 顶部模块“工资业务”。
- 子页签“月度工资”。

解决什么事：

- 生成月度工资报账相关表格和导入文件。
- 支持“工资表 Excel 兼容模式”和“本地工资数据模式”。
- 支持社保补齐、个税扣款、补发工资、保险导入、凭证导入、工资导入。

数据来源：

- 本地在职工资、退休工资、其他工资。
- 工资表 Excel。
- 社保未申报汇总。
- 个税计算表。
- 单位设置。

生成结果：

- 报表预览。
- 保险导入文件。
- 凭证导入文件。
- 工资导入文件。
- 补发工资文件。
- 历史报账记录和报表快照。

关键业务规则：

- 只能处理当前月份。
- 已月结月份不能重新预处理或重新生成。
- 社保是最终月结必备文件；未补齐社保时只能生成阶段结果。
- 社保文件会校验“费款所属期起/止”：必须覆盖当前处理月份；允许同时包含以前月份的补缴或调整记录。
- 个税文件会校验“税款所属期起/止”：当前月份申报上个月个税，例如 6 月处理时个税所属期必须是 5 月。
- 有工资表时按工资表兼容模式校准本地工资数据。
- 没有工资表时按本地在职工资、退休工资、其他工资生成。
- 工资表与本地工资数据有可自动回写差异时，需要用户确认后才回写。
- 保险凭证附件页数固定为 7。
- 工资凭证附件页数根据工资表、遗补、退休房补打印页数动态计算。
- 同月重新生成会把旧报账记录标记为过期，已成功推送的状态会变成“需要重新推送”。

失败时会看到什么：

- 非当前月份、已月结、缺少社保文件、社保不含当月所属期、个税不是上月所属期、工资表与本地数据不一致、个税人员匹配失败、社保个人四险不一致等提示。

相关代码：

- `app/src/renderer/src/components/MonthlyPayrollPage.vue`
- `app/src/main/services/monthly-payroll/monthlyPayroll.ts`
- `app/src/main/services/monthly-payroll/monthlyPayrollRuns.ts`
- `app/src/main/services/monthly-payroll/integratedPayroll.ts`
- `app/src/main/services/monthly-payroll/monthlyPayrollParsers.ts`
- `app/src/main/services/monthly-payroll/voucherSheet.ts`

回归样例：

- `tests/fixtures/monthly-payroll/basic-integrated/`

## 7. 绩效工资

入口位置：

- 顶部模块“工资业务”。
- 子页签“绩效工资”。

解决什么事：

- 对比两个期间的工资历史数据。
- 识别晋级、小档、退休、调出、新进、调入等变化。
- 生成绩效工资差异结果。

数据来源：

- 一体化历史工资数据。
- 或用户选择的两个本地工资 Excel。

生成结果：

- 绩效工资结果文件。
- 匹配数量、变化数量、缺失数量和警告。

关键业务规则：

- 以证件号码作为稳定匹配键。
- 两个期间都存在的人用于对比变化。
- 只在第一个期间存在的人按调出/退休等处理。
- 只在第二个期间存在的人按新进/调入等处理。
- 备注文字应保持业务口径，避免随意改名。

相关代码：

- `app/src/renderer/src/components/PerformancePayrollPage.vue`
- `app/src/main/services/performancePayroll.ts`

回归样例：

- `tests/fixtures/performance-payroll/two-period-change/`

## 8. 年初调整

入口位置：

- 顶部模块“工资业务”。
- 子页签“年初调整”。

解决什么事：

- 根据工资表、公积金账号表、社保明细等文件生成年初社保个税调整结果。
- 可生成工资导入文件、住房申报相关文件、个税导入文件、社保基数导入文件。

数据来源：

- 工资表。
- 公积金账号表。
- 社保明细文件。
- 个税模板。
- 社保基数模板。
- 本地在职工资。

生成结果：

- 年初调整工资表。
- 工资导入文件。
- 住房申报文件。
- 缺失人员日志。
- 个税导入文件。
- 社保基数导入文件。

关键业务规则：

- 社保比例字段映射到一体化字段，例如 8% 对应养老保险缴费、4% 对应职业年金缴费。
- 能自动判断的写回在职工资，不能判断的进入人工判断列表。
- 写回一体化工资数据前需要用户确认。

相关代码：

- `app/src/renderer/src/components/AnnualAdjustmentPage.vue`
- `app/src/main/services/annualAdjustment.ts`

回归样例：

- `tests/fixtures/annual-adjustment/basic/`

## 9. 保险凭证与凭证导入

入口位置：

- 月度工资历史记录中的“推送保险/凭证”。
- 一体化对接页自动承接推送队列。

解决什么事：

- 把保险导入记录推到一体化“直接支付外部数据”。
- 把凭证导入文件上传到一体化“凭证导入”。

数据来源：

- 月度工资报账生成的保险导入 xlsx。
- 月度工资报账生成的凭证 xlsx。
- 单位设置和一体化登录态。

生成结果：

- 一体化系统中的保险支付外部数据。
- 一体化系统中的凭证导入结果。
- 本地报账历史中的推送状态。

关键业务规则：

- 保险和凭证作为同一保险推送链路的两个步骤。
- 推送前必须检查当前登录单位和目标单位。
- 重新生成报账后，旧推送状态需要重新推送。

相关代码：

- `app/src/renderer/src/integration/pushInsuranceScript.ts`
- `app/src/renderer/src/integration/pushVoucherScript.ts`
- `app/src/renderer/src/components/IntegratedPortalPage.vue`

## 10. 预算

入口位置：

- 顶部模块“预算”。
- 一体化对接中手动下载预算 xls 后触发预览入库。

解决什么事：

- 维护预算在职、预算退休、预算其他数据。
- 从一体化下载的预算 xls 预览后入库。
- 可从一体化工资数据同步预算相关字段。

数据来源：

- 一体化预算 xls。
- 本地工资数据。
- 预算工作表人工维护。

生成结果：

- 预算工作表数据。
- 预算入库预览和确认结果。

关键业务规则：

- 预算 xls 不直接自动入库，必须预览确认。
- 字段匹配依赖 `importSource`，不是只靠显示名称。

相关代码：

- `app/src/main/services/budgetExcelImport.ts`
- `app/src/main/services/budget/integratedBudgetSync.ts`
- `app/src/main/services/budgetActiveHrSync.ts`

## 11. 工资年报和统计报表

入口位置：

- 顶部模块“工资年报”。
- 顶部模块“统计分析”。

解决什么事：

- 生成工资年报。
- 按预设规则生成统计报表和下钻明细。
- 支持透视分析。

数据来源：

- 本地工资数据。
- 人事信息、预算表、乡镇补贴等工作表。
- 用户输入的绩效、班主任费、延时费等年报参数。

生成结果：

- 年报数据。
- 统计报表。
- 透视结果和导出文件。

相关代码：

- `app/src/main/services/annual-report/annualReport.ts`
- `app/src/main/services/statReports.ts`
- `app/src/main/services/pivot.ts`
- `app/src/main/services/pivotExport.ts`

## 12. 乡镇补贴和退休房补

入口位置：

- 顶部模块“乡镇补贴”。
- 顶部模块“退休房补”。

解决什么事：

- 乡镇补贴按工作年限和对照表生成新标准。
- 补全乡镇补贴中的身份证号。
- 核算新房补并写回退休工资。

数据来源：

- 一体化工资数据。
- 乡镇工作年限对照表。
- 人事信息。
- 退休工资和房补相关表。

生成结果：

- 乡镇补贴调整结果。
- 身份证号补全报告。
- 新房补结果和退休工资写回。

相关代码：

- `app/src/main/services/township-allowance/townshipAllowance.ts`
- `app/src/main/services/townshipHrSync.ts`
- `app/src/main/services/housing-subsidy/newHousingSubsidy.ts`

## 13. 人事管理和一致性检查

入口位置：

- 顶部模块“人事管理”。
- 一致性审计页面。

解决什么事：

- 维护人事信息、学历、资格、任教、履历、职级简历等数据。
- 对比不同来源中的关键字段是否一致。
- 将确认后的差异写回主数据或来源表。

数据来源：

- 人事信息表。
- 预算、工资、教师明细等来源表。

生成结果：

- 差异列表。
- 写回结果。

相关代码：

- `app/src/main/services/consistencyAudit.ts`
- `app/src/main/services/hrMasterSync.ts`
- `app/src/main/services/teacherDetailHrSync.ts`
- `app/src/main/services/rankResumeImport.ts`

## 14. 邮件附件下载

入口位置：

- 邮件附件下载页面。

解决什么事：

- 配置 IMAP 邮箱。
- 按规则扫描邮件附件并下载到本地目录。
- 记录下载日志和下载记录。

数据来源：

- 邮箱 IMAP。
- 邮件主题、附件扩展名、未读状态等规则。

生成结果：

- 本地附件文件。
- 下载记录。
- 下载日志。

关键业务规则：

- UI 应提示用户填写“授权码”，不要写“邮箱密码”。
- 邮箱授权码加密存储，不能明文展示。

相关代码：

- `app/src/renderer/src/components/MailAttachmentPage.vue`
- `app/src/main/services/mail/*`
- `app/src/main/ipc/mailApi.ts`

## 15. 备份、恢复和月结

入口位置：

- 设置或相关管理入口中的备份功能。
- 月度工资历史记录中的月结功能。

解决什么事：

- 备份 SQLite 数据库。
- 从备份恢复数据库。
- 月度工资报账完成后归档当月文件并锁定月份。

数据来源：

- 本地 SQLite 数据库。
- 月度工资报账生成文件。

生成结果：

- 备份 `.sqlite` 文件。
- 月结归档目录和清单。
- 需要时重启应用并恢复数据库。

关键业务规则：

- 备份前会执行 WAL checkpoint，避免只复制主库漏掉 WAL 中的数据。
- 恢复备份会覆盖当前数据库并重启程序。
- 月结前必须补齐社保文件。
- 月结后该月不能重新生成工资报账。

相关代码：

- `app/src/main/services/backup.ts`
- `app/src/main/services/monthly-payroll/monthlyPayrollRuns.ts`

## 16. 正式包和开发版差异

正式包要求：

- 不开放录制工具。
- 不提交构建产物。
- 不打包真实业务数据。
- 升级安装不得覆盖业务数据目录。

开发版可用：

- Vite 开发服务。
- 开发数据目录 `D:\laojiu\gzdata-dev`。
- 开发安装目录 `D:\laojiu\gzxt-dev`。

相关代码：

- `app/src/main/config/paths.ts`
- `app/package.json`
- `app/installer/installer.nsh`
