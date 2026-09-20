// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_OWNERSHIP_TRACE_SCHEMA =
  "wasm-dolphin.wgpu-ownership-trace.v1";
export const WGPU_OWNERSHIP_TRACE_HEADER_WORDS = 5;
export const WGPU_OWNERSHIP_TRACE_RECORD_WORDS = 8;
export const WGPU_OWNERSHIP_EVENT = Object.freeze({
  EPOCH: 1,
  COMMAND: 2,
  COMMIT: 3,
  ABORT: 4,
  POISON: 5,
  ROLLBACK: 6,
  LOAD_REQUESTED: 7,
  CONSUMER_FAILURE: 8,
  PENDING_RESERVED: 9,
  PASS_BEGIN: 10,
  CAPTURE_END: 11,
});
export const WGPU_COMMAND_PUBLICATION = Object.freeze({
  IMMEDIATE: 0,
  PRIVATE_STAGED: 1,
  IMMEDIATE_ACTIVE: 2,
});

const DEFAULT_RECENT_RECORD_LIMIT = 64;
const MAX_RECENT_RECORD_LIMIT = 256;
const EVENT_HISTOGRAM_SIZE = 16;
const OPCODE_HISTOGRAM_SIZE = 32;
const ATTRIBUTION_HISTOGRAM_SIZE = 4;
const PUBLICATION_HISTOGRAM_SIZE = 4;

export function requestedWgpuOwnershipTrace(search = "") {
  return new URLSearchParams(search).get("wgpuownershiptrace") === "1";
}

export function attachWgpuOwnershipTraceFromApi(trace, api, heapBuffer) {
  if (!trace || typeof trace.attach !== "function") {
    throw new TypeError("ownership trace decoder is unavailable");
  }
  for (const name of [
    "setWebGpuOwnershipTraceEnabled",
    "getWebGpuOwnershipTracePtr",
    "getWebGpuOwnershipTraceCapacity",
  ]) {
    if (typeof api?.[name] !== "function") {
      throw new TypeError(`ownership trace native API ${name} is unavailable`);
    }
  }
  api.setWebGpuOwnershipTraceEnabled(1);
  const ptr = api.getWebGpuOwnershipTracePtr() >>> 0;
  const capacity = api.getWebGpuOwnershipTraceCapacity() >>> 0;
  trace.attach({
    ptr,
    capacity,
    schema: WGPU_OWNERSHIP_TRACE_SCHEMA,
    headerWords: WGPU_OWNERSHIP_TRACE_HEADER_WORDS,
    recordWords: WGPU_OWNERSHIP_TRACE_RECORD_WORDS,
  }, heapBuffer);
  return { ptr, capacity };
}

