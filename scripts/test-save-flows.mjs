import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, acceptDownloads: true })
const page = await context.newPage()
page.setDefaultTimeout(15000)
const errors = []
let phase = 'initial page load'
page.on('pageerror', error => errors.push({ phase, stack: error.stack || error.message }))
const artifacts = new URL('../.artifacts/', import.meta.url)
const checks = []
const demo = 'Star Orbit · 星际漫游'
const second = 'Battery-Switch-Orbit'

async function ready() {
  await page.getByRole('button', { name: `开始 ${demo}`, exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.game-cover')?.disabled)
}

async function launch(title) {
  phase = `launch ${title}`
  await page.getByRole('button', { name: `开始 ${title}`, exact: true }).click()
  await page.getByRole('button', { name: '开始游戏', exact: true }).click()
  await page.waitForFunction(() => {
    const control = document.querySelector('[aria-label="暂停 (Space)"]')
    return control && !control.disabled
  })
  assert.equal(await page.locator('.player-heading strong').innerText(), title)
}

async function openSaves() {
  await page.getByRole('button', { name: '管理即时存档', exact: true }).click()
  await page.getByRole('button', { name: '导出 .sav', exact: true }).waitFor()
}

async function closeSaves() {
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
}

async function importBattery(score) {
  phase = `import .sav with score ${score}`
  const bytes = Buffer.alloc(32768)
  bytes.set([83, 79, 1, score, score ^ 255])
  await page.locator('input[type="file"][accept=".sav"]').setInputFiles({
    name: `orbit-${score}.sav`, mimeType: 'application/octet-stream', buffer: bytes,
  })
  const success = page.getByText('存档已导入，游戏已重新启动', { exact: true })
  const failure = page.getByRole('alert')
  await success.or(failure).waitFor()
  assert.equal(await failure.count(), 0, `import ${score}: ${await failure.allTextContents()}`)
  await page.waitForFunction(() => !document.querySelector('[aria-label="暂停 (Space)"]')?.disabled)
}

async function assertBattery(score, message) {
  phase = message
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 .sav', exact: true }).click()
  const download = await pending
  assert.match(download.suggestedFilename(), /\.sav$/)
  const bytes = await readFile(await download.path())
  assert.equal(bytes.length, 32768, `${message}: SRAM size`)
  assert.deepEqual([...bytes.subarray(0, 5)], [83, 79, 1, score, score ^ 255], message)
  checks.push(message)
}

try {
  await page.goto(process.env.UI_TEST_URL || 'http://127.0.0.1:5173')
  await ready()

  // Establish an older automatic state, so restoring it would visibly undo an import.
  await launch(demo)
  await openSaves()
  await assertBattery(0, 'fresh ROM initializes a valid SRAM record')
  await closeSaves()
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()
  await ready()
  await launch(demo)
  await openSaves()
  await page.getByRole('button', { name: '导出存档位 0', exact: true }).waitFor()
  await importBattery(7)
  await assertBattery(7, 'imported .sav reaches the running core')

  // Reload while still in the player: recover the unfinished session without hiding imported SRAM.
  await page.reload()
  await ready()
  await page.getByRole('heading', { name: '恢复未结束的游戏', exact: true }).waitFor()
  await page.getByRole('button', { name: '恢复进度', exact: true }).click()
  await page.waitForFunction(() => {
    const control = document.querySelector('[aria-label="暂停 (Space)"]')
    return control && !control.disabled
  })
  await openSaves()
  await assertBattery(7, 'unfinished-session recovery preserves imported progress')
  await closeSaves()
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()
  await ready()
  await page.reload()
  await ready()
  await launch(demo)
  await openSaves()
  await assertBattery(7, 'close, reload and replay preserve imported progress')
  await closeSaves()

  // Change the actual cartridge header and repair its checksum to make a second ROM.
  const rom = Buffer.from(await readFile(new URL('../public/demo/star-orbit.gba', import.meta.url)))
  Buffer.from('SVB2').copy(rom, 0xac)
  let checksum = 0x19
  for (let offset = 0xa0; offset <= 0xbc; offset++) checksum += rom[offset]
  rom[0xbd] = -checksum & 255
  await page.getByLabel('选择游戏文件', { exact: true }).setInputFiles({
    name: `${second}.gba`, mimeType: 'application/octet-stream', buffer: rom,
  })
  await page.getByText('已导入 1 个游戏，准备开始吧', { exact: true }).waitFor()
  assert.equal(await page.locator('.game-card').count(), 2)
  await launch(second)
  await openSaves()
  await assertBattery(0, 'a second cartridge starts with independent SRAM')
  await importBattery(23)
  await assertBattery(23, 'second cartridge accepts its own .sav')
  await closeSaves()

  // Switch directly between running cartridges; engine flushes must use the old game ID.
  await launch(demo)
  await openSaves()
  await assertBattery(7, 'switching back retains the first cartridge SRAM')
  await closeSaves()
  await launch(second)
  await openSaves()
  await assertBattery(23, 'switching again retains the second cartridge SRAM')
  await closeSaves()
  await page.getByRole('button', { name: '返回游戏库', exact: true }).click()
  await ready()
  await page.reload()
  await ready()
  for (const [title, score] of [[demo, 7], [second, 23]]) {
    await launch(title)
    await openSaves()
    await assertBattery(score, `${title}: independent SRAM survives reload`)
    await closeSaves()
  }
  assert.deepEqual(errors, [], 'save workflows have no uncaught browser errors')
  const result = JSON.stringify({ passed: true, checks }, null, 2)
  await mkdir(artifacts, { recursive: true })
  await writeFile(new URL('save-flows-result.json', artifacts), result)
  console.log(result)
} catch (error) {
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({ path: fileURLToPath(new URL('save-flow-failure.png', artifacts)), fullPage: true }).catch(() => {})
  const result = JSON.stringify({ passed: false, phase, completedChecks: checks, browserErrors: errors, error: error.stack || String(error) }, null, 2)
  await writeFile(new URL('save-flows-result.json', artifacts), result)
  console.error(result)
  throw error
} finally {
  await browser.close()
}
