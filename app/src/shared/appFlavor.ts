// 构建期应用变体常量。
//
// 由 Vite `define` 注入全局 `__APP_FLAVOR__`（见 vite.config.mts），构建期决定，
// 不是运行时用户开关：
//   - 'full'   完整版：外网/内网完整工作模式，全部模块可见。
//   - 'runner' 内网执行端版：隐藏无关报表入口，推送集中到一体化对接工具栏。
//
// 用 `typeof` 防御：若某构建上下文未注入该常量（例如主进程构建），标识符仍存在
// 但取值为 undefined 时回退到 'full'，避免 ReferenceError。

declare const __APP_FLAVOR__: 'full' | 'runner' | undefined

export type AppFlavor = 'full' | 'runner'

export const APP_FLAVOR: AppFlavor =
  typeof __APP_FLAVOR__ !== 'undefined' && __APP_FLAVOR__ === 'runner' ? 'runner' : 'full'

export const isRunnerFlavor = APP_FLAVOR === 'runner'

export const isFullFlavor = APP_FLAVOR === 'full'
