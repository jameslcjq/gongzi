<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ImportBatchSummary, ImportPreview } from '@shared/types'

type WorksheetOption = { worksheetId: string; name: string }
const worksheetDisplayNames: Record<string, string> = {
  一体化在职: '在职工资',
  一体化退休: '退休工资',
  一体化其他: '其他工资'
}

function displayWorksheetName(name?: string) {
  if (!name) return ''
  return worksheetDisplayNames[name] ?? name
}

const props = defineProps<{
  modelValue: boolean
  worksheets: WorksheetOption[]
  preferredWorksheetId?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'imported', summary: ImportBatchSummary): void
}>()

const filePath = ref('')
const fileName = ref('')
const overrideWorksheetId = ref<string | undefined>(undefined)
const preview = ref<ImportPreview | null>(null)
const previewLoading = ref(false)
const committing = ref(false)
const batches = ref<ImportBatchSummary[]>([])
const batchesLoading = ref(false)

const previewableHeaderColumns = computed(() => preview.value?.matchedHeaders.map((m) => m.columnName) ?? [])
const hasUnknownHeaders = computed(() => Boolean(preview.value?.unknownHeaders.length))
const hasMissingUniqueKeys = computed(() => Boolean(preview.value?.diff?.missingKeyRows))

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      filePath.value = ''
      fileName.value = ''
      preview.value = null
      overrideWorksheetId.value = props.preferredWorksheetId
      void refreshBatches()
    }
  }
)

async function chooseFile() {
  const result = await window.salaryApi.chooseImportFile()
  if (!result) return
  filePath.value = result.filePath
  fileName.value = result.fileName
  await loadPreview()
}

async function loadPreview() {
  if (!filePath.value) return
  previewLoading.value = true
  preview.value = null
  try {
    const result = await window.salaryApi.previewImport(filePath.value, overrideWorksheetId.value)
    preview.value = result
    overrideWorksheetId.value = result.worksheetId
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '预览失败')
  } finally {
    previewLoading.value = false
  }
}

async function commit() {
  const current = preview.value
  if (!filePath.value || !current) return
  let confirmUpdates = false
  const diff = current.diff
  if (diff?.requiresConfirmation) {
    const examples = diff.examples
      .filter((item) => item.action === 'update')
      .slice(0, 5)
      .map((item) => {
        const fields = item.changes
          .slice(0, 4)
          .map((change) => `${change.fieldName}: ${formatPreviewValue(change.currentValue)} → ${formatPreviewValue(change.nextValue)}`)
          .join('；')
        return `${item.key}：${fields}`
      })
      .join('\n')
    try {
      await ElMessageBox.confirm(
        [
          `按${diff.uniqueFieldName ?? '唯一键'}比对，发现 ${diff.updatedRows} 行已有数据发生变化。`,
          `系统将只更新变化字段；${diff.unchangedRows} 行无变化会跳过，${diff.insertedRows} 行为新增。`,
          examples ? `\n示例：\n${examples}` : ''
        ].join('\n'),
        '确认更新已有数据',
        { type: 'warning', confirmButtonText: '确认更新字段', cancelButtonText: '取消' }
      )
      confirmUpdates = true
    } catch {
      return
    }
  }
  committing.value = true
  try {
    const summary = await window.salaryApi.commitImport(filePath.value, current.worksheetId, { confirmUpdates })
    ElMessage.success(`导入完成：${summary.rowCount} 行（批次 #${summary.id}）`)
    emit('imported', summary)
    await refreshBatches()
    filePath.value = ''
    fileName.value = ''
    preview.value = null
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '导入失败')
  } finally {
    committing.value = false
  }
}

function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '空'
  return String(value)
}

async function refreshBatches() {
  batchesLoading.value = true
  try {
    batches.value = await window.salaryApi.listImportBatches(20)
  } finally {
    batchesLoading.value = false
  }
}

