// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  WGPU_LEGACY_COMMAND_OPCODE as OP,
  WGPU_RESOURCE_CLASS as RESOURCE,
  WGPU_SEMANTIC_EVENT_KIND as KIND,
} from "./wgpu-legacy-semantic-decoder.js";

export const WGPU_RESOURCE_GENERATION_TRACKER_SCHEMA =
  "wasm-dolphin.wgpu-resource-generation-tracker.v1";

export const WGPU_RESOURCE_EPOCH_KIND = Object.freeze({
  LOAD: "load",
  CONSUMER_RESET: "consumer-reset",
});

const WPL3_MAGIC = 0x57504c33;
const WBG1_MAGIC = 0x57424731;
const WPL3_HEADER_WORDS = 26;
const WPL3_ATTRIBUTE_WORDS = 3;
const WBG1_HEADER_WORDS = 3;
const WBG1_ENTRY_WORDS = 5;
const DEFAULT_FRAMEBUFFER_GENERATION = 1;

/**
 * Track semantic resource incarnations without touching renderer objects.
 *
 * The input must already be a canonical event produced by the independent
 * legacy decoder. WPL3 and WBG1 are decoded only as CREATE_* payloads; this
 * module deliberately has no parser for a future replay-package envelope.
 */
export function createWgpuResourceGenerationTracker({
  maxTrackedResources = 262_144,
  maxDependencyPayloadBytes = 1 << 20,
} = {}) {
  const resourceLimit = positiveSafeInteger(maxTrackedResources, "maxTrackedResources");
  const payloadLimit = positiveSafeInteger(
    maxDependencyPayloadBytes,
    "maxDependencyPayloadBytes"
  );
  const registry = new Map();
  const revisions = new Map();
  const reasons = new Set();
  let transaction = null;
  let initialized = false;
  let baselineKnown = false;
  let failed = false;
  let historicalFailureCount = 0;
  let epoch = 0;
  let epochCount = 0;
  let loadEpochCount = 0;
  let consumerResetEpochCount = 0;
  let decoratedEventCount = 0;
  let acceptedEventCount = 0;
  let discardedStagedEventCount = 0;
  let createCount = 0;
  let useCount = 0;
  let destroyCount = 0;
  let dependencyCount = 0;
  let liveResourceCount = 0;
  let committedTransactionCount = 0;
  let abortedTransactionCount = 0;

  function beginEpoch(epochValue, { kind: kindValue } = {}) {
    const nextEpoch = requiredU32(epochValue, "epoch", true);
    const kind = normalizeEpochKind(kindValue);
    if (failed && kind !== WGPU_RESOURCE_EPOCH_KIND.CONSUMER_RESET) {
      throw new Error("resource generation tracker is failed; consumer-reset required");
    }
    if (initialized && nextEpoch === epoch) {
      fail(`resource epoch ${nextEpoch} is already active`);
    }
    if (initialized && nextEpoch !== ((epoch + 1) >>> 0)) {
      fail(`resource epoch ${nextEpoch} does not follow ${epoch}`);
    }
    if (transaction) {
      discardedStagedEventCount += transaction.counters.decorated;
      transaction = null;
      abortedTransactionCount += 1;
    }
    epoch = nextEpoch;
    epochCount += 1;
    initialized = true;
    if (kind === WGPU_RESOURCE_EPOCH_KIND.LOAD) {
      loadEpochCount += 1;
      // A save-state load does not rebuild browser-side resources. Starting
      // observation at a load boundary therefore cannot manufacture the
      // pre-existing registry, while a registry observed before the load is
      // retained exactly.
      if (!baselineKnown) {
        fail("a load epoch cannot establish a resource baseline midstream");
      }
      return snapshot();
    }

    // This boundary is valid only after the consumer has destroyed/cleared
    // every browser-side resource map. It is not an ordinary core reset.
    registry.clear();
    revisions.clear();
    liveResourceCount = 0;
    transaction = null;
    baselineKnown = true;
    failed = false;
    reasons.clear();
    consumerResetEpochCount += 1;
    return snapshot();
  }

  function beginTransaction(transactionId) {
    requireReady("beginTransaction");
    const id = requiredU32(transactionId, "transactionId");
    if (transaction) fail(`resource transaction ${transaction.id} is already open`);
    transaction = {
      id,
      overlay: new Map(),
      observedRevisions: new Map(),
      counters: emptyCounters(),
    };
  }

  function decorate(input, options = {}) {
    try {
      return decorateCanonicalEvent(input, options);
    } catch (error) {
      recordFailure(error?.message || String(error));
      throw error;
    }
  }

  function decorateCanonicalEvent(input, { staged = false } = {}) {
    requireReady("decorate");
    const event = normalizeEvent(input);
    const isStaged = Boolean(staged);
    if (isStaged && !transaction) {
      fail("staged resource events require an open transaction");
    }
    if (
      isStaged && event.transaction != null &&
      event.transaction !== 0 && event.transaction !== transaction.id
    ) {
      fail(
        `event transaction ${event.transaction} does not match open transaction ${transaction.id}`
      );
    }

    let generation = 0;
    let dependencies = [];
    switch (event.opcode) {
      case OP.NOP:
      case OP.CLEAR:
      case OP.SET_VIEWPORT:
      case OP.SET_SCISSOR:
      case OP.DRAW:
      case OP.DRAW_INDEXED:
      case OP.END_PASS:
      case OP.SUBMIT_PRESENT:
        requirePrimary(event, RESOURCE.NONE, 0);
        break;

      case OP.CREATE_SHADER:
        requirePrimary(event, RESOURCE.SHADER);
        generation = createResource(RESOURCE.SHADER, event.resourceId, isStaged);
        break;

      case OP.CREATE_PIPELINE: {
        requirePrimary(event, RESOURCE.PIPELINE);
        requireArgs(event, 3);
        dependencies = [
          dependency("vertex-shader", RESOURCE.SHADER, event.args[1], isStaged),
          dependency("fragment-shader", RESOURCE.SHADER, event.args[2], isStaged),
        ];
        generation = createResource(RESOURCE.PIPELINE, event.resourceId, isStaged);
        break;
      }

      case OP.DRAW_TEST:
      case OP.SET_PIPELINE:
        requirePrimary(event, RESOURCE.PIPELINE);
        generation = useResource(RESOURCE.PIPELINE, event.resourceId, isStaged);
        break;

      case OP.CREATE_BUFFER:
        requirePrimary(event, RESOURCE.BUFFER);
        generation = createResource(RESOURCE.BUFFER, event.resourceId, isStaged);
        break;

      case OP.UPLOAD_BUFFER:
      case OP.SET_VERTEX_BUFFER:
      case OP.SET_INDEX_BUFFER:
        requirePrimary(event, RESOURCE.BUFFER);
        generation = useResource(RESOURCE.BUFFER, event.resourceId, isStaged);
        break;

      case OP.CREATE_TEXTURE: {
        requirePrimary(event, RESOURCE.TEXTURE);
        ensureCreateCapacity([
          [RESOURCE.TEXTURE, event.resourceId],
          [RESOURCE.FRAMEBUFFER, event.resourceId],
        ], isStaged);
        const texture = prepareCreate(RESOURCE.TEXTURE, event.resourceId, isStaged);
        // A nonzero BEGIN_PASS framebuffer id aliases the color texture id.
        // Track that identity in its own class so equal numeric ids in other
        // classes cannot accidentally satisfy framebuffer lookup.
        const framebuffer = prepareCreate(RESOURCE.FRAMEBUFFER, event.resourceId, isStaged);
        applyEntry(texture.key, texture.entry, isStaged);
        applyEntry(framebuffer.key, framebuffer.entry, isStaged);
        generation = texture.entry.generation;
        break;
      }

      case OP.UPLOAD_TEXTURE:
        requirePrimary(event, RESOURCE.TEXTURE);
        generation = useResource(RESOURCE.TEXTURE, event.resourceId, isStaged);
        break;

      case OP.CREATE_PIPELINE_CFG: {
        requirePrimary(event, RESOURCE.PIPELINE);
        const pipeline = parseWpl3(event.payloadBytes, payloadLimit);
        dependencies = [
          dependency("vertex-shader", RESOURCE.SHADER, pipeline.vertexShaderId, isStaged),
          dependency("fragment-shader", RESOURCE.SHADER, pipeline.fragmentShaderId, isStaged),
        ];
        generation = createResource(RESOURCE.PIPELINE, event.resourceId, isStaged);
        break;
      }

      case OP.CREATE_SAMPLER:
        requirePrimary(event, RESOURCE.SAMPLER);
        generation = createResource(RESOURCE.SAMPLER, event.resourceId, isStaged);
        break;

      case OP.CREATE_BIND_GROUP: {
        requirePrimary(event, RESOURCE.BIND_GROUP);
        requireArgs(event, 2);
        const bindGroup = parseWbg1(event.payloadBytes, payloadLimit);
        if (bindGroup.group !== event.args[1]) {
          fail(`WBG1 group ${bindGroup.group} does not match canonical group ${event.args[1]}`);
        }
        dependencies = bindGroup.entries.map((entry) => dependency(
          "bind-entry",
          entry.resourceClass,
          entry.resourceId,
          isStaged,
          entry.binding
        ));
        generation = createResource(RESOURCE.BIND_GROUP, event.resourceId, isStaged);
        break;
      }

      case OP.BEGIN_PASS: {
        requirePrimary(event, RESOURCE.FRAMEBUFFER);
        requireArgs(event, 7);
        // ID zero denotes the stable virtual swapchain/backbuffer identity.
        // Generation 1 does not claim a physical browser texture survives a
        // presentation or reconfiguration boundary.
        generation = event.resourceId === 0
          ? DEFAULT_FRAMEBUFFER_GENERATION
          : useResource(RESOURCE.FRAMEBUFFER, event.resourceId, isStaged);
        if (event.args[6] !== 0) {
          dependencies = [dependency(
            "depth-attachment", RESOURCE.TEXTURE, event.args[6], isStaged
          )];
        }
        break;
      }

      case OP.SET_BIND_GROUP:
        requirePrimary(event, RESOURCE.BIND_GROUP);
        generation = useResource(RESOURCE.BIND_GROUP, event.resourceId, isStaged);
        break;

      case OP.DESTROY: {
        requireArgs(event, 2);
        const expectedClass = destroyClass(event.args[0]);
        requirePrimary(event, expectedClass);
        if (expectedClass === RESOURCE.TEXTURE) {
          const texture = prepareDestroy(RESOURCE.TEXTURE, event.resourceId, isStaged);
          const framebuffer = prepareDestroy(RESOURCE.FRAMEBUFFER, event.resourceId, isStaged);
          applyEntry(texture.key, texture.entry, isStaged);
          applyEntry(framebuffer.key, framebuffer.entry, isStaged);
          generation = texture.generation;
        } else {
          generation = destroyResource(expectedClass, event.resourceId, isStaged);
        }
        break;
      }

      case OP.BLIT_TEXTURE:
        requirePrimary(event, RESOURCE.TEXTURE);
        requireArgs(event, 2);
        generation = useResource(RESOURCE.TEXTURE, event.resourceId, isStaged);
        dependencies = [dependency(
          "blit-destination", RESOURCE.TEXTURE, event.args[1], isStaged
        )];
        break;

      default:
        fail(`unsupported canonical WebGPU opcode ${event.opcode}`);
    }

    const counters = countersForEvent(event.opcode, dependencies.length);
    acceptedEventCount += 1;
    if (isStaged) addCounters(transaction.counters, counters);
    else applyCommittedCounters(counters);
    const frozenDependencies = Object.freeze(
      dependencies.map((entry) => Object.freeze({ ...entry }))
    );
    return Object.freeze({
      generation,
      dependencies: frozenDependencies,
    });
  }

  function commit(transactionId) {
    requireReady("commit");
    const state = requireTransaction(transactionId, "commit");
    for (const [key, observedRevision] of state.observedRevisions) {
      if ((revisions.get(key) ?? 0) !== observedRevision) {
        fail(`resource ${key} changed while transaction ${state.id} was staged`);
      }
    }
    for (const [key, entry] of state.overlay) {
      const nextRevision = (revisions.get(key) ?? 0) + 1;
      if (!Number.isSafeInteger(nextRevision)) {
        fail(`resource ${key} revision overflow`);
      }
    }
    for (const [key, entry] of state.overlay) {
      applyCommittedEntry(key, entry);
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
    }
    applyCommittedCounters(state.counters);
    transaction = null;
    committedTransactionCount += 1;
  }

  function abort(transactionId) {
    requireReady("abort");
    requireTransaction(transactionId, "abort");
    discardedStagedEventCount += transaction.counters.decorated;
    transaction = null;
    abortedTransactionCount += 1;
  }

  function snapshot({ includeResources = true } = {}) {
    const resources = includeResources
      ? Array.from(registry.values())
          .sort((left, right) =>
            left.resourceClass - right.resourceClass || left.resourceId - right.resourceId
          )
          .map((entry) => ({ ...entry }))
      : [];
    return Object.freeze({
      schema: WGPU_RESOURCE_GENERATION_TRACKER_SCHEMA,
      initialized,
      baselineKnown,
      failed,
      reasons: Object.freeze([...reasons]),
      historicalFailureCount,
      epoch,
      epochCount,
      loadEpochCount,
      consumerResetEpochCount,
      decoratedEventCount,
      acceptedEventCount,
      discardedStagedEventCount,
      createCount,
      useCount,
      destroyCount,
      dependencyCount,
      maxTrackedResources: resourceLimit,
      maxDependencyPayloadBytes: payloadLimit,
      // This tracker is wired into the default-off worker observer, but these
      // readiness fields deliberately refer to a future executable package
      // path. The tracker alone cannot attest package decoding or replay.
      dependencyEncodingAvailable: true,
      dependencyEncodingReady: false,
      independentDependencyDecodingReady: false,
      runtimeIntegrationReady: false,
      committedTransactionCount,
      abortedTransactionCount,
      openTransactionCount: transaction ? 1 : 0,
      liveResourceCount,
      knownResourceCount: registry.size,
      resourcesIncluded: Boolean(includeResources),
      resources: Object.freeze(resources.map((entry) => Object.freeze(entry))),
    });
  }

  function createResource(resourceClass, resourceId, staged) {
    const prepared = prepareCreate(resourceClass, resourceId, staged);
    applyEntry(prepared.key, prepared.entry, staged);
    return prepared.entry.generation;
  }

  function prepareCreate(resourceClass, resourceId, staged) {
    const id = requiredU32(resourceId, "resourceId");
    const key = resourceKey(resourceClass, id);
    const current = lookupEntry(key, staged, true);
    if (current?.alive) fail(`resource ${key} is already alive`);
    ensureCreateCapacity([[resourceClass, id]], staged);
    const generation = (current?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation > 0xffff_ffff) {
      fail(`resource ${key} generation overflow`);
    }
    return {
      key,
      entry: Object.freeze({ resourceClass, resourceId: id, generation, alive: true }),
    };
  }

  function useResource(resourceClass, resourceId, staged) {
    const id = requiredU32(resourceId, "resourceId");
    const key = resourceKey(resourceClass, id);
    const current = lookupEntry(key, staged, true);
    if (!current?.alive) fail(`resource ${key} has no known live incarnation`);
    return current.generation;
  }

  function destroyResource(resourceClass, resourceId, staged) {
    const prepared = prepareDestroy(resourceClass, resourceId, staged);
    applyEntry(prepared.key, prepared.entry, staged);
    return prepared.generation;
  }

  function prepareDestroy(resourceClass, resourceId, staged) {
    const id = requiredU32(resourceId, "resourceId");
    const key = resourceKey(resourceClass, id);
    const current = lookupEntry(key, staged, true);
    if (!current?.alive) fail(`resource ${key} cannot be destroyed without a live incarnation`);
    return {
      key,
      entry: Object.freeze({ ...current, alive: false }),
      generation: current.generation,
    };
  }

  function dependency(role, resourceClass, resourceId, staged, binding = null) {
    const id = requiredU32(resourceId, `${role} resourceId`);
    const generation = useResource(resourceClass, id, staged);
    const result = { role, resourceClass, resourceId: id, generation };
    if (binding != null) result.binding = requiredU32(binding, "binding", true);
    return result;
  }

  function lookupEntry(key, staged, observe) {
    if (staged) {
      if (transaction.overlay.has(key)) return transaction.overlay.get(key);
      if (observe && !transaction.observedRevisions.has(key)) {
        transaction.observedRevisions.set(key, revisions.get(key) ?? 0);
      }
    }
    return registry.get(key);
  }

  function applyEntry(key, entry, staged) {
    if (staged) {
      if (!transaction.observedRevisions.has(key)) {
        transaction.observedRevisions.set(key, revisions.get(key) ?? 0);
      }
      transaction.overlay.set(key, entry);
      return;
    }
    applyCommittedEntry(key, entry);
    bumpRevision(key);
  }

  function applyCommittedEntry(key, entry) {
    const previous = registry.get(key);
    if (previous?.alive !== entry.alive) liveResourceCount += entry.alive ? 1 : -1;
    registry.set(key, entry);
  }

  function bumpRevision(key) {
    const next = (revisions.get(key) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) fail(`resource ${key} revision overflow`);
    revisions.set(key, next);
  }

  function trackedResourceKeyCount() {
    if (!transaction) return registry.size;
    let stagedNewKeys = 0;
    for (const key of transaction.overlay.keys()) {
      if (!registry.has(key)) stagedNewKeys += 1;
    }
    return registry.size + stagedNewKeys;
  }

  function ensureCreateCapacity(resources, staged) {
    const newKeys = new Set();
    for (const [resourceClass, resourceId] of resources) {
      const key = resourceKey(resourceClass, requiredU32(resourceId, "resourceId"));
      if (!registry.has(key) && !(staged && transaction.overlay.has(key))) newKeys.add(key);
    }
    if (trackedResourceKeyCount() + newKeys.size > resourceLimit) {
      fail(`resource tracking limit ${resourceLimit} exceeded`);
    }
  }

  function applyCommittedCounters(counters) {
    decoratedEventCount += counters.decorated;
    createCount += counters.create;
    useCount += counters.use;
    destroyCount += counters.destroy;
    dependencyCount += counters.dependencies;
  }

  function requireReady(operation) {
    if (!initialized) fail(`${operation} requires an explicit epoch boundary`);
    if (!baselineKnown) fail(`${operation} requires a complete resource baseline`);
    if (failed) throw new Error("resource generation tracker is failed; consumer-reset required");
  }

  function requireTransaction(transactionId, operation) {
    if (!transaction) fail(`${operation} requires an open resource transaction`);
    const id = requiredU32(transactionId, "transactionId");
    if (transaction.id !== id) {
      fail(`${operation} transaction ${id} does not match open transaction ${transaction.id}`);
    }
    return transaction;
  }

  function fail(reason) {
    recordFailure(reason);
    throw new Error(reason);
  }

  function recordFailure(reason) {
    if (failed) return;
    historicalFailureCount += 1;
    failed = true;
    reasons.add(reason);
  }

  return Object.freeze({
    beginEpoch: sticky(beginEpoch),
    beginTransaction: sticky(beginTransaction),
    decorate,
    commit: sticky(commit),
    abort: sticky(abort),
    snapshot,
    summary: () => snapshot({ includeResources: false }),
  });

  function sticky(operation) {
    return (...args) => {
      try {
        return operation(...args);
      } catch (error) {
        recordFailure(error?.message || String(error));
        throw error;
      }
    };
  }
}

