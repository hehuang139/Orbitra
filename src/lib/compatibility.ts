export type CapabilityStatus = 'ok' | 'warning' | 'error'

export interface CapabilityCheck {
  id: 'isolation' | 'sharedArrayBuffer' | 'wasm' | 'webgl' | 'indexedDB' | 'storageQuota'
  label: string
  status: CapabilityStatus
  detail: string
  action?: string
}

export interface CompatibilityReport {
  checks: CapabilityCheck[]
  ready: boolean
  renderingBackend: RenderingBackend
}

export type RenderingBackend = 'webgl2' | 'canvas2d' | 'none'

type ProbeEnvironment = {
  isSecureContext?: boolean
  crossOriginIsolated?: boolean
  SharedArrayBuffer?: unknown
  WebAssembly?: unknown
  indexedDB?: unknown
  navigator?: {
    storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> }
  }
  document?: {
    createElement?: (tag: string) => {
      getContext?: (kind: string) => unknown
    }
  }
}

type RenderingProbe = {
  backend: RenderingBackend
  hasWebGL1: boolean
  softwareWebGL2: boolean
}

const hasFunction = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === 'function'

class ProbeTimeoutError extends Error {}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function releaseWebGLContext(context: unknown): void {
  safely(() => {
    const candidate = context as {
      getExtension?: (name: string) => { loseContext?: () => void } | null
    }
    candidate.getExtension?.('WEBGL_lose_context')?.loseContext?.()
    return true
  }, false)
}

function isSoftwareRenderer(context: unknown): boolean {
  return safely(() => {
    const candidate = context as {
      getExtension?: (name: string) => { UNMASKED_RENDERER_WEBGL?: number } | null
      getParameter?: (parameter: number) => unknown
    }
    const info = candidate.getExtension?.('WEBGL_debug_renderer_info')
    const renderer = info?.UNMASKED_RENDERER_WEBGL
      ? candidate.getParameter?.(info.UNMASKED_RENDERER_WEBGL)
      : candidate.getParameter?.(0x1f01)
    return (
      typeof renderer === 'string' &&
      /swiftshader|llvmpipe|softpipe|lavapipe|software rasterizer|\bwarp\b/i.test(renderer)
    )
  }, false)
}

function probeRendering(environment: ProbeEnvironment): RenderingProbe {
  const createCanvas = () => environment.document?.createElement?.('canvas')
  let webgl2: unknown = null
  try {
    webgl2 = createCanvas()?.getContext?.('webgl2')
    const lost = safely(
      () => (webgl2 as { isContextLost?: () => boolean }).isContextLost?.() === true,
      true,
    )
    if (webgl2 && !lost) {
      return {
        backend: 'webgl2',
        hasWebGL1: false,
        softwareWebGL2: isSoftwareRenderer(webgl2),
      }
    }
  } catch {
    webgl2 = null
  } finally {
    releaseWebGLContext(webgl2)
  }

  let webgl1: unknown = null
  let hasWebGL1 = false
  try {
    webgl1 = createCanvas()?.getContext?.('webgl')
    hasWebGL1 = Boolean(
      webgl1 &&
      !safely(() => (webgl1 as { isContextLost?: () => boolean }).isContextLost?.() === true, true),
    )
  } catch {
    hasWebGL1 = false
  } finally {
    releaseWebGLContext(webgl1)
  }

  const canvas2d = safely(() => createCanvas()?.getContext?.('2d'), null as unknown)
  const supportsCanvas2D = Boolean(
    canvas2d &&
    hasFunction((canvas2d as { createImageData?: unknown }).createImageData) &&
    hasFunction((canvas2d as { putImageData?: unknown }).putImageData),
  )
  return {
    backend: supportsCanvas2D ? 'canvas2d' : 'none',
    hasWebGL1,
    softwareWebGL2: false,
  }
}

let probeSequence = 0

