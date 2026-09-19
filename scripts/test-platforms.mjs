import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createGameBoyTestRom } from './game-boy-test-rom.mjs'
import { createNesTestRom, createSnesTestRom } from './classic-console-test-roms.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
const consoleMessages = []
page.on('pageerror', (error) => errors.push(error.stack || error.message))
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleMessages.push(`[${message.type()}] ${message.text()}`)
  }
})
const artifacts = new URL('../.artifacts/', import.meta.url)
await mkdir(artifacts, { recursive: true })

const waitForPlayer = async () => {
  await page.waitForFunction(() => {
    const control = document.querySelector('[aria-label="暂停 (Space)"]')
    return control && !control.disabled
  })
}

const assertScreen = async (platform, name) => {
  assert.equal(await page.locator('.player-heading .pill').innerText(), name.toUpperCase())
  assert.deepEqual(
    await page.locator('canvas').evaluate((canvas) => {
      const bounds = canvas.getBoundingClientRect()
      return {
        width: canvas.width,
        height: canvas.height,
        cssRatio: Math.round((bounds.width / bounds.height) * 1000) / 1000,
      }
    }),
    { width: 160, height: 144, cssRatio: 1.111 },
  )
  assert.equal(
    await page.locator('.advance-touch-shoulders').count(),
    0,
    `${platform} has no shoulder buttons`,
  )
}

