// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_PASS_PACKAGE_PROJECTION_SCHEMA =
  "wasm-dolphin.wgpu-pass-package-projection.v1";

export const WGPU_PASS_PACKAGE_OP = Object.freeze({
  NOP: 0,
  CLEAR: 1,
  CREATE_SHADER: 2,
  CREATE_PIPELINE: 3,
  DRAW_TEST: 4,
  CREATE_BUFFER: 5,
  UPLOAD_BUFFER: 6,
  CREATE_TEXTURE: 7,
  UPLOAD_TEXTURE: 8,
  CREATE_PIPELINE_CFG: 9,
  CREATE_SAMPLER: 10,
  CREATE_BIND_GROUP: 11,
  BEGIN_PASS: 12,
  SET_PIPELINE: 13,
  SET_BIND_GROUP: 14,
  SET_VERTEX_BUFFER: 15,
  SET_INDEX_BUFFER: 16,
  SET_VIEWPORT: 17,
  SET_SCISSOR: 18,
  DRAW: 19,
  DRAW_INDEXED: 20,
  END_PASS: 21,
  SUBMIT_PRESENT: 22,
  DESTROY: 23,
  BLIT_TEXTURE: 24,
});

const KNOWN_OP_COUNT = 25;
const DEFAULT_RECENT_PACKAGE_LIMIT = 32;
const LEGACY_RECORD_BYTES = 32;
const RESOURCE_OPS = new Set([2, 3, 5, 7, 9, 10, 11, 23]);
const UPLOAD_OPS = new Set([6, 8]);
const PASS_STATE_OPS = new Set([13, 14, 15, 16, 17, 18, 19, 20]);

export function requestedWgpuPassPackageProjection(search = "") {
  return new URLSearchParams(search).get("wgpupackageprojection") === "1";
}

