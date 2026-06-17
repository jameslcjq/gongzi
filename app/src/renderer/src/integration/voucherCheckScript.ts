import type { UnitSettings } from '@shared/types'
import {
  createDefaultVoucherCheckRuleLibrary,
  type VoucherCheckRuleLibrary
} from '@shared/voucherCheckRules'

export type VoucherCheckScriptOptions = {
  unit?: Pick<UnitSettings, 'unitFullName' | 'unitImportCode' | 'functionCode' | 'retiredFunctionCode'>
  ruleLibrary?: VoucherCheckRuleLibrary
}

export function buildVoucherCheckScript(options: VoucherCheckScriptOptions = {}): string {
  const payload = {
    unitFullName: options.unit?.unitFullName || '',
    unitImportCode: options.unit?.unitImportCode || '',
    functionCode: options.unit?.functionCode || '',
    retiredFunctionCode: options.unit?.retiredFunctionCode || '2210202',
    ruleLibrary: options.ruleLibrary || createDefaultVoucherCheckRuleLibrary()
  }

  return String.raw`
;(() => {
  const SCRIPT_VERSION = '20260617-period-accounting-check-v6'
  const OPTIONS = ${JSON.stringify(payload)}

  try {
    console.log('[voucher-check] script reached frame:', location.href)
  } catch (error) {}

  if (window.__salaryVoucherChecker && window.__salaryVoucherChecker.version === SCRIPT_VERSION) {
    window.__salaryVoucherChecker.options = OPTIONS
    window.__salaryVoucherChecker.injectButton()
    return { ok: true, message: 'installed' }
  }

  if (window.__salaryVoucherCheckTimer) {
    clearInterval(window.__salaryVoucherCheckTimer)
    window.__salaryVoucherCheckTimer = null
  }

  const CAPITAL_EXP_ECO_CODES = new Set([
    '31001', '31002', '31003', '31005', '31006', '31007', '31008', '31009',
    '31010', '31011', '31012', '31013', '31019', '31021', '31022', '31099'
  ])
  const FIXED_ASSET_PREFIXES = ['160101', '160102', '160103', '160104', '160105', '160106']
  const VOUCHER_INPUT_PATH = '/gld-web/gl/html/voucher/VoucherInput.html'
  const BOOK_MENU_ID = 'eb140b8e27464d06872c8c504d9d57f0'
  const BOOK_MENU_PARAMETER = '2'
  const CHECK_PANEL_WIDTH = 1200

  const state = {
    lastVoucher: null,
    vouchersById: new Map(),
    voucherLists: [],
    balanceMenuId: '',
    balanceBookId: '',
    balanceBookMenuId: '',
    panelHidden: false,
    running: false
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  }

  function compactText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, '').trim()
  }

  function normalizeCode(value) {
    return String(value == null ? '' : value).replace(/[^0-9A-Za-z]/g, '').toUpperCase()
  }

  function amount(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0
    const raw = String(value == null ? '' : value).replace(/,/g, '').trim()
    if (!raw) return 0
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : 0
  }

  function directedAmounts(raw) {
    var debit = amount(firstValue(raw, ['deb_money', 'dr_amt', 'money_debit', 'dr_money']))
    var credit = amount(firstValue(raw, ['cre_money', 'cr_amt', 'money_credit', 'cr_money']))
    if (debit || credit) return { debit: debit, credit: credit }

    var direction = Number(firstValue(raw, ['dr_cr', 'realDrCr']))
    var value = amount(firstValue(raw, ['realAmt', 'amt', 'money']))
    if (!value) return { debit: 0, credit: 0 }
    if (direction === 1) return { debit: value, credit: 0 }
    if (direction === 2) return { debit: 0, credit: value }
    return { debit: 0, credit: 0 }
  }

  function formatMoney(value) {
    return amount(value).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }

  function firstValue(source, keys) {
    if (!source) return ''
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key]
    }
    return ''
  }

  function extractRows(payload) {
    const candidates = [
      payload && payload.rows,
      payload && payload.data,
      payload && payload.data && payload.data.rows,
      payload && payload.data && payload.data.data,
      payload && payload.result,
      payload && payload.result && payload.result.rows
    ]
    for (let i = 0; i < candidates.length; i += 1) {
      if (Array.isArray(candidates[i])) return candidates[i]
      if (candidates[i] && Array.isArray(candidates[i].rows)) return candidates[i].rows
    }
    return []
  }

  function normalizeDetail(raw, index) {
    const subjectCode = normalizeCode(firstValue(raw, [
      'as_code', 'debit_as_code', 'credit_as_code', 'bgt_as_code',
      'debit_bgt_as_code', 'credit_bgt_as_code', 'cr_code'
    ]))
    const subjectName = normalizeText(firstValue(raw, [
      'as_name', 'debit_as_name', 'credit_as_name', 'bgt_as_name',
      'debit_bgt_as_name', 'credit_bgt_as_name', 'cr_name'
    ]))
    const expFuncCode = normalizeCode(firstValue(raw, ['exp_func_code', 'function_code', 'expFuncCode']))
    const expFuncName = normalizeText(firstValue(raw, ['exp_func_name', 'function_name', 'expFuncName']))
    const expEcoCode = normalizeCode(firstValue(raw, ['exp_eco_code', 'dep_exp_eco_code', 'expEcoCode']))
    const expEcoName = normalizeText(firstValue(raw, ['exp_eco_name', 'dep_exp_eco_name', 'expEcoName']))
    const money = directedAmounts(raw)

    return {
      raw,
      index: Number(firstValue(raw, ['vou_seq', 'detail_id', 'rowIndex'])) || index + 1,
      subjectCode,
      subjectName,
      summary: normalizeText(firstValue(raw, ['summary', 'smr'])),
      assistantSummary: normalizeText(firstValue(raw, ['assistant_summary', 'assistantSummary'])),
      debit: money.debit,
      credit: money.credit,
      expFuncCode,
      expFuncName,
      expEcoCode,
      expEcoName,
      budgetProjectName: normalizeText(firstValue(raw, ['dep_pro_name', 'budget_project_name', 'budgetProjectName']))
    }
  }

  function normalizeVoucher(raw, fallback) {
    const source = raw && raw.data && !Array.isArray(raw.data) ? raw.data : raw
    if (!source || typeof source !== 'object') return null
    const detailsRaw = Array.isArray(source.details)
      ? source.details
      : Array.isArray(source.detail)
        ? source.detail
        : Array.isArray(source.children)
          ? source.children
          : []
    const fallbackRow = fallback || {}
    const voucher = {
      id: normalizeText(firstValue(source, ['id', 'voucher_id']) || firstValue(fallbackRow, ['id', 'voucher_id'])),
      type: normalizeText(firstValue(source, ['voucherTypeName', 'acct_voucher_type', 'voucher_type_name']) || firstValue(fallbackRow, ['voucherTypeName', 'acct_voucher_type'])),
      no: normalizeText(firstValue(source, ['no', 'voucher_no', 'vou_no']) || firstValue(fallbackRow, ['no', 'voucher_no', 'vou_no'])),
      period: normalizeText(firstValue(source, ['period', 'acct_period']) || firstValue(fallbackRow, ['period', 'acct_period'])),
      date: normalizeText(firstValue(source, ['voucher_date', 'make_date', 'date']) || firstValue(fallbackRow, ['voucher_date', 'make_date'])),
      accessoryNum: amount(firstValue(source, ['accessory_num', 'accessoryNum', 'attach_num']) || firstValue(fallbackRow, ['accessory_num', 'accessoryNum'])),
      summary: normalizeText(firstValue(source, ['summary']) || firstValue(fallbackRow, ['summary'])),
      raw: source,
      details: detailsRaw.map(normalizeDetail).filter(function (detail) {
        return detail.subjectCode || detail.summary || detail.debit || detail.credit || detail.expFuncCode || detail.expEcoCode
      })
    }
    if (!voucher.type && voucher.no && voucher.no.indexOf('-') > 0) voucher.type = voucher.no.split('-')[0]
    return voucher
  }

  function rememberVoucher(raw, fallback) {
    const voucher = normalizeVoucher(raw, fallback)
    if (!voucher || !voucher.details.length) return null
    state.lastVoucher = voucher
    if (voucher.id) state.vouchersById.set(voucher.id, voucher)
    return voucher
  }

  function rememberVoucherList(payload) {
    const rows = extractRows(payload)
    if (!rows.length) return
    state.voucherLists.unshift(rows)
    if (state.voucherLists.length > 8) state.voucherLists.pop()
  }

  function captureResponse(url, text, requestBody) {
    try {
      const urlText = String(url || '')
      if (!urlText) return
      if (urlText.indexOf('getVoucherById') < 0 && urlText.indexOf('loadVoucherPage') < 0) return
      const trimmed = String(text || '').trim()
      if (!trimmed || trimmed.charAt(0) === '<') return
      const parsed = JSON.parse(trimmed)
      if (urlText.indexOf('getVoucherById') >= 0) {
        const fallback = {}
        const idMatch = String(requestBody || '').match(/(?:^|&)id=([^&]+)/)
        if (idMatch) fallback.id = decodeURIComponent(idMatch[1])
        rememberVoucher(parsed, fallback)
      } else if (urlText.indexOf('loadVoucherPage') >= 0) {
        rememberVoucherList(parsed)
      }
    } catch (error) {}
  }

  function patchNetwork() {
    if (window.__salaryVoucherCheckNetworkPatched) return
    window.__salaryVoucherCheckNetworkPatched = true

    try {
      const originalFetch = window.fetch
      if (typeof originalFetch === 'function') {
        window.fetch = function patchedVoucherCheckFetch(input, init) {
          const requestUrl = typeof input === 'string' ? input : (input && input.url) || ''
          const requestBody = init && init.body
          return originalFetch.apply(this, arguments).then(function (response) {
            try {
              const clone = response.clone()
              clone.text().then(function (text) {
                captureResponse(requestUrl, text, requestBody)
              }).catch(function () {})
            } catch (error) {}
            return response
          })
        }
      }
    } catch (error) {}

    try {
      const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype
      if (!proto || proto.__salaryVoucherCheckPatched) return
      proto.__salaryVoucherCheckPatched = true
      const originalOpen = proto.open
      const originalSend = proto.send
      proto.open = function patchedVoucherCheckOpen(method, url) {
        this.__salaryVoucherCheckUrl = url
        return originalOpen.apply(this, arguments)
      }
      proto.send = function patchedVoucherCheckSend(body) {
        try {
          this.addEventListener('readystatechange', function () {
            if (this.readyState === 4) captureResponse(this.__salaryVoucherCheckUrl, this.responseText, body)
          })
        } catch (error) {}
        return originalSend.apply(this, arguments)
      }
    } catch (error) {}
  }

  function menuId() {
    try {
      const params = new URLSearchParams(location.search || '')
      return params.get('menuid') || params.get('moduleid') || ''
    } catch (error) {
      const match = String(location.href || '').match(/[?&]menuid=([^&]+)/)
      return match ? decodeURIComponent(match[1]) : ''
    }
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options || { credentials: 'include' })
    const text = await response.text()
    if (!response.ok) throw new Error('HTTP ' + response.status + '：' + text.slice(0, 120))
    const trimmed = String(text || '').trim()
    if (!trimmed) return null
    if (trimmed.charAt(0) === '<') throw new Error('接口返回了页面，请确认一体化登录状态')
    return JSON.parse(trimmed)
  }

  async function fetchVoucherById(id, fallback) {
    const mid = menuId()
    if (!id) throw new Error('当前凭证没有可读取的 ID')
    if (!mid) throw new Error('当前页面缺少 menuid，无法读取凭证明细')
    const payload = await fetchJson('/gld-account-server/gl/account/getVoucherById?menuid=' + encodeURIComponent(mid), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'id=' + encodeURIComponent(id)
    })
    const voucher = rememberVoucher(payload, fallback)
    if (!voucher) throw new Error('凭证明细接口没有返回可检查的分录')
    return voucher
  }

  function parseMonthValue(value) {
    const direct = Number(value)
    if (Number.isFinite(direct) && direct >= 1 && direct <= 13) return direct
    const text = String(value == null ? '' : value)
    const dateMatch = text.match(/(?:^|[^0-9])20\\d{2}[-/年](\\d{1,2})(?:[-/月]|$)/)
    if (dateMatch) return Number(dateMatch[1])
    const monthMatch = text.match(/(?:^|[^0-9])(\\d{1,2})\\s*月/)
    if (monthMatch) return Number(monthMatch[1])
    return 0
  }

  function rowPeriod(row) {
    return parseMonthValue(firstValue(row, [
      'period', 'acct_period', 'month', 'monthId', 'voucher_month', 'voucher_date', 'make_date', 'date'
    ]))
  }

  function resolveCurrentPeriod() {
    const selected = readSelectedVoucherRow()
    const selectedPeriod = rowPeriod(selected)
    if (selectedPeriod) return selectedPeriod

    if (state.lastVoucher) {
      const lastPeriod = parseMonthValue(state.lastVoucher.period || state.lastVoucher.date)
      if (lastPeriod) return lastPeriod
    }

    try {
      const nodes = document.querySelectorAll('input,select,.textbox-value,.combo-value')
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]
        const name = compactText(node.getAttribute && (
          node.getAttribute('name') || node.getAttribute('id') || node.getAttribute('textboxname') || ''
        ))
        if (name && name.toLowerCase().indexOf('period') < 0 && name.indexOf('期间') < 0 && name.indexOf('月份') < 0) continue
        const value = node.value || node.getAttribute('value') || node.innerText || node.textContent
        const period = parseMonthValue(value)
        if (period) return period
      }
    } catch (error) {}

    const cachedPeriods = {}
    state.voucherLists.forEach(function (rows) {
      rows.forEach(function (row) {
        const period = rowPeriod(row)
        if (!period) return
        cachedPeriods[period] = (cachedPeriods[period] || 0) + 1
      })
    })
    let bestPeriod = 0
    let bestCount = 0
    Object.keys(cachedPeriods).forEach(function (key) {
      if (cachedPeriods[key] > bestCount) {
        bestPeriod = Number(key)
        bestCount = cachedPeriods[key]
      }
    })
    return bestPeriod
  }

  function uniqueVoucherRows(rows, period) {
    const seen = new Set()
    return (rows || []).filter(function (row) {
      if (!row) return false
      const id = normalizeText(firstValue(row, ['id', 'voucher_id']))
      if (!id || seen.has(id)) return false
      const itemPeriod = rowPeriod(row)
      if (period && itemPeriod && itemPeriod !== period) return false
      seen.add(id)
      return true
    }).sort(function (a, b) {
      const aNo = Number(firstValue(a, ['no', 'voucher_no', 'vou_no'])) || 0
      const bNo = Number(firstValue(b, ['no', 'voucher_no', 'vou_no'])) || 0
      return aNo - bNo
    })
  }

  function cachedVoucherRowsForPeriod(period) {
    const rows = []
    state.voucherLists.forEach(function (list) {
      list.forEach(function (row) {
        const itemPeriod = rowPeriod(row)
        if (!period || !itemPeriod || itemPeriod === period) rows.push(row)
      })
    })
    return uniqueVoucherRows(rows, period)
  }

  async function fetchVoucherRowsForPeriod(period) {
    const mid = menuId()
    if (!mid) throw new Error('当前页面缺少 menuid，无法读取本月凭证列表')
    const payload = await fetchJson('/gld-account-server/gl/account/loadVoucherPageisQuery?menuid=' + encodeURIComponent(mid), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'period=' + encodeURIComponent(period) + '&isModelFlag=false'
    })
    rememberVoucherList(payload)
    return uniqueVoucherRows(extractRows(payload), period)
  }

  function completedPeriods() {
    const currentMonth = new Date().getMonth() + 1
    const lastClosedMonth = currentMonth - 1
    const periods = []
    for (let month = 1; month <= lastClosedMonth; month += 1) periods.push(month)
    return periods
  }

  function fallbackVoucherFromRow(row, period) {
    return {
      id: normalizeText(firstValue(row, ['id', 'voucher_id'])),
      type: normalizeText(firstValue(row, ['voucherTypeName', 'acct_voucher_type', 'voucher_type_name'])) || '凭证',
      no: normalizeText(firstValue(row, ['no', 'voucher_no', 'vou_no'])),
      period: String(period || rowPeriod(row) || ''),
      date: normalizeText(firstValue(row, ['voucher_date', 'make_date', 'date'])),
      accessoryNum: amount(firstValue(row, ['accessory_num', 'accessoryNum', 'attach_num'])),
      summary: normalizeText(firstValue(row, ['summary'])),
      raw: row || {},
      details: []
    }
  }

  async function checkCurrentMonthBatch() {
    const period = resolveCurrentPeriod()
    if (!period) throw new Error('未能判断当前月份。请先在左侧凭证列表中点选本月任意一张凭证，再点击检查。')

    let rows = []
    try {
      rows = await fetchVoucherRowsForPeriod(period)
    } catch (error) {
      rows = cachedVoucherRowsForPeriod(period)
      if (!rows.length) throw error
    }
    if (!rows.length) throw new Error(period + '月没有读取到凭证列表。请确认当前月份下已有凭证。')

    const results = []
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      const id = normalizeText(firstValue(row, ['id', 'voucher_id']))
      renderLoading('正在检查 ' + period + ' 月凭证：' + (i + 1) + '/' + rows.length)
      try {
        const voucher = await fetchVoucherById(id, row)
        results.push(checkVoucher(voucher))
      } catch (error) {
        const voucher = fallbackVoucherFromRow(row, period)
        results.push({
          voucher,
          issues: [{
            level: 'error',
            rule: '读取凭证',
            message: titleOf(voucher) + '读取失败：' + (error && error.message ? error.message : String(error || '未知错误')),
            suggestion: '请打开该凭证确认页面可正常读取后再试。',
            detail: ''
          }],
          debitTotal: 0,
          creditTotal: 0
        })
      }
    }

    return { period, rows, results }
  }

  function urlParam(url, name) {
    const normalizedUrl = String(url || '').replace(/&amp;/g, '&')
    try {
      const parsed = new URL(normalizedUrl, location.href)
      return parsed.searchParams.get(name) || ''
    } catch (error) {
      const match = normalizedUrl.match(new RegExp('[?&]' + name + '=([^&]+)'))
      return match ? decodeURIComponent(match[1]) : ''
    }
  }

  function looksLikeBalanceBookUrl(url) {
    const text = String(url || '').replace(/&amp;/g, '&')
    return text.indexOf('BookView.html') >= 0 &&
      (urlParam(text, 'menu_parameter') === BOOK_MENU_PARAMETER || text.indexOf('menu_parameter=2') >= 0)
  }

  function scanBalanceMenuIdInDoc(doc) {
    try {
      if (!doc) return ''
      const currentHref = String(doc.location && doc.location.href || '')
      if (looksLikeBalanceBookUrl(currentHref)) {
        const currentMenuId = urlParam(currentHref, 'menuid')
        if (currentMenuId) return currentMenuId
      }

      const nodes = doc.querySelectorAll('iframe[src],frame[src],a[href],[data-url],[url]')
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]
        const rawUrl = node.getAttribute('src') || node.getAttribute('href') ||
          node.getAttribute('data-url') || node.getAttribute('url') || ''
        if (!looksLikeBalanceBookUrl(rawUrl)) continue
        const menuId = urlParam(rawUrl, 'menuid')
        if (menuId) return menuId
      }

      const html = String(doc.body && doc.body.innerHTML || '')
      const matches = html.match(/BookView\.html\?[^"'<>\s]*menu_parameter=2[^"'<>\s]*/ig) || []
      for (let i = 0; i < matches.length; i += 1) {
        const menuId = urlParam(matches[i], 'menuid')
        if (menuId) return menuId
      }
    } catch (error) {}
    return ''
  }

  function findBalanceMenuIdFromOpenPages() {
    const seen = []
    function visit(win) {
      try {
        if (!win || seen.indexOf(win) >= 0) return ''
        seen.push(win)
        const menuId = scanBalanceMenuIdInDoc(win.document)
        if (menuId) return menuId
        for (let i = 0; i < win.frames.length; i += 1) {
          const childMenuId = visit(win.frames[i])
          if (childMenuId) return childMenuId
        }
      } catch (error) {}
      return ''
    }
    try {
      return visit(window.top || window) || visit(window) || ''
    } catch (error) {
      return scanBalanceMenuIdInDoc(document)
    }
  }

  function resolveBalanceMenuId() {
    const found = findBalanceMenuIdFromOpenPages()
    if (found && found !== state.balanceMenuId) {
      state.balanceMenuId = found
      state.balanceBookId = ''
      state.balanceBookMenuId = ''
    }
    if (!state.balanceMenuId) state.balanceMenuId = BOOK_MENU_ID
    return state.balanceMenuId
  }

  function bookApi(path, menuId) {
    const resolvedMenuId = menuId || resolveBalanceMenuId()
    return '/gld-data-server/' + path + '?menuid=' + encodeURIComponent(resolvedMenuId) + '&menu_parameter=' + BOOK_MENU_PARAMETER
  }

  async function warmupBalanceBookPage(menuId) {
    const resolvedMenuId = menuId || resolveBalanceMenuId()
    function balanceQuery(path) {
      return path + (path.indexOf('?') >= 0 ? '&' : '?') +
        'menuid=' + encodeURIComponent(resolvedMenuId) +
        '&menu_parameter=' + BOOK_MENU_PARAMETER
    }
    async function postWarmup(path) {
      try {
        await fetch(balanceQuery(path), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json;charset=UTF-8' }
        })
      } catch (error) {}
    }
    try {
      await fetch(
        '/gld-web/gl/html/book/BookView.html?menu_parameter=' + BOOK_MENU_PARAMETER +
          '&menuid=' + encodeURIComponent(resolvedMenuId),
        { credentials: 'include' }
      )
    } catch (error) {}
    const warmups = [
      '/gld-account-server/public/getSession',
      '/gld-account-server/public/getParaValue',
      '/gld-account-server/moduleSetting/getAgencyExpireTime',
      '/gld-account-server/accessControl/getSession',
      '/gld-account-server/public/isParallel',
      '/gld-data-server/BookData/getBookTypeIsPrinting',
      '/gld-account-server/public/getPeriodAllList',
      '/gld-account-server/gl/account/getParamListInfo',
      '/gld-data-server/BookData/getGroupElementList',
      '/gld-account-server/publicElement/getElementListForPage',
      '/gld-account-server/public/getParameter?paramCode=ACC_BOOK_PERIOD&contrastSetId=&contrastModelSetId='
    ]
    for (let index = 0; index < warmups.length; index += 1) {
      await postWarmup(warmups[index])
    }
  }

  function flattenBookTree(nodes) {
    const result = []
    function visit(node) {
      if (!node || typeof node !== 'object') return
      result.push(node)
      const children = Array.isArray(node.children) ? node.children : []
      children.forEach(visit)
    }
    ;(Array.isArray(nodes) ? nodes : []).forEach(visit)
    return result
  }

  async function fetchBalanceBookId() {
    const balanceMenuId = resolveBalanceMenuId()
    if (state.balanceBookId && state.balanceBookMenuId === balanceMenuId) return state.balanceBookId
    await warmupBalanceBookPage(balanceMenuId)
    const payload = await fetchJson(bookApi('BookData/getBookList', balanceMenuId), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ menu_param: 2, flag: false })
    })
    const rows = Array.isArray(payload && payload.data) ? payload.data : []
    const matched = rows.find(function (row) {
      return compactText(row && row.name).indexOf('科目余额表') >= 0 || String(row && row.code || '') === '101'
    })
    if (!matched || !matched.id) throw new Error('未找到科目余额表账簿')
    state.balanceBookId = matched.id
    state.balanceBookMenuId = balanceMenuId
    return matched.id
  }

  function monthEndDate(year, period) {
    const date = new Date(Number(year) || new Date().getFullYear(), Number(period) || 1, 0)
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return y + '-' + m + '-' + d
  }

  async function fetchBalanceRowsForPeriod(period) {
    const bookId = await fetchBalanceBookId()
    const balanceMenuId = state.balanceBookMenuId || resolveBalanceMenuId()
    const baseCondition = {
      moneyType: '0',
      moneyUnit: '0',
      voucherType: '-1',
      summary: '',
      subjecttype: 0,
      startDate: '',
      endDate: '',
      startMonth: String(period),
      endMonth: String(period),
      monthId: String(period),
      voucherState: '-1',
      fmType: 0,
      startBalance: '',
      endBalance: '',
      show_adjust_period: false
    }
    const conditionPayload = await fetchJson(bookApi('BookView/getBookCondition', balanceMenuId), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        cmbBook: bookId,
        conditionObj: baseCondition,
        conditionElement: {},
        bookType: 2,
        contrastSetId: '',
        contrastModelSetId: ''
      })
    })
    const condition = (conditionPayload && conditionPayload.data && conditionPayload.data.condition) || {}
    const checkNodeList = flattenBookTree(conditionPayload && conditionPayload.data && conditionPayload.data.bookTree)
    const year = Number(condition.year || condition.strYear || new Date().getFullYear())
    Object.assign(condition, {
      startMonth: String(period),
      endMonth: String(period),
      monthId: String(period),
      startDate: year + '-' + String(period).padStart(2, '0') + '-01',
      endDate: monthEndDate(year, period),
      page: 1,
      pageRowNum: condition.pageRowNum || 35,
      isSelectAll: true,
      month: true,
      strYear: String(year),
      isExport: false,
      isPrint: false
    })
    if (!condition.setID && condition.session && condition.session.acctSetId) {
      condition.setID = condition.session.acctSetId
    }

    const body = {
      bookCondition: condition,
      cmbBook: bookId,
      pageSize: '50',
      contrastSetId: '',
      contrastModelSetId: '',
      checkNodeList
    }
    try {
      await fetchJson(bookApi('BookView/loadPageCount', balanceMenuId), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(body)
      })
    } catch (error) {}

    const payload = await fetchJson(bookApi('BookView/loadNodeBookAllModel', balanceMenuId), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body)
    })
    const rows = payload && payload.data && Array.isArray(payload.data.dataMapList)
      ? payload.data.dataMapList
      : []
    if (!rows.length) throw new Error(period + '月余额表没有返回数据')
    return rows.map(normalizeBalanceRow).filter(function (row) { return !!row.code })
  }

  function normalizeBalanceRow(raw) {
    return {
      raw: raw || {},
      code: normalizeCode(firstValue(raw, ['code', 'bookBalanceId'])),
      displayCode: normalizeText(firstValue(raw, ['code', 'bookBalanceId'])),
      name: normalizeText(firstValue(raw, ['name'])),
      beginDirection: normalizeText(firstValue(raw, ['yearDirection', 'startDirection'])),
      begin: amount(firstValue(raw, ['remainStartBalance', 'startMoneyStr', 'beginMoneyStr', 'yearMoneyStr'])),
      debit: amount(firstValue(raw, ['debit', 'debite', 'debitMoneyStr', 'debMoneyStr'])),
      credit: amount(firstValue(raw, ['credit', 'creditMoneyStr', 'creMoneyStr'])),
      sumDebit: amount(firstValue(raw, ['sumDebit', 'sumDebite', 'sumDebitMoneyStr', 'debitSumMoneyStr'])),
      sumCredit: amount(firstValue(raw, ['sumCredit', 'sumCreditMoneyStr', 'creditSumMoneyStr'])),
      endDirection: normalizeText(firstValue(raw, ['endDirection'])),
      end: amount(firstValue(raw, ['endMoneyStr', 'endBalance', 'endMoney']))
    }
  }

  function voucherDetailsForPeriod(monthResults, period, cumulative) {
    const output = []
    monthResults.forEach(function (monthResult) {
      if (cumulative ? monthResult.period > period : monthResult.period !== period) return
      ;(monthResult.results || []).forEach(function (result) {
        const voucher = result.voucher || {}
        ;(voucher.details || []).forEach(function (detail) {
          output.push(detail)
        })
      })
    })
    return output
  }

  function sumDetailsBySubjectPrefix(details, subjectCode) {
    return details.reduce(function (sum, detail) {
      const code = normalizeCode(detail.subjectCode)
      if (code !== subjectCode && code.indexOf(subjectCode) !== 0) return sum
      sum.debit += detail.debit
      sum.credit += detail.credit
      return sum
    }, { debit: 0, credit: 0 })
  }

  function shouldCompareBalanceRow(row) {
    return !!row.code && /^[0-9]/.test(row.code)
  }

  function addBalanceIssue(issues, period, level, rule, message, suggestion, row) {
    issues.push({
      period,
      level,
      rule,
      message,
      suggestion: suggestion || '',
      balanceRow: row || null
    })
  }

  function balanceRowByCode(rows, code) {
    var target = normalizeCode(code)
    return (rows || []).find(function (row) {
      return row && row.code === target
    }) || null
  }

  function normalizeBalanceAmountField(field) {
    if (field === 'credit' || field === 'sumDebit' || field === 'sumCredit') return field
    return 'debit'
  }

  function balanceAmountFieldText(field) {
    if (field === 'credit') return '本期贷方发生'
    if (field === 'sumDebit') return '借方累计发生'
    if (field === 'sumCredit') return '贷方累计发生'
    return '本期借方发生'
  }

  function balanceAmountByField(row, field) {
    if (!row) return 0
    var normalized = normalizeBalanceAmountField(field)
    if (normalized === 'credit') return row.credit || 0
    if (normalized === 'sumDebit') return row.sumDebit || 0
    if (normalized === 'sumCredit') return row.sumCredit || 0
    return row.debit || 0
  }

  function balanceSubjectLabel(code, name, row) {
    if (row) return (row.displayCode + ' ' + row.name).trim()
    return (normalizeCode(code) + (name ? ' ' + normalizeText(name) : '')).trim()
  }

  function balanceEquationRules() {
    return configuredRules().filter(function (rule) {
      return rule.type === 'balance-equation'
    })
  }

  function checkBalanceEquationRules(period, rows, issues) {
    balanceEquationRules().forEach(function (rule) {
      var sourceCode = normalizeCode(rule.sourceCode)
      var sourceFields = Array.isArray(rule.sourceFields) ? rule.sourceFields.map(normalizeBalanceAmountField) : ['debit']
      var targetSubjects = Array.isArray(rule.targetSubjects) ? rule.targetSubjects : []
      var ruleName = normalizeText(rule.name) || '余额表科目勾稽'
      if (!sourceCode || !sourceFields.length || !targetSubjects.length) return

      var sourceRow = balanceRowByCode(rows, sourceCode)
      var targetParts = targetSubjects.map(function (item) {
        var code = normalizeCode(item && item.code)
        var row = balanceRowByCode(rows, code)
        var field = normalizeBalanceAmountField(item && item.field)
        return {
          code: code,
          name: normalizeText(item && item.name),
          row: row,
          field: field,
          amount: balanceAmountByField(row, field)
        }
      }).filter(function (item) {
        return !!item.code
      })
      if (!targetParts.length) return

      var targetTotal = targetParts.reduce(function (sum, item) {
        return sum + item.amount
      }, 0)
      var sourceAmounts = sourceFields.map(function (field) {
        return {
          field: field,
          amount: balanceAmountByField(sourceRow, field)
        }
      })
      var hasActivity = Math.abs(targetTotal) > 0.01 ||
        sourceAmounts.some(function (item) { return Math.abs(item.amount) > 0.01 }) ||
        targetParts.some(function (item) { return Math.abs(item.amount) > 0.01 })
      if (!hasActivity) return

      var mismatched = sourceAmounts.filter(function (item) {
        return Math.abs(item.amount - targetTotal) > 0.01
      })
      if (!mismatched.length) return

      var sourceLabel = balanceSubjectLabel(sourceCode, rule.sourceName, sourceRow)
      var sourceText = sourceAmounts.map(function (item) {
        return balanceAmountFieldText(item.field) + ' ' + formatMoney(item.amount)
      }).join('、')
      var targetText = targetParts.map(function (item) {
        var label = balanceSubjectLabel(item.code, item.name, item.row)
        return label + ' ' + balanceAmountFieldText(item.field) + ' ' +
          (item.row ? formatMoney(item.amount) : '未找到')
      }).join(' + ')
      addBalanceIssue(
        issues,
        period,
        ruleLevel(rule),
        ruleName,
        sourceLabel + ' ' + sourceText + '；目标合计 ' + formatMoney(targetTotal) + '（' + targetText + '）。',
        normalizeText(rule.suggestion) || '请核对余额表相关科目的本期发生额勾稽关系。',
        sourceRow
      )
    })
  }

  function checkBalanceRows(period, rows, monthResults) {
    const issues = []
    const monthDetails = voucherDetailsForPeriod(monthResults, period, false)
    const cumulativeDetails = voucherDetailsForPeriod(monthResults, period, true)
    rows.filter(shouldCompareBalanceRow).forEach(function (row) {
      const monthSum = sumDetailsBySubjectPrefix(monthDetails, row.code)
      const cumulativeSum = sumDetailsBySubjectPrefix(cumulativeDetails, row.code)
      if (Math.abs(row.debit - monthSum.debit) > 0.01 || Math.abs(row.credit - monthSum.credit) > 0.01) {
        addBalanceIssue(
          issues,
          period,
          'error',
          '余额表本期发生',
          row.displayCode + ' ' + row.name + '：余额表本期借方 ' + formatMoney(row.debit) +
            '、贷方 ' + formatMoney(row.credit) + '；凭证汇总借方 ' + formatMoney(monthSum.debit) +
            '、贷方 ' + formatMoney(monthSum.credit) + '。',
          '请核对该月凭证是否遗漏、作废、未记账，或余额表月份条件是否一致。',
          row
        )
      }
      if ((row.sumDebit || row.sumCredit) &&
        (Math.abs(row.sumDebit - cumulativeSum.debit) > 0.01 || Math.abs(row.sumCredit - cumulativeSum.credit) > 0.01)) {
        addBalanceIssue(
          issues,
          period,
          'error',
          '余额表累计发生',
          row.displayCode + ' ' + row.name + '：余额表累计借方 ' + formatMoney(row.sumDebit) +
            '、累计贷方 ' + formatMoney(row.sumCredit) + '；凭证累计借方 ' + formatMoney(cumulativeSum.debit) +
            '、累计贷方 ' + formatMoney(cumulativeSum.credit) + '。',
          '请核对 1 月至本月凭证汇总与余额表累计发生是否一致。',
          row
        )
      }
      if (row.endDirection) {
        const calcEnd = row.endDirection === '贷'
          ? row.begin - row.debit + row.credit
          : row.begin + row.debit - row.credit
        if (Math.abs(calcEnd - row.end) > 0.01) {
          addBalanceIssue(
            issues,
            period,
            'error',
            '余额表期末余额',
            row.displayCode + ' ' + row.name + '：按期初和本期发生计算期末应为 ' +
              formatMoney(calcEnd) + '，余额表为 ' + formatMoney(row.end) + '。',
            '请核对余额表方向、期初余额和本期发生额。',
            row
          )
        }
      }
    })
    checkBalanceEquationRules(period, rows, issues)
    return issues
  }

  async function checkClosedPeriodsAccounting() {
    const periods = completedPeriods()
    if (!periods.length) throw new Error('当前月份没有已结束月份可检查。')

    const monthResults = []
    for (let p = 0; p < periods.length; p += 1) {
      const period = periods[p]
      let rows = []
      try {
        rows = await fetchVoucherRowsForPeriod(period)
      } catch (error) {
        rows = cachedVoucherRowsForPeriod(period)
        if (!rows.length) throw error
      }

      const results = []
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        const id = normalizeText(firstValue(row, ['id', 'voucher_id']))
        renderLoading('正在检查 ' + period + ' 月凭证：' + (i + 1) + '/' + rows.length)
        try {
          const voucher = await fetchVoucherById(id, row)
          results.push(checkVoucher(voucher))
        } catch (error) {
          const voucher = fallbackVoucherFromRow(row, period)
          results.push({
            voucher,
            issues: [{
              level: 'error',
              rule: '读取凭证',
              message: titleOf(voucher) + '读取失败：' + (error && error.message ? error.message : String(error || '未知错误')),
              suggestion: '请打开该凭证确认页面可正常读取后再试。',
              detail: ''
            }],
            debitTotal: 0,
            creditTotal: 0
          })
        }
      }
      monthResults.push({ period, rows, results, balanceRows: [], balanceIssues: [] })
    }

    for (let p = 0; p < monthResults.length; p += 1) {
      const monthResult = monthResults[p]
      renderLoading('正在检查 ' + monthResult.period + ' 月余额表...')
      try {
        monthResult.balanceRows = await fetchBalanceRowsForPeriod(monthResult.period)
        monthResult.balanceIssues = checkBalanceRows(monthResult.period, monthResult.balanceRows, monthResults)
      } catch (error) {
        monthResult.balanceIssues = [{
          period: monthResult.period,
          level: 'error',
          rule: '读取余额表',
          message: monthResult.period + '月余额表读取失败：' + (error && error.message ? error.message : String(error || '未知错误')),
          suggestion: '请先打开一次“账簿查询-余额表”，再回到凭证页重新点账务检查；系统会优先使用已打开余额表页签的接口参数。',
          balanceRow: null
        }]
      }
    }

    return { periods, monthResults }
  }

  function readSelectedVoucherRow() {
    try {
      const jq = window.jQuery || window.$
      if (jq && jq.fn && jq.fn.datagrid) {
        const grid = jq('#dg')
        if (grid && grid.length) {
          const selected = grid.datagrid('getSelected')
          if (selected) return selected
          const rows = grid.datagrid('getRows') || []
          if (rows.length === 1) return rows[0]
        }
      }
    } catch (error) {}

    const selectedRow = document.querySelector('tr.datagrid-row-selected, tr.datagrid-row-checked')
    if (!selectedRow) return null
    const row = {}
    const cells = selectedRow.querySelectorAll('td[field]')
    cells.forEach(function (cell) {
      const key = cell.getAttribute('field')
      if (!key) return
      row[key] = normalizeText(cell.innerText || cell.textContent || '')
    })
    return Object.keys(row).length ? row : null
  }

  function matchListRow(selected) {
    if (!selected) return null
    const selectedId = normalizeText(firstValue(selected, ['id', 'voucher_id']))
    if (selectedId) return selected
    const selectedSummary = compactText(firstValue(selected, ['summary']))
    const selectedNo = compactText(firstValue(selected, ['no', 'voucher_no', 'vou_no']))
    const selectedType = compactText(firstValue(selected, ['voucherTypeName', 'acct_voucher_type']))
    const selectedDebit = amount(firstValue(selected, ['dr_amt', 'deb_money', 'sum_money']))
    const selectedCredit = amount(firstValue(selected, ['cr_amt', 'cre_money', 'sum_money']))

    for (let i = 0; i < state.voucherLists.length; i += 1) {
      const rows = state.voucherLists[i]
      for (let j = 0; j < rows.length; j += 1) {
        const row = rows[j]
        const id = normalizeText(firstValue(row, ['id', 'voucher_id']))
        if (!id) continue
        const rowSummary = compactText(firstValue(row, ['summary']))
        const rowNo = compactText(firstValue(row, ['no', 'voucher_no', 'vou_no']))
        const rowType = compactText(firstValue(row, ['voucherTypeName', 'acct_voucher_type']))
        const rowDebit = amount(firstValue(row, ['dr_amt', 'deb_money', 'sum_money']))
        const rowCredit = amount(firstValue(row, ['cr_amt', 'cre_money', 'sum_money']))
        if (selectedNo && rowNo && selectedNo !== rowNo) continue
        if (selectedType && rowType && selectedType !== rowType) continue
        if (selectedSummary && rowSummary && selectedSummary !== rowSummary) continue
        if (selectedDebit && rowDebit && Math.abs(selectedDebit - rowDebit) > 0.005) continue
        if (selectedCredit && rowCredit && Math.abs(selectedCredit - rowCredit) > 0.005) continue
        return row
      }
    }
    return null
  }

  function resolveLastVoucherBySelected(selected) {
    if (!state.lastVoucher) return null
    if (!selected) return state.lastVoucher
    const selectedNo = compactText(firstValue(selected, ['no', 'voucher_no', 'vou_no']))
    const selectedSummary = compactText(firstValue(selected, ['summary']))
    const lastNo = compactText(state.lastVoucher.no)
    const lastSummary = compactText(state.lastVoucher.summary)
    if (selectedNo && lastNo && selectedNo !== lastNo) return null
    if (selectedSummary && lastSummary && selectedSummary !== lastSummary) return null
    return state.lastVoucher
  }

  async function readCurrentVoucher() {
    const selected = readSelectedVoucherRow()
    const selectedId = normalizeText(firstValue(selected, ['id', 'voucher_id']))
    if (selectedId) return fetchVoucherById(selectedId, selected)

    const matched = matchListRow(selected)
    const matchedId = normalizeText(firstValue(matched, ['id', 'voucher_id']))
    if (matchedId) return fetchVoucherById(matchedId, matched)

    const cached = resolveLastVoucherBySelected(selected)
    if (cached) return cached

    throw new Error('未能定位当前凭证。请先在左侧凭证列表中点选一张凭证，等待明细显示后再检查。')
  }

  function titleOf(voucher) {
    const parts = []
    if (voucher.period) parts.push(voucher.period + '月')
    if (voucher.type && voucher.no && compactText(voucher.type).indexOf(compactText(voucher.no)) < 0) {
      parts.push(voucher.type + '-' + voucher.no)
    } else if (voucher.type) {
      parts.push(voucher.type)
    } else if (voucher.no) {
      parts.push(voucher.no)
    }
    return parts.join(' ') || '当前凭证'
  }

  function detailLabel(detail) {
    const subject = [detail.subjectCode, detail.subjectName].filter(Boolean).join(' ')
    return '分录' + detail.index + (subject ? '（' + subject + '）' : '')
  }

  function isTransferVoucher(voucher) {
    const type = compactText(voucher.type || voucher.no || '')
    return type.indexOf('转账') >= 0
  }

  function isFixedAssetDetail(detail) {
    const code = detail.subjectCode
    return FIXED_ASSET_PREFIXES.some(function (prefix) {
      return code.indexOf(prefix) === 0
    })
  }

  function isBudgetExpenseDetail(detail) {
    const code = detail.subjectCode
    const debitBgtCode = normalizeCode(firstValue(detail.raw, ['debit_bgt_as_code', 'bgt_as_code']))
    return code.indexOf('720') === 0 || debitBgtCode.indexOf('720') === 0
  }

  function isBudgetRevenueDetail(detail) {
    const code = detail.subjectCode
    const creditBgtCode = normalizeCode(firstValue(detail.raw, ['credit_bgt_as_code', 'bgt_as_code']))
    return code.indexOf('660') === 0 || creditBgtCode.indexOf('660') === 0
  }

  function voucherKeywordText(voucher) {
    const parts = [voucher.summary || '']
    ;(voucher.details || []).forEach(function (detail) {
      parts.push(detail.summary || '')
      parts.push(detail.assistantSummary || '')
      parts.push(detail.subjectName || '')
    })
    return compactText(parts.join(' '))
  }

  function hasAnyKeyword(text, keywords) {
    return keywords.some(function (keyword) {
      return text.indexOf(keyword) >= 0
    })
  }

  function subjectMatches(detail, code) {
    const target = normalizeCode(code)
    const subjectCode = normalizeCode(detail.subjectCode)
    const debitBgtCode = normalizeCode(firstValue(detail.raw, ['debit_bgt_as_code', 'bgt_as_code']))
    const creditBgtCode = normalizeCode(firstValue(detail.raw, ['credit_bgt_as_code']))
    return subjectCode === target || debitBgtCode === target || creditBgtCode === target
  }

  function ruleLevel(rule) {
    return rule && rule.level === 'error' ? 'error' : 'warn'
  }

  function configuredRules() {
    var library = OPTIONS.ruleLibrary || {}
    return Array.isArray(library.rules) ? library.rules.filter(function (rule) {
      return rule && rule.enabled !== false
    }) : []
  }

  function requiredSubjectLabel(item) {
    return normalizeCode(item && item.code) + (item && item.name ? ' ' + normalizeText(item.name) : '')
  }

  function detailMatchesDirection(detail, direction) {
    if (direction === 'debit') return detail.debit > 0
    if (direction === 'credit') return detail.credit > 0
    return true
  }

  function requireBudgetEcoCodeByRule(issues, voucher, rule) {
    var keywords = Array.isArray(rule.keywords) ? rule.keywords.map(normalizeText).filter(Boolean) : []
    var expectedCode = normalizeCode(rule.expectedEcoCode)
    var expectedName = normalizeText(rule.expectedEcoName)
    var ruleName = normalizeText(rule.name) || '部门支出经济分类'
    if (!keywords.length || !expectedCode) return
    const text = voucherKeywordText(voucher)
    if (!hasAnyKeyword(text, keywords)) return
    const budgetRows = (voucher.details || []).filter(function (detail) {
      return isBudgetExpenseDetail(detail) && detail.debit > 0
    })
    if (!budgetRows.length) {
      addIssue(
        issues,
        ruleLevel(rule),
        ruleName,
        '摘要包含“' + keywords.join(' / ') + '”，但未找到对应预算支出分录。',
        '请核对是否应有 720 类预算支出分录及部门支出经济分类。'
      )
      return
    }
    budgetRows.forEach(function (detail) {
      if (detail.expEcoCode === expectedCode) return
      addIssue(
        issues,
        ruleLevel(rule),
        ruleName,
        detailLabel(detail) + '部门支出经济分类为 ' + (detail.expEcoCode || '空') +
          (detail.expEcoName ? ' ' + detail.expEcoName : '') + '，应为 ' + expectedCode + ' ' + expectedName + '。',
        normalizeText(rule.suggestion) || ('应修改为' + expectedCode + (expectedName ? ' ' + expectedName : '') + '。')
      )
    })
  }

  function checkSubjectSetByRule(issues, voucher, rule) {
    var keywords = Array.isArray(rule.keywords) ? rule.keywords.map(normalizeText).filter(Boolean) : []
    var requiredSubjects = Array.isArray(rule.requiredSubjects) ? rule.requiredSubjects : []
    var ruleName = normalizeText(rule.name) || '科目组合'
    const text = voucherKeywordText(voucher)
    if (!keywords.length || !hasAnyKeyword(text, keywords)) return
    const details = voucher.details || []
    const missingSubjects = requiredSubjects.filter(function (item) {
      return !details.some(function (detail) {
        return subjectMatches(detail, item.code) && detailMatchesDirection(detail, item.direction)
      })
    })
    if (missingSubjects.length) {
      addIssue(
        issues,
        ruleLevel(rule),
        ruleName,
        '摘要包含“' + keywords.join(' / ') + '”，凭证应包含指定科目，当前缺少：' +
          missingSubjects.map(requiredSubjectLabel).join('、') + '。',
        normalizeText(rule.suggestion) || '请按规则库中的科目组合调整。'
      )
    }

    var expectedBudgetExpenseSubjectCode = normalizeCode(rule.expectedBudgetExpenseSubjectCode)
    details.filter(function (detail) {
      return isBudgetExpenseDetail(detail) && detail.debit > 0
    }).forEach(function (detail) {
      if (!expectedBudgetExpenseSubjectCode || subjectMatches(detail, expectedBudgetExpenseSubjectCode)) return
      addIssue(
        issues,
        ruleLevel(rule),
        ruleName,
        '摘要包含“' + keywords.join(' / ') + '”，预算支出分录应为 ' + expectedBudgetExpenseSubjectCode + '，当前为 ' +
          (detail.subjectCode || '空') + (detail.subjectName ? ' ' + detail.subjectName : '') + '。',
        '应修改为' + expectedBudgetExpenseSubjectCode + '。'
      )
    })

    var expectedBudgetRevenueSubjectCode = normalizeCode(rule.expectedBudgetRevenueSubjectCode)
    details.filter(function (detail) {
      return isBudgetRevenueDetail(detail) && detail.credit > 0
    }).forEach(function (detail) {
      if (!expectedBudgetRevenueSubjectCode || subjectMatches(detail, expectedBudgetRevenueSubjectCode)) return
      addIssue(
        issues,
        ruleLevel(rule),
        ruleName,
        '摘要包含“' + keywords.join(' / ') + '”，预算收入分录应为 ' + expectedBudgetRevenueSubjectCode + '，当前为 ' +
          (detail.subjectCode || '空') + (detail.subjectName ? ' ' + detail.subjectName : '') + '。',
        '应修改为' + expectedBudgetRevenueSubjectCode + '。'
      )
    })
  }

  function startsWithAnyCode(code, prefixes) {
    var normalized = normalizeCode(code)
    return (prefixes || []).some(function (prefix) {
      var p = normalizeCode(prefix)
      return p && normalized.indexOf(p) === 0
    })
  }

  function checkFixedAssetCapitalByRule(issues, voucher, rule) {
    var fixedPrefixes = Array.isArray(rule.fixedAssetPrefixes) ? rule.fixedAssetPrefixes : []
    var budgetPrefixes = Array.isArray(rule.budgetExpensePrefixes) ? rule.budgetExpensePrefixes : ['720']
    var allowedEcoCodes = new Set((Array.isArray(rule.allowedEcoCodes) ? rule.allowedEcoCodes : []).map(normalizeCode).filter(Boolean))
    var ruleName = normalizeText(rule.name) || '固定资产资本性支出'
    if (!fixedPrefixes.length || !allowedEcoCodes.size) return
    var details = voucher.details || []
    var fixedRows = details.filter(function (detail) {
      return startsWithAnyCode(detail.subjectCode, fixedPrefixes)
    })
    if (!fixedRows.length) return

    var fixedDebitTotal = fixedRows.reduce(function (sum, detail) { return sum + detail.debit }, 0)
    var budgetRows = details.filter(function (detail) {
      return isBudgetExpenseDetail(detail) && detail.debit > 0 && startsWithAnyCode(detail.subjectCode, budgetPrefixes)
    })
    var matchedBudgetRows = budgetRows.filter(function (detail) {
      return Math.abs(detail.debit - fixedDebitTotal) <= 0.005
    })
    var rowsToCheck = matchedBudgetRows.length ? matchedBudgetRows : budgetRows
    if (!rowsToCheck.length) {
      addIssue(
        issues,
        ruleLevel(rule),
        ruleName,
        '凭证包含固定资产类科目（' + fixedRows.map(detailLabel).join('、') + '），但未找到对应预算支出分录。',
        '请核对是否应有 720 类预算支出分录及部门支出经济分类。'
      )
      return
    }
    rowsToCheck.forEach(function (detail) {
      if (allowedEcoCodes.has(detail.expEcoCode)) return
      addIssue(
        issues,
        ruleLevel(rule),
        ruleName,
        '凭证包含固定资产类科目，对应预算支出 ' + detailLabel(detail) + ' 的部门支出经济分类为 ' +
          (detail.expEcoCode || '空') + (detail.expEcoName ? ' ' + detail.expEcoName : '') + '，不是 310 类资本性支出。',
        normalizeText(rule.suggestion) || '应修改为310类资本性支出。'
      )
    })
  }

  function applyConfiguredVoucherRules(issues, voucher) {
    configuredRules().forEach(function (rule) {
      if (rule.type === 'keyword-eco') {
        requireBudgetEcoCodeByRule(issues, voucher, rule)
      } else if (rule.type === 'keyword-subject-set') {
        checkSubjectSetByRule(issues, voucher, rule)
      } else if (rule.type === 'fixed-asset-capital') {
        checkFixedAssetCapitalByRule(issues, voucher, rule)
      }
    })
  }

  function addIssue(issues, level, rule, message, suggestion, detail) {
    issues.push({
      level,
      rule,
      message,
      suggestion: suggestion || '',
      detail: detail || ''
    })
  }

  function checkVoucher(voucher) {
    const issues = []
    const details = voucher.details || []
    const debitTotal = details.reduce(function (sum, detail) { return sum + detail.debit }, 0)
    const creditTotal = details.reduce(function (sum, detail) { return sum + detail.credit }, 0)
    const diff = debitTotal - creditTotal

    if (Math.abs(diff) > 0.005) {
      addIssue(
        issues,
        'error',
        '借贷平衡',
        '借方合计 ' + formatMoney(debitTotal) + '，贷方合计 ' + formatMoney(creditTotal) + '，差额 ' + formatMoney(diff),
        '请核对借贷金额。'
      )
    }

    if (!isTransferVoucher(voucher) && voucher.accessoryNum <= 0) {
      addIssue(
        issues,
        'warn',
        '附件张数',
        '附件张数为 0。',
        '转账凭证允许无附件；其他凭证请核对是否漏传附件。'
      )
    }

    details.forEach(function (detail) {
      if (!detail.summary || !detail.assistantSummary) return
      if (compactText(detail.summary) === compactText(detail.assistantSummary)) return
      addIssue(
        issues,
        'warn',
        '辅助摘要',
        detailLabel(detail) + '摘要为“' + detail.summary + '”，辅助摘要为“' + detail.assistantSummary + '”。',
        '请核对辅助摘要是否需要改成与摘要一致。'
      )
    })

    applyConfiguredVoucherRules(issues, voucher)

    const expectedFunctionCode = normalizeCode(OPTIONS.functionCode)
    const retiredFunctionCode = normalizeCode(OPTIONS.retiredFunctionCode || '2210202') || '2210202'
    details.forEach(function (detail) {
      if (!detail.expFuncCode) return
      var isRetiredRentProject = compactText(detail.budgetProjectName).indexOf('退休提租补贴') >= 0
      var targetFunctionCode = isRetiredRentProject ? retiredFunctionCode : expectedFunctionCode
      if (!targetFunctionCode) return
      if (detail.expFuncCode === targetFunctionCode) return
      if (isRetiredRentProject) {
        addIssue(
          issues,
          'warn',
          '支出功能分类',
          detailLabel(detail) + '预算项目为“' + detail.budgetProjectName + '”，支出功能分类为 ' +
            detail.expFuncCode + (detail.expFuncName ? ' ' + detail.expFuncName : '') + '，应为 ' + targetFunctionCode + '。',
          '退休提租补贴必须使用 2210202，不按系统设置中的普通支出功能分类校验。'
        )
      } else {
        addIssue(
          issues,
          'warn',
          '支出功能分类',
          detailLabel(detail) + '支出功能分类为 ' + detail.expFuncCode + (detail.expFuncName ? ' ' + detail.expFuncName : '') + '，系统设置为 ' + expectedFunctionCode + '。',
          '请核对凭证支出功能分类是否选错。'
        )
      }
    })

    return {
      voucher,
      issues,
      debitTotal,
      creditTotal
    }
  }

  function panelStyleText() {
    return [
      'position:fixed',
      'right:18px',
      'top:18px',
      'width:' + CHECK_PANEL_WIDTH + 'px',
      'max-width:calc(100vw - 36px)',
      'max-height:76vh',
      'overflow:auto',
      'background:#fff',
      'border:1px solid #d7dce5',
      'box-shadow:0 12px 32px rgba(15,23,42,.22)',
      'z-index:2147483647',
      'font-size:13px',
      'line-height:1.55',
      'color:#1f2937',
      'border-radius:6px',
      'font-family:Microsoft YaHei,Arial,sans-serif'
    ].join(';')
  }

  function updatePanelToggle() {
    const toggle = document.getElementById('salary-voucher-check-toggle')
    if (!toggle) return
    const panel = document.getElementById('salary-voucher-check-panel')
    toggle.style.display = panel && state.panelHidden ? 'block' : 'none'
  }

  function ensurePanelToggle() {
    let toggle = document.getElementById('salary-voucher-check-toggle')
    if (!toggle) {
      toggle = document.createElement('button')
      toggle.id = 'salary-voucher-check-toggle'
      toggle.type = 'button'
      toggle.innerText = '显示检查结果'
      toggle.style.cssText = [
        'position:fixed',
        'right:18px',
        'top:18px',
        'z-index:2147483647',
        'border:1px solid #dc2626',
        'border-radius:4px',
        'background:#fff',
        'color:#dc2626',
        'font-size:13px',
        'font-weight:700',
        'padding:6px 12px',
        'box-shadow:0 4px 12px rgba(15,23,42,.16)',
        'cursor:pointer',
        'font-family:Microsoft YaHei,Arial,sans-serif'
      ].join(';')
      toggle.onclick = function (event) {
        event.preventDefault()
        event.stopPropagation()
        setPanelVisible(true)
      }
      document.body.appendChild(toggle)
    }
    updatePanelToggle()
    return toggle
  }

  function setPanelVisible(visible) {
    const panel = document.getElementById('salary-voucher-check-panel')
    state.panelHidden = !visible
    if (panel) panel.style.display = visible ? 'block' : 'none'
    ensurePanelToggle()
  }

  function bindPanelHide() {
    const close = document.getElementById('salary-voucher-check-close')
    if (close) {
      close.onclick = function (event) {
        event.preventDefault()
        event.stopPropagation()
        setPanelVisible(false)
      }
    }
  }

  function ensurePanel() {
    let panel = document.getElementById('salary-voucher-check-panel')
    if (!panel) {
      panel = document.createElement('div')
      panel.id = 'salary-voucher-check-panel'
      document.body.appendChild(panel)
    }
    panel.style.cssText = panelStyleText()
    panel.style.display = state.panelHidden ? 'none' : 'block'
    ensurePanelToggle()
    return panel
  }

  function showPanelForRender() {
    state.panelHidden = false
    const panel = ensurePanel()
    panel.style.display = 'block'
    updatePanelToggle()
    return panel
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function renderLoading(message) {
    const panel = showPanelForRender()
    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #edf0f5;background:#f8fafc;">' +
      '<strong>账务检查</strong>' +
      '<button id="salary-voucher-check-close" style="border:1px solid #cbd5e1;background:#fff;border-radius:4px;font-size:12px;line-height:1;cursor:pointer;color:#475569;padding:4px 8px;">隐藏</button>' +
      '</div>' +
      '<div style="padding:14px 16px;color:#475569;">' + escapeHtml(message || '正在读取凭证...') + '</div>'
    bindPanelHide()
  }

  function renderResult(result) {
    const panel = showPanelForRender()
    const issues = result.issues || []
    const errorCount = issues.filter(function (item) { return item.level === 'error' }).length
    const warnCount = issues.filter(function (item) { return item.level !== 'error' }).length
    const statusColor = errorCount ? '#dc2626' : warnCount ? '#d97706' : '#059669'
    const statusText = errorCount
      ? errorCount + ' 个严重问题，' + warnCount + ' 个提醒'
      : warnCount
        ? warnCount + ' 个提醒'
        : '未发现问题'
    const issueHtml = issues.length
      ? issues.map(function (issue) {
          const color = issue.level === 'error' ? '#dc2626' : '#d97706'
          return '<div style="padding:10px 0;border-top:1px solid #eef2f7;">' +
            '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">' +
            '<span style="display:inline-block;min-width:42px;text-align:center;border-radius:999px;color:#fff;background:' + color + ';font-size:12px;padding:1px 6px;">' +
            (issue.level === 'error' ? '严重' : '提醒') + '</span>' +
            '<strong>' + escapeHtml(issue.rule) + '</strong>' +
            '</div>' +
            '<div style="color:#334155;">' + escapeHtml(issue.message) + '</div>' +
            (issue.suggestion ? '<div style="color:#64748b;margin-top:3px;">建议：' + escapeHtml(issue.suggestion) + '</div>' : '') +
            '</div>'
        }).join('')
      : '<div style="padding:14px 0;color:#059669;border-top:1px solid #eef2f7;">当前规则未发现异常。</div>'

    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #edf0f5;background:#f8fafc;">' +
      '<strong>凭证检查</strong>' +
      '<button id="salary-voucher-check-close" style="border:1px solid #cbd5e1;background:#fff;border-radius:4px;font-size:12px;line-height:1;cursor:pointer;color:#475569;padding:4px 8px;">隐藏</button>' +
      '</div>' +
      '<div style="padding:12px 14px;">' +
      '<div style="font-weight:600;margin-bottom:4px;">' + escapeHtml(titleOf(result.voucher)) + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;color:#64748b;margin-bottom:10px;">' +
      '<span>借方 ' + escapeHtml(formatMoney(result.debitTotal)) + '</span>' +
      '<span>贷方 ' + escapeHtml(formatMoney(result.creditTotal)) + '</span>' +
      '<span>附件 ' + escapeHtml(String(result.voucher.accessoryNum || 0)) + '</span>' +
      (OPTIONS.functionCode ? '<span>系统功能分类 ' + escapeHtml(OPTIONS.functionCode) + '</span>' : '') +
      '</div>' +
      '<div style="color:' + statusColor + ';font-weight:700;margin-bottom:4px;">' + escapeHtml(statusText) + '</div>' +
      issueHtml +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
      '<button id="salary-voucher-check-refresh" style="border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:4px;padding:5px 12px;cursor:pointer;">重新检查</button>' +
      '</div>' +
      '</div>'

    bindPanelHide()
    const refresh = document.getElementById('salary-voucher-check-refresh')
    if (refresh) refresh.onclick = startCheck
  }

  function renderBatchResult(batch) {
    const panel = showPanelForRender()
    const results = batch.results || []
    const allIssues = []
    results.forEach(function (result) {
      ;(result.issues || []).forEach(function (issue) {
        allIssues.push({ result: result, issue: issue })
      })
    })
    const errorCount = allIssues.filter(function (item) { return item.issue.level === 'error' }).length
    const warnCount = allIssues.filter(function (item) { return item.issue.level !== 'error' }).length
    const problemVoucherCount = results.filter(function (result) {
      return (result.issues || []).length > 0
    }).length
    const statusColor = errorCount ? '#dc2626' : warnCount ? '#d97706' : '#059669'
    const statusText = errorCount
      ? errorCount + ' 个严重问题，' + warnCount + ' 个提醒'
      : warnCount
        ? warnCount + ' 个提醒'
        : '未发现问题'

    const issueHtml = allIssues.length
      ? allIssues.map(function (item) {
          const issue = item.issue
          const voucher = item.result.voucher
          const color = issue.level === 'error' ? '#dc2626' : '#d97706'
          return '<div style="padding:10px 0;border-top:1px solid #eef2f7;">' +
            '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">' +
            '<span style="display:inline-block;min-width:42px;text-align:center;border-radius:999px;color:#fff;background:' + color + ';font-size:12px;padding:1px 6px;">' +
            (issue.level === 'error' ? '严重' : '提醒') + '</span>' +
            '<strong>' + escapeHtml(titleOf(voucher)) + '</strong>' +
            '<span style="color:#64748b;">' + escapeHtml(issue.rule) + '</span>' +
            '</div>' +
            '<div style="color:#334155;">' + escapeHtml(issue.message) + '</div>' +
            (issue.suggestion ? '<div style="color:#64748b;margin-top:3px;">建议：' + escapeHtml(issue.suggestion) + '</div>' : '') +
            '</div>'
        }).join('')
      : '<div style="padding:14px 0;color:#059669;border-top:1px solid #eef2f7;">当前月份全部凭证未发现异常。</div>'

    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #edf0f5;background:#f8fafc;">' +
      '<strong>本月凭证检查</strong>' +
      '<button id="salary-voucher-check-close" style="border:1px solid #cbd5e1;background:#fff;border-radius:4px;font-size:12px;line-height:1;cursor:pointer;color:#475569;padding:4px 8px;">隐藏</button>' +
      '</div>' +
      '<div style="padding:12px 14px;">' +
      '<div style="font-weight:600;margin-bottom:4px;">' + escapeHtml(batch.period + ' 月全部凭证') + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;color:#64748b;margin-bottom:10px;">' +
      '<span>检查 ' + escapeHtml(String(results.length)) + ' 张凭证</span>' +
      '<span>异常凭证 ' + escapeHtml(String(problemVoucherCount)) + ' 张</span>' +
      (OPTIONS.functionCode ? '<span>系统功能分类 ' + escapeHtml(OPTIONS.functionCode) + '</span>' : '') +
      '<span>退休功能分类 ' + escapeHtml(OPTIONS.retiredFunctionCode || '2210202') + '</span>' +
      '</div>' +
      '<div style="color:' + statusColor + ';font-weight:700;margin-bottom:4px;">' + escapeHtml(statusText) + '</div>' +
      issueHtml +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
      '<button id="salary-voucher-check-refresh" style="border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:4px;padding:5px 12px;cursor:pointer;">重新检查本月</button>' +
      '</div>' +
      '</div>'

    bindPanelHide()
    const refresh = document.getElementById('salary-voucher-check-refresh')
    if (refresh) refresh.onclick = startCheck
  }

  function renderAccountingResult(report) {
    const panel = showPanelForRender()
    const monthResults = report.monthResults || []

    function voucherIssuesForMonth(monthResult) {
      const items = []
      ;(monthResult.results || []).forEach(function (result) {
        ;(result.issues || []).forEach(function (issue) {
          items.push({ period: monthResult.period, result: result, issue: issue })
        })
      })
      return items
    }

    function balanceIssuesForMonth(monthResult) {
      return (monthResult.balanceIssues || []).map(function (issue) {
        return { period: monthResult.period, issue: issue }
      })
    }

    const voucherIssues = []
    const balanceIssues = []
    monthResults.forEach(function (monthResult) {
      voucherIssuesForMonth(monthResult).forEach(function (item) { voucherIssues.push(item) })
      balanceIssuesForMonth(monthResult).forEach(function (item) { balanceIssues.push(item) })
    })

    const allIssues = voucherIssues.map(function (item) { return item.issue })
      .concat(balanceIssues.map(function (item) { return item.issue }))
    const errorCount = allIssues.filter(function (item) { return item.level === 'error' }).length
    const warnCount = allIssues.filter(function (item) { return item.level !== 'error' }).length
    const voucherCount = monthResults.reduce(function (sum, monthResult) {
      return sum + ((monthResult.results || []).length)
    }, 0)
    const problemVoucherCount = monthResults.reduce(function (sum, monthResult) {
      return sum + (monthResult.results || []).filter(function (result) {
        return (result.issues || []).length > 0
      }).length
    }, 0)
    const balanceMonthCount = monthResults.filter(function (monthResult) {
      return (monthResult.balanceRows || []).length > 0
    }).length
    const periodText = (report.periods || []).map(function (period) { return period + '月' }).join('、')
    const statusColor = errorCount ? '#dc2626' : warnCount ? '#d97706' : '#059669'
    const statusText = errorCount
      ? errorCount + ' 个严重问题，' + warnCount + ' 个提醒'
      : warnCount
        ? warnCount + ' 个提醒'
        : '未发现问题'

    function badge(issue) {
      const color = issue.level === 'error' ? '#dc2626' : '#d97706'
      return '<span style="display:inline-block;min-width:42px;text-align:center;border-radius:999px;color:#fff;background:' + color + ';font-size:12px;padding:1px 6px;">' +
        (issue.level === 'error' ? '严重' : '提醒') + '</span>'
    }

    function issueItemHtml(item, type) {
      const issue = item.issue
      const voucher = item.result && item.result.voucher ? item.result.voucher : {}
      const title = type === 'balance' ? item.period + '月 余额表' : item.period + '月 ' + titleOf(voucher)
      return '<div style="padding:10px 0;border-top:1px solid #eef2f7;">' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">' +
        badge(issue) +
        '<strong>' + escapeHtml(title) + '</strong>' +
        '<span style="color:#64748b;">' + escapeHtml(issue.rule) + '</span>' +
        '</div>' +
        '<div style="color:#334155;">' + escapeHtml(issue.message) + '</div>' +
        (issue.suggestion ? '<div style="color:#64748b;margin-top:3px;">建议：' + escapeHtml(issue.suggestion) + '</div>' : '') +
        '</div>'
    }

    function sectionHtml(title, items, type, emptyText) {
      const content = items.length
        ? items.map(function (item) { return issueItemHtml(item, type) }).join('')
        : '<div style="padding:10px 0;color:#059669;border-top:1px solid #eef2f7;">' + escapeHtml(emptyText) + '</div>'
      return '<div style="font-weight:700;margin-top:12px;">' + escapeHtml(title) + '</div>' + content
    }

    const activeMonthResult = monthResults.find(function (monthResult) {
      return voucherIssuesForMonth(monthResult).length + balanceIssuesForMonth(monthResult).length > 0
    }) || monthResults[0] || { period: '' }
    const activePeriod = String(activeMonthResult.period || '')
    const tabHtml = monthResults.map(function (monthResult) {
      const period = String(monthResult.period)
      const issueCount = voucherIssuesForMonth(monthResult).length + balanceIssuesForMonth(monthResult).length
      return '<button type="button" data-check-month-tab="' + escapeHtml(period) + '" style="border:1px solid #cbd5e1;background:#f8fafc;color:#334155;border-radius:4px;padding:4px 9px;cursor:pointer;font-size:13px;">' +
        escapeHtml(period + '月') + (issueCount ? '<span style="margin-left:4px;">(' + escapeHtml(String(issueCount)) + ')</span>' : '') +
        '</button>'
    }).join('')
    const monthPaneHtml = monthResults.map(function (monthResult) {
      const period = String(monthResult.period)
      const monthVoucherIssues = voucherIssuesForMonth(monthResult)
      const monthBalanceIssues = balanceIssuesForMonth(monthResult)
      const monthVoucherCount = (monthResult.results || []).length
      const monthProblemVoucherCount = (monthResult.results || []).filter(function (result) {
        return (result.issues || []).length > 0
      }).length
      const monthBalanceCount = (monthResult.balanceRows || []).length
      return '<div data-check-month-pane="' + escapeHtml(period) + '" style="display:' + (period === activePeriod ? 'block' : 'none') + ';">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;color:#64748b;margin:8px 0 4px;">' +
        '<span>' + escapeHtml(period) + '月凭证 ' + escapeHtml(String(monthVoucherCount)) + ' 张</span>' +
        '<span>异常凭证 ' + escapeHtml(String(monthProblemVoucherCount)) + ' 张</span>' +
        '<span>余额表科目 ' + escapeHtml(String(monthBalanceCount)) + ' 条</span>' +
        '</div>' +
        sectionHtml('凭证规则问题', monthVoucherIssues, 'voucher', '本月凭证规则未发现异常。') +
        sectionHtml('余额表一致性问题', monthBalanceIssues, 'balance', '本月余额表与凭证汇总未发现异常。') +
        '</div>'
    }).join('')

    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #edf0f5;background:#f8fafc;">' +
      '<strong>账务检查</strong>' +
      '<button id="salary-voucher-check-close" style="border:1px solid #cbd5e1;background:#fff;border-radius:4px;font-size:12px;line-height:1;cursor:pointer;color:#475569;padding:4px 8px;">隐藏</button>' +
      '</div>' +
      '<div style="padding:12px 14px;">' +
      '<div style="font-weight:600;margin-bottom:4px;">已结束月份逐月检查</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;color:#64748b;margin-bottom:10px;">' +
      '<span>月份 ' + escapeHtml(periodText || '-') + '</span>' +
      '<span>凭证 ' + escapeHtml(String(voucherCount)) + ' 张</span>' +
      '<span>异常凭证 ' + escapeHtml(String(problemVoucherCount)) + ' 张</span>' +
      '<span>余额表 ' + escapeHtml(String(balanceMonthCount)) + ' 个月</span>' +
      (OPTIONS.functionCode ? '<span>系统功能分类 ' + escapeHtml(OPTIONS.functionCode) + '</span>' : '') +
      '<span>退休功能分类 ' + escapeHtml(OPTIONS.retiredFunctionCode || '2210202') + '</span>' +
      '</div>' +
      '<div style="color:' + statusColor + ';font-weight:700;margin-bottom:10px;">' + escapeHtml(statusText) + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px;">' + tabHtml + '</div>' +
      monthPaneHtml +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">' +
      '<button id="salary-voucher-check-refresh" style="border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:4px;padding:5px 12px;cursor:pointer;">重新检查</button>' +
      '</div>' +
      '</div>'

    bindPanelHide()
    const refresh = document.getElementById('salary-voucher-check-refresh')
    if (refresh) refresh.onclick = startCheck
    function activateMonth(period) {
      const targetPeriod = String(period || '')
      const panes = panel.querySelectorAll('[data-check-month-pane]')
      Array.prototype.forEach.call(panes, function (pane) {
        pane.style.display = pane.getAttribute('data-check-month-pane') === targetPeriod ? 'block' : 'none'
      })
      const tabs = panel.querySelectorAll('[data-check-month-tab]')
      Array.prototype.forEach.call(tabs, function (tab) {
        const active = tab.getAttribute('data-check-month-tab') === targetPeriod
        tab.style.background = active ? '#2563eb' : '#f8fafc'
        tab.style.borderColor = active ? '#2563eb' : '#cbd5e1'
        tab.style.color = active ? '#fff' : '#334155'
      })
    }
    const tabs = panel.querySelectorAll('[data-check-month-tab]')
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.onclick = function () {
        activateMonth(tab.getAttribute('data-check-month-tab'))
      }
    })
    activateMonth(activePeriod)
  }

  function renderError(error) {
    const panel = showPanelForRender()
    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #edf0f5;background:#f8fafc;">' +
      '<strong>账务检查</strong>' +
      '<button id="salary-voucher-check-close" style="border:1px solid #cbd5e1;background:#fff;border-radius:4px;font-size:12px;line-height:1;cursor:pointer;color:#475569;padding:4px 8px;">隐藏</button>' +
      '</div>' +
      '<div style="padding:14px 16px;color:#b91c1c;">' + escapeHtml(error && error.message ? error.message : String(error || '检查失败')) + '</div>'
    bindPanelHide()
  }

  async function startCheck() {
    if (state.running) return
    state.running = true
    renderLoading('正在读取已结束月份凭证列表...')
    try {
      const report = await checkClosedPeriodsAccounting()
      renderAccountingResult(report)
    } catch (error) {
      renderError(error)
    } finally {
      state.running = false
    }
  }

  function isVoucherInputPage(doc) {
    try {
      const href = String(doc.location && doc.location.href || location.href || '')
      if (href.indexOf(VOUCHER_INPUT_PATH) >= 0) return true
      const text = compactText(doc.body && (doc.body.innerText || doc.body.textContent || '')).slice(0, 20000)
      return text.indexOf('凭证号') >= 0 &&
        text.indexOf('附单据') >= 0 &&
        text.indexOf('借方金额') >= 0 &&
        text.indexOf('贷方金额') >= 0
    } catch (error) {
      return false
    }
  }

  function injectButton() {
    if (!document.body || !isVoucherInputPage(document)) return
    if (document.getElementById('salary-voucher-check-btn')) return

    const btn = document.createElement('button')
    btn.id = 'salary-voucher-check-btn'
    btn.type = 'button'
    btn.innerText = '账务检查'
    btn.title = '逐月检查已结束月份凭证和余额表'
    btn.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:18px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'border:1px solid #dc2626',
      'border-radius:4px',
      'background:#fff',
      'color:#dc2626',
      'font-size:14px',
      'font-weight:700',
      'padding:7px 14px',
      'box-shadow:0 4px 12px rgba(15,23,42,.16)',
      'cursor:pointer',
      'font-family:Microsoft YaHei,Arial,sans-serif'
    ].join(';')
    btn.onclick = function (event) {
      event.preventDefault()
      event.stopPropagation()
      startCheck()
    }
    document.body.appendChild(btn)
  }

  patchNetwork()
  window.__salaryVoucherChecker = {
    version: SCRIPT_VERSION,
    options: OPTIONS,
    state,
    injectButton,
    startCheck
  }
  window.addEventListener('load', injectButton)
  window.__salaryVoucherCheckTimer = window.__salaryVoucherCheckTimer || setInterval(injectButton, 1000)
  injectButton()

  return { ok: true, message: 'installed' }
})()
`
}
