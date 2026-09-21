import { useEffect, useId, useRef, useState } from 'react'
import { Download, HardDrive, LoaderCircle, RefreshCw, Trash2, Upload } from 'lucide-react'
import { BACKUP_LIMITS, gameIdForRom, parseBackup } from '../lib/backup-format'
import type { BackupData } from '../lib/backup-format'
import { BUNDLED_CORE_ID } from '../lib/core-version'
import * as db from '../lib/storage'
import type { RestoreChoices, RestorePreview } from '../lib/storage'
import type { Game } from '../lib/types'
import { PLATFORM_REGISTRY, platformFromFilename } from '../lib/platforms'
import { automaticSlotLabel, isAutomaticSlot } from '../lib/autosave'
import './backup-manager.css'

interface BackupManagerProps {
  games: Game[]
  onExport: (
    ids: string[],
    includeRoms: boolean,
    onProgress: (message: string) => void,
  ) => Promise<void>
  onRestore: (data: BackupData, choices: RestoreChoices) => Promise<void>
  onDelete: (game: Game) => void
  onBusyChange: (busy: boolean) => void
}

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 * 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
const formatDate = (date: string | number) => new Date(date).toLocaleString('zh-CN')
const coreLabel = (core?: string) => {
  if (!core) return '未知核心版本'
  const [version, digest] = core.split(':')
  return digest ? `${version} · ${digest.slice(0, 8)}` : version
}
const defaultChoices = (preview: RestorePreview): RestoreChoices => ({
  fingerprint: preview.fingerprint,
  games: Object.fromEntries(
    preview.games.map((entry) => [
      entry.game.id,
      entry.missingRom
        ? { metadata: false, battery: false, slots: [] }
        : { ...entry.defaults, slots: [...entry.defaults.slots] },
    ]),
  ),
})

