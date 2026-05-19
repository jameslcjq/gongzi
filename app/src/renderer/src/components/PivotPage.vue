<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Document, Download, Plus, Refresh } from '@element-plus/icons-vue'
import type {
  AppSummary,
  PivotAggregation,
  PivotConfig,
  PivotFilterOp,
  PivotResult,
  WorksheetField
} from '@shared/types'

const props = defineProps<{
  summary: AppSummary | null
  sourceWorksheetId?: string
}>()

type PivotConfigSummary = {
  id: number
  name: string
  primaryWorksheetId: string
  primaryWorksheetName: string
  createdAt: string
  updatedAt: string
}

const aggregationOptions: Array<{ value: PivotAggregation; label: string }> = [
  { value: 'sum', label: '求和' },
  { value: 'count', label: '计数' },
  { value: 'count_distinct', label: '去重计数' },
  { value: 'avg', label: '平均' },
  { value: 'max', label: '最大' },
  { value: 'min', label: '最小' }
]

const filterOpOptions: Array<{ value: PivotFilterOp; label: string }> = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'is_null', label: '为空' },
  { value: 'not_null', label: '不为空' },
  { value: 'between', label: '区间' },
  { value: 'in', label: '在集合内' }
]

const configs = ref<PivotConfigSummary[]>([])
const configsLoading = ref(false)
const editing = reactive<PivotConfig>(emptyConfig())
const result = ref<PivotResult | null>(null)
const running = ref(false)
const saving = ref(false)
const exporting = ref(false)

const worksheets = computed(() => {
  const all = props.summary?.worksheets ?? []
  if (!props.sourceWorksheetId) return all
  return all.filter((worksheet) => worksheet.worksheetId === props.sourceWorksheetId)
})
const primaryWorksheet = computed(() =>
  worksheets.value.find((item) => item.worksheetId === editing.primaryWorksheetId)
)
const visibleConfigs = computed(() => {
  if (!props.sourceWorksheetId) return configs.value
  return configs.value.filter((config) => config.primaryWorksheetId === props.sourceWorksheetId)
})
const joinedWorksheets = computed(() =>
  editing.joins
    .map((join) => worksheets.value.find((item) => item.worksheetId === join.worksheetId))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
)
const availableWorksheets = computed(() =>
  [primaryWorksheet.value, ...joinedWorksheets.value].filter(
    (item): item is NonNullable<typeof item> => Boolean(item)
  )
)
const numericFieldsByWorksheet = computed(() => {
  const result = new Map<string, WorksheetField[]>()
  for (const worksheet of availableWorksheets.value) {
    result.set(
      worksheet.worksheetId,
      worksheet.fields.filter((field) => [6, 31].includes(field.controlType))
    )
  }
  return result
})

function emptyConfig(): PivotConfig {
  return {
    name: '新透视表',
    primaryWorksheetId: '',
    joins: [],
    rows: [],
    columns: [],
    values: [],
    filters: [],
    showRowSubtotal: false,
    showRowGrandTotal: true,
    showColumnGrandTotal: true
  }
}

function resetEditing(seed?: Partial<PivotConfig>) {
  Object.assign(editing, emptyConfig(), { primaryWorksheetId: props.sourceWorksheetId ?? '' }, seed)
  if (props.sourceWorksheetId) {
    editing.primaryWorksheetId = props.sourceWorksheetId
    editing.joins = []
  }
  result.value = null
}

async function loadConfigs() {
  configsLoading.value = true
  try {
    configs.value = await window.salaryApi.listPivotConfigs()
  } finally {
    configsLoading.value = false
  }
}

async function loadConfig(id: number) {
  const config = await window.salaryApi.getPivotConfig(id)
  if (!config) return
  Object.assign(editing, emptyConfig(), config)
  result.value = null
  await runPivot()
}

function newConfig() {
  resetEditing()
}

async function runPivot() {
  if (!editing.primaryWorksheetId) {
    ElMessage.warning('请先选择主表')
    return
  }
  if (editing.values.length === 0) {
    ElMessage.warning('请至少选择一个数值字段')
    return
  }
  running.value = true
  try {
    result.value = await window.salaryApi.runPivot(editing)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '透视计算失败')
  } finally {
    running.value = false
  }
}

