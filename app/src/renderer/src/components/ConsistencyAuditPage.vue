<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Refresh, Upload } from '@element-plus/icons-vue'
import type {
  ConsistencyAuditApplyDirection,
  ConsistencyAuditIssue,
  ConsistencyAuditResult
} from '@shared/types'

const loading = ref(false)
const applying = ref(false)
const result = ref<ConsistencyAuditResult | null>(null)
const search = ref('')
const fieldFilter = ref('')
const selectedIssues = ref<ConsistencyAuditIssue[]>([])

const fieldOptions = computed(() => result.value?.rules ?? [])

const filteredIssues = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return (result.value?.issues ?? []).filter((issue) => {
    if (fieldFilter.value && issue.fieldKey !== fieldFilter.value) return false
    if (!keyword) return true
    return [
      issue.name,
      issue.idCard,
      issue.fieldLabel,
      issue.master?.value,
      issue.source.worksheetName,
      issue.source.fieldName,
      issue.source.value
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword))
  })
})

onMounted(() => {
  void runAudit()
})

async function runAudit(): Promise<void> {
  loading.value = true
  try {
    result.value = await window.salaryApi.runConsistencyAudit()
    selectedIssues.value = []
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '一致性审计失败')
  } finally {
    loading.value = false
  }
}

async function applySelected(direction: ConsistencyAuditApplyDirection): Promise<void> {
  const issues = selectedIssues.value.filter((issue) => issue.severity === 'warning' && issue.master)
  if (issues.length === 0) {
    ElMessage.warning('请先选择可更新的不一致记录')
    return
  }

  const actionText = direction === 'source-to-master' ? '用来源值更新人事信息' : '用人事信息回写来源表'
  try {
    await ElMessageBox.confirm(`确认${actionText}？将处理选中的 ${issues.length} 项差异。`, '确认更新', {
      type: 'warning',
      confirmButtonText: '确认更新',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  applying.value = true
  try {
    const payload = issues.map((issue) => JSON.parse(JSON.stringify(issue)) as ConsistencyAuditIssue)
    const summary = await window.salaryApi.applyConsistencyAudit(direction, payload)
    ElMessage.success(summary.messages.join('；'))
    await runAudit()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '更新失败')
  } finally {
    applying.value = false
  }
}

function handleSelectionChange(rows: ConsistencyAuditIssue[]): void {
  selectedIssues.value = rows
}

function displayValue(value: string | undefined): string {
  return value ? value : '空'
}

function rowClassName({ row }: { row: ConsistencyAuditIssue }): string {
  return row.severity === 'error' ? 'audit-row-error' : ''
}
</script>

<template>
  <section class="audit-page">
    <header class="audit-header">
      <div>
        <h2>全局一致性审计</h2>
        <span v-if="result">主表：{{ result.masterWorksheetName }}</span>
      </div>
      <el-button type="primary" :loading="loading" @click="runAudit">
        <el-icon><Refresh /></el-icon>
        重新审计
      </el-button>
    </header>

    <div class="audit-metrics">
      <div class="audit-metric">
        <span>主表人数</span>
        <strong>{{ result?.checkedPeople ?? 0 }}</strong>
      </div>
      <div class="audit-metric">
        <span>已比对项</span>
        <strong>{{ result?.comparedCells ?? 0 }}</strong>
      </div>
      <div class="audit-metric">
        <span>问题数</span>
        <strong>{{ result?.issueCount ?? 0 }}</strong>
      </div>
      <div class="audit-metric">
        <span>主表缺失</span>
        <strong>{{ result?.missingMasterRows ?? 0 }}</strong>
      </div>
    </div>

    <div class="audit-controls">
      <el-select v-model="fieldFilter" clearable placeholder="全部字段">
        <el-option
          v-for="field in fieldOptions"
          :key="field.fieldKey"
          :label="`${field.fieldLabel}（${field.issueCount}）`"
          :value="field.fieldKey"
        />
      </el-select>
      <el-button
        :disabled="selectedIssues.length === 0"
        :loading="applying"
        @click="applySelected('source-to-master')"
      >
        <el-icon><Upload /></el-icon>
        来源值更新人事信息
      </el-button>
      <el-button
        :disabled="selectedIssues.length === 0"
        :loading="applying"
        @click="applySelected('master-to-source')"
      >
        <el-icon><Download /></el-icon>
        人事信息回写来源表
      </el-button>
      <el-input v-model="search" clearable placeholder="搜索姓名、身份证号、来源表或字段值" />
    </div>

    <el-table
      v-loading="loading"
      :data="filteredIssues"
      border
      stripe
      height="calc(100vh - 326px)"
      size="small"
      :row-class-name="rowClassName"
      empty-text="未发现不一致"
      @selection-change="handleSelectionChange"
    >
      <el-table-column type="selection" width="42" />
      <el-table-column prop="severity" label="类型" width="86">
        <template #default="{ row }">
          <el-tag :type="row.severity === 'error' ? 'danger' : 'warning'" size="small">
            {{ row.severity === 'error' ? '缺失' : '不一致' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="fieldLabel" label="字段" width="130" show-overflow-tooltip />
      <el-table-column prop="name" label="姓名" width="110" show-overflow-tooltip />
      <el-table-column prop="idCard" label="身份证号" width="190" show-overflow-tooltip />
      <el-table-column label="人事信息" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ displayValue(row.master?.value) }}</template>
      </el-table-column>
      <el-table-column prop="source.worksheetName" label="来源表" width="140" show-overflow-tooltip />
      <el-table-column prop="source.fieldName" label="来源字段" width="150" show-overflow-tooltip />
      <el-table-column label="来源值" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ displayValue(row.source.value) }}</template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.audit-page {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 18px;
  background: #f6f8fb;
}

.audit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.audit-header h2 {
  margin: 0;
  color: #172033;
  font-size: 20px;
  font-weight: 700;
}

.audit-header span {
  display: inline-block;
  margin-top: 4px;
  color: #667085;
  font-size: 13px;
}

.audit-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.audit-metric {
  padding: 12px 14px;
  border: 1px solid #dde4ef;
  border-radius: 8px;
  background: #fff;
}

.audit-metric span {
  display: block;
  color: #667085;
  font-size: 12px;
}

.audit-metric strong {
  display: block;
  margin-top: 4px;
  color: #172033;
  font-size: 24px;
  line-height: 1.1;
}

.audit-controls {
  display: grid;
  grid-template-columns: 220px auto auto minmax(260px, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}

:deep(.audit-row-error) {
  --el-table-tr-bg-color: #fff5f5;
}

@media (max-width: 900px) {
  .audit-metrics {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }

  .audit-controls {
    grid-template-columns: 1fr;
  }
}
</style>
