import { app, safeStorage } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { getDataPath } from '../config/paths'
import { getHardwareIdentity } from './hardwareFingerprint'

export type LicenseSource = 'online' | 'offline' | 'cache'

export interface LicenseStatus {
  valid: boolean
  source?: LicenseSource
  product_key?: string
  product_name?: string
  license_key?: string
  customer_code?: string
  customer_name?: string
  plan?: string
  expires_at?: string
  seats?: number
  used_seats?: number
  features?: Record<string, unknown>
  reason?: string
  message?: string
  cached?: boolean
  checkedAt?: string
  server_time?: string
  device_id?: string
}

interface LicenseCache extends LicenseStatus {
  cachedAt: string
}

interface LicenseConfig {
  serverUrl?: string
  apiBase?: string
  licenseKey?: string
  license_key?: string
  offlinePublicKey?: string
  offline_public_key?: string
  customerName?: string
  customer_name?: string
  lastVerifiedAt?: string
  last_verified_at?: string
  lastServerTime?: string
  last_server_time?: string
  lastValidResult?: Partial<LicenseStatus>
  last_valid_result?: Partial<LicenseStatus>
}

interface OfflineLicensePayload {
  product_key: string
  product_name?: string
  license_key: string
  customer_code?: string
  customer_name?: string
  plan?: string
  seats?: number
  used_seats?: number
  expires_at: string
  features?: Record<string, unknown>
  device_ids?: string[]
  issued_at?: string
  not_before?: string
}

interface OfflineLicenseFile {
  format?: string
  version?: number
  algorithm?: string
  key_id?: string
  payload?: OfflineLicensePayload
  signature?: string
}

export interface LicenseDeviceInfo {
  product_key: string
  license_key?: string
  device_id: string
  device_name: string
  app_version: string
  hardware: string
}

export interface LicenseMachineRequest extends LicenseDeviceInfo {
  format: 'yunbg.license-request'
  version: 1
  generated_at: string
}

const PRODUCT_KEY = 'payroll'
const PRODUCT_NAME = '工资系统'
const DEFAULT_LICENSE_API_BASE = 'https://jyj.yunbg.vip/api/license'
// 在线授权短时不可用时允许使用最近一次有效结果，避免临时网络故障挡住当天业务。
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000
const OFFLINE_LICENSE_FILE = 'offline_license.lic'
const OFFLINE_LICENSE_FORMAT = 'yunbg.offline-license'
const OFFLINE_LICENSE_VERSION = 1
const SAFE_PREFIX = 'enc:'
const PLAIN_PREFIX = 'b64:'

function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getLicenseDataDir(): string {
  return ensureDir(getDataPath('license'))
}

function getConfigPath(): string {
  return path.join(getLicenseDataDir(), 'license_config.json')
}

function getCachePath(): string {
  return path.join(getLicenseDataDir(), 'license_cache.json')
}

function getOfflineLicensePath(): string {
  return path.join(getLicenseDataDir(), OFFLINE_LICENSE_FILE)
}

function readLicenseConfig(): LicenseConfig {
  try {
    const configPath = getConfigPath()
    if (!fs.existsSync(configPath)) return {}
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeLicenseConfig(config: LicenseConfig): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8')
}

function encodeConfigText(value: string): string {
  if (!value) return ''
  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      return SAFE_PREFIX + safeStorage.encryptString(value).toString('base64')
    }
  } catch {
    // Fall back to base64 below.
  }
  // base64 只是兼容 safeStorage 不可用的环境，不具备加密强度；不要在这里保存高敏明文。
  return PLAIN_PREFIX + Buffer.from(value, 'utf-8').toString('base64')
}

function decodeConfigText(value: string): string {
  if (!value) return ''
  try {
    if (value.startsWith(SAFE_PREFIX)) {
      return safeStorage?.decryptString
        ? safeStorage.decryptString(Buffer.from(value.slice(SAFE_PREFIX.length), 'base64'))
        : ''
    }
    if (value.startsWith(PLAIN_PREFIX)) {
      return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf-8')
    }
    return value
  } catch {
    return ''
  }
}

function normalizeLicenseKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 64)
}

function normalizeCustomerName(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160)
}

