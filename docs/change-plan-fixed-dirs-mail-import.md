# 工资系统修改方案：固定目录、邮件自动下载与报账闭环

更新时间：2026-06-06

本文用于记录工资系统下一阶段修改范围。目标不是把目录做成可配置，而是把“老九系列软件固定目录规范”落实到代码和安装包中，并保证打开软件后自动检测邮箱、自动下载附件到统一导入目录，用户可以直接进入工资报账流程。

同时，内外网隔离场景下的交换包能力也必须遵守同一套固定目录规范：外网端生成业务结果包后自动输出到摆渡目录；内网端取回交换包后先复制到本机固定 inbox，再校验和导入。

## 1. 产品目录策略

老九系列软件统一使用 `D:\laojiu` 作为品牌根目录。工资系统采用以下固定目录：

```text
D:\laojiu\gzxt                         工资系统安装目录
D:\laojiu\gzdata                      工资系统正式数据目录
D:\laojiu\gzdata-dev                  开发数据目录
D:\laojiu\工资导入                     工资表、社保表、个税表等统一导入目录
D:\laojiu\gzdata\工资数据              工资系统输出目录
D:\laojiu\交换包\工资系统\inbox        内网本机待导入业务包
D:\laojiu\交换包\工资系统\imported     已导入业务包
D:\laojiu\交换包\工资系统\failed       导入失败业务包
D:\laojiu\交换包\工资系统\quarantine   校验失败隔离区
D:\laojiu\交换包\工资系统\outbox       本机交换包和回执包输出目录
D:\laojiu\交换包\工资系统\temp         解包临时目录
```

目录策略说明：

- 这些目录不是用户偏好设置，而是产品规范。
- 代码中不得在多个业务模块重复手写路径。
- 所有模块应引用 `app/src/main/config/paths.ts` 中的统一常量。
- 安装包、启动初始化、邮件附件下载、Excel 自动监听、一体化下载拦截、交换包收发必须使用同一套路径。
- 摆渡盘盘符不固定，不能记录为业务依据；应通过 `laojiu-exchange.json` 和 `mediaId` 找回介质。

## 2. 当前需要调整的问题

### 2.1 邮件下载目录需要统一引用路径常量

当前邮件下载逻辑功能上已经保存到 `D:\laojiu\工资导入`，但代码中直接手写路径。建议改为引用：

```ts
import { importFolder } from '../../config/paths'

const downloadDir = importFolder
```

这样仍然固定落到 `D:\laojiu\工资导入`，但维护时只需要改一个地方。

### 2.2 邮件附件应保留原始文件名

当前附件保存文件名包含“发件人_主题_原附件名”。工资报账识别社保、个税、工资表时依赖文件名规则，特别是社保文件要求以“社保费未申报汇总信息”开头。改名会导致自动识别失败。

建议：

```ts
const desiredName = safeName
```

保留原附件名。重名时继续使用现有 `resolveConflict()` 追加 `_2`、`_3`。

### 2.3 取消“选择导入目录”能力

如果产品定位是统一固定目录，就不应允许用户把 Excel 自动导入目录改到其他位置。

建议：

- UI 中“选择导入目录”改为“打开导入目录”。
- `excelImportWatcher` 始终监听 `importFolder`。
- 忽略或清理历史保存的 `excel_import_folder` 设置。
- `getCachedImportFolder()` 固定返回 `importFolder`。

### 2.4 安装包不允许用户修改安装目录

`installer.nsh` 已经写入 `D:\laojiu\gzxt`，但 `package.json` 里 NSIS 配置仍允许用户修改安装目录。

建议：

```json
"allowToChangeInstallationDirectory": false
```

这样安装策略与品牌目录规范一致。

### 2.5 固定目录中补充交换包目录

安装包和启动初始化应额外创建交换包目录：

