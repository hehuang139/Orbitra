const CHEERPJ_LOADER = 'https://cjrtnc.leaningtech.com/4.3/loader.js'
const CLIENT_PATH = '/files/client_1.2.5.jar'
const CLASSPATH = `/app/lwjgl/lwjgl-2.9.3.jar:/app/lwjgl/lwjgl_util-2.9.3.jar:${CLIENT_PATH}`
const PRELOAD_RESOURCES = {
  '/lt/8/jre/lib/rt.jar': [
    0, 131072, 1310720, 1572864, 4456448, 4849664, 5111808, 5505024, 7995392, 8126464, 9699328,
    9830400, 9961472, 11534336, 11665408, 12189696, 12320768, 12582912, 13238272, 13369344,
    15073280, 15335424, 15466496, 15597568, 15990784, 16121856, 16252928, 16384000, 16777216,
    16908288, 17039360, 17563648, 17694720, 17825792, 17956864, 18087936, 18219008, 18612224,
    18743296, 18874368, 19005440, 19136512, 19398656, 19791872, 20054016, 20709376, 20840448,
    21757952, 21889024, 26869760,
  ],
  '/lt/etc/users': [0, 131072],
  '/lt/etc/localtime': [],
  '/lt/8/jre/lib/cheerpj-awt.jar': [0, 131072],
  '/lt/8/lib/ext/meta-index': [0, 131072],
  '/lt/8/lib/ext': [],
  '/lt/8/lib/ext/index.list': [],
  '/lt/8/lib/ext/localedata.jar': [],
  '/lt/8/jre/lib/jsse.jar': [0, 131072, 786432, 917504],
  '/lt/8/jre/lib/jce.jar': [0, 131072],
  '/lt/8/jre/lib/charsets.jar': [0, 131072, 1703936, 1835008],
  '/lt/8/jre/lib/resources.jar': [0, 131072, 917504, 1179648],
  '/lt/8/jre/lib/javaws.jar': [0, 131072, 1441792, 1703936],
  '/lt/8/lib/ext/sunjce_provider.jar': [],
  '/lt/8/lib/security/java.security': [0, 131072],
  '/lt/8/jre/lib/meta-index': [0, 131072],
  '/lt/8/jre/lib': [],
  '/lt/8/lib/accessibility.properties': [],
  '/lt/8/lib/fonts/LucidaSansRegular.ttf': [],
  '/lt/8/lib/currency.data': [0, 131072],
  '/lt/8/lib/currency.properties': [],
  '/lt/libraries/libGLESv2.so.1': [0, 262144],
  '/lt/libraries/libEGL.so.1': [0, 262144],
  '/lt/8/lib/fonts/badfonts.txt': [],
  '/lt/8/lib/fonts': [],
  '/lt/etc/hosts': [],
  '/lt/etc/resolv.conf': [0, 131072],
  '/lt/8/lib/fonts/fallback': [],
  '/lt/fc/fonts/fonts.conf': [0, 131072],
  '/lt/fc/ttf': [],
  '/lt/fc/cache/e21edda6a7db77f35ca341e0c3cb2a22-le32d8.cache-7': [0, 131072],
  '/lt/fc/ttf/LiberationSans-Regular.ttf': [0, 131072, 262144, 393216],
  '/lt/8/lib/jaxp.properties': [],
  '/lt/etc/timezone': [],
  '/lt/8/lib/tzdb.dat': [0, 131072],
}

const report = (type, message) => parent.postMessage({ type, message }, location.origin)

function loadCheerpJ() {
  if (self.cheerpjInit) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = CHEERPJ_LOADER
    script.crossOrigin = 'anonymous'
    script.onload = resolve
    script.onerror = () => reject(new Error('CheerpJ 浏览器运行时加载失败，请检查网络后重试。'))
    document.head.append(script)
  })
}

function writeFile(path, bytes) {
  return new Promise((resolve, reject) => {
    if (!self.cheerpOSOpen || !self.cheerpOSWrite || !self.cheerpOSClose) {
      reject(new Error('CheerpJ 文件系统不可用。'))
      return
    }
    const fds = []
    self.cheerpOSOpen(fds, path, 'w', (fd) => {
      self.cheerpOSWrite(fds, fd, bytes, 0, bytes.length, () => {
        self.cheerpOSClose(fds, fd, resolve)
      })
    })
  })
}

let started = false
window.addEventListener('message', async (event) => {
  if (started || event.origin !== location.origin || event.source !== parent) return
  if (event.data?.type !== 'orbitra-minecraft-start' || !(event.data.client instanceof ArrayBuffer))
    return
  started = true
  try {
    report('orbitra-minecraft-status', '正在加载 CheerpJ 浏览器 Java 运行时…')
    await loadCheerpJ()
    await self.cheerpjInit({
      version: 8,
      javaProperties: ['java.library.path=/app/lwjgl/libraries/'],
      libraries: { 'libGL.so.1': '/app/lwjgl/libraries/gl4es.wasm' },
      enableX11: true,
      preloadResources: PRELOAD_RESOURCES,
    })
    await self.cheerpjCreateDisplay(-1, -1, document.getElementById('display'))
    report('orbitra-minecraft-status', '正在载入已校验的官方客户端…')
    await writeFile(CLIENT_PATH, new Uint8Array(event.data.client))
    report('orbitra-minecraft-running')
    await self.cheerpjRunMain('net.minecraft.client.Minecraft', CLASSPATH)
  } catch (error) {
    report('orbitra-minecraft-error', error instanceof Error ? error.message : '浏览器运行失败。')
  }
})
