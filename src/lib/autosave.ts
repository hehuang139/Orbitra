import type { Game, SaveState } from './types.ts'

export type AutoSaveSlotCount = 1 | 2 | 3

export const AUTO_SAVE_SLOTS = [0, 6, 7] as const
export const MANUAL_SAVE_SLOTS = [1, 2, 3, 4, 5] as const

export function automaticSlots(count: AutoSaveSlotCount): readonly number[] {
  return AUTO_SAVE_SLOTS.slice(0, count)
}

export function isAutomaticSlot(slot: number): boolean {
  return AUTO_SAVE_SLOTS.includes(slot as (typeof AUTO_SAVE_SLOTS)[number])
}

export function automaticSlotLabel(slot: number): string {
  const index = AUTO_SAVE_SLOTS.indexOf(slot as (typeof AUTO_SAVE_SLOTS)[number])
  return index < 0 ? `存档位 ${slot}` : `自动存档 ${index + 1}`
}

export function nextAutomaticSlot(
  states: readonly Pick<SaveState, 'slot' | 'createdAt'>[],
  count: AutoSaveSlotCount,
): number {
  const slots = automaticSlots(count)
  const stored = new Map(states.map((state) => [state.slot, state]))
  const empty = slots.find((slot) => !stored.has(slot))
  if (empty !== undefined) return empty
  return slots.reduce((oldest, slot) =>
    stored.get(slot)!.createdAt < stored.get(oldest)!.createdAt ? slot : oldest,
  )
}

export function latestAutomaticState<T extends Pick<SaveState, 'slot' | 'createdAt'>>(
  states: readonly T[],
  count: AutoSaveSlotCount,
): T | undefined {
  const slots = new Set(automaticSlots(count))
  return states
    .filter((state) => slots.has(state.slot))
    .reduce<T | undefined>(
      (latest, state) => (!latest || state.createdAt > latest.createdAt ? state : latest),
      undefined,
    )
}

export function mostRecentPlayedGame<T extends Pick<Game, 'lastPlayed' | 'addedAt'>>(
  games: readonly T[],
): T | undefined {
  return games.reduce<T | undefined>((recent, game) => {
    if (game.lastPlayed === null) return recent
    if (!recent) return game
    const recentTime = recent.lastPlayed ?? 0
    return game.lastPlayed > recentTime ||
      (game.lastPlayed === recentTime && game.addedAt > recent.addedAt)
      ? game
      : recent
  }, undefined)
}
