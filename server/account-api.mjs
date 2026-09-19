import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const scrypt = promisify(scryptCallback)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_JSON_BYTES = 8 * 1024
const MAX_SNAPSHOT_BYTES = 72 * 1024 * 1024
const MAX_LIBRARY_ITEMS = 2000
const MAX_LIBRARY_BYTES = 2 * 1024 * 1024 * 1024
const COOKIE_NAME = 'advance_session'
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000
const RATE_LIMIT_ATTEMPTS = 10

function json(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function error(res, status, message) {
  json(res, status, { error: message })
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        reject(Object.assign(new Error('请求内容过大。'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=')
        return separator < 0
          ? [decodeURIComponent(part), '']
          : [
              decodeURIComponent(part.slice(0, separator)),
              decodeURIComponent(part.slice(separator + 1)),
            ]
      }),
  )
}

function sessionHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

function normalizeUsername(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('请输入用户名。'), { status: 400 })
  const username = value.trim().normalize('NFKC')
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    throw Object.assign(new Error('用户名需为 3-32 个字母、数字、点、下划线或连字符。'), {
      status: 400,
    })
  }
  return { username, key: username.toLocaleLowerCase('en-US') }
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw Object.assign(new Error('密码长度需为 8-128 个字符。'), { status: 400 })
  }
  return value
}

async function passwordHash(password, salt) {
  return Buffer.from(await scrypt(password, salt, 64))
}

function requestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
  const scheme = protocol || (req.socket.encrypted ? 'https' : 'http')
  return `${scheme}://${req.headers.host}`
}

function assertSameOrigin(req) {
  const origin = req.headers.origin
  if (origin && origin !== requestOrigin(req)) {
    throw Object.assign(new Error('请求来源无效。'), { status: 403 })
  }
}

