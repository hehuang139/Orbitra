// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  WGPU_UBO_COMPUTE_CLASS_BYTES,
  WGPU_UBO_COMPUTE_DIFF_GRANULARITY,
} from "./wgpu-ubo-compute-projection.js";

export const WGPU_UBO_COMPUTE_CODEC_MAGIC = 0x55424350; // "PCBU" as LE bytes
export const WGPU_UBO_COMPUTE_CODEC_VERSION = 1;
export const WGPU_UBO_COMPUTE_PACKAGE_ALIGNMENT = 256;

const HEADER_BYTES = 32;
const RECORD_BYTES = 32;
const RANGE_BYTES = 8;
const KIND = Object.freeze({ FULL: 0, DELTA: 1, EQUAL: 2 });
const CLASS = Object.freeze({ VS: 0, PS: 1, GS: 2 });
const CLASS_NAME = Object.freeze(["VS", "PS", "GS"]);

export function encodeWgpuUboComputePackage({
  uploads,
  shadows = new Map(),
  packageAlignment = WGPU_UBO_COMPUTE_PACKAGE_ALIGNMENT,
  borrowUploadBytes = false,
} = {}) {
  if (!Array.isArray(uploads) || uploads.length === 0) {
    throw new TypeError("uploads must be a non-empty array");
  }
  assertAlignment(packageAlignment);

  const resourceId = normalizeU32(uploads[0]?.resourceId, "resourceId");
  const nextShadows = cloneShadowMap(shadows);
  const records = [];
  let rangeBytes = 0;
  let payloadBytes = 0;

  for (const upload of uploads) {
    const id = normalizeU32(upload?.resourceId, "resourceId");
    if (id !== resourceId) {
      throw new RangeError("one compute package may target only one resource");
    }
    const classId = CLASS[upload?.resourceClass];
    if (classId === undefined) throw new RangeError("unsupported UBO resource class");
    const objectBytes = WGPU_UBO_COMPUTE_CLASS_BYTES[upload.resourceClass];
    const source = viewBytes(upload.bytes, borrowUploadBytes);
    if (!source || source.byteLength !== objectBytes) {
      throw new RangeError(`invalid ${upload.resourceClass} payload size`);
    }
    const destinationOffset = normalizeU32(upload.destinationOffset, "destinationOffset");
    if ((destinationOffset & 3) !== 0 || destinationOffset + objectBytes > 0x1_0000_0000) {
      throw new RangeError("destination range is unaligned or overflows u32");
    }

    const key = shadowKey(resourceId, classId);
    const previous = nextShadows.get(key);
    let kind = KIND.FULL;
    let ranges = [{ offset: 0, bytes: source }];
    if (previous) {
      ranges = findChangedRanges(previous, source);
      if (ranges.length === 0) {
        kind = KIND.EQUAL;
      } else {
        const changedBytes = ranges.reduce((sum, range) => sum + range.bytes.byteLength, 0);
        if (changedBytes + ranges.length * RANGE_BYTES < objectBytes) {
          kind = KIND.DELTA;
        } else {
          kind = KIND.FULL;
          ranges = [{ offset: 0, bytes: source }];
        }
      }
    }
    nextShadows.set(key, source.slice());
    const recordPayloadBytes = ranges.reduce(
      (sum, range) => sum + range.bytes.byteLength,
      0
    );
    records.push({
      kind,
      classId,
      resourceId,
      destinationOffset,
      objectBytes,
      ranges,
      recordPayloadBytes,
    });
    rangeBytes += ranges.length * RANGE_BYTES;
    payloadBytes += recordPayloadBytes;
  }

  const rangeStart = HEADER_BYTES + records.length * RECORD_BYTES;
  const payloadStart = alignUp(rangeStart + rangeBytes, 16);
  const logicalBytes = payloadStart + payloadBytes;
  const packageBytes = alignUp(logicalBytes, packageAlignment);
  if (packageBytes > 0xffff_ffff) throw new RangeError("package exceeds u32 size");
  const output = new Uint8Array(packageBytes);
  const view = new DataView(output.buffer);
  writeU32(view, 0, WGPU_UBO_COMPUTE_CODEC_MAGIC);
  writeU32(view, 4, WGPU_UBO_COMPUTE_CODEC_VERSION);
  writeU32(view, 8, records.length);
  writeU32(view, 12, rangeStart);
  writeU32(view, 16, payloadStart);
  writeU32(view, 20, logicalBytes);
  writeU32(view, 24, packageBytes);
  writeU32(view, 28, resourceId);

  let nextRangeOffset = rangeStart;
  let nextPayloadOffset = payloadStart;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const descriptor = HEADER_BYTES + index * RECORD_BYTES;
    writeU32(view, descriptor, record.kind);
    writeU32(view, descriptor + 4, record.classId);
    writeU32(view, descriptor + 8, record.destinationOffset);
    writeU32(view, descriptor + 12, record.objectBytes);
    writeU32(view, descriptor + 16, record.ranges.length);
    writeU32(view, descriptor + 20, nextRangeOffset);
    writeU32(view, descriptor + 24, nextPayloadOffset);
    writeU32(view, descriptor + 28, record.recordPayloadBytes);
    let recordPayloadOffset = nextPayloadOffset;
    for (const range of record.ranges) {
      writeU32(view, nextRangeOffset, range.offset);
      writeU32(view, nextRangeOffset + 4, range.bytes.byteLength);
      output.set(range.bytes, recordPayloadOffset);
      nextRangeOffset += RANGE_BYTES;
      recordPayloadOffset += range.bytes.byteLength;
    }
    nextPayloadOffset += record.recordPayloadBytes;
  }

  return Object.freeze({
    bytes: output,
    logicalBytes,
    packageBytes,
    payloadBytes,
    descriptorBytes: records.length * RECORD_BYTES + rangeBytes,
    resourceId,
    recordCount: records.length,
    kinds: Object.freeze(records.map((record) => CLASS_NAME[record.classId] + ":" + kindName(record.kind))),
    nextShadows,
  });
}

