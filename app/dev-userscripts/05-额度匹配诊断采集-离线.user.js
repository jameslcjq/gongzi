// ==UserScript==
// @name         工资系统-额度匹配诊断采集（离线）
// @namespace    https://www.hujiuxi.top/gongzi/dev
// @version      2026.06.09
// @description  采集“可挂接指标/计划”网格在“修改/编辑”态下的 datagrid 结构、字段、编辑器与当前焦点，用于定位额度匹配金额写错列的问题。请先选中一条可挂接指标行并点“修改”，再点本脚本的采集按钮。
// @author       老九 / Codex
// @match        http://172.24.147.202/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict'

  var MAX_GRIDS_PER_DOC = 30
  var MAX_SAMPLE_ROWS = 6
  var MAX_EDITING_CELLS = 60
  var QUOTA_HINT_FIELDS = ['pay_money', 'dep_bgt_eco_codename', 'dep_bgt_eco_code', 'dep_bgt_eco_name', 'gov_bgt_eco_codename', 'real_canuse_amount', 'balance_canuse_amount']

  function compact(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
  }
  function clip(v, n) {
    var s = compact(v)
    return s.length > (n || 80) ? s.slice(0, n || 80) + '…' : s
  }
  function safe(fn, fb) {
    try { return fn() } catch (e) { return fb }
  }
  function getJq(doc) {
    return safe(function () {
      return (doc.defaultView && (doc.defaultView.jQuery || doc.defaultView.$)) || null
    }, null)
  }
  function collectDocs(win, docs, seen) {
    if (!win || seen.indexOf(win) >= 0) return
    seen.push(win)
    safe(function () { if (win.document && docs.indexOf(win.document) < 0) docs.push(win.document) })
    safe(function () { for (var i = 0; i < win.frames.length; i++) collectDocs(win.frames[i], docs, seen) })
  }
  function reachableDocs() {
    var docs = [], seen = []
    collectDocs(window.top || window, docs, seen)
    collectDocs(window, docs, seen)
    return docs
  }
  function elDesc(el) {
    if (!el) return null
    return {
      tag: el.tagName || '',
      type: safe(function () { return el.getAttribute('type') }, '') || el.type || '',
      id: el.id || '',
      name: safe(function () { return el.getAttribute('name') }, '') || '',
      className: String(el.className || '').slice(0, 160),
      value: ('value' in el) ? clip(el.value, 80) : '',
      readOnly: !!el.readOnly,
      visible: safe(function () { var r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0 }, null)
    }
  }
  function closestFieldTd(el) {
    return safe(function () {
      var n = el
      while (n && n !== document) {
        if (n.getAttribute && n.getAttribute('field')) return n.getAttribute('field')
        n = n.parentNode
      }
      return ''
    }, '')
  }
  function trimRow(obj) {
    var out = {}
    safe(function () {
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
        var v = obj[k]
        var t = typeof v
        if (v == null) out[k] = v
        else if (t === 'string') out[k] = v.length > 80 ? v.slice(0, 80) + '…' : v
        else if (t === 'number' || t === 'boolean') out[k] = v
        // skip functions / nested objects / dom nodes
      }
    })
    return out
  }
  function domRowFieldMap(row) {
    var map = {}
    safe(function () {
      var cells = row.querySelectorAll('[field]')
      for (var i = 0; i < cells.length; i++) {
        var f = cells[i].getAttribute('field')
        if (!f) continue
        var t = cells[i].querySelector('[title]')
        map[f] = clip(t ? t.getAttribute('title') : (cells[i].innerText || cells[i].textContent || ''), 60)
      }
    })
    return map
  }
  function rowDomIndex(row) {
    var a = safe(function () { return row.getAttribute('datagrid-row-index') }, null)
    if (a !== null && a !== '') { var n = Number(a); if (isFinite(n)) return n }
    var id = safe(function () { return row.getAttribute('id') || '' }, '')
    var m = id && id.match(/-(\d+)$/)
    return m ? Number(m[1]) : null
  }
  function isEditingCell(td) {
    return safe(function () {
      if (td.querySelector('.datagrid-editable')) return true
      if (td.querySelector('input.textbox-text, input.numberbox-text, .combo, .combobox-f, select, textarea')) return true
      return false
    }, false)
  }

  function editorDesc(jq, gridEl, index, field) {
    return safe(function () {
      var ed = jq(gridEl).datagrid('getEditor', { index: index, field: field })
      if (!ed) return null
      var target = ed.target
      var tEl = (target && target[0]) ? target[0] : (target && target.nodeType ? target : null)
      var val = safe(function () { return String(jq(target).val()) }, '')
      return {
        field: field,
        type: ed.type || (typeof ed),
        targetTag: tEl ? tEl.tagName : '',
        targetClass: tEl ? String(tEl.className || '').slice(0, 120) : '',
        targetName: tEl ? (safe(function () { return tEl.getAttribute('name') }, '') || '') : '',
        rawValue: clip(val, 80)
      }
    }, null)
  }

  function inspectGrid(jq, gridEl, doc) {
    var info = {
      id: gridEl.id || '',
      tag: gridEl.tagName,
      className: String(gridEl.className || '').slice(0, 120)
    }
    info.columnFields = safe(function () { return jq(gridEl).datagrid('getColumnFields') || [] }, 'ERR')
    info.frozenFields = safe(function () { return jq(gridEl).datagrid('getColumnFields', true) || [] }, 'ERR')
    var allFields = [].concat(
      Array.isArray(info.frozenFields) ? info.frozenFields : [],
      Array.isArray(info.columnFields) ? info.columnFields : []
    )
    info.panel = safe(function () {
      var p = jq(gridEl).datagrid('getPanel')
      return (p && p[0]) ? { id: p[0].id || '', className: String(p[0].className || '').slice(0, 120) } : null
    }, null)
    info.rowCount = safe(function () { return (jq(gridEl).datagrid('getRows') || []).length }, 'ERR')
    info.editableFields = []
    safe(function () {
      for (var i = 0; i < allFields.length; i++) {
        var f = allFields[i]
        var opt = safe(function () { return jq(gridEl).datagrid('getColumnOption', f) }, null)
        if (opt && opt.editor) {
          info.editableFields.push({ field: f, editor: (typeof opt.editor === 'string' ? opt.editor : (opt.editor.type || 'object')) })
        }
      }
    })

    var hasQuotaHint = false
    for (var q = 0; q < QUOTA_HINT_FIELDS.length; q++) {
      if (allFields.indexOf(QUOTA_HINT_FIELDS[q]) >= 0) { hasQuotaHint = true; break }
    }
    info.looksLikeQuotaGrid = hasQuotaHint
    info.hasItemNameField = allFields.indexOf('item_name') >= 0

    // selected row (easyui model)
    info.selected = safe(function () { var s = jq(gridEl).datagrid('getSelected'); return s ? trimRow(s) : null }, null)

    // DOM panel rows: detect editing row + sample
    var editingIndex = null
    info.editingCellsInGrid = []
    safe(function () {
      var panelEl = info.panel ? doc.getElementById(info.panel.id) : null
      var scope = panelEl || doc
      var trs = scope.querySelectorAll('tr.datagrid-row, tr[id*="datagrid-row"]')
      for (var r = 0; r < trs.length; r++) {
        var tds = trs[r].querySelectorAll('td[field]')
        var rowEditing = false
        for (var c = 0; c < tds.length; c++) {
          if (isEditingCell(tds[c])) {
            rowEditing = true
            info.editingCellsInGrid.push({
              field: tds[c].getAttribute('field'),
              inputs: Array.prototype.slice.call(tds[c].querySelectorAll('input, select, textarea')).map(elDesc),
              innerHTML: clip(tds[c].innerHTML, 300)
            })
          }
        }
        if (rowEditing && editingIndex === null) editingIndex = rowDomIndex(trs[r])
      }
    })
    info.editingRowIndex = editingIndex

    // editor introspection for the editing (or selected) row, all fields
    var probeIndex = editingIndex
    if (probeIndex === null) {
      probeIndex = safe(function () {
        var rows = jq(gridEl).datagrid('getRows') || []
        var sel = jq(gridEl).datagrid('getSelected')
        return sel ? rows.indexOf(sel) : null
      }, null)
    }
    info.probeIndex = probeIndex
    info.editorsAtProbe = []
    if (probeIndex !== null && probeIndex >= 0) {
      for (var e = 0; e < allFields.length; e++) {
        var d = editorDesc(jq, gridEl, probeIndex, allFields[e])
        if (d) info.editorsAtProbe.push(d)
      }
    }

    // sample model rows
    info.sampleRows = safe(function () {
      var rows = jq(gridEl).datagrid('getRows') || []
      return rows.slice(0, MAX_SAMPLE_ROWS).map(trimRow)
    }, null)

    return info
  }

  function inspectDoc(doc) {
    var jq = getJq(doc)
    var out = {
      href: safe(function () { return doc.location.href }, ''),
      hasJq: !!jq,
      grids: [],
      editingCellsLoose: [],
      activeElement: null
    }
    if (!jq) return out

    // all datagrids in this doc
    safe(function () {
      var seenGrid = []
      var candidates = doc.querySelectorAll('table[id], div[id]')
      for (var i = 0; i < candidates.length && out.grids.length < MAX_GRIDS_PER_DOC; i++) {
        var el = candidates[i]
        var isGrid = safe(function () { return !!jq(el).data('datagrid') }, false)
        if (!isGrid) continue
        if (seenGrid.indexOf(el) >= 0) continue
        seenGrid.push(el)
        out.grids.push(inspectGrid(jq, el, doc))
      }
    })

    // loose editing-cell scan across whole doc (in case it's not inside a recognized grid)
    safe(function () {
      var tds = doc.querySelectorAll('td[field]')
      for (var i = 0; i < tds.length && out.editingCellsLoose.length < MAX_EDITING_CELLS; i++) {
        if (!isEditingCell(tds[i])) continue
        out.editingCellsLoose.push({
          field: tds[i].getAttribute('field'),
          rowIndex: rowDomIndex(tds[i].closest ? tds[i].closest('tr') : null),
          inputs: Array.prototype.slice.call(tds[i].querySelectorAll('input, select, textarea')).map(elDesc),
          innerHTML: clip(tds[i].innerHTML, 300)
        })
      }
    })

    // active element + its location
    safe(function () {
      var ae = doc.activeElement
      if (ae && ae !== doc.body) {
        out.activeElement = {
          el: elDesc(ae),
          inFieldTd: closestFieldTd(ae)
        }
      }
    })

    return out
  }

  function capture() {
    var docs = reachableDocs()
    var frames = []
    for (var i = 0; i < docs.length; i++) {
      var info = safe(function () { return inspectDoc(docs[i]) }, { error: 'inspect failed' })
      // only keep frames that have grids or editing cells, plus the top doc
      if ((info.grids && info.grids.length) || (info.editingCellsLoose && info.editingCellsLoose.length) || i === 0) {
        frames.push(info)
      }
    }
    return { capturedAt: new Date().toISOString(), topUrl: safe(function () { return (window.top || window).location.href }, ''), frames: frames }
  }

  function download(data) {
    var text = JSON.stringify(data, null, 2)
    safe(function () {
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' })
      var a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = '额度匹配诊断-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'
      document.body.appendChild(a)
      a.click()
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 1000)
    })
    safe(function () { console.log('[额度匹配诊断]', data) })
    safe(function () {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text)
    })
    return text
  }

  function flash(msg) {
    var el = document.getElementById('gongzi-quota-diag-flash')
    if (!el) {
      el = document.createElement('div')
      el.id = 'gongzi-quota-diag-flash'
      el.style.cssText = 'position:fixed;right:18px;bottom:150px;z-index:2147483647;max-width:360px;padding:10px 14px;border-radius:6px;background:rgba(32,38,46,.96);color:#fff;font-size:13px;line-height:1.5;box-shadow:0 6px 22px rgba(0,0,0,.24);white-space:pre-wrap'
      document.body.appendChild(el)
    }
    el.textContent = msg
  }

  function addButton() {
    if (document.getElementById('gongzi-quota-diag-btn')) return
    var btn = document.createElement('button')
    btn.id = 'gongzi-quota-diag-btn'
    btn.textContent = '采集额度匹配诊断'
    btn.title = '请先选中一条可挂接指标行并点击页面的“修改”，再点此按钮采集编辑态结构'
    btn.style.cssText = 'position:fixed;right:18px;bottom:138px;z-index:2147483647;padding:8px 12px;border:0;border-radius:4px;background:#dc2626;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.22)'
    btn.onclick = function () {
      var data = capture()
      download(data)
      var gridCount = 0, editing = 0, quotaGrids = 0
      for (var i = 0; i < data.frames.length; i++) {
        var f = data.frames[i]
        gridCount += (f.grids || []).length
        editing += (f.editingCellsLoose || []).length
        for (var g = 0; g < (f.grids || []).length; g++) if (f.grids[g].looksLikeQuotaGrid) quotaGrids++
      }
      flash('已采集并下载 JSON。\n datagrid 数：' + gridCount + '（疑似可挂接指标网格 ' + quotaGrids + ' 个）\n 编辑态单元格：' + editing + ' 个\n（已尝试复制到剪贴板，请把 JSON 发给我）')
    }
    document.body.appendChild(btn)
  }

  addButton()
  setInterval(addButton, 1000)
})()
