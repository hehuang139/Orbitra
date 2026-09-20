// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { encodeWgpuUboComputePackage } from "./wgpu-ubo-compute-codec.js";
import { WGPU_UBO_COMPUTE_CLASS_BYTES } from "./wgpu-ubo-compute-projection.js";

export const WGPU_UBO_COMPUTE_RECONSTRUCTION_SCHEMA =
  "wasm-dolphin.wgpu-ubo-compute-reconstruction.v1";
export const WGPU_UBO_RING_ROLE = "UBO_RING";

const DEFAULT_SLOT_COUNT = 3;
// Three 2 MiB slots cover the worst legal 768-record burst even when every
// record is a full 4,112-byte VS object. One MiB slots could represent the
// steady-state delta stream but failed closed on post-load full bursts.
const DEFAULT_SLOT_SIZE = 2 * 1024 * 1024;
const MAX_RECORDS_PER_PACKAGE = 256;
const PACKAGE_ALIGNMENT = 256;
const SHADOW_BYTES =
  WGPU_UBO_COMPUTE_CLASS_BYTES.VS +
  WGPU_UBO_COMPUTE_CLASS_BYTES.PS +
  WGPU_UBO_COMPUTE_CLASS_BYTES.GS;

const USAGE = Object.freeze({
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  STORAGE: 0x0080,
});
const MAP_WRITE_MODE = 0x0002;

export function requestedWgpuUboComputeReconstruction(search = "") {
  return new URLSearchParams(search).get("wgpuubocompute") === "1";
}

