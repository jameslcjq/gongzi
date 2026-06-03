import salaryPlanInputScript from './salaryPlanInput.user.js?raw'
import type { PersonnelExpensePlanPrefillResult } from '@shared/types'

type SalaryPlanInputScriptOptions = {
  showPageButton?: boolean
  prefill?: PersonnelExpensePlanPrefillResult
}

export function buildSalaryPlanInputScript(
  options: SalaryPlanInputScriptOptions = {}
): string {
  const showPageButton = options.showPageButton ?? true
  const prefillJson = JSON.stringify(options.prefill ?? { ok: false, rows: [] })
  return `
window.__SALARY_PLAN_INPUT_SHOW_PAGE_BUTTON = ${showPageButton ? 'true' : 'false'};
window.__SALARY_PLAN_INPUT_PREFILL = ${prefillJson};
${salaryPlanInputScript}
`
}

export function buildOpenSalaryPlanInputScript(
  prefill?: PersonnelExpensePlanPrefillResult
): string {
  const prefillJson = JSON.stringify(prefill ?? { ok: false, rows: [] })
  return `
;(async function openSalaryPlanInputFromToolbar() {
  var PREFILL = ${prefillJson};

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function normalizeText(value) {
    return String(value || '').replace(/\\s+/g, '')
  }

  function isVisible(el) {
    try {
      var style = el.ownerDocument.defaultView.getComputedStyle(el)
      var rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    } catch (error) {
      return true
    }
  }

  function findTarget(win) {
    try {
      if (
        win.__salaryPlanInput &&
        typeof win.__salaryPlanInput.canOpen === 'function' &&
        win.__salaryPlanInput.canOpen()
      ) {
        return win
      }
      for (var i = 0; i < win.frames.length; i++) {
        var found = findTarget(win.frames[i])
        if (found) return found
      }
    } catch (error) {}
    return null
  }

  function textExists(win, text) {
    try {
      if (normalizeText(win.document.body && win.document.body.innerText).indexOf(normalizeText(text)) >= 0) return true
      for (var i = 0; i < win.frames.length; i++) {
        if (textExists(win.frames[i], text)) return true
      }
    } catch (error) {}
    return false
  }

  function clickTextInWindow(win, text) {
    try {
      var wanted = normalizeText(text)
      var nodes = Array.prototype.slice.call(
        win.document.querySelectorAll('a,button,span,div,li,td')
      )
      var exact = []
      var partial = []
      nodes.forEach(function (el) {
        if (!isVisible(el)) return
        var own = normalizeText(el.innerText || el.textContent || el.title || '')
        if (!own) return
        if (own === wanted) exact.push(el)
        else if (own.indexOf(wanted) >= 0 && own.length <= wanted.length + 20) partial.push(el)
      })
      var picked = exact[0] || partial[0]
      if (picked) {
        picked.scrollIntoView({ block: 'center', inline: 'center' })
        picked.click()
        return true
      }
      for (var i = 0; i < win.frames.length; i++) {
        if (clickTextInWindow(win.frames[i], text)) return true
      }
    } catch (error) {}
    return false
  }

  async function waitForTarget(root, timeoutMs) {
    var deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      var target = findTarget(root)
      if (target && target.__salaryPlanInput) return target
      await sleep(700)
    }
    return null
  }

  async function clickAndWait(root, text, waitText) {
    if (waitText && textExists(root, waitText)) return true
    var clicked = clickTextInWindow(root, text)
    if (!clicked) return false
    var deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      if (findTarget(root)) return true
      if (!waitText || textExists(root, waitText)) return true
      await sleep(700)
    }
    return true
  }

  var root = window.top || window
  var target = await waitForTarget(root, 1000)
  if (!target) {
    if (!textExists(root, '集中支付') || !textExists(root, '一般用款计划录入')) {
      await clickAndWait(root, '预算执行', '集中支付')
      await sleep(1200)
    }
    await clickAndWait(root, '集中支付', '一般用款计划录入')
    await sleep(900)
    await clickAndWait(root, '一般用款计划录入', '批量录入')
    target = await waitForTarget(root, 20000)
  }

  if (!target || !target.__salaryPlanInput) {
    return {
      ok: false,
      message: '没有自动进入“一般用款计划录入”。请确认已登录，并且页面上能看到“预算执行 / 集中支付 / 一般用款计划录入”。'
    }
  }
  return target.__salaryPlanInput.openFromToolbar(PREFILL)
})()
`
}
