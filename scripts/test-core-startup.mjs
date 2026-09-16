import assert from 'node:assert/strict'

// The real worker and ROM run normally. Only delivery of the host's frame
// callback is gated, proving that pthread existence or elapsed time cannot
// make the adapter accept operations before it observes an initialized frame.
const gatedCore = `
import createCore from '/emulator/mgba.js?startup-regression-core'
export default async function createGatedCore(options) {
  const core = await createCore(options)
  window.startupCore = core
  const addCallbacks = core.addCoreCallbacks
  core.addCoreCallbacks = (callbacks) => addCallbacks({
    ...callbacks,
    videoFrameEndedCallback: () => {
      if (window.holdStartupFrames) { window.heldStartupFrames++; return }
      callbacks.videoFrameEndedCallback?.()
    },
  })
  return core
}`

export async function verifyStartup(browser, url) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Only wrap the adapter import; workers must load their original module and
  // isolation response headers unchanged.
  await page.route(
    `${url}/emulator/mgba.js`,
    (route) => route.fulfill({ contentType: 'application/javascript', body: gatedCore }),
    { times: 1 },
  )
  try {
    await page.goto(`${url}/src/emulator/verify.html`)
    await page.waitForFunction(() => !!window.emulator)
    await page.evaluate(async () => {
      window.holdStartupFrames = true
      window.heldStartupFrames = 0
      const bytes = new Uint8Array(await (await fetch('/demo/star-orbit.gba')).arrayBuffer())
      window.startupResult = null
      window.pendingStartup = window.emulator.loadRom(bytes, 'star-orbit.gba', 'gba').then(
        () => {
          window.startupResult = 'loaded'
        },
        (error) => {
          window.startupResult = error.message
        },
      )
    })
    await page.waitForFunction(
      () => window.heldStartupFrames >= 3 && window.startupCore.hostIsGameReady(),
    )
    const beforeFrame = await page.evaluate(async () => {
      const denied = []
      for (const operation of ['saveState', 'exportSave']) {
        try {
          await window.emulator[operation]()
        } catch (error) {
          denied.push(error.message)
        }
      }
      return {
        status: window.emulator.status,
        result: window.startupResult,
        denied,
        changes: window.saveChanges || 0,
      }
    })
    assert.equal(beforeFrame.status, 'loading')
    assert.equal(beforeFrame.result, null, 'load must remain pending without its frame callback')
    assert.equal(beforeFrame.changes, 0, 'startup must not publish uninitialized battery data')
    assert.equal(beforeFrame.denied.length, 2)
    assert.ok(beforeFrame.denied.every((message) => /请先载入/.test(message)))
    await page.evaluate(async () => {
      window.holdStartupFrames = false
      await window.pendingStartup
      window.emulator.pause()
    })
    assert.equal(await page.evaluate(() => window.emulator.status), 'paused')
    assert.equal(
      await page.evaluate(
        () => window.startupCore.FS.analyzePath('/data/states/current.ss2').exists,
      ),
      false,
      'battery snapshots remove their private slot',
    )

    await page.evaluate(async () => {
      const battery = await window.emulator.exportSave()
      battery.set([83, 79, 1, 9, 246])
      window.holdStartupFrames = true
      window.heldStartupFrames = 0
      window.startupResult = null
      window.pendingStartup = window.emulator.importSave(battery).then(
        () => {
          window.startupResult = 'imported'
        },
        (error) => {
          window.startupResult = error.message
        },
      )
    })
    await page.waitForFunction(() => window.heldStartupFrames >= 3)
    assert.equal(
      await page.evaluate(() => window.emulator.status),
      'loading',
      'a prior cartridge frame cannot satisfy import startup',
    )
    assert.equal(await page.evaluate(() => window.startupResult), null)
    const imported = await page.evaluate(async () => {
      window.holdStartupFrames = false
      await window.pendingStartup
      const battery = await window.emulator.exportSave()
      return { status: window.emulator.status, battery: Array.from(battery.slice(0, 5)) }
    })
    assert.deepEqual(imported, { status: 'paused', battery: [83, 79, 1, 9, 246] })
    const failedSnapshot = await page.evaluate(async () => {
      const originalState = await window.emulator.saveState()
      const filesystem = window.startupCore.FS
      const readFile = filesystem.readFile
      let message = ''
      let switchError = ''
      let pauseStatus = ''
      let loadStateStatus = ''
      const eventsBefore = window.events.length
      filesystem.readFile = (path) =>
        path === '/data/states/current.ss2' ? new Uint8Array([0]) : readFile(path)
      try {
        try {
          await window.emulator.exportSave()
        } catch (error) {
          message = error.message
        }
        window.emulator.resume()
        window.emulator.pause()
        pauseStatus = window.emulator.status
        await window.emulator.loadState(originalState)
        loadStateStatus = window.emulator.status
        window.emulator.resume()
        const rom = new Uint8Array(await (await fetch('/demo/star-orbit.gba')).arrayBuffer())
        try {
          await window.emulator.loadRom(rom, 'must-not-replace.gba', 'gba')
        } catch (error) {
          switchError = error.message
        }
      } finally {
        filesystem.readFile = readFile
      }
      const kept = readFile('/data/states/current.ss1')
      return {
        message,
        switchError,
        pauseStatus,
        loadStateStatus,
        switchStatus: window.emulator.status,
        switchName: window.emulator.romName,
        notifications: window.events
          .slice(eventsBefore)
          .filter(([event]) => event === 'error')
          .map(([, detail]) => detail),
        cleaned: !filesystem.analyzePath('/data/states/current.ss2').exists,
        stateUnchanged:
          kept.length === originalState.length &&
          kept.every((byte, index) => byte === originalState[index]),
      }
    })
    assert.match(failedSnapshot.message, /电池存档快照/)
    assert.equal(
      failedSnapshot.pauseStatus,
      'paused',
      'a backup error cannot leave a paused native game marked running',
    )
    assert.equal(
      failedSnapshot.loadStateStatus,
      'paused',
      'a completed state restore remains successful after an auxiliary backup failure',
    )
    assert.equal(failedSnapshot.notifications.length, 2)
    assert.ok(failedSnapshot.notifications.every((message) => /电池存档同步失败/.test(message)))
    assert.match(failedSnapshot.switchError, /电池存档快照/)
    assert.equal(failedSnapshot.switchStatus, 'paused')
    assert.equal(
      failedSnapshot.switchName,
      'star-orbit.gba',
      'an uncaptured cartridge is retained when switching fails',
    )
    assert.equal(
      failedSnapshot.cleaned,
      true,
      'a failed battery snapshot removes its temporary file',
    )
    assert.equal(
      failedSnapshot.stateUnchanged,
      true,
      'battery capture must not overwrite the quick-save slot',
    )
    await page.evaluate(() => {
      window.fps = 0
      window.emulator.resume()
    })
    await page.waitForFunction(() => window.fps > 0, undefined, { timeout: 10000 })
    await page.evaluate(() => window.emulator.pause())

    // Fail only after a real native snapshot has been written. This exercises
    // the adapter's exception cleanup with actual CPU/audio threads still alive.
    const nativeFailures = []
    for (const initialStatus of ['running', 'paused']) {
      const failure = await page.evaluate(async (initialStatus) => {
        const emulator = window.emulator
        const core = window.startupCore
        if (initialStatus === 'running') emulator.resume()
        else emulator.pause()
        const saveState = core.saveState
        const resumeGame = core.resumeGame
        const readFile = core.FS.readFile
        let resumes = 0
        let stateError = ''
        let screenshotError = ''
        let stateStatus = ''
        core.resumeGame = () => {
          resumes++
          resumeGame()
        }
        try {
          core.saveState = (slot) => {
            const result = saveState(slot)
            if (slot === 1) throw new Error('Injected failure after native state capture')
            return result
          }
          try {
            await emulator.saveState()
          } catch (error) {
            stateError = error.message
          }
          stateStatus = emulator.status
          core.saveState = saveState
          core.FS.readFile = (path, ...options) => {
            if (path === '/data/screenshots/capture.png')
              throw new Error('Injected screenshot read failure')
            return readFile(path, ...options)
          }
          try {
            await emulator.screenshot()
          } catch (error) {
            screenshotError = error.message
          }
        } finally {
          core.saveState = saveState
          core.resumeGame = resumeGame
          core.FS.readFile = readFile
        }
        window.fps = 0
        return {
          stateError,
          screenshotError,
          stateStatus,
          screenshotStatus: emulator.status,
          resumes,
          cleaned: !core.FS.analyzePath('/data/screenshots/capture.png').exists,
        }
      }, initialStatus)
      assert.match(failure.stateError, /Injected failure after native state capture/)
      assert.match(failure.screenshotError, /Injected screenshot read failure/)
      assert.equal(
        failure.stateStatus,
        initialStatus,
        'failed state capture preserves public status',
      )
      assert.equal(
        failure.screenshotStatus,
        initialStatus,
        'failed screenshot preserves public status',
      )
      assert.equal(failure.cleaned, true, 'failed screenshot reads must remove the temporary PNG')
      if (initialStatus === 'running') {
        await page.waitForFunction(() => window.fps > 0, undefined, { timeout: 10000 })
        assert.ok(failure.resumes > 0, 'failed running snapshots resume the native CPU')
      } else {
        assert.equal(failure.resumes, 0, 'failed paused snapshots never call native resume')
      }
      nativeFailures.push({
        initialStatus,
        restoredStatus: failure.screenshotStatus,
        cleaned: failure.cleaned,
      })
    }

    // Advance the host's monotonic clock only after the real thread is ready.
    // This verifies the existing 10-second deadline without a wall-clock sleep.
    await page.evaluate(async () => {
      const battery = await window.emulator.exportSave()
      window.holdStartupFrames = true
      window.heldStartupFrames = 0
      window.startupResult = null
      window.pendingStartup = window.emulator.importSave(battery).then(
        () => {
          window.startupResult = 'unexpected success'
        },
        (error) => {
          window.startupResult = error.message
        },
      )
    })
    await page.waitForFunction(() => window.heldStartupFrames >= 3)
    await page.evaluate(async () => {
      const now = performance.now.bind(performance)
      performance.now = () => now() + 11000
      try {
        await window.pendingStartup
      } finally {
        performance.now = now
      }
    })
    assert.match(await page.evaluate(() => window.startupResult), /启动超时/)
    assert.equal(await page.evaluate(() => window.emulator.status), 'error')
    await page.evaluate(async () => {
      const bytes = new Uint8Array(await (await fetch('/demo/star-orbit.gba')).arrayBuffer())
      window.heldStartupFrames = 0
      window.startupResult = null
      window.pendingStartup = window.emulator.loadRom(bytes, 'retry.gba', 'gba').then(
        () => {
          window.startupResult = 'unexpected success'
        },
        (error) => {
          window.startupResult = error.message
        },
      )
    })
    await page.waitForFunction(() => window.heldStartupFrames >= 3)
    const cancellation = await page.evaluate(async () => {
      const before = window.saveChanges || 0
      window.emulator.dispose()
      await window.pendingStartup
      return {
        status: window.emulator.status,
        message: window.startupResult,
        before,
        after: window.saveChanges || 0,
      }
    })
    assert.equal(cancellation.status, 'disposed')
    assert.match(cancellation.message, /已关闭/)
    assert.equal(
      cancellation.before,
      cancellation.after,
      'dispose during loading cannot replace the previous battery snapshot',
    )
    for (let attempt = 0; attempt < 20 && page.workers().length; attempt++)
      await page.waitForTimeout(50)
    assert.equal(page.workers().length, 0, 'dispose during startup terminates all workers')
    assert.deepEqual(errors, [])
    return {
      gatedLoad: true,
      gatedImport: true,
      timeout: true,
      disposeDuringLoad: true,
      snapshotFailureCleaned: true,
      nativeFailures,
      immediateImport: imported,
    }
  } catch (error) {
    console.error(
      'Core startup regression context:',
      await page
        .evaluate(() => ({
          heldFrames: window.heldStartupFrames,
          result: window.startupResult,
          events: window.events,
          threadReady: window.startupCore?.hostIsGameReady(),
        }))
        .catch(() => null),
      errors,
    )
    throw error
  } finally {
    await page.evaluate(() => window.emulator?.dispose()).catch(() => {})
    await page.close()
  }
}