async function probeIndexedDB(
  environment: ProbeEnvironment,
  timeoutMs: number,
): Promise<CapabilityCheck> {
  const check: CapabilityCheck = {
    id: 'indexedDB',
    label: 'IndexedDB',
    status: 'error',
    detail: '浏览器未提供可访问的本地数据库',
    action: '请检查本站点的存储权限与浏览器隐私设置，然后刷新页面重试。',
  }
  let factory: IDBFactory
  try {
    factory = environment.indexedDB as IDBFactory
    if (!factory || !hasFunction(factory.open) || !hasFunction(factory.deleteDatabase)) return check
  } catch {
    return check
  }

  // Never open the application's database. Only delete a database created by
  // this probe's upgrade event, even in the unlikely event of a name collision.
  const name = `advance-capability-probe-${Date.now()}-${++probeSequence}-${Math.random().toString(36).slice(2)}`
  let database: IDBDatabase | undefined
  let transaction: IDBTransaction | undefined
  let owned = false
  let cancelled = false
  let cleanup: Promise<void> | undefined
  const release = () => {
    safely(() => {
      transaction?.abort()
      return true
    }, false)
    safely(() => {
      database?.close()
      return true
    }, false)
  }
  const removeDatabase = (): Promise<void> => {
    release()
    if (!owned) return Promise.resolve()
    if (cleanup) return cleanup
    cleanup = new Promise<void>((resolve, reject) => {
      try {
        const request = factory.deleteDatabase(name)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('临时数据库清理被阻止'))
      } catch (error) {
        reject(error)
      }
    })
    return cleanup
  }

  let verified = false
  const operation = (async () => {
    try {
      database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(name, 1)
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('本地数据库打开被阻止'))
        request.onupgradeneeded = (event) => {
          try {
            if (cancelled || event.oldVersion !== 0) {
              request.transaction?.abort()
              return
            }
            owned = true
            request.result.createObjectStore('probe')
          } catch (error) {
            safely(() => {
              request.transaction?.abort()
              return true
            }, false)
            reject(error)
          }
        }
        request.onsuccess = () => {
          try {
            database = request.result
            if (cancelled || !owned) {
              database.close()
              reject(new Error('本地数据库检查已取消'))
              return
            }
            database.onversionchange = () => database?.close()
            resolve(database)
          } catch (error) {
            reject(error)
          }
        }
      })
      if (cancelled) throw new ProbeTimeoutError()
      await new Promise<void>((resolve, reject) => {
        transaction = database!.transaction('probe', 'readwrite')
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction?.error)
        transaction.objectStore('probe').put(name, 'value')
      })
      if (cancelled) throw new ProbeTimeoutError()
      await new Promise<void>((resolve, reject) => {
        transaction = database!.transaction('probe', 'readonly')
        transaction.onabort = () => reject(transaction?.error)
        const request = transaction.objectStore('probe').get('value')
        let matches = false
        request.onsuccess = () => {
          matches = request.result === name
        }
        transaction.oncomplete = () => (matches ? resolve() : reject(new Error('数据库校验失败')))
      })
      verified = true
    } finally {
      await removeDatabase()
    }
  })()

  try {
    await withTimeout(operation, timeoutMs)
    return {
      ...check,
      status: 'ok',
      detail: '本地数据库读写验证通过，临时数据已清理',
      action: undefined,
    }
  } catch (error) {
    cancelled = true
    release()
    // The open request cannot be cancelled. Its late events still close the
    // connection and run the same cleanup path; this catch handles that result.
    void removeDatabase().catch(() => {})
    return {
      ...check,
      status: verified ? 'warning' : 'error',
      detail: verified
        ? '本地数据库读写可用，临时检查数据尚未清理'
        : error instanceof ProbeTimeoutError
          ? '本地数据库读写检查超时'
          : '浏览器拒绝本地数据库读写',
    }
  }
}

async function probeStorageQuota(
  environment: ProbeEnvironment,
  timeoutMs: number,
): Promise<CapabilityCheck> {
  const check: CapabilityCheck = {
    id: 'storageQuota',
    label: '存储空间',
    status: 'warning',
    detail: '未提供存储配额信息',
    action: '无法估算可用空间；仍可尝试导入游戏，请定期导出存档备份。',
  }
  try {
    const storage = environment.navigator?.storage
    if (!storage || !hasFunction(storage.estimate)) return check
    const result = await withTimeout(Promise.resolve(storage.estimate()), timeoutMs)
    const quota = result.quota
    const usage = result.usage
    if (
      typeof quota !== 'number' ||
      !Number.isFinite(quota) ||
      quota <= 0 ||
      typeof usage !== 'number' ||
      !Number.isFinite(usage) ||
      usage < 0
    )
      return check
    const free = Math.max(0, quota - usage)
    return {
      ...check,
      status: free < 32 * 1048576 ? 'warning' : 'ok',
      detail: `可用空间约 ${Math.round(free / 1048576)} MB`,
      action:
        free < 32 * 1048576 ? '可用空间较少，请先导出备份，再清理无用游戏或存档。' : undefined,
    }
  } catch (error) {
    return {
      ...check,
      detail: error instanceof ProbeTimeoutError ? '存储配额检查超时' : '浏览器拒绝读取存储配额',
    }
  }
}

