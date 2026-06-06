# 老九自动化采集助手实现方案

更新时间：2026-06-06

本文用于设计一个可封装进工资系统、并可复用于其他老九系列软件的 Windows 自动化采集与诊断工具。第一阶段目标不是直接自动登录、自动审核或自动切换 Key，而是先把 Windows 原生弹窗、控件树、下拉列表和候选 Key 信息采集清楚，为后续自动化提供稳定依据。

## 1. 背景和目标

工资系统的一体化登录可能会弹出 Windows 原生 Key / 证书 / UKey 选择窗口。该窗口不是网页 DOM 弹窗，网页脚本无法直接读取和操作。

因此需要一个本地 Windows 自动化助手：

```text
laojiu-automation-helper.exe
```

它由 Electron 主程序调用，负责识别 Windows 原生弹窗、导出控件树、读取下拉列表、保存截图和生成诊断包。

目标：

```text
1. 降低登录 Key 自动化调试难度。
2. 不要求业务人员懂代码。
3. 让用户通过软件界面一键采集诊断信息。
4. 为后续自动选择 Key、自动切换 Key、自动审核等能力打基础。
5. 让工资系统和其他老九系列软件共用同一套 Windows 自动化能力。
```

## 2. 总体原则

```text
第一版只采集，不自动操作。
第二版自动选择 Key，但不自动点最终确认。
第三版再接入网页脚本，实现登录后校验、切 Key 和业务接力。
```

设计原则：

- 不直接写死窗口坐标。
- 不默认选择第一个 Key。
- 不在第一版自动点击“确定 / 登录 / 审核”。
- 不让交换包携带任何自动化脚本。
- 不保存证书私钥或 Key 敏感内容。
- 不长期后台常驻，采集动作由用户或主程序明确触发。
- 所有采集结果保存到本机固定调试目录。
- 后续所有自动化都必须有日志、超时、失败原因和人工接管能力。

## 3. 推荐架构

```text
工资系统 Electron 主程序
  ├─ 自动化诊断页面
  ├─ Automation Orchestrator 自动化编排器
  └─ child_process 调用
       ↓
laojiu-automation-helper.exe
  ├─ WindowScanner           顶层窗口发现
  ├─ UIATreeDumper           UI Automation 控件树导出
  ├─ ComboBoxInspector       下拉框识别和候选项读取
  ├─ ScreenshotCapturer      窗口截图和全屏截图
  ├─ ActionExecutor          后续选择/点击/聚焦能力
  └─ DiagnosticPackBuilder   诊断包生成
```

助手程序建议用：

```text
C# .NET + FlaUI + UI Automation UIA3
```

原因：

- 可以打包成独立 exe。
- Electron 主程序可通过 `child_process` 调用。
- Windows UI Automation 支持更稳定。
- 适合长期封装成老九系列软件共用能力。

## 4. 第一阶段范围：采集模式

第一阶段只实现采集，不执行有风险的业务操作。

命令示例：

```text
laojiu-automation-helper.exe collect --timeout 20 --scenario gongzi-login-key
laojiu-automation-helper.exe list-windows
laojiu-automation-helper.exe dump-tree --hwnd 0x001F08A2
laojiu-automation-helper.exe find-combos --hwnd 0x001F08A2
laojiu-automation-helper.exe screenshot --hwnd 0x001F08A2
```

第一阶段必须输出：

```text
窗口候选列表
命中的窗口
窗口标题 / 类名 / 进程名 / HWND
控件树摘要
所有 ComboBox / List / ListItem / Button
候选 Key 文本
支持的 UI Automation Pattern
窗口截图
下拉框展开截图
失败原因
环境信息
```

## 5. 采集流程

### 5.1 用户操作流程

在工资系统中增加入口：

```text
设置 / 调试工具 / 一体化登录 Key 采集
```

用户流程：

```text
1. 打开一体化登录页。
2. 点击“开始采集登录 Key 弹窗”。
3. 软件提示：请现在点击一体化网页登录按钮。
4. 用户点击网页登录。
5. Key / 证书选择窗口弹出。
6. 助手程序采集窗口、控件树、下拉列表、截图。
7. 工资系统展示采集摘要。
8. 用户点击“导出诊断包”。
```

