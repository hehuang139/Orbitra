import {
  isGamePlatform,
  PLATFORM_REGISTRY,
  platformFromFilename,
  ROM_FILE_EXTENSIONS,
  type GamePlatform,
} from './platforms.ts'
import type { Game, SaveState } from './types.ts'
import { BUNDLED_CORE_ID, coreIdForPlatform } from './core-version.ts'
import { BACKUP_LIMITS, gameIdForRom, sha256, validateBackupData } from './backup-format.ts'
import type { BackupData, BackupGame } from './backup-format.ts'
import { sha256 as incrementalSha256 } from '@noble/hashes/sha256'

export type RomData = Uint8Array | Blob

const DATABASE_NAME = 'advance-gba'
const DATABASE_VERSION = 1
const STORES = { games: 'games', roms: 'roms', states: 'states', batteries: 'batteries' } as const

export interface LibraryChange {
  kind: 'content' | 'metadata'
  gameId?: string
}

function announceLibraryChange(kind: LibraryChange['kind'], gameId?: string): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<LibraryChange>('advance-library-changed', { detail: { kind, gameId } }),
    )
  }
}

function storageError(error: unknown): Error {
  if (error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)) return error
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  if (name === 'QuotaExceededError')
    return new Error('本地存储空间不足，请删除不需要的游戏或存档后重试。')
  if (name === 'AbortError') return new Error('本地游戏库操作已取消，请重试。')
  if (name === 'SecurityError' || name === 'InvalidStateError')
    return new Error('浏览器无法访问本地存储，请检查隐私设置或退出无痕模式后重试。')
  if (name === 'VersionError') return new Error('本地游戏库版本较新，请刷新页面或更新应用后重试。')
  return new Error('本地游戏库读写失败，请刷新页面后重试。', { cause: error })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持本地游戏库，请使用支持 IndexedDB 的现代浏览器。'))
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    } catch (error) {
      reject(storageError(error))
      return
    }
    let blocked = false
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORES.games))
        db.createObjectStore(STORES.games, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORES.roms))
        db.createObjectStore(STORES.roms, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORES.batteries))
        db.createObjectStore(STORES.batteries, { keyPath: 'gameId' })
      if (!db.objectStoreNames.contains(STORES.states)) {
        const states = db.createObjectStore(STORES.states, { keyPath: 'id' })
        states.createIndex('gameId', 'gameId', { unique: false })
      }
    }
    request.onblocked = () => {
      blocked = true
      reject(new Error('游戏库正在另一窗口中使用，请关闭旧版页面后重试。'))
    }
    request.onerror = () => reject(storageError(request.error))
    request.onsuccess = () => {
      const db = request.result
      if (blocked) {
        db.close()
        return
      }
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDatabase()
  let tx: IDBTransaction
  try {
    tx = db.transaction(stores, mode)
  } catch (error) {
    db.close()
    throw storageError(error)
  }
  let aborted = false
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => {
      aborted = true
      reject(tx.error ?? new Error('本地游戏库操作已取消，请重试。'))
    }
    tx.onerror = () => {
      /* onabort owns the final transaction error. */
    }
  })
  // Mark the rejection handled even if it arrives before an awaited request.
  void completion.catch(() => {})
  try {
    const result = await work(tx)
    await completion
    return result
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* The transaction may already have finished. */
    }
    await completion.catch(() => {})
    if (
      aborted &&
      error instanceof DOMException &&
      ['InvalidStateError', 'TransactionInactiveError'].includes(error.name)
    ) {
      throw new Error('本地游戏库操作已取消，请重试。')
    }
    throw storageError(error)
  } finally {
    db.close()
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024 && size % (1024 * 1024) === 0) return `${size / (1024 * 1024)} MiB`
  if (size >= 1024 && size % 1024 === 0) return `${size / 1024} KiB`
  return `${size} 字节`
}

function assertRomSize(platform: GamePlatform, size: number): void {
  const { label, minRomSize, maxRomSize } = PLATFORM_REGISTRY[platform]
  if (!Number.isInteger(size) || size < minRomSize || size > maxRomSize) {
    throw new Error(
      `ROM 大小无效，${label} 游戏文件应为 ${formatSize(minRomSize)}至 ${formatSize(maxRomSize)}。`,
    )
  }
}

