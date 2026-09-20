// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { IncrementalSha256, bytesToHex, sha256 } from "./incremental-sha256.js";

export const WGPU_SEMANTIC_DIGEST_SCHEMA =
  "wasm-dolphin.wgpu-semantic-digest.v1";
export const WGPU_SEMANTIC_MAGIC = 0x31534457;
export const WGPU_SEMANTIC_SCHEMA_VERSION = 1;
export const WGPU_SEMANTIC_DOMAIN = "wasm-dolphin-wgpu-semantic-v1";
export const WGPU_SEMANTIC_DIGEST_SCHEMA_V2 =
  "wasm-dolphin.wgpu-semantic-digest.v2";
export const WGPU_SEMANTIC_MAGIC_V2 = 0x32534457;
export const WGPU_SEMANTIC_SCHEMA_VERSION_V2 = 2;
export const WGPU_SEMANTIC_DOMAIN_V2 = "wasm-dolphin-wgpu-semantic-v2";

export const WGPU_SEMANTIC_DEPENDENCY_ROLE_TAG = Object.freeze({
  VERTEX_SHADER: 1,
  FRAGMENT_SHADER: 2,
  BIND_ENTRY: 3,
  DEPTH_ATTACHMENT: 4,
  BLIT_DESTINATION: 5,
});
export const WGPU_SEMANTIC_MAX_DEPENDENCIES = 65_535;

const DOMAIN_BYTES = new TextEncoder().encode(WGPU_SEMANTIC_DOMAIN);
const DOMAIN_DIGEST = sha256(DOMAIN_BYTES);
const DOMAIN_DIGEST_V2 = sha256(new TextEncoder().encode(WGPU_SEMANTIC_DOMAIN_V2));
const EMPTY_BYTES = new Uint8Array(0);
const DEFAULT_RECENT_COMMIT_LIMIT = 32;
const MAX_V2_ARGS = 4_096;
const V1_CODEC = Object.freeze({
  schema: WGPU_SEMANTIC_DIGEST_SCHEMA,
  domain: WGPU_SEMANTIC_DOMAIN,
  domainDigest: DOMAIN_DIGEST,
  encode: encodeWgpuSemanticEvent,
  dependencies: false,
});
const V2_CODEC = Object.freeze({
  schema: WGPU_SEMANTIC_DIGEST_SCHEMA_V2,
  domain: WGPU_SEMANTIC_DOMAIN_V2,
  domainDigest: DOMAIN_DIGEST_V2,
  encode: encodeWgpuSemanticEventV2,
  dependencies: true,
});

export function encodeWgpuSemanticEvent(event, payloadDigest = null) {
  return encodeSemanticEvent(event, payloadDigest, {
    magic: WGPU_SEMANTIC_MAGIC,
    version: WGPU_SEMANTIC_SCHEMA_VERSION,
    dependencies: false,
  });
}

export function encodeWgpuSemanticEventV2(event, payloadDigest = null) {
  return encodeSemanticEvent(event, payloadDigest, {
    magic: WGPU_SEMANTIC_MAGIC_V2,
    version: WGPU_SEMANTIC_SCHEMA_VERSION_V2,
    dependencies: true,
  });
}

