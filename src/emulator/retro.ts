import { PLATFORM_REGISTRY, platformFromFilename } from '../lib/platforms.ts'
import type { EmulatorButton, GamePlatform } from '../lib/platforms.ts'
import type { Emulator, EmulatorOptions, EmulatorStatus } from './index.ts'

interface RetroGameManager {
  getState(): Uint8Array
  loadState(bytes: Uint8Array): void
  screenshot(): Promise<Uint8Array>
  restart(): void
  simulateInput(player: number, index: number, value: number): void
  getSaveFile(save?: boolean): Uint8Array | null
  getSaveFilePath(): string
  loadSaveFiles(): void
  setFastForwardRatio(ratio: number): void
  toggleFastForward(active: number): void
  toggleRewind(active: number): void
  getFrameNum(): number
  FS: {
    analyzePath(path: string): { exists: boolean }
    unlink(path: string): void
    writeFile(path: string, bytes: Uint8Array): void
  }
}

interface RetroFrontend {
  started: boolean
  paused: boolean
  failedToStart: boolean
  canvas: HTMLCanvasElement
  gameManager?: RetroGameManager
  on(event: string, callback: (data?: unknown) => void): void
  play(dontUpdate?: boolean): void
  pause(dontUpdate?: boolean): void
  setVolume(volume: number): void
  callEvent(event: string, data?: unknown): number
  destroy(): void
}

type RetroConstructor = new (selector: string, config: Record<string, unknown>) => RetroFrontend

declare global {
  interface Window {
    EmulatorJS?: RetroConstructor
  }
}

const RUNTIME_SCRIPTS = [
  'emulator.js',
  'nipplejs.js',
  'shaders.js',
  'storage.js',
  'gamepad.js',
  'GameManager.js',
  'socket.io.min.js',
  'compression.js',
] as const

const BUTTON_INDEX: Record<EmulatorButton, number> = {
  B: 0,
  Y: 1,
  Select: 2,
  Start: 3,
  Up: 4,
  Down: 5,
  Left: 6,
  Right: 7,
  A: 8,
  X: 9,
  L: 10,
  R: 11,
}

const CORE_NAMES: Record<'nes' | 'snes', string> = {
  nes: 'FCEUmm 4.2.3',
  snes: 'Snes9x 4.2.3',
}

let runtimePromise: Promise<void> | null = null
let nextHostId = 0

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  return !!a && a.length === b.length && a.every((value, index) => value === b[index])
}

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = false
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`无法加载模拟器运行时：${url.split('/').pop()}`))
    document.head.appendChild(script)
  })
}

async function loadRuntime(base: URL): Promise<void> {
  if (window.EmulatorJS) return
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const stylesheet = document.createElement('link')
      stylesheet.rel = 'stylesheet'
      stylesheet.href = new URL('emulator.css', base).href
      document.head.appendChild(stylesheet)
      for (const name of RUNTIME_SCRIPTS) {
        await loadScript(new URL(`src/${name}`, base).href)
      }
      if (!window.EmulatorJS) throw new Error('EmulatorJS 运行时初始化失败。')
    })().catch((error) => {
      runtimePromise = null
      throw error
    })
  }
  await runtimePromise
}

