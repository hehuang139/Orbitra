// Synthetic Gamepad API input through the real UI and real mGBA adapter.
// This does not certify physical controller hardware. Start Vite before running.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const artifacts = new URL('../.artifacts/', import.meta.url)
const url = process.env.UI_TEST_URL || 'http://127.0.0.1:5173'

try {
  await mkdir(artifacts, { recursive: true })
  await page.addInitScript(() => {
    window.__testPads = [
      {
        id: 'Synthetic custom controller',
        index: 0,
        mapping: '',
        connected: true,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
        axes: [0, 0, 0, 0],
      },
    ]
    window.__testPadFocused = true
    window.__testPadBlocked = false
    window.__testPadKeys = new Set()
    window.__testPadEvents = []
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => window.__testPadFocused,
    })
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => {
        if (window.__testPadBlocked)
          throw new DOMException('Blocked by test policy', 'SecurityError')
        return window.__testPads
      },
    })
  })
  // Observe adapter calls without shipping a test-only API in the application.
  await page.route('**/src/emulator/index.ts*', async (route) => {
    const response = await route.fetch()
    const original = await response.text()
    assert.match(original, /\bcreateEmulator\b/)
    const body =
      original.replace(/\bcreateEmulator\b/g, 'createObservedEmulator') +
      `
      export function createEmulator(...args) {
        const engine = createObservedEmulator(...args);
        for (const method of ['keyDown', 'keyUp', 'releaseAllKeys']) {
          const originalMethod = engine[method];
          engine[method] = (...values) => {
            window.__testPadEvents.push([method, values[0] ?? null]);
            if (method === 'keyDown') window.__testPadKeys.add(values[0]);
            if (method === 'keyUp') window.__testPadKeys.delete(values[0]);
            if (method === 'releaseAllKeys') window.__testPadKeys.clear();
            return originalMethod.apply(engine, values);
          };
        }
        return engine;
      }
    `
    await route.fulfill({ response, body })
  })

  const setButton = (index, pressed, padIndex = 0) =>
    page.evaluate(
      ({ index, pressed, padIndex }) => {
        window.__testPads[padIndex].buttons[index] = { pressed, value: pressed ? 1 : 0 }
      },
      { index, pressed, padIndex },
    )
  const setAxis = (index, value) =>
    page.evaluate(
      ({ index, value }) => {
        window.__testPads[0].axes[index] = value
      },
      { index, value },
    )
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  const waitKeys = (keys) =>
    page.waitForFunction(
      (expected) =>
        JSON.stringify([...window.__testPadKeys].sort()) === JSON.stringify([...expected].sort()),
      keys,
    )
  const mapping = (key) => page.getByRole('button', { name: `映射手柄 ${key}`, exact: true })
  const controls = () => page.getByRole('button', { name: '控制器设置', exact: true }).click()

  await page.goto(url)
  await page.getByRole('button', { name: '开始试玩', exact: true }).waitFor()
  await controls()
  await page.getByText('非标准布局：请逐项设置按键或轴方向后使用。', { exact: false }).waitFor()
  assert.equal(
    await page
      .locator('.gamepad-bind-button')
      .allTextContents()
      .then((labels) => labels.every((label) => label === '未映射')),
    true,
  )

  await setButton(3, true)
  await frames()
  await mapping('A').click()
  await frames()
  assert.equal(
    await mapping('A').textContent(),
    '等待输入…',
    'already-held input must not be captured',
  )
  await page.keyboard.press('Escape')
  assert.equal(await mapping('A').textContent(), '未映射')
  assert.equal(
    await page.getByRole('dialog').count(),
    1,
    'Escape cancels capture before closing the dialog',
  )
  await mapping('A').click()
  await setButton(3, false)
  await frames()
  await setButton(3, true)
  await page.getByText('A 已映射为按键 4。', { exact: true }).waitFor()
  await setButton(3, false)

  await mapping('Left').click()
  await setAxis(0, -0.9)
  await page.getByText('Left 已映射为轴 1 −。', { exact: true }).waitFor()
  await setAxis(0, 0)
  await page.locator('#gamepad-deadzone').fill('65')
  assert.equal(await page.locator('#gamepad-deadzone').inputValue(), '65')
  await mapping('B').click()
  await page.getByRole('button', { name: '取消映射', exact: true }).click()
  assert.equal(await mapping('B').textContent(), '未映射')
  await mapping('B').click()
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await controls()
  assert.equal(await mapping('B').textContent(), '未映射', 'closing controls cancels capture')

  await page.reload()
  await controls()
  await mapping('A').waitFor()
  assert.equal(await mapping('A').textContent(), '按键 4')
  assert.equal(await mapping('Left').textContent(), '轴 1 −')
  assert.equal(await page.locator('#gamepad-deadzone').inputValue(), '65')
  await page.locator('.gamepad-settings').scrollIntoViewIfNeeded()
  await page.screenshot({
    path: fileURLToPath(new URL('v11-gamepad-desktop.png', artifacts)),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.locator('.modal').evaluate((modal) => {
    modal.scrollTop = modal.querySelector('.gamepad-settings').offsetTop - modal.offsetTop - 12
  })
  await frames()
  await page.screenshot({
    path: fileURLToPath(new URL('v11-gamepad-mobile.png', artifacts)),
    fullPage: false,
  })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()

  await page.getByRole('button', { name: '开始试玩', exact: true }).click()
  await page.getByRole('button', { name: '开始游戏', exact: true }).click()
  await page.waitForFunction(
    () =>
      !!document.querySelector('[aria-label="暂停 (Space)"]') &&
      !document.querySelector('[aria-label="暂停 (Space)"]').disabled,
  )
  await setButton(3, true)
  await waitKeys(['A'])
  await controls()
  await waitKeys([])
  await setButton(3, false)
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await setAxis(0, -0.6)
  await frames()
  await waitKeys([])
  await setAxis(0, -0.9)
  await waitKeys(['Left'])
  await page.evaluate(() => {
    window.__testPadFocused = false
    window.dispatchEvent(new Event('blur'))
  })
  await waitKeys([])
  await setAxis(0, 0)
  await page.evaluate(() => {
    window.__testPadFocused = true
    window.dispatchEvent(new Event('focus'))
  })
  await setButton(3, true)
  await waitKeys(['A'])
  await page.evaluate(() => {
    const pad = window.__testPads[0]
    pad.connected = false
    const event = new Event('gamepaddisconnected')
    Object.defineProperty(event, 'gamepad', { value: pad })
    window.dispatchEvent(event)
  })
  await waitKeys([])

  await controls()
  await page.getByText('未检测到手柄', { exact: true }).waitFor()
  await page.evaluate(() => {
    window.__testPads[0].index = 2
    window.__testPads[0].connected = true
    window.__testPads[0].buttons[3] = { pressed: false, value: 0 }
  })
  await mapping('A').waitFor()
  assert.equal(
    await mapping('A').textContent(),
    '按键 4',
    'reconnecting in another browser slot keeps its profile',
  )
  await mapping('B').click()
  await page.evaluate(() => {
    window.__testPadFocused = false
    window.dispatchEvent(new Event('blur'))
  })
  await page.getByText('页面失去焦点，映射已取消。', { exact: true }).waitFor()
  assert.equal(await mapping('B').textContent(), '未映射')
  await page.evaluate(() => {
    window.__testPadFocused = true
    window.dispatchEvent(new Event('focus'))
  })

  await page.evaluate(() => {
    window.__originalStorageSet = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'advance.gamepads.v1') throw new DOMException('Quota test', 'QuotaExceededError')
      return window.__originalStorageSet.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: '重置手柄映射', exact: true }).click()
  await page.getByText('浏览器无法保存手柄设置；本次页面内仍然有效。', { exact: true }).waitFor()
  assert.equal(await mapping('A').textContent(), '未映射')
  assert.equal(await page.locator('#gamepad-deadzone').inputValue(), '45')
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__originalStorageSet
    const standard = {
      id: 'Synthetic standard controller',
      index: 1,
      mapping: 'standard',
      connected: true,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
    }
    window.__testPads.push(standard, { ...structuredClone(standard), index: 3 })
  })
  await page.getByText('3 台已连接', { exact: true }).waitFor()
  await page.locator('#gamepad-device').selectOption('1')
  assert.equal(await mapping('A').textContent(), '按键 1')
  assert.equal(await mapping('Up').textContent(), '按键 13 / 轴 2 −')
  assert.equal(await page.locator('#gamepad-deadzone').inputValue(), '45')
  await mapping('B').click()
  await setButton(0, true, 1)
  await page.getByText('B 已映射为按键 1。已移除 A 的同一输入映射。', { exact: true }).waitFor()
  assert.equal(await mapping('A').textContent(), '未映射')
  await setButton(0, false, 1)
  await page.getByRole('button', { name: '恢复手柄默认映射', exact: true }).click()
  assert.equal(await mapping('A').textContent(), '按键 1')
  assert.equal(await mapping('B').textContent(), '按键 2')
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await setButton(0, true, 1)
  await waitKeys(['A'])
  await setButton(0, true, 2)
  await frames()
  await page.evaluate(() => {
    window.__testPadEvents = []
    const pad = window.__testPads[1]
    pad.connected = false
    const event = new Event('gamepaddisconnected')
    Object.defineProperty(event, 'gamepad', { value: pad })
    window.dispatchEvent(event)
  })
  await frames()
  await waitKeys(['A'])
  assert.equal(
    await page.evaluate(() =>
      window.__testPadEvents.some(([method, key]) => method === 'keyUp' && key === 'A'),
    ),
    false,
    'a second pad retains ownership across disconnect',
  )
  await page.locator('canvas').focus()
  await page.keyboard.down('KeyX')
  await setButton(0, false, 2)
  await frames()
  await waitKeys(['A'])
  await page.keyboard.up('KeyX')
  await waitKeys([])
  await setButton(15, true, 2)
  await waitKeys(['Right'])

  await page.evaluate(() => {
    window.__testPadBlocked = true
  })
  await waitKeys([])
  await controls()
  await page
    .getByText('浏览器禁止访问手柄，请在允许 Gamepad API 的安全页面中重试。', { exact: true })
    .waitFor()
  await waitKeys([])
  await setButton(15, false, 2)
  await page.evaluate(() => {
    window.__testPadBlocked = false
  })
  await page.getByText('2 台已连接', { exact: true }).waitFor()
  assert.equal(await page.locator('.gamepad-settings .gamepad-notice').count(), 0)
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify(
      {
        gamepad: 'passed',
        hardware: 'synthetic API, no physical controller certification',
        checks: [
          'safe nonstandard defaults',
          'standard defaults and reset',
          'held capture',
          'button and signed axis capture',
          'Escape/button/modal cancellation',
          'deadzone',
          'reload and reconnect persistence',
          'modal/blur/disconnect input release',
          'shared ownership across two pads and keyboard',
          'storage failure',
          'Gamepad API SecurityError',
          'responsive settings',
        ],
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
