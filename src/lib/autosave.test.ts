import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  automaticSlotLabel,
  automaticSlots,
  isAutomaticSlot,
  latestAutomaticState,
  nextAutomaticSlot,
} from './autosave.ts'

test('automatic slot count selects up to three reserved slots', () => {
  assert.deepEqual(automaticSlots(1), [0])
  assert.deepEqual(automaticSlots(2), [0, 6])
  assert.deepEqual(automaticSlots(3), [0, 6, 7])
  assert.equal(isAutomaticSlot(0), true)
  assert.equal(isAutomaticSlot(6), true)
  assert.equal(isAutomaticSlot(7), true)
  assert.equal(isAutomaticSlot(1), false)
  assert.equal(automaticSlotLabel(6), '自动存档 2')
  assert.equal(automaticSlotLabel(4), '存档位 4')
})

test('automatic saves fill empty slots and then overwrite the oldest configured slot', () => {
  const states = [
    { slot: 0, createdAt: 30 },
    { slot: 6, createdAt: 10 },
    { slot: 7, createdAt: 20 },
    { slot: 1, createdAt: 1 },
  ]
  assert.equal(nextAutomaticSlot([], 3), 0)
  assert.equal(nextAutomaticSlot(states.slice(0, 1), 3), 6)
  assert.equal(nextAutomaticSlot(states, 3), 6)
  assert.equal(nextAutomaticSlot(states, 1), 0)
})

test('resume selects the newest state among configured automatic slots only', () => {
  const states = [
    { slot: 0, createdAt: 10, marker: 'first' },
    { slot: 6, createdAt: 30, marker: 'second' },
    { slot: 7, createdAt: 20, marker: 'third' },
    { slot: 1, createdAt: 40, marker: 'manual' },
  ]
  assert.equal(latestAutomaticState(states, 3)?.marker, 'second')
  assert.equal(latestAutomaticState(states, 1)?.marker, 'first')
  assert.equal(latestAutomaticState([{ slot: 7, createdAt: 20 }], 2), undefined)
})
