# SQLite 保留版结构索引

当前首版开发以 `docs/sqlite-schema-retained.sql` 为准，只包含 API 文档里仍保留的 16 张工作表。

## 保留表

| 序号 | 表名 | worksheetId |
|---:|---|---|
| 1 | 一体化在职 | `68d1363b4b3cd60c8a8cc89b` |
| 2 | 一体化退休 | `68d1363b4b3cd60c8a8cc89d` |
| 3 | 一体化其他 | `68d38e10a70778463f3eb9a8` |
| 4 | 预算在职 | `68d1363b4b3cd60c8a8cc89e` |
| 5 | 预算退休 | `68d1363b4b3cd60c8a8cc89c` |
| 6 | 其他人员 | `68d34fe93723d04420e7994a` |
| 7 | 退休养老金 | `68d3a0cb3723d04420e7998b` |
| 8 | 工资年报 | `68d1363b4b3cd60c8a8cc8a3` |
| 9 | 绩效工资 | `68d1363b4b3cd60c8a8cc895` |
| 10 | 乡镇补贴 | `68d1363b4b3cd60c8a8cc8a0` |
| 11 | 岗位工资对照 | `68d1363b4b3cd60c8a8cc8a1` |
| 12 | 薪级工资对照 | `68d1363b4b3cd60c8a8cc8a2` |
| 13 | 乡镇工作年限对照 | `68d1363b4b3cd60c8a8cc894` |
| 14 | 人员明细导出 | `68d1363b4b3cd60c8a8cc89a` |
| 15 | 人员待遇申领明细 | `68d1363b4b3cd60c8a8cc899` |
| 16 | 新房补 | `68d1363b4b3cd60c8a8cc898` |

## 使用说明

- 建库文件：`docs/sqlite-schema-retained.sql`
- 字段清单：`docs/worksheet-fields-retained.md`
- 元数据源：`docs/data/worksheets-retained.json`
- 已验证：`sqlite-schema-retained.sql` 可在 SQLite 内存库中成功创建 16 张业务表。

