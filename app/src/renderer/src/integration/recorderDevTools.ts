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
  kind: string
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
  startPortalNativeRecording: (
    sessionId: string,
    webContentsIds: number[]
  ) => Promise<{ ok: true; attached: number; tracked: number } | { ok: false; reason: string }>
  drainPortalNativeRecording: (
    sessionId: string
  ) => Promise<{ ok: true; events: Array<Record<string, unknown>> }>
  stopPortalNativeRecording: (
    sessionId: string
  ) => Promise<{ ok: true; events: Array<Record<string, unknown>> }>
}

const FRAME_SCRIPT_TIMEOUT_MS = 5000
const NATIVE_RECORDER_TIMEOUT_MS = 3000
const SCREENSHOT_TIMEOUT_MS = 3500
const EVENT_SCREENSHOT_LIMIT_PER_DRAIN = 3

export function mountPortalRecorderDevTools(options: {
  target: HTMLElement
  activeWebview: () => PortalWebview | undefined
  webviews?: () => PortalWebview[]
  api: RecorderApi
}): () => void {
  let recording = false
  let stopping = false
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
  let lastTargetCount = 0
  let lastInstalledFrameCount = 0
  let lastNativeTrackedCount = 0

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
    const active = recording || stopping
    startBtn.style.display = active ? 'none' : ''
    startBtn.disabled = active
    stopBtn.style.display = active ? '' : 'none'
    stopBtn.disabled = stopping
    stopBtn.style.cursor = stopping ? 'wait' : 'pointer'
    stopBtn.style.opacity = stopping ? '0.78' : '1'
    stopBtn.textContent = stopping
      ? `正在停止…（${events.length} 条 / ${screenshotCount} 图）`
      : `停止录制（${events.length} 条 / ${screenshotCount} 图 / ${lastInstalledFrameCount} frame / ${lastNativeTrackedCount} 原始）`
  }

  async function startRecording(): Promise<void> {
    if (recording || stopping) return
    const targets = listTargetWebviews()
    if (!targets.length) {
      window.alert('一体化页面尚未就绪')
      return
    }
    sessionId = `一体化录制-${formatLocalTimestamp(new Date())}`
    const nativeRes = await startNativeRecording(targets)
    const installRes = await installRecorderIntoTargets(targets, buildRecorderInstallScript(sessionId))
    if (!installRes.ok || installRes.frameCount <= 0) {
      window.alert(
        '录制安装失败：' +
          (installRes.reason || '没有成功注入到门户页面，请等页面加载完成后再试')
      )
      return
    }

    recording = true
    events = []
    recordingStart = Date.now()
    screenshotSeq = 0
    screenshotCount = 0
    screenshotFolder = ''
    initialScreenshot = undefined
    finalScreenshot = undefined
    screenshotFailures = []
    lastTargetCount = targets.length
    lastInstalledFrameCount = installRes.frameCount
    lastNativeTrackedCount = nativeRes.tracked
    updateButtons()
    initialScreenshot = await captureScreenshot(targets[0].getWebContentsId(), 'start')
    updateButtons()

    const drainCode = buildRecorderDrainScript()
    const installCode = buildRecorderInstallScript(sessionId)
    pollTimer = window.setInterval(async () => {
      if (!recording || draining) return
      const currentTargets = listTargetWebviews()
      if (!currentTargets.length) return
      draining = true
      try {
        const native = await startNativeRecording(currentTargets)
        const install = await installRecorderIntoTargets(currentTargets, installCode)
        lastTargetCount = currentTargets.length
        if (install.frameCount > 0) lastInstalledFrameCount = install.frameCount
        if (native.tracked > 0) lastNativeTrackedCount = native.tracked
        await drainRecorderTargets(currentTargets, drainCode)
        appendNativeEvents(await drainNativeRecording())
      } finally {
        draining = false
        updateButtons()
      }
    }, 1500)
  }

  async function stopRecording(): Promise<void> {
    if (stopping) return
    if (!recording) return
    recording = false
    stopping = true
    updateButtons()
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }

    try {
      const targets = listTargetWebviews()
      if (targets.length) {
        await drainRecorderTargets(targets, buildRecorderDrainScript(), {
          captureEventScreenshots: false
        })
        finalScreenshot = await captureScreenshot(targets[0].getWebContentsId(), 'stop')
        await stopRecorderTargets(targets, buildRecorderStopScript())
      }
      if (sessionId) {
        appendNativeEvents(await stopNativeRecording())
      }
    } finally {
      stopping = false
      updateButtons()
    }

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
      recorder: {
        targetWebviews: lastTargetCount,
        installedFrames: lastInstalledFrameCount,
        nativeTrackedWebviews: lastNativeTrackedCount
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

  function listTargetWebviews(): PortalWebview[] {
    const candidates = [options.activeWebview(), ...(options.webviews?.() || [])]
    const seen = new Set<number>()
    const result: PortalWebview[] = []
    for (const webview of candidates) {
      if (!webview) continue
      try {
        const id = webview.getWebContentsId()
        if (seen.has(id)) continue
        seen.add(id)
        result.push(webview)
      } catch {}
    }
    return result
  }

  async function startNativeRecording(
    targets: PortalWebview[]
  ): Promise<{ attached: number; tracked: number }> {
    if (!sessionId) return { attached: 0, tracked: 0 }
    const ids: number[] = []
    for (const webview of targets) {
      try {
        ids.push(webview.getWebContentsId())
      } catch {}
    }
    if (!ids.length) return { attached: 0, tracked: 0 }
    try {
      const res = await withTimeout(
        options.api.startPortalNativeRecording(sessionId, ids),
        NATIVE_RECORDER_TIMEOUT_MS,
        { ok: false, reason: '原始录制启动超时' }
      )
      if (!res.ok) return { attached: 0, tracked: lastNativeTrackedCount }
      return { attached: res.attached, tracked: res.tracked }
    } catch {
      return { attached: 0, tracked: lastNativeTrackedCount }
    }
  }

  async function drainNativeRecording(): Promise<Array<Record<string, unknown>>> {
    if (!sessionId) return []
    try {
      return (
        await withTimeout(options.api.drainPortalNativeRecording(sessionId), NATIVE_RECORDER_TIMEOUT_MS, {
          ok: true,
          events: []
        })
      ).events || []
    } catch {
      return []
    }
  }

  async function stopNativeRecording(): Promise<Array<Record<string, unknown>>> {
    if (!sessionId) return []
    try {
      return (
        await withTimeout(options.api.stopPortalNativeRecording(sessionId), NATIVE_RECORDER_TIMEOUT_MS, {
          ok: true,
          events: []
        })
      ).events || []
    } catch {
      return []
    }
  }

  async function installRecorderIntoTargets(
    targets: PortalWebview[],
    code: string
  ): Promise<{ ok: boolean; frameCount: number; reason?: string }> {
    let frameCount = 0
    const errors: string[] = []
    await Promise.all(
      targets.map(async (webview) => {
        try {
          const res = await withTimeout(
            options.api.execInAllPortalFrames(webview.getWebContentsId(), code),
            FRAME_SCRIPT_TIMEOUT_MS,
            { ok: false, count: 0, reason: 'frame 脚本安装超时' }
          )
          if (res.ok) frameCount += res.count || 0
          else errors.push(res.reason || '未知错误')
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      })
    )
    return {
      ok: frameCount > 0 || errors.length === 0,
      frameCount,
      reason: errors[0]
    }
  }

  async function drainRecorderTargets(
    targets: PortalWebview[],
    code: string,
    optionsOverride: { captureEventScreenshots?: boolean } = {}
  ): Promise<void> {
    await Promise.all(
      targets.map(async (webview) => {
        try {
          const webContentsId = webview.getWebContentsId()
          const res = await withTimeout(
            options.api.drainAllPortalFrames(webContentsId, code),
            FRAME_SCRIPT_TIMEOUT_MS,
            { ok: false, results: [], reason: 'frame 事件捞取超时' }
          )
          if (!res.ok) return
          const added = appendEvents(res.results)
          if (optionsOverride.captureEventScreenshots !== false) {
            await captureScreenshotsForEvents(
              webContentsId,
              added,
              EVENT_SCREENSHOT_LIMIT_PER_DRAIN
            )
          }
        } catch {}
      })
    )
  }

  async function stopRecorderTargets(targets: PortalWebview[], code: string): Promise<void> {
    await Promise.all(
      targets.map(async (webview) => {
        try {
          await withTimeout(
            options.api.execInAllPortalFrames(webview.getWebContentsId(), code),
            FRAME_SCRIPT_TIMEOUT_MS,
            { ok: false, count: 0, reason: 'frame 录制停止超时' }
          )
        } catch {}
      })
    )
  }

  function appendNativeEvents(nextEvents: Array<Record<string, unknown>>): void {
    for (const event of nextEvents || []) {
      events.push({
        frameUrl: String(event.url || ''),
        ...event,
        kind: String(event.kind || 'native')
      } as RecordingEvent)
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
    nextEvents: RecordingEvent[],
    maxScreenshots: number
  ): Promise<void> {
    let attempts = 0
    for (const event of nextEvents) {
      if (!shouldCaptureEventScreenshot(event)) continue
      if (attempts >= maxScreenshots) return
      attempts += 1
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
      const res = await withTimeout(
        options.api.capturePortalRecordingScreenshot(webContentsId, {
          sessionId: sessionId || '一体化录制',
          sequence,
          kind
        }),
        SCREENSHOT_TIMEOUT_MS,
        { ok: false, reason: '截图超时' }
      )
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: number | undefined
  const timeout = new Promise<T>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(fallback), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
  })
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
