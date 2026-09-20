// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const INCREMENTAL_SHA256_SNAPSHOT_SCHEMA =
  "wasm-dolphin.incremental-sha256.v1";

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class IncrementalSha256 {
  constructor(snapshot = null) {
    this._state = new Uint32Array(INITIAL_STATE);
    this._buffer = new Uint8Array(64);
    this._schedule = new Uint32Array(64);
    this._bufferLength = 0;
    this._bytesLow = 0;
    this._bytesHigh = 0;
    if (snapshot != null) this._restore(snapshot);
  }

  update(value) {
    const bytes = asBytes(value);
    const length = bytes.byteLength;
    if (length === 0) return this;
    const nextLowNumber = this._bytesLow + length;
    this._bytesLow = nextLowNumber >>> 0;
    this._bytesHigh = (
      this._bytesHigh + Math.floor(length / 0x100000000) +
      (nextLowNumber >= 0x100000000 ? 1 : 0)
    ) >>> 0;

    let offset = 0;
    if (this._bufferLength !== 0) {
      const copied = Math.min(64 - this._bufferLength, length);
      this._buffer.set(bytes.subarray(0, copied), this._bufferLength);
      this._bufferLength += copied;
      offset = copied;
      if (this._bufferLength === 64) {
        this._compress(this._buffer, 0);
        this._bufferLength = 0;
      }
    }
    while (offset + 64 <= length) {
      this._compress(bytes, offset);
      offset += 64;
    }
    if (offset < length) {
      this._buffer.set(bytes.subarray(offset), 0);
      this._bufferLength = length - offset;
    }
    return this;
  }

  clone() {
    return new IncrementalSha256(this.snapshot());
  }

  snapshot() {
    return {
      schema: INCREMENTAL_SHA256_SNAPSHOT_SCHEMA,
      state: Array.from(this._state),
      buffer: Array.from(this._buffer.subarray(0, this._bufferLength)),
      bufferLength: this._bufferLength,
      bytesLow: this._bytesLow,
      bytesHigh: this._bytesHigh,
    };
  }

  digest() {
    const copy = this.clone();
    const buffer = copy._buffer;
    let used = copy._bufferLength;
    buffer[used++] = 0x80;
    if (used > 56) {
      buffer.fill(0, used, 64);
      copy._compress(buffer, 0);
      used = 0;
    }
    buffer.fill(0, used, 56);
    const bitHigh = ((copy._bytesHigh << 3) | (copy._bytesLow >>> 29)) >>> 0;
    const bitLow = (copy._bytesLow << 3) >>> 0;
    writeU32Be(buffer, 56, bitHigh);
    writeU32Be(buffer, 60, bitLow);
    copy._compress(buffer, 0);
    const result = new Uint8Array(32);
    for (let index = 0; index < 8; index += 1) {
      writeU32Be(result, index * 4, copy._state[index]);
    }
    return result;
  }

  digestHex() {
    return bytesToHex(this.digest());
  }

  _restore(snapshot) {
    if (snapshot?.schema !== INCREMENTAL_SHA256_SNAPSHOT_SCHEMA) {
      throw new TypeError("unsupported SHA-256 snapshot schema");
    }
    const state = snapshot.state;
    const buffer = snapshot.buffer;
    const bufferLength = Number(snapshot.bufferLength);
    if (!Array.isArray(state) || state.length !== 8 ||
        !state.every(isU32)) {
      throw new TypeError("invalid SHA-256 snapshot state");
    }
    if (!Array.isArray(buffer) || !Number.isInteger(bufferLength) ||
        bufferLength < 0 || bufferLength >= 64 || buffer.length !== bufferLength ||
        !buffer.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      throw new TypeError("invalid SHA-256 snapshot buffer");
    }
    if (!isU32(snapshot.bytesLow) || !isU32(snapshot.bytesHigh)) {
      throw new TypeError("invalid SHA-256 snapshot length");
    }
    if ((snapshot.bytesLow & 63) !== bufferLength) {
      throw new TypeError("SHA-256 snapshot length does not match buffered bytes");
    }
    this._state.set(state);
    this._buffer.set(buffer);
    this._bufferLength = bufferLength;
    this._bytesLow = snapshot.bytesLow >>> 0;
    this._bytesHigh = snapshot.bytesHigh >>> 0;
  }

  _compress(bytes, offset) {
    const words = this._schedule;
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] = (
        (bytes[base] << 24) |
        (bytes[base + 1] << 16) |
        (bytes[base + 2] << 8) |
        bytes[base + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const sigma1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      words[index] = (
        words[index - 16] + sigma0 + words[index - 7] + sigma1
      ) >>> 0;
    }

    let a = this._state[0];
    let b = this._state[1];
    let c = this._state[2];
    let d = this._state[3];
    let e = this._state[4];
    let f = this._state[5];
    let g = this._state[6];
    let h = this._state[7];
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + upperSigma1 + choose + ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const upperSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this._state[0] = (this._state[0] + a) >>> 0;
    this._state[1] = (this._state[1] + b) >>> 0;
    this._state[2] = (this._state[2] + c) >>> 0;
    this._state[3] = (this._state[3] + d) >>> 0;
    this._state[4] = (this._state[4] + e) >>> 0;
    this._state[5] = (this._state[5] + f) >>> 0;
    this._state[6] = (this._state[6] + g) >>> 0;
    this._state[7] = (this._state[7] + h) >>> 0;
  }
}

export function sha256(value) {
  return new IncrementalSha256().update(value).digest();
}

export function sha256Hex(value) {
  return new IncrementalSha256().update(value).digestHex();
}

export function bytesToHex(bytes) {
  let result = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    result += bytes[index].toString(16).padStart(2, "0");
  }
  return result;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("SHA-256 input must be an ArrayBuffer or ArrayBuffer view");
}

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function writeU32Be(target, offset, value) {
  target[offset] = value >>> 24;
  target[offset + 1] = value >>> 16;
  target[offset + 2] = value >>> 8;
  target[offset + 3] = value;
}

function isU32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
