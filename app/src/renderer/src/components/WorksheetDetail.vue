<script setup lang="ts">
import { computed, ref } from 'vue'
import { Delete, Edit, Plus } from '@element-plus/icons-vue'
import type { WorksheetField, WorksheetRecord, WorksheetRecordsResult } from '@shared/types'

const props = defineProps<{
  worksheet?: {
    name: string
    worksheetId: string
    fieldCount: number
    viewCount: number
    fields: WorksheetField[]
  }
  records?: WorksheetRecordsResult | null
  recordsLoading?: boolean
}>()

const emit = defineEmits<{
  (event: 'create'): void
  (event: 'edit', record: WorksheetRecord): void
  (event: 'delete', record: WorksheetRecord): void
}>()

const activeTab = ref('rows')

const visibleFields = computed(() =>
  (props.worksheet?.fields ?? [])
    .map((field, index) => ({ ...field, displayOrder: field.displayOrder ?? index }))
    .filter((field) => !field.hidden)
    .sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0))
)

function localColumnNames(fields: WorksheetField[]): Map<string, string> {
  const used = new Map<string, number>()
  const result = new Map<string, string>()
  for (const field of fields) {
    const baseName = field.name || field.fieldId
    const count = used.get(baseName) ?? 0
    used.set(baseName, count + 1)
    result.set(field.fieldId, count === 0 ? baseName : `${baseName}_${count + 1}`)
  }
  return result
}

const fieldColumnNames = computed(() => localColumnNames(props.worksheet?.fields ?? []))

function columnNameOf(fieldId: string): string {
  return fieldColumnNames.value.get(fieldId) ?? fieldId
}
</script>

<template>
  <section class="worksheet-detail">
    <template v-if="worksheet">
      <div class="detail-heading">
        <div>
          <h2>{{ worksheet.name }}</h2>
          <p>{{ worksheet.worksheetId }}</p>
        </div>
        <div class="detail-tags">
          <el-tag effect="plain">{{ worksheet.fieldCount }} 个字段</el-tag>
          <el-tag effect="plain" type="info">{{ worksheet.viewCount }} 个视图</el-tag>
          <el-tag effect="plain" type="success">{{ records?.total ?? 0 }} 条记录</el-tag>
        </div>
      </div>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="字段结构" name="fields">
          <el-table :data="worksheet.fields" border stripe height="calc(100vh - 360px)">
            <el-table-column prop="name" label="字段名称" min-width="180" fixed />
            <el-table-column label="显示" width="90" align="center">
              <template #default="{ row }">{{ row.hidden ? '隐藏' : '显示' }}</template>
            </el-table-column>
            <el-table-column prop="type" label="类型" width="140" />
            <el-table-column prop="controlType" label="控件编号" width="110" align="right" />
            <el-table-column prop="desc" label="说明" min-width="170" />
            <el-table-column prop="fieldId" label="字段ID" min-width="260" />
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="数据记录" name="rows">
          <div class="rows-toolbar">
            <el-button type="primary" :icon="Plus" @click="emit('create')">新增</el-button>
            <span class="rows-toolbar-hint">
              共 {{ records?.total ?? 0 }} 条，显示前 {{ records?.rows.length ?? 0 }} 条
            </span>
          </div>

          <el-table
            v-if="records?.rows.length"
            v-loading="recordsLoading"
            :data="records.rows"
            border
            stripe
            height="calc(100vh - 420px)"
          >
            <el-table-column prop="id" label="ID" width="80" fixed />
            <el-table-column
              v-for="field in visibleFields"
              :key="field.fieldId"
              :prop="columnNameOf(field.fieldId)"
              :label="field.name"
              min-width="150"
              show-overflow-tooltip
            />
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <div class="row-actions-inline">
                  <el-button size="small" plain type="primary" :icon="Edit" @click="emit('edit', row)">编辑</el-button>
                  <el-button size="small" plain type="danger" :icon="Delete" @click="emit('delete', row)">删除</el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div v-else v-loading="recordsLoading" class="empty-panel">
            <strong>暂无数据</strong>
            <span>点击上方"新增"录入第一条，或在导入面板里把 Excel 放进监听文件夹自动入库。</span>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>

    <div v-else class="empty-panel">
      <strong>选择一张工作表</strong>
      <span>从左侧导航或工作表总览中选择，查看字段结构和本地记录。</span>
    </div>
  </section>
</template>

<style scoped>
.row-actions-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  white-space: nowrap;
}

.row-actions-inline .el-button {
  margin-left: 0;
}
</style>
