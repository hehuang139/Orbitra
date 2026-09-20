// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_UPLOAD_READ_HEADER_INDEX = 3;
export const WGPU_PROTOCOL_FLAGS_HEADER_INDEX = 4;
export const WGPU_UPLOAD_WATERMARK_PROTOCOL_FLAG = 1;

export function rebaseWgpuStagedUploadWindow({
  startIndex,
  writeIndex,
  scanCursor,
  stagedUploadIndices = []
}) {
  const start = startIndex >>> 0;
  const write = writeIndex >>> 0;
  const suffixLength = (write - start) >>> 0;

  // Command-ring occupancy is bounded well below 2^32 records, so unsigned
  // distance from the new suffix start gives an unambiguous wrap-safe range.
  for (const value of stagedUploadIndices) {
    const index = Number(value) >>> 0;
    if (((index - start) >>> 0) >= suffixLength) {
      return { ok: false, startIndex: start, invalidIndex: index };
    }
  }

  const cursor = scanCursor == null ? start : scanCursor >>> 0;
  const cursorDistance = (cursor - start) >>> 0;
  return {
    ok: true,
    startIndex: start,
    scanCursor: cursorDistance <= suffixLength ? cursor : start
  };
}

export function nextWgpuUploadRead({
  currentRead,
  uploadPointer,
  uploadBytes,
  uploadArenaBase,
  uploadArenaSize
}) {
  const read = currentRead >>> 0;
  const pointer = uploadPointer >>> 0;
  const bytes = uploadBytes >>> 0;
  const base = uploadArenaBase >>> 0;
  const size = uploadArenaSize >>> 0;

  if (!size || !bytes || bytes > size || pointer < base || pointer - base >= size) {
    return null;
  }

  const physicalOffset = (pointer - base) >>> 0;
  if (bytes > size - physicalOffset) return null;
  const cycleOffset = read % size;
  let distance = physicalOffset - cycleOffset;
  if (distance < 0) distance += size;
  return (read + distance + bytes) >>> 0;
}

export function publishWgpuUploadRead(ring, uploadPointer, uploadBytes) {
  if (!ring?.headerI32 || !ring.uploadWatermarkEnabled) return null;
  const currentRead = Atomics.load(
    ring.headerI32,
    WGPU_UPLOAD_READ_HEADER_INDEX
  ) >>> 0;
  const nextRead = nextWgpuUploadRead({
    currentRead,
    uploadPointer,
    uploadBytes,
    uploadArenaBase: ring.uploadBase,
    uploadArenaSize: ring.uploadSize
  });
  if (nextRead === null) return null;
  Atomics.store(ring.headerI32, WGPU_UPLOAD_READ_HEADER_INDEX, nextRead | 0);
  Atomics.notify(ring.headerI32, WGPU_UPLOAD_READ_HEADER_INDEX, 1);
  return nextRead;
}

export function enableWgpuUploadWatermark(ring) {
  if (!ring?.headerI32 || ring.headerI32.length <= WGPU_PROTOCOL_FLAGS_HEADER_INDEX) {
    return false;
  }
  Atomics.or(
    ring.headerI32,
    WGPU_PROTOCOL_FLAGS_HEADER_INDEX,
    WGPU_UPLOAD_WATERMARK_PROTOCOL_FLAG
  );
  Atomics.notify(ring.headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX, 1);
  ring.uploadWatermarkEnabled = true;
  return true;
}
