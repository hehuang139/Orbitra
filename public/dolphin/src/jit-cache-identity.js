// Persistent PPC->WASM cache identity. These domains are part of the storage
// contract: changing either requires an IndexedDB/prebuilt format migration.
export const JIT_CACHE_ENTRY_KEY_SCHEMA = "wasm-block-sha256-v1";
export const JIT_CACHE_CORE_FINGERPRINT_SCHEMA = "dolphin-core-sha256-v1";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("JIT cache payload must be an ArrayBuffer or typed array");
}

export async function sha256Hex(value) {
  const bytes = asBytes(value);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalWasmBlockKey(bytes) {
  return `${JIT_CACHE_ENTRY_KEY_SCHEMA}:${await sha256Hex(bytes)}`;
}

export async function verifyCanonicalWasmBlockKey(claimedKey, bytes) {
  if (typeof claimedKey !== "string") return false;
  const prefix = `${JIT_CACHE_ENTRY_KEY_SCHEMA}:`;
  if (!claimedKey.startsWith(prefix) || !SHA256_HEX_RE.test(claimedKey.slice(prefix.length))) {
    return false;
  }
  return claimedKey === await canonicalWasmBlockKey(bytes);
}

export function canonicalCoreFingerprint(verifiedSha256) {
  const normalized = String(verifiedSha256 || "").toLowerCase();
  if (!SHA256_HEX_RE.test(normalized)) {
    throw new Error("Core fingerprint requires an exact verified SHA-256 digest");
  }
  return `${JIT_CACHE_CORE_FINGERPRINT_SCHEMA}:${normalized}`;
}

export function classifyJitCacheIdentity({
  storedFingerprint,
  storedEntryKeySchema,
  currentFingerprint
}) {
  if (!currentFingerprint) return { reset: true, reason: "missing-current-fingerprint" };
  if (!storedFingerprint) return { reset: true, reason: "missing-stored-fingerprint" };
  if (storedFingerprint !== currentFingerprint) return { reset: true, reason: "fingerprint-mismatch" };
  if (!storedEntryKeySchema) return { reset: true, reason: "missing-entry-key-schema" };
  if (storedEntryKeySchema !== JIT_CACHE_ENTRY_KEY_SCHEMA) {
    return { reset: true, reason: "entry-key-schema-mismatch" };
  }
  return { reset: false, reason: "match" };
}

