<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpBold,
  Close,
  Delete,
  DeleteFilled,
  Download,
  Edit,
  Plus,
  Refresh,
  Search,
  Setting
} from '@element-plus/icons-vue'
import type {
  WorkflowDefinition,
  WorksheetField,
  WorksheetRecord,
  WorksheetRecordsResult
} from '@shared/types'

const props = defineProps<{
  worksheet: {
    name: string
    worksheetId: string
    fieldCount: number
    viewCount: number
    fields: WorksheetField[]
    views?: Array<{ viewId?: string; name?: string }>
  }
  records: WorksheetRecordsResult | null
  recordsLoading: boolean
  page: number
  pageSize: number
  allPageSize: number
  search: string
  activeView: string
  workflows: WorkflowDefinition[]
  workflowRunningKey: string
  displayName?: string
}>()

const emit = defineEmits<{
  (event: 'create'): void
  (event: 'edit', record: WorksheetRecord): void
  (event: 'delete', record: WorksheetRecord): void
  (event: 'delete-many', recordIds: number[]): void
  (event: 'clear'): void
  (event: 'export'): void
  (event: 'refresh'): void
  (event: 'page-change', page: number): void
  (event: 'search-change', value: string): void
  (event: 'view-change', value: string): void
  (event: 'show-fields'): void
  (event: 'run-workflow', workflowKey: string): void
  (event: 'sort-change', value: { column: string; order: 'asc' | 'desc' } | null): void
  (event: 'page-size-change', value: number): void
}>()

const sortState = ref<{ key: string; order: 'asc' | 'desc' } | null>(null)
const worksheetTitle = computed(() => props.displayName || props.worksheet.name)
const NON_SORTABLE_FIELDS = new Set([
  '身份证号',
  '身份证号码',
  '证件号码',
  '证件号码*',
  '教职工身份证号'
])

function onPageSizeSelect(value: string) {
  emit('page-size-change', value === 'all' ? props.allPageSize : 100)
}

function onColumnSort(params: { key: string; order: 'asc' | 'desc' | null }) {
  if (!params.order) {
    sortState.value = null
    emit('sort-change', null)
    return
  }
  const field = props.worksheet.fields.find((f) => f.fieldId === params.key)
  if (!field) return
  const columnName = localColumnNames.value.get(field.fieldId) ?? field.name
  sortState.value = { key: params.key, order: params.order }
  emit('sort-change', { column: columnName, order: params.order })
}

const PERSONNEL_DRAWER_TABLES = new Set([
  '人事信息',
  '在编教职工基本信息',
  '预算在职',
  '预算退休',
  '预算其他',
  '一体化在职',
  '一体化退休',
  '一体化其他'
])
const PLAIN_ALL_FIELD_TABLES = new Set([
  '预算在职',
  '预算退休',
  '预算其他',
  '一体化在职',
  '一体化退休',
  '一体化其他'
])

const detailEnabled = computed(() => true)

const selectedRows = ref<WorksheetRecord[]>([])
const selectedRecord = ref<WorksheetRecord | null>(null)

type VirtualTableColumn = {
  key: string
  dataKey: string
  title: string
  width: number
  fixed?: true | 'left' | 'right'
  align?: 'left' | 'center' | 'right'
  class?: string | ((params: { rowData: WorksheetRecord }) => string)
  headerClass?: string
  cellRenderer?: (params: {
    cellData: unknown
    rowData: WorksheetRecord
    rowIndex: number
  }) => ReturnType<typeof h>
  headerCellRenderer?: () => ReturnType<typeof h>
}

const visibleFields = computed(() =>
  props.worksheet.fields
    .map((field, index) => ({ ...field, displayOrder: field.displayOrder ?? index }))
    .filter((field) => !field.hidden)
    .sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0))
)

const visibleFieldNames = computed(() => new Set(visibleFields.value.map((field) => field.name)))

type ChildTable = { worksheetName: string; fields: Array<{ name: string; columnName: string }>; rows: Record<string, unknown>[] }
const childTables = ref<ChildTable[]>([])
const childTablesLoading = ref(false)

const isPersonnelDetail = computed(() => props.worksheet.worksheetId === 'local-hr-detail')
const isPersonnelDrawerStyle = computed(() => PERSONNEL_DRAWER_TABLES.has(props.worksheet.name))
const isPlainAllFieldTable = computed(() => PLAIN_ALL_FIELD_TABLES.has(props.worksheet.name))

const activeTab = ref('basic')
const PD_TABS = [
  { id: 'basic', label: '基本信息' },
  { id: 'edu',   label: '学历职称' },
  { id: 'cert',  label: '教师资格' },
  { id: 'teach', label: '任教' },
  { id: 'career',label: '工作履历' },
  { id: 'all',   label: '字段详情' }
]
const GENERIC_PERSON_TABS = [
  { id: 'basic', label: '基本信息' },
  { id: 'edu', label: '学历职称' },
  { id: 'career', label: '岗位薪酬' },
  { id: 'all', label: '字段详情' }
]
const ALL_FIELD_TABS = [{ id: 'all', label: '字段详情' }]
const detailTabs = computed(() => {
  if (isPersonnelDetail.value) return PD_TABS
  if (isPlainAllFieldTable.value) return ALL_FIELD_TABS
  return GENERIC_PERSON_TABS
})
const showDetailTabs = computed(() => !isPlainAllFieldTable.value)

function defaultDetailTab(): string {
  return isPlainAllFieldTable.value ? 'all' : 'basic'
}

watch(selectedRecord, async (record) => {
  activeTab.value = defaultDetailTab()
  if (!record || !isPersonnelDetail.value) {
    childTables.value = []
    return
  }
  const idField = props.worksheet.fields.find(
    (f) => f.name === '身份证号码' || f.name.includes('身份证') || f.name.includes('证件号')
  )
  if (!idField) { childTables.value = []; return }
  const key = localColumnNames.value.get(idField.fieldId) ?? idField.fieldId
  const idValue = (record as Record<string, unknown>)[key]
  if (!idValue || typeof idValue !== 'string') { childTables.value = []; return }
  childTablesLoading.value = true
  try {
    childTables.value = await window.salaryApi.listPersonnelChildRecords(idValue)
  } catch { childTables.value = [] }
  finally { childTablesLoading.value = false }
})

// 切换工作表时清空选中详情
watch(() => props.worksheet.worksheetId, () => {
  selectedRecord.value = null
  selectedRows.value = []
  activeTab.value = defaultDetailTab()
})