function normalizeEpochKind(kind) {
  if (
    kind === WGPU_RESOURCE_EPOCH_KIND.LOAD ||
    kind === WGPU_RESOURCE_EPOCH_KIND.CONSUMER_RESET
  ) {
    return kind;
  }
  throw new RangeError(`resource epoch kind must be load or consumer-reset (received ${kind})`);
}

function emptyCounters() {
  return { decorated: 0, create: 0, use: 0, destroy: 0, dependencies: 0 };
}

function countersForEvent(opcode, dependencies) {
  const counters = emptyCounters();
  counters.decorated = 1;
  counters.dependencies = dependencies;
  switch (opcode) {
    case OP.CREATE_SHADER:
    case OP.CREATE_PIPELINE:
    case OP.CREATE_BUFFER:
    case OP.CREATE_TEXTURE:
    case OP.CREATE_PIPELINE_CFG:
    case OP.CREATE_SAMPLER:
    case OP.CREATE_BIND_GROUP:
      counters.create = 1;
      break;
    case OP.DRAW_TEST:
    case OP.SET_PIPELINE:
    case OP.UPLOAD_BUFFER:
    case OP.SET_VERTEX_BUFFER:
    case OP.SET_INDEX_BUFFER:
    case OP.UPLOAD_TEXTURE:
    case OP.BEGIN_PASS:
    case OP.SET_BIND_GROUP:
    case OP.BLIT_TEXTURE:
      counters.use = 1;
      break;
    case OP.DESTROY:
      counters.destroy = 1;
      break;
    default:
      break;
  }
  return counters;
}

