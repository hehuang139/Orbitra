import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultBindings, normalizeSettings } from './preferences.ts'

test('legacy preferences retain keyboard bindings and receive touch defaults', () => {
  const settings = normalizeSettings({ volume: 0.3, touch: true, bindings: { A: 'KeyV' } })
  assert.equal(settings.bindings.A, 'KeyV')
  assert.equal(settings.volume, 0.3)
  assert.equal(settings.touch, true)
  assert.deepEqual(settings.touchConfig, {
    layout: 'standard',
    mode: 'panel',
    scale: 1,
    opacity: 1,
  })
  assert.equal(settings.autoSaveInterval, 1)
  assert.equal(settings.autoSaveSlotCount, 3)
})

test('retains one to three automatic slots and defaults legacy settings to three', () => {
  assert.equal(normalizeSettings({ autoSaveSlotCount: 1 }).autoSaveSlotCount, 1)
  assert.equal(normalizeSettings({ autoSaveSlotCount: 2 }).autoSaveSlotCount, 2)
  assert.equal(normalizeSettings({ autoSaveSlotCount: 3 }).autoSaveSlotCount, 3)
  for (const value of [0, 4, '2', null]) {
    assert.equal(normalizeSettings({ autoSaveSlotCount: value }).autoSaveSlotCount, 3)
  }
})

test('retains supported automatic save intervals and migrates all other values to one minute', () => {
  assert.equal(normalizeSettings({ autoSaveInterval: 5 }).autoSaveInterval, 5)
  assert.equal(normalizeSettings({ autoSaveInterval: 10 }).autoSaveInterval, 10)
  for (const value of [0, 2, 60, '5', null]) {
    assert.equal(normalizeSettings({ autoSaveInterval: value }).autoSaveInterval, 1)
  }
})

test('invalid, reserved and duplicate mappings cannot break startup or trap navigation', () => {
  for (const raw of [
    null,
    [],
    12,
    { volume: Infinity, bindings: { A: 'Tab', B: 'Unidentified' } },
    { bindings: { A: 'KeyZ' } },
    { bindings: { A: 'ControlLeft' } },
  ]) {
    const settings = normalizeSettings(raw)
    assert.deepEqual(settings.bindings, defaultBindings)
    assert.equal(settings.volume, 0.65)
  }
  assert.notEqual(normalizeSettings(null).bindings, defaultBindings)
})
