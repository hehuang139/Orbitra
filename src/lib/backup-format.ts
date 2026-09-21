import { Inflate, zip } from 'fflate'
import type { Game, SaveState } from './types.ts'
import { validateCheats } from './cheats.ts'
import {
  isGamePlatform,
  PLATFORM_REGISTRY,
  platformFromFilename,
  ROM_FILE_EXTENSIONS,
} from './platforms.ts'
import type { GamePlatform } from './platforms.ts'

const MiB = 1024 * 1024
/** Conservative in-memory limits; real low-memory devices still need release validation. */
export const BACKUP_LIMITS = {
  archiveBytes: 72 * MiB,
  totalBytes: 64 * MiB,
  romBytes: 32 * MiB,
  stateBytes: 16 * MiB,
  batteryBytes: MiB,
  manifestBytes: 2 * MiB,
  screenshotCharacters: 256 * 1024,
  games: 16,
  files: 161,
} as const

export interface BackupGame {
  game: Game
  rom?: Uint8Array
  battery?: Uint8Array
  states: SaveState[]
}

export interface BackupData {
  formatVersion: 1
  exportedAt: string
  coreVersion: string
  games: BackupGame[]
}

export interface BackupProgressOptions {
  onProgress?: (message: string) => void
}

interface ManifestFile {
  path: string
  size: number
  sha256: string
}

interface ManifestGame {
  game: Game
  rom?: string
  battery?: string
  states: (Omit<SaveState, 'data'> & { path: string })[]
}

interface Manifest {
  format: 'advance-gba-backup'
  formatVersion: 1
  exportedAt: string
  coreVersion: string
  games: ManifestGame[]
  files: ManifestFile[]
}

const HASH = /^[0-9a-f]{64}$/
const ZIP_ERROR = '备份 ZIP 已损坏或包含无效边界，请重新选择完整备份。'
const FORMAT_ERROR = '备份清单或游戏信息无效，请重新导出备份。'
const WORKING_SET_ERROR = '关联 ROM 与存档超过 64 MiB，请减少所选游戏后分批备份。'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const ROM_PAYLOAD_NAMES = new Set(ROM_FILE_EXTENSIONS.map((extension) => `rom${extension}`))

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function safeName(value: unknown): value is string {
  return text(value, 255) && !/[\\/:]/.test(value) && value !== '.' && value !== '..'
}

function checkVersion(value: unknown): void {
  if (value !== 1)
    throw new Error(
      `不支持备份格式版本 ${String(value).slice(0, 32)}；当前仅支持版本 1，未写入游戏库。`,
    )
}

function checkHeader(value: Record<string, unknown>): void {
  checkVersion(value.formatVersion)
  if (
    typeof value.exportedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.exportedAt) ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    new Date(value.exportedAt).toISOString() !== value.exportedAt ||
    !text(value.coreVersion, 128) ||
    !Array.isArray(value.games) ||
    value.games.length < 1 ||
    value.games.length > BACKUP_LIMITS.games
  )
    throw new Error(`备份清单无效；每个备份须包含 1 至 ${BACKUP_LIMITS.games} 个游戏。`)
}

