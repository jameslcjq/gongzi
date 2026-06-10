import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    // 只收 tests/unit 下的用例；scripts/ 下的 *.test.ts 是 esbuild 跑的旧断言脚本，
    // 由 tests/unit 里的包装用例引入执行，不让 vitest 直接当测试文件收集。
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node'
  }
})
