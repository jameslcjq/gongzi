import { dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { getDatabase, get, run } from '../db/connection'
import {
  createDefaultVoucherCheckRuleLibrary,
  normalizeVoucherCheckRuleLibrary,
  VOUCHER_CHECK_RULE_LIBRARY_VERSION,
  type VoucherCheckRuleFileResult,
  type VoucherCheckRuleLibrary
} from '../../shared/voucherCheckRules'

const STORAGE_KEY = 'voucher-check-rules'

export async function readVoucherCheckRuleLibrary(): Promise<VoucherCheckRuleLibrary> {
  const database = await getDatabase()
  const row = await get<{ value: string }>(
    database,
    'SELECT value FROM app_settings WHERE key = ?',
    [STORAGE_KEY]
  )
  if (!row?.value) return createDefaultVoucherCheckRuleLibrary()
  try {
    return normalizeVoucherCheckRuleLibrary(JSON.parse(row.value))
  } catch {
    return createDefaultVoucherCheckRuleLibrary()
  }
}

export async function writeVoucherCheckRuleLibrary(
  library: VoucherCheckRuleLibrary
): Promise<VoucherCheckRuleLibrary> {
  const database = await getDatabase()
  const normalized = normalizeVoucherCheckRuleLibrary({
    ...library,
    updatedAt: new Date().toISOString()
  })
  await run(
    database,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [STORAGE_KEY, JSON.stringify(normalized)]
  )
  return normalized
}

export async function resetVoucherCheckRuleLibrary(): Promise<VoucherCheckRuleLibrary> {
  return writeVoucherCheckRuleLibrary(createDefaultVoucherCheckRuleLibrary())
}

export async function exportVoucherCheckRuleLibrary(): Promise<VoucherCheckRuleFileResult> {
  const library = await readVoucherCheckRuleLibrary()
  const libraryVersion = cleanFileNamePart(library.libraryVersion || VOUCHER_CHECK_RULE_LIBRARY_VERSION)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const result = await dialog.showSaveDialog({
    title: '导出账务检查规则库',
    defaultPath: `账务检查规则库-v${libraryVersion}-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true, reason: '用户取消' }
  }
  await writeFile(result.filePath, JSON.stringify(library, null, 2) + '\n', 'utf-8')
  return { ok: true, filePath: result.filePath, library }
}

export async function importVoucherCheckRuleLibrary(): Promise<VoucherCheckRuleFileResult> {
  const result = await dialog.showOpenDialog({
    title: '导入账务检查规则库',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, canceled: true, reason: '用户取消' }
  }
  const raw = await readFile(result.filePaths[0], 'utf-8')
  const library = await writeVoucherCheckRuleLibrary(normalizeVoucherCheckRuleLibrary(JSON.parse(raw)))
  return { ok: true, filePath: result.filePaths[0], library }
}

function cleanFileNamePart(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || VOUCHER_CHECK_RULE_LIBRARY_VERSION
}
