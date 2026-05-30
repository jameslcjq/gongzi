import type { SalaryQuotaMatchLocalSummary } from '@shared/types'

type SalaryQuotaMatchScriptOptions = {
  autoStart?: boolean
  showPageButton?: boolean
  localSummary?: SalaryQuotaMatchLocalSummary
}

export function buildSalaryQuotaMatchScript(
  options: SalaryQuotaMatchScriptOptions = {}
): string {
  const autoStart = options.autoStart ?? false
  const showPageButton = options.showPageButton ?? true
  const localSummary = options.localSummary ?? {
    ok: false,
    activeOtherOneTotal: 0,
    activeBasicPerformanceTotal: 0,
    retiredHousingTotal: 0,
    retiredActualPayTotal: 0,
    otherActualPayTotal: 0
  }

  return `
;(function installSalaryQuotaMatch() {
  var AUTO_START = ${autoStart ? 'true' : 'false'}
  var SHOW_PAGE_BUTTON = ${showPageButton ? 'true' : 'false'}
  var VERSION = '20260529-salary-quota-match-home-guard'
  var BTN_ID = 'salary-quota-match-btn'
  var STATUS_ID = 'salary-quota-match-status'
  var LOCAL_SUMMARY = ${JSON.stringify(localSummary)}

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
    return String(value || '').replace(/\\s+/g, ' ').trim()
  }

  function normalizeText(value) {
    return String(value || '').replace(/\\s+/g, '')
  }

  function parseAmountValue(value) {
    var text = String(value == null ? '' : value)
      .replace(/,/g, '')
      .replace(/￥/g, '')
      .replace(/元/g, '')
      .replace(/\\s+/g, '')
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

  function getLocalSummary() {
    try {
      return ((window.top || window).__salaryQuotaMatchLocalSummary || LOCAL_SUMMARY)
    } catch (error) {
      return window.__salaryQuotaMatchLocalSummary || LOCAL_SUMMARY
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
    return row.querySelector('[field="' + String(field).replace(/"/g, '\\\\"') + '"]')
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
    var match = id && id.match(/-(\\d+)$/)
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
    for (var i = 0; i < CONFIG.itemAmountFields.length; i++) {
      var value = getCellText(row, CONFIG.itemAmountFields[i])
      var amount = parseAmount(value)
      if (amount > 0) return amount
    }
    return 0
  }

  function getItemTypeText(row) {
    return CONFIG.itemTypeFields.map(function (field) { return getCellText(row, field) }).join(' ')
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
        merged.push({ row: item.row, amount: item.amount, label: item.label })
      }
    }
    return merged
  }

  function buildRetiredFeeAllocations(itemName, itemRow, amount, rows) {
    var localSummary = getLocalSummary()
    if (!localSummary || !localSummary.ok) {
      return {
        ok: false,
        reason: '本地工资数据读取失败，无法拆分“事业退休/退休费实发”：' + ((localSummary && localSummary.message) || '')
      }
    }

    var otherActual = roundMoney(localSummary.otherActualPayTotal)
    if (otherActual < 0) otherActual = 0
    if (otherActual > amount + 0.01) {
      return {
        ok: false,
        reason:
          '其他工资实发合计大于当前“退休费实发”金额，停止匹配。当前：' +
          formatAmount(amount) +
          '，其他工资实发：' +
          formatAmount(otherActual)
      }
    }

    var otherAmount = otherActual > 0 ? Math.min(otherActual, amount) : 0
    var retiredFeeAmount = roundMoney(amount - otherAmount)
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
      var basicQuota = null
      if (!livingQuota) {
        basicQuota = pick30301With30107Fallback(
          rows,
          otherAmount,
          {
            primaryRequire: ['30301'],
            primaryPrefer: ['30301', '基本工资'],
            primaryAvoid: ['30302', '退休费', '30305', '生活补助', '生活补贴'],
            primaryLabel: '30301 基本工资',
            fallbackRequire: ['30107'],
            fallbackPrefer: ['30107', '绩效工资'],
            fallbackAvoid: ['30302', '退休费', '30305', '生活补助', '生活补贴'],
            fallbackLabel: '30107 绩效工资'
          }
        )
      }
      var otherQuota = livingQuota ? { row: livingQuota, label: '30305 生活补助' } : basicQuota
      if (!otherQuota) {
        return {
          ok: false,
          reason:
            '其他工资实发合计无法匹配：30305 余额不足/未找到/余额读取失败，30301/30107 兜底也不足或不可用。金额：' +
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
    var housingQuota = pickQuotaByRequirement(
      rows,
      amount,
      ['30302', '事业人员提租补贴'],
      ['30302', '事业人员提租补贴', '住房补贴', '提租'],
      ['退休费', '30305', '生活补助', '生活补贴', '30102', '津贴补贴']
    )
    if (housingQuota) {
      return {
        ok: true,
        allocations: [{ row: housingQuota, amount: amount, label: '30302 事业人员提租补贴' }]
      }
    }

    var basicQuota = pick30301With30107Fallback(
      rows,
      amount,
      {
        primaryRequire: ['30301'],
        primaryPrefer: ['30301', '基本工资'],
        primaryAvoid: ['30302', '退休费', '30305', '生活补助', '生活补贴', '30102', '津贴补贴'],
        primaryLabel: '30301 基本工资',
        fallbackRequire: ['30107'],
        fallbackPrefer: ['30107', '绩效工资'],
        fallbackAvoid: ['30302', '退休费', '30305', '生活补助', '生活补贴', '30102', '津贴补贴'],
        fallbackLabel: '30107 绩效工资'
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
        '事业住房补贴无法匹配：30302 事业人员提租补贴余额不足/未找到/余额读取失败，30301/30107 兜底也不足或不可用。金额：' +
        formatAmount(amount)
    }
  }

  function buildCareerAllowanceAllocations(itemName, itemRow, amount, rows) {
    var allowanceQuota = pickQuotaByRequirement(
      rows,
      amount,
      ['30302', '事业人员工资'],
      ['30302', '事业人员工资', '津贴补贴'],
      ['事业人员提租补贴', '退休费', '30305', '生活补助', '生活补贴', '30102']
    )
    if (allowanceQuota) {
      return {
        ok: true,
        allocations: [{ row: allowanceQuota, amount: amount, label: '30302 事业人员工资' }]
      }
    }

    var basicQuota = pick30301With30107Fallback(
      rows,
      amount,
      {
        primaryRequire: ['30301'],
        primaryPrefer: ['30301', '基本工资'],
        primaryAvoid: ['30302', '退休费', '事业人员提租补贴', '30305', '生活补助', '生活补贴', '30102'],
        primaryLabel: '30301 基本工资',
        fallbackRequire: ['30107'],
        fallbackPrefer: ['30107', '绩效工资'],
        fallbackAvoid: ['30302', '退休费', '事业人员提租补贴', '30305', '生活补助', '生活补贴', '30102'],
        fallbackLabel: '30107 绩效工资'
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
        '事业津贴补贴无法匹配：30302 事业人员工资余额不足/未找到/余额读取失败，30301/30107 兜底也不足或不可用。金额：' +
        formatAmount(amount)
    }
  }

  function buildCareerBasicSalaryAllocations(itemName, itemRow, amount, rows) {
    var localSummary = getLocalSummary()
    if (!localSummary || !localSummary.ok) {
      return {
        ok: false,
        reason: '本地工资数据读取失败，无法拆分“事业/基本工资实发”：' + ((localSummary && localSummary.message) || '')
      }
    }

    var townshipAmount = roundMoney(localSummary.activeOtherOneTotal)
    var performanceAmount = roundMoney(localSummary.activeBasicPerformanceTotal)
    if (townshipAmount < 0) townshipAmount = 0
    if (performanceAmount < 0) performanceAmount = 0
    var splitKnown = roundMoney(townshipAmount + performanceAmount)
    if (splitKnown > amount + 0.01) {
      return {
        ok: false,
        reason:
          '事业基本工资拆分金额大于当前“基本工资实发”，停止匹配。当前：' +
          formatAmount(amount) +
          '，其他一：' +
          formatAmount(townshipAmount) +
          '，基础性绩效：' +
          formatAmount(performanceAmount)
      }
    }

    var remainingAmount = roundMoney(amount - townshipAmount - performanceAmount)
    var allocations = []

    if (townshipAmount > 0) {
      var township30302Quota = pickCareerSalary30302Quota(rows, townshipAmount)
      var townshipQuota = township30302Quota
        ? { row: township30302Quota, label: '30302 事业人员工资' }
        : pick30301With30107Fallback(
            rows,
            townshipAmount,
            {
              primaryRequire: ['30301'],
              primaryPrefer: ['30301', '基本工资'],
              primaryAvoid: ['30302', '退休费', '30305', '生活补助', '生活补贴'],
              primaryReject: ['基础性绩效'],
              primaryLabel: '30301 基本工资',
              fallbackRequire: ['30107'],
              fallbackPrefer: ['30107', '绩效工资'],
              fallbackAvoid: ['30302', '退休费', '30305', '生活补助', '生活补贴'],
              fallbackLabel: '30107 绩效工资'
            }
          )
      if (!townshipQuota) {
        return {
          ok: false,
          reason:
            '事业基本工资中的其他一无法匹配：30302 事业人员工资余额不足/未找到/余额读取失败，30301/30107 兜底也不足或不可用。金额：' +
            formatAmount(townshipAmount)
        }
      }
      allocations.push({ row: townshipQuota.row, amount: townshipAmount, label: townshipQuota.label })
    }

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
        return {
          ok: false,
          reason:
            '事业基本工资中的基础性绩效无法匹配：30107 绩效工资余额不足、未找到或余额读取失败。金额：' +
            formatAmount(performanceAmount)
        }
      }
      allocations.push({ row: performanceQuota, amount: performanceAmount, label: '30107 绩效工资' })
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
        return {
          ok: false,
          reason:
            '事业基本工资剩余金额无法匹配：30301 基本工资余额不足/未找到/余额读取失败，30107 兜底也不足或不可用。金额：' +
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

  async function enterAmount(row, amount) {
    var cell = getCell(row, CONFIG.quotaAmountField)
    if (!cell) return false
    clickElement(cell)
    try {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
    } catch (error) {}
    await sleep(250)
    var doc = row.ownerDocument
    var inputs = Array.prototype.slice.call(
      doc.querySelectorAll('input.textbox-text, input[type="text"], textarea')
    ).filter(isVisible)
    var input = inputs[inputs.length - 1] || doc.activeElement
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
    if (!btn) return false
    clickElement(btn)
    var start = Date.now()
    while (Date.now() - start < CONFIG.saveWaitTime) {
      clickDialogButton(['确定', '确认', '是', 'OK'])
      await sleep(500)
      return true
    }
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

      var createBtn = findButton(page, '额度匹配')
      if (createBtn) {
        status('已找到“额度匹配”，开始生成发放明细...')
        clickElement(createBtn)
        await sleep(1200)
        clickDialogButton(['确定', '确认', '是', 'OK'])
      }

      var itemPage = await waitForItemRows()
      if (!itemPage) throw new Error('没有找到可匹配的工资项目明细')

      var matched = 0
      var skipped = []
      var processed = {}
      var guard = 0
      while (guard < 80) {
        guard += 1
        itemPage = await waitForItemRows(8000)
        if (!itemPage || !itemPage.rows.length) break
        var candidates = itemPage.rows.filter(function (candidate, idx) {
          var candidateName = getCellText(candidate, CONFIG.itemNameField)
          var candidateAmount = getItemAmount(candidate)
          var key = candidateName + '|' + candidateAmount + '|' + rowIndex(candidate, idx)
          return !processed[key]
        })
        if (!candidates.length) break
        var row = candidates[0]
        var itemName = getCellText(row, CONFIG.itemNameField)
        var amount = getItemAmount(row)
        if (!itemName || amount <= 0) break
        var rowKey = itemName + '|' + amount + '|' + rowIndex(row, 0)

        status('处理：' + itemName + '\\n金额：' + formatAmount(amount))
        clickElement(row)
        await sleep(CONFIG.rowSettleWait)
        await clickModify(itemPage.doc)
        var quotas = await waitForQuotaRows(itemPage.doc)
        var plan = buildAllocations(itemName, row, amount, quotas)
        if (!plan.ok) {
          skipped.push(itemName + ' ' + formatAmount(amount) + '：' + plan.reason)
          status(plan.reason, 'warn')
          break
        }
        plan.allocations = mergeAllocations(plan.allocations)
        for (var a = 0; a < plan.allocations.length; a++) {
          var allocation = plan.allocations[a]
          clickElement(allocation.row)
          await sleep(300)
          if (!(await enterAmount(allocation.row, allocation.amount))) {
            throw new Error('无法填写挂接金额：' + itemName + ' / ' + allocation.label)
          }
          await sleep(300)
        }
        await sleep(350)
        if (!(await clickSave(itemPage.doc))) throw new Error('保存失败：' + itemName)
        matched += 1
        processed[rowKey] = true
        await sleep(1200)
      }

      if (skipped.length) {
        status('额度匹配停止，以下项目未处理：\\n' + skipped.join('\\n'), 'warn')
        return { ok: false, matchedCount: matched, skipped: skipped, message: '有项目未找到足够额度' }
      }

      if (matched <= 0) {
        status('没有找到需要处理的额度匹配项目。', 'warn')
        return { ok: false, matchedCount: 0, message: '没有找到需要处理的额度匹配项目' }
      }

      await createPayment(itemPage.doc)
      status('额度匹配完成。已保存 ' + matched + ' 项。', 'ok')
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
        'margin-left:6px',
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
      if (host && host.parentNode) host.parentNode.insertBefore(btn, host.nextSibling)
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
`
}

export function buildStartSalaryQuotaMatchScript(): string {
  return `
;(function startSalaryQuotaMatchFromToolbar() {
  function findController(win) {
    try {
      if (win.__salaryQuotaMatch && typeof win.__salaryQuotaMatch.start === 'function') return win
    } catch (error) {}
    try {
      for (var i = 0; i < win.frames.length; i++) {
        var found = findController(win.frames[i])
        if (found) return found
      }
    } catch (error) {}
    return null
  }

  var root = window.top || window
  var target = findController(root) || findController(window)
  if (!target || !target.__salaryQuotaMatch) {
    return { ok: false, code: 'not-installed', message: '额度匹配脚本尚未注入' }
  }
  return target.__salaryQuotaMatch.start()
})()
`
}
