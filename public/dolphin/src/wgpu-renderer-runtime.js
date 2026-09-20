// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  WGPU_CONSUMER_ERROR_UNKNOWN,
  WGPU_CONSUMER_STATE_FAILED,
  WGPU_CONSUMER_STATE_HEADER_INDEX,
  enableWgpuNonDroppingBackpressure,
  failWgpuRingConsumer,
  publishWgpuRingProgress,
} from "./wgpu-ring-backpressure.js";
import {
  enableWgpuUploadWatermark,
  publishWgpuUploadRead,
} from "./wgpu-upload-watermark.js";
import {
  awaitWgpuQueueCompletion,
  createWgpuReplayStabilityTracker,
  requireWgpuReplayRing,
  validatePostCompletionReplaySnapshot,
} from "./wgpu-replay-quiescence.js";

const COMMAND_RECORD_BYTES = 32;
const PROTOCOL_V2_HEADER_WORDS = 5;
const PROTOCOL_V3_HEADER_WORDS = 7;

function integer(name, value, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new RangeError(`WGPU ring ${name} is invalid: ${value}`);
  }
  return number;
}

function alignedPointer(name, value) {
  const pointer = integer(name, value);
  if (pointer % 4 !== 0) {
    throw new RangeError(`WGPU ring ${name} must be 4-byte aligned`);
  }
  return pointer;
}

function checkedEnd(name, start, length, byteLength) {
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > byteLength) {
    throw new RangeError(`WGPU ring ${name} is outside the shared heap`);
  }
  return end;
}

function normalizeSessionId(sessionId) {
  if (
    (typeof sessionId === "string" && sessionId.length > 0) ||
    (Number.isSafeInteger(sessionId) && sessionId >= 0)
  ) {
    return sessionId;
  }
  throw new TypeError("WGPU ring sessionId must be a non-empty string or non-negative integer");
}

function count(value) {
  if (value instanceof Set || value instanceof Map) return value.size;
  return Math.max(0, Number(value) || 0);
}

function mappedState(snapshot) {
  const source = snapshot || {};
  const mapped = source.mapped || {};
  const compute = source.compute || {};
  return {
    pendingMappedUploads: count(source.pendingUploads),
    activeMappedBatches: source.activeBatches == null
      ? count(mapped.activeBatches) + count(compute.activeBatches)
      : count(source.activeBatches),
    pendingRemaps: count(source.pendingRemaps),
    capacityBlocked: Boolean(source.capacityBlocked),
    mappedDrainTimerPending: Boolean(source.timerPending ?? source.mappedDrainTimerPending),
  };
}

export function failWgpuRingDescriptor({
  heapBuffer,
  descriptor,
  errorCode = WGPU_CONSUMER_ERROR_UNKNOWN,
} = {}) {
  try {
    if (!(heapBuffer instanceof SharedArrayBuffer)) return false;
    const protocolVersion = integer("protocolVersion", descriptor?.protocolVersion);
    const headerWords = integer("headerWords", descriptor?.headerWords);
    if (protocolVersion !== 3 || headerWords < PROTOCOL_V3_HEADER_WORDS) return false;
    const headerPtr = alignedPointer("headerPtr", descriptor?.headerPtr);
    checkedEnd(
      "header",
      headerPtr,
      PROTOCOL_V3_HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT,
      heapBuffer.byteLength
    );
    const ring = {
      protocolV3Enabled: true,
      headerI32: new Int32Array(
        heapBuffer,
        headerPtr,
        PROTOCOL_V3_HEADER_WORDS
      ),
    };
    if (Atomics.load(ring.headerI32, WGPU_CONSUMER_STATE_HEADER_INDEX) ===
        WGPU_CONSUMER_STATE_FAILED) {
      return false;
    }
    if (!enableWgpuNonDroppingBackpressure(ring)) return false;
    return failWgpuRingConsumer(ring, errorCode);
  } catch {
    return false;
  }
}

