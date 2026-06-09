import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { failRule, okRule } from '../ruleResult'
import type {
  MonthlyPayrollReconciliationResult,
  MonthlyPayrollReportResult,
  MonthlyPayrollReportSheet,
  MonthlyPayrollSalaryPrintPageSummary,
  MonthlyPayrollVoucherPageCounts,
  MonthlyPayrollWorkflowInput,
  RuleResult,
  UnitSettings,
  WorkflowMessageTooltip
} from '../../../shared/types'
import { readUnitSettings } from '../unitSettings'
import { readMonthlyPayrollPrintSettings } from '../printSettings'
import {
  loadIntegratedActiveAggregates,
  loadIntegratedActiveBackpayRows,
  loadIntegratedActiveHousingFund,
  loadIntegratedActivePersonalInsuranceTotals,
  loadIntegratedSimpleAggregates,
  loadRetiredHousingDetails,
  loadRetiredSummary,
  runDetailImports
} from './monthlyPayrollDataLoaders'
import { getMonthlyPayrollTempPath } from '../../config/paths'
import {
  parseSalaryWorkbook,
  parseSocialSecurityWorkbook,
  parseTaxWorkbook
} from './monthlyPayrollParsers'
import {
  applyIntegratedWriteBackPlan,
  applyTaxAndRecomputeIntegratedActive,
  buildIntegratedActiveBackpayAdjustmentPlan,
  buildIntegratedActiveIdCardResolver,
  buildIntegratedActiveWriteBackPlan,
  buildIntegratedOtherWriteBackPlan,
  buildMonthlyPayrollWriteBackPreview,
  comparePayrollPeople,
  formatCompareTooltipLines,
  formatCompareMessage,
  formatCompareWarning,
  getActiveCompareFields,
  mergeAppliedWriteBackPreview,
  mergeIntegratedWriteBackPlans,
  recomputeIntegratedOtherLikeWorksheet,
  summarizeIntegratedActive,
  survivorCompareFields,
  type CompareSummary,
  type IntegratedIdCardResolver,
  type IntegratedActiveRecomputeResult,
  type IntegratedSimplePaySummary
} from './integratedPayroll'
import { readMonthlyPayrollSettings } from './monthlyPayrollSettings'
import {
  findSameMonthlyPayrollRun,
  findMonthlyPayrollSourceSalaryOriginalPath,
  fingerprintReportSheets,
  isMonthlyPayrollMonthArchived,
  normalizeMonthlyPayrollDataSourceMode,
  persistMonthlyPayrollRun,
} from './monthlyPayrollRuns'
import { registerMonthlyPayrollSources } from './monthlyPayrollSources'
import {
  buildInsuranceVoucherUsage,
  buildSalaryVoucherUsage,
  buildVoucherSheet,
  departmentEconomicSubjectForSocialItem,
  formatVoucherAmount,
  toChineseRmb
} from './voucherSheet'
import { sumSocialByCanonicalName, sumSocialByKeyword } from './socialSecuritySummary'
import { getSalaryWorkbookPrintPageSummary } from './printSalaryViaExcel'
import { writeSalaryImportWorkbook } from './salaryImportWorkbook'
import {
  addBackpayAdjustment,
  addSignedBackpayAdjustment,
  createBackpayAdjustmentRow,
  hasBackpayAdjustments
} from './backpayAdjustmentRows'
import type {
  IntegratedActiveAggregates,
  IntegratedSimpleAggregates,
  PersonalInsuranceTotals,
  PayrollPeriodRange,
  RetiredHousingPerson,
  RetiredSummary,
  SalarySummary,
  SocialSecuritySummary,
  TaxSummary
} from './monthlyPayrollTypes'
import {
  formatMoney,
  normalizeIdCard,
  num,
  roundMoney,
  text
} from './monthlyPayrollUtils'
import {
  gridColumns,
  timestamp,
  writeWorkbook
} from './monthlyPayrollWorkbookUtils'
import {
  assertCurrentPayrollPeriod,
  isIntegratedDataSource,
  missingSourceMessage,
  normalizeList,
  normalizeMonthlyPayrollInput,
  validateMonthlyPayrollSourcePeriods
} from './monthlyPayrollPeriodChecks'
import {
  appendBusinessSummaryMessages,
  buildBusinessSummary,
  buildSalarySummaryFromIntegratedAggregates,
  buildSalaryWorkbookBusinessSummary
} from './monthlyPayrollBusinessSummary'
import {
  applyTaxToSalarySummary,
  backupAndWriteTaxToSalaryWorkbook,
  buildTaxByIdCardFromSummary
} from './monthlyPayrollTax'
import { reconcileMonthlyPayrollReport } from './monthlyPayrollReconciliation'
export {
  archiveMonthlyPayrollRun,
  cancelMonthlyPayrollMonthClose,
  deleteMonthlyPayrollRun,
  getMonthlyPayrollRunReport,
  listMonthlyPayrollRuns,
  assertMonthlyPayrollRunPushable,
  updateMonthlyPayrollPushStatus
} from './monthlyPayrollRuns'
export { inspectMonthlyPayrollSourcePeriods } from './monthlyPayrollPeriodChecks'

const workflowName = '月度工资报账预处理'
const generateWorkflowName = '月度工资报账汇总生成'
// 财政凭证附件要求：保险凭证固定 7 页；工资凭证页数另按工资表、遗补、退休房补动态统计。
const INSURANCE_VOUCHER_ATTACHMENT_PAGES = 7

function buildCompareMessageTooltips(summaries: CompareSummary[]): WorkflowMessageTooltip[] {
  const tooltips: WorkflowMessageTooltip[] = []
  for (const summary of summaries) {
    const lines = formatCompareTooltipLines(summary)
    if (lines.length === 0) continue
    tooltips.push({
      message: formatCompareMessage(summary),
      lines
    })
    if (summary.added + summary.removed + summary.changed > 0) {
      tooltips.push({
        message: formatCompareWarning(summary),
        lines
      })
    }
  }
  return tooltips
}
const VOUCHER_ATTACHMENT_PAGES_COLUMN = '附件页数'
const salaryPrintSummaryCache = new Map<string, MonthlyPayrollSalaryPrintPageSummary>()
const RETIRED_HOUSING_REPORT_SHEET_NAME = '退休房补'
const LEGACY_RETIRED_HOUSING_REPORT_SHEET_NAME = '退休工资'

