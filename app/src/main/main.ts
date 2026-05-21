import { app, BrowserWindow, session, type Session, type DownloadItem } from 'electron'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase } from './db/connection'
import { registerAppIpc } from './ipc/appApi'
import {
  getImportWatcherStatus,
  startExcelImportWatcher
} from './services/excelImportWatcher'
import { applyAnnualTownshipYearIncreaseIfNeeded } from './services/township-allowance/townshipAllowance'

const isDev = process.env.NODE_ENV === 'development'

// 防止给同一个 session 重复挂 will-download 监听
const hookedSessions = new WeakSet<Session>()

function installDownloadInterception(targetSession: Session, hostWindow: BrowserWindow): void {
  if (hookedSessions.has(targetSession)) return
  hookedSessions.add(targetSession)

  targetSession.on('will-download', (_event, item: DownloadItem) => {
    try {
      const url = item.getURL()
      const filename = item.getFilename() || 'download.bin'
      // 只拦内网一体化系统的 Excel/CSV 类下载
      const isPortalSource = /172\.24\.147\.202|portal|sal-|bim\//i.test(url)
      const isImportable = /\.(xls|xlsx|csv)$/i.test(filename)
      if (!isPortalSource || !isImportable) {
        return // 让它正常走默认下载行为
      }

      // 异步取 watcher 文件夹（不能让监听器变 async，否则 will-download 默认行为已走完）
      void getImportWatcherStatus()
        .then((status) => {
          const folder = status.folderPath
          if (!folder) return
          if (!existsSync(folder)) mkdirSync(folder, { recursive: true })

          const safe = filename.replace(/[\\/:*?"<>|]/g, '_')
          const ts = new Date()
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/[T.]/g, '_')
            .slice(0, 17)
          const dotIdx = safe.lastIndexOf('.')
          const stem = dotIdx > 0 ? safe.slice(0, dotIdx) : safe
          const ext = dotIdx > 0 ? safe.slice(dotIdx) : '.xls'
          const finalName = `一体化_${stem}_${ts}${ext}`
          const fullPath = join(folder, finalName)

          item.setSavePath(fullPath)

          item.once('done', (_e, state) => {
            if (!hostWindow.isDestroyed()) {
              hostWindow.webContents.send('integration:webview-download-done', {
                ok: state === 'completed',
                state,
                originalName: filename,
                savedPath: fullPath,
                url
              })
            }
          })
        })
        .catch((error) => {
          console.warn('[will-download] 取 import folder 失败', error)
        })
    } catch (error) {
      console.warn('[will-download] 处理异常', error)
    }
  })
}

function hostWindowFor(wc: Electron.WebContents): BrowserWindow | null {
  const owner = BrowserWindow.fromWebContents(wc)
  if (owner) return owner
  return BrowserWindow.getAllWindows()[0] || null
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1100,
    minHeight: 720,
    title: '工资系统',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // 拦截 webview 内的弹窗（window.open / target=_blank），转成宿主侧 "新标签" 请求
  mainWindow.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    guestWebContents.setWindowOpenHandler(({ url, disposition }) => {
      // 通知宿主开新标签
      mainWindow.webContents.send('integration:webview-open-tab', {
        sourceWebContentsId: guestWebContents.id,
        url,
        disposition
      })
      return { action: 'deny' }
    })

    // 给该 webview 的 session 装下载拦截（同一 partition 多次挂载会被 WeakSet 去重）
    const host = hostWindowFor(mainWindow.webContents) || mainWindow
    installDownloadInterception(guestWebContents.session, host)
  })

  // 也给已存在的 partition session 预先挂一次（覆盖热重载情况）
  try {
    installDownloadInterception(
      session.fromPartition('persist:integrated-portal'),
      mainWindow
    )
  } catch (error) {
    console.warn('预挂载 integrated-portal session 下载拦截失败', error)
  }
}

app.whenReady().then(async () => {
  try {
    await getDatabase()
    const townshipAnnualIncrease = await applyAnnualTownshipYearIncreaseIfNeeded()
    if (townshipAnnualIncrease.applied) {
      console.info(
        `乡镇补贴年度递增已执行：${townshipAnnualIncrease.year}，影响 ${townshipAnnualIncrease.affectedRows} 行`
      )
      for (const warning of townshipAnnualIncrease.warnings) {
        console.warn(`乡镇补贴年度递增提醒：${warning}`)
      }
    }
  } catch (error) {
    console.error('数据库初始化失败', error)
  }
  registerAppIpc()
  createWindow()

  startExcelImportWatcher().catch((error) => {
    console.error('Excel 导入监听启动失败', error)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
