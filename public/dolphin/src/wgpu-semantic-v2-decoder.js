// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// Independent decoder for the WDS2 semantic-event wire format. Constants and
// validation live here deliberately: importing the producer would make this
// decoder unable to detect a producer-side ABI drift.

const MAGIC = 0x32534457;
const VERSION = 2;
const MAX_ARGS = 4_096;
const MAX_DEPENDENCIES = 65_535;
const WORD_BYTES = 4;
const DEPENDENCY_WORDS = 6;
const DIGEST_BYTES = 32;
const FIXED_HEADER_WORDS = 13; // length plus twelve body words through arg count
const TRAILER_BYTES = WORD_BYTES + DIGEST_BYTES;
const MIN_FRAME_BYTES = FIXED_HEADER_WORDS * WORD_BYTES + WORD_BYTES + TRAILER_BYTES;
const COMMAND_KIND = 1;

const RESOURCE = Object.freeze({
  NONE: 0,
  SHADER: 1,
  PIPELINE: 2,
  BUFFER: 3,
  TEXTURE: 4,
  SAMPLER: 5,
  BIND_GROUP: 6,
  FRAMEBUFFER: 7,
});

const EMPTY_PAYLOAD_DIGEST = Object.freeze([
  0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14,
  0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9, 0x24,
  0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c,
  0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52, 0xb8, 0x55,
]);

const ROLE_BY_TAG = Object.freeze({
  1: Object.freeze({ role: "vertex-shader", classes: Object.freeze([1]), binding: false }),
  2: Object.freeze({ role: "fragment-shader", classes: Object.freeze([1]), binding: false }),
  3: Object.freeze({ role: "bind-entry", classes: Object.freeze([3, 4, 5]), binding: true }),
  4: Object.freeze({ role: "depth-attachment", classes: Object.freeze([4]), binding: false }),
  5: Object.freeze({ role: "blit-destination", classes: Object.freeze([4]), binding: false }),
});

/**
 * Decode one exact WDS2 frame.
 *
 * The returned object, argument list, dependency list, dependency objects, and
 * payload digest are frozen. The digest is represented as a frozen byte array
 * rather than a typed array because JavaScript typed-array elements cannot be
 * frozen.
 */