function assertRomContent(platform: GamePlatform, bytes: Uint8Array): void {
  if (
    platform === 'nes' &&
    (bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a)
  ) {
    throw new Error('无法识别 FC / NES ROM：缺少有效的 iNES 或 NES 2.0 文件头。')
  }
  if (platform === 'snes' && bytes.byteLength % 0x8000 !== 0 && bytes.byteLength % 0x8000 !== 512) {
    throw new Error('无法识别 SFC / SNES ROM：文件大小不符合卡带映像或 512 字节头格式。')
  }
  if (
    platform === 'gamecube' &&
    (bytes[0x1c] !== 0xc2 || bytes[0x1d] !== 0x33 || bytes[0x1e] !== 0x9f || bytes[0x1f] !== 0x3d)
  ) {
    throw new Error('无法识别 GameCube 光盘镜像：缺少有效的光盘文件头。')
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function gameIdForFile(platform: GamePlatform, file: Blob): Promise<string> {
  const hash = incrementalSha256.create()
  const chunkSize = 4 * 1024 * 1024
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    hash.update(new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer()))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const contentDigest = hash.digest()
  const domain = new TextEncoder().encode(`advance-game-id:v1\0${platform}\0`)
  const identity = new Uint8Array(domain.length + contentDigest.length)
  identity.set(domain)
  identity.set(contentDigest, domain.length)
  return hex(incrementalSha256(identity))
}

function titleFromFilename(filename: string): string {
  return (
    filename
      .replace(/\.[^.]+$/i, '')
      .replace(/[_]+/g, ' ')
      .trim() || '未命名游戏'
  )
}

function decodeSnesTitle(bytes: Uint8Array): string | undefined {
  let end = bytes.length
  while (end && [0x00, 0x20, 0xff].includes(bytes[end - 1])) end -= 1
  if (end < 2) return undefined
  const value = bytes.subarray(0, end)
  if (value.some((byte) => byte < 0x20 || byte === 0x7f)) return undefined
  try {
    const title = new TextDecoder('shift_jis')
      .decode(value)
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!title || title.includes('\ufffd') || !/[\p{L}\p{N}]/u.test(title)) return undefined
    return title
  } catch {
    return undefined
  }
}

function snesTitle(bytes: Uint8Array): string | undefined {
  const base = bytes.byteLength % 0x8000 === 512 ? 512 : 0
  const candidates = [
    { offset: base + 0x7fc0, modes: [0x20, 0x22, 0x30, 0x32] },
    { offset: base + 0xffc0, modes: [0x21, 0x25, 0x31, 0x35] },
    { offset: base + 0x40ffc0, modes: [0x25, 0x35] },
  ]
  let best: { score: number; title: string } | undefined
  for (const candidate of candidates) {
    const { offset } = candidate
    if (offset + 0x40 > bytes.byteLength) continue
    const title = decodeSnesTitle(bytes.subarray(offset, offset + 21))
    if (!title) continue
    const mapMode = bytes[offset + 0x15] & 0x3f
    const complement = bytes[offset + 0x1c] | (bytes[offset + 0x1d] << 8)
    const checksum = bytes[offset + 0x1e] | (bytes[offset + 0x1f] << 8)
    const resetVector = bytes[offset + 0x3c] | (bytes[offset + 0x3d] << 8)
    const validChecksum =
      (checksum !== 0 || complement !== 0) &&
      (checksum !== 0xffff || complement !== 0xffff) &&
      ((checksum + complement) & 0xffff) === 0xffff
    const score =
      2 +
      (candidate.modes.includes(mapMode) ? 4 : 0) +
      (validChecksum ? 4 : 0) +
      (resetVector >= 0x8000 ? 2 : 0)
    if (score >= 8 && (!best || score > best.score)) best = { score, title }
  }
  return best?.title
}

