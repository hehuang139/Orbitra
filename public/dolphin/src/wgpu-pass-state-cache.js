// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

const NO_RESOURCE = Symbol("no-wgpu-resource");
const NO_OFFSETS = Object.freeze([]);

export const WGPU_PRODUCER_PROFILE_SCHEMA =
  "wasm-dolphin.wgpu-producer-profile.v1";
export const WGPU_DRAW_PROFILE_SCHEMA = "wasm-dolphin.wgpu-draw-profile.v1";
export const WGPU_TAIL_GATE_SCHEMA = "wasm-dolphin.wgpu-tail-gate.v1";
// Phases are inclusive and may nest (for example, geometry_commit contains
// upload_copy). Compare each phase independently; never sum phase estimates.
export const WGPU_PRODUCER_PROFILE_PHASE_ORDER = Object.freeze([
  "ring_publish",
  "upload_copy",
  "geometry_commit",
  "draw_resources",
  "shader_translate_emit",
  "pipeline_serialize_emit",
  "bind_group_prepare",
  "xfb_show_image",
  "backbuffer_present",
  "fifo_decode",
  "fifo_tail_flush",
  "reserved",
]);
export const WGPU_DRAW_PROFILE_PHASE_ORDER = Object.freeze([
  "pipeline_uid_build",
  "pipeline_cache_lookup",
  "draw_resource_init",
  "uniform_prepare",
  "texture_sampler_resolve",
  "bind_resource_record",
  "command_stage",
]);
export const WGPU_DRAW_PROFILE_PERIODS = Object.freeze([64, 64, 256, 64, 64, 64, 256]);

export function parseWgpuProducerProfileStats(text = "") {
  const normalized = String(text || "");
  const header = /\bwgprod:(\d+),(\d+),(\d+),(\d+)(?=\s|$)/i.exec(normalized);
  const epoch = Number(header?.[3]);
  if (!header || Number(header[1]) !== 1 || !["0", "1"].includes(header[2]) ||
      !Number.isSafeInteger(epoch) ||
      Number(header[4]) !== WGPU_PRODUCER_PROFILE_PHASE_ORDER.length) {
    return null;
  }
  const periods = profileVector(normalized, "wgprd");
  const calls = profileVector(normalized, "wgprc");
  const samples = profileVector(normalized, "wgprs");
  const sampleTotalNs = profileVector(normalized, "wgprt");
  const sampleMaxNs = profileVector(normalized, "wgprm");
  if (![periods, calls, samples, sampleTotalNs, sampleMaxNs].every(Boolean)) {
    return null;
  }
  const estimatedTotalNs = sampleTotalNs.map((value, index) =>
    value * periods[index]
  );
  if (estimatedTotalNs.some((value) => !Number.isSafeInteger(value))) return null;
  return {
    schema: WGPU_PRODUCER_PROFILE_SCHEMA,
    version: 1,
    enabled: header[2] === "1",
    epoch,
    phaseCount: Number(header[4]),
    phaseOrder: [...WGPU_PRODUCER_PROFILE_PHASE_ORDER],
    periods,
    calls,
    samples,
    sampleTotalNs,
    sampleMaxNs,
    estimatedTotalNs,
  };
}

export function parseWgpuDrawProfileStats(text = "") {
  const normalized = String(text || "");
  const header = /\bwgdraw:(\d+),(\d+),(\d+),(\d+)(?=\s|$)/i.exec(normalized);
  const epoch = Number(header?.[3]);
  if (!header || Number(header[1]) !== 1 || !["0", "1"].includes(header[2]) ||
      !Number.isSafeInteger(epoch) ||
      Number(header[4]) !== WGPU_DRAW_PROFILE_PHASE_ORDER.length) {
    return null;
  }
  const count = WGPU_DRAW_PROFILE_PHASE_ORDER.length;
  const periods = profileVector(normalized, "wgdrd", count);
  const calls = profileVector(normalized, "wgdrc", count);
  const samples = profileVector(normalized, "wgdrs", count);
  const sampleTotalNs = profileVector(normalized, "wgdrt", count);
  const sampleMaxNs = profileVector(normalized, "wgdrm", count);
  if (![periods, calls, samples, sampleTotalNs, sampleMaxNs].every(Boolean)) return null;
  const estimatedTotalNs = sampleTotalNs.map((value, index) => value * periods[index]);
  if (estimatedTotalNs.some((value) => !Number.isSafeInteger(value))) return null;
  return {
    schema: WGPU_DRAW_PROFILE_SCHEMA,
    version: 1,
    enabled: header[2] === "1",
    epoch,
    phaseCount: Number(header[4]),
    phaseOrder: [...WGPU_DRAW_PROFILE_PHASE_ORDER],
    periods,
    calls,
    samples,
    sampleTotalNs,
    sampleMaxNs,
    estimatedTotalNs,
  };
}

