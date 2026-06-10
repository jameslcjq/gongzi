// 一体化门户主机地址（R-09 配置外置）。
// 渲染层：构建期常量 __PORTAL_HOST__（见 vite.config.mts，PAYROLL_PORTAL_HOST 环境变量在打包时生效）。
// 主进程：运行时还可再被 PAYROLL_PORTAL_HOST 环境变量覆盖（resolvePortalHost）。
// 默认值保持现网地址，不设环境变量时行为与从前完全一致。

export const DEFAULT_PORTAL_HOST = '172.24.147.202'

declare const __PORTAL_HOST__: string | undefined

export const PORTAL_HOST: string =
  typeof __PORTAL_HOST__ !== 'undefined' && __PORTAL_HOST__ ? __PORTAL_HOST__ : DEFAULT_PORTAL_HOST

export function resolvePortalHost(env?: Record<string, string | undefined>): string {
  const fromEnv = env?.PAYROLL_PORTAL_HOST?.trim()
  return fromEnv || PORTAL_HOST
}

export function portalBaseUrl(env?: Record<string, string | undefined>): string {
  return `http://${resolvePortalHost(env)}`
}
