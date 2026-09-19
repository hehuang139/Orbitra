export type EmulatorButton =
  'A' | 'B' | 'X' | 'Y' | 'L' | 'R' | 'Start' | 'Select' | 'Up' | 'Down' | 'Left' | 'Right'

export interface PlatformDefinition {
  readonly id: string
  readonly extensions: readonly string[]
  readonly label: string
  readonly name: string
  readonly core: 'mgba' | 'fceumm' | 'snes9x'
  readonly nativeWidth: number
  readonly nativeHeight: number
  readonly minRomSize: number
  readonly maxRomSize: number
  readonly buttons: readonly EmulatorButton[]
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
