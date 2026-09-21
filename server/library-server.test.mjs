import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createOnlineLibrary, isDirectExecution } from './library-server.mjs'

let baseUrl
let directory
let server

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'orbitra-library-'))
  const demo = fileURLToPath(new URL('../public/demo/star-orbit.gba', import.meta.url))
  await copyFile(demo, path.join(directory, 'Distributed Orbit.gba'))
  await writeFile(path.join(directory, 'notes.txt'), 'not a game')
  const handler = await createOnlineLibrary({
    rootDirectory: directory,
    name: 'Test Distribution',
    allowedOrigins: 'https://orbitra.example',
    adminToken: 'distribution-secret',
  })
  server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await rm(directory, { recursive: true, force: true })
})

function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { Origin: 'https://orbitra.example', ...options.headers },
  })
}

test('detects direct execution through Node and PM2', () => {
  const source = path.resolve('/srv/orbitra/server/library-server.mjs')
  assert.equal(isDirectExecution(source, source), true)
  assert.equal(
    isDirectExecution(source, '/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js', source),
    true,
  )
  assert.equal(isDirectExecution(source, '/srv/orbitra/server/test.mjs'), false)
})

test('serves a public manifest and immutable ROM without account endpoints', async () => {
  const response = await request('/manifest.json')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://orbitra.example')
  const manifest = await response.json()
  assert.equal(manifest.format, 'orbitra-online-library')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.name, 'Test Distribution')
  assert.equal(manifest.games.length, 1)
  assert.match(manifest.games[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(manifest.games[0].platform, 'gba')

  const game = await request(`/${manifest.games[0].url}`)
  assert.equal(game.status, 200)
  assert.equal(Number(game.headers.get('content-length')), manifest.games[0].size)
  assert.equal((await game.arrayBuffer()).byteLength, manifest.games[0].size)

  assert.equal((await request('/api/auth/session')).status, 404)
})

test('is read-only and rejects origins outside the configured allowlist', async () => {
  assert.equal((await request('/manifest.json', { method: 'POST' })).status, 405)
  const denied = await fetch(`${baseUrl}/manifest.json`, {
    headers: { Origin: 'https://untrusted.example' },
  })
  assert.equal(denied.status, 403)
})

test('admin token publishes and removes distribution files', async () => {
  const uploadedBytes = Buffer.alloc(192, 9)
  const unauthorized = await request('/admin/games/Published.gba', {
    method: 'PUT',
    body: uploadedBytes,
  })
  assert.equal(unauthorized.status, 401)

  const uploaded = await request('/admin/games/Published.gba', {
    method: 'PUT',
    headers: { Authorization: 'Bearer distribution-secret' },
    body: uploadedBytes,
  })
  assert.equal(uploaded.status, 200)
  assert.equal(
    (await uploaded.json()).games.some((game) => game.filename === 'Published.gba'),
    true,
  )

  const removed = await request('/admin/games/Published.gba', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer distribution-secret' },
  })
  assert.equal(removed.status, 200)
  assert.equal(
    (await removed.json()).games.some((game) => game.filename === 'Published.gba'),
    false,
  )
})

test('supports manifest revalidation and ROM HEAD requests', async () => {
  const first = await request('/manifest.json')
  const etag = first.headers.get('etag')
  assert.ok(etag)
  const unchanged = await request('/manifest.json', { headers: { 'If-None-Match': etag } })
  assert.equal(unchanged.status, 304)

  const manifest = await first.json()
  const head = await request(`/${manifest.games[0].url}`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers.get('content-length')), manifest.games[0].size)
})
