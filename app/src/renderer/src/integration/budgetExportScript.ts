/**
 * 预算导出（人员信息查看）准自动化脚本。
 *
 * 实测请求链路（来自抓包录制）：
 *   1. button#exportdata        ← 顶部"导出"按钮
 *   2. input#exportcfgAll        ← 弹出的配置对话框里的"全部"勾选
 *   3. div#layui-layer1 ... a.layui-layer-btn0   ← 弹层底部"导出"确认
 *
 * 之后页面自己发若干个加密 RCP 调用，服务端异步生成文件并触发 xls 下载。
 * 下载本身由 main 进程的 will-download 拦截器接管，自动落入导入文件夹。
 *
 * 脚本只负责"模拟点这 3 下"。
 */
export function buildBudgetExportScript(): string {
  return `
;(async function runBudgetExport() {
  const STEP_DELAY = 800
  const WAIT_TIMEOUT = 15000

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  function ensureStatus() {
    let el = document.getElementById('budget-export-status')
    if (el) return el
    el = document.createElement('div')
    el.id = 'budget-export-status'
    el.style.cssText = [
      'position:fixed','top:130px','right:24px','min-width:300px','max-width:520px',
      'padding:14px 18px','background:rgba(33,33,33,0.92)','color:#fff',
      'border-radius:8px','font-size:13px','line-height:1.6',
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
    else el.style.background = 'rgba(33,33,33,0.92)'
    console.log('[budget-export]', text)
  }
  function clearStatusLater(ms) {
    setTimeout(function () {
      const el = document.getElementById('budget-export-status')
      if (el && el.parentNode) el.parentNode.removeChild(el)
    }, ms || 10000)
  }

  // 递归在所有可访问 frame 里查元素
  function queryDeep(selector) {
    function dig(doc) {
      if (!doc) return null
      try {
        const el = doc.querySelector(selector)
        if (el) return el
      } catch (e) {}
      let frames
      try { frames = doc.defaultView ? doc.defaultView.frames : [] } catch (e) { frames = [] }
      for (let i = 0; i < frames.length; i++) {
        try {
          const sub = frames[i].document
          const r = dig(sub)
          if (r) return r
        } catch (e) {}
      }
      return null
    }
    return dig(document) || dig(window.top && window.top.document)
  }

  function queryDeepByText(selector, text) {
    const wanted = String(text).trim()
    function dig(doc) {
      if (!doc) return null
      try {
        const list = doc.querySelectorAll(selector)
        for (let i = 0; i < list.length; i++) {
          const el = list[i]
          const t = (el.innerText || el.textContent || '').trim()
          if (t === wanted || t.indexOf(wanted) >= 0) return el
        }
      } catch (e) {}
      let frames
      try { frames = doc.defaultView ? doc.defaultView.frames : [] } catch (e) { frames = [] }
      for (let i = 0; i < frames.length; i++) {
        try {
          const r = dig(frames[i].document)
          if (r) return r
        } catch (e) {}
      }
      return null
    }
    return dig(document) || dig(window.top && window.top.document)
  }

  async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || WAIT_TIMEOUT)
    while (Date.now() < deadline) {
      const r = predicate()
      if (r) return r
      await sleep(300)
    }
    throw new Error('超时等待：' + (label || 'element'))
  }

  function fireClick(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) {}
    try { el.click(); return true } catch (e) {}
    try {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      el.dispatchEvent(evt)
      return true
    } catch (e) {}
    return false
  }

  try {
    status('🔍 检查页面...')
    // 必须停在 "人员信息查看" 页才能点
    const exportBtn = queryDeep('button#exportdata')
    if (!exportBtn) {
      throw new Error('未找到 button#exportdata。请先在一体化系统里进入"预算编制 → 人员信息查看"页面')
    }
    status('🖱 第 1/3 步：点击顶部"导出"按钮...')
    fireClick(exportBtn)

    await sleep(STEP_DELAY)
    const cfgAll = await waitFor(
      function () { return queryDeep('input#exportcfgAll') },
      WAIT_TIMEOUT,
      'input#exportcfgAll'
    )
    status('🖱 第 2/3 步：勾选"全部"...')
    fireClick(cfgAll)
    // 有些 layui 表单还得手动设 checked
    try {
      cfgAll.checked = true
      cfgAll.dispatchEvent(new Event('change', { bubbles: true }))
    } catch (e) {}

    await sleep(STEP_DELAY)
    const layerBtn = await waitFor(
      function () {
        // 优先按 selector 找；找不到再按文字找弹层主按钮
        return (
          queryDeep('div[id^="layui-layer"] a.layui-layer-btn0') ||
          queryDeepByText('a.layui-layer-btn0', '导出')
        )
      },
      WAIT_TIMEOUT,
      'layui 弹层确认按钮'
    )
    status('🖱 第 3/3 步：点击弹层"导出"...')
    fireClick(layerBtn)

    await sleep(600)
    status(
      '✅ 已触发导出。\\n服务端正在异步生成文件，下载完成后 app 会自动入库。\\n你可以继续其他操作。',
      'ok'
    )
    clearStatusLater(12000)
    return { ok: true, message: '已触发导出' }
  } catch (error) {
    const msg = error && error.message ? error.message : String(error)
    status('❌ ' + msg, 'err')
    return { ok: false, message: msg }
  }
})();
`
}
