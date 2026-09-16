import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const url = process.env.UI_TEST_URL || 'http://127.0.0.1:5173'
const artifacts = new URL('../.artifacts/', import.meta.url)
await mkdir(artifacts, { recursive: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const screenshot = (name) =>
  page.screenshot({
    path: new URL(`${name}.png`, artifacts).pathname.replace(/^\/([A-Z]:)/, '$1'),
    fullPage: true,
  })
try {
  await page.goto(url)
  await page.getByRole('button', { name: '开始试玩', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('.hero-actions button').disabled)
  await screenshot('desktop-library')
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'desktop must not overflow',
  )

  await page.getByRole('button', { name: '环境检查', exact: true }).click()
  assert.equal(await page.locator('.compatibility-check').count(), 6)
  assert.equal(
    await page.locator('.compatibility-check.error').count(),
    0,
    'working browser capabilities must not be reported as errors',
  )
  await screenshot('desktop-compatibility')
  await page.getByRole('button', { name: '关闭环境检查', exact: true }).click()

  await page.getByRole('button', { name: '收藏 Star Orbit · 星际漫游', exact: true }).click()
  await page.getByRole('button', { name: '我的收藏' }).click()
  assert.equal(
    await page.locator('.game-card').count(),
    1,
    'favorites must filter real saved games',
  )
  await page.getByRole('button', { name: /^游戏库/ }).click()
  await page.getByRole('textbox', { name: '搜索游戏' }).fill('no-such-game')
  await page.getByText('没有找到这个游戏').waitFor()
  await page.getByRole('button', { name: '清空搜索' }).click()

  await page.getByRole('button', { name: '开始试玩', exact: true }).click()
  await page.getByRole('button', { name: '暂停 (Space)', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[aria-label="暂停 (Space)"]').disabled)
  await page.keyboard.down('ArrowRight')
  await page.waitForTimeout(220)
  await page.keyboard.up('ArrowRight')
  await page.keyboard.press('F5')
  await page.getByText('已保存到存档位 1', { exact: true }).waitFor()
  await page.keyboard.press('Space')
  await page.getByText('游戏已暂停', { exact: true }).waitFor()
  await screenshot('desktop-player')
  await page.getByRole('button', { name: '管理即时存档' }).click()
  assert.equal(await page.locator('.save-slot').count(), 6)
  assert.equal(await page.locator('.save-slot.filled').count(), 1)
  await page.locator('.save-slot.filled img').waitFor()
  const stateDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出存档位 1', exact: true }).click()
  assert.match((await stateDownload).suggestedFilename(), /\.state$/)
  await screenshot('desktop-states')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.locator('canvas').focus()
  await page.keyboard.press('F8')
  await page.getByText('已恢复存档', { exact: true }).waitFor()

  await page.getByRole('button', { name: '控制器设置', exact: true }).click()
  await page.getByRole('button', { name: 'A 按钮键盘映射：X', exact: true }).click()
  await page.keyboard.press('KeyV')
  await page.getByRole('button', { name: 'A 按钮键盘映射：V', exact: true }).waitFor()
  await page.getByRole('button', { name: '完成设置' }).click()
  await page.getByRole('combobox', { name: '画面滤镜', exact: true }).selectOption('crt')
  assert.equal(await page.locator('.filter-crt').count(), 1)
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()
  await page.getByRole('button', { name: '开始试玩', exact: true }).waitFor()

  const rom = Buffer.from(await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url)))
  rom[0xac] = 0x54
  rom[0xad] = 0x53
  let checksum = 0
  for (let i = 0xa0; i < 0xbd; i++) checksum = (checksum - rom[i]) & 255
  rom[0xbd] = (checksum - 0x19) & 255
  await page
    .locator('input[type=file][accept*=".gba"]')
    .setInputFiles({ name: 'Test-Orbit.gba', mimeType: 'application/octet-stream', buffer: rom })
  await page.getByText('已导入 1 个游戏，准备开始吧', { exact: true }).waitFor()
  assert.equal(await page.locator('.game-card').count(), 2)
  await page.reload()
  await page.locator('.game-card').nth(1).waitFor()
  assert.equal(
    await page.getByRole('combobox', { name: '画面滤镜', exact: true }).inputValue(),
    'crt',
  )
  await page.getByRole('button', { name: '控制器设置', exact: true }).click()
  await page.getByRole('button', { name: 'A 按钮键盘映射：V', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '存档管理', exact: true }).click()
  await page.locator('.state-card').nth(1).waitFor()
  assert.equal(
    await page.locator('.state-card').count(),
    2,
    'auto and manual states persist across reload',
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.getByRole('button', { name: /^游戏库/ }).click()
  await screenshot('mobile-library')
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'mobile must not overflow',
  )
  await page.getByRole('button', { name: '环境检查', exact: true }).click()
  await screenshot('mobile-compatibility')
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'mobile diagnostics must not overflow',
  )
  await page.getByRole('button', { name: '关闭环境检查', exact: true }).click()
  await page.getByRole('button', { name: '开始试玩', exact: true }).click()
  await page.waitForFunction(
    () =>
      !!document.querySelector('[aria-label="暂停 (Space)"]') &&
      !document.querySelector('[aria-label="暂停 (Space)"]').disabled,
  )
  assert.equal(await page.locator('.touch-controls').isVisible(), true)
  await page.getByRole('button', { name: '暂停 (Space)', exact: true }).click()
  await screenshot('mobile-player')
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'mobile player must not overflow',
  )
  assert.deepEqual(errors, [], 'no uncaught browser errors')

  const deniedStorage = await browser.newContext()
  await deniedStorage.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException('Site storage denied', 'SecurityError')
    }
  })
  const deniedPage = await deniedStorage.newPage()
  deniedPage.on('pageerror', (error) => errors.push(error.message))
  await deniedPage.goto(url)
  await deniedPage.getByRole('button', { name: '环境检查', exact: true }).click()
  assert.match(
    await deniedPage.locator('.compatibility-check.error').innerText(),
    /IndexedDB.*拒绝/s,
  )
  await deniedStorage.close()

  const pendingQuota = await browser.newContext()
  await pendingQuota.addInitScript(() => {
    StorageManager.prototype.estimate = () => new Promise(() => {})
  })
  const quotaPage = await pendingQuota.newPage()
  quotaPage.on('pageerror', (error) => errors.push(error.message))
  await quotaPage.goto(url)
  await quotaPage.waitForFunction(() => !document.querySelector('.hero-actions button')?.disabled)
  await quotaPage.getByRole('button', { name: '环境检查', exact: true }).click()
  assert.match(
    await quotaPage
      .locator('.compatibility-check.warning')
      .filter({ hasText: '存储空间' })
      .innerText(),
    /存储配额检查超时/,
  )
  assert.equal(
    await quotaPage.locator('.game-card').count(),
    1,
    'quota failure must not hide the game library',
  )
  await pendingQuota.close()
  assert.deepEqual(errors, [], 'diagnostic failures must not throw browser errors')
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'initial library',
          'favorites',
          'search',
          'real ROM launch',
          'keyboard',
          'quick save/load',
          'state download',
          'key remapping',
          'CRT filter',
          'game import',
          'reload persistence',
          'mobile navigation',
          'touch controls',
          'responsive overflow',
          'desktop and mobile compatibility panel',
          'denied IndexedDB diagnostics',
          'quota timeout preserves library',
        ],
        screenshots: artifacts.pathname,
      },
      null,
      2,
    ),
  )
} catch (error) {
  await screenshot('ui-failure').catch(() => {})
  throw error
} finally {
  await browser.close()
}