function normalizeGame(value: unknown, allowLegacy = false): Game {
  const raw = object(value) ? value : null
  const filenamePlatform = raw ? platformFromFilename(String(raw.filename ?? '')) : undefined
  const platform =
    raw?.platform === undefined && allowLegacy && filenamePlatform === 'gba' ? 'gba' : raw?.platform
  if (
    !raw ||
    typeof raw.id !== 'string' ||
    !HASH.test(raw.id) ||
    !text(raw.title, 512) ||
    !safeName(raw.filename) ||
    !isGamePlatform(platform) ||
    filenamePlatform !== platform ||
    !Number.isInteger(raw.size) ||
    Number(raw.size) < PLATFORM_REGISTRY[platform].minRomSize ||
    Number(raw.size) > PLATFORM_REGISTRY[platform].maxRomSize ||
    !finite(raw.addedAt) ||
    (raw.lastPlayed !== null && !finite(raw.lastPlayed)) ||
    !finite(raw.playTime) ||
    typeof raw.favorite !== 'boolean' ||
    (raw.skipAutoState !== undefined && typeof raw.skipAutoState !== 'boolean') ||
    (raw.launchMode !== undefined &&
      !['auto', 'fresh', 'state'].includes(String(raw.launchMode))) ||
    (raw.launchStateSlot !== undefined &&
      (!Number.isInteger(raw.launchStateSlot) ||
        Number(raw.launchStateSlot) < 0 ||
        Number(raw.launchStateSlot) > 7)) ||
    (raw.color !== undefined && (!text(raw.color, 64) || !/^#[0-9a-f]{3,8}$/i.test(raw.color)))
  )
    throw new Error(FORMAT_ERROR)
  try {
    const cheats = validateCheats(raw.cheats)
    const game = { ...raw }
    delete game.resumeAutoSaveSlot
    return {
      ...(game as unknown as Game),
      platform,
      ...(raw.cheats === undefined ? {} : { cheats }),
    }
  } catch {
    throw new Error(FORMAT_ERROR)
  }
}

function checkGame(value: unknown): asserts value is Game {
  normalizeGame(value)
}

function romPayloadPath(game: Game): string {
  return `games/${game.id}/rom${PLATFORM_REGISTRY[game.platform].extensions[0]}`
}

function isRomPayloadPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return ROM_PAYLOAD_NAMES.has(name)
}

function checkState(value: unknown, gameId: string): asserts value is SaveState {
  if (
    !object(value) ||
    !Number.isInteger(value.slot) ||
    Number(value.slot) < 0 ||
    Number(value.slot) > 7 ||
    value.gameId !== gameId ||
    value.id !== `${gameId}:${value.slot}` ||
    !finite(value.createdAt) ||
    (value.coreVersion !== undefined && !text(value.coreVersion, 128))
  )
    throw new Error('备份即时存档信息无效；槽位仅支持 0 至 7。')
  if (
    value.screenshot !== undefined &&
    (typeof value.screenshot !== 'string' ||
      value.screenshot.length > BACKUP_LIMITS.screenshotCharacters ||
      !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value.screenshot))
  ) {
    throw new Error('备份截图无效；仅支持不超过 256 KiB 的 PNG data URL。')
  }
}

function byteLength(value: unknown, max: number, label: string): number {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > max) {
    throw new Error(`${label}大小无效或超出单项限制（最大 ${max / MiB} MiB）。`)
  }
  return value.byteLength
}

/**
 * Synchronous structural validation; create/parse additionally verify ROM content hashes.
 * Format v1 limits the restore working set: every game.size (even omitted ROMs), saves,
 * and manifest together must fit 64 MiB, so every exported backup can reach restore preview.
 */
