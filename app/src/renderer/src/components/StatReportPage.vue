<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Refresh, Search } from '@element-plus/icons-vue'
import type {
  StatReportColumn,
  StatReportDef,
  StatReportDrillResult,
  StatReportResult,
  StatReportRow
} from '@shared/types'

const reports = ref<StatReportDef[]>([])
const selectedId = ref('')
const result = ref<StatReportResult | null>(null)
const loading = ref(false)
const exportLoading = ref(false)
const drillLoading = ref(false)
const drillVisible = ref(false)
const drillResult = ref<StatReportDrillResult | null>(null)

const groupedReports = computed(() => {
  const groups = new Map<string, StatReportDef[]>()
  for (const report of reports.value) {
    groups.set(report.category, [...(groups.get(report.category) ?? []), report])
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }))
})

const selectedReport = computed(() =>
  reports.value.find((report) => report.id === selectedId.value)
)

onMounted(async () => {
  reports.value = await window.salaryApi.listStatReports()
  if (!selectedId.value && reports.value.length > 0) {
    selectedId.value = reports.value[0].id
    await runSelectedReport()
  }
})

async function selectReport(report: StatReportDef) {
  if (selectedId.value === report.id) return
  selectedId.value = report.id
  await runSelectedReport()
}

async function runSelectedReport() {
  if (!selectedId.value) return
  loading.value = true
  try {
    result.value = await window.salaryApi.runStatReport(selectedId.value)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '统计报表生成失败')
  } finally {
    loading.value = false
  }
}

async function exportCurrentReport() {
  if (!result.value) return
  exportLoading.value = true
  try {
    const exported = await window.salaryApi.exportStatReport(result.value)
    ElMessage.success(`已导出 ${exported.rowCount} 行：${exported.filePath}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '统计报表导出失败')
  } finally {
    exportLoading.value = false
  }
}

async function drill(row: StatReportRow, column: StatReportColumn) {
  const value = Number(row.values[column.key] ?? 0)
  if (!Number.isFinite(value) || value <= 0) return
  drillLoading.value = true
  drillVisible.value = true
  try {
    drillResult.value = await window.salaryApi.drillStatReport(
      JSON.parse(JSON.stringify(row.filter ?? [])),
      String(row.filterDesc ?? row.label ?? ''),
      String(column.key ?? ''),
      String(column.label ?? '')
    )
  } catch (error) {
    drillVisible.value = false
    ElMessage.error(error instanceof Error ? error.message : '明细钻取失败')
  } finally {
    drillLoading.value = false
  }
}

function valueOf(row: StatReportRow, key: string): string | number {
  return row.values[key] ?? ''
}
</script>

<template>
  <div class="stat-page">
    <aside class="stat-sidebar">
      <div class="stat-sidebar-head">
        <strong>统计报表</strong>
        <span>来源：人事信息</span>
      </div>
      <div class="stat-report-list">
        <section
          v-for="group in groupedReports"
          :key="group.category"
          class="stat-report-group"
        >
          <div class="stat-report-group-title">{{ group.category }}</div>
          <button
            v-for="report in group.items"
            :key="report.id"
            class="stat-report-item"
            :class="{ active: selectedId === report.id }"
            @click="selectReport(report)"
          >
            <strong>{{ report.name }}</strong>
            <span>{{ report.description }}</span>
          </button>
        </section>
      </div>
    </aside>

    <main class="stat-main">
      <div class="stat-toolbar">
        <div>
          <h2>{{ result?.name || selectedReport?.name || '统计报表' }}</h2>
          <p>固定统计口径只读取人事信息主表，不混用一体化、预算或附表数据。</p>
        </div>
        <div class="stat-actions">
          <el-button :icon="Refresh" :loading="loading" @click="runSelectedReport">
            重新统计
          </el-button>
          <el-button
            type="primary"
            :icon="Download"
            :loading="exportLoading"
            :disabled="!result"
            @click="exportCurrentReport"
          >
            导出
          </el-button>
        </div>
      </div>

      <div v-if="result" class="stat-summary">
        <span>生成时间：{{ result.generatedAt }}</span>
        <span>数据行数：{{ result.dataCount }}</span>
        <span>数据源：人事信息</span>
      </div>

      <div class="stat-table-wrap">
        <el-table
          v-if="result"
          v-loading="loading"
          :data="result.rows"
          border
          stripe
          height="100%"
          size="small"
        >
          <el-table-column fixed prop="label" label="项目" min-width="220">
            <template #default="{ row }">
              <span
                class="stat-row-label"
                :class="{ total: row.isTotal, section: row.isSectionHeader }"
                :style="{ paddingLeft: `${row.indent * 18}px` }"
              >
                {{ row.label }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            v-for="column in result.columns"
            :key="column.key"
            :label="column.label"
            :width="column.width"
            align="right"
          >
            <template #default="{ row }">
              <button
                class="stat-value-btn"
                :disabled="Number(valueOf(row, column.key) || 0) <= 0"
                @click="drill(row, column)"
              >
                {{ valueOf(row, column.key) }}
              </button>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="stat-empty">
          <el-icon><Search /></el-icon>
          <span>选择左侧报表开始统计</span>
        </div>
      </div>
    </main>

    <el-dialog
      v-model="drillVisible"
      title="统计明细"
      width="1180px"
      :close-on-click-modal="false"
    >
      <div class="stat-drill-head">
        <span>{{ drillResult?.filterDesc }}</span>
        <strong>{{ drillResult?.totalRows ?? 0 }} 人</strong>
      </div>
      <el-table
        v-loading="drillLoading"
        :data="drillResult?.rows ?? []"
        border
        stripe
        height="520"
        size="small"
      >
        <el-table-column
          v-for="field in drillResult?.fields ?? []"
          :key="field"
          :prop="field"
          :label="field"
          min-width="130"
          show-overflow-tooltip
        />
      </el-table>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-page {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  background: var(--bg);
}

.stat-sidebar {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.stat-sidebar-head {
  display: grid;
  gap: 2px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.stat-sidebar-head strong {
  font-size: 15px;
}

.stat-sidebar-head span {
  color: var(--text-3);
  font-size: 12px;
}

.stat-report-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 0;
}

.stat-report-group {
  display: grid;
  gap: 4px;
  margin-bottom: 10px;
}

.stat-report-group-title {
  padding: 6px 16px 4px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.stat-report-item {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 9px 16px;
  border: 0;
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.stat-report-item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.stat-report-item.active {
  border-left-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary-text);
}

.stat-report-item strong {
  font-size: 13px;
  font-weight: 600;
}

.stat-report-item span {
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.4;
}

.stat-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}

.stat-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.stat-toolbar h2 {
  margin: 0;
  font-size: 17px;
  line-height: 1.4;
}

.stat-toolbar p {
  margin: 2px 0 0;
  color: var(--text-3);
  font-size: 12.5px;
}

.stat-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.stat-summary {
  display: flex;
  gap: 18px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--border);
  color: var(--text-3);
  font-size: 12px;
  flex-shrink: 0;
}

.stat-table-wrap {
  flex: 1;
  min-height: 0;
  padding: 12px 16px 16px;
}

.stat-row-label {
  display: inline-block;
  color: var(--text-2);
}

.stat-row-label.total {
  color: var(--text);
  font-weight: 700;
}

.stat-row-label.section {
  color: var(--text-muted);
}

.stat-value-btn {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--primary);
  text-align: right;
  cursor: pointer;
  font: inherit;
}

.stat-value-btn:disabled {
  color: var(--text-muted);
  cursor: default;
}

.stat-empty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-muted);
}

.stat-drill-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
  color: var(--text-2);
}
</style>