/** Synchronous core prerequisites shared by startup and the diagnostics panel. */
export function checkRuntimePrerequisites(
  environment: ProbeEnvironment = globalThis as unknown as ProbeEnvironment,
): CompatibilityReport {
  const checks: CapabilityCheck[] = []
  const secure = safely(() => environment.isSecureContext === true, false)
  const isolated = safely(() => environment.crossOriginIsolated === true, false)
  checks.push({
    id: 'isolation',
    label: '跨源隔离',
    status: secure && isolated ? 'ok' : 'error',
    detail: !secure
      ? '当前页面不是安全上下文，模拟核心无法启动'
      : isolated
        ? '安全上下文与 COOP / COEP 已启用'
        : '当前页面未启用跨源隔离，线程无法启动',
    action: !secure
      ? '请通过 HTTPS 或本机 localhost 访问；手机访问局域网 HTTP 地址不属于安全上下文。'
      : isolated
        ? undefined
        : '请配置 COOP: same-origin 与 COEP: require-corp 响应头后刷新页面。',
  })

  const sab = safely(() => hasFunction(environment.SharedArrayBuffer), false)
  checks.push({
    id: 'sharedArrayBuffer',
    label: 'SharedArrayBuffer',
    status: sab ? 'ok' : 'error',
    detail: sab ? '浏览器支持 WebAssembly 线程内存' : '浏览器未提供 SharedArrayBuffer',
    action: sab ? undefined : '请升级浏览器，并确认页面处于跨源隔离环境。',
  })

  const wasm = safely(() => {
    const api = environment.WebAssembly as { instantiate?: unknown; compile?: unknown } | undefined
    return Boolean(api && (hasFunction(api.instantiate) || hasFunction(api.compile)))
  }, false)
  checks.push({
    id: 'wasm',
    label: 'WebAssembly',
    status: wasm ? 'ok' : 'error',
    detail: wasm ? '可以加载 mGBA 模拟核心' : '浏览器不支持 WebAssembly',
    action: wasm ? undefined : '请升级浏览器后重试。',
  })

  const rendering = probeRendering(environment)
  const renderingStatus: CapabilityStatus =
    rendering.backend === 'none'
      ? 'error'
      : rendering.backend === 'canvas2d' || rendering.softwareWebGL2
        ? 'warning'
        : 'ok'
  const renderingDetail =
    rendering.backend === 'webgl2'
      ? rendering.softwareWebGL2
        ? 'WebGL 2 软件渲染可用，性能可能较低'
        : 'WebGL 2 可以显示游戏画面'
      : rendering.backend === 'canvas2d'
        ? rendering.hasWebGL1
          ? '仅检测到 WebGL 1，将使用 Canvas 2D 软件渲染'
          : 'WebGL 不可用，将使用 Canvas 2D 软件渲染'
        : rendering.hasWebGL1
          ? '浏览器仅提供 WebGL 1，且 Canvas 2D 软件渲染不可用'
          : '无法创建 WebGL 或 Canvas 2D 图形上下文'
  checks.push({
    id: 'webgl',
    label: '图形渲染',
    status: renderingStatus,
    detail: renderingDetail,
    action:
      renderingStatus === 'ok'
        ? undefined
        : rendering.backend === 'none'
          ? '请启用 Canvas 2D 或硬件加速；若刚更新显卡驱动，请重启系统和浏览器后重试。'
          : rendering.backend === 'canvas2d'
            ? '兼容模式支持 GBA、GB 与 GBC；如帧率较低，请更新显卡驱动并重启浏览器。'
            : '当前使用浏览器的软件图形后端；如帧率较低，请修复显卡驱动或启用硬件加速。',
  })

  return {
    checks,
    ready: checks.every((check) => check.status !== 'error'),
    renderingBackend: rendering.backend,
  }
}

export async function probeCompatibility(
  environment: ProbeEnvironment = globalThis as unknown as ProbeEnvironment,
  options: { timeoutMs?: number } = {},
): Promise<CompatibilityReport> {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : 2000
  const runtime = checkRuntimePrerequisites(environment)
  const { checks } = runtime
  checks.push(
    ...(await Promise.all([
      probeIndexedDB(environment, timeoutMs),
      probeStorageQuota(environment, timeoutMs),
    ])),
  )

  return {
    checks,
    ready: checks.every((check) => check.status !== 'error'),
    renderingBackend: runtime.renderingBackend,
  }
}
