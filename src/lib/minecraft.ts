import { sha1 } from '@noble/hashes/sha1'

export const MINECRAFT_ENDPOINTS = {
  manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  assets: 'https://resources.download.minecraft.net',
  bedrockStore: 'https://www.minecraft.net/store/minecraft-deluxe-collection-pc',
} as const

const OFFICIAL_HOSTS = new Set([
  'piston-meta.mojang.com',
  'launchermeta.mojang.com',
  'piston-data.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
])

export type MinecraftKnownVersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'

export interface MinecraftVersionEntry {
  key: string
  id: string
  type: string
  url: string
  sha1: string
  time: string
  releaseTime: string
}

export interface MinecraftManifest {
  latest: { release: string; snapshot: string }
  versions: MinecraftVersionEntry[]
  fetchedAt: number
  raw: unknown
}

export type MinecraftFileKind =
  'version-metadata' | 'client' | 'asset-index' | 'asset' | 'library' | 'native' | 'logging'

export interface MinecraftDependency {
  path: string
  kind: MinecraftFileKind
  url: string
  sha1: string
  size: number
  logicalPath?: string
}

export interface MinecraftDependencyGraph {
  version: MinecraftVersionEntry
  javaMajorVersion?: number
  files: MinecraftDependency[]
  metadata: unknown
}

export interface MinecraftPlatform {
  os: 'windows' | 'osx' | 'linux'
  arch: 'x86' | 'x64' | 'arm32' | 'arm64'
  osVersion?: string
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效。`)
  }
  return value as UnknownRecord
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}缺失或无效。`)
  return value
}

function sha1String(value: unknown, label: string): string {
  const result = nonEmptyString(value, label).toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${label}不是有效的 SHA-1。`)
  return result
}

function byteSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}缺失或无效。`)
  return value as number
}

export function assertOfficialMinecraftUrl(value: string, label = '下载地址'): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}不是有效 URL。`)
  }
  if (
    url.protocol !== 'https:' ||
    !OFFICIAL_HOSTS.has(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(`${label}不是允许的 Mojang / Microsoft 官方 HTTPS 地址。`)
  }
  return url
}

export function minecraftOfficialTransportUrl(value: string): string {
  const source = assertOfficialMinecraftUrl(value)
  if (typeof window === 'undefined') return source.href
  return `${window.location.origin}/minecraft-official/${source.hostname}${source.pathname}${source.search}`
}

export function parseMinecraftManifest(value: unknown, fetchedAt = Date.now()): MinecraftManifest {
  const source = record(value, '官方版本清单')
  const latest = record(source.latest, '官方版本清单 latest')
  const versions = source.versions
  if (!Array.isArray(versions)) throw new Error('官方版本清单缺少 versions。')
  const parsed = versions.map((item, index): MinecraftVersionEntry => {
    const entry = record(item, `版本条目 ${index + 1}`)
    const id = nonEmptyString(entry.id, `版本条目 ${index + 1} 的 ID`)
    const type = nonEmptyString(entry.type, `版本 ${id} 的类型`)
    const url = assertOfficialMinecraftUrl(
      nonEmptyString(entry.url, `版本 ${id} 的详情地址`),
      `版本 ${id} 的详情地址`,
    ).href
    const digest = sha1String(entry.sha1, `版本 ${id} 的详情 SHA-1`)
    const time = nonEmptyString(entry.time, `版本 ${id} 的更新时间`)
    const releaseTime = nonEmptyString(entry.releaseTime, `版本 ${id} 的发布时间`)
    if (!Number.isFinite(Date.parse(time)) || !Number.isFinite(Date.parse(releaseTime))) {
      throw new Error(`版本 ${id} 的时间字段无效。`)
    }
    return {
      key: `${id}\u0000${digest}`,
      id,
      type,
      url,
      sha1: digest,
      time,
      releaseTime,
    }
  })
  return {
    latest: {
      release: nonEmptyString(latest.release, '最新正式版 ID'),
      snapshot: nonEmptyString(latest.snapshot, '最新快照版 ID'),
    },
    versions: parsed,
    fetchedAt,
    raw: value,
  }
}

export function minecraftVersionTypeLabel(type: string): string {
  return (
    (
      {
        release: '正式版',
        snapshot: '快照版',
        old_beta: 'Beta',
        old_alpha: 'Alpha',
      } satisfies Record<MinecraftKnownVersionType, string>
    )[type as MinecraftKnownVersionType] ?? `未识别 · ${type}`
  )
}

export function currentMinecraftPlatform(): MinecraftPlatform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  const source = `${ua} ${platform}`.toLowerCase()
  const os = /windows/.test(source) ? 'windows' : /mac|darwin/.test(source) ? 'osx' : 'linux'
  const arch = /arm64|aarch64/.test(source)
    ? 'arm64'
    : /arm/.test(source)
      ? 'arm32'
      : /x86_64|x64|win64|amd64/.test(source)
        ? 'x64'
        : 'x86'
  const osVersion =
    os === 'windows'
      ? source.match(/windows nt ([\d.]+)/)?.[1]
      : os === 'osx'
        ? source.match(/mac os x ([\d_]+)/)?.[1]?.replaceAll('_', '.')
        : undefined
  return { os, arch, osVersion }
}

function ruleMatches(rule: UnknownRecord, platform: MinecraftPlatform): boolean {
  if (rule.features && Object.values(record(rule.features, '依赖规则 features')).some(Boolean))
    return false
  if (!rule.os) return true
  const os = record(rule.os, '依赖规则 os')
  if (typeof os.name === 'string' && os.name !== platform.os) return false
  if (typeof os.arch === 'string') {
    const expected = os.arch === 'x86' ? 'x86' : os.arch === 'x86_64' ? 'x64' : os.arch
    if (expected !== platform.arch) return false
  }
  if (typeof os.version === 'string') {
    try {
      if (!new RegExp(os.version).test(platform.osVersion ?? '')) return false
    } catch {
      return false
    }
  }
  return true
}

export function minecraftLibraryAllowed(value: unknown, platform: MinecraftPlatform): boolean {
  const library = record(value, 'Java 依赖')
  if (!Array.isArray(library.rules)) return true
  let allowed = false
  for (const value of library.rules) {
    const rule = record(value, 'Java 依赖规则')
    if (ruleMatches(rule, platform)) allowed = rule.action === 'allow'
  }
  return allowed
}

function safePath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label).replaceAll('\\', '/')
  if (
    path.startsWith('/') ||
    path.includes('\u0000') ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label}包含不安全路径。`)
  }
  return path
}

