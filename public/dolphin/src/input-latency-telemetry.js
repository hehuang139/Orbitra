const DEFAULT_MAX_SAMPLES = 64;

export function requestedInputLatencyDiagnostics(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("inputlatency") === "1";
}

export function requestedInputReadbackDiagnostics(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("inputreadback") === "1";
}

export function parsePadPollStats(value) {
  const text = String(value || "");
  const match = /pad polls:(\d+).*?\binput:([0-9a-f]+)/i.exec(text);
  if (!match) return null;
  const generation = /\bgen:(\d+)/i.exec(text);
  return {
    pollCount: Number.parseInt(match[1], 10) >>> 0,
    inputMask: Number.parseInt(match[2], 16) >>> 0,
    inputGeneration: generation ? Number.parseInt(generation[1], 10) >>> 0 : 0
  };
}

export function createInputVisibleLatencyTracker({
  enabled = false,
  maxSamples = DEFAULT_MAX_SAMPLES,
  now = () => Date.now()
} = {}) {
  const active = Boolean(enabled);
  const sampleLimit = Math.max(1, Math.trunc(Number(maxSamples) || DEFAULT_MAX_SAMPLES));
  const applySamples = [];
  const pollSamples = [];
  const visibleSamples = [];
  const pollToVisibleSamples = [];
  let pending = null;
  const stats = {
    appliedCount: 0,
    duplicateApplyCount: 0,
    supersededCount: 0,
    corePollCount: 0,
    visibleCount: 0,
    applyAgeLastMs: 0,
    pollAgeLastMs: 0,
    visibleAgeLastMs: 0,
    pollToVisibleLastMs: 0,
    lastCompletedGeneration: 0,
    lastCompletedCoreFrame: 0,
    sourceCounts: {}
  };

  function retainSample(target, value) {
    target.push(value);
    if (target.length > sampleLimit) target.shift();
  }

  function recordApplied({
    generation,
    inputMask,
    sentAtEpochMs,
    baselinePollCount = 0,
    baselineVisualHash = 0,
    source = "unknown"
  } = {}) {
    if (!active) return false;
    const normalizedGeneration = Number(generation) >>> 0;
    const normalizedMask = Number(inputMask) >>> 0;
    if (pending?.generation === normalizedGeneration) {
      stats.duplicateApplyCount += 1;
      return false;
    }
    if (pending) stats.supersededCount += 1;

    const appliedAtEpochMs = Number(now());
    const sentAt = Number(sentAtEpochMs);
    const applyAgeMs = validAge(appliedAtEpochMs, sentAt);
    pending = {
      generation: normalizedGeneration,
      inputMask: normalizedMask,
      sentAtEpochMs: Number.isFinite(sentAt) ? sentAt : appliedAtEpochMs,
      appliedAtEpochMs,
      baselinePollCount: Number(baselinePollCount) >>> 0,
      baselineVisualHash: Number(baselineVisualHash) >>> 0,
      polledAtEpochMs: 0
    };
    stats.appliedCount += 1;
    stats.sourceCounts[source] = (stats.sourceCounts[source] || 0) + 1;
    if (applyAgeMs !== null) {
      stats.applyAgeLastMs = applyAgeMs;
      retainSample(applySamples, applyAgeMs);
    }
    return true;
  }

  function recordObservation({ pollCount, inputMask, visualHash, coreFrame = 0 } = {}) {
    if (!active || !pending) return false;
    const observedAt = Number(now());
    const normalizedPollCount = Number(pollCount) >>> 0;
    const normalizedMask = Number(inputMask) >>> 0;
    const normalizedHash = Number(visualHash) >>> 0;

    if (
      !pending.polledAtEpochMs &&
      normalizedPollCount > pending.baselinePollCount &&
      normalizedMask === pending.inputMask
    ) {
      pending.polledAtEpochMs = observedAt;
      stats.corePollCount += 1;
      const pollAgeMs = validAge(observedAt, pending.sentAtEpochMs);
      if (pollAgeMs !== null) {
        stats.pollAgeLastMs = pollAgeMs;
        retainSample(pollSamples, pollAgeMs);
      }
    }

    if (
      !pending.polledAtEpochMs ||
      normalizedHash === 0 ||
      normalizedHash === pending.baselineVisualHash
    ) {
      return false;
    }

    const visibleAgeMs = validAge(observedAt, pending.sentAtEpochMs);
    const pollToVisibleMs = validAge(observedAt, pending.polledAtEpochMs);
    if (visibleAgeMs !== null) {
      stats.visibleAgeLastMs = visibleAgeMs;
      retainSample(visibleSamples, visibleAgeMs);
    }
    if (pollToVisibleMs !== null) {
      stats.pollToVisibleLastMs = pollToVisibleMs;
      retainSample(pollToVisibleSamples, pollToVisibleMs);
    }
    stats.visibleCount += 1;
    stats.lastCompletedGeneration = pending.generation;
    stats.lastCompletedCoreFrame = Number(coreFrame) >>> 0;
    pending = null;
    return true;
  }

  function updatePendingVisualBaseline(visualHash) {
    if (!active || !pending) return false;
    const normalizedHash = Number(visualHash) >>> 0;
    if (!normalizedHash) return false;
    pending.baselineVisualHash = normalizedHash;
    return true;
  }

  function snapshot() {
    return {
      schema: "wasm-dolphin.input-visible-latency.v1",
      enabled: active,
      meaning: "host-to-next-distinct-frame-after-core-poll",
      causalVisualAttribution: false,
      ...stats,
      sourceCounts: { ...stats.sourceCounts },
      pendingGeneration: pending?.generation ?? 0,
      pendingInputMask: pending?.inputMask ?? 0,
      applyAgeAverageMs: average(applySamples),
      applyAgeP95Ms: percentile(applySamples, 0.95),
      pollAgeAverageMs: average(pollSamples),
      pollAgeP95Ms: percentile(pollSamples, 0.95),
      visibleAgeAverageMs: average(visibleSamples),
      visibleAgeP95Ms: percentile(visibleSamples, 0.95),
      visibleAgeMaxMs: maximum(visibleSamples),
      pollToVisibleAverageMs: average(pollToVisibleSamples),
      pollToVisibleP95Ms: percentile(pollToVisibleSamples, 0.95)
    };
  }

  return {
    hasPending: () => Boolean(active && pending),
    recordApplied,
    recordObservation,
    updatePendingVisualBaseline,
    snapshot
  };
}

function validAge(end, start) {
  const age = Number(end) - Number(start);
  return Number.isFinite(age) && age >= 0 && age <= 60000 ? age : null;
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}
