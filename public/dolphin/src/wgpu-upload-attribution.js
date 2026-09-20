// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_UPLOAD_ROLE_NAMES = Object.freeze([
  "unknown",
  "ubo",
  "utility-uniform",
  "vertex",
  "index",
  "texture-adjacent",
  "geometry",
]);

export const WGPU_UPLOAD_ROLE = Object.freeze({
  UNKNOWN: 0,
  UBO: 1,
  UTILITY_UNIFORM: 2,
  VERTEX: 3,
  INDEX: 4,
  TEXTURE_ADJACENT: 5,
  GEOMETRY: 6,
});

export const WGPU_UPLOAD_SIZE_BUCKET_LABELS = Object.freeze([
  "<=64",
  "<=256",
  "<=1024",
  "<=4096",
  "<=16384",
  "<=65536",
  ">65536",
]);

const SIZE_BUCKET_UPPER_BOUNDS = Object.freeze([
  64,
  256,
  1024,
  4096,
  16384,
  65536,
  null,
]);

const ROLE_COUNT = WGPU_UPLOAD_ROLE_NAMES.length;
const BUCKET_COUNT = WGPU_UPLOAD_SIZE_BUCKET_LABELS.length;
const SLOW_QUEUE_WRITE_THRESHOLD_MS = 20;
const SLOW_QUEUE_WRITE_EVENT_LIMIT = 32;

