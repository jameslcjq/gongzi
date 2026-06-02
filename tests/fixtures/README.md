# 脱敏回归样例

这些文件用于人工回归和未来自动测试。样例全部为虚构数据，不来自真实工资表、真实人员信息或真实身份证号。

## 使用原则

- 不把真实 Excel、真实数据库、真实导出文件提交到仓库。
- 样例人员统一使用 `教师A001`、`退休A001`、`遗补A001` 这类名称。
- 证件号、手机号、银行账号、工资金额均为测试值。
- 当前样例先用 JSON 表达输入和预期结果，后续可以用脚本生成 Excel 样例。
- 月度工资代码目前只允许处理当月。跑月度样例时，如果样例期间不是当前年月，需要先把样例期间替换为当前年月，或以后补测试专用时间注入。

## 样例目录

```text
tests/fixtures/
  monthly-payroll/basic-integrated/
    input.json
    expected.json
  performance-payroll/two-period-change/
    input.json
    expected.json
  integration-push/insurance-voucher-queue/
    input.json
    expected.json
  annual-adjustment/basic/
    input.json
    expected.json
```

## 第一轮人工回归重点

- 月度工资：人数、应发、实发、个税、五险一金、附件页数、社保缺失限制。
- 绩效工资：同证件号匹配、变化人员、新进、调出。
- 一体化推送：单位前置检查、保险和凭证串行、失败停止。
- 年初调整：社保比例映射、可自动写回和人工判断分流。
