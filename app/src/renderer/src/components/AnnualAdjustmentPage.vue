<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type {
  AnnualAdjustmentFilePick,
  ImportWatcherStatus,
  PersonalTaxImportGenerateResult,
  SocialInsuranceBaseExportResult
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
const socialBaseResult = ref<SocialInsuranceBaseExportResult | null>(null)
const taxLoading = ref(false)
const socialBaseLoading = ref(false)

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

const socialBaseFormulaFields = ['岗位工资', '薪级工资', '教（工）龄补贴', '岗位津贴', '生活补贴']

const detectedFiles = computed(() => props.importWatcher?.annualAdjustment)

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

async function generateSocialInsuranceBase() {
  socialBaseLoading.value = true
  try {
    const next = await window.salaryApi.exportSocialInsuranceBase({
      templateWorkbookPath:
        socialBaseTemplateFile.value?.filePath ?? detectedFiles.value?.socialBaseTemplateWorkbookPath,
      salaryWorkbookPath: detectedFiles.value?.salaryWorkbookPath,
      housingAccountWorkbookPath: detectedFiles.value?.housingAccountWorkbookPath,
      insuranceDetailWorkbookPaths: [...(detectedFiles.value?.insuranceDetailWorkbookPaths ?? [])],
      baseFields: [...socialBaseFormulaFields]
    })
    socialBaseResult.value = next
    const messages = [`社保基数 ${next.rowCount} 人`]
    if (next.housingDeclarationPath) messages.push(`公积金导入 ${next.housingRowCount ?? next.rowCount} 人`)
    if (next.salaryApplied) messages.push(`工资表回写 ${next.salaryApplied} 人`)
    ElMessage.success(`已生成：${messages.join('，')}`)
    await openOutputFolder(
      next.housingDeclarationPath ||
      next.salaryBackupPath ||
      next.salaryOutputPath ||
      next.filePath
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生成社保、公积金文件失败')
  } finally {
    socialBaseLoading.value = false
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
        <h2>导出社保、公积金</h2>
        <el-button type="primary" :loading="socialBaseLoading" @click="generateSocialInsuranceBase">
          生成公积金导入、社保基数
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
      <div v-if="socialBaseResult" class="output-list">
        <button @click="openPath(socialBaseResult.filePath)">
          社保基数：{{ socialBaseResult.filePath }}
        </button>
        <button
          v-if="socialBaseResult.housingDeclarationPath"
          @click="openPath(socialBaseResult.housingDeclarationPath)"
        >
          公积金导入：{{ socialBaseResult.housingDeclarationPath }}
        </button>
        <button
          v-if="socialBaseResult.salaryOutputPath"
          @click="openPath(socialBaseResult.salaryOutputPath)"
        >
          工资表：{{ socialBaseResult.salaryOutputPath }}
        </button>
        <button
          v-if="socialBaseResult.salaryBackupPath"
          @click="openPath(socialBaseResult.salaryBackupPath)"
        >
          原始备份：{{ socialBaseResult.salaryBackupPath }}
        </button>
        <button
          v-if="socialBaseResult.housingMissingLogPath"
          @click="openPath(socialBaseResult.housingMissingLogPath)"
        >
          未查到账号：{{ socialBaseResult.housingMissingLogPath }}
        </button>
        <small>{{ socialBaseResult.rowCount }} 人，基数合计 {{ socialBaseResult.baseTotal }}</small>
        <small v-if="socialBaseResult.housingDeclarationPath">
          公积金 {{ socialBaseResult.housingRowCount }} 人，月缴存额合计 {{ socialBaseResult.housingAmountTotal }}
        </small>
        <small v-if="socialBaseResult.salaryApplied">
          工资表已回写 {{ socialBaseResult.salaryApplied }} 人
        </small>
        <small v-for="warning in (socialBaseResult.warnings || [])" :key="warning" class="warning-line">
          {{ warning }}
        </small>
      </div>
    </section>
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
</style>