export class WgpuRendererRuntime {
  constructor({
    drain = () => {},
    mappedSnapshot = () => null,
    finalizeMapped = async () => {},
    queue = () => null,
    coreState = () => "Paused",
    loadFenceActive = () => false,
    fatal = () => null,
    now = () => globalThis.performance.now(),
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  } = {}) {
    this.dependencies = {
      drain,
      mappedSnapshot,
      finalizeMapped,
      queue,
      coreState,
      loadFenceActive,
      fatal,
      now,
      delay,
      setTimeoutFn,
      clearTimeoutFn,
    };
    this.ring = null;
    this.lastAttachment = null;
  }

  attachRing({ sessionId, heapGeneration, heapBuffer, descriptor } = {}) {
    if (this.ring) throw new Error("WGPU command ring is already attached");
    if (this.dependencies.fatal()) {
      throw new Error("WGPU command ring cannot attach after a fatal replay state");
    }
    if (!(heapBuffer instanceof SharedArrayBuffer)) {
      throw new TypeError("WGPU command ring requires a SharedArrayBuffer heap");
    }
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedHeapGeneration = integer("heapGeneration", heapGeneration);
    if (
      this.lastAttachment?.sessionId === normalizedSessionId &&
      normalizedHeapGeneration <= this.lastAttachment.heapGeneration
    ) {
      throw new Error(
        `WGPU command ring session ${normalizedSessionId} requires a newer heap generation`
      );
    }

    const protocolVersion = integer("protocolVersion", descriptor?.protocolVersion, {
      minimum: 2,
    });
    if (protocolVersion !== 2 && protocolVersion !== 3) {
      throw new RangeError(`WGPU command ring protocol ${protocolVersion} is unsupported`);
    }
    const requiredHeaderWords = protocolVersion === 3
      ? PROTOCOL_V3_HEADER_WORDS
      : PROTOCOL_V2_HEADER_WORDS;
    const headerWords = integer("headerWords", descriptor?.headerWords, {
      minimum: requiredHeaderWords,
    });
    const headerPtr = alignedPointer("headerPtr", descriptor?.headerPtr);
    const slotsPtr = alignedPointer("slotsPtr", descriptor?.slotsPtr);
    const uploadPtr = alignedPointer("uploadPtr", descriptor?.uploadPtr);
    const capacity = integer("capacity", descriptor?.capacity, { minimum: 1 });
    const uploadSize = integer("uploadSize", descriptor?.uploadSize, { minimum: 1 });
    checkedEnd("header", headerPtr, headerWords * Int32Array.BYTES_PER_ELEMENT, heapBuffer.byteLength);
    checkedEnd("slots", slotsPtr, capacity * COMMAND_RECORD_BYTES, heapBuffer.byteLength);
    checkedEnd("upload arena", uploadPtr, uploadSize, heapBuffer.byteLength);

    const headerI32 = new Int32Array(heapBuffer, headerPtr, headerWords);
    const declaredCapacity = Atomics.load(headerI32, 2) >>> 0;
    if (declaredCapacity !== capacity) {
      throw new Error(
        `WGPU command ring capacity mismatch: descriptor=${capacity} header=${declaredCapacity}`
      );
    }
    const ring = {
      sessionId: normalizedSessionId,
      heapGeneration: normalizedHeapGeneration,
      heapBuffer,
      protocolVersion,
      headerPtr,
      headerWords,
      headerI32,
      headerU32: new Uint32Array(heapBuffer, headerPtr, headerWords),
      consumerRead: Atomics.load(headerI32, 1) >>> 0,
      slotsBase: slotsPtr,
      capacity,
      uploadBase: uploadPtr,
      uploadSize,
      uploadWatermarkEnabled: false,
      protocolV3Enabled: false,
      stagedUploads: new Map(),
      stagedUploadBytes: 0,
      heldReplayStart: null,
      stagedPassStart: null,
      stagedScanCursor: null,
    };
    if (!enableWgpuUploadWatermark(ring)) {
      throw new Error("WGPU command ring could not enable its upload watermark");
    }
    if (protocolVersion === 3 && !enableWgpuNonDroppingBackpressure(ring)) {
      throw new Error("WGPU command ring could not enable protocol-v3 backpressure");
    }
    this.ring = ring;
    this.lastAttachment = {
      sessionId: normalizedSessionId,
      heapGeneration: normalizedHeapGeneration,
    };
    return ring;
  }

