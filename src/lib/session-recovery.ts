export const SESSION_RECOVERY_KEY = 'advance.session-recovery'
export const SESSION_RECOVERY_MAX_AGE = 30 * 24 * 60 * 60 * 1000

export interface SessionRecoveryRecord {
  version: 1
  gameId: string
  coreId: string
  startedAt: number
  updatedAt: number
  stateSlot?: number
  stateCreatedAt?: number
}

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function valid(value: unknown, now: number): value is SessionRecoveryRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as SessionRecoveryRecord
  const hasState = record.stateSlot !== undefined || record.stateCreatedAt !== undefined
  return (
    record.version === 1 &&
    typeof record.gameId === 'string' &&
    record.gameId.length > 0 &&
    record.gameId.length <= 256 &&
    typeof record.coreId === 'string' &&
    record.coreId.length > 0 &&
    record.coreId.length <= 256 &&
    timestamp(record.startedAt) &&
    timestamp(record.updatedAt) &&
    record.updatedAt >= record.startedAt &&
    record.updatedAt <= now + 5 * 60 * 1000 &&
    now - record.updatedAt <= SESSION_RECOVERY_MAX_AGE &&
    (!hasState ||
      (Number.isInteger(record.stateSlot) &&
        record.stateSlot! >= 0 &&
        record.stateSlot! <= 7 &&
        timestamp(record.stateCreatedAt)))
  )
}

function discard(storage: RecoveryStorage): void {
  try {
    storage.removeItem(SESSION_RECOVERY_KEY)
  } catch {
    /* Unavailable browser storage is handled as no recovery record. */
  }
}

export function readSessionRecovery(
  storage: RecoveryStorage = localStorage,
  now = Date.now(),
): SessionRecoveryRecord | null {
  try {
    const raw = storage.getItem(SESSION_RECOVERY_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!valid(parsed, now)) {
      discard(storage)
      return null
    }
    return { ...parsed }
  } catch {
    discard(storage)
    return null
  }
}

export function beginSessionRecovery(
  gameId: string,
  coreId: string,
  state: { slot: number; createdAt: number } | undefined,
  storage: RecoveryStorage = localStorage,
  now = Date.now(),
): SessionRecoveryRecord {
  const record: SessionRecoveryRecord = {
    version: 1,
    gameId,
    coreId,
    startedAt: now,
    updatedAt: now,
    ...(state ? { stateSlot: state.slot, stateCreatedAt: state.createdAt } : {}),
  }
  if (!valid(record, now)) throw new Error('无法记录当前游戏会话。')
  storage.setItem(SESSION_RECOVERY_KEY, JSON.stringify(record))
  return record
}

export function updateSessionRecoveryState(
  gameId: string,
  state: { slot: number; createdAt: number },
  storage: RecoveryStorage = localStorage,
  now = Date.now(),
): SessionRecoveryRecord | null {
  const current = readSessionRecovery(storage, now)
  if (!current || current.gameId !== gameId) return current
  const updated: SessionRecoveryRecord = {
    ...current,
    updatedAt: now,
    stateSlot: state.slot,
    stateCreatedAt: state.createdAt,
  }
  if (!valid(updated, now)) throw new Error('无法更新当前游戏会话。')
  storage.setItem(SESSION_RECOVERY_KEY, JSON.stringify(updated))
  return updated
}

export function clearSessionRecovery(
  gameId?: string,
  storage: RecoveryStorage = localStorage,
): void {
  if (gameId) {
    const current = readSessionRecovery(storage)
    if (!current || current.gameId !== gameId) return
  }
  storage.removeItem(SESSION_RECOVERY_KEY)
}