export function createWgpuOwnershipTrace({
  recentRecordLimit = DEFAULT_RECENT_RECORD_LIMIT,
} = {}) {
  const recentLimit = clampRecentLimit(recentRecordLimit);
  const eventHistogram = new Float64Array(EVENT_HISTOGRAM_SIZE);
  const opcodeHistogram = new Float64Array(OPCODE_HISTOGRAM_SIZE);
  const commandAttributionHistogram = new Float64Array(ATTRIBUTION_HISTOGRAM_SIZE);
  const commandPublicationHistogram = new Float64Array(PUBLICATION_HISTOGRAM_SIZE);
  const uploadBytesByAttribution = new Float64Array(ATTRIBUTION_HISTOGRAM_SIZE);
  const recentRecordWords = new Uint32Array(
    recentLimit * WGPU_OWNERSHIP_TRACE_RECORD_WORDS
  );
  let recentRecordCount = 0;
  let recentRecordWrite = 0;
  let requested = false;
  let active = false;
  let setterAvailable = false;
  let setterInvoked = false;
  let registered = false;
  let descriptor = null;
  let headerI32 = null;
  let recordsU32 = null;
  let observedRecords = 0;
  let drainedBatches = 0;
  let nativeDropped = 0;
  let epoch = 0;
  let epochChangeCount = 0;
  let recordEpochMismatchCount = 0;
  let monotonicOrderingViolationCount = 0;
  let malformedHeaderCount = 0;
  let malformedDescriptorCount = 0;
  let eventOverflowCount = 0;
  let opcodeOverflowCount = 0;
  let lastCommandSerial = null;
  let lastRecordEpoch = null;
  let maximumTransactionId = 0;
  let zeroTransactionCommandCount = 0;
  let lastError = "";

  function configure(next = {}) {
    requested = Boolean(next.requested);
    active = Boolean(next.active);
    setterAvailable = Boolean(next.setterAvailable);
    setterInvoked = Boolean(next.setterInvoked);
  }

  function attach(nextDescriptor, heapBuffer) {
    try {
      const normalized = validateDescriptor(nextDescriptor, heapBuffer);
      descriptor = normalized;
      headerI32 = new Int32Array(
        heapBuffer,
        normalized.ptr,
        WGPU_OWNERSHIP_TRACE_HEADER_WORDS
      );
      recordsU32 = new Uint32Array(
        heapBuffer,
        normalized.ptr + WGPU_OWNERSHIP_TRACE_HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT,
        normalized.capacity * WGPU_OWNERSHIP_TRACE_RECORD_WORDS
      );
      const headerCapacity = atomicLoad(headerI32, 2);
      if (headerCapacity !== normalized.capacity) {
        throw new RangeError(
          `ownership trace header capacity ${headerCapacity} != descriptor ${normalized.capacity}`
        );
      }
      epoch = atomicLoad(headerI32, 4);
      nativeDropped = atomicLoad(headerI32, 3);
      lastCommandSerial = null;
      lastRecordEpoch = null;
      registered = true;
      lastError = "";
      return true;
    } catch (error) {
      malformedDescriptorCount += 1;
      detach(String(error?.message || error));
      throw error;
    }
  }

  function drain({ collect = false, stopAfterEvent = null } = {}) {
    if (!registered || !headerI32 || !recordsU32 || !descriptor) {
      return collect ? [] : 0;
    }
    const write = atomicLoad(headerI32, 0);
    const read = atomicLoad(headerI32, 1);
    const headerCapacity = atomicLoad(headerI32, 2);
    const dropped = atomicLoad(headerI32, 3);
    const nextEpoch = atomicLoad(headerI32, 4);
    if (headerCapacity !== descriptor.capacity) {
      return failHeader(
        `ownership trace header capacity changed to ${headerCapacity}`,
        collect
      );
    }
    const available = (write - read) >>> 0;
    if (available > descriptor.capacity) {
      return failHeader(
        `ownership trace backlog ${available} exceeds capacity ${descriptor.capacity}`,
        collect
      );
    }
    epoch = nextEpoch;
    nativeDropped = dropped;
    if (available === 0) return collect ? [] : 0;

    const terminalEvent = stopAfterEvent == null
      ? null
      : validateEventCode(stopAfterEvent, "stopAfterEvent");
    const drained = collect ? [] : null;
    let drainedCount = 0;
    for (let offset = 0; offset < available; offset += 1) {
      const sequence = (read + offset) >>> 0;
      const slot = sequence % descriptor.capacity;
      const base = slot * WGPU_OWNERSHIP_TRACE_RECORD_WORDS;
      const event = recordsU32[base] >>> 0;
      const recordEpoch = recordsU32[base + 1] >>> 0;
      const transactionId = recordsU32[base + 2] >>> 0;
      const commandSerial = recordsU32[base + 3] >>> 0;
      const opcode = recordsU32[base + 4] >>> 0;
      const resourceId = recordsU32[base + 5] >>> 0;
      const payloadLength = recordsU32[base + 6] >>> 0;
      const auxiliary = recordsU32[base + 7] >>> 0;
      if (lastRecordEpoch == null) {
        lastRecordEpoch = recordEpoch;
      } else if (recordEpoch !== lastRecordEpoch) {
        if (isMonotonicU32(lastRecordEpoch, recordEpoch)) {
          epochChangeCount += 1;
          lastRecordEpoch = recordEpoch;
          lastCommandSerial = null;
        } else {
          recordEpochMismatchCount += 1;
        }
      }
      if (
        lastCommandSerial != null &&
        !isMonotonicU32(lastCommandSerial, commandSerial)
      ) {
        monotonicOrderingViolationCount += 1;
      }
      lastCommandSerial = commandSerial;
      if (event < EVENT_HISTOGRAM_SIZE) eventHistogram[event] += 1;
      else eventOverflowCount += 1;
      if (event === WGPU_OWNERSHIP_EVENT.COMMAND) {
        if (opcode < OPCODE_HISTOGRAM_SIZE) opcodeHistogram[opcode] += 1;
        else opcodeOverflowCount += 1;
        const attribution = auxiliary & 0x3;
        const publication = (auxiliary >>> 8) & 0x3;
        commandAttributionHistogram[attribution] += 1;
        commandPublicationHistogram[publication] += 1;
        maximumTransactionId = Math.max(maximumTransactionId, transactionId);
        if (transactionId === 0) zeroTransactionCommandCount += 1;
        if (opcode === 6 || opcode === 8) {
          uploadBytesByAttribution[attribution] += payloadLength;
        }
      }
      observedRecords += 1;
      const recentBase = recentRecordWrite * WGPU_OWNERSHIP_TRACE_RECORD_WORDS;
      recentRecordWords[recentBase] = event;
      recentRecordWords[recentBase + 1] = recordEpoch;
      recentRecordWords[recentBase + 2] = transactionId;
      recentRecordWords[recentBase + 3] = commandSerial;
      recentRecordWords[recentBase + 4] = opcode;
      recentRecordWords[recentBase + 5] = resourceId;
      recentRecordWords[recentBase + 6] = payloadLength;
      recentRecordWords[recentBase + 7] = auxiliary;
      recentRecordWrite = (recentRecordWrite + 1) % recentLimit;
      recentRecordCount = Math.min(recentLimit, recentRecordCount + 1);
      if (collect) {
        drained.push(recordFromWords(
          event,
          recordEpoch,
          transactionId,
          commandSerial,
          opcode,
          resourceId,
          payloadLength,
          auxiliary
        ));
      }
      drainedCount += 1;
      if (terminalEvent != null && event === terminalEvent) break;
    }
    atomicStore(headerI32, 1, (read + drainedCount) >>> 0);
    drainedBatches += 1;
    return collect ? drained : drainedCount;
  }

  function reset(kind = "reset") {
    detach(String(kind || "reset"));
    lastCommandSerial = null;
    lastRecordEpoch = null;
  }

  function snapshot() {
    const write = registered ? atomicLoad(headerI32, 0) : 0;
    const read = registered ? atomicLoad(headerI32, 1) : 0;
    return {
      schema: WGPU_OWNERSHIP_TRACE_SCHEMA,
      requested,
      active,
      enabled: active,
      setterAvailable,
      setterInvoked,
      registered,
      descriptorSchema: descriptor?.schema ?? "",
      headerWords: descriptor?.headerWords ?? WGPU_OWNERSHIP_TRACE_HEADER_WORDS,
      recordWords: descriptor?.recordWords ?? WGPU_OWNERSHIP_TRACE_RECORD_WORDS,
      capacity: descriptor?.capacity ?? 0,
      epoch,
      write,
      read,
      backlog: registered ? (write - read) >>> 0 : 0,
      nativeDropped,
      observedRecords,
      drainedBatches,
      epochChangeCount,
      recordEpochMismatchCount,
      monotonicOrderingViolationCount,
      malformedHeaderCount,
      malformedDescriptorCount,
      eventHistogram: Array.from(eventHistogram),
      opcodeHistogram: Array.from(opcodeHistogram),
      commandAttributionHistogram: Array.from(commandAttributionHistogram),
      commandPublicationHistogram: Array.from(commandPublicationHistogram),
      uploadBytesByAttribution: Array.from(uploadBytesByAttribution),
      maximumTransactionId,
      zeroTransactionCommandCount,
      eventOverflowCount,
      opcodeOverflowCount,
      recentRecordLimit: recentLimit,
      recentRecords: snapshotRecentRecords(
        recentRecordWords,
        recentRecordCount,
        recentRecordWrite,
        recentLimit
      ),
      lastError,
    };
  }

  function failHeader(message, collect = false) {
    malformedHeaderCount += 1;
    detach(message);
    return collect ? [] : 0;
  }

  function detach(message = "") {
    registered = false;
    descriptor = null;
    headerI32 = null;
    recordsU32 = null;
    lastError = message;
  }

  return { configure, attach, drain, reset, snapshot };
}