function addCounters(target, source) {
  target.decorated += source.decorated;
  target.create += source.create;
  target.use += source.use;
  target.destroy += source.destroy;
  target.dependencies += source.dependencies;
}

function normalizeEvent(input) {
  if (!input || typeof input !== "object" || ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
    throw new TypeError(
      "resource tracking requires a canonical decoded event; raw package records are unsupported"
    );
  }
  const kind = requiredU32(input.kind, "kind", true);
  if (kind !== KIND.COMMAND) throw new RangeError(`unsupported semantic event kind ${kind}`);
  return {
    opcode: requiredU32(input.opcode, "opcode", true),
    resourceClass: requiredU32(input.resourceClass, "resourceClass", true),
    resourceId: requiredU32(input.resourceId, "resourceId", true),
    transaction: input.transaction == null
      ? null
      : requiredU32(input.transaction, "transaction", true),
    args: Array.from(input.args ?? [], (value) => requiredU32(value, "arg", true)),
    payloadBytes: exactBytes(input.payloadBytes ?? new Uint8Array(0), "payloadBytes"),
  };
}

function requirePrimary(event, resourceClass, resourceId = null) {
  if (event.resourceClass !== resourceClass) {
    throw new Error(
      `opcode ${event.opcode} resource class ${event.resourceClass} != ${resourceClass}`
    );
  }
  if (resourceId != null && event.resourceId !== resourceId) {
    throw new Error(`opcode ${event.opcode} resource id ${event.resourceId} != ${resourceId}`);
  }
  if (resourceClass !== RESOURCE.NONE && event.resourceId === 0) {
    if (!(resourceClass === RESOURCE.FRAMEBUFFER && event.opcode === OP.BEGIN_PASS)) {
      throw new Error(`opcode ${event.opcode} has a zero resource id`);
    }
  }
}