export function validateBackupData(data: BackupData): void {
  if (!object(data)) throw new Error(FORMAT_ERROR)
  checkHeader(data)
  let total = 0
  const ids = new Set<string>()
  for (const entry of data.games) {
    if (!object(entry)) throw new Error(FORMAT_ERROR)
    checkGame(entry.game)
    total += entry.game.size
    if (ids.has(entry.game.id)) throw new Error('备份包含重复的游戏内容标识。')
    ids.add(entry.game.id)
    if (!Array.isArray(entry.states) || entry.states.length > 8)
      throw new Error('备份即时存档槽位无效。')
    if (entry.rom !== undefined) {
      byteLength(entry.rom, BACKUP_LIMITS.romBytes, 'ROM')
      if (entry.rom.byteLength !== entry.game.size)
        throw new Error('备份 ROM 大小与游戏元数据不一致。')
    }
    if (entry.battery !== undefined)
      total += byteLength(entry.battery, BACKUP_LIMITS.batteryBytes, '电池存档')
    const slots = new Set<number>()
    for (const state of entry.states) {
      checkState(state, entry.game.id)
      if (slots.has(state.slot)) throw new Error('备份包含重复的即时存档槽位。')
      slots.add(state.slot)
      total += byteLength(state.data, BACKUP_LIMITS.stateBytes, '即时存档')
    }
  }
  if (total > BACKUP_LIMITS.totalBytes) throw new Error(WORKING_SET_ERROR)
  const manifestBytes = encoder.encode(JSON.stringify(manifestSkeleton(data))).length
  if (manifestBytes > BACKUP_LIMITS.manifestBytes)
    throw new Error('备份清单超过 2 MiB，请减少游戏或带截图的存档。')
  if (total + manifestBytes > BACKUP_LIMITS.totalBytes) throw new Error(WORKING_SET_ERROR)
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await sha256Bytes(bytes))
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle)
    throw new Error('浏览器无法执行 SHA-256 校验，请使用 HTTPS 或 localhost 打开应用。')
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Preserve historical GBA IDs while separating otherwise identical GB/GBC ROMs.
 * The second digest is versioned so this identity scheme remains stable as more
 * platforms are added.
 */
export async function gameIdForRom(platform: GamePlatform, bytes: Uint8Array): Promise<string> {
  const contentDigest = await sha256Bytes(bytes)
  if (platform === 'gba') return hex(contentDigest)
  const domain = encoder.encode(`advance-game-id:v1\0${platform}\0`)
  const identity = new Uint8Array(domain.length + contentDigest.length)
  identity.set(domain)
  identity.set(contentDigest, domain.length)
  return hex(await sha256Bytes(identity))
}

function stateMetadata(state: Omit<SaveState, 'data'>): Omit<SaveState, 'data'> {
  return {
    id: state.id,
    gameId: state.gameId,
    slot: state.slot,
    createdAt: state.createdAt,
    ...(state.screenshot === undefined ? {} : { screenshot: state.screenshot }),
    ...(state.coreVersion === undefined ? {} : { coreVersion: state.coreVersion }),
  }
}

function gameMetadata(game: Game): Game {
  return {
    id: game.id,
    title: game.title,
    filename: game.filename,
    platform: game.platform,
    size: game.size,
    addedAt: game.addedAt,
    lastPlayed: game.lastPlayed,
    playTime: game.playTime,
    favorite: game.favorite,
    ...(game.skipAutoState === undefined ? {} : { skipAutoState: game.skipAutoState }),
    ...(game.launchMode === undefined ? {} : { launchMode: game.launchMode }),
    ...(game.launchStateSlot === undefined ? {} : { launchStateSlot: game.launchStateSlot }),
    ...(game.color === undefined ? {} : { color: game.color }),
    ...(game.cheats === undefined ? {} : { cheats: game.cheats }),
  }
}

/** Hash placeholders have the same encoded length as real SHA-256 values. */
function manifestSkeleton(data: BackupData): Manifest {
  const manifest: Manifest = {
    format: 'advance-gba-backup',
    formatVersion: 1,
    exportedAt: data.exportedAt,
    coreVersion: data.coreVersion,
    games: [],
    files: [],
  }
  const add = (path: string, bytes: Uint8Array): string => {
    manifest.files.push({ path, size: bytes.byteLength, sha256: '0'.repeat(64) })
    return path
  }
  for (const entry of data.games) {
    const prefix = `games/${entry.game.id}/`
    manifest.games.push({
      game: gameMetadata(entry.game),
      ...(entry.rom === undefined ? {} : { rom: add(romPayloadPath(entry.game), entry.rom) }),
      ...(entry.battery === undefined
        ? {}
        : { battery: add(`${prefix}battery.sav`, entry.battery) }),
      states: entry.states.map((state) => ({
        ...stateMetadata(state),
        path: add(`${prefix}state-${state.slot}.bin`, state.data),
      })),
    })
  }
  return manifest
}

