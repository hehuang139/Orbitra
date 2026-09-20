import { createWgpuUploadAttribution } from "./wgpu-upload-attribution.js";
import { createWgpuPassPackageProjection } from "./wgpu-pass-package-projection.js";
import { createWgpuOwnershipTrace } from "./wgpu-ownership-trace.js";
import {
  WGPU_DRAW_PROFILE_PHASE_ORDER,
  WGPU_DRAW_PROFILE_SCHEMA,
  WGPU_PRODUCER_PROFILE_PHASE_ORDER,
  WGPU_PRODUCER_PROFILE_SCHEMA,
} from "./wgpu-pass-state-cache.js";

export const CAUSAL_TELEMETRY_SCHEMA_VERSION = 3;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const nullable = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

export function createCausalTelemetry(overrides = {}) {
  const telemetry = deepMerge(
    {
      schemaVersion: CAUSAL_TELEMETRY_SCHEMA_VERSION,
      enabled: false,
      capturedAtMs: 0,
      core: {
        frame: 0,
        ticks: 0,
        ticksPerSecond: 0,
        ppcPc: 0,
        loadedCheckpointGeneration: 0,
        loadedCheckpointTicks: null,
        loadedCheckpointPpcPc: null,
      },
      softwareRaster: {
        sourceXfbCount: 0,
        sourceWidth: 0,
        sourceHeight: 0,
        sourceStrideBytes: 0,
        sourceHash: null,
        sourceNonZeroPixels: 0,
        xfbIntervalLastMs: null,
        xfbIntervalAverageMs: null,
        xfbIntervalMaxMs: null,
        xfbDecodeLastMs: null,
        xfbDecodeAverageMs: null,
        xfbDecodeMaxMs: null,
        outputSyncLastMs: null,
        outputSyncMaxMs: null,
        outputPublishLastMs: null,
        outputPublishMaxMs: null,
        outputTotalLastMs: null,
        outputTotalMaxMs: null,
        encodeTotalMs: null,
        encodeConvertMs: null,
        encodeCopyMs: null,
        profileEnabled: false,
        caseSampleSeed: 0,
        rasterTraversalCount: 0,
        rasterTraversalTimedSampleCount: 0,
        rasterTraversalSampledTotalMs: null,
        rasterTraversalSampledAverageMs: null,
        rasterCandidatePixelCount: 0,
        tevPixelCount: 0,
        tevStageCount: 0,
        tevTimedSampleCount: 0,
        tevSampledTotalMs: null,
        tevSampledAverageMs: null,
        textureSampleCount: 0,
        textureTimedSampleCount: 0,
        textureSampledTotalMs: null,
        textureSampledAverageMs: null,
        textureCases: emptyRasterCaseProfile(),
        tevCases: emptyRasterCaseProfile(),
        fifoBurstCount: 0,
        fifoConsumeCount: 0,
        fifoBytesLast: 0,
        fifoBytesMax: 0,
        fifoConsumerObservedBacklogAgeLastMs: null,
        fifoConsumerObservedBacklogAgeMaxMs: null,
        // Deprecated schema-v2 compatibility names. These are aliases for
        // consumer-observed continuous-backlog age, not oldest-item latency.
        fifoOldestPendingAgeLastMs: null,
        fifoOldestPendingAgeMaxMs: null,
        fifoAgeSampleCount: 0,
        fifoDistanceUnderflowCount: 0,
        xfbGenerationCount: 0,
        xfbGenerationLastMs: null,
        xfbGenerationTotalMs: null,
        xfbGenerationMaxMs: null,
        frameGenerationCount: 0,
        frameGenerationIntervalLastMs: null,
        frameGenerationIntervalAverageMs: null,
        frameGenerationIntervalMaxMs: null,
        sampledSourceFrameCount: 0,
        sampledUniqueFrameCount: 0,
        sampledStaleFrameCount: 0,
        sampledStaleFrameRatio: 0,
        sampledStaleFrameRunLast: 0,
        sampledStaleFrameRunMax: 0,
        staleRepaintCount: 0,
      },
      presentation: {
        backend: "none",
        pacingMode: "unknown",
        freshFrameDelivery: "unknown",
        legacyTickQueue: false,
        presentedFrames: 0,
        fps: 0,
        rawFps: 0,
        loopFps: 0,
        visualFps: 0,
        queueDepth: 0,
        queueTarget: 0,
        queueLimit: 0,
        queueAgeMs: 0,
        queueAgeAverageMs: 0,
        queueAgeMaxMs: 0,
        queueDepthHighWater: 0,
        immediateFreshFrameCount: 0,
        queuedFreshFrameCount: 0,
        tickRepaintCount: 0,
        frameLag: 0,
        underrunCount: 0,
        droppedFrameCount: 0,
        intervalAverageMs: 0,
        intervalP95Ms: 0,
        intervalMaxMs: 0,
        intervalLifetimeMaxMs: 0,
        intervalLongFrameCount: 0,
        js: emptyStageWindow(),
        gpuCompletion: emptyGpuCompletionTelemetry(),
      },
      webgpu: {
        registered: false,
        drainCount: 0,
        emptyDrainCount: 0,
        commandsProcessed: 0,
        drainLastMs: 0,
        drainTotalMs: 0,
        drainMaxMs: 0,
        backlogLast: 0,
        backlogHighWater: 0,
        backlogSampleP95: 0,
        backlogSampleCount: 0,
        backlogSampleAverage: 0,
        backlogAfterLast: 0,
        backlogAfterHighWater: 0,
        backlogIntegralRecordMs: 0,
        backlogNonzeroAgeLastMs: 0,
        backlogNonzeroAgeMaxMs: 0,
        replayBudgetEnabled: false,
        replayBudgetMs: 0,
        replayBudgetCheckIntervalRecords: 32,
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
        drainDurationBucketBoundsMs: [2, 4, 6, 8, 12, 20, 50],
        drainDurationHistogram: [0, 0, 0, 0, 0, 0, 0, 0],
        drainCommandBucketBounds: [0, 32, 128, 512, 2048, 8192, 16384],
        drainCommandHistogram: [0, 0, 0, 0, 0, 0, 0, 0],
        replayPumpScheduleCount: 0,
        replayPumpBacklogScheduleCount: 0,
        replayPumpIdleScheduleCount: 0,
        replayPumpWakeCount: 0,
        replayPumpWakeDelayLastMs: 0,
        replayPumpWakeDelayTotalMs: 0,
        replayPumpWakeDelayMaxMs: 0,
        replayPumpWakeDelayAverageMs: 0,
        stageBudgetYieldCount: 0,
        stageCopyDeadlineOverrunCount: 0,
        stageCopyDeadlineOverrunMaxMs: 0,
        deferredBeginPassCount: 0,
        errorCount: 0,
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
        producerUploadArenaRequestedBytes: 0,
        producerUploadArenaConfiguredBytes: 0,
        producerUploadArenaFallbackCount: 0,
        producerUploadArenaLateRejectCount: 0,
        producerUploadArenaWrapCount: 0,
        producerUploadArenaInflightHighWaterBytes: 0,
        producerRingWaitCount: 0,
        producerRingWaitTotalUs: 0,
        producerRingWaitMaxUs: 0,
        producerUploadWaitCount: 0,
        producerUploadWaitTotalUs: 0,
        producerUploadWaitMaxUs: 0,
        rendererWorkerProbe: {
          requested: "off",
          active: false,
          passed: false,
          schema: "",
          adapterMs: 0,
          deviceMs: 0,
          gpuCompletionMs: 0,
          mapMs: 0,
          totalMs: 0,
          error: "",
          executorLocation: "",
          blankOutput: false,
          sharedHeap: false,
          protocolVersion: 0,
          claimedOwner: 0,
          claimCount: 0,
          conflictCount: 0,
          handoffAckCount: 0,
          observedRecordCount: 0,
          consumedRecordCount: 0,
          skippedRecordCount: 0,
          invalidRecordCount: 0,
          unknownOpcodeCount: 0,
          opHistogram: new Array(25).fill(0),
          streamDigest: "",
          uploadRecordCount: 0,
          releasedUploadCount: 0,
          totalUploadBytes: 0,
          invalidUploadSpanCount: 0,
          uploadReleaseMismatchCount: 0,
          submissionCount: 0,
          gpuCompletionCount: 0,
          gpuCompletionP95Ms: 0,
          fatalCount: 0,
          fatalScope: "",
          consumerState: 0,
          consumerError: 0,
          backlog: 0,
          quiesced: false,
        },
        producerUboChangeMaskHistogram: [0, 0, 0, 0, 0, 0, 0, 0],
        producerUboPackEnabled: false,
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
        producerUniformFastEnabled: false,
        producerUniformFastClassOrder: ["vs", "ps", "gs"],
        producerUniformFastSkippedComparisons: [0, 0, 0],
        producerUniformFastKeptComparisons: [0, 0, 0],
        producerUniformFastChangedComparisons: [0, 0, 0],
        queueSubmissionCount: 0,
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
        uploadAttribution: createWgpuUploadAttribution().snapshot({ enabled: false }),
        passPackageProjection: createWgpuPassPackageProjection().snapshot({
          requested: false,
          active: false,
        }),
        ownershipTrace: createWgpuOwnershipTrace().snapshot(),
      },
      workerTraffic: {
        mainToWorker: emptyTrafficDirection(),
        workerToMain: emptyTrafficDirection(),
      },
      audio: {
        requestedTransport: "legacy",
        activeTransport: "legacy",
        transportFallbackReason: "",
        workletRing: null,
        workerMixCount: 0,
        workerRequestedFrames: 0,
        workerReturnedFrames: 0,
        workerEmptyMixCount: 0,
        workerMixLastMs: 0,
        workerMixTotalMs: 0,
        workerMixMaxMs: 0,
        pumpCount: 0,
        pumpPendingSkipCount: 0,
        pumpMissCount: 0,
        pumpGapLastMs: 0,
        pumpGapAverageMs: 0,
        pumpGapMaxMs: 0,
        mixRoundTripAverageMs: 0,
        mixRoundTripMaxMs: 0,
        underrunCount: 0,
        overrunCount: 0,
        scheduleLeadSeconds: 0,
        scheduleDriftSeconds: 0,
      },
      input: {
        mainStateChangeCount: 0,
        mainPostCount: 0,
        mainSabWriteCount: 0,
        mainGeneration: 0,
        mainSabGeneration: 0,
        workerPostApplyCount: 0,
        workerSabApplyCount: 0,
        workerSabGeneration: 0,
        ageLastMs: 0,
        ageAverageMs: 0,
        ageMaxMs: 0,
        visible: emptyInputVisibleLatencyTelemetry(),
        marker: {
          enabled: false,
          appliedCount: 0,
          duplicateApplyCount: 0,
          supersededCount: 0,
          supersededArmedCount: 0,
          droppedInFlightCount: 0,
          exactCorePollCount: 0,
          generationMismatchCount: 0,
          generationUnavailableCount: 0,
          markerArmedCount: 0,
          markerSubmittedCount: 0,
          markerCompletedCount: 0,
          duplicateSubmitCount: 0,
          duplicateCompleteCount: 0,
          retiredCompletedMarkerCount: 0,
          expiredMarkerCount: 0,
          expiredInFlightCount: 0,
          pendingGeneration: 0,
          activeGeneration: 0,
          inFlightCount: 0,
          completionAgeLastMs: 0,
          completionAgeP95Ms: 0,
          pollToCompletionLastMs: 0,
          pollToCompletionP95Ms: 0,
          lastCompletedGeneration: 0,
          lastCompletionKind: "",
          overhead: emptyInputPhotonOverheadTelemetry(),
        },
      },
      host: {
        rafLoopCount: 0,
        rafLoopLastMs: 0,
        rafLoopAverageMs: 0,
        rafLoopMaxMs: 0,
        renderLastMs: 0,
        publishLastMs: 0,
        rgbaCopyLastMs: 0,
        putImageDataLastMs: 0,
        drawImageLastMs: 0,
      },
    },
    overrides
  );
  const raster = telemetry.softwareRaster;
  if (raster.fifoConsumerObservedBacklogAgeLastMs == null)
    raster.fifoConsumerObservedBacklogAgeLastMs = raster.fifoOldestPendingAgeLastMs;
  if (raster.fifoConsumerObservedBacklogAgeMaxMs == null)
    raster.fifoConsumerObservedBacklogAgeMaxMs = raster.fifoOldestPendingAgeMaxMs;
  if (raster.fifoOldestPendingAgeLastMs == null)
    raster.fifoOldestPendingAgeLastMs = raster.fifoConsumerObservedBacklogAgeLastMs;
  if (raster.fifoOldestPendingAgeMaxMs == null)
    raster.fifoOldestPendingAgeMaxMs = raster.fifoConsumerObservedBacklogAgeMaxMs;
  return telemetry;
}

