import assert from 'node:assert/strict'

const url = new URL(process.env.DEPLOYMENT_TEST_URL || 'http://127.0.0.1:8080')
assert.equal(url.pathname, '/', 'deployment must use the site root')

const checked = []
async function request(path, { status = 200, contentType, immutable = false } = {}) {
  const response = await fetch(new URL(path, url), {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  assert.equal(response.status, status, `${path}: status`)
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', `${path}: COOP`)
  assert.equal(
    response.headers.get('cross-origin-embedder-policy'),
    'require-corp',
    `${path}: COEP`,
  )
  if (contentType) {
    assert.equal(response.headers.get('content-type')?.split(';')[0], contentType, `${path}: MIME`)
  }
  const cache = response.headers.get('cache-control') || ''
  if (status === 200) {
    if (immutable) {
      assert.match(cache, /max-age=31536000/, `${path}: long-lived cache`)
      assert.match(cache, /immutable/, `${path}: immutable cache`)
    } else {
      assert.match(cache, /(?:no-cache|no-store)/, `${path}: revalidated cache`)
    }
  } else {
    assert.doesNotMatch(cache, /immutable/, `${path}: errors must not be immutable`)
  }
  checked.push(path)
  return response
}

const html = await (await request('/', { contentType: 'text/html' })).text()
assert.match(html, /<title>Orbitra/, 'the application must replace the Nginx welcome page')
assert.equal(await (await request('/index.html', { contentType: 'text/html' })).text(), html)
assert.equal(
  await (await request('/deployment-smoke/route', { contentType: 'text/html' })).text(),
  html,
  'extensionless navigation must fall back to the application',
)

// Use the same generated entry references as the dependency-free offline shell.
const assets = [
  ...new Set(
    [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]),
  ),
]
assert.ok(
  assets.some((asset) => asset.endsWith('.js')),
  'a built JavaScript entry must be present',
)
assert.ok(
  assets.some((asset) => asset.endsWith('.css')),
  'a built stylesheet must be present',
)
for (const asset of assets) {
  const contentType = asset.endsWith('.js') ? 'application/javascript' : 'text/css'
  await (await request(asset, { contentType, immutable: true })).arrayBuffer()
}

const wasm = await (
  await request('/emulator/mgba.wasm', { contentType: 'application/wasm' })
).arrayBuffer()
assert.deepEqual(
  [...new Uint8Array(wasm, 0, 4)],
  [0, 97, 115, 109],
  'the real WASM binary is served',
)
for (const path of ['/emulator/mgba.js', '/emulator/host-sync.js', '/sw.js']) {
  await (await request(path, { contentType: 'application/javascript' })).text()
}
for (const path of ['/emulatorjs/src/emulator.js', '/emulatorjs/src/GameManager.js']) {
  await (await request(path, { contentType: 'application/javascript' })).text()
}
for (const path of [
  '/emulatorjs/cores/fceumm-legacy-wasm.data',
  '/emulatorjs/cores/snes9x-legacy-wasm.data',
]) {
  assert.ok(
    (await (await request(path, { contentType: 'application/octet-stream' })).arrayBuffer())
      .byteLength > 0,
    `${path}: core data must not be empty`,
  )
}
await (await request('/fonts/dm-sans.ttf', { contentType: 'font/ttf' })).arrayBuffer()
const rom = await (
  await request('/demo/star-orbit.gba', { contentType: 'application/octet-stream' })
).arrayBuffer()
assert.ok(rom.byteLength >= 192, 'the homebrew demo must be bundled')
const manifest = await (
  await request('/manifest.webmanifest', { contentType: 'application/manifest+json' })
).json()
assert.equal(manifest.scope, '/')
assert.equal(manifest.start_url, '/')
assert.equal(await (await request('/healthz', { contentType: 'text/plain' })).text(), 'ok\n')

for (const path of [
  '/licenses/LICENSE',
  '/licenses/THIRD_PARTY_NOTICES.md',
  '/licenses/DEPENDENCIES.txt',
  '/emulator/LICENSE-MPL-2.0.txt',
  '/emulator/NOTICE.md',
  '/emulatorjs/LICENSE-FCEUMM-GPL-2.0.txt',
  '/emulatorjs/LICENSE-GPL-3.0.txt',
  '/emulatorjs/LICENSE-SNES9X.txt',
  '/emulatorjs/NOTICE.md',
  '/fonts/OFL.txt',
  '/demo/LICENSE.txt',
]) {
  assert.ok((await (await request(path)).text()).length > 0, `${path}: notices must be retained`)
}

for (const path of [
  '/assets/missing.js',
  '/emulator/missing.wasm',
  '/emulatorjs/missing.data',
  '/fonts/missing.ttf',
  '/demo/missing.gba',
  '/licenses/missing.txt',
  '/missing.css',
]) {
  await (await request(path, { status: 404 })).text()
}

console.log(JSON.stringify({ passed: true, url: url.href, checked }, null, 2))
