import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions } from 'electron'
import { assertTrustedIpcSender } from './ipcGuard'
import fs from 'node:fs/promises'
import {
  claimTrialLicense,
  exportMachineRequest,
  getCachedLicenseStatus,
  getLicenseDeviceInfo,
  getLicenseServerUrl,
  getSavedLicenseKey,
  importOfflineLicenseText,
  saveLicenseKey,
  verifyLicense
} from '../services/licenseService'

function ok<T>(data?: T) {
  return { success: true, data }
}

function fail(error: unknown) {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

export function registerLicenseIpc(): void {
  const rawHandle = ipcMain.handle.bind(ipcMain)
  // 与 createLicensedIpcMain 同样的 sender 守卫：授权通道只允许主窗口调用。
  const guarded = {
    handle(channel: string, listener: Parameters<typeof rawHandle>[1]): void {
      rawHandle(channel, async (event, ...args) => {
        assertTrustedIpcSender(event)
        return listener(event, ...args)
      })
    }
  }
  guarded.handle('license:status', async () => {
    try {
      return ok(await getCachedLicenseStatus())
    } catch (error) {
      return fail(error)
    }
  })

  guarded.handle('license:check', async (_event, licenseKey?: string) => {
    try {
      return ok(await verifyLicense(licenseKey || ''))
    } catch (error) {
      return fail(error)
    }
  })

  guarded.handle(
    'license:claimTrial',
    async (_event, customerName: string, customerCode?: string) => {
      try {
        return ok(await claimTrialLicense(customerName || '', customerCode || ''))
      } catch (error) {
        return fail(error)
      }
    }
  )

  guarded.handle('license:getKey', async () => {
    try {
      return ok(getSavedLicenseKey())
    } catch (error) {
      return fail(error)
    }
  })

  guarded.handle('license:saveKey', async (_event, licenseKey: string) => {
    try {
      saveLicenseKey(licenseKey || '')
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  guarded.handle('license:getServerUrl', async () => {
    try {
      return ok(getLicenseServerUrl())
    } catch (error) {
      return fail(error)
    }
  })

  guarded.handle('license:setServerUrl', async () =>
    fail(new Error('授权服务器地址不允许在客户端修改'))
  )

  guarded.handle('license:deviceInfo', async (_event, licenseKey?: string) => {
    try {
      return ok(await getLicenseDeviceInfo(licenseKey || ''))
    } catch (error) {
      return fail(error)
    }
  })

  guarded.handle('license:exportMachineRequest', async (event, licenseKey?: string) => {
    try {
      const request = await exportMachineRequest(licenseKey || '')
      const parent = BrowserWindow.fromWebContents(event.sender) || undefined
      const options: SaveDialogOptions = {
        title: '导出机器码',
        defaultPath: `工资系统机器码-${request.device_id.slice(0, 12)}.json`,
        filters: [
          { name: '授权机器码', extensions: ['json'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      }
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return ok({ canceled: true, request })
      await fs.writeFile(result.filePath, JSON.stringify(request, null, 2), 'utf-8')
      return ok({ canceled: false, filePath: result.filePath, request })
    } catch (error) {
      return fail(error)
    }
  })

  guarded.handle('license:importOffline', async (event) => {
    try {
      const parent = BrowserWindow.fromWebContents(event.sender) || undefined
      const options: OpenDialogOptions = {
        title: '导入离线授权文件',
        properties: ['openFile'],
        filters: [
          { name: '离线授权文件', extensions: ['lic', 'json'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      }
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return ok({ canceled: true })
      const raw = await fs.readFile(result.filePaths[0], 'utf-8')
      const status = await importOfflineLicenseText(raw)
      return ok({ canceled: false, filePath: result.filePaths[0], status })
    } catch (error) {
      return fail(error)
    }
  })
}
