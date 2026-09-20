// Large enough for an external photodiode or high-speed-camera region while
// the browser observer samples only the uniform top-left 8x8 subset.
export const INPUT_VISUAL_MARKER_SIZE = 32;
export const INPUT_PHOTON_MARKER_SIZE = 160;
export const INPUT_VISUAL_MARKER_MODE_BROWSER = "browser-canvas";
export const INPUT_VISUAL_MARKER_MODE_PHOTON = "external-sensor";
const DEFAULT_MARKER_SIZE = INPUT_VISUAL_MARKER_SIZE;
const DEFAULT_MAX_SAMPLES = 64;
const DEFAULT_MARKER_HOLD_MS = 250;
const DEFAULT_MARKER_MAX_LIFETIME_MS = 2000;

export function requestedInputPhotonMarkerConfig(
  search = globalThis.location?.search ?? ""
) {
  const params = new URLSearchParams(search);
  const enabled = params.get("inputphoton") === "1";
  return {
    enabled,
    mode: enabled ? INPUT_VISUAL_MARKER_MODE_PHOTON : INPUT_VISUAL_MARKER_MODE_BROWSER,
    size: boundedInteger(params.get("inputphotonsize"), INPUT_PHOTON_MARKER_SIZE, 16, 4096),
    x: optionalNonNegativeInteger(params.get("inputphotonx")),
    y: optionalNonNegativeInteger(params.get("inputphotony"))
  };
}

export function inputMarkerRgba(generation) {
  const value = Number(generation) >>> 0;
  return [
    0x40 | (value & 0x3f),
    0x80 | ((value >>> 6) & 0x3f),
    0xc0 | ((value >>> 12) & 0x3f),
    0xff
  ];
}

export function applyInputMarkerRgba(
  bytes,
  width,
  height,
  generation,
  { bytesPerRow = Number(width) * 4, markerSize = DEFAULT_MARKER_SIZE } = {}
) {
  const frameWidth = Math.trunc(Number(width));
  const frameHeight = Math.trunc(Number(height));
  const stride = Math.trunc(Number(bytesPerRow));
  const size = Math.max(1, Math.trunc(Number(markerSize) || DEFAULT_MARKER_SIZE));
  if (
    !bytes ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    stride < frameWidth * 4 ||
    bytes.byteLength < stride * frameHeight
  ) {
    return false;
  }

  const rgba = inputMarkerRgba(generation);
  const markerWidth = Math.min(size, frameWidth);
  const markerHeight = Math.min(size, frameHeight);
  for (let y = 0; y < markerHeight; y += 1) {
    const row = y * stride;
    for (let x = 0; x < markerWidth; x += 1) {
      const offset = row + x * 4;
      bytes[offset] = rgba[0];
      bytes[offset + 1] = rgba[1];
      bytes[offset + 2] = rgba[2];
      bytes[offset + 3] = rgba[3];
    }
  }
  return true;
}

export function inputPhotonLuminance(generation) {
  return (Number(generation) >>> 0) & 1 ? 0xff : 0x00;
}

export function resolveInputPhotonMarkerGeometry(
  width,
  height,
  { size = INPUT_PHOTON_MARKER_SIZE, x = null, y = null } = {}
) {
  const frameWidth = Math.max(0, Math.trunc(Number(width) || 0));
  const frameHeight = Math.max(0, Math.trunc(Number(height) || 0));
  const markerWidth = Math.min(
    frameWidth,
    Math.max(1, Math.trunc(Number(size) || INPUT_PHOTON_MARKER_SIZE))
  );
  const markerHeight = Math.min(
    frameHeight,
    Math.max(1, Math.trunc(Number(size) || INPUT_PHOTON_MARKER_SIZE))
  );
  const requestedX = optionalNonNegativeInteger(x);
  const requestedY = optionalNonNegativeInteger(y);
  return {
    x: Math.min(
      Math.max(0, frameWidth - markerWidth),
      requestedX ?? Math.floor((frameWidth - markerWidth) / 2)
    ),
    y: Math.min(
      Math.max(0, frameHeight - markerHeight),
      requestedY ?? Math.floor((frameHeight - markerHeight) / 2)
    ),
    width: markerWidth,
    height: markerHeight,
    frameWidth,
    frameHeight
  };
}

