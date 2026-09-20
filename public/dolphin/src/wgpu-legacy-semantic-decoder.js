// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// Pure decoder for the protocol-v3 WebGPU command record. This module is an
// independent semantic oracle: it does not call renderer APIs, advance ring
// cursors, or retain transport addresses in its result.

export const WGPU_SEMANTIC_EVENT_KIND = Object.freeze({
  COMMAND: 1
});

export const WGPU_RESOURCE_CLASS = Object.freeze({
  NONE: 0,
  SHADER: 1,
  PIPELINE: 2,
  BUFFER: 3,
  TEXTURE: 4,
  SAMPLER: 5,
  BIND_GROUP: 6,
  FRAMEBUFFER: 7
});

export const WGPU_LEGACY_COMMAND_OPCODE = Object.freeze({
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
  BLIT_TEXTURE: 24
});

const COMMAND_WORDS = 8;
const COMMAND_BYTES = COMMAND_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const MAX_U32 = 0xFFFF_FFFF;
const EMPTY_PAYLOAD_BYTES = new Uint8Array(0);

/**
 * Decode one fixed-size legacy command into its transport-independent form.
 *
 * `record` is either an eight-word Uint32Array or an exact 32-byte byte view.
 * `heapBytes` is required only for commands which declare a blob/upload span.
 * Returned payload bytes are an exact view of that declared span; callers
 * which need an immutable snapshot must copy the view before producer reuse.
 */