```text
D:\laojiu\交换包\工资系统\inbox
D:\laojiu\交换包\工资系统\imported
D:\laojiu\交换包\工资系统\failed
D:\laojiu\交换包\工资系统\quarantine
D:\laojiu\交换包\工资系统\outbox
D:\laojiu\交换包\工资系统\temp
```

交换包目录用于内外网隔离业务，不与普通 Excel 导入目录混用。

## 3. 启动后自动收邮件的业务闭环

目标流程：

```text
打开软件
  ↓
创建固定目录
  ↓
启动 Excel 导入监听 D:\laojiu\工资导入
  ↓
启动后自动检测邮箱
  ↓
匹配规则的 Excel 附件自动保存到 D:\laojiu\工资导入
  ↓
工资报账页面识别工资表、社保表、个税表
  ↓
用户直接进行下一步工资报账
```

注意事项：

- 邮件附件下载只处理允许的扩展名，如 `.xls`、`.xlsx`、`.csv`、`.pdf` 等。
- 危险扩展名继续禁止，如 `.exe`、`.bat`、`.cmd`、`.ps1` 等。
- 附件下载应有去重记录，避免同一邮件重复下载。
- 邮件下载后保留原始文件名，确保工资报账识别逻辑稳定。

## 4. 交换包收发与固定目录闭环

交换包流程按 `docs/feasibility-outer-process-inner-integration.md` 执行。固定目录文档中只记录和目录有关的强约束。

### 4.1 外网端自动输出

外网端第一次生成业务结果包时选择虚拟 U 盘或摆渡目录，程序自动创建：

```text
X:\老九交换包\laojiu-exchange.json
X:\老九交换包\工资系统\outbox
```

本机保存：

```text
exchange_outer_media_id
exchange_outer_last_outbox
exchange_outer_auto_copy
```

后续处理完成后自动生成 `.ljgzpkg`，并复制到已记住的摆渡目录。如果盘符变化，扫描 `D:` 到 `Z:` 查找相同 `mediaId` 的 `laojiu-exchange.json`。

如果摆渡盘不在线，包保存到：

```text
D:\laojiu\交换包\工资系统\outbox
```

并提示用户稍后复制。

### 4.2 内网端自动取回

内网端不从 U 盘直接入库。流程为：

```text
虚拟 U 盘 / 摆渡目录
  ↓
等待文件稳定
  ↓
复制到 D:\laojiu\交换包\工资系统\inbox\.incoming\*.tmp
  ↓
复制完成并校验 SHA256
  ↓
重命名为 D:\laojiu\交换包\工资系统\inbox\*.ljgzpkg
  ↓
校验并提示用户导入
```

第一版不做独立托盘常驻程序。主程序启动时自动扫描，运行中轻量扫描，界面提供“扫描摆渡盘”按钮。

### 4.3 月结位置

外网端不做真正月结，只做：

```text
报账已生成
报表已打印
交换包已生成
已复制到摆渡目录
等待内网回执
```

真正月结放在内网端，在一体化导入、保险推送、凭证推送、工资导入、补发导入、额度匹配完成后执行。内网月结后生成 `.ljgzreceipt` 回执包，外网收到回执后显示“内网已月结 / 归档完成”。

## 5. 安全和稳定性加固

### 5.1 邮件 IPC 接入授权门禁

邮件功能涉及邮箱授权码、附件下载和业务数据，应当和其他业务 IPC 一样走授权检查。建议 `mailApi.ts` 接入统一授权拦截，未授权时不允许执行邮件账号保存、邮件检测、附件下载等业务能力。

### 5.2 接受本地路径的 IPC 加白名单

所有接受 `filePath` 的 IPC 应限制在以下目录：

```text
D:\laojiu\工资导入
D:\laojiu\gzdata
D:\laojiu\gzdata\工资数据
D:\laojiu\gzdata\temp
D:\laojiu\交换包\工资系统
```

并且增加：

- 扩展名限制。
- 文件大小限制。
- `realpath` 规范化，防止路径穿越。
- 禁止读取可执行文件。

