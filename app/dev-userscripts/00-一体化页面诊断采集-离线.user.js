// ==UserScript==
// @name         一体化页面诊断采集（离线）
// @namespace    https://www.hujiuxi.top/gongzi/dev
// @version      2026.06.04
// @description  离线采集当前一体化页面的按钮、iframe、表格字段和页面文字，用于定位注入脚本问题。
// @author       老九 / Codex
// @match        http://172.24.147.202/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict'

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }

  function safe(fn, fallback) {
    try { return fn() } catch (error) { return fallback }
  }

  function visible(el) {
    return safe(function () {
      var style = el.ownerDocument.defaultView.getComputedStyle(el)
      var rect = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }, true)
  }

  function inspectDoc(win, depth) {
    var doc = win.document
    var buttons = Array.prototype.slice.call(doc.querySelectorAll('a,button,span,[role="button"],.l-btn-text,.btn,.more,.tit'))
      .filter(visible)
      .map(function (el) {
        return {
          tag: el.tagName,
          id: el.id || '',
          className: String(el.className || '').slice(0, 160),
          text: normalize(el.innerText || el.textContent || el.title || '').slice(0, 120)
        }
      })
      .filter(function (item) { return item.text })
      .slice(0, 200)
    var rows = Array.prototype.slice.call(doc.querySelectorAll('tr.datagrid-row, tr[id*="datagrid-row"]')).slice(0, 30)
    var tableFields = rows.map(function (row) {
      return {
        id: row.id || '',
        index: row.getAttribute('datagrid-row-index') || '',
        fields: Array.prototype.slice.call(row.querySelectorAll('[field]')).map(function (cell) {
          return {
            field: cell.getAttribute('field'),
            text: normalize(cell.innerText || cell.textContent || '').slice(0, 80)
          }
        }).slice(0, 40)
      }
    })
    var iframes = Array.prototype.slice.call(doc.querySelectorAll('iframe')).map(function (iframe) {
      return {
        src: iframe.src || iframe.getAttribute('src') || '',
        id: iframe.id || '',
        name: iframe.name || '',
        className: String(iframe.className || '').slice(0, 120)
      }
    })
    return {
      depth: depth,
      href: safe(function () { return win.location.href }, ''),
      title: doc.title || '',
      textPreview: normalize(doc.body && (doc.body.innerText || doc.body.textContent) || '').slice(0, 3000),
      buttons: buttons,
      iframes: iframes,
      tableFields: tableFields
    }
  }

  function collect(win, depth, result) {
    result.push(safe(function () { return inspectDoc(win, depth) }, { depth: depth, error: 'document access failed' }))
    if (depth >= 3) return
    safe(function () {
      for (var i = 0; i < win.frames.length; i++) collect(win.frames[i], depth + 1, result)
    }, null)
  }

  function downloadJson(data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = '一体化页面诊断-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'
    document.body.appendChild(a)
    a.click()
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 1000)
  }

  function addButton() {
    if (document.getElementById('gongzi-page-diagnostic-btn')) return
    var btn = document.createElement('button')
    btn.id = 'gongzi-page-diagnostic-btn'
    btn.textContent = '采集页面诊断'
    btn.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:8px 12px;border:0;border-radius:4px;background:#1f6feb;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.22)'
    btn.onclick = function () {
      var frames = []
      collect(window.top || window, 0, frames)
      downloadJson({ capturedAt: new Date().toISOString(), frames: frames })
    }
    document.body.appendChild(btn)
  }

  addButton()
  setInterval(addButton, 1000)
})()
