// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_CONSUMER_RESET_ATTESTATION_SCHEMA =
  "wasm-dolphin.wgpu-consumer-reset-attestation.v1";
export const WGPU_CONSUMER_RESET_ATTESTATION_KIND =
  "initial-empty-consumer";

const RESOURCE_MAP_NAMES = Object.freeze([
  "shaders",
  "pipelines",
  "buffers",
  "textures",
  "samplers",
  "bindGroups",
  "pipeTpl",
  "pipeVar",
]);
const authenticAttestations = new WeakSet();

// This is deliberately narrower than a general reset API. Today the browser
// consumer has exactly one provable empty boundary: before ownership tracing
// attaches and before the first command-ring handoff. Save-state load, core
// reset, and device loss do not clear every browser-side resource map.
export function captureInitialWgpuConsumerResetAttestation({
  resourceMaps,
  videoBackend,
  renderDeviceReady,
  capturedBeforeTraceAttach,
  commandRingRegistered,
  commandsProcessed,
  canvasOwnedByCommandRing,
  replayFatal,
} = {}) {
  const reasons = [];
  const resourceCounts = {};
  let totalResourceCount = 0;

  for (const name of RESOURCE_MAP_NAMES) {
    const map = resourceMaps?.[name];
    if (!(map instanceof Map)) {
      reasons.push(`resource map ${name} is unavailable`);
      resourceCounts[name] = -1;
      continue;
    }
    resourceCounts[name] = map.size;
    totalResourceCount += map.size;
    if (map.size !== 0) reasons.push(`resource map ${name} is not empty`);
  }

  const processed = exactCount(commandsProcessed, "commandsProcessed", reasons);
  if (videoBackend !== "WebGPU-Real") reasons.push("video backend is not WebGPU-Real");
  if (renderDeviceReady !== true) reasons.push("render device is not ready");
  if (capturedBeforeTraceAttach !== true) reasons.push("trace already attached");
  if (commandRingRegistered === true) reasons.push("command ring is already registered");
  if (processed !== 0) reasons.push("commands have already been processed");
  if (canvasOwnedByCommandRing === true) reasons.push("command ring already owns the canvas");
  if (replayFatal != null) reasons.push("replay is already failed");

  const attestation = Object.freeze({
    schema: WGPU_CONSUMER_RESET_ATTESTATION_SCHEMA,
    kind: WGPU_CONSUMER_RESET_ATTESTATION_KIND,
    valid: reasons.length === 0,
    resourceCounts: Object.freeze(resourceCounts),
    totalResourceCount,
    commandsProcessed: processed,
    capturedBeforeTraceAttach: capturedBeforeTraceAttach === true,
    commandRingRegistered: commandRingRegistered === true,
    reasons: Object.freeze(reasons),
  });
  authenticAttestations.add(attestation);
  return attestation;
}

export function isAuthenticInitialWgpuConsumerResetAttestation(value) {
  return Boolean(
    value &&
    authenticAttestations.has(value) &&
    value.schema === WGPU_CONSUMER_RESET_ATTESTATION_SCHEMA &&
    value.kind === WGPU_CONSUMER_RESET_ATTESTATION_KIND &&
    value.valid === true &&
    value.totalResourceCount === 0 &&
    value.commandsProcessed === 0 &&
    value.capturedBeforeTraceAttach === true &&
    value.commandRingRegistered === false
  );
}

function exactCount(value, name, reasons) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    reasons.push(`${name} is not a non-negative safe integer`);
    return -1;
  }
  return number;
}