// The external-sensor mode always paints its optical ROI, including the
// generation-zero black baseline. The corner code stays separate so a camera
// run can recover the exact input generation without weakening the 0/255 edge.
export function applyInputPhotonMarkerRgba(
  bytes,
  width,
  height,
  generation,
  {
    bytesPerRow = Number(width) * 4,
    size = INPUT_PHOTON_MARKER_SIZE,
    x = null,
    y = null,
    barcodeSize = INPUT_VISUAL_MARKER_SIZE,
    luminance = inputPhotonLuminance(generation)
  } = {}
) {
  const frameWidth = Math.trunc(Number(width));
  const frameHeight = Math.trunc(Number(height));
  const stride = Math.trunc(Number(bytesPerRow));
  if (
    !bytes ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    stride < frameWidth * 4 ||
    bytes.byteLength < stride * frameHeight
  ) {
    return false;
  }

  const geometry = resolveInputPhotonMarkerGeometry(frameWidth, frameHeight, { size, x, y });
  const opticalLevel = Number(luminance) >= 0x80 ? 0xff : 0x00;
  fillRgbaRect(bytes, stride, geometry, [opticalLevel, opticalLevel, opticalLevel, 0xff]);
  applyInputMarkerRgba(bytes, frameWidth, frameHeight, generation, {
    bytesPerRow: stride,
    markerSize: barcodeSize
  });
  return true;
}

export function applyInputVisualMarkerRgba(bytes, width, height, marker) {
  if (!marker) return false;
  if (marker.mode === INPUT_VISUAL_MARKER_MODE_PHOTON) {
    return applyInputPhotonMarkerRgba(bytes, width, height, marker.generation, {
      size: marker.optical?.size,
      x: marker.optical?.x,
      y: marker.optical?.y,
      luminance: marker.optical?.luminance
    });
  }
  return applyInputMarkerRgba(bytes, width, height, marker.generation);
}

export function inputMarkerPixelMatches(bytes, generation, offset = 0) {
  const index = Math.trunc(Number(offset));
  if (!bytes || index < 0 || index + 3 >= bytes.byteLength) return false;
  const rgba = inputMarkerRgba(generation);
  return rgba.every((value, channel) => bytes[index + channel] === value);
}

