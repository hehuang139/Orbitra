import {
  PLATFORM_REGISTRY,
  platformFromFilename,
  platformSupportsButton,
} from '../lib/platforms.ts'
import type { EmulatorButton } from '../lib/platforms.ts'
import type { Emulator, EmulatorOptions, EmulatorStatus, RomSource } from './index.ts'

const CORE_SHA256 = 'd7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c'

interface DolphinState {
  mask: number
  stickX: number
  stickY: number
  cStickX: number
  cStickY: number
  triggerLeft: number
  triggerRight: number
  analogA: number
  analogB: number
}

interface DolphinAdapter {
  worker: Worker | null
  presentationFps?: number
  mountGame(file: File): Promise<{ gameId?: string }>
  setInputState(state: DolphinState): void
  start(): void
  pause(): void
  reset(): void
  pollFrame(): void
  mixAudio(frames?: number): Promise<unknown>
  setAudioMuted(muted: boolean): void
  rejectAll(message: string): void
  saveStateFile(): Promise<{ saved: boolean; bytes?: ArrayBuffer; error?: string }>
  loadStateFile(bytes: Uint8Array): Promise<{ loaded: boolean; error?: string }>
}

interface AudioControllerLike {
  context: AudioContext | null
  setSource(source: (frames?: number) => Promise<unknown>): void
  setMuted(muted: boolean): Promise<boolean>
  setVolume(value: number): number
  stopPump(): void
}

type AdapterConstructor = new (options: Record<string, unknown>) => DolphinAdapter
type AudioConstructor = new () => AudioControllerLike

const BUTTON_MASK: Record<EmulatorButton, number> = {
  A: 1 << 0,
  B: 1 << 1,
  X: 1 << 2,
  Y: 1 << 3,
  Start: 1 << 4,
  L: 1 << 5,
  R: 1 << 6,
  Z: 1 << 7,
  Up: (1 << 8) | (1 << 12),
  Down: (1 << 9) | (1 << 13),
  Left: (1 << 10) | (1 << 14),
  Right: (1 << 11) | (1 << 15),
  Select: 0,
}

function fileFromSource(source: RomSource, name: string): File {
  return source instanceof File
    ? source
    : new File([source], name, { type: 'application/octet-stream' })
}

function assertPrerequisites(): void {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function')
    throw new Error(
      'GameCube 需要跨源隔离；请通过本站 HTTPS 地址打开，并确认 COOP/COEP 响应头有效。',
    )
  if (
    typeof Worker !== 'function' ||
    typeof HTMLCanvasElement !== 'function' ||
    !HTMLCanvasElement.prototype.transferControlToOffscreen
  )
    throw new Error(
      '当前浏览器不支持 GameCube 所需的 Worker OffscreenCanvas，请使用桌面版 Chromium。',
    )
}

