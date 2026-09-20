// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { WGPU_UPLOAD_ROLE } from "./wgpu-upload-attribution.js";

export const WGPU_SPARSE_UBO_CLASS_SPECS = Object.freeze([
  Object.freeze({ name: "vs", size: 4112 }),
  Object.freeze({ name: "ps", size: 1536 }),
  Object.freeze({ name: "gs", size: 64 }),
]);

const CLASS_INDEX_BY_SIZE = new Map(
  WGPU_SPARSE_UBO_CLASS_SPECS.map((spec, index) => [spec.size, index])
);
let nextSparseUboInstanceId = 1;

export function planWgpuUboDirtyRanges(current, previous, blockBytes = 16) {
  const currentBytes = viewBytes(current);
  const previousBytes = viewBytes(previous);
  if (!currentBytes || !previousBytes || currentBytes.byteLength !== previousBytes.byteLength) {
    throw new TypeError("UBO diff inputs must be equal-length byte views");
  }
  if (!Number.isInteger(blockBytes) || blockBytes <= 0 || blockBytes % 4 !== 0) {
    throw new RangeError("UBO diff block size must be a positive multiple of four");
  }

  const ranges = [];
  let dirtyBytes = 0;
  for (let start = 0; start < currentBytes.byteLength; start += blockBytes) {
    const end = Math.min(start + blockBytes, currentBytes.byteLength);
    let dirty = false;
    for (let offset = start; offset < end; offset += 1) {
      if (currentBytes[offset] !== previousBytes[offset]) {
        dirty = true;
        break;
      }
    }
    if (!dirty) continue;
    dirtyBytes += end - start;
    const previousRange = ranges.at(-1);
    if (previousRange?.end === start) previousRange.end = end;
    else ranges.push({ start, end });
  }
  return { ranges, dirtyBytes };
}