function validateDescriptor(value, heapBuffer) {
  const shared = typeof SharedArrayBuffer === "function" &&
    heapBuffer instanceof SharedArrayBuffer;
  if (!(heapBuffer instanceof ArrayBuffer) && !shared) {
    throw new TypeError("ownership trace requires an ArrayBuffer-backed wasm heap");
  }
  const ptr = Number(value?.ptr);
  const capacity = Number(value?.capacity);
  const headerWords = Number(value?.headerWords);
  const recordWords = Number(value?.recordWords);
  const schema = String(value?.schema || "");
  if (schema !== WGPU_OWNERSHIP_TRACE_SCHEMA) {
    throw new TypeError(`unsupported ownership trace schema ${schema || "<empty>"}`);
  }
  if (!Number.isSafeInteger(ptr) || ptr < 0 || ptr % 4 !== 0) {
    throw new RangeError("ownership trace ptr must be an aligned non-negative integer");
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("ownership trace capacity must be positive");
  }
  if (headerWords !== WGPU_OWNERSHIP_TRACE_HEADER_WORDS) {
    throw new RangeError(`ownership trace headerWords must equal ${WGPU_OWNERSHIP_TRACE_HEADER_WORDS}`);
  }
  if (recordWords !== WGPU_OWNERSHIP_TRACE_RECORD_WORDS) {
    throw new RangeError(`ownership trace recordWords must equal ${WGPU_OWNERSHIP_TRACE_RECORD_WORDS}`);
  }
  const end = ptr + (headerWords + capacity * recordWords) * Uint32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(end) || end > heapBuffer.byteLength) {
    throw new RangeError("ownership trace span exceeds the wasm heap");
  }
  return { ptr, capacity, headerWords, recordWords, schema };
}

