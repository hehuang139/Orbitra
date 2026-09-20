// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { bytesToHex, sha256 } from "./incremental-sha256.js";
import {
  WGPU_SEMANTIC_DIGEST_SCHEMA,
  WGPU_SEMANTIC_DIGEST_SCHEMA_V2,
} from "./wgpu-semantic-digest.js";
import {
  WGPU_COMMAND_PUBLICATION,
  WGPU_OWNERSHIP_EVENT,
} from "./wgpu-ownership-trace.js";
import {
  isAuthenticInitialWgpuConsumerResetAttestation,
} from "./wgpu-consumer-reset-attestation.js";

export { WGPU_COMMAND_PUBLICATION, WGPU_OWNERSHIP_EVENT };

export const WGPU_OWNERSHIP_COMMAND_CORRELATOR_SCHEMA =
  "wasm-dolphin.wgpu-ownership-command-correlator.v1";
export const WGPU_CORRELATION_EPOCH_KIND = Object.freeze({
  OBSERVATION_START: "observation-start",
  CONSUMER_RESET: "consumer-reset",
  LOAD: "load",
});

const SUBMIT_PRESENT_OPCODE = 22;
const UPLOAD_BUFFER_OPCODE = 6;
const OWNERSHIP_TRACE_VERSION = 1;
const EMPTY_BYTES = new Uint8Array(0);
const LEGACY_RECORD_BYTES = 32;
const MAX_PAYLOAD_PAGE_BYTES = 4 * 1024 * 1024;
const PASS_PACKAGE_OPPORTUNITY_SCHEMA =
  "wasm-dolphin.wgpu-pass-package-opportunity.v1";

