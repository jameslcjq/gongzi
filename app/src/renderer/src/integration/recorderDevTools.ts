import {
  buildRecorderDrainScript,
  buildRecorderInstallScript,
  buildRecorderStopScript
} from './recorderScript'

type PortalWebview = HTMLElement & {
  getWebContentsId: () => number
}

type RecordingEvent = {
  t: number
  frameUrl: string
  kind: 'fetch' | 'xhr' | 'click' | 'navigation'
  [key: string]: unknown
}

type RecorderApi = {
  execInAllPortalFrames: (webContentsId: number, code: string) => Promise<{
    ok: boolean
    count?: number
    reason?: string
  }>
  drainAllPortalFrames: (webContentsId: number, code: string) => Promise<{
    ok: boolean
    results: Array<{ value?: { events?: RecordingEvent[] } }>
  }>
  savePortalRecording: (json: string) => Promise<{ ok: boolean; path?: string; reason?: string; canceled?: boolean }>
}

export function mountPortalRecorderDevTools(options: {
  target: HTMLElement
  activeWebview: () => PortalWebview | undefined
  api: RecorderApi
}): () => void {
  let recording = false
  let recordingStart = 0
  let events: RecordingEvent[] = []
  let pollTimer: number | null = null

  const startBtn = createButton('开始录制')
  startBtn.style.borderColor = '#dc2626'
  startBtn.style.color = '#dc2626'
  const stopBtn = createButton('停止录制')
  stopBtn.style.borderColor = '#dc2626'
  stopBtn.style.background = '#dc2626'
  stopBtn.style.color = '#fff'
  stopBtn.style.display = 'none'

  startBtn.addEventListener('click', () => void startRecording())
  stopBtn.addEventListener('click', () => void stopRecording())
  options.target.appendChild(startBtn)
  options.target.appendChild(stopBtn)

  function updateButtons(): void {
    startBtn.style.display = recording ? 'none' : ''
    stopBtn.style.display = recording ? '' : 'none'
    stopBtn.textContent = `停止录制（${events.length} 条）`
  }

  async function startRecording(): Promise<void> {
    if (recording) return
    const webview = options.activeWebview()
    if (!webview) {
      window.alert('一体化页面尚未就绪')
      return
    }
    const webContentsId = webview.getWebContentsId()
    const installRes = await options.api.execInAllPortalFrames(
      webContentsId,
      buildRecorderInstallScript()
    )
    if (!installRes.ok) {
      window.alert('录制安装失败：' + (installRes.reason || '未知错误'))
      return
    }

    recording = true
    events = []
    recordingStart = Date.now()
    updateButtons()

    const drainCode = buildRecorderDrainScript()
    const installCode = buildRecorderInstallScript()
    pollTimer = window.setInterval(async () => {
      if (!recording) return
      const current = options.activeWebview()
      if (!current) return
      const currentWebContentsId = current.getWebContentsId()
      try {
        await options.api.execInAllPortalFrames(currentWebContentsId, installCode)
      } catch {}
      try {
        const res = await options.api.drainAllPortalFrames(currentWebContentsId, drainCode)
        if (res.ok) appendEvents(res.results)
      } catch {}
      updateButtons()
    }, 1500)
  }

  async function stopRecording(): Promise<void> {
    if (!recording) return
    recording = false
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }

    const webview = options.activeWebview()
    if (webview) {
      try {
        const webContentsId = webview.getWebContentsId()
        const res = await options.api.drainAllPortalFrames(webContentsId, buildRecorderDrainScript())
        if (res.ok) appendEvents(res.results)
        await options.api.execInAllPortalFrames(webContentsId, buildRecorderStopScript())
      } catch {}
    }

    updateButtons()
    if (!events.length) {
      window.alert('录制已停止，但没有捕获到事件')
      return
    }

    events.sort((a, b) => a.t - b.t)
    const summary = {
      startedAt: new Date(recordingStart).toISOString(),
      durationMs: Date.now() - recordingStart,
      totalEvents: events.length,
      byKind: events.reduce(
        (acc, event) => {
          acc[event.kind] = (acc[event.kind] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      ),
      events
    }
    const save = await options.api.savePortalRecording(JSON.stringify(summary, null, 2))
    if (save.ok) window.alert(`录制已保存：${save.path}（${summary.totalEvents} 条事件）`)
    else if (!save.canceled) window.alert('保存失败：' + (save.reason || '未知错误'))
  }

  function appendEvents(results: Array<{ value?: { events?: RecordingEvent[] } }>): void {
    for (const result of results) {
      const nextEvents = result.value?.events
      if (Array.isArray(nextEvents) && nextEvents.length) events.push(...nextEvents)
    }
  }

  return () => {
    if (pollTimer !== null) window.clearInterval(pollTimer)
    startBtn.remove()
    stopBtn.remove()
  }
}

function createButton(text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = text
  button.style.cssText = [
    'height:32px',
    'padding:0 12px',
    'border:1px solid #cbd5e1',
    'border-radius:6px',
    'background:#fff',
    'font-size:13px',
    'cursor:pointer'
  ].join(';')
  return button
}
