// 注入脚本语法校验器（R-03 阶段1）
// 背景：src/renderer/src/integration/ 下的自动化脚本以"TS 函数返回巨型 JS 模板字符串"的形式存在，
// vue-tsc/eslint 对字符串内的代码失明，语法错误只能在真实一体化页面上运行时才暴露。
// 本脚本在构建期把每个 build*Script 函数实际调用一遍，取出生成的 JS 字符串，
// 用 `node --check` 做语法解析校验；任何一个脚本语法损坏即退出码 1（接入 CI）。
// 注意：只做语法校验，不执行脚本，不依赖 electron/浏览器环境。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const integrationDir = path.join(appRoot, 'src', 'renderer', 'src', 'integration')
const userscriptsDir = path.join(appRoot, 'dev-userscripts')
const tempDir = path.join(appRoot, '.tmp-script-check')

fs.mkdirSync(tempDir, { recursive: true })

// Vite 的 `?raw` 导入（pdf-lib bundle、salaryPlanInput.user.js）esbuild 不认识，补一个等价 loader。
const rawLoaderPlugin = {
  name: 'vite-raw-loader',
  setup(buildApi) {
    buildApi.onResolve({ filter: /\?raw$/ }, (args) => {
      const cleaned = args.path.replace(/\?raw$/, '')
      let resolved
      if (cleaned.startsWith('.')) {
        resolved = path.resolve(args.resolveDir, cleaned)
      } else {
        resolved = path.join(appRoot, 'node_modules', cleaned)
      }
      return { path: resolved, namespace: 'raw-text' }
    })
    buildApi.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
      contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf-8'))}`,
      loader: 'js'
    }))
  }
}

async function loadModule(sourceFile) {
  const outfile = path.join(tempDir, path.basename(sourceFile).replace(/\.ts$/, '.mjs'))
  await build({
    entryPoints: [sourceFile],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
    plugins: [rawLoaderPlugin],
    alias: {
      '@shared': path.join(appRoot, 'src', 'shared'),
      '@renderer': path.join(appRoot, 'src', 'renderer', 'src')
    }
  })
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
}

// 各 builder 的参数候选：按顺序尝试，第一个返回"像脚本的字符串"的调用生效。
const ARG_VARIANTS = [
  [],
  [{}],
  [''],
  ['voucher'],
  ['', ''],
  ['', '', ''],
  [[]],
  [true, 'x'],
  [{}, {}],
  // salarySystemImportScript 需要 mode+file 结构
  [{ mode: 'salary', file: { fileName: 'check.xls', base64: '', size: 0 } }]
]

function nodeSyntaxCheck(code, label) {
  const file = path.join(tempDir, `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.check.js`)
  fs.writeFileSync(file, code, 'utf-8')
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' })
  return { ok: result.status === 0, stderr: (result.stderr || '').trim() }
}

let checked = 0
let failed = 0
const skipped = []

const files = fs
  .readdirSync(integrationDir)
  .filter((name) => name.endsWith('.ts'))
  .sort()

for (const name of files) {
  const sourceFile = path.join(integrationDir, name)
  let mod
  try {
    mod = await loadModule(sourceFile)
  } catch (error) {
    console.error(`✗ ${name} 模块打包失败：${error.message}`)
    failed += 1
    continue
  }
  // 只认 build*Script 命名的"脚本生成器"（同步、纯函数、返回字符串）。
  // 不能放宽到 build* —— integration 下还有 buildReceiptInteractive 这类真业务函数，误执行有副作用。
  const builders = Object.entries(mod).filter(
    ([key, value]) => /^build.*Script$/.test(key) && typeof value === 'function'
  )
  for (const [fnName, fn] of builders) {
    let code = null
    let lastError = ''
    for (const args of ARG_VARIANTS) {
      try {
        const result = fn(...args)
        if (result && typeof result.then === 'function') {
          // 异步函数不是脚本生成器；吞掉 rejection 防止进程崩溃
          result.catch(() => {})
          lastError = '返回 Promise（非脚本生成器）'
          break
        }
        if (typeof result === 'string' && result.trim().length > 40) {
          code = result
          break
        }
      } catch (error) {
        lastError = error.message
      }
    }
    if (code == null) {
      skipped.push(`${name}#${fnName}（无参数组合能生成脚本${lastError ? '：' + lastError : ''}）`)
      continue
    }
    const { ok, stderr } = nodeSyntaxCheck(code, `${name}-${fnName}`)
    checked += 1
    if (ok) {
      console.log(`✓ ${name} ${fnName} (${code.length} chars)`)
    } else {
      failed += 1
      console.error(`✗ ${name} ${fnName} 语法错误：\n${stderr}`)
    }
  }
}

// 离线油猴产物一并校验（含手写的 salaryPlanInput.user.js）
if (fs.existsSync(userscriptsDir)) {
  for (const name of fs.readdirSync(userscriptsDir).filter((n) => n.endsWith('.user.js')).sort()) {
    const code = fs.readFileSync(path.join(userscriptsDir, name), 'utf-8')
    const { ok, stderr } = nodeSyntaxCheck(code, `userscript-${name}`)
    checked += 1
    if (ok) {
      console.log(`✓ dev-userscripts/${name}`)
    } else {
      failed += 1
      console.error(`✗ dev-userscripts/${name} 语法错误：\n${stderr}`)
    }
  }
}

fs.rmSync(tempDir, { recursive: true, force: true })

if (skipped.length) {
  console.log(`\n跳过 ${skipped.length} 个 builder（请补参数候选）：`)
  for (const item of skipped) console.log(`  - ${item}`)
}
console.log(`\n校验 ${checked} 个脚本，失败 ${failed} 个`)
process.exit(failed > 0 ? 1 : 0)
