/**
 * 录制模式：在 webview 的每一个 frame 注入钩子，捕获
 *   - fetch / XHR：URL、方法、请求体、响应状态、响应体片段
 *   - 用户点击：选择器、可见文本、所属 frame URL
 * 事件先缓冲在每个 frame 的 window.__exportRecorder.events，
 * 宿主每隔 1-2 秒通过 drain 脚本捞回来合并。
 */
export function buildRecorderInstallScript(sessionId = ''): string {
  const encodedSessionId = JSON.stringify(sessionId)
  return `
;(function installRecorder() {
  const sessionId = ${encodedSessionId}
  const now = Date.now()
  window.__exportRecorder = window.__exportRecorder || { events: [], startedAt: now, lastNavigationUrl: '', sessionId: '' }
  if (sessionId && window.__exportRecorder.sessionId !== sessionId) {
    window.__exportRecorder.events = []
    window.__exportRecorder.startedAt = now
    window.__exportRecorder.lastNavigationUrl = ''
    window.__exportRecorder.sessionId = sessionId
  }

  const MAX_PREVIEW = 4000
  const MAX_BUF = 8000

  function push(kind, data) {
    try {
      const ev = Object.assign(
        { t: Date.now() - (window.__exportRecorder.startedAt || now), frameUrl: location.href, kind: kind },
        data
      )
      window.__exportRecorder.events.push(ev)
      if (window.__exportRecorder.events.length > MAX_BUF) {
        window.__exportRecorder.events = window.__exportRecorder.events.slice(-MAX_BUF / 2)
      }
    } catch (e) {}
  }

  function pushNavigationOnce() {
    try {
      if (window.__exportRecorder.lastNavigationUrl === location.href) return
      window.__exportRecorder.lastNavigationUrl = location.href
      push('navigation', {
        url: location.href,
        title: document.title || ''
      })
    } catch (e) {}
  }

  function isFormDataLike(value) {
    try {
      return value && typeof value.entries === 'function' && String(value) === '[object FormData]'
    } catch (e) {
      return false
    }
  }

  function describeBodyValue(value) {
    try {
      if (value && typeof File !== 'undefined' && value instanceof File) {
        return {
          kind: 'file',
          name: value.name || '',
          size: value.size || 0,
          type: value.type || ''
        }
      }
      if (value && typeof Blob !== 'undefined' && value instanceof Blob) {
        return {
          kind: 'blob',
          size: value.size || 0,
          type: value.type || ''
        }
      }
    } catch (e) {}
    if (value === null || value === undefined) return ''
    return String(value).slice(0, MAX_PREVIEW)
  }

  function serializeRequestBody(body) {
    try {
      if (!body) return null
      if (isFormDataLike(body)) {
        const fields = []
        body.forEach(function (value, key) {
          fields.push({ name: String(key || ''), value: describeBodyValue(value) })
        })
        return { kind: 'formData', fields: fields }
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return { kind: 'urlSearchParams', text: String(body).slice(0, MAX_PREVIEW) }
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return describeBodyValue(body)
      }
      return { kind: typeof body, text: String(body).slice(0, MAX_PREVIEW) }
    } catch (e) {
      return { kind: 'unreadable', error: String((e && e.message) || e) }
    }
  }

  if (window.__exportRecorderInstalled) {
    pushNavigationOnce()
    return { ok: true, alreadyInstalled: true, frameUrl: location.href }
  }
  window.__exportRecorderInstalled = true

  // -------- fetch ----------
  if (window.fetch) {
    const orig = window.fetch
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const method = ((init && init.method) || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase()
      let reqBody = null
      try {
        if (init && init.body) reqBody = serializeRequestBody(init.body)
      } catch (e) {}
      const t0 = Date.now()
      return orig.apply(this, arguments).then(
        function (res) {
          try {
            const clone = res.clone()
            clone.text().then(
              function (text) {
                push('fetch', {
                  url: url,
                  method: method,
                  reqBody: reqBody,
                  status: res.status,
                  respLen: (text || '').length,
                  respPreview: (text || '').slice(0, MAX_PREVIEW),
                  durationMs: Date.now() - t0
                })
              },
              function () {
                push('fetch', { url: url, method: method, reqBody: reqBody, status: res.status, durationMs: Date.now() - t0 })
              }
            )
          } catch (e) {}
          return res
        },
        function (err) {
          push('fetch', {
            url: url,
            method: method,
            reqBody: reqBody,
            error: String((err && err.message) || err),
            durationMs: Date.now() - t0
          })
          throw err
        }
      )
    }
  }

  // -------- XHR ----------
  try {
    const origOpen = XMLHttpRequest.prototype.open
    const origSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__recMethod = method
      this.__recUrl = url
      return origOpen.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function (body) {
      const t0 = Date.now()
      const self = this
      let reqBody = null
      try {
        if (body) reqBody = serializeRequestBody(body)
      } catch (e) {}
      this.addEventListener('loadend', function () {
        let respText = ''
        try {
          respText = self.responseText || ''
        } catch (e) {}
        push('xhr', {
          url: self.__recUrl,
          method: (self.__recMethod || 'GET').toUpperCase(),
          reqBody: reqBody,
          status: self.status,
          respLen: respText.length,
          respPreview: respText.slice(0, MAX_PREVIEW),
          durationMs: Date.now() - t0
        })
      })
      return origSend.apply(this, arguments)
    }
  } catch (e) {}

  // -------- user actions ----------
  function toElement(target) {
    try {
      if (!target) return null
      if (target.nodeType === 1) return target
      if (target.parentElement) return target.parentElement
    } catch (e) {}
    return null
  }

  function buildSelector(el) {
    try {
      if (!el || el.nodeType !== 1) return ''
      const parts = []
      let cur = el
      let depth = 0
      while (cur && cur.nodeType === 1 && depth < 6) {
        let part = cur.tagName.toLowerCase()
        if (cur.id) {
          part += '#' + cur.id
          parts.unshift(part)
          break
        }
        if (cur.className && typeof cur.className === 'string') {
          const cls = cur.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.')
          if (cls) part += '.' + cls
        }
        parts.unshift(part)
        cur = cur.parentElement
        depth++
      }
      return parts.join(' > ')
    } catch (e) {
      return ''
    }
  }

  function elementText(el) {
    try {
      return (el.innerText || el.textContent || '').trim().slice(0, 120)
    } catch (e) {
      return ''
    }
  }

  function elementValue(el) {
    try {
      if (!el) return undefined
      const tag = String(el.tagName || '').toUpperCase()
      const type = String(el.type || '').toLowerCase()
      if (type === 'password') return '<password>'
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return String(el.value || '').slice(0, 500)
      }
    } catch (e) {}
    return undefined
  }

  // easyui 网格上下文：点的是哪个网格、哪一行、哪一列(field)。排查“有没有点进挂接金额格子”全靠它。
  function gridContextOf(el) {
    try {
      const td = el.closest ? el.closest('td[field]') : null
      if (!td) return null
      const out = { field: td.getAttribute('field') || '' }
      const tr = td.closest('tr')
      if (tr) {
        const ri = tr.getAttribute('datagrid-row-index')
        if (ri !== null && ri !== '') out.rowIndex = ri
      }
      const wrap = td.closest('.datagrid-wrap')
      if (wrap) {
        const src = wrap.querySelector('.easyui-datagrid[id], table[id]')
        if (src && src.id) out.gridId = src.id
      }
      return out
    } catch (e) {
      return null
    }
  }

  function pushElementEvent(kind, ev, extra) {
    try {
      const el = toElement(ev && ev.target)
      if (!el) return
      const base = {
        selector: buildSelector(el),
        text: elementText(el),
        tagName: el.tagName,
        id: el.id || '',
        name: el.name || '',
        value: elementValue(el)
      }
      const grid = gridContextOf(el)
      if (grid) base.grid = grid
      push(kind, Object.assign(base, extra || {}))
    } catch (e) {}
  }

  document.addEventListener('click', function (ev) {
    pushElementEvent('click', ev, {
      button: ev.button,
      clientX: ev.clientX,
      clientY: ev.clientY,
      pageX: ev.pageX,
      pageY: ev.pageY
    })
  }, true)

  document.addEventListener('pointerdown', function (ev) {
    pushElementEvent('pointerdown', ev, {
      button: ev.button,
      clientX: ev.clientX,
      clientY: ev.clientY,
      pageX: ev.pageX,
      pageY: ev.pageY
    })
  }, true)

  document.addEventListener('pointerup', function (ev) {
    pushElementEvent('pointerup', ev, {
      button: ev.button,
      clientX: ev.clientX,
      clientY: ev.clientY,
      pageX: ev.pageX,
      pageY: ev.pageY
    })
  }, true)

  // -------- easyui 下拉 / 账套·年度选择 ----------
  // 账套、年度等都是 easyui combo：选项面板（.combo-panel / .combobox / .tree）通常挂在 <body> 上，
  // 选择动作往往落在 mousedown 上（onSelect），普通 click 有时不冒泡到 document。这里专门补一条
  // combo-select，带上被选中项的可见文本（如“沭阳县扎下初级中学”）——这是判断“切到哪个账套”的关键。
  function comboItemOf(el) {
    try {
      if (!el || !el.closest) return null
      const panel = el.closest('.combo-panel, .combobox, .combotree, .combobox-panel, .m-list, .panel-body')
      if (!panel) return null
      const item =
        el.closest('.combobox-item, .tree-node, .menu-item, .l-btn, [data-options], td, li') || el
      const text = (item.innerText || item.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
      if (!text) return null
      const out = { text: text }
      if (panel.id) out.panelId = panel.id
      try {
        const val =
          (item.getAttribute && (item.getAttribute('value') || item.getAttribute('data-value'))) || ''
        if (val) out.itemValue = String(val).slice(0, 120)
      } catch (e) {}
      return out
    } catch (e) {
      return null
    }
  }

  document.addEventListener('mousedown', function (ev) {
    try {
      const el = toElement(ev && ev.target)
      if (!el) return
      const combo = comboItemOf(el)
      if (!combo) return
      pushElementEvent('combo-select', ev, combo)
    } catch (e) {}
  }, true)

  document.addEventListener('input', function (ev) {
    pushElementEvent('input', ev)
  }, true)

  document.addEventListener('change', function (ev) {
    pushElementEvent('change', ev)
  }, true)

  document.addEventListener('submit', function (ev) {
    pushElementEvent('submit', ev)
  }, true)

  document.addEventListener('keydown', function (ev) {
    if (!ev || (ev.key !== 'Enter' && ev.key !== 'Tab')) return
    pushElementEvent('keydown', ev, { key: ev.key })
  }, true)

  document.addEventListener('focusin', function (ev) {
    pushElementEvent('focusin', ev)
  }, true)

  document.addEventListener('dblclick', function (ev) {
    pushElementEvent('dblclick', ev)
  }, true)

  // -------- easyui 行内编辑器生死记录 ----------
  // 记录 .datagrid-editable 出现/消失（editor-open/editor-close），带 field/行号/当时显示文本。
  // “部门经济分类编辑器打开时显示纯数字 id(如 6)”= 行编辑器未被页面正常初始化的铁证。
  try {
    const describeEditableCell = function (cell) {
      const out = { field: '', rowIndex: '', display: '' }
      try {
        const td = cell.closest ? cell.closest('td[field]') : null
        if (td) out.field = td.getAttribute('field') || ''
        const tr = td && td.closest ? td.closest('tr') : null
        if (tr) out.rowIndex = tr.getAttribute('datagrid-row-index') || ''
        const input = cell.querySelector('input.textbox-text, input.combo-text, input[type="text"], select, textarea')
        const raw = input && input.value !== '' ? input.value : (cell.innerText || cell.textContent || '')
        out.display = String(raw || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
      } catch (e) {}
      return out
    }
    const scanEditorNodes = function (nodes, kind) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        if (!node || node.nodeType !== 1) continue
        let cells = []
        try {
          if (node.classList && node.classList.contains('datagrid-editable')) cells = [node]
          else if (node.getElementsByClassName) cells = Array.prototype.slice.call(node.getElementsByClassName('datagrid-editable'))
        } catch (e) {}
        for (let j = 0; j < cells.length && j < 20; j++) push(kind, describeEditableCell(cells[j]))
      }
    }
    const editorObserver = new MutationObserver(function (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        scanEditorNodes(mutations[i].addedNodes, 'editor-open')
        scanEditorNodes(mutations[i].removedNodes, 'editor-close')
      }
    })
    editorObserver.observe(document.documentElement || document.body, { childList: true, subtree: true })
  } catch (e) {}

  window.addEventListener('hashchange', function () {
    push('navigation', {
      url: location.href,
      title: document.title || '',
      source: 'hashchange'
    })
  }, true)

  window.addEventListener('popstate', function () {
    push('navigation', {
      url: location.href,
      title: document.title || '',
      source: 'popstate'
    })
  }, true)

  // -------- 页面跳转 ----------
  pushNavigationOnce()

  return { ok: true, alreadyInstalled: false, frameUrl: location.href }
})();
`
}

/** 把当前 frame 缓冲的事件取走并清空 */
export function buildRecorderDrainScript(): string {
  return `
;(function drainRecorder() {
  const rec = window.__exportRecorder
  const buf = (rec && rec.events) ? rec.events : []
  if (rec) rec.events = []
  return { frameUrl: location.href, events: buf }
})();
`
}

/** 卸载（清空事件；不能真的移除 fetch/XHR 的 hook，重新装会复用现有钩子） */
export function buildRecorderStopScript(): string {
  return `
;(function stopRecorder() {
  if (window.__exportRecorder) window.__exportRecorder.events = []
  // 钩子保留，避免重复安装；下次开始会复用钩子并重新写入当前页面导航。
  return { ok: true }
})();
`
}
