import type { EmulatorCore, GamePlatform } from './platforms.ts'

/** Historical default and backup producer ID retained for GBA/GB/GBC compatibility. */
export const BUNDLED_CORE_ID =
  'mgba-wasm@2.5.1:c4c647d455840df684396b0a03833c1c2332793b73fabbba37d64323ad0c4c8d'

export interface CoreBuildDefinition {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly artifactSha256: string
  readonly stateFormat: string
  readonly stateCompatibility: 'exact-build'
}

export const CORE_REGISTRY = {
  mgba: {
    id: BUNDLED_CORE_ID,
    name: 'mGBA WebAssembly',
    version: '2.5.1',
    artifactSha256: 'c4c647d455840df684396b0a03833c1c2332793b73fabbba37d64323ad0c4c8d',
    stateFormat: 'mgba-native-state@2.5.1',
    stateCompatibility: 'exact-build',
  },
  fceumm: {
    id: 'fceumm@4.2.3:f1054b094e7149fd6278485bc1b2e51ff75c5259048ddb1134171e53d651f239',
    name: 'FCEUmm',
    version: '4.2.3',
    artifactSha256: 'f1054b094e7149fd6278485bc1b2e51ff75c5259048ddb1134171e53d651f239',
    stateFormat: 'emulatorjs-fceumm-state@4.2.3',
    stateCompatibility: 'exact-build',
  },
  snes9x: {
    id: 'snes9x@4.2.3:7d427a575cefad98ff400493fa1d7e892da63fe7bab68979babd9cea0bfaaf3b',
    name: 'Snes9x',
    version: '4.2.3',
    artifactSha256: '7d427a575cefad98ff400493fa1d7e892da63fe7bab68979babd9cea0bfaaf3b',
    stateFormat: 'emulatorjs-snes9x-state@4.2.3',
    stateCompatibility: 'exact-build',
  },
  dolphin: {
    id: 'dolphin-wasm@e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1:sha256-d7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c',
    name: 'Dolphin WebAssembly',
    version: 'e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1',
    artifactSha256: 'd7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c',
    stateFormat: 'dolphin-wasm-state@e22551e',
    stateCompatibility: 'exact-build',
  },
} as const satisfies Record<EmulatorCore, CoreBuildDefinition>

export const CORE_ID_BY_PLATFORM: Readonly<Record<GamePlatform, string>> = {
  gba: CORE_REGISTRY.mgba.id,
  gb: CORE_REGISTRY.mgba.id,
  gbc: CORE_REGISTRY.mgba.id,
  nes: CORE_REGISTRY.fceumm.id,
  snes: CORE_REGISTRY.snes9x.id,
  gamecube: CORE_REGISTRY.dolphin.id,
}

export function coreIdForPlatform(platform: GamePlatform): string {
  return CORE_ID_BY_PLATFORM[platform]
}