### 5.2 程序采集流程

```text
1. 主程序记录 web-login-clicked 时间点。
2. helper 进入 20 秒监听窗口状态。
3. 监听新出现或前台变化的顶层窗口。
4. 对候选窗口采集标题、类名、进程、位置、大小。
5. 对候选窗口导出 UIA 控件树。
6. 查找 ComboBox / List / ListItem / Button。
7. 尝试展开 ComboBox。
8. 展开后再次导出控件树。
9. 读取候选 Key 文本。
10. 保存窗口截图和下拉展开截图。
11. 输出 JSON。
12. 主程序读取 JSON 并展示结果。
```

## 6. 采集目录

默认输出目录：

```text
D:\laojiu\gzdata\debug\automation\
```

如果后续多个老九软件共用，也可以扩展为：

```text
D:\laojiu\debug\automation\
```

一次采集输出目录示例：

```text
D:\laojiu\gzdata\debug\automation\20260606-143012-gongzi-login-key\
  capture.json
  windows.json
  window-tree-before-expand.json
  window-tree-after-expand.json
  key-candidates.json
  timeline.log
  environment.json
  window.png
  expanded.png
  fullscreen.png
```

诊断包：

```text
login-key-diagnostic-20260606-143012.zip
```

## 7. 需要采集的信息

### 7.1 窗口级信息

每个候选窗口采集：

```json
{
  "hwnd": "0x001F08A2",
  "title": "请选择证书",
  "className": "#32770",
  "processId": 12345,
  "processName": "ca-client.exe",
  "threadId": 6789,
  "isVisible": true,
  "isForeground": true,
  "rect": {
    "left": 520,
    "top": 280,
    "width": 560,
    "height": 340
  },
  "createdAfterLoginClickMs": 842
}
```

说明：

- `HWND` 只作为本次操作入口，每次弹窗都可能变化。
- 长期匹配应依赖窗口标题、类名、进程名、控件树、出现时机和候选 Key 文本。

### 7.2 控件树信息

控件树中每个节点采集：

```json
{
  "controlType": "ComboBox",
  "localizedControlType": "组合框",
  "name": "请选择登录Key",
  "automationId": "cmbCert",
  "className": "ComboBox",
  "isEnabled": true,
  "isOffscreen": false,
  "hasKeyboardFocus": false,
  "boundingRectangle": {
    "left": 620,
    "top": 360,
    "width": 320,
    "height": 28
  },
  "patterns": [
    "ExpandCollapse",
    "Selection",
    "Value",
    "LegacyIAccessible"
  ],
  "children": []
}
```

重点控件类型：

```text
Window
Pane
Text
Edit
ComboBox
List
ListItem
DataItem
Button
```

### 7.3 候选 Key 文本

这是后续自动匹配的核心数据。

示例：

```json
{
  "keyCandidates": [
    {
      "text": "019070 某某学校 经办Key",
      "index": 0,
      "controlType": "ListItem",
      "source": "ListItem.Name",
      "isSelected": false,
      "patterns": ["SelectionItem", "ScrollItem"],
      "roleGuess": "operator",
      "score": 100
    },
    {
      "text": "019070 某某学校 审核Key",
      "index": 1,
      "controlType": "ListItem",
      "source": "ListItem.Name",
      "isSelected": false,
      "patterns": ["SelectionItem", "ScrollItem"],
      "roleGuess": "reviewer",
      "score": 95
    }
  ]
}
```

采集时应尝试从多个来源拼接文本：

```text
Name
ValuePattern.Value
LegacyIAccessible.Name
子 Text 节点 Name
```

### 7.4 按钮信息

采集所有按钮：

```json
{
  "buttons": [
    {
      "name": "确定",
      "automationId": "btnOK",
      "className": "Button",
      "patterns": ["Invoke"],
      "rect": {}
    },
    {
      "name": "取消",
      "automationId": "btnCancel",
      "className": "Button",
      "patterns": ["Invoke"],
      "rect": {}
    }
  ]
}
```

