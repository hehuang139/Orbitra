import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  CloudDownload,
  Download,
  Files,
  Gamepad2,
  Link2,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Unplug,
  Upload,
} from 'lucide-react'
import type { OnlineLibraryController } from '../hooks/useOnlineLibrary.ts'
import { gameIdForOnlineLibraryEntry } from '../lib/online-library.ts'
import { PLATFORM_LIST, PLATFORM_REGISTRY, type GamePlatform } from '../lib/platforms.ts'
import { getRomGameIds } from '../lib/storage.ts'
import type { Game } from '../lib/types.ts'
import './online-library-panel.css'

interface OnlineLibraryPageProps {
  library: OnlineLibraryController
  personalGames: readonly Game[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

type PersonalGamePublishStatus =
  'ready' | 'published' | 'missing-rom' | 'filename-conflict' | 'checking'

const publishStatusLabel: Record<PersonalGamePublishStatus, string> = {
  ready: '可发布',
  published: '已发布',
  'missing-rom': 'ROM 不在此设备',
  'filename-conflict': '文件名冲突',
  checking: '正在检查 ROM',
}

export function OnlineLibraryPage({ library, personalGames }: OnlineLibraryPageProps) {
  const [url, setUrl] = useState(library.url ?? '')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [view, setView] = useState<'browse' | 'manage'>('browse')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState<'all' | GamePlatform>('all')
  const [adminToken, setAdminToken] = useState('')
  const [selectedPersonalGames, setSelectedPersonalGames] = useState<Set<string>>(() => new Set())
  const [localRomGameIds, setLocalRomGameIds] = useState<ReadonlySet<string> | null>(null)
  const busy = ['loading', 'importing', 'publishing'].includes(library.phase)
  const games = useMemo(() => library.manifest?.games ?? [], [library.manifest])
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const available = useMemo(
    () => games.filter((game) => !library.installedGameIds.has(gameIdForOnlineLibraryEntry(game))),
    [games, library.installedGameIds],
  )
  const publishedGameIds = useMemo(
    () => new Set(games.map((game) => gameIdForOnlineLibraryEntry(game))),
    [games],
  )
  const publishedFilenames = useMemo(
    () =>
      new Map(
        games.map((game) => [
          game.filename.toLocaleLowerCase('en-US'),
          gameIdForOnlineLibraryEntry(game),
        ]),
      ),
    [games],
  )
  const personalPublishRows = useMemo(
    () =>
      personalGames.map((game) => {
        let status: PersonalGamePublishStatus = 'ready'
        if (publishedGameIds.has(game.id)) status = 'published'
        else if (
          publishedFilenames.has(game.filename.toLocaleLowerCase('en-US')) &&
          publishedFilenames.get(game.filename.toLocaleLowerCase('en-US')) !== game.id
        ) {
          status = 'filename-conflict'
        } else if (!localRomGameIds) status = 'checking'
        else if (!localRomGameIds.has(game.id)) status = 'missing-rom'
        return { game, status }
      }),
    [localRomGameIds, personalGames, publishedFilenames, publishedGameIds],
  )
  const publishablePersonalGames = useMemo(
    () => personalPublishRows.filter(({ status }) => status === 'ready').map(({ game }) => game),
    [personalPublishRows],
  )
  const visiblePersonalRows = useMemo(
    () =>
      personalPublishRows.filter(
        ({ game }) =>
          !normalizedQuery ||
          `${game.title}\n${game.filename}\n${PLATFORM_REGISTRY[game.platform].label}`
            .toLocaleLowerCase('zh-CN')
            .includes(normalizedQuery),
      ),
    [normalizedQuery, personalPublishRows],
  )
  const visibleGames = useMemo(() => {
    return games.filter(
      (game) =>
        (view !== 'browse' || platform === 'all' || game.platform === platform) &&
        (!normalizedQuery ||
          `${game.title}\n${game.filename}\n${PLATFORM_REGISTRY[game.platform].label}`
            .toLocaleLowerCase('zh-CN')
            .includes(normalizedQuery)),
    )
  }, [games, normalizedQuery, platform, view])
  const selectableVisible = visibleGames.filter(
    (game) => !library.installedGameIds.has(gameIdForOnlineLibraryEntry(game)),
  )

  useEffect(() => setUrl(library.url ?? ''), [library.url])
  useEffect(() => {
    let active = true
    setLocalRomGameIds(null)
    void getRomGameIds()
      .then((ids) => {
        if (active) setLocalRomGameIds(ids)
      })
      .catch(() => {
        if (active) setLocalRomGameIds(new Set())
      })
    return () => {
      active = false
    }
  }, [personalGames])
  useEffect(() => {
    setSelected((current) => {
      const availableIds = new Set(available.map((game) => game.id))
      return new Set(Array.from(current).filter((id) => availableIds.has(id)))
    })
  }, [available])
  useEffect(() => {
    setSelectedPersonalGames((current) => {
      const publishableIds = new Set(publishablePersonalGames.map((game) => game.id))
      const next = new Set(Array.from(current).filter((id) => publishableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [publishablePersonalGames])

  const connect = async (event: FormEvent) => {
    event.preventDefault()
    await library.connect(url).catch(() => {})
  }

  if (!library.url || !library.manifest) {
    return (
      <section className="online-library-page online-library-connect" aria-label="连接在线游戏库">
        <div className="online-library-connect-heading">
          <span className="online-library-connect-icon" aria-hidden="true">
            <Server size={24} />
          </span>
          <div>
            <h2>添加分发来源</h2>
            <p>连接一个 Orbitra 在线游戏库。</p>
          </div>
        </div>
        <form className="online-library-form online-library-connect-form" onSubmit={connect}>
          <label>
            <span>在线游戏库地址</span>
            <input
              name="onlineLibraryUrl"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://library.example.com"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="account-spinner" /> : <Link2 size={16} />}
            读取目录
          </button>
        </form>
        <div
          className={`online-library-feedback ${library.phase === 'error' ? 'is-error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {library.message}
        </div>
      </section>
    )
  }

  const allSelected =
    selectableVisible.length > 0 && selectableVisible.every((game) => selected.has(game.id))
  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current)
      for (const game of selectableVisible) {
        if (allSelected) next.delete(game.id)
        else next.add(game.id)
      }
      return next
    })
  }
  const allPublishableSelected =
    publishablePersonalGames.length > 0 &&
    publishablePersonalGames.every((game) => selectedPersonalGames.has(game.id))
  const toggleAllPublishable = () => {
    setSelectedPersonalGames(
      allPublishableSelected ? new Set() : new Set(publishablePersonalGames.map((game) => game.id)),
    )
  }

  return (
    <section className="online-library-page" aria-label="在线游戏库工作台">
      <header className="online-library-source">
        <span className="online-library-source-icon" aria-hidden="true">
          <CloudDownload size={21} />
        </span>
        <div className="online-library-source-name">
          <h2>{library.manifest.name}</h2>
          <span title={library.url}>{library.url}</span>
        </div>
        <div className="online-library-summary" aria-label="在线游戏库概览">
          <span>
            <strong>{games.length}</strong> 已发布
          </span>
          <span>
            <strong>{available.length}</strong> 可导入
          </span>
          <span>
            <strong>{library.manifest.revision.slice(0, 8)}</strong> 目录版本
          </span>
        </div>
        <div className="online-library-source-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="刷新在线游戏库"
            title="刷新在线游戏库"
            disabled={busy}
            onClick={() => void library.refresh().catch(() => {})}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="断开在线游戏库"
            title="断开在线游戏库"
            disabled={busy}
            onClick={() => {
              setAdminToken('')
              setQuery('')
              setPlatform('all')
              library.disconnect()
            }}
          >
            <Unplug size={16} />
          </button>
        </div>
      </header>

      <div className="online-library-tabs" role="tablist" aria-label="在线游戏库视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'browse'}
          onClick={() => setView('browse')}
        >
          浏览与导入
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'manage'}
          onClick={() => setView('manage')}
        >
          管理分发
        </button>
      </div>

      <div className="online-library-toolbar">
        <div className="online-library-filter-tools">
          <label className="online-library-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索在线游戏"
              placeholder="搜索游戏或文件名…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {view === 'browse' && (
            <label className="online-library-platform-filter">
              <Gamepad2 size={16} aria-hidden="true" />
              <select
                aria-label="游戏类型"
                value={platform}
                onChange={(event) => setPlatform(event.target.value as 'all' | GamePlatform)}
              >
                <option value="all">全部类型</option>
                {PLATFORM_LIST.map((definition) => (
                  <option value={definition.id} key={definition.id}>
                    {definition.label} · {definition.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {view === 'browse' ? (
          <label className="online-library-select-all">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={!selectableVisible.length || busy}
              onChange={toggleAll}
            />
            <span>选择当前结果</span>
          </label>
        ) : (
          <span className="online-library-result-count">
            {visiblePersonalRows.length} 个本地游戏 · {visibleGames.length} 个已发布
          </span>
        )}
      </div>

      {view === 'browse' ? (
        <>
          <div className="online-library-table online-library-browse-table">
            <div className="online-library-table-heading" aria-hidden="true">
              <span aria-hidden="true" />
              <span>游戏</span>
              <span>文件名</span>
              <span>平台</span>
              <span>大小</span>
              <span>状态</span>
            </div>
            <div className="online-library-list" aria-label="在线游戏目录">
              {visibleGames.length ? (
                visibleGames.map((game) => {
                  const installed = library.installedGameIds.has(gameIdForOnlineLibraryEntry(game))
                  return (
                    <label
                      className={`online-library-game ${installed ? 'is-installed' : ''}`}
                      key={game.id}
                    >
                      <input
                        type="checkbox"
                        checked={installed || selected.has(game.id)}
                        disabled={installed || busy}
                        aria-label={`选择 ${game.title}`}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current)
                            if (next.has(game.id)) next.delete(game.id)
                            else next.add(game.id)
                            return next
                          })
                        }
                      />
                      <span className="online-library-game-title">
                        <strong>{game.title}</strong>
                        <small className="online-library-mobile-meta">
                          {PLATFORM_REGISTRY[game.platform].label} · {formatSize(game.size)}
                        </small>
                      </span>
                      <span className="online-library-filename" title={game.filename}>
                        {game.filename}
                      </span>
                      <span className="online-library-platform">
                        {PLATFORM_REGISTRY[game.platform].label}
                      </span>
                      <span className="online-library-size">{formatSize(game.size)}</span>
                      <em>{installed ? '已在个人库' : '可导入'}</em>
                    </label>
                  )
                })
              ) : (
                <div className="online-library-empty">
                  <Files size={24} aria-hidden="true" />
                  <span>
                    {games.length
                      ? '没有匹配此类型或搜索条件的游戏。'
                      : '此在线游戏库暂时没有游戏。'}
                  </span>
                </div>
              )}
            </div>
          </div>
          <footer className="online-library-actionbar">
            <div
              className={`online-library-feedback ${library.phase === 'error' ? 'is-error' : ''}`}
              role="status"
              aria-live="polite"
            >
              {library.message}
            </div>
            <button
              className="button primary online-library-import"
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() =>
                void library
                  .importGames(Array.from(selected))
                  .then(() => setSelected(new Set()))
                  .catch(() => {})
              }
            >
              {library.phase === 'importing' ? (
                <LoaderCircle size={16} className="account-spinner" />
              ) : (
                <Download size={16} />
              )}
              导入所选{selected.size ? `（${selected.size}）` : ''}
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="online-library-form online-library-admin">
            <label>
              <span>管理员令牌</span>
              <input
                name="adminToken"
                type="password"
                autoComplete="off"
                required
                value={adminToken}
                onChange={(event) => setAdminToken(event.target.value)}
              />
            </label>
            <span className="online-library-token-note">令牌仅在当前页面停留期间保留。</span>
          </div>

          <section
            className="online-library-manage-section"
            aria-labelledby="personal-games-heading"
          >
            <header className="online-library-section-heading">
              <div>
                <h3 id="personal-games-heading">本地游戏待发布</h3>
                <span>{publishablePersonalGames.length} 个可发布</span>
              </div>
              <div className="online-library-bulk-actions">
                <label className="online-library-select-all">
                  <input
                    type="checkbox"
                    aria-label="选择全部可发布游戏"
                    checked={allPublishableSelected}
                    disabled={!publishablePersonalGames.length || busy}
                    onChange={toggleAllPublishable}
                  />
                  <span>全选可发布游戏</span>
                </label>
                <button
                  className="button primary online-library-publish"
                  type="button"
                  disabled={busy || !adminToken.trim() || selectedPersonalGames.size === 0}
                  onClick={() =>
                    void library
                      .publishPersonalGames(Array.from(selectedPersonalGames), adminToken)
                      .then(() => setSelectedPersonalGames(new Set()))
                      .catch(() => {})
                  }
                >
                  {library.phase === 'publishing' ? (
                    <LoaderCircle size={16} className="account-spinner" />
                  ) : (
                    <Upload size={16} />
                  )}
                  发布所选{selectedPersonalGames.size ? `（${selectedPersonalGames.size}）` : ''}
                </button>
              </div>
            </header>
            <div className="online-library-table online-library-personal-table">
              <div className="online-library-table-heading">
                <span aria-hidden="true" />
                <span>游戏</span>
                <span>文件名</span>
                <span>平台</span>
                <span>大小</span>
                <span>状态</span>
              </div>
              <div className="online-library-list" aria-label="个人游戏库发布列表">
                {visiblePersonalRows.length ? (
                  visiblePersonalRows.map(({ game, status }) => {
                    const selectable = status === 'ready'
                    return (
                      <label
                        className={`online-library-game ${selectable ? '' : 'is-unavailable'}`}
                        key={game.id}
                      >
                        <input
                          type="checkbox"
                          aria-label={`选择发布 ${game.title}`}
                          checked={status === 'published' || selectedPersonalGames.has(game.id)}
                          disabled={!selectable || busy}
                          onChange={() =>
                            setSelectedPersonalGames((current) => {
                              const next = new Set(current)
                              if (next.has(game.id)) next.delete(game.id)
                              else next.add(game.id)
                              return next
                            })
                          }
                        />
                        <span className="online-library-game-title">
                          <strong>{game.title}</strong>
                          <small className="online-library-mobile-meta">
                            {PLATFORM_REGISTRY[game.platform].label} · {formatSize(game.size)}
                          </small>
                        </span>
                        <span className="online-library-filename" title={game.filename}>
                          {game.filename}
                        </span>
                        <span className="online-library-platform">
                          {PLATFORM_REGISTRY[game.platform].label}
                        </span>
                        <span className="online-library-size">{formatSize(game.size)}</span>
                        <em className={`is-${status}`}>{publishStatusLabel[status]}</em>
                      </label>
                    )
                  })
                ) : (
                  <div className="online-library-empty">
                    <Files size={24} aria-hidden="true" />
                    <span>
                      {personalGames.length ? '没有匹配的本地游戏。' : '个人游戏库中还没有游戏。'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section
            className="online-library-manage-section"
            aria-labelledby="published-games-heading"
          >
            <header className="online-library-section-heading">
              <div>
                <h3 id="published-games-heading">在线库已发布</h3>
                <span>{visibleGames.length} 个文件</span>
              </div>
            </header>
            <div className="online-library-table online-library-manage-table">
              <div className="online-library-table-heading" aria-hidden="true">
                <span aria-hidden="true" />
                <span>游戏</span>
                <span>文件名</span>
                <span>平台</span>
                <span>大小</span>
                <span>SHA-256</span>
                <span aria-hidden="true" />
              </div>
              <div className="online-library-list" aria-label="已发布游戏">
                {visibleGames.length ? (
                  visibleGames.map((game) => (
                    <div className="online-library-game online-library-managed-game" key={game.id}>
                      <CloudDownload size={16} aria-hidden="true" />
                      <span className="online-library-game-title">
                        <strong>{game.title}</strong>
                        <small className="online-library-mobile-meta">
                          {PLATFORM_REGISTRY[game.platform].label} · {formatSize(game.size)}
                        </small>
                      </span>
                      <span className="online-library-filename" title={game.filename}>
                        {game.filename}
                      </span>
                      <span className="online-library-platform">
                        {PLATFORM_REGISTRY[game.platform].label}
                      </span>
                      <span className="online-library-size">{formatSize(game.size)}</span>
                      <code title={game.sha256}>{game.sha256.slice(0, 12)}</code>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`下架 ${game.title}`}
                        title={`下架 ${game.title}`}
                        disabled={busy || !adminToken}
                        onClick={() => {
                          if (window.confirm(`从在线游戏库下架「${game.title}」？`)) {
                            void library.remove(game.filename, adminToken).catch(() => {})
                          }
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="online-library-empty">
                    <Files size={24} aria-hidden="true" />
                    <span>{games.length ? '没有匹配的文件。' : '尚未发布游戏。'}</span>
                  </div>
                )}
              </div>
            </div>
          </section>
          <footer className="online-library-actionbar">
            <div
              className={`online-library-feedback ${library.phase === 'error' ? 'is-error' : ''}`}
              role="status"
              aria-live="polite"
            >
              {library.message}
            </div>
          </footer>
        </>
      )}
    </section>
  )
}
