// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const INPUT_STATE_SLOT_COUNT = 12;
export const INPUT_STATE_SEQUENCE_SLOT = 11;

export function compareInputGenerations(candidate, current) {
  const delta = ((Number(candidate) >>> 0) - (Number(current) >>> 0)) >>> 0;
  if (delta === 0) return 0;
  return delta < 0x8000_0000 ? 1 : -1;
}

export function writeInputStateSnapshot(view, state = {}) {
  requireInputStateView(view);
  const previousSequence = Atomics.load(view, INPUT_STATE_SEQUENCE_SLOT) >>> 0;
  const writeSequence = ((previousSequence + 1) | 1) >>> 0;
  Atomics.store(view, INPUT_STATE_SEQUENCE_SLOT, writeSequence | 0);
  Atomics.store(view, 0, Number(state.mask) | 0);
  Atomics.store(view, 1, Number(state.stickX) | 0);
  Atomics.store(view, 2, Number(state.stickY) | 0);
  Atomics.store(view, 3, Number(state.cStickX) | 0);
  Atomics.store(view, 4, Number(state.cStickY) | 0);
  Atomics.store(view, 5, Number(state.triggerLeft) | 0);
  Atomics.store(view, 6, Number(state.triggerRight) | 0);
  Atomics.store(view, 7, Number(state.analogA) | 0);
  Atomics.store(view, 8, Number(state.analogB) | 0);
  Atomics.store(view, 10, Number(state.sentAtEpochMs) | 0);
  Atomics.store(view, 9, Number(state.inputGeneration) | 0);
  Atomics.store(view, INPUT_STATE_SEQUENCE_SLOT, (writeSequence + 1) | 0);
}

export function readInputStateSnapshot(view, { maxAttempts = 3 } = {}) {
  requireInputStateView(view);
  const attempts = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const sequenceBefore = Atomics.load(view, INPUT_STATE_SEQUENCE_SLOT) >>> 0;
    if (sequenceBefore & 1) {
      return { attempts: attempt, snapshot: null, status: "writer-active" };
    }
    const snapshot = {
      mask: Atomics.load(view, 0) >>> 0,
      stickX: Atomics.load(view, 1),
      stickY: Atomics.load(view, 2),
      cStickX: Atomics.load(view, 3),
      cStickY: Atomics.load(view, 4),
      triggerLeft: Atomics.load(view, 5),
      triggerRight: Atomics.load(view, 6),
      analogA: Atomics.load(view, 7),
      analogB: Atomics.load(view, 8),
      inputGeneration: Atomics.load(view, 9) >>> 0,
      sentAtEpochMsLow: Atomics.load(view, 10) >>> 0
    };
    const sequenceAfter = Atomics.load(view, INPUT_STATE_SEQUENCE_SLOT) >>> 0;
    if (sequenceBefore === sequenceAfter && !(sequenceAfter & 1)) {
      return { attempts: attempt, snapshot, status: "ok" };
    }
  }
  return { attempts, snapshot: null, status: "unstable" };
}

function requireInputStateView(view) {
  if (!(view instanceof Int32Array) || view.length < INPUT_STATE_SLOT_COUNT) {
    throw new TypeError(`input state transport requires ${INPUT_STATE_SLOT_COUNT} Int32 slots`);
  }
}
