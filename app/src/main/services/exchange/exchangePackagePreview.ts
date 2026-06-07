import { dialog } from 'electron'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import JSZip from 'jszip'
import type {
  ExchangePackageChecksumFile,
  ExchangePackageManifestSummary,
  ExchangePackagePreview
} from '../../../shared/types'

type RawChecksumEntry = {
  path: string
  sha256?: string
}

const PACKAGE_EXTENSION = '.ljgzpkg'
const RECEIPT_EXTENSION = '.ljgzreceipt'
const MANIFEST_PATH = 'manifest.json'
const CHECKSUMS_PATH = 'checksums.json'
const EXPECTED_FORMAT = 'laojiu.payroll.exchange-package'
const EXPECTED_RECEIPT_FORMAT = 'laojiu.payroll.exchange-receipt'

export async function chooseExchangePackageFile(): Promise<{ filePath: string; fileName: string } | null> {
  const result = await dialog.showOpenDialog({
    title: '选择工资业务摆渡包',
    properties: ['openFile'],
    filters: [{ name: '工资业务摆渡包', extensions: ['ljgzpkg'] }]
  })

  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  return {
    filePath,
    fileName: basename(filePath)
  }
}

export async function previewExchangePackage(filePath: string): Promise<ExchangePackagePreview> {
  return previewExchangeZip(filePath, PACKAGE_EXTENSION, EXPECTED_FORMAT, '只允许预览 .ljgzpkg 摆渡包')
}

export async function previewExchangeReceipt(filePath: string): Promise<ExchangePackagePreview> {
  return previewExchangeZip(filePath, RECEIPT_EXTENSION, EXPECTED_RECEIPT_FORMAT, '只允许预览 .ljgzreceipt 回执包')
}

