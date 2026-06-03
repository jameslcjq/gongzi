export type IntegrationModuleTarget = 'budget' | 'accounting'

export type IntegrationModuleNavigationResult = {
  ok: boolean
  target: IntegrationModuleTarget
  message: string
  changed?: boolean
}

const MODULES: Record<
  IntegrationModuleTarget,
  { name: string; entryText: string; readyTexts: string[] }
> = {
  budget: {
    name: '预算执行',
    entryText: '预算执行',
    readyTexts: ['集中支付', '一般用款计划录入', '直接支付外部数据']
  },
  accounting: {
    name: '中科单位核算',
    entryText: '中科单位核算',
    readyTexts: ['凭证管理', '凭证录入']
  }
}

export function buildOpenIntegrationModuleScript(target: IntegrationModuleTarget): string {
  const moduleConfig = MODULES[target]
  return `
;(async function openIntegrationModule() {
  var TARGET = ${JSON.stringify(target)}
  var MODULE = ${JSON.stringify(moduleConfig)}

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
  function normalize(value) { return String(value || '').replace(/\\s+/g, '') }

  function isVisible(el) {
    try {
      var style = el.ownerDocument.defaultView.getComputedStyle(el)
      var rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    } catch (error) {
      return true
    }
  }

  function textExistsIn(win, text) {
    try {
      var body = win.document && win.document.body
      if (body && normalize(body.innerText || body.textContent || '').indexOf(normalize(text)) >= 0) return true
      for (var i = 0; i < win.frames.length; i++) {
        if (textExistsIn(win.frames[i], text)) return true
      }
    } catch (error) {}
    return false
  }

  function anyReadyTextExists(root) {
    for (var i = 0; i < MODULE.readyTexts.length; i++) {
      if (textExistsIn(root, MODULE.readyTexts[i])) return true
    }
    return false
  }

  function clickableTarget(el) {
    try {
      return el.closest('a,button,li,[role="button"],.menu-item,.app-item,.module-item,.portal-menu-item') || el
    } catch (error) {
      return el
    }
  }

  function clickElement(el) {
    var target = clickableTarget(el)
    try { target.scrollIntoView({ block: 'center', inline: 'center' }) } catch (error) {}
    try {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: target.ownerDocument.defaultView }))
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: target.ownerDocument.defaultView }))
    } catch (error) {}
    target.click()
  }

  function clickTextInWin(win, text) {
    try {
      var wanted = normalize(text)
      var nodes = Array.prototype.slice.call(
        win.document.querySelectorAll('a,button,span,div,li,td,p,h1,h2,h3,[role="button"],[title]')
      )
      var exact = []
      var partial = []
      nodes.forEach(function (el) {
        if (!isVisible(el)) return
        var own = normalize(el.innerText || el.textContent || el.title || '')
        if (!own) return
        if (own === wanted) exact.push(el)
        else if (own.indexOf(wanted) >= 0 && own.length <= wanted.length + 40) partial.push(el)
      })
      var picked = exact[0] || partial[0]
      if (picked) {
        clickElement(picked)
        return true
      }
      for (var i = 0; i < win.frames.length; i++) {
        if (clickTextInWin(win.frames[i], text)) return true
      }
    } catch (error) {}
    return false
  }

  async function waitForReady(root, timeoutMs) {
    var deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (anyReadyTextExists(root)) return true
      await sleep(500)
    }
    return false
  }

  try {
    var root = window.top || window
    if (anyReadyTextExists(root)) {
      return {
        ok: true,
        target: TARGET,
        message: '已在' + MODULE.name + '模块'
      }
    }

    if (!textExistsIn(root, MODULE.entryText)) {
      return {
        ok: false,
        target: TARGET,
        message: '当前页面找不到“' + MODULE.entryText + '”入口。请确认已登录一体化，并停在能看到模块入口的页面。'
      }
    }

    if (!clickTextInWin(root, MODULE.entryText)) {
      return {
        ok: false,
        target: TARGET,
        message: '未能点击“' + MODULE.entryText + '”入口'
      }
    }

    if (await waitForReady(root, 60000)) {
      return {
        ok: true,
        target: TARGET,
        changed: true,
        message: '已打开' + MODULE.name + '模块'
      }
    }

    return {
      ok: false,
      target: TARGET,
      message: '已点击“' + MODULE.entryText + '”，但没有等到' + MODULE.readyTexts.join(' / ') + '菜单'
    }
  } catch (error) {
    return {
      ok: false,
      target: TARGET,
      message: '打开' + MODULE.name + '模块失败：' + (error && error.message ? error.message : String(error))
    }
  }
})()
`
}
