import assert from 'node:assert/strict'
import { beforeEach, afterEach, test } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import {
  sha1Hex,
  parseMinecraftManifest,
  parseMinecraftVersionDependencies,
  minecraftLibraryAllowed,
  fetchMinecraftBytes,
} from './minecraft.ts'
import {
  cacheMinecraftBlob,
  commitMinecraftVersion,
  deleteMinecraftVersion,
  getMinecraftBlob,
  hasMinecraftBlobs,
  listMinecraftVersions,
  verifyMinecraftVersion,
} from './minecraft-storage.ts'
import type { MinecraftDependency, MinecraftVersionEntry } from './minecraft.ts'

const originalFetch = globalThis.fetch

function manifestEntry(
  id: string,
  type: string,
  digest = '0123456789012345678901234567890123456789',
): MinecraftVersionEntry {
  return {
    key: `${id}\u0000${digest}`,
    id,
    type,
    url: `https://piston-meta.mojang.com/v1/packages/${digest}/${id}.json`,
    sha1: digest,
    time: '2024-01-01T00:00:00Z',
    releaseTime: '2024-01-01T00:00:00Z',
  }
}

function digest(bytes: Uint8Array): string {
  return sha1Hex(bytes)
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('parses all official version categories, unknown types, and duplicate IDs independently', () => {
  const value = {
    latest: { release: '1.20.4', snapshot: '24w01a' },
    versions: [
      {
        id: '1.20.4',
        type: 'release',
        url: 'https://piston-meta.mojang.com/v1/packages/0123456789012345678901234567890123456789/r.json',
        sha1: '0123456789012345678901234567890123456789',
        time: '2024-01-01T00:00:00Z',
        releaseTime: '2024-01-01T00:00:00Z',
      },
      {
        id: '24w01a',
        type: 'snapshot',
        url: 'https://piston-meta.mojang.com/v1/packages/1123456789012345678901234567890123456789/s.json',
        sha1: '1123456789012345678901234567890123456789',
        time: '2024-01-01T00:00:00Z',
        releaseTime: '2024-01-01T00:00:00Z',
      },
      {
        id: 'b1.7.3',
        type: 'old_beta',
        url: 'https://piston-meta.mojang.com/v1/packages/2123456789012345678901234567890123456789/b.json',
        sha1: '2123456789012345678901234567890123456789',
        time: '2024-01-01T00:00:00Z',
        releaseTime: '2011-07-08T00:00:00Z',
      },
      {
        id: 'a1.2.6',
        type: 'old_alpha',
        url: 'https://piston-meta.mojang.com/v1/packages/3123456789012345678901234567890123456789/a.json',
        sha1: '3123456789012345678901234567890123456789',
        time: '2024-01-01T00:00:00Z',
        releaseTime: '2010-07-03T00:00:00Z',
      },
      {
        id: 'future',
        type: 'experimental',
        url: 'https://piston-meta.mojang.com/v1/packages/4123456789012345678901234567890123456789/f.json',
        sha1: '4123456789012345678901234567890123456789',
        time: '2024-01-01T00:00:00Z',
        releaseTime: '2024-01-01T00:00:00Z',
      },
      {
        id: 'same',
        type: 'release',
        url: 'https://piston-meta.mojang.com/v1/packages/5123456789012345678901234567890123456789/a.json',
        sha1: '5123456789012345678901234567890123456789',
        time: '2024-01-01T00:00:00Z',
        releaseTime: '2024-01-01T00:00:00Z',
      },
    ],
  }
  const parsed = parseMinecraftManifest(value, 42)
  assert.equal(parsed.versions.length, 6)
  assert.equal(new Set(parsed.versions.map((entry) => entry.key)).size, 6)
  assert.equal(parsed.fetchedAt, 42)
  assert.throws(
    () =>
      parseMinecraftManifest({
        ...value,
        versions: [{ ...value.versions[0], url: 'http://evil.example/metadata.json' }],
      }),
    /官方 HTTPS/,
  )
  assert.throws(
    () => parseMinecraftManifest({ ...value, versions: [{ ...value.versions[0], sha1: 'bad' }] }),
    /SHA-1/,
  )
})

test('applies launcher OS rules and rejects unsafe dependency paths', () => {
  assert.equal(minecraftLibraryAllowed({}, { os: 'linux', arch: 'x64' }), true)
  assert.equal(
    minecraftLibraryAllowed(
      { rules: [{ action: 'allow', os: { name: 'linux' } }] },
      { os: 'linux', arch: 'x64' },
    ),
    true,
  )
  assert.equal(
    minecraftLibraryAllowed(
      { rules: [{ action: 'allow', os: { name: 'windows' } }, { action: 'disallow' }] },
      { os: 'windows', arch: 'x64' },
    ),
    false,
  )
  const version = manifestEntry('test')
  const bytes = new Uint8Array([1, 2, 3])
  const fileHash = digest(bytes)
  const metadata = {
    id: 'test',
    downloads: {
      client: {
        url: 'https://launcher.mojang.com/v1/objects/0123456789012345678901234567890123456789/client.jar',
        sha1: version.sha1,
        size: 3,
      },
    },
    assetIndex: {
      id: 'assets',
      url: 'https://launchermeta.mojang.com/v1/packages/0123456789012345678901234567890123456789/assets.json',
      sha1: version.sha1,
      size: 3,
    },
    libraries: [
      {
        downloads: {
          artifact: {
            path: '../escape.jar',
            url: 'https://libraries.minecraft.net/escape.jar',
            sha1: fileHash,
            size: 3,
          },
        },
      },
    ],
  }
  assert.throws(
    () => parseMinecraftVersionDependencies(version, metadata, { objects: {} }),
    /不安全路径/,
  )
})

test('verifies official download size and SHA-1 before returning bytes', async () => {
  const bytes = new Uint8Array([4, 5, 6])
  const file = {
    kind: 'client' as const,
    url: 'https://launcher.mojang.com/v1/objects/test/client.jar',
    sha1: digest(bytes),
    size: bytes.length,
  }
  globalThis.fetch = async () => new Response(bytes, { status: 200 })
  assert.deepEqual(await fetchMinecraftBytes(file), bytes)
  globalThis.fetch = async () => new Response(new Uint8Array([9]), { status: 200 })
  await assert.rejects(fetchMinecraftBytes(file, { retries: 0 }), /大小不符|SHA-1/)
  globalThis.fetch = async () =>
    new Response(bytes, { status: 302, headers: { Location: 'https://evil.example/file' } })
  await assert.rejects(fetchMinecraftBytes(file, { retries: 0 }), /官方下载失败|重定向/)
})

test('shares verified blobs and keeps remaining versions intact when deleting one', async () => {
  const shared = new Uint8Array([7, 7, 7])
  const unique = new Uint8Array([8, 8])
  const sharedFile: MinecraftDependency = {
    kind: 'library',
    path: 'libraries/shared.jar',
    url: 'https://libraries.minecraft.net/shared.jar',
    sha1: digest(shared),
    size: shared.length,
  }
  const uniqueFile: MinecraftDependency = {
    kind: 'client',
    path: 'versions/a/a.jar',
    url: 'https://launcher.mojang.com/a.jar',
    sha1: digest(unique),
    size: unique.length,
  }
  await cacheMinecraftBlob(sharedFile, shared)
  await cacheMinecraftBlob(sharedFile, shared)
  const a = manifestEntry('a', 'release', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const b = manifestEntry('b', 'release', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  await commitMinecraftVersion(a, [sharedFile], new Map(), undefined)
  await commitMinecraftVersion(
    b,
    [sharedFile, uniqueFile],
    new Map([[uniqueFile.sha1, unique]]),
    undefined,
  )
  const installed = await listMinecraftVersions()
  assert.equal(installed.length, 2)
  assert.deepEqual(installed.find((version) => version.key === a.key)?.source, a)
  assert.equal((await verifyMinecraftVersion(b.key)).valid, true)
  await deleteMinecraftVersion(a.key)
  assert.ok(await getMinecraftBlob(sharedFile.sha1))
  await deleteMinecraftVersion(b.key)
  assert.equal(await getMinecraftBlob(sharedFile.sha1), undefined)
})

test('does not reuse a same-size blob whose SHA-1 no longer matches', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const file: MinecraftDependency = {
    kind: 'asset',
    path: 'assets/objects/test',
    url: 'https://resources.download.minecraft.net/00/test',
    sha1: digest(bytes),
    size: bytes.length,
  }
  await cacheMinecraftBlob(file, bytes)
  assert.deepEqual([...(await hasMinecraftBlobs([file]))], [file.sha1])

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('orbitra-minecraft', 1)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('blobs', 'readwrite')
    tx.objectStore('blobs').put({
      key: file.sha1,
      sha1: file.sha1,
      size: file.size,
      data: new Blob([new Uint8Array([3, 2, 1])]),
      sourceUrl: file.url,
      fetchedAt: Date.now(),
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  database.close()

  assert.deepEqual([...(await hasMinecraftBlobs([file]))], [])
})
