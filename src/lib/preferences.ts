import type { EmulatorButton } from '../emulator'
import { defaultTouchConfig, normalizeTouchConfig } from './touch.ts'
import type { TouchConfig } from './touch.ts'

export type Settings = {
  volume: number
  speed: 1 | 2 | 4
  filter: 'pixel' | 'smooth' | 'crt'
  autoSave: boolean
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
  L: 'KeyA',
  R: 'KeyS',
  Start: 'Enter',
  Select: 'ShiftRight',
}
export const defaultSettings: Settings = {
  volume: 0.65,
  speed: 1,
  filter: 'pixel',
  autoSave: true,
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
  if (raw.bindings && typeof raw.bindings === 'object') {
    for (const key of Object.keys(defaultBindings) as EmulatorButton[]) {
      const code = (raw.bindings as Record<string, unknown>)[key]
      if (isBindingCode(code)) bindings[key] = code
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
