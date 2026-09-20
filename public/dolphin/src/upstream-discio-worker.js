import {
  DEFAULT_UPSTREAM_CORE_SHA256,
  DEFAULT_UPSTREAM_CORE_URL,
  WORKERFS_MOUNT_DIR,
  buildWorkerErrorReply,
  isStrictOneWayWorkerRequest,
  planWorkerSuccessReply,
  sanitizeDiscFileName,
  sha256Hex
} from "./upstream-worker-protocol.js";
import { parseDolHeader } from "./dol.js";
import { decodeWgpuSamplerState } from "./wgpu-sampler-state.js";
import { decodePrebuiltCache } from "./prebuilt-jit-cache-format.js";
import {
  JIT_CACHE_ENTRY_KEY_SCHEMA,
  canonicalCoreFingerprint,
  classifyJitCacheIdentity,
  verifyCanonicalWasmBlockKey
} from "./jit-cache-identity.js";
import {
  createCausalTelemetry,
  emptyStageWindow,
  parseCoreProfileTelemetry,
  stageWindowFromProfile
} from "./causal-telemetry.js";
import {
  createFrameReuseTelemetry,
  frameReuseTelemetryPayload,
  recordSampledSourceFrame
} from "./frame-reuse-telemetry.js";
import {
  createWgpuReplayOpMetrics,
  createWgpuReplayClassifier,
  createWgpuReplayBudgetGate,
  findPublishedAtomicPassEnd,
  isIntentionalBlankWgpuProbe,
  selectAtomicReplayLimit,
  summarizeWgpuReplayRange
} from "./wgpu-replay-diagnostics.js";
import {
  WgpuRendererRuntime,
  failWgpuRingDescriptor,
} from "./wgpu-renderer-runtime.js";
import {
  FRESH_FRAME_DELIVERY,
  freshFrameDeliveryForPacing
} from "./presentation-pacing.js";
import { createGpuCompletionTracker } from "./gpu-completion-telemetry.js";
import {
  createInputVisibleLatencyTracker,
  parsePadPollStats
} from "./input-latency-telemetry.js";
import {
  INPUT_VISUAL_MARKER_SIZE,
  INPUT_VISUAL_MARKER_MODE_PHOTON,
  applyInputVisualMarkerRgba,
  createInputVisualMarkerTracker,
  inputMarkerRgba,
  inputPhotonLuminance,
  resolveInputPhotonMarkerGeometry
} from "./input-visual-marker.js";
import {
  compareInputGenerations,
  readInputStateSnapshot
} from "./input-transport.js";
import {
  enableWgpuUploadWatermark,
  nextWgpuUploadRead,
  rebaseWgpuStagedUploadWindow
} from "./wgpu-upload-watermark.js";
import {
  WGPU_DRAW_PROFILE_PHASE_ORDER,
  WGPU_DRAW_PROFILE_SCHEMA,
  WGPU_PRODUCER_PROFILE_PHASE_ORDER,
  WGPU_PRODUCER_PROFILE_SCHEMA,
  WGPU_TAIL_GATE_SCHEMA,
  createWgpuPassStateCache,
  parseWgpuDrawProfileStats,
  parseWgpuProducerProfileStats,
  parseWgpuProducerStateStats,
  parseWgpuTailGateStats
} from "./wgpu-pass-state-cache.js";
import {
  WGPU_UPLOAD_ROLE,
  createWgpuUploadAttribution
} from "./wgpu-upload-attribution.js";
import { createWgpuDirtyRangeProjection } from "./wgpu-dirty-range-projection.js";
import { createWgpuPassPackageProjection } from "./wgpu-pass-package-projection.js";
import { createWgpuUploadRunProjection } from "./wgpu-upload-run-projection.js";
import {
  WGPU_UBO_COMPUTE_CLASS_BYTES,
  createWgpuUboComputeProjection
} from "./wgpu-ubo-compute-projection.js";
import {
  WGPU_UBO_RING_ROLE,
  createWgpuUboComputeReconstruction
} from "./wgpu-ubo-compute-reconstruction.js";
import {
  WGPU_OWNERSHIP_EVENT,
  attachWgpuOwnershipTraceFromApi,
  createWgpuOwnershipTrace
} from "./wgpu-ownership-trace.js";
import {
  captureInitialWgpuConsumerResetAttestation,
} from "./wgpu-consumer-reset-attestation.js";
import { createWgpuSemanticRuntime } from "./wgpu-semantic-runtime.js";
import { handleWgpuDeviceLoss } from "./wgpu-device-lifecycle.js";
import {
  attemptRetainedWgpuUpload,
  createWgpuMappedStagingPool
} from "./wgpu-mapped-staging-pool.js";
import { createWgpuSparseUboCopyForward } from "./wgpu-sparse-ubo-copy-forward.js";
import {
  WGPU_MAPPED_DRAIN_FORCE_REASONS,
  createWgpuMappedDrainCoalescer
} from "./wgpu-mapped-drain-coalescer.js";
import {
  WGPU_CONSUMER_ERROR_DEVICE_LOST,
  WGPU_CONSUMER_ERROR_SUBMIT,
  WGPU_CONSUMER_ERROR_UNKNOWN,
  enableWgpuNonDroppingBackpressure,
  failWgpuRingConsumer
} from "./wgpu-ring-backpressure.js";
import {
  WGPU_UPLOAD_PROBE_SCHEMA,
  createWgpuUploadProbeExecutor
} from "./wgpu-upload-probe-executor.js";
import { AudioPcmProducer } from "./audio-pcm-producer.js";
import { installWgpuDiagnosticLogFilter } from "./diagnostic-log-filter.js";
import {
  WGPU_VISUAL_BYTES_PER_ROW,
  WGPU_VISUAL_READBACK_BYTES,
  WGPU_VISUAL_READBACK_RING_SIZE,
  WGPU_VISUAL_SAMPLE_HEIGHT,
  WGPU_VISUAL_SAMPLE_WIDTH,
  createWgpuVisualCadenceTelemetry,
  hashWgpuVisualSample
} from "./wgpu-visual-cadence.js";

// Day-25: mark this thread. The discio worker owns the WebGPU device
// (createWebGpuPresenter runs here). WebGPU objects aren't shareable
// across Emscripten pthreads, so the real GPU pipeline's wgpu calls
// must run on THIS thread. C++ probes `self.__dolphinDiscioWorker`
// via EM_ASM at Initialize/Draw/ShowImage to confirm it's on the
// device-owning thread. Pthreads have their own `self` without it.
self.__dolphinDiscioWorker = true;
console.log(`[boot-phase] discio-worker module-eval at perf.now=${performance.now().toFixed(1)}ms`);

let coreUrl = DEFAULT_UPSTREAM_CORE_URL;
let moduleInstance = null;
let api = null;
let wgpuDiagnosticQuiet = false;
let wgpuDiagnosticLogFilter = installWgpuDiagnosticLogFilter({ enabled: false });
let mounted = false;
let inputMask = 0;
let workerOwnsCanvas = false;
let renderCanvas = null;
// Desired backbuffer size for the hardware (command-ring) path, learned from
// the game's own SET_VIEWPORT on fb#0.
//
// createWebGpuPresenter is shared by the software and hardware paths, and
// drawFrameBytesToWebGpu resizes renderCanvas to the FRAME size. Before a disc
// mounts, the built-in demo scene runs at 320x240 and sizes the canvas to that;
// the hardware path then renders into the stale 320x240 backbuffer forever,
// because it never calls drawFrameBytesToWebGpu. The viewport handler clamps
// the game's 640x480 request down to the pass, so it fails silently at quarter
// resolution instead of erroring.
// Dolphin's backbuffer target. index.html declares the visible canvas at this
// size; the demo scene shrinks it to 320x240 via the shared presenter and the
// hardware path never restores it.
const WGPU_BACKBUFFER_W = 640;
const WGPU_BACKBUFFER_H = 480;
let wgpuBackbufferSized = false;
let renderContext = null;
let renderImageData = null;
let renderGpu = null;
let renderGl = null;
let renderGlState = null;
let renderUploadBuffer = null;
let renderRequiresUploadCopy = false;
let preferredPresenterBackend = "webgl";
let presentationLoopActive = false;
let presentedFrame = 0;
let lastPresentedCoreFrame = -1;
let presentationFps = 0;
let presentationRawFps = 0;
let presentationLoopFps = 0;
let presentationAverageIntervalMs = 0;
let presentationP95IntervalMs = 0;
let presentationMaxIntervalMs = 0;
let presentationLongFrameCount = 0;
// Lifetime smoothness counters (never reset). presentationMaxIntervalMs
// resets every 500 ms FPS window, so a transient freeze between windows
// would be invisible. These four persist across the full run so the
// validator can summarize "worst single gap" and full inter-frame
// distribution shape. presentationLifetimeMaxIntervalAtMs is the
// performance.now() timestamp of when the worst gap happened — lets
// the validator distinguish boot-phase stalls (early) from gameplay
// stalls (late).
let presentationLifetimeMaxIntervalMs = 0;
let presentationLifetimeMaxIntervalAtMs = 0;
let presentationLifetimeDropCount = 0;
let presentationLifetimeFrameCount = 0;
// Welford online stddev for inter-frame intervals across the whole run.
let presentationIntervalMean = 0;
let presentationIntervalM2 = 0;
let presentationIntervalCount = 0;
// Fixed-width histogram (ms buckets) of inter-frame intervals — captures
// distribution shape (bimodal, periodic jitter) that p95 alone misses.
// Buckets: 0-8, 8-12, 12-16, 16-20, 20-24, 24-33, 33-50, 50-100, 100-200, 200+
const PRESENTATION_HISTOGRAM_BUCKETS_MS = [8, 12, 16, 20, 24, 33, 50, 100, 200];
const presentationIntervalHistogram = new Uint32Array(
  PRESENTATION_HISTOGRAM_BUCKETS_MS.length + 1
);
let visualChangeFps = 0;
let visualFrameHash = 0;
let lastVisualFrameHash = 0;
let lastOglSwapCount = 0;
let oglGlError = 0;
let visualSampleSource = "none";
let visualChangesSincePresentationFps = 0;
let framesSincePresentationFps = 0;
let loopsSincePresentationFps = 0;
let intervalSumSincePresentationFps = 0;
let intervalSamplesSincePresentationFps = [];
let maxIntervalSincePresentationFps = 0;
let longFramesSincePresentationFps = 0;
let lastPresentationFpsTime = 0;
let lastPresentedAt = 0;
let lastHostPumpTime = 0;
let renderBackend = "none";
let rendererDiagnostics = createRendererDiagnostics();
let wgpuReplayClassifier = null;
let wgpuReplayClassifierGeneration = 0;
let wgpuPresentCompletionProbeStarted = false;
let wgpuClassifierEfbReadbackPending = false;
let wgpuClassifierBackbufferReadbackPending = false;
let wgpuClassifierXfbReadbackPending = false;
let wgpuInputBackbufferReadbackPending = false;
let wgpuInputVisualBaselineReady = false;
let wgpuLastBackbufferSourceTextureId = 0;
let wgpuAtomicPassReplay = true;
let wgpuProducerProfileRequested = false;
let wgpuProducerProfileAvailable = false;
let wgpuDrawProfileRequested = false;
let wgpuDrawProfileAvailable = false;
let wgpuTailGateRequested = false;
let wgpuTailGateAvailable = false;
let wgpuStateCacheEnabled = false;
let wgpuUboCacheEnabled = false;
let wgpuUboMetricsEnabled = false;
let wgpuUniformFastEnabled = false;
let wgpuUboPackEnabled = false;
let wgpuSparseUboEnabled = false;
let wgpuSparseUbo = null;
let wgpuGeometryPackEnabled = false;
let wgpuGeometryRangeEnabled = false;
let wgpuUploadArenaMiB = 32;
let wgpuUploadTransport = "queue";
const WGPU_MAPPED_STAGING_SLOT_COUNT = 3;
const WGPU_MAPPED_STAGING_SLOT_BYTES = 16 * 1024 * 1024;
let wgpuMappedStagingSlotCount = WGPU_MAPPED_STAGING_SLOT_COUNT;
let wgpuMappedStageFastEnabled = false;
const WGPU_FAST_STAGE_ACCEPTED = Object.freeze({ ok: true, reason: null });
let wgpuMappedDrainCoalescingEnabled = false;
let wgpuRendererWorkerProbe = "off";
let wgpuVisualCadenceEnabled = false;
// Mirrors the loaded core's videoBackend for code outside loadCore's scope.
let hardwareVideoBackend = false;
let wgpuVisualCadenceResources = null;
let wgpuVisualCadenceTelemetry = createWgpuVisualCadenceTelemetry(false);
let wgpuVisualCadenceSequence = 0;
let wgpuUploadProbeExecutor = null;
let wgpuUploadProbeWorker = null;
let wgpuUploadProbeOwnerBuffer = null;
let wgpuUploadProbeRing = null;
let wgpuUploadProbeInitMetrics = null;
let wgpuUploadProbeNextRequestId = 1;
const wgpuUploadProbePendingRequests = new Map();
let wgpuMappedStagingPool = null;
let wgpuMappedRemapPromises = new Set();
let wgpuMappedCapacityBlocked = false;
let wgpuMappedCapacityBlockedAt = 0;
let wgpuMappedCapacityBlockedRole = WGPU_UPLOAD_ROLE.UNKNOWN;
let wgpuMappedStagingGeneration = 0;
let wgpuMappedStageTimingStride = 1;
let wgpuMappedDrainCoalescer = createWgpuMappedDrainCoalescer();
let wgpuMappedDrainTimer = null;
let wgpuMappedDrainTimerToken = null;
let wgpuProducerStateCacheAvailable = false;
let wgpuConsumerStateCacheEnabled = false;
let wgpuPassStateCache = createWgpuPassStateCache();
let wgpuReplayOpMetrics = createWgpuReplayOpMetrics();
let wgpuUploadAttribution = createWgpuUploadAttribution();
let wgpuDirtyRangeProjection = createWgpuDirtyRangeProjection();
let wgpuDirtyRangeProjectionRequested = false;
let wgpuDirtyRangeProjectionActive = false;
let wgpuPassPackageProjection = createWgpuPassPackageProjection();
let wgpuPassPackageProjectionRequested = false;
let wgpuPassPackageProjectionActive = false;
let wgpuUploadRunProjection = createWgpuUploadRunProjection();
let wgpuUploadRunProjectionRequested = false;
let wgpuUploadRunProjectionActive = false;
let wgpuUboComputeProjection = createWgpuUboComputeProjection();
let wgpuUboComputeProjectionRequested = false;
let wgpuUboComputeProjectionActive = false;
let wgpuUboComputeReconstruction = null;
let wgpuUboComputeReconstructionRequested = false;
let wgpuUboComputeReconstructionActive = false;
let wgpuOwnershipTrace = createWgpuOwnershipTrace();
let wgpuOwnershipTraceRequested = false;
let wgpuOwnershipTraceActive = false;
let wgpuSemanticRuntime = createWgpuSemanticRuntime();
let wgpuSemanticRuntimeRequested = false;
let wgpuSemanticRuntimeActive = false;
let wgpuDeepReplayDiagnostics = false;
let gpuCompletionDiagnostics = false;
let gpuCompletionTracker = createGpuCompletionTracker();
let inputLatencyDiagnostics = false;
let inputReadbackDiagnostics = false;
let inputPhotonDiagnostics = false;
let inputPhotonOverheadDiagnostics = createInputPhotonOverheadDiagnostics();
let inputVisibleLatencyTracker = createInputVisibleLatencyTracker();
let inputVisualMarkerTracker = createInputVisualMarkerTracker();
let wgpuDetachedPresenter = false;
let wgpuDetachedBitmapPending = false;
let wgpuLoadEpochFence = false;
let wgpuLoadFenceActive = false;
let wgpuReplayPumpEnabled = false;
let wgpuReplayPumpTimer = null;
let wgpuReplayBudgetMs = 0;
let wgpuPowerPreference = "high-performance";
let wgpuReplayFatal = null;
let wgpuReplayYieldPending = false;
let wgpuReplayPumpScheduledAt = 0;
let wgpuReplayPumpDueAt = 0;
let frameProfileStats = "-";
let profileWindow = createProfileWindow();
let lastStructuredProfileWindow = emptyStageWindow();
let causalMetricsEnabled = false;
let collectMetrics = false;
let softwareTevHotCaseMode = 0;
let metricsDiagnostics = createMetricsDiagnostics();
let lastCausalTelemetryAt = 0;
const CAUSAL_TELEMETRY_INTERVAL_MS = 200;
const causalAudioStats = {
  workerMixCount: 0,
  workerRequestedFrames: 0,
  workerReturnedFrames: 0,
  workerEmptyMixCount: 0,
  workerMixLastMs: 0,
  workerMixTotalMs: 0,
  workerMixMaxMs: 0
};
const workletAudioProducer = new AudioPcmProducer({
  api: () => ({
    mixAudio: api?.mixAudio,
    audioBuffer: api?.audioBuffer,
    audioBufferFrames: api?.audioBufferFrames,
    audioChannels: api?.audioChannels,
    audioSampleRate: api?.audioSampleRate,
    heapU8: moduleInstance?.HEAPU8,
  }),
  recordMix: (requested, returned, durationMs) =>
    recordWorkerAudioMix(requested, returned, durationMs),
});
const causalInputStats = {
  workerPostApplyCount: 0,
  workerSabApplyCount: 0,
  workerSabGeneration: 0,
  duplicateGenerationCount: 0,
  staleGenerationCount: 0,
  sabSnapshotRetryCount: 0,
  ageLastMs: 0,
  ageTotalMs: 0,
  ageSamples: 0,
  ageMaxMs: 0
};
// Stall-logger state.
let worstLoopMsLogged = 0;
let stallCount = 0;
let worstSignalWaitMs = 0;
let signalStallCount = 0;
let presentationChannel = null;
let frameSignalHeap = null;
let frameSignalIndex = -1;
let frameSignalValue = 0;
let frameSignalWaitPending = false;
let ppcWasmJitRequested = false;
let ppcWasmJitForce = false;
let ppcWasmJitActive = false;
let ppcWasmJitDisabledForSession = false;
let ppcWasmJitCooldownUntilFrame = 0;
let ppcWasmJitEnabledAtFrame = 0;
// Day-21: presentation fps captured immediately before the JIT
// engaged. The disable guard fuses the JIT only if presentation
// regressed materially below this baseline (i.e. the JIT itself hurt),
// not merely because the renderer is slow.
let ppcWasmJitPreEngageFps = 0;
// Core-fps (emulation throughput) baseline captured just before the JIT
// engages. presentationFps cannot serve this role: it tracks how expensive the
// SCENE is to draw, so a menu-time baseline compared against an in-game frame
// reads as a huge "regression" that the JIT had nothing to do with. Observed on
// Mario Kart Wii as "fps:15 baseline:29" and "fps:6 baseline:46" -- the JIT was
// switched off on entering a race, i.e. exactly when it was needed.
let ppcWasmJitPreEngageCoreFps = 0;
let ppcWasmJitCoreSampleFrame = -1;
let ppcWasmJitCoreSampleTime = 0;
let ppcWasmJitCoreFpsRolling = 0;
let ppcWasmJitCorePaused = false;
let ppcWasmJitTimingSuspensions = 0;
function sampleCoreFpsRolling(coreFrame) {
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const cf = coreFrame >>> 0;
  if (ppcWasmJitCoreSampleFrame < 0) {
    ppcWasmJitCoreSampleFrame = cf;
    ppcWasmJitCoreSampleTime = now;
    return;
  }
  const dt = now - ppcWasmJitCoreSampleTime;
  if (dt >= 1000) {
    ppcWasmJitCoreFpsRolling = (((cf - ppcWasmJitCoreSampleFrame) >>> 0) * 1000) / dt;
    ppcWasmJitCoreSampleFrame = cf;
    ppcWasmJitCoreSampleTime = now;
  }
}
// §28s: renderer-agnostic core-liveness tracker for the JIT fuse.
// presentationFps is structurally ~0 in the WebGPU-presenter path
// (it counts the legacy canvas-blit, not DIAG_EFB_TO_CANVAS), so the
// old `catastrophic = presentationFps < FLOOR` net mis-fired every
// fuse window even at a healthy 60 coreFps → JIT thrash → cutscene
// black-flash. The real "JIT froze emulation" signal is the core
// frame counter not advancing in wall-clock time.
let ppcWasmJitFuseLastFrame = -1;
let ppcWasmJitFuseLastTime = 0;
let ppcWasmJitTier = "guarded";
let ppcWasmJitWarmupFrames = 3600;
let pacedPresentationActive = false;
let nextPacedPresentationTime = 0;
let pacedPresentationTimer = 0;
let pacedPresentationRaf = 0;
let frameQueue = [];
let presentationQueueLimit = 8;
let presentationQueueTarget = 4;
let pacedPresentationPrimed = false;
let pacedPresentationStartedAt = 0;
let presentationPacingMode = "smooth";
let legacyTickQueue = false;
let inputStateSabView = null;
let lastInputStateGeneration = 0;
// Detached OGL mode: worker owns a standalone OffscreenCanvas for the GL
// backend (no transferControlToOffscreen, no compositor binding). After
// each GL swap the worker transferToImageBitmap()s the canvas and posts
// the bitmap to main thread, which drawImages it onto the visible canvas.
let detachedOglCanvas = null;
let detachedOglFrameCount = 0;
let detachedWgpuCanvas = null;
// SAB pixel transport state (Day-5). When enabled, the worker copies
// s_framebuffer bytes into oglPixelSabView per OGL swap and increments
// oglMetaSabView[0] atomically. Main thread reads the counter on RAF and
// putImageDatas to the visible canvas, bypassing the WebGPU presenter.
let oglPixelSabView = null;
let oglMetaSabView = null;
let oglSabWidth = 0;
let oglSabHeight = 0;
let oglSabEnabledForLoad = false;
// Boot-stall watchdog state. Detects the "core CPU is frozen but canvas
// still updates" pattern (Chrome IntensiveWakeUpThrottling clamping the
// worker's setTimeout below 1Hz, starving pumpHostJobs).
let watchdogLastCoreTicks = -1;
let watchdogStallCount = 0;
let watchdogRecoveryCount = 0;
let watchdogFireCount = 0;
const WATCHDOG_STALL_THRESHOLD = 2; // 2 x 500ms = 1s of frozen coreTicks
let presentationUnderrunCount = 0;
let presentationDroppedFrameCount = 0;
let presentationUnderrunsSinceFps = 0;
let presentationDropsSinceFps = 0;
let presentationWindowUnderrunCount = 0;
let presentationWindowDropCount = 0;
let presentationFrameLag = 0;
let presentationQueueAgeMs = 0;
let presentationQueueAgeTotalMs = 0;
let presentationQueueAgeSamples = 0;
let presentationQueueAgeMaxMs = 0;
let presentationQueueDepthHighWater = 0;
let immediateFreshFrameCount = 0;
let queuedFreshFrameCount = 0;
let tickRepaintCount = 0;
let frameReuseTelemetry = createFrameReuseTelemetry();
let lastCapturedCoreFrame = -1;
let coreBoot = {
  attempted: false,
  accepted: false,
  path: "",
  skippedReason: ""
};
let legacyOneWayAck = false;
const workerTransportStats = {
  schema: "wasm-dolphin.worker-transport.v1",
  legacyOneWayAck: false,
  requestsReceived: 0,
  requestMessagesReceived: 0,
  oneWayRequestsReceived: 0,
  requestSuccessRepliesSent: 0,
  requestErrorRepliesSent: 0,
  oneWaySuccessRepliesSuppressed: 0,
  oneWayLegacySuccessRepliesSent: 0,
  oneWayErrorRepliesSent: 0,
  estimatedOneWaySuccessReplyJsonBytesAvoided: 0
};

const MIN_FULL_BOOT_BYTES = 16 * 1024 * 1024;
const LONG_PRESENTATION_FRAME_MS = 24;
const PACED_PRESENTATION_INTERVAL_MS = 1000 / 60;
// Default queue depth (smooth pacing) — 4 absorbs typical paint-time jitter
// (~3 long-frames/s under JIT compile bursts and worker contention) without
// stalling the paced loop. At target=1, steady-state queue depth is ~1-2
// frames; the extra headroom only kicks in on transient spikes. Empirically
// (Day 8) bumping 2→4 lifted presentFps from ~26 to ~55 at the same actual
// paint rate (rawFps=59) — the gap was metric-induced via p95-clamping on
// underrun/drop events.
const DEFAULT_PRESENTATION_QUEUE = 4;
const MIN_PRESENTATION_QUEUE = 2;
const MAX_PRESENTATION_QUEUE = 12;
const VISUAL_HASH_SAMPLE_STRIDE_BYTES = 256;
// §28ao: was 3600 (=60 s @60fps) → the JIT stayed OFF for the first
// minute of a cold run, executing all PPC on the slow interpreter —
// the dominant "not smooth / slow boot" cause (agent-confirmed). 300
// (~5 s) front-loads the one-time compile burst to the GC IPL screen
// (player just watching) instead of the menus. The post-activation
// stall fuse + cooldown already guard against JIT destabilisation.
const DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES = 300;
const WASM_JIT_MIN_STABLE_PRESENTATION_FPS = 25;
const WASM_JIT_MAX_STABLE_PRESENTATION_GAP_MS = 80;
const WASM_JIT_MIN_ACTIVE_FRAMES_BEFORE_FUSE = 240;
// Day-21: regression-relative fuse. Keep the JIT unless presentation
// fell to < 65% of its pre-engage rate (a regression the JIT itself
// introduced) and the baseline was high enough to trust, OR fps is
// catastrophically low in absolute terms (a real freeze). The old
// absolute fps/gap floor mis-fused the JIT whenever the CPU software
// rasteriser — not the JIT — was the fps bottleneck.
const WASM_JIT_REGRESSION_FRACTION = 0.65;
const WASM_JIT_REGRESSION_MIN_BASELINE_FPS = 18;
const WASM_JIT_ABSOLUTE_FLOOR_FPS = 6;
const WASM_JIT_POST_ACTIVATION_STALL_THRESHOLD_MS = 5000;
const WASM_JIT_POST_ACTIVATION_GRACE_FRAMES = 300;
// After a temporary degraded-presentation disable, wait this many video frames
// before allowing the JIT to re-engage. ~5 seconds at 60fps.
const WASM_JIT_DEGRADED_COOLDOWN_FRAMES = 300;

function createRendererDiagnostics() {
  return {
    requestedVideoBackend: null,
    configuredVideoBackend: null,
    activeVideoBackend: "none",
    videoBackendEvidence: "not-configured",
    requestedPresenterBackend: null,
    activePresenterBackend: "none",
    coreSelection: {
      requestedCoreSha256: null,
      requestedCoreUrl: null,
      activeCoreSha256: null,
      activeCoreUrl: null,
      fallbackReason: null,
      fallbackBeforeCanvasTransfer: false,
    },
    fallback: null,
    adapter: null,
    device: null,
    errors: [],
    emscriptenPrintErr: [],
    statusHistory: [],
    fatalStatusHistory: [],
  };
}

function createMetricsDiagnostics() {
  return {
    enabled: false,
    helperStatsCalls: 0,
    profileStatsCalls: 0,
    profileTimeSamples: 0,
  };
}

function metricsDiagnosticsPayload() {
  return { ...metricsDiagnostics, enabled: collectMetrics };
}

function createInputPhotonOverheadDiagnostics(enabled = false) {
  return {
    schema: "wasm-dolphin.input-photon-overhead.v1",
    enabled: Boolean(enabled),
    collectionRequires: "inputphoton=1&metrics=1",
    softwareFrameCopyPaint: {
      calls: 0,
      sourceBytes: 0,
      paintedBytes: 0,
      totalMs: 0,
      maxMs: 0,
    },
    padStatsPollParse: {
      calls: 0,
      sourceUtf16Bytes: 0,
      totalMs: 0,
      maxMs: 0,
      failureCount: 0,
    },
  };
}

function inputPhotonOverheadDiagnosticsPayload() {
  const copyPaint = inputPhotonOverheadDiagnostics.softwareFrameCopyPaint;
  const padStats = inputPhotonOverheadDiagnostics.padStatsPollParse;
  return {
    ...inputPhotonOverheadDiagnostics,
    softwareFrameCopyPaint: {
      ...copyPaint,
      averageMs: copyPaint.calls > 0 ? copyPaint.totalMs / copyPaint.calls : 0,
    },
    padStatsPollParse: {
      ...padStats,
      averageMs: padStats.calls > 0 ? padStats.totalMs / padStats.calls : 0,
    },
  };
}

function webGpuUboCacheMode() {
  return (wgpuUboCacheEnabled ? 1 : 0) |
    (wgpuUboMetricsEnabled ? 2 : 0) |
    (wgpuUniformFastEnabled ? 4 : 0);
}

function webGpuUboPackMode() {
  // The exact-slice cache owns independent class lifetimes. Dense packets use
  // one shared publication serial, so cache mode deliberately forces legacy.
  return wgpuUboPackEnabled && !wgpuUboCacheEnabled ? 1 : 0;
}

function recordRendererError(kind, message) {
  const entry = {
    atMs: Number(performance.now().toFixed(3)),
    kind,
    message: String(message || "unknown").slice(0, 1000),
  };
  rendererDiagnostics.errors.push(entry);
  if (
    causalMetricsEnabled &&
    (
      String(kind).toLowerCase().includes("webgpu") ||
      ["validation", "uncaptured-error", "device-lost", "submit-error", "error-scope-failure"].includes(kind)
    )
  ) {
    webGpuCausalStats.errorCount += 1;
  }
  if (rendererDiagnostics.errors.length > 64) rendererDiagnostics.errors.shift();
  return entry;
}

function wgpuOutputContractPayload() {
  const intentionalBlankProbe = isIntentionalBlankWgpuProbe(wgpuRendererWorkerProbe);
  return {
    schema: "wasm-dolphin.wgpu-output-contract.v1",
    disposition: intentionalBlankProbe ? "intentional-blank-probe" : "visible-canvas",
    expectsVisibleCanvas: !intentionalBlankProbe,
    activePresenterBackend: renderBackend,
    probeMode: intentionalBlankProbe ? wgpuRendererWorkerProbe : null
  };
}

function wgpuRuntimeConfigPayload() {
  return {
    schema: "wasm-dolphin.wgpu-runtime-config.v1",
    metricsEnabled: causalMetricsEnabled,
    uploadTransport: wgpuUploadTransport,
    stateCacheEnabled: wgpuStateCacheEnabled,
    uboCacheEnabled: Boolean(webGpuUboCacheMode() & 1),
    producerUboCacheMetricsEnabled: Boolean(webGpuUboCacheMode() & 2),
    producerUniformFastEnabled: Boolean(webGpuUboCacheMode() & 4),
    uboPackEnabled: Boolean(webGpuUboPackMode()),
    producerUboCacheAvailable: Boolean(api?.setWebGpuUboCacheEnabled),
    producerUboPackAvailable: Boolean(api?.setWebGpuUboPackEnabled),
    geometryPackEnabled: wgpuGeometryPackEnabled,
    geometryRangeEnabled: wgpuGeometryRangeEnabled,
    producerGeometryRangeAvailable: Boolean(api?.setWebGpuGeometryRangeEnabled),
    mappedStagingFastPath: wgpuMappedStageFastEnabled,
    mappedStaging: {
      enabled: wgpuUploadTransport === "mapped",
      slotCount: wgpuMappedStagingSlotCount,
      recordStore: wgpuMappedStageFastEnabled ? "flat" : "objects",
      timing: {
        enabled: causalMetricsEnabled,
        stride: wgpuMappedStageTimingStride,
      },
    },
    uploadAttribution: {
      mappedStageTiming: { stride: wgpuMappedStageTimingStride },
    },
    mappedDrainCoalescingEnabled: wgpuMappedDrainCoalescingEnabled,
    tailGate: {
      schema: WGPU_TAIL_GATE_SCHEMA,
      schemaVersion: 1,
      requested: wgpuTailGateRequested,
      available: wgpuTailGateAvailable,
      enabled: wgpuTailGateRequested && wgpuTailGateAvailable,
    },
  };
}

function rendererDiagnosticsPayload() {
  return {
    ...rendererDiagnostics,
    coreSelection: { ...rendererDiagnostics.coreSelection },
    activePresenterBackend: renderBackend,
    metrics: metricsDiagnosticsPayload(),
    errors: rendererDiagnostics.errors.map((entry) => ({ ...entry })),
    emscriptenPrintErr: [...rendererDiagnostics.emscriptenPrintErr],
    statusHistory: rendererDiagnostics.statusHistory.map((entry) => ({ ...entry })),
    fatalStatusHistory: rendererDiagnostics.fatalStatusHistory.map((entry) => ({ ...entry })),
    workerTransport: workerTransportTelemetry(),
    diagnosticLogFilter: wgpuDiagnosticLogFilter.snapshot(),
    outputContract: wgpuOutputContractPayload(),
    runtimeConfig: wgpuRuntimeConfigPayload(),
    wgpuReplayClassifier: wgpuReplayClassifier?.snapshot() ?? null,
    wgpuReplayOps: wgpuReplayOpMetrics.snapshot({ enabled: causalMetricsEnabled }),
    wgpuUploadAttribution: wgpuUploadAttribution.snapshot({ enabled: causalMetricsEnabled }),
    wgpuDirtyRangeProjection: wgpuDirtyRangeProjection.snapshot({
      requested: wgpuDirtyRangeProjectionRequested,
      active: wgpuDirtyRangeProjectionActive
    }),
    wgpuPassPackageProjection: wgpuPassPackageProjection.snapshot({
      requested: wgpuPassPackageProjectionRequested,
      active: wgpuPassPackageProjectionActive
    }),
    wgpuUploadRunProjection: wgpuUploadRunProjection.snapshot({
      requested: wgpuUploadRunProjectionRequested,
      active: wgpuUploadRunProjectionActive
    }),
    wgpuUboComputeProjection: wgpuUboComputeProjection.snapshot({
      requested: wgpuUboComputeProjectionRequested,
      active: wgpuUboComputeProjectionActive
    }),
    wgpuUboComputeReconstruction: wgpuUboComputeReconstructionSnapshot(),
    wgpuOwnershipTrace: wgpuOwnershipTrace.snapshot(),
    wgpuSemanticRuntime: wgpuSemanticRuntime.snapshot(),
    wgpuVisualCadence: wgpuVisualCadenceSnapshot(),
  };
}

function wgpuVisualCadenceSnapshot() {
  return {
    ...wgpuVisualCadenceTelemetry,
    visualFps: wgpuVisualCadenceEnabled ? visualChangeFps : 0
  };
}

self.addEventListener("message", async (event) => {
  const data = event.data ?? {};
  // Forward detachedOglFrame messages from Dolphin's GPU pthread to main.
  // The C++ Swap path posts the bitmap from whichever pthread owns the
  // canvas (Emscripten transfers Module.canvas to the GPU pthread on first
  // access, detaching it from the discio-worker side). The pthread's
  // postMessage lands on its parent (this discio worker), so we forward
  // it on to main where the upstream-worker-adapter handles it.
  if (data && data.type === "detachedOglFrame" && data.bitmap) {
    try {
      self.postMessage(
        { type: "detachedOglFrame", bitmap: data.bitmap, width: data.width, height: data.height },
        [data.bitmap]
      );
    } catch (err) {
      try { data.bitmap.close(); } catch {}
    }
    return;
  }
  const { type, payload = {} } = data;
  const oneWay = isStrictOneWayWorkerRequest(data);
  workerTransportStats.requestsReceived += 1;
  if (oneWay) {
    workerTransportStats.oneWayRequestsReceived += 1;
  } else {
    workerTransportStats.requestMessagesReceived += 1;
  }

  try {
    const result = await handleMessage(type, payload);
    postResult(data, result);
  } catch (error) {
    const errorName = error?.name || error?.constructor?.name || "Error";
    if (errorName === "LinkError" || errorName === "WebAssembly.LinkError") {
      recordRendererError("wasm-link-error", `${errorName}: ${error?.message || error}`);
    }
    postStatus(`${errorName}: ${error instanceof Error ? error.message : String(error)}`);
    if (oneWay) {
      workerTransportStats.oneWayErrorRepliesSent += 1;
    } else {
      workerTransportStats.requestErrorRepliesSent += 1;
    }
    self.postMessage(
      buildWorkerErrorReply(
        data,
        error instanceof Error ? error.message : String(error)
      )
    );
  }
});

async function handleMessage(type, payload) {
  switch (type) {
    case "load":
      if (!moduleInstance) {
        cancelWgpuMappedDrainTimer();
        wgpuMappedStagingGeneration += 1;
      }
      causalMetricsEnabled = Boolean(payload.collectMetrics);
      collectMetrics = Boolean(payload.collectMetrics);
      metricsDiagnostics = createMetricsDiagnostics();
      metricsDiagnostics.enabled = collectMetrics;
      wgpuReplayOpMetrics = createWgpuReplayOpMetrics();
      wgpuMappedStageTimingStride = Number(payload.wgpuMappedStageTimingStride) === 64
        ? 64
        : 1;
      wgpuUploadAttribution = createWgpuUploadAttribution({
        mappedStageTimingStride: wgpuMappedStageTimingStride,
      });
      wgpuDirtyRangeProjection = createWgpuDirtyRangeProjection();
      wgpuDirtyRangeProjectionRequested = Boolean(payload.wgpuDirtyRangeProjection);
      wgpuDirtyRangeProjectionActive =
        wgpuDirtyRangeProjectionRequested && causalMetricsEnabled;
      wgpuPassPackageProjection = createWgpuPassPackageProjection();
      wgpuPassPackageProjectionRequested = Boolean(payload.wgpuPassPackageProjection);
      wgpuPassPackageProjectionActive = wgpuPassPackageProjectionRequested &&
        causalMetricsEnabled && payload.videoBackend === "WebGPU-Real";
      wgpuUploadRunProjection = createWgpuUploadRunProjection({
        maxEnvelopeBytes: WGPU_MAPPED_STAGING_SLOT_BYTES,
      });
      wgpuUploadRunProjectionRequested = Boolean(payload.wgpuUploadRunProjection);
      wgpuUploadRunProjectionActive = wgpuUploadRunProjectionRequested &&
        causalMetricsEnabled && payload.videoBackend === "WebGPU-Real" &&
        payload.wgpuUploadTransport === "mapped";
      wgpuUboComputeProjection = createWgpuUboComputeProjection();
      wgpuUboComputeProjectionRequested = Boolean(payload.wgpuUboComputeProjection);
      wgpuUboComputeProjectionActive = wgpuUboComputeProjectionRequested &&
        causalMetricsEnabled && payload.videoBackend === "WebGPU-Real" &&
        payload.wgpuUploadTransport === "mapped";
      wgpuUboComputeReconstruction = null;
      wgpuUboComputeReconstructionRequested = Boolean(
        payload.wgpuUboComputeReconstruction
      );
      wgpuUboComputeReconstructionActive =
        wgpuUboComputeReconstructionRequested && causalMetricsEnabled &&
        payload.videoBackend === "WebGPU-Real" &&
        payload.wgpuUploadTransport === "mapped";
      wgpuOwnershipTrace = createWgpuOwnershipTrace();
      wgpuSemanticRuntimeRequested = Boolean(payload.wgpuSemanticRuntime);
      wgpuSemanticRuntimeActive = wgpuSemanticRuntimeRequested &&
        causalMetricsEnabled && payload.videoBackend === "WebGPU-Real";
      wgpuOwnershipTraceRequested = Boolean(payload.wgpuOwnershipTrace) ||
        wgpuSemanticRuntimeRequested;
      wgpuOwnershipTraceActive = wgpuOwnershipTraceRequested &&
        causalMetricsEnabled && payload.videoBackend === "WebGPU-Real";
      gpuCompletionDiagnostics = Boolean(payload.gpuCompletionDiagnostics);
      gpuCompletionTracker = createGpuCompletionTracker({
        enabled: gpuCompletionDiagnostics
      });
      inputPhotonDiagnostics = Boolean(payload.inputPhotonDiagnostics);
      inputLatencyDiagnostics = Boolean(
        payload.inputLatencyDiagnostics || inputPhotonDiagnostics
      );
      inputPhotonOverheadDiagnostics = createInputPhotonOverheadDiagnostics(
        inputPhotonDiagnostics && collectMetrics
      );
      inputReadbackDiagnostics = Boolean(
        inputLatencyDiagnostics && payload.inputReadbackDiagnostics
      );
      inputVisibleLatencyTracker = createInputVisibleLatencyTracker({
        enabled: inputLatencyDiagnostics
      });
      inputVisualMarkerTracker = createInputVisualMarkerTracker({
        enabled: inputLatencyDiagnostics,
        mode: inputPhotonDiagnostics
          ? INPUT_VISUAL_MARKER_MODE_PHOTON
          : undefined,
        opticalMarker: payload.inputPhotonMarker
      });
      frameReuseTelemetry = createFrameReuseTelemetry();
      legacyOneWayAck = Boolean(payload.legacyOneWayAck);
      workerTransportStats.legacyOneWayAck = legacyOneWayAck;
      if (payload.inputStateSab instanceof SharedArrayBuffer) {
        inputStateSabView = new Int32Array(payload.inputStateSab);
        lastInputStateGeneration = 0;
      }
      // SAB pixel transport: set up shared views once. The worker's
      // presentation loop will copy s_framebuffer bytes into oglPixelSabView
      // per OGL swap and bump oglMetaSabView[0] atomically — main thread
      // reads the counter in its existing RAF loop and putImageDatas.
      if (payload.oglPixelSab instanceof SharedArrayBuffer &&
          payload.oglMetaSab instanceof SharedArrayBuffer) {
        oglPixelSabView = new Uint8Array(payload.oglPixelSab);
        oglMetaSabView = new Int32Array(payload.oglMetaSab);
        oglSabWidth = payload.oglSabWidth | 0;
        oglSabHeight = payload.oglSabHeight | 0;
      }
      await loadCore({
        coreUrl: payload.coreUrl,
        expectedCoreSha256: payload.expectedCoreSha256,
        canvas: payload.canvas,
        videoBackend: payload.videoBackend,
        cpuThread: payload.cpuThread,
        cpuCore: payload.cpuCore,
        ppcWasmJit: payload.ppcWasmJit,
        ppcWasmJitForce: payload.ppcWasmJitForce,
        ppcWasmJitTier: payload.ppcWasmJitTier,
        ppcWasmJitWarmupFrames: payload.ppcWasmJitWarmupFrames,
        ppcProfile: payload.ppcProfile,
        cpuOverclock: payload.cpuOverclock,
        emulationSpeed: payload.emulationSpeed,
        presentationScale: payload.presentationScale,
        presentationQueueSize: payload.presentationQueueSize,
        presentationPacing: payload.presentationPacing,
        legacyTickQueue: payload.legacyTickQueue,
        presenterBackend: payload.presenterBackend,
        oglProxyMode: payload.oglProxyMode,
        oglTestClear: payload.oglTestClear,
        fastSoftwareRaster: payload.fastSoftwareRaster,
        softwareTevHotCaseMode: payload.softwareTevHotCaseMode,
        xfbFastPaths: payload.xfbFastPaths,
        correctTimeDrift: payload.correctTimeDrift,
        coreLog: payload.coreLog,
        efbDiag: payload.efbDiag,
        jitVerbose: payload.jitVerbose,
        frameCap: payload.frameCap,
        cachedInterpreterDisableMask: payload.cachedInterpreterDisableMask,
        wgpuScissoredClearRect: payload.wgpuScissoredClearRect,
        noJitCache: payload.noJitCache,
        reportedCoreSelection: payload.coreSelection,
        wgpuReplayDiagnostics: payload.wgpuReplayDiagnostics,
        wgpuDeepReplayDiagnostics: payload.wgpuDeepReplayDiagnostics,
        wgpuDetachedPresenter: payload.wgpuDetachedPresenter,
        wgpuLoadEpochFence: payload.wgpuLoadEpochFence,
        wgpuReplayPump: payload.wgpuReplayPump,
        wgpuReplayBudgetMs: payload.wgpuReplayBudgetMs,
        wgpuPowerPreference: payload.wgpuPowerPreference,
        wgpuAtomicPassReplay: payload.wgpuAtomicPassReplay,
        wgpuDiagnosticQuiet: payload.wgpuDiagnosticQuiet,
        wgpuProducerProfile: payload.wgpuProducerProfile,
        wgpuDrawProfile: payload.wgpuDrawProfile,
        wgpuTailGate: payload.wgpuTailGate,
        wgpuStateCache: payload.wgpuStateCache,
        wgpuUboCache: payload.wgpuUboCache,
        wgpuUboMetrics: payload.wgpuUboMetrics,
        wgpuVpDiag: payload.wgpuVpDiag,
        wgpuUniformFast: payload.wgpuUniformFast,
        wgpuUboPack: payload.wgpuUboPack,
        wgpuSparseUbo: payload.wgpuSparseUbo,
        wgpuGeometryPack: payload.wgpuGeometryPack,
        wgpuGeometryRange: payload.wgpuGeometryRange,
        wgpuUploadArenaMiB: payload.wgpuUploadArenaMiB,
        wgpuUploadTransport: payload.wgpuUploadTransport,
        wgpuMappedStagingSlotCount: payload.wgpuMappedStagingSlotCount,
        wgpuMappedStageFast: payload.wgpuMappedStageFast,
        wgpuMappedDrainCoalescing: payload.wgpuMappedDrainCoalescing,
        wgpuRendererWorkerProbe: payload.wgpuRendererWorkerProbe,
        wgpuVisualCadence: payload.wgpuVisualCadence,
        wgpuPassPackageProjection: payload.wgpuPassPackageProjection,
        wgpuUploadRunProjection: payload.wgpuUploadRunProjection,
        wgpuUboComputeProjection: payload.wgpuUboComputeProjection,
        wgpuUboComputeReconstruction: payload.wgpuUboComputeReconstruction,
        wgpuOwnershipTrace: payload.wgpuOwnershipTrace,
        wgpuSemanticRuntime: payload.wgpuSemanticRuntime,
        oglSabEnabled: oglPixelSabView !== null
      });
      return metadataPayload();
    case "mountFile":
      return mountFile(payload.file);
    case "setInputMask":
      inputMask = payload.mask >>> 0;
      api?.setInputMask(inputMask);
      return {};
    case "setInputState":
      applyInputStateSnapshot({
        mask: payload.mask,
        stickX: payload.stickX,
        stickY: payload.stickY,
        cStickX: payload.cStickX,
        cStickY: payload.cStickY,
        triggerLeft: payload.triggerLeft,
        triggerRight: payload.triggerRight,
        analogA: payload.analogA,
        analogB: payload.analogB,
        inputGeneration: payload.inputGeneration
      }, payload.inputSentAtEpochMs, "post");
      return {};
    case "runFrame":
      if (!presentationLoopActive) {
        api?.pumpHostJobs?.();
      }
      if (!coreBoot.accepted && !presentationLoopActive) {
        api?.runFrame();
      }
      return framePayload();
    case "reset":
      forceWgpuMappedDrainLifecycle(WGPU_MAPPED_DRAIN_FORCE_REASONS.RESET);
      wgpuSparseUbo?.reset("core-reset");
      if (wgpuUboComputeProjectionActive) {
        wgpuUboComputeProjection.reset("core-reset");
      }
      wgpuUboComputeReconstruction?.reset("core-reset");
      workletAudioProducer.transition();
      api?.reset();
      api?.setWebGpuUploadArenaMiB?.(wgpuUploadArenaMiB, collectMetrics ? 1 : 0);
      api?.setWebGpuProducerProfileEnabled?.(wgpuProducerProfileRequested ? 1 : 0);
      api?.setWebGpuDrawProfileEnabled?.(wgpuDrawProfileRequested ? 1 : 0);
      applyWgpuTailGate("core reset");
      api?.setWebGpuUboCacheEnabled?.(webGpuUboCacheMode());
      api?.setWebGpuUboPackEnabled?.(webGpuUboPackMode());
      api?.setWebGpuGeometryPackEnabled?.(wgpuGeometryPackEnabled ? 1 : 0);
      api?.setWebGpuGeometryRangeEnabled?.(wgpuGeometryRangeEnabled ? 1 : 0);
      api?.setSoftwareTevHotCaseMode?.(softwareTevHotCaseMode);
      if (wgpuProducerProfileRequested || wgpuDrawProfileRequested) {
        verifyWgpuProducerProfileActivation("core reset");
      }
      api?.setInputMask(inputMask);
      return framePayload();
    case "bootProbe":
      return { bootProbe: bootProbePayload(metadataPayload()) };
    case "saveState":
      return { saved: Boolean(api?.saveState(payload.slot | 0)) };
    case "loadState": {
      forceWgpuMappedDrainLifecycle(WGPU_MAPPED_DRAIN_FORCE_REASONS.LOAD);
      wgpuSparseUbo?.reset("slot-state-load");
      if (wgpuUboComputeProjectionActive) {
        wgpuUboComputeProjection.reset("slot-state-load");
      }
      wgpuUboComputeReconstruction?.reset("slot-state-load");
      workletAudioProducer.transition();
      api?.setWebGpuUploadArenaMiB?.(wgpuUploadArenaMiB, collectMetrics ? 1 : 0);
      api?.setWebGpuProducerProfileEnabled?.(wgpuProducerProfileRequested ? 1 : 0);
      api?.setWebGpuDrawProfileEnabled?.(wgpuDrawProfileRequested ? 1 : 0);
      applyWgpuTailGate("slot state pre-load");
      api?.setWebGpuUboCacheEnabled?.(webGpuUboCacheMode());
      api?.setWebGpuUboPackEnabled?.(webGpuUboPackMode());
      api?.setWebGpuGeometryPackEnabled?.(wgpuGeometryPackEnabled ? 1 : 0);
      api?.setWebGpuGeometryRangeEnabled?.(wgpuGeometryRangeEnabled ? 1 : 0);
      let loaded = false;
      ppcWasmJitTimingSuspensions += 1;
      try {
        loaded = Boolean(api?.loadState(payload.slot | 0));
      } finally {
        resetPpcWasmJitTiming(loaded);
        ppcWasmJitTimingSuspensions -= 1;
      }
      api?.setWebGpuUploadArenaMiB?.(wgpuUploadArenaMiB, collectMetrics ? 1 : 0);
      api?.setWebGpuProducerProfileEnabled?.(wgpuProducerProfileRequested ? 1 : 0);
      api?.setWebGpuDrawProfileEnabled?.(wgpuDrawProfileRequested ? 1 : 0);
      applyWgpuTailGate("slot state reload");
      api?.setWebGpuUboCacheEnabled?.(webGpuUboCacheMode());
      api?.setWebGpuUboPackEnabled?.(webGpuUboPackMode());
      api?.setWebGpuGeometryPackEnabled?.(wgpuGeometryPackEnabled ? 1 : 0);
      api?.setWebGpuGeometryRangeEnabled?.(wgpuGeometryRangeEnabled ? 1 : 0);
      api?.setSoftwareTevHotCaseMode?.(softwareTevHotCaseMode);
      if (wgpuProducerProfileRequested || wgpuDrawProfileRequested) {
        verifyWgpuProducerProfileActivation("slot state reload");
      }
      return { loaded, ...framePayload() };
    }
    case "validationSetCorePaused": {
      // Harness-only checkpoint barrier. The app never sends this message;
      // normal emulator pause/start behavior and defaults remain unchanged.
      if (!api?.setCorePaused) {
        return { paused: false, error: "SetCorePaused export unavailable" };
      }
      const paused = Boolean(payload.paused);
      const transitionAtMs = performance.now();
      ppcWasmJitTimingSuspensions += 1;
      resetPpcWasmJitTiming();
      try {
        if (api.setCorePaused(paused ? 1 : 0)) {
          ppcWasmJitCorePaused = paused;
        }
        if (paused) await new Promise((resolve) => setTimeout(resolve, 100));
        const observedAtMs = performance.now();
        const coreStateName = api?.getCoreStateName?.() ?? "";
        if (coreStateName) ppcWasmJitCorePaused = coreStateName === "Paused";
        return {
          paused: coreStateName === "Paused",
          requestedPaused: paused,
          coreStateName,
          transitionAtMs,
          observedAtMs,
          ...framePayload(),
        };
      } finally {
        resetPpcWasmJitTiming();
        ppcWasmJitTimingSuspensions -= 1;
      }
    }
    case "validationReadCoreProgress": {
      const loadedCheckpoint = readLastLoadedCheckpoint();
      return {
        frame: api?.getFrame?.() ?? 0,
        coreTicks: readCoreTicks(),
        coreTicksPerSecond: readCoreTicksPerSecond(),
        ppcPc: api?.getPpcPc?.() ?? 0,
        loadedCheckpointGeneration: loadedCheckpoint.generation,
        loadedCheckpointTicks: loadedCheckpoint.ticks,
        loadedCheckpointPpcPc: loadedCheckpoint.ppcPc,
        observedAtMs: performance.now(),
      };
    }
    case "validationReadJitCacheReadiness": {
      const requiredWorkers = dolphinJitPthreadRuntime
        ? [...new Set(dolphinJitPthreadRuntime.runningWorkers || [])]
        : [];
      const requiredBarrierAcked = requiredWorkers.filter(
        (worker) =>
          dolphinJitPthreadBarrierAckGeneration.get(worker) ===
          dolphinJitPthreadBarrierGeneration
      ).length;
      return {
        schema: "wasm-dolphin.jit-cache-readiness.v1",
        enabled: dolphinJitCachePersistenceEnabled,
        bootLoadComplete: dolphinJitBootLoadComplete,
        bootLoadedEntries: dolphinJitBootLoadedEntries,
        lazyFillStarted: dolphinJitLazyFillStarted,
        lazyFillActive: dolphinJitLazyFillActive,
        lazyFillCompleted: dolphinJitLazyFillCompleted,
        lazyFillSourceEntries: dolphinJitLazyFillSourceEntries,
        lazyFillProcessedEntries: dolphinJitLazyFillProcessedEntries,
        lazyFillAddedEntries: dolphinJitLazyFillAddedEntries,
        lazyFillTerminalReason: dolphinJitLazyFillTerminalReason,
        lazyFillFailureCount: dolphinJitLazyFillFailureCount,
        cacheSize: dolphinJitCacheMap.size,
        newCompileCount: dolphinJitNewCompileCount,
        verificationPending: dolphinJitVerificationPending.size,
        compilePending: dolphinJitCompilePending,
        idbWritesPending: dolphinJitIdbWritesPending,
        idbWriteCount: dolphinJitIdbWriteCount,
        pthreadWorkerCount: dolphinJitPthreadWorkers.length,
        pthreadBarrierGeneration: dolphinJitPthreadBarrierGeneration,
        pthreadBarrierExpected: dolphinJitPthreadBarrierExpected,
        pthreadBarrierAcked: dolphinJitPthreadBarrierAcked,
        pthreadRequiredWorkerCount: requiredWorkers.length,
        pthreadRequiredBarrierAcked: requiredBarrierAcked,
        pthreadInstallPostFailures: dolphinJitPthreadInstallPostFailures,
        pthreadBarrierInvalidAcks: dolphinJitPthreadBarrierInvalidAcks,
        observedAtMs: performance.now(),
      };
    }
    case "validationFinalizeWgpuRendererProbe": {
      if (api?.getCoreStateName?.() !== "Paused") {
        throw new Error("WGPU renderer probe finalization requires a paused core");
      }
      forceWgpuMappedDrainLifecycle(WGPU_MAPPED_DRAIN_FORCE_REASONS.FINALIZATION);
      const finalized = await finalizeWgpuUploadProbe(
        Math.max(1000, Math.min(30_000, Number(payload.timeoutMs) || 10_000))
      );
      return { ...finalized, ...framePayload({ forceCausalTelemetry: true }) };
    }
    case "validationFinalizeWgpuMappedDrain": {
      if (api?.getCoreStateName?.() !== "Paused") {
        throw new Error("WGPU mapped drain finalization requires a paused core");
      }
      const mappedDrainFinalization = await finalizeWgpuMappedDrain(
        Math.max(1000, Math.min(30_000, Number(payload.timeoutMs) || 10_000))
      );
      return {
        mappedDrainFinalization,
        ...framePayload({ forceCausalTelemetry: true }),
      };
    }
    case "validationFinalizeWgpuReplay": {
      if (api?.getCoreStateName?.() !== "Paused") {
        throw new Error("WGPU replay finalization requires a paused core");
      }
      const replayQuiescence = await finalizeWgpuReplayQuiescence(
        Math.max(1000, Math.min(30_000, Number(payload.timeoutMs) || 30_000)),
        { requireRing: Boolean(payload.requireRing) }
      );
      return {
        replayQuiescence,
        ...framePayload({ forceCausalTelemetry: true }),
      };
    }
    case "validationBeginWgpuRendererProbeMeasurement": {
      if (api?.getCoreStateName?.() !== "Paused") {
        throw new Error("WGPU renderer probe measurement boundary requires a paused core");
      }
      const begun = await beginWgpuUploadProbeMeasurement(
        Math.max(1000, Math.min(30_000, Number(payload.timeoutMs) || 10_000))
      );
      return { ...begun, ...framePayload({ forceCausalTelemetry: true }) };
    }
    case "rendererDiagnostics":
      return rendererDiagnosticsPayload();
    case "loadStateFile": {
      forceWgpuMappedDrainLifecycle(WGPU_MAPPED_DRAIN_FORCE_REASONS.LOAD);
      wgpuSparseUbo?.reset("save-state-load");
      if (wgpuUboComputeProjectionActive) {
        wgpuUboComputeProjection.reset("save-state-load");
      }
      wgpuUboComputeReconstruction?.reset("save-state-load");
      workletAudioProducer.transition();
      // Write the .sav bytes into the Emscripten FS, then ask the core
      // to State::LoadAs it. Dolphin save states are build/version
      // locked — a state from a different Dolphin will be rejected by
      // LoadAs's version check (logged, not a crash). We pump a few
      // frames so the loaded state actually renders.
      if (!api?.loadStateFile || !moduleInstance?.FS) {
        return { loaded: false, error: "no loadStateFile/FS" };
      }
      // payload.fsPath: load an existing FS file in place (e.g. the
      // one SaveStateFile just wrote) — proves a version-matched
      // round-trip with zero serving. Else write payload.bytes first.
      const path = payload.fsPath || "/savestate.sav";
      if (!payload.fsPath) {
        try {
          const bytes = payload.bytes instanceof Uint8Array
            ? payload.bytes
            : new Uint8Array(payload.bytes);
          moduleInstance.FS.writeFile(path, bytes);
        } catch (e) {
          return { loaded: false, error: `FS.writeFile: ${e?.message || e}` };
        }
      }
      collectWebGpuProducerStateStats();
      const uploadTimeoutCountBeforeLoad = webGpuCausalStats.uploadTimeoutCount;
      const loadRingBoundary = (wgpuReplayClassifier || wgpuLoadEpochFence)
        ? summarizeCurrentWgpuRing({ maxRecords: webGpuCmdRing?.capacity ?? 4096 })
        : null;
      const hasHeldReplay = webGpuCmdRing?.heldReplayStart != null ||
        (webGpuCmdRing?.stagedUploads?.size ?? 0) > 0;
      if (wgpuReplayClassifier) {
        wgpuReplayClassifierGeneration += 1;
        wgpuReplayClassifier = createWgpuReplayClassifier({
          scope: "load-state-file",
          generation: wgpuReplayClassifierGeneration
        });
        wgpuPresentCompletionProbeStarted = false;
        wgpuClassifierEfbReadbackPending = false;
        wgpuClassifierBackbufferReadbackPending = false;
        wgpuClassifierXfbReadbackPending = false;
        wgpuInputBackbufferReadbackPending = false;
        wgpuInputVisualBaselineReady = false;
        wgpuLastBackbufferSourceTextureId = 0;
        wgpuReplayClassifier.recordLoadBoundary(loadRingBoundary);
        wgpuLoadFenceActive = wgpuLoadEpochFence &&
          (loadRingBoundary.summary.openPassDepth > 0 || hasHeldReplay);
        wgpuReplayClassifier.recordLoadFence({ armed: wgpuLoadFenceActive });
      } else {
        wgpuLoadFenceActive = wgpuLoadEpochFence &&
          (loadRingBoundary?.summary?.openPassDepth > 0 || hasHeldReplay);
      }
      const beforeState = api?.getCoreStateName?.() ?? "";
      api?.setWebGpuUploadArenaMiB?.(wgpuUploadArenaMiB, collectMetrics ? 1 : 0);
      api?.setWebGpuProducerProfileEnabled?.(wgpuProducerProfileRequested ? 1 : 0);
      api?.setWebGpuDrawProfileEnabled?.(wgpuDrawProfileRequested ? 1 : 0);
      applyWgpuTailGate("save-state pre-load");
      api?.setWebGpuUboCacheEnabled?.(webGpuUboCacheMode());
      api?.setWebGpuUboPackEnabled?.(webGpuUboPackMode());
      api?.setWebGpuGeometryPackEnabled?.(wgpuGeometryPackEnabled ? 1 : 0);
      api?.setWebGpuGeometryRangeEnabled?.(wgpuGeometryRangeEnabled ? 1 : 0);
      let rc = 0;
      ppcWasmJitTimingSuspensions += 1;
      try {
        rc = api.loadStateFile(path) | 0;
        // LoadAs runs on the autonomous CPU pthread (RunFrame doesn't
        // step the core) — wait real wall-clock time so the restore
        // actually takes effect before we sample/screenshot.
        await new Promise((r) => setTimeout(r, 1200));
      } finally {
        resetPpcWasmJitTiming(rc === 1);
        ppcWasmJitTimingSuspensions -= 1;
      }
      api?.setWebGpuUploadArenaMiB?.(wgpuUploadArenaMiB, collectMetrics ? 1 : 0);
      api?.setWebGpuProducerProfileEnabled?.(wgpuProducerProfileRequested ? 1 : 0);
      api?.setWebGpuDrawProfileEnabled?.(wgpuDrawProfileRequested ? 1 : 0);
      applyWgpuTailGate("save-state reload");
      api?.setWebGpuUboCacheEnabled?.(webGpuUboCacheMode());
      api?.setWebGpuUboPackEnabled?.(webGpuUboPackMode());
      api?.setWebGpuGeometryPackEnabled?.(wgpuGeometryPackEnabled ? 1 : 0);
      api?.setWebGpuGeometryRangeEnabled?.(wgpuGeometryRangeEnabled ? 1 : 0);
      api?.setSoftwareTevHotCaseMode?.(softwareTevHotCaseMode);
      if (wgpuProducerProfileRequested || wgpuDrawProfileRequested) {
        verifyWgpuProducerProfileActivation("save-state reload");
      }
      collectWebGpuProducerStateStats();
      const uploadTimeoutCountImmediatelyAfterLoad = webGpuCausalStats.uploadTimeoutCount;
      const uploadTimeoutBoundaryVerified = rc === 1 && collectMetrics;
      if (uploadTimeoutBoundaryVerified) {
        webGpuCausalStats.uploadTimeoutBoundaryVerified = true;
        webGpuCausalStats.uploadTimeoutCountAtVerifiedLoad = uploadTimeoutCountBeforeLoad;
        webGpuCausalStats.uploadTimeoutCountBeforeVerifiedLoad = uploadTimeoutCountBeforeLoad;
        webGpuCausalStats.uploadTimeoutCountAfterVerifiedLoad = Math.max(
          0,
          uploadTimeoutCountImmediatelyAfterLoad - uploadTimeoutCountBeforeLoad
        );
      }
      // The fixed battle state is the measurement boundary. Clear boot/menu
      // tuples after the core's existing post-load settle, then let the
      // harness's later first sample act as the battle-settle baseline.
      if (rc === 1 && collectMetrics &&
          rendererDiagnostics.configuredVideoBackend === "Software Renderer") {
        api?.setSoftwareRasterProfileEnabled?.(0);
        api?.setSoftwareRasterProfileEnabled?.(1);
      }
      const afterState = api?.getCoreStateName?.() ?? "";
      // §27 diagnostic (JS-only, served live, no rebuild): open a
      // post-load watchdog window so drainWebGpuCmdRing logs whether
      // the producer ring keeps advancing (producer alive) vs the
      // consumer going stale, to localize the savestate-load desync.
      self._postLoadProbeT0 = Date.now();
      self._postLoadProbeUntil = self._postLoadProbeT0 + 35000;
      self._postLoadProbeLast = 0;
      console.log(`[loadStateFile] path=${path} rc=${rc} ` +
        `before='${beforeState}' after='${afterState}' ` +
        `frame=${api?.getFrame?.() ?? -1}`);
      return { loaded: rc === 1, rc, beforeState, afterState,
               wgpuUploadTimeoutBoundary: {
                 enabled: collectMetrics,
                 verified: uploadTimeoutBoundaryVerified,
                 beforeLoad: uploadTimeoutCountBeforeLoad,
                 immediatelyAfterLoad: uploadTimeoutCountImmediatelyAfterLoad,
                 afterLoadDelta: Math.max(
                   0,
                   uploadTimeoutCountImmediatelyAfterLoad - uploadTimeoutCountBeforeLoad
                 ),
               },
               ...framePayload() };
    }
    case "saveStateFile": {
      // SaveStateFile queues SaveToFileSync onto the autonomous Dolphin
      // CPU pthread (the discio worker's RunFrame does NOT step the
      // core — it's just a present tick). So we must WAIT real
      // wall-clock time for that pthread to run the job + write the
      // file; pumping runFrame did nothing and returned in <10 ms
      // (§24 size=0). handleMessage is async → await real timeouts so
      // the CPU/dump pthreads get scheduled.
      if (!api?.saveStateFile || !moduleInstance?.FS) {
        return { saved: false, error: "no saveStateFile/FS" };
      }
      const path = "/savestate_out.sav";
      try { moduleInstance.FS.unlink(path); } catch (e) {}
      const rc = api.saveStateFile(path) | 0;
      let prev = -1, stable = 0, size = 0;
      // up to ~8 s real time (40 × 200 ms); a Melee state is ~tens of
      // MB so allow generous time for DoState + zstd on the pthread.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const st = moduleInstance.FS.stat(path);
          size = st.size | 0;
          if (size > 0 && size === prev) { if (++stable >= 3) break; }
          else stable = 0;
          prev = size;
        } catch (e) { /* not written yet */ }
      }
      let bytes = null;
      try {
        if (size > 0) bytes = moduleInstance.FS.readFile(path); // Uint8Array
      } catch (e) {
        return { saved: false, rc, error: `readFile: ${e?.message || e}` };
      }
      console.log(`[saveStateFile] path=${path} rc=${rc} size=${size} ` +
        `frame=${api?.getFrame?.() ?? -1}`);
      const ab = bytes ? bytes.buffer.slice(bytes.byteOffset,
                                            bytes.byteOffset + bytes.byteLength)
                       : null;
      return ab
        ? { saved: true, rc, size, bytes: ab, transfer: [ab] }
        : { saved: false, rc, size, error: "empty/no state file" };
    }
    case "mixAudio": {
      const mixStartedAt = causalMetricsEnabled ? performance.now() : 0;
      const requested = Math.max(1, Math.min(4096, payload.frames | 0));
      if (!api?.mixAudio || !api?.audioBuffer || !moduleInstance?.HEAPU8) {
        recordWorkerAudioMix(requested, 0, causalMetricsEnabled ? performance.now() - mixStartedAt : 0);
        return {
          available: false,
          frames: 0,
          channels: 2,
          sampleRate: 48000,
          samples: null,
          stats: api?.getAudioStats?.() || "audio:unavailable"
        };
      }
      const channels = Math.max(1, Math.min(2, api.audioChannels?.() || 2));
      const sampleRate = Math.max(8000, api.audioSampleRate?.() || 48000);
      const maxFrames = Math.max(1, api.audioBufferFrames?.() || 4096);
      const mixed = Math.max(0, Math.min(maxFrames, api.mixAudio(requested) | 0));
      recordWorkerAudioMix(requested, mixed, causalMetricsEnabled ? performance.now() - mixStartedAt : 0);
      const pointer = api.audioBuffer();
      const samples =
        mixed > 0 && pointer
          ? new Int16Array(moduleInstance.HEAPU8.buffer, pointer, mixed * channels).slice()
          : null;
      return {
        available: mixed > 0,
        frames: mixed,
        channels,
        sampleRate,
        samples,
        stats: api.getAudioStats?.() || ""
      };
    }
    case "setAudioMuted":
      api?.setAudioMuted?.(payload.muted ? 1 : 0);
      workletAudioProducer.setMuted(Boolean(payload.muted));
      return {};
    case "configureAudioWorklet": {
      if (!payload.enabled) {
        workletAudioProducer.stop();
        return { active: false, reason: "disabled" };
      }
      const result = workletAudioProducer.install(payload.sab, {
        muted: Boolean(payload.muted),
      });
      if (result.active) api?.setAudioMuted?.(payload.muted ? 1 : 0);
      return result;
    }
    default:
      throw new Error(`Unknown upstream worker message: ${type}`);
  }
}

async function loadCore({
  coreUrl: nextCoreUrl = DEFAULT_UPSTREAM_CORE_URL,
  expectedCoreSha256 = DEFAULT_UPSTREAM_CORE_SHA256,
  canvas = null,
  videoBackend = "Software Renderer",
  cpuThread = false,
  cpuCore = "cached",
  ppcWasmJit = false,
  ppcWasmJitForce: requestedPpcWasmJitForce = false,
  ppcWasmJitTier: requestedPpcWasmJitTier = "guarded",
  ppcWasmJitWarmupFrames: requestedPpcWasmJitWarmupFrames = DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES,
  ppcProfile = false,
  cpuOverclock = 1,
  emulationSpeed = 1,
  presentationScale = 1,
  presentationQueueSize = DEFAULT_PRESENTATION_QUEUE,
  presentationPacing = "smooth",
  legacyTickQueue: requestedLegacyTickQueue = false,
  presenterBackend = "webgl",
  oglProxyMode = "proxy",
  oglTestClear = false,
  fastSoftwareRaster = 0,
  softwareTevHotCaseMode: requestedSoftwareTevHotCaseMode = 0,
  xfbFastPaths = 0,
  correctTimeDrift = false,
  coreLog = false,
  efbDiag = false,
  jitVerbose = false,
  frameCap = 0,
  cachedInterpreterDisableMask = 0,
  wgpuScissoredClearRect = true,
  noJitCache = false,
  reportedCoreSelection = null,
  wgpuReplayDiagnostics = false,
  wgpuDeepReplayDiagnostics: requestedWgpuDeepReplayDiagnostics = false,
  wgpuDetachedPresenter: requestedWgpuDetachedPresenter = false,
  wgpuLoadEpochFence: requestedWgpuLoadEpochFence = false,
  wgpuReplayPump: requestedWgpuReplayPump = false,
  wgpuReplayBudgetMs: requestedWgpuReplayBudgetMs = 0,
  wgpuPowerPreference: requestedWgpuPowerPreference = "high-performance",
  wgpuAtomicPassReplay: requestedWgpuAtomicPassReplay = true,
  wgpuDiagnosticQuiet: requestedWgpuDiagnosticQuiet = false,
  wgpuProducerProfile: requestedWgpuProducerProfile = false,
  wgpuDrawProfile: requestedWgpuDrawProfile = false,
  wgpuTailGate: requestedWgpuTailGate = false,
  wgpuStateCache: requestedWgpuStateCache = false,
  wgpuUboCache: requestedWgpuUboCache = false,
  wgpuUboMetrics: requestedWgpuUboMetrics = false,
  wgpuVpDiag: requestedWgpuVpDiag = false,
  wgpuUniformFast: requestedWgpuUniformFast = false,
  wgpuUboPack: requestedWgpuUboPack = false,
  wgpuSparseUbo: requestedWgpuSparseUbo = false,
  wgpuGeometryPack: requestedWgpuGeometryPack = false,
  wgpuGeometryRange: requestedWgpuGeometryRange = false,
  wgpuUploadArenaMiB: requestedWgpuUploadArenaMiB = 32,
  wgpuUploadTransport: requestedWgpuUploadTransport = "queue",
  wgpuMappedStagingSlotCount: requestedWgpuMappedStagingSlotCount =
    WGPU_MAPPED_STAGING_SLOT_COUNT,
  wgpuMappedStageFast: requestedWgpuMappedStageFast = false,
  wgpuMappedDrainCoalescing: requestedWgpuMappedDrainCoalescing = false,
  wgpuRendererWorkerProbe: requestedWgpuRendererWorkerProbe = "off",
  wgpuVisualCadence: requestedWgpuVisualCadence = false,
  wgpuPassPackageProjection: requestedWgpuPassPackageProjection = false,
  wgpuUploadRunProjection: requestedWgpuUploadRunProjection = false,
  wgpuUboComputeProjection: requestedWgpuUboComputeProjection = false,
  wgpuUboComputeReconstruction: requestedWgpuUboComputeReconstruction = false,
  wgpuOwnershipTrace: requestedWgpuOwnershipTrace = false,
  wgpuSemanticRuntime: requestedWgpuSemanticRuntime = false,
  oglSabEnabled = false
} = {}) {
  if (moduleInstance) {
    return moduleInstance;
  }
  rendererDiagnostics = createRendererDiagnostics();
  wgpuDiagnosticQuiet = Boolean(requestedWgpuDiagnosticQuiet);
  wgpuDiagnosticLogFilter.restore();
  wgpuDiagnosticLogFilter = installWgpuDiagnosticLogFilter({
    enabled: wgpuDiagnosticQuiet,
  });
  rendererDiagnostics.coreSelection = normalizedCoreSelection(
    reportedCoreSelection,
    nextCoreUrl,
    expectedCoreSha256
  );
  wgpuReplayClassifierGeneration += 1;
  wgpuReplayClassifier = wgpuReplayDiagnostics
    ? createWgpuReplayClassifier({
        scope: "core-load",
        generation: wgpuReplayClassifierGeneration
      })
    : null;
  wgpuPresentCompletionProbeStarted = false;
  wgpuClassifierEfbReadbackPending = false;
  wgpuClassifierBackbufferReadbackPending = false;
  wgpuClassifierXfbReadbackPending = false;
  wgpuInputBackbufferReadbackPending = false;
  wgpuInputVisualBaselineReady = false;
  wgpuLastBackbufferSourceTextureId = 0;
  wgpuAtomicPassReplay = Boolean(requestedWgpuAtomicPassReplay);
  if (requestedWgpuPassPackageProjection && !collectMetrics) {
    throw new Error("wgpupackageprojection=1 requires metrics=1");
  }
  if (requestedWgpuPassPackageProjection && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpupackageprojection=1 requires video=wgpu");
  }
  if (requestedWgpuUploadRunProjection && !collectMetrics) {
    throw new Error("wgpuuploadrunprojection=1 requires metrics=1");
  }
  if (requestedWgpuUploadRunProjection && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpuuploadrunprojection=1 requires video=wgpu");
  }
  if (requestedWgpuUploadRunProjection && requestedWgpuUploadTransport !== "mapped") {
    throw new Error("wgpuuploadrunprojection=1 requires wgpuuploadtransport=mapped");
  }
  if (requestedWgpuUboComputeProjection && !collectMetrics) {
    throw new Error("wgpuubocomputeprojection=1 requires metrics=1");
  }
  if (requestedWgpuUboComputeProjection && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpuubocomputeprojection=1 requires video=wgpu");
  }
  if (requestedWgpuUboComputeProjection && requestedWgpuUploadTransport !== "mapped") {
    throw new Error(
      "wgpuubocomputeprojection=1 requires wgpuuploadtransport=mapped"
    );
  }
  if (requestedWgpuUboComputeReconstruction && !collectMetrics) {
    throw new Error("wgpuubocompute=1 requires metrics=1");
  }
  if (requestedWgpuUboComputeReconstruction && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpuubocompute=1 requires video=wgpu");
  }
  if (requestedWgpuUboComputeReconstruction &&
      requestedWgpuUploadTransport !== "mapped") {
    throw new Error("wgpuubocompute=1 requires wgpuuploadtransport=mapped");
  }
  if (requestedWgpuOwnershipTrace && !collectMetrics) {
    throw new Error("wgpuownershiptrace=1 requires metrics=1");
  }
  if (requestedWgpuOwnershipTrace && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpuownershiptrace=1 requires video=wgpu");
  }
  if (requestedWgpuSemanticRuntime && !collectMetrics) {
    throw new Error("wgpusemantic=1 requires metrics=1");
  }
  if (requestedWgpuSemanticRuntime && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpusemantic=1 requires video=wgpu");
  }
  wgpuProducerProfileRequested = collectMetrics && Boolean(requestedWgpuProducerProfile);
  wgpuProducerProfileAvailable = false;
  wgpuDrawProfileRequested = Boolean(requestedWgpuDrawProfile);
  wgpuDrawProfileAvailable = false;
  webGpuCausalStats.producerProfile = {
    ...webGpuCausalStats.producerProfile,
    requested: wgpuProducerProfileRequested,
    available: false,
    enabled: false,
  };
  webGpuCausalStats.drawProfile = {
    ...webGpuCausalStats.drawProfile,
    requested: wgpuDrawProfileRequested,
    available: false,
    enabled: false,
  };
  if (wgpuDrawProfileRequested && !collectMetrics) {
    throw new Error("wgpudrawprofile=1 requires metrics=1");
  }
  if (wgpuDrawProfileRequested && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpudrawprofile=1 requires video=wgpu");
  }
  wgpuTailGateRequested = Boolean(requestedWgpuTailGate);
  wgpuTailGateAvailable = false;
  webGpuCausalStats.tailGate = {
    ...webGpuCausalStats.tailGate,
    schema: WGPU_TAIL_GATE_SCHEMA,
    requested: wgpuTailGateRequested,
    available: false,
    enabled: false,
  };
  if (wgpuTailGateRequested && !collectMetrics) {
    throw new Error("wgputailgate=1 requires metrics=1");
  }
  if (wgpuTailGateRequested && videoBackend !== "WebGPU-Real") {
    throw new Error("wgputailgate=1 requires the true hardware WebGPU backend");
  }
  wgpuStateCacheEnabled = Boolean(requestedWgpuStateCache);
  wgpuUboCacheEnabled = Boolean(requestedWgpuUboCache);
  if (requestedWgpuUboMetrics && !collectMetrics) {
    throw new Error("wgpuubometrics=1 requires metrics=1");
  }
  if (requestedWgpuUboMetrics && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpuubometrics=1 requires video=wgpu");
  }
  wgpuUboMetricsEnabled = collectMetrics && Boolean(requestedWgpuUboMetrics);
  // vpdiag starts finished, so every vpDiagNote* call is a single boolean
  // test until someone asks for the dump.
  vpDiagDone = !requestedWgpuVpDiag;
  if (requestedWgpuUniformFast && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpuuniformfast=1 requires video=wgpu");
  }
  wgpuUniformFastEnabled = Boolean(requestedWgpuUniformFast);
  wgpuUboPackEnabled = Boolean(requestedWgpuUboPack);
  if (requestedWgpuSparseUbo && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpuubosparse=1 requires video=wgpu");
  }
  wgpuGeometryPackEnabled = Boolean(requestedWgpuGeometryPack);
  wgpuGeometryRangeEnabled =
    wgpuGeometryPackEnabled && Boolean(requestedWgpuGeometryRange);
  wgpuUploadArenaMiB = Number(requestedWgpuUploadArenaMiB) === 64 ? 64 : 32;
  wgpuUploadTransport = requestedWgpuUploadTransport === "mapped" ? "mapped" : "queue";
  wgpuMappedStagingSlotCount = Number(requestedWgpuMappedStagingSlotCount) === 4
    ? 4
    : WGPU_MAPPED_STAGING_SLOT_COUNT;
  if (requestedWgpuSparseUbo && wgpuUploadTransport !== "mapped") {
    throw new Error("wgpuubosparse=1 requires wgpuuploadtransport=mapped");
  }
  wgpuSparseUboEnabled = Boolean(requestedWgpuSparseUbo);
  wgpuMappedStageFastEnabled =
    wgpuUploadTransport === "mapped" && Boolean(requestedWgpuMappedStageFast);
  wgpuMappedDrainCoalescingEnabled =
    wgpuUploadTransport === "mapped" && Boolean(requestedWgpuMappedDrainCoalescing);
  wgpuMappedDrainCoalescer = createWgpuMappedDrainCoalescer({
    enabled: wgpuMappedDrainCoalescingEnabled,
    generation: wgpuMappedStagingGeneration,
  });
  wgpuRendererWorkerProbe = new Set([
    "canary", "inline-upload", "worker-upload", "null-drain"
  ]).has(requestedWgpuRendererWorkerProbe) ? requestedWgpuRendererWorkerProbe : "off";
  if (requestedWgpuVisualCadence && videoBackend !== "WebGPU-Real") {
    throw new Error("wgpuvisual=1 requires video=wgpu");
  }
  destroyWgpuVisualCadenceResources();
  hardwareVideoBackend = videoBackend === "WebGPU-Real";
  wgpuVisualCadenceEnabled = Boolean(requestedWgpuVisualCadence);
  wgpuVisualCadenceTelemetry = createWgpuVisualCadenceTelemetry(
    wgpuVisualCadenceEnabled
  );
  wgpuVisualCadenceSequence = 0;
  wgpuMappedStagingPool?.invalidate("core reloaded");
  wgpuMappedStagingPool = null;
  wgpuSparseUbo?.reset("core-reload");
  wgpuSparseUbo = null;
  if (wgpuUboComputeProjectionActive) {
    wgpuUboComputeProjection.reset("core-reload");
  }
  wgpuUboComputeReconstruction = null;
  wgpuMappedRemapPromises = new Set();
  wgpuMappedCapacityBlocked = false;
  wgpuMappedCapacityBlockedAt = 0;
  wgpuMappedCapacityBlockedRole = WGPU_UPLOAD_ROLE.UNKNOWN;
  wgpuProducerStateCacheAvailable = false;
  wgpuConsumerStateCacheEnabled = false;
  wgpuPassStateCache = createWgpuPassStateCache();
  wgpuDeepReplayDiagnostics = Boolean(requestedWgpuDeepReplayDiagnostics);
  wgpuDetachedPresenter = Boolean(requestedWgpuDetachedPresenter);
  wgpuDetachedBitmapPending = false;
  wgpuLoadEpochFence = Boolean(requestedWgpuLoadEpochFence);
  wgpuLoadFenceActive = false;
  wgpuReplayPumpEnabled = Boolean(requestedWgpuReplayPump);
  wgpuReplayBudgetMs = [4, 6].includes(Number(requestedWgpuReplayBudgetMs))
    ? Number(requestedWgpuReplayBudgetMs)
    : 0;
  wgpuPowerPreference = requestedWgpuPowerPreference === "low-power"
    ? "low-power"
    : "high-performance";
  webGpuCausalStats.rendererWorkerProbe = {
    ...webGpuCausalStats.rendererWorkerProbe,
    requested: wgpuRendererWorkerProbe,
    active: false,
    passed: false,
    error: "",
  };
  if (wgpuRendererWorkerProbe === "canary") {
    try {
      await runWgpuRendererWorkerCanary();
    } catch (error) {
      webGpuCausalStats.rendererWorkerProbe.error = String(error?.message || error);
      throw error;
    }
  } else if (isIntentionalBlankWgpuProbe(wgpuRendererWorkerProbe)) {
    if (videoBackend !== "WebGPU-Real") {
      throw new Error("WGPU upload probes require the true hardware WebGPU backend");
    }
    try {
      await initializeWgpuUploadProbe(wgpuRendererWorkerProbe);
    } catch (error) {
      webGpuCausalStats.rendererWorkerProbe.error = String(error?.message || error);
      throw error;
    }
  }
  wgpuReplayYieldPending = false;
  webGpuCausalStats.replayBudgetEnabled = wgpuReplayBudgetMs > 0;
  webGpuCausalStats.replayBudgetMs = wgpuReplayBudgetMs;
  webGpuCausalStats.replayWindowRecords = WGPU_REPLAY_WINDOW_RECORDS;
  webGpuCausalStats.uploadTransport = wgpuUploadTransport;
  webGpuCausalStats.mappedStagingFastPath = wgpuMappedStageFastEnabled;
  webGpuCausalStats.mappedDrainCoalescingEnabled = wgpuMappedDrainCoalescingEnabled;
  rendererDiagnostics.requestedVideoBackend = videoBackend;
  softwareTevHotCaseMode = (Number(requestedSoftwareTevHotCaseMode) || 0) & 3;
  rendererDiagnostics.requestedPresenterBackend = normalizePresenterBackend(presenterBackend);
  oglSabEnabledForLoad = Boolean(oglSabEnabled);

  const normalizedOglProxyMode = normalizeOglProxyMode(oglProxyMode);
  // SAB mode behaves like readback (worker fills s_framebuffer via readback)
  // but pipes pixels via SAB+main-thread putImageData instead of running a
  // WebGPU presenter on a transferred OffscreenCanvas. So we force-enable
  // readback when SAB is on, regardless of the user's oglproxy choice.
  const readbackOgl =
    videoBackend === "OGL" && (normalizedOglProxyMode === "readback" || oglSabEnabledForLoad);
  // Detached mode: when no canvas was transferred but we're on the OGL
  // worker path, create a standalone OffscreenCanvas for the GL backend.
  // Standalone OCs aren't bound to any DOM element so commit/captureStream
  // problems don't apply. Worker reads back pixels per frame and posts an
  // ImageBitmap to the main thread, which paints the visible canvas via
  // drawImage. This is the architecture that works in the user's
  // environment when transferControlToOffscreen-based paths fail.
  const detachedOgl =
    videoBackend === "OGL" && !readbackOgl && !canvas && typeof OffscreenCanvas === "function";
  const detachedWgpu =
    videoBackend === "WebGPU-Real" && wgpuDetachedPresenter && !canvas &&
    typeof OffscreenCanvas === "function";
  detachedWgpuCanvas = detachedWgpu ? new OffscreenCanvas(640, 480) : null;
  let moduleCanvas;
  if (videoBackend === "OGL") {
    if (readbackOgl && typeof OffscreenCanvas === "function") {
      moduleCanvas = new OffscreenCanvas(320, 240);
    } else if (detachedOgl) {
      moduleCanvas = new OffscreenCanvas(640, 480);
      detachedOglCanvas = moduleCanvas;
    } else {
      moduleCanvas = canvas;
    }
  }
  if (moduleCanvas) {
    moduleCanvas.id = "canvas";
  }

  if (canvas) {
    canvas.id = "canvas";
    workerOwnsCanvas = true;
    postStatus(`Worker received canvas: ${canvas.constructor?.name || typeof canvas}`);
  } else if (detachedOgl) {
    postStatus("Worker DETACHED OGL: standalone OffscreenCanvas, frames posted via ImageBitmap");
  } else if (detachedWgpu) {
    postStatus("Worker DETACHED WGPU: standalone OffscreenCanvas, frames posted via ImageBitmap");
  } else {
    postStatus(`Worker received NO canvas (videoBackend=${videoBackend}, oglProxy=${normalizedOglProxyMode})`);
  }

  if (canvas && videoBackend === "OGL" && !readbackOgl) {
    renderCanvas = canvas;
    renderBackend = "ogl";
    rendererDiagnostics.activePresenterBackend = renderBackend;
    postStatus("Worker OGL path: canvas attached, awaiting WebGL2 context creation");
  } else if (detachedOgl) {
    renderCanvas = moduleCanvas;
    renderBackend = "ogl";
    rendererDiagnostics.activePresenterBackend = renderBackend;
    // Detached mode still "owns" a canvas (the standalone OffscreenCanvas);
    // it's just not the user's visible one. Without this, the presentation
    // loop never starts (it gates on workerOwnsCanvas) and presentFrame is
    // never called, so no frames flow through the pipeline.
    workerOwnsCanvas = true;
  } else if (oglSabEnabledForLoad && moduleCanvas) {
    // SAB pixel transport: the standalone moduleCanvas hosts the GL backend
    // and we publish pixels to main via the SAB. Same workerOwnsCanvas
    // promotion as detached mode — otherwise the presentation loop won't
    // start and we'll never call publishOglSabFrame.
    //
    // renderBackend = "ogl" is critical: it routes the presentation loop
    // through the OGL branch (which dedups on OGL-swap-count) instead of
    // the generic frameSignal branch (which dedups on coreFrame). OGL
    // bypasses XFB, so coreFrame doesn't tick per visible swap, and the
    // dedup would reject every paint except the first — pthread reports
    // 1000s of swaps but the visible canvas only updates once.
    renderCanvas = moduleCanvas;
    renderBackend = "ogl";
    rendererDiagnostics.activePresenterBackend = renderBackend;
    workerOwnsCanvas = true;
    postStatus("Worker SAB OGL: standalone OffscreenCanvas, pixels via SharedArrayBuffer");
  } else if (detachedWgpu) {
    workerOwnsCanvas = true;
  }

  if (isIntentionalBlankWgpuProbe(wgpuRendererWorkerProbe)) {
    renderCanvas = null;
    renderBackend = "wgpu-upload-probe";
    rendererDiagnostics.activePresenterBackend = renderBackend;
    cmdRingOwnsCanvas = true;
    postStatus(`WGPU ${wgpuRendererWorkerProbe} probe active (blank output)`);
  } else if (canvas && (videoBackend !== "OGL" || readbackOgl)) {
    preferredPresenterBackend = normalizePresenterBackend(presenterBackend);
    await setupSoftwarePresenter(canvas, preferredPresenterBackend);
  } else if (detachedWgpuCanvas) {
    preferredPresenterBackend = "webgpu";
    await setupSoftwarePresenter(detachedWgpuCanvas, preferredPresenterBackend);
  }

  // §28cf boot-phase timing instrumentation. Attributes the ~1s page-load
  // freeze measured in §28cd. Each step's wall time is postStatus'd so the
  // validator's console-log capture surfaces the breakdown without a rebuild.
  const _bootT0 = performance.now();
  const _bootMark = (label) => {
    const dt = performance.now() - _bootT0;
    console.log(`[boot-phase] ${label} t=${dt.toFixed(1)}ms`);
  };
  _bootMark("loadCore-entry");
  coreUrl = new URL(nextCoreUrl, self.location.href).href;
  // Pre-fetch the wasm binary so we can both (a) hand it to Emscripten via
  // wasmBinary (skips its internal fetch) and (b) fingerprint it for the
  // JIT-cache cross-build invalidation. Single localhost fetch instead of
  // a double-fetch + extra hash pass.
  const _t_fetch = performance.now();
  const { wasmBinary, fingerprint: buildFingerprint } =
      await fetchWasmAndFingerprint(coreUrl, expectedCoreSha256);
  console.log(`[boot-phase] fetchWasmAndFingerprint took ${(performance.now() - _t_fetch).toFixed(1)}ms (${(wasmBinary.byteLength / 1048576).toFixed(2)}MiB)`);
  const _t_import = performance.now();
  const imported = await import(coreUrl);
  console.log(`[boot-phase] import(coreUrl) took ${(performance.now() - _t_import).toFixed(1)}ms`);
  const factory = imported.default ?? imported.createDolphinCore ?? self.createDolphinCore;

  if (typeof factory !== "function") {
    throw new Error("Upstream Dolphin bundle did not expose createDolphinCore");
  }
  // Reconcile IDB cache against this build's fingerprint before we touch
  // the cache map. If the build changed since the previous session, clear
  // the stale modules so we don't carry forward dead entries forever.
  // ?nojitcache=1: skip the IndexedDB JIT-cache entirely (no reconcile, no
  // boot-time mass re-instantiation of thousands of cached WebAssembly
  // Modules, no persistence). Deterministic isolation/mitigation for the
  // renderer OOM — the JIT just recompiles fresh this session.
  // §28cg prebuilt cache pre-warm. Reconcile identity first so legacy,
  // missing-metadata, or stale rows are cleared before a prebuilt file can
  // seed the v3 store. Newly seeded rows then use the same verified load path.
  // First-session cold starts get the same warm-cache treatment as session 2+,
  // killing the menu-nav interpret stall measured in §28bz/§28cf.
  const _t_idb = performance.now();
  dolphinJitCachePersistenceEnabled = !noJitCache;
  dolphinJitBootLoadComplete = false;
  dolphinJitBootLoadedEntries = 0;
  if (!noJitCache) {
    await reconcileJitCacheWithBuild(buildFingerprint);
  } else {
    postStatus("jit-cache: DISABLED via ?nojitcache=1 (no IDB load/persist)");
  }
  console.log(`[boot-phase] reconcileJitCacheWithBuild took ${(performance.now() - _t_idb).toFixed(1)}ms (cache size now ${dolphinJitCacheMap.size})`);
  if (!noJitCache && buildFingerprint) {
    const _t_prebuilt = performance.now();
    const seeded = await maybeSeedIdbFromPrebuiltCache(coreUrl, buildFingerprint);
    if (seeded > 0) {
      const loaded = await loadDolphinJitCacheFromIdb(dolphinJitIdb);
      if (loaded >= DOLPHIN_JIT_PREWARM_THRESHOLD) dolphinJitCachePreWarmed = true;
    }
    console.log(`[boot-phase] prebuilt-jit-cache seed took ${(performance.now() - _t_prebuilt).toFixed(1)}ms (seeded ${seeded} new IDB entries)`);
  }
  dolphinJitBootLoadedEntries = dolphinJitCacheMap.size;
  dolphinJitBootLoadComplete = true;

  // Day-15 (wasm-dolphin) WebGPU video backend: when the user selects
  // `?video=webgpu`, the existing WebGPU presenter (createWebGpuPresenter)
  // has already acquired a WGPUDevice and configured the canvas context.
  // Hand that same device to Emscripten via `preinitializedWebGPUDevice`
  // so the C++ side can pull it with `emscripten_webgpu_get_device()` and
  // reuse the existing context rather than acquiring a second device.
  const preinitializedWebGPUDevice =
    (videoBackend === "WebGPU" || videoBackend === "WebGPU-Real") && renderGpu
      ? renderGpu.device
      : undefined;

  const _t_factory = performance.now();
  moduleInstance = await factory({
    noInitialRun: true,
    canvas: videoBackend === "OGL" ? moduleCanvas || undefined : undefined,
    wasmBinary,
    // worker_owned_webgl must be true for any OGL run. The C++ side gates
    // its worker-context path, the InitBackendInfo probe-skip, and per-Swap
    // commit-frame handling on this flag. With it false, the standard
    // emscripten_webgl_create_context path produces a degenerate proxied
    // context (debug_bits=3, no GLctx) whose draw calls silently drop —
    // GP fifo stays empty and the visible canvas stays black.
    dolphinOglWorkerWebGl: videoBackend === "OGL",
    dolphinOglReadbackPresent: readbackOgl,
    dolphinOglTestClear: Boolean(oglTestClear),
    dolphinFastSoftwareRaster: Math.min(3, Math.max(0, Number(fastSoftwareRaster) || 0)),
    dolphinXfbFastPaths: (Number(xfbFastPaths) || 0) & 3,
    // Read by dolphin_web_core.cpp at CoreInit. Both are opt-in and default
    // false, so the shipping page load is unchanged.
    dolphinCorrectTimeDrift: Boolean(correctTimeDrift),
    dolphinCoreLog: Boolean(coreLog),
    // Ranks the instructions that block JIT compilation (?jitverbose=1).
    dolphinWebVerbosePpcJit: Boolean(jitVerbose),
    dolphinFrameCap: (frameCapTarget = Number(frameCap) || 0),
    dolphinEfbDiag: (DIAG_EFB_TO_CANVAS =
      (String(efbDiag) === "2" ? 2 : (efbDiag ? 1 : 0))),
    preinitializedWebGPUDevice,
    locateFile: (path) => new URL(path, coreUrl).href,
    print: (message) => postStatus(message),
    printErr: (message) => {
      const text = String(message || "");
      rendererDiagnostics.emscriptenPrintErr.push(text.slice(0, 1000));
      if (rendererDiagnostics.emscriptenPrintErr.length > 64) {
        rendererDiagnostics.emscriptenPrintErr.shift();
      }
      if (/webgpu[^\n]*validation/i.test(text)) {
        recordRendererError("validation", `Emscripten printErr: ${text}`);
      }
      postStatus(text);
    },
    onAbort: (reason) => {
      recordRendererError("emscripten-abort", reason);
      postStatus(`Emscripten abort: ${reason}`);
    }
  });

  console.log(`[boot-phase] factory({wasmBinary}) Emscripten init took ${(performance.now() - _t_factory).toFixed(1)}ms`);

  // Day-16: `?video=webgpu` runs the Software→WebGPU-presenter hybrid.
  // The C++ Software path writes XFB into s_framebuffer; the existing
  // JS WebGPU presenter uploads + blits those bytes via a real
  // wgpuRenderPass. Plays Melee end-to-end today.
  if (videoBackend === "WebGPU" && renderGpu) {
    postStatus("WebGPU video backend: Software→WebGPU presenter hybrid (day-16)");
  }
  // Day-17: `?video=wgpu` activates the real WebGPU video backend in
  // C++. No Software bridge. WebGPUGfx drives the canvas directly via
  // wgpu API calls. Early phases: clear-colour or partial frames while
  // pipeline pieces (textures, shaders, draw calls) come online.
  if (videoBackend === "WebGPU-Real" && renderGpu) {
    postStatus("WebGPU video backend: real C++ render path active (day-17, under construction)");
  }

  api = bindApi(moduleInstance);
  const ownershipTraceSetterAvailable = Boolean(
    api.setWebGpuOwnershipTraceEnabled &&
    api.getWebGpuOwnershipTracePtr &&
    api.getWebGpuOwnershipTraceCapacity
  );
  wgpuOwnershipTrace.configure({
    requested: wgpuOwnershipTraceRequested,
    active: wgpuOwnershipTraceActive,
    setterAvailable: ownershipTraceSetterAvailable,
    setterInvoked: wgpuOwnershipTraceActive && ownershipTraceSetterAvailable,
  });
  if (wgpuOwnershipTraceRequested && !ownershipTraceSetterAvailable) {
    throw new Error(
      "wgpuownershiptrace=1 requires ownership trace setter and descriptor getters"
    );
  }
  if (wgpuSemanticRuntimeActive &&
      !api.acknowledgeWebGpuOwnershipTraceCapture) {
    throw new Error(
      "wgpusemantic=1 requires AcknowledgeWebGpuOwnershipTraceCapture"
    );
  }
  api.setWgpuDeepDiagnosticsEnabled?.(wgpuDeepReplayDiagnostics ? 1 : 0);
  wgpuProducerProfileAvailable = Boolean(
    api.setWebGpuProducerProfileEnabled && api.getWebGpuStateCacheStats
  );
  wgpuDrawProfileAvailable = Boolean(
    api.setWebGpuDrawProfileEnabled && api.getWebGpuStateCacheStats
  );
  webGpuCausalStats.producerProfile.available = wgpuProducerProfileAvailable;
  webGpuCausalStats.drawProfile.available = wgpuDrawProfileAvailable;
  if (wgpuProducerProfileRequested && !wgpuProducerProfileAvailable) {
    throw new Error(
      "wgpuprodprofile=1 requires SetWebGpuProducerProfileEnabled and " +
      "GetWebGpuStateCacheStats exports"
    );
  }
  if (wgpuDrawProfileRequested && !wgpuDrawProfileAvailable) {
    throw new Error(
      "wgpudrawprofile=1 requires SetWebGpuDrawProfileEnabled and " +
      "GetWebGpuStateCacheStats exports"
    );
  }
  wgpuTailGateAvailable = Boolean(
    api.setWgpuIdleFifoTailElisionEnabled && api.getWebGpuStateCacheStats
  );
  webGpuCausalStats.tailGate.available = wgpuTailGateAvailable;
  if (wgpuTailGateRequested && !wgpuTailGateAvailable) {
    throw new Error(
      "wgputailgate=1 requires SetWgpuIdleFifoTailElisionEnabled and " +
      "GetWebGpuStateCacheStats exports"
    );
  }
  wgpuProducerStateCacheAvailable = Boolean(api.setWebGpuStateCacheEnabled);
  // The producer and consumer see the same ordered SET_* stream. Once the
  // producer suppresses exact repeats, comparing every remaining record again
  // in JS only adds work. Keep the JS cache as a compatibility fallback for a
  // core that predates the producer export.
  wgpuConsumerStateCacheEnabled =
    wgpuStateCacheEnabled && !wgpuProducerStateCacheAvailable;
  // Renderer transport is required even when persistent JIT caching is not.
  // ?nojitcache=1 gates only the optional cache channel below.
  await installDolphinPthreadChannels(moduleInstance, {
    jitCacheEnabled: !noJitCache
  });
  if (wgpuOwnershipTraceActive) {
    const heap = moduleInstance?.HEAPU8;
    if (!heap || !(heap.buffer instanceof SharedArrayBuffer)) {
      throw new Error("wgpuownershiptrace=1 requires a shared wasm heap");
    }
    const initialConsumerResetAttestation = wgpuSemanticRuntimeActive
      ? captureInitialWgpuConsumerResetAttestation({
          resourceMaps: webGpuObjects,
          videoBackend,
          renderDeviceReady: Boolean(renderGpu?.device),
          capturedBeforeTraceAttach: true,
          commandRingRegistered: Boolean(webGpuCmdRing),
          commandsProcessed: webGpuCausalStats.commandsProcessed,
          canvasOwnedByCommandRing: cmdRingOwnsCanvas,
          replayFatal: wgpuReplayFatal,
        })
      : null;
    attachWgpuOwnershipTraceFromApi(
      wgpuOwnershipTrace,
      api,
      heap.buffer
    );
    wgpuSemanticRuntime = createWgpuSemanticRuntime({
      requested: wgpuSemanticRuntimeRequested,
      active: wgpuSemanticRuntimeActive,
      initialConsumerResetAttestation,
    });
  } else {
    api.setWebGpuOwnershipTraceEnabled?.(0);
    wgpuSemanticRuntime = createWgpuSemanticRuntime({
      requested: wgpuSemanticRuntimeRequested,
      active: false,
    });
  }
  if (api.setVideoBackend) {
    api.setVideoBackend(videoBackend);
    rendererDiagnostics.configuredVideoBackend = videoBackend;
    rendererDiagnostics.videoBackendEvidence = "SetVideoBackend invoked; waiting for accepted Dolphin boot";
  } else {
    rendererDiagnostics.videoBackendEvidence = "SetVideoBackend export unavailable";
  }
  api.setCpuThread?.(Boolean(cpuThread));
  api.setCpuCore?.(cpuCore);
  ppcWasmJitRequested = Boolean(ppcWasmJit);
  ppcWasmJitForce = Boolean(requestedPpcWasmJitForce);
  ppcWasmJitActive = false;
  ppcWasmJitDisabledForSession = false;
  ppcWasmJitCooldownUntilFrame = 0;
  ppcWasmJitEnabledAtFrame = 0;
  ppcWasmJitCorePaused = false;
  ppcWasmJitTimingSuspensions = 0;
  resetPpcWasmJitTiming(true);
  ppcWasmJitTier = requestedPpcWasmJitTier === "mixed" ? "mixed" : "guarded";
  ppcWasmJitWarmupFrames = normalizePpcWasmJitWarmupFrames(requestedPpcWasmJitWarmupFrames);
  console.log(`[s28-jittier] worker init: requested=${JSON.stringify(requestedPpcWasmJitTier)} ` +
    `→ resolved ppcWasmJitTier=${ppcWasmJitTier} (engage will call ` +
    `setPpcWasmJitEnabled(${ppcWasmJitTier === "mixed" ? 2 : 1}))`);
  api.setPpcWasmJitEnabled?.(0);
  api.setPpcProfileEnabled?.(ppcProfile ? 1 : 0);
  api.setWebGpuUploadArenaMiB?.(wgpuUploadArenaMiB, collectMetrics ? 1 : 0);
  api.setWebGpuProducerProfileEnabled?.(wgpuProducerProfileRequested ? 1 : 0);
  api.setWebGpuDrawProfileEnabled?.(wgpuDrawProfileRequested ? 1 : 0);
  applyWgpuTailGate("core boot");
  api.setWebGpuStateCacheEnabled?.(wgpuStateCacheEnabled ? 1 : 0);
  api.setWebGpuUboCacheEnabled?.(webGpuUboCacheMode());
  api.setWebGpuUboPackEnabled?.(webGpuUboPackMode());
  api.setWebGpuGeometryPackEnabled?.(wgpuGeometryPackEnabled ? 1 : 0);
  api.setWebGpuGeometryRangeEnabled?.(wgpuGeometryRangeEnabled ? 1 : 0);
  api.setCpuOverclock?.(Number(cpuOverclock));
  api.setEmulationSpeed?.(Number(emulationSpeed));
  api.setPresentationScale?.(Number(presentationScale));
  api.setFastSoftwareRaster?.(Math.min(3, Math.max(0, Number(fastSoftwareRaster) || 0)));
  api.setSoftwareTevHotCaseMode?.(softwareTevHotCaseMode);
  api.setXfbFastPaths?.((Number(xfbFastPaths) || 0) & 3);
  api.setSoftwareRasterProfileEnabled?.(
    collectMetrics && videoBackend === "Software Renderer" ? 1 : 0
  );
  if (wgpuProducerProfileRequested || wgpuDrawProfileRequested)
    verifyWgpuProducerProfileActivation("core boot");
  // Renderer capabilities are their own mask, separate from the CPU disable
  // mask below. The backend defaults every bit ON, so a call is only strictly
  // needed to turn something OFF for bisection -- but it is issued
  // unconditionally so the active configuration is visible in the status log
  // rather than implied.
  const RENDERER_FEATURE_SCISSORED_CLEAR_RECT = 1 << 0;
  let rendererFeatureMask = RENDERER_FEATURE_SCISSORED_CLEAR_RECT;
  if (!wgpuScissoredClearRect) {
    rendererFeatureMask =
      (rendererFeatureMask & ~RENDERER_FEATURE_SCISSORED_CLEAR_RECT) >>> 0;
  }

  // Cores built before the capability existed read the ClearRect enable out of
  // the cached-interpreter disable mask instead, at bit 24, defaulting to off.
  // Host and core are versioned independently -- a stale cached core, a
  // half-finished rebuild -- and getting this wrong is not a degraded feature
  // but a black Mario Kart Wii, so fall back rather than assume they match.
  const LEGACY_DISABLE_BIT_CLEARRECT_ENABLE = 1 << 24;
  let disableMask = (Number(cachedInterpreterDisableMask) || 0) >>> 0;
  const rendererMaskSupported = Boolean(api.setRendererFeatureMask);
  if (!rendererMaskSupported && wgpuScissoredClearRect) {
    disableMask = (disableMask | LEGACY_DISABLE_BIT_CLEARRECT_ENABLE) >>> 0;
  }

  if (disableMask !== 0 && api.setCachedInterpreterDisableMask) {
    api.setCachedInterpreterDisableMask(disableMask);
    postStatus(`CachedInterpreter disable mask = 0x${disableMask.toString(16)}`);
  }
  if (rendererMaskSupported) {
    api.setRendererFeatureMask(rendererFeatureMask);
    postStatus(`Renderer feature mask = 0x${rendererFeatureMask.toString(16)}`);
  } else {
    postStatus(
      `Renderer feature mask unsupported by this core; ClearRect via legacy bit 24 ` +
      `(${wgpuScissoredClearRect ? "on" : "off"})`
    );
  }
  startFrameRingDrainLoop();
  configurePresentationQueue(presentationQueueSize);
  if (presentationPacing === "tick") presentationPacingMode = "tick";
  else if (presentationPacing === "direct") presentationPacingMode = "direct";
  else presentationPacingMode = "smooth";
  legacyTickQueue = Boolean(requestedLegacyTickQueue);
  const _t_coreinit = performance.now();
  api.coreInit?.();
  console.log(`[boot-phase] api.coreInit() took ${(performance.now() - _t_coreinit).toFixed(1)}ms`);
  startPresentationLoop();

  if (!resolveWorkerFs(moduleInstance)) {
    throw new Error("Upstream Dolphin bundle was not built with WORKERFS");
  }
  _bootMark("loadCore-return");
  return moduleInstance;
}

// WORKERFS lookup, with a fallback that current Emscripten requires.
//
// Emscripten registers a filesystem into FS.filesystems only when its JS
// library was linked, and it decides that from an internal library_map in
// tools/link.py. That map has no entry for workerfs.js or nodefs.js any more,
// so `-lworkerfs.js` in the vendored CMake is accepted, silently mapped to
// nothing, and FS.filesystems comes out as {MEMFS} alone. Naming WORKERFS in
// EXPORTED_RUNTIME_METHODS still publishes the same filesystem object on the
// Module, so prefer FS.filesystems (older cores, including the committed one)
// and fall back to the Module export (cores built with current Emscripten).
//
// Without this, a freshly built core boots, runs frames and engages the JIT
// but throws before loadCore returns, so no disc ever mounts.
function resolveWorkerFs(moduleInstance) {
  return moduleInstance?.FS?.filesystems?.WORKERFS ?? moduleInstance?.WORKERFS ?? null;
}

function bindApi(module) {
  const cwrap = module.cwrap.bind(module);
  const ccall = module.ccall.bind(module);
  const optionalCwrap = (name, returnType, argTypes = []) =>
    typeof module[`_${name}`] === "function" ? cwrap(name, returnType, argTypes) : null;

  return {
    mountDisc: (path) => ccall("MountDisc", "number", ["string"], [path]),
    coreInit: optionalCwrap("CoreInit", "number", []),
    setVideoBackend:
      typeof module._SetVideoBackend === "function"
        ? (backend) => ccall("SetVideoBackend", "number", ["string"], [backend])
        : null,
    setCpuThread:
      typeof module._SetCpuThread === "function"
        ? (enabled) => ccall("SetCpuThread", "number", ["number"], [enabled ? 1 : 0])
        : null,
    setCpuCore:
      typeof module._SetCpuCore === "function"
        ? (core) => ccall("SetCpuCore", "number", ["string"], [core])
        : null,
    setPpcWasmJitEnabled:
      typeof module._SetPpcWasmJitEnabled === "function"
        ? (enabled) =>
            // §28bi: pass the integer tier through. `enabled ? 1 : 0`
            // boolean-coerced it, collapsing 2 (mixed) → 1 (guarded),
            // so the core's `s_wasm_jit_direct_only = enabled < 2` was
            // ALWAYS true ⇒ the mixed tier has been structurally
            // impossible. 0=off, 1=guarded, 2=mixed.
            ccall("SetPpcWasmJitEnabled", null, ["number"], [enabled | 0])
        : null,
    setPpcProfileEnabled:
      typeof module._SetPpcProfileEnabled === "function"
        ? (enabled) => ccall("SetPpcProfileEnabled", null, ["number"], [enabled ? 1 : 0])
        : null,
    setWebGpuStateCacheEnabled:
      typeof module._SetWebGpuStateCacheEnabled === "function"
        ? (enabled) => ccall("SetWebGpuStateCacheEnabled", null, ["number"], [enabled ? 1 : 0])
        : null,
    setWebGpuProducerProfileEnabled:
      typeof module._SetWebGpuProducerProfileEnabled === "function"
        ? (enabled) => ccall(
            "SetWebGpuProducerProfileEnabled", null, ["number"], [enabled ? 1 : 0]
          )
        : null,
    setWebGpuDrawProfileEnabled:
      typeof module._SetWebGpuDrawProfileEnabled === "function"
        ? (enabled) => ccall(
            "SetWebGpuDrawProfileEnabled", null, ["number"], [enabled ? 1 : 0]
          )
        : null,
    setWebGpuOwnershipTraceEnabled:
      typeof module._SetWebGpuOwnershipTraceEnabled === "function"
        ? (enabled) => ccall(
            "SetWebGpuOwnershipTraceEnabled", null, ["number"], [enabled ? 1 : 0]
          )
        : null,
    acknowledgeWebGpuOwnershipTraceCapture:
      typeof module._AcknowledgeWebGpuOwnershipTraceCapture === "function"
        ? (captureId) => ccall(
            "AcknowledgeWebGpuOwnershipTraceCapture",
            "number",
            ["number"],
            [captureId >>> 0]
          ) !== 0
        : null,
    getWebGpuOwnershipTracePtr:
      typeof module._GetWebGpuOwnershipTracePtr === "function"
        ? () => ccall("GetWebGpuOwnershipTracePtr", "number", [], []) >>> 0
        : null,
    getWebGpuOwnershipTraceCapacity:
      typeof module._GetWebGpuOwnershipTraceCapacity === "function"
        ? () => ccall("GetWebGpuOwnershipTraceCapacity", "number", [], []) >>> 0
        : null,
    setWgpuDeepDiagnosticsEnabled:
      typeof module._SetWgpuDeepDiagnosticsEnabled === "function"
        ? (enabled) => ccall(
            "SetWgpuDeepDiagnosticsEnabled", null, ["number"], [enabled ? 1 : 0]
          )
        : null,
    setWgpuIdleFifoTailElisionEnabled:
      typeof module._SetWgpuIdleFifoTailElisionEnabled === "function"
        ? (enabled) => ccall(
            "SetWgpuIdleFifoTailElisionEnabled", null, ["number"], [enabled ? 1 : 0]
          )
        : null,
    setWebGpuUboCacheEnabled:
      typeof module._SetWebGpuUboCacheEnabled === "function"
        ? (mode) => ccall("SetWebGpuUboCacheEnabled", null, ["number"], [mode | 0])
        : null,
    setWebGpuUboPackEnabled:
      typeof module._SetWebGpuUboPackEnabled === "function"
        ? (enabled) => ccall("SetWebGpuUboPackEnabled", null, ["number"], [enabled ? 1 : 0])
        : null,
    setWebGpuGeometryPackEnabled:
      typeof module._SetWebGpuGeometryPackEnabled === "function"
        ? (enabled) => ccall("SetWebGpuGeometryPackEnabled", null, ["number"], [enabled ? 1 : 0])
        : null,
    setWebGpuGeometryRangeEnabled:
      typeof module._SetWebGpuGeometryRangeEnabled === "function"
        ? (enabled) => ccall("SetWebGpuGeometryRangeEnabled", null, ["number"], [enabled ? 1 : 0])
        : null,
    setWebGpuUploadArenaMiB:
      typeof module._SetWebGpuUploadArenaMiB === "function"
        ? (mib, metrics) => ccall(
            "SetWebGpuUploadArenaMiB",
            null,
            ["number", "number"],
            [Number(mib) === 64 ? 64 : 32, metrics ? 1 : 0]
          )
        : null,
    getWebGpuStateCacheStats: optionalCwrap("GetWebGpuStateCacheStats", "string", []),
    setCpuOverclock:
      typeof module._SetCpuOverclock === "function"
        ? (factor) => ccall("SetCpuOverclock", "number", ["number"], [Number(factor) || 1])
        : null,
    setEmulationSpeed:
      typeof module._SetEmulationSpeed === "function"
        ? (factor) => ccall("SetEmulationSpeed", "number", ["number"], [Number(factor)])
        : null,
    setPresentationScale:
      typeof module._SetPresentationScale === "function"
        ? (scale) => ccall("SetPresentationScale", "number", ["number"], [Number(scale)])
        : null,
    setFastSoftwareRaster:
      typeof module._SetFastSoftwareRaster === "function"
        ? (mode) => ccall("SetFastSoftwareRaster", "number", ["number"], [mode | 0])
        : null,
    setSoftwareTevHotCaseMode:
      typeof module._SetSoftwareTevHotCaseMode === "function"
        ? (mode) => ccall("SetSoftwareTevHotCaseMode", "number", ["number"], [mode | 0])
        : null,
    setXfbFastPaths:
      typeof module._SetXfbFastPaths === "function"
        ? (flags) => ccall("SetXfbFastPaths", "number", ["number"], [flags | 0])
        : null,
    setSoftwareRasterProfileEnabled:
      typeof module._SetSoftwareRasterProfileEnabled === "function"
        ? (enabled) => ccall("SetSoftwareRasterProfileEnabled", "number", ["number"], [enabled ? 1 : 0])
        : null,
    setRendererFeatureMask:
      typeof module._SetRendererFeatureMask === "function"
        ? (mask) =>
            ccall("SetRendererFeatureMask", "number", ["number"], [(mask >>> 0)])
        : null,
    getRendererFeatureMask:
      typeof module._GetRendererFeatureMask === "function"
        ? () => ccall("GetRendererFeatureMask", "number", [], []) >>> 0
        : null,
    setCachedInterpreterDisableMask:
      typeof module._SetCachedInterpreterDisableMask === "function"
        ? (mask) =>
            ccall("SetCachedInterpreterDisableMask", "number", ["number"], [(mask >>> 0)])
        : null,
    getCachedInterpreterDisableMask:
      typeof module._GetCachedInterpreterDisableMask === "function"
        ? () => ccall("GetCachedInterpreterDisableMask", "number", [], []) >>> 0
        : null,
    getFrameRingEntryPtr:
      typeof module._GetFrameRingEntryPtr === "function"
        ? () => ccall("GetFrameRingEntryPtr", "number", [], []) >>> 0
        : null,
    getFrameRingCapacity:
      typeof module._GetFrameRingCapacity === "function"
        ? () => ccall("GetFrameRingCapacity", "number", [], []) | 0
        : null,
    getFrameRingEntrySize:
      typeof module._GetFrameRingEntrySize === "function"
        ? () => ccall("GetFrameRingEntrySize", "number", [], []) | 0
        : null,
    getFrameRingHead:
      typeof module._GetFrameRingHead === "function"
        ? () => ccall("GetFrameRingHead", "number", [], []) >>> 0
        : null,
    bootDisc:
      typeof module._BootDisc === "function"
        ? (path) => ccall("BootDisc", "number", ["string"], [path])
        : null,
    stopCore: optionalCwrap("StopCore", null, []),
    setCorePaused: optionalCwrap("SetCorePaused", "number", ["number"]),
    pumpHostJobs: optionalCwrap("PumpHostJobs", null, []),
    getCoreState: optionalCwrap("GetCoreState", "number", []),
    getCoreStateName: optionalCwrap("GetCoreStateName", "string", []),
    getCoreStatus: optionalCwrap("GetCoreStatus", "string", []),
    getCoreTitle: optionalCwrap("GetCoreTitle", "string", []),
    getCoreTicksLow: optionalCwrap("GetCoreTicksLow", "number", []),
    getCoreTicksHigh: optionalCwrap("GetCoreTicksHigh", "number", []),
    getCoreTicksPerSecond: optionalCwrap("GetCoreTicksPerSecond", "number", []),
    getPpcPc: optionalCwrap("GetPPCPC", "number", []),
    getLastLoadedCoreTicksLow: optionalCwrap("GetLastLoadedCoreTicksLow", "number", []),
    getLastLoadedCoreTicksHigh: optionalCwrap("GetLastLoadedCoreTicksHigh", "number", []),
    getLastLoadedPpcPc: optionalCwrap("GetLastLoadedPPCPC", "number", []),
    getLastLoadedCheckpointGeneration: optionalCwrap(
      "GetLastLoadedCheckpointGeneration",
      "number",
      []
    ),
    getCpuCoreName: optionalCwrap("GetCPUCoreName", "string", []),
    getPpcWasmBlockCompileCount: optionalCwrap("GetPpcWasmBlockCompileCount", "number", []),
    getPpcWasmBlockRunCount: optionalCwrap("GetPpcWasmBlockRunCount", "number", []),
    getPpcWasmHelperStats: optionalCwrap("GetPpcWasmHelperStats", "string", []),
    getPpcProfileStats: optionalCwrap("GetPpcProfileStats", "string", []),
    getVideoStats: optionalCwrap("GetVideoStats", "string", []),
    reset: cwrap("Reset", null, []),
    setInputMask: cwrap("SetInputMask", null, ["number"]),
    setInputState:
      typeof module._SetInputState === "function"
        ? (state) =>
            ccall(
              "SetInputState",
              null,
              ["number", "number", "number", "number", "number", "number", "number", "number", "number", "number"],
              [
                state.mask >>> 0,
                state.stickX | 0,
                state.stickY | 0,
                state.cStickX | 0,
                state.cStickY | 0,
                state.triggerLeft | 0,
                state.triggerRight | 0,
                state.analogA | 0,
                state.analogB | 0,
                state.inputGeneration >>> 0
              ]
            )
        : null,
    runFrame: cwrap("RunFrame", null, []),
    frameWidth: cwrap("FrameWidth", "number", []),
    frameHeight: cwrap("FrameHeight", "number", []),
    frameBuffer: cwrap("FrameBuffer", "number", []),
    saveState: cwrap("SaveState", "number", ["number"]),
    loadState: cwrap("LoadState", "number", ["number"]),
    loadStateFile: optionalCwrap("LoadStateFile", "number", ["string"]),
    saveStateFile: optionalCwrap("SaveStateFile", "number", ["string"]),
    getFrame: cwrap("GetFrame", "number", []),
    getFrameSignalPtr: optionalCwrap("GetFrameSignalPtr", "number", []),
    getGameId: cwrap("GetGameId", "string", []),
    getGameTitle: cwrap("GetGameTitle", "string", []),
    getMakerId: cwrap("GetMakerId", "string", []),
    getPlatform: cwrap("GetPlatform", "string", []),
    getRegion: cwrap("GetRegion", "string", []),
    getDiscNumber: cwrap("GetDiscNumber", "number", []),
    getApploaderDate: cwrap("GetApploaderDate", "string", []),
    getApploaderSize: cwrap("GetApploaderSize", "number", []),
    getBootDolOffset: cwrap("GetBootDolOffset", "number", []),
    getBootDolSize: cwrap("GetBootDolSize", "number", []),
    getFstOffset: cwrap("GetFstOffset", "number", []),
    getFstSize: cwrap("GetFstSize", "number", []),
    getRawSize: cwrap("GetRawSize", "number", []),
    getDataSize: cwrap("GetDataSize", "number", []),
    getRootEntryCount: cwrap("GetRootEntryCount", "number", []),
    getRootEntryName: cwrap("GetRootEntryName", "string", ["number"]),
    getRootEntryPath: cwrap("GetRootEntryPath", "string", ["number"]),
    getRootEntryIsDirectory: cwrap("GetRootEntryIsDirectory", "number", ["number"]),
    getRootEntryOffset: cwrap("GetRootEntryOffset", "number", ["number"]),
    getRootEntrySize: cwrap("GetRootEntrySize", "number", ["number"]),
    readDisc: cwrap("ReadDisc", "number", ["number", "number", "number"]),
    audioSampleRate: optionalCwrap("AudioSampleRate", "number", []),
    audioChannels: optionalCwrap("AudioChannels", "number", []),
    audioBufferFrames: optionalCwrap("AudioBufferFrames", "number", []),
    audioBuffer: optionalCwrap("AudioBuffer", "number", []),
    mixAudio: optionalCwrap("MixAudio", "number", ["number"]),
    setAudioMuted: optionalCwrap("SetAudioMuted", "number", ["number"]),
    getAudioStats: optionalCwrap("GetAudioStats", "string", [])
  };
}

async function mountFile(file) {
  if (!moduleInstance) {
    throw new Error("Upstream core must be loaded before mounting a disc");
  }

  if (!file) {
    throw new Error("No disc file was provided to the upstream worker");
  }

  const fs = moduleInstance.FS;
  const safeName = sanitizeDiscFileName(file.name);
  const path = `${WORKERFS_MOUNT_DIR}/${safeName}`;

  try {
    fs.mkdir(WORKERFS_MOUNT_DIR);
  } catch {
    // Mount point may already exist.
  }

  if (mounted) {
    fs.unmount(WORKERFS_MOUNT_DIR);
    mounted = false;
  }

  const _t_workerfs = performance.now();
  fs.mount(resolveWorkerFs(moduleInstance), { blobs: [{ name: safeName, data: file }] }, WORKERFS_MOUNT_DIR);
  mounted = true;
  console.log(`[boot-phase] fs.mount(WORKERFS) took ${(performance.now() - _t_workerfs).toFixed(1)}ms (${(file.size / 1048576).toFixed(1)}MiB image)`);

  const _t_mount = performance.now();
  const accepted = api.mountDisc(path);
  console.log(`[boot-phase] api.mountDisc() took ${(performance.now() - _t_mount).toFixed(1)}ms`);
  if (!accepted) {
    throw new Error("Upstream Dolphin DiscIO rejected the selected disc");
  }

  coreBoot = {
    attempted: false,
    accepted: false,
    path,
    skippedReason: ""
  };
  frameQueue = [];
  resetPresentationBuffer();
  lastCapturedCoreFrame = -1;
  lastPresentedCoreFrame = -1;
  lastPresentedAt = 0;
  presentedFrame = 0;

  if (api.bootDisc && file.size >= MIN_FULL_BOOT_BYTES) {
    coreBoot.attempted = true;
    const _t_boot = performance.now();
    coreBoot.accepted = Boolean(api.bootDisc(path));
    if (coreBoot.accepted) {
      rendererDiagnostics.activeVideoBackend = rendererDiagnostics.configuredVideoBackend || "unknown";
      rendererDiagnostics.videoBackendEvidence = "SetVideoBackend invoked and BootDisc accepted";
    }
    console.log(`[boot-phase] api.bootDisc() took ${(performance.now() - _t_boot).toFixed(1)}ms`);
    const _t_pump = performance.now();
    api.pumpHostJobs?.();
    console.log(`[boot-phase] api.pumpHostJobs() took ${(performance.now() - _t_pump).toFixed(1)}ms`);
  } else if (api.bootDisc) {
    coreBoot.skippedReason = `Disc image is too small for full CPU boot (${file.size} bytes)`;
  }

  const metadata = metadataPayload();
  return {
    ...metadata,
    bootProbe: bootProbePayload(metadata),
    path,
    ...framePayload()
  };
}

function configurePresentationQueue(size) {
  const requested = Number(size);
  presentationQueueLimit = Number.isFinite(requested)
    ? Math.round(Math.min(MAX_PRESENTATION_QUEUE, Math.max(MIN_PRESENTATION_QUEUE, requested)))
    : DEFAULT_PRESENTATION_QUEUE;
  presentationQueueTarget = 1;
}

function resetPresentationBuffer() {
  pacedPresentationPrimed = false;
  pacedPresentationStartedAt = performance.now();
  presentationFps = 0;
  presentationRawFps = 0;
  presentationAverageIntervalMs = 0;
  presentationP95IntervalMs = 0;
  presentationMaxIntervalMs = 0;
  presentationLongFrameCount = 0;
  visualChangeFps = 0;
  visualFrameHash = 0;
  lastVisualFrameHash = 0;
  lastOglSwapCount = 0;
  oglGlError = 0;
  visualSampleSource = wgpuVisualCadenceEnabled
    ? wgpuVisualCadenceTelemetry.source
    : "none";
  visualChangesSincePresentationFps = 0;
  framesSincePresentationFps = 0;
  intervalSumSincePresentationFps = 0;
  intervalSamplesSincePresentationFps = [];
  maxIntervalSincePresentationFps = 0;
  longFramesSincePresentationFps = 0;
  lastPresentationFpsTime = performance.now();
  presentationUnderrunCount = 0;
  presentationDroppedFrameCount = 0;
  presentationUnderrunsSinceFps = 0;
  presentationDropsSinceFps = 0;
  presentationWindowUnderrunCount = 0;
  presentationWindowDropCount = 0;
  presentationFrameLag = 0;
  presentationQueueAgeMs = 0;
  presentationQueueAgeTotalMs = 0;
  presentationQueueAgeSamples = 0;
  presentationQueueAgeMaxMs = 0;
  presentationQueueDepthHighWater = 0;
  immediateFreshFrameCount = 0;
  queuedFreshFrameCount = 0;
  tickRepaintCount = 0;
}

function readDetailedCoreStat(name, readStat) {
  if (!collectMetrics || typeof readStat !== "function") {
    return null;
  }

  const counter = `${name}Calls`;
  if (counter in metricsDiagnostics) {
    metricsDiagnostics[counter] += 1;
  }
  return readStat();
}

function applyWgpuProducerProfileStats(profile) {
  if (!profile) return false;
  webGpuCausalStats.producerProfile = {
    ...profile,
    requested: wgpuProducerProfileRequested,
    available: wgpuProducerProfileAvailable,
  };
  return true;
}

function applyWgpuDrawProfileStats(profile) {
  if (!profile) return false;
  webGpuCausalStats.drawProfile = {
    ...profile,
    requested: wgpuDrawProfileRequested,
    available: wgpuDrawProfileAvailable,
  };
  return true;
}

function verifyWgpuProducerProfileActivation(scope) {
  const text = api?.getWebGpuStateCacheStats?.() ?? "";
  const profile = parseWgpuProducerProfileStats(text);
  const drawProfile = parseWgpuDrawProfileStats(text);
  const drawProfileValid = !wgpuDrawProfileRequested && !wgpuDrawProfileAvailable ||
    applyWgpuDrawProfileStats(drawProfile) &&
      drawProfile.enabled === wgpuDrawProfileRequested;
  if (!applyWgpuProducerProfileStats(profile) ||
      profile.enabled !== wgpuProducerProfileRequested ||
      !drawProfileValid) {
    throw new Error(`WGPU producer/draw profile failed to activate during ${scope}`);
  }
  return profile;
}

function applyWgpuTailGate(scope) {
  api?.setWgpuIdleFifoTailElisionEnabled?.(wgpuTailGateRequested ? 1 : 0);
  if (!wgpuTailGateRequested) return null;
  const text = api?.getWebGpuStateCacheStats?.() ?? "";
  const stats = parseWgpuTailGateStats(text);
  if (!stats || stats.enabled !== true) {
    throw new Error(`WGPU idle FIFO tail elision failed to activate during ${scope}`);
  }
  webGpuCausalStats.tailGate = {
    ...stats,
    requested: true,
    available: wgpuTailGateAvailable,
  };
  return stats;
}

function collectWebGpuProducerStateStats() {
  if (!collectMetrics) return null;
  const text = api?.getWebGpuStateCacheStats?.() ?? null;
  const parsed = parseWgpuProducerStateStats(text);
  applyWgpuProducerProfileStats(parseWgpuProducerProfileStats(text));
  applyWgpuDrawProfileStats(parseWgpuDrawProfileStats(text));
  const tailGate = parseWgpuTailGateStats(text);
  if (tailGate) {
    webGpuCausalStats.tailGate = {
      ...tailGate,
      requested: wgpuTailGateRequested,
      available: wgpuTailGateAvailable,
    };
  }
  if (parsed) {
    webGpuCausalStats.producerStateCacheEnabled = parsed.enabled;
    webGpuCausalStats.producerPipelineRecordsSuppressed =
      parsed.pipelineRecordsSuppressed;
    webGpuCausalStats.producerBindGroupRecordsSuppressed =
      parsed.bindGroupRecordsSuppressed;
    webGpuCausalStats.producerVertexBufferRecordsSuppressed =
      parsed.vertexBufferRecordsSuppressed;
    webGpuCausalStats.producerIndexBufferRecordsSuppressed =
      parsed.indexBufferRecordsSuppressed;
    webGpuCausalStats.commandDroppedCount = parsed.commandDroppedCount;
    webGpuCausalStats.batchAbortCount = parsed.batchAbortCount;
    webGpuCausalStats.batchOversizeCount = parsed.batchOversizeCount;
    webGpuCausalStats.uploadTimeoutCount = parsed.uploadTimeoutCount;
    if (webGpuCausalStats.uploadTimeoutBoundaryVerified) {
      webGpuCausalStats.uploadTimeoutCountAfterVerifiedLoad = Math.max(
        0,
        parsed.uploadTimeoutCount - webGpuCausalStats.uploadTimeoutCountAtVerifiedLoad
      );
    }
    webGpuCausalStats.producerUboCacheEnabled = parsed.uboCacheEnabled;
    webGpuCausalStats.producerUniformFastEnabled = parsed.uniformFastEnabled;
    webGpuCausalStats.producerUboPackEnabled = parsed.uboPackEnabled;
    webGpuCausalStats.producerUboCacheMetricsEnabled = parsed.uboCacheMetricsEnabled;
    webGpuCausalStats.producerUboCacheClassOrder = parsed.uboCacheClassOrder;
    webGpuCausalStats.producerUboCacheLookups = parsed.uboCacheLookups;
    webGpuCausalStats.producerUboCacheHits = parsed.uboCacheHits;
    webGpuCausalStats.producerUboCacheExpired = parsed.uboCacheExpired;
    webGpuCausalStats.producerUboUploadCallsSuppressed =
      parsed.uboUploadCallsSuppressed;
    webGpuCausalStats.producerUboUploadBytesSuppressed =
      parsed.uboUploadBytesSuppressed;
    webGpuCausalStats.producerUboChangeMaskHistogram = parsed.uboChangeMaskHistogram;
    webGpuCausalStats.producerUboPacketEligibleCount = parsed.uboPacketEligibleCount;
    webGpuCausalStats.producerUboPacketTheoreticalCallsRemoved =
      parsed.uboPacketTheoreticalCallsRemoved;
    webGpuCausalStats.producerUboPacketPayloadBytes = parsed.uboPacketPayloadBytes;
    webGpuCausalStats.producerUboPacketAlignedBytes = parsed.uboPacketAlignedBytes;
    webGpuCausalStats.producerUboPrepareCpuCalls = parsed.uboPrepareCpuCalls;
    webGpuCausalStats.producerUboPrepareCpuNs = parsed.uboPrepareCpuNs;
    webGpuCausalStats.producerUboChangeClassOrder = parsed.uboChangeClassOrder;
    webGpuCausalStats.producerUboChangeSchemaVersion = parsed.uboChangeSchemaVersion;
    webGpuCausalStats.producerUboChangeAvailable = parsed.uboChangeAvailable;
    webGpuCausalStats.producerUboChangeEnabled = parsed.uboChangeEnabled;
    webGpuCausalStats.producerUboChangeEpoch = parsed.uboChangeEpoch;
    webGpuCausalStats.producerUboChangeUploadCalls = parsed.uboChangeUploadCalls;
    webGpuCausalStats.producerUboChangeFullBytes = parsed.uboChangeFullBytes;
    webGpuCausalStats.producerUboChangedBytes = parsed.uboChangedBytes;
    webGpuCausalStats.producerUboChangeBaselineFullCount =
      parsed.uboChangeBaselineFullCount;
    webGpuCausalStats.producerUboChangeBaselineFullBytes =
      parsed.uboChangeBaselineFullBytes;
    webGpuCausalStats.producerUboDirty16Bytes = parsed.uboDirty16Bytes;
    webGpuCausalStats.producerUboDirty16Ranges = parsed.uboDirty16Ranges;
    webGpuCausalStats.producerUboDirty256Bytes = parsed.uboDirty256Bytes;
    webGpuCausalStats.producerUboDirty256Ranges = parsed.uboDirty256Ranges;
    webGpuCausalStats.producerUniformFastClassOrder = parsed.uniformFastClassOrder;
    webGpuCausalStats.producerUniformFastSkippedComparisons =
      parsed.uniformFastSkippedComparisons;
    webGpuCausalStats.producerUniformFastKeptComparisons =
      parsed.uniformFastKeptComparisons;
    webGpuCausalStats.producerUniformFastChangedComparisons =
      parsed.uniformFastChangedComparisons;
    webGpuCausalStats.producerGeometryPackEnabled = parsed.geometryPackEnabled;
    webGpuCausalStats.producerGeometryPackEpoch = parsed.geometryPackEpoch;
    webGpuCausalStats.producerUploadArenaRequestedBytes = parsed.uploadArenaRequestedBytes;
    webGpuCausalStats.producerUploadArenaConfiguredBytes = parsed.uploadArenaConfiguredBytes;
    webGpuCausalStats.producerUploadArenaFallbackCount = parsed.uploadArenaFallbackCount;
    webGpuCausalStats.producerUploadArenaLateRejectCount = parsed.uploadArenaLateRejectCount;
    webGpuCausalStats.producerUploadArenaWrapCount = parsed.uploadArenaWrapCount;
    webGpuCausalStats.producerUploadArenaInflightHighWaterBytes =
      parsed.uploadArenaInflightHighWaterBytes;
    webGpuCausalStats.producerRingWaitCount = parsed.ringWaitCount;
    webGpuCausalStats.producerRingWaitTotalUs = parsed.ringWaitTotalUs;
    webGpuCausalStats.producerRingWaitMaxUs = parsed.ringWaitMaxUs;
    webGpuCausalStats.producerUploadWaitCount = parsed.uploadWaitCount;
    webGpuCausalStats.producerUploadWaitTotalUs = parsed.uploadWaitTotalUs;
    webGpuCausalStats.producerUploadWaitMaxUs = parsed.uploadWaitMaxUs;
  }
  return text;
}

function metadataPayload() {
  const rootEntryCount = api?.getRootEntryCount() ?? -1;
  const loadedCheckpoint = readLastLoadedCheckpoint();
  const helperStats = readDetailedCoreStat("helperStats", api?.getPpcWasmHelperStats);
  const profileStats = readDetailedCoreStat("profileStats", api?.getPpcProfileStats);
  const webGpuStateCacheStats = collectWebGpuProducerStateStats();
  const videoStats = api?.getVideoStats?.();
  return {
    width: api?.frameWidth() ?? 320,
    height: api?.frameHeight() ?? 240,
    frame: api?.getFrame() ?? 0,
    gameId: api?.getGameId() ?? "",
    title: api?.getGameTitle() ?? "",
    makerId: api?.getMakerId() ?? "",
    platform: api?.getPlatform() ?? "",
    region: api?.getRegion() ?? "",
    discNumber: api?.getDiscNumber() ?? -1,
    apploaderDate: api?.getApploaderDate() ?? "",
    apploaderSize: api?.getApploaderSize() ?? -1,
    bootDolOffset: api?.getBootDolOffset() ?? -1,
    bootDolSize: api?.getBootDolSize() ?? -1,
    fstOffset: api?.getFstOffset() ?? -1,
    fstSize: api?.getFstSize() ?? -1,
    rawSize: api?.getRawSize() ?? -1,
    dataSize: api?.getDataSize() ?? -1,
    rootEntryCount,
    rootEntries: readRootEntries(rootEntryCount),
    fullCore: Boolean(api?.bootDisc),
    coreBoot,
    coreState: api?.getCoreState?.() ?? -1,
    coreStateName: api?.getCoreStateName?.() ?? "",
    coreStatus: api?.getCoreStatus?.() ?? "",
    coreTitle: api?.getCoreTitle?.() ?? "",
    coreTicks: readCoreTicks(),
    coreTicksPerSecond: readCoreTicksPerSecond(),
    ppcPc: api?.getPpcPc?.() ?? 0,
    loadedCheckpointGeneration: loadedCheckpoint.generation,
    loadedCheckpointTicks: loadedCheckpoint.ticks,
    loadedCheckpointPpcPc: loadedCheckpoint.ppcPc,
    cpuCoreName: api?.getCpuCoreName?.() ?? "",
    ppcWasmBlockCompileCount: api?.getPpcWasmBlockCompileCount?.() ?? 0,
    ppcWasmBlockRunCount: api?.getPpcWasmBlockRunCount?.() ?? 0,
    ppcWasmHelperStats: joinedStats(
      helperStats,
      videoStats,
      profileStats,
      webGpuStateCacheStats,
      `metrics:${collectMetrics ? "on" : "off"}`
    )
  };
}

function bootProbePayload(metadata) {
  const milestones = [];

  if (!api || !moduleInstance || !metadata.gameId) {
    return {
      attempted: false,
      status: "blocked",
      blocker: "No mounted disc",
      milestones
    };
  }

  milestones.push(`Disc mounted: ${metadata.gameId}`);

  if (metadata.bootDolOffset < 0 || metadata.bootDolSize < 0) {
    return {
      attempted: true,
      status: "blocked",
      blocker: "Boot DOL location is unavailable",
      milestones
    };
  }

  milestones.push(`Boot DOL located at ${formatHex(metadata.bootDolOffset)}`);

  try {
    const headerBytes = readDiscBytes(metadata.bootDolOffset, Math.min(0x100, metadata.bootDolSize));
    const dol = parseDolHeader(headerBytes);
    milestones.push(`Boot DOL entry parsed: ${formatHex(dol.entryPoint)}`);
    milestones.push(`${dol.loadSections.length} DOL load sections discovered`);

    if (metadata.fullCore) {
      milestones.push(`Dolphin core state: ${metadata.coreStateName || "unknown"}`);

      if (!coreBoot.attempted && coreBoot.skippedReason) {
        return {
          attempted: true,
          status: "blocked",
          blocker: coreBoot.skippedReason,
          milestones,
          dol,
          coreState: metadata.coreState,
          coreStateName: metadata.coreStateName,
          coreStatus: metadata.coreStatus,
          coreTitle: metadata.coreTitle
        };
      }

      return {
        attempted: true,
        status: coreBoot.accepted ? "boot-submitted" : "blocked",
        blocker: coreBoot.accepted
          ? "Dolphin core boot was submitted; waiting for rendered frames and controller input"
          : metadata.coreStatus || "Dolphin core rejected the boot request",
        milestones,
        dol,
        coreState: metadata.coreState,
        coreStateName: metadata.coreStateName,
        coreStatus: metadata.coreStatus,
        coreTitle: metadata.coreTitle
      };
    }

    return {
      attempted: true,
      status: "blocked",
      blocker: "PowerPC CPU, memory map, and scheduler are not integrated yet",
      milestones,
      dol
    };
  } catch (error) {
    return {
      attempted: true,
      status: "failed",
      blocker: error instanceof Error ? error.message : String(error),
      milestones
    };
  }
}

function readDiscBytes(offset, length) {
  const pointer = moduleInstance._malloc(length);

  if (!pointer) {
    throw new Error("Unable to allocate DOL read buffer");
  }

  try {
    const read = api.readDisc(offset, length, pointer);
    if (read <= 0) {
      throw new Error("Unable to read boot DOL bytes");
    }

    return moduleInstance.HEAPU8.slice(pointer, pointer + read);
  } finally {
    moduleInstance._free(pointer);
  }
}

function readRootEntries(rootEntryCount) {
  if (!api || rootEntryCount <= 0) {
    return [];
  }

  const limit = Math.min(rootEntryCount, 256);
  const entries = [];

  for (let index = 0; index < limit; index += 1) {
    entries.push({
      name: api.getRootEntryName(index),
      path: api.getRootEntryPath(index),
      directory: Boolean(api.getRootEntryIsDirectory(index)),
      offset: api.getRootEntryOffset(index),
      size: api.getRootEntrySize(index)
    });
  }

  return entries;
}

function framePayload({ forceCausalTelemetry = false } = {}) {
  if (!moduleInstance || !api) {
    return { frameBuffer: null };
  }

  maybeEnablePpcWasmJit();
  const jitState = !ppcWasmJitRequested
    ? "off"
    : ppcWasmJitDisabledForSession
      ? "disabled"
      : ppcWasmJitActive
        ? "on"
        : "warmup";

  const width = api.frameWidth();
  const height = api.frameHeight();
  const pointer = api.frameBuffer();
  const length = width * height * 4;
  const ppcWasmHelperStats = readDetailedCoreStat("helperStats", api?.getPpcWasmHelperStats);
  const ppcProfileStats = readDetailedCoreStat("profileStats", api?.getPpcProfileStats);
  const webGpuStateCacheStats = collectWebGpuProducerStateStats();
  const videoStats = api.getVideoStats?.();
  const loadedCheckpoint = readLastLoadedCheckpoint();
  if (renderBackend === "ogl") {
    // The videoStats `hash:` field is computed in DolphinWeb_OnXfb /
    // DolphinWeb_OnGlBackbuffer, not in DolphinWeb_OnOglSwap. For the OGL
    // path, OnXfb is bypassed (the GL backend draws straight to the canvas)
    // so the hash field is frozen on a stale snapshot from before OGL took
    // over. The OGL swap count, however, increments once per
    // DolphinWeb_OnOglSwap and is the only authoritative measure of frames
    // actually committed to the WebGL canvas. Prefer real pixel-readback
    // when available, otherwise count OGL swaps explicitly.
    const oglStats = parseOglSwapStats(videoStats);
    if (oglStats.readbackRgba) {
      recordVisualFrameHash(oglStats.readbackRgba);
      visualSampleSource = "ogl-readback";
    } else if (oglStats.swap > 0) {
      recordOglSwapDelta(oglStats.swap);
      visualSampleSource = "ogl-swap";
    } else {
      recordVisualFrameHash(parseVideoFrameHash(videoStats));
      visualSampleSource = "xfb-hash";
    }
    oglGlError = oglStats.glError;
  } else if (!wgpuVisualCadenceEnabled) {
    // The hardware WebGPU path never reaches DolphinWeb_OnXfb, so there is no
    // XFB hash to read here — saying "xfb-hash" claimed a measurement that was
    // not taken, and visualChangeFps stayed 0 forever. Only the software
    // presenters actually hash an XFB.
    visualSampleSource = hardwareVideoBackend ? "unsampled" : "xfb-hash";
  }
  const causalTelemetry = maybeCreateCausalTelemetry(videoStats, { force: forceCausalTelemetry });
  let frameBuffer = null;
  let transfer = [];

  if ((renderContext || renderGpu || renderGl) && !presentationLoopActive) {
    presentFrame(width, height, pointer, length);
  } else if (!workerOwnsCanvas) {
    const frameBytes = moduleInstance.HEAPU8.slice(pointer, pointer + length);
    frameBuffer = frameBytes.buffer;
    transfer = [frameBytes.buffer];
  }

  return {
    width,
    height,
    frame: api.getFrame(),
    coreTicks: readCoreTicks(),
    coreTicksPerSecond: readCoreTicksPerSecond(),
    ppcPc: api.getPpcPc?.() ?? 0,
    loadedCheckpointGeneration: loadedCheckpoint.generation,
    loadedCheckpointTicks: loadedCheckpoint.ticks,
    loadedCheckpointPpcPc: loadedCheckpoint.ppcPc,
    cpuCoreName: api.getCpuCoreName?.() ?? "",
    ppcWasmBlockCompileCount: api.getPpcWasmBlockCompileCount?.() ?? 0,
    ppcWasmBlockRunCount: api.getPpcWasmBlockRunCount?.() ?? 0,
    ppcWasmHelperStats: joinedStats(
      ppcWasmHelperStats,
      videoStats,
      ppcProfileStats,
      webGpuStateCacheStats,
      `metrics:${collectMetrics ? "on" : "off"}`,
      `jit:${jitState} warm:${ppcWasmJitWarmupFrames} present ${renderBackend} signal:${frameSignalHeap ? "wait" : "poll"} mode:${presentationPacingMode} delivery:${freshFrameDeliveryForPacing(presentationPacingMode, legacyTickQueue)} legacytickqueue:${legacyTickQueue ? 1 : 0} fps:${presentationFps} raw:${presentationRawFps} loop:${presentationLoopFps} gap:${presentationP95IntervalMs}/${presentationMaxIntervalMs}ms long:${presentationLongFrameCount} queue:${frameQueue.length}/${presentationQueueLimit} qmax:${presentationQueueDepthHighWater} qage:${presentationQueueAgeMs.toFixed(1)}/${presentationQueueAgeMaxMs.toFixed(1)}ms fresh:${immediateFreshFrameCount}/${queuedFreshFrameCount} tickpaint:${tickRepaintCount} underrun:${presentationWindowUnderrunCount} drop:${presentationWindowDropCount} frames:${presentedFrame} visualfps:${visualChangeFps} visualsrc:${visualSampleSource} wd:${watchdogRecoveryCount}/${watchdogFireCount}` +
      // §28v: extra on-screen telemetry for the user's screenshots —
      // JIT cache size/new-compiles (compile-burst visibility) +
      // WebGPU executor draw/miss/skip counters (render-health: is
      // geometry flowing into the EFB, are pipes/bind-groups missing,
      // are draws being poison-guard-skipped).
      ` jitc:${dolphinJitCacheMap.size}/${dolphinJitNewCompileCount}` +
      ` wgx:d${webGpuExecStats.drawIdx}/mp${webGpuExecStats.missPipe}` +
      `/mb${webGpuExecStats.missBg}/sk${webGpuExecStats.skipDraw}`
    ),
    frameProfileStats,
    presentedFrame,
    presentationFps,
    presentationRawFps,
    presentationAverageIntervalMs,
    presentationP95IntervalMs,
    presentationMaxIntervalMs,
    presentationLongFrameCount,
    // Lifetime smoothness fields (never reset). presentationMaxIntervalMs
    // above resets every 500 ms window; presentationLifetimeMaxIntervalMs
    // here is the worst single gap across the whole run.
    presentationLifetimeMaxIntervalMs,
    presentationLifetimeMaxIntervalAtMs,
    presentationLifetimeDropCount,
    presentationLifetimeFrameCount,
    presentationIntervalStddevMs:
      presentationIntervalCount > 1
        ? Math.sqrt(presentationIntervalM2 / (presentationIntervalCount - 1))
        : 0,
    presentationIntervalHistogram: Array.from(presentationIntervalHistogram),
    presentationIntervalHistogramBuckets: PRESENTATION_HISTOGRAM_BUCKETS_MS,
    presentationFrameLag,
    presentationQueueAgeMs,
    visualChangeFps,
    visualFrameHash,
    visualSampleSource,
    visualCadenceTelemetry: wgpuVisualCadenceSnapshot(),
    oglGlError,
    frameBuffer,
    transfer,
    ...(causalTelemetry ? { causalTelemetry } : {})
  };
}

function maybeCreateCausalTelemetry(videoStats, { force = false } = {}) {
  if (!causalMetricsEnabled) return null;
  const now = performance.now();
  if (
    !force &&
    lastCausalTelemetryAt > 0 &&
    now - lastCausalTelemetryAt < CAUSAL_TELEMETRY_INTERVAL_MS
  ) {
    return null;
  }
  lastCausalTelemetryAt = now;
  if (wgpuOwnershipTraceActive) drainWgpuSemanticOwnership();
  const loadedCheckpoint = readLastLoadedCheckpoint();
  const uploadAttributionSnapshot = wgpuUploadAttribution.snapshot({
    enabled: causalMetricsEnabled,
  });
  return createCausalTelemetry({
    enabled: true,
    capturedAtMs: now,
    core: {
      frame: api?.getFrame?.() ?? 0,
      ticks: readCoreTicks(),
      ticksPerSecond: readCoreTicksPerSecond(),
      ppcPc: api?.getPpcPc?.() ?? 0,
      loadedCheckpointGeneration: loadedCheckpoint.generation,
      loadedCheckpointTicks: loadedCheckpoint.ticks,
      loadedCheckpointPpcPc: loadedCheckpoint.ppcPc,
    },
    softwareRaster: {
      ...parseCoreProfileTelemetry(videoStats),
      ...frameReuseTelemetryPayload(frameReuseTelemetry, tickRepaintCount),
    },
    presentation: {
      backend: renderBackend,
      pacingMode: presentationPacingMode,
      freshFrameDelivery: freshFrameDeliveryForPacing(presentationPacingMode, legacyTickQueue),
      legacyTickQueue,
      presentedFrames: presentedFrame,
      fps: presentationFps,
      rawFps: presentationRawFps,
      loopFps: presentationLoopFps,
      visualFps: visualChangeFps,
      queueDepth: frameQueue.length,
      queueTarget: presentationQueueTarget,
      queueLimit: presentationQueueLimit,
      queueAgeMs: presentationQueueAgeMs,
      queueAgeAverageMs: presentationQueueAgeSamples > 0
        ? presentationQueueAgeTotalMs / presentationQueueAgeSamples
        : 0,
      queueAgeMaxMs: presentationQueueAgeMaxMs,
      queueDepthHighWater: presentationQueueDepthHighWater,
      immediateFreshFrameCount,
      queuedFreshFrameCount,
      tickRepaintCount,
      frameLag: presentationFrameLag,
      underrunCount: presentationUnderrunCount,
      droppedFrameCount: presentationDroppedFrameCount,
      intervalAverageMs: presentationAverageIntervalMs,
      intervalP95Ms: presentationP95IntervalMs,
      intervalMaxMs: presentationMaxIntervalMs,
      intervalLifetimeMaxMs: presentationLifetimeMaxIntervalMs,
      intervalLongFrameCount: presentationLongFrameCount,
      js: lastStructuredProfileWindow,
      gpuCompletion: gpuCompletionTracker.snapshot(),
    },
    webgpu: {
      ...webGpuCausalStats,
      visualCadence: wgpuVisualCadenceSnapshot(),
      mappedStaging: wgpuMappedStagingPool?.snapshot() ?? null,
      mappedDrainCoalescing: wgpuMappedDrainCoalescer.snapshot(),
      uboSparse: wgpuSparseUboSnapshot(),
      backlogSampleP95: wgpuBacklogSampleP95(),
      replayPumpWakeDelayAverageMs: webGpuCausalStats.replayPumpWakeCount > 0
        ? webGpuCausalStats.replayPumpWakeDelayTotalMs /
          webGpuCausalStats.replayPumpWakeCount
        : 0,
      replayOps: wgpuReplayOpMetrics.snapshot({ enabled: causalMetricsEnabled }),
      uploadAttribution: uploadAttributionSnapshot,
      dirtyRangeProjection: wgpuDirtyRangeProjection.snapshot({
        requested: wgpuDirtyRangeProjectionRequested,
        active: wgpuDirtyRangeProjectionActive
      }),
      passPackageProjection: wgpuPassPackageProjection.snapshot({
        requested: wgpuPassPackageProjectionRequested,
        active: wgpuPassPackageProjectionActive
      }),
      uploadRunProjection: wgpuUploadRunProjection.snapshot({
        requested: wgpuUploadRunProjectionRequested,
        active: wgpuUploadRunProjectionActive
      }),
      uboComputeProjection: wgpuUboComputeProjection.snapshot({
        requested: wgpuUboComputeProjectionRequested,
        active: wgpuUboComputeProjectionActive
      }),
      uboComputeReconstruction: wgpuUboComputeReconstructionSnapshot(),
      ownershipTrace: wgpuOwnershipTrace.snapshot(),
      semanticRuntime: wgpuSemanticRuntime.snapshot(),
      registered: Boolean(webGpuCmdRing),
      stateCacheEnabled: wgpuStateCacheEnabled,
      uboCacheEnabled: wgpuUboCacheEnabled,
      uniformFastEnabled: wgpuUniformFastEnabled,
      uboPackEnabled: Boolean(webGpuUboPackMode()),
      geometryPackEnabled: wgpuGeometryPackEnabled,
      geometryRangeEnabled: wgpuGeometryRangeEnabled,
      producerUboCacheAvailable: Boolean(api?.setWebGpuUboCacheEnabled),
      producerUboPackAvailable: Boolean(api?.setWebGpuUboPackEnabled),
      producerGeometryPackAvailable: Boolean(api?.setWebGpuGeometryPackEnabled),
      producerGeometryRangeAvailable: Boolean(api?.setWebGpuGeometryRangeEnabled),
      producerUploadArenaAvailable: Boolean(api?.setWebGpuUploadArenaMiB),
      producerStateCacheEnabled:
        wgpuStateCacheEnabled && wgpuProducerStateCacheAvailable,
      consumerStateCacheEnabled: wgpuConsumerStateCacheEnabled,
      stateCache: wgpuConsumerStateCacheEnabled ? wgpuPassStateCache.snapshot() : null,
    },
    audio: {
      ...causalAudioStats,
      ...workletAudioProducer.telemetry(),
    },
    input: {
      workerPostApplyCount: causalInputStats.workerPostApplyCount,
      workerSabApplyCount: causalInputStats.workerSabApplyCount,
      workerSabGeneration: causalInputStats.workerSabGeneration,
      duplicateGenerationCount: causalInputStats.duplicateGenerationCount,
      staleGenerationCount: causalInputStats.staleGenerationCount,
      sabSnapshotRetryCount: causalInputStats.sabSnapshotRetryCount,
      ageLastMs: causalInputStats.ageLastMs,
      ageAverageMs: causalInputStats.ageSamples > 0
        ? causalInputStats.ageTotalMs / causalInputStats.ageSamples
        : 0,
      ageMaxMs: causalInputStats.ageMaxMs,
      visible: inputVisibleLatencyTracker.snapshot(),
      marker: {
        ...inputVisualMarkerTracker.snapshot(),
        overhead: inputPhotonOverheadDiagnosticsPayload(),
      },
      legacyReadbackEnabled: inputReadbackDiagnostics,
    },
  });
}

function startPresentationLoop() {
  if (!workerOwnsCanvas || presentationLoopActive) {
    return;
  }

  presentationLoopActive = true;
  lastPresentationFpsTime = performance.now();
  configureFrameSignalWait();
  if (!frameSignalHeap && typeof MessageChannel === "function") {
    presentationChannel = new MessageChannel();
    presentationChannel.port1.onmessage = () => runPresentationLoop();
  }
  schedulePresentationLoop();
  // §28cl tick mode: in addition to the new-frame-driven present loop,
  // start a 60Hz timer that re-paints the last known frame whenever the
  // previous paint is older than ~14ms (one frame at 60Hz with slack).
  // Skips when no frame has been painted yet, when a real paint just
  // happened, or when the buffer cache is empty.
  if (presentationPacingMode === "tick") {
    startTickRepaintLoop();
  }
}

// §28cl: 60Hz re-paint loop for tick pacing. Cheap — drawFrameToWebGpu
// already runs in <2ms typical; re-painting the same buffer at 60Hz costs
// the same as a fresh frame would have. The new-frame presentFrame path
// is unchanged so latency stays at direct-mode levels; this only fills
// the visual gaps when Melee internally renders duplicates.
let _tickRepaintTimer = null;
function startTickRepaintLoop() {
  if (_tickRepaintTimer) return;
  const TICK_MS = 16; // ~60 Hz cadence
  const SKIP_IF_RECENT_MS = 14; // don't double-paint within one frame of a real paint
  _tickRepaintTimer = setInterval(() => {
    if (!presentationLoopActive) return;
    // Hardware WGPU presents through the command-ring context. Once it has
    // submitted a real present, repainting the cached CPU frame here would
    // immediately cover that backbuffer with the stale checker/green frame.
    if (cmdRingOwnsCanvas) return;
    if (!_lastFrameCopyValid || _lastFrameLength <= 0) return;
    const now = performance.now();
    if (lastPresentedAt > 0 && (now - lastPresentedAt) < SKIP_IF_RECENT_MS) return;
    // Re-paint the STABLE snapshot (not the live s_framebuffer pointer, which
    // the core overwrites mid-frame → flicker). Bypasses recordPresentedFrame
    // so the presentation-fps metric continues to reflect *unique* content
    // rate, not the tick rate. lastPresentedAt is bumped so back-to-back ticks
    // honor the SKIP_IF_RECENT_MS gate.
    const tickBytes = _lastFrameCopy.subarray(0, _lastFrameLength);
    const coreFrame = api?.getFrame?.() ?? 0;
    const marker = prepareInputVisualMarker(coreFrame);
    const marked = frameWithInputMarker(
      tickBytes,
      _lastFrameWidth,
      _lastFrameHeight,
      marker
    );
    const markerApplied = marked.applied;
    const displayBytes = markerApplied ? marked.bytes : tickBytes;
    let markerOutputIssued = false;
    if (renderGpu) {
      drawFrameBytesToWebGpu(_lastFrameWidth, _lastFrameHeight, displayBytes);
      markerOutputIssued = markerApplied;
    } else if (renderGl) {
      drawFrameBytesToWebGl(_lastFrameWidth, _lastFrameHeight, displayBytes);
      markerOutputIssued = markerApplied;
    } else if (renderContext) {
      drawFrameBytesToCanvas(_lastFrameWidth, _lastFrameHeight, displayBytes);
      markerOutputIssued = markerApplied;
    } else if (markerApplied && oglPixelSabView && oglMetaSabView) {
      markerOutputIssued = publishOglSabFrame(
        _lastFrameWidth,
        _lastFrameHeight,
        displayBytes
      );
    }
    if (markerOutputIssued) {
      recordInputMarkerSubmission(
        marker,
        coreFrame,
        `software-tick-${renderBackend}`,
        renderGpu?.device?.queue
      );
    }
    tickRepaintCount += 1;
    lastPresentedAt = now;
  }, TICK_MS);
}

function schedulePresentationLoop() {
  if (!presentationLoopActive) {
    return;
  }

  if (coreBoot.accepted && renderBackend === "ogl" && frameSignalHeap) {
    // OGL fires DolphinWeb_OnOglSwap on every GL swap, which calls
    // PublishFrameSignal. Use Atomics.waitAsync on the same frame signal as
    // the software path: it is exempt from Chrome's worker setTimeout
    // throttling (IntensiveWakeUpThrottling clamps occluded-tab worker
    // timers to a 1s minimum, starving pumpHostJobs and freezing the core).
    // Lane W traced this as the root cause of "stuck at cutscene" reports
    // in real Chrome. The Playwright probe never reproduced because headless
    // has no occlusion-detected window.
    scheduleFrameSignalWait();
  } else if (coreBoot.accepted && renderBackend === "ogl") {
    scheduleOglPresentationPoll();
  } else if (coreBoot.accepted && frameSignalHeap) {
    if (
      freshFrameDeliveryForPacing(presentationPacingMode, legacyTickQueue) ===
      FRESH_FRAME_DELIVERY.QUEUED
    ) {
      startPacedPresentation();
    }
    scheduleFrameSignalWait();
  } else if (presentationChannel) {
    presentationChannel.port2.postMessage(0);
  } else {
    setTimeout(() => runPresentationLoop(), 0);
  }
}

function scheduleOglPresentationPoll() {
  setTimeout(() => runPresentationLoop(), PACED_PRESENTATION_INTERVAL_MS);
}

function configureFrameSignalWait() {
  const signalPointer = api?.getFrameSignalPtr?.() ?? 0;
  const heap32 = moduleInstance?.HEAP32 ?? new Int32Array(moduleInstance?.HEAPU8?.buffer ?? new ArrayBuffer(0));
  if (
    signalPointer > 0 &&
    heap32?.buffer instanceof SharedArrayBuffer &&
    typeof Atomics?.waitAsync === "function"
  ) {
    frameSignalHeap = heap32;
    frameSignalIndex = signalPointer >> 2;
    frameSignalValue = Atomics.load(frameSignalHeap, frameSignalIndex);
  }
}

function scheduleFrameSignalWait() {
  if (!presentationLoopActive || frameSignalWaitPending || !frameSignalHeap || frameSignalIndex < 0) {
    return;
  }

  const currentSignal = Atomics.load(frameSignalHeap, frameSignalIndex);
  if (currentSignal !== frameSignalValue) {
    frameSignalValue = currentSignal;
    queueMicrotask(() => runPresentationLoop());
    return;
  }

  // 16ms timeout = ~60Hz fallback wake rate when the OGL render thread is
  // not bumping the frame signal. Earlier 8ms made the worker thread
  // compete with the EmuThread (cpu=dual mode) for CPU, regressing gameplay.
  // 50ms was too slow when the signal stalled; 16ms is the middle ground:
  // matches VI vsync rate so we never wait longer than one frame's worth.
  const wait = Atomics.waitAsync(frameSignalHeap, frameSignalIndex, currentSignal, 16);
  if (!wait.async) {
    setTimeout(() => runPresentationLoop(), 0);
    return;
  }

  frameSignalWaitPending = true;
  const waitStartedAt = performance.now();
  wait.value
    .catch(() => "error")
    .then(() => {
      frameSignalWaitPending = false;
      // Diagnostic: if signal wait took >200ms, the OGL pthread is stalled
      // (likely glReadPixels syncing on a deep GPU queue — texture loads on
      // scene transitions like character-select are the prime suspect).
      // discio's loop itself is fast; the long gap shows up as a paint-rate
      // stall because the signal that triggers the next paint doesn't tick.
      const waitMs = performance.now() - waitStartedAt;
      if (waitMs > 200) {
        signalStallCount += 1;
        const isNewWorst = waitMs > worstSignalWaitMs;
        if (isNewWorst || signalStallCount % 5 === 0) {
          if (isNewWorst) worstSignalWaitMs = waitMs;
          // eslint-disable-next-line no-console
          console.log(
            `[signal-stall#${signalStallCount}${isNewWorst ? "*" : ""}] ` +
            `waitMs=${waitMs.toFixed(0)} renderBackend=${renderBackend}`
          );
        }
      }
      if (!presentationLoopActive) {
        return;
      }
      frameSignalValue = Atomics.load(frameSignalHeap, frameSignalIndex);
      runPresentationLoop();
    });
}

function applyInputStateSnapshot(state, sentAtEpochMs, source) {
  if (!api?.setInputState || !state) return false;
  const generation = Number(state.inputGeneration) >>> 0;
  if (!generation) return false;
  const order = compareInputGenerations(generation, lastInputStateGeneration);
  if (order === 0) {
    causalInputStats.duplicateGenerationCount += 1;
    return false;
  }
  if (order < 0) {
    causalInputStats.staleGenerationCount += 1;
    return false;
  }

  lastInputStateGeneration = generation;
  const mask = Number(state.mask) >>> 0;
  inputMask = mask;
  const wrappedSentAt = source === "sab"
    ? wrappedEpochMilliseconds(Number(sentAtEpochMs) >>> 0)
    : Number(sentAtEpochMs);
  recordInputApplied({
    generation,
    inputMask: mask,
    sentAtEpochMs: wrappedSentAt,
    source
  });
  api.setInputState({
    mask,
    stickX: Number(state.stickX) | 0,
    stickY: Number(state.stickY) | 0,
    cStickX: Number(state.cStickX) | 0,
    cStickY: Number(state.cStickY) | 0,
    triggerLeft: Number(state.triggerLeft) | 0,
    triggerRight: Number(state.triggerRight) | 0,
    analogA: Number(state.analogA) | 0,
    analogB: Number(state.analogB) | 0,
    inputGeneration: generation
  });
  recordInputAge(sentAtEpochMs, source === "sab");
  if (source === "sab") {
    causalInputStats.workerSabApplyCount += 1;
    causalInputStats.workerSabGeneration = generation;
  } else {
    causalInputStats.workerPostApplyCount += 1;
  }
  return true;
}

function pollInputStateFromSab() {
  if (!inputStateSabView || !api?.setInputState) {
    return;
  }
  const result = readInputStateSnapshot(inputStateSabView);
  causalInputStats.sabSnapshotRetryCount += Math.max(0, result.attempts - 1);
  if (!result.snapshot) {
    causalInputStats.sabSnapshotRetryCount += 1;
    return;
  }
  applyInputStateSnapshot(result.snapshot, result.snapshot.sentAtEpochMsLow, "sab");
}

function runPresentationLoop() {
  const stages = {};
  try {
    loopsSincePresentationFps += 1;
    if (moduleInstance && api) {
      pollInputStateFromSab();
      // Day-27: drain the cross-thread WebGPU command ring and replay
      // on renderGpu.device. No-op until the video pthread hands the
      // ring over (handleWebGpuCmdRing) and only matters for
      // ?video=wgpu. Cheap when empty (one atomic load).
      if (!(wgpuReplayBudgetMs > 0 && wgpuReplayYieldPending)) {
        drainWebGpuCmdRing("presentation");
      } else {
        webGpuCausalStats.replayBudgetPresentationRedrainSuppressedCount += 1;
      }
      const loopStartedAt = performance.now();
      // Pump host jobs every loop iteration. The previous 100ms rate-limit
      // capped pumpHostJobs at 10Hz post-boot, which starves CoreTiming when
      // the worker's loop is running fine but pumpHostJobs is the bottleneck
      // for game-clock progress. Pumping on every iteration (~60Hz when
      // healthy) lets the core advance even under Chrome's worker timer
      // throttling.
      const pumpStartedAt = startProfileSample();
      api.pumpHostJobs?.();
      stages.pump = finishProfileSample("pump", pumpStartedAt);
      lastHostPumpTime = loopStartedAt;
      if (!coreBoot.accepted) {
        const firstRunFrame = !self._firstRunFrameLogged;
        const runStartedAt = collectMetrics || firstRunFrame ? performance.now() : 0;
        if (firstRunFrame) {
          self._firstRunFrameLogged = true;
          console.log(`[boot-phase] FIRST api.runFrame() at perf.now=${runStartedAt.toFixed(1)}ms`);
        }
        api.runFrame?.();
        stages.run = finishProfileSample("run", runStartedAt);
      }

      const apiStartedAt = startProfileSample();
      const width = api.frameWidth();
      const height = api.frameHeight();
      const pointer = api.frameBuffer();
      const coreFrame = api.getFrame?.() ?? 0;
      stages.api = finishProfileSample("api", apiStartedAt);
      maybeEnablePpcWasmJit(coreFrame);
      const presentStartedAt = startProfileSample();
      if (cmdRingOwnsCanvas) {
        // The WebGPU hardware renderer presents the canvas itself via
        // the cmd-ring executor; skip the legacy CPU-framebuffer blit
        // (post-cutover that buffer is stale — it was overwriting the
        // real GPU frame every iteration).
      } else if (coreBoot.accepted && frameSignalHeap && renderBackend === "ogl") {
        // OGL bypasses XFB, so api.getFrame() doesn't increment per visible frame.
        // Use the OGL swap count (incremented in DolphinWeb_OnOglSwap) as the
        // present-deduplication key so each new GL swap registers as a new frame.
        const oglSwap = parseOglSwapStats(api.getVideoStats?.()).swap >>> 0;
        const oglFrameKey = oglSwap > 0 ? oglSwap : coreFrame;
        // Detached OGL bitmap capture now happens C++-side from the GPU
        // pthread (Emscripten.cpp Swap() does transferToImageBitmap +
        // self.postMessage), and the discio worker forwards via
        // handleDetachedOglFrame attached per-pthread in
        // installDolphinJitCacheChannel. The discio worker can't
        // transferToImageBitmap on detachedOglCanvas because Emscripten
        // transferred it to the GPU pthread — that's what Day-3 hit and
        // why we couldn't make worker-mode painting work then.
        presentFrame(width, height, pointer, width * height * 4, oglFrameKey);
      } else if (coreBoot.accepted && frameSignalHeap) {
        const delivery = freshFrameDeliveryForPacing(presentationPacingMode, legacyTickQueue);
        if (delivery === FRESH_FRAME_DELIVERY.IMMEDIATE) {
          if (coreFrame !== lastPresentedCoreFrame) immediateFreshFrameCount += 1;
          presentFrame(width, height, pointer, width * height * 4, coreFrame);
        } else {
          captureFrameForPacedPresentation(width, height, pointer, width * height * 4, coreFrame);
        }
      } else if (coreFrame !== lastPresentedCoreFrame) {
        presentFrame(width, height, pointer, width * height * 4, coreFrame);
      }
      stages.present = collectMetrics ? performance.now() - presentStartedAt : 0;
      updatePresentationFps();
      maybeDisablePpcWasmJit(coreFrame);
      const loopMs = performance.now() - loopStartedAt;
      stages.loop = loopMs;
      addProfileTime("loop", loopMs);
      // Stall logger: when a single loop iteration exceeds 100 ms, log a
      // per-stage breakdown. We always log the worst sample so far, and
      // additionally every 5th stall after that, so a sustained slow patch
      // surfaces in the console without overwhelming it.
      if (loopMs > 100) {
        stallCount += 1;
        const isNewWorst = loopMs > worstLoopMsLogged;
        if (isNewWorst || stallCount % 5 === 0) {
          if (isNewWorst) worstLoopMsLogged = loopMs;
          // eslint-disable-next-line no-console
          console.log(
            `[stall#${stallCount}${isNewWorst ? "*" : ""}] loop=${loopMs.toFixed(0)}ms ` +
            `pump=${(stages.pump ?? 0).toFixed(0)} ` +
            `api=${(stages.api ?? 0).toFixed(0)} ` +
            `present=${(stages.present ?? 0).toFixed(0)} ` +
            `coreFrame=${coreFrame} renderBackend=${renderBackend}`
          );
        }
      }
    }
  } catch (error) {
    postStatus(error instanceof Error ? error.message : String(error));
  } finally {
    schedulePresentationLoop();
  }
}

function resetPpcWasmJitTiming(invalidateBaseline = false) {
  // Intentional pauses and loads are not emulation stalls. Keep JIT mode,
  // cooldown, presentation resources, and lifetime metrics unchanged.
  ppcWasmJitCoreSampleFrame = -1;
  ppcWasmJitCoreSampleTime = 0;
  ppcWasmJitCoreFpsRolling = 0;
  ppcWasmJitFuseLastFrame = -1;
  ppcWasmJitFuseLastTime = 0;
  presentationMaxIntervalMs = 0;
  maxIntervalSincePresentationFps = 0;
  lastPresentedAt = performance.now();
  if (invalidateBaseline) {
    ppcWasmJitPreEngageFps = 0;
    ppcWasmJitPreEngageCoreFps = 0;
  }
}

function maybeEnablePpcWasmJit(coreFrame = api?.getFrame?.() ?? 0) {
  if (ppcWasmJitCorePaused || ppcWasmJitTimingSuspensions > 0) return;
  // Keep a pre-engage core-fps estimate warm. This runs every tick while the
  // JIT is still off, which is the only window in which an honest "before"
  // baseline can be taken.
  sampleCoreFpsRolling(coreFrame);
  if (
    !ppcWasmJitRequested ||
    ppcWasmJitActive ||
    ppcWasmJitDisabledForSession ||
    !api?.setPpcWasmJitEnabled
  ) {
    return;
  }

  // Warm-cache fast path. When Day-9 fingerprint matched and Day-7 loaded
  // enough cached modules to cover the initial compile burst, skip the
  // long warmup gate — there's no stability concern because the JIT
  // doesn't have to actually compile anything; it just instantiates from
  // cache. The MINIMUM_PRE_JIT_FRAMES floor is still respected so the
  // emulator gets through the first few video frames stably before we
  // change its compilation behavior.
  const MINIMUM_PRE_JIT_FRAMES = 30;
  const effectiveWarmup =
    dolphinJitCachePreWarmed && coreFrame >= MINIMUM_PRE_JIT_FRAMES
      ? MINIMUM_PRE_JIT_FRAMES
      : ppcWasmJitWarmupFrames;
  if ((coreFrame >>> 0) < effectiveWarmup) {
    return;
  }

  if ((coreFrame >>> 0) < ppcWasmJitCooldownUntilFrame) {
    return;
  }

  // Engage after warmup regardless of momentary presentation rate. Single-
  // window samples drop to 0 during multi-second core stalls and would
  // indefinitely block engage even when long-term throughput is healthy. The
  // post-engage guard (maybeDisablePpcWasmJit, ACTIVE_* thresholds) handles
  // catastrophic regression.

  // Day-21: snapshot the pre-engage presentation rate. The disable
  // guard judges the JIT by *regression vs this baseline*, not an
  // absolute fps floor. A heavy renderer (fastsw=0 full-res CPU
  // raster) caps present fps far below the old absolute threshold;
  // the JIT still speeds up PPC emulation in that regime, so fusing
  // it off there was strictly counterproductive (and flapped every
  // cooldown). Record the baseline so we only fuse when the JIT
  // itself made presentation worse.
  ppcWasmJitPreEngageFps = presentationFps;
  ppcWasmJitPreEngageCoreFps = ppcWasmJitCoreFpsRolling;

  console.log(`[s28-jittier] ENGAGE: setPpcWasmJitEnabled(${ppcWasmJitTier === "mixed" ? 2 : 1}) ` +
    `(ppcWasmJitTier=${ppcWasmJitTier}) @frame ${coreFrame}`);
  api.setPpcWasmJitEnabled(ppcWasmJitTier === "mixed" ? 2 : 1);
  ppcWasmJitActive = true;
  ppcWasmJitEnabledAtFrame = coreFrame >>> 0;
  // §28s: re-arm the core-liveness tracker on every (re)engage so a
  // pre-cooldown (frame,time) pair can't compute a bogus low coreFps
  // across the cooldown gap on the first post-re-engage fuse check.
  ppcWasmJitFuseLastFrame = -1;
  const reason = dolphinJitCachePreWarmed && effectiveWarmup === MINIMUM_PRE_JIT_FRAMES
    ? `pre-warmed cache hit, JIT engaged at frame ${coreFrame}`
    : `JIT enabled after ${coreFrame} stable video frames`;
  postStatus(`Experimental WASM ${reason}`);
}

function maybeDisablePpcWasmJit(coreFrame = api?.getFrame?.() ?? 0) {
  if (ppcWasmJitCorePaused || ppcWasmJitTimingSuspensions > 0) return;
  if (!ppcWasmJitActive || ppcWasmJitForce || !api?.setPpcWasmJitEnabled) {
    return;
  }

  const framesSinceActivation = (coreFrame >>> 0) - ppcWasmJitEnabledAtFrame;

  // Detect multi-second post-activation stalls even during the grace period.
  // A stall exceeding WASM_JIT_POST_ACTIVATION_STALL_THRESHOLD_MS (5s) means the
  // compile burst blocked presentation long enough to produce a visible freeze.
  // §28bq: REVERTED §28bp. Gating this stall guard off for the
  // webgpu presenter removed the ONLY post-engage grace-period
  // protection, so a compile-burst freeze went uncaught → boot
  // stall regression ("core not advancing"). Restored original
  // (presentation-interval) stall guard; the §28bp sawtooth concern
  // needs a core-liveness redesign, not removal of protection.
  if (presentationMaxIntervalMs > WASM_JIT_POST_ACTIVATION_STALL_THRESHOLD_MS) {
    api.setPpcWasmJitEnabled(0);
    ppcWasmJitActive = false;
    ppcWasmJitDisabledForSession = true;
    postStatus(
      `Experimental WASM JIT disabled after post-activation stall ` +
        `(max_interval:${presentationMaxIntervalMs}ms at frame ${coreFrame})`
    );
    return;
  }

  if (framesSinceActivation < WASM_JIT_MIN_ACTIVE_FRAMES_BEFORE_FUSE) {
    return;
  }

  // Day-21: judge the JIT by regression vs the pre-engage baseline,
  // not an absolute fps floor. The absolute floor (fps>=25, gap<=40ms)
  // assumed a GPU-class renderer; with the CPU software rasteriser
  // (especially fastsw=0 full-res) present fps is renderer-capped well
  // below that even though the JIT is *helping* PPC throughput. The
  // old logic disabled the JIT every cooldown, making emulation slower
  // for no benefit — exactly the "feels slower" the user hit.
  //
  // Keep the JIT unless presentation dropped materially below where it
  // was right before the JIT engaged (a regression the JIT caused),
  // OR it's catastrophically slow in absolute terms (sub-floor — a
  // genuine freeze, not just a heavy renderer). The 5s post-activation
  // stall check above already handles compile-burst freezes.
  // §28bq: REVERTED §28bp `regressed` gating (see above).
  // Judge the JIT by EMULATION THROUGHPUT, not presentation rate. The JIT
  // affects how fast PowerPC executes; it does not make a scene cheaper to
  // draw. Comparing a light-screen presentation baseline against a heavy scene
  // fused the JIT off on every menu->gameplay transition. Core fps is the same
  // signal the catastrophic check below already uses, measured over one shared
  // window.

  // §28s: "catastrophic" = the JIT genuinely FROZE emulation, judged
  // by the core frame counter vs wall-clock — NOT presentationFps
  // (structurally ~0 in the WebGPU presenter, which made the old
  // floor fire every window at a healthy 60 coreFps and thrash the
  // JIT, collapsing the intro cutscene into a black flash). Only
  // trip when ≥1.5 s of wall time elapsed AND effective core fps is
  // sub-floor (a true freeze; healthy ≈ 60).
  const nowMs = (typeof performance !== "undefined" ? performance.now()
                 : Date.now());
  const cf = coreFrame >>> 0;
  let catastrophic = false;
  let regressed = false;
  if (ppcWasmJitFuseLastFrame >= 0) {
    const dtMs = nowMs - ppcWasmJitFuseLastTime;
    if (dtMs >= 1500) {
      const dFrames = (cf - ppcWasmJitFuseLastFrame) >>> 0;
      const coreFps = (dFrames * 1000) / dtMs;
      catastrophic = coreFps < WASM_JIT_ABSOLUTE_FLOOR_FPS;
      regressed =
        ppcWasmJitPreEngageCoreFps >= WASM_JIT_REGRESSION_MIN_BASELINE_FPS &&
        coreFps < ppcWasmJitPreEngageCoreFps * WASM_JIT_REGRESSION_FRACTION;
      ppcWasmJitFuseLastFrame = cf;
      ppcWasmJitFuseLastTime = nowMs;
    }
  } else {
    ppcWasmJitFuseLastFrame = cf;
    ppcWasmJitFuseLastTime = nowMs;
  }

  if (!regressed && !catastrophic) {
    return;
  }

  api.setPpcWasmJitEnabled(0);
  ppcWasmJitActive = false;
  // Cooldown rather than permanent disable: degraded presentation often
  // recovers (post-cutscene transition, post-shader-compile spike). After the
  // cooldown frames pass the engage check can re-fire.
  ppcWasmJitCooldownUntilFrame = (coreFrame >>> 0) + WASM_JIT_DEGRADED_COOLDOWN_FRAMES;
  postStatus(
    `Experimental WASM JIT temporarily off ` +
      `(fps:${presentationFps} baseline:${ppcWasmJitPreEngageCoreFps} ` +
      `${catastrophic ? "catastrophic" : "regressed"}; cooldown ` +
      `${WASM_JIT_DEGRADED_COOLDOWN_FRAMES} frames)`
  );
}

function normalizePpcWasmJitWarmupFrames(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) {
    return DEFAULT_WASM_JIT_WARMUP_XFB_FRAMES;
  }
  return Math.round(Math.min(60000, Math.max(0, requested)));
}

function parseVideoFrameHash(videoStats) {
  const match = String(videoStats || "").match(/\shash:([0-9a-f]+)/i);
  if (!match) {
    return 0;
  }

  const parsed = Number.parseInt(match[1], 16);
  return Number.isFinite(parsed) ? parsed >>> 0 : 0;
}

function parseOglSwapStats(videoStats) {
  const text = String(videoStats || "");
  const swap = Number.parseInt(/\bogl_swap:(\d+)/i.exec(text)?.[1] || "", 10);
  const size = /\bbb:(\d+)x(\d+)/i.exec(text);
  const readbackRgba = Number.parseInt(/\brb:0x([0-9a-f]+)/i.exec(text)?.[1] || "", 16);
  // glerr is captured by GLContextEmscripten::Swap() right before
  // emscripten_webgl_commit_frame(). It surfaces any GL error left pending in
  // the queue at swap time; on the OGL path the error originates inside the
  // upstream Dolphin OGL backend's draw pipeline (not our presenter glue), so
  // 0x502 (GL_INVALID_OPERATION) is reported but not auto-cleared here.
  const glError = Number.parseInt(/\bglerr:0x([0-9a-f]+)/i.exec(text)?.[1] || "", 16);

  return {
    swap: Number.isFinite(swap) ? swap >>> 0 : 0,
    width: size ? Math.max(0, Number.parseInt(size[1], 10) || 0) : 0,
    height: size ? Math.max(0, Number.parseInt(size[2], 10) || 0) : 0,
    readbackRgba: Number.isFinite(readbackRgba) ? readbackRgba >>> 0 : 0,
    glError: Number.isFinite(glError) ? glError >>> 0 : 0
  };
}

function recordOglSwapDelta(swapCount) {
  const current = swapCount >>> 0;
  if (!current) {
    return;
  }

  if (lastOglSwapCount > 0 && current > lastOglSwapCount) {
    visualChangesSincePresentationFps += current - lastOglSwapCount;
  }
  visualFrameHash = current;
  lastVisualFrameHash = current;
  lastOglSwapCount = current;
}

function captureFrameForPacedPresentation(width, height, pointer, length, coreFrame) {
  const captureStartedAt = startProfileSample();
  if (coreFrame === lastCapturedCoreFrame || width <= 0 || height <= 0 || pointer <= 0 || length <= 0) {
    return;
  }

  while (frameQueue.length >= presentationQueueLimit) {
    frameQueue.shift();
    presentationDroppedFrameCount += 1;
    presentationDropsSinceFps += 1;
  }

  const copyStartedAt = startProfileSample();
  const bytes = moduleInstance.HEAPU8.slice(pointer, pointer + length);
  finishProfileSample("copy", copyStartedAt);
  addProfileBytes(length);

  frameQueue.push({
    bytes,
    capturedAt: performance.now(),
    coreFrame,
    height,
    width
  });
  queuedFreshFrameCount += 1;
  presentationQueueDepthHighWater = Math.max(presentationQueueDepthHighWater, frameQueue.length);
  lastCapturedCoreFrame = coreFrame;
  finishProfileSample("capture", captureStartedAt);
}

function startPacedPresentation() {
  if (pacedPresentationActive) {
    return;
  }

  pacedPresentationActive = true;
  pacedPresentationStartedAt = performance.now();
  nextPacedPresentationTime = performance.now();
  schedulePacedPresentation();
}

function schedulePacedPresentation() {
  if (!pacedPresentationActive) {
    return;
  }

  const delay = Math.max(0, nextPacedPresentationTime - performance.now());
  pacedPresentationTimer = setTimeout(() => {
    pacedPresentationTimer = 0;
    runPacedPresentation();
  }, delay);
}

function runPacedPresentation(timestamp = performance.now()) {
  const pacedStartedAt = startProfileSample();
  try {
    const now = timestamp;
    if (!pacedPresentationPrimed) {
      if (frameQueue.length < presentationQueueTarget) {
        presentationUnderrunCount += 1;
        presentationUnderrunsSinceFps += 1;
        return;
      }
      pacedPresentationPrimed = true;
    }

    const queued = frameQueue.shift();
    if (queued) {
      presentationFrameLag = Math.max(0, lastCapturedCoreFrame - queued.coreFrame);
      presentationQueueAgeMs = Math.max(0, now - queued.capturedAt);
      presentationQueueAgeTotalMs += presentationQueueAgeMs;
      presentationQueueAgeSamples += 1;
      presentationQueueAgeMaxMs = Math.max(presentationQueueAgeMaxMs, presentationQueueAgeMs);
      presentFrameBytes(queued.width, queued.height, queued.bytes, queued.coreFrame);
    } else {
      presentationUnderrunCount += 1;
      presentationUnderrunsSinceFps += 1;
    }
  } catch (error) {
    postStatus(error instanceof Error ? error.message : String(error));
  } finally {
    const now = timestamp || performance.now();
    do {
      nextPacedPresentationTime += PACED_PRESENTATION_INTERVAL_MS;
    } while (nextPacedPresentationTime < now - PACED_PRESENTATION_INTERVAL_MS);
    schedulePacedPresentation();
    finishProfileSample("paced", pacedStartedAt);
  }
}

let _firstPaintLogged = false;
// §28cl last-frame cache for tick-mode re-paints. Updated on every real
// presentFrame call (NEW content) so the tick timer can re-paint the same
// content at a steady cadence without waiting for Melee to produce a fresh
// xfb. Width/height/pointer/length are exactly what drawFrameToWebGpu /
// drawFrameToCanvas / drawFrameToWebGl expect — the same call signature
// presentFrame uses internally.
let _lastFrameWidth = 0;
let _lastFrameHeight = 0;
let _lastFramePointer = 0;
let _lastFrameLength = 0;
// §28cx tick-flicker fix: a stable JS-owned snapshot of the last real frame.
// The 60 Hz tick re-paint timer paints THIS, never the live s_framebuffer
// pointer — the core overwrites s_framebuffer with the next frame between
// signals, so re-reading the pointer mid-write produced torn/black frames
// (the flicker seen in pacing=tick).
let _lastFrameCopy = null;
let _lastFrameCopyValid = false;
let _inputMarkerFrameCopy = null;

function recordInputPhotonFrameCopyPaint({ sourceBytes, paintedBytes, elapsedMs }) {
  if (!inputPhotonOverheadDiagnostics.enabled) return;
  const stats = inputPhotonOverheadDiagnostics.softwareFrameCopyPaint;
  const durationMs = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0;
  stats.calls += 1;
  stats.sourceBytes += Math.max(0, Number(sourceBytes) || 0);
  stats.paintedBytes += Math.max(0, Number(paintedBytes) || 0);
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
}

function frameWithInputMarker(bytes, width, height, marker) {
  if (!marker || !bytes?.byteLength) return { bytes, applied: false };
  const collectOverhead = inputPhotonOverheadDiagnostics.enabled &&
    marker.mode === INPUT_VISUAL_MARKER_MODE_PHOTON;
  const startedAt = collectOverhead ? performance.now() : 0;
  if (!_inputMarkerFrameCopy || _inputMarkerFrameCopy.length < bytes.byteLength) {
    _inputMarkerFrameCopy = new Uint8Array(bytes.byteLength);
  }
  const marked = _inputMarkerFrameCopy.subarray(0, bytes.byteLength);
  marked.set(bytes);
  const applied = applyInputVisualMarkerRgba(marked, width, height, marker);
  const elapsedMs = collectOverhead ? performance.now() - startedAt : 0;
  let geometry = null;
  if (applied && marker.mode === INPUT_VISUAL_MARKER_MODE_PHOTON) {
    geometry = resolveInputPhotonMarkerGeometry(width, height, marker.optical);
  }
  if (collectOverhead) {
    const barcodeWidth = Math.min(INPUT_VISUAL_MARKER_SIZE, Math.max(0, Number(width) || 0));
    const barcodeHeight = Math.min(INPUT_VISUAL_MARKER_SIZE, Math.max(0, Number(height) || 0));
    const paintedBytes = applied
      ? ((geometry?.width ?? 0) * (geometry?.height ?? 0) + barcodeWidth * barcodeHeight) * 4
      : 0;
    recordInputPhotonFrameCopyPaint({
      sourceBytes: bytes.byteLength,
      paintedBytes,
      elapsedMs,
    });
  }
  if (geometry) inputVisualMarkerTracker.recordRenderGeometry(geometry);
  return { bytes: marked, applied };
}

function presentFrame(width, height, pointer, length, coreFrame = api?.getFrame?.() ?? 0) {
  const firstPaint = !_firstPaintLogged;
  const presentStartedAt = collectMetrics || firstPaint ? performance.now() : 0;
  if (coreFrame === lastPresentedCoreFrame) {
    updatePresentationFps();
    return;
  }
  if (firstPaint) {
    _firstPaintLogged = true;
    console.log(`[boot-phase] FIRST paint coreFrame=${coreFrame} at perf.now=${presentStartedAt.toFixed(1)}ms (${width}x${height})`);
  }
  // §28cl: stash for the tick re-paint timer.
  _lastFramePointer = pointer;

  const frameView =
    moduleInstance && pointer > 0 && length > 0
      ? new Uint8Array(moduleInstance.HEAPU8.buffer, pointer, length)
      : null;
  const marker = prepareInputVisualMarker(coreFrame);
  let displayFrameView = frameView;
  let sourceFrameView = frameView;
  let markerApplied = false;

  // §28cx tick-flicker fix: snapshot this complete frame into a stable buffer
  // so the tick re-paint never reads s_framebuffer while the core writes the
  // next frame. CRITICAL: stash the dims TOGETHER with the copy, and ONLY when
  // the frame is valid — otherwise a null/zero/resolution-change frame would
  // bump _lastFrameWidth/Height/Length while _lastFrameCopy kept old bytes, and
  // the tick would upload old bytes at new dimensions → stride mismatch → the
  // rainbow-gradient flicker. Keeping them atomic means a transition frame
  // simply leaves the last good frame (and its dims) on screen.
  if (frameView) {
    if (!_lastFrameCopy || _lastFrameCopy.length < length)
      _lastFrameCopy = new Uint8Array(length);
    _lastFrameCopy.set(frameView);
    _lastFrameWidth = width;
    _lastFrameHeight = height;
    _lastFrameLength = length;
    _lastFrameCopyValid = true;
    sourceFrameView = _lastFrameCopy.subarray(0, length);
    const marked = frameWithInputMarker(sourceFrameView, width, height, marker);
    markerApplied = marked.applied;
    if (markerApplied) displayFrameView = marked.bytes;
  }

  const drawStartedAt = startProfileSample();
  let markerOutputIssued = false;
  if (renderGpu) {
    if (markerApplied) drawFrameBytesToWebGpu(width, height, displayFrameView);
    else drawFrameToWebGpu(width, height, pointer, length);
    markerOutputIssued = markerApplied;
  } else if (renderGl) {
    if (markerApplied) drawFrameBytesToWebGl(width, height, displayFrameView);
    else drawFrameToWebGl(width, height, pointer, length);
    markerOutputIssued = markerApplied;
  } else if (renderContext) {
    if (markerApplied) drawFrameBytesToCanvas(width, height, displayFrameView);
    else drawFrameToCanvas(width, height, pointer, length);
    markerOutputIssued = markerApplied;
  }
  // SAB pixel transport: copy s_framebuffer bytes into the shared pixel
  // buffer and bump the generation counter atomically. Main thread reads
  // the counter on RAF and putImageDatas the SAB contents onto the visible
  // canvas. The drawFrame* path above is a no-op in SAB mode (no presenter
  // was set up), so this IS the visible-paint pipeline for OGL+SAB.
  if (displayFrameView && oglPixelSabView && oglMetaSabView) {
    const published = publishOglSabFrame(width, height, displayFrameView);
    if (markerApplied && published) markerOutputIssued = true;
  }
  finishProfileSample("draw", drawStartedAt);
  if (markerOutputIssued) {
    recordInputMarkerSubmission(
      marker,
      coreFrame,
      `software-frame-${renderBackend}`,
      renderGpu?.device?.queue
    );
  }

  const hashStartedAt = startProfileSample();
  if (!wgpuVisualCadenceEnabled) {
    recordVisualFrameHash(hashFrameBytes(sourceFrameView), true);
  }
  finishProfileSample("hash", hashStartedAt);
  recordPresentedFrame(coreFrame);
  finishProfileSample("present", presentStartedAt);
}

let oglSabLastPublishMs = 0;
// Throttle on SAB writes. Each OGL swap fires the frame signal twice
// (OnGlBackbuffer + OnOglSwap, ~1 ms apart) and ogl_swap_count's relaxed
// memory ordering means the worker reads it racily — sometimes both wakes
// see the same count, sometimes adjacent counts. 14 ms catches the paired
// wakes reliably but caps SAB write-rate around 20 Hz. Lower values lift
// the write rate but trade gameSpeed (Day-10 measured 91% at 4 ms vs 100%
// at 14 ms — main-thread paint contention with worker's SAB reads).
const OGL_SAB_MIN_INTERVAL_MS = 14;

let oglSabWriteCount = 0;       // successful SAB writes (memcpy + gen bump)
let oglSabThrottleSkipCount = 0; // calls returned early by 14ms throttle
let oglSabLastReportMs = 0;
const OGL_SAB_REPORT_INTERVAL_MS = 5000;
function publishOglSabFrame(width, height, frameView) {
  // Throttle to ~60 Hz: without this cap, the worker drives glReadPixels
  // at 150-200 Hz (no presenter pacing in SAB mode), eating GPU pthread
  // time that the CPU emulation pthread could otherwise use. Empirically
  // dropped gameSpeed from 98 % to 67 %. Capping the publish rate keeps the
  // readback at human-visible cadence without saturating the pipeline.
  const now = performance.now();
  if (now - oglSabLastPublishMs < OGL_SAB_MIN_INTERVAL_MS) {
    oglSabThrottleSkipCount += 1;
    maybeReportOglSabRates(now);
    return false;
  }
  oglSabLastPublishMs = now;

  // SAB allocation in core-host.js is sized to match this readback output
  // exactly (presentationScale × 320 × 240). On the rare path where sizes
  // diverge (e.g. presentation-scale change mid-run, currently not
  // supported), clip to the smaller buffer so we don't OOB.
  const sabBytes = oglPixelSabView.length;
  const fbBytes = frameView.length;
  const copyBytes = fbBytes < sabBytes ? fbBytes : sabBytes;
  if (copyBytes === 0) return false;
  if (copyBytes === sabBytes && copyBytes === fbBytes) {
    // Common path: same-size memcpy via TypedArray.set, which compiles to
    // a SIMD memmove on Chrome.
    oglPixelSabView.set(frameView);
  } else {
    oglPixelSabView.set(frameView.subarray(0, copyBytes));
    if (copyBytes < sabBytes) {
      oglPixelSabView.fill(0, copyBytes);
    }
  }
  // Bump the generation; main thread polls this with Atomics.load on RAF.
  Atomics.add(oglMetaSabView, 0, 1);
  oglSabWriteCount += 1;
  maybeReportOglSabRates(now);
  return true;
}
function maybeReportOglSabRates(now) {
  if (oglSabLastReportMs === 0) {
    oglSabLastReportMs = now;
    return;
  }
  const elapsed = now - oglSabLastReportMs;
  if (elapsed < OGL_SAB_REPORT_INTERVAL_MS) return;
  const writes = oglSabWriteCount;
  const skips = oglSabThrottleSkipCount;
  const writesPerSec = ((writes * 1000) / elapsed).toFixed(1);
  const skipsPerSec = ((skips * 1000) / elapsed).toFixed(1);
  const genValue = oglMetaSabView ? Atomics.load(oglMetaSabView, 0) : 0;
  // eslint-disable-next-line no-console
  console.log(
    `[ogl-sab] writes/s=${writesPerSec} skips/s=${skipsPerSec} ` +
    `gen=${genValue} renderBackend=${renderBackend} window=${(elapsed / 1000).toFixed(1)}s`
  );
  oglSabWriteCount = 0;
  oglSabThrottleSkipCount = 0;
  oglSabLastReportMs = now;
}

function presentFrameBytes(width, height, bytes, coreFrame) {
  const presentStartedAt = startProfileSample();
  if (coreFrame === lastPresentedCoreFrame) {
    updatePresentationFps();
    return;
  }

  const marker = prepareInputVisualMarker(coreFrame);
  const marked = frameWithInputMarker(bytes, width, height, marker);
  const markerApplied = marked.applied;
  const displayBytes = markerApplied ? marked.bytes : bytes;

  const drawStartedAt = startProfileSample();
  let markerOutputIssued = false;
  if (renderGpu) {
    drawFrameBytesToWebGpu(width, height, displayBytes);
    markerOutputIssued = markerApplied;
  } else if (renderGl) {
    drawFrameBytesToWebGl(width, height, displayBytes);
    markerOutputIssued = markerApplied;
  } else if (renderContext) {
    drawFrameBytesToCanvas(width, height, displayBytes);
    markerOutputIssued = markerApplied;
  }
  finishProfileSample("draw", drawStartedAt);
  if (markerOutputIssued) {
    recordInputMarkerSubmission(
      marker,
      coreFrame,
      `software-queued-${renderBackend}`,
      renderGpu?.device?.queue
    );
  }

  // §28cx tick-flicker fix (REAL one): feed the tick re-paint cache from THIS
  // clean paced frame. `bytes` is the queue entry's own stable copy, with dims
  // that match it. Previously _lastFrameCopy was only set by presentFrame —
  // which is NOT called in paced/tick mode — so it stayed frozen on an early
  // boot/garbage frame, and the 60Hz tick timer re-blitted that garbage
  // interleaved with the good paced frames → the rainbow flicker. Now the tick
  // always re-blits the latest GOOD frame (dims always match the bytes).
  if (bytes && bytes.byteLength > 0) {
    _lastFrameCopy = bytes;
    _lastFrameWidth = width;
    _lastFrameHeight = height;
    _lastFrameLength = bytes.byteLength;
    _lastFrameCopyValid = true;
  }

  const hashStartedAt = startProfileSample();
  if (!wgpuVisualCadenceEnabled) {
    recordVisualFrameHash(hashFrameBytes(bytes), true);
  }
  finishProfileSample("hash", hashStartedAt);
  recordPresentedFrame(coreFrame);
  finishProfileSample("present", presentStartedAt);
}

function hashFrameBytes(bytes) {
  if (!bytes?.byteLength) {
    return 0;
  }

  let hash = 2166136261;
  for (let index = 0; index < bytes.byteLength; index += VISUAL_HASH_SAMPLE_STRIDE_BYTES) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
    hash ^= bytes[index + 1] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= bytes[index + 2] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  hash ^= bytes.byteLength;
  return hash >>> 0;
}

function recordVisualFrameHash(hash, sampledSourceFrame = false) {
  if (!hash) {
    return;
  }

  visualFrameHash = hash >>> 0;
      recordInputVisibleObservation(visualFrameHash);
      if (sampledSourceFrame && causalMetricsEnabled) {
        recordSampledSourceFrame(frameReuseTelemetry, visualFrameHash);
      }
  if (lastVisualFrameHash && visualFrameHash !== lastVisualFrameHash) {
    visualChangesSincePresentationFps += 1;
  }
  lastVisualFrameHash = visualFrameHash;
}

function recordPresentedFrame(coreFrame) {
  presentedFrame += 1;
  framesSincePresentationFps += 1;
  presentationLifetimeFrameCount += 1;
  lastPresentedCoreFrame = coreFrame;
  const now = performance.now();
  if (lastPresentedAt > 0) {
    const interval = now - lastPresentedAt;
    intervalSumSincePresentationFps += interval;
    intervalSamplesSincePresentationFps.push(interval);
    maxIntervalSincePresentationFps = Math.max(maxIntervalSincePresentationFps, interval);
    if (interval > LONG_PRESENTATION_FRAME_MS) {
      longFramesSincePresentationFps += 1;
    }
    // Lifetime stats (never reset).
    if (interval > presentationLifetimeMaxIntervalMs) {
      presentationLifetimeMaxIntervalMs = interval;
      presentationLifetimeMaxIntervalAtMs = now;
    }
    // Welford online: numerically-stable streaming mean+variance.
    presentationIntervalCount += 1;
    const delta = interval - presentationIntervalMean;
    presentationIntervalMean += delta / presentationIntervalCount;
    const delta2 = interval - presentationIntervalMean;
    presentationIntervalM2 += delta * delta2;
    // Bucket the interval. Last bucket is the "200+ ms" catch-all.
    let bucket = PRESENTATION_HISTOGRAM_BUCKETS_MS.length;
    for (let i = 0; i < PRESENTATION_HISTOGRAM_BUCKETS_MS.length; i++) {
      if (interval < PRESENTATION_HISTOGRAM_BUCKETS_MS[i]) {
        bucket = i;
        break;
      }
    }
    presentationIntervalHistogram[bucket] += 1;
    // Anything past the 24 ms "long frame" threshold counts as a dropped
    // frame for end-of-run reporting. The 24 ms threshold matches
    // LONG_PRESENTATION_FRAME_MS and corresponds to >1 frame at 60 Hz
    // (16.67 ms target + 7 ms slack).
    if (interval > LONG_PRESENTATION_FRAME_MS) {
      presentationLifetimeDropCount += 1;
    }
  }
  lastPresentedAt = now;
  updatePresentationFps();
}

function updatePresentationFps() {
  const now = performance.now();
  if (now - lastPresentationFpsTime >= 500) {
    const profileElapsedMs = now - lastPresentationFpsTime;
    const rawFps = Math.round((framesSincePresentationFps * 1000) / profileElapsedMs);
    presentationRawFps = rawFps;
    presentationP95IntervalMs = roundedPercentile(intervalSamplesSincePresentationFps, 0.95);
    presentationFps =
      presentationP95IntervalMs > 0
        ? Math.min(rawFps, Math.round(1000 / presentationP95IntervalMs))
        : rawFps;
    presentationLoopFps = Math.round((loopsSincePresentationFps * 1000) / profileElapsedMs);
    presentationAverageIntervalMs =
      framesSincePresentationFps > 1
        ? Math.round((intervalSumSincePresentationFps / (framesSincePresentationFps - 1)) * 10) / 10
        : 0;
    presentationMaxIntervalMs = Math.round(maxIntervalSincePresentationFps * 10) / 10;
    presentationLongFrameCount = longFramesSincePresentationFps;
    presentationWindowUnderrunCount = presentationUnderrunsSinceFps;
    presentationWindowDropCount = presentationDropsSinceFps;
    visualChangeFps = Math.round((visualChangesSincePresentationFps * 1000) / profileElapsedMs);
    if (collectMetrics) {
      frameProfileStats = formatProfileWindow(profileElapsedMs);
      lastStructuredProfileWindow = stageWindowFromProfile(profileWindow, profileElapsedMs);
      profileWindow = createProfileWindow();
    } else {
      frameProfileStats = "metrics:off";
    }
    framesSincePresentationFps = 0;
    loopsSincePresentationFps = 0;
    visualChangesSincePresentationFps = 0;
    intervalSumSincePresentationFps = 0;
    intervalSamplesSincePresentationFps = [];
    maxIntervalSincePresentationFps = 0;
    longFramesSincePresentationFps = 0;
    presentationUnderrunsSinceFps = 0;
    presentationDropsSinceFps = 0;
    lastPresentationFpsTime = now;
    checkBootStallWatchdog();
  }
}

function checkBootStallWatchdog() {
  if (!coreBoot.accepted || !api) {
    watchdogLastCoreTicks = -1;
    watchdogStallCount = 0;
    return;
  }
  const coreFrame = api.getFrame?.() ?? 0;
  // Skip watchdog during JIT post-activation grace - JIT compile bursts
  // legitimately freeze the CPU briefly.
  if (
    ppcWasmJitActive &&
    (coreFrame >>> 0) - ppcWasmJitEnabledAtFrame < WASM_JIT_POST_ACTIVATION_GRACE_FRAMES
  ) {
    watchdogStallCount = 0;
    return;
  }

  const currentTicks = readCoreTicks();
  // Strict equality - only fire on a true freeze (no tick progress at all).
  // Earlier "slow but advancing" threshold caused the watchdog to fire
  // continuously during legitimate slow scenes (boot loading, complex
  // cutscenes), and each recovery step (force-pump, re-schedule) ate CPU
  // that the EmuThread needed to make progress, creating a feedback loop.
  if (currentTicks === watchdogLastCoreTicks && currentTicks > 0) {
    watchdogStallCount += 1;
  } else {
    watchdogStallCount = 0;
  }
  watchdogLastCoreTicks = currentTicks;

  if (watchdogStallCount < WATCHDOG_STALL_THRESHOLD) return;

  const step = watchdogStallCount - WATCHDOG_STALL_THRESHOLD;
  watchdogRecoveryCount += 1;
  if (step === 0 && frameSignalHeap && frameSignalIndex >= 0) {
    Atomics.store(frameSignalHeap, frameSignalIndex, (coreFrame >>> 0) + 1);
    Atomics.notify(frameSignalHeap, frameSignalIndex);
  } else if (step === 1) {
    lastHostPumpTime = 0;
    api.pumpHostJobs?.();
  } else if (step === 2) {
    schedulePresentationLoop();
  } else if (step === 3) {
    watchdogFireCount += 1;
    postStatus("Boot stall detected: core not advancing. Try reloading.");
  }
}

function roundedPercentile(samples, percentile) {
  if (!samples.length) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function createProfileWindow() {
  return {
    apiCount: 0,
    apiMs: 0,
    captureCount: 0,
    captureMs: 0,
    copyBytes: 0,
    copyCount: 0,
    copyMs: 0,
    drawCount: 0,
    drawMs: 0,
    hashCount: 0,
    hashMs: 0,
    loopCount: 0,
    loopMs: 0,
    pacedCount: 0,
    pacedMs: 0,
    presentCount: 0,
    presentMs: 0,
    pumpCount: 0,
    pumpMs: 0,
    runCount: 0,
    runMs: 0
  };
}

function startProfileSample() {
  return collectMetrics ? performance.now() : 0;
}

function finishProfileSample(name, startedAt) {
  if (!collectMetrics) {
    return 0;
  }

  const elapsedMs = performance.now() - startedAt;
  addProfileTime(name, elapsedMs);
  return elapsedMs;
}

function addProfileTime(name, elapsedMs) {
  if (!collectMetrics || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return;
  }

  const msKey = `${name}Ms`;
  const countKey = `${name}Count`;
  if (!(msKey in profileWindow) || !(countKey in profileWindow)) {
    return;
  }

  profileWindow[msKey] += elapsedMs;
  profileWindow[countKey] += 1;
  metricsDiagnostics.profileTimeSamples += 1;
}

function addProfileBytes(byteLength) {
  if (collectMetrics && Number.isFinite(byteLength) && byteLength > 0) {
    profileWindow.copyBytes += byteLength;
  }
}

function recordWorkerAudioMix(requested, returned, durationMs) {
  causalAudioStats.workerMixCount += 1;
  causalAudioStats.workerRequestedFrames += Math.max(0, Number(requested) || 0);
  causalAudioStats.workerReturnedFrames += Math.max(0, Number(returned) || 0);
  if (!(returned > 0)) causalAudioStats.workerEmptyMixCount += 1;
  if (causalMetricsEnabled && Number.isFinite(durationMs) && durationMs >= 0) {
    causalAudioStats.workerMixLastMs = durationMs;
    causalAudioStats.workerMixTotalMs += durationMs;
    causalAudioStats.workerMixMaxMs = Math.max(causalAudioStats.workerMixMaxMs, durationMs);
  }
}

function recordInputAge(sentAt, wrappedMilliseconds = false) {
  const sent = Number(sentAt);
  if (!Number.isFinite(sent) || sent <= 0) return;
  const age = wrappedMilliseconds
    ? (((Date.now() >>> 0) - (sent >>> 0)) >>> 0)
    : Date.now() - sent;
  if (!Number.isFinite(age) || age < 0 || age > 60000) return;
  causalInputStats.ageLastMs = age;
  causalInputStats.ageTotalMs += age;
  causalInputStats.ageSamples += 1;
  causalInputStats.ageMaxMs = Math.max(causalInputStats.ageMaxMs, age);
}

function wrappedEpochMilliseconds(lowBits) {
  const now = Date.now();
  const age = (((now >>> 0) - (Number(lowBits) >>> 0)) >>> 0);
  return age <= 60000 ? now - age : now;
}

function recordInputPhotonPadStatsPollParse({ sourceUtf16Bytes, elapsedMs, failed }) {
  if (!inputPhotonOverheadDiagnostics.enabled) return;
  const stats = inputPhotonOverheadDiagnostics.padStatsPollParse;
  const durationMs = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0;
  stats.calls += 1;
  stats.sourceUtf16Bytes += Math.max(0, Number(sourceUtf16Bytes) || 0);
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
  if (failed) stats.failureCount += 1;
}

function currentPadPollStats() {
  if (!inputLatencyDiagnostics || typeof api?.getVideoStats !== "function") return null;
  if (!inputPhotonOverheadDiagnostics.enabled) {
    try {
      return parsePadPollStats(api.getVideoStats());
    } catch {
      return null;
    }
  }

  const startedAt = performance.now();
  let source = null;
  let failed = false;
  try {
    source = api.getVideoStats();
    return parsePadPollStats(source);
  } catch {
    failed = true;
    return null;
  } finally {
    const elapsedMs = performance.now() - startedAt;
    const sourceUtf16Bytes = String(source || "").length * 2;
    recordInputPhotonPadStatsPollParse({ sourceUtf16Bytes, elapsedMs, failed });
  }
}

function recordInputApplied({ generation, inputMask: mask, sentAtEpochMs, source }) {
  if (!inputLatencyDiagnostics) return;
  const baseline = currentPadPollStats();
  inputVisibleLatencyTracker.recordApplied({
    generation,
    inputMask: mask,
    sentAtEpochMs,
    baselinePollCount: baseline?.pollCount ?? 0,
    baselineVisualHash: visualFrameHash,
    source
  });
  inputVisualMarkerTracker.recordApplied({
    generation,
    inputMask: mask,
    sentAtEpochMs,
    baselinePollCount: baseline?.pollCount ?? 0
  });
}

function recordInputVisibleObservation(hash) {
  if (!inputLatencyDiagnostics || !inputVisibleLatencyTracker.hasPending()) return;
  const pad = currentPadPollStats();
  if (!pad) return;
  inputVisibleLatencyTracker.recordObservation({
    pollCount: pad.pollCount,
    inputMask: pad.inputMask,
    visualHash: hash,
    coreFrame: api?.getFrame?.() ?? 0
  });
}

function prepareInputVisualMarker(coreFrame = api?.getFrame?.() ?? 0) {
  if (!inputLatencyDiagnostics) return null;
  // The optical baseline remains visible between inputs, but the expensive
  // GetVideoStats string/parse is needed only while an input awaits an exact
  // core poll. This keeps the diagnostic from polling all video telemetry on
  // every 60 Hz repaint.
  const pad = inputVisualMarkerTracker.hasPendingInput()
    ? currentPadPollStats()
    : null;
  if (pad) {
    inputVisualMarkerTracker.recordCorePoll({
      pollCount: pad.pollCount,
      inputMask: pad.inputMask,
      inputGeneration: pad.inputGeneration,
      coreFrame
    });
  }
  return inputVisualMarkerTracker.currentMarker();
}

function recordInputMarkerSubmission(marker, coreFrame, source, queue = null) {
  if (!marker?.needsSubmission) return false;
  const submitted = inputVisualMarkerTracker.recordMarkerSubmitted({
    generation: marker.generation,
    coreFrame,
    source
  });
  if (!submitted) return false;

  if (typeof queue?.onSubmittedWorkDone === "function") {
    Promise.resolve(queue.onSubmittedWorkDone()).then(() => {
      inputVisualMarkerTracker.recordMarkerCompleted({
        generation: marker.generation,
        coreFrame,
        source,
        completionKind: "gpu-queue-complete"
      });
    }).catch((error) => {
      recordRendererError("input-marker-completion", error?.message || error);
    });
  } else {
    inputVisualMarkerTracker.recordMarkerCompleted({
      generation: marker.generation,
      coreFrame,
      source,
      completionKind: "draw-issued"
    });
  }
  return true;
}

function formatProfileWindow(elapsedMs) {
  const avg = (name) => {
    const total = profileWindow[`${name}Ms`] || 0;
    const count = profileWindow[`${name}Count`] || 0;
    if (!count) {
      return "0";
    }
    const value = total / count;
    return value >= 10 ? value.toFixed(1) : value.toFixed(2);
  };
  const copiedMbPerSecond =
    elapsedMs > 0 ? (profileWindow.copyBytes / 1048576 / (elapsedMs / 1000)).toFixed(1) : "0.0";

  return (
    `loop:${avg("loop")} pump:${avg("pump")} run:${avg("run")} api:${avg("api")} ` +
    `cap:${avg("capture")} copy:${avg("copy")} present:${avg("present")} ` +
    `draw:${avg("draw")} hash:${avg("hash")} paced:${avg("paced")} ` +
    `copy:${copiedMbPerSecond}MB/s cap:${profileWindow.captureCount} shown:${profileWindow.presentCount}`
  );
}

async function setupSoftwarePresenter(canvas, presenterBackend) {
  rendererDiagnostics.requestedPresenterBackend = presenterBackend;
  renderCanvas = canvas;
  renderContext = null;
  renderGpu = null;
  renderGl = null;
  renderGlState = null;
  renderImageData = null;
  renderUploadBuffer = null;
  renderRequiresUploadCopy = false;

  if (presenterBackend === "webgpu") {
    try {
      renderGpu = await createWebGpuPresenter(renderCanvas);
      renderBackend = "webgpu";
      rendererDiagnostics.activePresenterBackend = renderBackend;
      postStatus("WebGPU presenter active");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rendererDiagnostics.fallback = { from: "webgpu", reason: message };
      recordRendererError("backend-fallback", message);
      postStatus(`WebGPU presenter unavailable: ${message}; falling back to WebGL`);
    }
  }

  if (presenterBackend !== "2d") {
    renderGl =
      renderCanvas.getContext("webgl2", softwareBlitContextAttributes()) ||
      renderCanvas.getContext("webgl", softwareBlitContextAttributes());
    if (renderGl) {
      renderBackend = "webgl";
      rendererDiagnostics.activePresenterBackend = renderBackend;
      renderGlState = createSoftwareBlitter(renderGl);
      return;
    }
  }

  renderContext = renderCanvas.getContext("2d", { alpha: false });
  renderBackend = renderContext ? "2d" : "none";
  rendererDiagnostics.activePresenterBackend = renderBackend;
  if (!renderContext) {
    throw new Error("Upstream software renderer could not create a worker canvas context");
  }
}

function normalizePresenterBackend(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "webgpu" || normalized === "wgpu") {
    return "webgpu";
  }
  if (normalized === "2d" || normalized === "canvas") {
    return "2d";
  }
  return "webgl";
}

function normalizeOglProxyMode(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "readback" || normalized === "bridge") {
    return "readback";
  }
  return normalized === "worker" || normalized === "offscreen" ? "worker" : "proxy";
}

async function createWebGpuPresenter(canvas) {
  const gpu = self.navigator?.gpu;
  const textureUsage = self.GPUTextureUsage;
  const shaderStage = self.GPUShaderStage;
  if (!gpu || !textureUsage || !shaderStage) {
    throw new Error("navigator.gpu is not available in this worker");
  }

  const adapter = await gpu.requestAdapter({ powerPreference: wgpuPowerPreference });
  if (!adapter) {
    throw new Error(`WebGPU adapter request (${wgpuPowerPreference}) returned null`);
  }

  let adapterInfo = adapter.info || null;
  if (!adapterInfo && typeof adapter.requestAdapterInfo === "function") {
    try { adapterInfo = await adapter.requestAdapterInfo(); } catch {}
  }
  rendererDiagnostics.adapter = {
    selected: true,
    vendor: adapterInfo?.vendor || null,
    architecture: adapterInfo?.architecture || null,
    device: adapterInfo?.device || null,
    description: adapterInfo?.description || null,
    features: [...adapter.features].sort(),
    limits: {
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  };
  // Depth clamp needs two optional WebGPU features. With bSupportsDepthClamp
  // true, upstream's vertex shader emits clip distances, and the translated
  // WGSL then needs the clip-distances extension: without it every vertex
  // shader fails with "extension 'clip_distances' is not allowed in the
  // current environment", which surfaces as missing pipelines and a black
  // frame rather than an error. depth-clip-control is what turns clipping
  // into clamping.
  const wantFeatures = ["clip-distances", "depth-clip-control"];
  const haveFeatures = wantFeatures.filter((f) => adapter.features && adapter.features.has(f));
  console.log("[wgpu-features] got=" + (haveFeatures.join(",") || "none") +
              " missing=" + (wantFeatures.filter((f) => !haveFeatures.includes(f)).join(",") || "none"));
  const device = await adapter.requestDevice(
    haveFeatures.length ? { requiredFeatures: haveFeatures } : undefined);
  rendererDiagnostics.device = {
    created: true,
    label: device.label || null,
    features: [...device.features].sort(),
    limits: {
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
    },
  };
  device.addEventListener?.("uncapturederror", (event) => {
    recordRendererError("uncaptured-error", event?.error?.message || event?.message || "unknown");
  });
  const format = typeof gpu.getPreferredCanvasFormat === "function" ? gpu.getPreferredCanvasFormat() : "bgra8unorm";
  const shaderModule = device.createShaderModule({
    label: "dolphin-xfb-presenter",
    code: `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertex_index], 0.0, 1.0);
  output.uv = uvs[vertex_index];
  return output;
}

@group(0) @binding(0) var frame_sampler: sampler;
@group(0) @binding(1) var frame_texture: texture_2d<f32>;

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(frame_texture, frame_sampler, input.uv);
}
`
  });
  // Day-21: linear filtering on the XFB→canvas blit. The GameCube
  // XFB is 640x480; the visible canvas is usually larger, so nearest
  // sampling magnified every texel into a hard block — and that
  // compounded fastsw=1's already-half-res output into a very chunky
  // image. Linear costs nothing on the GPU and smooths the upscale,
  // closer to how Dolphin's other backends present. (Native res is
  // unchanged; this is purely the final present-stage filter.)
  const sampler = device.createSampler({
    label: "dolphin-xfb-linear",
    magFilter: "linear",
    minFilter: "linear"
  });
  const bindGroupLayout = device.createBindGroupLayout({
    label: "dolphin-xfb-bind-layout",
    entries: [
      {
        binding: 0,
        visibility: shaderStage.FRAGMENT,
        sampler: { type: "filtering" }
      },
      {
        binding: 1,
        visibility: shaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" }
      }
    ]
  });
  const pipeline = device.createRenderPipeline({
    label: "dolphin-xfb-presenter-pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: "vs"
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs",
      targets: [{ format }]
    },
    primitive: {
      topology: "triangle-list"
    }
  });
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("OffscreenCanvas could not create a WebGPU context");
  }
  // Day-33 Phase C: configure the context up-front. Pre-cutover only
  // drawFrameBytesToWebGpu configured it (on the first XFB frame);
  // post-cutover that legacy path is dead, so the cmd-ring executor's
  // backbuffer pass (renderGpu.context.getCurrentTexture()) would
  // throw "context not configured" — silently swallowed, leaving the
  // visible canvas unpainted (the green). Idempotent re-configure
  // elsewhere is fine.
  try {
    context.configure({
      device,
      format,
      alphaMode: "opaque",
      usage: textureUsage.RENDER_ATTACHMENT |
        ((wgpuReplayClassifier || inputReadbackDiagnostics) ? textureUsage.COPY_SRC : 0) |
        (wgpuVisualCadenceEnabled ? textureUsage.TEXTURE_BINDING : 0)
    });
  } catch (e) {
    recordRendererError("validation", `context.configure: ${e?.message || e}`);
    postStatus(`WebGPU context.configure failed: ${e?.message || e}`);
  }
  const state = {
    bindGroup: null,
    bindGroupLayout,
    canvasHeight: 0,
    canvasWidth: 0,
    context,
    device,
    format,
    pipeline,
    sampler,
    texture: null,
    textureHeight: 0,
    textureView: null,
    textureWidth: 0,
    uploadBuffer: null
  };

  if (wgpuVisualCadenceEnabled) {
    ensureWgpuVisualCadenceResources(state);
    visualSampleSource = wgpuVisualCadenceTelemetry.source;
  }

  wgpuReplayFatal = null;

  device.lost.then((info) => {
    handleWgpuDeviceLoss({
      activeDevice: renderGpu?.device,
      lostDevice: device,
      info,
      recordError: recordRendererError,
      markFatal: markWgpuReplayFatal,
      cancelReplay: cancelWgpuReplayPump,
      clearReplayState: clearWgpuReplayStateAfterDeviceLoss,
      invalidateGeometry: () => {
        api?.setWebGpuGeometryPackEnabled?.(wgpuGeometryPackEnabled ? 1 : 0);
        api?.setWebGpuGeometryRangeEnabled?.(wgpuGeometryRangeEnabled ? 1 : 0);
      },
      clearActiveDevice: () => { renderGpu = null; },
      setBackend: (backend) => { renderBackend = backend; },
      postStatus,
    });
  });

  return state;
}

function ensureWgpuVisualCadenceResources(gpu = renderGpu) {
  if (!wgpuVisualCadenceEnabled || !gpu?.device || wgpuVisualCadenceResources) {
    return wgpuVisualCadenceResources;
  }
  const device = gpu.device;
  const sampleTexture = device.createTexture({
    label: "dolphin-wgpu-visual-sample",
    size: {
      width: WGPU_VISUAL_SAMPLE_WIDTH,
      height: WGPU_VISUAL_SAMPLE_HEIGHT,
      depthOrArrayLayers: 1
    },
    format: gpu.format,
    usage: 0x10 | 0x01 // RENDER_ATTACHMENT | COPY_SRC
  });
  const slots = Array.from({ length: WGPU_VISUAL_READBACK_RING_SIZE }, (_, index) => ({
    buffer: device.createBuffer({
      label: `dolphin-wgpu-visual-readback-${index}`,
      size: WGPU_VISUAL_READBACK_BYTES,
      usage: 0x01 | 0x08 // MAP_READ | COPY_DST
    }),
    sequence: 0,
    state: "idle"
  }));
  wgpuVisualCadenceResources = {
    sampleTexture,
    sampleView: sampleTexture.createView(),
    slots
  };
  return wgpuVisualCadenceResources;
}

function destroyWgpuVisualCadenceResources() {
  if (!wgpuVisualCadenceResources) return;
  try { wgpuVisualCadenceResources.sampleTexture?.destroy(); } catch {}
  for (const slot of wgpuVisualCadenceResources.slots || []) {
    try { slot.buffer?.destroy(); } catch {}
  }
  wgpuVisualCadenceResources = null;
}

function encodeWgpuVisualCadence(encoder, sourceTexture) {
  if (!wgpuVisualCadenceEnabled || !encoder || !sourceTexture || !renderGpu) {
    return null;
  }
  const telemetry = wgpuVisualCadenceTelemetry;
  telemetry.encodeAttemptCount += 1;
  const resources = ensureWgpuVisualCadenceResources(renderGpu);
  const slot = resources?.slots.find((candidate) => candidate.state === "idle");
  if (!slot) {
    telemetry.busyDropCount += 1;
    return null;
  }

  slot.state = "encoded";
  slot.sequence = ++wgpuVisualCadenceSequence;
  telemetry.inFlightCount += 1;
  telemetry.inFlightHighWater = Math.max(
    telemetry.inFlightHighWater,
    telemetry.inFlightCount
  );
  let pass = null;
  try {
    // Reuse the presenter's fullscreen triangle, sampler, bind-group layout,
    // and target format. Only the destination changes to a 96x72 texture.
    const bindGroup = renderGpu.device.createBindGroup({
      label: "dolphin-wgpu-visual-bind-group",
      layout: renderGpu.bindGroupLayout,
      entries: [
        { binding: 0, resource: renderGpu.sampler },
        { binding: 1, resource: sourceTexture.createView() }
      ]
    });
    pass = encoder.beginRenderPass({
      label: "dolphin-wgpu-visual-downsample",
      colorAttachments: [{
        view: resources.sampleView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(renderGpu.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    pass = null;
    encoder.copyTextureToBuffer(
      { texture: resources.sampleTexture },
      {
        buffer: slot.buffer,
        bytesPerRow: WGPU_VISUAL_BYTES_PER_ROW,
        rowsPerImage: WGPU_VISUAL_SAMPLE_HEIGHT
      },
      {
        width: WGPU_VISUAL_SAMPLE_WIDTH,
        height: WGPU_VISUAL_SAMPLE_HEIGHT,
        depthOrArrayLayers: 1
      }
    );
    telemetry.encodedSampleCount += 1;
    return slot;
  } catch (error) {
    try { pass?.end(); } catch {}
    telemetry.encodeErrorCount += 1;
    releaseWgpuVisualCadenceSlot(slot);
    recordRendererError("wgpu-visual-encode", error?.message || error);
    return null;
  }
}

function mapWgpuVisualCadenceSlot(slot, submitted) {
  if (!slot) return;
  if (!submitted) {
    releaseWgpuVisualCadenceSlot(slot);
    return;
  }
  slot.state = "mapping";
  slot.buffer.mapAsync(0x01).then(() => {
    const bytes = new Uint8Array(slot.buffer.getMappedRange());
    const hash = hashWgpuVisualSample(bytes);
    const telemetry = wgpuVisualCadenceTelemetry;
    if (slot.sequence > telemetry.latestCompletedSequence) {
      if (telemetry.latestHash && hash && telemetry.latestHash !== hash) {
        telemetry.changedSampleCount += 1;
      }
      telemetry.latestHash = hash;
      telemetry.latestCompletedSequence = slot.sequence;
      telemetry.completedSampleCount += 1;
      visualSampleSource = telemetry.source;
      recordVisualFrameHash(hash);
    }
    slot.buffer.unmap();
    releaseWgpuVisualCadenceSlot(slot);
  }).catch((error) => {
    wgpuVisualCadenceTelemetry.mapErrorCount += 1;
    try { slot.buffer.unmap(); } catch {}
    releaseWgpuVisualCadenceSlot(slot);
    recordRendererError("wgpu-visual-map", error?.message || error);
  });
}

function releaseWgpuVisualCadenceSlot(slot) {
  if (!slot || slot.state === "idle") return;
  slot.state = "idle";
  slot.sequence = 0;
  wgpuVisualCadenceTelemetry.inFlightCount = Math.max(
    0,
    wgpuVisualCadenceTelemetry.inFlightCount - 1
  );
}

// Day-17 (wasm-dolphin) C++ → JS bridge for the real WebGPU video
// backend (`?video=wgpu`). C++ `WebGPUGfx::PresentBackbuffer` calls
// `self.__dolphinWebGpuClear(r, g, b)` via EM_ASM to drive a real
// `wgpuRenderPass` clear on the canvas every frame. This replaces the
// Day-15 JS clear loop with a C++-owned render path; the next phases
// (17.3, 17.4) will extend this bridge with texture upload + blit so
// real game content reaches the canvas through the WebGPU backend.
//
// Why the bridge instead of issuing the render pass directly in C++:
// the canvas's WGPU context is configured on the discio worker's
// JS scope (via `createWebGpuPresenter`). Emscripten's webgpu.h
// exposes the device handle to C++, but the canvas surface is
// JS-side. Driving the pass through a `self`-scoped function keeps
// the surface bookkeeping in one place while letting C++ own the
// per-frame timing.
self.__dolphinWebGpuClear = function (r, g, b) {
  const gpu = renderGpu;
  if (!gpu || !gpu.context) return;
  try {
    const textureView = gpu.context.getCurrentTexture().createView();
    const encoder = gpu.device.createCommandEncoder({ label: "webgpu-real-clear" });
    const pass = encoder.beginRenderPass({
      label: "webgpu-real-clear-pass",
      colorAttachments: [{
        view: textureView,
        clearValue: { r, g, b, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
    gpuCompletionTracker.recordSubmittedWork(gpu.device.queue, "real-clear");
  } catch (e) {
    recordRendererError("real-clear-error", e?.message || e);
    postStatus(`WebGPU real-clear error: ${e?.message || e}`);
  }
};

function softwareBlitContextAttributes() {
  return {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
    stencil: false
  };
}

function createSoftwareBlitter(gl) {
  const program = createProgram(
    gl,
    `
attribute vec2 a_position;
attribute vec2 a_tex_coord;
varying vec2 v_tex_coord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_tex_coord = a_tex_coord;
}
`,
    `
precision mediump float;
uniform sampler2D u_frame;
varying vec2 v_tex_coord;

void main() {
  gl_FragColor = texture2D(u_frame, v_tex_coord);
}
`
  );
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  const vertices = new Float32Array([
    -1, 1, 0, 0,
    -1, -1, 0, 1,
    1, 1, 1, 0,
    1, -1, 1, 1
  ]);

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
  const position = gl.getAttribLocation(program, "a_position");
  const texCoord = gl.getAttribLocation(program, "a_tex_coord");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(texCoord);
  gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "u_frame"), 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  return {
    buffer,
    height: 0,
    program,
    texture,
    width: 0
  };
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Software blitter shader link failed: ${gl.getProgramInfoLog(program)}`);
  }

  return program;
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Software blitter shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }

  return shader;
}

function drawFrameToWebGpu(width, height, pointer, length) {
  if (!renderCanvas || !renderGpu || width <= 0 || height <= 0 || pointer <= 0 || length <= 0) {
    return;
  }

  drawFrameBytesToWebGpu(width, height, new Uint8Array(moduleInstance.HEAPU8.buffer, pointer, length));
}

function drawFrameBytesToWebGpu(width, height, frameView) {
  if (!renderCanvas || !renderGpu || width <= 0 || height <= 0 || !frameView?.byteLength) {
    return;
  }

  const gpu = renderGpu;
  const textureUsage = self.GPUTextureUsage;
  if (!textureUsage) {
    return;
  }

  if (renderCanvas.width !== width || renderCanvas.height !== height) {
    renderCanvas.width = width;
    renderCanvas.height = height;
  }

  if (gpu.canvasWidth !== width || gpu.canvasHeight !== height) {
    gpu.context.configure({
      alphaMode: "opaque",
      device: gpu.device,
      format: gpu.format,
      usage: textureUsage.RENDER_ATTACHMENT |
        ((wgpuReplayClassifier || inputReadbackDiagnostics) ? textureUsage.COPY_SRC : 0) |
        (wgpuVisualCadenceEnabled ? textureUsage.TEXTURE_BINDING : 0)
    });
    gpu.canvasWidth = width;
    gpu.canvasHeight = height;
  }

  if (gpu.textureWidth !== width || gpu.textureHeight !== height) {
    gpu.texture?.destroy?.();
    gpu.texture = gpu.device.createTexture({
      label: "dolphin-xfb-frame",
      size: { width, height, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      usage: textureUsage.COPY_DST | textureUsage.TEXTURE_BINDING
    });
    gpu.textureView = gpu.texture.createView();
    gpu.bindGroup = gpu.device.createBindGroup({
      label: "dolphin-xfb-bind-group",
      layout: gpu.bindGroupLayout,
      entries: [
        { binding: 0, resource: gpu.sampler },
        { binding: 1, resource: gpu.textureView }
      ]
    });
    gpu.textureWidth = width;
    gpu.textureHeight = height;
    gpu.uploadBuffer = null;
  }

  const rowBytes = width * 4;
  const bytesPerRow = alignTo(rowBytes, 256);
  const uploadView = webGpuUploadSource(gpu, frameView, rowBytes, bytesPerRow, height);
  gpu.device.queue.writeTexture(
    { texture: gpu.texture },
    uploadView,
    { bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 }
  );

  const encoder = gpu.device.createCommandEncoder({ label: "dolphin-xfb-presenter" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
        view: gpu.context.getCurrentTexture().createView()
      }
    ]
  });
  pass.setPipeline(gpu.pipeline);
  pass.setBindGroup(0, gpu.bindGroup);
  pass.draw(3);
  pass.end();
  gpu.device.queue.submit([encoder.finish()]);
  gpuCompletionTracker.recordSubmittedWork(gpu.device.queue, "software-present");
}

function webGpuUploadSource(gpu, frameView, rowBytes, bytesPerRow, height) {
  if (rowBytes === bytesPerRow) {
    return frameView;
  }

  const requiredBytes = bytesPerRow * height;
  if (!gpu.uploadBuffer || gpu.uploadBuffer.byteLength !== requiredBytes) {
    gpu.uploadBuffer = new Uint8Array(requiredBytes);
  }

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * bytesPerRow;
    gpu.uploadBuffer.set(frameView.subarray(sourceOffset, sourceOffset + rowBytes), targetOffset);
  }
  return gpu.uploadBuffer;
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function drawFrameToWebGl(width, height, pointer, length) {
  if (!renderCanvas || !renderGl || !renderGlState || width <= 0 || height <= 0 || pointer <= 0 || length <= 0) {
    return;
  }

  drawFrameBytesToWebGl(width, height, new Uint8Array(moduleInstance.HEAPU8.buffer, pointer, length));
}

function drawFrameBytesToWebGl(width, height, frameView) {
  if (!renderCanvas || !renderGl || !renderGlState || width <= 0 || height <= 0 || !frameView?.byteLength) {
    return;
  }

  if (renderCanvas.width !== width || renderCanvas.height !== height) {
    renderCanvas.width = width;
    renderCanvas.height = height;
  }

  const gl = renderGl;
  const uploadView = uploadSource(frameView);

  gl.useProgram(renderGlState.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderGlState.buffer);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, renderGlState.texture);
  gl.viewport(0, 0, width, height);

  try {
    if (renderGlState.width !== width || renderGlState.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, uploadView);
      renderGlState.width = width;
      renderGlState.height = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, uploadView);
    }
  } catch (error) {
    if (!renderRequiresUploadCopy) {
      renderRequiresUploadCopy = true;
      drawFrameBytesToWebGl(width, height, frameView);
      return;
    }
    throw error;
  }

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (typeof gl.commit === "function") {
    gl.commit();
  }
}

function uploadSource(frameView) {
  if (!renderRequiresUploadCopy) {
    return frameView;
  }

  if (!renderUploadBuffer || renderUploadBuffer.byteLength !== frameView.byteLength) {
    renderUploadBuffer = new Uint8Array(frameView.byteLength);
  }
  renderUploadBuffer.set(frameView);
  return renderUploadBuffer;
}

function drawFrameToCanvas(width, height, pointer, length) {
  if (!renderCanvas || !renderContext || width <= 0 || height <= 0 || pointer <= 0 || length <= 0) {
    return;
  }

  drawFrameBytesToCanvas(width, height, new Uint8ClampedArray(moduleInstance.HEAPU8.buffer, pointer, length));
}

function drawFrameBytesToCanvas(width, height, frameView) {
  if (!renderCanvas || !renderContext || width <= 0 || height <= 0 || !frameView?.byteLength) {
    return;
  }

  if (renderCanvas.width !== width || renderCanvas.height !== height) {
    renderCanvas.width = width;
    renderCanvas.height = height;
    renderImageData = null;
  }

  if (!renderImageData || renderImageData.width !== width || renderImageData.height !== height) {
    renderImageData = renderContext.createImageData(width, height);
  }

  renderImageData.data.set(frameView);
  renderContext.putImageData(renderImageData, 0, 0);
}

function joinedStats(ppcStats, videoStats, ...extraStats) {
  return [ppcStats, videoStats ? `video ${videoStats}` : "", ...extraStats].filter(Boolean).join(" | ");
}

function readCoreTicks() {
  const low = api?.getCoreTicksLow?.() ?? 0;
  const high = api?.getCoreTicksHigh?.() ?? 0;
  return (high >>> 0) * 0x100000000 + (low >>> 0);
}

function readCoreTicksPerSecond() {
  const ticksPerSecond = api?.getCoreTicksPerSecond?.() ?? 486000000;
  return Number.isFinite(ticksPerSecond) && ticksPerSecond > 0 ? ticksPerSecond : 486000000;
}

function postResult(request, result) {
  const { transfer = [] } = result ?? {};
  let replyResult = result ?? {};
  if (causalMetricsEnabled) {
    replyResult = {
      ...replyResult,
      telemetryTransferBytes: transfer.reduce(
        (total, value) => total + (Number(value?.byteLength) || 0),
        0
      )
    };
  }
  const planned = planWorkerSuccessReply(request, replyResult, { legacyOneWayAck });
  if (planned.suppress) {
    workerTransportStats.oneWaySuccessRepliesSuppressed += 1;
    workerTransportStats.estimatedOneWaySuccessReplyJsonBytesAvoided +=
      planned.estimatedReplyJsonBytes;
    return;
  }
  if (planned.oneWay) {
    workerTransportStats.oneWayLegacySuccessRepliesSent += 1;
  } else {
    workerTransportStats.requestSuccessRepliesSent += 1;
  }
  self.postMessage(planned.reply, planned.transfer);
}

function normalizedCoreSelection(reported, activeCoreUrl, activeCoreSha256) {
  const resolvedActiveUrl = new URL(activeCoreUrl, self.location.href).href;
  const fallbackReason = reported?.fallbackReason
    ? String(reported.fallbackReason).slice(0, 1000)
    : null;
  return {
    requestedCoreSha256: String(
      reported?.requestedCoreSha256 || activeCoreSha256 || ""
    ),
    requestedCoreUrl: String(reported?.requestedCoreUrl || resolvedActiveUrl),
    activeCoreSha256: String(activeCoreSha256 || ""),
    activeCoreUrl: resolvedActiveUrl,
    fallbackReason,
    fallbackBeforeCanvasTransfer: Boolean(
      fallbackReason && reported?.fallbackBeforeCanvasTransfer
    ),
  };
}

function workerTransportTelemetry() {
  return { ...workerTransportStats };
}

function readLastLoadedCheckpoint() {
  if (!api?.getLastLoadedCheckpointGeneration) {
    return { generation: 0, ticks: null, ppcPc: null };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generationBefore = api.getLastLoadedCheckpointGeneration() >>> 0;
    if (!generationBefore) return { generation: 0, ticks: null, ppcPc: null };
    const low = api.getLastLoadedCoreTicksLow?.() ?? 0;
    const high = api.getLastLoadedCoreTicksHigh?.() ?? 0;
    const ppcPc = api.getLastLoadedPpcPc?.() ?? 0;
    const generationAfter = api.getLastLoadedCheckpointGeneration() >>> 0;
    if (generationBefore === generationAfter) {
      return {
        generation: generationAfter,
        ticks: (high >>> 0) * 0x100000000 + (low >>> 0),
        ppcPc
      };
    }
  }
  return { generation: 0, ticks: null, ppcPc: null };
}

function postStatus(message) {
  const text = String(message);
  const entry = {
    atMs: Number(performance.now().toFixed(3)),
    message: text.slice(0, 1000),
  };
  rendererDiagnostics.statusHistory.push(entry);
  if (rendererDiagnostics.statusHistory.length > 128) rendererDiagnostics.statusHistory.shift();
  if (isFatalStatusMessage(text)) {
    rendererDiagnostics.fatalStatusHistory.push(entry);
    if (rendererDiagnostics.fatalStatusHistory.length > 128) {
      rendererDiagnostics.fatalStatusHistory.shift();
    }
  }
  self.postMessage({
    type: "status",
    message: text
  });
}

function isFatalStatusMessage(message) {
  return /(?:webgpu[^\n]*(?:validation|device[ -]lost|uncaptured|real-clear error|show-image draw error|unavailable|fail|missing|threw|error)|emscripten abort|aborted\(|webassembly\.(?:linkerror|runtimeerror)|worker rpc[^\n]*timed out)/i.test(
    String(message || "")
  );
}

// Day-7 persistent JIT cache. The master cache lives here on the discio
// worker. We load it from IndexedDB at boot and persist new compiles back
// to IDB so the next session boots with a pre-warmed cache. At factory()
// return time we postMessage the cache to every pthread worker in the
// pool so each pthread can consult it from its EM_JS compile body. Each
// pthread instantiates cached Modules locally on its own wasmTable —
// bypassing the cross-pthread-table problem from Day 6.
const dolphinJitCacheMap = new Map(); // Map<canonical SHA-256 key, WebAssembly.Module>
const DOLPHIN_JIT_IDB_NAME = "dolphin-jit-cache";
const DOLPHIN_JIT_IDB_STORE = "modules";
const DOLPHIN_JIT_IDB_META = "metadata";
const DOLPHIN_JIT_IDB_VERSION = 3;
// §28u: 8192 was far too small for full Melee — the user's cache
// plateaued at ~8135 (cap hit) while still in the menus, so EVERY
// later 3D scene (intro/2nd cutscene, battle) exceeded the cap →
// `handleDolphinJitNewCompile` early-returns at line ~2858 → those
// blocks are never cached NOR persisted to IDB → they recompile
// from scratch on every run → perpetual compile-burst BLACK + speed
// collapse (img12 34 %, img19 57 %) on exactly the 3D scenes.
// Raising the cap 6× lets the cache cover the whole game; combined
// with the existing IDB persistence the cutscene/battle blocks now
// survive and pre-warm subsequent runs (no re-burst). Entries are
// small per-block WebAssembly.Modules (raw bytes live in IDB, not
// the Map) so 6× is a modest memory delta on a 1.36 GB-game tab.
const DOLPHIN_JIT_CACHE_MAX = 49152; // hard cap on in-memory entries
// §28bw / §28cg / §28cv / §28cw revert: probe-validated PTHREAD_POOL_SIZE=8
// + 16k cache config FAILED in real Chrome — audio drops 18u/16d despite
// 0u/0d in headless probe. Reverted PTHREAD_POOL_SIZE to 16; reverted cache
// cap to 8192 to maintain the 192k Module memory ceiling. Lesson: headless
// probe doesn't capture real-Chrome main-thread contention from compositor,
// extensions, GC. ALWAYS validate in real browser before shipping changes
// to PTHREAD_POOL_SIZE.
const DOLPHIN_JIT_IDB_BOOT_LOAD_MAX = 8192;
const DOLPHIN_JIT_FINGERPRINT_KEY = "buildFingerprint";
const DOLPHIN_JIT_ENTRY_KEY_SCHEMA_KEY = "entryKeySchema";
let dolphinJitIdb = null;
let dolphinJitIdbWritesPending = 0;
let dolphinJitIdbWriteCount = 0;
async function verifyDolphinJitEntries(entries, batchSize = 64) {
  const verified = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (entry) => {
      const key = String(entry.hash ?? entry.key ?? "");
      const value = entry.bytes ?? entry.value;
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      if (!(bytes instanceof Uint8Array)) return null;
      return await verifyCanonicalWasmBlockKey(key, bytes) ? { ...entry, key, bytes } : null;
    }));
    if (results.some((entry) => entry === null)) return null;
    verified.push(...results);
  }
  return verified;
}
function openDolphinJitIdb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DOLPHIN_JIT_IDB_NAME, DOLPHIN_JIT_IDB_VERSION);
    } catch (err) {
      postStatus(`jit-cache: indexedDB.open failed: ${err?.message || err}`);
      resolve(null);
      return;
    }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // v3 replaces collision-prone FNV keys with canonical SHA-256 keys.
      // Existing rows cannot be migrated without re-hashing their bytes, so
      // drop them atomically and let the current build repopulate the store.
      if (event.oldVersion < 3 && db.objectStoreNames.contains(DOLPHIN_JIT_IDB_STORE)) {
        db.deleteObjectStore(DOLPHIN_JIT_IDB_STORE);
      }
      if (!db.objectStoreNames.contains(DOLPHIN_JIT_IDB_STORE)) {
        db.createObjectStore(DOLPHIN_JIT_IDB_STORE);
      }
      if (!db.objectStoreNames.contains(DOLPHIN_JIT_IDB_META)) {
        db.createObjectStore(DOLPHIN_JIT_IDB_META);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      postStatus(`jit-cache: indexedDB.open error: ${request.error?.message || "unknown"}`);
      resolve(null);
    };
  });
}
function readDolphinJitMetadata(db, key) {
  return new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const tx = db.transaction(DOLPHIN_JIT_IDB_META, "readonly");
      const req = tx.objectStore(DOLPHIN_JIT_IDB_META).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
function writeDolphinJitMetadata(db, key, value) {
  return new Promise((resolve) => {
    if (!db) { resolve(false); return; }
    try {
      const tx = db.transaction(DOLPHIN_JIT_IDB_META, "readwrite");
      const req = tx.objectStore(DOLPHIN_JIT_IDB_META).put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
function clearDolphinJitModulesStore(db) {
  return new Promise((resolve) => {
    if (!db) { resolve(false); return; }
    try {
      const tx = db.transaction(DOLPHIN_JIT_IDB_STORE, "readwrite");
      const req = tx.objectStore(DOLPHIN_JIT_IDB_STORE).clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
async function loadDolphinJitCacheFromIdb(db) {
  if (!db) return 0;
  const entries = await new Promise((resolve) => {
    const out = [];
    try {
      const tx = db.transaction(DOLPHIN_JIT_IDB_STORE, "readonly");
      const store = tx.objectStore(DOLPHIN_JIT_IDB_STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        out.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(out);
      tx.onerror = () => resolve(out);
    } catch (err) {
      postStatus(`jit-cache: IDB load failed: ${err?.message || err}`);
      resolve(out);
    }
  });
  let loaded = 0;
  // §28ao: was a SEQUENTIAL `await WebAssembly.compile` per entry —
  // for a warm cache (10k+ blocks) that is a 5-20 s wall blocking the
  // whole boot ("title takes a while", agent-confirmed). Compile in
  // PARALLEL batches via Promise.allSettled (browser uses all cores);
  // warm-boot compile drops to ~1-3 s. Module is structured-cloneable
  // so each pthread still receives ready-to-instantiate Modules.
  const COMPILE_BATCH = 64;
  for (let i = 0; i < entries.length; i += COMPILE_BATCH) {
    if (dolphinJitCacheMap.size >= DOLPHIN_JIT_IDB_BOOT_LOAD_MAX) break;
    const candidates = [];
    for (const { key, value } of entries.slice(i, i + COMPILE_BATCH)) {
      if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) continue;
      if (dolphinJitCacheMap.has(key)) continue;
      const buf = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      candidates.push({ key: String(key), buf });
    }
    const verified = await Promise.all(candidates.map(async ({ key, buf }) => ({
      key,
      buf,
      valid: await verifyCanonicalWasmBlockKey(String(key), buf)
    })));
    const batch = verified
      .filter(({ valid }) => valid)
      .map(({ key, buf }) => ({ key, p: WebAssembly.compile(buf) }));
    const res = await Promise.allSettled(batch.map((b) => b.p));
    for (let k = 0; k < res.length; k++) {
      if (res[k].status === "fulfilled") {
        dolphinJitCacheMap.set(batch[k].key, res[k].value);
        loaded += 1;
      }
      // rejected = corrupt entry; skipped, re-cached on next miss.
    }
  }
  return loaded;
}
async function writeDolphinJitEntryToIdb(hash, bytes) {
  if (!dolphinJitIdb) return;
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (!(buf instanceof Uint8Array) || !(await verifyCanonicalWasmBlockKey(String(hash), buf))) {
    if (!self._dolphinJitIdbIdentityErrLogged) {
      self._dolphinJitIdbIdentityErrLogged = true;
      postStatus("jit-cache: rejected IDB write with mismatched block identity");
    }
    return;
  }
  try {
    const tx = dolphinJitIdb.transaction(DOLPHIN_JIT_IDB_STORE, "readwrite");
    tx.onabort = () => {
      if (!self._dolphinJitIdbTxAbortLogged) {
        self._dolphinJitIdbTxAbortLogged = true;
        postStatus(`jit-cache: IDB tx abort: ${tx.error?.message || "unknown"}`);
      }
    };
    const store = tx.objectStore(DOLPHIN_JIT_IDB_STORE);
    dolphinJitIdbWritesPending += 1;
    const req = store.put(buf, hash);
    req.onsuccess = () => {
      dolphinJitIdbWritesPending -= 1;
      dolphinJitIdbWriteCount += 1;
      if (
        dolphinJitIdbWriteCount === 100 ||
        dolphinJitIdbWriteCount % 500 === 0
      ) {
        postStatus(
          `jit-cache: IDB writes=${dolphinJitIdbWriteCount} pending=${dolphinJitIdbWritesPending}`
        );
      }
    };
    req.onerror = () => {
      dolphinJitIdbWritesPending -= 1;
      if (!self._dolphinJitIdbWriteErrLogged) {
        self._dolphinJitIdbWriteErrLogged = true;
        postStatus(`jit-cache: IDB write error: ${req.error?.message || "unknown"}`);
      }
    };
  } catch (err) {
    if (!self._dolphinJitIdbWriteErrLogged) {
      self._dolphinJitIdbWriteErrLogged = true;
      postStatus(`jit-cache: IDB write threw: ${err?.message || err}`);
    }
  }
}
async function fetchWasmAndFingerprint(coreUrlValue, expectedSha256 = DEFAULT_UPSTREAM_CORE_SHA256) {
  // coreUrlValue points at the JS shim (dolphin-core-upstream.js). The
  // wasm sits beside it under the conventional name.
  const wasmUrl = new URL("dolphin-core-upstream.wasm", coreUrlValue).href;
  let buffer = null;
  try {
    const resp = await fetch(wasmUrl);
    if (!resp.ok) {
      throw new Error(`Core WASM fetch returned ${resp.status}`);
    }
    buffer = await resp.arrayBuffer();
  } catch (err) {
    throw new Error(`Core WASM fetch failed: ${err?.message || err}`);
  }
  const actualSha256 = await sha256Hex(buffer);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Core WASM SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  // The verified artifact digest is already available. Reuse the complete
  // SHA-256 rather than a sampled fingerprint that can alias distinct cores.
  const fingerprint = canonicalCoreFingerprint(actualSha256);
  return { wasmBinary: buffer, fingerprint, sha256: actualSha256 };
}
// Open IDB eagerly so loadCore() doesn't pay the open latency. Module load
// is deferred until the build fingerprint is computed (after fetching the
// wasm) so we can skip / clear stale entries from a previous build.
const dolphinJitIdbReady = (async () => {
  dolphinJitIdb = await openDolphinJitIdb();
})();
// When the persistent JIT cache loaded a non-trivial number of modules
// for this build at boot, maybeEnablePpcWasmJit will skip the warmup
// frame gate and engage JIT essentially immediately. Without this,
// warm boots wait 700+ stable video frames (15+ seconds) before JIT
// kicks in, even though the cache could service the first compile
// burst near-instantly. Threshold is intentionally low (>= 50): the
// cache only needs to absorb the initial burst, not the whole game.
let dolphinJitCachePreWarmed = false;
const DOLPHIN_JIT_PREWARM_THRESHOLD = 50;
// §28cg fetch + decode the prebuilt JIT cache (if present) and bulk-insert
// its modules into IDB BEFORE reconcileJitCacheWithBuild runs. Returns the
// number of entries seeded (0 if no file, fingerprint mismatch, or IDB has
// equal-or-better coverage already).
async function maybeSeedIdbFromPrebuiltCache(coreUrlValue, currentFingerprint) {
  await dolphinJitIdbReady;
  if (!dolphinJitIdb || !currentFingerprint) return 0;
  // Skip when IDB already has matching-fingerprint entries — the prebuilt
  // file is for FIRST-session cold start only. Once IDB has accumulated
  // real entries, the user's own cache is a better fit than our shipped one.
  const storedFp = await readDolphinJitMetadata(dolphinJitIdb, DOLPHIN_JIT_FINGERPRINT_KEY);
  if (storedFp === currentFingerprint) {
    const existingCount = await new Promise((resolve) => {
      try {
        const tx = dolphinJitIdb.transaction(DOLPHIN_JIT_IDB_STORE, "readonly");
        const req = tx.objectStore(DOLPHIN_JIT_IDB_STORE).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      } catch { resolve(0); }
    });
    if (existingCount >= DOLPHIN_JIT_PREWARM_THRESHOLD) {
      // User's IDB already pre-warmed enough — no need to seed from prebuilt.
      return 0;
    }
  }
  const prebuiltUrl = new URL("prebuilt-jit-cache.bin", coreUrlValue).href;
  let buffer;
  try {
    const resp = await fetch(prebuiltUrl);
    if (!resp.ok) {
      // 404 is normal — the build just didn't ship a prebuilt cache.
      return 0;
    }
    buffer = await resp.arrayBuffer();
  } catch {
    return 0;
  }
  let decoded;
  try {
    decoded = decodePrebuiltCache(buffer);
  } catch (err) {
    postStatus(`jit-cache: prebuilt decode failed: ${err?.message || err}`);
    return 0;
  }
  if (decoded.fingerprint !== currentFingerprint) {
    postStatus(
      `jit-cache: prebuilt fingerprint mismatch (file=${decoded.fingerprint.slice(0, 8)} build=${currentFingerprint.slice(0, 8)}); ignored`
    );
    return 0;
  }
  if (decoded.entryKeySchema !== JIT_CACHE_ENTRY_KEY_SCHEMA) {
    postStatus("jit-cache: prebuilt entry-key schema mismatch; ignored");
    return 0;
  }
  const verifiedEntries = await verifyDolphinJitEntries(decoded.entries);
  if (!verifiedEntries) {
    postStatus("jit-cache: prebuilt block identity mismatch; entire file ignored");
    return 0;
  }
  // §28ch: only seed the FIRST DOLPHIN_JIT_IDB_BOOT_LOAD_MAX entries into
  // IDB synchronously — past testing showed a 16k-entry IDB tx blocks the
  // main thread ~3s and re-inflates the startup freeze the prebuilt cache
  // was meant to fix. Stash the OVERFLOW in `dolphinJitPrebuiltOverflow`;
  // the lazy-fill task drains it post-boot and writes-back to IDB after
  // each successful compile so subsequent sessions read from the IDB path.
  const boot = verifiedEntries.slice(0, DOLPHIN_JIT_IDB_BOOT_LOAD_MAX);
  const overflow = verifiedEntries.slice(DOLPHIN_JIT_IDB_BOOT_LOAD_MAX);
  if (overflow.length > 0) {
    dolphinJitPrebuiltOverflow = overflow;
  }
  const seeded = await new Promise((resolve) => {
    try {
      const tx = dolphinJitIdb.transaction(DOLPHIN_JIT_IDB_STORE, "readwrite");
      const store = tx.objectStore(DOLPHIN_JIT_IDB_STORE);
      let inserted = 0;
      for (const { key, bytes } of boot) {
        store.put(bytes, key);
        inserted += 1;
      }
      tx.oncomplete = () => resolve(inserted);
      tx.onerror = () => resolve(0);
      tx.onabort = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
  // Stamp the fingerprint too so reconcileJitCacheWithBuild treats this as
  // a same-build cache and just loads (vs clearing) the seeded modules.
  if (seeded > 0) {
    await writeDolphinJitMetadata(dolphinJitIdb, DOLPHIN_JIT_FINGERPRINT_KEY, currentFingerprint);
    await writeDolphinJitMetadata(
      dolphinJitIdb,
      DOLPHIN_JIT_ENTRY_KEY_SCHEMA_KEY,
      JIT_CACHE_ENTRY_KEY_SCHEMA
    );
    postStatus(`jit-cache: seeded ${seeded} prebuilt modules into IDB (fingerprint match)`);
  }
  return seeded;
}

async function reconcileJitCacheWithBuild(fingerprint) {
  await dolphinJitIdbReady;
  if (!dolphinJitIdb) return 0;
  const [storedFingerprint, storedEntryKeySchema] = await Promise.all([
    readDolphinJitMetadata(dolphinJitIdb, DOLPHIN_JIT_FINGERPRINT_KEY),
    readDolphinJitMetadata(dolphinJitIdb, DOLPHIN_JIT_ENTRY_KEY_SCHEMA_KEY)
  ]);
  const identity = classifyJitCacheIdentity({
    storedFingerprint,
    storedEntryKeySchema,
    currentFingerprint: fingerprint
  });
  if (identity.reset) {
    await clearDolphinJitModulesStore(dolphinJitIdb);
    dolphinJitCacheMap.clear();
    dolphinJitPrebuiltOverflow = null;
    postStatus(
      `jit-cache: identity reset (${identity.reason}); cleared unverified modules`
    );
  }
  if (fingerprint) {
    await Promise.all([
      writeDolphinJitMetadata(dolphinJitIdb, DOLPHIN_JIT_FINGERPRINT_KEY, fingerprint),
      writeDolphinJitMetadata(
        dolphinJitIdb,
        DOLPHIN_JIT_ENTRY_KEY_SCHEMA_KEY,
        JIT_CACHE_ENTRY_KEY_SCHEMA
      )
    ]);
  } else {
    return 0;
  }
  const loaded = await loadDolphinJitCacheFromIdb(dolphinJitIdb);
  if (loaded > 0) {
    postStatus(`jit-cache: loaded ${loaded} compiled modules from IndexedDB`);
  }
  if (loaded >= DOLPHIN_JIT_PREWARM_THRESHOLD) {
    dolphinJitCachePreWarmed = true;
    postStatus(
      `jit-cache: pre-warmed with ${loaded} modules; JIT warmup gate will be skipped on this session`
    );
  }
  return loaded;
}
let dolphinJitNewCompileCount = 0;
let dolphinJitCompilePending = 0;
const dolphinJitVerificationPending = new Set();
async function handleDolphinJitNewCompile(event) {
  const data = event.data;
  if (!data || data.type !== "dolphin-jit-new-compile") return;
  if (!data.hash || !data.bytes) return;
  const key = String(data.hash);
  const bytes = data.bytes instanceof ArrayBuffer ? new Uint8Array(data.bytes) : data.bytes;
  if (!(bytes instanceof Uint8Array)) return;
  if (dolphinJitCacheMap.has(key) || dolphinJitVerificationPending.has(key)) return;
  if (dolphinJitCacheMap.size >= DOLPHIN_JIT_CACHE_MAX) return;
  dolphinJitVerificationPending.add(key);
  let valid = false;
  try {
    valid = await verifyCanonicalWasmBlockKey(String(data.hash), bytes);
  } finally {
    dolphinJitVerificationPending.delete(key);
  }
  if (!valid) {
    if (!self._dolphinJitIncomingIdentityErrLogged) {
      self._dolphinJitIncomingIdentityErrLogged = true;
      postStatus("jit-cache: rejected pthread compile with mismatched block identity");
    }
    return;
  }
  if (dolphinJitCacheMap.has(key)) return;
  dolphinJitNewCompileCount += 1;
  // Reserve the slot synchronously so duplicate notifications dedupe even
  // before the async compile finishes. Replace with the real Module once
  // compilation completes. Async to keep discio off-critical-path. After
  // the compile lands, persist to IndexedDB so subsequent boots can
  // pre-warm without recompiling.
  dolphinJitCacheMap.set(key, null);
  // Persist bytes synchronously (fire-and-forget IDB put). Storage format
  // is raw wasm bytes; we recompile at boot. WebAssembly.Module storage in
  // IDB proved unreliable empirically (put().oncomplete fires but
  // req.onsuccess never does, and the data doesn't survive). Bytes are
  // boring TypedArrays and clone reliably.
  void writeDolphinJitEntryToIdb(key, bytes);
  dolphinJitCompilePending += 1;
  WebAssembly.compile(bytes).then((mod) => {
    dolphinJitCacheMap.set(key, mod);
  }).catch((err) => {
    dolphinJitCacheMap.delete(key);
    if (!self._dolphinJitNewCompileErrLogged) {
      self._dolphinJitNewCompileErrLogged = true;
      postStatus(`jit-cache: async compile-on-discio failed: ${err?.message || err}`);
    }
  }).finally(() => {
    dolphinJitCompilePending -= 1;
  });
  if (
    dolphinJitNewCompileCount === 1 ||
    dolphinJitNewCompileCount === 10 ||
    dolphinJitNewCompileCount % 100 === 0
  ) {
    postStatus(
      `jit-cache: discio recorded ${dolphinJitNewCompileCount} new compiles (cache size=${dolphinJitCacheMap.size})`
    );
  }
}
// §28ch lazy-fill state. Stored at module scope so the background fill
// task (kicked off after reconcileJitCacheWithBuild) can broadcast new
// modules to pthread workers as they become available.
let dolphinJitPthreadWorkers = [];
let dolphinJitPthreadRuntime = null;
let dolphinJitCachePersistenceEnabled = false;
let dolphinJitBootLoadComplete = false;
let dolphinJitBootLoadedEntries = 0;
let dolphinJitLazyFillActive = false;
let dolphinJitLazyFillStarted = false;
let dolphinJitLazyFillCompleted = false;
let dolphinJitLazyFillSourceEntries = 0;
let dolphinJitLazyFillProcessedEntries = 0;
let dolphinJitLazyFillAddedEntries = 0;
let dolphinJitLazyFillTerminalReason = "not-started";
let dolphinJitLazyFillFailureCount = 0;
let dolphinJitLazyFillPromise = null;
let dolphinJitPthreadBarrierGeneration = 0;
let dolphinJitPthreadBarrierExpected = 0;
let dolphinJitPthreadBarrierAcked = 0;
let dolphinJitPthreadInstallPostFailures = 0;
let dolphinJitPthreadBarrierInvalidAcks = 0;
const dolphinJitPthreadBarrierAckGeneration = new WeakMap();
const dolphinJitPthreadBarrierListeners = new WeakSet();
const dolphinJitPthreadCompileListeners = new WeakSet();
// §28ch overflow buffer: prebuilt entries beyond the boot-load cap that
// we DON'T write to IDB upfront (the 20MiB IDB tx blocked the main thread
// long enough to inflate the startup freeze). Lazy fill compiles from
// here, then writes-back to IDB after each successful compile so subsequent
// sessions can read from the existing IDB-path.
let dolphinJitPrebuiltOverflow = null;

function handleDolphinJitPthreadBarrierAck(event, worker) {
  const data = event.data;
  if (data?.type !== "dolphin-jit-cache-barrier-ack") return;
  if (Number(data.generation) !== dolphinJitPthreadBarrierGeneration) return;
  if (dolphinJitPthreadBarrierAckGeneration.get(worker) === data.generation) return;
  if (data.installed !== true || !Number.isFinite(Number(data.cacheSize))) {
    dolphinJitPthreadBarrierInvalidAcks += 1;
    return;
  }
  dolphinJitPthreadBarrierAckGeneration.set(worker, data.generation);
  dolphinJitPthreadBarrierAcked += 1;
}

function handleDolphinJitPthreadBarrierAckEvent(event) {
  handleDolphinJitPthreadBarrierAck(event, event.currentTarget);
}

function ensureDolphinJitPthreadListeners(worker) {
  if (!dolphinJitPthreadBarrierListeners.has(worker)) {
    worker.addEventListener("message", handleDolphinJitPthreadBarrierAckEvent);
    dolphinJitPthreadBarrierListeners.add(worker);
  }
  if (!dolphinJitPthreadCompileListeners.has(worker)) {
    worker.addEventListener("message", handleDolphinJitNewCompile);
    dolphinJitPthreadCompileListeners.add(worker);
  }
}

function publishDolphinJitPthreadBarrier(workers = dolphinJitPthreadWorkers) {
  const targets = [...new Set(workers)];
  dolphinJitPthreadBarrierGeneration += 1;
  dolphinJitPthreadBarrierExpected = targets.length;
  dolphinJitPthreadBarrierAcked = 0;
  dolphinJitPthreadBarrierInvalidAcks = 0;
  for (const worker of targets) {
    try {
      worker.postMessage({
        type: "dolphin-jit-cache-barrier",
        generation: dolphinJitPthreadBarrierGeneration,
      });
    } catch {
      dolphinJitPthreadInstallPostFailures += 1;
    }
  }
}

async function waitForDolphinJitPthreadBarrier(timeoutMs = 30_000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= timeoutMs) {
    if (dolphinJitPthreadInstallPostFailures > 0) return false;
    if (dolphinJitPthreadBarrierAcked === dolphinJitPthreadBarrierExpected) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

export async function installDolphinPthreadChannels(
  moduleInstance,
  { jitCacheEnabled = true } = {}
) {
  const pthread = moduleInstance?.PThread;
  dolphinJitPthreadRuntime = pthread || null;
  if (!pthread) {
    if (jitCacheEnabled) {
      postStatus("jit-cache: Module.PThread unavailable; persistent JIT cache disabled");
    }
    return;
  }
  const workers = [...new Set([
    ...(pthread.runningWorkers || []),
    ...(pthread.unusedWorkers || [])
  ])];

  // These messages originate on whichever pthread owns Dolphin's video
  // thread. They are transport, not JIT-cache functionality.
  const transportListeners = [
    ["detached OGL frame", handleDetachedOglFrame],
    ["WebGPU show-image", handleWebGpuShowImage],
    ["WebGPU command ring", handleWebGpuCmdRing]
  ];
  for (const worker of workers) {
    for (const [label, listener] of transportListeners) {
      try {
        worker.addEventListener("message", listener);
      } catch (err) {
        if (!self._dolphinPthreadTransportErrLogged) {
          self._dolphinPthreadTransportErrLogged = true;
          postStatus(
            `pthread-transport: ${label} listener installation failed: ${err?.message || err}`
          );
        }
      }
    }
  }

  if (!jitCacheEnabled) return;
  // dolphinJitCacheMap is already populated by loadCore() (which awaits
  // reconcileJitCacheWithBuild before reaching this call site), so we
  // can push immediately.
  dolphinJitPthreadWorkers = workers;
  dolphinJitPthreadInstallPostFailures = 0;
  if (!workers.length) {
    postStatus("jit-cache: no pthread workers visible at boot (PTHREAD_POOL_SIZE may be 0)");
    return;
  }
  // Send the cache to every worker. We send the same payload to running +
  // unused so when Dolphin assigns a fresh pthread to a previously-idle
  // worker, the cache is already installed. Also addEventListener so the
  // pthread's self.postMessage cache-miss notifications reach us alongside
  // Emscripten's worker.onmessage.
  let sent = 0;
  for (const w of workers) {
    try {
      ensureDolphinJitPthreadListeners(w);
      w.postMessage({ type: "dolphin-jit-cache", cache: dolphinJitCacheMap });
      sent += 1;
    } catch (err) {
      dolphinJitPthreadInstallPostFailures += 1;
      if (!self._dolphinJitChannelErrLogged) {
        self._dolphinJitChannelErrLogged = true;
        postStatus(`jit-cache: postMessage to pthread worker failed: ${err?.message || err}`);
      }
    }
  }
  postStatus(`jit-cache: pushed cache (${dolphinJitCacheMap.size} entries) to ${sent}/${workers.length} pthread workers`);
  // §28ch: kick off background lazy fill so any IDB entries past the
  // boot-load cap get compiled + pushed to pthreads incrementally while
  // the game runs. Cost: small CPU on discio worker + N postMessages,
  // each well under the 16ms frame budget. Gain: bigger effective cache
  // covering menu-nav transitions that the bounded boot-load missed.
  dolphinJitLazyFillPromise = startLazyJitCacheFill().catch((error) => {
    dolphinJitLazyFillActive = false;
    dolphinJitLazyFillCompleted = false;
    dolphinJitLazyFillTerminalReason = "error";
    dolphinJitLazyFillFailureCount += 1;
    postStatus(`jit-cache: lazy fill failed: ${error?.message || error}`);
  });
  await dolphinJitLazyFillPromise;
  publishDolphinJitPthreadBarrier(workers);
  const synchronized = await waitForDolphinJitPthreadBarrier();
  postStatus(
    `jit-cache: pre-boot pthread fence ${synchronized ? "complete" : "incomplete"} ` +
    `(${dolphinJitPthreadBarrierAcked}/${dolphinJitPthreadBarrierExpected} acknowledged)`
  );
}

// §28ch: continue loading IDB modules past DOLPHIN_JIT_IDB_BOOT_LOAD_MAX,
// compiling them async on the discio worker, and pushing each one to all
// pthread workers via "dolphin-jit-cache-add" messages so they merge into
// the per-pthread Module._dolphinJitCache. Idempotent: starts once,
// silently no-ops on subsequent calls.
async function startLazyJitCacheFill() {
  if (dolphinJitLazyFillStarted) return;
  dolphinJitLazyFillStarted = true;
  dolphinJitLazyFillCompleted = false;
  dolphinJitLazyFillSourceEntries = 0;
  dolphinJitLazyFillProcessedEntries = 0;
  dolphinJitLazyFillAddedEntries = 0;
  dolphinJitLazyFillTerminalReason = "running";
  dolphinJitLazyFillFailureCount = 0;
  if (!dolphinJitIdb) {
    dolphinJitLazyFillTerminalReason = "indexeddb-unavailable";
    return;
  }
  dolphinJitLazyFillActive = true;
  const startedAt = performance.now();
  const startSize = dolphinJitCacheMap.size;
  const skipKeys = new Set(dolphinJitCacheMap.keys());
  // §28ch source preference: drain the in-memory overflow buffer first
  // (filled by maybeSeedIdbFromPrebuiltCache with entries the boot-load
  // skipped). Subsequent sessions whose IDB has more than the boot-load
  // cap fall back to the IDB-cursor path.
  let remaining = [];
  let fromOverflow = false;
  let cursorFailed = false;
  if (dolphinJitPrebuiltOverflow && dolphinJitPrebuiltOverflow.length > 0) {
    fromOverflow = true;
    for (const { hash, bytes } of dolphinJitPrebuiltOverflow) {
      if (!skipKeys.has(hash)) remaining.push({ key: hash, value: bytes });
    }
    // Release the overflow buffer once we've copied the work list — its
    // bytes will be reachable through `remaining` until they compile.
    dolphinJitPrebuiltOverflow = null;
  } else {
    remaining = await new Promise((resolve) => {
      const out = [];
      try {
        const tx = dolphinJitIdb.transaction(DOLPHIN_JIT_IDB_STORE, "readonly");
        const cur = tx.objectStore(DOLPHIN_JIT_IDB_STORE).openCursor();
        cur.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) { resolve(out); return; }
          if (!skipKeys.has(cursor.key)) {
            out.push({ key: cursor.key, value: cursor.value });
          }
          cursor.continue();
        };
        cur.onerror = () => {
          cursorFailed = true;
          resolve(out);
        };
      } catch {
        cursorFailed = true;
        resolve(out);
      }
    });
  }
  dolphinJitLazyFillSourceEntries = remaining.length;
  if (cursorFailed) {
    dolphinJitLazyFillActive = false;
    dolphinJitLazyFillTerminalReason = "cursor-error";
    dolphinJitLazyFillFailureCount += 1;
    return;
  }
  if (remaining.length === 0) {
    dolphinJitLazyFillActive = false;
    dolphinJitLazyFillCompleted = true;
    dolphinJitLazyFillTerminalReason = "complete";
    return;
  }
  postStatus(`jit-cache: lazy fill starting on ${remaining.length} extra IDB entries`);
  // Small batches with a yield between them so we don't starve the
  // discio-worker event loop (it pumps presentation frames, audio buffers,
  // and disc-io requests).
  const LAZY_BATCH = 16;
  const HARD_CAP = DOLPHIN_JIT_CACHE_MAX;
  let added = 0;
  for (let i = 0; i < remaining.length; i += LAZY_BATCH) {
    if (dolphinJitCacheMap.size >= HARD_CAP) break;
    const slice = remaining.slice(i, i + LAZY_BATCH);
    const verifiedSlice = await Promise.all(slice.map(async (entry) => {
      if (!(entry.value instanceof Uint8Array) && !(entry.value instanceof ArrayBuffer)) {
        return null;
      }
      const buf = entry.value instanceof ArrayBuffer
        ? new Uint8Array(entry.value)
        : entry.value;
      if (!(await verifyCanonicalWasmBlockKey(String(entry.key), buf))) return null;
      return { entry, buf };
    }));
    const compiles = verifiedSlice.map((verified) => {
      if (!verified) return null;
      const { entry, buf } = verified;
      // Only carry bytes through when sourced from the overflow buffer —
      // those need IDB write-back. IDB-sourced entries are already there.
      return { key: entry.key, p: WebAssembly.compile(buf), bytes: fromOverflow ? buf : null };
    }).filter(Boolean);
    dolphinJitLazyFillFailureCount += verifiedSlice.length - compiles.length;
    const settled = await Promise.allSettled(compiles.map((c) => c.p));
    dolphinJitLazyFillProcessedEntries += slice.length;
    for (let k = 0; k < settled.length; k++) {
      if (settled[k].status !== "fulfilled") {
        dolphinJitLazyFillFailureCount += 1;
        continue;
      }
      const key = compiles[k].key;
      const mod = settled[k].value;
      const bytes = compiles[k].bytes;
      dolphinJitCacheMap.set(key, mod);
      added += 1;
      dolphinJitLazyFillAddedEntries = added;
      // Push to every pthread worker. Modules are structured-clone-safe
      // so the receiver can install them on its local wasmTable.
      for (const w of dolphinJitPthreadWorkers) {
        try {
          w.postMessage({ type: "dolphin-jit-cache-add", hash: key, module: mod });
        } catch {
          dolphinJitLazyFillFailureCount += 1;
        }
      }
      // §28ch persist-on-fill: when the source was the prebuilt-overflow
      // (not already in IDB), write the bytes so subsequent sessions skip
      // the prebuilt file entirely. Fire-and-forget; existing helper
      // batches writes via the open dolphinJitIdb instance.
      if (bytes) writeDolphinJitEntryToIdb(key, bytes);
    }
    // Yield to the event loop between batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const ms = Math.round(performance.now() - startedAt);
  postStatus(
    `jit-cache: lazy fill done — added ${added} (cache ${startSize}→${dolphinJitCacheMap.size}) in ${ms}ms`
  );
  dolphinJitLazyFillActive = false;
  dolphinJitLazyFillCompleted =
    dolphinJitLazyFillProcessedEntries === dolphinJitLazyFillSourceEntries &&
    dolphinJitLazyFillFailureCount === 0;
  dolphinJitLazyFillTerminalReason = dolphinJitLazyFillCompleted
    ? "complete"
    : dolphinJitCacheMap.size >= HARD_CAP
      ? "capacity"
      : "incomplete";
}

// Day-27: cross-thread WebGPU command ring. The video pthread can't
// own a WebGPU device (Day-26 wall), so WebGPUCommandStream records
// GPU commands into a ring in the shared wasm heap and the discio
// worker (which owns renderGpu.device + pumps its event loop)
// replays them here. This is the wire protocol for the remote WebGPU
// backend. Day-27 implements the transport + OP_CLEAR; the full
// AbstractGfx opcode set layers on next.
//
// Header layout (CmdRingHeader, protocol-dependent @ headerPtr):
//   [0] u32 write (atomic)  [1] u32 read (atomic)
//   [2] u32 capacity        [3] u32 upload_read (atomic byte watermark)
//   [4] u32 protocol_flags  [5] u32 consumer_state [6] u32 consumer_error
// Slot layout (CmdRecord, 32 bytes @ slotsPtr + i*32):
//   [0] u32 op   [1..7] 7 words (f32/u32 per opcode)
const WGPU_CMD_OP_NOP = 0;
const WGPU_CMD_OP_CLEAR = 1;
const WGPU_CMD_OP_CREATE_SHADER = 2;
const WGPU_CMD_OP_CREATE_PIPELINE = 3;
const WGPU_CMD_OP_DRAW_TEST = 4;
// Phase A (Day-33): full AbstractGfx opcode set. Wire form fixed by
// DESIGN-webgpu-command-protocol; consumer handlers land per-increment.
// §16: reused scratch for SET_BIND_GROUP dynamic offsets so the
// per-draw hot path (~1.5M calls/run) allocates nothing — a fresh
// array here stalled the consumer → ring backpressure → JIT
// catastrophic. Non-shared so no engine rejects it (cf. TextDecoder).
const WGPU_DYN_OFF_SCRATCH = new Uint32Array(4);
const WGPU_CMD_OP_CREATE_BUFFER = 5;
const WGPU_BUFFER_RESOURCE_ROLE_UNKNOWN = 0;
const WGPU_BUFFER_RESOURCE_ROLE_UBO_RING = 1;
const WGPU_CMD_OP_UPLOAD_BUFFER = 6;
const WGPU_CMD_OP_CREATE_TEXTURE = 7;
const WGPU_CMD_OP_UPLOAD_TEXTURE = 8;
const WGPU_CMD_OP_CREATE_PIPELINE_CFG = 9;
const WGPU_CMD_OP_CREATE_SAMPLER = 10;
const WGPU_CMD_OP_CREATE_BIND_GROUP = 11;
const WGPU_CMD_OP_BEGIN_PASS = 12;
const WGPU_CMD_OP_SET_PIPELINE = 13;
const WGPU_CMD_OP_SET_BIND_GROUP = 14;
const WGPU_CMD_OP_SET_VERTEX_BUFFER = 15;
const WGPU_CMD_OP_SET_INDEX_BUFFER = 16;
const WGPU_CMD_OP_SET_VIEWPORT = 17;
const WGPU_CMD_OP_SET_SCISSOR = 18;
const WGPU_CMD_OP_DRAW = 19;
const WGPU_CMD_OP_DRAW_INDEXED = 20;
const WGPU_CMD_OP_END_PASS = 21;
const WGPU_CMD_OP_SUBMIT_PRESENT = 22;
const WGPU_CMD_OP_DESTROY = 23;
const WGPU_CMD_OP_BLIT_TEXTURE = 24;
const WGPU_CMD_OP_CLEAR_RECT = 25;
// ClearRect uses the full attachment viewport and [0,1] depth range, so its
// scissor alone determines coverage and its depth is independent of game state.
// A/B switch: false restores the original game-viewport-dependent clear.
const CLEARRECT_FULL_VIEWPORT = true;
const WGPU_REPLAY_WINDOW_RECORDS = 16384;
const WGPU_MAX_STAGED_UPLOAD_BYTES = 32 * 1024 * 1024;
const WGPU_REPLAY_BUDGET_CHECK_RECORDS = 32;
const WGPU_DRAIN_DURATION_BUCKET_BOUNDS_MS = Object.freeze([2, 4, 6, 8, 12, 20, 50]);
const WGPU_DRAIN_COMMAND_BUCKET_BOUNDS = Object.freeze([0, 32, 128, 512, 2048, 8192, 16384]);
const WGPU_BACKLOG_SAMPLE_CAPACITY = 128;
const wgpuBacklogSamples = new Float64Array(WGPU_BACKLOG_SAMPLE_CAPACITY);
let wgpuBacklogSampleCount = 0;
let wgpuBacklogSampleCursor = 0;
let wgpuBacklogLastSampleAt = 0;
let wgpuBacklogLastValue = 0;
let wgpuBacklogNonzeroSince = 0;
let webGpuCmdRing = null;  // { headerI32, slotsBase, capacity, uploadBase }
let wgpuRendererHeapBuffer = null;
let wgpuRendererHeapGeneration = 0;
const wgpuRendererRuntime = new WgpuRendererRuntime({
  drain: ({ source = "pump" } = {}) => drainWebGpuCmdRing(source),
  mappedSnapshot: () => ({
    ...pendingWgpuUploadSnapshot(),
    pendingRemaps: wgpuMappedRemapPromises.size,
    capacityBlocked: wgpuMappedCapacityBlocked,
    timerPending: wgpuMappedDrainTimer !== null,
  }),
  finalizeMapped: (timeoutMs) => finalizeWgpuMappedDrain(timeoutMs),
  queue: () => renderGpu?.device?.queue ?? null,
  coreState: () => api?.getCoreStateName?.() ?? "",
  loadFenceActive: () => wgpuLoadFenceActive,
  fatal: () => wgpuReplayFatal,
});
// Day-28/29 resource object table: producer-assigned id → real GPU
// object built here on renderGpu.device. Phase A widens this to the
// full AbstractGfx resource set.
const webGpuObjects = {
  shaders: new Map(),
  // Fragment-shader variants with the sampled UV pinned to the texture centre.
  // Selected only for depth-using pipelines, so the 2D overlay -- which samples
  // glyphs and would collapse to a flat colour -- keeps its real shader.
  shadersUvForced: new Map(),
  pipelines: new Map(),
  buffers: new Map(),
  textures: new Map(),
  samplers: new Map(),
  samplerDescriptors: new Map(),
  nearestSamplers: new Map(),
  bindGroups: new Map(),
  bindGroupSamplingMasks: new Map(),
  pipeTpl: new Map(),  // id → {desc, target, depthBase} template
  pipeVar: new Map(),  // pipeline/attachment/depth/sampling-layout key → pipeline|null
  shaderOk: 0,
  shaderFail: 0
};
// Day-29: constant-colour test fragment shader the consumer pairs
// with a bridge-translated vertex shader to prove the pipeline/draw
// replay path. Real Dolphin pixel shaders arrive with the Day-30
// api_type→Vulkan flip; this FS just emits a recognisable colour so
// a successful pipeline+draw is visible on the canvas.
const WGPU_TEST_FS_WGSL =
  "@fragment fn main() -> @location(0) vec4<f32> " +
  "{ return vec4<f32>(0.13, 0.62, 0.91, 1.0); }";
let webGpuTestFsModule = null;
const webGpuTextDecoder =
  typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;

function encodeHardwareInputMarker(encoder, texture, format, marker) {
  if (!inputLatencyDiagnostics || !encoder || !texture || !marker || !renderGpu?.device) {
    return false;
  }
  const device = renderGpu.device;
  let state = renderGpu.inputMarkerState;
  if (!state || state.format !== format) {
    const shader = device.createShaderModule({
      label: "dolphin-input-marker",
      code: `
struct MarkerColor { rgba: vec4f };
@group(0) @binding(0) var<uniform> marker: MarkerColor;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  return vec4f(positions[index], 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return marker.rgba;
}
`
    });
    const pipeline = device.createRenderPipeline({
      label: "dolphin-input-marker",
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
    const createColorBinding = (label) => {
      const colorBuffer = device.createBuffer({
        label,
        size: 16,
        usage: 0x40 | 0x8
      });
      return {
        colorBuffer,
        bindGroup: device.createBindGroup({
          label,
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: colorBuffer } }]
        })
      };
    };
    state = {
      barcode: createColorBinding("dolphin-input-marker-barcode-color"),
      optical: createColorBinding("dolphin-input-marker-optical-color"),
      format,
      generation: null,
      mode: "",
      pipeline
    };
    renderGpu.inputMarkerState = state;
  }

  if (state.generation !== marker.generation || state.mode !== marker.mode) {
    const rgba = inputMarkerRgba(marker.generation).map((value) => value / 255);
    const luminance = marker.mode === INPUT_VISUAL_MARKER_MODE_PHOTON
      ? (Number(marker.optical?.luminance) >= 0x80 ? 1 : 0)
      : inputPhotonLuminance(marker.generation) / 255;
    device.queue.writeBuffer(state.barcode.colorBuffer, 0, new Float32Array(rgba));
    device.queue.writeBuffer(
      state.optical.colorBuffer,
      0,
      new Float32Array([luminance, luminance, luminance, 1])
    );
    state.generation = marker.generation;
    state.mode = marker.mode;
  }

  const encodeRect = (binding, geometry, label) => {
    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [{
        view: texture.createView(),
        loadOp: "load",
        storeOp: "store"
      }]
    });
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, binding.bindGroup);
    pass.setViewport(0, 0, texture.width, texture.height, 0, 1);
    pass.setScissorRect(geometry.x, geometry.y, geometry.width, geometry.height);
    pass.draw(3);
    pass.end();
  };

  if (marker.mode === INPUT_VISUAL_MARKER_MODE_PHOTON) {
    const geometry = resolveInputPhotonMarkerGeometry(
      texture.width,
      texture.height,
      marker.optical
    );
    encodeRect(state.optical, geometry, "dolphin-input-marker-optical-roi");
    inputVisualMarkerTracker.recordRenderGeometry(geometry);
  }
  encodeRect(state.barcode, {
    x: 0,
    y: 0,
    width: Math.min(INPUT_VISUAL_MARKER_SIZE, texture.width),
    height: Math.min(INPUT_VISUAL_MARKER_SIZE, texture.height)
  }, "dolphin-input-marker-generation-barcode");
  return true;
}

function handleWebGpuCmdRing(event) {
  const data = event.data;
  if (!data || data.type !== "webgpu-cmd-ring") return;
  const heap = moduleInstance?.HEAPU8;
  if (!heap || !(heap.buffer instanceof SharedArrayBuffer)) {
    postStatus("webgpu-cmd-ring: wasm heap is not shared; bridge disabled");
    return;
  }
  if (isIntentionalBlankWgpuProbe(wgpuRendererWorkerProbe)) {
    attachWgpuUploadProbeRing(data, heap.buffer);
    return;
  }
  if (wgpuReplayFatal) {
    failWgpuRingDescriptor({ heapBuffer: heap.buffer, descriptor: data });
    postStatus("webgpu-cmd-ring: attach rejected after fatal replay state");
    return;
  }
  if (wgpuRendererRuntime.ring) {
    // The committed producer is a process-lifetime singleton: EnsureRing()
    // allocates once and never frees or replaces its header. An exact repeat
    // is therefore a transport retransmission, not a new renderer epoch.
    if (wgpuRendererRuntime.matchesRing({
      heapBuffer: heap.buffer,
      descriptor: data,
    })) {
      postStatus("webgpu-cmd-ring: duplicate attachment ignored");
      return;
    }
    const detail = "a different command ring arrived while the renderer still owns one";
    failWgpuRingDescriptor({ heapBuffer: heap.buffer, descriptor: data });
    recordRendererError("webgpu-command-ring-ownership", detail);
    markWgpuReplayFatal("webgpu-command-ring-ownership", detail);
    postStatus(`webgpu-cmd-ring: attach rejected: ${detail}`);
    return;
  }
  if (wgpuRendererHeapBuffer !== heap.buffer) {
    wgpuRendererHeapBuffer = heap.buffer;
    wgpuRendererHeapGeneration += 1;
  }
  try {
    // The renderer runtime is the sole owner of the live command-ring views.
    // UploadBuffer/UploadTexture source pointers remain absolute offsets into
    // the shared wasm heap, so replay stays zero-copy on this thread.
    webGpuCmdRing = wgpuRendererRuntime.attachRing({
      sessionId: "inline-discio",
      heapGeneration: wgpuRendererHeapGeneration,
      heapBuffer: heap.buffer,
      descriptor: data,
    });
  } catch (error) {
    const detail = error?.message || String(error);
    failWgpuRingDescriptor({ heapBuffer: heap.buffer, descriptor: data });
    recordRendererError("webgpu-command-ring-attach", detail);
    markWgpuReplayFatal("webgpu-command-ring-attach", detail);
    postStatus(`webgpu-cmd-ring: attach failed: ${detail}`);
    return;
  }
  publishWgpuReadIndex(webGpuCmdRing, webGpuCmdRing.consumerRead);
  collectWebGpuProducerStateStats();
  const requestedArenaBytes = wgpuUploadArenaMiB * 1024 * 1024;
  const expectedArenaBytes = webGpuCausalStats.producerUploadArenaConfiguredBytes ||
    requestedArenaBytes;
  webGpuCausalStats.uploadArenaRingHandoffBytes = webGpuCmdRing.uploadSize;
  webGpuCausalStats.uploadArenaRingHandoffExpectedBytes = expectedArenaBytes;
  webGpuCausalStats.uploadArenaRingHandoffMismatch =
    webGpuCmdRing.uploadSize !== expectedArenaBytes;
  if (webGpuCausalStats.uploadArenaRingHandoffMismatch) {
    webGpuCausalStats.uploadArenaRingHandoffMismatchCount += 1;
    recordRendererError(
      "webgpu-upload-arena-handoff",
      `ring upload bytes=${webGpuCmdRing.uploadSize} expected=${expectedArenaBytes}`
    );
  }
  postStatus(
    `webgpu-cmd-ring: registered (cap=${data.capacity} upload=${
      (webGpuCmdRing.uploadSize / 1048576) | 0}MB) — GPU command bridge live`
  );
  startWgpuReplayPump();
}

function currentWgpuReadIndex(ring) {
  if (!ring) return 0;
  if (ring !== webGpuCmdRing || ring !== wgpuRendererRuntime.ring) {
    throw new Error("WGPU read requested by a non-owner");
  }
  return wgpuRendererRuntime.currentReadIndex();
}

function currentWgpuUploadReadIndex(ring) {
  if (!ring) return 0;
  if (ring !== webGpuCmdRing || ring !== wgpuRendererRuntime.ring) {
    throw new Error("WGPU upload read requested by a non-owner");
  }
  return wgpuRendererRuntime.currentUploadReadIndex();
}

function releaseWgpuUploadPayload(ring, uploadPointer, uploadBytes) {
  if (!ring?.uploadWatermarkEnabled) return null;
  if (ring !== webGpuCmdRing || ring !== wgpuRendererRuntime.ring) {
    throw new Error("WGPU upload release attempted by a non-owner");
  }
  const nextRead = wgpuRendererRuntime.publishUploadRead(uploadPointer, uploadBytes);
  if (nextRead === null) {
    webGpuCausalStats.errorCount += 1;
    recordRendererError(
      "upload-watermark",
      `invalid upload span ptr=${uploadPointer >>> 0} bytes=${uploadBytes >>> 0}`
    );
    return;
  }
  webGpuCausalStats.uploadReadLast = nextRead;
  webGpuCausalStats.uploadReleaseCount += 1;
  return nextRead;
}

function copyWgpuUploadPayload(heap, pointer, bytes, padToFour = false) {
  const length = padToFour ? (bytes + 3) & ~3 : bytes;
  if (length === bytes) return heap.slice(pointer, pointer + bytes);
  const copy = new Uint8Array(length);
  copy.set(heap.subarray(pointer, pointer + bytes));
  return copy;
}

// Borrowed payload for the immediate queue.writeBuffer call only. That call
// copies its bytes synchronously; the next upload may reuse storage after it
// returns. Held uploads, texture uploads, and mapped staging retain their own data.
const WGPU_IMMEDIATE_BUFFER_SCRATCH_MAX_BYTES = 4 * 1024 * 1024;
let wgpuImmediateBufferScratch = new Uint8Array(0);

function copyImmediateWgpuBufferUpload(heap, pointer, bytes) {
  if (bytes > WGPU_IMMEDIATE_BUFFER_SCRATCH_MAX_BYTES) {
    return copyWgpuUploadPayload(heap, pointer, bytes, true);
  }
  const source = heap.subarray(pointer, pointer + bytes);
  // Preserve the original helper behavior for truncated or invalid spans.
  if (source.byteLength !== bytes) {
    return copyWgpuUploadPayload(heap, pointer, bytes, true);
  }
  const length = (bytes + 3) & ~3;
  if (wgpuImmediateBufferScratch.byteLength < length) {
    let capacity = Math.max(256, wgpuImmediateBufferScratch.byteLength);
    while (capacity < length) capacity *= 2;
    wgpuImmediateBufferScratch = new Uint8Array(capacity);
  }
  const payload = wgpuImmediateBufferScratch.subarray(0, length);
  payload.set(source);
  payload.fill(0, bytes);
  return payload;
}

function stageHeldWgpuUploads(
  ring,
  startIndex,
  writeIndex,
  u32,
  heap,
  { deadlineMs = Number.POSITIVE_INFINITY } = {}
) {
  if (!ring?.uploadWatermarkEnabled || startIndex === writeIndex) return;
  const startedAt = performance.now();
  const normalizedStart = startIndex >>> 0;
  if (ring.stagedPassStart !== normalizedStart) {
    // Replaying a completed held pass can expose a later incomplete pass in
    // the same drain. Uploads retained for that later suffix remain valid;
    // only an upload from the newly consumed prefix is an ordering failure.
    const rebased = rebaseWgpuStagedUploadWindow({
      startIndex: normalizedStart,
      writeIndex,
      scanCursor: ring.stagedScanCursor,
      stagedUploadIndices: ring.stagedUploads.keys()
    });
    if (!rebased.ok) {
      webGpuCausalStats.errorCount += 1;
      recordRendererError(
        "upload-stage-order",
        `staged upload ${rebased.invalidIndex} precedes held suffix ${normalizedStart}`
      );
      return;
    }
    ring.stagedPassStart = rebased.startIndex;
    ring.stagedScanCursor = rebased.scanCursor;
  }
  let index = ring.stagedScanCursor ?? normalizedStart;
  let scannedRecords = 0;
  while (index !== writeIndex) {
    if (Number.isFinite(deadlineMs) && performance.now() >= deadlineMs) {
      webGpuCausalStats.stageBudgetYieldCount += 1;
      break;
    }
    scannedRecords += 1;
    const word = (ring.slotsBase + (index % ring.capacity) * 32) >>> 2;
    const op = u32[word];
    let pointer = 0;
    let bytes = 0;
    let kind = "";
    if (op === WGPU_CMD_OP_UPLOAD_BUFFER) {
      pointer = u32[word + 3];
      bytes = u32[word + 4];
      kind = "buffer";
    } else if (op === WGPU_CMD_OP_UPLOAD_TEXTURE) {
      pointer = u32[word + 2];
      bytes = Math.imul(u32[word + 3], u32[word + 5]) >>> 0;
      kind = "texture";
    }
    if (kind) {
      const stagedByteLimit = Math.min(
        WGPU_MAX_STAGED_UPLOAD_BYTES,
        ring.uploadSize || WGPU_MAX_STAGED_UPLOAD_BYTES
      );
      const paddedBytes = kind === "buffer" ? (bytes + 3) & ~3 : bytes;
      if (ring.stagedUploadBytes + paddedBytes > stagedByteLimit) {
        webGpuCausalStats.heldUploadStageLimitCount += 1;
        break;
      }
      const currentRead = currentWgpuUploadReadIndex(ring);
      const expectedRead = nextWgpuUploadRead({
        currentRead,
        uploadPointer: pointer,
        uploadBytes: bytes,
        uploadArenaBase: ring.uploadBase,
        uploadArenaSize: ring.uploadSize
      });
      if (expectedRead === null) {
        releaseWgpuUploadPayload(ring, pointer, bytes);
        break;
      }
      const copyStartedAt = causalMetricsEnabled || Number.isFinite(deadlineMs)
        ? performance.now()
        : 0;
      const data = copyWgpuUploadPayload(heap, pointer, bytes, kind === "buffer");
      const copyEndedAt = copyStartedAt ? performance.now() : 0;
      if (causalMetricsEnabled) {
        wgpuReplayOpMetrics.recordUploadCopy(
          op,
          data.byteLength,
          copyEndedAt - copyStartedAt
        );
      }
      if (copyStartedAt && copyStartedAt < deadlineMs && copyEndedAt > deadlineMs) {
        const overrunMs = copyEndedAt - deadlineMs;
        webGpuCausalStats.stageCopyDeadlineOverrunCount += 1;
        webGpuCausalStats.stageCopyDeadlineOverrunMaxMs = Math.max(
          webGpuCausalStats.stageCopyDeadlineOverrunMaxMs,
          overrunMs
        );
      }
      const publishedRead = releaseWgpuUploadPayload(ring, pointer, bytes);
      if (publishedRead !== expectedRead) break;
      ring.stagedUploads.set(index, { kind, data });
      ring.stagedUploadBytes += data.byteLength;
      webGpuCausalStats.heldUploadStagedCount += 1;
      webGpuCausalStats.heldUploadStagedBytes += bytes;
      webGpuCausalStats.heldUploadStagedHighWaterBytes = Math.max(
        webGpuCausalStats.heldUploadStagedHighWaterBytes,
        ring.stagedUploadBytes
      );
    }
    index = (index + 1) >>> 0;
    ring.stagedScanCursor = index;
  }
  const elapsed = performance.now() - startedAt;
  webGpuCausalStats.heldUploadScanCount += 1;
  webGpuCausalStats.heldUploadScannedRecords += scannedRecords;
  webGpuCausalStats.heldUploadScanTotalMs += elapsed;
  webGpuCausalStats.heldUploadScanMaxMs = Math.max(
    webGpuCausalStats.heldUploadScanMaxMs,
    elapsed
  );
}

function publishWgpuReadIndex(ring, readIndex) {
  if (ring !== webGpuCmdRing || ring !== wgpuRendererRuntime.ring) {
    throw new Error("WGPU read publication attempted by a non-owner");
  }
  // Slot ownership follows actual consumption. The old replay-pump path
  // subtracted capacity-16K here, which made the producer treat already
  // consumed slots as occupied and reduced a 262K ring to an effective 16K.
  // WGPU_REPLAY_WINDOW_RECORDS is a per-drain work budget, not a reservation.
  return wgpuRendererRuntime.publishReadIndex(readIndex);
}

function startWgpuReplayPump() {
  if (!wgpuReplayPumpEnabled || wgpuReplayPumpTimer !== null) return;
  const pump = () => {
    wgpuReplayPumpTimer = null;
    if (!wgpuReplayPumpEnabled || !webGpuCmdRing) return;
    if (wgpuReplayPumpDueAt > 0) {
      const wokeAt = performance.now();
      const wakeDelayMs = Math.max(0, wokeAt - wgpuReplayPumpDueAt);
      webGpuCausalStats.replayPumpWakeCount += 1;
      webGpuCausalStats.replayPumpWakeDelayLastMs = wakeDelayMs;
      webGpuCausalStats.replayPumpWakeDelayTotalMs += wakeDelayMs;
      webGpuCausalStats.replayPumpWakeDelayMaxMs = Math.max(
        webGpuCausalStats.replayPumpWakeDelayMaxMs,
        wakeDelayMs
      );
    }
    wgpuReplayYieldPending = false;
    const write = Atomics.load(webGpuCmdRing.headerI32, 0) >>> 0;
    const read = currentWgpuReadIndex(webGpuCmdRing);
    if (write !== read) {
      webGpuCausalStats.replayPumpDrainCount += 1;
      drainWebGpuCmdRing("pump");
    } else {
      webGpuCausalStats.replayPumpEmptyPollCount += 1;
    }
    scheduleWgpuReplayPump(
      pump,
      write === read || wgpuMappedCapacityBlocked ? 4 : 0
    );
  };
  scheduleWgpuReplayPump(pump, 0);
}

function scheduleWgpuReplayPump(callback, delayMs) {
  const delay = Math.max(0, Number(delayMs) || 0);
  const trackWakeDelay = causalMetricsEnabled || wgpuReplayBudgetMs > 0;
  wgpuReplayPumpScheduledAt = trackWakeDelay ? performance.now() : 0;
  wgpuReplayPumpDueAt = trackWakeDelay ? wgpuReplayPumpScheduledAt + delay : 0;
  webGpuCausalStats.replayPumpScheduleCount += 1;
  if (delay === 0) webGpuCausalStats.replayPumpBacklogScheduleCount += 1;
  else webGpuCausalStats.replayPumpIdleScheduleCount += 1;
  wgpuReplayPumpTimer = setTimeout(callback, delay);
}

function cancelWgpuReplayPump() {
  if (wgpuReplayPumpTimer !== null) clearTimeout(wgpuReplayPumpTimer);
  wgpuReplayPumpTimer = null;
  wgpuReplayYieldPending = false;
  wgpuReplayPumpScheduledAt = 0;
  wgpuReplayPumpDueAt = 0;
}

function clearWgpuReplayStateAfterDeviceLoss() {
  wgpuMappedStagingGeneration += 1;
  resetWgpuMappedDrainCoalescing(WGPU_MAPPED_DRAIN_FORCE_REASONS.DEVICE_LOSS);
  wgpuUploadAttribution.cancelCapacityWait();
  destroyWgpuVisualCadenceResources();
  if (wgpuSemanticRuntimeActive) {
    wgpuSemanticRuntime.invalidate(
      "device loss does not clear all browser WebGPU resource maps"
    );
  }
  wgpuMappedStagingPool?.invalidate("WebGPU device lost");
  wgpuUboComputeReconstruction?.invalidate("device-loss");
  wgpuSparseUbo?.reset("device-loss");
  wgpuSparseUbo = null;
  wgpuMappedCapacityBlocked = false;
  wgpuMappedCapacityBlockedAt = 0;
  wgpuMappedCapacityBlockedRole = WGPU_UPLOAD_ROLE.UNKNOWN;
  if (webGpuCmdRing) {
    webGpuCmdRing.heldReplayStart = null;
    webGpuCmdRing.stagedUploads?.clear();
    webGpuCmdRing.stagedUploadBytes = 0;
    webGpuCmdRing.stagedPassStart = null;
    webGpuCmdRing.stagedScanCursor = null;
  }
  wgpuPassStateCache.reset("device-lost");
  if (wgpuPassPackageProjectionActive) {
    wgpuPassPackageProjection.reset("device-lost");
  }
  if (wgpuUploadRunProjectionActive) {
    wgpuUploadRunProjection.reset("device-lost");
  }
  if (wgpuUboComputeProjectionActive) {
    wgpuUboComputeProjection.reset("device-lost");
  }
}

function ensureWgpuMappedStagingPool(device) {
  if (wgpuUploadTransport !== "mapped") return null;
  if (!wgpuMappedStagingPool) {
    wgpuMappedStagingPool = createWgpuMappedStagingPool({
      device,
      slotCount: wgpuMappedStagingSlotCount,
      slotSize: WGPU_MAPPED_STAGING_SLOT_BYTES,
      // MAP_WRITE | COPY_SRC and GPUMapMode.WRITE. Passing the numeric
      // values keeps the worker test seam independent of WebGPU globals.
      bufferUsage: 0x0002 | 0x0004,
      mapMode: 0x0002,
      watchDeviceLoss: false,
      flatRecords: wgpuMappedStageFastEnabled,
    });
  }
  return wgpuMappedStagingPool;
}

function ensureWgpuUboComputeReconstruction(device) {
  if (!wgpuUboComputeReconstructionActive) return null;
  wgpuUboComputeReconstruction ??= createWgpuUboComputeReconstruction({
    device,
    watchDeviceLoss: true,
  });
  return wgpuUboComputeReconstruction;
}

function wgpuUboComputeReconstructionSnapshot() {
  const snapshot = wgpuUboComputeReconstruction?.snapshot() ?? null;
  return {
    schema: snapshot?.schema ?? "wasm-dolphin.wgpu-ubo-compute-reconstruction.v1",
    requested: wgpuUboComputeReconstructionRequested,
    eligible: wgpuUboComputeReconstructionRequested,
    active: wgpuUboComputeReconstructionActive && Boolean(snapshot?.active),
    runtimeEligible: wgpuUboComputeReconstructionActive,
    projectionOnly: false,
    replayBehaviorChanged: wgpuUboComputeReconstructionActive,
    disabledReason: wgpuUboComputeReconstructionRequested &&
        !wgpuUboComputeReconstructionActive
      ? "requires-metrics-hardware-wgpu-mapped"
      : null,
    ...(snapshot ?? {}),
  };
}

function pendingWgpuUploadSnapshot() {
  const mapped = wgpuMappedStagingPool?.snapshot() ?? null;
  const compute = wgpuUboComputeReconstruction?.snapshot() ?? null;
  return {
    pendingUploads: (mapped?.pendingUploads ?? 0) + (compute?.pendingUploads ?? 0),
    pendingBytes: mapped?.pendingBytes ?? 0,
    oldestPendingAgeMs: mapped?.oldestPendingAgeMs ?? 0,
    mapped,
    compute,
  };
}

function ensureWgpuSparseUbo(device) {
  if (!wgpuSparseUboEnabled) return null;
  wgpuSparseUbo ??= createWgpuSparseUboCopyForward({ device });
  return wgpuSparseUbo;
}

function classifyWgpuUboComputeUpload(role, byteLength) {
  if (role === WGPU_UPLOAD_ROLE.UTILITY_UNIFORM) {
    return { resourceClass: "RAW_FULL", utility: true, rawReason: "utility" };
  }
  if (role !== WGPU_UPLOAD_ROLE.UBO) return null;
  for (const [resourceClass, classBytes] of Object.entries(
    WGPU_UBO_COMPUTE_CLASS_BYTES
  )) {
    if (byteLength === classBytes) {
      return { resourceClass, utility: false, rawReason: null };
    }
  }
  return {
    resourceClass: "RAW_FULL",
    utility: false,
    rawReason: "unknown-class-size",
  };
}

function stageWgpuUboComputeUpload({
  resourceId,
  role,
  destinationOffset,
  data,
  borrowBytes = false,
} = {}) {
  if (!wgpuUboComputeReconstructionActive || role !== WGPU_UPLOAD_ROLE.UBO) {
    return null;
  }
  const classification = classifyWgpuUboComputeUpload(role, data?.byteLength ?? 0);
  if (!classification || classification.resourceClass === "RAW_FULL") return null;
  const manager = wgpuUboComputeReconstruction;
  if (!manager) {
    return { handled: true, ok: false, reason: "ubo-compute-manager-unavailable" };
  }
  const result = manager.stage({
    resourceId,
    resourceClass: classification.resourceClass,
    destinationOffset,
    bytes: data,
    borrowBytes,
  });
  return { handled: true, ...result };
}

function wgpuSparseUboSnapshot() {
  if (wgpuSparseUbo) {
    return wgpuSparseUbo.snapshot({ requested: true, active: wgpuSparseUboEnabled });
  }
  return {
    schema: "wasm-dolphin.wgpu-sparse-ubo.v1",
    instanceId: 0,
    requested: wgpuSparseUboEnabled,
    active: false,
    coverageThreshold: 0.5,
    maxSparseRanges: 0,
    classOrder: ["vs", "ps", "gs"],
    classSizes: [4112, 1536, 64],
    shadowValid: [false, false, false],
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
}

function cancelWgpuMappedDrainTimer(token = null) {
  if (token && wgpuMappedDrainTimerToken &&
      (token.generation !== wgpuMappedDrainTimerToken.generation ||
       token.sequence !== wgpuMappedDrainTimerToken.sequence)) {
    return false;
  }
  if (wgpuMappedDrainTimer !== null) clearTimeout(wgpuMappedDrainTimer);
  wgpuMappedDrainTimer = null;
  wgpuMappedDrainTimerToken = null;
  return true;
}

function resetWgpuMappedDrainCoalescing(reason, { clearTelemetry = false } = {}) {
  cancelWgpuMappedDrainTimer();
  wgpuMappedDrainCoalescer.reset({
    generation: wgpuMappedStagingGeneration,
    reason,
    clearTelemetry,
  });
}

function mappedDrainForceReason(reason) {
  if (reason === "staging-capacity") return WGPU_MAPPED_DRAIN_FORCE_REASONS.CAPACITY;
  if (reason === "present") return WGPU_MAPPED_DRAIN_FORCE_REASONS.PRESENT;
  if (reason.includes("readback")) return WGPU_MAPPED_DRAIN_FORCE_REASONS.READBACK;
  if (reason === "blit") return WGPU_MAPPED_DRAIN_FORCE_REASONS.BLIT;
  if (reason === "destroy") return WGPU_MAPPED_DRAIN_FORCE_REASONS.DESTROY;
  return WGPU_MAPPED_DRAIN_FORCE_REASONS.RENDER;
}

function prepareWgpuMappedDrainSubmission(reason, decisionPrepared = false) {
  const snapshot = pendingWgpuUploadSnapshot();
  const pending = (snapshot?.pendingUploads ?? 0) > 0;
  if (!decisionPrepared) {
    const decision = wgpuMappedDrainCoalescer.force(mappedDrainForceReason(reason), {
      pending,
      pendingBytes: snapshot?.pendingBytes ?? 0,
      pendingRecords: snapshot?.pendingUploads ?? 0,
      pendingAgeMs: snapshot?.oldestPendingAgeMs ?? 0,
      generation: wgpuMappedStagingGeneration,
    });
    if (decision.cancelledTimerToken) {
      cancelWgpuMappedDrainTimer(decision.cancelledTimerToken);
    }
  }
  return pending;
}

function submitPendingWgpuMappedUploads(reason = "coalescing-deadline") {
  const pool = wgpuMappedStagingPool;
  const queue = renderGpu?.device?.queue;
  if (!pool || !queue) return false;
  let batch = null;
  let computeBatch = null;
  try {
    batch = pool.seal();
    if (wgpuUboComputeReconstructionActive && wgpuUboComputeReconstruction) {
      computeBatch = wgpuUboComputeReconstruction.seal(
        `Dolphin ordered UBO reconstruction: ${reason}`
      );
      if (computeBatch && !computeBatch.ok) {
        throw new Error(`UBO compute seal failed: ${computeBatch.reason}`);
      }
    }
    if (!batch && !computeBatch) return false;
    if (wgpuUboComputeProjectionActive) {
      wgpuUboComputeProjection.boundary(reason);
    }
    queue.submit([
      ...(batch ? [batch.commandBuffer] : []),
      ...(computeBatch ? [computeBatch.commandBuffer] : []),
    ]);
    gpuCompletionTracker.recordSubmittedWork(queue, "hardware-upload-staging");
    if (causalMetricsEnabled) webGpuCausalStats.queueSubmissionCount += 1;
    wgpuReplayClassifier?.recordSubmission({ reason, submitted: true });
    if (batch) {
      wgpuMappedDrainCoalescer.recordSubmission(
        Math.max(0, globalThis.performance.now() - batch.oldestPendingAtMs)
      );
      trackWgpuMappedRemap(pool.acceptSubmission(batch));
    }
    if (computeBatch) {
      trackWgpuMappedRemap(wgpuUboComputeReconstruction.accept(computeBatch));
    }
    return true;
  } catch (error) {
    if (batch) {
      try {
        pool.rejectSubmission(batch, error);
      } catch {
        pool.invalidate(error);
      }
    }
    if (computeBatch?.ok) {
      try {
        trackWgpuMappedRemap(
          wgpuUboComputeReconstruction.reject(computeBatch, "submit-error")
        );
      } catch {
        wgpuUboComputeReconstruction = null;
      }
    }
    recordRendererError("submit-error", error?.message || error);
    markWgpuReplayFatal("submit-error", error?.message || error);
    wgpuReplayClassifier?.recordSubmission({ reason, submitted: false, error });
    return false;
  }
}

function scheduleWgpuMappedDrainDeadline(decision) {
  cancelWgpuMappedDrainTimer();
  const token = decision.timerToken;
  if (!token) return;
  wgpuMappedDrainTimerToken = token;
  const timerHandle = setTimeout(() => {
    const isCurrentTimer = wgpuMappedDrainTimer === timerHandle &&
      wgpuMappedDrainTimerToken?.generation === token.generation &&
      wgpuMappedDrainTimerToken?.sequence === token.sequence;
    if (!isCurrentTimer) {
      wgpuMappedDrainCoalescer.onTimer(token, {
        pending: false,
        generation: token.generation,
      });
      return;
    }
    wgpuMappedDrainTimer = null;
    wgpuMappedDrainTimerToken = null;
    const snapshot = pendingWgpuUploadSnapshot();
    const pending = (snapshot?.pendingUploads ?? 0) > 0;
    const timerDecision = wgpuMappedDrainCoalescer.onTimer(token, {
      pending,
      pendingBytes: snapshot?.pendingBytes ?? 0,
      pendingRecords: snapshot?.pendingUploads ?? 0,
      pendingAgeMs: snapshot?.oldestPendingAgeMs ?? 0,
      generation: wgpuMappedStagingGeneration,
    });
    if (timerDecision.action === "flush") {
      submitPendingWgpuMappedUploads("coalescing-deadline");
    }
  }, Math.max(0, decision.delayMs));
  wgpuMappedDrainTimer = timerHandle;
}

function forceWgpuMappedDrainLifecycle(reason) {
  if (!wgpuMappedDrainCoalescingEnabled) {
    return submitPendingWgpuMappedUploads(reason);
  }
  const snapshot = pendingWgpuUploadSnapshot();
  const pending = (snapshot?.pendingUploads ?? 0) > 0;
  const decision = wgpuMappedDrainCoalescer.force(reason, {
    pending,
    pendingBytes: snapshot?.pendingBytes ?? 0,
    pendingRecords: snapshot?.pendingUploads ?? 0,
    pendingAgeMs: snapshot?.oldestPendingAgeMs ?? 0,
    generation: wgpuMappedStagingGeneration,
  });
  if (decision.cancelledTimerToken) {
    cancelWgpuMappedDrainTimer(decision.cancelledTimerToken);
  }
  if (decision.action === "flush") {
    submitPendingWgpuMappedUploads(reason);
  }
  resetWgpuMappedDrainCoalescing(reason);
  return decision.action === "flush";
}

async function finalizeWgpuMappedDrain(timeoutMs = 10_000) {
  const deadlineAt = globalThis.performance.now() + timeoutMs;
  for (;;) {
    const snapshot = pendingWgpuUploadSnapshot();
    if ((snapshot?.pendingUploads ?? 0) > 0) {
      forceWgpuMappedDrainLifecycle(WGPU_MAPPED_DRAIN_FORCE_REASONS.FINALIZATION);
    }
    const pendingRemaps = [...wgpuMappedRemapPromises];
    if (pendingRemaps.length === 0) break;
    const remainingMs = deadlineAt - globalThis.performance.now();
    if (remainingMs <= 0) {
      throw new Error("WGPU mapped drain finalization timed out");
    }
    let timeoutHandle;
    try {
      await Promise.race([
        Promise.all(pendingRemaps),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("WGPU mapped drain finalization timed out")),
            remainingMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
    await Promise.resolve();
  }
  const finalSnapshot = pendingWgpuUploadSnapshot();
  const mappedFinal = finalSnapshot.mapped;
  const computeFinal = finalSnapshot.compute;
  const quiesced = !wgpuReplayFatal &&
    (finalSnapshot?.pendingUploads ?? 0) === 0 &&
    (mappedFinal?.activeBatches ?? 0) === 0 &&
    (mappedFinal?.states?.remapping ?? 0) === 0 &&
    (computeFinal?.activeBatches ?? 0) === 0 &&
    (computeFinal?.states?.remapping ?? 0) === 0 &&
    wgpuMappedRemapPromises.size === 0 &&
    !wgpuMappedCapacityBlocked;
  if (!quiesced) {
    throw new Error("WGPU mapped drain finalization did not quiesce");
  }
  return {
    quiesced: true,
    pendingUploads: finalSnapshot?.pendingUploads ?? 0,
    activeBatches: (mappedFinal?.activeBatches ?? 0) +
      (computeFinal?.activeBatches ?? 0),
    remappingSlots: (mappedFinal?.states?.remapping ?? 0) +
      (computeFinal?.states?.remapping ?? 0),
    activeCapacityWait: false,
  };
}

function wgpuReplayQuiescenceSnapshot() {
  return wgpuRendererRuntime.snapshot();
}

async function finalizeWgpuReplayQuiescence(
  timeoutMs = 30_000,
  { requireRing = false } = {}
) {
  return wgpuRendererRuntime.quiesce(timeoutMs, {
    requireRing,
  });
}

function drainWgpuSemanticOwnership() {
  if (!wgpuOwnershipTraceActive) return 0;
  if (!wgpuSemanticRuntimeActive) return wgpuOwnershipTrace.drain();
  if (!wgpuSemanticRuntime.isOpen() ||
      !wgpuSemanticRuntime.canDrainOwnership()) return 0;
  const loadedCheckpointGeneration = readLastLoadedCheckpoint().generation;
  const records = wgpuOwnershipTrace.drain({
    collect: true,
    stopAfterEvent: WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED,
  });
  wgpuSemanticRuntime.pushOwnership(records, wgpuOwnershipTrace.snapshot(), {
    loadedCheckpointGeneration,
  });
  return records.length;
}

function advanceWgpuSemanticCapture(ring, read) {
  if (!wgpuSemanticRuntimeActive || !ring?.headerI32) return;
  drainWgpuSemanticOwnership();
  const ownershipHealth = wgpuOwnershipTrace.snapshot();
  const write = Atomics.load(ring.headerI32, 0) >>> 0;
  const loadedCheckpointGeneration = readLastLoadedCheckpoint().generation;
  if (wgpuSemanticRuntime.maybeRequestCaptureEnd({
    commandRingRead: read,
    commandRingWrite: write,
    ownershipHealth,
    loadedCheckpointGeneration,
  })) {
    try {
      api.setWebGpuOwnershipTraceEnabled(0);
      wgpuSemanticRuntime.markNativeStopRequestSent();
    } catch (error) {
      wgpuSemanticRuntime.invalidate(
        `native capture-stop request failed: ${error?.message || error}`
      );
    }
  }
  const frozen = wgpuSemanticRuntime.maybeFreezeCapture({
    commandRingRead: read,
    commandRingWrite: write,
    ownershipHealth,
    loadedCheckpointGeneration,
  });
  if (!frozen) return;
  if (!api.acknowledgeWebGpuOwnershipTraceCapture(frozen.captureId)) {
    markWgpuReplayFatal(
      "semantic-capture-ack",
      `native capture ${frozen.captureId} acknowledgement was rejected`
    );
  }
}

async function initializeWgpuUploadProbe(mode) {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
    throw new Error("WGPU upload probes require cross-origin isolation");
  }
  if (wgpuUploadProbeExecutor || wgpuUploadProbeWorker) {
    throw new Error("WGPU upload probe is already initialized");
  }
  wgpuUploadProbeOwnerBuffer = new SharedArrayBuffer(16);
  wgpuUploadProbeRing = null;
  const startedAt = performance.now();
  if (mode === "inline-upload") {
    if (!self.navigator?.gpu) throw new Error("WebGPU is unavailable in disc worker");
    const adapterStartedAt = performance.now();
    const adapter = await self.navigator.gpu.requestAdapter({
      powerPreference: wgpuPowerPreference
    });
    const adapterMs = performance.now() - adapterStartedAt;
    if (!adapter) throw new Error("disc worker requestAdapter returned null");
    const deviceStartedAt = performance.now();
    const device = await adapter.requestDevice();
    const deviceMs = performance.now() - deviceStartedAt;
    wgpuUploadProbeExecutor = createWgpuUploadProbeExecutor({
      mode,
      device,
      ownerBuffer: wgpuUploadProbeOwnerBuffer,
      onSnapshot: mergeWgpuUploadProbeSnapshot,
      onFatal: (fatal) => recordRendererError("wgpu-upload-probe", fatal.detail)
    });
    wgpuUploadProbeInitMetrics = {
      adapterMs,
      deviceMs,
      totalMs: performance.now() - startedAt
    };
  } else {
    const worker = new Worker(new URL("./wgpu-renderer-worker-probe.js", import.meta.url), {
      type: "module",
      name: "dolphin-wgpu-upload-probe"
    });
    wgpuUploadProbeWorker = worker;
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("nested WGPU upload probe initialization timed out")),
        10_000
      );
      const onMessage = (event) => {
        if (event.data?.type !== "upload-probe-ready") return;
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        if (!event.data.ok || event.data.schema !== WGPU_UPLOAD_PROBE_SCHEMA) {
          reject(new Error(event.data.error || "nested WGPU upload probe schema mismatch"));
          return;
        }
        resolve(event.data);
      };
      worker.addEventListener("message", onMessage);
    });
    worker.addEventListener("message", handleWgpuUploadProbeWorkerMessage);
    worker.addEventListener("error", (event) => {
      failWgpuUploadProbeRing(event.message || "nested WGPU upload probe worker failed");
    });
    worker.addEventListener("messageerror", () => {
      failWgpuUploadProbeRing("nested WGPU upload probe message deserialization failed");
    });
    worker.postMessage({
      type: "upload-probe-init",
      mode,
      ownerBuffer: wgpuUploadProbeOwnerBuffer,
      powerPreference: wgpuPowerPreference
    });
    const result = await ready;
    wgpuUploadProbeInitMetrics = {
      adapterMs: Number(result.adapterMs) || 0,
      deviceMs: Number(result.deviceMs) || 0,
      totalMs: Number(result.totalMs) || performance.now() - startedAt
    };
  }
  webGpuCausalStats.rendererWorkerProbe = {
    ...webGpuCausalStats.rendererWorkerProbe,
    requested: mode,
    active: false,
    passed: false,
    schema: WGPU_UPLOAD_PROBE_SCHEMA,
    blankOutput: true,
    sharedHeap: true,
    ...wgpuUploadProbeInitMetrics,
    error: ""
  };
}

function attachWgpuUploadProbeRing(data, heapBuffer) {
  if (wgpuUploadProbeRing) {
    failWgpuUploadProbeRing("duplicate WGPU upload probe ring handoff");
    return;
  }
  try {
    if (!(heapBuffer instanceof SharedArrayBuffer)) {
      throw new TypeError("upload probe handoff requires a shared WASM heap");
    }
    const headerPtr = Number(data.headerPtr);
    const headerWords = Number(data.headerWords);
    if (!Number.isSafeInteger(headerPtr) || headerPtr < 0 || headerPtr % 4 ||
        !Number.isSafeInteger(headerWords) || headerWords < 7 ||
        headerPtr + 7 * 4 > heapBuffer.byteLength) {
      throw new RangeError("upload probe header is outside the shared WASM heap");
    }
    wgpuUploadProbeRing = {
      headerI32: new Int32Array(heapBuffer, headerPtr, 7),
      protocolV3Enabled: false
    };
    if (Number(data.protocolVersion) !== 3) {
      failWgpuUploadProbeRing("upload probe requires protocol v3 handoff");
      return;
    }
    const descriptor = {
      heapBuffer,
      headerPtr,
      headerWords,
      slotsPtr: Number(data.slotsPtr),
      capacity: Number(data.capacity),
      uploadPtr: Number(data.uploadPtr),
      uploadSize: Number(data.uploadSize),
      protocolVersion: Number(data.protocolVersion),
      start: true
    };
    if (wgpuRendererWorkerProbe === "inline-upload") {
      mergeWgpuUploadProbeSnapshot(wgpuUploadProbeExecutor.attach(descriptor));
    } else {
      wgpuUploadProbeWorker.postMessage({ type: "upload-probe-attach", descriptor });
    }
  } catch (error) {
    if (wgpuUploadProbeRing) failWgpuUploadProbeRing(error?.message || error);
    else recordRendererError("wgpu-upload-probe", error?.message || error);
  }
}

function handleWgpuUploadProbeWorkerMessage(event) {
  const message = event.data;
  if (!message) return;
  if (message.snapshot) mergeWgpuUploadProbeSnapshot(message.snapshot);
  if (message.type === "upload-probe-telemetry" ||
      message.type === "upload-probe-attached") {
    if (message.type === "upload-probe-attached" && message.ok) {
      wgpuUploadProbeRing.protocolV3Enabled = true;
      postStatus(`WGPU ${wgpuRendererWorkerProbe} ring attached`);
    }
    return;
  }
  if (message.type === "upload-probe-fatal") {
    const detail = message.fatal?.detail || "nested WGPU upload probe failed";
    recordRendererError("wgpu-upload-probe", detail);
    return;
  }
  if (message.type === "upload-probe-error") {
    failWgpuUploadProbeRing(message.error || "nested WGPU upload probe error");
  }
  if (message.id != null) {
    const pending = wgpuUploadProbePendingRequests.get(message.id);
    if (pending) {
      wgpuUploadProbePendingRequests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || `${message.type} failed`));
    }
  }
}

function mergeWgpuUploadProbeSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== WGPU_UPLOAD_PROBE_SCHEMA) return;
  webGpuCausalStats.rendererWorkerProbe = {
    ...snapshot,
    ...wgpuUploadProbeInitMetrics,
    error: snapshot.fatalError || ""
  };
  if (wgpuUploadProbeRing && snapshot.active) {
    wgpuUploadProbeRing.protocolV3Enabled = true;
  }
}

function failWgpuUploadProbeRing(detail) {
  const message = String(detail || "WGPU upload probe failed");
  if (wgpuUploadProbeRing && !wgpuUploadProbeRing.protocolV3Enabled) {
    enableWgpuUploadWatermark(wgpuUploadProbeRing);
    enableWgpuNonDroppingBackpressure(wgpuUploadProbeRing);
  }
  failWgpuRingConsumer(wgpuUploadProbeRing, WGPU_CONSUMER_ERROR_UNKNOWN);
  webGpuCausalStats.rendererWorkerProbe = {
    ...webGpuCausalStats.rendererWorkerProbe,
    passed: false,
    error: message
  };
  recordRendererError("wgpu-upload-probe", message);
}

function requestWgpuUploadProbeWorker(type, payload = {}, timeoutMs = 15_000) {
  if (!wgpuUploadProbeWorker) throw new Error("nested WGPU upload probe is unavailable");
  const id = wgpuUploadProbeNextRequestId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wgpuUploadProbePendingRequests.delete(id);
      failWgpuUploadProbeRing(`${type} timed out`);
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    wgpuUploadProbePendingRequests.set(id, { resolve, reject, timeout });
    wgpuUploadProbeWorker.postMessage({ type, id, ...payload });
  });
}

async function finalizeWgpuUploadProbe(timeoutMs = 10_000) {
  if (!isIntentionalBlankWgpuProbe(wgpuRendererWorkerProbe)) {
    return { required: false, snapshot: null };
  }
  let snapshot;
  if (wgpuRendererWorkerProbe === "inline-upload") {
    snapshot = await wgpuUploadProbeExecutor.finalize({ timeoutMs });
  } else {
    const result = await requestWgpuUploadProbeWorker(
      "upload-probe-finalize",
      { timeoutMs },
      timeoutMs + 5000
    );
    snapshot = result.snapshot;
  }
  mergeWgpuUploadProbeSnapshot(snapshot);
  return { required: true, snapshot: webGpuCausalStats.rendererWorkerProbe };
}

async function beginWgpuUploadProbeMeasurement(timeoutMs = 10_000) {
  if (!isIntentionalBlankWgpuProbe(wgpuRendererWorkerProbe)) {
    return { required: false, snapshot: null };
  }
  let snapshot;
  if (wgpuRendererWorkerProbe === "inline-upload") {
    snapshot = await wgpuUploadProbeExecutor.beginMeasurement({ timeoutMs });
  } else {
    const result = await requestWgpuUploadProbeWorker(
      "upload-probe-begin-measurement",
      { timeoutMs },
      timeoutMs + 5000
    );
    snapshot = result.snapshot;
  }
  mergeWgpuUploadProbeSnapshot(snapshot);
  return { required: true, snapshot: webGpuCausalStats.rendererWorkerProbe };
}

async function runWgpuRendererWorkerCanary() {
  if (!(globalThis.crossOriginIsolated && typeof SharedArrayBuffer === "function")) {
    throw new Error("renderer worker canary requires cross-origin isolation");
  }
  const sharedCanary = new SharedArrayBuffer(4);
  const atomics = new Int32Array(sharedCanary);
  const worker = new Worker(new URL("./wgpu-renderer-worker-probe.js", import.meta.url), {
    type: "module",
    name: "dolphin-wgpu-renderer-probe",
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("renderer worker canary timed out")), 10_000);
    worker.addEventListener("message", (event) => {
      if (event.data?.type !== "canary-result") return;
      clearTimeout(timeout);
      resolve(event.data);
    }, { once: true });
    worker.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(new Error(event.message || "renderer worker canary failed"));
    }, { once: true });
    worker.postMessage({
      type: "canary",
      sharedCanary,
      powerPreference: wgpuPowerPreference,
    });
  }).finally(() => worker.terminate());
  const expectedCanary = 0x57a6cafe;
  const expectedSchema = "wasm-dolphin.wgpu-renderer-worker-canary.v1";
  const observedCanary = Atomics.load(atomics, 0) >>> 0;
  if (
    !result?.ok ||
    result.schema !== expectedSchema ||
    observedCanary !== expectedCanary ||
    result.observed !== expectedCanary
  ) {
    throw new Error(result?.error || `renderer worker canary mismatch: ${observedCanary.toString(16)}`);
  }
  webGpuCausalStats.rendererWorkerProbe = {
    requested: "canary",
    active: true,
    passed: true,
    schema: expectedSchema,
    adapterMs: Number(result.adapterMs) || 0,
    deviceMs: Number(result.deviceMs) || 0,
    gpuCompletionMs: Number(result.gpuCompletionMs) || 0,
    mapMs: Number(result.mapMs) || 0,
    totalMs: Number(result.totalMs) || 0,
    error: "",
  };
  postStatus(
    `WGPU renderer worker canary passed in ${webGpuCausalStats.rendererWorkerProbe.totalMs.toFixed(1)}ms`
  );
  return webGpuCausalStats.rendererWorkerProbe;
}

function trackWgpuMappedRemap(remapPromise) {
  const generation = wgpuMappedStagingGeneration;
  const attribution = wgpuUploadAttribution;
  const tracked = Promise.resolve(remapPromise).then((ok) => {
    if (generation !== wgpuMappedStagingGeneration) return ok;
    if (!ok) {
      webGpuCausalStats.mappedStagingRemapFailureCount += 1;
      markWgpuReplayFatal(
        "staging-remap",
        wgpuMappedStagingPool?.snapshot().lastError || "mapped staging remap failed"
      );
    }
    return ok;
  }, (error) => {
    if (generation !== wgpuMappedStagingGeneration) return false;
    webGpuCausalStats.mappedStagingRemapFailureCount += 1;
    wgpuMappedStagingPool?.invalidate(error);
    markWgpuReplayFatal("staging-remap", error?.message || error);
    return false;
  }).finally(() => {
    wgpuMappedRemapPromises.delete(tracked);
    if (generation !== wgpuMappedStagingGeneration) return;
    if (wgpuMappedCapacityBlocked) {
      const waitedMs = Math.max(0, performance.now() - wgpuMappedCapacityBlockedAt);
      webGpuCausalStats.mappedStagingCapacityWaitTotalMs += waitedMs;
      webGpuCausalStats.mappedStagingCapacityWaitMaxMs = Math.max(
        webGpuCausalStats.mappedStagingCapacityWaitMaxMs,
        waitedMs
      );
      attribution.recordCapacityWaitDuration(
        wgpuMappedCapacityBlockedRole,
        waitedMs
      );
      wgpuMappedCapacityBlocked = false;
      wgpuMappedCapacityBlockedAt = 0;
      wgpuMappedCapacityBlockedRole = WGPU_UPLOAD_ROLE.UNKNOWN;
    }
    if (!wgpuReplayFatal && webGpuCmdRing) startWgpuReplayPump();
  });
  wgpuMappedRemapPromises.add(tracked);
  return tracked;
}

function markWgpuMappedCapacityWait(uploadRole = WGPU_UPLOAD_ROLE.UNKNOWN) {
  webGpuCausalStats.mappedStagingCapacityWaitCount += 1;
  const normalizedRole = wgpuUploadAttribution.recordCapacityWaitAttempt(uploadRole);
  if (!wgpuMappedCapacityBlocked) {
    wgpuMappedCapacityBlocked = true;
    wgpuMappedCapacityBlockedAt = performance.now();
    wgpuMappedCapacityBlockedRole = normalizedRole;
    wgpuUploadAttribution.beginCapacityWait(normalizedRole);
  }
}

function markWgpuReplayFatal(scope, detail) {
  if (wgpuReplayFatal) return false;
  wgpuReplayFatal = { scope: String(scope), detail: String(detail || "unknown") };
  resetWgpuMappedDrainCoalescing(WGPU_MAPPED_DRAIN_FORCE_REASONS.FATAL);
  wgpuSparseUbo?.reset(`fatal-${scope}`);
  if (wgpuUboComputeProjectionActive) {
    wgpuUboComputeProjection.reset(`fatal-${scope}`);
  }
  wgpuUboComputeReconstruction?.invalidate(`fatal-${scope}`);
  if (wgpuMappedStagingPool?.snapshot().pendingUploads > 0) {
    wgpuMappedStagingPool.invalidate(`fatal ${scope}: ${detail || "unknown"}`);
  }
  const errorCode = scope === "device-lost"
    ? WGPU_CONSUMER_ERROR_DEVICE_LOST
    : scope === "submit-error"
      ? WGPU_CONSUMER_ERROR_SUBMIT
      : WGPU_CONSUMER_ERROR_UNKNOWN;
  wgpuRendererRuntime.emergencyFail(errorCode);
  return true;
}

function summarizeCurrentWgpuRing({
  readIndex: requestedReadIndex = null,
  writeIndex: requestedWriteIndex = null,
  maxRecords = 4096
} = {}) {
  const ring = webGpuCmdRing;
  const heap = moduleInstance?.HEAPU8;
  if (!ring || !heap) {
    return { readIndex: 0, writeIndex: 0, uploadReadIndex: 0, summary: {} };
  }
  const writeIndex = requestedWriteIndex == null
    ? Atomics.load(ring.headerI32, 0) >>> 0
    : requestedWriteIndex >>> 0;
  const readIndex = requestedReadIndex == null
    ? currentWgpuReadIndex(ring)
    : requestedReadIndex >>> 0;
  const u32 = new Uint32Array(heap.buffer);
  const summary = summarizeWgpuReplayRange({
    read: readIndex,
    write: writeIndex,
    recordAt: (index) => {
      const word = (ring.slotsBase + (index % ring.capacity) * 32) >>> 2;
      const op = u32[word];
      return {
        op,
        uploadPointer: op === WGPU_CMD_OP_UPLOAD_BUFFER
          ? u32[word + 3]
          : op === WGPU_CMD_OP_UPLOAD_TEXTURE
            ? u32[word + 2]
            : 0,
        uploadBytes: op === WGPU_CMD_OP_UPLOAD_BUFFER
          ? u32[word + 4]
          : op === WGPU_CMD_OP_UPLOAD_TEXTURE
            ? u32[word + 3] * u32[word + 5]
            : 0
      };
    },
    maxRecords,
    uploadArenaBase: ring.uploadBase,
    uploadArenaSize: ring.uploadSize
  });
  return {
    readIndex,
    writeIndex,
    uploadReadIndex: currentWgpuUploadReadIndex(ring),
    summary
  };
}

// Drain + replay pending commands on renderGpu.device. Called every
// presentation tick. Single-consumer; the producer (video pthread)
// publishes with a release store on `write`, we acquire-load it.
// Day-33 A4/A5: WebGPU texture-format codes (matches MapTexFormat in
// WebGPUTexture.cpp).
const WGPU_TEX_FORMAT = [
  "rgba8unorm", "bgra8unorm", "depth24plus", "depth32float",
  "depth24plus-stencil8", "rgba16float", "r16uint", "r32float",
  "rgb10a2unorm"
];
// Color bindings use the filterable layout. Depth and R32F bindings use
// matching unfilterable layouts and point samplers without converting texels.
const FILTERABLE_TEX_FORMATS = new Set([
  "rgba8unorm", "bgra8unorm", "rgba16float", "rgb10a2unorm"
]);
const UNFILTERABLE_TEX_FORMATS = new Set([
  "r32float", "depth24plus", "depth32float", "depth24plus-stencil8"
]);

// Explicit layouts mirroring SHADER_HEADER: group0 = UBOs b0..3, group1 =
// textures b0..7 and samplers b8..15, group2 = bbox storage b0. Groups 0 and 2
// are shared; group 1 and the pipeline layout vary with texture sample types.
function getFixedLayouts(unfilterableMask = 0, nonFilteringSamplerMask = unfilterableMask) {
  if (renderGpu._fixedLayouts) {
    const base = renderGpu._fixedLayouts;
    if (!unfilterableMask && !nonFilteringSamplerMask) return base;
    const key = `${unfilterableMask}/${nonFilteringSamplerMask}`;
    if (!base.samplingVariants.has(key)) {
      const entries = [];
      for (let i = 0; i < 8; i++) {
        entries.push({ binding: i, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: (unfilterableMask & (1 << i))
            ? "unfilterable-float" : "float", viewDimension: "2d-array" } });
        entries.push({ binding: i + 8, visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: (nonFilteringSamplerMask & (1 << i))
            ? "non-filtering" : "filtering" } });
      }
      const l1 = renderGpu.device.createBindGroupLayout({
        label: `dolphin-bg1-samp-${key}`, entries
      });
      const pipelineLayout = renderGpu.device.createPipelineLayout({
        label: `dolphin-pipeline-layout-${key}`, bindGroupLayouts: [base.l0, l1, base.l2]
      });
      base.samplingVariants.set(key, { ...base, l1, pipelineLayout });
    }
    return base.samplingVariants.get(key);
  }
  const dev = renderGpu.device;
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  // §16: the 4 group-0 UBOs are dynamic-offset — one bind group over
  // the per-draw uniform ring, the draw's slice selected by the offsets
  // on SET_BIND_GROUP. Fixes every draw seeing only the last upload.
  const l0 = dev.createBindGroupLayout({
    label: "dolphin-bg0-ubo",
    entries: [0, 1, 2, 3].map((b) => ({
      binding: b, visibility: VF,
      buffer: { type: "uniform", hasDynamicOffset: true }
    }))
  });
  // GX and utility/framebuffer shaders pair each texture with its own sampler.
  // FramebufferShaderGen EmitSamplerDeclarations uses:
  // fbtex{i} → SAMPLER_BINDING(i) (b0-7), fbsmp{i} → SAMPLER_BINDING(i+8)
  // (b8-15). GenerateEFBRestorePixelShader uses index 0+1, so fbsmp1
  // lands at @group(1) @binding(9). Declare b0-7 textures + b8-15
  // samplers so every SHADER_HEADER sampler binding the translator can
  // emit exists in the fixed layout (declaring bindings a given shader
  // omits is allowed; the reverse is the pipeline-build failure).
  const e1 = [];
  for (let i = 0; i < 8; i++) {
    e1.push({
      binding: i, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d-array" }
    });
  }
  for (let i = 8; i < 16; i++) {
    e1.push({
      binding: i, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" }
    });
  }
  const l1 = dev.createBindGroupLayout({ label: "dolphin-bg1-samp", entries: e1 });
  const l2 = dev.createBindGroupLayout({
    label: "dolphin-bg2-ssbo",
    entries: [{
      binding: 0, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "storage" }
    }]
  });
  const pipelineLayout = dev.createPipelineLayout({
    label: "dolphin-pipeline-layout", bindGroupLayouts: [l0, l1, l2]
  });
  // Persistent dummies to pad bind-group entries the producer's blob
  // omits but the (now wider) fixed layout declares — WebGPU requires
  // a bind group to bind every layout binding. 1×1 2d-array texture +
  // a sampler; harmless when the shader never references them.
  const dummyTex = dev.createTexture({
    size: [1, 1, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  // Unsupported integer formats and missing resources still need a float
  // placeholder. DIAG_DUMMY_TINT makes those substitutions visible.
  if (DIAG_DUMMY_TINT) {
    dev.queue.writeTexture({ texture: dummyTex },
      new Uint8Array([0, 255, 0, 255]), { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 1]);
  }
  const dummyTexView = dummyTex.createView({ dimension: "2d-array" });
  const dummySampler = dev.createSampler({});
  renderGpu._fixedLayouts = { l0, l1, l2, pipelineLayout,
    dummyTex, dummyTexView, dummySampler, samplingVariants: new Map() };
  return getFixedLayouts(unfilterableMask, nonFilteringSamplerMask);
}

function getNonFilteringSampler(id) {
  const descriptor = webGpuObjects.samplerDescriptors.get(id);
  if (descriptor && (descriptor.magFilter || "nearest") === "nearest" &&
      (descriptor.minFilter || "nearest") === "nearest" &&
      (descriptor.mipmapFilter || "nearest") === "nearest" &&
      (descriptor.maxAnisotropy || 1) === 1) {
    return webGpuObjects.samplers.get(id);
  }
  if (!webGpuObjects.nearestSamplers.has(id)) {
    webGpuObjects.nearestSamplers.set(id, renderGpu.device.createSampler({
      ...descriptor, magFilter: "nearest", minFilter: "nearest",
      mipmapFilter: "nearest", maxAnisotropy: 1
    }));
  }
  return webGpuObjects.nearestSamplers.get(id);
}

// Build a GPUBindGroup from a CREATE_BIND_GROUP blob against the fixed
// layout for its group. blob: u32 magic 'WBG1', group, count, then
// count×{binding, kind, resId, off, size}. kind 0/3 = buffer,
// 1 = texture, 2 = sampler.
function replayCreateBindGroup(id, blobPtr, blobLen) {
  if (!renderGpu || webGpuObjects.bindGroups.has(id)) return;
  if (!blobPtr) {
    wgpuReplayClassifier?.recordMissingResource({ kind: "bind-group-blob", id });
    return;
  }
  const u = new Uint32Array(moduleInstance.HEAPU8.buffer, blobPtr, blobLen >>> 2);
  if (u[0] !== 0x57424731) {
    wgpuReplayClassifier?.recordMissingResource({ kind: "bind-group-blob", id });
    return;
  }
  const group = u[1], count = u[2];
  let unfilterableMask = 0;
  let hasPerTextureSamplers = false;
  if (group === 1) {
    for (let i = 0; i < count; i++) {
      const base = 3 + i * 5;
      const binding = u[base], kind = u[base + 1], resId = u[base + 2];
      if (kind === 1 && binding < 8 &&
          UNFILTERABLE_TEX_FORMATS.has(webGpuObjects.textures.get(resId)?.format)) {
        unfilterableMask |= 1 << binding;
      }
      if (kind === 2 && binding > 8) hasPerTextureSamplers = true;
    }
  }
  // Older cores pair every texture with sampler 8. Their compatibility path
  // must make that shared sampler nearest whenever any bound texture needs it.
  const nonFilteringSamplerMask = unfilterableMask |
    (unfilterableMask && !hasPerTextureSamplers ? 1 : 0);
  const samplingKey = `${unfilterableMask}/${nonFilteringSamplerMask}`;
  const layouts = getFixedLayouts(unfilterableMask, nonFilteringSamplerMask);
  const layout = group === 0 ? layouts.l0 : group === 1 ? layouts.l1 : layouts.l2;
  // DIAG one-shot: for the first few group-1 (texture+sampler) bind
  // groups, dump each binding's resId and whether that texture exists
  // / its format+size. Reveals if textured GX draws sample the 1×1
  // dummy or a never-built id (→ black) vs real game textures.
  if (!vpDiagDone && group === 1 && (self._wgBg1N = (self._wgBg1N || 0) + 1) <= 10) {
    let s = `[webgpu-DIAG-bg1] id=${id} count=${count}`;
    for (let i = 0; i < count; i++) {
      const b = u[3 + i * 5], k = u[3 + i * 5 + 1], r = u[3 + i * 5 + 2];
      if (k === 1) {
        const t = webGpuObjects.textures.get(r);
        s += ` b${b}:tex#${r}=${t ? `${t.format} ${t.tex.width}x${t.tex.height}` : "MISSING"}`;
      } else if (k === 2) {
        s += ` b${b}:samp#${r}=${webGpuObjects.samplers.get(r) ? "ok" : "MISSING"}`;
      }
    }
    console.log(s);
  }
  const entries = [];
  let srcTexId = -1;
  for (let i = 0; i < count; i++) {
    const base = 3 + i * 5;
    const binding = u[base], kind = u[base + 1], resId = u[base + 2];
    if (kind === 1) {
      if (binding === 0 && srcTexId < 0) srcTexId = resId;
      const t = webGpuObjects.textures.get(resId);
      if (!t) {
        wgpuReplayClassifier?.recordMissingResource({ kind: "texture", id: resId });
        // §28 diag: which texture ids are missing (→ whole draw
        // skipped → screen-specific black, e.g. difficulty-select
        // background)? Rate-limited tally of the missing resId.
        self._wgMiss = self._wgMiss || { n: 0, ids: {} };
        self._wgMiss.n++;
        self._wgMiss.ids[resId] = (self._wgMiss.ids[resId] || 0) + 1;
        if ((self._wgMiss.n & 0x3FFF) === 0) {
          const top = Object.entries(self._wgMiss.ids)
            .sort((a, b) => b[1] - a[1]).slice(0, 8)
            .map(([k, v]) => `tex#${k}:${v}`).join(" ");
          console.log(`[s28-missbg] n=${self._wgMiss.n} b${binding} ` +
            `top-missing=${top}`);
        }
        // §28cx FORCE-VALID: do NOT drop the whole bind group when a texture
        // is missing — that permanently skips every draw using it (the
        // create record is one-shot), which is why characters & menus vanish
        // (their CMPR maps aren't on the consumer yet / format-unsupported).
        // Substitute the persistent dummy view so the group stays valid and
        // the draw RENDERS (placeholder texel for the one missing map, not an
        // invisible character). Mirrors the non-filterable substitution below.
        // DIAG: a missing texture renders with a 1x1 placeholder, which looks
        // exactly like the flat rectangles Mario Kart Wii shows where its 3D
        // world should be. Count them, and record which ids.
        self._wgDummyMissing = (self._wgDummyMissing || 0) + 1;
        (self._wgDummyMissingIds = self._wgDummyMissingIds || new Set()).add(resId);
        entries.push({ binding, resource: getFixedLayouts().dummyTexView });
        continue;
      }
      // Depth-aspect views are legal texture_2d_array<f32> resources with
      // unfilterable-float layouts. Dolphin reads .r and requests point
      // sampling for depth copies/restores, preserving all 24 GX depth bits.
      if (!FILTERABLE_TEX_FORMATS.has(t.format) && !UNFILTERABLE_TEX_FORMATS.has(t.format)) {
        self._wgDummyFormat = (self._wgDummyFormat || 0) + 1;
        (self._wgDummyFormats = self._wgDummyFormats || new Set()).add(t.format);
        entries.push({ binding, resource: getFixedLayouts().dummyTexView });
      } else {
        entries.push({ binding, resource: t.view2dArray ||
          (t.view2dArray = t.tex.createView({ dimension: "2d-array",
            aspect: t.format.startsWith("depth") ? "depth-only" : "all" })) });
      }
    } else if (kind === 2) {
      const s = webGpuObjects.samplers.get(resId);
      if (!s) {
        wgpuReplayClassifier?.recordMissingResource({ kind: "sampler", id: resId });
        // §28cx FORCE-VALID: missing sampler → dummy, don't drop the group.
        entries.push({ binding, resource: getFixedLayouts().dummySampler });
        continue;
      }
      entries.push({ binding, resource: group === 1 && binding >= 8 &&
        (nonFilteringSamplerMask & (1 << (binding - 8)))
        ? getNonFilteringSampler(resId) : s });
    } else {
      const b = webGpuObjects.buffers.get(resId);
      if (!b) {
        wgpuReplayClassifier?.recordMissingResource({ kind: "buffer", id: resId });
        return;
      }
      // §16: group-0 UBO entries carry a class-size window (blob size
      // field); the per-draw byte offset is a *dynamic* offset applied
      // at setBindGroup, so the entry itself is {offset:0,size}. size==0
      // (e.g. the bbox SSBO) ⇒ bind the whole buffer as before.
      const bsz = u[base + 4];
      entries.push({ binding, resource: bsz
        ? { buffer: b, offset: u[base + 3], size: bsz }
        : { buffer: b } });
    }
  }
  // The fixed group-1 layout declares b0-7 (texture) + b8-15 (sampler)
  // so utility shaders (e.g. EFBRestore's fbsmp1 @binding 9) build, but
  // the producer's blob only carries the bindings it actually uses.
  // WebGPU requires a bind group to bind EVERY layout binding — pad the
  // gaps with persistent dummies (never sampled when the shader omits
  // them).
  if (group === 1) {
    const have = new Set(entries.map((e) => e.binding));
    for (let b = 0; b < 16; b++) {
      if (have.has(b)) continue;
      entries.push(b < 8
        ? { binding: b, resource: layouts.dummyTexView }
        : { binding: b, resource: layouts.dummySampler });
    }
  }
  // Runtime sidecar: the presenter also uses binding 0 to identify the
  // backbuffer source. Preserve it even when optional diagnostics are off.
  if (group === 1 && srcTexId >= 0) {
    self._wgBgTex = self._wgBgTex || {};
    self._wgBgTex[id] = srcTexId;
    if (!vpDiagDone) {
      // §28: full group-1 texture binding set (b0..b7) so we can see
      // what the black backdrop draw actually samples at every binding.
      self._wgBgAll = self._wgBgAll || {};
      let a = "";
      for (let i = 0; i < count; i++) {
        const bb = u[3 + i * 5], kk = u[3 + i * 5 + 1], rr = u[3 + i * 5 + 2];
        if (kk !== 1) continue;
        const tt = webGpuObjects.textures.get(rr);
        a += ` b${bb}=tex#${rr}` +
          (tt ? `(${tt.tex.width}x${tt.tex.height})` : "(?)");
        // §28: stash the backdrop's b1/b2 non-dummy textures so the
        // periodic DIAG-cpy readback dumps their content (is tex#5499
        // the real backdrop image, or also black?).
        if ((bb === 1 || bb === 2) && tt && !(tt.tex.width === 1)) {
          self._wgCpyExtra = self._wgCpyExtra || new Set();
          if (self._wgCpyExtra.size < 24) self._wgCpyExtra.add(rr);
        }
      }
      self._wgBgAll[id] = a;
      // Structured counterpart of the string above: bgId -> {binding: texId}.
      // Needed because a draw samples whichever texture unit its TEV uses --
      // SAMP_AT(i) selects tex_##i -- so checking binding 0 alone inspects the
      // wrong texture for any draw using another unit.
      const byB = {};
      for (let i = 0; i < count; i++) {
        const bb = u[3 + i * 5], kk = u[3 + i * 5 + 1], rr = u[3 + i * 5 + 2];
        if (kk === 1) byB[bb] = rr;
      }
      vpDiagBgTexByBinding.set(id, byB);
    }
  }
  try {
    webGpuObjects.bindGroups.set(id,
      renderGpu.device.createBindGroup({ layout, entries }));
    if (group === 1) webGpuObjects.bindGroupSamplingMasks.set(id, samplingKey);
  } catch (e) {
    if (!self._webGpuBgErr) {
      self._webGpuBgErr = true;
      console.log(`[webgpu-bg] createBindGroup group=${group} threw: ${e?.message || e}`);
    }
  }
}

// Day-33 grind: GPU texture-to-texture blit for the EFB→XFB resolve
// (and EFB copies). Same-format same-size → exact copyTextureToTexture;
// otherwise (the rgba8unorm EFB → bgra8unorm XFB resolve) a sampled
// fullscreen-triangle render pass that also handles the format
// conversion + src/dst sub-rect. Lazily built, pipeline cached per
// destination format.
let blitState = null;
function ensureBlitState() {
  if (blitState) return blitState;
  const dev = renderGpu.device;
  const module = dev.createShaderModule({
    label: "wgpu-blit",
    code: `
struct U { v: vec4<f32> };
@group(0) @binding(0) var t: texture_2d_array<f32>;
@group(0) @binding(1) var sm: sampler;
@group(0) @binding(2) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  var p = array<vec2<f32>,3>(vec2<f32>(-1.,-1.), vec2<f32>(3.,-1.), vec2<f32>(-1.,3.));
  let xy = p[vi];
  var o: VO;
  o.pos = vec4<f32>(xy, 0., 1.);
  let base = vec2<f32>((xy.x + 1.) * 0.5, (1. - xy.y) * 0.5);
  o.uv = base * u.v.xy + u.v.zw;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4<f32> {
  return textureSampleLevel(t, sm, i.uv, 0, 0.);
}` });
  const bgl = dev.createBindGroupLayout({
    label: "wgpu-blit-bgl",
    entries: [
      { binding: 0, visibility: 2 /*FRAGMENT*/,
        texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 1, visibility: 2, sampler: { type: "filtering" } },
      { binding: 2, visibility: 1 /*VERTEX*/, buffer: { type: "uniform" } }
    ]
  });
  blitState = {
    module, bgl,
    layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    sampler: dev.createSampler({
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
    pipelines: new Map()
  };
  return blitState;
}
function ensureBlitPipeline(dstFmt) {
  const bs = ensureBlitState();
  let p = bs.pipelines.get(dstFmt);
  if (p) return p;
  try {
    p = renderGpu.device.createRenderPipeline({
      label: `wgpu-blit-${dstFmt}`,
      layout: bs.layout,
      vertex: { module: bs.module, entryPoint: "vs" },
      fragment: { module: bs.module, entryPoint: "fs",
                  targets: [{ format: dstFmt }] },
      primitive: { topology: "triangle-list" }
    });
    bs.pipelines.set(dstFmt, p);
  } catch (e) {
    if (!self._wgBlitPipeErr) {
      self._wgBlitPipeErr = true;
      console.log(`[webgpu-blit] pipeline(${dstFmt}) threw: ${e?.message || e}`);
    }
    return null;
  }
  return p;
}
function blitTexture(enc, s, d, sx, sy, sw, sh, dx, dy, dw, dh,
                     sLayer, sLevel, dLayer, dLevel) {
  const dev = renderGpu.device;
  const sameFmt = s.format === d.format;
  // Exact GPU copy: identical format + no scaling. Handles sub-rect /
  // layers / levels precisely (the common EFB→texture-cache copy, and
  // depth, which can't go through the sampled color blit).
  if (sameFmt && sw === dw && sh === dh) {
    try {
      enc.copyTextureToTexture(
        { texture: s.tex, mipLevel: sLevel, origin: { x: sx, y: sy, z: sLayer } },
        { texture: d.tex, mipLevel: dLevel, origin: { x: dx, y: dy, z: dLayer } },
        { width: sw, height: sh, depthOrArrayLayers: 1 });
    } catch (e) {
      if (!self._wgBlitCopyErr) {
        self._wgBlitCopyErr = true;
        console.log(`[webgpu-blit] copyTexture threw: ${e?.message || e}`);
      }
    }
    return;
  }
  if (s.format.startsWith("depth") || d.format.startsWith("depth")) return;
  const pipe = ensureBlitPipeline(d.format);
  if (!pipe) return;
  // Source rectangles are expressed in texels of the selected mip, and the
  // sampling view below exposes that mip as level zero.
  const sw0 = Math.max(1, s.tex.width >> sLevel);
  const sh0 = Math.max(1, s.tex.height >> sLevel);
  // 16-byte uniform per blit (a handful/frame) so concurrent blits in
  // one submit never alias a shared buffer.
  const ubo = dev.createBuffer({ size: 16, usage: 0x40 | 0x8,
                                 mappedAtCreation: true });
  new Float32Array(ubo.getMappedRange()).set(
    [sw / sw0, sh / sh0, sx / sw0, sy / sh0]);
  ubo.unmap();
  try {
    const view = s.tex.createView({ dimension: "2d-array",
      baseArrayLayer: sLayer, arrayLayerCount: 1,
      baseMipLevel: sLevel, mipLevelCount: 1 });
    const bg = dev.createBindGroup({ layout: blitState.bgl, entries: [
      { binding: 0, resource: view },
      { binding: 1, resource: blitState.sampler },
      { binding: 2, resource: { buffer: ubo } } ] });
    const dview = d.tex.createView({ dimension: "2d",
      baseArrayLayer: dLayer, arrayLayerCount: 1,
      baseMipLevel: dLevel, mipLevelCount: 1 });
    const rp = enc.beginRenderPass({ label: "wgpu-blit-pass",
      colorAttachments: [{ view: dview, loadOp: "load", storeOp: "store" }] });
    rp.setPipeline(pipe);
    rp.setViewport(dx, dy, Math.max(1, dw), Math.max(1, dh), 0, 1);
    rp.setBindGroup(0, bg);
    rp.draw(3);
    rp.end();
    if (!self._wgBlitOnce) {
      self._wgBlitOnce = true;
      console.log(`[webgpu-blit] first blit ${s.format} ${sw0}x${sh0} ` +
        `src(${sx},${sy} ${sw}x${sh}) -> ${d.format} ` +
        `dst(${dx},${dy} ${dw}x${dh})`);
    }
  } catch (e) {
    if (!self._wgBlitErr) {
      self._wgBlitErr = true;
      console.log(`[webgpu-blit] render blit threw: ${e?.message || e}`);
    }
  }
}

// DIAGNOSTIC (revertible): after the producer's present, blit the raw
// EFB colour texture straight onto the canvas, bypassing the XFB-copy
// + present-blit chain. Isolates "geometry not visible": if the canvas
// then shows Melee geometry, the EFB is correct and the XFB/present
// chain (scale/UV) is the bug; if still uniform, the EFB itself is
// wrong (transform/depth). Flip to false to restore normal present.
// §28cx: diagnosis complete — the raw-EFB blit was the FLICKER source.
// The EFB is loadOp=clear'd to (0,0,0,0) at each frame start, so presents
// landing after the clear but before/without draws showed black → flicker.
// The XFB (tex#47) carries content every frame. Restored to normal present.
let DIAG_EFB_TO_CANVAS = false;
// How far into the frame is the XFB copy taken? The EFB holds the correct
// scene at PRESENT time, but the XFB entry that is actually presented holds
// only ground. If the copy runs after a few hundred EFB draws while the frame
// issues thousands, it is capturing a half-drawn EFB.
// ---- single-frame capture -------------------------------------------------
// Every pass, render target, viewport, scissor, bound source texture and draw
// for ONE frame, in ring order. Piecewise probes produced two mutually
// inconsistent pictures of the present path -- the XFB entry holds correct 3D
// and no HUD, while the presented frame has a HUD and broken 3D, which a single
// blit of that entry cannot produce. That is the signature of measuring the
// wrong thing, so this records the whole frame instead of sampling parts.
//
// ?framecap=N captures the Nth present after boot. Off by default and costs
// nothing when off.
let frameCapTarget = 0;
let frameCapRows = [];
let frameCapDone = false;
const FRAME_CAP_MAX_ROWS = 600;
function frameCapActive() {
  return frameCapTarget > 0 && !frameCapDone &&
         (self._wgPresentCount || 0) === frameCapTarget;
}
function frameCapPush(row) {
  if (!frameCapActive()) return;
  if (frameCapRows.length < FRAME_CAP_MAX_ROWS) frameCapRows.push(row);
}
function frameCapFinish() {
  if (frameCapTarget <= 0 || frameCapDone) return;
  if ((self._wgPresentCount || 0) !== frameCapTarget) return;
  frameCapDone = true;
  console.log(`[framecap] present #${frameCapTarget}, ${frameCapRows.length} records`);
  for (const r of frameCapRows) console.log(`[framecap] ${r}`);
  console.log("[framecap] END");
}

// Per-draw viewport depth range, tallied over the one ?framecap=N frame.
//
// The question this answers: does a single pass contain draws with DIFFERENT
// viewport depth ranges? The consumer applies ONE depth convention per frame
// -- depthClearValue 0.0 plus REVZ_COMPARE_FLIP_ALL -- so if the ranges are
// uniform that convention can be right for every draw, and if they are mixed
// it cannot be right for all of them.
//
// This must read the values BEFORE the `mn > mx` swap that Dawn forces, since
// the swap is what destroys the reversal signal.
//
// Why it can vary at all: with bSupportsReversedDepthRange=false AND
// bSupportsDepthClamp=false, VertexShaderManager::UseVertexDepthRange() returns
// false unconditionally (it bails at the depth-clamp check), so BPFunctions
// skips the block that would pin min/max to [0, MAX_EFB_DEPTH] and emits the
// game's own farZ/zRange instead. zRange < 0 then yields near > far.
//
// Deliberately NOT gated on ?framecap: that plumbing runs through core-host ->
// adapter -> worker payload, and a value that fails to arrive makes the probe
// silently print nothing, which reads identically to "the pass is uniform".
// The trigger is the consumer's own present counter instead, so the probe
// cannot no-op without saying so.
const VPDIAG_EVERY = 500;  // dump a tally every Nth present ...
const VPDIAG_UNTIL = 6000; // ... up to here, so a scene change can't be missed
let vpDiagRaw = null;      // [near, far] as the producer sent them
let vpDiagTally = new Map();
let vpDiagDraws = 0;
// Starts true: this is the PR #19 investigation dump, and it is only armed by
// wgpuvpdiag=1. It used to run unconditionally for the first 6000 presents,
// which is about five minutes on the hardware path -- long enough that every
// benchmark run was measured with it on.
let vpDiagDone = true;
function vpDiagNoteViewport(near, far) {
  if (vpDiagDone) return;
  vpDiagRaw = [near, far];
}
// Raw (producer) vs clamped (WebGPU-legal) viewport rect. WebGPU requires the
// rect to lie inside the attachment; Vulkan/D3D allow it to hang outside via
// the guard band, and Dolphin relies on that. The clamp below SHRINKS w/h,
// which rescales the scene instead of cropping it -- so any draw where raw and
// clamped differ is rendered at the wrong scale.
let vpDiagRect = null;
// Scissor rect in force for each draw, raw and after the clamp. The frame's
// hard axis-aligned boundaries look like rectangles, and a scissor that
// collapses (sx reaching passW makes sw 0) clips a draw away entirely.
let vpDiagScissor = "sc?";
// Per frame: how many times the EFB pass is (re)begun, how many of those clear
// it, and how many draws land after the LAST clear. Anything drawn before a
// clear is discarded, so "draws after last clear" is the only geometry that can
// reach the screen.
const vpDiagClearRects = new Map();
const vpDiagBandOrder = new Map();
const vpDiagFinalCmp = new Map();
let vpDiagEfbPasses = 0;
let vpDiagEfbClears = 0;
let vpDiagDrawsSinceClear = 0;
let vpDiagDrawsTotalEfb = 0;
function vpDiagNoteEfbPass(cleared) {
  if (vpDiagDone) return;
  vpDiagEfbPasses++;
  if (cleared) { vpDiagEfbClears++; vpDiagDrawsSinceClear = 0; }
}
function vpDiagIsDepthAlways(pipelineId) {
  const tpl = webGpuObjects.pipeTpl.get(pipelineId);
  return !!(tpl && tpl.depthBase && tpl.depthBase.depthCompare === "always");
}
function vpDiagNoteScissor(rx, ry, rw, rh, sx, sy, sw, sh) {
  if (vpDiagDone) return;
  const same = rx === sx && ry === sy && rw === sw && rh === sh;
  vpDiagScissor = (sw === 0 || sh === 0)
    ? `sc COLLAPSED raw(${rx},${ry} ${rw}x${rh})`
    : same ? `sc(${sx},${sy} ${sw}x${sh})`
      : `sc raw(${rx},${ry} ${rw}x${rh})->(${sx},${sy} ${sw}x${sh})`;
}
// Distinct VS-constant slices used within one frame. Dolphin re-uploads the
// vertex-shader constants (projection, position/normal matrices) per draw into
// a ring and selects them with a dynamic offset. If every draw resolves to the
// SAME offset the whole scene renders with one transform, which looks like a
// handful of giant flat surfaces -- i.e. the reported zoom.
let vpDiagVsOffsets = new Set();
// Distinct projection matrices seen in one frame. VertexShaderConstants puts
// projection[4] at byte 128 (16B header + 6 float4 posnormalmatrix). Reading it
// at upload answers whether the backend is handed a sane perspective matrix --
// if it is, the transform inputs are right and the zoom is downstream of them.
// Tagged [vpdiag] deliberately: the pre-existing dump here is [webgpu-DIAG-ub],
// which diagnostic-log-filter.js drops, so its output never reaches a captured
// console.
const VS_CONSTANTS_PROJ_OFFSET = 128;
let vpDiagProj = new Map();
let vpDiagPnm = new Map();
let vpDiagXf = new Map();
// Vertices/indices actually handed to the GPU in one frame. Dolphin's own
// prim counter says how much geometry it thinks it submitted; if the consumer
// draws far fewer than ~3 indices per primitive, the loss is in our path.
let vpDiagVerts = 0;
let vpDiagIdx = 0;
// The last draws of a frame are what ends up on top, so a frame that looks
// like a few giant flat regions is described by its tail, not its totals.
let vpDiagTail = [];
// First vertex of each vertex-buffer upload (BufferUploadRole::Vertex = 3).
//
// AMBIGUOUS AS WRITTEN -- read the result with care. It assumes position is a
// leading float32x3, which is only true for some vertex formats. A batch whose
// position is float32x2 puts a packed colour where this reads z, and a unorm8x4
// colour reinterpreted as a float is a huge or denormal value. So the "BAD"
// rows below (sane x, sane y, |z| ~ 1e38) are exactly what a 2D format looks
// like through this lens, and are NOT evidence of corrupt geometry. To make
// this decisive it has to read the batch's declared stride and attribute
// offsets from the pipeline config instead of assuming them.
let vpDiagVtx = new Map();
const vpDiagPipeVtx = new Map();     // pipelineId -> {stride, pos:{format,offset}}
let vpDiagLastVtxBytes = null;       // head of the most recent vertex upload
let vpDiagLastVtxLen = 0;
// Only the FIRST draw after a vertex upload is a sound pairing of that upload
// with a pipeline: one upload serves many subsequent draws, which read it at
// their own base-vertex offsets and say nothing about its total length.
let vpDiagVtxFresh = false;
// Index-buffer contents and the draw parameters that address them. Correct
// vertices can still render as wrong shapes if the indices are wrong, and
// nothing has inspected them yet. The addressing is known to be sane -- the
// live path binds the index buffer at offset 0 and passes base_index as
// firstIndex -- so this is about the values themselves.
let vpDiagLastIdxMin = -1;
let vpDiagLastIdxMax = -1;
let vpDiagLastIdxCount = 0;
let vpDiagLastVtxCount = 0;
const vpDiagIdxTally = new Map();
const vpDiagBatchPos = new Map();
const vpDiagCol0 = new Map();
// Keep recent index uploads keyed by their destination byte offset. A draw's
// firstIndex addresses the ring, not the most recent upload, so the previous
// version compared a draw against whatever happened to be uploaded last -- which
// reported a stale 6-index range for every draw.
const vpDiagIdxUploads = [];
function vpDiagNoteIndexUpload(bytes, len, dstOffset) {
  if (vpDiagDone) return;
  const n = len >> 1;
  if (!n) return;
  const copy = new Uint16Array(n);
  copy.set(new Uint16Array(bytes.buffer, bytes.byteOffset, n));
  vpDiagIdxUploads.push({ off: dstOffset, n, data: copy });
  if (vpDiagIdxUploads.length > 24) vpDiagIdxUploads.shift();
}
function vpDiagIndicesFor(firstIndex, count) {
  const startByte = firstIndex * 2;
  for (let i = vpDiagIdxUploads.length - 1; i >= 0; i--) {
    const u = vpDiagIdxUploads[i];
    if (startByte >= u.off && startByte + count * 2 <= u.off + u.n * 2) {
      const base = (startByte - u.off) >> 1;
      let mn = 0xffff, mx = 0;
      for (let k = 0; k < count; k++) {
        const v = u.data[base + k];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      return { mn, mx };
    }
  }
  return null;
}
function vpDiagNoteIndexedDraw(idxCount, firstIndex, baseVertex) {
  if (vpDiagDone) return;
  const r = vpDiagIndicesFor(firstIndex, idxCount);
  const key = r
    ? `indices[${r.mn}..${r.mx}] span=${r.mx - r.mn + 1} count=${idxCount}` +
      `${r.mn === r.mx ? " DEGENERATE" : ""}`
    : `count=${idxCount} first=${firstIndex} NO MATCHING UPLOAD`;
  vpDiagIdxTally.set(key, (vpDiagIdxTally.get(key) || 0) + 1);
}
const VPDIAG_FMT_READ = {
  float32: (dv, o) => [dv.getFloat32(o, true)],
  float32x2: (dv, o) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true)],
  float32x3: (dv, o) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true),
                         dv.getFloat32(o + 8, true)],
  float32x4: (dv, o) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true),
                         dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)]
};
let vpDiagStrideBad = 0;
let vpDiagStrideOk = 0;
let vpDiagPosBad = 0;
let vpDiagPosOk = 0;
// Validate the most recent vertex upload against the layout the bound pipeline
// actually declares. Two independent checks:
//   1. the upload length must be a whole number of strides (the producer rounds
//      vbytes up to 4, so a remainder of 0..3 is expected);
//   2. the Position attribute, decoded at its declared offset and format, must
//      be finite and of plausible model-space magnitude.
// A stride mismatch means the pipeline and the data disagree about the vertex
// size, which fetches every attribute from the wrong bytes.
function vpDiagCheckVertex(pipelineId) {
  if (vpDiagDone || !vpDiagLastVtxBytes) return;
  const lay = vpDiagPipeVtx.get(pipelineId);
  if (!lay || !lay.stride) return;
  const fresh = vpDiagVtxFresh;
  vpDiagVtxFresh = false;
  if (!fresh) { /* not this upload's batch; stride says nothing */ }
  else if (vpDiagLastVtxLen % lay.stride <= 3) vpDiagStrideOk++;
  else {
    if (vpDiagStrideBad === 0) {
      console.log(`[vpdiag] STRIDE MISMATCH pipe=${pipelineId} stride=${lay.stride} ` +
                  `uploadLen=${vpDiagLastVtxLen} rem=${vpDiagLastVtxLen % lay.stride}`);
    }
    vpDiagStrideBad++;
  }
  const tc = lay.tc0;
  if (tc) {
    const rdt = VPDIAG_FMT_READ[tc.format];
    if (rdt && tc.offset + 16 <= vpDiagLastVtxBytes.byteLength) {
      const dvt = new DataView(vpDiagLastVtxBytes.buffer, vpDiagLastVtxBytes.byteOffset);
      const uv = rdt(dvt, tc.offset);
      const key = `${tc.format}@${tc.offset} uv=[` +
        uv.map((x) => (Number.isFinite(x) ? x.toFixed(3) : String(x))).join(",") + "]";
      vpDiagTc0.set(key, (vpDiagTc0.get(key) || 0) + 1);
    }
  } else {
    vpDiagTc0.set("NO TexCoord0 ATTRIBUTE", (vpDiagTc0.get("NO TexCoord0 ATTRIBUTE") || 0) + 1);
  }
  const col = lay.col0;
  if (fresh && col && lay.stride) {
    const nv = Math.min(Math.floor(vpDiagLastVtxLen / lay.stride),
                        Math.floor(vpDiagLastVtxBytes.byteLength / lay.stride));
    let amin = 255, amax = 0, zero = 0, seen = 0;
    let r0 = -1, g0 = -1, b0 = -1;
    for (let i = 0; i < nv; i++) {
      const o = i * lay.stride + col.offset;
      if (o + 4 > vpDiagLastVtxBytes.byteLength) break;
      const a = vpDiagLastVtxBytes[o + 3];
      if (seen === 0) {
        r0 = vpDiagLastVtxBytes[o];
        g0 = vpDiagLastVtxBytes[o + 1];
        b0 = vpDiagLastVtxBytes[o + 2];
      }
      if (a < amin) amin = a;
      if (a > amax) amax = a;
      if (a === 0) zero++;
      seen++;
    }
    if (seen) {
      vpDiagCol0.set(
        `${col.format}@${col.offset} n=${seen} alpha[${amin}..${amax}] ` +
        `zeroAlpha=${zero} firstRGB=${r0},${g0},${b0}`,
        (vpDiagCol0.get(
          `${col.format}@${col.offset} n=${seen} alpha[${amin}..${amax}] ` +
          `zeroAlpha=${zero} firstRGB=${r0},${g0},${b0}`) || 0) + 1);
    }
  } else if (fresh && !col) {
    vpDiagCol0.set("NO Color0 ATTRIBUTE", (vpDiagCol0.get("NO Color0 ATTRIBUTE") || 0) + 1);
  }
  const pos = lay.pos;
  if (!pos) return;
  if (fresh && lay.stride) {
    const rdA = VPDIAG_FMT_READ[pos.format];
    const nv = Math.floor(vpDiagLastVtxLen / lay.stride);
    if (rdA && nv > 1) {
      const dvA = new DataView(vpDiagLastVtxBytes.buffer, vpDiagLastVtxBytes.byteOffset);
      let mnx = 1e30, mxx = -1e30, mny = 1e30, mxy = -1e30, bad = 0;
      const lim = Math.min(nv, Math.floor(vpDiagLastVtxBytes.byteLength / lay.stride));
      for (let i = 0; i < lim; i++) {
        const o = i * lay.stride + pos.offset;
        if (o + 8 > vpDiagLastVtxBytes.byteLength) break;
        const v = rdA(dvA, o);
        if (!v.every((x) => Number.isFinite(x)) || Math.abs(v[0]) > 1e6) {
          bad++;
          if (!self._vpDiagBadVtxDumped) {
            self._vpDiagBadVtxDumped = true;
            const hex = [];
            for (let k = 0; k < Math.min(lay.stride, 48); k++) {
              hex.push(vpDiagLastVtxBytes[i * lay.stride + k].toString(16).padStart(2, "0"));
            }
            console.log(`[vpdiag] bad vertex #${i}: stride=${lay.stride} ` +
              `posFmt=${pos.format} posOff=${pos.offset} raw=${hex.join(" ")}`);
          }
          continue;
        }
        if (v[0] < mnx) mnx = v[0];
        if (v[0] > mxx) mxx = v[0];
        if (v[1] < mny) mny = v[1];
        if (v[1] > mxy) mxy = v[1];
      }
      if (lim > 1 && mxx > -1e30) {
        const flat = (mxx - mnx) < 1e-4 || (mxy - mny) < 1e-4;
        vpDiagBatchPos.set(
          `n=${lim} x[${mnx.toFixed(1)}..${mxx.toFixed(1)}] ` +
          `y[${mny.toFixed(1)}..${mxy.toFixed(1)}]${bad ? ` bad=${bad}` : ""}` +
          `${flat ? " FLAT" : ""}`,
          (vpDiagBatchPos.get(
            `n=${lim} x[${mnx.toFixed(1)}..${mxx.toFixed(1)}] ` +
            `y[${mny.toFixed(1)}..${mxy.toFixed(1)}]${bad ? ` bad=${bad}` : ""}` +
            `${flat ? " FLAT" : ""}`) || 0) + 1);
      }
    }
  }
  const rd = VPDIAG_FMT_READ[pos.format];
  if (!rd || pos.offset + 16 > vpDiagLastVtxBytes.byteLength) return;
  const dv = new DataView(vpDiagLastVtxBytes.buffer, vpDiagLastVtxBytes.byteOffset);
  const v = rd(dv, pos.offset);
  if (v.every((x) => Number.isFinite(x) && Math.abs(x) < 1e6)) vpDiagPosOk++;
  else {
    if (vpDiagPosBad === 0) {
      console.log(`[vpdiag] BAD POSITION pipe=${pipelineId} fmt=${pos.format} ` +
                  `off=${pos.offset} stride=${lay.stride} v=[${v.join(",")}]`);
    }
    vpDiagPosBad++;
  }
}
function vpDiagNoteVertexUpload(bytes, len) {
  if (vpDiagDone || len < 12) return;
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, 3);
  const bad = ![...f].every((v) => Number.isFinite(v) && Math.abs(v) < 1e6);
  const key = `${bad ? "BAD " : ""}${f[0].toFixed(1)},${f[1].toFixed(1)},${f[2].toFixed(1)}`;
  vpDiagVtx.set(key, (vpDiagVtx.get(key) || 0) + 1);
}
function vpDiagNoteTail(entry) {
  if (vpDiagDone) return;
  vpDiagTail.push(entry);
  if (vpDiagTail.length > 12) vpDiagTail.shift();
}
let vpDiagPcc = new Map();
let vpDiagTexMtx = new Map();
let vpDiagLight = new Map();
let vpDiagMissing = new Map();
let vpDiagTc0 = new Map();
// PixelShaderConstants: colors[4] int4 at 0, kcolors[4] int4 at 64, alpha int4
// at 128. These are the TEV registers. If a draw's TEV output is built from
// registers that are all zero, the fragment is black no matter what texture it
// samples -- which is what "geometry rasterises but paints nothing" looks like.
let vpDiagTev = new Map();
let vpDiagFog = new Map();
// Which textures the world draws bind, and whether those textures ever
// received any non-zero pixel data. A draw that samples an all-zero texture
// renders black through any TEV stage that multiplies by texture colour.
const vpDiagTexData = new Map();   // texId -> {uploads, nonZero}
// Textures that are RENDERED INTO (an offscreen BeginPass targets fbId, which
// is the texture id) and how many draws landed there. This is the other way a
// texture-cache entry gets filled, and the only way to tell a genuinely empty
// texture from one an EFB copy populated -- the RENDER_ATTACHMENT usage bit
// cannot, since every entry carries it.
const vpDiagRtDraws = new Map();   // texId -> cumulative draws into it
const vpDiagBgTexByBinding = new Map();  // bgId -> {binding: texId}
const vpDiagFsTexBinding = new Map();    // fsId -> texture binding it samples
const vpDiagFsSource = new Map();        // fsId -> translated WGSL
const vpDiagPipeDraws = new Map();       // pipelineId -> depth-tested EFB draws
let vpDiagShaderDumped = false;
const VPDIAG_DUMP_VS = true;
// Print the translated fragment shader of whichever pipeline the most
// depth-tested EFB draws use. Every test so far has probed this shader from
// outside -- substituting it, perturbing its sample, stripping its discard --
// without anyone reading what it actually computes.
function vpDiagDumpTopShader() {
  if (vpDiagShaderDumped || !vpDiagPipeDraws.size) return;
  // Prefer the busiest pipeline with NO Color0 attribute: those must synthesise
  // colour0 from missing_color_value, which measured opaque white, yet the
  // coverage probe showed their pixels at alpha 0.
  const ranked = [...vpDiagPipeDraws.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.find(([pid]) => {
    const l = vpDiagPipeVtx.get(pid);
    return l && !l.col0;
  }) || ranked[0];
  const lay = vpDiagPipeVtx.get(top[0]);
  const src = lay ? vpDiagFsSource.get(VPDIAG_DUMP_VS ? lay.vsId : lay.fsId) : null;
  if (!src) return;
  vpDiagShaderDumped = true;
  console.log(`[fsdump] pipeline ${top[0]} (${top[1]} draws) ` +
              `${VPDIAG_DUMP_VS ? "vs=" + lay.vsId : "fs=" + lay.fsId} len=${src.length}`);
  const compact = src.replace(/[ 	]+/g, " ");
  for (let i = 0; i < compact.length; i += 700) {
    console.log(`[fsdump] ${(i / 700) | 0}| ${compact.slice(i, i + 700)}`);
  }
  console.log("[fsdump] END");
}
// BlitTexture destinations. A texture can also be filled by a blit rather than
// a render pass, so counting only BeginPass targets would under-report how a
// cache entry got populated.
const vpDiagBlitDst = new Map();
let vpDiagTexBind = new Map();
// Shape of the uploads that arrive empty, so the zeros can be attributed:
// is the payload the expected size, does it come through the staging path, and
// is any byte non-zero anywhere in it.
const vpDiagTexUploadShape = new Map();
function vpDiagNoteTexUploadShape(texId, bpr, w, h, len, staged, nzFrac) {
  if (vpDiagDone) return;
  const key = `${w}x${h} bpr=${bpr} len=${len} expect=${bpr * h} ` +
    `${staged ? "staged" : "direct"} nz=${nzFrac}%`;
  vpDiagTexUploadShape.set(key, (vpDiagTexUploadShape.get(key) || 0) + 1);
}
function vpDiagNoteTexUpload(texId, bytes, len) {
  let rec = vpDiagTexData.get(texId);
  if (!rec) vpDiagTexData.set(texId, (rec = { uploads: 0, nonZero: 0 }));
  rec.uploads++;
  // "Some byte is non-zero" is too weak: a texture that is 99% black passes it
  // while still sampling black almost everywhere. Measure the FRACTION of
  // non-zero bytes instead, over a strided sample of the whole payload.
  const step = Math.max(1, Math.floor(len / 8192));
  let seen = 0;
  let nz = 0;
  for (let i = 0; i < len; i += step) { seen++; if (bytes[i] !== 0) nz++; }
  rec.samples = (rec.samples || 0) + seen;
  rec.nzBytes = (rec.nzBytes || 0) + nz;
  if (nz > 0) rec.nonZero++;
}
function vpDiagNoteTexBind(fbId, cmp, texId, samplerBinding) {
  if (vpDiagDone || fbId !== self._wgEfbColorId) return;
  if (cmp === "always" || cmp === "none") return;   // world geometry only
  const t = texId != null ? webGpuObjects.textures.get(texId) : null;
  const rec = vpDiagTexData.get(texId);
  // A texture with RENDER_ATTACHMENT (16) is drawn into, not uploaded, so an
  // absent upload says nothing about its contents. Distinguish the two before
  // reading "no upload data" as "empty".
  const isRT = !!(t && (t.usage & 16));
  const pct = rec && rec.samples ? Math.round((100 * rec.nzBytes) / rec.samples) : 0;
  // Report BOTH: the usage flag alone does not discriminate, because Dolphin
  // creates every texture-cache entry with RENDER_ATTACHMENT once
  // bSupportsCopyToVram is on, so "is a render target" is true of all of them.
  // Absence of upload data therefore does NOT prove a texture is empty -- it
  // may have been filled by an EFB copy. Showing the upload statistics next to
  // the flag keeps that distinction visible instead of hiding it.
  const rt = vpDiagRtDraws.get(texId) || 0;
  const up = !rec ? "no upload"
    : rec.nonZero > 0 ? `${pct}% non-zero`
      : `upload ALL ZERO (${rec.uploads})`;
  const bl = vpDiagBlitDst.get(texId) || 0;
  const filled = rt > 0 ? `RENDERED INTO (${rt} draws)`
    : bl > 0 ? `BLIT DEST (${bl})`
      : "never rendered into or blitted";
  const data = `${up}, ${filled}`;
  const key = `b${samplerBinding === undefined ? "?" : samplerBinding} ` +
    `tex#${texId != null ? texId : "none"} ` +
    `${t && t.tex ? `${t.tex.width}x${t.tex.height} ${t.format}` : "unresolved"} ${data}`;
  vpDiagTexBind.set(key, (vpDiagTexBind.get(key) || 0) + 1);
}
function vpDiagNotePsUpload(bytes, len) {
  if (vpDiagDone) return;
  if (len < 1500 || len > 1700) return;
  const i = new Int32Array(bytes.buffer, bytes.byteOffset, 36);
  const cols = Array.from(i.slice(0, 16));
  const kcols = Array.from(i.slice(16, 32));
  const allZero = cols.every((v) => v === 0) && kcols.every((v) => v === 0);
  // fogcolor int4 @432, fogi int4 @448, fogf float4 @464 -- offsets follow from
  // colors(64)+kcolors(64)+alpha(16)+texdims(128)+zbias(32)+indtexscale(32)
  // +indtexmtx(96) = 432. Saturated fog with a black fog colour turns world
  // pixels black while leaving fog-disabled HUD draws alone.
  const fi = new Int32Array(bytes.buffer, bytes.byteOffset + 432, 8);
  const ff = new Float32Array(bytes.buffer, bytes.byteOffset + 464, 4);
  const fogKey = `fogcolor[${fi[0]},${fi[1]},${fi[2]},${fi[3]}] ` +
                 `fogi[${fi[4]},${fi[5]}] fogf[${ff[0].toFixed(2)},${ff[1].toFixed(2)}]`;
  vpDiagFog.set(fogKey, (vpDiagFog.get(fogKey) || 0) + 1);
  const key = allZero ? "ALL ZERO"
    : `c0[${cols.slice(0, 4).join(",")}] k0[${kcols.slice(0, 4).join(",")}] a[${i[32]},${i[33]},${i[34]},${i[35]}]`;
  vpDiagTev.set(key, (vpDiagTev.get(key) || 0) + 1);
}
function vpDiagNoteUpload(bytes, len) {
  if (vpDiagDone) return;
  if (len < 4000 || len > 4200) return;            // VS constants are ~4112 B
  const f = new Float32Array(bytes.buffer, bytes.byteOffset + VS_CONSTANTS_PROJ_OFFSET, 16);
  const key = Array.from(f, (v) => v.toFixed(3)).join(",");
  vpDiagProj.set(key, (vpDiagProj.get(key) || 0) + 1);
  // posnormalmatrix: 3 float4 rows of the position (modelview) matrix at byte
  // 32. A correct race camera has a rotation part with magnitudes <= 1 and a
  // translation in world units; a hugely scaled one magnifies the world, which
  // is what the zoom would look like given a correct projection.
  const g = new Float32Array(bytes.buffer, bytes.byteOffset + 32, 12);
  const pk = Array.from(g, (v) => v.toFixed(2)).join(",");
  vpDiagPnm.set(pk, (vpDiagPnm.get(pk) || 0) + 1);
  // transformmatrices[0] at byte 1280 -- what posmtx-indexed geometry (most of
  // the 3D world) actually transforms through -- plus pixelcentercorrection
  // (3840) and the VS's own idea of the viewport size (3856).
  const t = new Float32Array(bytes.buffer, bytes.byteOffset + 1280, 12);
  vpDiagXf.set(Array.from(t, (v) => v.toFixed(2)).join(","),
    (vpDiagXf.get(Array.from(t, (v) => v.toFixed(2)).join(",")) || 0) + 1);
  // texmatrices[24] float4 at byte 896 (after materials at 192, lights at 256).
  // The first three rows are the texgen matrix for texcoord 0. If these are
  // zero or degenerate the generated UV collapses, and these textures begin
  // with black rows, so a collapsed UV samples black.
  const tm = new Float32Array(bytes.buffer, bytes.byteOffset + 896, 12);
  const tmKey = Array.from(tm, (v) => v.toFixed(2)).join(",");
  vpDiagTexMtx.set(tmKey, (vpDiagTexMtx.get(tmKey) || 0) + 1);
  // Lighting inputs to vertexColour0. VertexShaderConstants: components at 0,
  // xfmem_numColorChans at 8, materials[4] int4 at 192, lights[8] at 256 with
  // each light 80 bytes starting with an int4 colour. vertexColour0.a is what
  // measured near zero, so the alpha lanes here are the ones that matter.
  // missing_color_hex at byte 12 and missing_color_value (float4) at 16 are
  // what a vertex shader uses for a colour channel the vertex format does not
  // supply -- and many pipelines here declare no Color0 attribute at all.
  const hdr = new Uint32Array(bytes.buffer, bytes.byteOffset, 4);
  const miss = new Float32Array(bytes.buffer, bytes.byteOffset + 16, 4);
  vpDiagMissing.set(
    `hex=0x${hdr[3].toString(16)} value=[${Array.from(miss, (v) => v.toFixed(2)).join(",")}]`,
    (vpDiagMissing.get(
      `hex=0x${hdr[3].toString(16)} value=[${Array.from(miss, (v) => v.toFixed(2)).join(",")}]`)
      || 0) + 1);
  const mat = new Int32Array(bytes.buffer, bytes.byteOffset + 192, 16);
  const lit = new Int32Array(bytes.buffer, bytes.byteOffset + 256, 4);
  vpDiagLight.set(
    `chans=${hdr[2]} mat0[${mat.slice(0, 4).join(",")}] mat1[${mat.slice(4, 8).join(",")}] ` +
    `mat2[${mat.slice(8, 12).join(",")}] mat3[${mat.slice(12, 16).join(",")}] ` +
    `light0[${lit.join(",")}]`,
    (vpDiagLight.get(
      `chans=${hdr[2]} mat0[${mat.slice(0, 4).join(",")}] mat1[${mat.slice(4, 8).join(",")}] ` +
      `mat2[${mat.slice(8, 12).join(",")}] mat3[${mat.slice(12, 16).join(",")}] ` +
      `light0[${lit.join(",")}]`) || 0) + 1);
  const c = new Float32Array(bytes.buffer, bytes.byteOffset + 3840, 6);
  vpDiagPcc.set(Array.from(c, (v) => v.toFixed(3)).join(","),
    (vpDiagPcc.get(Array.from(c, (v) => v.toFixed(3)).join(",")) || 0) + 1);
}
function vpDiagNoteVsOffset(off) {
  if (vpDiagDone) return;
  if (vpDiagVsOffsets.size < 4096) vpDiagVsOffsets.add(off >>> 0);
}
// Set when the requested viewport did not fit the attachment and the clamp
// below had to shrink w/h. Upstream (Vulkan/D3D guard band) would render the
// draw at full scale and let it clip at the framebuffer edge; we instead
// squeeze the whole draw into the surviving rect, painting a shrunken copy of
// its content. VP_SKIP_RESCALED omits those draws instead -- strictly less
// wrong than drawing them at the wrong scale, and it isolates the artifact.
const VP_SKIP_RESCALED = false;
let vpRescaled = false;
function vpDiagNoteRect(rawX, rawY, rawW, rawH, cx, cy, cw, ch, passW, passH) {
  if (vpDiagDone) return;
  const same = rawX === cx && rawY === cy && rawW === cw && rawH === ch;
  vpDiagRect = same
    ? `vp(${cx.toFixed(0)},${cy.toFixed(0)} ${cw.toFixed(0)}x${ch.toFixed(0)}) fb=${passW}x${passH}`
    : `vp RAW(${rawX.toFixed(0)},${rawY.toFixed(0)} ${rawW.toFixed(0)}x${rawH.toFixed(0)})` +
      ` -> CLAMPED(${cx.toFixed(0)},${cy.toFixed(0)} ${cw.toFixed(0)}x${ch.toFixed(0)})` +
      ` fb=${passW}x${passH}  <-- RESCALED`;
}
function vpDiagNoteDraw(fbId, pipelineId) {
  if (vpDiagDone) return;
  vpDiagDraws++;
  const tpl = webGpuObjects.pipeTpl.get(pipelineId);
  const cmp = tpl && tpl.depthBase ? tpl.depthBase.depthCompare : "none";
  let range = "unset";
  let cls = "unset";
  if (vpDiagRaw) {
    const [n, f] = vpDiagRaw;
    range = `${n.toFixed(6)},${f.toFixed(6)}`;
    cls = Math.abs(n - f) < 1e-6 ? "ZEROWIDTH" : (n > f ? "INVERTED" : "normal");
  }
  const lay = vpDiagPipeVtx.get(pipelineId);
  const blend = lay
    ? `wm${lay.writeMask}${lay.blendEnable ? ` blend${lay.srcF}/${lay.dstF}` : " noblend"}`
    : "wm?";
  const key = `fb#${fbId} ${vpDiagRect || "vp?"} depth=${cmp} ${blend}`;
  if (fbId === self._wgEfbColorId) {
    vpDiagDrawsTotalEfb++;
    vpDiagDrawsSinceClear++;
    if (cmp !== "always" && cmp !== "none") {
      vpDiagPipeDraws.set(pipelineId, (vpDiagPipeDraws.get(pipelineId) || 0) + 1);
    }
  }
  if (fbId) vpDiagRtDraws.set(fbId, (vpDiagRtDraws.get(fbId) || 0) + 1);
  vpDiagCheckVertex(pipelineId);
  const layTex = vpDiagPipeVtx.get(pipelineId);
  const wantB = layTex ? vpDiagFsTexBinding.get(layTex.fsId) : undefined;
  const byB = vpDiagBgTexByBinding.get(self._wgCurBg1);
  const texId = (byB && wantB !== undefined && byB[wantB] !== undefined)
    ? byB[wantB]
    : (self._wgBgTex ? self._wgBgTex[self._wgCurBg1] : undefined);
  vpDiagNoteTexBind(fbId, cmp, texId, wantB);
  const texObj = texId != null ? webGpuObjects.textures.get(texId) : null;
  // Draw-order of each depth band. Reverse-Z means larger = nearer, so the
  // world band z(0.00,0.84) must be drawn BEFORE anything that writes the
  // nearer HUD band z(0.89,0.99); if the HUD writes depth first, every world
  // fragment fails greater-equal and the world is rejected wholesale.
  if (fbId === self._wgEfbColorId && cls !== "unset" && cmp !== "none") {
    const band = range;
    let b = vpDiagBandOrder.get(band);
    if (!b) vpDiagBandOrder.set(band, (b = { first: vpDiagDrawsTotalEfb, last: 0, n: 0 }));
    b.last = vpDiagDrawsTotalEfb;
    b.n++;
  }
  vpDiagNoteTail(`fb#${fbId} ${vpDiagRect || "vp?"} depth=${cmp}` +
    ` tex#${texId != null ? texId : "?"}` +
    `${texObj && texObj.tex ? ` ${texObj.tex.width}x${texObj.tex.height}` : ""}`);
  vpDiagTally.set(key, (vpDiagTally.get(key) || 0) + 1);
}
// Called from SUBMIT_PRESENT, before the present counter increments, so the
// tally holds exactly the draws of the frame being presented.
function vpDiagPresent() {
  // Isolation bookkeeping must run every frame, before the tally's early
  // return -- otherwise it silently stops once the dump window closes.
  const pn = self._wgPresentCount || 0;
  vpDiagIsolateSeen = 0;
  vpDiagIsolateIdx = Math.floor(pn / 300) % 60;
  if (vpDiagDone) return;
  const n = pn;
  if (n === 0) {
    console.log(`[vpdiag] armed, dumping every ${VPDIAG_EVERY} presents ` +
                `up to #${VPDIAG_UNTIL}`);
  }
  if (n > 0 && n % VPDIAG_EVERY === 0) {
    vpDiagFinish(n);
    if (n >= VPDIAG_UNTIL) { vpDiagDone = true; return; }
  }
  vpDiagTally.clear();
  vpDiagDraws = 0;
  vpDiagVsOffsets.clear();
  vpDiagProj.clear();
  vpDiagPnm.clear();
  vpDiagXf.clear();
  vpDiagVerts = 0;
  vpDiagIdx = 0;
  vpDiagTail = [];
  vpDiagVtx.clear();
  for (const [k, n] of [...vpDiagFinalCmp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x ${k}`);
  }
  for (const [band, b] of [...vpDiagBandOrder.entries()].sort((x, y) => x[1].first - y[1].first)) {
    console.log(`[vpdiag]   band z(${band}) draws=${b.n} first=${b.first} last=${b.last}`);
  }
  vpDiagBandOrder.clear();
  vpDiagClearRects.clear();
  vpDiagEfbPasses = 0; vpDiagEfbClears = 0;
  vpDiagDrawsSinceClear = 0; vpDiagDrawsTotalEfb = 0;
  vpDiagStrideOk = 0; vpDiagStrideBad = 0;
  vpDiagPosOk = 0; vpDiagPosBad = 0;
  vpDiagPcc.clear();
  vpDiagTexMtx.clear();
  vpDiagLight.clear();
  vpDiagMissing.clear();
  vpDiagTc0.clear();
  vpDiagTev.clear();
  vpDiagFog.clear();
  // Persist the frame's most-sampled textures before clearing, so the readback
  // at SUBMIT_PRESENT has something to inspect -- vpDiagPresent() runs first
  // and would otherwise hand it an empty tally.
  vpDiagLastPicks = [...vpDiagTexBind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  vpDiagTexBind.clear();
  vpDiagIdxTally.clear();
  vpDiagBatchPos.clear();
  vpDiagCol0.clear();
}
function vpDiagFinish(present) {
  console.log(`[vpdiag] present #${present}: ${vpDiagVsOffsets.size} distinct VS ` +
              `constant offsets across ${vpDiagDraws} draws`);
  console.log(`[vpdiag] present #${present}: ${vpDiagVerts} vertices + ` +
              `${vpDiagIdx} indices drawn (~${Math.round(vpDiagIdx / 3)} indexed tris)`);
  const bad = [...vpDiagVtx.entries()].filter(([k]) => k.startsWith("BAD"));
  const badN = bad.reduce((a, [, n]) => a + n, 0);
  for (const [k, n] of [...vpDiagClearRects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`[vpdiag]   ${String(n).padStart(5)}x clearrect ${k}`);
  }
  console.log(`[vpdiag] present #${present}: skipDraw=${webGpuExecStats.skipDraw || 0} ` +
              `draw=${webGpuExecStats.draw || 0} drawIdx=${webGpuExecStats.drawIdx || 0} ` +
              `clearRect=${self._wgClearRectN || 0}`);
  console.log(`[vpdiag] present #${present}: EFB passes=${vpDiagEfbPasses} ` +
              `clears=${vpDiagEfbClears} | EFB draws=${vpDiagDrawsTotalEfb}, ` +
              `${vpDiagDrawsSinceClear} after the last clear`);
  console.log(`[vpdiag] present #${present}: stride ok=${vpDiagStrideOk} ` +
              `bad=${vpDiagStrideBad} | position ok=${vpDiagPosOk} bad=${vpDiagPosBad}`);
  console.log(`[vpdiag] present #${present}: ${vpDiagVtx.size} distinct first-vertices, ` +
              `${badN} from non-finite/huge batches`);
  for (const [k, n] of [...vpDiagVtx.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x v0(${k})`);
  }
  console.log(`[vpdiag] present #${present}: last ${vpDiagTail.length} draws, in order`);
  for (const e of vpDiagTail) console.log(`[vpdiag]   ${e}`);
  const projRows = [...vpDiagProj.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(`[vpdiag] present #${present}: ${vpDiagProj.size} distinct projections`);
  for (const [k, n] of [...vpDiagFog.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x ${k}`);
  }
  console.log(`[vpdiag] shaders by stage ${JSON.stringify(vpDiagShaderStage)} ` +
              `| pixel shaders containing discard: ${vpDiagShaderWithDiscard}`);
  for (const [k, n] of [...vpDiagTc0.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x tc0 ${k}`);
  }
  for (const [k, n] of [...vpDiagMissing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x missingColor ${k}`);
  }
  for (const [k, n] of [...vpDiagLight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x ${k}`);
  }
  for (const [k, n] of [...vpDiagTexMtx.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    const v = k.split(",");
    console.log(`[vpdiag]   ${String(n).padStart(4)}x texmtx0` +
      ` [${v.slice(0, 4).join(" ")}] [${v.slice(4, 8).join(" ")}] [${v.slice(8, 12).join(" ")}]`);
  }
  for (const [k, n] of [...vpDiagTexUploadShape.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x texupload ${k}`);
  }
  for (const [k, n] of [...vpDiagCol0.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x col0 ${k}`);
  }
  for (const [k, n] of [...vpDiagBatchPos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x batchpos ${k}`);
  }
  for (const [k, n] of [...vpDiagIdxTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x ${k}`);
  }
  // Per-pipeline colour-attribute presence, weighted by depth-tested draw
  // count. No upload/pipeline pairing is involved, so this cannot suffer the
  // ambiguity that broke the earlier per-batch colour probe.
  {
    const rows = [...vpDiagPipeDraws.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [pid, n] of rows) {
      const l = vpDiagPipeVtx.get(pid);
      const c = l && l.col0;
      console.log(`[vpdiag]   pipe ${pid}: ${n} draws stride=${l ? l.stride : "?"} ` +
        `col0=${c ? `${c.format}@${c.offset}` : "ABSENT"}`);
    }
  }
  // Static profile of the busiest depth-tested pipelines: whether each has a
  // colour attribute, whether its fragment shader even declares the
  // @location(0) colour varying, and how it blends. A pipeline whose FS has no
  // colour varying cannot be using the rasterised colour, so a zero vertex
  // alpha is irrelevant to it -- which is the check 5f88837 skipped when it
  // joined a shader from one pipeline to a vertex shader from another.
  for (const [pid, n] of [...vpDiagPipeDraws.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    const l = vpDiagPipeVtx.get(pid);
    const fs = l ? vpDiagFsSource.get(l.fsId) : null;
    const hasColourVarying = fs ? /@location\(0\)\s+\w+\s*:\s*vec4<f32>/.test(fs) : null;
    const blend = l ? (l.blendEnable ? `blend${l.srcF}/${l.dstF}` : "noblend") : "?";
    console.log(`[vpdiag]   pipe ${pid}: ${n} draws col0=${l && l.col0 ? "yes" : "no"} ` +
      `fsColourVarying=${hasColourVarying === null ? "?" : hasColourVarying} ` +
      `${blend} wm${l ? l.writeMask : "?"}`);
  }
  if (present >= 2500) vpDiagDumpTopShader();
  console.log(`[vpdiag] present #${present}: world draws bind ` +
              `${vpDiagTexBind.size} distinct textures`);
  for (const [k, n] of [...vpDiagTexBind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x ${k}`);
  }
  console.log(`[vpdiag] present #${present}: ${vpDiagTev.size} distinct TEV register sets`);
  for (const [k, n] of [...vpDiagTev.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    console.log(`[vpdiag]   ${String(n).padStart(4)}x tev ${k}`);
  }
  for (const [k, n] of [...vpDiagPcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    const v = k.split(",");
    console.log(`[vpdiag]   ${String(n).padStart(4)}x pcc[${v.slice(0, 4).join(" ")}]` +
                ` vsViewport[${v.slice(4, 6).join(" ")}]`);
  }
  for (const [k, n] of [...vpDiagXf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    const v = k.split(",");
    console.log(`[vpdiag]   ${String(n).padStart(4)}x xf0` +
      ` [${v.slice(0, 4).join(" ")}] [${v.slice(4, 8).join(" ")}] [${v.slice(8, 12).join(" ")}]`);
  }
  const pnmRows = [...vpDiagPnm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`[vpdiag] present #${present}: ${vpDiagPnm.size} distinct modelviews`);
  for (const [k, n] of pnmRows) {
    const v = k.split(",");
    console.log(`[vpdiag]   ${String(n).padStart(4)}x pnm` +
      ` [${v.slice(0, 4).join(" ")}]` +
      ` [${v.slice(4, 8).join(" ")}]` +
      ` [${v.slice(8, 12).join(" ")}]`);
  }
  for (const [k, n] of projRows) {
    const v = k.split(",");
    console.log(`[vpdiag]   ${String(n).padStart(4)}x proj` +
      ` [${v.slice(0, 4).join(" ")}]` +
      ` [${v.slice(4, 8).join(" ")}]` +
      ` [${v.slice(8, 12).join(" ")}]` +
      ` [${v.slice(12, 16).join(" ")}]`);
  }
  console.log(`[vpdiag] present #${present}: ${vpDiagDraws} draws, ` +
              `${vpDiagTally.size} distinct (framebuffer, depth range, compare) tuples`);
  const rows = [...vpDiagTally.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, n] of rows) console.log(`[vpdiag] ${String(n).padStart(5)}x  ${key}`);
  // The headline: is any single pass internally mixed?
  const byFb = new Map();
  for (const [key, n] of rows) {
    const fb = key.slice(0, key.indexOf(" "));
    if (!byFb.has(fb)) byFb.set(fb, new Map());
    const cls = key.includes("INVERTED") ? "INVERTED"
      : (key.includes("ZEROWIDTH") ? "ZEROWIDTH"
        : (key.includes("unset") ? "unset" : "normal"));
    byFb.get(fb).set(cls, (byFb.get(fb).get(cls) || 0) + n);
  }
  for (const [fb, classes] of byFb) {
    const parts = [...classes.entries()].map(([c, n]) => `${c}=${n}`).join(" ");
    console.log(`[vpdiag] ${fb} ${parts}` +
                (classes.size > 1 ? "   <-- MIXED depth conventions in one pass" : ""));
  }
  console.log("[vpdiag] END");
}
let diagEfbDrawsThisFrame = 0;
let diagLastCopyDst = 0;
let diagLastCopyFrame = -1;
function diagNoteXfbCopy(fbId) {
  if (!DIAG_EFB_TO_CANVAS) return;
  self._wgXfbCopyN = (self._wgXfbCopyN || 0) + 1;
  if (self._wgXfbCopyN <= 8 || (self._wgXfbCopyN % 900) === 0) {
    console.log(`[xfbtime] copy#${self._wgXfbCopyN} into fb#${fbId} after ` +
                `${diagEfbDrawsThisFrame} EFB draws this frame`);
  }
}
function diagFrameEnd() {
  if (!DIAG_EFB_TO_CANVAS) return;
  self._wgFrameN = (self._wgFrameN || 0) + 1;
  if (self._wgFrameN <= 4 || (self._wgFrameN % 400) === 0) {
    console.log(`[xfbtime] frame#${self._wgFrameN} total EFB draws=${diagEfbDrawsThisFrame}`);
  }
  diagEfbDrawsThisFrame = 0;
  diagBbDrawsThisFrame = 0;
}
// Read back the EFB and the texture actually presented, at the same instant,
// and reduce each to a 4x3 grid of mean RGB. If the grids agree, the XFB entry
// holds the right picture and the fault is downstream of it. If they disagree,
// the copy's CONTENT is wrong -- which is where the evidence points, since its
// source rect, destination size and binding all measure correct.
function diagGridSignature(bytes, bpr, w, h) {
  const cells = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x0 = Math.floor(gx * w / 4), x1 = Math.floor((gx + 1) * w / 4);
      const y0 = Math.floor(gy * h / 3), y1 = Math.floor((gy + 1) * h / 3);
      // Alpha included: the TEV alpha stage reduces to texAlpha * vertexAlpha
      // and 206 world draws blend srcAlpha/one-minus-srcAlpha, so a zero alpha
      // channel makes a draw invisible however bright its RGB is. Every earlier
      // readback averaged only r, g and b.
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y += 4) {
        for (let x = x0; x < x1; x += 4) {
          const o = y * bpr + x * 4;
          r += bytes[o]; g += bytes[o + 1]; b += bytes[o + 2]; a += bytes[o + 3]; n++;
        }
      }
      cells.push(n ? `${(r / n) | 0},${(g / n) | 0},${(b / n) | 0}/a${(a / n) | 0}` : "-");
    }
  }
  return cells.join(" | ");
}
// Depth readback. diagReadTexture refuses depth formats, but the question is
// exactly what depth values the world draws leave in the buffer: the viewport
// bands and the vertex shader together predict 0.00..0.84 for the world, and if
// the stored values are elsewhere the viewport transform is not mapping as
// assumed. depth32float copies with aspect "depth-only", 4 bytes a texel.
// mapAsync on a readback buffer BEFORE the encoder that copies into it is
// submitted makes that submit invalid ("used in submit while pending map"), and
// Dawn then drops the whole command buffer: the frame's draws, the copy, all of
// it. The buffer maps anyway and reads back as the zeros it was created with.
// That is exactly what the present-time depth readback reported, and what the
// first two depth-trace runs reported, control write included. Every readback
// must queue its map here and drain it after queue.submit().
function dtraceDefer(fn) {
  (self._wgDtPending = self._wgDtPending || []).push(fn);
}
function dtraceDrainPending() {
  const pend = self._wgDtPending;
  if (!pend || !pend.length) return;
  self._wgDtPending = [];
  for (const fn of pend) {
    try { fn(); } catch (e) { console.log("[dtrace] drain failed: " + (e && e.message)); }
  }
}
function diagReadDepth(dev, encoder, entry, tag) {
  if (!entry || !entry.tex) return;
  const w = entry.tex.width, h = entry.tex.height;
  const bpr = Math.ceil(w * 4 / 256) * 256;
  let buf;
  try {
    buf = dev.createBuffer({ size: bpr * h, usage: 0x1 | 0x8 });
    encoder.copyTextureToBuffer({ texture: entry.tex, aspect: "depth-only" },
      { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 });
  } catch (e) {
    console.log("[vpdiag] depth readback rejected: " + (e && e.message));
    return;
  }
  dtraceDefer(() => buf.mapAsync(0x1).then(() => {
    const f = new Float32Array(buf.getMappedRange());
    const stride = bpr >> 2;
    let mn = Infinity, mx = -Infinity, sum = 0, n = 0, zeros = 0;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const v = f[y * stride + x];
        if (!Number.isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        if (v === 0) zeros++;
        sum += v; n++;
      }
    }
    console.log(`[vpdiag] EFB depth ${tag} ${w}x${h}: min=${mn.toFixed(4)} ` +
      `max=${mx.toFixed(4)} mean=${(sum / Math.max(1, n)).toFixed(4)} ` +
      `zeros=${zeros}/${n}`);
    buf.unmap();
  }).catch(() => {}));
}
function diagReadDepthTrace(dev, encoder, entry, tag) {
  const dt = self._wgDt;
  if (!entry || !entry.tex) { console.log(`[dtrace] no depth texture for: ${tag}`); return; }
  const w = entry.tex.width, h = entry.tex.height;
  const bpr = Math.ceil(w * 4 / 256) * 256;
  let buf;
  try {
    buf = dev.createBuffer({ size: bpr * h, usage: 0x1 | 0x8 });
    encoder.copyTextureToBuffer({ texture: entry.tex, aspect: "depth-only" },
      { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 });
  } catch (e) { console.log(`[dtrace] copy rejected (${tag}): ${e && e.message}`); return; }
  if (dt) dt.issued++;
  const seq = dt ? dt.issued : 0;
  dtraceDefer(() => buf.mapAsync(0x1).then(() => {
    const f = new Float32Array(buf.getMappedRange());
    const stride = bpr >> 2;
    let mn = Infinity, mx = -Infinity, sum = 0, n = 0, nz = 0;
    // 4x3 grid of the fraction of NON-ZERO texels, so where the writes landed
    // is visible, not just whether any did.
    const grid = new Array(12).fill(0), gridN = new Array(12).fill(0);
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const v = f[y * stride + x]; n++;
        const g = Math.floor(y * 3 / h) * 4 + Math.floor(x * 4 / w); gridN[g]++;
        if (v !== 0) {
          nz++; grid[g]++;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          sum += v;
        }
      }
    }
    console.log(`[dtrace] #${seq} ${tag}: nonzero=${nz}/${n} ` +
      (nz ? `min=${mn.toFixed(4)} max=${mx.toFixed(4)} mean=${(sum / nz).toFixed(4)} ` : "") +
      `grid%=[${grid.map((c, i) => Math.round(100 * c / Math.max(1, gridN[i]))).join(",")}]`);
    buf.unmap(); buf.destroy();
    if (dt) dt.done++;
  }).catch((e) => console.log(`[dtrace] #${seq} map failed (${tag}): ${e && e.message}`)));
}
function diagReadColorTrace(dev, encoder, entry, tag) {
  if (!entry || !entry.tex) { console.log(`[dtrace] no colour texture for: ${tag}`); return; }
  const w = entry.tex.width, h = entry.tex.height;
  const bpr = Math.ceil(w * 4 / 256) * 256;
  let buf;
  try {
    buf = dev.createBuffer({ size: bpr * h, usage: 0x1 | 0x8 });
    encoder.copyTextureToBuffer({ texture: entry.tex },
      { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 });
  } catch (e) { console.log(`[dtrace] colour copy rejected (${tag}): ${e && e.message}`); return; }
  const dt = self._wgDt;
  const seq = dt ? dt.issued : 0;
  dtraceDefer(() => buf.mapAsync(0x1).then(() => {
    const bytes = new Uint8Array(buf.getMappedRange());
    console.log(`[dtrace] #${seq} colour ${tag}: ${diagGridSignature(bytes, bpr, w, h)}`);
    buf.unmap(); buf.destroy();
  }).catch((e) => console.log(`[dtrace] #${seq} colour map failed (${tag}): ${e && e.message}`)));
}
function diagReadTexture(dev, encoder, entry, label, tag) {
  if (!entry || !entry.tex || String(entry.format || "").startsWith("depth")) return;
  const w = entry.tex.width, h = entry.tex.height;
  const bpr = Math.ceil(w * 4 / 256) * 256;
  let buf;
  try {
    buf = dev.createBuffer({ size: bpr * h, usage: 0x1 | 0x8 });
    encoder.copyTextureToBuffer({ texture: entry.tex },
      { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 });
  } catch (e) { return; }
  self._wgGridPending = self._wgGridPending || [];
  self._wgGridPending.push({ buf, bpr, w, h, label, tag });
}
function diagDrainGrids() {
  const pend = self._wgGridPending;
  if (!pend || !pend.length) return;
  self._wgGridPending = [];
  for (const p of pend) {
    p.buf.mapAsync(0x1).then(() => {
      const bytes = new Uint8Array(p.buf.getMappedRange());
      console.log(`[grid] ${p.tag} ${p.label} ${p.w}x${p.h} :: ` +
                  diagGridSignature(bytes, p.bpr, p.w, p.h));
      try { p.buf.unmap(); p.buf.destroy(); } catch (e) {}
    }).catch(() => {});
  }
}
// Every draw that lands in the backbuffer, with what it samples and where it
// puts it. The race frame is composed of mismatched rectangles, which is what
// several draws sampling different XFB entries into different sub-rects looks
// like -- Dolphin stitches XFB containers from multiple copies.
let diagBbDrawsThisFrame = 0;
function diagNoteBackbufferDraw(srcId, vp, sc) {
  if (!DIAG_EFB_TO_CANVAS) return;
  diagBbDrawsThisFrame++;
  self._wgBbDrawN = (self._wgBbDrawN || 0) + 1;
  if (self._wgBbDrawN <= 12 || (self._wgBbDrawN % 900) === 0) {
    console.log(`[bbdraw] #${diagBbDrawsThisFrame} src=tex#${srcId || 0} ` +
                `vp=${vp} sc=${sc} lastCopyDst=tex#${diagLastCopyDst} ` +
                `${srcId === diagLastCopyDst ? "FRESH" : "STALE"} ` +
                `copyFrame=${diagLastCopyFrame} nowFrame=${self._wgFrameN || 0}`);
  }
}
// srcId is passed in: currentBackbufferSourceTextureId lives inside the
// executor closure, and referencing it from this module-level function threw a
// ReferenceError on every backbuffer draw, swallowed by the executor.
// Scissored clear inside an open render pass.
//
// WebGPU's loadOp:clear always clears the whole attachment and ignores
// setScissorRect, so a sub-rect clear has to be a DRAW. Doing it as a utility
// draw in the core was tried and reverted -- that path ends and restarts the
// pass per clear, and Wario World issues ~7,800 a frame. Here the pass stays
// open: set the scissor, draw one full-screen triangle, restore the scissor.
//
// The colour and depth are baked into the shader constant rather than passed in
// a uniform buffer, so a clear costs no buffer write. The trade is that the
// cache is keyed on the clear value, so a game that animates one -- a fade, a
// cycling fog colour -- mints a pipeline per frame.
//
// The cap therefore evicts rather than refusing. Returning null past the cap
// dropped the clear silently and permanently: the cache never shrank, so once
// 64 distinct values had been seen, every subsequent clear with a new value did
// nothing at all and the EFB kept whatever was under it. Least-recently-used
// eviction bounds the cache the same way, and the worst case is re-creating a
// pipeline instead of skipping a clear.
const WGPU_CLEAR_PIPELINES = new Map();
const WGPU_CLEAR_PIPELINE_CAP = 64;
function ensureClearPipeline(dev, colorFormat, depthFormat, colorWriteMask, writeDepth, rgba, depth) {
  const key = `${colorFormat}|${depthFormat || "-"}|${colorWriteMask}` +
              `|${writeDepth ? 1 : 0}|${rgba}|${depth.toFixed(6)}`;
  const hit = WGPU_CLEAR_PIPELINES.get(key);
  if (hit) {
    // Refresh recency: delete + set moves the key to the end of the Map's
    // insertion order, which is what makes the eviction below LRU.
    WGPU_CLEAR_PIPELINES.delete(key);
    WGPU_CLEAR_PIPELINES.set(key, hit);
    return hit;
  }
  while (WGPU_CLEAR_PIPELINES.size >= WGPU_CLEAR_PIPELINE_CAP) {
    const oldest = WGPU_CLEAR_PIPELINES.keys().next();
    if (oldest.done) break;
    WGPU_CLEAR_PIPELINES.delete(oldest.value);
  }
  const r = ((rgba >>> 24) & 0xff) / 255;
  const g = ((rgba >>> 16) & 0xff) / 255;
  const b = ((rgba >>> 8) & 0xff) / 255;
  const a = (rgba & 0xff) / 255;
  const z = Math.min(1, Math.max(0, depth));
  const wgsl = `
@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -3.0), vec2(-1.0, 1.0), vec2(3.0, 1.0));
  return vec4<f32>(p[i], ${z.toFixed(6)}, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(${r.toFixed(6)}, ${g.toFixed(6)}, ${b.toFixed(6)}, ${a.toFixed(6)});
}`;
  let pipe = null;
  try {
    const mod = dev.createShaderModule({ code: wgsl, label: "dolphin-clearrect" });
    const desc = {
      label: "dolphin-clearrect",
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs" },
      primitive: { topology: "triangle-list" }
    };
    // Colour must still be written as an attachment even when only depth is
    // being cleared, otherwise the pipeline is incompatible with the pass.
    desc.fragment = {
      module: mod, entryPoint: "fs",
      targets: [{ format: colorFormat, writeMask: colorWriteMask }]
    };
    if (depthFormat) {
      desc.depthStencil = {
        format: depthFormat,
        depthWriteEnabled: Boolean(writeDepth),
        depthCompare: "always"
      };
    }
    pipe = dev.createRenderPipeline(desc);
  } catch (e) {
    recordRendererError("validation", `clearrect pipeline: ${e?.message || e}`);
    pipe = null;
  }
  WGPU_CLEAR_PIPELINES.set(key, pipe);
  return pipe;
}
function diagTallyDrawTarget(passFbId, srcId) {
  if (!DIAG_EFB_TO_CANVAS) return;
  if (passFbId === 0)
    diagNoteBackbufferDraw(srcId, self._wgLastVp || "?", self._wgLastSc || "?");
  if (passFbId === (self._wgEfbColorId || -1)) diagEfbDrawsThisFrame++;
  self._wgDrawByFb = self._wgDrawByFb || new Map();
  self._wgDrawByFb.set(passFbId, (self._wgDrawByFb.get(passFbId) || 0) + 1);
  self._wgDrawTally = (self._wgDrawTally || 0) + 1;
  if ((self._wgDrawTally % 4000) === 0) {
    const top = [...self._wgDrawByFb.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([fb, n]) => `fb#${fb}:${n}`).join(' ');
    console.log(`[drawfb] efbColor=tex#${self._wgEfbColorId || 0} ` +
                `xfb=tex#${self._wgXfbId || 0} | ${top}`);
  }
}

// DIAGNOSTIC (revertible): force depthCompare "always" on every
// pipeline (see resolvePipeline) to bisect the black-EFB cause.
const DIAG_DEPTH_ALWAYS = false;  // §28ag: bisect done — dark 1P menu is NOT depth (still dark with depth bypassed) ⇒ blend/TEV/material/texture construct
// §28ad/§28af ROOT FIX: WebGPU can't carry Dolphin's reverse-Z in
// the viewport (Dawn rejects minDepth>maxDepth). Master enable for
// the per-PASS reverse-Z compensation (flip GX depth compare
// less↔greater + clear depth to far=0.0) — applied ONLY to
// reverse-Z passes (vp near>far); normal-Z menu/UI passes keep the
// GX compare + clear=1.0. See resolvePipeline / BEGIN_PASS (§28af).
// §28as REVERTED to true (paired with producer flag=true). flag=
// false rendered dark + hung even with fog decoupled (a 2nd
// coupling remains); back to the verified §28ao render+smooth
// state (flickers on mixed passes, root proven §28aq).
// §28at: coupling-(2) found & C++-decoupled (the depth-inversion
// cluster, api_type==Vulkan-gated). Producer flag now false →
// uniform normal-Z [0,1] viewports, no mixed reverse/normal pass.
// §28at: SINGLE convention = the reverse-Z one flag=true-3D proved
// works (dcv=0.0 + GEQUAL). Flip the GX compare for ALL rzRelevant
// draws (not per-pass-revZ — at flag=false every viewport is the
// same (0,1), so the §28af `&& revZ` gate never fires; the flip is
// applied uniformly via REVZ_COMPARE_FLIP_ALL below). One convention
// for every draw in every pass ⇒ the §28aq mixed-pass flicker is
// structurally impossible AND 3D/title renders (matches flag=true).
// GX_NATIVE_DEPTH: FALSIFIED, kept as a switch because it is the cheapest way
// to re-run the experiment.
//
// The per-draw tally showed every EFB viewport arrives non-inverted -- (0,0.84),
// (0.84,0.89), (0.89,0.99) -- and I read that as "these passes are normal-Z, so
// clear to 1.0 and leave the GX compare alone". That inference was wrong.
//
// BPFunctions emits near_depth = 1 - max_depth and far_depth = 1 - min_depth,
// so the viewport REVERSES depth: the game's near plane (min_depth) lands at
// the viewport's LARGER value and its far plane at the smaller one. Larger
// depth therefore means nearer, which is reverse-Z, which is exactly what the
// clear-to-0.0-plus-flipped-compare convention below assumes. The viewport
// arriving with near < far is what reverse-Z looks like after that 1-x, not
// evidence against it.
//
// Measured consequence of getting it backwards: Mario Kart Wii's world sits at
// z(0.00,0.84) and its HUD at z(0.89,0.99), i.e. the HUD is nearer. With
// GX_NATIVE_DEPTH the world occludes the HUD and the pause menu and controller
// overlay vanish entirely; with it false they render and match the software
// reference frame.
const GX_NATIVE_DEPTH = false;
const REVZ_COMPARE_FLIP = !GX_NATIVE_DEPTH;
// §28aw: decisive dark-menu experiment — force FS textureSampleBias
// array-layer to 0 (menu textures are single-layer, bound 2d-array;
// a non-zero texgen layer ⇒ out-of-range sample ⇒ black). Gated so
// it's toggleable/revertible; kept only if menu renders AND title/3D
// does not regress.
// §28aw FALSIFIED: forcing menu FS textureSampleBias layer→0 left the
// menu identically dark (hash unchanged) ⇒ array-layer is NOT the
// root. Flag kept inert (false) as a documented negative result.
const S28AW_FORCE_TEXLAYER0 = false;
// §28ax CONFIRMED: const-magenta FILLED the menu ⇒ draws reach the
// framebuffer with valid full-screen geometry; the dark is purely
// FS-internal. §28ay: dolphin_fn_1_→white showed only sparse white
// lines + a dark-blue region (NOT the full menu) ⇒ the texture
// sample WAS ~0 (secondary) AND the TEV/PS-constant chain collapses
// the bulk output regardless (DOMINANT). Both flags reverted to
// false (diagnostic shader rewrites must never ship); findings in
// SESSION §28ax/§28ay. Next: pinpoint which TEV PS-constant/UBO
// member is delivered ~0 for the menu draw.
const S28AX_FS_CONST = false;
const S28AY_SAMPLER_WHITE = false;
// §28bb FALSIFIED: textureSampleLevel(…,0.0) gave the IDENTICAL dark
// menu (hash 0x-680ec5c0, 0 valErr) ⇒ sample-mechanics (LOD/bias/
// mip) is NOT the root. By the §28ba decision rule this isolates the
// root to the UV addressing the WRONG atlas sub-region (the GC
// texgen/posttransform path, §28an/al). Flag reverted (false).
const S28BB_SAMPLE_LOD0 = false;
// §28bf RESULT: UV-as-colour showed a spatially-VARYING gradient
// (non-degenerate, not uniformly zero) ⇒ the texgen produces a real
// varying UV. Combined with §28be (posttransform verified correct at
// the right offset), every measurable value is correct yet the
// sample is ~0 — a systemic texgen/atlas/sample mismatch needing
// reference-texel comparison, not more value-probing. Flag reverted.
const S28BF_SHOW_UV = false;
// §28at: apply the compare flip uniformly (drop the per-pass `revZ`
// gate). The single reverse-Z convention is correct for every
// rzRelevant draw now that flag=false made all viewports uniform.
const REVZ_COMPARE_FLIP_ALL = !GX_NATIVE_DEPTH;
// DIAGNOSTIC (revertible): force cullMode "none" + skip scissor so no
// primitive is culled/scissored. With EFB→canvas: geometry appears ⇒
// it was rasterization state (cull/scissor); still black ⇒ VS math /
// vertex fetch / clip-space.
const DIAG_RASTER_OPEN = false;  // §28w: cull CONCLUSIVELY ruled out for the 3D region (clean A-only running repro)
// Cull-only variant. DIAG_RASTER_OPEN also disables the scissor, so it cannot
// separate the two. The §28w "conclusively ruled out" above was reached by
// comparing runs driven by the harness's random input script, which diverge
// into different scenes -- the methodology behind three retractions in
// docs/webgpu-hardware-renderer-bugs.md. Re-testable now against the
// deterministic save state.
const DIAG_CULL_NONE = false;
// Skip EFB draws whose pipeline ignores depth. The in-race frame carries ~21
// full-screen depth=always quads; if one of them is painting over the world,
// dropping them exposes the scene underneath. Diagnostic only -- these draws
// are real content upstream draws too.
const DIAG_SKIP_DEPTH_ALWAYS = false;
// Replace the fragment shader of every depth-using pipeline with one that
// returns a constant colour, keeping the real vertex shader so geometry is
// still transformed and rasterised normally. Legal because the cfg pipelines
// use an explicit fixed pipeline layout, not layout:"auto", so a fragment
// module may declare fewer bindings than the layout provides.
//
// If magenta geometry appears, primitives rasterise and the defect is in the
// TEV/texture path. If the frame stays black, the fragments are being
// discarded or the primitives never rasterise at all.
const DIAG_CONST_FS = false;
const DIAG_DUMMY_TINT = false;
const DIAG_NO_DISCARD = false;
const DIAG_FORCE_LAYER0 = false;
const DIAG_FORCE_UV = false;
const DIAG_UV_FINITE = false;
// Visualise the UV instead of judging it: red = fract(u), green = fract(v).
// A healthy surface shows a red/green gradient across it; a UV pinned near zero
// shows near-black, and a constant UV shows one flat colour.
const DIAG_UV_VIS = false;
const DIAG_UV_PERTURB = false;
const DIAG_SHOW_VCOLOR = false;
// Render ONLY the opaque depth-tested EFB draws -- blendEnable false -- and
// skip the blended ones. The two busiest pipelines are noblend/wm15 with a
// colour attribute, so they ignore alpha entirely and should be visible
// whatever the vertex alpha does. Selecting by PROPERTY not by pipeline id:
// bridge ids are assigned per run and shift between them.
const DIAG_ONLY_OPAQUE = false;
// Constant colour on the OPAQUE depth-tested pipelines only. The earlier
// const-FS test covered every depth pipeline including the blended ones, and
// returned alpha 1.0, so its magenta could have come entirely from those. This
// isolates the noblend/wm15 pipelines that carry ~47,000 draws and are
// invisible even though they ignore alpha.
const DIAG_CONST_FS_OPAQUE = false;
// With the constant colour forced on the opaque pipelines they still produce
// nothing, so they are not rasterising. Force their depth compare to "always"
// as well: if magenta then appears, the depth test is what rejects them.
const DIAG_OPAQUE_DEPTH_ALWAYS = false;
function vpDiagIsBlended(pipelineId) {
  const l = vpDiagPipeVtx.get(pipelineId);
  return !!(l && l.blendEnable);
}
const DIAG_ALPHA_COVERAGE = false;
// Show vertex ALPHA as greyscale. The alpha stage reduces to
// texAlpha * vertexAlpha, texture alpha measured 58..255, and the RGB
// visualisation forced alpha to 1.0 -- so vertex alpha is the one operand in
// that product still unmeasured.
const DIAG_SHOW_VALPHA = false;
// Drop EFB draws whose sampled texture received no non-zero data. If the empty
// textures cover the large surfaces, what remains should be the draws that
// sample populated textures -- and whether anything recognisable appears says
// how much of the blackness those empty textures actually account for.
const DIAG_SKIP_EMPTY_TEX = false;
const DIAG_TEX_READBACK = false;
const DIAG_DEPTH_READBACK = false;
// Depth trace. The present-time depth readback cannot say WHEN the buffer was
// zero: several frames share an encoder and clears re-run. This reads the EFB
// depth buffer inside the target frame, in the same encoder, at chosen points:
// after the Nth EFB draw (the pass is ended, copied, and re-opened with load
// ops and its state restored), before every depth-clearing ClearRect, and at
// every EFB pass end. Each read is tagged with how many EFB draws and
// depth-writing draws preceded it, so "no fragment ever wrote depth" and "the
// writes were wiped afterwards" become distinguishable.
const DIAG_DEPTH_TRACE = false;
const DTRACE_PRESENT = 2500;
const DTRACE_SPLITS = new Set([1, 5, 20, 60, 119, 135, 251, 384, 419, 500, 792]);
// Positive control: at the first split, write a known depth through the clear
// pipeline over a 64x64 corner rect, so the readbacks that follow prove they
// read the attachment the pass writes. A probe that cannot see its own write
// is a null instrument, whatever else it reports.
const DTRACE_CONTROL = true;
// FINAL depth state per created pipeline object, so a draw can be classified
// by what the descriptor actually carried rather than the pre-flip template.
const vpDiagPipeFinalDs = new WeakMap();
// Render ONE depth-tested EFB draw per frame and skip the rest, so a single
// draw's output can be observed directly instead of inferred from texture and
// state accounting. The index advances every 300 presents so successive
// screenshots show different draws. Depth-less draws (the 2D overlay) are kept
// for orientation.
const DIAG_ISOLATE_DRAW = false;
// Constant colour on pipelines that perform a REAL depth test (less/greater
// family), leaving depth=always and depth=none alone. DIAG_CONST_FS covers
// every depth-using pipeline including the always quads, which are the only
// visible content, so it cannot show whether the less-equal world draws
// actually cover the screen. This can.
const DIAG_CONST_FS_TESTED_ONLY = false;
// Substitute a trivial vertex shader (plus the constant fragment shader, since
// a trivial VS cannot satisfy the real FS's inputs) on genuinely depth-tested
// pipelines. It reads the position attribute at location 0 and normalises
// model-space coordinates into clip space, so what appears is the silhouette
// the vertex data itself describes -- independent of the translated VS, the
// uniform blocks and the transform. If a real mesh appears, the data is fine
// and the translated vertex shader is where the geometry goes wrong.
const DIAG_TRIVIAL_VS = false;
let diagTrivialVsModule = null;
function getTrivialVsModule(dev) {
  if (!diagTrivialVsModule) {
    diagTrivialVsModule = dev.createShaderModule({
      label: "diag-trivial-vs",
      code: "@vertex fn main(@location(0) p: vec2<f32>) -> @builtin(position) vec4<f32> " +
            "{ return vec4<f32>(p.x / 400.0, p.y / 400.0, 0.5, 1.0); }"
    });
  }
  return diagTrivialVsModule;
}
let vpDiagIsolateIdx = 0;
let vpDiagIsolateSeen = 0;
function vpDiagIsolateAllows(fbId, pipelineId) {
  if (!DIAG_ISOLATE_DRAW || fbId !== self._wgEfbColorId) return true;
  const tpl = webGpuObjects.pipeTpl.get(pipelineId);
  const cmp = tpl && tpl.depthBase ? tpl.depthBase.depthCompare : "none";
  if (cmp === "none") return true;              // 2D overlay: always keep
  const n = vpDiagIsolateSeen++;
  return n === vpDiagIsolateIdx;
}
let vpDiagReadbackDone = false;
let vpDiagLastPicks = [];
function vpDiagTexIsEmpty(texId) {
  const rec = vpDiagTexData.get(texId);
  if (!rec) return false;                 // never uploaded: unknown, keep it
  return rec.nonZero === 0 || (rec.samples && rec.nzBytes === 0);
}
let vpDiagUvFinite = 0;
// Replace the sample with a verdict colour instead of a texel: magenta when the
// sampled UV is finite, green when it is NaN or infinite. WGSL has no isNan, so
// NaN is caught by (uv != uv) and infinities by abs(uv) > 1e30. The verdict
// still flows through the TEV maths, so read the HUE, not the exact colour.
function pickVariantFs(fsId) {
  const v = webGpuObjects.shadersUvForced.get(fsId);
  if (v && ++vpDiagVariantUsed <= 1) {
    console.log("[vpdiag] variant fragment module selected for a depth pipeline");
  }
  return v;
}
let vpDiagVariantUsed = 0;
// Perturb the sample instead of replacing it: keep the real call, add a
// constant blue to its result. Every earlier probe substituted the sample, so
// the verdict always flowed through the TEV maths afterwards and could not tell
// "the texel is black" from "TEV zeroes a good texel".
//   blue appears  -> the sample result reaches the output, so the texel is black
//   stays black   -> TEV discards it regardless of what was sampled
// Return the interpolated vertex colour0 instead of the TEV result, keeping the
// shader's own signature and bindings. The combine is
// texture.rgb + vertexColour0.rgb, so if this comes back black the lighting
// path supplies nothing and the dark texel is only half the story.
function vcolorRewrite(src) {
  const sig = /@location\(0\)\s+(\w+)\s*:\s*vec4<f32>/.exec(src);
  if (!sig) return null;
  const name = sig[1];
  // The fragment entry's final `return _eN;` is the last return in the module.
  const m = [...src.matchAll(/return\s+(\w+)\s*;/g)];
  if (!m.length) return null;
  const last = m[m.length - 1];
  const out = src.slice(0, last.index) +
    // Alpha in red, a constant 1.0 in green as a coverage marker. This is what
    // ad77cd6's greyscale version could not do: there, black meant "alpha zero"
    // OR "no draw covered this pixel", and the two are not the same claim.
    //   black  = not covered by any depth-tested draw
    //   green  = covered, vertex alpha 0
    //   yellow = covered, vertex alpha 1
    (DIAG_ALPHA_COVERAGE
      ? `return vec4<f32>(${name}.w, 1.0, 0.0, 1.0);`
      : DIAG_SHOW_VALPHA
        ? `return vec4<f32>(${name}.w, ${name}.w, ${name}.w, 1.0);`
        : `return vec4<f32>(${name}.x, ${name}.y, ${name}.z, 1.0);`) +
    src.slice(last.index + last[0].length);
  if (out !== src && ++vpDiagVcolor <= 1) {
    console.log("[vpdiag] built vertex-colour visualisation variants");
  }
  return out === src ? null : out;
}
let vpDiagVcolor = 0;
function uvPerturbRewrite(src) {
  const out = src.replace(
    /(textureSample[A-Za-z]*\([^;]*?\));/g,
    "($1 + vec4<f32>(0.0, 0.0, 0.5, 0.0));");
  if (out !== src && ++vpDiagUvPerturb <= 1) {
    console.log("[vpdiag] built sample-perturbation variants");
  }
  return out === src ? null : out;
}
let vpDiagUvPerturb = 0;
function uvFiniteRewrite(src) {
  const out = src.replace(
    // Match the WHOLE call up to its terminating ");", so textureSampleBias --
    // which carries a trailing bias argument -- is rewritten too. Requiring the
    // call to end right after the layer matched only plain textureSample, which
    // is why the first version left the frame untouched.
    /textureSample[A-Za-z]*\(([^,]+),\s*([^,]+),\s*(vec2<f32>\([^)]*\))[^;]*?\);/g,
    (DIAG_UV_VIS
      ? "vec4<f32>(fract($3.x), fract($3.y), 0.0, 1.0);"
      : "select(vec4<f32>(1.0, 0.0, 1.0, 1.0), vec4<f32>(0.0, 1.0, 0.0, 1.0), " +
        "any($3 != $3) || any(abs($3) > vec2<f32>(1e30, 1e30)));"));
  if (out !== src && ++vpDiagUvFinite <= 1) {
    console.log("[vpdiag] built UV-finiteness probe variants");
  }
  return out === src ? null : out;
}
function uvForceRewrite(src) {
  const out = src.replace(
    /textureSample([A-Za-z]*)\(([^,]+),\s*([^,]+),\s*vec2<f32>\([^)]*\)/g,
    "textureSample$1($2, $3, vec2<f32>(0.5, 0.5)");
  if (out !== src && ++vpDiagUvForced <= 1) {
    console.log("[vpdiag] built UV-forced fragment variants");
  }
  return out === src ? null : out;
}
let vpDiagUvForced = 0;
let vpDiagLayerForced = 0;
let vpDiagDiscardStripped = 0;
const vpDiagShaderStage = {};
let vpDiagShaderWithDiscard = 0;
let diagConstFsModule = null;
function getConstFsModule(dev) {
  if (!diagConstFsModule) {
    diagConstFsModule = dev.createShaderModule({
      label: "diag-const-fs",
      code: "@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 1.0, 1.0); }"
    });
  }
  return diagConstFsModule;
}

// Set true once the WebGPU hardware renderer (cmd-ring executor) has
// presented a frame; suppresses the legacy CPU-framebuffer canvas blit
// in runPresentationLoop so the two don't fight over renderGpu.context.
let cmdRingOwnsCanvas = false;
const webGpuExecStats = {
  beginFb0: 0, beginFbN: 0, draw: 0, drawIdx: 0, setPipe: 0,
  setBg: 0, present: 0, missPipe: 0, missBg: 0, skipDraw: 0, lastLog: 0
};
const webGpuCausalStats = {
  drainCount: 0,
  emptyDrainCount: 0,
  commandsProcessed: 0,
  drainLastMs: 0,
  drainTotalMs: 0,
  drainMaxMs: 0,
  backlogLast: 0,
  backlogHighWater: 0,
  replayPumpDrainCount: 0,
  replayPumpEmptyPollCount: 0,
  replayPumpScheduleCount: 0,
  replayPumpBacklogScheduleCount: 0,
  replayPumpIdleScheduleCount: 0,
  replayPumpWakeCount: 0,
  replayPumpWakeDelayLastMs: 0,
  replayPumpWakeDelayTotalMs: 0,
  replayPumpWakeDelayMaxMs: 0,
  replayWindowRecords: 0,
  replayBudgetEnabled: false,
  replayBudgetMs: 0,
  replayBudgetCheckIntervalRecords: WGPU_REPLAY_BUDGET_CHECK_RECORDS,
  replayBudgetCheckCount: 0,
  replayBudgetYieldCount: 0,
  replayBudgetDeadlineReachedCount: 0,
  replayBudgetAtomicContinuationCount: 0,
  replayBudgetAtomicOverrunCount: 0,
  replayBudgetAtomicOverrunTotalMs: 0,
  replayBudgetAtomicOverrunMaxMs: 0,
  replayBudgetPresentationRedrainSuppressedCount: 0,
  replayBudgetSourceCounts: { presentation: 0, pump: 0 },
  replayBudgetSourceYieldCounts: { presentation: 0, pump: 0 },
  replayBudgetStopReasons: {
    empty: 0,
    write: 0,
    "record-window": 0,
    "time-budget": 0,
    "deferred-begin": 0,
    "load-fence": 0,
  },
  drainDurationBucketBoundsMs: [...WGPU_DRAIN_DURATION_BUCKET_BOUNDS_MS],
  drainDurationHistogram: new Array(WGPU_DRAIN_DURATION_BUCKET_BOUNDS_MS.length + 1).fill(0),
  drainCommandBucketBounds: [...WGPU_DRAIN_COMMAND_BUCKET_BOUNDS],
  drainCommandHistogram: new Array(WGPU_DRAIN_COMMAND_BUCKET_BOUNDS.length + 1).fill(0),
  backlogSampleCount: 0,
  backlogSampleAverage: 0,
  backlogAfterLast: 0,
  backlogAfterHighWater: 0,
  backlogIntegralRecordMs: 0,
  backlogNonzeroAgeLastMs: 0,
  backlogNonzeroAgeMaxMs: 0,
  stageBudgetYieldCount: 0,
  stageCopyDeadlineOverrunCount: 0,
  stageCopyDeadlineOverrunMaxMs: 0,
  uploadReadLast: 0,
  uploadReleaseCount: 0,
  heldUploadStagedCount: 0,
  heldUploadStagedBytes: 0,
  heldUploadStagedHighWaterBytes: 0,
  heldUploadStageLimitCount: 0,
  heldUploadScanCount: 0,
  producerStateCacheEnabled: false,
  producerPipelineRecordsSuppressed: 0,
  producerBindGroupRecordsSuppressed: [0, 0, 0],
  producerVertexBufferRecordsSuppressed: 0,
  producerIndexBufferRecordsSuppressed: 0,
  producerProfile: {
    schema: WGPU_PRODUCER_PROFILE_SCHEMA,
    requested: false,
    available: false,
    version: 1,
    enabled: false,
    epoch: 0,
    phaseCount: WGPU_PRODUCER_PROFILE_PHASE_ORDER.length,
    phaseOrder: [...WGPU_PRODUCER_PROFILE_PHASE_ORDER],
    periods: new Array(WGPU_PRODUCER_PROFILE_PHASE_ORDER.length).fill(0),
    calls: new Array(WGPU_PRODUCER_PROFILE_PHASE_ORDER.length).fill(0),
    samples: new Array(WGPU_PRODUCER_PROFILE_PHASE_ORDER.length).fill(0),
    sampleTotalNs: new Array(WGPU_PRODUCER_PROFILE_PHASE_ORDER.length).fill(0),
    sampleMaxNs: new Array(WGPU_PRODUCER_PROFILE_PHASE_ORDER.length).fill(0),
    estimatedTotalNs: new Array(WGPU_PRODUCER_PROFILE_PHASE_ORDER.length).fill(0),
  },
  drawProfile: {
    schema: WGPU_DRAW_PROFILE_SCHEMA,
    requested: false,
    available: false,
    version: 1,
    enabled: false,
    epoch: 0,
    phaseCount: WGPU_DRAW_PROFILE_PHASE_ORDER.length,
    phaseOrder: [...WGPU_DRAW_PROFILE_PHASE_ORDER],
    periods: new Array(WGPU_DRAW_PROFILE_PHASE_ORDER.length).fill(0),
    calls: new Array(WGPU_DRAW_PROFILE_PHASE_ORDER.length).fill(0),
    samples: new Array(WGPU_DRAW_PROFILE_PHASE_ORDER.length).fill(0),
    sampleTotalNs: new Array(WGPU_DRAW_PROFILE_PHASE_ORDER.length).fill(0),
    sampleMaxNs: new Array(WGPU_DRAW_PROFILE_PHASE_ORDER.length).fill(0),
    estimatedTotalNs: new Array(WGPU_DRAW_PROFILE_PHASE_ORDER.length).fill(0),
  },
  tailGate: {
    schema: WGPU_TAIL_GATE_SCHEMA,
    requested: false,
    available: false,
    version: 1,
    enabled: false,
    epoch: 0,
    period: 0,
    payloadSamples: 0,
    flushNeededSamples: 0,
    refreshNeededSamples: 0,
    bothCleanSamples: 0,
    dirtyAtSkip: 0,
  },
  producerUboCacheEnabled: false,
  producerUniformFastEnabled: false,
  producerUboPackEnabled: false,
  producerUboCacheMetricsEnabled: false,
  producerUboCacheClassOrder: ["vs", "ps", "gs"],
  producerUboCacheLookups: [0, 0, 0],
  producerUboCacheHits: [0, 0, 0],
  producerUboCacheExpired: [0, 0, 0],
  producerUboUploadCallsSuppressed: [0, 0, 0],
  producerUboUploadBytesSuppressed: [0, 0, 0],
  producerUboChangeMaskHistogram: [0, 0, 0, 0, 0, 0, 0, 0],
  producerUboPacketEligibleCount: 0,
  producerUboPacketTheoreticalCallsRemoved: 0,
  producerUboPacketPayloadBytes: 0,
  producerUboPacketAlignedBytes: 0,
  producerUboPrepareCpuCalls: [0, 0, 0],
  producerUboPrepareCpuNs: [0, 0, 0],
  producerUboChangeClassOrder: ["vs", "ps", "gs"],
  producerUboChangeSchemaVersion: 0,
  producerUboChangeAvailable: false,
  producerUboChangeEnabled: false,
  producerUboChangeEpoch: 0,
  producerUboChangeUploadCalls: [0, 0, 0],
  producerUboChangeFullBytes: [0, 0, 0],
  producerUboChangedBytes: [0, 0, 0],
  producerUboChangeBaselineFullCount: [0, 0, 0],
  producerUboChangeBaselineFullBytes: [0, 0, 0],
  producerUboDirty16Bytes: [0, 0, 0],
  producerUboDirty16Ranges: [0, 0, 0],
  producerUboDirty256Bytes: [0, 0, 0],
  producerUboDirty256Ranges: [0, 0, 0],
  producerUniformFastClassOrder: ["vs", "ps", "gs"],
  producerUniformFastSkippedComparisons: [0, 0, 0],
  producerUniformFastKeptComparisons: [0, 0, 0],
  producerUniformFastChangedComparisons: [0, 0, 0],
  producerGeometryPackEnabled: false,
  producerGeometryPackEpoch: 0,
  producerUploadArenaRequestedBytes: 0,
  producerUploadArenaConfiguredBytes: 0,
  producerUploadArenaFallbackCount: 0,
  producerUploadArenaLateRejectCount: 0,
  producerUploadArenaWrapCount: 0,
  producerUploadArenaInflightHighWaterBytes: 0,
  uploadArenaRingHandoffBytes: 0,
  uploadArenaRingHandoffExpectedBytes: 0,
  uploadArenaRingHandoffMismatch: false,
  uploadArenaRingHandoffMismatchCount: 0,
  commandDroppedCount: 0,
  batchAbortCount: 0,
  batchOversizeCount: 0,
  uploadTimeoutCount: 0,
  uploadTimeoutBoundaryVerified: false,
  uploadTimeoutCountAtVerifiedLoad: 0,
  uploadTimeoutCountBeforeVerifiedLoad: 0,
  uploadTimeoutCountAfterVerifiedLoad: 0,
  queueSubmissionCount: 0,
  uploadTransport: "queue",
  mappedStagingFastPath: false,
  mappedDrainCoalescingEnabled: false,
  mappedStagingCopyCount: 0,
  mappedStagingCopyBytes: 0,
  mappedStagingCopyTotalMs: 0,
  mappedStagingCopyMaxMs: 0,
  mappedStagingCapacityWaitCount: 0,
  mappedStagingCapacityWaitTotalMs: 0,
  mappedStagingCapacityWaitMaxMs: 0,
  mappedStagingRemapFailureCount: 0,
  mappedStagingUnsafeCapacityCount: 0,
  heldUploadScannedRecords: 0,
  heldUploadScanTotalMs: 0,
  heldUploadScanMaxMs: 0,
  detachedBitmapSentCount: 0,
  detachedBitmapCoalescedCount: 0,
  detachedBitmapErrorCount: 0,
  deferredBeginPassCount: 0,
  errorCount: 0
};

function scheduleDetachedWgpuBitmap(queue) {
  if (!wgpuDetachedPresenter || !detachedWgpuCanvas ||
      typeof detachedWgpuCanvas.transferToImageBitmap !== "function") {
    return;
  }
  if (wgpuDetachedBitmapPending) {
    webGpuCausalStats.detachedBitmapCoalescedCount += 1;
    return;
  }
  wgpuDetachedBitmapPending = true;
  queue.onSubmittedWorkDone().then(() => {
    if (!wgpuDetachedPresenter || !detachedWgpuCanvas) return;
    const bitmap = detachedWgpuCanvas.transferToImageBitmap();
    self.postMessage({
      type: "detachedWgpuFrame",
      bitmap,
      width: detachedWgpuCanvas.width,
      height: detachedWgpuCanvas.height
    }, [bitmap]);
    webGpuCausalStats.detachedBitmapSentCount += 1;
    if (webGpuCausalStats.detachedBitmapSentCount === 1) {
      postStatus(
        `wgpu-detached: first completed bitmap sent to main ` +
        `(${detachedWgpuCanvas.width}x${detachedWgpuCanvas.height})`
      );
    }
  }).catch((error) => {
    webGpuCausalStats.detachedBitmapErrorCount += 1;
    recordRendererError("detached-wgpu-frame", error?.message || error);
  }).finally(() => {
    wgpuDetachedBitmapPending = false;
  });
}

function updateWgpuBacklogState(backlog, sampledAt) {
  const value = Math.max(0, Number(backlog) || 0);
  if (wgpuBacklogLastSampleAt > 0) {
    webGpuCausalStats.backlogIntegralRecordMs +=
      wgpuBacklogLastValue * Math.max(0, sampledAt - wgpuBacklogLastSampleAt);
  }
  wgpuBacklogLastSampleAt = sampledAt;
  wgpuBacklogLastValue = value;
  if (value > 0) {
    wgpuBacklogNonzeroSince ||= sampledAt;
    const age = Math.max(0, sampledAt - wgpuBacklogNonzeroSince);
    webGpuCausalStats.backlogNonzeroAgeLastMs = age;
    webGpuCausalStats.backlogNonzeroAgeMaxMs = Math.max(
      webGpuCausalStats.backlogNonzeroAgeMaxMs,
      age
    );
  } else {
    wgpuBacklogNonzeroSince = 0;
    webGpuCausalStats.backlogNonzeroAgeLastMs = 0;
  }
}

function recordWgpuBacklogSample(backlog, sampledAt) {
  const value = Math.max(0, Number(backlog) || 0);
  updateWgpuBacklogState(value, sampledAt);
  wgpuBacklogSamples[wgpuBacklogSampleCursor] = value;
  wgpuBacklogSampleCursor = (wgpuBacklogSampleCursor + 1) % WGPU_BACKLOG_SAMPLE_CAPACITY;
  wgpuBacklogSampleCount = Math.min(
    WGPU_BACKLOG_SAMPLE_CAPACITY,
    wgpuBacklogSampleCount + 1
  );
  webGpuCausalStats.backlogSampleCount += 1;
  webGpuCausalStats.backlogSampleAverage +=
    (value - webGpuCausalStats.backlogSampleAverage) /
      webGpuCausalStats.backlogSampleCount;
}

function wgpuBacklogSampleP95() {
  if (wgpuBacklogSampleCount === 0) return 0;
  const samples = Array.from(wgpuBacklogSamples.subarray(0, wgpuBacklogSampleCount));
  samples.sort((left, right) => left - right);
  return samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
}

function recordBoundedHistogram(values, bounds, value) {
  let bucket = 0;
  while (bucket < bounds.length && value > bounds[bucket]) bucket += 1;
  values[bucket] += 1;
}

function drainWebGpuCmdRing(source = "presentation") {
  if (wgpuReplayFatal) return;
  const ring = webGpuCmdRing;
  if (!ring || !renderGpu) return;
  if (wgpuSemanticRuntimeActive) drainWgpuSemanticOwnership();
  if (wgpuUploadTransport === "mapped" && wgpuMappedCapacityBlocked &&
      wgpuMappedRemapPromises.size > 0) {
    return;
  }
  const normalizedSource = source === "pump" ? "pump" : "presentation";
  const collectReplayMetrics = causalMetricsEnabled || wgpuReplayBudgetMs > 0;
  if (collectReplayMetrics) {
    webGpuCausalStats.replayBudgetSourceCounts[normalizedSource] += 1;
  }
  const budgetGate = wgpuReplayBudgetMs > 0
    ? createWgpuReplayBudgetGate({
        budgetMs: wgpuReplayBudgetMs,
        checkIntervalRecords: WGPU_REPLAY_BUDGET_CHECK_RECORDS,
      })
    : null;
  const budgetStartedAt = budgetGate?.beginDrain() ?? 0;
  const drainStartedAt = budgetStartedAt || (causalMetricsEnabled ? performance.now() : 0);
  const budgetDeadlineMs = wgpuReplayBudgetMs > 0
    ? budgetStartedAt + wgpuReplayBudgetMs
    : Number.POSITIVE_INFINITY;
  const write = Atomics.load(ring.headerI32, 0) >>> 0;
  let read = currentWgpuReadIndex(ring);
  const initialRead = read;
  const initialPresentCount = webGpuExecStats.present;
  const backlog = (write - read) >>> 0;
  if (collectReplayMetrics) {
    recordWgpuBacklogSample(backlog, drainStartedAt || performance.now());
  }
  webGpuCausalStats.uploadReadLast = currentWgpuUploadReadIndex(ring);
  webGpuCausalStats.drainCount += 1;
  webGpuCausalStats.backlogLast = backlog;
  webGpuCausalStats.backlogHighWater = Math.max(webGpuCausalStats.backlogHighWater, backlog);
  if (wgpuLoadFenceActive && write !== read) {
    if (wgpuConsumerStateCacheEnabled) wgpuPassStateCache.reset("load-fence-discard");
    const fenceU32 = new Uint32Array(moduleInstance.HEAPU8.buffer);
    let discardTo = read;
    let completedAtRecordIndex = null;
    while (discardTo !== write) {
      const word = (ring.slotsBase + (discardTo % ring.capacity) * 32) >>> 2;
      const op = fenceU32[word];
      const staged = ring.stagedUploads?.get(discardTo);
      if (staged) {
        ring.stagedUploads.delete(discardTo);
        ring.stagedUploadBytes = Math.max(0, ring.stagedUploadBytes - staged.data.byteLength);
      } else if (op === WGPU_CMD_OP_UPLOAD_BUFFER) {
        releaseWgpuUploadPayload(ring, fenceU32[word + 3], fenceU32[word + 4]);
      } else if (op === WGPU_CMD_OP_UPLOAD_TEXTURE) {
        releaseWgpuUploadPayload(
          ring,
          fenceU32[word + 2],
          Math.imul(fenceU32[word + 3], fenceU32[word + 5]) >>> 0
        );
      }
      discardTo = (discardTo + 1) >>> 0;
      if (op === WGPU_CMD_OP_END_PASS) {
        completedAtRecordIndex = (discardTo - 1) >>> 0;
        wgpuLoadFenceActive = false;
        ring.heldReplayStart = null;
        ring.stagedPassStart = null;
        ring.stagedScanCursor = null;
        break;
      }
    }
    const discardedRecords = (discardTo - read) >>> 0;
    if (discardedRecords > 0) {
      if (wgpuSemanticRuntimeActive) {
        wgpuSemanticRuntime.invalidate(
          `load fence permanently discarded ${discardedRecords} published records`
        );
      }
      if (causalMetricsEnabled) {
        wgpuUploadAttribution.recordIncompletePass();
        if (wgpuDirtyRangeProjectionActive) {
          wgpuDirtyRangeProjection.recordSegmentBoundary({
            kind: "load-fence",
            complete: false
          });
        }
      }
      if (wgpuPassPackageProjectionActive) {
        wgpuPassPackageProjection.reset("load-fence-discard");
      }
      if (wgpuUploadRunProjectionActive) {
        wgpuUploadRunProjection.reset("load-fence-discard");
      }
      if (wgpuUboComputeProjectionActive) {
        wgpuUboComputeProjection.reset("load-fence-discard");
      }
      wgpuUboComputeReconstruction?.reset("load-fence-discard");
      publishWgpuReadIndex(ring, discardTo);
      wgpuReplayClassifier?.recordLoadFence({
        discardedRecords,
        completedAtRecordIndex
      });
      read = discardTo;
    }
  }
  // §27 post-load watchdog: log BEFORE the empty-ring early return so
  // we see whether `write` keeps advancing (producer alive) after
  // State::Load, or freezes (producer/video-pthread stalled).
  if (self._postLoadProbeUntil && Date.now() < self._postLoadProbeUntil) {
    const nowMs = Date.now();
    // NOTE: do NOT `| 0` a Date.now() timestamp — it truncates to a
    // garbage 32-bit value and the throttle never fires (spam). Plain
    // Number compare, ~1 s cadence.
    if (nowMs - (self._postLoadProbeLast || 0) >= 1000) {
      self._postLoadProbeLast = nowMs;
      const s = webGpuExecStats;
      console.log(`[postload-probe] dt=` +
        `${((nowMs - self._postLoadProbeT0) / 1000).toFixed(1)}s ` +
        `ring write=${write} read=${read} pend=${(write - read) >>> 0} ` +
        `present=${s.present} draw=${s.draw} drawIdx=${s.drawIdx} ` +
        `beginFb0=${s.beginFb0} beginFbN=${s.beginFbN} ` +
        `setPipe=${s.setPipe} missPipe=${s.missPipe} ` +
        `setBg=${s.setBg} missBg=${s.missBg} ` +
        `efbId=${self._wgEfbColorId} tex=${webGpuObjects.textures.size} ` +
        `pipes=${webGpuObjects.pipelines.size} ` +
        `bg=${webGpuObjects.bindGroups.size}`);
    }
  }
  if (write === read) {
    if (wgpuUploadRunProjectionActive) wgpuUploadRunProjection.boundary("drain");
    webGpuCausalStats.replayBudgetStopReasons.empty += 1;
    webGpuCausalStats.backlogAfterLast = 0;
    webGpuCausalStats.emptyDrainCount += 1;
    const processed = (read - initialRead) >>> 0;
    wgpuReplayClassifier?.recordDrainEpoch({
      readIndex: initialRead,
      writeIndex: write,
      replayLimit: read,
      processed,
      presentCount: 0
    });
    if (collectReplayMetrics) updateWgpuBacklogState(0, performance.now());
    finishWebGpuDrain(drainStartedAt, processed);
    return;
  }

  // NOTE (Day-27 audit): the Atomics.load(write) above is seq-cst.
  // The slot reads below are plain (non-atomic) Uint32/Float32 reads.
  // Per the abstract ECMAScript SAB memory model that's technically
  // unordered, but on a wasm-backed SharedArrayBuffer wasm seq-cst
  // atomics emit full memory fences, so every slot byte written
  // before the producer's release-store on `write` is visible here.
  // This is a deliberate, documented reliance on wasm SAB semantics
  // (not a portable-JS guarantee) — kept for zero-copy speed.
  const heap = moduleInstance.HEAPU8;
  const f32 = new Float32Array(heap.buffer);
  const u32 = new Uint32Array(heap.buffer);
  const epochSummary = wgpuReplayClassifier?.needsBacklogSummary(backlog)
    ? summarizeCurrentWgpuRing({
        readIndex: read,
        writeIndex: write,
        maxRecords: ring.capacity
      }).summary
    : null;
  let replayLimit = wgpuReplayBudgetMs > 0
    ? write
    : wgpuAtomicPassReplay
      ? selectAtomicReplayLimit({
          read,
          write,
          maxRecords: WGPU_REPLAY_WINDOW_RECORDS,
          opAt: (index) => u32[
            (ring.slotsBase + (index % ring.capacity) * 32) >>> 2
          ]
        })
      : (read + Math.min(backlog, WGPU_REPLAY_WINDOW_RECORDS)) >>> 0;
  if (wgpuReplayBudgetMs === 0 && replayLimit !== write) {
    ring.heldReplayStart ??= replayLimit;
    wgpuReplayClassifier?.recordAtomicHold({ recordIndex: replayLimit, writeIndex: write });
  }
  const dev = renderGpu.device;
  const q = dev.queue;
  let enc = null;
  let pass = null;
  let passW = 0;
  let passH = 0;
  let passColorFmt = null;
  let passDepthFmt = null;
  let passDepthId = 0;
  let passLoadOp = "load";
  let passHasPipe = false;
  let passSamplingKey = "0/0";
  let passNeedsVertexBuffer = false;
  let vertexBufferValid = false;
  let indexBufferValid = false;
  // The viewport and scissor last applied to the open pass. ClearRect resets
  // both for its clear triangle and must put the game's back afterwards.
  let lastAppliedViewport = null;
  let lastAppliedScissor = null;
  // DIAG_DEPTH_TRACE: the rest of the last-applied pass state, so a split pass
  // can be re-opened with the same state the game had set.
  let dtLastPipe = null;
  const dtLastBg = [null, null, null];
  let dtLastVb = null, dtLastIb = null, dtPassDesc = null;
  let currentBackbufferSourceTextureId = 0;
  let lastBackbufferSourceTextureId = wgpuLastBackbufferSourceTextureId;
  let lastBackbufferTexture = null;
  // §28j: per-pass bind-group validity. The fixed pipeline layout
  // declares 3 groups (l0/l1/l2); WebGPU requires ALL declared groups
  // to hold a valid bind group at draw time. If replayCreateBindGroup
  // skipped one (a referenced texture wasn't ready) the SET_BIND_GROUP
  // misses and the slot is unbound/stale → the draw is invalid → the
  // whole frame's queue.submit() throws → the ENTIRE frame presents
  // BLACK (the user-visible "mostly black, occasional flash"). Track
  // which slots currently hold a valid bind group and SKIP draws that
  // aren't fully bound, so one bad draw no longer poisons the frame.
  const bgValid = [false, false, false];
  const drawState = wgpuReplayClassifier ? {
    bindGroups: [0, 0, 0],
    dynamicOffsetCounts: [0, 0, 0],
    vertexBuffer: null,
    indexBuffer: null,
    viewport: null,
    scissor: null
  } : null;
  const captureFirstEfbDrawState = (indexed, args) => {
    if (!wgpuReplayClassifier?.needsFirstEfbDrawState(indexed) ||
        passFbId !== self._wgEfbColorId) {
      return null;
    }
    const tpl = webGpuObjects.pipeTpl.get(self._wgCurPipe);
    return {
      pass: {
        framebufferId: passFbId,
        width: passW,
        height: passH,
        colorFormat: passColorFmt,
        depthFormat: passDepthFmt,
        depthTextureId: passDepthId,
        loadOp: passLoadOp
      },
      pipeline: {
        id: self._wgCurPipe >>> 0,
        resolved: passHasPipe,
        summary: tpl?.s28dbg ?? null,
        primitive: tpl?.desc?.primitive ?? null,
        colorTarget: tpl?.target ?? null,
        depthStencil: tpl?.desc?.depthStencil ?? null
      },
      bindGroups: drawState.bindGroups.slice(),
      dynamicOffsetCounts: drawState.dynamicOffsetCounts.slice(),
      vertexBuffer: drawState.vertexBuffer ? { ...drawState.vertexBuffer } : null,
      indexBuffer: drawState.indexBuffer ? { ...drawState.indexBuffer } : null,
      viewport: drawState.viewport ? drawState.viewport.slice() : null,
      scissor: drawState.scissor ? drawState.scissor.slice() : null,
      draw: { indexed: Boolean(indexed), ...args }
    };
  };
  let errScope = false;
  let mappedCapacityHold = false;
  // One-shot present-path diagnostic: per-pass tally of pipeline/bind/
  // draw activity for the backbuffer (fb=0) and XFB-format (fb=47)
  // passes — tells us whether the present/XFB-copy draw actually runs.
  let passFbId = -1;
  let pd = { pipeOk: 0, pipeMiss: 0, bgOk: 0, bgMiss: 0, draw: 0, drawIdx: 0 };
  self._wgPassDiag = self._wgPassDiag || {};
  const flushPassDiag = () => {
    if (passFbId < 0) return;
    const key = passFbId === 0 ? "fb0" : "fb" + passFbId;
    const n = (self._wgPassDiag[key] = (self._wgPassDiag[key] || 0) + 1);
    // [webgpu-DIAG-cpypass] EFB-copy target passes (the 640x480
    // rgba8unorm depth-less RTs found opaque-black, §15a): does the
    // copy draw actually run, and with a pipeline+bind group?
    const isCopyTgt = self._wgCopyTargets &&
      self._wgCopyTargets.has(passFbId);
    // §28y: also fire on a wall-clock cadence (every 5 s, capped 30×)
    // so the copy pass is observable DEEP in the A-only black-3D
    // dwell (n≫6 there) — does the EFB→640×480 copy draw actually
    // run, with what srcTex/pipe/bg, when the copies read all-white?
    let _cpWcOk = false;
    if (isCopyTgt) {
      const _cn = Date.now();
      self._wgCpPassT0 = self._wgCpPassT0 || _cn;
      const _ct = Math.floor((_cn - self._wgCpPassT0) / 5000);
      self._wgCpPassWc = (self._wgCpPassWc == null) ? -1 : self._wgCpPassWc;
      if (_ct !== self._wgCpPassWc && _ct < 30) {
        self._wgCpPassWc = _ct;
        _cpWcOk = true;
      }
    }
    if (isCopyTgt && (n <= 6 || _cpWcOk)) {
      const _ct = webGpuObjects.pipeTpl.get(self._wgCurPipe);
      console.log(`[webgpu-DIAG-cpypass] pass#${n} fb=${passFbId} ` +
        `pipeOk=${pd.pipeOk} pipeMiss=${pd.pipeMiss} bgOk=${pd.bgOk} ` +
        `bgMiss=${pd.bgMiss} draw=${pd.draw} drawIdx=${pd.drawIdx} ` +
        `srcTex=${self._wgCpySrc != null ? "tex#" + self._wgCpySrc : "?"} ` +
        `pipe=${self._wgCurPipe} ${_ct ? _ct.s28dbg : "?"} ` +
        `${passColorFmt}/${passDepthFmt} ${passW}x${passH}`);
      // §28z: one-shot dump the 640×480 EFB-copy's FS WGSL — the
      // shader that outputs white instead of mirroring tex#14. Keyed
      // off the copy pipeline (not the broken 4096 heuristic).
      if (passW === 640 && passH === 480 && _ct && !self._wgCpFsDone &&
          self._wgFsSrc && self._wgFsSrc[_ct.fsId] !== undefined) {
        self._wgCpFsDone = true;
        const w = self._wgFsSrc[_ct.fsId].replace(/\s+/g, " ");
        console.log(`[s28z-cpfs] fb=${passFbId} pipe=${self._wgCurPipe} ` +
          `fs#${_ct.fsId} vs#${_ct.vsId} len=${w.length} ` +
          `nSample=${(w.match(/textureSample/g) || []).length}`);
        for (let o = 0; o < w.length && o < 4200; o += 700)
          console.log(`[s28z-cpfs ${o}] ${w.slice(o, o + 700)}`);
      }
    }
    if ((passFbId === 0 || passFbId === 47) && n <= 3) {
      console.log(`[webgpu-exec] pass#${n} fb=${passFbId} ` +
        `pipeOk=${pd.pipeOk} pipeMiss=${pd.pipeMiss} bgOk=${pd.bgOk} ` +
        `bgMiss=${pd.bgMiss} draw=${pd.draw} drawIdx=${pd.drawIdx} ` +
        `${passColorFmt}/${passDepthFmt} ${passW}x${passH}`);
    }
    // [webgpu-DIAG-efbpass] The EFB colour pass (depth-attached
    // tex#14) sampled across the run. Decides menu-black: real draws
    // but black EFB ⇒ state/shader; ~0 draws ⇒ menu uses another path.
    if (self._wgEfbColorId && passFbId === self._wgEfbColorId &&
        (n % 240) === 1) {
      console.log(`[webgpu-DIAG-efbpass] p=${webGpuExecStats.present} ` +
        `n=${n} fb=${passFbId} pipeOk=${pd.pipeOk} pipeMiss=${pd.pipeMiss} ` +
        `bgOk=${pd.bgOk} bgMiss=${pd.bgMiss} draw=${pd.draw} ` +
        `drawIdx=${pd.drawIdx} ${passColorFmt}/${passDepthFmt} ` +
        `${passW}x${passH}`);
    }
    // §28k: where do intro-cutscene / title / main-menu draws go?
    // Those screens render BLACK with zero draws into tex#14 (the EFB
    // pass). Tally per-fbId draw totals over the run and dump the full
    // map periodically so we can see whether they target a different
    // FB / copy target instead of the depth-attached EFB.
    if (pd.draw + pd.drawIdx > 0) {
      self._wgFbDraws = self._wgFbDraws || {};
      const fk = passFbId === 0 ? "fb0" : "fb" + passFbId;
      const e = self._wgFbDraws[fk] || { d: 0, passes: 0, efb: 0 };
      e.d += pd.draw + pd.drawIdx; e.passes += 1;
      if (passFbId === self._wgEfbColorId) e.efb = 1;
      self._wgFbDraws[fk] = e;
    }
    self._wgFbDumpN = (self._wgFbDumpN || 0) + 1;
    if ((self._wgFbDumpN % 600) === 0) {
      const rows = Object.entries(self._wgFbDraws || {})
        .map(([k, v]) => `${k}${v.efb ? "*EFB" : ""}=${v.d}/${v.passes}p`)
        .join(" ");
      console.log(`[s28k-fbdraws] p=${webGpuExecStats.present} ` +
        `efbId=${self._wgEfbColorId} ${rows}`);
    }
    passFbId = -1;
    pd = { pipeOk: 0, pipeMiss: 0, bgOk: 0, bgMiss: 0, draw: 0, drawIdx: 0 };
  };
  const ensureEnc = () => {
    if (!enc) {
      dev.pushErrorScope("validation");
      errScope = true;
      enc = dev.createCommandEncoder({ label: "dolphin-frame" });
    }
    return enc;
  };
  const acceptMappedBatch = (batch) => {
    if (!batch) return;
    if (batch.ordinary) {
      wgpuMappedDrainCoalescer.recordSubmission(
        Math.max(0, globalThis.performance.now() - batch.ordinary.oldestPendingAtMs)
      );
      trackWgpuMappedRemap(wgpuMappedStagingPool.acceptSubmission(batch.ordinary));
    }
    if (batch.compute) {
      trackWgpuMappedRemap(wgpuUboComputeReconstruction.accept(batch.compute));
    }
  };
  const rejectMappedBatch = (batch, error) => {
    if (!batch) return;
    if (batch.ordinary) {
      try {
        wgpuMappedStagingPool.rejectSubmission(batch.ordinary, error);
      } catch {
        wgpuMappedStagingPool.invalidate(error);
      }
    }
    if (batch.compute) {
      try {
        trackWgpuMappedRemap(
          wgpuUboComputeReconstruction.reject(batch.compute, "submit-error")
        );
      } catch {
        wgpuUboComputeReconstruction = null;
      }
    }
  };
  const sealMappedBatch = (reason = "drain-boundary", decisionPrepared = false) => {
    if (wgpuUploadTransport !== "mapped") return null;
    prepareWgpuMappedDrainSubmission(reason, decisionPrepared);
    let ordinary = null;
    let compute = null;
    try {
      ordinary = ensureWgpuMappedStagingPool(dev).seal();
      compute = wgpuUboComputeReconstructionActive &&
          wgpuUboComputeReconstruction
        ? wgpuUboComputeReconstruction.seal(
            `Dolphin ordered UBO reconstruction: ${reason}`
          )
        : null;
      if (compute && !compute.ok) {
        throw new Error(`UBO compute seal failed: ${compute.reason}`);
      }
      if ((ordinary || compute) && wgpuUboComputeProjectionActive) {
        wgpuUboComputeProjection.boundary(reason);
      }
      return ordinary || compute ? { ordinary, compute } : null;
    } catch (error) {
      if (ordinary) {
        try {
          wgpuMappedStagingPool.rejectSubmission(ordinary, error);
        } catch {
          wgpuMappedStagingPool.invalidate(error);
        }
      }
      markWgpuReplayFatal("staging-seal", error?.message || error);
      return null;
    }
  };
  const flushMappedUploadsOnly = (
    reason = "staging-capacity",
    decisionPrepared = false
  ) => {
    prepareWgpuMappedDrainSubmission(reason, decisionPrepared);
    return submitPendingWgpuMappedUploads(reason);
  };
  let lastSubmitFailureReason = null;
  const submitEnc = (reason = "drain-boundary", decisionPrepared = false) => {
    lastSubmitFailureReason = null;
    if (!enc) {
      // Upload-only drains still have to seal and submit their mapped batch,
      // but callers use the return value to decide whether a render/present
      // command buffer was submitted.
      flushMappedUploadsOnly(reason, decisionPrepared);
      lastSubmitFailureReason = wgpuReplayFatal ? "replay-fatal" : "no-command-encoder";
      return false;
    }
    const mappedBatch = sealMappedBatch(reason, decisionPrepared);
    if (wgpuReplayFatal) {
      lastSubmitFailureReason = wgpuReplayFatal.scope === "submit-error"
        ? "submit-error"
        : "replay-fatal";
      return false;
    }
    let submitted = false;
    try {
      const renderCommandBuffer = enc.finish();
      q.submit([
        ...(mappedBatch?.ordinary ? [mappedBatch.ordinary.commandBuffer] : []),
        ...(mappedBatch?.compute ? [mappedBatch.compute.commandBuffer] : []),
        renderCommandBuffer,
      ]);
      gpuCompletionTracker.recordSubmittedWork(q, "hardware-replay");
      acceptMappedBatch(mappedBatch);
      submitted = true;
      dtraceDrainPending();
    } catch (e) {
      lastSubmitFailureReason = "submit-error";
      rejectMappedBatch(mappedBatch, e);
      recordRendererError("submit-error", e?.message || e);
      markWgpuReplayFatal("submit-error", e?.message || e);
      wgpuReplayClassifier?.recordSubmission({ reason, submitted: false, error: e });
    }
    if (submitted) {
      if (causalMetricsEnabled) webGpuCausalStats.queueSubmissionCount += 1;
      wgpuReplayClassifier?.recordSubmission({ reason, submitted: true });
      if (reason === "present" && wgpuReplayClassifier &&
          !wgpuPresentCompletionProbeStarted) {
        wgpuPresentCompletionProbeStarted = true;
        const classifierGeneration = wgpuReplayClassifierGeneration;
        q.onSubmittedWorkDone().then(() => {
          if (classifierGeneration === wgpuReplayClassifierGeneration) {
            wgpuReplayClassifier?.recordPresentCompletion({ completed: true });
          }
        }).catch((error) => {
          if (classifierGeneration === wgpuReplayClassifierGeneration) {
            wgpuReplayClassifier?.recordPresentCompletion({ completed: false, error });
          }
        });
      }
    }
    enc = null;
    if (errScope) {
      errScope = false;
      dev.popErrorScope().then((er) => {
        if (er) recordRendererError("validation", er.message);
        if (er && !self._wgValErr) {
          self._wgValErr = true;
          console.log(`[webgpu-exec] VALIDATION: ${String(er.message).slice(0, 320)}`);
        }
      }).catch((error) => recordRendererError("error-scope-failure", error?.message || error));
    }
    return submitted;
  };
  const endPass = (reason = "implicit", recordIndex = read) => {
    if (pass) {
      const endedFramebufferId = passFbId;
      if (passFbId === 0) {
        lastBackbufferSourceTextureId = currentBackbufferSourceTextureId;
        wgpuLastBackbufferSourceTextureId = currentBackbufferSourceTextureId;
      }
      try { pass.end(); } catch (e) {}
      if (DIAG_DEPTH_TRACE && self._wgDt && self._wgDt.armed &&
          endedFramebufferId === self._wgEfbColorId && passDepthId) {
        const dt = self._wgDt;
        diagReadDepthTrace(dev, ensureEnc(), webGpuObjects.textures.get(passDepthId),
          `end of pass#${dt.passSeq} (${reason}) | efbDraws=${dt.draws} depthWrites=${dt.writes} clearRects=${dt.clears}`);
        diagReadColorTrace(dev, ensureEnc(), webGpuObjects.textures.get(endedFramebufferId),
          `end of pass#${dt.passSeq} | efbDraws=${dt.draws}`);
      }
      // Read the copy destination AND the EFB immediately after the copy pass
      // ends, so both reads sit adjacent in the command stream. Reading at
      // present time instead was confounded by encoder batching: several
      // frames can share one encoder, so the EFB read executed after a later
      // frame's clear and came back all zeros.
      if (DIAG_EFB_TO_CANVAS && endedFramebufferId !== 0 &&
          endedFramebufferId !== (self._wgEfbColorId || -1)) {
        const dst = webGpuObjects.textures.get(endedFramebufferId);
        if (dst && dst.tex && dst.tex.width === 608 && dst.tex.height === 456) {
          self._wgGridN = (self._wgGridN || 0) + 1;
          if ((self._wgGridN % 300) === 0) {
            try {
              const enc = ensureEnc();
              diagReadTexture(dev, enc, dst, `COPYDST(tex#${endedFramebufferId})`,
                              `n=${self._wgGridN}`);
              diagReadTexture(dev, enc,
                              webGpuObjects.textures.get(self._wgEfbColorId || 0),
                              `EFB(tex#${self._wgEfbColorId || 0})`, `n=${self._wgGridN}`);
            } catch (e) {}
          }
        }
      }
      wgpuReplayClassifier?.recordPassEnd({ reason, recordIndex });
      if (causalMetricsEnabled) {
        if (reason === "explicit" || reason === "submit-present") {
          wgpuUploadAttribution.recordPassEnd();
        } else {
          wgpuUploadAttribution.recordIncompletePass();
        }
        if (wgpuDirtyRangeProjectionActive) {
          wgpuDirtyRangeProjection.recordSegmentBoundary({
            kind: reason,
            complete: reason === "explicit" || reason === "submit-present"
          });
        }
      }
      pass = null;
      if (wgpuConsumerStateCacheEnabled) wgpuPassStateCache.reset(reason);
      flushPassDiag();

      // Present-time EFB sampling can be invalidated by a later clear.  When
      // the classifier is enabled, submit exactly one readback immediately
      // after the first completed EFB pass that contained an indexed draw.
      // Non-indexed utility triangles can legitimately leave the sampled EFB
      // clear and must not consume the one-shot mutation proof.
      if (wgpuReplayClassifier?.beginFirstEfbPassReadback({
        framebufferId: endedFramebufferId,
        passEndRecordIndex: recordIndex,
        drawCountAtEncode: wgpuReplayClassifier.captureEfbDrawCount()
      })) {
        const classifierGeneration = wgpuReplayClassifierGeneration;
        const color = webGpuObjects.textures.get(endedFramebufferId);
        let readback = null;
        try {
          if (!color || color.format.startsWith("depth")) {
            throw new Error(`EFB texture ${endedFramebufferId} unavailable for readback`);
          }
          const width = color.tex.width;
          const height = color.tex.height;
          const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
          readback = dev.createBuffer({
            size: bytesPerRow * height,
            usage: 0x1 | 0x8 // MAP_READ | COPY_DST
          });
          ensureEnc().copyTextureToBuffer(
            { texture: color.tex },
            { buffer: readback, bytesPerRow, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 }
          );
          if (!submitEnc("first-efb-pass-readback")) {
            throw new Error("first EFB pass readback submission failed");
          }
          readback.mapAsync(0x1).then(() => {
            const bytes = new Uint8Array(readback.getMappedRange());
            let nonzeroBytes = 0;
            let nonzeroColorBytes = 0;
            let maxByte = 0;
            for (let y = 0; y < height; y += 1) {
              const row = y * bytesPerRow;
              for (let x = 0; x < width; x += 1) {
                const pixel = row + x * 4;
                for (let channel = 0; channel < 4; channel += 1) {
                  const value = bytes[pixel + channel];
                  if (!value) continue;
                  nonzeroBytes += 1;
                  if (channel < 3) nonzeroColorBytes += 1;
                  if (value > maxByte) maxByte = value;
                }
              }
            }
            if (classifierGeneration === wgpuReplayClassifierGeneration) {
              wgpuReplayClassifier?.recordFirstEfbPassReadback({
                nonzeroBytes,
                nonzeroColorBytes,
                sampledBytes: width * height * 4,
                maxByte
              });
            }
            readback.unmap();
            readback.destroy();
          }).catch((error) => {
            if (classifierGeneration === wgpuReplayClassifierGeneration) {
              wgpuReplayClassifier?.recordFirstEfbPassReadback({ error });
            }
            readback?.destroy();
          });
        } catch (error) {
          if (classifierGeneration === wgpuReplayClassifierGeneration) {
            wgpuReplayClassifier?.recordFirstEfbPassReadback({ error });
          }
          readback?.destroy();
        }
      }
      return true;
    }
    return false;
  };
  // DIAG_DEPTH_TRACE: end the open EFB pass, copy its depth buffer in the same
  // encoder, and re-open the pass with load ops and the last-applied state.
  const dtraceSplit = (tag) => {
    const dt = self._wgDt;
    if (!DIAG_DEPTH_TRACE || !dt || !dt.armed || !pass ||
        passFbId !== self._wgEfbColorId) return;
    if (!dtPassDesc || !dtPassDesc.depthStencilAttachment) {
      console.log(`[dtrace] split skipped, no depth attachment: ${tag}`);
      return;
    }
    const dtex = webGpuObjects.textures.get(passDepthId);
    try { pass.end(); } catch (e) { console.log(`[dtrace] end failed: ${e && e.message}`); }
    diagReadDepthTrace(dev, ensureEnc(), dtex,
      `${tag} | efbDraws=${dt.draws} depthWrites=${dt.writes} clearRects=${dt.clears} pass#${dt.passSeq}`);
    diagReadColorTrace(dev, ensureEnc(), webGpuObjects.textures.get(passFbId),
      `${tag} | efbDraws=${dt.draws}`);
    const d2 = {
      colorAttachments: dtPassDesc.colorAttachments.map((c) => ({ ...c, loadOp: "load" })),
      depthStencilAttachment: { ...dtPassDesc.depthStencilAttachment, depthLoadOp: "load" }
    };
    if (d2.depthStencilAttachment.stencilLoadOp) d2.depthStencilAttachment.stencilLoadOp = "load";
    try {
      pass = enc.beginRenderPass(d2);
      if (wgpuConsumerStateCacheEnabled) wgpuPassStateCache.reset("dtrace-split");
      if (lastAppliedViewport) pass.setViewport(...lastAppliedViewport);
      if (lastAppliedScissor) pass.setScissorRect(...lastAppliedScissor);
      if (dtLastPipe) pass.setPipeline(dtLastPipe);
      for (let sl = 0; sl < 3; sl++) {
        const g = dtLastBg[sl];
        if (!g) continue;
        if (g.off) pass.setBindGroup(sl, g.bg, g.off); else pass.setBindGroup(sl, g.bg);
      }
      if (dtLastVb) pass.setVertexBuffer(dtLastVb.slot, dtLastVb.b, dtLastVb.offset);
      if (dtLastIb) pass.setIndexBuffer(dtLastIb.b, dtLastIb.format, dtLastIb.offset);
      dt.splits++;
      if (DTRACE_CONTROL && !dt.controlDone) {
        dt.controlDone = true;
        const cp = ensureClearPipeline(dev, passColorFmt, passDepthFmt, false, true, 0, 0.5);
        if (cp) {
          pass.setScissorRect(0, 0, 64, 64);
          pass.setPipeline(cp);
          pass.draw(3, 1, 0, 0);
          if (lastAppliedScissor) pass.setScissorRect(...lastAppliedScissor); else pass.setScissorRect(0, 0, passW, passH);
          if (dtLastPipe) pass.setPipeline(dtLastPipe);
          console.log(`[dtrace] control: clear-pipeline depth write z=0.5 over (0,0 64x64) ` +
            `with viewport ${lastAppliedViewport ? lastAppliedViewport.map((v) => +v.toFixed(2)).join(",") : "unset"}`);
        } else {
          console.log("[dtrace] control: clear pipeline unavailable");
        }
      }
    } catch (e) {
      console.log(`[dtrace] re-open failed: ${e && e.message}`);
    }
  };
  const dtraceAfterDraw = () => {
    const dt = self._wgDt;
    if (!DIAG_DEPTH_TRACE || !dt || !dt.armed || passFbId !== self._wgEfbColorId) return;
    dt.draws++;
    const ds = dtLastPipe ? vpDiagPipeFinalDs.get(dtLastPipe) : null;
    const k = ds ? `${ds.cmp}/${ds.write ? "write" : "nowrite"}` : "nodepth";
    dt.cmpTally.set(k, (dt.cmpTally.get(k) || 0) + 1);
    if (ds && ds.write && ds.cmp !== "never") dt.writes++;
    if (DTRACE_SPLITS.has(dt.draws)) {
      const z = vpDiagRaw ? vpDiagRaw.map((v) => v.toFixed(2)).join(",") : "?";
      dtraceSplit(`after draw ${dt.draws} (${k} ${vpDiagRect || "vp?"} z=${z} ${vpDiagScissor})`);
    }
  };

  const heapCopy = (off, len) => heap.slice(off, off + len);
  // Atomic replay normally stops before an incomplete BEGIN_PASS and leaves
  // it in the ring until END_PASS is visible. The guard below is retained for
  // the explicit legacy rollback mode (`?wgpuatomic=0`).
  // §28ao flicker fix: when BEGIN_PASS is reached but its back-to-back
  // SET_VIEWPORT isn't visible in the ring yet (consumer drained
  // between the producer's two separate atomic Push() stores), the
  // §28af peek misses → stale _wgPassRevZ → wrong baked depthClearValue
  // for the whole pass → intermittent flicker. Defer the BEGIN_PASS to
  // the next drain (don't advance `read`) so the SET_VIEWPORT is
  // present and revZ is correct. Bounded so a stalled producer can't
  // wedge the ring forever.
  let deferBeginPass = false;
  let protocolPassDepth = 0;
  let budgetStopReason = null;
  while (read !== replayLimit) {
    const processedBeforeRecord = (read - initialRead) >>> 0;
    if (wgpuReplayBudgetMs > 0 && protocolPassDepth === 0 &&
        processedBeforeRecord >= WGPU_REPLAY_WINDOW_RECORDS) {
      budgetStopReason = "record-window";
      break;
    }
    const recWord = (ring.slotsBase + (read % ring.capacity) * 32) >>> 2;
    const op = u32[recWord];
    if (budgetGate) {
      const beforeRecordBudget = budgetGate.check({
        processed: processedBeforeRecord,
        passDepth: protocolPassDepth,
        force: op === WGPU_CMD_OP_BEGIN_PASS && protocolPassDepth === 0,
      });
      if (beforeRecordBudget.shouldYield) {
        budgetStopReason = beforeRecordBudget.reason;
        break;
      }
    }
    const publishedPassEnd = wgpuReplayBudgetMs > 0 && op === WGPU_CMD_OP_BEGIN_PASS
      ? findPublishedAtomicPassEnd({
          begin: read,
          write: replayLimit,
          opAt: (index) => u32[
            (ring.slotsBase + (index % ring.capacity) * 32) >>> 2
          ],
          beginOp: WGPU_CMD_OP_BEGIN_PASS,
          endOp: WGPU_CMD_OP_END_PASS,
        })
      : null;
    if (op === WGPU_CMD_OP_BEGIN_PASS && wgpuReplayBudgetMs > 0 &&
        publishedPassEnd === null) {
      budgetStopReason = "deferred-begin";
      webGpuCausalStats.deferredBeginPassCount += 1;
      break;
    }
    if (op === WGPU_CMD_OP_BEGIN_PASS && wgpuReplayBudgetMs === 0 &&
        ((read + 1) >>> 0) === replayLimit) {
      self._wgBpDefer = (self._wgBpDefer || 0) + 1;
      if (self._wgBpDefer <= 8) {
        deferBeginPass = true;
        webGpuCausalStats.deferredBeginPassCount += 1;
        break;
      }
      // budget exhausted: fall through and process with last revZ.
    } else if (op === WGPU_CMD_OP_BEGIN_PASS) {
      self._wgBpDefer = 0;
    }
    const retainedSemanticPayload = ring.stagedUploads?.get(read)?.data ?? null;
    const exactRetainedSemanticPayload = retainedSemanticPayload &&
        op === WGPU_CMD_OP_UPLOAD_BUFFER
      ? retainedSemanticPayload.subarray(0, u32[recWord + 4])
      : retainedSemanticPayload;
    const preparedSemanticRecord = wgpuSemanticRuntimeActive &&
        wgpuSemanticRuntime.isOpen()
      ? wgpuSemanticRuntime.prepareLegacy(
          u32.subarray(recWord, recWord + 8),
          heap,
          exactRetainedSemanticPayload
            ? { payloadBytes: exactRetainedSemanticPayload }
            : undefined
        )
      : null;
    const replayOpStartedAt = causalMetricsEnabled
      ? wgpuReplayOpMetrics.beginReplay(op)
      : null;
    let replayRecordAccepted = true;
    try {
      switch (op) {
        case WGPU_CMD_OP_CREATE_SHADER:
          replayCreateShader(u32[recWord + 1], u32[recWord + 2],
                             u32[recWord + 3], u32[recWord + 4]);
          break;
        case WGPU_CMD_OP_CREATE_PIPELINE_CFG:
          replayCreatePipelineCfg(u32[recWord + 1], u32[recWord + 2],
                                  u32[recWord + 3]);
          break;
        case WGPU_CMD_OP_CREATE_PIPELINE:
          replayCreatePipeline(u32[recWord + 1], u32[recWord + 2],
                               u32[recWord + 3], u32[recWord + 4]);
          break;
        case WGPU_CMD_OP_CREATE_BUFFER: {
          const id = u32[recWord + 1];
          if (!webGpuObjects.buffers.has(id)) {
            const size = Math.max(16, (u32[recWord + 2] + 3) & ~3);
            const producerUsage = u32[recWord + 3];
            const resourceRole = u32[recWord + 4] || WGPU_BUFFER_RESOURCE_ROLE_UNKNOWN;
            let computeManager = null;
            let usage = producerUsage;
            if (wgpuUboComputeReconstructionActive &&
                resourceRole === WGPU_BUFFER_RESOURCE_ROLE_UBO_RING) {
              try {
                computeManager = ensureWgpuUboComputeReconstruction(dev);
                usage |= 0x0080; // GPUBufferUsage.STORAGE
              } catch (error) {
                wgpuUboComputeReconstructionActive = false;
                console.warn(
                  `[webgpu-ubo-compute] disabled before replay: ${error?.message || error}`
                );
              }
            }
            const createdBuffer = dev.createBuffer({ size, usage });
            webGpuObjects.buffers.set(id, createdBuffer);
            if (computeManager) {
              try {
                computeManager.registerResource({
                  resourceId: id,
                  role: WGPU_UBO_RING_ROLE,
                  buffer: createdBuffer,
                  size,
                  usage,
                });
              } catch (error) {
                wgpuUboComputeReconstructionActive = false;
                wgpuUboComputeReconstruction = null;
                console.warn(
                  `[webgpu-ubo-compute] resource registration fell back to legacy: ` +
                  `${error?.message || error}`
                );
              }
            }
            // The utility UBO is the unique 4096-byte uniform buffer
            // (kUtilUboSize). Track its id so we can dump what
            // UploadUtilityUniforms actually writes (src_offset/size
            // for the EFB-copy VS).
            if (u32[recWord + 2] === 4096) self._wgUtilBuf = id;
            // §28-vtxdata: the main vertex buffer is the unique 16 MB
            // buffer (kVertexBufferSize). Track its id so we can read
            // the uploaded per-vertex texcoord bytes for the dark-menu
            // probe (zero ⇒ GX position-texgen; non-zero ⇒ posttransform).
            if (u32[recWord + 2] === 16777216) self._wgVtxBufId = id;
          }
          break;
        }
        case WGPU_CMD_OP_UPLOAD_BUFFER: {
          const bufferId = u32[recWord + 1];
          const srcP = u32[recWord + 3];
          const uploadBytes = u32[recWord + 4];
          const uploadRole = u32[recWord + 5];
          const stagedUpload = ring.stagedUploads?.get(read) ?? null;
          if (stagedUpload && wgpuUploadTransport !== "mapped") {
            ring.stagedUploads.delete(read);
            ring.stagedUploadBytes = Math.max(
              0,
              ring.stagedUploadBytes - stagedUpload.data.byteLength
            );
          }
          const buf = webGpuObjects.buffers.get(bufferId);
          const len = (uploadBytes + 3) & ~3;
          const uploadSource = stagedUpload?.data ??
            (uploadBytes === len
              ? new Uint8Array(moduleInstance.HEAPU8.buffer, srcP, len)
              : copyWgpuUploadPayload(heap, srcP, uploadBytes, true));
          let mappedStageAccepted = false;
          try {
            if (!buf) {
              wgpuReplayClassifier?.recordMissingResource({ kind: "upload-buffer", id: bufferId });
            }
            if (buf) {
              // writeBuffer requires offset & size multiples of 4
              // (producer already aligns; round len defensively).
            // DIAG one-shot per buffer id: dump what we actually write.
            // The VS UBO is the big one; floats @byte32=posnormalmatrix,
            // @byte128=projection. Zeros here ⇒ upload path broken;
            // valid ⇒ the GPU UBO is fine and the bug is VS exec /
            // vertex fetch.
            if (!vpDiagDone) {
              vpDiagNoteUpload(uploadSource, len);
              vpDiagNotePsUpload(uploadSource, len);
            }
          if (uploadRole === 4 && !vpDiagDone) {
            vpDiagNoteIndexUpload(uploadSource, len, u32[recWord + 2]);
          }
          if (uploadRole === 3) {
            vpDiagNoteVertexUpload(uploadSource, len);
            if (!vpDiagDone) {
              // Keep enough of the batch to decode EVERY vertex, not just the
              // first. 864fb59 validated only the leading vertex, which says
              // nothing about the rest of a mesh -- and rectangular coverage is
              // what wrong positions across the remainder would look like.
              vpDiagLastVtxBytes = uploadSource.slice(0, Math.min(len, 262144));
              vpDiagLastVtxLen = len;
              vpDiagVtxFresh = true;
              const _l = vpDiagPipeVtx.get(self._wgCurPipe);
              vpDiagLastVtxCount = (_l && _l.stride) ? Math.floor(len / _l.stride) : 0;
            }
          }
            const bid = u32[recWord + 1];
            self._wgUbN = (self._wgUbN || 0) + 1;
            // First few + periodic so steady-state UBO uploads are
            // visible (one-shot only caught the pre-SetConstants zero).
            if (self._wgUbN <= 6 || (self._wgUbN % 4000) === 0) {
              const ff = new Float32Array(uploadSource.buffer,
                                          uploadSource.byteOffset,
                                          Math.min(len, 160) >>> 2);
              console.log(`[webgpu-DIAG-ub] id=${bid} dst=${u32[recWord+2]} ` +
                `len=${len} f0=${ff[0]?.toFixed(3)},${ff[1]?.toFixed(3)} ` +
                `pnm@32=${ff[8]?.toFixed(3)},${ff[9]?.toFixed(3)},${ff[10]?.toFixed(3)} ` +
                `proj@128=${ff[32]?.toFixed(3)},${ff[33]?.toFixed(3)},` +
                `${ff[34]?.toFixed(3)},${ff[35]?.toFixed(3)}`);
            }
            // §28b: PixelShaderConstants has fogcolor (int4 @byte432),
            // fogi (int4 @448), fogf (float4 @464). The backdrop FS
            // lerps to fogcolor by a fogf-driven factor → if fogcolor
            // is ~0 the untextured backdrop goes black. Dump fog for
            // PS-sized uploads (len ≥ 480) so we can see if fogcolor
            // is zero / fogf forces full fog at difficulty-select.
            // PixelShaderConstants is ~1536 bytes (VS ~4112, GS small);
            // the per-draw uniform ring writes the PS slice at that len.
            if (wgpuDeepReplayDiagnostics && len >= 1500 && len <= 1700) {
              self._wgFogN = (self._wgFogN || 0) + 1;
              if (self._wgFogN <= 6 || (self._wgFogN % 1500) === 0) {
                const ib = new Int32Array(uploadSource.buffer,
                                          uploadSource.byteOffset + 432, 8);   // fogcolor+fogi
                const fb = new Float32Array(uploadSource.buffer,
                                            uploadSource.byteOffset + 464, 4);  // fogf
                // §28e: TEV color registers — I_COLORS @0 (int4[4]),
                // I_KCOLORS @64 (int4[4]), I_ALPHA @128 (int4). If the
                // untextured backdrop TEV reads these and they're 0,
                // that's why it's black (vs a fog problem).
                const cb = new Int32Array(uploadSource.buffer,
                                          uploadSource.byteOffset, 36);  // colors+kcolors+alpha
                console.log(`[s28-fog] id=${bid} len=${len} ` +
                  `fogcolor=${ib[0]},${ib[1]},${ib[2]},${ib[3]} ` +
                  `fogi=${ib[4]},${ib[5]},${ib[6]},${ib[7]} ` +
                  `fogf=${fb[0]?.toFixed(4)},${fb[1]?.toFixed(4)},` +
                  `${fb[2]?.toFixed(4)},${fb[3]?.toFixed(4)}`);
                // §28f: I_TEXDIMS @144 (int4[8]); the textured-draw FS
                // normalises texcoords by f32(I_TEXDIMS[map].xy*128).
                // If these are 0 ⇒ div-by-0 ⇒ NaN uv ⇒ sample 0 ⇒
                // black despite a valid texture+konst.
                const td = new Int32Array(uploadSource.buffer,
                                          uploadSource.byteOffset + 144, 16);  // texdims[0..3]
                console.log(`[s28-creg] id=${bid} ` +
                  `c0=${cb[0]},${cb[1]},${cb[2]},${cb[3]} ` +
                  `c1=${cb[4]},${cb[5]},${cb[6]},${cb[7]} ` +
                  `c2=${cb[8]},${cb[9]},${cb[10]},${cb[11]} ` +
                  `c3=${cb[12]},${cb[13]},${cb[14]},${cb[15]} ` +
                  `k0=${cb[16]},${cb[17]},${cb[18]},${cb[19]} ` +
                  `alpha=${cb[32]},${cb[33]},${cb[34]},${cb[35]}`);
                console.log(`[s28-texdim] id=${bid} ` +
                  `td0=${td[0]},${td[1]},${td[2]},${td[3]} ` +
                  `td1=${td[4]},${td[5]},${td[6]},${td[7]} ` +
                  `td2=${td[8]},${td[9]},${td[10]},${td[11]} ` +
                  `td3=${td[12]},${td[13]},${td[14]},${td[15]}`);
              }
              // [s28av] snapshot the freshest PSBlock (every PS-sized
              // write, NOT throttled) so the DRAW_INDEXED probe can read
              // I_TEXDIMS (member_3 @byte144) for the effective-UV calc.
              if (!self._wgPsSnap || self._wgPsSnap.byteLength < len)
                self._wgPsSnap = new Uint8Array(len);
              self._wgPsSnap.set(uploadSource.subarray(0, len));
              self._wgPsSnapLen = len;
            }
            // [s28be] snapshot the VS UBO (VertexShaderConstants ~4112B;
            // PS is ~1536). The §28an baked probe read posttransform at
            // the WRONG offset (byte 1280 = transformmatrices) so it was
            // NEVER verified. Correct C++ offsets (ConstantManager.h):
            // texmatrices@896, posttransformmatrices@2816.
            if (wgpuDeepReplayDiagnostics && len >= 4000 && len <= 4200) {
              if (!self._wgVsSnap || self._wgVsSnap.byteLength < len)
                self._wgVsSnap = new Uint8Array(len);
              self._wgVsSnap.set(uploadSource.subarray(0, len));
              self._wgVsSnapLen = len;
            }
            // [webgpu-DIAG-utilubo] EFB-copy VS reads src_offset(.xy)
            // + src_size(.xy) from this UBO. If src_size≈0 every vertex
            // gets the same uv ⇒ samples one EFB texel ⇒ uniform black.
            // §28y: also wall-clock-sample (every 5 s, capped 24×) so
            // the EFB-copy src_size is observable DEEP in the A-only
            // black-3D dwell (src_size≈0 ⇒ degenerate UV ⇒ uniform
            // white copy = the §28x root).
            let _utWcOk = false;
            if (bid === self._wgUtilBuf) {
              const _un = Date.now();
              self._wgUtUbT0 = self._wgUtUbT0 || _un;
              const _ut = Math.floor((_un - self._wgUtUbT0) / 5000);
              self._wgUtUbWc = (self._wgUtUbWc == null) ? -1 : self._wgUtUbWc;
              if (_ut !== self._wgUtUbWc && _ut < 24) {
                self._wgUtUbWc = _ut;
                _utWcOk = true;
              }
            }
            if (bid === self._wgUtilBuf &&
                ((self._wgUtilUbN = (self._wgUtilUbN || 0) + 1) <= 8
                 || _utWcOk)) {
              const uf = new Float32Array(uploadSource.buffer,
                                          uploadSource.byteOffset,
                                          Math.min(len, 64) >>> 2);
              const ui = new Uint32Array(uploadSource.buffer,
                                         uploadSource.byteOffset,
                                         Math.min(len, 64) >>> 2);
              console.log(`[webgpu-DIAG-utilubo] id=${bid} len=${len} ` +
                `src_offset=${uf[0]?.toFixed(4)},${uf[1]?.toFixed(4)} ` +
                `src_size=${uf[2]?.toFixed(4)},${uf[3]?.toFixed(4)} ` +
                `filt=${ui[4]},${ui[5]},${ui[6]} gamma_rcp=${uf[7]?.toFixed(3)} ` +
                `clamp=${uf[8]?.toFixed(4)},${uf[9]?.toFixed(4)} ` +
                `pxh=${uf[10]?.toFixed(5)}`);
            }
            // §28-vtxdata: snapshot the vertex batch bytes from the
            // HEAP before they go to the GPU (this is the only window
            // to read them). Keyed by dst_offset; bounded to 64 batches.
            if (wgpuDeepReplayDiagnostics && bid === self._wgVtxBufId) {
              if (!self._wgVbSnap) self._wgVbSnap = new Map();
              const dstOff = u32[recWord + 2] & ~3;
              const snap = new Uint8Array(len);
              snap.set(uploadSource.subarray(0, len));
              self._wgVbSnap.set(dstOff, snap);
              if (self._wgVbSnap.size > 64)
                self._wgVbSnap.delete(self._wgVbSnap.keys().next().value);
            }
              if (wgpuUploadTransport === "mapped") {
                const stageStartedAt = causalMetricsEnabled
                  ? wgpuUploadAttribution.beginMappedStageTiming(uploadRole)
                  : null;
                const pool = ensureWgpuMappedStagingPool(dev);
                let retainedAccepted = false;
                let stageAccepted;
                let stageReason = null;
                const destinationOffset = u32[recWord + 2] & ~3;
                if (stagedUpload) {
                  const stage = (data) => {
                    const compute = stageWgpuUboComputeUpload({
                      resourceId: bufferId,
                      role: uploadRole,
                      destinationOffset,
                      data,
                      borrowBytes: true,
                    });
                    if (compute?.handled) return compute;
                    const sparse = ensureWgpuSparseUbo(dev)?.stage({
                      pool,
                      data,
                      destination: buf,
                      destinationOffset,
                      role: uploadRole,
                    });
                    if (sparse?.handled) return sparse;
                    if (wgpuMappedStageFastEnabled) {
                      const reason = pool.stageBufferFast(data, buf, destinationOffset);
                      return reason === null
                        ? WGPU_FAST_STAGE_ACCEPTED
                        : { ok: false, reason };
                    }
                    return pool.stageBuffer({ data, destination: buf, destinationOffset });
                  };
                  const retainedAttempt = attemptRetainedWgpuUpload({
                    stagedUploads: ring.stagedUploads,
                    recordIndex: read,
                    stage,
                  });
                  stageAccepted = retainedAttempt.result.ok;
                  stageReason = retainedAttempt.result.reason ?? null;
                  retainedAccepted = retainedAttempt.accepted;
                } else {
                  const compute = stageWgpuUboComputeUpload({
                    resourceId: bufferId,
                    role: uploadRole,
                    destinationOffset,
                    data: uploadSource,
                  });
                  const sparse = compute?.handled ? null : ensureWgpuSparseUbo(dev)?.stage({
                    pool,
                    data: uploadSource,
                    destination: buf,
                    destinationOffset,
                    role: uploadRole,
                  });
                  if (compute?.handled) {
                    stageAccepted = compute.ok;
                    stageReason = compute.reason ?? null;
                  } else if (sparse?.handled) {
                    stageAccepted = sparse.ok;
                    stageReason = sparse.reason ?? null;
                  } else if (wgpuMappedStageFastEnabled) {
                    stageReason = pool.stageBufferFast(uploadSource, buf, destinationOffset);
                    stageAccepted = stageReason === null;
                  } else {
                    const staged = pool.stageBuffer({
                      data: uploadSource,
                      destination: buf,
                      destinationOffset,
                    });
                    stageAccepted = staged.ok;
                    stageReason = staged.reason ?? null;
                  }
                }
                const stageElapsedMs = stageStartedAt !== null
                  ? wgpuUploadAttribution.finishMappedStageTiming(
                    uploadRole, stageStartedAt, len
                  )
                  : null;
                if (wgpuMappedStageTimingStride === 1 && stageElapsedMs !== null) {
                  webGpuCausalStats.mappedStagingCopyTotalMs += stageElapsedMs;
                  webGpuCausalStats.mappedStagingCopyMaxMs = Math.max(
                    webGpuCausalStats.mappedStagingCopyMaxMs,
                    stageElapsedMs
                  );
                }
                webGpuCausalStats.mappedStagingCopyCount += stageAccepted ? 1 : 0;
                webGpuCausalStats.mappedStagingCopyBytes += stageAccepted ? len : 0;
                if (!stageAccepted) {
                  mappedCapacityHold = true;
                  if (stageReason === "no-capacity") {
                    markWgpuMappedCapacityWait(uploadRole);
                  } else {
                    webGpuCausalStats.mappedStagingUnsafeCapacityCount += 1;
                    markWgpuReplayFatal("staging-capacity", stageReason);
                  }
                  break;
                }
                mappedStageAccepted = true;
                if (retainedAccepted) {
                  ring.stagedUploadBytes = Math.max(
                    0,
                    ring.stagedUploadBytes - stagedUpload.data.byteLength
                  );
                }
                if (causalMetricsEnabled) {
                  wgpuUploadAttribution.recordUpload(
                    uploadRole,
                    uploadBytes,
                    u32[recWord + 2] & ~3
                  );
                  if (wgpuUboComputeProjectionActive) {
                    const classification = classifyWgpuUboComputeUpload(
                      uploadRole,
                      uploadBytes
                    );
                    if (classification) {
                      wgpuUboComputeProjection.observeUpload({
                        resourceId: bufferId,
                        destinationOffset,
                        bytes: uploadSource.subarray(0, uploadBytes),
                        ...classification,
                      });
                    }
                  }
                  if (wgpuDirtyRangeProjectionActive) {
                    wgpuDirtyRangeProjection.recordUpload({
                      bufferId,
                      destinationOffset: u32[recWord + 2] & ~3,
                      bytes: len,
                      role: uploadRole,
                      sourcePointer: srcP,
                      sourceBytes: len,
                      sourceArenaBase: ring.uploadBase,
                      sourceArenaSize: ring.uploadSize,
                      recordIndex: read,
                    });
                  }
                }
              } else {
              let uploadPayload = stagedUpload?.data;
              if (!uploadPayload) {
                const copyStartedAt = causalMetricsEnabled ? performance.now() : 0;
                uploadPayload = copyImmediateWgpuBufferUpload(heap, srcP, uploadBytes);
                if (causalMetricsEnabled) {
                  wgpuReplayOpMetrics.recordUploadCopy(
                    WGPU_CMD_OP_UPLOAD_BUFFER,
                    uploadPayload.byteLength,
                    performance.now() - copyStartedAt
                  );
                }
              }
              const queueWriteStartedAt = causalMetricsEnabled ? performance.now() : 0;
              q.writeBuffer(buf, u32[recWord + 2] & ~3, uploadPayload);
              if (causalMetricsEnabled) {
                wgpuUploadAttribution.recordQueueWrite(
                  uploadRole,
                  uploadBytes,
                  performance.now() - queueWriteStartedAt,
                  {
                    backlogRecords: (replayLimit - read) >>> 0,
                    submissionCount: webGpuCausalStats.queueSubmissionCount,
                    passDepth: protocolPassDepth,
                    staged: Boolean(stagedUpload),
                  }
                );
                wgpuUploadAttribution.recordUpload(
                  uploadRole,
                  uploadBytes,
                  u32[recWord + 2] & ~3
                );
                if (wgpuDirtyRangeProjectionActive) {
                  wgpuDirtyRangeProjection.recordUpload({
                    bufferId,
                    destinationOffset: u32[recWord + 2] & ~3,
                    bytes: len,
                    role: uploadRole,
                    sourcePointer: srcP,
                    sourceBytes: len,
                    sourceArenaBase: ring.uploadBase,
                    sourceArenaSize: ring.uploadSize,
                    recordIndex: read,
                  });
                }
                wgpuReplayOpMetrics.recordQueueUpload(
                  WGPU_CMD_OP_UPLOAD_BUFFER,
                  uploadPayload.byteLength
                );
              }
              }
            }
          } finally {
            // heapCopy/q.writeBuffer have synchronously detached this upload
            // from shared wasm memory, so the producer may now recycle it.
            if (wgpuUploadTransport !== "mapped") {
              if (!stagedUpload) releaseWgpuUploadPayload(ring, srcP, uploadBytes);
            } else if (mappedStageAccepted || !buf) {
              if (!mappedStageAccepted && stagedUpload) {
                ring.stagedUploads.delete(read);
                ring.stagedUploadBytes = Math.max(
                  0,
                  ring.stagedUploadBytes - stagedUpload.data.byteLength
                );
              } else if (!stagedUpload) {
                releaseWgpuUploadPayload(ring, srcP, uploadBytes);
              }
            }
          }
          break;
        }
        case WGPU_CMD_OP_CREATE_TEXTURE: {
          const id = u32[recWord + 1];
          if (!webGpuObjects.textures.has(id)) {
            const fmt = WGPU_TEX_FORMAT[u32[recWord + 4]] || "rgba8unorm";
            const layers = Math.max(1, u32[recWord + 6] || 1);
            const tex = dev.createTexture({
              size: [Math.max(1, u32[recWord + 2]),
                     Math.max(1, u32[recWord + 3]), layers],
              // Older producers leave this word zero. Preserve their single
              // mip allocation while accepting the game's complete mip chain.
              mipLevelCount: Math.max(1, u32[recWord + 7] || 1),
              // DIAG_TEX_READBACK adds COPY_SRC so the texture can be copied
              // back and inspected. Upload-byte accounting has proved
              // unreliable twice; reading the actual texels replaces the whole
              // inference chain with a direct observation.
              format: fmt,
              usage: u32[recWord + 5] | ((DIAG_TEX_READBACK || DIAG_DEPTH_READBACK || DIAG_DEPTH_TRACE) ? 0x1 : 0)
            });
            webGpuObjects.textures.set(id,
              { tex, format: fmt, layers, view2dArray: null,
                usage: u32[recWord + 5] });
          }
          break;
        }
        case WGPU_CMD_OP_UPLOAD_TEXTURE: {
          const textureId = u32[recWord + 1];
          const src = u32[recWord + 2];
          const bpr = u32[recWord + 3];
          const h = u32[recWord + 5];
          const uploadBytes = Math.imul(bpr, h) >>> 0;
          const stagedUpload = ring.stagedUploads?.get(read) ?? null;
          if (stagedUpload && wgpuUploadTransport !== "mapped") {
            ring.stagedUploads.delete(read);
            ring.stagedUploadBytes = Math.max(
              0,
              ring.stagedUploadBytes - stagedUpload.data.byteLength
            );
          }
          const t = webGpuObjects.textures.get(textureId);
          const uploadSource = stagedUpload?.data ??
            new Uint8Array(moduleInstance.HEAPU8.buffer, src, uploadBytes);
          let mappedStageAccepted = false;
          try {
            if (!t) {
              wgpuReplayClassifier?.recordMissingResource({ kind: "upload-texture", id: textureId });
            }
            if (!vpDiagDone) {
              vpDiagNoteTexUpload(textureId, uploadSource, uploadBytes);
              const _r = vpDiagTexData.get(textureId);
              vpDiagNoteTexUploadShape(textureId, bpr, u32[recWord + 4], h, uploadBytes,
                !!stagedUpload,
                _r && _r.samples ? Math.round((100 * _r.nzBytes) / _r.samples) : 0);
            }
            const uz = u32[recWord + 7];
            if (t && !t.format.startsWith("depth") && uz < t.layers) {
              const w = u32[recWord + 4];
            // DIAG one-shot per tex id: confirm uploaded pixels aren't
            // all-zero (→ black sampling). Dumps first 4 RGBA texels.
            self._wgUtN = self._wgUtN || {};
            const tid = u32[recWord + 1];
            if (!self._wgUtN[tid] &&
                (self._wgUtTot = (self._wgUtTot || 0) + 1) <= 14) {
              self._wgUtN[tid] = true;
              const px = uploadSource.subarray(0, Math.min(uploadBytes, 16));
              let nz = 0;
              const chk = uploadSource.subarray(0, Math.min(uploadBytes, 4096));
              for (let q2 = 0; q2 < chk.length; q2++) if (chk[q2]) { nz++; }
              console.log(`[webgpu-DIAG-ut] tex#${tid} ${w}x${h} bpr=${bpr} ` +
                `mip=${u32[recWord+6]} px0=${px[0]},${px[1]},${px[2]},${px[3]} ` +
                `px1=${px[4]},${px[5]},${px[6]},${px[7]} nz=${nz}/${chk.length}`);
            }
              if (wgpuUploadTransport === "mapped") {
                const stageStartedAt = causalMetricsEnabled
                  ? wgpuUploadAttribution.beginMappedStageTiming(
                      WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT
                    )
                  : null;
                const pool = ensureWgpuMappedStagingPool(dev);
                const copySize = { width: w, height: h, depthOrArrayLayers: 1 };
                const origin = { x: 0, y: 0, z: uz };
                let retainedAccepted = false;
                let stageAccepted;
                let stageReason = null;
                if (wgpuMappedStageFastEnabled) {
                  stageReason = pool.stageTextureFast(
                    stagedUpload?.data ?? uploadSource,
                    t.tex,
                    copySize,
                    bpr,
                    h,
                    origin,
                    u32[recWord + 6]
                  );
                  stageAccepted = stageReason === null;
                  if (stagedUpload && stageAccepted) {
                    ring.stagedUploads.delete(read);
                    retainedAccepted = true;
                  }
                } else {
                  const stage = (data) => pool.stageTexture({
                    data,
                    destination: t.tex,
                    sourceBytesPerRow: bpr,
                    sourceRowsPerImage: h,
                    mipLevel: u32[recWord + 6],
                    origin,
                    copySize,
                  });
                  const retainedAttempt = stagedUpload
                    ? attemptRetainedWgpuUpload({
                        stagedUploads: ring.stagedUploads,
                        recordIndex: read,
                        stage,
                      })
                    : null;
                  const staged = retainedAttempt?.result ?? stage(uploadSource);
                  stageAccepted = staged.ok;
                  stageReason = staged.reason ?? null;
                  retainedAccepted = Boolean(retainedAttempt?.accepted);
                }
                const stageElapsedMs = stageStartedAt !== null
                  ? wgpuUploadAttribution.finishMappedStageTiming(
                    WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT,
                    stageStartedAt,
                    uploadBytes
                  )
                  : null;
                if (wgpuMappedStageTimingStride === 1 && stageElapsedMs !== null) {
                  webGpuCausalStats.mappedStagingCopyTotalMs += stageElapsedMs;
                  webGpuCausalStats.mappedStagingCopyMaxMs = Math.max(
                    webGpuCausalStats.mappedStagingCopyMaxMs,
                    stageElapsedMs
                  );
                }
                webGpuCausalStats.mappedStagingCopyCount += stageAccepted ? 1 : 0;
                webGpuCausalStats.mappedStagingCopyBytes += stageAccepted ? uploadBytes : 0;
                if (!stageAccepted) {
                  mappedCapacityHold = true;
                  if (stageReason === "no-capacity") {
                    markWgpuMappedCapacityWait(WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT);
                  } else {
                    webGpuCausalStats.mappedStagingUnsafeCapacityCount += 1;
                    markWgpuReplayFatal("staging-capacity", stageReason);
                  }
                  break;
                }
                mappedStageAccepted = true;
                if (retainedAccepted) {
                  ring.stagedUploadBytes = Math.max(
                    0,
                    ring.stagedUploadBytes - stagedUpload.data.byteLength
                  );
                }
                if (causalMetricsEnabled) {
                  wgpuUploadAttribution.recordUpload(
                    WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT,
                    uploadBytes,
                    0
                  );
                }
              } else {
              let uploadPayload = stagedUpload?.data;
              if (!uploadPayload) {
                const copyStartedAt = causalMetricsEnabled ? performance.now() : 0;
                uploadPayload = heapCopy(src, uploadBytes);
                if (causalMetricsEnabled) {
                  wgpuReplayOpMetrics.recordUploadCopy(
                    WGPU_CMD_OP_UPLOAD_TEXTURE,
                    uploadPayload.byteLength,
                    performance.now() - copyStartedAt
                  );
                }
              }
              q.writeTexture(
                { texture: t.tex, mipLevel: u32[recWord + 6],
                  origin: { x: 0, y: 0, z: uz } },
                uploadPayload,
                { offset: 0, bytesPerRow: bpr, rowsPerImage: h },
                { width: w, height: h, depthOrArrayLayers: 1 });
              if (causalMetricsEnabled) {
                wgpuUploadAttribution.recordUpload(
                  WGPU_UPLOAD_ROLE.TEXTURE_ADJACENT,
                  uploadBytes,
                  0
                );
                wgpuReplayOpMetrics.recordQueueUpload(
                  WGPU_CMD_OP_UPLOAD_TEXTURE,
                  uploadPayload.byteLength
                );
              }
              }
            }
          } finally {
            // queue.writeTexture consumes the local heapCopy synchronously.
            if (wgpuUploadTransport !== "mapped") {
              if (!stagedUpload) releaseWgpuUploadPayload(ring, src, uploadBytes);
            } else if (mappedStageAccepted || !t) {
              if (!mappedStageAccepted && stagedUpload) {
                ring.stagedUploads.delete(read);
                ring.stagedUploadBytes = Math.max(
                  0,
                  ring.stagedUploadBytes - stagedUpload.data.byteLength
                );
              } else if (!stagedUpload) {
                releaseWgpuUploadPayload(ring, src, uploadBytes);
              }
            }
          }
          break;
        }
        case WGPU_CMD_OP_CREATE_SAMPLER: {
          const id = u32[recWord + 1];
          if (!webGpuObjects.samplers.has(id)) {
            const descriptor = decodeWgpuSamplerState(u32[recWord + 2]);
            webGpuObjects.samplers.set(id, dev.createSampler(descriptor));
            webGpuObjects.samplerDescriptors.set(id, descriptor);
          }
          break;
        }
        case WGPU_CMD_OP_CREATE_BIND_GROUP:
          replayCreateBindGroup(u32[recWord + 1], u32[recWord + 2],
                                u32[recWord + 3]);
          break;
        case WGPU_CMD_OP_BEGIN_PASS: {
          const passWasOpen = Boolean(pass);
          endPass("begin-pass", read);
          if (!passWasOpen && wgpuConsumerStateCacheEnabled) {
            wgpuPassStateCache.reset("begin-pass");
          }
          ensureEnc();
          const fbId = u32[recWord + 1];
          // Clear intent is a bitmask packed into the load_op word by
          // WebGPUGfx::PendingClearMask(): bit0 = clear at all, bit1 = clear
          // colour, bit2 = clear depth. Older cores only ever wrote 0 or 1,
          // and bit0 keeps that meaning, so a pre-bitmask core still decodes
          // correctly -- it simply reports "clear both", which is what it did.
          //
          // Before this, a single bit drove BOTH attachments, so a depth-only
          // clear also wiped colour. On Wario World that destroyed a fully
          // rendered 3D EFB right before the XFB copy, leaving only the 2D
          // overlay on black (issue #8).
          const clearMask = u32[recWord + 6];
          const clearAny = (clearMask & 1) !== 0;
          const legacyClear = clearMask === 1;
          const clearColor = clearAny && (legacyClear || (clearMask & 2) !== 0);
          const clearDepth = clearAny && (legacyClear || (clearMask & 4) !== 0);
          const loadOp = clearColor ? "clear" : "load";
          const depthLoadOpResolved = clearDepth ? "clear" : "load";
          const depthId = u32[recWord + 7];
          passDepthId = depthId;
          if (fbId === self._wgEfbColorId && depthId) self._wgEfbDepthId = depthId;
          passLoadOp = loadOp;
          // §28af: the producer emits SET_VIEWPORT immediately after
          // BEGIN_PASS (cached vp re-emit). Peek it to learn this
          // pass's reverse-Z BEFORE the depth attachment (whose
          // depthClearValue is fixed at beginRenderPass and cannot be
          // changed later) is built. reverse-Z ⇒ clear depth to far
          // 0.0; normal-Z ⇒ far 1.0 (the GX/Dolphin default). If the
          // peek isn't available yet, keep the last-seen pass state.
          if (((read + 1) >>> 0) !== replayLimit) {
            const nrw = (ring.slotsBase + ((read + 1) % ring.capacity) * 32) >>> 2;
            if (u32[nrw] === WGPU_CMD_OP_SET_VIEWPORT)
              self._wgPassRevZ = f32[nrw + 5] > f32[nrw + 6];
          }
          // §28at: SINGLE non-reverse convention (producer flag=false
          // + C++ inversion cluster decoupled). Bake a CONSTANT far
          // depth clear for EVERY pass — a per-pass dcv is exactly
          // the §28aq flicker mechanism (one baked value can't serve a
          // mixed pass). With uniform normal-Z [0,1] viewports and the
          // [s28at-vp] PROVED flag=false makes EVERY viewport arrive
          // T(near=0,far=1) → consumer setViewport(0,1) for all — the
          // SAME setViewport flag=true-3D produces after swapping its
          // raw (1,0). flag=true-3D RENDERS that with dcv=0.0 + GEQUAL
          // (reverse-Z carried in the projection/VS, which is NOT
          // flag-keyed). So the single convention = dcv=0.0 + flipped
          // compare for ALL rzRelevant draws (uniform — see
          // REVZ_COMPARE_FLIP). dcv=1.0/unflipped was backwards = black;
          // §28as's dcv=0.0-but-unflipped was the half-right mismatch.
          const dcv = GX_NATIVE_DEPTH ? 1.0 : 0.0;
          // §28aq DISCRIMINATING PROBE: record the revZ baked into
          // this pass's depthClearValue; the SET_VIEWPORT handler
          // logs when a later viewport in the SAME pass disagrees
          // (⇒ the bake-time value was wrong = the flicker source).
          self._wgPassRevZAtBegin = self._wgPassRevZ;
          self._wgBpSeq = (self._wgBpSeq || 0) + 1;
          self._wgVpInPass = 0;
          if (depthId && (self._wgAqN = (self._wgAqN || 0) + 1) <= 60) {
            console.log(`[s28aq-bp] bp#${self._wgBpSeq} fb=${fbId} ` +
              `depth=${depthId} dcv=${dcv} revZ=${self._wgPassRevZ ? 1 : 0} ` +
              `peeked=${(((read + 1) >>> 0) !== replayLimit &&
                u32[(ring.slotsBase + ((read + 1) % ring.capacity) * 32) >>> 2]
                  === WGPU_CMD_OP_SET_VIEWPORT) ? 1 : 0}`);
          }
          let colorView;
          if (fbId === 0) {
            webGpuExecStats.beginFb0++;
            // Grow the backbuffer to what the game actually asked for. Only
            // ever grows, and only when the size differs, so a game that
            // legitimately renders small is not disturbed every frame.
            // ONE-SHOT, and only upward. Driving this from per-frame viewport
            // requests was tried and reverted: extents reached 944x756, and
            // resizing the swapchain repeatedly blanked the output entirely
            // (0.0 visual fps). The size must be stable, so take the page
            // canvas's intended size once and leave it alone.
            if (!wgpuBackbufferSized && renderCanvas &&
                (renderCanvas.width < WGPU_BACKBUFFER_W ||
                 renderCanvas.height < WGPU_BACKBUFFER_H)) {
              wgpuBackbufferSized = true;
              const newW = WGPU_BACKBUFFER_W;
              const newH = WGPU_BACKBUFFER_H;
              try {
                renderCanvas.width = newW;
                renderCanvas.height = newH;
                renderGpu.context.configure({
                  device: renderGpu.device,
                  format: renderGpu.format,
                  alphaMode: "opaque",
                  usage: self.GPUTextureUsage.RENDER_ATTACHMENT |
                    ((wgpuReplayClassifier || inputReadbackDiagnostics) ?
                      self.GPUTextureUsage.COPY_SRC : 0) |
                    (wgpuVisualCadenceEnabled ? self.GPUTextureUsage.TEXTURE_BINDING : 0)
                });
                renderGpu.canvasWidth = newW;
                renderGpu.canvasHeight = newH;
                console.log(`[bbresize] backbuffer ${newW}x${newH} (game viewport extent)`);
                postStatus(`wgpu backbuffer resized to ${newW}x${newH}`);
              } catch (e) {
                recordRendererError("validation", `backbuffer resize: ${e?.message || e}`);
              }
            }
            // Content check on the texture actually about to be presented,
            // read adjacent to the EFB in the command stream. Triple buffering
            // means the presented entry legitimately differs from the newest
            // one, so identity proves nothing -- only content does.
            if (DIAG_EFB_TO_CANVAS) {
              self._wgPresGridN = (self._wgPresGridN || 0) + 1;
              if ((self._wgPresGridN % 240) === 0) {
                const _src = wgpuLastBackbufferSourceTextureId || 0;
                if (_src) {
                  try {
                    const _enc = ensureEnc();
                    diagReadTexture(dev, _enc, webGpuObjects.textures.get(_src),
                                    `PRESENTED(tex#${_src})`, `n=${self._wgPresGridN}`);
                    diagReadTexture(dev, _enc,
                                    webGpuObjects.textures.get(self._wgEfbColorId || 0),
                                    `EFB(tex#${self._wgEfbColorId || 0})`,
                                    `n=${self._wgPresGridN}`);
                  } catch (e) {}
                }
              }
            }
            const cur = renderGpu.context.getCurrentTexture();
            lastBackbufferTexture = cur;
            currentBackbufferSourceTextureId = 0;
            colorView = cur.createView();
            passW = cur.width;
            passH = cur.height;
            passColorFmt = renderGpu.format;
            if (frameCapActive()) frameCapPush(`BEGINPASS fb#0 BACKBUFFER ${passW}x${passH}`);
          } else {
            webGpuExecStats.beginFbN++;
            const ct = webGpuObjects.textures.get(fbId);
            if (!ct) {
              wgpuReplayClassifier?.recordMissingResource({ kind: "color-texture", id: fbId });
              break;
            }
            colorView = ct.tex.createView({ dimension: "2d", mipLevelCount: 1,
              baseArrayLayer: 0, arrayLayerCount: 1 });
            passW = ct.tex.width;
            passH = ct.tex.height;
            passColorFmt = ct.format;
            if (frameCapActive()) frameCapPush(`BEGINPASS fb#${fbId} ${passW}x${passH} fmt=${ct.format}` +
              `${fbId === (self._wgEfbColorId || -1) ? " (EFB)" : ""}`);
            // DIAG: which texture ids are ever render targets (+size).
            // Cross-ref with tex#69 (640x480 green, sampled at b1
            // everywhere): if 640x480 ids never appear here, they're
            // pure XFB-from-RAM ⇒ EFB-copy-to-RAM (staging) is stubbed.
            self._wgRT = self._wgRT || {};
            if (!self._wgRT[fbId]) {
              self._wgRT[fbId] = true;
              console.log(`[webgpu-DIAG-rt] render-target tex#${fbId} ` +
                `${ct.tex.width}x${ct.tex.height} ${ct.format} depth=${depthId}`);
            }
            // [webgpu-DIAG-cpy] EFB-copy color targets: depth-less
            // rgba8unorm RTs that aren't the bgra8 XFB. These are the
            // textures textured draws later SAMPLE — if they are empty
            // post-copy-to-vram, every consumer is black (§15a).
            if (!depthId && ct.format === "rgba8unorm" &&
                ct.tex.width <= 1024) {
              self._wgCopyTargets = self._wgCopyTargets || new Set();
              self._wgCopyTargets.add(fbId);
              self._wgCpySrc = null;
            }
            // The XFB blit target: the large bgra8unorm depth-less RT.
            // If menu content lives HERE while the EFB is cleared, the
            // interim DIAG_EFB_TO_CANVAS present (EFB only) shows black.
            if (!depthId && ct.format === "bgra8unorm" &&
                ct.tex.width >= 1024) {
              self._wgXfbId = fbId;
            }
          }
          passDepthFmt = (depthId && webGpuObjects.textures.get(depthId))
            ? webGpuObjects.textures.get(depthId).format : null;
          const desc = {
            colorAttachments: [{
              view: colorView,
              clearValue: { r: f32[recWord + 2], g: f32[recWord + 3],
                            b: f32[recWord + 4], a: f32[recWord + 5] },
              loadOp, storeOp: "store"
            }]
          };
          const dt = depthId ? webGpuObjects.textures.get(depthId) : null;
          if (depthId && !dt) {
            wgpuReplayClassifier?.recordMissingResource({ kind: "depth-texture", id: depthId });
          }
          if (dt) {
            const ds = {
              view: dt.tex.createView({ dimension: "2d", mipLevelCount: 1,
                baseArrayLayer: 0, arrayLayerCount: 1 }),
              // §28af: per-pass reverse-Z depth clear (dcv computed
              // from the peeked SET_VIEWPORT above). reverse-Z 3D
              // passes clear to far=0.0 (paired with the flipped
              // GEQUAL compare); normal-Z menu/UI passes clear to
              // far=1.0 with the unflipped GX compare — the §28ad
              // global 0.0 wrongly killed the normal-Z menu draws.
              depthClearValue: dcv, depthLoadOp: depthLoadOpResolved,
              depthStoreOp: "store"
            };
            if (dt.format.indexOf("stencil") >= 0) {
              ds.stencilClearValue = 0;
              ds.stencilLoadOp = depthLoadOpResolved;
              ds.stencilStoreOp = "store";
            }
            desc.depthStencilAttachment = ds;
          }
          if (fbId === self._wgEfbColorId) vpDiagNoteEfbPass(loadOp === "clear");
          pass = enc.beginRenderPass(desc);
          dtPassDesc = desc;
          lastAppliedViewport = lastAppliedScissor = dtLastPipe = dtLastVb = dtLastIb = null;
          dtLastBg.fill(null);
          if (DIAG_DEPTH_TRACE && self._wgDt && self._wgDt.armed &&
              fbId === self._wgEfbColorId) {
            self._wgDt.passSeq++;
          }
          if (causalMetricsEnabled) wgpuUploadAttribution.recordPassBegin();
          wgpuReplayClassifier?.recordPassBegin({ framebufferId: fbId, recordIndex: read });
          if (depthId && loadOp === "clear") {
            wgpuReplayClassifier?.recordEfbClear({
              framebufferId: fbId,
              rgba: [f32[recWord + 2], f32[recWord + 3],
                     f32[recWord + 4], f32[recWord + 5]]
            });
          }
          passHasPipe = false;
          passNeedsVertexBuffer = false;
          vertexBufferValid = false;
          indexBufferValid = false;
          passSamplingKey = "0/0";
          bgValid[0] = bgValid[1] = bgValid[2] = false;  // §28j
          if (drawState) {
            drawState.bindGroups.fill(0);
            drawState.dynamicOffsetCounts.fill(0);
            drawState.vertexBuffer = null;
            drawState.indexBuffer = null;
            drawState.viewport = null;
            drawState.scissor = null;
          }
          passFbId = fbId;
          // Every non-EFB, non-backbuffer target, with how many EFB draws have
          // executed this frame at that moment. The copy's source rect is
          // correct and the EFB is correct at present time, so if the copy
          // runs early in the frame it captures a half-drawn EFB.
          if (fbId !== 0 && fbId !== (self._wgEfbColorId || -1)) {
            const _d = webGpuObjects.textures.get(fbId);
            if (_d && _d.tex && _d.tex.width === 608 && _d.tex.height === 456) {
              diagLastCopyDst = fbId;
              diagLastCopyFrame = self._wgFrameN || 0;
            }
            diagNoteXfbCopy(fbId);
          }
          // The EFB colour pass is the only one with a depth
          // attachment (the fb=47 XFB has none) — track its id so the
          // DIAG path can blit it straight to the canvas.
          if (fbId !== 0 && depthId) self._wgEfbColorId = fbId;
          if (fbId !== 0) {
            self._wgEfbN = (self._wgEfbN || 0) + 1;
            if (self._wgEfbN <= 6) {
              const ct2 = webGpuObjects.textures.get(fbId);
              console.log(`[webgpu-exec] EFB pass#${self._wgEfbN} fb=${fbId}` +
                `(${ct2 ? ct2.format : "?"}) depth=${depthId}` +
                `(${dt ? dt.format : "none"}) load=${loadOp} ` +
                `clear=${f32[recWord + 2].toFixed(2)},${f32[recWord + 3].toFixed(2)},` +
                `${f32[recWord + 4].toFixed(2)},${f32[recWord + 5].toFixed(2)}`);
            }
          } else if (!self._wgFb0Logged) {
            self._wgFb0Logged = true;
            console.log(`[webgpu-exec] first backbuffer pass load=${loadOp} ` +
              `clear=${f32[recWord + 2].toFixed(2)},${f32[recWord + 3].toFixed(2)},` +
              `${f32[recWord + 4].toFixed(2)}`);
          }
          break;
        }
        case WGPU_CMD_OP_SET_PIPELINE: {
          const pid = u32[recWord + 1];
          self._wgCurPipe = pid;
          // A SET_* record is a requested transition, not a hint. If the
          // resource is missing or the call fails, retaining the previous
          // pipeline would silently execute the next draw with stale state.
          passHasPipe = false;
          passNeedsVertexBuffer = false;
          if (!pass) {
            wgpuReplayClassifier?.recordStateOutsidePass({ op: "set-pipeline", recordIndex: read });
          }
          const p = pass
            ? resolvePipeline(pid, passColorFmt, passDepthFmt, undefined,
                              !!self._wgPassRevZ, passSamplingKey)
            : null;
          if (pass && p) {
            const needsApply = !wgpuConsumerStateCacheEnabled ||
              wgpuPassStateCache.pipelineNeedsApply(p);
            try {
              if (needsApply) {
                pass.setPipeline(p);
                if (wgpuConsumerStateCacheEnabled) wgpuPassStateCache.recordPipelineApplied(p);
              }
              passHasPipe = true;
              dtLastPipe = p;
              passNeedsVertexBuffer = Boolean(
                webGpuObjects.pipeTpl.get(pid)?.desc?.vertex?.buffers?.length
              );
              webGpuExecStats.setPipe++;
              pd.pipeOk++;
            } catch (error) {
              if (wgpuConsumerStateCacheEnabled) wgpuPassStateCache.recordPipelineApplyFailed();
              passHasPipe = false;
              recordRendererError("set-pipeline", error?.message || error);
              webGpuExecStats.missPipe++;
              pd.pipeMiss++;
            }
          } else {
            webGpuExecStats.missPipe++; pd.pipeMiss++;
            if (pass && !p) {
              wgpuReplayClassifier?.recordMissingResource({ kind: "pipeline", id: pid });
            }
          }
          break;
        }
        case WGPU_CMD_OP_SET_BIND_GROUP: {
          const bgSlot = u32[recWord + 1];
          const bgId = u32[recWord + 2];
          const bg = webGpuObjects.bindGroups.get(bgId);
          if (!pass) {
            wgpuReplayClassifier?.recordStateOutsidePass({ op: "set-bind-group", recordIndex: read });
          }
          if (!bg) {
            wgpuReplayClassifier?.recordMissingResource({ kind: "bind-group", id: bgId });
          }
          if (bgSlot === 1 && pass) {
            const samplingKey = webGpuObjects.bindGroupSamplingMasks.get(bgId) || "0/0";
            if (samplingKey !== passSamplingKey) {
              passSamplingKey = samplingKey;
              // The producer sets its pipeline before its texture group and
              // can retain that pipeline while textures change. Select the
              // matching layout now, before either draw opcode uses it.
              if (passHasPipe) {
                const pipeline = resolvePipeline(self._wgCurPipe, passColorFmt,
                  passDepthFmt, undefined, !!self._wgPassRevZ, passSamplingKey);
                passHasPipe = false;
                if (pipeline) {
                  try {
                    pass.setPipeline(pipeline);
                    dtLastPipe = pipeline;
                    if (wgpuConsumerStateCacheEnabled) {
                      wgpuPassStateCache.recordPipelineApplied(pipeline);
                    }
                    passHasPipe = true;
                  } catch (error) {
                    if (wgpuConsumerStateCacheEnabled) {
                      wgpuPassStateCache.recordPipelineApplyFailed();
                    }
                    recordRendererError("set-pipeline", error?.message || error);
                  }
                }
              }
            }
          }
          if (bgSlot < 3) bgValid[bgSlot] = !!(pass && bg);  // §28j
          if (drawState && bgSlot < 3) {
            drawState.bindGroups[bgSlot] = bgId;
            drawState.dynamicOffsetCounts[bgSlot] = u32[recWord + 3];
          }
          if (u32[recWord + 1] === 1) self._wgCurBg1 = bgId;
          if (bgSlot === 1 && self._wgBgTex) {
            const _bt = self._wgBgTex[bgId];
            const _bo = _bt != null ? webGpuObjects.textures.get(_bt) : null;
            if (frameCapActive()) frameCapPush(`  BINDTEX  fb#${passFbId} tex#${_bt != null ? _bt : "?"}` +
              `${_bo && _bo.tex ? " " + _bo.tex.width + "x" + _bo.tex.height : ""}`);
          }
          if (passFbId === 0 && bgSlot === 1 && self._wgBgTex) {
            currentBackbufferSourceTextureId = self._wgBgTex[bgId] >>> 0;
            // DIAG: what does the backbuffer blit actually sample? Mario Kart
            // Wii presents what looks like its minimap scaled to full frame,
            // so the question is whether this is the EFB colour texture at all
            // and what size it is. Capped: first few, then occasional, so a
            // long run still shows the in-race state.
            self._wgBbSrcN = (self._wgBbSrcN || 0) + 1;
            if (self._wgBbSrcN <= 6 || (self._wgBbSrcN % 600) === 0) {
              const _t = webGpuObjects.textures.get(currentBackbufferSourceTextureId);
              const _e = webGpuObjects.textures.get(self._wgEfbColorId || 0);
              const _dim = (o) => (o && o.tex) ? `${o.tex.width}x${o.tex.height}` : "?";
              console.log(`[bbsrc] n=${self._wgBbSrcN} src=tex#${currentBackbufferSourceTextureId}` +
                ` ${_dim(_t)} fmt=${_t ? _t.format : "?"}` +
                ` | efb=tex#${self._wgEfbColorId || 0} ${_dim(_e)}` +
                ` xfb=tex#${self._wgXfbId || 0}`);
            }
          }
          if (u32[recWord + 1] === 1 && self._wgBgTex &&
              self._wgBgTex[bgId] != null &&
              self._wgCopyTargets && self._wgCopyTargets.has(passFbId)) {
            self._wgCpySrc = self._wgBgTex[bgId];
          }
          if (pass && bg) {
            // §16: arg.u[2]=nDynOff, u[3..6]=per-draw ring offsets
            // (group0 has 4 dynamic-offset UBO bindings; groups 1/2: 0).
            const nOff = u32[recWord + 3];
            for (let k = 0; k < nOff; k++) {
              WGPU_DYN_OFF_SCRATCH[k] = u32[recWord + 4 + k];
              if (bgSlot === 0) vpDiagNoteVsOffset(u32[recWord + 4 + k]);
            }
            dtLastBg[bgSlot] = { bg, off: nOff ? Array.from(WGPU_DYN_OFF_SCRATCH.subarray(0, nOff)) : null };
            const needsApply = !wgpuConsumerStateCacheEnabled ||
              wgpuPassStateCache.bindGroupNeedsApply(
                bgSlot,
                bg,
                WGPU_DYN_OFF_SCRATCH,
                nOff
              );
            try {
              if (needsApply) {
                if (nOff) {
                  // Zero-alloc overload: (slot, bg, data, dataStart, dataLen)
                  pass.setBindGroup(bgSlot, bg, WGPU_DYN_OFF_SCRATCH, 0, nOff);
                } else {
                  pass.setBindGroup(bgSlot, bg);
                }
                if (wgpuConsumerStateCacheEnabled) {
                  wgpuPassStateCache.recordBindGroupApplied(
                    bgSlot,
                    bg,
                    WGPU_DYN_OFF_SCRATCH,
                    nOff
                  );
                }
              }
              webGpuExecStats.setBg++;
              pd.bgOk++;
            } catch (error) {
              if (wgpuConsumerStateCacheEnabled) {
                wgpuPassStateCache.recordBindGroupApplyFailed(bgSlot);
              }
              if (bgSlot < 3) bgValid[bgSlot] = false;
              recordRendererError("set-bind-group", error?.message || error);
              webGpuExecStats.missBg++;
              pd.bgMiss++;
            }
          }
          else { webGpuExecStats.missBg++; pd.bgMiss++; }
          break;
        }
        case WGPU_CMD_OP_SET_VERTEX_BUFFER: {
          const bufferId = u32[recWord + 2];
          const b = webGpuObjects.buffers.get(bufferId);
          const slot = u32[recWord + 1];
          if (slot === 0) vertexBufferValid = false;
          if (!pass) {
            wgpuReplayClassifier?.recordStateOutsidePass({ op: "set-vertex-buffer", recordIndex: read });
          }
          if (!b) wgpuReplayClassifier?.recordMissingResource({ kind: "vertex-buffer", id: bufferId });
          if (pass && b) {
            const offset = u32[recWord + 3];
            dtLastVb = { slot, b, offset };
            const needsApply = !wgpuConsumerStateCacheEnabled ||
              wgpuPassStateCache.vertexBufferNeedsApply(slot, b, offset);
            try {
              if (needsApply) {
                pass.setVertexBuffer(slot, b, offset);
                if (wgpuConsumerStateCacheEnabled) {
                  wgpuPassStateCache.recordVertexBufferApplied(slot, b, offset);
                }
              }
              if (slot === 0) vertexBufferValid = true;
              if (drawState) drawState.vertexBuffer = { slot, id: bufferId, offset };
            } catch (error) {
              if (wgpuConsumerStateCacheEnabled) {
                wgpuPassStateCache.recordVertexBufferApplyFailed(slot);
              }
              recordRendererError("set-vertex-buffer", error?.message || error);
            }
          }
          break;
        }
        case WGPU_CMD_OP_SET_INDEX_BUFFER: {
          const bufferId = u32[recWord + 1];
          const b = webGpuObjects.buffers.get(bufferId);
          indexBufferValid = false;
          if (!pass) {
            wgpuReplayClassifier?.recordStateOutsidePass({ op: "set-index-buffer", recordIndex: read });
          }
          if (!b) wgpuReplayClassifier?.recordMissingResource({ kind: "index-buffer", id: bufferId });
          if (pass && b) {
            const format = u32[recWord + 2] === 1 ? "uint32" : "uint16";
            const offset = u32[recWord + 3];
            dtLastIb = { b, format, offset };
            const needsApply = !wgpuConsumerStateCacheEnabled ||
              wgpuPassStateCache.indexBufferNeedsApply(b, format, offset);
            try {
              if (needsApply) {
                pass.setIndexBuffer(b, format, offset);
                if (wgpuConsumerStateCacheEnabled) {
                  wgpuPassStateCache.recordIndexBufferApplied(b, format, offset);
                }
              }
              indexBufferValid = true;
              if (drawState) drawState.indexBuffer = { id: bufferId, format, offset };
            } catch (error) {
              if (wgpuConsumerStateCacheEnabled) {
                wgpuPassStateCache.recordIndexBufferApplyFailed();
              }
              recordRendererError("set-index-buffer", error?.message || error);
            }
          }
          break;
        }
        case WGPU_CMD_OP_SET_VIEWPORT:
          // DIAG (?efbdiag=1): the backbuffer blit. EFB, the EFB->XFB copy and
          // the presented entry all verify correct, so the remaining suspect is
          // how this pass samples that entry. Record the raw requested viewport
          // for fb#0 against the pass size.
          if (passFbId === 0) {
            self._wgLastVp = `${f32[recWord + 1].toFixed(0)},${f32[recWord + 2].toFixed(0)}` +
              `+${f32[recWord + 3].toFixed(0)}x${f32[recWord + 4].toFixed(0)}`;
          }
          if (frameCapActive()) frameCapPush(`  VIEWPORT fb#${passFbId} ` +
            `${f32[recWord + 1].toFixed(0)},${f32[recWord + 2].toFixed(0)}` +
            `+${f32[recWord + 3].toFixed(0)}x${f32[recWord + 4].toFixed(0)}`);
          if (DIAG_EFB_TO_CANVAS && passFbId === 0) {
            self._wgBbVpN = (self._wgBbVpN || 0) + 1;
            if (self._wgBbVpN <= 4 || (self._wgBbVpN % 600) === 0) {
              const _cv = renderGpu && renderGpu.context && renderGpu.context.canvas;
              console.log(`[bbcanvas] ctxCanvas=${_cv ? _cv.width + "x" + _cv.height : "?"}` +
                ` renderCanvas=${typeof renderCanvas !== "undefined" && renderCanvas ?
                   renderCanvas.width + "x" + renderCanvas.height : "?"}` +
                ` gpuCfg=${renderGpu ? renderGpu.canvasWidth + "x" + renderGpu.canvasHeight : "?"}`);
              console.log(`[bbvp] n=${self._wgBbVpN} raw vp=(${f32[recWord + 1].toFixed(1)},` +
                `${f32[recWord + 2].toFixed(1)})+${f32[recWord + 3].toFixed(1)}x` +
                `${f32[recWord + 4].toFixed(1)} pass=${passW}x${passH} ` +
                `src=tex#${currentBackbufferSourceTextureId || 0}`);
            }
          }
          if (pass && passW > 0) {
            // Preserve the viewport transform; the attachment/scissor clips fragments.
            const vx = f32[recWord + 1], vy = f32[recWord + 2];
            const vw = f32[recWord + 3], vh = f32[recWord + 4];
            // §28af: raw near>far ⇒ Dolphin reverse-Z viewport for
            // this pass. Drives the per-pass compare-flip + depth
            // clear (set self._wgPassRevZ BEFORE the Dawn-required
            // mn≤mx swap so the reversal signal isn't lost).
            self._wgPassRevZ = f32[recWord + 5] > f32[recWord + 6];
            // §28aq: a SET_VIEWPORT inside an open pass whose revZ
            // disagrees with what BEGIN_PASS baked into depthClearValue
            // = the flicker mechanism (bake-time guess was wrong).
            self._wgVpInPass = (self._wgVpInPass || 0) + 1;
            if (pass && self._wgPassRevZ !== self._wgPassRevZAtBegin &&
                (self._wgAqMisN = (self._wgAqMisN || 0) + 1) <= 60) {
              console.log(`[s28aq-MISMATCH] bp#${self._wgBpSeq} ` +
                `vpInPass=${self._wgVpInPass} bakedRevZ=` +
                `${self._wgPassRevZAtBegin ? 1 : 0} nowRevZ=` +
                `${self._wgPassRevZ ? 1 : 0} (dcv stuck at ` +
                `${self._wgPassRevZAtBegin ? 0.0 : 1.0}, wrong for this draw)`);
            }
            // §28at DISCRIMINATING PROBE (JS-only, flag=true run):
            // BPFunctions emits near_T=max_depth,far_T=min_depth at
            // flag=true; at flag=false it emits (1-max_depth,
            // 1-min_depth) = exactly (1-near_T,1-far_T) for this SAME
            // draw. So we can compute the precise flag=false viewport
            // here without a rebuild and test the tracer's "zero-width
            // collapse" hypothesis vs "stays healthy [0,1]" (⇒ the real
            // coupling-(2) is the dcv/compare pairing, not BPFunctions).
            {
              const nT = f32[recWord + 5], fT = f32[recWord + 6];
              const nF = 1.0 - nT, fF = 1.0 - fT;
              const span = Math.abs(nF - fF);
              const cls = span < 1e-4 ? "ZEROWIDTH"
                : (nF > fF ? "inverted(needswap)" : "normal[0,1]");
              if ((self._wgAtN = (self._wgAtN || 0) + 1) <= 120) {
                console.log(`[s28at-vp] bp#${self._wgBpSeq} ` +
                  `vp#${self._wgVpInPass} revZ=${self._wgPassRevZ ? 1 : 0} ` +
                  `T(near=${nT.toFixed(5)},far=${fT.toFixed(5)}) ` +
                  `=> F(near=${nF.toFixed(5)},far=${fF.toFixed(5)}) ` +
                  `span=${span.toFixed(5)} ${cls}`);
              }
            }
            vpRescaled = f32[recWord + 3] !== vw || f32[recWord + 4] !== vh;
            vpDiagNoteViewport(f32[recWord + 5], f32[recWord + 6]);
            vpDiagNoteRect(f32[recWord + 1], f32[recWord + 2],
                           f32[recWord + 3], f32[recWord + 4],
                           vx, vy, vw, vh, passW, passH);
            let mn = f32[recWord + 5], mx = f32[recWord + 6];
            mn = Math.min(1, Math.max(0, mn));
            mx = Math.min(1, Math.max(0, mx));
            // §28ad: WebGPU/Dawn REJECTS minDepth>maxDepth (unlike
            // Vulkan's VkViewport) — confirmed validation error. So a
            // reversed viewport is impossible here; keep the swap to a
            // normal [mn,mx] viewport. Dolphin's reverse-Z
            // (bSupportsReversedDepthRange=true) must instead be
            // honoured via the depth CLEAR value (see depthClearValue
            // below) since the viewport sense cannot carry it.
            if (mn > mx) { const t = mn; mn = mx; mx = t; }
            pass.setViewport(vx, vy, vw, vh, mn, mx);
            lastAppliedViewport = [vx, vy, vw, vh, mn, mx];
            if (drawState) drawState.viewport = [vx, vy, vw, vh, mn, mx];
          }
          break;
        case WGPU_CMD_OP_CLEAR_RECT: {
          // Scissored clear inside the open pass: set the scissor, draw one
          // full-screen triangle with the clear colour/depth baked in, restore
          // the scissor. The pass is NOT torn down, which is what made the
          // core-side utility-draw version regress Wario World.
          if (!pass || passW <= 0) break;
          const cx = Math.min(u32[recWord + 1], passW - 1);
          const cy = Math.min(u32[recWord + 2], passH - 1);
          const cw = Math.max(1, Math.min(u32[recWord + 3], passW - cx));
          const ch = Math.max(1, Math.min(u32[recWord + 4], passH - cy));
          const crgba = u32[recWord + 5] >>> 0;
          // The producer sends the game's clear depth (~1.0), but this backend
          // runs the reverse-Z convention: BeginPass clears depth to dcv = 0.0
          // and every flippable pipeline compare is inverted to the greater
          // family. Writing 1.0 here means a fragment must reach depth >= 1.0
          // to pass, so every draw after the clear is rejected and the frame
          // goes black -- which is why this path was left off by default.
          // Use the same value the loadOp path uses.
          const cdepthRaw = f32[recWord + 6];
          const cdepth = GX_NATIVE_DEPTH ? cdepthRaw : 0.0;
          const cflags = u32[recWord + 7] >>> 0;
          // New records carry independent RGB/alpha enables. Legacy records
          // used bit 0 for all four color channels. Alpha-only clears build
          // masks for EFB-copy effects and must preserve the rendered RGB.
          const colorWriteMask = (cflags & 8)
            ? ((cflags & 1) ? 0x7 : 0) | ((cflags & 4) ? 0x8 : 0)
            : ((cflags & 1) ? 0xF : 0);
          if (DIAG_DEPTH_TRACE && self._wgDt && self._wgDt.armed &&
              passFbId === self._wgEfbColorId) {
            if (cflags & 2) {
              dtraceSplit(`before clearrect(${cx},${cy} ${cw}x${ch}) flags=${cflags} depth=${cdepth} ` +
                `vpz=${lastAppliedViewport ? lastAppliedViewport[4] + "," + lastAppliedViewport[5] : "default"}`);
            }
            self._wgDt.clears++;
          }
          const cpipe = ensureClearPipeline(dev, passColorFmt, passDepthFmt,
                                            colorWriteMask, (cflags & 2) !== 0,
                                            crgba, cdepth);
          if (!cpipe) break;
          try {
            // The clear triangle's depth goes through the viewport transform
            // like any other fragment: window z = minDepth + z * (maxDepth -
            // minDepth). Mario Kart Wii's frame-start clear arrives while its
            // HUD viewport z(0.89,0.99) is active, so a "0.0" clear wrote 0.89
            // across the whole EFB -- a plane NEARER than the entire world
            // band z(0.00,0.84) under reverse-Z. Every world fragment then
            // failed greater-equal and the world was black, while the HUD at
            // >= 0.89 passed. Measured with DIAG_DEPTH_TRACE: 0.89 at every
            // viewport texel right after the clear with only non-writing
            // draws in between, and a control write of 0.5 under the world
            // viewport landing as 0.42. Clear through a full [0,1] range and
            // put the game's viewport back.
            // The triangle must also cover the full attachment: a clear
            // outside the game's viewport otherwise receives no fragments,
            // even when its scissor and depth are correct. Skip redundant
            // viewport calls only for the full-pass [0,1] viewport (important
            // for Wario World's thousands of clears).
            const vpFix = CLEARRECT_FULL_VIEWPORT && lastAppliedViewport &&
              !(lastAppliedViewport[0] === 0 && lastAppliedViewport[1] === 0 &&
                lastAppliedViewport[2] === passW && lastAppliedViewport[3] === passH &&
                lastAppliedViewport[4] === 0 && lastAppliedViewport[5] === 1);
            if (vpFix) {
              pass.setViewport(0, 0, passW, passH, 0, 1);
            }
            pass.setScissorRect(cx, cy, cw, ch);
            pass.setPipeline(cpipe);
            pass.draw(3, 1, 0, 0);
            if (vpFix) pass.setViewport(...lastAppliedViewport);
            // Restore the scissor the game had set, so following draws are
            // unaffected. Restoring the full pass instead un-scissored every
            // draw until the game next changed its scissor.
            if (lastAppliedScissor) pass.setScissorRect(...lastAppliedScissor);
            else pass.setScissorRect(0, 0, passW, passH);
            self._wgClearRectN = (self._wgClearRectN || 0) + 1;
            if (!vpDiagDone) {
              const frac = Math.round((100 * cw * ch) / (passW * passH));
              // Ordering is what matters: as a loadOp the clear ran at pass
              // begin, but as a draw it lands wherever the game issued it. A
              // large clear AFTER the world draws wipes them.
              // cdepth is the producer's clear depth. The loadOp path ignores
              // it and writes the reverse-Z convention value (dcv = 0.0); if
              // ClearRect writes something else, every later draw is depth
              // tested against the wrong reference.
              const key = `rect(${cx},${cy} ${cw}x${ch}) = ${frac}% flags=${cflags} ` +
                `depth=${cdepth} raw=${cdepthRaw} afterEfbDraws=${vpDiagDrawsTotalEfb}`;
              vpDiagClearRects.set(key, (vpDiagClearRects.get(key) || 0) + 1);
            }
          } catch (e) {
            recordRendererError("validation", `clearrect: ${e?.message || e}`);
          }
          // The clear replaced the bound pipeline, so the next game draw must
          // re-issue its own. passHasPipe is the flag the draw path checks;
          // leaving it set would run that draw with the clear pipeline.
          passHasPipe = false;
          passNeedsVertexBuffer = false;
          self._wgCurPipe = 0;
          break;
        }
        case WGPU_CMD_OP_SET_SCISSOR:
          if (passFbId === 0) {
            self._wgLastSc = `${u32[recWord + 1]},${u32[recWord + 2]}` +
              `+${u32[recWord + 3]}x${u32[recWord + 4]}`;
          }
          if (frameCapActive()) frameCapPush(`  SCISSOR  fb#${passFbId} ${u32[recWord + 1]},${u32[recWord + 2]}` +
            `+${u32[recWord + 3]}x${u32[recWord + 4]}`);
          if (DIAG_EFB_TO_CANVAS && passFbId === 0) {
            self._wgBbScN = (self._wgBbScN || 0) + 1;
            if (self._wgBbScN <= 4 || (self._wgBbScN % 600) === 0) {
              console.log(`[bbsc] n=${self._wgBbScN} raw sc=(${u32[recWord + 1]},` +
                `${u32[recWord + 2]})+${u32[recWord + 3]}x${u32[recWord + 4]} ` +
                `pass=${passW}x${passH}`);
            }
          }
          if (pass && passW > 0 && !DIAG_RASTER_OPEN) {
            let sx = u32[recWord + 1], sy = u32[recWord + 2];
            let sw = u32[recWord + 3], sh = u32[recWord + 4];
            if (sx > passW) sx = passW;
            if (sy > passH) sy = passH;
            sw = Math.min(sw, passW - sx);
            sh = Math.min(sh, passH - sy);
            vpDiagNoteScissor(u32[recWord + 1], u32[recWord + 2],
                              u32[recWord + 3], u32[recWord + 4], sx, sy, sw, sh);
            pass.setScissorRect(sx, sy, sw, sh);
            lastAppliedScissor = [sx, sy, sw, sh];
            if (drawState) drawState.scissor = [sx, sy, sw, sh];
          }
          break;
        case WGPU_CMD_OP_DRAW:
          // §28j: require pipeline + ALL 3 bind groups valid, else
          // skipping prevents an invalid draw poisoning the whole
          // frame submit (→ black frame).
          if (!pass) {
            wgpuReplayClassifier?.recordStateOutsidePass({ op: "draw", recordIndex: read });
          }
          if (pass && passHasPipe && bgValid[0] && bgValid[1] && bgValid[2] &&
              (!passNeedsVertexBuffer || vertexBufferValid)) {
            diagTallyDrawTarget(passFbId, currentBackbufferSourceTextureId);
            vpDiagNoteDraw(passFbId, self._wgCurPipe);
            if (!vpDiagIsolateAllows(passFbId, self._wgCurPipe)) break;
            if (DIAG_ONLY_OPAQUE && passFbId === self._wgEfbColorId &&
                vpDiagIsBlended(self._wgCurPipe)) break;
            if (DIAG_SKIP_DEPTH_ALWAYS && vpDiagIsDepthAlways(self._wgCurPipe)) break;
            if (DIAG_SKIP_EMPTY_TEX && passFbId === self._wgEfbColorId) {
              const _l = vpDiagPipeVtx.get(self._wgCurPipe);
              const _wb = _l ? vpDiagFsTexBinding.get(_l.fsId) : undefined;
              const _bb = vpDiagBgTexByBinding.get(self._wgCurBg1);
              const _t = (_bb && _wb !== undefined) ? _bb[_wb] : undefined;
              if (_t !== undefined && vpDiagTexIsEmpty(_t)) break;
            }
            if (VP_SKIP_RESCALED && vpRescaled) {
              self._wgVpSkipN = (self._wgVpSkipN || 0) + 1;
              break;
            }
            frameCapPush(`  DRAW     fb#${passFbId}`);
            if (!vpDiagDone) vpDiagVerts += u32[recWord + 1] * Math.max(1, u32[recWord + 2]);
            pass.draw(u32[recWord + 1], u32[recWord + 2], u32[recWord + 3], 0);
            dtraceAfterDraw();
            webGpuExecStats.draw++; pd.draw++;
            wgpuReplayClassifier?.recordRealDraw({
              framebufferId: passFbId,
              indexed: false,
              pipelineId: self._wgCurPipe,
              efb: passFbId === self._wgEfbColorId,
              state: captureFirstEfbDrawState(false, {
                vertexCount: u32[recWord + 1],
                instanceCount: u32[recWord + 2],
                firstVertex: u32[recWord + 3]
              })
            });
          }
          else if (pass) {
            webGpuExecStats.skipDraw = (webGpuExecStats.skipDraw || 0) + 1;
          }
          break;
        case WGPU_CMD_OP_DRAW_INDEXED:
          if (!pass) {
            wgpuReplayClassifier?.recordStateOutsidePass({ op: "draw-indexed", recordIndex: read });
          }
          if (pass && !(passHasPipe && bgValid[0] && bgValid[1] && bgValid[2] &&
              (!passNeedsVertexBuffer || vertexBufferValid) && indexBufferValid)) {
            webGpuExecStats.skipDraw = (webGpuExecStats.skipDraw || 0) + 1;
          } else if (pass) {
            diagTallyDrawTarget(passFbId, currentBackbufferSourceTextureId);
            vpDiagNoteDraw(passFbId, self._wgCurPipe);
            if (!vpDiagIsolateAllows(passFbId, self._wgCurPipe)) break;
            if (DIAG_ONLY_OPAQUE && passFbId === self._wgEfbColorId &&
                vpDiagIsBlended(self._wgCurPipe)) break;
            if (DIAG_SKIP_DEPTH_ALWAYS && vpDiagIsDepthAlways(self._wgCurPipe)) break;
            if (DIAG_SKIP_EMPTY_TEX && passFbId === self._wgEfbColorId) {
              const _l = vpDiagPipeVtx.get(self._wgCurPipe);
              const _wb = _l ? vpDiagFsTexBinding.get(_l.fsId) : undefined;
              const _bb = vpDiagBgTexByBinding.get(self._wgCurBg1);
              const _t = (_bb && _wb !== undefined) ? _bb[_wb] : undefined;
              if (_t !== undefined && vpDiagTexIsEmpty(_t)) break;
            }
            if (VP_SKIP_RESCALED && vpRescaled) {
              self._wgVpSkipN = (self._wgVpSkipN || 0) + 1;
              break;
            }
            frameCapPush(`  DRAW     fb#${passFbId}`);
            if (!vpDiagDone) {
              vpDiagIdx += u32[recWord + 1] * Math.max(1, u32[recWord + 2]);
              vpDiagNoteIndexedDraw(u32[recWord + 1], u32[recWord + 3], u32[recWord + 4]);
            }
            pass.drawIndexed(u32[recWord + 1], u32[recWord + 2],
                             u32[recWord + 3], u32[recWord + 4], 0);
            dtraceAfterDraw();
            webGpuExecStats.drawIdx++; pd.drawIdx++;
            wgpuReplayClassifier?.recordRealDraw({
              framebufferId: passFbId,
              indexed: true,
              pipelineId: self._wgCurPipe,
              efb: passFbId === self._wgEfbColorId,
              state: captureFirstEfbDrawState(true, {
                indexCount: u32[recWord + 1],
                instanceCount: u32[recWord + 2],
                firstIndex: u32[recWord + 3],
                baseVertex: u32[recWord + 4]
              })
            });
            if ((self._wgDi = (self._wgDi || 0) + 1) <= 5) {
              console.log(`[webgpu-exec] DRAW_INDEXED#${self._wgDi} ` +
                `idx=${u32[recWord + 1]} inst=${u32[recWord + 2]} ` +
                `firstIdx=${u32[recWord + 3]} baseVtx=${u32[recWord + 4]}`);
            }
            if (!wgpuDeepReplayDiagnostics) break;
            // §28-vtxdata: dark-menu probe — for the menu textured
            // pipeline (stride 20, TexCoord0 @location(8) float32x2
            // @offset 12) read the uploaded per-vertex texcoord bytes.
            // All-zero ⇒ GX position-texgen (VertexLoader writes 0
            // UVs; UV must come from VS texgen/posttransform) ⇒ the
            // dark is degenerate uv≈0 → atlas-corner. Non-zero ⇒ the
            // posttransform screen→UV mapping is the defect.
            if (self._wgVbSnap &&
                (self._wgVtxProbeN = (self._wgVtxProbeN || 0)) < 60) {
              const vtpl = webGpuObjects.pipeTpl.get(self._wgCurPipe);
              const vbs = vtpl && vtpl.desc && vtpl.desc.vertex &&
                vtpl.desc.vertex.buffers;
              // §28-vtxdata GENERALISED: match ANY vertex-buffer layout
              // carrying a TexCoord0 attr @location(8) float32x2 (the
              // menu VS texcoord input) — ANY stride/offset (the §28ap
              // menu pipes vary: stride 20 tc@12, or L5:unorm8x4 + tc@16
              // etc). Read using the layout's real arrayStride + the
              // attr's real offset, and pos from @location(0) if present.
              let vb = null, tcA = null, posA = null;
              if (vbs) {
                for (const b of vbs) {
                  const t = b.attributes.find((a) =>
                    a.shaderLocation === 8 && a.format === "float32x2");
                  if (t) { vb = b; tcA = t;
                    posA = b.attributes.find((a) => a.shaderLocation === 0);
                    break; }
                }
              }
              if (vb && tcA) {
                const stride = vb.arrayStride;
                const baseVtx = u32[recWord + 4];
                const batchOff = baseVtx * stride;
                let s = null, sOff = 0;
                for (const [doff, sn] of self._wgVbSnap) {
                  if (batchOff >= doff &&
                      batchOff < doff + sn.byteLength) { s = sn; sOff = doff; break; }
                }
                if (s) {
                  self._wgVtxProbeN++;
                  const lb = batchOff - sOff;
                  const nV = Math.min(4,
                    Math.floor((s.byteLength - lb) / stride));
                  const dv = new DataView(s.buffer, s.byteOffset + lb);
                  const tcv = [], pov = [];
                  for (let v = 0; v < nV; v++) {
                    const to = v * stride + tcA.offset;
                    tcv.push(`(${dv.getFloat32(to, true).toFixed(4)},` +
                      `${dv.getFloat32(to + 4, true).toFixed(4)})`);
                    if (posA && posA.format.indexOf("float32") === 0) {
                      const po = v * stride + posA.offset;
                      pov.push(`(${dv.getFloat32(po, true).toFixed(1)},` +
                        `${dv.getFloat32(po + 4, true).toFixed(1)},` +
                        `${dv.getFloat32(po + 8, true).toFixed(1)})`);
                    }
                  }
                  console.log(`[s28-vtxdata] pipe=${self._wgCurPipe} ` +
                    `fs#${vtpl.fsId} stride=${stride} tcOff=${tcA.offset} ` +
                    `baseVtx=${baseVtx} idx=${u32[recWord + 1]} ` +
                    `tc=[${tcv.join(",")}] pos=[${pov.join(",")}]`);
                }
              }
            }
            // [s28av-texuv] DECISIVE dark-menu probe: the menu FS
            // computes uv = vtxTC / (I_TEXDIMS*128) (Dolphin texel*128
            // fixed-point convention). [s28-vtxdata] PROVED the WebGPU
            // VertexLoader delivers [0,1]-normalised UVs, so this
            // division collapses uv→~0 → samples the atlas corner →
            // dark menu. Confirm: parse the FS for the member_3*128
            // pattern, read live I_TEXDIMS from the PSBlock snapshot,
            // compute the effective UV. Capped 8.
            if ((self._wgAvN = (self._wgAvN || 0)) < 8) {
              const aT = webGpuObjects.pipeTpl.get(self._wgCurPipe);
              const aB = aT && aT.desc && aT.desc.vertex &&
                aT.desc.vertex.buffers;
              let aTc = null, aStride = 0;
              if (aB) for (const b of aB) {
                const t = b.attributes.find((a) =>
                  a.shaderLocation === 8 && a.format === "float32x2");
                if (t) { aTc = t; aStride = b.arrayStride; break; }
              }
              if (aTc && aT && self._wgFsSrc &&
                  self._wgFsSrc[aT.fsId] !== undefined) {
                self._wgAvN++;
                const flat = self._wgFsSrc[aT.fsId].replace(/\s+/g, " ");
                const hasNorm = flat.indexOf("member_3") >= 0 &&
                  flat.indexOf("128") >= 0;
                const sm = flat.match(/textureSample\w*\s*\([^;]{0,180}/);
                // §28ba: which @binding does the menu FS actually
                // sample? dolphin_fn_1_ is called with (…, global_1,
                // global_2, …) ⇒ the sampled texture = `global_1`.
                // Parse its @group/@binding + list all texture_2d_array
                // bindings, so we can cross-check [s28-texfs]'s b0..b7
                // (b0=tex#76 atlas, b1=tex#65 640×480 EFB backdrop).
                const g1m = flat.match(
                  /@group\((\d+)\)\s*@binding\((\d+)\)\s*var\s+global_1\s*:/);
                const texBinds = (flat.match(
                  /@binding\(\d+\)\s*var\s+\w+\s*:\s*texture_2d_array/g)
                  || []).join(" | ");
                console.log(`[s28ba-bind] fs#${aT.fsId} ` +
                  `global_1@group${g1m ? g1m[1] : "?"}` +
                  `/binding${g1m ? g1m[2] : "?"} ` +
                  `texDecls=[${texBinds}]`);
                // [s28be] DECISIVE: read the VS UBO at the CORRECT C++
                // offsets — texmatrices@896, posttransformmatrices@2816
                // (the §28an baked probe read byte1280=transformmatrices,
                // so posttransform was NEVER verified). UV =
                // posttransform(texmtx·texcoordAttr). If postP0/P1≈0 ⇒
                // ROOT=A (posttransform delivered zero → UV→0 →
                // transparent atlas → dark).
                if (self._wgVsSnap && self._wgVsSnapLen >= 2864) {
                  const vv = new DataView(self._wgVsSnap.buffer,
                    self._wgVsSnap.byteOffset);
                  const r4 = (o) => [0, 4, 8, 12].map((d) =>
                    vv.getFloat32(o + d, true).toFixed(3));
                  const p0 = r4(2816), p1 = r4(2832), p2 = r4(2848);
                  const tm0 = r4(896), tm1 = r4(912);
                  const pmag = Math.abs(+p0[0]) + Math.abs(+p0[1]) +
                    Math.abs(+p1[0]) + Math.abs(+p1[1]);
                  const tmag = Math.abs(+tm0[0]) + Math.abs(+tm0[1]) +
                    Math.abs(+tm1[0]) + Math.abs(+tm1[1]);
                  console.log(`[s28be-vsubo] fs#${aT.fsId} ` +
                    `texm0=[${tm0}] texm1=[${tm1}] ` +
                    `postP0=[${p0}] postP1=[${p1}] postP2=[${p2}]`);
                  if (pmag < 0.01)
                    console.log(`[s28be-VERDICT] ROOT=A: ` +
                      `posttransformmatrices @byte2816 are ZERO ⇒ ` +
                      `UV→0 → transparent atlas → dark menu. (§28an's ` +
                      `"post real" read byte1280=transformmatrices.)`);
                  else if (tmag < 0.01)
                    console.log(`[s28be-VERDICT] texmatrices @896 ZERO ` +
                      `(unexpected — §28an said identity).`);
                  else
                    console.log(`[s28be-VERDICT] post+texm BOTH ` +
                      `populated (pmag=${pmag.toFixed(3)} ` +
                      `tmag=${tmag.toFixed(3)}) — root is elsewhere; ` +
                      `dump effective UV next.`);
                }
                // §28bd: dump the menu VS texgen — does texture_coord_0
                // derive from rawpos (SourceRow::Geom) or rawtex0
                // (SourceRow::Tex)? and is the posttransform (P0/P1/P2,
                // I_POSTTRANSFORMMATRICES) applied? This pins WHICH
                // input the wrong-atlas UV (§28bc) comes from.
                if (self._wgVsSrc && aT.vsId !== undefined &&
                    self._wgVsSrc[aT.vsId] !== undefined &&
                    !self._wgBdVs) {
                  self._wgBdVs = true;
                  const vf = self._wgVsSrc[aT.vsId].replace(/\s+/g, " ");
                  console.log(`[s28bd-vs] vs#${aT.vsId} len=${vf.length} ` +
                    `nTexSampleBiasFS=na — full VS WGSL follows:`);
                  for (let o = 0; o < vf.length; o += 700)
                    console.log(`[s28bd-vs ${o}] ${vf.slice(o, o + 700)}`);
                }
                let tdx = -1, tdy = -1, tdz = -1, tdw = -1;
                if (self._wgPsSnap && self._wgPsSnapLen >= 160) {
                  const pv = new DataView(self._wgPsSnap.buffer,
                    self._wgPsSnap.byteOffset);
                  tdx = pv.getInt32(144, true);   // texdims[0].x = width
                  tdy = pv.getInt32(148, true);   // texdims[0].y = height
                  tdz = pv.getInt32(152, true);   // [0].z = tc_scale_s
                  tdw = pv.getInt32(156, true);   // [0].w = tc_scale_t
                  // §28az: dump the TEV colour/konst PS-constants the
                  // menu FS combines the sample with (§28ay proved the
                  // TEV chain is the dominant collapse). [s28-creg]
                  // layout: I_COLORS@0 (4×int4), I_KCOLORS@64,
                  // I_ALPHA@128. If a register the TEV uses is ~0 ⇒
                  // the §28b-class PS-constant delivery is the root.
                  const r4 = (o) => `${pv.getInt32(o, true)},` +
                    `${pv.getInt32(o + 4, true)},${pv.getInt32(o + 8, true)},` +
                    `${pv.getInt32(o + 12, true)}`;
                  console.log(`[s28az-creg] fs#${aT.fsId} ` +
                    `C0=[${r4(0)}] C1=[${r4(16)}] C2=[${r4(32)}] ` +
                    `C3=[${r4(48)}] K0=[${r4(64)}] K1=[${r4(80)}] ` +
                    `K2=[${r4(96)}] K3=[${r4(112)}] A=[${r4(128)}]`);
                }
                let vU = NaN, vV = NaN;
                if (self._wgVbSnap) {
                  const off = u32[recWord + 4] * aStride;
                  for (const [doff, sn] of self._wgVbSnap) {
                    if (off >= doff && off + aStride <= doff + sn.byteLength) {
                      const dv = new DataView(sn.buffer,
                        sn.byteOffset + (off - doff));
                      vU = dv.getFloat32(aTc.offset, true);
                      vV = dv.getFloat32(aTc.offset + 4, true);
                      break;
                    }
                  }
                }
                // FULL effective sampled UV: texgen multiplies vtxTC by
                // (tc_scale .zw · 128), FS divides by (texdims .xy · 128)
                // ⇒ effUV = vtxTC · (.zw / .xy). The 128s cancel.
                const effU = (tdx > 0) ? vU * (tdz / tdx) : NaN;
                const effV = (tdy > 0) ? vV * (tdw / tdy) : NaN;
                console.log(`[s28av-texuv] pipe=${self._wgCurPipe} ` +
                  `fs#${aT.fsId} vs#${aT.vsId} hasNorm=${hasNorm ? 1 : 0} ` +
                  `td.xy=(${tdx},${tdy}) td.zw_scale=(${tdz},${tdw}) ` +
                  `vtxTC=(${vU.toFixed(5)},${vV.toFixed(5)}) ` +
                  `effUV=(${effU.toFixed(6)},${effV.toFixed(6)}) ` +
                  `sample=${sm ? sm[0].slice(0, 120) : "NONE"}`);
                if (!isNaN(effU)) {
                  if (Math.abs(effU) < 0.01 && Math.abs(effV) < 0.01 &&
                      !isNaN(vU) && Math.abs(vU) > 0.01) {
                    console.log(`[s28av-VERDICT] UV-COLLAPSE: vtxTC ` +
                      `(${vU.toFixed(3)},${vV.toFixed(3)}) × (tc_scale ` +
                      `${tdz},${tdw} / texdim ${tdx},${tdy}) → effUV≈0. ` +
                      (tdz <= 1 || tdw <= 1
                        ? `tc_scale .zw≈${tdz},${tdw} is NOT the texsize ` +
                          `(SetTexCoordChanged not delivering scale=texsize) ` +
                          `⇒ the .zw/tc-scale path is the defect.`
                        : `tc_scale present but mismatched vs texdim ` +
                          `(${tdz},${tdw} vs ${tdx},${tdy}).`));
                  } else if (Math.abs(effU - vU) < 0.05 &&
                             Math.abs(effV - vV) < 0.05) {
                    console.log(`[s28av-VERDICT] effUV≈vtxTC ` +
                      `(${effU.toFixed(3)},${effV.toFixed(3)}) — round-trip ` +
                      `OK. Dark root is NOT UV units; check texture ` +
                      `content / FS TEV / blend.`);
                  } else {
                    console.log(`[s28av-VERDICT] effUV=` +
                      `(${effU.toFixed(3)},${effV.toFixed(3)}) vs vtxTC=` +
                      `(${vU.toFixed(3)},${vV.toFixed(3)}) — partial ` +
                      `mismatch; tc_scale=${tdz},${tdw} texdim=${tdx},${tdy}.`);
                  }
                }
              }
            }
            // §28: at difficulty-select the backdrop is black. For the
            // EFB colour pass, tally the DISTINCT (pipeline, sampled
            // group-1 texture, size, idxCount) set so we can tell what
            // the backdrop draw samples vs the glyph/text draws.
            if (self._wgEfbColorId && passFbId === self._wgEfbColorId) {
              const idx = u32[recWord + 1];
              const bg1 = self._wgCurBg1;
              const allb = (self._wgBgAll && bg1 != null)
                ? (self._wgBgAll[bg1] || "?") : "?";
              const tpl = webGpuObjects.pipeTpl.get(self._wgCurPipe);
              const pdbg = tpl ? (tpl.s28dbg || "?") : "?";
              // §28: the backdrop draw = b0 is the 1x1 dummy + large
              // index count. Capture its FS id and dump that FS once.
              if (tpl && idx >= 40 && allb.indexOf(" b0=tex#57(1x1)") === 0
                  && !self._wgBdFsDone && self._wgFsSrc &&
                  self._wgFsSrc[tpl.fsId] !== undefined) {
                self._wgBdFsDone = true;
                const w = self._wgFsSrc[tpl.fsId];
                console.log(`[s28-bdfs] pipe=${self._wgCurPipe} ` +
                  `fs#${tpl.fsId} len=${w.length} ${pdbg}`);
                // Parse the WGSL: log only the decisive lines —
                // textureSample* calls (which binding the backdrop
                // samples), discards/alpha-test, and the final
                // @location(0) output assignment.
                const flat = w.replace(/\s+/g, " ");
                // §28e: dump the WHOLE TEV chain (every dolphin_fn_*),
                // not just fn_4_, to see which TEV input (vertex color
                // vs I_COLORS / konst / I_KCOLORS UBO reg) collapses
                // the untextured backdrop to black. Start at the first
                // "fn dolphin_fn_" so fn_0..fn_4 are all captured.
                const fi = flat.indexOf("fn dolphin_fn_");
                console.log(`[s28-bdfsX] fnAt=${fi} len=${flat.length} ` +
                  `nSample=${(flat.match(/textureSample/g) || []).length}`);
                // Capture the global UBO struct decl too (member_N ↔
                // I_COLORS/I_KCOLORS/konst byte mapping).
                const sd = flat.indexOf("struct type_");
                if (sd >= 0)
                  console.log(`[s28-bdfsS] ${flat.slice(sd, sd + 900)}`);
                if (fi >= 0)
                  for (let o = fi; o < flat.length; o += 700)
                    console.log(`[s28-fn4 ${o - fi}] ${flat.slice(o, o + 700)}`);
                // §28e: dump the paired VS — trace how color0 (the
                // location(0) varying the FS returns) is produced: a
                // per-vertex @location(5) attr, or a lighting/material
                // UBO constant (which would be 0 ⇒ black backdrop).
                if (self._wgVsSrc &&
                    self._wgVsSrc[tpl.vsId] !== undefined) {
                  const v = self._wgVsSrc[tpl.vsId].replace(/\s+/g, " ");
                  const vm = v.indexOf("fn main(");
                  console.log(`[s28-vs] vs#${tpl.vsId} len=${v.length} ` +
                    `sig=${v.slice(vm, v.indexOf("{", vm))}`);
                  // The VS color-channel synthesis: log lines that
                  // write the colour varying / read material lights.
                  const ci = v.indexOf("fn dolphin_fn_");
                  if (ci >= 0)
                    for (let o = ci; o < v.length; o += 700)
                      console.log(`[s28-vsfn ${o - ci}] ${v.slice(o, o + 700)}`);
                }
              }
              // §28f: also dump the dominant TEXTURED difficulty-select
              // draw — b0 a REAL texture (not the 1x1 dummy), big idx
              // (the backdrop/roster composite), binding a 640x480
              // EFB-copy at b1. This is the draw that outputs ~0 into
              // tex#14 while sampling the black copy; dump its FS
              // textureSample* calls + final return to see if it
              // multiplies the (black) b1 copy (feedback) or collapses
              // via alpha/texcoord.
              // §28ag: dump each DISTINCT textured EFB FS once (capped),
              // not one-shot — so the MENU pipeline (fs#16081, dark 1P
              // menu) is captured too, not just difficulty-select's.
              self._wgTexFsSet = self._wgTexFsSet || new Set();
              if (tpl && idx >= 40 &&
                  allb.indexOf(" b0=tex#57(1x1)") !== 0 &&
                  allb.indexOf("(640x480)") >= 0 &&
                  self._wgFsSrc && self._wgFsSrc[tpl.fsId] !== undefined &&
                  !self._wgTexFsSet.has(tpl.fsId) &&
                  self._wgTexFsSet.size < 8) {
                self._wgTexFsSet.add(tpl.fsId);
                const w = self._wgFsSrc[tpl.fsId];
                const flat = w.replace(/\s+/g, " ");
                console.log(`[s28-texfs] pipe=${self._wgCurPipe} ` +
                  `fs#${tpl.fsId} vs#${tpl.vsId} len=${w.length} ${pdbg} ` +
                  `bg1=${allb} nSample=` +
                  `${(flat.match(/textureSample/g) || []).length}`);
                const fi = flat.indexOf("fn dolphin_fn_");
                if (fi >= 0)
                  for (let o = fi; o < flat.length; o += 700)
                    console.log(`[s28-tfn ${o - fi}] ${flat.slice(o, o + 700)}`);
                // §28aj: dump the PSBlock UBO struct decls so we can map
                // Naga member_N → byte offset and compare to the C++
                // PixelShaderConstants layout (colors@0, kcolors@64,
                // alpha@128, texdims@144…). The §28ah probe proved the
                // VALUES are correct at source; a std140 member-offset
                // mismatch here (the §28b/c class) would make the FS
                // read colors[1]/kcolors[0]/texdims from the wrong
                // bytes → black menu. JS-only (FS already captured).
                // §28ak: queue this menu textured draw's b0 (the
                // sampled UI/glyph texture) for the [webgpu-DIAG-cpy]
                // readback — decides texture CONTENT empty (upload
                // bug) vs populated (⇒ texcoord/texdim sampling bug).
                {
                  const m = /b0=tex#(\d+)/.exec(allb);
                  if (m) {
                    self._wgCpyExtra = self._wgCpyExtra || new Set();
                    if (self._wgCpyExtra.size < 24)
                      self._wgCpyExtra.add(parseInt(m[1], 10));
                    console.log(`[s28ak-b0] fs#${tpl.fsId} b0=tex#${m[1]} queued`);
                  }
                }
                let sd = flat.indexOf("struct type_");
                for (let k = 0; k < 6 && sd >= 0; k++) {
                  const end = flat.indexOf("}", sd);
                  console.log(`[s28aj-struct ${k}] ` +
                    flat.slice(sd, end >= 0 ? end + 1 : sd + 700));
                  sd = flat.indexOf("struct type_", sd + 1);
                }
                // The @group/@binding decls (which binding is the
                // PSBlock vs textures) + the global var lines.
                const gb = flat.match(/@group\([0-9]\)\s*@binding\([0-9]+\)\s*var<?[^;]*;/g);
                if (gb) console.log(`[s28aj-bind] ${gb.join(" || ")}`);
                // §28al: dump the paired menu VS texgen — the FS UV
                // (param_8/param_9) is a VS output varying. A zero/
                // wrong texgen here makes a populated texture sample
                // ≈0 → black menu (§28ak). JS-only (VS WGSL captured).
                if (self._wgVsSrc && self._wgVsSrc[tpl.vsId] !== undefined) {
                  const v = self._wgVsSrc[tpl.vsId].replace(/\s+/g, " ");
                  const vm = v.indexOf("fn main(");
                  console.log(`[s28al-vs] vs#${tpl.vsId} len=${v.length} ` +
                    `nLoc=${(v.match(/@location\(/g) || []).length} ` +
                    `sig=${v.slice(vm, v.indexOf("{", vm) + 1)}`);
                  // texgen lives in the dolphin_fn chain — dump it +
                  // the @location output assignments (the varyings the
                  // FS reads as param_8/param_9 texcoord/layer).
                  const ci = v.indexOf("fn dolphin_fn_");
                  if (ci >= 0)
                    for (let o = ci; o < v.length; o += 700)
                      console.log(`[s28al-vsfn ${o - ci}] ${v.slice(o, o + 700)}`);
                  // §28am: dump the VS UBO struct decls so member_9/
                  // member_12 (the texgen matrices the UV depends on)
                  // map to VertexShaderConstants fields (texmatrices@
                  // /posttransformmatrices). JS-only, no rebuild.
                  let vd = v.indexOf("struct type_");
                  for (let k = 0; k < 4 && vd >= 0; k++) {
                    const ve = v.indexOf("}", vd);
                    console.log(`[s28am-vstruct ${k}] ` +
                      v.slice(vd, ve >= 0 ? ve + 1 : vd + 700));
                    vd = v.indexOf("struct type_", vd + 1);
                  }
                  const vgb = v.match(/@group\([0-9]\)\s*@binding\([0-9]+\)\s*var<?[^;]*;/g);
                  if (vgb) console.log(`[s28am-vbind] ${vgb.join(" || ")}`);
                }
              }
              const key = `pipe${self._wgCurPipe}|idx${idx}|${pdbg}|${allb}`;
              self._wgEfbDraws = self._wgEfbDraws || new Map();
              self._wgEfbDraws.set(key, (self._wgEfbDraws.get(key) || 0) + 1);
              self._wgEfbDrawsN = (self._wgEfbDrawsN || 0) + 1;
              if ((self._wgEfbDrawsN % 20000) === 0) {
                const rows = [...self._wgEfbDraws.entries()]
                  .sort((a, b) => b[1] - a[1]).slice(0, 14)
                  .map(([k, v]) => `${k}=${v}`);
                console.log(`[s28-efbdraws] n=${self._wgEfbDrawsN} ` +
                  rows.join("  "));
                self._wgEfbDraws.clear();
              }
            }
          }
          break;
        case WGPU_CMD_OP_END_PASS:
          endPass("explicit", read);
          break;
        case WGPU_CMD_OP_SUBMIT_PRESENT:
          frameCapPush("PRESENT");
          vpDiagPresent();
          if ((self._wgPresentCount || 0) % 600 === 0) {
            const miss = self._wgDummyMissing || 0;
            const fmt = self._wgDummyFormat || 0;
            const cr = self._wgClearRectN || 0;
            if (cr) console.log(`[clearrect] executed=${cr} pipelines=${WGPU_CLEAR_PIPELINES.size}`);
            if (miss || fmt) {
              console.log(`[dummytex] missing=${miss} unfilterable=${fmt} ` +
                `missingIds=${[...(self._wgDummyMissingIds || [])].slice(0, 8).join(",")} ` +
                `formats=${[...(self._wgDummyFormats || [])].join(",")}`);
            }
          }
          if (DIAG_TEX_READBACK && !vpDiagReadbackDone &&
              (self._wgPresentCount || 0) >= 2500 && vpDiagLastPicks.length) {
            vpDiagReadbackDone = true;
            try {
              ensureEnc();
              const picks = vpDiagLastPicks;
              for (const [k] of picks) {
                const m = /tex#(\d+)/.exec(k);
                if (!m) continue;
                const e = webGpuObjects.textures.get(Number(m[1]));
                if (e) diagReadTexture(dev, enc, e, k.slice(0, 60), "texcheck");
              }
            } catch (e) {
              console.log("[vpdiag] readback queue failed: " + (e && e.message));
            }
          }
          if (DIAG_DEPTH_READBACK && !self._wgDepthRbDone &&
              (self._wgPresentCount || 0) >= 2500 && self._wgEfbDepthId) {
            self._wgDepthRbDone = true;
            try {
              ensureEnc();
              diagReadDepth(dev, enc, webGpuObjects.textures.get(self._wgEfbDepthId),
                            "after-frame");
            } catch (e) { console.log("[vpdiag] depth rb failed: " + (e && e.message)); }
          }
          frameCapFinish();
          self._wgPresentCount = (self._wgPresentCount || 0) + 1;
          diagFrameEnd();

          wgpuReplayClassifier?.recordPresentCommand({ recordIndex: read });
          if (!endPass("submit-present", read) && wgpuDirtyRangeProjectionActive) {
            wgpuDirtyRangeProjection.recordSegmentBoundary({
              kind: "submit-present",
              complete: true
            });
          }
          if (DIAG_DEPTH_TRACE) {
            const pn = self._wgPresentCount || 0;
            const dt = self._wgDt;
            if (dt && dt.armed) {
              dt.armed = false;
              console.log(`[dtrace] frame done: efbDraws=${dt.draws} depthWrites=${dt.writes} ` +
                `clearRects=${dt.clears} efbPasses=${dt.passSeq} splits=${dt.splits} ` +
                `readbacksIssued=${dt.issued}`);
              for (const [k, n] of [...dt.cmpTally.entries()].sort((a, b) => b[1] - a[1])) {
                console.log(`[dtrace]   ${String(n).padStart(4)}x ${k}`);
              }
            } else if (!dt && pn >= DTRACE_PRESENT && self._wgEfbColorId) {
              self._wgDt = { armed: true, draws: 0, writes: 0, clears: 0, passSeq: 0,
                             splits: 0, issued: 0, done: 0, cmpTally: new Map() };
              console.log(`[dtrace] armed for the frame after present #${pn}`);
            }
          }
          let presentAlreadySubmitted = false;
          const hardwareInputMarkerCoreFrame = api?.getFrame?.() ?? 0;
          const hardwareInputMarker = prepareInputVisualMarker(hardwareInputMarkerCoreFrame);
          let hardwareInputMarkerApplied = false;
          const applyHardwareInputMarker = () => {
            if (hardwareInputMarkerApplied || !hardwareInputMarker || !lastBackbufferTexture) {
              return hardwareInputMarkerApplied;
            }
            try {
              hardwareInputMarkerApplied = encodeHardwareInputMarker(
                ensureEnc(),
                lastBackbufferTexture,
                renderGpu.format,
                hardwareInputMarker
              );
            } catch (error) {
              recordRendererError("input-marker-encode", error?.message || error);
            }
            return hardwareInputMarkerApplied;
          };
          // Keep the sample on the same command encoder and before the
          // optional input marker so it represents the unmodified game
          // output submitted by this hardware present.
          const visualCadenceSlot = wgpuVisualCadenceEnabled && lastBackbufferTexture
            ? encodeWgpuVisualCadence(ensureEnc(), lastBackbufferTexture)
            : null;
          // ?efbdiag=1 blits the EFB; ?efbdiag=2 blits the XFB entry the game
          // last presented. The second answers whether that entry holds the
          // scene WITHOUT a readback -- readbacks in this pipeline have already
          // produced one confirmed artifact (an all-zero EFB caused by encoder
          // batching, not by an empty EFB), so a visual check is worth more
          // than another grid comparison here.
          const _diagSrcId = DIAG_EFB_TO_CANVAS === 2
            ? (wgpuLastBackbufferSourceTextureId || 0)
            : (self._wgEfbColorId || 0);
          if (DIAG_EFB_TO_CANVAS && _diagSrcId) {
            const efb = webGpuObjects.textures.get(_diagSrcId);
            const bs = efb ? ensureBlitState() : null;
            const dpipe = bs ? ensureBlitPipeline(renderGpu.format) : null;
            if (efb && dpipe) {
              try {
                ensureEnc();
                const ubo = dev.createBuffer({ size: 16, usage: 0x40 | 0x8,
                                               mappedAtCreation: true });
                new Float32Array(ubo.getMappedRange()).set([1, 1, 0, 0]);
                ubo.unmap();
                const ev = efb.tex.createView({ dimension: "2d-array",
                  baseArrayLayer: 0, arrayLayerCount: 1 });
                const dbg = dev.createBindGroup({ layout: bs.bgl, entries: [
                  { binding: 0, resource: ev },
                  { binding: 1, resource: bs.sampler },
                  { binding: 2, resource: { buffer: ubo } } ] });
                const ctex = renderGpu.context.getCurrentTexture();
                const rp = enc.beginRenderPass({ label: "DIAG-efb-to-canvas",
                  colorAttachments: [{ view: ctex.createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear", storeOp: "store" }] });
                rp.setPipeline(dpipe);
                rp.setViewport(0, 0, ctex.width, ctex.height, 0, 1);
                rp.setBindGroup(0, dbg);
                rp.draw(3);
                rp.end();
                if (!self._wgDiagOnce) {
                  self._wgDiagOnce = true;
                  console.log(`[webgpu-DIAG] EFB ${self._wgEfbColorId} ` +
                    `${efb.format} ${efb.tex.width}x${efb.tex.height} -> ` +
                    `canvas ${ctex.width}x${ctex.height}`);
                }
              } catch (e) {
                if (!self._wgDiagErr) {
                  self._wgDiagErr = true;
                  console.log(`[webgpu-DIAG] threw: ${e?.message || e}`);
                }
              }
            }
          }
          // [webgpu-DIAG-cpy] PERIODIC readback of the EFB colour tex
          // (self._wgEfbColorId — what DIAG_EFB_TO_CANVAS shows) AND the
          // EFB-copy targets, sampled across boot→title→menu→demo so we
          // can correlate "EFB black during menus" vs "EFB-copy content"
          // with the screenshot timeline (tag p=<present>). Encoded into
          // `enc` before submit; mapAsync after. COPY_SRC on all (kTexUsage).
          {
            const P = webGpuExecStats.present;
            const tick = (P >= 300) ? Math.floor((P - 300) / 350) : -1;
            self._wgCpyTick = (self._wgCpyTick == null) ? -1 : self._wgCpyTick;
            // §28x: the present-gated tick caps at <9 so it never
            // fires deep in the A-only black-3D dwell (P ≫). Add a
            // WALL-CLOCK periodic trigger (every 6 s, capped 20 fires)
            // so the EFB/copy readback runs throughout ANY run —
            // bisects whether the 3D scene's draws sample black
            // EFB-copies (feedback chain) vs produce black directly.
            const _wcNow = Date.now();
            self._wgCpyWcT0 = self._wgCpyWcT0 || _wcNow;
            const _wcTick = Math.floor((_wcNow - self._wgCpyWcT0) / 6000);
            self._wgCpyWcTick = (self._wgCpyWcTick == null)
              ? -1 : self._wgCpyWcTick;
            const _preOk = wgpuDeepReplayDiagnostics &&
              tick >= 0 && tick !== self._wgCpyTick && tick < 9;
            const _wcOk = wgpuDeepReplayDiagnostics &&
              _wcTick !== self._wgCpyWcTick && _wcTick < 20;
            const _classifyOk = Boolean(
              wgpuReplayClassifier?.needsPostDrawEfbReadback(P)
            ) && !wgpuClassifierEfbReadbackPending;
            const _backbufferOk = Boolean(
              wgpuReplayClassifier?.needsPresentationReadback("backbuffer", P)
            ) && !wgpuClassifierBackbufferReadbackPending;
            // Input-to-visible diagnostics need the actual hardware output,
            // not the stale CPU XFB hash left behind after WGPU takes canvas
            // ownership.  Establish one baseline, then sample only while an
            // input generation is pending.  This is opt-in because a mapped
            // GPU readback is intentionally too expensive for normal play.
            const _inputBackbufferOk = inputReadbackDiagnostics &&
              lastBackbufferTexture && !wgpuInputBackbufferReadbackPending &&
              (!wgpuInputVisualBaselineReady || inputVisibleLatencyTracker.hasPending());
            const _sourceOk = lastBackbufferSourceTextureId > 0 && Boolean(
              wgpuReplayClassifier?.needsPresentationReadback("xfb", P)
            ) && !wgpuClassifierXfbReadbackPending;
            if (_preOk || _wcOk || _classifyOk || _backbufferOk ||
                _sourceOk || _inputBackbufferOk) {
            if (_preOk) self._wgCpyTick = tick;
            if (_wcOk) self._wgCpyWcTick = _wcTick;
            const pending = [];
            const ids = (_preOk || _wcOk)
              ? new Set(self._wgCopyTargets || [])
              : new Set();
            if ((_classifyOk || _preOk || _wcOk) && self._wgEfbColorId) {
              ids.add(self._wgEfbColorId);
            }
            if (_sourceOk) ids.add(lastBackbufferSourceTextureId);
            if ((_preOk || _wcOk) && self._wgXfbId) ids.add(self._wgXfbId);
            // §28: also read back the backdrop's sampled b1/b2 textures.
            if ((_preOk || _wcOk) && self._wgCpyExtra) {
              for (const e of self._wgCpyExtra) ids.add(e);
            }
            for (const cid of ids) {
              const ct = webGpuObjects.textures.get(cid);
              if (!ct || ct.format.startsWith("depth")) continue;
              try {
                ensureEnc();
                const w = cid === lastBackbufferSourceTextureId
                  ? Math.min(ct.tex.width, 640) : ct.tex.width;
                const h = cid === lastBackbufferSourceTextureId
                  ? Math.min(ct.tex.height, 480) : ct.tex.height;
                const bpr = Math.ceil(w * 4 / 256) * 256;
                const rb = dev.createBuffer({ size: bpr * h,
                  usage: 0x1 | 0x8 });           // MAP_READ | COPY_DST
                enc.copyTextureToBuffer(
                  { texture: ct.tex },
                  { buffer: rb, bytesPerRow: bpr, rowsPerImage: h },
                  { width: w, height: h, depthOrArrayLayers: 1 });
                const kind = cid === self._wgEfbColorId ? "efb" :
                  cid === lastBackbufferSourceTextureId ? "xfb" : "copy";
                pending.push({ rb, bpr, w, h, framebufferId: cid, kind,
                  isEfb: cid === self._wgEfbColorId,
                  sourceTextureId: cid,
                  presentSequence: P,
                  classifierGeneration: wgpuReplayClassifierGeneration,
                  efbDrawCountAtEncode: cid === self._wgEfbColorId
                    ? wgpuReplayClassifier?.captureEfbDrawCount() ?? 0
                    : 0,
                  tag: `p=${P} tex#${cid}` +
                    (cid === self._wgEfbColorId ? "(EFB)"
                     : cid === self._wgXfbId ? "(XFB)" : "(copy)") +
                    ` ${w}x${h}` });
              } catch (e) {
                console.log(`[webgpu-DIAG-cpy] ${cid} enc threw ` +
                  `${e?.message || e}`);
              }
            }
            if ((_backbufferOk || _inputBackbufferOk) && lastBackbufferTexture) {
              try {
                ensureEnc();
                const w = lastBackbufferTexture.width;
                const h = lastBackbufferTexture.height;
                const bpr = Math.ceil(w * 4 / 256) * 256;
                const rb = dev.createBuffer({ size: bpr * h,
                  usage: 0x1 | 0x8 });
                enc.copyTextureToBuffer(
                  { texture: lastBackbufferTexture },
                  { buffer: rb, bytesPerRow: bpr, rowsPerImage: h },
                  { width: w, height: h, depthOrArrayLayers: 1 });
                pending.push({
                  rb, bpr, w, h, framebufferId: 0, kind: "backbuffer",
                  isEfb: false,
                  sourceTextureId: lastBackbufferSourceTextureId,
                  inputVisualSample: _inputBackbufferOk,
                  presentSequence: P,
                  classifierGeneration: wgpuReplayClassifierGeneration,
                  efbDrawCountAtEncode: 0,
                  tag: `p=${P} backbuffer(src=tex#${lastBackbufferSourceTextureId || 0}) ${w}x${h}`
                });
              } catch (e) {
                console.log(`[webgpu-DIAG-cpy] backbuffer enc threw ${e?.message || e}`);
              }
            }
            if (pending.length) {
              if (_classifyOk && pending.some((entry) => entry.isEfb)) {
                wgpuClassifierEfbReadbackPending = true;
              }
              if (pending.some((entry) => entry.kind === "backbuffer")) {
                wgpuClassifierBackbufferReadbackPending = true;
              }
              if (pending.some((entry) => entry.inputVisualSample)) {
                wgpuInputBackbufferReadbackPending = true;
              }
              if (pending.some((entry) => entry.kind === "xfb")) {
                wgpuClassifierXfbReadbackPending = true;
              }
              // Diagnostic copies must observe the unmodified game output.
              // The deterministic marker is encoded only after those copies,
              // but before the same queue submission reaches the canvas.
              applyHardwareInputMarker();
              presentAlreadySubmitted = submitEnc("present");
              for (const p of pending) {
                p.rb.mapAsync(0x1).then(() => {
                  const a = new Uint8Array(p.rb.getMappedRange());
                  const N = p.w * p.h * 4;
                  let nz = 0, nzColor = 0, nzAlpha = 0, mx = 0;
                  for (let y = 0; y < p.h; y += 1) {
                    const row = y * p.bpr;
                    for (let x = 0; x < p.w; x += 1) {
                      const pixel = row + x * 4;
                      for (let channel = 0; channel < 4; channel += 1) {
                        const value = a[pixel + channel];
                        if (!value) continue;
                        nz += 1;
                        if (channel < 3) nzColor += 1;
                        else nzAlpha += 1;
                        if (value > mx) mx = value;
                      }
                    }
                  }
                  if (p.isEfb) {
                    if (p.classifierGeneration === wgpuReplayClassifierGeneration) {
                      wgpuReplayClassifier?.recordEfbReadback({
                        framebufferId: p.framebufferId,
                        nonzeroBytes: nz,
                        nonzeroColorBytes: nzColor,
                        maxByte: mx,
                        drawCountAtEncode: p.efbDrawCountAtEncode,
                        presentSequence: p.presentSequence
                      });
                      wgpuClassifierEfbReadbackPending = false;
                    }
                  }
                  if (p.classifierGeneration === wgpuReplayClassifierGeneration &&
                      p.kind !== "copy") {
                    wgpuReplayClassifier?.recordPresentationReadback({
                      kind: p.kind,
                      framebufferId: p.framebufferId,
                      sourceTextureId: p.sourceTextureId,
                      nonzeroBytes: nz,
                      nonzeroColorBytes: nzColor,
                      nonzeroAlphaBytes: nzAlpha,
                      sampledBytes: N,
                      maxByte: mx,
                      presentSequence: p.presentSequence
                    });
                    if (p.kind === "backbuffer") {
                      wgpuClassifierBackbufferReadbackPending = false;
                    }
                    if (p.kind === "xfb") {
                      wgpuClassifierXfbReadbackPending = false;
                    }
                  }
                  if (p.inputVisualSample) {
                    const hash = hashFrameBytes(a);
                    visualSampleSource = "wgpu-readback";
                    if (!wgpuInputVisualBaselineReady) {
                      wgpuInputVisualBaselineReady = true;
                      inputVisibleLatencyTracker.updatePendingVisualBaseline(hash);
                    }
                    recordVisualFrameHash(hash);
                    wgpuInputBackbufferReadbackPending = false;
                  }
                  const cy = p.h >> 1, cx = p.w >> 1;
                  const o = cy * p.bpr + cx * 4;
                  const o2 = (p.h >> 2) * p.bpr + (p.w >> 2) * 4;
                  // Fixed (200,150) lands inside any plausible 640x480
                  // menu sub-rect even for the big 2560x1024 XFB.
                  const sy = Math.min(150, p.h - 1);
                  const sx = Math.min(200, p.w - 1);
                  const o3 = sy * p.bpr + sx * 4;
                  console.log(`[webgpu-DIAG-cpy] ${p.tag} ` +
                    `nz=${nz}/${N} rgb=${nzColor} a=${nzAlpha} max=${mx} ` +
                    `px0=${a[0]},${a[1]},${a[2]},${a[3]} ` +
                    `ctr=${a[o]},${a[o+1]},${a[o+2]},${a[o+3]} ` +
                    `q=${a[o2]},${a[o2+1]},${a[o2+2]},${a[o2+3]} ` +
                    `s200x150=${a[o3]},${a[o3+1]},${a[o3+2]},${a[o3+3]}`);
                  p.rb.unmap(); p.rb.destroy();
                }).catch((e) => {
                  if (p.isEfb && p.classifierGeneration === wgpuReplayClassifierGeneration) {
                    wgpuClassifierEfbReadbackPending = false;
                  }
                  if (p.kind === "backbuffer" &&
                      p.classifierGeneration === wgpuReplayClassifierGeneration) {
                    wgpuClassifierBackbufferReadbackPending = false;
                  }
                  if (p.kind === "xfb" &&
                      p.classifierGeneration === wgpuReplayClassifierGeneration) {
                    wgpuClassifierXfbReadbackPending = false;
                  }
                  if (p.inputVisualSample) {
                    wgpuInputBackbufferReadbackPending = false;
                  }
                  console.log(`[webgpu-DIAG-cpy] map ${p.tag} err ${e?.message || e}`);
                });
              }
            }
            }
          }
          if (!presentAlreadySubmitted) applyHardwareInputMarker();
          const submittedPresent = presentAlreadySubmitted || submitEnc("present");
          // Buffers copied above are only mappable once the encoder is submitted.
          diagDrainGrids();
          mapWgpuVisualCadenceSlot(visualCadenceSlot, submittedPresent);
          if (!submittedPresent) {
            const rejectionReason = lastSubmitFailureReason ||
              (wgpuReplayFatal?.scope === "submit-error" ? "submit-error" :
                wgpuReplayFatal ? "replay-fatal" : "unknown");
            wgpuReplayClassifier?.recordPresentRejected({
              recordIndex: read,
              reason: rejectionReason
            });
            self._wgPresentRejectedLogCount = (self._wgPresentRejectedLogCount || 0) + 1;
            if (self._wgPresentRejectedLogCount <= 4) {
              console.log(
                `[webgpu-present-rejected] reason=${rejectionReason} ` +
                `fatalScope=${wgpuReplayFatal?.scope || "none"} record=${read}`
              );
            }
            break;
          }
          if (hardwareInputMarkerApplied) {
            recordInputMarkerSubmission(
              hardwareInputMarker,
              hardwareInputMarkerCoreFrame,
              "hardware-wgpu",
              q
            );
          }
          // Count hardware presents at the same boundary used by the
          // software presenters: a successful queue submission.  The old
          // path incremented only a private WGPU counter, which made the
          // public presentation FPS read as zero even while the browser was
          // visibly presenting.  Claim canvas ownership immediately too, so
          // the legacy repaint loop cannot race this submitted frame before
          // the current command-ring drain returns.
          cmdRingOwnsCanvas = true;
          recordPresentedFrame(api?.getFrame?.() ?? 0);
          scheduleDetachedWgpuBitmap(q);
          webGpuExecStats.present++;
          if (webGpuExecStats.present - webGpuExecStats.lastLog >= 120) {
            webGpuExecStats.lastLog = webGpuExecStats.present;
            const s = webGpuExecStats;
            console.log(
              `[webgpu-exec] stats present=${s.present} beginFb0=${s.beginFb0} ` +
              `beginFbN=${s.beginFbN} drawIdx=${s.drawIdx} draw=${s.draw} ` +
              `setPipe=${s.setPipe} missPipe=${s.missPipe} setBg=${s.setBg} ` +
              `missBg=${s.missBg} skipDraw=${s.skipDraw} ` +
              `pipes=${webGpuObjects.pipelines.size} ` +
              `tex=${webGpuObjects.textures.size} buf=${webGpuObjects.buffers.size} ` +
              `bg=${webGpuObjects.bindGroups.size}`);
          }
          break;
        case WGPU_CMD_OP_DESTROY: {
          const pendingMappedDestroyUploads =
            pendingWgpuUploadSnapshot().pendingUploads > 0;
          if (wgpuMappedDrainCoalescingEnabled && pendingMappedDestroyUploads) {
            if (pass) {
              markWgpuReplayFatal(
                "destroy-order",
                "destroy encountered with pending mapped uploads inside a render pass"
              );
              break;
            }
            const destroySubmitted = enc
              ? submitEnc("destroy")
              : flushMappedUploadsOnly("destroy");
            const destroyStillPending =
              pendingWgpuUploadSnapshot().pendingUploads > 0;
            if (!destroySubmitted || destroyStillPending) {
              markWgpuReplayFatal(
                "destroy-order",
                "destroy could not submit all pending mapped uploads"
              );
              break;
            }
            if (wgpuReplayFatal) break;
          }
          const tag = u32[recWord + 1], id = u32[recWord + 2];
          const m = tag === 1 ? webGpuObjects.buffers
                  : tag === 2 ? webGpuObjects.textures
                  : tag === 3 ? webGpuObjects.bindGroups : null;
          if (m) {
            const resource = m.get(id);
            if (resource && wgpuConsumerStateCacheEnabled) {
              wgpuPassStateCache.invalidateDestroyedResource(tag, resource);
            }
            m.delete(id);
            if (tag === 3) webGpuObjects.bindGroupSamplingMasks.delete(id);
          }
          break;
        }
        case WGPU_CMD_OP_BLIT_TEXTURE: {
          const sourceId = u32[recWord + 1];
          const destinationId = u32[recWord + 2];
          const s = webGpuObjects.textures.get(sourceId);
          const d = webGpuObjects.textures.get(destinationId);
          if (!s) wgpuReplayClassifier?.recordMissingResource({ kind: "blit-source", id: sourceId });
          if (!d) wgpuReplayClassifier?.recordMissingResource({ kind: "blit-destination", id: destinationId });
          if (s && d) {
            if (!vpDiagDone) {
              vpDiagBlitDst.set(destinationId, (vpDiagBlitDst.get(destinationId) || 0) + 1);
            }
            endPass("blit", read);
            ensureEnc();
            const a2 = u32[recWord + 3], a3 = u32[recWord + 4];
            const a4 = u32[recWord + 5], a5 = u32[recWord + 6];
            const a6 = u32[recWord + 7];
            blitTexture(enc, s, d,
              a2 & 0xFFFF, a2 >>> 16, a3 & 0xFFFF, a3 >>> 16,
              a4 & 0xFFFF, a4 >>> 16, a5 & 0xFFFF, a5 >>> 16,
              a6 & 0xFF, (a6 >>> 8) & 0xFF, (a6 >>> 16) & 0xFF, (a6 >>> 24) & 0xFF);
          }
          break;
        }
        default:
          break;
      }
    } catch (e) {
      replayRecordAccepted = false;
      webGpuCausalStats.errorCount += 1;
      if (wgpuUploadTransport === "mapped" &&
          (op === WGPU_CMD_OP_UPLOAD_BUFFER || op === WGPU_CMD_OP_UPLOAD_TEXTURE)) {
        wgpuMappedStagingPool?.invalidate(e);
        markWgpuReplayFatal("staging-copy", e?.message || e);
      }
      if (!self._webGpuExecErr) {
        self._webGpuExecErr = true;
        console.log(`[webgpu-exec] op=${op} threw: ${e?.message || e}`);
      }
    }
    if (causalMetricsEnabled) {
      wgpuReplayOpMetrics.finishReplay(op, replayOpStartedAt);
    }
    if (wgpuSemanticRuntimeActive && wgpuSemanticRuntime.isOpen()) {
      if (replayRecordAccepted && !wgpuReplayFatal && !mappedCapacityHold) {
        wgpuSemanticRuntime.acceptPrepared(preparedSemanticRecord, read);
      } else if (mappedCapacityHold && !wgpuReplayFatal) {
        wgpuSemanticRuntime.retryPrepared(preparedSemanticRecord);
      } else {
        wgpuSemanticRuntime.discardPrepared(
          preparedSemanticRecord,
          `consumer rejected record ${read} opcode ${op}`
        );
      }
    }
    if (wgpuReplayFatal) break;
    if (mappedCapacityHold) {
      // The current upload record is deliberately still owned by the ring.
      // A completed pass/encoder may be submitted ahead of the retry. An
      // open render pass cannot survive the asynchronous mapAsync wait, so
      // failing closed is the only ordering-safe response in that case.
      if (pass) {
        webGpuCausalStats.mappedStagingUnsafeCapacityCount += 1;
        markWgpuReplayFatal(
          "staging-capacity",
          "mapped staging capacity exhausted inside an atomic render pass"
        );
      } else {
        const flushed = enc
          ? submitEnc("staging-capacity")
          : flushMappedUploadsOnly("staging-capacity");
        if (!flushed && wgpuMappedRemapPromises.size === 0) {
          webGpuCausalStats.mappedStagingUnsafeCapacityCount += 1;
          markWgpuReplayFatal(
            "staging-capacity",
            "mapped staging capacity exhausted without a remap path"
          );
        }
      }
      break;
    }
    if (wgpuPassPackageProjectionActive && replayRecordAccepted) {
      const payloadBytes = op === WGPU_CMD_OP_UPLOAD_BUFFER
        ? u32[recWord + 4]
        : op === WGPU_CMD_OP_UPLOAD_TEXTURE
          ? Math.imul(u32[recWord + 3], u32[recWord + 5]) >>> 0
          : 0;
      // Observe only after the handler accepted this record and immediately
      // before the authoritative legacy read cursor advances.
      wgpuPassPackageProjection.observeConsumedRecord(op, read, payloadBytes);
    }
    if (wgpuUploadRunProjectionActive && replayRecordAccepted) {
      wgpuUploadRunProjection.observeAcceptedRecord({
        op,
        recordIndex: read,
        sourcePointer: op === WGPU_CMD_OP_UPLOAD_BUFFER ? u32[recWord + 3] : 0,
        logicalBytes: op === WGPU_CMD_OP_UPLOAD_BUFFER ? u32[recWord + 4] : 0,
        alignedBytes: op === WGPU_CMD_OP_UPLOAD_BUFFER
          ? (u32[recWord + 4] + 3) & ~3
          : 0,
        sourceArenaBase: ring.uploadBase,
        sourceArenaSize: ring.uploadSize,
        hasDestination: op === WGPU_CMD_OP_UPLOAD_BUFFER &&
          webGpuObjects.buffers.has(u32[recWord + 1]),
        retained: op === WGPU_CMD_OP_UPLOAD_BUFFER && Boolean(retainedSemanticPayload),
        semanticCapture: Boolean(preparedSemanticRecord),
      });
    }
    read = (read + 1) >>> 0;
    if (wgpuReplayBudgetMs > 0) {
      if (op === WGPU_CMD_OP_BEGIN_PASS) protocolPassDepth += 1;
      if (op === WGPU_CMD_OP_END_PASS) protocolPassDepth = Math.max(0, protocolPassDepth - 1);
      const afterRecordBudget = budgetGate.check({
        processed: (read - initialRead) >>> 0,
        passDepth: protocolPassDepth,
        force: op === WGPU_CMD_OP_END_PASS,
      });
      if (afterRecordBudget.shouldYield) {
        budgetStopReason = afterRecordBudget.reason;
        break;
      }
    }
  }
  if (wgpuUploadRunProjectionActive) wgpuUploadRunProjection.boundary("drain");
  if (wgpuReplayBudgetMs > 0) replayLimit = read;
  if (!wgpuReplayFatal) {
    endPass("drain-boundary", read);
    const mappedSnapshot = pendingWgpuUploadSnapshot();
    const pendingMappedUploads = (mappedSnapshot?.pendingUploads ?? 0) > 0;
    const mappedDrainDecision = wgpuMappedDrainCoalescer.atBoundary({
      pending: pendingMappedUploads,
      pendingBytes: mappedSnapshot?.pendingBytes ?? 0,
      pendingRecords: mappedSnapshot?.pendingUploads ?? 0,
      pendingAgeMs: mappedSnapshot?.oldestPendingAgeMs ?? 0,
      generation: wgpuMappedStagingGeneration,
      hasOpenPass: Boolean(pass),
      hasRenderEncoder: Boolean(enc),
    });
    if (mappedDrainDecision.cancelledTimerToken) {
      cancelWgpuMappedDrainTimer(mappedDrainDecision.cancelledTimerToken);
    }
    if (mappedDrainDecision.action === "defer") {
      scheduleWgpuMappedDrainDeadline(mappedDrainDecision);
    } else if (enc || mappedDrainDecision.action === "flush") {
      submitEnc("drain-boundary", true);
    }
  }
  const stopReason = deferBeginPass
    ? "deferred-begin"
    : read === write
      ? "write"
      : budgetStopReason || "record-window";
  webGpuCausalStats.replayBudgetStopReasons[stopReason] += 1;
  if (wgpuReplayBudgetMs > 0 && read !== write) {
    ring.heldReplayStart ??= read;
    wgpuReplayClassifier?.recordAtomicHold({ recordIndex: read, writeIndex: write });
  }
  if (!deferBeginPass && read === replayLimit && replayLimit !== write) {
    // Preserve pass atomicity without deadlocking the bounded upload arena.
    // Stage the held suffix only AFTER every replayable-prefix upload has
    // synchronously copied and advanced its watermark. Upload allocations
    // and watermark releases must stay in producer order; acknowledging the
    // suffix first can let the producer overwrite an earlier prefix payload.
    stageHeldWgpuUploads(ring, replayLimit, write, u32, heap, {
      deadlineMs: budgetDeadlineMs,
    });
  }
  if (read === write) {
    ring.heldReplayStart = null;
    ring.stagedPassStart = null;
    ring.stagedScanCursor = null;
  }
  publishWgpuReadIndex(ring, read);
  advanceWgpuSemanticCapture(ring, read);
  const processed = (read - initialRead) >>> 0;
  const backlogAfter = (write - read) >>> 0;
  webGpuCausalStats.backlogAfterLast = backlogAfter;
  webGpuCausalStats.backlogAfterHighWater = Math.max(
    webGpuCausalStats.backlogAfterHighWater,
    backlogAfter
  );
  if (collectReplayMetrics) {
    updateWgpuBacklogState(backlogAfter, performance.now());
  }
  wgpuReplayClassifier?.recordDrainEpoch({
    readIndex: initialRead,
    writeIndex: write,
    replayLimit,
    uploadReadIndex: currentWgpuUploadReadIndex(ring),
    processed,
    presentCount: webGpuExecStats.present - initialPresentCount,
    summary: epochSummary
  });
  const budgetSnapshot = budgetGate?.snapshot() ?? null;
  if (budgetSnapshot) {
    webGpuCausalStats.replayBudgetCheckCount += budgetSnapshot.checkCount;
    webGpuCausalStats.replayBudgetAtomicContinuationCount +=
      budgetSnapshot.atomicContinuationCount;
    if (budgetSnapshot.deadlineReached) {
      webGpuCausalStats.replayBudgetDeadlineReachedCount += 1;
    }
  }
  if (budgetStopReason === "time-budget") {
    webGpuCausalStats.replayBudgetYieldCount += 1;
    webGpuCausalStats.replayBudgetSourceYieldCounts[normalizedSource] += 1;
    workletAudioProducer.refill(1);
  }
  if (budgetSnapshot?.atomicOverrunCompleted) {
    const atomicOverrunMs = budgetSnapshot.atomicOverrunMs;
    webGpuCausalStats.replayBudgetAtomicOverrunCount += 1;
    webGpuCausalStats.replayBudgetAtomicOverrunTotalMs += atomicOverrunMs;
    webGpuCausalStats.replayBudgetAtomicOverrunMaxMs = Math.max(
      webGpuCausalStats.replayBudgetAtomicOverrunMaxMs,
      atomicOverrunMs
    );
  }
  if (wgpuReplayBudgetMs > 0 && read !== write && wgpuReplayPumpEnabled) {
    wgpuReplayYieldPending = true;
  }
  finishWebGpuDrain(drainStartedAt, processed);
  // Once the cmd-ring executor has presented a real frame, IT owns the
  // canvas (renderGpu.context). The legacy runPresentationLoop blit of
  // the CPU framebuffer (presentFrame → drawFrameBytesToWebGpu) must
  // then be suppressed — post-cutover the Software rasteriser is gone
  // so that CPU buffer is stale/empty (the green that was clobbering
  // our GPU render every loop iteration).
  if (webGpuExecStats.present > 0) cmdRingOwnsCanvas = true;
}

function finishWebGpuDrain(startedAt, processed) {
  const commandCount = Math.max(0, Number(processed) || 0);
  webGpuCausalStats.commandsProcessed += commandCount;
  const collectReplayMetrics = causalMetricsEnabled || wgpuReplayBudgetMs > 0;
  if (collectReplayMetrics) {
    recordBoundedHistogram(
      webGpuCausalStats.drainCommandHistogram,
      WGPU_DRAIN_COMMAND_BUCKET_BOUNDS,
      commandCount
    );
  }
  if (!collectReplayMetrics || !startedAt) return;
  const elapsed = performance.now() - startedAt;
  webGpuCausalStats.drainLastMs = elapsed;
  webGpuCausalStats.drainTotalMs += elapsed;
  webGpuCausalStats.drainMaxMs = Math.max(webGpuCausalStats.drainMaxMs, elapsed);
  recordBoundedHistogram(
    webGpuCausalStats.drainDurationHistogram,
    WGPU_DRAIN_DURATION_BUCKET_BOUNDS_MS,
    elapsed
  );
}

// Day-29: build a real GPURenderPipeline from a bridge-translated
// vertex-shader module + the constant-colour test FS. Wrapped in an
// error scope so WGSL/pipeline-validation failures are reported
// rather than silently swallowed. One-shot per pipeline id.
function replayCreatePipeline(pipelineId, vsShaderId, fsShaderId, topology) {
  if (!renderGpu || webGpuObjects.pipelines.has(pipelineId)) return;
  const vs = webGpuObjects.shaders.get(vsShaderId);
  const fs = webGpuObjects.shaders.get(fsShaderId);
  if (!vs || !fs) {
    if (!self._webGpuPipeNoShader) {
      self._webGpuPipeNoShader = true;
      console.log(
        `[webgpu-cmd-pipeline] CREATE_PIPELINE id=${pipelineId}: ` +
        `vs ${vsShaderId}=${vs ? "ok" : "MISSING"} ` +
        `fs ${fsShaderId}=${fs ? "ok" : "MISSING"} (drain-order bug?)`
      );
    }
    return;
  }
  try {
    renderGpu.device.pushErrorScope("validation");
    // Day-32: real Dolphin VS + real Dolphin FS pair (both
    // bridge-translated). layout:"auto" lets WGPU derive bind groups
    // from the shaders for now; Day-33 supplies Dolphin's real
    // pipeline/vertex/bind state.
    const pipe = renderGpu.device.createRenderPipeline({
      label: `dolphin-pipeline-${pipelineId}`,
      layout: "auto",
      vertex: { module: vs },
      fragment: {
        module: fs,
        targets: [{ format: renderGpu.format }]
      },
      primitive: { topology: topology === 0 ? "triangle-list" : "triangle-list" }
    });
    renderGpu.device.popErrorScope().then((err) => {
      if (err) {
        recordRendererError("validation", err.message);
        if (!self._webGpuPipeFirstErr) {
          self._webGpuPipeFirstErr = true;
          console.log(
            `[webgpu-cmd-pipeline] pipeline ${pipelineId} (vs=${vsShaderId} ` +
            `fs=${fsShaderId}) validation error: ${String(err.message).slice(0, 280)}`
          );
        }
      } else {
        webGpuObjects.pipelines.set(pipelineId, pipe);
        console.log(
          `[webgpu-cmd-pipeline] GPURenderPipeline ${pipelineId} built OK ` +
          `from real Dolphin VS=${vsShaderId}+FS=${fsShaderId} — ` +
          `shader-pair pipeline proven`
        );
      }
    }).catch((error) => recordRendererError("error-scope-failure", error?.message || error));
  } catch (e) {
    if (!self._webGpuPipeErr) {
      self._webGpuPipeErr = true;
      console.log(`[webgpu-cmd-pipeline] createRenderPipeline threw: ${e?.message || e}`);
    }
  }
}

// Day-33 A2: consumer-side WebGPU enum tables. The producer pre-maps
// every Dolphin pipeline-state enum to these numeric codes (see
// SerializePipelineConfig), so this side never reasons about GameCube
// semantics — it just indexes.
const WGPU_VERTEX_FORMAT = [
  "float32", "float32x2", "float32x3", "float32x4",
  "uint8x2", "uint8x4", "sint8x2", "sint8x4",
  "unorm8x2", "unorm8x4", "snorm8x2", "snorm8x4",
  "uint16x2", "uint16x4", "sint16x2", "sint16x4",
  "unorm16x2", "unorm16x4", "snorm16x2", "snorm16x4"
];
const WGPU_COMPARE = [
  "never", "less", "equal", "less-equal",
  "greater", "not-equal", "greater-equal", "always"
];
const WGPU_BLEND_FACTOR = [
  "zero", "one", "src", "one-minus-src",
  "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst",
  "dst-alpha", "one-minus-dst-alpha"
];
const WGPU_BLEND_OP = ["add", "subtract", "reverse-subtract"];

const webGpuPcfg = { ok: 0, fail: 0, defer: 0 };

// Day-33 A2: build a real GPURenderPipeline from the serialized
// AbstractPipelineConfig blob (replaces the Day-32 layout:"auto" +
// test-FS proof with Dolphin's real blend/depth/raster/vertex state).
// Bind-group layout is still derived (layout:"auto") — explicit
// layouts + vertex/uniform buffers land in A3/A4; this increment
// measures real-pipeline build coverage. One-shot per pipeline id.
function replayCreatePipelineCfg(pipelineId, blobPtr, blobLen) {
  if (!renderGpu || !blobPtr || !blobLen ||
      webGpuObjects.pipelines.has(pipelineId)) {
    return;
  }
  const u = new Uint32Array(moduleInstance.HEAPU8.buffer, blobPtr,
                            blobLen >>> 2);
  if (u[0] !== 0x57504c33) {  // 'WPL3'
    if (!self._webGpuPcfgMagic) {
      self._webGpuPcfgMagic = true;
      console.log(`[webgpu-pcfg] bad magic 0x${u[0].toString(16)} id=${pipelineId}`);
    }
    return;
  }
  const vsId = u[1], fsId = u[2];
  const vs = webGpuObjects.shaders.get(vsId);
  const fs = webGpuObjects.shaders.get(fsId);
  if (!vs || !fs) {
    // FIFO guarantees CreateShader drained first; modules build
    // synchronously at drain, so a miss is rare. Defer this frame.
    webGpuPcfg.defer += 1;
    if (!self._webGpuPcfgDefer) {
      self._webGpuPcfgDefer = true;
      console.log(
        `[webgpu-pcfg] defer id=${pipelineId} vs ${vsId}=${vs ? 1 : 0} ` +
        `fs ${fsId}=${fs ? 1 : 0}`
      );
    }
    return;
  }

  const topology = u[3];
  const stripIdxFmt = u[4];
  const cullCode = u[5];
  const depthTest = u[7];
  const depthWrite = u[8];
  const depthCompare = u[9];
  const hasDepth = u[10];
  const depthFmt = u[11];
  const colorFmt = u[12];
  const blendEnable = u[13];
  const writeMask = u[14];
  const colorOp = u[15];
  const srcF = u[16];
  const dstF = u[17];
  const alphaOp = u[18];
  const srcFA = u[19];
  const dstFA = u[20];
  const stride = u[24];
  const attrCount = u[25];

  const attributes = [];
  for (let i = 0; i < attrCount; i++) {
    const base = 26 + i * 3;
    attributes.push({
      shaderLocation: u[base],
      format: WGPU_VERTEX_FORMAT[u[base + 1]] || "float32x4",
      offset: u[base + 2]
    });
  }

  // Layout-aware vertex validation (see vpDiagCheckVertex). Keep the declared
  // stride and the Position attribute (ShaderAttrib::Position == 0) so a draw
  // can be checked against the bytes that were actually uploaded, rather than
  // assuming a leading float32x3.
  vpDiagPipeVtx.set(pipelineId, {
    stride,
    fsId,
    vsId,
    pos: attributes.find((a) => a.shaderLocation === 0) || null,
    // ShaderAttrib::TexCoord0 == 8. With an identity texgen matrix the sampled
    // UV is this attribute, so a zero/degenerate texcoord samples the black
    // corner these textures start with.
    tc0: attributes.find((a) => a.shaderLocation === 8) || null,
    // ShaderAttrib::Color0 == 5. The vertex shader passes this straight through
    // as vertexColour0, so its alpha byte IS the alpha that reaches the TEV.
    col0: attributes.find((a) => a.shaderLocation === 5) || null,
    writeMask,
    blendEnable,
    srcF,
    dstF
  });

  // §28ap: cap 24→1200 so the late-created MENU pipelines (id≈16000+,
  // fs#16081) are captured — compare their serialized vertex
  // attributes (esp. the TexCoord0 = @location(8) entry the menu VS
  // reads) vs the VS @location inputs to settle data-vs-layout for
  // the dark-content defect (§28an). Tag the texcoord attrs.
  if (wgpuDeepReplayDiagnostics && attrCount > 0 &&
      (self._wgPcfgAttrN = (self._wgPcfgAttrN || 0) + 1) <= 1200) {
    const tc = attributes.filter((a) => a.shaderLocation >= 8 &&
      a.shaderLocation <= 15);
    console.log(`[webgpu-DIAG-attr] pcfg id=${pipelineId} vs=${vsId} fs=${fsId} ` +
      `stride=${stride} attrCount=${attrCount} ` +
      attributes.map((a) => `L${a.shaderLocation}:${a.format}@${a.offset}`).join(" ") +
      ` | texcoordAttrs=${tc.length ? tc.map((a) => `L${a.shaderLocation}:${a.format}@${a.offset}`).join(",") : "NONE"}`);
  }

  const TOPO = ["point-list", "line-list", "triangle-list",
                "triangle-strip"];
  const CULL = ["none", "back", "front"];

  const target = {
    format: colorFmt === 1 ? "bgra8unorm" : "rgba8unorm",
    writeMask: writeMask
  };
  if (blendEnable) {
    target.blend = {
      color: {
        srcFactor: WGPU_BLEND_FACTOR[srcF] || "one",
        dstFactor: WGPU_BLEND_FACTOR[dstF] || "zero",
        operation: WGPU_BLEND_OP[colorOp] || "add"
      },
      alpha: {
        srcFactor: WGPU_BLEND_FACTOR[srcFA] || "one",
        dstFactor: WGPU_BLEND_FACTOR[dstFA] || "zero",
        operation: WGPU_BLEND_OP[alphaOp] || "add"
      }
    };
  }

  const desc = {
    label: `dolphin-pcfg-${pipelineId}`,
    layout: getFixedLayouts().pipelineLayout,
    vertex: {
      module: (DIAG_TRIVIAL_VS && hasDepth && depthTest &&
               ["less", "greater", "less-equal", "greater-equal"]
                 .includes(WGPU_COMPARE[depthCompare]))
        ? getTrivialVsModule(renderGpu.device) : vs,
      buffers: attrCount > 0
        ? [{ arrayStride: stride, stepMode: "vertex", attributes }]
        : []
    },
    fragment: {
      module: ((DIAG_CONST_FS && hasDepth) ||
               (DIAG_CONST_FS_OPAQUE && hasDepth && depthTest && !blendEnable &&
                ["less", "greater", "less-equal", "greater-equal"]
                  .includes(WGPU_COMPARE[depthCompare])) ||
               (DIAG_TRIVIAL_VS && hasDepth && depthTest &&
                ["less", "greater", "less-equal", "greater-equal"]
                  .includes(WGPU_COMPARE[depthCompare])) ||
               (DIAG_CONST_FS_TESTED_ONLY && hasDepth && depthTest &&
                ["less", "greater", "less-equal", "greater-equal"]
                  .includes(WGPU_COMPARE[depthCompare])))
        ? getConstFsModule(renderGpu.device)
        : (((DIAG_FORCE_UV || DIAG_UV_FINITE || DIAG_UV_PERTURB || DIAG_SHOW_VCOLOR) &&
            hasDepth &&
            pickVariantFs(fsId)) || fs),
      targets: [target]
    },
    primitive: {
      topology: TOPO[topology] || "triangle-list",
      // §28g ROOT-CAUSE FIX: the GX vertex shader negates clip-space Y
      // (VertexShaderGen Y-flip → `pos.y = -pos.y`), which REVERSES
      // triangle winding. With the default frontFace "ccw" the
      // Dolphin-driven back/front cull then removes exactly the
      // geometry that should be visible — the confirmed cause of the
      // black difficulty-select roster/scene (bisected via
      // DIAG_RASTER_OPEN → DIAG_CULL_NONE_ONLY: cull-none renders it
      // fully, scissor innocent). Declaring frontFace "cw" compensates
      // for the VS Y-flip so Dolphin's cull semantics are correct;
      // cull-none draws (boot/text/2D UI) are unaffected.
      frontFace: "cw",
      cullMode: (DIAG_RASTER_OPEN || DIAG_CULL_NONE) ? "none" : (CULL[cullCode] || "none")
    },
    multisample: { count: 1 }
  };
  if (topology === 3 && stripIdxFmt === 1) {
    desc.primitive.stripIndexFormat = "uint16";
  }
  if (hasDepth) {
    desc.depthStencil = {
      format: depthFmt === 1 ? "depth32float" : "depth24plus",
      depthWriteEnabled: !!depthWrite,
      depthCompare: depthTest ? (WGPU_COMPARE[depthCompare] || "always")
                              : "always"
    };
  }

  // Store a template; the actual GPURenderPipeline is built lazily per
  // (colorFmt, depthFmt) the pass actually uses — Dolphin's pipeline
  // framebuffer-state and the real WebGPU target formats can diverge
  // (RGBA8 vs the bgra8unorm canvas/XFB), and WebGPU requires an exact
  // attachment match. Pipeline *variants* keyed on the live pass
  // formats eliminate the whole attachment-mismatch class.
  const depthBase = hasDepth
    ? { depthWriteEnabled: !!depthWrite,
        depthCompare: depthTest ? (WGPU_COMPARE[depthCompare] || "always")
                                : "always" }
    : null;
  // §28: persist a compact pipeline-state summary so the EFB-draw
  // tally can report why the backdrop draw produces black (writeMask
  // 0? blend dst-only? depth always-fail? which FS to dump?).
  const s28dbg = `fs#${fsId} vs#${vsId} wm${writeMask}` +
    ` blend${blendEnable ? `1:${srcF}/${dstF}` : "0"}` +
    ` depth${hasDepth ? `${depthTest ? 1 : 0}/${depthWrite ? 1 : 0}/${depthCompare}` : "off"}`;
  webGpuObjects.pipeTpl.set(pipelineId, { desc, target, depthBase, s28dbg, fsId, vsId });
  // Build the default (pcfg-format) variant now so the map is warm.
  resolvePipeline(pipelineId, target.format, depthBase ? desc.depthStencil.format : null,
                  { vsId, fsId, attrCount, stride, blendEnable, hasDepth });
}

// Return (building+caching on first use) the pipeline variant whose
// colour/depth attachment formats match the render pass it'll run in.
function resolvePipeline(pipelineId, colorFmt, depthFmt, dbg, revZ, samplingKey = "0/0") {
  // §28af: revZ is per-PASS (from the SET_VIEWPORT near>far that
  // precedes this draw). Default to the last-seen pass state so the
  // warm template build (revZ undefined) doesn't pin a wrong variant.
  if (revZ === undefined) revZ = !!self._wgPassRevZ;
  const tpl = webGpuObjects.pipeTpl.get(pipelineId);
  // §28ai SMOOTHNESS: the rz0/rz1 split only changes the descriptor
  // when there's a depth attachment AND a FLIPPABLE compare
  // (less/greater/less-equal/greater-equal). For depthless pipelines
  // (copies/composites/most UI) and depth pipelines with
  // always/equal/never/not-equal, rz1 builds a byte-identical
  // pipeline → a wasted second WebGPU compile (stutter). Collapse
  // those to a single rz0 variant — zero correctness change (the
  // §28af flip is already a no-op there), fewer pipeline compiles.
  const _fc = tpl && tpl.depthBase ? tpl.depthBase.depthCompare : null;
  const rzRelevant = !!depthFmt && (_fc === "less" || _fc === "greater" ||
    _fc === "less-equal" || _fc === "greater-equal");
  // §28at: single convention — flip for every rzRelevant draw
  // (REVZ_COMPARE_FLIP_ALL), so the variant key no longer depends on
  // per-pass revZ (which is uniformly false at flag=false anyway).
  const keyRz = ((typeof REVZ_COMPARE_FLIP_ALL !== "undefined" &&
                  REVZ_COMPARE_FLIP_ALL)
                   ? rzRelevant
                   : (rzRelevant && revZ)) ? 1 : 0;
  // The sampling key is part of the identity: a pipeline built against the
  // filtering layout cannot be reused for one whose bind group declares an
  // unfilterable texture or a non-filtering sampler.
  const key = `${pipelineId}|${colorFmt}|${depthFmt}|rz${keyRz}|s${samplingKey}`;
  const cached = webGpuObjects.pipeVar.get(key);
  if (cached !== undefined) return cached;
  if (!tpl) { webGpuObjects.pipeVar.set(key, null); return null; }
  const d = Object.assign({}, tpl.desc);
  // Build against the layout the bind group will actually be created with.
  // The template carries the all-filtering layout, which a bind group holding
  // a depth or R32F texture cannot satisfy.
  const [unfilterableMask, nonFilteringSamplerMask] = samplingKey.split("/").map(Number);
  d.layout = getFixedLayouts(unfilterableMask, nonFilteringSamplerMask).pipelineLayout;
  d.fragment = { module: tpl.desc.fragment.module,
                 targets: [Object.assign({}, tpl.target, { format: colorFmt })] };
  if (depthFmt) {
    d.depthStencil = Object.assign({ format: depthFmt },
      tpl.depthBase || { depthWriteEnabled: false, depthCompare: "always" });
    // §28ad/§28af ROOT FIX (3D-black layer (a)): reverse-Z compare
    // flip — but ONLY for reverse-Z passes. Dolphin runs
    // bSupportsReversedDepthRange=true so it emits the GX compare
    // UNflipped and relies on a reversed VkViewport to carry
    // reverse-Z. WebGPU/Dawn forbids minDepth>maxDepth, so we keep a
    // normal viewport; for the perspective (reversed-viewport) draws
    // the window depth is reverse-Z (near→1,far→0) and the GX
    // LEQUAL/LESS compare must be flipped to GEQUAL/GREATER (+ depth
    // cleared to far=0.0 at depthClearValue). §28ad flipped this
    // GLOBALLY, which INVERTED occlusion on the normal-Z (vp
    // near<far) menu/UI/overlay depth draws → menu rendered dark and
    // the title flickered (user-reported). §28af makes it per-pass:
    // flip + clear-0 only when revZ; normal-Z passes keep the GX
    // compare and clear to 1.0 unchanged (no §28g/menu regression).
    if (REVZ_COMPARE_FLIP && rzRelevant &&
        ((typeof REVZ_COMPARE_FLIP_ALL !== "undefined" &&
          REVZ_COMPARE_FLIP_ALL) || revZ)) {
      const F = { "less": "greater", "greater": "less",
                  "less-equal": "greater-equal",
                  "greater-equal": "less-equal" };
      const c = d.depthStencil.depthCompare;
      if (F[c]) d.depthStencil.depthCompare = F[c];
    }
    // DIAGNOSTIC (revertible): force depth-test off so nothing is
    // depth-rejected. With the EFB→canvas DIAG, this bisects "black
    // EFB": geometry appears ⇒ uniform depth-rejection (EFB depth
    // clear / GX-vs-Vulkan z convention); still black ⇒ transform/
    // vertex bug. Flip false to restore real depth state.
    if (DIAG_DEPTH_ALWAYS) {
      d.depthStencil.depthCompare = "always";
      d.depthStencil.depthWriteEnabled = false;
    }
  } else {
    delete d.depthStencil;
  }
  // The vpdiag tally reports tpl.depthBase.depthCompare, which is the value
  // BEFORE the reverse-Z flip. Log what the descriptor actually carries, so
  // "flipped to greater-equal" is observed rather than assumed.
  if (d.depthStencil && !self._wgCmpLogged) {
    self._wgCmpLogged = (self._wgCmpLogged || 0) + 1;
    if (self._wgCmpLogged <= 0) { /* unreachable, keeps shape */ }
  }
  if (d.depthStencil) {
    const key = `final depthCompare=${d.depthStencil.depthCompare} ` +
      `write=${d.depthStencil.depthWriteEnabled}`;
    vpDiagFinalCmp.set(key, (vpDiagFinalCmp.get(key) || 0) + 1);
  }
  let pipe = null;
  try {
    renderGpu.device.pushErrorScope("validation");
    pipe = renderGpu.device.createRenderPipeline(d);
    if (pipe && d.depthStencil) {
      vpDiagPipeFinalDs.set(pipe, { cmp: d.depthStencil.depthCompare,
                                    write: !!d.depthStencil.depthWriteEnabled });
    }
    renderGpu.device.popErrorScope().then((err) => {
      if (err) {
        recordRendererError("validation", err.message);
        webGpuObjects.pipeVar.set(key, null);
        webGpuPcfg.fail += 1;
        // DIAG: log the first ~24 distinct variant failures (not just
        // the first ever) — silent per-pipeline VS↔FS interstage
        // mismatches are the leading textured-black suspect (§14).
        if ((self._wgPcfgFailN = (self._wgPcfgFailN || 0) + 1) <= 24) {
          console.log(`[webgpu-pcfg] variant FAIL ${key}` +
            (dbg ? ` (vs=${dbg.vsId} fs=${dbg.fsId} attrs=${dbg.attrCount})` : "") +
            `: ${String(err.message).slice(0, 220)}`);
        }
      } else {
        webGpuPcfg.ok += 1;
        if (webGpuPcfg.ok <= 3 || webGpuPcfg.ok % 128 === 0) {
          console.log(`[webgpu-pcfg] variant OK ${key} ` +
            `[ok=${webGpuPcfg.ok} fail=${webGpuPcfg.fail}]`);
        }
      }
    }).catch((error) => recordRendererError("error-scope-failure", error?.message || error));
  } catch (e) {
    webGpuPcfg.fail += 1;
    if (!self._webGpuPcfgThrew) {
      self._webGpuPcfgThrew = true;
      console.log(`[webgpu-pcfg] createRenderPipeline threw ${key}: ${e?.message || e}`);
    }
  }
  webGpuObjects.pipeVar.set(key, pipe);
  return pipe;
}

// Day-28: build a real GPUShaderModule from a WGSL blob in the shared
// wasm heap, keyed by the producer-assigned id. createShaderModule is
// synchronous; compilation diagnostics come back via the async
// getCompilationInfo() — we count ok/fail off that and surface the
// first few + the first error so we can see how much of Dolphin's
// real shader set survives GLSL→Naga→WGSL→browser end-to-end.
function replayCreateShader(id, blobPtr, blobLen, stage) {
  if (!self._webGpuShaderSeen) {
    self._webGpuShaderSeen = true;
    console.log(
      `[webgpu-cmd-shader] first CREATE_SHADER reached consumer: id=${id} ` +
      `ptr=${blobPtr} len=${blobLen} stage=${stage} ` +
      `renderGpu=${renderGpu ? 1 : 0} dec=${webGpuTextDecoder ? 1 : 0}`
    );
  }
  if (!renderGpu || !webGpuTextDecoder || !blobPtr || !blobLen) {
    webGpuObjects.shaderFail += 1;
    return;
  }
  let wgsl;
  let uvForcedWgsl = null;
  try {
    // TextDecoder.decode() rejects SharedArrayBuffer-backed views in
    // several engines ("cannot decode from a shared ArrayBuffer"), so
    // copy the blob into a plain (non-shared) Uint8Array first. The
    // copy is small (a shader's WGSL, ~1-4 KB) and one-time per shader.
    const shared = new Uint8Array(moduleInstance.HEAPU8.buffer, blobPtr, blobLen);
    const local = new Uint8Array(blobLen);
    local.set(shared);
    wgsl = webGpuTextDecoder.decode(local);
    // Strip `discard` from fragment shaders. Dolphin bakes the GX alpha test
    // into the pixel shader as a discard; if it rejects every world fragment
    // the EFB keeps its clear colour and the geometry is invisible -- which is
    // also what the constant-colour FS test bypassed, so it is consistent with
    // everything measured so far. Diagnostic only: removing it draws fragments
    // the game intended to throw away.
    vpDiagShaderStage[stage] = (vpDiagShaderStage[stage] || 0) + 1;
    if (stage === 2 && /discard/.test(wgsl)) {
      if (++vpDiagShaderWithDiscard === 1) {
        const i = wgsl.indexOf("discard");
        console.log("[vpdiag] discard context: " +
          JSON.stringify(wgsl.slice(Math.max(0, i - 160), i + 120)));
      }
    }
    // Keep vertex sources too: vertexColour0.a is computed here, and the
    // constants feeding it measured correct.
    if ((stage === 2 || stage === 0) && wgsl.length < 60000) vpDiagFsSource.set(id, wgsl);
    if (stage === 2) {
      const mb0 = /@group\(1\)\s*@binding\((\d+)\)\s*var[^;]*texture_2d_array/.exec(wgsl);
      if (mb0) vpDiagFsTexBinding.set(id, Number(mb0[1]));
    }
    if (stage === 2 && !self._vpDiagFsBindingsLogged) {
      self._vpDiagFsBindingsLogged = true;
      const calls = wgsl.match(/textureSample[A-Za-z]*\([^;]*?\);/g) || [];
      console.log("[vpdiag] FS sample calls: " + JSON.stringify(calls.slice(0, 3)));
      const mb = /@group\(1\)\s*@binding\((\d+)\)\s*var[^;]*texture_2d_array/.exec(wgsl);
      if (mb) vpDiagFsTexBinding.set(id, Number(mb[1]));
      const decls = wgsl.match(/@group\([0-9]+\)\s*@binding\([0-9]+\)\s*var[^;]*;/g) || [];
      console.log("[vpdiag] FS bindings: " + JSON.stringify(decls));
    }
    // Force the texture-array layer to 0. The translated sampling call is
    // textureSample(tex, samp, vec2<f32>(uv), i32(coord.z)), so the layer comes
    // from the third texcoord. Every texture the world binds is single-layer,
    // so a non-zero layer samples out of range.
    if (DIAG_FORCE_LAYER0 && stage === 2) {
      const before = wgsl;
      wgsl = wgsl.replace(
        /textureSample([A-Za-z]*)\(([^,]+),\s*([^,]+),\s*(vec2<f32>\([^)]*\)),\s*i32\([^)]*\)/g,
        "textureSample$1($2, $3, $4, 0i");
      if (before !== wgsl && ++vpDiagLayerForced <= 1) {
        console.log("[vpdiag] forced texture array layer to 0");
      }
    }
    // Force the sampled UV to the middle of the texture. The textures these
    // draws bind begin with black rows -- that is what made a head-only scan
    // misread them as empty -- so texcoords stuck near zero would sample that
    // black corner and produce exactly the observed black.
    if (DIAG_SHOW_VCOLOR && stage === 2) uvForcedWgsl = vcolorRewrite(wgsl);
    else if (DIAG_UV_PERTURB && stage === 2) uvForcedWgsl = uvPerturbRewrite(wgsl);
    else if (DIAG_UV_FINITE && stage === 2) uvForcedWgsl = uvFiniteRewrite(wgsl);
    else if (DIAG_FORCE_UV && stage === 2) uvForcedWgsl = uvForceRewrite(wgsl);
    if (DIAG_NO_DISCARD && stage === 2) {
      const before = wgsl;
      wgsl = wgsl.replace(/discard;/g, "");
      if (before !== wgsl && ++vpDiagDiscardStripped <= 1) {
        console.log("[vpdiag] stripped discard from fragment shaders");
      }
    }
  } catch (e) {
    webGpuObjects.shaderFail += 1;
    if (!self._webGpuShaderDecodeErr) {
      self._webGpuShaderDecodeErr = true;
      console.log(`[webgpu-cmd-shader] WGSL decode failed: ${e?.message || e}`);
    }
    return;
  }

  // DIAG one-shot per stage: dump the translated WGSL head so the
  // @group/@binding for the UBO blocks and the @location vertex inputs
  // can be checked against the producer's group0 layout + pcfg vertex
  // attributes (the suspected black-EFB cause: shader-interface
  // mismatch).
  // Compact interface map: for every distinct vertex shader, log just
  // its `fn main(...)` signature (the @location inputs). Correlate
  // shader id ↔ [webgpu-DIAG-attr]'s pcfg vs=<id> attrs to find the
  // vertex-attribute interface mismatch.
  if (stage === 0 && (self._wgWgslN = (self._wgWgslN || 0) + 1) <= 24) {
    const mi = wgsl.indexOf("fn main(");
    let sig = "(no main)";
    if (mi >= 0) {
      const end = wgsl.indexOf("{", mi);
      sig = wgsl.slice(mi, end >= 0 ? end : mi + 240).replace(/\s+/g, " ");
    }
    console.log(`[webgpu-DIAG-wgsl] vs id=${id} len=${wgsl.length} ${sig}`);
  }
  // Full body of the first GX vertex shader (has @location inputs, big)
  // to trace how @builtin(position) is computed from the position attr
  // + VSBlock (clip-space / projection / Y-Z-W convention).
  if (stage === 0 && wgsl.length > 5000 && wgsl.indexOf("@location(0)") >= 0 &&
      !self._wgVsFull) {
    self._wgVsFull = true;
    for (let o = 0; o < wgsl.length; o += 1600) {
      console.log(`[webgpu-DIAG-vsfull id=${id} ${o}] ` +
                  wgsl.slice(o, o + 1600));
    }
  }
  // Full body of the first big GX fragment shader (TEV) — trace
  // texture sampling, TEV combiner, alpha test, ocol0 output to find
  // why textured draws output black.
  if (stage === 2 && wgsl.length > 4000 && !self._wgFsFull) {
    self._wgFsFull = true;
    for (let o = 0; o < wgsl.length; o += 1600) {
      console.log(`[webgpu-DIAG-fsfull id=${id} ${o}] ` +
                  wgsl.slice(o, o + 1600));
    }
  }
  // §28: stash pixel-shader WGSL by id (capped) so the EFB-draw tally
  // can dump the specific black-backdrop FS on demand.
  if (stage === 2) {
    self._wgFsSrc = self._wgFsSrc || {};
    if (self._wgFsSrc[id] === undefined &&
        Object.keys(self._wgFsSrc).length < 80) {
      self._wgFsSrc[id] = wgsl;
    }
  }
  // §28e: also stash vertex-shader WGSL by id — the backdrop FS = pure
  // vertex-colour pass-through, so the black comes from the VS colour
  // output. Dump the backdrop VS alongside its FS to see how color0 is
  // synthesised (per-vertex attr vs lighting/material UBO constants).
  if (stage === 0) {
    self._wgVsSrc = self._wgVsSrc || {};
    if (self._wgVsSrc[id] === undefined &&
        Object.keys(self._wgVsSrc).length < 80) {
      self._wgVsSrc[id] = wgsl;
    }
  }

  // [webgpu-DIAG-util] Full body of the small utility shaders (EFB-copy
  // VS/FS, screen-quad, color/copy FS — all < 4 KB; GX TEV shaders are
  // far bigger so the length cap excludes them). The EFB-copy targets
  // are still opaque-black after the utility-uniform fix, so trace the
  // copy VS (vertex_index fullscreen-tri + src_offset/src_size from the
  // PSBlock UBO) and the copy FS (SampleEFB → ocol0) for the real cause.
  if (wgsl.length < 4000 &&
      (self._wgUtilN = (self._wgUtilN || 0) + 1) <= 8) {
    for (let o = 0; o < wgsl.length; o += 1600) {
      console.log(`[webgpu-DIAG-util id=${id} s${stage} ${o}] ` +
                  wgsl.slice(o, o + 1600));
    }
  }

  // [s28aw] DECISIVE dark-menu experiment (JS-only, gated, revertible):
  // §28av proved the menu sampled UV is valid [0,1]; the remaining
  // strong candidate is the textureSampleBias array-LAYER index. The
  // menu textures are single-layer but bound as 2d-array views; if the
  // texgen 3rd coord makes i32(_eN.z) ≥ 1 the sample is out-of-range ⇒
  // 0 ⇒ black. Force the layer to 0 in FS textureSampleBias calls and
  // see if the menu renders. Verified against BOTH the menu (must
  // render) and title/3D (must NOT regress) before keeping.
  if (S28AW_FORCE_TEXLAYER0 && stage === 2 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl.replace(/(textureSampleBias\([^;]*?,\s*)i32\(_e\d+\.z\)/g,
                        "$1" + "0i");
    if (wgsl !== before &&
        (self._wgS28awN = (self._wgS28awN || 0) + 1) <= 4) {
      console.log(`[s28aw] forced textureSampleBias layer→0 in fs id=${id}`);
    }
  }
  // [s28ax] decisive bisection: replace the textured-FS entry body
  // (the only `-> @location(0) vec4<f32> { … }`, no nested braces in
  // Naga's main) with a constant magenta return.
  if (S28AX_FS_CONST && stage === 2 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl.replace(
      /(->\s*@location\(0\)\s*vec4<f32>\s*\{)[^{}]*\}/,
      "$1 return vec4<f32>(1.0, 0.0, 1.0, 1.0); }");
    if (wgsl !== before &&
        (self._wgS28axN = (self._wgS28axN || 0) + 1) <= 4) {
      console.log(`[s28ax] forced const-magenta FS id=${id}`);
    }
  }
  // [s28bf] visualise the sampled UV: replace textureSampleBias(t,s,
  // vec2<f32>(UV), layer, bias) with vec4(UV.x, UV.y, 0, 1) so the
  // TEV carries the texgen UV as colour. Naga form:
  // textureSampleBias(p6, p7, vec2<f32>(_eN.x, _eN.y), i32(_eN.z), _eM)
  if (S28BF_SHOW_UV && stage === 2 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl.replace(
      /textureSampleBias\(\s*\w+\s*,\s*\w+\s*,\s*(vec2<f32>\([^()]*\))\s*,\s*[^,]*,\s*\w+\s*\)/g,
      "vec4<f32>(($1).x, ($1).y, 0.0, 1.0)");
    if (wgsl !== before &&
        (self._wgS28bfN = (self._wgS28bfN || 0) + 1) <= 4) {
      console.log(`[s28bf] showing UV-as-colour fs id=${id}`);
    }
  }
  // [s28bb] isolate sample mechanics: textureSampleBias(t,s,c,l,bias)
  // → textureSampleLevel(t,s,c,l,0.0). Naga emits the bias as the
  // final `_e<N>` arg right after `i32(_e<N>.z)`; swap the call name
  // and replace that last arg with explicit LOD 0.0.
  if (S28BB_SAMPLE_LOD0 && stage === 2 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl
      .replace(/textureSampleBias\(/g, "textureSampleLevel(")
      .replace(/(textureSampleLevel\([^;]*?,\s*i32\(_e\d+\.z\)\s*),\s*_e\d+\)/g,
               "$1, 0.0)");
    if (wgsl !== before &&
        (self._wgS28bbN = (self._wgS28bbN || 0) + 1) <= 4) {
      console.log(`[s28bb] textureSampleBias→Level(…,0.0) fs id=${id}`);
    }
  }
  // [s28ay] sample-vs-TEV bisect: dolphin_fn_1_ is the texture-sampler
  // helper (`-> vec4<i32> { …no nested braces… return _eN; }`). Force
  // it to return white so the TEV runs with a known-good "sample".
  if (S28AY_SAMPLER_WHITE && stage === 2 &&
      wgsl.indexOf("fn dolphin_fn_1_(") >= 0 &&
      wgsl.indexOf("textureSampleBias(") >= 0) {
    const before = wgsl;
    wgsl = wgsl.replace(
      /(fn dolphin_fn_1_\([^{]*\{)[^{}]*\}/,
      "$1 return vec4<i32>(255i, 255i, 255i, 255i); }");
    if (wgsl !== before &&
        (self._wgS28ayN = (self._wgS28ayN || 0) + 1) <= 4) {
      console.log(`[s28ay] forced dolphin_fn_1_→white FS id=${id}`);
    }
  }
  let module;
  try {
    module = renderGpu.device.createShaderModule({
      label: `dolphin-shader-${id}-s${stage}`,
      code: wgsl
    });
  } catch (e) {
    webGpuObjects.shaderFail += 1;
    if (!self._webGpuShaderFirstErr) {
      self._webGpuShaderFirstErr = true;
      // console.log (not postStatus) so the validator's console.log
      // capture preserves it — postStatus only keeps the latest pill.
      console.log(`[webgpu-cmd-shader] createShaderModule threw: ${e?.message || e}`);
    }
    return;
  }
  webGpuObjects.shaders.set(id, module);
  if (uvForcedWgsl) {
    try {
      webGpuObjects.shadersUvForced.set(id,
        renderGpu.device.createShaderModule({ label: `uvforced-${id}`, code: uvForcedWgsl }));
    } catch { /* variant is diagnostic only; fall back to the real module */ }
  }
  if (webGpuObjects.shaders.size <= 4) {
    console.log(
      `[webgpu-cmd-shader] GPUShaderModule created id=${id} stage=${stage} ` +
      `wgslLen=${wgsl.length} hasCompileInfo=` +
      `${typeof module.getCompilationInfo === "function" ? 1 : 0} ` +
      `(map size=${webGpuObjects.shaders.size})`
    );
  }

  // Validate asynchronously (discio worker is event-loop driven, so
  // this resolves — unlike the pthread). Count + report via
  // console.log so it lands in the captured console stream.
  if (typeof module.getCompilationInfo === "function") {
    module.getCompilationInfo().then((info) => {
      const errs = (info?.messages || []).filter((m) => m.type === "error");
      if (errs.length === 0) {
        webGpuObjects.shaderOk += 1;
        if (webGpuObjects.shaderOk <= 4) {
          console.log(
            `[webgpu-cmd-shader] module id=${id} stage=${stage} compiled OK ` +
            `[ok=${webGpuObjects.shaderOk} fail=${webGpuObjects.shaderFail}]`
          );
        }
      } else {
        webGpuObjects.shaderFail += 1;
        if (!self._webGpuShaderFirstCompileErr) {
          self._webGpuShaderFirstCompileErr = true;
          const e0 = errs[0];
          console.log(
            `[webgpu-cmd-shader] first WGSL compile error (id=${id} stage=${stage}) ` +
            `L${e0.lineNum}:${e0.linePos} ${String(e0.message).slice(0, 220)}`
          );
          // Day-31: dump the offending WGSL so we can see the
          // cyclic-function pattern Naga emitted. Cap to keep the log
          // sane; include line numbers for cross-ref with the error.
          try {
            const lines = String(wgsl).split("\n");
            const dump = lines
              .map((ln, i) => `${i + 1}: ${ln}`)
              .join("\n")
              .slice(0, 6000);
            console.log(`[webgpu-cmd-wgsl] id=${id} (${lines.length} lines):\n${dump}`);
          } catch (e) { /* best-effort */ }
        }
      }
    }).catch(() => { webGpuObjects.shaderFail += 1; });
  } else {
    webGpuObjects.shaderOk += 1;
  }
}

// Day-17 phase 4: receive XFB pixel data from `WebGPUGfx::ShowImage`
// (`?video=wgpu` path). The C++ side posts {type:'webgpu-show-image',
// width, height, bytes: Uint8Array} from the GPU pthread; we feed
// those bytes through the existing WebGPU presenter pipeline so the
// canvas displays the real frame via a `wgpuRenderPass` blit.
let webGpuShowImageCount = 0;
function handleWebGpuShowImage(event) {
  const data = event.data;
  if (!data || data.type !== "webgpu-show-image" || !data.ptr || !data.len) return;
  if (cmdRingOwnsCanvas) return;
  webGpuShowImageCount += 1;
  if (webGpuShowImageCount === 1) {
    postStatus(
      `WebGPU video backend: first XFB frame ${data.width}x${data.height} ` +
        `(zero-copy via shared heap @0x${data.ptr.toString(16)})`
    );
  }
  try {
    // Zero-copy: read the pixels straight out of the shared wasm heap
    // at the pointer C++ handed us. drawFrameBytesToWebGpu only reads
    // the view (queue.writeTexture copies into the GPU texture), so no
    // intermediate JS allocation is needed.
    const heap = moduleInstance?.HEAPU8;
    if (!heap) return;
    const frameView = new Uint8Array(heap.buffer, data.ptr, data.len);
    drawFrameBytesToWebGpu(data.width, data.height, frameView);
  } catch (e) {
    recordRendererError("show-image-draw-error", e?.message || e);
    if (!self._webGpuShowImageErrLogged) {
      self._webGpuShowImageErrLogged = true;
      postStatus(`webgpu-show-image draw error: ${e?.message || e}`);
    }
  }
}

let detachedOglForwardedCount = 0;
function handleDetachedOglFrame(event) {
  const data = event.data;
  if (!data || data.type !== "detachedOglFrame" || !data.bitmap) return;
  detachedOglForwardedCount += 1;
  if (detachedOglForwardedCount === 1) {
    postStatus(
      `ogl-detached: first bitmap received from GPU pthread (${data.width}x${data.height}); forwarding to main`
    );
  }
  try {
    self.postMessage(
      { type: "detachedOglFrame", bitmap: data.bitmap, width: data.width, height: data.height },
      [data.bitmap]
    );
  } catch (err) {
    if (!self._detachedOglForwardErrLogged) {
      self._detachedOglForwardErrLogged = true;
      postStatus(`ogl-detached: forward to main failed: ${err?.message || err}`);
    }
    try { data.bitmap.close(); } catch {}
  }
}

// Day-1 instrumentation: drain the C++ per-frame ring buffer ~1Hz and print
// new entries to console. The C side pushes one entry per OGL swap; entries
// are 32 bytes / 8 × u32 (see DolphinWebFrameRingEntry in
// core/upstream/dolphin_web_discio.cpp). Layout:
//   u32 frame, prim, draw, verts, xfb_hash, glerr; i32 commit_result; u32 debug_bits
//
// `head` is monotonic so we can detect overflow (newEntries > capacity).
let frameRingDrainTimer = null;
let frameRingLastDrainHead = 0;
function startFrameRingDrainLoop() {
  if (frameRingDrainTimer || !api?.getFrameRingHead || !api?.getFrameRingEntryPtr) {
    return;
  }
  const capacity = api.getFrameRingCapacity?.() | 0;
  const entrySize = api.getFrameRingEntrySize?.() | 0;
  if (capacity <= 0 || entrySize !== 32) {
    postStatus(`frame-ring drain disabled: capacity=${capacity} entrySize=${entrySize}`);
    return;
  }
  const ptr = api.getFrameRingEntryPtr();
  if (!ptr || !moduleInstance?.HEAPU32) {
    postStatus("frame-ring drain disabled: no HEAPU32 or null ptr");
    return;
  }
  frameRingLastDrainHead = api.getFrameRingHead?.() >>> 0;
  postStatus(
    `frame-ring drain online: capacity=${capacity} ptr=0x${ptr.toString(16)} startHead=${frameRingLastDrainHead}`
  );
  frameRingDrainTimer = setInterval(() => {
    const heap = moduleInstance.HEAPU32;
    if (!heap || !api?.getFrameRingHead) return;
    const head = api.getFrameRingHead() >>> 0;
    if (head === frameRingLastDrainHead) return;
    const total = (head - frameRingLastDrainHead) >>> 0;
    const overflowed = total > capacity;
    const startIndex = overflowed ? head - capacity : frameRingLastDrainHead;
    const baseIndex = (ptr >>> 2);
    const u32sPerEntry = 8;
    if (overflowed) {
      postStatus(`frame-ring overflow: ${total} entries dropped (capacity=${capacity})`);
    }
    for (let n = startIndex; (n >>> 0) !== head; n = (n + 1) >>> 0) {
      const slot = (n >>> 0) % capacity;
      const off = baseIndex + slot * u32sPerEntry;
      const frame = heap[off + 0] >>> 0;
      const prim = heap[off + 1] >>> 0;
      const draw = heap[off + 2] >>> 0;
      const verts = heap[off + 3] >>> 0;
      const xfbHash = heap[off + 4] >>> 0;
      const glerr = heap[off + 5] >>> 0;
      const commit = heap[off + 6] | 0; // signed
      const debugBits = heap[off + 7] >>> 0;
      console.log(
        `[frame-ring] f=${frame} prim=${prim} draw=${draw} verts=${verts} ` +
          `xfb=0x${xfbHash.toString(16)} glerr=${glerr} commit=${commit} ` +
          `dbg=0x${debugBits.toString(16)}`
      );
    }
    frameRingLastDrainHead = head;
  }, 1000);
}

function formatHex(value) {
  return `0x${Math.trunc(value).toString(16).toUpperCase()}`;
}
