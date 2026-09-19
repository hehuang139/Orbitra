import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Zip, ZipDeflate, zipSync } from 'fflate'
import { extractRomFiles, importableRomFiles } from './import-roms.ts'

const MiB = 1024 * 1024
const payload = (seed = 1, size = 1024) => new Uint8Array(size).fill(seed)
const archive = (bytes: Uint8Array, name = 'Games.zip') => new File([bytes], name)
async function collect(file: File): Promise<File[]> {
  const result: File[] = []
  for await (const rom of extractRomFiles(file)) result.push(rom)
  return result
}

function directory(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  const records: number[] = []
  let cursor = view.getUint32(end + 16, true)
  for (let count = view.getUint16(end + 10, true); count > 0; count--) {
    records.push(cursor)
    cursor +=
      46 +
      view.getUint16(cursor + 28, true) +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true)
  }
  return records
}

function patchEntry(
  bytes: Uint8Array,
  index: number,
  patch: (view: DataView, central: number, local: number) => void,
): Uint8Array {
  const copy = new Uint8Array(bytes)
  const view = new DataView(copy.buffer)
  const central = directory(copy)[index]
  patch(view, central, view.getUint32(central + 42, true))
  return copy
}

test('folder scans keep supported ROMs and ZIPs while ignoring unrelated files', () => {
  const macMetadata = new File([], 'metadata.gba')
  Object.defineProperty(macMetadata, 'webkitRelativePath', {
    value: 'Library/__MACOSX/metadata.gba',
  })
  const files = [
    new File([], 'Advance.GBA'),
    new File([], 'handheld.gb'),
    new File([], 'collection.ZIP'),
    new File([], 'Advance.png'),
    new File([], 'README.txt'),
    new File([], 'Advance.sav'),
    new File([], '._metadata.gba'),
    macMetadata,
  ]
  assert.deepEqual(
    importableRomFiles(files).map((file) => file.name),
    ['Advance.GBA', 'handheld.gb', 'collection.ZIP'],
  )
})

function declaredSize(bytes: Uint8Array, index: number, size: number): Uint8Array {
  return patchEntry(bytes, index, (view, central, local) => {
    view.setUint32(central + 24, size, true)
    view.setUint32(local + 22, size, true)
  })
}

test('direct supported ROM files retain identity and leave hardware validation to storage', async () => {
  for (const name of [
    'Example.GBA',
    'Pocket.GB',
    'Color.GBC',
    'Console.NES',
    'Super.SFC',
    'Header.SMC',
  ]) {
    const rom = new File([payload()], name)
    assert.deepEqual(await collect(rom), [rom])
  }
  assert.deepEqual(await collect(new File([], 'small.gba')).then((files) => files[0].size), 0)
  await assert.rejects(
    collect(new File([], 'game.7z')),
    /\.gba.*\.gb.*\.gbc.*\.nes.*\.sfc.*\.smc.*\.zip/,
  )
})

test('stored and deflated ZIPs preserve original bytes and reduce nested names to basenames', async () => {
  for (const level of [0, 6] as const) {
    const files = await collect(
      archive(
        zipSync({ 'folder/中文游戏.GBA': payload(7), 'other/demo.gba': payload(8) }, { level }),
        'Games.ZIP',
      ),
    )
    assert.deepEqual(
      files.map((file) => file.name),
      ['中文游戏.GBA', 'demo.gba'],
    )
    assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), payload(7))
    assert.deepEqual(new Uint8Array(await files[1].arrayBuffer()), payload(8))
  }
})

test('extracts mixed-platform archives with original platform extensions', async () => {
  const files = await collect(
    archive(
      zipSync({
        'advance/game.GBA': payload(1),
        'classic/game.gb': payload(2, 32 * 1024),
        'color/game.GBC': payload(3, 32 * 1024),
        'console/game.nes': payload(4, 16 * 1024 + 16),
        'super/game.SFC': payload(5, 32 * 1024),
        'header/game.smc': payload(6, 32 * 1024 + 512),
      }),
    ),
  )
  assert.deepEqual(
    files.map((file) => file.name),
    ['game.GBA', 'game.gb', 'game.GBC', 'game.nes', 'game.SFC', 'game.smc'],
  )
  assert.deepEqual(
    files.map((file) => file.size),
    [1024, 32 * 1024, 32 * 1024, 16 * 1024 + 16, 32 * 1024, 32 * 1024 + 512],
  )
})

test('same basenames from distinct folders remain distinct ROMs', async () => {
  const files = await collect(
    archive(zipSync({ 'one/game.gba': payload(1), 'two/game.gba': payload(2) })),
  )
  assert.deepEqual(
    files.map((file) => file.name),
    ['game.gba', 'game.gba'],
  )
  assert.notDeepEqual(await files[0].arrayBuffer(), await files[1].arrayBuffer())
})

test('ignores docs, nested archives and Mac metadata without inflating them', async () => {
  let bytes = zipSync({
    'readme.txt': payload(),
    'inner.zip': payload(),
    '__MACOSX/game.gba': payload(),
    'folder/._game.gba': payload(),
    'good.gba': payload(9),
  })
  // An unsupported compression method in an unrelated document must not be decoded.
  bytes = patchEntry(bytes, 0, (view, central, local) => {
    view.setUint16(central + 10, 99, true)
    view.setUint16(local + 8, 99, true)
  })
  const files = await collect(archive(bytes))
  assert.deepEqual(
    files.map((file) => file.name),
    ['good.gba'],
  )
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), payload(9))
})

