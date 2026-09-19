import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { createBackup, gameIdForRom, parseBackup } from '../src/lib/backup-format.ts'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const title = 'Backup Orbit'
const rom = Buffer.from(await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url)))
Buffer.from('BKP1').copy(rom, 0xac)
let checksum = 0x19
for (let offset = 0xa0; offset <= 0xbc; offset++) checksum += rom[offset]
rom[0xbd] = -checksum & 255
const romFile = { name: `${title}.gba`, mimeType: 'application/octet-stream', buffer: rom }
const handheldRoms = Object.fromEntries(
  await Promise.all(
    ['gb', 'gbc'].map(async (platform, platformIndex) => {
      const bytes = Uint8Array.from(
        { length: 32 * 1024 },
        (_, index) => (index + platformIndex * 29) % 251,
      )
      return [
        platform,
        {
          bytes,
          id: await gameIdForRom(platform, bytes),
          filename: `Backup ${platform.toUpperCase()}.${platform}`,
          title: `Backup ${platform.toUpperCase()}`,
        },
      ]
    }),
  ),
)
const handheldWithoutRom = await createBackup({
  formatVersion: 1,
  exportedAt: '2026-09-16T00:00:00.000Z',
  coreVersion: 'backup-platform-test@1',
  games: Object.entries(handheldRoms).map(([platform, item], index) => ({
    game: {
      id: item.id,
      title: item.title,
      filename: item.filename,
      platform,
      size: item.bytes.length,
      addedAt: index + 1,
      lastPlayed: null,
      playTime: 0,
      favorite: false,
    },
    rom: item.bytes,
    states: [],
  })),
})
const checks = []
const errors = []
let phase = 'setup'
let currentPage
const contexts = []
const button = (page, name) => page.getByRole('button', { name, exact: true })

async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  })
  contexts.push(context)
  const page = await context.newPage()
  currentPage = page
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => errors.push({ phase, message: error.message }))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ phase, message: message.text() })
  })
  await page.goto(process.env.UI_TEST_URL || 'http://127.0.0.1:5173')
  await page.waitForFunction(() => !document.querySelector('.hero-actions button')?.disabled)
  return page
}