function normalizeApiBase(url: string): string {
  const trimmed = String(url || DEFAULT_LICENSE_API_BASE).trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(trimmed)
    if (parsed.pathname === '' || parsed.pathname === '/') {
      parsed.pathname = '/api/license'
      return parsed.toString().replace(/\/+$/, '')
    }
  } catch {
    // Validation happens separately.
  }
  return trimmed
}

function isAllowedLicenseApiBase(url: string): boolean {
  try {
    const parsed = new URL(normalizeApiBase(url))
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

export function getLicenseServerUrl(): string {
  const config = readLicenseConfig()
  const saved = config.apiBase || config.serverUrl || ''
  if (typeof saved === 'string' && isAllowedLicenseApiBase(saved)) {
    return normalizeApiBase(saved)
  }
  return DEFAULT_LICENSE_API_BASE
}

export function setLicenseServerUrl(url: string): void {
  const normalized = normalizeApiBase(url || DEFAULT_LICENSE_API_BASE)
  if (!isAllowedLicenseApiBase(normalized)) {
    throw new Error('授权服务器地址必须使用 HTTPS；仅开发环境允许 localhost 使用 HTTP。')
  }
  writeLicenseConfig({
    ...readLicenseConfig(),
    apiBase: normalized,
    serverUrl: undefined
  })
}

export function getSavedLicenseKey(): string {
  const config = readLicenseConfig()
  return normalizeLicenseKey(decodeConfigText(config.license_key || config.licenseKey || ''))
}

export function saveLicenseKey(licenseKey: string): void {
  const normalized = normalizeLicenseKey(licenseKey)
  if (!normalized) throw new Error('授权码不能为空')
  writeLicenseConfig({
    ...readLicenseConfig(),
    license_key: encodeConfigText(normalized),
    licenseKey: undefined
  })
}

function normalizePem(value: string): string {
  return String(value || '').replace(/\\n/g, '\n').trim()
}

function saveOfflinePublicKey(publicKey: string): void {
  const normalized = normalizePem(publicKey)
  if (!normalized || !normalized.includes('BEGIN PUBLIC KEY')) return
  writeLicenseConfig({
    ...readLicenseConfig(),
    offline_public_key: encodeConfigText(normalized),
    offlinePublicKey: undefined
  })
}

function readOptionalTextFile(filePath: string): string {
  try {
    if (filePath && fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8')
  } catch {
    // Optional file.
  }
  return ''
}

function getOfflinePublicKeys(): string[] {
  const config = readLicenseConfig()
  const envKeys = [
    process.env.PAYROLL_LICENSE_PUBLIC_KEY || '',
    ...(process.env.PAYROLL_LICENSE_PUBLIC_KEYS || '')
      .split('-----END PUBLIC KEY-----')
      .map((chunk) => (chunk.trim() ? `${chunk.trim()}-----END PUBLIC KEY-----` : ''))
  ]
  const fileKeys = [
    path.join(process.cwd(), 'license_public_key.pem'),
    path.join(process.resourcesPath || '', 'license_public_key.pem'),
    path.join(app.getAppPath?.() || process.cwd(), 'license_public_key.pem'),
    path.join(path.dirname(app.getPath('exe') || process.cwd()), 'license_public_key.pem'),
    path.join(getLicenseDataDir(), 'license_public_key.pem')
  ].map(readOptionalTextFile)

  return Array.from(
    new Set(
      [
        ...envKeys,
        decodeConfigText(config.offline_public_key || config.offlinePublicKey || ''),
        ...fileKeys
      ]
        .map(normalizePem)
        .filter((key) => key.includes('BEGIN PUBLIC KEY'))
    )
  )
}

function getTodayDateString(): string {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isExpiryCurrent(expiresAt?: string): boolean {
  return !!expiresAt && expiresAt >= getTodayDateString()
}

function isSystemClockRolledBack(): boolean {
  const config = readLicenseConfig()
  const trustedTime =
    config.last_server_time ||
    config.lastServerTime ||
    String(config.last_valid_result?.server_time || config.lastValidResult?.server_time || '')
  const trustedTimeMs = new Date(trustedTime).getTime()
  if (!Number.isFinite(trustedTimeMs)) return false
  return Date.now() + 5 * 60 * 1000 < trustedTimeMs
}

function readCache(): LicenseCache | null {
  try {
    const cachePath = getCachePath()
    if (!fs.existsSync(cachePath)) return null
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Partial<LicenseCache>
    if (typeof parsed?.valid === 'boolean' && typeof parsed.cachedAt === 'string') {
      return parsed as LicenseCache
    }
  } catch {
    // Ignore invalid cache.
  }
  return null
}

function writeCache(cache: LicenseCache): void {
  fs.writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8')
}

function isCacheFresh(cache: LicenseCache): boolean {
  const cachedAtTime = new Date(cache.cachedAt).getTime()
  const now = Date.now()
  return (
    Number.isFinite(cachedAtTime) &&
    cachedAtTime <= now + 5 * 60 * 1000 &&
    now - cachedAtTime < OFFLINE_GRACE_MS
  )
}

function statusFromCache(cache: LicenseCache): LicenseStatus {
  let valid = !!cache.valid
  let reason = cache.reason
  if (valid && !isExpiryCurrent(cache.expires_at)) {
    valid = false
    reason = 'expired'
  } else if (valid && cache.source !== 'offline' && !isCacheFresh(cache)) {
    valid = false
    reason = 'network_error'
  }

  return {
    ...cache,
    valid,
    reason,
    source: cache.source || 'cache',
    cached: true,
    checkedAt: cache.cachedAt
  }
}

function cacheFromStatus(status: LicenseStatus): LicenseCache {
  return {
    valid: status.valid,
    source: status.source || (status.cached ? 'cache' : 'online'),
    product_key: status.product_key || PRODUCT_KEY,
    product_name: status.product_name || PRODUCT_NAME,
    license_key: status.license_key,
    customer_code: status.customer_code,
    customer_name: status.customer_name,
    plan: status.plan,
    expires_at: status.expires_at,
    seats: status.seats,
    used_seats: status.used_seats,
    features: status.features,
    reason: status.reason,
    message: status.message,
    server_time: status.server_time,
    device_id: status.device_id,
    cachedAt: status.checkedAt || new Date().toISOString()
  }
}

function saveLicenseMetadata(status: LicenseStatus): void {
  const config = readLicenseConfig()
  const nextConfig: LicenseConfig = {
    ...config,
    customer_name: status.customer_name || config.customer_name || config.customerName,
    last_verified_at: status.checkedAt || new Date().toISOString(),
    last_server_time: status.server_time || config.last_server_time || config.lastServerTime,
    last_valid_result: status.valid
      ? {
          valid: status.valid,
          product_key: status.product_key,
          product_name: status.product_name,
          license_key: status.license_key,
          customer_code: status.customer_code,
          customer_name: status.customer_name,
          plan: status.plan,
          expires_at: status.expires_at,
          seats: status.seats,
          used_seats: status.used_seats,
          server_time: status.server_time
        }
      : config.last_valid_result || config.lastValidResult
  }

  const licenseKey = normalizeLicenseKey(status.license_key || '')
  if (status.valid && licenseKey) {
    nextConfig.license_key = encodeConfigText(licenseKey)
    nextConfig.licenseKey = undefined
  }

  writeLicenseConfig(nextConfig)
}

async function buildDevicePayload() {
  const identity = await getHardwareIdentity()
  const appName = typeof app.getName === 'function' ? app.getName() : PRODUCT_NAME
  const appVersion = typeof app.getVersion === 'function' ? app.getVersion() : ''

  return {
    device_id: identity.deviceId,
    device_name: `${os.hostname()} / ${appName}`.slice(0, 180),
    app_version: appVersion,
    hardware: identity.hardware.slice(0, 240)
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`

  const objectValue = value as Record<string, unknown>
  return `{${Object.keys(objectValue)
    .filter((key) => typeof objectValue[key] !== 'undefined')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(objectValue[key])}`)
    .join(',')}}`
}

function verifyOfflineSignature(payload: OfflineLicensePayload, signature: string): boolean {
  const publicKeys = getOfflinePublicKeys()
  if (!publicKeys.length) throw new Error('offline_key_missing')

  const signedPayload = Buffer.from(canonicalStringify(payload), 'utf-8')
  const signatureBuffer = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

  return publicKeys.some((publicKey) => {
    try {
      return crypto.verify('sha256', signedPayload, publicKey, signatureBuffer)
    } catch {
      return false
    }
  })
}

function normalizeDeviceId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 128)
}

function offlineStatus(
  reason: string,
  message?: string,
  payload?: Partial<OfflineLicensePayload>
): LicenseStatus {
  return {
    valid: false,
    source: 'offline',
    product_key: payload?.product_key || PRODUCT_KEY,
    product_name: payload?.product_name || PRODUCT_NAME,
    license_key: payload?.license_key,
    customer_code: payload?.customer_code,
    customer_name: payload?.customer_name,
    plan: payload?.plan,
    expires_at: payload?.expires_at,
    seats: payload?.seats,
    used_seats: payload?.used_seats,
    features: payload?.features,
    reason,
    message,
    cached: true,
    checkedAt: new Date().toISOString()
  }
}

function validateOfflineLicenseEnvelope(envelope: OfflineLicenseFile, deviceId: string): LicenseStatus {
  const payload = envelope?.payload
  if (!payload || typeof payload !== 'object') {
    return offlineStatus('offline_invalid', '离线授权文件格式不正确')
  }
  if (envelope.format !== OFFLINE_LICENSE_FORMAT) {
    return offlineStatus('offline_invalid', '离线授权文件不是统一授权格式', payload)
  }
  if (envelope.version && envelope.version !== OFFLINE_LICENSE_VERSION) {
    return offlineStatus('offline_invalid', '离线授权文件版本不受支持', payload)
  }

  const payloadLicenseKey = normalizeLicenseKey(payload.license_key || '')
  if (payload.product_key !== PRODUCT_KEY || !payloadLicenseKey) {
    return offlineStatus('missing_product_or_license', '离线授权文件缺少当前产品或授权码', payload)
  }

  const savedLicenseKey = getSavedLicenseKey()
  if (savedLicenseKey && payloadLicenseKey !== savedLicenseKey) {
    return offlineStatus('license_mismatch', '离线授权文件与当前授权码不一致', payload)
  }

  if (!payload.expires_at || !/^\d{4}-\d{2}-\d{2}$/.test(payload.expires_at)) {
    return offlineStatus('offline_invalid', '离线授权文件缺少有效到期日期', payload)
  }

  const today = getTodayDateString()
  if (isSystemClockRolledBack()) {
    return offlineStatus('clock_rollback', '检测到本机时间异常，请联网校验后继续使用。', payload)
  }
  if (payload.not_before && payload.not_before > today) {
    return offlineStatus('offline_not_started', '离线授权尚未生效', payload)
  }
  if (payload.expires_at < today) return offlineStatus('expired', '离线授权已过期', payload)

  const allowedDeviceIds = Array.isArray(payload.device_ids)
    ? payload.device_ids.map(normalizeDeviceId).filter(Boolean)
    : []
  const normalizedDeviceId = normalizeDeviceId(deviceId)
  if (allowedDeviceIds.length > 0 && !allowedDeviceIds.includes(normalizedDeviceId)) {
    return offlineStatus('device_mismatch', '离线授权文件不属于当前电脑', payload)
  }

  const signature = String(envelope.signature || '')
  if (!signature) return offlineStatus('offline_invalid', '离线授权文件缺少签名', payload)

  try {
    if (!verifyOfflineSignature(payload, signature)) {
      return offlineStatus('offline_invalid', '离线授权文件签名无效', payload)
    }
  } catch (error: any) {
    if (error?.message === 'offline_key_missing') {
      return offlineStatus(
        'offline_key_missing',
        '客户端缺少离线授权公钥，请先完成一次在线授权，或把授权中心公钥 license_public_key.pem 放到软件目录。',
        payload
      )
    }
    return offlineStatus('offline_invalid', '离线授权文件验签失败', payload)
  }

  return {
    valid: true,
    source: 'offline',
    product_key: payload.product_key,
    product_name: payload.product_name || PRODUCT_NAME,
    license_key: payloadLicenseKey,
    customer_code: payload.customer_code,
    customer_name: payload.customer_name,
    plan: payload.plan,
    expires_at: payload.expires_at,
    seats: payload.seats,
    used_seats: payload.used_seats,
    features: payload.features && typeof payload.features === 'object' ? payload.features : undefined,
    cached: true,
    checkedAt: new Date().toISOString(),
    device_id: normalizedDeviceId
  }
}

async function readOfflineLicenseStatus(): Promise<LicenseStatus | null> {
  try {
    const filePath = getOfflineLicensePath()
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    const envelope = JSON.parse(raw) as OfflineLicenseFile
    const device = await buildDevicePayload()
    return validateOfflineLicenseEnvelope(envelope, device.device_id)
  } catch {
    return offlineStatus('offline_invalid', '离线授权文件读取失败')
  }
}

function httpGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const isHttps = urlObj.protocol === 'https:'
    const transport = isHttps ? https : http
    const req = transport.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'GET',
        timeout: 10000
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('Invalid response'))
          }
        })
      }
    )

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Timeout'))
    })
    req.end()
  })
}

