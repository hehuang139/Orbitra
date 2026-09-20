// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_UBO_COMPUTE_PROJECTION_SCHEMA =
  "wasm-dolphin.wgpu-ubo-compute-projection.v1";

export const WGPU_UBO_COMPUTE_CLASS_BYTES = Object.freeze({
  VS: 4112,
  PS: 1536,
  GS: 64,
});

export const WGPU_UBO_COMPUTE_DIFF_GRANULARITY = 16;

const DEFAULT_DESCRIPTOR_BYTES = 16;
const DEFAULT_RANGE_DESCRIPTOR_BYTES = 8;
const DEFAULT_PACKAGE_ALIGNMENT = 256;
const DEFAULT_MAX_RECORDS_PER_PACKAGE = 256;
const DEFAULT_MAX_PACKAGE_WORK_BYTES = 1024 * 1024;

export function requestedWgpuUboComputeProjection(search = "") {
  return new URLSearchParams(search).get("wgpuubocomputeprojection") === "1";
}

// Passive CPU model for a possible future compute-based UBO reconstruction
// path. It never submits GPU work or changes replay. Returned records are
// descriptions only; callers may use them for reference validation.
export function createWgpuUboComputeProjection({
  descriptorBytes = DEFAULT_DESCRIPTOR_BYTES,
  rangeDescriptorBytes = DEFAULT_RANGE_DESCRIPTOR_BYTES,
  packageAlignment = DEFAULT_PACKAGE_ALIGNMENT,
  maxRecordsPerPackage = DEFAULT_MAX_RECORDS_PER_PACKAGE,
  maxPackageWorkBytes = DEFAULT_MAX_PACKAGE_WORK_BYTES,
} = {}) {
  const recordDescriptorBytes = positiveIntegerOr(
    descriptorBytes,
    DEFAULT_DESCRIPTOR_BYTES
  );
  const perRangeDescriptorBytes = positiveIntegerOr(
    rangeDescriptorBytes,
    DEFAULT_RANGE_DESCRIPTOR_BYTES
  );
  const alignment = positivePowerOfTwoOr(
    packageAlignment,
    DEFAULT_PACKAGE_ALIGNMENT
  );
  const recordCap = positiveIntegerOr(
    maxRecordsPerPackage,
    DEFAULT_MAX_RECORDS_PER_PACKAGE
  );
  const workCap = positiveIntegerOr(
    maxPackageWorkBytes,
    DEFAULT_MAX_PACKAGE_WORK_BYTES
  );

  const shadows = new Map();
  const splitReasons = Object.create(null);
  const boundaryReasons = Object.create(null);
  const resetReasons = Object.create(null);

  let currentPackage = null;
  let nextRecordSequence = 0;
  let nextPackageSequence = 0;
  let eligibleCalls = 0;
  let eligibleBytes = 0;
  let malformedCalls = 0;
  let unclassifiedResourceIdentity = 0;
  let fullCount = 0;
  let deltaCount = 0;
  let equalCount = 0;
  let rawCount = 0;
  let utilityRawCount = 0;
  let unknownClassRawCount = 0;
  let rangeCount = 0;
  let reconstructedBytes = 0;
  let payloadBytes = 0;
  let descriptorByteCount = 0;
  let sealedPackageCount = 0;
  let sealedPackageWorkBytes = 0;
  let sealedPackagePaddingBytes = 0;
  let sealedPackageRecordCount = 0;
  let splitCount = 0;
  let boundaryCount = 0;
  let resetCount = 0;
  let maxRecordSerializedBytes = 0;
  let maxRecordPayloadBytes = 0;
  let maxRecordRangeCount = 0;
  let maxRecordReconstructedBytes = 0;
  let maxPackageWorkBytesObserved = 0;
  let maxRecordsInPackage = 0;
  let oversizedRecordCount = 0;

  function observeUpload({
    resourceId,
    resourceClass,
    destinationOffset,
    bytes,
    utility = false,
    rawReason = null,
  } = {}) {
    const source = copyBytes(bytes);
    const validDestination = Number.isSafeInteger(destinationOffset) &&
      destinationOffset >= 0;
    if (!source || !validDestination) {
      malformedCalls += 1;
      return {
        accepted: false,
        reason: source ? "invalidDestinationOffset" : "invalidBytes",
        sequence: nextRecordSequence++,
      };
    }

    const identity = classifyIdentity(
      resourceId,
      resourceClass,
      utility,
      rawReason
    );
    if (!identity.classified) unclassifiedResourceIdentity += 1;
    const wrongClassSize = identity.kind === "CLASS" &&
      source.byteLength !== WGPU_UBO_COMPUTE_CLASS_BYTES[identity.className];
    if (identity.malformed || wrongClassSize || source.byteLength === 0) {
      malformedCalls += 1;
    }

    let record;
    if (identity.kind === "CLASS" &&
        source.byteLength === WGPU_UBO_COMPUTE_CLASS_BYTES[identity.className]) {
      record = buildClassRecord(identity, destinationOffset, source);
    } else {
      record = buildRawRecord(identity, destinationOffset, source);
    }

    const descriptorTotal = recordDescriptorBytes +
      (record.kind === "DELTA"
        ? record.ranges.length * perRangeDescriptorBytes
        : 0);
    record.descriptorBytes = descriptorTotal;
    record.serializedBytes = descriptorTotal + record.payloadBytes;
    record.sequence = nextRecordSequence++;
    record.accepted = true;

    if (currentPackage && currentPackage.recordCount >= recordCap) {
      split("recordCap");
    }
    if (currentPackage &&
        currentPackage.workBytes + record.serializedBytes > workCap) {
      split("workCap");
    }
    if (!currentPackage) startPackage();
    if (record.serializedBytes > workCap) oversizedRecordCount += 1;

    currentPackage.recordCount += 1;
    currentPackage.workBytes += record.serializedBytes;
    record.packageSequence = currentPackage.sequence;
    record.packageRecordIndex = currentPackage.recordCount - 1;

    eligibleCalls += 1;
    eligibleBytes += source.byteLength;
    payloadBytes += record.payloadBytes;
    descriptorByteCount += descriptorTotal;
    reconstructedBytes += record.reconstructedBytes;
    rangeCount += record.ranges.length;
    maxRecordSerializedBytes = Math.max(
      maxRecordSerializedBytes,
      record.serializedBytes
    );
    maxRecordPayloadBytes = Math.max(maxRecordPayloadBytes, record.payloadBytes);
    maxRecordRangeCount = Math.max(maxRecordRangeCount, record.ranges.length);
    maxRecordReconstructedBytes = Math.max(
      maxRecordReconstructedBytes,
      record.reconstructedBytes
    );
    return record;
  }

  function buildClassRecord(identity, destinationOffset, source) {
    const shadowKey = `${identity.resourceKey}\u0000${identity.className}`;
    const previous = shadows.get(shadowKey);
    let kind = "FULL";
    let ranges = [{ offset: 0, bytes: source.slice() }];

    if (previous) {
      ranges = changedRanges(previous, source);
      if (ranges.length === 0) {
        kind = "EQUAL";
      } else {
        const deltaPayloadBytes = sumRangeBytes(ranges);
        const deltaSerializedBytes = recordDescriptorBytes +
          ranges.length * perRangeDescriptorBytes + deltaPayloadBytes;
        const fullSerializedBytes = recordDescriptorBytes + source.byteLength;
        if (deltaSerializedBytes < fullSerializedBytes) {
          kind = "DELTA";
        } else {
          kind = "FULL";
          ranges = [{ offset: 0, bytes: source.slice() }];
        }
      }
    }

    shadows.set(shadowKey, source.slice());
    if (kind === "FULL") fullCount += 1;
    else if (kind === "DELTA") deltaCount += 1;
    else equalCount += 1;
    return makeRecord({
      kind,
      identity,
      destinationOffset,
      sourceBytes: source.byteLength,
      ranges,
      reconstructedBytes: source.byteLength,
    });
  }

  function buildRawRecord(identity, destinationOffset, source) {
    rawCount += 1;
    if (identity.rawReason === "utility") utilityRawCount += 1;
    if (identity.rawReason === "unknown-class-size") unknownClassRawCount += 1;
    return makeRecord({
      kind: "RAW_FULL",
      identity,
      destinationOffset,
      sourceBytes: source.byteLength,
      ranges: [{ offset: 0, bytes: source.slice() }],
      reconstructedBytes: source.byteLength,
    });
  }

  function boundary(reason = "boundary") {
    const normalizedReason = String(reason || "boundary");
    if (currentPackage) sealPackage();
    boundaryCount += 1;
    boundaryReasons[normalizedReason] =
      (boundaryReasons[normalizedReason] || 0) + 1;
  }

  function reset(reason = "reset") {
    boundary(reason);
    shadows.clear();
    resetCount += 1;
    const normalizedReason = String(reason || "reset");
    resetReasons[normalizedReason] = (resetReasons[normalizedReason] || 0) + 1;
  }

  function snapshot({ requested = false, active = requested } = {}) {
    const pendingPackages = currentPackage ? 1 : 0;
    const pendingWorkBytes = currentPackage?.workBytes ?? 0;
    const pendingPaddingBytes = currentPackage
      ? alignUp(pendingWorkBytes, alignment) - pendingWorkBytes
      : 0;
    const packages = sealedPackageCount + pendingPackages;
    const packageWorkBytes = sealedPackageWorkBytes + pendingWorkBytes;
    const paddingBytes = sealedPackagePaddingBytes + pendingPaddingBytes;
    const projectedBytes = packageWorkBytes + paddingBytes;
    const avoidedBytes = eligibleBytes - projectedBytes;
    const projectedCopyCommands = packages;

    return {
      schema: WGPU_UBO_COMPUTE_PROJECTION_SCHEMA,
      requested: Boolean(requested),
      active: Boolean(active),
      enabled: Boolean(active),
      projectionOnly: true,
      replayBehaviorChanged: false,
      runtimeEligible: false,
      configuration: {
        descriptorBytes: recordDescriptorBytes,
        rangeDescriptorBytes: perRangeDescriptorBytes,
        diffGranularity: WGPU_UBO_COMPUTE_DIFF_GRANULARITY,
        packageAlignment: alignment,
        maxRecordsPerPackage: recordCap,
        maxPackageWorkBytes: workCap,
      },
      eligible: { calls: eligibleCalls, bytes: eligibleBytes },
      bytes: {
        payload: payloadBytes,
        descriptors: descriptorByteCount,
        packageWork: packageWorkBytes,
        packagePadding: paddingBytes,
        projected: projectedBytes,
        avoided: avoidedBytes,
        avoidedPercent: eligibleBytes > 0 ? avoidedBytes / eligibleBytes * 100 : 0,
      },
      commands: {
        legacyCopy: eligibleCalls,
        projectedCopy: projectedCopyCommands,
        avoidedCopy: eligibleCalls - projectedCopyCommands,
        dispatches: packages,
        packages,
      },
      records: {
        total: eligibleCalls,
        full: fullCount,
        delta: deltaCount,
        equal: equalCount,
        rawFull: rawCount,
        utilityRaw: utilityRawCount,
        unknownClassRaw: unknownClassRawCount,
        ranges: rangeCount,
        reconstructedBytes,
      },
      maxima: {
        recordSerializedBytes: maxRecordSerializedBytes,
        recordPayloadBytes: maxRecordPayloadBytes,
        rangesPerRecord: maxRecordRangeCount,
        reconstructedBytesPerRecord: maxRecordReconstructedBytes,
        packageWorkBytes: Math.max(
          maxPackageWorkBytesObserved,
          pendingWorkBytes
        ),
        recordsPerPackage: Math.max(
          maxRecordsInPackage,
          currentPackage?.recordCount ?? 0
        ),
      },
      packages: {
        sealed: sealedPackageCount,
        pending: pendingPackages,
        records: sealedPackageRecordCount +
          (currentPackage?.recordCount ?? 0),
        oversizedRecords: oversizedRecordCount,
      },
      splits: { total: splitCount, reasons: { ...splitReasons } },
      boundaries: {
        total: boundaryCount,
        reasons: { ...boundaryReasons },
      },
      resets: {
        total: resetCount,
        reasons: { ...resetReasons },
        shadowEntries: shadows.size,
      },
      malformed: malformedCalls,
      unclassifiedResourceIdentity,
    };
  }

  function startPackage() {
    currentPackage = {
      sequence: nextPackageSequence++,
      recordCount: 0,
      workBytes: 0,
    };
  }

  function sealPackage() {
    if (!currentPackage) return;
    const padding = alignUp(currentPackage.workBytes, alignment) -
      currentPackage.workBytes;
    sealedPackageCount += 1;
    sealedPackageRecordCount += currentPackage.recordCount;
    sealedPackageWorkBytes += currentPackage.workBytes;
    sealedPackagePaddingBytes += padding;
    maxPackageWorkBytesObserved = Math.max(
      maxPackageWorkBytesObserved,
      currentPackage.workBytes
    );
    maxRecordsInPackage = Math.max(
      maxRecordsInPackage,
      currentPackage.recordCount
    );
    currentPackage = null;
  }

  function split(reason) {
    sealPackage();
    splitCount += 1;
    splitReasons[reason] = (splitReasons[reason] || 0) + 1;
  }

  return { observeUpload, boundary, reset, snapshot };
}

