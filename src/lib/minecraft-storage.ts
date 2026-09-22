import type { MinecraftDependency, MinecraftManifest, MinecraftVersionEntry } from './minecraft.ts'
import { sha1Hex } from './minecraft.ts'

const DATABASE_NAME = 'orbitra-minecraft'
const DATABASE_VERSION = 1
const STORES = { config: 'config', blobs: 'blobs', versions: 'versions', tasks: 'tasks' } as const

export interface MinecraftStoredBlob {
  sha1: string
  size: number
  data: Blob
  sourceUrl: string
  fetchedAt: number
}

export interface MinecraftInstalledVersion {
  key: string
  id: string
  type: string
  manifestSha1: string
  files: MinecraftDependency[]
  installedAt: number
  verifiedAt: number
  upstreamAvailable: boolean
  javaMajorVersion?: number
  source?: MinecraftVersionEntry
}

export interface MinecraftTaskRecord {
  key: string
  versionId: string
  state: 'preparing' | 'downloading' | 'interrupted'
  completedFiles: number
  totalFiles: number
  updatedAt: number
}

interface ManifestCacheRecord {
  key: 'manifest'
  manifest: MinecraftManifest
  etag?: string
  lastModified?: string
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'key' })
      }
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Minecraft 本地版本库正在另一窗口中升级。'))
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}

async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDatabase()
  const tx = db.transaction(stores, mode)
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Minecraft 本地版本库操作已取消。'))
  })
  void completion.catch(() => {})
  try {
    const result = await work(tx)
    await completion
    return result
  } catch (error) {
    try {
      tx.abort()
    } catch {
      // The transaction may already be complete.
    }
    await completion.catch(() => {})
    if (
      error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'QuotaExceededError'
    ) {
      throw new Error('本地空间不足，Minecraft 版本未提交。')
    }
    throw error
  } finally {
    db.close()
  }
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
}

export async function getMinecraftManifestCache(): Promise<ManifestCacheRecord | undefined> {
  return transact([STORES.config], 'readonly', (tx) =>
    request(tx.objectStore(STORES.config).get('manifest')),
  )
}

export async function saveMinecraftManifestCache(
  manifest: MinecraftManifest,
  headers: { etag?: string; lastModified?: string } = {},
): Promise<void> {
  await transact([STORES.config], 'readwrite', async (tx) => {
    await request(
      tx
        .objectStore(STORES.config)
        .put({ key: 'manifest', manifest, ...headers } satisfies ManifestCacheRecord),
    )
  })
}

export async function listMinecraftVersions(): Promise<MinecraftInstalledVersion[]> {
  return transact([STORES.versions], 'readonly', (tx) =>
    request(tx.objectStore(STORES.versions).getAll()),
  )
}

export async function getMinecraftBlob(digest: string): Promise<MinecraftStoredBlob | undefined> {
  return transact([STORES.blobs], 'readonly', async (tx) => {
    const value = await request<(MinecraftStoredBlob & { key: string }) | undefined>(
      tx.objectStore(STORES.blobs).get(digest),
    )
    return value
  })
}

export async function hasMinecraftBlobs(
  files: readonly MinecraftDependency[],
): Promise<Set<string>> {
  const unique = new Map(files.map((file) => [file.sha1, file]))
  const stored = await transact([STORES.blobs], 'readonly', async (tx) => {
    const store = tx.objectStore(STORES.blobs)
    return Promise.all(
      [...unique.values()].map(async (file) => ({
        file,
        blob: await request<(MinecraftStoredBlob & { key: string }) | undefined>(
          store.get(file.sha1),
        ),
      })),
    )
  })
  const existing = new Set<string>()
  for (const { file, blob } of stored) {
    if (!blob || blob.size !== file.size || blob.data.size !== file.size) continue
    const bytes = new Uint8Array(await blob.data.arrayBuffer())
    if (sha1Hex(bytes) === file.sha1) existing.add(file.sha1)
  }
  return existing
}

export async function cacheMinecraftBlob(
  file: MinecraftDependency,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength !== file.size || sha1Hex(bytes) !== file.sha1) {
    throw new Error(`缓存前校验失败：${file.path}`)
  }
  await transact([STORES.blobs], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORES.blobs)
    const existing = await request<(MinecraftStoredBlob & { key: string }) | undefined>(
      store.get(file.sha1),
    )
    if (existing && existing.size === file.size) return
    await request(
      store.put({
        key: file.sha1,
        sha1: file.sha1,
        size: file.size,
        data: new Blob([bytes]),
        sourceUrl: file.url,
        fetchedAt: Date.now(),
      }),
    )
  })
}

