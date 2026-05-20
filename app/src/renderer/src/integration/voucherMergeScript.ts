import pdfLibBundle from 'pdf-lib/dist/pdf-lib.min.js?raw'

type VoucherMergeScriptOptions = {
  autoStart?: boolean
}

export function buildVoucherMergeScript(options: VoucherMergeScriptOptions = {}): string {
  const autoStart = options.autoStart ?? true

  return `
${pdfLibBundle}

;(async function installVoucherMerge() {
  const AUTO_START = ${autoStart ? 'true' : 'false'}
  const SCRIPT_VERSION = '20260520-registered-tab-voucher-page'

  if (window.__salaryVoucherMerge && window.__salaryVoucherMerge.version === SCRIPT_VERSION) {
    window.__salaryVoucherMerge.injectButton()
    if (AUTO_START) return window.__salaryVoucherMerge.startBatchProcess()
    return { ok: true, message: 'installed' }
  }

  if (window.__salaryVoucherMergeTimer) {
    clearInterval(window.__salaryVoucherMergeTimer)
    window.__salaryVoucherMergeTimer = null
  }

  const CONFIG = {
    loadDelay: 4500,
    retryMax: 3,
    retryLoadDelay: 6000,
    retryMaxRound2: 6,
    processDelay: 1000,
    leftMargin: '50px'
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function findPdfViewerWindow(win) {
    try {
      if (win.PDFViewerApplication && typeof win.PDFViewerApplication === 'object') return win
    } catch (error) {}

    try {
      const frames = win.frames
      for (let i = 0; i < frames.length; i++) {
        const result = findPdfViewerWindow(frames[i])
        if (result) return result
      }
    } catch (error) {}

    return null
  }

  function findRowsRecursively(win) {
    try {
      const rows = Array.from(win.document.querySelectorAll('tr.datagrid-row')).filter((row) => {
        const indexCell = row.querySelector('td[field="index"]')
        return indexCell && indexCell.innerText.trim() !== ''
      })
      if (rows.length > 0) return rows

      const frames = win.frames
      for (let i = 0; i < frames.length; i++) {
        const result = findRowsRecursively(frames[i])
        if (result) return result
      }
    } catch (error) {}

    return null
  }

  function ensureStatus() {
    const existing = document.getElementById('salary-voucher-merge-status')
    if (existing) return existing

    const status = document.createElement('div')
    status.id = 'salary-voucher-merge-status'
    status.style.cssText = [
      'position:fixed',
      'top:60px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(0,0,0,0.85)',
      'color:#fff',
      'padding:15px 30px',
      'border-radius:30px',
      'font-size:15px',
      'z-index:2147483647',
      'text-align:center',
      'box-shadow:0 4px 15px rgba(0,0,0,0.3)'
    ].join(';')
    document.body.appendChild(status)
    return status
  }

  async function processSingleRow(row, indexNum, mergedPdf, isRetryPhase = false) {
    const currentDelay = isRetryPhase ? CONFIG.retryLoadDelay : CONFIG.loadDelay
    const currentMaxRetries = isRetryPhase ? CONFIG.retryMaxRound2 : CONFIG.retryMax

    try {
      const oldViewer = findPdfViewerWindow(window.top)
      if (oldViewer && oldViewer.PDFViewerApplication) oldViewer.PDFViewerApplication.url = null

      const cell = row.querySelector('td[field="index"]')
      if (cell) {
        cell.scrollIntoView({ block: 'center', behavior: 'auto' })
        const targetNode = cell.querySelector('div') || cell
        targetNode.click()
      }

      await sleep(currentDelay)

      let foundUrl = null
      for (let attempt = 0; attempt <= currentMaxRetries; attempt++) {
        const viewerWindow = findPdfViewerWindow(window.top)
        if (viewerWindow && viewerWindow.PDFViewerApplication && viewerWindow.PDFViewerApplication.url) {
          foundUrl = viewerWindow.PDFViewerApplication.url
          break
        }
        if (attempt < currentMaxRetries) await sleep(1000)
      }

      if (!foundUrl) throw new Error('超时未获取到新 PDF URL')

      const response = await fetch(foundUrl)
      if (!response.ok) throw new Error('PDF 下载失败：HTTP ' + response.status)

      const arrayBuffer = await response.arrayBuffer()
      const srcDoc = await window.PDFLib.PDFDocument.load(arrayBuffer)
      const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices())
      copiedPages.forEach((page) => mergedPdf.addPage(page))

      row.style.backgroundColor = '#dff0d8'
      console.log('序号 ' + indexNum + ': 成功，重试模式=' + isRetryPhase)
      return true
    } catch (error) {
      row.style.backgroundColor = '#f2dede'
      console.warn('序号 ' + indexNum + ': 失败 - ' + (error && error.message ? error.message : error))
      return false
    }
  }

  async function startBatchProcess() {
    if (window.__voucherMergeRunning) {
      alert('凭证合并任务正在运行，请等待当前任务完成。')
      return { ok: false, message: 'running' }
    }

    window.__voucherMergeRunning = true

    try {
      if (!window.PDFLib || !window.PDFLib.PDFDocument) {
        alert('PDF 合并库加载失败，请重新打开一体化对接页后再试。')
        return { ok: false, message: 'pdf-lib missing' }
      }

      const targetRows = findRowsRecursively(window.top)
      if (!targetRows || targetRows.length === 0) {
        alert('未找到凭证数据行。请先进入凭证列表页面，再点击“自动合并”。')
        return { ok: false, message: 'rows missing' }
      }

      if (!confirm('准备自动遍历并合并 ' + targetRows.length + ' 条凭证。\\n\\n是否开始？')) {
        return { ok: false, message: 'cancelled' }
      }

      const mergedPdf = await window.PDFLib.PDFDocument.create()
      const status = ensureStatus()
      let successCount = 0
      const failedRows = []

      for (let i = 0; i < targetRows.length; i++) {
        const row = targetRows[i]
        const indexNum = row.querySelector('td[field="index"]').innerText.trim()
        status.innerHTML =
          '<b>第 1 轮</b>: ' +
          (i + 1) +
          '/' +
          targetRows.length +
          '（序号: ' +
          indexNum +
          '）<br><span style="font-size:12px;color:#ccc">成功: ' +
          successCount +
          ' | 暂败: ' +
          failedRows.length +
          '</span>'

        const success = await processSingleRow(row, indexNum, mergedPdf, false)
        if (success) successCount++
        else failedRows.push({ row, index: indexNum })

        await sleep(CONFIG.processDelay)
      }

      if (failedRows.length > 0) {
        status.style.backgroundColor = 'rgba(200,100,0,0.9)'
        for (let i = 0; i < failedRows.length; i++) {
          const item = failedRows[i]
          status.innerHTML =
            '<b>第 2 轮补录</b>: ' +
            (i + 1) +
            '/' +
            failedRows.length +
            '<br>正在重试序号: <b>' +
            item.index +
            '</b>'

          const success = await processSingleRow(item.row, item.index, mergedPdf, true)
          if (success) successCount++
        }
      }

      status.innerHTML = '正在生成最终 PDF，稍等片刻...'
      status.style.backgroundColor = 'rgba(0,150,0,0.9)'

      const finalPdfBytes = await mergedPdf.save()
      const blob = new Blob([finalPdfBytes], { type: 'application/pdf' })
      const link = document.createElement('a')
      const objectUrl = URL.createObjectURL(blob)
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      link.href = objectUrl
      link.download = '财政凭证合并版_' + dateStr + '_(总' + successCount + '张).pdf'
      link.click()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)

      const failedCount = targetRows.length - successCount
      if (failedCount > 0) {
        alert('处理完成，但仍有 ' + failedCount + ' 条失败。请检查变红色的行。')
      } else {
        status.innerHTML = '全部下载合并成功。'
        setTimeout(() => status.remove(), 3000)
      }

      return { ok: true, successCount, failedCount }
    } finally {
      window.__voucherMergeRunning = false
    }
  }

  function compactText(element) {
    return (element && (element.innerText || element.textContent) ? element.innerText || element.textContent : '')
      .replace(/\\s+/g, '')
      .trim()
  }

  function findTextElement(doc, labels) {
    const nodes = doc.querySelectorAll('a,button,span,div,td,li')
    for (let i = 0; i < labels.length; i++) {
      for (let j = 0; j < nodes.length; j++) {
        if (compactText(nodes[j]) === labels[i]) return nodes[j]
      }
    }
    return null
  }

  function getTabInsertTarget(element) {
    if (!element || !element.closest) return element
    return element.closest('li,a,button,td') || element
  }

  function findVoucherRegisteredTabMount(doc) {
    const pageText = compactText(doc.body)
    if (!pageText.includes('直接支付入账通知书')) return null

    const textElement = findTextElement(doc, ['已登记'])
    if (!textElement) return null

    const targetElement = getTabInsertTarget(textElement)
    return { doc, targetElement }
  }

  function findLegacyTopNavMount(doc) {
    const topNav = doc.getElementById('topnav')
    if (!topNav) return null

    const spans = topNav.querySelectorAll('span')
    for (let i = 0; i < spans.length; i++) {
      if (spans[i].innerText && spans[i].innerText.includes('已登记')) {
        return { doc, targetElement: spans[i] }
      }
    }
    return null
  }

  function findButtonMount(win) {
    try {
      const doc = win.document
      const existing = doc.getElementById('my-merge-btn')
      if (existing) return { existing }

      const voucherRegisteredTabMount = findVoucherRegisteredTabMount(doc)
      if (voucherRegisteredTabMount) return voucherRegisteredTabMount

      const legacyTopNavMount = findLegacyTopNavMount(doc)
      if (legacyTopNavMount) return legacyTopNavMount

      const frames = win.frames
      for (let i = 0; i < frames.length; i++) {
        const result = findButtonMount(frames[i])
        if (result) return result
      }
    } catch (error) {}

    return null
  }

  function injectButton() {
    const mount = findButtonMount(window.top)
    if (!mount || mount.existing || !mount.doc || !mount.targetElement) return

    const btn = mount.doc.createElement('span')
    btn.id = 'my-merge-btn'
    btn.innerText = '自动合并'
    btn.style.cssText =
      'display:inline-block;margin-left:' +
      CONFIG.leftMargin +
      ';padding:5px 15px;background-color:#6610f2;color:white;border-radius:4px;cursor:pointer;font-size:14px;font-weight:bold;vertical-align:middle;line-height:20px;box-shadow:0 2px 4px rgba(0,0,0,0.1);'
    btn.onclick = function (event) {
      event.stopPropagation()
      startBatchProcess()
    }

    const target = mount.targetElement
    if (target.tagName === 'TD' && target.parentNode && target.parentNode.tagName === 'TR') {
      const cell = mount.doc.createElement('td')
      cell.appendChild(btn)
      target.parentNode.insertBefore(cell, target.nextSibling)
    } else if (target.parentNode) {
      target.parentNode.insertBefore(btn, target.nextSibling)
    }
  }

  window.__salaryVoucherMerge = { version: SCRIPT_VERSION, startBatchProcess, injectButton }
  window.addEventListener('load', injectButton)
  window.__salaryVoucherMergeTimer = window.__salaryVoucherMergeTimer || setInterval(injectButton, 1000)
  injectButton()

  if (AUTO_START) return startBatchProcess()
  return { ok: true, message: 'installed' }
})()
`
}