test('supports ZIP data descriptors produced by streaming writers', async () => {
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, data) => {
    if (error) throw error
    chunks.push(data)
  })
  const file = new ZipDeflate('streamed.gba')
  zip.add(file)
  file.push(payload(3, 512), false)
  file.push(payload(4, 512), true)
  zip.end()
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const files = await collect(archive(bytes))
  assert.equal(files.length, 1)
  const expected = new Uint8Array(1024)
  expected.set(payload(3, 512))
  expected.set(payload(4, 512), 512)
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), expected)
})

test('reports malformed, truncated, empty and nested-only archives clearly', async () => {
  await assert.rejects(collect(archive(payload())), /ZIP 文件已损坏/)
  await assert.rejects(collect(archive(new Uint8Array())), /ZIP 文件已损坏/)
  const bytes = zipSync({ 'game.gba': payload() })
  await assert.rejects(collect(archive(bytes.subarray(0, bytes.length - 4))), /ZIP 文件已损坏/)
  await assert.rejects(collect(archive(zipSync({}))), /没有找到.*\.gba/)
  await assert.rejects(collect(archive(zipSync({ 'inner.zip': bytes }))), /不支持.*嵌套 ZIP/)
})

test('encrypted and unsupported-method ROMs offer an unpack-first error', async () => {
  const bytes = zipSync({ 'game.gba': payload() })
  const encrypted = patchEntry(bytes, 0, (view, central, local) => {
    view.setUint16(central + 8, 1, true)
    view.setUint16(local + 6, 1, true)
  })
  await assert.rejects(collect(archive(encrypted)), /已加密.*解压/)
  const unsupported = patchEntry(bytes, 0, (view, central, local) => {
    view.setUint16(central + 10, 12, true)
    view.setUint16(local + 8, 12, true)
  })
  await assert.rejects(collect(archive(unsupported)), /不支持.*压缩方式.*解压/)
})

test('rejects corruption by verifying decompressed CRC, including a later entry', async () => {
  const bytes = zipSync({ 'good.gba': payload(), 'bad.gba': payload(2) }, { level: 0 })
  const corrupted = patchEntry(bytes, 1, (view, _central, local) => {
    const payloadOffset =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    view.setUint8(payloadOffset, 33)
  })
  const generator = extractRomFiles(archive(corrupted))
  assert.equal((await generator.next()).value?.name, 'good.gba')
  await assert.rejects(generator.next(), /bad.gba.*完整性校验失败/)
})

test('rejects wrong local headers and out-of-bounds payload locations', async () => {
  const bytes = zipSync({ 'game.gba': payload() })
  await assert.rejects(
    collect(
      archive(
        patchEntry(bytes, 0, (view, _central, local) => view.setUint32(local + 22, 999, true)),
      ),
    ),
    /ZIP 文件已损坏/,
  )
  await assert.rejects(
    collect(
      archive(
        patchEntry(bytes, 0, (view, central) => view.setUint32(central + 42, bytes.length, true)),
      ),
    ),
    /ZIP 文件已损坏/,
  )
})

test('enforces archive, ROM count and cumulative declared size limits before inflating', async () => {
  const oversized = archive(new Uint8Array())
  Object.defineProperty(oversized, 'size', { value: 64 * MiB + 1 })
  await assert.rejects(collect(oversized), /64 MiB/)
  const many = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`${index}.gba`, payload()]),
  )
  await assert.rejects(collect(archive(zipSync(many))), /最多导入 32/)
  let total = zipSync(
    Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`${index}.gba`, payload()])),
  )
  for (let index = 0; index < 5; index++) total = declaredSize(total, index, 32 * MiB)
  await assert.rejects(collect(archive(total)), /总大小.*128 MiB/)
})

test('checks both declared and actual output sizes, even when attacker forges ZIP sizes', async () => {
  const bytes = zipSync({ 'game.gba': payload() })
  await assert.rejects(collect(archive(declaredSize(bytes, 0, 191))), /大小无效/)
  await assert.rejects(collect(archive(declaredSize(bytes, 0, 32 * MiB + 1))), /大小无效/)
  await assert.rejects(collect(archive(declaredSize(bytes, 0, 192))), /实际解压大小/)
  await assert.rejects(collect(archive(declaredSize(bytes, 0, 2048))), /完整性校验失败/)
  const bomb = zipSync({ 'bomb.gba': payload(0, 32 * MiB + 1) })
  await assert.rejects(collect(archive(declaredSize(bomb, 0, 32 * MiB))), /实际解压大小.*32 MiB/)

  const gb = zipSync({ 'game.gb': payload(1, 32 * 1024) })
  await assert.rejects(collect(archive(declaredSize(gb, 0, 32 * 1024 - 1))), /GB.*32 KiB.*8 MiB/)
  await assert.rejects(collect(archive(declaredSize(gb, 0, 8 * MiB + 1))), /GB.*32 KiB.*8 MiB/)
})

test('rejects ZIP64 and split archives with actionable explanations', async () => {
  const bytes = zipSync({ 'game.gba': payload() })
  const zip64 = new Uint8Array(bytes)
  new DataView(zip64.buffer).setUint32(zip64.length - 22 + 16, 0xffffffff, true)
  await assert.rejects(collect(archive(zip64)), /ZIP64.*解压/)
  const split = new Uint8Array(bytes)
  new DataView(split.buffer).setUint16(split.length - 22 + 4, 1, true)
  await assert.rejects(collect(archive(split)), /分卷 ZIP/)
})