function gameRecord(value: unknown): Game {
  if (!value || typeof value !== 'object') throw new Error('游戏信息已损坏，请删除后重新导入 ROM。')
  const game = value as Game
  const filenamePlatform =
    typeof game.filename === 'string' ? platformFromFilename(game.filename) : undefined
  // Version 1 records predate platform metadata and only contain GBA filenames.
  const platform = game.platform === undefined && filenamePlatform === 'gba' ? 'gba' : game.platform
  if (
    typeof game.id !== 'string' ||
    !game.id ||
    typeof game.title !== 'string' ||
    !game.title.trim() ||
    typeof game.filename !== 'string' ||
    !game.filename ||
    !isGamePlatform(platform) ||
    filenamePlatform !== platform ||
    !Number.isInteger(game.size) ||
    !isTimestamp(game.addedAt) ||
    (game.lastPlayed !== null && !isTimestamp(game.lastPlayed)) ||
    !isTimestamp(game.playTime) ||
    typeof game.favorite !== 'boolean' ||
    (game.color !== undefined && typeof game.color !== 'string') ||
    (game.skipAutoState !== undefined && typeof game.skipAutoState !== 'boolean')
  ) {
    throw new Error('游戏信息已损坏，请删除后重新导入 ROM。')
  }
  try {
    assertRomSize(platform, game.size)
  } catch {
    throw new Error('游戏信息已损坏，请删除后重新导入 ROM。')
  }
  return { ...game, platform }
}

function copyBytes(value: unknown, message: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error(message)
  return new Uint8Array(value)
}

function stateId(gameId: string, slot: number): string {
  if (!gameId || !Number.isSafeInteger(slot) || slot < 0)
    throw new Error('存档槽位无效，请选择有效的存档槽位。')
  return `${gameId}:${slot}`
}

function stateRecord(value: unknown): SaveState {
  if (!value || typeof value !== 'object') throw new Error('即时存档已损坏，请使用其他存档。')
  const state = value as SaveState
  if (
    typeof state.gameId !== 'string' ||
    !state.gameId ||
    !Number.isSafeInteger(state.slot) ||
    state.slot < 0 ||
    state.id !== `${state.gameId}:${state.slot}` ||
    !isTimestamp(state.createdAt) ||
    (state.screenshot !== undefined && typeof state.screenshot !== 'string') ||
    (state.coreVersion !== undefined &&
      (typeof state.coreVersion !== 'string' || !state.coreVersion))
  ) {
    throw new Error('即时存档已损坏，请使用其他存档。')
  }
  return { ...state, data: copyBytes(state.data, '即时存档已损坏，请使用其他存档。') }
}

async function requireGame(tx: IDBTransaction, id: string): Promise<Game> {
  const value = await requestResult(tx.objectStore(STORES.games).get(id))
  if (value === undefined) throw new Error('游戏不存在，请先导入 ROM。')
  return gameRecord(value)
}

export async function getGames(): Promise<Game[]> {
  return transaction([STORES.games], 'readonly', async (tx) => {
    const games = await requestResult(tx.objectStore(STORES.games).getAll())
    return games
      .map(gameRecord)
      .sort((a, b) => (b.lastPlayed ?? b.addedAt) - (a.lastPlayed ?? a.addedAt))
  })
}

export async function importGame(file: File): Promise<Game> {
  const platform = platformFromFilename(file.name)
  if (!platform) throw new Error(`请选择 ${ROM_FILE_EXTENSIONS.join('、')} 格式的游戏文件。`)
  assertRomSize(platform, file.size)
  let data: RomData
  let bytes: Uint8Array | undefined
  let id: string
  try {
    if (platform === 'gamecube') {
      const header = new Uint8Array(await file.slice(0, 0x40).arrayBuffer())
      assertRomContent(platform, header)
      id = await gameIdForFile(platform, file)
      data = file.slice(0, file.size, 'application/octet-stream')
    } else {
      bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength !== file.size) throw new Error('游戏文件读取不完整，请重新选择后重试。')
      assertRomContent(platform, bytes)
      id = await gameIdForRom(platform, bytes)
      data = bytes
    }
  } catch (error) {
    if (error instanceof Error && /无法识别|读取不完整/.test(error.message)) throw error
    throw new Error('无法读取游戏文件，请重新选择后重试。', { cause: error })
  }
  const suggestedTitle = titleFromFilename(file.name)
  const game = await transaction([STORES.games, STORES.roms], 'readwrite', async (tx) => {
    const existing = await requestResult(tx.objectStore(STORES.games).get(id))
    const game =
      existing === undefined
        ? ({
            id,
            title: suggestedTitle,
            filename: file.name,
            platform,
            size: file.size,
            addedAt: Date.now(),
            lastPlayed: null,
            playTime: 0,
            favorite: false,
          } satisfies Game)
        : (() => {
            const current = gameRecord(existing)
            const automaticTitles = new Set([
              titleFromFilename(current.filename),
              ...(current.platform === 'snes' && bytes ? [snesTitle(bytes)] : []),
            ])
            return {
              ...current,
              filename: file.name,
              title: automaticTitles.has(current.title) ? suggestedTitle : current.title,
            }
          })()
    // Reimporting deduplicates metadata while repairing any missing ROM bytes.
    await requestResult(tx.objectStore(STORES.roms).put({ id, data }))
    if (existing === undefined) await requestResult(tx.objectStore(STORES.games).add(game))
    else if (
      game.title !== gameRecord(existing).title ||
      game.filename !== gameRecord(existing).filename
    )
      await requestResult(tx.objectStore(STORES.games).put(game))
    return game
  })
  announceLibraryChange('content', game.id)
  return game
}

