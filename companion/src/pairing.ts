import { createHash, timingSafeEqual } from 'node:crypto'
import type { PairingRecord } from './contracts.js'

export interface PairingPersistence {
  read(): Promise<PairingRecord | undefined>
  write(record: PairingRecord): Promise<void>
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

export function normalizeWebOrigin(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('配对来源必须是 HTTP 或 HTTPS 网站。')
  }
  if (url.origin !== value || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('配对来源必须是完整且不含路径的网页来源。')
  }
  return url.origin
}

export function validatePairingToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error('配对令牌格式无效。')
  }
  return token
}

export class PairingStore {
  private record?: PairingRecord

  constructor(private readonly persistence: PairingPersistence) {}

  async load(): Promise<void> {
    this.record = await this.persistence.read()
  }

  async pair(origin: string, token: string): Promise<void> {
    const normalizedOrigin = normalizeWebOrigin(origin)
    validatePairingToken(token)
    const record: PairingRecord = {
      origin: normalizedOrigin,
      tokenHash: tokenHash(token).toString('hex'),
      pairedAt: Date.now(),
    }
    await this.persistence.write(record)
    this.record = record
  }

  isPaired(): boolean {
    return Boolean(this.record)
  }

  allowsOrigin(origin: string | undefined): boolean {
    return Boolean(origin && this.record?.origin === origin)
  }

  authenticate(origin: string | undefined, token: string | undefined): boolean {
    if (!this.allowsOrigin(origin) || !token || !this.record) return false
    const actual = tokenHash(token)
    const expected = Buffer.from(this.record.tokenHash, 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
}
