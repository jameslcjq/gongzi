export function buildPortalDomRecorderScript(): string {
  return String.raw`
;(() => {
  try {
    const MAX_ACTIONS = 400
    const MAX_INPUTS = 300
    const MAX_TABLES = 80
    const MAX_ROWS = 10
    const MAX_CELLS = 24

    function normalizeText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }

    function clip(value, limit) {
      const text = normalizeText(value)
      const max = limit || 200
      return text.length > max ? text.slice(0, max) + '...' : text
    }

    function list(nodes, limit) {
      return Array.prototype.slice.call(nodes || [], 0, limit)
    }

    function unique(values) {
      const seen = new Set()
      const output = []
      values.forEach(function (value) {
        const text = String(value || '').trim()
        if (!text || seen.has(text)) return
        seen.add(text)
        output.push(text)
      })
      return output
    }

    function escapeCss(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch })
    }

    function rectOf(el) {
      try {
        const rect = el.getBoundingClientRect()
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      } catch (error) {
        return null
      }
    }

    function isVisible(el) {
      try {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') !== 0 &&
          rect.width > 0 &&
          rect.height > 0
      } catch (error) {
        return true
      }
    }

    function classNameOf(el) {
      return typeof el.className === 'string' ? el.className : ''
    }

    function nthOfType(el) {
      let index = 1
      let sibling = el
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === el.tagName) index += 1
      }
      return index
    }

    function selectorFor(el) {
      try {
        const parts = []
        let node = el
        while (node && node.nodeType === 1 && parts.length < 5) {
          const tag = node.tagName.toLowerCase()
          let part = tag
          if (node.id) {
            part += '#' + escapeCss(node.id)
            parts.unshift(part)
            break
          }
          const field = node.getAttribute('field')
          const name = node.getAttribute('name')
          if (field) part += '[field="' + field.replace(/"/g, '\\"') + '"]'
          else if (name) part += '[name="' + name.replace(/"/g, '\\"') + '"]'
          const classes = classNameOf(node).split(/\s+/).filter(Boolean).slice(0, 2)
          classes.forEach(function (name) {
            part += '.' + escapeCss(name)
          })
          if (!field && !name && !classes.length) part += ':nth-of-type(' + nthOfType(node) + ')'
          parts.unshift(part)
          node = node.parentElement
        }
        return parts.join(' > ')
      } catch (error) {
        return ''
      }
    }

    function attrsOf(el, names) {
      const output = {}
      names.forEach(function (name) {
        const value = el.getAttribute && el.getAttribute(name)
        if (value !== null && value !== undefined && value !== '') output[name] = clip(value, 260)
      })
      return output
    }

    function contextTextOf(el) {
      const context = el.closest && el.closest(
        '.datagrid-toolbar,.toolbar,.panel-toolbar,.dialog-button,.window,.panel,.tabs-header,form,.btn-group,.searchArea,.search-area'
      )
      if (!context || context === document.body) return ''
      return clip(context.innerText || context.textContent || '', 360)
    }

    function actionTextOf(el) {
      return clip(
        el.innerText ||
          el.textContent ||
          el.value ||
          el.title ||
          el.getAttribute('aria-label') ||
          el.getAttribute('name') ||
          '',
        160
      )
    }

    function collectActions() {
      const selector = [
        'a',
        'button',
        'input[type="button"]',
        'input[type="submit"]',
        'input[type="reset"]',
        '.l-btn',
        '.l-btn-text',
        '.easyui-linkbutton',
        '[role="button"]',
        '[onclick]'
      ].join(',')
      const hosts = []
      const seen = new Set()
      list(document.querySelectorAll(selector), MAX_ACTIONS * 2).forEach(function (el) {
        const host = el.closest && (el.closest('a,button,.l-btn,.easyui-linkbutton,[role="button"]') || el)
        const picked = host || el
        if (seen.has(picked)) return
        seen.add(picked)
        hosts.push(picked)
      })
      return hosts.slice(0, MAX_ACTIONS).map(function (el) {
        return {
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          text: actionTextOf(el),
          visible: isVisible(el),
          rect: rectOf(el),
          attrs: attrsOf(el, [
            'id',
            'name',
            'class',
            'type',
            'title',
            'aria-label',
            'href',
            'data-options',
            'field',
            'onclick'
          ]),
          contextText: contextTextOf(el)
        }
      })
    }

    function collectInputs() {
      return list(document.querySelectorAll('input,select,textarea'), MAX_INPUTS).map(function (el) {
        const tag = el.tagName.toLowerCase()
        const type = String(el.getAttribute('type') || tag).toLowerCase()
        let value = ''
        if (type === 'password') value = '[password omitted]'
        else if (type === 'hidden') value = '[hidden omitted]'
        else if ('value' in el) value = clip(el.value, 180)
        return {
          selector: selectorFor(el),
          tag: tag,
          type: type,
          value: value,
          checked: !!el.checked,
          disabled: !!el.disabled,
          readonly: !!el.readOnly,
          visible: isVisible(el),
          rect: rectOf(el),
          attrs: attrsOf(el, [
            'id',
            'name',
            'class',
            'placeholder',
            'title',
            'aria-label',
            'data-options'
          ]),
          nearbyText: contextTextOf(el)
        }
      })
    }

    function cellsOf(row) {
      return list(row.querySelectorAll('th,td'), MAX_CELLS).map(function (cell) {
        const fieldNode = cell.matches && cell.matches('[field]') ? cell : cell.querySelector('[field]')
        return {
          field: fieldNode ? fieldNode.getAttribute('field') || '' : cell.getAttribute('field') || '',
          text: clip(cell.innerText || cell.textContent || '', 160),
          attrs: attrsOf(cell, ['field', 'class', 'data-options'])
        }
      })
    }

    function rowsOf(root) {
      return list(root.querySelectorAll('tr.datagrid-row,tr'), MAX_ROWS).map(function (row) {
        const cells = cellsOf(row)
        const valuesByField = {}
        cells.forEach(function (cell) {
          if (cell.field && !(cell.field in valuesByField)) valuesByField[cell.field] = cell.text
        })
        return {
          rowIndex: row.getAttribute('datagrid-row-index') || row.rowIndex,
          className: classNameOf(row),
          text: clip(row.innerText || row.textContent || '', 520),
          cells: cells,
          valuesByField: valuesByField
        }
      })
    }

    function collectDomTables() {
      const selector = [
        '.datagrid',
        '.datagrid-view',
        '.datagrid-view2',
        '.datagrid-btable',
        '.datagrid-htable',
        '.easyui-datagrid',
        '[role="grid"]',
        'table[id]',
        'table'
      ].join(',')
      return list(document.querySelectorAll(selector), MAX_TABLES).map(function (el) {
        const fields = unique(list(el.querySelectorAll('[field]'), 160).map(function (node) {
          return node.getAttribute('field')
        }))
        const headers = unique(
          list(el.querySelectorAll('th,.datagrid-header [field],.datagrid-htable [field]'), 80)
            .map(function (node) { return clip(node.innerText || node.textContent || node.getAttribute('field') || '', 120) })
        )
        return {
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          visible: isVisible(el),
          rect: rectOf(el),
          attrs: attrsOf(el, ['id', 'name', 'class', 'data-options', 'role']),
          fields: fields,
          headers: headers,
          rowCount: el.querySelectorAll('tr.datagrid-row,tr').length,
          textSample: clip(el.innerText || el.textContent || '', 900),
          rows: rowsOf(el)
        }
      })
    }

    function serializeRow(row) {
      const output = {}
      if (!row || typeof row !== 'object') return output
      Object.keys(row).slice(0, 80).forEach(function (key) {
        const value = row[key]
        output[key] = typeof value === 'object' ? clip(JSON.stringify(value), 220) : clip(value, 220)
      })
      return output
    }

    function collectJqueryDatagrids() {
      const $ = window.jQuery || window.$
      if (!$) return []
      return list(document.querySelectorAll('table[id],.easyui-datagrid'), 50).map(function (el) {
        const entry = {
          selector: selectorFor(el),
          attrs: attrsOf(el, ['id', 'name', 'class', 'data-options']),
          ok: false,
          fields: [],
          columns: [],
          selectedRows: [],
          rows: [],
          error: ''
        }
        try {
          const jq = $(el)
          if (typeof jq.datagrid !== 'function') {
            entry.error = 'jQuery datagrid plugin is not attached'
            return entry
          }
          entry.ok = true
          try { entry.fields = jq.datagrid('getColumnFields') || [] } catch (error) {}
          try {
            const columns = jq.datagrid('getColumns') || []
            entry.columns = columns.map(function (col) {
              return {
                field: col.field || '',
                title: clip(col.title || '', 120),
                hidden: !!col.hidden,
                editor: typeof col.editor === 'string' ? col.editor : col.editor ? JSON.stringify(col.editor) : ''
              }
            })
          } catch (error) {}
          try { entry.selectedRows = (jq.datagrid('getSelections') || []).slice(0, MAX_ROWS).map(serializeRow) } catch (error) {}
          try { entry.rows = (jq.datagrid('getRows') || []).slice(0, MAX_ROWS).map(serializeRow) } catch (error) {}
          return entry
        } catch (error) {
          entry.error = error && error.message ? error.message : String(error)
          return entry
        }
      })
    }

    function describeController(name) {
      const ctrl = window[name]
      if (!ctrl) return { present: false }
      const output = {
        present: true,
        version: clip(ctrl.version || '', 120),
        keys: Object.keys(ctrl).slice(0, 40)
      }
      if (name === '__salaryPlanInput' && typeof ctrl.canOpen === 'function') {
        try { output.canOpen = !!ctrl.canOpen() } catch (error) { output.canOpenError = String(error) }
      }
      return output
    }

    function collectFrames() {
      const output = []
      for (let i = 0; i < window.frames.length; i += 1) {
        const frame = window.frames[i]
        try {
          output.push({
            index: i,
            accessible: true,
            href: frame.location && frame.location.href,
            title: frame.document && frame.document.title,
            textSample: clip(frame.document && frame.document.body && frame.document.body.innerText, 420)
          })
        } catch (error) {
          output.push({ index: i, accessible: false, error: String(error) })
        }
      }
      return output
    }

    const bodyText = document.body ? document.body.innerText || document.body.textContent || '' : ''
    return {
      ok: true,
      capturedAt: new Date().toISOString(),
      href: location.href,
      origin: location.origin,
      pathname: location.pathname,
      hash: location.hash,
      title: document.title,
      readyState: document.readyState,
      frameElement: window.frameElement ? attrsOf(window.frameElement, ['id', 'name', 'class', 'src']) : null,
      bodyTextLength: normalizeText(bodyText).length,
      bodyTextSample: clip(bodyText, 5000),
      controllers: {
        salaryPlanInput: describeController('__salaryPlanInput'),
        salaryQuotaMatch: describeController('__salaryQuotaMatch'),
        autoVoucherEntry: describeController('__autoVoucherEntry'),
        salaryVoucherMerge: describeController('__salaryVoucherMerge')
      },
      actions: collectActions(),
      inputs: collectInputs(),
      domTables: collectDomTables(),
      jqueryDatagrids: collectJqueryDatagrids(),
      frames: collectFrames()
    }
  } catch (error) {
    return {
      ok: false,
      capturedAt: new Date().toISOString(),
      href: location.href,
      title: document.title,
      error: error && error.message ? error.message : String(error)
    }
  }
})()
`
}