type GameChanges = Partial<
  Pick<Game, 'title' | 'lastPlayed' | 'playTime' | 'favorite' | 'color' | 'skipAutoState'>
>

export async function updateGame(id: string, changes: GameChanges): Promise<Game> {
  const game = await transaction([STORES.games], 'readwrite', async (tx) => {
    const current = await requireGame(tx, id)
    const updated = gameRecord({
      ...current,
      ...changes,
      id: current.id,
      filename: current.filename,
      platform: current.platform,
      size: current.size,
      addedAt: current.addedAt,
    })
    await requestResult(tx.objectStore(STORES.games).put(updated))
    return updated
  })
  announceLibraryChange('metadata', id)
  return game
}

export async function getRom(id: string): Promise<RomData | undefined> {
  return transaction([STORES.games, STORES.roms], 'readonly', async (tx) => {
    const record = await requestResult(tx.objectStore(STORES.roms).get(id))
    if (record === undefined) return undefined
    const game = await requireGame(tx, id)
    if (game.platform === 'gamecube') {
      if (!(record.data instanceof Blob) || record.data.size !== game.size)
        throw new Error('游戏 ROM 数据已损坏，请重新导入游戏。')
      return record.data.slice(0, record.data.size, 'application/octet-stream')
    }
    const bytes = copyBytes(record.data, '游戏 ROM 数据已损坏，请重新导入游戏。')
    if (bytes.byteLength !== game.size) throw new Error('游戏 ROM 数据已损坏，请重新导入游戏。')
    return bytes
  })
}

/** Cache a remotely restored ROM without marking saves or metadata as locally modified. */
export async function cacheRom(id: string, data: Uint8Array): Promise<Uint8Array> {
  const bytes = copyBytes(data, '下载的游戏 ROM 数据无效，请重试。')
  const game = await transaction([STORES.games], 'readonly', (tx) => requireGame(tx, id))
  if (game.platform === 'gamecube') throw new Error('GameCube 光盘镜像仅保存在导入它的浏览器中。')
  if (bytes.byteLength !== game.size || (await gameIdForRom(game.platform, bytes)) !== id)
    throw new Error('下载的游戏 ROM 与游戏清单不匹配。')
  await transaction([STORES.games, STORES.roms], 'readwrite', async (tx) => {
    const current = await requireGame(tx, id)
    if (current.platform !== game.platform || current.size !== bytes.byteLength)
      throw new Error('游戏清单已发生变化，请重新下载 ROM。')
    await requestResult(tx.objectStore(STORES.roms).put({ id, data: bytes }))
  })
  return new Uint8Array(bytes)
}

export async function deleteGame(id: string): Promise<void> {
  await transaction(Object.values(STORES), 'readwrite', async (tx) => {
    const stateKeys = await requestResult(
      tx.objectStore(STORES.states).index('gameId').getAllKeys(id),
    )
    await Promise.all([
      requestResult(tx.objectStore(STORES.games).delete(id)),
      requestResult(tx.objectStore(STORES.roms).delete(id)),
      requestResult(tx.objectStore(STORES.batteries).delete(id)),
      ...stateKeys.map((key) => requestResult(tx.objectStore(STORES.states).delete(key))),
    ])
  })
  announceLibraryChange('content', id)
}

