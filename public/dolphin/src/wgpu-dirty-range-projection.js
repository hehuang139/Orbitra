// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  WGPU_UPLOAD_ROLE,
  WGPU_UPLOAD_ROLE_NAMES,
} from "./wgpu-upload-attribution.js";

export const WGPU_DIRTY_RANGE_GAP_THRESHOLDS = Object.freeze([
  0,
  64,
  256,
  1024,
  4096,
]);

export function requestedWgpuDirtyRangeProjection(search = "") {
  return new URLSearchParams(search).get("wgpudirtyranges") === "1";
}

// This is projection-only telemetry. It describes how many destination ranges
// a future upload compactor might emit; it never changes upload ordering or GPU
// commands. Overlap and ordering counters identify segments that would require
// explicit last-write-wins materialization before such a compactor was safe.
export function createWgpuDirtyRangeProjection({
  gapThresholds = WGPU_DIRTY_RANGE_GAP_THRESHOLDS,
} = {}) {
  const thresholds = normalizeThresholds(gapThresholds);
  const finalizedProjection = createProjectionTotals(thresholds);
  const finalizedRoleProjection = WGPU_UPLOAD_ROLE_NAMES.map(
    () => createProjectionTotals(thresholds)
  );
  const rawByRole = WGPU_UPLOAD_ROLE_NAMES.map(() => ({ uploads: 0, bytes: 0 }));
  const boundaryKinds = Object.create(null);

  let ranges = [];
  let rangesByRole = WGPU_UPLOAD_ROLE_NAMES.map(() => []);
  let rawUploads = 0;
  let rawBytes = 0;
  let finalizedRawUploads = 0;
  let finalizedRawBytes = 0;
  let finalizedSegmentCount = 0;
  let completeSegmentCount = 0;
  let incompleteSegmentCount = 0;
  let emptyBoundaryCount = 0;
  let maxSegmentUploads = 0;
  let maxSegmentBytes = 0;
  let currentSegmentBytes = 0;
  let overlapUploadCount = 0;
  let overlapIntervalCount = 0;
  let overlapBytes = 0;
  let destinationOrderRegressionCount = 0;
  let sourceArenaWrapCount = 0;
  let sourceOutOfArenaCount = 0;
  let recordIndexWrapCount = 0;
  let recordOrderHazardCount = 0;
  const finalizedHazards = createHazardCounters();
  let lastSourceOffset = null;
  let lastRecordIndex = null;
  const lastDestinationByBuffer = new Map();
  const coveredIntervalsByBuffer = new Map();

  function recordUpload(upload = {}) {
    const bufferId = finiteInteger(upload.bufferId);
    const destinationOffset = finiteNonnegative(upload.destinationOffset);
    const bytes = finiteNonnegative(upload.bytes);
    const role = validRole(upload.role) ? upload.role : WGPU_UPLOAD_ROLE.UNKNOWN;
    const end = destinationOffset + bytes;

    rawUploads += 1;
    rawBytes += bytes;
    currentSegmentBytes += bytes;
    rawByRole[role].uploads += 1;
    rawByRole[role].bytes += bytes;

    const overlap = insertCoveredInterval(
      coveredIntervalsByBuffer,
      bufferId,
      destinationOffset,
      end
    );
    if (overlap.intervals > 0) overlapUploadCount += 1;
    overlapIntervalCount += overlap.intervals;
    overlapBytes += overlap.bytes;

    const priorDestination = lastDestinationByBuffer.get(bufferId);
    if (priorDestination !== undefined && destinationOffset < priorDestination) {
      destinationOrderRegressionCount += 1;
    }
    lastDestinationByBuffer.set(bufferId, destinationOffset);

    observeSource(
      upload.sourcePointer,
      upload.sourceBytes ?? bytes,
      upload.sourceArenaBase,
      upload.sourceArenaSize
    );
    observeRecordIndex(upload.recordIndex);
    const range = { bufferId, start: destinationOffset, end, role };
    ranges.push(range);
    rangesByRole[role].push(range);
  }

  function recordSegmentBoundary({ kind = "pass", complete = true } = {}) {
    const boundaryKind = String(kind || "pass");
    boundaryKinds[boundaryKind] = (boundaryKinds[boundaryKind] || 0) + 1;
    if (ranges.length === 0) {
      emptyBoundaryCount += 1;
      resetSegment();
      return false;
    }

    accumulateProjection(finalizedProjection, projectRanges(ranges, thresholds));
    for (let role = 0; role < WGPU_UPLOAD_ROLE_NAMES.length; role += 1) {
      accumulateProjection(
        finalizedRoleProjection[role],
        projectRanges(rangesByRole[role], thresholds)
      );
    }
    finalizedRawUploads += ranges.length;
    finalizedRawBytes += currentSegmentBytes;
    Object.assign(finalizedHazards, hazardSnapshot());
    finalizedSegmentCount += 1;
    if (complete) completeSegmentCount += 1;
    else incompleteSegmentCount += 1;
    maxSegmentUploads = Math.max(maxSegmentUploads, ranges.length);
    maxSegmentBytes = Math.max(maxSegmentBytes, currentSegmentBytes);
    resetSegment();
    return true;
  }

  function snapshot({ requested = false, active = requested } = {}) {
    const currentProjection = projectRanges(ranges, thresholds);
    const projection = cloneProjection(finalizedProjection);
    accumulateProjection(projection, currentProjection);
    const roles = rawByRole.map((raw, role) => {
      const projected = cloneProjection(finalizedRoleProjection[role]);
      accumulateProjection(
        projected,
        projectRanges(rangesByRole[role], thresholds)
      );
      return {
        role,
        roleName: WGPU_UPLOAD_ROLE_NAMES[role],
        raw: { ...raw },
        projection: projectionSnapshot(projected),
      };
    });
    return {
      schema: "wasm-dolphin.wgpu-dirty-range-projection.v1",
      requested: Boolean(requested),
      active: Boolean(active),
      enabled: Boolean(active),
      projectionOnly: true,
      gapThresholds: [...thresholds],
      raw: { uploads: rawUploads, bytes: rawBytes },
      finalized: {
        segmentCount: finalizedSegmentCount,
        raw: {
          uploads: finalizedRawUploads,
          bytes: finalizedRawBytes,
        },
        projection: projectionSnapshot(finalizedProjection),
        hazards: { ...finalizedHazards },
      },
      segments: {
        definition: "uploads-after-previous-boundary-through-pass-or-present-safe-boundary",
        finalized: finalizedSegmentCount,
        complete: completeSegmentCount,
        incomplete: incompleteSegmentCount,
        emptyBoundaries: emptyBoundaryCount,
        currentUploads: ranges.length,
        currentBytes: currentSegmentBytes,
        maxUploads: Math.max(maxSegmentUploads, ranges.length),
        maxBytes: Math.max(maxSegmentBytes, currentSegmentBytes),
        boundaryKinds: { ...boundaryKinds },
      },
      hazards: hazardSnapshot(),
      projection: projectionSnapshot(projection),
      roleProjectionAdditive: false,
      roleProjectionNote:
        "role rows are projected independently and do not add to cross-role merged totals",
      roles,
    };
  }

  function hazardSnapshot() {
    return {
      overlapUploadCount,
      overlapIntervalCount,
      overlapBytes,
      destinationOrderRegressionCount,
      sourceArenaWrapCount,
      sourceOutOfArenaCount,
      recordIndexWrapCount,
      recordOrderHazardCount,
    };
  }

  function observeSource(pointerValue, bytesValue, baseValue, sizeValue) {
    if (pointerValue === undefined || pointerValue === null) return;
    const pointer = finiteNonnegative(pointerValue);
    const bytes = finiteNonnegative(bytesValue);
    const base = finiteNonnegative(baseValue);
    const size = finiteNonnegative(sizeValue);
    const arenaEnd = base + size;
    const sourceEnd = pointer + bytes;
    if (size === 0 || !Number.isSafeInteger(arenaEnd) ||
        !Number.isSafeInteger(sourceEnd) || pointer < base || pointer >= arenaEnd ||
        sourceEnd > arenaEnd || sourceEnd < pointer) {
      sourceOutOfArenaCount += 1;
      lastSourceOffset = null;
      return;
    }
    const offset = pointer - base;
    if (lastSourceOffset !== null && offset < lastSourceOffset) {
      sourceArenaWrapCount += 1;
    }
    lastSourceOffset = offset;
  }

  function observeRecordIndex(indexValue) {
    if (indexValue === undefined || indexValue === null) return;
    const index = finiteInteger(indexValue) >>> 0;
    if (lastRecordIndex !== null) {
      const delta = (index - lastRecordIndex) >>> 0;
      if (delta === 0 || delta > 0x7fffffff) {
        recordOrderHazardCount += 1;
      } else if (index < lastRecordIndex) {
        recordIndexWrapCount += 1;
      }
    }
    lastRecordIndex = index;
  }

  function resetSegment() {
    ranges = [];
    rangesByRole = WGPU_UPLOAD_ROLE_NAMES.map(() => []);
    currentSegmentBytes = 0;
    lastSourceOffset = null;
    lastRecordIndex = null;
    lastDestinationByBuffer.clear();
    coveredIntervalsByBuffer.clear();
  }

  return { recordUpload, recordSegmentBoundary, snapshot };
}

