import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getDataPath } from '../config/paths'

// 主进程日志落盘（R-07）：现场排障不能依赖看不见的控制台。
// 按天一个文件：<dataRoot>/logs/main-YYYY-MM-DD.log。
// 设计为绝不抛错——日志失败只能静默，不能反过来影响业务。

let logsDirEnsured = false

function logFilePath(): string {
  const dir = getDataPath('logs')
  if (!logsDirEnsured) {
    try {
      mkdirSync(dir, { recursive: true })
      logsDirEnsured = true
    } catch {
      /* 日志目录建不出来时放弃落盘 */
    }
  }
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return join(dir, `main-${day}.log`)
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function appendMainLog(level: string, source: string, ...parts: unknown[]): void {
  try {
    const time = new Date().toISOString()
    const message = parts.map(formatValue).join(' ').slice(0, 4000)
    appendFileSync(logFilePath(), `${time} [${level}] [${source}] ${message}\n`, 'utf-8')
  } catch {
    /* 落盘失败静默 */
  }
}

let installed = false

/**
 * 安装主进程日志：
 * 1. console.info/warn/error 同时落盘（保留原 console 输出）；
 * 2. uncaughtException / unhandledRejection 落盘（不改变默认行为之外的逻辑，仅留痕）。
 */
export function installMainProcessLogging(): void {
  if (installed) return
  installed = true

  const original = {
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }
  console.info = (...args: unknown[]) => {
    appendMainLog('info', 'console', ...args)
    original.info(...args)
  }
  console.warn = (...args: unknown[]) => {
    appendMainLog('warn', 'console', ...args)
    original.warn(...args)
  }
  console.error = (...args: unknown[]) => {
    appendMainLog('error', 'console', ...args)
    original.error(...args)
  }

  process.on('uncaughtException', (error) => {
    appendMainLog('fatal', 'uncaughtException', error)
    original.error('[uncaughtException]', error)
  })
  process.on('unhandledRejection', (reason) => {
    appendMainLog('error', 'unhandledRejection', reason)
    original.error('[unhandledRejection]', reason)
  })
}