export async function preprocessMonthlyPayroll(
  payload?: { monthlyPayroll?: MonthlyPayrollWorkflowInput }
): Promise<RuleResult> {
  try {
    const input = normalizeMonthlyPayrollInput(payload?.monthlyPayroll)
    const targetDate = assertCurrentPayrollPeriod(input)
    if (await isMonthlyPayrollMonthArchived(targetDate.year, targetDate.month)) {
      return {
        ok: false,
        affectedRows: 0,
        messages: [],
        warnings: [`${targetDate.year}年${targetDate.month}月工资已月结，不能再次开始预处理。请在历史报表中查看月结记录。`]
      }
    }
    const sourceError = missingSourceMessage(input)
    if (sourceError) {
      return {
        ok: false,
        affectedRows: 0,
        messages: [],
        warnings: [sourceError]
      }
    }

    const [socialSecurity, tax] = await Promise.all([
      input.socialSecurityWorkbookPath
        ? parseSocialSecurityWorkbook(input.socialSecurityWorkbookPath)
        : Promise.resolve<SocialSecuritySummary | undefined>(undefined),
      input.taxWorkbookPath
        ? parseTaxWorkbook(input.taxWorkbookPath)
        : Promise.resolve<TaxSummary | undefined>(undefined)
    ])
    validateMonthlyPayrollSourcePeriods(targetDate, socialSecurity, tax)
    const taxByIdCard = buildTaxByIdCardFromSummary(tax)
    const monthlyPayrollSettings = await readMonthlyPayrollSettings()
    const taxField = monthlyPayrollSettings.taxField

    const salary = input.salaryWorkbookPath
      ? applyTaxToSalarySummary(
          await parseSalaryWorkbook(input.salaryWorkbookPath),
          taxByIdCard,
          { clearTaxWhenMissing: !tax }
        )
      : undefined
    await registerMonthlyPayrollSources(input, { salary, socialSecurity, tax })
    const integratedOtherPaySummary = await recomputeIntegratedOtherLikeWorksheet('其他工资')
    const integratedRetiredPaySummary = await recomputeIntegratedOtherLikeWorksheet('退休工资')

    if (!input.confirmWriteBack) {
      await runDetailImports(input, salary)
    }

    if (input.processScope === 'social') {
      if (!socialSecurity) {
        return {
          ok: false,
          affectedRows: 0,
          messages: [],
          warnings: ['社保每月必办，请先放入社保未申报汇总文件。']
        }
      }
      const [integratedPersonalInsurance, integratedActiveHousingFund] = await Promise.all([
        loadIntegratedActivePersonalInsuranceTotals(),
        loadIntegratedActiveHousingFund()
      ])
      const activePaySummary = isIntegratedDataSource(input)
        ? await applyTaxAndRecomputeIntegratedActive(taxByIdCard, { clearTaxWhenMissing: !tax })
        : salary ? await summarizeIntegratedActive(taxByIdCard) : undefined
      const insuranceCheck = buildPersonalInsuranceCheck(
        socialSecurity,
        isIntegratedDataSource(input) ? undefined : salary,
        integratedPersonalInsurance
      )
      const socialTotal = roundMoney(Object.values(socialSecurity.byItem).reduce((sum, value) => sum + value, 0))
      const detailMessages = [
        `报账模式：社保补齐处理${tax ? '，包含个税扣款' : '，不处理个税'}`,
        salary
          ? '工资表：已读取，仅用于同时生成工资凭证；本次不生成工资相关打印报表'
          : '工资表：未检测到，本次只能生成社保凭证',
        `社保：读取 ${socialSecurity.rowCount} 行，按征收品目汇总 ${Object.keys(socialSecurity.byItem).length} 类，合计 ${formatMoney(socialTotal)}`,
        `住房公积金：按${salary ? '工资表/在职工资' : '在职工资'}当前公积金合计 ${formatMoney(salary ? resolveHousingFund(salary, integratedActiveHousingFund) : integratedActiveHousingFund)} 生成个人和单位公积金`,
        tax
          ? `个税：读取 ${tax.rows.length} 人，总额 ${formatMoney(tax.totalTax)}${isIntegratedDataSource(input) && activePaySummary ? `，已写入在职工资「${taxField}」 ${activePaySummary.taxApplied} 人` : ''}`
          : '个税：未检测到个税文件，本次不报个税',
        ...insuranceCheck.messages
      ]
      const messages = insuranceCheck.warnings.length === 0 && salary
        ? appendBusinessSummaryMessages(detailMessages, buildBusinessSummary({
            active: activePaySummary,
            survivor: integratedOtherPaySummary,
            retiredHousing: integratedRetiredPaySummary
          }))
        : detailMessages
      return okRule(
        workflowName,
        (salary?.activePeople.length ?? 0) + (salary?.survivorPeople.length ?? 0) + socialSecurity.rowCount + (tax?.rows.length ?? 0),
        messages,
        insuranceCheck.warnings
      )
    }

    if (isIntegratedDataSource(input)) {
      const [integratedActiveRecompute, integratedPersonalInsurance, integratedActiveHousingFund] = await Promise.all([
        applyTaxAndRecomputeIntegratedActive(taxByIdCard, { clearTaxWhenMissing: !tax }),
        loadIntegratedActivePersonalInsuranceTotals(),
        loadIntegratedActiveHousingFund()
      ])
      const insuranceCheck = buildPersonalInsuranceCheck(socialSecurity, undefined, integratedPersonalInsurance)
      const socialTotal = socialSecurity
        ? roundMoney(Object.values(socialSecurity.byItem).reduce((sum, value) => sum + value, 0))
        : 0
      const mode = socialSecurity ? '工资+社保' : '工资阶段结果'
      const detailMessages = [
        `权威来源：本地在职工资、退休工资、其他工资；工资表 Excel${salary ? '仅作为附件、页数统计和辅助核对' : '未参与本次金额计算'}`,
        `报账模式：${mode}${tax ? '，包含个税扣款' : '，不处理个税'}`,
        `在职工资已按公式重算 ${integratedActiveRecompute.rowCount} 人：应发合计 ${formatMoney(integratedActiveRecompute.payableTotal)}，实发合计 ${formatMoney(integratedActiveRecompute.actualPayTotal)}`,
        `其他工资 ${integratedOtherPaySummary.rowCount} 人：实发 ${formatMoney(integratedOtherPaySummary.actualPayTotal)}`,
        `退休工资 ${integratedRetiredPaySummary.rowCount} 人：实发 ${formatMoney(integratedRetiredPaySummary.actualPayTotal)}`,
        socialSecurity
          ? `社保：读取 ${socialSecurity.rowCount} 行，按征收品目汇总 ${Object.keys(socialSecurity.byItem).length} 类，合计 ${formatMoney(socialTotal)}`
          : '社保：未检测到社保文件，本次只生成工资阶段结果；补齐社保后重新点击工资报账即可生成最终结果，未补齐前不能月结',
        `住房公积金：按在职工资当前公积金合计 ${formatMoney(integratedActiveHousingFund)} 生成个人和单位公积金`,
        tax
          ? `个税：读取 ${tax.rows.length} 人，总额 ${formatMoney(tax.totalTax)}，已写入在职工资「${taxField}」 ${integratedActiveRecompute.taxApplied} 人${integratedActiveRecompute.taxMissing ? `，库中缺失 ${integratedActiveRecompute.taxMissing} 人` : ''}`
          : '个税：未检测到个税文件，本次不报个税',
        ...insuranceCheck.messages
      ]
      const warnings = [
        ...(tax?.missingIdCards.length
          ? [`个税表有 ${tax.missingIdCards.length} 行缺少身份证号，需要人工核对`]
          : []),
        ...(integratedActiveRecompute.taxMissing > 0
          ? [`个税表有 ${integratedActiveRecompute.taxMissing} 人在在职工资中找不到对应记录，未回写`]
          : []),
        ...insuranceCheck.warnings
      ]
      const messages = warnings.length === 0
        ? appendBusinessSummaryMessages(detailMessages, buildBusinessSummary({
            active: integratedActiveRecompute,
            survivor: integratedOtherPaySummary,
            retiredHousing: integratedRetiredPaySummary
          }))
        : detailMessages

      return okRule(
        workflowName,
        integratedActiveRecompute.rowCount +
          integratedOtherPaySummary.rowCount +
          integratedRetiredPaySummary.rowCount +
          (socialSecurity?.rowCount ?? 0) +
          (tax?.rows.length ?? 0),
        messages,
        warnings
      )
    }

    if (!salary) {
      if (!socialSecurity) {
        return {
          ok: false,
          affectedRows: 0,
          messages: [],
          warnings: ['社保每月必办，请先放入社保未申报汇总文件。']
        }
      }
      const [integratedPersonalInsurance, integratedActiveHousingFund] = await Promise.all([
        loadIntegratedActivePersonalInsuranceTotals(),
        loadIntegratedActiveHousingFund()
      ])
      const insuranceCheck = buildPersonalInsuranceCheck(socialSecurity, undefined, integratedPersonalInsurance)
      const socialTotal = roundMoney(Object.values(socialSecurity.byItem).reduce((sum, value) => sum + value, 0))
      const messages = [
        `报账模式：社保补齐处理${tax ? '，包含个税扣款' : '，不处理个税'}`,
        `社保：读取 ${socialSecurity.rowCount} 行，按征收品目汇总 ${Object.keys(socialSecurity.byItem).length} 类，合计 ${formatMoney(socialTotal)}`,
        `住房公积金：按在职工资当前公积金合计 ${formatMoney(integratedActiveHousingFund)} 生成个人和单位公积金`,
        tax
          ? `个税：读取 ${tax.rows.length} 人，总额 ${formatMoney(tax.totalTax)}`
          : '个税：未检测到个税文件，本次只处理五险一金',
        ...insuranceCheck.messages
      ]
      return okRule(
        workflowName,
        socialSecurity.rowCount + (tax?.rows.length ?? 0),
        messages,
        insuranceCheck.warnings
      )
    }
    const identityFallbackOptions = { allowIdentityFallback: Boolean(input.confirmIdentityFallback) }
    let activeFieldWriteBackPlan = await buildIntegratedActiveWriteBackPlan(
      salary.activePeople,
      identityFallbackOptions
    )
    let activeBackpayWriteBackPlan = await buildIntegratedActiveBackpayAdjustmentPlan(
      salary.activePeople,
      identityFallbackOptions
    )
    let activeWriteBackPlan = mergeIntegratedWriteBackPlans(
      activeFieldWriteBackPlan,
      activeBackpayWriteBackPlan
    )
    let survivorWriteBackPlan = await buildIntegratedOtherWriteBackPlan(
      salary.survivorPeople,
      identityFallbackOptions
    )
    let writeBackPlan = mergeIntegratedWriteBackPlans(activeWriteBackPlan, survivorWriteBackPlan)
    const blockedIdentityReviews = writeBackPlan.identityReviews.filter((review) => !review.confirmable)
    const confirmableIdentityReviews = writeBackPlan.identityReviews.filter((review) => review.confirmable)
    let writeBackPreview = buildMonthlyPayrollWriteBackPreview(writeBackPlan, {
      requiresConfirmation: writeBackPlan.changes.length > 0 && !input.confirmWriteBack,
      requiresIdentityConfirmation: confirmableIdentityReviews.length > 0 && !input.confirmIdentityFallback,
      applied: false
    })

    if (blockedIdentityReviews.length > 0 || (confirmableIdentityReviews.length > 0 && !input.confirmIdentityFallback)) {
      const pendingPreview = buildMonthlyPayrollWriteBackPreview(writeBackPlan, {
        requiresConfirmation: false,
        requiresIdentityConfirmation: blockedIdentityReviews.length === 0 && confirmableIdentityReviews.length > 0,
        applied: false
      })
      const warnings = blockedIdentityReviews.length > 0
        ? [
            `发现 ${blockedIdentityReviews.length} 条工资表与本地工资数据身份无法自动确认，请先人工修正后再预处理。`,
            ...pendingPreview.identityReviewExamples.map((item) => `身份待处理：${item}`)
          ]
        : [
            `发现 ${confirmableIdentityReviews.length} 条工资表与本地工资数据身份证不一致，但姓名唯一匹配，需要人工确认后才允许继续。`,
            ...pendingPreview.identityReviewExamples.map((item) => `身份待确认：${item}`)
          ]
      const result = okRule(
        workflowName,
        salary.activePeople.length + salary.survivorPeople.length + (socialSecurity?.rowCount ?? 0) + (tax?.rows.length ?? 0),
        [
          `身份核对：${pendingPreview.identityReviewCount} 条需人工处理，确认前不会回写或更新本地工资数据。`
        ],
        warnings
      )
      result.monthlyPayrollWriteBack = pendingPreview
      return result
    }

    if (writeBackPlan.changes.length > 0 && !input.confirmWriteBack) {
      const pendingPreview = buildMonthlyPayrollWriteBackPreview(writeBackPlan, {
        requiresConfirmation: true,
        requiresIdentityConfirmation: false,
        applied: false
      })
      const result = okRule(
        workflowName,
        salary.activePeople.length + salary.survivorPeople.length + (socialSecurity?.rowCount ?? 0) + (tax?.rows.length ?? 0),
        [
          `发现工资表与本地工资数据有 ${writeBackPlan.changes.length} 项金额差异可自动回写，涉及 ${pendingPreview.personCount} 人`,
          ...pendingPreview.examples.map((item) => `可回写：${item}`),
          ...(writeBackPlan.manual.length > 0
            ? [`另有 ${writeBackPlan.manual.length} 项差异需要人工判断，自动回写后会继续复核`]
            : [])
        ],
        ['请确认是否将工资表中的可回写金额同步到本地工资数据；确认后系统会自动复核，仍有差异则停止生成报表。']
      )
      result.monthlyPayrollWriteBack = pendingPreview
      return result
    }

    let integratedActiveRecompute: IntegratedActiveRecomputeResult
    if (writeBackPlan.changes.length > 0 && input.confirmWriteBack) {
      const appliedPlan = writeBackPlan
      await applyIntegratedWriteBackPlan(writeBackPlan)
      integratedActiveRecompute = activeWriteBackPlan.changes.length > 0
        ? await applyTaxAndRecomputeIntegratedActive(taxByIdCard, {
            clearTaxWhenMissing: !tax,
            preserveExistingTaxField: activeBackpayWriteBackPlan.changes.length > 0
          })
        : await summarizeIntegratedActive(taxByIdCard)
      activeFieldWriteBackPlan = await buildIntegratedActiveWriteBackPlan(
        salary.activePeople,
        identityFallbackOptions
      )
      activeBackpayWriteBackPlan = await buildIntegratedActiveBackpayAdjustmentPlan(
        salary.activePeople,
        identityFallbackOptions
      )
      activeWriteBackPlan = mergeIntegratedWriteBackPlans(
        activeFieldWriteBackPlan,
        activeBackpayWriteBackPlan
      )
      survivorWriteBackPlan = await buildIntegratedOtherWriteBackPlan(
        salary.survivorPeople,
        identityFallbackOptions
      )
      writeBackPlan = mergeIntegratedWriteBackPlans(activeWriteBackPlan, survivorWriteBackPlan)
      writeBackPreview = mergeAppliedWriteBackPreview(appliedPlan, writeBackPlan)
    } else {
      integratedActiveRecompute = await summarizeIntegratedActive(taxByIdCard)
    }

    const [activeCompare, survivorCompare, integratedPersonalInsurance] = await Promise.all([
      comparePayrollPeople('公办在职', salary.activePeople, '在职工资', getActiveCompareFields(taxField), identityFallbackOptions),
      comparePayrollPeople('遗补', salary.survivorPeople, '其他工资', survivorCompareFields, identityFallbackOptions),
      loadIntegratedActivePersonalInsuranceTotals()
    ])
    const messageTooltips = buildCompareMessageTooltips([activeCompare, survivorCompare])
    const insuranceCheck = buildPersonalInsuranceCheck(socialSecurity, salary, integratedPersonalInsurance)

    const salaryActualPay = num(salary.active['实发工资合计'])
    const actualPayDiff = roundMoney(salaryActualPay - integratedActiveRecompute.actualPayTotal)
    const actualPayMatched = Math.abs(actualPayDiff) < 0.01

    const mode = socialSecurity ? '工资+社保' : '工资阶段结果'
    const detailMessages = [
      `报账模式：${mode}${tax ? '，包含个税扣款' : '，不处理个税'}`,
      `工资表：在职 ${salary.activePeople.length} 人，遗补 ${salary.survivorPeople.length} 人`,
      formatCompareMessage(activeCompare),
      formatCompareMessage(survivorCompare),
      socialSecurity
        ? `社保：读取 ${socialSecurity.rowCount} 行，按征收品目汇总 ${Object.keys(socialSecurity.byItem).length} 类`
        : '社保：未检测到社保文件，本次只生成工资阶段结果；补齐社保后重新点击工资报账即可生成最终结果，未补齐前不能月结',
      tax
        ? `个税：读取 ${tax.rows.length} 人，总额 ${formatMoney(tax.totalTax)}，${writeBackPreview.applied ? `已回写到在职工资「${taxField}」` : `已按在职工资「${taxField}」核对`} ${integratedActiveRecompute.taxApplied} 人${integratedActiveRecompute.taxMissing ? `，库中缺失 ${integratedActiveRecompute.taxMissing} 人` : ''}`
        : '个税：未检测到个税文件，本次跳过个税扣款和补发工资；如本单位无个税或个税另行代收，可继续不提供个税文件',
      ...(writeBackPreview.applied
        ? [`工资表金额差异已自动回写 ${writeBackPreview.syncableCount} 项，复核后${activeCompare.changed === 0 ? '在职工资已一致' : `仍有 ${activeCompare.changed} 人存在差异`}`]
        : []),
      ...(writeBackPreview.identityReviewCount > 0 && input.confirmIdentityFallback
        ? [`身份核对：已人工确认 ${writeBackPreview.identityConfirmableCount} 条姓名唯一匹配，本次未自动修改身份证号`]
        : []),
      `${writeBackPreview.applied ? '在职工资已按公式重算' : '在职工资当前汇总'} ${integratedActiveRecompute.rowCount} 人：应发合计 ${formatMoney(integratedActiveRecompute.payableTotal)}，实发合计 ${formatMoney(integratedActiveRecompute.actualPayTotal)}`,
      actualPayMatched
        ? `实发核对：工资表 ${formatMoney(salaryActualPay)} 与 在职工资 ${formatMoney(integratedActiveRecompute.actualPayTotal)} 一致`
        : `实发核对：工资表 ${formatMoney(salaryActualPay)} 与 在职工资 ${formatMoney(integratedActiveRecompute.actualPayTotal)} 差 ${formatMoney(actualPayDiff)}`,
      ...insuranceCheck.messages
    ]
    const warnings = [
      ...(activeCompare.added + activeCompare.removed + activeCompare.changed > 0
        ? [formatCompareWarning(activeCompare)]
        : []),
      ...(survivorCompare.added + survivorCompare.removed + survivorCompare.changed > 0
        ? [formatCompareWarning(survivorCompare)]
        : []),
      ...(tax?.missingIdCards.length
        ? [`个税表有 ${tax.missingIdCards.length} 行缺少身份证号，需要人工核对`]
        : []),
      ...(integratedActiveRecompute.taxMissing > 0
        ? [`个税表有 ${integratedActiveRecompute.taxMissing} 人在在职工资中找不到对应记录，未回写`]
        : []),
      ...(writeBackPreview.applied && activeCompare.changed > 0
        ? ['自动回写后工资表与在职工资仍有差异，请人工介入；本次不会自动生成报表']
        : []),
      ...(actualPayMatched
        ? []
        : [`工资表实发合计 ${formatMoney(salaryActualPay)} 与在职工资实发合计 ${formatMoney(integratedActiveRecompute.actualPayTotal)} 不一致（差 ${formatMoney(actualPayDiff)}），请先排查后再生成报表`]),
      ...insuranceCheck.warnings
    ]
    const messages = warnings.length === 0
      ? appendBusinessSummaryMessages(detailMessages, buildBusinessSummary({
          active: integratedActiveRecompute,
          survivor: integratedOtherPaySummary,
          retiredHousing: integratedRetiredPaySummary
        }))
      : detailMessages

    const result = okRule(
      workflowName,
      salary.activePeople.length + salary.survivorPeople.length + (socialSecurity?.rowCount ?? 0) + (tax?.rows.length ?? 0),
      messages,
      warnings
    )
    result.monthlyPayrollWriteBack = writeBackPreview
    result.messageTooltips = messageTooltips
    return result
  } catch (error) {
    return failRule(workflowName, error)
  }
}

