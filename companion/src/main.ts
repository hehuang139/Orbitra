import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import electron, { type BrowserWindow as BrowserWindowType, type Tray as TrayType } from 'electron'
import { MinecraftAuthenticator, type SecretVault } from './auth.js'
import { COMPANION_PORT, type PairingRecord } from './contracts.js'
import { LaunchService } from './launch-service.js'
import { createCompanionServer, listenCompanionServer } from './local-server.js'
import { MinecraftLauncher } from './minecraft-launcher.js'
import { PairingStore, type PairingPersistence } from './pairing.js'

const { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, shell, Tray } = electron

let mainWindow: BrowserWindowType | undefined
let tray: TrayType | undefined
let quitting = false
let pendingLink: string | undefined

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

function findProtocolLink(values: string[]): string | undefined {
  return values.find((value) => value.startsWith('orbitra://'))
}

pendingLink = findProtocolLink(process.argv)
app.on('open-url', (event, url) => {
  event.preventDefault()
  pendingLink = url
  if (app.isReady()) void handleProtocol(url)
})
app.on('second-instance', (_event, argv) => {
  const link = findProtocolLink(argv)
  if (link) void handleProtocol(link)
  showWindow()
})

class JsonPairingPersistence implements PairingPersistence {
  constructor(private readonly path: string) {}

  async read(): Promise<PairingRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as PairingRecord
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return undefined
      throw cause
    }
  }

  async write(record: PairingRecord): Promise<void> {
    await writeFile(this.path, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
  }
}

class EncryptedTokenVault implements SecretVault {
  constructor(private readonly path: string) {}

  private ensureEncryption(): void {
    const insecureLinuxBackend =
      process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'
    if (!safeStorage.isEncryptionAvailable() || insecureLinuxBackend) {
      throw new Error('系统安全存储不可用；请启用操作系统密钥环后重试登录。')
    }
  }

  async read(): Promise<string | undefined> {
    try {
      this.ensureEncryption()
      const encoded = await readFile(this.path, 'utf8')
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return undefined
      throw cause
    }
  }

  async write(value: string): Promise<void> {
    this.ensureEncryption()
    const encrypted = safeStorage.encryptString(value).toString('base64')
    await writeFile(this.path, encrypted, { encoding: 'utf8', mode: 0o600 })
  }
}

let pairing: PairingStore

function companionHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Orbitra Companion</title><style>
*{box-sizing:border-box}body{margin:0;background:#121615;color:#edf3ef;font:14px system-ui,sans-serif}
main{padding:32px}.brand{display:flex;align-items:center;gap:12px}.mark{width:42px;height:42px;display:grid;place-items:center;border:1px solid #5d806b;border-radius:7px;color:#a8f0c4;background:#1b2921;font-weight:800}
h1{margin:0;font-size:20px;letter-spacing:0}p{margin:20px 0;color:#aeb9b2;line-height:1.65}.status{padding:13px 14px;border-left:3px solid #78c99a;background:#19211d;color:#dce7e0}small{display:block;margin-top:22px;color:#76817b}
</style></head><body><main><div class="brand"><div class="mark">O</div><div><h1>Orbitra Companion</h1><span>本地 Minecraft 启动服务</span></div></div><p>伴侣只监听本机回环地址。回到 Orbitra 网页完成配对，之后即可从版本列表一键启动。</p><div class="status">服务已启动 · 127.0.0.1:${COMPANION_PORT}</div><small>关闭窗口后服务会继续驻留；可从系统托盘退出。</small></main></body></html>`
}

function showWindow(): void {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 470,
    height: 330,
    minWidth: 420,
    minHeight: 300,
    show: false,
    title: 'Orbitra Companion',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(companionHtml())}`)
  mainWindow.once('ready-to-show', showWindow)
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

function createTray(): void {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#18201c"/><circle cx="16" cy="16" r="9" fill="none" stroke="#a8f0c4" stroke-width="4"/><circle cx="16" cy="16" r="3" fill="#f7f9f8"/></svg>`
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  )
  if (icon.isEmpty()) return
  tray = new Tray(icon.resize({ width: 18, height: 18 }))
  tray.setToolTip('Orbitra Companion')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 Orbitra Companion', click: showWindow },
      { label: '打开数据目录', click: () => void shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('double-click', showWindow)
}

async function handleProtocol(value: string): Promise<void> {
  try {
    const url = new URL(value)
    if (url.protocol !== 'orbitra:' || url.hostname !== 'pair')
      throw new Error('不支持的 Orbitra 链接。')
    const origin = url.searchParams.get('origin') ?? ''
    const token = url.searchParams.get('token') ?? ''
    if (url.searchParams.get('eula') !== 'accepted') {
      throw new Error('请先在 Orbitra 网页阅读并接受 Minecraft EULA。')
    }
    const result = await dialog.showMessageBox({
      type: 'question',
      title: '连接 Orbitra 网页',
      message: '允许此网页启动本机 Minecraft？',
      detail: `${origin}\n\n继续表示你确认已阅读并接受 Minecraft EULA。仅应允许你正在使用的 Orbitra 网页。`,
      buttons: ['允许连接', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (result.response !== 0) return
    await pairing.pair(origin, token)
    await dialog.showMessageBox({
      type: 'info',
      title: 'Orbitra 已连接',
      message: '配对完成',
      detail: '回到 Orbitra 网页即可一键启动 Minecraft。',
    })
  } catch (cause) {
    await dialog.showMessageBox({
      type: 'error',
      title: '无法连接 Orbitra',
      message: cause instanceof Error ? cause.message : '配对链接无效。',
    })
  }
}

app.whenReady().then(async () => {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('orbitra', process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient('orbitra')
  }

  const dataPath = app.getPath('userData')
  pairing = new PairingStore(new JsonPairingPersistence(join(dataPath, 'pairing.json')))
  await pairing.load()

  let service!: LaunchService
  const authenticator = new MinecraftAuthenticator(
    new EncryptedTokenVault(join(dataPath, 'microsoft-token-cache.enc')),
    {
      openExternal: (url) => shell.openExternal(url),
      onMessage: (message) => service?.update({ message }),
    },
  )
  const launcher = new MinecraftLauncher(join(dataPath, 'minecraft'), {
    onProgress: (progress) => service?.update({ progress }),
    onMessage: (message) => service?.update({ message }),
    onExit: (code, signal) => service?.gameExited(code, signal),
  })
  service = new LaunchService(app.getVersion(), authenticator, launcher)
  const server = createCompanionServer({
    pairing,
    companionVersion: app.getVersion(),
    getStatus: () => service.snapshot(),
    launch: async (request) => service.accept(request),
  })
  try {
    await listenCompanionServer(server)
  } catch (cause) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Orbitra Companion 无法启动',
      message: cause instanceof Error ? cause.message : '本地服务启动失败。',
    })
    app.quit()
    return
  }

  createWindow()
  createTray()
  if (pendingLink) await handleProtocol(pendingLink)
})

app.on('window-all-closed', () => {})
app.on('before-quit', () => {
  quitting = true
})
