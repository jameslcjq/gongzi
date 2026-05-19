<script setup lang="ts">
import { FolderOpened, Refresh, SwitchButton } from '@element-plus/icons-vue'
import type { ImportWatcherStatus } from '@shared/types'

defineProps<{
  status?: ImportWatcherStatus | null
  loading?: boolean
}>()

defineEmits<{
  refresh: []
  openFolder: []
  chooseFolder: []
  start: []
  stop: []
}>()
</script>

<template>
  <section class="import-watcher">
    <div class="watcher-main">
      <div>
        <div class="watcher-title">
          <strong>Excel 自动导入</strong>
          <el-tag :type="status?.running ? 'success' : 'info'" effect="plain">
            {{ status?.running ? '监听中' : '已停止' }}
          </el-tag>
        </div>
        <p>{{ status?.folderPath || '正在初始化监控文件夹' }}</p>
        <small v-if="status?.templateFolderPath">模板目录：{{ status.templateFolderPath }}</small>
      </div>
      <div class="watcher-actions">
        <el-button :icon="Refresh" :loading="loading" @click="$emit('refresh')">刷新</el-button>
        <el-button :icon="FolderOpened" @click="$emit('openFolder')">打开文件夹</el-button>
        <el-button :icon="FolderOpened" @click="$emit('chooseFolder')">选择文件夹</el-button>
        <el-button
          v-if="status?.running"
          :icon="SwitchButton"
          @click="$emit('stop')"
        >
          停止监听
        </el-button>
        <el-button
          v-else
          type="primary"
          :icon="SwitchButton"
          @click="$emit('start')"
        >
          开始监听
        </el-button>
      </div>
    </div>

    <div v-if="status?.logs.length" class="watcher-logs">
      <div v-for="log in status.logs.slice(0, 4)" :key="`${log.fileName}-${log.createdAt}`">
        <el-tag :type="log.ok ? 'success' : 'danger'" size="small" effect="plain">
          {{ log.ok ? '成功' : '失败' }}
        </el-tag>
        <span>{{ log.fileName }}</span>
        <small>{{ log.message }}</small>
      </div>
    </div>
  </section>
</template>
