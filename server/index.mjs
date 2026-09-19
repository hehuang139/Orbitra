import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountApi } from './account-api.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = path.join(root, 'dist')
const port = Number(process.env.PORT || 4173)
const api = createAccountApi()
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

function staticFile(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let file = path.resolve(dist, requested)
  if (!file.startsWith(`${dist}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
    file = path.join(dist, 'index.html')
  }
  const stat = statSync(file)
  res.writeHead(200, {
    'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
}

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html 不存在，请先运行 pnpm build。')
  process.exit(1)
}

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) void api(req, res)
  else staticFile(req, res)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Advance account server: http://localhost:${port}`)
})