try {
  await page.goto(process.env.UI_TEST_URL || 'http://127.0.0.1:5173')
  const input = page.locator('input[type=file][accept*=".gba"]')
  assert.equal(await input.getAttribute('accept'), '.gba,.gb,.gbc,.nes,.sfc,.smc,.zip')
  await input.setInputFiles([
    {
      name: 'Classic.gb',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(createGameBoyTestRom()),
    },
    {
      name: 'Color.gbc',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(createGameBoyTestRom({ color: true })),
    },
  ])
  await page.getByText('已导入 2 个游戏，准备开始吧', { exact: true }).waitFor()
  assert.equal(await page.locator('.game-card').count(), 3)
  assert.equal(await page.locator('.cover-platform[data-platform="gba"]').count(), 1)
  assert.equal(await page.locator('.cover-platform[data-platform="gb"]').count(), 1)
  assert.equal(await page.locator('.cover-platform[data-platform="gbc"]').count(), 1)

  await page.getByRole('button', { name: '我的收藏' }).click()
  assert.equal(
    await page.locator('.platform-filter button[data-platform="gb"] span').innerText(),
    '0',
  )
  await page.locator('.platform-filter button[data-platform="gb"]').click()
  await page.getByText('还没有收藏的 GB 游戏', { exact: true }).waitFor()
  assert.equal(await page.getByText(/导入 \.gb ROM/).count(), 0)
  await page.getByRole('button', { name: '最近游玩' }).click()
  await page.getByText('还没有最近游玩的 GB 游戏', { exact: true }).waitFor()
  assert.equal(
    await page.locator('.platform-filter button[data-platform="gb"] span').innerText(),
    '0',
  )
  await page.locator('.nav-item').filter({ hasText: '游戏库' }).click()

  assert.equal(await page.locator('.game-card').count(), 1)
  await page.getByRole('button', { name: '开始 Classic', exact: true }).click()
  await waitForPlayer()
  await assertScreen('GB', 'Game Boy')
  await page.getByRole('button', { name: '控制器设置', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.locator('.key-binding').count(), 8, 'GB exposes only its eight controls')
  assert.equal(await page.getByText('L 肩键', { exact: true }).count(), 0)
  assert.equal(await page.getByText('R 肩键', { exact: true }).count(), 0)
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await page.getByRole('button', { name: '快速存档 (F5)', exact: true }).click()
  await page.getByText('已保存到存档位 1', { exact: true }).waitFor()
  await page.getByRole('button', { name: '存档管理', exact: true }).click()
  assert.equal(
    await page.locator('.state-card[data-platform="gb"] > img').evaluate((image) => {
      const bounds = image.getBoundingClientRect()
      return Math.round((bounds.width / bounds.height) * 1000) / 1000
    }),
    1.111,
    'GB save-state thumbnails keep the native 10:9 ratio',
  )
  await page.locator('.nav-item').filter({ hasText: '游戏库' }).click()
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()

  await page.locator('.platform-filter button[data-platform="gbc"]').click()
  assert.equal(await page.locator('.game-card').count(), 1)
  await page.getByRole('button', { name: '开始 Color', exact: true }).click()
  await waitForPlayer()
  await assertScreen('GBC', 'Game Boy Color')
  await page.screenshot({
    path: fileURLToPath(new URL('platform-player-gbc.png', artifacts)),
    fullPage: true,
  })
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()
  await page.waitForFunction(() => {
    const button = document.querySelector('.import-top')
    return button && !button.disabled
  })

  await input.setInputFiles([
    {
      name: 'Console.nes',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(createNesTestRom()),
    },
    {
      name: '123456.sfc',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(createSnesTestRom()),
    },
  ])
  await page.getByText('已导入 2 个游戏，准备开始吧', { exact: true }).waitFor()
  await page.locator('.platform-filter button').first().click()
  assert.equal(await page.locator('.game-card').count(), 5)

  await page.locator('.platform-filter button[data-platform="nes"]').click()
  await page.getByRole('button', { name: '开始 Console', exact: true }).click()
  await waitForPlayer()
  assert.equal(await page.locator('.player-heading .pill').innerText(), 'FAMICOM / NES')
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.retro-host canvas')
    return canvas && canvas.width > 0 && canvas.height > 0
  })
  await page.getByRole('button', { name: '快速存档 (F5)', exact: true }).click()
  await page.getByText('已保存到存档位 1', { exact: true }).waitFor()
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()
  await page.waitForFunction(() => {
    const button = document.querySelector('.import-top')
    return button && !button.disabled
  })

  await page.locator('.platform-filter button[data-platform="snes"]').click()
  await page.getByRole('button', { name: 'ADVANCE SNES TEST', exact: true }).waitFor()
  assert.equal(await page.getByText('123456', { exact: true }).count(), 0)
  await page.getByRole('button', { name: '开始 ADVANCE SNES TEST', exact: true }).click()
  await waitForPlayer()
  assert.equal(await page.locator('.player-heading .pill').innerText(), 'SUPER FAMICOM / SNES')
  assert.equal(await page.locator('.advance-touch-action .advance-touch-key').count(), 4)
  await page.getByRole('button', { name: '控制器设置', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.locator('.key-binding').count(), 12, 'SFC exposes all twelve controls')
  assert.equal(await page.getByText('X 按钮', { exact: true }).count(), 1)
  assert.equal(await page.getByText('Y 按钮', { exact: true }).count(), 1)
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await page.getByRole('button', { name: '快速存档 (F5)', exact: true }).click()
  await page.getByText('已保存到存档位 1', { exact: true }).waitFor()
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()

  await page.reload()
  await page.locator('.platform-filter').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.game-card').length === 5)
  assert.equal(
    await page.locator('.cover-platform').count(),
    5,
    'platform metadata persists across reload',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.sidebar').evaluate(async (sidebar) => {
    await Promise.all(sidebar.getAnimations().map((animation) => animation.finished))
  })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'platform filters must not overflow mobile',
  )
  const mobileBounds = await page.locator('main').evaluate((main) => {
    const bounds = main.getBoundingClientRect()
    return { left: bounds.left, right: bounds.right, viewport: innerWidth, scrollX }
  })
  assert.ok(mobileBounds.left >= 0, 'mobile content must not be clipped on the left')
  assert.ok(mobileBounds.right <= mobileBounds.viewport, 'mobile content must fit the viewport')
  assert.equal(mobileBounds.scrollX, 0, 'mobile layout must remain at the horizontal origin')
  await page.screenshot({
    path: fileURLToPath(new URL('platform-library.png', artifacts)),
    fullPage: true,
  })
  assert.deepEqual(errors, [], 'platform UI must not produce uncaught browser errors')
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'GB/GBC direct import',
          'FC/SFC direct import and real core startup',
          'SFC internal title extraction for numeric filenames',
          'FC/SFC save states',
          'SFC X/Y/L/R controls',
          'platform badges and filters',
          'native 10:9 screen ratio',
          'platform-specific touch controls',
          'platform-specific keyboard controls',
          'native save-state thumbnail ratio',
          'reload persistence',
          'mobile overflow',
        ],
      },
      null,
      2,
    ),
  )
} catch (error) {
  const diagnostics = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 2000),
      bodyClasses: document.body.className,
      playerCount: document.querySelectorAll('.player-panel').length,
      retroHostCount: document.querySelectorAll('.retro-host').length,
      toastText: document.querySelector('.toast')?.textContent ?? null,
    }))
    .catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }))
  console.error(JSON.stringify({ diagnostics, pageErrors: errors, consoleMessages }, null, 2))
  await page
    .screenshot({ path: fileURLToPath(new URL('platform-failure.png', artifacts)), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await browser.close()
}
