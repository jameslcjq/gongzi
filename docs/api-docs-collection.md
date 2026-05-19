# 明道云 API 开发文档采集

采集时间：2026-04-30

入口：

- `http://192.168.116.100:8880/worksheetapi/b38eea69-98e4-4e25-bc51-381d8246f3cd`

说明：页面包含应用授权密钥 AppKey/Sign。密钥属于敏感信息，本文不记录具体值，只记录授权方式和业务元数据。

## 页面结构

页面标题：`工资系统aAPI说明`

顶部栏目：

- 应用授权
- API V3
- API V2
- 分享

左侧栏目：

- 授权管理
- IP 白名单
- 工作表
- 聚合表

授权信息：

- 已存在 1 个授权密钥
- 授权类型：本应用全部接口
- 创建者：hujiuxi
- 创建时间：2025-09-22 11:42:56
- IP 白名单未设置时，所有 IP 来源都可发起请求

## 工作表清单

API 文档左侧展开后显示以下工作表：

- 一体化在职
- 一体化退休
- 一体化其他
- 局工资表
- 补发工资
- 预算在职
- 预算退休
- 其他人员
- 退休养老金
- 工资年报
- 绩效工资
- 乡镇补贴
- 岗位工资对照
- 薪级工资对照
- 乡镇工作年限对照
- 人员明细导出
- 人员待遇申领明细
- 新房补
- 职称信息表
- 姓名
- 绩效工资过渡表

## 一体化在职

工作表 ID：`68d1363b4b3cd60c8a8cc89b`

视图：

- `68d1363b4b3cd60c8a8cc8ba`：全部，表格

字段对照：

| 字段ID | 字段名称 | 类型 | 控件类型编号 | 说明 |
|---|---|---|---|---|
| 6652db461e574cbbbc9ace00 | 内设部门名称 | 文本框 | 2 | String 文本 |
| 6652db461e574cbbbc9ace01 | 月份 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace02 | 部门内序号 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace03 | 姓名 | 文本框 | 2 | String 文本 |
| 6652db461e574cbbbc9ace05 | 岗位工资 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace06 | 薪级工资 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace07 | 岗位津贴 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace08 | 生活补贴 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace09 | 绩效工资 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace0a | 工作性津贴 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace0b | 教（工）龄补贴 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace0c | 特岗性津补贴 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace0d | 交通费 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace0e | 公车补贴 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace0f | 住房补贴 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace10 | 基础绩效奖 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace11 | 补发工资 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace12 | 补扣工资 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace13 | 其他一 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace14 | 其他二 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace15 | 其他三 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace16 | 当月个人所得税 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace17 | 公积金 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace18 | 养老保险缴费 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace19 | 职业年金缴费 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace1a | 医疗保险 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace1b | 失业保险 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace1c | 支出一 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace1d | 支出二 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace1e | 支出三 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace1f | 代扣工资 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace20 | 代扣合计 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace21 | 实发合计 | 数值 | 6 | Double |
| 6652db461e574cbbbc9ace22 | 备注一 | 文本框 | 2 | String 文本 |
| 6652db461e574cbbbc9ace23 | 应发工资 | 数值 | 6 | Double |
| 6652de35677544ef3658518a | 证件号码 | 证件 | 7 | String 文本 |
| 670e3b3c391f693e985a0cbf | 单位编码 | 文本框 | 2 | String 文本 |
| 670e3b3c391f693e985a0cc0 | 单位名称 | 文本框 | 2 | String 文本 |
| 67a81cfa8d1d42d0db2efed1 | 工资类别编码 | 文本框 | 2 | String 文本 |
| 67a81cfa8d1d42d0db2efed2 | 工资类别名称 | 文本框 | 2 | String 文本 |
| 67a81d9a8d1d42d0db2efedb | 业务年度 | 数值 | 6 | Double |
| 67a81e1c8d1d42d0db2efee5 | 工资批次 | 文本框 | 2 | String 文本 |
| 67a81e2d8d1d42d0db2efee9 | 工资批次名称 | 文本框 | 2 | String 文本 |
| 67a81e5d8d1d42d0db2efeed | 内设部门编码 | 文本框 | 2 | String 文本 |
| 67a8201e8d1d42d0db2eff6a | 备注二 | 文本框 | 2 | String 文本 |
| 67a8201e8d1d42d0db2eff6b | 备注三 | 文本框 | 2 | String 文本 |
| 67a820898d1d42d0db2eff71 | 备注 | 文本框 | 2 | String 文本 |
| 67a820e88d1d42d0db2eff75 | 支出一备注 | 文本框 | 2 | String 文本 |
| 67a820e88d1d42d0db2eff76 | 支出二备注 | 文本框 | 2 | String 文本 |
| 67a820e88d1d42d0db2eff77 | 支出三备注 | 文本框 | 2 | String 文本 |

系统字段：

- `rowid`：记录ID
- `ownerid`：拥有者
- `caid`：创建人，只读
- `ctime`：创建时间，只读
- `utime`：最近修改时间，只读
- `uaid`：最近修改人，只读
- `wfname`：流程名称，只读
- `wfcuaids`：节点负责人，只读
- `wfcaid`：发起人，只读
- `wfctime`：发起时间，只读
- `wfrtime`：节点开始时间，只读
- `wfcotime`：审批完成时间，只读
- `wfdtime`：截止时间，只读
- `wfftime`：剩余时间，只读
- `wfstatus`：流程状态，只读

## SQLite 映射建议

明道云字段 ID 可作为迁移映射表保存，不建议直接作为业务列名。

建议新增字段映射表：

```sql
CREATE TABLE md_field_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worksheet_id TEXT NOT NULL,
  worksheet_name TEXT NOT NULL,
  field_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_type TEXT,
  control_type INTEGER,
  sqlite_column TEXT NOT NULL,
  sqlite_type TEXT NOT NULL,
  readonly INTEGER NOT NULL DEFAULT 0,
  UNIQUE (worksheet_id, field_id)
);
```

一体化在职主表可用蛇形命名，例如：

- `employee_name`
- `id_card_no`
- `org_code`
- `org_name`
- `post_salary`
- `grade_salary`
- `post_allowance`
- `living_allowance`
- `performance_salary`
- `payable_salary`
- `deduction_total`
- `net_salary`

