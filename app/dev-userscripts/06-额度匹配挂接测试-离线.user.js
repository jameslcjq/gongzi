// ==UserScript==
// @name         工资系统-额度匹配挂接测试（离线·点格子方案v2）
// @namespace    https://www.hujiuxi.top/gongzi/dev
// @version      2026.06.09d
// @description  验证新方案：选工资项→选指标→点修改(只点一次)→“点入挂接金额格子”触发页面编辑(不调用 beginEdit)→填金额。记录“部门经济分类”显示名字还是id、保存按钮在不在、有无报错。只填值不点保存；若自动入账请用页面“撤销匹配”还原。
// @author       老九 / Codex
// @match        http://172.24.147.202/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict'

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').trim() }
  function compact(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim() }

  function eachDoc(fn) {
    function w(win) { try { fn(win.document) } catch (e) {} for (var i = 0; i < win.frames.length; i++) { try { w(win.frames[i]) } catch (e) {} } }
    w(window.top || window)
  }
  function getJqOf(doc) { try { return (doc.defaultView && (doc.defaultView.jQuery || doc.defaultView.$)) || null } catch (e) { return null } }

  function findGridBy(predicate) {
    var hit = null
    eachDoc(function (doc) {
      if (hit) return
      var jq = getJqOf(doc); if (!jq) return
      var els = doc.querySelectorAll('table[id],div[id]')
      for (var i = 0; i < els.length; i++) { var el = els[i]; try { if (!jq(el).data('datagrid')) continue; if (predicate(jq, el)) { hit = { jq: jq, grid: el, doc: doc }; return } } catch (e) {} }
    })
    return hit
  }
  function findQuotaGrid() { return findGridBy(function (jq, el) { var o = jq(el).datagrid('getColumnOption', 'pay_money'); return !!(o && o.editor) }) }
  function findItemGrid() { return findGridBy(function (jq, el) { var fs = jq(el).datagrid('getColumnFields') || []; if (fs.indexOf('item_name') < 0) return false; return (jq(el).datagrid('getRows') || []).length > 0 }) }

  // 与真实代码 clickElement 一致：只点一次（click() 成功就返回，dispatch 仅兜底）。
  function clickEl(el) {
    if (!el) return
    try { el.scrollIntoView({ block: 'center' }) } catch (e) {}
    try { el.click(); return } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })) } catch (e) {}
  }
  function dblclickEl(el) { try { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window })) } catch (e) {} }

  function btnPresent(text) {
    var want = norm(text), found = false
    eachDoc(function (doc) {
      if (found) return
      var ns = doc.querySelectorAll('a,button,input[type=button],input[type=submit],.l-btn,.l-btn-text,span.l-btn-text')
      for (var i = 0; i < ns.length; i++) { var n = ns[i]; var host = (n.classList && n.classList.contains('l-btn-text')) ? (n.closest('.l-btn') || n) : n; var v = n.tagName === 'INPUT' ? (n.value || '') : (n.innerText || n.textContent || n.title || ''); if (norm(v) === want) { var r = host.getBoundingClientRect(); if (r.width > 0 || r.height > 0) { found = true; return } } }
    })
    return found
  }
  function findButtonEl(text) {
    var want = norm(text), hit = null
    eachDoc(function (doc) {
      if (hit) return
      var ns = doc.querySelectorAll('a,button,input[type=button],input[type=submit],.l-btn,.l-btn-text,span.l-btn-text')
      for (var i = 0; i < ns.length; i++) { var n = ns[i]; var host = (n.classList && n.classList.contains('l-btn-text')) ? (n.closest('.l-btn') || n) : n; var v = n.tagName === 'INPUT' ? (n.value || '') : (n.innerText || n.textContent || n.title || ''); if (norm(v) === want) { var r = host.getBoundingClientRect(); if (r.width > 0 || r.height > 0) { hit = host; return } } }
    })
    return hit
  }

  function payCellEl(ctx, idx) {
    try { var panel = ctx.jq(ctx.grid).datagrid('getPanel'); var scope = (panel && panel[0]) || ctx.doc; return scope.querySelector('tr[datagrid-row-index="' + idx + '"] td[field="pay_money"]') } catch (e) { return null }
  }
  function cellDisplay(ctx, idx, field) {
    try { var panel = ctx.jq(ctx.grid).datagrid('getPanel'); var scope = (panel && panel[0]) || ctx.doc; var td = scope.querySelector('tr[datagrid-row-index="' + idx + '"] td[field="' + field + '"]'); if (!td) return null; var inp = td.querySelector('input.textbox-text, input.combo-text, input[type=text]'); return inp ? ('[输入框]' + inp.value) : ('[文本]' + compact(td.innerText || td.textContent || '')) } catch (e) { return 'ERR' }
  }
  function editorVal(jq, ed) {
    if (!ed || !ed.target) return null
    var t = ed.target, v = null, ms = ['combotree', 'combobox', 'combo', 'numberbox', 'textbox']
    for (var i = 0; i < ms.length; i++) { if (v != null) break; try { var x = jq(t)[ms[i]]('getValue'); if (x !== undefined && x !== null && x !== '') v = String(x) } catch (e) {} }
    if (v == null) { try { var y = jq(t).val(); if (y != null && y !== '') v = String(y) } catch (e) {} }
    return v
  }

  function snap(label, ctx, itemCtx) {
    var idx = -1
    try { idx = ctx.jq(ctx.grid).datagrid('getRows').indexOf(ctx.jq(ctx.grid).datagrid('getSelected')) } catch (e) {}
    var model = {}
    try { var r = ctx.jq(ctx.grid).datagrid('getRows')[idx] || {}; model = { dep_bgt_eco_id: r.dep_bgt_eco_id, dep_bgt_eco_codename: r.dep_bgt_eco_codename, pay_money: r.pay_money } } catch (e) {}
    var eds = {}
    ;['dep_bgt_eco_id', 'pay_money'].forEach(function (f) { try { var ed = ctx.jq(ctx.grid).datagrid('getEditor', { index: idx, field: f }); eds[f] = ed ? { value: editorVal(ctx.jq, ed) } : null } catch (e) { eds[f] = 'ERR' } })
    var item = null
    try { var s = itemCtx.jq(itemCtx.grid).datagrid('getSelected'); item = s ? { item_name: s.item_name, unalready: s.unalready_matc_amonty } : null } catch (e) {}
    return { step: label, saveButtons: { '修改': btnPresent('修改'), '保存': btnPresent('保存'), '确定': btnPresent('确定') }, selectedItem: item, quotaIndex: idx, quotaModel: model, 部门经济分类_显示: cellDisplay(ctx, idx, 'dep_bgt_eco_id'), 挂接金额_显示: cellDisplay(ctx, idx, 'pay_money'), editors: eds }
  }

  function output(data) {
    var text = JSON.stringify(data, null, 2)
    try { console.log('[挂接测试4]', data) } catch (e) {}
    try { var b = new Blob([text], { type: 'application/json;charset=utf-8' }); var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = '挂接测试4-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 1000) } catch (e) {}
    var ta = document.getElementById('gongzi-link-test-out'); if (!ta) { ta = document.createElement('textarea'); ta.id = 'gongzi-link-test-out'; ta.style.cssText = 'position:fixed;left:18px;bottom:18px;width:560px;height:300px;z-index:2147483647;font-size:12px;border:2px solid #dc2626;background:#fff;'; document.body.appendChild(ta) }
    ta.value = text; ta.focus(); ta.select()
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text) } catch (e) {}
  }

  async function runTest() {
    var ctx = findQuotaGrid(); var itemCtx = findItemGrid()
    if (!ctx) { alert('未找到可挂接指标网格'); return }
    if (!itemCtx) { alert('未找到工资项网格'); return }
    var itemRows = itemCtx.jq(itemCtx.grid).datagrid('getRows') || []
    var itemIdx = -1; for (var i = 0; i < itemRows.length; i++) { if (Number(itemRows[i].unalready_matc_amonty) > 0) { itemIdx = i; break } }
    if (itemIdx < 0) { alert('没有未匹配金额>0 的工资项'); return }
    try { itemCtx.jq(itemCtx.grid).datagrid('selectRow', itemIdx) } catch (e) {}
    await sleep(800)
    var quotaRows = ctx.jq(ctx.grid).datagrid('getRows') || []
    if (!quotaRows.length) { alert('可挂接指标为空'); return }
    try { ctx.jq(ctx.grid).datagrid('selectRow', 0) } catch (e) {}
    await sleep(500)

    var snaps = []
    snaps.push(snap('1_选完', ctx, itemCtx))

    var mod = findButtonEl('修改'); if (mod) clickEl(mod)
    await sleep(900)
    snaps.push(snap('2_点修改后(应出现保存)', ctx, itemCtx))

    var idx = ctx.jq(ctx.grid).datagrid('getRows').indexOf(ctx.jq(ctx.grid).datagrid('getSelected'))
    var editor = null
    for (var attempt = 0; attempt < 3 && !(editor && editor.target); attempt++) {
      var cell = payCellEl(ctx, idx)
      if (cell) { clickEl(cell); dblclickEl(cell) }
      var until = Date.now() + 1600
      while (Date.now() < until) { try { editor = ctx.jq(ctx.grid).datagrid('getEditor', { index: idx, field: 'pay_money' }) } catch (e) {} if (editor && editor.target) break; await sleep(200) }
    }
    snaps.push(snap('3_点格子后(取到编辑器=' + !!(editor && editor.target) + ')', ctx, itemCtx))

    var setOk = false, setErr = ''
    if (editor && editor.target) { try { ctx.jq(editor.target).textbox('setValue', '1'); setOk = true } catch (e) { setErr = String(e && e.message || e) } }
    await sleep(700)
    snaps.push(snap('4_填金额1后', ctx, itemCtx))

    output({ capturedAt: new Date().toISOString(), editorFound: !!(editor && editor.target), setOk: setOk, setErr: setErr, note: '看第2步保存=true；第3/4步“部门经济分类_显示”是名字还是id、editorFound、保存在不在、setErr。名字+无报错=新方案有效。只填值未点保存；自动入账请撤销匹配。', snapshots: snaps })
  }

  function addButton() {
    if (document.getElementById('gongzi-link-test-btn')) return
    var btn = document.createElement('button')
    btn.id = 'gongzi-link-test-btn'
    btn.textContent = '测试挂接(点格子v2)'
    btn.style.cssText = 'position:fixed;right:18px;bottom:180px;z-index:2147483647;padding:8px 12px;border:0;border-radius:4px;background:#0f766e;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.22)'
    btn.onclick = function () { runTest() }
    document.body.appendChild(btn)
  }

  addButton()
  setInterval(addButton, 1000)
})()
