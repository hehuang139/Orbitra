// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  WGPU_LEGACY_COMMAND_OPCODE as OP,
  WGPU_RESOURCE_CLASS as RESOURCE,
} from "./wgpu-legacy-semantic-decoder.js";
import {
  WGPU_RESOURCE_EPOCH_KIND,
  createWgpuResourceGenerationTracker,
} from "./wgpu-resource-generation-tracker.js";
import { createWgpuSemanticDigestV2 } from "./wgpu-semantic-digest.js";
import { decodeWgpuSemanticEventV2 } from "./wgpu-semantic-v2-decoder.js";

export const WGPU_SEMANTIC_PARITY_SINK_SCHEMA =
  "wasm-dolphin.wgpu-semantic-parity-sink.v1";

// This composes already-decoded legacy commands into WDS2 evidence. It does
// not publish packages, execute WebGPU calls, or prove that a consumer reset
// happened. A caller must supply the exact load/consumer-reset boundary kind.
export function createWgpuSemanticParitySink({
  recentCommitLimit,
  now,
  maxTrackedResources,
  maxDependencyPayloadBytes,
} = {}) {
  const tracker = createWgpuResourceGenerationTracker({
    maxTrackedResources,
    maxDependencyPayloadBytes,
  });
  const digest = createWgpuSemanticDigestV2({ recentCommitLimit, now });
  const reasons = new Set();
  let failed = false;
  let openTransaction = 0;
  let independentDecodedEventCount = 0;

  function beginEpoch(epoch, { kind } = {}) {
    requireHealthy("beginEpoch");
    if (openTransaction !== 0) fail(`epoch boundary has open transaction ${openTransaction}`);
    if (
      kind !== WGPU_RESOURCE_EPOCH_KIND.LOAD &&
      kind !== WGPU_RESOURCE_EPOCH_KIND.CONSUMER_RESET
    ) {
      fail(`semantic parity epoch kind ${kind} is unsupported`);
    }
    try {
      tracker.beginEpoch(epoch, { kind });
      digest.beginEpoch(epoch);
    } catch (error) {
      fail(error?.message || String(error));
    }
  }

  function beginTransaction(transactionId) {
    requireHealthy("beginTransaction");
    if (openTransaction !== 0) fail(`semantic parity transaction ${openTransaction} is open`);
    try {
      tracker.beginTransaction(transactionId);
      digest.beginTransaction(transactionId);
      openTransaction = transactionId >>> 0;
    } catch (error) {
      tryAbortTracker(transactionId);
      fail(error?.message || String(error));
    }
  }

  function appendEvent(event, { staged = false } = {}) {
    requireHealthy("appendEvent");
    try {
      const annotation = tracker.decorate(event, { staged });
      validateAnnotation(event, annotation);
      const encoded = digest.appendEvent({ ...event, ...annotation }, { staged });
      if (encoded) verifyEncodedEvents([encoded]);
      return encoded;
    } catch (error) {
      fail(error?.message || String(error));
    }
  }

  function commitTransaction(transactionId) {
    requireHealthy("commitTransaction");
    requireOpenTransaction(transactionId, "commit");
    try {
      // Tracker validation can reject a concurrent incarnation change. Do it
      // before advancing the digest; WDS2 commit itself is transaction-atomic.
      tracker.commit(transactionId);
      verifyEncodedEvents(digest.commitTransaction(transactionId));
      openTransaction = 0;
    } catch (error) {
      fail(error?.message || String(error));
    }
  }

  function abortTransaction(transactionId) {
    requireHealthy("abortTransaction");
    requireOpenTransaction(transactionId, "abort");
    try {
      tracker.abort(transactionId);
      digest.abortTransaction(transactionId);
      openTransaction = 0;
    } catch (error) {
      fail(error?.message || String(error));
    }
  }

  function markUnresolved(count = 1) {
    digest.markUnresolved(count);
  }

  function markMismatch(count = 1) {
    digest.markMismatch(count);
  }

  function markOverflow() {
    digest.markOverflow();
  }

  function snapshot({ detailed = true } = {}) {
    const digestState = digest.snapshot({ includeRecentCommits: detailed });
    const resourceState = tracker.snapshot({ includeResources: detailed });
    const independentlyDecoded =
      !failed && independentDecodedEventCount === digestState.committedEventCount;
    return Object.freeze({
      ...digestState,
      recentCommits: Object.freeze(
        digestState.recentCommits.map((entry) => Object.freeze({ ...entry }))
      ),
      paritySchema: WGPU_SEMANTIC_PARITY_SINK_SCHEMA,
      failed: failed || resourceState.failed,
      reasons: Object.freeze([...reasons]),
      resourceTracker: resourceState,
      independentDecodedEventCount,
      dependencyEncodingReady: independentlyDecoded,
      independentDecodingReady: independentlyDecoded,
      // The worker observer is reported by wgpu-semantic-runtime. This field
      // remains false until a real package path consumes equivalent evidence.
      runtimeIntegrationReady: false,
    });
  }

  function requireHealthy(operation) {
    if (failed) throw new Error(`semantic parity sink is failed; cannot ${operation}`);
  }

  function requireOpenTransaction(transactionId, operation) {
    const id = Number(transactionId);
    if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff) {
      fail(`${operation} transaction must be a nonzero u32`);
    }
    if (openTransaction !== (id >>> 0)) {
      fail(`${operation} transaction ${id} does not match open transaction ${openTransaction}`);
    }
  }

  function tryAbortTracker(transactionId) {
    try {
      tracker.abort(transactionId);
    } catch {
      // The first failure is retained by fail(); cleanup is best effort only.
    }
  }

  function verifyEncodedEvents(encodedEvents) {
    if (!Array.isArray(encodedEvents)) {
      throw new Error("WDS2 transaction did not return encoded events for verification");
    }
    for (const encoded of encodedEvents) {
      decodeWgpuSemanticEventV2(encoded);
      independentDecodedEventCount += 1;
    }
  }

  function fail(reason) {
    failed = true;
    reasons.add(reason);
    try {
      digest.markMismatch();
    } catch {
      // Snapshot.failed remains authoritative if mismatch accounting fails.
    }
    throw new Error(reason);
  }

  return Object.freeze({
    beginEpoch,
    beginTransaction,
    appendEvent,
    commitTransaction,
    abortTransaction,
    markUnresolved,
    markMismatch,
    markOverflow,
    snapshot,
    summary: () => snapshot({ detailed: false }),
  });
}

