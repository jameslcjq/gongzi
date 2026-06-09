import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'
import { getDatabase, run, get } from '../../db/connection'
import {
  exchangeImportedFolder,
  exchangeInboxFolder,
  exchangeOutboxFolder,
  exchangeTempFolder,
  getPeriodOutputPath
} from '../../config/paths'
import { listMonthlyPayrollRuns } from '../monthly-payroll/monthlyPayrollRuns'
import { persistMonthlyPayrollRun, type MonthlyPayrollRunInput } from '../monthly-payroll/monthlyPayrollRuns'
import { computeSalaryQuotaMatchLocalSummary } from '../monthly-payroll/quotaMatchLocalSummary'
import { readUnitSettings } from '../unitSettings'
import { copyExchangeFileToPreferredMedia } from './exchangeMedia'
import { getExchangeStatus } from './exchangeStatus'
import { previewExchangePackage, previewExchangeReceipt } from './exchangePackagePreview'
import type {
  ExchangePackageBuildResult,
  ExchangePackageFileSummary,
  ExchangePackageImportResult,
  ExchangePackagePreview,
  ExchangeReceiptImportResult,
  ExchangeReceiptBuildResult,
  ExchangeStatus,
  MonthlyPayrollRun
} from '../../../shared/types'

type PackagedFile = {
  key: keyof Pick<
    MonthlyPayrollRun,
    | 'sourceSalaryPath'
    | 'sourceSocialPath'
    | 'sourceTaxPath'
    | 'insuranceImportPath'
    | 'voucherImportPath'
    | 'salaryImportPath'
    | 'payrollBackpayPath'
  >
  label: string
  zipPath: string
  originalPath: string
  originalName: string
  sha256: string
  size: number
}

type PackagePayload = {
  run: MonthlyPayrollRun
  files: PackagedFile[]
}

const PACKAGE_FORMAT = 'laojiu.payroll.exchange-package'
const BUSINESS_TYPE = 'monthly-payroll'
const RECEIPT_BUSINESS_TYPE = 'monthly-payroll-receipt'