// Independent CPU reference for the package contract. It validates the whole
// package and every destination before changing either destinations or shadows.
export function applyWgpuUboComputePackageReference({
  packageBytes,
  destinations,
  shadows = new Map(),
} = {}) {
  const bytes = copyBytes(packageBytes);
  if (!bytes || !(destinations instanceof Map)) {
    throw new TypeError("packageBytes and destination map are required");
  }
  const parsed = validatePackage(bytes, destinations);
  const nextShadows = cloneShadowMap(shadows);
  const destinationCopies = new Map();
  for (const [id, destination] of destinations) {
    destinationCopies.set(id, copyBytes(destination));
  }

  for (const record of parsed.records) {
    const key = shadowKey(parsed.resourceId, record.classId);
    let shadow = nextShadows.get(key);
    if (record.kind === KIND.FULL) shadow = new Uint8Array(record.objectBytes);
    if (!shadow || shadow.byteLength !== record.objectBytes) {
      throw new Error("DELTA/EQUAL record has no valid prior shadow");
    }
    let payloadCursor = record.payloadOffset;
    for (const range of record.ranges) {
      shadow.set(bytes.subarray(payloadCursor, payloadCursor + range.length), range.offset);
      payloadCursor += range.length;
    }
    nextShadows.set(key, shadow);
    destinationCopies.get(parsed.resourceId).set(shadow, record.destinationOffset);
  }

  for (const [id, copy] of destinationCopies) destinations.get(id).set(copy);
  replaceShadowMap(shadows, nextShadows);
  return Object.freeze({
    resourceId: parsed.resourceId,
    recordCount: parsed.records.length,
    logicalBytes: parsed.logicalBytes,
  });
}