function recordFromWords(
  event,
  epoch,
  transactionId,
  commandSerial,
  opcode,
  resourceId,
  payloadLength,
  auxiliary
) {
  return {
    event,
    epoch,
    transactionId,
    commandSerial,
    opcode,
    resourceId,
    payloadLength,
    auxiliary,
  };
}

function snapshotRecentRecords(words, count, write, capacity) {
  const records = [];
  const first = (write - count + capacity) % capacity;
  for (let offset = 0; offset < count; offset += 1) {
    const slot = (first + offset) % capacity;
    const base = slot * WGPU_OWNERSHIP_TRACE_RECORD_WORDS;
    records.push(recordFromWords(
      words[base] >>> 0,
      words[base + 1] >>> 0,
      words[base + 2] >>> 0,
      words[base + 3] >>> 0,
      words[base + 4] >>> 0,
      words[base + 5] >>> 0,
      words[base + 6] >>> 0,
      words[base + 7] >>> 0
    ));
  }
  return records;
}

function isMonotonicU32(previous, next) {
  const distance = (next - previous) >>> 0;
  return distance === 0 || distance < 0x80000000;
}

function atomicLoad(view, index) {
  return typeof SharedArrayBuffer === "function" && view.buffer instanceof SharedArrayBuffer
    ? Atomics.load(view, index) >>> 0
    : view[index] >>> 0;
}

function atomicStore(view, index, value) {
  if (typeof SharedArrayBuffer === "function" && view.buffer instanceof SharedArrayBuffer) {
    Atomics.store(view, index, value | 0);
  }
  else view[index] = value | 0;
}

function clampRecentLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_RECENT_RECORD_LIMIT;
  return Math.min(MAX_RECENT_RECORD_LIMIT, Math.max(1, Math.floor(number)));
}

function validateEventCode(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw new RangeError(`${name} must be a u32`);
  }
  return number >>> 0;
}