export async function createBackup(
  data: BackupData,
  options: BackupProgressOptions & { includeRoms?: boolean } = {},
): Promise<Uint8Array> {
  if (!object(data)) throw new Error(FORMAT_ERROR)
  checkHeader(data)
  const source: BackupData = {
    ...data,
    games: data.games.map((entry) => ({
      ...entry,
      rom: options.includeRoms ? entry.rom : undefined,
    })),
  }
  // Enforce limits before allocating copies of all selected byte arrays.
  validateBackupData(source)
  // Copy caller-owned bytes before asynchronous hashing so the exported manifest cannot race a mutation.
  const selected: BackupData = {
    ...source,
    games: source.games.map((entry) => ({
      game: gameMetadata(entry.game),
      ...(entry.rom === undefined ? {} : { rom: new Uint8Array(entry.rom) }),
      ...(entry.battery === undefined ? {} : { battery: new Uint8Array(entry.battery) }),
      states: entry.states.map((state) => ({
        ...stateMetadata(state),
        data: new Uint8Array(state.data),
      })),
    })),
  }
  if (options.includeRoms && selected.games.some((entry) => !entry.rom))
    throw new Error('选择了包含 ROM，但部分游戏缺少 ROM，备份未生成。')
  const files: Record<string, Uint8Array> = Object.create(null)
  const manifest = manifestSkeleton(selected)
  const add = async (path: string, bytes: Uint8Array): Promise<string> => {
    files[path] = bytes
    const hash = await sha256(bytes)
    manifest.files.find((file) => file.path === path)!.sha256 = hash
    return hash
  }
  for (let index = 0; index < selected.games.length; index++) {
    const entry = selected.games[index]
    options.onProgress?.(`正在校验并打包游戏 ${index + 1}/${selected.games.length}…`)
    const prefix = `games/${entry.game.id}/`
    if (entry.rom) {
      await add(romPayloadPath(entry.game), entry.rom)
      if ((await gameIdForRom(entry.game.platform, entry.rom)) !== entry.game.id)
        throw new Error('备份 ROM 内容标识与游戏不一致，备份未生成。')
    }
    if (entry.battery) await add(`${prefix}battery.sav`, entry.battery)
    for (const state of entry.states) await add(`${prefix}state-${state.slot}.bin`, state.data)
  }
  const metadata = encoder.encode(JSON.stringify(manifest))
  if (metadata.length > BACKUP_LIMITS.manifestBytes)
    throw new Error('备份清单超过 2 MiB，请减少游戏或带截图的存档。')
  if (
    metadata.length + manifest.files.reduce((sum, file) => sum + file.size, 0) >
    BACKUP_LIMITS.totalBytes
  )
    throw new Error('备份解压总大小不能超过 64 MiB，请减少选择的游戏或存档。')
  files['manifest.json'] = metadata
  options.onProgress?.('正在生成备份 ZIP…')
  const result = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 6 }, (error, bytes) => (error ? reject(error) : resolve(bytes)))
  })
  if (result.length > BACKUP_LIMITS.archiveBytes)
    throw new Error('备份压缩包超过 72 MiB，请减少选择内容。')
  return result
}

interface ZipEntry {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  size: number
  compressedSize: number
  offset: number
  start: number
  end: number
}

function extras(view: DataView, start: number, length: number): void {
  const end = start + length
  while (start < end) {
    if (start + 4 > end) throw new Error(ZIP_ERROR)
    if (view.getUint16(start, true) === 1) throw new Error('备份暂不支持 ZIP64 格式。')
    start += 4 + view.getUint16(start + 2, true)
    if (start > end) throw new Error(ZIP_ERROR)
  }
}

