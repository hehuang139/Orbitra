import { useCallback, useEffect, useRef, useState } from 'react'
import * as db from '../lib/storage.ts'
import {
  clearOnlineLibraryUrl,
  downloadOnlineLibraryGame,
  fetchOnlineLibraryManifest,
  gameIdForOnlineLibraryEntry,
  normalizeOnlineLibraryUrl,
  publishOnlineLibraryGame,
  readOnlineLibraryUrl,
  removeOnlineLibraryGame,
  saveOnlineLibraryUrl,
} from '../lib/online-library.ts'
import type { OnlineLibraryManifest } from '../lib/online-library.ts'

export type OnlineLibraryPhase =
  'unconfigured' | 'loading' | 'ready' | 'importing' | 'publishing' | 'error'

export interface OnlineLibraryController {
  url: string | null
  manifest: OnlineLibraryManifest | null
  installedGameIds: ReadonlySet<string>
  phase: OnlineLibraryPhase
  message: string
  connect(url: string): Promise<void>
  disconnect(): void
  refresh(): Promise<void>
  importGames(ids: string[]): Promise<void>
  publish(file: File, token: string): Promise<void>
  remove(filename: string, token: string): Promise<void>
}

interface OnlineLibraryOptions {
  onLibraryChanged(): Promise<void>
}

export function useOnlineLibrary({
  onLibraryChanged,
}: OnlineLibraryOptions): OnlineLibraryController {
  const [url, setUrl] = useState<string | null>(() => readOnlineLibraryUrl())
  const [manifest, setManifest] = useState<OnlineLibraryManifest | null>(null)
  const [installedGameIds, setInstalledGameIds] = useState<ReadonlySet<string>>(() => new Set())
  const [phase, setPhase] = useState<OnlineLibraryPhase>(url ? 'loading' : 'unconfigured')
  const [message, setMessage] = useState(url ? '正在读取在线游戏库…' : '尚未配置在线游戏库。')
  const urlRef = useRef(url)
  urlRef.current = url

  const load = useCallback(async (nextUrl: string, persist: boolean) => {
    const normalized = normalizeOnlineLibraryUrl(nextUrl)
    setPhase('loading')
    setMessage('正在读取在线游戏库…')
    try {
      const [nextManifest, localGames] = await Promise.all([
        fetchOnlineLibraryManifest(normalized),
        db.getGames(),
      ])
      if (persist) saveOnlineLibraryUrl(normalized)
      setUrl(normalized)
      setManifest(nextManifest)
      setInstalledGameIds(new Set(localGames.map((game) => game.id)))
      setPhase('ready')
      setMessage(`已读取 ${nextManifest.games.length} 个可分发游戏。`)
    } catch (cause) {
      setPhase('error')
      setMessage(cause instanceof Error ? cause.message : '在线游戏库读取失败。')
      throw cause
    }
  }, [])

  useEffect(() => {
    if (!urlRef.current) return
    void load(urlRef.current, false).catch(() => {})
  }, [load])

  return {
    url,
    manifest,
    installedGameIds,
    phase,
    message,
    connect: (nextUrl) => load(nextUrl, true),
    disconnect() {
      clearOnlineLibraryUrl()
      setUrl(null)
      setManifest(null)
      setPhase('unconfigured')
      setMessage('已断开在线游戏库；已导入的个人游戏不会被删除。')
    },
    async refresh() {
      if (!urlRef.current) throw new Error('请先配置在线游戏库地址。')
      await load(urlRef.current, false)
    },
    async importGames(ids: string[]) {
      if (!manifest) throw new Error('请先读取在线游戏库。')
      const requested = new Set(ids)
      const entries = manifest.games.filter((game) => requested.has(game.id))
      if (!entries.length) return
      setPhase('importing')
      let imported = 0
      let skipped = 0
      try {
        const localGames = await db.getGames()
        const known = new Set(localGames.map((game) => game.id))
        for (const [index, entry] of entries.entries()) {
          const expectedGameId = gameIdForOnlineLibraryEntry(entry)
          if (known.has(expectedGameId)) {
            skipped += 1
            continue
          }
          setMessage(`正在导入 ${index + 1}/${entries.length}：${entry.title}`)
          const bytes = await downloadOnlineLibraryGame(entry)
          const game = await db.importGame(
            new File([new Uint8Array(bytes)], entry.filename, { type: 'application/octet-stream' }),
          )
          if (game.id !== expectedGameId) throw new Error(`「${entry.title}」内容标识校验失败。`)
          if (game.title !== entry.title) await db.updateGame(game.id, { title: entry.title })
          known.add(game.id)
          imported += 1
        }
        setInstalledGameIds(known)
        await onLibraryChanged()
        setPhase('ready')
        setMessage(
          [
            imported ? `已导入 ${imported} 个游戏` : '',
            skipped ? `${skipped} 个已有游戏已跳过` : '',
          ]
            .filter(Boolean)
            .join('；') || '所选游戏已在个人游戏库中。',
        )
      } catch (cause) {
        await onLibraryChanged()
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '在线游戏导入失败。')
        throw cause
      }
    },
    async publish(file: File, token: string) {
      if (!urlRef.current) throw new Error('请先配置在线游戏库地址。')
      setPhase('publishing')
      setMessage(`正在发布 ${file.name}…`)
      try {
        const nextManifest = await publishOnlineLibraryGame(urlRef.current, token, file)
        setManifest(nextManifest)
        setPhase('ready')
        setMessage(`已发布 ${file.name}。`)
      } catch (cause) {
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '在线游戏发布失败。')
        throw cause
      }
    },
    async remove(filename: string, token: string) {
      if (!urlRef.current) throw new Error('请先配置在线游戏库地址。')
      setPhase('publishing')
      setMessage(`正在下架 ${filename}…`)
      try {
        const nextManifest = await removeOnlineLibraryGame(urlRef.current, token, filename)
        setManifest(nextManifest)
        setPhase('ready')
        setMessage(`已下架 ${filename}；个人游戏库中的副本不受影响。`)
      } catch (cause) {
        setPhase('error')
        setMessage(cause instanceof Error ? cause.message : '在线游戏下架失败。')
        throw cause
      }
    },
  }
}
