# 工资系统独立版开发方案

> 历史文档（建项初版方案，阶段 1-5 已基本完成）。当前有效的开发计划见 [development-plan-2026H2.md](development-plan-2026H2.md)。

目标：脱离明道云，用独立 Electron 桌面程序重建“工资系统a”。首版不采集真实业务数据，先完成结构、页面、规则和本地数据库能力。

当前开发范围以 API 文档中仍保留的 16 张工作表为准，详见 `docs/retained-worksheets.md`。已删除表只作为旧流程改写线索，不进入首版页面和数据库。

## 技术选型

| 层 | 方案 | 说明 |
|---|---|---|
| 桌面壳 | Electron | 单机运行、部署简单、可离线使用 |
| 前端 | Vue 3 + TypeScript + Element Plus | 表格、表单、弹窗、日期、导入导出组件成熟 |
| 构建 | Vite + electron-vite | Electron + Vue 开发体验好 |
| 数据库 | SQLite | 本地文件数据库，适合几百到几千条工资数据 |
| SQLite 驱动 | better-sqlite3 | 同步 API 简单稳定，适合 Electron 主进程 |
| 数据访问 | Kysely 或轻量 Repository | 保持 SQL 可控，避免过重 ORM |
| 导入导出 | xlsx | 后续支持 Excel 导入、导出、模板下载 |

推荐架构：Electron 主进程负责数据库和业务服务，Vue 渲染进程只做界面。前端通过 preload 暴露的 typed IPC 调用服务，不直接访问 SQLite。

## 目录结构建议

```text
app/
  electron.vite.config.ts
  package.json
  src/
    main/
      index.ts
      db/
        connection.ts
        migrations/
        repositories/
      services/
        salary/
        budget/
        annual-report/
        township-allowance/
        performance/
        housing-subsidy/
      ipc/
      backup/
    preload/
      index.ts
    renderer/
      src/
        main.ts
        App.vue
        router/
        layouts/
        pages/
        components/
        api/
        stores/
        types/
```

## 数据库设计

已有保留版草案：`docs/sqlite-schema-retained.sql`。

首版建议分两层处理：

1. 原始迁移层：保留明道云字段结构，字段 ID、worksheetId、原字段名全部可追溯。
2. 业务访问层：代码里通过 Repository 暴露清晰方法，不让页面直接拼 SQL。

可先沿用当前保留的 16 张表，避免早期重命名造成字段遗漏。后续稳定后，再把核心表整理成英文内部表名，并保留字段映射表。

建议增加系统表：

| 表 | 用途 |
|---|---|
| `app_settings` | 系统参数、当前年度、单位信息 |
| `operation_logs` | 本地操作日志 |
| `import_batches` | Excel/API 导入批次 |
| `workflow_runs` | 规则执行记录 |
| `field_mappings` | 明道云字段到本地字段的映射 |

## 功能模块

### 1. 基础资料

- 一体化在职
- 一体化退休
- 一体化其他

### 2. 预算管理

- 预算在职
- 预算退休
- 其他人员
- 退休养老金

### 3. 工资年报

- 工资年报列表
- 从一体化在职生成年报
- 更新绩效工资
- 更新岗位工资、薪级工资
- 更新乡镇工作年限

### 4. 津补贴

- 乡镇补贴

### 5. 对照表

- 岗位工资对照
- 薪级工资对照
- 乡镇工作年限对照

### 6. 新房补核定

- 人员明细导出
- 人员待遇申领明细
- 新房补

### 7. 导入导出

- Excel 导入
- Excel 导出
- 导入预览
- 错误行提示
- 导入批次回滚

## 工作流复刻策略

不建议复刻明道云的通用工作流编辑器。当前系统流程数量不多，首版直接写成明确的业务服务函数，便于测试和维护。

已启用流程对应服务函数：

| 明道云流程 | 独立版函数 |
|---|---|
| 生成工资年报 | `generateAnnualSalaryReport()` |
| 核对预算人员 | `verifyBudgetActiveEmployee()` |
| 更新在职信息 | `onBudgetActiveCreated()` |
| 更新薪级 | `updateSalaryGrade()` |
| 增加薪级 | `increaseSalaryGrade()` |
| 计算基础性绩效工资 | `calculateBudgetActiveBaseSalary()` |
| 更新绩效工资 | `updateAnnualReportPerformanceSalary()` |
| 改乡镇工作年限 | `updateTownshipYearsForAnnualReport()` |
| 调整乡镇补贴 | `onTownshipAllowanceChanged()` |
| 增加1年 | `increaseTownshipYears()` |

