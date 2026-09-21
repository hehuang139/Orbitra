import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { sha256 } from '@noble/hashes/sha256'
import {
  clearOnlineLibraryUrl,
  downloadOnlineLibraryGame,
  fetchOnlineLibraryManifest,
  gameIdForOnlineLibraryEntry,
  normalizeOnlineLibraryUrl,
  parseOnlineLibraryManifest,
  readOnlineLibraryUrl,
  saveOnlineLibraryUrl,
} from './online-library.ts'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const originalFetch = globalThis.fetch
const bytes = new Uint8Array(192).fill(7)
const digest = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    format: 'orbitra-online-library',
    version: 1,
    name: 'Test library',
    revision: 'revision-1',
    games: [
      {
        id: 'test-game',
        title: 'Test Game',
        filename: 'test-game.gba',
        platform: 'gba',
        size: bytes.length,
        sha256: digest,
        url: 'games/test-game.gba',
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('stores a distribution URL without account credentials', () => {
  assert.equal(
    normalizeOnlineLibraryUrl(' https://library.example.com/team/ '),
    'https://library.example.com/team',
  )
  assert.throws(() => normalizeOnlineLibraryUrl('/api'), /完整的在线游戏库地址/)
  assert.throws(
    () => normalizeOnlineLibraryUrl('https://user:secret@example.com'),
    /不能包含用户名或密码/,
  )
  saveOnlineLibraryUrl('https://library.example.com/')
  assert.equal(readOnlineLibraryUrl(), 'https://library.example.com')
  assert.equal(localStorage.getItem('advance.online-library')?.includes('token'), false)
  localStorage.setItem(
    'advance.online-library',
    JSON.stringify({ url: 'https://legacy.example.com', token: 'obsolete-account-token' }),
  )
  assert.equal(readOnlineLibraryUrl(), 'https://legacy.example.com')
  assert.equal(localStorage.getItem('advance.online-library')?.includes('token'), false)
  clearOnlineLibraryUrl()
  assert.equal(readOnlineLibraryUrl(), null)
})

test('validates a versioned manifest and derives the local content identity', () => {
  const parsed = parseOnlineLibraryManifest(
    manifest(),
    new URL('https://library.example.com/manifest.json'),
  )
  assert.equal(parsed.games[0].downloadUrl, 'https://library.example.com/games/test-game.gba')
  assert.equal(gameIdForOnlineLibraryEntry(parsed.games[0]), digest)
  assert.throws(
    () =>
      parseOnlineLibraryManifest(
        manifest({ version: 2 }),
        new URL('https://library.example.com/manifest.json'),
      ),
    /不是兼容/,
  )
  assert.throws(
    () =>
      parseOnlineLibraryManifest(
        manifest({ games: [{ ...manifest().games[0], platform: 'unknown' }] }),
        new URL('https://library.example.com/manifest.json'),
      ),
    /不支持的平台/,
  )
})

test('fetches the public manifest without credentials', async () => {
  let request: Request | undefined
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init)
    return Response.json(manifest())
  }
  const result = await fetchOnlineLibraryManifest('https://library.example.com/catalog')
  assert.equal(request?.url, 'https://library.example.com/catalog/manifest.json')
  assert.equal(request?.credentials, 'omit')
  assert.equal(request?.headers.get('authorization'), null)
  assert.equal(result.games.length, 1)
})

test('verifies ROM size and SHA-256 before returning bytes', async () => {
  const entry = parseOnlineLibraryManifest(
    manifest(),
    new URL('https://library.example.com/manifest.json'),
  ).games[0]
  globalThis.fetch = async () =>
    new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } })
  assert.deepEqual(await downloadOnlineLibraryGame(entry), bytes)

  globalThis.fetch = async () => new Response(new Uint8Array(bytes.length).fill(8))
  await assert.rejects(downloadOnlineLibraryGame(entry), /校验失败/)
})
