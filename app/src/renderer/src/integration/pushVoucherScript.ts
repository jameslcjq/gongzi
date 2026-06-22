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
  // currentModelId 每次运行时从一体化“凭证导入”页轮询扫描自动取真实值，不再写死。
  // 旧写法曾写死 c6025c60…，服务端模板被重建后该 ID 失效（2026-06-19 触发“获取导入模板失败！”）。
  currentModelId: '',
  incrementFlag: '1'
}

export type PushVoucherTargetUnit = {
  unitFullName?: string
  unitImportCode?: string
}

export function buildPushVoucherScript(
  fileName: string,
  base64: string,
  runLabel: string,
  targetUnit: PushVoucherTargetUnit = {}
): string {
  return `
;(async function pushVoucher() {
  const FILE_NAME = ${JSON.stringify(fileName)}
  const BASE64 = ${JSON.stringify(base64)}
  const RUN_LABEL = ${JSON.stringify(runLabel)}
  const TARGET_UNIT = ${JSON.stringify({
    unitFullName: targetUnit.unitFullName || '',
    unitImportCode: targetUnit.unitImportCode || ''
  })}
  const MENUID = ${JSON.stringify(VOUCHER_MENUID)}
  const IMPORT_PARAM = ${JSON.stringify(VOUCHER_IMPORT_PARAM)}
  var TRACE = []
  var TRACE_T0 = Date.now()

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function normalize(v) { return String(v || '').replace(/\\s+/g, '') }
  function compact(v) { return String(v || '').replace(/\\s+/g, ' ').trim() }
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
    return String((account && (account.name || account.text || account.agency_name || account.acctSetName)) || '')
  }

  function accountLabel(account) {
    if (!account) return ''
    return [account.code || account.agency_code || account.acctSetCode || '', accountName(account)].filter(Boolean).join(' ')
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

  // 业务决策（2026-06-16，应用户要求变更，推翻 2026-06-12 的“不切换”约定）：
  // 凭证导入前【自动切换】到与本机单位一致的账套；找不到本单位账套、或切换后回读校验不一致
  // → 中止导入（避免把凭证导到错误账套）。
  // 接口均由录制坐实：userAcctSets(账套列表) / userSession/user(当前账套+userId) / changeAcctSet(切换)。
  async function readUserSession(fetchFn) {
    try {
      var r = await fetchJsonWithTimeout(
        fetchFn,
        '/new-framework-engin2/userSession/user?time=' + Date.now(),
        { method: 'GET', credentials: 'include' },
        10000
      )
      var d = r.ok && r.json && String(r.json.status_code) === '0000' ? r.json.data : null
      if (!d) return null
      return {
        userId: d.userId !== undefined && d.userId !== null ? String(d.userId) : '',
        acctSetId: d.acctSetId !== undefined && d.acctSetId !== null ? String(d.acctSetId) : '',
        acctSetName: String(d.acctSetName || '')
      }
    } catch (e) {
      return null
    }
  }

  async function readAcctSetList(fetchFn) {
    try {
      var r = await fetchJsonWithTimeout(
        fetchFn,
        '/new-framework-engin2/userAcctSets?time=' + Date.now(),
        { method: 'GET', credentials: 'include' },
        10000
      )
      return r.ok && r.json && String(r.json.status_code) === '0000' && Array.isArray(r.json.data)
        ? r.json.data
        : null
    } catch (e) {
      return null
    }
  }

  // 切换到本机单位对应的账套。返回 { ok:true, account, switched } 或 { ok:false, reason }。
  async function ensureTargetAcctSet(fetchFn) {
    var sess = await readUserSession(fetchFn)
    var sets = await readAcctSetList(fetchFn)
    if (!sets || !sets.length) {
      if (sess && (sess.acctSetId || sess.acctSetName)) {
        return {
          ok: true,
          account: { id: sess.acctSetId, name: sess.acctSetName },
          switched: false,
          singleUnitFallback: true
        }
      }
      return { ok: false, reason: '读取账套列表失败（userAcctSets 无数据），且未读取到当前账套，已中止导入。' }
    }
    var target = null
    if (TARGET_UNIT.unitImportCode || TARGET_UNIT.unitFullName) {
      for (var i = 0; i < sets.length; i++) {
        if (accountMatchesTarget(sets[i])) { target = sets[i]; break }
      }
    }
    if (!target && sets.length === 1) {
      target = sets[0]
      status('账套列表只有一个，按单单位账号直接使用：' + accountLabel(target))
    }
    if (!target && sess && sess.acctSetId) {
      for (var j = 0; j < sets.length; j++) {
        if (String(sets[j].id || sets[j].acctSetId || '') === sess.acctSetId) {
          target = sets[j]
          break
        }
      }
    }
    if (!target) {
      var avail = sets.map(function (s) { return accountLabel(s) }).filter(Boolean).join('、')
      return {
        ok: false,
        reason: '账套列表里没有与本单位（' + targetUnitLabel() + '）匹配的账套；可选：' + avail + '。已中止导入。'
      }
    }
    var targetId = String(target.id || target.acctSetId || '')
    if (!sess || !sess.userId) {
      if (sets.length === 1) {
        return { ok: true, account: target, switched: false, singleUnitFallback: true }
      }
      return { ok: false, reason: '读取当前会话失败（userSession/user），无法切换账套，已中止导入。' }
    }
    if (!targetId || (sess.acctSetId && sess.acctSetId === targetId)) {
      return { ok: true, account: target, switched: false }
    }
    status('🔄 切换账套：' + (sess.acctSetName || sess.acctSetId || '当前') + ' → ' + accountLabel(target) + ' ...')
    var chg = await fetchJsonWithTimeout(
      fetchFn,
      '/new-framework-engin2/changeAcctSet?userId=' + encodeURIComponent(sess.userId) +
        '&acctSetId=' + encodeURIComponent(targetId) + '&time=' + Date.now(),
      { method: 'GET', credentials: 'include' },
      10000
    )
    if (!(chg.ok && chg.json && String(chg.json.status_code) === '0000')) {
      var why = (chg.json && (chg.json.reason || chg.json.message)) || ('HTTP ' + chg.http)
      return { ok: false, reason: '切换账套请求失败（changeAcctSet：' + why + '），已中止导入。' }
    }
    // 回读校验：轮询会话，等服务端账套真正生效后再放行
    var confirmed = false
    for (var k = 0; k < 10; k++) {
      await sleep(600)
      var v = await readUserSession(fetchFn)
      if (v && v.acctSetId === targetId) { confirmed = true; break }
    }
    if (!confirmed) {
      return {
        ok: false,
        reason: '切换账套后回读校验不一致（会话仍非「' + accountLabel(target) + '」），已中止导入。'
      }
    }
    return { ok: true, account: target, switched: true }
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

  function isImportPageUrl(url) {
    return /gld-web\\/gl\\/html\\/common\\/Import\\.html/i.test(String(url || '')) &&
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
    var text = String(value || '').replace(/\\s+/g, ' ').trim()
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

  function hasStrongModelCandidate(list) {
    for (var i = 0; i < list.length; i++) {
      // score 0 = DOM <option>/<input> 的 value；1 = currentModelId/modelId 命名来源。
      // 这些才是导入页真正选中的模板；弱来源（页面文本/随机GUID）不足以提前结束轮询。
      if (modelCandidateScore(list[i]) <= 1) return true
    }
    return false
  }

  function importModelNamePref(name) {
    // 凭证导入模板优先取名字含“工资/凭证”的（本系统该模板就叫“工资”）；
    // 防止同 modelType=29 下存在多个模板时选错。
    var n = String(name || '')
    return n.indexOf('工资') >= 0 || n.indexOf('凭证') >= 0 ? 0 : 1
  }

  // 首选来源：直接调一体化“获取导入模板列表”接口拿活模板ID（确定性，不依赖导入页是否被人选过模板）。
  // 抓包坐实（2026-06-20）：POST /gld-account-server/importModel/getImportModelList?menuid=<MENUID>
  //   body: menuid=<MENUID>&modelType=29 → data[].id 即 currentModelId（modelType=29 的“工资”模板）。
  async function fetchImportModelList(fetchFn) {
    try {
      var res = await fetchFn('/gld-account-server/importModel/getImportModelList?menuid=' + MENUID, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'menuid=' + encodeURIComponent(MENUID) + '&modelType=' + encodeURIComponent(IMPORT_PARAM.modelType)
      })
      var text = await res.text()
      var json = text ? JSON.parse(text) : null
      if (!json || String(json.status_code) !== '0000' || !Array.isArray(json.data)) return []
      var out = []
      for (var i = 0; i < json.data.length; i++) {
        var m = json.data[i]
        if (!m || !isLikelyModelId(m.id)) continue
        if (String(m.model_type) !== String(IMPORT_PARAM.modelType)) continue
        out.push({ id: String(m.id), name: String(m.name || ''), source: 'getImportModelList(' + (m.name || '') + ')' })
      }
      out.sort(function (a, b) { return importModelNamePref(a.name) - importModelNamePref(b.name) })
      return out
    } catch (e) {
      return []
    }
  }

  async function buildImportParamAttempts(importWin, fetchFn) {
    // 1) 首选：调接口直接拿活模板ID（最稳，打包应用里也能用）。不再写死，服务端重建模板也能自动跟上。
    var modelCandidates = await fetchImportModelList(fetchFn)

    // 2) 接口拿不到时，再退回轮询扫描导入页 DOM（仅当导入窗口已被人手动选过模板时才有值）。
    if (!modelCandidates.length) {
      var deadline = Date.now() + 20000
      var announced = false
      for (;;) {
        modelCandidates = []
        var modelSeen = {}
        scanWindowForModelIds(importWin, 'Import.html', modelCandidates, modelSeen, [])
        if (hasStrongModelCandidate(modelCandidates)) break
        if (Date.now() >= deadline) break
        if (!announced) {
          announced = true
          status('⏳ 接口未返回模板，改从导入页读取（异步加载中）...')
        }
        await sleep(800)
      }
      modelCandidates.sort(function (a, b) { return modelCandidateScore(a) - modelCandidateScore(b) })
    }

    var attempts = []
    var attemptSeen = {}
    for (var i = 0; i < modelCandidates.length && attempts.length < 5; i++) {
      var detected = cloneImportParam()
      detected.currentModelId = modelCandidates[i].id
      addImportAttempt(attempts, attemptSeen, detected, modelCandidates[i].source)
    }
    if (!attempts.length) {
      throw new Error('未能自动识别凭证导入模板ID（getImportModelList 接口与导入页都没读到）。请确认一体化“凭证录入→导入”里存在可用的凭证导入模板后重试。')
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
    var match = /\\d{4}-(\\d{1,2})/.exec(String(label || ''))
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
          return '⚠ 凭证列表回查账套异常：当前列表 set_id=' + setIds.join(',') + '，会话账套=' + targetAccount.id + '。为避免重复上传，未自动重试，请人工核对。'
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

  function removeManagedImportIframe(root) {
    try {
      var doc = (root && root.document) || document
      var existing = doc.getElementById('payroll-voucher-import-iframe')
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
    } catch (e) {}
  }

  function injectImportIframe(root) {
    try {
      var doc = (root && root.document) || document
      removeManagedImportIframe(root)
      var url = '/gld-web/gl/html/common/Import.html?modelType=29&mode=0&menuid=' + MENUID + '&_payrollTs=' + Date.now()
      var ifr = doc.createElement('iframe')
      ifr.id = 'payroll-voucher-import-iframe'
      ifr.src = url
      ifr.style.cssText = 'position:fixed;left:-99999px;top:0;width:1200px;height:800px;border:0;z-index:-1;'
      doc.body.appendChild(ifr)
      return ifr
    } catch (e) { return null }
  }

  async function openImportPage(root) {
    var ifr = injectImportIframe(root)
    if (!ifr) return null
    await new Promise(function (resolve) {
      var done = false
      function fin() { if (!done) { done = true; resolve() } }
      try { ifr.addEventListener('load', fin) } catch (e) {}
      setTimeout(fin, 30000)
    })
    var deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        var w = ifr.contentWindow
        if (w && looksLikeImportPage(w)) return w
      } catch (e) {}
      await sleep(500)
    }
    return null
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
    // 导入前自动切换到本单位账套；切不成（找不到/切换失败/回读不一致）则中止，不导入。
    var switchRes = await ensureTargetAcctSet(rootFetch)
    if (!switchRes.ok) {
      status('❌ ' + switchRes.reason, 'err')
      clearStatusLater(15000)
      return {
        ok: false,
        reason: switchRes.reason,
        trace: TRACE,
        traceText: TRACE.join('\\n')
      }
    }
    var defaultAccount = switchRes.account
    status(
      '凭证将导入账套：' + accountLabel(defaultAccount) +
        (switchRes.switched ? '（已自动切换到本单位）' : '（当前已是本单位账套）')
    )

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

    var execWin = findVoucherWindow(root)
    if (!execWin) {
      throw new Error('当前未处于“凭证录入”页面，已停止上传，避免把文件发到错误模块。')
    }

    status('📤 推送凭证：' + RUN_LABEL + '\\n导入账套：' + (defaultAccount ? accountLabel(defaultAccount) : '默认账套（会话信息未读取到）') + ' ...')

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
    var attempts = await buildImportParamAttempts(importWin, fetchFn)
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

      if (!json && /^\\s*</.test(text || '')) {
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
    var validationFailCount = pickNumFromText(retMsg, [/数据读取校验失败条数[：:]\\s*(\\d+)/, /校验失败条数[：:]\\s*(\\d+)/])
    if (okCount === null) okCount = pickNumFromText(retMsg, [/成功(?:数)?[：:]\\s*(\\d+)/, /新增数[：:]\\s*(\\d+)/])
    var newCount = pickNumFromText(retMsg, [/新增数[：:]\\s*(\\d+)/])
    if (failCount === null) {
      failCount = pickNumFromText(retMsg, [
        /导入失败数[：:]\\s*(\\d+)/,
        /失败数[：:]\\s*(\\d+)/,
        /(?:^|[，,;；\\s])失败[：:]\\s*(\\d+)/,
        /(?:^|[，,;；\\s])失败条数[：:]\\s*(\\d+)/
      ])
    }
    if (totalCount === null) totalCount = pickNumFromText(retMsg, [/总数[：:]\\s*(\\d+)/, /共\\s*(\\d+)/])
    var detailParts = []
    if (totalCount !== null) detailParts.push('共 ' + totalCount)
    if (okCount !== null) detailParts.push('成功 ' + okCount)
    if (newCount !== null) detailParts.push('新增 ' + newCount)
    if (failCount !== null) detailParts.push('失败 ' + failCount)
    if (validationFailCount !== null) detailParts.push('校验提示 ' + validationFailCount)
    if (retMsg) detailParts.push(String(retMsg))
    var detailText = detailParts.join('，')
    var rawText = JSON.stringify(json)
    if (rawText && rawText.length > 240) rawText = rawText.slice(0, 240) + '...'

    if ((totalCount !== null && totalCount <= 0) || (failCount !== null && failCount > 0)) {
      throw new Error(
        '凭证导入未真正成功：' + (detailText || '一体化返回成功 0 条 / 存在失败行') +
        '\\n模板ID：' + (usedImportParam.currentModelId || '无模板ID') +
        '\\n一体化返回：' + rawText
      )
    }

    var verifyText = await verifyVoucherListTarget(fetchFn, defaultAccount)
    status('✅ 凭证导入完成：' + RUN_LABEL + (detailText ? '\\n' + detailText : '') +
      '\\n导入账套：' + (defaultAccount ? accountLabel(defaultAccount) : '默认账套（会话信息未读取到）') +
      '\\n模板ID：' + (usedImportParam.currentModelId || '无模板ID') +
      (verifyText ? '\\n' + verifyText : '') +
      '\\n一体化返回：' + rawText, 'ok')
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