第一阶段不点击按钮，但要采集，为后续自动确认做准备。

### 7.5 时序日志

采集过程必须有时序日志：

```text
0ms      web-login-clicked
842ms    win-dialog-detected hwnd=0x001F08A2
1100ms   combo-found count=1
1350ms   combo-expanded
1600ms   items-collected count=2
1800ms   screenshots-saved
2000ms   capture-json-written
```

用于区分：

```text
窗口没弹出
窗口弹出太慢
控件树没读到
下拉框没展开
列表项没加载
截图失败
```

### 7.6 环境信息

采集：

```json
{
  "environment": {
    "windowsVersion": "Windows 10/11",
    "isHelperElevated": false,
    "isElectronElevated": false,
    "sessionId": 1,
    "dpiScale": 125,
    "screenCount": 2,
    "primaryScreen": "1920x1080",
    "helperBitness": "x64"
  }
}
```

原因：

- 权限不一致时可能读不到窗口。
- DPI 缩放会影响截图和坐标。
- 多显示器会影响弹窗位置。
- 32/64 位 helper 可能影响部分兼容性。

## 8. 如何找到下拉列表

查找顺序：

```text
1. 从候选窗口 HWND 转成 UI Automation 根元素。
2. 只在该窗口内查找，不从整个桌面深搜。
3. 查找 ControlType.ComboBox。
4. 如果没有 ComboBox，查找 List / ListItem / DataItem / Text。
5. 对 ComboBox 调用 ExpandCollapsePattern.Expand。
6. 展开后再次查找 ListItem。
7. 如果列表项不在 ComboBox 子树下，则在窗口子树和新出现的 Popup 窗口中查找。
8. 读取候选项文本。
9. 记录展开前后控件树和截图。
```

下拉框评分规则：

```text
控件类型是 ComboBox：+30
Name 包含 key / 证书 / 登录 / 单位：+30
支持 ExpandCollapse：+20
支持 Selection 或 Value：+20
展开后有多个 ListItem：+30
候选项文本包含单位编码：+50
候选项文本包含单位名称：+30
附近有“请选择 / Key / 证书”等文本：+20
```

如果多个 ComboBox 得分接近，不自动选择，要求人工确认。

## 9. 降级策略

不同 Key 驱动和 CA 控件可能暴露方式不同，应按以下顺序降级。

### 9.1 UI Automation 优先

优先使用：

```text
ComboBox
ExpandCollapsePattern
SelectionPattern
SelectionItemPattern
InvokePattern
ValuePattern
```

### 9.2 LegacyIAccessible / MSAA

如果 UIA 读不到文本，尝试：

```text
LegacyIAccessible.Name
LegacyIAccessible.Role
LegacyIAccessible.State
```

### 9.3 Win32 子窗口和消息

如果是标准 Win32 控件，尝试：

```text
EnumChildWindows
GetClassName
GetWindowText
SendMessage
CB_GETCOUNT
CB_GETLBTEXT
CB_SETCURSEL
LB_GETCOUNT
LB_GETTEXT
LB_SETCURSEL
```

### 9.4 键盘辅助

如果能聚焦但不能直接选择：

```text
Focus ComboBox
Alt + ↓
输入匹配关键字
Enter
```

### 9.5 人工提示

如果仍无法可靠读取和选择：

```text
请在弹出的证书窗口中选择：019070 某某学校 经办Key
```

此时可以把目标 Key 文本复制到剪贴板，减少用户选错。

## 10. 第二阶段：半自动选择 Key

当第一阶段确认能稳定读取候选 Key 后，再增加：

```text
select-key
```

命令示例：

```text
laojiu-automation-helper.exe select-key --scenario gongzi-login-key --unit-code 019070 --unit-name 某某学校 --role operator --confirm false
```

规则：