export function emptyStageWindow() {
  return {
    elapsedMs: 0,
    capture: emptyStage(),
    copy: emptyStage(),
    draw: emptyStage(),
    hash: emptyStage(),
    present: emptyStage(),
    paced: emptyStage(),
    loop: emptyStage(),
    pump: emptyStage(),
    run: emptyStage(),
    api: emptyStage(),
    copyBytes: 0,
    copyMegabytesPerSecond: 0,
  };
}

export function emptyRasterCaseProfile() {
  return {
    sampledCount: 0,
    workCount: 0,
    otherSampleCount: 0,
    otherWorkCount: 0,
    collisionCount: 0,
    topCases: [],
  };
}

export function stageWindowFromProfile(profile = {}, elapsedMs = 0) {
  const result = emptyStageWindow();
  result.elapsedMs = finite(elapsedMs);
  for (const name of ["capture", "copy", "draw", "hash", "present", "paced", "loop", "pump", "run", "api"]) {
    const count = finite(profile[`${name}Count`]);
    const totalMs = finite(profile[`${name}Ms`]);
    result[name] = { count, totalMs, averageMs: count > 0 ? totalMs / count : 0 };
  }
  result.copyBytes = finite(profile.copyBytes);
  result.copyMegabytesPerSecond =
    result.elapsedMs > 0 ? result.copyBytes / 1048576 / (result.elapsedMs / 1000) : 0;
  return result;
}

function unpackBits(value, shift, width) {
  return Math.floor(Number(value) / (2 ** shift)) % (2 ** width);
}

function parseCaseHeader(match) {
  return {
    sampledCount: finite(match?.[1]),
    workCount: finite(match?.[2]),
    otherSampleCount: finite(match?.[3]),
    otherWorkCount: finite(match?.[4]),
    collisionCount: finite(match?.[5]),
  };
}

function parseTextureCaseProfile(match) {
  const profile = { ...emptyRasterCaseProfile(), ...parseCaseHeader(match) };
  const encoded = String(match?.[6] || "");
  if (!encoded || encoded === "-") return profile;
  profile.topCases = encoded.split(",").flatMap((entry) => {
    const parsed = /^([0-9a-f]+)=(\d+)\/(\d+)$/i.exec(entry);
    if (!parsed) return [];
    const packed = Number.parseInt(parsed[1], 16);
    if (!Number.isSafeInteger(packed)) return [];
    return [{
      key: `0x${parsed[1].toLowerCase()}`,
      sampleCount: finite(parsed[2]),
      decodeWorkCount: finite(parsed[3]),
      textureFormat: unpackBits(packed, 0, 4),
      linear: unpackBits(packed, 4, 1) === 1,
      mipmapFilter: unpackBits(packed, 5, 2),
      baseMip: unpackBits(packed, 7, 5),
      mipLinear: unpackBits(packed, 12, 1) === 1,
      wrapS: unpackBits(packed, 13, 2),
      wrapT: unpackBits(packed, 15, 2),
      manuallyManaged: unpackBits(packed, 17, 1) === 1,
      tlutFormat: unpackBits(packed, 18, 2),
      widthPowerOfTwo: unpackBits(packed, 20, 1) === 1,
      heightPowerOfTwo: unpackBits(packed, 21, 1) === 1,
      decodeWorkPerSample: unpackBits(packed, 22, 4),
      minFilter: unpackBits(packed, 26, 1),
      magFilter: unpackBits(packed, 27, 1),
    }];
  });
  return profile;
}

function parseTevCaseProfile(match) {
  const profile = { ...emptyRasterCaseProfile(), ...parseCaseHeader(match) };
  const encoded = String(match?.[6] || "");
  if (!encoded || encoded === "-") return profile;
  profile.topCases = encoded.split(",").flatMap((entry) => {
    const parsed =
      /^([0-9a-f]+)\.([0-9a-f]+)(?:@(\d+)((?:\.[0-9a-f]+)+))?=(\d+)\/(\d+)$/i.exec(entry);
    if (!parsed) return [];
    const structure = Number.parseInt(parsed[1], 16);
    if (!Number.isSafeInteger(structure)) return [];
    const canonicalProgramSchema = parsed[3] == null ? null : Number.parseInt(parsed[3], 10);
    const rawCanonicalWords = parsed[4] == null ? [] : parsed[4].slice(1).split(".");
    const canonicalWordValues = rawCanonicalWords.map((word) => Number.parseInt(word, 16));
    if (
      canonicalWordValues.some(
        (word) => !Number.isSafeInteger(word) || word < 0 || word > 0xffffffff
      )
    ) {
      return [];
    }
    if (canonicalProgramSchema === 1 && canonicalWordValues.length !== 9) return [];
    const canonicalProgramWords = canonicalWordValues.map((word) => `0x${word.toString(16)}`);
    const canonicalProgram = canonicalProgramSchema == null
      ? {}
      : {
          canonicalProgramSchema,
          canonicalProgramWords,
          ...(canonicalProgramSchema === 1
            ? {
                genModeHex: canonicalProgramWords[0],
                tevIndirectReferenceHex: canonicalProgramWords[1],
                orderWord: canonicalProgramWords[2],
                indirectWord: canonicalProgramWords[3],
                colorCombinerHex: canonicalProgramWords[4],
                alphaCombinerHex: canonicalProgramWords[5],
                konstWord: canonicalProgramWords[6],
                rasterSwapWord: canonicalProgramWords[7],
                textureSwapWord: canonicalProgramWords[8],
              }
            : {}),
        };
    return [{
      structuralKey: `0x${parsed[1].toLowerCase()}`,
      programFingerprint: `0x${parsed[2].toLowerCase()}`,
      sampleCount: finite(parsed[5]),
      stageWorkCount: finite(parsed[6]),
      tevStageCount: unpackBits(structure, 0, 5),
      indirectStageCount: unpackBits(structure, 5, 3),
      textureGenerationCount: unpackBits(structure, 8, 4),
      colorChannelCount: unpackBits(structure, 12, 3),
      textureEnabledStageCount: unpackBits(structure, 15, 5),
      activeIndirectStageCount: unpackBits(structure, 20, 5),
      usedIndirectTextureMask: unpackBits(structure, 25, 4),
      colorCompareStageCount: unpackBits(structure, 29, 5),
      alphaCompareStageCount: unpackBits(structure, 34, 5),
      colorClampStageCount: unpackBits(structure, 39, 5),
      alphaClampStageCount: unpackBits(structure, 44, 5),
      ...canonicalProgram,
    }];
  });
  return profile;
}

