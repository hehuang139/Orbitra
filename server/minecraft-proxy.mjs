import { Readable } from 'node:stream'

export const MINECRAFT_OFFICIAL_HOSTS = new Set([
  'piston-meta.mojang.com',
  'launchermeta.mojang.com',
  'piston-data.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
])

const PREFIX = '/minecraft-official/'
const responseHeaders = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
]

function targetForRequest(requestUrl) {
  const parsed = new URL(requestUrl || '/', 'http://localhost')
  if (!parsed.pathname.startsWith(PREFIX)) return undefined
  let decoded
  try {
    decoded = decodeURIComponent(parsed.pathname.slice(PREFIX.length))
  } catch {
    throw new Error('Invalid encoded path')
  }
  const separator = decoded.indexOf('/')
  if (separator < 1) throw new Error('Missing official host or path')
  const host = decoded.slice(0, separator)
  const pathname = decoded.slice(separator)
  if (!MINECRAFT_OFFICIAL_HOSTS.has(host)) throw new Error('Host is not allowlisted')
  if (pathname.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Unsafe path')
  }
  const target = new URL(`https://${host}${pathname}`)
  target.search = parsed.search
  return target
}

async function fetchOfficial(target, request, fetchImpl) {
  let current = target
  for (let redirects = 0; redirects <= 3; redirects++) {
    const headers = { Accept: request.headers.accept || '*/*' }
    if (request.headers.range) headers.Range = request.headers.range
    if (request.headers['if-none-match'])
      headers['If-None-Match'] = request.headers['if-none-match']
    if (request.headers['if-modified-since'])
      headers['If-Modified-Since'] = request.headers['if-modified-since']
    const response = await fetchImpl(current, {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) throw new Error('Official redirect is missing Location')
    current = new URL(location, current)
    if (current.protocol !== 'https:' || !MINECRAFT_OFFICIAL_HOSTS.has(current.hostname)) {
      throw new Error('Official redirect left the allowlist')
    }
  }
  throw new Error('Too many official redirects')
}

export function createMinecraftProxy({ fetchImpl = fetch } = {}) {
  return async function minecraftProxy(request, response, next) {
    let target
    try {
      target = targetForRequest(request.url)
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Invalid Minecraft official file path')
      return
    }
    if (!target) {
      if (next) next()
      else {
        response.writeHead(404)
        response.end()
      }
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }
    try {
      const upstream = await fetchOfficial(target, request, fetchImpl)
      const headers = {
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Minecraft-Official-Source': target.href,
      }
      for (const name of responseHeaders) {
        const value = upstream.headers.get(name)
        if (value) headers[name] = value
      }
      response.writeHead(upstream.status, headers)
      if (request.method === 'HEAD' || !upstream.body) response.end()
      else Readable.fromWeb(upstream.body).pipe(response)
    } catch (error) {
      response.writeHead(502, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(error instanceof Error ? error.message : 'Official Minecraft download failed')
    }
  }
}