watch(
  () => props.records?.rows,
  (rows) => {
    const currentIds = new Set((rows ?? []).map(recordKey))
    selectedRows.value = selectedRows.value.filter((row) => currentIds.has(recordKey(row)))
  }
)

function recordKey(row: WorksheetRecord): string {
  const id = (row as Record<string, unknown>).id
  return id === null || id === undefined ? '' : String(id)
}

const selectedRowKeys = computed(() => new Set(selectedRows.value.map(recordKey)))

const currentPageRows = computed(() => props.records?.rows ?? [])

const allCurrentPageSelected = computed(
  () =>
    currentPageRows.value.length > 0 &&
    currentPageRows.value.every((row) => selectedRowKeys.value.has(recordKey(row)))
)

const someCurrentPageSelected = computed(
  () => currentPageRows.value.some((row) => selectedRowKeys.value.has(recordKey(row)))
)

function isRowSelected(row: WorksheetRecord): boolean {
  return selectedRowKeys.value.has(recordKey(row))
}

function toggleRowSelection(row: WorksheetRecord, checked: boolean) {
  const key = recordKey(row)
  if (!key) return

  if (checked) {
    if (!selectedRowKeys.value.has(key)) {
      selectedRows.value = [...selectedRows.value, row]
    }
    return
  }

  selectedRows.value = selectedRows.value.filter((item) => recordKey(item) !== key)
}

function toggleCurrentPageSelection(checked: boolean) {
  selectedRows.value = checked ? [...currentPageRows.value] : []
}

function onRowClick(row: WorksheetRecord) {
  if (selectedRecord.value === row) {
    selectedRecord.value = null
  } else {
    selectedRecord.value = row
  }
}

function rowClassName({ row }: { row: WorksheetRecord }) {
  return row === selectedRecord.value ? 'is-selected-row' : ''
}

function virtualRowClassName({ rowData }: { rowData: WorksheetRecord }) {
  return rowData === selectedRecord.value ? 'is-selected-row' : ''
}

const virtualRowEventHandlers = {
  onClick: ({ rowData }: { rowData: WorksheetRecord }) => {
    if (detailEnabled.value) onRowClick(rowData)
  }
}

// 详情英雄字段
const heroNameField = computed(() =>
  props.worksheet.fields.find((f) => f.name === '姓名' || f.name.includes('姓名'))
)
const heroIdField = computed(() =>
  props.worksheet.fields.find(
    (f) => f.name.includes('身份证') || f.name.includes('证件号')
  )
)
const heroUnitField = computed(() =>
  props.worksheet.fields.find((f) => f.name === '单位全称' || f.name === '单位名称' || f.name.includes('单位'))
)

function recordVal(record: WorksheetRecord, fieldId: string): string {
  const key = columnNameOf(fieldId)
  const val = (record as Record<string, unknown>)[key]
  return val === null || val === undefined ? '—' : String(val)
}

function formatUpdatedAt(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未记录'
  const raw = String(value)
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

const selectedUpdatedAt = computed(() => {
  const row = selectedRecord.value as Record<string, unknown> | null
  return formatUpdatedAt(row?.md_updated_at)
})

const heroName = computed(() => {
  if (!selectedRecord.value || !heroNameField.value) return '—'
  return recordVal(selectedRecord.value, heroNameField.value.fieldId)
})
const heroId = computed(() => {
  if (!selectedRecord.value || !heroIdField.value) return ''
  return recordVal(selectedRecord.value, heroIdField.value.fieldId)
})
const heroUnit = computed(() => {
  if (!selectedRecord.value || !heroUnitField.value) return ''
  return recordVal(selectedRecord.value, heroUnitField.value.fieldId)
})
const heroInitial = computed(() => heroName.value.slice(-2) || '—')

function onSelectionChange(rows: WorksheetRecord[]) {
  selectedRows.value = rows
}

function deleteSelected() {
  const ids = selectedRows.value
    .map((row) => (typeof row.id === 'number' ? row.id : Number(row.id)))
    .filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) return
  emit('delete-many', ids)
}

const localSearch = ref(props.search)
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.search,
  (value) => {
    localSearch.value = value
  }
)

watch(localSearch, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    emit('search-change', value)
  }, 300)
})

const total = computed(() => props.records?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / props.pageSize)))
const showingFrom = computed(() =>
  total.value === 0 ? 0 : (props.page - 1) * props.pageSize + 1
)
const showingTo = computed(() =>
  Math.min(props.page * props.pageSize, total.value)
)
const viewNames = computed(() => {
  const names = (props.worksheet.views ?? [])
    .map((view) => view.name)
    .filter((name): name is string => Boolean(name))
  return names.length > 0 ? names : ['\u5168\u90e8']
})
const currentView = computed(() => props.activeView || viewNames.value[0] || '\u5168\u90e8')
const showViewSwitcher = computed(() => viewNames.value.length > 1)

const localColumnNames = computed(() => {
  const used = new Map<string, number>()
  const result = new Map<string, string>()
  for (const field of props.worksheet.fields) {
    const baseName = field.name || field.fieldId
    const count = used.get(baseName) ?? 0
    used.set(baseName, count + 1)
    result.set(field.fieldId, count === 0 ? baseName : `${baseName}_${count + 1}`)
  }
  return result
})

const fieldColMap = computed(() => {
  const map = new Map<string, string>()
  for (const field of props.worksheet.fields) {
    map.set(field.name, localColumnNames.value.get(field.fieldId) ?? field.fieldId)
  }
  return map
})

function fval(name: string): string {
  if (!selectedRecord.value) return ''
  const col = fieldColMap.value.get(name)
  if (!col) return ''
  const v = (selectedRecord.value as Record<string, unknown>)[col]
  return v === null || v === undefined ? '' : String(v)
}

function firstValue(names: string[]): string {
  if (!selectedRecord.value) return ''
  for (const name of names) {
    const exact = fval(name)
    if (exact) return exact
  }
  for (const field of props.worksheet.fields) {
    if (!names.some((name) => field.name.includes(name))) continue
    const value = recordVal(selectedRecord.value, field.fieldId)
    if (value && value !== '—') return value
  }
  return ''
}