function dependency(
  value: unknown,
  kind: MinecraftFileKind,
  pathOverride?: string,
): MinecraftDependency {
  const item = record(value, `${kind} 文件`)
  const url = assertOfficialMinecraftUrl(
    nonEmptyString(item.url, `${kind} URL`),
    `${kind} URL`,
  ).href
  const digest = sha1String(item.sha1, `${kind} SHA-1`)
  const size = byteSize(item.size, `${kind} 大小`)
  const path = pathOverride ?? safePath(item.path, `${kind} 路径`)
  return { kind, path, url, sha1: digest, size }
}

function nativeClassifier(library: UnknownRecord, platform: MinecraftPlatform): string | undefined {
  if (!library.natives) return undefined
  const natives = record(library.natives, '原生库分类器')
  const template = natives[platform.os]
  if (typeof template !== 'string') return undefined
  return template.replace(
    '${arch}',
    platform.arch === 'x86' || platform.arch === 'arm32' ? '32' : '64',
  )
}

function addFile(target: Map<string, MinecraftDependency>, file: MinecraftDependency): void {
  const existing = target.get(file.path)
  if (existing && (existing.sha1 !== file.sha1 || existing.size !== file.size)) {
    throw new Error(`依赖目标路径冲突：${file.path}`)
  }
  target.set(file.path, file)
}

