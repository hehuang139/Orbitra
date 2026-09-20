// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_MAPPED_DRAIN_MAX_AGE_MS = 4;
export const WGPU_MAPPED_DRAIN_MAX_BYTES = 1024 * 1024;
export const WGPU_MAPPED_DRAIN_MAX_RECORDS = 640;

export const WGPU_MAPPED_DRAIN_FORCE_REASONS = Object.freeze({
  CAPACITY: "capacity",
  PASS: "pass",
  RENDER: "render",
  PRESENT: "present",
  BLIT: "blit",
  READBACK: "readback",
  DESTROY: "destroy",
  RESET: "reset",
  LOAD: "load",
  DEVICE_LOSS: "device-loss",
  FATAL: "fatal",
  FINALIZATION: "finalization",
});

const FORCE_REASON_VALUES = new Set(Object.values(WGPU_MAPPED_DRAIN_FORCE_REASONS));

function requirePositiveLimit(value, name) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return normalized;
}

function normalizeGeneration(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RangeError("generation must be a non-negative safe integer");
  }
  return normalized;
}

function normalizePendingMetric(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function makeTelemetry() {
  return {
    boundaryCalls: 0,
    deferredBoundaries: 0,
    flushDecisions: 0,
    noneDecisions: 0,
    timerArmed: 0,
    timerFired: 0,
    timerStale: 0,
    timerCancelled: 0,
    actualSubmissions: 0,
    actualSubmissionAgeMaxMs: 0,
    actualDeadlineOverrunMaxMs: 0,
    deadlineOverrunTotalMs: 0,
    deadlineOverrunMaxMs: 0,
    resets: 0,
    generationMismatches: 0,
    maxPendingBytes: 0,
    maxPendingRecords: 0,
    maxPendingAgeMs: 0,
    flushReasons: Object.create(null),
    resetReasons: Object.create(null),
  };
}

function incrementReason(counts, reason) {
  counts[reason] = (counts[reason] || 0) + 1;
}

/**
 * Pure policy state for bounded mapped-upload drain coalescing.
 *
 * The caller owns timers and GPU submission. Results describe whether to keep
 * the current mapped batch, flush it, or do nothing. Timer tokens are fenced
 * by both a monotonically increasing sequence and the renderer generation.
 */
export function createWgpuMappedDrainCoalescer({
  enabled = false,
  generation = 0,
  maxAgeMs = WGPU_MAPPED_DRAIN_MAX_AGE_MS,
  maxBytes = WGPU_MAPPED_DRAIN_MAX_BYTES,
  maxRecords = WGPU_MAPPED_DRAIN_MAX_RECORDS,
} = {}) {
  const config = Object.freeze({
    enabled: Boolean(enabled),
    maxAgeMs: requirePositiveLimit(maxAgeMs, "maxAgeMs"),
    maxBytes: requirePositiveLimit(maxBytes, "maxBytes"),
    maxRecords: requirePositiveLimit(maxRecords, "maxRecords"),
  });

  let currentGeneration = normalizeGeneration(generation);
  let deferred = false;
  let timerSequence = 0;
  let activeTimerToken = null;
  let telemetry = makeTelemetry();

  const result = (action, reason, extra = {}) => ({
    action,
    reason,
    generation: currentGeneration,
    ...extra,
  });

  const cancelActiveTimer = () => {
    const cancelledTimerToken = activeTimerToken;
    if (cancelledTimerToken) telemetry.timerCancelled += 1;
    activeTimerToken = null;
    deferred = false;
    return cancelledTimerToken;
  };

  const decideFlush = (reason) => {
    const cancelledTimerToken = cancelActiveTimer();
    telemetry.flushDecisions += 1;
    incrementReason(telemetry.flushReasons, reason);
    return result("flush", reason, { cancelledTimerToken });
  };

  const decideNone = (reason) => {
    telemetry.noneDecisions += 1;
    return result("none", reason);
  };

  const recordPending = (pendingBytes, pendingRecords, pendingAgeMs) => {
    telemetry.maxPendingBytes = Math.max(telemetry.maxPendingBytes, pendingBytes);
    telemetry.maxPendingRecords = Math.max(telemetry.maxPendingRecords, pendingRecords);
    telemetry.maxPendingAgeMs = Math.max(telemetry.maxPendingAgeMs, pendingAgeMs);
  };

  const recordDeadlineOverrun = (pendingAgeMs) => {
    const overrunMs = Math.max(0, pendingAgeMs - config.maxAgeMs);
    if (overrunMs === 0) return;
    telemetry.deadlineOverrunTotalMs += overrunMs;
    telemetry.deadlineOverrunMaxMs = Math.max(
      telemetry.deadlineOverrunMaxMs,
      overrunMs
    );
  };

  function atBoundary({
    pending = false,
    pendingBytes = 0,
    pendingRecords = 0,
    pendingAgeMs = 0,
    generation: observedGeneration = currentGeneration,
    hasOpenPass = false,
    hasRenderEncoder = false,
  } = {}) {
    telemetry.boundaryCalls += 1;

    if (normalizeGeneration(observedGeneration) !== currentGeneration) {
      telemetry.generationMismatches += 1;
      return decideNone("stale-generation");
    }

    if (!pending) {
      const cancelledTimerToken = cancelActiveTimer();
      const decision = decideNone("no-pending");
      return cancelledTimerToken ? { ...decision, cancelledTimerToken } : decision;
    }

    const bytes = normalizePendingMetric(pendingBytes);
    const records = normalizePendingMetric(pendingRecords);
    const ageMs = normalizePendingMetric(pendingAgeMs);
    if (bytes === null || records === null || ageMs === null) {
      return decideFlush("invalid-pending-metrics");
    }
    recordPending(bytes, records, ageMs);
    recordDeadlineOverrun(ageMs);

    if (!config.enabled) return decideFlush("disabled");
    if (hasOpenPass) return decideFlush(WGPU_MAPPED_DRAIN_FORCE_REASONS.PASS);
    if (hasRenderEncoder) return decideFlush(WGPU_MAPPED_DRAIN_FORCE_REASONS.RENDER);
    if (ageMs >= config.maxAgeMs) return decideFlush("age-cap");
    if (bytes >= config.maxBytes) return decideFlush("byte-cap");
    if (records >= config.maxRecords) return decideFlush("record-cap");
    if (deferred) return decideFlush("second-boundary");

    deferred = true;
    activeTimerToken = Object.freeze({
      generation: currentGeneration,
      sequence: ++timerSequence,
    });
    telemetry.deferredBoundaries += 1;
    telemetry.timerArmed += 1;
    return result("defer", "first-boundary", {
      timerToken: activeTimerToken,
      delayMs: config.maxAgeMs - ageMs,
    });
  }

  function force(reason, {
    pending = true,
    pendingBytes = 0,
    pendingRecords = 0,
    pendingAgeMs = 0,
    generation: observedGeneration = currentGeneration,
  } = {}) {
    if (!FORCE_REASON_VALUES.has(reason)) {
      throw new RangeError(`unknown mapped-drain force reason: ${String(reason)}`);
    }
    if (normalizeGeneration(observedGeneration) !== currentGeneration) {
      telemetry.generationMismatches += 1;
      return decideNone("stale-generation");
    }
    if (!pending) {
      const cancelledTimerToken = cancelActiveTimer();
      const decision = decideNone(reason);
      return cancelledTimerToken ? { ...decision, cancelledTimerToken } : decision;
    }
    const bytes = normalizePendingMetric(pendingBytes);
    const records = normalizePendingMetric(pendingRecords);
    const ageMs = normalizePendingMetric(pendingAgeMs);
    if (bytes !== null && records !== null && ageMs !== null) {
      recordPending(bytes, records, ageMs);
      recordDeadlineOverrun(ageMs);
    }
    return decideFlush(reason);
  }

  function onTimer(timerToken, {
    pending = true,
    pendingBytes = 0,
    pendingRecords = 0,
    pendingAgeMs = 0,
    generation: observedGeneration = currentGeneration,
  } = {}) {
    const tokenMatches = timerToken && activeTimerToken &&
      timerToken.sequence === activeTimerToken.sequence &&
      timerToken.generation === activeTimerToken.generation;
    const generationMatches = normalizeGeneration(observedGeneration) === currentGeneration &&
      timerToken?.generation === currentGeneration;
    if (!tokenMatches || !generationMatches || !deferred) {
      telemetry.timerStale += 1;
      return decideNone("stale-timer");
    }

    activeTimerToken = null;
    deferred = false;
    telemetry.timerFired += 1;
    if (!pending) return decideNone("timer-no-pending");
    const bytes = normalizePendingMetric(pendingBytes);
    const records = normalizePendingMetric(pendingRecords);
    const ageMs = normalizePendingMetric(pendingAgeMs);
    if (bytes !== null && records !== null && ageMs !== null) {
      recordPending(bytes, records, ageMs);
      recordDeadlineOverrun(ageMs);
    }
    telemetry.flushDecisions += 1;
    incrementReason(telemetry.flushReasons, "timer-deadline");
    return result("flush", "timer-deadline", { cancelledTimerToken: null });
  }

  function reset({
    generation: nextGeneration = currentGeneration + 1,
    reason = WGPU_MAPPED_DRAIN_FORCE_REASONS.RESET,
    clearTelemetry = false,
  } = {}) {
    const normalizedGeneration = normalizeGeneration(nextGeneration);
    const cancelledTimerToken = cancelActiveTimer();
    currentGeneration = normalizedGeneration;
    if (clearTelemetry) telemetry = makeTelemetry();
    telemetry.resets += 1;
    incrementReason(telemetry.resetReasons, String(reason));
    return result("none", "reset", { cancelledTimerToken });
  }

  function resetTelemetry() {
    telemetry = makeTelemetry();
  }

  function recordSubmission(pendingAgeMs = 0) {
    const ageMs = normalizePendingMetric(pendingAgeMs);
    if (ageMs === null) {
      throw new RangeError("pendingAgeMs must be a non-negative finite number");
    }
    telemetry.actualSubmissions += 1;
    telemetry.actualSubmissionAgeMaxMs = Math.max(
      telemetry.actualSubmissionAgeMaxMs,
      ageMs
    );
    telemetry.actualDeadlineOverrunMaxMs = Math.max(
      telemetry.actualDeadlineOverrunMaxMs,
      Math.max(0, ageMs - config.maxAgeMs)
    );
  }

  function snapshot() {
    return {
      config,
      state: {
        generation: currentGeneration,
        deferred,
        activeTimerToken,
      },
      telemetry: {
        ...telemetry,
        flushReasons: { ...telemetry.flushReasons },
        resetReasons: { ...telemetry.resetReasons },
      },
    };
  }

  return Object.freeze({
    atBoundary,
    force,
    onTimer,
    reset,
    resetTelemetry,
    recordSubmission,
    snapshot,
  });
}