function encodeSemanticEvent(event, payloadDigest, codec) {
  const args = normalizeArgs(event?.args);
  if (codec.dependencies && args.length > MAX_V2_ARGS) {
    throw new RangeError(`WDS2 argument count exceeds ${MAX_V2_ARGS}`);
  }
  const dependencies = codec.dependencies
    ? normalizeDependencies(event?.dependencies)
    : [];
  const payloadBytes = asBytes(event?.payloadBytes ?? EMPTY_BYTES);
  const digest = payloadDigest == null ? sha256(payloadBytes) : exactDigest(payloadDigest);
  const payloadLength = u32(
    event?.payloadLength ?? payloadBytes.byteLength,
    "payloadLength"
  );
  if (payloadLength !== payloadBytes.byteLength && payloadDigest == null) {
    throw new RangeError("payloadLength does not match payloadBytes");
  }
  const dependencyBytes = codec.dependencies ? 4 + dependencies.length * 6 * 4 : 0;
  const bodyBytes = 12 * 4 + args.length * 4 + dependencyBytes + 4 + 32;
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes > 0xffff_fffb) {
    throw new RangeError("semantic event encoding exceeds the u32 frame length");
  }
  const encoded = new Uint8Array(4 + bodyBytes);
  const view = new DataView(encoded.buffer);
  let offset = 0;
  offset = putU32(view, offset, bodyBytes);
  offset = putU32(view, offset, codec.magic);
  offset = putU32(view, offset, codec.version);
  offset = putU32(view, offset, u32(event?.kind, "kind"));
  offset = putU32(view, offset, u32(event?.epoch, "epoch"));
  offset = putU32(view, offset, u32(event?.transaction, "transaction"));
  offset = putU32(view, offset, u32(event?.sequenceLo, "sequenceLo"));
  offset = putU32(view, offset, u32(event?.sequenceHi, "sequenceHi"));
  offset = putU32(view, offset, u32(event?.opcode, "opcode"));
  offset = putU32(view, offset, u32(event?.resourceClass, "resourceClass"));
  offset = putU32(view, offset, u32(event?.resourceId, "resourceId"));
  offset = putU32(view, offset, u32(event?.generation, "generation"));
  offset = putU32(view, offset, args.length);
  for (const arg of args) offset = putU32(view, offset, arg);
  if (codec.dependencies) {
    offset = putU32(view, offset, dependencies.length);
    for (const dependency of dependencies) {
      offset = putU32(view, offset, dependency.roleTag);
      offset = putU32(view, offset, dependency.resourceClass);
      offset = putU32(view, offset, dependency.resourceId);
      offset = putU32(view, offset, dependency.generation);
      offset = putU32(view, offset, Object.hasOwn(dependency, "binding") ? 1 : 0);
      offset = putU32(view, offset, dependency.binding ?? 0);
    }
  }
  offset = putU32(view, offset, payloadLength);
  encoded.set(digest, offset);
  return encoded;
}

export function createWgpuSemanticDigest({
  recentCommitLimit = DEFAULT_RECENT_COMMIT_LIMIT,
  now = defaultNow,
} = {}) {
  return createSemanticDigest({ recentCommitLimit, now }, V1_CODEC);
}

export function createWgpuSemanticDigestV2({
  recentCommitLimit = DEFAULT_RECENT_COMMIT_LIMIT,
  now = defaultNow,
} = {}) {
  return createSemanticDigest({ recentCommitLimit, now }, V2_CODEC);
}