function projectRanges(ranges, thresholds) {
  const totals = createProjectionTotals(thresholds);
  if (ranges.length === 0) return totals;
  const byBuffer = new Map();
  for (const range of ranges) {
    let list = byBuffer.get(range.bufferId);
    if (!list) {
      list = [];
      byBuffer.set(range.bufferId, list);
    }
    list.push(range);
  }
  for (const list of byBuffer.values()) {
    list.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let thresholdIndex = 0; thresholdIndex < thresholds.length; thresholdIndex += 1) {
      const gap = thresholds[thresholdIndex];
      let start = list[0].start;
      let end = list[0].end;
      for (let index = 1; index < list.length; index += 1) {
        const next = list[index];
        if (next.start <= end + gap) {
          end = Math.max(end, next.end);
        } else {
          totals.copies[thresholdIndex] += 1;
          totals.bytes[thresholdIndex] += Math.max(0, end - start);
          start = next.start;
          end = next.end;
        }
      }
      totals.copies[thresholdIndex] += 1;
      totals.bytes[thresholdIndex] += Math.max(0, end - start);
    }
  }
  return totals;
}

// Maintain a sorted, disjoint union per destination buffer. This makes the
// common sequential append O(log n) lookup + O(1) insertion and bounds overlap
// work by the number of union intervals consumed, rather than all prior
// uploads in the segment.
function insertCoveredInterval(intervalsByBuffer, bufferId, start, end) {
  if (end <= start) return { intervals: 0, bytes: 0 };
  let intervals = intervalsByBuffer.get(bufferId);
  if (!intervals) {
    intervals = [];
    intervalsByBuffer.set(bufferId, intervals);
  }

  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (intervals[middle].end < start) low = middle + 1;
    else high = middle;
  }

  const insertionIndex = low;
  let cursor = low;
  let mergedStart = start;
  let mergedEnd = end;
  let overlapIntervals = 0;
  let bytesOverlapped = 0;
  while (cursor < intervals.length && intervals[cursor].start <= mergedEnd) {
    const prior = intervals[cursor];
    const intersection = Math.min(end, prior.end) - Math.max(start, prior.start);
    if (intersection > 0) {
      overlapIntervals += 1;
      bytesOverlapped += intersection;
    }
    mergedStart = Math.min(mergedStart, prior.start);
    mergedEnd = Math.max(mergedEnd, prior.end);
    cursor += 1;
  }
  intervals.splice(
    insertionIndex,
    cursor - insertionIndex,
    { start: mergedStart, end: mergedEnd }
  );
  return { intervals: overlapIntervals, bytes: bytesOverlapped };
}

