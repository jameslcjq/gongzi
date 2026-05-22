#!/usr/bin/env node
/**
 * 一次性脚本：根据 sample xls 的"行政在职在编"和"行政离退休"两张 sheet
 * 在 worksheets-retained.json 里新建对应的两张 worksheet：
 *   预算行政在职 / 预算行政离退休
 * 字段名直接用 xls 全限定名（从 row 2..N 拼接），name == importSource。
 */

const fs = require('fs')
const path = require('path')
const xlsx = require(path.join(__dirname, '..', 'app', 'node_modules', 'xlsx'))

const REPO_ROOT = path.resolve(__dirname, '..')
const METADATA_PATH = path.join(REPO_ROOT, 'docs', 'data', 'worksheets-retained.json')

const TARGETS = [
  {
    sheetName: '行政在职在编人员信息情况表',
    worksheetName: '预算行政在职',
    fieldIdPrefix: 'budget_gov_active_v1_'
  },
  {
    sheetName: '行政离退休人员信息情况表',
    worksheetName: '预算行政离退休',
    fieldIdPrefix: 'budget_gov_retired_v1_'
  }
]

function detectFirstDataRow(rows) {
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
  const headerRows = []
  for (let r = 2; r < firstDataRow; r++) headerRows.push(rows[r] || [])
  const width = Math.max(...headerRows.map((r) => r.length))
  const result = []
  for (let i = 0; i < width; i++) {
    const segments = headerRows
      .map((row) => String(row[i] || '').trim())
      .filter((s) => s.length > 0)
    const deduped = []
    for (const s of segments) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== s) deduped.push(s)
    }
    result.push(deduped.join('_'))
  }
  // 同 sheet 内全限定名去重（极少见）
  const counts = new Map()
  return result.map((n) => {
    const c = (counts.get(n) || 0) + 1
    counts.set(n, c)
    return c === 1 ? n : `${n}#${c}`
  })
}

function main() {
  const xlsPath = process.argv[2]
  if (!xlsPath || !fs.existsSync(xlsPath)) {
    console.error('用法: node createBudgetGovWorksheets.js <xls 路径>')
    process.exit(1)
  }
  const wb = xlsx.readFile(xlsPath)
  const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf-8'))

  for (const target of TARGETS) {
    if (!wb.Sheets[target.sheetName]) {
      console.warn(`⚠ xls 缺 sheet: ${target.sheetName}，跳过`)
      continue
    }
    const fullNames = extractFullNames(wb.Sheets[target.sheetName])
    console.log(`📐 [${target.sheetName}] → ${target.worksheetName}：${fullNames.length} 列`)

    const existing = metadata.find((w) => w.name === target.worksheetName)
    if (existing) {
      console.warn(`⚠ ${target.worksheetName} 已存在，覆盖更新字段定义（保留 worksheetId）`)
    }

    const fields = fullNames.map((fullName, idx) => {
      const seq = String(idx + 1).padStart(3, '0')
      return {
        fieldId: target.fieldIdPrefix + seq,
        name: fullName,
        type: '文本框',
        controlType: 2,
        importSource: fullName
      }
    })

    const worksheetId = (existing && existing.worksheetId) || target.fieldIdPrefix + 'sheet'
    const newWs = {
      name: target.worksheetName,
      worksheetId,
      fieldCount: fields.length,
      fields,
      systemFields: existing ? existing.systemFields || [] : [],
      views: existing ? existing.views || [] : []
    }
    if (existing) {
      const idx = metadata.indexOf(existing)
      metadata[idx] = newWs
    } else {
      metadata.push(newWs)
    }
  }

  fs.writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2) + '\n', 'utf-8')
  console.log(`\n✅ 已写入 ${METADATA_PATH}`)
}

main()
