import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { automationDebugRoot } from '../../config/paths'
import type {
  AutomationCaptureResult,
  AutomationHelperStatus,
  AutomationKeySwitchResult
} from '../../../shared/types'

const execFileAsync = promisify(execFile)
const HELPER_EXE = 'laojiu-automation-helper.exe'
const COLLECT_TIMEOUT_MS = 30_000

function candidateHelperPaths(): string[] {
  const override = process.env.PAYROLL_AUTOMATION_HELPER?.trim()
  const paths = [
    override,
    app.isPackaged ? join(process.resourcesPath, 'native', HELPER_EXE) : '',
    resolve(__dirname, '../native', HELPER_EXE),
    resolve(__dirname, '../../native', HELPER_EXE),
    resolve(__dirname, '../../tools/laojiu-automation-helper/bin/Release/net7.0-windows/win-x64/publish', HELPER_EXE),
    resolve(__dirname, '../../tools/laojiu-automation-helper/bin/Debug/net7.0-windows', HELPER_EXE)
  ]
  return paths.filter((item): item is string => Boolean(item))
}

export function resolveAutomationHelperPath(): string | null {
  return candidateHelperPaths().find((item) => existsSync(item)) ?? null
}

export function getAutomationHelperStatus(): AutomationHelperStatus {
  const helperPath = resolveAutomationHelperPath()
  return {
    available: Boolean(helperPath),
    helperPath: helperPath ?? undefined,
    debugRoot: automationDebugRoot,
    message: helperPath ? '采集助手已就绪' : '未找到 laojiu-automation-helper.exe，请先重新构建应用'
  }
}

export async function openAutomationDebugFolder(): Promise<string> {
  mkdirSync(automationDebugRoot, { recursive: true })
  return shell.openPath(automationDebugRoot)
}

export async function collectIntegrationLoginKey(): Promise<AutomationCaptureResult> {
  mkdirSync(automationDebugRoot, { recursive: true })
  const helperPath = resolveAutomationHelperPath()
  if (!helperPath) {
    return {
      ok: false,
      phase: 'helper-missing',
      reason: '未找到一体化登录 Key 采集助手',
      warnings: [],
      errors: ['未找到 laojiu-automation-helper.exe，请重新构建或重新安装程序']
    }
  }

  try {
    const raw = await runHelper(helperPath, [
      'collect',
      '--timeout',
      '20',
      '--scenario',
      'gongzi-login-key',
      '--out',
      automationDebugRoot
    ])

    return normalizeCaptureResult(raw)
  } catch (error) {
    return {
      ok: false,
      phase: 'helper-run',
      reason: error instanceof Error ? error.message : String(error),
      warnings: [],
      errors: [error instanceof Error ? error.message : String(error)]
    }
  }
}

export async function switchIntegrationLoginKey(input: {
  keyText?: string
  index?: number
  pin?: string
  confirm?: boolean
}): Promise<AutomationKeySwitchResult> {
  const helperPath = resolveAutomationHelperPath()
  const keyText = typeof input.keyText === 'string' ? input.keyText.trim() : ''
  const index = typeof input.index === 'number' && Number.isFinite(input.index) ? Math.trunc(input.index) : undefined
  const pin = typeof input.pin === 'string' ? input.pin : ''
  const confirm = input.confirm === true
  if (!helperPath) {
    return {
      ok: false,
      phase: 'helper-missing',
      reason: '未找到一体化登录 Key 采集助手',
      warnings: [],
      errors: ['未找到 laojiu-automation-helper.exe，请重新构建或重新安装程序']
    }
  }
  if (!keyText && index === undefined) {
    return {
      ok: false,
      phase: 'missing-target',
      reason: '缺少要切换的 Key',
      warnings: [],
      errors: ['缺少要切换的 Key']
    }
  }
  if (confirm && !pin.trim()) {
    return {
      ok: false,
      phase: 'missing-pin',
      reason: '自动确定前必须输入 PIN 码',
      warnings: [],
      errors: ['自动确定前必须输入 PIN 码']
    }
  }

  const args = ['select-key', '--timeout', '20']
  if (keyText) args.push('--key', keyText)
  if (index !== undefined) args.push('--index', String(index))
  if (confirm) args.push('--confirm', 'true')
  // PIN 经环境变量传入，不进命令行参数（命令行在 Windows 上可被其它进程列出）。
  const extraEnv = pin ? { LAOJIU_HELPER_PIN: pin } : undefined

  try {
    const raw = await runHelper(helperPath, args, extraEnv)
    return normalizeKeySwitchResult(raw)
  } catch (error) {
    return {
      ok: false,
      phase: 'helper-run',
      reason: error instanceof Error ? error.message : String(error),
      warnings: [],
      errors: [error instanceof Error ? error.message : String(error)]
    }
  }
}