function directory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 22 - 65535); cursor--) {
    if (
      view.getUint32(cursor, true) === 0x06054b50 &&
      cursor + 22 + view.getUint16(cursor + 20, true) === bytes.length
    ) {
      eocd = cursor
      break
    }
  }
  if (eocd < 0) throw new Error(ZIP_ERROR)
  const count = view.getUint16(eocd + 10, true)
  const size = view.getUint32(eocd + 12, true)
  const offset = view.getUint32(eocd + 16, true)
  if (
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    (eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50)
  )
    throw new Error('备份暂不支持 ZIP64 格式。')
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    view.getUint16(eocd + 8, true) !== count
  )
    throw new Error('备份不支持分卷 ZIP。')
  if (count < 1 || count > BACKUP_LIMITS.files)
    throw new Error(`备份 ZIP 文件数量无效或超出 ${BACKUP_LIMITS.files} 项限制。`)
  if (offset + size !== eocd) throw new Error(ZIP_ERROR)
  const entries: ZipEntry[] = []
  const paths = new Set<string>()
  let cursor = offset
  let total = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error(ZIP_ERROR)
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const next = cursor + 46 + nameLength + extraLength + view.getUint16(cursor + 32, true)
    if (next > eocd || nameLength < 1 || nameLength > 128) throw new Error(ZIP_ERROR)
    let path: string
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    try {
      path = decoder.decode(name)
    } catch {
      throw new Error(ZIP_ERROR)
    }
    const payload = /^games\/[0-9a-f]{64}\/([^/]+)$/.exec(path)?.[1]
    if (
      path !== 'manifest.json' &&
      (!payload ||
        (!ROM_PAYLOAD_NAMES.has(payload) &&
          payload !== 'battery.sav' &&
          !/^state-[0-5]\.bin$/.test(payload)))
    )
      throw new Error('备份包含非法路径、路径穿越或未声明的文件名。')
    if (paths.has(path)) throw new Error('备份 ZIP 包含重复文件条目。')
    paths.add(path)
    if (flags & ~0x80e) throw new Error('备份 ZIP 包含加密或不支持的文件标志。')
    if (method !== 0 && method !== 8) throw new Error('备份 ZIP 使用了不支持的压缩方式。')
    const entry = {
      path,
      name,
      flags,
      method,
      crc: view.getUint32(cursor + 16, true),
      compressedSize: view.getUint32(cursor + 20, true),
      size: view.getUint32(cursor + 24, true),
      offset: view.getUint32(cursor + 42, true),
      start: 0,
      end: 0,
    }
    if (
      entry.size === 0xffffffff ||
      entry.compressedSize === 0xffffffff ||
      entry.offset === 0xffffffff
    )
      throw new Error('备份暂不支持 ZIP64 格式。')
    if (view.getUint16(cursor + 34, true) !== 0) throw new Error('备份不支持分卷 ZIP。')
    extras(view, cursor + 46 + nameLength, extraLength)
    const max =
      path === 'manifest.json'
        ? BACKUP_LIMITS.manifestBytes
        : isRomPayloadPath(path)
          ? BACKUP_LIMITS.romBytes
          : path.endsWith('battery.sav')
            ? BACKUP_LIMITS.batteryBytes
            : BACKUP_LIMITS.stateBytes
    if (entry.size < 1 || entry.size > max)
      throw new Error(`备份文件「${path}」声明大小无效或超出单项限制。`)
    total += entry.size
    if (total > BACKUP_LIMITS.totalBytes) throw new Error('备份解压总大小不能超过 64 MiB。')
    entries.push(entry)
    cursor = next
  }
  if (cursor !== eocd || !paths.has('manifest.json'))
    throw new Error('备份缺少 manifest.json 或 ZIP 目录已损坏。')
  const ordered = [...entries].sort((a, b) => a.offset - b.offset)
  let boundary = 0
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]
    const local = entry.offset
    if (local !== boundary || local + 30 > offset || view.getUint32(local, true) !== 0x04034b50)
      throw new Error(ZIP_ERROR)
    const nameLength = view.getUint16(local + 26, true)
    const extraLength = view.getUint16(local + 28, true)
    entry.start = local + 30 + nameLength + extraLength
    entry.end = entry.start + entry.compressedSize
    if (
      entry.start > offset ||
      entry.end > offset ||
      nameLength !== entry.name.length ||
      !entry.name.every((byte, position) => bytes[local + 30 + position] === byte) ||
      view.getUint16(local + 6, true) !== entry.flags ||
      view.getUint16(local + 8, true) !== entry.method
    )
      throw new Error(ZIP_ERROR)
    extras(view, local + 30 + nameLength, extraLength)
    if (!(entry.flags & 8)) {
      if (
        view.getUint32(local + 14, true) !== entry.crc ||
        view.getUint32(local + 18, true) !== entry.compressedSize ||
        view.getUint32(local + 22, true) !== entry.size
      )
        throw new Error(ZIP_ERROR)
      boundary = entry.end
    } else {
      const next = ordered[index + 1]?.offset ?? offset
      const length = next - entry.end
      if (length !== 12 && length !== 16) throw new Error(ZIP_ERROR)
      const descriptor = entry.end + (length === 16 ? 4 : 0)
      if (
        (length === 16 && view.getUint32(entry.end, true) !== 0x08074b50) ||
        view.getUint32(descriptor, true) !== entry.crc ||
        view.getUint32(descriptor + 4, true) !== entry.compressedSize ||
        view.getUint32(descriptor + 8, true) !== entry.size
      )
        throw new Error(ZIP_ERROR)
      boundary = next
    }
  }
  if (boundary !== offset) throw new Error(ZIP_ERROR)
  return entries
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

