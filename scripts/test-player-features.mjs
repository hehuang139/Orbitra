import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

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

try {
  await page.goto(url)
  await page.getByRole('button', { name: '开始试玩', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.hero-actions button').disabled)
  await page.getByRole('button', { name: '开始试玩', exact: true }).click()
  await page.waitForFunction(() => {
    const pause = document.querySelector('[aria-label="暂停 (Space)"]')
    return pause && !pause.disabled
  })

  await page.getByRole('button', { name: '控制器设置', exact: true }).click()
  await page.getByLabel('显示方式', { exact: true }).selectOption('overlay')
  const touchToggle = page.getByRole('switch', { name: '显示触屏按键', exact: true })
  if ((await touchToggle.getAttribute('aria-checked')) !== 'true') await touchToggle.click()
  await page.getByRole('button', { name: '完成设置', exact: true }).click()
  const overlay = page.locator('.advance-touch')
  await overlay.waitFor({ state: 'visible' })
  assert.equal(await overlay.getAttribute('data-mode'), 'overlay')
  assert.deepEqual(
    await overlay.evaluate((element) => ({
      position: getComputedStyle(element).position,
      pointerEvents: getComputedStyle(element).pointerEvents,
      buttonPointerEvents: getComputedStyle(element.querySelector('button')).pointerEvents,
    })),
    { position: 'absolute', pointerEvents: 'none', buttonPointerEvents: 'auto' },
  )

  await page.getByRole('button', { name: '进入全屏 (F11)', exact: true }).click()
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('player-panel'))
  await page.getByRole('button', { name: '退出全屏 (F11)', exact: true }).waitFor()
  await page.screenshot({ path: new URL('fullscreen-overlay.png', artifacts).pathname })
  await page.getByRole('button', { name: '退出全屏 (F11)', exact: true }).click()
  await page.waitForFunction(() => !document.fullscreenElement)

  await page.getByRole('button', { name: '管理金手指', exact: true }).click()
  await page.getByRole('button', { name: '添加金手指', exact: true }).click()
  await page.getByLabel('名称', { exact: true }).fill('回归测试代码')
  await page.getByLabel('代码', { exact: true }).fill('32000000 0001')
  await page.getByRole('switch', { name: '回归测试代码启用状态', exact: true }).click()
  await page.getByRole('button', { name: '保存并重新载入', exact: true }).click()
  await page.getByText('金手指已保存，游戏已恢复', { exact: true }).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '管理金手指', exact: true }).click()
  assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), '回归测试代码')
  assert.equal(await page.locator('.cheat-code-field textarea').inputValue(), '32000000 0001')
  assert.equal(
    await page
      .getByRole('switch', { name: '回归测试代码启用状态', exact: true })
      .getAttribute('aria-checked'),
    'false',
  )
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()

  await page.getByRole('button', { name: '模拟器设置', exact: true }).click()
  await page.locator('.modal select[aria-label="自动存档间隔"]').selectOption('5')
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  const settings = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('advance.settings') || '{}'),
  )
  assert.equal(settings.autoSaveInterval, 5)
  assert.equal(settings.touchConfig.mode, 'overlay')
  assert.deepEqual(errors, [])

  const report = {
    passed: true,
    checks: [
      'touch overlay placement and pointer pass-through',
      'Fullscreen API enter, state sync and exit',
      'per-game cheat persistence and core reload',
      'automatic save interval persistence',
    ],
  }
  await writeFile(
    new URL('player-features-result.json', artifacts),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  await page
    .screenshot({ path: new URL('player-features-failure.png', artifacts).pathname })
    .catch(() => {})
  throw error
} finally {
  await browser.close()
}