export async function getStates(gameId: string): Promise<SaveState[]> {
  return transaction([STORES.states], 'readonly', async (tx) => {
    const states = await requestResult(tx.objectStore(STORES.states).index('gameId').getAll(gameId))
    return states.map(stateRecord).sort((a, b) => a.slot - b.slot)
  })
}

export async function getState(gameId: string, slot: number): Promise<SaveState | undefined> {
  const id = stateId(gameId, slot)
  return transaction([STORES.states], 'readonly', async (tx) => {
    const value = await requestResult(tx.objectStore(STORES.states).get(id))
    return value === undefined ? undefined : stateRecord(value)
  })
}

export async function saveState(
  gameId: string,
  slot: number,
  data: Uint8Array,
  screenshot?: string,
): Promise<SaveState> {
  const id = stateId(gameId, slot)
  const state = await transaction([STORES.games, STORES.states], 'readwrite', async (tx) => {
    const game = await requireGame(tx, gameId)
    const state = stateRecord({
      id,
      gameId,
      slot,
      data,
      screenshot,
      createdAt: Date.now(),
      coreVersion: coreIdForPlatform(game.platform),
    })
    await requestResult(tx.objectStore(STORES.states).put(state))
    if (slot === 0 && game.skipAutoState)
      await requestResult(tx.objectStore(STORES.games).put({ ...game, skipAutoState: false }))
    return state
  })
  announceLibraryChange('content', gameId)
  return state
}

export async function deleteState(gameId: string, slot: number): Promise<void> {
  const id = stateId(gameId, slot)
  await transaction([STORES.states], 'readwrite', async (tx) => {
    await requestResult(tx.objectStore(STORES.states).delete(id))
  })
  announceLibraryChange('content', gameId)
}

export async function getBatterySave(gameId: string): Promise<Uint8Array | undefined> {
  return transaction([STORES.batteries], 'readonly', async (tx) => {
    const record = await requestResult(tx.objectStore(STORES.batteries).get(gameId))
    return record === undefined
      ? undefined
      : copyBytes(record.data, '游戏电池存档已损坏，请导入备份存档。')
  })
}

/** Counts storage records without reading their state or battery byte buffers. */
export async function getStorageSummary(
  gameId: string,
): Promise<{ states: number; battery: boolean }> {
  return transaction([STORES.states, STORES.batteries], 'readonly', async (tx) => {
    const [states, batteryKey] = await Promise.all([
      requestResult(tx.objectStore(STORES.states).index('gameId').count(gameId)),
      requestResult(tx.objectStore(STORES.batteries).getKey(gameId)),
    ])
    return { states, battery: batteryKey !== undefined }
  })
}

export async function setBatterySave(gameId: string, data: Uint8Array): Promise<void> {
  const bytes = copyBytes(data, '电池存档为空或格式无效，请选择有效的 .sav 文件。')
  await transaction([STORES.games, STORES.batteries], 'readwrite', async (tx) => {
    await requireGame(tx, gameId)
    await requestResult(tx.objectStore(STORES.batteries).put({ gameId, data: bytes }))
  })
  announceLibraryChange('content', gameId)
}

export interface RestoreGameChoice {
  metadata: boolean
  battery: boolean
  slots: number[]
}

export interface RestoreChoices {
  /** The local library fingerprint returned by the most recent preview. */
  fingerprint: string
  /** Omitted games are not restored. Each field is an explicit selection. */
  games: Record<string, RestoreGameChoice>
}

export interface RestoreGamePreview {
  game: Game
  local?: Game
  missingRom: boolean
  battery: { available: boolean; conflict: boolean }
  states: {
    slot: number
    createdAt: number
    coreVersion?: string
    conflict: boolean
    incompatible: boolean
  }[]
  defaults: RestoreGameChoice
}

export interface RestorePreview {
  fingerprint: string
  games: RestoreGamePreview[]
  totalBytes: number
  stateCount: number
}

interface LibraryRecord {
  id: string
  game?: Game
  hasRom: boolean
  rom?: Uint8Array
  battery?: Uint8Array
  states: SaveState[]
}