const personName = computed(() => firstValue(['姓名', '人员姓名', '职工姓名']) || heroName.value)
const personId = computed(() => firstValue(['身份证号码', '证件号码', '身份证号']) || heroId.value)
const personUnit = computed(() => firstValue(['单位全称', '单位名称', '单位']) || heroUnit.value)
const personPost = computed(() => firstValue(['岗位职务', '岗位', '职务', '岗位名称']))
const personTitle = computed(() => firstValue(['职称', '专业技术职务', '岗位等级']))
const personStatus = computed(() => firstValue(['人员状态', '是否在岗', '状态', '人员类别']))
const personSalaryGrade = computed(() => firstValue(['薪级', '工资薪级', '薪级等级']))
const personStartTime = computed(() => firstValue(['本县入编时间', '参加工作时间', '入编时间', '任职时间']))

function visibleNames(names: string[]): string[] {
  return names.filter((name) => visibleFieldNames.value.has(name))
}

function detailFieldsByKeywords(keywords: string[]): WorksheetField[] {
  const used = new Set<string>()
  const fields: WorksheetField[] = []
  for (const field of visibleFields.value) {
    if (!keywords.some((keyword) => field.name.includes(keyword))) continue
    if (used.has(field.fieldId)) continue
    used.add(field.fieldId)
    fields.push(field)
  }
  return fields
}

function genericDetailFields(tabId: string): WorksheetField[] {
  if (tabId === 'all') return visibleFields.value
  if (tabId === 'basic') {
    return detailFieldsByKeywords([
      '单位',
      '姓名',
      '身份证',
      '证件',
      '性别',
      '民族',
      '出生',
      '政治',
      '电话',
      '住址',
      '地址',
      '籍贯'
    ])
  }
  if (tabId === 'edu') {
    return detailFieldsByKeywords(['学历', '学位', '毕业', '专业', '院校', '职称', '学科'])
  }
  if (tabId === 'teach') {
    return detailFieldsByKeywords(['任教', '课程', '课时', '班主任', '学科', '班级'])
  }
  if (tabId === 'career') {
    return detailFieldsByKeywords([
      '岗位',
      '职务',
      '职级',
      '薪级',
      '工资',
      '补贴',
      '津贴',
      '绩效',
      '参加工作',
      '入编',
      '退休',
      '调出',
      '状态',
      '备注',
      '原因'
    ])
  }
  return []
}

function copyVal(text: string) {
  if (!text) return
  navigator.clipboard?.writeText(text).catch(() => {})
}

const pdEduRows    = computed(() => childTables.value.find(t => t.worksheetName === '教职工学历')?.rows ?? [])
const pdEduFields  = computed(() => childTables.value.find(t => t.worksheetName === '教职工学历')?.fields ?? [])
const pdCertRows   = computed(() => childTables.value.find(t => t.worksheetName === '教职工教师资格')?.rows ?? [])
const pdCertFields = computed(() => childTables.value.find(t => t.worksheetName === '教职工教师资格')?.fields ?? [])
const pdTeachRows  = computed(() => childTables.value.find(t => t.worksheetName === '教职工任教信息')?.rows ?? [])
const pdTeachFields= computed(() => childTables.value.find(t => t.worksheetName === '教职工任教信息')?.fields ?? [])
const pdWorkRows   = computed(() => childTables.value.find(t => t.worksheetName === '教职工工作履历')?.rows ?? [])

const moduleWorkflows = computed(() => {
  const worksheetWorkflowMap: Record<string, string[]> = {
    人员明细导出: ['housing-subsidy.prepare-new'],
    新房补: ['housing-subsidy.write-back-retired']
  }
  const workflowKeys = worksheetWorkflowMap[props.worksheet.name]
  if (workflowKeys) {
    return props.workflows.filter((workflow) => workflowKeys.includes(workflow.key))
  }

  const moduleMap: Record<string, string> = {
    一体化在职: '一体化在职',
    一体化退休: '一体化在职',
    一体化其他: '一体化在职',
    预算在职: '预算',
    预算退休: '预算',
    预算其他: '预算',
    工资年报: '工资年报',
    绩效工资: '绩效工资',
    乡镇补贴: '乡镇补贴'
  }
  const moduleName = moduleMap[props.worksheet.name]
  if (!moduleName) return []
  return props.workflows.filter((workflow) => workflow.module === moduleName)
})

function columnNameOf(fieldId: string): string {
  return localColumnNames.value.get(fieldId) ?? fieldId
}

function displayCellValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

function renderCellText(value: unknown) {
  const text = displayCellValue(value)
  return h('span', { class: 'virtual-cell-text', title: text }, text)
}

function renderHeaderCheckbox() {
  return h('input', {
    type: 'checkbox',
    class: 'virtual-row-checkbox',
    checked: allCurrentPageSelected.value,
    title:
      someCurrentPageSelected.value && !allCurrentPageSelected.value
        ? '已选中部分本页记录'
        : '选择本页记录',
    onClick: (event: MouseEvent) => event.stopPropagation(),
    onChange: (event: Event) => {
      toggleCurrentPageSelection((event.target as HTMLInputElement).checked)
    }
  })
}

function renderRowCheckbox(row: WorksheetRecord) {
  return h('input', {
    type: 'checkbox',
    class: 'virtual-row-checkbox',
    checked: isRowSelected(row),
    onClick: (event: MouseEvent) => event.stopPropagation(),
    onChange: (event: Event) => {
      toggleRowSelection(row, (event.target as HTMLInputElement).checked)
    }
  })
}

function renderActionButton(
  label: string,
  type: 'primary' | 'danger',
  onClick: () => void
) {
  const Icon = type === 'primary' ? Edit : Delete
  return h(
    'button',
    {
      type: 'button',
      class: ['virtual-action-button', `is-${type}`],
      onClick: (event: MouseEvent) => {
        event.stopPropagation()
        onClick()
      }
    },
    [
      h('span', { class: 'virtual-action-icon' }, [h(Icon)]),
      h('span', label)
    ]
  )
}

