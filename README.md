# 工资系统

这是一个工资业务桌面应用项目，主体应用在 `app/` 目录中，使用 Electron、Vue 3、TypeScript 和 Element Plus 开发。

## 目录

- `app/`：桌面端应用源码和前端工程
- `docs/`：接口、表结构、工作流和字段说明文档
- `UI/`：早期界面原型和辅助脚本

## 本地开发

```bash
cd app
npm install
npm run dev
```

## 构建

```bash
cd app
npm run build
```

## 上传前注意

仓库已配置 `.gitignore`，会排除依赖、构建产物、日志、本地数据库、工资归档和 Excel 等业务数据文件。上传 GitHub 前请确认不要提交真实人员、工资、社保、个税等敏感数据。
