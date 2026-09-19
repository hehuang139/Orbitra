import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteCloudLibraryItem,
  downloadCloudLibraryItem,
  downloadCloudSnapshot,
  getAccountSession,
  getCloudLibraryIndex,
  loginAccount,
  logoutAccount,
  registerAccount,
  uploadCloudLibraryItem,
} from '../lib/account-api.ts'
import type { AccountUser, CloudLibraryItem } from '../lib/account-api.ts'
import { createBackup, parseBackup } from '../lib/backup-format.ts'
import * as db from '../lib/storage.ts'
import type { LibraryChange, RestoreChoices, RestorePreview } from '../lib/storage.ts'

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

export function useAccountSync({ onLibraryChanged }: AccountSyncOptions): AccountSyncController {
  const [user, setUser] = useState<AccountUser | null>(null)
  const [phase, setPhase] = useState<AccountPhase>('checking')
  const [message, setMessage] = useState('正在检查登录状态…')
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [revision, setRevision] = useState(0)
  const userRef = useRef<AccountUser | null>(null)
  const revisionRef = useRef(0)
  const libraryItems = useRef(new Map<string, CloudLibraryItem>())
  const dirtyGameIds = useRef(new Set<string>())
  const fullUpload = useRef(false)
  const syncing = useRef(false)
  const pending = useRef(false)
  const pendingPull = useRef(false)
  const pendingForceAll = useRef(false)
  const restoring = useRef(false)
  const runSyncRef = useRef<(pullRemote: boolean, forceAll?: boolean) => Promise<void>>(
    async () => {},
  )
  const contentTimer = useRef<number | undefined>(undefined)
  const metadataTimer = useRef<number | undefined>(undefined)

  const runSync = useCallback(
    async (pullRemote: boolean, forceAll = false) => {
      if (!userRef.current) return
      if (syncing.current) {
        pending.current = true
        pendingPull.current ||= pullRemote
        pendingForceAll.current ||= forceAll
        return
      }
      syncing.current = true
      setPhase('syncing')
      setMessage(pullRemote ? '正在检查账号游戏库…' : '正在保存游戏与存档到账号…')
      try {
        let restored = false
        if (pullRemote) {
          const index = await getCloudLibraryIndex(
            revisionRef.current > 0 && !forceAll ? revisionRef.current : undefined,
          )
          if (index) {
            const previousItems = libraryItems.current
            const remoteItems = new Map(index.items.map((item) => [item.gameId, item]))
            const localIds = new Set((await db.getGames()).map((game) => game.id))

            // A version-zero item library may still have a legacy all-in-one snapshot.
            if (index.revision === 0 && index.items.length === 0) {
              const legacy = await downloadCloudSnapshot()
              if (legacy) {
                const data = await parseBackup(
                  new Blob([new Uint8Array(legacy.bytes)], { type: 'application/zip' }),
                )
                const preview = await db.previewRestore(data)
                const choices = defaultRestoreChoices(preview)
                if (selectedCount(choices)) {
                  restoring.current = true
                  try {
                    await db.restoreLibrary(data, choices)
                  } finally {
                    restoring.current = false
                  }
                  restored = true
                  for (const entry of data.games) localIds.add(entry.game.id)
                }
              }
            }

            const removedIds = [...previousItems.keys()].filter(
              (id) => !remoteItems.has(id) && localIds.has(id) && !dirtyGameIds.current.has(id),
            )
            for (const id of removedIds) {
              restoring.current = true
              try {
                await db.deleteGame(id)
              } finally {
                restoring.current = false
              }
              localIds.delete(id)
              restored = true
            }

            let completed = 0
            const downloads = index.items.filter((item) => {
              const previous = previousItems.get(item.gameId)
              return (
                !localIds.has(item.gameId) ||
                (previous !== undefined &&
                  previous.sha256 !== item.sha256 &&
                  !dirtyGameIds.current.has(item.gameId))
              )
            })
            for (const item of downloads) {
              completed += 1
              setMessage(`正在恢复账号游戏 ${completed}/${downloads.length}…`)
              const remote = await downloadCloudLibraryItem(item.gameId)
              const data = await parseBackup(
                new Blob([new Uint8Array(remote.bytes)], { type: 'application/zip' }),
              )
              if (data.games.length !== 1 || data.games[0].game.id !== item.gameId) {
                throw new Error('账号中的游戏分片与内容标识不匹配。')
              }
              const preview = await db.previewRestore(data)
              const choices = defaultRestoreChoices(preview)
              if (selectedCount(choices)) {
                restoring.current = true
                try {
                  await db.restoreLibrary(data, choices)
                } finally {
                  restoring.current = false
                }
                restored = true
              }
              localIds.add(item.gameId)
            }

            libraryItems.current = remoteItems
            revisionRef.current = index.revision
            setRevision(index.revision)
            if (index.updatedAt) setLastSyncedAt(index.updatedAt)
            if (restored) {
              await db.repairImportedTitles()
              await onLibraryChanged()
            }
          } else if (!forceAll && dirtyGameIds.current.size === 0 && !fullUpload.current) {
            const games = await db.getGames()
            setPhase('idle')
            setMessage(`已同步 ${games.length} 个游戏及其存档`)
            return
          }
        }

        const games = await db.getGames()
        const gameIds = new Set(games.map((game) => game.id))
        const uploadIds = new Set<string>()
        if (forceAll || fullUpload.current) {
          for (const game of games) uploadIds.add(game.id)
        } else {
          for (const game of games) {
            if (!libraryItems.current.has(game.id)) uploadIds.add(game.id)
          }
        }
        for (const id of dirtyGameIds.current) {
          if (gameIds.has(id)) uploadIds.add(id)
        }

        for (const id of [...dirtyGameIds.current]) {
          if (gameIds.has(id)) continue
          const receipt = await deleteCloudLibraryItem(id)
          libraryItems.current.delete(id)
          dirtyGameIds.current.delete(id)
          revisionRef.current = receipt.revision
          setRevision(receipt.revision)
          if (receipt.updatedAt) setLastSyncedAt(receipt.updatedAt)
        }

        let completed = 0
        for (const id of uploadIds) {
          completed += 1
          setMessage(`正在上传账号游戏 ${completed}/${uploadIds.size}…`)
          const data = await db.getLibrarySnapshot([id], true)
          const bytes = await createBackup(data, { includeRoms: true })
          const receipt = await uploadCloudLibraryItem(id, bytes)
          libraryItems.current.set(id, {
            gameId: id,
            revision: receipt.revision,
            updatedAt: receipt.updatedAt,
            size: receipt.size,
            sha256: receipt.sha256,
          })
          dirtyGameIds.current.delete(id)
          revisionRef.current = receipt.revision
          setRevision(receipt.revision)
          setLastSyncedAt(receipt.updatedAt)
        }
        if (forceAll || fullUpload.current) fullUpload.current = false

        setPhase('idle')
        setMessage(`已同步 ${games.length} 个游戏及其存档`)
      } catch (cause) {
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '账号同步失败，请稍后重试。')
      } finally {
        syncing.current = false
        if (pending.current && userRef.current) {
          const pull = pendingPull.current
          const force = pendingForceAll.current
          pending.current = false
          pendingPull.current = false
          pendingForceAll.current = false
          void runSyncRef.current(pull, force)
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
      const detail = (event as CustomEvent<LibraryChange | LibraryChange['kind']>).detail
      const change: LibraryChange = typeof detail === 'string' ? { kind: detail } : detail
      if (change.gameId) dirtyGameIds.current.add(change.gameId)
      else fullUpload.current = true
      const timer = change.kind === 'metadata' ? metadataTimer : contentTimer
      if (timer.current !== undefined) return
      timer.current = window.setTimeout(
        () => {
          timer.current = undefined
          void runSync(false)
        },
        change.kind === 'metadata' ? 10000 : 1500,
      )
    }
    const online = () => {
      flushScheduled(true)
    }
    const pullLatest = () => {
      if (userRef.current && document.visibilityState === 'visible') void runSync(true)
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
      libraryItems.current.clear()
      dirtyGameIds.current.clear()
      fullUpload.current = false
      setUser(null)
      setPhase('signed-out')
      setMessage('已退出账号。本地游戏仍保留在此浏览器。')
      revisionRef.current = 0
      setRevision(0)
      setLastSyncedAt(null)
    },
    syncNow: () => runSync(true, true),
  }
}