const virtualColumns = computed<VirtualTableColumn[]>(() => {
  const columns: VirtualTableColumn[] = [
    {
      key: '__selection',
      dataKey: '__selection',
      title: '',
      width: 46,
      fixed: 'left',
      align: 'center',
      headerCellRenderer: renderHeaderCheckbox,
      cellRenderer: ({ rowData }) => renderRowCheckbox(rowData)
    },
    {
      key: '__index',
      dataKey: '__index',
      title: '#',
      width: 60,
      fixed: 'left',
      align: 'center',
      cellRenderer: ({ rowIndex }) => h('span', { class: 'virtual-index-cell' }, showingFrom.value + rowIndex)
    },
    ...visibleFields.value.map<VirtualTableColumn>((field) => ({
      key: field.fieldId,
      dataKey: columnNameOf(field.fieldId),
      title: field.name,
      width: 140,
      sortable: !NON_SORTABLE_FIELDS.has(field.name),
      cellRenderer: ({ cellData }) => renderCellText(cellData)
    }))
  ]

  if (!selectedRecord.value) {
    columns.push({
      key: '__actions',
      dataKey: '__actions',
      title: '操作',
      width: 150,
      fixed: 'right',
      align: 'center',
      cellRenderer: ({ rowData }) =>
        h('div', { class: 'row-actions-inline virtual-row-actions' }, [
          renderActionButton('编辑', 'primary', () => emit('edit', rowData)),
          renderActionButton('删除', 'danger', () => emit('delete', rowData))
        ])
    })
  }

  return columns
})

function gotoPage(page: number) {
  if (page < 1 || page > totalPages.value) return
  emit('page-change', page)
}

function workflowButtonType(workflow: WorkflowDefinition) {
  if (workflow.status === 'ready') return 'primary'
  if (workflow.status === 'blocked-by-source') return 'info'
  return 'default'
}

function workflowDisabled(workflow: WorkflowDefinition) {
  return workflow.status !== 'ready'
}
</script>

