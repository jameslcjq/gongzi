import { app, BrowserWindow, dialog, type Session, type DownloadItem } from 'electron'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase } from './db/connection'
import { registerAppIpc } from './ipc/appApi'
import { registerLicenseIpc } from './ipc/licenseApi'
import { registerMailIpc } from './ipc/mailApi'
import { startAutoCheck } from './services/mail/mailImapService'
import { getCachedLicenseStatus } from './services/licenseService'
import { appDisplayName, ensureBusinessFolders, ensureImportFolderDesktopShortcut } from './config/paths'
import {
  getCachedImportFolder,
  startExcelImportWatcher
} from './services/excelImportWatcher'
import { applyAnnualTownshipYearIncreaseIfNeeded } from './services/township-allowance/townshipAllowance'
import { appendMainLog, installMainProcessLogging } from './services/mainLog'
import { runDailyAutoBackup } from './services/backup'
import { resolvePortalHost } from '../shared/portalHost'

const isDev = process.env.NODE_ENV === 'development'

// 单实例锁：同一安装实例双开会导致同一 SQLite 双进程写、导入监听把同一文件导两遍、
// 一体化自动化重复执行。锁按 userData 目录生效——实例2/内网执行端各有独立 userData
// （见 config/paths 的 payrollInstance），相互不受影响；这里只挡“同一实例开第二次”。
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

let mainWindowRef: BrowserWindow | null = null

app.on('second-instance', () => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    if (mainWindowRef.isMinimized()) mainWindowRef.restore()
    mainWindowRef.focus()
  }
})

// 防止给同一个 session 重复挂 will-download 监听
const hookedSessions = new WeakSet<Session>()

function normalizeDownloadName(filename: string): string {
  return filename.trim().replace(/\s+/g, '')
}

function isBudgetPersonnelExport(filename: string): boolean {
  const name = normalizeDownloadName(filename)
  return /(^|[_-])人员信息([_-]|$)/.test(name) && /\d{5,}/.test(name)
}

function isSalaryExportWorkbook(filename: string): boolean {
  const name = normalizeDownloadName(filename)
  return /^工资[-_]/.test(name)
}

function shouldAutoCapturePortalWorkbook(filename: string): boolean {
  const name = normalizeDownloadName(filename)
  return isSalaryExportWorkbook(name) || isBudgetPersonnelExport(name)
}

function installDownloadInterception(targetSession: Session, hostWindow: BrowserWindow): void {
  if (hookedSessions.has(targetSession)) return
  hookedSessions.add(targetSession)

  targetSession.on('will-download', (_event, item: DownloadItem) => {
    try {
      const url = item.getURL()
      const filename = item.getFilename() || 'download.bin'
      // 只拦一体化里的两个入库来源：导出工资、预算人员信息；其它 Excel 走默认另存为。
      const portalHostPattern = resolvePortalHost(process.env).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const isPortalSource = new RegExp(`${portalHostPattern}|portal|sal-|bim\\/`, 'i').test(url)
      const isImportable = /\.(xls|xlsx|csv)$/i.test(filename)
      if (!isPortalSource || !isImportable || !shouldAutoCapturePortalWorkbook(filename)) {
        return // 让它正常走默认下载行为（操作系统的另存为对话框）
      }

      // ⚠ setSavePath 必须同步调用：异步取目录会让 Electron 先弹出保存对话框
      const folder = getCachedImportFolder()
      if (!folder) {
        console.warn('[will-download] 没有可用的导入目录，放它走默认行为')
        return
      }

      // 预算"人员信息查看"导出的文件名形如 "019070_人员信息_20260522..._xxx.xls"
      // 只用文件名判定：单位编码 + "_人员信息_" → 预算分支（走子目录 + 调 budget importer）
      // 其他都按工资 xls 处理（主目录 + watcher 自动入库）
      const isBudget = isBudgetPersonnelExport(filename)
      const targetDir = isBudget ? join(folder, '预算导出') : folder
      try {
        if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
        if (isBudget && !existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
      } catch (e) {
        console.warn('[will-download] 建目录失败', e)
      }

      const safe = filename.replace(/[\\/:*?"<>|]/g, '_')
      const ts = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/[T.]/g, '_')
        .slice(0, 17)
      const dotIdx = safe.lastIndexOf('.')
      const stem = dotIdx > 0 ? safe.slice(0, dotIdx) : safe
      const ext = dotIdx > 0 ? safe.slice(dotIdx) : '.xls'
      const prefix = isBudget ? '预算_' : '一体化_'
      const finalName = `${prefix}${stem}_${ts}${ext}`
      const fullPath = join(targetDir, finalName)

      // 关键：同步设置保存路径，绕开"另存为"对话框
      item.setSavePath(fullPath)

      item.once('done', (_e, state) => {
        const completed = state === 'completed'
        if (!hostWindow.isDestroyed()) {
          hostWindow.webContents.send('integration:webview-download-done', {
            ok: completed,
            state,
            originalName: filename,
            savedPath: fullPath,
            url,
            isBudget
          })
        }
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
    title: appDisplayName,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  mainWindowRef = mainWindow
  mainWindow.maximize()

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  if (isDev && process.env.PAYROLL_OPEN_DEVTOOLS === '1') {
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

  // 下载拦截在每个 webview attach 后按其独立 partition 安装。
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  installMainProcessLogging()
  appendMainLog('info', 'startup', `应用启动 ${appDisplayName} v${app.getVersion()}`)
  ensureBusinessFolders()
  ensureImportFolderDesktopShortcut()
  try {
    await getDatabase()
  } catch (error) {
    // 数据库打不开继续跑只会让后续每个操作散点报错——明示并退出（R-07 fail-fast）。
    appendMainLog('fatal', 'startup', '数据库初始化失败', error)
    dialog.showErrorBox(
      '数据库初始化失败',
      `工资数据库无法打开，程序无法继续运行。\n\n${error instanceof Error ? error.message : String(error)}\n\n请检查数据目录是否可写、磁盘是否已满，或从备份恢复后重试。`
    )
    app.quit()
    return
  }
  try {
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
    console.error('乡镇补贴年度递增检查失败', error)
  }
  // 每日自动备份（保留最近 14 份），失败只记日志不打扰启动
  runDailyAutoBackup().catch((error) => {
    console.error('每日自动备份失败', error)
  })
  registerAppIpc()
  registerLicenseIpc()
  registerMailIpc()
  createWindow()

  startExcelImportWatcher().catch((error) => {
    console.error('Excel 导入监听启动失败', error)
  })

  // 启动后 5 秒自动检测邮件附件
  setTimeout(() => {
    ;(async () => {
      const licenseStatus = await getCachedLicenseStatus()
      if (!licenseStatus.valid) {
        console.info('邮件自动检测已跳过：授权未通过')
        return
      }
      await startAutoCheck(30)
    })().catch((error) => {
      console.error('邮件自动检测失败', error)
    })
  }, 5000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