export async function buildMonthlyPayrollExchangePackage(runId: number): Promise<ExchangePackageBuildResult> {
  mkdirSync(exchangeOutboxFolder, { recursive: true })
  const runInfo = await findMonthlyPayrollRun(runId)
  if (!runInfo) throw new Error('未找到工资报账记录')
  if (runInfo.archivedAt) throw new Error('已月结记录不允许生成新的内网业务包')
  if (runInfo.isOutdated) throw new Error('已过期记录不允许生成内网业务包')

  const unitSettings = await readUnitSettings()
  const unitCode = unitSettings.unitImportCode || ''
  const unitName = runInfo.unitFullName || unitSettings.unitFullName || ''
  const packageId = buildPackageId(unitCode, runInfo.year, runInfo.month)
  const warnings: string[] = []
  const zip = new JSZip()
  const packagedFiles: PackagedFile[] = []

  for (const file of collectRunFiles(runInfo)) {
    if (!file.originalPath || !existsSync(file.originalPath)) {
      warnings.push(`${file.label}文件不存在，未写入包：${file.originalPath || '-'}`)
      continue
    }
    const buffer = await readFile(file.originalPath)
    const fileStat = await stat(file.originalPath)
    zip.file(file.zipPath, buffer)
    packagedFiles.push({
      ...file,
      originalName: basename(file.originalPath),
      sha256: sha256(buffer),
      size: fileStat.size
    })
  }

  // 额度匹配本地汇总：在外网（有明细表）算好打包带给内网执行端（内网无明细表无法现算）。
  const quotaMatchLocalSummary = await computeSalaryQuotaMatchLocalSummary()
  const payload: PackagePayload = {
    run: { ...runInfo, quotaMatchLocalSummary },
    files: packagedFiles
  }
  zip.file('payload/monthly-payroll-run.json', stableJson(payload))
  if (runInfo.reportSnapshot) {
    zip.file('payload/report-snapshot.json', stableJson(runInfo.reportSnapshot))
  }

  const checksumFiles = await buildChecksumEntries(zip)
  const manifest = {
    format: PACKAGE_FORMAT,
    version: 1,
    packageId,
    appName: '老九的工资系统',
    appVersion: app.getVersion(),
    createdAt: new Date().toISOString(),
    createdByMode: 'outer-network',
    businessType: BUSINESS_TYPE,
    unit: {
      unitFullName: unitName,
      unitImportCode: unitCode
    },
    period: {
      year: runInfo.year,
      month: runInfo.month
    },
    contains: {
      monthlyPayrollRun: true,
      reportSnapshot: Boolean(runInfo.reportSnapshot),
      insuranceImport: Boolean(runInfo.insuranceImportPath),
      voucherImport: Boolean(runInfo.voucherImportPath),
      salaryImport: Boolean(runInfo.salaryImportPath),
      backpayImport: Boolean(runInfo.payrollBackpayPath)
    },
    sourceFiles: packagedFiles
      .filter((file) => file.zipPath.startsWith('source/'))
      .map((file) => ({
        kind: file.key,
        originalName: file.originalName,
        sha256: file.sha256
      }))
  }
  zip.file('manifest.json', stableJson(manifest))
  zip.file('checksums.json', stableJson({ files: checksumFiles }))

  const packageBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
  const packageSha256 = sha256(packageBuffer)
  const packagePath = join(
    exchangeOutboxFolder,
    `工资交换包-${unitCode || 'UNKNOWN'}-${runInfo.year}-${String(runInfo.month).padStart(2, '0')}-${packageId.slice(-6)}.ljgzpkg`
  )
  await writeFile(packagePath, packageBuffer)
  const mediaCopy = await copyExchangeFileToPreferredMedia(
    packagePath,
    packageSha256,
    'package',
    warnings,
    { allowPrompt: true, displayName: unitName ? `${unitName}工资摆渡盘` : undefined }
  )
  await recordExchangePackage({
    packageId,
    packageSha256,
    unitCode,
    unitName,
    year: runInfo.year,
    month: runInfo.month,
    businessType: BUSINESS_TYPE,
    status: mediaCopy.copied || mediaCopy.mediaPath ? 'copied-to-media' : 'built',
    sourcePath: mediaCopy.mediaPath ?? null,
    localPath: packagePath,
    manifest,
    importedRunId: runInfo.id
  })
  await markRunExchangePackage(
    runInfo.id,
    packageId,
    mediaCopy.copied || mediaCopy.mediaPath ? 'copied-to-media' : 'package-built'
  )

  return {
    ok: true,
    packageId,
    packagePath,
    packageSha256,
    copiedToMedia: Boolean(mediaCopy.copied || mediaCopy.mediaPath),
    mediaPath: mediaCopy.mediaPath,
    copiedFiles: packagedFiles.length,
    warnings
  }
}

