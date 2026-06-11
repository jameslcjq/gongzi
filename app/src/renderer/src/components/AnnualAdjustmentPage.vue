<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  AnnualAdjustmentApplyResult,
  AnnualAdjustmentFilePick,
  AnnualAdjustmentPreviewInput,
  AnnualAdjustmentSourceRow,
  ImportWatcherStatus,
  PersonalTaxImportGenerateResult,
  SocialInsuranceBaseExportResult
} from '@shared/types'
import {
  pendingPushQueue,
  requestSwitchToIntegration,
  type PushStep
} from '../integration/insurancePushQueue'

const props = defineProps<{
  importWatcher?: ImportWatcherStatus | null
  loading?: boolean
}>()

const emit = defineEmits<{
  refresh: []
  openFolder: []
}>()

const taxTemplateFile = ref<AnnualAdjustmentFilePick | null>(null)
const result = ref<AnnualAdjustmentApplyResult | null>(null)
const taxResult = ref<PersonalTaxImportGenerateResult | null>(null)
const socialBaseTemplateFile = ref<AnnualAdjustmentFilePick | null>(null)
const socialBaseResult = ref<SocialInsuranceBaseExportResult | null>(null)
const adjustmentLoading = ref(false)
const taxLoading = ref(false)
const socialBaseLoading = ref(false)
const pushingAnnualAdjustment = ref(false)

const incomeFieldOptions = [
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
  '其他三'
]

const selectedIncomeFields = ref<string[]>([
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
  '其他三'
])

const selectedSocialBaseFields = ref<string[]>([...selectedIncomeFields.value])

const detectedFiles = computed(() => props.importWatcher?.annualAdjustment)

const canUpdateInsurance = computed(
  () =>
    Boolean(detectedFiles.value?.salaryWorkbookPath) &&
    (Boolean(detectedFiles.value?.housingAccountWorkbookPath) ||
      Boolean(detectedFiles.value?.insuranceDetailWorkbookPaths.length))
)

async function chooseTaxTemplateFile() {
  const files = await window.salaryApi.chooseAnnualAdjustmentFiles({
    title: '选择个税导入模板',
    multi: false
  })
  if (files?.[0]) {
    taxTemplateFile.value = files[0]
    taxResult.value = null
  }
}

async function chooseSocialBaseTemplateFile() {
  const files = await window.salaryApi.chooseAnnualAdjustmentFiles({
    title: '选择参保职工列表模板',
    multi: false
  })
  if (files?.[0]) {
    socialBaseTemplateFile.value = files[0]
    socialBaseResult.value = null
  }
}

function buildInput(): AnnualAdjustmentPreviewInput {
  const files = detectedFiles.value
  if (!files?.salaryWorkbookPath) throw new Error('监控文件夹未检测到工资表')
  return {
    salaryWorkbookPath: files.salaryWorkbookPath,
    housingAccountWorkbookPath: files.housingAccountWorkbookPath,
    insuranceDetailWorkbookPaths: [...files.insuranceDetailWorkbookPaths]
  }
}

async function applyAdjustment() {
  adjustmentLoading.value = true
  result.value = null
  try {
    const input = buildInput()
    const confirmed = await confirmNameIdCardMismatches(input)
    if (!confirmed) return
    const next = await window.salaryApi.applyAnnualAdjustment({
      ...input,
      confirmIntegratedWriteBack: true,
      confirmNameIdCardMismatch: confirmed === 'confirmed'
    })
    result.value = next
    ElMessage.success(next.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '更新五险一金失败')
  } finally {
    adjustmentLoading.value = false
  }
}

async function confirmNameIdCardMismatches(
  input: AnnualAdjustmentPreviewInput
): Promise<'none' | 'confirmed' | false> {
  const preview = await window.salaryApi.previewAnnualAdjustment(input)
  const conflicts = (preview.sourceRows as AnnualAdjustmentSourceRow[]).filter(
    isConfirmableNameIdCardMismatch
  )
  if (conflicts.length === 0) return 'none'
  const examples = conflicts
    .slice(0, 10)
    .map((row: AnnualAdjustmentSourceRow) =>
      `- ${row.name}：来源身份证 ${row.idCard}，工资表身份证 ${row.targetIdCard || '未识别'}，${row.fieldName} ${formatMoney(row.amount)}（${row.sourceFile} 第 ${row.rowNumber} 行）`
    )
    .join('\n')
  const more = conflicts.length > 10 ? `\n...还有 ${conflicts.length - 10} 条` : ''
  try {
    await ElMessageBox.confirm(
      `发现 ${conflicts.length} 条五险一金明细与工资表同名但身份证不同。确认后本次会按工资表唯一同名人员写入明细金额；不会修改原始身份证号。\n\n${examples}${more}`,
      '确认身份匹配',
      {
        type: 'warning',
        confirmButtonText: '确认并继续',
        cancelButtonText: '先不继续'
      }
    )
    return 'confirmed'
  } catch {
    return false
  }
}

function isConfirmableNameIdCardMismatch(row: AnnualAdjustmentSourceRow): boolean {
  return row.status === 'id-conflict' && row.reason.includes('需人工确认')
}

