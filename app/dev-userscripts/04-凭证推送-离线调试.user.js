// ==UserScript==
// @name         工资系统-凭证推送调试（离线）
// @namespace    https://www.hujiuxi.top/gongzi/dev
// @version      2026.06.04
// @description  离线油猴调试版：在一体化凭证录入页面选择本地凭证 xlsx 后上传。
// @author       老九 / Codex
// @match        http://172.24.147.202/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

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
      const TARGET_UNIT = {"unitFullName":"","unitImportCode":""}
      const MENUID = "227b6262406c4afb836d98abe98d4f85"
      const IMPORT_PARAM = {"modelType":"29","displayMode":"0","currentModelId":"c6025c601352431c977b538e99c56c5f","incrementFlag":"1"}
      var TRACE = []
      var TRACE_T0 = Date.now()
    
      function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
      function normalize(v) { return String(v || '').replace(/\s+/g, '') }
      function compact(v) { return String(v || '').replace(/\s+/g, ' ').trim() }
      function normalizeCode(v) { return String(v || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase() }
    
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
    
      function targetUnitLabel() {
        return [TARGET_UNIT.unitImportCode || '', TARGET_UNIT.unitFullName || ''].filter(Boolean).join(' ') || RUN_LABEL
      }
    
      function accountName(account) {
        return String((account && (account.name || account.text || account.agency_name)) || '')
      }
    
      function accountLabel(account) {
        if (!account) return ''
        return [account.code || account.agency_code || '', accountName(account)].filter(Boolean).join(' ')
      }
    
      function mapAccountSet(item) {
        return {
          id: item && item.id !== undefined ? String(item.id) : '',
          code: String((item && item.code) || ''),
          agency_code: String((item && item.agency_code) || ''),
          name: String((item && (item.name || item.text || item.agency_name)) || ''),
          agency_name: String((item && item.agency_name) || '')
        }
      }
    
      function accountCodeMatchesTarget(account, expectedCode) {
        if (!expectedCode) return false
        var codes = [
          normalizeCode(account && account.code),
          normalizeCode(account && account.agency_code)
        ].filter(Boolean)
        for (var i = 0; i < codes.length; i++) {
          var code = codes[i]
          if (code === expectedCode || code.endsWith(expectedCode) || expectedCode.endsWith(code)) return true
        }
        return false
      }
    
      function accountNameMatchesTarget(account, expectedName) {
        if (!expectedName) return false
        var name = normalize(accountName(account))
        return !!name && (name.indexOf(expectedName) >= 0 || expectedName.indexOf(name) >= 0)
      }
    
      function accountMatchesTarget(account) {
        return accountCodeMatchesTarget(account, normalizeCode(TARGET_UNIT.unitImportCode)) ||
          accountNameMatchesTarget(account, normalize(TARGET_UNIT.unitFullName))
      }
    
      async function fetchJsonWithTimeout(fetchFn, url, options, timeoutMs) {
        var controller = null
        var timer = null
        try {
          controller = window.AbortController ? new AbortController() : null
          timer = controller ? setTimeout(function () { try { controller.abort() } catch (e) {} }, timeoutMs || 8000) : null
          var opts = options || {}
          opts.credentials = opts.credentials || 'include'
          if (controller) opts.signal = controller.signal
          var res = await fetchFn(url, opts)
          var text = await res.text()
          var json = null
          try { json = text ? JSON.parse(text) : null } catch (e) {}
          return { ok: res.ok, http: res.status, text: text, json: json }
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
    
      async function fetchAccountSets(fetchFn) {
        var result = await fetchJsonWithTimeout(
          fetchFn,
          '/new-framework-engin2/userAcctSets?time=' + Date.now(),
          { method: 'GET', credentials: 'include' },
          10000
        )
        if (!result.ok || !result.json || String(result.json.status_code) !== '0000') {
          throw new Error('读取一体化账套列表失败，已停止上传。HTTP=' + result.http + '；返回=' + shortText(result.text))
        }
        var rows = Array.isArray(result.json.data) ? result.json.data : []
        return rows.map(mapAccountSet).filter(function (item) { return !!(item.id || item.code || item.name) })
      }
    
      function pickTargetAccount(accounts) {
        var expectedCode = normalizeCode(TARGET_UNIT.unitImportCode)
        var expectedName = normalize(TARGET_UNIT.unitFullName)
        if (!expectedCode && !expectedName) {
          throw new Error('凭证推送缺少目标单位编码/名称，已停止上传，避免导入到错误账套。')
        }
    
        if (expectedCode) {
          var codeMatches = accounts.filter(function (account) {
            return accountCodeMatchesTarget(account, expectedCode)
          })
          if (codeMatches.length === 1) return codeMatches[0]
          if (codeMatches.length > 1) {
            throw new Error('目标单位编码匹配到多个一体化账套，已停止上传：' + codeMatches.map(accountLabel).join('；'))
          }
        }
    
        if (expectedName) {
          var nameMatches = accounts.filter(function (account) {
            return accountNameMatchesTarget(account, expectedName)
          })
          if (nameMatches.length === 1) return nameMatches[0]
          if (nameMatches.length > 1) {
            throw new Error('目标单位名称匹配到多个一体化账套，已停止上传：' + nameMatches.map(accountLabel).join('；'))
          }
        }
    
        throw new Error(
          '当前一体化账号未找到目标账套，已停止上传。目标：' + targetUnitLabel() +
          '；可用账套：' + accounts.map(accountLabel).join('；')
        )
      }
    
      function collectCurrentAccountTexts(root) {
        var texts = []
        function add(value) {
          var text = compact(value)
          if (text && texts.indexOf(text) < 0) texts.push(text)
        }
        function scan(win) {
          try {
            var doc = win.document
            if (!doc) return
            var nodes = Array.prototype.slice.call(doc.querySelectorAll([
              'div.usermess-list input',
              'div.usermess-list .textbox-value',
              '.usermess-list span.textbox input',
              'input[id^="_easyui_textbox_input"]'
            ].join(',')))
            nodes.forEach(function (el) {
              try {
                var value = el.value || el.getAttribute('value') || el.textContent || ''
                if (/[0-9]{4,}|[一-龥]/.test(String(value || ''))) add(value)
              } catch (e) {}
            })
            var bodyText = doc.body ? String(doc.body.innerText || doc.body.textContent || '') : ''
            var re = /当前账套\s*[：:]?\s*([^\n\r]+)/g
            var match
            while ((match = re.exec(bodyText))) add(match[1])
          } catch (e) {}
          try {
            for (var i = 0; i < win.frames.length; i++) scan(win.frames[i])
          } catch (e) {}
        }
        scan(root)
        return texts
      }
    
      function identifyAccountFromTexts(accounts, texts) {
        for (var ti = 0; ti < texts.length; ti++) {
          var text = normalize(texts[ti])
          if (!text) continue
          var exactCode = accounts.filter(function (account) {
            var code = normalizeCode(account.code)
            return code && normalizeCode(text).indexOf(code) >= 0
          })
          if (exactCode.length === 1) return exactCode[0]
          var exactAgencyCode = accounts.filter(function (account) {
            var code = normalizeCode(account.agency_code)
            return code && normalizeCode(text).indexOf(code) >= 0
          })
          if (exactAgencyCode.length === 1) return exactAgencyCode[0]
          var nameMatches = accounts.filter(function (account) {
            var name = normalize(accountName(account))
            return name && text.indexOf(name) >= 0
          })
          if (nameMatches.length === 1) return nameMatches[0]
        }
        return null
      }
    
      function getCurrentAccountState(root, accounts) {
        var texts = collectCurrentAccountTexts(root)
        var account = identifyAccountFromTexts(accounts, texts)
        return { account: account, texts: texts }
      }
    
      async function ensureAccountingShell(root) {
        if (collectCurrentAccountTexts(root).length) return true
        if (!textExistsIn(root, '凭证管理')) {
          status('🧭 打开中科单位核算，准备确认当前账套 ...')
          await clickAnyAndWait(root, ['中科单位核算', '单位核算', '会计核算'], '凭证管理', 60000)
          await sleep(1800)
        }
        return collectCurrentAccountTexts(root).length > 0 || textExistsIn(root, '凭证管理')
      }
    
      function findAccountSwitchWindow(root) {
        function scan(win) {
          try {
            var doc = win.document
            if (doc && doc.querySelector('div.usermess-list')) return win
          } catch (e) {}
          try {
            for (var i = 0; i < win.frames.length; i++) {
              var found = scan(win.frames[i])
              if (found) return found
            }
          } catch (e) {}
          return null
        }
        return scan(root)
      }
    
      function textMatchesAccount(text, account) {
        var normalized = normalize(text)
        var code = normalizeCode(text)
        var name = normalize(accountName(account))
        return (account.code && code.indexOf(normalizeCode(account.code)) >= 0) ||
          (account.agency_code && code.indexOf(normalizeCode(account.agency_code)) >= 0) ||
          (name && normalized.indexOf(name) >= 0)
      }
    
      async function clickAccountComboItem(root, targetAccount) {
        var ctx = findAccountSwitchWindow(root)
        if (!ctx) return false
        try {
          var doc = ctx.document
          var arrow = doc.querySelector('div.usermess-list .combo-arrow, div.usermess-list a.textbox-icon')
          if (arrow) {
            arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            arrow.click()
          }
        } catch (e) {}
        await sleep(600)
    
        var candidates = []
        function scan(win) {
          try {
            var nodes = Array.prototype.slice.call(win.document.querySelectorAll('.combobox-item,.tree-node,li,td,div,span'))
            nodes.forEach(function (el) {
              var text = compact(el.innerText || el.textContent || el.title || '')
              if (!text || text.length > 120 || !isVisible(el)) return
              if (textMatchesAccount(text, targetAccount)) candidates.push({ el: el, text: text })
            })
          } catch (e) {}
          try {
            for (var i = 0; i < win.frames.length; i++) scan(win.frames[i])
          } catch (e) {}
        }
        scan(root)
        candidates.sort(function (a, b) { return a.text.length - b.text.length })
        var picked = candidates[0]
        if (!picked) return false
        try {
          picked.el.scrollIntoView({ block: 'center', inline: 'center' })
          picked.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          picked.el.click()
          return true
        } catch (e) {
          return false
        }
      }
    
      function tryEasyuiAccountSwitch(root, targetAccount) {
        var ctx = findAccountSwitchWindow(root)
        if (!ctx) return false
        try {
          var jq = ctx.jQuery || ctx.$
          if (!jq) return false
          var input = ctx.document.querySelector('div.usermess-list input[id^="_easyui_textbox_input"], div.usermess-list input')
          if (!input) return false
          var combo = jq(input).closest('span.combo,span.textbox').prev('input,select')
          if (!combo || !combo.length || !combo.combobox) return false
          var values = [targetAccount.id, targetAccount.code, targetAccount.agency_code, accountLabel(targetAccount)].filter(Boolean)
          for (var i = 0; i < values.length; i++) {
            try { combo.combobox('select', values[i]) } catch (e) {}
            try { combo.combobox('setValue', values[i]) } catch (e) {}
          }
          try { combo.combobox('setText', accountLabel(targetAccount)) } catch (e) {}
          try { combo.trigger('change') } catch (e) {}
          return true
        } catch (e) {
          return false
        }
      }
    
      async function switchToAccountSet(root, targetAccount, currentState) {
        var currentLabel = currentState && currentState.account
          ? accountLabel(currentState.account)
          : (currentState && currentState.texts && currentState.texts[0]) || '未识别'
        var targetLabel = accountLabel(targetAccount)
        var ok = confirm(
          '凭证导入前需要切换单位核算账套。\n\n当前账套：' + currentLabel +
          '\n目标账套：' + targetLabel +
          '\n\n确认后将尝试自动切换，切换确认成功后才会上传凭证。'
        )
        if (!ok) throw new Error('用户取消账套切换，已停止上传凭证。')
    
        status('⚠ 当前账套不是目标单位，正在切换到：' + targetLabel, 'warn')
        var clicked = await clickAccountComboItem(root, targetAccount)
        var easyui = tryEasyuiAccountSwitch(root, targetAccount)
        if (!clicked && !easyui) {
          throw new Error('未能自动触发账套切换，请手动切到 ' + targetLabel + ' 后重试。')
        }
    
        var deadline = Date.now() + 30000
        while (Date.now() < deadline) {
          await sleep(1000)
          var state = getCurrentAccountState(root, [targetAccount])
          if (state.account && accountMatchesTarget(state.account)) {
            status('✅ 当前账套已确认：' + accountLabel(state.account), 'ok')
            await sleep(800)
            return
          }
        }
        throw new Error('账套切换后未能确认当前账套为 ' + targetLabel + '，已停止上传。')
      }
    
      async function ensureTargetAccountSet(root, fetchFn) {
        await ensureAccountingShell(root)
        var accounts = await fetchAccountSets(fetchFn)
        if (!accounts.length) throw new Error('未读取到一体化账套列表，已停止上传。')
        var targetAccount = pickTargetAccount(accounts)
        var current = getCurrentAccountState(root, accounts)
        if (!current.account) {
          throw new Error(
            '未能读取“中科单位核算”的当前账套，已停止上传。目标账套：' + accountLabel(targetAccount) +
            '；页面识别文本：' + (current.texts.join('；') || '无')
          )
        }
        if (accountMatchesTarget(current.account)) {
          status('✅ 当前账套已确认：' + accountLabel(current.account))
          return targetAccount
        }
        await switchToAccountSet(root, targetAccount, current)
        return targetAccount
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
        return /gld-web\/gl\/html\/voucher\/VoucherInput\.html/i.test(String(url || ''))
      }
    
      function isImportPageUrl(url) {
        return /gld-web\/gl\/html\/common\/Import\.html/i.test(String(url || '')) &&
          /modelType=29/i.test(String(url || ''))
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
    
      function looksLikeImportPage(win) {
        try {
          if (isImportPageUrl(win.location.href)) return true
        } catch (e) {}
        try {
          var text = normalize(win.document.body && (win.document.body.innerText || win.document.body.textContent) || '')
          return text.indexOf('导入模板') >= 0 && text.indexOf('导入') >= 0
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
    
      function findImportWindow(win) {
        try {
          if (looksLikeImportPage(win)) return win
        } catch (e) {}
        try {
          var iframes = win.document.querySelectorAll('iframe')
          for (var i = 0; i < iframes.length; i++) {
            var src = iframes[i].src || iframes[i].getAttribute('src') || ''
            if (isImportPageUrl(src)) {
              try { return iframes[i].contentWindow || win } catch (e) { return win }
            }
          }
        } catch (e) {}
        try {
          var frames = win.frames
          for (var j = 0; j < frames.length; j++) {
            var found = findImportWindow(frames[j])
            if (found) return found
          }
        } catch (e) {}
        return null
      }
    
      function isOnVoucherPage(win) {
        return !!findVoucherWindow(win)
      }
    
      function shortText(value, limit) {
        var text = String(value || '').replace(/\s+/g, ' ').trim()
        var max = limit || 260
        return text.length > max ? text.slice(0, max) + '...' : text
      }
    
      function cloneImportParam() {
        return {
          modelType: IMPORT_PARAM.modelType,
          displayMode: IMPORT_PARAM.displayMode,
          currentModelId: IMPORT_PARAM.currentModelId,
          incrementFlag: IMPORT_PARAM.incrementFlag
        }
      }
    
      function isLikelyModelId(value) {
        var text = String(value || '').trim()
        return /^[0-9a-f]{32}$/i.test(text) && text !== MENUID
      }
    
      function addModelCandidate(list, seen, value, source) {
        var id = String(value || '').trim()
        if (!isLikelyModelId(id) || seen[id]) return
        seen[id] = true
        list.push({ id: id, source: source || 'unknown' })
      }
    
      function addModelCandidatesFromText(list, seen, value, source) {
        var text = String(value || '')
        if (!text) return
        var patterns = [
          /currentModelId[^0-9a-f]{1,40}([0-9a-f]{32})/ig,
          /current_model_id[^0-9a-f]{1,40}([0-9a-f]{32})/ig,
          /modelId[^0-9a-f]{1,40}([0-9a-f]{32})/ig,
          /model_id[^0-9a-f]{1,40}([0-9a-f]{32})/ig,
          /templateId[^0-9a-f]{1,40}([0-9a-f]{32})/ig,
          /template_id[^0-9a-f]{1,40}([0-9a-f]{32})/ig
        ]
        for (var pi = 0; pi < patterns.length; pi++) {
          var re = patterns[pi]
          var match
          while ((match = re.exec(text))) {
            addModelCandidate(list, seen, match[1], source)
          }
        }
      }
    
      function scanObjectForModelId(obj, source, list, seen, visited, depth) {
        if (!obj || depth > 2) return
        try {
          if (visited.indexOf(obj) >= 0) return
          visited.push(obj)
        } catch (e) { return }
        var keys = []
        try { keys = Object.keys(obj).slice(0, 500) } catch (e) { return }
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i]
          var keyNorm = String(key || '').toLowerCase()
          var interested = keyNorm.indexOf('model') >= 0 ||
            keyNorm.indexOf('template') >= 0 ||
            keyNorm.indexOf('import') >= 0
          if (!interested && depth > 0) continue
          var value
          try { value = obj[key] } catch (e) { continue }
          if (interested && (typeof value === 'string' || typeof value === 'number')) {
            addModelCandidate(list, seen, value, source + '.' + key)
            addModelCandidatesFromText(list, seen, value, source + '.' + key)
          } else if (value && typeof value === 'object') {
            scanObjectForModelId(value, source + '.' + key, list, seen, visited, depth + 1)
          }
        }
      }
    
      function scanWindowForModelIds(win, label, list, seen, visitedWins) {
        try {
          if (!win || visitedWins.indexOf(win) >= 0) return
          visitedWins.push(win)
        } catch (e) { return }
    
        try {
          var doc = win.document
          if (doc) {
            var nodes = Array.prototype.slice.call(
              doc.querySelectorAll('input,select,option,textarea,[data-model-id],[data-current-model-id],[data-template-id],[modelid],[currentmodelid]')
            ).slice(0, 800)
            nodes.forEach(function (el) {
              try {
                var attrs = Array.prototype.slice.call(el.attributes || [])
                attrs.forEach(function (attr) {
                  var name = String(attr.name || '').toLowerCase()
                  if (name.indexOf('model') >= 0 || name.indexOf('template') >= 0 || name.indexOf('import') >= 0) {
                    addModelCandidate(list, seen, attr.value, label + '.dom@' + attr.name)
                    addModelCandidatesFromText(list, seen, attr.value, label + '.dom@' + attr.name)
                  }
                })
                addModelCandidate(list, seen, el.value, label + '.dom.value')
              } catch (e) {}
            })
            addModelCandidatesFromText(list, seen, doc.documentElement && doc.documentElement.innerHTML, label + '.html')
          }
        } catch (e) {}
    
        try {
          ;[win.sessionStorage, win.localStorage].forEach(function (store, storeIndex) {
            if (!store) return
            var storeName = storeIndex === 0 ? 'sessionStorage' : 'localStorage'
            for (var i = 0; i < Math.min(store.length, 200); i++) {
              var key = store.key(i)
              var value = key ? store.getItem(key) : ''
              addModelCandidatesFromText(list, seen, key + '=' + value, label + '.' + storeName + '.' + key)
            }
          })
        } catch (e) {}
    
        scanObjectForModelId(win, label + '.window', list, seen, [], 0)
    
        try {
          for (var i = 0; i < win.frames.length; i++) {
            scanWindowForModelIds(win.frames[i], label + '>frame[' + i + ']', list, seen, visitedWins)
          }
        } catch (e) {}
      }
    
      async function fetchTextWithTimeout(fetchFn, win, url, timeoutMs) {
        var controller = null
        var timer = null
        try {
          controller = win && win.AbortController ? new win.AbortController() : null
          timer = controller ? setTimeout(function () { try { controller.abort() } catch (e) {} }, timeoutMs || 5000) : null
          var res = await fetchFn(url, {
            method: 'GET',
            credentials: 'include',
            signal: controller ? controller.signal : undefined
          })
          return await res.text()
        } catch (e) {
          return ''
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
    
      function addImportAttempt(list, seen, param, source) {
        var key = JSON.stringify(param)
        if (seen[key]) return
        seen[key] = true
        list.push({ param: param, source: source || 'default' })
      }
    
      function modelCandidateScore(candidate) {
        var source = String(candidate && candidate.source || '').toLowerCase()
        if (source.indexOf('dom.value') >= 0) return 0
        if (source.indexOf('currentmodel') >= 0 || source.indexOf('modelid') >= 0) return 1
        if (source.indexOf('import.html') >= 0 || source.indexOf('import') >= 0) return 2
        return 3
      }
    
      async function buildImportParamAttempts(importWin) {
        var modelCandidates = []
        var modelSeen = {}
        scanWindowForModelIds(importWin, 'Import.html', modelCandidates, modelSeen, [])
        modelCandidates.sort(function (a, b) { return modelCandidateScore(a) - modelCandidateScore(b) })
    
        var attempts = []
        var attemptSeen = {}
        for (var i = 0; i < modelCandidates.length && attempts.length < 5; i++) {
          var detected = cloneImportParam()
          detected.currentModelId = modelCandidates[i].id
          addImportAttempt(attempts, attemptSeen, detected, modelCandidates[i].source)
        }
        if (!attempts.length) {
          throw new Error('未能从一体化导入页读取凭证导入模板ID，已停止上传。请手动打开“导入”窗口确认模板后再试。')
        }
        return attempts
      }
    
      async function postVoucherImport(fetchFn, FormDataCtor, file, param) {
        var formData = new FormDataCtor()
        formData.append('file', file, FILE_NAME)
        formData.append('file', '')
        formData.append('param', JSON.stringify(param))
        var url = '/gld-account-server/importAccount/gl_import_file_json?menuid=' + MENUID
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
        return { json: json, text: text }
      }
    
      function parseRunPeriod(label) {
        var match = /\d{4}-(\d{1,2})/.exec(String(label || ''))
        if (!match) return ''
        var n = Number(match[1])
        return n > 0 && n <= 12 ? String(n) : ''
      }
    
      async function verifyVoucherListTarget(fetchFn, targetAccount) {
        var period = parseRunPeriod(RUN_LABEL)
        if (!period) return ''
        for (var attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) await sleep(1800)
          try {
            var res = await fetchFn('/gld-account-server/gl/account/loadVoucherPageisQuery?menuid=' + MENUID, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
              body: 'period=' + encodeURIComponent(period) + '&isModelFlag=false'
            })
            var text = await res.text()
            var json = text ? JSON.parse(text) : null
            var rows = json && Array.isArray(json.data) ? json.data : []
            if (!rows.length) continue
            var setIds = []
            rows.forEach(function (row) {
              var setId = row && row.set_id !== undefined ? String(row.set_id) : ''
              if (setId && setIds.indexOf(setId) < 0) setIds.push(setId)
            })
            if (targetAccount && targetAccount.id && setIds.length && setIds.indexOf(String(targetAccount.id)) < 0) {
              return '⚠ 凭证列表回查账套异常：当前列表 set_id=' + setIds.join(',') + '，目标=' + targetAccount.id + '。为避免重复上传，未自动重试，请人工核对。'
            }
            return '凭证列表回查：期间 ' + period + ' 月，读取到 ' + rows.length + ' 条，账套 ' + (setIds.join(',') || '未返回')
          } catch (e) {}
        }
        return '⚠ 导入接口已返回成功，但凭证列表暂未刷新出记录。为避免重复上传，未自动重试，请到一体化导入日志/凭证列表核对。'
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
    
      function injectImportIframe(root) {
        try {
          var doc = (root && root.document) || document
          var existing = doc.getElementById('payroll-voucher-import-iframe')
          if (existing) return existing
          var url = '/gld-web/gl/html/common/Import.html?modelType=29&mode=0&menuid=' + MENUID
          var ifr = doc.createElement('iframe')
          ifr.id = 'payroll-voucher-import-iframe'
          ifr.src = url
          ifr.style.cssText = 'position:fixed;left:-99999px;top:0;width:1200px;height:800px;border:0;z-index:-1;'
          doc.body.appendChild(ifr)
          return ifr
        } catch (e) { return null }
      }
    
      async function openImportPage(root) {
        var existing = findImportWindow(root)
        if (existing && looksLikeImportPage(existing)) return existing
        var ifr = injectImportIframe(root)
        if (!ifr) return null
        await new Promise(function (resolve) {
          var done = false
          function fin() { if (!done) { done = true; resolve() } }
          try { ifr.addEventListener('load', fin) } catch (e) {}
          setTimeout(fin, 30000)
        })
        await sleep(1800)
        try {
          var w = ifr.contentWindow
          if (w && looksLikeImportPage(w)) return w
        } catch (e) {}
        return findImportWindow(root)
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
    
        // iframe 优先：SmartFin 菜单已变，点菜单只会狂弹窗且慢；页内同源 iframe 直达凭证录入已验证可用
        status('🧭 在页内直接打开凭证录入(iframe) ...')
        if (await openVoucherViaIframe(root)) {
          await sleep(800)
          return 'ok'
        }
    
        // iframe 没成功，再退回点菜单（兼容老门户）
        status('🧭 iframe 未成功，改走菜单导航：中科单位核算 → 凭证管理 → 凭证录入 ...', 'warn')
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
        return 'fail'
      }
    
      try {
        if (!BASE64) {
          throw new Error('凭证文件为空')
        }
    
        var root = window.top || window
        var rootFetch = (root && root.fetch) ? root.fetch.bind(root) : fetch
        var targetAccount = await ensureTargetAccountSet(root, rootFetch)
    
        if (!isOnVoucherPage(root)) {
          var nav = await openVoucherPage(root)
          if (nav !== 'ok') {
            status('❌ 未能打开“凭证录入”页面', 'err')
            clearStatusLater(10000)
            return {
              ok: false,
              reason: '未能打开“凭证录入”页面：菜单中未找到入口，页内直接打开(iframe)也未成功（一体化可能已升级为 SmartFin，需按新菜单适配；详见日志“门户结构诊断”）',
              trace: TRACE,
              traceText: TRACE.join('\n')
            }
          }
        }
    
        var execWin = findVoucherWindow(root)
        if (!execWin) {
          throw new Error('当前未处于“凭证录入”页面，已停止上传，避免把文件发到错误模块。')
        }
    
        status('📤 推送凭证：' + RUN_LABEL + '\n目标账套：' + accountLabel(targetAccount) + ' ...')
    
        var importWin = await openImportPage(root)
        if (!importWin) {
          throw new Error('未能打开一体化凭证导入页 Import.html，已停止上传。')
        }
        var fetchFn = (importWin && importWin.fetch) ? importWin.fetch.bind(importWin) : fetch
        var FormDataCtor = (importWin && importWin.FormData) ? importWin.FormData : FormData
        var FileCtor = (importWin && importWin.File) ? importWin.File : File
        var BlobCtor = (importWin && importWin.Blob) ? importWin.Blob : Blob
    
        // 解 base64 → Blob → FormData
        var binary = atob(BASE64)
        var bytes = new Uint8Array(binary.length)
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        var blob = new BlobCtor([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        })
    
        var file
        try {
          file = new FileCtor([blob], FILE_NAME, { type: blob.type })
        } catch (e) {
          // 旧浏览器 File 构造可能不支持，直接用 blob
          file = blob
        }
        var attempts = await buildImportParamAttempts(importWin)
        status('凭证导入模板候选：' + attempts.map(function (item) {
          return (item.param.currentModelId || '无模板ID') + '（' + item.source + '）'
        }).join('；'))
    
        var text = ''
        var json = null
        var usedImportParam = null
        var lastImportError = ''
        for (var ai = 0; ai < attempts.length; ai++) {
          var attempt = attempts[ai]
          var modelLabel = attempt.param.currentModelId || '无模板ID'
          status('⏳ 上传中（服务端处理可能需要 20-30 秒）... 模板ID：' + modelLabel + '，尝试 ' + (ai + 1) + '/' + attempts.length)
          var posted = await postVoucherImport(fetchFn, FormDataCtor, file, attempt.param)
          text = posted.text
          json = posted.json
    
          if (!json && /^\s*</.test(text || '')) {
            throw new Error('凭证导入接口返回了页面内容，不是导入结果。请确认已停在“凭证录入”页面后重试。')
          }
          if (!json) {
            throw new Error('凭证导入接口没有返回可识别的导入结果。一体化返回：' + shortText(text))
          }
    
          if (json && json.status_code && String(json.status_code) !== '200' && String(json.status_code) !== '0000') {
            var reason = json.reason || json.message || JSON.stringify(json)
            lastImportError = '凭证导入失败：' + reason + '；模板ID=' + modelLabel + '；一体化返回：' + shortText(JSON.stringify(json))
            if (/获取导入模板失败|模板/.test(String(reason)) && ai < attempts.length - 1) {
              status('⚠ 模板ID不可用：' + modelLabel + '，改用下一种参数 ...', 'warn')
              continue
            }
            throw new Error(lastImportError)
          }
          usedImportParam = attempt.param
          break
        }
        if (!usedImportParam) {
          throw new Error(lastImportError || '凭证导入失败：所有模板参数均未成功')
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
        var pickNumFromText = function (value, patterns) {
          var msg = String(value || '')
          for (var pi = 0; pi < patterns.length; pi++) {
            var match = patterns[pi].exec(msg)
            if (match && match[1] !== undefined && !isNaN(Number(match[1]))) return Number(match[1])
          }
          return null
        }
        var okCount = pickNum(detailObj, ['successCount', 'success_count', 'succeedCount', 'succ_count', 'successNum', 'success'])
        var failCount = pickNum(detailObj, ['failCount', 'fail_count', 'errorCount', 'error_count', 'failNum', 'fail'])
        var totalCount = pickNum(detailObj, ['totalCount', 'total_count', 'total', 'count'])
        var retMsg = (json && (json.reason || json.message || json.msg)) ||
          (detailObj && (detailObj.reason || detailObj.message || detailObj.msg)) || ''
        if (okCount === null) okCount = pickNumFromText(retMsg, [/成功(?:数)?[：:]\s*(\d+)/, /新增数[：:]\s*(\d+)/])
        var newCount = pickNumFromText(retMsg, [/新增数[：:]\s*(\d+)/])
        if (failCount === null) failCount = pickNumFromText(retMsg, [/失败(?:条数|数)?[：:]\s*(\d+)/])
        if (totalCount === null) totalCount = pickNumFromText(retMsg, [/总数[：:]\s*(\d+)/, /共\s*(\d+)/])
        var detailParts = []
        if (totalCount !== null) detailParts.push('共 ' + totalCount)
        if (okCount !== null) detailParts.push('成功 ' + okCount)
        if (newCount !== null) detailParts.push('新增 ' + newCount)
        if (failCount !== null) detailParts.push('失败 ' + failCount)
        if (retMsg) detailParts.push(String(retMsg))
        var detailText = detailParts.join('，')
        var rawText = JSON.stringify(json)
        if (rawText && rawText.length > 240) rawText = rawText.slice(0, 240) + '...'
    
        if ((totalCount !== null && totalCount <= 0) || (failCount !== null && failCount > 0)) {
          throw new Error(
            '凭证导入未真正成功：' + (detailText || '一体化返回成功 0 条 / 存在失败行') +
            '\n模板ID：' + (usedImportParam.currentModelId || '无模板ID') +
            '\n一体化返回：' + rawText
          )
        }
    
        var verifyText = await verifyVoucherListTarget(fetchFn, targetAccount)
        status('✅ 凭证导入完成：' + RUN_LABEL + (detailText ? '\n' + detailText : '') +
          '\n目标账套：' + accountLabel(targetAccount) +
          '\n模板ID：' + (usedImportParam.currentModelId || '无模板ID') +
          (verifyText ? '\n' + verifyText : '') +
          '\n一体化返回：' + rawText, 'ok')
        clearStatusLater(12000)
        return { ok: true, response: json, trace: TRACE, traceText: TRACE.join('\n') }
      } catch (error) {
        var msg = error && error.message ? error.message : String(error)
        status('❌ ' + msg, 'err')
        clearStatusLater(12000)
        return { ok: false, reason: msg, trace: TRACE, traceText: TRACE.join('\n') }
      }
  }

  addButton()
  setInterval(addButton, 1000)
})()
