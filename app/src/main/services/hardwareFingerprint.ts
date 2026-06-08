import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const BLOCKED_HARDWARE_VALUES = new Set([
  'TO BE FILLED BY O.E.M.',
  'DEFAULT STRING',
  'SYSTEM SERIAL NUMBER',
  'NONE',
  'UNKNOWN',
  '00000000-0000-0000-0000-000000000000'
])

interface HardwareField {
  label: string
  value: string
}

interface DeviceIdCandidate {
  label: string
  values: string[]
}

export interface HardwareIdentity {
  deviceId: string
  hardware: string
  deviceAliases?: string[]
}

export function normalizeHardwareValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase()
  return BLOCKED_HARDWARE_VALUES.has(normalized) ? '' : normalized
}

function hashHex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export function makeDeviceId(values: string[]): string {
  const normalizedValues = values.map(normalizeHardwareValue).filter(Boolean)
  const payload = ['yunbg-license-device', 'v1', ...normalizedValues].join('|')
  return hashHex(payload)
}

function makeCandidateDeviceId(candidate: DeviceIdCandidate): string {
  return makeDeviceId([candidate.label, ...candidate.values])
}

function uniqueDeviceIds(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function addField(fields: HardwareField[], label: string, value: unknown): void {
  const normalized = normalizeHardwareValue(value)
  if (normalized) fields.push({ label, value: normalized })
}

function addCandidate(candidates: DeviceIdCandidate[], label: string, values: unknown[]): void {
  const normalizedValues = values.map(normalizeHardwareValue).filter(Boolean)
  if (normalizedValues.length === values.length && normalizedValues.length > 0) {
    candidates.push({ label, values: normalizedValues })
  }
}

export function summarizeHardware(fields: HardwareField[], platform = process.platform): string {
  const parts = fields
    .filter((field) => field.value)
    .map((field) => `${field.label}:${hashHex(field.value).slice(0, 8)}`)
  return [platform === 'win32' ? 'win' : platform, ...parts].join('|')
}

async function readWindowsHardware(): Promise<any> {
  const script = `
    $data = [ordered]@{
      csProduct = Get-CimInstance Win32_ComputerSystemProduct | Select-Object -First 1 UUID,IdentifyingNumber,Name,Vendor
      baseBoard = Get-CimInstance Win32_BaseBoard | Select-Object -First 1 SerialNumber,Product,Manufacturer
      bios = Get-CimInstance Win32_BIOS | Select-Object -First 1 SerialNumber,SMBIOSBIOSVersion
      cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 ProcessorId,Name
      computer = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 Manufacturer,Model
    }
    $data | ConvertTo-Json -Compress -Depth 4
  `

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 5000 }
  )

  return JSON.parse(stdout)
}

export function collectWindowsHardwareFields(raw: any): HardwareField[] {
  const fields: HardwareField[] = []
  addField(fields, 'uuid', raw?.csProduct?.UUID)
  addField(fields, 'asset', raw?.csProduct?.IdentifyingNumber)
  addField(fields, 'board', raw?.baseBoard?.SerialNumber)
  addField(fields, 'bios', raw?.bios?.SerialNumber)
  addField(fields, 'cpu', raw?.cpu?.ProcessorId)
  addField(fields, 'maker', raw?.computer?.Manufacturer)
  addField(fields, 'model', raw?.computer?.Model)
  return fields
}

export function collectWindowsDeviceIdCandidates(raw: any): DeviceIdCandidate[] {
  const candidates: DeviceIdCandidate[] = []
  addCandidate(candidates, 'win:asset', [raw?.csProduct?.IdentifyingNumber])
  addCandidate(candidates, 'win:bios', [raw?.bios?.SerialNumber])
  addCandidate(candidates, 'win:uuid', [raw?.csProduct?.UUID])
  addCandidate(candidates, 'win:board', [raw?.baseBoard?.SerialNumber])
  addCandidate(candidates, 'win:board-cpu', [raw?.baseBoard?.SerialNumber, raw?.cpu?.ProcessorId])
  return candidates
}

function collectFallbackHardwareFields(): HardwareField[] {
  const fields: HardwareField[] = []
  addField(fields, 'host', os.hostname())
  addField(fields, 'platform', process.platform)
  addField(fields, 'arch', process.arch)
  addField(fields, 'release', os.release())
  return fields
}

function buildIdentityFromWindowsHardware(raw: any): HardwareIdentity | null {
  const fields = collectWindowsHardwareFields(raw)
  const candidates = collectWindowsDeviceIdCandidates(raw)
  if (candidates.length === 0) return null

  const primaryDeviceId = makeCandidateDeviceId(candidates[0])
  const legacyFullHardwareId = fields.length > 0 ? makeDeviceId(fields.map((field) => field.value)) : ''
  const fallbackFields = collectFallbackHardwareFields()
  const legacyFallbackId = makeDeviceId(fallbackFields.map((field) => field.value))
  const deviceAliases = uniqueDeviceIds([
    legacyFullHardwareId,
    legacyFallbackId,
    ...candidates.slice(1).map(makeCandidateDeviceId)
  ]).filter((deviceId) => deviceId !== primaryDeviceId)

  return {
    deviceId: primaryDeviceId,
    hardware: summarizeHardware(fields),
    deviceAliases
  }
}

function getTestIdentityOverride(): HardwareIdentity | null {
  if (process.env.NODE_ENV !== 'test') return null
  const deviceId = process.env.PAYROLL_TEST_LICENSE_DEVICE_ID?.trim()
  if (!deviceId) return null
  return {
    deviceId,
    hardware: process.env.PAYROLL_TEST_LICENSE_HARDWARE?.trim() || 'test|device'
  }
}

export async function getHardwareIdentity(): Promise<HardwareIdentity> {
  const testIdentity = getTestIdentityOverride()
  if (testIdentity) return testIdentity

  try {
    if (process.platform === 'win32') {
      const raw = await readWindowsHardware()
      const identity = buildIdentityFromWindowsHardware(raw)
      if (identity) return identity
    }
  } catch (error) {
    console.warn('[License] 读取硬件信息失败，使用稳定系统信息降级生成设备指纹:', error)
  }

  const fallbackFields = collectFallbackHardwareFields()
  return {
    deviceId: makeDeviceId(fallbackFields.map((field) => field.value)),
    hardware: summarizeHardware(fallbackFields)
  }
}
