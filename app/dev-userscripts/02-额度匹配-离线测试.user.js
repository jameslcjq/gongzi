// ==UserScript==
// @name         工资系统-额度匹配调试（离线）
// @namespace    https://www.hujiuxi.top/gongzi/dev
// @version      2026.06.04
// @description  离线油猴调试版：在一体化生成支付页面测试额度匹配、修改、保存、重新选行。
// @author       老九 / Codex
// @match        http://172.24.147.202/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==


;(function installSalaryQuotaMatch() {
  var AUTO_START = false
  var SHOW_PAGE_BUTTON = true
  var VERSION = '20260604-salary-quota-match-unmatched-amount-first'
  var BTN_ID = 'salary-quota-match-btn'
  var STATUS_ID = 'salary-quota-match-status'
  var LOCAL_SUMMARY = (function () {
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
  })()
  var PERSONNEL_EXPENSE_CODES = ['30101', '30102', '30103', '30106', '30107', '30108', '30109', '30110', '30111', '30112', '30113']

  try {
    ;(window.top || window).__salaryQuotaMatchLocalSummary = LOCAL_SUMMARY
  } catch (error) {
    window.__salaryQuotaMatchLocalSummary = LOCAL_SUMMARY
  }

  if (window.__salaryQuotaMatch && window.__salaryQuotaMatch.version === VERSION) {
    window.__salaryQuotaMatch.injectButton()
    if (AUTO_START) return window.__salaryQuotaMatch.start()
    return { ok: true, message: 'installed' }
  }

  if (window.__salaryQuotaMatchTimer) {
    clearInterval(window.__salaryQuotaMatchTimer)
    window.__salaryQuotaMatchTimer = null
  }

  var running = false
  var CONFIG = {
    maxWaitTime: 30000,
    rowSettleWait: 900,
    saveWaitTime: 45000,
    autoCreatePayment: true,
    itemNameField: 'item_name',
    itemTypeFields: ['saltype_name', 'saltype_code', 'item_rule_type_name'],
    itemAmountFields: ['unalready_matc_amonty', 'unmatch_amount', 'item_money', 'salary_money'],
    quotaAmountField: 'pay_money',
    quotaAvailableFields: ['real_canuse_amount', 'balance_canuse_amount', 'pay_available_amt', 'balance_sum_amount'],
    quotaTextFields: [
      'dep_bgt_eco_codename',
      'dep_bgt_eco_id',
      'dep_bgt_eco_code',
      'dep_bgt_eco_name',
      'gov_bgt_eco_codename',
      'gov_bgt_eco_code',
      'gov_bgt_eco_name',
      'pro_name',
      'doc_no_name',
      'doc_no_codename',
      'exp_func_codename'
    ]
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, '')
  }

  function parseAmountValue(value) {
    var text = String(value == null ? '' : value)
      .replace(/,/g, '')
      .replace(/￥/g, '')
      .replace(/元/g, '')
      .replace(/\s+/g, '')
      .trim()
    if (!text) return null
    var num = Number(text)
    return Number.isFinite(num) ? num : null
  }

  function parseAmount(value) {
    var num = parseAmountValue(value)
    return num == null ? 0 : num
  }

  function roundMoney(value) {
    var num = Number(value || 0)
    if (!Number.isFinite(num)) return 0
    return Math.round(num * 100) / 100
  }

  function formatAmount(value) {
    return Number(value || 0).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }

  function moneyEquals(a, b) {
    return Math.abs(roundMoney(a) - roundMoney(b)) <= 0.01
  }

  function amountMismatchReason(label, localAmount, pageAmount) {
    return (
      label +
      '金额不一致，已停止自动匹配。网页金额：' +
      formatAmount(pageAmount) +
      '，本地明细合计：' +
      formatAmount(localAmount) +
      '，差额：' +
      formatAmount(roundMoney(pageAmount - localAmount))
    )
  }

  function getLocalSummary() {
    try {
      return ((window.top || window).__salaryQuotaMatchLocalSummary || LOCAL_SUMMARY)
    } catch (error) {
      return window.__salaryQuotaMatchLocalSummary || LOCAL_SUMMARY
    }
  }

  // 前置总额校验（规则草稿〈前置校验/报表口径〉）：网页当前 001 批次工资项总额，
  // 必须等于「实发合计 − 002交通费」。不一致就停止，避免把额度匹配挂到错误金额上。
  function checkTotalBeforeMatch(itemRows) {
    var ls = getLocalSummary()
    if (!ls || !ls.ok) {
      return { ok: false, message: '前置校验失败：本地工资汇总读取失败，已停止自动匹配。' + ((ls && ls.message) || '') }
    }
    if (typeof ls.actualPayTotal !== 'number' || ls.actualPayTotal <= 0) {
      return {
        ok: false,
        message: '前置校验失败：未读取到当月报账“实发合计”。请先在“工资业务 → 月度工资”生成当月报账，再做额度匹配。'
      }
    }
    var pageTotal = 0
    var list = itemRows || []
    for (var i = 0; i < list.length; i++) {
      var amt = getItemAmount(list[i])
      if (amt > 0) pageTotal += amt
    }
    pageTotal = roundMoney(pageTotal)
    var traffic002 = roundMoney(ls.traffic002Total || 0)
    var expected = roundMoney(ls.actualPayTotal - traffic002)
    if (!moneyEquals(pageTotal, expected)) {
      return {
        ok: false,
        message:
          '前置总额校验未通过，已停止自动匹配：\n网页工资项总额：' + formatAmount(pageTotal) +
          '\n本地应匹配（实发合计 ' + formatAmount(ls.actualPayTotal) + ' − 002交通费 ' + formatAmount(traffic002) + '）：' + formatAmount(expected) +
          '\n差额：' + formatAmount(roundMoney(pageTotal - expected))
      }
    }
    status('前置校验通过：网页工资项总额 ' + formatAmount(pageTotal) + ' = 实发合计 − 002交通费 = ' + formatAmount(expected), 'ok')
    return { ok: true }
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
        'min-width:320px',
        'max-width:600px',
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
    console.log('[salary-quota-match]', text)
  }

  function isVisible(el) {
    if (!el) return false
    try {
      var host = el.classList && el.classList.contains('l-btn-text') ? (el.closest('.l-btn') || el) : el
      var win = host.ownerDocument.defaultView || window
      var style = win.getComputedStyle(host)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      var rect = host.getBoundingClientRect()
      if (rect.width <= 0 && rect.height <= 0) return false
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
      for (var i = 0; i < win.frames.length; i++) collectDocs(win.frames[i], docs, seen)
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
      if (host && (host.id === BTN_ID || (host.closest && host.closest('#' + BTN_ID)))) continue
      if (!isVisible(host)) continue
      var value = node.tagName === 'INPUT'
        ? node.value || node.getAttribute('value') || ''
        : node.innerText || node.textContent || node.title || ''
      var own = normalizeText(value)
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
      if (host && (host.id === BTN_ID || (host.closest && host.closest('#' + BTN_ID)))) continue
      if (!isVisible(host)) continue
      var value = node.tagName === 'INPUT'
        ? node.value || node.getAttribute('value') || ''
        : node.innerText || node.textContent || node.title || ''
      if (normalizeText(value) === wanted) return host
    }
    return null
  }

  function visibleButtonTexts(doc) {
    if (!doc) return ''
    var nodes = doc.querySelectorAll('a,button,input[type="button"],input[type="submit"],.l-btn,.l-btn-text,span.l-btn-text')
    var seen = []
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      var host = node.classList && node.classList.contains('l-btn-text') ? (node.closest('.l-btn') || node) : node
      if (!isVisible(host)) continue
      var value = node.tagName === 'INPUT'
        ? node.value || node.getAttribute('value') || ''
        : node.innerText || node.textContent || node.title || ''
      var text = compactText(value)
      if (!text || seen.indexOf(text) >= 0) continue
      seen.push(text)
      if (seen.length >= 12) break
    }
    return seen.join('、')
  }

  function isSalaryPaymentPage(doc) {
    if (!doc) return false
    try {
      var href = doc.location && doc.location.href ? doc.location.href : ''
      if (href.indexOf('salSalaryAuditSCZF') >= 0 || href.indexOf('/salaryGiveOut/') >= 0) {
        return true
      }
    } catch (error) {}

    if (
      doc.querySelector(
        '[field="item_name"],[field="saltype_name"],[field="item_rule_type_name"],[field="unalready_matc_amonty"],[field="unmatch_amount"],[field="pay_money"],[field="real_canuse_amount"],[field="balance_canuse_amount"]'
      )
    ) {
      return true
    }

    return !!findExactButton(doc, '额度匹配')
  }

  function findSalaryActionAnchor(doc) {
    if (!isSalaryPaymentPage(doc)) return null
    return findExactButton(doc, '额度匹配') || findExactButton(doc, '生成支付')
  }

  function getCurrentSalaryBatch(doc) {
    var state = { value: '', text: '' }
    if (!doc) return state
    var valueInput = doc.querySelector('input[name="salbatch_id"].textbox-value') || doc.querySelector('input#salbatch_id')
    if (valueInput && valueInput.value != null) state.value = compactText(valueInput.value)
    var combo = valueInput && valueInput.closest ? valueInput.closest('.textbox.combo') : null
    if (!combo) {
      var idInput = doc.querySelector('input#salbatch_id')
      combo = idInput && idInput.closest ? idInput.closest('.textbox.combo') : null
      if (!state.value && idInput && idInput.value != null) state.value = compactText(idInput.value)
    }
    if (combo) {
      var textInputs = Array.prototype.slice.call(combo.querySelectorAll('input.textbox-text,input[type="text"]'))
      for (var i = 0; i < textInputs.length; i++) {
        var input = textInputs[i]
        if (input.classList && input.classList.contains('textbox-value')) continue
        var value = compactText(input.value || input.getAttribute('value') || '')
        if (value) {
          state.text = value
          break
        }
      }
    }
    if (!state.text) {
      var inputs = Array.prototype.slice.call(doc.querySelectorAll('input.textbox-text,input[type="text"]'))
      for (var j = 0; j < inputs.length; j++) {
        var candidate = compactText(inputs[j].value || inputs[j].getAttribute('value') || '')
        if (/\[\d{3}\].*工资/.test(candidate)) {
          state.text = candidate
          break
        }
      }
    }
    return state
  }

  function ensureSalaryBatch001(doc) {
    var batch = getCurrentSalaryBatch(doc)
    var displayText = normalizeText(batch.text || '')
    var valueText = normalizeText(batch.value || '')
    if (displayText) {
      if (displayText.indexOf('[001]工资') >= 0 || displayText.indexOf('001工资') >= 0) return true
    } else if (valueText === '1') {
      return true
    }
    if (!batch.text && !batch.value) {
      throw new Error('无法读取工资批次。请先手动选择 [001]工资 并点击查询后，再执行自动额度匹配。')
    }
    throw new Error(
      '当前工资批次不是 [001]工资，已停止自动匹配。当前批次：' +
        (batch.text || batch.value) +
        '。请先手动选择 [001]工资 并点击查询。'
    )
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

  function clickDialogButton(labels) {
    var docs = getReachableDocs()
    for (var d = 0; d < docs.length; d++) {
      for (var i = 0; i < labels.length; i++) {
        var btn = findButton(docs[d], labels[i])
        if (btn && clickElement(btn)) return true
      }
    }
    return false
  }

  function getCell(row, field) {
    if (!row) return null
    return row.querySelector('[field="' + String(field).replace(/"/g, '\\"') + '"]')
  }

  function getCellText(row, field) {
    var cell = getCell(row, field)
    if (!cell) return ''
    var titleNode = cell.querySelector('[title]')
    return compactText(titleNode ? titleNode.getAttribute('title') : (cell.innerText || cell.textContent || ''))
  }

  function rowIndex(row, fallback) {
    var attr = row && row.getAttribute('datagrid-row-index')
    if (attr !== null && attr !== '') {
      var idx = Number(attr)
      if (Number.isFinite(idx)) return idx
    }
    var id = row && (row.getAttribute('id') || '')
    var match = id && id.match(/-(\d+)$/)
    return match ? Number(match[1]) : fallback
  }

  function visibleRowsWithField(doc, field) {
    return Array.prototype.slice.call(doc.querySelectorAll('tr.datagrid-row, tr[id*="datagrid-row"]'))
      .filter(function (row) {
        return isVisible(row) && !!getCell(row, field)
      })
  }

  function uniqueRows(rows) {
    var seen = {}
    return rows.filter(function (row, i) {
      var key = (row.ownerDocument === document ? 'd0' : 'd') + ':' + (row.getAttribute('id') || rowIndex(row, i))
      if (seen[key]) return false
      seen[key] = true
      return true
    })
  }

  function getItemRows(doc) {
    return uniqueRows(visibleRowsWithField(doc, CONFIG.itemNameField)).filter(function (row) {
      var name = getCellText(row, CONFIG.itemNameField)
      var amount = getItemAmount(row)
      return !!name && amount > 0
    })
  }

  function getItemAmount(row) {
    var unmatchedFields = ['unalready_matc_amonty', 'unmatch_amount']
    for (var u = 0; u < unmatchedFields.length; u++) {
      if (!getCell(row, unmatchedFields[u])) continue
      var unmatched = parseAmountValue(getCellText(row, unmatchedFields[u]))
      if (unmatched != null) return Math.max(0, unmatched)
    }
    for (var i = 0; i < CONFIG.itemAmountFields.length; i++) {
      if (unmatchedFields.indexOf(CONFIG.itemAmountFields[i]) >= 0) continue
      var value = getCellText(row, CONFIG.itemAmountFields[i])
      var amount = parseAmount(value)
      if (amount > 0) return amount
    }
    return 0
  }

  function findItemRow(rows, itemName, amount, itemTypeText) {
    var normalizedName = normalizeText(itemName)
    var normalizedType = normalizeText(itemTypeText || '')
    var exactNameRows = rows.filter(function (row) {
      return normalizeText(getCellText(row, CONFIG.itemNameField)) === normalizedName
    })
    var candidateRows = exactNameRows
    if (normalizedType) {
      var typedRows = exactNameRows.filter(function (row) {
        var rowType = normalizeText(getItemTypeText(row))
        return rowType === normalizedType || rowType.indexOf(normalizedType) >= 0 || normalizedType.indexOf(rowType) >= 0
      })
      if (typedRows.length) candidateRows = typedRows
    }
    for (var i = 0; i < candidateRows.length; i++) {
      if (moneyEquals(getItemAmount(candidateRows[i]), amount)) return candidateRows[i]
    }
    for (var j = 0; j < candidateRows.length; j++) {
      if (getItemAmount(candidateRows[j]) > 0) return candidateRows[j]
    }
    if (normalizedType && exactNameRows.length) return null
    for (var k = 0; k < rows.length; k++) {
      var rowName = normalizeText(getCellText(rows[k], CONFIG.itemNameField))
      if (rowName && (rowName.indexOf(normalizedName) >= 0 || normalizedName.indexOf(rowName) >= 0)) return rows[k]
    }
    return null
  }

  function getItemTypeText(row) {
    return CONFIG.itemTypeFields.map(function (field) { return getCellText(row, field) }).join(' ')
  }

  async function waitForItemAmountToSettle(itemName, itemTypeText, previousAmount, allocationAmount) {
    var deadline = Date.now() + 10000
    var lastPage = null
    while (Date.now() < deadline) {
      var page = await waitForItemRows(2000)
      if (page) {
        lastPage = page
        var row = findItemRow(page.rows, itemName, roundMoney(previousAmount - allocationAmount), itemTypeText) ||
          findItemRow(page.rows, itemName, previousAmount, itemTypeText)
        if (!row) return page
        var currentAmount = getItemAmount(row)
        if (!moneyEquals(currentAmount, previousAmount)) return page
      }
      await sleep(500)
    }
    return lastPage || waitForItemRows(8000)
  }

  function isRetiredItem(row) {
    return normalizeText(getItemTypeText(row)).indexOf('退休') >= 0
  }

  function isRetiredFeeItem(itemName, row) {
    return isRetiredItem(row) && normalizeText(itemName).indexOf('退休费') >= 0
  }

  function isCareerItem(row) {
    var text = normalizeText(getItemTypeText(row))
    return text.indexOf('事业') >= 0 && text.indexOf('退休') < 0 && text.indexOf('离休') < 0
  }

  function isHousingItem(itemName) {
    var text = normalizeText(itemName)
    return text.indexOf('住房补贴') >= 0 || text.indexOf('提租补贴') >= 0 || text.indexOf('住房提租') >= 0
  }

  function isCareerHousingItem(itemName, row) {
    return isCareerItem(row) && isHousingItem(itemName)
  }

  function isRetiredHousingItem(itemName, row) {
    return isRetiredItem(row) && isHousingItem(itemName)
  }

  function isAllowanceItem(itemName) {
    var text = normalizeText(itemName)
    return text.indexOf('津贴补贴') >= 0 || text.indexOf('津补贴') >= 0
  }

  function isCareerAllowanceItem(itemName, row) {
    return isCareerItem(row) && isAllowanceItem(itemName)
  }

  function isBasicSalaryItem(itemName) {
    return normalizeText(itemName).indexOf('基本工资') >= 0
  }

  function isCareerBasicSalaryItem(itemName, row) {
    return isCareerItem(row) && isBasicSalaryItem(itemName)
  }

  function getQuotaRows(doc) {
    var rows = []
    for (var i = 0; i < CONFIG.quotaTextFields.length; i++) {
      rows = rows.concat(visibleRowsWithField(doc, CONFIG.quotaTextFields[i]))
    }
    return uniqueRows(rows).filter(function (row) {
      return !getCell(row, CONFIG.itemNameField) && !!getCell(row, CONFIG.quotaAmountField)
    })
  }

  function quotaText(row) {
    return CONFIG.quotaTextFields.map(function (field) { return getCellText(row, field) }).join(' ')
  }

  function quotaSnapshot(row) {
    return normalizeText(quotaText(row))
  }

  function quotaAvailable(row) {
    var hasReadableAmount = false
    for (var i = 0; i < CONFIG.quotaAvailableFields.length; i++) {
      var cell = getCell(row, CONFIG.quotaAvailableFields[i])
      if (!cell) continue
      var amount = parseAmountValue(getCellText(row, CONFIG.quotaAvailableFields[i]))
      if (amount == null) continue
      hasReadableAmount = true
      if (amount > 0) return amount
    }
    return hasReadableAmount ? 0 : -1
  }

  function scoreQuota(rule, row, amount) {
    var text = normalizeText(quotaText(row))
    var score = 0
    if (!rule) return 0
    if (rule.require) {
      for (var r = 0; r < rule.require.length; r++) {
        if (text.indexOf(normalizeText(rule.require[r])) < 0) {
          return rule.strict ? Number.NEGATIVE_INFINITY : 0
        }
      }
      score += 100
    }
    if (rule.avoid) {
      for (var a = 0; a < rule.avoid.length; a++) {
        if (text.indexOf(normalizeText(rule.avoid[a])) >= 0) score -= 5
      }
    }
    for (var i = 0; i < rule.prefer.length; i++) {
      if (text.indexOf(normalizeText(rule.prefer[i])) >= 0) score += 3
    }
    if (quotaAvailable(row) >= amount) score += 2
    return score
  }

  function pickQuotaByRequirement(rows, amount, require, prefer, avoid, reject) {
    var rule = {
      require: require,
      prefer: prefer || require,
      avoid: avoid || [],
      strict: true
    }
    var best = null
    var bestScore = Number.NEGATIVE_INFINITY
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var text = normalizeText(quotaText(row))
      var rejected = false
      if (reject) {
        for (var x = 0; x < reject.length; x++) {
          if (text.indexOf(normalizeText(reject[x])) >= 0) {
            rejected = true
            break
          }
        }
      }
      if (rejected) continue
      if (quotaAvailable(row) < amount) continue
      var score = scoreQuota(rule, row, amount)
      if (score === Number.NEGATIVE_INFINITY) continue
      if (score > bestScore) {
        best = row
        bestScore = score
      }
    }
    if (!best || quotaAvailable(best) < amount) return null
    return best
  }

  function pick30301With30107Fallback(rows, amount, options) {
    var primary = pickQuotaByRequirement(
      rows,
      amount,
      options.primaryRequire || ['30301'],
      options.primaryPrefer || ['30301', '基本工资'],
      options.primaryAvoid || ['30302', '退休费', '30305', '生活补助', '生活补贴'],
      options.primaryReject
    )
    if (primary) return { row: primary, label: options.primaryLabel || '30301 基本工资' }

    var fallback = pickQuotaByRequirement(
      rows,
      amount,
      options.fallbackRequire || ['30107'],
      options.fallbackPrefer || ['30107', '绩效工资'],
      options.fallbackAvoid || ['30302', '退休费', '30305', '生活补助', '生活补贴'],
      options.fallbackReject
    )
    if (fallback) return { row: fallback, label: options.fallbackLabel || '30107 绩效工资' }
    return null
  }

  function pickPersonnelExpenseFallback(rows, amount, options) {
    options = options || {}
    var best = null
    var bestScore = Number.NEGATIVE_INFINITY
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var text = normalizeText(quotaText(row))
      var matchedCode = ''
      for (var c = 0; c < PERSONNEL_EXPENSE_CODES.length; c++) {
        if (text.indexOf(PERSONNEL_EXPENSE_CODES[c]) >= 0) {
          matchedCode = PERSONNEL_EXPENSE_CODES[c]
          break
        }
      }
      if (!matchedCode) continue
      if (options.reject) {
        var rejected = false
        for (var r = 0; r < options.reject.length; r++) {
          if (text.indexOf(normalizeText(options.reject[r])) >= 0) {
            rejected = true
            break
          }
        }
        if (rejected) continue
      }
      if (quotaAvailable(row) < amount) continue
      var score = 100
      if (options.prefer) {
        for (var p = 0; p < options.prefer.length; p++) {
          if (text.indexOf(normalizeText(options.prefer[p])) >= 0) score += 5
        }
      }
      if (options.avoid) {
        for (var a = 0; a < options.avoid.length; a++) {
          if (text.indexOf(normalizeText(options.avoid[a])) >= 0) score -= 3
        }
      }
      var orderIndex = PERSONNEL_EXPENSE_CODES.indexOf(matchedCode)
      if (orderIndex >= 0) score += PERSONNEL_EXPENSE_CODES.length - orderIndex
      if (score > bestScore) {
        best = { row: row, label: matchedCode + ' 人员经费兜底' }
        bestScore = score
      }
    }
    return best
  }

  function pickCareerSalary30302Quota(rows, amount) {
    var best = null
    var bestScore = Number.NEGATIVE_INFINITY
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var text = normalizeText(quotaText(row))
      if (text.indexOf('30302') < 0) continue
      if (text.indexOf('事业工资') < 0 && text.indexOf('事业人员工资') < 0) continue
      if (
        text.indexOf('事业人员提租补贴') >= 0 ||
        text.indexOf('提租补贴') >= 0 ||
        text.indexOf('住房补贴') >= 0 ||
        text.indexOf('退休费') >= 0 ||
        text.indexOf('30305') >= 0 ||
        text.indexOf('生活补助') >= 0 ||
        text.indexOf('生活补贴') >= 0
      ) {
        continue
      }
      if (quotaAvailable(row) < amount) continue

      var score = 100
      if (text.indexOf('事业人员工资') >= 0) score += 30
      if (text.indexOf('事业工资') >= 0) score += 20
      if (text.indexOf('30302') >= 0) score += 10
      if (score > bestScore) {
        best = row
        bestScore = score
      }
    }
    return best
  }

  function mergeAllocations(allocations) {
    var merged = []
    for (var i = 0; i < allocations.length; i++) {
      var item = allocations[i]
      var found = null
      for (var j = 0; j < merged.length; j++) {
        if (merged[j].row === item.row) {
          found = merged[j]
          break
        }
      }
      if (found) {
        found.amount = roundMoney(found.amount + item.amount)
        if (found.label.indexOf(item.label) < 0) found.label += ' + ' + item.label
      } else {
        merged.push({ row: item.row, amount: item.amount, label: item.label, quotaText: item.quotaText || quotaSnapshot(item.row) })
      }
    }
    return merged
  }

  function findQuotaForAllocation(rows, allocation) {
    var wantedText = normalizeText(allocation.quotaText || quotaSnapshot(allocation.row))
    var label = normalizeText(allocation.label || '')
    var codes = label.match(/[0-9]{5}/g) || []
    var labelText = label.replace(/[0-9]{5}/g, '').replace(/（.*?）/g, '').replace(/[+()（）]/g, '')
    var best = null
    var bestScore = Number.NEGATIVE_INFINITY
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var text = quotaSnapshot(row)
      var available = quotaAvailable(row)
      if (available >= 0 && available + 0.01 < allocation.amount) continue
      var score = 0
      if (wantedText && text === wantedText) score += 100
      for (var c = 0; c < codes.length; c++) {
        if (text.indexOf(codes[c]) >= 0) score += 20
      }
      if (labelText && text.indexOf(labelText) >= 0) score += 12
      if (available >= allocation.amount) score += 5
      if (score > bestScore) {
        best = row
        bestScore = score
      }
    }
    return bestScore > 0 ? best : null
  }

  function buildRetiredFeeAllocations(itemName, itemRow, amount, rows) {
    var localSummary = getLocalSummary()
    if (!localSummary || !localSummary.ok) {
      return {
        ok: false,
        reason: '本地工资数据读取失败，无法拆分“事业退休/退休费实发”：' + ((localSummary && localSummary.message) || '')
      }
    }

    var retiredBackpay = roundMoney(localSummary.retiredBackpayTotal)
    var otherActual = roundMoney(localSummary.otherActualPayTotal)
    if (retiredBackpay < 0) retiredBackpay = 0
    if (otherActual < 0) otherActual = 0
    var expectedAmount = roundMoney(retiredBackpay + otherActual)
    if (!moneyEquals(expectedAmount, amount)) {
      return {
        ok: false,
        reason: amountMismatchReason('事业退休/退休费实发', expectedAmount, amount)
      }
    }

    var otherAmount = otherActual
    var retiredFeeAmount = retiredBackpay
    var allocations = []

    if (retiredFeeAmount > 0) {
      var retiredQuota = pickQuotaByRequirement(
        rows,
        retiredFeeAmount,
        ['30302', '退休费'],
        ['30302', '退休费'],
        ['30305', '生活补助', '生活补贴', '50901', '30301', '基本工资', '30102', '津贴补贴']
      )
      if (!retiredQuota) {
        return {
          ok: false,
          reason: '30302 退休费余额不足、未找到或余额读取失败，不能混用其他条目。金额：' + formatAmount(retiredFeeAmount)
        }
      }
      allocations.push({ row: retiredQuota, amount: retiredFeeAmount, label: '30302 退休费' })
    }

    if (otherAmount > 0) {
      var livingQuota = pickQuotaByRequirement(
        rows,
        otherAmount,
        ['30305'],
        ['30305', '生活补助', '生活补贴'],
        ['30302', '退休费']
      )
      var fallbackQuota = null
      if (!livingQuota) {
        fallbackQuota = pickPersonnelExpenseFallback(
          rows,
          otherAmount,
          {
            prefer: ['30101', '30107', '30102'],
            reject: ['30302', '退休费', '30305', '生活补助', '生活补贴']
          }
        )
      }
      var otherQuota = livingQuota ? { row: livingQuota, label: '30305 生活补助' } : fallbackQuota
      if (!otherQuota) {
        return {
          ok: false,
          reason:
            '其他工资实发合计无法匹配：30305 余额不足/未找到/余额读取失败，人员经费兜底范围也不足或不可用。金额：' +
            formatAmount(otherAmount)
        }
      }
      allocations.push({
        row: otherQuota.row,
        amount: otherAmount,
        label: otherQuota.label
      })
    }

    return { ok: true, allocations: allocations }
  }

  function buildRetiredHousingAllocations(itemName, itemRow, amount, rows) {
    var localSummary = getLocalSummary()
    if (!localSummary || !localSummary.ok) {
      return {
        ok: false,
        reason: '本地工资数据读取失败，无法校验“事业退休/住房补贴”：' + ((localSummary && localSummary.message) || '')
      }
    }
    var localAmount = roundMoney(localSummary.retiredHousingTotal)
    if (!moneyEquals(localAmount, amount)) {
      return { ok: false, reason: amountMismatchReason('事业退休/住房补贴', localAmount, amount) }
    }
    var retiredQuota = pickQuotaByRequirement(
      rows,
      amount,
      ['30302', '退休费'],
      ['30302', '退休费'],
      ['30305', '生活补助', '生活补贴', '50901', '30301', '基本工资', '30102', '津贴补贴']
    )
    if (!retiredQuota) {
      return {
        ok: false,
        reason: '退休住房补贴无法匹配：30302 退休费余额不足、未找到或余额读取失败，不能混用其他条目。金额：' + formatAmount(amount)
      }
    }
    return {
      ok: true,
      allocations: [{ row: retiredQuota, amount: amount, label: '30302 退休费' }]
    }
  }

  function buildCareerHousingAllocations(itemName, itemRow, amount, rows) {
    var localSummary = getLocalSummary()
    if (!localSummary || !localSummary.ok) {
      return {
        ok: false,
        reason: '本地工资数据读取失败，无法校验“事业/住房补贴”：' + ((localSummary && localSummary.message) || '')
      }
    }
    var localAmount = roundMoney(localSummary.activeHousingTotal)
    if (!moneyEquals(localAmount, amount)) {
      return { ok: false, reason: amountMismatchReason('事业/住房补贴', localAmount, amount) }
    }
    var housingQuota = pickQuotaByRequirement(
      rows,
      amount,
      ['30102', '事业人员提租补贴'],
      ['30102', '事业人员提租补贴', '住房补贴', '提租'],
      ['退休费', '30305', '生活补助', '生活补贴']
    )
    if (housingQuota) {
      return {
        ok: true,
        allocations: [{ row: housingQuota, amount: amount, label: '30102 事业人员提租补贴' }]
      }
    }

    var basicQuota = pickPersonnelExpenseFallback(
      rows,
      amount,
      {
        prefer: ['30102', '30101', '30107'],
        reject: ['30302', '退休费', '30305', '生活补助', '生活补贴']
      }
    )
    if (basicQuota) {
      return {
        ok: true,
        allocations: [{ row: basicQuota.row, amount: amount, label: basicQuota.label }]
      }
    }

    return {
      ok: false,
      reason:
        '事业住房补贴无法匹配：30102 事业人员提租补贴余额不足/未找到/余额读取失败，人员经费兜底范围也不足或不可用。金额：' +
        formatAmount(amount)
    }
  }

  function buildCareerAllowanceAllocations(itemName, itemRow, amount, rows) {
    var localSummary = getLocalSummary()
    if (!localSummary || !localSummary.ok) {
      return {
        ok: false,
        reason: '本地工资数据读取失败，无法校验“事业/津贴补贴实发”：' + ((localSummary && localSummary.message) || '')
      }
    }
    var localAmount = roundMoney(localSummary.activeAllowanceTotal)
    if (!moneyEquals(localAmount, amount)) {
      return { ok: false, reason: amountMismatchReason('事业/津贴补贴实发', localAmount, amount) }
    }
    var allowanceQuota = pickQuotaByRequirement(
      rows,
      amount,
      ['30102', '事业人员工资'],
      ['30102', '事业人员工资', '津贴补贴'],
      ['事业人员提租补贴', '退休费', '30305', '生活补助', '生活补贴']
    )
    if (allowanceQuota) {
      return {
        ok: true,
        allocations: [{ row: allowanceQuota, amount: amount, label: '30102 事业人员工资' }]
      }
    }

    var basicQuota = pickPersonnelExpenseFallback(
      rows,
      amount,
      {
        prefer: ['30102', '30101', '30107'],
        reject: ['事业人员提租补贴', '退休费', '30305', '生活补助', '生活补贴']
      }
    )
    if (basicQuota) {
      return {
        ok: true,
        allocations: [{ row: basicQuota.row, amount: amount, label: basicQuota.label }]
      }
    }

    return {
      ok: false,
      reason:
        '事业津贴补贴无法匹配：30102 事业人员工资余额不足/未找到/余额读取失败，人员经费兜底范围也不足或不可用。金额：' +
        formatAmount(amount)
    }
  }

  function buildCareerBasicSalaryWholeAllocations(itemName, itemRow, amount, rows) {
    var basicQuota = pick30301With30107Fallback(
      rows,
      amount,
      {
        primaryRequire: ['30301'],
        primaryPrefer: ['30301', '基本工资'],
        primaryAvoid: ['30107', '绩效工资', '30302', '退休费', '30305', '生活补助'],
        primaryReject: ['乡镇', '基础性绩效'],
        primaryLabel: '30301 基本工资',
        fallbackRequire: ['30107'],
        fallbackPrefer: ['30107', '绩效工资'],
        fallbackAvoid: ['30302', '退休费', '30305', '生活补助'],
        fallbackLabel: '30107 绩效工资'
      }
    )
    if (basicQuota) {
      return {
        ok: true,
        allocations: [{ row: basicQuota.row, amount: amount, label: basicQuota.label }]
      }
    }

    var careerSalaryQuota = pickCareerSalary30302Quota(rows, amount)
    if (careerSalaryQuota) {
      return {
        ok: true,
        allocations: [{ row: careerSalaryQuota, amount: amount, label: '30302 事业人员工资' }]
      }
    }

    return {
      ok: false,
      reason:
        '整项匹配也失败：30301 基本工资/30107 绩效工资/30302 事业人员工资余额不足、未找到或余额读取失败。金额：' +
        formatAmount(amount)
    }
  }

  function buildCareerBasicSalaryAllocations(itemName, itemRow, amount, rows) {
    var localSummary = getLocalSummary()
    if (!localSummary || !localSummary.ok) {
      return {
        ok: false,
        reason:
          '本地工资数据读取失败，无法拆分“事业/基本工资实发”，已停止自动匹配' +
          ((localSummary && localSummary.message) ? '。本地读取提示：' + localSummary.message : '')
      }
    }

    var otherOneAmount = roundMoney(localSummary.activeOtherOneTotal)
    var performanceAmount = roundMoney(localSummary.activeBasicPerformanceTotal)
    if (otherOneAmount < 0) otherOneAmount = 0
    if (performanceAmount < 0) performanceAmount = 0
    var remainingAmount = roundMoney(amount - performanceAmount - otherOneAmount)
    if (remainingAmount < -0.01) {
      return {
        ok: false,
        reason:
          '事业基本工资拆分金额大于当前“基本工资实发”，停止匹配。当前：' +
          formatAmount(amount) +
          '，岗位津贴+生活补贴：' +
          formatAmount(performanceAmount) +
          '，其他一：' +
          formatAmount(otherOneAmount)
      }
    }
    if (remainingAmount < 0) remainingAmount = 0
    var splitTotal = roundMoney(performanceAmount + otherOneAmount + remainingAmount)
    if (!moneyEquals(splitTotal, amount)) {
      return {
        ok: false,
        reason:
          '事业基本工资拆分合计不等于网页“基本工资实发”未匹配金额，已停止自动匹配。网页金额：' +
          formatAmount(amount) +
          '，岗位津贴+生活补贴：' +
          formatAmount(performanceAmount) +
          '，其他一：' +
          formatAmount(otherOneAmount) +
          '，剩余：' +
          formatAmount(remainingAmount) +
          '，拆分合计：' +
          formatAmount(splitTotal)
      }
    }

    var allocations = []

    if (performanceAmount > 0) {
      var performanceQuota = pickQuotaByRequirement(
        rows,
        performanceAmount,
        ['30107', '绩效'],
        ['30107', '绩效工资', '基础性绩效', '基础性绩效工资'],
        ['30301', '30302', '退休费', '30305', '生活补助'],
        ['乡镇']
      )
      if (!performanceQuota) {
        var performanceFallback = pickPersonnelExpenseFallback(
          rows,
          performanceAmount,
          {
            prefer: ['30107', '30101', '30102'],
            reject: ['30302', '退休费', '30305', '生活补助', '生活补贴']
          }
        )
        performanceQuota = performanceFallback && performanceFallback.row
      }
      if (!performanceQuota) {
        return {
          ok: false,
          reason:
            '事业基本工资中的岗位津贴+生活补贴无法匹配：30107 绩效工资余额不足、未找到或余额读取失败，人员经费兜底范围也不足或不可用。金额：' +
            formatAmount(performanceAmount)
        }
      }
      allocations.push({ row: performanceQuota, amount: performanceAmount, label: '30107 绩效工资（岗位津贴+生活补贴）' })
    }

    if (otherOneAmount > 0) {
      var otherOneQuota = pickPersonnelExpenseFallback(
        rows,
        otherOneAmount,
        {
          prefer: ['30101', '30107', '30102'],
          reject: ['30302', '退休费', '30305', '生活补助', '生活补贴']
        }
      )
      if (!otherOneQuota) {
        return {
          ok: false,
          reason:
            '事业基本工资中的其他一无法匹配：人员经费兜底范围余额不足、未找到或余额读取失败。金额：' +
            formatAmount(otherOneAmount)
        }
      }
      allocations.push({ row: otherOneQuota.row, amount: otherOneAmount, label: otherOneQuota.label + '（其他一）' })
    }

    if (remainingAmount > 0) {
      var basicQuota = pick30301With30107Fallback(
        rows,
        remainingAmount,
        {
          primaryRequire: ['30301'],
          primaryPrefer: ['30301', '基本工资'],
          primaryAvoid: ['30107', '绩效工资', '30302', '退休费', '30305', '生活补助'],
          primaryReject: ['乡镇', '基础性绩效'],
          primaryLabel: '30301 基本工资',
          fallbackRequire: ['30107'],
          fallbackPrefer: ['30107', '绩效工资'],
          fallbackAvoid: ['30302', '退休费', '30305', '生活补助'],
          fallbackLabel: '30107 绩效工资'
        }
      )
      if (!basicQuota) {
        var remainingFallback = pickPersonnelExpenseFallback(
          rows,
          remainingAmount,
          {
            prefer: ['30101', '30107', '30102'],
            reject: ['30302', '退休费', '30305', '生活补助', '生活补贴']
          }
        )
        if (remainingFallback) basicQuota = remainingFallback
      }
      if (!basicQuota) {
        return {
          ok: false,
          reason:
            '事业基本工资剩余金额无法匹配：30301 基本工资余额不足/未找到/余额读取失败，人员经费兜底范围也不足或不可用。金额：' +
            formatAmount(remainingAmount)
        }
      }
      allocations.push({ row: basicQuota.row, amount: remainingAmount, label: basicQuota.label })
    }

    return { ok: true, allocations: allocations }
  }

  function buildAllocations(itemName, itemRow, amount, rows) {
    if (isRetiredFeeItem(itemName, itemRow)) {
      return buildRetiredFeeAllocations(itemName, itemRow, amount, rows)
    }
    if (isRetiredHousingItem(itemName, itemRow)) {
      return buildRetiredHousingAllocations(itemName, itemRow, amount, rows)
    }
    if (isCareerBasicSalaryItem(itemName, itemRow)) {
      return buildCareerBasicSalaryAllocations(itemName, itemRow, amount, rows)
    }
    if (isCareerHousingItem(itemName, itemRow)) {
      return buildCareerHousingAllocations(itemName, itemRow, amount, rows)
    }
    if (isCareerAllowanceItem(itemName, itemRow)) {
      return buildCareerAllowanceAllocations(itemName, itemRow, amount, rows)
    }
    return {
      ok: false,
      reason:
        '此工资项没有配置明确额度匹配规则，已停止，避免误匹配：' +
        itemName +
        '，金额：' +
        formatAmount(amount)
    }
  }

  async function waitForSalaryPage(maxWait) {
    var start = Date.now()
    while (Date.now() - start < (maxWait || CONFIG.maxWaitTime)) {
      var docs = getReachableDocs()
      for (var i = 0; i < docs.length; i++) {
        if (isSalaryPaymentPage(docs[i]) && (findSalaryActionAnchor(docs[i]) || getItemRows(docs[i]).length)) {
          return docs[i]
        }
      }
      await sleep(400)
    }
    return null
  }

  async function waitForItemRows(maxWait) {
    var start = Date.now()
    while (Date.now() - start < (maxWait || CONFIG.maxWaitTime)) {
      clickDialogButton(['确定', '确认', '是', 'OK'])
      var docs = getReachableDocs()
      for (var i = 0; i < docs.length; i++) {
        var rows = getItemRows(docs[i])
        if (rows.length) return { doc: docs[i], rows: rows }
      }
      await sleep(450)
    }
    return null
  }

  async function waitForQuotaRows(doc, maxWait) {
    var start = Date.now()
    while (Date.now() - start < (maxWait || CONFIG.maxWaitTime)) {
      var rows = getQuotaRows(doc)
      if (rows.length) return rows
      await sleep(350)
    }
    return []
  }

  function getJq(doc) {
    try {
      return (doc.defaultView && (doc.defaultView.jQuery || doc.defaultView.$)) || window.jQuery || window.$ || null
    } catch (error) {
      return null
    }
  }

  function selectDatagridRow(row, field) {
    if (!row) return false
    var doc = row.ownerDocument
    var jq = doc ? getJq(doc) : null
    var index = rowIndex(row, 0)
    var selected = false
    try {
      clickElement(row)
      selected = true
    } catch (error) {}
    if (!doc || !jq) return selected
    var candidates = Array.prototype.slice.call(doc.querySelectorAll('table[id],div[id]'))
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i]
      try {
        if (!jq(el).data('datagrid')) continue
        var fields = []
        try {
          fields = fields.concat(jq(el).datagrid('getColumnFields') || [])
          fields = fields.concat(jq(el).datagrid('getColumnFields', true) || [])
        } catch (error) {}
        if (field && fields.length && fields.indexOf(field) < 0) continue
        var rows = jq(el).datagrid('getRows') || []
        if (!rows[index]) continue
        try {
          jq(el).datagrid('scrollTo', index)
        } catch (error) {}
        jq(el).datagrid('selectRow', index)
        selected = true
      } catch (error) {}
    }
    return selected
  }

  async function selectSalaryItemRow(row) {
    if (!selectDatagridRow(row, CONFIG.itemNameField)) return false
    await sleep(CONFIG.rowSettleWait)
    return true
  }

  async function selectQuotaRow(row) {
    if (!selectDatagridRow(row, CONFIG.quotaAmountField)) return false
    await sleep(250)
    return true
  }

  function findDatagridEditor(row, field) {
    var doc = row && row.ownerDocument
    var jq = doc ? getJq(doc) : null
    if (!doc || !jq) return null
    var index = rowIndex(row, 0)
    var candidates = Array.prototype.slice.call(doc.querySelectorAll('table[id],div[id]'))
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i]
      try {
        if (!jq(el).data('datagrid')) continue
        var fields = []
        try {
          fields = fields.concat(jq(el).datagrid('getColumnFields') || [])
          fields = fields.concat(jq(el).datagrid('getColumnFields', true) || [])
        } catch (error) {}
        if (fields.length && fields.indexOf(field) < 0) continue
        var rows = jq(el).datagrid('getRows') || []
        if (!rows[index]) continue
        var editor = jq(el).datagrid('getEditor', { index: index, field: field })
        if (!editor) {
          try {
            jq(el).datagrid('selectRow', index)
            jq(el).datagrid('beginEdit', index)
            editor = jq(el).datagrid('getEditor', { index: index, field: field })
          } catch (error) {}
        }
        if (editor && editor.target) {
          return { grid: el, editor: editor, index: index, rows: rows, jq: jq }
        }
      } catch (error) {}
    }
    return null
  }

  function setEditorValue(editorInfo, value) {
    var jq = editorInfo && editorInfo.jq
    var target = editorInfo && editorInfo.editor && editorInfo.editor.target
    if (!jq || !target) return false
    var textValue = String(value)
    var ok = false
    try {
      jq(target).numberbox('setValue', textValue)
      ok = true
    } catch (error) {}
    try {
      jq(target).textbox('setValue', textValue)
      ok = true
    } catch (error) {}
    try {
      jq(target).val(textValue).trigger('input').trigger('change')
      ok = true
    } catch (error) {}
    try {
      var wrapper = jq(target).closest('.textbox')
      wrapper.find('input.textbox-text,input.textbox-value,input[type="text"],input[type="hidden"]').each(function () {
        this.value = textValue
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
      })
      ok = true
    } catch (error) {}
    try {
      if (editorInfo.rows && editorInfo.rows[editorInfo.index]) {
        editorInfo.rows[editorInfo.index][CONFIG.quotaAmountField] = value
      }
    } catch (error) {}
    return ok
  }

  function currentEditorValue(editorInfo) {
    var jq = editorInfo && editorInfo.jq
    var target = editorInfo && editorInfo.editor && editorInfo.editor.target
    if (!jq || !target) return ''
    try {
      var numberValue = jq(target).numberbox('getValue')
      if (numberValue !== undefined && numberValue !== null && numberValue !== '') return String(numberValue)
    } catch (error) {}
    try {
      var textboxValue = jq(target).textbox('getValue')
      if (textboxValue !== undefined && textboxValue !== null && textboxValue !== '') return String(textboxValue)
    } catch (error) {}
    try {
      var val = jq(target).val()
      if (val !== undefined && val !== null && val !== '') return String(val)
    } catch (error) {}
    return ''
  }

  async function enterAmount(row, amount) {
    var cell = getCell(row, CONFIG.quotaAmountField)
    if (!cell) return false
    clickElement(cell)
    try {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
    } catch (error) {}
    await sleep(250)
    var doc = row.ownerDocument
    var editorInfo = findDatagridEditor(row, CONFIG.quotaAmountField)
    if (editorInfo && setEditorValue(editorInfo, amount)) {
      await sleep(150)
      var actual = parseAmount(currentEditorValue(editorInfo))
      if (Math.abs(actual - amount) <= 0.01) return true
      status(
        '已尝试写入额度编辑器，但读回金额不一致。目标：' +
          formatAmount(amount) +
          '，读回：' +
          (currentEditorValue(editorInfo) || '空'),
        'warn'
      )
    }

    var inputs = Array.prototype.slice.call(
      cell.querySelectorAll('input.textbox-text, input[type="text"], textarea')
    ).concat(
      Array.prototype.slice.call(doc.querySelectorAll('.datagrid-editable input.textbox-text, .datagrid-editable input[type="text"], .datagrid-editable textarea'))
    ).concat(
      Array.prototype.slice.call(doc.querySelectorAll('input.textbox-text, input[type="text"], textarea'))
    ).filter(isVisible)
    var input = inputs[0] || doc.activeElement
    if (!input || !('value' in input)) return false
    input.focus()
    input.value = String(amount)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
    } catch (error) {}
    try {
      input.blur()
    } catch (error) {}
    await sleep(150)
    return true
  }

  async function clickModify(doc) {
    var btn = findButton(doc, '修改') || findButtonAcross('修改', doc)
    if (!btn) return false
    clickElement(btn)
    await sleep(450)
    return true
  }

  async function clickSave(doc) {
    var btn = findButton(doc, '保存') || findButtonAcross('保存', doc)
    if (!btn) {
      status('保存前没有找到“保存”按钮。当前可见按钮：' + (visibleButtonTexts(doc) || '未读取到'), 'err')
      return false
    }
    status('已找到“保存”按钮，正在保存...')
    clickElement(btn)
    var start = Date.now()
    var noConfirmDeadline = start + 4000
    var maxWait = Math.min(CONFIG.saveWaitTime, 12000)
    while (Date.now() - start < maxWait) {
      if (clickDialogButton(['确定', '确认', '是', 'OK'])) {
        status('已确认保存，等待一体化页面写入...')
        await sleep(1200)
        return true
      }
      if (Date.now() >= noConfirmDeadline) {
        status('已点击“保存”，未出现确认弹窗，正在重新读取页面...')
        await sleep(1200)
        return true
      }
      await sleep(350)
    }
    status('已点击“保存”，等待超时前未发现确认弹窗，继续重新读取页面...', 'warn')
    await sleep(1200)
    return true
  }

  async function createPayment(doc) {
    if (!CONFIG.autoCreatePayment) return true
    var btn = findButton(doc, '生成支付') || findButtonAcross('生成支付', doc)
    if (!btn) return true
    status('额度已处理，准备生成支付申请...')
    clickElement(btn)
    await sleep(1200)
    clickDialogButton(['确定', '确认', '是', 'OK'])
    await sleep(900)
    var savePay = findButton(doc, '生成支付申请') || findButtonAcross('生成支付申请', doc)
    if (savePay) {
      clickElement(savePay)
      await sleep(900)
      clickDialogButton(['确定', '确认', '是', 'OK'])
    }
    return true
  }

  async function start() {
    if (running) return { ok: false, message: '额度匹配正在运行' }
    running = true
    try {
      var page = await waitForSalaryPage()
      if (!page) return { ok: false, code: 'not-page', message: '请先进入“工资发放/生成支付”的额度匹配页面' }
      ensureSalaryBatch001(page)

      var createBtn = findButton(page, '额度匹配')
      if (createBtn) {
        status('已找到“额度匹配”，开始生成发放明细...')
        clickElement(createBtn)
        await sleep(1200)
        clickDialogButton(['确定', '确认', '是', 'OK'])
      }

      var itemPage = await waitForItemRows()
      if (!itemPage) throw new Error('没有找到可匹配的工资项目明细')

      // 前置总额校验：网页 001 批次工资项总额 必须 = 实发合计 − 002交通费，否则停止。
      var preflight = checkTotalBeforeMatch(itemPage.rows)
      if (!preflight.ok) {
        status(preflight.message, 'err')
        return { ok: false, code: 'total-mismatch', message: preflight.message }
      }

      var matched = 0
      var skipped = []
      var processed = {}
      var guard = 0
      var lastDoc = itemPage.doc
      while (guard < 80) {
        guard += 1
        itemPage = await waitForItemRows(8000)
        if (!itemPage || !itemPage.rows.length) break
        lastDoc = itemPage.doc
        // 停止条件：只挑"未匹配金额(>0)且未处理过"的工资项；当所有工资项未匹配金额都为 0 时
        // candidates 为空 → 结束（即"工资单所有未匹配金额全部为0就停止匹配"）。
        var candidates = itemPage.rows.filter(function (candidate, idx) {
          var candidateName = getCellText(candidate, CONFIG.itemNameField)
          var candidateAmount = getItemAmount(candidate)
          var key = candidateName + '|' + candidateAmount + '|' + rowIndex(candidate, idx)
          return candidateAmount > 0 && !processed[key]
        })
        if (!candidates.length) break
        var row = candidates[0]
        var itemName = getCellText(row, CONFIG.itemNameField)
        var itemTypeText = getItemTypeText(row)
        var amount = getItemAmount(row)
        if (!itemName) break
        var rowKey = itemName + '|' + amount + '|' + rowIndex(row, 0)

        status('处理：' + itemName + '\n金额：' + formatAmount(amount))
        if (!(await selectSalaryItemRow(row))) {
          throw new Error('无法选中工资单数据：' + itemName)
        }
        var quotas = await waitForQuotaRows(itemPage.doc)
        status('处理：' + itemName + '\n工资项金额：' + formatAmount(amount) + '\n读取到额度行：' + quotas.length + ' 行')
        var plan = buildAllocations(itemName, row, amount, quotas)
        if (!plan.ok) {
          skipped.push(itemName + ' ' + formatAmount(amount) + '：' + plan.reason)
          status(plan.reason, 'warn')
          break
        }
        plan.allocations = mergeAllocations(plan.allocations)
        status(
          '准备填写额度：' +
            itemName +
            '\n' +
            plan.allocations.map(function (item) {
              return item.label + '：' + formatAmount(item.amount)
            }).join('\n')
        )
        for (var a = 0; a < plan.allocations.length; a++) {
          var allocation = plan.allocations[a]
          itemPage = await waitForItemRows(8000)
          if (!itemPage || !itemPage.rows.length) {
            throw new Error('保存后没有重新找到工资单数据列表：' + itemName)
          }
          row = findItemRow(itemPage.rows, itemName, amount, itemTypeText)
          if (!row) {
            throw new Error('保存后没有重新找到工资单数据：' + itemName)
          }
          var beforeSaveAmount = getItemAmount(row)
          status(
            '逐条处理：' +
              itemName +
              '\n工资项金额：' +
              formatAmount(amount) +
              '\n当前指标：' +
              allocation.label +
              '\n调整金额：' +
              formatAmount(allocation.amount)
          )
          if (!(await selectSalaryItemRow(row))) {
            throw new Error('无法选中工资单数据：' + itemName)
          }
          quotas = await waitForQuotaRows(itemPage.doc, 8000)
          var quotaRow = findQuotaForAllocation(quotas, allocation)
          if (!quotaRow) {
            throw new Error('保存后没有重新找到可挂接指标：' + itemName + ' / ' + allocation.label)
          }
          allocation.row = quotaRow
          if (!(await selectQuotaRow(quotaRow))) {
            throw new Error('无法选中可挂接指标：' + itemName + ' / ' + allocation.label)
          }
          if (!(await clickModify(itemPage.doc))) {
            throw new Error('没有找到“修改”按钮：' + itemName + ' / ' + allocation.label + '。当前可见按钮：' + (visibleButtonTexts(itemPage.doc) || '未读取到'))
          }
          if (!(await enterAmount(quotaRow, allocation.amount))) {
            throw new Error('无法填写挂接金额：' + itemName + ' / ' + allocation.label)
          }
          await sleep(350)
          if (!(await clickSave(itemPage.doc))) throw new Error('保存失败：' + itemName + ' / ' + allocation.label)
          await waitForItemAmountToSettle(itemName, itemTypeText, beforeSaveAmount, allocation.amount)
          await sleep(500)
        }
        matched += 1
        processed[rowKey] = true
        status('已完成第 ' + matched + ' 项：' + itemName + '，正在检查是否还有未匹配工资项...', 'ok')
        await sleep(1200)
      }

      if (skipped.length) {
        status('额度匹配停止，以下项目未处理：\n' + skipped.join('\n'), 'warn')
        return { ok: false, matchedCount: matched, skipped: skipped, message: '有项目未找到足够额度' }
      }

      if (matched <= 0) {
        status('没有找到需要处理的额度匹配项目。', 'warn')
        return { ok: false, matchedCount: 0, message: '没有找到需要处理的额度匹配项目' }
      }

      status('额度匹配完成：已保存 ' + matched + ' 项。' + (CONFIG.autoCreatePayment ? '正在生成支付申请...' : ''), 'ok')
      await createPayment(lastDoc)
      status('额度匹配完成：已保存 ' + matched + ' 项。' + (CONFIG.autoCreatePayment ? '已生成支付申请，请核对。' : ''), 'ok')
      return { ok: true, matchedCount: matched }
    } catch (error) {
      var msg = error && error.message ? error.message : String(error)
      status('额度匹配停止：' + msg, 'err')
      return { ok: false, message: msg }
    } finally {
      running = false
    }
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
      var anchor = findSalaryActionAnchor(doc)
      if (!anchor) {
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
        'margin-right:6px',
        'padding:0 10px',
        'height:28px',
        'line-height:28px',
        'background:#f59e0b',
        'color:#fff',
        'border-radius:2px',
        'text-decoration:none',
        'vertical-align:middle',
        'font-weight:700'
      ].join(';')
      btn.innerHTML = '<span class="l-btn-left"><span class="l-btn-text">自动额度匹配</span></span>'
      btn.onclick = function (event) {
        event.preventDefault()
        event.stopPropagation()
        start()
      }
      var host = anchor.closest ? (anchor.closest('a') || anchor) : anchor
      if (host && host.parentNode) host.parentNode.insertBefore(btn, host)
      else doc.body.appendChild(btn)
    }
  }

  window.__salaryQuotaMatch = {
    version: VERSION,
    start: start,
    injectButton: injectButton
  }

  window.addEventListener('load', injectButton)
  window.__salaryQuotaMatchTimer = setInterval(injectButton, 1500)
  injectButton()

  if (AUTO_START) return start()
  return { ok: true, message: 'installed' }
})()