<template>
  <section
    class="worksheet-view"
    :class="{
      'is-personnel-drawer': isPersonnelDrawerStyle,
      'has-detail-open': Boolean(selectedRecord)
    }"
  >
    <header class="ws-header">
      <div class="ws-title">
        <el-icon><ArrowUpBold /></el-icon>
        <h2>{{ worksheetTitle }}</h2>
        <el-button text :icon="Setting" size="small" @click="emit('show-fields')">
          字段结构
        </el-button>
      </div>

      <div class="ws-actions">
        <el-button-group v-if="moduleWorkflows.length" class="ws-workflow-actions">
          <el-tooltip
            v-for="workflow in moduleWorkflows"
            :key="workflow.key"
            :content="workflow.blockedReason || (workflow.status === 'ready' ? workflow.name : '规则未完成，暂不允许执行')"
            placement="bottom"
          >
            <el-button
              size="default"
              :type="workflowButtonType(workflow)"
              :disabled="workflowDisabled(workflow)"
              :loading="workflowRunningKey === workflow.key"
              @click="emit('run-workflow', workflow.key)"
            >
              {{ workflow.name }}
            </el-button>
          </el-tooltip>
        </el-button-group>
        <el-button type="primary" :icon="Plus" @click="emit('create')">+ 记录</el-button>
        <el-input
          v-model="localSearch"
          :prefix-icon="Search"
          placeholder="搜索本表"
          clearable
          size="default"
          class="ws-search"
        />
      </div>
    </header>

    <div class="ws-subbar">
      <div class="ws-subbar-left">
        <template v-if="showViewSwitcher">
          <el-button
            v-for="viewName in viewNames"
            :key="viewName"
            size="small"
            :type="currentView === viewName ? 'primary' : 'default'"
            plain
            @click="emit('view-change', viewName)"
          >
            {{ viewName }}
          </el-button>
        </template>
        <el-button
          v-if="selectedRows.length > 0"
          size="small"
          type="danger"
          :icon="Delete"
          @click="deleteSelected"
        >
          删除选中（{{ selectedRows.length }}）
        </el-button>
        <el-button
          v-if="total > 0"
          size="small"
          type="danger"
          plain
          :icon="DeleteFilled"
          @click="emit('clear')"
        >
          清空本表
        </el-button>
      </div>
      <div class="ws-subbar-right">
        <el-button text :icon="Refresh" :loading="recordsLoading" @click="emit('refresh')">
          刷新
        </el-button>
        <el-button text :icon="Download" @click="emit('export')">
          导出
        </el-button>
        <span class="ws-pagination-info">
          共 {{ total }} 行，{{ showingFrom }}-{{ showingTo }}（{{ page }}/{{ totalPages }} 页）
        </span>
        <el-select
          :model-value="pageSize >= allPageSize ? 'all' : '100'"
          size="small"
          style="width: 90px"
          @change="onPageSizeSelect"
        >
          <el-option label="100" value="100" />
          <el-option label="全部" value="all" />
        </el-select>
        <el-button-group>
          <el-button
            size="small"
            :icon="ArrowLeft"
            :disabled="page <= 1"
            @click="gotoPage(page - 1)"
          />
          <el-button
            size="small"
            :icon="ArrowRight"
            :disabled="page >= totalPages"
            @click="gotoPage(page + 1)"
          />
        </el-button-group>
      </div>
    </div>

    <div class="ws-body">
      <div class="ws-table-section">
        <div class="ws-table-wrap" v-loading="recordsLoading">
        <el-auto-resizer v-if="records?.rows.length" class="virtual-table-resizer">
          <template #default="{ height, width }">
            <el-table-v2
              class="ws-virtual-table"
              :columns="virtualColumns"
              :data="records.rows"
              :width="width"
              :height="height"
              :row-height="38"
              :header-height="40"
              row-key="id"
              fixed
              scrollbar-always-on
              :sort-by="sortState ?? undefined"
              :row-class="virtualRowClassName"
              :row-event-handlers="virtualRowEventHandlers"
              @column-sort="onColumnSort"
            />
          </template>
        </el-auto-resizer>

        <div v-else class="ws-empty">
          <strong>暂无数据</strong>
          <span>点击右上角"+ 记录"录入第一条，或把 Excel 拖进 D:\\laojiu\\工资导入 自动入库</span>
        </div>
        </div>
      </div>

      <transition name="detail-slide">
        <aside v-if="detailEnabled && selectedRecord" class="ws-detail-panel">

          <!-- ========== 非人员表：原有简洁布局 ========== -->
          <template v-if="!isPersonnelDrawerStyle">
            <div class="ws-detail-hero">
              <div class="ws-detail-avatar">{{ heroInitial }}</div>
              <div class="ws-detail-hero-info">
                <strong>{{ heroName }}</strong>
                <span v-if="heroId">{{ heroId }}</span>
                <span v-if="heroUnit" class="ws-detail-unit">{{ heroUnit }}</span>
              </div>
              <button class="ws-detail-close" @click="selectedRecord = null">
                <el-icon><Close /></el-icon>
              </button>
            </div>
            <div class="ws-detail-toolbar">
              <el-button size="small" type="primary" plain :icon="Edit" @click="emit('edit', selectedRecord)">编辑</el-button>
              <el-button size="small" type="danger" plain :icon="Delete" @click="emit('delete', selectedRecord)">删除</el-button>
            </div>
            <div class="ws-detail-body">
              <div class="record-update-stamp">
                <span>最后更新时间</span>
                <strong>{{ selectedUpdatedAt }}</strong>
              </div>
              <div class="ws-detail-kv">
                <div v-for="field in visibleFields" :key="field.fieldId" class="ws-detail-kv-row">
                  <span class="ws-kv-key">{{ field.name }}</span>
                  <span class="ws-kv-val">{{ recordVal(selectedRecord, field.fieldId) }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- ========== 人员表：右侧详情 + 标签页人员卡 ========== -->
          <template v-else>
            <!-- 顶部工具条 -->
            <div class="pd-toolbar">
              <el-button size="small" type="primary" plain :icon="Edit" @click="emit('edit', selectedRecord)">编辑</el-button>
              <el-button size="small" type="danger" plain :icon="Delete" @click="emit('delete', selectedRecord)">删除</el-button>
              <div class="pd-spacer"></div>
              <button class="pd-close-btn" @click="selectedRecord = null">
                <el-icon><Close /></el-icon>
              </button>
            </div>

            <!-- 滚动内容区 -->
            <div class="pd-scroll">
              <div class="pd-shell">

                <!-- Hero 卡 -->
                <div class="pd-hero">
                  <div class="pd-hero-main">
                    <div class="pd-avatar">{{ heroInitial }}</div>
                    <div class="pd-hero-text">
                      <h2 class="pd-name">
                        <span class="pd-nm">{{ personName || '—' }}</span>
                        <span v-if="personPost" class="pd-pos-job">{{ personPost }}</span>
                      </h2>
                      <div class="pd-id-line">
                        <span class="pd-copyable" @click="copyVal(personId)">{{ personId || '—' }}</span>
                        <template v-if="firstValue(['联系电话', '电话', '手机'])">
                          <span class="pd-sep">·</span>
                          <span class="pd-copyable" @click="copyVal(firstValue(['联系电话', '电话', '手机']))">{{ firstValue(['联系电话', '电话', '手机']) }}</span>
                        </template>
                        <template v-if="personUnit">
                          <span class="pd-sep">·</span>
                          <span>{{ personUnit }}</span>
                        </template>
                      </div>
                      <div class="pd-tag-row">
                        <span v-if="fval('性别')" class="pd-tag pd-tag-gray">{{ fval('性别') }}</span>
                        <span v-if="fval('是否在岗') === '是'" class="pd-tag pd-tag-green">在岗</span>
                        <span v-else-if="fval('是否在岗') === '否'" class="pd-tag pd-tag-warn">不在岗</span>
                        <span v-if="personStatus && !['是', '否'].includes(personStatus)" class="pd-tag pd-tag-green">{{ personStatus }}</span>
                        <span v-if="fval('政治面貌')" class="pd-tag pd-tag-blue">{{ fval('政治面貌') }}</span>
                      </div>
                    </div>
                  </div>
                  <div class="pd-quick-stats">
                    <div class="pd-qs">
                      <span class="pd-qk">职称</span>
                      <span class="pd-qv">{{ personTitle || '—' }}</span>
                    </div>
                    <div class="pd-qs">
                      <span class="pd-qk">时间</span>
                      <span class="pd-qv pd-mono">{{ personStartTime || '—' }}</span>
                    </div>
                    <div class="pd-qs">
                      <span class="pd-qk">薪级</span>
                      <span class="pd-qv pd-mono">{{ personSalaryGrade || fval('总周课时数') || '—' }}</span>
                    </div>
                  </div>
                </div>

                <!-- 标签栏 -->
                <div v-if="showDetailTabs" class="pd-tab-bar">
                  <div
                    v-for="(tab, i) in detailTabs"
                    :key="tab.id"
                    :class="['pd-tab', activeTab === tab.id ? 'pd-tab-active' : '']"
                    @click="activeTab = tab.id"
                  >{{ tab.label }}<span class="pd-tab-num">{{ i + 1 }}</span></div>
                </div>

                <!-- Tab: 基本信息 -->
                <div v-if="activeTab === 'basic'" class="pd-pane">
                  <template v-if="!isPersonnelDetail">
                    <div class="pd-section">
                      <h3 class="pd-section-title">基本信息</h3>
                      <div v-if="genericDetailFields('basic').length === 0" class="pd-muted pd-empty-tip">暂无可展示字段</div>
                      <div v-else class="pd-kv-grid pd-kv-grid-wide">
                        <div v-for="field in genericDetailFields('basic')" :key="field.fieldId" class="pd-kv">
                          <span class="pd-k">{{ field.name }}</span>
                          <span :class="['pd-v', recordVal(selectedRecord, field.fieldId) === '—' ? 'pd-muted' : '']">{{ recordVal(selectedRecord, field.fieldId) }}</span>
                        </div>
                      </div>
                    </div>
                  </template>
                  <template v-else>
                  <div class="pd-section">
                    <h3 class="pd-section-title">基本信息</h3>
                    <div class="pd-kv-grid">
                      <div v-for="n in visibleNames(['民族','籍贯','政治面貌','入党时间','出生日期','人员性质','现住址','联系电话'])" :key="n" class="pd-kv">
                        <span class="pd-k">{{ n }}</span>
                        <span :class="['pd-v', !fval(n) ? 'pd-muted' : '']">{{ fval(n) || '—' }}</span>
                      </div>
                    </div>
                  </div>
                  <div class="pd-section">
                    <h3 class="pd-section-title">入编与岗位</h3>
                    <div class="pd-kv-grid">
                      <div v-for="n in visibleNames(['本县入编时间','岗位职务','任命单位','批复文号','在现单位任现职时间','是否在岗','岗位','总周课时数','是否任班主任'])" :key="n" class="pd-kv">
                        <span class="pd-k">{{ n }}</span>
                        <span :class="['pd-v', !fval(n) ? 'pd-muted' : '']">{{ fval(n) || '—' }}</span>
                      </div>
                    </div>
                  </div>
                  <div v-if="fval('不在岗原因') || fval('不在岗起始时间') || fval('不在岗现在何处')" class="pd-section">
                    <h3 class="pd-section-title">不在岗信息</h3>
                    <div class="pd-kv-grid">
                      <div v-for="n in ['不在岗原因','不在岗起始时间','不在岗现在何处']" :key="n" class="pd-kv">
                        <span class="pd-k">{{ n }}</span>
                        <span :class="['pd-v', !fval(n) ? 'pd-muted' : '']">{{ fval(n) || '—' }}</span>
                      </div>
                    </div>
                  </div>
                  <div v-if="fval('备注')" class="pd-section">
                    <h3 class="pd-section-title">备注</h3>
                    <div class="pd-remark">{{ fval('备注') }}</div>
                  </div>
                  </template>
                </div>

                <!-- Tab: 学历职称 -->
                <div v-if="activeTab === 'edu'" class="pd-pane">
                  <template v-if="!isPersonnelDetail">
                    <div class="pd-section">
                      <h3 class="pd-section-title">学历职称</h3>
                      <div v-if="genericDetailFields('edu').length === 0" class="pd-muted pd-empty-tip">暂无可展示字段</div>
                      <div v-else class="pd-kv-grid pd-kv-grid-wide">
                        <div v-for="field in genericDetailFields('edu')" :key="field.fieldId" class="pd-kv">
                          <span class="pd-k">{{ field.name }}</span>
                          <span :class="['pd-v', recordVal(selectedRecord, field.fieldId) === '—' ? 'pd-muted' : '']">{{ recordVal(selectedRecord, field.fieldId) }}</span>
                        </div>
                      </div>
                    </div>
                  </template>
                  <template v-else>
                  <div class="pd-section">
                    <h3 class="pd-section-title">学历记录</h3>
                    <div v-if="childTablesLoading" class="pd-loading">加载中...</div>
                    <div v-else-if="pdEduRows.length === 0" class="pd-muted pd-empty-tip">暂无学历记录</div>
                    <div v-else class="pd-table-wrap">
                      <table class="pd-table">
                        <thead><tr><th v-for="f in pdEduFields" :key="f.columnName">{{ f.name }}</th></tr></thead>
                        <tbody>
                          <tr v-for="(row, i) in pdEduRows" :key="i">
                            <td v-for="f in pdEduFields" :key="f.columnName">{{ row[f.columnName] ?? '—' }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div class="pd-section">
                    <h3 class="pd-section-title">职称信息</h3>
                    <div class="pd-kv-grid">
                    <div v-for="n in visibleNames(['职称','职称学科','职称获得时间'])" :key="n" class="pd-kv">
                      <span class="pd-k">{{ n }}</span>
                      <span :class="['pd-v', !fval(n) ? 'pd-muted' : '']">{{ fval(n) || '—' }}</span>
                    </div>
                    </div>
                  </div>
                  </template>
                </div>

                <!-- Tab: 教师资格 -->
                <div v-if="activeTab === 'cert'" class="pd-pane">
                  <div class="pd-section">
                    <h3 class="pd-section-title">教师资格</h3>
                    <div v-if="childTablesLoading" class="pd-loading">加载中...</div>
                    <div v-else-if="pdCertRows.length === 0" class="pd-muted pd-empty-tip">无教师资格记录</div>
                    <div v-else class="pd-table-wrap">
                      <table class="pd-table">
                        <thead><tr><th v-for="f in pdCertFields" :key="f.columnName">{{ f.name }}</th></tr></thead>
                        <tbody>
                          <tr v-for="(row, i) in pdCertRows" :key="i">
                            <td v-for="f in pdCertFields" :key="f.columnName">{{ row[f.columnName] ?? '—' }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <!-- Tab: 任教 -->
                <div v-if="activeTab === 'teach'" class="pd-pane">
                  <div class="pd-section">
                    <h3 class="pd-section-title">任教信息</h3>
                    <div v-if="childTablesLoading" class="pd-loading">加载中...</div>
                    <div v-else-if="pdTeachRows.length === 0" class="pd-muted pd-empty-tip">无任教记录</div>
                    <div v-else class="pd-table-wrap">
                      <table class="pd-table">
                        <thead><tr><th v-for="f in pdTeachFields" :key="f.columnName">{{ f.name }}</th></tr></thead>
                        <tbody>
                          <tr v-for="(row, i) in pdTeachRows" :key="i">
                            <td v-for="f in pdTeachFields" :key="f.columnName">{{ row[f.columnName] ?? '—' }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div v-if="fval('总周课时数')" class="pd-teach-footer">
                      合计周课时：<b>{{ fval('总周课时数') }}</b>
                      <span v-if="fval('是否任班主任')" class="pd-teach-footer-extra">班主任：<b>{{ fval('是否任班主任') }}</b></span>
                    </div>
                  </div>
                </div>

                <!-- Tab: 工作履历 -->
                <div v-if="activeTab === 'career'" class="pd-pane">
                  <div class="pd-section">
                    <h3 class="pd-section-title">工作履历</h3>
                    <template v-if="!isPersonnelDetail">
                      <div v-if="genericDetailFields('career').length === 0" class="pd-muted pd-empty-tip">暂无可展示字段</div>
                      <div v-else class="pd-kv-grid pd-kv-grid-wide">
                        <div v-for="field in genericDetailFields('career')" :key="field.fieldId" class="pd-kv">
                          <span class="pd-k">{{ field.name }}</span>
                          <span :class="['pd-v', recordVal(selectedRecord, field.fieldId) === '—' ? 'pd-muted' : '']">{{ recordVal(selectedRecord, field.fieldId) }}</span>
                        </div>
                      </div>
                    </template>
                    <div v-else-if="childTablesLoading" class="pd-loading">加载中...</div>
                    <div v-else-if="pdWorkRows.length === 0" class="pd-muted pd-empty-tip">暂无工作履历</div>
                    <ul v-else class="pd-timeline">
                      <li v-for="(row, i) in pdWorkRows" :key="i" class="pd-tl-item">
                        <span class="pd-tl-when">{{ row['开始时间'] }}{{ row['结束时间'] ? ' — ' + row['结束时间'] : '' }}</span>
                        <div class="pd-tl-body">
                          <span class="pd-tl-where">{{ row['工作单位'] || '—' }}</span>
                          <span v-if="row['职务岗位']" class="pd-tl-role"> · {{ row['职务岗位'] }}</span>
                          <div v-if="row['说明']" class="pd-tl-note">{{ row['说明'] }}</div>
                        </div>
                      </li>
                    </ul>
                  </div>
                </div>

                <!-- Tab: 字段详情 -->
                <div v-if="activeTab === 'all'" class="pd-pane">
                  <div class="pd-section">
                    <div class="record-update-stamp record-update-stamp-pd">
                      <span>最后更新时间</span>
                      <strong>{{ selectedUpdatedAt }}</strong>
                    </div>
                    <h3 class="pd-section-title">{{ isPlainAllFieldTable ? '字段详情' : '完整字段' }}</h3>
                    <div class="pd-kv-grid pd-kv-grid-wide">
                      <div v-for="field in visibleFields" :key="field.fieldId" class="pd-kv">
                        <span class="pd-k">{{ field.name }}</span>
                        <span :class="['pd-v', recordVal(selectedRecord, field.fieldId) === '—' ? 'pd-muted' : '']">{{ recordVal(selectedRecord, field.fieldId) }}</span>
                      </div>
                    </div>
                  </div>
                </div>

              </div><!-- /pd-shell -->
            </div><!-- /pd-scroll -->
          </template>

        </aside>
      </transition>
    </div>
  </section>
</template>

<style scoped>
.worksheet-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--surface);
}

.ws-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.ws-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ws-title h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}

.ws-actions {
  display: flex;
  flex: 1;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}

.ws-workflow-actions {
  margin-left: auto;
  margin-right: auto;
}

.ws-search {
  width: 220px;
}

.ws-subbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}

