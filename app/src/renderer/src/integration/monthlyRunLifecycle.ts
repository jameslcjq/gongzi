// 工资报账记录的"月结 / 生成回执"共享逻辑。
//
// 原本内嵌在 MonthlyPayrollPage.vue，现抽出供两处复用：
//   - 工资业务页历史记录的月结/回执按钮（完整版）。
//   - 一体化系统页工具栏（内网执行端，隐藏工资业务后由工具栏完成闭环）。
// 均为本地 DB + 文件操作，与一体化 webview 登录状态无关。

import { ElMessage, ElMessageBox } from 'element-plus'
import type { MonthlyPayrollRun } from '@shared/types'

export function canArchiveRun(row: MonthlyPayrollRun): boolean {
  return Boolean(!row.archivedAt && row.sourceSocialPath && row.insuranceImportPath)
}

/** 月结：检查 → 确认 → 归档。成功返回归档后的 run；取消/失败/不可月结返回 null。 */
export async function archiveRunInteractive(row: MonthlyPayrollRun): Promise<MonthlyPayrollRun | null> {
  if (!canArchiveRun(row)) {
    ElMessage.warning('社保文件未补齐，当前只是工资阶段结果，不能月结')
    return null
  }
  try {
    await ElMessageBox.confirm(
      `${row.year}年${row.month}月结后，本月不能再次进行工资报账或重新生成报表；系统只归档最后有效的工资、社保、个税源文件和最终导出的保险导入、凭证、补发工资等文件。月结完成后会清零在职工资、退休工资、其他工资中的补发工资、补扣工资，用于下月业务初始化。`,
      '工资月结',
      { type: 'warning', confirmButtonText: '确认月结', cancelButtonText: '取消' }
    )
  } catch {
    return null
  }
  try {
    const archived = await window.salaryApi.archiveMonthlyPayrollRun(row.id)
    ElMessage.success(`已月结 ${archived.files.length} 个文件`)
    return archived.run
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message)
    return null
  }
}

/** 生成内网执行回执：要求已月结。成功返回 true（并打开回执所在目录）。 */
export async function buildReceiptInteractive(row: MonthlyPayrollRun): Promise<boolean> {
  if (!row.archivedAt) {
    ElMessage.warning('请先完成月结后再生成回执')
    return false
  }
  try {
    const result = await window.salaryApi.buildMonthlyPayrollExchangeReceipt(row.id)
    ElMessage.success(
      result.copiedToMedia
        ? `已生成并复制回执到摆渡目录：${result.receiptId}`
        : `已生成内网执行回执：${result.receiptId}`
    )
    if (result.warnings.length > 0) {
      await ElMessageBox.alert(result.warnings.join('\n'), '回执生成提醒', {
        type: 'warning',
        confirmButtonText: '知道了'
      })
    }
    await window.salaryApi.openLocalPath(
      (result.mediaPath || result.receiptPath).replace(/[\\/][^\\/]*$/, '')
    )
    return true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生成内网执行回执失败')
    return false
  }
}
