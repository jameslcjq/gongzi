# 工资系统可行性方案：外网处理、外网打印、内网执行一体化

更新时间：2026-06-06

本文用于确定工资系统在内外网隔离环境下的最终推荐工作模式。结论是：只做“模式一”，即外网完成资料采集、工资报账处理和报表打印，内网只负责接收业务结果包并执行一体化对接、导入、推送和额度匹配。

## 1. 结论

推荐且只实现以下模式：

```text
外网处理端：
收邮件 / 下载工资表、社保表、个税表 / 月度工资报账处理 / 打印报表 / 生成内网业务结果包

内网执行端：
接收业务结果包 / 校验 / 更新本地业务数据 / 执行一体化导入、保险推送、凭证推送、额度匹配 / 生成执行回执
```

不实现“内网处理后再回外网打印”的备用模式。原因是该模式摆渡次数更多、链路更长、用户操作更复杂、出错点更多，不适合作为当前产品主流程。

## 2. 业务背景

实际使用环境中可能存在以下网络边界：

```text
外网可用能力：
- 邮箱访问
- 工资表下载或接收
- 社保表下载或接收
- 个税表下载或接收
- 报表打印环境

内网可用能力：
- 一体化系统访问
- 工资导入
- 补发工资导入
- 保险推送
- 凭证推送
- 额度匹配
- 计划录入
- 页面脚本执行
```

因此最稳定的职责划分是：

```text
外网负责采集、计算、打印、封包。
内网负责验包、入库、推送、回执。
```

## 3. 为什么只做模式一

### 3.1 摆渡次数最少

模式一的主流程只需要一次关键摆渡：

```text
外网业务结果包 -> 内网
```

内网执行后可以选择生成回执包再摆渡回外网归档，但该动作不影响当月业务继续执行。

如果采用“内网处理、外网打印”模式，则至少需要：

```text
外网原始资料包 -> 内网
内网打印包 -> 外网
必要时外网确认结果 -> 内网
```

摆渡次数越多，越容易出现拿错包、漏传包、重复包、旧包覆盖新包、文件未复制完整等问题。

### 3.2 外网依赖留在外网，内网依赖留在内网

工资表、社保表、个税表和打印环境都依赖外网；一体化导入、推送和额度匹配依赖内网。模式一刚好按照网络能力切分，不强迫任何一端承担不具备的能力。

### 3.3 计算结果和打印结果同源

外网端完成工资报账后，立即生成报表和业务结果包。这样报表、导入文件、校验结果和源文件摘要来自同一次处理，便于追溯。

### 3.4 内网端更简单

内网端不需要处理邮箱、外网下载源、打印机、打印模板等外网相关能力，只专注于一体化系统相关动作，部署和维护更稳定。

### 3.5 售后排查边界清晰

模式一的故障边界：

```text
外网阶段：收邮件、下载附件、工资报账、打印、生成业务包
摆渡阶段：包是否完整、是否拿错单位或月份
内网阶段：验包、入库、一体化导入、保险推送、凭证推送、额度匹配
```

每个阶段职责清楚，日志和错误提示可以按阶段定位。

## 4. 总体架构

```text
外网处理端
  ├─ 自动检测邮箱
  ├─ 下载工资表、社保表、个税表到 D:\laojiu\工资导入
  ├─ 月度工资报账处理
  ├─ 生成或打印报表
  ├─ 生成内网业务结果包 .ljgzpkg
  └─ 写入虚拟 U 盘或摆渡目录

虚拟 U 盘 / 摆渡系统
  └─ 传递 .ljgzpkg

内网执行端
  ├─ 扫描虚拟 U 盘或摆渡目录
  ├─ 复制业务结果包到本机固定 inbox
  ├─ 校验签名、哈希、单位、月份、版本
  ├─ 导入业务数据
  ├─ 标记报账记录为待推送
  ├─ 执行一体化导入、保险推送、凭证推送、额度匹配
  └─ 生成执行回执 .ljgzreceipt
```

## 5. 固定目录设计

继续沿用老九系列软件统一目录：

```text
D:\laojiu\gzxt                         工资系统安装目录
D:\laojiu\gzdata                      工资系统正式数据目录
D:\laojiu\工资导入                     外网工资表、社保表、个税表导入目录
D:\laojiu\gzdata\工资数据              输出目录
D:\laojiu\交换包\工资系统\inbox        内网本机待导入业务包
D:\laojiu\交换包\工资系统\imported     已导入业务包
D:\laojiu\交换包\工资系统\failed       导入失败业务包
D:\laojiu\交换包\工资系统\quarantine   校验失败隔离区
D:\laojiu\交换包\工资系统\outbox       内网回执包输出目录
D:\laojiu\交换包\工资系统\temp         解包临时目录
```

虚拟 U 盘盘符不固定，因此不依赖盘符。外网端写入摆渡介质时创建统一结构：

```text
X:\老九交换包\laojiu-exchange.json
X:\老九交换包\工资系统\outbox\*.ljgzpkg
X:\老九交换包\工资系统\receipt\*.ljgzreceipt
```

