// 内网交换包（.ljgzpkg）交互式导入的共享逻辑。
//
// 原本内嵌在 MonthlyPayrollPage.vue，现抽出供两处复用：
//   - 工资业务页的"导入内网业务包"按钮（完整版）。
//   - 一体化系统页工具栏的"导入交换包"按钮（内网执行端）。
// 复用主程序已有的 exchange 导入能力（选文件 → 预览 sha256 校验 → 确认 → 入库）。

import { ElMessage, ElMessageBox } from 'element-plus'
import type { ExchangePackagePreview, UnitSettings } from '@shared/types'

export function formatExchangePreviewMessage(preview: ExchangePackagePreview): string {
  const manifest = preview.manifest
  const unit = [manifest?.unitCode, manifest?.unitName].filter(Boolean).join(' ') || '单位未知'
  const period = manifest?.year && manifest?.month ? `${manifest.year}年${manifest.month}月` : '年月未知'
  const packageId = manifest?.packageId || '包号未知'
  const checksum = preview.ok
    ? `校验通过：${preview.checksumSummary.matched}/${preview.checksumSummary.declared}`
    : `校验异常：缺失 ${preview.checksumSummary.missing}，不一致 ${preview.checksumSummary.mismatched}，未声明 ${preview.checksumSummary.unchecked}`
  const details = [...preview.errors, ...preview.warnings].filter(Boolean)
  return [
    `文件：${preview.fileName}`,
    `单位：${unit}`,
    `年月：${period}`,
    `包号：${packageId}`,
    checksum,
    details.length ? `问题：${details.slice(0, 5).join('；')}` : ''
  ].filter(Boolean).join('\n')
}

export async function getExchangePackageUnitMismatch(preview: ExchangePackagePreview): Promise<string | null> {
  const settings = await readCurrentUnitSettings()
  const manifest = preview.manifest
  if (!settings || !manifest) return null

  const expectedCode = normalizeUnitToken(settings.unitImportCode)
  const expectedName = normalizeUnitToken(settings.unitFullName)
  const packageCode = normalizeUnitToken(manifest.unitCode)
  const packageName = normalizeUnitToken(manifest.unitName)

  if (expectedCode && packageCode && expectedCode !== packageCode) {
    return `单位编码不一致（本机 ${displayUnitValue(settings.unitImportCode)}，包内 ${displayUnitValue(manifest.unitCode)}）`
  }
  if (
    expectedName &&
    packageName &&
    !expectedName.includes(packageName) &&
    !packageName.includes(expectedName)
  ) {
    return `单位名称不一致（本机 ${displayUnitValue(settings.unitFullName)}，包内 ${displayUnitValue(manifest.unitName)}）`
  }
  return null
}

/**
 * 交互式导入内网交换包：选文件 → 预览校验 → 确认 → 导入。
 * 返回是否成功导入（成功时由调用方负责刷新列表）。错误与取消已在内部处理。
 */
export async function importExchangePackageInteractive(): Promise<boolean> {
  try {
    const picked = await window.salaryApi.chooseExchangePackage()
    if (!picked) return false

    const preview = await window.salaryApi.previewExchangePackage(picked.filePath)
    const unitMismatch = await getExchangePackageUnitMismatch(preview)
    if (unitMismatch) {
      ElMessage.warning(`非本单位交换包，已取消导入：${unitMismatch}`)
      return false
    }

    const message = formatExchangePreviewMessage(preview)
    await ElMessageBox.confirm(
      `${message}\n\n确认导入后，会把包内文件解压到本机工资数据目录，并生成一条待一体化执行的工资报账记录。`,
      '导入内网业务包',
      {
        type: preview.ok ? 'warning' : 'error',
        confirmButtonText: preview.ok ? '确认导入' : '关闭',
        cancelButtonText: '取消',
        showCancelButton: preview.ok
      }
    )
    if (!preview.ok) return false

    const imported = await window.salaryApi.importMonthlyPayrollExchangePackage(picked.filePath)
    ElMessage.success(imported.message)
    return true
  } catch (error) {
    if (error === 'cancel') return false
    ElMessage.error(error instanceof Error ? error.message : '导入内网业务包失败')
    return false
  }
}

async function readCurrentUnitSettings(): Promise<UnitSettings | null> {
  try {
    return await window.salaryApi.getUnitSettings()
  } catch {
    return null
  }
}

function normalizeUnitToken(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '').trim()
}

function displayUnitValue(value: unknown): string {
  return String(value ?? '').trim() || '未填写'
}