function requireArgs(event, minimum) {
  if (event.args.length < minimum) {
    throw new RangeError(`opcode ${event.opcode} requires at least ${minimum} canonical arguments`);
  }
}

function destroyClass(tag) {
  if (tag === 1) return RESOURCE.BUFFER;
  if (tag === 2) return RESOURCE.TEXTURE;
  if (tag === 3) return RESOURCE.BIND_GROUP;
  throw new RangeError(`unsupported destroy resource class tag ${tag}`);
}

function parseWpl3(bytesValue, payloadLimit) {
  const bytes = exactBytes(bytesValue, "WPL3");
  if (bytes.byteLength > payloadLimit) {
    throw new RangeError(`WPL3 payload exceeds ${payloadLimit} bytes`);
  }
  const words = exactLeWords(bytes, "WPL3");
  if (words.length < WPL3_HEADER_WORDS || words[0] !== WPL3_MAGIC) {
    throw new Error("WPL3 payload has invalid magic or truncated header");
  }
  const attributeCount = words[25];
  const expectedWords = WPL3_HEADER_WORDS + attributeCount * WPL3_ATTRIBUTE_WORDS;
  if (!Number.isSafeInteger(expectedWords) || words.length !== expectedWords) {
    throw new Error(
      `WPL3 payload length ${words.length} words does not match attribute count ${attributeCount}`
    );
  }
  return {
    vertexShaderId: requiredU32(words[1], "WPL3 vertex shader id"),
    fragmentShaderId: requiredU32(words[2], "WPL3 fragment shader id"),
  };
}

