// §28cg prebuilt JIT cache file format.
//
// Binary layout (little-endian throughout):
//
//   [8 bytes]  magic           "DOLPCACH" (0x44 0x4f 0x4c 0x50 0x43 0x41 0x43 0x48)
//   [4 bytes]  version         u32 (= 2)
//   [4 bytes]  fingerprintLen  u32
//   [N bytes]  fingerprint     UTF-8 bytes (matches buildFingerprint stored in IDB)
//   [4 bytes]  keySchemaLen    u32
//   [N bytes]  entryKeySchema  UTF-8 bytes (currently wasm-block-sha256-v1)
//   [4 bytes]  entryCount      u32
//   For each entry (sequential, no padding):
//     [4 bytes]  hashLen       u32
//     [hashLen]  hash          UTF-8 canonical SHA-256 key (same key as IDB)
//     [4 bytes]  dataLen       u32
//     [dataLen]  data          raw WASM bytes (same payload as IDB modules store)
//
// Rationale:
//   - Mirrors IDB-store semantics 1:1, so a load can just push values into IDB
//     and let the existing reconcileJitCacheWithBuild path async-compile them.
//   - Fingerprint embedded so a stale prebuilt file from a previous build is
//     rejected before it touches IDB (no risk of dirty mixed-build entries).
//   - Sequential layout: parser does one pass, allocating one Uint8Array view
//     per entry. No random access needed.
//   - No compression: the WASM bytes don't compress much (entropy is high in
//     the LEB128 + bytecode), and brotli at the HTTP layer will handle it.

export const PREBUILT_CACHE_MAGIC = new Uint8Array([
  0x44, 0x4f, 0x4c, 0x50, 0x43, 0x41, 0x43, 0x48
]);
import { JIT_CACHE_ENTRY_KEY_SCHEMA } from "./jit-cache-identity.js";

export const PREBUILT_CACHE_VERSION = 2;

// Encode a {fingerprint, entries: Map<hashHex, Uint8Array>} to a Uint8Array
// suitable for writing to disk / serving as a static asset.
export function encodePrebuiltCache({ fingerprint, entryKeySchema, entries }) {
  const fpBytes = new TextEncoder().encode(fingerprint || "");
  if (entryKeySchema !== JIT_CACHE_ENTRY_KEY_SCHEMA) {
    throw new Error(`prebuilt-jit-cache: unsupported entry key schema ${entryKeySchema || "<missing>"}`);
  }
  const schemaBytes = new TextEncoder().encode(entryKeySchema);
  const entryList = [];
  let bodySize = 0;
  for (const [hash, data] of entries) {
    if (!String(hash).startsWith(`${entryKeySchema}:`)) {
      throw new Error(`prebuilt-jit-cache: entry key does not match ${entryKeySchema}`);
    }
    const hashBytes = new TextEncoder().encode(hash);
    const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    entryList.push({ hashBytes, dataBytes });
    bodySize += 4 + hashBytes.byteLength + 4 + dataBytes.byteLength;
  }
  const headerSize = 8 + 4 + 4 + fpBytes.byteLength + 4 + schemaBytes.byteLength + 4;
  const out = new Uint8Array(headerSize + bodySize);
  const view = new DataView(out.buffer);
  let off = 0;
  out.set(PREBUILT_CACHE_MAGIC, off); off += 8;
  view.setUint32(off, PREBUILT_CACHE_VERSION, true); off += 4;
  view.setUint32(off, fpBytes.byteLength, true); off += 4;
  out.set(fpBytes, off); off += fpBytes.byteLength;
  view.setUint32(off, schemaBytes.byteLength, true); off += 4;
  out.set(schemaBytes, off); off += schemaBytes.byteLength;
  view.setUint32(off, entryList.length, true); off += 4;
  for (const { hashBytes, dataBytes } of entryList) {
    view.setUint32(off, hashBytes.byteLength, true); off += 4;
    out.set(hashBytes, off); off += hashBytes.byteLength;
    view.setUint32(off, dataBytes.byteLength, true); off += 4;
    out.set(dataBytes, off); off += dataBytes.byteLength;
  }
  return out;
}

// Decode the binary format. Returns {fingerprint, entries: Array<{hash, bytes}>}.
// Throws on magic / version mismatch — caller treats as "no prebuilt cache."
export function decodePrebuiltCache(buffer) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer);
  if (bytes.byteLength < 20) {
    throw new Error("prebuilt-jit-cache: file too small for header");
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PREBUILT_CACHE_MAGIC[i]) {
      throw new Error("prebuilt-jit-cache: magic mismatch");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const requireBytes = (count) => {
    if (!Number.isSafeInteger(count) || count < 0 || off + count > bytes.byteLength) {
      throw new Error("prebuilt-jit-cache: truncated payload");
    }
  };
  const readU32 = () => {
    requireBytes(4);
    const value = view.getUint32(off, true);
    off += 4;
    return value;
  };
  let off = 8;
  const version = readU32();
  if (version !== PREBUILT_CACHE_VERSION) {
    throw new Error(`prebuilt-jit-cache: unsupported version ${version}`);
  }
  const fpLen = readU32();
  requireBytes(fpLen);
  const fingerprint = new TextDecoder().decode(
    bytes.subarray(off, off + fpLen)
  );
  off += fpLen;
  const schemaLen = readU32();
  requireBytes(schemaLen);
  const entryKeySchema = new TextDecoder().decode(bytes.subarray(off, off + schemaLen));
  off += schemaLen;
  if (entryKeySchema !== JIT_CACHE_ENTRY_KEY_SCHEMA) {
    throw new Error(`prebuilt-jit-cache: unsupported entry key schema ${entryKeySchema || "<missing>"}`);
  }
  const entryCount = readU32();
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const hashLen = readU32();
    requireBytes(hashLen);
    const hash = new TextDecoder().decode(bytes.subarray(off, off + hashLen));
    off += hashLen;
    const dataLen = readU32();
    requireBytes(dataLen);
    // Copy so the decoded payload survives any later buffer reuse.
    const data = bytes.slice(off, off + dataLen);
    off += dataLen;
    entries.push({ hash, bytes: data });
  }
  if (off !== bytes.byteLength) {
    throw new Error("prebuilt-jit-cache: trailing payload bytes");
  }
  return { fingerprint, entryKeySchema, entries };
}
