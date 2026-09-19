import type { GbaButton } from '../emulator/index.ts'

export const gbaButtons: GbaButton[] = [
  'Up',
  'Down',
  'Left',
  'Right',
  'A',
  'B',
  'X',
  'Y',
  'L',
  'R',
  'Start',
  'Select',
]
export const GAMEPAD_STORAGE_KEY = 'advance.gamepads.v1'
export const DEFAULT_DEADZONE = 0.45

export interface GamepadSnapshot {
  id: string
  index: number
  mapping: string
  connected: boolean
  buttons: readonly { pressed: boolean; value: number }[]
  axes: readonly number[]
}

export type GamepadBinding =
  { type: 'button'; index: number } | { type: 'axis'; index: number; direction: -1 | 1 }

export interface GamepadProfile {
  version: 1
  deadzone: number
  bindings: Record<GbaButton, GamepadBinding[]>
}

/** Index is deliberately excluded: reconnecting a device can change its browser slot. */
export function gamepadProfileKey(pad: GamepadSnapshot): string {
  return JSON.stringify([pad.id, pad.mapping, pad.buttons.length, pad.axes.length])
}

export function defaultGamepadProfile(pad: GamepadSnapshot): GamepadProfile {
  const bindings = {} as GamepadProfile['bindings']
  for (const key of gbaButtons) bindings[key] = []
  if (pad.mapping === 'standard') {
    const buttons: [number, GbaButton][] = [
      [0, 'A'],
      [1, 'B'],
      [2, 'X'],
      [3, 'Y'],
      [4, 'L'],
      [5, 'R'],
      [8, 'Select'],
      [9, 'Start'],
      [12, 'Up'],
      [13, 'Down'],
      [14, 'Left'],
      [15, 'Right'],
    ]
    for (const [index, key] of buttons) {
      if (index < pad.buttons.length) bindings[key].push({ type: 'button', index })
    }
    if (pad.axes.length > 0) {
      bindings.Left.push({ type: 'axis', index: 0, direction: -1 })
      bindings.Right.push({ type: 'axis', index: 0, direction: 1 })
    }
    if (pad.axes.length > 1) {
      bindings.Up.push({ type: 'axis', index: 1, direction: -1 })
      bindings.Down.push({ type: 'axis', index: 1, direction: 1 })
    }
  }
  return { version: 1, deadzone: DEFAULT_DEADZONE, bindings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validGamepadBinding(value: unknown, pad: GamepadSnapshot): value is GamepadBinding {
  if (!isRecord(value) || !Number.isInteger(value.index) || (value.index as number) < 0)
    return false
  if (value.type === 'button') return (value.index as number) < pad.buttons.length
  return (
    value.type === 'axis' &&
    (value.index as number) < pad.axes.length &&
    (value.direction === -1 || value.direction === 1)
  )
}

/** Reject an invalid profile as a whole, including mappings for a changed device layout. */
export function validateGamepadProfile(
  value: unknown,
  pad: GamepadSnapshot,
): GamepadProfile | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.deadzone !== 'number' ||
    !Number.isFinite(value.deadzone) ||
    value.deadzone < 0.1 ||
    value.deadzone > 0.9 ||
    !isRecord(value.bindings)
  )
    return null
  const bindingKeys = Object.keys(value.bindings)
  if (
    bindingKeys.some((key) => !gbaButtons.includes(key as GbaButton)) ||
    bindingKeys.some((key, index) => bindingKeys.indexOf(key) !== index) ||
    bindingKeys.length < gbaButtons.length - 2 ||
    bindingKeys.length > gbaButtons.length
  )
    return null
  const bindings = {} as GamepadProfile['bindings']
  for (const key of gbaButtons) {
    const entries = value.bindings[key] ?? (key === 'X' || key === 'Y' ? [] : undefined)
    if (
      !Array.isArray(entries) ||
      entries.length > 8 ||
      !entries.every((entry) => validGamepadBinding(entry, pad))
    )
      return null
    bindings[key] = entries.map((entry: GamepadBinding) =>
      entry.type === 'button'
        ? { type: 'button', index: entry.index }
        : { type: 'axis', index: entry.index, direction: entry.direction },
    )
  }
  return { version: 1, deadzone: value.deadzone, bindings }
}

