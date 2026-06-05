import { app } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 一体化推送的持久化日志：把渲染进程发来的每一行推送过程写进按天分文件的 .log，
 * 供内网排查（用户点"打开日志文件夹"即可拿到文件发回来分析）。
 * 存放在 userData 下，保证任何情况下都可写、与导入文件夹无关。
 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStamp(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function getPushLogDir(): string {
  return join(app.getPath('userData'), '推送日志')
}

export function getPushLogFilePath(d = new Date()): string {
  return join(getPushLogDir(), `push-${dayStamp(d)}.log`)
}

// 串行化写入：时间戳在调用时刻确定，文件追加按调用顺序排队，
// 避免多行并发 appendFile 互相穿插导致日志顺序错乱（不利于排查）。
let writeChain: Promise<void> = Promise.resolve()

export function appendPushLog(line: string): Promise<void> {
  const now = new Date()
  const entry = `[${dayStamp(now)} ${timeStamp(now)}] ${line}\n`
  const file = getPushLogFilePath(now)
  writeChain = writeChain
    .then(() => mkdir(getPushLogDir(), { recursive: true }))
    .then(() => appendFile(file, entry, 'utf-8'))
    .catch((error) => {
      console.warn('写入推送日志失败', error)
    })
  return writeChain
}

export async function ensurePushLogDir(): Promise<string> {
  const dir = getPushLogDir()
  await mkdir(dir, { recursive: true })
  return dir
}