.ws-subbar-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ws-subbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-3);
  font-size: 12.5px;
}

.ws-pagination-info {
  color: var(--text-3);
  font-size: 12px;
  font-family: var(--mono);
}

/* ===== 主体：表格 + 详情面板 ===== */
.ws-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.worksheet-view.is-personnel-drawer .ws-body {
  gap: 14px;
  padding: 14px 20px 20px;
  align-items: stretch;
  background: var(--bg);
}

.ws-table-section {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ws-table-wrap {
  flex: 1;
  min-height: 0;
  padding: 0 20px 20px;
  display: flex;
  flex-direction: column;
}

.worksheet-view.is-personnel-drawer .ws-table-section {
  flex: 1 1 auto;
  min-width: 0;
}

.worksheet-view.is-personnel-drawer .ws-table-wrap {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.worksheet-view.is-personnel-drawer .virtual-table-resizer {
  border: 0;
}

.worksheet-view.is-personnel-drawer.has-detail-open .ws-table-section {
  flex: 1 1 50%;
}

.virtual-table-resizer {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-top: 0;
  overflow: hidden;
}

.ws-virtual-table {
  --el-table-header-bg-color: var(--surface-2);
  --el-table-row-hover-bg-color: #eef4ff;
  font-size: 12px;
}

.ws-virtual-table :deep(.el-table-v2__header-cell) {
  background: var(--surface-2);
  color: var(--text-2);
  font-weight: 600;
}

.ws-virtual-table :deep(.el-table-v2__row) {
  cursor: pointer;
}

.ws-virtual-table :deep(.el-table-v2__row.is-selected-row),
.ws-virtual-table :deep(.el-table-v2__row.is-selected-row .el-table-v2__row-cell) {
  background: #eaf2ff;
}

.ws-virtual-table :deep(.el-table-v2__row-cell) {
  border-right: 1px solid var(--border);
}

.virtual-cell-text {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.virtual-index-cell {
  color: var(--text-3);
  font-family: var(--mono);
}

.virtual-row-checkbox {
  width: 14px;
  height: 14px;
  margin: 0;
  vertical-align: middle;
  cursor: pointer;
}

.ws-virtual-table :deep(.virtual-row-actions) {
  justify-content: center;
  width: 100%;
  gap: 6px;
}

.ws-virtual-table :deep(.virtual-action-button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 11.5px;
  line-height: 24px;
  font-weight: 500;
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
  appearance: none;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.ws-virtual-table :deep(.virtual-action-button.is-primary) {
  border-color: #91caff;
  background: #f0f7ff;
  color: var(--primary);
}

.ws-virtual-table :deep(.virtual-action-button.is-primary:hover) {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.ws-virtual-table :deep(.virtual-action-button.is-danger) {
  border-color: #ffccc7;
  background: var(--danger-soft);
  color: #ff4d4f;
}

.ws-virtual-table :deep(.virtual-action-button.is-danger:hover) {
  border-color: #ff7875;
  background: #fff1f0;
}

.ws-virtual-table :deep(.virtual-action-icon) {
  display: inline-flex;
  width: 11px;
  height: 11px;
  line-height: 1;
  flex: 0 0 11px;
}

.ws-virtual-table :deep(.virtual-action-icon svg) {
  width: 11px;
  height: 11px;
  display: block;
}

.ws-empty {
  display: grid;
  place-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-3);
  text-align: center;
}

.ws-empty strong {
  color: var(--text);
  font-size: 15px;
}

.ws-empty span {
  font-size: 12.5px;
  color: var(--text-3);
}

.row-actions-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  white-space: nowrap;
}

.row-actions-inline .el-button {
  margin-left: 0;
  padding: 0 2px;
}

/* ===== 右侧详情面板 ===== */
.ws-detail-panel {
  flex: 0 0 45%;
  min-width: 340px;
  max-width: 680px;
  border-left: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.worksheet-view.is-personnel-drawer .ws-detail-panel {
  flex: 1 1 50%;
  min-width: 520px;
  max-width: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  background: var(--surface);
}

.ws-detail-hero {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 20px 16px 16px;
  background: linear-gradient(135deg, #2f54eb 0%, #1d39c4 100%);
  color: #fff;
  position: relative;
  flex-shrink: 0;
}

.ws-detail-avatar {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.22);
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
  letter-spacing: 0.02em;
}

.ws-detail-hero-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ws-detail-hero-info strong {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  line-height: 1.2;
}

.ws-detail-hero-info span {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-detail-unit {
  font-size: 11.5px !important;
  color: rgba(255, 255, 255, 0.6) !important;
  font-family: inherit !important;
}

.ws-detail-close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  font-size: 14px;
  transition: background 0.12s;
}

.ws-detail-close:hover {
  background: rgba(255, 255, 255, 0.28);
  color: #fff;
}

.ws-detail-toolbar {
  display: flex;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.ws-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px 20px;
}

.record-update-stamp {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 8px 10px;
  border: 1px solid #99f6e4;
  border-radius: 6px;
  background: #ecfdf5;
  color: #0f766e;
  font-size: 12px;
}

.record-update-stamp span {
  color: #0d9488;
  font-weight: 600;
}

.record-update-stamp strong {
  color: #115e59;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  text-align: right;
}

.record-update-stamp-pd {
  margin-bottom: 10px;
}

.ws-detail-kv {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}

.ws-detail-kv-row {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 0 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}

.ws-detail-kv-row:last-child,
.ws-detail-kv-row:nth-last-child(2) {
  border-bottom: none;
}

.ws-kv-key {
  color: var(--text-3);
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.ws-kv-val {
  color: var(--text);
  font-size: 12.5px;
  word-break: break-all;
  min-width: 0;
}

/* ========== 人员卡 pd-* ========== */

.pd-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}

.pd-spacer { flex: 1; }

.pd-close-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
  font-size: 14px;
  transition: background 0.12s;
}
.pd-close-btn:hover { background: var(--gray-soft); color: var(--text); }

.pd-scroll {
  flex: 1;
  overflow-y: auto;
  background: var(--bg);
}

.pd-shell {
  background: var(--surface);
  margin: 14px 16px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

/* Hero */
.pd-hero {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 18px 20px 14px;
  align-items: flex-start;
}

.pd-hero-main {
  flex: 1 1 220px;
  min-width: 0;
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.pd-hero-text { flex: 1; min-width: 0; }

.pd-avatar {
  width: 50px;
  height: 50px;
  border-radius: 10px;
  background: var(--primary);
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 18px;
  letter-spacing: -0.02em;
  flex-shrink: 0;
}

.pd-name {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--text);
}

.pd-nm { white-space: nowrap; }

.pd-pos-job {
  font-size: 12.5px;
  color: var(--text-2);
  font-weight: 500;
}

.pd-id-line {
  font-size: 12px;
  color: var(--text-3);
  font-family: var(--mono);
  margin-top: 5px;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.pd-copyable {
  cursor: pointer;
  border-bottom: 1px dashed var(--border-strong);
  padding-bottom: 1px;
  transition: color 0.12s, border-color 0.12s;
}
.pd-copyable:hover { color: var(--primary); border-bottom-color: var(--primary); }

.pd-sep { color: var(--text-muted); }

.pd-tag-row {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.pd-tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
}
.pd-tag-gray  { background: var(--gray-soft);    color: var(--gray-text); }
.pd-tag-green { background: var(--success-soft); color: var(--success); }
.pd-tag-warn  { background: var(--warn-soft);    color: var(--warn); }
.pd-tag-blue  { background: var(--primary-soft); color: var(--primary); }

.pd-quick-stats {
  display: flex;
  gap: 18px;
  text-align: right;
  padding-left: 12px;
  border-left: 1px solid var(--border);
  flex-wrap: wrap;
}

.pd-qs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 56px;
}
.pd-qk { font-size: 10.5px; color: var(--text-3); letter-spacing: 0.03em; }
.pd-qv { font-size: 13px; font-weight: 600; color: var(--text); }
.pd-mono { font-family: var(--mono); font-size: 12px; font-weight: 500; }

/* Tab bar */
.pd-tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  padding: 0 12px;
  gap: 0;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.pd-tab {
  position: relative;
  padding: 9px 12px 10px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: color 0.12s;
  white-space: nowrap;
  user-select: none;
}
.pd-tab:hover { color: var(--text); }
.pd-tab-active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 600;
}

.pd-tab-num {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-muted);
  background: var(--gray-soft);
  border-radius: 3px;
  padding: 1px 4px;
}
.pd-tab-active .pd-tab-num { background: var(--primary-soft); color: var(--primary); }

/* Pane content */
.pd-pane { padding: 0 0 8px; }

.pd-section {
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--border);
}
.pd-section:last-child { border-bottom: none; }

.pd-section-title {
  margin: 0 0 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  text-transform: none;
  letter-spacing: 0.01em;
}

.pd-kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0;
}

