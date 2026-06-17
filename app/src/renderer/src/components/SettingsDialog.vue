<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ConsistencyAuditPage from './ConsistencyAuditPage.vue'
import MailAttachmentPage from './MailAttachmentPage.vue'
import {
  internalToolsEnabled,
  setInternalToolsEnabled,
  unlockInternalTools
} from '../internalToolsMode'
import type { BudgetProjectCodeResult } from '../integration/budgetProjectCodeScript'
import type {
  BackupSummary,
  ImportWatcherStatus,
  RecycleBinBatch,
  UnitSettings,
  UnitSettingsLockState
} from '@shared/types'
import {
  createDefaultVoucherCheckRuleLibrary,
  normalizeVoucherCheckRuleLibrary,
  type VoucherBalanceAmountField,
  type VoucherBalanceEquationTarget,
  type VoucherCheckRequiredSubject,
  type VoucherCheckRule,
  type VoucherCheckRuleLibrary
} from '@shared/voucherCheckRules'

const showInternalTools = internalToolsEnabled
const AutomationDiagnosticsPage = defineAsyncComponent(() => import('./AutomationDiagnosticsPage.vue'))

const props = defineProps<{
  modelValue: boolean
  importWatcher: ImportWatcherStatus | null
  databasePath: string
  initialTab?: string
  resolveBudgetProjectCodes?: () => Promise<BudgetProjectCodeResult>
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'changed'): void
  (event: 'openWorksheet', worksheetName: string): void
}>()

const fullBackups = ref<BackupSummary[]>([])
const fullBackupsLoading = ref(false)
const creatingFullBackup = ref(false)
const restoringFullBackup = ref(false)
const wiping = ref(false)
const recycleBatches = ref<RecycleBinBatch[]>([])
const recycleLoading = ref(false)
const recycleRestoringId = ref<number | null>(null)
const recycleRevertingId = ref<number | null>(null)
const retireBatchKind = 'worksheet.retire-active-employee'
const activeTab = ref('unit')
const appVersion = ref('dev')
const voucherRules = ref<VoucherCheckRule[]>([])
const voucherRulesLoading = ref(false)
const voucherRulesSaving = ref(false)
const voucherRulesFileBusy = ref(false)

const unitForm = reactive<UnitSettings>({
  unitFullName: '',
  unitImportCode: '',
  schoolLevel: '小学教育',
  functionCode: '2050202',
  retiredFunctionCode: '2210202',
  retiredFunctionName: '退休提租补贴',
  budgetActiveCode: '',
  budgetRetiredCode: '',
  socialPayeeName: '',
  socialPayeeBank: '',
  socialPayeeAccount: '',
  housingPayeeName: '',
  housingPayeeBank: '',
  housingPayeeAccount: '',
  salaryExportSaltypes: []
})
const unitSaving = ref(false)
const schoolLookupLoading = ref(false)
const budgetProjectResolving = ref(false)
const unitSettingsLock = ref<UnitSettingsLockState>({
  locked: false,
  rowCount: 0,
  tables: []
})

function normalizeSettingsTab(tab?: string): string {
  if (tab === 'automation' && !showInternalTools.value) return 'unit'
  return tab || 'unit'
}

const unitLockMessage = computed(() => {
  if (!unitSettingsLock.value.locked) return ''
  const tableNames = unitSettingsLock.value.tables.slice(0, 3).map((item) => item.name).join('、')
  const suffix = unitSettingsLock.value.tables.length > 3 ? '等' : ''
  return `系统已有业务数据（${tableNames}${suffix}，共 ${unitSettingsLock.value.rowCount} 行），单位基础信息已锁定；在职/退休预算项目编码仍可修改。`
})

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      activeTab.value = normalizeSettingsTab(props.initialTab)
      void refreshBackupLists()
      void refreshRecycleBin()
      void loadUnitSettings()
      void loadVoucherRules()
      void loadAppVersion()
    }
  }
)

watch(
  () => props.initialTab,
  (tab) => {
    if (props.modelValue && tab) activeTab.value = normalizeSettingsTab(tab)
  }
)

async function loadAppVersion() {
  try {
    appVersion.value = await window.salaryApi.getAppVersion()
  } catch {
    appVersion.value = 'dev'
  }
}

async function loadUnitSettings() {
  const [settings, lockState] = await Promise.all([
    window.salaryApi.getUnitSettings(),
    window.salaryApi.getUnitSettingsLockState()
  ])
  unitSettingsLock.value = lockState
  Object.assign(unitForm, settings)
}

async function saveUnitSettings(successMessage?: string): Promise<boolean> {
  unitSaving.value = true
  try {
    const next = await window.salaryApi.setUnitSettings(buildUnitSettingsPayload())
    Object.assign(unitForm, next)
    const trial = unitSettingsLock.value.locked ? false : await claimTrialAfterUnitSave(next)
    ElMessage.success(
      successMessage ||
      (trial
        ? '单位设置已保存，试用授权已自动开通'
        : unitSettingsLock.value.locked
          ? '预算项目编码已保存'
          : '单位设置已保存')
    )
    emit('changed')
    return true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
    return false
  } finally {
    unitSaving.value = false
  }
}

async function claimTrialAfterUnitSave(settings: UnitSettings): Promise<boolean> {
  const unitName = settings.unitFullName.trim()
  if (!unitName) return false

  try {
    const response = await window.salaryApi.licenseClaimTrial(unitName, settings.unitImportCode)
    if (!response?.success) {
      ElMessage.warning(response?.error || '单位设置已保存，但自动领取试用授权失败')
      return false
    }

    const status = response.data
    if (status?.valid) return true
    ElMessage.warning(status?.message || '单位设置已保存，但自动领取试用授权失败')
  } catch (error) {
    ElMessage.warning(
      error instanceof Error ? `单位设置已保存，但自动授权失败：${error.message}` : '单位设置已保存，但自动授权失败'
    )
  }
  return false
}