其中 `X:` 可以是任意盘符。

## 6. 交换包类型

### 6.1 月度业务结果包

扩展名：

```text
.ljgzpkg
```

用途：外网处理完成后传给内网。

内容：

```text
manifest.json                  包清单
checksums.json                 文件 SHA256 清单
signature.sig                  签名文件
payload/monthly-payroll-run.json
payload/worksheet-patches.json
payload/import-plan.json
payload/source-summary.json
payload/validation-report.json
files/insurance-import.xlsx
files/voucher-import.xlsx
files/salary-import.xlsx
files/backpay-import.xlsx
files/reports/*.pdf
logs/generate.log
logs/warnings.json
```

### 6.2 执行回执包

扩展名：

```text
.ljgzreceipt
```

用途：内网执行一体化动作后生成，供外网归档和售后排查。

内容：

```text
原始 packageId
导入时间
导入机器
导入用户
一体化推送状态
保险推送状态
凭证推送状态
工资导入状态
补发工资导入状态
额度匹配状态
错误日志
一体化返回摘要
```

## 7. manifest.json 建议结构

```json
{
  "format": "laojiu.payroll.exchange-package",
  "version": 1,
  "packageId": "019070-2026-06-001",
  "appName": "老九的工资系统",
  "appVersion": "0.9.0",
  "createdAt": "2026-06-06T10:30:00+08:00",
  "createdByMode": "outer-network",
  "businessType": "monthly-payroll",
  "unit": {
    "unitFullName": "测试学校",
    "unitImportCode": "019070"
  },
  "period": {
    "year": 2026,
    "month": 6
  },
  "contains": {
    "monthlyPayrollRun": true,
    "worksheetPatches": true,
    "insuranceImport": true,
    "voucherImport": true,
    "salaryImport": true,
    "backpayImport": true,
    "printReports": true
  },
  "sourceFiles": [
    {
      "kind": "salaryWorkbook",
      "originalName": "2026年6月工资表.xlsx",
      "sha256": "..."
    },
    {
      "kind": "socialSecurityWorkbook",
      "originalName": "社保费未申报汇总信息.xlsx",
      "sha256": "..."
    },
    {
      "kind": "taxWorkbook",
      "originalName": "税款计算_工资薪金所得.xlsx",
      "sha256": "..."
    }
  ]
}
```

## 8. 外网处理端流程

```text
1. 打开软件。
2. 自动创建固定目录。
3. 自动检测邮箱。
4. 按规则下载工资表、社保表、个税表到 D:\laojiu\工资导入。
5. 用户进入工资报账。
6. 系统识别工资表、社保表、个税表。
7. 执行月度工资报账处理。
8. 生成报表、保险导入、凭证导入、工资导入、补发导入文件。
9. 打印或生成 PDF 报表。
10. 点击“生成内网业务结果包”。
11. 选择虚拟 U 盘或摆渡目录。
12. 系统自动写入 老九交换包\工资系统\outbox。
```

外网端不直接访问内网一体化系统。

## 9. 内网执行端流程

```text
1. 打开软件。
2. 自动创建 D:\laojiu\交换包\工资系统 下的 inbox、imported、failed、quarantine、outbox、temp。
3. 扫描本机 inbox。
4. 扫描所有盘符下的 老九交换包 标记目录。
5. 发现 .ljgzpkg 后等待文件稳定。
6. 将包复制到本机 inbox。
7. 校验 ZIP 结构、manifest、checksums、signature。
8. 校验单位编码、单位名称、年月、业务类型、App 数据格式版本。
9. 显示导入预览。
10. 用户确认导入。
11. 自动备份当前数据库。
12. 开启数据库事务。
13. 写入业务数据和报账历史。
14. 标记本月报账记录为待推送。
15. 提交事务。
16. 用户进入一体化对接。
17. 执行保险推送、凭证推送、工资导入、补发工资导入、额度匹配。
18. 生成执行回执包。
```

内网端不重新计算工资报账，不重新生成打印报表，只执行内网一体化相关动作。

## 10. 虚拟 U 盘盘符不固定的处理

