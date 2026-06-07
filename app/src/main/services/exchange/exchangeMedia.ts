import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import { basename, join, normalize } from 'node:path'
import { getDatabase, get, run } from '../../db/connection'

const MARKER_DIR_NAME = '老九交换包'
const MARKER_FILE_NAME = 'laojiu-exchange.json'
const PRODUCT_DIR_NAME = '工资系统'
const MEDIA_ID_KEY = 'exchange_outer_media_id'
const LAST_OUTBOX_KEY = 'exchange_outer_last_outbox'

export type ExchangeMediaCopyKind = 'package' | 'receipt'

export type ExchangeMediaCopyResult = {
  copied: boolean
  mediaPath?: string
  mediaId?: string
  reason?: string
}

type ExchangeMediaTarget = {
  mediaId: string
  outboxPath: string
  receiptPath: string
}

export async function copyExchangeFileToPreferredMedia(
  localPath: string,
  expectedSha256: string,
  kind: ExchangeMediaCopyKind,
  warnings: string[],
  options: { allowPrompt?: boolean; displayName?: string } = {}
): Promise<ExchangeMediaCopyResult> {
  const target = await resolvePreferredMediaTarget(options.allowPrompt ?? false, options.displayName)
  if (!target) {
    warnings.push('未找到摆渡目录，文件已保存到本机交换包 outbox')
    return { copied: false, reason: 'media-not-found' }
  }

  const targetDir = kind === 'receipt' ? target.receiptPath : target.outboxPath
  mkdirSync(targetDir, { recursive: true })
  const mediaPath = join(targetDir, basename(localPath))

  if (existsSync(mediaPath)) {
    const existingSha = await sha256File(mediaPath)
    if (existingSha === expectedSha256) {
      return { copied: false, mediaPath, mediaId: target.mediaId, reason: 'already-exists' }
    }
    warnings.push(`摆渡目录已有同名文件但校验值不同，已保留本机文件未覆盖：${mediaPath}`)
    return { copied: false, mediaPath, mediaId: target.mediaId, reason: 'conflict' }
  }

  const tmpPath = `${mediaPath}.tmp`
  if (existsSync(tmpPath)) unlinkSync(tmpPath)
  await copyFile(localPath, tmpPath)
  const copiedSha = await sha256File(tmpPath)
  if (copiedSha !== expectedSha256) {
    unlinkSync(tmpPath)
    warnings.push(`复制到摆渡目录后校验失败，已删除临时文件：${mediaPath}`)
    return { copied: false, mediaPath, mediaId: target.mediaId, reason: 'sha-mismatch' }
  }
  renameSync(tmpPath, mediaPath)
  return { copied: true, mediaPath, mediaId: target.mediaId }
}

async function resolvePreferredMediaTarget(
  allowPrompt: boolean,
  displayName?: string
): Promise<ExchangeMediaTarget | null> {
  const settings = await readMediaSettings()

  if (settings.lastOutbox && existsSync(settings.lastOutbox)) {
    const root = normalizeMarkerRootFromOutbox(settings.lastOutbox)
    return ensureMediaTarget(root, settings.mediaId, displayName)
  }

  const scanned = scanMarkedMedia(settings.mediaId)
  if (scanned) return scanned

  if (!allowPrompt) return null
  const selectedRoot = await chooseMediaRoot()
  if (!selectedRoot) return null
  return ensureMediaTarget(selectedRoot, settings.mediaId, displayName)
}

async function chooseMediaRoot(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择摆渡盘或摆渡目录',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '使用此目录'
  })
  if (result.canceled || !result.filePaths[0]) return null
  return normalizeMarkerRoot(result.filePaths[0])
}

function scanMarkedMedia(preferredMediaId?: string): ExchangeMediaTarget | null {
  const all: ExchangeMediaTarget[] = []
  for (let code = 68; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`
    if (!existsSync(root)) continue
    const markerRoot = join(root, MARKER_DIR_NAME)
    const marker = readMarker(markerRoot)
    if (!marker?.mediaId) continue
    const target = buildMediaTarget(markerRoot, marker.mediaId)
    all.push(target)
    if (preferredMediaId && marker.mediaId === preferredMediaId) return target
  }
  return all[0] ?? null
}

async function ensureMediaTarget(root: string, preferredMediaId?: string, displayName?: string): Promise<ExchangeMediaTarget> {
  mkdirSync(root, { recursive: true })
  const existing = readMarker(root)
  const mediaId = existing?.mediaId || preferredMediaId || randomUUID()
  const target = buildMediaTarget(root, mediaId)
  mkdirSync(target.outboxPath, { recursive: true })
  mkdirSync(target.receiptPath, { recursive: true })
  writeMarker(root, {
    mediaId,
    displayName: existing?.displayName || displayName || '老九工资系统摆渡盘'
  })
  await writeMediaSettings(mediaId, target.outboxPath)
  return target
}

function buildMediaTarget(root: string, mediaId: string): ExchangeMediaTarget {
  return {
    mediaId,
    outboxPath: join(root, PRODUCT_DIR_NAME, 'outbox'),
    receiptPath: join(root, PRODUCT_DIR_NAME, 'receipt')
  }
}

function normalizeMarkerRoot(selectedPath: string): string {
  const normalized = normalize(selectedPath)
  const index = normalized.toLowerCase().indexOf(MARKER_DIR_NAME.toLowerCase())
  if (index >= 0) return normalized.slice(0, index + MARKER_DIR_NAME.length)
  return join(normalized, MARKER_DIR_NAME)
}

function normalizeMarkerRootFromOutbox(outboxPath: string): string {
  return normalizeMarkerRoot(outboxPath)
}

function readMarker(root: string): { mediaId?: string; displayName?: string } | null {
  const markerPath = join(root, MARKER_FILE_NAME)
  if (!existsSync(markerPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
      mediaId?: unknown
      displayName?: unknown
    }
    return {
      mediaId: typeof parsed.mediaId === 'string' ? parsed.mediaId : undefined,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined
    }
  } catch {
    return null
  }
}

function writeMarker(root: string, marker: { mediaId: string; displayName: string }): void {
  const markerPath = join(root, MARKER_FILE_NAME)
  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        format: 'laojiu.exchange.media',
        version: 1,
        mediaId: marker.mediaId,
        productFamily: 'laojiu',
        products: ['gongzi'],
        displayName: marker.displayName,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    ) + '\n',
    'utf-8'
  )
}

async function readMediaSettings(): Promise<{ mediaId?: string; lastOutbox?: string }> {
  const database = await getDatabase()
  const mediaId = await get<{ value: string | null }>(
    database,
    'SELECT value FROM app_settings WHERE key = ?',
    [MEDIA_ID_KEY]
  )
  const lastOutbox = await get<{ value: string | null }>(
    database,
    'SELECT value FROM app_settings WHERE key = ?',
    [LAST_OUTBOX_KEY]
  )
  return {
    mediaId: mediaId?.value || undefined,
    lastOutbox: lastOutbox?.value || undefined
  }
}

async function writeMediaSettings(mediaId: string, outboxPath: string): Promise<void> {
  const database = await getDatabase()
  await run(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [MEDIA_ID_KEY, mediaId]
  )
  await run(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [LAST_OUTBOX_KEY, outboxPath]
  )
}

async function sha256File(filePath: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}
