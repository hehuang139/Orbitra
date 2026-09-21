import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircleOff,
  Clock3,
  CloudDownload,
  CloudOff,
  Download,
  Expand,
  FastForward,
  FolderOpen,
  FlaskConical,
  Gamepad2,
  HardDrive,
  Heart,
  Keyboard,
  LayoutGrid,
  List,
  ListChecks,
  LoaderCircle,
  Menu,
  Minimize2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { HandheldArt, SpaceArt } from './components/Artwork'
import { createEmulator } from './emulator'
import type { Emulator, EmulatorButton, EmulatorStatus } from './emulator'
import * as db from './lib/storage'
import { extractRomFiles, importableRomFiles } from './lib/import-roms'
import {
  PLATFORM_LIST,
  PLATFORM_REGISTRY,
  ROM_FILE_EXTENSIONS,
  platformSupportsButton,
} from './lib/platforms'
import type { Cheat, Game, GameLaunchMode, GamePlatform, SaveState } from './lib/types'
import { defaultBindings, isBindingCode, keyLabel, readSettings } from './lib/preferences'
import { createInputController } from './lib/input'
import { useGamepads } from './hooks/useGamepads'
import { GamepadSettings } from './components/GamepadSettings'
import { TouchControls } from './components/TouchControls'
import { TouchSettings } from './components/TouchSettings'
import { BackupManager } from './components/BackupManager'
import { OfflineStatus } from './components/OfflineStatus'
import { AccountPanel } from './components/AccountPanel'
import { OnlineLibraryPage } from './components/OnlineLibraryPanel'
import { useAccountSync } from './hooks/useAccountSync'
import { useOnlineLibrary } from './hooks/useOnlineLibrary'
import { createBackup } from './lib/backup-format'
import type { BackupData } from './lib/backup-format'
import type { Settings } from './lib/preferences'
import { probeCompatibility } from './lib/compatibility'
import type { CompatibilityReport } from './lib/compatibility'
import { FEATURE_STATUS_LABELS, capabilityReportForPlatform } from './lib/capability-status'
import type { FeatureStatus } from './lib/capability-status'
import { CORE_REGISTRY, coreIdForPlatform } from './lib/core-version'
import { createCheatId, validateCheats } from './lib/cheats'
import {
  AUTO_SAVE_SLOTS,
  MANUAL_SAVE_SLOTS,
  automaticSlotLabel,
  isAutomaticSlot,
  latestAutomaticState,
  mostRecentPlayedGame,
  nextAutomaticSlot,
} from './lib/autosave'
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenElement,
  fullscreenSupported,
  watchFullscreen,
} from './lib/fullscreen'
import {
  beginSessionRecovery,
  clearSessionRecovery,
  readSessionRecovery,
  updateSessionRecoveryState,
} from './lib/session-recovery'
import type { SessionRecoveryRecord } from './lib/session-recovery'

type Page = 'library' | 'recent' | 'favorites' | 'states' | 'online-library'
type Modal =
  | 'launch'
  | 'recovery'
  | 'settings'
  | 'controls'
  | 'help'
  | 'states'
  | 'cheats'
  | 'backup'
  | 'account'
  | null