export function parseWgpuTailGateStats(text = "") {
  const match = /\bwgtail:(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)(?=\s|$)/i
    .exec(String(text || ""));
  if (!match || Number(match[1]) !== 1 || !["0", "1"].includes(match[2])) return null;
  const values = match.slice(3).map(Number);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0) || values[1] < 1) {
    return null;
  }
  return {
    schema: WGPU_TAIL_GATE_SCHEMA,
    version: 1,
    enabled: match[2] === "1",
    epoch: values[0],
    period: values[1],
    payloadSamples: values[2],
    flushNeededSamples: values[3],
    refreshNeededSamples: values[4],
    bothCleanSamples: values[5],
    dirtyAtSkip: values[6],
  };
}

export function parseWgpuProducerStateStats(text = "") {
  const normalized = String(text || "");
  const match = /\bwgstate:(\d+)\s+pipe:(\d+)\s+bg:(\d+),(\d+),(\d+)\s+vb:(\d+)\s+ib:(\d+)\s+wgdrop:(\d+)(?:\s+wgbabort:(\d+)\s+wgboversize:(\d+)\s+wguploadto:(\d+))?/i
    .exec(normalized);
  if (!match) return null;
  const ubo = /\bwgubo:(\d+)(?:\s+wgubometrics:(\d+))?(?:\s+wgubopack:\d+)?\s+ulook:(\d+),(\d+),(\d+)\s+uhit:(\d+),(\d+),(\d+)\s+uexp:(\d+),(\d+),(\d+)\s+usupcall:(\d+),(\d+),(\d+)\s+usupbyte:(\d+),(\d+),(\d+)/i
    .exec(normalized);
  const uboPacket = /\bumask:(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\s+upack:(\d+),(\d+),(\d+),(\d+)\s+ucpucall:(\d+),(\d+),(\d+)\s+ucpuns:(\d+),(\d+),(\d+)/i
    .exec(normalized);
  const denseUbo = /\bwgubopack:(\d+)/i.exec(normalized);
  const uniformFast = /\bwguniformfast:(\d+)\s+ufskip:(\d+),(\d+),(\d+)\s+ufkeep:(\d+),(\d+),(\d+)\s+ufmiss:(\d+),(\d+),(\d+)/i
    .exec(normalized);
  const geometry = /\bwggeom:(\d+)\s+wggeomepoch:(\d+)/i.exec(normalized);
  const arena = /\bwgarena:(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/i.exec(normalized);
  const waits = /\bwgwait:(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/i.exec(normalized);
  const uboDiffHeader = /\bubodiff:(\d+),([01]),(\d+),(\d+)(?=\s|$)/i.exec(normalized);
  const uboDiffVectors = [
    statTriple(normalized, "uchgcall"),
    statTriple(normalized, "uchgfull"),
    statTriple(normalized, "uchgbyte"),
    statTriple(normalized, "ubaseline"),
    statTriple(normalized, "ubasebyte"),
    statTriple(normalized, "u16byte"),
    statTriple(normalized, "u16range"),
    statTriple(normalized, "u256byte"),
    statTriple(normalized, "u256range"),
  ];
  const uboDiffEpoch = Number(uboDiffHeader?.[3]);
  const uboChangeAvailable = uboDiffHeader?.[1] === "1" &&
    uboDiffHeader?.[4] === "3" && Number.isSafeInteger(uboDiffEpoch) &&
    uboDiffEpoch >= 0 && uboDiffVectors.every(Boolean);
  const uboChangeValues = uboChangeAvailable
    ? uboDiffVectors
    : uboDiffVectors.map(() => [0, 0, 0]);
  const [
    uboChangeUploadCalls,
    uboChangeFullBytes,
    uboChangedBytes,
    uboChangeBaselineFullCount,
    uboChangeBaselineFullBytes,
    uboDirty16Bytes,
    uboDirty16Ranges,
    uboDirty256Bytes,
    uboDirty256Ranges,
  ] = uboChangeValues;
  return {
    enabled: match[1] === "1",
    pipelineRecordsSuppressed: Number(match[2]),
    bindGroupRecordsSuppressed: [Number(match[3]), Number(match[4]), Number(match[5])],
    vertexBufferRecordsSuppressed: Number(match[6]),
    indexBufferRecordsSuppressed: Number(match[7]),
    commandDroppedCount: Number(match[8]),
    batchAbortCount: Number(match[9] || 0),
    batchOversizeCount: Number(match[10] || 0),
    uploadTimeoutCount: Number(match[11] || 0),
    uboCacheEnabled: ubo?.[1] === "1",
    uboCacheMetricsEnabled: ubo?.[2] === "1",
    uboPackEnabled: denseUbo?.[1] === "1",
    uniformFastEnabled: uniformFast?.[1] === "1",
    uniformFastClassOrder: ["vs", "ps", "gs"],
    uniformFastSkippedComparisons: numericTriple(uniformFast, 2),
    uniformFastKeptComparisons: numericTriple(uniformFast, 5),
    uniformFastChangedComparisons: numericTriple(uniformFast, 8),
    uboCacheClassOrder: ["vs", "ps", "gs"],
    uboCacheLookups: numericTriple(ubo, 3),
    uboCacheHits: numericTriple(ubo, 6),
    uboCacheExpired: numericTriple(ubo, 9),
    uboUploadCallsSuppressed: numericTriple(ubo, 12),
    uboUploadBytesSuppressed: numericTriple(ubo, 15),
    uboChangeMaskHistogram: numericValues(uboPacket, 1, 8),
    uboPacketEligibleCount: Number(uboPacket?.[9] || 0),
    uboPacketTheoreticalCallsRemoved: Number(uboPacket?.[10] || 0),
    uboPacketPayloadBytes: Number(uboPacket?.[11] || 0),
    uboPacketAlignedBytes: Number(uboPacket?.[12] || 0),
    uboPrepareCpuCalls: numericTriple(uboPacket, 13),
    uboPrepareCpuNs: numericTriple(uboPacket, 16),
    uboChangeClassOrder: ["vs", "ps", "gs"],
    uboChangeSchemaVersion: uboChangeAvailable ? 1 : 0,
    uboChangeAvailable,
    uboChangeEnabled: uboChangeAvailable && uboDiffHeader[2] === "1",
    uboChangeEpoch: uboChangeAvailable ? uboDiffEpoch : 0,
    uboChangeUploadCalls,
    uboChangeFullBytes,
    uboChangedBytes,
    uboChangeBaselineFullCount,
    uboChangeBaselineFullBytes,
    uboDirty16Bytes,
    uboDirty16Ranges,
    uboDirty256Bytes,
    uboDirty256Ranges,
    geometryPackEnabled: geometry?.[1] === "1",
    geometryPackEpoch: Number(geometry?.[2] || 0),
    uploadArenaRequestedBytes: Number(arena?.[1] || 0),
    uploadArenaConfiguredBytes: Number(arena?.[2] || 0),
    uploadArenaFallbackCount: Number(arena?.[3] || 0),
    uploadArenaLateRejectCount: Number(arena?.[4] || 0),
    uploadArenaWrapCount: Number(arena?.[5] || 0),
    uploadArenaInflightHighWaterBytes: Number(arena?.[6] || 0),
    ringWaitCount: Number(waits?.[1] || 0),
    ringWaitTotalUs: Number(waits?.[2] || 0),
    ringWaitMaxUs: Number(waits?.[3] || 0),
    uploadWaitCount: Number(waits?.[4] || 0),
    uploadWaitTotalUs: Number(waits?.[5] || 0),
    uploadWaitMaxUs: Number(waits?.[6] || 0)
  };
}

function numericTriple(match, start) {
  return [
    Number(match?.[start] || 0),
    Number(match?.[start + 1] || 0),
    Number(match?.[start + 2] || 0)
  ];
}

function numericValues(match, start, count) {
  return Array.from({ length: count }, (_, index) =>
    Number(match?.[start + index] || 0)
  );
}

function statTriple(text, label) {
  const match = new RegExp(`\\b${label}:(\\d+),(\\d+),(\\d+)(?=\\s|$)`, "i")
    .exec(text);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  return values.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? values
    : null;
}

function profileVector(text, label, count = WGPU_PRODUCER_PROFILE_PHASE_ORDER.length) {
  const match = new RegExp(`\\b${label}:([0-9]+(?:,[0-9]+){${count - 1}})(?=\\s|$)`, "i")
    .exec(text);
  if (!match) return null;
  const values = match[1].split(",").map(Number);
  return values.length === count &&
    values.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? values
    : null;
}

export function createWgpuPassStateCache() {
  let pipeline = NO_RESOURCE;
  const bindGroups = new Map();
  const vertexBuffers = new Map();
  let indexBuffer = null;

  const pipelineCounters = createCounters();
  const bindGroupCounters = new Map();
  const vertexBufferCounters = new Map();
  const indexBufferCounters = createCounters();
  const lifecycleCounters = {
    resetCount: 0,
    resetEntries: 0,
    resetReasons: {},
    destroyCount: 0,
    destroyEntries: 0,
    destroyKinds: {}
  };

  // Comparison and commit are deliberately separate. Callers commit only
  // after the synchronous WebGPU state call succeeds, so a missing resource
  // or thrown validation error remains retryable.
  function pipelineNeedsApply(resource) {
    return compare(pipelineCounters,
      pipeline !== NO_RESOURCE && Object.is(pipeline, resource));
  }

  function recordPipelineApplied(resource) {
    if (!hasResource(resource)) return recordFailure(pipelineCounters);
    pipeline = resource;
    pipelineCounters.applied += 1;
    return true;
  }

  function recordPipelineApplyFailed() {
    pipelineCounters.failures += 1;
  }

  function isPipelineReady(resource = NO_RESOURCE) {
    if (pipeline === NO_RESOURCE) return false;
    return resource === NO_RESOURCE || Object.is(pipeline, resource);
  }

  function bindGroupNeedsApply(slot, resource, dynamicOffsets = NO_OFFSETS,
                               dynamicOffsetCount = dynamicOffsets?.length ?? 0) {
    const normalizedSlot = slot >>> 0;
    const counters = slotCounters(bindGroupCounters, normalizedSlot);
    const cached = bindGroups.get(normalizedSlot);
    const count = checkedOffsetCount(dynamicOffsets, dynamicOffsetCount);
    return compare(counters, cached !== undefined &&
      Object.is(cached.resource, resource) &&
      offsetsEqual(cached.dynamicOffsets, dynamicOffsets, count));
  }

  function recordBindGroupApplied(slot, resource, dynamicOffsets = NO_OFFSETS,
                                  dynamicOffsetCount = dynamicOffsets?.length ?? 0) {
    const normalizedSlot = slot >>> 0;
    const counters = slotCounters(bindGroupCounters, normalizedSlot);
    if (!hasResource(resource)) return recordFailure(counters);
    const count = checkedOffsetCount(dynamicOffsets, dynamicOffsetCount);
    let state = bindGroups.get(normalizedSlot);
    if (!state) {
      state = { resource, dynamicOffsets: new Uint32Array(count) };
      bindGroups.set(normalizedSlot, state);
    } else {
      state.resource = resource;
      if (state.dynamicOffsets.length !== count) {
        state.dynamicOffsets = new Uint32Array(count);
      }
    }
    copyOffsetsInto(state.dynamicOffsets, dynamicOffsets, count);
    counters.applied += 1;
    return true;
  }

  function recordBindGroupApplyFailed(slot) {
    slotCounters(bindGroupCounters, slot >>> 0).failures += 1;
  }

  function vertexBufferNeedsApply(slot, resource, offset = 0) {
    const normalizedSlot = slot >>> 0;
    const counters = slotCounters(vertexBufferCounters, normalizedSlot);
    const cached = vertexBuffers.get(normalizedSlot);
    return compare(counters, cached !== undefined &&
      Object.is(cached.resource, resource) && cached.offset === (offset >>> 0));
  }

  function recordVertexBufferApplied(slot, resource, offset = 0) {
    const normalizedSlot = slot >>> 0;
    const counters = slotCounters(vertexBufferCounters, normalizedSlot);
    if (!hasResource(resource)) return recordFailure(counters);
    const state = vertexBuffers.get(normalizedSlot);
    if (state) {
      state.resource = resource;
      state.offset = offset >>> 0;
    } else {
      vertexBuffers.set(normalizedSlot, { resource, offset: offset >>> 0 });
    }
    counters.applied += 1;
    return true;
  }

  function recordVertexBufferApplyFailed(slot) {
    slotCounters(vertexBufferCounters, slot >>> 0).failures += 1;
  }

  function indexBufferNeedsApply(resource, format, offset = 0) {
    return compare(indexBufferCounters, indexBuffer !== null &&
      Object.is(indexBuffer.resource, resource) &&
      indexBuffer.format === format && indexBuffer.offset === (offset >>> 0));
  }

  function recordIndexBufferApplied(resource, format, offset = 0) {
    if (!hasResource(resource)) return recordFailure(indexBufferCounters);
    if (indexBuffer) {
      indexBuffer.resource = resource;
      indexBuffer.format = format;
      indexBuffer.offset = offset >>> 0;
    } else {
      indexBuffer = { resource, format, offset: offset >>> 0 };
    }
    indexBufferCounters.applied += 1;
    return true;
  }

  function recordIndexBufferApplyFailed() {
    indexBufferCounters.failures += 1;
  }

  function reset(reason = "pass") {
    const cleared = liveEntryCount();
    pipeline = NO_RESOURCE;
    bindGroups.clear();
    vertexBuffers.clear();
    indexBuffer = null;
    lifecycleCounters.resetCount += 1;
    lifecycleCounters.resetEntries += cleared;
    const key = String(reason || "unspecified");
    lifecycleCounters.resetReasons[key] =
      (lifecycleCounters.resetReasons[key] || 0) + 1;
    return cleared;
  }

  function invalidateDestroyedResource(kind, resource) {
    const normalizedKind = normalizeDestroyKind(kind);
    let invalidated = 0;
    if (normalizedKind === "bind-group") {
      invalidated += invalidateSlots(bindGroups, bindGroupCounters, resource);
    } else if (normalizedKind === "buffer") {
      invalidated += invalidateSlots(vertexBuffers, vertexBufferCounters, resource);
      if (indexBuffer !== null && Object.is(indexBuffer.resource, resource)) {
        indexBuffer = null;
        indexBufferCounters.invalidated += 1;
        invalidated += 1;
      }
    } else if (normalizedKind === "pipeline") {
      if (pipeline !== NO_RESOURCE && Object.is(pipeline, resource)) {
        pipeline = NO_RESOURCE;
        pipelineCounters.invalidated += 1;
        invalidated += 1;
      }
    }
    lifecycleCounters.destroyCount += 1;
    lifecycleCounters.destroyEntries += invalidated;
    lifecycleCounters.destroyKinds[normalizedKind] =
      (lifecycleCounters.destroyKinds[normalizedKind] || 0) + 1;
    return invalidated;
  }

  function snapshot() {
    return {
      schema: "wasm-dolphin.wgpu-pass-state-cache.v1",
      current: {
        pipelineReady: pipeline !== NO_RESOURCE,
        bindGroupSlots: sortedSlots(bindGroups),
        vertexBufferSlots: sortedSlots(vertexBuffers),
        indexBufferReady: indexBuffer !== null,
        liveEntries: liveEntryCount()
      },
      counters: {
        pipeline: copyCounters(pipelineCounters),
        bindGroups: snapshotSlotCounters(bindGroupCounters),
        vertexBuffers: snapshotSlotCounters(vertexBufferCounters),
        indexBuffer: copyCounters(indexBufferCounters),
        lifecycle: {
          ...lifecycleCounters,
          resetReasons: { ...lifecycleCounters.resetReasons },
          destroyKinds: { ...lifecycleCounters.destroyKinds }
        }
      }
    };
  }

  function liveEntryCount() {
    return (pipeline === NO_RESOURCE ? 0 : 1) + bindGroups.size +
      vertexBuffers.size + (indexBuffer === null ? 0 : 1);
  }

  return {
    pipelineNeedsApply,
    recordPipelineApplied,
    recordPipelineApplyFailed,
    isPipelineReady,
    bindGroupNeedsApply,
    recordBindGroupApplied,
    recordBindGroupApplyFailed,
    vertexBufferNeedsApply,
    recordVertexBufferApplied,
    recordVertexBufferApplyFailed,
    indexBufferNeedsApply,
    recordIndexBufferApplied,
    recordIndexBufferApplyFailed,
    reset,
    invalidateDestroyedResource,
    snapshot
  };
}

function createCounters() {
  return {
    comparisons: 0,
    applyRequired: 0,
    redundant: 0,
    applied: 0,
    failures: 0,
    invalidated: 0
  };
}

function compare(counters, redundant) {
  counters.comparisons += 1;
  if (redundant) {
    counters.redundant += 1;
    return false;
  }
  counters.applyRequired += 1;
  return true;
}

function recordFailure(counters) {
  counters.failures += 1;
  return false;
}

function hasResource(resource) {
  return resource !== null && resource !== undefined;
}

function slotCounters(countersBySlot, slot) {
  let counters = countersBySlot.get(slot);
  if (!counters) {
    counters = createCounters();
    countersBySlot.set(slot, counters);
  }
  return counters;
}

function checkedOffsetCount(offsets, count) {
  const length = offsets?.length ?? 0;
  const normalized = Number(count);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > length) {
    throw new RangeError("dynamic offset count exceeds the supplied offsets");
  }
  return normalized;
}

function offsetsEqual(cached, candidate, count) {
  if (cached.length !== count) return false;
  for (let index = 0; index < count; index += 1) {
    if (cached[index] !== (candidate[index] >>> 0)) return false;
  }
  return true;
}

function copyOffsetsInto(copy, offsets, count) {
  for (let index = 0; index < count; index += 1) {
    copy[index] = offsets[index] >>> 0;
  }
}

function invalidateSlots(states, countersBySlot, resource) {
  let invalidated = 0;
  for (const [slot, state] of states) {
    if (!Object.is(state.resource, resource)) continue;
    states.delete(slot);
    slotCounters(countersBySlot, slot).invalidated += 1;
    invalidated += 1;
  }
  return invalidated;
}

function normalizeDestroyKind(kind) {
  if (kind === 1 || kind === "buffer") return "buffer";
  if (kind === 3 || kind === "bind-group" || kind === "bindGroup") {
    return "bind-group";
  }
  if (kind === "pipeline") return "pipeline";
  return String(kind || "unknown");
}

function sortedSlots(states) {
  return [...states.keys()].sort((left, right) => left - right);
}

function snapshotSlotCounters(countersBySlot) {
  const slots = {};
  const total = createCounters();
  for (const [slot, counters] of [...countersBySlot.entries()]
    .sort(([left], [right]) => left - right)) {
    slots[slot] = copyCounters(counters);
    for (const key of Object.keys(total)) total[key] += counters[key];
  }
  return { total, slots };
}

function copyCounters(counters) {
  return { ...counters };
}
