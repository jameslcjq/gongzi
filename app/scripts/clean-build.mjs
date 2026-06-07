import { rm } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const root = resolve(process.cwd())
const targets = ['dist', 'dist-electron']

for (const target of targets) {
  const fullPath = resolve(root, target)
  const rel = relative(root, fullPath)
  if (rel.startsWith('..') || rel === '' || rel.includes(':')) {
    throw new Error(`Refuse to remove path outside project: ${fullPath}`)
  }
  await rm(fullPath, { recursive: true, force: true })
}
