import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } })
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const button = (name) => page.getByRole('button', { name, exact: true })
// Traverse the real tab order: this catches hidden/background focus targets.
async function tabTo(locator) {
  for (let i = 0; i < 100; i++) {
    if (await locator.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(
    `Unreachable by keyboard: ${(await locator.getAttribute('aria-label')) || (await locator.textContent())}`,
  )
}
async function activate(name) {
  console.log(`Keyboard: ${name}`)
  const target = button(name)
  await tabTo(target)
  await page.keyboard.press('Enter')
}
try {
  await page.goto(process.env.UI_TEST_URL || 'http://127.0.0.1:5173')
  await page.waitForFunction(() => !document.querySelector('.hero-actions button')?.disabled)
  const chooser = page.waitForEvent('filechooser')
  await activate('导入游戏')
  await (
    await chooser
  ).setFiles({
    name: 'star-orbit.gba',
    mimeType: 'application/octet-stream',
    buffer: await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url)),
  })
  await page.getByText('1 个重复游戏已合并', { exact: true }).waitFor()
  await activate('控制器设置')
  assert.equal(await button('关闭对话框').evaluate((el) => el === document.activeElement), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await button('完成设置').evaluate((el) => el === document.activeElement), true)
  await page.keyboard.press('Tab')
  assert.equal(await button('关闭对话框').evaluate((el) => el === document.activeElement), true)
  await activate('A 按钮键盘映射：X')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 1, 'cancel mapping must keep dialog open')
  assert.equal(
    await button('A 按钮键盘映射：X').evaluate((el) => el === document.activeElement),
    true,
  )
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await button('控制器设置').evaluate((el) => el === document.activeElement), true)
  await activate('开始试玩')
  await activate('开始游戏')
  await page.waitForFunction(() => {
    const pause = document.querySelector('[aria-label="暂停 (Space)"]')
    return pause && !pause.disabled
  })
  assert.equal(await page.locator('canvas').evaluate((el) => el === document.activeElement), true)
  await page.keyboard.press('Space')
  console.log('Keyboard: paused')
  await button('继续 (Space)').waitFor()
  await page.keyboard.press('Space')
  await button('暂停 (Space)').waitFor()
  await page.keyboard.press('F5')
  console.log('Keyboard: save slot 1')
  await page.getByText('已保存到存档位 1', { exact: true }).waitFor()
  // The save toast can render before run() has released its operation lock.
  await page.waitForFunction(() => {
    const control = document.querySelector('[aria-label="快速读档 (F8)"]')
    return control && !control.disabled
  })
  assert.equal(await page.locator('canvas').evaluate((el) => el === document.activeElement), true)
  await page.keyboard.press('F8')
  await page.getByText('已恢复存档', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await button('暂停 (Space)').evaluate((el) => el === document.activeElement), true)
  await activate('返回游戏库')
  await button('开始试玩').waitFor()
  await page.waitForFunction(
    () => document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent?.trim() === '开始试玩',
  )
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'keyboard ROM import',
          'dialog focus trap and restore',
          'mapping cancellation',
          'launch focus',
          'pause/resume',
          'save/load',
          'leave canvas and exit game',
        ],
      },
      null,
      2,
    ),
  )
} catch (error) {
  await mkdir(new URL('../.artifacts/', import.meta.url), { recursive: true })
  await page.screenshot({ path: '.artifacts/keyboard-failure.png', fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