async function extract(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const output = new Uint8Array(entry.size)
  let written = 0
  let crc = -1
  const accept = (chunk: Uint8Array) => {
    if (written + chunk.length > entry.size) throw new Error('备份实际解压大小超出声明限制。')
    for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
    output.set(chunk, written)
    written += chunk.length
  }
  try {
    if (entry.method === 0) accept(bytes.subarray(entry.start, entry.end))
    else {
      const inflate = new Inflate(accept)
      for (let cursor = entry.start; cursor < entry.end; cursor += 4096) {
        const end = Math.min(cursor + 4096, entry.end)
        inflate.push(bytes.subarray(cursor, end), end === entry.end)
        if ((cursor - entry.start) % (256 * 1024) === 0)
          await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('实际解压大小')) throw error
    throw new Error('备份文件解压失败，请重新选择完整备份。', { cause: error })
  }
  if (written !== entry.size || (crc ^ -1) >>> 0 !== entry.crc)
    throw new Error('备份文件完整性校验失败（CRC 或字节数不一致）。')
  return output
}

function parseManifest(bytes: Uint8Array, entries: ZipEntry[]): Manifest {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new Error('备份 manifest.json 无法读取。')
  }
  if (!object(value)) throw new Error(FORMAT_ERROR)
  checkHeader(value)
  if (
    value.format !== 'advance-gba-backup' ||
    !Array.isArray(value.files) ||
    value.files.length > BACKUP_LIMITS.files - 1
  )
    throw new Error(FORMAT_ERROR)
  const declared = new Map<string, ManifestFile>()
  const actual = new Map(entries.map((entry) => [entry.path, entry]))
  for (const file of value.files) {
    if (
      !object(file) ||
      typeof file.path !== 'string' ||
      file.path === 'manifest.json' ||
      declared.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      typeof file.sha256 !== 'string' ||
      !HASH.test(file.sha256) ||
      actual.get(file.path)?.size !== file.size
    )
      throw new Error('备份文件声明重复、缺失或字节数无效。')
    declared.set(file.path, file as unknown as ManifestFile)
  }
  if (declared.size + 1 !== entries.length) throw new Error('备份包含未声明的额外负载文件。')
  const ids = new Set<string>()
  const references = new Set<string>()
  const reference = (path: unknown, expected: string) => {
    if (path !== expected || !declared.has(expected) || references.has(expected))
      throw new Error('备份文件引用缺失、重复或游戏内容标识不一致。')
    references.add(expected)
  }
  for (const entry of value.games as unknown[]) {
    if (!object(entry)) throw new Error(FORMAT_ERROR)
    const game = normalizeGame(entry.game, true)
    entry.game = game
    if (ids.has(game.id)) throw new Error('备份包含重复的游戏内容标识。')
    ids.add(game.id)
    const prefix = `games/${game.id}/`
    if (entry.rom !== undefined) {
      const expected = romPayloadPath(game)
      reference(entry.rom, expected)
      const file = declared.get(expected)!
      if (file.size !== game.size) throw new Error('备份 ROM 大小与游戏信息不一致。')
    }
    if (entry.battery !== undefined) reference(entry.battery, `${prefix}battery.sav`)
    if (!Array.isArray(entry.states) || entry.states.length > 8)
      throw new Error('备份即时存档槽位无效。')
    const slots = new Set<number>()
    for (const state of entry.states) {
      checkState(state, game.id)
      if (slots.has(state.slot)) throw new Error('备份包含重复的即时存档槽位。')
      slots.add(state.slot)
      reference(
        (state as unknown as Record<string, unknown>).path,
        `${prefix}state-${state.slot}.bin`,
      )
    }
  }
  if (references.size !== declared.size) throw new Error('备份包含未引用的额外负载文件。')
  const manifest = value as unknown as Manifest
  const workingSetBytes =
    bytes.length +
    manifest.games.reduce((total, entry) => total + entry.game.size, 0) +
    manifest.files.reduce((total, file) => total + (isRomPayloadPath(file.path) ? 0 : file.size), 0)
  if (workingSetBytes > BACKUP_LIMITS.totalBytes) throw new Error(WORKING_SET_ERROR)
  return manifest
}

