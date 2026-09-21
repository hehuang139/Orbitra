/// <reference types="vite/client" />
import { checkRuntimePrerequisites } from '../lib/compatibility'
import { batteryFromState } from './battery-snapshot'
import { installCanvas2DRenderer } from './canvas2d-renderer'
import { createRetroEmulator } from './retro'
import { createDolphinEmulator } from './dolphin'
import { mgbaCheatFile } from '../lib/cheats.ts'
import type { Cheat } from '../lib/types.ts'

/** Browser adapter for the locally bundled mGBA WebAssembly core. */
import { PLATFORM_REGISTRY, platformFromFilename } from '../lib/platforms.ts'
import type {
  EmulatorButton as PlatformButton,
  GamePlatform,
  PlatformCapabilities,
} from '../lib/platforms.ts'

export type EmulatorButton = PlatformButton
export type GbaButton = EmulatorButton
export type EmulatorStatus = 'idle' | 'loading' | 'running' | 'paused' | 'error' | 'disposed'
export type RomSource = Uint8Array | Blob

export interface EmulatorOptions {
  onStatus?: (status: EmulatorStatus) => void
  onError?: (error: Error) => void
  onProgress?: (message: string) => void
  onFps?: (fps: number) => void
  onSaveChange?: (bytes: Uint8Array) => void
}

export interface Emulator {
  readonly status: EmulatorStatus
  readonly romName: string | null
  readonly platform: GamePlatform | null
  readonly capabilities: PlatformCapabilities | null
  readonly version: string
  loadRom(
    data: RomSource,
    name: string,
    platform: GamePlatform,
    cheats?: readonly Cheat[],
  ): Promise<void>
  start(): void
  resume(): void
  pause(): void
  reset(): void
  setVolume(volume: number): void
  setSpeed(speed: 1 | 2 | 4): void
  keyDown(button: EmulatorButton): void
  keyUp(button: EmulatorButton): void
  releaseAllKeys(): void
  saveState(): Promise<Uint8Array>
  loadState(bytes: Uint8Array): Promise<void>
  exportSave(): Promise<Uint8Array | null>
  importSave(bytes: Uint8Array): Promise<void>
  /** Hold true to travel backwards through the recent gameplay buffer. */
  setRewind(enabled: boolean): void
  screenshot(): Promise<Blob>
  dispose(): void
}

interface Core {
  FS: {
    mkdir(path: string): void
    writeFile(path: string, bytes: Uint8Array): void
    readFile(path: string): Uint8Array
    unlink(path: string): void
    analyzePath(path: string): { exists: boolean }
    readdir(path: string): string[]
  }
  version: { projectName: string; projectVersion: string }
  SDL2?: { audioContext?: AudioContext }
  loadGame(path: string): boolean
  pauseGame(): void
  resumeGame(): void
  quickReload(): void
  quitGame(): void
  buttonPress(button: string): void
  buttonUnpress(button: string): void
  toggleInput(enabled: boolean): void
  setVolume(volume: number): void
  setFastForwardMultiplier(speed: number): void
  setCoreSettings(settings: Record<string, number | boolean>): void
  toggleRewind(enabled: boolean): void
  saveState(slot: number): boolean
  loadState(slot: number): boolean
  getSave(): Uint8Array | null
  screenshot(name: string): boolean
  addCoreCallbacks(callbacks: Record<string, (() => void) | null>): void
  setLogger(
    callback: ((entry: { level: string; category: string; message: string }) => void) | null,
  ): void
  /** Small, documented host lifecycle additions to the upstream JS wrapper. */
  hostIsGameReady(): boolean
  hostDispose(): void
}

type CoreFactory = (options: {
  canvas: HTMLCanvasElement
  locateFile: (name: string) => string
  print: (message: string) => void
  printErr: (message: string) => void
  onAbort: (message: string) => void
}) => Promise<Core>

