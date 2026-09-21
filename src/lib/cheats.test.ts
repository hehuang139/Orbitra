import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mgbaCheatFile, normalizeCheatCode, validateCheats } from './cheats.ts'

test('normalizes pasted codes and validates a bounded per-game cheat list', () => {
  assert.equal(normalizeCheatCode('  1234 5678\r\n\r\n ABCD-EFGH  '), '1234 5678\nABCD-EFGH')
  assert.deepEqual(
    validateCheats([
      { id: 'infinite-health', name: '  Infinite health ', code: ' 1234 5678 ', enabled: true },
    ]),
    [{ id: 'infinite-health', name: 'Infinite health', code: '1234 5678', enabled: true }],
  )
})

test('rejects malformed and directive-injecting cheat data', () => {
  for (const value of [
    [
      { id: 'same', name: 'One', code: '1234', enabled: true },
      { id: 'same', name: 'Two', code: '5678', enabled: true },
    ],
    [{ id: 'bad id', name: 'One', code: '1234', enabled: true }],
    [{ id: 'one', name: 'One', code: '# injected', enabled: true }],
    [{ id: 'one', name: '', code: '1234', enabled: true }],
  ]) {
    assert.throws(() => validateCheats(value), /金手指/)
  }
})

test('serializes enabled and disabled mGBA sets without allowing metadata directives', () => {
  const bytes = mgbaCheatFile([
    { id: 'one', name: 'Infinite lives', code: '1111 2222+3333 4444', enabled: true },
    { id: 'two', name: 'Unlock all', code: 'AAAA BBBB', enabled: false },
  ])
  assert.equal(
    new TextDecoder().decode(bytes),
    '# Infinite lives\n1111 2222\n3333 4444\n!disabled\n# Unlock all\nAAAA BBBB\n',
  )
})
