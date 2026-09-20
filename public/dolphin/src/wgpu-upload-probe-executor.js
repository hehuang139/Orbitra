// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { createWgpuMappedStagingPool } from "./wgpu-mapped-staging-pool.js";
import {
  WGPU_CONSUMER_ERROR_DEVICE_LOST,
  WGPU_CONSUMER_ERROR_SUBMIT,
  WGPU_CONSUMER_ERROR_UNKNOWN,
  enableWgpuNonDroppingBackpressure,
  failWgpuRingConsumer,
  publishWgpuRingProgress,
} from "./wgpu-ring-backpressure.js";
import {
  enableWgpuUploadWatermark,
  publishWgpuUploadRead,
} from "./wgpu-upload-watermark.js";

export const WGPU_UPLOAD_PROBE_SCHEMA =
  "wasm-dolphin.wgpu-renderer-worker-upload-probe.v1";
export const WGPU_UPLOAD_PROBE_OWNER = Object.freeze({
  none: 0,
  inline: 1,
  worker: 2,
  null: 3,
  failed: 4,
});

const OP_CREATE_BUFFER = 5;
const OP_UPLOAD_BUFFER = 6;
const OP_CREATE_TEXTURE = 7;
const OP_UPLOAD_TEXTURE = 8;
const OP_SUBMIT_PRESENT = 22;
const OP_DESTROY = 23;
const MAX_OPCODE = 24;
const RECORD_BYTES = 32;
const HEADER_WORDS = 7;
const OWNER_WORDS = 4;
const DEFAULT_MAX_RECORDS = 16384;
const DEFAULT_SLOT_BYTES = 16 * 1024 * 1024;
const MAX_SUBMIT_DIGESTS = 1024;
const REQUIRED_STABLE_EMPTY_OBSERVATIONS = 2;
const REQUIRED_STABLE_EMPTY_MS = 50;
const TEXTURE_FORMATS = Object.freeze([
  "rgba8unorm", "bgra8unorm", "depth24plus", "depth32float",
  "depth24plus-stencil8", "rgba16float", "r16uint", "r32float",
  "rgb10a2unorm",
]);

