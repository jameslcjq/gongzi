import type { IpcMainInvokeEvent } from 'electron'

// 纵深防御：业务 IPC 只允许主窗口渲染进程调用。
// 一体化 webview（内网页面）当前没有 preload、本就触达不到 ipcRenderer；
// 这里再加一道断言，保证将来任何人误给 webview 配置 preload 时，
// 全部业务通道（含全盘文件读取类）也不会暴露给内网页面。
export function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderType = event.sender.getType()
  if (senderType !== 'window') {
    throw new Error(`该接口不允许来自 ${senderType} 的调用`)
  }
}
