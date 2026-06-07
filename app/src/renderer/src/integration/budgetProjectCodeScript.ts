export type BudgetProjectCodeResult =
  | {
      ok: true
      activeCode: string
      activeName: string
      retiredCode: string
      retiredName: string
      total: number
    }
  | {
      ok: false
      message: string
      total?: number
      availableNames?: string[]
    }

/**
 * 从一体化当前登录态读取预算项目基础资料。
 * 采集包确认接口为 getBaseInfoListInside + eleCode=DEP_PRO。
 */
export function buildBudgetProjectCodeScript(): string {
  return `
;(async function resolveBudgetProjectCodes() {
  const URL = '/gld-account-server/baseInfo/getBaseInfoListInside?menuid=457cadeb5cd643c0bb946dfb6d23f971'
  const BASE_INFO_URL = '/gld-web/gl/html/common/BaseInfo.html?menuid=457cadeb5cd643c0bb946dfb6d23f971'
  const ACTIVE_NAMES = ['事业人员工资']
  const RETIRED_NAMES = ['退休提租补贴', '退休人员提租补贴']

  function text(value) {
    return String(value == null ? '' : value).replace(/\\s+/g, '').trim()
  }

  function codeOf(row) {
    return text(row && (row.code || row.code1 || row.in_code))
  }

  function rowName(row) {
    return text(row && (row.name || row.codename))
  }

  function pick(rows, names) {
    for (var ni = 0; ni < names.length; ni++) {
      var want = text(names[ni])
      var exact = rows.find(function (row) { return rowName(row) === want && codeOf(row) })
      if (exact) return exact
    }
    for (var ni2 = 0; ni2 < names.length; ni2++) {
      var keyword = text(names[ni2])
      var fuzzy = rows.find(function (row) { return rowName(row).indexOf(keyword) >= 0 && codeOf(row) })
      if (fuzzy) return fuzzy
    }
    return null
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = controller
      ? setTimeout(function () { controller.abort() }, timeoutMs)
      : null
    try {
      return await fetch(url, Object.assign({}, options || {}, controller ? { signal: controller.signal } : {}))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    try {
      await fetchWithTimeout(BASE_INFO_URL, { credentials: 'include' }, 3000)
    } catch (preheatError) {}

    const res = await fetchWithTimeout(URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body: 'eleCode=DEP_PRO'
    }, 10000)
    if (!res.ok) {
      return { ok: false, message: '读取预算项目失败：HTTP ' + res.status }
    }
    const contentType = String(res.headers && res.headers.get ? res.headers.get('content-type') : '')
    if (contentType && contentType.indexOf('json') < 0) {
      return { ok: false, message: '一体化返回的不是预算项目数据，请先登录 0101 业务账号后再点自动填入' }
    }
    const json = await res.json()
    const rows = Array.isArray(json && json.data) ? json.data : []
    if (!rows.length) {
      return { ok: false, message: '一体化没有返回预算项目列表，请确认 0101 业务账号已登录', total: 0 }
    }

    const active = pick(rows, ACTIVE_NAMES)
    const retired = pick(rows, RETIRED_NAMES)
    if (!active || !retired) {
      const availableNames = rows.map(rowName).filter(Boolean).slice(0, 80)
      return {
        ok: false,
        message:
          '未找到' +
          (!active ? '“事业人员工资”' : '') +
          (!active && !retired ? '、' : '') +
          (!retired ? '“退休提租补贴”' : '') +
          '对应的预算项目',
        total: rows.length,
        availableNames: availableNames
      }
    }

    return {
      ok: true,
      activeCode: codeOf(active),
      activeName: rowName(active),
      retiredCode: codeOf(retired),
      retiredName: rowName(retired),
      total: rows.length
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return {
        ok: false,
        message: '读取预算项目接口超时，请确认 0101 账号已登录且一体化页面可正常访问'
      }
    }
    return {
      ok: false,
      message: error && error.message ? error.message : String(error)
    }
  }
})();
`
}