export function createInputVisualMarkerTracker({
  enabled = false,
  mode = INPUT_VISUAL_MARKER_MODE_BROWSER,
  opticalMarker = {},
  maxSamples = DEFAULT_MAX_SAMPLES,
  markerHoldMs = DEFAULT_MARKER_HOLD_MS,
  markerMaxLifetimeMs = DEFAULT_MARKER_MAX_LIFETIME_MS,
  now = () => Date.now()
} = {}) {
  const active = Boolean(enabled);
  const markerMode = mode === INPUT_VISUAL_MARKER_MODE_PHOTON
    ? INPUT_VISUAL_MARKER_MODE_PHOTON
    : INPUT_VISUAL_MARKER_MODE_BROWSER;
  const opticalMode = markerMode === INPUT_VISUAL_MARKER_MODE_PHOTON;
  const optical = {
    size: boundedInteger(opticalMarker?.size, INPUT_PHOTON_MARKER_SIZE, 16, 4096),
    x: optionalNonNegativeInteger(opticalMarker?.x),
    y: optionalNonNegativeInteger(opticalMarker?.y)
  };
  const sampleLimit = Math.max(1, Math.trunc(Number(maxSamples) || DEFAULT_MAX_SAMPLES));
  const holdMs = Math.max(0, Math.trunc(Number(markerHoldMs) || 0));
  const maxLifetimeMs = Math.max(
    holdMs,
    Math.trunc(Number(markerMaxLifetimeMs) || DEFAULT_MARKER_MAX_LIFETIME_MS)
  );
  const completedSamples = [];
  const tokens = new Map();
  let pending = null;
  let activeGeneration = 0;
  let activeMarkerExpiresAtEpochMs = 0;
  let activeMarkerCompleted = false;
  let opticalLuminance = 0;
  let lastRenderGeometry = null;
  const stats = {
    appliedCount: 0,
    duplicateApplyCount: 0,
    supersededCount: 0,
    supersededArmedCount: 0,
    droppedInFlightCount: 0,
    exactCorePollCount: 0,
    generationMismatchCount: 0,
    generationUnavailableCount: 0,
    markerArmedCount: 0,
    markerSubmittedCount: 0,
    markerCompletedCount: 0,
    duplicateSubmitCount: 0,
    duplicateCompleteCount: 0,
    retiredCompletedMarkerCount: 0,
    expiredMarkerCount: 0,
    expiredInFlightCount: 0,
    lastCompletedGeneration: 0,
    lastCompletedCoreFrame: 0,
    lastSource: "",
    lastCompletionKind: "",
    pollAgeLastMs: 0,
    submitAgeLastMs: 0,
    completionAgeLastMs: 0,
    pollToCompletionLastMs: 0
  };

  function recordApplied({
    generation,
    inputMask,
    sentAtEpochMs,
    baselinePollCount = 0
  } = {}) {
    if (!active) return false;
    const normalizedGeneration = Number(generation) >>> 0;
    if (!normalizedGeneration) return false;
    if (pending?.generation === normalizedGeneration || activeGeneration === normalizedGeneration) {
      stats.duplicateApplyCount += 1;
      return false;
    }
    if (pending) stats.supersededCount += 1;
    const appliedAtEpochMs = Number(now());
    const sentAt = Number(sentAtEpochMs);
    pending = {
      generation: normalizedGeneration,
      inputMask: Number(inputMask) >>> 0,
      sentAtEpochMs: Number.isFinite(sentAt) ? sentAt : appliedAtEpochMs,
      appliedAtEpochMs,
      baselinePollCount: Number(baselinePollCount) >>> 0
    };
    stats.appliedCount += 1;
    return true;
  }

  function recordCorePoll({ pollCount, inputMask, inputGeneration, coreFrame = 0 } = {}) {
    if (!active || !pending) return 0;
    const normalizedPollCount = Number(pollCount) >>> 0;
    const normalizedGeneration = Number(inputGeneration) >>> 0;
    if (normalizedPollCount <= pending.baselinePollCount ||
        (Number(inputMask) >>> 0) !== pending.inputMask) {
      return 0;
    }
    if (!normalizedGeneration) {
      stats.generationUnavailableCount += 1;
      return 0;
    }
    if (normalizedGeneration !== pending.generation) {
      stats.generationMismatchCount += 1;
      return 0;
    }

    const polledAtEpochMs = Number(now());
    const token = {
      generation: pending.generation,
      sentAtEpochMs: pending.sentAtEpochMs,
      appliedAtEpochMs: pending.appliedAtEpochMs,
      polledAtEpochMs,
      coreFrame: Number(coreFrame) >>> 0,
      submittedAtEpochMs: 0,
      completedAtEpochMs: 0,
      expiresAtEpochMs: polledAtEpochMs + maxLifetimeMs,
      source: ""
    };
    if (activeGeneration && activeGeneration !== token.generation) {
      const previous = tokens.get(activeGeneration);
      if (previous && !previous.submittedAtEpochMs) {
        tokens.delete(activeGeneration);
        stats.supersededArmedCount += 1;
      }
    }
    tokens.set(token.generation, token);
    while (tokens.size > sampleLimit) {
      const oldestGeneration = tokens.keys().next().value;
      if (oldestGeneration === token.generation && tokens.size === 1) break;
      tokens.delete(oldestGeneration);
      stats.droppedInFlightCount += 1;
    }
    activeGeneration = token.generation;
    if (opticalMode) opticalLuminance = opticalLuminance === 0 ? 0xff : 0x00;
    activeMarkerExpiresAtEpochMs = opticalMode ? 0 : token.expiresAtEpochMs;
    activeMarkerCompleted = false;
    pending = null;
    stats.exactCorePollCount += 1;
    stats.markerArmedCount += 1;
    const age = validAge(polledAtEpochMs, token.sentAtEpochMs);
    if (age !== null) stats.pollAgeLastMs = age;
    return token.generation;
  }

  function currentMarker() {
    if (!active) return null;
    if (!opticalMode && !activeGeneration) return null;
    if (!opticalMode && expireActiveMarker()) return null;
    const token = tokens.get(activeGeneration);
    return {
      generation: activeGeneration,
      rgba: inputMarkerRgba(activeGeneration),
      needsSubmission: Boolean(token && !token.submittedAtEpochMs),
      mode: markerMode,
      optical: opticalMode ? {
        ...optical,
        luminance: opticalLuminance,
        persistentBaseline: true
      } : null
    };
  }

  function hasPendingInput() {
    return active && pending !== null;
  }

  function recordRenderGeometry(geometry) {
    if (!active || !opticalMode || !geometry) return false;
    lastRenderGeometry = {
      x: Number(geometry.x) >>> 0,
      y: Number(geometry.y) >>> 0,
      width: Number(geometry.width) >>> 0,
      height: Number(geometry.height) >>> 0,
      frameWidth: Number(geometry.frameWidth) >>> 0,
      frameHeight: Number(geometry.frameHeight) >>> 0
    };
    return true;
  }

  function recordMarkerSubmitted({ generation, coreFrame = 0, source = "unknown" } = {}) {
    if (!active) return false;
    const normalizedGeneration = Number(generation) >>> 0;
    const token = tokens.get(normalizedGeneration);
    if (!token) return false;
    if (token.submittedAtEpochMs) {
      stats.duplicateSubmitCount += 1;
      return false;
    }
    token.submittedAtEpochMs = Number(now());
    token.coreFrame = Number(coreFrame) >>> 0;
    token.source = String(source || "unknown");
    stats.markerSubmittedCount += 1;
    stats.lastSource = token.source;
    const age = validAge(token.submittedAtEpochMs, token.sentAtEpochMs);
    if (age !== null) stats.submitAgeLastMs = age;
    return true;
  }

  function recordMarkerCompleted({
    generation,
    coreFrame = 0,
    source = "unknown",
    completionKind = "unknown"
  } = {}) {
    if (!active) return false;
    const normalizedGeneration = Number(generation) >>> 0;
    const token = tokens.get(normalizedGeneration);
    if (!token || !token.submittedAtEpochMs) return false;
    if (token.completedAtEpochMs) {
      stats.duplicateCompleteCount += 1;
      return false;
    }
    token.completedAtEpochMs = Number(now());
    if (activeGeneration === token.generation) {
      activeMarkerExpiresAtEpochMs = opticalMode ? 0 : token.completedAtEpochMs + holdMs;
      activeMarkerCompleted = true;
    }
    token.coreFrame = Number(coreFrame) >>> 0;
    token.source = String(source || token.source || "unknown");
    const completionAgeMs = validAge(token.completedAtEpochMs, token.sentAtEpochMs);
    const pollToCompletionMs = validAge(token.completedAtEpochMs, token.polledAtEpochMs);
    const sample = {
      generation: token.generation,
      coreFrame: token.coreFrame,
      source: token.source,
      completionKind: String(completionKind || "unknown"),
      sentAtEpochMs: token.sentAtEpochMs,
      appliedAtEpochMs: token.appliedAtEpochMs,
      polledAtEpochMs: token.polledAtEpochMs,
      submittedAtEpochMs: token.submittedAtEpochMs,
      completedAtEpochMs: token.completedAtEpochMs,
      completionAgeMs: completionAgeMs ?? 0,
      pollToCompletionMs: pollToCompletionMs ?? 0
    };
    completedSamples.push(sample);
    if (completedSamples.length > sampleLimit) completedSamples.shift();
    stats.markerCompletedCount += 1;
    stats.lastCompletedGeneration = token.generation;
    stats.lastCompletedCoreFrame = token.coreFrame;
    stats.lastSource = token.source;
    stats.lastCompletionKind = sample.completionKind;
    if (completionAgeMs !== null) stats.completionAgeLastMs = completionAgeMs;
    if (pollToCompletionMs !== null) stats.pollToCompletionLastMs = pollToCompletionMs;
    tokens.delete(normalizedGeneration);
    return true;
  }

  function snapshot() {
    if (!opticalMode) expireActiveMarker();
    const completionAges = completedSamples.map((sample) => sample.completionAgeMs);
    const pollToCompletion = completedSamples.map((sample) => sample.pollToCompletionMs);
    return {
      schema: "wasm-dolphin.input-visual-marker.v1",
      enabled: active,
      mode: markerMode,
      causalVisualAttribution: true,
      meaning: opticalMode
        ? "host-input-to-core-polled-generation-to-external-sensor-optical-transition"
        : "host-input-to-core-polled-generation-to-deterministic-marker-completion",
      measurementBoundary: opticalMode
        ? "worker input generation through marker submission/completion telemetry; photon time requires an external sensor"
        : "worker input generation through browser marker submission/completion telemetry",
      physicalPhotonBoundaryIncluded: false,
      opticalMarker: {
        enabled: active && opticalMode,
        persistentBlackBaseline: active && opticalMode,
        transition: active && opticalMode
          ? "every exact core-polled generation toggles full-scale black/white"
          : "none",
        lowLuminance: 0,
        highLuminance: 255,
        requestedSize: optical.size,
        requestedX: optical.x,
        requestedY: optical.y,
        barcodeSize: INPUT_VISUAL_MARKER_SIZE,
        lastRenderGeometry: lastRenderGeometry ? { ...lastRenderGeometry } : null
      },
      ...stats,
      pendingGeneration: pending?.generation ?? 0,
      activeGeneration,
      activeMarkerExpiresAtEpochMs,
      markerHoldMs: holdMs,
      markerMaxLifetimeMs: maxLifetimeMs,
      inFlightCount: tokens.size,
      completionAgeAverageMs: average(completionAges),
      completionAgeP95Ms: percentile(completionAges, 0.95),
      completionAgeMaxMs: maximum(completionAges),
      pollToCompletionAverageMs: average(pollToCompletion),
      pollToCompletionP95Ms: percentile(pollToCompletion, 0.95),
      samples: completedSamples.map((sample) => ({ ...sample }))
    };
  }

  function expireActiveMarker() {
    if (!activeGeneration || activeMarkerExpiresAtEpochMs <= 0 ||
        Number(now()) <= activeMarkerExpiresAtEpochMs) {
      return false;
    }
    const token = tokens.get(activeGeneration);
    if (activeMarkerCompleted) {
      stats.retiredCompletedMarkerCount += 1;
    } else {
      stats.expiredMarkerCount += 1;
    }
    if (token && !token.completedAtEpochMs) {
      tokens.delete(activeGeneration);
      stats.expiredInFlightCount += 1;
    }
    activeGeneration = 0;
    activeMarkerExpiresAtEpochMs = 0;
    activeMarkerCompleted = false;
    return true;
  }

  return {
    currentMarker,
    hasPendingInput,
    recordApplied,
    recordCorePoll,
    recordMarkerCompleted,
    recordMarkerSubmitted,
    recordRenderGeometry,
    snapshot
  };
}

function fillRgbaRect(bytes, stride, geometry, rgba) {
  for (let y = geometry.y; y < geometry.y + geometry.height; y += 1) {
    const row = y * stride;
    for (let x = geometry.x; x < geometry.x + geometry.width; x += 1) {
      const offset = row + x * 4;
      bytes[offset] = rgba[0];
      bytes[offset + 1] = rgba[1];
      bytes[offset + 2] = rgba[2];
      bytes[offset + 3] = rgba[3];
    }
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value === null || value === undefined || value === ""
    ? Number.NaN
    : Number(value);
  const integer = Number.isFinite(number) ? Math.trunc(number) : fallback;
  return Math.min(maximum, Math.max(minimum, integer));
}

function optionalNonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function validAge(end, start) {
  const age = Number(end) - Number(start);
  return Number.isFinite(age) && age >= 0 && age <= 60000 ? age : null;
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}
