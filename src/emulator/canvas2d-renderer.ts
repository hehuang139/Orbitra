type MutableCanvas = HTMLCanvasElement & {
  getContextSafariWebGL2Fixed?: HTMLCanvasElement['getContext']
}

type SoftwareObject = {
  kind: string
  name?: number
}

type UniformInfo = {
  name: string
  size: number
  type: number
}

const ACTIVE_UNIFORMS = 0x8b86
const FRAMEBUFFER_BINDING = 0x8ca6
const MAX_TEXTURE_SIZE = 0x0d33
const RENDERER = 0x1f01
const SHADING_LANGUAGE_VERSION = 0x8b8c
const VENDOR = 0x1f00
const VERSION = 0x1f02

const uniforms: UniformInfo[] = [
  { name: 'u_projection', size: 1, type: 0x8b5c },
  { name: 'u_texture', size: 1, type: 0x8b5e },
]

const noop = () => {}

function makeObject(kind: string): SoftwareObject {
  return { kind }
}

/**
 * Implements the small WebGL surface used by the fixed mGBA SDL renderer.
 * The core still renders every frame; only its final RGBX texture upload is
 * presented through Canvas 2D when the browser cannot create WebGL 2.
 */
function createSoftwareContext(
  canvas: HTMLCanvasElement,
  surface: CanvasRenderingContext2D,
): WebGL2RenderingContext {
  let textureWidth = canvas.width
  let textureHeight = canvas.height
  let frame: ImageData | null = null

  const context = {
    ACTIVE_UNIFORMS,
    MAX_TEXTURE_SIZE,
    RGBA: 0x1908,
    TEXTURE_2D: 0x0de1,
    UNSIGNED_BYTE: 0x1401,
    canvas,
    get drawingBufferWidth() {
      return canvas.width
    },
    get drawingBufferHeight() {
      return canvas.height
    },
    getSupportedExtensions: () => [],
    getExtension: () => null,
    getContextAttributes: () => ({
      alpha: false,
      antialias: false,
      depth: false,
      failIfMajorPerformanceCaveat: false,
      powerPreference: 'low-power',
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: false,
      desynchronized: true,
    }),
    getParameter: (parameter: number) => {
      if (parameter === MAX_TEXTURE_SIZE) return 4096
      if (parameter === FRAMEBUFFER_BINDING) return null
      if (parameter === VERSION) return 'WebGL 2.0 (Orbitra Canvas 2D compatibility)'
      if (parameter === SHADING_LANGUAGE_VERSION) return 'WebGL GLSL ES 3.00 (compatibility)'
      if (parameter === RENDERER) return 'Orbitra Canvas 2D'
      if (parameter === VENDOR) return 'Orbitra'
      return 0
    },
    getError: () => 0,
    isContextLost: () => false,

    createShader: () => makeObject('shader'),
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    getShaderSource: () => '',
    deleteShader: noop,

    createProgram: () => makeObject('program'),
    attachShader: noop,
    detachShader: noop,
    bindAttribLocation: noop,
    linkProgram: noop,
    validateProgram: noop,
    getProgramParameter: (_program: SoftwareObject, parameter: number) =>
      parameter === ACTIVE_UNIFORMS ? uniforms.length : true,
    getProgramInfoLog: () => '',
    getActiveUniform: (_program: SoftwareObject, index: number) => uniforms[index] ?? null,
    getUniformLocation: (_program: SoftwareObject, name: string) => ({ name }),
    getAttribLocation: (_program: SoftwareObject, name: string) =>
      ({ a_position: 0, a_color: 1, a_texCoord: 2 })[name as 'a_position'] ?? -1,
    useProgram: noop,
    deleteProgram: noop,

    createBuffer: () => makeObject('buffer'),
    bindBuffer: noop,
    bufferData: noop,
    bufferSubData: noop,
    deleteBuffer: noop,

    createTexture: () => makeObject('texture'),
    bindTexture: noop,
    activeTexture: noop,
    texParameteri: noop,
    texParameterf: noop,
    pixelStorei: noop,
    generateMipmap: noop,
    deleteTexture: noop,
    texImage2D: (...args: unknown[]) => {
      textureWidth = Number(args[3]) || canvas.width
      textureHeight = Number(args[4]) || canvas.height
    },
    texSubImage2D: (...args: unknown[]) => {
      const x = Number(args[2]) || 0
      const y = Number(args[3]) || 0
      const width = Number(args[4]) || textureWidth
      const height = Number(args[5]) || textureHeight
      const source = args[8]
      const sourceOffset = Number(args[9]) || 0
      if (
        !ArrayBuffer.isView(source) ||
        !Number.isSafeInteger(sourceOffset) ||
        sourceOffset < 0 ||
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0
      )
        return

      const elementSize =
        'BYTES_PER_ELEMENT' in source && typeof source.BYTES_PER_ELEMENT === 'number'
          ? source.BYTES_PER_ELEMENT
          : 1
      const byteOffset = source.byteOffset + sourceOffset * elementSize
      const byteLength = width * height * 4
      if (
        byteOffset < source.byteOffset ||
        byteOffset + byteLength > source.byteOffset + source.byteLength
      )
        return

      if (!frame || frame.width !== width || frame.height !== height)
        frame = surface.createImageData(width, height)
      frame.data.set(new Uint8Array(source.buffer, byteOffset, byteLength))
      // SDL uploads RGBX pixels. WebGL's alpha:false surface ignores the X byte,
      // while putImageData treats it as alpha and would make valid colors transparent.
      for (let index = 3; index < frame.data.length; index += 4) frame.data[index] = 255
      surface.putImageData(frame, x, y)
    },

    createFramebuffer: () => makeObject('framebuffer'),
    bindFramebuffer: noop,
    framebufferTexture2D: noop,
    checkFramebufferStatus: () => 0x8cd5,
    deleteFramebuffer: noop,
    createRenderbuffer: () => makeObject('renderbuffer'),
    bindRenderbuffer: noop,
    renderbufferStorage: noop,
    framebufferRenderbuffer: noop,
    deleteRenderbuffer: noop,

    viewport: noop,
    scissor: noop,
    clearColor: noop,
    clearDepth: noop,
    clearStencil: noop,
    clear: noop,
    enable: noop,
    disable: noop,
    blendColor: noop,
    blendEquation: noop,
    blendEquationSeparate: noop,
    blendFunc: noop,
    blendFuncSeparate: noop,
    colorMask: noop,
    depthMask: noop,
    depthFunc: noop,
    cullFace: noop,
    frontFace: noop,
    lineWidth: noop,
    polygonOffset: noop,
    sampleCoverage: noop,
    stencilFunc: noop,
    stencilMask: noop,
    stencilOp: noop,
    enableVertexAttribArray: noop,
    disableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    uniform1i: noop,
    uniform1f: noop,
    uniform2f: noop,
    uniform3f: noop,
    uniform4f: noop,
    uniformMatrix4fv: noop,
    drawArrays: noop,
    drawElements: noop,
    finish: noop,
    flush: noop,
  }

  return context as unknown as WebGL2RenderingContext
}

