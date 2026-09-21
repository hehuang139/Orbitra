import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const artifacts = new URL('../.artifacts/', import.meta.url)
await mkdir(artifacts, { recursive: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const screenshot = (name) =>
  page.screenshot({
    path: fileURLToPath(new URL(`${name}.png`, artifacts)),
    fullPage: true,
    animations: 'disabled',
  })
const controls = page.locator('.advance-touch')
const a = controls.locator('button[aria-label="A 按钮"]')
const b = controls.locator('button[aria-label="B 按钮"]')
const up = controls.locator('button[aria-label="上"]')
const pressed = (button) => button.evaluate((element) => element.classList.contains('is-pressed'))
const pointer = (button, type, pointerId) =>
  button.dispatchEvent(type, { pointerId, pointerType: 'touch', button: 0, bubbles: true })
const openControls = async () => {
  const settings = page.getByRole('button', { name: '控制器设置', exact: true })
  if (!(await settings.evaluate((element) => element.getBoundingClientRect().left >= 0)))
    await page.getByRole('button', { name: '打开导航', exact: true }).click()
  await settings.click()
  await page.getByLabel('触屏布局', { exact: true }).waitFor()
}
const closeControls = () => page.getByRole('button', { name: '完成设置', exact: true }).click()
const start = async () => {
  await page.getByRole('button', { name: '开始试玩', exact: true }).click()
  await page.getByRole('button', { name: '开始游戏', exact: true }).click()
  await page.waitForFunction(() => {
    const pause = document.querySelector('[aria-label="暂停 (Space)"]')
    return pause && !pause.disabled
  })
}
const dimensions = []
const checkLayout = async (width, height, preset) => {
  await page.setViewportSize({ width, height })
  await controls.waitFor({ state: 'visible' })
  const result = await controls.evaluate((element) => {
    const panel = element.getBoundingClientRect()
    const keys = [...element.querySelectorAll('button')].map((button) => {
      const rect = button.getBoundingClientRect()
      return {
        label: button.getAttribute('aria-label'),
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    })
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      left: panel.left,
      right: panel.right,
      bottom: panel.bottom,
      keys,
    }
  })
  assert.equal(result.overflow, false, `${width} × ${height}: ${preset} must not overflow`)
  for (const key of result.keys) {
    assert(
      key.left >= result.left && key.right <= result.right + 0.5,
      `${key.label} must stay inside the touch panel`,
    )
    assert(
      key.bottom <= result.bottom + 0.5,
      `${key.label} must stay above the safe bottom padding`,
    )
    assert(key.width >= 43.9 && key.height >= 43.9, `${key.label} needs at least a 44px hit target`)
  }
  for (let i = 0; i < result.keys.length; i++) {
    for (let j = i + 1; j < result.keys.length; j++) {
      const first = result.keys[i],
        second = result.keys[j]
      const overlapWidth = Math.min(first.right, second.right) - Math.max(first.left, second.left)
      const overlapHeight = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top)
      assert(
        overlapWidth <= 0.5 || overlapHeight <= 0.5,
        `${first.label} and ${second.label} must not overlap`,
      )
    }
  }
  dimensions.push({
    width,
    height,
    preset,
    minimumTarget: Math.min(...result.keys.map((key) => Math.min(key.width, key.height))),
  })
}

try {
  await page.goto(process.env.UI_TEST_URL || 'http://127.0.0.1:5173')
  await page.waitForFunction(() => {
    const button = document.querySelector('.hero-actions button')
    return button && !button.disabled
  })
  await openControls()
  await page.getByLabel('触屏布局', { exact: true }).selectOption('compact')
  const size = page.getByRole('slider', { name: '触屏按键大小', exact: true })
  await size.focus()
  await page.keyboard.press('End')
  const opacity = page.getByRole('slider', { name: '触屏按键不透明度', exact: true })
  await opacity.focus()
  await page.keyboard.press('Home')
  for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowRight')
  await page.getByRole('switch', { name: '显示触屏按键', exact: true }).click()
  assert.equal(await size.inputValue(), '130')
  assert.equal(await opacity.inputValue(), '55')
  await screenshot('touch-settings-desktop')
  await closeControls()
  await page.reload()
  await openControls()
  assert.equal(await page.getByLabel('触屏布局', { exact: true }).inputValue(), 'compact')
  assert.equal(await size.inputValue(), '130')
  assert.equal(await opacity.inputValue(), '55')
  assert.equal(
    await page
      .getByRole('switch', { name: '显示触屏按键', exact: true })
      .getAttribute('aria-checked'),
    'true',
  )
  await closeControls()
  await start()

  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [844, 390],
  ])
    await checkLayout(width, height, 'compact 130%')
  await page.setViewportSize({ width: 390, height: 844 })
  await screenshot('touch-player-mobile')
  await pointer(a, 'pointerdown', 1)
  await pointer(a, 'pointerdown', 2)
  await pointer(up, 'pointerdown', 3)
  assert.equal(await pressed(a), true)
  assert.equal(await pressed(up), true)
  await pointer(a, 'pointerup', 1)
  assert.equal(await pressed(a), true, 'another finger still holds A')
  await pointer(a, 'pointercancel', 2)
  assert.equal(await pressed(a), false, 'cancelling the last A touch releases A')
  assert.equal(await pressed(up), true, 'cancelling A keeps the direction held')
  await pointer(up, 'lostpointercapture', 3)
  assert.equal(await pressed(up), false)
  await pointer(a, 'pointerdown', 4)
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4, pointerType: 'touch' })),
  )
  assert.equal(await pressed(a), false, 'a pointer ending outside the button releases it')
  await pointer(a, 'pointerdown', 5)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  assert.equal(await pressed(a), false, 'window blur clears held touches')
  await pointer(a, 'pointerdown', 6)
  await page.setViewportSize({ width: 844, height: 390 })
  await page.waitForFunction(() => !document.querySelector('.advance-touch .is-pressed'))
  await checkLayout(844, 390, 'orientation change')
  await screenshot('touch-player-landscape')

  await a.focus()
  await page.keyboard.down('Space')
  assert.equal(await pressed(a), true)
  await page.keyboard.up('Space')
  assert.equal(await pressed(a), false)
  await page.keyboard.down('Enter')
  assert.equal(await pressed(a), true)
  await b.focus()
  await page.keyboard.up('Enter')
  assert.equal(await pressed(a), false, 'moving focus releases a keyboard-held touch button')
  await a.evaluate((element) => element.click())
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="A 按钮"]').classList.contains('is-pressed'),
  )
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="A 按钮"]').classList.contains('is-pressed'),
  )

  await pointer(a, 'pointerdown', 7)
  await openControls()
  assert.equal(await pressed(a), false, 'opening settings releases held touches')
  assert.equal(await a.isDisabled(), true)
  await page.getByLabel('触屏布局', { exact: true }).selectOption('standard')
  await closeControls()
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [844, 390],
  ])
    await checkLayout(width, height, 'standard 130%')
  await openControls()
  await size.focus()
  await page.keyboard.press('Home')
  await closeControls()
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [844, 390],
  ])
    await checkLayout(width, height, 'standard 80%')
  await openControls()
  await page.getByRole('button', { name: '恢复默认触屏配置', exact: true }).click()
  assert.equal(await size.inputValue(), '100')
  assert.equal(await opacity.inputValue(), '100')
  await page.getByRole('switch', { name: '显示触屏按键', exact: true }).click()
  await closeControls()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await controls.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 390, height: 844 })
  await controls.waitFor({ state: 'visible' })
  await pointer(a, 'pointerdown', 8)
  await page.getByRole('button', { name: '暂停 (Space)', exact: true }).click()
  await page.getByRole('button', { name: '继续 (Space)', exact: true }).waitFor()
  await page.waitForFunction(
    () => {
      const key = document.querySelector('.advance-touch [aria-label="A 按钮"]')
      return key?.disabled && !key.classList.contains('is-pressed')
    },
    null,
    { timeout: 1500 },
  )
  assert.equal(await pressed(a), false, 'pausing releases touches')
  assert.equal(await a.isDisabled(), true)
  assert.deepEqual(errors, [], 'no uncaught browser errors')
  const report = {
    browser: await browser.version(),
    testedAt: new Date().toISOString(),
    environment:
      'Playwright viewport simulation; not a physical phone or assistive technology audit',
    dimensions,
    checks: [
      'touch settings persist after reload',
      'same-button multi-pointer release',
      'direction/action concurrency',
      'pointer cancellation',
      'lost capture',
      'global pointer release',
      'blur',
      'orientation change',
      'keyboard and synthetic button activation',
      'modal interruption',
      'minimum targets and non-overlapping layout',
      'reset defaults',
      'automatic mobile visibility',
      'pause releases input',
    ],
  }
  await writeFile(new URL('touch-report.json', artifacts), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  await screenshot('touch-failure').catch(() => {})
  console.error(
    'Touch regression stopped at:',
    await page
      .locator('.player-heading')
      .textContent()
      .catch(() => 'player unavailable'),
  )
  throw error
} finally {
  await browser.close()
}
