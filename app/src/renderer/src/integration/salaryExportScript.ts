export type SalaryExportSaltypeInput = {
  saltype_id: string
  saltype_name: string
  onlyFirstBatch?: boolean
}

type SalaryExportScriptOptions = {
  /** 工资模块固定 menuid（来自抓包） */
  menuid?: string
  /** 月份；为空则用当前月 */
  month?: string
  /** 要遍历的工资类别列表；单位 + 批次都在脚本运行时自动发现 */
  saltypes: SalaryExportSaltypeInput[]
  /** 单位过滤名：只导出 agency_name 包含这个字符串的单位；为空则全导 */
  filterUnitName?: string
  /** 预算单位编码：多单位账号下优先用编码精确定位单位 */
  filterUnitCode?: string
}

/**
 * 工资导出注入脚本（v5：三维自动发现 agency × saltype × batch）
 *
 * 服务端真实数据模型（来自完整录制分析）：
 *   - 一个登录账号可以管理多个 agency（单位）—— 经 getAllAgencyHN 返回
 *   - 一个 agency 有一组 batch（批次）—— 经 getBatchAgency 返回，body 必须带 agency_id
 *   - saltype（工资类别）正交 batch
 *
 * 注意：cookie 里的 belongOrgId 在某些账号下是 "0"（聚合账号），完全不可信，所以这里不再依赖 cookie。
 *
 * 返回：{ ok, files: [{filename, base64, size, agency, saltype, salbatch}], skipped, failed }
 */