// Passive projection over records that the legacy consumer has already
// accepted. This module owns no transport or renderer objects and cannot
// affect replay, publication, resource lifetime, or payload storage.
export function createWgpuPassPackageProjection({
  recentPackageLimit = DEFAULT_RECENT_PACKAGE_LIMIT,
} = {}) {
  const recentLimit = clampRecentLimit(recentPackageLimit);
  const opHistogram = new Float64Array(KNOWN_OP_COUNT);
  const unsupportedOpHistogram = Object.create(null);
  const recentPackages = [];
  const resetKinds = Object.create(null);
  let lifecycleEpoch = 0;
  let submissionEpoch = 0;
  let observedRecords = 0;
  let observedRecordBytes = 0;
  let legacyPublications = 0;
  let projectedRecords = 0;
  let projectedPublications = 0;
  let completePassPackages = 0;
  let outsideSegments = 0;
  let uploadRecordCount = 0;
  let uploadBytes = 0;
  let resourceRecordCount = 0;
  let unsupportedRecordCount = 0;
  let malformedRecordCount = 0;
  let nestedPassCount = 0;
  let stateOutsidePassCount = 0;
  let unresolvedPrePassUploadCount = 0;
  let unresolvedOutsideResourceCount = 0;
  let incompletePassCount = 0;
  let resetCount = 0;
  let maxPackageRecords = 0;
  let maxLegacyRecordBytesInSegment = 0;
  let packageSequence = 0;
  let currentPass = null;
  let currentOutside = null;
  let pendingPrePassUploadCount = 0;
  let pendingOutsideResourceCount = 0;

  function observeConsumedRecord(opValue, recordIndexValue, payloadBytesValue = 0) {
    const opNumber = Number(opValue);
    const recordIndexNumber = Number(recordIndexValue);
    const payloadNumber = Number(payloadBytesValue);
    const op = Number.isInteger(opNumber) && opNumber >= 0 ? opNumber : 0xffffffff;
    const recordIndex = Number.isInteger(recordIndexNumber) && recordIndexNumber >= 0
      ? recordIndexNumber >>> 0
      : 0;
    const payloadBytes = Number.isFinite(payloadNumber) && payloadNumber > 0
      ? Math.floor(payloadNumber)
      : 0;
    const known = op < KNOWN_OP_COUNT;
    const valid = Number.isInteger(opNumber) && opNumber >= 0 &&
      Number.isInteger(recordIndexNumber) && recordIndexNumber >= 0;
    observedRecords += 1;
    observedRecordBytes += LEGACY_RECORD_BYTES;
    if (!valid) malformedRecordCount += 1;
    if (known) opHistogram[op] += 1;
    else {
      unsupportedRecordCount += 1;
      const key = String(op);
      unsupportedOpHistogram[key] = (unsupportedOpHistogram[key] || 0) + 1;
    }
    const upload = UPLOAD_OPS.has(op);
    const resource = RESOURCE_OPS.has(op);
    if (upload) {
      uploadRecordCount += 1;
      uploadBytes += payloadBytes;
    }
    if (resource) resourceRecordCount += 1;

    if (op === WGPU_PASS_PACKAGE_OP.BEGIN_PASS) {
      flushOutside("begin-pass");
      // PushBatch publishes the atomic pass at BEGIN_PASS. A consumer can
      // observe an open pass only after that one producer publication.
      legacyPublications += 1;
      if (currentPass) {
        nestedPassCount += 1;
        incompletePassCount += 1;
        retainPackage(finalizePackage(currentPass, "incomplete-nested"));
      }
      // A preceding upload is visible to this consumer, but BEGIN_PASS does
      // not prove which producer transaction owned it. Preserve that as an
      // unresolved hazard instead of manufacturing an ownership edge.
      unresolvedPrePassUploadCount += pendingPrePassUploadCount;
      unresolvedOutsideResourceCount += pendingOutsideResourceCount;
      pendingPrePassUploadCount = 0;
      pendingOutsideResourceCount = 0;
      currentPass = createPackage("pass", op, recordIndex, payloadBytes, known, valid);
      return;
    }

    if (op === WGPU_PASS_PACKAGE_OP.END_PASS) {
      if (!currentPass) {
        malformedRecordCount += 1;
        legacyPublications += 1;
        appendOutside(op, recordIndex, payloadBytes, known, valid);
        flushOutside("orphan-end-pass");
        return;
      }
      appendRecord(currentPass, op, recordIndex, payloadBytes, known, valid);
      completePassPackages += 1;
      retainPackage(finalizePackage(currentPass, "complete"));
      currentPass = null;
      return;
    }

    if (currentPass) {
      appendRecord(currentPass, op, recordIndex, payloadBytes, known, valid);
      return;
    }

    if (PASS_STATE_OPS.has(op)) stateOutsidePassCount += 1;
    if (upload) pendingPrePassUploadCount += 1;
    if (resource) pendingOutsideResourceCount += 1;
    // Records outside a producer PushBatch are individually published.
    legacyPublications += 1;
    appendOutside(op, recordIndex, payloadBytes, known, valid);
    if (op === WGPU_PASS_PACKAGE_OP.SUBMIT_PRESENT) {
      flushOutside("submit-present");
      submissionEpoch += 1;
    }
  }

  function reset(kind = "reset") {
    const normalizedKind = String(kind || "reset");
    flushOutside(normalizedKind);
    if (currentPass) {
      incompletePassCount += 1;
      retainPackage(finalizePackage(currentPass, `incomplete-${normalizedKind}`));
      currentPass = null;
    }
    unresolvedPrePassUploadCount += pendingPrePassUploadCount;
    unresolvedOutsideResourceCount += pendingOutsideResourceCount;
    pendingPrePassUploadCount = 0;
    pendingOutsideResourceCount = 0;
    lifecycleEpoch += 1;
    submissionEpoch = 0;
    resetCount += 1;
    resetKinds[normalizedKind] = (resetKinds[normalizedKind] || 0) + 1;
  }

  function snapshot({ requested = false, active = requested } = {}) {
    const openPassRecords = currentPass?.recordCount ?? 0;
    const openOutsideRecords = currentOutside?.recordCount ?? 0;
    return {
      schema: WGPU_PASS_PACKAGE_PROJECTION_SCHEMA,
      requested: Boolean(requested),
      active: Boolean(active),
      enabled: Boolean(active),
      projectionOnly: true,
      replayBehaviorChanged: false,
      runtimeEligible: false,
      payloadByteProof: "unavailable",
      lifecycleDigestProof: "unavailable",
      drawObservableDigestProof: "unavailable",
      limitations: [
        "payload bytes are neither copied nor hashed",
        "resource generations and draw-observable state are not proven",
        "consumer-only observation cannot prove unpublished producer aborts",
      ],
      epochs: { lifecycle: lifecycleEpoch, submission: submissionEpoch },
      legacy: {
        records: observedRecords,
        recordBytes: observedRecordBytes,
        publications: legacyPublications,
        publicationModel:
          "complete BeginPass-through-EndPass batch once; outside records individually",
      },
      projected: {
        kind: "safe-records-only",
        records: legacyPublications,
        publications: legacyPublications,
        recordReduction: Math.max(0, observedRecords - legacyPublications),
        publicationReduction: 0,
        publicationReductionClaimed: false,
        preservesObservedPublicationBoundaries: true,
        completePassPackages,
        outsideSegments,
        maxPackageRecords: Math.max(maxPackageRecords, openPassRecords, openOutsideRecords),
        maxLegacyRecordBytesInSegment: Math.max(
          maxLegacyRecordBytesInSegment,
          openPassRecords * LEGACY_RECORD_BYTES,
          openOutsideRecords * LEGACY_RECORD_BYTES
        ),
        maxLegacyRecordBytesInSegmentIsLowerBound: true,
        packageCapacityEvidence: false,
      },
      speculativeFullEnvelope: {
        unsafe: true,
        runtimeEligible: false,
        records: projectedRecords + (openPassRecords > 0 ? 1 : 0) +
          (openOutsideRecords > 0 ? 1 : 0),
        publications: projectedPublications + (openPassRecords > 0 ? 1 : 0) +
          (openOutsideRecords > 0 ? 1 : 0),
        publicationReductionEstimate: Math.max(
          0,
          legacyPublications - projectedPublications -
            (openPassRecords > 0 ? 1 : 0) - (openOutsideRecords > 0 ? 1 : 0)
        ),
        publicationReductionClaimed: false,
        reason:
          "outside-record grouping crosses unproven producer transaction ownership",
      },
      records: {
        uploads: uploadRecordCount,
        uploadBytes,
        resources: resourceRecordCount,
        unsupported: unsupportedRecordCount,
        malformed: malformedRecordCount,
        nestedPasses: nestedPassCount,
        stateOutsidePass: stateOutsidePassCount,
      },
      ownership: {
        pendingPrePassUploads: pendingPrePassUploadCount,
        resolvedPrePassUploads: 0,
        unresolvedPrePassUploads: unresolvedPrePassUploadCount,
        pendingOutsideResources: pendingOutsideResourceCount,
        resolvedOutsideResources: 0,
        unresolvedOutsideResources: unresolvedOutsideResourceCount,
      },
      boundaries: {
        incompletePasses: incompletePassCount,
        resets: resetCount,
        resetKinds: { ...resetKinds },
      },
      opHistogram: Array.from(opHistogram),
      unsupportedOpHistogram: { ...unsupportedOpHistogram },
      recentPackageLimit: recentLimit,
      recentPackages: recentPackages.map((item) => ({ ...item })),
    };
  }

  function appendOutside(op, recordIndex, payloadBytes, known, valid) {
    if (!currentOutside) {
      currentOutside = createPackage(
        "outside", op, recordIndex, payloadBytes, known, valid
      );
    } else {
      appendRecord(currentOutside, op, recordIndex, payloadBytes, known, valid);
    }
  }

  function flushOutside(reason) {
    if (!currentOutside) return;
    outsideSegments += 1;
    retainPackage(finalizePackage(currentOutside, reason));
    currentOutside = null;
  }

  function retainPackage(pkg) {
    projectedRecords += 1;
    projectedPublications += 1;
    maxPackageRecords = Math.max(maxPackageRecords, pkg.recordCount);
    maxLegacyRecordBytesInSegment = Math.max(
      maxLegacyRecordBytesInSegment,
      pkg.legacyRecordBytes
    );
    recentPackages.push(pkg);
    if (recentPackages.length > recentLimit) recentPackages.shift();
  }

  function createPackage(kind, op, recordIndex, payloadBytes, known, valid) {
    const pkg = {
      sequence: ++packageSequence,
      kind,
      lifecycleEpoch,
      submissionEpoch,
      firstRecordIndex: recordIndex,
      lastRecordIndex: recordIndex,
      recordCount: 0,
      uploadRecords: 0,
      uploadBytes: 0,
      resourceRecords: 0,
      unsupportedRecords: 0,
      malformedRecords: 0,
      ownedPrePassUploadRecords: 0,
    };
    appendRecord(pkg, op, recordIndex, payloadBytes, known, valid);
    return pkg;
  }

  return { observeConsumedRecord, reset, snapshot };
}

function appendRecord(pkg, op, recordIndex, payloadBytes, known, valid) {
  pkg.recordCount += 1;
  pkg.lastRecordIndex = recordIndex;
  if (UPLOAD_OPS.has(op)) {
    pkg.uploadRecords += 1;
    pkg.uploadBytes += payloadBytes;
  }
  if (RESOURCE_OPS.has(op)) pkg.resourceRecords += 1;
  if (!known) pkg.unsupportedRecords += 1;
  if (!valid) pkg.malformedRecords += 1;
}

function finalizePackage(pkg, disposition) {
  return {
    ...pkg,
    disposition,
    legacyRecordBytes: pkg.recordCount * LEGACY_RECORD_BYTES,
  };
}

function clampRecentLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_RECENT_PACKAGE_LIMIT;
  return Math.min(256, Math.max(1, Math.floor(number)));
}