.pd-kv-grid-wide {
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}

.pd-kv {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 0 8px;
  padding: 5px 6px;
  border-bottom: 1px solid var(--border);
}
.pd-kv:nth-last-child(-n+2) { border-bottom: none; }

.pd-k {
  font-size: 11.5px;
  color: var(--text-3);
  font-weight: 500;
  white-space: nowrap;
}

.pd-v {
  font-size: 12.5px;
  color: var(--text);
  word-break: break-all;
  min-width: 0;
}
.pd-muted { color: var(--text-muted) !important; }

.pd-remark {
  font-size: 12.5px;
  color: var(--text);
  white-space: pre-wrap;
  line-height: 1.6;
}

.pd-loading, .pd-empty-tip {
  font-size: 12px;
  padding: 6px 0;
}

/* Tables */
.pd-table-wrap { overflow-x: auto; }

.pd-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.pd-table th, .pd-table td {
  padding: 5px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.pd-table th {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
  background: var(--gray-soft);
}
.pd-table td { color: var(--text); }
.pd-table tbody tr:last-child td { border-bottom: none; }

.pd-teach-footer {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-2);
}
.pd-teach-footer b { color: var(--text); }
.pd-teach-footer-extra { margin-left: 16px; }

/* Timeline */
.pd-timeline {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.pd-tl-item {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.pd-tl-item:last-child { border-bottom: none; }

.pd-tl-when {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-3);
  white-space: nowrap;
  padding-top: 2px;
  min-width: 100px;
}

.pd-tl-body { flex: 1; min-width: 0; font-size: 12.5px; }

.pd-tl-where { color: var(--text); font-weight: 500; }

.pd-tl-role { color: var(--text-2); }

.pd-tl-note {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-3);
}

/* ===== 详情面板滑入动画 ===== */
.detail-slide-enter-active,
.detail-slide-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.detail-slide-enter-from,
.detail-slide-leave-to {
  transform: translateX(20px);
  opacity: 0;
}

@media (max-width: 1180px) {
  .worksheet-view.is-personnel-drawer .ws-body {
    flex-direction: column;
    overflow: auto;
  }

  .worksheet-view.is-personnel-drawer .ws-table-section,
  .worksheet-view.is-personnel-drawer.has-detail-open .ws-table-section,
  .worksheet-view.is-personnel-drawer .ws-detail-panel {
    flex: 0 0 auto;
    min-width: 0;
  }

  .worksheet-view.is-personnel-drawer .ws-table-wrap {
    min-height: 420px;
  }

  .worksheet-view.is-personnel-drawer .ws-detail-panel {
    min-height: 420px;
  }
}
</style>