```text
1. 精确匹配单位导入编码。
2. 精确匹配单位全称。
3. 包含单位导入编码。
4. 包含单位名称关键字。
5. 匹配角色关键字：经办 / 审核。
6. 匹配上一次成功 Key。
7. 如果唯一高分，自动选中。
8. 如果多个高分，提示用户选择。
9. 只自动选中，不自动点击“确定”。
```

第二阶段必须继续生成日志和截图。

## 11. 第三阶段：和网页脚本接力

第三阶段再接入网页自动化脚本，实现：

```text
WinKeyAgent 负责选择 Windows 登录 Key。
WebAgent 负责网页登录状态、单位校验、角色校验和业务页面操作。
Orchestrator 负责状态机和接力。
```

推荐状态机：

```text
idle
  ↓
open-login-page
  ↓
wait-key-dialog-for-operator
  ↓
operator-key-selected
  ↓
wait-operator-login-success
  ↓
verify-operator-unit-role
  ↓
run-operator-business-check
  ↓
operator-submit-done
  ↓
logout-operator
  ↓
wait-key-dialog-for-reviewer
  ↓
reviewer-key-selected
  ↓
wait-reviewer-login-success
  ↓
verify-reviewer-unit-role
  ↓
run-review-check
  ↓
review-confirm
  ↓
review-done
  ↓
receipt-generated
```

关键要求：

```text
每次登录后必须校验单位、账号、角色。
切换 Key 前必须退出旧会话或清理会话。
审核、提交、月结等关键动作第一版必须保留人工确认。
```

## 12. 工资系统中的页面设计

新增页面或入口：

```text
设置 / 调试工具 / 自动化诊断
```

页面功能：

```text
[开始采集登录 Key 弹窗]
[查看最近采集结果]
[打开诊断目录]
[导出诊断包]
[测试读取下拉列表]
[测试自动选中 Key]
```

第一版页面展示：

```text
采集状态
命中的窗口标题
窗口类名
进程名
候选 ComboBox 数量
候选 Key 列表
按钮列表
截图预览
错误信息
诊断包路径
```

用户不需要懂代码，只需要能导出诊断包。

## 13. 安全边界

采集工具必须遵守：

```text
1. 只在用户点击“开始采集”或主程序明确触发时运行。
2. 默认监听时间不超过 20 秒。
3. 不长期后台常驻。
4. 不采集密码框内容。
5. 不保存证书私钥。
6. 不上传任何诊断数据。
7. 诊断包只保存在本机。
8. 导出诊断包时提示可能包含单位名称、单位编码和 Key 显示名称。
9. 对外发送诊断包前，后续应支持脱敏。
```

## 14. 诊断包脱敏策略

后续建议支持一键脱敏：

```text
019070 某某学校 经办Key
```

脱敏成：

```text
[单位编码] [单位名称] 经办Key
```

或者：

```text
UNIT_CODE_1 UNIT_NAME_1 OPERATOR_KEY
```

第一阶段内部调试可以保留明文；对外发包时再脱敏。

## 15. 建议新增文件和目录

```text
app/native/laojiu-automation-helper.exe
app/src/main/services/automation/automationHelper.ts
app/src/main/services/automation/automationDiagnostics.ts
app/src/main/ipc/automationApi.ts
app/src/renderer/src/components/AutomationDiagnosticsPage.vue
app/src/shared/automationTypes.ts
```

如果 helper 源码放入仓库，建议目录：

```text
tools/laojiu-automation-helper/
  src/
  README.md
  laojiu-automation-helper.csproj
```

如果 helper 二进制随安装包发布，应通过 `electron-builder` extraResources 打包。

## 16. 建议命令行接口

### 16.1 collect

```text
laojiu-automation-helper.exe collect --timeout 20 --scenario gongzi-login-key --out D:\laojiu\gzdata\debug\automation
```

作用：采集窗口、控件树、候选 Key、截图和环境信息。

### 16.2 list-windows

```text
laojiu-automation-helper.exe list-windows
```

作用：列出当前可见顶层窗口。

### 16.3 dump-tree

```text
laojiu-automation-helper.exe dump-tree --hwnd 0x001F08A2
```