// This manager owns only package staging and reconstruction commands. The
// caller remains responsible for queue submission and for placing the returned
// command buffer before every render command buffer that consumes the ring.
export function createWgpuUboComputeReconstruction({
  device,
  slotCount = DEFAULT_SLOT_COUNT,
  slotSize = DEFAULT_SLOT_SIZE,
  stagingUsage = USAGE.MAP_WRITE | USAGE.COPY_SRC,
  workUsage = USAGE.COPY_DST | USAGE.STORAGE,
  shadowUsage = USAGE.STORAGE,
  mapMode = MAP_WRITE_MODE,
  watchDeviceLoss = true,
} = {}) {
  validateDevice(device, slotCount, slotSize);
  requireFlags(stagingUsage, USAGE.MAP_WRITE | USAGE.COPY_SRC, "stagingUsage");
  requireFlags(workUsage, USAGE.COPY_DST | USAGE.STORAGE, "workUsage");
  requireFlags(shadowUsage, USAGE.STORAGE, "shadowUsage");
  if (!isU32(mapMode)) throw new TypeError("mapMode must be a numeric WebGPU flag");

  const owner = Symbol("wgpu-ubo-compute-reconstruction");
  const resources = new Map();
  const cpuShadows = new Map();
  const resetReasons = Object.create(null);
  const rejectReasons = Object.create(null);
  const slots = [];
  let pipeline = createPipeline(device);
  let bindGroupLayout = pipeline.getBindGroupLayout(0);
  let pending = [];
  let sealedAwaitingDecision = null;
  let nextBatchId = 1;
  let generation = 1;
  let failed = false;
  let lastError = null;
  const activeBatches = new Set();
  const metrics = {
    stagedUploads: 0,
    stagedLogicalBytes: 0,
    packagesEncoded: 0,
    packageBytes: 0,
    packagePayloadBytes: 0,
    packageDescriptorBytes: 0,
    copiesEncoded: 0,
    dispatchesEncoded: 0,
    batchesSealed: 0,
    batchesAccepted: 0,
    batchesRejected: 0,
    batchesCompleted: 0,
    remapsStarted: 0,
    remapsCompleted: 0,
    remapFailures: 0,
    validationRejects: 0,
    capacityRejects: 0,
    resets: 0,
    invalidations: 0,
  };

  createSlots();

  if (watchDeviceLoss && device.lost && typeof device.lost.then === "function") {
    device.lost.then(
      (info) => invalidate(`device-lost:${info?.reason || "unknown"}`),
      (error) => invalidate(`device-lost-rejected:${errorText(error)}`)
    );
  }

  function createSlots() {
    for (let id = 0; id < slotCount; id += 1) {
      const staging = device.createBuffer({
        label: `Dolphin UBO compute staging ${id}`,
        size: slotSize,
        usage: stagingUsage,
        mappedAtCreation: true,
      });
      const work = device.createBuffer({
        label: `Dolphin UBO compute work ${id}`,
        size: slotSize,
        usage: workUsage,
      });
      slots.push({
        id,
        staging,
        work,
        mappedBytes: new Uint8Array(staging.getMappedRange()),
        state: "mapped",
        cursor: 0,
        generation,
      });
    }
  }

  function registerResource({ resourceId, role, buffer, size, usage } = {}) {
    assertUsable();
    const id = normalizeResourceId(resourceId);
    if (role !== WGPU_UBO_RING_ROLE) {
      throw new RangeError(`resource ${id} must have explicit UBO_RING role`);
    }
    if (!buffer || !isPositiveMultipleOfFour(size)) {
      throw new TypeError("registered UBO ring needs a buffer and four-byte-aligned size");
    }
    requireFlags(usage, USAGE.STORAGE, "registered UBO ring usage");
    if (size > device.limits.maxBufferSize ||
        size > device.limits.maxStorageBufferBindingSize) {
      throw new RangeError("registered UBO ring exceeds device storage-buffer limits");
    }
    if (resources.has(id)) throw new RangeError(`resource ${id} is already registered`);
    const shadow = device.createBuffer({
      label: `Dolphin UBO compute shadow ${id}`,
      size: SHADOW_BYTES,
      usage: shadowUsage,
    });
    resources.set(id, { id, role, buffer, size, usage, shadow });
    return Object.freeze({ resourceId: id, role, size });
  }

  function unregisterResource(resourceId) {
    assertUsable();
    if (pending.length || sealedAwaitingDecision || activeBatches.size) {
      throw new Error("cannot unregister a UBO ring while reconstruction work is pending");
    }
    const id = normalizeResourceId(resourceId);
    const resource = resources.get(id);
    if (!resource) return false;
    resource.shadow.destroy?.();
    resources.delete(id);
    for (const key of cpuShadows.keys()) {
      if (key.startsWith(`${id}:`)) cpuShadows.delete(key);
    }
    return true;
  }

  function stage({
    resourceId,
    resourceClass,
    destinationOffset,
    bytes,
    borrowBytes = false,
  } = {}) {
    assertUsable();
    if (sealedAwaitingDecision) return rejectStage("sealed-batch-awaiting-decision");
    const id = normalizeResourceId(resourceId);
    const resource = resources.get(id);
    if (!resource || resource.role !== WGPU_UBO_RING_ROLE) {
      return rejectStage("unregistered-ubo-ring");
    }
    const expectedBytes = WGPU_UBO_COMPUTE_CLASS_BYTES[resourceClass];
    const source = viewBytes(bytes, borrowBytes);
    if (!expectedBytes || !source || source.byteLength !== expectedBytes ||
        !isU32(destinationOffset) || (destinationOffset & 3) !== 0 ||
        destinationOffset + expectedBytes > resource.size) {
      return rejectStage("invalid-upload");
    }
    // Bound retained CPU data to the maximum number of records that can be
    // represented by the currently mapped staging capacity.
    if (pending.length >= slotCount * MAX_RECORDS_PER_PACKAGE) {
      metrics.capacityRejects += 1;
      return Object.freeze({ ok: false, reason: "pending-record-cap" });
    }
    pending.push({ resourceId: id, resourceClass, destinationOffset, bytes: source });
    metrics.stagedUploads += 1;
    metrics.stagedLogicalBytes += source.byteLength;
    return Object.freeze({ ok: true, pendingUploads: pending.length });
  }

  function seal(label = "Dolphin ordered UBO reconstruction") {
    assertUsable();
    if (sealedAwaitingDecision) {
      return Object.freeze({ ok: false, reason: "sealed-batch-awaiting-decision" });
    }
    if (pending.length === 0) return null;

    let encoded;
    try {
      encoded = encodePendingPackages(pending, cpuShadows, slotSize);
    } catch (error) {
      metrics.validationRejects += 1;
      return Object.freeze({ ok: false, reason: "package-validation", error: errorText(error) });
    }
    const allocation = planAllocations(encoded.packages);
    if (!allocation) {
      metrics.capacityRejects += 1;
      return Object.freeze({ ok: false, reason: "no-mapped-capacity" });
    }

    const usedSlots = [...new Set(allocation.map((entry) => entry.slot))];
    try {
      for (const entry of allocation) {
        entry.slot.mappedBytes.set(entry.package.bytes, entry.offset);
        entry.slot.cursor = entry.offset + entry.package.packageBytes;
      }
      for (const slot of usedSlots) {
        slot.staging.unmap();
        slot.mappedBytes = null;
        slot.state = "sealed";
      }
      const encoder = device.createCommandEncoder({ label });
      for (const entry of allocation) {
        encoder.copyBufferToBuffer(
          entry.slot.staging,
          entry.offset,
          entry.slot.work,
          entry.offset,
          entry.package.packageBytes
        );
        const bindGroup = device.createBindGroup({
          label: `Dolphin UBO compute package ${entry.index}`,
          layout: bindGroupLayout,
          entries: [
            { binding: 0, resource: {
              buffer: entry.slot.work,
              offset: entry.offset,
              size: entry.package.packageBytes,
            } },
            { binding: 1, resource: {
              buffer: entry.resource.shadow,
              offset: 0,
              size: SHADOW_BYTES,
            } },
            { binding: 2, resource: {
              buffer: entry.resource.buffer,
              offset: 0,
              size: entry.resource.size,
            } },
          ],
        });
        const pass = encoder.beginComputePass({
          label: `Dolphin ordered UBO reconstruction ${entry.index}`,
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1, 1, 1);
        pass.end();
      }
      const batch = {
        ok: true,
        owner,
        id: nextBatchId++,
        generation,
        state: "sealed",
        commandBuffer: encoder.finish(),
        slots: usedSlots,
        nextShadows: encoded.nextShadows,
        packageCount: encoded.packages.length,
        recordCount: pending.length,
        packageBytes: encoded.packageBytes,
      };
      pending = [];
      sealedAwaitingDecision = batch;
      metrics.packagesEncoded += encoded.packages.length;
      metrics.packageBytes += encoded.packageBytes;
      metrics.packagePayloadBytes += encoded.payloadBytes;
      metrics.packageDescriptorBytes += encoded.descriptorBytes;
      metrics.copiesEncoded += encoded.packages.length;
      metrics.dispatchesEncoded += encoded.packages.length;
      metrics.batchesSealed += 1;
      return batch;
    } catch (error) {
      invalidate(`encode-failed:${errorText(error)}`);
      return Object.freeze({ ok: false, reason: "encode-failed", error: errorText(error) });
    }
  }

  function accept(batch, submissionCompletion = Promise.resolve()) {
    validateBatchDecision(batch);
    sealedAwaitingDecision = null;
    batch.state = "accepted";
    replaceShadowMap(cpuShadows, batch.nextShadows);
    metrics.batchesAccepted += 1;
    activeBatches.add(batch);
    const remaps = remapBatchSlots(batch);
    const completion = Promise.resolve(submissionCompletion);
    batch.completion = Promise.all([completion, ...remaps]).then(
      () => {
        if (batch.generation === generation && !failed) metrics.batchesCompleted += 1;
        activeBatches.delete(batch);
        batch.state = "completed";
        return true;
      },
      (error) => {
        activeBatches.delete(batch);
        if (batch.generation === generation) {
          metrics.remapFailures += 1;
          invalidate(`submission-or-remap-rejected:${errorText(error)}`);
          batch.state = "failed";
        } else {
          batch.state = "retired";
        }
        return false;
      }
    );
    return batch.completion;
  }

  function reject(batch, reason = "not-submitted") {
    validateBatchDecision(batch);
    sealedAwaitingDecision = null;
    batch.state = "rejected";
    metrics.batchesRejected += 1;
    const normalizedReason = String(reason || "not-submitted");
    rejectReasons[normalizedReason] = (rejectReasons[normalizedReason] || 0) + 1;
    return Promise.all(remapBatchSlots(batch)).then(
      () => true,
      (error) => {
        metrics.remapFailures += 1;
        invalidate(`rejected-batch-remap-failed:${errorText(error)}`);
        return false;
      }
    );
  }

  function reset(reason = "reset") {
    const normalizedReason = String(reason || "reset");
    const retiredSlots = slots.slice();
    const retiredShadows = [...resources.values()].map((resource) => resource.shadow);
    const retiredCompletions = [...activeBatches].map((batch) => batch.completion);
    generation += 1;
    metrics.resets += 1;
    resetReasons[normalizedReason] = (resetReasons[normalizedReason] || 0) + 1;
    pending = [];
    sealedAwaitingDecision = null;
    cpuShadows.clear();
    failed = false;
    lastError = null;
    slots.length = 0;
    for (const resource of resources.values()) {
      resource.shadow = device.createBuffer({
        label: `Dolphin UBO compute shadow ${resource.id}`,
        size: SHADOW_BYTES,
        usage: shadowUsage,
      });
    }
    pipeline = createPipeline(device);
    bindGroupLayout = pipeline.getBindGroupLayout(0);
    createSlots();
    const destroyRetired = () => {
      for (const slot of retiredSlots) {
        slot.staging.destroy?.();
        slot.work.destroy?.();
      }
      for (const shadow of retiredShadows) shadow.destroy?.();
    };
    if (retiredCompletions.length > 0) {
      Promise.allSettled(retiredCompletions).then(destroyRetired);
    } else {
      destroyRetired();
    }
  }

  function snapshot() {
    const states = { mapped: 0, sealed: 0, remapping: 0, failed: 0 };
    for (const slot of slots) states[slot.state] = (states[slot.state] || 0) + 1;
    return {
      schema: WGPU_UBO_COMPUTE_RECONSTRUCTION_SCHEMA,
      active: !failed,
      failed,
      lastError,
      generation,
      slotCount,
      slotSize,
      states,
      registeredUboRings: resources.size,
      pendingUploads: pending.length,
      sealedAwaitingDecision: Boolean(sealedAwaitingDecision),
      activeBatches: activeBatches.size,
      shadowBytesPerResource: SHADOW_BYTES,
      ...metrics,
      resetReasons: { ...resetReasons },
      rejectReasons: { ...rejectReasons },
    };
  }

  function remapBatchSlots(batch) {
    return batch.slots.map((slot) => {
      slot.state = "remapping";
      slot.cursor = 0;
      metrics.remapsStarted += 1;
      return Promise.resolve(slot.staging.mapAsync(mapMode)).then(() => {
        if (batch.generation !== generation || failed) return;
        slot.mappedBytes = new Uint8Array(slot.staging.getMappedRange());
        slot.state = "mapped";
        metrics.remapsCompleted += 1;
      });
    });
  }

  function planAllocations(packages) {
    const available = slots.filter((slot) => slot.state === "mapped");
    const cursors = new Map(available.map((slot) => [slot, slot.cursor]));
    const allocation = [];
    for (let index = 0; index < packages.length; index += 1) {
      const pkg = packages[index];
      if (pkg.packageBytes > slotSize) return null;
      let selected = null;
      let offset = 0;
      for (const slot of available) {
        const candidate = alignUp(cursors.get(slot), PACKAGE_ALIGNMENT);
        if (candidate + pkg.packageBytes <= slotSize) {
          selected = slot;
          offset = candidate;
          break;
        }
      }
      if (!selected) return null;
      cursors.set(selected, offset + pkg.packageBytes);
      allocation.push({
        index,
        package: pkg,
        resource: resources.get(pkg.resourceId),
        slot: selected,
        offset,
      });
    }
    return allocation;
  }

  function validateBatchDecision(batch) {
    assertUsable();
    if (!batch || batch.owner !== owner || batch !== sealedAwaitingDecision ||
        batch.state !== "sealed" || batch.generation !== generation) {
      throw new RangeError("batch is stale, foreign, or already decided");
    }
  }

  function rejectStage(reason) {
    metrics.validationRejects += 1;
    return Object.freeze({ ok: false, reason });
  }

  function assertUsable() {
    if (failed) throw new Error(`UBO compute reconstruction is invalid: ${lastError}`);
  }

  function invalidate(reason) {
    if (failed) return;
    failed = true;
    lastError = String(reason || "invalidated");
    metrics.invalidations += 1;
    pending = [];
    sealedAwaitingDecision = null;
    cpuShadows.clear();
    for (const slot of slots) slot.state = "failed";
    destroyInternalBuffers();
  }

  function destroyInternalBuffers() {
    for (const slot of slots) {
      slot.staging.destroy?.();
      slot.work.destroy?.();
    }
    for (const resource of resources.values()) resource.shadow.destroy?.();
  }

  return Object.freeze({
    registerResource,
    unregisterResource,
    stage,
    seal,
    accept,
    reject,
    reset,
    invalidate,
    snapshot,
  });
}

function encodePendingPackages(uploads, initialShadows, maxPackageBytes) {
  const packages = [];
  let shadows = cloneShadowMap(initialShadows);
  for (let start = 0; start < uploads.length;) {
    const resourceId = uploads[start].resourceId;
    let end = start;
    while (end < uploads.length && uploads[end].resourceId === resourceId &&
           end - start < MAX_RECORDS_PER_PACKAGE) {
      end += 1;
    }
    let encoded = encodeWgpuUboComputePackage({
      uploads: uploads.slice(start, end),
      shadows,
      borrowUploadBytes: true,
    });
    // A full-change burst can exceed the work-buffer slice even below the
    // record cap. Split without committing speculative CPU shadows.
    while (encoded.packageBytes > maxPackageBytes && end - start > 1) {
      end = start + Math.floor((end - start) / 2);
      encoded = encodeWgpuUboComputePackage({
        uploads: uploads.slice(start, end),
        shadows,
        borrowUploadBytes: true,
      });
    }
    packages.push(encoded);
    shadows = encoded.nextShadows;
    start = end;
  }
  return {
    packages,
    nextShadows: shadows,
    packageBytes: packages.reduce((sum, pkg) => sum + pkg.packageBytes, 0),
    payloadBytes: packages.reduce((sum, pkg) => sum + pkg.payloadBytes, 0),
    descriptorBytes: packages.reduce((sum, pkg) => sum + pkg.descriptorBytes, 0),
  };
}

function createPipeline(device) {
  const module = device.createShaderModule({
    label: "Dolphin ordered UBO reconstruction shader",
    code: UBO_RECONSTRUCTION_WGSL,
  });
  return device.createComputePipeline({
    label: "Dolphin ordered UBO reconstruction pipeline",
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
}

function validateDevice(device, slotCount, slotSize) {
  for (const method of [
    "createBuffer", "createShaderModule", "createComputePipeline",
    "createBindGroup", "createCommandEncoder",
  ]) {
    if (typeof device?.[method] !== "function") {
      throw new TypeError(`device.${method} is required`);
    }
  }
  if (!Number.isSafeInteger(slotCount) || slotCount <= 0) {
    throw new RangeError("slotCount must be a positive integer");
  }
  if (!isPositiveMultipleOfFour(slotSize) || slotSize % PACKAGE_ALIGNMENT !== 0) {
    throw new RangeError("slotSize must be a positive multiple of 256");
  }
  const requiredLimits = {
    maxBufferSize: Math.max(slotSize, SHADOW_BYTES),
    maxStorageBufferBindingSize: Math.max(slotSize, SHADOW_BYTES),
    maxStorageBuffersPerShaderStage: 3,
    maxComputeInvocationsPerWorkgroup: 64,
    maxComputeWorkgroupSizeX: 64,
    maxComputeWorkgroupsPerDimension: 1,
    maxBindGroups: 1,
  };
  for (const [name, minimum] of Object.entries(requiredLimits)) {
    const actual = device?.limits?.[name];
    if (!Number.isFinite(actual) || actual < minimum) {
      throw new RangeError(`device limit ${name}=${actual} is below required ${minimum}`);
    }
  }
}

function requireFlags(value, required, name) {
  if (!isU32(value) || (value & required) !== required) {
    throw new RangeError(`${name} must include WebGPU flags 0x${required.toString(16)}`);
  }
}

function normalizeResourceId(value) {
  if (!isU32(value)) throw new RangeError("resourceId must be a u32");
  return value >>> 0;
}

function isU32(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isPositiveMultipleOfFour(value) {
  return Number.isSafeInteger(value) && value > 0 && value % 4 === 0;
}

function viewBytes(value, borrow = false) {
  if (!ArrayBuffer.isView(value)) return null;
  const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return borrow ? view : view.slice();
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function cloneShadowMap(source) {
  return new Map([...source].map(([key, value]) => [key, value.slice()]));
}

function replaceShadowMap(destination, source) {
  destination.clear();
  for (const [key, value] of source) destination.set(key, value.slice());
}

function errorText(error) {
  return String(error?.message || error || "unknown error");
}

const UBO_RECONSTRUCTION_WGSL = /* wgsl */ `
struct Words { values: array<u32> };

@group(0) @binding(0) var<storage, read> package_data: Words;
@group(0) @binding(1) var<storage, read_write> class_shadow: Words;
@group(0) @binding(2) var<storage, read_write> destination: Words;

fn class_base_words(class_id: u32) -> u32 {
  if (class_id == 0u) { return 0u; }
  if (class_id == 1u) { return 1028u; }
  return 1412u;
}

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) local_id: vec3<u32>) {
  let lane = local_id.x;
  let record_count = package_data.values[2u];
  for (var record_index = 0u; record_index < record_count; record_index += 1u) {
    let descriptor = 8u + record_index * 8u;
    let class_id = package_data.values[descriptor + 1u];
    let destination_word = package_data.values[descriptor + 2u] / 4u;
    let object_words = package_data.values[descriptor + 3u] / 4u;
    let range_count = package_data.values[descriptor + 4u];
    let range_words = package_data.values[descriptor + 5u] / 4u;
    let payload_words = package_data.values[descriptor + 6u] / 4u;
    let shadow_word = class_base_words(class_id);
    var payload_cursor = 0u;

    for (var range_index = 0u; range_index < range_count; range_index += 1u) {
      let range_descriptor = range_words + range_index * 2u;
      let range_start = package_data.values[range_descriptor] / 4u;
      let range_length = package_data.values[range_descriptor + 1u] / 4u;
      for (var word = lane; word < range_length; word += 64u) {
        class_shadow.values[shadow_word + range_start + word] =
          package_data.values[payload_words + payload_cursor + word];
      }
      payload_cursor += range_length;
      storageBarrier();
    }

    for (var word = lane; word < object_words; word += 64u) {
      destination.values[destination_word + word] =
        class_shadow.values[shadow_word + word];
    }
    storageBarrier();
  }
}
`;
