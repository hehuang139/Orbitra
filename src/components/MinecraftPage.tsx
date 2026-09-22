import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  CloudDownload,
  Database,
  ExternalLink,
  HardDrive,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  downloadPreparedMinecraftVersion,
  fetchMinecraftCatalog,
  prepareMinecraftDownload,
  verifyAndRepairMinecraftVersion,
  type MinecraftDownloadProgress,
  type MinecraftPreparedDownload,
} from '../lib/minecraft-manager.ts'
import {
  deleteMinecraftVersion,
  listMinecraftTasks,
  listMinecraftVersions,
  minecraftStorageUsage,
  type MinecraftInstalledVersion,
  type MinecraftTaskRecord,
} from '../lib/minecraft-storage.ts'
import {
  MINECRAFT_ENDPOINTS,
  minecraftVersionTypeLabel,
  type MinecraftManifest,
  type MinecraftVersionEntry,
} from '../lib/minecraft.ts'
import { MinecraftPlayer } from './MinecraftPlayer.tsx'
import './minecraft.css'

type Filter = 'all' | 'release' | 'snapshot' | 'old_beta' | 'old_alpha' | 'installed'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(value: string | number): string {
  return new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

export function MinecraftPage() {
  const [manifest, setManifest] = useState<MinecraftManifest>()
  const [installed, setInstalled] = useState<MinecraftInstalledVersion[]>([])
  const [tasks, setTasks] = useState<MinecraftTaskRecord[]>([])
  const [usage, setUsage] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(100)
  const [phase, setPhase] = useState<
    'loading' | 'ready' | 'preparing' | 'downloading' | 'repairing'
  >('loading')
  const [message, setMessage] = useState('')
  const [prepared, setPrepared] = useState<MinecraftPreparedDownload>()
  const [progress, setProgress] = useState<MinecraftDownloadProgress>()
  const [player, setPlayer] = useState<MinecraftInstalledVersion>()
  const abortRef = useRef<AbortController | undefined>(undefined)

  const reloadLocal = async () => {
    const [versions, pending, storage] = await Promise.all([
      listMinecraftVersions(),
      listMinecraftTasks(),
      minecraftStorageUsage(),
    ])
    setInstalled(versions)
    setTasks(pending)
    setUsage(storage.bytes)
  }

  const load = async (force = false) => {
    setPhase('loading')
    setMessage('')
    try {
      const [catalog] = await Promise.all([fetchMinecraftCatalog({ force }), reloadLocal()])
      setManifest(catalog.manifest)
      setMessage(catalog.warning ?? '')
      setPhase('ready')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法读取 Minecraft 官方版本目录。')
      setPhase('ready')
    }
  }

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [])

  const installedByKey = useMemo(
    () => new Map(installed.map((version) => [version.key, version])),
    [installed],
  )
  const catalogVersions = useMemo(() => {
    const versions = [...(manifest?.versions ?? [])]
    const known = new Set(versions.map((version) => version.key))
    for (const local of installed) {
      if (known.has(local.key)) continue
      const metadata = local.files.find((file) => file.kind === 'version-metadata')
      const fallbackTime = new Date(local.installedAt).toISOString()
      versions.push(
        local.source ?? {
          key: local.key,
          id: local.id,
          type: local.type,
          url: metadata?.url ?? '',
          sha1: local.manifestSha1,
          time: fallbackTime,
          releaseTime: fallbackTime,
        },
      )
    }
    return versions
  }, [installed, manifest])
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return catalogVersions.filter((version) => {
      if (filter === 'installed' && !installedByKey.has(version.key)) return false
      if (filter !== 'all' && filter !== 'installed' && version.type !== filter) return false
      return !normalized || version.id.toLowerCase().includes(normalized)
    })
  }, [catalogVersions, filter, installedByKey, query])

  const prepare = async (version: MinecraftVersionEntry) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setPhase('preparing')
    setPrepared(undefined)
    setMessage(`正在解析 ${version.id} 的官方依赖…`)
    try {
      const result = await prepareMinecraftDownload(version, abortRef.current.signal)
      setPrepared(result)
      setMessage('')
      setPhase('ready')
    } catch (error) {
      if (abortRef.current.signal.aborted) return
      setMessage(error instanceof Error ? error.message : '依赖解析失败。')
      setPhase('ready')
    }
  }

  const download = async () => {
    if (!prepared) return
    abortRef.current = new AbortController()
    setPhase('downloading')
    setProgress(undefined)
    try {
      await downloadPreparedMinecraftVersion(prepared, {
        signal: abortRef.current.signal,
        onProgress: setProgress,
      })
      setPrepared(undefined)
      setMessage(`${prepared.graph.version.id} 已完整下载并通过校验。`)
      await reloadLocal()
    } catch (error) {
      setMessage(
        abortRef.current.signal.aborted
          ? '下载已暂停；已校验文件保留，下次可继续。'
          : error instanceof Error
            ? error.message
            : '下载失败。',
      )
      await reloadLocal()
    } finally {
      setPhase('ready')
    }
  }

  const repair = async (version: MinecraftInstalledVersion) => {
    abortRef.current = new AbortController()
    setPhase('repairing')
    setMessage(`正在校验 ${version.id}…`)
    try {
      const result = await verifyAndRepairMinecraftVersion(version, {
        signal: abortRef.current.signal,
        onProgress: setProgress,
      })
      setMessage(
        result.repaired ? `已修复 ${result.repaired} 个文件。` : `${version.id} 文件完整。`,
      )
      await reloadLocal()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '校验修复失败。')
    } finally {
      setPhase('ready')
    }
  }

  const remove = async (version: MinecraftInstalledVersion) => {
    if (!window.confirm(`删除本地 Minecraft ${version.id}？共享文件仍会保留给其他版本。`)) return
    await deleteMinecraftVersion(version.key)
    setMessage(`已删除本地版本 ${version.id}。`)
    await reloadLocal()
  }

  return (
    <div className="minecraft-page">
      <section className="minecraft-overview">
        <div className="minecraft-source">
          <span>
            <Database size={18} />
          </span>
          <div>
            <strong>Mojang 官方 Java Edition 目录</strong>
            <p>
              {manifest
                ? `${manifest.versions.length} 个公开版本 · 更新于 ${new Date(manifest.fetchedAt).toLocaleString('zh-CN')}`
                : '正在连接官方版本服务'}
            </p>
          </div>
        </div>
        <div className="minecraft-stats">
          <span>
            <strong>{installed.length}</strong>本地版本
          </span>
          <span>
            <strong>{formatBytes(usage)}</strong>已用空间
          </span>
          <button
            className="button secondary"
            disabled={phase !== 'ready'}
            onClick={() => void load(true)}
          >
            <RefreshCw size={15} />
            刷新目录
          </button>
        </div>
      </section>

      {message && (
        <div className="minecraft-notice" role="status">
          {message}
        </div>
      )}
      {tasks.length > 0 && (
        <div className="minecraft-resume-note">
          <HardDrive size={16} />
          {tasks.length} 个下载任务可继续；再次选择对应版本即可复用已校验文件。
        </div>
      )}

      <section className="minecraft-controls">
        <div className="minecraft-filters" role="group" aria-label="Minecraft 版本类型">
          {(
            [
              ['all', '全部'],
              ['release', '正式版'],
              ['snapshot', '快照版'],
              ['old_beta', 'Beta'],
              ['old_alpha', 'Alpha'],
              ['installed', '已下载'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              onClick={() => {
                setFilter(value)
                setLimit(100)
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="minecraft-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(100)
            }}
            placeholder="搜索版本 ID"
          />
        </label>
      </section>

      {prepared && (
        <section className="minecraft-download-plan">
          <button
            className="icon-button"
            aria-label="关闭下载计划"
            onClick={() => setPrepared(undefined)}
          >
            <X size={16} />
          </button>
          <div>
            <span className="minecraft-cube">
              <CloudDownload size={22} />
            </span>
            <div>
              <strong>下载 {prepared.graph.version.id}</strong>
              <p>
                {prepared.graph.files.length} 个文件 · 共 {formatBytes(prepared.totalBytes)} · 新增{' '}
                {formatBytes(prepared.downloadBytes)} · 复用 {prepared.reusableFiles} 个文件
              </p>
            </div>
          </div>
          <button className="button primary" onClick={() => void download()}>
            <CloudDownload size={16} />
            确认下载
          </button>
        </section>
      )}

      {['preparing', 'downloading', 'repairing'].includes(phase) && (
        <section className="minecraft-progress" aria-live="polite">
          <div>
            <LoaderCircle className="spin" size={18} />
            <strong>
              {phase === 'preparing'
                ? '解析官方依赖'
                : phase === 'repairing'
                  ? '校验并修复'
                  : '下载并校验'}
            </strong>
          </div>
          {progress && (
            <>
              <progress value={progress.completedBytes} max={progress.totalBytes} />
              <span>
                {progress.completedFiles} / {progress.totalFiles} ·{' '}
                {formatBytes(progress.completedBytes)} / {formatBytes(progress.totalBytes)}
              </span>
            </>
          )}
          <button className="button secondary" onClick={() => abortRef.current?.abort()}>
            <X size={14} />
            {phase === 'downloading' ? '暂停' : '取消'}
          </button>
        </section>
      )}

      <section className="minecraft-list" aria-busy={phase === 'loading'}>
        <div className="minecraft-list-heading">
          <span>版本</span>
          <span>类型</span>
          <span>发布时间</span>
          <span>状态与操作</span>
        </div>
        {phase === 'loading' && !manifest ? (
          <div className="minecraft-empty">
            <LoaderCircle className="spin" size={24} />
            正在读取官方目录…
          </div>
        ) : visible.length === 0 ? (
          <div className="minecraft-empty">没有符合条件的版本。</div>
        ) : (
          visible.slice(0, limit).map((version) => {
            const local = installedByKey.get(version.key)
            const playable = version.id === '1.2.5' && Boolean(local)
            return (
              <article className="minecraft-version" key={version.key}>
                <div className="minecraft-version-name">
                  <span className={`minecraft-version-mark ${version.type}`} aria-hidden="true" />
                  <div>
                    <strong>{version.id}</strong>
                    <small>
                      {local && !local.upstreamAvailable
                        ? '上游已撤下 · 本地保留'
                        : manifest?.latest.release === version.id
                          ? '最新正式版'
                          : manifest?.latest.snapshot === version.id
                            ? '最新快照版'
                            : version.sha1.slice(0, 10)}
                    </small>
                  </div>
                </div>
                <span className={`minecraft-type ${version.type}`}>
                  {minecraftVersionTypeLabel(version.type)}
                </span>
                <time>{formatDate(version.releaseTime)}</time>
                <div className="minecraft-version-actions">
                  {local ? (
                    <span className="minecraft-installed">
                      <CheckCircle2 size={14} />
                      已下载
                    </span>
                  ) : null}
                  {playable && (
                    <button className="button primary compact" onClick={() => setPlayer(local)}>
                      <Play size={14} fill="currentColor" />
                      浏览器试玩
                    </button>
                  )}
                  {local ? (
                    <>
                      <button
                        className="icon-button"
                        title="校验并修复"
                        aria-label={`校验并修复 ${version.id}`}
                        disabled={phase !== 'ready'}
                        onClick={() => void repair(local)}
                      >
                        <ShieldCheck size={16} />
                      </button>
                      <button
                        className="icon-button danger"
                        title="删除版本"
                        aria-label={`删除 ${version.id}`}
                        disabled={phase !== 'ready'}
                        onClick={() => void remove(local)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  ) : (
                    <button
                      className="button secondary compact"
                      disabled={phase !== 'ready'}
                      onClick={() => void prepare(version)}
                    >
                      <CloudDownload size={14} />
                      准备下载
                    </button>
                  )}
                </div>
              </article>
            )
          })
        )}
        {visible.length > limit && (
          <button className="minecraft-more" onClick={() => setLimit((value) => value + 100)}>
            再显示 100 个版本
          </button>
        )}
      </section>

      <section className="minecraft-boundary">
        <div>
          <ShieldCheck size={18} />
          <strong>浏览器运行范围</strong>
        </div>
        <p>
          所有公开 Java 版均可从官方源下载、校验和离线保存；当前仅 1.2.5 通过 CheerpJ + LWJGL
          浏览器运行验证，试玩限制 3 分钟。其他版本不会显示虚假的“可运行”状态。
        </p>
        <a
          className="button secondary compact"
          href={MINECRAFT_ENDPOINTS.bedrockStore}
          target="_blank"
          rel="noreferrer"
        >
          Bedrock 官方购买入口 <ExternalLink size={13} />
        </a>
      </section>
      {player && <MinecraftPlayer version={player} onClose={() => setPlayer(undefined)} />}
    </div>
  )
}