程序不记录盘符，不依赖 `E:\`、`F:\` 等固定路径。

内网端启动后扫描：

```text
D:\ 到 Z:\
```

只检查浅层固定路径：

```text
X:\老九交换包\laojiu-exchange.json
X:\老九交换包\工资系统\outbox\*.ljgzpkg
X:\LaoJiuExchange\gongzi\outbox\*.ljgzpkg
X:\*.ljgzpkg
```

原则：

- 不递归扫描整盘。
- 不从 U 盘直接入库。
- 先复制到本机固定 inbox。
- 等文件稳定后再复制。
- 复制完成后重新计算 SHA256。

## 11. 校验与安全策略

导入前必须通过：

```text
ZIP 结构校验
路径穿越校验
禁止可执行文件
manifest 格式校验
format/version 校验
单位编码校验
年月校验
packageId 去重校验
checksums 哈希校验
signature 签名校验
App 版本兼容校验
业务数据预览校验
```

交换包中禁止包含：

```text
.exe
.bat
.cmd
.ps1
.js
.vbs
.msi
.scr
.com
```

一体化脚本不得来自交换包。交换包只携带数据，内网端只能执行软件内置脚本。

## 12. 重复包和覆盖规则

导入粒度：

```text
单位编码 + 年 + 月 + 业务类型 + packageId
```

规则：

```text
packageId 已导入：跳过，不重复导入。
同单位同月份已有未推送记录：允许用户确认后导入新包，旧记录标记过期。
同单位同月份已有已推送记录：禁止自动覆盖，必须用户二次确认。
单位编码不一致：禁止导入。
月份不一致或非当前处理月份：提示风险。
签名或哈希失败：禁止导入，移动到 quarantine。
```

## 13. 基础数据同步问题

模式一的前提是外网端拥有足够新的基础数据，例如：

```text
在职工资
退休工资
其他工资
人事信息
单位设置
工资报账设置
字段映射
```

如果基础数据以内网为准，需要另行设计“基础数据同步包”：

```text
内网导出基础数据包 -> 外网导入基础数据包 -> 外网处理本月工资报账
```

第一阶段可以先人工保持两端基础数据一致；第二阶段再补基础数据同步包。

## 14. 建议新增模块

```text
app/src/main/services/exchange/
  packageTypes.ts
  packageManifest.ts
  packageBuilder.ts
  packageValidator.ts
  packageImporter.ts
  packageWatcher.ts
  packageMediaScanner.ts
  packageReceipt.ts
  packageCrypto.ts
```

建议新增 IPC：

```text
exchange:get-status
exchange:scan-media
exchange:open-inbox
exchange:open-outbox
exchange:build-monthly-package
exchange:preview-package
exchange:import-package
exchange:list-packages
exchange:create-receipt
exchange:copy-receipt-to-media
```

建议新增前端页面：

```text
内外网交换
  ├─ 当前模式：外网处理端 / 内网执行端
  ├─ 发现的交换包
  ├─ 导入预览
  ├─ 导入历史
  ├─ 回执包
  └─ 摆渡介质状态
```

## 15. 数据库表建议

```sql
CREATE TABLE exchange_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id TEXT NOT NULL UNIQUE,
  package_sha256 TEXT NOT NULL,
  unit_code TEXT NOT NULL,
  unit_name TEXT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  business_type TEXT NOT NULL,
  package_version INTEGER NOT NULL,
  app_version TEXT,
  source_network_mode TEXT,
  status TEXT NOT NULL,
  source_path TEXT,
  local_path TEXT,
  manifest_json TEXT,
  checksum_json TEXT,
  imported_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  error_message TEXT
);
```

可以后续补充：

```text
exchange_package_files
exchange_import_logs
exchange_receipts
```

## 16. 第一阶段实施范围

第一阶段建议只做最小闭环：

```text
1. 外网生成 .ljgzpkg。
2. 内网手动选择或自动发现 .ljgzpkg。
3. 内网校验 manifest 和 checksums。
4. 内网导入业务结果。
5. 内网进入一体化对接执行。
6. 内网生成简单回执。
```

第一阶段可以暂缓：

```text
加密包
完整签名体系
自动基础数据同步包
自动上传回执
多单位批量包
```

但第一阶段必须有：

```text
packageId
单位校验
月份校验
哈希校验
重复导入校验
导入前备份
失败回滚
```

## 17. 验收标准

### 外网端

- 自动收邮件。
- 附件落到固定导入目录。
- 工资报账可正常生成。
- 报表可打印或生成 PDF。
- 能生成 `.ljgzpkg`。
- 业务包中包含 manifest、checksums、必要导入文件和报表快照。
- 能写入盘符不固定的虚拟 U 盘标准目录。

### 内网端

- 能扫描虚拟 U 盘标准目录。
- 不依赖固定盘符。
- 能把包复制到本机 inbox。
- 能校验单位、年月、哈希、packageId。
- 能阻止重复导入。
- 能导入后生成待推送记录。
- 能继续执行一体化导入、推送、额度匹配。
- 能生成回执包。

## 18. 回归测试清单

```text
外网下载工资表、社保表、个税表。
外网完成月度工资报账。
外网生成 .ljgzpkg。
虚拟 U 盘盘符变化后内网仍能发现包。
半复制文件不会被导入。
拿错单位包会被拦截。
拿错月份包会提示风险。
重复 packageId 不会重复导入。
哈希错误包进入 quarantine。
导入失败能回滚数据库。
导入成功后可进入一体化执行。
一体化执行后能生成回执。
```

## 19. 最终产品定位

面向内外网隔离单位，工资系统的推荐模式固定为：

```text
外网端：负责工资资料采集、工资报账处理、报表打印和业务结果封包。
内网端：负责业务结果验包、入库、一体化执行和回执归档。
```

这条路线最符合当前业务依赖，摆渡次数少，用户步骤少，出错边界清晰，后续也便于扩展签名、加密、回执和基础数据同步能力。