function validateAnnotation(event, annotation) {
  if (!annotation || !Number.isInteger(annotation.generation)) {
    throw new Error("resource generation annotation is missing");
  }
  const resourceClass = Number(event?.resourceClass);
  if (resourceClass === RESOURCE.NONE && annotation.generation !== 0) {
    throw new Error("resource-free command has a nonzero generation");
  }
  if (resourceClass !== RESOURCE.NONE && annotation.generation === 0) {
    throw new Error("resource command has a zero generation");
  }
  if (!Array.isArray(annotation.dependencies)) {
    throw new Error("resource dependency annotations are missing");
  }

  const roles = annotation.dependencies.map((dependency) => dependency.role);
  switch (event.opcode) {
    case OP.CREATE_PIPELINE:
    case OP.CREATE_PIPELINE_CFG:
      requireRoles(roles, ["vertex-shader", "fragment-shader"], event.opcode);
      break;
    case OP.CREATE_BIND_GROUP:
      if (roles.some((role) => role !== "bind-entry")) {
        throw new Error("bind-group dependency order contains a non-binding role");
      }
      break;
    case OP.BEGIN_PASS:
      if (roles.length > 1 || (roles.length === 1 && roles[0] !== "depth-attachment")) {
        throw new Error("begin-pass dependencies are not an optional depth attachment");
      }
      break;
    case OP.BLIT_TEXTURE:
      requireRoles(roles, ["blit-destination"], event.opcode);
      break;
    default:
      if (roles.length !== 0) {
        throw new Error(`opcode ${event.opcode} has unexpected resource dependencies`);
      }
      break;
  }
}

function requireRoles(actual, expected, opcode) {
  if (actual.length !== expected.length || actual.some((role, index) => role !== expected[index])) {
    throw new Error(`opcode ${opcode} dependency roles do not match the canonical order`);
  }
}
