import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const assets = [
  {
    file: path.join(root, 'public', 'emulator', 'mgba.wasm'),
    notice: path.join(root, 'public', 'emulator', 'NOTICE.md'),
    marker: 'Original WebAssembly SHA-256:',
  },
  ...[
    'src/emulator.js',
    'src/GameManager.js',
    'cores/fceumm-legacy-wasm.data',
    'cores/snes9x-legacy-wasm.data',
  ].map((name) => ({
    file: path.join(root, 'public', 'emulatorjs', ...name.split('/')),
    notice: path.join(root, 'public', 'emulatorjs', 'NOTICE.md'),
    marker: `\`${name}\`:`,
  })),
  {
    file: path.join(root, 'public', 'dolphin', 'cores', 'dolphin', 'dolphin-core-upstream.wasm'),
    notice: path.join(root, 'public', 'dolphin', 'NOTICE.md'),
    marker: '`cores/dolphin/dolphin-core-upstream.wasm`',
  },
]

function fail(message) {
  console.error(`Core asset verification failed: ${message}`)
  process.exitCode = 1
}

try {
  for (const asset of assets) {
    const [notice, bytes] = await Promise.all([
      readFile(asset.notice, 'utf8'),
      readFile(asset.file),
    ])
    const name = path.relative(root, asset.file).replaceAll('\\', '/')
    const markerAt = notice.indexOf(asset.marker)
    const match =
      markerAt < 0 ? null : notice.slice(markerAt, markerAt + 160).match(/[0-9a-f]{64}/i)
    if (!match) throw new Error(`${name} has no SHA-256 value in its NOTICE.md.`)
    const expected = match[0].toLowerCase()
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      throw new Error(`${name} hash mismatch (expected ${expected}, got ${actual}).`)
    }
    console.log(`Core asset verified: ${name} SHA-256 ${actual}`)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
