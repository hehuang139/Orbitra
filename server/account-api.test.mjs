import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { createAccountApi } from './account-api.mjs'

let api
let baseUrl
let dataDirectory
let server

before(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), 'advance-account-'))
  api = createAccountApi({ dataDirectory })
  server = createServer((request, response) => void api(request, response))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  api.close()
  await rm(dataDirectory, { recursive: true, force: true })
})

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Origin: baseUrl,
      ...options.headers,
    },
  })
}

function sessionCookie(response) {
  const value = response.headers.get('set-cookie')
  assert.ok(value, 'response should set a session cookie')
  return value.split(';', 1)[0]
}

test('account session preserves a snapshot across logout and login', async () => {
  const credentials = JSON.stringify({ username: 'player.one', password: 'correct-horse-42' })
  const registered = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: credentials,
  })
  assert.equal(registered.status, 201)
  const firstCookie = sessionCookie(registered)
  assert.equal((await registered.json()).user.username, 'player.one')

  const session = await request('/api/auth/session', { headers: { Cookie: firstCookie } })
  assert.equal((await session.json()).user.username, 'player.one')

  const snapshot = Buffer.alloc(22)
  snapshot[0] = 0x50
  snapshot[1] = 0x4b
  const uploaded = await request('/api/sync', {
    method: 'PUT',
    headers: { Cookie: firstCookie, 'Content-Type': 'application/zip' },
    body: snapshot,
  })
  assert.equal(uploaded.status, 200)
  assert.equal((await uploaded.json()).revision, 1)

  const downloaded = await request('/api/sync', { headers: { Cookie: firstCookie } })
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('x-advance-revision'), '1')
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), snapshot)

  const unchanged = await request('/api/sync', {
    headers: { Cookie: firstCookie, 'If-None-Match': '"advance-1"' },
  })
  assert.equal(unchanged.status, 304)
  assert.equal(unchanged.headers.get('etag'), '"advance-1"')

  const gameId = 'a'.repeat(64)
  const itemUploaded = await request(`/api/library/${gameId}`, {
    method: 'PUT',
    headers: { Cookie: firstCookie, 'Content-Type': 'application/zip' },
    body: snapshot,
  })
  assert.equal(itemUploaded.status, 200)
  const itemReceipt = await itemUploaded.json()
  assert.equal(itemReceipt.revision, 1)
  assert.equal(itemReceipt.size, snapshot.length)

  const library = await request('/api/library', { headers: { Cookie: firstCookie } })
  assert.equal(library.status, 200)
  const libraryBody = await library.json()
  assert.equal(libraryBody.revision, 1)
  assert.deepEqual(
    libraryBody.items.map((item) => item.gameId),
    [gameId],
  )

  const currentLibrary = await request('/api/library', {
    headers: { Cookie: firstCookie, 'If-None-Match': '"advance-library-1"' },
  })
  assert.equal(currentLibrary.status, 304)

  const itemDownloaded = await request(`/api/library/${gameId}`, {
    headers: { Cookie: firstCookie },
  })
  assert.equal(itemDownloaded.status, 200)
  assert.deepEqual(Buffer.from(await itemDownloaded.arrayBuffer()), snapshot)

  const itemDeleted = await request(`/api/library/${gameId}`, {
    method: 'DELETE',
    headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(itemDeleted.status, 200)
  assert.equal((await itemDeleted.json()).revision, 2)
  const emptyLibrary = await request('/api/library', { headers: { Cookie: firstCookie } })
  assert.deepEqual((await emptyLibrary.json()).items, [])

  const loggedOut = await request('/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(loggedOut.status, 200)
  const expiredSession = await request('/api/auth/session', { headers: { Cookie: firstCookie } })
  assert.equal((await expiredSession.json()).user, null)

  const rejected = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'player.one', password: 'incorrect-password' }),
  })
  assert.equal(rejected.status, 401)

  const loggedIn = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: credentials,
  })
  assert.equal(loggedIn.status, 200)
  const secondCookie = sessionCookie(loggedIn)
  const restored = await request('/api/sync', { headers: { Cookie: secondCookie } })
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), snapshot)

  const duplicate = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: credentials,
  })
  assert.equal(duplicate.status, 409)
})

test('mutating endpoints reject cross-origin requests', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other-user', password: 'valid-password' }),
  })
  assert.equal(response.status, 403)
})

test('sync requires an authenticated session', async () => {
  for (const pathname of ['/api/sync', '/api/library', `/api/library/${'a'.repeat(64)}`]) {
    const response = await request(pathname)
    assert.equal(response.status, 401)
  }
})