function classifyIdentity(resourceId, resourceClass, utility, rawReason) {
  const resourceKey = normalizeResourceId(resourceId);
  if (utility === true || resourceClass === "RAW_FULL") {
    const normalizedRawReason = utility === true
      ? "utility"
      : rawReason === "unknown-class-size"
        ? "unknown-class-size"
        : "explicit-raw";
    return {
      kind: "RAW_FULL",
      className: "RAW_FULL",
      resourceId,
      resourceKey,
      classified: resourceKey !== null,
      malformed: resourceKey === null,
      rawReason: normalizedRawReason,
    };
  }
  if (resourceKey !== null &&
      Object.hasOwn(WGPU_UBO_COMPUTE_CLASS_BYTES, resourceClass)) {
    return {
      kind: "CLASS",
      className: resourceClass,
      resourceId,
      resourceKey,
      classified: true,
      malformed: false,
    };
  }
  return {
    kind: "RAW_FULL",
    className: null,
    resourceId,
    resourceKey,
    classified: false,
    malformed: resourceKey === null || typeof resourceClass !== "string",
  };
}

function normalizeResourceId(resourceId) {
  if (typeof resourceId === "string" && resourceId.length > 0) {
    return `s:${resourceId}`;
  }
  if (typeof resourceId === "number" && Number.isSafeInteger(resourceId)) {
    return `n:${resourceId}`;
  }
  if (typeof resourceId === "bigint") return `b:${resourceId}`;
  return null;
}