export function createWgpuSparseUboCopyForward({
  device,
  coverageThreshold = 0.5,
  maxSparseRanges = 0,
  bufferUsage = 0x0004 | 0x0008,
} = {}) {
  if (!device?.createBuffer) throw new TypeError("device must create WebGPU buffers");
  if (!(coverageThreshold > 0 && coverageThreshold <= 1)) {
    throw new RangeError("coverageThreshold must be greater than zero and at most one");
  }
  if (!Number.isSafeInteger(maxSparseRanges) || maxSparseRanges < 0) {
    throw new RangeError("maxSparseRanges must be a non-negative safe integer");
  }
  const instanceId = nextSparseUboInstanceId++;

  const states = WGPU_SPARSE_UBO_CLASS_SPECS.map((spec) => ({
    spec,
    cpuShadow: new Uint8Array(spec.size),
    gpuShadow: null,
    valid: false,
  }));
  const metrics = {
    eligibleCalls: 0,
    baselineCalls: 0,
    sparseCalls: 0,
    equalCalls: 0,
    fullFallbackCalls: 0,
    capacityMisses: 0,
    fullBytes: 0,
    stagedBytes: 0,
    avoidedStagedBytes: 0,
    copyForwardBytes: 0,
    overlayRanges: 0,
    overlayBytes: 0,
    predictedGpuCopyBytes: 0,
    invalidations: 0,
    invalidationReasons: {},
    callsByClass: [0, 0, 0],
    sparseCallsByClass: [0, 0, 0],
    stagedBytesByClass: [0, 0, 0],
  };

  function stage({
    pool,
    data,
    destination,
    destinationOffset = 0,
    role = WGPU_UPLOAD_ROLE.UNKNOWN,
  } = {}) {
    const bytes = viewBytes(data);
    const classIndex = bytes ? CLASS_INDEX_BY_SIZE.get(bytes.byteLength) : undefined;
    if (role !== WGPU_UPLOAD_ROLE.UBO || classIndex === undefined) {
      return { handled: false, ok: false, reason: "ineligible" };
    }
    if (!pool?.stageBufferSnapshot) {
      throw new TypeError("sparse UBO staging requires a compound snapshot pool");
    }
    const state = states[classIndex];
    state.gpuShadow ??= device.createBuffer({
      label: `Dolphin sparse UBO ${state.spec.name} shadow`,
      size: state.spec.size,
      usage: bufferUsage,
    });

    let mode = "baseline";
    let copyForward = false;
    let ranges = [{ start: 0, end: bytes.byteLength }];
    let dirtyBytes = bytes.byteLength;
    if (state.valid) {
      const dirty = planWgpuUboDirtyRanges(bytes, state.cpuShadow);
      dirtyBytes = dirty.dirtyBytes;
      if (dirtyBytes === 0) {
        mode = "equal";
        copyForward = true;
        ranges = dirty.ranges;
      } else if (dirty.ranges.length <= maxSparseRanges &&
                 dirtyBytes / bytes.byteLength <= coverageThreshold) {
        mode = "sparse";
        copyForward = true;
        ranges = dirty.ranges;
      } else {
        mode = "full-fallback";
      }
    }

    const staged = pool.stageBufferSnapshot({
      data: bytes,
      destination,
      destinationOffset,
      shadowBuffer: state.gpuShadow,
      ranges,
      copyForward,
    });
    if (!staged.ok) {
      if (staged.reason === "no-capacity") metrics.capacityMisses += 1;
      return { handled: true, ok: false, reason: staged.reason, mode, classIndex };
    }

    state.cpuShadow.set(bytes);
    state.valid = true;
    metrics.eligibleCalls += 1;
    metrics.callsByClass[classIndex] += 1;
    metrics.fullBytes += bytes.byteLength;
    metrics.stagedBytes += staged.stagedBytes;
    metrics.stagedBytesByClass[classIndex] += staged.stagedBytes;
    metrics.avoidedStagedBytes += bytes.byteLength - staged.stagedBytes;
    metrics.overlayRanges += ranges.length;
    metrics.overlayBytes += staged.stagedBytes;
    if (copyForward) {
      metrics.copyForwardBytes += bytes.byteLength;
      metrics.predictedGpuCopyBytes += bytes.byteLength + staged.stagedBytes * 2;
      if (mode === "equal") {
        metrics.equalCalls += 1;
      } else {
        metrics.sparseCalls += 1;
        metrics.sparseCallsByClass[classIndex] += 1;
      }
    } else {
      metrics.predictedGpuCopyBytes += bytes.byteLength * 2;
      if (mode === "baseline") metrics.baselineCalls += 1;
      else metrics.fullFallbackCalls += 1;
    }
    return {
      handled: true,
      ok: true,
      reason: null,
      mode,
      classIndex,
      dirtyBytes,
      stagedBytes: staged.stagedBytes,
    };
  }

  function reset(reason = "reset") {
    let destroyed = 0;
    for (const state of states) {
      if (state.gpuShadow) {
        try {
          state.gpuShadow.destroy();
        } catch {
          // Best-effort cleanup after device loss or a failed submission.
        }
        destroyed += 1;
      }
      state.gpuShadow = null;
      state.valid = false;
      state.cpuShadow.fill(0);
    }
    metrics.invalidations += 1;
    const key = String(reason || "reset");
    metrics.invalidationReasons[key] = (metrics.invalidationReasons[key] ?? 0) + 1;
    return destroyed;
  }

  function snapshot({ requested = true, active = true } = {}) {
    return {
      schema: "wasm-dolphin.wgpu-sparse-ubo.v1",
      instanceId,
      requested: Boolean(requested),
      active: Boolean(active),
      coverageThreshold,
      maxSparseRanges,
      classOrder: WGPU_SPARSE_UBO_CLASS_SPECS.map((spec) => spec.name),
      classSizes: WGPU_SPARSE_UBO_CLASS_SPECS.map((spec) => spec.size),
      shadowValid: states.map((state) => state.valid),
      ...metrics,
      invalidationReasons: { ...metrics.invalidationReasons },
      callsByClass: [...metrics.callsByClass],
      sparseCallsByClass: [...metrics.sparseCallsByClass],
      stagedBytesByClass: [...metrics.stagedBytesByClass],
    };
  }

  return Object.freeze({ stage, reset, snapshot });
}

export function requestedWgpuSparseUbo(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpuubosparse") === "1";
}

function viewBytes(value) {
  if (!ArrayBuffer.isView(value)) return null;
  return value instanceof Uint8Array
    ? value
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
