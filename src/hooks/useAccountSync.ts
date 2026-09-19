import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clearOnlineLibraryConnection,
  OnlineLibraryClient,
  readOnlineLibraryConnection,
  saveOnlineLibraryConnection,
} from '../lib/account-api.ts'
import type { AccountUser, CloudLibraryItem } from '../lib/account-api.ts'
import { createBackup, parseBackup } from '../lib/backup-format.ts'
import * as db from '../lib/storage.ts'
import type { LibraryChange, RestoreChoices, RestorePreview } from '../lib/storage.ts'

export type AccountPhase = 'unconfigured' | 'checking' | 'signed-out' | 'idle' | 'syncing' | 'error'

export interface AccountSyncController {
  serverUrl: string | null
  user: AccountUser | null
  phase: AccountPhase
  message: string
  lastSyncedAt: number | null
  revision: number
  connect(serverUrl: string): Promise<void>
  disconnect(): Promise<void>
  signIn(username: string, password: string): Promise<void>
  signUp(username: string, password: string): Promise<void>
  signOut(): Promise<void>
  syncNow(): Promise<void>
  ensureRom(gameId: string): Promise<Uint8Array | undefined>
}

interface AccountSyncOptions {
  onLibraryChanged(): Promise<void>
}

const KNOWN_LIBRARY_PREFIX = 'advance.account-library.'

function knownLibraryKey(serverUrl: string, userId: number): string {
  return `${KNOWN_LIBRARY_PREFIX}${encodeURIComponent(serverUrl)}.${userId}`
}

function loadKnownLibrary(serverUrl: string, userId: number): Map<string, CloudLibraryItem> {
  try {
    const value = JSON.parse(localStorage.getItem(knownLibraryKey(serverUrl, userId)) || '[]')
    if (!Array.isArray(value)) return new Map()
    return new Map(
      value
        .filter(
          (item): item is CloudLibraryItem =>
            item &&
            typeof item === 'object' &&
            typeof item.gameId === 'string' &&
            /^[0-9a-f]{64}$/.test(item.gameId) &&
            typeof item.syncReady === 'boolean' &&
            typeof item.syncSha256 === 'string',
        )
        .map((item) => [item.gameId, item]),
    )
  } catch {
    return new Map()
  }
}

function saveKnownLibrary(
  serverUrl: string,
  userId: number,
  items: Map<string, CloudLibraryItem>,
): void {
  try {
    localStorage.setItem(knownLibraryKey(serverUrl, userId), JSON.stringify([...items.values()]))
  } catch {
    // Sync still works without this deletion/version cache.
  }
}

