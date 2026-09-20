const DEFAULT_MAX_EVENTS = 32;
const DEFAULT_MAX_MISSING_IDS_PER_KIND = 4;
const DEFAULT_MAX_DRAIN_SAMPLES = 32;
const DEFAULT_MAX_CHAIN_READBACKS = 8;
const DEFAULT_READBACK_PRESENT_GAP = 120;

// Keep this array in exact wire-protocol order. Fixed-width output avoids
// silently dropping cold opcodes from benchmark artifacts and makes two runs
// directly comparable without first unioning object keys.
export const WGPU_REPLAY_OP_NAMES = Object.freeze([
  "NOP",
  "CLEAR",
  "CREATE_SHADER",
  "CREATE_PIPELINE",
  "DRAW_TEST",
  "CREATE_BUFFER",
  "UPLOAD_BUFFER",
  "CREATE_TEXTURE",
  "UPLOAD_TEXTURE",
  "CREATE_PIPELINE_CFG",
  "CREATE_SAMPLER",
  "CREATE_BIND_GROUP",
  "BEGIN_PASS",
  "SET_PIPELINE",
  "SET_BIND_GROUP",
  "SET_VERTEX_BUFFER",
  "SET_INDEX_BUFFER",
  "SET_VIEWPORT",
  "SET_SCISSOR",
  "DRAW",
  "DRAW_INDEXED",
  "END_PASS",
  "SUBMIT_PRESENT",
  "DESTROY",
  "BLIT_TEXTURE"
]);

