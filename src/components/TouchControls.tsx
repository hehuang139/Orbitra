import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import type { GbaButton } from '../emulator'
import { createTouchInput, normalizeTouchConfig } from '../lib/touch'
import type { TouchConfig } from '../lib/touch'
import './touch-controls.css'

const touchMedia = '(max-width: 650px), (pointer: coarse)'
const labels: Record<GbaButton, string> = {
  Up: '上',
  Down: '下',
  Left: '左',
  Right: '右',
  A: 'A 按钮',
  B: 'B 按钮',
  L: 'L 肩键',
  R: 'R 肩键',
  Start: '开始',
  Select: '选择',
}
const symbols: Partial<Record<GbaButton, string>> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Start: 'START',
  Select: 'SELECT',
}

export function TouchControls({
  config,
  buttons,
  visible,
  enabled,
  onPress,
  onRelease,
}: {
  config: TouchConfig
  buttons: readonly GbaButton[]
  visible: boolean
  enabled: boolean
  onPress: (button: GbaButton) => void
  onRelease: (button: GbaButton) => void
}) {
  const [automatic, setAutomatic] = useState(() => window.matchMedia(touchMedia).matches)
  const [pressed, setPressed] = useState<Set<GbaButton>>(() => new Set())
  const callbacks = useRef({ onPress, onRelease })
  callbacks.current = { onPress, onRelease }
  const input = useRef<ReturnType<typeof createTouchInput> | null>(null)
  if (!input.current) {
    input.current = createTouchInput(
      (button) => callbacks.current.onPress(button),
      (button) => callbacks.current.onRelease(button),
    )
  }
  const clickTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const clickSequence = useRef(0)
  const shown = visible || automatic
  const normalized = normalizeTouchConfig(config)
  const updatePressed = useCallback(() => setPressed(new Set(input.current!.pressedButtons())), [])
  const release = useCallback(
    (source: string) => {
      input.current!.release(source)
      updatePressed()
    },
    [updatePressed],
  )
  const releaseAll = useCallback(() => {
    input.current!.releaseAll()
    for (const timer of clickTimers.current) clearTimeout(timer)
    clickTimers.current.clear()
    updatePressed()
  }, [updatePressed])

  useEffect(() => {
    const media = window.matchMedia(touchMedia)
    const change = () => setAutomatic(media.matches)
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    if (!enabled || !shown) releaseAll()
  }, [enabled, shown, releaseAll])

  useEffect(releaseAll, [buttons, releaseAll])

  useEffect(() => {
    const pointerEnd = (event: globalThis.PointerEvent) => release(`pointer:${event.pointerId}`)
    const visibility = () => {
      if (document.hidden) releaseAll()
    }
    window.addEventListener('pointerup', pointerEnd)
    window.addEventListener('pointercancel', pointerEnd)
    window.addEventListener('blur', releaseAll)
    window.addEventListener('resize', releaseAll)
    window.addEventListener('orientationchange', releaseAll)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('pointerup', pointerEnd)
      window.removeEventListener('pointercancel', pointerEnd)
      window.removeEventListener('blur', releaseAll)
      window.removeEventListener('resize', releaseAll)
      window.removeEventListener('orientationchange', releaseAll)
      document.removeEventListener('visibilitychange', visibility)
      input.current!.releaseAll()
      for (const timer of clickTimers.current) clearTimeout(timer)
      clickTimers.current.clear()
    }
  }, [release, releaseAll])

  const pointerDown = (event: PointerEvent<HTMLButtonElement>, button: GbaButton) => {
    if (!enabled || !shown || event.button !== 0) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Global pointer listeners still release input when capture is unavailable.
    }
    input.current!.press(`pointer:${event.pointerId}`, button)
    updatePressed()
  }
  const activationKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    button: GbaButton,
    down: boolean,
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    const source = `keyboard:${button}:${event.key}`
    if (down && enabled && shown) input.current!.press(source, button)
    else input.current!.release(source)
    updatePressed()
  }

  const key = (button: GbaButton, className = '') => (
    <button
      type="button"
      className={`advance-touch-key ${className}${pressed.has(button) ? ' is-pressed' : ''}`}
      aria-label={labels[button]}
      disabled={!enabled}
      onPointerDown={(event) => pointerDown(event, button)}
      onPointerUp={(event) => release(`pointer:${event.pointerId}`)}
      onPointerCancel={(event) => release(`pointer:${event.pointerId}`)}
      onLostPointerCapture={(event) => release(`pointer:${event.pointerId}`)}
      onKeyDown={(event) => activationKey(event, button, true)}
      onKeyUp={(event) => activationKey(event, button, false)}
      onBlur={() => {
        release(`keyboard:${button}:Enter`)
        release(`keyboard:${button}: `)
      }}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        // Assistive technology can activate a native button without pointer/key events.
        if (event.detail !== 0 || !enabled || !shown) return
        const source = `activation:${++clickSequence.current}`
        input.current!.press(source, button)
        updatePressed()
        const timer = setTimeout(() => {
          clickTimers.current.delete(timer)
          release(source)
        }, 100)
        clickTimers.current.add(timer)
      }}
    >
      {symbols[button] || button}
    </button>
  )

  return (
    <div
      className="touch-controls advance-touch"
      role="group"
      aria-label="触屏游戏手柄"
      hidden={!shown}
      data-layout={normalized.layout}
      style={
        { '--tc-scale': normalized.scale, '--tc-opacity': normalized.opacity } as CSSProperties
      }
    >
      <div className="advance-touch-layout">
        {buttons.includes('L') || buttons.includes('R') ? (
          <div className="advance-touch-shoulders">
            {buttons.includes('L') ? key('L') : null}
            {buttons.includes('R') ? key('R') : null}
          </div>
        ) : null}
        <div className="advance-touch-dpad">
          {key('Up', 'advance-touch-up')}
          {key('Left', 'advance-touch-left')}
          {key('Right', 'advance-touch-right')}
          {key('Down', 'advance-touch-down')}
        </div>
        <div className="advance-touch-system">
          {key('Select')}
          {key('Start')}
        </div>
        <div className="advance-touch-action">
          {key('B')}
          {key('A')}
        </div>
      </div>
    </div>
  )
}
