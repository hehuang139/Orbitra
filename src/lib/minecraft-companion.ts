export const MINECRAFT_COMPANION_ORIGIN = 'http://127.0.0.1:43125'
export const MINECRAFT_COMPANION_API_VERSION = 1

const TOKEN_KEY = 'orbitra:minecraft-companion-token:v1'
const RELEASE_ROOT = 'https://github.com/hehuang139/Orbitra/releases/latest/download'

export type CompanionPhase =
  'idle' | 'installing' | 'authenticating' | 'launching' | 'running' | 'error'

export interface CompanionHealth {
  name: string
  apiVersion: number
  companionVersion: string
  paired: boolean
}

export interface CompanionStatus {
  apiVersion: number
  companionVersion: string
  phase: CompanionPhase
  message: string
  versionId?: string
  profileName?: string
  progress?: { completed: number; total: number; label: string }
  updatedAt: number
}

export interface CompanionConnection {
  health?: CompanionHealth
  status?: CompanionStatus
  available: boolean
  compatible: boolean
  paired: boolean
}

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds)
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === 'string') return new Error(payload.error)
  } catch {
    // Fall back to the HTTP status below.
  }
  return new Error(`Orbitra Companion 请求失败（${response.status}）。`)
}

export function minecraftCompanionInstallerUrl(
  platform = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): string | undefined {
  const value = platform.toLowerCase()
  if (/android|iphone|ipad|ipod|mobile/.test(value)) return undefined
  if (value.includes('windows')) return `${RELEASE_ROOT}/Orbitra-Companion-win-x64.exe`
  if (value.includes('mac')) return `${RELEASE_ROOT}/Orbitra-Companion-mac-universal.dmg`
  if (value.includes('linux') || value.includes('x11')) {
    return `${RELEASE_ROOT}/Orbitra-Companion-linux-x64.deb`
  }
  return undefined
}

export function getMinecraftCompanionToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined
}

export function createMinecraftCompanionPairingUrl(eulaAccepted: boolean): string {
  if (!eulaAccepted) throw new Error('连接前请阅读并接受 Minecraft EULA。')
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  localStorage.setItem(TOKEN_KEY, token)
  const query = new URLSearchParams({
    origin: window.location.origin,
    token,
    eula: 'accepted',
  })
  return `orbitra://pair?${query}`
}

export async function inspectMinecraftCompanion(): Promise<CompanionConnection> {
  let health: CompanionHealth
  try {
    const response = await fetch(`${MINECRAFT_COMPANION_ORIGIN}/v1/health`, {
      cache: 'no-store',
      signal: timeoutSignal(900),
    })
    if (!response.ok) return { available: false, compatible: true, paired: false }
    health = (await response.json()) as CompanionHealth
    if (health.apiVersion !== MINECRAFT_COMPANION_API_VERSION) {
      return { health, available: true, compatible: false, paired: false }
    }
  } catch {
    return { available: false, compatible: true, paired: false }
  }

  const token = getMinecraftCompanionToken()
  if (!token) return { health, available: true, compatible: true, paired: false }
  try {
    const response = await fetch(`${MINECRAFT_COMPANION_ORIGIN}/v1/status`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
      signal: timeoutSignal(1500),
    })
    if (!response.ok) return { health, available: true, compatible: true, paired: false }
    const status = (await response.json()) as CompanionStatus
    return { health, status, available: true, compatible: true, paired: true }
  } catch {
    return { health, available: true, compatible: true, paired: false }
  }
}

export async function launchMinecraftWithCompanion(
  versionId: string,
  options: { minMemory?: number; maxMemory?: number } = {},
): Promise<void> {
  const token = getMinecraftCompanionToken()
  if (!token) throw new Error('请先连接 Orbitra Companion。')
  const response = await fetch(`${MINECRAFT_COMPANION_ORIGIN}/v1/launch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ versionId, ...options }),
  })
  if (!response.ok) throw await responseError(response)
}