function createSemanticDigest({ recentCommitLimit, now }, codec) {
  const recentLimit = Math.min(256, Math.max(1, Number(recentCommitLimit) | 0));
  const transactions = new Map();
  const recentCommits = [];
  let globalDigest = new Uint8Array(codec.domainDigest);
  let epochDigest = new Uint8Array(codec.domainDigest);
  let epoch = 0;
  let sequenceLo = 0;
  let sequenceHi = 0;
  let eventCount = 0;
  let committedEventCount = 0;
  let committedDependencyCount = 0;
  let committedTransactionCount = 0;
  let abortedTransactionCount = 0;
  let payloadBytesHashed = 0;
  let encodedBytesHashed = 0;
  let hashTotalMs = 0;
  let hashMaxMs = 0;
  let unresolvedCount = 0;
  let mismatchCount = 0;
  let overflow = false;

  function beginEpoch(nextEpoch) {
    if (transactions.size !== 0) {
      unresolvedCount += transactions.size;
      transactions.clear();
    }
    epoch = u32(nextEpoch, "epoch");
    epochDigest = new Uint8Array(codec.domainDigest);
    sequenceLo = 0;
    sequenceHi = 0;
  }

  function beginTransaction(transactionId) {
    const id = requiredTransaction(transactionId);
    if (transactions.has(id)) {
      mismatchCount += 1;
      throw new Error(`semantic transaction ${id} is already open`);
    }
    if (transactions.size !== 0) {
      mismatchCount += 1;
      throw new Error("overlapping semantic transactions are not supported");
    }
    transactions.set(id, {
      events: [],
    });
  }

  function appendEvent(draft, { staged = false } = {}) {
    const transaction = u32(draft?.transaction ?? 0, "transaction");
    const payloadBytes = asBytes(draft?.payloadBytes ?? EMPTY_BYTES);
    const branch = staged ? transactions.get(transaction) : null;
    if (staged && transaction === 0) {
      mismatchCount += 1;
      throw new Error("staged semantic events require a nonzero transaction");
    }
    if (staged && !branch) {
      unresolvedCount += 1;
      throw new Error(`semantic transaction ${transaction} is not open`);
    }
    const startedAt = now();
    const payloadDigest = sha256(payloadBytes);
    const event = immutableEventDraft({
      draft,
      epoch,
      transaction,
      payloadLength: payloadBytes.byteLength,
      payloadDigest,
      includeDependencies: codec.dependencies,
    });
    eventCount += 1;
    payloadBytesHashed += payloadBytes.byteLength;
    if (staged) {
      branch.events.push(event);
      recordHashTime(startedAt);
      return null;
    }
    const encoded = commitEvent(event);
    recordHashTime(startedAt);
    return encoded;
  }

  function commitTransaction(transactionId) {
    const id = requiredTransaction(transactionId);
    const branch = transactions.get(id);
    if (!branch) {
      mismatchCount += 1;
      throw new Error(`semantic transaction ${id} cannot commit because it is not open`);
    }
    const startedAt = now();
    const encodedEvents = commitEvents(branch.events);
    transactions.delete(id);
    committedTransactionCount += 1;
    recentCommits.push({
      epoch,
      transaction: id,
      eventCount: branch.events.length,
      globalDigest: bytesToHex(globalDigest),
      epochDigest: bytesToHex(epochDigest),
    });
    if (recentCommits.length > recentLimit) recentCommits.shift();
    recordHashTime(startedAt);
    return encodedEvents;
  }

  function abortTransaction(transactionId) {
    const id = requiredTransaction(transactionId);
    if (!transactions.delete(id)) {
      mismatchCount += 1;
      throw new Error(`semantic transaction ${id} cannot abort because it is not open`);
    }
    abortedTransactionCount += 1;
  }

  function markUnresolved(count = 1) {
    unresolvedCount += positiveCount(count);
  }

  function markMismatch(count = 1) {
    mismatchCount += positiveCount(count);
  }

  function markOverflow() {
    overflow = true;
  }

  function snapshot({ includeRecentCommits = true } = {}) {
    return {
      schema: codec.schema,
      domain: codec.domain,
      epoch,
      sequenceLo,
      sequenceHi,
      globalDigest: bytesToHex(globalDigest),
      epochDigest: bytesToHex(epochDigest),
      eventCount,
      committedEventCount,
      ...(codec.dependencies ? { committedDependencyCount } : {}),
      openTransactionCount: transactions.size,
      committedTransactionCount,
      abortedTransactionCount,
      payloadBytesHashed,
      encodedBytesHashed,
      hashTotalMs,
      hashMaxMs,
      unresolvedCount,
      mismatchCount,
      overflow,
      recentCommitsIncluded: Boolean(includeRecentCommits),
      recentCommits: includeRecentCommits
        ? recentCommits.map((entry) => ({ ...entry }))
        : [],
    };
  }

  function recordHashTime(startedAt) {
    const elapsed = Math.max(0, now() - startedAt);
    hashTotalMs += elapsed;
    hashMaxMs = Math.max(hashMaxMs, elapsed);
  }

  function commitEvent(event) {
    return commitEvents([event])[0];
  }

  function commitEvents(events) {
    const encodedEvents = [];
    let nextLo = sequenceLo;
    let nextHi = sequenceHi;
    let nextGlobalDigest = globalDigest;
    let nextEpochDigest = epochDigest;
    let addedEncodedBytes = 0;
    let addedDependencies = 0;
    for (const event of events) {
      const encoded = codec.encode({
        ...event,
        sequenceLo: nextLo,
        sequenceHi: nextHi,
      }, event.payloadDigest);
      [nextLo, nextHi] = nextSequence(nextLo, nextHi);
      nextGlobalDigest = chain(nextGlobalDigest, encoded);
      nextEpochDigest = chain(nextEpochDigest, encoded);
      addedEncodedBytes += encoded.byteLength;
      if (codec.dependencies) addedDependencies += event.dependencies.length;
      encodedEvents.push(encoded);
    }

    sequenceLo = nextLo;
    sequenceHi = nextHi;
    globalDigest = nextGlobalDigest;
    epochDigest = nextEpochDigest;
    encodedBytesHashed += addedEncodedBytes;
    committedEventCount += events.length;
    committedDependencyCount += addedDependencies;
    return encodedEvents;
  }

  return {
    beginEpoch,
    beginTransaction,
    appendEvent,
    commitTransaction,
    abortTransaction,
    markUnresolved,
    markMismatch,
    markOverflow,
    snapshot,
  };
}