export function createRetroEmulator(
  canvas: HTMLCanvasElement,
  options: EmulatorOptions = {},
): Emulator {
  let status: EmulatorStatus = 'idle'
  let romName: string | null = null
  let platform: GamePlatform | null = null
  let frontend: RetroFrontend | null = null
  let host: HTMLDivElement | null = null
  let volume = 0.65
  let speed: 1 | 2 | 4 = 1
  let lastSave: Uint8Array | null = null
  let batteryTimer: number | undefined
  let fpsTimer: number | undefined
  let lastFrame = 0
  let generation = 0

  const setStatus = (next: EmulatorStatus) => {
    if (status === next || status === 'disposed') return
    status = next
    options.onStatus?.(next)
  }
  const assertAlive = () => {
    if (status === 'disposed') throw new Error('模拟器已关闭，请重新打开游戏。')
  }
  const assertGame = (): RetroGameManager => {
    assertAlive()
    if (!frontend?.gameManager || !romName || !['running', 'paused'].includes(status))
      throw new Error('请先载入一个游戏。')
    return frontend.gameManager
  }
  const reportError = (value: unknown): Error => {
    const error = value instanceof Error ? value : new Error(String(value))
    if (status !== 'disposed') {
      setStatus('error')
      options.onError?.(error)
    }
    return error
  }
  const releaseAllKeys = () => {
    if (!frontend?.gameManager || status === 'disposed') return
    for (const index of Object.values(BUTTON_INDEX)) frontend.gameManager.simulateInput(0, index, 0)
    frontend.gameManager.toggleRewind(0)
  }
  const captureBattery = (): Uint8Array | null => {
    const manager = assertGame()
    const data = manager.getSaveFile()
    if (!data?.length) return null
    const bytes = copy(data)
    if (!sameBytes(lastSave, bytes)) {
      lastSave = bytes
      options.onSaveChange?.(copy(bytes))
    }
    return bytes
  }
  const withPausedCore = <T>(action: () => T): T => {
    const resume = status === 'running' && frontend && !frontend.paused
    if (resume) frontend!.pause(true)
    try {
      return action()
    } finally {
      if (resume && status === 'running') frontend?.play(true)
    }
  }
  const withPausedCoreAsync = async <T>(action: () => Promise<T>): Promise<T> => {
    const resume = status === 'running' && frontend && !frontend.paused
    if (resume) frontend!.pause(true)
    try {
      return await action()
    } finally {
      if (resume && status === 'running') frontend?.play(true)
    }
  }
  const startTimers = () => {
    window.clearInterval(batteryTimer)
    window.clearInterval(fpsTimer)
    batteryTimer = window.setInterval(() => {
      if (status !== 'running') return
      try {
        captureBattery()
      } catch (error) {
        console.warn('[EmulatorJS] 读取存档失败', error)
      }
    }, 2000)
    lastFrame = frontend?.gameManager?.getFrameNum() ?? 0
    fpsTimer = window.setInterval(() => {
      if (status !== 'running' || !frontend?.gameManager) return
      const frame = frontend.gameManager.getFrameNum()
      options.onFps?.(Math.max(0, frame - lastFrame))
      lastFrame = frame
    }, 1000)
  }
  const teardown = () => {
    window.clearInterval(batteryTimer)
    window.clearInterval(fpsTimer)
    if (frontend) {
      try {
        releaseAllKeys()
        frontend.destroy()
      } catch (error) {
        console.warn('[EmulatorJS] 关闭核心失败', error)
      }
    }
    frontend = null
    host?.remove()
    host = null
    canvas.classList.remove('retro-focus-canvas')
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
    get version() {
      return platform === 'nes' || platform === 'snes'
        ? `${CORE_NAMES[platform]} · EmulatorJS`
        : 'FCEUmm / Snes9x · EmulatorJS'
    },
    async loadRom(data, name, nextPlatform) {
      assertAlive()
      if (nextPlatform !== 'nes' && nextPlatform !== 'snes')
        throw new Error('此核心仅支持 FC / NES 与 SFC / SNES 游戏。')
      const definition = PLATFORM_REGISTRY[nextPlatform]
      if (
        platformFromFilename(name) !== nextPlatform ||
        data.byteLength < definition.minRomSize ||
        data.byteLength > definition.maxRomSize
      )
        throw new Error(`无效的 ${definition.label} ROM：文件格式或大小不受支持。`)
      if (status === 'loading') throw new Error('正在载入游戏，请稍候。')
      teardown()
      const ticket = ++generation
      romName = null
      platform = null
      lastSave = null
      setStatus('loading')
      try {
        const base = new URL(`${import.meta.env.BASE_URL}emulatorjs/`, window.location.href)
        options.onProgress?.(`正在加载 ${definition.label} 模拟核心…`)
        await loadRuntime(base)
        assertAlive()
        if (ticket !== generation) throw new Error('游戏载入已取消。')
        const parent = canvas.parentElement
        if (!parent) throw new Error('模拟器画面容器不可用。')
        host = document.createElement('div')
        host.id = `advance-retro-${++nextHostId}`
        host.className = 'retro-host'
        host.setAttribute('aria-hidden', 'true')
        parent.insertBefore(host, canvas)
        canvas.width = definition.nativeWidth
        canvas.height = definition.nativeHeight
        canvas.classList.add('retro-focus-canvas')
        host.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }))
        const Constructor = window.EmulatorJS
        if (!Constructor) throw new Error('EmulatorJS 运行时不可用。')
        const started = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error(`${definition.label} 核心启动超时，请刷新后重试。`)),
            20000,
          )
          const check = window.setInterval(() => {
            if (frontend?.failedToStart) {
              window.clearInterval(check)
              window.clearTimeout(timeout)
              reject(new Error(`无法启动 ${definition.label} 核心，请检查 ROM 文件。`))
            }
          }, 100)
          const finish = () => {
            window.clearInterval(check)
            window.clearTimeout(timeout)
            resolve()
          }
          queueMicrotask(() => frontend?.on('start', finish))
        })
        frontend = new Constructor(`#${host.id}`, {
          gameUrl: new File([copy(data)], name, { type: 'application/octet-stream' }),
          gameName: name.replace(/\.[^.]+$/, ''),
          gameId: name,
          dataPath: base.href,
          system: nextPlatform,
          startOnLoad: true,
          noAutoFocus: true,
          disableDatabases: true,
          disableLocalStorage: true,
          forceLegacyCores: true,
          threads: false,
          volume,
          defaultOptions: { rewindEnabled: 'enabled' },
          buttonOpts: {
            playPause: false,
            restart: false,
            mute: false,
            volume: false,
            fullscreen: false,
            saveState: false,
            loadState: false,
            saveSavFiles: false,
            loadSavFiles: false,
            gamepad: false,
            cheat: false,
            cacheManager: false,
            exitEmulation: false,
            netplay: false,
          },
        })
        await started
        assertAlive()
        if (ticket !== generation || !frontend.gameManager) throw new Error('游戏载入已取消。')
        romName = name
        platform = nextPlatform
        frontend.setVolume(volume)
        frontend.gameManager.setFastForwardRatio(speed)
        frontend.gameManager.toggleFastForward(speed === 1 ? 0 : 1)
        setStatus('running')
        startTimers()
        options.onProgress?.('')
      } catch (error) {
        teardown()
        throw reportError(error)
      }
    },
    start() {
      emulator.resume()
    },
    resume() {
      if (status !== 'paused' || !frontend) return
      frontend.play(true)
      setStatus('running')
      startTimers()
    },
    pause() {
      if (status !== 'running' || !frontend) return
      releaseAllKeys()
      frontend.pause(true)
      setStatus('paused')
      options.onFps?.(0)
      try {
        captureBattery()
      } catch {
        /* Some cartridges do not expose persistent memory. */
      }
    },
    reset() {
      const manager = assertGame()
      withPausedCore(() => {
        releaseAllKeys()
        try {
          captureBattery()
        } catch {
          /* Reset remains useful for cartridges without persistent memory. */
        }
        manager.restart()
      })
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
      if (frontend?.started) frontend.setVolume(volume)
    },
    setSpeed(value) {
      speed = value === 2 || value === 4 ? value : 1
      if (!frontend?.gameManager) return
      frontend.gameManager.toggleFastForward(0)
      frontend.gameManager.setFastForwardRatio(speed)
      if (speed !== 1) frontend.gameManager.toggleFastForward(1)
    },
    keyDown(button) {
      if (status === 'running') frontend?.gameManager?.simulateInput(0, BUTTON_INDEX[button], 1)
    },
    keyUp(button) {
      if (status !== 'disposed') frontend?.gameManager?.simulateInput(0, BUTTON_INDEX[button], 0)
    },
    releaseAllKeys,
    async saveState() {
      return withPausedCore(() => copy(assertGame().getState()))
    },
    async loadState(bytes) {
      if (!bytes.length || bytes.length > 32 * 1024 * 1024)
        throw new Error('即时存档文件大小无效。')
      withPausedCore(() => assertGame().loadState(copy(bytes)))
    },
    async exportSave() {
      return captureBattery()
    },
    async importSave(bytes) {
      if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('游戏内存档文件大小无效。')
      const manager = assertGame()
      withPausedCore(() => {
        const path = manager.getSaveFilePath()
        if (manager.FS.analyzePath(path).exists) manager.FS.unlink(path)
        manager.FS.writeFile(path, copy(bytes))
        manager.loadSaveFiles()
        lastSave = copy(bytes)
        options.onSaveChange?.(copy(bytes))
      })
    },
    setRewind(enabled) {
      if (status === 'running') frontend?.gameManager?.toggleRewind(enabled ? 1 : 0)
    },
    async screenshot() {
      const bytes = await withPausedCoreAsync(() =>
        Promise.race([
          assertGame().screenshot(),
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error('截图超时，请稍后重试。')), 3000),
          ),
        ]),
      )
      return new Blob([copy(bytes)], { type: 'image/png' })
    },
    dispose() {
      if (status === 'disposed') return
      generation++
      teardown()
      status = 'disposed'
      romName = null
      platform = null
      options.onStatus?.('disposed')
    },
  }
  return emulator
}
