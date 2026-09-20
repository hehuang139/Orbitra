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
const importedCount = 20
const titles = Array.from(
  { length: importedCount },
  (_, index) => `Synced Orbit ${String(index + 1).padStart(2, '0')}`,
)
const errors = []

async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
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
    .getByText(/已同步 1 个游戏清单及存档/)
    .waitFor()
  await first.page.getByRole('button', { name: '关闭对话框' }).click()

  const second = await openPage()
  await openAccount(second.page)
  await second.page.getByLabel('用户名').fill(username)
  await second.page.getByLabel('密码', { exact: true }).fill(password)
  await second.page.getByRole('button', { name: '登录并恢复' }).click()
  await second.page
    .locator('.account-panel')
    .getByText(/已同步 1 个游戏清单及存档/)
    .waitFor()
  await second.page.getByRole('button', { name: '关闭对话框' }).click()

  const source = await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url))
  const files = titles.map((title, index) => {
    const rom = Buffer.from(source)
    Buffer.from(`SYNC${String(index).padStart(4, '0')}`).copy(rom, 0xac)
    let checksum = 0x19
    for (let offset = 0xa0; offset <= 0xbc; offset++) checksum += rom[offset]
    rom[0xbd] = -checksum & 255
    return { name: `${title}.gba`, mimeType: 'application/octet-stream', buffer: rom }
  })
  await first.page.getByLabel('选择游戏文件', { exact: true }).setInputFiles(files)
  await first.page
    .getByText(`已导入 ${importedCount} 个游戏，准备开始吧`, { exact: true })
    .waitFor()
  await openAccount(first.page)
  await first.page
    .locator('.account-panel')
    .getByText(new RegExp(`已同步 ${importedCount + 1} 个游戏清单及存档`))
    .waitFor()
  await second.page.waitForFunction(
    (expected) => document.querySelectorAll('.game-card').length === expected,
    importedCount + 1,
  )
  await second.page.locator('.game-title', { hasText: titles.at(-1) }).waitFor()
  assert.equal(await second.page.locator('.game-card').count(), importedCount + 1)
  const romCount = (page) =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('advance-gba', 1)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            const count = database.transaction('roms').objectStore('roms').count()
            count.onerror = () => reject(count.error)
            count.onsuccess = () => {
              database.close()
              resolve(count.result)
            }
          }
        }),
    )
  assert.equal(
    await romCount(second.page),
    1,
    'the second browser should only have its bundled demo ROM',
  )
  await second.page.getByRole('button', { name: `开始 ${titles.at(-1)}` }).click()
  await second.page.getByText('正在游玩', { exact: true }).waitFor()
  assert.equal(await romCount(second.page), 2, 'playing should cache only the requested cloud ROM')
  await second.page.getByRole('button', { name: '批量管理' }).click()
  assert.equal(
    await second.page.getByRole('button', { name: 'Star Orbit · 星际漫游 无法选择' }).isDisabled(),
    true,
    'the bundled demo must not be selectable',
  )
  assert.equal(
    await second.page.getByRole('button', { name: `${titles.at(-1)} 无法选择` }).isDisabled(),
    true,
    'the running game must not be selectable',
  )
  await second.page.getByRole('button', { name: '完成' }).click()
  await first.page.getByRole('button', { name: '关闭对话框' }).click()
  await first.page.getByRole('button', { name: '批量管理' }).click()
  assert.equal(
    await first.page.getByRole('button', { name: 'Star Orbit · 星际漫游 无法选择' }).isDisabled(),
    true,
    'the bundled demo must not be selectable in batch mode',
  )
  await first.page.getByRole('button', { name: `选择 ${titles[0]}` }).click()
  await first.page.getByRole('button', { name: `选择 ${titles[1]}` }).click()
  await first.page.getByText('已选择 2 个游戏', { exact: true }).waitFor()
  await first.page.getByRole('button', { name: '删除所选' }).click()
  await first.page.getByRole('heading', { name: '删除选中的 2 个游戏？' }).waitFor()
  await first.page.getByRole('button', { name: '删除 2 个游戏' }).click()
  await first.page.getByText('已删除 2 个游戏及其存档', { exact: true }).waitFor()
  await first.page.waitForFunction(
    (expected) => document.querySelectorAll('.game-card').length === expected,
    importedCount - 1,
  )
  await second.page.waitForFunction(
    (expected) => document.querySelectorAll('.game-card').length === expected,
    importedCount - 1,
  )
  assert.equal(await first.page.locator('.game-title', { hasText: titles[0] }).count(), 0)
  assert.equal(await second.page.locator('.game-title', { hasText: titles[1] }).count(), 0)
  await first.context.close()

  await openAccount(second.page)
  await second.page.getByRole('button', { name: '退出登录' }).click()
  await second.page.getByText('已退出账号。本地游戏仍保留在此浏览器。').waitFor()
  await second.page.getByRole('button', { name: '关闭对话框' }).click()
  await second.page.locator('.game-title', { hasText: titles.at(-1) }).waitFor()
  await second.context.close()

  assert.deepEqual(errors, [], 'account flow should not produce uncaught browser errors')
  console.log(
    `Account sync flow passed: ${importedCount} automatic item uploads, protected batch selection, live cross-browser batch delete, logout retention.`,
  )
} finally {
  await browser.close()
}