function buildUnitSettingsPayload(): UnitSettings {
  return {
    unitFullName: unitForm.unitFullName,
    unitImportCode: unitForm.unitImportCode,
    schoolLevel: unitForm.schoolLevel,
    functionCode: unitForm.functionCode,
    retiredFunctionCode: unitForm.retiredFunctionCode,
    retiredFunctionName: unitForm.retiredFunctionName,
    budgetActiveCode: unitForm.budgetActiveCode,
    budgetRetiredCode: unitForm.budgetRetiredCode,
    socialPayeeName: unitForm.socialPayeeName,
    socialPayeeBank: unitForm.socialPayeeBank,
    socialPayeeAccount: unitForm.socialPayeeAccount,
    housingPayeeName: unitForm.housingPayeeName,
    housingPayeeBank: unitForm.housingPayeeBank,
    housingPayeeAccount: unitForm.housingPayeeAccount,
    salaryExportSaltypes: (unitForm.salaryExportSaltypes ?? []).map((s) => ({
      saltype_id: s.saltype_id,
      saltype_name: s.saltype_name,
      onlyFirstBatch: !!s.onlyFirstBatch
    }))
  }
}

async function applySchoolLookupByCode() {
  if (unitSettingsLock.value.locked) {
    ElMessage.warning('系统已有业务数据，不能重新填写单位信息')
    return
  }
  const code = unitForm.unitImportCode.trim()
  if (!code) return
  schoolLookupLoading.value = true
  try {
    const matched = await window.salaryApi.resolveSchoolUnitSettings(code)
    if (!matched) {
      ElMessage.warning('学校对照表中未找到该预算单位编码')
      return
    }
    Object.assign(unitForm, matched)
    ElMessage.success(`已填入 ${matched.unitFullName ?? ''} 的单位信息`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '匹配学校对照表失败')
  } finally {
    schoolLookupLoading.value = false
  }
}

async function autofillBudgetProjectCodes() {
  if (!props.resolveBudgetProjectCodes) {
    ElMessage.warning('一体化系统页面尚未加载')
    return
  }
  budgetProjectResolving.value = true
  try {
    const result = await props.resolveBudgetProjectCodes()
    if (!result.ok) {
      const names = result.availableNames?.length
        ? `；可用项目：${result.availableNames.slice(0, 12).join('、')}`
        : ''
      ElMessage.error(`${result.message}${names}`)
      return
    }
    unitForm.budgetActiveCode = result.activeCode
    unitForm.budgetRetiredCode = result.retiredCode
    await saveUnitSettings(
      `已填入并保存：${result.activeName} ${result.activeCode}；${result.retiredName} ${result.retiredCode}`
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '自动填入预算项目编码失败')
  } finally {
    budgetProjectResolving.value = false
  }
}

async function refreshBackupLists() {
  fullBackupsLoading.value = true
  try {
    fullBackups.value = await window.salaryApi.listFullBackups()
  } finally {
    fullBackupsLoading.value = false
  }
}

async function refreshRecycleBin() {
  recycleLoading.value = true
  try {
    recycleBatches.value = await window.salaryApi.listRecycleBinBatches(200)
  } finally {
    recycleLoading.value = false
  }
}

async function createFullBackup() {
  creatingFullBackup.value = true
  try {
    const summary = await window.salaryApi.createFullBackup()
    if (!summary) return
    ElMessage.success(`全量备份已保存：${summary.fileName}，共 ${summary.includedFiles} 个文件`)
    await refreshBackupLists()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '全量备份失败')
  } finally {
    creatingFullBackup.value = false
  }
}

async function restoreFullBackup(backup?: BackupSummary) {
  restoringFullBackup.value = true
  try {
    const summary = await window.salaryApi.restoreFullBackup(backup?.fileName)
    if (!summary) return
    ElMessage.success(`已恢复全量备份：${summary.includedFiles} 个文件，正在重启`)
  } catch (error) {
    if (error instanceof Error && error.message === '用户取消恢复') return
    ElMessage.error(error instanceof Error ? error.message : '全量恢复失败')
  } finally {
    restoringFullBackup.value = false
  }
}

async function restoreRecycleBatch(row: RecycleBinBatch) {
  try {
    await ElMessageBox.confirm(
      `将尝试恢复批次 ${row.id} 中的 ${row.recordCount} 行删除快照；如原记录 ID 或唯一字段已经被占用，系统会跳过冲突行，不覆盖现有数据。`,
      '从回收站恢复',
      {
        type: 'warning',
        confirmButtonText: '恢复',
        cancelButtonText: '取消'
      }
    )
  } catch {
    return
  }

  recycleRestoringId.value = row.id
  try {
    const result = await window.salaryApi.restoreRecycleBinBatch(row.id)
    ElMessage.success(
      `已恢复 ${result.restoredRows} 行，冲突 ${result.conflictRows} 行，跳过 ${result.skippedRows} 行`
    )
    await refreshRecycleBin()
    emit('changed')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复失败')
  } finally {
    recycleRestoringId.value = null
  }
}