function httpPost(url: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const urlObj = new URL(url)
    const isHttps = urlObj.protocol === 'https:'
    const transport = isHttps ? https : http
    const req = transport.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 10000
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('Invalid response'))
          }
        })
      }
    )

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Timeout'))
    })
    req.write(data)
    req.end()
  })
}

function normalizeStatusReason(result: any): string | undefined {
  if (typeof result?.reason === 'string' && result.reason) return result.reason
  if (result?.found === false) return 'not_found'
  return undefined
}

function toLicenseStatus(result: any): LicenseStatus {
  const reason = normalizeStatusReason(result)
  return {
    valid: !!result?.valid,
    source: 'online',
    product_key: result?.product_key || PRODUCT_KEY,
    product_name: result?.product_name || PRODUCT_NAME,
    license_key: result?.license_key,
    customer_code: result?.customer_code || result?.canonical_customer_code || result?.school_code,
    customer_name: result?.customer_name || result?.school_name,
    plan: result?.plan,
    expires_at: result?.expires_at,
    seats: typeof result?.seats === 'number' ? result.seats : undefined,
    used_seats: typeof result?.used_seats === 'number' ? result.used_seats : undefined,
    features: result?.features && typeof result.features === 'object' ? result.features : undefined,
    reason,
    message: result?.message,
    cached: false,
    checkedAt: new Date().toISOString(),
    server_time: result?.server_time
  }
}

