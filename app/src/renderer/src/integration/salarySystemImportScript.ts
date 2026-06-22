type SalarySystemImportMode = 'backpay' | 'salary'

export type SalarySystemImportFile = {
  fileName: string
  base64: string
  size: number
}

type SalarySystemImportScriptOptions = {
  mode: SalarySystemImportMode
  file: SalarySystemImportFile
  filterUnitName?: string
  filterUnitCode?: string
  month?: string
}

const SALARY_MENUID = '1fb8071c09c44932a99439096316db28'

export function buildSalarySystemImportScript(options: SalarySystemImportScriptOptions): string {
  return `
;(async function runSalarySystemImport() {
  var MODE = ${JSON.stringify(options.mode)}
  var FILE_NAME = ${JSON.stringify(options.file.fileName)}
  var BASE64 = ${JSON.stringify(options.file.base64)}
  var FILTER_UNIT_NAME = ${JSON.stringify(options.filterUnitName || '')}
  var FILTER_UNIT_CODE = ${JSON.stringify(options.filterUnitCode || '')}
  var MONTH = ${JSON.stringify(options.month || '')}
  var MENUID = ${JSON.stringify(SALARY_MENUID)}
  var TRACE = []
  var TRACE_T0 = Date.now()

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
  function normalize(value) { return String(value || '').replace(/\\s+/g, '') }
  function normalizeCode(value) { return String(value || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase() }

  function ensureStatus() {
    var el = document.getElementById('salary-system-import-status')
    if (el) return el
    el = document.createElement('div')
    el.id = 'salary-system-import-status'
    el.style.cssText = [
      'position:fixed',
      'top:180px',
      'right:24px',
      'z-index:2147483647',
      'min-width:360px',
      'max-width:620px',
      'padding:14px 18px',
      'border-radius:8px',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)',
      'background:rgba(33,33,33,.92)',
      'color:#fff',
      'font-size:13px',
      'line-height:1.65',
      'white-space:pre-wrap'
    ].join(';')
    document.body.appendChild(el)
    return el
  }

  function status(text, kind) {
    var el = ensureStatus()
    el.textContent = text
    if (kind === 'ok') el.style.background = 'rgba(38,128,80,.95)'
    else if (kind === 'err') el.style.background = 'rgba(180,40,40,.95)'
    else if (kind === 'warn') el.style.background = 'rgba(200,140,0,.95)'
    else el.style.background = 'rgba(33,33,33,.92)'
    console.log('[salary-system-import]', text)
    try { TRACE.push('+' + ((Date.now() - TRACE_T0) / 1000).toFixed(1) + 's ' + text) } catch (e) {}
  }

  function clearStatusLater(ms) {
    setTimeout(function () {
      var el = document.getElementById('salary-system-import-status')
      if (el && el.parentNode) el.parentNode.removeChild(el)
    }, ms || 10000)
  }

  async function preheatSalaryContext() {
    try {
      await fetch('/salary-pro-web/grp/salaryNanJ/html/message/salary/salSalaryMain.html?menuid=' + MENUID + '&moduleid=' + MENUID + '&myMenuid=2020120628491', {
        credentials: 'include'
      })
    } catch (error) {}
  }

  async function fetchJson(url, options) {
    var res = await fetch(url, options || { credentials: 'include' })
    if (!res.ok) throw new Error(url + ' HTTP ' + res.status)
    return await res.json()
  }

  function normalizeAgencyItem(item) {
    item = item || {}
    return {
      agency_id: String(item.id || item.ID || item.agency_id || item.agencyId || ''),
      agency_code: String(item.CODE || item.code || item.agency_code || item.agencyCode || ''),
      agency_name: String(item.NAME || item.name || item.CODENAME || item.agency_name || item.agencyName || '')
    }
  }

  function normalizeSessionAgency(data) {
    if (!data || typeof data !== 'object') return null
    var rawCode = data.agency_code || data.agencyCode || data.orgCode || data.org_code ||
      data.budgetUnitCode || data.unitCode || data.userCode || data.code || ''
    var agency = {
      agency_id: String(data.agency_id || data.agencyId || data.orgId || data.org_id ||
        data.belongOrgId || data.belong_org_id || ''),
      agency_code: String(rawCode || '').replace(/-0101$/i, ''),
      agency_name: String(data.agency_name || data.agencyName || data.orgName || data.org_name ||
        data.unitName || data.name || '')
    }
    return (agency.agency_id || agency.agency_code || agency.agency_name) ? agency : null
  }

  async function fetchSessionAgency() {
    var urls = [
      '/sal-salary-pro-server/grpSalaryController/getCurrenetSession?menuid=' + MENUID,
      '/framework-engin2/userSession/user',
      '/new-framework-engin2/userSession/user?time=' + Date.now()
    ]
    for (var i = 0; i < urls.length; i++) {
      try {
        var json = await fetchJson(urls[i], { credentials: 'include' })
        var data = json && (json.data || json.user || json)
        var agency = normalizeSessionAgency(data)
        if (agency) return agency
      } catch (error) {}
    }
    return null
  }

  async function discoverAgency() {
    var json = await fetchJson(
      '/sal-query-pro-server/salaryQueryController/getAllAgencyHN?ele_code=Agency&judge=1&menuid=' + MENUID,
      { credentials: 'include' }
    )
    var raw = (json && json.data) || []
    var list = raw.map(normalizeAgencyItem).filter(function (item) { return !!item.agency_id })
    if (!list.length) {
      var sessionAgency = await fetchSessionAgency()
      if (sessionAgency && sessionAgency.agency_id) return sessionAgency
      throw new Error('未发现单位选择，且未读取到当前登录单位 agency_id，无法导入工资')
    }
    if (list.length === 1) return list[0]

    var filterCode = normalizeCode(FILTER_UNIT_CODE)
    if (filterCode) {
      var codeMatched = list.filter(function (item) {
        return normalizeCode(item.agency_code) === filterCode ||
          normalizeCode(item.agency_code + item.agency_name).indexOf(filterCode) >= 0
      })
      if (codeMatched.length === 1) return codeMatched[0]
      if (codeMatched.length > 1) throw new Error('预算单位编码匹配到多个单位：' + codeMatched.map(function (x) { return x.agency_code + ' ' + x.agency_name }).join('、'))
    }

    var filter = normalize(FILTER_UNIT_NAME)
    if (filter) {
      var matched = list.filter(function (item) {
        return normalize(item.agency_name).indexOf(filter) >= 0 ||
          normalize(item.agency_code + item.agency_name).indexOf(filter) >= 0
      })
      if (matched.length === 1) return matched[0]
      if (matched.length > 1) throw new Error('匹配到多个单位，请在系统设置中把单位全称填完整：' + matched.map(function (x) { return x.agency_name }).join('、'))
    }
    if (list.length === 1) return list[0]
    throw new Error('当前账号有多个单位，无法自动判断导入单位。请先在系统设置中维护单位全称')
  }

  async function discoverBatch(agencyId) {
    var json = await fetchJson('/sal-config-pro-server/salaryBatchController/getBatchAgency?menuid=' + MENUID, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ agency_id: agencyId })
    })
    var raw = (json && json.data) || []
    var first = raw.find(function (item) { return item && item.salbatch_id && String(item.is_end || '0') !== '1' }) ||
      raw.find(function (item) { return item && item.salbatch_id })
    if (!first) throw new Error('未读取到工资批次')
    return String(first.salbatch_id)
  }

  function fileFromBase64() {
    if (!BASE64) throw new Error('导入文件为空')
    var binary = atob(BASE64)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    var blob = new Blob([bytes], { type: 'application/vnd.ms-excel' })
    try {
      return new File([blob], FILE_NAME, { type: blob.type })
    } catch (error) {
      blob.name = FILE_NAME
      return blob
    }
  }

  function isOkResponse(json) {
    if (!json) return false
    if (json && json.__httpOk === false) return false
    var code = json && json.status_code != null ? String(json.status_code) : ''
    if (!code) return json.success !== false && json.ok !== false
    return code === '1000' || code === '1001' || code === '0000' || code === '200'
  }

  async function postImport(url, fieldName, file) {
    var data = new FormData()
    data.append(fieldName, file, FILE_NAME)
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest'
      },
      body: data
    })
    var responseText = await res.text()
    var json = null
    try { json = responseText ? JSON.parse(responseText) : null } catch (error) {}
    if (!res.ok) {
      return {
        __httpOk: false,
        __fieldName: fieldName,
        __httpStatus: res.status,
        __text: responseText,
        reason: '上传接口 HTTP ' + res.status
      }
    }
    if (!json && /^\\s*</.test(responseText || '')) {
      return {
        __httpOk: false,
        __fieldName: fieldName,
        __text: responseText,
        reason: '上传接口返回了页面内容，不是导入结果。请确认一体化登录未失效，并停在工资导入页面。'
      }
    }
    return json || { __httpOk: true, __fieldName: fieldName, status_code: '1000', reason: '接口未返回 JSON，HTTP 已成功' }
  }

  async function uploadWithFallback(url, file) {
    var fieldNames = ['ImportFile', 'file', 'fbk', 'importFile', 'uploadFile', 'excelFile']
    var failures = []
    for (var i = 0; i < fieldNames.length; i++) {
      var fieldName = fieldNames[i]
      status('尝试上传字段：' + fieldName + '\\n接口：' + url)
      var result = await postImport(url, fieldName, file)
      if (isOkResponse(result)) return result
      if (isBusinessFailureResponse(result)) throw new Error(responseReason(result))
      failures.push(fieldName + ' => ' + responseReason(result))
    }
    throw new Error('所有上传字段均失败：\\n' + failures.join('\\n'))
  }

  function isBusinessFailureResponse(json) {
    if (!json || json.__httpOk === false) return false
    if (json.__fieldName && json.__fieldName !== 'ImportFile') return false
    return json.status_code != null || json.reason != null || json.message != null || json.data != null
  }

  function responseReason(json) {
    if (!json) return ''
    var pieces = []
    if (json.__fieldName) pieces.push('字段 ' + json.__fieldName)
    if (json.__httpStatus) pieces.push('HTTP ' + json.__httpStatus)
    var reason = String(json.reason || json.message || json.detail || json.data || '')
    if (reason) pieces.push(reason)
    var responseText = String(json.__text || '').trim()
    if (responseText && responseText !== reason) pieces.push(responseText.slice(0, 500))
    return pieces.join('；') || JSON.stringify(json)
  }

  try {
    status('准备工资系统导入：' + (MODE === 'backpay' ? '补发工资' : '工资变动') + '\\n文件：' + FILE_NAME)
    await preheatSalaryContext()
    await sleep(300)
    var agency = await discoverAgency()
    var batchId = await discoverBatch(agency.agency_id)
    var file = fileFromBase64()
    var url
    if (MODE === 'backpay') {
      url = '/sal-salary-pro-server/AddSalExcelController/imp_jsbfExcel?menuid=' + MENUID +
        '&agency_id=' + encodeURIComponent(agency.agency_id) +
        '&salbatch_id=' + encodeURIComponent(batchId) +
        '&importFile=' + encodeURIComponent(FILE_NAME)
    } else {
      if (!MONTH) throw new Error('工资导入缺少月份')
      url = '/sal-salary-pro-server/SalExcelController/sal_imp?menuid=' + MENUID +
        '&impType=2&impAgencyId=' + encodeURIComponent(agency.agency_id) +
        '&month=' + encodeURIComponent(MONTH) +
        '&salbatch_id=' + encodeURIComponent(batchId)
    }

    status('上传中...\\n单位：' + agency.agency_name + '\\n批次：' + batchId + (MODE === 'salary' ? '\\n月份：' + MONTH : ''))
    var result = await uploadWithFallback(url, file)
    if (!isOkResponse(result)) throw new Error(result && (result.reason || result.message || result.detail) || JSON.stringify(result))

    status('导入成功：' + (result && (result.data || result.reason || result.message) || FILE_NAME), 'ok')
    clearStatusLater(10000)
    return { ok: true, response: result, agency: agency, batchId: batchId, trace: TRACE, traceText: TRACE.join('\\n') }
  } catch (error) {
    var message = error && error.message ? error.message : String(error)
    status('导入失败：' + message, 'err')
    clearStatusLater(15000)
    return { ok: false, message: message, trace: TRACE, traceText: TRACE.join('\\n') }
  }
})()
`
}
