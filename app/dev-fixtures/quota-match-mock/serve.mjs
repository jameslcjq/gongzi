// 仿真页静态服务器：以 app 根目录为站点根，使 ../../node_modules 与 ../../dev-userscripts 可达。
// 用法：node dev-fixtures/quota-match-mock/serve.mjs   （在 app 目录下运行）
// 打开：http://localhost:4519/dev-fixtures/quota-match-mock/salSalaryAuditSCZF.html
import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const port = Number(process.env.MOCK_PORT || 4519)

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
}

http
  .createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      const filePath = normalize(join(appRoot, urlPath))
      if (!filePath.startsWith(appRoot + sep) && filePath !== appRoot) {
        res.writeHead(403).end('forbidden')
        return
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404).end('not found: ' + urlPath)
        return
      }
      res.writeHead(200, { 'Content-Type': types[extname(filePath).toLowerCase()] || 'application/octet-stream' })
      createReadStream(filePath).pipe(res)
    } catch (error) {
      res.writeHead(500).end(String(error))
    }
  })
  .listen(port, () => {
    console.log(`额度匹配仿真页: http://localhost:${port}/dev-fixtures/quota-match-mock/salSalaryAuditSCZF.html`)
  })