function isOnlineBlockingStatus(status: LicenseStatus): boolean {
  return (
    !status.valid &&
    ['not_found', 'expired', 'disabled', 'product_disabled', 'missing_product_or_license'].includes(
      status.reason || ''
    )
  )
}

async function fetchOnlineLicenseStatus(apiBase: string, licenseKey: string): Promise<LicenseStatus> {
  const url = new URL(`${apiBase}/v2/status`)
  url.searchParams.set('product_key', PRODUCT_KEY)
  url.searchParams.set('license_key', licenseKey)

  const result = await httpGet(url.toString())
  if (typeof result?.offline_public_key === 'string') saveOfflinePublicKey(result.offline_public_key)
  const status = toLicenseStatus(result)
  if (!status.license_key) status.license_key = licenseKey
  return status
}

export async function getLicenseDeviceInfo(licenseKeyInput = ''): Promise<LicenseDeviceInfo> {
  const device = await buildDevicePayload()
  const licenseKey = normalizeLicenseKey(licenseKeyInput || getSavedLicenseKey())
  return {
    product_key: PRODUCT_KEY,
    license_key: licenseKey || undefined,
    ...device
  }
}

export async function exportMachineRequest(licenseKeyInput = ''): Promise<LicenseMachineRequest> {
  const info = await getLicenseDeviceInfo(licenseKeyInput)
  return {
    format: 'yunbg.license-request',
    version: 1,
    ...info,
    generated_at: new Date().toISOString()
  }
}