export async function importMonthlyPayrollExchangePackage(filePath: string): Promise<ExchangePackageImportResult> {
  const preview = await previewExchangePackage(filePath)
  if (!preview.ok) {
    throw new Error(`摆渡包校验未通过：${[...preview.errors, ...preview.warnings].filter(Boolean).join('；')}`)
  }
  await assertPackageMatchesUnit(preview)
  const packageId = preview.manifest?.packageId
  if (!packageId) throw new Error('摆渡包缺少 packageId')

  const existing = await get<{ id: number; status: string }>(
    await getDatabase(),
    'SELECT id, status FROM exchange_packages WHERE package_id = ? AND status = ? LIMIT 1',
    [packageId, 'imported']
  )
  if (existing) throw new Error(`该摆渡包已导入：${packageId}`)
  const localPackagePath = await copyToInboxIfNeeded(filePath, packageId)

  const buffer = await readFile(localPackagePath)
  const zip = await JSZip.loadAsync(buffer)
  const payloadFile = zip.file('payload/monthly-payroll-run.json')
  if (!payloadFile) throw new Error('摆渡包缺少 payload/monthly-payroll-run.json')
  const payload = JSON.parse(await payloadFile.async('string')) as PackagePayload
  const sourceRun = payload.run
  if (!sourceRun?.year || !sourceRun?.month) throw new Error('摆渡包中的工资报账记录无效')

  const extractDir = getPeriodOutputPath(
    sourceRun.year,
    sourceRun.month,
    '交换包导入',
    sanitizePathSegment(packageId)
  )
  mkdirSync(extractDir, { recursive: true })

  const localPaths: Partial<Record<PackagedFile['key'], string>> = {}
  let importedFiles = 0
  for (const file of payload.files || []) {
    const zipFile = zip.file(file.zipPath)
    if (!zipFile) continue
    const bytes = await zipFile.async('nodebuffer')
    const localPath = join(extractDir, `${file.label}_${sanitizePathSegment(file.originalName)}`)
    await writeFile(localPath, bytes)
    localPaths[file.key] = localPath
    importedFiles++
  }

  const reportSnapshotFile = zip.file('payload/report-snapshot.json')
  const reportSnapshotPath = reportSnapshotFile ? join(extractDir, 'report-snapshot.json') : null
  if (reportSnapshotFile && reportSnapshotPath) {
    await writeFile(reportSnapshotPath, await reportSnapshotFile.async('nodebuffer'))
  }

  const runInput: MonthlyPayrollRunInput = {
    year: sourceRun.year,
    month: sourceRun.month,
    unitFullName: sourceRun.unitFullName,
    activeCount: sourceRun.activeCount,
    survivorCount: sourceRun.survivorCount,
    retiredHousingCount: sourceRun.retiredHousingCount,
    salaryTotal: sourceRun.salaryTotal,
    withholdingTotal: sourceRun.withholdingTotal,
    taxTotal: sourceRun.taxTotal,
    actualPay: sourceRun.actualPay,
    activeActualPay: sourceRun.activeActualPay,
    survivorActualPay: sourceRun.survivorActualPay,
    retiredHousingActualPay: sourceRun.retiredHousingActualPay,
    retiredHousing: sourceRun.retiredHousing,
    sourceSalaryPath: localPaths.sourceSalaryPath ?? null,
    sourceSocialPath: localPaths.sourceSocialPath ?? null,
    sourceTaxPath: localPaths.sourceTaxPath ?? null,
    insuranceImportPath: localPaths.insuranceImportPath ?? null,
    voucherImportPath: localPaths.voucherImportPath ?? null,
    salaryImportPath: localPaths.salaryImportPath ?? null,
    payrollBackpayPath: localPaths.payrollBackpayPath ?? null,
    reportFingerprint: sourceRun.reportFingerprint,
    taxField: sourceRun.taxField,
    dataSourceMode: sourceRun.dataSourceMode,
    reportSnapshot: sourceRun.reportSnapshot ?? null,
    quotaMatchLocalSummary: sourceRun.quotaMatchLocalSummary ?? null
  }
  await persistMonthlyPayrollRun(runInput)
  const importedRun = await findLatestImportedRun(sourceRun.year, sourceRun.month, sourceRun.unitFullName)
  await recordExchangePackage({
    packageId,
    packageSha256: preview.packageSha256,
    unitCode: preview.manifest?.unitCode ?? '',
    unitName: preview.manifest?.unitName ?? sourceRun.unitFullName,
    year: sourceRun.year,
    month: sourceRun.month,
    businessType: BUSINESS_TYPE,
    status: 'imported',
    sourcePath: filePath,
    localPath: localPackagePath,
    manifest: preview.manifest ?? {},
    importedRunId: importedRun?.id
  })
  if (importedRun?.id) {
    await markRunExchangePackage(importedRun.id, packageId, 'package-built')
  }
  const warnings = [...preview.warnings]
  await deleteExchangeFileIfExists(localPackagePath, warnings, '已导入的本机业务包')
  if (filePath.toLowerCase() !== localPackagePath.toLowerCase()) {
    await deleteExchangeFileIfExists(filePath, warnings, '已导入的源业务包')
  }

  return {
    ok: true,
    packageId,
    runId: importedRun?.id,
    extractDir,
    importedFiles,
    warnings,
    message: `已导入 ${sourceRun.year}年${sourceRun.month}月工资业务包`
  }
}

