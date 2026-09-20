// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

const noop = () => {};

export function handleWgpuDeviceLoss({
  activeDevice,
  lostDevice,
  info = null,
  recordError = noop,
  markFatal = noop,
  cancelReplay = noop,
  clearReplayState = noop,
  invalidateGeometry = noop,
  clearActiveDevice = noop,
  setBackend = noop,
  postStatus = noop,
} = {}) {
  const detail = String(info?.message || info?.reason || "unknown");
  if (!lostDevice || activeDevice !== lostDevice) {
    return { handled: false, detail };
  }

  recordError("device-lost", detail);
  markFatal("device-lost", detail);
  cancelReplay();
  clearReplayState();
  invalidateGeometry();
  clearActiveDevice();
  setBackend("webgpu-lost");
  postStatus(`WebGPU device lost: ${detail}`);
  return { handled: true, detail };
}
