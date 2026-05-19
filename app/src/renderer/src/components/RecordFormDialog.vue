<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { WorksheetField, WorksheetRecord, WorksheetRecordValue } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  worksheetName: string
  fields: WorksheetField[]
  initialValues?: WorksheetRecord
  mode: 'create' | 'edit'
  saving?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'submit', values: Record<string, WorksheetRecordValue>): void
}>()

const formState = reactive<{ values: Record<string, WorksheetRecordValue> }>({ values: {} })

const visibleFields = computed(() =>
  props.fields
    .map((field, index) => ({ ...field, displayOrder: field.displayOrder ?? index }))
    .filter((field) => !field.hidden)
    .sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0))
)

const localColumnNames = computed(() => {
  const used = new Map<string, number>()
  const result = new Map<string, string>()
  for (const field of props.fields) {
    const baseName = field.name || field.fieldId
    const count = used.get(baseName) ?? 0
    used.set(baseName, count + 1)
    result.set(field.fieldId, count === 0 ? baseName : `${baseName}_${count + 1}`)
  }
  return result
})

const budgetStatusOptions = computed(() => {
  if (props.worksheetName === '预算在职') return ['正常', '调出人员']
  if (props.worksheetName === '预算退休' || props.worksheetName === '预算其他') return ['正常', '去世']
  return []
})

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return
    formState.values = {}
    for (const field of props.fields) {
      const columnName = localColumnNames.value.get(field.fieldId) ?? field.fieldId
      const initial = props.initialValues?.[columnName]
      formState.values[columnName] = initial ?? null
    }
    if (budgetStatusOptions.value.length > 0) {
      formState.values.md_status = props.initialValues?.md_status ?? '正常'
    }
  },
  { immediate: true }
)

function close() {
  emit('update:modelValue', false)
}

function submit() {
  const cleaned: Record<string, WorksheetRecordValue> = {}
  for (const [key, value] of Object.entries(formState.values)) {
    cleaned[key] = value === '' ? null : value
  }
  emit('submit', cleaned)
}

function isNumericField(field: WorksheetField): boolean {
  return field.controlType === 6 || field.controlType === 31
}

function fieldOptions(field: WorksheetField): string[] {
  return field.options?.filter((option) => option.trim()) ?? []
}

function hasOptions(field: WorksheetField): boolean {
  return fieldOptions(field).length > 0
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="mode === 'create' ? `新增 ${worksheetName}` : `编辑 ${worksheetName}`"
    width="900px"
    :close-on-click-modal="false"
    @update:model-value="close"
  >
    <el-form label-position="top" class="record-form-grid">
      <el-form-item v-if="budgetStatusOptions.length > 0" label="状态">
        <el-select
          v-model="(formState.values.md_status as string)"
          clearable
          filterable
          style="width: 100%"
          placeholder="请选择状态"
        >
          <el-option
            v-for="option in budgetStatusOptions"
            :key="option"
            :label="option"
            :value="option"
          />
        </el-select>
      </el-form-item>
      <el-form-item v-for="field in visibleFields" :key="field.fieldId" :label="field.name">
        <el-select
          v-if="hasOptions(field)"
          v-model="(formState.values[localColumnNames.get(field.fieldId) ?? field.fieldId] as string)"
          clearable
          filterable
          style="width: 100%"
          :placeholder="field.desc || '请选择'"
        >
          <el-option
            v-for="option in fieldOptions(field)"
            :key="option"
            :label="option"
            :value="option"
          />
        </el-select>
        <el-input-number
          v-else-if="isNumericField(field)"
          v-model="(formState.values[localColumnNames.get(field.fieldId) ?? field.fieldId] as number)"
          :controls="false"
          :precision="2"
          style="width: 100%"
          :placeholder="field.desc"
        />
        <el-input
          v-else
          v-model="(formState.values[localColumnNames.get(field.fieldId) ?? field.fieldId] as string)"
          :placeholder="field.desc"
          clearable
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>
