import { useCallback, useEffect, useRef, useState } from 'react'
import {
  downloadCloudSnapshot,
  getAccountSession,
  loginAccount,
  logoutAccount,
  registerAccount,
  uploadCloudSnapshot,
} from '../lib/account-api.ts'
import type { AccountUser } from '../lib/account-api.ts'
import { createBackup, parseBackup } from '../lib/backup-format.ts'
import type { BackupData, BackupGame } from '../lib/backup-format.ts'
import * as db from '../lib/storage.ts'
import type { RestoreChoices, RestorePreview } from '../lib/storage.ts'

export type AccountPhase = 'checking' | 'signed-out' | 'idle' | 'syncing' | 'error'

export interface AccountSyncController {
  user: AccountUser | null
  phase: AccountPhase
  message: string
  lastSyncedAt: number | null
  revision: number
  signIn(username: string, password: string): Promise<void>
  signUp(username: string, password: string): Promise<void>
  signOut(): Promise<void>
  syncNow(): Promise<void>
}

interface AccountSyncOptions {
  onLibraryChanged(): Promise<void>
}

function defaultRestoreChoices(preview: RestorePreview): RestoreChoices {
  return {
    fingerprint: preview.fingerprint,
    games: Object.fromEntries(
      preview.games.map((entry) => [
        entry.game.id,
        entry.missingRom
          ? { metadata: false, battery: false, slots: [] }
          : { ...entry.defaults, slots: [...entry.defaults.slots] },
      ]),
    ),
  }
}

function selectedCount(choices: RestoreChoices): number {
  return Object.values(choices.games).reduce(
    (total, choice) =>
      total + Number(choice.metadata) + Number(choice.battery) + choice.slots.length,
    0,
  )
}

function equalBytes(left?: Uint8Array, right?: Uint8Array): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.byteLength === right.byteLength &&
        left.every((byte, index) => byte === right[index])
}

function sameGame(left: BackupGame, right: BackupGame): boolean {
  if (
    JSON.stringify(left.game) !== JSON.stringify(right.game) ||
    !equalBytes(left.rom, right.rom) ||
    !equalBytes(left.battery, right.battery) ||
    left.states.length !== right.states.length
  )
    return false
  const rightStates = new Map(right.states.map((state) => [state.slot, state]))
  return left.states.every((state) => {
    const other = rightStates.get(state.slot)
    if (!other || !equalBytes(state.data, other.data)) return false
    const { data: _leftData, ...leftMetadata } = state
    const { data: _rightData, ...rightMetadata } = other
    return JSON.stringify(leftMetadata) === JSON.stringify(rightMetadata)
  })
}

function sameBackupContent(left: BackupData, right: BackupData): boolean {
  if (left.games.length !== right.games.length) return false
  const rightGames = new Map(right.games.map((game) => [game.game.id, game]))
  return left.games.every((game) => {
    const other = rightGames.get(game.game.id)
    return other !== undefined && sameGame(game, other)
  })
}

