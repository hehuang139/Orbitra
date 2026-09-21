import type { GbaButton } from '../emulator'

export type TouchConfig = {
  layout: 'standard' | 'compact'
  mode: 'panel' | 'overlay'
  scale: number
  opacity: number
}

export const defaultTouchConfig: TouchConfig = {
  layout: 'standard',
  mode: 'panel',
  scale: 1,
  opacity: 1,
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback
}

export function normalizeTouchConfig(value: unknown): TouchConfig {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    layout: raw.layout === 'compact' ? 'compact' : 'standard',
    mode: raw.mode === 'overlay' ? 'overlay' : 'panel',
    scale: clamp(raw.scale, 0.8, 1.3, defaultTouchConfig.scale),
    opacity: clamp(raw.opacity, 0.4, 1, defaultTouchConfig.opacity),
  }
}

/** Several pointers or activation keys may hold the same emulated button. */
export function createTouchInput(
  onPress: (button: GbaButton) => void,
  onRelease: (button: GbaButton) => void,
) {
  const sources = new Map<string, GbaButton>()
  const buttons = new Map<GbaButton, number>()

  const release = (source: string) => {
    const button = sources.get(source)
    if (!button) return
    sources.delete(source)
    const remaining = (buttons.get(button) || 1) - 1
    if (remaining) buttons.set(button, remaining)
    else {
      buttons.delete(button)
      onRelease(button)
    }
  }

  return {
    press(source: string, button: GbaButton) {
      if (sources.get(source) === button) return
      release(source)
      sources.set(source, button)
      const held = buttons.get(button) || 0
      buttons.set(button, held + 1)
      if (!held) onPress(button)
    },
    release,
    releaseAll() {
      const held = [...buttons.keys()]
      sources.clear()
      buttons.clear()
      for (const button of held) onRelease(button)
    },
    pressedButtons: () => [...buttons.keys()],
  }
}
