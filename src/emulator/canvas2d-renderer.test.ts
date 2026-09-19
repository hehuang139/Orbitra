import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installCanvas2DRenderer } from './canvas2d-renderer.ts'

test('presents the mGBA RGBX upload as opaque Canvas 2D pixels and restores the canvas', () => {
  const presented: Array<{ data: number[]; width: number; height: number; x: number; y: number }> =
    []
  const surface = {
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: (
      frame: { data: Uint8ClampedArray; width: number; height: number },
      x: number,
      y: number,
    ) =>
      presented.push({
        data: Array.from(frame.data),
        width: frame.width,
        height: frame.height,
        x,
        y,
      }),
  }
  const nativeGetContext = (kind: string) => (kind === '2d' ? surface : null)
  const canvas = {
    width: 2,
    height: 1,
    dataset: {} as Record<string, string>,
    getContext: nativeGetContext,
  } as unknown as HTMLCanvasElement

  const restore = installCanvas2DRenderer(canvas)
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext
  assert.ok(gl)
  assert.equal(canvas.dataset.renderBackend, 'canvas2d')
  assert.equal(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096)
  assert.equal(gl.getProgramParameter(gl.createProgram()!, gl.ACTIVE_UNIFORMS), 2)

  const heap = new Uint8Array([99, 98, 1, 2, 3, 0, 4, 5, 6, 42, 97])
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  ;(gl.texSubImage2D as (...args: unknown[]) => void)(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    2,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    heap,
    2,
  )
  assert.deepEqual(presented, [
    { data: [1, 2, 3, 255, 4, 5, 6, 255], width: 2, height: 1, x: 0, y: 0 },
  ])

  restore()
  restore()
  assert.equal(canvas.getContext, nativeGetContext)
  assert.equal(canvas.dataset.renderBackend, undefined)
  assert.equal('getContextSafariWebGL2Fixed' in canvas, false)
})

test('ignores an out-of-bounds texture upload', () => {
  let presented = false
  const surface = {
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: () => {
      presented = true
    },
  }
  const canvas = {
    width: 2,
    height: 2,
    dataset: {},
    getContext: (kind: string) => (kind === '2d' ? surface : null),
  } as unknown as HTMLCanvasElement
  const restore = installCanvas2DRenderer(canvas)
  try {
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext
    ;(gl.texSubImage2D as (...args: unknown[]) => void)(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      2,
      2,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
      0,
    )
    assert.equal(presented, false)
  } finally {
    restore()
  }
})