export function createWgpuUploadProbeExecutor({
  mode,
  device = null,
  ownerBuffer,
  slotCount = 3,
  slotSize = DEFAULT_SLOT_BYTES,
  now = () => performance.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (handle) => clearTimeout(handle),
  onSnapshot = () => {},
  onFatal = () => {},
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const gpuEnabled = normalizedMode !== "null-drain";
  if (gpuEnabled && (!device?.createBuffer || !device?.createTexture || !device?.queue?.submit)) {
    throw new TypeError("GPU upload probes require a WebGPU device and queue");
  }
  if (!(ownerBuffer instanceof SharedArrayBuffer) || ownerBuffer.byteLength < OWNER_WORDS * 4) {
    throw new TypeError("upload probe ownership requires a four-word SharedArrayBuffer");
  }

  const executionLocation = normalizedMode === "inline-upload"
    ? "inline"
    : normalizedMode === "worker-upload" ? "worker" : "null";
  const ownerToken = WGPU_UPLOAD_PROBE_OWNER[executionLocation];
  const owner = new Int32Array(ownerBuffer, 0, OWNER_WORDS);
  const buffers = new Map();
  const textures = new Map();
  const histogram = new Array(MAX_OPCODE + 1).fill(0);
  const completionSamples = [];
  const submitDigests = [];
  const remapPromises = new Set();
  const completionPromises = new Set();
  const deferredDestroy = [];
  let pool = gpuEnabled ? createWgpuMappedStagingPool({
    device,
    slotCount,
    slotSize,
    bufferUsage: 0x0002 | 0x0004,
    mapMode: 0x0002,
    now,
  }) : null;
  let ring = null;
  let timer = null;
  let dueAt = 0;
  let stopped = false;
  let fatal = null;
  let digest = 2166136261 >>> 0;
  let submitDigest = 2166136261 >>> 0;
  let lastSnapshotAt = 0;
  let heldRecordIndex = null;
  const stats = {
    requested: normalizedMode,
    active: false,
    passed: false,
    schema: WGPU_UPLOAD_PROBE_SCHEMA,
    executorLocation: executionLocation,
    blankOutput: true,
    sharedHeap: true,
    protocolVersion: 0,
    claimedOwner: WGPU_UPLOAD_PROBE_OWNER.none,
    claimCount: 0,
    conflictCount: 0,
    ownershipEpoch: 0,
    handoffAckCount: 0,
    pumpCount: 0,
    pumpTotalMs: 0,
    pumpMaxMs: 0,
    wakeDelayTotalMs: 0,
    wakeDelayMaxMs: 0,
    observedRecordCount: 0,
    consumedRecordCount: 0,
    skippedRecordCount: 0,
    invalidRecordCount: 0,
    unknownOpcodeCount: 0,
    readPublishCount: 0,
    initialRead: 0,
    finalRead: 0,
    finalWrite: 0,
    backlog: 0,
    quiesced: false,
    uploadRecordCount: 0,
    releasedUploadCount: 0,
    bufferUploadCalls: 0,
    bufferUploadBytes: 0,
    textureUploadCalls: 0,
    textureUploadBytes: 0,
    totalUploadBytes: 0,
    invalidUploadSpanCount: 0,
    uploadReleaseMismatchCount: 0,
    watermarkPublishCount: 0,
    initialUploadRead: 0,
    finalUploadRead: 0,
    bufferCreateCount: 0,
    textureCreateCount: 0,
    bufferDestroyCount: 0,
    textureDestroyCount: 0,
    missingResourceCount: 0,
    capacityHoldCount: 0,
    submissionCount: 0,
    gpuCompletionCount: 0,
    gpuCompletionTotalMs: 0,
    gpuCompletionMaxMs: 0,
    deviceLossCount: 0,
    fatalCount: 0,
    fatalScope: "",
    fatalError: "",
  };

  if (gpuEnabled && device.lost?.then) {
    device.lost.then((info) => {
      stats.deviceLossCount += 1;
      markFatal("device-lost", info?.message || info?.reason || "device lost",
        WGPU_CONSUMER_ERROR_DEVICE_LOST);
    });
  }

  function attach({
    heapBuffer,
    headerPtr,
    headerWords,
    slotsPtr,
    capacity,
    uploadPtr,
    uploadSize,
    protocolVersion,
    start = true,
  } = {}) {
    if (ring) throw new Error("upload probe ring is already attached");
    if (!(heapBuffer instanceof SharedArrayBuffer)) {
      throw new TypeError("upload probe heap must be a SharedArrayBuffer");
    }
    const descriptor = validateDescriptor({
      heapBytes: heapBuffer.byteLength,
      headerPtr, headerWords, slotsPtr, capacity, uploadPtr, uploadSize, protocolVersion,
    });
    const previous = Atomics.compareExchange(
      owner, 0, WGPU_UPLOAD_PROBE_OWNER.none, ownerToken
    );
    if (previous !== WGPU_UPLOAD_PROBE_OWNER.none) {
      stats.conflictCount += 1;
      throw new Error(`upload probe ring ownership conflict: ${previous}`);
    }
    stats.claimCount += 1;
    stats.claimedOwner = ownerToken;
    stats.ownershipEpoch = (Atomics.add(owner, 1, 1) + 1) >>> 0;
    const headerI32 = new Int32Array(heapBuffer, descriptor.headerPtr, HEADER_WORDS);
    ring = {
      ...descriptor,
      uploadBase: descriptor.uploadPtr,
      heapBuffer,
      heap: new Uint8Array(heapBuffer),
      u32: new Uint32Array(heapBuffer),
      headerI32,
      consumerRead: Atomics.load(headerI32, 1) >>> 0,
      uploadWatermarkEnabled: false,
      protocolV3Enabled: false,
    };
    if ((Atomics.load(headerI32, 2) >>> 0) !== descriptor.capacity) {
      markFatal("ring-descriptor", "header capacity does not match handoff");
      throw new Error(fatal.detail);
    }
    enableWgpuUploadWatermark(ring);
    enableWgpuNonDroppingBackpressure(ring);
    publishRead(ring.consumerRead);
    stats.initialRead = ring.consumerRead;
    stats.initialUploadRead = Atomics.load(headerI32, 3) >>> 0;
    stats.protocolVersion = descriptor.protocolVersion;
    stats.active = true;
    stats.passed = true;
    stats.handoffAckCount += 1;
    Atomics.store(owner, 2, 1);
    Atomics.notify(owner, 2);
    emitSnapshot(true);
    if (start) schedulePump(0);
    return snapshot();
  }

  function drain(maxRecords = DEFAULT_MAX_RECORDS) {
    if (!ring || stopped || fatal) return snapshot();
    const startedAt = now();
    const write = Atomics.load(ring.headerI32, 0) >>> 0;
    let read = ring.consumerRead >>> 0;
    const backlog = (write - read) >>> 0;
    if (backlog > ring.capacity) {
      stats.invalidRecordCount += 1;
      markFatal("ring-overrun", `backlog ${backlog} exceeds capacity ${ring.capacity}`);
      return snapshot();
    }
    let processed = 0;
    while (read !== write && processed < maxRecords && !fatal) {
      const word = (ring.slotsPtr + (read % ring.capacity) * RECORD_BYTES) >>> 2;
      const op = ring.u32[word] >>> 0;
      const firstObservation = heldRecordIndex !== read;
      if (firstObservation) {
        heldRecordIndex = read;
        stats.observedRecordCount += 1;
      }
      if (op > MAX_OPCODE) {
        if (firstObservation) stats.unknownOpcodeCount += 1;
        markFatal("unknown-opcode", `unknown opcode ${op}`);
        break;
      }
      if (firstObservation) {
        histogram[op] += 1;
        hashRecord(op, word);
      }
      let result;
      try {
        result = executeRecord(op, word, firstObservation);
      } catch (error) {
        stats.invalidRecordCount += 1;
        markFatal("record-execution", error?.message || error);
        result = "fatal";
      }
      if (result === "capacity") {
        stats.capacityHoldCount += 1;
        if (!submitPending("capacity") && remapPromises.size === 0) {
          markFatal("staging-capacity", "capacity hold has no submit path");
        }
        break;
      }
      if (result === "fatal") break;
      if (result === "skipped") stats.skippedRecordCount += 1;
      read = (read + 1) >>> 0;
      heldRecordIndex = null;
      processed += 1;
      stats.consumedRecordCount += 1;
    }
    if (read !== ring.consumerRead) publishRead(read);
    const elapsed = Math.max(0, now() - startedAt);
    stats.pumpCount += 1;
    stats.pumpTotalMs += elapsed;
    stats.pumpMaxMs = Math.max(stats.pumpMaxMs, elapsed);
    updateRingStats();
    emitSnapshot(false);
    return snapshot();
  }

  function executeRecord(op, word, firstObservation) {
    if (op === OP_CREATE_BUFFER) {
      const id = ring.u32[word + 1] >>> 0;
      if (!id) return invalid("create-buffer", "buffer id is zero");
      if (!buffers.has(id)) {
        const size = Math.max(16, ((ring.u32[word + 2] >>> 0) + 3) & ~3);
        const usage = ring.u32[word + 3] >>> 0;
        buffers.set(id, gpuEnabled ? device.createBuffer({ size, usage }) : { size, usage });
        stats.bufferCreateCount += 1;
      }
      return "consumed";
    }
    if (op === OP_CREATE_TEXTURE) {
      const id = ring.u32[word + 1] >>> 0;
      if (!id) return invalid("create-texture", "texture id is zero");
      if (!textures.has(id)) {
        const width = Math.max(1, ring.u32[word + 2] >>> 0);
        const height = Math.max(1, ring.u32[word + 3] >>> 0);
        const format = TEXTURE_FORMATS[ring.u32[word + 4] >>> 0] || "rgba8unorm";
        const usage = ring.u32[word + 5] >>> 0;
        const layers = Math.max(1, ring.u32[word + 6] >>> 0 || 1);
        const texture = gpuEnabled
          ? device.createTexture({ size: [width, height, layers], format, usage })
          : { width, height, depthOrArrayLayers: layers };
        textures.set(id, { texture, format, layers });
        stats.textureCreateCount += 1;
      }
      return "consumed";
    }
    if (op === OP_UPLOAD_BUFFER) return executeBufferUpload(word, firstObservation);
    if (op === OP_UPLOAD_TEXTURE) return executeTextureUpload(word, firstObservation);
    if (op === OP_SUBMIT_PRESENT) {
      closeSubmitDigest();
      submitPending("present");
      return "consumed";
    }
    if (op === OP_DESTROY) {
      submitPending("destroy");
      const tag = ring.u32[word + 1] >>> 0;
      const id = ring.u32[word + 2] >>> 0;
      if (tag === 1) {
        const resource = buffers.get(id);
        if (resource) {
          buffers.delete(id);
          deferResourceDestroy(resource);
          stats.bufferDestroyCount += 1;
        }
      }
      if (tag === 2) {
        const resource = textures.get(id);
        if (resource) {
          textures.delete(id);
          deferResourceDestroy(resource.texture);
          stats.textureDestroyCount += 1;
        }
      }
      return "consumed";
    }
    return "skipped";
  }

  function executeBufferUpload(word, firstObservation) {
    const id = ring.u32[word + 1] >>> 0;
    const destinationOffset = ring.u32[word + 2] >>> 0;
    const pointer = ring.u32[word + 3] >>> 0;
    const bytes = ring.u32[word + 4] >>> 0;
    if (firstObservation) {
      stats.uploadRecordCount += 1;
      stats.bufferUploadCalls += 1;
      stats.bufferUploadBytes += bytes;
      stats.totalUploadBytes += bytes;
    }
    if (!validateUploadSpan(pointer, bytes)) return "fatal";
    if (firstObservation) hashPayload(pointer, bytes);
    const destination = buffers.get(id);
    if (!destination) {
      stats.missingResourceCount += 1;
      return releaseUpload(pointer, bytes) ? "consumed" : "fatal";
    }
    if (gpuEnabled) {
      const padded = (bytes + 3) & ~3;
      const data = padded === bytes
        ? new Uint8Array(ring.heapBuffer, pointer, bytes)
        : paddedUploadCopy(pointer, bytes, padded);
      const staged = pool.stageBuffer({
        data,
        destination,
        destinationOffset: destinationOffset & ~3,
      });
      if (!staged.ok) return staged.reason === "no-capacity" ? "capacity" : invalid(
        "stage-buffer", staged.reason
      );
    }
    return releaseUpload(pointer, bytes) ? "consumed" : "fatal";
  }

  function executeTextureUpload(word, firstObservation) {
    const id = ring.u32[word + 1] >>> 0;
    const pointer = ring.u32[word + 2] >>> 0;
    const bytesPerRow = ring.u32[word + 3] >>> 0;
    const width = ring.u32[word + 4] >>> 0;
    const height = ring.u32[word + 5] >>> 0;
    const mipLevel = ring.u32[word + 6] >>> 0;
    const layer = ring.u32[word + 7] >>> 0;
    const bytes = bytesPerRow * height;
    if (firstObservation) {
      stats.uploadRecordCount += 1;
      stats.textureUploadCalls += 1;
      stats.textureUploadBytes += bytes;
      stats.totalUploadBytes += bytes;
    }
    if (!width || !height || !bytesPerRow || !Number.isSafeInteger(bytes) ||
        bytes > 0xffffffff) {
      return invalid(
        "upload-texture-layout",
        `invalid texture upload layout bpr=${bytesPerRow} width=${width} height=${height}`
      );
    }
    if (!validateUploadSpan(pointer, bytes)) return "fatal";
    if (firstObservation) hashPayload(pointer, bytes);
    const destination = textures.get(id);
    if (!destination || destination.format.startsWith("depth") || layer >= destination.layers) {
      if (!destination) stats.missingResourceCount += 1;
      return releaseUpload(pointer, bytes) ? "consumed" : "fatal";
    }
    if (gpuEnabled) {
      const staged = pool.stageTexture({
        data: new Uint8Array(ring.heapBuffer, pointer, bytes),
        destination: destination.texture,
        sourceBytesPerRow: bytesPerRow,
        sourceRowsPerImage: height,
        mipLevel,
        origin: { x: 0, y: 0, z: layer },
        copySize: { width, height, depthOrArrayLayers: 1 },
      });
      if (!staged.ok) return staged.reason === "no-capacity" ? "capacity" : invalid(
        "stage-texture", staged.reason
      );
    }
    return releaseUpload(pointer, bytes) ? "consumed" : "fatal";
  }

  function submitPending(reason) {
    if (!gpuEnabled || !pool) return false;
    let batch;
    try {
      batch = pool.seal();
    } catch (error) {
      markFatal("staging-seal", error?.message || error, WGPU_CONSUMER_ERROR_SUBMIT);
      return false;
    }
    if (!batch) return false;
    const submittedAt = now();
    try {
      device.queue.submit([batch.commandBuffer]);
      stats.submissionCount += 1;
    } catch (error) {
      pool.rejectSubmission(batch, error);
      markFatal("submit", error?.message || error, WGPU_CONSUMER_ERROR_SUBMIT);
      return false;
    }
    let remapResult;
    try {
      remapResult = pool.acceptSubmission(batch);
    } catch (error) {
      markFatal("remap-start", error?.message || error);
      return false;
    }
    const remap = Promise.resolve(remapResult).then((ok) => {
      if (!ok) markFatal("remap", `mapped staging remap failed after ${reason}`);
      return ok;
    }, (error) => {
      markFatal("remap", error?.message || error);
      return false;
    }).finally(() => {
      remapPromises.delete(remap);
      if (!stopped && !fatal) schedulePump(0);
    });
    remapPromises.add(remap);
    if (typeof device.queue.onSubmittedWorkDone === "function") {
      let completionResult;
      try {
        completionResult = device.queue.onSubmittedWorkDone();
      } catch (error) {
        markFatal("gpu-completion", error?.message || error, WGPU_CONSUMER_ERROR_SUBMIT);
        return false;
      }
      const completion = Promise.resolve(completionResult).then(() => {
        const elapsed = Math.max(0, now() - submittedAt);
        stats.gpuCompletionCount += 1;
        stats.gpuCompletionTotalMs += elapsed;
        stats.gpuCompletionMaxMs = Math.max(stats.gpuCompletionMaxMs, elapsed);
        completionSamples.push(elapsed);
        if (completionSamples.length > 256) completionSamples.shift();
        destroyDeferredResources();
      }, (error) => markFatal(
        "gpu-completion", error?.message || error, WGPU_CONSUMER_ERROR_SUBMIT
      )).finally(() => completionPromises.delete(completion));
      completionPromises.add(completion);
    }
    return true;
  }

  async function quiesce({ timeoutMs = 10000 } = {}) {
    if (!ring) throw new Error("upload probe ring is not attached");
    const deadline = now() + timeoutMs;
    let stableEmptyObservations = 0;
    let stableWrite = null;
    let stableSince = null;
    if (timer !== null) {
      cancelSchedule(timer);
      timer = null;
    }
    while (!fatal && now() < deadline) {
      drain(Number.MAX_SAFE_INTEGER);
      submitPending("finalize");
      if (remapPromises.size) await Promise.race([
        Promise.allSettled([...remapPromises]),
        delay(Math.min(10, Math.max(0, deadline - now()))),
      ]);
      if (completionPromises.size) {
        await Promise.race([
          Promise.allSettled([...completionPromises]),
          delay(Math.min(10, Math.max(0, deadline - now()))),
        ]);
      }
      updateRingStats();
      const staging = pool?.snapshot();
      const empty = stats.backlog === 0 && remapPromises.size === 0 &&
        completionPromises.size === 0 &&
        (!staging || (staging.pendingUploads === 0 && staging.activeBatches === 0));
      if (empty && stableWrite === stats.finalWrite) {
        stableEmptyObservations += 1;
      } else if (empty) {
        stableWrite = stats.finalWrite;
        stableEmptyObservations = 1;
        stableSince = now();
      } else {
        stableWrite = null;
        stableEmptyObservations = 0;
        stableSince = null;
      }
      if (stableEmptyObservations >= REQUIRED_STABLE_EMPTY_OBSERVATIONS &&
          stableSince !== null && now() - stableSince >= REQUIRED_STABLE_EMPTY_MS) {
        stats.quiesced = true;
        destroyDeferredResources();
        emitSnapshot(true);
        return snapshot();
      }
      await delay(5);
    }
    stats.quiesced = false;
    markFatal("finalize-timeout", "upload probe did not quiesce before timeout");
    return snapshot();
  }

  async function beginMeasurement({ timeoutMs = 10000 } = {}) {
    const boundary = await quiesce({ timeoutMs });
    if (!boundary.quiesced || !boundary.passed) return boundary;
    resetMeasurementStats();
    stats.quiesced = false;
    emitSnapshot(true);
    schedulePump(0);
    return snapshot();
  }

  async function finalize({ timeoutMs = 10000 } = {}) {
    const finalSnapshot = await quiesce({ timeoutMs });
    if (finalSnapshot.quiesced && finalSnapshot.passed) {
      destroyRemainingResources();
      emitSnapshot(true);
    }
    return snapshot();
  }

  function resetMeasurementStats() {
    const read = ring.consumerRead >>> 0;
    const uploadRead = Atomics.load(ring.headerI32, 3) >>> 0;
    for (const name of [
      "pumpCount", "pumpTotalMs", "pumpMaxMs", "wakeDelayTotalMs", "wakeDelayMaxMs",
      "observedRecordCount", "consumedRecordCount", "skippedRecordCount",
      "invalidRecordCount", "unknownOpcodeCount", "readPublishCount",
      "uploadRecordCount", "releasedUploadCount", "bufferUploadCalls", "bufferUploadBytes",
      "textureUploadCalls", "textureUploadBytes", "totalUploadBytes",
      "invalidUploadSpanCount", "uploadReleaseMismatchCount", "watermarkPublishCount",
      "bufferCreateCount", "textureCreateCount", "bufferDestroyCount", "textureDestroyCount",
      "missingResourceCount", "capacityHoldCount", "submissionCount", "gpuCompletionCount",
      "gpuCompletionTotalMs", "gpuCompletionMaxMs",
    ]) stats[name] = 0;
    stats.initialRead = read;
    stats.finalRead = read;
    stats.finalWrite = Atomics.load(ring.headerI32, 0) >>> 0;
    stats.backlog = 0;
    stats.initialUploadRead = uploadRead;
    stats.finalUploadRead = uploadRead;
    histogram.fill(0);
    completionSamples.length = 0;
    submitDigests.length = 0;
    digest = 2166136261 >>> 0;
    submitDigest = 2166136261 >>> 0;
    heldRecordIndex = null;
  }

  function validateUploadSpan(pointer, bytes) {
    const base = ring.uploadPtr;
    const size = ring.uploadSize;
    const valid = bytes > 0 && bytes <= size && pointer >= base && pointer - base < size &&
      bytes <= size - (pointer - base) && pointer + bytes <= ring.heapBuffer.byteLength;
    if (!valid) {
      stats.invalidUploadSpanCount += 1;
      markFatal("upload-span", `invalid upload span ptr=${pointer} bytes=${bytes}`);
    }
    return valid;
  }

  function releaseUpload(pointer, bytes) {
    const next = publishWgpuUploadRead(ring, pointer, bytes);
    if (next === null) {
      stats.uploadReleaseMismatchCount += 1;
      markFatal("upload-watermark", `cannot release ptr=${pointer} bytes=${bytes}`);
      return false;
    }
    stats.releasedUploadCount += 1;
    stats.watermarkPublishCount += 1;
    stats.finalUploadRead = next;
    return true;
  }

  function publishRead(value) {
    ring.consumerRead = publishWgpuRingProgress(ring, 1, value);
    stats.finalRead = ring.consumerRead;
    stats.readPublishCount += 1;
  }

  function invalid(scope, detail) {
    stats.invalidRecordCount += 1;
    markFatal(scope, detail);
    return "fatal";
  }

  function markFatal(scope, detail, errorCode = WGPU_CONSUMER_ERROR_UNKNOWN) {
    if (fatal) return false;
    fatal = { scope: String(scope), detail: String(detail || "unknown") };
    stats.fatalCount += 1;
    stats.fatalScope = fatal.scope;
    stats.fatalError = fatal.detail;
    stats.passed = false;
    if (timer !== null) cancelSchedule(timer);
    timer = null;
    pool?.invalidate(fatal.detail);
    destroyDeferredResources();
    destroyRemainingResources();
    if (ring) failWgpuRingConsumer(ring, errorCode);
    Atomics.store(owner, 0, WGPU_UPLOAD_PROBE_OWNER.failed);
    Atomics.notify(owner, 0);
    onFatal({ ...fatal, errorCode });
    emitSnapshot(true);
    return true;
  }

  function hashRecord(op, word) {
    hashStreamWord(op);
    hashSubmitWord(op);
    const stableWords = op === OP_CREATE_BUFFER ? [2, 3]
      : op === OP_UPLOAD_BUFFER ? [4, 5]
        : op === OP_CREATE_TEXTURE ? [2, 3, 4, 5, 6]
          : op === OP_UPLOAD_TEXTURE ? [3, 4, 5, 6, 7]
            : op === OP_DESTROY ? [1]
              : [];
    for (const index of stableWords) hashStreamWord(ring.u32[word + index] >>> 0);
  }

  function hashPayload(pointer, bytes) {
    const head = Math.min(16, bytes);
    for (let index = 0; index < head; index += 1) hashPayloadByte(ring.heap[pointer + index]);
    const tailStart = Math.max(head, bytes - 16);
    for (let index = tailStart; index < bytes; index += 1) {
      hashPayloadByte(ring.heap[pointer + index]);
    }
  }

  function hashStreamWord(value) {
    hashPayloadByte(value & 0xff);
    hashPayloadByte((value >>> 8) & 0xff);
    hashPayloadByte((value >>> 16) & 0xff);
    hashPayloadByte((value >>> 24) & 0xff);
  }

  function hashSubmitWord(value) {
    for (const byte of [
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]) submitDigest = Math.imul((submitDigest ^ byte) >>> 0, 16777619) >>> 0;
  }

  function hashPayloadByte(value) {
    digest = Math.imul((digest ^ value) >>> 0, 16777619) >>> 0;
  }

  function closeSubmitDigest() {
    submitDigests.push(hex(submitDigest));
    if (submitDigests.length > MAX_SUBMIT_DIGESTS) submitDigests.shift();
    submitDigest = 2166136261 >>> 0;
  }

  function paddedUploadCopy(pointer, bytes, padded) {
    const copy = new Uint8Array(padded);
    copy.set(new Uint8Array(ring.heapBuffer, pointer, bytes));
    return copy;
  }

  function schedulePump(delayMs) {
    if (timer !== null || stopped || fatal || !ring) return;
    dueAt = now() + delayMs;
    timer = schedule(() => {
      timer = null;
      const wokeAt = now();
      const wakeDelay = Math.max(0, wokeAt - dueAt);
      stats.wakeDelayTotalMs += wakeDelay;
      stats.wakeDelayMaxMs = Math.max(stats.wakeDelayMaxMs, wakeDelay);
      drain();
      schedulePump(stats.backlog > 0 ? 0 : 1);
    }, delayMs);
  }

  function stop(reason = "stopped") {
    stopped = true;
    if (timer !== null) cancelSchedule(timer);
    timer = null;
    pool?.invalidate(reason);
    destroyDeferredResources();
    destroyRemainingResources();
    return snapshot();
  }

  function deferResourceDestroy(resource) {
    if (!gpuEnabled || typeof resource?.destroy !== "function") return;
    if (completionPromises.size === 0) {
      resource.destroy();
      return;
    }
    deferredDestroy.push(resource);
  }

  function destroyDeferredResources() {
    for (const resource of deferredDestroy.splice(0)) {
      try { resource.destroy?.(); } catch {}
    }
  }

  function destroyRemainingResources() {
    if (!gpuEnabled) return;
    for (const resource of buffers.values()) {
      try { resource.destroy?.(); } catch {}
    }
    for (const resource of textures.values()) {
      try { resource.texture?.destroy?.(); } catch {}
    }
    buffers.clear();
    textures.clear();
  }

  function updateRingStats() {
    if (!ring) return;
    stats.finalWrite = Atomics.load(ring.headerI32, 0) >>> 0;
    stats.finalRead = ring.consumerRead >>> 0;
    stats.finalUploadRead = Atomics.load(ring.headerI32, 3) >>> 0;
    stats.backlog = (stats.finalWrite - stats.finalRead) >>> 0;
    Atomics.store(owner, 3, (now() | 0));
  }

  function snapshot() {
    updateRingStats();
    const completionSorted = [...completionSamples].sort((left, right) => left - right);
    return {
      ...stats,
      opHistogram: [...histogram],
      streamDigest: hex(digest),
      submitDigests: [...submitDigests],
      gpuCompletionP95Ms: percentile(completionSorted, 0.95),
      staging: pool?.snapshot() ?? null,
      consumerState: ring ? Atomics.load(ring.headerI32, 5) >>> 0 : 0,
      consumerError: ring ? Atomics.load(ring.headerI32, 6) >>> 0 : 0,
    };
  }

  function emitSnapshot(force) {
    const time = now();
    if (!force && time - lastSnapshotAt < 250) return;
    lastSnapshotAt = time;
    onSnapshot(snapshot());
  }

  return Object.freeze({ attach, beginMeasurement, drain, finalize, snapshot, stop });
}

function validateDescriptor(value) {
  const descriptor = Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, Number(entry),
  ]));
  for (const key of [
    "heapBytes", "headerPtr", "headerWords", "slotsPtr", "capacity",
    "uploadPtr", "uploadSize", "protocolVersion",
  ]) {
    if (!Number.isSafeInteger(descriptor[key]) || descriptor[key] < 0) {
      throw new TypeError(`invalid upload probe descriptor ${key}`);
    }
  }
  if (descriptor.protocolVersion !== 3 || descriptor.headerWords < HEADER_WORDS) {
    throw new Error("upload probe requires command-ring protocol v3");
  }
  if (!descriptor.capacity || descriptor.headerPtr % 4 || descriptor.slotsPtr % 4 ||
      descriptor.uploadPtr % 4 ||
      descriptor.headerPtr + HEADER_WORDS * 4 > descriptor.heapBytes ||
      descriptor.slotsPtr + descriptor.capacity * RECORD_BYTES > descriptor.heapBytes ||
      !descriptor.uploadSize || descriptor.uploadPtr + descriptor.uploadSize > descriptor.heapBytes) {
    throw new RangeError("upload probe descriptor is outside the shared heap");
  }
  return descriptor;
}

function normalizeMode(value) {
  if (["inline-upload", "worker-upload", "null-drain"].includes(value)) return value;
  throw new RangeError(`invalid upload probe mode: ${value}`);
}

function percentile(sorted, quantile) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function hex(value) {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