/** Read-only parsing: all ZIP, manifest, byte, hash and reference checks finish before returning. */
export async function parseBackup(
  file: Blob,
  options: BackupProgressOptions = {},
): Promise<BackupData> {
  if (file.size > BACKUP_LIMITS.archiveBytes) throw new Error('备份压缩包不能超过 72 MiB。')
  options.onProgress?.('正在读取备份并检查 ZIP 边界…')
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (error) {
    throw new Error('无法读取备份文件，请重新选择。', { cause: error })
  }
  if (bytes.length !== file.size || bytes.length > BACKUP_LIMITS.archiveBytes)
    throw new Error('备份读取大小不一致或超出 72 MiB 限制。')
  const entries = directory(bytes)
  const manifest = parseManifest(
    await extract(
      bytes,
      entries.find((entry) => entry.path === 'manifest.json')!,
    ),
    entries,
  )
  const contents = new Map<string, Uint8Array>()
  const declared = new Map(manifest.files.map((entry) => [entry.path, entry]))
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.path === 'manifest.json') continue
    options.onProgress?.(`正在解压并校验文件 ${contents.size + 1}/${manifest.files.length}…`)
    const data = await extract(bytes, entry)
    if ((await sha256(data)) !== declared.get(entry.path)?.sha256)
      throw new Error(`备份文件 SHA-256 校验失败：${entry.path}`)
    contents.set(entry.path, data)
  }
  const result: BackupData = {
    formatVersion: 1,
    exportedAt: manifest.exportedAt,
    coreVersion: manifest.coreVersion,
    games: manifest.games.map((entry) => ({
      game: gameMetadata(entry.game),
      ...(entry.rom === undefined ? {} : { rom: contents.get(entry.rom)! }),
      ...(entry.battery === undefined ? {} : { battery: contents.get(entry.battery)! }),
      states: entry.states.map((state) => ({
        ...stateMetadata(state),
        data: contents.get(state.path)!,
      })),
    })),
  }
  for (const entry of result.games) {
    if (entry.rom && (await gameIdForRom(entry.game.platform, entry.rom)) !== entry.game.id)
      throw new Error('备份 ROM 内容标识与游戏不一致。')
  }
  validateBackupData(result)
  options.onProgress?.('备份校验完成，可以预览；尚未写入游戏库。')
  return result
}