const SAVE_PATH = '/data/saves/current.sav'
const STATE_PATH = '/data/states/current.ss1'
const BATTERY_SNAPSHOT_PATH = '/data/states/current.ss2'
const CHEAT_PATH = '/data/cheats/current.cheats'
const BUTTONS: EmulatorButton[] = [
  'A',
  'B',
  'L',
  'R',
  'Start',
  'Select',
  'Up',
  'Down',
  'Left',
  'Right',
]
const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  return !!a && a.length === b.length && a.every((value, index) => value === b[index])
}

export function createMgbaEmulator(
  canvas: HTMLCanvasElement,
  options: EmulatorOptions = {},
): Emulator {
  let status: EmulatorStatus = 'idle'
  let romName: string | null = null
  let platform: GamePlatform | null = null
  let romPath = '/data/games/current.gba'
  let core: Core | null = null
  let initializing: Promise<Core> | null = null
  let generation = 0
  let volume = 0.65
  let speed: 1 | 2 | 4 = 1
  let lastSave: Uint8Array | null = null
  let batteryTimer: number | undefined
  let fpsFrames = 0
  let fpsStart = 0
  let pendingBattery = false
  let coreError: Error | null = null
  let firstFrameEnded = false
  let pausedCoreDepth = 0
  let restoreRenderer: (() => void) | null = null

  const releaseRenderer = () => {
    restoreRenderer?.()
    restoreRenderer = null
  }

  const setStatus = (next: EmulatorStatus) => {
    if (status === next || status === 'disposed') return
    status = next
    options.onStatus?.(next)
  }
  const assertAlive = () => {
    if (status === 'disposed') throw new Error('模拟器已关闭，请重新打开游戏。')
  }
  const assertGame = (): Core => {
    assertAlive()
    if (!core || !romName || (status !== 'running' && status !== 'paused')) {
      throw new Error('请先载入一个游戏。')
    }
    return core
  }
  const reportError = (value: unknown): Error => {
    const error = value instanceof Error ? value : new Error(String(value))
    if (status !== 'disposed') {
      coreError = error
      setStatus('error')
      options.onError?.(error)
    }
    return error
  }
  const withPausedCore = <T>(instance: Core, action: () => T): T => {
    // Framebuffer access is not locked by the native screenshot API. Keep all
    // synchronous snapshot work on a paused CPU, including nested SRAM capture
    // after loading a state, without changing the public running/paused status.
    const pauseHere = pausedCoreDepth === 0 && status === 'running'
    const ticket = generation
    if (pauseHere) instance.pauseGame()
    pausedCoreDepth++
    try {
      return action()
    } finally {
      pausedCoreDepth--
      if (pauseHere && core === instance && ticket === generation && status === 'running')
        instance.resumeGame()
    }
  }
  const captureBattery = (includePendingWrites = true) => {
    if (!core || !romName || (status !== 'running' && status !== 'paused')) return null
    const instance = core
    let data: Uint8Array | null
    if (includePendingWrites) {
      // The core flushes cartridge writes to MEMFS only after they settle.
      // A state snapshot reads actual cartridge memory under the native thread
      // lock, preserving recent writes even when the game is paused at once.
      data = withPausedCore(instance, () => {
        try {
          if (!instance.saveState(2))
            throw new Error('无法读取当前电池存档，请重试或先导出即时存档。')
          const snapshot = batteryFromState(
            instance.FS.readFile(BATTERY_SNAPSHOT_PATH),
            instance.getSave(),
          )
          // An older save callback must not overwrite this newer snapshot with
          // MEMFS data that has not caught up with the cartridge's latest writes.
          pendingBattery = false
          return snapshot
        } finally {
          if (instance.FS.analyzePath(BATTERY_SNAPSHOT_PATH).exists)
            instance.FS.unlink(BATTERY_SNAPSHOT_PATH)
        }
      })
    } else {
      data = instance.getSave()
    }
    if (!data?.length) return null
    const bytes = copy(data)
    if (!sameBytes(lastSave, bytes)) {
      lastSave = bytes
      options.onSaveChange?.(copy(bytes))
    }
    return bytes
  }
  const captureBatteryAfterAction = () => {
    try {
      captureBattery()
    } catch (value) {
      // Pause/state restoration already succeeded. A backup failure must not
      // change that action's status or be reported as a failed game startup.
      const message = value instanceof Error ? value.message : String(value)
      options.onError?.(new Error(`电池存档同步失败：${message}`))
    }
  }
  const clearSessionFiles = () => {
    if (!core) return
    for (const directory of [
      '/data/games',
      '/data/saves',
      '/data/states',
      '/autosave',
      '/data/screenshots',
    ]) {
      for (const name of core.FS.readdir(directory)) {
        if (name !== '.' && name !== '..') core.FS.unlink(`${directory}/${name}`)
      }
    }
  }
  const releaseAllKeys = () => {
    if (!core || status === 'disposed') return
    for (const button of BUTTONS) core.buttonUnpress(button)
    core.toggleRewind(false)
  }
  const resumeAudio = () => {
    const context = core?.SDL2?.audioContext
    if (context?.state === 'suspended') void context.resume().catch(() => {})
  }
  const initialize = (): Promise<Core> => {
    if (initializing) return initializing
    initializing = (async () => {
      const prerequisites = checkRuntimePrerequisites()
      const unavailable = prerequisites.checks.find((check) => check.status === 'error')
      if (unavailable) throw new Error(`${unavailable.detail}。${unavailable.action || ''}`)
      if (prerequisites.renderingBackend === 'canvas2d' && !restoreRenderer)
        restoreRenderer = installCanvas2DRenderer(canvas)
      options.onProgress?.('正在加载 mGBA 模拟核心…')
      const base = new URL(`${import.meta.env.BASE_URL}emulator/`, window.location.href)
      const entry = new URL('mgba.js', base).href
      const { default: factory } = (await import(/* @vite-ignore */ entry)) as {
        default: CoreFactory
      }
      assertAlive()
      const instance = await factory({
        canvas,
        locateFile: (name) => new URL(name, base).href,
        print: () => {},
        printErr: (message) => console.warn('[mGBA]', message),
        onAbort: (message) => {
          reportError(new Error(`mGBA 核心异常：${message}`))
        },
      })
      if (status === 'disposed') {
        instance.hostDispose()
        releaseRenderer()
        throw new Error('模拟器已关闭。')
      }
      core = instance
      // The application persists data in its own IndexedDB. Use MEMFS here to
      // prevent stale upstream IDBFS data from silently restoring other games.
      for (const directory of [
        '/data',
        '/data/games',
        '/data/saves',
        '/data/states',
        '/data/cheats',
        '/data/screenshots',
        '/data/patches',
        '/autosave',
      ]) {
        instance.FS.mkdir(directory)
      }
      instance.toggleInput(false)
      instance.setCoreSettings({
        rewindEnable: true,
        rewindBufferCapacity: 600,
        rewindBufferInterval: 1,
        autoSaveStateEnable: false,
        restoreAutoSaveStateOnLoad: false,
        allowOpposingDirections: false,
        showFpsCounter: false,
        baseFpsTarget: 60,
      })
      instance.setLogger((entry) => {
        if (entry.level === 'FATAL') reportError(new Error(`游戏运行异常：${entry.message}`))
      })
      return instance
    })().catch((error: unknown) => {
      initializing = null
      if (!core) releaseRenderer()
      throw error
    })
    return initializing
  }
  const waitForGame = async (ticket: number) => {
    const deadline = performance.now() + 10000
    // A pthread can exist before it executes any ROM instructions. Wait for
    // this cartridge's first completed frame before allowing save operations.
    while (!core?.hostIsGameReady() || !firstFrameEnded) {
      assertAlive()
      if (ticket !== generation) throw new Error('游戏载入已取消。')
      if (coreError) throw coreError
      if (performance.now() > deadline) throw new Error('游戏启动超时，请保持页面可见后重试。')
      await delay(20)
    }
    assertAlive()
    if (ticket !== generation) throw new Error('游戏载入已取消。')
    if (coreError) throw coreError
  }
  const attachCallbacks = (ticket: number) => {
    firstFrameEnded = false
    fpsFrames = 0
    fpsStart = performance.now()
    core?.addCoreCallbacks({
      videoFrameEndedCallback: () => {
        if (ticket !== generation || status === 'disposed') return
        firstFrameEnded = true
        if (status !== 'running') return
        fpsFrames++
        const elapsed = performance.now() - fpsStart
        if (elapsed >= 1000) {
          options.onFps?.(Math.round((fpsFrames * 1000) / elapsed))
          fpsStart = performance.now()
          fpsFrames = 0
        }
      },
      coreCrashedCallback: () => {
        if (ticket === generation)
          reportError(new Error('当前游戏触发了模拟核心异常，请重置或尝试其他 ROM。'))
      },
      saveDataUpdatedCallback: () => {
        if (ticket === generation) pendingBattery = true
      },
    })
    window.clearInterval(batteryTimer)
    batteryTimer = window.setInterval(() => {
      if (status === 'running' && pendingBattery) {
        pendingBattery = false
        // This path is triggered only after the core's savedata sync callback.
        try {
          captureBattery(false)
        } catch (error) {
          console.warn('[mGBA] 读取存档失败', error)
        }
      }
    }, 1000)
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
      return core
        ? `${core.version.projectName} ${core.version.projectVersion}`
        : 'mGBA · WebAssembly'
    },
    async loadRom(data, name, nextPlatform, cheats = []) {
      assertAlive()
      const definition = PLATFORM_REGISTRY[nextPlatform]
      if (
        !(data instanceof Uint8Array) ||
        !definition ||
        definition.core !== 'mgba' ||
        platformFromFilename(name) !== nextPlatform
      ) {
        throw new Error('游戏平台与文件格式不匹配，请重新导入 ROM。')
      }
      if (data.byteLength < definition.minRomSize || data.byteLength > definition.maxRomSize) {
        throw new Error(`无效的 ${definition.label} ROM：文件大小超出支持范围。`)
      }
      if (status === 'loading') throw new Error('正在载入游戏，请稍候。')
      if (romName && core) {
        releaseAllKeys()
        core.pauseGame()
        if (status === 'running') {
          setStatus('paused')
          options.onFps?.(0)
        }
        // Abort a cartridge switch if its current progress cannot be captured.
        // Keep the old generation valid so this paused game can still resume.
        captureBattery()
        core.quitGame()
      }
      const ticket = ++generation
      romName = null
      platform = null
      coreError = null
      lastSave = null
      pendingBattery = false
      window.clearInterval(batteryTimer)
      setStatus('loading')
      try {
        const instance = await initialize()
        assertAlive()
        if (ticket !== generation) throw new Error('游戏载入已取消。')
        options.onProgress?.('正在启动游戏…')
        clearSessionFiles()
        romPath = `/data/games/current${definition.extensions[0]}`
        canvas.width = definition.nativeWidth
        canvas.height = definition.nativeHeight
        instance.FS.writeFile(romPath, copy(data))
        if (cheats.length) instance.FS.writeFile(CHEAT_PATH, mgbaCheatFile(cheats))
        if (!instance.loadGame(romPath))
          throw new Error(`无法识别这个 ROM，请导入有效的 ${definition.label} 游戏文件。`)
        // The upstream registration function mutates callback vectors without
        // locking. Install before the next animation frame starts the CPU thread.
        attachCallbacks(ticket)
        await waitForGame(ticket)
        romName = name
        platform = nextPlatform
        instance.toggleInput(false)
        instance.setVolume(volume)
        instance.setFastForwardMultiplier(speed)
        resumeAudio()
        setStatus('running')
        options.onProgress?.('')
      } catch (error) {
        window.clearInterval(batteryTimer)
        if (core && status !== 'disposed') core.quitGame()
        throw reportError(error)
      }
    },
    start() {
      emulator.resume()
    },
    resume() {
      if (status !== 'paused') return
      assertGame().resumeGame()
      resumeAudio()
      fpsFrames = 0
      fpsStart = performance.now()
      setStatus('running')
    },
    pause() {
      if (status !== 'running') return
      releaseAllKeys()
      assertGame().pauseGame()
      setStatus('paused')
      options.onFps?.(0)
      captureBatteryAfterAction()
    },
    reset() {
      const instance = assertGame()
      withPausedCore(instance, () => {
        releaseAllKeys()
        captureBattery()
        instance.quickReload()
        instance.setVolume(volume)
        instance.setFastForwardMultiplier(speed)
        if (status === 'paused') instance.pauseGame()
      })
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
      if (status !== 'disposed') core?.setVolume(volume)
      if (volume > 0 && status === 'running') resumeAudio()
    },
    setSpeed(value) {
      speed = value === 2 || value === 4 ? value : 1
      if (status !== 'disposed') core?.setFastForwardMultiplier(speed)
    },
    keyDown(button) {
      if (status === 'running') {
        core?.buttonPress(button)
        resumeAudio()
      }
    },
    keyUp(button) {
      if (status !== 'disposed') core?.buttonUnpress(button)
    },
    releaseAllKeys,
    async saveState() {
      const instance = assertGame()
      return withPausedCore(instance, () => {
        if (!instance.saveState(1)) throw new Error('即时存档失败，请稍后重试。')
        return copy(instance.FS.readFile(STATE_PATH))
      })
    },
    async loadState(bytes) {
      const instance = assertGame()
      if (!bytes.length || bytes.length > 16 * 1024 * 1024)
        throw new Error('即时存档文件大小无效。')
      withPausedCore(instance, () => {
        releaseAllKeys()
        instance.FS.writeFile(STATE_PATH, copy(bytes))
        if (!instance.loadState(1))
          throw new Error('无法读取此即时存档，请确认它属于当前游戏与 mGBA 核心。')
        if (status === 'paused') instance.pauseGame()
        captureBatteryAfterAction()
      })
    },
    async exportSave() {
      assertGame()
      return captureBattery()
    },
    async importSave(bytes) {
      const instance = assertGame()
      if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('电池存档文件大小无效。')
      const wasPaused = status === 'paused'
      const ticket = ++generation
      releaseAllKeys()
      // quitGame destroys the old audio device before joining its CPU thread.
      // Stop that CPU first, just as cartridge switching and disposal do.
      instance.pauseGame()
      instance.quitGame()
      setStatus('loading')
      pendingBattery = false
      try {
        instance.FS.writeFile(SAVE_PATH, copy(bytes))
        if (!instance.loadGame(romPath)) throw new Error('导入存档后重新启动游戏失败。')
        attachCallbacks(ticket)
        await waitForGame(ticket)
        instance.toggleInput(false)
        instance.setVolume(volume)
        instance.setFastForwardMultiplier(speed)
        const changed = !sameBytes(lastSave, bytes)
        lastSave = copy(bytes)
        if (changed) options.onSaveChange?.(copy(bytes))
        setStatus('running')
        if (wasPaused) emulator.pause()
        else resumeAudio()
      } catch (error) {
        window.clearInterval(batteryTimer)
        if (core && status !== 'disposed') core.quitGame()
        throw reportError(error)
      }
    },
    setRewind(enabled) {
      if (status === 'running') core?.toggleRewind(enabled)
    },
    async screenshot() {
      const instance = assertGame()
      return withPausedCore(instance, () => {
        // Capture from the core framebuffer, not WebGL's discarded backbuffer.
        const name = 'capture.png'
        const path = `/data/screenshots/${name}`
        try {
          if (!instance.screenshot(name)) throw new Error('截图失败，请稍后重试。')
          return new Blob([copy(instance.FS.readFile(path))], { type: 'image/png' })
        } finally {
          if (instance.FS.analyzePath(path).exists) instance.FS.unlink(path)
        }
      })
    },
    dispose() {
      if (status === 'disposed') return
      generation++
      releaseAllKeys()
      window.clearInterval(batteryTimer)
      if (core) {
        try {
          core.pauseGame()
          // Disposal must not resume the CPU after its final battery capture.
          if (status === 'running') status = 'paused'
          captureBattery()
        } catch {
          /* A crashed core may no longer expose its save. */
        }
        try {
          core.hostDispose()
        } catch (error) {
          console.warn('[mGBA] 关闭核心失败', error)
        }
        core = null
      }
      releaseRenderer()
      status = 'disposed'
      romName = null
      platform = null
      options.onStatus?.('disposed')
    },
  }
  return emulator
}

