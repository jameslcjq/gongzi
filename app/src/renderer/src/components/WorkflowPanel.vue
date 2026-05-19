<script setup lang="ts">
import { computed } from 'vue'
import { Lock, VideoPlay, Warning } from '@element-plus/icons-vue'
import type { WorkflowDefinition } from '@shared/types'

const props = defineProps<{
  workflows: WorkflowDefinition[]
  runningKey?: string
}>()

defineEmits<{
  run: [workflowKey: string]
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

function statusTag(workflow: WorkflowDefinition): {
  type: 'success' | 'warning' | 'info' | 'danger'
  text: string
} {
  if (workflow.status === 'ready') return { type: 'success', text: '可执行' }
  if (workflow.status === 'blocked-by-source') return { type: 'danger', text: '待确认取数' }
  return { type: 'warning', text: '待补规则' }
}
</script>

<template>
  <section class="workflow-panel">
    <div class="section-heading">
      <h2>启用工作流</h2>
      <span>{{ workflows.length }} 个服务函数</span>
    </div>

    <div class="workflow-groups">
      <div v-for="group in moduleGroups" :key="group.module" class="workflow-group">
        <div class="workflow-group-title">{{ group.module }}</div>
        <div class="workflow-list">
          <div v-for="workflow in group.items" :key="workflow.key" class="workflow-item">
            <div class="workflow-info">
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
              :loading="runningKey === workflow.key"
              @click="$emit('run', workflow.key)"
            >
              试运行
            </el-button>
            <el-button
              v-else
              size="small"
              type="primary"
              :icon="VideoPlay"
              :loading="runningKey === workflow.key"
              @click="$emit('run', workflow.key)"
            >
              执行
            </el-button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
