/*
 * Orbitra offline shell. Keep this file dependency-free: it is served from
 * public/ and must be installable before the Vite bundle is available.
 */
const CACHE_VERSION = 'advance-shell-v5'
// Keep the legacy prefix so upgrades remove older Advance caches instead of orphaning them.
const CACHE_PREFIX = 'advance-'
const CORE_ASSETS = [
  '/favicon.svg',
  '/manifest.webmanifest',
  '/emulator/mgba.js',
  '/emulator/mgba.wasm',
  '/emulator/host-sync.js',
  '/emulatorjs/emulator.css',
  '/emulatorjs/src/emulator.js',
  '/emulatorjs/src/nipplejs.js',
  '/emulatorjs/src/shaders.js',
  '/emulatorjs/src/storage.js',
  '/emulatorjs/src/gamepad.js',
  '/emulatorjs/src/GameManager.js',
  '/emulatorjs/src/socket.io.min.js',
  '/emulatorjs/src/compression.js',
  '/emulatorjs/compression/extract7z.js',
  '/emulatorjs/cores/reports/fceumm.json',
  '/emulatorjs/cores/reports/snes9x.json',
  '/emulatorjs/cores/fceumm-legacy-wasm.data',
  '/emulatorjs/cores/snes9x-legacy-wasm.data',
  '/fonts/dm-sans.ttf',
]

const isSameOrigin = (request) => new URL(request.url).origin === self.location.origin
const isAppAsset = (url) =>
  url.pathname.startsWith('/assets/') ||
  url.pathname.startsWith('/emulator/') ||
  url.pathname.startsWith('/emulatorjs/') ||
  url.pathname.startsWith('/fonts/')

async function appShellUrls() {
  const urls = ['/']
  try {
    const response = await fetch('/index.html', { cache: 'no-store' })
    if (!response.ok) return urls
    const html = await response.text()
    // Vite emits absolute /assets/*.js and /assets/*.css references.
    for (const match of html.matchAll(/(?:src|href)=["'](\/[^"']+)["']/g)) {
      if (match[1].startsWith('/assets/')) urls.push(match[1])
    }
  } catch {
    // The shell can still install with the fixed core assets when offline.
  }
  return [...new Set(urls)]
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION)
      const urls = [...new Set([...(await appShellUrls()), ...CORE_ASSETS])]
      await cache.addAll(urls)
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

async function isolatedDocument(response) {
  if (!response || !response.ok) return response
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || !isSameOrigin(request)) return
  const url = new URL(request.url)

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_VERSION)
        try {
          const network = await fetch(request)
          if (network.ok) {
            await cache.put('/index.html', network.clone())
            await cache.put('/', network.clone())
          }
          return isolatedDocument(network)
        } catch {
          const cached = (await cache.match('/index.html')) || (await cache.match('/'))
          if (!cached) return Response.error()
          return isolatedDocument(cached)
        }
      })(),
    )
    return
  }

  if (!isAppAsset(url)) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION)
      const cached = await cache.match(request)
      if (cached) return cached
      try {
        const response = await fetch(request)
        if (response.ok) await cache.put(request, response.clone())
        return response
      } catch {
        return cached || Response.error()
      }
    })(),
  )
})