/** Experimental browser adapter for the pinned wasm-dolphin worker runtime. */
export function createDolphinEmulator(
  focusCanvas: HTMLCanvasElement,
  options: EmulatorOptions = {},
): Emulator {
  let status: EmulatorStatus = 'idle'
  let romName: string | null = null
  let platform: 'gamecube' | null = null
  let adapter: DolphinAdapter | null = null
  let audio: AudioControllerLike | null = null
  let displayCanvas: HTMLCanvasElement | null = null
  let volume = 0.65
  let generation = 0
  let frameTimer: number | undefined
  const pressed = new Set<EmulatorButton>()

  const setStatus = (next: EmulatorStatus) => {
    if (status === 'disposed' || status === next) return
    status = next
    options.onStatus?.(next)
  }
  const isDisposed = () => status === 'disposed'
  const assertGame = () => {
    if (!adapter || !romName || (status !== 'running' && status !== 'paused'))
      throw new Error('请先载入一个 GameCube 游戏。')
    return adapter
  }
  const inputState = (): DolphinState => ({
    mask: [...pressed].reduce((mask, button) => mask | BUTTON_MASK[button], 0) >>> 0,
    stickX: pressed.has('Left') ? 0 : pressed.has('Right') ? 255 : 128,
    stickY: pressed.has('Up') ? 0 : pressed.has('Down') ? 255 : 128,
    cStickX: 128,
    cStickY: 128,
    triggerLeft: pressed.has('L') ? 255 : 0,
    triggerRight: pressed.has('R') ? 255 : 0,
    analogA: pressed.has('A') ? 255 : 0,
    analogB: pressed.has('B') ? 255 : 0,
  })
  const syncInput = () => adapter?.setInputState(inputState())
  const releaseAllKeys = () => {
    pressed.clear()
    syncInput()
  }
  const stopRuntime = () => {
    window.clearInterval(frameTimer)
    frameTimer = undefined
    releaseAllKeys()
    if (audio) {
      void audio.setMuted(true).catch(() => {})
      audio.stopPump()
      void audio.context?.close().catch(() => {})
      audio = null
    }
    if (adapter) {
      adapter.rejectAll('GameCube 模拟器已关闭。')
      adapter.worker?.terminate()
    }
    adapter = null
    displayCanvas?.remove()
    displayCanvas = null
  }

  const emulator: Emulator = {
    get status() {
      return status
    },
    get romName() {
      return romName
    },
    get platform() {
      return platform
    },
    get capabilities() {
      return platform ? PLATFORM_REGISTRY[platform].capabilities : null
    },
    get version() {
      return `Dolphin WebAssembly (experimental) · ${CORE_SHA256.slice(0, 12)}`
    },
    async loadRom(source, name, nextPlatform) {
      if (status === 'disposed') throw new Error('模拟器已关闭，请重新打开游戏。')
      const definition = PLATFORM_REGISTRY[nextPlatform]
      if (
        nextPlatform !== 'gamecube' ||
        definition.core !== 'dolphin' ||
        platformFromFilename(name) !== nextPlatform
      )
        throw new Error('游戏平台与文件格式不匹配，请重新导入 GameCube 光盘镜像。')
      const file = fileFromSource(source, name)
      if (file.size < definition.minRomSize || file.size > definition.maxRomSize)
        throw new Error('无效的 GameCube 光盘镜像：文件大小超出支持范围。')
      assertPrerequisites()
      const ticket = ++generation
      stopRuntime()
      romName = null
      platform = null
      setStatus('loading')
      try {
        options.onProgress?.('正在加载实验性 Dolphin 核心（约需 1.5 GiB 内存）…')
        const base = new URL(`${import.meta.env.BASE_URL}dolphin/`, window.location.href)
        const [{ UpstreamWorkerAdapter }, { AudioController }] = await Promise.all([
          import(
            /* @vite-ignore */ new URL('src/upstream-worker-adapter.js', base).href
          ) as Promise<{
            UpstreamWorkerAdapter: AdapterConstructor
          }>,
          import(/* @vite-ignore */ new URL('src/audio.js', base).href) as Promise<{
            AudioController: AudioConstructor
          }>,
        ])
        if (ticket !== generation || isDisposed()) throw new Error('游戏载入已取消。')
        displayCanvas = document.createElement('canvas')
        displayCanvas.className = 'dolphin-canvas'
        displayCanvas.width = definition.nativeWidth
        displayCanvas.height = definition.nativeHeight
        displayCanvas.addEventListener('pointerdown', () =>
          focusCanvas.focus({ preventScroll: true }),
        )
        focusCanvas.classList.add('dolphin-focus-canvas')
        focusCanvas.insertAdjacentElement('afterend', displayCanvas)
        const offscreen = displayCanvas.transferControlToOffscreen()
        adapter = new UpstreamWorkerAdapter({
          coreUrl: new URL('cores/dolphin/dolphin-core-upstream.js', base).href,
          expectedCoreSha256: CORE_SHA256,
          workerUrl: new URL('src/upstream-discio-worker.js', base).href,
          canvas: offscreen,
          videoBackend: 'Software Renderer',
          cpuCore: 'cached',
          onStatus: (message: string) => {
            if (/fail|error|abort/i.test(message)) console.warn('[Dolphin]', message)
          },
        })
        audio = new AudioController()
        audio.setSource((frames) => adapter!.mixAudio(frames))
        audio.setVolume(volume)
        options.onProgress?.('正在挂载 GameCube 光盘镜像…')
        await adapter.mountGame(file)
        if (ticket !== generation || isDisposed()) throw new Error('游戏载入已取消。')
        adapter.start()
        adapter.setAudioMuted(volume === 0)
        await audio.setMuted(volume === 0)
        romName = name
        platform = 'gamecube'
        setStatus('running')
        options.onProgress?.('')
        frameTimer = window.setInterval(() => {
          adapter?.pollFrame()
          options.onFps?.(Math.round(adapter?.presentationFps ?? 0))
        }, 500)
      } catch (value) {
        stopRuntime()
        focusCanvas.classList.remove('dolphin-focus-canvas')
        const error = value instanceof Error ? value : new Error(String(value))
        if (!isDisposed()) {
          setStatus('error')
          options.onError?.(error)
        }
        throw error
      }
    },
    start() {
      emulator.resume()
    },
    resume() {
      if (status !== 'paused') return
      assertGame().start()
      adapter?.setAudioMuted(volume === 0)
      void audio?.setMuted(volume === 0)
      setStatus('running')
    },
    pause() {
      if (status !== 'running') return
      releaseAllKeys()
      assertGame().pause()
      adapter?.setAudioMuted(true)
      void audio?.setMuted(true)
      options.onFps?.(0)
      setStatus('paused')
    },
    reset() {
      releaseAllKeys()
      assertGame().reset()
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
      audio?.setVolume(volume)
      adapter?.setAudioMuted(volume === 0 || status === 'paused')
      if (status === 'running') void audio?.setMuted(volume === 0)
    },
    setSpeed() {},
    keyDown(button) {
      if (status !== 'running' || !platformSupportsButton('gamecube', button)) return
      pressed.add(button)
      syncInput()
    },
    keyUp(button) {
      pressed.delete(button)
      syncInput()
    },
    releaseAllKeys,
    async saveState() {
      const result = await assertGame().saveStateFile()
      if (!result.saved || !result.bytes)
        throw new Error(`GameCube 即时存档失败${result.error ? `：${result.error}` : '。'}`)
      return new Uint8Array(result.bytes)
    },
    async loadState(bytes) {
      if (!bytes.byteLength) throw new Error('即时存档文件为空。')
      releaseAllKeys()
      const result = await assertGame().loadStateFile(new Uint8Array(bytes))
      if (!result.loaded)
        throw new Error(`无法读取此 GameCube 即时存档${result.error ? `：${result.error}` : '。'}`)
    },
    async exportSave() {
      assertGame()
      return null
    },
    async importSave() {
      throw new Error('实验性 GameCube 核心暂不支持独立记忆卡导入。')
    },
    setRewind() {},
    async screenshot() {
      throw new Error('实验性 GameCube 核心暂不支持截图。')
    },
    dispose() {
      if (status === 'disposed') return
      generation++
      stopRuntime()
      focusCanvas.classList.remove('dolphin-focus-canvas')
      status = 'disposed'
      romName = null
      platform = null
      options.onStatus?.('disposed')
    },
  }
  return emulator
}
