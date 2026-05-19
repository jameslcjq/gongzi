import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getDatabase } from './db/connection'
import { registerAppIpc } from './ipc/appApi'
import { startExcelImportWatcher } from './services/excelImportWatcher'
import { applyAnnualTownshipYearIncreaseIfNeeded } from './services/township-allowance/townshipAllowance'

const isDev = process.env.NODE_ENV === 'development'

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

  mainWindow.webContents.openDevTools({ mode: 'detach' })
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