作用：导出指定窗口控件树。

### 16.4 find-combos

```text
laojiu-automation-helper.exe find-combos --hwnd 0x001F08A2
```

作用：查找 ComboBox、展开并读取选项。

### 16.5 select-key

```text
laojiu-automation-helper.exe select-key --unit-code 019070 --unit-name 某某学校 --role operator --confirm false
```

作用：半自动选择 Key。第二阶段实现。

### 16.6 screenshot

```text
laojiu-automation-helper.exe screenshot --hwnd 0x001F08A2
```

作用：保存窗口截图。

## 17. 建议返回 JSON 格式

```json
{
  "ok": true,
  "scenario": "gongzi-login-key",
  "captureDir": "D:\\laojiu\\gzdata\\debug\\automation\\20260606-143012-gongzi-login-key",
  "matchedWindow": {
    "hwnd": "0x001F08A2",
    "title": "请选择证书",
    "className": "#32770",
    "processName": "ca-client.exe",
    "score": 92
  },
  "combos": [],
  "keyCandidates": [],
  "buttons": [],
  "screenshots": {
    "window": "window.png",
    "expanded": "expanded.png",
    "fullscreen": "fullscreen.png"
  },
  "errors": []
}
```

失败返回：

```json
{
  "ok": false,
  "scenario": "gongzi-login-key",
  "phase": "find-combo",
  "reason": "未找到可展开的 ComboBox",
  "captureDir": "D:\\laojiu\\gzdata\\debug\\automation\\20260606-143012-gongzi-login-key",
  "errors": [
    "Window detected but no ComboBox/ListItem found"
  ]
}
```

## 18. 验收标准

第一阶段验收：

```text
1. 能从工资系统界面启动采集。
2. 能在 20 秒内发现 Key 选择窗口。
3. 能记录窗口标题、类名、进程名、HWND。
4. 能导出控件树 JSON。
5. 能识别 ComboBox / List / ListItem / Button。
6. 能尝试展开下拉框。
7. 能读取候选 Key 文本；如读取不到，也能在日志中说明失败原因。
8. 能保存窗口截图和展开截图。
9. 能生成诊断包。
10. 不会自动点击“确定”。
11. 不会修改业务数据。
```

第二阶段验收：

```text
1. 能按单位编码和单位名称匹配唯一 Key。
2. 能区分经办 Key 和审核 Key。
3. 多个匹配项时不自动选择，提示用户。
4. 自动选中后不自动确认。
5. 登录后网页脚本能校验单位和角色。
```

第三阶段验收：

```text
1. WinKeyAgent 和 WebAgent 能通过 Orchestrator 接力。
2. 经办 Key 登录后能执行业务前置校验。
3. 切换审核 Key 前能退出旧会话。
4. 审核 Key 登录后能校验单位和角色。
5. 审核、提交、月结等关键动作保留人工确认。
6. 全流程有结构化日志和诊断包。
```

## 19. 回归测试清单

```text
正常经办 Key 弹窗采集。
正常审核 Key 弹窗采集。
多个单位 / 多个 Key 的弹窗采集。
下拉框展开前后截图正常。
候选 Key 文本可读。
ComboBox 读不到时有明确失败日志。
窗口弹出超时能提示。
权限不足时能提示。
多显示器环境截图正常。
DPI 125% / 150% 环境截图正常。
诊断包能导出。
诊断包不包含密码或私钥。
```

## 20. 最终路线

```text
第一阶段：AI 开发 laojiu-automation-helper.exe 的 collect 采集能力。
第二阶段：封装到工资系统“自动化诊断”页面。
第三阶段：采集 3 到 5 组真实弹窗诊断包。
第四阶段：根据诊断包补充窗口指纹和控件匹配规则。
第五阶段：实现半自动选择 Key。
第六阶段：接入网页脚本，实现登录后单位/角色校验。
第七阶段：再考虑自动确认、自动切 Key 和自动审核接力。
```

一句话总结：

```text
先让软件看清楚 Windows 弹窗，再让软件操作 Windows 弹窗。
```
