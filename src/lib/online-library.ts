import { sha256 as sha256Digest } from '@noble/hashes/sha256'
import { isGamePlatform, platformFromFilename, PLATFORM_REGISTRY } from './platforms.ts'
import type { GamePlatform } from './platforms.ts'

export const ONLINE_LIBRARY_STORAGE_KEY = 'advance.online-library'
const MANIFEST_FORMAT = 'orbitra-online-library'
const MANIFEST_VERSION = 1
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_GAMES = 2000
const HASH = /^[0-9a-f]{64}$/
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export interface OnlineLibraryEntry {
  id: string
  title: string
  filename: string
  platform: GamePlatform
  size: number
  sha256: string
  downloadUrl: string
}

export interface OnlineLibraryManifest {
  format: typeof MANIFEST_FORMAT
  version: typeof MANIFEST_VERSION
  name: string
  revision: string
  games: OnlineLibraryEntry[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function assertSafeUrl(url: URL, label: string): void {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label}必须使用 http 或 https，且不能包含用户名或密码。`)
  }
  if (
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    url.protocol !== 'https:' &&
    !isLoopback(url.hostname)
  ) {
    throw new Error('HTTPS 页面只能连接 HTTPS 在线游戏库。')
  }
}

export function normalizeOnlineLibraryUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请输入完整的在线游戏库地址，例如 https://library.example.com。')
  }
  assertSafeUrl(url, '在线游戏库地址')
  if (url.search || url.hash) throw new Error('在线游戏库地址不能包含查询参数或片段。')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/$/, '')
}

export function readOnlineLibraryUrl(): string | null {
  try {
    const raw = localStorage.getItem(ONLINE_LIBRARY_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as unknown
    const url = typeof value === 'string' ? value : record(value) ? value.url : null
    if (typeof url !== 'string') return null
    const normalized = normalizeOnlineLibraryUrl(url)
    if (typeof value !== 'string' && record(value) && 'token' in value) {
      localStorage.setItem(ONLINE_LIBRARY_STORAGE_KEY, JSON.stringify({ url: normalized }))
    }
    return normalized
  } catch {
    return null
  }
}

export function saveOnlineLibraryUrl(value: string): string {
  const url = normalizeOnlineLibraryUrl(value)
  localStorage.setItem(ONLINE_LIBRARY_STORAGE_KEY, JSON.stringify({ url }))
  return url
}

export function clearOnlineLibraryUrl(): void {
  localStorage.removeItem(ONLINE_LIBRARY_STORAGE_KEY)
}

function resolveDownloadUrl(value: unknown, manifestUrl: URL): string {
  if (!text(value, 2048)) throw new Error('在线游戏库清单包含无效的游戏下载地址。')
  let url: URL
  try {
    url = new URL(value, manifestUrl)
  } catch {
    throw new Error('在线游戏库清单包含无效的游戏下载地址。')
  }
  assertSafeUrl(url, '游戏下载地址')
  return url.href
}

function parseEntry(value: unknown, manifestUrl: URL): OnlineLibraryEntry {
  if (!record(value)) throw new Error('在线游戏库清单包含无效的游戏条目。')
  const { id, title, filename, platform, size, sha256, url } = value
  if (!text(id, 128) || !SAFE_ID.test(id)) throw new Error('在线游戏库清单包含无效的游戏 ID。')
  if (!text(title, 160)) throw new Error(`游戏 ${id} 的标题无效。`)
  if (!text(filename, 255) || /[\\/:]/.test(filename) || filename === '.' || filename === '..') {
    throw new Error(`游戏 ${id} 的文件名无效。`)
  }
  if (!isGamePlatform(platform)) throw new Error(`游戏 ${id} 使用了不支持的平台。`)
  const definition = PLATFORM_REGISTRY[platform]
  if (!definition.extensions.some((extension) => filename.toLowerCase().endsWith(extension))) {
    throw new Error(`游戏 ${id} 的文件扩展名与平台不匹配。`)
  }
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < definition.minRomSize ||
    size > definition.maxRomSize
  ) {
    throw new Error(`游戏 ${id} 的文件大小无效。`)
  }
  if (typeof sha256 !== 'string' || !HASH.test(sha256)) {
    throw new Error(`游戏 ${id} 的 SHA-256 无效。`)
  }
  return {
    id,
    title: title.trim(),
    filename,
    platform,
    size,
    sha256,
    downloadUrl: resolveDownloadUrl(url, manifestUrl),
  }
}

export function parseOnlineLibraryManifest(
  value: unknown,
  manifestUrl: URL,
): OnlineLibraryManifest {
  if (!record(value) || value.format !== MANIFEST_FORMAT || value.version !== MANIFEST_VERSION) {
    throw new Error('该地址不是兼容的 Orbitra 在线游戏库。')
  }
  if (!text(value.name, 80) || !text(value.revision, 128)) {
    throw new Error('在线游戏库清单缺少有效的名称或版本。')
  }
  if (!Array.isArray(value.games) || value.games.length > MAX_GAMES) {
    throw new Error(`在线游戏库清单最多包含 ${MAX_GAMES} 个游戏。`)
  }
  const games = value.games.map((entry) => parseEntry(entry, manifestUrl))
  const ids = new Set<string>()
  const hashes = new Set<string>()
  for (const game of games) {
    if (ids.has(game.id)) throw new Error(`在线游戏库清单包含重复的游戏 ID：${game.id}`)
    if (hashes.has(game.sha256)) throw new Error(`在线游戏库清单重复分发同一个 ROM：${game.id}`)
    ids.add(game.id)
    hashes.add(game.sha256)
  }
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    name: value.name.trim(),
    revision: value.revision.trim(),
    games,
  }
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') return new Error(body.error)
  } catch {
    // Static distribution servers commonly return plain-text errors.
  }
  return new Error(response.status >= 500 ? '在线游戏库暂时不可用。' : '在线游戏库请求失败。')
}

export async function fetchOnlineLibraryManifest(baseUrl: string): Promise<OnlineLibraryManifest> {
  const manifestUrl = new URL(`${normalizeOnlineLibraryUrl(baseUrl)}/manifest.json`)
  let response: Response
  try {
    response = await fetch(manifestUrl, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      referrerPolicy: 'no-referrer',
    })
  } catch (cause) {
    throw new Error('无法读取在线游戏库，请检查地址、网络和跨域配置。', { cause })
  }
  if (!response.ok) throw await responseError(response)
  const declaredSize = Number(response.headers.get('Content-Length') || 0)
  if (declaredSize > MAX_MANIFEST_BYTES) throw new Error('在线游戏库清单过大。')
  const body = await response.text()
  if (new TextEncoder().encode(body).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('在线游戏库清单过大。')
  }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new Error('在线游戏库清单不是有效的 JSON。')
  }
  return parseOnlineLibraryManifest(value, manifestUrl)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function digestBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) || [], (part) => Number.parseInt(part, 16))
}

export function gameIdForOnlineLibraryEntry(entry: OnlineLibraryEntry): string {
  // GBA content IDs predate the multi-platform domain separator and remain raw SHA-256.
  if (entry.platform === 'gba') return entry.sha256
  const domain = new TextEncoder().encode(`advance-game-id:v1\0${entry.platform}\0`)
  const digest = digestBytes(entry.sha256)
  const identity = new Uint8Array(domain.length + digest.length)
  identity.set(domain)
  identity.set(digest, domain.length)
  return hex(sha256Digest(identity))
}

export async function downloadOnlineLibraryGame(entry: OnlineLibraryEntry): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(entry.downloadUrl, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
  } catch (cause) {
    throw new Error(`无法下载「${entry.title}」，请检查在线游戏库连接。`, { cause })
  }
  if (!response.ok) throw await responseError(response)
  const declaredSize = Number(response.headers.get('Content-Length') || 0)
  if (declaredSize && declaredSize !== entry.size) {
    throw new Error(`「${entry.title}」的文件大小与清单不一致。`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== entry.size) throw new Error(`「${entry.title}」下载不完整。`)
  if (hex(sha256Digest(bytes)) !== entry.sha256) {
    throw new Error(`「${entry.title}」校验失败，未导入个人游戏库。`)
  }
  return bytes
}

async function mutateOnlineLibrary(
  baseUrl: string,
  token: string,
  filename: string,
  init: RequestInit,
): Promise<OnlineLibraryManifest> {
  if (!token.trim()) throw new Error('请输入在线游戏库管理员令牌。')
  const normalized = normalizeOnlineLibraryUrl(baseUrl)
  const manifestUrl = new URL(`${normalized}/manifest.json`)
  let response: Response
  try {
    response = await fetch(`${normalized}/admin/games/${encodeURIComponent(filename)}`, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      referrerPolicy: 'no-referrer',
    })
  } catch (cause) {
    throw new Error('无法连接在线游戏库管理接口。', { cause })
  }
  if (!response.ok) throw await responseError(response)
  return parseOnlineLibraryManifest(await response.json(), manifestUrl)
}

export function publishOnlineLibraryGame(
  baseUrl: string,
  token: string,
  file: File,
): Promise<OnlineLibraryManifest> {
  const platform = platformFromFilename(file.name)
  if (!platform) throw new Error('请选择受支持的 ROM 文件。')
  const definition = PLATFORM_REGISTRY[platform]
  if (file.size < definition.minRomSize || file.size > definition.maxRomSize) {
    throw new Error('ROM 文件大小不符合对应平台范围。')
  }
  return mutateOnlineLibrary(baseUrl, token, file.name, { method: 'PUT', body: file })
}

export function removeOnlineLibraryGame(
  baseUrl: string,
  token: string,
  filename: string,
): Promise<OnlineLibraryManifest> {
  return mutateOnlineLibrary(baseUrl, token, filename, { method: 'DELETE' })
}
