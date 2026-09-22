declare const __ORBITRA_MICROSOFT_CLIENT_ID__: string

export const MICROSOFT_CLIENT_ID =
  typeof __ORBITRA_MICROSOFT_CLIENT_ID__ === 'string'
    ? __ORBITRA_MICROSOFT_CLIENT_ID__
    : (process.env.ORBITRA_MICROSOFT_CLIENT_ID?.trim() ?? '')
export const MICROSOFT_SCOPES = ['XboxLive.signin', 'offline_access']
export const VERSION_MANIFEST_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