async function previewExchangeZip(
  filePath: string,
  expectedExtension: string,
  expectedFormat: string,
  extensionError: string
): Promise<ExchangePackagePreview> {
  assertExchangeZipPath(filePath, expectedExtension, extensionError)
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) throw new Error('选择的路径不是文件')

  const buffer = await readFile(filePath)
  const warnings: string[] = []
  const errors: string[] = []
  const files: ExchangePackageChecksumFile[] = []
  const packageSha256 = sha256(buffer)

  let manifest: ExchangePackageManifestSummary | undefined
  let checksumEntries: RawChecksumEntry[] = []
  let zip: JSZip

  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (error) {
    throw new Error(`摆渡包不是有效 ZIP：${error instanceof Error ? error.message : String(error)}`)
  }

  const zipFiles = Object.values(zip.files).filter((file) => !file.dir)
  const unsafeEntries = zipFiles.filter((file) => isUnsafeZipPath(file.name))
  if (unsafeEntries.length > 0) {
    errors.push(`ZIP 内存在不安全路径：${unsafeEntries.map((file) => file.name).slice(0, 5).join('，')}`)
  }

  const zipFileMap = new Map(zipFiles.map((file) => [normalizeZipPath(file.name), file]))
  const manifestFile = zipFileMap.get(MANIFEST_PATH)
  const checksumsFile = zipFileMap.get(CHECKSUMS_PATH)

  if (!manifestFile) {
    errors.push('缺少 manifest.json')
  } else {
    try {
      manifest = summarizeManifest(JSON.parse(await manifestFile.async('string')))
      if (manifest.format && manifest.format !== expectedFormat) {
        warnings.push(`manifest.format 不是 ${expectedFormat}：${manifest.format}`)
      }
    } catch (error) {
      errors.push(`manifest.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!checksumsFile) {
    errors.push('缺少 checksums.json')
  } else {
    try {
      checksumEntries = parseChecksumEntries(JSON.parse(await checksumsFile.async('string')))
    } catch (error) {
      errors.push(`checksums.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const declaredPaths = new Set<string>()
  let matched = 0
  let missing = 0
  let mismatched = 0

  for (const entry of checksumEntries) {
    const normalizedPath = normalizeZipPath(entry.path)
    declaredPaths.add(normalizedPath)
    const target = zipFileMap.get(normalizedPath)
    const row: ExchangePackageChecksumFile = {
      path: normalizedPath,
      declaredSha256: entry.sha256
    }

    if (!target) {
      row.ok = false
      row.error = '文件不存在'
      missing++
      files.push(row)
      continue
    }

    const bytes = await target.async('nodebuffer')
    row.size = bytes.length
    row.actualSha256 = sha256(bytes)
    const declaredSha256 = entry.sha256 ? normalizeHash(entry.sha256) : undefined
    row.ok = Boolean(declaredSha256) && declaredSha256 === row.actualSha256
    if (row.ok) {
      matched++
    } else {
      row.error = entry.sha256 ? 'SHA256 不一致' : '缺少声明 SHA256'
      mismatched++
    }
    files.push(row)
  }

  const uncheckedFiles = zipFiles
    .map((file) => normalizeZipPath(file.name))
    .filter((name) => name !== MANIFEST_PATH && name !== CHECKSUMS_PATH && !declaredPaths.has(name))

  for (const name of uncheckedFiles) {
    files.push({
      path: name,
      ok: undefined,
      error: '未在 checksums.json 中声明'
    })
  }

  return {
    ok: errors.length === 0 && missing === 0 && mismatched === 0,
    filePath,
    fileName: basename(filePath),
    size: fileStat.size,
    packageSha256,
    manifest,
    checksumSummary: {
      declared: checksumEntries.length,
      matched,
      missing,
      mismatched,
      unchecked: uncheckedFiles.length
    },
    files,
    warnings,
    errors
  }
}

function assertExchangeZipPath(filePath: string, expectedExtension: string, message: string): void {
  if (!filePath) throw new Error('摆渡包路径为空')
  if (extname(filePath).toLowerCase() !== expectedExtension) {
    throw new Error(message)
  }
}

function summarizeManifest(raw: unknown): ExchangePackageManifestSummary {
  const manifest = asRecord(raw)
  const unit = asRecord(manifest.unit)
  const period = asRecord(manifest.period)
  return {
    format: asString(manifest.format),
    version: typeof manifest.version === 'number' || typeof manifest.version === 'string'
      ? manifest.version
      : undefined,
    packageId: asString(manifest.packageId),
    receiptId: asString(manifest.receiptId),
    originalPackageId: asString(manifest.originalPackageId),
    appName: asString(manifest.appName),
    appVersion: asString(manifest.appVersion),
    createdAt: asString(manifest.createdAt),
    businessType: asString(manifest.businessType),
    unitCode: asString(unit.unitImportCode),
    unitName: asString(unit.unitFullName),
    year: asNumber(period.year),
    month: asNumber(period.month),
    contains: asRecordOrUndefined(manifest.contains),
    sourceFiles: parseManifestSourceFiles(manifest.sourceFiles)
  }
}

function parseChecksumEntries(raw: unknown): RawChecksumEntry[] {
  const record = asRecord(raw)
  const source: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(record.files)
      ? record.files
      : Array.isArray(record.checksums)
        ? record.checksums
        : Object.entries(record).map(([path, value]) => ({ path, sha256: value }))

  return source
    .map((entry): RawChecksumEntry | null => {
      const item = asRecord(entry)
      const path = asString(item.path) || asString(item.file) || asString(item.name)
      const sha = asString(item.sha256) || asString(item.hash) || asString(item.checksum)
      if (!path) return null
      const result: RawChecksumEntry = { path }
      if (sha) result.sha256 = normalizeHash(sha)
      return result
    })
    .filter((entry): entry is RawChecksumEntry => Boolean(entry))
}

function parseManifestSourceFiles(raw: unknown): ExchangePackageManifestSummary['sourceFiles'] {
  if (!Array.isArray(raw)) return undefined
  return raw.map((item) => {
    const row = asRecord(item)
    return {
      kind: asString(row.kind),
      originalName: asString(row.originalName),
      sha256: asString(row.sha256)
    }
  })
}

function normalizeZipPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

function isUnsafeZipPath(value: string): boolean {
  const normalized = normalizeZipPath(value)
  return normalized.startsWith('/') ||
    normalized.includes(':') ||
    normalized.split('/').some((part) => part === '..')
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function normalizeHash(value: string): string {
  return value.trim().toLowerCase()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value)
  return Object.keys(record).length > 0 ? record : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