export async function syncExchangeMedia(): Promise<ExchangeStatus> {
  const before = getExchangeStatus()
  const messages: string[] = []
  const warnings: string[] = []

  for (const file of before.mediaPackages) {
    if (!file.stable) continue
    if (file.kind === 'monthly-package') {
      await copyMediaPackageToInbox(file, warnings)
    } else if (file.kind === 'receipt') {
      const receipt = await importMonthlyPayrollExchangeReceipt(file.filePath).catch((error) => {
        warnings.push(`回执处理失败：${file.fileName}，${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      if (receipt?.ok) messages.push(receipt.message)
    }
  }

  const after = getExchangeStatus()
  return {
    ...after,
    warnings: [...after.warnings, ...warnings],
    syncMessages: messages
  }
}

export async function importMonthlyPayrollExchangeReceipt(
  filePath: string
): Promise<ExchangeReceiptImportResult> {
  const preview = await previewExchangeReceipt(filePath)
  if (!preview.ok) {
    throw new Error(`回执包校验未通过：${[...preview.errors, ...preview.warnings].filter(Boolean).join('；')}`)
  }
  const receiptId = preview.manifest?.receiptId
  if (!receiptId) throw new Error('回执包缺少 receiptId')
  const originalPackageId = preview.manifest?.originalPackageId
  const existing = await get<{ id: number; status: string }>(
    await getDatabase(),
    'SELECT id, status FROM exchange_packages WHERE package_id = ? AND status = ? LIMIT 1',
    [receiptId, 'receipt-received']
  )
  const receiptPath = await copyReceiptToImportedIfNeeded(filePath, receiptId, preview.packageSha256)
  const targetRun = await findReceiptTargetRun(originalPackageId, preview)
  if (!targetRun) {
    await recordExchangePackage({
      packageId: receiptId,
      packageSha256: preview.packageSha256,
      unitCode: preview.manifest?.unitCode ?? '',
      unitName: preview.manifest?.unitName ?? '',
      year: preview.manifest?.year ?? 0,
      month: preview.manifest?.month ?? 0,
      businessType: RECEIPT_BUSINESS_TYPE,
      status: 'receipt-received',
      sourcePath: filePath,
      localPath: receiptPath,
      manifest: preview.manifest ?? {}
    })
    return {
      ok: true,
      receiptId,
      originalPackageId,
      receiptPath,
      warnings: [...preview.warnings, '未找到对应工资报账记录，仅保存回执文件'],
      message: `已收到内网回执：${receiptId}，但未找到对应工资报账记录`
    }
  }

  if (targetRun.exchangeReceiptId !== receiptId) {
    await applyReceiptToRun(targetRun.id, receiptId, originalPackageId, receiptPath)
  }
  if (!existing) {
    await recordExchangePackage({
      packageId: receiptId,
      packageSha256: preview.packageSha256,
      unitCode: preview.manifest?.unitCode ?? '',
      unitName: preview.manifest?.unitName ?? targetRun.unitFullName,
      year: preview.manifest?.year ?? targetRun.year,
      month: preview.manifest?.month ?? targetRun.month,
      businessType: RECEIPT_BUSINESS_TYPE,
      status: 'receipt-received',
      sourcePath: filePath,
      localPath: receiptPath,
      manifest: preview.manifest ?? {},
      importedRunId: targetRun.id
    })
  }

  return {
    ok: true,
    receiptId,
    originalPackageId,
    runId: targetRun.id,
    receiptPath,
    warnings: preview.warnings,
    message: `已收到内网回执：${targetRun.year}年${targetRun.month}月 ${targetRun.unitFullName}`
  }
}

async function copyMediaPackageToInbox(
  file: ExchangePackageFileSummary,
  warnings: string[]
): Promise<string | null> {
  const preview = await previewExchangePackage(file.filePath).catch((error) => {
    warnings.push(`业务包校验失败：${file.fileName}，${error instanceof Error ? error.message : String(error)}`)
    return null
  })
  if (!preview) return null
  if (!preview.ok) {
    warnings.push(`业务包校验未通过，未自动取回：${file.fileName}，${[...preview.errors, ...preview.warnings].join('；')}`)
    return null
  }
  const packageId = preview.manifest?.packageId
  if (!packageId) {
    warnings.push(`业务包缺少 packageId，未自动取回：${file.fileName}`)
    return null
  }

  mkdirSync(exchangeInboxFolder, { recursive: true })
  const target = join(exchangeInboxFolder, `${sanitizePathSegment(packageId)}.ljgzpkg`)
  if (existsSync(target)) {
    const existingSha = await sha256File(target)
    if (existingSha === preview.packageSha256) {
      await deleteExchangeFileIfExists(file.filePath, warnings, '摆渡盘源业务包')
      return null
    }
    warnings.push(`本机 inbox 已有同名业务包但校验值不同，未覆盖：${target}`)
    return null
  }

  await copyVerifiedFile(file.filePath, target, preview.packageSha256)
  await deleteExchangeFileIfExists(file.filePath, warnings, '摆渡盘源业务包')
  return `已自动取回内网业务包到本机 inbox：${preview.fileName}`
}

async function copyReceiptToImportedIfNeeded(
  filePath: string,
  receiptId: string,
  receiptSha256: string
): Promise<string> {
  mkdirSync(exchangeImportedFolder, { recursive: true })
  const baseName = `${sanitizePathSegment(receiptId)}.ljgzreceipt`
  let target = join(exchangeImportedFolder, baseName)
  if (filePath.toLowerCase() === target.toLowerCase()) return target
  if (existsSync(target)) {
    const existingSha = await sha256File(target)
    if (existingSha === receiptSha256) return target
    target = join(
      exchangeImportedFolder,
      `${sanitizePathSegment(receiptId)}-${receiptSha256.slice(0, 8)}.ljgzreceipt`
    )
  }
  await copyVerifiedFile(filePath, target, receiptSha256)
  return target
}

async function copyVerifiedFile(
  sourcePath: string,
  targetPath: string,
  expectedSha256: string
): Promise<void> {
  mkdirSync(exchangeTempFolder, { recursive: true })
  const tempPath = join(
    exchangeTempFolder,
    `${Date.now()}-${Math.random().toString(36).slice(2)}${extname(targetPath)}.tmp`
  )
  try {
    await copyFile(sourcePath, tempPath)
    const copiedSha = await sha256File(tempPath)
    if (copiedSha !== expectedSha256) {
      throw new Error(`复制后 SHA256 不一致：${copiedSha}`)
    }
    await rename(tempPath, targetPath)
  } catch (error) {
    try {
      if (existsSync(tempPath)) await unlink(tempPath)
    } catch {}
    throw error
  }
}

async function deleteExchangeFileIfExists(
  filePath: string,
  warnings: string[],
  label: string
): Promise<void> {
  try {
    if (existsSync(filePath)) await unlink(filePath)
  } catch (error) {
    warnings.push(`删除${label}失败：${filePath}，${error instanceof Error ? error.message : String(error)}`)
  }
}

async function findReceiptTargetRun(
  originalPackageId: string | undefined,
  preview: ExchangePackagePreview
): Promise<MonthlyPayrollRun | null> {
  const runs = await listMonthlyPayrollRuns()
  if (originalPackageId) {
    const byRunField = runs.find((runInfo) => runInfo.exchangePackageId === originalPackageId)
    if (byRunField) return byRunField

    const packageRow = await get<{
      imported_run_id: number | null
      year: number | null
      month: number | null
      unit_name: string | null
    }>(
      await getDatabase(),
      'SELECT imported_run_id, year, month, unit_name FROM exchange_packages WHERE package_id = ? LIMIT 1',
      [originalPackageId]
    )
    if (packageRow?.imported_run_id) {
      const byId = runs.find((runInfo) => runInfo.id === Number(packageRow.imported_run_id))
      if (byId) return byId
    }
    const byPackageRecord = findRunByPeriodUnit(
      runs,
      Number(packageRow?.year || 0),
      Number(packageRow?.month || 0),
      packageRow?.unit_name || ''
    )
    if (byPackageRecord) return byPackageRecord
  }

  return findRunByPeriodUnit(
    runs,
    Number(preview.manifest?.year || 0),
    Number(preview.manifest?.month || 0),
    preview.manifest?.unitName || ''
  )
}

function findRunByPeriodUnit(
  runs: MonthlyPayrollRun[],
  year: number,
  month: number,
  unitName: string
): MonthlyPayrollRun | null {
  if (!year || !month) return null
  const normalizedUnit = normalizeUnitToken(unitName)
  return runs.find((runInfo) => {
    if (runInfo.year !== year || runInfo.month !== month) return false
    if (!normalizedUnit) return true
    const localUnit = normalizeUnitToken(runInfo.unitFullName)
    return localUnit.includes(normalizedUnit) || normalizedUnit.includes(localUnit)
  }) ?? null
}

async function markRunExchangePackage(
  runId: number,
  packageId: string,
  status: 'package-built' | 'copied-to-media'
): Promise<void> {
  await run(
    await getDatabase(),
    `UPDATE monthly_payroll_runs
        SET exchange_package_id = ?,
            exchange_package_status = ?
      WHERE id = ?`,
    [packageId, status, runId]
  )
}

async function applyReceiptToRun(
  runId: number,
  receiptId: string,
  originalPackageId: string | undefined,
  receiptPath: string
): Promise<void> {
  await run(
    await getDatabase(),
    `UPDATE monthly_payroll_runs
        SET exchange_package_id = COALESCE(exchange_package_id, ?),
            exchange_package_status = 'receipt-received',
            exchange_receipt_id = ?,
            exchange_receipt_at = ?,
            exchange_receipt_path = ?
      WHERE id = ?`,
    [originalPackageId ?? null, receiptId, new Date().toISOString(), receiptPath, runId]
  )
}

export async function buildMonthlyPayrollExchangeReceipt(runId: number): Promise<ExchangeReceiptBuildResult> {
  mkdirSync(exchangeOutboxFolder, { recursive: true })
  const runInfo = await findMonthlyPayrollRun(runId)
  if (!runInfo) throw new Error('未找到工资报账记录')
  if (!runInfo.archivedAt) throw new Error('该记录尚未月结，不能生成内网执行回执')

  const importedPackage = await get<{
    package_id: string
    package_sha256: string
    manifest_json: string | null
  }>(
    await getDatabase(),
    'SELECT package_id, package_sha256, manifest_json FROM exchange_packages WHERE imported_run_id = ? AND status = ? LIMIT 1',
    [runId, 'imported']
  )
  const receiptId = `${importedPackage?.package_id || buildPackageId('', runInfo.year, runInfo.month)}-receipt-${Date.now()}`
  const warnings: string[] = []
  if (!importedPackage) warnings.push('未找到对应的导入业务包记录，回执将不包含原包号')

  const receiptPayload = {
    originalPackageId: importedPackage?.package_id,
    originalPackageSha256: importedPackage?.package_sha256,
    runId: runInfo.id,
    unitFullName: runInfo.unitFullName,
    year: runInfo.year,
    month: runInfo.month,
    importedAt: runInfo.createdAt,
    monthClosedAt: runInfo.archivedAt,
    integrationStatus: {
      insurance: {
        status: runInfo.insurancePushStatus,
        pushedAt: runInfo.insurancePushedAt
      },
      voucher: {
        status: runInfo.voucherPushStatus,
        pushedAt: runInfo.voucherPushedAt
      },
      salary: {
        status: runInfo.salaryPushStatus,
        pushedAt: runInfo.salaryPushedAt
      }
    },
    archive: {
      archiveDir: runInfo.archiveDir,
      files: runInfo.archiveManifest
    }
  }
  const manifest = {
    format: 'laojiu.payroll.exchange-receipt',
    version: 1,
    receiptId,
    originalPackageId: importedPackage?.package_id,
    appName: '老九的工资系统',
    appVersion: app.getVersion(),
    createdAt: new Date().toISOString(),
    businessType: RECEIPT_BUSINESS_TYPE,
    unit: {
      unitFullName: runInfo.unitFullName
    },
    period: {
      year: runInfo.year,
      month: runInfo.month
    }
  }

  const zip = new JSZip()
  zip.file('manifest.json', stableJson(manifest))
  zip.file('payload/receipt.json', stableJson(receiptPayload))
  const checksumFiles = await buildChecksumEntries(zip)
  zip.file('checksums.json', stableJson({ files: checksumFiles }))

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
  const receiptSha256 = sha256(buffer)
  const receiptPath = join(
    exchangeOutboxFolder,
    `工资回执-${runInfo.year}-${String(runInfo.month).padStart(2, '0')}-${sanitizePathSegment(receiptId.slice(-18))}.ljgzreceipt`
  )
  await writeFile(receiptPath, buffer)
  const mediaCopy = await copyExchangeFileToPreferredMedia(
    receiptPath,
    receiptSha256,
    'receipt',
    warnings,
    { allowPrompt: true, displayName: `${runInfo.unitFullName}工资摆渡盘` }
  )
  await recordExchangePackage({
    packageId: receiptId,
    packageSha256: receiptSha256,
    unitCode: '',
    unitName: runInfo.unitFullName,
    year: runInfo.year,
    month: runInfo.month,
    businessType: RECEIPT_BUSINESS_TYPE,
    status: mediaCopy.copied || mediaCopy.mediaPath ? 'receipt-copied-to-media' : 'receipt-built',
    sourcePath: mediaCopy.mediaPath ?? null,
    localPath: receiptPath,
    manifest,
    importedRunId: runInfo.id
  })

  return {
    ok: true,
    receiptId,
    receiptPath,
    receiptSha256,
    originalPackageId: importedPackage?.package_id,
    copiedToMedia: Boolean(mediaCopy.copied || mediaCopy.mediaPath),
    mediaPath: mediaCopy.mediaPath,
    warnings
  }
}

async function findMonthlyPayrollRun(runId: number): Promise<MonthlyPayrollRun | null> {
  const runs = await listMonthlyPayrollRuns()
  return runs.find((runInfo) => runInfo.id === runId) ?? null
}

async function assertPackageMatchesUnit(preview: ExchangePackagePreview): Promise<void> {
  const settings = await readUnitSettings()
  const expectedCode = normalizeUnitToken(settings.unitImportCode)
  const expectedName = normalizeUnitToken(settings.unitFullName)
  const packageCode = normalizeUnitToken(preview.manifest?.unitCode)
  const packageName = normalizeUnitToken(preview.manifest?.unitName)

  if (expectedCode && packageCode && expectedCode !== packageCode) {
    throw new Error(`摆渡包单位编码不一致：本机 ${settings.unitImportCode}，包内 ${preview.manifest?.unitCode}`)
  }
  if (
    expectedName &&
    packageName &&
    !expectedName.includes(packageName) &&
    !packageName.includes(expectedName)
  ) {
    throw new Error(`摆渡包单位名称不一致：本机 ${settings.unitFullName}，包内 ${preview.manifest?.unitName}`)
  }
}

function normalizeUnitToken(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '').trim()
}

async function findLatestImportedRun(year: number, month: number, unitFullName: string): Promise<MonthlyPayrollRun | null> {
  const runs = await listMonthlyPayrollRuns()
  return runs.find((runInfo) =>
    runInfo.year === year &&
    runInfo.month === month &&
    runInfo.unitFullName === unitFullName &&
    !runInfo.isOutdated
  ) ?? null
}

function collectRunFiles(runInfo: MonthlyPayrollRun): Array<Omit<PackagedFile, 'originalName' | 'sha256' | 'size'>> {
  const files: Array<Omit<PackagedFile, 'originalName' | 'sha256' | 'size'>> = [
    { key: 'sourceSalaryPath', label: '原始工资表', zipPath: buildZipPath('source', runInfo.sourceSalaryPath), originalPath: runInfo.sourceSalaryPath ?? '' },
    { key: 'sourceSocialPath', label: '社保', zipPath: buildZipPath('source', runInfo.sourceSocialPath), originalPath: runInfo.sourceSocialPath ?? '' },
    { key: 'sourceTaxPath', label: '个税', zipPath: buildZipPath('source', runInfo.sourceTaxPath), originalPath: runInfo.sourceTaxPath ?? '' },
    { key: 'insuranceImportPath', label: '保险导入', zipPath: buildZipPath('files', runInfo.insuranceImportPath), originalPath: runInfo.insuranceImportPath ?? '' },
    { key: 'voucherImportPath', label: '凭证', zipPath: buildZipPath('files', runInfo.voucherImportPath), originalPath: runInfo.voucherImportPath ?? '' },
    { key: 'salaryImportPath', label: '工资导入', zipPath: buildZipPath('files', runInfo.salaryImportPath), originalPath: runInfo.salaryImportPath ?? '' },
    { key: 'payrollBackpayPath', label: '补发工资', zipPath: buildZipPath('files', runInfo.payrollBackpayPath), originalPath: runInfo.payrollBackpayPath ?? '' }
  ]
  return files.filter((file) => file.originalPath)
}

function buildZipPath(folder: 'source' | 'files', filePath: string | null): string {
  const fileName = filePath ? sanitizePathSegment(basename(filePath)) : 'missing'
  return `${folder}/${fileName}`
}

async function buildChecksumEntries(zip: JSZip): Promise<Array<{ path: string; sha256: string; size: number }>> {
  const result: Array<{ path: string; sha256: string; size: number }> = []
  const files = Object.values(zip.files).filter((file) => !file.dir)
  for (const file of files) {
    const bytes = await file.async('nodebuffer')
    result.push({
      path: file.name,
      sha256: sha256(bytes),
      size: bytes.length
    })
  }
  return result
}

async function copyToInboxIfNeeded(filePath: string, packageId: string): Promise<string> {
  mkdirSync(exchangeInboxFolder, { recursive: true })
  const target = join(exchangeInboxFolder, `${sanitizePathSegment(packageId)}.ljgzpkg`)
  if (filePath.toLowerCase() === target.toLowerCase()) return target
  await copyFile(filePath, target)
  return target
}

async function recordExchangePackage(input: {
  packageId: string
  packageSha256: string
  unitCode: string
  unitName: string
  year: number
  month: number
  businessType: string
  status: string
  sourcePath: string | null
  localPath: string
  manifest: unknown
  importedRunId?: number
}): Promise<void> {
  const database = await getDatabase()
  await run(
    database,
    `
      INSERT INTO exchange_packages (
        package_id, package_sha256, unit_code, unit_name, year, month, business_type,
        status, source_path, local_path, manifest_json, imported_run_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(package_id) DO UPDATE SET
        package_sha256 = excluded.package_sha256,
        unit_code = excluded.unit_code,
        unit_name = excluded.unit_name,
        year = excluded.year,
        month = excluded.month,
        business_type = excluded.business_type,
        status = excluded.status,
        source_path = excluded.source_path,
        local_path = excluded.local_path,
        manifest_json = excluded.manifest_json,
        imported_run_id = excluded.imported_run_id,
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      input.packageId,
      input.packageSha256,
      input.unitCode,
      input.unitName,
      input.year,
      input.month,
      input.businessType,
      input.status,
      input.sourcePath,
      input.localPath,
      stableJson(input.manifest),
      input.importedRunId ?? null
    ]
  )
}

function buildPackageId(unitCode: string, year: number, month: number): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  return `${unitCode || 'UNKNOWN'}-${year}-${String(month).padStart(2, '0')}-${stamp}`
}

function sanitizePathSegment(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 120)
  return cleaned || 'unnamed'
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath))
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}