export async function generateMonthlyPayrollReports(
  payload?: { monthlyPayroll?: MonthlyPayrollWorkflowInput }
): Promise<RuleResult> {
  try {
    const report = await generateMonthlyPayrollReportView(payload?.monthlyPayroll)
    const affectedRows = report.sheets.reduce((total, sheet) => total + sheet.rows.length, 0)
    if (!report.ok) {
      const result = failRule(generateWorkflowName, report.message)
      result.affectedRows = affectedRows
      result.warnings = [
        ...result.warnings,
        ...reconciliationIssueMessages(report.reconciliation)
      ]
      result.monthlyPayrollReport = report
      return result
    }
    const outputMessages = [
      report.insuranceImportPath ? `保险导入：${report.insuranceImportPath}` : '',
      report.salaryImportPath ? `工资导入：${report.salaryImportPath}` : '',
      report.payrollBackpayPath ? `补发工资：${report.payrollBackpayPath}` : '',
      report.voucherImportPath ? `凭证导入：${report.voucherImportPath}` : ''
    ].filter(Boolean)
    const result = okRule(
      generateWorkflowName,
      affectedRows,
      [report.message, ...outputMessages],
      []
    )
    result.monthlyPayrollReport = report
    return result
  } catch (error) {
    return failRule(generateWorkflowName, error)
  }
}