export function decodeWgpuSemanticEventV2(frame) {
  const bytes = exactBytes(frame);
  if (bytes.byteLength < MIN_FRAME_BYTES) {
    throw new RangeError(`WDS2 frame is truncated: ${bytes.byteLength} bytes`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bodyLength = view.getUint32(0, true);
  if (bodyLength !== bytes.byteLength - WORD_BYTES) {
    throw new RangeError(
      `WDS2 body length ${bodyLength} does not match exact frame length ${bytes.byteLength - WORD_BYTES}`
    );
  }
  if ((bodyLength & (WORD_BYTES - 1)) !== 0) {
    throw new RangeError("WDS2 body length must be four-byte aligned");
  }

  const magic = view.getUint32(4, true);
  if (magic !== MAGIC) {
    throw new RangeError(`WDS2 magic 0x${magic.toString(16)} is unsupported`);
  }
  const version = view.getUint32(8, true);
  if (version !== VERSION) {
    throw new RangeError(`WDS2 version ${version} is unsupported`);
  }

  const result = {
    kind: view.getUint32(12, true),
    epoch: view.getUint32(16, true),
    transaction: view.getUint32(20, true),
    sequenceLo: view.getUint32(24, true),
    sequenceHi: view.getUint32(28, true),
    opcode: view.getUint32(32, true),
    resourceClass: view.getUint32(36, true),
    resourceId: view.getUint32(40, true),
    generation: view.getUint32(44, true),
  };

  const argCount = view.getUint32(48, true);
  if (argCount > MAX_ARGS) {
    throw new RangeError(`WDS2 argument count ${argCount} exceeds ${MAX_ARGS}`);
  }
  const argsBytes = checkedProduct(argCount, WORD_BYTES, "argument byte count");
  let offset = checkedAdd(FIXED_HEADER_WORDS * WORD_BYTES, argsBytes, "argument boundary");
  requireRemaining(bytes, offset, WORD_BYTES + TRAILER_BYTES, "dependency count and trailer");

  const args = new Array(argCount);
  for (let index = 0; index < argCount; index += 1) {
    args[index] = view.getUint32(FIXED_HEADER_WORDS * WORD_BYTES + index * WORD_BYTES, true);
  }

  const dependencyCount = view.getUint32(offset, true);
  offset += WORD_BYTES;
  if (dependencyCount > MAX_DEPENDENCIES) {
    throw new RangeError(
      `WDS2 dependency count ${dependencyCount} exceeds ${MAX_DEPENDENCIES}`
    );
  }
  const dependencyBytes = checkedProduct(
    dependencyCount,
    DEPENDENCY_WORDS * WORD_BYTES,
    "dependency byte count"
  );
  const expectedEnd = checkedAdd(
    checkedAdd(offset, dependencyBytes, "dependency boundary"),
    TRAILER_BYTES,
    "WDS2 trailer boundary"
  );
  if (expectedEnd !== bytes.byteLength) {
    throw new RangeError(
      `WDS2 counts require ${expectedEnd} bytes but exact frame length is ${bytes.byteLength}`
    );
  }

  const dependencies = new Array(dependencyCount);
  for (let index = 0; index < dependencyCount; index += 1) {
    const roleTag = view.getUint32(offset, true);
    const resourceClass = view.getUint32(offset + 4, true);
    const resourceId = view.getUint32(offset + 8, true);
    const generation = view.getUint32(offset + 12, true);
    const bindingPresent = view.getUint32(offset + 16, true);
    const bindingWord = view.getUint32(offset + 20, true);
    offset += DEPENDENCY_WORDS * WORD_BYTES;

    const roleSpec = ROLE_BY_TAG[roleTag];
    if (!roleSpec) {
      throw new RangeError(`WDS2 dependency ${index} role tag ${roleTag} is unsupported`);
    }
    if (!roleSpec.classes.includes(resourceClass)) {
      throw new RangeError(
        `WDS2 dependency ${index} ${roleSpec.role} has incompatible resource class ${resourceClass}`
      );
    }
    if (resourceId === 0) {
      throw new RangeError(`WDS2 dependency ${index} resource id must be nonzero`);
    }
    if (generation === 0) {
      throw new RangeError(`WDS2 dependency ${index} generation must be nonzero`);
    }
    if (bindingPresent !== 0 && bindingPresent !== 1) {
      throw new RangeError(
        `WDS2 dependency ${index} binding-present word must be exactly 0 or 1`
      );
    }
    if (bindingPresent === 0 && bindingWord !== 0) {
      throw new RangeError(
        `WDS2 dependency ${index} absent binding word must be zero`
      );
    }
    if (roleSpec.binding !== (bindingPresent === 1)) {
      throw new RangeError(
        roleSpec.binding
          ? `WDS2 dependency ${index} bind-entry requires a binding`
          : `WDS2 dependency ${index} ${roleSpec.role} cannot carry a binding`
      );
    }

    const dependency = { role: roleSpec.role, roleTag, resourceClass, resourceId, generation };
    if (bindingPresent === 1) dependency.binding = bindingWord;
    dependencies[index] = Object.freeze(dependency);
  }

  result.args = Object.freeze(args);
  result.dependencies = Object.freeze(dependencies);
  result.payloadLength = view.getUint32(offset, true);
  offset += WORD_BYTES;
  result.payloadDigest = Object.freeze(Array.from(bytes.subarray(offset, offset + DIGEST_BYTES)));
  validateCanonicalCommand(result);
  return Object.freeze(result);
}

function validateCanonicalCommand(event) {
  if (event.kind !== COMMAND_KIND) {
    throw new RangeError(`WDS2 semantic event kind ${event.kind} is unsupported`);
  }
  if (event.opcode > 24) {
    throw new RangeError(`WDS2 command opcode ${event.opcode} is unsupported`);
  }

  switch (event.opcode) {
    case 0: // NOP
      requirePrimary(event, RESOURCE.NONE);
      requireArgs(event, 0);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 1: // CLEAR
      requirePrimary(event, RESOURCE.NONE);
      requireArgs(event, 4);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 2: // CREATE_SHADER
      requirePrimary(event, RESOURCE.SHADER, 0);
      requireArgs(event, 2);
      requirePositivePayload(event, "CREATE_SHADER");
      requireNoDependencies(event);
      break;

    case 3: // CREATE_PIPELINE
      requirePrimary(event, RESOURCE.PIPELINE, 0);
      requireArgs(event, 4);
      requireNoPayload(event);
      requirePipelineDependencies(event, true);
      break;

    case 4: // DRAW_TEST
      requirePrimary(event, RESOURCE.PIPELINE, 0);
      requireArgs(event, 2);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 5: // CREATE_BUFFER
      requirePrimary(event, RESOURCE.BUFFER, 0);
      requireArgs(event, 3);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 6: // UPLOAD_BUFFER
      requirePrimary(event, RESOURCE.BUFFER, 0);
      requireArgs(event, 4);
      requirePositiveArg(event, 2, "upload length");
      if (event.args[3] > 6) {
        throw new RangeError(`WDS2 opcode 6 upload role ${event.args[3]} is unsupported`);
      }
      requirePayloadLength(event, event.args[2], "UPLOAD_BUFFER");
      requireNoDependencies(event);
      break;

    case 7: // CREATE_TEXTURE
      requirePrimary(event, RESOURCE.TEXTURE, 0);
      // Six-argument packets predate mip counts and imply a single level.
      requireArgs(event, event.args.length === 7 ? 7 : 6);
      requirePositiveArg(event, 1, "width");
      requirePositiveArg(event, 2, "height");
      requirePositiveArg(event, 5, "layer count");
      if (event.args.length === 7) requirePositiveArg(event, 6, "mip level count");
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 8: { // UPLOAD_TEXTURE
      requirePrimary(event, RESOURCE.TEXTURE, 0);
      requireArgs(event, 6);
      requirePositiveArg(event, 1, "bytes per row");
      requirePositiveArg(event, 2, "width");
      requirePositiveArg(event, 3, "height");
      const length = checkedU32Product(event.args[1], event.args[3], "texture upload length");
      requirePayloadLength(event, length, "UPLOAD_TEXTURE");
      requireNoDependencies(event);
      break;
    }

    case 9: // CREATE_PIPELINE_CFG
      requirePrimary(event, RESOURCE.PIPELINE, 0);
      requireArgs(event, 1);
      if (event.payloadLength < 104 || (event.payloadLength - 104) % 12 !== 0) {
        throw new RangeError(
          `WDS2 CREATE_PIPELINE_CFG payload length ${event.payloadLength} is not canonical WPL3`
        );
      }
      requirePipelineDependencies(event, false);
      break;

    case 10: // CREATE_SAMPLER
      requirePrimary(event, RESOURCE.SAMPLER, 0);
      requireArgs(event, 2);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 11: { // CREATE_BIND_GROUP
      requirePrimary(event, RESOURCE.BIND_GROUP, 0);
      requireArgs(event, 2);
      if (event.args[1] > 2) {
        throw new RangeError(`WDS2 CREATE_BIND_GROUP group ${event.args[1]} is unsupported`);
      }
      const expectedPayload = checkedAdd(
        12,
        checkedProduct(event.dependencies.length, 20, "WBG1 entry byte count"),
        "WBG1 payload length"
      );
      requirePayloadLength(event, expectedPayload, "CREATE_BIND_GROUP");
      const bindings = new Set();
      for (let index = 0; index < event.dependencies.length; index += 1) {
        const dependency = event.dependencies[index];
        if (dependency.role !== "bind-entry") {
          throw new RangeError(
            `WDS2 CREATE_BIND_GROUP dependency ${index} must be a bind-entry`
          );
        }
        if (bindings.has(dependency.binding)) {
          throw new RangeError(
            `WDS2 CREATE_BIND_GROUP binding ${dependency.binding} is duplicated`
          );
        }
        bindings.add(dependency.binding);
      }
      break;
    }

    case 12: { // BEGIN_PASS
      requirePrimary(event, RESOURCE.FRAMEBUFFER, 0, { allowZeroId: true });
      requireArgs(event, 7);
      if (event.resourceId === 0 && event.generation !== 1) {
        throw new RangeError("WDS2 BEGIN_PASS virtual framebuffer generation must be 1");
      }
      if (event.args[5] !== 0 && event.args[5] !== 1) {
        throw new RangeError("WDS2 BEGIN_PASS load/clear flag must be exactly 0 or 1");
      }
      requireNoPayload(event);
      if (event.args[6] === 0) {
        requireNoDependencies(event);
      } else {
        requireOneDependency(event, "depth-attachment", event.args[6]);
      }
      break;
    }

    case 13: // SET_PIPELINE
      requirePrimary(event, RESOURCE.PIPELINE, 0);
      requireArgs(event, 1);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 14: { // SET_BIND_GROUP
      requirePrimary(event, RESOURCE.BIND_GROUP, 1);
      requireMinimumArgs(event, 3);
      if (event.args[0] > 2) {
        throw new RangeError(`WDS2 SET_BIND_GROUP group ${event.args[0]} is unsupported`);
      }
      const dynamicOffsetCount = event.args[2];
      if (dynamicOffsetCount > 4) {
        throw new RangeError(
          `WDS2 SET_BIND_GROUP dynamic offset count ${dynamicOffsetCount} exceeds 4`
        );
      }
      requireArgs(event, 3 + dynamicOffsetCount);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;
    }

    case 15: // SET_VERTEX_BUFFER
      requirePrimary(event, RESOURCE.BUFFER, 1);
      requireArgs(event, 3);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 16: // SET_INDEX_BUFFER
      requirePrimary(event, RESOURCE.BUFFER, 0);
      requireArgs(event, 3);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 17: // SET_VIEWPORT
      requirePrimary(event, RESOURCE.NONE);
      requireArgs(event, 6);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 18: // SET_SCISSOR
      requirePrimary(event, RESOURCE.NONE);
      requireArgs(event, 4);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 19: // DRAW
      requirePrimary(event, RESOURCE.NONE);
      requireArgs(event, 3);
      requirePositiveArg(event, 0, "vertex count");
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 20: // DRAW_INDEXED
      requirePrimary(event, RESOURCE.NONE);
      requireArgs(event, 4);
      requirePositiveArg(event, 0, "index count");
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 21: // END_PASS
    case 22: // SUBMIT_PRESENT
      requirePrimary(event, RESOURCE.NONE);
      requireArgs(event, 0);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;

    case 23: { // DESTROY
      requireArgs(event, 2);
      const expectedClass = event.args[0] === 1
        ? RESOURCE.BUFFER
        : event.args[0] === 2
          ? RESOURCE.TEXTURE
          : event.args[0] === 3
            ? RESOURCE.BIND_GROUP
            : 0;
      if (expectedClass === 0) {
        throw new RangeError(`WDS2 DESTROY class tag ${event.args[0]} is unsupported`);
      }
      requirePrimary(event, expectedClass, 1);
      requireNoPayload(event);
      requireNoDependencies(event);
      break;
    }

    case 24: // BLIT_TEXTURE
      requirePrimary(event, RESOURCE.TEXTURE, 0);
      requireArgs(event, 14);
      requirePositiveArg(event, 1, "destination resource id");
      requirePositiveArg(event, 4, "source width");
      requirePositiveArg(event, 5, "source height");
      requirePositiveArg(event, 8, "destination width");
      requirePositiveArg(event, 9, "destination height");
      for (let index = 10; index <= 13; index += 1) {
        if (event.args[index] > 0xff) {
          throw new RangeError(`WDS2 BLIT_TEXTURE channel argument ${index} exceeds one byte`);
        }
      }
      for (let index = 2; index <= 9; index += 1) {
        if (event.args[index] > 0xffff) {
          throw new RangeError(`WDS2 BLIT_TEXTURE argument ${index} exceeds packed u16`);
        }
      }
      for (let index = 10; index <= 13; index += 1) {
        if (event.args[index] > 0xff) {
          throw new RangeError(`WDS2 BLIT_TEXTURE argument ${index} exceeds packed u8`);
        }
      }
      requireNoPayload(event);
      requireOneDependency(event, "blit-destination", event.args[1]);
      break;
  }
}

function requirePrimary(event, resourceClass, argumentIndex = null, { allowZeroId = false } = {}) {
  if (event.resourceClass !== resourceClass) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} resource class ${event.resourceClass} must be ${resourceClass}`
    );
  }
  if (resourceClass === RESOURCE.NONE) {
    if (event.resourceId !== 0 || event.generation !== 0) {
      throw new RangeError(
        `WDS2 opcode ${event.opcode} resource-free primary id and generation must be zero`
      );
    }
    return;
  }
  if (!allowZeroId && event.resourceId === 0) {
    throw new RangeError(`WDS2 opcode ${event.opcode} primary resource id must be nonzero`);
  }
  if (event.generation === 0) {
    throw new RangeError(`WDS2 opcode ${event.opcode} primary generation must be nonzero`);
  }
  if (argumentIndex != null && event.args[argumentIndex] !== event.resourceId) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} primary id ${event.resourceId} does not match argument ${argumentIndex}`
    );
  }
}