function defaultRestoreChoices(preview: RestorePreview): RestoreChoices {
  return {
    fingerprint: preview.fingerprint,
    games: Object.fromEntries(
      preview.games.map((entry) => [
        entry.game.id,
        {
          metadata: true,
          battery: entry.battery.available,
          slots: entry.states.filter((state) => !state.incompatible).map((state) => state.slot),
        },
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
  const initialConnection = useRef(readOnlineLibraryConnection())
  const [serverUrl, setServerUrl] = useState<string | null>(initialConnection.current?.url ?? null)
  const [user, setUser] = useState<AccountUser | null>(null)
  const [phase, setPhase] = useState<AccountPhase>(serverUrl ? 'checking' : 'unconfigured')
  const [message, setMessage] = useState(
    serverUrl ? '正在连接在线游戏库…' : '配置独立的在线游戏库地址后即可登录和同步。',
  )
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [revision, setRevision] = useState(0)
  const userRef = useRef<AccountUser | null>(null)
  const clientRef = useRef<OnlineLibraryClient | null>(
    initialConnection.current
      ? new OnlineLibraryClient(initialConnection.current.url, initialConnection.current.token)
      : null,
  )
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
      const client = clientRef.current
      if (!userRef.current || !client) return
      if (syncing.current) {
        pending.current = true
        pendingPull.current ||= pullRemote
        pendingForceAll.current ||= forceAll
        return
      }
      syncing.current = true
      setPhase('syncing')
      setMessage(pullRemote ? '正在检查在线游戏库…' : '正在保存游戏与存档到在线库…')
      try {
        let restored = false
        if (pullRemote) {
          const index = await client.getLibraryIndex(
            revisionRef.current > 0 && !forceAll ? revisionRef.current : undefined,
          )
          if (index) {
            const previousItems = libraryItems.current
            const remoteItems = new Map(index.items.map((item) => [item.gameId, item]))
            const localIds = new Set((await db.getGames()).map((game) => game.id))

            // A version-zero item library may still have a legacy all-in-one snapshot.
            if (index.revision === 0 && index.items.length === 0) {
              const legacy = await client.downloadSnapshot()
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
                item.syncReady &&
                !dirtyGameIds.current.has(item.gameId) &&
                (!localIds.has(item.gameId) ||
                  previous === undefined ||
                  previous.syncSha256 !== item.syncSha256)
              )
            })
            for (const item of downloads) {
              completed += 1
              setMessage(`正在恢复在线游戏 ${completed}/${downloads.length}…`)
              const remote = await client.downloadLibrarySync(item.gameId)
              const data = await parseBackup(
                new Blob([new Uint8Array(remote.bytes)], { type: 'application/zip' }),
              )
              if (data.games.length !== 1 || data.games[0].game.id !== item.gameId) {
                throw new Error('在线游戏库中的游戏分片与内容标识不匹配。')
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
            saveKnownLibrary(client.baseUrl, userRef.current.id, remoteItems)
            revisionRef.current = index.revision
            setRevision(index.revision)
            if (index.updatedAt) setLastSyncedAt(index.updatedAt)
            if (restored) {
              await onLibraryChanged()
            }
          } else if (!forceAll && dirtyGameIds.current.size === 0 && !fullUpload.current) {
            const games = await db.getGames()
            setPhase('idle')
            setMessage(`已同步 ${games.length} 个游戏清单及存档`)
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
            const remote = libraryItems.current.get(game.id)
            if (!remote || !remote.syncReady) uploadIds.add(game.id)
          }
        }
        for (const id of dirtyGameIds.current) {
          if (gameIds.has(id)) uploadIds.add(id)
        }

        for (const id of [...dirtyGameIds.current]) {
          if (gameIds.has(id)) continue
          const receipt = await client.deleteLibraryItem(id)
          libraryItems.current.delete(id)
          dirtyGameIds.current.delete(id)
          revisionRef.current = receipt.revision
          setRevision(receipt.revision)
          if (receipt.updatedAt) setLastSyncedAt(receipt.updatedAt)
        }

        let completed = 0
        for (const id of uploadIds) {
          completed += 1
          setMessage(`正在同步游戏清单与存档 ${completed}/${uploadIds.size}…`)
          let remote = libraryItems.current.get(id)
          if (!remote) {
            const fullData = await db.getLibrarySnapshot([id], true)
            const fullBytes = await createBackup(fullData, { includeRoms: true })
            const fullReceipt = await client.uploadLibraryItem(id, fullBytes)
            remote = {
              gameId: id,
              ...fullReceipt,
              syncReady: false,
              syncSize: fullReceipt.size,
              syncSha256: fullReceipt.sha256,
            }
          }
          const syncData = await db.getLibrarySnapshot([id], false)
          const syncBytes = await createBackup(syncData, { includeRoms: false })
          const receipt = await client.uploadLibrarySync(id, syncBytes)
          libraryItems.current.set(id, {
            ...remote,
            revision: receipt.revision,
            updatedAt: receipt.updatedAt,
            syncReady: true,
            syncSize: receipt.size,
            syncSha256: receipt.sha256,
          })
          dirtyGameIds.current.delete(id)
          revisionRef.current = receipt.revision
          setRevision(receipt.revision)
          setLastSyncedAt(receipt.updatedAt)
        }
        if (forceAll || fullUpload.current) fullUpload.current = false
        saveKnownLibrary(client.baseUrl, userRef.current.id, libraryItems.current)

        setPhase('idle')
        const waiting = [...libraryItems.current.values()].filter((item) => !item.syncReady).length
        setMessage(
          waiting
            ? `已同步 ${games.length} 个游戏；${waiting} 个旧游戏等待源浏览器更新清单`
            : `已同步 ${games.length} 个游戏清单及存档`,
        )
      } catch (cause) {
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '在线游戏库同步失败，请稍后重试。')
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
    const client = clientRef.current
    if (!client) {
      setPhase('unconfigured')
      setMessage('配置独立的在线游戏库地址后即可登录和同步。')
      return
    }
    void (async () => {
      await client.health()
      return client.getSession()
    })().then(
      (current) => {
        if (cancelled) return
        userRef.current = current
        setUser(current)
        if (current) {
          libraryItems.current = loadKnownLibrary(client.baseUrl, current.id)
          revisionRef.current = 0
          void runSync(true)
        } else {
          client.setToken()
          saveOnlineLibraryConnection({ url: client.baseUrl })
          setPhase('signed-out')
          setMessage('在线库已连接。登录后自动同步清单与存档，ROM 在启动时按需下载。')
        }
      },
      () => {
        if (cancelled) return
        setPhase('error')
        setMessage('在线游戏库暂时不可用，本地游戏仍可正常使用。')
      },
    )
    return () => {
      cancelled = true
    }
  }, [runSync, serverUrl])

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
      const client = clientRef.current
      if (!client) throw new Error('请先配置在线游戏库地址。')
      setPhase('syncing')
      setMessage(mode === 'login' ? '正在登录并恢复游戏库…' : '正在创建账号并保存游戏库…')
      try {
        const session =
          mode === 'login'
            ? await client.login(username, password)
            : await client.register(username, password)
        client.setToken(session.token)
        saveOnlineLibraryConnection({ url: client.baseUrl, token: session.token })
        userRef.current = session.user
        libraryItems.current = loadKnownLibrary(client.baseUrl, session.user.id)
        revisionRef.current = 0
        setUser(session.user)
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
    serverUrl,
    user,
    phase,
    message,
    lastSyncedAt,
    revision,
    async connect(value: string) {
      setPhase('checking')
      setMessage('正在连接在线游戏库…')
      try {
        const client = new OnlineLibraryClient(value)
        await client.health()
        clearOnlineLibraryConnection()
        saveOnlineLibraryConnection({ url: client.baseUrl })
        clientRef.current = client
        userRef.current = null
        libraryItems.current.clear()
        dirtyGameIds.current.clear()
        revisionRef.current = 0
        setRevision(0)
        setLastSyncedAt(null)
        setUser(null)
        setServerUrl(client.baseUrl)
        setPhase('signed-out')
        setMessage('在线库已连接。登录后自动同步清单与存档，ROM 在启动时按需下载。')
      } catch (cause) {
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '无法连接在线游戏库。')
        throw cause
      }
    },
    async disconnect() {
      const client = clientRef.current
      if (client && userRef.current) await client.logout().catch(() => {})
      clearOnlineLibraryConnection()
      clientRef.current = null
      userRef.current = null
      libraryItems.current.clear()
      dirtyGameIds.current.clear()
      fullUpload.current = false
      revisionRef.current = 0
      setServerUrl(null)
      setUser(null)
      setRevision(0)
      setLastSyncedAt(null)
      setPhase('unconfigured')
      setMessage('已断开在线游戏库。本地游戏和存档仍保留在此浏览器。')
    },
    signIn: (username, password) => authenticate('login', username, password),
    signUp: (username, password) => authenticate('register', username, password),
    async signOut() {
      const client = clientRef.current
      if (!client) return
      await client.logout().catch(() => {})
      client.setToken()
      saveOnlineLibraryConnection({ url: client.baseUrl })
      userRef.current = null
      libraryItems.current.clear()
      dirtyGameIds.current.clear()
      fullUpload.current = false
      setUser(null)
      setPhase('signed-out')
      setMessage('已退出在线库账号。本地游戏仍保留在此浏览器。')
      revisionRef.current = 0
      setRevision(0)
      setLastSyncedAt(null)
    },
    syncNow: () => runSync(true, true),
    async ensureRom(gameId: string) {
      const local = await db.getRom(gameId)
      if (local) return local
      const client = clientRef.current
      if (!client || !userRef.current || !libraryItems.current.has(gameId)) return undefined
      setMessage('正在下载游戏 ROM…')
      try {
        const remote = await client.downloadLibraryItem(gameId)
        const data = await parseBackup(
          new Blob([new Uint8Array(remote.bytes)], { type: 'application/zip' }),
        )
        const entry = data.games.find((item) => item.game.id === gameId)
        if (!entry?.rom) throw new Error('在线库游戏缺少 ROM，请在原浏览器中重新导入。')
        const bytes = await db.cacheRom(gameId, entry.rom)
        setMessage(
          `ROM 已缓存到当前浏览器；已同步 ${(await db.getGames()).length} 个游戏清单及存档`,
        )
        return bytes
      } catch (cause) {
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '游戏下载失败，请稍后重试。')
        throw cause
      }
    },
  }
}
