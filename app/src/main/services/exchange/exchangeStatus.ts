import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  exchangeFailedFolder,
  exchangeImportedFolder,
  exchangeInboxFolder,
  exchangeOutboxFolder,
  exchangeQuarantineFolder,
  exchangeRoot,
  exchangeTempFolder
} from '../../config/paths'
import type {
  ExchangeMediaSummary,
  ExchangePackageFileSummary,
  ExchangePackageKind,
  ExchangePackageLocation,
  ExchangeStatus
} from '../../../shared/types'

const PACKAGE_EXTENSION = '.ljgzpkg'
const RECEIPT_EXTENSION = '.ljgzreceipt'
const FILE_STABLE_MS = 1500

export function ensureExchangeFolders(): void {
  for (const folder of [
    exchangeRoot,
    exchangeInboxFolder,
    exchangeImportedFolder,
    exchangeFailedFolder,
    exchangeQuarantineFolder,
    exchangeOutboxFolder,
    exchangeTempFolder
  ]) {
    mkdirSync(folder, { recursive: true })
  }
}

export function getExchangeStatus(): ExchangeStatus {
  ensureExchangeFolders()
  const warnings: string[] = []
  const localInboxPackages = scanPackageDirectory(exchangeInboxFolder, 'local-inbox', warnings)
  const localOutboxPackages = scanPackageDirectory(exchangeOutboxFolder, 'local-outbox', warnings)
  const mediaScan = scanExchangeMedia(warnings)

  return {
    paths: {
      root: exchangeRoot,
      inbox: exchangeInboxFolder,
      imported: exchangeImportedFolder,
      failed: exchangeFailedFolder,
      quarantine: exchangeQuarantineFolder,
      outbox: exchangeOutboxFolder,
      temp: exchangeTempFolder
    },
    localInboxPackages,
    localOutboxPackages,
    mediaPackages: mediaScan.packages,
    media: mediaScan.media,
    warnings,
    lastScannedAt: new Date().toISOString()
  }
}

function scanExchangeMedia(warnings: string[]): {
  media: ExchangeMediaSummary[]
  packages: ExchangePackageFileSummary[]
} {
  const media: ExchangeMediaSummary[] = []
  const packages: ExchangePackageFileSummary[] = []

  for (let code = 68; code <= 90; code++) {
    const driveRoot = `${String.fromCharCode(code)}:\\`
    if (!existsSync(driveRoot)) continue

    const standardRoot = join(driveRoot, '老九交换包')
    const standardOutbox = join(standardRoot, '工资系统', 'outbox')
    const standardReceipt = join(standardRoot, '工资系统', 'receipt')
    const markerPath = join(standardRoot, 'laojiu-exchange.json')
    const fallbackOutbox = join(driveRoot, 'LaoJiuExchange', 'gongzi', 'outbox')

    const marker = readMediaMarker(markerPath, warnings)
    const standardPackages = scanPackageDirectory(standardOutbox, 'media-outbox', warnings)
    const fallbackPackages = scanPackageDirectory(fallbackOutbox, 'media-outbox', warnings)
    const receiptPackages = scanPackageDirectory(standardReceipt, 'media-receipt', warnings)
    const rootPackages = scanPackageDirectory(driveRoot, 'media-root', warnings)
    const drivePackages = [
      ...standardPackages,
      ...fallbackPackages,
      ...receiptPackages,
      ...rootPackages
    ]

    if (marker || drivePackages.length > 0) {
      media.push({
        driveRoot,
        markerPath: marker ? markerPath : undefined,
        mediaId: marker?.mediaId,
        displayName: marker?.displayName,
        outboxPath: existsSync(standardOutbox)
          ? standardOutbox
          : existsSync(fallbackOutbox)
            ? fallbackOutbox
            : undefined,
        receiptPath: existsSync(standardReceipt) ? standardReceipt : undefined,
        packageCount: drivePackages.filter((file) => file.kind === 'monthly-package').length,
        receiptCount: drivePackages.filter((file) => file.kind === 'receipt').length
      })
      packages.push(...drivePackages)
    }
  }

  return { media, packages }
}

function scanPackageDirectory(
  dir: string,
  location: ExchangePackageLocation,
  warnings: string[]
): ExchangePackageFileSummary[] {
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((filePath) => {
        const extension = extname(filePath).toLowerCase()
        return extension === PACKAGE_EXTENSION || extension === RECEIPT_EXTENSION
      })
      .map((filePath) => summarizePackageFile(filePath, location))
      .filter((file): file is ExchangePackageFileSummary => Boolean(file))
  } catch (error) {
    warnings.push(`扫描交换目录失败：${dir}，${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

function summarizePackageFile(
  filePath: string,
  location: ExchangePackageLocation
): ExchangePackageFileSummary | null {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    const extension = extname(filePath).toLowerCase()
    const kind: ExchangePackageKind = extension === RECEIPT_EXTENSION ? 'receipt' : 'monthly-package'

    return {
      filePath,
      fileName: basename(filePath),
      kind,
      location,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      stable: Date.now() - stat.mtimeMs >= FILE_STABLE_MS
    }
  } catch {
    return null
  }
}

function readMediaMarker(
  markerPath: string,
  warnings: string[]
): { mediaId?: string; displayName?: string } | null {
  if (!existsSync(markerPath)) return null

  try {
    const raw = readFileSync(markerPath, 'utf-8')
    const parsed = JSON.parse(raw) as { mediaId?: unknown; displayName?: unknown }
    return {
      mediaId: typeof parsed.mediaId === 'string' ? parsed.mediaId : undefined,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined
    }
  } catch (error) {
    warnings.push(`读取摆渡盘标记失败：${markerPath}，${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