export function BackupManager({
  games,
  onExport,
  onRestore,
  onDelete,
  onBusyChange,
}: BackupManagerProps) {
  const id = useId()
  const [selected, setSelected] = useState<string[]>(() => games.map((game) => game.id))
  const [includeRoms, setIncludeRoms] = useState(false)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const feedback = useRef<HTMLDivElement>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [data, setData] = useState<BackupData | null>(null)
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [choices, setChoices] = useState<RestoreChoices | null>(null)
  const [fileName, setFileName] = useState('')
  const [storageStats, setStorageStats] = useState<
    Record<string, { states: number; battery: boolean }>
  >({})
  const [storageLoading, setStorageLoading] = useState(true)
  const [storageError, setStorageError] = useState('')
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null)
  const [storageRevision, setStorageRevision] = useState(0)

  useEffect(() => {
    setSelected((previous) => previous.filter((gameId) => games.some((game) => game.id === gameId)))
    let cancelled = false
    setStorageLoading(true)
    setStorageError('')
    void Promise.allSettled(
      games.map(async (game) => {
        const summary = await db.getStorageSummary(game.id)
        return [game.id, summary] as const
      }),
    ).then((results) => {
      if (cancelled) return
      setStorageStats(
        Object.fromEntries(
          results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
        ),
      )
      if (results.some((result) => result.status === 'rejected'))
        setStorageError('部分存档数量读取失败，请刷新存储信息后重试。')
      setStorageLoading(false)
    })
    void Promise.resolve()
      .then(() => navigator.storage?.estimate?.() ?? null)
      .then(
        (value) => {
          if (!cancelled) setEstimate(value)
        },
        () => {
          if (!cancelled) setEstimate(null)
        },
      )
    return () => {
      cancelled = true
    }
  }, [games, storageRevision])

  async function run(action: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(false)
    onBusyChange(true)
    try {
      await action()
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : '操作失败，请重试。')
      feedback.current?.focus()
    } finally {
      locked.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }

  async function readBackup(file: File) {
    await run(async () => {
      setPreview(null)
      setData(null)
      setChoices(null)
      setMessage('正在读取并校验备份…')
      const parsed = await parseBackup(file, { onProgress: setMessage })
      setMessage('正在检查本地游戏库与冲突…')
      const next = await db.previewRestore(parsed)
      setData(parsed)
      setPreview(next)
      setChoices(defaultChoices(next))
      setFileName(file.name)
      setMessage('备份已校验，请检查恢复项目。确认恢复前不会写入游戏库。')
    })
  }

  async function matchRom(file: File, gameId: string) {
    if (!data || !choices) return
    await run(async () => {
      const entry = data.games.find((item) => item.game.id === gameId)
      if (!entry) throw new Error('备份中找不到该游戏，请重新选择备份。')
      setMessage(`正在校验 ${entry.game.title} 的 ROM…`)
      const platform = PLATFORM_REGISTRY[entry.game.platform]
      if (platformFromFilename(file.name) !== entry.game.platform)
        throw new Error(`请选择 ${platform.extensions.join(' / ')} 格式的 ROM 文件。`)
      if (file.size !== entry.game.size)
        throw new Error('ROM 大小与备份不一致，请选择对应的原始游戏文件。')
      if (!globalThis.crypto?.subtle)
        throw new Error('浏览器无法校验 ROM，请使用 HTTPS 或 localhost 打开应用。')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (
        (await gameIdForRom(entry.game.platform, bytes)) !== gameId ||
        bytes.byteLength !== entry.game.size
      )
        throw new Error('ROM 的平台内容标识与备份不一致，未添加此文件。')
      const updated: BackupData = {
        ...data,
        games: data.games.map((item) => (item.game.id === gameId ? { ...item, rom: bytes } : item)),
      }
      const next = await db.previewRestore(updated)
      const nextChoices = defaultChoices(next)
      for (const item of next.games) {
        if (item.game.id !== gameId && choices.games[item.game.id])
          nextChoices.games[item.game.id] = choices.games[item.game.id]
      }
      setData(updated)
      setPreview(next)
      setChoices(nextChoices)
      setMessage(`${entry.game.title} 的 ROM 校验通过，已加入恢复预览，尚未写入游戏库。`)
    })
  }

  function changeChoice(gameId: string, patch: Partial<RestoreChoices['games'][string]>) {
    setChoices((previous) =>
      previous
        ? {
            ...previous,
            games: { ...previous.games, [gameId]: { ...previous.games[gameId], ...patch } },
          }
        : previous,
    )
  }

  const selectedItemCount = choices
    ? Object.values(choices.games).reduce(
        (count, choice) =>
          count + Number(choice.metadata) + Number(choice.battery) + choice.slots.length,
        0,
      )
    : 0
  const hasSelectedMissingRom = Boolean(
    preview?.games.some((entry) => {
      const choice = choices?.games[entry.game.id]
      return (
        entry.missingRom && choice && (choice.metadata || choice.battery || choice.slots.length)
      )
    }),
  )
  const selectedRomBytes = games
    .filter((game) => selected.includes(game.id))
    .reduce((sum, game) => sum + game.size, 0)
  const knownUsage = typeof estimate?.usage === 'number' && Number.isFinite(estimate.usage)
  const knownQuota = typeof estimate?.quota === 'number' && Number.isFinite(estimate.quota)

  return (
    <div className="backup-manager" aria-busy={busy}>
      <div
        ref={feedback}
        className={`backup-feedback${error ? ' is-error' : ''}`}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {busy ? <LoaderCircle size={16} className="backup-spinner" aria-hidden="true" /> : null}
        <span>{message || '备份包含游戏信息、电池存档与即时存档。请妥善保存下载的文件。'}</span>
      </div>
      <fieldset className="backup-controls" disabled={busy}>
        <legend className="sr-only">备份、恢复与存储整理</legend>
        <section className="backup-section" aria-labelledby={`${id}-export-title`}>
          <h3 id={`${id}-export-title`}>
            <Download size={17} aria-hidden="true" />
            导出备份
          </h3>
          <div className="backup-selection-heading">
            <span>
              选择游戏（已选 {selected.length} / {games.length}）
            </span>
            <div className="backup-inline-actions">
              <button
                type="button"
                className="text-button"
                disabled={!games.length}
                onClick={() => setSelected(games.map((game) => game.id))}
              >
                全选游戏
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!selected.length}
                onClick={() => setSelected([])}
              >
                清空选择
              </button>
            </div>
          </div>
          <div className="backup-game-selection">
            {games.length ? (
              games.map((game) => (
                <label className="backup-check" key={game.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(game.id)}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, game.id]
                          : previous.filter((gameId) => gameId !== game.id),
                      )
                    }
                  />
                  <span>
                    <strong>{game.title}</strong>
                    <small>
                      {game.filename} · {formatSize(game.size)}
                    </small>
                  </span>
                </label>
              ))
            ) : (
              <p className="backup-hint">游戏库为空。导入游戏后即可导出备份。</p>
            )}
          </div>
          <label className="backup-check backup-rom-option">
            <input
              type="checkbox"
              checked={includeRoms}
              onChange={(event) => setIncludeRoms(event.target.checked)}
            />
            <span>
              <strong>在备份中包含 ROM</strong>
              <small>
                默认只备份游戏信息和存档。包含 ROM 会额外占用约 {formatSize(selectedRomBytes)}。
              </small>
            </span>
          </label>
          <p className="backup-hint">
            单份备份最多 {BACKUP_LIMITS.games} 个游戏、{formatSize(BACKUP_LIMITS.totalBytes)} 关联
            ROM、存档与清单。省略 ROM 也计入此分批限制，较大的游戏库请减少选择后导出。
          </p>
          {selected.length > BACKUP_LIMITS.games ? (
            <p className="backup-hint backup-warning">已超过单份备份的游戏数量上限，请减少选择。</p>
          ) : null}
          <button
            type="button"
            className="button primary"
            disabled={!selected.length || selected.length > BACKUP_LIMITS.games}
            onClick={() =>
              void run(async () => {
                setMessage('正在准备备份…')
                await onExport(selected, includeRoms, setMessage)
                setMessage('备份已生成并开始下载，请保留下载文件。')
              })
            }
          >
            <Download size={15} aria-hidden="true" />
            导出所选游戏备份
          </button>
        </section>

        <section className="backup-section" aria-labelledby={`${id}-restore-title`}>
          <h3 id={`${id}-restore-title`}>
            <Upload size={17} aria-hidden="true" />
            恢复备份
          </h3>
          <p className="backup-hint">
            选择本应用导出的备份
            ZIP。已有游戏信息、电池存档与同名槽位默认保留本地内容；需覆盖时逐项勾选。
          </p>
          <label className="backup-file-label" htmlFor={`${id}-file`}>
            选择备份文件
          </label>
          <input
            id={`${id}-file`}
            className="backup-file-input"
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void readBackup(file)
            }}
          />
          {preview && data && choices ? (
            <div className="backup-preview">
              <div className="backup-preview-heading">
                <h4>恢复预览</h4>
                <span>{fileName}</span>
              </div>
              <dl className="backup-summary">
                <div>
                  <dt>备份时间</dt>
                  <dd>{formatDate(data.exportedAt)}</dd>
                </div>
                <div>
                  <dt>内容</dt>
                  <dd>
                    {preview.games.length} 个游戏 · {preview.stateCount} 个即时存档
                  </dd>
                </div>
                <div>
                  <dt>数据大小</dt>
                  <dd>{formatSize(preview.totalBytes)}</dd>
                </div>
                <div>
                  <dt>备份核心</dt>
                  <dd title={data.coreVersion}>{coreLabel(data.coreVersion)}</dd>
                </div>
                <div>
                  <dt>当前核心</dt>
                  <dd title={BUNDLED_CORE_ID}>{coreLabel(BUNDLED_CORE_ID)}</dd>
                </div>
              </dl>
              <p className="backup-hint">
                核心版本不同或未知的即时存档默认跳过。选中恢复仅保存这些存档，并不保证能够载入。电池存档不受核心版本限制。
              </p>
              {preview.games.map((entry) => {
                const choice = choices.games[entry.game.id]
                const disabledSaves = entry.missingRom || (!entry.local && !choice.metadata)
                return (
                  <fieldset className="backup-restore-game" key={entry.game.id}>
                    <legend>{entry.game.title}</legend>
                    <p className="backup-hint">
                      {entry.local ? '本地已有此游戏' : '新游戏'} · ROM{' '}
                      {formatSize(entry.game.size)} · {entry.states.length} 个即时存档
                    </p>
                    <details className="backup-identity">
                      <summary>查看 ROM 标识与文件名</summary>
                      <p>{entry.game.filename}</p>
                      <code>内容 ID: {entry.game.id}</code>
                    </details>
                    {entry.missingRom ? (
                      <div className="backup-missing-rom">
                        <p>
                          缺少匹配的 ROM，此游戏默认跳过，可先恢复其他游戏。请选择原始{' '}
                          {PLATFORM_REGISTRY[entry.game.platform].extensions.join(' / ')}{' '}
                          文件，校验通过后才能恢复此游戏。
                        </p>
                        <label className="backup-file-label" htmlFor={`${id}-rom-${entry.game.id}`}>
                          为 {entry.game.title} 选择匹配 ROM
                        </label>
                        <input
                          id={`${id}-rom-${entry.game.id}`}
                          className="backup-file-input"
                          type="file"
                          accept={PLATFORM_REGISTRY[entry.game.platform].extensions.join(',')}
                          onChange={(event) => {
                            const file = event.target.files?.[0]
                            event.target.value = ''
                            if (file) void matchRom(file, entry.game.id)
                          }}
                        />
                      </div>
                    ) : null}
                    <label className="backup-check">
                      <input
                        type="checkbox"
                        disabled={entry.missingRom}
                        checked={choice.metadata}
                        onChange={(event) =>
                          changeChoice(
                            entry.game.id,
                            !entry.local && !event.target.checked
                              ? { metadata: false, battery: false, slots: [] }
                              : { metadata: event.target.checked },
                          )
                        }
                      />
                      <span>
                        <strong>{entry.local ? '覆盖游戏信息' : '恢复游戏信息'}</strong>
                        <small>
                          {entry.local
                            ? '已有本地信息；默认保留。勾选后替换标题、收藏、游玩时长等信息。'
                            : '创建游戏记录；恢复该游戏的存档需要同时选择此项。'}
                        </small>
                      </span>
                    </label>
                    {entry.battery.available ? (
                      <label className="backup-check">
                        <input
                          type="checkbox"
                          disabled={disabledSaves}
                          checked={choice.battery}
                          onChange={(event) =>
                            changeChoice(entry.game.id, { battery: event.target.checked })
                          }
                        />
                        <span>
                          <strong>恢复电池存档</strong>
                          <small>
                            {entry.battery.conflict
                              ? '与本地电池存档冲突；勾选将覆盖本地内容。'
                              : '本地没有电池存档。'}
                          </small>
                          <small>
                            未恢复任何自动存档时，下次从电池进度启动，保留的自动档仍可手动读取。
                          </small>
                        </span>
                      </label>
                    ) : (
                      <p className="backup-hint">备份中没有电池存档。</p>
                    )}
                    {entry.states.map((state) => (
                      <label className="backup-check" key={state.slot}>
                        <input
                          type="checkbox"
                          disabled={disabledSaves}
                          checked={choice.slots.includes(state.slot)}
                          onChange={(event) =>
                            changeChoice(entry.game.id, {
                              slots: event.target.checked
                                ? [...choice.slots, state.slot]
                                : choice.slots.filter((slot) => slot !== state.slot),
                            })
                          }
                        />
                        <span>
                          <strong>
                            恢复即时存档 ·{' '}
                            {isAutomaticSlot(state.slot)
                              ? automaticSlotLabel(state.slot)
                              : `槽位 ${state.slot}`}
                          </strong>
                          <small>
                            {formatDate(state.createdAt)} ·{' '}
                            <span title={state.coreVersion}>{coreLabel(state.coreVersion)}</span>
                          </small>
                          {state.conflict ? (
                            <small className="backup-warning">
                              与本地槽位冲突；勾选将覆盖本地内容。
                            </small>
                          ) : null}
                          {state.incompatible ? (
                            <small className="backup-warning">
                              核心版本不同或未知，默认跳过；可能无法载入。
                            </small>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )
              })}
              <div className="backup-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={!selectedItemCount || hasSelectedMissingRom}
                  onClick={() =>
                    void run(async () => {
                      setMessage('正在恢复已选择的项目…')
                      await onRestore(data, choices)
                      setPreview(null)
                      setData(null)
                      setChoices(null)
                      setStorageRevision((value) => value + 1)
                      setMessage('恢复完成。所选内容已保存到本地游戏库。')
                    })
                  }
                >
                  确认恢复 {selectedItemCount} 项
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setPreview(null)
                    setData(null)
                    setChoices(null)
                    setError(false)
                    setMessage('已取消恢复，备份内容未写入游戏库。')
                  }}
                >
                  取消恢复
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    void run(async () => {
                      setMessage('正在刷新恢复预览…')
                      const next = await db.previewRestore(data)
                      setPreview(next)
                      setChoices(defaultChoices(next))
                      setMessage('恢复预览已刷新，选择已重置为保留本地内容，请重新检查。')
                    })
                  }
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  刷新恢复预览
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="backup-section" aria-labelledby={`${id}-storage-title`}>
          <h3 id={`${id}-storage-title`}>
            <HardDrive size={17} aria-hidden="true" />
            存储整理
          </h3>
          <p className="backup-hint">
            此站点已用 {knownUsage ? formatSize(estimate!.usage!) : '未知'} / 配额{' '}
            {knownQuota ? formatSize(estimate!.quota!) : '未知'}
            。浏览器提供的估算可能包含离线缓存；无法估算时仍可正常管理游戏。
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => setStorageRevision((value) => value + 1)}
          >
            <RefreshCw size={13} aria-hidden="true" />
            刷新存储信息
          </button>
          {storageError ? (
            <p className="backup-feedback is-error" role="status">
              {storageError}
            </p>
          ) : null}
          <div className="backup-storage-list">
            {games.map((game) => (
              <div className="backup-storage-row" key={game.id}>
                <div>
                  <strong>{game.title}</strong>
                  <p>
                    ROM {formatSize(game.size)} ·{' '}
                    {storageStats[game.id]
                      ? `${storageStats[game.id].states} 个即时存档 · ${storageStats[game.id].battery ? '有' : '无'}电池存档`
                      : storageLoading
                        ? '正在读取存档数量…'
                        : '存档数量未知'}
                  </p>
                </div>
                <button
                  type="button"
                  className="button danger"
                  aria-label={`删除 ${game.title} 及其存档`}
                  onClick={() => onDelete(game)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  删除
                </button>
              </div>
            ))}
            {!games.length ? <p className="backup-hint">游戏库为空。</p> : null}
          </div>
          <p className="backup-hint">
            删除游戏会同时删除 ROM、电池存档和即时存档。建议先导出备份，点击删除后会再次确认。
          </p>
        </section>
      </fieldset>
    </div>
  )
}
