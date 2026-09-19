export interface AccountUser {
  id: number
  username: string
  createdAt: number
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

async function apiError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') return new Error(body.error)
  } catch {
    /* The fallback below keeps proxy and server errors actionable. */
  }
  return new Error(response.status >= 500 ? '账号服务暂时不可用。' : '账号请求失败，请重试。')
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) throw await apiError(response)
  return response.json() as Promise<T>
}

export async function getAccountSession(): Promise<AccountUser | null> {
  return (await jsonRequest<{ user: AccountUser | null }>('/api/auth/session')).user
}

export async function registerAccount(username: string, password: string): Promise<AccountUser> {
  return (
    await jsonRequest<{ user: AccountUser }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  ).user
}

export async function loginAccount(username: string, password: string): Promise<AccountUser> {
  return (
    await jsonRequest<{ user: AccountUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  ).user
}

export async function logoutAccount(): Promise<void> {
  await jsonRequest('/api/auth/logout', { method: 'POST', body: '{}' })
}

/** `undefined` means the caller's known revision is still current; `null` means no snapshot exists. */
export async function downloadCloudSnapshot(
  knownRevision?: number,
): Promise<CloudSnapshot | null | undefined> {
  const response = await fetch('/api/sync', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers:
      knownRevision && Number.isSafeInteger(knownRevision)
        ? { 'If-None-Match': `"advance-${knownRevision}"` }
        : undefined,
  })
  if (response.status === 304) return undefined
  if (response.status === 204) return null
  if (!response.ok) throw await apiError(response)
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    revision: Number(response.headers.get('X-Advance-Revision') || 0),
    updatedAt: Number(response.headers.get('X-Advance-Updated-At') || 0),
  }
}

export async function uploadCloudSnapshot(bytes: Uint8Array): Promise<CloudSnapshotReceipt> {
  const response = await fetch('/api/sync', {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/zip' },
    body: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
  })
  if (!response.ok) throw await apiError(response)
  return response.json() as Promise<CloudSnapshotReceipt>
}
