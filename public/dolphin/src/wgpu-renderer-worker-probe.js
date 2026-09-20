// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  WGPU_UPLOAD_PROBE_SCHEMA,
  createWgpuUploadProbeExecutor,
} from "./wgpu-upload-probe-executor.js";

const CANARY_VALUE = 0x57a6cafe;
let uploadExecutor = null;
let uploadDevice = null;
let uploadMode = "off";

self.addEventListener("message", (event) => {
  handleMessage(event.data).catch((error) => postFailure(event.data, error));
});

async function handleMessage(message) {
  if (message?.type === "canary") {
    const result = await runCanary(message);
    self.postMessage({ type: "canary-result", ok: true, ...result });
    return;
  }
  if (message?.type === "upload-probe-init") {
    await initializeUploadProbe(message);
    return;
  }
  if (message?.type === "upload-probe-attach") {
    if (!uploadExecutor) throw new Error("upload probe is not initialized");
    const snapshot = uploadExecutor.attach(message.descriptor);
    self.postMessage({ type: "upload-probe-attached", ok: true, snapshot });
    return;
  }
  if (message?.type === "upload-probe-finalize") {
    if (!uploadExecutor) throw new Error("upload probe is not initialized");
    const snapshot = await uploadExecutor.finalize({ timeoutMs: message.timeoutMs });
    self.postMessage({
      type: "upload-probe-finalized",
      id: message.id,
      ok: snapshot.quiesced && snapshot.passed,
      snapshot,
    });
    return;
  }
  if (message?.type === "upload-probe-begin-measurement") {
    if (!uploadExecutor) throw new Error("upload probe is not initialized");
    const snapshot = await uploadExecutor.beginMeasurement({ timeoutMs: message.timeoutMs });
    self.postMessage({
      type: "upload-probe-measurement-begun",
      id: message.id,
      ok: snapshot.passed && snapshot.observedRecordCount === 0,
      snapshot,
    });
    return;
  }
  if (message?.type === "upload-probe-snapshot") {
    self.postMessage({
      type: "upload-probe-snapshot",
      id: message.id,
      ok: true,
      snapshot: uploadExecutor?.snapshot() ?? null,
    });
    return;
  }
  if (message?.type === "upload-probe-shutdown") {
    uploadExecutor?.stop("worker shutdown");
    uploadDevice?.destroy?.();
    uploadExecutor = null;
    uploadDevice = null;
    uploadMode = "off";
    self.postMessage({ type: "upload-probe-shutdown", id: message.id, ok: true });
  }
}

async function initializeUploadProbe({
  mode,
  ownerBuffer,
  powerPreference = "high-performance",
} = {}) {
  if (uploadExecutor) throw new Error("upload probe is already initialized");
  if (!self.crossOriginIsolated || !(ownerBuffer instanceof SharedArrayBuffer)) {
    throw new Error("upload probe requires cross-origin isolation and shared ownership");
  }
  if (!["worker-upload", "null-drain"].includes(mode)) {
    throw new Error(`nested worker cannot run upload probe mode ${mode}`);
  }
  const startedAt = performance.now();
  let adapterMs = 0;
  let deviceMs = 0;
  if (mode === "worker-upload") {
    if (!self.navigator?.gpu) throw new Error("WebGPU is unavailable in nested worker");
    const adapterStartedAt = performance.now();
    const adapter = await self.navigator.gpu.requestAdapter({ powerPreference });
    adapterMs = performance.now() - adapterStartedAt;
    if (!adapter) throw new Error("nested worker requestAdapter returned null");
    const deviceStartedAt = performance.now();
    uploadDevice = await adapter.requestDevice();
    deviceMs = performance.now() - deviceStartedAt;
  }
  uploadMode = mode;
  uploadExecutor = createWgpuUploadProbeExecutor({
    mode,
    device: uploadDevice,
    ownerBuffer,
    onSnapshot: (snapshot) => self.postMessage({
      type: "upload-probe-telemetry",
      snapshot,
    }),
    onFatal: (fatal) => self.postMessage({ type: "upload-probe-fatal", fatal }),
  });
  self.postMessage({
    type: "upload-probe-ready",
    ok: true,
    schema: WGPU_UPLOAD_PROBE_SCHEMA,
    mode,
    adapterMs,
    deviceMs,
    totalMs: performance.now() - startedAt,
  });
}

function postFailure(message, error) {
  self.postMessage({
    type: message?.type === "canary" ? "canary-result" : "upload-probe-error",
    id: message?.id,
    mode: uploadMode,
    ok: false,
    error: String(error?.stack || error?.message || error),
  });
}

async function runCanary({ sharedCanary, powerPreference = "high-performance" }) {
  if (!(sharedCanary instanceof SharedArrayBuffer)) {
    throw new Error("renderer worker canary requires SharedArrayBuffer");
  }
  if (!self.navigator?.gpu) throw new Error("WebGPU is unavailable in nested worker");
  const atomics = new Int32Array(sharedCanary);
  const startedAt = performance.now();
  Atomics.store(atomics, 0, CANARY_VALUE | 0);
  Atomics.notify(atomics, 0);

  const adapterStartedAt = performance.now();
  const adapter = await self.navigator.gpu.requestAdapter({ powerPreference });
  if (!adapter) throw new Error("nested worker requestAdapter returned null");
  const adapterMs = performance.now() - adapterStartedAt;
  const deviceStartedAt = performance.now();
  const device = await adapter.requestDevice();
  const deviceMs = performance.now() - deviceStartedAt;

  const source = device.createBuffer({
    size: 4,
    usage: 0x0002 | 0x0004,
    mappedAtCreation: true,
  });
  new Uint32Array(source.getMappedRange())[0] = CANARY_VALUE;
  source.unmap();
  const destination = device.createBuffer({ size: 4, usage: 0x0001 | 0x0008 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, destination, 0, 4);
  const submitStartedAt = performance.now();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  const gpuCompletionMs = performance.now() - submitStartedAt;
  const mapStartedAt = performance.now();
  await destination.mapAsync(0x0001);
  const mapMs = performance.now() - mapStartedAt;
  const observed = new Uint32Array(destination.getMappedRange())[0] >>> 0;
  destination.unmap();
  source.destroy();
  destination.destroy();
  device.destroy();
  if (observed !== CANARY_VALUE) {
    throw new Error(`nested worker GPU copy mismatch: ${observed.toString(16)}`);
  }
  return {
    schema: "wasm-dolphin.wgpu-renderer-worker-canary.v1",
    adapterMs,
    deviceMs,
    gpuCompletionMs,
    mapMs,
    totalMs: performance.now() - startedAt,
    observed,
    sabCanary: Atomics.load(atomics, 0) >>> 0,
  };
}
