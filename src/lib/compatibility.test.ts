import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { checkRuntimePrerequisites, probeCompatibility } from './compatibility.ts'

const healthy = () => ({
  isSecureContext: true,
  crossOriginIsolated: true,
  SharedArrayBuffer: class SharedArrayBuffer {},
  WebAssembly: { instantiate: async () => ({}) },
  indexedDB: new IDBFactory(),
  document: { createElement: () => ({ getContext: () => ({}) }) },
  navigator: { storage: { estimate: async () => ({ usage: 10, quota: 100 * 1048576 }) } },
})

test('reports a fully supported environment and storage headroom', async () => {
  const report = await probeCompatibility(healthy())
  assert.equal(report.ready, true)
  assert.deepEqual(
    report.checks.map((check) => check.status),
    ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  )
  assert.match(report.checks.at(-1)?.detail || '', /可用空间约/)
})

test('verifies stored data and cleans up without changing the existing game database', async () => {
  const environment = healthy()
  const factory = environment.indexedDB
  const existing = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('advance-gba', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('saves')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = existing.transaction('saves', 'readwrite')
      tx.objectStore('saves').put('existing progress', 'game')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
    const report = await probeCompatibility(environment)
    assert.equal(report.checks.find((check) => check.id === 'indexedDB')?.status, 'ok')
    assert.deepEqual(await factory.databases(), [{ name: 'advance-gba', version: 1 }])
    const value = await new Promise((resolve, reject) => {
      const request = existing.transaction('saves').objectStore('saves').get('game')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    assert.equal(value, 'existing progress')
  } finally {
    existing.close()
  }
})

test('reports failure when the IndexedDB API exists but open is denied', async () => {
  let deleted = false
  const report = await probeCompatibility({
    ...healthy(),
    indexedDB: {
      open: () => {
        throw new DOMException('Storage disabled', 'SecurityError')
      },
      deleteDatabase: () => {
        deleted = true
      },
    },
  })
  const check = report.checks.find((item) => item.id === 'indexedDB')!
  assert.equal(check.status, 'error')
  assert.match(check.detail, /拒绝/)
  assert.equal(report.ready, false)
  assert.equal(deleted, false, 'no database was created or deleted')
})

test('handles asynchronous database open errors', async () => {
  const report = await probeCompatibility({
    ...healthy(),
    indexedDB: {
      open: () => {
        const request = { onerror: null as (() => void) | null, error: new Error('Denied') }
        queueMicrotask(() => request.onerror?.())
        return request
      },
      deleteDatabase: () => {
        throw new Error('unexpected cleanup')
      },
    },
  })
  assert.equal(report.checks.find((item) => item.id === 'indexedDB')?.status, 'error')
})

test('a database write failure is not reported as working storage and its database is removed', async () => {
  const environment = healthy()
  const factory = environment.indexedDB
  const open = factory.open.bind(factory)
  factory.open = (...args) => {
    const request = open(...args)
    request.addEventListener('success', () => {
      const database = request.result
      const transaction = database.transaction.bind(database)
      database.transaction = (...txArgs) => {
        const tx = transaction(...txArgs)
        if (txArgs[1] === 'readwrite') queueMicrotask(() => tx.abort())
        return tx
      }
    })
    return request
  }
  const report = await probeCompatibility(environment)
  assert.equal(report.checks.find((item) => item.id === 'indexedDB')?.status, 'error')
  assert.deepEqual(await factory.databases(), [])
})

test('a stalled database open times out without blocking other diagnostics', async () => {
  const report = await probeCompatibility(
    {
      ...healthy(),
      indexedDB: { open: () => ({}), deleteDatabase: () => ({}) },
    },
    { timeoutMs: 20 },
  )
  const check = report.checks.find((item) => item.id === 'indexedDB')!
  assert.equal(check.status, 'error')
  assert.match(check.detail, /超时/)
  assert.equal(report.checks.find((item) => item.id === 'storageQuota')?.status, 'ok')
})

test('quota rejection is a warning and preserves the StorageManager receiver', async () => {
  const storage = {
    estimate() {
      assert.equal(this, storage)
      return Promise.reject(new DOMException('Not allowed', 'SecurityError'))
    },
  }
  const report = await probeCompatibility({ ...healthy(), navigator: { storage } })
  const check = report.checks.find((item) => item.id === 'storageQuota')!
  assert.equal(check.status, 'warning')
  assert.match(check.detail, /拒绝/)
  assert.equal(report.ready, true)
})

test('closes and removes a temporary database whose open success arrives after timeout', async () => {
  const factory = new IDBFactory()
  let resumeOpen!: () => void
  const resume = new Promise<void>((resolve) => {
    resumeOpen = resolve
  })
  let removed!: () => void
  const deleted = new Promise<void>((resolve) => {
    removed = resolve
  })
  const report = await probeCompatibility(
    {
      ...healthy(),
      indexedDB: {
        open: (name: string, version: number) => {
          const request = factory.open(name, version)
          const delayed = {
            get result() {
              return request.result
            },
            get transaction() {
              return request.transaction
            },
            get error() {
              return request.error
            },
            onupgradeneeded: null as ((event: IDBVersionChangeEvent) => void) | null,
            onsuccess: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onblocked: null as (() => void) | null,
          }
          request.onupgradeneeded = (event) => delayed.onupgradeneeded?.(event)
          request.onerror = () => delayed.onerror?.()
          request.onsuccess = () => {
            void resume.then(() => delayed.onsuccess?.())
          }
          return delayed
        },
        deleteDatabase: (name: string) => {
          const request = factory.deleteDatabase(name)
          request.addEventListener('success', () => removed())
          return request
        },
      },
    },
    { timeoutMs: 100 },
  )
  assert.equal(report.checks.find((item) => item.id === 'indexedDB')?.status, 'error')
  resumeOpen()
  await deleted
  assert.deepEqual(await factory.databases(), [])
})

test('a quota request that never resolves produces a bounded warning', async () => {
  const report = await probeCompatibility(
    {
      ...healthy(),
      navigator: { storage: { estimate: () => new Promise(() => {}) } },
    },
    { timeoutMs: 100 },
  )
  const check = report.checks.find((item) => item.id === 'storageQuota')!
  assert.equal(check.status, 'warning')
  assert.match(check.detail, /超时/)
  assert.equal(report.ready, true)
})

test('throwing browser capability getters become diagnostic failures', async () => {
  const environment = Object.defineProperties(
    {},
    Object.fromEntries(
      [
        'isSecureContext',
        'crossOriginIsolated',
        'SharedArrayBuffer',
        'WebAssembly',
        'document',
        'indexedDB',
        'navigator',
      ].map((key) => [
        key,
        {
          get() {
            throw new DOMException('Denied', 'SecurityError')
          },
        },
      ]),
    ),
  )
  const report = await probeCompatibility(environment)
  assert.equal(report.ready, false)
  assert.deepEqual(
    report.checks.map((check) => check.status),
    ['error', 'error', 'error', 'error', 'error', 'warning'],
  )
})

test('releases the temporary WebGL context after checking support', async () => {
  let released = false
  const report = await probeCompatibility({
    ...healthy(),
    document: {
      createElement: () => ({
        getContext: (kind: string) =>
          kind === 'webgl2'
            ? {
                getExtension: (name: string) => {
                  if (name === 'WEBGL_lose_context')
                    return {
                      loseContext: () => {
                        released = true
                      },
                    }
                  return null
                },
              }
            : null,
      }),
    },
  })
  assert.equal(report.checks.find((item) => item.id === 'webgl')?.status, 'ok')
  assert.equal(released, true)
})

test('explains missing deployment prerequisites', async () => {
  const report = await probeCompatibility({
    isSecureContext: true,
    crossOriginIsolated: false,
    document: { createElement: () => ({ getContext: () => null }) },
  })
  assert.equal(report.ready, false)
  assert.equal(report.checks.find((check) => check.id === 'isolation')?.status, 'error')
  assert.match(report.checks.find((check) => check.id === 'isolation')?.action || '', /COOP/)
  assert.equal(report.checks.find((check) => check.id === 'storageQuota')?.status, 'warning')
})

test('startup prerequisites distinguish insecure LAN access from missing isolation headers', () => {
  const insecure = checkRuntimePrerequisites({
    ...healthy(),
    isSecureContext: false,
    crossOriginIsolated: false,
  })
  const missingHeaders = checkRuntimePrerequisites({ ...healthy(), crossOriginIsolated: false })
  assert.equal(insecure.ready, false)
  assert.match(insecure.checks[0].detail, /不是安全上下文/)
  assert.match(insecure.checks[0].action || '', /手机.*HTTP/)
  assert.match(missingHeaders.checks[0].detail, /未启用跨源隔离/)
  assert.match(missingHeaders.checks[0].action || '', /COOP/)
})

test('startup checks are synchronous and never access storage permissions', () => {
  const environment = Object.defineProperties(healthy(), {
    indexedDB: {
      get() {
        throw new Error('startup must not probe IndexedDB')
      },
    },
    navigator: {
      get() {
        throw new Error('startup must not estimate storage')
      },
    },
  })
  const report = checkRuntimePrerequisites(environment)
  assert.equal(report.ready, true)
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ['isolation', 'sharedArrayBuffer', 'wasm', 'webgl'],
  )
})

test('startup identifies unavailable SharedArrayBuffer and WebAssembly separately', () => {
  for (const [api, id] of [
    ['SharedArrayBuffer', 'sharedArrayBuffer'],
    ['WebAssembly', 'wasm'],
  ] as const) {
    const report = checkRuntimePrerequisites({ ...healthy(), [api]: undefined })
    assert.equal(report.ready, false)
    assert.deepEqual(
      report.checks.filter((check) => check.status === 'error').map((check) => check.id),
      [id],
    )
    assert.ok(report.checks.find((check) => check.id === id)?.action)
  }
})

test('a WebGL 1 only browser uses the Canvas 2D compatibility renderer', () => {
  const requested: string[] = []
  const report = checkRuntimePrerequisites({
    ...healthy(),
    document: {
      createElement: () => ({
        getContext: (kind: string) => {
          requested.push(kind)
          if (kind === 'webgl') return {}
          if (kind === '2d') return { createImageData() {}, putImageData() {} }
          return null
        },
      }),
    },
  })
  assert.equal(report.ready, true)
  assert.equal(report.renderingBackend, 'canvas2d')
  assert.deepEqual(requested, ['webgl2', 'webgl', '2d'])
  const check = report.checks.find((item) => item.id === 'webgl')!
  assert.equal(check.status, 'warning')
  assert.match(check.detail, /WebGL 1.*Canvas 2D/)
})

test('a browser without WebGL uses Canvas 2D and remains ready', () => {
  const report = checkRuntimePrerequisites({
    ...healthy(),
    document: {
      createElement: () => ({
        getContext: (kind: string) =>
          kind === '2d' ? { createImageData() {}, putImageData() {} } : null,
      }),
    },
  })
  assert.equal(report.ready, true)
  assert.equal(report.renderingBackend, 'canvas2d')
  const check = report.checks.find((item) => item.id === 'webgl')!
  assert.equal(check.status, 'warning')
  assert.match(check.detail, /WebGL 不可用.*Canvas 2D/)
})

test('a browser without any drawing context still fails clearly', () => {
  const report = checkRuntimePrerequisites({
    ...healthy(),
    document: { createElement: () => ({ getContext: () => null }) },
  })
  assert.equal(report.ready, false)
  assert.equal(report.renderingBackend, 'none')
  const check = report.checks.find((item) => item.id === 'webgl')!
  assert.equal(check.status, 'error')
  assert.match(check.detail, /WebGL.*Canvas 2D/)
})

test('software WebGL 2 is allowed with a performance warning', () => {
  const report = checkRuntimePrerequisites({
    ...healthy(),
    document: {
      createElement: () => ({
        getContext: (kind: string) =>
          kind === 'webgl2'
            ? {
                getExtension: (name: string) =>
                  name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null,
                getParameter: () => 'ANGLE (SwiftShader Device)',
              }
            : null,
      }),
    },
  })
  assert.equal(report.ready, true)
  assert.equal(report.renderingBackend, 'webgl2')
  const check = report.checks.find((item) => item.id === 'webgl')!
  assert.equal(check.status, 'warning')
  assert.match(check.detail, /软件渲染/)
})
