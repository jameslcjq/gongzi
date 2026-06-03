/**
 * 把"凭证_*.xlsx"推送到一体化系统的"凭证导入"。
 *
 * 流程（来自抓包）：
 *   1. （可选）确保已在 gld-web/voucher 模块上下文
 *   2. POST /gld-account-server/importAccount/gl_import_file_json?menuid=227b6262...
 *      body: FormData { file: <xlsx blob>, param: <导入配置 JSON> }   ← 与保险不同，这里是文件上传
 *   3. 服务端异步处理（约 20-30 秒），返回后即完成
 */

const VOUCHER_MENUID = '227b6262406c4afb836d98abe98d4f85'
const VOUCHER_IMPORT_PARAM = {
  modelType: '29',
  displayMode: '0',
  currentModelId: 'c6025c601352431c977b538e99c56c5f',
  incrementFlag: '1'
}

export function buildPushVoucherScript(
  fileName: string,
  base64: string,
  runLabel: string
): string {
  return `
;(async function pushVoucher() {
  const FILE_NAME = ${JSON.stringify(fileName)}
  const BASE64 = ${JSON.stringify(base64)}
  const RUN_LABEL = ${JSON.stringify(runLabel)}
  const MENUID = ${JSON.stringify(VOUCHER_MENUID)}
  const IMPORT_PARAM = ${JSON.stringify(VOUCHER_IMPORT_PARAM)}

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function normalize(v) { return String(v || '').replace(/\\s+/g, '') }

  function ensureStatus() {
    let el = document.getElementById('voucher-push-status')
    if (el) return el
    el = document.createElement('div')
    el.id = 'voucher-push-status'
    el.style.cssText = [
      'position:fixed','top:230px','right:24px','min-width:320px','max-width:520px',
      'padding:14px 18px','background:rgba(33,33,33,0.92)','color:#fff',
      'border-radius:8px','font-size:13px','line-height:1.6',
      'box-shadow:0 6px 20px rgba(0,0,0,0.35)','z-index:2147483647','white-space:pre-wrap'
    ].join(';')
    document.body.appendChild(el)
    return el
  }
  function status(text, kind) {
    const el = ensureStatus()
    el.textContent = text
    if (kind === 'ok') el.style.background = 'rgba(38,128,80,0.95)'
    else if (kind === 'err') el.style.background = 'rgba(180,40,40,0.95)'
    else if (kind === 'warn') el.style.background = 'rgba(200,140,0,0.95)'
    else el.style.background = 'rgba(33,33,33,0.92)'
    console.log('[voucher-push]', text)
  }
  function clearStatusLater(ms) {
    setTimeout(function () {
      const el = document.getElementById('voucher-push-status')
      if (el && el.parentNode) el.parentNode.removeChild(el)
    }, ms || 10000)
  }

  function isVisible(el) {
    try {
      var style = el.ownerDocument.defaultView.getComputedStyle(el)
      var rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    } catch (e) { return true }
  }

  function textExistsIn(win, text) {
    try {
      var body = win.document.body
      if (body && normalize(body.innerText).indexOf(normalize(text)) >= 0) return true
      var frames = win.frames
      for (var i = 0; i < frames.length; i++) {
        if (textExistsIn(frames[i], text)) return true
      }
    } catch (e) {}
    return false
  }

  function clickTextInWin(win, text) {
    try {
      var wanted = normalize(text)
      var nodes = Array.prototype.slice.call(
        win.document.querySelectorAll('a,button,span,div,li,td')
      )
      var exact = [], partial = []
      nodes.forEach(function (el) {
        if (!isVisible(el)) return
        var own = normalize(el.innerText || el.textContent || el.title || '')
        if (!own) return
        if (own === wanted) exact.push(el)
        else if (own.indexOf(wanted) >= 0 && own.length <= wanted.length + 30) partial.push(el)
      })
      var picked = exact[0] || partial[0]
      if (picked) {
        picked.scrollIntoView({ block: 'center', inline: 'center' })
        picked.click()
        return true
      }
      var frames = win.frames
      for (var i = 0; i < frames.length; i++) {
        if (clickTextInWin(frames[i], text)) return true
      }
    } catch (e) {}
    return false
  }

  async function clickAndWait(root, text, waitText, timeoutMs) {
    if (waitText && textExistsIn(root, waitText)) return true
    var clicked = clickTextInWin(root, text)
    if (!clicked) return false
    var deadline = Date.now() + (timeoutMs || 60000)
    while (Date.now() < deadline) {
      if (!waitText || textExistsIn(root, waitText)) return true
      await sleep(500)
    }
    return true
  }

  // 在 gld-web 域名下，凭证录入 / 凭证管理上下文里发请求最稳
  function findGldWindow(win) {
    try {
      if (/gld-web\\/gl\\//i.test(win.location.href)) return win
    } catch (e) {}
    try {
      var iframes = win.document.querySelectorAll('iframe')
      for (var i = 0; i < iframes.length; i++) {
        var src = iframes[i].src || iframes[i].getAttribute('src') || ''
        if (/gld-web\\/gl\\//i.test(src)) {
          try { return iframes[i].contentWindow || win } catch (e) { return win }
        }
      }
    } catch (e) {}
    try {
      var frames = win.frames
      for (var i = 0; i < frames.length; i++) {
        var found = findGldWindow(frames[i])
        if (found) return found
      }
    } catch (e) {}
    return null
  }

  function isOnVoucherPage(win) {
    return !!findGldWindow(win)
  }

  try {
    if (!BASE64) {
      throw new Error('凭证文件为空')
    }

    var root = window.top || window

    // 如果不在 gld-web 页面，尝试点菜单 凭证管理 → 凭证录入
    if (!isOnVoucherPage(root)) {
      status('🧭 自动导航：中科单位核算 → 凭证管理 → 凭证录入 ...')
      if (!textExistsIn(root, '凭证管理') && textExistsIn(root, '中科单位核算')) {
        await clickAndWait(root, '中科单位核算', '凭证管理', 60000)
      }
      if (!textExistsIn(root, '凭证管理')) {
        throw new Error('当前页面找不到"凭证管理"菜单。请确认已登录一体化系统，并先打开"中科单位核算"模块')
      }
      await clickAndWait(root, '凭证管理', '凭证录入', 60000)
      await sleep(400)
      clickTextInWin(root, '凭证录入')
      // 等 gld-web frame 出现
      var deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        if (isOnVoucherPage(root)) break
        await sleep(500)
      }
      if (!isOnVoucherPage(root)) {
        status('⚠ 没看到 gld-web 加载，盲试上传...', 'warn')
        await sleep(800)
      } else {
        await sleep(1500)
      }
    }

    status('📤 推送凭证：' + RUN_LABEL + ' ...')

    // 解 base64 → Blob → FormData
    var binary = atob(BASE64)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    var blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })

    var execWin = findGldWindow(root) || window
    var fetchFn = (execWin && execWin.fetch) ? execWin.fetch.bind(execWin) : fetch
    var FormDataCtor = (execWin && execWin.FormData) ? execWin.FormData : FormData
    var FileCtor = (execWin && execWin.File) ? execWin.File : File

    var file
    try {
      file = new FileCtor([blob], FILE_NAME, { type: blob.type })
    } catch (e) {
      // 旧浏览器 File 构造可能不支持，直接用 blob
      file = blob
    }
    var formData = new FormDataCtor()
    formData.append('file', file, FILE_NAME)
    formData.append('param', JSON.stringify(IMPORT_PARAM))

    var url = '/gld-account-server/importAccount/gl_import_file_json?menuid=' + MENUID
    status('⏳ 上传中（服务端处理可能需要 20-30 秒）...')

    var res = await fetchFn(url, {
      method: 'POST',
      credentials: 'include',
      body: formData
    })
    if (!res.ok) throw new Error('gl_import_file_json HTTP ' + res.status)
    var json
    try { json = await res.json() } catch (e) { json = null }

    if (json && json.status_code && String(json.status_code) !== '200' && String(json.status_code) !== '0000') {
      throw new Error('凭证导入失败：' + (json.reason || json.message || JSON.stringify(json)))
    }

    status('✅ 凭证导入完成：' + RUN_LABEL, 'ok')
    clearStatusLater(8000)
    return { ok: true, response: json }
  } catch (error) {
    var msg = error && error.message ? error.message : String(error)
    status('❌ ' + msg, 'err')
    clearStatusLater(12000)
    return { ok: false, reason: msg }
  }
})()
`
}