function requireArgs(event, count) {
  if (event.args.length !== count) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} requires exactly ${count} arguments, received ${event.args.length}`
    );
  }
}

function requireMinimumArgs(event, count) {
  if (event.args.length < count) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} requires at least ${count} arguments, received ${event.args.length}`
    );
  }
}

function requirePositiveArg(event, index, label) {
  if (event.args[index] === 0) {
    throw new RangeError(`WDS2 opcode ${event.opcode} ${label} must be nonzero`);
  }
}

function requireNoPayload(event) {
  if (event.payloadLength !== 0) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} forbids payload length ${event.payloadLength}`
    );
  }
  if (!sameBytes(event.payloadDigest, EMPTY_PAYLOAD_DIGEST)) {
    throw new RangeError(`WDS2 opcode ${event.opcode} has a noncanonical empty-payload digest`);
  }
}

function requirePositivePayload(event, label) {
  if (event.payloadLength === 0) {
    throw new RangeError(`WDS2 ${label} requires a nonempty payload`);
  }
  if (sameBytes(event.payloadDigest, EMPTY_PAYLOAD_DIGEST)) {
    throw new RangeError(`WDS2 ${label} has an empty-payload digest for nonempty content`);
  }
}

function requirePayloadLength(event, expected, label) {
  if (event.payloadLength !== expected) {
    throw new RangeError(
      `WDS2 ${label} payload length ${event.payloadLength} must be ${expected}`
    );
  }
  if (expected === 0) requireNoPayload(event);
  else requirePositivePayload(event, label);
}

function requireNoDependencies(event) {
  if (event.dependencies.length !== 0) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} forbids ${event.dependencies.length} dependencies`
    );
  }
}