/** Installs a reversible WebGL facade on one canvas; no globals are changed. */
export function installCanvas2DRenderer(canvas: HTMLCanvasElement): () => void {
  const mutable = canvas as MutableCanvas
  const getContextDescriptor = Object.getOwnPropertyDescriptor(canvas, 'getContext')
  const safariFixDescriptor = Object.getOwnPropertyDescriptor(canvas, 'getContextSafariWebGL2Fixed')
  const nativeGetContext = canvas.getContext.bind(canvas)
  const surface = nativeGetContext('2d', {
    alpha: false,
    desynchronized: true,
  })
  if (!surface) throw new Error('浏览器无法创建 Canvas 2D 软件渲染上下文。')

  const softwareContext = createSoftwareContext(canvas, surface)
  Object.defineProperty(canvas, 'getContext', {
    configurable: true,
    writable: true,
    value: (kind: string, ...args: unknown[]) =>
      kind === 'webgl2'
        ? softwareContext
        : (nativeGetContext as (...parameters: unknown[]) => unknown)(kind, ...args),
  })
  // The fixed upstream glue uses this marker before applying a Safari WebGL 2
  // wrapper. The facade is already normalized and must remain intact.
  Object.defineProperty(canvas, 'getContextSafariWebGL2Fixed', {
    configurable: true,
    writable: true,
    value: nativeGetContext,
  })
  canvas.dataset.renderBackend = 'canvas2d'

  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (getContextDescriptor) Object.defineProperty(canvas, 'getContext', getContextDescriptor)
    else delete (canvas as unknown as { getContext?: unknown }).getContext
    if (safariFixDescriptor)
      Object.defineProperty(canvas, 'getContextSafariWebGL2Fixed', safariFixDescriptor)
    else delete mutable.getContextSafariWebGL2Fixed
    delete canvas.dataset.renderBackend
  }
}