function validatePackage(bytes, destinations) {
  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength % WGPU_UBO_COMPUTE_PACKAGE_ALIGNMENT !== 0) {
    throw new RangeError("package size/alignment is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readU32(view, 0) !== WGPU_UBO_COMPUTE_CODEC_MAGIC ||
      readU32(view, 4) !== WGPU_UBO_COMPUTE_CODEC_VERSION) {
    throw new RangeError("package magic/version is invalid");
  }
  const recordCount = readU32(view, 8);
  const rangeStart = readU32(view, 12);
  const payloadStart = readU32(view, 16);
  const logicalBytes = readU32(view, 20);
  const declaredPackageBytes = readU32(view, 24);
  const resourceId = readU32(view, 28);
  if (recordCount === 0 || recordCount > 256 ||
      rangeStart !== HEADER_BYTES + recordCount * RECORD_BYTES ||
      payloadStart < rangeStart || (payloadStart & 15) !== 0 ||
      logicalBytes < payloadStart || logicalBytes > bytes.byteLength ||
      declaredPackageBytes !== bytes.byteLength) {
    throw new RangeError("package header is inconsistent");
  }
  const destination = destinations.get(resourceId);
  if (!(destination instanceof Uint8Array)) throw new RangeError("unknown destination resource");
  const records = [];
  let expectedRangeOffset = rangeStart;
  let expectedPayloadOffset = payloadStart;
  for (let index = 0; index < recordCount; index += 1) {
    const offset = HEADER_BYTES + index * RECORD_BYTES;
    const kind = readU32(view, offset);
    const classId = readU32(view, offset + 4);
    const destinationOffset = readU32(view, offset + 8);
    const objectBytes = readU32(view, offset + 12);
    const rangeCount = readU32(view, offset + 16);
    const rangeOffset = readU32(view, offset + 20);
    const payloadOffset = readU32(view, offset + 24);
    const payloadLength = readU32(view, offset + 28);
    if (kind > KIND.EQUAL || classId >= CLASS_NAME.length ||
        objectBytes !== WGPU_UBO_COMPUTE_CLASS_BYTES[CLASS_NAME[classId]] ||
        (destinationOffset & 3) !== 0 || destinationOffset + objectBytes > destination.byteLength ||
        rangeCount > Math.ceil(objectBytes / WGPU_UBO_COMPUTE_DIFF_GRANULARITY) ||
        rangeOffset !== expectedRangeOffset || payloadOffset !== expectedPayloadOffset) {
      throw new RangeError("record descriptor is invalid");
    }
    if ((kind === KIND.EQUAL && (rangeCount !== 0 || payloadLength !== 0)) ||
        (kind !== KIND.EQUAL && rangeCount === 0)) {
      throw new RangeError("record kind/range contract is invalid");
    }
    if (rangeOffset + rangeCount * RANGE_BYTES > payloadStart ||
        payloadOffset + payloadLength > logicalBytes) {
      throw new RangeError("record tables or payload are truncated");
    }
    const ranges = [];
    let rangePayloadBytes = 0;
    let previousEnd = 0;
    for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex += 1) {
      const entry = rangeOffset + rangeIndex * RANGE_BYTES;
      const start = readU32(view, entry);
      const length = readU32(view, entry + 4);
      if (length === 0 || (start & 15) !== 0 || (length & 15) !== 0 ||
          start < previousEnd || start + length > objectBytes) {
        throw new RangeError("record range is invalid or overlapping");
      }
      previousEnd = start + length;
      rangePayloadBytes += length;
      ranges.push({ offset: start, length });
    }
    if (rangePayloadBytes !== payloadLength ||
        (kind === KIND.FULL && (rangeCount !== 1 || ranges[0]?.offset !== 0 || payloadLength !== objectBytes))) {
      throw new RangeError("record payload accounting is invalid");
    }
    expectedRangeOffset += rangeCount * RANGE_BYTES;
    expectedPayloadOffset += payloadLength;
    records.push({ kind, classId, destinationOffset, objectBytes, payloadOffset, ranges });
  }
  if (expectedRangeOffset > payloadStart || expectedPayloadOffset !== logicalBytes) {
    throw new RangeError("package accounting is invalid");
  }
  return { resourceId, records, logicalBytes };
}

function findChangedRanges(previous, next) {
  const ranges = [];
  let start = -1;
  for (let offset = 0; offset < next.byteLength; offset += WGPU_UBO_COMPUTE_DIFF_GRANULARITY) {
    const end = Math.min(offset + WGPU_UBO_COMPUTE_DIFF_GRANULARITY, next.byteLength);
    let changed = false;
    for (let index = offset; index < end; index += 1) {
      if (previous[index] !== next[index]) { changed = true; break; }
    }
    if (changed && start < 0) start = offset;
    if (!changed && start >= 0) {
      ranges.push({ offset: start, bytes: next.slice(start, offset) });
      start = -1;
    }
  }
  if (start >= 0) ranges.push({ offset: start, bytes: next.slice(start) });
  return ranges;
}

function shadowKey(resourceId, classId) { return `${resourceId}:${classId}`; }
function kindName(kind) { return kind === KIND.FULL ? "FULL" : kind === KIND.DELTA ? "DELTA" : "EQUAL"; }
function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
function readU32(view, offset) { return view.getUint32(offset, true); }
function alignUp(value, alignment) { return Math.ceil(value / alignment) * alignment; }
function assertAlignment(value) {
  if (!Number.isSafeInteger(value) || value < 256 || (value & (value - 1)) !== 0) {
    throw new RangeError("packageAlignment must be a power of two >= 256");
  }
}
function normalizeU32(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a u32`);
  }
  return value >>> 0;
}
function viewBytes(value, borrow = false) {
  if (!ArrayBuffer.isView(value)) return null;
  const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return borrow ? view : view.slice();
}
function copyBytes(value) { return viewBytes(value, false); }
function cloneShadowMap(source) {
  if (!(source instanceof Map)) throw new TypeError("shadows must be a Map");
  return new Map([...source].map(([key, value]) => [key, copyBytes(value)]));
}
function replaceShadowMap(destination, source) {
  destination.clear();
  for (const [key, value] of source) destination.set(key, value);
}
