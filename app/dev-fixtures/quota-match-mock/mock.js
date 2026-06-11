// 额度匹配离线仿真页（A2）
// 数据与列结构取自 2026-06-09 真实页面诊断采集（额度匹配诊断 JSON）。
// 行为复刻三条关键规律（与真实页面一致，包括"坏行为"）：
//   1) 点"修改"只切换按钮，不建行内编辑器；
//   2) 页面自己的"点单元格"才会 beginEdit 并把部门经济分类 combotree 初始化好（显示名称）；
//   3) 外部直接调 datagrid('beginEdit') 绕过初始化 → combotree 显示裸 id（如 6）→ 保存必败。
// 这样注入脚本的回归在本页上跑通，才有把握上真实页面。

/* global $ */

// ---- 本地工资汇总：必须在 02 脚本加载前写入 localStorage ----
// 数字与下方工资单行精确对应：前置总额校验 = 实发合计 − 002交通费 = 工资项未匹配总额。
;(function presetLocalSummary() {
  var summary = {
    ok: true,
    actualPayTotal: 565157.98,
    traffic002Total: 0,
    activeOtherOneTotal: 0,
    activeBasicPerformanceTotal: 100000, // 基本工资中"岗位津贴+生活补贴"→ 30107
    activeHousingTotal: 103849,
    activeAllowanceTotal: 505, // 教龄津贴
    // 没有数币卡人员的交通费留在 001 批次，页面并入「津贴补贴实发」（505+1200=1705）
    activeTraffic001Total: 1200,
    retiredHousingTotal: 64000,
    retiredBackpayTotal: 6800,
    retiredActualPayTotal: 6800,
    otherActualPayTotal: 0,
    // A4 批次交叉校验：002 实发合计须等于 002 交通费合计（本页无数币批次，均为 0）
    activeBatchActualPayTotals: { '001': 494357.98, '002': 0 },
    message: '仿真页内置汇总'
  }
  try {
    window.localStorage.setItem('__salary_quota_match_local_summary__', JSON.stringify(summary))
  } catch (e) {}
})()

