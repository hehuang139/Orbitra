import { CORE_REGISTRY } from './core-version.ts'
import { PLATFORM_CAPABILITIES, PLATFORM_REGISTRY } from './platforms.ts'
import type { GamePlatform, PlatformCapability } from './platforms.ts'

export type FeatureStatus = 'planned' | 'experimental' | 'verified' | 'unavailable'

export const FEATURE_STATUS_LABELS: Readonly<Record<FeatureStatus, string>> = {
  planned: '计划',
  experimental: '实验',
  verified: '已验证',
  unavailable: '不可用',
}

export const CAPABILITY_LABELS: Readonly<Record<PlatformCapability, string>> = {
  saveStates: '即时存档',
  batterySaves: '游戏内存档',
  rewind: '倒带',
  screenshots: '截图',
  speedControl: '倍速',
  cheats: '金手指',
  patches: '补丁',
  shaders: '着色器',
  recording: '录制',
  multiplayer: '多人游戏',
  rtc: '实时时钟',
  motion: '体感',
  rumble: '震动',
  microphone: '麦克风',
}

const PLANNED_CAPABILITIES: Readonly<Record<GamePlatform, readonly PlatformCapability[]>> = {
  gba: ['patches', 'shaders', 'recording', 'multiplayer', 'rtc', 'motion', 'rumble'],
  gb: ['patches', 'shaders', 'recording', 'multiplayer', 'rtc'],
  gbc: ['patches', 'shaders', 'recording', 'multiplayer', 'rtc'],
  nes: ['patches', 'shaders', 'recording', 'multiplayer'],
  snes: ['patches', 'shaders', 'recording', 'multiplayer'],
  gamecube: [
    'batterySaves',
    'screenshots',
    'speedControl',
    'cheats',
    'shaders',
    'recording',
    'multiplayer',
    'motion',
    'rumble',
  ],
}

export interface CapabilityStatusEntry {
  capability: PlatformCapability
  label: string
  status: FeatureStatus
  reason: string
}

export function capabilityReportForPlatform(platform: GamePlatform): CapabilityStatusEntry[] {
  const definition = PLATFORM_REGISTRY[platform]
  const core = CORE_REGISTRY[definition.core]
  const planned = new Set(PLANNED_CAPABILITIES[platform])
  const experimental = 'experimental' in definition && definition.experimental
  return PLATFORM_CAPABILITIES.map((capability) => {
    const supported = definition.capabilities[capability]
    const status: FeatureStatus = supported
      ? experimental
        ? 'experimental'
        : 'verified'
      : planned.has(capability)
        ? 'planned'
        : 'unavailable'
    const reason = supported
      ? experimental
        ? `${core.name} 已实现，当前平台仍在扩大兼容性验证。`
        : `${core.name} ${core.version} 适配层已实现并纳入自动化回归。`
      : status === 'planned'
        ? '已列入 roadmap，当前适配层尚未实现。'
        : `${definition.label} 的当前核心或硬件模型不提供此能力。`
    return { capability, label: CAPABILITY_LABELS[capability], status, reason }
  })
}