// This is an observational join, not a replay path. The ownership lane says
// when a producer command became globally visible; the legacy lane supplies
// the exact command semantics and payload bytes. Only joined records are sent
// to the injected sink, in legacy-ring order.
export function createWgpuOwnershipCommandCorrelator({
  semanticSink,
  maxPendingRecords = 262_144,
  initialConsumerResetAttestation = null,
} = {}) {
  const sink = normalizeSink(semanticSink);
  const pendingLimit = positiveSafeInteger(maxPendingRecords, "maxPendingRecords");
  const initialConsumerResetAttested =
    isAuthenticInitialWgpuConsumerResetAttestation(initialConsumerResetAttestation);
  const immediatePublished = [];
  const stagedPublished = [];
  const publicationOrder = [];
  const legacy = [];
  let immediateRead = 0;
  let stagedRead = 0;
  let publicationRead = 0;
  let legacyRead = 0;
  const transactions = new Map();
  const reasons = new Set();
  const lifecycleCounts = new Float64Array(12);
  let currentTransaction = 0;
  let epoch = null;
  let lastCommandSerial = null;
  let lastLegacyRecordIndex = null;
  let nativeDropped = 0;
  let failed = false;
  let observedOwnershipRecords = 0;
  let observedLegacyRecords = 0;
  let pairedRecords = 0;
  let discardedPrivateRecords = 0;
  let completedTransactions = 0;
  let resetCount = 0;
  let historicalFailureCount = 0;
  let generation = 0;
  let epochOpened = false;
  let retiredTransactionHighWater = 0;
  let captureEndSeen = false;
  let captureEndCommandRingWrite = 0;
  let captureEndCommandSerial = 0;
  let captureId = 0;
  let packageOpportunity = createPackageOpportunityState();

  function pushOwnership(records, health = {}) {
    if (!Array.isArray(records)) {
      throw new TypeError("ownership records must be an array");
    }
    try {
      applyHealth(health);
    } catch (error) {
      fail(`invalid ownership health: ${error?.message || error}`);
    }
    if (failed) return 0;
    const before = pairedRecords;
    for (const input of records) {
      if (failed) break;
      try {
        const record = normalizeOwnershipRecord(input);
        observedOwnershipRecords += 1;
        processOwnership(record);
        reconcile();
      } catch (error) {
        fail(`invalid ownership record: ${error?.message || error}`);
      }
    }
    return pairedRecords - before;
  }

  function transaction(id) {
    let state = transactions.get(id);
    if (!state) {
      if (id <= retiredTransactionHighWater) {
        throw new Error(`transaction ${id} is already retired`);
      }
      if (pendingRecordCount() >= pendingLimit) {
        throw new Error(`correlator pending-record limit ${pendingLimit} exceeded`);
      }
      state = transactionState(id);
      transactions.set(id, state);
    }
    return state;
  }

  function pushLegacy(commands) {
    if (!Array.isArray(commands)) {
      throw new TypeError("legacy commands must be an array");
    }
    if (failed) return 0;
    const before = pairedRecords;
    for (const input of commands) {
      if (failed) break;
      let actual;
      try {
        actual = snapshotLegacyCommand(input);
      } catch (error) {
        fail(`invalid legacy record: ${error?.message || error}`);
        break;
      }
      if (
        lastLegacyRecordIndex != null &&
        actual.recordIndex !== ((lastLegacyRecordIndex + 1) >>> 0)
      ) {
        fail(
          `legacy record index gap ${lastLegacyRecordIndex} -> ${actual.recordIndex}`
        );
        break;
      }
      if (!reservePendingRecord()) break;
      lastLegacyRecordIndex = actual.recordIndex;
      legacy.push(actual);
      observedLegacyRecords += 1;
      reconcile();
    }
    return pairedRecords - before;
  }

  function applyHealth(health = {}) {
    const dropped = optionalCount(health.nativeDropped, nativeDropped);
    nativeDropped = Math.max(nativeDropped, dropped);
    if (nativeDropped !== 0) fail("native ownership trace dropped records");
    for (const [field, label] of [
      ["recordEpochMismatchCount", "ownership trace epoch mismatch"],
      ["monotonicOrderingViolationCount", "ownership trace ordering violation"],
      ["malformedHeaderCount", "ownership trace malformed header"],
      ["malformedDescriptorCount", "ownership trace malformed descriptor"],
    ]) {
      if (optionalCount(health[field], 0) !== 0) fail(label);
    }
    if (health.registered === false) fail("ownership trace is not registered");
  }

  function processOwnership(record) {
    const event = record.event;
    if (event < lifecycleCounts.length) lifecycleCounts[event] += 1;
    else return fail(`unknown ownership event ${event}`);

    if (!epochOpened && event !== WGPU_OWNERSHIP_EVENT.EPOCH) {
      return fail("ownership stream did not begin with an epoch record");
    }
    if (epochOpened && event !== WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED &&
        record.epoch !== epoch) {
      return fail("ownership epoch changed without LoadRequested");
    }

    switch (event) {
      case WGPU_OWNERSHIP_EVENT.EPOCH:
        if (epochOpened) return fail("duplicate ownership epoch record");
        if (record.transactionId !== 0 || record.opcode !== 0 ||
            record.resourceId !== OWNERSHIP_TRACE_VERSION ||
            record.payloadLength !== 0 || record.auxiliary !== 0) {
          return fail("ownership epoch record does not match ABI version 1");
        }
        epoch = record.epoch;
        epochOpened = true;
        try {
          // The native initial epoch attests only that ownership tracing was
          // enabled. Upgrade it to a reset boundary only when the trusted JS
          // capture proved every browser resource map empty before attach.
          sink.beginEpoch(epoch, {
            kind: initialConsumerResetAttested
              ? WGPU_CORRELATION_EPOCH_KIND.CONSUMER_RESET
              : WGPU_CORRELATION_EPOCH_KIND.OBSERVATION_START,
          });
        } catch (error) {
          return fail(`semantic sink epoch begin failed: ${error?.message || error}`);
        }
        return;

      case WGPU_OWNERSHIP_EVENT.LOAD_REQUESTED:
        if (record.epoch !== ((epoch + 1) >>> 0)) {
          return fail(`LoadRequested epoch ${record.epoch} does not follow ${epoch}`);
        }
        resetForEpoch(record.epoch, true);
        return;

      case WGPU_OWNERSHIP_EVENT.COMMAND:
        if (captureEndSeen) return fail("ownership command arrived after capture end");
        return processCommand(record);

      case WGPU_OWNERSHIP_EVENT.CAPTURE_END:
        if (captureEndSeen) return fail("duplicate capture end record");
        if (record.transactionId !== 0 || record.opcode !== SUBMIT_PRESENT_OPCODE ||
            record.commandSerial !== lastCommandSerial || record.payloadLength === 0 ||
            record.auxiliary !== 0) {
          return fail("capture end record does not match the terminal ABI");
        }
        captureEndSeen = true;
        captureEndCommandRingWrite = record.resourceId;
        captureEndCommandSerial = record.commandSerial;
        captureId = record.payloadLength;
        return;

      case WGPU_OWNERSHIP_EVENT.PENDING_RESERVED:
        if (!requireTransaction(record, "pending reservation")) return;
        if (transaction(record.transactionId).reserved ||
            transaction(record.transactionId).passBegan ||
            transaction(record.transactionId).completed) {
          const state = transaction(record.transactionId);
          return fail(
            `duplicate or late pending reservation for transaction ${record.transactionId} ` +
            `(serial=${record.commandSerial}, reserved=${Number(state.reserved)}, ` +
            `passBegan=${Number(state.passBegan)}, completed=${Number(state.completed)})`
          );
        }
        transaction(record.transactionId).reserved = true;
        return;

      case WGPU_OWNERSHIP_EVENT.PASS_BEGIN:
        if (!requireTransaction(record, "pass begin")) return;
        if (transaction(record.transactionId).passBegan ||
            transaction(record.transactionId).completed) {
          return fail(`duplicate or late pass begin for transaction ${record.transactionId}`);
        }
        observeTransactionSuccessor(record.transactionId);
        transaction(record.transactionId).passBegan = true;
        return;

      case WGPU_OWNERSHIP_EVENT.COMMIT:
        return commitPrivate(record);

      case WGPU_OWNERSHIP_EVENT.ABORT:
        return abortPrivate(record);

      case WGPU_OWNERSHIP_EVENT.CONSUMER_FAILURE:
        return fail("native WebGPU consumer failure");

      case WGPU_OWNERSHIP_EVENT.POISON:
      case WGPU_OWNERSHIP_EVENT.ROLLBACK:
        return;

      default:
        fail(`unsupported ownership event ${event}`);
    }
  }

  function processCommand(record) {
    if (
      lastCommandSerial != null &&
      record.commandSerial !== ((lastCommandSerial + 1) >>> 0)
    ) {
      return fail(
        `ownership command serial gap ${lastCommandSerial} -> ${record.commandSerial}`
      );
    }
    lastCommandSerial = record.commandSerial;
    const publication = (record.auxiliary >>> 8) & 0x3;
    const attribution = record.auxiliary & 0x3;
    if (publication === 3) return fail("unknown command publication 3");
    if (attribution === 3) return fail("unknown command attribution 3");
    if (attribution === 0 && record.transactionId !== 0) {
      return fail("outside command has a transaction");
    }
    if (attribution !== 0 && record.transactionId === 0) {
      return fail("owned command has no transaction");
    }
    if (
      publication === WGPU_COMMAND_PUBLICATION.IMMEDIATE_ACTIVE &&
      attribution !== 2
    ) {
      return fail("immediate-active publication is not actively attributed");
    }
    if (
      publication === WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED &&
      attribution !== 2
    ) {
      return fail("private staged publication is not actively attributed");
    }
    observePackageOpportunityCommand(record, publication);
    if (record.transactionId !== 0) {
      if (transaction(record.transactionId).completed) {
        return fail(`command arrived after transaction ${record.transactionId} closed`);
      }
      observeTransactionSuccessor(record.transactionId);
    }
    const expected = { ...record, publication };
    if (publication === WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED) {
      if (record.transactionId === 0) {
        return fail("private staged command has no transaction");
      }
      if (!reservePendingRecord()) return;
      transaction(record.transactionId).privateRecords.push(expected);
      return;
    }
    if (!reservePendingRecord()) return;
    publishExpected(expected);
    if (
      record.opcode === SUBMIT_PRESENT_OPCODE &&
      record.transactionId !== 0 &&
      attribution === 2
    ) {
      requestClose(record.transactionId, "submit-present");
    }
  }

  function commitPrivate(record) {
    if (!requireTransaction(record, "commit")) return;
    const state = transaction(record.transactionId);
    if (state.aborted || state.commitSeen) {
      return fail(`duplicate or invalid commit for transaction ${record.transactionId}`);
    }
    if (!state.passBegan) {
      return fail(`commit preceded pass begin for transaction ${record.transactionId}`);
    }
    if (record.resourceId !== state.privateRecords.length) {
      return fail(
        `commit count ${record.resourceId} != ${state.privateRecords.length} private records`
      );
    }
    const beginCount = state.privateRecords.filter((entry) => entry.opcode === 12).length;
    const endCount = state.privateRecords.filter((entry) => entry.opcode === 21).length;
    if (beginCount !== 1 || endCount !== 1) {
      return fail(
        `committed pass requires exactly one BEGIN and END (saw ${beginCount}/${endCount})`
      );
    }
    if (state.privateRecords[0]?.opcode !== 12 ||
        state.privateRecords.at(-1)?.opcode !== 21 ||
        state.privateRecords.some((entry) => entry.opcode < 12 || entry.opcode > 21)) {
      return fail("committed private batch is not a contiguous BEGIN_PASS..END_PASS sequence");
    }
    state.commitSeen = true;
    for (const expected of state.privateRecords) publishExpected(expected, true);
    state.privateRecords.length = 0;
    // Commit is a publication point, not a transaction-close point. Native
    // resource commands can still be attributed to this pass until present or
    // the next transaction creates a successor fence.
    maybeCommitSink(state);
    maybeComplete(state);
  }

  function abortPrivate(record) {
    if (record.transactionId === 0) {
      // A load boundary can report an empty abort immediately before the
      // LoadRequested event. It carries no private rollback scope.
      return;
    }
    const state = transaction(record.transactionId);
    const loadBoundaryAbort = record.opcode === 0 &&
      record.resourceId === 0 && record.payloadLength === 3;
    if (state.commitSeen && loadBoundaryAbort) {
      requestClose(state.id, "load-requested");
      return;
    }
    if (state.commitSeen || state.aborted || state.completed) {
      return fail(`duplicate or post-commit abort for transaction ${record.transactionId}`);
    }
    state.aborted = true;
    state.closeRequested = true;
    state.closeFence = "abort";
    discardedPrivateRecords += state.privateRecords.length;
    state.privateRecords.length = 0;
    if (state.sinkTransactionOpen) {
      try {
        sink.abortTransaction(state.id);
        state.sinkTransactionOpen = false;
        state.sinkTransactionSettled = true;
      } catch (error) {
        return fail(`semantic sink abort failed: ${error?.message || error}`);
      }
    }
    if (currentTransaction === state.id) currentTransaction = 0;
    maybeComplete(state);
  }

  function publishExpected(expected, staged = false) {
    const lane = staged ? stagedPublished : immediatePublished;
    lane.push(expected);
    publicationOrder.push(staged ? 1 : 0);
    if (expected.transactionId !== 0) {
      const state = transaction(expected.transactionId);
      state.outstandingPublished += 1;
      if (staged) state.outstandingStagedPublished += 1;
    }
  }

  function ensureSinkTransaction(state) {
    if (state.sinkTransactionOpen || state.sinkTransactionSettled) return;
    try {
      sink.beginTransaction(state.id);
      state.sinkTransactionOpen = true;
    } catch (error) {
      fail(`semantic sink begin failed: ${error?.message || error}`);
    }
  }

  function maybeCommitSink(state) {
    if (
      failed ||
      !state.commitSeen ||
      state.outstandingStagedPublished !== 0
    ) {
      return false;
    }
    if (!state.sinkTransactionOpen) {
      state.sinkTransactionSettled = true;
      return true;
    }
    try {
      sink.commitTransaction(state.id);
      state.sinkTransactionOpen = false;
      state.sinkTransactionSettled = true;
      return true;
    } catch (error) {
      fail(`semantic sink commit failed: ${error?.message || error}`);
      return false;
    }
  }

  function observeTransactionSuccessor(id) {
    if (currentTransaction !== 0 && currentTransaction !== id) {
      requestClose(currentTransaction, "successor");
    }
    currentTransaction = id;
    transaction(id);
  }

  function requestClose(id, fence) {
    const state = transaction(id);
    state.closeRequested = true;
    state.closeFence = fence;
    if (currentTransaction === id) currentTransaction = 0;
    maybeComplete(state);
  }

  function maybeComplete(state) {
    if (
      state.completed ||
      !state.closeRequested ||
      state.privateRecords.length !== 0 ||
      state.outstandingPublished !== 0 ||
      (!state.aborted && !state.commitSeen)
    ) {
      return false;
    }
    state.completed = true;
    completedTransactions += 1;
    if (state.aborted) {
      packageOpportunity.abortedTransactions += 1;
    } else {
      packageOpportunity.committedTransactions += 1;
      packageOpportunity.maximumPackageRecords = Math.max(
        packageOpportunity.maximumPackageRecords,
        state.packageEligibleRecords
      );
      packageOpportunity.maximumPackagePayloadBytes = Math.max(
        packageOpportunity.maximumPackagePayloadBytes,
        state.packageEligiblePayloadBytes
      );
      packageOpportunity.maximumPackageBytes = Math.max(
        packageOpportunity.maximumPackageBytes,
        state.packageEligibleRecords * LEGACY_RECORD_BYTES +
          state.packageEligiblePayloadBytes
      );
    }
    retiredTransactionHighWater = Math.max(retiredTransactionHighWater, state.id);
    transactions.delete(state.id);
    return true;
  }

  function reconcile() {
    while (
      !failed &&
      publicationRead < publicationOrder.length &&
      legacyRead < legacy.length
    ) {
      const staged = publicationOrder[publicationRead] === 1;
      const traceLane = staged ? stagedPublished : immediatePublished;
      const traceRead = staged ? stagedRead : immediateRead;
      const expected = traceLane[traceRead];
      if (!expected) {
        fail(`publication order references an empty ${staged ? "staged" : "immediate"} lane`);
        break;
      }
      const actual = legacy[legacyRead];
      const mismatch = signatureMismatch(expected, actual);
      if (mismatch) {
        fail(
          `ownership/legacy mismatch at opcode ${expected.opcode}, ` +
          `serial ${expected.commandSerial}, legacy record ${actual.recordIndex}: ${mismatch}`
        );
        break;
      }
      publicationRead += 1;
      if (staged) stagedRead += 1;
      else immediateRead += 1;
      legacyRead += 1;
      const emitted = Object.freeze({
        ...actual.event,
        epoch: expected.epoch,
        transaction: expected.transactionId,
        transactionId: expected.transactionId,
        commandSerial: expected.commandSerial,
        publication: expected.publication,
        attribution: expected.auxiliary & 0x3,
        payloadLength: actual.payloadBytes.byteLength,
        payloadSha256: actual.payloadSha256,
        payloadBytes: new Uint8Array(actual.payloadBytes),
      });
      try {
        if (staged && expected.transactionId !== 0) {
          ensureSinkTransaction(transaction(expected.transactionId));
          if (failed) break;
        }
        sink.appendEvent(emitted, { staged });
      } catch (error) {
        fail(`semantic sink rejected command: ${error?.message || error}`);
        break;
      }
      pairedRecords += 1;
      if (expected.transactionId !== 0) {
        const state = transaction(expected.transactionId);
        state.outstandingPublished -= 1;
        if (staged) state.outstandingStagedPublished -= 1;
        state.paired += 1;
        if (state.outstandingPublished < 0 || state.outstandingStagedPublished < 0) {
          fail(`negative outstanding count for transaction ${state.id}`);
          break;
        }
        maybeCommitSink(state);
        maybeComplete(state);
      }
      compactQueues();
    }
  }

  function compactQueues() {
    immediateRead = compactQueue(immediatePublished, immediateRead);
    stagedRead = compactQueue(stagedPublished, stagedRead);
    publicationRead = compactQueue(publicationOrder, publicationRead);
    legacyRead = compactQueue(legacy, legacyRead);
  }

  function checkpoint({ compact = false } = {}) {
    const sinkSnapshot = snapshotSink(semanticSink, { compact });
    const openTransactions = Array.from(transactions.values()).filter(
      (state) => !state.completed
    );
    const prefixReasons = [...reasons];
    if (nativeDropped !== 0) prefixReasons.push("native trace drops are nonzero");
    if (sinkSnapshot && !validSinkPrefix(sinkSnapshot)) {
      prefixReasons.push("semantic sink committed prefix is invalid");
    }
    if (!sinkSnapshot) prefixReasons.push("semantic sink snapshot is unavailable");
    const checkpointReasons = [...prefixReasons];
    const pendingOwnership = publicationOrder.length - publicationRead;
    const pendingLegacy = legacy.length - legacyRead;
    if (pendingOwnership !== 0) checkpointReasons.push("unmatched ownership commands");
    if (pendingLegacy !== 0) checkpointReasons.push("unmatched legacy commands");
    if (openTransactions.length !== 0) checkpointReasons.push("open ownership transactions");
    if (sinkSnapshot && Number(sinkSnapshot.openTransactionCount ?? 0) !== 0) {
      checkpointReasons.push("semantic sink is not checkpoint-clean");
    }
    if (captureEndSeen) {
      const consumedWrite = lastLegacyRecordIndex == null
        ? 0
        : (lastLegacyRecordIndex + 1) >>> 0;
      if (consumedWrite !== captureEndCommandRingWrite) {
        checkpointReasons.push("capture end cutoff does not match consumed legacy prefix");
      }
    }
    const committedPrefixValid = prefixReasons.length === 0;
    const fullyQuiescent = checkpointReasons.length === 0;
    return Object.freeze({
      schema: WGPU_OWNERSHIP_COMMAND_CORRELATOR_SCHEMA,
      valid: fullyQuiescent,
      committedPrefixValid,
      fullyQuiescent,
      reasons: Object.freeze([...new Set(checkpointReasons)]),
      generation,
      epoch: epoch ?? 0,
      initialConsumerResetAttested,
      pairedRecords,
      pendingOwnershipRecords: pendingOwnership,
      pendingLegacyRecords: pendingLegacy,
      openTransactionCount: openTransactions.length,
      nativeDropped,
      lastLegacyRecordIndex: lastLegacyRecordIndex ?? 0,
      captureEndSeen,
      captureEndCommandRingWrite,
      captureEndCommandSerial,
      captureId,
      sink: sinkSnapshot,
    });
  }

  function snapshot() {
    const openTransactions = Array.from(transactions.values()).filter(
      (state) => !state.completed
    );
    return {
      schema: WGPU_OWNERSHIP_COMMAND_CORRELATOR_SCHEMA,
      generation,
      epoch: epoch ?? 0,
      initialConsumerResetAttested,
      failed,
      reasons: [...reasons],
      historicalFailureCount,
      nativeDropped,
      observedOwnershipRecords,
      observedLegacyRecords,
      pairedRecords,
      pendingOwnershipRecords: publicationOrder.length - publicationRead,
      pendingImmediateOwnershipRecords: immediatePublished.length - immediateRead,
      pendingStagedOwnershipRecords: stagedPublished.length - stagedRead,
      pendingLegacyRecords: legacy.length - legacyRead,
      maxPendingRecords: pendingLimit,
      trackedTransactionCount: transactions.size,
      retiredTransactionHighWater,
      openTransactionCount: openTransactions.length,
      discardedPrivateRecords,
      completedTransactions,
      resetCount,
      lifecycleCounts: Array.from(lifecycleCounts),
      captureEndSeen,
      captureEndCommandRingWrite,
      captureEndCommandSerial,
      captureId,
      packageOpportunity: snapshotPackageOpportunity(openTransactions),
    };
  }

  function resetForEpoch(nextEpoch, explicitLoad = false) {
    if (explicitLoad || epoch !== nextEpoch) {
      const dirtyBoundary = epoch != null && (
        pendingRecordCount() !== 0 ||
        Array.from(transactions.values()).some((state) => !state.completed)
      );
      if (dirtyBoundary) {
        fail("epoch boundary has unmatched commands or open ownership state");
      }
      immediatePublished.length = 0;
      stagedPublished.length = 0;
      publicationOrder.length = 0;
      legacy.length = 0;
      immediateRead = 0;
      stagedRead = 0;
      publicationRead = 0;
      legacyRead = 0;
      for (const state of transactions.values()) {
        if (state.sinkTransactionOpen) {
          try {
            sink.abortTransaction(state.id);
          } catch (error) {
            fail(`semantic sink reset abort failed: ${error?.message || error}`);
          }
        }
      }
      transactions.clear();
      packageOpportunity = createPackageOpportunityState();
      currentTransaction = 0;
      lastCommandSerial = null;
      lastLegacyRecordIndex = null;
      epoch = nextEpoch;
      epochOpened = true;
      generation += 1;
      resetCount += 1;
      try {
        sink.beginEpoch(nextEpoch, { kind: WGPU_CORRELATION_EPOCH_KIND.LOAD });
      } catch (error) {
        fail(`semantic sink epoch reset failed: ${error?.message || error}`);
      }
    }
  }

  function fail(reason) {
    if (!failed) historicalFailureCount += 1;
    failed = true;
    reasons.add(reason);
    try {
      sink.markMismatch();
    } catch {
      reasons.add("semantic sink mismatch marker failed");
    }
    return false;
  }

  function observePackageOpportunityCommand(record, publication) {
    packageOpportunity.legacyRecords += 1;
    if (record.transactionId === 0) {
      packageOpportunity.outsideImmediateCommands += 1;
      return;
    }
    const state = transaction(record.transactionId);
    const packageEligible =
      publication === WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED ||
      record.opcode === UPLOAD_BUFFER_OPCODE;
    if (publication === WGPU_COMMAND_PUBLICATION.PRIVATE_STAGED) {
      packageOpportunity.privateStagedCommands += 1;
    } else if (packageEligible) {
      packageOpportunity.eligibleImmediateCommands += 1;
    } else {
      packageOpportunity.ineligibleTransactionCommands += 1;
    }
    if (!packageEligible) return;
    packageOpportunity.eligiblePayloadBytes += record.payloadLength;
    state.packageEligibleRecords += 1;
    state.packageEligiblePayloadBytes += record.payloadLength;
  }

  function snapshotPackageOpportunity(openTransactions) {
    const reasons = [];
    const pendingOwnership = publicationOrder.length - publicationRead;
    const pendingLegacy = legacy.length - legacyRead;
    if (failed) reasons.push("ownership/semantic correlation failed");
    if (nativeDropped !== 0) reasons.push("native trace drops are nonzero");
    if (packageOpportunity.abortedTransactions !== 0) {
      reasons.push("aborted transactions require producer-state rollback proof");
    }
    if (openTransactions.length !== 0) reasons.push("ownership transactions remain open");
    if (pendingOwnership !== 0) reasons.push("ownership commands remain unmatched");
    if (pendingLegacy !== 0) reasons.push("legacy commands remain unmatched");
    if (packageOpportunity.committedTransactions === 0) {
      reasons.push("no committed transactions were observed");
    }
    const legacyPublications =
      packageOpportunity.outsideImmediateCommands +
      packageOpportunity.eligibleImmediateCommands +
      packageOpportunity.ineligibleTransactionCommands +
      packageOpportunity.committedTransactions;
    const projectedPublications =
      packageOpportunity.outsideImmediateCommands +
      packageOpportunity.ineligibleTransactionCommands +
      packageOpportunity.committedTransactions;
    const projectedRecords = projectedPublications;
    const publicationReduction = legacyPublications - projectedPublications;
    return Object.freeze({
      schema: PASS_PACKAGE_OPPORTUNITY_SCHEMA,
      currentEpochOnly: true,
      runtimeBehaviorChanged: false,
      eligible: reasons.length === 0,
      reasons: Object.freeze(reasons),
      legacyRecords: packageOpportunity.legacyRecords,
      projectedRecords,
      recordReduction: packageOpportunity.legacyRecords - projectedRecords,
      legacyPublications,
      projectedPublications,
      publicationReduction,
      publicationReductionRatio:
        legacyPublications === 0 ? 0 : publicationReduction / legacyPublications,
      committedTransactions: packageOpportunity.committedTransactions,
      abortedTransactions: packageOpportunity.abortedTransactions,
      outsideImmediateCommands: packageOpportunity.outsideImmediateCommands,
      eligibleImmediateCommands: packageOpportunity.eligibleImmediateCommands,
      privateStagedCommands: packageOpportunity.privateStagedCommands,
      ineligibleTransactionCommands: packageOpportunity.ineligibleTransactionCommands,
      eligiblePayloadBytes: packageOpportunity.eligiblePayloadBytes,
      maximumPackageRecords: packageOpportunity.maximumPackageRecords,
      maximumPackagePayloadBytes: packageOpportunity.maximumPackagePayloadBytes,
      maximumPackageBytes: packageOpportunity.maximumPackageBytes,
      requiresMultiplePayloadPages:
        packageOpportunity.maximumPackagePayloadBytes > MAX_PAYLOAD_PAGE_BYTES,
    });
  }

  function reservePendingRecord() {
    if (pendingRecordCount() < pendingLimit) return true;
    return fail(`correlator pending-record limit ${pendingLimit} exceeded`);
  }

  function pendingRecordCount() {
    let privateCount = 0;
    for (const state of transactions.values()) privateCount += state.privateRecords.length;
    return (
      publicationOrder.length - publicationRead +
      legacy.length - legacyRead +
      privateCount +
      transactions.size
    );
  }

  function requireTransaction(record, label) {
    if (record.transactionId !== 0) return true;
    return fail(`${label} requires a nonzero transaction`);
  }

  return {
    pushOwnership,
    pushLegacy,
    applyHealth,
    checkpoint,
    snapshot,
  };
}