export function decodeGamepadProfiles(text: string | null): Record<string, unknown> {
  if (!text || text.length > 262_144) return {}
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.profiles)) return {}
    return Object.fromEntries(Object.entries(value.profiles).slice(0, 128))
  } catch {
    return {}
  }
}

export function bindingId(binding: GamepadBinding): string {
  return binding.type === 'button'
    ? `button:${binding.index}`
    : `axis:${binding.index}:${binding.direction}`
}

export function bindingLabel(binding: GamepadBinding): string {
  return binding.type === 'button'
    ? `按键 ${binding.index + 1}`
    : `轴 ${binding.index + 1} ${binding.direction === -1 ? '−' : '+'}`
}

export function bindingPressed(
  pad: GamepadSnapshot,
  binding: GamepadBinding,
  deadzone: number,
): boolean {
  if (binding.type === 'button') {
    const button = pad.buttons[binding.index]
    return Boolean(
      button && (button.pressed || (Number.isFinite(button.value) && button.value > 0.5)),
    )
  }
  const value = pad.axes[binding.index]
  return Number.isFinite(value) && value * binding.direction > deadzone
}

export function mappedGamepadButtons(
  pad: GamepadSnapshot,
  profile: GamepadProfile,
): Set<GbaButton> {
  if (!pad.connected) return new Set()
  return new Set(
    gbaButtons.filter((key) =>
      profile.bindings[key].some((binding) => bindingPressed(pad, binding, profile.deadzone)),
    ),
  )
}

export function aggregateGamepadButtons(
  devices: readonly { pad: GamepadSnapshot; profile: GamepadProfile }[],
): Set<GbaButton> {
  const pressed = new Set<GbaButton>()
  for (const { pad, profile } of devices) {
    for (const key of mappedGamepadButtons(pad, profile)) pressed.add(key)
  }
  return pressed
}

export function diffGamepadButtons(previous: ReadonlySet<GbaButton>, next: ReadonlySet<GbaButton>) {
  return {
    released: [...previous].filter((key) => !next.has(key)),
    pressed: [...next].filter((key) => !previous.has(key)),
  }
}

function activeSources(pad: GamepadSnapshot, deadzone: number): GamepadBinding[] {
  const sources: GamepadBinding[] = []
  pad.buttons.forEach((_, index) => {
    const binding: GamepadBinding = { type: 'button', index }
    if (bindingPressed(pad, binding, deadzone)) sources.push(binding)
  })
  pad.axes.forEach((_, index) => {
    for (const direction of [-1, 1] as const) {
      const binding: GamepadBinding = { type: 'axis', index, direction }
      if (bindingPressed(pad, binding, Math.max(0.55, deadzone))) sources.push(binding)
    }
  })
  return sources
}

export interface GamepadCapture {
  /** Sources held before capture must be released before they can be captured. */
  blocked: Set<string>
}

export function beginGamepadCapture(pad: GamepadSnapshot, deadzone: number): GamepadCapture {
  return { blocked: new Set(activeSources(pad, deadzone).map(bindingId)) }
}

export function advanceGamepadCapture(
  pad: GamepadSnapshot,
  capture: GamepadCapture,
  deadzone: number,
) {
  const active = activeSources(pad, deadzone)
  const activeIds = new Set(active.map(bindingId))
  const blocked = new Set([...capture.blocked].filter((id) => activeIds.has(id)))
  return {
    capture: { blocked },
    binding: active.find((binding) => !blocked.has(bindingId(binding))) ?? null,
  }
}

/** A captured source has one logical owner, avoiding accidental simultaneous A/B presses. */
export function assignGamepadBinding(
  profile: GamepadProfile,
  target: GbaButton,
  binding: GamepadBinding,
) {
  const id = bindingId(binding)
  const displaced = gbaButtons.filter(
    (key) => key !== target && profile.bindings[key].some((entry) => bindingId(entry) === id),
  )
  const bindings = Object.fromEntries(
    gbaButtons.map((key) => [
      key,
      key === target ? [binding] : profile.bindings[key].filter((entry) => bindingId(entry) !== id),
    ]),
  ) as GamepadProfile['bindings']
  return { profile: { ...profile, bindings }, displaced }
}
