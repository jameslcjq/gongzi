/**
 * 把推送过程写进持久日志文件（主进程 push-log:append），供内网排查。
 * 渲染进程里多个页面（月度工资入口、一体化执行页）都通过它落盘，保证"全程"留痕。
 * fire-and-forget：写日志失败绝不影响推送主流程。
 */
export function appendPushLogLine(line: string): void {
  try {
    void window.salaryApi.appendPushLog(line).catch(() => {})
  } catch {
    /* 忽略：日志不可用时不能阻断推送 */
  }
}

export function openPushLogFolder(): Promise<string> {
  return window.salaryApi.openPushLogFolder()
}
