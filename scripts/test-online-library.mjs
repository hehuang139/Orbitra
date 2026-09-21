import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader'],
})
const appUrl = process.env.UI_TEST_URL || 'http://127.0.0.1:5173'
const libraryUrl = process.env.ONLINE_LIBRARY_TEST_URL || 'http://127.0.0.1:4174'
const adminToken = process.env.ONLINE_LIBRARY_TEST_ADMIN_TOKEN || 'distribution-test-token'
const errors = []
const libraryRequests = []
const artifacts = new URL('../.artifacts/', import.meta.url)
await mkdir(artifacts, { recursive: true })

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.url().startsWith(libraryUrl)) {
      libraryRequests.push({
        method: request.method(),
        url: request.url(),
        authorization: request.headers().authorization,
      })
    }
  })
  await page.goto(appUrl)
  await page.waitForFunction(() => !document.querySelector('.hero-actions button')?.disabled)
  await page.getByRole('button', { name: '登录与同步' }).waitFor()
  await page.getByRole('button', { name: '在线游戏库' }).click()
  await page.getByRole('heading', { name: '在线游戏库' }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0, 'online library must be a page')
  await page.locator('.online-library-page').waitFor()
  await page.getByLabel('在线游戏库地址').fill(libraryUrl)
  await page.getByRole('button', { name: '读取目录' }).click()
  await page.getByRole('tab', { name: '浏览与导入' }).waitFor()
  await page.getByText('star-orbit.gba', { exact: true }).waitFor()
  await page.getByLabel('游戏类型').selectOption('gamecube')
  await page.getByText('没有匹配此类型或搜索条件的游戏。').waitFor()
  assert.equal(await page.getByText('star-orbit.gba', { exact: true }).count(), 0)
  await page.getByLabel('游戏类型').selectOption('gba')
  await page.getByText('star-orbit.gba', { exact: true }).waitFor()
  await page.screenshot({ path: new URL('desktop-online-library.png', artifacts).pathname })

  const source = Buffer.from(
    await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url)),
  )
  Buffer.from('LIBRARYTEST1').copy(source, 0xac)
  let checksum = 0x19
  for (let offset = 0xa0; offset <= 0xbc; offset++) checksum += source[offset]
  source[0xbd] = -checksum & 255

  await page.getByRole('tab', { name: '管理分发' }).click()
  await page.getByLabel('管理员令牌').fill(adminToken)
  await page.getByRole('button', { name: '本地文件' }).click()
  await page.getByLabel('发布 ROM').setInputFiles({
    name: 'Library Orbit.gba',
    mimeType: 'application/octet-stream',
    buffer: source,
  })
  await page.getByRole('button', { name: '发布到在线库' }).click()
  await page.getByText('已发布 Library Orbit.gba。').waitFor()
  await page.locator('.online-library-managed-game', { hasText: 'Library Orbit' }).waitFor()
  await page.getByText('Library Orbit.gba', { exact: true }).waitFor()
  await page.screenshot({ path: new URL('desktop-online-library-manage.png', artifacts).pathname })

  await page.getByRole('tab', { name: '浏览与导入' }).click()
  const row = page.locator('.online-library-game', { hasText: 'Library Orbit' })
  await row.locator('input[type="checkbox"]').check()
  await page.getByRole('button', { name: '导入所选（1）' }).click()
  await page.getByText('已导入 1 个游戏').waitFor()
  assert.equal(await row.locator('input[type="checkbox"]').isDisabled(), true)
  await row.getByText('已在个人库').waitFor()

  const storedConnection = await page.evaluate(() => localStorage.getItem('advance.online-library'))
  assert.ok(storedConnection?.includes(libraryUrl))
  assert.equal(storedConnection?.includes(adminToken), false, 'admin token must not be persisted')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('tab', { name: '管理分发' }).click()
  await page.getByRole('button', { name: '下架 Library Orbit' }).click()
  await page.getByText('已下架 Library Orbit.gba；个人游戏库中的副本不受影响。').waitFor()
  assert.equal(
    await page.locator('.online-library-managed-game', { hasText: 'Library Orbit' }).count(),
    0,
  )
  await page.getByRole('button', { name: '个人游戏库' }).click()
  await page.getByLabel('选择个人游戏').selectOption({ label: 'Library Orbit (GBA)' })
  await page.getByRole('button', { name: '发布到在线库' }).click()
  await page.getByText('已从个人游戏库发布 Library Orbit.gba。').waitFor()
  await page.locator('.online-library-managed-game', { hasText: 'Library Orbit' }).waitFor()
  assert.equal(await page.getByLabel('选择个人游戏').isDisabled(), true)
  assert.equal(
    await page.getByLabel('选择个人游戏').inputValue(),
    '',
    'a published personal game must no longer be offered for upload',
  )

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '下架 Library Orbit' }).click()
  await page.getByText('已下架 Library Orbit.gba；个人游戏库中的副本不受影响。').waitFor()
  await page.getByRole('button', { name: /^游戏库/ }).click()
  await page.locator('.game-title', { hasText: 'Library Orbit' }).waitFor()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.getByRole('button', { name: '在线游戏库' }).click()
  await page.getByRole('tab', { name: '浏览与导入' }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.sidebar')?.classList.contains('open'))
  await page.waitForTimeout(250)
  assert.equal(await page.getByRole('dialog').count(), 0, 'mobile online library must be a page')
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'mobile online library must not overflow',
  )
  await page.screenshot({ path: new URL('mobile-online-library.png', artifacts).pathname })
  await page.getByRole('tab', { name: '管理分发' }).click()
  await page.getByLabel('管理员令牌').waitFor()
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'mobile distribution management must not overflow',
  )
  await page.screenshot({ path: new URL('mobile-online-library-manage.png', artifacts).pathname })

  assert.equal(
    libraryRequests.some((request) => request.url.includes('/api/auth')),
    false,
    'distribution library must never receive account API requests',
  )
  assert.equal(
    libraryRequests
      .filter((request) => !request.url.includes('/admin/games/'))
      .some((request) => request.authorization),
    false,
    'public catalog and ROM downloads must not receive the admin token',
  )
  assert.deepEqual(errors, [], 'online library flow should not produce uncaught browser errors')
  await context.close()
  console.log(
    'Online library page passed: platform filter, file and personal-library publishing, import, deduplicate, remove, responsive layout.',
  )
} finally {
  await browser.close()
}
