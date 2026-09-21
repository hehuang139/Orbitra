import type { EmulatorButton } from '../emulator'
import { defaultTouchConfig, normalizeTouchConfig } from './touch.ts'
import type { TouchConfig } from './touch.ts'

export type Settings = {
  volume: number
  speed: 1 | 2 | 4
  filter: 'pixel' | 'smooth' | 'crt'
  autoSave: boolean
  autoSaveInterval: 1 | 5 | 10
  touch: boolean
  touchConfig: TouchConfig
  bindings: Record<EmulatorButton, string>
}
export const defaultBindings: Record<EmulatorButton, string> = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  A: 'KeyX',
  B: 'KeyZ',
  X: 'KeyC',
  Y: 'KeyV',
  L: 'KeyA',
  R: 'KeyS',
  Z: 'KeyD',
  Start: 'Enter',
  Select: 'ShiftRight',
}
export const defaultSettings: Settings = {
  volume: 0.65,
  speed: 1,
  filter: 'pixel',
  autoSave: true,
  autoSaveInterval: 1,
  touch: false,
  touchConfig: defaultTouchConfig,
  bindings: defaultBindings,
}
export function isBindingCode(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Enter|Shift(Left|Right)|Bracket(Left|Right)|Semicolon|Quote|Comma|Period|Slash|Backslash|Minus|Equal|Backquote|Numpad[0-9])$/.test(
      code,
    )
  )
}

export function normalizeSettings(value: unknown): Settings {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const bindings = { ...defaultBindings }
  const rawBindings =
    raw.bindings && typeof raw.bindings === 'object'
      ? (raw.bindings as Record<string, unknown>)
      : null
  if (rawBindings) {
    for (const key of Object.keys(defaultBindings) as EmulatorButton[]) {
      const code = rawBindings[key]
      if (isBindingCode(code)) bindings[key] = code
    }
    // X/Y/Z did not exist before multi-console support. Preserve every legacy
    // binding and move only a newly supplied default when one is occupied.
    for (const key of ['X', 'Y', 'Z'] as const) {
      if (rawBindings[key] !== undefined) continue
      const occupied = new Set(
        Object.entries(bindings)
          .filter(([candidate]) => candidate !== key)
          .map(([, code]) => code),
      )
      if (occupied.has(bindings[key])) {
        bindings[key] = ['KeyC', 'KeyV', 'KeyB', 'KeyN', 'BracketLeft', 'BracketRight'].find(
          (code) => !occupied.has(code),
        )!
      }
    }
  }
  const unique = new Set(Object.values(bindings)).size === Object.keys(bindings).length
  return {
    volume:
      typeof raw.volume === 'number' && Number.isFinite(raw.volume)
        ? Math.max(0, Math.min(1, raw.volume))
        : 0.65,
    speed: raw.speed === 2 || raw.speed === 4 ? raw.speed : 1,
    filter: raw.filter === 'smooth' || raw.filter === 'crt' ? raw.filter : 'pixel',
    autoSave: raw.autoSave !== false,
    autoSaveInterval:
      raw.autoSaveInterval === 5 || raw.autoSaveInterval === 10 ? raw.autoSaveInterval : 1,
    touch: raw.touch === true,
    touchConfig: normalizeTouchConfig(raw.touchConfig),
    bindings: unique ? bindings : { ...defaultBindings },
  }
}
export function readSettings(): Settings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem('advance.settings') || '{}'))
  } catch {
    return normalizeSettings(null)
  }
}
export function keyLabel(code: string) {
  return (
    (
      {
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        Enter: 'Enter',
        ShiftRight: 'R Shift',
        ShiftLeft: 'L Shift',
        Space: 'Space',
      } as Record<string, string>
    )[code] || code.replace(/^Key|^Digit/, '')
  )
}
