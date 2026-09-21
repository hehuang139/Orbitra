import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SESSION_RECOVERY_KEY,
  SESSION_RECOVERY_MAX_AGE,
  beginSessionRecovery,
  clearSessionRecovery,
  readSessionRecovery,
  updateSessionRecoveryState,
} from './session-recovery.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

test('records an active session and advances only its referenced state', () => {
  const storage = new MemoryStorage()
  const started = beginSessionRecovery('game-1', 'core-1', undefined, storage, 100)
  assert.deepEqual(started, {
    version: 1,
    gameId: 'game-1',
    coreId: 'core-1',
    startedAt: 100,
    updatedAt: 100,
  })
  assert.deepEqual(
    updateSessionRecoveryState('other', { slot: 0, createdAt: 90 }, storage, 110),
    started,
  )
  assert.deepEqual(
    updateSessionRecoveryState('game-1', { slot: 6, createdAt: 105 }, storage, 120),
    {
      ...started,
      updatedAt: 120,
      stateSlot: 6,
      stateCreatedAt: 105,
    },
  )
})

test('clears only the matching normally closed session', () => {
  const storage = new MemoryStorage()
  const now = Date.now()
  beginSessionRecovery('game-1', 'core-1', { slot: 1, createdAt: now - 10 }, storage, now)
  clearSessionRecovery('other', storage)
  assert.ok(storage.getItem(SESSION_RECOVERY_KEY))
  clearSessionRecovery('game-1', storage)
  assert.equal(storage.getItem(SESSION_RECOVERY_KEY), null)
})

test('drops corrupt, future, incomplete and stale records', () => {
  const now = SESSION_RECOVERY_MAX_AGE + 10_000
  const invalid = [
    '{',
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      version: 1,
      gameId: 'game-1',
      coreId: 'core-1',
      startedAt: now,
      updatedAt: now + 6 * 60 * 1000,
    }),
    JSON.stringify({
      version: 1,
      gameId: 'game-1',
      coreId: 'core-1',
      startedAt: 0,
      updatedAt: 0,
    }),
    JSON.stringify({
      version: 1,
      gameId: 'game-1',
      coreId: 'core-1',
      startedAt: now,
      updatedAt: now,
      stateSlot: 0,
    }),
  ]
  for (const value of invalid) {
    const storage = new MemoryStorage()
    storage.setItem(SESSION_RECOVERY_KEY, value)
    assert.equal(readSessionRecovery(storage, now), null)
    assert.equal(storage.getItem(SESSION_RECOVERY_KEY), null)
  }
})

test('storage failures do not surface a malformed recovery candidate', () => {
  const storage = {
    getItem() {
      throw new DOMException('Denied', 'SecurityError')
    },
    setItem() {
      throw new DOMException('Denied', 'SecurityError')
    },
    removeItem() {
      throw new DOMException('Denied', 'SecurityError')
    },
  }
  assert.equal(readSessionRecovery(storage), null)
  assert.throws(() => beginSessionRecovery('game-1', 'core-1', undefined, storage), /Denied/)
})