export async function importOfflineLicenseText(raw: string): Promise<LicenseStatus> {
  try {
    const envelope = JSON.parse(raw) as OfflineLicenseFile
    const device = await buildDevicePayload()
    const status = validateOfflineLicenseEnvelope(envelope, device.device_id)
    if (!status.valid) return status

    fs.writeFileSync(getOfflineLicensePath(), JSON.stringify(envelope, null, 2), 'utf-8')
    writeCache(cacheFromStatus(status))
    saveLicenseMetadata(status)
    return status
  } catch (error: any) {
    return offlineStatus('offline_invalid', error?.message || '离线授权文件解析失败')
  }
}

export async function claimTrialLicense(
  customerNameInput: string,
  customerCodeInput = ''
): Promise<LicenseStatus> {
  const customerName = normalizeCustomerName(customerNameInput)
  if (!customerName) {
    return {
      valid: false,
      product_key: PRODUCT_KEY,
      product_name: PRODUCT_NAME,
      reason: 'customer_required',
      message: '请先填写单位名称',
      checkedAt: new Date().toISOString()
    }
  }

  const apiBase = getLicenseServerUrl()
  try {
    const device = await buildDevicePayload()
    const result = await httpPost(`${apiBase}/v2/trial`, {
      product_key: PRODUCT_KEY,
      customer_name: customerName,
      customer_code: normalizeCustomerName(customerCodeInput) || undefined,
      ...device
    })
    if (typeof result?.offline_public_key === 'string') saveOfflinePublicKey(result.offline_public_key)
    const status = toLicenseStatus(result)
    status.device_id = device.device_id
    if (status.valid && status.license_key) {
      writeCache(cacheFromStatus(status))
      saveLicenseMetadata(status)
    }
    return status
  } catch {
    return {
      valid: false,
      product_key: PRODUCT_KEY,
      product_name: PRODUCT_NAME,
      customer_name: customerName,
      reason: 'network_error',
      cached: false,
      checkedAt: new Date().toISOString()
    }
  }
}

