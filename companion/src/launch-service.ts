import { COMPANION_API_VERSION, type CompanionStatus, type LaunchRequest } from './contracts.js'
import type { MinecraftAuthenticator, MinecraftIdentity } from './auth.js'
import type { MinecraftLauncher } from './minecraft-launcher.js'

export class LaunchService {
  private status: CompanionStatus
  private busy = false

  constructor(
    companionVersion: string,
    private readonly authenticator: MinecraftAuthenticator,
    private readonly launcher: MinecraftLauncher,
  ) {
    this.status = {
      apiVersion: COMPANION_API_VERSION,
      companionVersion,
      phase: 'idle',
      message: authenticator.isConfigured()
        ? '伴侣已就绪。'
        : '安装包未配置 Microsoft OAuth，暂时无法登录。',
      updatedAt: Date.now(),
    }
  }

  snapshot(): CompanionStatus {
    return structuredClone(this.status)
  }

  update(patch: Partial<CompanionStatus>): void {
    this.status = { ...this.status, ...patch, updatedAt: Date.now() }
  }

  accept(request: LaunchRequest): void {
    if (this.busy || this.launcher.isRunning()) throw new Error('已有 Minecraft 启动或运行任务。')
    this.busy = true
    this.update({
      phase: 'authenticating',
      versionId: request.versionId,
      message: '正在检查 Microsoft 登录与游戏所有权…',
      progress: undefined,
    })
    void this.run(request)
  }

  private async run(request: LaunchRequest): Promise<void> {
    try {
      const identity: MinecraftIdentity = await this.authenticator.authenticate()
      this.update({
        phase: 'installing',
        profileName: identity.name,
        message: `已验证 ${identity.name}，正在准备游戏文件…`,
      })
      await this.launcher.launch(request, identity)
      this.update({ phase: 'running', message: `Minecraft ${request.versionId} 正在运行。` })
    } catch (cause) {
      this.update({
        phase: 'error',
        message: cause instanceof Error ? cause.message : '启动 Minecraft 失败。',
        progress: undefined,
      })
    } finally {
      this.busy = false
    }
  }

  gameExited(code: number | null, signal: NodeJS.Signals | null): void {
    this.update({
      phase: code === 0 ? 'idle' : 'error',
      message:
        code === 0
          ? 'Minecraft 已正常退出。'
          : `Minecraft 已退出（${signal ? `信号 ${signal}` : `代码 ${code ?? '未知'}`}）。`,
      progress: undefined,
    })
  }
}
