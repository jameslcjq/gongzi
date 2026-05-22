<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Calendar, FolderOpened, Upload } from '@element-plus/icons-vue'
import type {
  AnnualAdjustmentFilePick,
  IntegratedHistorySalaryPeriod,
  PerformancePayrollGenerateResult
} from '@shared/types'

const running = ref(false)
const defaultYear = new Date().getFullYear() - 1
const firstYear = ref(defaultYear)
const firstMonth = ref(2)
const secondYear = ref(defaultYear)
const secondMonth = ref(12)
const firstFile = ref<AnnualAdjustmentFilePick | null>(null)
const secondFile = ref<AnnualAdjustmentFilePick | null>(null)
const result = ref<PerformancePayrollGenerateResult | null>(null)

const yearOptions = Array.from({ length: 8 }, (_, index) => new Date().getFullYear() - 5 + index)
const monthOptions = Array.from({ length: 12 }, (_, index) => index + 1)

function firstPeriod(): IntegratedHistorySalaryPeriod {
  return { year: firstYear.value, month: firstMonth.value }
}

function secondPeriod(): IntegratedHistorySalaryPeriod {
  return { year: secondYear.value, month: secondMonth.value }
}

function formatPeriod(period: IntegratedHistorySalaryPeriod): string {
  return `${period.year}年${period.month}月`
}

function validatePeriods(): { first: IntegratedHistorySalaryPeriod; second: IntegratedHistorySalaryPeriod } | null {
  const first = firstPeriod()
  const second = secondPeriod()
  if (first.year === second.year && first.month === second.month) {
    ElMessage.warning('请选择两个不同月份')
    return null
  }
  return { first, second }
}

async function generateFromIntegrated(): Promise<void> {
  const periods = validatePeriods()
  if (!periods) return
  running.value = true
  result.value = null
  try {
    const next = await window.salaryApi.generatePerformancePayrollFromHistory({
      firstPeriod: periods.first,
      secondPeriod: periods.second
    })
    result.value = next
    ElMessage.success(`绩效工资已生成：${formatPeriod(periods.first)} → ${formatPeriod(periods.second)}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '绩效工资生成失败')
  } finally {
    running.value = false
  }
}

async function chooseLocalFile(which: 'first' | 'second'): Promise<void> {
  const file = await window.salaryApi.chooseAnnualAdjustmentFiles({
    title: which === 'first' ? '选择前月历史工资表' : '选择后月历史工资表',
    multi: false
  })
  if (!file?.[0]) return
  if (which === 'first') firstFile.value = file[0]
  else secondFile.value = file[0]
}

async function generateFromLocal(): Promise<void> {
  const periods = validatePeriods()
  if (!periods) return
  if (!firstFile.value || !secondFile.value) {
    ElMessage.warning('请先选择前月和后月两份历史工资表')
    return
  }

  running.value = true
  result.value = null
  try {
    const next = await window.salaryApi.generatePerformancePayrollFromLocal({
      firstPeriod: periods.first,
      secondPeriod: periods.second,
      firstWorkbookPath: firstFile.value.filePath,
      secondWorkbookPath: secondFile.value.filePath
    })
    result.value = next
    ElMessage.success(`绩效工资已生成：${formatPeriod(periods.first)} → ${formatPeriod(periods.second)}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '绩效工资生成失败')
  } finally {
    running.value = false
  }
}

async function openResult(): Promise<void> {
  if (!result.value?.filePath) return
  const error = await window.salaryApi.openLocalPath(result.value.filePath)
  if (error) ElMessage.error(`无法打开：${error}`)
}
</script>

