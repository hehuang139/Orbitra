// Integration tests against real mGBA, real WebAssembly threads, and our original ROM.
// Start Vite first. Install playwright or set PLAYWRIGHT_MODULE to its index.mjs.
// Optional: ENGINE_TEST_URL, BROWSER_EXECUTABLE_PATH, ENGINE_SCREENSHOT_PATH.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createGameBoyTestRom } from './game-boy-test-rom.mjs'
import { verifyStartup } from './test-core-startup.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))

const inspectFrame = () =>
  page.evaluate(async () => {
    const bitmap = await createImageBitmap(await window.emulator.screenshot())
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = surface.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const { data } = context.getImageData(0, 0, surface.width, surface.height)
    let checksum = 0
    let min = 255
    let max = 0
    for (let index = 0; index < data.length; index += 4) {
      const luminance = data[index] + data[index + 1] + data[index + 2]
      min = Math.min(min, data[index], data[index + 1], data[index + 2])
      max = Math.max(max, data[index], data[index + 1], data[index + 2])
      checksum = (checksum + luminance * (index + 1)) >>> 0
    }
    return { width: surface.width, height: surface.height, checksum, range: max - min }
  })

try {
  const url = process.env.ENGINE_TEST_URL || 'http://127.0.0.1:5173'
  await page.goto(`${url}/src/emulator/verify.html`)
  await page.waitForFunction(() => !!window.emulator)
  assert.equal(
    await page.evaluate(() => crossOriginIsolated),
    true,
    'COOP/COEP must enable threads',
  )
  const firstFrame = await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/demo/star-orbit.gba')).arrayBuffer())
    await window.emulator.loadRom(bytes, 'star-orbit.gba', 'gba')
    // No FPS wait or arbitrary startup delay: the adapter's load promise must
    // make an immediate pause, state capture and SRAM export safe.
    window.emulator.pause()
    const state = await window.emulator.saveState()
    const battery = await window.emulator.exportSave()
    window.emulator.resume()
    return { stateSize: state.length, battery: battery ? Array.from(battery.slice(0, 5)) : null }
  })
  assert.ok(firstFrame.stateSize > 1000, 'loadRom must support an immediate state capture')
  assert.deepEqual(
    firstFrame.battery,
    [83, 79, 1, 0, 255],
    'loadRom must execute ROM initialization before resolving',
  )
  assert.equal(await page.evaluate(() => window.emulator.status), 'running')
  await page.waitForFunction(() => window.fps > 25, undefined, { timeout: 10000 })
  const normalFps = await page.evaluate(() => window.fps)

  // Read the actual core framebuffer. Identify only the mint-colored ship in
  // the playfield, excluding both HUD lines, to prove CPU input changes pixels.
  const shipPosition = () =>
    page.evaluate(async () => {
      const bitmap = await createImageBitmap(await window.emulator.screenshot())
      const surface = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = surface.getContext('2d')
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const { data } = context.getImageData(0, 0, surface.width, surface.height)
      let count = 0,
        totalX = 0,
        totalY = 0
      for (let y = 30; y < 140; y++) {
        for (let x = 0; x < 240; x++) {
          const offset = (y * 240 + x) * 4
          if (data[offset] < 180 && data[offset + 1] > 190 && data[offset + 2] > 130) {
            totalX += x
            totalY += y
            count++
          }
        }
      }
      return {
        x: totalX / count,
        y: totalY / count,
        count,
        width: surface.width,
        height: surface.height,
      }
    })

  await page.evaluate(async () => {
    window.emulator.pause()
    window.savedState = await window.emulator.saveState()
  })
  const start = await shipPosition()
  assert.equal(start.width, 240)
  assert.equal(start.height, 160)
  assert.ok(start.count > 5, 'ROM must render its mint-colored ship')
  const stateSize = await page.evaluate(() => window.savedState.length)
  assert.ok(stateSize > 1000, 'a real state must contain CPU and memory data')

  await page.evaluate(() => {
    window.emulator.resume()
    window.emulator.keyDown('Right')
  })
  await page.waitForTimeout(350)
  await page.evaluate(() => {
    window.emulator.keyUp('Right')
    window.emulator.pause()
  })
  const moved = await shipPosition()
  assert.ok(moved.x > start.x + 10, `Right input must move the ship: ${start.x} -> ${moved.x}`)

  await page.evaluate(async () => {
    await window.emulator.loadState(window.savedState)
    window.emulator.resume()
  })
  await page.waitForTimeout(70)
  await page.evaluate(() => window.emulator.pause())
  const restored = await shipPosition()
  assert.ok(Math.abs(restored.x - start.x) < 2, 'loading state must restore position')

  await page.evaluate(() => {
    window.emulator.resume()
    window.emulator.keyDown('Right')
  })
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    window.emulator.keyUp('Right')
    window.emulator.pause()
  })
  const beforeRewind = await shipPosition()
  await page.evaluate(() => {
    window.emulator.resume()
    window.emulator.setRewind(true)
  })
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    window.emulator.setRewind(false)
    window.emulator.pause()
  })
  const rewound = await shipPosition()
  assert.ok(
    rewound.x < beforeRewind.x - 5,
    `rewind must restore older frames: ${beforeRewind.x} -> ${rewound.x}`,
  )

  await page.evaluate(() => {
    window.emulator.setSpeed(2)
    window.emulator.resume()
    window.fps = 0
  })
  await page.waitForFunction(() => window.fps > 80, undefined, { timeout: 10000 })
  const fastFps = await page.evaluate(() => window.fps)
  await page.evaluate(() => {
    window.emulator.setSpeed(1)
    window.emulator.pause()
  })

  const saveData = await page.evaluate(async () => {
    const battery = await window.emulator.exportSave()
    if (!battery) return null
    const before = window.saveChanges || 0
    await window.emulator.exportSave()
    return { size: battery.length, before, after: window.saveChanges || 0 }
  })
  if (saveData) {
    assert.equal(
      saveData.before,
      saveData.after,
      'unchanged battery data must not fire onSaveChange',
    )
    assert.ok(saveData.size >= 512)
    const imported = await page.evaluate(async () => {
      const battery = await window.emulator.exportSave()
      // The original demo persists its score in a tiny, documented SRAM record.
      battery.set([83, 79, 1, 7, 248])
      await window.emulator.importSave(battery)
      const exported = await window.emulator.exportSave()
      return Array.from(exported.slice(0, 5))
    })
    assert.deepEqual(
      imported,
      [83, 79, 1, 7, 248],
      'battery import must reach the emulated cartridge SRAM',
    )
    assert.equal(
      await page.evaluate(() => window.emulator.status),
      'paused',
      'import preserves pause state',
    )
  }

  // Exercise the public APIs while the native CPU is running. The normal ship
  // assertions above deliberately capture paused frames, which missed races
  // between synchronous native state access and framebuffer/audio callbacks.
  await page.evaluate(() => window.emulator.resume())
  const runningSnapshots = []
  for (let round = 0; round < 8; round++) {
    console.log(`Engine: running save/screenshot/load/SRAM round ${round + 1}/8`)
    const result = await page.evaluate(async () => {
      const emulator = window.emulator
      const statuses = [emulator.status]
      const state = await emulator.saveState()
      statuses.push(emulator.status)
      const png = await emulator.screenshot()
      statuses.push(emulator.status)
      await emulator.loadState(state)
      statuses.push(emulator.status)
      const battery = await emulator.exportSave()
      statuses.push(emulator.status)
      const bitmap = await createImageBitmap(png)
      const dimensions = [bitmap.width, bitmap.height]
      bitmap.close()
      return {
        statuses,
        stateSize: state.length,
        screenshotSize: png.size,
        dimensions,
        batterySize: battery?.length ?? 0,
        batteryRecord: battery ? Array.from(battery.slice(0, 5)) : null,
      }
    })
    assert.deepEqual(
      result.statuses,
      Array(5).fill('running'),
      'native snapshots must preserve running status',
    )
    assert.ok(
      result.stateSize > 1000,
      'running state capture must contain real CPU and memory data',
    )
    assert.ok(result.screenshotSize > 100, 'running screenshot must contain an encoded image')
    assert.deepEqual(
      result.dimensions,
      [240, 160],
      'running screenshot must decode as a full GBA frame',
    )
    assert.ok(result.batterySize >= 512, 'running SRAM export must contain cartridge save memory')
    assert.deepEqual(
      result.batteryRecord.slice(0, 3),
      [83, 79, 1],
      'SRAM record must retain its Star Orbit signature',
    )
    assert.equal(
      result.batteryRecord[3] + result.batteryRecord[4],
      255,
      'SRAM score checksum must remain valid',
    )
    runningSnapshots.push(result)
  }
  await page.evaluate(() => {
    window.fps = 0
  })
  await page.waitForFunction(() => window.fps > 0, undefined, { timeout: 10000 })
  const snapshotsResumedFps = await page.evaluate(() => window.fps)
  const pausedSnapshot = await page.evaluate(async () => {
    const emulator = window.emulator
    emulator.pause()
    const statuses = [emulator.status]
    const state = await emulator.saveState()
    statuses.push(emulator.status)
    await emulator.screenshot()
    statuses.push(emulator.status)
    await emulator.loadState(state)
    statuses.push(emulator.status)
    await emulator.exportSave()
    statuses.push(emulator.status)
    return { statuses, stateSize: state.length }
  })
  assert.deepEqual(
    pausedSnapshot.statuses,
    Array(5).fill('paused'),
    'native snapshots must never resume a paused game',
  )
  assert.ok(pausedSnapshot.stateSize > 1000)

  await page.evaluate(() => window.emulator.reset())
  assert.equal(await page.evaluate(() => window.emulator.status), 'paused')

  const handhelds = []
  for (const platform of ['gb', 'gbc']) {
    const rom = createGameBoyTestRom({ color: platform === 'gbc' })
    await page.evaluate(
      async ({ bytes, name, platform }) => {
        window.fps = 0
        await window.emulator.loadRom(new Uint8Array(bytes), name, platform)
      },
      { bytes: Array.from(rom), name: `advance-test.${platform}`, platform },
    )
    await page.waitForFunction(() => window.fps > 25, undefined, { timeout: 10000 })
    const platformFps = await page.evaluate(() => window.fps)
    const initial = await inspectFrame()
    assert.deepEqual(
      { width: initial.width, height: initial.height },
      { width: 160, height: 144 },
      `${platform.toUpperCase()} must use its native framebuffer size`,
    )
    assert.ok(initial.range > 20, `${platform.toUpperCase()} must render visible tile graphics`)
    const stateSize = await page.evaluate(async () => {
      window.emulator.pause()
      const state = await window.emulator.saveState()
      await window.emulator.loadState(state)
      window.emulator.resume()
      return state.length
    })
    assert.ok(stateSize > 1000, `${platform.toUpperCase()} must create a real mGBA state`)
    const saveMarker = platform === 'gb' ? 11 : 19
    const saveData = await page.evaluate(async (marker) => {
      const battery = await window.emulator.exportSave()
      if (!battery) return null
      battery.set([marker, marker ^ 255], 3)
      await window.emulator.importSave(battery)
      const restored = await window.emulator.exportSave()
      return { size: restored?.length, marker: Array.from(restored?.slice(0, 5) || []) }
    }, saveMarker)
    assert.deepEqual(
      saveData,
      { size: 8 * 1024, marker: [83, 79, 1, saveMarker, saveMarker ^ 255] },
      `${platform.toUpperCase()} battery saves must survive a core reload`,
    )
    await page.evaluate(() => window.emulator.keyDown('Right'))
    await page.waitForTimeout(120)
    const pressed = await inspectFrame()
    const pressedMarker = await page.evaluate(async () => (await window.emulator.exportSave())?.[5])
    await page.evaluate(() => window.emulator.keyUp('Right'))
    await page.waitForTimeout(60)
    const releasedMarker = await page.evaluate(
      async () => (await window.emulator.exportSave())?.[5],
    )
    assert.deepEqual(
      { pressedMarker, releasedMarker },
      { pressedMarker: 0x1a, releasedMarker: 0xe4 },
      `${platform.toUpperCase()} input must reach the emulated joypad and release cleanly`,
    )
    if (platform === 'gb')
      assert.notEqual(pressed.checksum, initial.checksum, 'GB input must update the rendered frame')
    handhelds.push({ platform, fps: platformFps, stateSize, saveData, initial, pressed })
  }
  if (process.env.ENGINE_SCREENSHOT_PATH)
    await page.screenshot({ path: process.env.ENGINE_SCREENSHOT_PATH })
  await page.evaluate(() => window.emulator.dispose())
  assert.equal(await page.evaluate(() => window.emulator.status), 'disposed')
  await page.waitForTimeout(200)
  assert.equal(page.workers().length, 0, 'disposal must terminate every emulation worker')
  // Deterministic regression for a queued ScriptProcessor callback from the
  // previous cartridge. Without the audio-instance guard this invokes a freed
  // native pointer, producing divide-by-zero or out-of-bounds WebAssembly errors.
  const audioGuard = await page.evaluate(async () => {
    const { default: createCore } = await import('/emulator/mgba.js')
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    const core = await createCore({ canvas, print: () => {} })
    const wait = () => new Promise((resolve) => setTimeout(resolve, 150))
    try {
      for (const directory of [
        '/data',
        '/data/games',
        '/data/saves',
        '/data/states',
        '/data/cheats',
        '/data/screenshots',
        '/data/patches',
        '/autosave',
      ])
        core.FS.mkdir(directory)
      core.setCoreSettings({ autoSaveStateEnable: false, restoreAutoSaveStateOnLoad: false })
      core.FS.writeFile(
        '/data/games/test.gba',
        new Uint8Array(await (await fetch('/demo/star-orbit.gba')).arrayBuffer()),
      )
      core.loadGame('/data/games/test.gba')
      await wait()
      const oldAudio = core.SDL2.audio
      const staleCallback = oldAudio.scriptProcessorNode.onaudioprocess
      core.quitGame()
      core.loadGame('/data/games/test.gba')
      await wait()
      if (core.SDL2.audio === oldAudio) throw new Error('test requires a new audio instance')
      staleCallback({
        outputBuffer: core.SDL2.audioContext.createBuffer(
          2,
          1024,
          core.SDL2.audioContext.sampleRate,
        ),
      })
      return {
        staleCallbackIgnored: true,
        oldHandlerRemoved: oldAudio.scriptProcessorNode.onaudioprocess === null,
      }
    } finally {
      core.hostDispose()
      canvas.remove()
    }
  })
  assert.deepEqual(audioGuard, { staleCallbackIgnored: true, oldHandlerRemoved: true })
  for (let attempt = 0; attempt < 20 && page.workers().length; attempt++)
    await page.waitForTimeout(50)
  assert.equal(page.workers().length, 0, 'audio regression core must also release all workers')
  const startup = await verifyStartup(browser, url)
  assert.deepEqual(errors, [], 'no browser runtime errors')
  const snapshots = {
    rounds: runningSnapshots.length,
    first: runningSnapshots[0],
    last: runningSnapshots.at(-1),
    resumedFps: snapshotsResumedFps,
    paused: pausedSnapshot,
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        firstFrame,
        startup,
        normalFps,
        fastFps,
        stateSize,
        start,
        moved,
        restored,
        beforeRewind,
        rewound,
        saveData,
        snapshots,
        handhelds,
        audioGuard,
        workersAfterDispose: page.workers().length,
      },
      null,
      2,
    ),
  )
} catch (error) {
  const artifacts = new URL('../.artifacts/', import.meta.url)
  await mkdir(artifacts, { recursive: true })
  await page
    .screenshot({ path: fileURLToPath(new URL('engine-failure.png', artifacts)), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await browser.close()
}
