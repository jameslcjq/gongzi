import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'node:path'

// 构建期应用变体：APP_FLAVOR=runner 产出内网执行端版，否则完整版。
// 注入为全局常量 __APP_FLAVOR__，供 src/shared/appFlavor.ts 读取。
const appFlavor = process.env.APP_FLAVOR === 'runner' ? 'runner' : 'full'
const flavorDefine = { __APP_FLAVOR__: JSON.stringify(appFlavor) }

export default defineConfig({
  define: flavorDefine,
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [
    vue(),
    electron([
      {
        entry: 'src/main/main.ts',
        onstart(options) {
          options.startup()
        },
        vite: {
          define: flavorDefine,
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['sqlite3', 'imapflow', 'mailparser']
            }
          }
        }
      },
      {
        entry: 'src/preload/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          define: flavorDefine,
          build: {
            outDir: 'dist-electron'
          }
        }
      }
    ]),
    renderer()
  ]
})