export function parseMinecraftVersionDependencies(
  version: MinecraftVersionEntry,
  value: unknown,
  assetIndexValue: unknown,
  platform = currentMinecraftPlatform(),
  metadataSize?: number,
): MinecraftDependencyGraph {
  const metadata = record(value, `版本 ${version.id} 元数据`)
  if (metadata.id !== version.id) throw new Error(`版本详情 ID 与目录不一致：${version.id}`)
  const files = new Map<string, MinecraftDependency>()
  addFile(files, {
    kind: 'version-metadata',
    path: `versions/${safePath(version.id, '版本 ID')}/${safePath(version.id, '版本 ID')}.json`,
    url: version.url,
    sha1: version.sha1,
    size: metadataSize ?? 0,
  })

  const downloads = record(metadata.downloads, `版本 ${version.id} downloads`)
  addFile(files, dependency(downloads.client, 'client', `versions/${version.id}/${version.id}.jar`))

  const assetIndex = record(metadata.assetIndex, `版本 ${version.id} assetIndex`)
  const indexId = safePath(assetIndex.id, '资源索引 ID')
  addFile(files, dependency(assetIndex, 'asset-index', `assets/indexes/${indexId}.json`))
  const assets = record(assetIndexValue, `版本 ${version.id} 资源索引`)
  const objects = record(assets.objects, `版本 ${version.id} 资源对象`)
  for (const [logicalPath, rawObject] of Object.entries(objects)) {
    const object = record(rawObject, `资源对象 ${logicalPath}`)
    const digest = sha1String(object.hash, `资源对象 ${logicalPath} SHA-1`)
    const size = byteSize(object.size, `资源对象 ${logicalPath} 大小`)
    const path = `assets/objects/${digest.slice(0, 2)}/${digest}`
    addFile(files, {
      kind: 'asset',
      path,
      logicalPath: safePath(logicalPath, '资源逻辑路径'),
      url: `${MINECRAFT_ENDPOINTS.assets}/${digest.slice(0, 2)}/${digest}`,
      sha1: digest,
      size,
    })
  }

  if (!Array.isArray(metadata.libraries)) throw new Error(`版本 ${version.id} 缺少 libraries。`)
  for (const rawLibrary of metadata.libraries) {
    const library = record(rawLibrary, 'Java 依赖')
    if (!minecraftLibraryAllowed(library, platform)) continue
    const libraryDownloads = record(library.downloads, 'Java 依赖 downloads')
    if (libraryDownloads.artifact) addFile(files, dependency(libraryDownloads.artifact, 'library'))
    const classifier = nativeClassifier(library, platform)
    if (classifier) {
      const classifiers = record(libraryDownloads.classifiers, '原生库 classifiers')
      if (!classifiers[classifier]) throw new Error(`原生库缺少分类器 ${classifier}。`)
      addFile(files, dependency(classifiers[classifier], 'native'))
    }
  }

  if (metadata.logging) {
    const logging = record(metadata.logging, '日志配置')
    const client = record(logging.client, '客户端日志配置')
    const file = record(client.file, '客户端日志文件')
    addFile(
      files,
      dependency(file, 'logging', `assets/log_configs/${safePath(file.id, '日志配置 ID')}`),
    )
  }

  const javaVersion = metadata.javaVersion ? record(metadata.javaVersion, 'Java 版本') : undefined
  const javaMajorVersion = javaVersion?.majorVersion
  return {
    version,
    javaMajorVersion:
      typeof javaMajorVersion === 'number' && Number.isInteger(javaMajorVersion)
        ? javaMajorVersion
        : undefined,
    files: [...files.values()],
    metadata: value,
  }
}

export function sha1Hex(bytes: Uint8Array): string {
  return Array.from(sha1(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function fetchMinecraftBytes(
  file: Pick<MinecraftDependency, 'url' | 'sha1' | 'size' | 'kind'>,
  options: { signal?: AbortSignal; retries?: number; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  assertOfficialMinecraftUrl(file.url, `${file.kind} URL`)
  const retries = options.retries ?? 2
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    try {
      const transportUrl = minecraftOfficialTransportUrl(file.url)
      const response = await fetch(transportUrl, {
        credentials: 'omit',
        redirect: 'follow',
        signal,
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`官方下载失败（HTTP ${response.status}）。`)
      if (response.url && response.url !== transportUrl) {
        const redirected = new URL(response.url)
        const sameOriginProxy =
          typeof window !== 'undefined' &&
          redirected.origin === window.location.origin &&
          redirected.pathname.startsWith('/minecraft-official/')
        if (!sameOriginProxy) {
          assertOfficialMinecraftUrl(response.url, `${file.kind} 重定向地址`)
        }
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (file.size > 0 && bytes.byteLength !== file.size) throw new Error('官方下载文件大小不符。')
      if (sha1Hex(bytes) !== file.sha1) throw new Error('官方下载文件 SHA-1 校验失败。')
      return bytes
    } catch (error) {
      lastError = error
      if (options.signal?.aborted || attempt === retries) break
    }
  }
  if (options.signal?.aborted) throw new DOMException('下载已取消。', 'AbortError')
  throw lastError instanceof Error ? lastError : new Error('官方下载失败。')
}

export function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error(`${label}不是有效的 JSON。`)
  }
}
