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

  const original = Buffer.from(
    await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url)),
  )
  const localGames = ['ONE', 'TWO'].map((suffix, index) => {
    const source = Buffer.from(original)
    Buffer.from(`LIBRARY${suffix}`).copy(source, 0xac)
    source[0x90 + index] ^= 0x5a + index
    let checksum = 0x19
    for (let offset = 0xa0; offset <= 0xbc; offset++) checksum += source[offset]
    source[0xbd] = -checksum & 255
    return {
      name: `Library Orbit ${index + 1}.gba`,
      mimeType: 'application/octet-stream',
      buffer: source,
    }
  })
  await page.getByLabel('选择游戏文件', { exact: true }).setInputFiles(localGames)
  await page.getByText('已导入 2 个游戏，准备开始吧', { exact: true }).waitFor()

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

  const onlineRow = page.locator('.online-library-game', { hasText: 'star-orbit.gba' })
  assert.equal(await onlineRow.locator('input[type="checkbox"]').isDisabled(), true)
  await onlineRow.getByText('已在个人库').waitFor()

  const storedConnection = await page.evaluate(() => localStorage.getItem('advance.online-library'))
  assert.ok(storedConnection?.includes(libraryUrl))
  assert.equal(storedConnection?.includes(adminToken), false, 'admin token must not be persisted')

  await page.getByRole('tab', { name: '管理分发' }).click()
  await page.getByLabel('管理员令牌').fill(adminToken)
  const personalList = page.getByLabel('个人游戏库发布列表')
  await personalList.getByText('Library Orbit 1.gba', { exact: true }).waitFor()
  await personalList.getByText('Library Orbit 2.gba', { exact: true }).waitFor()
  await page.getByLabel('选择全部可发布游戏').check()
  assert.equal(await page.getByRole('button', { name: '发布所选（2）' }).isEnabled(), true)
  await page.getByRole('button', { name: '发布所选（2）' }).click()
  await page.getByText('已从个人游戏库发布 2 个游戏。').waitFor()
  const publishedList = page.getByLabel('已发布游戏')
  await publishedList.getByText('Library Orbit 1.gba', { exact: true }).waitFor()
  await publishedList.getByText('Library Orbit 2.gba', { exact: true }).waitFor()
  for (const title of ['Library Orbit 1', 'Library Orbit 2']) {
    const row = personalList.locator('.online-library-game', { hasText: title })
    assert.equal(await row.locator('input[type="checkbox"]').isDisabled(), true)
    await row.getByText('已发布', { exact: true }).waitFor()
  }
  assert.equal(await page.getByLabel('选择全部可发布游戏').isDisabled(), true)
  await page.screenshot({ path: new URL('desktop-online-library-manage.png', artifacts).pathname })

  for (const title of ['Library Orbit 1', 'Library Orbit 2']) {
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: `下架 ${title}` }).click()
    await page.getByText(`已下架 ${title}.gba；个人游戏库中的副本不受影响。`).waitFor()
  }
  assert.equal(await publishedList.getByText(/Library Orbit [12]\.gba/).count(), 0)
  assert.equal(await page.getByLabel('选择全部可发布游戏').isEnabled(), true)
  await page.getByRole('button', { name: /^游戏库/ }).click()
  await page.locator('.game-title', { hasText: 'Library Orbit 1' }).waitFor()
  await page.locator('.game-title', { hasText: 'Library Orbit 2' }).waitFor()

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
    'Online library page passed: platform filter, personal-library table, bulk publishing, remove, responsive layout.',
  )
} finally {
  await browser.close()
}