function parseWbg1(bytesValue, payloadLimit) {
  const bytes = exactBytes(bytesValue, "WBG1");
  if (bytes.byteLength > payloadLimit) {
    throw new RangeError(`WBG1 payload exceeds ${payloadLimit} bytes`);
  }
  const words = exactLeWords(bytes, "WBG1");
  if (words.length < WBG1_HEADER_WORDS || words[0] !== WBG1_MAGIC) {
    throw new Error("WBG1 payload has invalid magic or truncated header");
  }
  const group = words[1];
  if (group > 2) throw new RangeError(`WBG1 group ${group} is outside the fixed layout ABI`);
  const count = words[2];
  const expectedWords = WBG1_HEADER_WORDS + count * WBG1_ENTRY_WORDS;
  if (!Number.isSafeInteger(expectedWords) || words.length !== expectedWords) {
    throw new Error(`WBG1 payload length ${words.length} words does not match entry count ${count}`);
  }
  const result = [];
  const bindings = new Set();
  for (let index = 0; index < count; index += 1) {
    const base = WBG1_HEADER_WORDS + index * WBG1_ENTRY_WORDS;
    const binding = words[base];
    if (bindings.has(binding)) throw new Error(`WBG1 binding ${binding} is duplicated`);
    bindings.add(binding);
    const kind = words[base + 1];
    const resourceClass = kind === 0 || kind === 3
      ? RESOURCE.BUFFER
      : kind === 1
        ? RESOURCE.TEXTURE
        : kind === 2
          ? RESOURCE.SAMPLER
          : 0;
    if (resourceClass === 0) throw new RangeError(`WBG1 entry kind ${kind} is unsupported`);
    result.push({
      binding,
      resourceClass,
      resourceId: requiredU32(words[base + 2], `WBG1 binding ${binding} resource id`),
    });
  }
  return { group, entries: result };
}

function exactLeWords(value, label) {
  const bytes = exactBytes(value, label);
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
    throw new RangeError(`${label} payload must be a nonempty whole-u32 byte sequence`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from(
    { length: bytes.byteLength / 4 },
    (_, index) => view.getUint32(index * 4, true)
  );
}

function exactBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError(`${label} must be a Uint8Array or ArrayBuffer`);
}

function resourceKey(resourceClass, resourceId) {
  return `${resourceClass}:${resourceId}`;
}

function requiredU32(value, label, allowZero = false) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw new RangeError(`${label} must be a u32`);
  }
  if (!allowZero && number === 0) throw new RangeError(`${label} must be nonzero`);
  return number >>> 0;
}

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return number;
}
