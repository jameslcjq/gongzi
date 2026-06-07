type AutoVoucherEntryScriptOptions = {
  autoStart?: boolean
  autoStartTargetOnly?: boolean
  showPageButton?: boolean
  requireRows?: boolean
  maxWaitTime?: number
}

export function buildAutoVoucherEntryScript(
  options: AutoVoucherEntryScriptOptions = {}
): string {
  const autoStart = options.autoStart ?? false
  const autoStartTargetOnly = options.autoStartTargetOnly ?? false
  const showPageButton = options.showPageButton ?? true
  const requireRows = options.requireRows ?? false
  const maxWaitTime = Number.isFinite(options.maxWaitTime) ? Number(options.maxWaitTime) : 30000

  return `
;(function installAutoVoucherEntry() {
  var AUTO_START = ${autoStart ? 'true' : 'false'}
  var AUTO_START_TARGET_ONLY = ${autoStartTargetOnly ? 'true' : 'false'}
  var SHOW_PAGE_BUTTON = ${showPageButton ? 'true' : 'false'}
  var REQUIRE_ROWS = ${requireRows ? 'true' : 'false'}
  var VERSION = '20260607-auto-voucher-entry-frame-target'
  var BTN_ID = 'auto-voucher-entry-btn'
  var STATUS_ID = 'auto-voucher-entry-status'
  var STORE_KEY = 'autoVoucherEntryState'

  if (window.__autoVoucherEntry && window.__autoVoucherEntry.version === VERSION && !AUTO_START) {
    window.__autoVoucherEntry.injectButton()
    return { ok: true, message: 'installed' }
  }

  if (window.__autoVoucherEntryTimer) {
    clearInterval(window.__autoVoucherEntryTimer)
    window.__autoVoucherEntryTimer = null
  }

  var DEFAULT_CONFIG = {
    maxWaitTime: ${maxWaitTime},
    saveWaitTime: 300000,
    listAmountField: 'pay_rmn_amt',
    listAmountFields: ['pay_rmn_amt', 'pay_amt', 'pay_apply_amt', 'pay_app_amt', 'amount', 'amt'],
    subjectField: 'dep_bgt_eco_code_name',
    subjectFields: ['dep_bgt_eco_code_name', 'dep_bgt_eco_name', 'dep_bgt_eco_code', 'depBgtEcoCodeName'],
    availableAmountField: 'pay_available_amt',
    availableAmountFields: ['pay_available_amt', 'available_amt', 'canuse_amt', 'useable_amt', 'balance_amt', 'remain_amt'],
    govPurchaseText: '不是政府采购',
    govPurchaseFields: ['is_gov_pur_pay', 'gov_pur_code_name', 'gov_pur_pay', 'gov_pur']
  }

  function mergeConfig(base, extra) {
    var out = {}
    Object.keys(base || {}).forEach(function (key) { out[key] = base[key] })
    Object.keys(extra || {}).forEach(function (key) {
      var value = extra[key]
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        out[key] &&
        typeof out[key] === 'object' &&
        !Array.isArray(out[key])
      ) {
        out[key] = mergeConfig(out[key], value)
      } else if (value !== undefined) {
        out[key] = value
      }
    })
    return out
  }

  var CONFIG = mergeConfig(DEFAULT_CONFIG, window.__AUTO_VOUCHER_ENTRY_JSON_CONFIG || {})
  var running = false

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function normalizeText(value) {
    return String(value || '').replace(/\\s+/g, '')
  }

  function compactText(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim()
  }

  function parseAmount(value) {
    var text = String(value == null ? '' : value)
      .replace(/,/g, '')
      .replace(/￥/g, '')
      .replace(/\\s+/g, '')
      .trim()
    if (!text) return 0
    var num = Number(text)
    return Number.isFinite(num) ? num : 0
  }

  function formatAmount(value) {
    return Number(value || 0).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }

  function getStore() {
    try {
      return window.top && window.top.sessionStorage ? window.top.sessionStorage : window.sessionStorage
    } catch (error) {
      return window.sessionStorage
    }
  }

  function status(text, kind) {
    var rootDoc = document
    try {
      if (window.top && window.top.document) rootDoc = window.top.document
    } catch (error) {}

    var el = rootDoc.getElementById(STATUS_ID)
    if (!el) {
      el = rootDoc.createElement('div')
      el.id = STATUS_ID
      el.style.cssText = [
        'position:fixed',
        'top:92px',
        'right:24px',
        'z-index:2147483647',
        'min-width:310px',
        'max-width:560px',
        'padding:13px 16px',
        'border-radius:6px',
        'box-shadow:0 6px 22px rgba(0,0,0,.24)',
        'font-size:13px',
        'line-height:1.6',
        'white-space:pre-wrap',
        'color:#fff'
      ].join(';')
      rootDoc.body.appendChild(el)
    }
    el.textContent = text
    el.style.background =
      kind === 'ok'
        ? 'rgba(34,128,80,.96)'
        : kind === 'warn'
          ? 'rgba(184,126,0,.96)'
          : kind === 'err'
            ? 'rgba(180,45,45,.96)'
            : 'rgba(32,38,46,.96)'
    console.log('[auto-voucher-entry]', text)
  }

  function clearStatusLater(ms) {
    setTimeout(function () {
      var docs = getReachableDocs()
      for (var i = 0; i < docs.length; i++) {
        var el = docs[i].getElementById(STATUS_ID)
        if (el && el.parentNode) el.parentNode.removeChild(el)
      }
    }, ms || 10000)
  }

  function isVisible(el) {
    if (!el) return false
    var target = el
    try {
      if (target.classList && target.classList.contains('l-btn-text')) {
        target = target.closest('.l-btn') || target
      }
      var win = target.ownerDocument.defaultView || window
      var style = win.getComputedStyle(target)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false
      }
      var rect = target.getBoundingClientRect()
      if (rect.width <= 0 && rect.height <= 0) {
        var parent = target.closest && target.closest('.l-btn,.window,.panel,.datagrid,.combo-panel')
        if (parent && parent !== target) return isVisible(parent)
        return false
      }
      return true
    } catch (error) {
      return true
    }
  }

  function isDocVisible(doc) {
    if (!doc || !doc.body) return false
    try {
      var frame = doc.defaultView && doc.defaultView.frameElement
      if (frame && !isVisible(frame)) return false
    } catch (error) {}
    return true
  }

  function collectDocs(win, docs, seen) {
    if (!win || seen.indexOf(win) >= 0) return
    seen.push(win)
    try {
      if (win.document && docs.indexOf(win.document) < 0) docs.push(win.document)
    } catch (error) {}
    try {
      for (var i = 0; i < win.frames.length; i++) {
        collectDocs(win.frames[i], docs, seen)
      }
    } catch (error) {}
  }

  function getReachableDocs() {
    var docs = []
    var seen = []
    collectDocs(window, docs, seen)
    try {
      if (window.top && window.top !== window) collectDocs(window.top, docs, seen)
    } catch (error) {}
    return docs.filter(isDocVisible)
  }

  function clickElement(element) {
    if (!element) return false
    try {
      element.scrollIntoView({ block: 'center', inline: 'center' })
    } catch (error) {}
    try {
      element.click()
      return true
    } catch (error) {}
    try {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return true
    } catch (error) {}
    return false
  }

  function findButton(doc, text) {
    if (!doc) return null
    var wanted = normalizeText(text)
    var nodes = doc.querySelectorAll('a,button,input[type="button"],input[type="submit"],.l-btn,.l-btn-text,span.l-btn-text')
    var partial = null
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      var host = node.classList && node.classList.contains('l-btn-text') ? (node.closest('.l-btn') || node) : node
      if (!isVisible(host)) continue
      var textValue =
        node.tagName === 'INPUT'
          ? node.value || node.getAttribute('value') || ''
          : node.innerText || node.textContent || node.title || ''
      var own = normalizeText(textValue)
      if (!own) continue
      if (own === wanted) return host
      if (!partial && own.indexOf(wanted) >= 0 && own.length <= wanted.length + 20) partial = host
    }
    return partial
  }

  function findExactButton(doc, text) {
    if (!doc) return null
    var wanted = normalizeText(text)
    var nodes = doc.querySelectorAll('a,button,input[type="button"],input[type="submit"],.l-btn,.l-btn-text,span.l-btn-text')
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      var host = node.classList && node.classList.contains('l-btn-text') ? (node.closest('.l-btn') || node) : node
      if (!isVisible(host)) continue
      var textValue =
        node.tagName === 'INPUT'
          ? node.value || node.getAttribute('value') || ''
          : node.innerText || node.textContent || node.title || ''
      if (normalizeText(textValue) === wanted) return host
    }
    return null
  }

  function findButtonAcross(text, preferredDoc) {
    if (preferredDoc) {
      var local = findButton(preferredDoc, text)
      if (local) return local
    }
    var docs = getReachableDocs()
    for (var i = 0; i < docs.length; i++) {
      var btn = findButton(docs[i], text)
      if (btn) return btn
    }
    return null
  }

  // 列表页用页内 iframe 直达打开时，往往不会像走门户菜单那样自动触发查询，导致网格停在"暂无数据"。
  // 列表为空时主动点一次“查询”（精确匹配，避开“查询规则/查询条件”），把刚导入的数据 load 出来。
  function triggerListQuery(doc) {
    if (!doc) return false
    var btn = findExactButton(doc, '查询') || findExactButton(doc, '刷新')
    if (btn && clickElement(btn)) return true
    return false
  }

  function isSalaryPaymentPage(doc) {
    if (!doc) return false
    try {
      var href = doc.location && doc.location.href ? doc.location.href : ''
      if (href.indexOf('/salary-pro-web/') >= 0 || href.indexOf('salSalaryAuditSCZF') >= 0) {
        return true
      }
    } catch (error) {}

    var hasSalaryFields = !!doc.querySelector(
      '[field="item_name"],[field="saltype_name"],[field="item_rule_type_name"],[field="unalready_matc_amonty"]'
    )
    if (!hasSalaryFields) return false
    return !!(
      findButton(doc, '额度匹配') ||
      findButton(doc, '生成支付') ||
      findButton(doc, '生成支付申请')
    )
  }

  function getCellText(row, field) {
    if (!row) return ''
    var cell = row.querySelector('[field="' + String(field).replace(/"/g, '\\\\"') + '"]')
    if (!cell) return ''
    var titleNode = cell.querySelector('[title]')
    return compactText(titleNode ? titleNode.getAttribute('title') : (cell.innerText || cell.textContent || ''))
  }

  function fieldExists(doc, field) {
    if (!doc || !field) return false
    return !!doc.querySelector('[field="' + String(field).replace(/"/g, '\\\\"') + '"]')
  }

  function asArray(value, fallback) {
    if (Array.isArray(value) && value.length) return value
    return fallback || []
  }

  function findFieldByHeader(doc, candidates, labels) {
    if (!doc) return ''
    var fields = asArray(candidates, [])
    for (var i = 0; i < fields.length; i++) {
      if (fieldExists(doc, fields[i])) return fields[i]
    }

    var wantedLabels = asArray(labels, []).map(normalizeText).filter(Boolean)
    var headers = Array.prototype.slice.call(
      doc.querySelectorAll('.datagrid-header [field], .datagrid-htable [field], .datagrid-view [field]')
    )
    for (var h = 0; h < headers.length; h++) {
      var node = headers[h]
      var field = node.getAttribute('field')
      if (!field || field === 'ck') continue
      var text = normalizeText(node.innerText || node.textContent || node.getAttribute('title') || '')
      if (!text) continue
      for (var l = 0; l < wantedLabels.length; l++) {
        if (text.indexOf(wantedLabels[l]) >= 0 || wantedLabels[l].indexOf(text) >= 0) {
          return field
        }
      }
    }
    return ''
  }

  function resolveSubjectField(doc) {
    return findFieldByHeader(
      doc,
      asArray(CONFIG.subjectFields, [CONFIG.subjectField]),
      ['部门支出经济分类', '支出经济分类', '部门经济分类']
    ) || CONFIG.subjectField
  }

  function resolveListAmountField(doc) {
    return findFieldByHeader(
      doc,
      asArray(CONFIG.listAmountFields, [CONFIG.listAmountField]),
      ['金额', '支付金额', '申请金额']
    ) || CONFIG.listAmountField
  }

  function resolveAvailableAmountField(doc) {
    return findFieldByHeader(
      doc,
      asArray(CONFIG.availableAmountFields, [CONFIG.availableAmountField]),
      ['可用金额', '可用额度', '可用余额', '余额']
    ) || CONFIG.availableAmountField
  }

  function isDirectPayExternalListDoc(doc) {
    if (!doc) return false
    try {
      var href = doc.location && doc.location.href ? doc.location.href : ''
      if (href.indexOf('/pay-voucher-web/record/templateslist.html') >= 0) return true
    } catch (error) {}
    var text = normalizeText(doc.body ? (doc.body.innerText || doc.body.textContent || '') : '')
    return text.indexOf('导入批次号') >= 0 &&
      text.indexOf('预算单位') >= 0 &&
      text.indexOf('预算项目') >= 0 &&
      !!findExactButton(doc, '生成')
  }

  function rowIndex(row, fallback) {
    if (!row) return fallback
    var attr = row.getAttribute('datagrid-row-index')
    if (attr !== null && attr !== '') {
      var idx = Number(attr)
      if (Number.isFinite(idx)) return idx
    }
    var id = row.getAttribute('id') || ''
    var match = id.match(/-(\\d+)$/)
    if (match) return Number(match[1])
    return fallback
  }

  function getListRowPairs(doc, subjectField) {
    if (!doc) return []
    var leftRows = Array.prototype.slice.call(
      doc.querySelectorAll('.datagrid-view1 .datagrid-btable tr[id*="grid_datagrid-row"]:not([id*="quota-grid"]):not([id*="import-grid"])')
    ).filter(function (row) {
      return isVisible(row) && row.querySelector('input[type="checkbox"]')
    })
    var rightRows = Array.prototype.slice.call(
      doc.querySelectorAll('.datagrid-view2 .datagrid-btable tr[id*="grid_datagrid-row"]:not([id*="quota-grid"]):not([id*="import-grid"])')
    ).filter(function (row) {
      return isVisible(row) && row.querySelector('[field="' + String(subjectField || CONFIG.subjectField).replace(/"/g, '\\\\"') + '"]')
    })
    var rightByIndex = {}
    rightRows.forEach(function (row, i) {
      rightByIndex[rowIndex(row, i)] = row
    })
    return leftRows.map(function (leftRow, i) {
      var idx = rowIndex(leftRow, i)
      return {
        index: i,
        gridIndex: idx,
        leftRow: leftRow,
        rightRow: rightByIndex[idx] || rightRows[i] || null
      }
    }).filter(function (pair) {
      return !!pair.rightRow
    })
  }

  function getQuotaRowPairs(doc, subjectField) {
    if (!doc) return []
    var rightRows = Array.prototype.slice.call(
      doc.querySelectorAll('tr[id*="quota-grid_datagrid-row-r2-2"], tr[id*="quota-grid"][id*="-r2-2"], .datagrid-view2 .datagrid-btable tr[id*="quota-grid"]')
    ).filter(function (row) {
      return isVisible(row) && row.querySelector('[field="' + String(subjectField || CONFIG.subjectField).replace(/"/g, '\\\\"') + '"]')
    })
    var leftRows = Array.prototype.slice.call(
      doc.querySelectorAll('tr[id*="quota-grid_datagrid-row-r2-1"], tr[id*="quota-grid"][id*="-r2-1"], .datagrid-view1 .datagrid-btable tr[id*="quota-grid"]')
    ).filter(function (row) {
      return isVisible(row) && row.querySelector('input[type="checkbox"]')
    })
    var leftByIndex = {}
    leftRows.forEach(function (row, i) {
      leftByIndex[rowIndex(row, i)] = row
    })
    return rightRows.map(function (rightRow, i) {
      var idx = rowIndex(rightRow, i)
      return {
        index: i,
        gridIndex: idx,
        rightRow: rightRow,
        leftRow: leftByIndex[idx] || leftRows[i] || null
      }
    })
  }

  function getListSignature(pairs, subjectField, amountField) {
    return pairs.slice(0, 6).map(function (pair) {
      return [
        getCellText(pair.rightRow, subjectField || CONFIG.subjectField),
        getCellText(pair.rightRow, amountField || CONFIG.listAmountField)
      ].join('|')
    }).join('||')
  }

  function getListPageFromDoc(doc) {
    if (!doc) return null
    if (isSalaryPaymentPage(doc)) return null
    if (!doc.querySelector('.datagrid-view1')) return null
    var generateBtn = findExactButton(doc, '生成')
    if (!generateBtn) return null
    var returnBtn = findButton(doc, '返回')
    var subjectField = resolveSubjectField(doc)
    var amountField = resolveListAmountField(doc)
    var quotaPairs = getQuotaRowPairs(doc, subjectField)
    if (returnBtn || quotaPairs.length > 0) return null
    if (!fieldExists(doc, subjectField)) {
      return null
    }
    if (!fieldExists(doc, amountField) && !isDirectPayExternalListDoc(doc)) {
      return null
    }
    return {
      doc: doc,
      pairs: getListRowPairs(doc, subjectField),
      generateBtn: generateBtn,
      subjectField: subjectField,
      amountField: amountField
    }
  }

  function getCurrentFrameListPage() {
    if (!isDocVisible(document)) return null
    return getListPageFromDoc(document)
  }

  function getListPage() {
    var docs = getReachableDocs()
    var fallback = null
    for (var i = 0; i < docs.length; i++) {
      var page = getListPageFromDoc(docs[i])
      if (!page) continue
      if (page.pairs.length > 0) return page
      if (!fallback) fallback = page
    }
    return fallback
  }

  function getMatchPage() {
    var docs = getReachableDocs()
    for (var i = 0; i < docs.length; i++) {
      var subjectField = resolveSubjectField(docs[i])
      var quotaPairs = getQuotaRowPairs(docs[i], subjectField)
      if (!quotaPairs.length) continue
      var returnBtn = findButton(docs[i], '返回')
      if (returnBtn) {
        return {
          doc: docs[i],
          quotaPairs: quotaPairs,
          returnBtn: returnBtn,
          subjectField: subjectField,
          availableAmountField: resolveAvailableAmountField(docs[i])
        }
      }
    }
    return null
  }

  function clickDialogButton(labels) {
    var docs = getReachableDocs()
    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d]
      var scopes = Array.prototype.slice.call(
        doc.querySelectorAll('.messager-window,.window,.panel.window,.layui-layer,.el-message-box,.dialog-button')
      ).filter(isVisible)
      if (!scopes.length) scopes = [doc]
      for (var s = 0; s < scopes.length; s++) {
        for (var i = 0; i < labels.length; i++) {
          var btn = findButton(scopes[s].ownerDocument || doc, labels[i])
          if (btn && isVisible(btn) && clickElement(btn)) return true
        }
      }
    }
    return false
  }

  async function waitForListPage(maxWait, alreadyWorked) {
    status('等待直接支付列表页...')
    var start = Date.now()
    var lastLog = 0
    var emptySeenAt = 0
    var lastQueryAt = 0
    // 空列表的处理分两种情形：
    // ① 已经录入/跳过过至少一条（alreadyWorked）后再遇到空列表 = 数据已全部处理完，快速返回空页面，
    //    交上层凭 savedCount>0 判成功——这是“全做成功却被误报失败”的根因修复，绝不能再死等返回 null。
    // ② 还没处理过就空（首次进列表）：直达 iframe 常不会自动查询，主动点“查询”load 数据，并多等一会儿
    //    （require 模式 20s）；到点仍空再返回空页面，让上层报准确的“列表为空”，而不是误导性的“无法进入列表页”。
    var emptyGrace = alreadyWorked ? 1200 : (REQUIRE_ROWS ? 20000 : 2500)
    while (Date.now() - start < (maxWait || CONFIG.maxWaitTime)) {
      var page = getListPage()
      if (page) {
        if (Date.now() - lastLog > 2000) {
          console.log('[auto-voucher-entry] list rows=' + page.pairs.length + ', generate=true')
          lastLog = Date.now()
        }
        if (page.pairs.length > 0) {
          await sleep(350)
          var fresh = getListPage()
          return fresh || page
        }
        if (!emptySeenAt) emptySeenAt = Date.now()
        // 仅“首次进列表就空”才主动点“查询”：先给自动加载 1.5s，仍空则点（节流，每 4s 一次）。
        // 已处理过后的空表是正常清空，不再点查询、也不久等。
        if (!alreadyWorked && Date.now() - emptySeenAt > 1500 && Date.now() - lastQueryAt > 4000) {
          if (triggerListQuery(page.doc)) {
            console.log('[auto-voucher-entry] 列表为空，已点击“查询”触发加载')
          }
          lastQueryAt = Date.now()
        }
        // 空表等待封顶：超过 emptyGrace 仍为空，返回空页面（交给上层判定，不再返回 null）。
        if (Date.now() - emptySeenAt > emptyGrace) return page
      } else {
        emptySeenAt = 0
      }
      if (Date.now() - lastLog > 2000) {
        console.log('[auto-voucher-entry] waiting list page...')
        lastLog = Date.now()
      }
      await sleep(300)
    }
    return null
  }

  async function waitForMatchPage(maxWait) {
    status('等待指标匹配页...')
    var start = Date.now()
    var lastLog = 0
    while (Date.now() - start < (maxWait || CONFIG.maxWaitTime)) {
      var page = getMatchPage()
      if (page && page.quotaPairs.length > 0) {
        if (Date.now() - lastLog > 2000) {
          console.log('[auto-voucher-entry] quota rows=' + page.quotaPairs.length + ', return=true')
          lastLog = Date.now()
        }
        await sleep(650)
        var fresh = getMatchPage()
        return fresh || page
      }
      if (Date.now() - lastLog > 2000) {
        console.log('[auto-voucher-entry] waiting match page...')
        lastLog = Date.now()
      }
      await sleep(450)
    }
    return null
  }

  async function waitForListAfterSave(beforeSignature, beforeCount, subjectField, amountField) {
    var start = Date.now()
    var firstListAt = 0
    var emptySeenAt = 0
    var lastPage = null
    var lastStatusAt = 0
    var timeout = CONFIG.saveWaitTime || CONFIG.maxWaitTime
    while (Date.now() - start < timeout) {
      clickDialogButton(['确定', '确认', '是', 'OK'])
      if (Date.now() - lastStatusAt > 3000) {
        var elapsed = Math.round((Date.now() - start) / 1000)
        status('保存处理中，请等待... 已等待 ' + elapsed + ' 秒')
        lastStatusAt = Date.now()
      }
      var page = getListPage()
      if (page) {
        if (!firstListAt) firstListAt = Date.now()
        lastPage = page
        if (page.pairs.length === 0) {
          if (!emptySeenAt) emptySeenAt = Date.now()
          if (Date.now() - emptySeenAt > 2500) return page
        } else {
          emptySeenAt = 0
          var signature = getListSignature(
            page.pairs,
            page.subjectField || subjectField,
            page.amountField || amountField
          )
          if (signature !== beforeSignature || page.pairs.length !== beforeCount) {
            await sleep(400)
            return getListPage() || page
          }
        }
        if (Date.now() - firstListAt > 7000) return page
      }
      await sleep(450)
    }
    return lastPage
  }

  function clearListChecks(doc) {
    Array.prototype.slice.call(doc.querySelectorAll('.datagrid-view1 input[type="checkbox"]:checked')).forEach(function (cb) {
      clickElement(cb)
    })
  }

  function extractSubjectCode(subject) {
    var match = String(subject || '').trim().match(/^([0-9A-Za-z]+)/)
    return match ? match[1] : normalizeText(subject)
  }

  function findGovCell(doc) {
    var importRows = Array.prototype.slice.call(
      doc.querySelectorAll('tr[id*="import-grid_datagrid-row"], .datagrid-view2 .datagrid-btable tr[id*="import-grid"]')
    ).filter(isVisible)
    var row = importRows[0]
    if (!row) return null
    for (var i = 0; i < CONFIG.govPurchaseFields.length; i++) {
      var cell = row.querySelector('[field="' + CONFIG.govPurchaseFields[i] + '"]')
      if (cell) return cell
    }
    return row.querySelector('[field*="gov"]') || row.querySelector('[field]')
  }

  async function setGovPurchaseNo(doc) {
    var cell = findGovCell(doc)
    if (!cell) return false
    try {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
    } catch (error) {}
    await sleep(350)
    var docs = getReachableDocs()
    for (var d = 0; d < docs.length; d++) {
      var items = docs[d].querySelectorAll('.combo-panel .combobox-item,.combobox-item,div[role="option"],li')
      for (var i = 0; i < items.length; i++) {
        if (!isVisible(items[i])) continue
        if (compactText(items[i].innerText || items[i].textContent).indexOf(CONFIG.govPurchaseText) >= 0) {
          clickElement(items[i])
          return true
        }
      }
    }
    return false
  }

  function setButtonRunning(isRunning) {
    var docs = getReachableDocs()
    for (var i = 0; i < docs.length; i++) {
      var btn = docs[i].getElementById(BTN_ID)
      if (!btn) continue
      var text = btn.querySelector('.l-btn-text') || btn
      text.textContent = isRunning ? '自动录入中...' : '自动录入'
      btn.style.opacity = isRunning ? '.72' : '1'
    }
  }

  async function returnToList(matchPage) {
    var returnBtn = (matchPage && matchPage.returnBtn) || findButtonAcross('返回', matchPage && matchPage.doc)
    if (!returnBtn) return null
    clickElement(returnBtn)
    return waitForListPage()
  }

  async function startBatchProcess(startIndex) {
    if (running) {
      alert('自动录入正在运行，请等待当前任务完成。')
      return { ok: false, message: 'running' }
    }

    running = true
    setButtonRunning(true)

    var currentIndex = Number(startIndex || 0)
    var isRetrySingle = false
    var savedCount = 0
    var skippedCount = 0

    try {
      status('开始自动录入，从 Index ' + currentIndex + ' 开始')
      while (true) {
        // 已经保存/跳过过至少一条后，空列表 = 全部处理完，让 waitForListPage 快速返回空页面判成功，
        // 不再因 require 模式死等超时返回 null 而把成功误报成失败。
        var listPage = await waitForListPage(undefined, savedCount > 0 || skippedCount > 0)
        if (!listPage) throw new Error('无法进入直接支付列表页')

        var pairs = listPage.pairs
        if (pairs.length === 0 || currentIndex >= pairs.length) {
          getStore().removeItem(STORE_KEY)
          if (REQUIRE_ROWS && savedCount === 0 && skippedCount === 0) {
            status('自动录入停止：直接支付外部数据列表为空，未找到刚导入的保险数据。', 'err')
            return {
              ok: false,
              message: '直接支付外部数据列表为空，未找到刚导入的保险数据。请确认导入日志或刷新直接支付外部数据页面后重试。',
              savedCount: savedCount,
              skippedCount: skippedCount
            }
          }
          status('处理完成。成功保存 ' + savedCount + ' 次，跳过 ' + skippedCount + ' 条。', 'ok')
          clearStatusLater(8000)
          return { ok: true, savedCount: savedCount, skippedCount: skippedCount }
        }

        clearListChecks(listPage.doc)
        await sleep(220)

        listPage = getListPage() || listPage
        pairs = listPage.pairs
        var subjectField = listPage.subjectField || CONFIG.subjectField
        var amountField = listPage.amountField || CONFIG.listAmountField
        var targetPair = pairs[currentIndex]
        if (!targetPair) {
          currentIndex = 0
          continue
        }

        var targetSubject = getCellText(targetPair.rightRow, subjectField)
        if (!targetSubject) {
          skippedCount += 1
          currentIndex += 1
          isRetrySingle = false
          continue
        }

        var beforeSignature = getListSignature(pairs, subjectField, amountField)
        var beforeCount = pairs.length
        var batchCount = 0
        var totalAmount = 0
        var lastSelectedIndex = currentIndex

        if (isRetrySingle) {
          var cb = targetPair.leftRow.querySelector('input[type="checkbox"]')
          if (cb && !cb.checked) clickElement(cb)
          totalAmount = parseAmount(getCellText(targetPair.rightRow, amountField))
          batchCount = cb ? 1 : 0
        } else {
          for (var i = currentIndex; i < pairs.length; i++) {
            var pair = pairs[i]
            var subject = getCellText(pair.rightRow, subjectField)
            if (subject !== targetSubject) continue
            var checkbox = pair.leftRow.querySelector('input[type="checkbox"]')
            if (!checkbox) continue
            if (!checkbox.checked) clickElement(checkbox)
            totalAmount += parseAmount(getCellText(pair.rightRow, amountField))
            batchCount += 1
            lastSelectedIndex = i
          }
        }

        if (batchCount <= 0) {
          skippedCount += 1
          currentIndex += 1
          isRetrySingle = false
          continue
        }

        status('已勾选 ' + batchCount + ' 条：' + targetSubject + '\\n金额：' + formatAmount(totalAmount))
        await sleep(300)

        var generateBtn = findExactButton(listPage.doc, '生成') || listPage.generateBtn
        if (!generateBtn) throw new Error('找不到“生成”按钮')
        clickElement(generateBtn)

        getStore().setItem(STORE_KEY, JSON.stringify({
          currentIndex: currentIndex,
          nextIndex: lastSelectedIndex + 1,
          batchCount: batchCount,
          currentDepEco: targetSubject,
          currentAmount: totalAmount
        }))

        var matchPage = await waitForMatchPage()
        if (!matchPage) throw new Error('生成后没有进入指标匹配页')

        var targetCode = extractSubjectCode(targetSubject)
        var matchedPair = null
        var availableAmount = 0
        for (var q = 0; q < matchPage.quotaPairs.length; q++) {
          var quotaPair = matchPage.quotaPairs[q]
          var matchSubjectField = matchPage.subjectField || subjectField
          var cellText = getCellText(quotaPair.rightRow, matchSubjectField)
          if (cellText && cellText.indexOf(targetCode) === 0) {
            matchedPair = quotaPair
            availableAmount = parseAmount(getCellText(quotaPair.rightRow, matchPage.availableAmountField || CONFIG.availableAmountField))
            break
          }
        }

        if (!matchedPair) {
          status('未找到匹配指标：' + targetCode + '，跳过当前数据。', 'warn')
          await returnToList(matchPage)
          skippedCount += 1
          currentIndex += 1
          isRetrySingle = false
          continue
        }

        if (totalAmount > availableAmount) {
          status(
            '余额不足：' + targetCode + '\\n需要：' + formatAmount(totalAmount) + '\\n可用：' + formatAmount(availableAmount),
            'warn'
          )
          await returnToList(matchPage)
          if (batchCount > 1) {
            isRetrySingle = true
          } else {
            skippedCount += 1
            currentIndex += 1
            isRetrySingle = false
          }
          continue
        }

        var quotaCheckbox = matchedPair.leftRow && matchedPair.leftRow.querySelector('input[type="checkbox"]')
        if (quotaCheckbox && !quotaCheckbox.checked) clickElement(quotaCheckbox)
        await sleep(300)

        await setGovPurchaseNo(matchPage.doc)
        await sleep(450)

        var saveBtn = findButton(matchPage.doc, '保存') || findButtonAcross('保存', matchPage.doc)
        if (!saveBtn) throw new Error('找不到“保存”按钮')
        status('保存：' + targetSubject + '\\n金额：' + formatAmount(totalAmount))
        clickElement(saveBtn)

        var refreshedList = await waitForListAfterSave(beforeSignature, beforeCount, subjectField, amountField)
        if (!refreshedList) throw new Error('保存后没有回到列表页')

        savedCount += 1
        var afterSignature = getListSignature(
          refreshedList.pairs,
          refreshedList.subjectField || subjectField,
          refreshedList.amountField || amountField
        )
        var afterCount = refreshedList.pairs.length
        currentIndex =
          afterSignature === beforeSignature && afterCount === beforeCount
            ? Math.min(lastSelectedIndex + 1, afterCount)
            : 0
        isRetrySingle = false
        getStore().setItem(STORE_KEY, JSON.stringify({ currentIndex: currentIndex }))
        await sleep(350)
      }
    } catch (error) {
      var msg = error && error.message ? error.message : String(error)
      status('自动录入停止：' + msg, 'err')
      return { ok: false, message: msg, savedCount: savedCount, skippedCount: skippedCount }
    } finally {
      running = false
      setButtonRunning(false)
    }
  }

  async function startBatchProcessIfCurrentFrameTarget() {
    var startedAt = Date.now()
    // 本 frame 就是直接支付列表页(templateslist) 时，多等一会儿让 easyui 数据表格初始化完成：
    // iframe 直达时 URL 很快就绪、但表格(.datagrid-view1+“生成”)要等 JS/AJAX 再渲染，
    // 旧的 10s 窗口会在表格就绪前就放弃 → “命中 0 个直接支付列表页”。
    // 其它 frame（门户/凭证录入/about:blank）不可能是目标，快速跳过，避免拖慢 drainAllFrames。
    var isTemplatesFrame = false
    try {
      isTemplatesFrame = /pay-voucher-web\\/record\\/templateslist/i.test(String(location && location.href ? location.href : ''))
    } catch (error) {}
    var targetWait = isTemplatesFrame ? 45000 : Math.min(8000, CONFIG.maxWaitTime || 8000)
    if (isTemplatesFrame) {
      console.log('[auto-voucher-entry] 本 frame 是直接支付列表页，等待表格初始化（最多 ' + Math.round(targetWait / 1000) + 's）...')
    }
    while (Date.now() - startedAt < targetWait) {
      if (getCurrentFrameListPage()) {
        return startBatchProcess(0)
      }
      await sleep(500)
    }
    if (isTemplatesFrame) {
      console.log('[auto-voucher-entry] 直接支付列表页表格在 ' + Math.round((Date.now() - startedAt) / 1000) + 's 内仍未就绪，跳过自启动')
    }
    return {
      ok: false,
      skipped: true,
      message: '非直接支付外部数据列表页，跳过自启动',
      frameHref: String(location && location.href ? location.href : '')
    }
  }

  function getController() {
    try {
      if (window.top && window.top.__autoVoucherEntry && window.top.__autoVoucherEntry.version === VERSION) {
        return window.top.__autoVoucherEntry
      }
    } catch (error) {}
    return window.__autoVoucherEntry
  }

  function injectButton() {
    var docs = getReachableDocs()
    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i]
      var existing = doc.getElementById(BTN_ID)
      if (!SHOW_PAGE_BUTTON) {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        continue
      }
      var page = getListPageFromDoc(doc)
      var isTargetPage = !!page

      if (!isTargetPage) {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        continue
      }
      if (existing) continue

      var btn = doc.createElement('a')
      btn.id = BTN_ID
      btn.href = 'javascript:void(0);'
      btn.className = 'easyui-linkbutton action-btn btn_level_2 l-btn l-btn-small l-btn-plain'
      btn.style.cssText = [
        'display:inline-block',
        'margin-left:6px',
        'padding:0 10px',
        'height:28px',
        'line-height:28px',
        'background:#28a745',
        'color:#fff',
        'border-radius:2px',
        'text-decoration:none',
        'vertical-align:middle',
        'font-weight:700'
      ].join(';')
      btn.innerHTML = '<span class="l-btn-left"><span class="l-btn-text">自动录入</span></span>'
      btn.onclick = function (event) {
        event.preventDefault()
        event.stopPropagation()
        var controller = getController()
        if (controller && typeof controller.startBatchProcess === 'function') {
          controller.startBatchProcess(0)
        } else {
          startBatchProcess(0)
        }
      }

      var more = doc.querySelector('.btn-more-content')
      if (more && more.parentNode) {
        more.parentNode.insertBefore(btn, more.nextSibling)
      } else {
        var generate = findExactButton(doc, '生成')
        var anchor = generate && generate.closest ? (generate.closest('a') || generate) : generate
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling)
        else doc.body.appendChild(btn)
      }
    }
  }

  function canRun() {
    return !!getListPage()
  }

  window.__autoVoucherEntry = {
    version: VERSION,
    canRun: canRun,
    injectButton: injectButton,
    startBatchProcess: startBatchProcess
  }

  window.addEventListener('load', injectButton)
  window.__autoVoucherEntryTimer = setInterval(injectButton, 1500)
  injectButton()

  if (AUTO_START) {
    if (AUTO_START_TARGET_ONLY) return startBatchProcessIfCurrentFrameTarget()
    return startBatchProcess(0)
  }
  return { ok: true, message: 'installed' }
})()
`
}