export async function verifyLicense(licenseKeyInput = ''): Promise<LicenseStatus> {
  const requestedLicenseKey = normalizeLicenseKey(licenseKeyInput || getSavedLicenseKey())
  if (!requestedLicenseKey) {
    const offline = await readOfflineLicenseStatus()
    if (offline?.valid) return offline
    return (
      offline || {
        valid: false,
        product_key: PRODUCT_KEY,
        product_name: PRODUCT_NAME,
        reason: 'missing_product_or_license',
        checkedAt: new Date().toISOString()
      }
    )
  }

  const apiBase = getLicenseServerUrl()
  try {
    const preflight = await fetchOnlineLicenseStatus(apiBase, requestedLicenseKey)
    if (isOnlineBlockingStatus(preflight)) {
      writeCache(cacheFromStatus(preflight))
      saveLicenseMetadata(preflight)
      return preflight
    }

    const device = await buildDevicePayload()
    const result = await httpPost(`${apiBase}/v2/verify`, {
      product_key: PRODUCT_KEY,
      license_key: requestedLicenseKey,
      ...device
    })
    if (typeof result?.offline_public_key === 'string') saveOfflinePublicKey(result.offline_public_key)
    const status = toLicenseStatus(result)
    status.device_id = device.device_id
    if (status.valid && !status.license_key) status.license_key = requestedLicenseKey

    writeCache(cacheFromStatus(status))
    saveLicenseMetadata(status)
    return status
  } catch {
    const offline = await readOfflineLicenseStatus()
    if (offline?.valid) {
      writeCache(cacheFromStatus(offline))
      return offline
    }

    const cache = readCache()
    if (cache) return statusFromCache(cache)
    return {
      valid: false,
      product_key: PRODUCT_KEY,
      product_name: PRODUCT_NAME,
      license_key: requestedLicenseKey,
      reason: 'network_error',
      cached: false,
      checkedAt: new Date().toISOString()
    }
  }
}

export async function getCachedLicenseStatus(): Promise<LicenseStatus> {
  const offline = await readOfflineLicenseStatus()
  if (offline) return offline

  const cache = readCache()
  if (cache) return statusFromCache(cache)

  return {
    valid: false,
    product_key: PRODUCT_KEY,
    product_name: PRODUCT_NAME,
    license_key: getSavedLicenseKey() || undefined,
    reason: 'not_found'
  }
}