<template>
  <section class="performance-page">
    <header class="performance-header">
      <div>
        <h1>绩效工资</h1>
        <p class="performance-warning">起始月份之前 退休/调出 人员请手动增加</p>
      </div>
    </header>

    <section class="performance-panel">
      <div class="period-grid">
        <label>
          <span>前月工资</span>
          <div class="month-selects">
            <el-select v-model="firstYear">
              <el-option v-for="year in yearOptions" :key="year" :label="`${year}年`" :value="year" />
            </el-select>
            <el-select v-model="firstMonth">
              <el-option v-for="month in monthOptions" :key="month" :label="`${month}月`" :value="month" />
            </el-select>
          </div>
        </label>
        <label>
          <span>后月工资</span>
          <div class="month-selects">
            <el-select v-model="secondYear">
              <el-option v-for="year in yearOptions" :key="year" :label="`${year}年`" :value="year" />
            </el-select>
            <el-select v-model="secondMonth">
              <el-option v-for="month in monthOptions" :key="month" :label="`${month}月`" :value="month" />
            </el-select>
          </div>
        </label>
        <el-button
          type="primary"
          :icon="Calendar"
          :loading="running"
          @click="generateFromIntegrated"
        >
          从一体化历史工资生成
        </el-button>
      </div>
      <p class="note">
        先打开一体化系统再操作
      </p>
    </section>

    <section class="performance-panel">
      <div class="local-grid">
        <label>
          <span>前月历史工资表</span>
          <el-button :icon="Upload" @click="chooseLocalFile('first')">
            {{ firstFile?.fileName || '选择文件' }}
          </el-button>
        </label>
        <label>
          <span>后月历史工资表</span>
          <el-button :icon="Upload" @click="chooseLocalFile('second')">
            {{ secondFile?.fileName || '选择文件' }}
          </el-button>
        </label>
        <el-button
          type="primary"
          plain
          :loading="running"
          @click="generateFromLocal"
        >
          从本地工资表生成
        </el-button>
      </div>
      <p class="note">
        未接一体化时使用。工资表会优先按表头识别字段；识别不到表头时兼容旧脚本的 G/H/M/N/O/P 列。
      </p>
    </section>

    <section v-if="result" class="result-panel">
      <div>
        <strong>已生成绩效工资表</strong>
        <p>输出 {{ result.rowCount }} 行，匹配 {{ result.matchedCount }} 人，晋级/小档 {{ result.changedCount }} 人。</p>
        <p v-if="result.firstMissingCount || result.secondMissingCount">
          前月缺 {{ result.firstMissingCount }} 人，后月缺 {{ result.secondMissingCount }} 人。
        </p>
        <p class="path">{{ result.filePath }}</p>
      </div>
      <el-button :icon="FolderOpened" @click="openResult">打开结果</el-button>
    </section>
  </section>
</template>

<style scoped>
.performance-page {
  flex: 1;
  min-width: 0;
  padding: 18px;
  background: var(--surface);
  overflow: auto;
}

.performance-header {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.performance-header h1 {
  margin: 0;
  color: var(--text);
  font-size: 20px;
  font-weight: 650;
}

.performance-header p {
  margin: 6px 0 0;
  color: var(--text-3);
  font-size: 13px;
}

.performance-warning {
  font-weight: 700;
  font-style: italic;
}

.performance-panel,
.result-panel {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.period-grid,
.local-grid {
  display: flex;
  align-items: end;
  gap: 10px;
  flex-wrap: wrap;
}

.period-grid label,
.local-grid label {
  display: grid;
  gap: 4px;
}

.period-grid label span,
.local-grid label span,
.note {
  color: var(--text-3);
  font-size: 12px;
}

.month-selects {
  display: flex;
  gap: 8px;
}

.month-selects .el-select:first-child {
  width: 116px;
}

.month-selects .el-select:last-child {
  width: 88px;
}

.note {
  margin: 10px 0 0;
}

.result-panel {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  border-color: var(--success);
  background: var(--success-soft);
}

.result-panel strong {
  color: var(--text);
  font-size: 14px;
}

.result-panel p {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 13px;
}

.result-panel .path {
  color: var(--text-3);
  word-break: break-all;
}
</style>
