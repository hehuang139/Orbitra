import type { GamePlatform } from './platforms.ts'

/** Historical default and backup producer ID retained for GBA/GB/GBC compatibility. */
export const BUNDLED_CORE_ID =
  'mgba-wasm@2.5.1:c4c647d455840df684396b0a03833c1c2332793b73fabbba37d64323ad0c4c8d'

export const CORE_ID_BY_PLATFORM: Readonly<Record<GamePlatform, string>> = {
  gba: BUNDLED_CORE_ID,
  gb: BUNDLED_CORE_ID,
  gbc: BUNDLED_CORE_ID,
  nes: 'fceumm@4.2.3:f1054b094e7149fd6278485bc1b2e51ff75c5259048ddb1134171e53d651f239',
  snes: 'snes9x@4.2.3:7d427a575cefad98ff400493fa1d7e892da63fe7bab68979babd9cea0bfaaf3b',
}

export function coreIdForPlatform(platform: GamePlatform): string {
  return CORE_ID_BY_PLATFORM[platform]
}
