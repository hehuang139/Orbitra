export const WGPU_VISUAL_SAMPLE_WIDTH = 96;
export const WGPU_VISUAL_SAMPLE_HEIGHT = 72;
export const WGPU_VISUAL_READBACK_RING_SIZE = 3;
export const WGPU_VISUAL_BYTES_PER_PIXEL = 4;
export const WGPU_VISUAL_BYTES_PER_ROW = alignTo(
  WGPU_VISUAL_SAMPLE_WIDTH * WGPU_VISUAL_BYTES_PER_PIXEL,
  256
);
export const WGPU_VISUAL_READBACK_BYTES =
  WGPU_VISUAL_BYTES_PER_ROW * WGPU_VISUAL_SAMPLE_HEIGHT;

// Tri-state. `wgpuvisual=1` and `wgpuvisual=0` are explicit; with the flag
// absent the sampler follows the video path, which means it is ON for
// `?video=wgpu`.
//
// It used to default off everywhere, and that made the HUD lie: the hardware
// path never hashes an XFB, so `visual` read a flat 0.0 on the one path whose
// entire justification is beating the software rasterizer's unique-frame
// ceiling (issue #7). A number nobody can measure is worse than a readback
// nobody asked for. Perf-attribution runs that must not pay the per-present
// downsample + copyTextureToBuffer opt out with `wgpuvisual=0`.
export function requestedWgpuVisualCadence(
  search = globalThis.location?.search ?? "",
  { hardwareVideo = false } = {}
) {
  const requested = new URLSearchParams(search).get("wgpuvisual");
  if (requested === "1") return true;
  if (requested === "0") return false;
  return Boolean(hardwareVideo);
}

export function hashWgpuVisualSample(
  bytes,
  {
    width = WGPU_VISUAL_SAMPLE_WIDTH,
    height = WGPU_VISUAL_SAMPLE_HEIGHT,
    bytesPerRow = WGPU_VISUAL_BYTES_PER_ROW
  } = {}
) {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes ?? 0);
  const rowBytes = Math.max(0, Number(width) || 0) * WGPU_VISUAL_BYTES_PER_PIXEL;
  const rows = Math.max(0, Number(height) || 0);
  const stride = Math.max(rowBytes, Number(bytesPerRow) || 0);
  if (!rowBytes || !rows || view.byteLength < stride * rows) return 0;

  // FNV-1a over visible texels only. WebGPU row padding is deliberately
  // excluded because copyTextureToBuffer does not define padding contents.
  let hash = 2166136261;
  for (let y = 0; y < rows; y += 1) {
    const end = y * stride + rowBytes;
    for (let offset = y * stride; offset < end; offset += 1) {
      hash ^= view[offset];
      hash = Math.imul(hash, 16777619);
    }
  }
  hash ^= rowBytes;
  hash = Math.imul(hash, 16777619);
  hash ^= rows;
  return hash >>> 0;
}

export function createWgpuVisualCadenceTelemetry(enabled = false) {
  return {
    schema: "wasm-dolphin.wgpu-visual-cadence.v1",
    enabled: Boolean(enabled),
    source: enabled ? "wgpu-downsample-readback" : "none",
    sampleWidth: WGPU_VISUAL_SAMPLE_WIDTH,
    sampleHeight: WGPU_VISUAL_SAMPLE_HEIGHT,
    bytesPerRow: WGPU_VISUAL_BYTES_PER_ROW,
    readbackBytesPerSlot: WGPU_VISUAL_READBACK_BYTES,
    ringSize: WGPU_VISUAL_READBACK_RING_SIZE,
    allocatedReadbackBytes: enabled
      ? WGPU_VISUAL_READBACK_BYTES * WGPU_VISUAL_READBACK_RING_SIZE
      : 0,
    encodeAttemptCount: 0,
    encodedSampleCount: 0,
    completedSampleCount: 0,
    changedSampleCount: 0,
    busyDropCount: 0,
    encodeErrorCount: 0,
    mapErrorCount: 0,
    inFlightCount: 0,
    inFlightHighWater: 0,
    latestHash: 0,
    latestCompletedSequence: 0
  };
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