export function decodeLegacyWgpuCommandRecord(
  record,
  heapBytes = null,
  { payloadBytes: retainedPayloadBytes = null } = {}
) {
  const words = readCommandWords(record);
  const opcode = words[0];
  const u = (index) => words[index + 1];
  const payload = (pointer, length, label) => retainedPayloadBytes == null
    ? declaredPayloadView(heapBytes, pointer, length, label)
    : retainedPayloadView(retainedPayloadBytes, length, label);
  const result = (resourceClass, resourceId, args, payloadBytes = EMPTY_PAYLOAD_BYTES) => ({
    kind: WGPU_SEMANTIC_EVENT_KIND.COMMAND,
    opcode,
    resourceClass,
    resourceId,
    args,
    payloadBytes
  });

  // Keep this switch exhaustive and independent from the replay executor.
  // Argument order is the canonical semantic ABI, not the physical record
  // layout. In particular, transport pointers are never copied into args.
  switch (opcode) {
    case WGPU_LEGACY_COMMAND_OPCODE.NOP:
      return result(WGPU_RESOURCE_CLASS.NONE, 0, []);

    case WGPU_LEGACY_COMMAND_OPCODE.CLEAR:
      return result(WGPU_RESOURCE_CLASS.NONE, 0, [u(0), u(1), u(2), u(3)]);

    case WGPU_LEGACY_COMMAND_OPCODE.CREATE_SHADER: {
      const id = requireResourceId(u(0), "CREATE_SHADER");
      const payloadBytes = payload(u(1), u(2), "CREATE_SHADER");
      return result(WGPU_RESOURCE_CLASS.SHADER, id, [id, u(3)], payloadBytes);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.CREATE_PIPELINE: {
      const id = requireResourceId(u(0), "CREATE_PIPELINE");
      requireResourceId(u(1), "CREATE_PIPELINE vertex shader");
      requireResourceId(u(2), "CREATE_PIPELINE fragment shader");
      return result(WGPU_RESOURCE_CLASS.PIPELINE, id, [id, u(1), u(2), u(3)]);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.DRAW_TEST: {
      const pipelineId = requireResourceId(u(0), "DRAW_TEST pipeline");
      return result(WGPU_RESOURCE_CLASS.PIPELINE, pipelineId, [pipelineId, u(1)]);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.CREATE_BUFFER: {
      const id = requireResourceId(u(0), "CREATE_BUFFER");
      return result(WGPU_RESOURCE_CLASS.BUFFER, id, [id, u(1), u(2)]);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.UPLOAD_BUFFER: {
      const id = requireResourceId(u(0), "UPLOAD_BUFFER");
      const length = requirePositive(u(3), "UPLOAD_BUFFER length");
      const uploadRole = u(4);
      if (uploadRole > 6) {
        throw new RangeError(`UPLOAD_BUFFER role ${uploadRole} is outside the protocol ABI`);
      }
      const payloadBytes = payload(u(2), length, "UPLOAD_BUFFER");
      return result(
        WGPU_RESOURCE_CLASS.BUFFER,
        id,
        [id, u(1), length, uploadRole],
        payloadBytes
      );
    }

    case WGPU_LEGACY_COMMAND_OPCODE.CREATE_TEXTURE: {
      const id = requireResourceId(u(0), "CREATE_TEXTURE");
      requirePositive(u(1), "CREATE_TEXTURE width");
      requirePositive(u(2), "CREATE_TEXTURE height");
      requirePositive(u(5), "CREATE_TEXTURE layers");
      // The reserved last word was zero in old records, meaning one mip.
      // Keep their canonical arguments stable while retaining longer chains.
      const args = [id, u(1), u(2), u(3), u(4), u(5)];
      if (u(6) > 1) args.push(u(6));
      return result(
        WGPU_RESOURCE_CLASS.TEXTURE,
        id,
        args
      );
    }

    case WGPU_LEGACY_COMMAND_OPCODE.UPLOAD_TEXTURE: {
      const id = requireResourceId(u(0), "UPLOAD_TEXTURE");
      const bytesPerRow = requirePositive(u(2), "UPLOAD_TEXTURE bytes-per-row");
      requirePositive(u(3), "UPLOAD_TEXTURE width");
      const height = requirePositive(u(4), "UPLOAD_TEXTURE height");
      const length = checkedU32Product(bytesPerRow, height, "UPLOAD_TEXTURE byte length");
      const payloadBytes = payload(u(1), length, "UPLOAD_TEXTURE");
      return result(
        WGPU_RESOURCE_CLASS.TEXTURE,
        id,
        [id, bytesPerRow, u(3), height, u(5), u(6)],
        payloadBytes
      );
    }

    case WGPU_LEGACY_COMMAND_OPCODE.CREATE_PIPELINE_CFG: {
      const id = requireResourceId(u(0), "CREATE_PIPELINE_CFG");
      const payloadBytes = payload(u(1), u(2), "CREATE_PIPELINE_CFG");
      return result(WGPU_RESOURCE_CLASS.PIPELINE, id, [id], payloadBytes);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.CREATE_SAMPLER: {
      const id = requireResourceId(u(0), "CREATE_SAMPLER");
      return result(WGPU_RESOURCE_CLASS.SAMPLER, id, [id, u(1)]);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.CREATE_BIND_GROUP: {
      const id = requireResourceId(u(0), "CREATE_BIND_GROUP");
      const payloadBytes = payload(u(1), u(2), "CREATE_BIND_GROUP");
      return result(WGPU_RESOURCE_CLASS.BIND_GROUP, id, [id, u(3)], payloadBytes);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.BEGIN_PASS:
      return result(
        WGPU_RESOURCE_CLASS.FRAMEBUFFER,
        u(0),
        [u(0), u(1), u(2), u(3), u(4), u(5), u(6)]
      );

    case WGPU_LEGACY_COMMAND_OPCODE.SET_PIPELINE: {
      const id = requireResourceId(u(0), "SET_PIPELINE");
      return result(WGPU_RESOURCE_CLASS.PIPELINE, id, [id]);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.SET_BIND_GROUP: {
      const id = requireResourceId(u(1), "SET_BIND_GROUP");
      const dynamicOffsetCount = u(2);
      if (dynamicOffsetCount > 4) {
        throw new RangeError(
          `SET_BIND_GROUP dynamic offset count ${dynamicOffsetCount} exceeds record capacity`
        );
      }
      return result(
        WGPU_RESOURCE_CLASS.BIND_GROUP,
        id,
        [u(0), id, dynamicOffsetCount, ...words.slice(4, 4 + dynamicOffsetCount)]
      );
    }

    case WGPU_LEGACY_COMMAND_OPCODE.SET_VERTEX_BUFFER: {
      const id = requireResourceId(u(1), "SET_VERTEX_BUFFER");
      return result(WGPU_RESOURCE_CLASS.BUFFER, id, [u(0), id, u(2)]);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.SET_INDEX_BUFFER: {
      const id = requireResourceId(u(0), "SET_INDEX_BUFFER");
      return result(WGPU_RESOURCE_CLASS.BUFFER, id, [id, u(1), u(2)]);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.SET_VIEWPORT:
      return result(
        WGPU_RESOURCE_CLASS.NONE,
        0,
        [u(0), u(1), u(2), u(3), u(4), u(5)]
      );

    case WGPU_LEGACY_COMMAND_OPCODE.SET_SCISSOR:
      return result(WGPU_RESOURCE_CLASS.NONE, 0, [u(0), u(1), u(2), u(3)]);

    case WGPU_LEGACY_COMMAND_OPCODE.DRAW:
      requirePositive(u(0), "DRAW vertex count");
      return result(WGPU_RESOURCE_CLASS.NONE, 0, [u(0), u(1), u(2)]);

    case WGPU_LEGACY_COMMAND_OPCODE.DRAW_INDEXED:
      requirePositive(u(0), "DRAW_INDEXED index count");
      return result(WGPU_RESOURCE_CLASS.NONE, 0, [u(0), u(1), u(2), u(3)]);

    case WGPU_LEGACY_COMMAND_OPCODE.END_PASS:
    case WGPU_LEGACY_COMMAND_OPCODE.SUBMIT_PRESENT:
      return result(WGPU_RESOURCE_CLASS.NONE, 0, []);

    case WGPU_LEGACY_COMMAND_OPCODE.DESTROY: {
      const resourceClass = destroyResourceClass(u(0));
      const id = requireResourceId(u(1), "DESTROY");
      return result(resourceClass, id, [u(0), id]);
    }

    case WGPU_LEGACY_COMMAND_OPCODE.BLIT_TEXTURE: {
      const sourceId = requireResourceId(u(0), "BLIT_TEXTURE source");
      const destinationId = requireResourceId(u(1), "BLIT_TEXTURE destination");
      const srcX = low16(u(2));
      const srcY = high16(u(2));
      const srcW = low16(u(3));
      const srcH = high16(u(3));
      const dstX = low16(u(4));
      const dstY = high16(u(4));
      const dstW = low16(u(5));
      const dstH = high16(u(5));
      requirePositive(srcW, "BLIT_TEXTURE source width");
      requirePositive(srcH, "BLIT_TEXTURE source height");
      requirePositive(dstW, "BLIT_TEXTURE destination width");
      requirePositive(dstH, "BLIT_TEXTURE destination height");
      return result(WGPU_RESOURCE_CLASS.TEXTURE, sourceId, [
        sourceId,
        destinationId,
        srcX,
        srcY,
        srcW,
        srcH,
        dstX,
        dstY,
        dstW,
        dstH,
        u(6) & 0xFF,
        (u(6) >>> 8) & 0xFF,
        (u(6) >>> 16) & 0xFF,
        u(6) >>> 24
      ]);
    }

    default:
      throw new RangeError(`Unknown legacy WebGPU opcode ${opcode}`);
  }
}

function readCommandWords(record) {
  if (record instanceof Uint32Array) {
    if (record.length !== COMMAND_WORDS) {
      throw new RangeError(`Legacy WebGPU command record must contain ${COMMAND_WORDS} words`);
    }
    return Array.from(record, (word) => word >>> 0);
  }

  const bytes = asExactByteView(record, "Legacy WebGPU command record");
  if (bytes.byteLength !== COMMAND_BYTES) {
    throw new RangeError(`Legacy WebGPU command record must be ${COMMAND_BYTES} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from(
    { length: COMMAND_WORDS },
    (_, index) => view.getUint32(index * Uint32Array.BYTES_PER_ELEMENT, true)
  );
}

function declaredPayloadView(heapBytes, pointer, lengthValue, label) {
  const length = requirePositive(lengthValue, `${label} payload length`);
  if (pointer === 0) throw new RangeError(`${label} payload pointer is zero`);
  const heap = asExactByteView(heapBytes, `${label} heap`);
  if (pointer > heap.byteLength || length > heap.byteLength - pointer) {
    throw new RangeError(
      `${label} payload span [${pointer}, ${pointer + length}) exceeds heap size ${heap.byteLength}`
    );
  }
  return heap.subarray(pointer, pointer + length);
}

function retainedPayloadView(payloadBytes, lengthValue, label) {
  const length = requirePositive(lengthValue, `${label} payload length`);
  const payload = asExactByteView(payloadBytes, `${label} retained payload`);
  if (payload.byteLength !== length) {
    throw new RangeError(
      `${label} retained payload length ${payload.byteLength} != declared ${length}`
    );
  }
  return payload;
}

function asExactByteView(value, label) {
  if (value instanceof Uint8Array) return value;
  if (isArrayBuffer(value)) return new Uint8Array(value);
  throw new TypeError(`${label} must be a Uint8Array or ArrayBuffer`);
}

function isArrayBuffer(value) {
  return value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer);
}

function requireResourceId(value, label) {
  if (value === 0) throw new RangeError(`${label} resource id is zero`);
  return value;
}

function requirePositive(value, label) {
  if (value === 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function checkedU32Product(left, right, label) {
  const product = left * right;
  if (!Number.isSafeInteger(product) || product > MAX_U32) {
    throw new RangeError(`${label} overflows u32 (${left} * ${right})`);
  }
  return product;
}

function destroyResourceClass(classTag) {
  switch (classTag) {
    case 1:
      return WGPU_RESOURCE_CLASS.BUFFER;
    case 2:
      return WGPU_RESOURCE_CLASS.TEXTURE;
    case 3:
      return WGPU_RESOURCE_CLASS.BIND_GROUP;
    default:
      throw new RangeError(`DESTROY resource class tag ${classTag} is unsupported`);
  }
}

function low16(value) {
  return value & 0xFFFF;
}

function high16(value) {
  return value >>> 16;
}
