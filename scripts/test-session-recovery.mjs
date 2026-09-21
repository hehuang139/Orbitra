import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const url = process.env.UI_TEST_URL || 'http://127.0.0.1:5173'
const artifacts = new URL('../.artifacts/', import.meta.url)
await mkdir(artifacts, { recursive: true })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))

const waitForLibrary = async () => {
  await page.getByRole('button', { name: '开始试玩', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.hero-actions button')?.disabled)
}
const waitForPlayer = () =>
  page.waitForFunction(() => {
    const pause = document.querySelector('[aria-label="暂停 (Space)"]')
    return pause && !pause.disabled
  })
const openLaunch = async () => {
  await page.getByRole('button', { name: '开始试玩', exact: true }).click()
  await page.getByRole('heading', { name: '选择这次的起点', exact: true }).waitFor()
}
const returnToLibrary = async () => {
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()
  await waitForLibrary()
}
const readJournal = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem('advance.session-recovery') || 'null'))
const readState = (gameId, slot) =>
  page.evaluate(
    ({ gameId, slot }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('advance-gba', 1)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const stateRequest = database
            .transaction('states')
            .objectStore('states')
            .get(`${gameId}:${slot}`)
          stateRequest.onerror = () => reject(stateRequest.error)
          stateRequest.onsuccess = () => {
            const state = stateRequest.result
            database.close()
            resolve(
              state ? { ...state, data: Array.from(state.data), screenshot: undefined } : null,
            )
          }
        }
      }),
    { gameId, slot },
  )
const seedRecovery = (record, corrupt = false) =>
  page.evaluate(
    ({ record, corrupt }) =>
      new Promise((resolve, reject) => {
        localStorage.setItem('advance.session-recovery', JSON.stringify(record))
        if (!corrupt) {
          resolve()
          return
        }
        const request = indexedDB.open('advance-gba', 1)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const tx = database.transaction('states', 'readwrite')
          const store = tx.objectStore('states')
          const stateRequest = store.get(`${record.gameId}:${record.stateSlot}`)
          stateRequest.onsuccess = () => {
            store.put({ ...stateRequest.result, data: new Uint8Array([1, 2, 3]) })
          }
          tx.oncomplete = () => {
            database.close()
            resolve()
          }
          tx.onabort = () => reject(tx.error)
        }
      }),
    { record, corrupt },
  )

try {
  await page.goto(url)
  await waitForLibrary()

  // Create a real automatic state through a normal close, then start from it and reload abruptly.
  await openLaunch()
  await page.getByRole('button', { name: '开始游戏', exact: true }).click()
  await waitForPlayer()
  await returnToLibrary()
  await openLaunch()
  await page.getByRole('radio', { name: /继续自动存档/ }).check()
  await page.getByRole('button', { name: '开始游戏', exact: true }).click()
  await waitForPlayer()
  const activeJournal = await readJournal()
  assert.ok(activeJournal?.stateSlot !== undefined, 'resumed sessions reference a real state')

  await page.reload()
  await page.getByRole('heading', { name: '恢复未结束的游戏', exact: true }).waitFor()
  const recoveryJournal = await readJournal()
  const stateBefore = await readState(recoveryJournal.gameId, recoveryJournal.stateSlot)
  assert.equal(stateBefore.createdAt, recoveryJournal.stateCreatedAt)
  await page.screenshot({ path: new URL('desktop-session-recovery.png', artifacts).pathname })
  await page.getByRole('button', { name: '恢复进度', exact: true }).click()
  await waitForPlayer()
  await page.getByText('已从存档继续游戏', { exact: true }).waitFor()
  assert.deepEqual(
    await readState(recoveryJournal.gameId, recoveryJournal.stateSlot),
    stateBefore,
    'successful recovery only reads the referenced state',
  )
  await returnToLibrary()
  assert.equal(await readJournal(), null, 'normal close clears the active-session journal')

  // A core-level state failure must keep the exact original bytes and fall back to normal startup.
  const failedRecord = {
    ...recoveryJournal,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  await seedRecovery(failedRecord, true)
  await page.reload()
  await page.getByRole('heading', { name: '恢复未结束的游戏', exact: true }).waitFor()
  const corruptBefore = await readState(failedRecord.gameId, failedRecord.stateSlot)
  assert.deepEqual(corruptBefore.data, [1, 2, 3])
  await page.getByRole('button', { name: '恢复进度', exact: true }).click()
  await waitForPlayer()
  await page.getByText('此即时存档无法恢复，已重新启动游戏', { exact: true }).waitFor()
  assert.deepEqual(
    await readState(failedRecord.gameId, failedRecord.stateSlot),
    corruptBefore,
    'failed recovery preserves the original state record',
  )
  await returnToLibrary()

  // Missing recovery state keeps recovery disabled but offers a clean startup on mobile.
  const missingRecord = {
    ...failedRecord,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    stateSlot: 5,
    stateCreatedAt: 1,
  }
  await seedRecovery(missingRecord)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.getByRole('heading', { name: '恢复未结束的游戏', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '恢复进度', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '正常启动', exact: true }).isEnabled(), true)
  await page.screenshot({ path: new URL('mobile-session-recovery.png', artifacts).pathname })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('button', { name: '正常启动', exact: true }).click()
  await waitForPlayer()
  await returnToLibrary()
  assert.equal(await readJournal(), null)

  await seedRecovery({ ...missingRecord, startedAt: Date.now(), updatedAt: Date.now() })
  await page.reload()
  await page.getByRole('heading', { name: '恢复未结束的游戏', exact: true }).waitFor()
  await page.getByRole('button', { name: '忽略', exact: true }).click()
  assert.equal(await readJournal(), null, 'ignore permanently clears the stale prompt')
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.deepEqual(errors, [])

  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'unfinished session prompt and successful recovery',
          'recovery reads without mutating the original state',
          'failed recovery preserves state and starts normally',
          'missing state offers normal startup',
          'ignore clears the session journal',
          'desktop and mobile responsive recovery dialog',
        ],
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
