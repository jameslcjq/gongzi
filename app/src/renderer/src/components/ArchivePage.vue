<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { LookupFailureEntry, PersonnelArchiveEntry } from '@shared/types'

type ArchiveTab = 'transferred-out' | 'deceased' | 'lookup-failures'

const activeTab = ref<ArchiveTab>('transferred-out')
const search = ref('')
const page = ref(1)
const pageSize = 50
const loading = ref(false)
const total = ref(0)

const archiveRows = ref<PersonnelArchiveEntry[]>([])
const failureRows = ref<LookupFailureEntry[]>([])
const detailVisible = ref(false)
const detailRow = ref<PersonnelArchiveEntry | null>(null)

const tabs: Array<{ key: ArchiveTab; label: string }> = [
  { key: 'transferred-out', label: '调出人员' },
  { key: 'deceased', label: '去世人员' },
  { key: 'lookup-failures', label: '查询失败日志' }
]

const isFailureTab = computed(() => activeTab.value === 'lookup-failures')

watch([activeTab, page, search], () => {
  void load()
})

watch(activeTab, () => {
  page.value = 1
  search.value = ''
})

onMounted(() => {
  void load()
})

async function load(): Promise<void> {
  loading.value = true
  try {
    if (isFailureTab.value) {
      const result = await window.salaryApi.listLookupFailures({
        search: search.value || undefined,
        limit: pageSize,
        offset: (page.value - 1) * pageSize
      })
      failureRows.value = result.rows
      total.value = result.total
    } else {
      const result = await window.salaryApi.listPersonnelArchive({
        archiveType: activeTab.value === 'transferred-out' ? '调出' : '去世',
        search: search.value || undefined,
        limit: pageSize,
        offset: (page.value - 1) * pageSize
      })
      archiveRows.value = result.rows
      total.value = result.total
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    loading.value = false
  }
}

function showDetail(row: PersonnelArchiveEntry): void {
  detailRow.value = row
  detailVisible.value = true
}

async function clearFailures(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定清空所有查询失败日志？', '提示', {
      type: 'warning'
    })
  } catch {
    return
  }
  const removed = await window.salaryApi.clearLookupFailures()
  ElMessage.success(`已清空 ${removed} 条`)
  page.value = 1
  await load()
}

const detailEntries = computed(() => {
  if (!detailRow.value) return [] as Array<[string, string]>
  return Object.entries(detailRow.value.originalData).map(([key, value]) => [
    key,
    value === null || value === undefined ? '' : String(value)
  ]) as Array<[string, string]>
})
</script>

<template>
  <div class="archive-page">
    <header class="archive-header">
      <h2>归档与日志</h2>
      <div class="archive-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="archive-tab"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
    </header>

    <div class="archive-toolbar">
      <el-button v-if="isFailureTab" type="danger" plain @click="clearFailures">
        清空日志
      </el-button>
      <span class="archive-total">共 {{ total }} 条</span>
      <el-input
        v-model="search"
        placeholder="按身份证 / 姓名 / 单位搜索"
        clearable
        style="width: 280px"
      />
    </div>

    <div v-loading="loading" class="archive-table">
      <el-table v-if="!isFailureTab" :data="archiveRows" stripe height="100%">
        <el-table-column prop="archivedAt" label="归档时间" width="180" />
        <el-table-column prop="sourceWorksheet" label="原表" width="120" />
        <el-table-column prop="idCard" label="证件号码" width="200" />
        <el-table-column prop="name" label="姓名" width="120" />
        <el-table-column prop="unitCode" label="单位编码" width="120" />
        <el-table-column prop="unitName" label="单位名称" min-width="200" />
        <el-table-column prop="reason" label="归档原因" min-width="220" />
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button link type="primary" @click="showDetail(row)">查看详情</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-table v-else :data="failureRows" stripe height="100%">
        <el-table-column prop="createdAt" label="时间" width="180" />
        <el-table-column prop="workflow" label="工作流" width="200" />
        <el-table-column prop="worksheet" label="工作表" width="120" />
        <el-table-column prop="idCard" label="证件号码" width="200" />
        <el-table-column prop="name" label="姓名" width="120" />
        <el-table-column prop="lookupTable" label="查询表" width="140" />
        <el-table-column prop="lookupKey" label="查询键" width="140" />
        <el-table-column prop="lookupValue" label="查询值" width="120" />
        <el-table-column prop="reason" label="原因" min-width="240" />
      </el-table>
    </div>

    <div class="archive-pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next, total"
        background
      />
    </div>

    <el-dialog v-model="detailVisible" title="原始数据" width="720px">
      <el-descriptions v-if="detailRow" :column="2" border size="small">
        <el-descriptions-item v-for="[key, value] in detailEntries" :key="key" :label="key">
          {{ value }}
        </el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<style scoped>
.archive-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 24px;
  gap: 12px;
  background: var(--surface);
}
.archive-header {
  display: flex;
  align-items: center;
  gap: 20px;
}
.archive-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}
.archive-tabs {
  display: flex;
  gap: 2px;
}
.archive-tab {
  padding: 0 14px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-2);
  font: inherit;
  transition: background 0.12s;
}
.archive-tab:hover {
  background: var(--gray-soft);
}
.archive-tab.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
  font-weight: 500;
}
.archive-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.archive-total {
  margin-left: auto;
  color: var(--text-3);
  font-size: 12px;
  font-family: var(--mono);
}
.archive-table {
  flex: 1;
  min-height: 0;
}
.archive-pagination {
  display: flex;
  justify-content: flex-end;
}
</style>
