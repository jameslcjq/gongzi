export type SalaryExportTargetInput = {
  saltype_id: string
  saltype_name: string
  salbatch_id: string
  salbatch_name: string
}

type SalaryExportScriptOptions = {
  /**
   * 工资信息维护页的 menuid，固定值（来自抓包）。
   */
  menuid?: string
  /**
   * 默认月份。若注入时调用方未传，则用页面下拉框的当前值，再 fallback 到当月。
   */
  month?: string
  /**
   * 要遍历的"类别+批次"组合。必填（一般从 UnitSettings 取）。
   */
  targets: SalaryExportTargetInput[]
}

/**
 * 构造一段可在内网工资系统 webview.executeJavaScript 注入运行的脚本。
 *
 * 脚本不再要求用户停在工资业务页 —— 只要 cookie 里有 belongOrgId（已登录）就能跑：
 *  1. 解析 cookie 拿 agency_id + 单位名
 *  2. 遍历调用方传入的 targets 列表，每个 (saltype_id, salbatch_id) 组合执行：
 *     loadSalaryCollection → expExcelPost → blob.arrayBuffer → base64
 *  3. 把每个非空文件收集成数组返回：
 *     { ok: true, files: [{filename, base64, size, saltype, salbatch}], skipped, failed }
 */
export function buildSalaryExportScript(options: SalaryExportScriptOptions): string {
  const menuid = options.menuid ?? '1fb8071c09c44932a99439096316db28'
  const month = options.month ?? ''
  const targets = options.targets

  return `
;(async function runSalaryExport() {
  const MENUID = ${JSON.stringify(menuid)}
  const FORCE_MONTH = ${JSON.stringify(month)}
  const TARGETS = ${JSON.stringify(targets)}

  const EMPTY_XLS_THRESHOLD = 4096
  const STEP_DELAY = 400

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  function ensureStatus() {
    let el = document.getElementById('salary-export-status')
    if (el) return el
    el = document.createElement('div')
    el.id = 'salary-export-status'
    el.style.cssText = [
      'position:fixed','top:130px','right:24px','min-width:320px','max-width:560px',
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

  function parseUserInfo() {
    try {
      const m = document.cookie.match(/(?:^|;\\s*)userInfo=([^;]+)/i) ||
                document.cookie.match(/(?:^|;\\s*)userinfo=([^;]+)/i)
      if (!m) return null
      return JSON.parse(decodeURIComponent(m[1]))
    } catch (error) { return null }
  }
  function readComboValue(id) {
    try {
      if (window.jQuery) {
        const \$el = window.jQuery('#' + id)
        if (\$el.length && \$el.combobox) {
          try {
            const v = \$el.combobox('getValue')
            if (v !== undefined && v !== null && v !== '') return String(v)
          } catch (error) {}
        }
        const v2 = \$el.val()
        if (v2) return String(v2)
      }
      const dom = document.getElementById(id)
      if (dom && dom.value) return String(dom.value)
    } catch (error) {}
    return ''
  }

  function bytesToBase64(bytes) {
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }

  async function loadItemIds(ctx, saltype_id, salbatch_id) {
    const res = await fetch(
      '/sal-config-pro-server/salSalaryItem/loadSalaryCollection?menuid=' + MENUID,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          saltype_id: saltype_id,
          salbatch_id: salbatch_id,
          agency_id: ctx.AGENCY_ID
        })
      }
    )
    if (!res.ok) return { ok: false, http: res.status }
    const col = await res.json()
    if (!col.data || !col.data.itemColList || !col.data.itemColList.length) {
      return { ok: false, empty: true }
    }
    return { ok: true, item_ids: col.data.itemColList.map(function (c) { return String(c.item_id) }) }
  }

  async function exportOneTarget(ctx, target) {
    let col = await loadItemIds(ctx, target.saltype_id, target.salbatch_id)
    if (!col.ok && col.http) {
      return { ok: false, skipped: true, reason: 'loadSalaryCollection HTTP ' + col.http }
    }
    if (!col.ok && col.empty && target.salbatch_id !== '1') {
      console.log('[salary-export] 列定义为空，回退到批次 1：', target.saltype_name, target.salbatch_name)
      col = await loadItemIds(ctx, target.saltype_id, '1')
    }
    if (!col.ok) return { ok: false, skipped: true, reason: '无工资项配置（已尝试回退批次1）' }
    const item_ids = col.item_ids

    const expRes = await fetch('/sal-salary-pro-server/SalExcelController/expExcelPost', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        impType: 2,
        agencyid: ctx.AGENCY_ID,
        need_total: false,
        month: ctx.MONTH,
        saltypeid: target.saltype_id,
        salbatch_id: target.salbatch_id,
        salDeptId: '0',
        isExpData: true,
        item_ids: item_ids,
        name: '', ic_id: '', card_no4: '',
        sfgz1: '', sfgz2: '', yfgz1: '', yfgz2: ''
      })
    })
    if (!expRes.ok) return { ok: false, skipped: false, reason: 'expExcelPost HTTP ' + expRes.status }
    const blob = await expRes.blob()
    if (blob.size < EMPTY_XLS_THRESHOLD) {
      return { ok: false, skipped: true, reason: '该组合没有数据（' + blob.size + ' 字节）' }
    }
    const ab = await blob.arrayBuffer()
    const base64 = bytesToBase64(new Uint8Array(ab))
    const safeUnit = (ctx.UNIT_NAME || ctx.AGENCY_ID.slice(0, 8)).replace(/[\\\\/:*?"<>|]/g, '_')
    const safeType = target.saltype_name.replace(/[\\\\/:*?"<>|]/g, '_')
    const safeBatch = target.salbatch_name.replace(/[\\\\/:*?"<>|]/g, '_')
    const filename =
      '工资-' + safeUnit + '-' + ctx.MONTH + '月-' + safeType + '-' + safeBatch + '.xls'
    return { ok: true, filename: filename, base64: base64, size: blob.size }
  }

  try {
    if (!Array.isArray(TARGETS) || !TARGETS.length) {
      throw new Error('未配置任何"类别+批次"组合，请在"系统设置 → 单位信息"里维护')
    }

    status('🔍 读取登录信息...')
    const ui = parseUserInfo()
    if (!ui || !ui.belongOrgId) throw new Error('未能从 cookie 读到 belongOrgId（请先登录一体化系统）')
    const ctx = {
      AGENCY_ID: ui.belongOrgId,
      UNIT_NAME: ui.mof_div_name || ui.admDivName || '',
      MONTH: FORCE_MONTH || readComboValue('month') || String(new Date().getMonth() + 1)
    }
    status('📦 共 ' + TARGETS.length + ' 个组合待导出\\n单位 ' +
           (ctx.UNIT_NAME || ctx.AGENCY_ID.slice(0, 8)) + ' / ' + ctx.MONTH + '月')
    await sleep(600)

    const files = []
    const skipped = []
    const failed = []
    for (let i = 0; i < TARGETS.length; i++) {
      const t = TARGETS[i]
      status('⏳ 进度 ' + (i + 1) + '/' + TARGETS.length + '\\n→ ' + t.saltype_name + ' / ' + t.salbatch_name)
      let r
      try {
        r = await exportOneTarget(ctx, t)
      } catch (error) {
        r = { ok: false, skipped: false, reason: error && error.message ? error.message : String(error) }
      }
      if (r.ok) {
        files.push({
          filename: r.filename, base64: r.base64, size: r.size,
          saltype: t.saltype_name, salbatch: t.salbatch_name
        })
      } else if (r.skipped) {
        skipped.push({ saltype: t.saltype_name, salbatch: t.salbatch_name, reason: r.reason })
      } else {
        failed.push({ saltype: t.saltype_name, salbatch: t.salbatch_name, reason: r.reason })
      }
      await sleep(STEP_DELAY)
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
 * 宿主收到结果后调用 saveSalaryExportXls 入库；
 * 入库结果可以注入这段脚本回写浮窗状态。
 */
export function buildSalaryExportFeedbackScript(
  ok: boolean,
  text: string
): string {
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
