import {
  MINECRAFT_ENDPOINTS,
  assertOfficialMinecraftUrl,
  fetchMinecraftBytes,
  minecraftOfficialTransportUrl,
  parseJsonBytes,
  parseMinecraftManifest,
  parseMinecraftVersionDependencies,
  type MinecraftDependency,
  type MinecraftDependencyGraph,
  type MinecraftManifest,
  type MinecraftVersionEntry,
} from './minecraft.ts'
import {
  cacheMinecraftBlob,
  clearMinecraftTask,
  commitMinecraftVersion,
  getMinecraftManifestCache,
  hasMinecraftBlobs,
  markMinecraftVersionVerified,
  replaceMinecraftBlobs,
  saveMinecraftManifestCache,
  saveMinecraftTask,
  updateMinecraftUpstreamAvailability,
  verifyMinecraftVersion,
  type MinecraftInstalledVersion,
} from './minecraft-storage.ts'

export interface MinecraftCatalogResult {
  manifest: MinecraftManifest
  source: 'network' | 'validated-cache' | 'stale-cache'
  warning?: string
}

export interface MinecraftPreparedDownload {
  graph: MinecraftDependencyGraph
  reusableFiles: number
  reusableBytes: number
  downloadBytes: number
  totalBytes: number
  prefetched: Map<string, Uint8Array>
}

export interface MinecraftDownloadProgress {
  completedFiles: number
  totalFiles: number
  completedBytes: number
  totalBytes: number
  currentPath: string
}

export async function fetchMinecraftCatalog(
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<MinecraftCatalogResult> {
  const cache = await getMinecraftManifestCache()
  const headers = new Headers({ Accept: 'application/json' })
  if (!options.force && cache?.etag) headers.set('If-None-Match', cache.etag)
  if (!options.force && cache?.lastModified) headers.set('If-Modified-Since', cache.lastModified)
  try {
    const transportUrl = minecraftOfficialTransportUrl(MINECRAFT_ENDPOINTS.manifest)
    const response = await fetch(transportUrl, {
      credentials: 'omit',
      redirect: 'follow',
      cache: options.force ? 'reload' : 'no-cache',
      headers,
      signal: options.signal,
    })
    if (response.status === 304 && cache) {
      const manifest = { ...cache.manifest, fetchedAt: Date.now() }
      await saveMinecraftManifestCache(manifest, {
        etag: cache.etag,
        lastModified: cache.lastModified,
      })
      return { manifest, source: 'validated-cache' }
    }
    if (!response.ok) throw new Error(`官方版本清单请求失败（HTTP ${response.status}）。`)
    if (response.url && response.url !== transportUrl) {
      const redirected = new URL(response.url)
      const sameOriginProxy =
        typeof window !== 'undefined' &&
        redirected.origin === window.location.origin &&
        redirected.pathname.startsWith('/minecraft-official/')
      if (!sameOriginProxy) assertOfficialMinecraftUrl(response.url, '版本清单重定向地址')
    }
    const manifest = parseMinecraftManifest(await response.json())
    await saveMinecraftManifestCache(manifest, {
      etag: response.headers.get('ETag') ?? undefined,
      lastModified: response.headers.get('Last-Modified') ?? undefined,
    })
    await updateMinecraftUpstreamAvailability(manifest)
    return { manifest, source: 'network' }
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (!cache) throw error
    return {
      manifest: cache.manifest,
      source: 'stale-cache',
      warning: `官方目录暂时不可用，正在显示 ${new Date(cache.manifest.fetchedAt).toLocaleString('zh-CN')} 的缓存。`,
    }
  }
}

export async function prepareMinecraftDownload(
  version: MinecraftVersionEntry,
  signal?: AbortSignal,
): Promise<MinecraftPreparedDownload> {
  const metadataFile: MinecraftDependency = {
    kind: 'version-metadata',
    path: `versions/${version.id}/${version.id}.json`,
    url: version.url,
    sha1: version.sha1,
    size: 0,
  }
  const metadataBytes = await fetchMinecraftBytes(metadataFile, { signal })
  const metadata = parseJsonBytes(metadataBytes, `版本 ${version.id} 元数据`)
  if (!metadata || typeof metadata !== 'object' || !('assetIndex' in metadata)) {
    throw new Error(`版本 ${version.id} 元数据缺少资源索引。`)
  }
  const rawIndex = (metadata as { assetIndex: unknown }).assetIndex
  if (!rawIndex || typeof rawIndex !== 'object') throw new Error('资源索引信息无效。')
  const index = rawIndex as Record<string, unknown>
  const assetIndexFile: MinecraftDependency = {
    kind: 'asset-index',
    path: `assets/indexes/${String(index.id)}.json`,
    url: String(index.url),
    sha1: String(index.sha1),
    size: Number(index.size),
  }
  const assetIndexBytes = await fetchMinecraftBytes(assetIndexFile, { signal })
  const assetIndex = parseJsonBytes(assetIndexBytes, `版本 ${version.id} 资源索引`)
  const graph = parseMinecraftVersionDependencies(
    version,
    metadata,
    assetIndex,
    undefined,
    metadataBytes.byteLength,
  )
  const existing = await hasMinecraftBlobs(graph.files)
  const prefetched = new Map<string, Uint8Array>([
    [version.sha1, metadataBytes],
    [assetIndexFile.sha1, assetIndexBytes],
  ])
  const reusable = graph.files.filter((file) => existing.has(file.sha1))
  const totalBytes = graph.files.reduce((total, file) => total + file.size, 0)
  const reusableBytes = reusable.reduce((total, file) => total + file.size, 0)
  return {
    graph,
    reusableFiles: reusable.length,
    reusableBytes,
    downloadBytes: totalBytes - reusableBytes,
    totalBytes,
    prefetched,
  }
}

export async function downloadPreparedMinecraftVersion(
  prepared: MinecraftPreparedDownload,
  options: {
    signal?: AbortSignal
    concurrency?: number
    onProgress?: (progress: MinecraftDownloadProgress) => void
  } = {},
): Promise<void> {
  const { graph } = prepared
  const existing = await hasMinecraftBlobs(graph.files)
  const pending = graph.files.filter((file) => !existing.has(file.sha1))
  let completedFiles = graph.files.length - pending.length
  let completedBytes = graph.files
    .filter((file) => existing.has(file.sha1))
    .reduce((total, file) => total + file.size, 0)
  let taskWrite = Promise.resolve()
  await saveMinecraftTask({
    key: graph.version.key,
    versionId: graph.version.id,
    state: 'downloading',
    completedFiles,
    totalFiles: graph.files.length,
    updatedAt: Date.now(),
  })
  let next = 0
  const worker = async () => {
    while (next < pending.length) {
      const file = pending[next++]
      if (options.signal?.aborted) throw new DOMException('下载已取消。', 'AbortError')
      const bytes =
        prepared.prefetched.get(file.sha1) ??
        (await fetchMinecraftBytes(file, { signal: options.signal }))
      await cacheMinecraftBlob(file, bytes)
      completedFiles += 1
      completedBytes += file.size
      const task = {
        key: graph.version.key,
        versionId: graph.version.id,
        state: 'downloading' as const,
        completedFiles,
        totalFiles: graph.files.length,
        updatedAt: Date.now(),
      }
      taskWrite = taskWrite.then(() => saveMinecraftTask(task))
      await taskWrite
      options.onProgress?.({
        completedFiles,
        totalFiles: graph.files.length,
        completedBytes,
        totalBytes: prepared.totalBytes,
        currentPath: file.path,
      })
    }
  }
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(options.concurrency ?? 4, Math.max(1, pending.length)) },
        worker,
      ),
    )
    await commitMinecraftVersion(graph.version, graph.files, new Map(), graph.javaMajorVersion)
  } catch (error) {
    await saveMinecraftTask({
      key: graph.version.key,
      versionId: graph.version.id,
      state: 'interrupted',
      completedFiles,
      totalFiles: graph.files.length,
      updatedAt: Date.now(),
    })
    throw error
  }
}

