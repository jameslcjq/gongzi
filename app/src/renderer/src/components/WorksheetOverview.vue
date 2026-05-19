<script setup lang="ts">
type WorksheetRow = {
  name: string
  worksheetId: string
  fieldCount: number
  viewCount: number
}

const props = defineProps<{
  worksheets: WorksheetRow[]
  selectedWorksheetId?: string
}>()

const emit = defineEmits<{
  select: [worksheetId: string]
}>()

function getRowClassName({ row }: { row: WorksheetRow }): string {
  return row.worksheetId === props.selectedWorksheetId ? 'is-selected-row' : ''
}

function handleRowClick(row: WorksheetRow): void {
  emit('select', row.worksheetId)
}
</script>

<template>
  <section class="worksheet-section">
    <div class="section-heading">
      <h2>保留工作表</h2>
      <span>{{ worksheets.length }} 张</span>
    </div>

    <el-table
      :data="worksheets"
      border
      stripe
      height="calc(100vh - 318px)"
      highlight-current-row
      :row-class-name="getRowClassName"
      @row-click="handleRowClick"
    >
      <el-table-column prop="name" label="工作表" min-width="180" fixed />
      <el-table-column prop="fieldCount" label="字段数" width="100" align="right" />
      <el-table-column prop="viewCount" label="视图数" width="100" align="right" />
      <el-table-column prop="worksheetId" label="worksheetId" min-width="280" />
      <el-table-column label="状态" width="120">
        <template #default>
          <el-tag type="success" effect="plain">已建表</el-tag>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>
