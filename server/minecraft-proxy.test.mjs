import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMinecraftProxy } from './minecraft-proxy.mjs'

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
    },
    end(body = '') {
      this.body += body
    },
  }
}

test('proxies only allowlisted official Minecraft hosts without forwarding credentials', async () => {
  let request
  const proxy = createMinecraftProxy({
    fetchImpl: async (url, init) => {
      request = { url: url.href, init }
      return new Response(null, {
        status: 200,
        headers: { 'Content-Length': '12', 'Content-Type': 'application/java-archive' },
      })
    },
  })
  const output = responseRecorder()
  await proxy(
    {
      method: 'HEAD',
      url: '/minecraft-official/libraries.minecraft.net/org/example/test.jar',
      headers: {
        accept: '*/*',
        cookie: 'secret',
        authorization: 'Bearer secret',
        range: 'bytes=0-4',
      },
    },
    output,
  )
  assert.equal(request.url, 'https://libraries.minecraft.net/org/example/test.jar')
  assert.deepEqual(request.init.headers, { Accept: '*/*', Range: 'bytes=0-4' })
  assert.equal(output.status, 200)
  assert.equal(output.headers['content-length'], '12')
})

test('rejects arbitrary hosts, unsafe methods, and redirects outside the allowlist', async () => {
  let calls = 0
  const proxy = createMinecraftProxy({
    fetchImpl: async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example/file' } })
    },
  })
  const arbitrary = responseRecorder()
  await proxy(
    { method: 'GET', url: '/minecraft-official/evil.example/file', headers: {} },
    arbitrary,
  )
  assert.equal(arbitrary.status, 400)
  assert.equal(calls, 0)

  const method = responseRecorder()
  await proxy(
    { method: 'POST', url: '/minecraft-official/launcher.mojang.com/file', headers: {} },
    method,
  )
  assert.equal(method.status, 405)

  const redirect = responseRecorder()
  await proxy(
    { method: 'HEAD', url: '/minecraft-official/launcher.mojang.com/file', headers: {} },
    redirect,
  )
  assert.equal(redirect.status, 502)
})
