/**
 * 推送失败时由主程序注入，抓取当前一体化门户的"结构快照"（只读，不点击不跳转），
 * 逐行写进推送日志。用途：在看不到内网页面的情况下，判断门户菜单/iframe 布局，
 * 尤其门户升级（如 framework-web2 → SmartFin apaas）后菜单变化导致的导航失败。
 *
 * 返回 string[]（每行一条），主程序用 logStepTrace 落盘。
 */
export function buildPortalDiagnosticsScript(): string {
  return `
;(function portalDiag() {
  var OUT = []
  function push(s) { try { OUT.push(String(s)) } catch (e) {} }
  function norm(v) { return String(v == null ? '' : v).replace(/\\s+/g, ' ').trim() }
  var KEYS = ['中科单位核算','单位核算','会计核算','凭证管理','凭证录入','预算执行','单位核算','直接支付外部数据','支付管理','集中支付','工资','导入']

  function isVisible(el) {
    try {
      var w = el.ownerDocument.defaultView
      var st = w.getComputedStyle(el)
      var r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    } catch (e) { return false }
  }

  function sampleMenus(doc) {
    var out = []
    try {
      var sel = 'a,button,li,span,[role=menuitem],[role=tab],[class*=menu],[class*=nav],[class*=tab]'
      var nodes = Array.prototype.slice.call(doc.querySelectorAll(sel))
      var seen = {}
      for (var i = 0; i < nodes.length && out.length < 40; i++) {
        var el = nodes[i]
        if (!isVisible(el)) continue
        var t = norm(el.innerText || el.textContent || el.title || '')
        if (!t || t.length > 14) continue
        if (seen[t]) continue
        seen[t] = 1
        out.push(t)
      }
    } catch (e) {}
    return out
  }

  function shadowCount(doc) {
    var n = 0
    try {
      var all = doc.querySelectorAll('*')
      for (var i = 0; i < all.length; i++) { if (all[i].shadowRoot) n++ }
    } catch (e) {}
    return n
  }

  function dumpWin(win, label, depth) {
    try {
      var doc = win.document
      push(label + ' url=' + norm(win.location && win.location.href))
      var present = []
      var bodyText = ''
      try { bodyText = norm(doc.body && doc.body.innerText) } catch (e) {}
      for (var k = 0; k < KEYS.length; k++) {
        if (bodyText.indexOf(KEYS[k]) >= 0 && present.indexOf(KEYS[k]) < 0) present.push(KEYS[k])
      }
      push(label + ' 命中关键词: ' + (present.join('、') || '（无）'))
      var menus = sampleMenus(doc)
      push(label + ' 菜单样本(' + menus.length + '): ' + (menus.join(' | ') || '（无可见可点项）'))
      var sc = shadowCount(doc)
      if (sc > 0) push(label + ' shadowRoot 元素数: ' + sc + '（疑似 Web Component，常规查找看不到内部）')
      if (depth < 3) {
        var frames = win.frames
        push(label + ' iframe 数: ' + frames.length)
        for (var i = 0; i < frames.length && i < 8; i++) {
          var fl = label + '>frame[' + i + ']'
          try { dumpWin(frames[i], fl, depth + 1) }
          catch (e) { push(fl + ' 跨域不可读: ' + norm(e && e.message)) }
        }
      }
    } catch (e) { push(label + ' 读取失败: ' + norm(e && e.message)) }
  }

  try {
    push('==== 门户结构诊断 ' + new Date().toLocaleString() + ' ====')
    dumpWin(window.top || window, 'top', 0)
  } catch (e) { push('诊断异常: ' + norm(e && e.message)) }
  return OUT
})()
`
}