async function revertRetirement(row: RecycleBinBatch) {
  let preview
  try {
    preview = await window.salaryApi.previewActiveRetirementRevert(row.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '撤销退休预检失败')
    return
  }
  if (!preview.canRevert) {
    ElMessage.warning(preview.message || '该退休操作无法撤销')
    return
  }

  const who = `${preview.name || '该人员'}（${preview.idCard || '无证件号'}）`
  const lines = [
    `将把 ${who} 从退休工资撤回到在职工资：`,
    `· 恢复在职工资 ${preview.activeRowsToRestore} 行`,
    `· 删除退休工资 ${preview.retiredRowsToDelete} 行` +
      (preview.retiredRowsMissing > 0 ? `（另有 ${preview.retiredRowsMissing} 行已不存在）` : ''),
    '· 各表人员状态将自动刷新回「在职」'
  ]
  if (preview.modifiedRetiredRows > 0) {
    lines.push(
      `⚠ 其中 ${preview.modifiedRetiredRows} 行退休记录转入后被手工修改过，撤销会一并删除这些改动，确定继续吗？`
    )
  }

  try {
    await ElMessageBox.confirm(lines.map(escapeHtml).join('<br>'), '撤销退休', {
      type: preview.modifiedRetiredRows > 0 ? 'error' : 'warning',
      dangerouslyUseHTMLString: true,
      confirmButtonText: '撤销退休',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  recycleRevertingId.value = row.id
  try {
    const result = await window.salaryApi.revertActiveRetirement(row.id)
    ElMessage.success(result.messages[0] || '已撤销退休')
    await refreshRecycleBin()
    emit('changed')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '撤销退休失败')
  } finally {
    recycleRevertingId.value = null
  }
}

async function wipeAll() {
  try {
    await ElMessageBox.confirm(
      '将清空业务工作表数据、导入批次、工资报账记录和摆渡包记录，四张对照基础表会保留；本次清空会写入永久操作留痕。建议先建一份备份。确定继续吗？',
      '一键清空所有数据',
      {
        type: 'error',
        confirmButtonText: '清空全部',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger'
      }
    )
  } catch {
    return
  }

  let confirmInput: string
  try {
    const result = await ElMessageBox.prompt(
      '请输入「确认清空」四个字以最终确认：',
      '最终确认',
      {
        confirmButtonText: '执行',
        cancelButtonText: '取消',
        inputPattern: /^确认清空$/,
        inputErrorMessage: '输入不正确，操作已取消'
      }
    )
    confirmInput = result.value
  } catch {
    return
  }

  if (confirmInput !== '确认清空') return

  wiping.value = true
  try {
    const summary = await window.salaryApi.wipeAllData()
    ElMessage.success(`已清空 ${summary.tables} 张业务表/记录表，共 ${summary.rows} 行，基础对照表已保留`)
    unitSettingsLock.value = await window.salaryApi.getUnitSettingsLockState()
    emit('changed')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '清空失败')
  } finally {
    wiping.value = false
  }
}

async function toggleInternalTools(): Promise<void> {
  if (showInternalTools.value) {
    try {
      await ElMessageBox.confirm(
        '关闭后将隐藏采集助手、录制工具、外部浏览器和推送日志入口。',
        '关闭诊断模式',
        {
          type: 'warning',
          confirmButtonText: '关闭',
          cancelButtonText: '取消'
        }
      )
    } catch {
      return
    }
    setInternalToolsEnabled(false)
    if (activeTab.value === 'automation') activeTab.value = 'unit'
    ElMessage.success('诊断模式已关闭')
    return
  }

  try {
    const { value } = await ElMessageBox.prompt('请输入开发调试密码', '开启诊断模式', {
      inputType: 'password',
      inputPlaceholder: '密码',
      confirmButtonText: '开启',
      cancelButtonText: '取消'
    })
    if (unlockInternalTools(String(value || ''))) {
      ElMessage.success('诊断模式已开启')
    } else {
      ElMessage.error('密码不正确')
    }
  } catch {}
}

async function openImportFolder() {
  await window.salaryApi.openImportWatcherFolder()
}

function openLookupWorksheet(name: string) {
  emit('openWorksheet', name)
}

function cloneRule<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function loadVoucherRules() {
  voucherRulesLoading.value = true
  try {
    const library = await window.salaryApi.getVoucherCheckRuleLibrary()
    voucherRules.value = cloneRule(library.rules)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载账务检查规则失败')
    voucherRules.value = cloneRule(createDefaultVoucherCheckRuleLibrary().rules)
  } finally {
    voucherRulesLoading.value = false
  }
}

function buildVoucherRuleLibrary(): VoucherCheckRuleLibrary {
  return normalizeVoucherCheckRuleLibrary({
    schemaVersion: 2,
    rules: voucherRules.value,
    updatedAt: new Date().toISOString()
  })
}

async function saveVoucherRules() {
  voucherRulesSaving.value = true
  try {
    const saved = await window.salaryApi.setVoucherCheckRuleLibrary(buildVoucherRuleLibrary())
    voucherRules.value = cloneRule(saved.rules)
    ElMessage.success('账务检查规则已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存账务检查规则失败')
  } finally {
    voucherRulesSaving.value = false
  }
}

async function exportVoucherRules() {
  voucherRulesFileBusy.value = true
  try {
    await window.salaryApi.setVoucherCheckRuleLibrary(buildVoucherRuleLibrary())
    const result = await window.salaryApi.exportVoucherCheckRuleLibrary()
    if (!result.ok) {
      if (!result.canceled) ElMessage.error(result.reason)
      return
    }
    ElMessage.success(`规则库已导出：${result.filePath}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导出账务检查规则失败')
  } finally {
    voucherRulesFileBusy.value = false
  }
}

async function importVoucherRules() {
  voucherRulesFileBusy.value = true
  try {
    const result = await window.salaryApi.importVoucherCheckRuleLibrary()
    if (!result.ok) {
      if (!result.canceled) ElMessage.error(result.reason)
      return
    }
    voucherRules.value = cloneRule(result.library.rules)
    ElMessage.success(`规则库已导入：${result.filePath}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导入账务检查规则失败')
  } finally {
    voucherRulesFileBusy.value = false
  }
}

async function resetVoucherRules() {
  try {
    await ElMessageBox.confirm('将恢复系统内置默认规则，并覆盖当前本地规则库。确定继续吗？', '恢复默认规则', {
      type: 'warning',
      confirmButtonText: '恢复默认',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  voucherRulesSaving.value = true
  try {
    const reset = await window.salaryApi.resetVoucherCheckRuleLibrary()
    voucherRules.value = cloneRule(reset.rules)
    ElMessage.success('已恢复默认账务检查规则')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复默认规则失败')
  } finally {
    voucherRulesSaving.value = false
  }
}

function newRuleId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

function addVoucherRule(type: VoucherCheckRule['type']) {
  if (type === 'keyword-eco') {
    voucherRules.value.push({
      id: newRuleId('R-ECO'),
      type,
      name: '关键词经济分类',
      enabled: true,
      level: 'warn',
      keywords: [],
      expectedEcoCode: '',
      expectedEcoName: '',
      suggestion: ''
    })
  } else if (type === 'keyword-subject-set') {
    voucherRules.value.push({
      id: newRuleId('R-SUBJECT'),
      type,
      name: '关键词科目组合',
      enabled: true,
      level: 'warn',
      keywords: [],
      requiredSubjects: [],
      expectedBudgetExpenseSubjectCode: '',
      expectedBudgetRevenueSubjectCode: '',
      suggestion: ''
    })
  } else if (type === 'fixed-asset-capital') {
    voucherRules.value.push({
      id: newRuleId('R-FIXED'),
      type,
      name: '固定资产资本性支出',
      enabled: true,
      level: 'warn',
      fixedAssetPrefixes: ['160101', '160102', '160103', '160104', '160105', '160106'],
      budgetExpensePrefixes: ['720'],
      allowedEcoCodes: ['31001', '31002', '31003', '31005', '31006', '31007', '31008', '31009', '31010', '31011', '31012', '31013', '31019', '31021', '31022', '31099'],
      suggestion: '应修改为310类资本性支出。'
    })
  } else {
    voucherRules.value.push({
      id: newRuleId('R-BALANCE'),
      type,
      name: '余额表科目勾稽',
      enabled: true,
      level: 'error',
      sourceCode: '',
      sourceName: '',
      sourceFields: ['debit', 'credit'],
      targetSubjects: [],
      suggestion: ''
    })
  }
}

function duplicateVoucherRule(index: number) {
  const source = voucherRules.value[index]
  if (!source) return
  const copy = cloneRule(source)
  copy.id = newRuleId('R-COPY')
  copy.name = `${copy.name} 副本`
  voucherRules.value.splice(index + 1, 0, copy)
}

function removeVoucherRule(index: number) {
  voucherRules.value.splice(index, 1)
}

function moveVoucherRule(index: number, offset: number) {
  const target = index + offset
  if (target < 0 || target >= voucherRules.value.length) return
  const [item] = voucherRules.value.splice(index, 1)
  voucherRules.value.splice(target, 0, item)
}

function ruleTypeText(type: VoucherCheckRule['type']): string {
  if (type === 'keyword-eco') return '关键词经济分类'
  if (type === 'keyword-subject-set') return '关键词科目组合'
  if (type === 'balance-equation') return '余额表勾稽'
  return '固定资产310类'
}

function splitRuleTokens(value: string): string[] {
  return Array.from(new Set(String(value || '').split(/[,\n，、;；]/).map((item) => item.trim()).filter(Boolean)))
}

function joinRuleTokens(value?: string[]): string {
  return (value || []).join('，')
}

function getRuleKeywords(rule: VoucherCheckRule): string {
  return 'keywords' in rule ? joinRuleTokens(rule.keywords) : ''
}

function setRuleKeywords(rule: VoucherCheckRule, value: string) {
  if ('keywords' in rule) rule.keywords = splitRuleTokens(value)
}

function getFixedPrefixes(rule: VoucherCheckRule): string {
  return rule.type === 'fixed-asset-capital' ? joinRuleTokens(rule.fixedAssetPrefixes) : ''
}

function setFixedPrefixes(rule: VoucherCheckRule, value: string) {
  if (rule.type === 'fixed-asset-capital') rule.fixedAssetPrefixes = splitRuleTokens(value)
}

function getBudgetPrefixes(rule: VoucherCheckRule): string {
  return rule.type === 'fixed-asset-capital' ? joinRuleTokens(rule.budgetExpensePrefixes) : ''
}

function setBudgetPrefixes(rule: VoucherCheckRule, value: string) {
  if (rule.type === 'fixed-asset-capital') rule.budgetExpensePrefixes = splitRuleTokens(value)
}

function getAllowedEcoCodes(rule: VoucherCheckRule): string {
  return rule.type === 'fixed-asset-capital' ? joinRuleTokens(rule.allowedEcoCodes) : ''
}

function setAllowedEcoCodes(rule: VoucherCheckRule, value: string) {
  if (rule.type === 'fixed-asset-capital') rule.allowedEcoCodes = splitRuleTokens(value)
}

function directionText(direction?: VoucherCheckRequiredSubject['direction']): string {
  if (direction === 'debit') return '借'
  if (direction === 'credit') return '贷'
  return '任意'
}

function balanceFieldText(field?: VoucherBalanceAmountField): string {
  if (field === 'credit') return '本期贷方'
  if (field === 'sumDebit') return '累计借方'
  if (field === 'sumCredit') return '累计贷方'
  return '本期借方'
}

function parseBalanceField(value: string): VoucherBalanceAmountField {
  const text = String(value || '').replace(/\s+/g, '')
  if (/累计贷方|贷方累计|sumCredit/i.test(text)) return 'sumCredit'
  if (/累计借方|借方累计|sumDebit/i.test(text)) return 'sumDebit'
  if (/贷方|credit/i.test(text)) return 'credit'
  return 'debit'
}

function getBalanceSourceFields(rule: VoucherCheckRule): string {
  return rule.type === 'balance-equation'
    ? (rule.sourceFields || []).map(balanceFieldText).join('，')
    : ''
}

function setBalanceSourceFields(rule: VoucherCheckRule, value: string) {
  if (rule.type !== 'balance-equation') return
  const fields = splitRuleTokens(value).map(parseBalanceField)
  rule.sourceFields = Array.from(new Set(fields.length ? fields : ['debit']))
}

function balanceTargetLines(rule: VoucherCheckRule): string {
  if (rule.type !== 'balance-equation') return ''
  return rule.targetSubjects
    .map((item) => [item.code, item.name || '', balanceFieldText(item.field)].filter(Boolean).join(' '))
    .join('\n')
}

function setBalanceTargetLines(rule: VoucherCheckRule, value: string) {
  if (rule.type !== 'balance-equation') return
  const targets: Array<VoucherBalanceEquationTarget | null> = String(value || '').split(/\n+/).map((line) => {
    const text = line.trim()
    if (!text) return null
    const codeMatch = text.match(/[0-9A-Za-z]+/)
    const code = codeMatch ? codeMatch[0].toUpperCase() : ''
    if (!code) return null
    const field = parseBalanceField(text)
    const name = text
      .replace(codeMatch ? codeMatch[0] : '', '')
      .replace(/本期借方发生|本期贷方发生|借方累计发生|贷方累计发生|累计借方|累计贷方|本期借方|本期贷方|借方|贷方|debit|credit|sumDebit|sumCredit/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return { code, name, field }
  })
  rule.targetSubjects = targets.filter((item): item is VoucherBalanceEquationTarget => !!item)
}

function subjectLines(rule: VoucherCheckRule): string {
  if (rule.type !== 'keyword-subject-set') return ''
  return rule.requiredSubjects
    .map((item) => [item.code, item.name || '', directionText(item.direction)].filter(Boolean).join(' '))
    .join('\n')
}

function setSubjectLines(rule: VoucherCheckRule, value: string) {
  if (rule.type !== 'keyword-subject-set') return
  const subjects: Array<VoucherCheckRequiredSubject | null> = String(value || '').split(/\n+/).map((line) => {
    const text = line.trim()
    if (!text) return null
    const direction: VoucherCheckRequiredSubject['direction'] =
      /(^|\s)(贷|credit)(\s|$)/i.test(text)
        ? 'credit'
        : /(^|\s)(借|debit)(\s|$)/i.test(text)
          ? 'debit'
          : 'any'
    const codeMatch = text.match(/[0-9A-Za-z]+/)
    const code = codeMatch ? codeMatch[0].toUpperCase() : ''
    if (!code) return null
    const name = text
      .replace(codeMatch ? codeMatch[0] : '', '')
      .replace(/(^|\s)(借|贷|debit|credit|任意|any)(\s|$)/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return { code, name, direction }
  })
  rule.requiredSubjects = subjects.filter((item): item is VoucherCheckRequiredSubject => !!item)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function recycleKindText(kind: string): string {
  if (kind === 'system.wipe-all') return '一键清空'
  if (kind === 'worksheet.clear') return '清空工作表'
  if (kind === 'worksheet.delete-records') return '批量删除'
  if (kind === 'worksheet.delete-record') return '删除记录'
  if (kind === 'monthly-payroll.delete-run') return '删除工资报账'
  if (kind === 'monthly-payroll.detail-replace') return '替换月度明细'
  if (kind === 'budget-xls.update') return '预算导入更新'
  if (kind === retireBatchKind) return '人员转退休'
  return kind
}

function close() {
  emit('update:modelValue', false)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="系统设置"
    width="1180px"
    :close-on-click-modal="false"
    @update:model-value="close"
  >
    <el-tabs v-model="activeTab" class="settings-tabs">
      <el-tab-pane label="单位信息" name="unit">
        <div class="settings-section">
          <h4>单位信息</h4>
          <p v-if="unitSettingsLock.locked" class="unit-lock-tip">{{ unitLockMessage }}</p>
          <p v-else>影响月度工资报账生成的单位名称、会计科目编码等。修改后下次生成报表立即生效。</p>
          <el-form :model="unitForm" label-width="140px" label-position="right" size="small">
            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="预算单位编码">
                  <el-input
                    v-model="unitForm.unitImportCode"
                    placeholder="如：019052"
                    :disabled="unitSettingsLock.locked"
                    @change="applySchoolLookupByCode"
                  >
                    <template #append>
                      <el-button
                        :loading="schoolLookupLoading"
                        :disabled="unitSettingsLock.locked"
                        @click="applySchoolLookupByCode"
                      >匹配</el-button>
                    </template>
                  </el-input>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="单位全称">
                  <el-input
                    v-model="unitForm.unitFullName"
                    placeholder="如：沭阳县扎下中心小学"
                    :disabled="unitSettingsLock.locked"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="支出功能分类编码">
                  <el-input
                    v-model="unitForm.functionCode"
                    placeholder="如：2050202"
                    :disabled="unitSettingsLock.locked"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="支出功能分类名称">
                  <el-input
                    v-model="unitForm.schoolLevel"
                    placeholder="如：小学教育 / 初中教育"
                    :disabled="unitSettingsLock.locked"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="在职预算项目编码">
                  <el-input v-model="unitForm.budgetActiveCode" placeholder="对应模板中 工资!D25">
                    <template #append>
                      <el-button
                        :loading="budgetProjectResolving"
                        :disabled="unitSaving"
                        @click="autofillBudgetProjectCodes"
                      >自动填入</el-button>
                    </template>
                  </el-input>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="退休预算项目编码">
                  <el-input v-model="unitForm.budgetRetiredCode" placeholder="对应模板中 工资!D26">
                    <template #append>
                      <el-button
                        :loading="budgetProjectResolving"
                        :disabled="unitSaving"
                        @click="autofillBudgetProjectCodes"
                      >自动填入</el-button>
                    </template>
                  </el-input>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="退休功能分类编码">
                  <el-input
                    v-model="unitForm.retiredFunctionCode"
                    placeholder="如：2210202"
                    :disabled="unitSettingsLock.locked"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="退休功能分类名称">
                  <el-input
                    v-model="unitForm.retiredFunctionName"
                    placeholder="如：退休提租补贴"
                    :disabled="unitSettingsLock.locked"
                  />
                </el-form-item>
              </el-col>
            </el-row>
            <el-divider content-position="left">五险缴存账户</el-divider>
            <el-row :gutter="12">
              <el-col :span="24">
                <el-form-item label="账户名称">
                  <el-input
                    v-model="unitForm.socialPayeeName"
                    placeholder="如：沭阳县会计核算中心代扣代缴专户"
                    :disabled="unitSettingsLock.locked"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="开户行">
                  <el-input v-model="unitForm.socialPayeeBank" :disabled="unitSettingsLock.locked" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="账号">
                  <el-input v-model="unitForm.socialPayeeAccount" :disabled="unitSettingsLock.locked" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-divider content-position="left">公积金缴存账户</el-divider>
            <el-row :gutter="12">
              <el-col :span="24">
                <el-form-item label="账户名称">
                  <el-input v-model="unitForm.housingPayeeName" :disabled="unitSettingsLock.locked" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="开户行">
                  <el-input v-model="unitForm.housingPayeeBank" :disabled="unitSettingsLock.locked" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="账号">
                  <el-input v-model="unitForm.housingPayeeAccount" :disabled="unitSettingsLock.locked" />
                </el-form-item>
              </el-col>
            </el-row>

            <div>
              <el-button
                type="primary"
                :loading="unitSaving"
                @click="saveUnitSettings()"
              >保存单位信息</el-button>
            </div>
          </el-form>
        </div>
      </el-tab-pane>

      <el-tab-pane label="一致性审计" name="audit">
        <div class="settings-audit-pane">
          <ConsistencyAuditPage />
        </div>
      </el-tab-pane>

      <el-tab-pane label="账务检查规则" name="voucher-rules">
        <div class="settings-section voucher-rule-toolbar">
          <div>
            <h4>账务检查规则库</h4>
            <p>规则保存在本机，可导入导出 JSON 文件。保存后重新进入或刷新一体化凭证页面，账务检查会按新规则执行。</p>
          </div>
          <div class="voucher-rule-actions">
            <el-button size="small" @click="addVoucherRule('keyword-eco')">新增经济分类规则</el-button>
            <el-button size="small" @click="addVoucherRule('keyword-subject-set')">新增科目组合规则</el-button>
            <el-button size="small" @click="addVoucherRule('fixed-asset-capital')">新增固定资产规则</el-button>
            <el-button size="small" @click="addVoucherRule('balance-equation')">新增余额表勾稽规则</el-button>
            <el-button size="small" :loading="voucherRulesFileBusy" @click="importVoucherRules">导入</el-button>
            <el-button size="small" :loading="voucherRulesFileBusy" @click="exportVoucherRules">导出</el-button>
            <el-button size="small" type="warning" plain :loading="voucherRulesSaving" @click="resetVoucherRules">恢复默认</el-button>
            <el-button size="small" type="primary" :loading="voucherRulesSaving" @click="saveVoucherRules">保存规则库</el-button>
          </div>
        </div>

        <div v-loading="voucherRulesLoading" class="voucher-rule-list">
          <div v-if="!voucherRules.length" class="voucher-rule-empty">
            暂无规则，请新增或恢复默认规则。
          </div>
          <div
            v-for="(rule, index) in voucherRules"
            :key="rule.id"
            class="voucher-rule-item"
          >
            <div class="voucher-rule-head">
              <div class="voucher-rule-title">
                <el-switch v-model="rule.enabled" size="small" />
                <el-tag size="small" effect="plain">{{ ruleTypeText(rule.type) }}</el-tag>
                <el-input v-model="rule.name" size="small" placeholder="规则名称" />
                <el-select v-model="rule.level" size="small" style="width: 96px">
                  <el-option label="提醒" value="warn" />
                  <el-option label="严重" value="error" />
                </el-select>
              </div>
              <div class="voucher-rule-row-actions">
                <el-button size="small" text :disabled="index === 0" @click="moveVoucherRule(index, -1)">上移</el-button>
                <el-button size="small" text :disabled="index === voucherRules.length - 1" @click="moveVoucherRule(index, 1)">下移</el-button>
                <el-button size="small" text @click="duplicateVoucherRule(index)">复制</el-button>
                <el-button size="small" text type="danger" @click="removeVoucherRule(index)">删除</el-button>
              </div>
            </div>

            <el-row :gutter="12">
              <el-col v-if="'keywords' in rule" :span="24">
                <el-form-item label="摘要关键词" label-width="110px" class="voucher-rule-form-item">
                  <el-input
                    :model-value="getRuleKeywords(rule)"
                    size="small"
                    placeholder="多个关键词用逗号或换行分隔"
                    @update:model-value="setRuleKeywords(rule, String($event))"
                  />
                </el-form-item>
              </el-col>

              <template v-if="rule.type === 'keyword-eco'">
                <el-col :span="8">
                  <el-form-item label="应为经济分类" label-width="110px" class="voucher-rule-form-item">
                    <el-input v-model="rule.expectedEcoCode" size="small" placeholder="如：30107" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="分类名称" label-width="90px" class="voucher-rule-form-item">
                    <el-input v-model="rule.expectedEcoName" size="small" placeholder="如：绩效工资" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="建议文字" label-width="80px" class="voucher-rule-form-item">
                    <el-input v-model="rule.suggestion" size="small" placeholder="如：应修改为30107 绩效工资。" />
                  </el-form-item>
                </el-col>
              </template>

              <template v-else-if="rule.type === 'keyword-subject-set'">
                <el-col :span="24">
                  <el-form-item label="应包含科目" label-width="110px" class="voucher-rule-form-item">
                    <el-input
                      :model-value="subjectLines(rule)"
                      type="textarea"
                      :rows="4"
                      placeholder="每行一个：编码 名称 借/贷，如：7201010103 事业支出-基本支出-人员经费-其他资金支出 借"
                      @update:model-value="setSubjectLines(rule, String($event))"
                    />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="预算支出科目" label-width="110px" class="voucher-rule-form-item">
                    <el-input v-model="rule.expectedBudgetExpenseSubjectCode" size="small" placeholder="如：7201010103" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="预算收入科目" label-width="110px" class="voucher-rule-form-item">
                    <el-input v-model="rule.expectedBudgetRevenueSubjectCode" size="small" placeholder="如：66090502" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="建议文字" label-width="80px" class="voucher-rule-form-item">
                    <el-input v-model="rule.suggestion" size="small" placeholder="如：应按图片中的四条分录科目调整。" />
                  </el-form-item>
                </el-col>
              </template>

              <template v-else-if="rule.type === 'balance-equation'">
                <el-col :span="8">
                  <el-form-item label="源科目编码" label-width="110px" class="voucher-rule-form-item">
                    <el-input v-model="rule.sourceCode" size="small" placeholder="如：400101" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="源科目名称" label-width="110px" class="voucher-rule-form-item">
                    <el-input v-model="rule.sourceName" size="small" placeholder="如：一般公共预算财政拨款" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="源校验字段" label-width="110px" class="voucher-rule-form-item">
                    <el-input
                      :model-value="getBalanceSourceFields(rule)"
                      size="small"
                      placeholder="如：本期借方，本期贷方"
                      @update:model-value="setBalanceSourceFields(rule, String($event))"
                    />
                  </el-form-item>
                </el-col>
                <el-col :span="24">
                  <el-form-item label="目标科目" label-width="110px" class="voucher-rule-form-item">
                    <el-input
                      :model-value="balanceTargetLines(rule)"
                      type="textarea"
                      :rows="3"
                      placeholder="每行一个：编码 名称 字段，如：7201010101 财政拨款支出 本期借方"
                      @update:model-value="setBalanceTargetLines(rule, String($event))"
                    />
                  </el-form-item>
                </el-col>
                <el-col :span="24">
                  <el-form-item label="建议文字" label-width="110px" class="voucher-rule-form-item">
                    <el-input v-model="rule.suggestion" size="small" placeholder="如：请核对余额表科目发生额是否一致。" />
                  </el-form-item>
                </el-col>
              </template>

              <template v-else-if="rule.type === 'fixed-asset-capital'">
                <el-col :span="12">
                  <el-form-item label="固定资产科目前缀" label-width="130px" class="voucher-rule-form-item">
                    <el-input
                      :model-value="getFixedPrefixes(rule)"
                      size="small"
                      placeholder="如：160101，160102"
                      @update:model-value="setFixedPrefixes(rule, String($event))"
                    />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="预算支出科目前缀" label-width="130px" class="voucher-rule-form-item">
                    <el-input
                      :model-value="getBudgetPrefixes(rule)"
                      size="small"
                      placeholder="如：720"
                      @update:model-value="setBudgetPrefixes(rule, String($event))"
                    />
                  </el-form-item>
                </el-col>
                <el-col :span="16">
                  <el-form-item label="允许经济分类" label-width="130px" class="voucher-rule-form-item">
                    <el-input
                      :model-value="getAllowedEcoCodes(rule)"
                      size="small"
                      placeholder="如：31001，31002，31003"
                      @update:model-value="setAllowedEcoCodes(rule, String($event))"
                    />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="建议文字" label-width="80px" class="voucher-rule-form-item">
                    <el-input v-model="rule.suggestion" size="small" placeholder="应修改为310类资本性支出。" />
                  </el-form-item>
                </el-col>
              </template>
            </el-row>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="数据库" name="database">
        <div class="settings-section">
          <h4>全量备份</h4>
          <p>包含：业务数据库、工资数据、工资导入、交换包；保留：本机授权、备份库、登录缓存。</p>
          <div class="backup-actions">
            <el-button type="primary" :loading="creatingFullBackup" @click="createFullBackup">全量备份所有数据</el-button>
            <el-button
              type="warning"
              plain
              :loading="restoringFullBackup"
              @click="restoreFullBackup()"
            >选择全量备份恢复</el-button>
            <el-button @click="refreshBackupLists">刷新备份列表</el-button>
          </div>
        </div>

        <el-table
          :data="fullBackups"
          v-loading="fullBackupsLoading"
          border
          size="small"
          height="220"
          empty-text="暂无保存在默认备份目录的全量备份"
        >
          <el-table-column prop="fileName" label="全量备份文件" min-width="260" show-overflow-tooltip />
          <el-table-column label="大小" width="100" align="right">
            <template #default="{ row }">{{ formatSize(row.sizeBytes) }}</template>
          </el-table-column>
          <el-table-column prop="createdAt" label="时间" min-width="200" />
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="warning" @click="restoreFullBackup(row)">恢复</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="回收站" name="recycle">
        <div class="settings-section">
          <h4>回收站</h4>
          <p>删除、清空、替换前的数据快照会永久留痕；恢复时只补回不存在的原记录，不覆盖当前数据。</p>
          <p>「人员转退休」批次请用「撤销退休」整批撤回：会补回在职工资、删除对应退休工资行，并把各表人员状态刷新回在职。</p>
          <div>
            <el-button @click="refreshRecycleBin">刷新回收站</el-button>
          </div>
        </div>

        <el-table :data="recycleBatches" v-loading="recycleLoading" border size="small" height="420">
          <el-table-column prop="id" label="批次" width="78" />
          <el-table-column prop="createdAt" label="时间" min-width="170" />
          <el-table-column label="类型" width="130">
            <template #default="{ row }">{{ recycleKindText(row.kind) }}</template>
          </el-table-column>
          <el-table-column label="对象" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.targetName || row.targetType || '-' }}</template>
          </el-table-column>
          <el-table-column label="说明" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.reason || '-' }}</template>
          </el-table-column>
          <el-table-column prop="recordCount" label="快照行数" width="100" align="right" />
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.kind === retireBatchKind"
                size="small"
                text
                type="warning"
                :loading="recycleRevertingId === row.id"
                @click="revertRetirement(row)"
              >撤销退休</el-button>
              <el-button
                v-else
                size="small"
                text
                type="primary"
                :loading="recycleRestoringId === row.id"
                @click="restoreRecycleBatch(row)"
              >恢复</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="导入目录" name="import">
        <div class="settings-section">
          <h4>Excel 自动导入固定文件夹</h4>
          <p>{{ importWatcher?.folderPath || '未配置' }}</p>
          <p>模板文件夹：{{ importWatcher?.templateFolderPath || '-' }}</p>
          <div>
            <el-button @click="openImportFolder">打开目录</el-button>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="基础对照表" name="lookups">
        <div class="settings-section">
          <h4>基础对照表</h4>
          <p>岗位、薪级、乡镇工作年限、学校对照属于基础数据，一键清空时会自动保留。</p>
          <div class="lookup-actions">
            <el-button @click="openLookupWorksheet('岗位工资对照')">岗位工资对照</el-button>
            <el-button @click="openLookupWorksheet('薪级工资对照')">薪级工资对照</el-button>
            <el-button @click="openLookupWorksheet('乡镇工作年限对照')">乡镇工作年限对照</el-button>
            <el-button @click="openLookupWorksheet('学校对照表')">学校对照表</el-button>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="邮件附件" name="mail">
        <MailAttachmentPage />
      </el-tab-pane>

      <el-tab-pane v-if="showInternalTools" label="采集助手" name="automation">
        <component :is="AutomationDiagnosticsPage" />
      </el-tab-pane>

      <el-tab-pane label="关于" name="about">
        <div class="about-panel">
          <div class="about-brand">
            <div class="about-mark">资</div>
            <div>
              <h2>工资系统</h2>
              <p>工资业务与数据管理工作台</p>
            </div>
          </div>
          <div class="about-meta">
            <div>
              <span>版权人</span>
              <strong>老九</strong>
            </div>
            <div>
              <span>版权声明</span>
              <strong>© 2026 老九 版权所有</strong>
            </div>
            <div>
              <span>使用授权</span>
              <strong>仅限授权单位内部工资业务使用</strong>
            </div>
            <div>
              <span>当前版本</span>
              <strong>v{{ appVersion }}</strong>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="危险操作" name="danger">
        <div class="settings-section danger-section">
          <h4>危险操作</h4>
          <p>清空后不可恢复，先建一份备份再操作。四张基础对照表会保留。</p>
          <div>
            <el-button type="danger" :loading="wiping" @click="wipeAll">一键清空所有数据</el-button>
          </div>
        </div>
        <div class="settings-section diagnostic-section">
          <h4>诊断模式</h4>
          <p>
            {{
              showInternalTools
                ? '已开启：显示采集助手、录制工具、外部浏览器和推送日志入口。'
                : '默认隐藏内部调试入口，需要到现场采集或排查时输入密码开启。'
            }}
          </p>
          <div>
            <el-button :type="showInternalTools ? 'warning' : 'primary'" @click="toggleInternalTools">
              {{ showInternalTools ? '关闭诊断模式' : '开启诊断模式' }}
            </el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <el-button type="primary" @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.settings-tabs {
  min-height: 560px;
}

.settings-section {
  display: grid;
  gap: 10px;
}

.settings-section h4 {
  margin: 0;
  color: var(--text);
  font-size: 15px;
}

.settings-section p {
  margin: 0;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.6;
}

.settings-section .unit-lock-tip {
  color: var(--danger);
}

.lookup-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.backup-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.danger-section {
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: var(--radius);
  background: var(--danger-soft);
}

.diagnostic-section {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid #d7e7ff;
  border-radius: var(--radius);
  background: #f7fbff;
}

.settings-audit-pane {
  height: 560px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.settings-audit-pane :deep(.audit-page) {
  min-height: 560px;
  padding: 14px;
}

.settings-audit-pane :deep(.audit-header h2) {
  font-size: 18px;
}

.voucher-rule-toolbar {
  margin-bottom: 12px;
}

.voucher-rule-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.voucher-rule-list {
  display: grid;
  gap: 10px;
  max-height: 500px;
  overflow: auto;
  padding-right: 4px;
}

.voucher-rule-empty {
  padding: 18px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-3);
  text-align: center;
}

.voucher-rule-item {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #fff;
}

.voucher-rule-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 10px;
}

.voucher-rule-title {
  display: grid;
  grid-template-columns: auto auto minmax(180px, 1fr) 96px;
  gap: 8px;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.voucher-rule-row-actions {
  display: flex;
  gap: 4px;
  white-space: nowrap;
}

.voucher-rule-form-item {
  margin-bottom: 8px;
}

.about-panel {
  display: grid;
  gap: 22px;
}

.about-brand {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}

.about-mark {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 6px;
  background: var(--primary);
  color: #fff;
  font-size: 22px;
  font-weight: 800;
}

.about-brand h2 {
  margin: 0 0 6px;
  color: var(--text);
  font-size: 22px;
}

.about-brand p {
  margin: 0;
  color: var(--text-3);
  font-size: 13px;
}

.about-meta {
  display: grid;
  gap: 12px;
  max-width: 620px;
}

.about-meta > div {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 16px;
  align-items: center;
  min-height: 38px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.about-meta span {
  color: var(--text-3);
  font-size: 13px;
}

.about-meta strong {
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
}
</style>
