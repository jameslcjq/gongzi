<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type {
  AnnualAdjustmentFilePick,
  ImportWatcherStatus,
  PersonalTaxImportGenerateResult,
  SocialBaseApplyResult,
  SocialBaseDataSourceMode,
  SocialBaseManualChange,
  SocialBasePreview
} from '@shared/types'

const props = defineProps<{
  importWatcher?: ImportWatcherStatus | null
  loading?: boolean
}>()

defineEmits<{
  refresh: []
  openFolder: []
}>()

const taxTemplateFile = ref<AnnualAdjustmentFilePick | null>(null)
const taxResult = ref<PersonalTaxImportGenerateResult | null>(null)
const socialBaseTemplateFile = ref<AnnualAdjustmentFilePick | null>(null)
const taxLoading = ref(false)
const socialBaseLoading = ref(false)

// 社保基数两阶段：数据源 → 预览确认 → 应用
const dataSourceMode = ref<SocialBaseDataSourceMode>('salary-workbook')
const previewVisible = ref(false)
const preview = ref<SocialBasePreview | null>(null)
const batchChoice = ref<Record<string, string>>({})
const writeDatabase = ref(true)
const applyResult = ref<SocialBaseApplyResult | null>(null)
const applyLoading = ref(false)

function manualKey(item: { idCard: string; fieldName: string }): string {
  return `${item.idCard}::${item.fieldName}`
}

// 未匹配项按人去重（后端按字段返回，一人可能多条）
const missingPeople = computed(() => {
  const map = new Map<string, { name: string; idCard: string }>()
  for (const item of preview.value?.missing ?? []) {
    if (!map.has(item.idCard)) map.set(item.idCard, { name: item.name, idCard: item.idCard })
  }
  return [...map.values()]
})

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
  '其他一',
  '其他二',
  '其他三'
]

const selectedIncomeFields = ref<string[]>([
  '岗位工资',
  '薪级工资',
  '岗位津贴',
  '生活补贴',
  '教（工）龄补贴'
])

const detectedFiles = computed(() => props.importWatcher?.annualAdjustment)

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
    await openOutputFolder(next.filePath)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生成个税导入文件失败')
  } finally {
    taxLoading.value = false
  }
}

function buildSocialBaseInput() {
  return {
    dataSourceMode: dataSourceMode.value,
    salaryWorkbookPath: detectedFiles.value?.salaryWorkbookPath,
    housingAccountWorkbookPath: detectedFiles.value?.housingAccountWorkbookPath,
    socialBaseTemplatePath:
      socialBaseTemplateFile.value?.filePath ?? detectedFiles.value?.socialBaseTemplateWorkbookPath
  }
}

async function openSocialBasePreview() {
  socialBaseLoading.value = true
  try {
    const next = await window.salaryApi.previewSocialInsuranceBase(buildSocialBaseInput())
    preview.value = next
    const choice: Record<string, string> = {}
    for (const item of next.manualChanges) choice[manualKey(item)] = item.defaultBatchCode
    batchChoice.value = choice
    writeDatabase.value = true
    previewVisible.value = true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '预览社保基数失败')
  } finally {
    socialBaseLoading.value = false
  }
}

