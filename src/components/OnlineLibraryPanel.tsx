import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  CloudDownload,
  Download,
  Link2,
  LoaderCircle,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
  Upload,
} from 'lucide-react'
import type { OnlineLibraryController } from '../hooks/useOnlineLibrary.ts'
import { gameIdForOnlineLibraryEntry } from '../lib/online-library.ts'
import { PLATFORM_REGISTRY, ROM_FILE_EXTENSIONS } from '../lib/platforms.ts'
import './online-library-panel.css'

interface OnlineLibraryPanelProps {
  library: OnlineLibraryController
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function OnlineLibraryPanel({ library }: OnlineLibraryPanelProps) {
  const [url, setUrl] = useState(library.url ?? '')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [view, setView] = useState<'browse' | 'manage'>('browse')
  const [adminToken, setAdminToken] = useState('')
  const [upload, setUpload] = useState<File | null>(null)
  const [uploadInputKey, setUploadInputKey] = useState(0)
  const busy = ['loading', 'importing', 'publishing'].includes(library.phase)
  const available = useMemo(
    () =>
      (library.manifest?.games ?? []).filter(
        (game) => !library.installedGameIds.has(gameIdForOnlineLibraryEntry(game)),
      ),
    [library.installedGameIds, library.manifest],
  )

  useEffect(() => setUrl(library.url ?? ''), [library.url])
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
      <div className="online-library-panel">
        <div className="online-library-source">
          <Server size={19} aria-hidden="true" />
          <div>
            <strong>添加分发来源</strong>
            <span>公开分发目录，不使用用户账号登录。</span>
          </div>
        </div>
        <form className="online-library-form" onSubmit={(event) => void connect(event)}>
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
      </div>
    )
  }

  const allSelected = available.length > 0 && available.every((game) => selected.has(game.id))
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(available.map((game) => game.id)))

  return (
    <div className="online-library-panel">
      <div className="online-library-source">
        <CloudDownload size={19} aria-hidden="true" />
        <div>
          <span>{library.manifest.name}</span>
          <strong title={library.url}>{library.url}</strong>
          <small>目录版本 {library.manifest.revision}</small>
        </div>
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
            library.disconnect()
          }}
        >
          <Unplug size={16} />
        </button>
      </div>

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

      {view === 'browse' ? (
        <>
          <div className="online-library-toolbar">
            <label>
              <input
                type="checkbox"
                checked={allSelected}
                disabled={!available.length || busy}
                onChange={toggleAll}
              />
              <span>选择全部未导入游戏</span>
            </label>
            <span>{available.length} 个可导入</span>
          </div>
          <div className="online-library-list" aria-label="在线游戏目录">
            {library.manifest.games.length ? (
              library.manifest.games.map((game) => {
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
                      onChange={() =>
                        setSelected((current) => {
                          const next = new Set(current)
                          if (next.has(game.id)) next.delete(game.id)
                          else next.add(game.id)
                          return next
                        })
                      }
                    />
                    <span>
                      <strong>{game.title}</strong>
                      <small>
                        {PLATFORM_REGISTRY[game.platform].label} · {formatSize(game.size)}
                      </small>
                    </span>
                    <em>{installed ? '已在个人库' : '可导入'}</em>
                  </label>
                )
              })
            ) : (
              <div className="online-library-empty">此在线游戏库暂时没有可分发的游戏。</div>
            )}
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
        </>
      ) : (
        <>
          <form
            className="online-library-form online-library-admin"
            onSubmit={(event) => {
              event.preventDefault()
              if (!upload) return
              void library
                .publish(upload, adminToken)
                .then(() => {
                  setUpload(null)
                  setUploadInputKey((value) => value + 1)
                })
                .catch(() => {})
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
            <label>
              <span>发布 ROM</span>
              <input
                key={uploadInputKey}
                name="gameFile"
                type="file"
                accept={ROM_FILE_EXTENSIONS.join(',')}
                required
                onChange={(event) => setUpload(event.target.files?.[0] ?? null)}
              />
            </label>
            <button className="button primary" type="submit" disabled={busy || !upload}>
              {library.phase === 'publishing' ? (
                <LoaderCircle size={16} className="account-spinner" />
              ) : (
                <Upload size={16} />
              )}
              发布到在线库
            </button>
          </form>
          <div className="online-library-list" aria-label="已发布游戏">
            {library.manifest.games.length ? (
              library.manifest.games.map((game) => (
                <div className="online-library-game online-library-managed-game" key={game.id}>
                  <CloudDownload size={16} aria-hidden="true" />
                  <span>
                    <strong>{game.title}</strong>
                    <small>
                      {PLATFORM_REGISTRY[game.platform].label} · {formatSize(game.size)}
                    </small>
                  </span>
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
              <div className="online-library-empty">尚未发布游戏。</div>
            )}
          </div>
        </>
      )}
      <div
        className={`online-library-feedback ${library.phase === 'error' ? 'is-error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {library.message}
      </div>
      <p className="small-note">
        {view === 'browse'
          ? '在线库只提供游戏文件；个人存档与账号数据不会发送给此来源。'
          : '管理令牌仅保留在当前对话框中，关闭或刷新后清除。'}
      </p>
    </div>
  )
}
