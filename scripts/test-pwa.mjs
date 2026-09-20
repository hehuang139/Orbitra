import assert from 'node:assert/strict'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
    : {}),
})
const url = process.env.PWA_TEST_URL || process.env.UI_TEST_URL || 'http://127.0.0.1:4173'
const context = await browser.newContext()
const page = await context.newPage()
try {
  await page.goto(url, { waitUntil: 'networkidle' })
  assert.equal(await page.evaluate(() => !!document.querySelector('link[rel="manifest"]')), true)
  const manifest = await page.evaluate(() =>
    fetch('/manifest.webmanifest').then((response) => response.json()),
  )
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.scope, '/')
  assert.match(manifest.description, /GBA.*GB.*GBC/)

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('service workers are unavailable')
    await navigator.serviceWorker.ready
  })
  const workerState = await page.evaluate(() => ({
    controlled: Boolean(navigator.serviceWorker.controller),
    registration: Boolean(navigator.serviceWorker.getRegistration),
  }))
  // Registration becomes controlling after the first navigation. Reload once
  // so the offline assertion exercises the worker rather than the network.
  if (!workerState.controlled) await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true)
  assert.equal(
    await page.evaluate(async () =>
      (await caches.keys()).some((key) => key.startsWith('advance-shell-v')),
    ),
    true,
  )

  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  assert.match(await page.title(), /Orbitra/)
  assert.equal(await page.locator('#root').count(), 1)
  console.log(JSON.stringify({ passed: true, controlled: true, offlineNavigation: true }, null, 2))
} finally {
  await context.setOffline(false).catch(() => {})
  await browser.close()
}