export function buildSalaryExportScript(options: SalaryExportScriptOptions): string {
  const menuid = options.menuid ?? '1fb8071c09c44932a99439096316db28'
  const month = options.month ?? ''
  const saltypes = options.saltypes
  const filterUnitName = options.filterUnitName ?? ''
  const filterUnitCode = options.filterUnitCode ?? ''

  return `
;(async function runSalaryExport() {
  const MENUID = ${JSON.stringify(menuid)}
  const FORCE_MONTH = ${JSON.stringify(month)}
  const SALTYPES = ${JSON.stringify(saltypes)}
  const FILTER_UNIT_NAME = ${JSON.stringify(filterUnitName)}
  const FILTER_UNIT_CODE = ${JSON.stringify(filterUnitCode)}

  const EMPTY_XLS_THRESHOLD = 4096
  const STEP_DELAY = 350

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function normalizeCode(value) { return String(value || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase() }

  function ensureStatus() {
    let el = document.getElementById('salary-export-status')
    if (el) return el
    el = document.createElement('div')
    el.id = 'salary-export-status'
    el.style.cssText = [
      'position:fixed','top:130px','right:24px','min-width:360px','max-width:620px',
      'padding:14px 18px','background:rgba(33,33,33,0.92)','color:#fff',
      'border-radius:8px','font-size:13px','line-height:1.65',
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
    console.log('[salary-export]', text)
  }

  function bytesToBase64(bytes) {
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }

  // -------------------------------------------------------------------------
  // 静默预热：没进过工资模块时服务端不会绑菜单上下文，先 GET 一下工资页 HTML 让它挂上
  // -------------------------------------------------------------------------
  async function preheatSalaryContext() {
    try {
      await fetch(
        '/salary-pro-web/grp/salaryNanJ/html/message/salary/salSalaryMain.html?menuid=' +
          MENUID + '&moduleid=' + MENUID + '&myMenuid=2020120628491',
        { credentials: 'include' }
      )
    } catch (e) {}
    try {
      await fetch(
        '/sal-salary-pro-server/grpSalaryController/getCurrenetSession?menuid=' + MENUID,
        { credentials: 'include' }
      )
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 1) 发现"我能管的所有单位"
  // -------------------------------------------------------------------------
  async function fetchAgencies() {
    const res = await fetch(
      '/sal-query-pro-server/salaryQueryController/getAllAgencyHN?ele_code=Agency&judge=1&menuid=' + MENUID,
      { credentials: 'include' }
    )
    if (!res.ok) return { ok: false, http: res.status, list: [] }
    const j = await res.json()
    const raw = (j && j.data) || []
    const list = raw.map(function (a) {
      return {
        agency_id: String(a.id || a.ID || ''),
        agency_code: String(a.CODE || a.code || ''),
        agency_name: String(a.NAME || a.name || a.CODENAME || '')
      }
    }).filter(function (a) { return !!a.agency_id })
    return { ok: true, list: list }
  }

  async function discoverAgencies() {
    let r = await fetchAgencies()
    if (!r.ok) return { ok: false, reason: 'getAllAgencyHN HTTP ' + r.http }
    if (!r.list.length) {
      status('🔧 单位列表为空，尝试预热菜单上下文...')
      await preheatSalaryContext()
      await sleep(400)
      r = await fetchAgencies()
      if (!r.ok) return { ok: false, reason: 'getAllAgencyHN HTTP ' + r.http + '（预热后仍失败）' }
    }
    return { ok: true, agencies: r.list }
  }

  // -------------------------------------------------------------------------
  // 2) 对每个 agency 发现批次
  // -------------------------------------------------------------------------
  async function discoverBatches(agency_id) {
    const res = await fetch(
      '/sal-config-pro-server/salaryBatchController/getBatchAgency?menuid=' + MENUID,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ agency_id: agency_id })
      }
    )
    if (!res.ok) return { ok: false, http: res.status, batches: [] }
    const j = await res.json()
    const raw = (j && j.data) || []
    const seen = new Set()
    const batches = []
    for (let i = 0; i < raw.length; i++) {
      const id = String(raw[i].salbatch_id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      batches.push({
        salbatch_id: id,
        salbatch_name: '批次' + String(batches.length + 1).padStart(3, '0')
      })
    }
    return { ok: true, batches: batches }
  }

  // -------------------------------------------------------------------------
  // 3) 拉列定义
  // -------------------------------------------------------------------------
  async function loadItemIds(agency_id, saltype_id, salbatch_id) {
    const res = await fetch(
      '/sal-config-pro-server/salSalaryItem/loadSalaryCollection?menuid=' + MENUID,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          agency_id: agency_id,
          saltype_id: saltype_id,
          salbatch_id: salbatch_id
        })
      }
    )
    if (!res.ok) return { ok: false, http: res.status }
    const col = await res.json()
    if (!col.data || !col.data.itemColList || !col.data.itemColList.length) {
      return { ok: false, empty: true }
    }
    return {
      ok: true,
      item_ids: col.data.itemColList.map(function (c) { return String(c.item_id) })
    }
  }

  // -------------------------------------------------------------------------
  // 4) 单组合导出
  // -------------------------------------------------------------------------
  async function exportOneCombo(month, agency, saltype, batch, firstBatchId) {
    let col = await loadItemIds(agency.agency_id, saltype.saltype_id, batch.salbatch_id)
    if (!col.ok && col.http) {
      return { ok: false, skipped: true, reason: 'loadSalaryCollection HTTP ' + col.http }
    }
    if (!col.ok && col.empty && batch.salbatch_id !== firstBatchId) {
      // 列定义复用首批次
      col = await loadItemIds(agency.agency_id, saltype.saltype_id, firstBatchId)
    }
    if (!col.ok) return { ok: false, skipped: true, reason: '无工资项配置' }

    const expRes = await fetch('/sal-salary-pro-server/SalExcelController/expExcelPost', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        impType: 2,
        agencyid: agency.agency_id,
        need_total: false,
        month: month,
        saltypeid: saltype.saltype_id,
        salbatch_id: batch.salbatch_id,
        salDeptId: '0',
        isExpData: true,
        item_ids: col.item_ids,
        name: '', ic_id: '', card_no4: '',
        sfgz1: '', sfgz2: '', yfgz1: '', yfgz2: ''
      })
    })
    if (!expRes.ok) {
      // 5xx 一般表示"该 (单位×类别×批次) 在服务端没数据"，视为静默跳过；
      // 4xx 才算真错（401/403 是权限问题，404 是接口变了），需要给用户看到
      const skipped = expRes.status >= 500
      return { ok: false, skipped: skipped, reason: 'expExcelPost HTTP ' + expRes.status }
    }
    const blob = await expRes.blob()
    if (blob.size < EMPTY_XLS_THRESHOLD) {
      return { ok: false, skipped: true, reason: '该组合没有数据（' + blob.size + ' 字节）' }
    }
    const ab = await blob.arrayBuffer()
    const base64 = bytesToBase64(new Uint8Array(ab))

    function safe(s) { return String(s || '').replace(/[\\\\/:*?"<>|]/g, '_') }
    const filename =
      '工资-' + safe(agency.agency_code) + safe(agency.agency_name) +
      '-' + month + '月-' + safe(saltype.saltype_name) +
      '-' + safe(batch.salbatch_name) + '.xls'

    return {
      ok: true,
      filename: filename,
      base64: base64,
      size: blob.size
    }
  }

  // -------------------------------------------------------------------------
  // 主流程
  // -------------------------------------------------------------------------
  try {
    if (!Array.isArray(SALTYPES) || !SALTYPES.length) {
      throw new Error('未配置任何工资类别，请在"系统设置 → 单位信息 → 一体化工资导出"里维护')
    }

    const MONTH = FORCE_MONTH || String(new Date().getMonth() + 1)

    status('🔍 发现单位列表...')
    const agDisc = await discoverAgencies()
    if (!agDisc.ok) throw new Error('发现单位失败：' + agDisc.reason)
    if (!agDisc.agencies.length) throw new Error('当前账号没有可访问的单位（getAllAgencyHN 返回空）')

    // 单位过滤：预算单位编码优先，单位全称兜底。多单位账号必须唯一命中，避免误导出其它单位。
    let agencies = agDisc.agencies
    if (FILTER_UNIT_CODE) {
      const codeFiltered = agencies.filter(function (a) {
        return normalizeCode(a.agency_code) === normalizeCode(FILTER_UNIT_CODE) ||
          normalizeCode(a.agency_code + a.agency_name).indexOf(normalizeCode(FILTER_UNIT_CODE)) >= 0
      })
      if (!codeFiltered.length) {
        throw new Error(
          '按预算单位编码"' + FILTER_UNIT_CODE + '"过滤后没有匹配单位。\\n可用单位：' +
            agencies.map(function (a) { return a.agency_code + ' ' + a.agency_name }).join('、')
        )
      }
      if (codeFiltered.length > 1) {
        throw new Error(
          '预算单位编码"' + FILTER_UNIT_CODE + '"匹配到多个单位：' +
            codeFiltered.map(function (a) { return a.agency_code + ' ' + a.agency_name }).join('、')
        )
      }
      agencies = codeFiltered
    } else if (FILTER_UNIT_NAME) {
      const filtered = agencies.filter(function (a) {
        return (
          (a.agency_name || '').indexOf(FILTER_UNIT_NAME) >= 0 ||
          FILTER_UNIT_NAME.indexOf(a.agency_name || '') >= 0
        )
      })
      if (!filtered.length) {
        throw new Error(
          '按"' + FILTER_UNIT_NAME + '"过滤后没有匹配单位。\\n可用单位：' +
            agencies.map(function (a) { return a.agency_code + ' ' + a.agency_name }).join('、')
        )
      }
      if (filtered.length > 1) {
        throw new Error(
          '按"' + FILTER_UNIT_NAME + '"匹配到多个单位，请在系统设置中维护预算单位编码：' +
            filtered.map(function (a) { return a.agency_code + ' ' + a.agency_name }).join('、')
        )
      }
      agencies = filtered
    }

    const agencyBatches = []
    for (let i = 0; i < agencies.length; i++) {
      const a = agencies[i]
      const bd = await discoverBatches(a.agency_id)
      if (!bd.ok) {
        agencyBatches.push({ agency: a, batches: [], reason: 'getBatchAgency HTTP ' + bd.http })
      } else {
        agencyBatches.push({ agency: a, batches: bd.batches })
      }
    }

    // 算总组合数：考虑每个 saltype 的 onlyFirstBatch
    let totalCombos = 0
    for (let ai = 0; ai < agencyBatches.length; ai++) {
      const batchCount = agencyBatches[ai].batches.length
      for (let si = 0; si < SALTYPES.length; si++) {
        const limit = SALTYPES[si].onlyFirstBatch ? Math.min(1, batchCount) : batchCount
        totalCombos += limit
      }
    }
    status(
      '📦 ' + agencies.length + ' 单位 × ' + SALTYPES.length + ' 类别 = ' + totalCombos + ' 个组合\\n月份：' + MONTH
    )
    await sleep(700)

    const files = []
    const skipped = []
    const failed = []
    let idx = 0

    for (let ai = 0; ai < agencyBatches.length; ai++) {
      const ab = agencyBatches[ai]
      const ag = ab.agency
      if (!ab.batches.length) {
        failed.push({
          agency: ag.agency_code + ' ' + ag.agency_name,
          saltype: '-', salbatch: '-',
          reason: ab.reason || '没有任何批次'
        })
        continue
      }
      const firstBatchId = ab.batches[0].salbatch_id

      for (let si = 0; si < SALTYPES.length; si++) {
        const st = SALTYPES[si]
        const batchLimit = st.onlyFirstBatch ? Math.min(1, ab.batches.length) : ab.batches.length
        for (let bi = 0; bi < batchLimit; bi++) {
          const bt = ab.batches[bi]
          idx++
          status(
            '⏳ 进度 ' + idx + '/' + totalCombos +
            '\\n→ ' + ag.agency_code + ' ' + ag.agency_name +
            ' / ' + st.saltype_name + ' / ' + bt.salbatch_name
          )
          let r
          try {
            r = await exportOneCombo(MONTH, ag, st, bt, firstBatchId)
          } catch (error) {
            r = { ok: false, skipped: false, reason: error && error.message ? error.message : String(error) }
          }
          const tag = {
            agency: ag.agency_code + ' ' + ag.agency_name,
            saltype: st.saltype_name,
            salbatch: bt.salbatch_name
          }
          if (r.ok) {
            files.push({
              filename: r.filename, base64: r.base64, size: r.size,
              agency: tag.agency, saltype: tag.saltype, salbatch: tag.salbatch
            })
          } else if (r.skipped) {
            skipped.push(Object.assign(tag, { reason: r.reason }))
          } else {
            failed.push(Object.assign(tag, { reason: r.reason }))
          }
          await sleep(STEP_DELAY)
        }
      }
    }

    status('💾 ' + files.length + ' 个文件待入库...')
    return { ok: true, files: files, skipped: skipped, failed: failed }
  } catch (error) {
    const msg = (error && error.message) ? error.message : String(error)
    status('❌ ' + msg, 'err')
    return { ok: false, error: msg }
  }
})();
`
}

/**
 * 落盘结果反馈：宿主收到 ok/失败后注入这段更新浮窗
 */
export function buildSalaryExportFeedbackScript(ok: boolean, text: string): string {
  const safeText = JSON.stringify(text)
  const okLit = ok ? 'true' : 'false'
  return `
;(function () {
  const el = document.getElementById('salary-export-status')
  if (!el) return
  el.textContent = ${safeText}
  el.style.background = ${okLit} ? 'rgba(38,128,80,0.95)' : 'rgba(180,40,40,0.95)'
  setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el) }, 15000)
})();
`
}
