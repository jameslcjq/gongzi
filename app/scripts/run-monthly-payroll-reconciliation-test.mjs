import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outFile = path.join(appRoot, '.codex-dev', 'monthly-payroll-reconciliation-core.test.mjs')

await mkdir(path.dirname(outFile), { recursive: true })
await build({
  entryPoints: [path.join(appRoot, 'scripts', 'monthly-payroll-reconciliation-core.test.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  logLevel: 'silent'
})

await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)