  currentReadIndex() {
    const ring = this.ring;
    if (!ring) return 0;
    return ring.consumerRead == null
      ? Atomics.load(ring.headerI32, 1) >>> 0
      : ring.consumerRead >>> 0;
  }

  matchesRing({ heapBuffer, descriptor } = {}) {
    const ring = this.ring;
    return Boolean(ring) &&
      ring.heapBuffer === heapBuffer &&
      ring.headerPtr === Number(descriptor?.headerPtr) &&
      ring.headerWords === Number(descriptor?.headerWords) &&
      ring.slotsBase === Number(descriptor?.slotsPtr) &&
      ring.capacity === Number(descriptor?.capacity) &&
      ring.uploadBase === Number(descriptor?.uploadPtr) &&
      ring.uploadSize === Number(descriptor?.uploadSize) &&
      ring.protocolVersion === Number(descriptor?.protocolVersion);
  }

  currentUploadReadIndex() {
    return this.ring ? Atomics.load(this.ring.headerI32, 3) >>> 0 : 0;
  }

  publishReadIndex(readIndex) {
    if (!this.ring) throw new Error("WGPU command ring is not attached");
    const normalized = Number(readIndex) >>> 0;
    this.ring.consumerRead = normalized;
    return publishWgpuRingProgress(this.ring, 1, normalized);
  }

  publishUploadRead(uploadPointer, uploadBytes) {
    if (!this.ring) throw new Error("WGPU command ring is not attached");
    return publishWgpuUploadRead(this.ring, uploadPointer, uploadBytes);
  }

  emergencyFail(errorCode = WGPU_CONSUMER_ERROR_UNKNOWN) {
    return failWgpuRingConsumer(this.ring, errorCode);
  }

  detach({ fail = false, errorCode = WGPU_CONSUMER_ERROR_UNKNOWN } = {}) {
    const ring = this.ring;
    if (!ring) return null;
    const snapshot = this.snapshot();
    const clean = !snapshot.fatal &&
      snapshot.backlog === 0 &&
      snapshot.readIndex === snapshot.publishedReadIndex &&
      snapshot.stagedUploads === 0 &&
      !snapshot.heldReplay &&
      !snapshot.loadFenceActive &&
      snapshot.pendingMappedUploads === 0 &&
      snapshot.activeMappedBatches === 0 &&
      snapshot.pendingRemaps === 0 &&
      !snapshot.capacityBlocked &&
      !snapshot.mappedDrainTimerPending;
    if (fail) {
      if (ring.protocolVersion !== 3) {
        throw new Error("WGPU protocol-v2 ring cannot be detached with a failure signal");
      }
      const failed = this.emergencyFail(errorCode);
      const alreadyFailed = Atomics.load(
        ring.headerI32,
        WGPU_CONSUMER_STATE_HEADER_INDEX
      ) === WGPU_CONSUMER_STATE_FAILED;
      if (!failed && !alreadyFailed) {
        throw new Error("WGPU command ring failure could not be published before detach");
      }
    } else if (!clean) {
      throw new Error("WGPU command ring must be quiescent before clean detach");
    }
    this.ring = null;
    return {
      sessionId: ring.sessionId,
      heapGeneration: ring.heapGeneration,
      protocolVersion: ring.protocolVersion,
      readIndex: ring.consumerRead >>> 0,
      publishedReadIndex: Atomics.load(ring.headerI32, 1) >>> 0,
      uploadReadIndex: Atomics.load(ring.headerI32, 3) >>> 0,
    };
  }

