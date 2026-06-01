export type IntegrationPushPreflightAgency = {
  agency_id: string
  agency_code: string
  agency_name: string
}

export type IntegrationPushPreflightUnit = {
  code?: string
  name?: string
}

export type IntegrationPushPreflightOptions = {
  unitFullName?: string
  unitImportCode?: string
  needsSalary?: boolean
  needsInsurance?: boolean
  needsVoucher?: boolean
  insuranceUnits?: IntegrationPushPreflightUnit[]
}

export type IntegrationPushPreflightResult = {
  ok: boolean
  message: string
  details?: string[]
  matchedAgency?: IntegrationPushPreflightAgency
  agencies?: IntegrationPushPreflightAgency[]
}

const SALARY_MENUID = '1fb8071c09c44932a99439096316db28'

export function buildIntegrationPushPreflightScript(
  options: IntegrationPushPreflightOptions
): string {
  return `
;(async function runIntegrationPushPreflight() {
  var OPTIONS = ${JSON.stringify(options)}
  var SALARY_MENUID = ${JSON.stringify(SALARY_MENUID)}

  function normalize(value) {
    return String(value || '').replace(/\\s+/g, '')
  }

  function normalizeCode(value) {
    return String(value || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase()
  }

  function fail(message, details, agencies) {
    return {
      ok: false,
      message: message,
      details: details || [],
      agencies: agencies || []
    }
  }

  function ok(message, details, agency, agencies) {
    return {
      ok: true,
      message: message,
      details: details || [],
      matchedAgency: agency,
      agencies: agencies || []
    }
  }

  async function fetchJson(url, options) {
    var res = await fetch(url, options || { credentials: 'include' })
    var text = await res.text()
    if (!res.ok) {
      return { ok: false, http: res.status, text: text, json: null }
    }
    var trimmed = String(text || '').trim()
    if (trimmed && /^</.test(trimmed)) {
      return { ok: false, http: res.status, text: trimmed.slice(0, 300), json: null, html: true }
    }
    try {
      return { ok: true, http: res.status, text: text, json: trimmed ? JSON.parse(trimmed) : null }
    } catch (error) {
      return { ok: false, http: res.status, text: trimmed.slice(0, 300), json: null }
    }
  }

  async function preheatSalaryContext() {
    try {
      await fetch('/salary-pro-web/grp/salaryNanJ/html/message/salary/salSalaryMain.html?menuid=' + SALARY_MENUID + '&moduleid=' + SALARY_MENUID + '&myMenuid=2020120628491', {
        credentials: 'include'
      })
    } catch (error) {}
    try {
      await fetch('/sal-salary-pro-server/grpSalaryController/getCurrenetSession?menuid=' + SALARY_MENUID, {
        credentials: 'include'
      })
    } catch (error) {}
  }

  async function fetchAgencies() {
    var result = await fetchJson(
      '/sal-query-pro-server/salaryQueryController/getAllAgencyHN?ele_code=Agency&judge=1&menuid=' + SALARY_MENUID,
      { credentials: 'include' }
    )
    if (!result.ok) return { ok: false, reason: '读取单位列表失败 HTTP ' + result.http, agencies: [] }
    var raw = (result.json && result.json.data) || []
    var agencies = raw.map(function (item) {
      return {
        agency_id: String(item.id || item.ID || ''),
        agency_code: String(item.CODE || item.code || ''),
        agency_name: String(item.NAME || item.name || item.CODENAME || '')
      }
    }).filter(function (item) { return !!item.agency_id })
    return { ok: true, agencies: agencies }
  }

  function matchAgency(agencies) {
    var expectedCode = normalizeCode(OPTIONS.unitImportCode)
    var expectedName = normalize(OPTIONS.unitFullName)
    var details = []
    if (!expectedCode && !expectedName) {
      return {
        ok: false,
        message: '系统设置中未填写预算单位编码或单位全称，无法判断一体化单位',
        details: details
      }
    }

    if (expectedCode) {
      var codeMatches = agencies.filter(function (agency) {
        return normalizeCode(agency.agency_code) === expectedCode ||
          normalizeCode(agency.agency_code + agency.agency_name).indexOf(expectedCode) >= 0
      })
      if (codeMatches.length === 1) {
        details.push('单位编码匹配：' + codeMatches[0].agency_code + ' ' + codeMatches[0].agency_name)
        return { ok: true, agency: codeMatches[0], details: details }
      }
      if (codeMatches.length > 1) {
        return {
          ok: false,
          message: '预算单位编码匹配到多个一体化单位，请检查系统设置',
          details: codeMatches.map(function (agency) { return agency.agency_code + ' ' + agency.agency_name })
        }
      }
      details.push('预算单位编码未匹配：' + expectedCode)
    }

    if (expectedName) {
      var nameMatches = agencies.filter(function (agency) {
        var agencyName = normalize(agency.agency_name)
        return agencyName.indexOf(expectedName) >= 0 || expectedName.indexOf(agencyName) >= 0
      })
      if (nameMatches.length === 1) {
        details.push('单位名称匹配：' + nameMatches[0].agency_code + ' ' + nameMatches[0].agency_name)
        return { ok: true, agency: nameMatches[0], details: details }
      }
      if (nameMatches.length > 1) {
        return {
          ok: false,
          message: '单位名称匹配到多个一体化单位，请把系统设置中的单位全称或预算单位编码填准确',
          details: nameMatches.map(function (agency) { return agency.agency_code + ' ' + agency.agency_name })
        }
      }
      details.push('单位名称未匹配：' + expectedName)
    }

    return {
      ok: false,
      message: '当前一体化账号未匹配到系统设置单位',
      details: details.concat([
        '系统设置：' + [OPTIONS.unitImportCode || '', OPTIONS.unitFullName || ''].filter(Boolean).join(' '),
        '一体化可访问单位：' + agencies.map(function (agency) {
          return agency.agency_code + ' ' + agency.agency_name
        }).join('、')
      ])
    }
  }

  function assertInsuranceUnitsMatch(agency) {
    var units = Array.isArray(OPTIONS.insuranceUnits) ? OPTIONS.insuranceUnits : []
    var details = []
    var bad = []
    for (var i = 0; i < units.length; i++) {
      var unit = units[i] || {}
      var unitCode = normalizeCode(unit.code)
      var unitName = normalize(unit.name)
      var matchedByCode = unitCode && normalizeCode(agency.agency_code) === unitCode
      var agencyName = normalize(agency.agency_name)
      var matchedByName = unitName && (agencyName.indexOf(unitName) >= 0 || unitName.indexOf(agencyName) >= 0)
      if (!matchedByCode && !matchedByName) {
        bad.push([unit.code || '', unit.name || ''].filter(Boolean).join(' '))
      }
    }
    if (bad.length) {
      return {
        ok: false,
        message: '保险导入文件中的单位与一体化匹配单位不一致，已停止推送',
        details: bad.concat(['一体化匹配单位：' + agency.agency_code + ' ' + agency.agency_name])
      }
    }
    if (units.length) details.push('保险导入单位与一体化匹配单位一致')
    return { ok: true, details: details }
  }

  async function assertSalaryModule(agency) {
    if (!OPTIONS.needsSalary) return { ok: true, details: [] }
    var result = await fetchJson('/sal-config-pro-server/salaryBatchController/getBatchAgency?menuid=' + SALARY_MENUID, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ agency_id: agency.agency_id })
    })
    if (!result.ok) {
      return {
        ok: false,
        message: '工资模块检测失败：无法读取工资批次',
        details: ['HTTP ' + result.http]
      }
    }
    var rows = (result.json && result.json.data) || []
    if (!rows.length) {
      return {
        ok: false,
        message: '工资模块检测失败：当前单位没有可用工资批次',
        details: ['单位：' + agency.agency_code + ' ' + agency.agency_name]
      }
    }
    return { ok: true, details: ['工资模块可访问，已读取到 ' + rows.length + ' 个批次'] }
  }

  function textExists(text) {
    var wanted = normalize(text)
    function scan(win) {
      try {
        var body = win.document && win.document.body
        if (body && normalize(body.innerText || body.textContent || '').indexOf(wanted) >= 0) return true
        for (var i = 0; i < win.frames.length; i++) {
          if (scan(win.frames[i])) return true
        }
      } catch (error) {}
      return false
    }
    return scan(window.top || window)
  }

  function moduleHints() {
    var hints = []
    if (OPTIONS.needsInsurance) {
      hints.push(textExists('集中支付') ? '集中支付菜单可见' : '未在当前页看到集中支付菜单，后续会自动尝试导航')
    }
    if (OPTIONS.needsVoucher) {
      hints.push(textExists('凭证管理') ? '凭证管理菜单可见' : '未在当前页看到凭证管理菜单，后续会自动尝试导航')
    }
    return hints
  }

  try {
    await preheatSalaryContext()
    var agencyResult = await fetchAgencies()
    if (!agencyResult.ok) {
      return fail('无法读取一体化单位列表，请确认已登录一体化系统，且账号有工资单位权限', [agencyResult.reason])
    }
    if (!agencyResult.agencies.length) {
      await preheatSalaryContext()
      agencyResult = await fetchAgencies()
    }
    if (!agencyResult.ok || !agencyResult.agencies.length) {
      return fail('未读取到一体化可访问单位，请先登录一体化并进入工资模块后再推送', [], agencyResult.agencies || [])
    }

    var agencyMatch = matchAgency(agencyResult.agencies)
    if (!agencyMatch.ok) return fail(agencyMatch.message, agencyMatch.details, agencyResult.agencies)

    var details = ['已登录一体化：读取到 ' + agencyResult.agencies.length + ' 个可访问单位']
      .concat(agencyMatch.details || [])

    var insuranceCheck = assertInsuranceUnitsMatch(agencyMatch.agency)
    if (!insuranceCheck.ok) return fail(insuranceCheck.message, insuranceCheck.details, agencyResult.agencies)
    details = details.concat(insuranceCheck.details || [])

    var salaryCheck = await assertSalaryModule(agencyMatch.agency)
    if (!salaryCheck.ok) return fail(salaryCheck.message, salaryCheck.details, agencyResult.agencies)
    details = details.concat(salaryCheck.details || [])

    details = details.concat(moduleHints())

    return ok('一体化推送前检测通过', details, agencyMatch.agency, agencyResult.agencies)
  } catch (error) {
    return fail('一体化推送前检测失败：' + (error && error.message ? error.message : String(error)))
  }
})()
`
}