export function createWgpuReplayOpMetrics({
  replayTimingSamplePeriod = 32,
  now = () => performance.now(),
} = {}) {
  const timingSamplePeriod = Math.max(
    1,
    Math.trunc(Number(replayTimingSamplePeriod) || 32)
  );
  const replayCount = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const replayTimingSampleCount = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const replayCpuSampleTotalMs = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const replayCpuMaxMs = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const uploadCopyCalls = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const uploadCopyBytes = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const uploadCopyCpuTotalMs = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const uploadCopyCpuMaxMs = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const queueUploadCalls = new Float64Array(WGPU_REPLAY_OP_NAMES.length);
  const queueUploadBytes = new Float64Array(WGPU_REPLAY_OP_NAMES.length);

  function validOp(op) {
    return Number.isInteger(op) && op >= 0 && op < WGPU_REPLAY_OP_NAMES.length;
  }

  function recordReplay(op, cpuTimeMs = 0) {
    if (!validOp(op)) return false;
    const elapsed = finiteNonnegative(cpuTimeMs);
    replayCount[op] += 1;
    replayTimingSampleCount[op] += 1;
    replayCpuSampleTotalMs[op] += elapsed;
    replayCpuMaxMs[op] = Math.max(replayCpuMaxMs[op], elapsed);
    return true;
  }

  function beginReplay(op) {
    if (!validOp(op)) return null;
    replayCount[op] += 1;
    const count = replayCount[op];
    return count === 1 || count % timingSamplePeriod === 0 ? now() : null;
  }

  function finishReplay(op, startedAt) {
    if (!validOp(op) || startedAt === null) return false;
    const elapsed = finiteNonnegative(now() - startedAt);
    replayTimingSampleCount[op] += 1;
    replayCpuSampleTotalMs[op] += elapsed;
    replayCpuMaxMs[op] = Math.max(replayCpuMaxMs[op], elapsed);
    return true;
  }

  function recordReplayBatch(op, count = 0, cpuTimeMs = 0) {
    if (!validOp(op)) return false;
    const records = Math.max(0, Math.trunc(Number(count) || 0));
    if (records === 0) return false;
    const elapsed = finiteNonnegative(cpuTimeMs);
    replayCount[op] += records;
    replayTimingSampleCount[op] += records;
    replayCpuSampleTotalMs[op] += elapsed;
    replayCpuMaxMs[op] = Math.max(replayCpuMaxMs[op], elapsed / records);
    return true;
  }

  function recordUploadCopy(op, bytes = 0, cpuTimeMs = 0) {
    if (!validOp(op)) return false;
    const copiedBytes = finiteNonnegative(bytes);
    const elapsed = finiteNonnegative(cpuTimeMs);
    uploadCopyCalls[op] += 1;
    uploadCopyBytes[op] += copiedBytes;
    uploadCopyCpuTotalMs[op] += elapsed;
    uploadCopyCpuMaxMs[op] = Math.max(uploadCopyCpuMaxMs[op], elapsed);
    return true;
  }

  function recordQueueUpload(op, bytes = 0) {
    if (!validOp(op)) return false;
    queueUploadCalls[op] += 1;
    queueUploadBytes[op] += finiteNonnegative(bytes);
    return true;
  }

  function reset() {
    for (const metric of [
      replayCount,
      replayTimingSampleCount,
      replayCpuSampleTotalMs,
      replayCpuMaxMs,
      uploadCopyCalls,
      uploadCopyBytes,
      uploadCopyCpuTotalMs,
      uploadCopyCpuMaxMs,
      queueUploadCalls,
      queueUploadBytes
    ]) {
      metric.fill(0);
    }
  }

  function snapshot({ enabled = true } = {}) {
    const replayCpuTotalMs = replayCount.map((count, op) => {
      const samples = replayTimingSampleCount[op];
      return samples > 0 ? replayCpuSampleTotalMs[op] * (count / samples) : 0;
    });
    return {
      schema: "wasm-dolphin.wgpu-replay-op-metrics.v1",
      enabled: Boolean(enabled),
      replayTimingMode: "per-op-periodic-sample",
      replayTimingSamplePeriod: timingSamplePeriod,
      opCount: WGPU_REPLAY_OP_NAMES.length,
      names: [...WGPU_REPLAY_OP_NAMES],
      histogram: Array.from(replayCount),
      replayCpuTotalMs: Array.from(replayCpuTotalMs),
      replayTimingSampleCounts: Array.from(replayTimingSampleCount),
      replayCpuSampleTotalMs: Array.from(replayCpuSampleTotalMs),
      replayCpuMaxMs: Array.from(replayCpuMaxMs),
      uploadCopyCalls: Array.from(uploadCopyCalls),
      uploadCopyBytes: Array.from(uploadCopyBytes),
      uploadCopyCpuTotalMs: Array.from(uploadCopyCpuTotalMs),
      uploadCopyCpuMaxMs: Array.from(uploadCopyCpuMaxMs),
      queueUploadCalls: Array.from(queueUploadCalls),
      queueUploadBytes: Array.from(queueUploadBytes),
      uploadCopyDefinition: "wasm-heap-to-local-payload-copy",
      queueUploadDefinition: "GPUQueue.writeBuffer/writeTexture"
    };
  }

  return {
    recordReplay,
    beginReplay,
    finishReplay,
    recordReplayBatch,
    recordUploadCopy,
    recordQueueUpload,
    reset,
    snapshot
  };
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function requestedWgpuReplayDiagnostics(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuclassify") === "1";
}

export function requestedWgpuDeepReplayDiagnostics(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpudeepdiag") === "1";
}

export function requestedWgpuLoadEpochFence(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuloadfence") === "1";
}

export function requestedWgpuDetachedPresenter(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpudetached") === "1";
}

export function requestedWgpuReplayPump(
  search = globalThis.location?.search ?? "",
  enabledByDefault = false
) {
  const value = new URLSearchParams(search).get("wgpupump");
  if (value === "1") return true;
  if (value === "0") return false;
  return Boolean(enabledByDefault);
}

export function requestedWgpuStateCache(
  search = globalThis.location?.search ?? "",
  enabledByDefault = false
) {
  const value = new URLSearchParams(search).get("wgpustatecache");
  if (value === "1") return true;
  if (value === "0") return false;
  return Boolean(enabledByDefault);
}

export function requestedWgpuUboCache(
  search = globalThis.location?.search ?? "",
  enabledByDefault = false
) {
  const value = new URLSearchParams(search).get("wgpuubocache");
  if (value === "1") return true;
  if (value === "0") return false;
  return Boolean(enabledByDefault);
}

export function requestedWgpuUboMetrics(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuubometrics") === "1";
}

// The viewport/uniform dump from the PR #19 black-3D-models investigation.
// It builds string keys out of float arrays on EVERY uniform upload, for the
// first 6000 presents -- about five minutes on the hardware path, so every
// benchmark run this project has ever taken was measured with it running. A
// CPU profile of the consumer thread put it at ~15% of that thread's time,
// plus a large share of an 11% garbage-collector share. Off unless asked for.
export function requestedWgpuVpDiag(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuvpdiag") === "1";
}

export function requestedWgpuUniformFast(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuuniformfast") === "1";
}

export function requestedWgpuReplayBudgetMs(
  search = globalThis.location?.search ?? ""
) {
  const value = new URLSearchParams(search).get("wgpureplayms");
  return value === "4" ? 4 : value === "6" ? 6 : 0;
}

export function requestedWgpuPowerPreference(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpupower") === "low"
    ? "low-power"
    : "high-performance";
}

export function createWgpuReplayBudgetGate({
  budgetMs = 0,
  checkIntervalRecords = 32,
  now = () => performance.now(),
} = {}) {
  const budget = budgetMs === 4 || budgetMs === 6 ? budgetMs : 0;
  const interval = Math.max(1, Math.trunc(Number(checkIntervalRecords) || 32));
  let startedAt = 0;
  let nextCheck = interval;
  let checkCount = 0;
  let atomicContinuationCount = 0;
  let atomicContinuationActive = false;
  let atomicOverrunCompleted = false;
  let atomicOverrunMs = 0;
  let deadlineReached = false;

  function beginDrain() {
    nextCheck = interval;
    checkCount = 0;
    atomicContinuationCount = 0;
    atomicContinuationActive = false;
    atomicOverrunCompleted = false;
    atomicOverrunMs = 0;
    deadlineReached = false;
    startedAt = budget > 0 ? now() : 0;
    return startedAt;
  }

  function check({ processed = 0, passDepth = 0, force = false } = {}) {
    if (budget === 0 || (!force && (processed <= 0 || processed < nextCheck))) {
      return { checked: false, shouldYield: false, reason: null, elapsedMs: 0 };
    }
    while (nextCheck <= processed) nextCheck += interval;
    checkCount += 1;
    const elapsedMs = Math.max(0, now() - startedAt);
    deadlineReached ||= elapsedMs >= budget;
    if (!deadlineReached) {
      return { checked: true, shouldYield: false, reason: null, elapsedMs };
    }
    if (passDepth > 0) {
      atomicContinuationCount += 1;
      atomicContinuationActive = true;
      return { checked: true, shouldYield: false, reason: "atomic-pass", elapsedMs };
    }
    if (atomicContinuationActive && !atomicOverrunCompleted) {
      atomicOverrunCompleted = true;
      atomicOverrunMs = Math.max(0, elapsedMs - budget);
    }
    return { checked: true, shouldYield: true, reason: "time-budget", elapsedMs };
  }

  function snapshot() {
    return {
      enabled: budget > 0,
      budgetMs: budget,
      checkIntervalRecords: interval,
      checkCount,
      atomicContinuationCount,
      atomicOverrunCompleted,
      atomicOverrunMs,
      deadlineReached,
      startedAt,
    };
  }

  return { beginDrain, check, snapshot };
}

export function findPublishedAtomicPassEnd({
  begin,
  write,
  opAt,
  beginOp = 12,
  endOp = 21,
} = {}) {
  if (typeof opAt !== "function") return null;
  const available = (write - begin) >>> 0;
  let depth = 0;
  for (let offset = 0; offset < available; offset += 1) {
    const index = (begin + offset) >>> 0;
    const op = opAt(index);
    if (op === beginOp) depth += 1;
    if (op !== endOp || depth === 0) continue;
    depth -= 1;
    if (depth === 0) return (index + 1) >>> 0;
  }
  return null;
}

export function requestedWgpuGeometryPack(
  search = globalThis.location?.search ?? "",
  enabledByDefault = false
) {
  const value = new URLSearchParams(search).get("wgpugeompack");
  if (value === "1") return true;
  if (value === "0") return false;
  return Boolean(enabledByDefault);
}

export function requestedWgpuGeometryRange(
  search = globalThis.location?.search ?? "",
  enabledByDefault = false
) {
  const value = new URLSearchParams(search).get("wgpugeomrange");
  if (value === "1") return true;
  if (value === "0") return false;
  return Boolean(enabledByDefault);
}

export function requestedWgpuUploadArenaMiB(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpuuploadmb") === "64" ? 64 : 32;
}

export function requestedWgpuMappedStagingSlotCount(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpustagingslots") === "4" ? 4 : 3;
}

export function requestedWgpuMappedStageTimingStride(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpumappedtiming") === "64" ? 64 : 1;
}

export function requestedWgpuUboPack(
  search = globalThis.location?.search ?? "",
  enabledByDefault = false
) {
  const value = new URLSearchParams(search).get("wgpuubopack");
  if (value === "1") return true;
  if (value === "0") return false;
  return Boolean(enabledByDefault);
}

export function requestedWgpuUploadTransport(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpuuploadtransport") === "mapped"
    ? "mapped"
    : "queue";
}

export function requestedWgpuMappedStageFast(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpustagefast") === "1";
}

export function requestedWgpuMappedDrainCoalescing(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpudraincoalesce") === "1";
}

export function requestedWgpuProducerProfile(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpuprodprofile") === "1";
}

export function requestedWgpuDrawProfile(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpudrawprofile") === "1";
}

export function requestedWgpuTailGate(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgputailgate") === "1";
}

export function requestedWgpuDiagnosticQuiet(
  search = globalThis.location?.search ?? ""
) {
  return new URLSearchParams(search).get("wgpudiagquiet") === "1";
}

export function requestedWgpuRendererWorkerProbe(
  search = globalThis.location?.search ?? ""
) {
  const value = new URLSearchParams(search).get("wgpurenderprobe");
  return new Set(["canary", "inline-upload", "worker-upload", "null-drain"]).has(value)
    ? value
    : "off";
}

export function isIntentionalBlankWgpuProbe(value) {
  return value === "inline-upload" || value === "worker-upload" || value === "null-drain";
}

export function shouldShowIntentionalBlankWgpuNotice(
  search = globalThis.location?.search ?? ""
) {
  const params = new URLSearchParams(search);
  return params.get("video") === "wgpu" &&
    isIntentionalBlankWgpuProbe(params.get("wgpurenderprobe"));
}

export function requestedWgpuAtomicPassReplay(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("wgpuatomic") !== "0";
}

export function selectAtomicReplayLimit({
  read,
  write,
  opAt,
  maxRecords = Number.POSITIVE_INFINITY,
  beginOp = 12,
  endOp = 21
}) {
  const available = (write - read) >>> 0;
  const requestedBudget = Number(maxRecords);
  const budget = Number.isFinite(requestedBudget)
    ? Math.min(available, Math.max(0, Math.trunc(requestedBudget)))
    : available;
  let safeLimit = read >>> 0;
  let passStart = null;

  for (let offset = 0; offset < available; offset += 1) {
    // The budget limits ordinary drain work. Once a pass has started,
    // continue through its END_PASS even if that crosses the budget so a
    // 16,385-record pass cannot deadlock behind a 16,384-record window.
    if (offset >= budget && passStart === null) break;
    const index = (read + offset) >>> 0;
    const op = opAt(index);
    if (passStart === null) {
      if (op === beginOp) {
        passStart = index;
      } else {
        safeLimit = (index + 1) >>> 0;
      }
      continue;
    }

    if (op === endOp) {
      passStart = null;
      safeLimit = (index + 1) >>> 0;
    }
  }

  return passStart === null ? safeLimit : passStart;
}

export function summarizeWgpuReplayRange({
  read,
  write,
  recordAt,
  maxRecords = 4096,
  beginOp = 12,
  drawOp = 19,
  drawIndexedOp = 20,
  endOp = 21,
  presentOp = 22,
  uploadBufferOp = 6,
  uploadTextureOp = 8,
  uploadArenaBase = 0,
  uploadArenaSize = 0
}) {
  const available = (write - read) >>> 0;
  const inspected = Math.min(available, Math.max(0, maxRecords | 0));
  const summary = {
    recordCount: available,
    inspectedRecordCount: inspected,
    truncated: inspected < available,
    firstOp: null,
    lastOp: null,
    beginPassCount: 0,
    endPassCount: 0,
    openPassDepth: 0,
    drawCount: 0,
    drawIndexedCount: 0,
    presentCount: 0,
    uploadBufferCount: 0,
    uploadTextureCount: 0,
    uploadBytes: 0,
    uploadReferencesInArena: 0,
    uploadPointerWrapCount: 0,
    potentialArenaOverwrite: false
  };
  let passDepth = 0;
  let previousUploadOffset = null;

  for (let offset = 0; offset < inspected; offset += 1) {
    const record = recordAt((read + offset) >>> 0) || {};
    const op = Number(record.op) >>> 0;
    if (offset === 0) summary.firstOp = op;
    summary.lastOp = op;
    if (op === beginOp) {
      summary.beginPassCount += 1;
      passDepth += 1;
    } else if (op === endOp) {
      summary.endPassCount += 1;
      passDepth = Math.max(0, passDepth - 1);
    } else if (op === drawOp) {
      summary.drawCount += 1;
    } else if (op === drawIndexedOp) {
      summary.drawIndexedCount += 1;
    } else if (op === presentOp) {
      summary.presentCount += 1;
    } else if (op === uploadBufferOp) {
      summary.uploadBufferCount += 1;
      summary.uploadBytes += Math.max(0, Number(record.uploadBytes) || 0);
      observeUploadPointer(record);
    } else if (op === uploadTextureOp) {
      summary.uploadTextureCount += 1;
      summary.uploadBytes += Math.max(0, Number(record.uploadBytes) || 0);
      observeUploadPointer(record);
    }
  }
  summary.openPassDepth = passDepth;
  summary.potentialArenaOverwrite = uploadArenaSize > 0 &&
    summary.uploadBytes > uploadArenaSize;
  return summary;

  function observeUploadPointer(record) {
    const pointer = Number(record.uploadPointer) >>> 0;
    const offset = (pointer - (uploadArenaBase >>> 0)) >>> 0;
    if (!(uploadArenaSize > 0) || offset >= uploadArenaSize) return;
    summary.uploadReferencesInArena += 1;
    if (previousUploadOffset !== null && offset < previousUploadOffset) {
      summary.uploadPointerWrapCount += 1;
    }
    previousUploadOffset = offset;
  }
}

export function createWgpuReplayClassifier({
  maxEvents = DEFAULT_MAX_EVENTS,
  maxDrainSamples = DEFAULT_MAX_DRAIN_SAMPLES,
  maxMissingIdsPerKind = DEFAULT_MAX_MISSING_IDS_PER_KIND,
  generation = 0,
  scope = "session",
  now = () => performance.now()
} = {}) {
  const events = [];
  let eventsDropped = 0;
  let passOpen = false;
  let currentFramebufferId = 0;

  const passAtomicity = {
    status: "pending",
    beginCount: 0,
    explicitEndCount: 0,
    splitAtDrainCount: 0,
    heldIncompletePassCount: 0,
    recordsOutsidePass: 0
  };
  const missingResources = {
    status: "pending",
    total: 0,
    counts: {},
    ids: {}
  };
  const efbMutation = {
    status: "pending",
    framebufferId: 0,
    clearCount: 0,
    drawCount: 0,
    readbackCount: 0,
    postDrawReadbackCount: 0,
    nonzeroReadbackCount: 0,
    drawCountAtLastReadback: 0,
    lastNonzeroBytes: 0,
    lastNonzeroColorBytes: 0,
    lastMaxByte: 0,
    lastPresentSequence: 0
  };
  const firstRealDraw = {
    status: "pending",
    indexed: false,
    framebufferId: 0,
    pipelineId: 0
  };
  const firstEfbDraw = {
    status: "pending",
    indexed: false,
    framebufferId: 0,
    pipelineId: 0,
    state: null
  };
  const firstIndexedEfbDraw = {
    status: "pending",
    framebufferId: 0,
    pipelineId: 0,
    state: null
  };
  const firstEfbPassReadback = {
    status: "pending",
    framebufferId: 0,
    passEndRecordIndex: null,
    drawCountAtEncode: 0,
    readbackCount: 0,
    nonzeroBytes: 0,
    nonzeroColorBytes: 0,
    sampledBytes: 0,
    maxByte: 0,
    error: null
  };
  const firstNonzeroEfb = {
    status: "pending",
    framebufferId: 0,
    nonzeroBytes: 0,
    nonzeroColorBytes: 0,
    maxByte: 0,
    presentSequence: 0,
    readbackOrdinal: 0,
    drawCountAtReadback: 0
  };
  const presentSubmission = {
    status: "pending",
    commandCount: 0,
    submittedCount: 0,
    completedCount: 0,
    errorCount: 0,
    rejectedCount: 0,
    rejectedReasons: {
      "no-command-encoder": 0,
      "submit-error": 0,
      "replay-fatal": 0,
      unknown: 0
    },
    lastRejectedReason: null,
    lastRejectedRecordIndex: null
  };
  const ringEpoch = {
    loadBoundary: null,
    loadFence: {
      armed: false,
      discardedRecords: 0,
      completedAtRecordIndex: null
    },
    drainSamples: [],
    drainSamplesDropped: 0,
    backlogHighWater: 0,
    highWaterSummary: null,
    totalProcessed: 0,
    presentCount: 0
  };
  const presentationChain = {
    efb: createReadbackStage(),
    xfb: createReadbackStage(),
    backbuffer: createReadbackStage()
  };

  function recordEvent(type, detail = {}) {
    const event = { type, at: now(), ...detail };
    if (events.length < maxEvents) events.push(event);
    else eventsDropped += 1;
  }

  function recordPassBegin({ framebufferId = 0, recordIndex = 0 } = {}) {
    passOpen = true;
    currentFramebufferId = framebufferId >>> 0;
    passAtomicity.beginCount += 1;
    recordEvent("pass-begin", { framebufferId: currentFramebufferId, recordIndex });
  }

  function recordPassEnd({ reason = "explicit", recordIndex = 0 } = {}) {
    if (!passOpen) return;
    passOpen = false;
    if (reason === "drain-boundary") passAtomicity.splitAtDrainCount += 1;
    if (reason === "explicit") passAtomicity.explicitEndCount += 1;
    recordEvent("pass-end", { reason, recordIndex, framebufferId: currentFramebufferId });
    currentFramebufferId = 0;
  }

  function recordStateOutsidePass({ op, recordIndex = 0 } = {}) {
    passAtomicity.recordsOutsidePass += 1;
    recordEvent("state-outside-pass", { op, recordIndex });
  }

  function recordAtomicHold({ recordIndex = 0, writeIndex = 0 } = {}) {
    passAtomicity.heldIncompletePassCount += 1;
    recordEvent("incomplete-pass-held", { recordIndex, writeIndex });
  }

  function recordMissingResource({ kind = "unknown", id = 0 } = {}) {
    missingResources.total += 1;
    missingResources.counts[kind] = (missingResources.counts[kind] || 0) + 1;
    const ids = missingResources.ids[kind] || (missingResources.ids[kind] = []);
    if (ids.length < maxMissingIdsPerKind && !ids.includes(id)) ids.push(id);
    recordEvent("missing-resource", { kind, id });
  }

  function recordEfbClear({ framebufferId = 0, rgba = [] } = {}) {
    efbMutation.framebufferId = framebufferId >>> 0;
    efbMutation.clearCount += 1;
    recordEvent("efb-clear", { framebufferId, rgba: rgba.slice(0, 4) });
  }

  function recordRealDraw({
    framebufferId = 0,
    indexed = false,
    pipelineId = 0,
    efb = false,
    state = null
  } = {}) {
    if (firstRealDraw.status !== "pass") {
      firstRealDraw.status = "pass";
      firstRealDraw.indexed = Boolean(indexed);
      firstRealDraw.framebufferId = framebufferId >>> 0;
      firstRealDraw.pipelineId = pipelineId >>> 0;
      recordEvent("first-real-draw", { framebufferId, indexed: Boolean(indexed), pipelineId });
    }
    if (efb || (framebufferId && framebufferId === efbMutation.framebufferId)) {
      efbMutation.framebufferId = framebufferId >>> 0;
      efbMutation.drawCount += 1;
      if (firstEfbDraw.status !== "pass") {
        firstEfbDraw.status = "pass";
        firstEfbDraw.indexed = Boolean(indexed);
        firstEfbDraw.framebufferId = framebufferId >>> 0;
        firstEfbDraw.pipelineId = pipelineId >>> 0;
        firstEfbDraw.state = state == null ? null : structuredClone(state);
        recordEvent("first-efb-draw", {
          framebufferId,
          indexed: Boolean(indexed),
          pipelineId
        });
      }
      if (indexed && firstIndexedEfbDraw.status !== "pass") {
        firstIndexedEfbDraw.status = "pass";
        firstIndexedEfbDraw.framebufferId = framebufferId >>> 0;
        firstIndexedEfbDraw.pipelineId = pipelineId >>> 0;
        firstIndexedEfbDraw.state = state == null ? null : structuredClone(state);
        recordEvent("first-indexed-efb-draw", { framebufferId, pipelineId });
      }
    }
  }

  function needsFirstEfbDrawState(indexed = false) {
    return firstEfbDraw.status !== "pass" ||
      (indexed && firstIndexedEfbDraw.status !== "pass");
  }

  function needsFirstEfbPassReadback(framebufferId = firstIndexedEfbDraw.framebufferId) {
    return firstIndexedEfbDraw.status === "pass" &&
      firstEfbPassReadback.status === "pending" &&
      (framebufferId >>> 0) === firstIndexedEfbDraw.framebufferId;
  }

  function beginFirstEfbPassReadback({
    framebufferId = firstIndexedEfbDraw.framebufferId,
    passEndRecordIndex = 0,
    drawCountAtEncode = efbMutation.drawCount
  } = {}) {
    if (!needsFirstEfbPassReadback(framebufferId)) return false;
    firstEfbPassReadback.status = "running";
    firstEfbPassReadback.framebufferId = framebufferId >>> 0;
    firstEfbPassReadback.passEndRecordIndex = passEndRecordIndex >>> 0;
    firstEfbPassReadback.drawCountAtEncode = Math.max(0, Number(drawCountAtEncode) || 0);
    recordEvent("first-efb-pass-readback-begin", {
      framebufferId: firstEfbPassReadback.framebufferId,
      passEndRecordIndex: firstEfbPassReadback.passEndRecordIndex,
      drawCountAtEncode: firstEfbPassReadback.drawCountAtEncode
    });
    return true;
  }

  function recordFirstEfbPassReadback({
    nonzeroBytes = 0,
    nonzeroColorBytes = nonzeroBytes,
    sampledBytes = 0,
    maxByte = 0,
    error = null
  } = {}) {
    if (firstEfbPassReadback.status !== "running") return false;
    firstEfbPassReadback.readbackCount = 1;
    firstEfbPassReadback.nonzeroBytes = Math.max(0, Number(nonzeroBytes) || 0);
    firstEfbPassReadback.nonzeroColorBytes = Math.max(0, Number(nonzeroColorBytes) || 0);
    firstEfbPassReadback.sampledBytes = Math.max(0, Number(sampledBytes) || 0);
    firstEfbPassReadback.maxByte = Math.max(0, Number(maxByte) || 0);
    firstEfbPassReadback.error = error == null ? null : String(error);
    firstEfbPassReadback.status = error ? "error" :
      firstEfbPassReadback.nonzeroColorBytes > 0 ? "pass" : "fail";
    recordEvent("first-efb-pass-readback-complete", {
      framebufferId: firstEfbPassReadback.framebufferId,
      passEndRecordIndex: firstEfbPassReadback.passEndRecordIndex,
      drawCountAtEncode: firstEfbPassReadback.drawCountAtEncode,
      nonzeroBytes: firstEfbPassReadback.nonzeroBytes,
      nonzeroColorBytes: firstEfbPassReadback.nonzeroColorBytes,
      sampledBytes: firstEfbPassReadback.sampledBytes,
      maxByte: firstEfbPassReadback.maxByte,
      error: firstEfbPassReadback.error
    });
    return true;
  }

  function recordEfbReadback({
    framebufferId = 0,
    nonzeroBytes = 0,
    nonzeroColorBytes = nonzeroBytes,
    maxByte = 0,
    drawCountAtEncode = efbMutation.drawCount,
    presentSequence = 0
  } = {}) {
    efbMutation.framebufferId = framebufferId >>> 0;
    efbMutation.readbackCount += 1;
    efbMutation.drawCountAtLastReadback = drawCountAtEncode;
    if (drawCountAtEncode > 0) efbMutation.postDrawReadbackCount += 1;
    efbMutation.lastNonzeroBytes = nonzeroBytes;
    efbMutation.lastNonzeroColorBytes = nonzeroColorBytes;
    efbMutation.lastMaxByte = maxByte;
    efbMutation.lastPresentSequence = presentSequence >>> 0;
    if (nonzeroColorBytes > 0) {
      efbMutation.nonzeroReadbackCount += 1;
      if (firstNonzeroEfb.status !== "pass") {
        firstNonzeroEfb.status = "pass";
        firstNonzeroEfb.framebufferId = framebufferId >>> 0;
        firstNonzeroEfb.nonzeroBytes = nonzeroBytes;
        firstNonzeroEfb.nonzeroColorBytes = nonzeroColorBytes;
        firstNonzeroEfb.maxByte = maxByte;
        firstNonzeroEfb.presentSequence = presentSequence >>> 0;
        firstNonzeroEfb.readbackOrdinal = efbMutation.readbackCount;
        firstNonzeroEfb.drawCountAtReadback = drawCountAtEncode;
        recordEvent("first-nonzero-efb", {
          framebufferId,
          nonzeroBytes,
          nonzeroColorBytes,
          maxByte,
          presentSequence,
          readbackOrdinal: efbMutation.readbackCount,
          drawCountAtReadback: drawCountAtEncode
        });
      }
    }
  }

  function captureEfbDrawCount() {
    return efbMutation.drawCount;
  }

  function needsPostDrawEfbReadback(
    presentSequence = 0,
    minimumDrawCount = 64,
    minimumPresentGap = DEFAULT_READBACK_PRESENT_GAP
  ) {
    if (efbMutation.drawCount < minimumDrawCount ||
        efbMutation.postDrawReadbackCount >= DEFAULT_MAX_CHAIN_READBACKS ||
        efbMutation.nonzeroReadbackCount > 0) {
      return false;
    }
    return efbMutation.postDrawReadbackCount === 0 ||
      ((presentSequence - efbMutation.lastPresentSequence) >>> 0) >= minimumPresentGap;
  }

  function recordPresentCommand({ recordIndex = 0 } = {}) {
    presentSubmission.commandCount += 1;
    recordEvent("present-command", { recordIndex });
  }

  function recordPresentRejected({ recordIndex = 0, reason = "unknown" } = {}) {
    const normalizedReason = Object.hasOwn(presentSubmission.rejectedReasons, reason)
      ? reason
      : "unknown";
    presentSubmission.rejectedCount += 1;
    presentSubmission.rejectedReasons[normalizedReason] += 1;
    presentSubmission.lastRejectedReason = normalizedReason;
    presentSubmission.lastRejectedRecordIndex = recordIndex >>> 0;
    recordEvent("present-rejected", {
      recordIndex: recordIndex >>> 0,
      reason: normalizedReason
    });
  }

  function recordSubmission({ reason = "unknown", submitted = false, error = null } = {}) {
    if (submitted) presentSubmission.submittedCount += 1;
    if (error) presentSubmission.errorCount += 1;
    recordEvent("submission", { reason, submitted: Boolean(submitted), error: error ? String(error) : undefined });
  }

  function recordPresentCompletion({ completed = false, error = null } = {}) {
    if (completed) presentSubmission.completedCount += 1;
    if (error) presentSubmission.errorCount += 1;
    recordEvent("present-completion", { completed: Boolean(completed), error: error ? String(error) : undefined });
  }

  function recordLoadBoundary({
    readIndex = 0,
    writeIndex = 0,
    uploadReadIndex = 0,
    summary = {}
  } = {}) {
    ringEpoch.loadBoundary = {
      readIndex: readIndex >>> 0,
      writeIndex: writeIndex >>> 0,
      uploadReadIndex: uploadReadIndex >>> 0,
      pendingRecords: (writeIndex - readIndex) >>> 0,
      inspectedRecordCount: Math.max(0, Number(summary.inspectedRecordCount) || 0),
      truncated: Boolean(summary.truncated),
      firstOp: summary.firstOp ?? null,
      lastOp: summary.lastOp ?? null,
      beginPassCount: Math.max(0, Number(summary.beginPassCount) || 0),
      endPassCount: Math.max(0, Number(summary.endPassCount) || 0),
      openPassDepth: Math.max(0, Number(summary.openPassDepth) || 0),
      drawCount: Math.max(0, Number(summary.drawCount) || 0),
      drawIndexedCount: Math.max(0, Number(summary.drawIndexedCount) || 0),
      presentCount: Math.max(0, Number(summary.presentCount) || 0),
      uploadBufferCount: Math.max(0, Number(summary.uploadBufferCount) || 0),
      uploadTextureCount: Math.max(0, Number(summary.uploadTextureCount) || 0),
      uploadBytes: Math.max(0, Number(summary.uploadBytes) || 0)
    };
    recordEvent("load-ring-boundary", ringEpoch.loadBoundary);
  }

  function recordDrainEpoch({
    readIndex = 0,
    writeIndex = 0,
    replayLimit = writeIndex,
    uploadReadIndex = 0,
    processed = 0,
    presentCount = 0,
    summary = null
  } = {}) {
    const backlog = (writeIndex - readIndex) >>> 0;
    const previousHighWater = ringEpoch.backlogHighWater;
    const sample = {
      readIndex: readIndex >>> 0,
      writeIndex: writeIndex >>> 0,
      replayLimit: replayLimit >>> 0,
      uploadReadIndex: uploadReadIndex >>> 0,
      backlog,
      processed: Math.max(0, Number(processed) || 0),
      presentCount: Math.max(0, Number(presentCount) || 0)
    };
    ringEpoch.backlogHighWater = Math.max(ringEpoch.backlogHighWater, backlog);
    if (summary && backlog >= previousHighWater) {
      ringEpoch.highWaterSummary = structuredClone(summary);
    }
    ringEpoch.totalProcessed += sample.processed;
    ringEpoch.presentCount += sample.presentCount;
    const previous = ringEpoch.drainSamples.at(-1);
    if (previous && previous.readIndex === sample.readIndex &&
        previous.writeIndex === sample.writeIndex &&
        previous.replayLimit === sample.replayLimit) {
      return;
    }
    if (ringEpoch.drainSamples.length < maxDrainSamples) ringEpoch.drainSamples.push(sample);
    else ringEpoch.drainSamplesDropped += 1;
  }

  function recordLoadFence({ armed = false, discardedRecords = 0, completedAtRecordIndex = null } = {}) {
    if (armed) ringEpoch.loadFence.armed = true;
    ringEpoch.loadFence.discardedRecords += Math.max(0, Number(discardedRecords) || 0);
    if (completedAtRecordIndex != null) {
      ringEpoch.loadFence.completedAtRecordIndex = completedAtRecordIndex >>> 0;
    }
  }

  function recordPresentationReadback({
    kind,
    framebufferId = 0,
    sourceTextureId = 0,
    nonzeroBytes = 0,
    nonzeroColorBytes = nonzeroBytes,
    nonzeroAlphaBytes = 0,
    sampledBytes = 0,
    maxByte = 0,
    presentSequence = 0
  } = {}) {
    const stage = presentationChain[kind];
    if (!stage) return;
    stage.readbackCount += 1;
    stage.framebufferId = framebufferId >>> 0;
    stage.sourceTextureId = sourceTextureId >>> 0;
    stage.lastNonzeroBytes = Math.max(0, Number(nonzeroBytes) || 0);
    stage.lastNonzeroColorBytes = Math.max(0, Number(nonzeroColorBytes) || 0);
    stage.lastNonzeroAlphaBytes = Math.max(0, Number(nonzeroAlphaBytes) || 0);
    stage.lastSampledBytes = Math.max(0, Number(sampledBytes) || 0);
    stage.lastMaxByte = Math.max(0, Number(maxByte) || 0);
    stage.lastPresentSequence = presentSequence >>> 0;
    if (nonzeroBytes > 0) {
      stage.nonzeroReadbackCount += 1;
      if (!stage.firstNonzero) {
        stage.firstNonzero = {
          nonzeroBytes: stage.lastNonzeroBytes,
          nonzeroColorBytes: stage.lastNonzeroColorBytes,
          nonzeroAlphaBytes: stage.lastNonzeroAlphaBytes,
          sampledBytes: stage.lastSampledBytes,
          maxByte: stage.lastMaxByte,
          presentSequence: stage.lastPresentSequence,
          framebufferId: stage.framebufferId,
          sourceTextureId: stage.sourceTextureId
        };
      }
    }
    if (nonzeroColorBytes > 0) stage.nonzeroColorReadbackCount += 1;
  }

  function needsPresentationReadback(
    kind,
    presentSequence = 0,
    minimumPresentGap = DEFAULT_READBACK_PRESENT_GAP
  ) {
    const stage = presentationChain[kind];
    if (!stage || stage.nonzeroColorReadbackCount > 0 ||
        stage.readbackCount >= DEFAULT_MAX_CHAIN_READBACKS) {
      return false;
    }
    return stage.readbackCount === 0 ||
      ((presentSequence - stage.lastPresentSequence) >>> 0) >= minimumPresentGap;
  }

  function needsBacklogSummary(backlog, minimumBacklog = 4096) {
    return backlog >= minimumBacklog && backlog > ringEpoch.backlogHighWater;
  }

  function snapshot() {
    passAtomicity.status = passAtomicity.splitAtDrainCount || passAtomicity.recordsOutsidePass ? "fail" :
      passAtomicity.explicitEndCount ? "pass" : "pending";
    missingResources.status = missingResources.total ? "fail" : "pending";
    efbMutation.status = efbMutation.nonzeroReadbackCount ? "pass" :
      efbMutation.postDrawReadbackCount ? "fail" : "pending";
    presentSubmission.status = presentSubmission.errorCount || presentSubmission.rejectedCount ? "fail" :
      presentSubmission.completedCount ? "pass" : presentSubmission.submittedCount ? "running" : "pending";

    let classifier = { status: "running", code: "WAITING_FOR_DRAW" };
    if (passAtomicity.splitAtDrainCount) classifier = { status: "fail", code: "PASS_SPLIT_AT_DRAIN" };
    else if (missingResources.total) classifier = { status: "fail", code: "MISSING_RESOURCES" };
    else if (presentSubmission.rejectedCount) classifier = {
      status: "fail",
      code: "PRESENT_SUBMISSION_REJECTED"
    };
    else if (firstEfbPassReadback.status === "error") classifier = {
      status: "fail",
      code: "FIRST_EFB_PASS_READBACK_ERROR"
    };
    else if (firstEfbPassReadback.status === "pass") classifier = {
      status: "pass",
      code: "FIRST_EFB_PASS_MUTATED"
    };
    else if (firstEfbPassReadback.status === "fail" && efbMutation.nonzeroReadbackCount) classifier = {
      status: "fail",
      code: "FIRST_EFB_PASS_NO_MUTATION_LATER_PRESENT_MUTATION"
    };
    else if (firstEfbPassReadback.status === "fail") classifier = {
      status: "fail",
      code: "FIRST_EFB_PASS_NO_MUTATION"
    };
    else if (firstEfbPassReadback.status === "running") classifier = {
      status: "running",
      code: "WAITING_FOR_FIRST_EFB_PASS_READBACK"
    };
    else if (efbMutation.nonzeroReadbackCount && presentSubmission.completedCount) classifier = { status: "pass", code: "PASS" };
    else if (efbMutation.postDrawReadbackCount) classifier = { status: "fail", code: "EFB_DRAW_NO_MUTATION" };
    else if (efbMutation.drawCount && efbMutation.readbackCount) classifier = {
      status: "running",
      code: "WAITING_FOR_POST_DRAW_EFB_READBACK"
    };
    else if (firstRealDraw.status === "pass") classifier = { status: "running", code: "WAITING_FOR_EFB_READBACK" };

    return structuredClone({
      schema: "wasm-dolphin.wgpu-replay-classifier.v2",
      scope,
      generation: generation >>> 0,
      classifier,
      stages: {
        passAtomicity,
        missingResources,
        efbMutation,
        firstRealDraw,
        firstEfbDraw,
        firstIndexedEfbDraw,
        firstEfbPassReadback,
        firstNonzeroEfb,
        presentSubmission,
        ringEpoch,
        presentationChain
      },
      events,
      eventsDropped
    });
  }

  return {
    recordPassBegin,
    recordPassEnd,
    recordStateOutsidePass,
    recordAtomicHold,
    recordMissingResource,
    recordEfbClear,
    recordRealDraw,
    needsFirstEfbDrawState,
    needsFirstEfbPassReadback,
    beginFirstEfbPassReadback,
    recordFirstEfbPassReadback,
    recordEfbReadback,
    captureEfbDrawCount,
    needsPostDrawEfbReadback,
    recordPresentCommand,
    recordPresentRejected,
    recordSubmission,
    recordPresentCompletion,
    recordLoadBoundary,
    recordDrainEpoch,
    recordLoadFence,
    recordPresentationReadback,
    needsPresentationReadback,
    needsBacklogSummary,
    snapshot
  };
}

function createReadbackStage() {
  return {
    readbackCount: 0,
    nonzeroReadbackCount: 0,
    nonzeroColorReadbackCount: 0,
    framebufferId: 0,
    sourceTextureId: 0,
    lastNonzeroBytes: 0,
    lastNonzeroColorBytes: 0,
    lastNonzeroAlphaBytes: 0,
    lastSampledBytes: 0,
    lastMaxByte: 0,
    lastPresentSequence: 0,
    firstNonzero: null
  };
}
