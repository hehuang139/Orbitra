import assert from 'node:assert/strict'
import test from 'node:test'
import { minecraftCompanionInstallerUrl } from './minecraft-companion.ts'

test('selects the stable release artifact for each desktop platform', () => {
  assert.match(minecraftCompanionInstallerUrl('Windows NT 10.0'), /-win-x64\.exe$/)
  assert.match(minecraftCompanionInstallerUrl('Macintosh; Intel Mac OS X'), /-mac-universal\.dmg$/)
  assert.match(minecraftCompanionInstallerUrl('X11; Linux x86_64'), /-linux-x64\.deb$/)
  assert.equal(minecraftCompanionInstallerUrl('iPhone; Mobile'), undefined)
  assert.equal(minecraftCompanionInstallerUrl('unknown platform'), undefined)
})
