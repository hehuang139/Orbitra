export interface AccountUser {
  id: number
  username: string
  createdAt: number
}

export interface AccountSession {
  user: AccountUser
  token: string
}

export interface OnlineLibraryConnection {
  url: string
  token?: string
}

export interface OnlineLibraryHealth {
  service: 'advance-online-library'
  version: 1
}

export interface CloudSnapshot {
  bytes: Uint8Array
  revision: number
  updatedAt: number
}

export interface CloudSnapshotReceipt {
  revision: number
  updatedAt: number
  size: number
  sha256: string
}

export interface CloudLibraryItem extends CloudSnapshotReceipt {
  gameId: string
  syncReady: boolean
  syncSize: number
  syncSha256: string
}

export interface CloudLibraryIndex {
  revision: number
  updatedAt: number
  items: CloudLibraryItem[]
}

export interface CloudLibraryMutation {
  revision: number
  updatedAt: number
}

const CONNECTION_KEY = 'advance.online-library'

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function normalizeOnlineLibraryUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请输入完整的在线游戏库地址，例如 https://library.example.com。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('在线游戏库地址必须是 http 或 https 地址，且不能包含用户名或密码。')
  }
  if (url.search || url.hash) throw new Error('在线游戏库地址不能包含查询参数或片段。')
  if (
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    url.protocol !== 'https:' &&
    !isLoopback(url.hostname)
  ) {
    throw new Error('HTTPS 页面只能连接 HTTPS 在线游戏库。')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/$/, '')
}

export function readOnlineLibraryConnection(): OnlineLibraryConnection | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CONNECTION_KEY) || 'null') as unknown
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    const url = normalizeOnlineLibraryUrl(String(value.url || ''))
    return {
      url,
      ...(typeof value.token === 'string' && value.token ? { token: value.token } : {}),
    }
  } catch {
    return null
  }
}

export function saveOnlineLibraryConnection(connection: OnlineLibraryConnection): void {
  localStorage.setItem(
    CONNECTION_KEY,
    JSON.stringify({
      url: normalizeOnlineLibraryUrl(connection.url),
      ...(connection.token ? { token: connection.token } : {}),
    }),
  )
}

export function clearOnlineLibraryConnection(): void {
  localStorage.removeItem(CONNECTION_KEY)
}

async function apiError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') return new Error(body.error)
  } catch {
    /* The fallback below keeps proxy and server errors actionable. */
  }
  return new Error(
    response.status >= 500 ? '在线游戏库暂时不可用。' : '在线游戏库请求失败，请重试。',
  )
}

export class OnlineLibraryClient {
  readonly baseUrl: string
  private token?: string

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = normalizeOnlineLibraryUrl(baseUrl)
    this.token = token
  }

  setToken(token?: string): void {
    this.token = token
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/${path.replace(/^\/+/, '')}`
  }

  private headers(init?: RequestInit): Headers {
    const headers = new Headers(init?.headers)
    if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    return headers
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetch(this.url(path), {
        cache: 'no-store',
        ...init,
        headers: this.headers(init),
      })
    } catch (cause) {
      throw new Error('无法连接在线游戏库，请检查地址、网络和服务端跨域配置。', {
        cause,
      })
    }
    return response
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init)
    if (!response.ok) throw await apiError(response)
    return response.json() as Promise<T>
  }

  async health(): Promise<OnlineLibraryHealth> {
    const health = await this.json<OnlineLibraryHealth>('health')
    if (health.service !== 'advance-online-library' || health.version !== 1) {
      throw new Error('该地址不是兼容的 Advance 在线游戏库。')
    }
    return health
  }

  async getSession(): Promise<AccountUser | null> {
    return (await this.json<{ user: AccountUser | null }>('auth/session')).user
  }

  register(username: string, password: string): Promise<AccountSession> {
    return this.json<AccountSession>('auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  login(username: string, password: string): Promise<AccountSession> {
    return this.json<AccountSession>('auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  async logout(): Promise<void> {
    await this.json('auth/logout', { method: 'POST', body: '{}' })
  }

  /** `undefined` means the caller's known revision is current; `null` means no snapshot exists. */
  async downloadSnapshot(knownRevision?: number): Promise<CloudSnapshot | null | undefined> {
    const response = await this.request('sync', {
      headers:
        knownRevision && Number.isSafeInteger(knownRevision)
          ? { 'If-None-Match': `"advance-${knownRevision}"` }
          : undefined,
    })
    if (response.status === 304) return undefined
    if (response.status === 204) return null
    if (!response.ok) throw await apiError(response)
    return this.snapshot(response)
  }

  uploadSnapshot(bytes: Uint8Array): Promise<CloudSnapshotReceipt> {
    return this.upload('sync', bytes)
  }

  /** `undefined` means the caller's library revision is current. */
  async getLibraryIndex(knownRevision?: number): Promise<CloudLibraryIndex | undefined> {
    const response = await this.request('library', {
      headers:
        knownRevision !== undefined && Number.isSafeInteger(knownRevision)
          ? { 'If-None-Match': `"advance-library-${knownRevision}"` }
          : undefined,
    })
    if (response.status === 304) return undefined
    if (!response.ok) throw await apiError(response)
    return response.json() as Promise<CloudLibraryIndex>
  }

  async downloadLibraryItem(gameId: string): Promise<CloudSnapshot> {
    const response = await this.request(`library/${encodeURIComponent(gameId)}`)
    if (!response.ok) throw await apiError(response)
    return this.snapshot(response)
  }

  async downloadLibrarySync(gameId: string): Promise<CloudSnapshot> {
    const response = await this.request(`library/${encodeURIComponent(gameId)}/sync`)
    if (!response.ok) throw await apiError(response)
    return this.snapshot(response)
  }

  uploadLibraryItem(gameId: string, bytes: Uint8Array): Promise<CloudSnapshotReceipt> {
    return this.upload(`library/${encodeURIComponent(gameId)}`, bytes)
  }

  uploadLibrarySync(gameId: string, bytes: Uint8Array): Promise<CloudSnapshotReceipt> {
    return this.upload(`library/${encodeURIComponent(gameId)}/sync`, bytes)
  }

  deleteLibraryItem(gameId: string): Promise<CloudLibraryMutation> {
    return this.json<CloudLibraryMutation>(`library/${encodeURIComponent(gameId)}`, {
      method: 'DELETE',
      body: '{}',
    })
  }

  private async snapshot(response: Response): Promise<CloudSnapshot> {
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      revision: Number(response.headers.get('X-Advance-Revision') || 0),
      updatedAt: Number(response.headers.get('X-Advance-Updated-At') || 0),
    }
  }

  private async upload(path: string, bytes: Uint8Array): Promise<CloudSnapshotReceipt> {
    const response = await this.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
    })
    if (!response.ok) throw await apiError(response)
    return response.json() as Promise<CloudSnapshotReceipt>
  }
}