export function parseCoreProfileTelemetry(text = "") {
  const source = String(text || "");
  const xfb = /\bxfb:(\d+)(?:\s+(\d+)x(\d+))?/i.exec(source);
  const stride = /\bstride:(\d+)/i.exec(source);
  const hash = /\bhash:([0-9a-f]+)/i.exec(source);
  const nonZero = /\bnz:(\d+)/i.exec(source);
  const profile = /\bcoreprof\s+xfb_dt:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+decode:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+vo_sync:([\d.]+)\/max([\d.]+)\s+vo_pub:([\d.]+)\/max([\d.]+)\s+vo_total:([\d.]+)\/max([\d.]+)\s+swxfb:([\d.]+)\s+conv:([\d.]+)\s+copy:([\d.]+)/.exec(source);
  const number = (match, index) => nullable(match?.[index]);
  const swphase = /\bswphase:(\d+)/i.exec(source);
  const caseSampleSeed = /\bcaseseed:(\d+)/i.exec(source);
  const raster = /\brast:(\d+)\/(\d+)\/(\d+)\/(\d+)/i.exec(source);
  const tev = /\btev:(\d+)\/(\d+)\/(\d+)\/(\d+)/i.exec(source);
  const texture = /\btex:(\d+)\/(\d+)\/(\d+)/i.exec(source);
  const textureCases = /\btexcase:(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+):([^\s|]+)/i.exec(source);
  const tevCases = /\btevcase:(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+):([^\s|]+)/i.exec(source);
  const fifo = /\bfifo:(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/i.exec(source);
  const fifoUnderflow = /\bfifouf:(\d+)/i.exec(source);
  const xfbGeneration = /\bxfbgen:(\d+)\/(\d+)\/(\d+)\/(\d+)/i.exec(source);
  const frameGeneration = /\bframegen:(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/i.exec(source);
  const micros = (match, index) => {
    const value = number(match, index);
    return value == null ? null : value / 1000;
  };
  const sampledAverage = (match, totalIndex, countIndex) => {
    const totalMs = micros(match, totalIndex);
    const count = finite(match?.[countIndex]);
    return totalMs == null || count <= 0 ? null : totalMs / count;
  };
  return {
    sourceXfbCount: finite(xfb?.[1]),
    sourceWidth: finite(xfb?.[2]),
    sourceHeight: finite(xfb?.[3]),
    sourceStrideBytes: finite(stride?.[1]),
    sourceHash: hash?.[1] ?? null,
    sourceNonZeroPixels: finite(nonZero?.[1]),
    xfbIntervalLastMs: number(profile, 1),
    xfbIntervalAverageMs: number(profile, 2),
    xfbIntervalMaxMs: number(profile, 3),
    xfbDecodeLastMs: number(profile, 4),
    xfbDecodeAverageMs: number(profile, 5),
    xfbDecodeMaxMs: number(profile, 6),
    outputSyncLastMs: number(profile, 7),
    outputSyncMaxMs: number(profile, 8),
    outputPublishLastMs: number(profile, 9),
    outputPublishMaxMs: number(profile, 10),
    outputTotalLastMs: number(profile, 11),
    outputTotalMaxMs: number(profile, 12),
    encodeTotalMs: number(profile, 13),
    encodeConvertMs: number(profile, 14),
    encodeCopyMs: number(profile, 15),
    profileEnabled: swphase?.[1] === "1",
    caseSampleSeed: finite(caseSampleSeed?.[1]),
    rasterTraversalCount: finite(raster?.[1]),
    rasterTraversalTimedSampleCount: finite(raster?.[2]),
    rasterTraversalSampledTotalMs: micros(raster, 3),
    rasterTraversalSampledAverageMs: sampledAverage(raster, 3, 2),
    rasterCandidatePixelCount: finite(raster?.[4]),
    tevPixelCount: finite(tev?.[1]),
    tevStageCount: finite(tev?.[2]),
    tevTimedSampleCount: finite(tev?.[3]),
    tevSampledTotalMs: micros(tev, 4),
    tevSampledAverageMs: sampledAverage(tev, 4, 3),
    textureSampleCount: finite(texture?.[1]),
    textureTimedSampleCount: finite(texture?.[2]),
    textureSampledTotalMs: micros(texture, 3),
    textureSampledAverageMs: sampledAverage(texture, 3, 2),
    textureCases: parseTextureCaseProfile(textureCases),
    tevCases: parseTevCaseProfile(tevCases),
    fifoBurstCount: finite(fifo?.[1]),
    fifoConsumeCount: finite(fifo?.[2]),
    fifoBytesLast: finite(fifo?.[3]),
    fifoBytesMax: finite(fifo?.[4]),
    fifoConsumerObservedBacklogAgeLastMs: micros(fifo, 5),
    fifoConsumerObservedBacklogAgeMaxMs: micros(fifo, 6),
    fifoOldestPendingAgeLastMs: micros(fifo, 5),
    fifoOldestPendingAgeMaxMs: micros(fifo, 6),
    fifoAgeSampleCount: finite(fifo?.[7]),
    fifoDistanceUnderflowCount: finite(fifoUnderflow?.[1]),
    xfbGenerationCount: finite(xfbGeneration?.[1]),
    xfbGenerationLastMs: micros(xfbGeneration, 2),
    xfbGenerationTotalMs: micros(xfbGeneration, 3),
    xfbGenerationMaxMs: micros(xfbGeneration, 4),
    frameGenerationCount: finite(frameGeneration?.[1]),
    frameGenerationIntervalLastMs: micros(frameGeneration, 2),
    frameGenerationIntervalAverageMs:
      finite(frameGeneration?.[5]) > 0
        ? (finite(frameGeneration?.[3]) / 1000) / finite(frameGeneration?.[5])
        : null,
    frameGenerationIntervalMaxMs: micros(frameGeneration, 4),
  };
}

export function countTransferBytes(values = []) {
  let total = 0;
  const seen = new Set();
  for (const value of values || []) {
    const buffer = value instanceof ArrayBuffer
      ? value
      : ArrayBuffer.isView(value)
        ? value.buffer
        : null;
    if (buffer && !seen.has(buffer)) {
      seen.add(buffer);
      total += buffer.byteLength;
    }
  }
  return total;
}

export function estimateMessageBytes(value, seen = new Set()) {
  if (value == null || typeof value === "boolean") return 0;
  if (typeof value === "number") return 8;
  if (typeof value === "string") return value.length * 2;
  if (typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  let total = 0;
  for (const [key, child] of Object.entries(value)) total += key.length * 2 + estimateMessageBytes(child, seen);
  return total;
}

export function flattenCausalTelemetry(value) {
  const valid = value?.schemaVersion === CAUSAL_TELEMETRY_SCHEMA_VERSION;
  const telemetry = valid ? value : createCausalTelemetry();
  const topTevCase = telemetry.softwareRaster.tevCases.topCases[0];
  const inputPhotonOverhead = deepMerge(
    emptyInputPhotonOverheadTelemetry(),
    telemetry.input?.marker?.overhead ?? {}
  );
  const uploadAttribution = deepMerge(
    createWgpuUploadAttribution().snapshot({ enabled: false }),
    telemetry.webgpu.uploadAttribution ?? {}
  );
  const uploadPassAssociation = uploadAttribution.passAssociation;
  const queueWrite = uploadAttribution.queueWrite;
  const mappedStageTiming = uploadAttribution.mappedStageTiming;
  const capacityWait = uploadAttribution.capacityWait;
  const passPackageProjection = deepMerge(
    createWgpuPassPackageProjection().snapshot({ requested: false, active: false }),
    telemetry.webgpu.passPackageProjection ?? {}
  );
  const ownershipTrace = deepMerge(
    createWgpuOwnershipTrace().snapshot(),
    telemetry.webgpu.ownershipTrace ?? {}
  );
  const flattened = {
    causalTelemetrySchemaVersion: telemetry.schemaVersion,
    causalCoreTicks: telemetry.core.ticks,
    causalLoadedCheckpointGeneration: telemetry.core.loadedCheckpointGeneration,
    causalLoadedCheckpointTicks: telemetry.core.loadedCheckpointTicks,
    causalLoadedCheckpointPpcPc: telemetry.core.loadedCheckpointPpcPc,
    causalSourceXfbCount: telemetry.softwareRaster.sourceXfbCount,
    causalSoftwareEncodeMs: telemetry.softwareRaster.encodeTotalMs,
    causalXfbDecodeMs: telemetry.softwareRaster.xfbDecodeLastMs,
    causalSoftwareRasterProfileEnabled: telemetry.softwareRaster.profileEnabled,
    causalRasterCaseSampleSeed: telemetry.softwareRaster.caseSampleSeed,
    causalRasterTraversalCount: telemetry.softwareRaster.rasterTraversalCount,
    causalRasterTraversalTimedSamples: telemetry.softwareRaster.rasterTraversalTimedSampleCount,
    causalRasterTraversalSampledTotalMs: telemetry.softwareRaster.rasterTraversalSampledTotalMs,
    causalRasterCandidatePixelCount: telemetry.softwareRaster.rasterCandidatePixelCount,
    causalTevPixelCount: telemetry.softwareRaster.tevPixelCount,
    causalTevStageCount: telemetry.softwareRaster.tevStageCount,
    causalTevTimedSamples: telemetry.softwareRaster.tevTimedSampleCount,
    causalTevSampledTotalMs: telemetry.softwareRaster.tevSampledTotalMs,
    causalTextureSampleCount: telemetry.softwareRaster.textureSampleCount,
    causalTextureTimedSamples: telemetry.softwareRaster.textureTimedSampleCount,
    causalTextureSampledTotalMs: telemetry.softwareRaster.textureSampledTotalMs,
    causalTextureCaseSampleCount: telemetry.softwareRaster.textureCases.sampledCount,
    causalTextureCaseWorkCount: telemetry.softwareRaster.textureCases.workCount,
    causalTextureCaseOtherSampleCount: telemetry.softwareRaster.textureCases.otherSampleCount,
    causalTextureCaseCollisionCount: telemetry.softwareRaster.textureCases.collisionCount,
    causalTextureTopCaseKey: telemetry.softwareRaster.textureCases.topCases[0]?.key ?? null,
    causalTextureTopCaseSamples:
      telemetry.softwareRaster.textureCases.topCases[0]?.sampleCount ?? 0,
    causalTextureTopCaseDecodeWork:
      telemetry.softwareRaster.textureCases.topCases[0]?.decodeWorkCount ?? 0,
    causalTevCaseSampleCount: telemetry.softwareRaster.tevCases.sampledCount,
    causalTevCaseWorkCount: telemetry.softwareRaster.tevCases.workCount,
    causalTevCaseOtherSampleCount: telemetry.softwareRaster.tevCases.otherSampleCount,
    causalTevCaseCollisionCount: telemetry.softwareRaster.tevCases.collisionCount,
    causalTevTopStructuralKey: topTevCase?.structuralKey ?? null,
    causalTevTopProgramFingerprint: topTevCase?.programFingerprint ?? null,
    causalTevTopCanonicalProgramSchema: topTevCase?.canonicalProgramSchema ?? null,
    causalTevTopGenModeHex: topTevCase?.genModeHex ?? null,
    causalTevTopIndirectReferenceHex: topTevCase?.tevIndirectReferenceHex ?? null,
    causalTevTopOrderWord: topTevCase?.orderWord ?? null,
    causalTevTopIndirectWord: topTevCase?.indirectWord ?? null,
    causalTevTopColorCombinerHex: topTevCase?.colorCombinerHex ?? null,
    causalTevTopAlphaCombinerHex: topTevCase?.alphaCombinerHex ?? null,
    causalTevTopKonstWord: topTevCase?.konstWord ?? null,
    causalTevTopRasterSwapWord: topTevCase?.rasterSwapWord ?? null,
    causalTevTopTextureSwapWord: topTevCase?.textureSwapWord ?? null,
    causalTevTopCaseSamples: topTevCase?.sampleCount ?? 0,
    causalFifoBytesLast: telemetry.softwareRaster.fifoBytesLast,
    causalFifoBytesMax: telemetry.softwareRaster.fifoBytesMax,
    causalFifoConsumerObservedBacklogAgeLastMs:
      telemetry.softwareRaster.fifoConsumerObservedBacklogAgeLastMs,
    causalFifoConsumerObservedBacklogAgeMaxMs:
      telemetry.softwareRaster.fifoConsumerObservedBacklogAgeMaxMs,
    causalFifoOldestPendingAgeLastMs: telemetry.softwareRaster.fifoOldestPendingAgeLastMs,
    causalFifoOldestPendingAgeMaxMs: telemetry.softwareRaster.fifoOldestPendingAgeMaxMs,
    causalFifoDistanceUnderflowCount: telemetry.softwareRaster.fifoDistanceUnderflowCount,
    causalXfbGenerationCount: telemetry.softwareRaster.xfbGenerationCount,
    causalXfbGenerationLastMs: telemetry.softwareRaster.xfbGenerationLastMs,
    causalFrameGenerationCount: telemetry.softwareRaster.frameGenerationCount,
    causalFrameGenerationIntervalLastMs: telemetry.softwareRaster.frameGenerationIntervalLastMs,
    causalFrameGenerationIntervalAverageMs: telemetry.softwareRaster.frameGenerationIntervalAverageMs,
    causalFrameGenerationIntervalMaxMs: telemetry.softwareRaster.frameGenerationIntervalMaxMs,
    causalSampledSourceFrameCount: telemetry.softwareRaster.sampledSourceFrameCount,
    causalSampledUniqueFrameCount: telemetry.softwareRaster.sampledUniqueFrameCount,
    causalSampledStaleFrameCount: telemetry.softwareRaster.sampledStaleFrameCount,
    causalSampledStaleFrameRatio: telemetry.softwareRaster.sampledStaleFrameRatio,
    causalSampledStaleFrameRunMax: telemetry.softwareRaster.sampledStaleFrameRunMax,
    causalStaleRepaintCount: telemetry.softwareRaster.staleRepaintCount,
    causalJsCaptureMs: telemetry.presentation.js.capture.averageMs,
    causalJsCopyMs: telemetry.presentation.js.copy.averageMs,
    causalJsDrawMs: telemetry.presentation.js.draw.averageMs,
    causalJsHashMs: telemetry.presentation.js.hash.averageMs,
    causalJsPresentMs: telemetry.presentation.js.present.averageMs,
    causalGpuCompletionEnabled: telemetry.presentation.gpuCompletion.enabled,
    causalGpuCompletionMs: telemetry.presentation.gpuCompletion.lastMs,
    causalGpuCompletionP95Ms: telemetry.presentation.gpuCompletion.p95Ms,
    causalGpuCompletionInFlight: telemetry.presentation.gpuCompletion.inFlight,
    causalGpuCompletionFailedCount: telemetry.presentation.gpuCompletion.failedCount,
    causalPresentationUnderruns: telemetry.presentation.underrunCount,
    causalPresentationQueueDepth: telemetry.presentation.queueDepth,
    causalPresentationQueueAgeMs: telemetry.presentation.queueAgeMs,
    causalPresentationQueueDepthHighWater: telemetry.presentation.queueDepthHighWater,
    causalPresentationQueueAgeAverageMs: telemetry.presentation.queueAgeAverageMs,
    causalPresentationQueueAgeMaxMs: telemetry.presentation.queueAgeMaxMs,
    causalFreshFrameDelivery: telemetry.presentation.freshFrameDelivery,
    causalLegacyTickQueue: telemetry.presentation.legacyTickQueue,
    causalImmediateFreshFrameCount: telemetry.presentation.immediateFreshFrameCount,
    causalQueuedFreshFrameCount: telemetry.presentation.queuedFreshFrameCount,
    causalTickRepaintCount: telemetry.presentation.tickRepaintCount,
    causalWgpuDrainMs: telemetry.webgpu.drainLastMs,
    causalWgpuBacklog: telemetry.webgpu.backlogLast,
    causalWgpuBacklogSampleP95: telemetry.webgpu.backlogSampleP95,
    causalWgpuBacklogSampleAverage: telemetry.webgpu.backlogSampleAverage,
    causalWgpuBacklogAfter: telemetry.webgpu.backlogAfterLast,
    causalWgpuBacklogNonzeroAgeMaxMs: telemetry.webgpu.backlogNonzeroAgeMaxMs,
    causalWgpuReplayBudgetMs: telemetry.webgpu.replayBudgetMs,
    causalWgpuReplayBudgetYieldCount: telemetry.webgpu.replayBudgetYieldCount,
    causalWgpuReplayBudgetAtomicOverrunMaxMs:
      telemetry.webgpu.replayBudgetAtomicOverrunMaxMs,
    causalWgpuReplayBudgetStopReasons: telemetry.webgpu.replayBudgetStopReasons,
    causalWgpuDrainDurationHistogram: telemetry.webgpu.drainDurationHistogram,
    causalWgpuDrainCommandHistogram: telemetry.webgpu.drainCommandHistogram,
    causalWgpuReplayPumpWakeDelayAverageMs:
      telemetry.webgpu.replayPumpWakeDelayAverageMs,
    causalWgpuReplayPumpWakeDelayMaxMs: telemetry.webgpu.replayPumpWakeDelayMaxMs,
    causalWgpuStageBudgetYieldCount: telemetry.webgpu.stageBudgetYieldCount,
    causalWgpuStageCopyDeadlineOverrunMaxMs:
      telemetry.webgpu.stageCopyDeadlineOverrunMaxMs,
    causalWgpuMappedStagingSlotCount:
      telemetry.webgpu.mappedStaging?.slotCount ?? 0,
    causalWgpuMappedStagingSlotSize:
      telemetry.webgpu.mappedStaging?.slotSize ?? 0,
    causalWgpuMappedStagingCapacityMissesNoMappedSlots:
      telemetry.webgpu.mappedStaging?.capacityMissesNoMappedSlots ?? 0,
    causalWgpuMappedStagingCapacityMissesMappedSlotsFull:
      telemetry.webgpu.mappedStaging?.capacityMissesMappedSlotsFull ?? 0,
    causalWgpuMappedStagingSealedSlotCountTotal:
      telemetry.webgpu.mappedStaging?.sealedSlotCountTotal ?? 0,
    causalWgpuMappedStagingSealedBytesTotal:
      telemetry.webgpu.mappedStaging?.sealedBytesTotal ?? 0,
    causalWgpuMappedStagingSealedBytesMax:
      telemetry.webgpu.mappedStaging?.sealedBytesMax ?? 0,
    causalWgpuMappedStagingSealedRecordsTotal:
      telemetry.webgpu.mappedStaging?.sealedRecordsTotal ?? 0,
    causalWgpuMappedStagingSealedRecordsMax:
      telemetry.webgpu.mappedStaging?.sealedRecordsMax ?? 0,
    causalWgpuMappedStagingRemapLatencyTotalMs:
      telemetry.webgpu.mappedStaging?.remapLatencyTotalMs ?? 0,
    causalWgpuMappedStagingRemapLatencyMaxMs:
      telemetry.webgpu.mappedStaging?.remapLatencyMaxMs ?? 0,
    causalWgpuMappedStagingRemapLatencyBucketBoundsMs:
      telemetry.webgpu.mappedStaging?.remapLatencyBucketBoundsMs ?? [],
    causalWgpuMappedStagingRemapLatencyHistogram:
      telemetry.webgpu.mappedStaging?.remapLatencyHistogram ?? [],
    causalWgpuSparseUboSchema: telemetry.webgpu.uboSparse?.schema ?? null,
    causalWgpuSparseUboInstanceId: telemetry.webgpu.uboSparse?.instanceId ?? 0,
    causalWgpuSparseUboRequested: telemetry.webgpu.uboSparse?.requested ?? false,
    causalWgpuSparseUboActive: telemetry.webgpu.uboSparse?.active ?? false,
    causalWgpuSparseUboCoverageThreshold:
      telemetry.webgpu.uboSparse?.coverageThreshold ?? 0,
    causalWgpuSparseUboMaxSparseRanges:
      telemetry.webgpu.uboSparse?.maxSparseRanges ?? 0,
    causalWgpuSparseUboClassOrder: telemetry.webgpu.uboSparse?.classOrder ?? [],
    causalWgpuSparseUboClassSizes: telemetry.webgpu.uboSparse?.classSizes ?? [],
    causalWgpuSparseUboEligibleCalls: telemetry.webgpu.uboSparse?.eligibleCalls ?? 0,
    causalWgpuSparseUboBaselineCalls: telemetry.webgpu.uboSparse?.baselineCalls ?? 0,
    causalWgpuSparseUboSparseCalls: telemetry.webgpu.uboSparse?.sparseCalls ?? 0,
    causalWgpuSparseUboEqualCalls: telemetry.webgpu.uboSparse?.equalCalls ?? 0,
    causalWgpuSparseUboFullFallbackCalls:
      telemetry.webgpu.uboSparse?.fullFallbackCalls ?? 0,
    causalWgpuSparseUboCapacityMisses:
      telemetry.webgpu.uboSparse?.capacityMisses ?? 0,
    causalWgpuSparseUboFullBytes: telemetry.webgpu.uboSparse?.fullBytes ?? 0,
    causalWgpuSparseUboStagedBytes: telemetry.webgpu.uboSparse?.stagedBytes ?? 0,
    causalWgpuSparseUboAvoidedStagedBytes:
      telemetry.webgpu.uboSparse?.avoidedStagedBytes ?? 0,
    causalWgpuSparseUboCopyForwardBytes:
      telemetry.webgpu.uboSparse?.copyForwardBytes ?? 0,
    causalWgpuSparseUboOverlayRanges:
      telemetry.webgpu.uboSparse?.overlayRanges ?? 0,
    causalWgpuSparseUboOverlayBytes:
      telemetry.webgpu.uboSparse?.overlayBytes ?? 0,
    causalWgpuSparseUboPredictedGpuCopyBytes:
      telemetry.webgpu.uboSparse?.predictedGpuCopyBytes ?? 0,
    causalWgpuSparseUboInvalidations:
      telemetry.webgpu.uboSparse?.invalidations ?? 0,
    causalWgpuSparseUboInvalidationReasons:
      telemetry.webgpu.uboSparse?.invalidationReasons ?? {},
    causalWgpuSparseUboCallsByClass:
      telemetry.webgpu.uboSparse?.callsByClass ?? [],
    causalWgpuSparseUboSparseCallsByClass:
      telemetry.webgpu.uboSparse?.sparseCallsByClass ?? [],
    causalWgpuSparseUboStagedBytesByClass:
      telemetry.webgpu.uboSparse?.stagedBytesByClass ?? [],
    causalWgpuMappedDrainCoalescingEnabled:
      telemetry.webgpu.mappedDrainCoalescingEnabled ?? false,
    causalWgpuMappedDrainDeferred:
      telemetry.webgpu.mappedDrainCoalescing?.state?.deferred ?? false,
    causalWgpuMappedDrainDeferredBoundaries:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.deferredBoundaries ?? 0,
    causalWgpuMappedDrainFlushDecisions:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.flushDecisions ?? 0,
    causalWgpuMappedDrainTimerFired:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.timerFired ?? 0,
    causalWgpuMappedDrainTimerStale:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.timerStale ?? 0,
    causalWgpuMappedDrainActualSubmissions:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.actualSubmissions ?? 0,
    causalWgpuMappedDrainActualSubmissionAgeMaxMs:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.actualSubmissionAgeMaxMs ?? 0,
    causalWgpuMappedDrainActualDeadlineOverrunMaxMs:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.actualDeadlineOverrunMaxMs ?? 0,
    causalWgpuMappedDrainDeadlineOverrunMaxMs:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.deadlineOverrunMaxMs ?? 0,
    causalWgpuMappedDrainMaxPendingBytes:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.maxPendingBytes ?? 0,
    causalWgpuMappedDrainMaxPendingRecords:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.maxPendingRecords ?? 0,
    causalWgpuMappedDrainMaxPendingAgeMs:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.maxPendingAgeMs ?? 0,
    causalWgpuMappedDrainFlushReasons:
      telemetry.webgpu.mappedDrainCoalescing?.telemetry?.flushReasons ?? {},
    causalWgpuErrorCount: telemetry.webgpu.errorCount,
    causalWgpuProducerStateCacheEnabled: telemetry.webgpu.producerStateCacheEnabled,
    causalWgpuProducerPipelineRecordsSuppressed:
      telemetry.webgpu.producerPipelineRecordsSuppressed,
    causalWgpuProducerBindGroupRecordsSuppressed:
      telemetry.webgpu.producerBindGroupRecordsSuppressed,
    causalWgpuProducerVertexBufferRecordsSuppressed:
      telemetry.webgpu.producerVertexBufferRecordsSuppressed,
    causalWgpuProducerIndexBufferRecordsSuppressed:
      telemetry.webgpu.producerIndexBufferRecordsSuppressed,
    causalWgpuProducerProfileSchema:
      telemetry.webgpu.producerProfile?.schema ?? WGPU_PRODUCER_PROFILE_SCHEMA,
    causalWgpuProducerProfileRequested:
      telemetry.webgpu.producerProfile?.requested ?? false,
    causalWgpuProducerProfileAvailable:
      telemetry.webgpu.producerProfile?.available ?? false,
    causalWgpuProducerProfileEnabled:
      telemetry.webgpu.producerProfile?.enabled ?? false,
    causalWgpuProducerProfileEpoch:
      telemetry.webgpu.producerProfile?.epoch ?? 0,
    causalWgpuProducerProfilePhaseCount:
      telemetry.webgpu.producerProfile?.phaseCount ?? WGPU_PRODUCER_PROFILE_PHASE_ORDER.length,
    causalWgpuProducerProfilePhaseOrder:
      telemetry.webgpu.producerProfile?.phaseOrder ?? [...WGPU_PRODUCER_PROFILE_PHASE_ORDER],
    causalWgpuProducerProfilePeriods:
      telemetry.webgpu.producerProfile?.periods ?? [],
    causalWgpuProducerProfileCalls:
      telemetry.webgpu.producerProfile?.calls ?? [],
    causalWgpuProducerProfileSamples:
      telemetry.webgpu.producerProfile?.samples ?? [],
    causalWgpuProducerProfileSampleTotalNs:
      telemetry.webgpu.producerProfile?.sampleTotalNs ?? [],
    causalWgpuProducerProfileSampleMaxNs:
      telemetry.webgpu.producerProfile?.sampleMaxNs ?? [],
    causalWgpuProducerProfileEstimatedTotalNs:
      telemetry.webgpu.producerProfile?.estimatedTotalNs ?? [],
    causalWgpuDrawProfileSchema:
      telemetry.webgpu.drawProfile?.schema ?? WGPU_DRAW_PROFILE_SCHEMA,
    causalWgpuDrawProfileRequested:
      telemetry.webgpu.drawProfile?.requested ?? false,
    causalWgpuDrawProfileAvailable:
      telemetry.webgpu.drawProfile?.available ?? false,
    causalWgpuDrawProfileEnabled:
      telemetry.webgpu.drawProfile?.enabled ?? false,
    causalWgpuDrawProfileEpoch:
      telemetry.webgpu.drawProfile?.epoch ?? 0,
    causalWgpuDrawProfilePhaseCount:
      telemetry.webgpu.drawProfile?.phaseCount ?? WGPU_DRAW_PROFILE_PHASE_ORDER.length,
    causalWgpuDrawProfilePhaseOrder:
      telemetry.webgpu.drawProfile?.phaseOrder ?? [...WGPU_DRAW_PROFILE_PHASE_ORDER],
    causalWgpuDrawProfilePeriods:
      telemetry.webgpu.drawProfile?.periods ?? [],
    causalWgpuDrawProfileCalls:
      telemetry.webgpu.drawProfile?.calls ?? [],
    causalWgpuDrawProfileSamples:
      telemetry.webgpu.drawProfile?.samples ?? [],
    causalWgpuDrawProfileSampleTotalNs:
      telemetry.webgpu.drawProfile?.sampleTotalNs ?? [],
    causalWgpuDrawProfileSampleMaxNs:
      telemetry.webgpu.drawProfile?.sampleMaxNs ?? [],
    causalWgpuDrawProfileEstimatedTotalNs:
      telemetry.webgpu.drawProfile?.estimatedTotalNs ?? [],
    causalWgpuUploadArenaRequestedBytes:
      telemetry.webgpu.producerUploadArenaRequestedBytes,
    causalWgpuUploadArenaConfiguredBytes:
      telemetry.webgpu.producerUploadArenaConfiguredBytes,
    causalWgpuUploadArenaFallbackCount:
      telemetry.webgpu.producerUploadArenaFallbackCount,
    causalWgpuUploadArenaLateRejectCount:
      telemetry.webgpu.producerUploadArenaLateRejectCount,
    causalWgpuUploadArenaWrapCount:
      telemetry.webgpu.producerUploadArenaWrapCount,
    causalWgpuUploadArenaInflightHighWaterBytes:
      telemetry.webgpu.producerUploadArenaInflightHighWaterBytes,
    causalWgpuProducerRingWaitCount: telemetry.webgpu.producerRingWaitCount,
    causalWgpuProducerRingWaitTotalUs: telemetry.webgpu.producerRingWaitTotalUs,
    causalWgpuProducerRingWaitMaxUs: telemetry.webgpu.producerRingWaitMaxUs,
    causalWgpuProducerUploadWaitCount: telemetry.webgpu.producerUploadWaitCount,
    causalWgpuProducerUploadWaitTotalUs: telemetry.webgpu.producerUploadWaitTotalUs,
    causalWgpuProducerUploadWaitMaxUs: telemetry.webgpu.producerUploadWaitMaxUs,
    causalWgpuRendererWorkerProbeRequested:
      telemetry.webgpu.rendererWorkerProbe?.requested ?? "off",
    causalWgpuRendererWorkerProbeActive:
      telemetry.webgpu.rendererWorkerProbe?.active ?? false,
    causalWgpuRendererWorkerProbePassed:
      telemetry.webgpu.rendererWorkerProbe?.passed ?? false,
    causalWgpuRendererWorkerProbeSchema:
      telemetry.webgpu.rendererWorkerProbe?.schema ?? "",
    causalWgpuRendererWorkerProbeTotalMs:
      telemetry.webgpu.rendererWorkerProbe?.totalMs ?? 0,
    causalWgpuRendererWorkerProbeError:
      telemetry.webgpu.rendererWorkerProbe?.error ?? "",
    causalWgpuRendererWorkerProbeExecutor:
      telemetry.webgpu.rendererWorkerProbe?.executorLocation ?? "",
    causalWgpuRendererWorkerProbeBlankOutput:
      telemetry.webgpu.rendererWorkerProbe?.blankOutput ?? false,
    causalWgpuRendererWorkerProbeProtocolVersion:
      telemetry.webgpu.rendererWorkerProbe?.protocolVersion ?? 0,
    causalWgpuRendererWorkerProbeClaimedOwner:
      telemetry.webgpu.rendererWorkerProbe?.claimedOwner ?? 0,
    causalWgpuRendererWorkerProbeClaimCount:
      telemetry.webgpu.rendererWorkerProbe?.claimCount ?? 0,
    causalWgpuRendererWorkerProbeConflictCount:
      telemetry.webgpu.rendererWorkerProbe?.conflictCount ?? 0,
    causalWgpuRendererWorkerProbeObservedRecords:
      telemetry.webgpu.rendererWorkerProbe?.observedRecordCount ?? 0,
    causalWgpuRendererWorkerProbeConsumedRecords:
      telemetry.webgpu.rendererWorkerProbe?.consumedRecordCount ?? 0,
    causalWgpuRendererWorkerProbeUploadRecords:
      telemetry.webgpu.rendererWorkerProbe?.uploadRecordCount ?? 0,
    causalWgpuRendererWorkerProbeReleasedUploads:
      telemetry.webgpu.rendererWorkerProbe?.releasedUploadCount ?? 0,
    causalWgpuRendererWorkerProbeUploadBytes:
      telemetry.webgpu.rendererWorkerProbe?.totalUploadBytes ?? 0,
    causalWgpuRendererWorkerProbeSubmissions:
      telemetry.webgpu.rendererWorkerProbe?.submissionCount ?? 0,
    causalWgpuRendererWorkerProbeGpuCompletions:
      telemetry.webgpu.rendererWorkerProbe?.gpuCompletionCount ?? 0,
    causalWgpuRendererWorkerProbeBacklog:
      telemetry.webgpu.rendererWorkerProbe?.backlog ?? 0,
    causalWgpuRendererWorkerProbeQuiesced:
      telemetry.webgpu.rendererWorkerProbe?.quiesced ?? false,
    causalWgpuRendererWorkerProbeFatalCount:
      telemetry.webgpu.rendererWorkerProbe?.fatalCount ?? 0,
    causalWgpuRendererWorkerProbeStreamDigest:
      telemetry.webgpu.rendererWorkerProbe?.streamDigest ?? "",
    causalWgpuProducerUboChangeMaskHistogram:
      telemetry.webgpu.producerUboChangeMaskHistogram,
    causalWgpuProducerUboPackEnabled: telemetry.webgpu.producerUboPackEnabled,
    causalWgpuProducerUboPacketEligibleCount:
      telemetry.webgpu.producerUboPacketEligibleCount,
    causalWgpuProducerUboPacketTheoreticalCallsRemoved:
      telemetry.webgpu.producerUboPacketTheoreticalCallsRemoved,
    causalWgpuProducerUboPacketPayloadBytes:
      telemetry.webgpu.producerUboPacketPayloadBytes,
    causalWgpuProducerUboPacketAlignedBytes:
      telemetry.webgpu.producerUboPacketAlignedBytes,
    causalWgpuProducerUboPrepareCpuCalls: telemetry.webgpu.producerUboPrepareCpuCalls,
    causalWgpuProducerUboPrepareCpuNs: telemetry.webgpu.producerUboPrepareCpuNs,
    causalWgpuProducerUboChangeClassOrder: telemetry.webgpu.producerUboChangeClassOrder,
    causalWgpuProducerUboChangeSchemaVersion:
      telemetry.webgpu.producerUboChangeSchemaVersion,
    causalWgpuProducerUboChangeAvailable: telemetry.webgpu.producerUboChangeAvailable,
    causalWgpuProducerUboChangeEnabled: telemetry.webgpu.producerUboChangeEnabled,
    causalWgpuProducerUboChangeEpoch: telemetry.webgpu.producerUboChangeEpoch,
    causalWgpuProducerUboChangeUploadCalls: telemetry.webgpu.producerUboChangeUploadCalls,
    causalWgpuProducerUboChangeFullBytes: telemetry.webgpu.producerUboChangeFullBytes,
    causalWgpuProducerUboChangedBytes: telemetry.webgpu.producerUboChangedBytes,
    causalWgpuProducerUboChangeBaselineFullCount:
      telemetry.webgpu.producerUboChangeBaselineFullCount,
    causalWgpuProducerUboChangeBaselineFullBytes:
      telemetry.webgpu.producerUboChangeBaselineFullBytes,
    causalWgpuProducerUboDirty16Bytes: telemetry.webgpu.producerUboDirty16Bytes,
    causalWgpuProducerUboDirty16Ranges: telemetry.webgpu.producerUboDirty16Ranges,
    causalWgpuProducerUboDirty256Bytes: telemetry.webgpu.producerUboDirty256Bytes,
    causalWgpuProducerUboDirty256Ranges: telemetry.webgpu.producerUboDirty256Ranges,
    causalWgpuProducerUniformFastEnabled: telemetry.webgpu.producerUniformFastEnabled,
    causalWgpuProducerUniformFastSkippedComparisons:
      telemetry.webgpu.producerUniformFastSkippedComparisons,
    causalWgpuProducerUniformFastKeptComparisons:
      telemetry.webgpu.producerUniformFastKeptComparisons,
    causalWgpuProducerUniformFastChangedComparisons:
      telemetry.webgpu.producerUniformFastChangedComparisons,
    causalWgpuQueueSubmissionCount: telemetry.webgpu.queueSubmissionCount,
    causalWgpuUploadArenaRingHandoffBytes:
      telemetry.webgpu.uploadArenaRingHandoffBytes,
    causalWgpuUploadArenaRingHandoffExpectedBytes:
      telemetry.webgpu.uploadArenaRingHandoffExpectedBytes,
    causalWgpuUploadArenaRingHandoffMismatch:
      telemetry.webgpu.uploadArenaRingHandoffMismatch,
    causalWgpuUploadArenaRingHandoffMismatchCount:
      telemetry.webgpu.uploadArenaRingHandoffMismatchCount,
    causalWgpuCommandDroppedCount: telemetry.webgpu.commandDroppedCount,
    causalWgpuBatchAbortCount: telemetry.webgpu.batchAbortCount,
    causalWgpuBatchOversizeCount: telemetry.webgpu.batchOversizeCount,
    causalWgpuUploadTimeoutCount: telemetry.webgpu.uploadTimeoutCount,
    causalWgpuUploadTimeoutBoundaryVerified:
      telemetry.webgpu.uploadTimeoutBoundaryVerified,
    causalWgpuUploadTimeoutCountAtVerifiedLoad:
      telemetry.webgpu.uploadTimeoutCountAtVerifiedLoad,
    causalWgpuUploadTimeoutCountBeforeVerifiedLoad:
      telemetry.webgpu.uploadTimeoutCountBeforeVerifiedLoad,
    causalWgpuUploadTimeoutCountAfterVerifiedLoad:
      telemetry.webgpu.uploadTimeoutCountAfterVerifiedLoad,
    causalWgpuUploadAttributionSchema: uploadAttribution.schema,
    causalWgpuUploadRoleOrder: uploadAttribution.roleOrder,
    causalWgpuUploadSizeBucketLabels: uploadAttribution.sizeBucketLabels,
    causalWgpuUploadTotalCalls: uploadAttribution.totalCalls,
    causalWgpuUploadTotalBytes: uploadAttribution.totalBytes,
    causalWgpuUploadMaxBytes: uploadAttribution.maxBytes,
    causalWgpuUploadCallsByRole: uploadAttribution.callsByRole,
    causalWgpuUploadBytesByRole: uploadAttribution.bytesByRole,
    causalWgpuUploadMaxBytesByRole: uploadAttribution.maxBytesByRole,
    causalWgpuQueueWriteTotalCalls: queueWrite.totalCalls,
    causalWgpuQueueWriteTotalMs: queueWrite.totalMs,
    causalWgpuQueueWriteMaxMs: queueWrite.maxMs,
    causalWgpuQueueWriteCallsByRole: queueWrite.callsByRole,
    causalWgpuQueueWriteTotalMsByRole: queueWrite.totalMsByRole,
    causalWgpuQueueWriteMaxMsByRole: queueWrite.maxMsByRole,
    causalWgpuQueueWriteSlowEventObservedCount: queueWrite.slowEventObservedCount,
    causalWgpuQueueWriteSlowEvents: queueWrite.slowEvents,
    causalWgpuUploadBucketCallsByRole: uploadAttribution.bucketCallsByRole,
    causalWgpuUploadBucketBytesByRole: uploadAttribution.bucketBytesByRole,
    causalWgpuMappedStageTimingSchema: mappedStageTiming.schema,
    causalWgpuMappedStageTimingMode: mappedStageTiming.mode,
    causalWgpuMappedStageTimingStride: mappedStageTiming.stride,
    causalWgpuMappedStageTimingEligibleCalls: mappedStageTiming.eligibleCalls,
    causalWgpuMappedStageTimingSampleCount: mappedStageTiming.sampleCount,
    causalWgpuMappedStageTimingSampleBytes: mappedStageTiming.sampleBytes,
    causalWgpuMappedStageTimingSampleTotalMs: mappedStageTiming.sampleTotalMs,
    causalWgpuMappedStageTimingSampleMaxMs: mappedStageTiming.sampleMaxMs,
    causalWgpuMappedStageTimingEligibleCallsByRole:
      mappedStageTiming.eligibleCallsByRole,
    causalWgpuMappedStageTimingSampleCountsByRole:
      mappedStageTiming.sampleCountsByRole,
    causalWgpuMappedStageTimingSampleBytesByRole:
      mappedStageTiming.sampleBytesByRole,
    causalWgpuMappedStageTimingSampleTotalMsByRole:
      mappedStageTiming.sampleTotalMsByRole,
    causalWgpuMappedStageTimingSampleMaxMsByRole:
      mappedStageTiming.sampleMaxMsByRole,
    causalWgpuMappedCapacityWaitAttempts: capacityWait.totalAttempts,
    causalWgpuMappedCapacityWaitEpisodes: capacityWait.totalEpisodes,
    causalWgpuMappedCapacityWaitCompletedEpisodes: capacityWait.completedEpisodes,
    causalWgpuMappedCapacityWaitTotalMs: capacityWait.totalMs,
    causalWgpuMappedCapacityWaitMaxMs: capacityWait.maxMs,
    causalWgpuMappedCapacityWaitActive: capacityWait.active,
    causalWgpuMappedCapacityWaitActiveRole: capacityWait.activeRole,
    causalWgpuMappedCapacityWaitAttemptsByRole: capacityWait.attemptsByRole,
    causalWgpuMappedCapacityWaitEpisodesByRole: capacityWait.episodesByRole,
    causalWgpuMappedCapacityWaitCompletedByRole: capacityWait.completedByRole,
    causalWgpuMappedCapacityWaitTotalMsByRole: capacityWait.totalMsByRole,
    causalWgpuMappedCapacityWaitMaxMsByRole: capacityWait.maxMsByRole,
    causalWgpuPassPackageProjectionSchema: passPackageProjection.schema,
    causalWgpuPassPackageProjectionRequested: passPackageProjection.requested,
    causalWgpuPassPackageProjectionActive: passPackageProjection.active,
    causalWgpuPassPackageRuntimeEligible: passPackageProjection.runtimeEligible,
    causalWgpuPassPackageLegacyRecords: passPackageProjection.legacy.records,
    causalWgpuPassPackageLegacyPublications: passPackageProjection.legacy.publications,
    causalWgpuPassPackageProjectedRecords: passPackageProjection.projected.records,
    causalWgpuPassPackageProjectedPublications: passPackageProjection.projected.publications,
    causalWgpuPassPackageProjectedRecordReduction:
      passPackageProjection.projected.recordReduction,
    causalWgpuPassPackageProjectedPublicationReduction:
      passPackageProjection.projected.publicationReduction,
    causalWgpuPassPackageSpeculativePublications:
      passPackageProjection.speculativeFullEnvelope.publications,
    causalWgpuPassPackageSpeculativePublicationReductionEstimate:
      passPackageProjection.speculativeFullEnvelope.publicationReductionEstimate,
    causalWgpuPassPackageCompletePasses: passPackageProjection.projected.completePassPackages,
    causalWgpuPassPackageOutsideSegments: passPackageProjection.projected.outsideSegments,
    causalWgpuPassPackageUploadRecords: passPackageProjection.records.uploads,
    causalWgpuPassPackageUploadBytes: passPackageProjection.records.uploadBytes,
    causalWgpuPassPackageResourceRecords: passPackageProjection.records.resources,
    causalWgpuPassPackageUnsupportedRecords: passPackageProjection.records.unsupported,
    causalWgpuPassPackageMalformedRecords: passPackageProjection.records.malformed,
    causalWgpuPassPackageNestedPasses: passPackageProjection.records.nestedPasses,
    causalWgpuPassPackageStateOutsidePass: passPackageProjection.records.stateOutsidePass,
    causalWgpuPassPackagePendingPrePassUploads:
      passPackageProjection.ownership.pendingPrePassUploads,
    causalWgpuPassPackageUnresolvedPrePassUploads:
      passPackageProjection.ownership.unresolvedPrePassUploads,
    causalWgpuPassPackagePendingOutsideResources:
      passPackageProjection.ownership.pendingOutsideResources,
    causalWgpuPassPackageUnresolvedOutsideResources:
      passPackageProjection.ownership.unresolvedOutsideResources,
    causalWgpuPassPackageOpHistogram: passPackageProjection.opHistogram,
    causalWgpuOwnershipTraceSchema: ownershipTrace.schema,
    causalWgpuOwnershipTraceRequested: ownershipTrace.requested,
    causalWgpuOwnershipTraceActive: ownershipTrace.active,
    causalWgpuOwnershipTraceSetterAvailable: ownershipTrace.setterAvailable,
    causalWgpuOwnershipTraceSetterInvoked: ownershipTrace.setterInvoked,
    causalWgpuOwnershipTraceRegistered: ownershipTrace.registered,
    causalWgpuOwnershipTraceEpoch: ownershipTrace.epoch,
    causalWgpuOwnershipTraceBacklog: ownershipTrace.backlog,
    causalWgpuOwnershipTraceNativeDropped: ownershipTrace.nativeDropped,
    causalWgpuOwnershipTraceObservedRecords: ownershipTrace.observedRecords,
    causalWgpuOwnershipTraceDrainedBatches: ownershipTrace.drainedBatches,
    causalWgpuOwnershipTraceEpochChanges: ownershipTrace.epochChangeCount,
    causalWgpuOwnershipTraceRecordEpochMismatches:
      ownershipTrace.recordEpochMismatchCount,
    causalWgpuOwnershipTraceOrderingViolations:
      ownershipTrace.monotonicOrderingViolationCount,
    causalWgpuOwnershipTraceMalformedHeaders: ownershipTrace.malformedHeaderCount,
    causalWgpuOwnershipTraceMalformedDescriptors:
      ownershipTrace.malformedDescriptorCount,
    causalWgpuOwnershipTraceEventHistogram: ownershipTrace.eventHistogram,
    causalWgpuOwnershipTraceOpcodeHistogram: ownershipTrace.opcodeHistogram,
    causalWgpuOwnershipTraceCommandAttributionHistogram:
      ownershipTrace.commandAttributionHistogram,
    causalWgpuOwnershipTraceCommandPublicationHistogram:
      ownershipTrace.commandPublicationHistogram,
    causalWgpuOwnershipTraceUploadBytesByAttribution:
      ownershipTrace.uploadBytesByAttribution,
    causalWgpuOwnershipTraceMaximumTransactionId:
      ownershipTrace.maximumTransactionId,
    causalWgpuOwnershipTraceZeroTransactionCommands:
      ownershipTrace.zeroTransactionCommandCount,
    causalWgpuUploadCompletedPassCount: uploadPassAssociation.completedPassCount,
    causalWgpuUploadAbortedPassCount: uploadPassAssociation.abortedPassCount,
    causalWgpuUploadIncompletePassCount: uploadPassAssociation.incompletePassCount,
    causalWgpuUploadCurrentWindowCalls: uploadPassAssociation.currentWindowCalls,
    causalWgpuUploadCurrentWindowBytes: uploadPassAssociation.currentWindowBytes,
    causalWgpuUploadMaxPassCalls: uploadPassAssociation.maxCalls,
    causalWgpuUploadMaxPassBytes: uploadPassAssociation.maxBytes,
    causalWgpuUploadMaxDestinationSpanBytes:
      uploadPassAssociation.maxDestinationSpanBytes,
    causalWgpuUploadMaxDestinationSpanBytesByRole:
      uploadPassAssociation.maxDestinationSpanBytesByRole,
    causalWorkerRequestCount: telemetry.workerTraffic.mainToWorker.requestCount,
    causalWorkerPostCount: telemetry.workerTraffic.mainToWorker.oneWayCount,
    causalWorkerTransferOutBytes: telemetry.workerTraffic.mainToWorker.transferBytes,
    causalWorkerTransferInBytes: telemetry.workerTraffic.workerToMain.transferBytes,
    causalAudioWorkerMixCount: telemetry.audio.workerMixCount,
    causalAudioWorkerRequestedFrames: telemetry.audio.workerRequestedFrames,
    causalAudioWorkerReturnedFrames: telemetry.audio.workerReturnedFrames,
    causalAudioWorkerEmptyMixCount: telemetry.audio.workerEmptyMixCount,
    causalAudioWorkerMixLastMs: telemetry.audio.workerMixLastMs,
    causalAudioWorkerMixTotalMs: telemetry.audio.workerMixTotalMs,
    causalAudioWorkerMixMaxMs: telemetry.audio.workerMixMaxMs,
    causalAudioRequestedTransport: telemetry.audio.requestedTransport,
    causalAudioActiveTransport: telemetry.audio.activeTransport,
    causalAudioTransportFallbackReason: telemetry.audio.transportFallbackReason,
    causalAudioWorkletFillFrames: telemetry.audio.workletRing?.fillFrames ?? 0,
    causalAudioWorkletUnderrunFrames: telemetry.audio.workletRing?.underrunFrames ?? 0,
    causalAudioWorkletUnderrunEvents: telemetry.audio.workletRing?.underrunEvents ?? 0,
    causalAudioWorkletWrittenFrames: telemetry.audio.workletRing?.writtenFrames ?? 0,
    causalAudioWorkletConsumedFrames: telemetry.audio.workletRing?.consumedFrames ?? 0,
    causalAudioWorkletProducerRefills: telemetry.audio.workletRing?.producerRefills ?? 0,
    causalAudioWorkletProducerEmptyMixes: telemetry.audio.workletRing?.producerEmptyMixes ?? 0,
    causalAudioWorkletProducerTimerGapMaxMs:
      telemetry.audio.workletRing?.producerTimerGapMaxMs ?? 0,
    causalAudioWorkletProducerFillHighWater:
      telemetry.audio.workletRing?.producerFillHighWater ?? 0,
    causalAudioPumpCount: telemetry.audio.pumpCount,
    causalAudioPumpPendingSkipCount: telemetry.audio.pumpPendingSkipCount,
    causalAudioPumpMissCount: telemetry.audio.pumpMissCount,
    causalAudioPumpGapLastMs: telemetry.audio.pumpGapLastMs,
    causalAudioPumpGapAverageMs: telemetry.audio.pumpGapAverageMs,
    causalAudioPumpGapMaxMs: telemetry.audio.pumpGapMaxMs,
    causalAudioMixRoundTripAverageMs: telemetry.audio.mixRoundTripAverageMs,
    causalAudioMixRoundTripMaxMs: telemetry.audio.mixRoundTripMaxMs,
    causalAudioUnderruns: telemetry.audio.underrunCount,
    causalAudioOverruns: telemetry.audio.overrunCount,
    causalAudioScheduleLeadSeconds: telemetry.audio.scheduleLeadSeconds,
    causalAudioScheduleDriftSeconds: telemetry.audio.scheduleDriftSeconds,
    // Compatibility aliases retained for existing result consumers.
    causalAudioMixMs: telemetry.audio.workerMixLastMs,
    causalAudioPumpGapMs: telemetry.audio.pumpGapLastMs,
    causalInputAgeMs: telemetry.input.ageLastMs,
    causalInputPostCount: telemetry.input.mainPostCount,
    causalInputGeneration: telemetry.input.mainGeneration,
    causalInputSabGeneration: telemetry.input.mainSabGeneration,
    causalInputVisibleEnabled: telemetry.input.visible.enabled,
    causalInputCorePollAgeMs: telemetry.input.visible.pollAgeLastMs,
    causalInputVisibleAgeMs: telemetry.input.visible.visibleAgeLastMs,
    causalInputPollToVisibleMs: telemetry.input.visible.pollToVisibleLastMs,
    causalInputMarkerEnabled: telemetry.input.marker.enabled,
    causalInputMarkerAppliedCount: telemetry.input.marker.appliedCount,
    causalInputMarkerDuplicateApplyCount: telemetry.input.marker.duplicateApplyCount,
    causalInputMarkerSupersededCount: telemetry.input.marker.supersededCount,
    causalInputMarkerSupersededArmedCount: telemetry.input.marker.supersededArmedCount,
    causalInputMarkerDroppedInFlightCount: telemetry.input.marker.droppedInFlightCount,
    causalInputMarkerExactCorePollCount: telemetry.input.marker.exactCorePollCount,
    causalInputMarkerGenerationMismatchCount: telemetry.input.marker.generationMismatchCount,
    causalInputMarkerGenerationUnavailableCount:
      telemetry.input.marker.generationUnavailableCount,
    causalInputMarkerArmedCount: telemetry.input.marker.markerArmedCount,
    causalInputMarkerSubmittedCount: telemetry.input.marker.markerSubmittedCount,
    causalInputMarkerCompletedCount: telemetry.input.marker.markerCompletedCount,
    causalInputMarkerDuplicateSubmitCount: telemetry.input.marker.duplicateSubmitCount,
    causalInputMarkerDuplicateCompleteCount: telemetry.input.marker.duplicateCompleteCount,
    causalInputMarkerRetiredCompletedCount:
      telemetry.input.marker.retiredCompletedMarkerCount,
    causalInputMarkerExpiredCount: telemetry.input.marker.expiredMarkerCount,
    causalInputMarkerExpiredInFlightCount: telemetry.input.marker.expiredInFlightCount,
    causalInputMarkerPendingGeneration: telemetry.input.marker.pendingGeneration,
    causalInputMarkerActiveGeneration: telemetry.input.marker.activeGeneration,
    causalInputMarkerInFlightCount: telemetry.input.marker.inFlightCount,
    causalInputMarkerCompletionAgeMs: telemetry.input.marker.completionAgeLastMs,
    causalInputMarkerCompletionAgeP95Ms: telemetry.input.marker.completionAgeP95Ms,
    causalInputMarkerPollToCompletionMs: telemetry.input.marker.pollToCompletionLastMs,
    causalInputMarkerPollToCompletionP95Ms: telemetry.input.marker.pollToCompletionP95Ms,
    causalInputMarkerLastCompletedGeneration: telemetry.input.marker.lastCompletedGeneration,
    causalInputMarkerCompletionKind: telemetry.input.marker.lastCompletionKind,
    causalInputPhotonOverheadEnabled: inputPhotonOverhead.enabled,
    causalInputPhotonFrameCopyPaintCalls:
      inputPhotonOverhead.softwareFrameCopyPaint.calls,
    causalInputPhotonFrameCopyBytes:
      inputPhotonOverhead.softwareFrameCopyPaint.sourceBytes,
    causalInputPhotonMarkerPaintBytes:
      inputPhotonOverhead.softwareFrameCopyPaint.paintedBytes,
    causalInputPhotonFrameCopyPaintTotalMs:
      inputPhotonOverhead.softwareFrameCopyPaint.totalMs,
    causalInputPhotonFrameCopyPaintMaxMs:
      inputPhotonOverhead.softwareFrameCopyPaint.maxMs,
    causalInputPhotonPadStatsPollParseCalls:
      inputPhotonOverhead.padStatsPollParse.calls,
    causalInputPhotonPadStatsSourceUtf16Bytes:
      inputPhotonOverhead.padStatsPollParse.sourceUtf16Bytes,
    causalInputPhotonPadStatsPollParseTotalMs:
      inputPhotonOverhead.padStatsPollParse.totalMs,
    causalInputPhotonPadStatsPollParseMaxMs:
      inputPhotonOverhead.padStatsPollParse.maxMs,
    causalInputPhotonPadStatsPollParseFailureCount:
      inputPhotonOverhead.padStatsPollParse.failureCount,
  };
  return valid
    ? flattened
    : Object.fromEntries(Object.keys(flattened).map((key) => [key, null]));
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return result;
}

function emptyStage() {
  return { count: 0, totalMs: 0, averageMs: 0 };
}

function emptyTrafficDirection() {
  return {
    requestCount: 0,
    oneWayCount: 0,
    responseCount: 0,
    notificationCount: 0,
    transferBytes: 0,
    estimatedPayloadBytes: 0,
    byType: {},
  };
}

function emptyGpuCompletionTelemetry() {
  return {
    schema: "wasm-dolphin.gpu-completion.v1",
    enabled: false,
    sampleEvery: 30,
    submitCount: 0,
    sampleRequestCount: 0,
    completedCount: 0,
    failedCount: 0,
    lastMs: 0,
    averageMs: 0,
    maxMs: 0,
    p95Ms: 0,
    unsupportedCount: 0,
    inFlight: 0,
    inFlightHighWater: 0,
    lastError: "",
    byRoute: {},
  };
}

function emptyInputVisibleLatencyTelemetry() {
  return {
    schema: "wasm-dolphin.input-visible-latency.v1",
    enabled: false,
    meaning: "host-to-next-distinct-frame-after-core-poll",
    causalVisualAttribution: false,
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
    sourceCounts: {},
    pendingGeneration: 0,
    pendingInputMask: 0,
    applyAgeAverageMs: 0,
    applyAgeP95Ms: 0,
    pollAgeAverageMs: 0,
    pollAgeP95Ms: 0,
    visibleAgeAverageMs: 0,
    visibleAgeP95Ms: 0,
    visibleAgeMaxMs: 0,
    pollToVisibleAverageMs: 0,
    pollToVisibleP95Ms: 0,
  };
}

function emptyInputPhotonOverheadTelemetry() {
  return {
    schema: "wasm-dolphin.input-photon-overhead.v1",
    enabled: false,
    collectionRequires: "inputphoton=1&metrics=1",
    softwareFrameCopyPaint: {
      calls: 0,
      sourceBytes: 0,
      paintedBytes: 0,
      totalMs: 0,
      maxMs: 0,
      averageMs: 0,
    },
    padStatsPollParse: {
      calls: 0,
      sourceUtf16Bytes: 0,
      totalMs: 0,
      maxMs: 0,
      failureCount: 0,
      averageMs: 0,
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value);
}