export async function discardMinecraftDownload(key: string): Promise<void> {
  await clearMinecraftTask(key)
}

export async function verifyAndRepairMinecraftVersion(
  version: MinecraftInstalledVersion,
  options: {
    signal?: AbortSignal
    onProgress?: (progress: MinecraftDownloadProgress) => void
  } = {},
): Promise<{ repaired: number }> {
  const verification = await verifyMinecraftVersion(version.key)
  if (verification.valid) {
    await markMinecraftVersionVerified(version.key)
    return { repaired: 0 }
  }
  const damagedPaths = new Set(verification.damaged)
  const damaged = version.files.filter((file) => damagedPaths.has(file.path))
  const downloaded = new Map<string, Uint8Array>()
  let completedBytes = 0
  const totalBytes = damaged.reduce((total, file) => total + file.size, 0)
  for (let index = 0; index < damaged.length; index++) {
    const file = damaged[index]
    const bytes = await fetchMinecraftBytes(file, { signal: options.signal })
    downloaded.set(file.sha1, bytes)
    completedBytes += file.size
    options.onProgress?.({
      completedFiles: index + 1,
      totalFiles: damaged.length,
      completedBytes,
      totalBytes,
      currentPath: file.path,
    })
  }
  await replaceMinecraftBlobs(damaged, downloaded)
  const final = await verifyMinecraftVersion(version.key)
  if (!final.valid) throw new Error(`修复后仍有 ${final.damaged.length} 个文件校验失败。`)
  await markMinecraftVersionVerified(version.key)
  return { repaired: damaged.length }
}
