import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertOfficialDownloadUrl } from './minecraft-launcher.js'

test('accepts only known Mojang and Microsoft download hosts', () => {
  assert.equal(
    assertOfficialDownloadUrl('https://piston-data.mojang.com/v1/objects/a/client.jar'),
    'https://piston-data.mojang.com/v1/objects/a/client.jar',
  )
  assert.throws(() => assertOfficialDownloadUrl('http://piston-data.mojang.com/client.jar'))
  assert.throws(() =>
    assertOfficialDownloadUrl('https://piston-data.mojang.com.evil.test/client.jar'),
  )
  assert.throws(() => assertOfficialDownloadUrl('https://example.test/client.jar'))
})
