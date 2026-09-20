// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { decodeLegacyWgpuCommandRecord } from "./wgpu-legacy-semantic-decoder.js";
import { createWgpuOwnershipCommandCorrelator } from
  "./wgpu-ownership-command-correlator.js";
import { createWgpuSemanticParitySink } from "./wgpu-semantic-parity-sink.js";
import { WGPU_OWNERSHIP_EVENT } from "./wgpu-ownership-trace.js";

export const WGPU_SEMANTIC_RUNTIME_SCHEMA =
  "wasm-dolphin.wgpu-semantic-runtime.v1";
export const DEFAULT_WGPU_SEMANTIC_MIN_COMMITTED_EVENTS = 128;
// Ownership draining stops at LoadRequested, so the runtime only ever retains
// the boundary itself while preceding legacy commands catch up. Keeping this
// at one prevents a semantic diagnostic from copying a native-ring suffix into
// thousands of short-lived JS objects.
export const DEFAULT_WGPU_SEMANTIC_MAX_DEFERRED_OWNERSHIP_RECORDS = 1;

export function requestedWgpuSemanticRuntime(search = "") {
  return new URLSearchParams(search).get("wgpusemantic") === "1";
}

export function createWgpuSemanticRuntime({
  requested = false,
  active = false,
  initialConsumerResetAttestation = null,
  minimumCommittedEventCount = DEFAULT_WGPU_SEMANTIC_MIN_COMMITTED_EVENTS,
  maxDeferredOwnershipRecordCount =
    DEFAULT_WGPU_SEMANTIC_MAX_DEFERRED_OWNERSHIP_RECORDS,
  now,
} = {}) {
  const enabled = Boolean(active);
  const minimumCommitted = positiveSafeInteger(
    minimumCommittedEventCount,
    "minimumCommittedEventCount"
  );
  const deferredOwnershipLimit = positiveSafeInteger(
    maxDeferredOwnershipRecordCount,
    "maxDeferredOwnershipRecordCount"
  );
  const reasons = new Set();
  let failed = false;
  let preparedRecordCount = 0;
  let acceptedRecordCount = 0;
  let discardedPreparedRecordCount = 0;
  let retriedPreparedRecordCount = 0;
  let ownershipBatchCount = 0;
  let failureOwnershipRecords = Object.freeze([]);
  let deferredOwnershipRecords = [];
  let deferredOwnershipHealth = null;
  let capturePhase = enabled ? "capturing" : "off";
  let captureStopRequested = false;
  let nativeStopRequestSent = false;
  let lastObservedCheckpointGeneration = 0;
  let loadBoundaryGenerationFloor = 0;
  let loadBoundaryObserved = false;
  let loadedCheckpointGeneration = 0;
  let stopCheckpointGeneration = 0;
  let frozenCompactSnapshot = null;
  let frozenDetailedSnapshot = null;

  const sink = enabled ? createWgpuSemanticParitySink({ now }) : null;
  const correlator = enabled ? createWgpuOwnershipCommandCorrelator({
    semanticSink: sink,
    initialConsumerResetAttestation,
  }) : null;

  function pushOwnership(records, health = {}, {
    loadedCheckpointGeneration: checkpointGeneration,
  } = {}) {
    if (!captureOpen()) return 0;
    if (!Array.isArray(records)) {
      invalidate("ownership ingestion failed: ownership records must be an array");
      return 0;
    }
    ownershipBatchCount += 1;
    const boundaryIndexes = [];
    for (let index = 0; index < records.length; index += 1) {
      if (Number(records[index]?.event) === WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED) {
        boundaryIndexes.push(index);
      }
    }
    if (boundaryIndexes.length > 1 ||
        (deferredOwnershipRecords.length !== 0 && boundaryIndexes.length !== 0)) {
      retainFailureOwnershipRecords(records);
      invalidate("multiple LoadRequested boundaries cannot be deferred safely");
      return 0;
    }

    if (boundaryIndexes.length === 1 && boundaryIndexes[0] !== records.length - 1) {
      retainFailureOwnershipRecords(records);
      invalidate("LoadRequested boundary must terminate the ownership drain");
      return 0;
    }

    observeCheckpointGeneration(checkpointGeneration, {
      loadBoundary: boundaryIndexes.length === 1,
    });

    if (deferredOwnershipRecords.length !== 0) {
      if (records.length !== 0) {
        retainFailureOwnershipRecords(records);
        invalidate("ownership drain advanced while LoadRequested was deferred");
      } else {
        pushCorrelatorOwnership([], health);
      }
      return 0;
    }

    if (boundaryIndexes.length === 0) {
      return pushCorrelatorOwnership(records, health);
    }

    const boundaryIndex = boundaryIndexes[0];
    const prefix = records.slice(0, boundaryIndex);
    const boundary = records[boundaryIndex];
    const paired = prefix.length === 0
      ? pushCorrelatorOwnership([], health)
      : pushCorrelatorOwnership(prefix, health);
    if (!captureOpen()) return paired;
    if (correlator.checkpoint({ compact: true }).fullyQuiescent) {
      return paired + pushCorrelatorOwnership([boundary], health);
    }
    deferOwnership([boundary], health);
    return paired;
  }

  function prepareLegacy(record, heapBytes = null, options = {}) {
    if (!captureOpen()) return null;
    try {
      const decoded = decodeLegacyWgpuCommandRecord(record, heapBytes, options);
      preparedRecordCount += 1;
      return Object.freeze({
        ...decoded,
        args: Object.freeze([...decoded.args]),
        payloadBytes: Uint8Array.from(decoded.payloadBytes),
      });
    } catch (error) {
      invalidate(`legacy preparation failed: ${error?.message || error}`);
      return null;
    }
  }

  function acceptPrepared(prepared, recordIndex) {
    if (!captureOpen() || !prepared) return 0;
    try {
      const paired = correlator.pushLegacy([{ ...prepared, recordIndex }]);
      acceptedRecordCount += 1;
      absorbCorrelatorFailure();
      return paired + flushDeferredOwnershipIfQuiescent();
    } catch (error) {
      invalidate(`legacy acceptance failed: ${error?.message || error}`);
      return 0;
    }
  }

  function discardPrepared(prepared, reason = "consumer discarded an accepted ring record") {
    if (!captureOpen() || !prepared) return;
    discardedPreparedRecordCount += 1;
    invalidate(reason);
  }

  function retryPrepared(prepared) {
    if (!captureOpen() || !prepared) return;
    retriedPreparedRecordCount += 1;
  }

  function invalidate(reason) {
    if (!enabled || capturePhase === "frozen") return;
    failed = true;
    capturePhase = "failed";
    reasons.add(String(reason || "semantic runtime invalidated"));
    try {
      sink.markMismatch();
    } catch {
      reasons.add("semantic mismatch marker failed");
    }
  }

  function maybeRequestCaptureEnd({
    commandRingRead,
    commandRingWrite,
    ownershipHealth,
    loadedCheckpointGeneration: checkpointGeneration,
  } = {}) {
    if (!captureOpen() || captureStopRequested) return false;
    const currentCheckpointGeneration = eligibleCheckpointGeneration(checkpointGeneration);
    observeCheckpointGeneration(checkpointGeneration);
    if (currentCheckpointGeneration === 0 ||
        currentCheckpointGeneration !== loadedCheckpointGeneration) {
      return false;
    }
    const read = u32(commandRingRead, "commandRingRead");
    const write = u32(commandRingWrite, "commandRingWrite");
    if (!healthyTrace(ownershipHealth)) return false;
    const checkpoint = correlator.checkpoint({ compact: true });
    const qualification = captureQualification(checkpoint);
    const sinkState = checkpoint?.sink ?? null;
    const committedPrefixEligible = Boolean(
      checkpoint?.committedPrefixValid &&
      checkpoint?.initialConsumerResetAttested &&
      discardedPreparedRecordCount === 0 &&
      sinkState?.dependencyEncodingReady &&
      sinkState?.independentDecodingReady
    );
    if (!committedPrefixEligible || !qualification.qualificationReady) {
      return false;
    }
    captureStopRequested = true;
    stopCheckpointGeneration = loadedCheckpointGeneration;
    capturePhase = "stop-requested";
    return true;
  }

  function markNativeStopRequestSent() {
    if (!captureStopRequested || nativeStopRequestSent || !captureOpen()) return false;
    nativeStopRequestSent = true;
    return true;
  }

  function maybeFreezeCapture({
    commandRingRead,
    commandRingWrite,
    ownershipHealth,
    loadedCheckpointGeneration: checkpointGeneration,
  } = {}) {
    if (!captureOpen() || !nativeStopRequestSent) return null;
    const currentCheckpointGeneration = eligibleCheckpointGeneration(checkpointGeneration);
    if (currentCheckpointGeneration !== stopCheckpointGeneration) {
      invalidate(
        `loaded checkpoint generation changed after capture stop ` +
        `${stopCheckpointGeneration} -> ${currentCheckpointGeneration}`
      );
      return null;
    }
    const read = u32(commandRingRead, "commandRingRead");
    const write = u32(commandRingWrite, "commandRingWrite");
    if (read !== write || !healthyDrainedTrace(ownershipHealth)) return null;
    const checkpoint = correlator.checkpoint({ compact: false });
    if (!checkpoint.captureEndSeen || write !== checkpoint.captureEndCommandRingWrite) {
      return null;
    }
    const qualification = captureQualification(checkpoint);
    const detailedState = buildSnapshot({ detailed: true, checkpoint, qualification });
    if (!detailedState.evidenceValid || !qualification.qualificationReady) {
      return null;
    }
    capturePhase = "frozen";
    frozenDetailedSnapshot = Object.freeze({
      ...detailedState,
      capturePhase,
      captureComplete: true,
    });
    frozenCompactSnapshot = frozenDetailedSnapshot;
    return Object.freeze({
      captureId: checkpoint.captureId,
      commandRingWrite: checkpoint.captureEndCommandRingWrite,
      commandSerial: checkpoint.captureEndCommandSerial,
    });
  }

  function captureControl() {
    const checkpoint = capturePhase === "frozen"
      ? frozenCompactSnapshot?.checkpoint ?? null
      : correlator?.checkpoint({ compact: true }) ?? null;
    const qualification = capturePhase === "frozen"
      ? frozenCompactSnapshot
      : captureQualification(checkpoint);
    return Object.freeze({
      open: captureOpen(),
      phase: capturePhase,
      stopRequested: captureStopRequested,
      nativeStopRequestPending:
        captureStopRequested && !nativeStopRequestSent && captureOpen(),
      nativeStopRequestSent,
      captureEndSeen: Boolean(checkpoint?.captureEndSeen),
      captureId: checkpoint?.captureId ?? 0,
      captureComplete: capturePhase === "frozen",
      loadedCheckpointGeneration: qualification?.loadedCheckpointGeneration ?? 0,
      loadEpochCount: qualification?.loadEpochCount ?? 0,
      currentEpochCommittedEventCount:
        qualification?.currentEpochCommittedEventCount ?? 0,
      deferredOwnershipRecordCount: deferredOwnershipRecords.length,
      deferredLoadBoundaryCount: deferredOwnershipRecords.length,
      qualificationReady: Boolean(qualification?.qualificationReady),
    });
  }

  function snapshot({ detailed = false } = {}) {
    if (capturePhase === "frozen") {
      return detailed ? frozenDetailedSnapshot : frozenCompactSnapshot;
    }
    return buildSnapshot({ detailed });
  }

  function buildSnapshot({ detailed = false, checkpoint = null, qualification = null } = {}) {
    checkpoint ??= correlator?.checkpoint({ compact: !detailed }) ?? null;
    qualification ??= captureQualification(checkpoint);
    const correlatorState = correlator?.snapshot() ?? null;
    // checkpoint already obtained the sink state. Reusing it avoids a second
    // registry snapshot in the 5 Hz causal-telemetry path.
    const sinkState = checkpoint?.sink ?? null;
    const evidenceValid = Boolean(
      enabled &&
      !failed &&
      checkpoint?.valid &&
      checkpoint?.initialConsumerResetAttested &&
      discardedPreparedRecordCount === 0 &&
      sinkState?.dependencyEncodingReady &&
      sinkState?.independentDecodingReady
    );
    return Object.freeze({
      schema: WGPU_SEMANTIC_RUNTIME_SCHEMA,
      requested: Boolean(requested),
      active: enabled,
      failed: failed || Boolean(correlatorState?.failed) || Boolean(sinkState?.failed),
      reasons: Object.freeze([...reasons]),
      workerIntegrationActive: enabled,
      detailed: Boolean(detailed),
      evidenceValid,
      captureScope: "bounded-prefix",
      capturePhase,
      captureComplete: false,
      captureStopRequested,
      nativeStopRequestSent,
      minimumCommittedEventCount: minimumCommitted,
      loadedCheckpointGeneration: qualification.loadedCheckpointGeneration,
      loadEpochCount: qualification.loadEpochCount,
      currentEpochCommittedEventCount: qualification.currentEpochCommittedEventCount,
      qualificationReady: qualification.qualificationReady,
      captureEndSeen: Boolean(checkpoint?.captureEndSeen),
      captureEndCommandRingWrite: checkpoint?.captureEndCommandRingWrite ?? 0,
      captureEndCommandSerial: checkpoint?.captureEndCommandSerial ?? 0,
      captureId: checkpoint?.captureId ?? 0,
      preparedRecordCount,
      acceptedRecordCount,
      discardedPreparedRecordCount,
      retriedPreparedRecordCount,
      ownershipBatchCount,
      failureOwnershipRecords,
      maxDeferredOwnershipRecordCount: deferredOwnershipLimit,
      deferredOwnershipRecordCount: deferredOwnershipRecords.length,
      deferredLoadBoundaryCount: deferredOwnershipRecords.length,
      loadBoundaryObserved,
      loadBoundaryGenerationFloor,
      stopCheckpointGeneration,
      deferredOwnershipRecordsIncluded: Boolean(detailed),
      deferredOwnershipRecords: Object.freeze(
        detailed ? deferredOwnershipRecords.map((record) => Object.freeze({ ...record })) : []
      ),
      checkpoint,
      correlator: correlatorState,
      parity: sinkState,
    });
  }

  function captureQualification(checkpoint) {
    const parity = checkpoint?.sink ?? null;
    const loadEpochCount = nonnegativeSafeInteger(
      parity?.resourceTracker?.loadEpochCount
    );
    const currentEpochCommittedEventCount = sequenceCount(
      parity?.sequenceHi,
      parity?.sequenceLo
    );
    return Object.freeze({
      loadedCheckpointGeneration,
      loadEpochCount,
      currentEpochCommittedEventCount,
      qualificationReady:
        loadBoundaryObserved &&
        loadedCheckpointGeneration > 0 &&
        loadEpochCount >= 1 &&
        currentEpochCommittedEventCount >= minimumCommitted &&
        deferredOwnershipRecords.length === 0,
    });
  }

  function pushCorrelatorOwnership(records, health) {
    try {
      const paired = correlator.pushOwnership(records, health);
      const correlatorState = correlator.snapshot();
      if (correlatorState.failed) retainFailureOwnershipRecords(records);
      absorbCorrelatorFailure(correlatorState);
      return paired;
    } catch (error) {
      retainFailureOwnershipRecords(records);
      invalidate(`ownership ingestion failed: ${error?.message || error}`);
      return 0;
    }
  }

  function deferOwnership(records, health) {
    if (deferredOwnershipRecords.length + records.length > deferredOwnershipLimit) {
      retainFailureOwnershipRecords([...deferredOwnershipRecords, ...records]);
      invalidate(
        `deferred ownership record limit ${deferredOwnershipLimit} exceeded`
      );
      return false;
    }
    for (const record of records) {
      deferredOwnershipRecords.push(Object.freeze({ ...record }));
    }
    deferredOwnershipHealth = Object.freeze({ ...health });
    return true;
  }

  function flushDeferredOwnershipIfQuiescent() {
    if (deferredOwnershipRecords.length === 0 || !captureOpen()) return 0;
    if (!correlator.checkpoint({ compact: true }).fullyQuiescent) return 0;
    const records = deferredOwnershipRecords;
    const health = deferredOwnershipHealth ?? {};
    deferredOwnershipRecords = [];
    deferredOwnershipHealth = null;
    return pushCorrelatorOwnership(records, health);
  }

  function retainFailureOwnershipRecords(records) {
    if (failureOwnershipRecords.length !== 0) return;
    failureOwnershipRecords = Object.freeze(
      records.slice(-64).map((record) => Object.freeze({ ...record }))
    );
  }

  function absorbCorrelatorFailure(state = correlator.snapshot()) {
    if (!state.failed) return;
    failed = true;
    for (const reason of state.reasons) reasons.add(reason);
  }

  function captureOpen() {
    return enabled && !failed && capturePhase !== "frozen";
  }

  function isOpen() {
    return captureOpen();
  }

  function canDrainOwnership() {
    return captureOpen() && deferredOwnershipRecords.length === 0;
  }

  function observeCheckpointGeneration(value, { loadBoundary = false } = {}) {
    const current = eligibleCheckpointGeneration(value);
    if (loadBoundary) {
      loadBoundaryObserved = true;
      loadBoundaryGenerationFloor = lastObservedCheckpointGeneration;
      // The native applied-load callback publishes checkpoint generation
      // before requesting this boundary. The producer may defer the boundary
      // until an active pass closes, so JS can legitimately observe the same
      // generation before the boundary record itself arrives.
      loadedCheckpointGeneration = current;
    } else if (loadBoundaryObserved && loadedCheckpointGeneration === 0 &&
        generationAdvanced(loadBoundaryGenerationFloor, current)) {
      loadedCheckpointGeneration = current;
    }
    if (current !== 0 || lastObservedCheckpointGeneration === 0) {
      lastObservedCheckpointGeneration = current;
    }
  }

  return Object.freeze({
    isOpen,
    canDrainOwnership,
    pushOwnership,
    prepareLegacy,
    acceptPrepared,
    discardPrepared,
    retryPrepared,
    invalidate,
    maybeRequestCaptureEnd,
    markNativeStopRequestSent,
    maybeFreezeCapture,
    captureControl,
    snapshot,
  });
}

