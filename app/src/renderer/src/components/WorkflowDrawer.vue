<script setup lang="ts">
import { computed } from 'vue'
import { Lock, VideoPlay, Warning } from '@element-plus/icons-vue'
import type { WorkflowDefinition, WorkflowRunResult } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  workflows: WorkflowDefinition[]
  runningKey: string
  lastResult: WorkflowRunResult | null
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'run', workflowKey: string): void
}>()

const moduleGroups = computed(() => {
  const map = new Map<string, WorkflowDefinition[]>()
  for (const workflow of props.workflows) {
    const list = map.get(workflow.module) ?? []
    list.push(workflow)
    map.set(workflow.module, list)
  }
  return Array.from(map.entries()).map(([module, items]) => ({ module, items }))
})

function statusTag(workflow: WorkflowDefinition) {
  if (workflow.status === 'ready') return { type: 'success' as const, text: '可执行' }
  if (workflow.status === 'blocked-by-source') return { type: 'danger' as const, text: '待确认取数' }
  return { type: 'warning' as const, text: '待补规则' }
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    title="启用工作流"
    direction="rtl"
    size="520px"
    @update:model-value="close"
  >
    <el-alert
      v-if="lastResult"
      :type="lastResult.ok ? 'success' : 'info'"
      :title="`${lastResult.workflowName}：${lastResult.ok ? '执行完成' : '待补规则'}`"
      :description="[...lastResult.messages, ...lastResult.warnings].join('；')"
      show-icon
      :closable="false"
      style="margin-bottom: 12px"
    />

    <div v-for="group in moduleGroups" :key="group.module" class="wf-group">
      <div class="wf-group-title">{{ group.module }}</div>
      <div v-for="workflow in group.items" :key="workflow.key" class="wf-row">
        <div class="wf-info">
          <strong>{{ workflow.name }}</strong>
          <el-tag size="small" :type="statusTag(workflow).type" effect="plain">
            {{ statusTag(workflow).text }}
          </el-tag>
        </div>
        <el-tooltip
          v-if="workflow.status === 'blocked-by-source' && workflow.blockedReason"
          :content="workflow.blockedReason"
          placement="top"
        >
          <el-button size="small" :icon="Lock" disabled>暂未开放</el-button>
        </el-tooltip>
        <el-button
          v-else-if="workflow.status === 'needs-rule'"
          size="small"
          :icon="Warning"
          disabled
        >
          暂未开放
        </el-button>
        <el-button
          v-else
          size="small"
          type="primary"
          :icon="VideoPlay"
          :loading="runningKey === workflow.key"
          @click="emit('run', workflow.key)"
        >
          执行
        </el-button>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.wf-group {
  margin-bottom: 16px;
}

.wf-group-title {
  margin-bottom: 8px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.wf-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-2);
  margin-bottom: 6px;
  transition: border-color 0.12s;
}

.wf-row:hover {
  border-color: var(--border-strong);
}

.wf-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.wf-info strong {
  font-size: 13px;
  color: var(--text);
}
</style>