function normalizeSink(sink) {
  if (!sink || typeof sink.appendEvent !== "function") {
    throw new TypeError("semanticSink must expose appendEvent(event, options)");
  }
  return {
    appendEvent: (event, options) => sink.appendEvent(event, options),
    beginTransaction: typeof sink.beginTransaction === "function"
      ? (id) => sink.beginTransaction(id)
      : () => {},
    commitTransaction: typeof sink.commitTransaction === "function"
      ? (id) => sink.commitTransaction(id)
      : () => {},
    abortTransaction: typeof sink.abortTransaction === "function"
      ? (id) => sink.abortTransaction(id)
      : () => {},
    beginEpoch: typeof sink.beginEpoch === "function"
      ? (nextEpoch, options) => sink.beginEpoch(nextEpoch, options)
      : () => {},
    markMismatch: typeof sink.markMismatch === "function"
      ? () => sink.markMismatch()
      : () => {},
  };
}

function snapshotSink(sink, { compact = false } = {}) {
  if (compact && typeof sink?.summary === "function") return sink.summary();
  return typeof sink?.snapshot === "function" ? sink.snapshot() : null;
}

function validSinkPrefix(value) {
  const recognizedSchema =
    value?.schema === WGPU_SEMANTIC_DIGEST_SCHEMA ||
    (
      value?.schema === WGPU_SEMANTIC_DIGEST_SCHEMA_V2 &&
      value?.dependencyEncodingReady === true &&
      value?.independentDecodingReady === true &&
      isNonNegativeSafeInteger(value.independentDecodedEventCount) &&
      value.independentDecodedEventCount === value.committedEventCount
    );
  return (
    recognizedSchema &&
    isNonNegativeSafeInteger(value.openTransactionCount) &&
    isNonNegativeSafeInteger(value.unresolvedCount) &&
    isNonNegativeSafeInteger(value.mismatchCount) &&
    value.unresolvedCount === 0 &&
    value.mismatchCount === 0 &&
    typeof value.overflow === "boolean" &&
    value.overflow === false &&
    isSha256Hex(value.globalDigest) &&
    isSha256Hex(value.epochDigest)
  );
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function normalizeOwnershipRecord(input) {
  const event = u32(input?.event, "event");
  return {
    event,
    epoch: u32(input?.epoch, "epoch"),
    transactionId: u32(input?.transactionId, "transactionId"),
    commandSerial: u32(input?.commandSerial, "commandSerial"),
    opcode: u32(input?.opcode, "opcode"),
    resourceId: u32(input?.resourceId, "resourceId"),
    payloadLength: u32(input?.payloadLength, "payloadLength"),
    auxiliary: u32(input?.auxiliary, "auxiliary"),
  };
}

function snapshotLegacyCommand(input) {
  const payloadBytes = copyBytes(input?.payloadBytes ?? EMPTY_BYTES);
  const event = {
    ...input,
    kind: u32(input?.kind, "kind"),
    opcode: u32(input?.opcode, "opcode"),
    resourceClass: u32(input?.resourceClass, "resourceClass"),
    resourceId: u32(input?.resourceId, "resourceId"),
    generation: u32(input?.generation ?? 0, "generation"),
    args: Array.from(input?.args ?? [], (arg) => u32(arg, "arg")),
  };
  delete event.payloadBytes;
  return {
    recordIndex: u32(input?.recordIndex, "recordIndex"),
    event,
    payloadBytes,
    payloadSha256: bytesToHex(sha256(payloadBytes)),
  };
}

function signatureMismatch(expected, actual) {
  if (expected.opcode !== actual.event.opcode) {
    return `opcode ${expected.opcode} != ${actual.event.opcode}`;
  }
  if (expected.resourceId !== actual.event.resourceId) {
    return `resource ${expected.resourceId} != ${actual.event.resourceId}`;
  }
  if (expected.payloadLength !== actual.payloadBytes.byteLength) {
    return `payload length ${expected.payloadLength} != ${actual.payloadBytes.byteLength}`;
  }
  return "";
}

function copyBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new TypeError("legacy payloadBytes must be an ArrayBuffer or view");
}

