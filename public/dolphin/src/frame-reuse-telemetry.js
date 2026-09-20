export function createFrameReuseTelemetry() {
  return {
    lastHash: 0,
    sampledSourceFrameCount: 0,
    sampledUniqueFrameCount: 0,
    sampledStaleFrameCount: 0,
    sampledStaleFrameRunLast: 0,
    sampledStaleFrameRunMax: 0,
  };
}

export function recordSampledSourceFrame(state, hash) {
  const numeric = Number(hash);
  if (!state || !Number.isFinite(numeric)) return false;
  const normalized = numeric >>> 0;
  if (normalized === 0) return false;

  state.sampledSourceFrameCount += 1;
  if (state.lastHash !== 0 && state.lastHash === normalized) {
    state.sampledStaleFrameCount += 1;
    state.sampledStaleFrameRunLast += 1;
    state.sampledStaleFrameRunMax = Math.max(
      state.sampledStaleFrameRunMax,
      state.sampledStaleFrameRunLast
    );
  } else {
    state.sampledUniqueFrameCount += 1;
    state.sampledStaleFrameRunLast = 0;
  }
  state.lastHash = normalized;
  return true;
}

export function frameReuseTelemetryPayload(state, staleRepaintCount = 0) {
  const sampledSourceFrameCount = Math.max(0, Number(state?.sampledSourceFrameCount) || 0);
  const sampledStaleFrameCount = Math.max(0, Number(state?.sampledStaleFrameCount) || 0);
  return {
    sampledSourceFrameCount,
    sampledUniqueFrameCount: Math.max(0, Number(state?.sampledUniqueFrameCount) || 0),
    sampledStaleFrameCount,
    sampledStaleFrameRatio:
      sampledSourceFrameCount > 0 ? sampledStaleFrameCount / sampledSourceFrameCount : 0,
    sampledStaleFrameRunLast: Math.max(0, Number(state?.sampledStaleFrameRunLast) || 0),
    sampledStaleFrameRunMax: Math.max(0, Number(state?.sampledStaleFrameRunMax) || 0),
    staleRepaintCount: Math.max(0, Number(staleRepaintCount) || 0),
  };
}
