// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_UPLOAD_RUN_PROJECTION_SCHEMA =
  "wasm-dolphin.wgpu-upload-run-projection.v1";

const WGPU_CMD_OP_UPLOAD_BUFFER = 6;
const DEFAULT_MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
const RUN_LENGTH_BUCKET_BOUNDS = Object.freeze([
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, Number.POSITIVE_INFINITY,
]);

export function requestedWgpuUploadRunProjection(search = "") {
  return new URLSearchParams(search).get("wgpuuploadrunprojection") === "1";
}

// Passive observer for a possible future mapped-staging upload-run ingest.
// It receives metadata only after legacy replay accepts a record. It owns no
// payload bytes, renderer resources, cursor, synchronization, or submission.
export function createWgpuUploadRunProjection({
  maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES,
} = {}) {
  const envelopeCapacity = positiveIntegerOr(
    maxEnvelopeBytes,
    DEFAULT_MAX_ENVELOPE_BYTES
  );
  const fallbackReasons = Object.create(null);
  const splitReasons = Object.create(null);
  const boundaryReasons = Object.create(null);
  const resetReasons = Object.create(null);
  const runLengthHistogram = new Array(RUN_LENGTH_BUCKET_BOUNDS.length).fill(0);

  let currentRun = null;
  let lastObservedRecordIndex = null;
  let logicalUploadCount = 0;
  let eligibleUploadCount = 0;
  let fallbackUploadCount = 0;
  let currentScalarSetCalls = 0;
  let logicalPayloadBytes = 0;
  let eligibleLogicalPayloadBytes = 0;
  let fallbackLogicalPayloadBytes = 0;
  let alignedCopyBytes = 0;
  let eligibleAlignedCopyBytes = 0;
  let fallbackAlignedCopyBytes = 0;
  let finalizedRunCount = 0;
  let finalizedEnvelopeBytes = 0;
  let finalizedGapBytes = 0;
  let finalizedRunUploadCount = 0;
  let runLengthMin = Number.POSITIVE_INFINITY;
  let runLengthMax = 0;
  let sourceArenaWrapCount = 0;
  let ownershipOrderHazardCount = 0;
  let fallbackCount = 0;
  let splitCount = 0;
  let boundaryCount = 0;
  let resetCount = 0;

  function observeAcceptedRecord({
    op,
    recordIndex,
    sourcePointer = 0,
    logicalBytes: payloadBytes = 0,
    alignedBytes = payloadBytes,
    sourceArenaBase = 0,
    sourceArenaSize = 0,
    hasDestination = false,
    retained = false,
    semanticCapture = false,
  } = {}) {
    const normalizedOp = Number(op);
    const normalizedRecordIndex = Number(recordIndex) >>> 0;
    if (normalizedOp !== WGPU_CMD_OP_UPLOAD_BUFFER) {
      boundary("nonUpload");
      lastObservedRecordIndex = normalizedRecordIndex;
      return;
    }

    logicalUploadCount += 1;
    const payloadLength = nonnegativeIntegerOr(payloadBytes, 0);
    const copyLength = nonnegativeIntegerOr(alignedBytes, 0);
    logicalPayloadBytes += payloadLength;
    alignedCopyBytes += copyLength;
    if (hasDestination && copyLength > 0) currentScalarSetCalls += 1;

    if (lastObservedRecordIndex !== null &&
        ((normalizedRecordIndex - lastObservedRecordIndex) >>> 0) !== 1) {
      ownershipOrderHazardCount += 1;
      split("recordDiscontinuity");
    }
    lastObservedRecordIndex = normalizedRecordIndex;

    const pointer = Number(sourcePointer) >>> 0;
    const arenaBase = Number(sourceArenaBase) >>> 0;
    const arenaSize = Number(sourceArenaSize) >>> 0;
    const arenaEnd = arenaBase + arenaSize;
    let fallbackReason = null;
    let ownershipHazard = false;

    if (!hasDestination) fallbackReason = "missingDestination";
    else if (retained) fallbackReason = "retainedUpload";
    else if (semanticCapture) fallbackReason = "semanticCapture";
    else if (!payloadLength || !copyLength || copyLength % 4 !== 0 ||
        copyLength < payloadLength) fallbackReason = "invalidLength";
    else if (copyLength > envelopeCapacity) fallbackReason = "payloadTooLarge";
    else if (!arenaSize || pointer < arenaBase || pointer >= arenaEnd) {
      fallbackReason = "outsideArena";
    } else if (copyLength > arenaEnd - pointer) {
      fallbackReason = "physicalRangeWrap";
      ownershipHazard = true;
    }

    if (fallbackReason) {
      finishRun();
      recordFallback(fallbackReason, payloadLength, copyLength, ownershipHazard);
      return;
    }

    if (!currentRun) {
      startRun(normalizedRecordIndex, pointer, payloadLength, copyLength);
      return;
    }

    if (pointer < currentRun.sourceStart) {
      sourceArenaWrapCount += 1;
      split("sourceArenaWrap");
      startRun(normalizedRecordIndex, pointer, payloadLength, copyLength);
      return;
    }
    if (pointer < currentRun.sourceEnd) {
      finishRun();
      recordFallback("sourceOverlap", payloadLength, copyLength, true);
      return;
    }

    const nextEnd = pointer + copyLength;
    if (nextEnd - currentRun.sourceStart > envelopeCapacity) {
      split("capacity");
      startRun(normalizedRecordIndex, pointer, payloadLength, copyLength);
      return;
    }

    currentRun.lastRecordIndex = normalizedRecordIndex;
    currentRun.sourceEnd = nextEnd;
    currentRun.logicalPayloadBytes += payloadLength;
    currentRun.alignedCopyBytes += copyLength;
    currentRun.uploadCount += 1;
    eligibleUploadCount += 1;
    eligibleLogicalPayloadBytes += payloadLength;
    eligibleAlignedCopyBytes += copyLength;
  }

  function boundary(reason = "boundary") {
    const normalizedReason = String(reason || "boundary");
    if (currentRun) {
      finishRun();
      boundaryCount += 1;
      boundaryReasons[normalizedReason] = (boundaryReasons[normalizedReason] || 0) + 1;
    }
    lastObservedRecordIndex = null;
  }

  function reset(reason = "reset") {
    boundary(reason);
    const normalizedReason = String(reason || "reset");
    resetCount += 1;
    resetReasons[normalizedReason] = (resetReasons[normalizedReason] || 0) + 1;
  }

  function snapshot({ requested = false, active = requested } = {}) {
    const pendingRuns = currentRun ? 1 : 0;
    const pendingUploads = currentRun?.uploadCount ?? 0;
    const pendingEnvelopeBytes = currentRun
      ? currentRun.sourceEnd - currentRun.sourceStart
      : 0;
    const pendingAlignedCopyBytes = currentRun?.alignedCopyBytes ?? 0;
    const runs = finalizedRunCount + pendingRuns;
    const runUploads = finalizedRunUploadCount + pendingUploads;
    const envelopeBytes = finalizedEnvelopeBytes + pendingEnvelopeBytes;
    const gapBytes = finalizedGapBytes + Math.max(
      0,
      pendingEnvelopeBytes - pendingAlignedCopyBytes
    );
    const projectedSetCalls = Math.max(
      0,
      currentScalarSetCalls - eligibleUploadCount + runs
    );
    const histogram = [...runLengthHistogram];
    if (pendingUploads > 0) histogram[bucketIndex(pendingUploads)] += 1;
    const effectiveMin = pendingUploads > 0
      ? Math.min(runLengthMin, pendingUploads)
      : runLengthMin;
    const effectiveMax = Math.max(runLengthMax, pendingUploads);

    return {
      schema: WGPU_UPLOAD_RUN_PROJECTION_SCHEMA,
      requested: Boolean(requested),
      active: Boolean(active),
      enabled: Boolean(active),
      projectionOnly: true,
      replayBehaviorChanged: false,
      runtimeEligible: false,
      maxEnvelopeBytes: envelopeCapacity,
      uploads: {
        logical: logicalUploadCount,
        eligible: eligibleUploadCount,
        fallback: fallbackUploadCount,
        currentScalarSetCalls,
      },
      projected: {
        runs,
        setCalls: projectedSetCalls,
        setCallReduction: Math.max(0, currentScalarSetCalls - projectedSetCalls),
        scatterCopyCommands: eligibleUploadCount,
      },
      bytes: {
        logicalPayload: logicalPayloadBytes,
        eligibleLogicalPayload: eligibleLogicalPayloadBytes,
        fallbackLogicalPayload: fallbackLogicalPayloadBytes,
        alignedCopy: alignedCopyBytes,
        eligibleAlignedCopy: eligibleAlignedCopyBytes,
        fallbackAlignedCopy: fallbackAlignedCopyBytes,
        alignmentPadding: Math.max(0, alignedCopyBytes - logicalPayloadBytes),
        envelope: envelopeBytes,
        gap: gapBytes,
        gapInflationRatio: eligibleAlignedCopyBytes > 0
          ? gapBytes / eligibleAlignedCopyBytes
          : 0,
      },
      runLength: {
        min: runs > 0 ? effectiveMin : 0,
        max: effectiveMax,
        average: runs > 0 ? runUploads / runs : 0,
        p50UpperBound: percentileUpperBound(histogram, runs, 0.50),
        p95UpperBound: percentileUpperBound(histogram, runs, 0.95),
        p99UpperBound: percentileUpperBound(histogram, runs, 0.99),
        bucketUpperBounds: RUN_LENGTH_BUCKET_BOUNDS.map(finiteBucketBound),
        histogram,
      },
      wraps: {
        sourceArena: sourceArenaWrapCount,
        physicalRange: fallbackReasons.physicalRangeWrap || 0,
      },
      fallbacks: {
        total: fallbackCount,
        reasons: { ...fallbackReasons },
      },
      splits: {
        total: splitCount,
        reasons: { ...splitReasons },
      },
      hazards: { ownershipOrder: ownershipOrderHazardCount },
      boundaries: {
        total: boundaryCount,
        reasons: { ...boundaryReasons },
        resets: resetCount,
        resetReasons: { ...resetReasons },
      },
    };
  }

  function startRun(recordIndex, sourceStart, payloadBytes, copyBytes) {
    currentRun = {
      firstRecordIndex: recordIndex,
      lastRecordIndex: recordIndex,
      sourceStart,
      sourceEnd: sourceStart + copyBytes,
      logicalPayloadBytes: payloadBytes,
      alignedCopyBytes: copyBytes,
      uploadCount: 1,
    };
    eligibleUploadCount += 1;
    eligibleLogicalPayloadBytes += payloadBytes;
    eligibleAlignedCopyBytes += copyBytes;
  }

  function finishRun() {
    if (!currentRun) return;
    const envelopeBytes = currentRun.sourceEnd - currentRun.sourceStart;
    finalizedRunCount += 1;
    finalizedRunUploadCount += currentRun.uploadCount;
    finalizedEnvelopeBytes += envelopeBytes;
    finalizedGapBytes += Math.max(0, envelopeBytes - currentRun.alignedCopyBytes);
    runLengthMin = Math.min(runLengthMin, currentRun.uploadCount);
    runLengthMax = Math.max(runLengthMax, currentRun.uploadCount);
    runLengthHistogram[bucketIndex(currentRun.uploadCount)] += 1;
    currentRun = null;
  }

  function split(reason) {
    if (currentRun) finishRun();
    splitCount += 1;
    splitReasons[reason] = (splitReasons[reason] || 0) + 1;
  }

  function recordFallback(reason, payloadBytes, copyBytes, ownershipHazard) {
    fallbackUploadCount += 1;
    fallbackLogicalPayloadBytes += payloadBytes;
    fallbackAlignedCopyBytes += copyBytes;
    fallbackCount += 1;
    fallbackReasons[reason] = (fallbackReasons[reason] || 0) + 1;
    if (ownershipHazard) ownershipOrderHazardCount += 1;
  }

  return { observeAcceptedRecord, boundary, reset, snapshot };
}

function bucketIndex(length) {
  for (let index = 0; index < RUN_LENGTH_BUCKET_BOUNDS.length; index += 1) {
    if (length <= RUN_LENGTH_BUCKET_BOUNDS[index]) return index;
  }
  return RUN_LENGTH_BUCKET_BOUNDS.length - 1;
}

function percentileUpperBound(histogram, total, percentile) {
  if (total <= 0) return 0;
  const target = Math.max(1, Math.ceil(total * percentile));
  let count = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    count += histogram[index];
    if (count >= target) return finiteBucketBound(RUN_LENGTH_BUCKET_BOUNDS[index]);
  }
  return finiteBucketBound(RUN_LENGTH_BUCKET_BOUNDS.at(-1));
}

function finiteBucketBound(value) {
  return Number.isFinite(value) ? value : null;
}

function positiveIntegerOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonnegativeIntegerOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}
