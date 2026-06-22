import type { SalaryQuotaMatchLocalSummary } from '@shared/types'

type SalarySendReviewScriptOptions = {
  localSummary?: SalaryQuotaMatchLocalSummary
  unit?: {
    code?: string
    name?: string
  }
  month?: number
  autoStart?: boolean
  headless?: boolean
  showPageButton?: boolean
  suppressAlert?: boolean
}

export function buildSalarySendReviewScript(options: SalarySendReviewScriptOptions = {}): string {
  const localSummaryJson = JSON.stringify(options.localSummary ?? { ok: false, message: '未读取到本地工资汇总' })
  const unitJson = JSON.stringify(options.unit ?? { code: '', name: '' })
  return `
;(function installSalarySendReview() {
  var LOCAL_SUMMARY = ${localSummaryJson}
  var CONFIGURED_UNIT = ${unitJson}
  var CONFIGURED_MONTH = ${options.month ? Number(options.month) : 0}
  var AUTO_START = ${options.autoStart ? 'true' : 'false'}
  var HEADLESS = ${options.headless ? 'true' : 'false'}
  var SHOW_PAGE_BUTTON = ${options.showPageButton === false ? 'false' : 'true'}
  var SUPPRESS_ALERT = ${options.suppressAlert ? 'true' : 'false'}
  var DEFAULT_SALARY_AUDIT_MENUID = '785009768fb34244b79199b732902f7c'
  var TRACE = []
  var TRACE_T0 = Date.now()
  window.__salarySendReviewLocalSummary = LOCAL_SUMMARY

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function trace(text) {
    var line = '+' + ((Date.now() - TRACE_T0) / 1000).toFixed(1) + 's ' + text
    TRACE.push(line)
    console.log('[salary-send-review]', text)
  }

  function compactText(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim()
  }

  function normalizeText(value) {
    return String(value || '').replace(/\\s+/g, '')
  }

  function normalizeCode(value) {
    var digits = String(value || '').replace(/\\D/g, '')
    return digits.length > 6 ? digits.slice(0, 6) : digits
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

  function isSalaryAuditPage(doc) {
    if (!doc) return false
    try {
      var href = doc.location && doc.location.href ? doc.location.href : ''
      if (href.indexOf('/salaryNanJ/html/audit/salary/salSalaryExamineStep1.html') >= 0) return true
    } catch (error) {}
    return !!(doc.querySelector('#sendAuditCheck') && doc.querySelector('#sendAuditBtn'))
  }

  function isVisible(el) {
    if (!el) return false
    try {
      var win = el.ownerDocument.defaultView || window
      var style = win.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      var rect = el.getBoundingClientRect()
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

  function getSalaryAuditDocs() {
    var docs = getReachableDocs()
    var targets = []
    for (var i = 0; i < docs.length; i++) {
      if (isSalaryAuditPage(docs[i])) targets.push(docs[i])
    }
    return targets
  }

  function getFirstSalaryAuditDoc() {
    var docs = getSalaryAuditDocs()
    return docs.length ? docs[0] : null
  }

  function getLocalSummary() {
    try {
      return ((window.top || window).__salarySendReviewLocalSummary || LOCAL_SUMMARY)
    } catch (error) {
      return window.__salarySendReviewLocalSummary || LOCAL_SUMMARY
    }
  }

  function status(text, kind) {
    trace(text)
    var rootDoc = document
    try {
      if (window.top && window.top.document) rootDoc = window.top.document
    } catch (error) {}

    var id = 'laojiu-salary-send-review-status'
    var el = rootDoc.getElementById(id)
    if (!el) {
      el = rootDoc.createElement('div')
      el.id = id
      rootDoc.body.appendChild(el)
    }
    el.textContent = text
    var color = kind === 'err' ? '#991b1b' : kind === 'ok' ? '#14532d' : '#1f2937'
    var bg = kind === 'err' ? '#fee2e2' : kind === 'ok' ? '#dcfce7' : '#fff7ed'
    el.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'max-width:520px',
      'white-space:pre-wrap',
      'font-size:13px',
      'line-height:1.55',
      'padding:10px 12px',
      'border-radius:6px',
      'box-shadow:0 8px 28px rgba(15,23,42,.18)',
      'background:' + bg,
      'color:' + color,
      'border:1px solid rgba(15,23,42,.12)'
    ].join(';')
  }

  function alertAndStatus(message, kind) {
    status(message, kind || 'err')
    if (!SUPPRESS_ALERT) window.alert(message)
  }

  function getMenuId(doc) {
    try {
      var loc = (doc && doc.location) || location
      var params = new URLSearchParams(loc.search || '')
      return params.get('menuid') || params.get('moduleid') || ''
    } catch (error) {
      return ''
    }
  }

  function withMenu(path) {
    var menuid = window.__laojiuSalarySendReviewMenuId || getMenuId(document) || DEFAULT_SALARY_AUDIT_MENUID
    if (!menuid) return path
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'menuid=' + encodeURIComponent(menuid)
  }

  async function requestJson(method, url, body) {
    var options = {
      method: method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    }
    if (body !== undefined) options.body = JSON.stringify(body)
    var res = await fetch(url, options)
    var text = await res.text()
    var json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (error) {
      throw new Error('接口返回不是 JSON：' + url + '\\n' + text.slice(0, 300))
    }
    if (!res.ok) throw new Error('接口请求失败：' + res.status + ' ' + url)
    return json
  }

  function ensureSuccess(resp, label) {
    var code = String((resp && resp.status_code) || '')
    if (code === '1000' || code === '1001' || code === '0000') return
    throw new Error(label + '失败：' + ((resp && (resp.reason || resp.detail || resp.message)) || '未知错误'))
  }

  async function loadUserSession() {
    var resp = await requestJson('GET', '/framework-engin2/userSession/user')
    ensureSuccess(resp, '读取登录用户')
    return (resp && resp.data) || {}
  }

  function getSelectedAgencyCode(doc) {
    var selected = doc.querySelector('.tree-node-selected .tree-title')
    var text = compactText(selected && selected.textContent)
    var match = /(\\d{6})/.exec(text)
    return match ? match[1] : ''
  }

  function getSelectedAgencyFromEasyui(doc) {
    try {
      var win = doc.defaultView || window
      var $ = win.jQuery || win.$
      if (!$ || !$.fn || !$.fn.tree) return null
      var trees = Array.prototype.slice.call(doc.querySelectorAll('.tree'))
      for (var i = 0; i < trees.length; i++) {
        try {
          var selected = $(trees[i]).tree('getSelected')
          if (!selected) continue
          var attr = selected.attributes || {}
          var id = selected.agency_id || selected.agencyId || attr.agency_id || attr.agencyId || selected.id || attr.id || ''
          var text = selected.text || selected.name || ''
          var codeMatch = /(\\d{6})/.exec(String(text))
          return { id: String(id || ''), code: codeMatch ? codeMatch[1] : '', text: String(text || '') }
        } catch (error) {}
      }
    } catch (error) {}
    return null
  }

  function configuredUnitCode() {
    return normalizeCode(CONFIGURED_UNIT && CONFIGURED_UNIT.code)
  }

  function configuredUnitName() {
    return compactText(CONFIGURED_UNIT && CONFIGURED_UNIT.name)
  }

  function nodeMatchesConfiguredUnit(node) {
    var code = configuredUnitCode()
    var name = configuredUnitName()
    if (!code && !name) return false
    var text = compactText((node && (node.text || node.name)) || '')
    var attr = (node && node.attributes) || {}
    var rawCode = normalizeCode(node && (node.agency_code || node.agencyCode || node.code || attr.agency_code || attr.agencyCode || attr.code))
    if (code && (rawCode === code || text.indexOf(code) >= 0)) return true
    if (name && text.indexOf(name) >= 0) return true
    return false
  }

  function selectConfiguredAgencyInTree(doc) {
    try {
      var win = doc.defaultView || window
      var $ = win.jQuery || win.$
      if (!$ || !$.fn || !$.fn.tree) return null
      var trees = Array.prototype.slice.call(doc.querySelectorAll('.tree'))
      function walk(tree, node) {
        if (!node) return null
        if (nodeMatchesConfiguredUnit(node)) return node
        var children = []
        try {
          children = $(tree).tree('getChildren', node.target) || []
        } catch (error) {
          children = node.children || []
        }
        for (var i = 0; i < children.length; i++) {
          var found = walk(tree, children[i])
          if (found) return found
        }
        return null
      }
      for (var i = 0; i < trees.length; i++) {
        var tree = trees[i]
        var roots = []
        try { roots = $(tree).tree('getRoots') || [] } catch (error) {}
        for (var r = 0; r < roots.length; r++) {
          var found = walk(tree, roots[r])
          if (!found) continue
          try {
            if (found.target) {
              $(tree).tree('select', found.target)
              return found
            }
          } catch (error) {}
          return found
        }
      }
    } catch (error) {}
    return null
  }

  function extractNodeAgencyId(node) {
    if (!node) return ''
    var attr = node.attributes || {}
    var id = node.agency_id || node.agencyId || attr.agency_id || attr.agencyId || node.id || attr.id || ''
    id = String(id || '')
    // 单位 agency_id 是 GUID（如 0ba903a0-e6e8-4d29-ab2d-998bf9117568），用它校验，
    // 避免误把 easyui 树内部序号当成 agency_id。
    return /^[0-9a-f-]{20,}$/i.test(id) ? id : ''
  }

  function extractNodeCode(node) {
    if (!node) return ''
    var attr = node.attributes || {}
    var raw = node.CODE || node.code || node.agency_code || node.agencyCode ||
      attr.CODE || attr.code || attr.agency_code ||
      node.CODENAME || node.text || node.name || ''
    return normalizeCode(raw)
  }

  // 直接调一体化单位列表接口拿【系统设置单位】的真实 agency_id（确定性，不依赖单位树是否渲染好）。
  // 抓包坐实（2026-06-20）：GET /sal-query-pro-server/salaryQueryController/getAllAgencyHN?ele_code=Agency&judge=1&menuid=...
  //   → data[]，每项 CODE=单位编码、id=GUID agency_id、NAME/CODENAME=名称；status_code 可能 0000/1001（加载成功）。
  async function fetchAgencyList() {
    try {
      var resp = await requestJson('GET', withMenu('/sal-query-pro-server/salaryQueryController/getAllAgencyHN?ele_code=Agency&judge=1'))
      var data = resp && resp.data
      if (!Array.isArray(data)) return []
      var out = []
      for (var i = 0; i < data.length; i++) {
        var item = data[i] || {}
        var id = String(item.id || item.ID || '')
        if (!/^[0-9a-f-]{20,}$/i.test(id)) continue
        out.push({
          id: id,
          code: normalizeCode(item.CODE || item.code || item.CODENAME),
          name: compactText(item.NAME || item.name || item.CODENAME || '')
        })
      }
      return out
    } catch (error) {
      return []
    }
  }

  // 多单位账号必须【编码精确匹配】，绝不模糊——避免 019100 误命中 019052 等相近单位。
  function pickConfiguredAgency(list, requiredCode, requiredName) {
    if (list.length === 1) return { agency: list[0], how: '单位列表只有一个单位，直接使用' }
    var reqCode = normalizeCode(requiredCode)
    if (reqCode) {
      var byCode = list.filter(function (a) { return a.code && a.code === reqCode })
      if (byCode.length === 1) return { agency: byCode[0], how: '编码精确匹配 ' + reqCode }
      if (byCode.length > 1) {
        return { error: '系统设置单位编码 ' + reqCode + ' 在一体化匹配到多个单位，无法确定，已停止自动送审。' }
      }
    }
    var reqName = normalizeText(requiredName)
    if (reqName) {
      var byName = list.filter(function (a) { return normalizeText(a.name) === reqName })
      if (byName.length === 1) return { agency: byName[0], how: '名称精确匹配' }
      if (byName.length > 1) {
        return { error: '系统设置单位名称在一体化匹配到多个单位，请用编码区分，已停止自动送审。' }
      }
    }
    return {}
  }

  async function resolveAgency(doc) {
    var session = await loadUserSession()
    var requiredCode = configuredUnitCode()
    var requiredName = configuredUnitName()
    var sessionCode = normalizeCode(session.orgCode || session.userCode)
    var userCode = String(session.userCode || '')
    if (requiredCode) {
      // 支持“财政局/代管账号管多单位”：登录号可能 ≠ 系统设置单位号（如登录 019052 代管 019100）。
      // 1) 首选：调单位列表接口，按编码精确匹配系统设置单位，用它的 GUID agency_id。
      //    确定性、不依赖单位树渲染，多单位账号也稳；下游 loadBatches/审核全按 agency_id 走。
      var agencyList = await fetchAgencyList()
      var picked = pickConfiguredAgency(agencyList, requiredCode, requiredName)
      if (picked.error) throw new Error(picked.error)
      if (picked.agency) {
        try { selectConfiguredAgencyInTree(doc) } catch (error) {}
        trace('单位列表' + (picked.how || '匹配') + '：agency_id=' + picked.agency.id + '（' + picked.agency.name + '）')
        return {
          id: picked.agency.id,
          code: requiredCode || picked.agency.code,
          name: requiredName || picked.agency.name || String(session.orgName || '')
        }
      }
      // 2) 接口拿不到时退回单位树（DOM）——仍要求节点编码与系统设置单位【精确一致】。
      var matchedNode = selectConfiguredAgencyInTree(doc)
      var matchedId = extractNodeAgencyId(matchedNode)
      var matchedCode = extractNodeCode(matchedNode)
      if (matchedNode && matchedId && matchedCode === requiredCode) {
        trace('单位树编码精确选中 ' + matchedCode + '，agency_id=' + matchedId)
        return {
          id: matchedId,
          code: requiredCode,
          name: requiredName || compactText(matchedNode.text || matchedNode.name) || String(session.orgName || '')
        }
      }
      if (!agencyList.length && !matchedNode && session.orgId) {
        trace('未发现单位选择/单位列表，按当前登录单单位送审：agency_id=' + session.orgId)
        return {
          id: String(session.orgId),
          code: normalizeCode(session.orgCode || session.userCode) || requiredCode,
          name: String(session.orgName || '') || requiredName
        }
      }
      // 3) 退回“登录号本身就是该单位”（一机一单位老路径）。
      var loginIsConfiguredUnit =
        normalizeCode(session.orgCode) === requiredCode ||
        normalizeCode(session.userCode) === requiredCode ||
        userCode === requiredCode + '-0101'
      if (loginIsConfiguredUnit) {
        if (!session.orgId) throw new Error('未读取到当前单位 agency_id，已停止自动送审。')
        return {
          id: String(session.orgId),
          code: requiredCode,
          name: requiredName || String(session.orgName || '')
        }
      }
      // 4) 单位列表、单位树、登录号都没能定位到系统设置单位 → 拦，绝不送错。
      throw new Error(
        '系统设置单位是 ' + requiredCode + (requiredName ? '（' + requiredName + '）' : '') +
        '，但在当前登录号(' + (userCode || session.orgCode || '未知') +
        ')可访问的一体化单位里没定位到它。为避免送错单位，已停止自动送审。' +
        '请确认本机单位设置正确、且该登录号有权访问该单位。'
      )
    }
    var selectedCode = getSelectedAgencyCode(doc)
    var selected = getSelectedAgencyFromEasyui(doc)
    if (selected && selected.id && /^[0-9a-f-]{20,}$/i.test(selected.id)) {
      return {
        id: selected.id,
        code: selected.code || selectedCode || String(session.orgCode || ''),
        name: selected.text || String(session.orgName || '')
      }
    }

    sessionCode = String(session.orgCode || '')
    if (selectedCode && sessionCode && selectedCode !== sessionCode) {
      throw new Error(
        '当前选中单位是 ' + selectedCode +
        '，但暂未读取到该单位的 agency_id。为避免送错单位，已停止自动送审。'
      )
    }
    if (!session.orgId) throw new Error('未读取到当前单位 agency_id，已停止自动送审。')
    return { id: String(session.orgId), code: sessionCode || selectedCode, name: String(session.orgName || '') }
  }

  function getSelectedMonth(doc) {
    if (CONFIGURED_MONTH >= 1 && CONFIGURED_MONTH <= 12) return CONFIGURED_MONTH
    var inputs = Array.prototype.slice.call(doc.querySelectorAll('input.textbox-text,input[type="text"]'))
    for (var i = 0; i < inputs.length; i++) {
      var text = compactText(inputs[i].value || inputs[i].getAttribute('value') || '')
      var match = /^(\\d{1,2})月份$/.exec(text)
      if (match) return Number(match[1])
    }
    return new Date().getMonth() + 1
  }

  function batchCode(batch) {
    var raw = String((batch && (batch.code || batch.CODE || batch.TEXT || batch.name || batch.salbatch_name)) || '')
    var match = /\\[?(\\d{3})\\]?/.exec(raw)
    return match ? match[1] : raw
  }

  async function loadBatches(agencyId) {
    var resp = await requestJson(
      'POST',
      withMenu('/sal-config-pro-server/salaryBatchController/getSalbatchByAgency'),
      { agency_id: agencyId }
    )
    ensureSuccess(resp, '读取工资批次')
    return Array.isArray(resp.data) ? resp.data : []
  }

  function findBatch(batches, code) {
    for (var i = 0; i < batches.length; i++) {
      if (batchCode(batches[i]) === code) return batches[i]
    }
    return null
  }

  function batchId(batch) {
    return String(
      (batch && (batch.id || batch.ID || batch.salbatch_id || batch.value || batch.code_id)) || ''
    )
  }

  function batchName(batch) {
    return String((batch && (batch.TEXT || batch.text || batch.name || batch.salbatch_name || batch.code)) || '')
  }

  async function loadAuditRows(agencyId, salbatchId, month) {
    var resp = await requestJson(
      'POST',
      withMenu('/sal-salary-pro-server/salaryAuditController/loadAuditData'),
      {
        agency_id: [agencyId],
        bill_id: [null],
        flow_status: '001|004',
        salbatch_id: salbatchId,
        month: String(month),
        sal_bz_type: 1
      }
    )
    ensureSuccess(resp, '读取待送审工资')
    var data = resp && resp.data
    return data && Array.isArray(data.pageData) ? data.pageData : []
  }

  function summarizeRows(rows) {
    var ids = []
    var total = 0
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {}
      if (row.id != null) ids.push(row.id)
      var amount = parseAmountValue(row.sfgz != null ? row.sfgz : row['实发合计'])
      if (amount != null) total = roundMoney(total + amount)
    }
    return { ids: ids, total: roundMoney(total), rows: rows }
  }

  async function recalculateSalary(agencyId, salbatchId) {
    var resp = await requestJson(
      'POST',
      withMenu('/sal-salary-pro-server/salaryController/reCalculateSalaryNew'),
      { agency_id: agencyId, salbatch_id: salbatchId, sal_bz_types: ['1'] }
    )
    ensureSuccess(resp, '送审前重算')
  }

  async function checkBeforeSend(ids) {
    var resp = await requestJson(
      'POST',
      withMenu('/sal-salary-pro-server/salaryAuditController/checksendBatchSalaryHeN'),
      { id: ids }
    )
    ensureSuccess(resp, '送审前校验')
  }

  async function loadAuditor(agencyId, ids) {
    var resp = await requestJson(
      'POST',
      withMenu('/sal-config-pro-server/SalaryMonController/loadSalAuditor'),
      { agency_id: [agencyId], bill_id: ids }
    )
    ensureSuccess(resp, '读取送审人员')
    return resp
  }

  async function sendBatch(ids) {
    var resp = await requestJson(
      'POST',
      withMenu('/sal-salary-pro-server/salaryAuditController/sendBatchSalaryHeN'),
      { id: ids }
    )
    ensureSuccess(resp, '送审')
  }

  async function sendOneBatch(ctx, batch, required) {
    var id = batchId(batch)
    var name = batchName(batch)
    if (!id) throw new Error('工资批次缺少 id：' + name)

    status('自动送审：读取 ' + name + ' 待送审数据…')
    var rows = await loadAuditRows(ctx.agency.id, id, ctx.month)
    var summary = summarizeRows(rows)
    if (!summary.ids.length) {
      if (required) throw new Error(name + ' 没有待送审数据，已停止自动送审。')
      status(name + ' 没有待送审数据，已跳过。', 'warn')
      return { sent: false, total: summary.total }
    }

    status('自动送审：' + name + ' 送审前校验…\\n金额：' + formatAmount(summary.total))
    await recalculateSalary(ctx.agency.id, id)
    await sleep(300)
    await checkBeforeSend(summary.ids)
    await sleep(300)
    await loadAuditor(ctx.agency.id, summary.ids)
    await sendBatch(summary.ids)
    await sleep(500)

    var afterRows = await loadAuditRows(ctx.agency.id, id, ctx.month)
    if (afterRows.length > 0) {
      throw new Error(name + ' 已调用送审接口，但待送审列表仍有 ' + afterRows.length + ' 条，请人工复核。')
    }
    status('自动送审：' + name + ' 送审成功。', 'ok')
    return { sent: true, total: summary.total }
  }

  function preflightReview(localSummary, batch001, batch002) {
    if (!localSummary || !localSummary.ok) {
      return {
        ok: false,
        message: '自动送审前置校验失败：本地工资汇总读取失败，已停止自动送审。' +
          ((localSummary && localSummary.message) || '')
      }
    }
    var historyActual = roundMoney(localSummary.actualPayTotal || 0)
    if (historyActual <= 0) {
      return {
        ok: false,
        message: '自动送审前置校验失败：未读取到当月历史报表“实发合计”。请先在“工资业务 → 月度工资”生成当月报账。'
      }
    }
    var page001 = roundMoney(batch001.total)
    var page002 = roundMoney(batch002.total)
    var expected001 = roundMoney(historyActual - page002)
    if (!moneyEquals(page001, expected001)) {
      return {
        ok: false,
        message:
          '自动送审前置校验未通过，已停止自动送审：\\n' +
          '001工资页面实发合计：' + formatAmount(page001) + '\\n' +
          '历史报表当月实发合计：' + formatAmount(historyActual) + '\\n' +
          '002数币批次金额：' + formatAmount(page002) + '\\n' +
          '应满足：001工资 = 历史实发合计 − 002数币 = ' + formatAmount(expected001) + '\\n' +
          '差额：' + formatAmount(roundMoney(page001 - expected001))
      }
    }
    return {
      ok: true,
      message:
        '自动送审前置校验通过：\\n' +
        '001工资页面实发合计 ' + formatAmount(page001) +
        ' = 历史实发合计 ' + formatAmount(historyActual) +
        ' − 002数币 ' + formatAmount(page002)
    }
  }

  async function runAutoSendReview(targetDoc) {
    var doc = targetDoc || getFirstSalaryAuditDoc() || document
    if (!HEADLESS && !isSalaryAuditPage(doc)) {
      var pageMsg = '请先进入“工资发放 → 业务流程 → 送审”页面。'
      alertAndStatus(pageMsg)
      return { ok: false, message: pageMsg, trace: TRACE, traceText: TRACE.join('\\n') }
    }
    window.__laojiuSalarySendReviewMenuId = getMenuId(doc)
    if (window.__laojiuSalarySendReviewRunning) {
      return { ok: false, message: '自动送审正在运行', trace: TRACE, traceText: TRACE.join('\\n') }
    }
    window.__laojiuSalarySendReviewRunning = true
    var buttons = Array.prototype.slice.call(doc.querySelectorAll('#laojiu-auto-send-review,#laojiu-auto-send-review-float'))
    buttons.forEach(function (item) {
      item.disabled = true
      item.textContent = '自动送审中…'
    })
    try {
      var ctx = {
        agency: await resolveAgency(doc),
        month: getSelectedMonth(doc)
      }
      status('自动送审：读取批次和待送审金额…\\n单位：' + (ctx.agency.code || '') + ' ' + (ctx.agency.name || '') + '\\n月份：' + ctx.month + '月')

      var batches = await loadBatches(ctx.agency.id)
      var batch001 = findBatch(batches, '001')
      var batch002 = findBatch(batches, '002')
      if (!batch001) throw new Error('未找到 [001]工资 批次，已停止自动送审。')
      if (!batch002) throw new Error('未找到 [002]数币 批次，已停止自动送审。')

      var id001 = batchId(batch001)
      var id002 = batchId(batch002)
      var rows001 = await loadAuditRows(ctx.agency.id, id001, ctx.month)
      var rows002 = await loadAuditRows(ctx.agency.id, id002, ctx.month)
      var summary001 = summarizeRows(rows001)
      var summary002 = summarizeRows(rows002)
      if (!summary001.ids.length) throw new Error('[001]工资 没有待送审数据，已停止自动送审。')
      if (!summary002.ids.length) throw new Error('[002]数币 没有待送审数据，已停止自动送审。')

      var preflight = preflightReview(getLocalSummary(), summary001, summary002)
      if (!preflight.ok) {
        alertAndStatus(preflight.message, 'err')
        return { ok: false, message: preflight.message, trace: TRACE, traceText: TRACE.join('\\n') }
      }
      status(preflight.message, 'ok')

      await sendOneBatch(ctx, batch001, true)
      await sendOneBatch(ctx, batch002, true)

      var message = '自动送审完成：\\n[001]工资：' + formatAmount(summary001.total) + '\\n[002]数币：' + formatAmount(summary002.total)
      alertAndStatus(message, 'ok')
      try {
        var refresh = findButton(doc, '刷新')
        if (refresh) clickElement(refresh)
      } catch (error) {}
      return {
        ok: true,
        message: message,
        batch001Total: summary001.total,
        batch002Total: summary002.total,
        trace: TRACE,
        traceText: TRACE.join('\\n')
      }
    } catch (error) {
      var msg = error instanceof Error ? error.message : String(error)
      alertAndStatus(msg, 'err')
      return { ok: false, message: msg, trace: TRACE, traceText: TRACE.join('\\n') }
    } finally {
      window.__laojiuSalarySendReviewRunning = false
      buttons = Array.prototype.slice.call(doc.querySelectorAll('#laojiu-auto-send-review,#laojiu-auto-send-review-float'))
      buttons.forEach(function (item) {
        item.disabled = false
        item.textContent = '自动送审'
      })
    }
  }

  function clickElement(element) {
    if (!element) return false
    try {
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      element.click()
      return true
    } catch (error) {
      try {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        return true
      } catch (inner) {
        return false
      }
    }
  }

  function findButton(doc, text) {
    var wanted = normalizeText(text)
    var nodes = Array.prototype.slice.call(doc.querySelectorAll('a,button,.l-btn,[role="button"],span.l-btn-text'))
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      var label = normalizeText(node.innerText || node.textContent || node.getAttribute('title') || '')
      if (label === wanted) return node.closest ? (node.closest('a,button,.l-btn') || node) : node
    }
    return null
  }

  function wireButton(btn, doc) {
    btn.textContent = window.__laojiuSalarySendReviewRunning ? '自动送审中…' : '自动送审'
    btn.disabled = !!window.__laojiuSalarySendReviewRunning
    btn.onclick = function (event) {
      event.preventDefault()
      event.stopPropagation()
      void runAutoSendReview(doc)
    }
  }

  function ensureButtonInDoc(doc) {
    if (!doc || !isSalaryAuditPage(doc)) return false
    var sendBtn = doc.querySelector('#sendAuditBtn')
    var btn = doc.getElementById('laojiu-auto-send-review')
    if (sendBtn && sendBtn.parentNode && !btn) {
      btn = doc.createElement('button')
      btn.id = 'laojiu-auto-send-review'
      btn.type = 'button'
      sendBtn.parentNode.insertBefore(btn, sendBtn.nextSibling)
    }
    if (btn) {
      wireButton(btn, doc)
      btn.style.cssText = [
        'margin-left:8px',
        'height:28px',
        'padding:0 10px',
        'border:1px solid #2563eb',
        'border-radius:4px',
        'background:#2563eb',
        'color:#fff',
        'font-size:13px',
        'cursor:pointer',
        'vertical-align:middle'
      ].join(';')
    }

    var floatBtn = doc.getElementById('laojiu-auto-send-review-float')
    if (!floatBtn) {
      floatBtn = doc.createElement('button')
      floatBtn.id = 'laojiu-auto-send-review-float'
      floatBtn.type = 'button'
      doc.body.appendChild(floatBtn)
    }
    wireButton(floatBtn, doc)
    floatBtn.style.cssText = [
      'position:fixed',
      'right:18px',
      'top:76px',
      'z-index:2147483647',
      'height:32px',
      'min-width:86px',
      'padding:0 12px',
      'border:1px solid #2563eb',
      'border-radius:4px',
      'background:#2563eb',
      'color:#fff',
      'font-size:13px',
      'font-weight:600',
      'box-shadow:0 8px 20px rgba(37,99,235,.22)',
      'cursor:pointer'
    ].join(';')
    return true
  }

  function ensureButton() {
    if (!SHOW_PAGE_BUTTON) {
      var existingDocs = getReachableDocs()
      for (var e = 0; e < existingDocs.length; e++) {
        var oldBtn = existingDocs[e].getElementById('laojiu-auto-send-review')
        var oldFloat = existingDocs[e].getElementById('laojiu-auto-send-review-float')
        if (oldBtn && oldBtn.parentNode) oldBtn.parentNode.removeChild(oldBtn)
        if (oldFloat && oldFloat.parentNode) oldFloat.parentNode.removeChild(oldFloat)
      }
      return
    }
    var docs = getSalaryAuditDocs()
    if (!docs.length && isSalaryAuditPage(document)) docs = [document]
    for (var i = 0; i < docs.length; i++) ensureButtonInDoc(docs[i])
  }

  ensureButton()
  if (!window.__laojiuSalarySendReviewTimer) {
    window.__laojiuSalarySendReviewTimer = setInterval(ensureButton, 1500)
  }
  if (AUTO_START) return runAutoSendReview(getFirstSalaryAuditDoc() || document)
})()
`
}