async function tabTo(page, target) {
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Unreachable keyboard target: ${await target.textContent()}`)
}

async function activate(page, target, key = 'Enter') {
  await tabTo(page, target)
  await page.keyboard.press(key)
}

async function launch(page) {
  await button(page, `开始 ${title}`).click()
  await page.waitForFunction(() => {
    const control = document.querySelector('[aria-label="暂停 (Space)"]')
    return control && !control.disabled
  })
}

async function importScore(page, score) {
  const bytes = Buffer.alloc(32768)
  bytes.set([83, 79, 1, score, score ^ 255])
  await page
    .locator('input[type="file"][accept=".sav"]')
    .setInputFiles({ name: 'progress.sav', mimeType: 'application/octet-stream', buffer: bytes })
  await page.getByText('存档已导入，游戏已重新启动', { exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[aria-label="暂停 (Space)"]')?.disabled)
}

async function readDatabase(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('advance-gba', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const names = ['games', 'roms', 'batteries', 'states']
    const tx = db.transaction(names, 'readonly')
    const result = await Promise.all(
      names.map(
        (name) =>
          new Promise((resolve, reject) => {
            const request = tx.objectStore(name).getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          }),
      ),
    )
    db.close()
    return JSON.parse(
      JSON.stringify(result, (_key, value) => (value instanceof Uint8Array ? [...value] : value)),
    )
  })
}

async function openBackup(page, keyboard = false) {
  if (keyboard) await activate(page, button(page, '备份与恢复'))
  else await button(page, '备份与恢复').click()
  await page.locator('.backup-manager').waitFor()
  await page.waitForFunction(() => !document.querySelector('[aria-label="关闭对话框"]')?.disabled)
}

async function preview(page, bytes) {
  await page.getByLabel('选择备份文件', { exact: true }).setInputFiles({
    name: 'advance-backup.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  })
  await page.getByRole('heading', { name: '恢复预览', exact: true }).waitFor()
  await page.waitForFunction(
    () => document.querySelector('.backup-manager')?.getAttribute('aria-busy') === 'false',
  )
}

async function exportZip(page) {
  const pending = page.waitForEvent('download')
  await activate(page, button(page, '导出所选游戏备份'))
  const download = await pending
  assert.match(download.suggestedFilename(), /^advance-backup-.*\.zip$/)
  const bytes = await readFile(await download.path())
  await page.locator('.backup-feedback').first().filter({ hasText: '备份已生成' }).waitFor()
  return bytes
}

async function confirmRestore(page, keyboard = false) {
  const target = page.getByRole('button', { name: /^确认恢复 \d+ 项$/ })
  if (keyboard) await activate(page, target)
  else await target.click()
  await page.locator('.backup-feedback').first().filter({ hasText: '恢复完成' }).waitFor()
}

async function verifyScore(page, score) {
  await launch(page)
  await button(page, '管理即时存档').click()
  const pending = page.waitForEvent('download')
  await button(page, '导出 .sav').click()
  const bytes = await readFile(await (await pending).path())
  assert.deepEqual([...bytes.subarray(0, 5)], [83, 79, 1, score, score ^ 255])
  await button(page, '关闭对话框').click()
}

try {
  await mkdir('.artifacts', { recursive: true })
  const source = await newPage()
  phase = 'seed real core and progress'
  console.log(phase)
  await source.locator('input[type="file"][accept*=".gba"]').setInputFiles(romFile)
  await source.getByText('已导入 1 个游戏，准备开始吧', { exact: true }).waitFor()
  await launch(source)
  await importScore(source, 7)
  await source.locator('canvas').focus()
  await source.keyboard.press('F5')
  await source.getByText('已保存到存档位 1', { exact: true }).waitFor()
  await source.keyboard.press('Escape')
  await openBackup(source, true)
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [844, 390],
  ]) {
    await source.setViewportSize({ width, height })
    assert.equal(
      await source.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `active game with backup dialog: ${width}px`,
    )
  }
  await source.setViewportSize({ width: 1440, height: 1100 })
  assert.equal(
    await button(source, '关闭对话框').evaluate((el) => document.activeElement === el),
    true,
  )
  await activate(source, button(source, '清空选择'))
  const exportGame = source
    .locator('.backup-game-selection')
    .getByRole('checkbox', { name: /Backup Orbit/ })
  await activate(source, exportGame, 'Space')
  const includeRom = source.getByRole('checkbox', { name: /在备份中包含 ROM/ })
  assert.equal(await includeRom.isChecked(), false)
  const withoutRom = await exportZip(source)
  await activate(source, includeRom, 'Space')
  const withRom = await exportZip(source)
  const parsed = await parseBackup(new File([withRom], 'backup.zip'))
  const parsedWithout = await parseBackup(new File([withoutRom], 'backup.zip'))
  assert.equal(parsed.games.length, 1)
  assert.equal(parsed.games[0].game.platform, 'gba')
  assert.deepEqual(Buffer.from(parsed.games[0].rom), rom)
  assert.equal(parsedWithout.games[0].rom, undefined)
  assert.equal(parsed.games[0].battery[3], 7)
  assert.deepEqual(
    parsed.games[0].states.map((state) => state.slot),
    [0, 1],
  )
  checks.push(
    'keyboard export selects only requested games, ROM defaults off, ZIP checksums and real progress round trip',
  )

  phase = 'cancel and corrupted preview'
  const before = await readDatabase(source)
  // Hold an actual parse dependency to exercise the modal while every control is disabled.
  await source.evaluate(() => {
    const original = SubtleCrypto.prototype.digest
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    SubtleCrypto.prototype.digest = async function (...args) {
      await gate
      return original.apply(this, args)
    }
    window.releaseBackupHash = () => {
      SubtleCrypto.prototype.digest = original
      release()
    }
  })
  await source
    .getByLabel('选择备份文件', { exact: true })
    .setInputFiles({ name: 'advance-backup.zip', mimeType: 'application/zip', buffer: withRom })
  await source.waitForFunction(
    () => document.querySelector('.backup-manager')?.getAttribute('aria-busy') === 'true',
  )
  await source.keyboard.press('Tab')
  await source.keyboard.press('Escape')
  assert.equal(await source.getByRole('dialog').count(), 1)
  assert.equal(
    await source.getByRole('dialog').evaluate((el) => el.contains(document.activeElement)),
    true,
  )
  assert.equal(await button(source, '关闭对话框').isDisabled(), true)
  await source.evaluate(() => {
    window.releaseBackupHash()
    delete window.releaseBackupHash
  })
  await source.getByRole('heading', { name: '恢复预览', exact: true }).waitFor()
  await source.waitForFunction(
    () => document.querySelector('.backup-manager')?.getAttribute('aria-busy') === 'false',
  )
  const choices = source.locator('.backup-restore-game input[type="checkbox"]')
  for (const choice of await choices.all()) assert.equal(await choice.isChecked(), false)
  await activate(source, button(source, '取消恢复'))
  assert.deepEqual(await readDatabase(source), before)
  const invalidFiles = unzipSync(withRom)
  const manifest = JSON.parse(strFromU8(invalidFiles['manifest.json']))
  manifest.formatVersion = 99
  invalidFiles['manifest.json'] = strToU8(JSON.stringify(manifest))
  await source.getByLabel('选择备份文件', { exact: true }).setInputFiles({
    name: 'future.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipSync(invalidFiles)),
  })
  await source.locator('.backup-feedback.is-error').filter({ hasText: '版本 99' }).waitFor()
  assert.deepEqual(await readDatabase(source), before)
  checks.push(
    'busy modal keeps keyboard focus; cancel, default conflicts and future-version preview leave all four stores unchanged',
  )

  phase = 'restore over a paused old core'
  await button(source, '关闭对话框').click()
  assert.equal(
    await button(source, '备份与恢复').evaluate((el) => document.activeElement === el),
    true,
  )
  await importScore(source, 23)
  await openBackup(source)
  await preview(source, withRom)
  for (const choice of await source.locator('.backup-restore-game input[type="checkbox"]').all()) {
    await activate(source, choice, 'Space')
  }
  await source.screenshot({ path: '.artifacts/backup-desktop.png', fullPage: true })
  await confirmRestore(source, true)
  await button(source, '关闭对话框').click()
  assert.equal(await source.locator('.player-panel.visible').count(), 0)
  assert.equal(await button(source, `开始 ${title}`).isEnabled(), true)
  await verifyScore(source, 7)
  await source.reload()
  await source.waitForFunction(() => !document.querySelector('.hero-actions button')?.disabled)
  await verifyScore(source, 7)
  checks.push(
    'explicit keyboard conflict choices discard the old core and preserve restored SRAM and states through replay and refresh',
  )

  phase = 'battery-only restore preserves old slots without auto-loading them'
  await importScore(source, 23)
  await openBackup(source)
  const olderSlots = (await readDatabase(source))[3]
  await preview(source, withRom)
  await source.getByRole('checkbox', { name: /^恢复电池存档/ }).check()
  await confirmRestore(source)
  const batteryOnly = await readDatabase(source)
  assert.deepEqual(batteryOnly[3], olderSlots, 'unselected states remain unchanged')
  assert.equal(
    batteryOnly[0].find((game) => game.id === parsed.games[0].game.id).skipAutoState,
    true,
  )
  await button(source, '关闭对话框').click()
  await source.reload()
  await source.waitForFunction(() => !document.querySelector('.hero-actions button')?.disabled)
  await verifyScore(source, 7)
  checks.push(
    'battery-only restore survives refresh and never auto-loads the preserved older slot 0',
  )

  phase = 'blank context atomic failure and retry'
  const fresh = await newPage()
  await openBackup(fresh)
  await preview(fresh, withRom)
  const freshBefore = await readDatabase(fresh)
  await fresh.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'states') {
        IDBObjectStore.prototype.put = original
        throw new DOMException('Injected quota failure after earlier writes', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  await fresh.getByRole('button', { name: /^确认恢复 \d+ 项$/ }).click()
  await fresh.locator('.backup-feedback.is-error').filter({ hasText: '空间不足' }).waitFor()
  assert.deepEqual(await readDatabase(fresh), freshBefore)
  await confirmRestore(fresh)
  await button(fresh, '关闭对话框').click()
  await verifyScore(fresh, 7)
  checks.push(
    'new browser context restores bundled ROM and real saved progress; middle-write quota fault rolls back all stores and retries',
  )

  phase = 'missing ROM and narrow layouts'
  const missing = await newPage()
  // A synchronous browser privacy exception must only make the estimate unknown.
  await missing.evaluate(() => {
    Object.defineProperty(navigator.storage, 'estimate', {
      configurable: true,
      value: () => {
        throw new DOMException('Denied', 'SecurityError')
      },
    })
  })
  await openBackup(missing)
  await preview(missing, withoutRom)
  const missingBefore = await readDatabase(missing)
  assert.equal(await missing.getByRole('button', { name: /^确认恢复 \d+ 项$/ }).isDisabled(), true)
  for (const choice of await missing.locator('.backup-restore-game input[type="checkbox"]').all()) {
    assert.equal(await choice.isChecked(), false)
  }
  const romInput = missing.getByLabel(`为 ${title} 选择匹配 ROM`, { exact: true })
  const wrong = Buffer.from(rom)
  wrong[0] ^= 1
  await romInput.setInputFiles({ ...romFile, buffer: wrong })
  await missing.locator('.backup-feedback.is-error').filter({ hasText: '内容标识' }).waitFor()
  assert.deepEqual(await readDatabase(missing), missingBefore)
  await romInput.setInputFiles(romFile)
  await missing.locator('.backup-feedback').first().filter({ hasText: 'ROM 校验通过' }).waitFor()
  assert.deepEqual(await readDatabase(missing), missingBefore)
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [844, 390],
  ]) {
    await missing.setViewportSize({ width, height })
    const overflow = await missing.evaluate(() => ({
      page: document.documentElement.scrollWidth > innerWidth,
      modal:
        document.querySelector('.modal').scrollWidth >
        document.querySelector('.modal').clientWidth + 1,
    }))
    assert.deepEqual(overflow, { page: false, modal: false }, `${width}x${height}`)
    await missing.screenshot({ path: `.artifacts/backup-${width}.png`, fullPage: true })
  }
  await confirmRestore(missing, true)
  await button(missing, '关闭对话框').click()
  await missing.setViewportSize({ width: 1440, height: 1100 })
  await verifyScore(missing, 7)
  checks.push(
    'without-ROM backup matches bytes in memory, rejects wrong content, restores progress, handles unavailable quota and fits 320px/mobile/landscape',
  )

  phase = 'GB and GBC missing-ROM matching'
  const handheld = await newPage()
  await openBackup(handheld)
  await preview(handheld, handheldWithoutRom)
  for (const platform of ['gb', 'gbc']) {
    const item = handheldRoms[platform]
    const input = handheld.getByLabel(`为 ${item.title} 选择匹配 ROM`, { exact: true })
    assert.equal(await input.getAttribute('accept'), `.${platform}`)
    if (platform === 'gb') {
      await input.setInputFiles({
        name: 'wrong.gba',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(item.bytes),
      })
      await handheld
        .locator('.backup-feedback.is-error')
        .filter({ hasText: '请选择 .gb' })
        .waitFor()
    }
    await input.setInputFiles({
      name: item.filename,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(item.bytes),
    })
    await handheld
      .locator('.backup-feedback')
      .first()
      .filter({ hasText: `${item.title} 的 ROM 校验通过` })
      .waitFor()
  }
  await confirmRestore(handheld)
  const restoredHandhelds = (await readDatabase(handheld))[0].filter((game) =>
    ['gb', 'gbc'].includes(game.platform),
  )
  assert.deepEqual(restoredHandhelds.map((game) => [game.filename, game.platform]).sort(), [
    ['Backup GB.gb', 'gb'],
    ['Backup GBC.gbc', 'gbc'],
  ])
  await button(handheld, '关闭对话框').click()
  checks.push(
    'GB/GBC without-ROM backups require the matching extension and restore platform metadata after domain-separated identity checks',
  )
  assert.deepEqual(errors, [])
  const result = {
    passed: true,
    browser: await browser.version(),
    platform: process.platform,
    checks,
  }
  await writeFile('.artifacts/backup-result.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await currentPage
    ?.screenshot({ path: '.artifacts/backup-failure.png', fullPage: true })
    .catch(() => {})
  const result = { passed: false, phase, checks, errors, error: error.stack || String(error) }
  await writeFile('.artifacts/backup-result.json', JSON.stringify(result, null, 2))
  console.error(JSON.stringify(result, null, 2))
  throw error
} finally {
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
}
