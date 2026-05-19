import { all, getDatabase } from '../db/connection'
import type { WorksheetRecordValue } from '../../shared/types'
import { getWorksheetByName, tableNameOf, tryFindColumnByName } from './worksheetTable'

type Row = Record<string, WorksheetRecordValue | number | undefined>

type RankResumeIssue = {
  name: string
  rowNumber: number
  reason: 'not-found' | 'duplicate'
  matchedCount: number
}

export type RankResumeImportAdjustment = {
  filledNameRows: number
  filledIdCardRows: number
  missingNameRows: number
  notFoundRows: number
  duplicateRows: number
  issues: RankResumeIssue[]
}

const masterName = '\u4eba\u4e8b\u4fe1\u606f'
const nameField = '\u59d3\u540d'
const idCardField = '\u8eab\u4efd\u8bc1\u53f7\u7801'
const startTimeField = '\u5f00\u59cb\u65f6\u95f4'

export async function normalizeRankResumeImportedRows(
  rows: Array<Record<string, unknown>>
): Promise<RankResumeImportAdjustment> {
  const adjustment: RankResumeImportAdjustment = {
    filledNameRows: 0,
    filledIdCardRows: 0,
    missingNameRows: 0,
    notFoundRows: 0,
    duplicateRows: 0,
    issues: []
  }

  let currentName = ''
  for (const row of rows) {
    const rowName = normalizeName(row[nameField])
    if (rowName) {
      currentName = rowName
      row[nameField] = rowName
      continue
    }
    if (!currentName) {
      adjustment.missingNameRows += 1
      continue
    }
    row[nameField] = currentName
    adjustment.filledNameRows += 1
  }

  for (const row of rows) {
    const normalizedStartTime = normalizeRankResumeStartTime(row[startTimeField])
    if (normalizedStartTime) row[startTimeField] = normalizedStartTime
  }

  const masterByName = await loadMasterRowsByName()
  rows.forEach((row, index) => {
    const name = normalizeName(row[nameField])
    if (!name || normalizeIdCard(row[idCardField])) return

    const matched = masterByName.get(name) ?? []
    if (matched.length === 0) {
      adjustment.issues.push({ name, rowNumber: index + 2, reason: 'not-found', matchedCount: 0 })
      adjustment.notFoundRows += 1
      return
    }
    if (matched.length > 1) {
      adjustment.issues.push({
        name,
        rowNumber: index + 2,
        reason: 'duplicate',
        matchedCount: matched.length
      })
      adjustment.duplicateRows += 1
      return
    }

    const idCard = normalizeIdCard(matched[0].idCard)
    if (!idCard) {
      adjustment.issues.push({ name, rowNumber: index + 2, reason: 'not-found', matchedCount: 1 })
      adjustment.notFoundRows += 1
      return
    }

    row[idCardField] = idCard
    adjustment.filledIdCardRows += 1
  })

  return adjustment
}

async function loadMasterRowsByName(): Promise<Map<string, Array<{ idCard: unknown }>>> {
  const database = await getDatabase()
  const master = getWorksheetByName(masterName)
  const nameColumn = tryFindColumnByName(master, nameField)
  const idCardColumn = tryFindColumnByName(master, idCardField)
  if (!nameColumn || !idCardColumn) return new Map()

  const rows = await all<Row>(database, `SELECT * FROM ${tableNameOf(master)}`)
  const result = new Map<string, Array<{ idCard: unknown }>>()
  for (const row of rows) {
    const name = normalizeName(row[nameColumn])
    if (!name) continue
    const bucket = result.get(name) ?? []
    bucket.push({ idCard: row[idCardColumn] })
    result.set(name, bucket)
  }
  return result
}

function normalizeName(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim().replace(/\s+/g, '')
}

function normalizeIdCard(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim().toUpperCase()
}

export function normalizeRankResumeStartTime(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value).trim().replace(/\s+/g, '')
  if (!text) return ''

  const compact = text.match(/^(\d{4})(\d{2})$/)
  if (compact) return `${compact[1]}${compact[2]}`

  const compactSingleMonth = text.match(/^(\d{4})(\d)$/)
  if (compactSingleMonth) return `${compactSingleMonth[1]}0${compactSingleMonth[2]}`

  const separated = text.match(/^(\d{4})[.\-/年](\d{1,2})(?:月.*)?$/)
  if (separated) return `${separated[1]}${separated[2].padStart(2, '0')}`

  return text
}
