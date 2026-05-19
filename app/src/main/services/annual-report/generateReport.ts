import * as fs from 'node:fs'
import * as path from 'node:path'
import * as XLSX from 'xlsx'

const STAFF_SHEET = '事业单位工作人员信息表'
const CONFIG_SHEET = '事业单位信息表'
const COL_A = 0
const COL_C_ID_CARD = 2
const COL_AF = 31
const COL_AT = 45
const HEADER_ROWS = 6
const STAFF_FIRST_DATA_ROW = 6
const CONFIG_DATA_ROW = 5
const CONFIG_UNIT_NAME_COL = 6

export interface GenerateAnnualReportInput {
  templatePath: string
  lastYearPath: string
  blank2025Path: string
  yitihuaPath?: string
  totalPerformance: number
  totalHeadTeacher: number
  totalOvertime: number
}

export interface GenerateAnnualReportResult {
  outputPath: string
  archiveDir: string
  unitName: string
  staffCount: number
  totalPerformance: number
  totalOvertime: number
  movedFiles: string[]
}

export async function generateAnnualReport(
  input: GenerateAnnualReportInput
): Promise<GenerateAnnualReportResult> {
  ensureFile(input.templatePath, '工资年报模板')
  ensureFile(input.lastYearPath, '事业单位表（去年）')
  ensureFile(input.blank2025Path, '事业单位表2025')
  if (input.yitihuaPath) ensureFile(input.yitihuaPath, '一体化')

  const wbTemplate = XLSX.readFile(input.templatePath, { cellStyles: true, cellNF: true })
  const wbLastYear = XLSX.readFile(input.lastYearPath, { cellStyles: true, cellNF: true })
  const wbOut = XLSX.readFile(input.blank2025Path, { cellStyles: true, cellNF: true })

  const wsStaffSrc = wbTemplate.Sheets[STAFF_SHEET]
  const wsStaffDest = wbOut.Sheets[STAFF_SHEET]
  const wsConfigSrc = wbLastYear.Sheets[CONFIG_SHEET]
  const wsConfigDest = wbOut.Sheets[CONFIG_SHEET]
  if (!wsStaffSrc) throw new Error(`模板缺少表「${STAFF_SHEET}」`)
  if (!wsStaffDest) throw new Error(`输出底板缺少表「${STAFF_SHEET}」`)
  if (!wsConfigSrc) throw new Error(`去年表缺少表「${CONFIG_SHEET}」`)
  if (!wsConfigDest) throw new Error(`输出底板缺少表「${CONFIG_SHEET}」`)

  copyRowsByValues(wsStaffSrc, wsStaffDest, STAFF_FIRST_DATA_ROW, COL_C_ID_CARD)
  copyRowByValues(wsConfigSrc, wsConfigDest, CONFIG_DATA_ROW)

  const { rowCount, lastRow } = countStaffRows(wsStaffDest)

  if (rowCount > 0) {
    distributeAmounts({
      sheet: wsStaffDest,
      lastRow,
      rowCount,
      totalSum1: input.totalPerformance + input.totalHeadTeacher,
      totalOvertime: input.totalOvertime
    })
    truncateTrailingRows(wsStaffDest, lastRow)
  }

  const unitName = readUnitName(wsConfigDest)
  const outputDir = path.dirname(path.resolve(input.blank2025Path))
  const folderName = `${unitName}2025`
  const outFileName = `${unitName}2025.xlsx`
  const initialOutPath = path.join(outputDir, outFileName)

  XLSX.writeFile(wbOut, initialOutPath, { compression: true, cellStyles: true })

  const archiveDir = path.join(outputDir, folderName)
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true })

  const movedFiles: string[] = []
  const finalOutPath = moveFile(initialOutPath, archiveDir, movedFiles)
  if (input.yitihuaPath) moveFile(input.yitihuaPath, archiveDir, movedFiles)
  moveFile(input.lastYearPath, archiveDir, movedFiles)

  return {
    outputPath: finalOutPath,
    archiveDir,
    unitName,
    staffCount: rowCount,
    totalPerformance: input.totalPerformance + input.totalHeadTeacher,
    totalOvertime: input.totalOvertime,
    movedFiles
  }
}

function ensureFile(filePath: string, label: string): void {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`未找到「${label}」文件：${filePath}`)
  }
}

function readSheetRange(sheet: XLSX.WorkSheet): XLSX.Range {
  if (!sheet['!ref']) return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }
  return XLSX.utils.decode_range(sheet['!ref'])
}

