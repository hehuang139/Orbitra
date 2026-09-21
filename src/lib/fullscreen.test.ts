import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fullscreenElement, fullscreenSupported } from './fullscreen.ts'

test('reads standard and WebKit fullscreen state', () => {
  const standardElement = {} as Element
  const webkitElement = {} as Element
  assert.equal(
    fullscreenElement({ fullscreenElement: standardElement } as Document),
    standardElement,
  )
  assert.equal(
    fullscreenElement({
      fullscreenElement: null,
      webkitFullscreenElement: webkitElement,
    } as Document & { webkitFullscreenElement: Element }),
    webkitElement,
  )
})

test('detects standard and WebKit request methods and respects disabled APIs', () => {
  const standard = { requestFullscreen() {} } as unknown as HTMLElement
  const webkit = { webkitRequestFullscreen() {} } as unknown as HTMLElement
  assert.equal(fullscreenSupported(standard, { fullscreenEnabled: true } as Document), true)
  assert.equal(
    fullscreenSupported(webkit, {
      fullscreenEnabled: false,
      webkitFullscreenEnabled: true,
    } as Document & {
      webkitFullscreenEnabled: boolean
    }),
    true,
  )
  assert.equal(fullscreenSupported({} as HTMLElement, {} as Document), false)
})