export async function generateMonthlyPayrollReportView(
  input?: MonthlyPayrollWorkflowInput
): Promise<MonthlyPayrollReportResult> {
  input = normalizeMonthlyPayrollInput(input)
  const sourceError = missingSourceMessage(input)
  if (sourceError) {
    throw new Error(sourceError)
  }
  const targetDate = assertCurrentPayrollPeriod(input)
  if (await isMonthlyPayrollMonthArchived(targetDate.year, targetDate.month)) {
    throw new Error(`${targetDate.year}年${targetDate.month}月工资已月结，不能重新生成报表。请在历史报表中查看月结记录。`)
  }

  const [rawSalary, socialSecurity, tax] = await Promise.all([
    input.salaryWorkbookPath
      ? parseSalaryWorkbook(input.salaryWorkbookPath)
      : Promise.resolve<SalarySummary | undefined>(undefined),
    input.socialSecurityWorkbookPath
      ? parseSocialSecurityWorkbook(input.socialSecurityWorkbookPath)
      : Promise.resolve<SocialSecuritySummary | undefined>(undefined),
    input.taxWorkbookPath
      ? parseTaxWorkbook(input.taxWorkbookPath)
      : Promise.resolve<TaxSummary | undefined>(undefined)
  ])
  validateMonthlyPayrollSourcePeriods(targetDate, socialSecurity, tax)
  const monthlyPayrollSettings = await readMonthlyPayrollSettings()
  const taxField = monthlyPayrollSettings.taxField
  const dataSourceMode = normalizeMonthlyPayrollDataSourceMode(input.dataSourceMode)
  const useIntegratedDataSource = dataSourceMode === 'integrated'
  const taxByIdCard = buildTaxByIdCardFromSummary(tax)
  const salary = rawSalary
    ? applyTaxToSalarySummary(rawSalary, taxByIdCard, { clearTaxWhenMissing: !tax })
    : undefined
  const preserveIntegratedTaxField = !useIntegratedDataSource && hasActiveBackpayAdjustments(salary)
  const integratedActiveSummary = await applyTaxAndRecomputeIntegratedActive(taxByIdCard, {
    clearTaxWhenMissing: !tax,
    preserveExistingTaxField: preserveIntegratedTaxField
  })
  const integratedOtherPaySummary = await recomputeIntegratedOtherLikeWorksheet('其他工资')
  const integratedRetiredPaySummary = await recomputeIntegratedOtherLikeWorksheet('退休工资')

  const [
    retired,
    retiredHousingPeople,
    unit,
    integratedActiveHousingFund,
    integratedActiveAggregates,
    integratedRetiredAggregates,
    integratedOtherAggregates,
    integratedBackpayRows
  ] = await Promise.all([
    loadRetiredSummary(),
    loadRetiredHousingDetails(),
    readUnitSettings(),
    loadIntegratedActiveHousingFund(),
    loadIntegratedActiveAggregates(),
    loadIntegratedSimpleAggregates('退休工资'),
    loadIntegratedSimpleAggregates('其他工资'),
    loadIntegratedActiveBackpayRows()
  ])
  const integratedAggregates = {
    active: integratedActiveAggregates,
    retired: integratedRetiredAggregates,
    other: integratedOtherAggregates
  }
  const reportSalary = useIntegratedDataSource
    ? buildSalarySummaryFromIntegratedAggregates(integratedActiveAggregates, integratedOtherAggregates)
    : salary
  const reportRetired = useIntegratedDataSource
    ? { count: integratedRetiredAggregates.count, housing: integratedRetiredAggregates.应发工资小计 }
    : retired
  const activeIdCardResolver = await buildIntegratedActiveIdCardResolver()
  const sheets = input.processScope === 'social'
    ? buildSocialOnlyReportSheets(
        socialSecurity,
        tax,
        unit,
        integratedActiveHousingFund,
        reportSalary,
        reportRetired
      )
    : buildReportSheets(
        reportSalary!,
        socialSecurity,
        tax,
        reportRetired,
        unit,
        integratedActiveHousingFund,
        retiredHousingPeople,
        useIntegratedDataSource ? integratedAggregates : undefined,
        useIntegratedDataSource ? integratedBackpayRows : undefined,
        activeIdCardResolver
    )
  const voucherPageCounts = await buildVoucherPageCounts(input, sheets)
  applyVoucherPageCounts(sheets, voucherPageCounts)
  const reportFingerprint = fingerprintReportSheets(sheets)
  const period = targetDate
  const reconciliation = await reconcileMonthlyPayrollReport({
    salary,
    socialSecurity,
    tax,
    dataSourceMode,
    allowIdentityFallback: Boolean(input.confirmIdentityFallback),
    sheets,
    integratedActiveAggregates,
    integratedRetiredAggregates,
    integratedOtherAggregates
  })
  if (reconciliation.status === 'failed') {
    return {
      ok: false,
      message: reconciliation.summary,
      taxField,
      processScope: input.processScope,
      dataSourceMode,
      voucherPageCounts,
      reconciliation,
      sheets
    }
  }
  const salaryImportFields = normalizeList(input.salaryImportFields)
  const salaryImportIdCards = normalizeList(input.salaryImportIdCards)
  const shouldGenerateSalaryImport = Boolean(
    salary &&
      !useIntegratedDataSource &&
      input.processScope !== 'social' &&
      salary.activePeople.length > 0 &&
      salaryImportFields.length > 0 &&
      salaryImportIdCards.length > 0
  )
  const shouldWriteTaxSalaryWorkbook = Boolean(
    rawSalary && salary && !useIntegratedDataSource && tax && input.salaryWorkbookPath
  )
  const stamp = timestamp()
  const existingSalaryOriginalPath = shouldWriteTaxSalaryWorkbook && input.salaryWorkbookPath
    ? await findMonthlyPayrollSourceSalaryOriginalPath(period.year, period.month, input.salaryWorkbookPath)
    : null
  const taxWriteBackupPath = shouldWriteTaxSalaryWorkbook && rawSalary && input.salaryWorkbookPath
    ? await backupAndWriteTaxToSalaryWorkbook(
        input.salaryWorkbookPath,
        rawSalary,
        taxByIdCard,
        period,
        stamp,
        existingSalaryOriginalPath
      )
    : null
  const sourceSalaryOriginalPath = taxWriteBackupPath ?? existingSalaryOriginalPath
  await registerMonthlyPayrollSources(input, { salary, socialSecurity, tax })
  const previousRun = await findSameMonthlyPayrollRun(
    period.year,
    period.month,
    reportFingerprint,
    dataSourceMode
  )
  if (
    previousRun?.reportSnapshot?.reconciliation?.status === 'passed' &&
      !shouldGenerateSalaryImport
  ) {
    return {
      ok: true,
      message: '本次报表内容无变化，未重新生成文件，已沿用上次输出结果',
      insuranceImportPath: previousRun.insuranceImportPath ?? undefined,
      salaryImportPath: previousRun.salaryImportPath ?? undefined,
      payrollBackpayPath: previousRun.payrollBackpayPath ?? undefined,
      voucherImportPath: previousRun.voucherImportPath ?? undefined,
      taxField,
      processScope: input.processScope,
      dataSourceMode,
      voucherPageCounts,
      reconciliation,
      sheets
    }
  }

  const outputDir = getMonthlyPayrollTempPath(period.year, period.month)
  mkdirSync(outputDir, { recursive: true })
  const sourceSalaryPath = input.salaryWorkbookPath ?? null
  const insuranceImportPath = socialSecurity ? join(outputDir, `工资报账_保险导入_${stamp}.xlsx`) : undefined
  const salaryImportPath = shouldGenerateSalaryImport ? join(outputDir, `工资报账_工资导入_${stamp}.xls`) : undefined
  const backpaySheet = sheets.find((sheet) => sheet.name === '补发工资')
  const hasBackpayRows = Boolean(backpaySheet?.rows.length)
  const payrollBackpayPath = hasBackpayRows ? join(outputDir, `工资报账_补发工资_${stamp}.xls`) : undefined
  const voucherSheet = sheets.find((sheet) => sheet.name === '凭证')
  const voucherImportPath = voucherSheet ? join(outputDir, `工资报账_凭证_${stamp}.xlsx`) : undefined

  if (insuranceImportPath) {
    const insuranceSheet = sheets.find((sheet) => sheet.name === '保险导入')
    if (insuranceSheet) writeWorkbook(insuranceImportPath, [{ ...insuranceSheet, name: 'Sheet1' }])
  }
  if (voucherImportPath && voucherSheet) {
    writeWorkbook(voucherImportPath, [voucherSheet])
  }
  if (salaryImportPath && salary) {
    await writeSalaryImportWorkbook(salaryImportPath, salary, {
      includedFields: salaryImportFields,
      includedIdCards: salaryImportIdCards,
      resolveIdCard: activeIdCardResolver
    })
  }
  if (payrollBackpayPath) {
    if (backpaySheet) {
      writeWorkbook(
        payrollBackpayPath,
        [
          backpaySheet,
          {
            name: '工资类别',
            columns: ['A'],
            showColumnHeader: false,
            rows: [['行政'], ['事业'], ['行政离休'], ['行政退休'], ['事业离休'], ['事业退休'], ['司法']]
          }
        ],
        'xls'
      )
    }
  }

  const outputMessages = [
    insuranceImportPath ? '保险导入文件' : '',
    salaryImportPath ? '工资导入文件' : '',
    payrollBackpayPath ? '补发工资文件' : '',
    voucherImportPath ? '凭证导入文件' : '',
    taxWriteBackupPath ? '工资表个税已直接回写' : ''
  ].filter(Boolean)
  const businessSummary = useIntegratedDataSource
    ? buildBusinessSummary({
        active: integratedActiveSummary,
        survivor: integratedOtherPaySummary,
        retiredHousing: integratedRetiredPaySummary
      })
    : buildSalaryWorkbookBusinessSummary(reportSalary, reportRetired)

  const reportMessage = `已生成 ${sheets.length} 张报表预览${outputMessages.length ? `，并输出${outputMessages.join('、')}` : ''}`

  await persistMonthlyPayrollRun({
    year: period.year,
    month: period.month,
    unitFullName: unit.unitFullName,
    activeCount: businessSummary.activeCount,
    survivorCount: businessSummary.survivorCount,
    retiredHousingCount: businessSummary.retiredHousingCount,
    salaryTotal: useIntegratedDataSource
      ? integratedActiveAggregates.应发工资
      : reportSalary ? num(reportSalary.active['应发工资合计']) : 0,
    withholdingTotal: useIntegratedDataSource
      ? integratedActiveAggregates.五险一金合计
      : reportSalary ? num(reportSalary.active['五险一金']) : 0,
    taxTotal: tax ? (useIntegratedDataSource ? integratedActiveAggregates.个税 : tax.totalTax) : 0,
    actualPay: roundMoney(
      businessSummary.activeActualPay +
        businessSummary.survivorActualPay +
        businessSummary.retiredHousingActualPay
    ),
    activeActualPay: businessSummary.activeActualPay,
    survivorActualPay: businessSummary.survivorActualPay,
    retiredHousingActualPay: businessSummary.retiredHousingActualPay,
    retiredHousing: reportRetired.housing,
    sourceSalaryPath,
    sourceSocialPath: input.socialSecurityWorkbookPath ?? null,
    sourceTaxPath: input.taxWorkbookPath ?? null,
    insuranceImportPath: insuranceImportPath ?? null,
    voucherImportPath: voucherImportPath ?? null,
    salaryImportPath: salaryImportPath ?? null,
    payrollBackpayPath: payrollBackpayPath ?? null,
    reportFingerprint,
    taxField,
    dataSourceMode,
    reportSnapshot: {
      ok: true,
      message: reportMessage,
      insuranceImportPath,
      salaryImportPath,
      payrollBackpayPath,
      voucherImportPath,
      sourceSalaryOriginalPath: sourceSalaryOriginalPath ?? undefined,
      taxField,
      processScope: input.processScope,
      dataSourceMode,
      voucherPageCounts,
      reconciliation,
      sheets
    }
  })

  return {
    ok: true,
    message: reportMessage,
    insuranceImportPath,
    salaryImportPath,
    payrollBackpayPath,
    voucherImportPath,
    sourceSalaryOriginalPath: sourceSalaryOriginalPath ?? undefined,
    taxField,
    processScope: input.processScope,
    dataSourceMode,
    voucherPageCounts,
    reconciliation,
    sheets
  }
}

function reconciliationIssueMessages(
  reconciliation: MonthlyPayrollReconciliationResult | undefined
): string[] {
  return (reconciliation?.issues ?? [])
    .slice(0, 8)
    .map((issue) => issue.message)
}

