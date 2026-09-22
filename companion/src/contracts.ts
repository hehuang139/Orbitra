export const COMPANION_PORT = 43125
export const COMPANION_API_VERSION = 1

export type CompanionPhase =
  'idle' | 'installing' | 'authenticating' | 'launching' | 'running' | 'error'

export interface CompanionProgress {
  completed: number
  total: number
  label: string
}

export interface CompanionStatus {
  apiVersion: number
  companionVersion: string
  phase: CompanionPhase
  message: string
  versionId?: string
  profileName?: string
  progress?: CompanionProgress
  updatedAt: number
}

export interface LaunchRequest {
  versionId: string
  minMemory?: number
  maxMemory?: number
}

export interface PairingRecord {
  origin: string
  tokenHash: string
  pairedAt: number
}