async function rollback(batch: ImportBatchSummary) {
  try {
    await ElMessageBox.confirm(
      `确认回滚批次 #${batch.id}（${displayWorksheetName(batch.worksheetName)} ${batch.rowCount} 行）吗？`,
      '回滚导入批次',
      { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  try {
    const result = await window.salaryApi.rollbackImportBatch(batch.id)
    ElMessage.success(`已回滚 ${result.rowCount} 行`)
    emit('imported', result)
    await refreshBatches()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '回滚失败')
  }
}

function close() {
  emit('update:modelValue', false)
}

const statusTag = (status: ImportBatchSummary['status']) => {
  if (status === 'imported') return { type: 'success' as const, label: '已导入' }
  if (status === 'rolled-back') return { type: 'info' as const, label: '已回滚' }
  return { type: 'danger' as const, label: '失败' }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="Excel 导入"
    width="980px"
    :close-on-click-modal="false"
    @update:model-value="close"
  >
    <div class="import-dialog">
      <div class="import-toolbar">
        <el-button type="primary" @click="chooseFile">选择 Excel 文件</el-button>
        <el-select
          v-model="overrideWorksheetId"
          placeholder="目标工作表"
          style="width: 220px"
          @change="loadPreview"
        >
          <el-option
            v-for="item in worksheets"
            :key="item.worksheetId"
            :label="item.name"
            :value="item.worksheetId"
          />
        </el-select>
        <span v-if="fileName" class="import-filename">{{ fileName }}</span>
      </div>

      <el-alert
        v-if="preview && preview.unknownHeaders.length"
        type="error"
        show-icon
        :closable="false"
        :title="`发现 ${preview.unknownHeaders.length} 个系统未登记字段，已暂停导入`"
        :description="`请先到「${displayWorksheetName(preview.worksheetName)} - 字段结构」中新增字段后再重新导入：${preview.unknownHeaders.join('、')}`"
        style="margin-bottom: 12px"
      />

      <div v-if="preview" class="preview-meta">
        目标：<strong>{{ displayWorksheetName(preview.worksheetName) }}</strong>
        共 {{ preview.totalRows }} 行，已匹配 {{ preview.matchedHeaders.length }} 列
      </div>

      <el-alert
        v-if="preview?.diff"
        :type="preview.diff.missingKeyRows || preview.diff.updatedRows > 0 ? 'warning' : 'success'"
        show-icon
        :closable="false"
        style="margin-bottom: 12px"
      >
        <template #title>
          按{{ preview.diff.uniqueFieldName || '唯一键' }}比对：
          新增 {{ preview.diff.insertedRows }} 行，
          更新 {{ preview.diff.updatedRows }} 行，
          无变化跳过 {{ preview.diff.unchangedRows }} 行
          <span v-if="preview.diff.missingKeyRows">，缺少唯一键 {{ preview.diff.missingKeyRows }} 行</span>
        </template>
      </el-alert>

      <el-table
        v-if="preview && preview.rows.length"
        v-loading="previewLoading"
        :data="preview.rows"
        border
        stripe
        height="280"
        size="small"
      >
        <el-table-column prop="rowNumber" label="行" width="70" fixed />
        <el-table-column
          v-for="header in preview.matchedHeaders"
          :key="header.columnName"
          :label="header.fieldName"
          min-width="140"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            {{ row.values[header.columnName] }}
          </template>
        </el-table-column>
        <el-table-column label="提示" min-width="120" fixed="right">
          <template #default="{ row }">
            <span v-if="row.warnings.length" class="warning-text">{{ row.warnings.join('；') }}</span>
            <span v-else class="muted-text">-</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-else-if="preview" v-loading="previewLoading" class="empty-panel">
        <strong>没有可预览的行</strong>
      </div>

      <div class="import-actions">
        <el-button :disabled="!preview || hasUnknownHeaders || hasMissingUniqueKeys || committing" type="primary" :loading="committing" @click="commit">
          确认导入
        </el-button>
        <span class="muted-text">导入后可在下方批次列表里回滚</span>
      </div>

      <el-divider />

      <div class="batches-heading">
        <strong>导入批次（最近 20）</strong>
        <el-button text :loading="batchesLoading" @click="refreshBatches">刷新</el-button>
      </div>

      <el-table :data="batches" border size="small" height="240">
        <el-table-column prop="id" label="#" width="70" />
        <el-table-column label="工作表" min-width="140">
          <template #default="{ row }">{{ displayWorksheetName(row.worksheetName) }}</template>
        </el-table-column>
        <el-table-column prop="sourceName" label="来源文件" min-width="180" show-overflow-tooltip />
        <el-table-column prop="rowCount" label="行数" width="80" align="right" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status).type">
              {{ statusTag(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="时间" min-width="190" />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'imported'"
              size="small"
              type="danger"
              text
              @click="rollback(row)"
            >
              回滚
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <template #footer>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.import-dialog {
  display: grid;
  gap: 12px;
}

.import-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
}

.import-filename {
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 12px;
}

.preview-meta {
  color: var(--text-2);
  font-size: 13px;
}

.import-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.muted-text {
  color: var(--text-muted);
  font-size: 12px;
}

.warning-text {
  color: var(--warn);
}

.batches-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
