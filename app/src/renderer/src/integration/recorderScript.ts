/**
 * 录制模式：在 webview 的每一个 frame 注入钩子，捕获
 *   - fetch / XHR：URL、方法、请求体、响应状态、响应体片段
 *   - 用户点击：选择器、可见文本、所属 frame URL
 * 事件先缓冲在每个 frame 的 window.__exportRecorder.events，
 * 宿主每隔 1-2 秒通过 drain 脚本捞回来合并。
 */
export function buildRecorderInstallScript(): string {
  return `
;(function installRecorder() {
  if (window.__exportRecorderInstalled) return { ok: true, alreadyInstalled: true, frameUrl: location.href }
  window.__exportRecorderInstalled = true
  window.__exportRecorder = { events: [], startedAt: Date.now() }

  const MAX_PREVIEW = 4000
  const MAX_BUF = 8000
  const startedAt = Date.now()

  function push(kind, data) {
    try {
      const ev = Object.assign(
        { t: Date.now() - startedAt, frameUrl: location.href, kind: kind },
        data
      )
      window.__exportRecorder.events.push(ev)
      if (window.__exportRecorder.events.length > MAX_BUF) {
        window.__exportRecorder.events = window.__exportRecorder.events.slice(-MAX_BUF / 2)
      }
    } catch (e) {}
  }

  // -------- fetch ----------
  if (window.fetch) {
    const orig = window.fetch
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const method = ((init && init.method) || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase()
      let reqBody = null
      try {
        if (init && init.body) reqBody = String(init.body).slice(0, MAX_PREVIEW)
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
        if (body) reqBody = String(body).slice(0, MAX_PREVIEW)
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

  // -------- click ----------
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

  document.addEventListener(
    'click',
    function (ev) {
      try {
        const el = ev.target
        if (!el || el.nodeType !== 1) return
        const txt = (el.innerText || el.textContent || '').trim().slice(0, 120)
        push('click', {
          selector: buildSelector(el),
          text: txt,
          tagName: el.tagName
        })
      } catch (e) {}
    },
    true
  )

  // -------- 页面跳转 ----------
  push('navigation', { url: location.href })

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

/** 卸载（清空 + 标记未安装；不能真的移除 fetch/XHR 的 hook，重新装会幂等跳过） */
export function buildRecorderStopScript(): string {
  return `
;(function stopRecorder() {
  if (window.__exportRecorder) window.__exportRecorder.events = []
  // 钩子保留，避免重复安装；下次开始仍生效（已安装的脚本判断为已安装）
  return { ok: true }
})();
`
}