function optionalCount(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError("health counters must be non-negative safe integers");
  }
  return number;
}

function u32(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw new RangeError(`${label} must be a u32`);
  }
  return number >>> 0;
}

function transactionState(id) {
  return {
    id,
    reserved: false,
    passBegan: false,
    commitSeen: false,
    aborted: false,
    closeRequested: false,
    closeFence: "",
    completed: false,
    privateRecords: [],
    outstandingPublished: 0,
    outstandingStagedPublished: 0,
    paired: 0,
    packageEligibleRecords: 0,
    packageEligiblePayloadBytes: 0,
    sinkTransactionOpen: false,
    sinkTransactionSettled: false,
  };
}

function createPackageOpportunityState() {
  return {
    legacyRecords: 0,
    committedTransactions: 0,
    abortedTransactions: 0,
    outsideImmediateCommands: 0,
    eligibleImmediateCommands: 0,
    privateStagedCommands: 0,
    ineligibleTransactionCommands: 0,
    eligiblePayloadBytes: 0,
    maximumPackageRecords: 0,
    maximumPackagePayloadBytes: 0,
    maximumPackageBytes: 0,
  };
}

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function compactQueue(queue, read) {
  if (read >= 4096 && read * 2 >= queue.length) {
    queue.splice(0, read);
    return 0;
  }
  return read;
}