async function saveConfig() {
  if (!editing.name.trim()) {
    ElMessage.warning('请输入名称')
    return
  }
  if (!editing.primaryWorksheetId) {
    ElMessage.warning('请先选择主表')
    return
  }
  saving.value = true
  try {
    const saved = await window.salaryApi.savePivotConfig(editing)
    Object.assign(editing, saved)
    ElMessage.success('已保存')
    await loadConfigs()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function deleteConfig(item: PivotConfigSummary) {
  try {
    await ElMessageBox.confirm(`删除透视表「${item.name}」？`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await window.salaryApi.deletePivotConfig(item.id)
  ElMessage.success('已删除')
  await loadConfigs()
  if (editing.id === item.id) resetEditing()
}

async function exportToExcel() {
  if (!result.value) {
    ElMessage.warning('请先运行透视')
    return
  }
  exporting.value = true
  try {
    const summary = await window.salaryApi.exportPivot(
      editing,
      `${editing.name || '透视结果'}.xlsx`
    )
    if (summary) ElMessage.success(`已导出 ${summary.rowCount} 行`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
  }
}

function addJoin() {
  if (props.sourceWorksheetId) return
  editing.joins.push({ worksheetId: '', joinType: 'left' })
}
function removeJoin(index: number) {
  editing.joins.splice(index, 1)
}
function addRow() {
  if (!editing.primaryWorksheetId) return
  editing.rows.push({ worksheetId: editing.primaryWorksheetId, fieldName: '' })
}
function removeRow(index: number) {
  editing.rows.splice(index, 1)
}
function addColumn() {
  if (!editing.primaryWorksheetId) return
  editing.columns.push({ worksheetId: editing.primaryWorksheetId, fieldName: '' })
}
function removeColumn(index: number) {
  editing.columns.splice(index, 1)
}
function addValue() {
  if (!editing.primaryWorksheetId) return
  editing.values.push({
    worksheetId: editing.primaryWorksheetId,
    fieldName: '',
    agg: 'sum'
  })
}
function removeValue(index: number) {
  editing.values.splice(index, 1)
}
function addFilter() {
  if (!editing.primaryWorksheetId) return
  editing.filters.push({
    worksheetId: editing.primaryWorksheetId,
    fieldName: '',
    op: 'eq',
    values: ['']
  })
}
function removeFilter(index: number) {
  editing.filters.splice(index, 1)
}

function fieldsOfWorksheet(worksheetId: string): WorksheetField[] {
  return worksheets.value.find((item) => item.worksheetId === worksheetId)?.fields ?? []
}

function numericFieldsOfWorksheet(worksheetId: string): WorksheetField[] {
  return numericFieldsByWorksheet.value.get(worksheetId) ?? []
}

const resultColumns = computed(() => {
  if (!result.value) return []
  return [
    ...result.value.rowDimensions,
    ...result.value.columnDimensions,
    ...result.value.valueAliases
  ]
})

watch(
  () => editing.primaryWorksheetId,
  () => {
    if (props.sourceWorksheetId && editing.primaryWorksheetId !== props.sourceWorksheetId) {
      editing.primaryWorksheetId = props.sourceWorksheetId
      editing.joins = []
      return
    }
    if (!editing.primaryWorksheetId) return
    editing.rows = editing.rows.filter((item) =>
      availableWorksheets.value.some((w) => w.worksheetId === item.worksheetId)
    )
    editing.columns = editing.columns.filter((item) =>
      availableWorksheets.value.some((w) => w.worksheetId === item.worksheetId)
    )
    editing.values = editing.values.filter((item) =>
      availableWorksheets.value.some((w) => w.worksheetId === item.worksheetId)
    )
    editing.filters = editing.filters.filter((item) =>
      availableWorksheets.value.some((w) => w.worksheetId === item.worksheetId)
    )
  }
)

onMounted(() => {
  if (props.sourceWorksheetId) {
    resetEditing({ primaryWorksheetId: props.sourceWorksheetId })
  }
  void loadConfigs()
})
</script>

<template>
  <div class="pivot-shell">
    <aside class="pivot-sidebar">
      <div class="pivot-sidebar-header">
        <strong>透视表</strong>
        <el-button text :icon="Plus" @click="newConfig">新建</el-button>
      </div>
      <div class="pivot-config-list" v-loading="configsLoading">
        <div
          v-for="item in visibleConfigs"
          :key="item.id"
          class="pivot-config-item"
          :class="{ active: editing.id === item.id }"
          @click="loadConfig(item.id)"
        >
          <el-icon><Document /></el-icon>
          <div class="pivot-config-meta">
            <strong>{{ item.name }}</strong>
            <small>{{ item.primaryWorksheetName }}</small>
          </div>
          <el-button text :icon="Delete" size="small" @click.stop="deleteConfig(item)" />
        </div>
        <div v-if="visibleConfigs.length === 0" class="pivot-config-empty">尚未保存任何透视表</div>
      </div>
    </aside>

    <main class="pivot-main">
      <div class="pivot-toolbar">
        <el-input v-model="editing.name" placeholder="透视表名称" style="width: 200px" />
        <el-select
          v-model="editing.primaryWorksheetId"
          placeholder="主表"
          style="width: 180px"
          filterable
          :disabled="Boolean(props.sourceWorksheetId)"
        >
          <el-option
            v-for="item in worksheets"
            :key="item.worksheetId"
            :label="item.name"
            :value="item.worksheetId"
          />
        </el-select>
        <el-button :icon="Refresh" :loading="running" type="primary" @click="runPivot">
          运行
        </el-button>
        <el-button :loading="saving" @click="saveConfig">保存</el-button>
        <el-button :icon="Download" :loading="exporting" :disabled="!result" @click="exportToExcel">
          导出 Excel
        </el-button>
      </div>

      <div class="pivot-config-grid">
        <section v-if="!props.sourceWorksheetId" class="pivot-zone">
          <header>
            <strong>关联表（按身份证号）</strong>
            <el-button text :icon="Plus" size="small" @click="addJoin">添加关联</el-button>
          </header>
          <div v-for="(join, index) in editing.joins" :key="index" class="pivot-row">
            <el-select
              v-model="join.worksheetId"
              placeholder="选择关联表"
              style="width: 160px"
              filterable
            >
              <el-option
                v-for="item in worksheets"
                :key="item.worksheetId"
                :label="item.name"
                :value="item.worksheetId"
                :disabled="
                  item.worksheetId === editing.primaryWorksheetId ||
                  editing.joins.some(
                    (j, i) => i !== index && j.worksheetId === item.worksheetId
                  )
                "
              />
            </el-select>
            <el-select v-model="join.joinType" style="width: 100px">
              <el-option label="LEFT" value="left" />
              <el-option label="INNER" value="inner" />
            </el-select>
            <el-button text :icon="Delete" @click="removeJoin(index)" />
          </div>
        </section>

        <section class="pivot-zone">
          <header>
            <strong>行维度</strong>
            <el-button text :icon="Plus" size="small" @click="addRow">添加</el-button>
          </header>
          <div v-for="(row, index) in editing.rows" :key="index" class="pivot-row">
            <el-select v-model="row.worksheetId" style="width: 140px">
              <el-option
                v-for="ws in availableWorksheets"
                :key="ws.worksheetId"
                :label="ws.name"
                :value="ws.worksheetId"
              />
            </el-select>
            <el-select v-model="row.fieldName" placeholder="字段" filterable style="flex: 1">
              <el-option
                v-for="field in fieldsOfWorksheet(row.worksheetId)"
                :key="field.fieldId"
                :label="field.name"
                :value="field.name"
              />
            </el-select>
            <el-button text :icon="Delete" @click="removeRow(index)" />
          </div>
        </section>

        <section class="pivot-zone">
          <header>
            <strong>列维度</strong>
            <el-button text :icon="Plus" size="small" @click="addColumn">添加</el-button>
          </header>
          <div v-for="(col, index) in editing.columns" :key="index" class="pivot-row">
            <el-select v-model="col.worksheetId" style="width: 140px">
              <el-option
                v-for="ws in availableWorksheets"
                :key="ws.worksheetId"
                :label="ws.name"
                :value="ws.worksheetId"
              />
            </el-select>
            <el-select v-model="col.fieldName" placeholder="字段" filterable style="flex: 1">
              <el-option
                v-for="field in fieldsOfWorksheet(col.worksheetId)"
                :key="field.fieldId"
                :label="field.name"
                :value="field.name"
              />
            </el-select>
            <el-button text :icon="Delete" @click="removeColumn(index)" />
          </div>
        </section>

        <section class="pivot-zone">
          <header>
            <strong>值字段</strong>
            <el-button text :icon="Plus" size="small" @click="addValue">添加</el-button>
          </header>
          <div v-for="(value, index) in editing.values" :key="index" class="pivot-row">
            <el-select v-model="value.worksheetId" style="width: 140px">
              <el-option
                v-for="ws in availableWorksheets"
                :key="ws.worksheetId"
                :label="ws.name"
                :value="ws.worksheetId"
              />
            </el-select>
            <el-select v-model="value.fieldName" placeholder="字段" filterable style="flex: 1">
              <el-option
                v-for="field in numericFieldsOfWorksheet(value.worksheetId)"
                :key="field.fieldId"
                :label="field.name"
                :value="field.name"
              />
            </el-select>
            <el-select v-model="value.agg" style="width: 110px">
              <el-option
                v-for="opt in aggregationOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
            <el-input v-model="value.alias" placeholder="别名(可选)" style="width: 130px" />
            <el-button text :icon="Delete" @click="removeValue(index)" />
          </div>
        </section>

        <section class="pivot-zone full-row">
          <header>
            <strong>筛选</strong>
            <el-button text :icon="Plus" size="small" @click="addFilter">添加</el-button>
          </header>
          <div v-for="(filter, index) in editing.filters" :key="index" class="pivot-row">
            <el-select v-model="filter.worksheetId" style="width: 140px">
              <el-option
                v-for="ws in availableWorksheets"
                :key="ws.worksheetId"
                :label="ws.name"
                :value="ws.worksheetId"
              />
            </el-select>
            <el-select v-model="filter.fieldName" placeholder="字段" filterable style="width: 180px">
              <el-option
                v-for="field in fieldsOfWorksheet(filter.worksheetId)"
                :key="field.fieldId"
                :label="field.name"
                :value="field.name"
              />
            </el-select>
            <el-select v-model="filter.op" style="width: 110px">
              <el-option
                v-for="opt in filterOpOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
            <el-input
              v-if="filter.op !== 'is_null' && filter.op !== 'not_null'"
              :model-value="filter.values.join(',')"
              placeholder="值（逗号分隔）"
              style="flex: 1"
              @update:model-value="(v: string) => (filter.values = v.split(',').map((s: string) => s.trim()))"
            />
            <el-button text :icon="Delete" @click="removeFilter(index)" />
          </div>
        </section>
      </div>

      <section class="pivot-result">
        <header>
          <strong>结果</strong>
          <span v-if="result">共 {{ result.totalRows }} 行</span>
        </header>
        <el-table
          v-if="result && result.rows.length"
          :data="result.rows"
          border
          stripe
          size="small"
          height="100%"
        >
          <el-table-column
            v-for="col in resultColumns"
            :key="col"
            :prop="col"
            :label="col"
            min-width="140"
            show-overflow-tooltip
          />
        </el-table>
        <div v-else class="pivot-result-empty">
          {{ running ? '计算中…' : '点上方"运行"出结果' }}
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.pivot-shell {
  display: flex;
  flex: 1;
  min-height: 0;
}

.pivot-sidebar {
  flex: 0 0 220px;
  border-right: 1px solid var(--border);
  background: var(--surface);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.pivot-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.pivot-config-list {
  flex: 1;
  padding: 6px 0;
  overflow-y: auto;
}

.pivot-config-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-2);
  border-left: 3px solid transparent;
  transition: background 0.1s;
}

.pivot-config-item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.pivot-config-item.active {
  background: var(--primary-soft);
  color: var(--primary-text);
  border-left-color: var(--primary);
  font-weight: 500;
}

.pivot-config-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pivot-config-meta strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pivot-config-meta small {
  color: var(--text-3);
  font-size: 11px;
  font-family: var(--mono);
}

.pivot-config-empty {
  padding: 20px;
  color: var(--text-muted);
  font-size: 12.5px;
  text-align: center;
}

.pivot-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}

.pivot-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.pivot-config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  max-height: 360px;
  overflow-y: auto;
  background: var(--bg);
}

.pivot-zone {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  display: flex;
  flex-direction: column;
}

.pivot-zone.full-row {
  grid-column: span 2;
}

.pivot-zone header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.pivot-zone header strong {
  font-size: 12.5px;
  color: var(--text-2);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.pivot-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 12px;
}

.pivot-result {
  flex: 1;
  min-height: 0;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
}

.pivot-result header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  color: var(--text);
  font-size: 13px;
}

.pivot-result header span {
  color: var(--text-3);
  font-size: 12px;
  font-family: var(--mono);
}

.pivot-result-empty {
  display: grid;
  place-content: center;
  flex: 1;
  color: var(--text-muted);
  font-size: 12.5px;
}
</style>