export function useAccountSync({ onLibraryChanged }: AccountSyncOptions): AccountSyncController {
  const [user, setUser] = useState<AccountUser | null>(null)
  const [phase, setPhase] = useState<AccountPhase>('checking')
  const [message, setMessage] = useState('正在检查登录状态…')
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [revision, setRevision] = useState(0)
  const userRef = useRef<AccountUser | null>(null)
  const revisionRef = useRef(0)
  const syncing = useRef(false)
  const pending = useRef(false)
  const restoring = useRef(false)
  const runSyncRef = useRef<(pullRemote: boolean, alwaysUpload?: boolean) => Promise<void>>(
    async () => {},
  )
  const contentTimer = useRef<number | undefined>(undefined)
  const metadataTimer = useRef<number | undefined>(undefined)

  const runSync = useCallback(
    async (pullRemote: boolean, alwaysUpload = true) => {
      if (!userRef.current) return
      if (syncing.current) {
        pending.current = true
        return
      }
      syncing.current = true
      setPhase('syncing')
      setMessage(pullRemote ? '正在合并账号中的游戏与存档…' : '正在保存游戏与存档到账号…')
      try {
        let remoteData: BackupData | undefined
        if (pullRemote) {
          const remote = await downloadCloudSnapshot(alwaysUpload ? undefined : revisionRef.current)
          if (remote === undefined) {
            setPhase('idle')
            return
          }
          if (remote) {
            remoteData = await parseBackup(
              new Blob([new Uint8Array(remote.bytes)], { type: 'application/zip' }),
            )
            const preview = await db.previewRestore(remoteData)
            const choices = defaultRestoreChoices(preview)
            if (selectedCount(choices)) {
              restoring.current = true
              try {
                await db.restoreLibrary(remoteData, choices)
                await db.repairImportedTitles()
                await onLibraryChanged()
              } finally {
                restoring.current = false
              }
            }
            revisionRef.current = remote.revision
            setRevision(remote.revision)
            setLastSyncedAt(remote.updatedAt)
          } else if (!alwaysUpload) {
            setPhase('idle')
            return
          }
        }

        const games = await db.getGames()
        const data = await db.getLibrarySnapshot(
          games.map((game) => game.id),
          true,
        )
        if (!alwaysUpload && remoteData && sameBackupContent(data, remoteData)) {
          setPhase('idle')
          setMessage(`已同步 ${games.length} 个游戏及其存档`)
          return
        }
        const bytes = await createBackup(data, { includeRoms: true })
        const receipt = await uploadCloudSnapshot(bytes)
        revisionRef.current = receipt.revision
        setRevision(receipt.revision)
        setLastSyncedAt(receipt.updatedAt)
        setPhase('idle')
        setMessage(`已同步 ${games.length} 个游戏及其存档`)
      } catch (cause) {
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '账号同步失败，请稍后重试。')
      } finally {
        syncing.current = false
        if (pending.current && userRef.current) {
          pending.current = false
          void runSyncRef.current(false)
        }
      }
    },
    [onLibraryChanged],
  )
  runSyncRef.current = runSync

  useEffect(() => {
    let cancelled = false
    void getAccountSession().then(
      (current) => {
        if (cancelled) return
        userRef.current = current
        setUser(current)
        if (current) void runSync(true)
        else {
          setPhase('signed-out')
          setMessage('登录后自动同步游戏、ROM 与存档。')
        }
      },
      () => {
        if (cancelled) return
        setPhase('error')
        setMessage('账号服务暂时不可用，本地游戏仍可正常使用。')
      },
    )
    return () => {
      cancelled = true
    }
  }, [runSync])

  useEffect(() => {
    const flushScheduled = (pullRemote = false) => {
      window.clearTimeout(contentTimer.current)
      window.clearTimeout(metadataTimer.current)
      contentTimer.current = undefined
      metadataTimer.current = undefined
      if (userRef.current) void runSync(pullRemote)
    }
    const schedule = (event: Event) => {
      if (!userRef.current || restoring.current) return
      const kind = (event as CustomEvent<'content' | 'metadata'>).detail
      const timer = kind === 'metadata' ? metadataTimer : contentTimer
      if (timer.current !== undefined) return
      timer.current = window.setTimeout(
        () => {
          timer.current = undefined
          void runSync(false)
        },
        kind === 'metadata' ? 10000 : 1500,
      )
    }
    const online = () => {
      flushScheduled(true)
    }
    const pullLatest = () => {
      if (userRef.current && document.visibilityState === 'visible') void runSync(true, false)
    }
    const visibilityChange = () => {
      if (document.visibilityState === 'hidden') flushScheduled(false)
      else pullLatest()
    }
    const poll = window.setInterval(pullLatest, 3000)
    window.addEventListener('advance-library-changed', schedule)
    window.addEventListener('online', online)
    window.addEventListener('focus', pullLatest)
    document.addEventListener('visibilitychange', visibilityChange)
    return () => {
      window.clearInterval(poll)
      window.removeEventListener('advance-library-changed', schedule)
      window.removeEventListener('online', online)
      window.removeEventListener('focus', pullLatest)
      document.removeEventListener('visibilitychange', visibilityChange)
      window.clearTimeout(contentTimer.current)
      window.clearTimeout(metadataTimer.current)
    }
  }, [runSync])

  const authenticate = useCallback(
    async (mode: 'login' | 'register', username: string, password: string) => {
      setPhase('syncing')
      setMessage(mode === 'login' ? '正在登录并恢复游戏库…' : '正在创建账号并保存游戏库…')
      try {
        const current =
          mode === 'login'
            ? await loginAccount(username, password)
            : await registerAccount(username, password)
        userRef.current = current
        setUser(current)
        await runSync(true)
      } catch (cause) {
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '登录失败，请重试。')
        throw cause
      }
    },
    [runSync],
  )

  return {
    user,
    phase,
    message,
    lastSyncedAt,
    revision,
    signIn: (username, password) => authenticate('login', username, password),
    signUp: (username, password) => authenticate('register', username, password),
    async signOut() {
      await logoutAccount()
      userRef.current = null
      setUser(null)
      setPhase('signed-out')
      setMessage('已退出账号。本地游戏仍保留在此浏览器。')
      revisionRef.current = 0
      setRevision(0)
      setLastSyncedAt(null)
    },
    syncNow: () => runSync(true),
  }
}