type PlatformFilter = 'all' | GamePlatform
type LaunchPolicy = 'remembered' | 'auto' | 'fresh'
const pages: Record<Page, string> = {
  library: '游戏库',
  recent: '最近游玩',
  favorites: '我的收藏',
  states: '存档管理',
  'online-library': '在线游戏库',
}
const buttonNames: Record<EmulatorButton, string> = {
  Up: '上',
  Down: '下',
  Left: '左',
  Right: '右',
  A: 'A 按钮',
  B: 'B 按钮',
  X: 'X 按钮',
  Y: 'Y 按钮',
  L: 'L 肩键',
  R: 'R 肩键',
  Z: 'Z 按钮',
  Start: '开始',
  Select: '选择',
}
const formatTime = (seconds: number) =>
  seconds < 60
    ? '刚刚开始'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟`
      : `${(seconds / 3600).toFixed(1)} 小时`
const formatDate = (time: number) =>
  new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
const formatSize = (bytes: number) =>
  bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
const isDemo = (game: Game) => game.filename === 'star-orbit.gba'
const displayTitle = (game: Game) => (isDemo(game) ? 'Star Orbit · 星际漫游' : game.title)
const acceptedGameFiles = [...ROM_FILE_EXTENSIONS, '.zip'].join(',')
const romFormatLabel = ROM_FILE_EXTENSIONS.map((extension) => extension.toUpperCase()).join(' / ')

function IconButton({
  children,
  label,
  onClick,
  disabled = false,
  className = '',
}: {
  children: ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

function download(data: Blob | Uint8Array, name: string) {
  const blob = data instanceof Blob ? data : new Blob([new Uint8Array(data)])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function App() {
  const [games, setGames] = useState<Game[]>([])
  const [page, setPage] = useState<Page>('library')
  const [active, setActive] = useState<Game | null>(null)
  const [status, setStatus] = useState<EmulatorStatus>('idle')
  const [settings, setSettings] = useState<Settings>(readSettings)
  const [modal, setModal] = useState<Modal>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('recent')
  const [layout, setLayout] = useState('grid')
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all')
  const [busy, setBusy] = useState(false)
  const [importLabel, setImportLabel] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState('正在准备模拟器…')
  const [compatibility, setCompatibility] = useState<CompatibilityReport | null>(null)
  const [compatibilityOpen, setCompatibilityOpen] = useState(false)
  const [compatibilityView, setCompatibilityView] = useState<'environment' | 'cores'>('environment')
  const [capabilityPlatform, setCapabilityPlatform] = useState<GamePlatform>('gba')
  const [fps, setFps] = useState(0)
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const [states, setStates] = useState<SaveState[]>([])
  const [allStates, setAllStates] = useState<SaveState[]>([])
  const [continueState, setContinueState] = useState<SaveState | null>(null)
  const [launchTarget, setLaunchTarget] = useState<Game | null>(null)
  const [launchMode, setLaunchMode] = useState<GameLaunchMode>('fresh')
  const [launchStateSlot, setLaunchStateSlot] = useState<number | null>(null)
  const [launchStates, setLaunchStates] = useState<SaveState[]>([])
  const launchAutomaticState = latestAutomaticState(launchStates, settings.autoSaveSlotCount)
  const [recoveryRecord, setRecoveryRecord] = useState<SessionRecoveryRecord | null>(null)
  const [recoveryState, setRecoveryState] = useState<SaveState | null>(null)
  const [mapping, setMapping] = useState<EmulatorButton | null>(null)
  const [launchError, setLaunchError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [gameMenu, setGameMenu] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Game | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedGameIds, setSelectedGameIds] = useState<Set<string>>(() => new Set())
  const [batchDeleteTargets, setBatchDeleteTargets] = useState<Game[] | null>(null)
  const [cheatDrafts, setCheatDrafts] = useState<Cheat[]>([])
  const [fullscreenActive, setFullscreenActive] = useState(false)
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false)
  const compatibilityRenderingWarning =
    compatibility?.checks.some((check) => check.id === 'webgl' && check.status === 'warning') ??
    false
  const recoveryGame = recoveryRecord
    ? (games.find((game) => game.id === recoveryRecord.gameId) ?? null)
    : null
  const recoveryCoreMatches = Boolean(
    recoveryGame && recoveryRecord?.coreId === coreIdForPlatform(recoveryGame.platform),
  )
  const recoveryStateMatches = Boolean(
    recoveryRecord &&
    recoveryState &&
    recoveryRecord.stateSlot === recoveryState.slot &&
    recoveryRecord.stateCreatedAt === recoveryState.createdAt &&
    (!recoveryState.coreVersion || recoveryState.coreVersion === recoveryRecord.coreId),
  )
  const recoveryProblem = !recoveryRecord
    ? ''
    : !recoveryGame
      ? '这个游戏已不在本地游戏库中。重新导入同一个 ROM 后，可从存档管理继续。'
      : !recoveryCoreMatches
        ? '模拟核心版本已经变化，为避免损坏进度，本次不自动读取旧状态。'
        : recoveryRecord.stateSlot === undefined
          ? '上次会话在生成可恢复存档前中断，可以正常启动游戏。'
          : !recoveryStateMatches
            ? '关联的即时存档已缺失、损坏或被更新，可以正常启动并从其他存档继续。'
            : ''
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const engineRef = useRef<Emulator | null>(null)
  const activeRef = useRef<Game | null>(null)
  const settingsRef = useRef(settings)
  const operationRef = useRef(false)
  const maintenanceRef = useRef(false)
  const pendingWrites = useRef(new Set<Promise<unknown>>())
  const inputRef = useRef<HTMLInputElement>(null)
  const directoryInputRef = useRef<HTMLInputElement>(null)
  const saveInputRef = useRef<HTMLInputElement>(null)
  const stateInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const mappingRef = useRef(mapping)
  mappingRef.current = mapping
  const launchTrigger = useRef<HTMLElement | null>(null)
  const launchTriggerName = useRef('')
  const returnFocusPending = useRef(false)
  const backupTrigger = useRef<HTMLElement | null>(null)
  const input = useMemo(
    () =>
      createInputController(
        (button) => engineRef.current?.keyDown(button),
        (button) => engineRef.current?.keyUp(button),
      ),
    [],
  )
  const releaseInputs = useCallback(() => {
    input.clear()
    engineRef.current?.releaseAllKeys()
    engineRef.current?.setRewind(false)
    engineRef.current?.setSpeed(settingsRef.current.speed)
  }, [input])
  const inputEnabled = Boolean(
    active && status === 'running' && !busy && !modal && !deleteTarget && !batchDeleteTargets,
  )
  const gamepads = useGamepads({
    enabled: inputEnabled,
    onPress: (button) => {
      const game = activeRef.current
      if (game && platformSupportsButton(game.platform, button)) input.press('gamepad', button)
    },
    onRelease: (button) => input.release('gamepad', button),
  })
  const gamepad = gamepads.connected
  const dragCount = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const notify = useCallback((text: string, error = false) => {
    clearTimeout(toastTimer.current)
    setToast({ text, error })
    toastTimer.current = setTimeout(() => setToast(null), error ? 7000 : 3500)
  }, [])
  const refresh = useCallback(async () => setGames(await db.getGames()), [])
  const account = useAccountSync({ onLibraryChanged: refresh })
  const onlineLibrary = useOnlineLibrary({ onLibraryChanged: refresh })
  const trackWrite = useCallback(<T,>(promise: Promise<T>): Promise<T> => {
    pendingWrites.current.add(promise)
    void promise.finally(() => pendingWrites.current.delete(promise)).catch(() => {})
    return promise
  }, [])
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (operationRef.current) return
      operationRef.current = true
      setBusy(true)
      try {
        await action()
      } catch (error) {
        notify(error instanceof Error ? error.message : '操作失败，请重试', true)
      } finally {
        operationRef.current = false
        setBusy(false)
      }
    },
    [notify],
  )

  useEffect(() => {
    let cancelled = false
    void probeCompatibility()
      .then((report) => {
        if (!cancelled) setCompatibility(report)
      })
      .catch(() => {
        if (!cancelled) notify('环境检查暂时无法完成，请刷新后重试', true)
      })
    return () => {
      cancelled = true
    }
  }, [notify])

  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        let list = await db.getGames()
        if (!list.some(isDemo)) {
          const response = await fetch('/demo/star-orbit.gba')
          if (!response.ok)
            throw new Error(`试玩游戏暂时不可用，你仍可导入自己的 ${romFormatLabel} 游戏`)
          await db.importGame(new File([await response.arrayBuffer()], 'star-orbit.gba'))
          list = await db.getGames()
        }
        if (!cancelled) {
          setGames(list)
          const recovery = readSessionRecovery()
          if (recovery) {
            let savedState: SaveState | null = null
            if (
              recovery.stateSlot !== undefined &&
              list.some((game) => game.id === recovery.gameId)
            ) {
              try {
                savedState = (await db.getState(recovery.gameId, recovery.stateSlot)) ?? null
              } catch {
                /* The recovery dialog reports an unavailable or damaged state. */
              }
            }
            if (!cancelled) {
              setRecoveryRecord(recovery)
              setRecoveryState(savedState)
              setModal('recovery')
            }
          }
        }
      } catch (error) {
        if (!cancelled) notify(error instanceof Error ? error.message : '无法读取游戏库', true)
      } finally {
        if (!cancelled) setReady(true)
      }
    }
    void init()
    return () => {
      cancelled = true
    }
  }, [notify])

  const makeEngine = useCallback(() => {
    if (!canvasRef.current) throw new Error('模拟器画面尚未就绪')
    const engine = createEmulator(canvasRef.current, {
      onStatus: setStatus,
      onFps: setFps,
      onProgress: setProgress,
      onError: (error) => {
        setLaunchError(error.message)
        notify(error.message, true)
      },
      onSaveChange: (bytes) => {
        const game = activeRef.current
        if (game && !maintenanceRef.current)
          void trackWrite(db.setBatterySave(game.id, bytes)).catch(() =>
            notify('游戏内存档写入失败，请导出备份', true),
          )
      },
    })
    return engine
  }, [notify, trackWrite])

  useEffect(() => {
    const engine = makeEngine()
    engineRef.current = engine
    return () => {
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [makeEngine])

  useEffect(() => {
    if (modal !== 'backup' && !deleteTarget && !batchDeleteTargets) maintenanceRef.current = false
  }, [modal, deleteTarget, batchDeleteTargets])

  useEffect(() => {
    if (active || busy || !returnFocusPending.current) return
    returnFocusPending.current = false
    const name = (element: HTMLElement) =>
      element.getAttribute('aria-label') ?? element.textContent?.trim()
    const available = (element: HTMLElement) =>
      !element.matches(':disabled') && element.getClientRects().length > 0
    const previous = launchTrigger.current
    const target =
      previous?.isConnected && available(previous) && name(previous) === launchTriggerName.current
        ? previous
        : (Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
            (element) => available(element) && name(element) === launchTriggerName.current,
          ) ??
          document.querySelector<HTMLButtonElement>('.hero-actions button:not(:disabled)') ??
          document.querySelector<HTMLButtonElement>('.import-top:not(:disabled)'))
    target?.focus()
  }, [active, busy])

  useEffect(() => {
    if (!busy || modal !== 'backup') return
    const previous = document.activeElement as HTMLElement | null
    modalRef.current?.focus()
    return () => {
      if (previous?.isConnected && !previous.matches(':disabled')) previous.focus()
    }
  }, [busy, modal])

  useEffect(() => {
    settingsRef.current = settings
    try {
      localStorage.setItem('advance.settings', JSON.stringify(settings))
    } catch {
      notify('设置无法持久保存：本地存储空间不足', true)
    }
    engineRef.current?.setVolume(settings.volume)
    engineRef.current?.setSpeed(settings.speed)
  }, [settings, notify])

  useEffect(() => {
    const update = () => {
      const stage = stageRef.current
      const active = Boolean(stage && fullscreenElement() === stage)
      setFullscreenActive(active)
      setFullscreenAvailable(Boolean(stage && fullscreenSupported(stage)))
      if (!active) {
        try {
          screen.orientation?.unlock()
        } catch {
          /* Browsers may expose orientation without allowing unlock. */
        }
      }
    }
    update()
    return watchFullscreen(update)
  }, [])

  const snapshot = useCallback(
    async (slot: number, silent = false) => {
      const game = activeRef.current,
        engine = engineRef.current
      if (!game || !engine || !['running', 'paused'].includes(engine.status)) return
      const data = await engine.saveState()
      let screenshot: string | undefined
      try {
        const blob = await engine.screenshot()
        screenshot = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      } catch {
        /* Save data remains useful without a thumbnail. */
      }
      const savedState = await db.saveState(game.id, slot, data, screenshot)
      setStates(await db.getStates(game.id))
      if (!silent) notify(isAutomaticSlot(slot) ? '自动存档已更新' : `已保存到存档位 ${slot}`)
      return savedState
    },
    [notify],
  )

  const automaticSnapshot = useCallback(async () => {
    const game = activeRef.current
    if (!game) return
    const saved = await db.getStates(game.id)
    const slot = nextAutomaticSlot(saved, settingsRef.current.autoSaveSlotCount)
    const savedState = await snapshot(slot, true)
    if (savedState) {
      try {
        updateSessionRecoveryState(game.id, savedState)
      } catch {
        /* A completed save remains valid even if the lightweight journal is unavailable. */
      }
    }
  }, [snapshot])

  useEffect(() => {
    if (!active || status !== 'running') return
    let lastTick = Date.now()
    const tick = async () => {
      const now = Date.now(),
        elapsed = Math.floor((now - lastTick) / 1000)
      lastTick = now
      if (elapsed < 1 || maintenanceRef.current) return
      try {
        const current = (await db.getGames()).find((g) => g.id === active.id)
        if (current && !maintenanceRef.current) {
          await db.updateGame(active.id, { playTime: current.playTime + elapsed })
          await refresh()
        }
      } catch {
        /* Report explicit save failures through the save controls. */
      }
    }
    const timer = setInterval(() => {
      void trackWrite(tick())
    }, 15000)
    return () => {
      clearInterval(timer)
      void trackWrite(tick())
    }
  }, [active, status, refresh, trackWrite])

  useEffect(() => {
    if (!active || !settings.autoSave || status !== 'running') return
    const timer = setInterval(() => {
      if (!operationRef.current) void run(automaticSnapshot)
    }, settings.autoSaveInterval * 60_000)
    return () => clearInterval(timer)
  }, [active, status, settings.autoSave, settings.autoSaveInterval, run, automaticSnapshot])

  useEffect(() => {
    const release = () => {
      releaseInputs()
    }
    const visibility = () => {
      if (document.hidden) {
        release()
        if (engineRef.current?.status === 'running') {
          try {
            engineRef.current.pause()
          } catch (error) {
            notify(error instanceof Error ? error.message : '暂停时保存失败，请导出备份', true)
          }
          if (settingsRef.current.autoSave && !operationRef.current) void run(automaticSnapshot)
        }
      }
    }
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [run, automaticSnapshot, releaseInputs, notify])

  useEffect(() => {
    if (!inputEnabled) releaseInputs()
  }, [inputEnabled, releaseInputs])

  useEffect(() => {
    if (page === 'states')
      void Promise.all(games.map((game) => db.getStates(game.id)))
        .then((result) => setAllStates(result.flat()))
        .catch(() => notify('无法读取存档', true))
  }, [page, games, states, notify])

  useEffect(() => {
    if (!modal && !deleteTarget && !batchDeleteTargets) return
    releaseInputs()
    const previous =
      modal === 'backup' ? backupTrigger.current : (document.activeElement as HTMLElement | null)
    const first = modalRef.current?.querySelector<HTMLElement>('button, input, select')
    first?.focus()
    const trap = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !mappingRef.current &&
        !event.defaultPrevented &&
        !operationRef.current
      ) {
        setModal(null)
        setDeleteTarget(null)
        setBatchDeleteTargets(null)
      }
      if (event.key !== 'Tab') return
      if (operationRef.current) {
        event.preventDefault()
        modalRef.current?.focus()
        return
      }
      const elements = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]',
        ) || [],
      ).filter((element) => element.getClientRects().length > 0)
      if (!elements.length) {
        event.preventDefault()
        modalRef.current?.focus()
        return
      }
      const first = elements[0],
        last = elements[elements.length - 1]
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !elements.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault()
        last.focus()
      }
      if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !elements.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.removeEventListener('keydown', trap)
      if (previous?.isConnected) previous.focus()
    }
  }, [modal, deleteTarget, batchDeleteTargets, releaseInputs])

  const loadGameSession = useCallback(
    async (
      game: Game,
      requestedState?: Pick<SaveState, 'data'> & Partial<Pick<SaveState, 'slot' | 'createdAt'>>,
      quietResume = false,
      launchPolicy: LaunchPolicy = 'remembered',
    ) => {
      const engine = engineRef.current
      if (!engine) throw new Error('模拟器尚未就绪')
      const previousGame = activeRef.current
      const startingNewSession = !previousGame || previousGame.id !== game.id
      if (!previousGame) {
        launchTrigger.current = document.activeElement as HTMLElement
        launchTriggerName.current =
          launchTrigger.current.getAttribute('aria-label') ??
          launchTrigger.current.textContent?.trim() ??
          ''
      }
      releaseInputs()
      if (activeRef.current && ['running', 'paused'].includes(engine.status)) {
        engine.pause()
        if (settingsRef.current.autoSave) await automaticSnapshot()
        const battery = await engine.exportSave()
        if (battery) await db.setBatterySave(activeRef.current.id, battery)
      }
      const bytes = await account.ensureRom(game.id)
      if (!bytes) throw new Error('游戏 ROM 尚未下载，请登录对应账号或重新导入')
      const battery = await db.getBatterySave(game.id)
      const currentGame = (await db.getGames()).find((item) => item.id === game.id) ?? game
      const shouldLoadAutomaticState =
        launchPolicy === 'auto' ||
        (launchPolicy === 'remembered' &&
          settingsRef.current.autoSave &&
          !currentGame.skipAutoState)
      const savedStates = shouldLoadAutomaticState ? await db.getStates(game.id) : []
      const preferredAutoState =
        currentGame.resumeAutoSaveSlot === undefined
          ? undefined
          : savedStates.find((state) => state.slot === currentGame.resumeAutoSaveSlot)
      const resume =
        requestedState ||
        (shouldLoadAutomaticState
          ? (preferredAutoState ??
            latestAutomaticState(savedStates, settingsRef.current.autoSaveSlotCount))
          : undefined)
      // loadRom flushes the previous cartridge. Keep its identity until that flush ends.
      setActive(currentGame)
      setPage('library')
      setModal(null)
      setProgress(`正在启动 ${PLATFORM_REGISTRY[currentGame.platform].label} 模拟核心…`)
      setLaunchError('')
      await engine.loadRom(bytes, currentGame.filename, currentGame.platform, currentGame.cheats)
      activeRef.current = currentGame
      if (battery) await engine.importSave(battery)
      engine.setVolume(settingsRef.current.volume)
      engine.setSpeed(settingsRef.current.speed)
      if (resume) {
        try {
          await engine.loadState(resume.data)
          if (!quietResume) notify('已从存档继续游戏')
        } catch {
          notify('此即时存档无法恢复，已重新启动游戏', true)
        }
      }
      await db.updateGame(game.id, { lastPlayed: Date.now() })
      setStates(await db.getStates(game.id))
      if (startingNewSession) {
        if (previousGame) {
          try {
            clearSessionRecovery(previousGame.id)
          } catch {
            /* The new session record below replaces a stale previous record when possible. */
          }
        }
        const resumeReference =
          resume && typeof resume.slot === 'number' && typeof resume.createdAt === 'number'
            ? { slot: resume.slot, createdAt: resume.createdAt }
            : undefined
        try {
          setRecoveryRecord(
            beginSessionRecovery(
              currentGame.id,
              coreIdForPlatform(currentGame.platform),
              resumeReference,
            ),
          )
          setRecoveryState(null)
        } catch {
          setRecoveryRecord(null)
          setRecoveryState(null)
        }
      }
      await refresh()
      canvasRef.current?.focus({ preventScroll: true })
      stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    [automaticSnapshot, notify, refresh, releaseInputs, account],
  )

  const playGame = useCallback(
    (game: Game, requestedState?: SaveState) => {
      if (requestedState) return run(() => loadGameSession(game, requestedState))
      return run(async () => {
        const savedStates = await db.getStates(game.id)
        const automaticState = latestAutomaticState(
          savedStates,
          settingsRef.current.autoSaveSlotCount,
        )
        const selectedState = savedStates.find((state) => state.slot === game.launchStateSlot)
        setLaunchTarget(game)
        setLaunchStates(savedStates)
        setLaunchMode(game.launchMode ?? (automaticState ? 'auto' : 'fresh'))
        setLaunchStateSlot(selectedState?.slot ?? savedStates[0]?.slot ?? null)
        setModal('launch')
      })
    },
    [run, loadGameSession],
  )

  const confirmLaunch = () =>
    run(async () => {
      if (!launchTarget) return
      const requestedState =
        launchMode === 'state'
          ? launchStates.find((state) => state.slot === launchStateSlot)
          : undefined
      if (launchMode === 'state' && !requestedState) throw new Error('请选择一个可用的即时存档')
      const updated = await db.updateGame(launchTarget.id, {
        launchMode,
        launchStateSlot: launchMode === 'state' ? requestedState?.slot : undefined,
        ...(launchMode === 'auto' ? { skipAutoState: false } : {}),
      })
      await loadGameSession(
        updated,
        requestedState,
        false,
        launchMode === 'state' ? 'fresh' : launchMode,
      )
    })

  const ignoreRecovery = () => {
    try {
      clearSessionRecovery(recoveryRecord?.gameId)
    } catch {
      /* Dismissing the prompt remains available when storage permissions change. */
    }
    setRecoveryRecord(null)
    setRecoveryState(null)
    setModal(null)
  }

  const recoverUnfinishedSession = () =>
    run(async () => {
      if (!recoveryGame || !recoveryState || !recoveryCoreMatches || !recoveryStateMatches)
        throw new Error('恢复所需的游戏或即时存档不可用')
      await loadGameSession(recoveryGame, recoveryState, false, 'fresh')
    })

  const startRecoveryFresh = () =>
    run(async () => {
      if (!recoveryGame) throw new Error('游戏不在本地游戏库中，请先重新导入 ROM')
      await loadGameSession(recoveryGame, undefined, false, 'fresh')
    })

  const openCheats = () => {
    const game = activeRef.current
    if (!game || !PLATFORM_REGISTRY[game.platform].capabilities.cheats) return
    setCheatDrafts((game.cheats ?? []).map((cheat) => ({ ...cheat })))
    setModal('cheats')
  }

  const applyCheats = () =>
    run(async () => {
      const game = activeRef.current
      const engine = engineRef.current
      if (!game || !engine) return
      const cheats = validateCheats(cheatDrafts)
      const liveState = await engine.saveState()
      const updated = await db.updateGame(game.id, { cheats })
      await loadGameSession(updated, { data: liveState }, true)
      notify(
        cheats.some((cheat) => cheat.enabled)
          ? '金手指已应用并重新载入游戏'
          : '金手指已保存，游戏已恢复',
      )
    })

  const closeGame = () =>
    run(async () => {
      const engine = engineRef.current,
        game = activeRef.current
      const sessionGameId = game?.id ?? active?.id
      if (game && engine && ['running', 'paused'].includes(engine.status)) {
        engine.pause()
        if (settings.autoSave) await automaticSnapshot()
        const battery = await engine.exportSave()
        if (battery) await db.setBatterySave(game.id, battery)
        engine.pause()
        engine.releaseAllKeys()
      }
      if (sessionGameId) {
        try {
          clearSessionRecovery(sessionGameId)
          setRecoveryRecord(null)
          setRecoveryState(null)
        } catch {
          /* Closing the emulator must still succeed when localStorage is unavailable. */
        }
      }
      activeRef.current = null
      returnFocusPending.current = true
      setActive(null)
      setStates([])
      await refresh()
      notify('已返回游戏库')
    })

  const loadSlot = (slot: number) =>
    run(async () => {
      if (!activeRef.current) return
      const state = await db.getState(activeRef.current.id, slot)
      if (!state) throw new Error('此存档位还没有存档')
      await engineRef.current?.loadState(state.data)
      notify('已恢复存档')
      setModal(null)
    })
  const togglePause = () => {
    const engine = engineRef.current
    if (!engine || !activeRef.current || operationRef.current) return
    try {
      if (engine.status === 'running') engine.pause()
      else if (engine.status === 'paused') engine.resume()
    } catch (error) {
      notify(error instanceof Error ? error.message : '暂停或继续失败，请重试', true)
    }
    canvasRef.current?.focus({ preventScroll: true })
  }
  const screenshot = () =>
    run(async () => {
      if (!activeRef.current || !engineRef.current) return
      download(await engineRef.current.screenshot(), `${activeRef.current.title}-${Date.now()}.png`)
      notify('截图已下载')
    })
  const fullscreen = async () => {
    const stage = stageRef.current
    if (!stage || !fullscreenSupported(stage)) {
      notify('当前浏览器不支持网页全屏，请使用浏览器菜单进入全屏', true)
      return
    }
    try {
      if (fullscreenElement()) await exitFullscreen()
      else await enterFullscreen(stage)
    } catch {
      notify('浏览器阻止了全屏，请再次点击全屏按钮或检查网站权限', true)
    }
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (mapping) {
        event.preventDefault()
        if (event.code === 'Escape') {
          setMapping(null)
          return
        }
        if (!isBindingCode(event.code)) {
          notify('请选择字母、数字、方向键或其他可用按键；快捷操作键保留给模拟器')
          return
        }
        const existing = Object.entries(settings.bindings).find(
          ([key, code]) => key !== mapping && code === event.code,
        )
        if (existing) {
          const existingButton = existing[0] as EmulatorButton
          const platform = activeRef.current?.platform ?? 'gba'
          if (platformSupportsButton(platform, existingButton)) {
            notify(`此按键已用于「${buttonNames[existingButton]}」`)
            return
          }
          setSettings((value) => ({
            ...value,
            bindings: {
              ...value.bindings,
              [existingButton]: value.bindings[mapping],
              [mapping]: event.code,
            },
          }))
          setMapping(null)
          return
        }
        setSettings((value) => ({
          ...value,
          bindings: { ...value.bindings, [mapping]: event.code },
        }))
        setMapping(null)
        return
      }
      if (
        modal ||
        deleteTarget ||
        batchDeleteTargets ||
        !activeRef.current ||
        (event.target instanceof HTMLElement &&
          (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) ||
            event.target.isContentEditable))
      )
        return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      // Gameplay shortcuts own the focused screen; the rest of the interface
      // keeps normal Tab navigation and Enter/Space button activation.
      if (document.activeElement !== canvasRef.current) return
      if (event.code === 'Escape') {
        releaseInputs()
        stageRef.current
          ?.querySelector<HTMLButtonElement>('.player-toolbar button:not(:disabled)')
          ?.focus()
        return
      }
      if (event.code === 'Tab' && event.shiftKey) return
      const button = (Object.entries(settings.bindings) as [EmulatorButton, string][]).find(
        ([, code]) => code === event.code,
      )?.[0]
      if (button) {
        if (!platformSupportsButton(activeRef.current.platform, button)) return
        event.preventDefault()
        if (!event.repeat && inputEnabled) input.press('keyboard', button)
        return
      }
      if (['Space', 'F5', 'F8', 'Tab', 'F11', 'Backspace'].includes(event.code))
        event.preventDefault()
      if (event.repeat) return
      if (event.code === 'Space') togglePause()
      if (event.code === 'F5') void run(() => snapshot(1))
      if (event.code === 'F8') void loadSlot(1)
      const capabilities = PLATFORM_REGISTRY[activeRef.current.platform].capabilities
      if (event.code === 'Tab' && capabilities.speedControl) engineRef.current?.setSpeed(2)
      if (event.code === 'Backspace' && capabilities.rewind) engineRef.current?.setRewind(true)
      if (event.code === 'F11') void fullscreen()
    }
    const keyup = (event: KeyboardEvent) => {
      const button = (Object.entries(settings.bindings) as [EmulatorButton, string][]).find(
        ([, code]) => code === event.code,
      )?.[0]
      if (button) input.release('keyboard', button)
      const platform = activeRef.current?.platform
      if (event.code === 'Tab' && platform && PLATFORM_REGISTRY[platform].capabilities.speedControl)
        engineRef.current?.setSpeed(settings.speed)
      if (event.code === 'Backspace' && platform && PLATFORM_REGISTRY[platform].capabilities.rewind)
        engineRef.current?.setRewind(false)
    }
    window.addEventListener('keydown', keydown)
    window.addEventListener('keyup', keyup)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('keyup', keyup)
    }
  })

  const importFiles = (files: File[]) =>
    run(async () => {
      if (!files.length) return
      let imported = 0
      let duplicates = 0
      const errors: string[] = []
      const known = new Set((await db.getGames()).map((game) => game.id))
      try {
        for (const file of files) {
          setImportLabel(/\.zip$/i.test(file.name) ? '正在解压…' : '正在导入…')
          try {
            for await (const rom of extractRomFiles(file)) {
              try {
                const game = await db.importGame(rom)
                if (known.has(game.id)) duplicates++
                else {
                  known.add(game.id)
                  imported++
                }
              } catch (error) {
                errors.push(`${rom.name}：${error instanceof Error ? error.message : '导入失败'}`)
              }
            }
          } catch (error) {
            errors.push(`${file.name}：${error instanceof Error ? error.message : '导入失败'}`)
          }
        }
        await refresh()
        setPage('library')
        const result = [
          imported ? `已导入 ${imported} 个游戏` : '',
          duplicates ? `${duplicates} 个重复游戏已合并` : '',
        ]
          .filter(Boolean)
          .join('；')
        const failure =
          errors.slice(0, 3).join('；') +
          (errors.length > 3 ? `；另有 ${errors.length - 3} 项失败` : '')
        notify(
          errors.length
            ? [result, failure].filter(Boolean).join('；')
            : duplicates
              ? result
              : `${result}，准备开始吧`,
          errors.length > 0,
        )
      } finally {
        setImportLabel(null)
      }
    })
  const favorite = async (game: Game) => {
    try {
      await db.updateGame(game.id, { favorite: !game.favorite })
      await refresh()
      setGameMenu(null)
    } catch {
      notify('收藏更新失败', true)
    }
  }
  const discardSession = () => {
    const gameId = activeRef.current?.id
    if (gameId) {
      try {
        clearSessionRecovery(gameId)
      } catch {
        /* Session disposal remains available when localStorage is unavailable. */
      }
    }
    setRecoveryRecord(null)
    setRecoveryState(null)
    activeRef.current = null
    engineRef.current?.dispose()
    engineRef.current = makeEngine()
    setActive(null)
    setStates([])
    setStatus('idle')
    setFps(0)
  }
  const openBackup = () =>
    run(async () => {
      backupTrigger.current = document.activeElement as HTMLElement | null
      maintenanceRef.current = true
      try {
        releaseInputs()
        engineRef.current?.pause()
        await Promise.all(Array.from(pendingWrites.current))
        const game = activeRef.current
        const engine = engineRef.current
        if (game && engine && ['running', 'paused'].includes(engine.status)) {
          // Explicit capture is required: pause's best-effort callback is insufficient.
          const bytes = await engine.exportSave()
          if (bytes) await db.setBatterySave(game.id, bytes)
        }
        await refresh()
        setSidebarOpen(false)
        setModal('backup')
      } catch (error) {
        maintenanceRef.current = false
        throw error
      }
    })
  const exportLibrary = async (
    ids: string[],
    includeRoms: boolean,
    onProgress: (message: string) => void,
  ) => {
    onProgress('正在读取游戏库快照…')
    const data = await db.getLibrarySnapshot(ids, includeRoms)
    const bytes = await createBackup(data, { includeRoms, onProgress })
    download(bytes, `orbitra-backup-${new Date().toISOString().slice(0, 10)}.zip`)
  }
  const restoreLibrary = async (data: BackupData, choices: db.RestoreChoices) => {
    await db.restoreLibrary(data, choices)
    // Discard the old core while writes are still blocked; it must never resume stale SRAM.
    discardSession()
    setPage('library')
    setAllStates([])
    try {
      await refresh()
    } catch {
      notify('恢复已完成，但游戏库列表刷新失败，请刷新页面查看恢复结果。', true)
    }
  }
  const deleteGame = () =>
    run(async () => {
      if (!deleteTarget) return
      await db.deleteGame(deleteTarget.id)
      if (activeRef.current?.id === deleteTarget.id) discardSession()
      setDeleteTarget(null)
      setGameMenu(null)
      await refresh()
      notify('游戏及其存档已删除')
    })
  const deleteSelectedGames = () =>
    run(async () => {
      if (!batchDeleteTargets?.length) return
      const targets = batchDeleteTargets.filter(
        (game) => !isDemo(game) && activeRef.current?.id !== game.id,
      )
      const results = await Promise.allSettled(targets.map((game) => db.deleteGame(game.id)))
      const failedIds = new Set(
        targets.filter((_, index) => results[index].status === 'rejected').map((game) => game.id),
      )
      const deletedCount = targets.length - failedIds.size
      setBatchDeleteTargets(null)
      setGameMenu(null)
      await refresh()
      if (failedIds.size) {
        setSelectedGameIds(failedIds)
        throw new Error(
          deletedCount
            ? `已删除 ${deletedCount} 个游戏，另有 ${failedIds.size} 个删除失败，请重试。`
            : `${failedIds.size} 个游戏删除失败，请重试。`,
        )
      }
      setSelectedGameIds(new Set())
      setSelectionMode(false)
      notify(`已删除 ${deletedCount} 个游戏及其存档`)
    })
  const exportBattery = () =>
    run(async () => {
      const game = activeRef.current
      if (!game) return
      const bytes = (await engineRef.current?.exportSave()) || (await db.getBatterySave(game.id))
      if (!bytes?.length) throw new Error('此游戏尚未生成游戏内存档。你可以先创建即时存档。')
      download(bytes, game.filename.replace(/\.[^.]+$/i, '.sav'))
      notify('游戏内存档已导出')
    })
  const importBattery = (file?: File) =>
    run(async () => {
      const game = activeRef.current
      if (!file || !game) return
      if (!/\.sav$/i.test(file.name) || file.size < 1 || file.size > 1048576)
        throw new Error('请选择有效的 .sav 存档文件（最大 1 MB）')
      const bytes = new Uint8Array(await file.arrayBuffer())
      await engineRef.current?.importSave(bytes)
      await db.setBatterySave(game.id, bytes)
      await automaticSnapshot()
      notify('存档已导入，游戏已重新启动')
    })
  const importSnapshot = (file?: File) =>
    run(async () => {
      if (!file || !activeRef.current) return
      if (!/\.ss[0-9]?$|\.state$/i.test(file.name) || file.size < 1 || file.size > 32 * 1024 * 1024)
        throw new Error('请选择当前核心生成的即时存档（.state / .ss0，最大 32 MiB）')
      await engineRef.current?.loadState(new Uint8Array(await file.arrayBuffer()))
      notify('即时存档已恢复')
      setModal(null)
    })

  const pageGames = useMemo(
    () =>
      games.filter(
        (game) => (page !== 'favorites' || game.favorite) && (page !== 'recent' || game.lastPlayed),
      ),
    [games, page],
  )
  const recentGame = useMemo(() => mostRecentPlayedGame(games), [games])
  useEffect(() => {
    let cancelled = false
    if (!recentGame) {
      setContinueState(null)
      return
    }
    void db
      .getStates(recentGame.id)
      .then((saved) => {
        if (!cancelled)
          setContinueState(latestAutomaticState(saved, settings.autoSaveSlotCount) ?? null)
      })
      .catch(() => {
        if (!cancelled) setContinueState(null)
      })
    return () => {
      cancelled = true
    }
  }, [recentGame, settings.autoSaveSlotCount, active])
  const visibleGames = useMemo(
    () =>
      pageGames
        .filter(
          (game) =>
            (platformFilter === 'all' || game.platform === platformFilter) &&
            displayTitle(game).toLowerCase().includes(search.toLowerCase()),
        )
        .sort((a, b) =>
          sort === 'name'
            ? displayTitle(a).localeCompare(displayTitle(b), 'zh-CN')
            : sort === 'added'
              ? b.addedAt - a.addedAt
              : (b.lastPlayed || 0) - (a.lastPlayed || 0) || b.addedAt - a.addedAt,
        ),
    [pageGames, platformFilter, search, sort],
  )
  const selectableVisibleGames = useMemo(
    () => visibleGames.filter((game) => !isDemo(game) && active?.id !== game.id),
    [visibleGames, active],
  )
  const allVisibleSelected =
    selectableVisibleGames.length > 0 &&
    selectableVisibleGames.every((game) => selectedGameIds.has(game.id))
  const toggleGameSelection = (game: Game) => {
    if (isDemo(game) || activeRef.current?.id === game.id) return
    setSelectedGameIds((current) => {
      const next = new Set(current)
      if (next.has(game.id)) next.delete(game.id)
      else next.add(game.id)
      return next
    })
  }
  const toggleVisibleSelection = () =>
    setSelectedGameIds((current) => {
      const next = new Set(current)
      for (const game of selectableVisibleGames) {
        if (allVisibleSelected) next.delete(game.id)
        else next.add(game.id)
      }
      return next
    })

  useEffect(() => {
    if (page === 'library') return
    setSelectionMode(false)
    setSelectedGameIds(new Set())
    setBatchDeleteTargets(null)
  }, [page])

  useEffect(() => {
    const availableIds = new Set(
      games.filter((game) => !isDemo(game) && active?.id !== game.id).map((game) => game.id),
    )
    setSelectedGameIds((current) => {
      const next = new Set(Array.from(current).filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [games, active])
  const selectedPlatform = platformFilter === 'all' ? undefined : PLATFORM_REGISTRY[platformFilter]
  const emptyStateCopy = search
    ? {
        title: '没有找到这个游戏',
        description: '换个关键词试试，或导入新的游戏。',
      }
    : page === 'favorites'
      ? {
          title: selectedPlatform
            ? `还没有收藏的 ${selectedPlatform.label} 游戏`
            : '收藏你的第一款游戏',
          description: selectedPlatform
            ? `在游戏库中收藏一款 ${selectedPlatform.label} 游戏，它会显示在这里。`
            : '点击游戏卡片上的爱心，将喜欢的游戏留在这里。',
        }
      : page === 'recent'
        ? {
            title: selectedPlatform
              ? `还没有最近游玩的 ${selectedPlatform.label} 游戏`
              : '你的冒险即将开始',
            description: selectedPlatform
              ? `开始一款 ${selectedPlatform.label} 游戏，下次就能从这里快速找到。`
              : '开始一款游戏，下次就能从这里快速找到。',
          }
        : {
            title: selectedPlatform ? `还没有 ${selectedPlatform.label} 游戏` : '游戏库还是空的',
            description: selectedPlatform
              ? `导入 ${selectedPlatform.extensions.join(' / ')} ROM，游戏会自动归入此平台。`
              : '点击导入，添加你的第一款游戏。',
          }
  const demo = games.find(isDemo)
  const activePlatform = PLATFORM_REGISTRY[active?.platform ?? 'gba']
  const capabilityDefinition = PLATFORM_REGISTRY[capabilityPlatform]
  const capabilityCore = CORE_REGISTRY[capabilityDefinition.core]
  const capabilityReport = capabilityReportForPlatform(capabilityPlatform)
  const effectiveSpeed = activePlatform.capabilities.speedControl ? settings.speed : 1
  const canControl = Boolean(active && ['running', 'paused'].includes(status) && !busy)
  const setSetting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((previous) => ({ ...previous, [key]: value }))
  const navigate = (next: Page) => {
    setPage(next)
    setSearch('')
    setSidebarOpen(false)
  }
  return (
    <div
      className="app-shell"
      onDragEnter={(event) => {
        event.preventDefault()
        if (event.dataTransfer.types.includes('Files')) {
          dragCount.current++
          setDragging(true)
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault()
        if (--dragCount.current <= 0) {
          dragCount.current = 0
          setDragging(false)
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        dragCount.current = 0
        setDragging(false)
        void importFiles(Array.from(event.dataTransfer.files))
      }}
    >
      <input
        ref={inputRef}
        type="file"
        aria-label="选择游戏文件"
        accept={acceptedGameFiles}
        multiple
        hidden
        onChange={(event) => {
          void importFiles(Array.from(event.target.files || []))
          event.target.value = ''
        }}
      />
      <input
        ref={directoryInputRef}
        type="file"
        aria-label="选择游戏文件夹"
        accept={acceptedGameFiles}
        multiple
        hidden
        webkitdirectory=""
        onChange={(event) => {
          const files = importableRomFiles(event.target.files || [])
          if (files.length) void importFiles(files)
          else notify(`所选文件夹中没有找到 ${romFormatLabel} / ZIP 游戏文件`, true)
          event.target.value = ''
        }}
      />
      <input
        ref={saveInputRef}
        type="file"
        accept=".sav"
        hidden
        onChange={(event) => {
          void importBattery(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <input
        ref={stateInputRef}
        type="file"
        accept=".state,.ss0,.ss1,.ss2,.ss3,.ss4,.ss5,.ss6,.ss7,.ss8,.ss9"
        hidden
        onChange={(event) => {
          void importSnapshot(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside
        className={`sidebar ${sidebarOpen ? 'open' : ''}`}
        inert={Boolean(modal || deleteTarget || batchDeleteTargets)}
      >
        <a
          href="#"
          className="brand"
          onClick={(event) => {
            event.preventDefault()
            navigate('library')
          }}
        >
          <img className="brand-mark" src="/favicon.svg" alt="" />
          <span>
            orbitra<span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-label">
          你的经典游戏空间 <span>BETA</span>
        </div>
        <div className="nav-group-title">工作台</div>
        <nav aria-label="主导航">
          {(
            [
              ['library', LayoutGrid],
              ['recent', Clock3],
              ['favorites', Heart],
              ['states', Save],
              ['online-library', CloudDownload],
            ] as const
          ).map(([key, Icon]) => (
            <button
              key={key}
              className={`nav-item ${page === key ? 'active' : ''}`}
              onClick={() => navigate(key)}
            >
              <Icon size={18} />
              <span>{pages[key]}</span>
              {key === 'library' && <span className="nav-count">{games.length}</span>}
              {key === 'favorites' && games.some((g) => g.favorite) && (
                <span className="nav-count">{games.filter((g) => g.favorite).length}</span>
              )}
              {key === 'online-library' &&
                (onlineLibrary.phase === 'loading' || onlineLibrary.phase === 'importing') && (
                  <LoaderCircle
                    size={14}
                    className="account-spinner"
                    aria-label="正在读取在线游戏库"
                  />
                )}
            </button>
          ))}
        </nav>
        <div className="nav-group-title second">偏好设置</div>
        <nav aria-label="偏好设置">
          <button
            className="nav-item"
            onClick={() => {
              setModal('account')
              setSidebarOpen(false)
            }}
          >
            <UserRound size={18} />
            <span className="account-nav-label" title={account.user?.username}>
              {account.user ? account.user.username : '登录与同步'}
            </span>
            {account.phase === 'syncing' ? (
              <LoaderCircle size={14} className="account-spinner" aria-label="正在同步" />
            ) : null}
          </button>
          <button className="nav-item" disabled={busy || !ready} onClick={() => void openBackup()}>
            <HardDrive size={18} />
            <span>备份与恢复</span>
          </button>
          <button
            className="nav-item"
            onClick={() => {
              setModal('controls')
              setSidebarOpen(false)
            }}
          >
            <Gamepad2 size={18} />
            <span>控制器设置</span>
          </button>
          <button
            className="nav-item"
            onClick={() => {
              setModal('settings')
              setSidebarOpen(false)
            }}
          >
            <SlidersHorizontal size={18} />
            <span>模拟器设置</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <div className="local-note-icon">
              <ShieldCheck size={19} />
            </div>
            <strong>{account.user ? '账号同步已开启' : '只属于你的游戏时光'}</strong>
            <p>
              {account.user ? '游戏与存档已保存到账号，' : '游戏与存档保存在此设备，'}
              <br />
              {account.user ? '换个浏览器也能继续。' : '登录后可跨浏览器恢复。'}
            </p>
            <span>
              <span className="status-dot" />
              {account.user ? `已登录 · ${account.user.username}` : '本地运行 · 隐私优先'}
            </span>
          </div>
          <button className="help-link" onClick={() => setModal('help')}>
            <CircleHelp size={17} />
            <span>帮助与快捷键</span>
            <span className="version">v1.4</span>
          </button>
          <div className="sidebar-footer">
            <span className="avatar">
              {account.user?.username.slice(0, 1).toUpperCase() ?? 'P'}
            </span>
            <div>
              <strong>{account.user?.username ?? 'Player One'}</strong>
              <small>{account.user ? account.message : '今天也要玩得开心'}</small>
            </div>
            <span className="online-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell" inert={Boolean(modal || deleteTarget || batchDeleteTargets)}>
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton
              label="打开导航"
              className="mobile-menu"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </IconButton>
            <span>工作台</span>
            <ChevronRight size={13} />
            <strong>{pages[page]}</strong>
          </div>
          <div className="topbar-right">
            <OfflineStatus />
            <span className="topbar-divider" />
            <button
              className={`environment-button ${compatibility ? (compatibility.ready && !compatibilityRenderingWarning ? 'ready' : 'warning') : 'pending'}`}
              onClick={() => setCompatibilityOpen((open) => !open)}
              aria-expanded={compatibilityOpen}
              aria-controls="compatibility-panel"
              aria-label="环境检查"
              title="环境检查"
              disabled={!compatibility}
            >
              {compatibility ? (
                compatibility.ready && !compatibilityRenderingWarning ? (
                  <ShieldCheck size={16} />
                ) : compatibility.ready ? (
                  <ShieldAlert size={16} />
                ) : (
                  <CloudOff size={16} />
                )
              ) : (
                <LoaderCircle className="spin" size={16} />
              )}
              <span>{compatibility ? '环境检查' : '检查环境…'}</span>
            </button>
            <span className="topbar-divider" />
            <span className={`connection ${gamepad ? 'connected' : ''}`}>
              <Gamepad2 size={16} />
              {gamepad ? '手柄已连接' : '键盘已就绪'}
            </span>
            <span className="topbar-divider" />
            <button className="shortcut-button" onClick={() => setModal('help')}>
              <Keyboard size={17} />
              <span>快捷键</span>
            </button>
          </div>
        </header>
        {compatibilityOpen && compatibility && (
          <section
            className="compatibility-panel"
            id="compatibility-panel"
            aria-label="运行环境检查"
          >
            <div className="compatibility-heading">
              <div>
                <strong>环境与核心能力</strong>
                <p>
                  {compatibilityView === 'cores'
                    ? '按当前适配层与已记录验证展示，不从上游核心能力推断支持。'
                    : !compatibility.ready
                      ? '有能力未满足，可能导致核心无法启动。'
                      : compatibilityRenderingWarning
                        ? '可以启动；部分能力将使用兼容模式。'
                        : '模拟器运行所需能力已就绪。'}
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="关闭环境检查"
                onClick={() => setCompatibilityOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="compatibility-tabs" role="tablist" aria-label="诊断视图">
              <button
                role="tab"
                aria-selected={compatibilityView === 'environment'}
                onClick={() => setCompatibilityView('environment')}
              >
                浏览器环境
              </button>
              <button
                role="tab"
                aria-selected={compatibilityView === 'cores'}
                onClick={() => setCompatibilityView('cores')}
              >
                核心能力
              </button>
            </div>
            {compatibilityView === 'environment' ? (
              <div className="compatibility-grid">
                {compatibility.checks.map((check) => (
                  <div className={`compatibility-check ${check.status}`} key={check.id}>
                    <span className="compatibility-mark" aria-hidden="true">
                      {check.status === 'ok' ? (
                        <Check size={14} />
                      ) : check.status === 'warning' ? (
                        '!'
                      ) : (
                        <X size={14} />
                      )}
                    </span>
                    <div>
                      <strong>{check.label}</strong>
                      <span>{check.detail}</span>
                      {check.action && <small>{check.action}</small>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="core-capability-view">
                <div className="core-capability-toolbar">
                  <label>
                    <span>平台</span>
                    <select
                      aria-label="选择能力平台"
                      value={capabilityPlatform}
                      onChange={(event) =>
                        setCapabilityPlatform(event.target.value as GamePlatform)
                      }
                    >
                      {PLATFORM_LIST.map((platform) => (
                        <option key={platform.id} value={platform.id}>
                          {platform.label} · {platform.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="core-capability-identity">
                    <strong>{capabilityCore.name}</strong>
                    <span>
                      {capabilityCore.version} · 状态格式 {capabilityCore.stateFormat}
                    </span>
                  </div>
                </div>
                <div className="core-capability-grid" role="list" aria-label="核心能力状态">
                  {capabilityReport.map((entry) => {
                    const StatusIcon = {
                      verified: Check,
                      experimental: FlaskConical,
                      planned: Clock3,
                      unavailable: CircleOff,
                    } satisfies Record<FeatureStatus, typeof Check>
                    const Icon = StatusIcon[entry.status]
                    return (
                      <div
                        className={`core-capability-row ${entry.status}`}
                        role="listitem"
                        key={entry.capability}
                      >
                        <span className="core-capability-mark" aria-hidden="true">
                          <Icon size={14} />
                        </span>
                        <div>
                          <strong>{entry.label}</strong>
                          <span>{entry.reason}</span>
                        </div>
                        <em>{FEATURE_STATUS_LABELS[entry.status]}</em>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </section>
        )}
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR NEXT ADVENTURE AWAITS</div>
              <h1>
                {pages[page]}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {page === 'library'
                  ? '熟悉的像素，随时开启的新冒险。'
                  : page === 'recent'
                    ? '接着上次的冒险，继续向前。'
                    : page === 'favorites'
                      ? '把心头好，放在最顺手的地方。'
                      : page === 'states'
                        ? '每一段冒险，都值得好好保存。'
                        : '浏览分发目录，把想玩的游戏带回个人游戏库。'}
              </p>
            </div>
            {page !== 'online-library' && (
              <div className="import-actions">
                <button
                  className="button secondary import-top"
                  disabled={busy}
                  onClick={() => directoryInputRef.current?.click()}
                >
                  <FolderOpen size={18} />
                  导入文件夹
                </button>
                <button
                  className="button primary import-top"
                  disabled={busy}
                  aria-busy={Boolean(importLabel)}
                  onClick={() => inputRef.current?.click()}
                >
                  {importLabel ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
                  {importLabel || '导入游戏'}
                </button>
              </div>
            )}
          </div>

          <section
            ref={stageRef}
            className={`player-panel platform-${activePlatform.id} ${active ? 'visible' : ''} ${fullscreenActive ? 'fullscreen-active' : ''}`}
            aria-label={`${activePlatform.label} 游戏画面`}
          >
            <div className="player-heading">
              <div>
                <span className={`status-dot ${status === 'running' ? '' : 'paused'}`} />
                <strong>{active ? displayTitle(active) : activePlatform.label}</strong>
                <span className="pill">{activePlatform.name.toUpperCase()}</span>
              </div>
              <IconButton label="返回游戏库" onClick={() => void closeGame()} disabled={busy}>
                <X size={18} />
              </IconButton>
            </div>
            <div
              className={`canvas-wrap filter-${settings.filter}`}
              style={
                {
                  '--screen-aspect': `${activePlatform.nativeWidth} / ${activePlatform.nativeHeight}`,
                } as CSSProperties
              }
            >
              <canvas
                ref={canvasRef}
                width={activePlatform.nativeWidth}
                height={activePlatform.nativeHeight}
                tabIndex={0}
                aria-label={`${activePlatform.label} 模拟器画面`}
                aria-describedby="player-keyboard-help"
                onBlur={() => {
                  input.clear('keyboard')
                  engineRef.current?.setRewind(false)
                  engineRef.current?.setSpeed(settingsRef.current.speed)
                }}
              />
              {active && status === 'loading' && (
                <div className="player-overlay loading-overlay" role="status">
                  <LoaderCircle className="spin" size={28} />
                  <span>{progress}</span>
                </div>
              )}
              {active && status === 'paused' && !busy && (
                <button className="player-overlay pause-overlay" onClick={togglePause}>
                  <span className="pause-round">
                    <Play size={27} fill="currentColor" />
                  </span>
                  <strong>游戏已暂停</strong>
                  <span>点击继续，或按空格键</span>
                </button>
              )}
              {active && status === 'error' && (
                <div className="player-overlay" role="alert">
                  <CircleHelp size={28} />
                  <strong>游戏启动失败</strong>
                  <span>{launchError || '请检查游戏文件，或重新尝试'}</span>
                  <button className="button primary" onClick={() => void playGame(active)}>
                    重新启动
                  </button>
                </div>
              )}
            </div>
            <div className="player-toolbar">
              <div className="toolbar-group">
                <IconButton
                  label={status === 'running' ? '暂停 (Space)' : '继续 (Space)'}
                  disabled={!canControl}
                  onClick={togglePause}
                >
                  {status === 'running' ? <Pause size={19} /> : <Play size={19} />}
                </IconButton>
                <IconButton
                  label="重新开始游戏"
                  disabled={!canControl}
                  onClick={() =>
                    void run(async () => {
                      await engineRef.current?.reset()
                      notify('游戏已重新开始')
                    })
                  }
                >
                  <RotateCcw size={18} />
                </IconButton>
                <span className="toolbar-divider" />
                <IconButton
                  label="快速存档 (F5)"
                  disabled={!canControl}
                  onClick={() => void run(() => snapshot(1))}
                >
                  <Save size={18} />
                </IconButton>
                <IconButton
                  label="快速读档 (F8)"
                  disabled={!canControl || !states.some((s) => s.slot === 1)}
                  onClick={() => void loadSlot(1)}
                >
                  <FolderOpen size={18} />
                </IconButton>
                <IconButton
                  label="保存截图"
                  disabled={!canControl || !activePlatform.capabilities.screenshots}
                  onClick={() => void screenshot()}
                >
                  <ScanLine size={18} />
                </IconButton>
                <IconButton
                  label="管理金手指"
                  disabled={!canControl || !activePlatform.capabilities.cheats}
                  onClick={openCheats}
                >
                  <Braces size={18} />
                </IconButton>
              </div>
              <div className="toolbar-group">
                <button
                  className={`speed-button ${effectiveSpeed !== 1 ? 'accelerated' : ''}`}
                  disabled={!activePlatform.capabilities.speedControl}
                  onClick={() =>
                    setSetting('speed', settings.speed === 1 ? 2 : settings.speed === 2 ? 4 : 1)
                  }
                  title="切换运行速度"
                >
                  <FastForward size={16} />
                  {effectiveSpeed}×
                </button>
                <span className="fps">
                  <span className="status-dot" />
                  {status === 'running' ? fps : '—'} FPS
                </span>
                <IconButton
                  label={settings.volume ? '静音' : '取消静音'}
                  onClick={() => setSetting('volume', settings.volume ? 0 : 0.65)}
                >
                  {settings.volume ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </IconButton>
                <IconButton
                  label={`${fullscreenActive ? '退出全屏' : '进入全屏'} (F11)`}
                  disabled={!fullscreenAvailable}
                  onClick={() => void fullscreen()}
                >
                  {fullscreenActive ? <Minimize2 size={18} /> : <Expand size={18} />}
                </IconButton>
              </div>
            </div>
            <p id="player-keyboard-help" className="sr-only">
              聚焦画面后使用游戏按键；按 Escape 移至播放工具栏，或按 Shift+Tab 离开画面。
            </p>
            <TouchControls
              config={settings.touchConfig}
              buttons={activePlatform.buttons}
              visible={settings.touch}
              enabled={inputEnabled}
              onPress={(button) => input.press('touch', button)}
              onRelease={(button) => input.release('touch', button)}
            />
          </section>

          {!active && page === 'library' && (
            <>
              {recentGame && (
                <section className="continue-shelf" aria-label="继续上次游戏">
                  <div className="continue-identity">
                    <span className="continue-icon" aria-hidden="true">
                      <Play size={17} fill="currentColor" />
                    </span>
                    <div>
                      <small>继续上次游戏</small>
                      <strong title={displayTitle(recentGame)}>{displayTitle(recentGame)}</strong>
                    </div>
                  </div>
                  <dl className="continue-meta">
                    <div>
                      <dt>平台</dt>
                      <dd>{PLATFORM_REGISTRY[recentGame.platform].label}</dd>
                    </div>
                    <div>
                      <dt>上次游玩</dt>
                      <dd>{formatDate(recentGame.lastPlayed!)}</dd>
                    </div>
                    <div>
                      <dt>最新自动存档</dt>
                      <dd>{continueState ? formatDate(continueState.createdAt) : '正常启动'}</dd>
                    </div>
                    <div>
                      <dt>模拟核心</dt>
                      <dd>
                        {CORE_REGISTRY[PLATFORM_REGISTRY[recentGame.platform].core].name.replace(
                          ' WebAssembly',
                          '',
                        )}
                      </dd>
                    </div>
                  </dl>
                  <button
                    className="button primary continue-button"
                    disabled={busy}
                    onClick={() => void playGame(recentGame)}
                  >
                    <Play size={15} fill="currentColor" />
                    继续游戏
                  </button>
                </section>
              )}
              <section className="hero">
                <div className="hero-content">
                  <div className="hero-badge">
                    <span /> SMALL CONSOLE. BIG MEMORIES.
                  </div>
                  <h2>
                    经典像素，
                    <br />
                    <span>全新主场。</span>
                  </h2>
                  <p>
                    把口袋里的冒险，带回你的屏幕。
                    <br />
                    轻一点，回到热爱的那个世界。
                  </p>
                  <div className="hero-actions">
                    <button
                      className="button primary"
                      disabled={!demo || busy}
                      onClick={() => demo && void playGame(demo)}
                    >
                      <Play size={15} fill="currentColor" />
                      开始试玩
                      <ArrowRight size={16} />
                    </button>
                    <button className="button ghost" onClick={() => setModal('help')}>
                      了解更多
                      <ChevronRight size={15} />
                    </button>
                  </div>
                  <span className="hero-footnote">
                    <Sparkles size={12} />
                    内置原创游戏 · 无需下载 · 即点即玩
                  </span>
                </div>
                <HandheldArt />
              </section>
            </>
          )}

          {page === 'online-library' ? (
            <OnlineLibraryPage library={onlineLibrary} personalGames={games} />
          ) : page !== 'states' ? (
            <div className="content-grid">
              <section className="library-section">
                <div className="section-heading">
                  <div className="section-title">
                    <h2>{page === 'library' ? '我的游戏' : pages[page]}</h2>
                    <span className="count-badge">{visibleGames.length}</span>
                  </div>
                  <div className="section-actions">
                    {page === 'library' && (
                      <button
                        className={`button secondary batch-manage-button ${selectionMode ? 'active' : ''}`}
                        aria-pressed={selectionMode}
                        onClick={() => {
                          setSelectionMode((value) => !value)
                          setSelectedGameIds(new Set())
                          setGameMenu(null)
                        }}
                      >
                        <ListChecks size={15} />
                        {selectionMode ? '完成' : '批量管理'}
                      </button>
                    )}
                    <div className="view-toggle">
                      <IconButton
                        label="网格视图"
                        className={layout === 'grid' ? 'selected' : ''}
                        onClick={() => setLayout('grid')}
                      >
                        <LayoutGrid size={16} />
                      </IconButton>
                      <IconButton
                        label="列表视图"
                        className={layout === 'list' ? 'selected' : ''}
                        onClick={() => setLayout('list')}
                      >
                        <List size={17} />
                      </IconButton>
                    </div>
                  </div>
                </div>
                <div className="library-tools">
                  <div className="platform-filter" role="group" aria-label="按游戏平台筛选">
                    <button
                      className={platformFilter === 'all' ? 'active' : ''}
                      aria-pressed={platformFilter === 'all'}
                      onClick={() => setPlatformFilter('all')}
                    >
                      全部
                    </button>
                    {PLATFORM_LIST.map((platform) => (
                      <button
                        key={platform.id}
                        className={platformFilter === platform.id ? 'active' : ''}
                        data-platform={platform.id}
                        aria-pressed={platformFilter === platform.id}
                        onClick={() => setPlatformFilter(platform.id)}
                      >
                        {platform.label}
                        <span>
                          {pageGames.filter((game) => game.platform === platform.id).length}
                        </span>
                      </button>
                    ))}
                  </div>
                  <label className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="搜索游戏"
                      placeholder="搜索你的游戏…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    {search && (
                      <button aria-label="清空搜索" onClick={() => setSearch('')}>
                        <X size={14} />
                      </button>
                    )}
                  </label>
                  <div className="sort-select">
                    <select
                      aria-label="游戏排序"
                      value={sort}
                      onChange={(event) => setSort(event.target.value)}
                    >
                      <option value="recent">最近游玩</option>
                      <option value="added">最近添加</option>
                      <option value="name">名称排序</option>
                    </select>
                    <ChevronDown size={13} />
                  </div>
                </div>
                {selectionMode && page === 'library' && (
                  <div className="batch-toolbar" role="toolbar" aria-label="批量管理游戏">
                    <span className="batch-selection-count">
                      已选择 <strong>{selectedGameIds.size}</strong> 个游戏
                    </span>
                    <button
                      className="button secondary"
                      disabled={!selectableVisibleGames.length}
                      onClick={toggleVisibleSelection}
                    >
                      <Check size={15} />
                      {allVisibleSelected ? '取消选择当前结果' : '选择当前结果'}
                    </button>
                    <button
                      className="button ghost"
                      disabled={!selectedGameIds.size}
                      onClick={() => setSelectedGameIds(new Set())}
                    >
                      清除选择
                    </button>
                    <button
                      className="button danger"
                      disabled={!selectedGameIds.size || busy}
                      onClick={() =>
                        setBatchDeleteTargets(games.filter((game) => selectedGameIds.has(game.id)))
                      }
                    >
                      <Trash2 size={15} />
                      删除所选
                    </button>
                  </div>
                )}
                {!ready ? (
                  <div className="empty-state">
                    <LoaderCircle className="spin" />
                    <p>正在整理游戏库…</p>
                  </div>
                ) : (
                  <div className={`games-${layout}`}>
                    {visibleGames.map((game) => {
                      const selectable = !isDemo(game) && active?.id !== game.id
                      const selected = selectedGameIds.has(game.id)
                      return (
                        <article
                          key={game.id}
                          className={`game-card ${active?.id === game.id ? 'playing' : ''} ${selectionMode ? 'selection-mode' : ''} ${selected ? 'selected' : ''} ${selectionMode && !selectable ? 'selection-disabled' : ''}`}
                        >
                          <button
                            className="game-cover"
                            data-platform={game.platform}
                            aria-label={
                              selectionMode
                                ? selectable
                                  ? `${selected ? '取消选择' : '选择'} ${displayTitle(game)}`
                                  : `${displayTitle(game)} 无法选择`
                                : `开始 ${displayTitle(game)}`
                            }
                            aria-pressed={selectionMode && selectable ? selected : undefined}
                            onClick={() =>
                              selectionMode ? toggleGameSelection(game) : void playGame(game)
                            }
                            disabled={busy || (selectionMode && !selectable)}
                            style={{ '--cover-color': game.color || '#7286b0' } as CSSProperties}
                          >
                            {isDemo(game) ? (
                              <>
                                <SpaceArt id={`cover-${game.id.slice(0, 8)}`} />
                                <div className="cover-wordmark">
                                  <span>AN ORIGINAL ADVENTURE</span>
                                  <strong>
                                    STAR
                                    <br />
                                    ORBIT<span>✦</span>
                                  </strong>
                                </div>
                              </>
                            ) : (
                              <div className="generic-cover">
                                <div className="cartridge">
                                  <Gamepad2 size={34} />
                                  <span>{PLATFORM_REGISTRY[game.platform].name.toUpperCase()}</span>
                                </div>
                                <span className="generic-title">{game.title}</span>
                              </div>
                            )}
                            <span className="cover-platform" data-platform={game.platform}>
                              {PLATFORM_REGISTRY[game.platform].label}
                            </span>
                            {isDemo(game) && <span className="demo-badge">原创试玩</span>}
                            <span className="cover-play">
                              <Play size={22} fill="currentColor" />
                            </span>
                            {active?.id === game.id && (
                              <span className="now-playing">
                                <span />
                                正在游玩
                              </span>
                            )}
                            {selectionMode && (
                              <span
                                className={`selection-mark ${selected ? 'checked' : ''} ${!selectable ? 'disabled' : ''}`}
                                aria-hidden="true"
                              >
                                {selected && <Check size={15} strokeWidth={3} />}
                              </span>
                            )}
                          </button>
                          <div className="game-info">
                            <div className="game-name-row">
                              <button
                                className="game-title"
                                aria-pressed={selectionMode && selectable ? selected : undefined}
                                onClick={() =>
                                  selectionMode ? toggleGameSelection(game) : void playGame(game)
                                }
                                disabled={busy || (selectionMode && !selectable)}
                              >
                                {displayTitle(game)}
                              </button>
                              {!selectionMode && (
                                <div className="game-menu-wrap">
                                  <IconButton
                                    label={`${game.title} 的更多操作`}
                                    onClick={() =>
                                      setGameMenu(gameMenu === game.id ? null : game.id)
                                    }
                                  >
                                    <MoreHorizontal size={18} />
                                  </IconButton>
                                  {gameMenu === game.id && (
                                    <>
                                      <button
                                        className="menu-dismiss"
                                        aria-label="关闭游戏菜单"
                                        onClick={() => setGameMenu(null)}
                                      />
                                      <div className="game-menu">
                                        <button onClick={() => void favorite(game)}>
                                          <Heart size={14} />
                                          {game.favorite ? '取消收藏' : '添加到收藏'}
                                        </button>
                                        <button
                                          className="danger-text"
                                          disabled={active?.id === game.id || isDemo(game)}
                                          onClick={() => setDeleteTarget(game)}
                                        >
                                          <Trash2 size={14} />
                                          删除游戏及存档
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="game-meta">
                              <span>
                                {isDemo(game) ? '太空探索' : formatSize(game.size)}
                                <i />{' '}
                                {game.lastPlayed ? formatTime(game.playTime) : '等待你的首次冒险'}
                              </span>
                              {!selectionMode && (
                                <button
                                  className={`favorite-button ${game.favorite ? 'is-favorite' : ''}`}
                                  aria-label={
                                    game.favorite ? '取消收藏' : `收藏 ${displayTitle(game)}`
                                  }
                                  onClick={() => void favorite(game)}
                                >
                                  <Heart size={14} fill={game.favorite ? 'currentColor' : 'none'} />
                                </button>
                              )}
                            </div>
                          </div>
                        </article>
                      )
                    })}
                    {page === 'library' &&
                      !selectionMode &&
                      !search &&
                      platformFilter === 'all' && (
                        <button
                          className="import-card"
                          disabled={busy}
                          onClick={() => inputRef.current?.click()}
                        >
                          <span className="import-circle">
                            <Plus size={25} strokeWidth={1.5} />
                          </span>
                          <strong>下一场冒险，由你选择</strong>
                          <p>使用上方按钮导入文件或文件夹，也可拖放到这里</p>
                          <span className="file-tag">
                            {romFormatLabel} / ZIP<span>自动解压</span>
                          </span>
                        </button>
                      )}
                    {visibleGames.length === 0 &&
                      (page !== 'library' || search || platformFilter !== 'all') && (
                        <div className="empty-state">
                          {search ? (
                            <Search size={30} />
                          ) : page === 'favorites' ? (
                            <Heart size={30} />
                          ) : (
                            <Clock3 size={30} />
                          )}
                          <h3>{emptyStateCopy.title}</h3>
                          <p>{emptyStateCopy.description}</p>
                          <button
                            className="button secondary"
                            onClick={() => {
                              setPage('library')
                              setSearch('')
                            }}
                          >
                            返回游戏库
                            <ArrowRight size={15} />
                          </button>
                        </div>
                      )}
                  </div>
                )}
                <div className="library-note">
                  <HardDrive size={14} />
                  <span>
                    {games.length} 个游戏 ·{' '}
                    {formatSize(games.reduce((total, game) => total + game.size, 0))} 本地空间
                  </span>
                  <span>好游戏，值得慢慢玩。</span>
                </div>
                <div className="tip-banner">
                  <div className="tip-icon">
                    <Keyboard size={21} />
                  </div>
                  <div>
                    <strong>熟悉的手感，不止一种方式</strong>
                    <p>键盘、手柄或触屏，用你喜欢的方式玩。</p>
                  </div>
                  <button onClick={() => setModal('controls')}>
                    设置按键
                    <ArrowRight size={15} />
                  </button>
                </div>
              </section>
              <aside className="quick-panel">
                <div className="section-heading">
                  <div className="section-title">
                    <SlidersHorizontal size={17} />
                    <h2>控制中心</h2>
                  </div>
                  <IconButton label="全部模拟器设置" onClick={() => setModal('settings')}>
                    <Settings2 size={16} />
                  </IconButton>
                </div>
                <div className="quick-settings">
                  <div className="setting-caption">
                    <span>
                      <Volume2 size={15} />
                      游戏音量
                    </span>
                    <strong>
                      {Math.round(settings.volume * 100)}
                      <small>%</small>
                    </strong>
                  </div>
                  <input
                    className="volume-slider"
                    aria-label="游戏音量"
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(settings.volume * 100)}
                    style={{ '--range-value': `${settings.volume * 100}%` } as CSSProperties}
                    onChange={(event) => setSetting('volume', Number(event.target.value) / 100)}
                  />
                  <div className="setting-caption speed-caption">
                    <span>
                      <FastForward size={15} />
                      运行速度
                    </span>
                  </div>
                  <div className="segmented">
                    {([1, 2, 4] as const).map((speed) => (
                      <button
                        key={speed}
                        className={effectiveSpeed === speed ? 'active' : ''}
                        disabled={!activePlatform.capabilities.speedControl}
                        onClick={() => setSetting('speed', speed)}
                      >
                        {speed}×{speed === 1 && <span>正常</span>}
                      </button>
                    ))}
                  </div>
                  <div className="quick-divider" />
                  <div className="setting-caption">
                    <span>
                      <ScanLine size={15} />
                      画面滤镜
                    </span>
                    <select
                      aria-label="画面滤镜"
                      value={settings.filter}
                      onChange={(event) =>
                        setSetting('filter', event.target.value as Settings['filter'])
                      }
                    >
                      <option value="pixel">原生像素</option>
                      <option value="smooth">柔和平滑</option>
                      <option value="crt">复古 CRT</option>
                    </select>
                  </div>
                  <div className="setting-caption autosave-row">
                    <span>
                      <Save size={15} />
                      自动存档
                    </span>
                    <Toggle
                      checked={settings.autoSave}
                      onChange={(value) => setSetting('autoSave', value)}
                      label="自动存档"
                    />
                  </div>
                  <div className="segmented autosave-interval" aria-label="自动存档间隔">
                    {([1, 5, 10] as const).map((minutes) => (
                      <button
                        key={minutes}
                        className={settings.autoSaveInterval === minutes ? 'active' : ''}
                        disabled={!settings.autoSave}
                        onClick={() => setSetting('autoSaveInterval', minutes)}
                      >
                        {minutes} 分钟
                      </button>
                    ))}
                  </div>
                  <div className="setting-caption autosave-count-caption">
                    <span>保留份数</span>
                  </div>
                  <div className="segmented autosave-interval" aria-label="自动存档保留份数">
                    {([1, 2, 3] as const).map((count) => (
                      <button
                        key={count}
                        className={settings.autoSaveSlotCount === count ? 'active' : ''}
                        disabled={!settings.autoSave}
                        onClick={() => setSetting('autoSaveSlotCount', count)}
                      >
                        {count} 份
                      </button>
                    ))}
                  </div>
                  <p className="setting-help">按所选间隔轮换覆盖，最多保留 3 份自动存档。</p>
                </div>
                <div className="quick-save">
                  <div>
                    <span className="save-icon">
                      <Save size={19} />
                    </span>
                    <div>
                      <strong>把进度，留在此刻</strong>
                      <p>{active ? '随时保存，随时继续' : '启动游戏后即可管理存档'}</p>
                    </div>
                  </div>
                  <button
                    className="button secondary"
                    disabled={!canControl}
                    onClick={() => setModal('states')}
                  >
                    管理即时存档
                    <ChevronRight size={15} />
                  </button>
                </div>
                <div className="core-status">
                  <span className="status-dot" />
                  <span>{engineRef.current?.version ?? '多核心引擎'}</span>
                  <span>WASM</span>
                </div>
              </aside>
            </div>
          ) : (
            <section className="saved-games">
              <div className="info-banner">
                <ShieldCheck size={19} />
                <span>即时存档保存在此浏览器。导出重要存档，可在清理浏览器数据后恢复进度。</span>
              </div>
              {allStates.length === 0 ? (
                <div className="empty-state">
                  <Save size={36} />
                  <h3>为冒险留一个书签</h3>
                  <p>启动游戏后按 F5 快速存档，或开启自动存档。</p>
                  <button className="button primary" onClick={() => navigate('library')}>
                    去游戏库
                    <ArrowRight size={15} />
                  </button>
                </div>
              ) : (
                <div className="state-grid">
                  {allStates
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((state) => {
                      const game = games.find((g) => g.id === state.gameId)
                      return (
                        game && (
                          <article
                            key={state.id}
                            className="state-card"
                            data-platform={game.platform}
                            style={
                              {
                                '--screen-aspect': `${PLATFORM_REGISTRY[game.platform].nativeWidth} / ${PLATFORM_REGISTRY[game.platform].nativeHeight}`,
                              } as CSSProperties
                            }
                          >
                            {state.screenshot ? (
                              <img src={state.screenshot} alt={`${displayTitle(game)} 存档画面`} />
                            ) : (
                              <div className="state-placeholder">
                                <Save />
                              </div>
                            )}
                            <div>
                              <span className="slot-label">{automaticSlotLabel(state.slot)}</span>
                              <span className="state-platform" data-platform={game.platform}>
                                {PLATFORM_REGISTRY[game.platform].label}
                              </span>
                              <h3>{displayTitle(game)}</h3>
                              <p>{formatDate(state.createdAt)}</p>
                              <div className="state-actions">
                                <button
                                  className="button primary"
                                  disabled={busy}
                                  onClick={() => void playGame(game, state)}
                                >
                                  <Play size={14} />
                                  继续游戏
                                </button>
                                <IconButton
                                  label="导出即时存档"
                                  onClick={() =>
                                    download(state.data, `${game.title}-${state.slot}.state`)
                                  }
                                >
                                  <Download size={16} />
                                </IconButton>
                                <IconButton
                                  label="删除即时存档"
                                  onClick={() =>
                                    void run(async () => {
                                      await db.deleteState(game.id, state.slot)
                                      setAllStates((previous) =>
                                        previous.filter((s) => s.id !== state.id),
                                      )
                                      if (active?.id === game.id)
                                        setStates(await db.getStates(game.id))
                                      notify('即时存档已删除')
                                    })
                                  }
                                >
                                  <Trash2 size={16} />
                                </IconButton>
                              </div>
                            </div>
                          </article>
                        )
                      )
                    })}
                </div>
              )}
            </section>
          )}
          <footer className="page-footer">
            <span>
              MADE FOR THE LOVE OF PLAY<span className="footer-star">✳</span>
            </span>
            <span>
              <CloudOff size={13} />
              {account.user ? '本地运行，账号同步已开启' : '本地游戏，本地存档，可选账号同步'}
            </span>
          </footer>
        </main>
      </div>

      {(modal || deleteTarget || batchDeleteTargets) && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !operationRef.current) {
              if (modal === 'recovery') ignoreRecovery()
              else setModal(null)
              setMapping(null)
              setDeleteTarget(null)
              setBatchDeleteTargets(null)
            }
          }}
        >
          <div
            className={`modal ${modal === 'states' || modal === 'cheats' || modal === 'backup' ? 'wide-modal' : ''}`}
            ref={modalRef}
            tabIndex={-1}
            role={deleteTarget || batchDeleteTargets ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">MAKE IT YOURS</span>
                <h2 id="modal-title">
                  {batchDeleteTargets
                    ? `删除选中的 ${batchDeleteTargets.length} 个游戏？`
                    : deleteTarget
                      ? '删除这个游戏？'
                      : modal === 'recovery'
                        ? '恢复未结束的游戏'
                        : modal === 'launch'
                          ? '选择这次的起点'
                          : modal === 'controls'
                            ? '找到你的顺手操作'
                            : modal === 'settings'
                              ? '你的模拟器，你来定义'
                              : modal === 'backup'
                                ? '备份与恢复'
                                : modal === 'account'
                                  ? '账号与游戏同步'
                                  : modal === 'states'
                                    ? '给冒险留个书签'
                                    : modal === 'cheats'
                                      ? '管理金手指'
                                      : '准备好，开始冒险'}
                </h2>
              </div>
              <IconButton
                label="关闭对话框"
                disabled={busy}
                onClick={() => {
                  if (modal === 'recovery') ignoreRecovery()
                  else setModal(null)
                  setMapping(null)
                  setDeleteTarget(null)
                  setBatchDeleteTargets(null)
                }}
              >
                <X size={20} />
              </IconButton>
            </div>
            {batchDeleteTargets ? (
              <>
                <p className="modal-description">
                  将永久删除选中的 {batchDeleteTargets.length} 个游戏、ROM
                  及其所有存档，并把删除结果同步到当前账号的其他浏览器。此操作无法撤销。
                </p>
                <div className="modal-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setBatchDeleteTargets(null)}
                  >
                    取消
                  </button>
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => void deleteSelectedGames()}
                  >
                    <Trash2 size={16} />
                    删除 {batchDeleteTargets.length} 个游戏
                  </button>
                </div>
              </>
            ) : deleteTarget ? (
              <>
                <p className="modal-description">
                  将删除「{displayTitle(deleteTarget)}
                  」及其所有本地存档。此操作无法撤销，请先导出需要保留的存档。
                </p>
                <div className="modal-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setDeleteTarget(null)}
                  >
                    取消
                  </button>
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => void deleteGame()}
                  >
                    <Trash2 size={16} />
                    确认删除
                  </button>
                </div>
              </>
            ) : modal === 'recovery' && recoveryRecord ? (
              <>
                <p className="modal-description">
                  上次游戏没有正常返回游戏库。你可以恢复当时引用的存档，或从 ROM 正常启动。
                </p>
                <div className="recovery-summary">
                  <div>
                    <Gamepad2 size={17} />
                    <span>
                      <small>游戏</small>
                      <strong>
                        {recoveryGame ? displayTitle(recoveryGame) : '游戏已从库中移除'}
                      </strong>
                    </span>
                  </div>
                  <div>
                    <Clock3 size={17} />
                    <span>
                      <small>最后活动</small>
                      <strong>{formatDate(recoveryRecord.updatedAt)}</strong>
                    </span>
                  </div>
                  <div>
                    <Save size={17} />
                    <span>
                      <small>恢复点</small>
                      <strong>
                        {recoveryStateMatches && recoveryState
                          ? `${automaticSlotLabel(recoveryState.slot)} · ${formatDate(recoveryState.createdAt)}`
                          : '没有可用恢复点'}
                      </strong>
                    </span>
                  </div>
                  <div>
                    <Braces size={17} />
                    <span>
                      <small>模拟核心</small>
                      <strong>
                        {recoveryGame
                          ? CORE_REGISTRY[
                              PLATFORM_REGISTRY[recoveryGame.platform].core
                            ].name.replace(' WebAssembly', '')
                          : '无法确认'}
                      </strong>
                    </span>
                  </div>
                </div>
                {recoveryProblem && (
                  <div className="recovery-warning" role="status">
                    <ShieldAlert size={17} />
                    <span>{recoveryProblem}</span>
                  </div>
                )}
                <p className="recovery-note">
                  恢复操作只读取原存档；失败时会保留它并正常启动游戏。
                </p>
                <div className="modal-actions recovery-actions">
                  <button className="text-button" disabled={busy} onClick={ignoreRecovery}>
                    忽略
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy || !recoveryGame}
                    onClick={() => void startRecoveryFresh()}
                  >
                    正常启动
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || Boolean(recoveryProblem)}
                    onClick={() => void recoverUnfinishedSession()}
                  >
                    <RotateCcw size={16} />
                    恢复进度
                  </button>
                </div>
              </>
            ) : modal === 'launch' && launchTarget ? (
              <>
                <p className="modal-description">
                  {displayTitle(launchTarget)}
                  <span> · 记住的选择会用于下次启动前的默认项</span>
                </p>
                <div className="launch-options" role="radiogroup" aria-label="启动方式">
                  <label
                    className={`launch-option ${launchMode === 'auto' ? 'selected' : ''} ${launchAutomaticState ? '' : 'disabled'}`}
                  >
                    <input
                      type="radio"
                      name="launch-mode"
                      value="auto"
                      checked={launchMode === 'auto'}
                      disabled={!launchAutomaticState}
                      onChange={() => setLaunchMode('auto')}
                    />
                    <span>
                      <strong>继续自动存档</strong>
                      <small>
                        {launchAutomaticState
                          ? `${automaticSlotLabel(launchAutomaticState.slot)} · ${formatDate(launchAutomaticState.createdAt)}`
                          : '还没有可用的自动存档'}
                      </small>
                    </span>
                  </label>
                  <label className={`launch-option ${launchMode === 'fresh' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="launch-mode"
                      value="fresh"
                      checked={launchMode === 'fresh'}
                      onChange={() => setLaunchMode('fresh')}
                    />
                    <span>
                      <strong>正常启动</strong>
                      <small>不读取即时存档，电池存档仍会正常载入</small>
                    </span>
                  </label>
                  <div
                    className={`launch-option launch-state-option ${launchMode === 'state' ? 'selected' : ''} ${launchStates.length ? '' : 'disabled'}`}
                  >
                    <label>
                      <input
                        type="radio"
                        name="launch-mode"
                        value="state"
                        checked={launchMode === 'state'}
                        disabled={!launchStates.length}
                        onChange={() => setLaunchMode('state')}
                      />
                      <span>
                        <strong>选择即时存档</strong>
                        <small>从指定的自动或手动存档继续</small>
                      </span>
                    </label>
                    <select
                      aria-label="选择即时存档"
                      value={launchStateSlot ?? ''}
                      disabled={!launchStates.length}
                      onChange={(event) => {
                        setLaunchStateSlot(Number(event.target.value))
                        setLaunchMode('state')
                      }}
                    >
                      {!launchStates.length && <option value="">没有可用存档</option>}
                      {launchStates.map((state) => (
                        <option value={state.slot} key={state.slot}>
                          {automaticSlotLabel(state.slot)} · {formatDate(state.createdAt)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="modal-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setModal(null)}
                  >
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || (launchMode === 'state' && launchStateSlot === null)}
                    onClick={() => void confirmLaunch()}
                  >
                    <Play size={16} />
                    开始游戏
                  </button>
                </div>
              </>
            ) : modal === 'backup' ? (
              <BackupManager
                games={games}
                onExport={exportLibrary}
                onRestore={restoreLibrary}
                onDelete={setDeleteTarget}
                onBusyChange={(value) => {
                  operationRef.current = value
                  setBusy(value)
                }}
              />
            ) : modal === 'account' ? (
              <AccountPanel account={account} />
            ) : modal === 'controls' ? (
              <>
                <p className="modal-description">
                  点击按键可重新映射。点击游戏画面后使用键盘，按 Esc
                  离开画面焦点。连接手柄后按任意按钮，可设置按钮或摇杆映射。
                </p>
                <div className={`controller-status ${gamepad ? 'connected' : ''}`}>
                  <Gamepad2 size={21} />
                  <div>
                    <strong>{gamepad ? '手柄已连接' : '键盘已就绪'}</strong>
                    <p>
                      {gamepad
                        ? '在下方确认或设置当前设备的按键与摇杆映射'
                        : '支持标准手柄，也可为非标准设备设置映射'}
                    </p>
                    <span className="status-dot" />
                  </div>
                </div>
                <div className="key-bindings">
                  {(Object.keys(defaultBindings) as EmulatorButton[])
                    .filter((key) => platformSupportsButton(activePlatform.id, key))
                    .map((key) => (
                      <div className="key-binding" key={key}>
                        <span>{buttonNames[key]}</span>
                        <button
                          className={mapping === key ? 'listening' : ''}
                          aria-label={`${buttonNames[key]}键盘映射：${mapping === key ? '按下新按键' : keyLabel(settings.bindings[key])}`}
                          onClick={() => setMapping(key)}
                        >
                          {mapping === key ? '按下新按键…' : keyLabel(settings.bindings[key])}
                        </button>
                      </div>
                    ))}
                </div>
                <p className="sr-only" role="status">
                  {mapping ? `正在设置${buttonNames[mapping]}，按 Escape 取消` : ''}
                </p>
                <GamepadSettings controller={gamepads} buttons={activePlatform.buttons} />
                <TouchSettings
                  config={settings.touchConfig}
                  onChange={(value) => setSetting('touchConfig', value)}
                />
                <div className="modal-setting">
                  <div>
                    <strong>显示触屏按键</strong>
                    <p>手机与平板默认显示虚拟手柄</p>
                  </div>
                  <Toggle
                    label="显示触屏按键"
                    checked={settings.touch}
                    onChange={(value) => setSetting('touch', value)}
                  />
                </div>
                <div className="modal-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      setSetting('bindings', defaultBindings)
                      setMapping(null)
                      notify('已恢复默认按键')
                    }}
                  >
                    <RotateCcw size={14} />
                    恢复默认
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      setModal(null)
                      setMapping(null)
                    }}
                  >
                    <Check size={16} />
                    完成设置
                  </button>
                </div>
              </>
            ) : modal === 'settings' ? (
              <>
                <p className="modal-description">设置会自动保存，并应用到接下来每一次游戏。</p>
                <div className="modal-setting">
                  <div>
                    <strong>画面显示</strong>
                    <p>原生像素会保留当前平台的画面比例</p>
                  </div>
                  <select
                    value={settings.filter}
                    aria-label="设置画面显示"
                    onChange={(event) =>
                      setSetting('filter', event.target.value as Settings['filter'])
                    }
                  >
                    <option value="pixel">原生像素</option>
                    <option value="smooth">柔和平滑</option>
                    <option value="crt">复古 CRT</option>
                  </select>
                </div>
                <div className="modal-setting">
                  <div>
                    <strong>运行速度</strong>
                    <p>加速对话或练级，也可按住 Tab 临时快进</p>
                  </div>
                  <select
                    aria-label="设置运行速度"
                    value={effectiveSpeed}
                    disabled={!activePlatform.capabilities.speedControl}
                    onChange={(event) =>
                      setSetting('speed', Number(event.target.value) as Settings['speed'])
                    }
                  >
                    <option value="1">1× 正常</option>
                    <option value="2">2× 快进</option>
                    <option value="4">4× 快进</option>
                  </select>
                </div>
                <div className="modal-setting">
                  <div>
                    <strong>游戏音量</strong>
                    <p>{Math.round(settings.volume * 100)}%</p>
                  </div>
                  <input
                    aria-label="设置游戏音量"
                    type="range"
                    min="0"
                    max="100"
                    value={settings.volume * 100}
                    onChange={(event) => setSetting('volume', Number(event.target.value) / 100)}
                  />
                </div>
                <div className="modal-setting">
                  <div>
                    <strong>自动存档与恢复</strong>
                    <p>定时轮换自动槽，返回游戏库和切到后台时也会保存</p>
                  </div>
                  <Toggle
                    label="自动存档与恢复"
                    checked={settings.autoSave}
                    onChange={(value) => setSetting('autoSave', value)}
                  />
                </div>
                <div className="modal-setting">
                  <div>
                    <strong>自动存档间隔</strong>
                    <p>可选 1、5 或 10 分钟</p>
                  </div>
                  <select
                    aria-label="自动存档间隔"
                    value={settings.autoSaveInterval}
                    disabled={!settings.autoSave}
                    onChange={(event) =>
                      setSetting('autoSaveInterval', Number(event.target.value) as 1 | 5 | 10)
                    }
                  >
                    <option value="1">每 1 分钟</option>
                    <option value="5">每 5 分钟</option>
                    <option value="10">每 10 分钟</option>
                  </select>
                </div>
                <div className="modal-setting">
                  <div>
                    <strong>自动存档保留份数</strong>
                    <p>轮换覆盖固定槽位，最多 3 份</p>
                  </div>
                  <select
                    aria-label="自动存档保留份数"
                    value={settings.autoSaveSlotCount}
                    disabled={!settings.autoSave}
                    onChange={(event) =>
                      setSetting('autoSaveSlotCount', Number(event.target.value) as 1 | 2 | 3)
                    }
                  >
                    <option value="1">保留 1 份</option>
                    <option value="2">保留 2 份</option>
                    <option value="3">保留 3 份</option>
                  </select>
                </div>
                <div className="modal-setting">
                  <div>
                    <strong>触屏手柄</strong>
                    <p>在桌面上也显示触屏按键</p>
                  </div>
                  <Toggle
                    label="触屏手柄"
                    checked={settings.touch}
                    onChange={(value) => setSetting('touch', value)}
                  />
                </div>
                <div className="info-banner">
                  <HardDrive size={19} />
                  <span>
                    已使用 {formatSize(games.reduce((size, g) => size + g.size, 0))}{' '}
                    游戏存储。清理浏览器数据会移除游戏和存档，建议定期导出备份。
                  </span>
                </div>
              </>
            ) : modal === 'cheats' ? (
              <>
                <p className="modal-description">
                  {activePlatform.label}{' '}
                  金手指由模拟核心执行。每行输入一段代码；保存后会在当前进度重新载入游戏。
                </p>
                <div className="cheat-list">
                  {cheatDrafts.length ? (
                    cheatDrafts.map((cheat, index) => (
                      <div className="cheat-row" key={cheat.id}>
                        <Toggle
                          checked={cheat.enabled}
                          label={`${cheat.name || `金手指 ${index + 1}`}启用状态`}
                          onChange={(enabled) =>
                            setCheatDrafts((current) =>
                              current.map((item) =>
                                item.id === cheat.id ? { ...item, enabled } : item,
                              ),
                            )
                          }
                        />
                        <label>
                          <span>名称</span>
                          <input
                            value={cheat.name}
                            maxLength={80}
                            placeholder={`金手指 ${index + 1}`}
                            onChange={(event) =>
                              setCheatDrafts((current) =>
                                current.map((item) =>
                                  item.id === cheat.id
                                    ? { ...item, name: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </label>
                        <label className="cheat-code-field">
                          <span>代码</span>
                          <textarea
                            value={cheat.code}
                            maxLength={4096}
                            rows={2}
                            spellCheck={false}
                            placeholder={
                              activePlatform.id === 'gba' ||
                              activePlatform.id === 'gb' ||
                              activePlatform.id === 'gbc'
                                ? 'XXXXXXXX YYYYYYYY'
                                : '输入当前核心支持的代码'
                            }
                            onChange={(event) =>
                              setCheatDrafts((current) =>
                                current.map((item) =>
                                  item.id === cheat.id
                                    ? { ...item, code: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </label>
                        <IconButton
                          label={`删除${cheat.name || `金手指 ${index + 1}`}`}
                          onClick={() =>
                            setCheatDrafts((current) =>
                              current.filter((item) => item.id !== cheat.id),
                            )
                          }
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </div>
                    ))
                  ) : (
                    <div className="cheat-empty">
                      <Braces size={24} />
                      <span>还没有金手指代码</span>
                    </div>
                  )}
                </div>
                <div className="modal-actions cheat-actions">
                  <button
                    className="button secondary"
                    disabled={cheatDrafts.length >= 50}
                    onClick={() =>
                      setCheatDrafts((current) => [
                        ...current,
                        {
                          id: createCheatId(),
                          name: `金手指 ${current.length + 1}`,
                          code: '',
                          enabled: true,
                        },
                      ])
                    }
                  >
                    <Plus size={16} />
                    添加金手指
                  </button>
                  <button className="button secondary" onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void applyCheats()}
                  >
                    <Check size={16} />
                    保存并重新载入
                  </button>
                </div>
              </>
            ) : modal === 'states' ? (
              <>
                <p className="modal-description">
                  {active && displayTitle(active)}
                  <span> · 即时存档记录游戏此刻的完整状态</span>
                </p>
                <div className="slot-grid">
                  {[...AUTO_SAVE_SLOTS, ...MANUAL_SAVE_SLOTS].map((slot) => {
                    const state = states.find((s) => s.slot === slot)
                    return (
                      <div className={`save-slot ${state ? 'filled' : ''}`} key={slot}>
                        <div className="slot-preview">
                          {state?.screenshot ? (
                            <img src={state.screenshot} alt={`存档位 ${slot} 画面`} />
                          ) : (
                            <Save size={28} />
                          )}
                          <span>{automaticSlotLabel(slot)}</span>
                        </div>
                        <p>{state ? formatDate(state.createdAt) : '等待一段冒险'}</p>
                        <div>
                          <button
                            disabled={!canControl}
                            onClick={() => void run(() => snapshot(slot))}
                          >
                            <Save size={14} />
                            {state ? '覆盖' : '保存'}
                          </button>
                          <button
                            disabled={!state || !canControl}
                            onClick={() => void loadSlot(slot)}
                          >
                            <Play size={14} />
                            读取
                          </button>
                          {state && (
                            <IconButton
                              label={`导出存档位 ${slot}`}
                              onClick={() => download(state.data, `${active?.title}-${slot}.state`)}
                            >
                              <Download size={14} />
                            </IconButton>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="save-transfers">
                  <button
                    className="button secondary"
                    disabled={!canControl}
                    onClick={() => stateInputRef.current?.click()}
                  >
                    <Upload size={15} />
                    导入即时存档
                  </button>
                  <button
                    className="button secondary"
                    disabled={!canControl || !activePlatform.capabilities.batterySaves}
                    onClick={() => void exportBattery()}
                  >
                    <ArrowDownToLine size={15} />
                    导出 .sav
                  </button>
                  <button
                    className="button secondary"
                    disabled={!canControl || !activePlatform.capabilities.batterySaves}
                    onClick={() => saveInputRef.current?.click()}
                  >
                    <ArrowUpFromLine size={15} />
                    导入 .sav
                  </button>
                </div>
                <p className="small-note">
                  {activePlatform.capabilities.batterySaves
                    ? '.sav 是游戏内存档；导入后会重启游戏。即时存档须由当前游戏和同一模拟核心生成。'
                    : 'GameCube 目前使用本地即时存档；暂不支持独立记忆卡导入导出。'}
                </p>
              </>
            ) : (
              <>
                <p className="modal-description">
                  Orbitra 是一个在浏览器中运行的经典游戏空间。导入 {romFormatLabel} 或 .ZIP
                  游戏，或先体验内置的原创游戏 Star Orbit。
                </p>
                <div className="help-steps">
                  <div>
                    <span>01</span>
                    <strong>带上你的游戏</strong>
                    <p>
                      点击「导入游戏」选择文件，或点击「导入文件夹」递归扫描目录。也可拖入
                      {romFormatLabel} / .ZIP 文件。ZIP 中的游戏会自动识别平台并解压，包括子文件夹。
                      各平台按独立大小限制校验；ZIP 最大 64 MiB，每包最多 32 个游戏、解压合计 128
                      MiB。
                    </p>
                  </div>
                  <div>
                    <span>02</span>
                    <strong>用熟悉的方式玩</strong>
                    <p>
                      点击游戏画面后，方向键移动，X / Z 对应 A / B，C / V 对应 X / Y，A / S
                      对应肩键，Enter 开始，右 Shift 选择。按 Esc 离开游戏焦点。
                    </p>
                  </div>
                  <div>
                    <span>03</span>
                    <strong>每次回来，接着冒险</strong>
                    <p>
                      自动存档可选 1、5 或 10 分钟，可配置轮换保留 1 至 3 份；另有 5 个手动存档位。
                    </p>
                  </div>
                </div>
                <div className="shortcut-grid">
                  {[
                    ['按住倒带', 'Backspace'],
                    ['暂停 / 继续', 'Space'],
                    ['快速存档（位 1）', 'F5'],
                    ['快速读档（位 1）', 'F8'],
                    ['按住快进', 'Tab'],
                    ['进入 / 退出全屏', 'F11'],
                  ].map(([name, key]) => (
                    <div key={key}>
                      <span>{name}</span>
                      <kbd>{key}</kbd>
                    </div>
                  ))}
                </div>
                <div className="demo-help">
                  <Sparkles size={18} />
                  <div>
                    <strong>Star Orbit · 原创试玩</strong>
                    <p>
                      方向键驾驶飞船，X 加速，Z 发出脉冲，Enter 重新开始。试着探索这片小小宇宙。
                    </p>
                  </div>
                </div>
                <p className="small-note">
                  基于 mGBA、FCEUmm 与 Snes9x WebAssembly 内核 · 商业游戏需自行提供合法获得的
                  ROM。暂不支持联机与密码压缩包。
                </p>
              </>
            )}
          </div>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Upload size={40} />
            <h2>放下游戏，开启冒险。</h2>
            <p>支持 {romFormatLabel} / .ZIP · 自动识别平台并解压游戏</p>
          </div>
        </div>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <CircleHelp size={18} /> : <Check size={18} />}
          <span>{toast.text}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