/** All requests run in the caller's one transaction; no hashing or timers here. */
async function readLibrary(
  tx: IDBTransaction,
  gameIds?: string[],
  includeRoms = true,
): Promise<LibraryRecord[]> {
  const games = tx.objectStore(STORES.games)
  const ids = gameIds ?? (await requestResult(games.getAllKeys())).map(String)
  if (ids.length > BACKUP_LIMITS.games)
    throw new Error('一次备份或恢复最多选择 16 个游戏，请减少选择。')
  const ordered = [...ids].sort()
  const metadata = await Promise.all(ordered.map((id) => requestResult(games.get(id))))
  const parsed = metadata.map((game) => (game === undefined ? undefined : gameRecord(game)))
  if (
    includeRoms &&
    parsed.reduce((total, game) => total + (game?.size ?? 0), 0) > BACKUP_LIMITS.totalBytes
  ) {
    throw new Error('所选本地 ROM 总大小超过 64 MiB，请减少选择，或导出时不包含 ROM。')
  }
  if (includeRoms && parsed.some((game) => game?.platform === 'gamecube'))
    throw new Error('GameCube 光盘镜像不写入备份，请关闭“包含 ROM”后导出游戏信息与即时存档。')
  const records: LibraryRecord[] = []
  let totalBytes = 0
  for (let index = 0; index < ordered.length; index++) {
    const id = ordered[index]
    const [rawRom, rawBattery, rawStates] = await Promise.all([
      includeRoms
        ? requestResult(tx.objectStore(STORES.roms).get(id))
        : requestResult(tx.objectStore(STORES.roms).getKey(id)),
      requestResult(tx.objectStore(STORES.batteries).get(id)),
      requestResult(tx.objectStore(STORES.states).index('gameId').getAll(id)),
    ])
    const game = parsed[index]
    const hasRom = rawRom !== undefined
    const rom =
      !includeRoms || rawRom === undefined
        ? undefined
        : copyBytes(rawRom.data, '游戏 ROM 数据已损坏，请重新导入游戏。')
    const battery =
      rawBattery === undefined
        ? undefined
        : copyBytes(rawBattery.data, '游戏电池存档已损坏，请导入备份存档。')
    const states = rawStates.map(stateRecord).sort((a, b) => a.slot - b.slot)
    if ((!game && (hasRom || battery || states.length)) || (rom && rom.byteLength !== game?.size)) {
      throw new Error('游戏库的 ROM 或存档引用已损坏，请先修复游戏库。')
    }
    totalBytes +=
      (rom?.byteLength ?? 0) +
      (battery?.byteLength ?? 0) +
      states.reduce(
        (total, state) => total + state.data.byteLength + (state.screenshot?.length ?? 0) * 2,
        0,
      )
    if (totalBytes > BACKUP_LIMITS.totalBytes)
      throw new Error('所选本地 ROM 与存档总大小超过 64 MiB，请减少选择。')
    records.push({ id, game, hasRom, rom, battery, states })
  }
  return records
}

function readLibrarySnapshot(gameIds?: string[], includeRoms = true): Promise<LibraryRecord[]> {
  return transaction(Object.values(STORES), 'readonly', (tx) =>
    readLibrary(tx, gameIds, includeRoms),
  )
}

async function validateRomIdentities(games: { game?: Game; rom?: Uint8Array }[]): Promise<void> {
  for (const entry of games) {
    if (
      entry.rom &&
      (!entry.game || (await gameIdForRom(entry.game.platform, entry.rom)) !== entry.game.id)
    ) {
      throw new Error('ROM 内容标识与游戏平台不匹配，请提供同一平台的原始 ROM。')
    }
  }
}

function assertMatchingRestorePlatforms(entries: BackupGame[], records: LibraryRecord[]): void {
  const local = new Map(records.map((record) => [record.id, record.game]))
  for (const entry of entries) {
    const game = local.get(entry.game.id)
    if (game && game.platform !== entry.game.platform) {
      throw new Error('备份游戏平台与本地同内容标识游戏不一致，无法关联 ROM 或存档。')
    }
  }
}

async function prepareBackup(data: BackupData): Promise<BackupData> {
  validateBackupData(data)
  // Detach caller-owned buffers and choices before the first asynchronous step.
  const copy = structuredClone(data)
  validateBackupData(copy)
  await validateRomIdentities(copy.games)
  return copy
}

