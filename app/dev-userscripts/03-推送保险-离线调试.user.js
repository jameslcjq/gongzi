// ==UserScript==
// @name         工资系统-推送保险调试（离线）
// @namespace    https://www.hujiuxi.top/gongzi/dev
// @version      2026.06.04
// @description  离线油猴调试版：粘贴保险记录 JSON 后推送到一体化直接支付外部数据页面。
// @author       老九 / Codex
// @match        http://172.24.147.202/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

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
      const MENUID = "1a4a2a50831b467088f25dbbf13d5453"

      function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
      function normalize(v) { return String(v || '').replace(/\s+/g, '') }
      function isInsurancePageText(text) {
        var t = normalize(text)
        return (
          t.indexOf('直接支付外部数据') >= 0 ||
          t.indexOf('直接支付录入') >= 0 ||
          (t.indexOf('直接支付') >= 0 && t.indexOf('外部数据') >= 0)
        )
      }
      function insurancePageTitleExists(win) {
        try {
          var nodes = Array.prototype.slice.call(
            win.document.querySelectorAll('h1,h2,h3,.panel-title,.tabs-title,.breadcrumb,.crumb,.title,.page-title,[class*="title"]')
          )
          for (var i = 0; i < nodes.length; i++) {
            if (isVisible(nodes[i]) && isInsurancePageText(nodes[i].innerText || nodes[i].textContent || nodes[i].title || '')) return true
          }
        } catch (e) {}
        return false
      }

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
        return false
      }

      function isTemplateslistUrl(url) {
        var value = String(url || '')
        if (!/pay-voucher-web\/record\/templateslist/i.test(value)) return false
        return value.indexOf(MENUID) >= 0 || /[?&]viewCode=zfm621198001(?:&|$)/i.test(value) || /[?&]myMenuId=2020120616061(?:&|$)/i.test(value)
      }

      async function clickUntil(root, text, ready, timeoutMs, intervalMs) {
        var deadline = Date.now() + (timeoutMs || 60000)
        var clickedOnce = false
        while (Date.now() < deadline) {
          if (ready()) return true
          var clicked = clickTextInWin(root, text)
          clickedOnce = clickedOnce || clicked
          await sleep(clicked ? 700 : (intervalMs || 900))
          if (ready()) return true
        }
        return ready() || clickedOnce
      }

      // 同时扫：① frame.location.href（同域才读得到）  ② DOM 里所有 <iframe> 的 src 属性（跨域也能读）。
      function pageReady(win) {
        try {
          if (isTemplateslistUrl(win.location.href)) return true
        } catch (e) {}
        try {
          var iframes = win.document.querySelectorAll('iframe')
          for (var i = 0; i < iframes.length; i++) {
            var src = iframes[i].src || iframes[i].getAttribute('src') || ''
            if (isTemplateslistUrl(src)) return true
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
          if (isTemplateslistUrl(win.location.href)) return win
        } catch (e) {}
        try {
          var iframes = win.document.querySelectorAll('iframe')
          for (var i = 0; i < iframes.length; i++) {
            var src = iframes[i].src || iframes[i].getAttribute('src') || ''
            if (isTemplateslistUrl(src)) {
              try {
                var frameWin = iframes[i].contentWindow
                if (frameWin && frameWin.fetch) return frameWin
              } catch (e) {}
              return win
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

      async function openDirectPayPage(root) {
        if (pageReady(root)) return true

        status('🧭 自动导航：进入预算执行模块 ...')
        if (!textExistsIn(root, '集中支付') && textExistsIn(root, '预算执行')) {
          await clickUntil(root, '预算执行', function () {
            return pageReady(root) || textExistsIn(root, '集中支付')
          }, 60000)
        }
        if (pageReady(root)) return true
        if (!textExistsIn(root, '集中支付')) {
          throw new Error('当前页面找不到“集中支付”菜单。请确认已登录一体化系统，并打开过预算执行入口。')
        }

        status('🧭 自动导航：集中支付 → 支付管理 ...')
        await clickUntil(root, '集中支付', function () {
          return pageReady(root) || textExistsIn(root, '支付管理')
        }, 60000)
        if (pageReady(root)) return true
        if (!textExistsIn(root, '支付管理')) {
          throw new Error('没有展开“集中支付 → 支付管理”。请确认当前账号有直接支付外部数据权限。')
        }

        status('🧭 自动导航：支付管理 → 直接支付外部数据 ...')
        await clickUntil(root, '支付管理', function () {
          return pageReady(root) || textExistsIn(root, '直接支付外部数据') || textExistsIn(root, '直接支付录入')
        }, 60000)
        await sleep(300)
        await clickUntil(root, '直接支付外部数据', function () {
          return pageReady(root)
        }, 45000)
        if (!pageReady(root)) {
          await clickUntil(root, '直接支付录入', function () {
            return pageReady(root)
          }, 30000)
        }
        if (!pageReady(root)) {
          throw new Error('没有等到“直接支付外部数据”页面加载完成。请确认菜单权限和网络正常后重试。')
        }
        await sleep(1500)
        return true
      }

      try {
        if (!RECORDS.length) {
          status('❌ 没有可推送的记录', 'err')
          clearStatusLater(5000)
          return { ok: false, reason: '记录为空' }
        }

        var root = window.top || window

        if (!pageReady(root)) {
          await openDirectPayPage(root)
        }

        status('📤 推送 ' + RECORDS.length + ' 条保险记录到一体化...')
        var progressKey = 'pushInsurance' + Date.now()
        var postUrl =
          '/pay-voucher-server/grp/fes/pay/raw/savePayRawData?menuid=' + MENUID +
          '&progress_key=' + progressKey

        // 优先在 templateslist iframe 里发请求（更接近原浏览器行为：referer/cookie 上下文一致）
        var execWin = findTemplateslistWindow(root)
        if (!execWin) {
          throw new Error('已进入预算执行，但没有定位到“直接支付外部数据/直接支付录入”页面，请手动打开该页面后重试。')
        }
        var fetchFn
        try {
          fetchFn = (execWin && execWin.fetch) ? execWin.fetch.bind(execWin) : fetch
        } catch (e) {
          throw new Error('无法在“直接支付外部数据”页面上下文发起推送，请手动打开该页面后重试。')
        }

        var postRes = await fetchFn(postUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json;charset=UTF-8' },
          body: JSON.stringify({ data: JSON.stringify(RECORDS) })
        })
        if (!postRes.ok) throw new Error('savePayRawData HTTP ' + postRes.status)
        var postText = ''
        try { postText = await postRes.text() } catch (e) { postText = '' }
        var postJson = null
        try { postJson = postText ? JSON.parse(postText) : null } catch (e) {}
        if (!postJson) {
          if (/^\s*</.test(postText || '')) {
            throw new Error('savePayRawData 返回了页面内容，不是推送结果。请确认一体化登录未失效，并停在“直接支付外部数据”页面。')
          }
          throw new Error('savePayRawData 没有返回可识别的推送结果。')
        }
        var postCode = postJson.status_code != null ? String(postJson.status_code) : ''
        var postMessage = String(postJson.reason || postJson.message || postJson.msg || '')
        var looksOk = postJson.success === true || postJson.ok === true || /成功|完成|已保存|已接收/.test(postMessage)
        if (!postCode && !looksOk) {
          throw new Error('savePayRawData 未返回明确成功结果，不能确认数据已保存：' + JSON.stringify(postJson).slice(0, 500))
        }
        if (postCode && postCode !== '200' && postCode !== '0000') {
          throw new Error('savePayRawData 返回 ' + postJson.status_code + ': ' + (postJson.reason || postJson.message || ''))
        }

        // 2. 轮询 progress
        status('⏳ 服务端处理中...')
        var progressUrl =
          '/pay-voucher-server/progress/check?progress_key=' + progressKey +
          '&menuid=' + MENUID + '&_=' + Date.now()
        var lastPct = ''
        var lastProgressText = ''
        var completed = false
        var pollDeadline = Date.now() + 60000
        while (Date.now() < pollDeadline) {
          try {
            var pRes = await fetchFn(progressUrl, { credentials: 'include' })
            var pJson = await pRes.json()
            var pct = pJson.progress_value || ''
            lastProgressText = pJson.progress_text || lastProgressText
            if (pct && pct !== lastPct) {
              status('⏳ 进度 ' + pct + '：' + (pJson.progress_text || ''))
              lastPct = pct
            }
            var progressText = String(pJson.progress_text || pJson.message || '')
            if (pct === '100%' || pct === '100' || pJson.success === true || /完成|成功/.test(progressText)) {
              completed = true
              break
            }
          } catch (e) {}
          await sleep(700)
        }
        if (!completed) {
          throw new Error('直接支付外部数据处理进度未完成，最后进度：' + (lastPct || '未返回') + (lastProgressText ? '，' + lastProgressText : ''))
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
  }

  addButton()
  setInterval(addButton, 1000)
})()