export async function commitMinecraftVersion(
  version: MinecraftVersionEntry,
  files: MinecraftDependency[],
  downloaded: ReadonlyMap<string, Uint8Array>,
  javaMajorVersion?: number,
): Promise<MinecraftInstalledVersion> {
  const now = Date.now()
  const installed: MinecraftInstalledVersion = {
    key: version.key,
    id: version.id,
    type: version.type,
    manifestSha1: version.sha1,
    files,
    installedAt: now,
    verifiedAt: now,
    upstreamAvailable: true,
    javaMajorVersion,
    source: version,
  }
  await transact([STORES.blobs, STORES.versions, STORES.tasks], 'readwrite', async (tx) => {
    const blobs = tx.objectStore(STORES.blobs)
    for (const file of files) {
      const existing = await request<(MinecraftStoredBlob & { key: string }) | undefined>(
        blobs.get(file.sha1),
      )
      if (existing?.size === file.size) continue
      const bytes = downloaded.get(file.sha1)
      if (!bytes) throw new Error(`缺少待提交文件：${file.path}`)
      if (bytes.byteLength !== file.size || sha1Hex(bytes) !== file.sha1) {
        throw new Error(`提交前校验失败：${file.path}`)
      }
      await request(
        blobs.put({
          key: file.sha1,
          sha1: file.sha1,
          size: file.size,
          data: new Blob([bytes]),
          sourceUrl: file.url,
          fetchedAt: now,
        }),
      )
    }
    await request(tx.objectStore(STORES.versions).put(installed))
    await request(tx.objectStore(STORES.tasks).delete(version.key))
  })
  return installed
}

export async function replaceMinecraftBlobs(
  files: readonly MinecraftDependency[],
  downloaded: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  await transact([STORES.blobs], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORES.blobs)
    for (const file of files) {
      const bytes = downloaded.get(file.sha1)
      if (!bytes || bytes.byteLength !== file.size || sha1Hex(bytes) !== file.sha1) {
        throw new Error(`修复文件校验失败：${file.path}`)
      }
      await request(
        store.put({
          key: file.sha1,
          sha1: file.sha1,
          size: file.size,
          data: new Blob([bytes]),
          sourceUrl: file.url,
          fetchedAt: Date.now(),
        }),
      )
    }
  })
}

export async function saveMinecraftTask(task: MinecraftTaskRecord): Promise<void> {
  await transact([STORES.tasks], 'readwrite', async (tx) => {
    await request(tx.objectStore(STORES.tasks).put(task))
  })
}

export async function listMinecraftTasks(): Promise<MinecraftTaskRecord[]> {
  return transact([STORES.tasks], 'readonly', (tx) =>
    request(tx.objectStore(STORES.tasks).getAll()),
  )
}

export async function clearMinecraftTask(key: string): Promise<void> {
  await transact([STORES.tasks], 'readwrite', async (tx) => {
    await request(tx.objectStore(STORES.tasks).delete(key))
  })
}

export async function verifyMinecraftVersion(
  key: string,
): Promise<{ valid: boolean; damaged: string[] }> {
  return transact([STORES.versions, STORES.blobs], 'readonly', async (tx) => {
    const installed = await request<MinecraftInstalledVersion | undefined>(
      tx.objectStore(STORES.versions).get(key),
    )
    if (!installed) throw new Error('本地 Minecraft 版本不存在。')
    const blobs = tx.objectStore(STORES.blobs)
    const damaged: string[] = []
    for (const file of installed.files) {
      const blob = await request<(MinecraftStoredBlob & { key: string }) | undefined>(
        blobs.get(file.sha1),
      )
      if (!blob || blob.size !== file.size) {
        damaged.push(file.path)
        continue
      }
      const bytes = new Uint8Array(await blob.data.arrayBuffer())
      if (sha1Hex(bytes) !== file.sha1) damaged.push(file.path)
    }
    return { valid: damaged.length === 0, damaged }
  })
}

export async function markMinecraftVersionVerified(key: string): Promise<void> {
  await transact([STORES.versions], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORES.versions)
    const value = await request<MinecraftInstalledVersion | undefined>(store.get(key))
    if (!value) return
    await request(store.put({ ...value, verifiedAt: Date.now() }))
  })
}

export async function deleteMinecraftVersion(key: string): Promise<void> {
  await transact([STORES.versions, STORES.blobs, STORES.tasks], 'readwrite', async (tx) => {
    const versions = tx.objectStore(STORES.versions)
    const target = await request<MinecraftInstalledVersion | undefined>(versions.get(key))
    if (!target) return
    await request(versions.delete(key))
    const remaining = await request<MinecraftInstalledVersion[]>(versions.getAll())
    const referenced = new Set(
      remaining.flatMap((version) => version.files.map((file) => file.sha1)),
    )
    const blobs = tx.objectStore(STORES.blobs)
    for (const digest of new Set(target.files.map((file) => file.sha1))) {
      if (!referenced.has(digest)) await request(blobs.delete(digest))
    }
    await request(tx.objectStore(STORES.tasks).delete(key))
  })
}

export async function updateMinecraftUpstreamAvailability(
  manifest: MinecraftManifest,
): Promise<void> {
  const available = new Set(manifest.versions.map((version) => version.key))
  await transact([STORES.versions], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORES.versions)
    for (const version of await request<MinecraftInstalledVersion[]>(store.getAll())) {
      const upstreamAvailable = available.has(version.key)
      if (version.upstreamAvailable !== upstreamAvailable) {
        await request(store.put({ ...version, upstreamAvailable }))
      }
    }
  })
}

export async function minecraftStorageUsage(): Promise<{ bytes: number; blobs: number }> {
  return transact([STORES.blobs], 'readonly', async (tx) => {
    const blobs = await request<(MinecraftStoredBlob & { key: string })[]>(
      tx.objectStore(STORES.blobs).getAll(),
    )
    return { bytes: blobs.reduce((total, blob) => total + blob.size, 0), blobs: blobs.length }
  })
}