/** Export all four tables at one point in time. The caller first flushes live SRAM. */
export async function getLibrarySnapshot(
  gameIds?: string[],
  includeRoms = false,
): Promise<BackupData> {
  if (
    gameIds &&
    (new Set(gameIds).size !== gameIds.length ||
      gameIds.some((id) => typeof id !== 'string' || !id))
  ) {
    throw new Error('请选择有效且不重复的游戏。')
  }
  if (gameIds && gameIds.length > BACKUP_LIMITS.games)
    throw new Error('一次备份最多选择 16 个游戏，请减少选择。')
  const records = await readLibrarySnapshot(gameIds ? [...gameIds] : undefined, includeRoms)
  const games: BackupGame[] = records.map((record) => {
    if (!record.game) throw new Error('所选游戏已不存在，请刷新游戏库后重试。')
    if (includeRoms && !record.hasRom)
      throw new Error('游戏 ROM 尚未下载，请先启动游戏或重新导入后再备份。')
    return {
      game: record.game,
      ...(includeRoms ? { rom: record.rom } : {}),
      ...(record.battery ? { battery: record.battery } : {}),
      states: record.states,
    }
  })
  const data: BackupData = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    coreVersion: BUNDLED_CORE_ID,
    games,
  }
  validateBackupData(data)
  await validateRomIdentities(records)
  return data
}

function gameMetadata(game?: Game): unknown {
  return (
    game && [
      game.id,
      game.title,
      game.filename,
      game.platform,
      game.size,
      game.addedAt,
      game.lastPlayed,
      game.playTime,
      game.favorite,
      game.color,
      game.skipAutoState === true,
    ]
  )
}

function stateMetadata(state: SaveState): unknown {
  return [state.id, state.gameId, state.slot, state.createdAt, state.screenshot, state.coreVersion]
}

async function libraryFingerprint(records: LibraryRecord[]): Promise<string> {
  const summaries = []
  for (const record of records) {
    const states = []
    for (const state of record.states) states.push([stateMetadata(state), await sha256(state.data)])
    summaries.push([
      record.id,
      gameMetadata(record.game),
      record.hasRom,
      record.rom ? await sha256(record.rom) : null,
      record.battery ? await sha256(record.battery) : null,
      states,
    ])
  }
  return sha256(new TextEncoder().encode(JSON.stringify(summaries)))
}

function equalBytes(a?: Uint8Array, b?: Uint8Array): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index])
}

/** Synchronous comparison inside the write transaction closes the preflight race. */
function sameLibrary(a: LibraryRecord[], b: LibraryRecord[]): boolean {
  return (
    a.length === b.length &&
    a.every((record, index) => {
      const other = b[index]
      return (
        record.id === other.id &&
        record.hasRom === other.hasRom &&
        JSON.stringify(gameMetadata(record.game)) === JSON.stringify(gameMetadata(other.game)) &&
        equalBytes(record.rom, other.rom) &&
        equalBytes(record.battery, other.battery) &&
        record.states.length === other.states.length &&
        record.states.every(
          (state, stateIndex) =>
            JSON.stringify(stateMetadata(state)) ===
              JSON.stringify(stateMetadata(other.states[stateIndex])) &&
            equalBytes(state.data, other.states[stateIndex].data),
        )
      )
    })
  )
}

/** Parses and hashes in memory and opens only a read transaction; cancel is zero-write. */
export async function previewRestore(data: BackupData): Promise<RestorePreview> {
  const prepared = await prepareBackup(data)
  const records = await readLibrarySnapshot(prepared.games.map((entry) => entry.game.id))
  assertMatchingRestorePlatforms(prepared.games, records)
  await validateRomIdentities(records)
  const local = new Map(records.map((record) => [record.id, record]))
  let totalBytes = 0
  let stateCount = 0
  const games = prepared.games.map((entry) => {
    const current = local.get(entry.game.id)!
    const states = entry.states.map((state) => ({
      slot: state.slot,
      createdAt: state.createdAt,
      coreVersion: state.coreVersion,
      conflict: current.states.some((item) => item.slot === state.slot),
      incompatible: state.coreVersion !== coreIdForPlatform(entry.game.platform),
    }))
    totalBytes +=
      (entry.rom?.byteLength ?? 0) +
      (entry.battery?.byteLength ?? 0) +
      new TextEncoder().encode(JSON.stringify(entry.game)).byteLength +
      entry.states.reduce(
        (sum, state) =>
          sum + state.data.byteLength + new TextEncoder().encode(state.screenshot ?? '').byteLength,
        0,
      )
    stateCount += states.length
    return {
      game: entry.game,
      local: current.game,
      missingRom: !entry.rom && !current.rom,
      battery: {
        available: Boolean(entry.battery),
        conflict: Boolean(entry.battery && current.battery),
      },
      states,
      defaults: {
        metadata: !current.game,
        battery: Boolean(entry.battery && !current.battery),
        slots: states
          .filter((state) => !state.conflict && !state.incompatible)
          .map((state) => state.slot),
      },
    }
  })
  return { fingerprint: await libraryFingerprint(records), games, totalBytes, stateCount }
}