function formatMoney(value: number): string {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}

async function generateTaxImport() {
  if (selectedIncomeFields.value.length === 0) {
    ElMessage.warning('请选择计入本期收入的字段')
    return
  }
  taxLoading.value = true
  try {
    const next = await window.salaryApi.generatePersonalTaxImport({
      templateWorkbookPath:
        taxTemplateFile.value?.filePath ?? detectedFiles.value?.taxTemplateWorkbookPath,
      incomeFields: [...selectedIncomeFields.value]
    })
    taxResult.value = next
    ElMessage.success(`已生成个税导入文件：${next.rowCount} 人`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生成个税导入文件失败')
  } finally {
    taxLoading.value = false
  }
}

async function generateSocialInsuranceBase() {
  if (selectedSocialBaseFields.value.length === 0) {
    ElMessage.warning('请选择计入社保基数的字段')
    return
  }
  socialBaseLoading.value = true
  try {
    const next = await window.salaryApi.exportSocialInsuranceBase({
      templateWorkbookPath:
        socialBaseTemplateFile.value?.filePath ?? detectedFiles.value?.socialBaseTemplateWorkbookPath,
      baseFields: [...selectedSocialBaseFields.value]
    })
    socialBaseResult.value = next
    ElMessage.success(`已生成社保基数导出文件：${next.rowCount} 人`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生成社保基数导出文件失败')
  } finally {
    socialBaseLoading.value = false
  }
}

async function openPath(path?: string) {
  if (!path) return
  await window.salaryApi.openLocalPath(path)
}

async function pushAnnualAdjustmentToIntegrated() {
  if (!result.value?.salaryImportPath) {
    ElMessage.warning('没有可推送的五险一金工资导入文件')
    return
  }
  pushingAnnualAdjustment.value = true
  try {
    const monthPrompt = await ElMessageBox.prompt(
      '请输入五险一金导入对应的一体化月份，例如 1',
      '五险一金导入月份',
      {
        confirmButtonText: '开始推送',
        cancelButtonText: '取消',
        inputValue: '1',
        inputPattern: /^(1[0-2]|[1-9])$/,
        inputErrorMessage: '请输入 1-12 的月份'
      }
    )
    const month = String(monthPrompt.value || '').trim()
    const file = await window.salaryApi.readLocalFileBase64(result.value.salaryImportPath)
    const steps: PushStep[] = [
      {
        kind: 'salary-system-import',
        mode: 'salary',
        fileBase64: file.base64,
        fileName: file.fileName,
        fileSize: file.size,
        month,
        label: `五险一金 ${result.value.salaryApplied} 人`
      }
    ]
    pendingPushQueue.value = steps
    ElMessage.info('已准备五险一金推送，正在跳转到“一体化对接”...')
    requestSwitchToIntegration()
  } catch (error) {
    const action = (error as { action?: string; message?: string } | undefined)?.action
    const message = (error as { message?: string } | undefined)?.message
    if (error === 'cancel' || action === 'cancel' || action === 'close' || message === 'cancel') return
    ElMessage.error(error instanceof Error ? error.message : '五险一金推送失败')
  } finally {
    pushingAnnualAdjustment.value = false
  }
}
</script>

<template>
  <section class="annual-page">
    <div class="annual-grid">
      <section class="annual-panel">
        <div class="panel-title-row">
          <h2>公积金 / 五险来源</h2>
          <div class="watcher-actions">
            <el-button size="small" :loading="props.loading" @click="emit('refresh')">刷新</el-button>
            <el-button size="small" @click="emit('openFolder')">打开文件夹</el-button>
            <el-button
              size="small"
              type="primary"
              :disabled="!canUpdateInsurance"
              :loading="adjustmentLoading"
              @click="applyAdjustment"
            >
              更新五险一金
            </el-button>
          </div>
        </div>
        <div class="watcher-folder">
          {{ props.importWatcher?.folderPath || '监控文件夹未启动' }}
        </div>
        <div class="file-row">
          <strong>工资表</strong>
          <span>{{ detectedFiles?.salaryWorkbookName || '未检测到' }}</span>
        </div>
        <div class="file-row">
          <strong>公积金账号表</strong>
          <span>{{ detectedFiles?.housingAccountWorkbookName || '未检测到' }}</span>
        </div>
        <div class="file-row">
          <strong>五险明细</strong>
          <span>
            {{
              detectedFiles?.insuranceDetailWorkbookNames.length
                ? `${detectedFiles.insuranceDetailWorkbookNames.length} 个文件`
                : '未检测到'
            }}
          </span>
        </div>
        <div v-if="detectedFiles?.insuranceDetailWorkbookNames.length" class="file-list">
          <span
            v-for="(fileName, index) in detectedFiles.insuranceDetailWorkbookNames"
            :key="`${fileName}-${index}`"
          >
            {{ fileName }}
          </span>
        </div>
      </section>
    </div>

    <section class="annual-panel annual-wide">
      <div class="panel-title-row">
        <h2>个税导入文件</h2>
        <el-button type="primary" :loading="taxLoading" @click="generateTaxImport">
          生成个税导入
        </el-button>
      </div>
      <div class="file-row">
        <strong>个税模板</strong>
        <span>
          {{
            taxTemplateFile?.fileName ||
            detectedFiles?.taxTemplateWorkbookName ||
            '内置：正常工资薪金所得.xls'
          }}
        </span>
        <el-button size="small" @click="chooseTaxTemplateFile">覆盖</el-button>
      </div>
      <div class="income-fields">
        <strong>计入本期收入</strong>
        <el-checkbox-group v-model="selectedIncomeFields">
          <el-checkbox
            v-for="field in incomeFieldOptions"
            :key="field"
            :label="field"
            :value="field"
          />
        </el-checkbox-group>
      </div>
      <div class="tax-map">
        <span>固定映射：</span>
        <span>基本养老保险费=养老保险缴费</span>
        <span>基本医疗保险费=医疗保险</span>
        <span>失业保险费=失业保险</span>
        <span>住房公积金=公积金</span>
        <span>企业(职业)年金=职业年金缴费</span>
      </div>
      <div v-if="taxResult" class="output-list">
        <button @click="openPath(taxResult.filePath)">个税导入：{{ taxResult.filePath }}</button>
        <small>
          {{ taxResult.rowCount }} 人，本期收入合计 {{ taxResult.incomeTotal }}，五险一金合计
          {{ taxResult.pensionTotal + taxResult.medicalTotal + taxResult.unemploymentTotal + taxResult.housingTotal + taxResult.annuityTotal }}
        </small>
      </div>
    </section>

    <section class="annual-panel annual-wide">
      <div class="panel-title-row">
        <h2>社保基数导出</h2>
        <el-button type="primary" :loading="socialBaseLoading" @click="generateSocialInsuranceBase">
          生成社保基数
        </el-button>
      </div>
      <div class="file-row">
        <strong>参保模板</strong>
        <span>
          {{
            socialBaseTemplateFile?.fileName ||
            detectedFiles?.socialBaseTemplateWorkbookName ||
            '内置：参保职工列表模板.xlsx'
          }}
        </span>
        <el-button size="small" @click="chooseSocialBaseTemplateFile">覆盖</el-button>
      </div>
      <div class="income-fields">
        <strong>计入社保基数</strong>
        <el-checkbox-group v-model="selectedSocialBaseFields">
          <el-checkbox
            v-for="field in incomeFieldOptions"
            :key="field"
            :label="field"
            :value="field"
          />
        </el-checkbox-group>
      </div>
      <div class="tax-map">
        <span>固定列：</span>
        <span>120|机关事业单位养老保险</span>
        <span>180|职业年金</span>
        <span>210|失业保险</span>
        <span>310|职工基本医疗保险</span>
        <span>330|大额医疗费用补助</span>
        <span>410|工伤保险</span>
        <span>510|生育保险</span>
      </div>
      <div v-if="socialBaseResult" class="output-list">
        <button @click="openPath(socialBaseResult.filePath)">
          社保基数：{{ socialBaseResult.filePath }}
        </button>
        <small>{{ socialBaseResult.rowCount }} 人，基数合计 {{ socialBaseResult.baseTotal }}</small>
      </div>
    </section>

    <section v-if="result" class="annual-panel annual-wide">
      <h2>输出</h2>
      <div class="output-list">
        <button @click="openPath(result.salaryOutputPath)">工资表：{{ result.salaryOutputPath }}</button>
        <button v-if="result.salaryImportPath" @click="openPath(result.salaryImportPath)">
          工资导入：{{ result.salaryImportPath }}
        </button>
        <el-button
          v-if="result.salaryImportPath"
          type="success"
          :loading="pushingAnnualAdjustment"
          @click="pushAnnualAdjustmentToIntegrated"
        >
          推送五险一金
        </el-button>
        <button v-if="result.housingDeclarationPath" @click="openPath(result.housingDeclarationPath)">
          公积金申报：{{ result.housingDeclarationPath }}
        </button>
        <button v-if="result.housingMissingLogPath" @click="openPath(result.housingMissingLogPath)">
          未查到账号：{{ result.housingMissingLogPath }}
        </button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.annual-page {
  padding: 20px;
  color: #1f2937;
}

.annual-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}

.annual-panel {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  padding: 16px;
}

.annual-panel h2 {
  margin: 0 0 12px;
  font-size: 16px;
}

.panel-title-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}

.panel-title-row h2 {
  margin: 0;
}

.watcher-actions {
  display: flex;
  gap: 8px;
}

.watcher-folder {
  margin: -2px 0 8px;
  color: #64748b;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.annual-wide {
  margin-top: 16px;
}

.file-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid #edf2f7;
}

.file-row span,
.file-list span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #475569;
}

.file-list {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  font-size: 13px;
}

.income-fields {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.income-fields :deep(.el-checkbox-group) {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 6px 12px;
}

.tax-map {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-top: 14px;
  color: #64748b;
  font-size: 13px;
}

.output-list {
  display: grid;
  gap: 8px;
}

.output-list button {
  border: 0;
  background: transparent;
  color: #2563eb;
  text-align: left;
  cursor: pointer;
}
</style>
