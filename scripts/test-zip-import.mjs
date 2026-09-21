import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const checks = []
const rom = new Uint8Array(
  await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url)),
)
const variant = (index) => {
  const result = new Uint8Array(rom)
  result[0xac] = 90
  result[0xad] = 80
  result[0xae] = 65
  result[0xaf] = index
  let checksum = -0x19
  for (let i = 0xa0; i < 0xbd; i++) checksum -= result[i]
  result[0xbd] = checksum & 255
  return result
}
const upload = async (name, buffer) => {
  await page
    .getByLabel('选择游戏文件', { exact: true })
    .setInputFiles({ name, mimeType: 'application/zip', buffer: Buffer.from(buffer) })
  await page.waitForFunction(() => !document.querySelector('.import-top')?.disabled)
}
const notice = () => page.locator('.toast')
const count = async (expected) => {
  await page.waitForFunction((n) => document.querySelectorAll('.game-card').length === n, expected)
  assert.equal(await page.locator('.game-card').count(), expected)
}
const launch = async (title) => {
  await page.getByRole('button', { name: `开始 ${title}`, exact: true }).click()
  await page.getByRole('button', { name: '开始游戏', exact: true }).click()
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="暂停 (Space)"]')
    return button && !button.disabled
  })
}
try {
  await page.goto(process.env.UI_TEST_URL || 'http://127.0.0.1:5173')
  await count(1)
  assert.match(
    await page.getByLabel('选择游戏文件', { exact: true }).getAttribute('accept'),
    /\.zip/,
  )
  const multi = zipSync({
    'docs/readme.txt': new TextEncoder().encode('Original ROM fixtures'),
    'nested/试玩/Zip-Alpha.GBA': variant(1),
    'nested/Zip-Beta.gba': [variant(2), { level: 0 }],
    'original/star-orbit.gba': rom,
    '__MACOSX/._Star.GBA': new Uint8Array([1]),
  })
  await upload('multi-game.ZIP', multi)
  await count(3)
  assert.match(await notice().innerText(), /已导入 2 个游戏.*1 个重复游戏已合并/)
  await page.getByRole('button', { name: '收藏 Zip-Alpha', exact: true }).click()
  await launch('Zip-Alpha')
  await page.keyboard.press('F5')
  await page.getByText('已保存到存档位 1', { exact: true }).waitFor()
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()
  await page.getByRole('button', { name: '开始试玩', exact: true }).waitFor()
  checks.push('mixed Stored/Deflate ZIP imports nested GBA files and runs the actual ROM')

  await upload('same-games.zip', multi)
  assert.match(await notice().innerText(), /3 个重复游戏已合并/)
  await count(3)
  await page.reload()
  await count(3)
  const alpha = page
    .locator('.game-card')
    .filter({ has: page.getByRole('button', { name: '开始 Zip-Alpha', exact: true }) })
  assert.equal(await alpha.locator('.favorite-button.is-favorite').count(), 1)
  await page.getByRole('button', { name: '存档管理', exact: true }).click()
  await page.locator('.state-card').nth(1).waitFor()
  assert.equal(await page.locator('.state-card').count(), 2)
  await page.getByRole('button', { name: /^游戏库/ }).click()
  checks.push('reimport and reload preserve game identity, favorites, and both save slots')

  const dropped = zipSync({ 'folder/Zip-Gamma.gba': variant(3) })
  await page.evaluate((bytes) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([new Uint8Array(bytes)], 'dragged.zip', { type: 'application/zip' }),
    )
    document
      .querySelector('.app-shell')
      .dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
  }, Array.from(dropped))
  await count(4)
  assert.match(await notice().innerText(), /已导入 1 个游戏/)
  checks.push('drag-and-drop ZIP uses the same extraction path')

  await upload('docs-only.zip', zipSync({ 'readme.txt': new Uint8Array([1, 2, 3]) }))
  assert.match(await notice().innerText(), /没有.*\.gba|未找到.*\.gba|不包含.*\.gba/)
  await count(4)
  await upload('broken.zip', new Uint8Array([80, 75, 1, 2, 3]))
  assert.equal(await notice().getAttribute('role'), 'alert')
  await count(4)
  await page.getByLabel('选择游戏文件', { exact: true }).setInputFiles([
    { name: 'still-broken.zip', mimeType: 'application/zip', buffer: Buffer.from([1, 2, 3]) },
    {
      name: 'Zip-Delta.gba',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(variant(4)),
    },
  ])
  await count(5)
  assert.match(await notice().innerText(), /已导入 1 个游戏.*still-broken\.zip/)
  checks.push('empty/corrupt archives produce errors without blocking other selected games')

  await launch('Zip-Alpha')
  await page.keyboard.press('F8')
  await page.getByText('已恢复存档', { exact: true }).waitFor()
  await page.getByRole('button', { name: '暂停 (Space)', exact: true }).click()
  const artifacts = new URL('../.artifacts/', import.meta.url)
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({
    path: fileURLToPath(new URL('zip-import.png', artifacts)),
    fullPage: true,
  })
  checks.push('ZIP-imported ROM resumes its persisted real mGBA state')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, checks, browserErrors: errors }, null, 2))
} catch (error) {
  const artifacts = new URL('../.artifacts/', import.meta.url)
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({ path: fileURLToPath(new URL('zip-failure.png', artifacts)), fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