function buildReportSheets(
  salary: SalarySummary,
  socialSecurity: SocialSecuritySummary | undefined,
  tax: TaxSummary | undefined,
  retired: RetiredSummary = { count: 0, housing: 0 },
  unit: UnitSettings,
  integratedActiveHousingFund = 0,
  retiredHousingPeople: RetiredHousingPerson[] = [],
  integratedAggregates?: {
    active: IntegratedActiveAggregates
    retired: IntegratedSimpleAggregates
    other: IntegratedSimpleAggregates
  },
  integratedBackpayRows?: Array<Array<string | number>>,
  activeIdCardResolver?: IntegratedIdCardResolver
): MonthlyPayrollReportSheet[] {
  const active = { ...salary.active }
  const survivor = salary.survivor
  const socialRows = socialSecurity
    ? Object.entries(socialSecurity.byItem).map(([item, amount]) => [item, amount] as [string, number])
    : []
  const socialTotal = roundMoney(socialRows.reduce((sum, [, amount]) => sum + amount, 0))
  const taxTotal = tax?.totalTax ?? 0
  active['住房公积金'] = resolveHousingFund(salary, integratedActiveHousingFund)
  active['个税'] = tax ? taxTotal : 0
  const salaryTotal = num(active['应发工资合计'])
  const survivorTotal = num(survivor['合计'])
  const retiredHousing = retired.housing
  const activeInsurance = num(active['五险一金'])
  const activeTax = num(active['个税'])
  const activeInsuranceWithoutTax = roundMoney(
    num(active['养老保险']) +
      num(active['职业年金']) +
      num(active['医保大病统筹']) +
      num(active['失业保险']) +
      num(active['住房公积金'])
  )
  const basicActual = roundMoney(num(active['应发基础工资']) - activeInsuranceWithoutTax)
  const salaryReimburseTotal = roundMoney(salaryTotal + survivorTotal + retiredHousing)
  const actualPay = roundMoney(num(active['实发工资合计']) + survivorTotal + retiredHousing)
  const withholdingTotal = activeInsurance
  const useIntegrated = Boolean(integratedAggregates)
  const integratedActive = integratedAggregates?.active
  const integratedRetired = integratedAggregates?.retired
  const integratedOther = integratedAggregates?.other
  const summaryActiveCount = useIntegrated ? integratedActive!.count : salary.activePeople.length
  const summaryBasic = useIntegrated ? integratedActive!.基本工资 : num(active['应发基础工资'])
  const summaryTeachingAge = useIntegrated ? integratedActive!.教龄津贴 : num(active['教龄津贴'])
  const summaryRural = useIntegrated ? integratedActive!.其他一 : num(active['乡镇补贴'])
  const summaryRemote = useIntegrated ? 0 : num(active['边远乡镇补贴'])
  const summaryHousing = useIntegrated ? integratedActive!.住房补贴 : num(active['住房补贴'])
  const summaryPerformance = useIntegrated ? integratedActive!.基础性绩效 : num(active['基础性绩效'])
  const summaryTraffic = useIntegrated ? integratedActive!.交通补贴 : num(active['交通补贴'])
  const summaryActiveBackpay = useIntegrated ? integratedActive!.补发工资 : 0
  const summarySurvivorCount = useIntegrated ? integratedOther!.count : salary.survivorPeople.length
  const summarySurvivorTotal = useIntegrated ? integratedOther!.应发工资小计 : survivorTotal
  const summaryRetiredHousingTotal = useIntegrated ? integratedRetired!.应发工资小计 : retiredHousing
  const summaryActivePayable = useIntegrated
    ? integratedActive!.应发工资
    : roundMoney(
        num(active['应发基础工资']) +
          num(active['教龄津贴']) +
          num(active['乡镇补贴']) +
          num(active['边远乡镇补贴']) +
          num(active['住房补贴']) +
          num(active['基础性绩效']) +
          num(active['交通补贴'])
      )
  const salaryBudgetTotal = roundMoney(
    summaryBasic + summaryTeachingAge + summaryRural + summaryRemote + summaryHousing + summaryPerformance
  )
  const salaryBudgetGrandTotal = useIntegrated
    ? roundMoney(summaryActivePayable + summarySurvivorTotal + summaryRetiredHousingTotal)
    : roundMoney(salaryBudgetTotal + summaryTraffic + summarySurvivorTotal)
  const salaryBudgetActual = roundMoney(salaryBudgetGrandTotal - withholdingTotal)
  const insuranceVoucherTotal = roundMoney(socialTotal + activeTax + num(active['住房公积金']) * 2)
  const payrollMonth = `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`
  const today = new Date()
  const unitCode = text(unit.unitImportCode)
  const summaryMonth = `${today.getMonth() + 1}月份`
  const summaryUnitName = shortInsuranceSummaryUnitName(unit.unitFullName)

  const titleAuto = `${unit.unitFullName}${payrollMonth}工资发放汇总表`
  const subtitleLeft = '       （自动生成表）                单位：元'
  const subtitleRight = '（自动生成表）                            单位：元'
  // 自动生成 / 报销凭证 各行金额：useIntegrated 时全部走本地三张工资表汇总
  const housing = useIntegrated ? integratedActive!.住房补贴 : num(active['住房补贴'])
  const teachingAge = useIntegrated ? integratedActive!.教龄津贴 : num(active['教龄津贴'])
  const traffic = useIntegrated ? integratedActive!.交通补贴 : num(active['交通补贴'])
  const performance = useIntegrated ? integratedActive!.基础性绩效 : num(active['基础性绩效'])
  const ruralTotal = useIntegrated
    ? integratedActive!.其他一
    : roundMoney(num(active['乡镇补贴']) + num(active['边远乡镇补贴']))
  // 自动生成中的"基本工资"=在职工资(岗位+薪级) - 个人代扣(不含个税)；其它项保持原口径
  const autoActiveInsuranceWithoutTax = useIntegrated
    ? roundMoney(
        integratedActive!.养老保险 +
          integratedActive!.职业年金 +
          integratedActive!.医疗保险 +
          integratedActive!.失业保险 +
          integratedActive!.公积金
      )
    : activeInsuranceWithoutTax
  const autoBasicActual = useIntegrated
    ? roundMoney(integratedActive!.基本工资 - autoActiveInsuranceWithoutTax)
    : basicActual
  const autoSurvivorTotal = useIntegrated ? integratedOther!.应发工资小计 : survivorTotal
  const autoRetiredHousing = useIntegrated ? integratedRetired!.应发工资小计 : retiredHousing
  const autoActiveInsurance = useIntegrated ? integratedActive!.五险一金合计 : activeInsurance
  const autoActiveTax = useIntegrated ? integratedActive!.个税 : activeTax
  const autoPension = useIntegrated ? integratedActive!.养老保险 : num(active['养老保险'])
  const autoAnnuity = useIntegrated ? integratedActive!.职业年金 : num(active['职业年金'])
  const autoMedical = useIntegrated ? integratedActive!.医疗保险 : num(active['医保大病统筹'])
  const autoUnemployment = useIntegrated ? integratedActive!.失业保险 : num(active['失业保险'])
  const autoHousingFund = useIntegrated ? integratedActive!.公积金 : num(active['住房公积金'])
  const middlePayBasicEtc = roundMoney(autoBasicActual + teachingAge + housing + performance + autoActiveInsurance)
  const middleBorrowTotal = roundMoney(
    middlePayBasicEtc + traffic + ruralTotal + autoSurvivorTotal + autoRetiredHousing
  )
  const leftTotal = roundMoney(
    autoBasicActual + teachingAge + traffic + performance + ruralTotal + housing + autoSurvivorTotal + autoRetiredHousing
  )
  const payrollSummaryTitle = `${unit.unitFullName}${payrollMonth}工资发放汇总表`
  const summaryActualPay = roundMoney(salaryBudgetGrandTotal - withholdingTotal)
  const payrollSummaryFooter = `本月应发：${formatVoucherAmount(salaryBudgetGrandTotal)}，  代扣未发：${formatVoucherAmount(withholdingTotal)}，  实发：${formatVoucherAmount(summaryActualPay)}。`
  const summaryColumnCount = 13
  const blankRow = (): string[] => Array.from({ length: summaryColumnCount }, () => '')
  const titleRow = (text: string): Array<string | number> => {
    const row: Array<string | number> = blankRow()
    row[0] = text
    return row
  }
  // 上半部分（财政补助支出）13 列；下半部分（代扣款）8 项，靠 2 列合并撑出更宽的视觉宽度
  const summaryColumnWidths = [7, 11, 9, 9, 9, 11, 9, 7, 10, 10, 9, 10, 11]
  const summaryRows: Array<Array<string | number>> = [
    titleRow(payrollSummaryTitle),
    (() => { const r = blankRow() as Array<string | number>; r[summaryColumnCount - 1] = '单位：人、元'; return r })(),
    titleRow('财政补助支出'),
    [
      '在职\n人数',
      '基本\n工资',
      '教龄\n津贴',
      '农村\n补贴',
      '住房\n补贴',
      '基础性\n绩效工资',
      '交通\n补贴',
      '遗补\n人数',
      '遗补\n金额',
      '退休\n房补',
      '民办合同\n人数',
      '民办合同\n金额',
      '其中在职\n补发数'
    ],
    [
      summaryActiveCount,
      summaryBasic,
      summaryTeachingAge,
      summaryRural,
      summaryHousing,
      summaryPerformance,
      summaryTraffic,
      summarySurvivorCount,
      summarySurvivorTotal,
      summaryRetiredHousingTotal,
      0,
      0,
      summaryActiveBackpay
    ],
    blankRow(),
    titleRow('代扣款'),
    (() => {
      const r = blankRow() as Array<string | number>
      const headers = [
        '养老\n保险',
        '职业\n年金',
        '医保\n大病统筹',
        '失业\n保险',
        '住房\n公积金',
        '个税',
        '合同代扣\n"五险"',
        '小计'
      ]
      // 0-1, 2-3, 4-5, 6-7, 8-9, 10, 11, 12
      const slots = [0, 2, 4, 6, 8, 10, 11, 12]
      headers.forEach((value, idx) => { r[slots[idx]] = value })
      return r
    })(),
    (() => {
      const r = blankRow() as Array<string | number>
      const values: Array<string | number> = [
        num(active['养老保险']),
        num(active['职业年金']),
        num(active['医保大病统筹']),
        num(active['失业保险']),
        num(active['住房公积金']),
        activeTax,
        0,
        withholdingTotal
      ]
      const slots = [0, 2, 4, 6, 8, 10, 11, 12]
      values.forEach((value, idx) => { r[slots[idx]] = value })
      return r
    })(),
    titleRow(payrollSummaryFooter)
  ]

  // 报销凭证 C1 行：useIntegrated 时全部用本地工资数据口径
  const voucherReimburseTotal = useIntegrated ? salaryBudgetGrandTotal : salaryReimburseTotal
  const voucherWithholding = useIntegrated ? autoActiveInsurance : activeInsurance
  const voucherActualPay = useIntegrated
    ? roundMoney(salaryBudgetGrandTotal - autoActiveInsurance - autoActiveTax)
    : actualPay

  const sheets: MonthlyPayrollReportSheet[] = [
    {
      name: '自动生成',
      columns: gridColumns(12),
      showColumnHeader: false,
      columnWidths: [5.16, 16.5, 19.5, 27.75, 1.25, 25.5, 8.5, 11.5, 1.5, 26.5, 9, 9],
      rowHeights: [27, null, null, 21, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15, 13.15],
      merges: ['A1:D1', 'F1:L1', 'C2:D2', 'F2:L2', 'F3:H3', 'J3:L3', 'I3:I19', 'A13:C13'],
      rows: [
        [titleAuto, '', '', '', '', titleAuto, '', '', '', '', '', ''],
        ['', '', subtitleLeft, '', '', subtitleRight, '', '', '', '', '', ''],
        ['', '', '', '', '', '财务会计', '', '', '', '预算会计', '', ''],
        ['序号', '项目', '账户', '金额', '', '项目', '借方金额', '贷方金额', '', '项目', '借方金额', '贷方金额'],
        [1, '基本工资', '其他应解汇款', autoBasicActual, '', '付基本工资、津补贴、绩效等', middlePayBasicEtc, '', '', '付基本工资', autoBasicActual, ''],
        [2, '教龄津贴、交通补贴', '其他应解汇款', roundMoney(teachingAge + traffic), '', '付交通补贴', traffic, '', '', '付教龄津贴', teachingAge, ''],
        [3, '基础性绩效', '其他应解汇款', performance, '', '付农村工作补贴(含边远)', ruralTotal, '', '', '付农村补贴（含边远）', ruralTotal, ''],
        [4, '乡镇补贴（含边远）', '其他应解汇款', ruralTotal, '', '付遗属补助发放', autoSurvivorTotal, '', '', '付住房补贴', housing, ''],
        [5, '住房补贴', '其他应解汇款', housing, '', '付退休人员房补', autoRetiredHousing, '', '', '付绩效工资', performance, ''],
        [6, '遗属补助', '其他应解汇款', autoSurvivorTotal, '', '付合同教师工资', 0, '', '', '付交通补贴', traffic, ''],
        [7, '退休人员房补', '其他应解汇款', autoRetiredHousing, '', '代扣养老保险', '', autoPension, '', '付遗属补助', autoSurvivorTotal, ''],
        [8, '合同教师', '其他应解汇款', 0, '', '代扣职业年金', '', autoAnnuity, '', '付退休人员房补', autoRetiredHousing, ''],
        ['合计：', '', '', leftTotal, '', '代扣医疗保险', '', autoMedical, '', '付合同教师', 0, ''],
        ['', '', '', '', '', '代扣失业保险', '', autoUnemployment, '', '付工资', '', leftTotal],
        ['', '', '', '', '', '代扣住房公积金', '', autoHousingFund, '', '', '', ''],
        ['', '', '', '', '', '代扣个人所得税', '', autoActiveTax, '', '', '', ''],
        ['', '', '', '', '', '代扣"合同教师保险"', '', 0, '', '', '', ''],
        ['', '', '', '', '', '付工资', '', leftTotal, '', '', '', ''],
        ['', '', '', '', '', '合计', middleBorrowTotal, middleBorrowTotal, '', '合计', leftTotal, leftTotal]
      ]
    },
    {
      name: '工退遗汇总',
      columns: gridColumns(summaryColumnCount),
      showColumnHeader: false,
      columnWidths: summaryColumnWidths,
      rowHeights: [29.65, 17.25, 22, 36, 24, 8, 22, 34, 24, 23],
      merges: [
        'A1:M1',
        'A3:M3',
        'A7:M7',
        'A10:M10',
        'A8:B8', 'C8:D8', 'E8:F8', 'G8:H8', 'I8:J8',
        'A9:B9', 'C9:D9', 'E9:F9', 'G9:H9', 'I9:J9'
      ],
      rows: summaryRows
    },
    {
      name: '报销凭证',
      columns: ['项目', '报账单位', '报销金额', '未报销金额', '实际付款金额', '支付令', '同城转账', '支付方式', '用途', '大写金额', '年', '月', '日', '未报销大写'],
      rows: [
        ...(socialSecurity
          ? [[
              '五险一金',
              unit.unitFullName,
              insuranceVoucherTotal,
              '',
              insuranceVoucherTotal,
              unitCode,
              '',
              '转账支票',
              buildInsuranceVoucherUsage(active, socialSecurity, activeTax, insuranceVoucherTotal),
              toChineseRmb(insuranceVoucherTotal),
              today.getFullYear(),
              today.getMonth() + 1,
              today.getDate(),
              ''
            ] as Array<string | number>]
          : []),
        [
          'C1工资遗补房补',
          unit.unitFullName,
          voucherReimburseTotal,
          voucherWithholding,
          voucherActualPay,
          unitCode,
          '',
          '转账支票',
          buildSalaryVoucherUsage(active, autoSurvivorTotal, autoRetiredHousing, autoBasicActual, voucherWithholding, voucherReimburseTotal),
          toChineseRmb(voucherReimburseTotal),
          today.getFullYear(),
          today.getMonth() + 1,
          today.getDate(),
          toChineseRmb(voucherWithholding)
        ]
      ]
    },
    {
      name: '补发工资',
      columns: [
        '证件号码',
        '月份',
        '姓名',
        '工资类别',
        '业务年度',
        '岗位工资',
        '薪级工资',
        '岗位津贴',
        '生活补贴',
        '绩效工资',
        '工作性津贴',
        '教（工）龄补贴',
        '特岗性津补贴',
        '交通费',
        '公车补贴',
        '住房补贴',
        '基础绩效奖',
        '补发工资',
        '补扣工资',
        '其他一',
        '其他二',
        '其他三',
        '当月个人所得税',
        '支出一'
      ],
      columnWidths: [20, 6, 10, 9, 10, 10, 10, 10, 10, 10, 11, 12, 12, 9, 9, 10, 11, 10, 10, 9, 9, 9, 13, 9],
      rows: integratedBackpayRows ?? buildBackpayRows(salary, tax, activeIdCardResolver)
    }
  ]

  if (socialSecurity) {
    const voucherSheet = buildVoucherSheet(
      {
        unit,
        today,
        active,
        socialSecurity,
        activeTax,
        actualPay,
        basicActual,
        teachingAge: num(active['教龄津贴']),
        ruralTotal: roundMoney(num(active['乡镇补贴']) + num(active['边远乡镇补贴'])),
        housing: num(active['住房补贴']),
        performance: num(active['基础性绩效']),
        traffic: num(active['交通补贴']),
        survivorTotal,
        retiredHousing,
        salaryReimburseTotal,
        insuranceVoucherTotal,
        withholdingTotal,
        salaryVoucherInsurance: activeInsuranceWithoutTax
      },
      { includeSalaryVoucher: true, includeInsuranceVoucher: true }
    )
    sheets.splice(sheets.findIndex((s) => s.name === '报销凭证') + 1, 0, voucherSheet)
  }

  if (socialSecurity) {
    const insurancePersonalPension = sumSocialByCanonicalName(socialSecurity, '养老保险个人')
    const insuranceUnitPension = sumSocialByCanonicalName(socialSecurity, '养老保险单位')
    const insurancePersonalAnnuity = sumSocialByCanonicalName(socialSecurity, '职业年金个人')
    const insuranceUnitAnnuity = sumSocialByCanonicalName(socialSecurity, '职业年金单位')
    const insurancePersonalMedical = sumSocialByCanonicalName(socialSecurity, '医保个人')
    const insuranceUnitMedical = sumSocialByCanonicalName(socialSecurity, '医保单位')
    const insuranceMaternity = sumSocialByCanonicalName(socialSecurity, '生育保险')
    const insurancePersonalUnemployment = sumSocialByCanonicalName(socialSecurity, '失业保险个人')
    const insuranceUnitUnemployment = roundMoney(
      sumSocialByCanonicalName(socialSecurity, '失业保险单位') +
        sumSocialByCanonicalName(socialSecurity, '工伤保险')
    )
    const titleInsurance = `${unit.unitFullName}${payrollMonth}五险一金明细`
    sheets.splice(1, 0, {
      name: '五险一金',
      columns: gridColumns(7),
      showColumnHeader: false,
      columnWidths: [25.75, 9.16, 8, 1.75, 26.25, 9.16, 9.16],
      rowHeights: [27, null, 22.5, 21, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
      merges: ['A1:G1', 'A2:G2', 'A3:C3', 'E3:G3', 'D3:D21'],
      rows: [
        [titleInsurance, '', '', '', '', '', ''],
        [subtitleRight, '', '', '', '', '', ''],
        ['财务会计', '', '', '', '预算会计', '', ''],
        ['项目', '借方金额', '贷方金额', '', '项目', '借方金额', '贷方金额'],
        ['养老保险', roundMoney(insurancePersonalPension + insuranceUnitPension), '', '', '养老保险（个人）', insurancePersonalPension, ''],
        ['职业年金', roundMoney(insurancePersonalAnnuity + insuranceUnitAnnuity), '', '', '养老保险（单位）', insuranceUnitPension, ''],
        ['医保', roundMoney(insurancePersonalMedical + insuranceUnitMedical), '', '', '职业年金（个人）', insurancePersonalAnnuity, ''],
        ['生育保险', insuranceMaternity, '', '', '职业年金（单位）', insuranceUnitAnnuity, ''],
        ['工伤失业', roundMoney(insurancePersonalUnemployment + insuranceUnitUnemployment), '', '', '医保等（个人）', insurancePersonalMedical, ''],
        ['住房公积金（个人）', num(active['住房公积金']), '', '', '医保等（单位）', insuranceUnitMedical, ''],
        ['住房公积金（单位）', num(active['住房公积金']), '', '', '生育保险', insuranceMaternity, ''],
        ['个税', activeTax, '', '', '工伤失业（个人）', insurancePersonalUnemployment, ''],
        ['补缴养老保险', 0, '', '', '工伤失业（单位）', insuranceUnitUnemployment, ''],
        ['补缴职业年金', 0, '', '', '住房公积金（个人）', num(active['住房公积金']), ''],
        ['补缴医保、工伤失业等', 0, '', '', '住房公积金（单位）', num(active['住房公积金']), ''],
        ['付五险一金、个税等（零余额）', '', roundMoney(insuranceVoucherTotal), '', '个税', activeTax, ''],
        ['付补交各类保险等（9674银行存款）', '', 0, '', '补缴养老保险', 0, ''],
        ['', '', '', '', '补缴职业年金', 0, ''],
        ['', '', '', '', '补缴医保、工伤失业等', 0, ''],
        ['', '', '', '', '付五险一金、个税等（零余额）', '', insuranceVoucherTotal],
        ['', '', '', '', '付补交各类保险等（9674银行存款）', '', 0]
      ]
    })
    sheets.push({
      name: '保险导入',
      columns: [
        '*单位代码',
        '*单位名称',
        '*部门经济科目代码',
        '*部门经济科目名称',
        '摘要',
        '*金额',
        '*收款账户名称',
        '*收款账户开户行',
        '*收款账户账号',
        '经办人',
        '审核人',
        '支付业务类型',
        '确认不是政府采购项目支付'
      ],
      columnWidths: [12, 18, 14, 18, 28, 12, 22, 22, 22, 10, 10, 14, 22],
      rows: buildInsuranceImportItems(socialSecurity, active, activeTax).map(([item, amount]) => {
        const isHousing = item.includes('公积金')
        const economicSubject = departmentEconomicSubjectForSocialItem(item)
        return [
          unitCode,
          unit.unitFullName,
          economicSubject.code,
          economicSubject.name,
          `${summaryUnitName}${summaryMonth}${item}`,
          amount,
          isHousing ? unit.housingPayeeName : unit.socialPayeeName,
          isHousing ? unit.housingPayeeBank : unit.socialPayeeBank,
          isHousing ? unit.housingPayeeAccount : unit.socialPayeeAccount,
          '',
          '',
          '',
          '是'
        ]
      })
    })
  }

  if (retiredHousingPeople.length > 0) {
    const integratedTitle = `${unit.unitFullName}${payrollMonth}退休教师房补`
    const integratedRows = retiredHousingPeople.map((row, index) => [
      index + 1,
      row.name,
      row.idCard,
      row.housing,
      row.backpay,
      row.payable,
      row.actualPay
    ])
    const integratedSums = {
      housing: roundMoney(retiredHousingPeople.reduce((s, r) => s + r.housing, 0)),
      backpay: roundMoney(retiredHousingPeople.reduce((s, r) => s + r.backpay, 0)),
      payable: roundMoney(retiredHousingPeople.reduce((s, r) => s + r.payable, 0)),
      actualPay: roundMoney(retiredHousingPeople.reduce((s, r) => s + r.actualPay, 0))
    }
    sheets.push({
      name: RETIRED_HOUSING_REPORT_SHEET_NAME,
      columns: gridColumns(7),
      showColumnHeader: false,
      columnWidths: [6, 12, 22, 12, 12, 14, 14],
      merges: ['A1:G1'],
      rows: [
        [integratedTitle, '', '', '', '', '', ''],
        ['序号', '姓名', '证件号码', '住房补贴', '补发工资', '应发工资小计', '实发合计'],
        ...integratedRows,
        ['合计', '', '', integratedSums.housing, integratedSums.backpay, integratedSums.payable, integratedSums.actualPay]
      ]
    })
  }

  return sheets
}

async function buildVoucherPageCounts(
  input: MonthlyPayrollWorkflowInput,
  sheets: MonthlyPayrollReportSheet[]
): Promise<MonthlyPayrollVoucherPageCounts> {
  // 报销凭证要打印附件页数：工资附件跟实际打印页数走，保险附件按固定规则走。
  const salaryPrintSummary = await getGeneratedSalaryPrintSummary(input)
  const salaryWorkbookPages =
    salaryPrintSummary?.items.find((item) => item.label === '工资表')?.pages ?? 0
  const survivorWorkbookPages = salaryPrintSummary?.items
    .filter((item) => item.label === '遗补')
    .reduce((sum, item) => sum + item.pages, 0) ?? 0
  const retiredHousingPages = countRetiredHousingPrintPages(sheets)
  return {
    insuranceAttachmentPages: INSURANCE_VOUCHER_ATTACHMENT_PAGES,
    salaryWorkbookPages,
    survivorWorkbookPages,
    retiredHousingPages,
    salaryAttachmentPages: salaryWorkbookPages + survivorWorkbookPages + retiredHousingPages
  }
}

async function getGeneratedSalaryPrintSummary(
  input: MonthlyPayrollWorkflowInput
) {
  if (!input.salaryWorkbookPath || input.processScope === 'social') return null
  try {
    const printSettings = await readMonthlyPayrollPrintSettings()
    const cacheKey = salaryPrintSummaryCacheKey(input.salaryWorkbookPath, printSettings.reportPrinterName)
    const cached = cacheKey ? salaryPrintSummaryCache.get(cacheKey) : undefined
    if (cached) return cached
    const summary = await getSalaryWorkbookPrintPageSummary({
      salaryWorkbookPath: input.salaryWorkbookPath,
      taxWorkbookPath: input.taxWorkbookPath,
      printerName: printSettings.reportPrinterName
    })
    if (cacheKey) salaryPrintSummaryCache.set(cacheKey, summary)
    return summary
  } catch (error) {
    console.warn('生成报表时统计工资表页数失败：', error)
    return null
  }
}

function salaryPrintSummaryCacheKey(
  salaryWorkbookPath: string,
  printerName: string | undefined
): string | null {
  try {
    const stat = statSync(salaryWorkbookPath)
    return [
      salaryWorkbookPath,
      stat.size,
      stat.mtimeMs,
      printerName ?? ''
    ].join('|')
  } catch {
    return null
  }
}

function countRetiredHousingPrintPages(sheets: MonthlyPayrollReportSheet[]): number {
  const sheet = sheets.find((item) =>
    item.name === RETIRED_HOUSING_REPORT_SHEET_NAME ||
    item.name === LEGACY_RETIRED_HOUSING_REPORT_SHEET_NAME
  )
  if (!sheet) return 0
  if (sheet.rows.length === 0) return 0
  if (sheet.rows.length <= 3) return 1
  const dataCount = Math.max(0, sheet.rows.length - 3)
  return Math.max(1, Math.ceil(dataCount / 20))
}

function applyVoucherPageCounts(
  sheets: MonthlyPayrollReportSheet[],
  counts: MonthlyPayrollVoucherPageCounts
): void {
  const sheet = sheets.find((item) => item.name === '报销凭证')
  if (!sheet) return
  let pageColumnIndex = sheet.columns.indexOf(VOUCHER_ATTACHMENT_PAGES_COLUMN)
  if (pageColumnIndex < 0) {
    sheet.columns.push(VOUCHER_ATTACHMENT_PAGES_COLUMN)
    pageColumnIndex = sheet.columns.length - 1
  }
  for (const row of sheet.rows) {
    row[pageColumnIndex] = isSalaryVoucherRow(row)
      ? counts.salaryAttachmentPages
      : counts.insuranceAttachmentPages
  }
}

function isSalaryVoucherRow(row: Array<string | number>): boolean {
  return String(row[0] ?? '').includes('工资')
}

function buildSocialOnlyReportSheets(
  socialSecurity: SocialSecuritySummary | undefined,
  tax: TaxSummary | undefined,
  unit: UnitSettings,
  integratedActiveHousingFund = 0,
  salary?: SalarySummary,
  retired: RetiredSummary = { count: 0, housing: 0 }
): MonthlyPayrollReportSheet[] {
  if (!socialSecurity) throw new Error('生成社保报账需要放入社保未申报汇总文件')

  const today = new Date()
  const payrollMonth = `${today.getFullYear()}年${today.getMonth() + 1}月`
  const summaryMonth = `${today.getMonth() + 1}月份`
  const unitCode = text(unit.unitImportCode)
  const summaryUnitName = shortInsuranceSummaryUnitName(unit.unitFullName)
  const subtitleRight = '（自动生成表）                            单位：元'
  const active: Record<string, number> = salary ? { ...salary.active } : {}
  active['住房公积金'] = salary
    ? resolveHousingFund(salary, integratedActiveHousingFund)
    : roundMoney(integratedActiveHousingFund)
  const activeTax = tax?.totalTax ?? 0
  active['个税'] = activeTax
  const socialTotal = roundMoney(Object.values(socialSecurity.byItem).reduce((sum, amount) => sum + amount, 0))
  const insuranceVoucherTotal = roundMoney(socialTotal + activeTax + num(active['住房公积金']) * 2)
  const survivorTotal = salary ? num(salary.survivor['合计']) : 0
  const retiredHousing = salary ? retired.housing : 0
  const activeInsurance = salary ? num(active['五险一金']) : 0
  const activeInsuranceWithoutTax = salary
    ? roundMoney(
        num(active['养老保险']) +
          num(active['职业年金']) +
          num(active['医保大病统筹']) +
          num(active['失业保险']) +
          num(active['住房公积金'])
      )
    : 0
  const basicActual = salary ? roundMoney(num(active['应发基础工资']) - activeInsuranceWithoutTax) : 0
  const salaryReimburseTotal = salary
    ? roundMoney(num(active['应发工资合计']) + survivorTotal + retiredHousing)
    : 0
  const actualPay = salary
    ? roundMoney(num(active['实发工资合计']) + survivorTotal + retiredHousing)
    : 0

  const insurancePersonalPension = sumSocialByCanonicalName(socialSecurity, '养老保险个人')
  const insuranceUnitPension = sumSocialByCanonicalName(socialSecurity, '养老保险单位')
  const insurancePersonalAnnuity = sumSocialByCanonicalName(socialSecurity, '职业年金个人')
  const insuranceUnitAnnuity = sumSocialByCanonicalName(socialSecurity, '职业年金单位')
  const insurancePersonalMedical = sumSocialByCanonicalName(socialSecurity, '医保个人')
  const insuranceUnitMedical = sumSocialByCanonicalName(socialSecurity, '医保单位')
  const insuranceMaternity = sumSocialByCanonicalName(socialSecurity, '生育保险')
  const insurancePersonalUnemployment = sumSocialByCanonicalName(socialSecurity, '失业保险个人')
  const insuranceUnitUnemployment = roundMoney(
    sumSocialByCanonicalName(socialSecurity, '失业保险单位') +
      sumSocialByCanonicalName(socialSecurity, '工伤保险')
  )
  const titleInsurance = `${unit.unitFullName}${payrollMonth}五险一金明细`
  const insuranceSheet: MonthlyPayrollReportSheet = {
    name: '五险一金',
    columns: gridColumns(7),
    showColumnHeader: false,
    columnWidths: [25.75, 9.16, 8, 1.75, 26.25, 9.16, 9.16],
    rowHeights: [27, null, 22.5, 21, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    merges: ['A1:G1', 'A2:G2', 'A3:C3', 'E3:G3', 'D3:D21'],
    rows: [
      [titleInsurance, '', '', '', '', '', ''],
      [subtitleRight, '', '', '', '', '', ''],
      ['财务会计', '', '', '', '预算会计', '', ''],
      ['项目', '借方金额', '贷方金额', '', '项目', '借方金额', '贷方金额'],
      ['养老保险', roundMoney(insurancePersonalPension + insuranceUnitPension), '', '', '养老保险（个人）', insurancePersonalPension, ''],
      ['职业年金', roundMoney(insurancePersonalAnnuity + insuranceUnitAnnuity), '', '', '养老保险（单位）', insuranceUnitPension, ''],
      ['医保', roundMoney(insurancePersonalMedical + insuranceUnitMedical), '', '', '职业年金（个人）', insurancePersonalAnnuity, ''],
      ['生育保险', insuranceMaternity, '', '', '职业年金（单位）', insuranceUnitAnnuity, ''],
      ['工伤失业', roundMoney(insurancePersonalUnemployment + insuranceUnitUnemployment), '', '', '医保等（个人）', insurancePersonalMedical, ''],
      ['住房公积金（个人）', num(active['住房公积金']), '', '', '医保等（单位）', insuranceUnitMedical, ''],
      ['住房公积金（单位）', num(active['住房公积金']), '', '', '生育保险', insuranceMaternity, ''],
      ['个税', activeTax, '', '', '工伤失业（个人）', insurancePersonalUnemployment, ''],
      ['补缴养老保险', 0, '', '', '工伤失业（单位）', insuranceUnitUnemployment, ''],
      ['补缴职业年金', 0, '', '', '住房公积金（个人）', num(active['住房公积金']), ''],
      ['补缴医保、工伤失业等', 0, '', '', '住房公积金（单位）', num(active['住房公积金']), ''],
      ['付五险一金、个税等（零余额）', '', roundMoney(insuranceVoucherTotal), '', '个税', activeTax, ''],
      ['付补交各类保险等（9674银行存款）', '', 0, '', '补缴养老保险', 0, ''],
      ['', '', '', '', '补缴职业年金', 0, ''],
      ['', '', '', '', '补缴医保、工伤失业等', 0, ''],
      ['', '', '', '', '付五险一金、个税等（零余额）', '', insuranceVoucherTotal],
      ['', '', '', '', '付补交各类保险等（9674银行存款）', '', 0]
    ]
  }

  const voucherPrintSheet: MonthlyPayrollReportSheet = {
    name: '报销凭证',
    columns: ['项目', '报账单位', '报销金额', '未报销金额', '实际付款金额', '支付令', '同城转账', '支付方式', '用途', '大写金额', '年', '月', '日', '未报销大写'],
    rows: [[
      '五险一金',
      unit.unitFullName,
      insuranceVoucherTotal,
      '',
      insuranceVoucherTotal,
      unitCode,
      '',
      '转账支票',
      buildInsuranceVoucherUsage(active, socialSecurity, activeTax, insuranceVoucherTotal),
      toChineseRmb(insuranceVoucherTotal),
      today.getFullYear(),
      today.getMonth() + 1,
      today.getDate(),
      ''
    ]]
  }

  const voucherSheet = buildVoucherSheet(
    {
      unit,
      today,
      active,
      socialSecurity,
      activeTax,
      actualPay,
      basicActual,
      teachingAge: salary ? num(active['教龄津贴']) : 0,
      ruralTotal: salary ? roundMoney(num(active['乡镇补贴']) + num(active['边远乡镇补贴'])) : 0,
      housing: salary ? num(active['住房补贴']) : 0,
      performance: salary ? num(active['基础性绩效']) : 0,
      traffic: salary ? num(active['交通补贴']) : 0,
      survivorTotal,
      retiredHousing,
      salaryReimburseTotal,
      insuranceVoucherTotal,
      withholdingTotal: activeInsurance,
      salaryVoucherInsurance: activeInsuranceWithoutTax
    },
    { includeSalaryVoucher: Boolean(salary), includeInsuranceVoucher: true }
  )

  const insuranceImportSheet: MonthlyPayrollReportSheet = {
    name: '保险导入',
    columns: [
      '*单位代码',
      '*单位名称',
      '*部门经济科目代码',
      '*部门经济科目名称',
      '摘要',
      '*金额',
      '*收款账户名称',
      '*收款账户开户行',
      '*收款账户账号',
      '经办人',
      '审核人',
      '支付业务类型',
      '确认不是政府采购项目支付'
    ],
    columnWidths: [12, 18, 14, 18, 28, 12, 22, 22, 22, 10, 10, 14, 22],
    rows: buildInsuranceImportItems(socialSecurity, active, activeTax).map(([item, amount]) => {
      const isHousing = item.includes('公积金')
      const economicSubject = departmentEconomicSubjectForSocialItem(item)
      return [
        unitCode,
        unit.unitFullName,
        economicSubject.code,
        economicSubject.name,
        `${summaryUnitName}${summaryMonth}${item}`,
        amount,
        isHousing ? unit.housingPayeeName : unit.socialPayeeName,
        isHousing ? unit.housingPayeeBank : unit.socialPayeeBank,
        isHousing ? unit.housingPayeeAccount : unit.socialPayeeAccount,
        '',
        '',
        '',
        '是'
      ]
    })
  }

  return [insuranceSheet, voucherPrintSheet, voucherSheet, insuranceImportSheet]
}

function buildBackpayRows(
  salary: SalarySummary,
  tax: TaxSummary | undefined,
  activeIdCardResolver?: IntegratedIdCardResolver
): Array<Array<string | number>> {
  const year = new Date().getFullYear()
  const month = new Date().getMonth() + 1
  const rowsById = new Map<string, Array<string | number>>()
  const rowsWithoutId: Array<Array<string | number>> = []

  const ensureRow = (idCard: string, name: string): Array<string | number> => {
    const outputIdCard = activeIdCardResolver?.(idCard, name) ?? idCard
    const key = normalizeIdCard(outputIdCard)
    const existing = rowsById.get(key)
    if (existing) return existing
    const row = createBackpayAdjustmentRow(key, name, year, month)
    rowsById.set(key, row)
    return row
  }

  for (const person of salary.activePeople) {
    const basicBackpay = num(person.values['基本补发'])
    const performanceBackpay = num(person.values['绩效补发'])
    if (basicBackpay === 0 && performanceBackpay === 0) continue
    const row = ensureRow(person.idCard, person.name)
    addSignedBackpayAdjustment(row, basicBackpay, 'basicIncrease', 'basicDeduction')
    addSignedBackpayAdjustment(row, performanceBackpay, 'performanceIncrease', 'performanceDeduction')
  }

  for (const item of tax?.rows ?? []) {
    const taxBackpay = -item.taxAmount
    if (!item.idCard) {
      const row = createBackpayAdjustmentRow('', item.name, year, month)
      addBackpayAdjustment(row, 'taxDeduction', taxBackpay)
      rowsWithoutId.push(row)
      continue
    }
    const row = ensureRow(item.idCard, item.name)
    addBackpayAdjustment(row, 'taxDeduction', taxBackpay)
  }

  return [...rowsById.values(), ...rowsWithoutId].filter(hasBackpayAdjustments)
}

function hasActiveBackpayAdjustments(salary: SalarySummary | undefined): boolean {
  return Boolean(salary?.activePeople.some((person) =>
    num(person.values['基本补发']) !== 0 ||
      num(person.values['绩效补发']) !== 0
  ))
}

function resolveHousingFund(salary: SalarySummary, integratedActiveHousingFund: number): number {
  const peopleTotal = roundMoney(
    salary.activePeople.reduce((sum, person) => sum + num(person.values['公积金']), 0)
  )
  return peopleTotal || num(salary.active['住房公积金']) || roundMoney(integratedActiveHousingFund)
}

function shortInsuranceSummaryUnitName(unitFullName: string): string {
  return text(unitFullName).replace(/^沭阳县/, '')
}

function buildInsuranceImportItems(
  socialSecurity: SocialSecuritySummary,
  active: Record<string, number>,
  activeTax: number
): Array<[string, number]> {
  const housingFund = num(active['住房公积金'])
  const socialPersonal = socialPersonalInsuranceTotals(socialSecurity)
  return [
    ['养老保险个人', socialPersonal.pension],
    ['养老保险单位', sumSocialByCanonicalName(socialSecurity, '养老保险单位')],
    ['职业年金个人', socialPersonal.annuity],
    ['职业年金单位', sumSocialByCanonicalName(socialSecurity, '职业年金单位')],
    ['医保个人', socialPersonal.medical],
    ['医保单位', sumSocialByCanonicalName(socialSecurity, '医保单位')],
    ['生育保险', sumSocialByCanonicalName(socialSecurity, '生育保险')],
    ['失业保险个人', socialPersonal.unemployment],
    ['失业保险单位', sumSocialByCanonicalName(socialSecurity, '失业保险单位')],
    ['工伤保险', sumSocialByCanonicalName(socialSecurity, '工伤保险')],
    ['住房公积金个人', housingFund],
    ['住房公积金单位', housingFund],
    ['个人所得税', activeTax]
  ].filter(([, amount]) => num(amount) !== 0) as Array<[string, number]>
}

function buildPersonalInsuranceCheck(
  socialSecurity: SocialSecuritySummary | undefined,
  salary: SalarySummary | undefined,
  integrated: PersonalInsuranceTotals
): { messages: string[]; warnings: string[] } {
  if (!socialSecurity) return { messages: [], warnings: [] }
  const social = socialPersonalInsuranceTotals(socialSecurity)
  const salaryTotals = salary ? salaryPersonalInsuranceTotals(salary) : undefined
  const salaryDiffs = salaryTotals
    ? diffPersonalInsuranceTotals(social, salaryTotals, '工资表', { includeHousing: false })
    : []
  const integratedDiffs = diffPersonalInsuranceTotals(social, integrated, '在职工资', { includeHousing: false })
  const socialFourTotal = roundMoney(social.pension + social.annuity + social.medical + social.unemployment)
  const salaryFourTotal = salaryTotals
    ? roundMoney(salaryTotals.pension + salaryTotals.annuity + salaryTotals.medical + salaryTotals.unemployment)
    : 0
  const integratedFourTotal = roundMoney(
    integrated.pension + integrated.annuity + integrated.medical + integrated.unemployment
  )
  const messages = [
    salaryTotals
      ? `个人四险核对：社保文件四项合计 ${formatMoney(socialFourTotal)}，工资表 ${formatMoney(salaryFourTotal)}，在职工资 ${formatMoney(integratedFourTotal)}`
      : `个人四险核对：社保文件四项合计 ${formatMoney(socialFourTotal)}，在职工资 ${formatMoney(integratedFourTotal)}`
  ]
  // 公积金双方对比（社保 XLS 没有公积金数据）
  const housingDiff = salaryTotals ? roundMoney(salaryTotals.housing - integrated.housing) : 0
  if (salaryTotals) {
    messages.push(
      `公积金个人核对：工资表 ${formatMoney(salaryTotals.housing)}，在职工资 ${formatMoney(integrated.housing)}` +
        (Math.abs(housingDiff) < 0.01 ? '（一致）' : `，差额 ${formatMoney(housingDiff)}`)
    )
  }
  const warnings = [
    ...(salaryDiffs.length ? [`社保个人四险与工资表不一致：${salaryDiffs.join('；')}`] : []),
    ...(integratedDiffs.length ? [`社保个人四险与在职工资不一致：${integratedDiffs.join('；')}`] : []),
    ...(salaryTotals && Math.abs(housingDiff) >= 0.01
      ? [`公积金个人与在职工资不一致：差额 ${formatMoney(housingDiff)}`]
      : [])
  ]
  if (warnings.length === 0) {
    messages.push(
      salaryTotals
        ? '个人五险一金核对：社保文件、工资表、在职工资金额一致'
        : '个人四险核对：社保文件与在职工资金额一致'
    )
  }
  return { messages, warnings }
}

function socialPersonalInsuranceTotals(socialSecurity: SocialSecuritySummary): PersonalInsuranceTotals {
  return personalInsuranceTotals({
    pension: sumSocialByCanonicalName(socialSecurity, '养老保险个人'),
    annuity: sumSocialByCanonicalName(socialSecurity, '职业年金个人'),
    medical: sumSocialByCanonicalName(socialSecurity, '医保个人'),
    unemployment: sumSocialByCanonicalName(socialSecurity, '失业保险个人'),
    housing: 0
  })
}

function salaryPersonalInsuranceTotals(salary: SalarySummary): PersonalInsuranceTotals {
  return personalInsuranceTotals({
    pension: num(salary.active['养老保险']),
    annuity: num(salary.active['职业年金']),
    medical: num(salary.active['医保大病统筹']),
    unemployment: num(salary.active['失业保险']),
    housing: num(salary.active['住房公积金'])
  })
}

function personalInsuranceTotals(
  values: Omit<PersonalInsuranceTotals, 'total'>
): PersonalInsuranceTotals {
  return {
    ...values,
    total: roundMoney(
      values.pension + values.annuity + values.medical + values.unemployment + values.housing
    )
  }
}

function diffPersonalInsuranceTotals(
  social: PersonalInsuranceTotals,
  target: PersonalInsuranceTotals,
  targetName: string,
  options: { includeHousing?: boolean } = {}
): string[] {
  const includeHousing = options.includeHousing ?? true
  const itemDiffs: Array<[keyof PersonalInsuranceTotals, string]> = [
    ['pension', '养老保险个人'],
    ['annuity', '职业年金个人'],
    ['medical', '医保个人'],
    ['unemployment', '失业保险个人'],
    ...(includeHousing ? [['housing', '住房公积金个人'] as [keyof PersonalInsuranceTotals, string]] : [])
  ]
  const messages: string[] = []
  for (const [key, label] of itemDiffs) {
    const difference = roundMoney(social[key] - target[key])
    if (Math.abs(difference) >= 0.01) {
      messages.push(`${label} 社保=${formatMoney(social[key])} / ${targetName}=${formatMoney(target[key])} / 差额=${formatMoney(difference)}`)
    }
  }
  // 合计单独算：不含公积金时，仅对 4 项求和；包含公积金时用 5 项 total
  const socialSum = includeHousing
    ? social.total
    : roundMoney(social.pension + social.annuity + social.medical + social.unemployment)
  const targetSum = includeHousing
    ? target.total
    : roundMoney(target.pension + target.annuity + target.medical + target.unemployment)
  const totalDiff = roundMoney(socialSum - targetSum)
  if (Math.abs(totalDiff) >= 0.01) {
    const label = includeHousing ? '五项合计' : '四项合计'
    messages.push(`${label} 社保=${formatMoney(socialSum)} / ${targetName}=${formatMoney(targetSum)} / 差额=${formatMoney(totalDiff)}`)
  }
  return messages
}

function sumSocialByAnyKeywordGroups(
  socialSecurity: SocialSecuritySummary,
  keywordGroups: string[][]
): number {
  const groups = keywordGroups.map((group) => group.map((item) => item.replace(/\s+/g, '')))
  return roundMoney(
    Object.entries(socialSecurity.byItem).reduce((sum, [item, amount]) => {
      const normalized = item.replace(/\s+/g, '')
      if (groups.some((group) => group.every((keyword) => normalized.includes(keyword)))) {
        return sum + amount
      }
      return sum
    }, 0)
  )
}
