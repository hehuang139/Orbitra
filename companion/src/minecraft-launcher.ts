import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MinecraftFolder,
  Version,
  launch,
  type JavaVersion,
  type ResolvedVersion,
} from '@xmcl/core'
import {
  DEFAULT_RUNTIME_ALL_URL,
  ProgressTrackerMultiple,
  createDefaultNodeInstallRuntime,
  createJavaRuntimeInstallWorkflow,
  executeInstallManifest,
  executeInstallWorkflow,
  fetchJavaRuntimeManifest,
  resolveAssetMetadataInstallFiles,
  resolveAssetObjectInstallFiles,
  resolveJava,
  resolveLibraryInstallFiles,
  resolveMinecraftJarInstallFile,
  type InstallFile,
  type JavaRuntimeTarget,
  type JavaRuntimes,
} from '@xmcl/installer'
import type { ChildProcess } from 'node:child_process'
import { VERSION_MANIFEST_URL } from './config.js'
import type { CompanionProgress, LaunchRequest } from './contracts.js'
import type { MinecraftIdentity } from './auth.js'

interface ManifestEntry {
  id: string
  url: string
  sha1: string
}

interface VersionManifest {
  versions: ManifestEntry[]
}

const OFFICIAL_DOWNLOAD_HOSTS = new Set([
  'piston-meta.mojang.com',
  'launchermeta.mojang.com',
  'piston-data.mojang.com',
  'launcher.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
])

export function assertOfficialDownloadUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !OFFICIAL_DOWNLOAD_HOSTS.has(url.hostname)
  ) {
    throw new Error(`拒绝非 Mojang / Microsoft 官方下载地址：${url.hostname || value}`)
  }
  return url.href
}

function assertOfficialFiles(files: InstallFile[]): void {
  for (const file of files) {
    for (const url of file.urls) assertOfficialDownloadUrl(url)
  }
}

export interface LauncherCallbacks {
  onProgress(progress: CompanionProgress | undefined): void
  onMessage(message: string): void
  onExit(code: number | null, signal: NodeJS.Signals | null): void
}

function runtimePlatformKey(): keyof JavaRuntimes {
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return 'windows-arm64'
    if (process.arch === 'ia32') return 'windows-x86'
    return 'windows-x64'
  }
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os'
  if (process.platform === 'linux' && process.arch === 'ia32') return 'linux-i386'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux'
  throw new Error(
    `当前系统架构尚无可验证的 Mojang Java 运行时：${process.platform}/${process.arch}`,
  )
}

