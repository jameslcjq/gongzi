<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Plus } from '@element-plus/icons-vue'
import type { WorksheetField } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  worksheetName: string
  fields: WorksheetField[]
  saving?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'save', fields: WorksheetField[]): void
}>()

const draftFields = ref<WorksheetField[]>([])
const originalFieldIds = computed(() => new Set(props.fields.map((field) => field.fieldId)))

const fieldTypes = [
  { label: '文本', type: '文本框', controlType: 2, desc: 'String text' },
  { label: '数值', type: '数值', controlType: 6, desc: 'Double number' },
  { label: '证件号', type: '证件', controlType: 7, desc: 'String text' }
]

const canSave = computed(() =>
  draftFields.value.every((field) => field.name.trim()) && !props.saving
)

watch(
  () => [props.modelValue, props.fields] as const,
  () => {
    if (!props.modelValue) return
    draftFields.value = props.fields
      .map((field, index) => ({ ...field, displayOrder: field.displayOrder ?? index }))
      .sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0))
  },
  { immediate: true }
)

function close() {
  emit('update:modelValue', false)
}

function addField() {
  const option = fieldTypes[0]
  draftFields.value.push({
    fieldId: '',
    name: '',
    type: option.type,
    controlType: option.controlType,
    desc: option.desc
  })
}

function changeType(field: WorksheetField, controlType: number) {
  const option = fieldTypes.find((item) => item.controlType === controlType) ?? fieldTypes[0]
  field.type = option.type
  field.controlType = option.controlType
  field.desc = option.desc
}

function moveField(index: number, direction: -1 | 1) {
  const nextIndex = index + direction
  if (nextIndex < 0 || nextIndex >= draftFields.value.length) return
  const next = [...draftFields.value]
  const [item] = next.splice(index, 1)
  next.splice(nextIndex, 0, item)
  draftFields.value = next
}

function save() {
  if (!canSave.value) return
  emit(
    'save',
    draftFields.value.map((field, index) => ({
      ...field,
      name: field.name.trim(),
      hidden: Boolean(field.hidden),
      displayOrder: index
    }))
  )
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    :title="`${worksheetName} - 字段结构`"
    direction="rtl"
    size="760px"
    @update:model-value="close"
  >
    <div class="field-toolbar">
      <el-button :icon="Plus" type="primary" plain @click="addField">新增字段</el-button>
      <el-button type="primary" :loading="saving" :disabled="!canSave" @click="save">
        保存显示设置
      </el-button>
    </div>

    <el-table :data="draftFields" border stripe size="small" height="calc(100vh - 170px)">
      <el-table-column label="#" width="54" align="center">
        <template #default="{ $index }">{{ $index + 1 }}</template>
      </el-table-column>
      <el-table-column label="字段名称" min-width="180" fixed>
        <template #default="{ row }">
          <el-input
            v-model="row.name"
            size="small"
            placeholder="与 Excel 表头一致"
            :disabled="originalFieldIds.has(row.fieldId)"
          />
        </template>
      </el-table-column>
      <el-table-column label="显示" width="86" align="center">
        <template #default="{ row }">
          <el-switch
            :model-value="!row.hidden"
            inline-prompt
            active-text="显示"
            inactive-text="隐藏"
            @change="(value: boolean) => { row.hidden = !value }"
          />
        </template>
      </el-table-column>
      <el-table-column label="类型" width="120">
        <template #default="{ row }">
          <el-select
            :model-value="row.controlType"
            size="small"
            @change="(value: number) => changeType(row, value)"
          >
            <el-option
              v-for="item in fieldTypes"
              :key="item.controlType"
              :label="item.label"
              :value="item.controlType"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="顺序" width="94" align="center">
        <template #default="{ $index }">
          <el-button
            text
            :icon="ArrowUp"
            size="small"
            :disabled="$index === 0"
            @click="moveField($index, -1)"
          />
          <el-button
            text
            :icon="ArrowDown"
            size="small"
            :disabled="$index === draftFields.length - 1"
            @click="moveField($index, 1)"
          />
        </template>
      </el-table-column>
      <el-table-column prop="fieldId" label="字段ID" min-width="220" show-overflow-tooltip />
    </el-table>
  </el-drawer>
</template>

<style scoped>
.field-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
</style>