### 5.3 一体化脚本执行接口收口

一体化自动化需要脚本能力，但不建议 IPC 接收任意 JS 字符串。建议改为脚本注册表模式：

```text
scriptName + params
```

主进程只允许执行内置脚本，不允许交换包或渲染进程随意传入可执行代码。

### 5.4 邮箱授权码加密回退调整

如果 Electron `safeStorage` 不可用，不建议回退到硬编码 key 的 XOR 保存。建议：

- safeStorage 不可用时只允许本次会话使用；或
- 明确提示当前系统无法安全保存邮箱授权码；或
- 后续 safeStorage 可用时自动迁移。

### 5.5 本地登录不作为安全边界

前端固定账号密码只能作为防误操作入口。真正的安全边界必须在主进程，包括授权校验、IPC 权限、路径白名单和文件校验。

## 6. 建议修改文件清单

```text
app/src/main/config/paths.ts
app/src/main/services/mail/mailImapService.ts
app/src/main/services/mail/attachmentDownloadService.ts
app/src/main/services/excelImportWatcher.ts
app/src/main/services/exchange/*
app/src/main/ipc/mailApi.ts
app/src/main/ipc/appApi.ts
app/package.json
app/installer/installer.nsh
docs/feature-guide.md
docs/maintenance-guide.md
docs/feasibility-outer-process-inner-integration.md
```

## 7. 验收标准

- 首次启动后自动创建 `D:\laojiu\工资导入`、`imported`、`failed`、`templates`。
- 首次启动后自动创建 `D:\laojiu\交换包\工资系统` 下的 inbox、imported、failed、quarantine、outbox、temp。
- 邮件自动检测可在启动后执行。
- 邮件附件保存到 `D:\laojiu\工资导入`。
- 附件保留原始文件名。
- 工资报账页面能识别工资表、社保表、个税表。
- 用户不能把导入目录改到其他位置。
- 安装包默认并固定安装到 `D:\laojiu\gzxt`。
- 外网第一次选择摆渡目录后，后续能自动输出交换包。
- 虚拟 U 盘盘符变化后能通过 `mediaId` 找回。
- 内网端能自动取回交换包到本机 inbox，但不会静默写库。
- 月结只在内网端执行。
- 未授权状态下不能执行邮件下载等业务功能。
- 接受路径的 IPC 不能读取业务目录外文件。

## 8. 回归测试清单

### 邮件下载

- 配置邮箱后启动软件自动检测。
- 只下载匹配规则的附件。
- 下载后文件落到 `D:\laojiu\工资导入`。
- 下载后保留原附件名。
- 重复邮件不会重复下载同一个附件。
- 危险附件被跳过。

### 工资报账

- 工资表可被识别。
- 社保费未申报汇总文件可被识别。
- 税款计算工资薪金所得文件可被识别。
- 文件下载后用户可直接进入工资报账。

### 交换包

- 外网第一次生成交换包时可选择摆渡目录。
- 外网能写入 `laojiu-exchange.json`。
- 外网第二次生成交换包时自动输出到摆渡目录。
- 摆渡盘盘符变化后仍能通过 `mediaId` 找回。
- 摆渡盘不在线时保存到本机 outbox 并提示。
- 内网打开软件后能扫描摆渡盘并取回交换包。
- 半复制文件不会被处理。
- 内网校验通过后才允许用户导入。
- 内网完成一体化后才允许月结。
- 内网月结后能生成回执包。

### 安装和目录

- 安装目录固定为 `D:\laojiu\gzxt`。
- 卸载或升级不删除 `D:\laojiu\gzdata`、`D:\laojiu\工资导入` 和 `D:\laojiu\交换包`。
- 桌面快捷方式指向正确目录。

### 授权和安全

- 未授权不能执行邮件下载。
- 路径型 IPC 不能读取目录外文件。
- 一体化脚本只能执行内置脚本。
- 交换包不能携带可执行脚本。
