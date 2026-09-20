// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

const WRAP_MODES = ["clamp-to-edge", "repeat", "mirror-repeat"];

export function decodeWgpuSamplerState(packed) {
  const bits = packed >>> 0;
  // The original producer always sent an untagged shared linear/repeat sampler.
  if ((bits & 0x80000000) === 0) {
    return {
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      addressModeU: "repeat", addressModeV: "repeat",
    };
  }

  const maxLod = ((bits >>> 19) & 0xff) / 16;
  const anisotropy = 1 << Math.min((bits >>> 7) & 15, 4);
  // Dolphin keeps the mip filter at nearest when mipmaps are disabled. With
  // LOD clamped to zero, linear mip filtering selects the same texels and lets
  // WebGPU retain anisotropy without changing the requested min/mag filters.
  const linearMip = (bits & 4) !== 0 ||
    (anisotropy > 1 && (bits & 3) === 3 && maxLod === 0);
  return {
    minFilter: (bits & 1) ? "linear" : "nearest",
    magFilter: (bits & 2) ? "linear" : "nearest",
    mipmapFilter: linearMip ? "linear" : "nearest",
    addressModeU: WRAP_MODES[(bits >>> 3) & 3] ?? "clamp-to-edge",
    addressModeV: WRAP_MODES[(bits >>> 5) & 3] ?? "clamp-to-edge",
    lodMinClamp: Math.min(((bits >>> 11) & 0xff) / 16, maxLod),
    lodMaxClamp: maxLod,
    // WebGPU requires all three filters to be linear for anisotropy > 1.
    // Preserve requested point filters instead of silently replacing them.
    maxAnisotropy: (bits & 3) === 3 && linearMip ? anisotropy : 1,
  };
}