  snapshot() {
    const ring = this.ring;
    const mapped = mappedState(this.dependencies.mappedSnapshot());
    const base = {
      sessionId: ring?.sessionId ?? null,
      heapGeneration: ring?.heapGeneration ?? null,
      registered: Boolean(ring),
      writeIndex: 0,
      readIndex: 0,
      publishedReadIndex: 0,
      uploadReadIndex: 0,
      backlog: 0,
      stagedUploads: 0,
      heldReplay: false,
      loadFenceActive: Boolean(this.dependencies.loadFenceActive()),
      ...mapped,
      fatal: this.dependencies.fatal(),
    };
    if (!ring) return base;
    const writeIndex = Atomics.load(ring.headerI32, 0) >>> 0;
    const readIndex = this.currentReadIndex();
    return {
      ...base,
      writeIndex,
      readIndex,
      publishedReadIndex: Atomics.load(ring.headerI32, 1) >>> 0,
      uploadReadIndex: this.currentUploadReadIndex(),
      backlog: (writeIndex - readIndex) >>> 0,
      stagedUploads: ring.stagedUploads.size,
      heldReplay: ring.heldReplayStart != null || ring.stagedPassStart != null ||
        ring.stagedScanCursor != null,
    };
  }

  async quiesce(timeoutMs = 30_000, { requireRing = false, requirePaused = true } = {}) {
    const timeout = integer("quiescence timeout", timeoutMs, { minimum: 1 });
    const {
      now,
      delay,
      drain,
      finalizeMapped,
      queue,
      coreState,
      setTimeoutFn,
      clearTimeoutFn,
    } = this.dependencies;
    const startedAtMs = now();
    const deadlineAtMs = startedAtMs + timeout;
    let drainCount = 0;
    const stabilityTracker = createWgpuReplayStabilityTracker();
    let snapshot = this.snapshot();
    const initial = { ...snapshot };
    requireWgpuReplayRing(snapshot, requireRing);
    if (requirePaused && coreState() !== "Paused") {
      throw new Error("WGPU replay finalization requires a paused core");
    }

    for (;;) {
      if (snapshot.fatal) {
        throw new Error("WGPU replay finalization found a fatal replay state");
      }
      if (snapshot.backlog > 0) {
        await drain({
          ring: this.ring,
          source: "pump",
          writeIndex: snapshot.writeIndex,
          readIndex: snapshot.readIndex,
        });
        drainCount += 1;
      }
      const remainingMs = deadlineAtMs - now();
      if (remainingMs <= 0) {
        throw new Error(`WGPU replay finalization timed out: ${JSON.stringify(snapshot)}`);
      }
      await finalizeMapped(remainingMs);
      snapshot = this.snapshot();
      const stability = stabilityTracker.observe(snapshot, now());
      if (stability.ready) {
        const gpuCompletion = await awaitWgpuQueueCompletion(queue(), {
          required: requireRing,
          deadlineAtMs,
          now,
          setTimeoutFn,
          clearTimeoutFn,
        });
        const postCompletionSnapshot = this.snapshot();
        validatePostCompletionReplaySnapshot(
          postCompletionSnapshot,
          stability.stableWriteIndex
        );
        return {
          quiesced: true,
          required: requireRing,
          coreStateName: coreState(),
          initial,
          ...postCompletionSnapshot,
          drainCount,
          stableEmptyObservations: stability.stableEmptyObservations,
          stableEmptyMs: stability.stableEmptyMs,
          gpuCompletion,
          elapsedMs: now() - startedAtMs,
        };
      }
      if (now() >= deadlineAtMs) {
        throw new Error(`WGPU replay finalization timed out: ${JSON.stringify(snapshot)}`);
      }
      await delay(5);
      snapshot = this.snapshot();
    }
  }
}
