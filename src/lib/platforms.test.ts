import assert from 'node:assert/strict'
import test from 'node:test'
import { CORE_REGISTRY, coreIdForPlatform } from './core-version.ts'
import {
  CORE_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  PLATFORM_LIST,
  platformSupportsCapability,
} from './platforms.ts'

test('every platform exposes the complete capability contract of its selected core', () => {
  for (const platform of PLATFORM_LIST) {
    assert.deepEqual(Object.keys(platform.capabilities).sort(), [...PLATFORM_CAPABILITIES].sort())
    assert.equal(platform.capabilities, CORE_CAPABILITIES[platform.core])
    assert.equal(coreIdForPlatform(platform.id), CORE_REGISTRY[platform.core].id)
  }
})

test('capability checks report only host features that are implemented and verified', () => {
  for (const platform of ['gba', 'gb', 'gbc', 'nes', 'snes'] as const) {
    assert.equal(platformSupportsCapability(platform, 'saveStates'), true)
    assert.equal(platformSupportsCapability(platform, 'cheats'), true)
    assert.equal(platformSupportsCapability(platform, 'patches'), false)
    assert.equal(platformSupportsCapability(platform, 'multiplayer'), false)
  }
  assert.equal(platformSupportsCapability('gamecube', 'saveStates'), true)
  assert.equal(platformSupportsCapability('gamecube', 'batterySaves'), false)
  assert.equal(platformSupportsCapability('gamecube', 'screenshots'), false)
})

test('core builds declare immutable artifact and state compatibility identities', () => {
  for (const core of Object.values(CORE_REGISTRY)) {
    assert.match(core.artifactSha256, /^[a-f0-9]{64}$/)
    assert.ok(core.id.includes(core.artifactSha256))
    assert.ok(core.version)
    assert.ok(core.stateFormat)
    assert.equal(core.stateCompatibility, 'exact-build')
  }
})
