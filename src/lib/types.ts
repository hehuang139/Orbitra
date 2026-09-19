import type { GamePlatform } from './platforms.ts'

export type { GamePlatform } from './platforms.ts'

/** Library metadata. Dates use epoch milliseconds; playTime uses seconds. */
export interface Game {
  id: string
  title: string
  filename: string
  platform: GamePlatform
  size: number
  addedAt: number
  lastPlayed: number | null
  playTime: number
  favorite: boolean
  color?: string
  /** Battery-only restoration takes precedence over an older automatic state. */
  skipAutoState?: boolean
}

export interface SaveState {
  id: string
  gameId: string
  slot: number
  data: Uint8Array
  screenshot?: string
  createdAt: number
  /** Absent on older records whose producing core was not recorded. */
  coreVersion?: string
}
