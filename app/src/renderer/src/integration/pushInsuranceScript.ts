/**
 * 把"保险导入"的多条记录推送到一体化系统的"直接支付外部数据"。
 *
 * 流程（按用户实际操作录制的 click + xhr 轨迹）：
 *   1. 在左侧菜单依次点 集中支付 → 支付管理 → 直接支付外部数据
 *   2. 等 templateslist.html 加载完
 *   3. POST /pay-voucher-server/grp/fes/pay/raw/savePayRawData?menuid=...&progress_key=...
 *      body = {"data": "<JSON 字符串：records 数组>"}
 *   4. 轮询 GET /pay-voucher-server/progress/check?progress_key=... 直到 100%
 */

export type InsuranceRecord = {
  agency_code: string
  agency_code_name: string
  dep_bgt_eco_code: string
  dep_bgt_eco_code_name: string
  use_des: string
  pay_sum_amt: string
  payee_acct_name: string
  payee_acct_bank_name: string
  payee_acct_no: string
  operate_user: string
  audit_user: string
  hold1: string
  is_gov_pur_pay: string
}

const PAY_VOUCHER_MENUID = '1a4a2a50831b467088f25dbbf13d5453'

export function buildPushInsuranceScript(records: InsuranceRecord[]): string {
  return `
;(async function pushInsurance() {
  const RECORDS = ${JSON.stringify(records)}
  const MENUID = ${JSON.stringify(PAY_VOUCHER_MENUID)}

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function normalize(v) { return String(v || '').replace(/\\s+/g, '') }

  function ensureStatus() {
    let el = document.getElementById('insurance-push-status')
    if (el) return el
    el = document.createElement('div')
    el.id = 'insurance-push-status'
    el.style.cssText = [
      'position:fixed','top:100px','right:24px','min-width:300px','max-width:520px',
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
    else el.style.background = 'rgba(33,33,33,0.92)'
    console.log('[insurance-push]', text)
  }
  function clearStatusLater(ms) {
    setTimeout(function () {
      const el = document.getElementById('insurance-push-status')
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

  // 同时扫：① frame.location.href（同域才读得到）  ② DOM 里所有 <iframe> 的 src 属性（跨域也能读）
  function pageReady(win) {
    try {
      if (/pay-voucher-web\\/record\\/templateslist/i.test(win.location.href)) return true
    } catch (e) {}
    try {
      var iframes = win.document.querySelectorAll('iframe')
      for (var i = 0; i < iframes.length; i++) {
        var src = iframes[i].src || iframes[i].getAttribute('src') || ''
        if (/pay-voucher-web\\/record\\/templateslist/i.test(src)) return true
      }
    } catch (e) {}
    try {
      var frames = win.frames
      for (var i = 0; i < frames.length; i++) {
        if (pageReady(frames[i])) return true
      }
    } catch (e) {}
    return false
  }

  // 找到承载 templateslist 的 window（用于在该 window 上下文执行 fetch，确保 menuid 会话正确）
  function findTemplateslistWindow(win) {
    try {
      if (/pay-voucher-web\\/record\\/templateslist/i.test(win.location.href)) return win
    } catch (e) {}
    try {
      var iframes = win.document.querySelectorAll('iframe')
      for (var i = 0; i < iframes.length; i++) {
        var src = iframes[i].src || iframes[i].getAttribute('src') || ''
        if (/pay-voucher-web\\/record\\/templateslist/i.test(src)) {
          try { return iframes[i].contentWindow || win } catch (e) { return win }
        }
      }
    } catch (e) {}
    try {
      var frames = win.frames
      for (var i = 0; i < frames.length; i++) {
        var found = findTemplateslistWindow(frames[i])
        if (found) return found
      }
    } catch (e) {}
    return null
  }

  try {
    if (!RECORDS.length) {
      status('❌ 没有可推送的记录', 'err')
      clearStatusLater(5000)
      return { ok: false, reason: '记录为空' }
    }

    var root = window.top || window

    // 1. 导航：集中支付 → 支付管理 → 直接支付外部数据
    if (!pageReady(root)) {
      status('🧭 自动导航：集中支付 → 支付管理 → 直接支付外部数据 ...')
      // 已在某个一体化页面，未必有左侧菜单 —— 先尝试点。失败提示用户。
      if (!textExistsIn(root, '集中支付') && textExistsIn(root, '预算执行')) {
        status('🧭 自动打开预算执行模块 ...')
        await clickAndWait(root, '预算执行', '集中支付', 60000)
      }
      if (!textExistsIn(root, '集中支付')) {
        throw new Error('当前页面找不到"集中支付"菜单。请确认已登录一体化系统，并先打开"预算执行"模块')
      }
      await clickAndWait(root, '集中支付', '支付管理', 60000)
      await sleep(400)
      await clickAndWait(root, '支付管理', '直接支付外部数据', 60000)
      await sleep(400)
      clickTextInWin(root, '直接支付外部数据')
      // 等 templateslist iframe 加载（包括跨域 iframe 的 src 属性扫描），最多 60 秒
      var deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        if (pageReady(root)) break
        await sleep(500)
      }
      if (!pageReady(root)) {
        // 容错：不立刻报错。后端可能已经接受 menuid 会话激活，盲试 POST，错了再说
        status('⚠ 没看到 templateslist 加载，盲试推送...', 'warn')
        await sleep(800)
      } else {
        await sleep(1500)
      }
    }

    status('📤 推送 ' + RECORDS.length + ' 条保险记录到一体化...')
    var progressKey = 'pushInsurance' + Date.now()
    var postUrl =
      '/pay-voucher-server/grp/fes/pay/raw/savePayRawData?menuid=' + MENUID +
      '&progress_key=' + progressKey

    // 优先在 templateslist iframe 里发请求（更接近原浏览器行为：referer/cookie 上下文一致）
    var execWin = findTemplateslistWindow(root) || window
    var fetchFn = (execWin && execWin.fetch) ? execWin.fetch.bind(execWin) : fetch

    var postRes = await fetchFn(postUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ data: JSON.stringify(RECORDS) })
    })
    if (!postRes.ok) throw new Error('savePayRawData HTTP ' + postRes.status)
    var postJson = await postRes.json()
    if (postJson.status_code && String(postJson.status_code) !== '200') {
      throw new Error('savePayRawData 返回 ' + postJson.status_code + ': ' + (postJson.reason || ''))
    }

    // 2. 轮询 progress
    status('⏳ 服务端处理中...')
    var progressUrl =
      '/pay-voucher-server/progress/check?progress_key=' + progressKey +
      '&menuid=' + MENUID + '&_=' + Date.now()
    var lastPct = ''
    var pollDeadline = Date.now() + 60000
    while (Date.now() < pollDeadline) {
      try {
        var pRes = await fetchFn(progressUrl, { credentials: 'include' })
        var pJson = await pRes.json()
        var pct = pJson.progress_value || ''
        if (pct && pct !== lastPct) {
          status('⏳ 进度 ' + pct + '：' + (pJson.progress_text || ''))
          lastPct = pct
        }
        if (pct === '100%') break
      } catch (e) {}
      await sleep(700)
    }

    status('✅ 完成！已推送 ' + RECORDS.length + ' 条到 直接支付外部数据', 'ok')
    clearStatusLater(8000)
    return { ok: true, recordCount: RECORDS.length }
  } catch (error) {
    var msg = error && error.message ? error.message : String(error)
    status('❌ ' + msg, 'err')
    clearStatusLater(12000)
    return { ok: false, reason: msg }
  }
})()
`
}
