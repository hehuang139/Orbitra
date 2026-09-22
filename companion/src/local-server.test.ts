import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { COMPANION_API_VERSION, type CompanionStatus, type PairingRecord } from './contracts.js'
import { createCompanionServer } from './local-server.js'
import { PairingStore } from './pairing.js'

const origin = 'https://orbitra.example'
const token = 'A'.repeat(43)

async function fixture() {
  let record: PairingRecord | undefined
  const pairing = new PairingStore({
    read: async () => record,
    write: async (next) => {
      record = next
    },
  })
  await pairing.load()
  const launches: string[] = []
  const allowedHosts = new Set<string>()
  const status: CompanionStatus = {
    apiVersion: COMPANION_API_VERSION,
    companionVersion: 'test',
    phase: 'idle',
    message: 'ready',
    updatedAt: 1,
  }
  const server = createCompanionServer({
    pairing,
    allowedHosts,
    companionVersion: 'test',
    getStatus: () => status,
    launch: async (request) => {
      launches.push(request.versionId)
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  allowedHosts.add(`127.0.0.1:${port}`)
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { Origin: origin, ...init.headers },
    })
  const requestWithHost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const current = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/health',
          headers: { Host: host, Origin: origin },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      current.on('error', reject)
      current.end()
    })
  return { pairing, launches, request, requestWithHost, server }
}

test('health is available before pairing but authenticated status is not', async (context) => {
  const value = await fixture()
  context.after(() => value.server.close())
  assert.equal((await value.request('/v1/health')).status, 200)
  assert.equal((await value.request('/v1/status')).status, 401)
})

test('paired origin and bearer token can launch a validated version', async (context) => {
  const value = await fixture()
  context.after(() => value.server.close())
  await value.pairing.pair(origin, token)
  const response = await value.request('/v1/launch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionId: '1.21.8', maxMemory: 4096 }),
  })
  assert.equal(response.status, 202)
  assert.deepEqual(value.launches, ['1.21.8'])
})

test('rejects wrong host, origin, token, content type, and unsafe version ids', async (context) => {
  const value = await fixture()
  context.after(() => value.server.close())
  await value.pairing.pair(origin, token)
  const authorized = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  assert.equal(await value.requestWithHost('attacker.example'), 403)
  assert.equal(
    (
      await value.request('/v1/status', {
        headers: { ...authorized, Origin: 'https://evil.example' },
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await value.request('/v1/status', {
        headers: { ...authorized, Authorization: `Bearer ${'B'.repeat(43)}` },
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await value.request('/v1/launch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: '{}',
      })
    ).status,
    415,
  )
  assert.equal(
    (
      await value.request('/v1/launch', {
        method: 'POST',
        headers: authorized,
        body: JSON.stringify({ versionId: '../escape' }),
      })
    ).status,
    400,
  )
})