function cookie(token, req, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : ''
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

export function createAccountApi(options = {}) {
  const dataDirectory = path.resolve(
    options.dataDirectory || process.env.ADVANCE_DATA_DIR || '.data',
  )
  mkdirSync(dataDirectory, { recursive: true })
  const databasePath = path.join(dataDirectory, 'advance.sqlite')
  const database = new DatabaseSync(databasePath)
  const rateLimits = new Map()
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_salt BLOB NOT NULL,
      password_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_revisions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_items (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (user_id, game_id)
    );
    CREATE INDEX IF NOT EXISTS library_items_user_revision
      ON library_items(user_id, revision);
  `)

  const findUser = database.prepare(
    'SELECT id, username, password_salt, password_hash, created_at FROM users WHERE username_key = ?',
  )
  const insertUser = database.prepare(
    'INSERT INTO users (username, username_key, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  const insertSession = database.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
  const deleteSession = database.prepare('DELETE FROM sessions WHERE id = ?')
  const deleteExpiredSessions = database.prepare('DELETE FROM sessions WHERE expires_at <= ?')
  const findSession = database.prepare(`
    SELECT users.id, users.username, users.created_at, sessions.expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `)
  const findSnapshot = database.prepare(
    'SELECT revision, updated_at, size, sha256, data FROM snapshots WHERE user_id = ?',
  )
  const saveSnapshot = database.prepare(`
    INSERT INTO snapshots (user_id, revision, updated_at, size, sha256, data)
    VALUES (?, 1, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      revision = snapshots.revision + 1,
      updated_at = excluded.updated_at,
      size = excluded.size,
      sha256 = excluded.sha256,
      data = excluded.data
    RETURNING revision, updated_at, size, sha256
  `)
  const findLibraryRevision = database.prepare(
    'SELECT revision, updated_at FROM library_revisions WHERE user_id = ?',
  )
  const bumpLibraryRevision = database.prepare(`
    INSERT INTO library_revisions (user_id, revision, updated_at)
    VALUES (?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      revision = library_revisions.revision + 1,
      updated_at = excluded.updated_at
    RETURNING revision, updated_at
  `)
  const listLibraryItems = database.prepare(`
    SELECT game_id, revision, updated_at, size, sha256
    FROM library_items WHERE user_id = ? ORDER BY game_id
  `)
  const findLibraryItem = database.prepare(`
    SELECT revision, updated_at, size, sha256, data
    FROM library_items WHERE user_id = ? AND game_id = ?
  `)
  const libraryUsage = database.prepare(
    'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size FROM library_items WHERE user_id = ?',
  )
  const saveLibraryItem = database.prepare(`
    INSERT INTO library_items (user_id, game_id, revision, updated_at, size, sha256, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, game_id) DO UPDATE SET
      revision = excluded.revision,
      updated_at = excluded.updated_at,
      size = excluded.size,
      sha256 = excluded.sha256,
      data = excluded.data
  `)
  const deleteLibraryItem = database.prepare(
    'DELETE FROM library_items WHERE user_id = ? AND game_id = ?',
  )

  const userResponse = (row) => ({
    id: Number(row.id),
    username: row.username,
    createdAt: Number(row.created_at),
  })

  function assertRateLimit(req, key) {
    const now = Date.now()
    const address = req.socket.remoteAddress || 'unknown'
    const id = `${address}:${key}`
    const current = rateLimits.get(id)
    if (!current || current.resetAt <= now) {
      rateLimits.set(id, { attempts: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    } else {
      current.attempts += 1
      if (current.attempts > RATE_LIMIT_ATTEMPTS) {
        throw Object.assign(new Error('尝试次数过多，请稍后再试。'), { status: 429 })
      }
    }
    if (rateLimits.size > 1000) {
      for (const [entry, value] of rateLimits) {
        if (value.resetAt <= now) rateLimits.delete(entry)
      }
      while (rateLimits.size > 1000) rateLimits.delete(rateLimits.keys().next().value)
    }
  }

  function clearRateLimit(req, key) {
    rateLimits.delete(`${req.socket.remoteAddress || 'unknown'}:${key}`)
  }

  function currentUser(req) {
    const token = parseCookies(req)[COOKIE_NAME]
    if (!token) return null
    deleteExpiredSessions.run(Date.now())
    return findSession.get(sessionHash(token), Date.now()) || null
  }

  function createSession(userId, req, res) {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    insertSession.run(sessionHash(token), userId, now, now + SESSION_TTL_MS)
    res.setHeader('Set-Cookie', cookie(token, req))
  }

  async function credentials(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw Object.assign(new Error('请求格式必须为 JSON。'), { status: 415 })
    }
    const raw = await readBody(req, MAX_JSON_BYTES)
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw Object.assign(new Error('登录信息格式无效。'), { status: 400 })
    }
    const { username, key } = normalizeUsername(body.username)
    return { username, key, password: validatePassword(body.password) }
  }

  async function accountApi(req, res, next) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname
    if (!pathname.startsWith('/api/')) {
      next?.()
      return
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    try {
      if (req.method === 'GET' && pathname === '/api/auth/session') {
        const user = currentUser(req)
        json(res, 200, { user: user ? userResponse(user) : null })
        return
      }

      if (req.method === 'POST' && pathname === '/api/auth/register') {
        assertSameOrigin(req)
        const { username, key, password } = await credentials(req)
        assertRateLimit(req, `register:${key}`)
        if (findUser.get(key)) {
          error(res, 409, '此用户名已被使用。')
          return
        }
        const salt = randomBytes(16)
        const hash = await passwordHash(password, salt)
        const createdAt = Date.now()
        let result
        try {
          result = insertUser.run(username, key, salt, hash, createdAt)
        } catch (cause) {
          if (String(cause).includes('UNIQUE')) {
            error(res, 409, '此用户名已被使用。')
            return
          }
          throw cause
        }
        createSession(Number(result.lastInsertRowid), req, res)
        json(res, 201, {
          user: { id: Number(result.lastInsertRowid), username, createdAt },
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/auth/login') {
        assertSameOrigin(req)
        const { key, password } = await credentials(req)
        assertRateLimit(req, `login:${key}`)
        const user = findUser.get(key)
        const supplied = user
          ? await passwordHash(password, Buffer.from(user.password_salt))
          : await passwordHash(password, Buffer.alloc(16))
        if (!user || !timingSafeEqual(supplied, Buffer.from(user.password_hash))) {
          error(res, 401, '用户名或密码不正确。')
          return
        }
        clearRateLimit(req, `login:${key}`)
        createSession(Number(user.id), req, res)
        json(res, 200, { user: userResponse(user) })
        return
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        assertSameOrigin(req)
        const token = parseCookies(req)[COOKIE_NAME]
        if (token) deleteSession.run(sessionHash(token))
        res.setHeader('Set-Cookie', cookie('', req, 0))
        json(res, 200, { user: null })
        return
      }

      if (pathname === '/api/sync') {
        const user = currentUser(req)
        if (!user) {
          error(res, 401, '请先登录后再同步。')
          return
        }
        if (req.method === 'GET') {
          const snapshot = findSnapshot.get(user.id)
          if (!snapshot) {
            res.writeHead(204, { 'Cache-Control': 'no-store' })
            res.end()
            return
          }
          const etag = `"advance-${snapshot.revision}"`
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag })
            res.end()
            return
          }
          const body = Buffer.from(snapshot.data)
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
            ETag: etag,
            'X-Advance-Revision': String(snapshot.revision),
            'X-Advance-Updated-At': String(snapshot.updated_at),
          })
          res.end(body)
          return
        }
        if (req.method === 'PUT') {
          assertSameOrigin(req)
          if (!String(req.headers['content-type'] || '').startsWith('application/zip')) {
            error(res, 415, '同步数据必须为 ZIP 备份。')
            return
          }
          const body = await readBody(req, MAX_SNAPSHOT_BYTES)
          if (body.length < 22 || body[0] !== 0x50 || body[1] !== 0x4b) {
            error(res, 400, '同步备份格式无效。')
            return
          }
          const updatedAt = Date.now()
          const sha256 = createHash('sha256').update(body).digest('hex')
          const saved = saveSnapshot.get(user.id, updatedAt, body.length, sha256, body)
          json(res, 200, {
            revision: Number(saved.revision),
            updatedAt: Number(saved.updated_at),
            size: Number(saved.size),
            sha256: saved.sha256,
          })
          return
        }
      }

      if (pathname === '/api/library' || pathname.startsWith('/api/library/')) {
        const user = currentUser(req)
        if (!user) {
          error(res, 401, '请先登录后再同步。')
          return
        }
        if (pathname === '/api/library' && req.method === 'GET') {
          const current = findLibraryRevision.get(user.id)
          const revision = Number(current?.revision || 0)
          const updatedAt = Number(current?.updated_at || 0)
          const etag = `"advance-library-${revision}"`
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag })
            res.end()
            return
          }
          json(
            res,
            200,
            {
              revision,
              updatedAt,
              items: listLibraryItems.all(user.id).map((item) => ({
                gameId: item.game_id,
                revision: Number(item.revision),
                updatedAt: Number(item.updated_at),
                size: Number(item.size),
                sha256: item.sha256,
              })),
            },
            { ETag: etag },
          )
          return
        }

        const match = /^\/api\/library\/([0-9a-f]{64})$/.exec(pathname)
        if (!match) {
          error(res, 404, '同步游戏不存在。')
          return
        }
        const gameId = match[1]
        if (req.method === 'GET') {
          const item = findLibraryItem.get(user.id, gameId)
          if (!item) {
            error(res, 404, '同步游戏不存在。')
            return
          }
          const body = Buffer.from(item.data)
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
            ETag: `"${item.sha256}"`,
            'X-Advance-Revision': String(item.revision),
            'X-Advance-Updated-At': String(item.updated_at),
          })
          res.end(body)
          return
        }
        if (req.method === 'PUT') {
          assertSameOrigin(req)
          if (!String(req.headers['content-type'] || '').startsWith('application/zip')) {
            error(res, 415, '同步数据必须为 ZIP 备份。')
            return
          }
          const body = await readBody(req, MAX_SNAPSHOT_BYTES)
          if (body.length < 22 || body[0] !== 0x50 || body[1] !== 0x4b) {
            error(res, 400, '同步备份格式无效。')
            return
          }
          const sha256 = createHash('sha256').update(body).digest('hex')
          const existing = findLibraryItem.get(user.id, gameId)
          if (existing?.sha256 === sha256) {
            const current = findLibraryRevision.get(user.id)
            json(res, 200, {
              revision: Number(current?.revision || existing.revision),
              updatedAt: Number(existing.updated_at),
              size: Number(existing.size),
              sha256: existing.sha256,
            })
            return
          }
          const usage = libraryUsage.get(user.id)
          const nextCount = Number(usage.count) + (existing ? 0 : 1)
          const nextSize = Number(usage.size) - Number(existing?.size || 0) + body.length
          if (nextCount > MAX_LIBRARY_ITEMS) {
            error(res, 413, `账号游戏库最多保存 ${MAX_LIBRARY_ITEMS} 个游戏。`)
            return
          }
          if (nextSize > MAX_LIBRARY_BYTES) {
            error(res, 413, '账号游戏库总容量不能超过 2 GiB。')
            return
          }
          const updatedAt = Date.now()
          database.exec('BEGIN IMMEDIATE')
          try {
            const next = bumpLibraryRevision.get(user.id, updatedAt)
            saveLibraryItem.run(
              user.id,
              gameId,
              next.revision,
              updatedAt,
              body.length,
              sha256,
              body,
            )
            database.exec('COMMIT')
            json(res, 200, {
              revision: Number(next.revision),
              updatedAt,
              size: body.length,
              sha256,
            })
          } catch (cause) {
            database.exec('ROLLBACK')
            throw cause
          }
          return
        }
        if (req.method === 'DELETE') {
          assertSameOrigin(req)
          const existing = findLibraryItem.get(user.id, gameId)
          const current = findLibraryRevision.get(user.id)
          if (!existing) {
            json(res, 200, {
              revision: Number(current?.revision || 0),
              updatedAt: Number(current?.updated_at || 0),
            })
            return
          }
          const updatedAt = Date.now()
          database.exec('BEGIN IMMEDIATE')
          try {
            const next = bumpLibraryRevision.get(user.id, updatedAt)
            deleteLibraryItem.run(user.id, gameId)
            database.exec('COMMIT')
            json(res, 200, { revision: Number(next.revision), updatedAt })
          } catch (cause) {
            database.exec('ROLLBACK')
            throw cause
          }
          return
        }
      }

      error(res, 404, '接口不存在。')
    } catch (cause) {
      if (res.headersSent || res.destroyed) return
      const status = Number(cause?.status) || 500
      if (status >= 500) console.error('[account-api]', cause)
      error(res, status, status >= 500 ? '服务器暂时无法完成请求。' : cause.message)
    }
  }
  accountApi.close = () => database.close()
  return accountApi
}