function createProjectionTotals(thresholds) {
  return {
    copies: new Float64Array(thresholds.length),
    bytes: new Float64Array(thresholds.length),
  };
}

function createHazardCounters() {
  return {
    overlapUploadCount: 0,
    overlapIntervalCount: 0,
    overlapBytes: 0,
    destinationOrderRegressionCount: 0,
    sourceArenaWrapCount: 0,
    sourceOutOfArenaCount: 0,
    recordIndexWrapCount: 0,
    recordOrderHazardCount: 0,
  };
}

function cloneProjection(projection) {
  return {
    copies: new Float64Array(projection.copies),
    bytes: new Float64Array(projection.bytes),
  };
}

function accumulateProjection(target, source) {
  for (let index = 0; index < target.copies.length; index += 1) {
    target.copies[index] += source.copies[index];
    target.bytes[index] += source.bytes[index];
  }
}

function projectionSnapshot(projection) {
  return {
    intervalCopiesByGap: Array.from(projection.copies),
    copiedBytesByGap: Array.from(projection.bytes),
  };
}

function normalizeThresholds(values) {
  const normalized = [...new Set(
    Array.from(values, (value) => Math.floor(finiteNonnegative(value)))
  )].sort((left, right) => left - right);
  return Object.freeze(normalized.length > 0 ? normalized : [0]);
}

function validRole(role) {
  return Number.isInteger(role) && role >= 0 && role < WGPU_UPLOAD_ROLE_NAMES.length;
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
