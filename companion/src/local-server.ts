import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  COMPANION_API_VERSION,
  COMPANION_PORT,
  type CompanionStatus,
  type LaunchRequest,
} from './contracts.js'
import type { PairingStore } from './pairing.js'

const LOOPBACK_HOSTS = new Set([`127.0.0.1:${COMPANION_PORT}`, `localhost:${COMPANION_PORT}`])
const MAX_BODY_BYTES = 8 * 1024

export interface CompanionServerOptions {
  pairing: PairingStore
  companionVersion: string
  allowedHosts?: ReadonlySet<string>
  getStatus(): CompanionStatus
  launch(request: LaunchRequest): Promise<void>
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function error(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message })
}

function setCors(request: IncomingMessage, response: ServerResponse, origin: string): void {
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.setHeader('Access-Control-Max-Age', '600')
  if (request.headers['access-control-request-private-network'] === 'true') {
    response.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)
  return match?.[1]
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求内容过大。')
    chunks.push(chunk)
  }
  if (!chunks.length) throw new Error('请求内容为空。')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function parseLaunchRequest(value: unknown): LaunchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('启动参数格式无效。')
  }
  const request = value as Record<string, unknown>
  if (typeof request.versionId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(request.versionId)) {
    throw new Error('版本 ID 格式无效。')
  }
  for (const field of ['minMemory', 'maxMemory'] as const) {
    const memory = request[field]
    if (
      memory !== undefined &&
      (typeof memory !== 'number' ||
        !Number.isSafeInteger(memory) ||
        memory < 512 ||
        memory > 32768)
    ) {
      throw new Error(`${field} 必须是 512 到 32768 之间的整数。`)
    }
  }
  if (
    typeof request.minMemory === 'number' &&
    typeof request.maxMemory === 'number' &&
    request.minMemory > request.maxMemory
  ) {
    throw new Error('最小内存不能大于最大内存。')
  }
  return {
    versionId: request.versionId,
    minMemory: typeof request.minMemory === 'number' ? request.minMemory : undefined,
    maxMemory: typeof request.maxMemory === 'number' ? request.maxMemory : undefined,
  }
}

export function createCompanionServer(options: CompanionServerOptions): Server {
  return createServer(async (request, response) => {
    if (
      !request.url ||
      !request.method ||
      !(options.allowedHosts ?? LOOPBACK_HOSTS).has(request.headers.host ?? '')
    ) {
      error(response, 403, '仅接受本机 Orbitra 请求。')
      return
    }

    const origin = request.headers.origin
    if (origin) setCors(request, response, origin)

    if (request.method === 'OPTIONS') {
      if (!origin || (request.url !== '/v1/health' && !options.pairing.allowsOrigin(origin))) {
        error(response, 403, '网页来源未配对。')
        return
      }
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === 'GET' && request.url === '/v1/health') {
      sendJson(response, 200, {
        name: 'Orbitra Companion',
        apiVersion: COMPANION_API_VERSION,
        companionVersion: options.companionVersion,
        paired: options.pairing.isPaired(),
      })
      return
    }

    if (!options.pairing.authenticate(origin, bearerToken(request))) {
      error(response, 401, '伴侣未与当前网页配对。')
      return
    }

    if (request.method === 'GET' && request.url === '/v1/status') {
      sendJson(response, 200, options.getStatus())
      return
    }

    if (request.method === 'POST' && request.url === '/v1/launch') {
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        error(response, 415, '启动请求必须使用 application/json。')
        return
      }
      try {
        const launchRequest = parseLaunchRequest(await jsonBody(request))
        await options.launch(launchRequest)
        sendJson(response, 202, { accepted: true })
      } catch (cause) {
        error(response, 400, cause instanceof Error ? cause.message : '启动请求无效。')
      }
      return
    }

    error(response, 404, '接口不存在。')
  })
}

export async function listenCompanionServer(server: Server, port = COMPANION_PORT): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}
