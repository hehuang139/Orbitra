export type EmulatorButton =
  'A' | 'B' | 'X' | 'Y' | 'L' | 'R' | 'Z' | 'Start' | 'Select' | 'Up' | 'Down' | 'Left' | 'Right'

export const PLATFORM_CAPABILITIES = [
  'saveStates',
  'batterySaves',
  'rewind',
  'screenshots',
  'speedControl',
  'cheats',
  'patches',
  'shaders',
  'recording',
  'multiplayer',
  'rtc',
  'motion',
  'rumble',
  'microphone',
] as const

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number]
export type EmulatorCore = 'mgba' | 'fceumm' | 'snes9x' | 'dolphin'
export type PlatformCapabilities = Readonly<Record<PlatformCapability, boolean>>

const CLASSIC_CORE_CAPABILITIES = {
  saveStates: true,
  batterySaves: true,
  rewind: true,
  screenshots: true,
  speedControl: true,
  cheats: true,
  patches: false,
  shaders: false,
  recording: false,
  multiplayer: false,
  rtc: false,
  motion: false,
  rumble: false,
  microphone: false,
} as const satisfies PlatformCapabilities

export const CORE_CAPABILITIES = {
  mgba: CLASSIC_CORE_CAPABILITIES,
  fceumm: CLASSIC_CORE_CAPABILITIES,
  snes9x: CLASSIC_CORE_CAPABILITIES,
  dolphin: {
    saveStates: true,
    batterySaves: false,
    rewind: false,
    screenshots: false,
    speedControl: false,
    cheats: false,
    patches: false,
    shaders: false,
    recording: false,
    multiplayer: false,
    rtc: false,
    motion: false,
    rumble: false,
    microphone: false,
  },
} as const satisfies Record<EmulatorCore, PlatformCapabilities>

export interface PlatformDefinition {
  readonly id: string
  readonly extensions: readonly string[]
  readonly label: string
  readonly name: string
  readonly core: EmulatorCore
  readonly nativeWidth: number
  readonly nativeHeight: number
  readonly minRomSize: number
  readonly maxRomSize: number
  readonly buttons: readonly EmulatorButton[]
  readonly capabilities: PlatformCapabilities
  readonly experimental?: boolean
}

/** Shared hardware and import capabilities for every emulated platform. */
export const PLATFORM_REGISTRY = {
  gba: {
    id: 'gba',
    extensions: ['.gba'],
    label: 'GBA',
    name: 'Game Boy Advance',
    core: 'mgba',
    nativeWidth: 240,
    nativeHeight: 160,
    minRomSize: 192,
    maxRomSize: 32 * 1024 * 1024,
    buttons: ['A', 'B', 'L', 'R', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right'],
    capabilities: CORE_CAPABILITIES.mgba,
  },
  gb: {
    id: 'gb',
    extensions: ['.gb'],
    label: 'GB',
    name: 'Game Boy',
    core: 'mgba',
    nativeWidth: 160,
    nativeHeight: 144,
    minRomSize: 32 * 1024,
    maxRomSize: 8 * 1024 * 1024,
    buttons: ['A', 'B', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right'],
    capabilities: CORE_CAPABILITIES.mgba,
  },
  gbc: {
    id: 'gbc',
    extensions: ['.gbc'],
    label: 'GBC',
    name: 'Game Boy Color',
    core: 'mgba',
    nativeWidth: 160,
    nativeHeight: 144,
    minRomSize: 32 * 1024,
    maxRomSize: 8 * 1024 * 1024,
    buttons: ['A', 'B', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right'],
    capabilities: CORE_CAPABILITIES.mgba,
  },
  nes: {
    id: 'nes',
    extensions: ['.nes'],
    label: 'FC',
    name: 'Famicom / NES',
    core: 'fceumm',
    nativeWidth: 256,
    nativeHeight: 240,
    minRomSize: 16 * 1024 + 16,
    maxRomSize: 8 * 1024 * 1024,
    buttons: ['A', 'B', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right'],
    capabilities: CORE_CAPABILITIES.fceumm,
  },
  snes: {
    id: 'snes',
    extensions: ['.sfc', '.smc'],
    label: 'SFC',
    name: 'Super Famicom / SNES',
    core: 'snes9x',
    nativeWidth: 256,
    nativeHeight: 224,
    minRomSize: 32 * 1024,
    maxRomSize: 16 * 1024 * 1024,
    buttons: ['A', 'B', 'X', 'Y', 'L', 'R', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right'],
    capabilities: CORE_CAPABILITIES.snes9x,
  },
  gamecube: {
    id: 'gamecube',
    extensions: ['.iso', '.gcm'],
    label: 'GC',
    name: 'Nintendo GameCube (Experimental)',
    core: 'dolphin',
    nativeWidth: 640,
    nativeHeight: 480,
    minRomSize: 32 * 1024,
    maxRomSize: 1_459_978_240,
    buttons: ['A', 'B', 'X', 'Y', 'L', 'R', 'Z', 'Start', 'Up', 'Down', 'Left', 'Right'],
    capabilities: CORE_CAPABILITIES.dolphin,
    experimental: true,
  },
} as const satisfies Record<string, PlatformDefinition>

export type GamePlatform = keyof typeof PLATFORM_REGISTRY

export const PLATFORM_LIST = Object.values(PLATFORM_REGISTRY)
export const ROM_FILE_EXTENSIONS = PLATFORM_LIST.flatMap((platform) => platform.extensions)

export function isGamePlatform(value: unknown): value is GamePlatform {
  return typeof value === 'string' && Object.hasOwn(PLATFORM_REGISTRY, value)
}

export function platformFromFilename(filename: string): GamePlatform | undefined {
  const lower = filename.toLowerCase()
  return PLATFORM_LIST.find((platform) =>
    platform.extensions.some((extension) => lower.endsWith(extension)),
  )?.id
}

export function platformSupportsButton(platform: GamePlatform, button: EmulatorButton): boolean {
  return PLATFORM_REGISTRY[platform].buttons.some((candidate) => candidate === button)
}

export function platformSupportsCapability(
  platform: GamePlatform,
  capability: PlatformCapability,
): boolean {
  return PLATFORM_REGISTRY[platform].capabilities[capability]
}
