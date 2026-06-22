# 工资系统 Electron 开发说明

这是“工资系统a”的独立桌面版工程，当前首版范围以 `../docs/retained-worksheets.md` 中的 16 张保留工作表为准。

## 当前已完成

- Electron + Vue 3 + TypeScript + Element Plus 工程骨架
- 主进程 SQLite 初始化
- 自动执行 `../docs/sqlite-schema-retained.sql`
- 读取 `../docs/data/worksheets-retained.json`
- 渲染 16 张保留工作表概览
- 预留主要业务规则服务函数

## 本地开发命令

```bash
npm install
npm run dev
```

## 重要说明

- 目前不采集、不导入真实工资业务数据。
- 程序默认安装到 `D:\laojiu\gzxt`，业务数据固定保存到 `D:\laojiu\gzdata`，SQLite 数据库为 `D:\laojiu\gzdata\salary-system.sqlite`。
- 升级或重复安装只覆盖程序文件，不覆盖 `D:\laojiu\gzdata` 数据目录。
- `更新工资信息` 和工资年报的 `更新信息` 旧流程依赖已删除的“局工资表”，需要补充新取数规则后再开放。
- 一体化系统里的“开始录制/停止录制”用于采集页面操作与自动化样本，开发版和正式安装包均在一体化工具栏显示。
