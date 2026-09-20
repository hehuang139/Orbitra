// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

const COPY_ALIGNMENT = 4;
const TEXTURE_ROW_ALIGNMENT = 256;
const RECORD_KIND_BUFFER = 0;
const RECORD_KIND_TEXTURE = 1;
const RECORD_KIND_BUFFER_SNAPSHOT = 2;
const REMAP_LATENCY_BUCKET_BOUNDS_MS = Object.freeze([
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000,
]);

export function createWgpuMappedStagingPool({
  device,
  slotCount = 3,
  slotSize,
  bufferUsage = resolveBufferUsage(),
  mapMode = resolveMapWriteMode(),
  watchDeviceLoss = true,
  flatRecords = false,
  now = () => globalThis.performance.now(),
} = {}) {
  if (!device?.createBuffer || !device?.createCommandEncoder) {
    throw new TypeError("device must provide WebGPU buffer and encoder creation");
  }
  if (!isPositiveInteger(slotCount)) {
    throw new RangeError("slotCount must be a positive integer");
  }
  if (!isPositiveInteger(slotSize) || slotSize % COPY_ALIGNMENT !== 0) {
    throw new RangeError("slotSize must be a positive multiple of 4");
  }
  if (!Number.isSafeInteger(slotCount * slotSize)) {
    throw new RangeError("combined staging capacity must be a safe integer");
  }
  if (!isNonnegativeInteger(bufferUsage) || !isNonnegativeInteger(mapMode)) {
    throw new TypeError("bufferUsage and mapMode must be numeric WebGPU flags");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const owner = Symbol("wgpu-mapped-staging-pool");
  const useFlatRecords = Boolean(flatRecords);
  const slots = Array.from({ length: slotCount }, (_, id) => {
    const buffer = device.createBuffer({
      label: `Dolphin mapped upload staging ${id}`,
      size: slotSize,
      usage: bufferUsage,
      mappedAtCreation: true,
    });
    return {
      id,
      buffer,
      mappedBytes: new Uint8Array(buffer.getMappedRange()),
      cursor: 0,
      records: useFlatRecords ? null : [],
      flatRecords: useFlatRecords ? createFlatRecordStore() : null,
      firstRecordAtMs: 0,
      state: "mapped",
      epoch: 0,
    };
  });

  let failed = false;
  let lastError = null;
  let nextBatchId = 1;
  let nextRecordSequence = 1;
  let lastRecordSequenceStaged = 0;
  let flatRecordHighWater = 0;
  let flatRecordResetCount = 0;
  const activeBatches = new Set();
  const metrics = {
    bufferUploads: 0,
    bufferUploadsCoalesced: 0,
    bufferSnapshotUploads: 0,
    bufferSnapshotSparseUploads: 0,
    bufferSnapshotFullUploads: 0,
    bufferSnapshotEqualUploads: 0,
    bufferSnapshotCopyForwardBytes: 0,
    bufferSnapshotOverlayRanges: 0,
    bufferSnapshotOverlayBytes: 0,
    bufferSnapshotAvoidedStagedBytes: 0,
    textureUploads: 0,
    copyCommandsEncoded: 0,
    logicalBytes: 0,
    stagedBytes: 0,
    capacityMisses: 0,
    oversizedMisses: 0,
    capacityMissesNoMappedSlots: 0,
    capacityMissesMappedSlotsFull: 0,
    batchesSealed: 0,
    batchesSubmitted: 0,
    sealedSlotCountTotal: 0,
    sealedBytesTotal: 0,
    sealedBytesMax: 0,
    sealedRecordsTotal: 0,
    sealedRecordsMax: 0,
    remapsStarted: 0,
    remapsCompleted: 0,
    remapFailures: 0,
    remapLatencyTotalMs: 0,
    remapLatencyMaxMs: 0,
    remapLatencyHistogram: new Array(REMAP_LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0),
    invalidations: 0,
  };

  function stageBuffer({ data, destination, destinationOffset = 0, alignment = 4 } = {}) {
    return stageBufferBytes(viewBytes(data), destination, destinationOffset, alignment, false);
  }

  function stageBufferFast(data, destination, destinationOffset = 0, alignment = 4) {
    return stageBufferBytes(viewBytes(data, true), destination, destinationOffset, alignment, true);
  }


  function stageBufferBytes(bytes, destination, destinationOffset, alignment, fast) {
    if (!bytes || !destination) throw new TypeError("buffer upload needs data and destination");
    if (!isNonnegativeInteger(destinationOffset) || destinationOffset % COPY_ALIGNMENT !== 0 ||
        bytes.byteLength === 0 || bytes.byteLength % COPY_ALIGNMENT !== 0) {
      throw new RangeError("buffer copy offsets and byte lengths must be positive multiples of 4");
    }
    const sourceAlignment = combinedAlignment(COPY_ALIGNMENT, alignment);
    let slot;
    let offset;
    if (fast) {
      const token = allocateFast(bytes.byteLength, sourceAlignment);
      if (typeof token === "string") return token;
      slot = slots[Math.floor(token / slotSize)];
      offset = token % slotSize;
    } else {
      const allocation = allocate(bytes.byteLength, sourceAlignment);
      if (!allocation.ok) return allocation;
      slot = allocation.slot;
      offset = allocation.offset;
    }

    slot.mappedBytes.set(bytes, offset);
    if (recordCount(slot) === 0) slot.firstRecordAtMs = now();
    const recordSequence = nextRecordSequence++;
    if (appendBufferRecord(
      slot,
      recordSequence,
      offset,
      bytes.byteLength,
      destination,
      destinationOffset
    )) {
      metrics.bufferUploadsCoalesced += 1;
    } else {
      metrics.copyCommandsEncoded += 1;
    }
    lastRecordSequenceStaged = recordSequence;
    metrics.bufferUploads += 1;
    metrics.logicalBytes += bytes.byteLength;
    metrics.stagedBytes += bytes.byteLength;
    return fast ? null : success(slot, offset, bytes.byteLength, bytes.byteLength);
  }

  function stageTexture({
    data,
    destination,
    copySize,
    sourceBytesPerRow,
    sourceRowsPerImage = copySize?.height,
    origin,
    mipLevel,
    aspect,
  } = {}) {
    return stageTextureBytes(
      viewBytes(data),
      destination,
      copySize,
      sourceBytesPerRow,
      sourceRowsPerImage,
      origin,
      mipLevel,
      aspect,
      false
    );
  }

  function stageBufferSnapshot({
    data,
    destination,
    destinationOffset = 0,
    shadowBuffer,
    ranges,
    copyForward = false,
  } = {}) {
    const bytes = viewBytes(data, true);
    if (!bytes || !destination || !shadowBuffer) {
      throw new TypeError("buffer snapshot needs data, destination, and shadow buffer");
    }
    if (destination === shadowBuffer) {
      throw new RangeError("buffer snapshot source and destination buffers must be distinct");
    }
    if (!isNonnegativeInteger(destinationOffset) || destinationOffset % COPY_ALIGNMENT !== 0 ||
        bytes.byteLength === 0 || bytes.byteLength % COPY_ALIGNMENT !== 0 ||
        !Array.isArray(ranges)) {
      throw new RangeError("buffer snapshot layout must use positive four-byte alignment");
    }

    let stagedBytes = 0;
    let previousEnd = 0;
    const plannedRanges = [];
    for (const range of ranges) {
      const start = range?.start;
      const end = range?.end;
      if (!isNonnegativeInteger(start) || !isPositiveInteger(end) ||
          start % COPY_ALIGNMENT !== 0 || end % COPY_ALIGNMENT !== 0 ||
          start < previousEnd || end <= start || end > bytes.byteLength) {
        throw new RangeError("buffer snapshot ranges must be ordered, disjoint, and four-byte aligned");
      }
      const size = end - start;
      if (!Number.isSafeInteger(stagedBytes + size)) {
        throw new RangeError("buffer snapshot staging size overflow");
      }
      plannedRanges.push({ start, end, size, packedOffset: stagedBytes });
      stagedBytes += size;
      previousEnd = end;
    }
    if (!copyForward &&
        (plannedRanges.length !== 1 || plannedRanges[0].start !== 0 ||
         plannedRanges[0].end !== bytes.byteLength)) {
      throw new RangeError("a full snapshot must stage the complete source payload");
    }

    if (failed) return miss("pool-failed", false);
    if (stagedBytes > slotSize) return miss("payload-too-large", true);
    let slot = null;
    let offset = 0;
    for (const candidate of slots) {
      if (candidate.state !== "mapped") continue;
      const candidateOffset = alignUp(candidate.cursor, COPY_ALIGNMENT);
      if (candidateOffset + stagedBytes > slotSize) continue;
      slot = candidate;
      offset = candidateOffset;
      break;
    }
    if (!slot) return miss("no-capacity", false);

    for (const range of plannedRanges) {
      slot.mappedBytes.set(
        bytes.subarray(range.start, range.end),
        offset + range.packedOffset
      );
    }
    slot.cursor = offset + stagedBytes;
    if (recordCount(slot) === 0) slot.firstRecordAtMs = now();
    const recordSequence = nextRecordSequence++;
    appendBufferSnapshotRecord(
      slot,
      recordSequence,
      offset,
      bytes.byteLength,
      destination,
      destinationOffset,
      shadowBuffer,
      Boolean(copyForward),
      plannedRanges
    );
    lastRecordSequenceStaged = recordSequence;

    const copyCommands = (copyForward ? 1 : 0) + plannedRanges.length * 2;
    metrics.bufferUploads += 1;
    metrics.bufferSnapshotUploads += 1;
    metrics.bufferSnapshotSparseUploads += copyForward ? 1 : 0;
    metrics.bufferSnapshotFullUploads += copyForward ? 0 : 1;
    metrics.bufferSnapshotEqualUploads += copyForward && plannedRanges.length === 0 ? 1 : 0;
    metrics.bufferSnapshotCopyForwardBytes += copyForward ? bytes.byteLength : 0;
    metrics.bufferSnapshotOverlayRanges += plannedRanges.length;
    metrics.bufferSnapshotOverlayBytes += stagedBytes;
    metrics.bufferSnapshotAvoidedStagedBytes += Math.max(0, bytes.byteLength - stagedBytes);
    metrics.copyCommandsEncoded += copyCommands;
    metrics.logicalBytes += bytes.byteLength;
    metrics.stagedBytes += stagedBytes;
    return success(slot, offset, bytes.byteLength, stagedBytes);
  }

  function stageTextureFast(
    data,
    destination,
    copySize,
    sourceBytesPerRow,
    sourceRowsPerImage = copySize?.height,
    origin,
    mipLevel,
    aspect
  ) {
    return stageTextureBytes(
      viewBytes(data, true),
      destination,
      copySize,
      sourceBytesPerRow,
      sourceRowsPerImage,
      origin,
      mipLevel,
      aspect,
      true
    );
  }

  function stageTextureBytes(
    bytes,
    destination,
    copySize,
    sourceBytesPerRow,
    sourceRowsPerImage,
    origin,
    mipLevel,
    aspect,
    fast
  ) {
    const width = copySize?.width;
    const height = copySize?.height;
    const depthOrArrayLayers = copySize?.depthOrArrayLayers ?? 1;
    if (!bytes || !destination) throw new TypeError("texture upload needs data and destination");
    if (!isPositiveInteger(width) || !isPositiveInteger(height) ||
        !isPositiveInteger(depthOrArrayLayers) || !isPositiveInteger(sourceBytesPerRow) ||
        !isPositiveInteger(sourceRowsPerImage) || sourceRowsPerImage < height) {
      throw new RangeError("texture copy dimensions and source row layout must be positive");
    }

    const sourceSliceBytes = sourceBytesPerRow * sourceRowsPerImage;
    const requiredSourceBytes = sourceSliceBytes * (depthOrArrayLayers - 1) +
      sourceBytesPerRow * height;
    if (!Number.isSafeInteger(requiredSourceBytes) || bytes.byteLength < requiredSourceBytes) {
      throw new RangeError("texture source does not contain every requested row");
    }
    const packedBytesPerRow = alignUp(sourceBytesPerRow, TEXTURE_ROW_ALIGNMENT);
    const packedSize = packedBytesPerRow * height * depthOrArrayLayers;
    if (!Number.isSafeInteger(packedSize)) throw new RangeError("texture staging size overflow");
    let slot;
    let offset;
    if (fast) {
      const token = allocateFast(packedSize, TEXTURE_ROW_ALIGNMENT);
      if (typeof token === "string") return token;
      slot = slots[Math.floor(token / slotSize)];
      offset = token % slotSize;
    } else {
      const allocation = allocate(packedSize, TEXTURE_ROW_ALIGNMENT);
      if (!allocation.ok) return allocation;
      slot = allocation.slot;
      offset = allocation.offset;
    }

    for (let layer = 0; layer < depthOrArrayLayers; layer += 1) {
      for (let row = 0; row < height; row += 1) {
        const sourceOffset = layer * sourceSliceBytes + row * sourceBytesPerRow;
        const targetOffset = offset +
          (layer * height + row) * packedBytesPerRow;
        slot.mappedBytes.set(
          bytes.subarray(sourceOffset, sourceOffset + sourceBytesPerRow),
          targetOffset
        );
      }
    }

    if (recordCount(slot) === 0) slot.firstRecordAtMs = now();
    const recordSequence = nextRecordSequence++;
    appendTextureRecord(
      slot,
      recordSequence,
      offset,
      packedBytesPerRow,
      height,
      destination,
      origin,
      mipLevel,
      aspect,
      { width, height, depthOrArrayLayers }
    );
    lastRecordSequenceStaged = recordSequence;
    metrics.textureUploads += 1;
    metrics.copyCommandsEncoded += 1;
    metrics.logicalBytes += sourceBytesPerRow * height * depthOrArrayLayers;
    metrics.stagedBytes += packedSize;
    return fast
      ? null
      : success(
          slot,
          offset,
          sourceBytesPerRow * height * depthOrArrayLayers,
          packedSize
        );
  }

  function recordCount(slot) {
    return useFlatRecords ? slot.flatRecords.count : slot.records.length;
  }

  function appendBufferRecord(
    slot,
    sequence,
    sourceOffset,
    size,
    destination,
    destinationOffset
  ) {
    if (!useFlatRecords) {
      const previous = slot.records.at(-1);
      if (previous?.kind === "buffer" && previous.destination === destination &&
          previous.sequenceEnd === lastRecordSequenceStaged &&
          previous.sourceOffset + previous.size === sourceOffset &&
          previous.destinationOffset + previous.size === destinationOffset) {
        previous.size += size;
        previous.sequenceEnd = sequence;
        return true;
      }
      slot.records.push({
        kind: "buffer",
        sequenceStart: sequence,
        sequenceEnd: sequence,
        sourceOffset,
        size,
        destination,
        destinationOffset,
      });
      return false;
    }

    const records = slot.flatRecords;
    const previous = records.count - 1;
    if (previous >= 0 && records.kinds[previous] === RECORD_KIND_BUFFER &&
        records.destinations[previous] === destination &&
        records.sequenceEnds[previous] === lastRecordSequenceStaged &&
        records.sourceOffsets[previous] + records.sizes[previous] === sourceOffset &&
        records.destinationOffsets[previous] + records.sizes[previous] === destinationOffset) {
      records.sizes[previous] += size;
      records.sequenceEnds[previous] = sequence;
      return true;
    }
    const index = records.count;
    records.kinds[index] = RECORD_KIND_BUFFER;
    records.sequenceStarts[index] = sequence;
    records.sequenceEnds[index] = sequence;
    records.sourceOffsets[index] = sourceOffset;
    records.sizes[index] = size;
    records.destinations[index] = destination;
    records.destinationOffsets[index] = destinationOffset;
    records.count += 1;
    flatRecordHighWater = Math.max(flatRecordHighWater, records.count);
    return false;
  }

  function appendTextureRecord(
    slot,
    sequence,
    sourceOffset,
    bytesPerRow,
    rowsPerImage,
    destination,
    origin,
    mipLevel,
    aspect,
    copySize
  ) {
    if (!useFlatRecords) {
      slot.records.push({
        kind: "texture",
        sequenceStart: sequence,
        sequenceEnd: sequence,
        sourceOffset,
        bytesPerRow,
        rowsPerImage,
        destination,
        origin,
        mipLevel,
        aspect,
        copySize,
      });
      return;
    }
    const records = slot.flatRecords;
    const index = records.count;
    records.kinds[index] = RECORD_KIND_TEXTURE;
    records.sequenceStarts[index] = sequence;
    records.sequenceEnds[index] = sequence;
    records.sourceOffsets[index] = sourceOffset;
    records.sizes[index] = bytesPerRow;
    records.rowsPerImage[index] = rowsPerImage;
    records.destinations[index] = destination;
    records.origins[index] = origin;
    records.mipLevels[index] = mipLevel;
    records.aspects[index] = aspect;
    records.copySizes[index] = copySize;
    records.count += 1;
    flatRecordHighWater = Math.max(flatRecordHighWater, records.count);
  }

  function appendBufferSnapshotRecord(
    slot,
    sequence,
    sourceOffset,
    size,
    destination,
    destinationOffset,
    shadowBuffer,
    copyForward,
    ranges
  ) {
    if (!useFlatRecords) {
      slot.records.push({
        kind: "buffer-snapshot",
        sequenceStart: sequence,
        sequenceEnd: sequence,
        sourceOffset,
        size,
        destination,
        destinationOffset,
        shadowBuffer,
        copyForward,
        ranges,
      });
      return;
    }
    const records = slot.flatRecords;
    const index = records.count;
    records.kinds[index] = RECORD_KIND_BUFFER_SNAPSHOT;
    records.sequenceStarts[index] = sequence;
    records.sequenceEnds[index] = sequence;
    records.sourceOffsets[index] = sourceOffset;
    records.sizes[index] = size;
    records.destinations[index] = destination;
    records.destinationOffsets[index] = destinationOffset;
    records.shadowBuffers[index] = shadowBuffer;
    records.copyForwards[index] = copyForward;
    records.snapshotRanges[index] = ranges;
    records.count += 1;
    flatRecordHighWater = Math.max(flatRecordHighWater, records.count);
  }

  function encodeFlatRecordsInSequence(encoder, batchSlots) {
    const cursors = new Array(batchSlots.length).fill(0);
    let remaining = batchSlots.reduce((total, slot) => total + recordCount(slot), 0);
    while (remaining > 0) {
      let selected = -1;
      let selectedSequence = Number.POSITIVE_INFINITY;
      for (let slotIndex = 0; slotIndex < batchSlots.length; slotIndex += 1) {
        const records = batchSlots[slotIndex].flatRecords;
        const recordIndex = cursors[slotIndex];
        if (recordIndex >= records.count) continue;
        const sequence = records.sequenceStarts[recordIndex];
        if (sequence < selectedSequence) {
          selected = slotIndex;
          selectedSequence = sequence;
        }
      }
      if (selected < 0) throw new Error("flat mapped records lost global sequence order");
      const slot = batchSlots[selected];
      encodeFlatRecord(encoder, slot.buffer, slot.flatRecords, cursors[selected]);
      cursors[selected] += 1;
      remaining -= 1;
    }
  }

  function clearSlotRecords(slot) {
    if (!useFlatRecords) {
      slot.records = [];
      return;
    }
    const records = slot.flatRecords;
    if (records.count > 0) flatRecordResetCount += 1;
    records.destinations.fill(undefined, 0, records.count);
    records.origins.fill(undefined, 0, records.count);
    records.aspects.fill(undefined, 0, records.count);
    records.copySizes.fill(undefined, 0, records.count);
    records.shadowBuffers.fill(undefined, 0, records.count);
    records.snapshotRanges.fill(undefined, 0, records.count);
    records.count = 0;
  }

  function seal() {
    assertUsable();
    const batchSlots = slots.filter((slot) => slot.state === "mapped" && recordCount(slot) > 0);
    if (batchSlots.length === 0) return null;

    const encoder = device.createCommandEncoder({ label: "Dolphin mapped staging uploads" });
    try {
      const sealedBytes = batchSlots.reduce((total, slot) => total + slot.cursor, 0);
      const sealedRecords = batchSlots.reduce((total, slot) => total + recordCount(slot), 0);
      const oldestPendingAtMs = Math.min(...batchSlots.map((slot) => slot.firstRecordAtMs));
      const orderedRecords = useFlatRecords ? null : batchSlots.flatMap((slot) =>
        slot.records.map((record) => ({ slot, record }))
      ).sort((left, right) => left.record.sequenceStart - right.record.sequenceStart);
      for (const slot of batchSlots) {
        slot.buffer.unmap();
        slot.mappedBytes = null;
        slot.state = "sealed";
      }
      if (useFlatRecords) {
        encodeFlatRecordsInSequence(encoder, batchSlots);
      } else {
        for (const { slot, record } of orderedRecords) {
          encodeRecord(encoder, slot.buffer, record);
        }
      }
      const batch = Object.freeze({
        owner,
        id: nextBatchId,
        slots: Object.freeze(batchSlots.slice()),
        commandBuffer: encoder.finish(),
        oldestPendingAtMs,
      });
      nextBatchId += 1;
      activeBatches.add(batch);
      metrics.batchesSealed += 1;
      metrics.sealedSlotCountTotal += batchSlots.length;
      metrics.sealedBytesTotal += sealedBytes;
      metrics.sealedBytesMax = Math.max(metrics.sealedBytesMax, sealedBytes);
      metrics.sealedRecordsTotal += sealedRecords;
      metrics.sealedRecordsMax = Math.max(metrics.sealedRecordsMax, sealedRecords);
      return batch;
    } catch (error) {
      invalidate(error);
      throw error;
    }
  }

  function acceptSubmission(batch) {
    requireActiveBatch(batch);
    activeBatches.delete(batch);
    metrics.batchesSubmitted += 1;
    const generation = batch.id;
    const remaps = batch.slots.map((slot) => {
      const remapStartedAt = now();
      slot.state = "remapping";
      clearSlotRecords(slot);
      slot.firstRecordAtMs = 0;
      slot.cursor = 0;
      slot.epoch = generation;
      metrics.remapsStarted += 1;
      return Promise.resolve(slot.buffer.mapAsync(mapMode)).then(() => {
        if (failed || slot.epoch !== generation || slot.state !== "remapping") return false;
        slot.mappedBytes = new Uint8Array(slot.buffer.getMappedRange());
        slot.state = "mapped";
        metrics.remapsCompleted += 1;
        const latencyMs = Math.max(0, now() - remapStartedAt);
        metrics.remapLatencyTotalMs += latencyMs;
        metrics.remapLatencyMaxMs = Math.max(metrics.remapLatencyMaxMs, latencyMs);
        const bucket = REMAP_LATENCY_BUCKET_BOUNDS_MS.findIndex((bound) => latencyMs <= bound);
        metrics.remapLatencyHistogram[
          bucket < 0 ? REMAP_LATENCY_BUCKET_BOUNDS_MS.length : bucket
        ] += 1;
        return true;
      }, (error) => {
        metrics.remapFailures += 1;
        invalidate(error);
        return false;
      });
    });
    return Promise.all(remaps).then((results) => results.every(Boolean));
  }

  function rejectSubmission(batch, error = new Error("WebGPU upload submission rejected")) {
    requireActiveBatch(batch);
    activeBatches.delete(batch);
    invalidate(error);
  }

  function invalidate(reason = "WebGPU staging pool invalidated") {
    if (failed) return false;
    failed = true;
    lastError = normalizeError(reason);
    metrics.invalidations += 1;
    activeBatches.clear();
    for (const slot of slots) {
      slot.epoch += 1;
      slot.state = "failed";
      clearSlotRecords(slot);
      slot.firstRecordAtMs = 0;
      slot.cursor = 0;
      slot.mappedBytes = null;
      try {
        slot.buffer.destroy();
      } catch {
        // Destruction is best-effort after a device failure.
      }
    }
    return true;
  }

  function snapshot() {
    const states = { mapped: 0, sealed: 0, remapping: 0, failed: 0 };
    for (const slot of slots) states[slot.state] += 1;
    const oldestPendingAtMs = slots.reduce((oldest, slot) => {
      if (slot.state !== "mapped" || recordCount(slot) === 0) return oldest;
      return oldest === 0 ? slot.firstRecordAtMs : Math.min(oldest, slot.firstRecordAtMs);
    }, 0);
    return {
      slotCount,
      slotSize,
      capacityBytes: slotCount * slotSize,
      failed,
      lastError,
      states,
      pendingUploads: slots.reduce((count, slot) => count + recordCount(slot), 0),
      pendingBytes: slots.reduce(
        (bytes, slot) => bytes + (slot.state === "mapped" ? slot.cursor : 0),
        0
      ),
      oldestPendingAtMs,
      oldestPendingAgeMs: oldestPendingAtMs > 0 ? Math.max(0, now() - oldestPendingAtMs) : 0,
      activeBatches: activeBatches.size,
      recordStore: useFlatRecords ? "flat" : "objects",
      flatRecordHighWater,
      flatRecordResetCount,
      remapLatencyBucketBoundsMs: [...REMAP_LATENCY_BUCKET_BOUNDS_MS],
      ...metrics,
      remapLatencyHistogram: [...metrics.remapLatencyHistogram],
    };
  }

  function allocate(size, alignment) {
    if (failed) return miss("pool-failed", false);
    if (size > slotSize) return miss("payload-too-large", true);
    for (const slot of slots) {
      if (slot.state !== "mapped") continue;
      const offset = alignUp(slot.cursor, alignment);
      if (offset + size > slotSize) continue;
      slot.cursor = offset + size;
      return { ok: true, slot, offset };
    }
    return miss("no-capacity", false);
  }

  function allocateFast(size, alignment) {
    if (failed) return fastMiss("pool-failed", false);
    if (size > slotSize) return fastMiss("payload-too-large", true);
    for (const slot of slots) {
      if (slot.state !== "mapped") continue;
      const offset = alignUp(slot.cursor, alignment);
      if (offset + size > slotSize) continue;
      slot.cursor = offset + size;
      return slot.id * slotSize + offset;
    }
    return fastMiss("no-capacity", false);
  }

  function miss(reason, oversized) {
    recordMiss(oversized);
    return Object.freeze({ ok: false, reason });
  }

  function fastMiss(reason, oversized) {
    recordMiss(oversized);
    return reason;
  }

  function recordMiss(oversized) {
    metrics.capacityMisses += 1;
    if (oversized) {
      metrics.oversizedMisses += 1;
    } else if (slots.some((slot) => slot.state === "mapped")) {
      metrics.capacityMissesMappedSlotsFull += 1;
    } else {
      metrics.capacityMissesNoMappedSlots += 1;
    }
  }

  function assertUsable() {
    if (failed) throw new Error(`WebGPU staging pool is failed: ${lastError}`);
  }

  function requireActiveBatch(batch) {
    if (batch?.owner !== owner || !activeBatches.has(batch)) {
      throw new TypeError("batch does not belong to this staging pool or is no longer active");
    }
  }

  if (watchDeviceLoss && device.lost?.then) {
    device.lost.then((info) => invalidate(info?.message || info?.reason || "device lost"));
  }

  return Object.freeze({
    stageBuffer,
    stageBufferFast,
    stageBufferSnapshot,
    stageTexture,
    stageTextureFast,
    seal,
    acceptSubmission,
    rejectSubmission,
    invalidate,
    snapshot,
  });
}

export function submitWgpuUploadBeforeRender({
  queue,
  pool,
  batch,
  renderCommandBuffers = [],
} = {}) {
  if (!queue?.submit || !pool?.acceptSubmission || !pool?.rejectSubmission || !batch) {
    throw new TypeError("queue, pool, and upload batch are required");
  }
  if (!Array.isArray(renderCommandBuffers)) {
    throw new TypeError("renderCommandBuffers must be an array");
  }
  try {
    queue.submit([batch.commandBuffer, ...renderCommandBuffers]);
  } catch (error) {
    pool.rejectSubmission(batch, error);
    throw error;
  }
  return pool.acceptSubmission(batch);
}

export function attemptRetainedWgpuUpload({
  stagedUploads,
  recordIndex,
  stage,
} = {}) {
  if (!(stagedUploads instanceof Map) || typeof stage !== "function") {
    throw new TypeError("stagedUploads and stage callback are required");
  }
  const retained = stagedUploads.get(recordIndex);
  if (!retained) return Object.freeze({ found: false, accepted: false, result: null });
  const result = stage(retained.data);
  if (!result?.ok) {
    return Object.freeze({ found: true, accepted: false, result });
  }
  stagedUploads.delete(recordIndex);
  return Object.freeze({ found: true, accepted: true, result });
}

function encodeRecord(encoder, sourceBuffer, record) {
  if (record.kind === "buffer") {
    encoder.copyBufferToBuffer(
      sourceBuffer,
      record.sourceOffset,
      record.destination,
      record.destinationOffset,
      record.size
    );
    return;
  }
  if (record.kind === "buffer-snapshot") {
    if (record.copyForward) {
      encoder.copyBufferToBuffer(
        record.shadowBuffer,
        0,
        record.destination,
        record.destinationOffset,
        record.size
      );
    }
    for (const range of record.ranges) {
      encoder.copyBufferToBuffer(
        sourceBuffer,
        record.sourceOffset + range.packedOffset,
        record.destination,
        record.destinationOffset + range.start,
        range.size
      );
    }
    for (const range of record.ranges) {
      encoder.copyBufferToBuffer(
        sourceBuffer,
        record.sourceOffset + range.packedOffset,
        record.shadowBuffer,
        range.start,
        range.size
      );
    }
    return;
  }
  const destination = { texture: record.destination };
  if (record.origin !== undefined) destination.origin = record.origin;
  if (record.mipLevel !== undefined) destination.mipLevel = record.mipLevel;
  if (record.aspect !== undefined) destination.aspect = record.aspect;
  encoder.copyBufferToTexture({
    buffer: sourceBuffer,
    offset: record.sourceOffset,
    bytesPerRow: record.bytesPerRow,
    rowsPerImage: record.rowsPerImage,
  }, destination, record.copySize);
}

function encodeFlatRecord(encoder, sourceBuffer, records, index) {
  const kind = records.kinds[index];
  if (kind === RECORD_KIND_BUFFER) {
    encoder.copyBufferToBuffer(
      sourceBuffer,
      records.sourceOffsets[index],
      records.destinations[index],
      records.destinationOffsets[index],
      records.sizes[index]
    );
    return;
  }
  if (kind === RECORD_KIND_BUFFER_SNAPSHOT) {
    const destination = records.destinations[index];
    const destinationOffset = records.destinationOffsets[index];
    const shadowBuffer = records.shadowBuffers[index];
    const size = records.sizes[index];
    if (records.copyForwards[index]) {
      encoder.copyBufferToBuffer(
        shadowBuffer,
        0,
        destination,
        destinationOffset,
        size
      );
    }
    const ranges = records.snapshotRanges[index];
    for (const range of ranges) {
      encoder.copyBufferToBuffer(
        sourceBuffer,
        records.sourceOffsets[index] + range.packedOffset,
        destination,
        destinationOffset + range.start,
        range.size
      );
    }
    for (const range of ranges) {
      encoder.copyBufferToBuffer(
        sourceBuffer,
        records.sourceOffsets[index] + range.packedOffset,
        shadowBuffer,
        range.start,
        range.size
      );
    }
    return;
  }
  const destination = { texture: records.destinations[index] };
  if (records.origins[index] !== undefined) destination.origin = records.origins[index];
  if (records.mipLevels[index] !== undefined) destination.mipLevel = records.mipLevels[index];
  if (records.aspects[index] !== undefined) destination.aspect = records.aspects[index];
  encoder.copyBufferToTexture({
    buffer: sourceBuffer,
    offset: records.sourceOffsets[index],
    bytesPerRow: records.sizes[index],
    rowsPerImage: records.rowsPerImage[index],
  }, destination, records.copySizes[index]);
}

function createFlatRecordStore() {
  return {
    count: 0,
    kinds: [],
    sequenceStarts: [],
    sequenceEnds: [],
    sourceOffsets: [],
    sizes: [],
    destinations: [],
    destinationOffsets: [],
    rowsPerImage: [],
    origins: [],
    mipLevels: [],
    aspects: [],
    copySizes: [],
    shadowBuffers: [],
    copyForwards: [],
    snapshotRanges: [],
  };
}

function success(slot, offset, logicalBytes, stagedBytes) {
  return Object.freeze({ ok: true, slot: slot.id, offset, logicalBytes, stagedBytes });
}

function alignUp(value, alignment) {
  if (!isNonnegativeInteger(value) || !isPositiveInteger(alignment)) {
    throw new RangeError("alignment inputs must be nonnegative safe integers");
  }
  const remainder = value % alignment;
  const result = remainder === 0 ? value : value + alignment - remainder;
  if (!Number.isSafeInteger(result)) throw new RangeError("alignment overflow");
  return result;
}

function combinedAlignment(base, requested) {
  if (!isPositiveInteger(requested)) throw new RangeError("alignment must be positive");
  return leastCommonMultiple(base, requested);
}

function leastCommonMultiple(left, right) {
  const value = left / greatestCommonDivisor(left, right) * right;
  if (!Number.isSafeInteger(value)) throw new RangeError("alignment overflow");
  return value;
}

function greatestCommonDivisor(left, right) {
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

function viewBytes(value, reuseUint8Array = false) {
  if (!ArrayBuffer.isView(value)) return null;
  if (reuseUint8Array && value instanceof Uint8Array) return value;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function resolveBufferUsage() {
  const usage = globalThis.GPUBufferUsage;
  if (!usage) throw new Error("GPUBufferUsage is unavailable; pass bufferUsage explicitly");
  return usage.MAP_WRITE | usage.COPY_SRC;
}

function resolveMapWriteMode() {
  const mode = globalThis.GPUMapMode;
  if (!mode) throw new Error("GPUMapMode is unavailable; pass mapMode explicitly");
  return mode.WRITE;
}

function normalizeError(value) {
  return String(value?.message || value?.reason || value || "unknown");
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
