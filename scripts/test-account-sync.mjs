import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader'],
})
const url = process.env.UI_TEST_URL || 'http://127.0.0.1:5173'
const username = `sync-${Date.now().toString(36)}`
const password = 'account-test-password'
const title = 'Synced Orbit'
const errors = []

async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => !document.querySelector('.hero-actions button')?.disabled)
  return { context, page }
}

async function openAccount(page) {
  await page.getByRole('button', { name: /登录与同步|sync-/ }).click()
  await page.getByRole('heading', { name: '账号与游戏同步' }).waitFor()
}

try {
  const first = await openPage()
  await openAccount(first.page)
  await first.page.getByRole('tab', { name: '注册' }).click()
  await first.page.getByLabel('用户名').fill(username)
  await first.page.getByLabel('密码', { exact: true }).fill(password)
  await first.page.getByLabel('确认密码').fill(password)
  await first.page.getByRole('button', { name: '创建账号并同步' }).click()
  await first.page
    .locator('.account-panel')
    .getByText(/已同步 1 个游戏及其存档/)
    .waitFor()
  await first.page.getByRole('button', { name: '关闭对话框' }).click()

  const second = await openPage()
  await openAccount(second.page)
  await second.page.getByLabel('用户名').fill(username)
  await second.page.getByLabel('密码', { exact: true }).fill(password)
  await second.page.getByRole('button', { name: '登录并恢复' }).click()
  await second.page
    .locator('.account-panel')
    .getByText(/已同步 1 个游戏及其存档/)
    .waitFor()
  await second.page.getByRole('button', { name: '关闭对话框' }).click()

  const rom = Buffer.from(await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url)))
  Buffer.from('SYNC').copy(rom, 0xac)
  let checksum = 0x19
  for (let offset = 0xa0; offset <= 0xbc; offset++) checksum += rom[offset]
  rom[0xbd] = -checksum & 255
  await first.page
    .locator('input[type=file][accept*=".gba"]')
    .setInputFiles({ name: `${title}.gba`, mimeType: 'application/octet-stream', buffer: rom })
  await first.page.getByText('已导入 1 个游戏，准备开始吧', { exact: true }).waitFor()
  await openAccount(first.page)
  await first.page
    .locator('.account-panel')
    .getByText(/已同步 2 个游戏及其存档/)
    .waitFor()
  await second.page.locator('.game-title', { hasText: title }).waitFor()
  await first.context.close()

  await openAccount(second.page)
  await second.page.getByRole('button', { name: '退出登录' }).click()
  await second.page.getByText('已退出账号。本地游戏仍保留在此浏览器。').waitFor()
  await second.page.getByRole('button', { name: '关闭对话框' }).click()
  await second.page.locator('.game-title', { hasText: title }).waitFor()
  await second.context.close()

  assert.deepEqual(errors, [], 'account flow should not produce uncaught browser errors')
  console.log(
    'Account sync flow passed: register, automatic upload, live cross-browser restore, logout retention.',
  )
} finally {
  await browser.close()
}
