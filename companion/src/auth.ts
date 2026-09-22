import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node'
import { MicrosoftAuthenticator, MojangClient } from '@xmcl/user'
import { MICROSOFT_CLIENT_ID, MICROSOFT_SCOPES } from './config.js'

export interface SecretVault {
  read(): Promise<string | undefined>
  write(value: string): Promise<void>
}

export interface MinecraftIdentity {
  accessToken: string
  id: string
  name: string
}

export interface AuthCallbacks {
  openExternal(url: string): Promise<void>
  onMessage(message: string): void
}

function createCachePlugin(vault: SecretVault): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext) {
      const cached = await vault.read()
      if (cached) context.tokenCache.deserialize(cached)
    },
    async afterCacheAccess(context: TokenCacheContext) {
      if (context.cacheHasChanged) await vault.write(context.tokenCache.serialize())
    },
  }
}

export class MinecraftAuthenticator {
  private readonly application?: PublicClientApplication
  private readonly xbox = new MicrosoftAuthenticator()
  private readonly mojang = new MojangClient()

  constructor(
    vault: SecretVault,
    private readonly callbacks: AuthCallbacks,
  ) {
    if (MICROSOFT_CLIENT_ID) {
      this.application = new PublicClientApplication({
        auth: {
          clientId: MICROSOFT_CLIENT_ID,
          authority: 'https://login.microsoftonline.com/consumers',
        },
        cache: { cachePlugin: createCachePlugin(vault) },
      })
    }
  }

  isConfigured(): boolean {
    return Boolean(this.application)
  }

  private async microsoftToken(): Promise<AuthenticationResult> {
    if (!this.application) {
      throw new Error('此安装包尚未配置 Orbitra Microsoft OAuth 客户端 ID。')
    }
    const accounts = await this.application.getTokenCache().getAllAccounts()
    const account: AccountInfo | undefined = accounts[0]
    if (account) {
      try {
        const result = await this.application.acquireTokenSilent({
          account,
          scopes: MICROSOFT_SCOPES,
        })
        if (result) return result
      } catch (cause) {
        if (!(cause instanceof InteractionRequiredAuthError)) throw cause
      }
    }

    const result = await this.application.acquireTokenByDeviceCode({
      scopes: MICROSOFT_SCOPES,
      deviceCodeCallback: (response) => {
        this.callbacks.onMessage(`请在 Microsoft 页面输入代码 ${response.userCode}`)
        void this.callbacks.openExternal(response.verificationUri)
      },
    })
    if (!result) throw new Error('Microsoft 登录未完成。')
    return result
  }

  async authenticate(): Promise<MinecraftIdentity> {
    const oauth = await this.microsoftToken()
    this.callbacks.onMessage('正在验证 Xbox 与 Minecraft 所有权…')
    const { minecraftXstsResponse } = await this.xbox.acquireXBoxToken(oauth.accessToken)
    const claim = minecraftXstsResponse.DisplayClaims.xui[0]
    if (!claim) throw new Error('Microsoft 账号未返回 Xbox 用户信息。')
    const minecraft = await this.xbox.loginMinecraftWithXBox(claim.uhs, minecraftXstsResponse.Token)
    const ownership = await this.mojang.checkGameOwnership(minecraft.access_token)
    if (
      !ownership.items.some((item) => ['product_minecraft', 'game_minecraft'].includes(item.name))
    ) {
      throw new Error('此 Microsoft 账号没有 Minecraft: Java Edition 所有权。')
    }
    const profile = await this.mojang.getProfile(minecraft.access_token)
    return { accessToken: minecraft.access_token, id: profile.id, name: profile.name }
  }
}