function healthyDrainedTrace(value) {
  return Boolean(
    healthyTrace(value) &&
    Number(value.backlog) === 0
  );
}

function healthyTrace(value) {
  return Boolean(
    value?.registered === true &&
    Number(value.nativeDropped) === 0 &&
    Number(value.recordEpochMismatchCount) === 0 &&
    Number(value.monotonicOrderingViolationCount) === 0 &&
    Number(value.malformedHeaderCount) === 0 &&
    Number(value.malformedDescriptorCount) === 0
  );
}

function positiveSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return number;
}

function eligibleCheckpointGeneration(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 0xffff_ffff
    ? number >>> 0
    : 0;
}

function generationAdvanced(previous, next) {
  const before = eligibleCheckpointGeneration(previous);
  const after = eligibleCheckpointGeneration(next);
  if (after === 0) return false;
  const distance = (after - before) >>> 0;
  return distance > 0 && distance < 0x8000_0000;
}

function nonnegativeSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function sequenceCount(sequenceHi, sequenceLo) {
  const high = Number(sequenceHi);
  const low = Number(sequenceLo);
  if (!Number.isInteger(high) || high < 0 || high > 0xffff_ffff ||
      !Number.isInteger(low) || low < 0 || low > 0xffff_ffff) {
    return 0;
  }
  const count = high * 0x1_0000_0000 + low;
  // The configured minimum is a safe integer. Saturation preserves the exact
  // qualification comparison while keeping snapshots JSON-serializable.
  return Number.isSafeInteger(count) ? count : Number.MAX_SAFE_INTEGER;
}

function u32(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw new RangeError(`${name} must be a u32`);
  }
  return number >>> 0;
}