function makeRecord({
  kind,
  identity,
  destinationOffset,
  sourceBytes,
  ranges,
  reconstructedBytes,
}) {
  return {
    kind,
    resourceId: identity.resourceId,
    resourceClass: identity.className,
    classifiedIdentity: identity.classified,
    destinationOffset,
    sourceBytes,
    payloadBytes: sumRangeBytes(ranges),
    ranges,
    reconstructedBytes,
  };
}

function changedRanges(previous, current) {
  const ranges = [];
  let rangeStart = -1;
  for (let offset = 0; offset < current.byteLength;
      offset += WGPU_UBO_COMPUTE_DIFF_GRANULARITY) {
    let changed = false;
    const end = Math.min(
      current.byteLength,
      offset + WGPU_UBO_COMPUTE_DIFF_GRANULARITY
    );
    for (let index = offset; index < end; index += 1) {
      if (previous[index] !== current[index]) {
        changed = true;
        break;
      }
    }
    if (changed && rangeStart < 0) rangeStart = offset;
    if (!changed && rangeStart >= 0) {
      ranges.push({ offset: rangeStart, bytes: current.slice(rangeStart, offset) });
      rangeStart = -1;
    }
  }
  if (rangeStart >= 0) {
    ranges.push({ offset: rangeStart, bytes: current.slice(rangeStart) });
  }
  return ranges;
}

function sumRangeBytes(ranges) {
  let total = 0;
  for (const range of ranges) total += range.bytes.byteLength;
  return total;
}

function copyBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes.slice();
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
  }
  return null;
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function positiveIntegerOr(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function positivePowerOfTwoOr(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 &&
    (number & (number - 1)) === 0 ? number : fallback;
}
