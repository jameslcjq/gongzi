import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const outDir = path.join(root, 'dev-userscripts')
const tempDir = path.join(root, '.tmp-userscript-build')

fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(tempDir, { recursive: true })

function metadata({ name, version, description }) {
  return [
    '// ==UserScript==',
    `// @name         ${name}`,
    '// @namespace    https://www.hujiuxi.top/gongzi/dev',
    `// @version      ${version}`,
    `// @description  ${description}`,
    '// @author       老九 / Codex',
    '// @match        http://172.24.147.202/*',
    '// @run-at       document-idle',
    '// @grant        none',
    '// ==/UserScript==',
    ''
  ].join('\n')
}

async function bundleModule(sourcePath, outName) {
  const outfile = path.join(tempDir, outName)
  await build({
    entryPoints: [path.join(root, sourcePath)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`)
}

function writeFile(name, content) {
  fs.writeFileSync(path.join(outDir, name), content.replace(/\r?\n/g, '\r\n'), 'utf-8')
}

function extractAsyncBody(script, functionName) {
  const start = script.indexOf(`;(async function ${functionName}() {`)
  if (start < 0) throw new Error(`Cannot find ${functionName} start`)
  const bodyStart = script.indexOf('{', start) + 1
  const end = script.lastIndexOf('})()')
  if (end < 0) throw new Error(`Cannot find ${functionName} end`)
  return script.slice(bodyStart, end).trim()
}

function diagnosticScript() {
  return `${metadata({
    name: '一体化页面诊断采集（离线）',
    version: '2026.06.04',
    description: '离线采集当前一体化页面的按钮、iframe、表格字段和页面文字，用于定位注入脚本问题。'
  })}
(function () {
  'use strict'

  function normalize(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim()
  }

  function safe(fn, fallback) {
    try { return fn() } catch (error) { return fallback }
  }

  function visible(el) {
    return safe(function () {
      var style = el.ownerDocument.defaultView.getComputedStyle(el)
      var rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }, true)
  }

  function inspectDoc(win, depth) {
    var doc = win.document
    var buttons = Array.prototype.slice.call(doc.querySelectorAll('a,button,span,[role="button"],.l-btn-text,.btn,.more,.tit'))
      .filter(visible)
      .map(function (el) {
        return {
          tag: el.tagName,
          id: el.id || '',
          className: String(el.className || '').slice(0, 160),
          text: normalize(el.innerText || el.textContent || el.title || '').slice(0, 120)
        }
      })
      .filter(function (item) { return item.text })
      .slice(0, 200)
    var rows = Array.prototype.slice.call(doc.querySelectorAll('tr.datagrid-row, tr[id*="datagrid-row"]')).slice(0, 30)
    var tableFields = rows.map(function (row) {
      return {
        id: row.id || '',
        index: row.getAttribute('datagrid-row-index') || '',
        fields: Array.prototype.slice.call(row.querySelectorAll('[field]')).map(function (cell) {
          return {
            field: cell.getAttribute('field'),
            text: normalize(cell.innerText || cell.textContent || '').slice(0, 80)
          }
        }).slice(0, 40)
      }
    })
    var iframes = Array.prototype.slice.call(doc.querySelectorAll('iframe')).map(function (iframe) {
      return {
        src: iframe.src || iframe.getAttribute('src') || '',
        id: iframe.id || '',
        name: iframe.name || '',
        className: String(iframe.className || '').slice(0, 120)
      }
    })
    return {
      depth: depth,
      href: safe(function () { return win.location.href }, ''),
      title: doc.title || '',
      textPreview: normalize(doc.body && (doc.body.innerText || doc.body.textContent) || '').slice(0, 3000),
      buttons: buttons,
      iframes: iframes,
      tableFields: tableFields
    }
  }

  function collect(win, depth, result) {
    result.push(safe(function () { return inspectDoc(win, depth) }, { depth: depth, error: 'document access failed' }))
    if (depth >= 3) return
    safe(function () {
      for (var i = 0; i < win.frames.length; i++) collect(win.frames[i], depth + 1, result)
    }, null)
  }

  function downloadJson(data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = '一体化页面诊断-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'
    document.body.appendChild(a)
    a.click()
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 1000)
  }

  function addButton() {
    if (document.getElementById('gongzi-page-diagnostic-btn')) return
    var btn = document.createElement('button')
    btn.id = 'gongzi-page-diagnostic-btn'
    btn.textContent = '采集页面诊断'
    btn.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:8px 12px;border:0;border-radius:4px;background:#1f6feb;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.22)'
    btn.onclick = function () {
      var frames = []
      collect(window.top || window, 0, frames)
      downloadJson({ capturedAt: new Date().toISOString(), frames: frames })
    }
    document.body.appendChild(btn)
  }

  addButton()
  setInterval(addButton, 1000)
})()
`
}

function insuranceUserScript(coreScript) {
  let body = extractAsyncBody(coreScript, 'pushInsurance')
  body = body.replace(/\s*const RECORDS = \[\]\s*\n/, '')
  return `${metadata({
    name: '工资系统-推送保险调试（离线）',
    version: '2026.06.04',
    description: '离线油猴调试版：粘贴保险记录 JSON 后推送到一体化直接支付外部数据页面。'
  })}
(function () {
  'use strict'

  function addButton() {
    if (document.getElementById('gongzi-insurance-debug-btn')) return
    var btn = document.createElement('button')
    btn.id = 'gongzi-insurance-debug-btn'
    btn.textContent = '推送保险调试'
    btn.style.cssText = 'position:fixed;right:18px;bottom:58px;z-index:2147483647;padding:8px 12px;border:0;border-radius:4px;background:#0f766e;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.22)'
    btn.onclick = async function () {
      var raw = window.prompt('粘贴保险 records JSON 数组。必须是软件生成的保险导入记录数组。')
      if (!raw) return
      var records
      try {
        records = JSON.parse(raw)
      } catch (error) {
        alert('JSON 格式不正确：' + error.message)
        return
      }
      if (!Array.isArray(records)) {
        alert('请粘贴数组，例如 [{...}]')
        return
      }
      await runPushInsurance(records)
    }
    document.body.appendChild(btn)
  }

  async function runPushInsurance(RECORDS) {
${body.split('\n').map((line) => `    ${line}`).join('\n')}
  }

  addButton()
  setInterval(addButton, 1000)
})()
`
}

function voucherUserScript(coreScript) {
  let body = extractAsyncBody(coreScript, 'pushVoucher')
  body = body
    .replace(/const FILE_NAME = ""\n/, '')
    .replace(/  const BASE64 = ""\n/, '')
    .replace(/  const RUN_LABEL = ""\n/, '')
  return `${metadata({
    name: '工资系统-凭证推送调试（离线）',
    version: '2026.06.04',
    description: '离线油猴调试版：在一体化凭证录入页面选择本地凭证 xlsx 后上传。'
  })}
(function () {
  'use strict'

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () {
        var text = String(reader.result || '')
        resolve(text.indexOf(',') >= 0 ? text.split(',').pop() : text)
      }
      reader.onerror = function () { reject(reader.error || new Error('读取文件失败')) }
      reader.readAsDataURL(file)
    })
  }

  function addButton() {
    if (document.getElementById('gongzi-voucher-debug-btn')) return
    var btn = document.createElement('button')
    btn.id = 'gongzi-voucher-debug-btn'
    btn.textContent = '凭证推送调试'
    btn.style.cssText = 'position:fixed;right:18px;bottom:98px;z-index:2147483647;padding:8px 12px;border:0;border-radius:4px;background:#7c3aed;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.22)'
    btn.onclick = function () {
      var input = document.createElement('input')
      input.type = 'file'
      input.accept = '.xlsx,.xls'
      input.onchange = async function () {
        var file = input.files && input.files[0]
        if (!file) return
        var label = window.prompt('本次凭证推送标签', file.name) || file.name
        var base64 = await fileToBase64(file)
        await runPushVoucher(file.name, base64, label)
      }
      input.click()
    }
    document.body.appendChild(btn)
  }

  async function runPushVoucher(FILE_NAME, BASE64, RUN_LABEL) {
${body.split('\n').map((line) => `    ${line}`).join('\n')}
  }

  addButton()
  setInterval(addButton, 1000)
})()
`
}

function quotaUserScript(coreScript) {
  const localSummaryReader = `var LOCAL_SUMMARY = (function () {
    try {
      var raw = window.localStorage && window.localStorage.getItem('__salary_quota_match_local_summary__')
      if (raw) return JSON.parse(raw)
    } catch (error) {}
    return {
      ok: true,
      activeOtherOneTotal: 0,
      activeBasicPerformanceTotal: 0,
      activeHousingTotal: 0,
      activeAllowanceTotal: 0,
      retiredHousingTotal: 0,
      retiredBackpayTotal: 0,
      retiredActualPayTotal: 0,
      otherActualPayTotal: 0,
      message: '油猴离线测试默认汇总为 0；如需真实拆分，请在 localStorage.__salary_quota_match_local_summary__ 写入 JSON。'
    }
  })()`
  const patched = coreScript.replace(/var LOCAL_SUMMARY = \{[\s\S]*?\}\n  var PERSONNEL_EXPENSE_CODES/, `${localSummaryReader}\n  var PERSONNEL_EXPENSE_CODES`)
  return `${metadata({
    name: '工资系统-额度匹配调试（离线）',
    version: '2026.06.09c',
    description: '离线油猴调试版：在一体化生成支付页面测试额度匹配、修改、保存、重新选行。'
  })}
${patched}
`
}

const quotaModule = await bundleModule('src/renderer/src/integration/salaryQuotaMatchScript.ts', 'salaryQuotaMatchScript.mjs')
const insuranceModule = await bundleModule('src/renderer/src/integration/pushInsuranceScript.ts', 'pushInsuranceScript.mjs')
const voucherModule = await bundleModule('src/renderer/src/integration/pushVoucherScript.ts', 'pushVoucherScript.mjs')

writeFile('00-一体化页面诊断采集-离线.user.js', diagnosticScript())
writeFile('01-人员经费录入-离线测试.user.js', fs.readFileSync(path.join(root, 'src/renderer/src/integration/salaryPlanInput.user.js'), 'utf-8'))
writeFile('02-额度匹配-离线测试.user.js', quotaUserScript(quotaModule.buildSalaryQuotaMatchScript({ autoStart: false, showPageButton: true })))
writeFile('03-推送保险-离线调试.user.js', insuranceUserScript(insuranceModule.buildPushInsuranceScript([])))
writeFile('04-凭证推送-离线调试.user.js', voucherUserScript(voucherModule.buildPushVoucherScript('', '', '')))

console.log(`Generated userscripts in ${outDir}`)
