import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPABILITY_LABELS,
  FEATURE_STATUS_LABELS,
  capabilityReportForPlatform,
} from './capability-status.ts'
import { PLATFORM_CAPABILITIES, PLATFORM_LIST } from './platforms.ts'

test('every platform reports every capability with a localized status and reason', () => {
  const observed = new Set<string>()
  for (const platform of PLATFORM_LIST) {
    const report = capabilityReportForPlatform(platform.id)
    assert.deepEqual(
      report.map((entry) => entry.capability),
      PLATFORM_CAPABILITIES,
    )
    for (const entry of report) {
      observed.add(entry.status)
      assert.equal(entry.label, CAPABILITY_LABELS[entry.capability])
      assert.ok(FEATURE_STATUS_LABELS[entry.status])
      assert.ok(entry.reason)
      assert.equal(
        platform.capabilities[entry.capability],
        entry.status === 'verified' || entry.status === 'experimental',
      )
    }
  }
  assert.deepEqual([...observed].sort(), ['experimental', 'planned', 'unavailable', 'verified'])
})

test('experimental cores never present implemented features as verified', () => {
  const gamecube = capabilityReportForPlatform('gamecube')
  assert.equal(gamecube.find((entry) => entry.capability === 'saveStates')?.status, 'experimental')
  assert.equal(gamecube.find((entry) => entry.capability === 'batterySaves')?.status, 'planned')
  assert.equal(gamecube.find((entry) => entry.capability === 'microphone')?.status, 'unavailable')
  assert.equal(gamecube.some((entry) => entry.status === 'verified'), false)
})
