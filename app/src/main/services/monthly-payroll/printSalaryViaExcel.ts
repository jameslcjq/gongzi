import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseSalaryWorkbook, parseTaxWorkbook } from './monthlyPayrollParsers'
import type { MonthlyPayrollSalaryPrintPageSummary } from '../../../shared/types'

export type PrintSalaryViaExcelRequest = {
  salaryWorkbookPath: string
  salaryWorkbookFallbackPaths?: string[]
  taxWorkbookPath?: string
  printerName?: string
  invoicePaperName?: string
}

export type WriteTaxToSalaryRequest = {
  salaryWorkbookPath: string
  taxByIdCard: Record<string, number>
}

const DEFAULT_INVOICE_PAPER_NAME = '发票'
const SALARY_SHEETS = ['公办在职', '遗补', '遗属补助']

export async function writeTaxToSalaryWorkbookViaExcel(
  request: WriteTaxToSalaryRequest
): Promise<void> {
  if (Object.keys(request.taxByIdCard).length === 0) return
  ensureFileExists(request.salaryWorkbookPath, '工资表文件不存在，无法回写个税')
  const script = buildWriteTaxScript({
    salaryWorkbookPath: request.salaryWorkbookPath,
    taxByIdCard: request.taxByIdCard
  })
  await runPowerShellScript(script, 'Excel 回写工资表个税失败')
}

export async function printSalaryWorkbookViaExcel(
  request: PrintSalaryViaExcelRequest
): Promise<void> {
  const salaryWorkbookPath = resolveSalaryWorkbookPath(request)
  ensureFileExists(salaryWorkbookPath, '工资表文件不存在，无法打印工资表')
  const taxByIdCard = request.taxWorkbookPath
    ? await buildTaxByIdCardMap(salaryWorkbookPath, request.taxWorkbookPath)
    : {}

  const script = buildPowerShellScript({
    salaryWorkbookPath,
    printerName: request.printerName ?? '',
    invoicePaperName: request.invoicePaperName ?? DEFAULT_INVOICE_PAPER_NAME,
    taxByIdCard,
    salarySheetNames: SALARY_SHEETS
  })
  await runPowerShellScript(script, 'Excel 处理工资表失败')
}

export async function getSalaryWorkbookPrintPageSummary(
  request: PrintSalaryViaExcelRequest
): Promise<MonthlyPayrollSalaryPrintPageSummary> {
  const salaryWorkbookPath = resolveSalaryWorkbookPath(request)
  if (!salaryWorkbookPath || !existsSync(salaryWorkbookPath)) return emptySalaryPrintPageSummary()
  const script = buildPageSummaryScript({
    salaryWorkbookPath,
    printerName: request.printerName ?? '',
    invoicePaperName: request.invoicePaperName ?? DEFAULT_INVOICE_PAPER_NAME,
    salarySheetNames: SALARY_SHEETS
  })
  const output = await runPowerShellScript(script, 'Excel 统计工资表打印页数失败')
  const jsonLine = output.trim().split(/\r?\n/).find((line) => line.trim().startsWith('{'))
  if (!jsonLine) throw new Error('Excel 统计工资表打印页数失败：未返回统计结果')
  return JSON.parse(jsonLine) as MonthlyPayrollSalaryPrintPageSummary
}

function resolveSalaryWorkbookPath(request: PrintSalaryViaExcelRequest): string {
  const candidates = [
    request.salaryWorkbookPath,
    ...(request.salaryWorkbookFallbackPaths ?? [])
  ].filter((item): item is string => Boolean(item))
  return candidates.find((item) => existsSync(item)) ?? request.salaryWorkbookPath
}

function ensureFileExists(filePath: string, message: string): void {
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`${message}：${filePath || '未提供路径'}`)
  }
}

function emptySalaryPrintPageSummary(): MonthlyPayrollSalaryPrintPageSummary {
  return { items: [], totalPages: 0 }
}

