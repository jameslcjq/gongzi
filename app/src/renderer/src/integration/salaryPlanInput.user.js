// ==UserScript==
// @name         人员经费用款计划录入 (油猴测试版)
// @namespace    https://www.hujiuxi.top/
// @version      0.2
// @description  在一体化“一般用款计划录入”页面注入人员经费录入按钮，校验可用余额后自动勾选、批量录入、填写金额和摘要。
// @author       老九
// @match        http://172.24.147.202/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict'

  const VERSION = '0.2'
  const SHOW_PAGE_BUTTON = window.__SALARY_PLAN_INPUT_SHOW_PAGE_BUTTON !== false
  const BTN_ID = 'salary-plan-input-btn'
  const MODAL_ID = 'salary-plan-input-modal'
  const STATUS_ID = 'salary-plan-input-status'
  const DRAFT_KEY = '__salary_plan_input_draft_v1__'
  const DEFAULT_SUMMARY = '2026年第三季度人员经费'

  const ITEMS = [
    {
      key: 'baseSalary',
      label: '基本工资',
      code: '30101',
      hints: ['基本工资']
    },
    {
      key: 'allowance',
      label: '津贴补贴',
      code: '30102',
      hints: ['津贴补贴'],
      exclude: ['提租补贴', '退休提租']
    },
    {
      key: 'performance',
      label: '绩效工资',
      code: '30107',
      hints: ['绩效工资']
    },
    {
      key: 'rentSubsidy',
      label: '提租补贴',
      code: '30102',
      hints: ['提租补贴'],
      exclude: ['退休提租']
    },
    {
      key: 'pension',
      label: '养老保险',
      code: '30108',
      hints: ['养老保险']
    },
    {
      key: 'medical',
      label: '医疗保险',
      code: '30110',
      hints: ['医疗保险']
    },
    {
      key: 'otherInsurance',
      label: '其他社会保险',
      code: '30112',
      hints: ['其他社会保障', '其他社会保险']
    },
    {
      key: 'annuity',
      label: '职业年金',
      code: '30109',
      hints: ['职业年金']
    },
    {
      key: 'housingFund',
      label: '住房公积金',
      code: '30113',
      hints: ['住房公积金']
    },
    {
      key: 'contractTeacher',
      label: '合同教师',
      code: '',
      hints: ['合同教师']
    },
    {
      key: 'survivorSubsidy',
      label: '遗属补助',
      code: '30305',
      hints: ['生活补助', '遗属']
    },
    {
      key: 'retiredRentSubsidy',
      label: '退休提租补贴',
      code: '30302',
      hints: ['退休提租', '退休人员提租', '退休费']
    }
  ]

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function getStore() {
    try {
      return window.top && window.top.sessionStorage ? window.top.sessionStorage : window.sessionStorage
    } catch (error) {
      return window.sessionStorage
    }
  }

  function parseAmount(value) {
    if (value === null || value === undefined) return 0
    const text = String(value).replace(/,/g, '').replace(/\s/g, '').replace(/￥/g, '')
    if (!text) return 0
    const num = Number(text)
    return Number.isFinite(num) ? num : NaN
  }

  function formatAmount(value) {
    const num = Number(value || 0)
    return num.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, '')
  }

  function rowText(row) {
    return normalizeText(
      [
        row.dep_bgt_eco_code_name,
        row.gov_bgt_eco_code_name,
        row.pro_name,
        row.pro_code_name,
        row.bgt_dec,
        row.exp_func_code_name,
        row.agency_code_name
      ].join(' ')
    )
  }

  function matchesItem(row, item) {
    const text = rowText(row)
    if (item.code && !text.includes(item.code)) return false
    if (item.hints && item.hints.length > 0 && !item.hints.some((hint) => text.includes(hint))) {
      return false
    }
    if (item.exclude && item.exclude.some((hint) => text.includes(hint))) return false
    return true
  }

  function getJq() {
    return window.jQuery || window.$ || null
  }

  function getGridRows(gridId) {
    const $ = getJq()
    const el = document.getElementById(gridId)
    if ($ && el) {
      try {
        const rows = $('#' + gridId).datagrid('getRows')
        if (Array.isArray(rows) && rows.length > 0) {
          return rows.map((row, index) => ({ row, index }))
        }
      } catch (error) {}
    }

    return Array.from(document.querySelectorAll('#' + gridId + ' ~ .datagrid .datagrid-view2 tr.datagrid-row, .datagrid-view2 tr.datagrid-row'))
      .filter((tr) => tr.querySelector('td[field="cur_amt"]'))
      .map((tr) => {
        const row = {}
        tr.querySelectorAll('td[field]').forEach((td) => {
          const field = td.getAttribute('field')
          const span = td.querySelector('span[title]')
          row[field] = span ? span.getAttribute('title') : td.innerText.trim()
        })
        return {
          row,
          index: Number(tr.getAttribute('datagrid-row-index') || 0)
        }
      })
  }

  function getCellText(row, field) {
    const value = row && row[field]
    if (value === null || value === undefined) return ''
    return String(value)
  }

  function hasListGrid() {
    if (!document.getElementById('grid')) return false
    if (document.getElementById('batchInputGrid')) return false
    const rows = getGridRows('grid')
    if (!rows.length) return false
    return rows.some(({ row }) => 'cur_amt' in row && 'dep_bgt_eco_code_name' in row)
  }

  function hasBatchGrid() {
    return !!document.getElementById('batchInputGrid')
  }

  function status(text, kind) {
    let el = document.getElementById(STATUS_ID)
    if (!el) {
      el = document.createElement('div')
      el.id = STATUS_ID
      el.style.cssText = [
        'position:fixed',
        'top:86px',
        'right:24px',
        'z-index:2147483647',
        'min-width:280px',
        'max-width:520px',
        'padding:12px 14px',
        'border-radius:6px',
        'box-shadow:0 6px 22px rgba(0,0,0,.22)',
        'font-size:13px',
        'line-height:1.55',
        'white-space:pre-wrap',
        'color:#fff'
      ].join(';')
      document.body.appendChild(el)
    }
    el.textContent = text
    el.style.background =
      kind === 'ok'
        ? 'rgba(34,128,80,.96)'
        : kind === 'warn'
          ? 'rgba(180,125,0,.96)'
          : kind === 'err'
            ? 'rgba(180,45,45,.96)'
            : 'rgba(32,38,46,.96)'
    console.log('[salary-plan-input]', text)
  }

  function clearStatusLater(ms) {
    setTimeout(() => {
      const el = document.getElementById(STATUS_ID)
      if (el && el.parentNode) el.parentNode.removeChild(el)
    }, ms || 10000)
  }

  function findActionButton(text) {
    return Array.from(document.querySelectorAll('a,button,span')).find((el) => {
      return normalizeText(el.textContent) === normalizeText(text)
    })
  }

  function injectListButton() {
    if (!SHOW_PAGE_BUTTON) {
      const existing = document.getElementById(BTN_ID)
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
      return
    }
    if (!hasListGrid()) return
    if (document.getElementById(BTN_ID)) return

    const btn = document.createElement('a')
    btn.id = BTN_ID
    btn.href = 'javascript:void(0);'
    btn.className = 'easyui-linkbutton action-btn btn_level_1'
    btn.setAttribute('plain', 'true')
    btn.innerHTML = '<span class="l-btn-left"><span class="l-btn-text">人员经费录入</span></span>'
    btn.style.cssText = [
      'display:inline-block',
      'margin-left:6px',
      'padding:0 10px',
      'height:28px',
      'line-height:28px',
      'background:#2f80ed',
      'color:#fff',
      'border-radius:2px',
      'text-decoration:none',
      'vertical-align:middle'
    ].join(';')
    btn.addEventListener('click', openModal)

    const batchBtn = findActionButton('批量录入')
    const anchor = batchBtn && batchBtn.closest ? batchBtn.closest('a') : batchBtn
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling)
    } else {
      document.body.appendChild(btn)
    }
  }

  function modalStyle() {
    if (document.getElementById('salary-plan-input-style')) return
    const style = document.createElement('style')
    style.id = 'salary-plan-input-style'
    style.textContent = `
      #${MODAL_ID} .spi-mask {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.36);
        z-index: 2147483646;
      }
      #${MODAL_ID} .spi-panel {
        position: fixed;
        top: 54px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        width: min(920px, calc(100vw - 48px));
        max-height: calc(100vh - 96px);
        overflow: auto;
        background: #fff;
        color: #1f2933;
        border-radius: 6px;
        box-shadow: 0 18px 48px rgba(0,0,0,.28);
        font-size: 14px;
      }
      #${MODAL_ID} .spi-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        border-bottom: 1px solid #d8e0e8;
        font-weight: 700;
      }
      #${MODAL_ID} .spi-body {
        padding: 14px 18px 18px;
      }
      #${MODAL_ID} .spi-tools {
        display: grid;
        grid-template-columns: 1fr 180px;
        gap: 10px;
        margin-bottom: 12px;
      }
      #${MODAL_ID} input,
      #${MODAL_ID} select {
        box-sizing: border-box;
        width: 100%;
        height: 30px;
        border: 1px solid #b8c6d6;
        border-radius: 3px;
        padding: 4px 8px;
        font-size: 13px;
      }
      #${MODAL_ID} table {
        width: 100%;
        border-collapse: collapse;
      }
      #${MODAL_ID} th,
      #${MODAL_ID} td {
        border: 1px solid #d8e0e8;
        padding: 6px 8px;
        text-align: left;
        white-space: nowrap;
      }
      #${MODAL_ID} th {
        background: #eef5fb;
        font-weight: 700;
      }
      #${MODAL_ID} td.spi-money {
        width: 170px;
      }
      #${MODAL_ID} .spi-total {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 10px;
        padding: 10px 12px;
        background: #f0f6ff;
        border: 1px solid #c8daf2;
        border-radius: 4px;
        font-weight: 700;
      }
      #${MODAL_ID} .spi-total strong {
        min-width: 150px;
        text-align: right;
        color: #1458a8;
        font-size: 16px;
      }
      #${MODAL_ID} .spi-foot {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid #d8e0e8;
        background: #f6f8fb;
      }
      #${MODAL_ID} button {
        height: 30px;
        border: 1px solid #b8c6d6;
        border-radius: 3px;
        padding: 0 14px;
        background: #fff;
        cursor: pointer;
      }
      #${MODAL_ID} button.spi-primary {
        border-color: #2f80ed;
        background: #2f80ed;
        color: #fff;
      }
    `
    document.head.appendChild(style)
  }

  function openModal() {
    modalStyle()
    const existing = document.getElementById(MODAL_ID)
    if (existing) existing.remove()

    const modal = document.createElement('div')
    modal.id = MODAL_ID
    const rows = ITEMS.map((item) => {
      return (
        '<tr>' +
        '<td>' + item.label + '</td>' +
        '<td>' + (item.code || '按名称匹配') + '</td>' +
        '<td class="spi-money"><input data-key="' + item.key + '" inputmode="decimal" placeholder="0.00"></td>' +
        '</tr>'
      )
    }).join('')

    modal.innerHTML =
      '<div class="spi-mask"></div>' +
      '<div class="spi-panel">' +
      '<div class="spi-head"><span>人员经费用款计划录入</span><button type="button" data-close>关闭</button></div>' +
      '<div class="spi-body">' +
      '<div class="spi-tools">' +
      '<input id="spi-summary" value="' + DEFAULT_SUMMARY + '" placeholder="摘要">' +
      '<select id="spi-pay-field">' +
      '<option value="plan_amt_dir">直接支付计划金额</option>' +
      '<option value="plan_amt_auth">授权支付计划金额</option>' +
      '</select>' +
      '</div>' +
      '<table><thead><tr><th>经费项目</th><th>匹配科目</th><th>录入金额</th></tr></thead><tbody>' +
      rows +
      '</tbody></table>' +
      '<div class="spi-total"><span>录入合计</span><strong id="spi-total-amount">0.00</strong></div>' +
      '</div>' +
      '<div class="spi-foot">' +
      '<button type="button" data-check>只校验并勾选</button>' +
      '<button type="button" class="spi-primary" data-run>校验、勾选并批量录入</button>' +
      '</div>' +
      '</div>'

    modal.querySelector('[data-close]').addEventListener('click', () => modal.remove())
    modal.querySelector('.spi-mask').addEventListener('click', () => modal.remove())
    modal.querySelector('[data-check]').addEventListener('click', () => prepareSelection(false))
    modal.querySelector('[data-run]').addEventListener('click', () => prepareSelection(true))
    modal.querySelectorAll('input[data-key]').forEach((input) => {
      input.addEventListener('input', updateModalTotal)
      input.addEventListener('change', updateModalTotal)
    })
    document.body.appendChild(modal)
    updateModalTotal()
  }

  function updateModalTotal() {
    const modal = document.getElementById(MODAL_ID)
    if (!modal) return
    const totalEl = modal.querySelector('#spi-total-amount')
    if (!totalEl) return
    let total = 0
    let hasInvalid = false
    modal.querySelectorAll('input[data-key]').forEach((input) => {
      const amount = parseAmount(input.value)
      if (Number.isNaN(amount)) {
        hasInvalid = true
        return
      }
      if (amount > 0) total += amount
    })
    totalEl.textContent = hasInvalid ? '金额格式有误' : formatAmount(total)
  }

  function collectInputs() {
    const modal = document.getElementById(MODAL_ID)
    const summary = (modal && modal.querySelector('#spi-summary') ? modal.querySelector('#spi-summary').value : DEFAULT_SUMMARY).trim() || DEFAULT_SUMMARY
    const payField = modal && modal.querySelector('#spi-pay-field') ? modal.querySelector('#spi-pay-field').value : 'plan_amt_dir'
    const selected = []
    const errors = []

    ITEMS.forEach((item) => {
      const input = modal && modal.querySelector('input[data-key="' + item.key + '"]')
      const raw = input ? input.value : ''
      const amount = parseAmount(raw)
      if (Number.isNaN(amount)) {
        errors.push(item.label + ' 金额格式不正确：' + raw)
        return
      }
      if (amount > 0) {
        selected.push(Object.assign({}, item, { amount, summary, payField }))
      }
    })

    return { selected, errors, summary, payField }
  }

  function findMatches(selected) {
    const rows = getGridRows('grid')
    const usedIndexes = new Set()
    const matched = []
    const errors = []

    selected.forEach((item) => {
      const candidates = rows.filter(({ row, index }) => !usedIndexes.has(index) && matchesItem(row, item))
      if (candidates.length === 0) {
        errors.push(item.label + '：没有找到匹配的指标行')
        return
      }

      const enough = candidates.find(({ row }) => parseAmount(getCellText(row, 'cur_amt')) >= item.amount)
      if (!enough) {
        const maxCur = Math.max.apply(
          null,
          candidates.map(({ row }) => parseAmount(getCellText(row, 'cur_amt')) || 0)
        )
        errors.push(item.label + '：可用余额不足，需要 ' + formatAmount(item.amount) + '，当前匹配行最大余额 ' + formatAmount(maxCur))
        return
      }

      usedIndexes.add(enough.index)
      matched.push({
        item,
        index: enough.index,
        row: enough.row,
        signature: makeSignature(enough.row)
      })
    })

    return { matched, errors }
  }

  function makeSignature(row) {
    return normalizeText(
      [
        row.dep_bgt_eco_code_name,
        row.pro_name,
        row.pro_code_name,
        row.bgt_dec,
        row.agency_code_name
      ].join('|')
    )
  }

  function checkRows(matched) {
    const $ = getJq()
    if ($ && document.getElementById('grid')) {
      try {
        $('#grid').datagrid('clearChecked')
        $('#grid').datagrid('clearSelections')
      } catch (error) {}
      matched.forEach(({ index }) => {
        try {
          $('#grid').datagrid('checkRow', index)
          $('#grid').datagrid('selectRow', index)
        } catch (error) {
          const checkbox = document.querySelector('.datagrid-view1 tr[datagrid-row-index="' + index + '"] input[type="checkbox"]')
          if (checkbox && !checkbox.checked) checkbox.click()
        }
      })
      return
    }

    matched.forEach(({ index }) => {
      const checkbox = document.querySelector('.datagrid-view1 tr[datagrid-row-index="' + index + '"] input[type="checkbox"]')
      if (checkbox && !checkbox.checked) checkbox.click()
    })
  }

  async function prepareSelection(runBatch) {
    const { selected, errors: inputErrors, summary, payField } = collectInputs()
    if (inputErrors.length) {
      alert(inputErrors.join('\n'))
      return
    }
    if (!selected.length) {
      alert('请至少输入一项金额。')
      return
    }

    const { matched, errors } = findMatches(selected)
    if (errors.length) {
      alert('校验没有通过：\n\n' + errors.join('\n'))
      status('校验未通过：\n' + errors.join('\n'), 'err')
      return
    }

    checkRows(matched)
    const total = matched.reduce((sum, item) => sum + item.item.amount, 0)
    const lines = matched.map(({ item, row }) => {
      return item.label + ' ' + formatAmount(item.amount) + ' / 余额 ' + formatAmount(parseAmount(row.cur_amt))
    })
    status('已勾选 ' + matched.length + ' 行，合计 ' + formatAmount(total) + '\n' + lines.join('\n'), 'ok')

    const draft = {
      version: VERSION,
      createdAt: Date.now(),
      summary,
      payField,
      items: matched.map(({ item, signature }) => ({
        key: item.key,
        label: item.label,
        code: item.code,
        hints: item.hints,
        exclude: item.exclude,
        amount: item.amount,
        summary: item.summary,
        payField: item.payField,
        signature
      }))
    }
    getStore().setItem(DRAFT_KEY, JSON.stringify(draft))

    if (!runBatch) {
      alert('校验通过，已勾选对应指标行。\n\n合计：' + formatAmount(total))
      return
    }

    const modal = document.getElementById(MODAL_ID)
    if (modal) modal.remove()
    await sleep(300)
    runBatchInput()
  }

  function runBatchInput() {
    try {
      if (typeof window.inputInfoBatch === 'function') {
        window.inputInfoBatch('zfm620102001003')
        return
      }
    } catch (error) {
      console.warn('[salary-plan-input] inputInfoBatch failed', error)
    }

    const btn = findActionButton('批量录入')
    const anchor = btn && btn.closest ? btn.closest('a') : btn
    if (anchor) {
      anchor.click()
      return
    }
    alert('没有找到“批量录入”按钮，请手动点击。脚本会在批量录入页继续自动填金额。')
  }

  function readDraft() {
    try {
      const raw = getStore().getItem(DRAFT_KEY)
      if (!raw) return null
      const draft = JSON.parse(raw)
      if (!draft || !Array.isArray(draft.items)) return null
      if (Date.now() - Number(draft.createdAt || 0) > 30 * 60 * 1000) {
        getStore().removeItem(DRAFT_KEY)
        return null
      }
      return draft
    } catch (error) {
      return null
    }
  }

  function writeEditorValue(gridId, index, field, value) {
    const $ = getJq()
    if ($ && document.getElementById(gridId)) {
      try {
        $('#' + gridId).datagrid('beginEdit', index)
      } catch (error) {}
      try {
        const editor = $('#' + gridId).datagrid('getEditor', { index, field })
        if (editor && editor.target) {
          const target = $(editor.target)
          if (target.textbox) target.textbox('setValue', value)
          else if (target.numberbox) target.numberbox('setValue', value)
          else if (target.val) target.val(value).trigger('change')
        }
      } catch (error) {}
      try {
        const rows = $('#' + gridId).datagrid('getRows')
        if (rows && rows[index]) rows[index][field] = value
        const patch = {}
        patch[field] = value
        $('#' + gridId).datagrid('updateRow', { index, row: patch })
      } catch (error) {}
    }

    const cell = document.querySelector('#' + gridId + ' ~ .datagrid .datagrid-view2 tr[datagrid-row-index="' + index + '"] td[field="' + field + '"] .datagrid-cell, .datagrid-view2 tr[datagrid-row-index="' + index + '"] td[field="' + field + '"] .datagrid-cell')
    if (cell) {
      cell.textContent = value
      cell.setAttribute('title', value)
    }
  }

  function matchDraftItem(row, remaining) {
    const signature = makeSignature(row)
    let idx = remaining.findIndex((item) => item.signature === signature)
    if (idx >= 0) return idx
    idx = remaining.findIndex((item) => matchesItem(row, item))
    return idx
  }

  async function applyDraftToBatch() {
    if (!hasBatchGrid()) return
    if (window.__salaryPlanBatchApplied) return
    const draft = readDraft()
    if (!draft) return

    window.__salaryPlanBatchApplied = true
    await sleep(600)

    const rows = getGridRows('batchInputGrid')
    if (!rows.length) {
      status('批量录入页没有读到指标行，请稍后刷新或手动录入。', 'err')
      return
    }

    const remaining = draft.items.slice()
    const filled = []
    const missing = []
    rows.forEach(({ row, index }) => {
      const itemIndex = matchDraftItem(row, remaining)
      if (itemIndex < 0) return
      const item = remaining.splice(itemIndex, 1)[0]
      const payField = item.payField || draft.payField || 'plan_amt_dir'
      writeEditorValue('batchInputGrid', index, payField, String(item.amount))
      const otherField = payField === 'plan_amt_dir' ? 'plan_amt_auth' : 'plan_amt_dir'
      writeEditorValue('batchInputGrid', index, otherField, '')
      writeEditorValue('batchInputGrid', index, 'use_des', item.summary || draft.summary || DEFAULT_SUMMARY)
      filled.push(item)
    })

    remaining.forEach((item) => missing.push(item.label))

    if (missing.length) {
      status('已填写 ' + filled.length + ' 项，但这些项目没有匹配到批量录入行：\n' + missing.join('、'), 'warn')
      alert('有项目没有匹配到批量录入行，请检查后手动补录：\n\n' + missing.join('\n'))
      return
    }

    const total = filled.reduce((sum, item) => sum + Number(item.amount || 0), 0)
    status('批量录入页已填写 ' + filled.length + ' 项，合计 ' + formatAmount(total) + '。\n请核对页面金额和摘要。', 'ok')

    if (confirm('已自动填写批量录入页。\n\n合计：' + formatAmount(total) + '\n摘要：' + (draft.summary || DEFAULT_SUMMARY) + '\n\n确认无误后，是否现在“保存并送审”？')) {
      try {
        getStore().removeItem(DRAFT_KEY)
        if (typeof window.inputInfoBatchSave === 'function') {
          window.inputInfoBatchSave('send')
          return
        }
      } catch (error) {
        console.warn('[salary-plan-input] inputInfoBatchSave failed', error)
      }
      const saveBtn = findActionButton('保存并送审')
      const anchor = saveBtn && saveBtn.closest ? saveBtn.closest('a') : saveBtn
      if (anchor) anchor.click()
      else alert('没有找到“保存并送审”按钮，请手动点击。')
    }
  }

  function boot() {
    try {
      injectListButton()
      applyDraftToBatch()
    } catch (error) {
      console.warn('[salary-plan-input] boot failed', error)
    }
  }

  function openFromToolbar() {
    if (!hasListGrid()) {
      return { ok: false, message: '当前页面不是一般用款计划录入列表页' }
    }
    openModal()
    return { ok: true, message: 'opened' }
  }

  window.__salaryPlanInput = {
    version: VERSION,
    canOpen: hasListGrid,
    openFromToolbar,
    boot,
    applyDraftToBatch
  }

  boot()
  setInterval(boot, 1200)
})()