/** Platform-neutral session that owns exactly one native core at a time. */
export function createEmulator(canvas: HTMLCanvasElement, options: EmulatorOptions = {}): Emulator {
  let backend: Emulator | null = null
  let status: EmulatorStatus = 'idle'
  let disposed = false
  let generation = 0
  let volume = 0.65
  let speed: 1 | 2 | 4 = 1

  const requireBackend = (): Emulator => {
    if (disposed) throw new Error('模拟器已关闭，请重新打开游戏。')
    if (!backend) throw new Error('请先载入一个游戏。')
    return backend
  }
  const scopedOptions = (ticket: number): EmulatorOptions => ({
    onStatus: (next) => {
      if (ticket !== generation || disposed) return
      status = next
      options.onStatus?.(next)
    },
    onError: (error) => {
      if (ticket === generation && !disposed) options.onError?.(error)
    },
    onProgress: (message) => {
      if (ticket === generation && !disposed) options.onProgress?.(message)
    },
    onFps: (fps) => {
      if (ticket === generation && !disposed) options.onFps?.(fps)
    },
    onSaveChange: (bytes) => {
      if (ticket === generation && !disposed) options.onSaveChange?.(bytes)
    },
  })

  const emulator: Emulator = {
    get status() {
      return status
    },
    get romName() {
      return backend?.romName ?? null
    },
    get platform() {
      return backend?.platform ?? null
    },
    get capabilities() {
      return backend?.capabilities ?? null
    },
    get version() {
      return backend?.version ?? 'Orbitra 多核心运行时'
    },
    async loadRom(data, name, platform, cheats = []) {
      if (disposed) throw new Error('模拟器已关闭，请重新打开游戏。')
      const definition = PLATFORM_REGISTRY[platform]
      const currentDefinition = backend?.platform ? PLATFORM_REGISTRY[backend.platform] : null
      if (backend && currentDefinition?.core === definition.core) {
        await backend.loadRom(data, name, platform, cheats)
        return
      }
      const ticket = ++generation
      backend?.dispose()
      status = 'loading'
      options.onStatus?.('loading')
      backend =
        definition.core === 'mgba'
          ? createMgbaEmulator(canvas, scopedOptions(ticket))
          : definition.core === 'dolphin'
            ? createDolphinEmulator(canvas, scopedOptions(ticket))
            : createRetroEmulator(canvas, scopedOptions(ticket))
      backend.setVolume(volume)
      backend.setSpeed(speed)
      await backend.loadRom(data, name, platform, cheats)
    },
    start() {
      backend?.start()
    },
    resume() {
      backend?.resume()
    },
    pause() {
      backend?.pause()
    },
    reset() {
      requireBackend().reset()
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
      backend?.setVolume(volume)
    },
    setSpeed(value) {
      speed = value === 2 || value === 4 ? value : 1
      backend?.setSpeed(speed)
    },
    keyDown(button) {
      backend?.keyDown(button)
    },
    keyUp(button) {
      backend?.keyUp(button)
    },
    releaseAllKeys() {
      backend?.releaseAllKeys()
    },
    saveState() {
      return requireBackend().saveState()
    },
    loadState(bytes) {
      return requireBackend().loadState(bytes)
    },
    exportSave() {
      return requireBackend().exportSave()
    },
    importSave(bytes) {
      return requireBackend().importSave(bytes)
    },
    setRewind(enabled) {
      backend?.setRewind(enabled)
    },
    screenshot() {
      return requireBackend().screenshot()
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      backend?.dispose()
      backend = null
      status = 'disposed'
      options.onStatus?.('disposed')
    },
  }
  return emulator
}