async function runPowerShellScript(script: string, errorPrefix: string): Promise<string> {
  const encoded = Buffer.from(buildPowerShellPreamble() + script, 'utf16le').toString('base64')
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      reject(new Error(`无法启动 PowerShell：${error.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      const message = cleanPowerShellError(stderr) || `PowerShell 退出码 ${code}`
      reject(new Error(`${errorPrefix}：${message}`))
    })
  })
}

function buildPowerShellPreamble(): string {
  return `
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
`
}

function cleanPowerShellError(stderr: string): string {
  const trimmed = stderr.trim()
  if (!trimmed) return ''
  if (!trimmed.startsWith('#< CLIXML')) return trimmed

  const errorParts = Array.from(trimmed.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g))
    .map((match) => decodePowerShellXmlText(match[1]))
    .join('')
  const lines = errorParts
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('_x000D__x000A_'))
    .filter((line) => !line.startsWith('+ '))
    .filter((line) => !line.startsWith('CategoryInfo'))
    .filter((line) => !line.startsWith('FullyQualifiedErrorId'))
  return lines.slice(-3).join('\n') || trimmed
}

function decodePowerShellXmlText(value: string): string {
  return value
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/_x000D_/g, '\r')
    .replace(/_x000A_/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function buildWriteTaxScript(input: {
  salaryWorkbookPath: string
  taxByIdCard: Record<string, number>
}): string {
  const pathLit = psString(input.salaryWorkbookPath)
  const taxJsonLit = psString(JSON.stringify(input.taxByIdCard))
  return `
$ErrorActionPreference = 'Stop'
$Path = ${pathLit}
$TaxJson = ${taxJsonLit}

$TaxMap = @{}
try {
  $obj = $TaxJson | ConvertFrom-Json
  if ($obj) {
    foreach ($prop in $obj.PSObject.Properties) {
      $TaxMap[$prop.Name] = [double]$prop.Value
    }
  }
} catch {}

if ($TaxMap.Count -eq 0) { exit 0 }

$xl = $null
$wb = $null
try {
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false

  $wb = $xl.Workbooks.Open($Path, 3, $false)

  $wsActive = $null
  try { $wsActive = $wb.Sheets.Item('公办在职') } catch { $wsActive = $null }
  if ($null -eq $wsActive) { throw "工资表中未找到 公办在职 工作表" }

  $usedRange = $wsActive.UsedRange
  $lastRow = $usedRange.Rows.Count
  $applied = 0
  for ($r = 2; $r -le $lastRow; $r++) {
    $idValue = $wsActive.Cells.Item($r, 3).Value2
    if ($null -eq $idValue) { continue }
    $idText = ([string]$idValue).Trim().ToUpper()
    if (-not $idText) { continue }
    if ($TaxMap.ContainsKey($idText)) {
      $taxCell = $wsActive.Cells.Item($r, 25)
      $taxCell.Value2 = [double]$TaxMap[$idText]
      $taxCell.NumberFormat = "0.00"
      $applied += 1
    }
  }

  if ($applied -gt 0) {
    $xl.CalculateFull()
    for ($r = 2; $r -le $lastRow; $r++) {
      $nameText = ([string]$wsActive.Cells.Item($r, 5).Text).Trim()
      if ($nameText -and $nameText.Contains("合计")) {
        $wsActive.Cells.Item($r, 25).NumberFormat = "0.00"
      }
    }
    $wb.Save()
  }

  $wb.Close($false)
  $xl.Quit()
  Write-Output ("taxApplied=$applied")
  exit 0
} catch {
  try { if ($wb) { $wb.Close($false) } } catch {}
  try { if ($xl) { $xl.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($wb) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
  if ($xl) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`
}

async function buildTaxByIdCardMap(
  salaryWorkbookPath: string,
  taxWorkbookPath: string
): Promise<Record<string, number>> {
  const [salary, tax] = await Promise.all([
    parseSalaryWorkbook(salaryWorkbookPath),
    parseTaxWorkbook(taxWorkbookPath)
  ])
  const salaryIdCards = new Set(salary.activePeople.map((person) => person.idCard))
  const map: Record<string, number> = {}
  for (const row of tax.rows) {
    if (!row.idCard || !salaryIdCards.has(row.idCard)) continue
    map[row.idCard] = row.taxAmount
  }
  return map
}

type ScriptInput = {
  salaryWorkbookPath: string
  printerName: string
  invoicePaperName: string
  taxByIdCard: Record<string, number>
  salarySheetNames: string[]
}

function buildPowerShellScript(input: ScriptInput): string {
  const pathLit = psString(input.salaryWorkbookPath)
  const printerLit = psString(input.printerName)
  const paperNameLit = psString(input.invoicePaperName)
  const sheetsLit = input.salarySheetNames.map(psString).join(', ')
  const taxJsonLit = psString(JSON.stringify(input.taxByIdCard))

  return `
$ErrorActionPreference = 'Stop'
$Path = ${pathLit}
$PrinterName = ${printerLit}
$InvoicePaperName = ${paperNameLit}
$SheetNames = @(${sheetsLit})
$TaxJson = ${taxJsonLit}

$TaxMap = @{}
try {
  $obj = $TaxJson | ConvertFrom-Json
  if ($obj) {
    foreach ($prop in $obj.PSObject.Properties) {
      $TaxMap[$prop.Name] = [double]$prop.Value
    }
  }
} catch {}

$PaperId = 9
try {
  Add-Type -AssemblyName System.Drawing
  if ($PrinterName -and $PrinterName.Length -gt 0) {
    $prSet = New-Object System.Drawing.Printing.PrinterSettings
    $prSet.PrinterName = $PrinterName
    foreach ($p in $prSet.PaperSizes) {
      if ($p.PaperName -match $InvoicePaperName -and $p.RawKind -ge 256) {
        $PaperId = [int]$p.RawKind
        break
      }
    }
  }
} catch {}

$xl = $null
$wb = $null
try {
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false

  $wb = $xl.Workbooks.Open($Path, 3, $false)

  if ($PrinterName -and $PrinterName.Length -gt 0) {
    $resolved = $null
    try {
      $escaped = $PrinterName -replace "'", "''"
      $printerInfo = Get-CimInstance -ClassName Win32_Printer -Filter ("Name = '" + $escaped + "'") -ErrorAction SilentlyContinue
      if ($printerInfo) {
        $resolved = "$PrinterName on " + $printerInfo.PortName
      }
    } catch {}
    foreach ($candidate in @($resolved, $PrinterName)) {
      if (-not $candidate) { continue }
      try {
        $xl.ActivePrinter = $candidate
        break
      } catch {}
    }
  }

  $taxApplied = 0
  if ($TaxMap.Count -gt 0) {
    $wsActive = $null
    try { $wsActive = $wb.Sheets.Item('公办在职') } catch { $wsActive = $null }
    if ($null -ne $wsActive) {
      $usedRange = $wsActive.UsedRange
      $lastRow = $usedRange.Rows.Count
      for ($r = 2; $r -le $lastRow; $r++) {
        $idValue = $wsActive.Cells.Item($r, 3).Value2
        if ($null -eq $idValue) { continue }
        $idText = ([string]$idValue).Trim().ToUpper()
        if (-not $idText) { continue }
        if ($TaxMap.ContainsKey($idText)) {
          $taxCell = $wsActive.Cells.Item($r, 25)
          $taxCell.Value2 = [double]$TaxMap[$idText]
          $taxCell.NumberFormat = "0.00"
          $taxApplied += 1
        }
      }
      if ($taxApplied -gt 0) {
        $xl.CalculateFull()
        for ($r = 2; $r -le $lastRow; $r++) {
          $nameText = ([string]$wsActive.Cells.Item($r, 5).Text).Trim()
          if ($nameText -and $nameText.Contains("合计")) {
            $wsActive.Cells.Item($r, 25).NumberFormat = "0.00"
          }
        }
        $wb.Save()
      }
    }
  }

  $printed = 0
  $seenSheets = @{}
  foreach ($name in $SheetNames) {
    $ws = $null
    try { $ws = $wb.Sheets.Item($name) } catch { $ws = $null }
    if ($null -eq $ws) { continue }
    if ($seenSheets.ContainsKey($ws.Name)) { continue }
    $seenSheets[$ws.Name] = $true

    $pageSetup = $ws.PageSetup
    $pageSetup.Orientation = 1
    $pageSetup.Zoom = $false
    $pageSetup.FitToPagesWide = 1
    $pageSetup.FitToPagesTall = $false
    $pageSetup.PrintArea = ''
    try {
      $pageSetup.PaperSize = $PaperId
    } catch {
      $pageSetup.PaperSize = 9
    }

    $ws.PrintOut()
    $printed += 1
  }

  if ($printed -eq 0) {
    throw "工资表中未找到可打印的工作表（公办在职 / 遗补）"
  }

  $wb.Close($false)
  $xl.Quit()
  Write-Output ("printed=$printed taxApplied=$taxApplied paperId=$PaperId")
  exit 0
} catch {
  try { if ($wb) { $wb.Close($false) } } catch {}
  try { if ($xl) { $xl.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($wb) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
  if ($xl) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`
}

function buildPageSummaryScript(input: Omit<ScriptInput, 'taxByIdCard'>): string {
  const pathLit = psString(input.salaryWorkbookPath)
  const printerLit = psString(input.printerName)
  const paperNameLit = psString(input.invoicePaperName)
  const sheetsLit = input.salarySheetNames.map(psString).join(', ')

  return `
$ErrorActionPreference = 'Stop'
$Path = ${pathLit}
$PrinterName = ${printerLit}
$InvoicePaperName = ${paperNameLit}
$SheetNames = @(${sheetsLit})

$PaperId = 9
try {
  Add-Type -AssemblyName System.Drawing
  if ($PrinterName -and $PrinterName.Length -gt 0) {
    $prSet = New-Object System.Drawing.Printing.PrinterSettings
    $prSet.PrinterName = $PrinterName
    foreach ($p in $prSet.PaperSizes) {
      if ($p.PaperName -match $InvoicePaperName -and $p.RawKind -ge 256) {
        $PaperId = [int]$p.RawKind
        break
      }
    }
  }
} catch {}

$xl = $null
$wb = $null
try {
  $xl = New-Object -ComObject Excel.Application
  $xl.Visible = $false
  $xl.DisplayAlerts = $false
  $xl.ScreenUpdating = $false

  $wb = $xl.Workbooks.Open($Path, 3, $false)

  if ($PrinterName -and $PrinterName.Length -gt 0) {
    $resolved = $null
    try {
      $escaped = $PrinterName -replace "'", "''"
      $printerInfo = Get-CimInstance -ClassName Win32_Printer -Filter ("Name = '" + $escaped + "'") -ErrorAction SilentlyContinue
      if ($printerInfo) {
        $resolved = "$PrinterName on " + $printerInfo.PortName
      }
    } catch {}
    foreach ($candidate in @($resolved, $PrinterName)) {
      if (-not $candidate) { continue }
      try {
        $xl.ActivePrinter = $candidate
        break
      } catch {}
    }
  }

  $items = New-Object System.Collections.Generic.List[object]
  $seenSheets = @{}
  foreach ($name in $SheetNames) {
    $ws = $null
    try { $ws = $wb.Sheets.Item($name) } catch { $ws = $null }
    if ($null -eq $ws) { continue }
    if ($seenSheets.ContainsKey($ws.Name)) { continue }
    $seenSheets[$ws.Name] = $true

    $pageSetup = $ws.PageSetup
    $pageSetup.Orientation = 1
    $pageSetup.Zoom = $false
    $pageSetup.FitToPagesWide = 1
    $pageSetup.FitToPagesTall = $false
    $pageSetup.PrintArea = ''
    try {
      $pageSetup.PaperSize = $PaperId
    } catch {
      $pageSetup.PaperSize = 9
    }

    $ws.Activate()
    try { $xl.ActiveWindow.View = 2 } catch {}
    try { $ws.DisplayPageBreaks = $true } catch {}
    $pages = [int]($ws.HPageBreaks.Count + 1)
    if ($pages -lt 1) { $pages = 1 }
    $label = if ($ws.Name -eq '公办在职') { '工资表' } else { '遗补' }
    $items.Add([pscustomobject]@{
      label = $label
      sheetName = [string]$ws.Name
      pages = $pages
    }) | Out-Null
  }

  $total = 0
  foreach ($item in $items) { $total += [int]$item.pages }
  $result = [pscustomobject]@{
    items = $items
    totalPages = $total
  }

  $wb.Close($false)
  $xl.Quit()
  $result | ConvertTo-Json -Depth 5 -Compress
  exit 0
} catch {
  try { if ($wb) { $wb.Close($false) } } catch {}
  try { if ($xl) { $xl.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($wb) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb) | Out-Null }
  if ($xl) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`
}

function psString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}
