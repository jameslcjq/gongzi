# 额度匹配离线仿真页（A2）

复刻一体化"工资发放/生成支付"额度匹配页面，用于**不连内网、不等发薪日**地回归额度匹配注入脚本。
数据与列结构取自 2026-06-09 真实页面诊断采集；行为复刻到"坏路径"级别。

## 用法

```powershell
# 在 app 目录下
node dev-fixtures/quota-match-mock/serve.mjs
# 浏览器打开
# http://localhost:4519/dev-fixtures/quota-match-mock/salSalaryAuditSCZF.html
```

页面自动加载 `dev-userscripts/02-额度匹配-离线测试.user.js`（油猴头是 // 注释，可直接当脚本引入），
并预置 localStorage 工资汇总（与工资单行精确匹配，前置总额校验可过）。

- 点右上角注入的 **「自动额度匹配」** → 应自动完成全部 6 笔挂接（基本工资拆 30107+30101、
  津贴505→人员经费兜底、住房103849→30102、退休费6800→30302、退休住房64000→30302）。
- 改完脚本源码后：`node scripts/generate-dev-userscripts.mjs` 重新生成 02，刷新页面再跑。
- 复位：刷新页面即可（数据在内存）。

## 复刻的关键行为（与真实页一致）

1. 点「修改」只切换按钮（修改↔保存），**不建行内编辑器**。
2. 页面自己的「点单元格」处理器才 beginEdit 并**装载部门经济分类 combotree**（显示名称）。
3. 外部直接 `datagrid('beginEdit')` 绕过初始化 → combotree 显示**裸 id（如 6）** →
   保存报「gov_bgt_eco_id 未定义」——2026-06 真实事故的复现器。
4. 保存校验：金额>0、≤额度余额、≤工资项未匹配金额；成功后指标占用、未匹配下降、调整金额清零。
5. 工资批次 combo（[001]工资）、额度匹配/生成支付确认弹窗（messager，位于 .window 内，
   可验证脚本"只点弹窗内确定"的逻辑）。

## 文件

- `salSalaryAuditSCZF.html` — 页面（文件名故意含 salSalaryAuditSCZF 以满足脚本 URL 识别）
- `mock.js` — 数据 + 行为
- `serve.mjs` — 静态服务器（站点根=app 目录，端口 4519）
- 依赖 `node_modules/jquery-easyui`（devDependency，自带配套 jquery）

## 边界

- 仿真页验证的是**脚本逻辑与 DOM 交互**；Electron webview 注入链路（installPortalAutomationScripts）
  不在覆盖范围（按 2026-06-11 决策，演练模式不打包进主程序）。
- 真实页面的服务端校验、批次切换、多单位等场景未仿真。
