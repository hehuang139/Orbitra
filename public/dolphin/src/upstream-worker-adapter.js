import {
  DEFAULT_UPSTREAM_CORE_SHA256,
  DEFAULT_UPSTREAM_CORE_URL,
  isOneWayWorkerRequestType,
  verifyUpstreamCoreWasm
} from "./upstream-worker-protocol.js";
import {
  INPUT_STATE_SLOT_COUNT,
  writeInputStateSnapshot
} from "./input-transport.js";
import {
  countTransferBytes,
  createCausalTelemetry,
  deepMerge,
  estimateMessageBytes
} from "./causal-telemetry.js";

const DEFAULT_WORKER_URL = new URL("./upstream-discio-worker.js", import.meta.url).href;

export async function upstreamBundleAvailable(coreUrl = DEFAULT_UPSTREAM_CORE_URL) {
  try {
    const response = await fetch(coreUrl, {
      method: "HEAD",
      cache: "no-store"
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class UpstreamWorkerAdapter {
  constructor({
    coreUrl = DEFAULT_UPSTREAM_CORE_URL,
    expectedCoreSha256 = DEFAULT_UPSTREAM_CORE_SHA256,
    workerUrl = DEFAULT_WORKER_URL,
    onStatus = () => {},
    canvas = null,
    transferCanvas = null,
    visibleCanvas = null,
    videoBackend = "Software Renderer",
    cpuThread = false,
    cpuCore = "cached",
    ppcWasmJit = false,
    ppcWasmJitTier = "guarded",
    ppcWasmJitForce = false,
    ppcWasmJitWarmupFrames = 3600,
    ppcProfile = false,
    cpuOverclock = 1,
    emulationSpeed = 1,
    presentationScale = 1,
    presentationQueueSize = 2,
    presenterBackend = "webgl",
    presentationPacing = "smooth",
    legacyTickQueue = false,
    oglProxyMode = "worker",
    oglTestClear = false,
    fastSoftwareRaster = 0,
    softwareTevHotCaseMode = 0,
    xfbFastPaths = 0,
    correctTimeDrift = false,
    coreLog = false,
    efbDiag = false,
    jitVerbose = false,
    frameCap = 0,
    cachedInterpreterDisableMask = 0,
    wgpuScissoredClearRect = true,
    noJitCache = false,
    collectMetrics = false,
    legacyOneWayAck = false,
    wgpuReplayDiagnostics = false,
    wgpuDeepReplayDiagnostics = false,
    wgpuDetachedPresenter = false,
    wgpuLoadEpochFence = false,
    wgpuReplayPump = false,
    wgpuReplayBudgetMs = 0,
    wgpuPowerPreference = "high-performance",
    wgpuAtomicPassReplay = true,
    wgpuDiagnosticQuiet = false,
    wgpuProducerProfile = false,
    wgpuDrawProfile = false,
    wgpuTailGate = false,
    wgpuStateCache = false,
    wgpuUboCache = false,
    wgpuUboMetrics = false,
    wgpuVpDiag = false,
    wgpuUniformFast = false,
    wgpuUboPack = false,
    wgpuSparseUbo = false,
    wgpuGeometryPack = false,
    wgpuGeometryRange = false,
    wgpuUploadArenaMiB = 32,
    wgpuUploadTransport = "queue",
    wgpuMappedStagingSlotCount = 3,
    wgpuMappedStageFast = false,
    wgpuMappedStageTimingStride = 1,
    wgpuMappedDrainCoalescing = false,
    wgpuRendererWorkerProbe = "off",
    wgpuVisualCadence = false,
    gpuCompletionDiagnostics = false,
    wgpuDirtyRangeProjection = false,
    wgpuPassPackageProjection = false,
    wgpuUploadRunProjection = false,
    wgpuUboComputeProjection = false,
    wgpuUboComputeReconstruction = false,
    wgpuOwnershipTrace = false,
    wgpuSemanticRuntime = false,
    inputLatencyDiagnostics = false,
    inputReadbackDiagnostics = false,
    inputPhotonDiagnostics = false,
    inputPhotonMarker = null,
    oglPixelSab = null,
    oglMetaSab = null,
    oglSabWidth = 0,
    oglSabHeight = 0
  } = {}) {
    this.requestedCoreUrl = coreUrl;
    this.requestedCoreSha256 = expectedCoreSha256;
    this.coreUrl = coreUrl;
    this.expectedCoreSha256 = expectedCoreSha256;
    this.coreCandidatePreflighted = false;
    this.coreFallbackReason = null;
    this.fallbackBeforeCanvasTransfer = false;
    this.workerUrl = workerUrl;
    this.onStatus = onStatus;
    this.canvas = canvas;
    this.transferCanvasFn = typeof transferCanvas === "function" ? transferCanvas : null;
    this.workerCanvas = Boolean(canvas) || Boolean(this.transferCanvasFn);
    this.visibleCanvas = visibleCanvas;
    this.detachedOglContext = null;
    this.detachedOglFramesDrawn = 0;
    this.detachedGpuFramesReceived = 0;
    this.detachedGpuFramesDropped = 0;
    this.detachedGpuDrawLastMs = 0;
    this.detachedGpuDrawMaxMs = 0;
    this.videoBackend = videoBackend;
    this.cpuThread = cpuThread;
    this.cpuCore = cpuCore;
    this.ppcWasmJit = ppcWasmJit;
    this.ppcWasmJitTier = ppcWasmJitTier === "mixed" ? "mixed" : "guarded";
    this.ppcWasmJitForce = Boolean(ppcWasmJitForce);
    this.ppcWasmJitWarmupFrames = ppcWasmJitWarmupFrames;
    this.ppcProfile = Boolean(ppcProfile);
    this.cpuOverclock = cpuOverclock;
    this.emulationSpeed = emulationSpeed;
    this.presentationScale = presentationScale;
    this.presentationQueueSize = presentationQueueSize;
    this.presenterBackend = presenterBackend;
    this.presentationPacing = presentationPacing;
    this.legacyTickQueue = Boolean(legacyTickQueue);
    this.oglProxyMode = oglProxyMode;
    this.oglTestClear = Boolean(oglTestClear);
    this.fastSoftwareRaster = Math.min(3, Math.max(0, Number(fastSoftwareRaster) || 0));
    this.softwareTevHotCaseMode = (Number(softwareTevHotCaseMode) || 0) & 3;
    this.xfbFastPaths = (Number(xfbFastPaths) || 0) & 3;
    this.correctTimeDrift = Boolean(correctTimeDrift);
    this.coreLog = Boolean(coreLog);
    this.efbDiag = Boolean(efbDiag);
    this.jitVerbose = Boolean(jitVerbose);
    this.frameCap = Number(frameCap) || 0;
    this.cachedInterpreterDisableMask = (Number(cachedInterpreterDisableMask) || 0) >>> 0;
    this.wgpuScissoredClearRect = wgpuScissoredClearRect !== false;
    this.noJitCache = Boolean(noJitCache);
    this.collectMetrics = Boolean(collectMetrics);
    this.legacyOneWayAck = Boolean(legacyOneWayAck);
    this.wgpuReplayDiagnostics = Boolean(wgpuReplayDiagnostics);
    this.wgpuDeepReplayDiagnostics = Boolean(wgpuDeepReplayDiagnostics);
    this.wgpuDetachedPresenter = Boolean(wgpuDetachedPresenter);
    this.wgpuLoadEpochFence = Boolean(wgpuLoadEpochFence);
    this.wgpuReplayPump = Boolean(wgpuReplayPump);
    this.wgpuReplayBudgetMs = [4, 6].includes(Number(wgpuReplayBudgetMs))
      ? Number(wgpuReplayBudgetMs)
      : 0;
    this.wgpuPowerPreference = wgpuPowerPreference === "low-power"
      ? "low-power"
      : "high-performance";
    this.wgpuAtomicPassReplay = Boolean(wgpuAtomicPassReplay);
    this.wgpuDiagnosticQuiet = Boolean(wgpuDiagnosticQuiet);
    this.wgpuProducerProfile = this.collectMetrics && Boolean(wgpuProducerProfile);
    this.wgpuDrawProfile = Boolean(wgpuDrawProfile);
    this.wgpuTailGate = Boolean(wgpuTailGate);
    this.wgpuStateCache = Boolean(wgpuStateCache);
    this.wgpuUboCache = Boolean(wgpuUboCache);
    this.wgpuUboMetrics = Boolean(wgpuUboMetrics);
    this.wgpuVpDiag = Boolean(wgpuVpDiag);
    this.wgpuUniformFast = Boolean(wgpuUniformFast);
    this.wgpuUboPack = Boolean(wgpuUboPack);
    this.wgpuSparseUbo = Boolean(wgpuSparseUbo);
    this.wgpuGeometryPack = Boolean(wgpuGeometryPack);
    this.wgpuGeometryRange = this.wgpuGeometryPack && Boolean(wgpuGeometryRange);
    this.wgpuUploadArenaMiB = Number(wgpuUploadArenaMiB) === 64 ? 64 : 32;
    this.wgpuUploadTransport = wgpuUploadTransport === "mapped" ? "mapped" : "queue";
    this.wgpuMappedStagingSlotCount = Number(wgpuMappedStagingSlotCount) === 4 ? 4 : 3;
    this.wgpuMappedStageFast = Boolean(wgpuMappedStageFast);
    this.wgpuMappedStageTimingStride = Number(wgpuMappedStageTimingStride) === 64 ? 64 : 1;
    this.wgpuMappedDrainCoalescing = Boolean(wgpuMappedDrainCoalescing);
    this.wgpuRendererWorkerProbe = new Set([
      "canary", "inline-upload", "worker-upload", "null-drain"
    ]).has(wgpuRendererWorkerProbe) ? wgpuRendererWorkerProbe : "off";
    this.wgpuVisualCadence = Boolean(wgpuVisualCadence);
    this.gpuCompletionDiagnostics = Boolean(gpuCompletionDiagnostics);
    this.wgpuDirtyRangeProjection = Boolean(wgpuDirtyRangeProjection);
    this.wgpuPassPackageProjection = Boolean(wgpuPassPackageProjection);
    this.wgpuUploadRunProjection = Boolean(wgpuUploadRunProjection);
    this.wgpuUboComputeProjection = Boolean(wgpuUboComputeProjection);
    this.wgpuUboComputeReconstruction = Boolean(wgpuUboComputeReconstruction);
    this.wgpuOwnershipTrace = Boolean(wgpuOwnershipTrace);
    this.wgpuSemanticRuntime = Boolean(wgpuSemanticRuntime);
    this.inputLatencyDiagnostics = Boolean(inputLatencyDiagnostics);
    this.inputReadbackDiagnostics = Boolean(inputReadbackDiagnostics);
    this.inputPhotonDiagnostics = Boolean(inputPhotonDiagnostics);
    this.inputPhotonMarker = inputPhotonMarker && typeof inputPhotonMarker === "object"
      ? { ...inputPhotonMarker }
      : null;
    this.oglPixelSab = oglPixelSab;
    this.oglMetaSab = oglMetaSab;
    this.oglSabWidth = oglSabWidth | 0;
    this.oglSabHeight = oglSabHeight | 0;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.workerTransportStats = {
      schema: "wasm-dolphin.worker-transport.v1",
      legacyOneWayAck: this.legacyOneWayAck,
      oneWayRequestsPosted: 0,
      requestMessagesPosted: 0,
      unmatchedSuccessRepliesReceived: 0,
      unmatchedErrorRepliesReceived: 0
    };
    this.loaded = false;
    this.framePending = false;
    this.lastTelemetryRequestTime = 0;
    this.telemetryIntervalMs = 250;
    this.width = 320;
    this.height = 240;
    this.coreFrame = 0;
    this.presentedFrame = 0;
    this.lastPresentedCoreFrame = -1;
    this.presentationFps = 0;
    this.presentationRawFps = 0;
    this.presentationAverageIntervalMs = 0;
    this.presentationP95IntervalMs = 0;
    this.presentationMaxIntervalMs = 0;
    this.presentationLongFrameCount = 0;
    this.presentationLifetimeMaxIntervalMs = 0;
    this.presentationLifetimeMaxIntervalAtMs = 0;
    this.presentationLifetimeDropCount = 0;
    this.presentationLifetimeFrameCount = 0;
    this.presentationIntervalStddevMs = 0;
    this.presentationIntervalHistogram = null;
    this.presentationIntervalHistogramBuckets = null;
    this.presentationFrameLag = 0;
    this.presentationQueueAgeMs = 0;
    this.visualChangeFps = 0;
    this.visualFrameHash = 0;
    this.visualSampleSource = "none";
    this.visualCadenceTelemetry = null;
    this.oglGlError = 0;
    this.coreTicks = 0;
    this.coreTicksPerSecond = 486000000;
    this.ppcPc = 0;
    this.loadedCheckpointGeneration = 0;
    this.loadedCheckpointTicks = null;
    this.loadedCheckpointPpcPc = null;
    this.cpuCoreName = "";
    this.ppcWasmBlockCompileCount = 0;
    this.ppcWasmBlockRunCount = 0;
    this.ppcWasmHelperStats = "";
    this.frameProfileStats = "-";
    this.frameData = null;
    this.lastInputStateSignature = "";
    this.workerCausalTelemetry = null;
    this.causalTelemetry = null;
    this.trafficStats = {
      mainToWorker: createTrafficDirection(),
      workerToMain: createTrafficDirection()
    };
    this.inputTelemetry = {
      mainStateChangeCount: 0,
      mainPostCount: 0,
      mainSabWriteCount: 0,
      mainGeneration: 0,
      mainSabGeneration: 0
    };
    // SharedArrayBuffer-backed input state. Bypasses postMessage queue.
    // Slots: 0=mask, 1=stickX, 2=stickY, 3=cStickX, 4=cStickY,
    //        5=triggerLeft, 6=triggerRight, 7=analogA, 8=analogB,
    //        9=generation (incremented on every changed state),
    //        10=Date.now() low 32 bits for input-age telemetry,
    //        11=odd/even seqlock. The writer publishes odd before changing
    //           fields and even after generation, so the worker cannot pair
    //           a generation with fields from a concurrent later write.
    if (typeof SharedArrayBuffer === "function") {
      this.inputStateSab = new SharedArrayBuffer(INPUT_STATE_SLOT_COUNT * Int32Array.BYTES_PER_ELEMENT);
      this.inputStateView = new Int32Array(this.inputStateSab);
    } else {
      this.inputStateSab = null;
      this.inputStateView = null;
    }
  }

  async load() {
    if (this.loaded) {
      return;
    }

    if (!this.coreCandidatePreflighted && this.coreUrl !== DEFAULT_UPSTREAM_CORE_URL) {
      try {
        await verifyUpstreamCoreWasm(this.coreUrl, this.expectedCoreSha256, window.location.href);
        this.coreCandidatePreflighted = true;
      } catch (error) {
        this.onStatus(`Candidate core rejected; rolling back to pinned baseline: ${error.message}`);
        this.coreFallbackReason = error.message;
        this.fallbackBeforeCanvasTransfer = true;
        this.coreUrl = DEFAULT_UPSTREAM_CORE_URL;
        this.expectedCoreSha256 = DEFAULT_UPSTREAM_CORE_SHA256;
        this.coreCandidatePreflighted = true;
      }
    }

    if (!this.worker) {
      const _t_worker = performance.now();
      console.log(`[boot-phase] new Worker(discio) at perf.now=${_t_worker.toFixed(1)}ms`);
      this.worker = new Worker(this.workerUrl, {
        type: "module",
        name: "dolphin-upstream-discio"
      });
      this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
      this.worker.addEventListener("error", (event) => this.rejectAll(event.message || "Upstream worker failed"));
    }
    const _t_load = performance.now();
    console.log(`[boot-phase] main-thread postMessage(load) at perf.now=${_t_load.toFixed(1)}ms`);

    const loadPayload = {
      coreUrl: new URL(this.coreUrl, window.location.href).href,
      expectedCoreSha256: this.expectedCoreSha256,
      videoBackend: this.videoBackend,
      cpuThread: this.cpuThread,
      cpuCore: this.cpuCore,
      ppcWasmJit: this.ppcWasmJit,
      ppcWasmJitTier: this.ppcWasmJitTier,
      ppcWasmJitForce: this.ppcWasmJitForce,
      ppcWasmJitWarmupFrames: this.ppcWasmJitWarmupFrames,
      ppcProfile: this.ppcProfile,
      cpuOverclock: this.cpuOverclock,
      emulationSpeed: this.emulationSpeed,
      presentationScale: this.presentationScale,
      presentationQueueSize: this.presentationQueueSize,
      presenterBackend: this.presenterBackend,
      presentationPacing: this.presentationPacing,
      legacyTickQueue: this.legacyTickQueue,
      oglProxyMode: this.oglProxyMode,
      oglTestClear: this.oglTestClear,
      fastSoftwareRaster: this.fastSoftwareRaster,
      softwareTevHotCaseMode: this.softwareTevHotCaseMode,
      xfbFastPaths: this.xfbFastPaths,
      correctTimeDrift: this.correctTimeDrift,
      coreLog: this.coreLog,
      efbDiag: this.efbDiag,
      jitVerbose: this.jitVerbose,
      frameCap: this.frameCap,
      cachedInterpreterDisableMask: this.cachedInterpreterDisableMask,
      wgpuScissoredClearRect: this.wgpuScissoredClearRect,
      noJitCache: this.noJitCache,
      collectMetrics: this.collectMetrics,
      legacyOneWayAck: this.legacyOneWayAck,
      coreSelection: this.coreSelectionTelemetry(window.location.href),
      wgpuReplayDiagnostics: this.wgpuReplayDiagnostics,
      wgpuDeepReplayDiagnostics: this.wgpuDeepReplayDiagnostics,
      wgpuDetachedPresenter: this.wgpuDetachedPresenter,
      wgpuLoadEpochFence: this.wgpuLoadEpochFence,
      wgpuReplayPump: this.wgpuReplayPump,
      wgpuReplayBudgetMs: this.wgpuReplayBudgetMs,
      wgpuPowerPreference: this.wgpuPowerPreference,
      wgpuAtomicPassReplay: this.wgpuAtomicPassReplay,
      wgpuDiagnosticQuiet: this.wgpuDiagnosticQuiet,
      wgpuProducerProfile: this.wgpuProducerProfile,
      wgpuDrawProfile: this.wgpuDrawProfile,
      wgpuTailGate: this.wgpuTailGate,
      wgpuStateCache: this.wgpuStateCache,
      wgpuUboCache: this.wgpuUboCache,
      wgpuUboMetrics: this.wgpuUboMetrics,
      wgpuVpDiag: this.wgpuVpDiag,
      wgpuUniformFast: this.wgpuUniformFast,
      wgpuUboPack: this.wgpuUboPack,
      wgpuSparseUbo: this.wgpuSparseUbo,
      wgpuGeometryPack: this.wgpuGeometryPack,
      wgpuGeometryRange: this.wgpuGeometryRange,
      wgpuUploadArenaMiB: this.wgpuUploadArenaMiB,
      wgpuUploadTransport: this.wgpuUploadTransport,
      wgpuMappedStagingSlotCount: this.wgpuMappedStagingSlotCount,
      wgpuMappedStageFast: this.wgpuMappedStageFast,
      wgpuMappedStageTimingStride: this.wgpuMappedStageTimingStride,
      wgpuMappedDrainCoalescing: this.wgpuMappedDrainCoalescing,
      wgpuRendererWorkerProbe: this.wgpuRendererWorkerProbe,
      wgpuVisualCadence: this.wgpuVisualCadence,
      gpuCompletionDiagnostics: this.gpuCompletionDiagnostics,
      wgpuDirtyRangeProjection: this.wgpuDirtyRangeProjection,
      wgpuPassPackageProjection: this.wgpuPassPackageProjection,
      wgpuUploadRunProjection: this.wgpuUploadRunProjection,
      wgpuUboComputeProjection: this.wgpuUboComputeProjection,
      wgpuUboComputeReconstruction: this.wgpuUboComputeReconstruction,
      wgpuOwnershipTrace: this.wgpuOwnershipTrace,
      wgpuSemanticRuntime: this.wgpuSemanticRuntime,
      inputLatencyDiagnostics: this.inputLatencyDiagnostics,
      inputReadbackDiagnostics: this.inputReadbackDiagnostics,
      inputPhotonDiagnostics: this.inputPhotonDiagnostics,
      inputPhotonMarker: this.inputPhotonMarker,
      inputStateSab: this.inputStateSab,
      oglPixelSab: this.oglPixelSab,
      oglMetaSab: this.oglMetaSab,
      oglSabWidth: this.oglSabWidth,
      oglSabHeight: this.oglSabHeight
    };
    const transfer = [];
    // Lazy transferControlToOffscreen: do it right at the moment we
    // postMessage to the worker, so the OffscreenCanvas hasn't had time to
    // be "used" by the main-thread compositor. Chrome rejects transferring
    // an OffscreenCanvas that has been bound to its element for too long.
    let canvasForLoad = this.canvas;
    if (!canvasForLoad && this.transferCanvasFn) {
      canvasForLoad = this.transferCanvasFn();
    }
    if (canvasForLoad) {
      loadPayload.canvas = canvasForLoad;
      transfer.push(canvasForLoad);
      this.canvas = null;
      this.transferCanvasFn = null;
    }

    let response;
    try {
      response = await this.request("load", loadPayload, transfer);
    } catch (err) {
      const msg = String(err?.message || err);
      // Some Chrome environments reject the OffscreenCanvas postMessage
      // transfer with "Cannot transfer OffscreenCanvas bound to element
      // using captureStream" because an extension or the compositor has
      // bound captureStream to the canvas. Retry once WITHOUT the canvas;
      // the worker boots, the OGL backend will fail to attach a canvas
      // but the worker stays alive so the user gets a clear status message
      // instead of a permanent black screen.
      if (/captureStream|OffscreenCanvas/i.test(msg)) {
        this.onStatus(
          `OffscreenCanvas transfer blocked by browser (captureStream binding); ` +
            `falling back to canvas-less worker. Use oglproxy=proxy for hardware OGL.`
        );
        delete loadPayload.canvas;
        response = await this.request("load", loadPayload, []);
      } else {
        throw err;
      }
    }
    this.applyMetadata(response);
    this.loaded = true;
  }

  async mountGame(file) {
    const _t_mountStart = performance.now();
    console.log(`[boot-phase] mountGame() entry at perf.now=${_t_mountStart.toFixed(1)}ms (file=${file?.size ?? "?"}B name=${file?.name ?? "?"})`);
    await this.load();
    const _t_afterLoad = performance.now();
    console.log(`[boot-phase] mountGame() after this.load() at perf.now=${_t_afterLoad.toFixed(1)}ms (load took ${(_t_afterLoad - _t_mountStart).toFixed(1)}ms)`);
    const response = await this.request("mountFile", { file });
    const _t_afterMount = performance.now();
    console.log(`[boot-phase] mountGame() mountFile responded at perf.now=${_t_afterMount.toFixed(1)}ms (mountFile took ${(_t_afterMount - _t_afterLoad).toFixed(1)}ms)`);
    this.applyMetadata(response);
    this.applyFrame(response);

    return {
      path: response.path,
      gameId: response.gameId,
      title: response.title,
      makerId: response.makerId,
      platform: response.platform,
      region: response.region,
      discNumber: response.discNumber,
      apploaderDate: response.apploaderDate,
      apploaderSize: response.apploaderSize,
      bootDolOffset: response.bootDolOffset,
      bootDolSize: response.bootDolSize,
      fstOffset: response.fstOffset,
      fstSize: response.fstSize,
      rawSize: response.rawSize,
      dataSize: response.dataSize,
      rootEntryCount: response.rootEntryCount,
      rootEntries: response.rootEntries ?? [],
      bootProbe: response.bootProbe ?? null,
      fullCore: Boolean(response.fullCore),
      coreBoot: response.coreBoot ?? null,
      coreState: response.coreState,
      coreStateName: response.coreStateName,
      coreStatus: response.coreStatus,
      coreTitle: response.coreTitle,
      coreTicks: response.coreTicks,
      ppcPc: response.ppcPc,
      cpuCoreName: response.cpuCoreName,
      ppcWasmBlockCompileCount: response.ppcWasmBlockCompileCount,
      ppcWasmBlockRunCount: response.ppcWasmBlockRunCount
    };
  }

  async probeBoot() {
    await this.load();
    const response = await this.request("bootProbe");
    return response.bootProbe;
  }

  setInputMask(mask) {
    if (!this.loaded) {
      return;
    }
    this.post("setInputMask", { mask: mask >>> 0 });
  }

  setInputState(state) {
    if (!this.loaded || !state) {
      return;
    }
    const mask = state.mask >>> 0;
    const stickX = state.stickX | 0;
    const stickY = state.stickY | 0;
    const cStickX = state.cStickX | 0;
    const cStickY = state.cStickY | 0;
    const triggerLeft = state.triggerLeft | 0;
    const triggerRight = state.triggerRight | 0;
    const analogA = state.analogA | 0;
    const analogB = state.analogB | 0;
    const signature = `${mask}:${stickX}:${stickY}:${cStickX}:${cStickY}:${triggerLeft}:${triggerRight}:${analogA}:${analogB}`;
    if (signature === this.lastInputStateSignature) {
      return;
    }
    this.lastInputStateSignature = signature;
    this.inputTelemetry.mainStateChangeCount += 1;
    const inputSentAtEpochMs = Date.now();
    let inputGeneration = (this.inputTelemetry.mainGeneration + 1) >>> 0;
    if (inputGeneration === 0) inputGeneration = 1;
    this.inputTelemetry.mainGeneration = inputGeneration;

    if (this.inputStateView) {
      writeInputStateSnapshot(this.inputStateView, {
        mask,
        stickX,
        stickY,
        cStickX,
        cStickY,
        triggerLeft,
        triggerRight,
        analogA,
        analogB,
        inputGeneration,
        sentAtEpochMs: inputSentAtEpochMs
      });
      this.inputTelemetry.mainSabGeneration = inputGeneration;
      this.inputTelemetry.mainSabWriteCount += 1;
    }
    // Always also send via postMessage. Belt-and-suspenders: if the worker
    // is between SAB-poll iterations when an input arrives (e.g. it's
    // blocked in a long pumpHostJobs() or compile burst), the message-based
    // path will deliver the update on the next event-loop tick. SAB is
    // strictly faster when the loop is healthy; postMessage is the floor.
    this.post("setInputState", {
      mask,
      stickX,
      stickY,
      cStickX,
      cStickY,
      triggerLeft,
      triggerRight,
      analogA,
      analogB,
      inputSentAtEpochMs,
      inputGeneration
    });
    this.inputTelemetry.mainPostCount += 1;
  }

  runFrame() {
    this.requestFrame();
  }

  pollFrame() {
    this.requestFrame(this.telemetryIntervalMs);
  }

  requestFrame(minIntervalMs = 0) {
    if (!this.loaded || this.framePending) {
      return;
    }
    const now = performance.now();
    if (minIntervalMs > 0 && now - this.lastTelemetryRequestTime < minIntervalMs) {
      return;
    }

    this.lastTelemetryRequestTime = now;
    this.framePending = true;
    this.request("runFrame")
      .then((response) => this.applyFrame(response))
      .catch((error) => this.onStatus(error.message))
      .finally(() => {
        this.framePending = false;
      });
  }

  readFrameRgba() {
    return this.frameData;
  }

  async mixAudio(frames = 1024) {
    if (!this.loaded) {
      return { available: false, frames: 0, channels: 2, sampleRate: 48000, samples: null };
    }

    return this.request("mixAudio", { frames });
  }

  setAudioMuted(muted) {
    if (!this.loaded) {
      return;
    }

    this.post("setAudioMuted", { muted: Boolean(muted) });
  }

  async configureAudioWorklet({ enabled, muted, sab }) {
    if (!this.loaded) return { active: false, reason: "core-not-loaded" };
    const response = await this.request("configureAudioWorklet", {
      enabled: Boolean(enabled),
      muted: Boolean(muted),
      sab: sab ?? null,
    });
    if (enabled && !response.active) {
      this.onStatus(`AudioWorklet producer unavailable; using legacy audio: ${response.reason || "unknown"}`);
    }
    return {
      active: Boolean(response.active),
      reason: String(response.reason || ""),
    };
  }

  start() {
    if (!this.loaded) {
      return;
    }
    this.request("start")
      .then((response) => this.applyFrame(response))
      .catch((error) => this.onStatus(error.message));
  }

  pause() {
    if (!this.loaded) {
      return;
    }
    this.request("pause")
      .then((response) => this.applyFrame(response))
      .catch((error) => this.onStatus(error.message));
  }

  reset() {
    if (!this.loaded) {
      return;
    }
    this.request("reset")
      .then((response) => {
        this.applyFrame(response);
        this.onStatus("Reset requested");
      })
      .catch((error) => this.onStatus(error.message));
  }

  saveState(slot) {
    if (!this.loaded) {
      return;
    }
    this.request("saveState", { slot })
      .then((response) => this.onStatus(response.saved ? `Save slot ${slot} requested` : `Save slot ${slot} unavailable`))
      .catch((error) => this.onStatus(error.message));
  }

  loadState(slot) {
    if (!this.loaded) {
      return;
    }
    this.request("loadState", { slot })
      .then((response) => {
        this.applyFrame(response);
        this.onStatus(response.loaded ? `Load slot ${slot} requested` : `Load slot ${slot} unavailable`);
      })
      .catch((error) => this.onStatus(error.message));
  }

  // Load a Dolphin save state from raw .sav bytes (transferred to the
  // worker, which FS.writeFile's it then State::LoadAs's it). Returns
  // the worker response so callers (the validator) can await + inspect
  // rc/before/after core state. Bytes are build/version sensitive.
  loadStateFile(bytes) {
    if (!this.loaded) {
      return Promise.resolve({ loaded: false, error: "not loaded" });
    }
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return this.request("loadStateFile", { bytes: u8 }, [u8.buffer])
      .then((response) => {
        this.applyFrame(response);
        this.onStatus(
          response.loaded
            ? `Save state loaded (${response.afterState || "?"})`
            : `Save state load failed (rc=${response.rc ?? "?"}${
                response.error ? " " + response.error : ""})`);
        return response;
      })
      .catch((error) => {
        this.onStatus(error.message);
        return { loaded: false, error: error.message };
      });
  }

  // Capture a version-matched Dolphin save state from THIS build.
  // Returns { saved, size, bytes (ArrayBuffer) } so the caller can
  // persist it for deterministic reuse across rebuilds.
  saveStateFile() {
    if (!this.loaded) {
      return Promise.resolve({ saved: false, error: "not loaded" });
    }
    return this.request("saveStateFile", {}, [])
      .then((r) => {
        this.onStatus(
          r.saved
            ? `Save state captured (${r.size} B)`
            : `Save state capture failed (${r.error || "?"})`);
        return r;
      })
      .catch((e) => ({ saved: false, error: e.message }));
  }

  // Reload a state already present in the worker FS (e.g. the one
  // saveStateFile just wrote) — a zero-serving version-matched
  // round-trip.
  loadStateFileFromFs(fsPath) {
    if (!this.loaded) {
      return Promise.resolve({ loaded: false, error: "not loaded" });
    }
    return this.request("loadStateFile", { fsPath })
      .then((response) => {
        this.applyFrame(response);
        this.onStatus(
          response.loaded
            ? `Save state reloaded (${response.afterState || "?"})`
            : `Save state reload failed (rc=${response.rc ?? "?"})`);
        return response;
      })
      .catch((e) => ({ loaded: false, error: e.message }));
  }

  request(type, payload = {}, transfer = []) {
    if (!this.worker) {
      throw new Error("Upstream worker has not been created");
    }

    const id = this.nextId;
    this.nextId += 1;
    recordTraffic(this.trafficStats.mainToWorker, "request", type, payload, transfer, this.collectMetrics);
    this.workerTransportStats.requestMessagesPosted += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }

  post(type, payload = {}, transfer = []) {
    if (!this.worker) {
      return;
    }

    recordTraffic(this.trafficStats.mainToWorker, "oneWay", type, payload, transfer, this.collectMetrics);
    const oneWay = isOneWayWorkerRequestType(type);
    if (oneWay) {
      this.workerTransportStats.oneWayRequestsPosted += 1;
    }
    this.worker.postMessage(
      oneWay ? { type, payload, oneWay: true } : { type, payload },
      transfer
    );
  }

  transportTelemetry() {
    return { ...this.workerTransportStats };
  }

  coreSelectionTelemetry(baseUrl = globalThis.location?.href) {
    return {
      requestedCoreSha256: this.requestedCoreSha256,
      requestedCoreUrl: resolveUrlForTelemetry(this.requestedCoreUrl, baseUrl),
      activeCoreSha256: this.expectedCoreSha256,
      activeCoreUrl: resolveUrlForTelemetry(this.coreUrl, baseUrl),
      fallbackReason: this.coreFallbackReason,
      fallbackBeforeCanvasTransfer: Boolean(
        this.coreFallbackReason && this.fallbackBeforeCanvasTransfer
      )
    };
  }

  drawDetachedOglBitmap(bitmap, width, height) {
    if (!bitmap) return;
    this.detachedGpuFramesReceived += 1;
    if (!this.visibleCanvas) {
      this.detachedGpuFramesDropped += 1;
      try { bitmap.close(); } catch {}
      return;
    }
    if (!this.detachedOglContext) {
      try {
        this.detachedOglContext = this.visibleCanvas.getContext("2d", { alpha: false });
      } catch (err) {
        this.onStatus(`Detached GPU presenter: cannot get 2D context: ${err.message}`);
        this.detachedGpuFramesDropped += 1;
        try { bitmap.close(); } catch {}
        return;
      }
      if (!this.detachedOglContext) {
        this.onStatus("Detached GPU presenter: visible canvas has no 2D context");
        this.detachedGpuFramesDropped += 1;
        try { bitmap.close(); } catch {}
        return;
      }
      this.onStatus(`Detached GPU presenter live (${this.visibleCanvas.width}x${this.visibleCanvas.height})`);
    }
    const startedAt = this.collectMetrics ? performance.now() : 0;
    try {
      this.detachedOglContext.drawImage(
        bitmap,
        0,
        0,
        this.visibleCanvas.width,
        this.visibleCanvas.height
      );
      this.detachedOglFramesDrawn += 1;
      if (startedAt) {
        this.detachedGpuDrawLastMs = performance.now() - startedAt;
        this.detachedGpuDrawMaxMs = Math.max(
          this.detachedGpuDrawMaxMs,
          this.detachedGpuDrawLastMs
        );
      }
    } catch (error) {
      this.detachedGpuFramesDropped += 1;
      this.onStatus(`Detached GPU presenter draw failed: ${error.message}`);
    }
    try { bitmap.close(); } catch {}
  }

  handleMessage(message) {
    // Stall logger: surface worker→main message handlers that take >20 ms.
    // This catches applyFrame backlog, detachedOgl bitmap draws, and
    // status floods. Correlates with PerformanceLongAnimationFrame entries.
    const handlerStartedAt = performance.now();
    const result = this._handleMessageInner(message);
    const handlerMs = performance.now() - handlerStartedAt;
    if (handlerMs > 20) {
      this._msgStallCount = (this._msgStallCount || 0) + 1;
      const isNewWorst = handlerMs > (this._msgStallWorstMs || 0);
      if (isNewWorst) this._msgStallWorstMs = handlerMs;
      if (isNewWorst || this._msgStallCount % 10 === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[msg-stall#${this._msgStallCount}${isNewWorst ? "*" : ""}] ` +
          `handler=${handlerMs.toFixed(0)}ms ` +
          `type=${message?.type || "rpc"} ` +
          `hasFrameBuffer=${Boolean(message?.payload?.frameBuffer ?? message?.frameBuffer)}`
        );
      }
    }
    return result;
  }

  _handleMessageInner(message) {
    const pendingForTraffic = this.pending.get(message?.id);
    const incomingType = pendingForTraffic?.type || message?.type || "unknown";
    recordIncomingTraffic(
      this.trafficStats.workerToMain,
      pendingForTraffic ? "response" : "notification",
      incomingType,
      message,
      this.collectMetrics
    );
    if (message?.causalTelemetry) {
      this.workerCausalTelemetry = message.causalTelemetry;
      this.refreshCausalTelemetry();
    }
    if (message?.type === "status") {
      this.onStatus(message.message);
      return;
    }

    if ((message?.type === "detachedOglFrame" ||
         message?.type === "detachedWgpuFrame") && message.bitmap) {
      // Worker has rendered a frame to its standalone OffscreenCanvas and
      // handed us the result as an ImageBitmap. Draw onto the visible
      // canvas via 2D context. Lazily create the context on first frame.
      this.drawDetachedOglBitmap(message.bitmap, message.width, message.height);
      return;
    }

    if (message?.type === "frameUpdate" && message.payload) {
      this.applyFrame(message.payload);
      return;
    }

    if (message?.id === undefined && message?.ok === true) {
      this.workerTransportStats.unmatchedSuccessRepliesReceived += 1;
      return;
    }

    if (message?.id === undefined && message?.ok === false) {
      this.workerTransportStats.unmatchedErrorRepliesReceived += 1;
      return;
    }

    const pending = this.pending.get(message?.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.error || "Upstream worker request failed"));
    }
  }

  rejectAll(message) {
    for (const { reject } of this.pending.values()) {
      reject(new Error(message));
    }
    this.pending.clear();
  }

  applyMetadata(response) {
    if (response?.causalTelemetry) {
      this.workerCausalTelemetry = response.causalTelemetry;
      this.refreshCausalTelemetry();
    }
    this.width = response.width || this.width;
    this.height = response.height || this.height;
    if (Number.isFinite(response.coreTicks)) {
      this.coreTicks = response.coreTicks;
    }
    if (Number.isFinite(response.coreTicksPerSecond) && response.coreTicksPerSecond > 0) {
      this.coreTicksPerSecond = response.coreTicksPerSecond;
    }
    if (Number.isFinite(response.ppcPc)) {
      this.ppcPc = response.ppcPc >>> 0;
    }
    if (Number.isFinite(response.loadedCheckpointGeneration)) {
      this.loadedCheckpointGeneration = response.loadedCheckpointGeneration >>> 0;
    }
    if (Number.isFinite(response.loadedCheckpointTicks)) {
      this.loadedCheckpointTicks = response.loadedCheckpointTicks;
    }
    if (Number.isFinite(response.loadedCheckpointPpcPc)) {
      this.loadedCheckpointPpcPc = response.loadedCheckpointPpcPc;
    }
    if (response.cpuCoreName) {
      this.cpuCoreName = response.cpuCoreName;
    }
    if (Number.isFinite(response.ppcWasmBlockCompileCount)) {
      this.ppcWasmBlockCompileCount = response.ppcWasmBlockCompileCount;
    }
    if (Number.isFinite(response.ppcWasmBlockRunCount)) {
      this.ppcWasmBlockRunCount = response.ppcWasmBlockRunCount;
    }
    if (typeof response.ppcWasmHelperStats === "string") {
      this.ppcWasmHelperStats = response.ppcWasmHelperStats;
    }
    if (typeof response.frameProfileStats === "string") {
      this.frameProfileStats = response.frameProfileStats;
    }
  }

  applyFrame(response) {
    this.applyMetadata(response);

    if (Number.isFinite(response.frame)) {
      this.coreFrame = response.frame;
      if (Number.isFinite(response.presentedFrame)) {
        this.presentedFrame = response.presentedFrame;
        this.lastPresentedCoreFrame = response.frame;
      } else if (response.frame !== this.lastPresentedCoreFrame) {
        this.presentedFrame += 1;
        this.lastPresentedCoreFrame = response.frame;
      }
    }
    if (Number.isFinite(response.presentationFps)) {
      this.presentationFps = response.presentationFps;
    }
    if (Number.isFinite(response.presentationRawFps)) {
      this.presentationRawFps = response.presentationRawFps;
    }
    if (Number.isFinite(response.presentationAverageIntervalMs)) {
      this.presentationAverageIntervalMs = response.presentationAverageIntervalMs;
    }
    if (Number.isFinite(response.presentationP95IntervalMs)) {
      this.presentationP95IntervalMs = response.presentationP95IntervalMs;
    }
    if (Number.isFinite(response.presentationMaxIntervalMs)) {
      this.presentationMaxIntervalMs = response.presentationMaxIntervalMs;
    }
    if (Number.isFinite(response.presentationLongFrameCount)) {
      this.presentationLongFrameCount = response.presentationLongFrameCount;
    }
    if (Number.isFinite(response.presentationLifetimeMaxIntervalMs)) {
      this.presentationLifetimeMaxIntervalMs = response.presentationLifetimeMaxIntervalMs;
    }
    if (Number.isFinite(response.presentationLifetimeMaxIntervalAtMs)) {
      this.presentationLifetimeMaxIntervalAtMs = response.presentationLifetimeMaxIntervalAtMs;
    }
    if (Number.isFinite(response.presentationLifetimeDropCount)) {
      this.presentationLifetimeDropCount = response.presentationLifetimeDropCount;
    }
    if (Number.isFinite(response.presentationLifetimeFrameCount)) {
      this.presentationLifetimeFrameCount = response.presentationLifetimeFrameCount;
    }
    if (Number.isFinite(response.presentationIntervalStddevMs)) {
      this.presentationIntervalStddevMs = response.presentationIntervalStddevMs;
    }
    if (Array.isArray(response.presentationIntervalHistogram)) {
      this.presentationIntervalHistogram = response.presentationIntervalHistogram;
    }
    if (Array.isArray(response.presentationIntervalHistogramBuckets)) {
      this.presentationIntervalHistogramBuckets = response.presentationIntervalHistogramBuckets;
    }
    if (Number.isFinite(response.presentationFrameLag)) {
      this.presentationFrameLag = response.presentationFrameLag;
    }
    if (Number.isFinite(response.presentationQueueAgeMs)) {
      this.presentationQueueAgeMs = response.presentationQueueAgeMs;
    }
    if (Number.isFinite(response.visualChangeFps)) {
      this.visualChangeFps = response.visualChangeFps;
    }
    if (Number.isFinite(response.visualFrameHash)) {
      this.visualFrameHash = response.visualFrameHash;
    }
    if (typeof response.visualSampleSource === "string") {
      this.visualSampleSource = response.visualSampleSource;
    }
    if (response.visualCadenceTelemetry &&
        typeof response.visualCadenceTelemetry === "object") {
      this.visualCadenceTelemetry = { ...response.visualCadenceTelemetry };
    }
    if (Number.isFinite(response.oglGlError)) {
      this.oglGlError = response.oglGlError;
    }

    if (response.frameBuffer) {
      this.frameData = new Uint8ClampedArray(response.frameBuffer);
    }
  }

  refreshCausalTelemetry() {
    if (!this.collectMetrics || !this.workerCausalTelemetry) {
      this.causalTelemetry = null;
      return;
    }
    this.causalTelemetry = createCausalTelemetry(deepMerge(this.workerCausalTelemetry, {
      workerTraffic: cloneTrafficStats(this.trafficStats),
      input: { ...this.inputTelemetry },
      presentation: {
        detachedBitmapReceivedCount: this.detachedGpuFramesReceived,
        detachedBitmapDrawnCount: this.detachedOglFramesDrawn,
        detachedBitmapDroppedCount: this.detachedGpuFramesDropped
      },
      host: {
        detachedBitmapDrawLastMs: this.detachedGpuDrawLastMs,
        detachedBitmapDrawMaxMs: this.detachedGpuDrawMaxMs
      }
    }));
  }
}

function createTrafficDirection() {
  return {
    requestCount: 0,
    oneWayCount: 0,
    responseCount: 0,
    notificationCount: 0,
    transferBytes: 0,
    estimatedPayloadBytes: 0,
    byType: {}
  };
}

function recordTraffic(direction, kind, type, payload, transfer, detailed) {
  if (kind === "request") direction.requestCount += 1;
  else direction.oneWayCount += 1;
  direction.transferBytes += countTransferBytes(transfer);
  if (detailed) {
    direction.estimatedPayloadBytes += estimateMessageBytes(payload);
    direction.byType[type] = (direction.byType[type] || 0) + 1;
  }
}

function recordIncomingTraffic(direction, kind, type, message, detailed) {
  if (kind === "response") direction.responseCount += 1;
  else direction.notificationCount += 1;
  direction.transferBytes += Math.max(0, Number(message?.telemetryTransferBytes) || 0);
  if (detailed) {
    direction.estimatedPayloadBytes += estimateMessageBytes(message);
    direction.byType[type] = (direction.byType[type] || 0) + 1;
  }
}

function cloneTrafficStats(stats) {
  return Object.fromEntries(Object.entries(stats).map(([direction, value]) => [
    direction,
    { ...value, byType: { ...value.byType } }
  ]));
}

function resolveUrlForTelemetry(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return String(value || "");
  }
}
