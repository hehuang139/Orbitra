// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_PROTOCOL_FLAGS_HEADER_INDEX = 4;
export const WGPU_CONSUMER_STATE_HEADER_INDEX = 5;
export const WGPU_CONSUMER_ERROR_HEADER_INDEX = 6;

export const WGPU_PROTOCOL_NON_DROPPING_FLAG = 1 << 1;
export const WGPU_CONSUMER_STATE_RUNNING = 1;
export const WGPU_CONSUMER_STATE_FAILED = 2;

export const WGPU_CONSUMER_ERROR_UNKNOWN = 1;
export const WGPU_CONSUMER_ERROR_DEVICE_LOST = 2;
export const WGPU_CONSUMER_ERROR_SUBMIT = 3;

export function enableWgpuNonDroppingBackpressure(ring) {
  if (!ring?.headerI32 || ring.headerI32.length <= WGPU_CONSUMER_ERROR_HEADER_INDEX) {
    if (ring) ring.protocolV3Enabled = false;
    return false;
  }
  Atomics.store(ring.headerI32, WGPU_CONSUMER_ERROR_HEADER_INDEX, 0);
  Atomics.store(
    ring.headerI32,
    WGPU_CONSUMER_STATE_HEADER_INDEX,
    WGPU_CONSUMER_STATE_RUNNING
  );
  Atomics.or(
    ring.headerI32,
    WGPU_PROTOCOL_FLAGS_HEADER_INDEX,
    WGPU_PROTOCOL_NON_DROPPING_FLAG
  );
  Atomics.notify(ring.headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX);
  Atomics.notify(ring.headerI32, WGPU_CONSUMER_STATE_HEADER_INDEX);
  ring.protocolV3Enabled = true;
  return true;
}

export function failWgpuRingConsumer(ring, errorCode = WGPU_CONSUMER_ERROR_UNKNOWN) {
  if (!ring?.protocolV3Enabled ||
      ring.headerI32.length <= WGPU_CONSUMER_ERROR_HEADER_INDEX) {
    return false;
  }
  const previous = Atomics.compareExchange(
    ring.headerI32,
    WGPU_CONSUMER_STATE_HEADER_INDEX,
    WGPU_CONSUMER_STATE_RUNNING,
    WGPU_CONSUMER_STATE_FAILED
  );
  if (previous !== WGPU_CONSUMER_STATE_RUNNING) return false;
  Atomics.store(
    ring.headerI32,
    WGPU_CONSUMER_ERROR_HEADER_INDEX,
    Number(errorCode) | 0
  );
  // A producer can be sleeping on either command slots or upload bytes.
  Atomics.notify(ring.headerI32, 1);
  Atomics.notify(ring.headerI32, 3);
  Atomics.notify(ring.headerI32, WGPU_CONSUMER_STATE_HEADER_INDEX);
  return true;
}

export function publishWgpuRingProgress(ring, headerIndex, value) {
  const normalized = value >>> 0;
  Atomics.store(ring.headerI32, headerIndex, normalized | 0);
  Atomics.notify(ring.headerI32, headerIndex, 1);
  return normalized;
}
