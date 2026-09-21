import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTouchInput, defaultTouchConfig, normalizeTouchConfig } from './touch.ts'

test('migrates missing or malformed touch settings without retaining unknown fields', () => {
  for (const value of [undefined, null, false, 3, 'compact', []]) {
    assert.deepEqual(normalizeTouchConfig(value), defaultTouchConfig)
  }
  assert.deepEqual(
    normalizeTouchConfig({ layout: 'unknown', scale: '1.2', opacity: null, other: true }),
    defaultTouchConfig,
  )
  const normalized = normalizeTouchConfig(undefined)
  normalized.scale = 1.2
  assert.equal(defaultTouchConfig.scale, 1)
})

test('retains supported presets and clamps finite size and opacity values', () => {
  assert.deepEqual(
    normalizeTouchConfig({ layout: 'compact', mode: 'overlay', scale: 1.15, opacity: 0.65 }),
    {
      layout: 'compact',
      mode: 'overlay',
      scale: 1.15,
      opacity: 0.65,
    },
  )
  assert.deepEqual(normalizeTouchConfig({ scale: -2, opacity: 20 }), {
    layout: 'standard',
    mode: 'panel',
    scale: 0.8,
    opacity: 1,
  })
  assert.deepEqual(normalizeTouchConfig({ scale: 20, opacity: -2 }), {
    layout: 'standard',
    mode: 'panel',
    scale: 1.3,
    opacity: 0.4,
  })
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(normalizeTouchConfig({ scale: invalid, opacity: invalid }), defaultTouchConfig)
  }
})

test('keeps a button pressed until the last pointer or keyboard source releases', () => {
  const events: string[] = []
  const input = createTouchInput(
    (button) => events.push(`down:${button}`),
    (button) => events.push(`up:${button}`),
  )
  input.press('pointer:1', 'A')
  input.press('pointer:1', 'A')
  input.press('pointer:2', 'A')
  input.press('keyboard:A:Enter', 'A')
  input.release('pointer:1')
  input.release('pointer:1')
  input.release('pointer:2')
  assert.deepEqual(events, ['down:A'])
  assert.deepEqual(input.pressedButtons(), ['A'])
  input.release('keyboard:A:Enter')
  assert.deepEqual(events, ['down:A', 'up:A'])
  assert.deepEqual(input.pressedButtons(), [])
})

test('supports simultaneous direction and action buttons and reused pointer identifiers', () => {
  const events: string[] = []
  const input = createTouchInput(
    (button) => events.push(`down:${button}`),
    (button) => events.push(`up:${button}`),
  )
  input.press('pointer:1', 'Up')
  input.press('pointer:2', 'A')
  input.press('pointer:3', 'Right')
  input.press('pointer:1', 'Down')
  assert.deepEqual(input.pressedButtons(), ['A', 'Right', 'Down'])
  assert.deepEqual(events, ['down:Up', 'down:A', 'down:Right', 'up:Up', 'down:Down'])
})

test('releases each button once on interruption and accepts fresh input afterward', () => {
  const events: string[] = []
  const input = createTouchInput(
    (button) => events.push(`down:${button}`),
    (button) => events.push(`up:${button}`),
  )
  input.press('pointer:1', 'Left')
  input.press('pointer:2', 'Left')
  input.press('pointer:3', 'B')
  input.releaseAll()
  input.releaseAll()
  input.release('pointer:1')
  assert.deepEqual(events, ['down:Left', 'down:B', 'up:Left', 'up:B'])
  assert.deepEqual(input.pressedButtons(), [])
  input.press('pointer:1', 'Left')
  input.release('pointer:1')
  assert.deepEqual(events.slice(-2), ['down:Left', 'up:Left'])
})
