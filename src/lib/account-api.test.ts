import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  clearOnlineLibraryConnection,
  normalizeOnlineLibraryUrl,
  OnlineLibraryClient,
  readOnlineLibraryConnection,
  saveOnlineLibraryConnection,
} from './account-api.ts'

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

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('normalizes and persists an explicit online library independently of the runtime origin', () => {
  assert.equal(
    normalizeOnlineLibraryUrl(' https://library.example.com/team/ '),
    'https://library.example.com/team',
  )
  assert.throws(() => normalizeOnlineLibraryUrl('/api'), /完整的在线游戏库地址/)
  assert.throws(
    () => normalizeOnlineLibraryUrl('https://user:secret@example.com'),
    /不能包含用户名或密码/,
  )
  assert.throws(() => normalizeOnlineLibraryUrl('https://example.com/?tenant=one'), /查询参数/)

  saveOnlineLibraryConnection({ url: 'https://library.example.com/', token: 'session-token' })
  assert.deepEqual(readOnlineLibraryConnection(), {
    url: 'https://library.example.com',
    token: 'session-token',
  })
  clearOnlineLibraryConnection()
  assert.equal(readOnlineLibraryConnection(), null)
})

test('targets the configured library path and authenticates with a bearer token', async () => {
  let request: Request | undefined
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init)
    return Response.json({ user: { id: 7, username: 'player', createdAt: 1 } })
  }
  const client = new OnlineLibraryClient('https://sync.example.com/advance', 'secret-token')
  const user = await client.getSession()
  assert.equal(request?.url, 'https://sync.example.com/advance/api/auth/session')
  assert.equal(request?.headers.get('authorization'), 'Bearer secret-token')
  assert.equal(user?.username, 'player')
})

test('rejects an address that responds but is not an Advance online library', async () => {
  globalThis.fetch = async () => Response.json({ service: 'something-else', version: 1 })
  const client = new OnlineLibraryClient('https://example.com')
  await assert.rejects(client.health(), /不是兼容的 Advance 在线游戏库/)
})
