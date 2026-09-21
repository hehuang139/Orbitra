import type { Cheat } from './types.ts'

export const MAX_CHEATS_PER_GAME = 50
export const MAX_CHEAT_NAME_LENGTH = 80
export const MAX_CHEAT_CODE_LENGTH = 4096

const idPattern = /^[A-Za-z0-9_-]{1,80}$/
const printableCodePattern = /^[\x20-\x7e\n]+$/

export function normalizeCheatCode(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

export function validateCheats(value: unknown): Cheat[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_CHEATS_PER_GAME)
    throw new Error(`金手指数据无效，每个游戏最多保存 ${MAX_CHEATS_PER_GAME} 条。`)

  const ids = new Set<string>()
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('金手指数据无效。')
    const raw = entry as Record<string, unknown>
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const code = typeof raw.code === 'string' ? normalizeCheatCode(raw.code) : ''
    if (
      typeof raw.id !== 'string' ||
      !idPattern.test(raw.id) ||
      ids.has(raw.id) ||
      !name ||
      name.length > MAX_CHEAT_NAME_LENGTH ||
      !code ||
      code.length > MAX_CHEAT_CODE_LENGTH ||
      !printableCodePattern.test(code) ||
      code.split('\n').some((line) => line.startsWith('#') || line.startsWith('!')) ||
      typeof raw.enabled !== 'boolean'
    ) {
      throw new Error('金手指名称或代码无效，请检查后重试。')
    }
    ids.add(raw.id)
    return { id: raw.id, name, code, enabled: raw.enabled }
  })
}

export function createCheatId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()
  return `cheat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function mgbaCheatFile(cheats: readonly Cheat[]): Uint8Array {
  const text = cheats
    .map((cheat) => {
      const code = normalizeCheatCode(cheat.code).replace(/\s*\+\s*/g, '\n')
      return `${cheat.enabled ? '' : '!disabled\n'}# ${cheat.name}\n${code}\n`
    })
    .join('')
  return new TextEncoder().encode(text)
}
