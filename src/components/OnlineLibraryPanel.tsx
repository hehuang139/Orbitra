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
import {
  PLATFORM_LIST,
  PLATFORM_REGISTRY,
  ROM_FILE_EXTENSIONS,
  type GamePlatform,
} from '../lib/platforms.ts'
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

export function OnlineLibraryPage({ library, personalGames }: OnlineLibraryPageProps) {
  const [url, setUrl] = useState(library.url ?? '')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [view, setView] = useState<'browse' | 'manage'>('browse')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState<'all' | GamePlatform>('all')
  const [adminToken, setAdminToken] = useState('')
  const [uploadSource, setUploadSource] = useState<'library' | 'file'>('library')
  const [personalGameId, setPersonalGameId] = useState('')
  const [upload, setUpload] = useState<File | null>(null)
  const [uploadInputKey, setUploadInputKey] = useState(0)
  const busy = ['loading', 'importing', 'publishing'].includes(library.phase)
  const games = useMemo(() => library.manifest?.games ?? [], [library.manifest])
  const available = useMemo(
    () => games.filter((game) => !library.installedGameIds.has(gameIdForOnlineLibraryEntry(game))),
    [games, library.installedGameIds],
  )
  const publishedGameIds = useMemo(
    () => new Set(games.map((game) => gameIdForOnlineLibraryEntry(game))),
    [games],
  )
  const personalUploadOptions = useMemo(
    () => personalGames.filter((game) => !publishedGameIds.has(game.id)),
    [personalGames, publishedGameIds],
  )
  const visibleGames = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return games.filter(
      (game) =>
        (view !== 'browse' || platform === 'all' || game.platform === platform) &&
        (!normalized ||
          `${game.title}\n${game.filename}\n${PLATFORM_REGISTRY[game.platform].label}`
            .toLocaleLowerCase('zh-CN')
            .includes(normalized)),
    )
  }, [games, platform, query, view])
  const selectableVisible = visibleGames.filter(
    (game) => !library.installedGameIds.has(gameIdForOnlineLibraryEntry(game)),
  )

  useEffect(() => setUrl(library.url ?? ''), [library.url])
  useEffect(() => {
    setPersonalGameId((current) =>
      personalUploadOptions.some((game) => game.id === current)
        ? current
        : (personalUploadOptions[0]?.id ?? ''),
    )
  }, [personalUploadOptions])
  useEffect(() => {
    setSelected((current) => {
      const availableIds = new Set(available.map((game) => game.id))
      return new Set(Array.from(current).filter((id) => availableIds.has(id)))
    })
  }, [available])

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
          <span className="online-library-result-count">{visibleGames.length} 个文件</span>
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
          <form
            className="online-library-form online-library-admin"
            onSubmit={(event) => {
              event.preventDefault()
              if (uploadSource === 'library') {
                if (!personalGameId) return
                void library.publishPersonalGame(personalGameId, adminToken).catch(() => {})
              } else {
                if (!upload) return
                void library
                  .publish(upload, adminToken)
                  .then(() => {
                    setUpload(null)
                    setUploadInputKey((value) => value + 1)
                  })
                  .catch(() => {})
              }
            }}
          >
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
            <div className="online-library-publish-control">
              <span>发布 ROM</span>
              <div className="online-library-upload-source" role="group" aria-label="上传来源">
                <button
                  type="button"
                  aria-pressed={uploadSource === 'library'}
                  onClick={() => setUploadSource('library')}
                >
                  <Files size={14} />
                  个人游戏库
                </button>
                <button
                  type="button"
                  aria-pressed={uploadSource === 'file'}
                  onClick={() => setUploadSource('file')}
                >
                  <Upload size={14} />
                  本地文件
                </button>
              </div>
              {uploadSource === 'library' ? (
                <select
                  aria-label="选择个人游戏"
                  required
                  value={personalGameId}
                  disabled={!personalUploadOptions.length}
                  onChange={(event) => setPersonalGameId(event.target.value)}
                >
                  {personalUploadOptions.length ? (
                    personalUploadOptions.map((game) => (
                      <option value={game.id} key={game.id}>
                        {game.title} ({PLATFORM_REGISTRY[game.platform].label})
                      </option>
                    ))
                  ) : (
                    <option value="">没有可发布的个人游戏</option>
                  )}
                </select>
              ) : (
                <input
                  key={uploadInputKey}
                  name="gameFile"
                  type="file"
                  aria-label="发布 ROM"
                  accept={ROM_FILE_EXTENSIONS.join(',')}
                  required
                  onChange={(event) => setUpload(event.target.files?.[0] ?? null)}
                />
              )}
            </div>
            <button
              className="button primary"
              type="submit"
              disabled={busy || (uploadSource === 'library' ? !personalGameId : !upload)}
            >
              {library.phase === 'publishing' ? (
                <LoaderCircle size={16} className="account-spinner" />
              ) : (
                <Upload size={16} />
              )}
              发布到在线库
            </button>
          </form>
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
          <footer className="online-library-actionbar">
            <div
              className={`online-library-feedback ${library.phase === 'error' ? 'is-error' : ''}`}
              role="status"
              aria-live="polite"
            >
              {library.message}
            </div>
            <span className="online-library-token-note">令牌仅在当前页面停留期间保留。</span>
          </footer>
        </>
      )}
    </section>
  )
}
