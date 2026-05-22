#!/usr/bin/env node
/**
 * 一次性迁移脚本：
 *   读 sample 预算 xls → 为每个 visible sheet 生成 "全限定列名" 列表
 *   对应的 worksheet 元数据按位置 + 归一化名做双重校验，
 *   写入 importSource 字段，并把结果保存回 docs/data/worksheets-retained.json。
 *
 * 用法：
 *   node scripts/generateBudgetImportSource.js <xls 路径>
 */

const fs = require('fs')
const path = require('path')
const xlsx = require(path.join(__dirname, '..', 'app', 'node_modules', 'xlsx'))

const REPO_ROOT = path.resolve(__dirname, '..')
const METADATA_PATH = path.join(REPO_ROOT, 'docs', 'data', 'worksheets-retained.json')

// xls sheet 名 → worksheet 名 映射
const SHEET_TO_WORKSHEET = {
  '事业在职在编人员信息情况表': '预算在职',
  '事业退休人员信息情况表': '预算退休',
  '其他人员表': '预算其他'
}

function normalize(s) {
  return String(s || '')
    .replace(/[*＊]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

function buildFullName(group, leaf) {
  const g = String(group || '').trim()
  const l = String(leaf || '').trim()
  if (!g || g === l) return l
  return g + '_' + l
}

function dedupe(names) {
  const counts = new Map()
  const result = []
  names.forEach((name) => {
    const c = (counts.get(name) || 0) + 1
    counts.set(name, c)
    result.push(c === 1 ? name : `${name}#${c}`)
  })
  return result
}

function detectFirstDataRow(rows) {
  // 表头 row 0/1 是标题/单位，row 2 起是分组/字段名层。逐行往下找第一行"看起来是数据"。
  // 数据行特征：col 0 是"合计"或纯数字（序号），或一行里数字单元格 > 30%
  for (let r = 2; r < Math.min(15, rows.length); r++) {
    const row = rows[r] || []
    const col0 = String(row[0] || '').trim()
    if (col0 === '合计' || /^\d+$/.test(col0)) return r
    const numericCount = row.filter((c) => {
      const s = String(c || '').trim()
      return s.length > 0 && /^[\d,\.]+$/.test(s)
    }).length
    if (numericCount > row.length * 0.3) return r
  }
  return 6
}

function extractFullNames(sheet) {
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  const firstDataRow = detectFirstDataRow(rows)
  // 表头取 rows[2 .. firstDataRow-1]
  const headerRows = []
  for (let r = 2; r < firstDataRow; r++) headerRows.push(rows[r] || [])
  const width = Math.max(...headerRows.map((r) => r.length))
  const raw = []
  for (let i = 0; i < width; i++) {
    // 拿这列在 4 行表头里的值，去空、去重复
    const segments = headerRows
      .map((row) => String(row[i] || '').trim())
      .filter((s) => s.length > 0)
    // 去掉连续重复（如 ["人员基本情况","性别","性别","性别"] → ["人员基本情况","性别"]）
    const deduped = []
    for (const s of segments) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== s) {
        deduped.push(s)
      }
    }
    raw.push(deduped.length ? deduped.join('_') : '')
  }
  // 同一 sheet 内若 xls 自身存在完全相同的全限定名，加 #2 #3 后缀消歧
  return dedupe(raw)
}

function getHeaderEndRow() {
  // 表头一共 6 行（rows 0-5），数据从 row 6 开始。导出脚本中也按此切片
  return 6
}

function main() {
  const xlsPath = process.argv[2]
  if (!xlsPath) {
    console.error('用法: node generateBudgetImportSource.js <xls 路径>')
    process.exit(1)
  }
  if (!fs.existsSync(xlsPath)) {
    console.error('xls 文件不存在: ' + xlsPath)
    process.exit(1)
  }

  const wb = xlsx.readFile(xlsPath)
  const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf-8'))

  let mutated = 0
  const reports = []

  for (const [sheetName, worksheetName] of Object.entries(SHEET_TO_WORKSHEET)) {
    if (!wb.Sheets[sheetName]) {
      console.warn(`⚠ xls 里没有 sheet: ${sheetName}，跳过`)
      continue
    }
    const sheetRows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' })
    const firstDataRow = detectFirstDataRow(sheetRows)
    console.log(
      `\n📐 [${sheetName}] 表头 = rows[2..${firstDataRow - 1}]（${firstDataRow - 2} 行），数据从 row ${firstDataRow} 起`
    )
    const fullNames = extractFullNames(wb.Sheets[sheetName])
    const ws = metadata.find((w) => w.name === worksheetName)
    if (!ws) {
      console.warn(`⚠ 元数据里没有 worksheet: ${worksheetName}，跳过`)
      continue
    }

    if (fullNames.length !== ws.fields.length) {
      console.warn(
        `⚠ ${worksheetName} 字段数 ${ws.fields.length} ≠ xls 列数 ${fullNames.length}，按较短的长度匹配`
      )
    }
    const len = Math.min(fullNames.length, ws.fields.length)

    const sheetReport = { worksheet: worksheetName, total: len, autoOk: 0, mismatched: [], skipped: 0 }
    for (let i = 0; i < len; i++) {
      const field = ws.fields[i]
      const xlsFullName = fullNames[i]
      if (!xlsFullName) {
        sheetReport.skipped++
        continue
      }
      // 双重校验：把字段当前名（去掉前缀）和 xls leaf 名归一化对比
      const xlsLeaf = xlsFullName.includes('_') ? xlsFullName.split('_').pop() : xlsFullName
      const ok = normalize(field.name) === normalize(xlsLeaf)
      if (!ok) {
        sheetReport.mismatched.push({
          position: i,
          currentName: field.name,
          xlsFullName,
          xlsLeaf
        })
      } else {
        sheetReport.autoOk++
      }
      field.importSource = xlsFullName
      mutated++
    }
    reports.push(sheetReport)
  }

  fs.writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2) + '\n', 'utf-8')

  console.log('\n========== 迁移报告 ==========')
  reports.forEach((r) => {
    console.log(`\n【${r.worksheet}】 共 ${r.total} 字段 / 自动通过 ${r.autoOk} / 不一致 ${r.mismatched.length}`)
    if (r.mismatched.length) {
      console.log('  ⚠ 位置 + 名字 不完全一致（已按位置写入 importSource，但请人工 sanity check）：')
      r.mismatched.forEach((m) => {
        console.log(
          `    [${String(m.position).padStart(2, '0')}] worksheet "${m.currentName}"  ←  xls "${m.xlsFullName}"`
        )
      })
    }
  })
  console.log(`\n✅ 共写入 ${mutated} 个 importSource，元数据已更新：${METADATA_PATH}`)
}

main()
