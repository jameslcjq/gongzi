import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorksheetMeta } from '../../shared/types'

let metadataCache: WorksheetMeta[] | null = null

function resolveMetadataPath(): string {
  const candidates = [
    resolve(process.cwd(), '../docs/data/worksheets-retained.json'),
    resolve(process.cwd(), 'docs/data/worksheets-retained.json'),
    resolve(__dirname, '../../../docs/data/worksheets-retained.json')
  ]

  const found = candidates.find((item) => existsSync(item))
  if (!found) throw new Error('未找到 worksheets-retained.json')
  return found
}

export function readWorksheetMetadata(): WorksheetMeta[] {
  if (metadataCache) return metadataCache
  metadataCache = JSON.parse(readFileSync(resolveMetadataPath(), 'utf-8')) as WorksheetMeta[]
  return metadataCache
}

export function writeWorksheetMetadata(worksheets: WorksheetMeta[]): void {
  writeFileSync(resolveMetadataPath(), JSON.stringify(worksheets, null, 2) + '\n', 'utf-8')
  metadataCache = worksheets
}

export function invalidateMetadataCache(): void {
  metadataCache = null
}