function requirePipelineDependencies(event, linkArguments) {
  if (event.dependencies.length !== 2) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} requires vertex and fragment shader dependencies`
    );
  }
  const vertex = event.dependencies[0];
  const fragment = event.dependencies[1];
  if (vertex.role !== "vertex-shader" || fragment.role !== "fragment-shader") {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} shader dependency order must be vertex then fragment`
    );
  }
  if (linkArguments && (vertex.resourceId !== event.args[1] || fragment.resourceId !== event.args[2])) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} shader dependencies do not match pipeline arguments`
    );
  }
}

function requireOneDependency(event, role, resourceId) {
  if (
    event.dependencies.length !== 1 ||
    event.dependencies[0].role !== role ||
    event.dependencies[0].resourceId !== resourceId
  ) {
    throw new RangeError(
      `WDS2 opcode ${event.opcode} requires one ${role} dependency linked to resource ${resourceId}`
    );
  }
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function checkedU32Product(left, right, label) {
  const product = checkedProduct(left, right, label);
  if (product > 0xffff_ffff) {
    throw new RangeError(`WDS2 ${label} overflows u32`);
  }
  return product;
}

function exactBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (isArrayBuffer(value)) return new Uint8Array(value);
  throw new TypeError("WDS2 frame must be a Uint8Array or ArrayBuffer");
}

function isArrayBuffer(value) {
  return value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer);
}

function checkedProduct(left, right, label) {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`WDS2 ${label} overflows safe integer arithmetic`);
  }
  return product;
}

function checkedAdd(left, right, label) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError(`WDS2 ${label} overflows safe integer arithmetic`);
  }
  return sum;
}

function requireRemaining(bytes, offset, required, label) {
  if (offset > bytes.byteLength || required > bytes.byteLength - offset) {
    throw new RangeError(`WDS2 frame is truncated before ${label}`);
  }
}
