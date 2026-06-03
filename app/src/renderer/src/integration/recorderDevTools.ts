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
  screenshotPath?: string
  screenshotFileName?: string
  screenshotError?: string
  screenshotCapturedAt?: string
  [key: string]: unknown
}

type PortalFrameDrainValue = {
  events?: unknown
}

type ScreenshotMeta = {
  kind: string
  path: string
  fileName: string
  capturedAt: string
}

type RecorderApi = {
  execInAllPortalFrames: (webContentsId: number, code: string) => Promise<{
    ok: boolean
    count?: number
    reason?: string
  }>
  drainAllPortalFrames: (webContentsId: number, code: string) => Promise<{
    ok: boolean
    results: Array<{ value?: unknown }>
    reason?: string
  }>
  savePortalRecording: (
    json: string,
    defaultFileName?: string
  ) => Promise<{ ok: true; path: string } | { ok: false; reason: string; canceled?: boolean }>
  capturePortalRecordingScreenshot: (
    webContentsId: number,
    options: { sessionId: string; sequence: number; kind?: string }
  ) => Promise<{
    ok: true
    path: string
    fileName: string
    folder: string
  } | { ok: false; reason: string }>
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
  let draining = false
  let sessionId = ''
  let screenshotSeq = 0
  let screenshotCount = 0
  let screenshotFolder = ''
  let initialScreenshot: ScreenshotMeta | undefined
  let finalScreenshot: ScreenshotMeta | undefined
  let screenshotFailures: Array<{ sequence: number; kind: string; reason: string }> = []

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
    stopBtn.textContent = `停止录制（${events.length} 条 / ${screenshotCount} 图）`
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
    sessionId = `一体化录制-${formatLocalTimestamp(new Date())}`
    screenshotSeq = 0
    screenshotCount = 0
    screenshotFolder = ''
    initialScreenshot = undefined
    finalScreenshot = undefined
    screenshotFailures = []
    updateButtons()
    initialScreenshot = await captureScreenshot(webContentsId, 'start')
    updateButtons()

    const drainCode = buildRecorderDrainScript()
    const installCode = buildRecorderInstallScript()
    pollTimer = window.setInterval(async () => {
      if (!recording || draining) return
      const current = options.activeWebview()
      if (!current) return
      const currentWebContentsId = current.getWebContentsId()
      draining = true
      try {
        try {
          await options.api.execInAllPortalFrames(currentWebContentsId, installCode)
        } catch {}
        try {
          const res = await options.api.drainAllPortalFrames(currentWebContentsId, drainCode)
          if (res.ok) {
            const added = appendEvents(res.results)
            await captureScreenshotsForEvents(currentWebContentsId, added)
          }
        } catch {}
      } finally {
        draining = false
        updateButtons()
      }
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
        if (res.ok) {
          const added = appendEvents(res.results)
          await captureScreenshotsForEvents(webContentsId, added)
        }
        finalScreenshot = await captureScreenshot(webContentsId, 'stop')
        await options.api.execInAllPortalFrames(webContentsId, buildRecorderStopScript())
      } catch {}
    }

    updateButtons()
    if (!events.length && screenshotCount === 0) {
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
      screenshots: {
        count: screenshotCount,
        folder: screenshotFolder || undefined,
        initial: initialScreenshot,
        final: finalScreenshot,
        failures: screenshotFailures
      },
      events
    }
    const save = await options.api.savePortalRecording(
      JSON.stringify(summary, null, 2),
      `${sessionId || '一体化录制'}.json`
    )
    if (save.ok) {
      window.alert(`录制已保存：${save.path}（${summary.totalEvents} 条事件，${screenshotCount} 张截图）`)
    } else if (!save.canceled) {
      window.alert('保存失败：' + (save.reason || '未知错误'))
    }
  }

  function appendEvents(results: Array<{ value?: unknown }>): RecordingEvent[] {
    const added: RecordingEvent[] = []
    for (const result of results) {
      const value = result.value as PortalFrameDrainValue | undefined
      const nextEvents = value && Array.isArray(value.events) ? value.events : []
      if (nextEvents.length) {
        const normalized = nextEvents as RecordingEvent[]
        events.push(...normalized)
        added.push(...normalized)
      }
    }
    return added
  }

  async function captureScreenshotsForEvents(
    webContentsId: number,
    nextEvents: RecordingEvent[]
  ): Promise<void> {
    for (const event of nextEvents) {
      if (!shouldCaptureEventScreenshot(event)) continue
      const shot = await captureScreenshot(webContentsId, event.kind)
      if (shot) {
        event.screenshotPath = shot.path
        event.screenshotFileName = shot.fileName
        event.screenshotCapturedAt = shot.capturedAt
      } else {
        const failure = screenshotFailures[screenshotFailures.length - 1]
        if (failure) event.screenshotError = failure.reason
      }
    }
  }

  async function captureScreenshot(
    webContentsId: number,
    kind: string
  ): Promise<ScreenshotMeta | undefined> {
    const sequence = ++screenshotSeq
    try {
      const res = await options.api.capturePortalRecordingScreenshot(webContentsId, {
        sessionId: sessionId || '一体化录制',
        sequence,
        kind
      })
      if (!res.ok) {
        screenshotFailures.push({ sequence, kind, reason: res.reason || '未知错误' })
        return undefined
      }
      screenshotCount += 1
      screenshotFolder = res.folder
      return {
        kind,
        path: res.path,
        fileName: res.fileName,
        capturedAt: new Date().toISOString()
      }
    } catch (error) {
      screenshotFailures.push({
        sequence,
        kind,
        reason: error instanceof Error ? error.message : String(error)
      })
      return undefined
    }
  }

  function shouldCaptureEventScreenshot(event: RecordingEvent): boolean {
    return event.kind === 'click' || event.kind === 'navigation'
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

function formatLocalTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
}