async function confirmSocialBaseApply() {
  if (!preview.value) return
  applyLoading.value = true
  try {
    const batchSelections = preview.value.manualChanges.map((item) => ({
      idCard: item.idCard,
      fieldName: item.fieldName,
      batchCode: batchChoice.value[manualKey(item)] ?? item.defaultBatchCode
    }))
    const next = await window.salaryApi.applySocialInsuranceBase({
      ...buildSocialBaseInput(),
      batchSelections,
      writeDatabase: writeDatabase.value
    })
    applyResult.value = next
    previewVisible.value = false
    const messages = [`社保基数 ${next.changedPeopleCount} 人变动`]
    if (next.salaryApplied) messages.push(`工资表回写 ${next.salaryApplied} 人`)
    if (next.integratedApplied) messages.push(`在职工资回写 ${next.integratedApplied} 项`)
    ElMessage.success(`已生成：${messages.join('，')}`)
    await openOutputFolder(
      next.changeDetailPath || next.housingDeclarationPath || next.salaryOutputPath || next.socialBasePath
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生成社保、公积金文件失败')
  } finally {
    applyLoading.value = false
  }
}

async function openPath(path?: string) {
  if (!path) return
  await window.salaryApi.openLocalPath(path)
}

function parentDir(path?: string): string | undefined {
  if (!path) return undefined
  const next = path.replace(/[\\/][^\\/]*$/, '')
  return next && next !== path ? next : undefined
}

async function openOutputFolder(path?: string) {
  const folder = parentDir(path)
  if (!folder) return
  const error = await window.salaryApi.openLocalPath(folder)
  if (error) ElMessage.warning(`输出文件夹打开失败：${error}`)
}
</script>

<template>
  <section class="annual-page">
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
        <h2>导出社保、公积金</h2>
        <el-button type="primary" :loading="socialBaseLoading" @click="openSocialBasePreview">
          生成新五险一金
        </el-button>
      </div>
      <div class="source-row">
        <strong>数据源</strong>
        <el-radio-group v-model="dataSourceMode">
          <el-radio value="salary-workbook">工资表花名册</el-radio>
          <el-radio value="integrated">在职工资(一体化数据)</el-radio>
        </el-radio-group>
        <span class="source-hint">默认工资表；选「在职工资」从本地数据库取数（无花名册可回写）</span>
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
      </div>
      <div class="file-row">
        <strong>公积金模板</strong>
        <span>内置：grjcjsList.xls</span>
      </div>
      <div class="tax-map">
        <span>五险基数公式：</span>
        <span>岗位工资 + 薪级工资 + 教（工）龄补贴 + 岗位津贴 + 生活补贴 + (岗位津贴 + 生活补贴) * 3 / 7，结果进一取整</span>
      </div>
      <div class="tax-map">
        <span>公积金公式：</span>
        <span>(岗位工资 + 薪级工资 + 教（工）龄补贴 + 岗位津贴 + 生活补贴 + (岗位津贴 + 生活补贴) * 3 / 7 + 住房补贴 + 交通费 + (岗位工资 + 薪级工资) / 12) * 12%，结果四舍五入取整数</span>
      </div>
      <div class="tax-map">
        <span>导出固定列：</span>
        <span>120|机关事业单位养老保险</span>
        <span>180|职业年金</span>
        <span>210|失业保险</span>
        <span>310|职工基本医疗保险</span>
        <span>330|大额医疗费用补助</span>
        <span>410|工伤保险</span>
        <span>510|生育保险</span>
      </div>
      <div v-if="applyResult" class="output-list">
        <button @click="openPath(applyResult.socialBasePath)">
          社保基数：{{ applyResult.socialBasePath }}
        </button>
        <button
          v-if="applyResult.housingDeclarationPath"
          @click="openPath(applyResult.housingDeclarationPath)"
        >
          公积金导入：{{ applyResult.housingDeclarationPath }}
        </button>
        <button v-if="applyResult.changeDetailPath" @click="openPath(applyResult.changeDetailPath)">
          五险一金变动明细：{{ applyResult.changeDetailPath }}
        </button>
        <button v-if="applyResult.salaryOutputPath" @click="openPath(applyResult.salaryOutputPath)">
          工资表：{{ applyResult.salaryOutputPath }}
        </button>
        <button v-if="applyResult.salaryBackupPath" @click="openPath(applyResult.salaryBackupPath)">
          原始备份：{{ applyResult.salaryBackupPath }}
        </button>
        <button
          v-if="applyResult.housingMissingLogPath"
          @click="openPath(applyResult.housingMissingLogPath)"
        >
          未查到账号：{{ applyResult.housingMissingLogPath }}
        </button>
        <small>{{ applyResult.changedPeopleCount }} 人五险一金变动，基数合计 {{ applyResult.baseTotal }}</small>
        <small v-if="applyResult.housingAmountTotal">
          公积金月缴存额合计 {{ applyResult.housingAmountTotal }}
        </small>
        <small v-if="applyResult.salaryApplied">工资表已回写 {{ applyResult.salaryApplied }} 人</small>
        <small v-if="applyResult.integratedApplied">在职工资已回写 {{ applyResult.integratedApplied }} 项</small>
        <small v-for="warning in applyResult.warnings" :key="warning" class="warning-line">
          {{ warning }}
        </small>
      </div>
    </section>

    <el-dialog v-model="previewVisible" title="社保基数 / 五险一金 回写预览" width="720px">
      <div v-if="preview" class="preview-body">
        <div class="preview-summary">
          数据源：{{ preview.dataSourceMode === 'salary-workbook' ? '工资表花名册' : '在职工资(一体化)' }}
          ｜ 参保 {{ preview.personCount }} 人 ｜ 五险一金变动 {{ preview.changedPeopleCount }} 人
          ｜ 基数合计 {{ preview.baseTotal }} ｜ 公积金合计 {{ preview.housingAmountTotal }}
        </div>
        <div class="preview-section">
          <strong>自动可写（{{ preview.autoChanges.length }} 项）</strong>
          <small>单批次/清零可直接写，无需选择。</small>
        </div>
        <div v-if="preview.manualChanges.length" class="preview-section">
          <strong>多批次需选目标批次（{{ preview.manualChanges.length }} 项，默认 001）</strong>
          <el-table :data="preview.manualChanges" size="small" max-height="260">
            <el-table-column prop="name" label="姓名" width="90" />
            <el-table-column prop="fieldName" label="字段" width="120" />
            <el-table-column prop="sourceValue" label="新值" width="90" />
            <el-table-column label="目标批次">
              <template #default="{ row }">
                <el-select v-model="batchChoice[manualKey(row)]" size="small" style="width: 100%">
                  <el-option
                    v-for="opt in (row as SocialBaseManualChange).batchOptions"
                    :key="opt.batchCode"
                    :label="`${opt.batchCode}（现 ${opt.currentValue}）`"
                    :value="opt.batchCode"
                  />
                </el-select>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <div v-if="missingPeople.length" class="preview-section">
          <strong class="warning-line">
            未匹配（{{ missingPeople.length }} 人，在职工资中无此人，不回写）
          </strong>
          <div class="missing-list">
            <span v-for="person in missingPeople" :key="person.idCard">
              {{ person.name }}（{{ person.idCard }}）
            </span>
          </div>
        </div>
        <div class="preview-section">
          <el-checkbox v-model="writeDatabase">回写到数据库在职工资（按批次）</el-checkbox>
          <small v-if="preview.canWriteSalaryWorkbook">勾选叠加：同时回写工资表花名册。</small>
          <small v-else>当前数据源无花名册文件，仅回写数据库 + 生成导入表/变动明细。</small>
        </div>
        <small v-for="warning in preview.warnings" :key="warning" class="warning-line">{{ warning }}</small>
      </div>
      <template #footer>
        <el-button @click="previewVisible = false">取消</el-button>
        <el-button type="primary" :loading="applyLoading" @click="confirmSocialBaseApply">
          确认并生成
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.annual-page {
  padding: 20px;
  color: #1f2937;
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

.file-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #475569;
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

.warning-line {
  color: #b45309;
}

.source-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid #edf2f7;
}

.source-hint {
  color: #94a3b8;
  font-size: 12px;
}

.preview-body {
  display: grid;
  gap: 14px;
}

.preview-summary {
  background: #f1f5f9;
  border-radius: 6px;
  padding: 10px 12px;
  color: #334155;
  font-size: 13px;
  line-height: 1.6;
}

.preview-section {
  display: grid;
  gap: 6px;
}

.preview-section small {
  color: #64748b;
}

.missing-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid #fde68a;
  border-radius: 6px;
  background: #fffbeb;
  font-size: 12px;
  color: #92400e;
}
</style>