function copyRowsByValues(
  src: XLSX.WorkSheet,
  dest: XLSX.WorkSheet,
  fromRowIndex: number,
  textColIndex: number
): void {
  const srcRange = readSheetRange(src)
  const destRange = readSheetRange(dest)
  for (let r = fromRowIndex; r <= srcRange.e.r; r++) {
    let rowHasValue = false
    for (let c = srcRange.s.c; c <= srcRange.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const srcCell = src[addr]
      if (!srcCell || srcCell.v === undefined || srcCell.v === null || srcCell.v === '') continue
      rowHasValue = true
      const destCell: XLSX.CellObject = c === textColIndex
        ? { t: 's', v: String(srcCell.v) }
        : { t: srcCell.t ?? 's', v: srcCell.v }
      if (srcCell.w !== undefined) destCell.w = srcCell.w
      dest[addr] = destCell
    }
    if (!rowHasValue) {
      for (let c = srcRange.s.c; c <= srcRange.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c })
        if (dest[addr]) delete dest[addr]
      }
    }
  }
  destRange.e.r = Math.max(destRange.e.r, srcRange.e.r)
  destRange.e.c = Math.max(destRange.e.c, srcRange.e.c)
  if (destRange.s.r === undefined) destRange.s.r = 0
  if (destRange.s.c === undefined) destRange.s.c = 0
  dest['!ref'] = XLSX.utils.encode_range(destRange)
}

function copyRowByValues(src: XLSX.WorkSheet, dest: XLSX.WorkSheet, rowIndex: number): void {
  const srcRange = readSheetRange(src)
  const destRange = readSheetRange(dest)
  for (let c = srcRange.s.c; c <= srcRange.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: rowIndex, c })
    const srcCell = src[addr]
    if (!srcCell) continue
    dest[addr] = { t: srcCell.t ?? 's', v: srcCell.v, ...(srcCell.w !== undefined ? { w: srcCell.w } : {}) }
  }
  destRange.e.r = Math.max(destRange.e.r, rowIndex)
  destRange.e.c = Math.max(destRange.e.c, srcRange.e.c)
  if (destRange.s.r === undefined) destRange.s.r = 0
  if (destRange.s.c === undefined) destRange.s.c = 0
  dest['!ref'] = XLSX.utils.encode_range(destRange)
}

function countStaffRows(sheet: XLSX.WorkSheet): { rowCount: number; lastRow: number } {
  const range = readSheetRange(sheet)
  const upperBound = range.e.r + 100
  let rowCount = 0
  let lastRow = HEADER_ROWS - 1
  for (let r = STAFF_FIRST_DATA_ROW; r <= upperBound; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: COL_A })
    const cell = sheet[addr]
    const value = cell?.v
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      rowCount += 1
      lastRow = r
    } else {
      break
    }
  }
  return { rowCount, lastRow }
}

function distributeAmounts(args: {
  sheet: XLSX.WorkSheet
  lastRow: number
  rowCount: number
  totalSum1: number
  totalOvertime: number
}): void {
  const { sheet, lastRow, rowCount, totalSum1, totalOvertime } = args
  const avg1 = Math.round(totalSum1 / rowCount)
  const avg2 = Math.round(totalOvertime / rowCount)
  let sumAF = 0
  let sumAT = 0

  for (let r = STAFF_FIRST_DATA_ROW; r < lastRow; r++) {
    const r1 = Math.trunc(avg1 + Math.floor(Math.random() * 10001) - 5000)
    sheet[XLSX.utils.encode_cell({ r, c: COL_AF })] = { t: 'n', v: r1 }
    sumAF += r1
    const r2 = Math.trunc(avg2 + Math.floor(Math.random() * 10001) - 5000)
    sheet[XLSX.utils.encode_cell({ r, c: COL_AT })] = { t: 'n', v: r2 }
    sumAT += r2
  }
  sheet[XLSX.utils.encode_cell({ r: lastRow, c: COL_AF })] = {
    t: 'n',
    v: Math.trunc(totalSum1 - sumAF)
  }
  sheet[XLSX.utils.encode_cell({ r: lastRow, c: COL_AT })] = {
    t: 'n',
    v: Math.trunc(totalOvertime - sumAT)
  }
}

function truncateTrailingRows(sheet: XLSX.WorkSheet, lastRow: number): void {
  const range = readSheetRange(sheet)
  if (range.e.r <= lastRow) return
  for (let r = lastRow + 1; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      if (sheet[addr]) delete sheet[addr]
    }
  }
  range.e.r = lastRow
  sheet['!ref'] = XLSX.utils.encode_range(range)
}

function readUnitName(sheet: XLSX.WorkSheet): string {
  const addr = XLSX.utils.encode_cell({ r: CONFIG_DATA_ROW, c: CONFIG_UNIT_NAME_COL })
  const cell = sheet[addr]
  const raw = cell?.v
  const value = raw === undefined || raw === null ? '' : String(raw).trim()
  return value || '学校'
}

function moveFile(src: string, archiveDir: string, log: string[]): string {
  if (!fs.existsSync(src)) return src
  const target = path.join(archiveDir, path.basename(src))
  if (path.resolve(src) === path.resolve(target)) {
    log.push(target)
    return target
  }
  if (fs.existsSync(target)) {
    fs.rmSync(target, { force: true })
  }
  fs.renameSync(src, target)
  log.push(target)
  return target
}
