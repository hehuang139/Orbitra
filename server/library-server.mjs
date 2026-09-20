import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { readdir, rename, stat, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const sourceFile = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(sourceFile), '..')
const platformByExtension = new Map([
  ['.gba', { platform: 'gba', min: 192, max: 32 * 1024 * 1024 }],
  ['.gb', { platform: 'gb', min: 32 * 1024, max: 8 * 1024 * 1024 }],
  ['.gbc', { platform: 'gbc', min: 32 * 1024, max: 8 * 1024 * 1024 }],
  ['.nes', { platform: 'nes', min: 16 * 1024 + 16, max: 8 * 1024 * 1024 }],
  ['.sfc', { platform: 'snes', min: 32 * 1024, max: 16 * 1024 * 1024 }],
  ['.smc', { platform: 'snes', min: 32 * 1024, max: 16 * 1024 * 1024 }],
  ['.iso', { platform: 'gamecube', min: 32 * 1024, max: 1_459_978_240 }],
  ['.gcm', { platform: 'gamecube', min: 32 * 1024, max: 1_459_978_240 }],
])

function json(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

function titleFor(filename) {
  return (
    filename
      .replace(/\.[^.]+$/u, '')
      .replace(/_+/gu, ' ')
      .trim() || 'Untitled game'
  )
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filename)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function buildCatalog(rootDirectory, name) {
  const entries = (await readdir(rootDirectory, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && platformByExtension.has(path.extname(entry.name).toLowerCase()),
    )
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const games = []
  for (const entry of entries) {
    const filename = path.join(rootDirectory, entry.name)
    const [metadata, sha256] = await Promise.all([stat(filename), sha256File(filename)])
    games.push({
      id: sha256,
      title: titleFor(entry.name),
      filename: entry.name,
      platform: platformByExtension.get(path.extname(entry.name).toLowerCase()).platform,
      size: metadata.size,
      sha256,
      url: `games/${encodeURIComponent(entry.name)}`,
    })
  }
  const revision = createHash('sha256').update(JSON.stringify(games)).digest('hex').slice(0, 16)
  return {
    format: 'orbitra-online-library',
    version: 1,
    name,
    revision,
    games,
  }
}

function allowedOrigins(value) {
  if (!value || value === '*') return null
  return new Set(
    String(value)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
}

function authorized(request, token) {
  if (!token) return false
  const supplied = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

function safeFilename(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\\/:\u0000-\u001f\u007f]/u.test(value) &&
    value !== '.' &&
    value !== '..'
  )
}

async function writeUpload(request, target, expectedSize) {
  const temporary = `${target}.${randomUUID()}.upload`
  let received = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      callback(received <= expectedSize ? null : new Error('上传内容超过声明大小。'), chunk)
    },
  })
  try {
    await pipeline(request, counter, createWriteStream(temporary, { flags: 'wx' }))
    if (received !== expectedSize) throw new Error('上传内容不完整。')
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function createOnlineLibrary(options = {}) {
  const rootDirectory = path.resolve(
    options.rootDirectory ||
      process.env.ONLINE_LIBRARY_ROOT ||
      path.join(projectRoot, 'public/demo'),
  )
  if (!existsSync(rootDirectory)) throw new Error(`在线游戏库目录不存在：${rootDirectory}`)
  const name = String(
    options.name || process.env.ONLINE_LIBRARY_NAME || 'Orbitra Demo Library',
  ).trim()
  const origins = allowedOrigins(
    options.allowedOrigins ?? process.env.ONLINE_LIBRARY_ALLOWED_ORIGINS,
  )
  const adminToken = String(options.adminToken ?? process.env.ONLINE_LIBRARY_ADMIN_TOKEN ?? '')
  let manifest = await buildCatalog(rootDirectory, name)
  let files = new Map(
    manifest.games.map((game) => [game.filename, path.join(rootDirectory, game.filename)]),
  )
  let mutation = Promise.resolve()
  const refreshCatalog = async () => {
    manifest = await buildCatalog(rootDirectory, name)
    files = new Map(
      manifest.games.map((game) => [game.filename, path.join(rootDirectory, game.filename)]),
    )
    return manifest
  }

  return async function onlineLibrary(request, response) {
    const origin = request.headers.origin
    if (origin && origins && !origins.has(origin)) {
      json(response, 403, { error: '当前 Orbitra 地址未被在线游戏库允许。' })
      return
    }
    const cors = {
      'Access-Control-Allow-Origin': origin || '*',
      Vary: origin ? 'Origin' : undefined,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-cache',
    }
    for (const [key, value] of Object.entries(cors)) {
      if (value !== undefined) response.setHeader(key, value)
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      })
      response.end()
      return
    }
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname)
    } catch {
      json(response, 400, { error: '请求地址无效。' })
      return
    }
    if (pathname.startsWith('/admin/games/')) {
      if (!authorized(request, adminToken)) {
        json(response, 401, { error: '在线游戏库管理员令牌无效。' })
        return
      }
      const filename = pathname.slice('/admin/games/'.length)
      const definition = platformByExtension.get(path.extname(filename).toLowerCase())
      if (!safeFilename(filename) || !definition) {
        json(response, 400, { error: '请选择受支持的 ROM 文件。' })
        return
      }
      if (request.method === 'PUT') {
        const size = Number(request.headers['content-length'])
        if (!Number.isSafeInteger(size)) {
          json(response, 411, { error: '上传请求必须包含文件大小。' })
          return
        }
        if (size < definition.min || size > definition.max) {
          json(response, 413, { error: 'ROM 文件大小不符合对应平台范围。' })
          return
        }
        const run = async () => {
          await writeUpload(request, path.join(rootDirectory, filename), size)
          return refreshCatalog()
        }
        const current = mutation.then(run, run)
        mutation = current.then(
          () => undefined,
          () => undefined,
        )
        try {
          json(response, 200, await current)
        } catch (error) {
          console.error('[online-library-upload]', error)
          json(response, 500, { error: '在线游戏上传失败。' })
        }
        return
      }
      if (request.method === 'DELETE') {
        const run = async () => {
          try {
            await unlink(path.join(rootDirectory, filename))
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
          return refreshCatalog()
        }
        const current = mutation.then(run, run)
        mutation = current.then(
          () => undefined,
          () => undefined,
        )
        try {
          json(response, 200, await current)
        } catch (error) {
          console.error('[online-library-delete]', error)
          json(response, 500, { error: '在线游戏下架失败。' })
        }
        return
      }
      json(response, 405, { error: '管理接口仅支持上传或下架。' }, { Allow: 'PUT, DELETE' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(
        response,
        405,
        { error: '公开在线游戏库仅提供只读访问。' },
        { Allow: 'GET, HEAD, OPTIONS' },
      )
      return
    }
    if (pathname === '/healthz') {
      json(response, 200, { service: 'orbitra-online-library', version: 1 })
      return
    }
    if (pathname === '/manifest.json') {
      const manifestEtag = `"orbitra-library-${manifest.revision}"`
      if (request.headers['if-none-match'] === manifestEtag) {
        response.writeHead(304, { ETag: manifestEtag })
        response.end()
        return
      }
      json(response, 200, manifest, { ETag: manifestEtag })
      return
    }
    if (!pathname.startsWith('/games/')) {
      json(response, 404, { error: '文件不存在。' })
      return
    }
    const filename = pathname.slice('/games/'.length)
    const file = files.get(filename)
    const game = manifest.games.find((candidate) => candidate.filename === filename)
    if (!file || !game) {
      json(response, 404, { error: '游戏不存在。' })
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': game.size,
      ETag: `"sha256-${game.sha256}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(file).pipe(response)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === sourceFile) {
  const port = Number(process.env.ONLINE_LIBRARY_PORT || 4174)
  const host = process.env.ONLINE_LIBRARY_HOST || '0.0.0.0'
  const certificatePath = process.env.ONLINE_LIBRARY_TLS_CERT_PATH
  const keyPath = process.env.ONLINE_LIBRARY_TLS_KEY_PATH
  if (Boolean(certificatePath) !== Boolean(keyPath)) {
    console.error('ONLINE_LIBRARY_TLS_CERT_PATH 与 ONLINE_LIBRARY_TLS_KEY_PATH 必须同时配置。')
    process.exit(1)
  }
  const handler = await createOnlineLibrary()
  const tls =
    certificatePath && keyPath
      ? { cert: readFileSync(certificatePath), key: readFileSync(keyPath) }
      : null
  const server = tls ? createSecureServer(tls, handler) : createServer(handler)
  const protocol = tls ? 'https' : 'http'
  server.listen(port, host, () => {
    console.log(`Orbitra online library: ${protocol}://${host}:${port}`)
  })
}