每个函数统一返回：

```ts
type RuleResult = {
  ok: boolean
  affectedRows: number
  messages: string[]
  warnings: string[]
}
```

## 已知规则先固化

- 基本工资 = 岗位工资 + 薪级工资
- 基础性绩效工资 = 岗位津贴 + 生活补贴
- 增加薪级：新薪级 = 当前薪级 + 2，再查薪级工资对照
- 工作年限 = 当前年份 - 1 - 参加工作时间年份
- 乡镇补贴按乡镇工作年限分段：0-4、5-9、10-14、15-19、20-24、25-29、30-34、35-39、40+

待人工补充：

- 每个查询节点的匹配条件
- 每个更新节点的目标字段
- 乡镇补贴各年限段金额
- 工资年报新增时 28 个字段的完整映射
- 原 JavaScript 节点源码或等价规则
- 原来依赖“职称信息表”的逻辑是否保留，以及改查哪张表

## 页面设计

首屏直接进入系统，不做登录页或宣传页。

推荐布局：

- 左侧导航：按业务分组展示工作表
- 顶部工具栏：年度、搜索、导入、导出、备份
- 中间主区域：表格列表
- 右侧/弹窗：新增、编辑、批量操作、规则执行结果

通用表格能力：

- 分页
- 排序
- 筛选
- 快速搜索
- 列显示配置
- 批量选择
- 批量导出
- 行内操作按钮

关键按钮：

- 生成工资年报
- 核对预算人员
- 更新薪级
- 增加薪级
- 更新绩效工资
- 改乡镇工作年限
- 调整乡镇补贴
- 增加工龄乡镇

## 开发阶段

### 第 1 阶段：项目骨架

- 初始化 Electron + Vue 3 + TypeScript
- 接入 Element Plus
- 建立主进程、preload、renderer 通信
- 接入 SQLite
- 建立迁移机制
- 执行 `sqlite-schema-retained.sql`

交付物：能打开桌面程序，能进入主界面，能创建本地数据库。

### 第 2 阶段：通用工作表界面

- 根据 `worksheets-retained.json` 渲染 16 张表
- 实现列表、详情、新增、编辑、删除
- 支持字段类型显示：文本、数值、日期、选项、关联记录
- 支持基础筛选和搜索

交付物：不用写 16 套页面，先用元数据驱动出通用表格。

### 第 3 阶段：核心业务规则

优先实现：

1. 预算在职：基本工资、基础性绩效工资、薪级更新
2. 一体化在职：生成工资年报、核对预算人员
3. 工资年报：生成、更新绩效工资、更新乡镇工作年限
4. 乡镇补贴：年限分段、同步在职/退休
5. 绩效工资：按保留表同步身份证等必要字段

交付物：核心按钮能跑，执行结果可追踪。

### 第 4 阶段：导入导出

- Excel 模板导出
- Excel 数据导入预览
- 字段匹配
- 错误行报告
- 导入批次记录
- 导出工资表、年报、预算表

交付物：能替代日常 Excel 流转。

### 第 5 阶段：稳定性和交付

- 自动备份 SQLite
- 手动备份/恢复
- 操作日志
- 打包 Windows 安装包
- 冒烟测试清单

交付物：可安装、可备份、可恢复的内部桌面软件。

## 测试方案

业务数据暂不采集时，用脱敏样例数据构造测试：

- 1 条在职人员
- 1 条退休人员
- 1 条其他人员
- 岗位工资对照样例
- 薪级工资对照样例
- 乡镇补贴分段样例

测试重点：

- 金额计算是否准确
- 跨表查询是否匹配正确
- 无匹配数据时是否给出提示
- 批量执行是否可回滚
- 导入失败是否不污染原数据

## 推荐开工顺序

1. 建 Electron 项目骨架。
2. 把 `worksheets-retained.json` 作为元数据源，做通用表格。
3. 接 SQLite，先跑通 16 张保留表建表。
4. 做一体化在职、预算在职、工资年报三个核心页面。
5. 把启用工作流逐个转成服务函数。
6. 你补充缺失业务逻辑，我把它们写进规则函数和测试。