async function runHelper(
  helperPath: string,
  args: string[],
  extraEnv?: Record<string, string>
): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(helperPath, args, {
      windowsHide: true,
      timeout: COLLECT_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf8',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env
    })
    return parseHelperJson(stdout)
  } catch (error) {
    const stdout = typeof (error as { stdout?: unknown }).stdout === 'string'
      ? (error as { stdout: string }).stdout
      : ''
    if (stdout.trim()) return parseHelperJson(stdout)
    throw error
  }
}

function parseHelperJson(stdout: string): unknown {
  const text = stdout.trim()
  const jsonStart = text.indexOf('{')
  if (jsonStart < 0) throw new Error('采集助手没有返回 JSON')
  return JSON.parse(text.slice(jsonStart))
}

function normalizeCaptureResult(raw: unknown): AutomationCaptureResult {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const captureDir = asString(value.captureDir)
  const diagnosticZipPath = asString(value.diagnosticZipPath)
  if (captureDir) mkdirSync(captureDir, { recursive: true })
  if (diagnosticZipPath) mkdirSync(dirname(diagnosticZipPath), { recursive: true })

  const warnings = asStringArray(value.warnings)
  const errors = asStringArray(value.errors)
  return {
    ok: value.ok === true,
    scenario: asString(value.scenario),
    phase: asString(value.phase),
    reason: asString(value.reason),
    captureDir,
    diagnosticZipPath,
    matchedWindow: isObject(value.matchedWindow) ? (value.matchedWindow as AutomationCaptureResult['matchedWindow']) : null,
    combos: Array.isArray(value.combos) ? (value.combos as AutomationCaptureResult['combos']) : [],
    keyCandidates: Array.isArray(value.keyCandidates)
      ? (value.keyCandidates as AutomationCaptureResult['keyCandidates'])
      : [],
    buttons: Array.isArray(value.buttons) ? (value.buttons as AutomationCaptureResult['buttons']) : [],
    comboCount: asNumber(value.comboCount),
    keyCandidateCount: asNumber(value.keyCandidateCount),
    buttonCount: asNumber(value.buttonCount),
    screenshots: isObject(value.screenshots) ? (value.screenshots as AutomationCaptureResult['screenshots']) : undefined,
    warnings,
    errors
  }
}

function normalizeKeySwitchResult(raw: unknown): AutomationKeySwitchResult {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const warnings = asStringArray(value.warnings)
  const errors = asStringArray(value.errors)
  return {
    ok: value.ok === true,
    command: asString(value.command),
    phase: asString(value.phase),
    reason: asString(value.reason),
    requestedKey: asString(value.requestedKey),
    requestedIndex: asNullableNumber(value.requestedIndex),
    selectedIndex: asNumber(value.selectedIndex),
    selectedText: asString(value.selectedText),
    method: asString(value.method),
    pinFilled: value.pinFilled === true,
    confirmed: value.confirmed === true,
    matchedWindow: isObject(value.matchedWindow) ? (value.matchedWindow as AutomationKeySwitchResult['matchedWindow']) : null,
    beforeCurrentKey: asString(value.beforeCurrentKey),
    afterCurrentKey: asString(value.afterCurrentKey),
    availableKeys: asStringArray(value.availableKeys),
    combos: Array.isArray(value.combos) ? (value.combos as AutomationKeySwitchResult['combos']) : [],
    keyCandidates: Array.isArray(value.keyCandidates)
      ? (value.keyCandidates as AutomationKeySwitchResult['keyCandidates'])
      : [],
    warnings,
    errors
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return asNumber(value)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : []
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