function javaExecutable(root: string): string {
  return join(root, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
}

function assertManifestEntry(value: unknown, versionId: string): ManifestEntry {
  if (!value || typeof value !== 'object') throw new Error(`官方目录中没有版本 ${versionId}。`)
  const entry = value as Record<string, unknown>
  if (
    entry.id !== versionId ||
    typeof entry.url !== 'string' ||
    typeof entry.sha1 !== 'string' ||
    !/^[a-f0-9]{40}$/.test(entry.sha1)
  ) {
    throw new Error(`版本 ${versionId} 的官方元数据无效。`)
  }
  assertOfficialDownloadUrl(entry.url)
  return entry as unknown as ManifestEntry
}

export class MinecraftLauncher {
  private process?: ChildProcess

  constructor(
    private readonly root: string,
    private readonly callbacks: LauncherCallbacks,
  ) {}

  isRunning(): boolean {
    return Boolean(this.process && this.process.exitCode === null && !this.process.killed)
  }

  private async installFiles(
    files: InstallFile[],
    label: string,
    tracker: ProgressTrackerMultiple,
  ) {
    if (!files.length) return
    assertOfficialFiles(files)
    this.callbacks.onMessage(label)
    const timer = setInterval(() => {
      this.callbacks.onProgress({ completed: tracker.progress, total: tracker.total, label })
    }, 250)
    try {
      await executeInstallManifest(
        { schemaVersion: 1, tasks: [{ id: label, type: 'files', files }] },
        createDefaultNodeInstallRuntime({ tracker, maxConcurrency: 16 }),
      )
    } finally {
      clearInterval(timer)
      this.callbacks.onProgress({ completed: tracker.progress, total: tracker.total, label })
    }
  }

  private async installVersion(versionId: string): Promise<ResolvedVersion> {
    const minecraft = MinecraftFolder.from(this.root)
    await mkdir(this.root, { recursive: true })
    const manifestResponse = await fetch(VERSION_MANIFEST_URL)
    if (!manifestResponse.ok)
      throw new Error(`读取 Mojang 版本目录失败（${manifestResponse.status}）。`)
    const manifest = (await manifestResponse.json()) as VersionManifest
    const entry = assertManifestEntry(
      manifest.versions.find((candidate) => candidate.id === versionId),
      versionId,
    )
    const tracker = new ProgressTrackerMultiple()
    await this.installFiles(
      [
        {
          path: minecraft.getVersionJson(versionId),
          urls: [entry.url],
          checksum: { algorithm: 'sha1', value: entry.sha1 },
          validator: 'json',
        },
      ],
      '下载版本元数据',
      tracker,
    )
    const resolved = await Version.parse(this.root, versionId)
    const jar = resolveMinecraftJarInstallFile(resolved)
    if (!jar?.checksum) throw new Error(`版本 ${versionId} 缺少可校验的客户端文件。`)
    const libraries = resolveLibraryInstallFiles(resolved.libraries, minecraft, {
      libraryHost: (library) => library.download.url,
      strict: true,
    })
    if (libraries.some((file) => !file.checksum)) {
      throw new Error(`版本 ${versionId} 包含无法校验的 Java 依赖。`)
    }
    await this.installFiles([jar, ...libraries], '下载客户端与 Java 依赖', tracker)
    const metadata = resolveAssetMetadataInstallFiles(resolved, minecraft, { strict: true })
    if (metadata.some((file) => !file.checksum)) {
      throw new Error(`版本 ${versionId} 包含无法校验的资源元数据。`)
    }
    await this.installFiles(metadata, '下载资源索引', tracker)
    const assets = await resolveAssetObjectInstallFiles(resolved, minecraft, { strict: true })
    await this.installFiles(assets, '下载游戏资源', tracker)
    return resolved
  }

  private async ensureJava(target: JavaVersion): Promise<string> {
    const runtimeRoot = join(this.root, 'runtime', `${target.component}-${target.majorVersion}`)
    const executable = javaExecutable(runtimeRoot)
    const current = await resolveJava(executable)
    if (current?.majorVersion === target.majorVersion) return executable

    this.callbacks.onMessage(`安装 Mojang Java ${target.majorVersion} 运行时`)
    const response = await fetch(DEFAULT_RUNTIME_ALL_URL)
    if (!response.ok) throw new Error(`读取 Mojang Java 运行时目录失败（${response.status}）。`)
    const runtimes = (await response.json()) as JavaRuntimes
    const targets = runtimes[runtimePlatformKey()]?.[target.component]
    const runtime: JavaRuntimeTarget | undefined = targets?.[0]
    if (!runtime) throw new Error(`Mojang 未提供 ${target.component} 的当前平台运行时。`)
    assertOfficialDownloadUrl(runtime.manifest.url)
    const runtimeManifest = await fetchJavaRuntimeManifest({
      manifestIndex: runtimes,
      target: target.component,
    })
    for (const entry of Object.values(runtimeManifest.files)) {
      if (entry.type === 'file') assertOfficialDownloadUrl(entry.downloads.raw.url)
    }
    const tracker = new ProgressTrackerMultiple()
    const timer = setInterval(() => {
      this.callbacks.onProgress({
        completed: tracker.progress,
        total: tracker.total,
        label: `安装 Java ${target.majorVersion}`,
      })
    }, 250)
    try {
      await executeInstallWorkflow(
        createJavaRuntimeInstallWorkflow({ target: runtime, destination: runtimeRoot }),
        createDefaultNodeInstallRuntime({ tracker, maxConcurrency: 16 }),
      )
    } finally {
      clearInterval(timer)
    }
    const installed = await resolveJava(executable)
    if (installed?.majorVersion !== target.majorVersion) {
      throw new Error(`Java 运行时安装完成，但版本不是所需的 Java ${target.majorVersion}。`)
    }
    return executable
  }

  async launch(request: LaunchRequest, identity: MinecraftIdentity): Promise<void> {
    if (this.isRunning()) throw new Error('Minecraft 已在运行。')
    const resolved = await this.installVersion(request.versionId)
    const javaPath = await this.ensureJava(resolved.javaVersion)
    this.callbacks.onProgress(undefined)
    this.callbacks.onMessage(`正在启动 Minecraft ${request.versionId}`)
    const child = await launch({
      version: resolved,
      gamePath: join(this.root, 'instances', request.versionId),
      resourcePath: this.root,
      javaPath,
      gameProfile: { id: identity.id, name: identity.name },
      accessToken: identity.accessToken,
      userType: 'mojang',
      launcherName: 'Orbitra',
      launcherBrand: 'Orbitra',
      minMemory: request.minMemory ?? 1024,
      maxMemory: request.maxMemory ?? 4096,
      extraExecOption: { stdio: ['ignore', 'pipe', 'pipe'] },
    })
    this.process = child
    child.once('exit', (code, signal) => {
      this.process = undefined
      this.callbacks.onExit(code, signal)
    })
    child.stderr?.on('data', (value: Buffer) => {
      const line = value.toString('utf8').trim().split(/\r?\n/).at(-1)
      if (line) this.callbacks.onMessage(line.slice(0, 240))
    })
  }
}