/** Apply explicit choices atomically after all validation and hashing has finished. */
export async function restoreLibrary(data: BackupData, choices: RestoreChoices): Promise<void> {
  const selected = structuredClone(choices)
  if (
    !selected ||
    typeof selected.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(selected.fingerprint) ||
    !selected.games ||
    typeof selected.games !== 'object' ||
    Array.isArray(selected.games)
  ) {
    throw new Error('恢复选择无效，请重新预览备份。')
  }
  const prepared = await prepareBackup(data)
  const ids = prepared.games.map((entry) => entry.game.id)
  if (Object.keys(selected.games).some((id) => !ids.includes(id)))
    throw new Error('恢复选择包含未知游戏，请重新预览。')
  const records = await readLibrarySnapshot(ids)
  assertMatchingRestorePlatforms(prepared.games, records)
  await validateRomIdentities(records)
  if ((await libraryFingerprint(records)) !== selected.fingerprint)
    throw new Error('游戏库在预览后已发生变化，请重新预览再恢复。')
  const local = new Map(records.map((record) => [record.id, record]))
  const writes: { entry: BackupGame; choice: RestoreGameChoice }[] = []
  for (const entry of prepared.games) {
    const choice = selected.games[entry.game.id]
    if (choice === undefined) continue
    if (
      !choice ||
      typeof choice.metadata !== 'boolean' ||
      typeof choice.battery !== 'boolean' ||
      !Array.isArray(choice.slots) ||
      new Set(choice.slots).size !== choice.slots.length ||
      choice.slots.some(
        (slot) => !Number.isSafeInteger(slot) || !entry.states.some((state) => state.slot === slot),
      ) ||
      (choice.battery && !entry.battery)
    ) {
      throw new Error('恢复选择包含无效的存档或槽位，请重新预览。')
    }
    if (!choice.metadata && !choice.battery && !choice.slots.length) continue
    const current = local.get(entry.game.id)!
    if (!current.game && !choice.metadata)
      throw new Error('新游戏需要同时恢复游戏信息，才能关联存档。')
    writes.push({ entry, choice })
  }
  if (!writes.length) return
  await transaction(Object.values(STORES), 'readwrite', async (tx) => {
    const current = await readLibrary(tx, ids)
    assertMatchingRestorePlatforms(prepared.games, current)
    if (!sameLibrary(records, current))
      throw new Error('游戏库在预览后已发生变化，请重新预览再恢复。')
    for (const { entry, choice } of writes) {
      const id = entry.game.id
      let game = choice.metadata ? entry.game : local.get(id)!.game!
      if (choice.battery && !choice.slots.includes(0)) game = { ...game, skipAutoState: true }
      else if (choice.slots.includes(0) && !choice.metadata)
        game = { ...game, skipAutoState: false }
      if (choice.metadata || choice.battery || choice.slots.includes(0))
        await requestResult(tx.objectStore(STORES.games).put(game))
      // An existing same-content ROM is retained; a supplied ROM repairs a missing one.
      if (!local.get(id)!.rom && entry.rom)
        await requestResult(tx.objectStore(STORES.roms).put({ id, data: entry.rom }))
      if (choice.battery)
        await requestResult(
          tx.objectStore(STORES.batteries).put({ gameId: id, data: entry.battery }),
        )
      for (const state of entry.states) {
        if (choice.slots.includes(state.slot))
          await requestResult(tx.objectStore(STORES.states).put(state))
      }
    }
  })
  announceLibraryChange('content')
}
