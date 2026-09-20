const DEFAULT_SAMPLE_EVERY = 30;
const DEFAULT_MAX_SAMPLES = 128;

export function requestedGpuCompletionDiagnostics(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("gpucomplete") === "1";
}

export function createGpuCompletionTracker({
  enabled = false,
  sampleEvery = DEFAULT_SAMPLE_EVERY,
  maxSamples = DEFAULT_MAX_SAMPLES,
  now = () => performance.now()
} = {}) {
  const active = Boolean(enabled);
  const interval = Math.max(1, Math.trunc(Number(sampleEvery) || DEFAULT_SAMPLE_EVERY));
  const sampleLimit = Math.max(1, Math.trunc(Number(maxSamples) || DEFAULT_MAX_SAMPLES));
  const samples = [];
  const routes = new Map();
  const stats = {
    submitCount: 0,
    sampleRequestCount: 0,
    completedCount: 0,
    failedCount: 0,
    unsupportedCount: 0,
    inFlight: 0,
    inFlightHighWater: 0,
    lastMs: 0,
    totalMs: 0,
    maxMs: 0,
    lastError: ""
  };

  function routeStats(route) {
    const key = String(route || "unknown");
    if (!routes.has(key)) {
      routes.set(key, {
        submitCount: 0,
        sampleRequestCount: 0,
        completedCount: 0,
        failedCount: 0,
        lastMs: 0,
        totalMs: 0,
        maxMs: 0,
        samples: []
      });
    }
    return routes.get(key);
  }

  function retainSample(target, durationMs) {
    target.push(durationMs);
    if (target.length > sampleLimit) target.shift();
  }

  function finishSuccess(route, startedAt) {
    stats.inFlight = Math.max(0, stats.inFlight - 1);
    const durationMs = Math.max(0, Number(now()) - startedAt);
    if (!Number.isFinite(durationMs)) return;
    const perRoute = routeStats(route);
    stats.completedCount += 1;
    stats.lastMs = durationMs;
    stats.totalMs += durationMs;
    stats.maxMs = Math.max(stats.maxMs, durationMs);
    perRoute.completedCount += 1;
    perRoute.lastMs = durationMs;
    perRoute.totalMs += durationMs;
    perRoute.maxMs = Math.max(perRoute.maxMs, durationMs);
    retainSample(samples, durationMs);
    retainSample(perRoute.samples, durationMs);
  }

  function finishFailure(route, error) {
    stats.inFlight = Math.max(0, stats.inFlight - 1);
    stats.failedCount += 1;
    stats.lastError = String(error?.message || error || "GPU completion failed").slice(0, 256);
    routeStats(route).failedCount += 1;
  }

  function recordSubmittedWork(queue, route = "unknown") {
    if (!active) return false;
    const perRoute = routeStats(route);
    stats.submitCount += 1;
    perRoute.submitCount += 1;
    if (stats.submitCount % interval !== 0) return false;
    if (typeof queue?.onSubmittedWorkDone !== "function") {
      stats.unsupportedCount += 1;
      return false;
    }

    const startedAt = Number(now());
    let completion;
    try {
      completion = queue.onSubmittedWorkDone();
    } catch (error) {
      stats.failedCount += 1;
      stats.lastError = String(error?.message || error || "GPU completion failed").slice(0, 256);
      perRoute.failedCount += 1;
      return false;
    }

    stats.sampleRequestCount += 1;
    perRoute.sampleRequestCount += 1;
    stats.inFlight += 1;
    stats.inFlightHighWater = Math.max(stats.inFlightHighWater, stats.inFlight);
    Promise.resolve(completion).then(
      () => finishSuccess(route, startedAt),
      (error) => finishFailure(route, error)
    );
    return true;
  }

  function snapshot() {
    const byRoute = {};
    for (const [route, value] of routes.entries()) {
      byRoute[route] = summarize(value, value.samples);
    }
    return {
      schema: "wasm-dolphin.gpu-completion.v1",
      enabled: active,
      sampleEvery: interval,
      ...summarize(stats, samples),
      unsupportedCount: stats.unsupportedCount,
      inFlight: stats.inFlight,
      inFlightHighWater: stats.inFlightHighWater,
      lastError: stats.lastError,
      byRoute
    };
  }

  return { recordSubmittedWork, snapshot };
}

function summarize(value, samples) {
  return {
    submitCount: value.submitCount,
    sampleRequestCount: value.sampleRequestCount,
    completedCount: value.completedCount,
    failedCount: value.failedCount,
    lastMs: value.lastMs,
    averageMs: value.completedCount > 0 ? value.totalMs / value.completedCount : 0,
    maxMs: value.maxMs,
    p95Ms: percentile(samples, 0.95)
  };
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}
