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
  var TRACE = []
  var TRACE_T0 = Date.now()

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
    try { TRACE.push('+' + ((Date.now() - TRACE_T0) / 1000).toFixed(1) + 's ' + text) } catch (e) {}
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

  async function clickUntil(root, text, ready, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 60000)
    var clickedOnce = false
    while (Date.now() < deadline) {
      if (ready()) return true
      var clicked = clickTextInWin(root, text)
      clickedOnce = clickedOnce || clicked
      await sleep(clicked ? 700 : 900)
      if (ready()) return true
    }
    return ready() || clickedOnce
  }

  async function clickAnyAndWait(root, texts, waitText, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 60000)
    while (Date.now() < deadline) {
      if (waitText && textExistsIn(root, waitText)) return waitText
      for (var i = 0; i < texts.length; i++) {
        if (!textExistsIn(root, texts[i])) continue
        if (await clickAndWait(root, texts[i], waitText, timeoutMs)) return texts[i]
      }
      await sleep(500)
    }
    return ''
  }

  function isVoucherEntryUrl(url) {
    return /gld-web\\/gl\\/html\\/voucher\\/VoucherInput\\.html/i.test(String(url || ''))
  }

  function looksLikeVoucherEntry(win) {
    try {
      if (isVoucherEntryUrl(win.location.href)) return true
    } catch (e) {}
    try {
      var text = normalize(win.document.body && (win.document.body.innerText || win.document.body.textContent) || '')
      return text.indexOf('凭证录入') >= 0 && text.indexOf('修改附件数') >= 0
    } catch (e) {}
    return false
  }

  // 必须定位到真正的凭证录入页，避免在 BookSet/核算首页上下文误传。
  function findVoucherWindow(win) {
    try {
      if (looksLikeVoucherEntry(win)) return win
    } catch (e) {}
    try {
      var iframes = win.document.querySelectorAll('iframe')
      for (var i = 0; i < iframes.length; i++) {
        var src = iframes[i].src || iframes[i].getAttribute('src') || ''
        if (isVoucherEntryUrl(src)) {
          try { return iframes[i].contentWindow || win } catch (e) { return win }
        }
      }
    } catch (e) {}
    try {
      var frames = win.frames
      for (var i = 0; i < frames.length; i++) {
        var found = findVoucherWindow(frames[i])
        if (found) return found
      }
    } catch (e) {}
    return null
  }

  function isOnVoucherPage(win) {
    return !!findVoucherWindow(win)
  }

  async function waitForVoucherPage(root, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 60000)
    while (Date.now() < deadline) {
      if (isOnVoucherPage(root)) return true
      await sleep(500)
    }
    return isOnVoucherPage(root)
  }

  function injectVoucherIframe(root) {
    try {
      var doc = (root && root.document) || document
      var existing = doc.getElementById('payroll-voucher-iframe')
      if (existing) return existing
      var url = '/gld-web/gl/html/voucher/VoucherInput.html?menuid=' + MENUID + '&moduleid=' + MENUID
      var ifr = doc.createElement('iframe')
      ifr.id = 'payroll-voucher-iframe'
      ifr.src = url
      ifr.style.cssText = 'position:fixed;left:-99999px;top:0;width:1200px;height:800px;border:0;z-index:-1;'
      doc.body.appendChild(ifr)
      return ifr
    } catch (e) { return null }
  }

  // 在页内注入同源 iframe 加载凭证录入页，等 onload 后确认是否真的落在凭证录入（而非被重定向到登录/SSO）
  async function openVoucherViaIframe(root) {
    var ifr = injectVoucherIframe(root)
    if (!ifr) return false
    await new Promise(function (resolve) {
      var done = false
      function fin() { if (!done) { done = true; resolve() } }
      try { ifr.addEventListener('load', fin) } catch (e) {}
      setTimeout(fin, 30000)
    })
    await sleep(2000)
    try {
      var w = ifr.contentWindow
      if (w && looksLikeVoucherEntry(w)) return true
    } catch (e) {}
    return false
  }

  async function openVoucherPage(root) {
    if (isOnVoucherPage(root)) return 'ok'

    status('🧭 自动导航：中科单位核算 → 凭证管理 → 凭证录入 ...')
    if (!textExistsIn(root, '凭证管理')) {
      await clickAnyAndWait(root, ['中科单位核算', '单位核算', '会计核算'], '凭证管理', 60000)
    }
    if (textExistsIn(root, '凭证管理')) {
      await clickUntil(root, '凭证管理', function () {
        return isOnVoucherPage(root) || textExistsIn(root, '凭证录入')
      }, 30000)
      await sleep(300)
      await clickUntil(root, '凭证录入', function () {
        return isOnVoucherPage(root)
      }, 30000)
    }
    if (await waitForVoucherPage(root, 10000)) {
      await sleep(1500)
      return 'ok'
    }

    // 菜单没能打开（门户可能已升级为 SmartFin，菜单结构变了）。不跳转 window.top（会摧毁脚本上下文卡死），
    // 也不让主程序 loadURL 直达裸地址（会被服务端 ERR_ABORTED 拦截）。改为页内注入同源 iframe 直接加载
    // 凭证录入页，复用当前登录 cookie；成功则后续按该 iframe 上传。
    status('🧭 菜单未找到凭证录入入口，尝试在页内直接打开(iframe) ...', 'warn')
    if (await openVoucherViaIframe(root)) {
      await sleep(800)
      return 'ok'
    }
    return 'fail'
  }

  try {
    if (!BASE64) {
      throw new Error('凭证文件为空')
    }

    var root = window.top || window

    if (!isOnVoucherPage(root)) {
      var nav = await openVoucherPage(root)
      if (nav !== 'ok') {
        status('❌ 未能打开“凭证录入”页面', 'err')
        clearStatusLater(10000)
        return {
          ok: false,
          reason: '未能打开“凭证录入”页面：菜单中未找到入口，页内直接打开(iframe)也未成功（一体化可能已升级为 SmartFin，需按新菜单适配；详见日志“门户结构诊断”）',
          trace: TRACE,
          traceText: TRACE.join('\\n')
        }
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

    var execWin = findVoucherWindow(root)
    if (!execWin) {
      throw new Error('当前未处于“凭证录入”页面，已停止上传，避免把文件发到错误模块。')
    }
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
    var text = ''
    try { text = await res.text() } catch (e) { text = '' }
    var json
    try { json = text ? JSON.parse(text) : null } catch (e) { json = null }

    if (!json && /^\\s*</.test(text || '')) {
      throw new Error('凭证导入接口返回了页面内容，不是导入结果。请确认已停在“凭证录入”页面后重试。')
    }
    if (!json) {
      throw new Error('凭证导入接口没有返回可识别的导入结果。')
    }

    if (json && json.status_code && String(json.status_code) !== '200' && String(json.status_code) !== '0000') {
      throw new Error('凭证导入失败：' + (json.reason || json.message || JSON.stringify(json)))
    }

    // 解析一体化返回的导入明细（不同版本字段名不一，做容错）：
    //  1) 真实判断是否导入成功——成功 0 条 / 有失败行 → 视为失败，不再"假成功"；
    //  2) 把返回内容显示在浮窗，便于核对与排错（之前只看 HTTP/status_code，会出现"显示成功但查无凭证"）。
    var detailObj = (json && (json.data || json.result || json.body)) || json || {}
    var pickNum = function (obj, keys) {
      for (var ki = 0; ki < keys.length; ki++) {
        var v = obj ? obj[keys[ki]] : null
        if (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) return Number(v)
      }
      return null
    }
    var okCount = pickNum(detailObj, ['successCount', 'success_count', 'succeedCount', 'succ_count', 'successNum', 'success'])
    var failCount = pickNum(detailObj, ['failCount', 'fail_count', 'errorCount', 'error_count', 'failNum', 'fail'])
    var totalCount = pickNum(detailObj, ['totalCount', 'total_count', 'total', 'count'])
    var retMsg = (json && (json.reason || json.message || json.msg)) ||
      (detailObj && (detailObj.reason || detailObj.message || detailObj.msg)) || ''
    var detailParts = []
    if (totalCount !== null) detailParts.push('共 ' + totalCount)
    if (okCount !== null) detailParts.push('成功 ' + okCount)
    if (failCount !== null) detailParts.push('失败 ' + failCount)
    if (retMsg) detailParts.push(String(retMsg))
    var detailText = detailParts.join('，')
    var rawText = JSON.stringify(json)
    if (rawText && rawText.length > 240) rawText = rawText.slice(0, 240) + '...'

    if ((okCount !== null && okCount <= 0) || (failCount !== null && failCount > 0)) {
      throw new Error(
        '凭证导入未真正成功：' + (detailText || '一体化返回成功 0 条 / 存在失败行') +
        '\\n一体化返回：' + rawText
      )
    }

    status('✅ 凭证导入完成：' + RUN_LABEL + (detailText ? '\\n' + detailText : '') + '\\n一体化返回：' + rawText, 'ok')
    clearStatusLater(12000)
    return { ok: true, response: json, trace: TRACE, traceText: TRACE.join('\\n') }
  } catch (error) {
    var msg = error && error.message ? error.message : String(error)
    status('❌ ' + msg, 'err')
    clearStatusLater(12000)
    return { ok: false, reason: msg, trace: TRACE, traceText: TRACE.join('\\n') }
  }
})()
`
}