// Uploads are commonly published before BEGIN_PASS. A window therefore starts
// immediately after the previous END/abort/incomplete boundary. Pre-BEGIN
// uploads remain in that window and are finalized by the following END_PASS.
export function createWgpuUploadAttribution({
  mappedStageTimingStride = 1,
  now = () => performance.now(),
} = {}) {
  const timingStride = Number(mappedStageTimingStride) === 64 ? 64 : 1;
  const callsByRole = new Float64Array(ROLE_COUNT);
  const bytesByRole = new Float64Array(ROLE_COUNT);
  const maxBytesByRole = new Float64Array(ROLE_COUNT);
  const bucketCallsByRole = new Float64Array(ROLE_COUNT * BUCKET_COUNT);
  const bucketBytesByRole = new Float64Array(ROLE_COUNT * BUCKET_COUNT);

  const windowMinDestinationByRole = new Float64Array(ROLE_COUNT);
  const windowMaxDestinationEndByRole = new Float64Array(ROLE_COUNT);
  const maxDestinationSpanBytesByRole = new Float64Array(ROLE_COUNT);
  const queueWriteCallsByRole = new Float64Array(ROLE_COUNT);
  const queueWriteTotalMsByRole = new Float64Array(ROLE_COUNT);
  const queueWriteMaxMsByRole = new Float64Array(ROLE_COUNT);
  const capacityWaitAttemptsByRole = new Float64Array(ROLE_COUNT);
  const capacityWaitEpisodesByRole = new Float64Array(ROLE_COUNT);
  const capacityWaitCompletedByRole = new Float64Array(ROLE_COUNT);
  const capacityWaitTotalMsByRole = new Float64Array(ROLE_COUNT);
  const capacityWaitMaxMsByRole = new Float64Array(ROLE_COUNT);
  const mappedTimingEligibleByRole = new Float64Array(ROLE_COUNT);
  const mappedTimingSamplesByRole = new Float64Array(ROLE_COUNT);
  const mappedTimingSampleBytesByRole = new Float64Array(ROLE_COUNT);
  const mappedTimingSampleTotalMsByRole = new Float64Array(ROLE_COUNT);
  const mappedTimingSampleMaxMsByRole = new Float64Array(ROLE_COUNT);

  let totalCalls = 0;
  let totalBytes = 0;
  let maxBytes = 0;
  let passOpen = false;
  let windowCalls = 0;
  let windowBytes = 0;
  let completedPassCount = 0;
  let abortedPassCount = 0;
  let incompletePassCount = 0;
  let maxPassCalls = 0;
  let maxPassBytes = 0;
  let maxDestinationSpanBytes = 0;
  let queueWriteTotalCalls = 0;
  let queueWriteTotalMs = 0;
  let queueWriteMaxMs = 0;
  let capacityWaitTotalAttempts = 0;
  let capacityWaitTotalEpisodes = 0;
  let capacityWaitCompletedEpisodes = 0;
  let capacityWaitTotalMs = 0;
  let capacityWaitMaxMs = 0;
  let capacityWaitActiveRole = WGPU_UPLOAD_ROLE.UNKNOWN;
  let capacityWaitActive = false;
  let slowQueueWriteObservedCount = 0;
  let queueWriteSequence = 0;
  let mappedTimingEligibleCalls = 0;
  let mappedTimingSampleCount = 0;
  let mappedTimingSampleBytes = 0;
  let mappedTimingSampleTotalMs = 0;
  let mappedTimingSampleMaxMs = 0;
  const slowQueueWriteEvents = [];

  resetWindow();

  function recordUpload(role, bytes, destinationOffset = 0) {
    const roleIndex = validRole(role) ? role : WGPU_UPLOAD_ROLE.UNKNOWN;
    const byteCount = finiteNonnegative(bytes);
    const offset = finiteNonnegative(destinationOffset);
    const bucketIndex = sizeBucket(byteCount);
    const bucketSlot = roleIndex * BUCKET_COUNT + bucketIndex;

    totalCalls += 1;
    totalBytes += byteCount;
    maxBytes = Math.max(maxBytes, byteCount);
    callsByRole[roleIndex] += 1;
    bytesByRole[roleIndex] += byteCount;
    maxBytesByRole[roleIndex] = Math.max(maxBytesByRole[roleIndex], byteCount);
    bucketCallsByRole[bucketSlot] += 1;
    bucketBytesByRole[bucketSlot] += byteCount;

    windowCalls += 1;
    windowBytes += byteCount;
    windowMinDestinationByRole[roleIndex] = Math.min(
      windowMinDestinationByRole[roleIndex],
      offset
    );
    windowMaxDestinationEndByRole[roleIndex] = Math.max(
      windowMaxDestinationEndByRole[roleIndex],
      offset + byteCount
    );
    return roleIndex;
  }

  function recordQueueWrite(role, bytes, durationMs, context = {}) {
    const roleIndex = validRole(role) ? role : WGPU_UPLOAD_ROLE.UNKNOWN;
    const byteCount = finiteNonnegative(bytes);
    const elapsedMs = finiteNonnegative(durationMs);
    queueWriteTotalCalls += 1;
    queueWriteTotalMs += elapsedMs;
    queueWriteMaxMs = Math.max(queueWriteMaxMs, elapsedMs);
    queueWriteCallsByRole[roleIndex] += 1;
    queueWriteTotalMsByRole[roleIndex] += elapsedMs;
    queueWriteMaxMsByRole[roleIndex] = Math.max(
      queueWriteMaxMsByRole[roleIndex], elapsedMs
    );
    queueWriteSequence += 1;

    if (elapsedMs > SLOW_QUEUE_WRITE_THRESHOLD_MS) {
      slowQueueWriteObservedCount += 1;
      retainSlowQueueWriteEvent({
        sequence: queueWriteSequence,
        role: roleIndex,
        roleName: WGPU_UPLOAD_ROLE_NAMES[roleIndex],
        bytes: byteCount,
        durationMs: elapsedMs,
        backlogRecords: finiteNonnegative(context.backlogRecords),
        submissionCount: finiteNonnegative(context.submissionCount),
        passDepth: finiteNonnegative(context.passDepth),
        staged: Boolean(context.staged),
      });
    }
    return roleIndex;
  }

  function beginMappedStageTiming(role) {
    const roleIndex = validRole(role) ? role : WGPU_UPLOAD_ROLE.UNKNOWN;
    mappedTimingEligibleCalls += 1;
    mappedTimingEligibleByRole[roleIndex] += 1;
    const roleSequence = mappedTimingEligibleByRole[roleIndex];
    return (roleSequence - 1) % timingStride === 0 ? now() : null;
  }

  function finishMappedStageTiming(role, startedAt, bytes = 0) {
    if (startedAt === null) return null;
    const roleIndex = validRole(role) ? role : WGPU_UPLOAD_ROLE.UNKNOWN;
    const elapsedMs = finiteNonnegative(now() - startedAt);
    const byteCount = finiteNonnegative(bytes);
    mappedTimingSampleCount += 1;
    mappedTimingSampleBytes += byteCount;
    mappedTimingSampleTotalMs += elapsedMs;
    mappedTimingSampleMaxMs = Math.max(mappedTimingSampleMaxMs, elapsedMs);
    mappedTimingSamplesByRole[roleIndex] += 1;
    mappedTimingSampleBytesByRole[roleIndex] += byteCount;
    mappedTimingSampleTotalMsByRole[roleIndex] += elapsedMs;
    mappedTimingSampleMaxMsByRole[roleIndex] = Math.max(
      mappedTimingSampleMaxMsByRole[roleIndex], elapsedMs
    );
    return elapsedMs;
  }

  function recordCapacityWaitAttempt(role) {
    const roleIndex = validRole(role) ? role : WGPU_UPLOAD_ROLE.UNKNOWN;
    capacityWaitTotalAttempts += 1;
    capacityWaitAttemptsByRole[roleIndex] += 1;
    return roleIndex;
  }

  function beginCapacityWait(role) {
    const roleIndex = validRole(role) ? role : WGPU_UPLOAD_ROLE.UNKNOWN;
    if (capacityWaitActive) return capacityWaitActiveRole;
    capacityWaitActive = true;
    capacityWaitActiveRole = roleIndex;
    capacityWaitTotalEpisodes += 1;
    capacityWaitEpisodesByRole[roleIndex] += 1;
    return roleIndex;
  }

  function recordCapacityWaitDuration(role, durationMs) {
    const roleIndex = validRole(role) ? role : WGPU_UPLOAD_ROLE.UNKNOWN;
    const elapsedMs = finiteNonnegative(durationMs);
    capacityWaitTotalMs += elapsedMs;
    capacityWaitMaxMs = Math.max(capacityWaitMaxMs, elapsedMs);
    capacityWaitTotalMsByRole[roleIndex] += elapsedMs;
    capacityWaitMaxMsByRole[roleIndex] = Math.max(
      capacityWaitMaxMsByRole[roleIndex], elapsedMs
    );
    if (capacityWaitActive) {
      capacityWaitCompletedEpisodes += 1;
      capacityWaitCompletedByRole[capacityWaitActiveRole] += 1;
      capacityWaitActive = false;
      capacityWaitActiveRole = WGPU_UPLOAD_ROLE.UNKNOWN;
    }
    return roleIndex;
  }

  function cancelCapacityWait() {
    const wasActive = capacityWaitActive;
    capacityWaitActive = false;
    capacityWaitActiveRole = WGPU_UPLOAD_ROLE.UNKNOWN;
    return wasActive;
  }

  function recordPassBegin() {
    if (passOpen) {
      incompletePassCount += 1;
      resetWindow();
    }
    passOpen = true;
  }

  function recordPassEnd() {
    if (!passOpen) {
      incompletePassCount += 1;
      resetWindow();
      return false;
    }
    completedPassCount += 1;
    maxPassCalls = Math.max(maxPassCalls, windowCalls);
    maxPassBytes = Math.max(maxPassBytes, windowBytes);
    for (let role = 0; role < ROLE_COUNT; role += 1) {
      const minimum = windowMinDestinationByRole[role];
      if (minimum === Number.POSITIVE_INFINITY) continue;
      const span = Math.max(0, windowMaxDestinationEndByRole[role] - minimum);
      maxDestinationSpanBytesByRole[role] = Math.max(
        maxDestinationSpanBytesByRole[role],
        span
      );
      maxDestinationSpanBytes = Math.max(maxDestinationSpanBytes, span);
    }
    resetWindow();
    return true;
  }

  function recordPassAbort() {
    if (!passOpen && windowCalls === 0) return false;
    abortedPassCount += 1;
    resetWindow();
    return true;
  }

  function recordIncompletePass() {
    if (!passOpen && windowCalls === 0) return false;
    incompletePassCount += 1;
    resetWindow();
    return true;
  }

  function reset() {
    callsByRole.fill(0);
    bytesByRole.fill(0);
    maxBytesByRole.fill(0);
    bucketCallsByRole.fill(0);
    bucketBytesByRole.fill(0);
    maxDestinationSpanBytesByRole.fill(0);
    queueWriteCallsByRole.fill(0);
    queueWriteTotalMsByRole.fill(0);
    queueWriteMaxMsByRole.fill(0);
    capacityWaitAttemptsByRole.fill(0);
    capacityWaitEpisodesByRole.fill(0);
    capacityWaitCompletedByRole.fill(0);
    capacityWaitTotalMsByRole.fill(0);
    capacityWaitMaxMsByRole.fill(0);
    mappedTimingEligibleByRole.fill(0);
    mappedTimingSamplesByRole.fill(0);
    mappedTimingSampleBytesByRole.fill(0);
    mappedTimingSampleTotalMsByRole.fill(0);
    mappedTimingSampleMaxMsByRole.fill(0);
    totalCalls = 0;
    totalBytes = 0;
    maxBytes = 0;
    completedPassCount = 0;
    abortedPassCount = 0;
    incompletePassCount = 0;
    maxPassCalls = 0;
    maxPassBytes = 0;
    maxDestinationSpanBytes = 0;
    queueWriteTotalCalls = 0;
    queueWriteTotalMs = 0;
    queueWriteMaxMs = 0;
    capacityWaitTotalAttempts = 0;
    capacityWaitTotalEpisodes = 0;
    capacityWaitCompletedEpisodes = 0;
    capacityWaitTotalMs = 0;
    capacityWaitMaxMs = 0;
    capacityWaitActiveRole = WGPU_UPLOAD_ROLE.UNKNOWN;
    capacityWaitActive = false;
    slowQueueWriteObservedCount = 0;
    queueWriteSequence = 0;
    mappedTimingEligibleCalls = 0;
    mappedTimingSampleCount = 0;
    mappedTimingSampleBytes = 0;
    mappedTimingSampleTotalMs = 0;
    mappedTimingSampleMaxMs = 0;
    slowQueueWriteEvents.length = 0;
    resetWindow();
  }

  function snapshot({ enabled = true } = {}) {
    return {
      schema: "wasm-dolphin.wgpu-upload-attribution.v2",
      enabled: Boolean(enabled),
      roleOrder: [...WGPU_UPLOAD_ROLE_NAMES],
      sizeBucketLabels: [...WGPU_UPLOAD_SIZE_BUCKET_LABELS],
      sizeBucketUpperBounds: [...SIZE_BUCKET_UPPER_BOUNDS],
      totalCalls,
      totalBytes,
      maxBytes,
      callsByRole: Array.from(callsByRole),
      bytesByRole: Array.from(bytesByRole),
      maxBytesByRole: Array.from(maxBytesByRole),
      bucketCallsByRole: snapshotBuckets(bucketCallsByRole),
      bucketBytesByRole: snapshotBuckets(bucketBytesByRole),
      queueWrite: {
        thresholdMs: SLOW_QUEUE_WRITE_THRESHOLD_MS,
        slowEventLimit: SLOW_QUEUE_WRITE_EVENT_LIMIT,
        totalCalls: queueWriteTotalCalls,
        totalMs: queueWriteTotalMs,
        maxMs: queueWriteMaxMs,
        callsByRole: Array.from(queueWriteCallsByRole),
        totalMsByRole: Array.from(queueWriteTotalMsByRole),
        maxMsByRole: Array.from(queueWriteMaxMsByRole),
        slowEventObservedCount: slowQueueWriteObservedCount,
        slowEvents: slowQueueWriteEvents
          .map((event) => ({ ...event }))
          .sort((left, right) => right.durationMs - left.durationMs),
      },
      mappedStageTiming: mappedStageTimingSnapshot(),
      capacityWait: {
        schema: "wasm-dolphin.wgpu-capacity-wait-attribution.v1",
        totalAttempts: capacityWaitTotalAttempts,
        totalEpisodes: capacityWaitTotalEpisodes,
        completedEpisodes: capacityWaitCompletedEpisodes,
        totalMs: capacityWaitTotalMs,
        maxMs: capacityWaitMaxMs,
        active: capacityWaitActive,
        activeRole: capacityWaitActiveRole,
        attemptsByRole: Array.from(capacityWaitAttemptsByRole),
        episodesByRole: Array.from(capacityWaitEpisodesByRole),
        completedByRole: Array.from(capacityWaitCompletedByRole),
        totalMsByRole: Array.from(capacityWaitTotalMsByRole),
        maxMsByRole: Array.from(capacityWaitMaxMsByRole),
      },
      passAssociation: {
        definition: "uploads-after-previous-boundary-through-following-end-pass",
        preBeginUploadsFoldIntoFollowingPass: true,
        completedPassCount,
        abortedPassCount,
        incompletePassCount,
        currentPassOpen: passOpen,
        currentWindowCalls: windowCalls,
        currentWindowBytes: windowBytes,
        maxCalls: maxPassCalls,
        maxBytes: maxPassBytes,
        maxDestinationSpanBytes,
        maxDestinationSpanBytesByRole: Array.from(maxDestinationSpanBytesByRole),
      },
    };
  }

  function mappedStageTimingSnapshot() {
    return {
      schema: "wasm-dolphin.wgpu-mapped-stage-timing.v1",
      mode: timingStride === 1 ? "exact" : "per-role-periodic-sample",
      stride: timingStride,
      eligibleCalls: mappedTimingEligibleCalls,
      sampleCount: mappedTimingSampleCount,
      sampleBytes: mappedTimingSampleBytes,
      sampleTotalMs: mappedTimingSampleTotalMs,
      sampleMaxMs: mappedTimingSampleMaxMs,
      eligibleCallsByRole: Array.from(mappedTimingEligibleByRole),
      sampleCountsByRole: Array.from(mappedTimingSamplesByRole),
      sampleBytesByRole: Array.from(mappedTimingSampleBytesByRole),
      sampleTotalMsByRole: Array.from(mappedTimingSampleTotalMsByRole),
      sampleMaxMsByRole: Array.from(mappedTimingSampleMaxMsByRole),
    };
  }

  function resetWindow() {
    passOpen = false;
    windowCalls = 0;
    windowBytes = 0;
    windowMinDestinationByRole.fill(Number.POSITIVE_INFINITY);
    windowMaxDestinationEndByRole.fill(0);
  }

  function retainSlowQueueWriteEvent(event) {
    if (slowQueueWriteEvents.length < SLOW_QUEUE_WRITE_EVENT_LIMIT) {
      slowQueueWriteEvents.push(event);
      return;
    }
    let shortestIndex = 0;
    for (let index = 1; index < slowQueueWriteEvents.length; index += 1) {
      if (slowQueueWriteEvents[index].durationMs <
          slowQueueWriteEvents[shortestIndex].durationMs) {
        shortestIndex = index;
      }
    }
    if (event.durationMs > slowQueueWriteEvents[shortestIndex].durationMs) {
      slowQueueWriteEvents[shortestIndex] = event;
    }
  }

  return {
    recordUpload,
    recordQueueWrite,
    beginMappedStageTiming,
    finishMappedStageTiming,
    recordCapacityWaitAttempt,
    beginCapacityWait,
    recordCapacityWaitDuration,
    cancelCapacityWait,
    recordPassBegin,
    recordPassEnd,
    recordPassAbort,
    recordIncompletePass,
    reset,
    snapshot,
  };
}

function validRole(role) {
  return Number.isInteger(role) && role >= 0 && role < ROLE_COUNT;
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sizeBucket(bytes) {
  if (bytes <= 64) return 0;
  if (bytes <= 256) return 1;
  if (bytes <= 1024) return 2;
  if (bytes <= 4096) return 3;
  if (bytes <= 16384) return 4;
  if (bytes <= 65536) return 5;
  return 6;
}

function snapshotBuckets(values) {
  const result = new Array(ROLE_COUNT);
  for (let role = 0; role < ROLE_COUNT; role += 1) {
    const start = role * BUCKET_COUNT;
    result[role] = Array.from(values.subarray(start, start + BUCKET_COUNT));
  }
  return result;
}