function immutableEventDraft({
  draft,
  epoch,
  transaction,
  payloadLength,
  payloadDigest,
  includeDependencies,
}) {
  const event = {
    kind: u32(draft?.kind, "kind"),
    epoch,
    transaction,
    opcode: u32(draft?.opcode, "opcode"),
    resourceClass: u32(draft?.resourceClass, "resourceClass"),
    resourceId: u32(draft?.resourceId, "resourceId"),
    generation: u32(draft?.generation, "generation"),
    args: normalizeArgs(draft?.args),
    payloadLength,
    payloadDigest: new Uint8Array(payloadDigest),
  };
  if (includeDependencies) event.dependencies = normalizeDependencies(draft?.dependencies);
  return event;
}

function chain(previous, encoded) {
  return new IncrementalSha256().update(previous).update(encoded).digest();
}

function nextSequence(low, high) {
  const nextLow = (low + 1) >>> 0;
  return [nextLow, nextLow === 0 ? (high + 1) >>> 0 : high];
}

function normalizeArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) && !(value instanceof Uint32Array)) {
    throw new TypeError("semantic args must be an array of u32 values");
  }
  return Array.from(value, (entry) => u32(entry, "arg"));
}

function normalizeDependencies(value) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError("semantic dependencies must be an array");
  }
  if (value.length > WGPU_SEMANTIC_MAX_DEPENDENCIES) {
    throw new RangeError(
      `WDS2 dependency count exceeds ${WGPU_SEMANTIC_MAX_DEPENDENCIES}`
    );
  }
  return Object.freeze(value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || ArrayBuffer.isView(entry)) {
      throw new TypeError(`dependency ${index} must be an object`);
    }
    const role = String(entry.role ?? "");
    const roleTag = dependencyRoleTag(role);
    const resourceClass = u32(entry.resourceClass, `dependency ${index} resourceClass`);
    const resourceId = nonzeroU32(entry.resourceId, `dependency ${index} resourceId`);
    const generation = nonzeroU32(entry.generation, `dependency ${index} generation`);
    validateDependencyClass(role, resourceClass);
    const hasBinding = Object.hasOwn(entry, "binding");
    if (role === "bind-entry" && !hasBinding) {
      throw new Error("bind-entry dependency requires a binding");
    }
    if (role !== "bind-entry" && hasBinding) {
      throw new Error(`${role} dependency cannot carry a binding`);
    }
    const dependency = { role, roleTag, resourceClass, resourceId, generation };
    if (hasBinding) dependency.binding = u32(entry.binding, `dependency ${index} binding`);
    return Object.freeze(dependency);
  }));
}

function dependencyRoleTag(role) {
  switch (role) {
    case "vertex-shader":
      return WGPU_SEMANTIC_DEPENDENCY_ROLE_TAG.VERTEX_SHADER;
    case "fragment-shader":
      return WGPU_SEMANTIC_DEPENDENCY_ROLE_TAG.FRAGMENT_SHADER;
    case "bind-entry":
      return WGPU_SEMANTIC_DEPENDENCY_ROLE_TAG.BIND_ENTRY;
    case "depth-attachment":
      return WGPU_SEMANTIC_DEPENDENCY_ROLE_TAG.DEPTH_ATTACHMENT;
    case "blit-destination":
      return WGPU_SEMANTIC_DEPENDENCY_ROLE_TAG.BLIT_DESTINATION;
    default:
      throw new RangeError(`dependency role ${role || "<empty>"} is unsupported`);
  }
}

function validateDependencyClass(role, resourceClass) {
  if ((role === "vertex-shader" || role === "fragment-shader") && resourceClass !== 1) {
    throw new Error(`${role} dependency requires resource class 1`);
  }
  if (role === "bind-entry" && ![3, 4, 5].includes(resourceClass)) {
    throw new Error("bind-entry dependency requires resource class 3, 4, or 5");
  }
  if ((role === "depth-attachment" || role === "blit-destination") && resourceClass !== 4) {
    throw new Error(`${role} dependency requires resource class 4`);
  }
}

function exactDigest(value) {
  const bytes = asBytes(value);
  if (bytes.byteLength !== 32) throw new RangeError("payload digest must be 32 bytes");
  return bytes;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("semantic payload must be an ArrayBuffer or view");
}

function putU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
  return offset + 4;
}

function u32(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) {
    throw new RangeError(`${label} must be a u32`);
  }
  return number >>> 0;
}

function requiredTransaction(value) {
  const id = u32(value, "transaction");
  if (id === 0) throw new RangeError("transaction must be nonzero");
  return id;
}

function nonzeroU32(value, label) {
  const number = u32(value, label);
  if (number === 0) throw new RangeError(`${label} must be nonzero`);
  return number;
}

function positiveCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("count must be a positive safe integer");
  }
  return count;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