function r2(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100 }
function fmtMoney(v) {
  return Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ---- 工资单（tableContent）----
var ITEM_ROWS = [
  { item_name: '基本工资实发', saltype_name: '事业', item_money: 388803.98, already_matc_amonty: 0, unalready_matc_amonty: 388803.98 },
  // 1705 = 教龄津贴 505 + 001批次交通费 1200（无数币卡人员交通费并入此项）
  { item_name: '津贴补贴实发', saltype_name: '事业', item_money: 1705, already_matc_amonty: 0, unalready_matc_amonty: 1705 },
  { item_name: '住房补贴', saltype_name: '事业', item_money: 103849, already_matc_amonty: 0, unalready_matc_amonty: 103849 },
  { item_name: '退休费实发', saltype_name: '事业退休', item_money: 6800, already_matc_amonty: 0, unalready_matc_amonty: 6800 },
  { item_name: '住房补贴', saltype_name: '事业退休', item_money: 64000, already_matc_amonty: 0, unalready_matc_amonty: 64000 }
].map(function (row) {
  row.agency_name = '沭阳县扎下初级中学'
  row.month = 6
  row.convert_status = '未匹配'
  row.item_rule_type_name = '支付凭证待生成'
  row.gov_bgt_eco_codename = ''
  row.dep_bgt_eco_codename = '00'
  row.exp_func_codename = ''
  return row
})

// ---- 可挂接指标/计划（tableSalaryLinkuQota）----
// dep_bgt_eco_id=6 故意对应 30107 绩效工资——复现"部门经济分类被显示成 6"的真实场景。
var QUOTA_ROWS = [
  q('3', '30102 津贴补贴', '50501 工资福利支出', '2050203 初中教育', 872100, 398280, '年初预算-事业人员提租补贴-津贴补贴'),
  // 津贴补贴实发（含001交通费）的主目标：30102 + 事业人员工资
  q('3', '30102 津贴补贴', '50501 工资福利支出', '2050203 初中教育', 500000, 200000, '年初预算-事业人员工资-津贴补贴'),
  q('7', '30108 机关事业单位基本养老保险缴费', '50501 工资福利支出', '2050203 初中教育', 659700, 198844.09, '年初预算-事业人员基本养老保险-机关事业单位基本养老保险缴费'),
  q('2', '30101 基本工资', '50501 工资福利支出', '2050203 初中教育', 2753659, 890261.23, '年初预算-事业人员工资-基本工资'),
  q('11', '30112 其他社会保障缴费', '50501 工资福利支出', '2050203 初中教育', 28875, 12423.5, '年初预算-事业人员工资-其他社会保障缴费'),
  q('9', '30110 职工基本医疗保险缴费', '50501 工资福利支出', '2050203 初中教育', 332250, 104962.32, '年初预算-事业人员工资-职工基本医疗保险缴费'),
  q('45', '30302 退休费', '50905 离退休费', '2210202 提租补贴', 553575, 233575, '年初预算-退休提租补贴-退休费'),
  q('6', '30107 绩效工资', '50501 工资福利支出', '2050203 初中教育', 980000, 600000, '年初预算-事业人员基础性绩效-绩效工资'),
  q('20', '30228 工会经费', '50502 商品和服务支出', '2050203 初中教育', 152400, 24900, '年初预算-事业人员工资-工会经费'),
  q('13', '30113 住房公积金', '50501 工资福利支出', '2050203 初中教育', 630900, 187506, '年初预算-事业人员住房公积金-住房公积金')
]

function q(id, depCodename, govCodename, expCodename, balanceSum, canUse, docName) {
  return {
    agency_codename: '019100 沭阳县扎下初级中学',
    dep_bgt_eco_id: id,
    dep_bgt_eco_codename: depCodename,
    gov_bgt_eco_codename: govCodename,
    exp_func_codename: expCodename,
    balance_sum_amount: balanceSum,
    balance_canuse_amount: canUse,
    real_canuse_amount: canUse,
    salary_money: 0,
    pay_money: 0,
    item_money: 0,
    balance_process: ((1 - canUse / balanceSum) * 100).toFixed(2) + '%',
    pro_codename: '3213222200001000016xx ' + docName.split('-')[1],
    pay_type_codename: '11 直接支付',
    doc_no_code: '沭财预〔2026〕00001号',
    doc_no_name: docName,
    item_remark: ''
  }
}

// 部门经济分类下拉树：页面"健康路径"点格子时才装载（同一编码多条指标行时按 id 去重）
var DEP_TREE = (function () {
  var seen = {}
  var nodes = []
  QUOTA_ROWS.forEach(function (row) {
    if (seen[row.dep_bgt_eco_id]) return
    seen[row.dep_bgt_eco_id] = true
    nodes.push({ id: row.dep_bgt_eco_id, text: row.dep_bgt_eco_codename })
  })
  return nodes
})()

var modifyMode = false
var editingIndex = null

function toggleModify(on) {
  modifyMode = on
  $('#btn-modify').toggleClass('tb-hidden', on)
  $('#btn-save').toggleClass('tb-hidden', !on)
}

function quotaGrid() { return $('#tableSalaryLinkuQota') }
function itemGrid() { return $('#tableContent') }

$(function () {
  itemGrid().datagrid({
    singleSelect: true,
    fit: false,
    data: ITEM_ROWS,
    columns: [[
      { field: 'agency_name', title: '预算单位', width: 170 },
      { field: 'month', title: '月份', width: 50, align: 'center' },
      { field: 'convert_status', title: '状态', width: 70, align: 'center' },
      { field: 'item_name', title: '工资项', width: 110 },
      { field: 'saltype_name', title: '工资类别', width: 80 },
      { field: 'item_rule_type_name', title: '生成模式', width: 120 },
      { field: 'item_money', title: '工资项总额', width: 110, align: 'right', formatter: fmtMoney },
      { field: 'already_matc_amonty', title: '已匹配金额', width: 110, align: 'right', formatter: fmtMoney },
      { field: 'unalready_matc_amonty', title: '未匹配金额', width: 110, align: 'right', formatter: fmtMoney },
      { field: 'gov_bgt_eco_codename', title: '政府支出经济分类', width: 130 },
      { field: 'dep_bgt_eco_codename', title: '部门支出经济分类', width: 130 },
      { field: 'exp_func_codename', title: '支出功能分类', width: 130 }
    ]],
    onSelect: function () {
      // 选中工资项 → 重载可挂接指标（与真实页一致），并退出修改态
      if (editingIndex != null) {
        try { quotaGrid().datagrid('cancelEdit', editingIndex) } catch (e) {}
        editingIndex = null
      }
      toggleModify(false)
      quotaGrid().datagrid('loadData', QUOTA_ROWS)
    }
  })

  quotaGrid().datagrid({
    singleSelect: true,
    fit: false,
    data: QUOTA_ROWS,
    columns: [[
      { field: 'agency_codename', title: '预算单位', width: 160 },
      {
        field: 'dep_bgt_eco_id', title: '部门支出经济分类', width: 150,
        formatter: function (value, row) { return row.dep_bgt_eco_codename },
        // 注意：editor 的 data 故意为空——只有页面自己的"点格子"处理器才会装载下拉树。
        // 外部直接 beginEdit 时这里保持空树 → 显示裸 id（复刻真实坏态）。
        editor: { type: 'combotree', options: { data: [] } }
      },
      { field: 'gov_bgt_eco_codename', title: '政府支出经济分类', width: 140 },
      { field: 'exp_func_codename', title: '支出功能分类科目', width: 130 },
      { field: 'balance_sum_amount', title: '总金额', width: 110, align: 'right', formatter: fmtMoney },
      { field: 'balance_canuse_amount', title: '额度余额', width: 110, align: 'right', formatter: fmtMoney },
      { field: 'real_canuse_amount', title: '可挂接指标/计划', width: 120, align: 'right', formatter: fmtMoney },
      { field: 'salary_money', title: '工资金额', width: 100, align: 'right', formatter: fmtMoney },
      { field: 'pay_money', title: '调整金额', width: 110, align: 'right', formatter: fmtMoney, editor: { type: 'textbox' } },
      { field: 'balance_process', title: '执行进度', width: 80, align: 'right' },
      { field: 'pro_codename', title: '指标文号', width: 200 },
      { field: 'pay_type_codename', title: '支付方式', width: 100 },
      { field: 'doc_no_code', title: '文号', width: 150 },
      { field: 'doc_no_name', title: '文号名称', width: 240 },
      { field: 'item_remark', title: '备注', width: 100 }
    ]],
    onClickCell: function (index, field) {
      // 健康路径：修改态下点任意单元格 → 页面自己 beginEdit 并把 combotree 初始化好
      if (!modifyMode) return
      if (editingIndex != null && editingIndex !== index) {
        try { quotaGrid().datagrid('endEdit', editingIndex) } catch (e) {}
      }
      quotaGrid().datagrid('beginEdit', index)
      editingIndex = index
      var row = quotaGrid().datagrid('getRows')[index]
      var depEd = quotaGrid().datagrid('getEditor', { index: index, field: 'dep_bgt_eco_id' })
      if (depEd) {
        var t = $(depEd.target)
        t.combotree('loadData', DEP_TREE)
        t.combotree('setValue', row.dep_bgt_eco_id)
      }
      if (field === 'pay_money') {
        var payEd = quotaGrid().datagrid('getEditor', { index: index, field: 'pay_money' })
        if (payEd) {
          try { $(payEd.target).textbox('textbox').focus() } catch (e) {}
        }
      }
    }
  })

  // ---- 工具栏 ----
  $('#btn-quota-match').on('click', function () {
    $.messager.confirm('确认', '是否根据工资单生成发放明细？', function (ok) {
      if (ok) $.messager.show({ title: '提示', msg: '发放明细已生成（仿真：行已预置）' })
    })
  })

  $('#btn-modify').on('click', function () {
    var selected = quotaGrid().datagrid('getSelected')
    if (!selected) {
      $.messager.alert('提示', '请先选择一条可挂接指标', 'warning')
      return
    }
    toggleModify(true)
  })

  $('#btn-save').on('click', saveCurrentEdit)

  $('#btn-create-pay').on('click', function () {
    $.messager.confirm('确认', '是否生成支付申请？', function (ok) {
      if (ok) $.messager.show({ title: '提示', msg: '支付申请已生成（仿真）' })
    })
  })

  ;['#btn-undo', '#btn-query', '#btn-back', '#btn-verify-view'].forEach(function (sel) {
    $(sel).on('click', function () {
      $.messager.show({ title: '提示', msg: $(sel).text() + '（仿真占位）' })
    })
  })
})

function saveCurrentEdit() {
  if (editingIndex == null) {
    $.messager.alert('提示', '没有处于修改状态的指标行', 'warning')
    return
  }
  var index = editingIndex
  var grid = quotaGrid()
  var row = grid.datagrid('getRows')[index]

  // 读编辑器现值（endEdit 之前）
  var depText = ''
  var depEd = grid.datagrid('getEditor', { index: index, field: 'dep_bgt_eco_id' })
  if (depEd) {
    try { depText = String($(depEd.target).combotree('getText') || '').trim() } catch (e) {}
  }
  var payVal = 0
  var payEd = grid.datagrid('getEditor', { index: index, field: 'pay_money' })
  if (payEd) {
    try { payVal = r2(parseFloat(String($(payEd.target).textbox('getValue')).replace(/,/g, '')) || 0) } catch (e) {}
  }

  // 复刻真实坏态：combotree 没被页面初始化（显示裸 id）→ 保存必败
  if (!depText || /^\d+(\.0+)?$/.test(depText)) {
    grid.datagrid('cancelEdit', index)
    editingIndex = null
    $.messager.alert('错误', '保存失败：gov_bgt_eco_id 未定义（部门经济分类编辑器未被页面正确初始化，显示值="' + (depText || '空') + '"）', 'error')
    return
  }

  var item = itemGrid().datagrid('getSelected')
  if (!item) {
    grid.datagrid('cancelEdit', index)
    editingIndex = null
    $.messager.alert('错误', '保存失败：未选择工资项', 'error')
    return
  }
  if (payVal <= 0) {
    $.messager.alert('提示', '调整金额必须大于 0', 'warning')
    return
  }
  if (payVal > r2(row.real_canuse_amount) + 0.005) {
    $.messager.alert('错误', '保存失败：调整金额超出可挂接额度余额', 'error')
    return
  }
  if (payVal > r2(item.unalready_matc_amonty) + 0.005) {
    $.messager.alert('错误', '保存失败：调整金额超出工资项未匹配金额', 'error')
    return
  }

  grid.datagrid('endEdit', index)
  editingIndex = null

  // 过账：指标占用额度，工资项未匹配金额下降（与真实页一致；调整金额清零）。
  // 注意：行对象已被原地修改，必须用 refreshRow 重绘——updateRow 会做差异比较，
  // 传同一个对象时差异为空会跳过重绘（导致 DOM 停留旧值）。
  row.salary_money = r2(row.salary_money + payVal)
  row.real_canuse_amount = r2(row.real_canuse_amount - payVal)
  row.balance_canuse_amount = r2(row.balance_canuse_amount - payVal)
  row.pay_money = 0
  grid.datagrid('refreshRow', index)

  item.already_matc_amonty = r2(item.already_matc_amonty + payVal)
  item.unalready_matc_amonty = r2(item.unalready_matc_amonty - payVal)
  if (item.unalready_matc_amonty <= 0.005) item.convert_status = '已匹配'
  var itemIndex = itemGrid().datagrid('getRows').indexOf(item)
  if (itemIndex >= 0) itemGrid().datagrid('refreshRow', itemIndex)

  toggleModify(false)
  $.messager.alert('提示', '保存成功', 'info')
}
