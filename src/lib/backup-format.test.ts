import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Zip, ZipDeflate, strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  BACKUP_LIMITS,
  createBackup,
  gameIdForRom,
  parseBackup,
  sha256,
  validateBackupData,
} from './backup-format.ts'
import type { BackupData } from './backup-format.ts'
import type { GamePlatform } from './platforms.ts'

const MiB = 1024 * 1024
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII='
const archive = (bytes: Uint8Array) => new File([bytes], 'advance-backup.zip')

const platformFixtures: Record<GamePlatform, { filename: string; size: number; seed: number }> = {
  gba: { filename: 'test.gba', size: 512, seed: 0 },
  gb: { filename: 'test.gb', size: 32 * 1024, seed: 17 },
  gbc: { filename: 'test.gbc', size: 32 * 1024, seed: 31 },
  nes: { filename: 'test.nes', size: 16 * 1024 + 16, seed: 43 },
  snes: { filename: 'test.sfc', size: 32 * 1024, seed: 59 },
}

async function fixture(platform: GamePlatform = 'gba'): Promise<BackupData> {
  const definition = platformFixtures[platform]
  const rom = Uint8Array.from(
    { length: definition.size },
    (_, index) => (index + definition.seed) % 251,
  )
  const id = await gameIdForRom(platform, rom)
  return {
    formatVersion: 1,
    exportedAt: '2026-09-10T10:00:00.000Z',
    coreVersion: 'test-core@1',
    games: [
      {
        game: {
          id,
          title: '原创测试游戏',
          filename: definition.filename,
          platform,
          size: rom.length,
          addedAt: 42,
          lastPlayed: 99,
          playTime: 3,
          favorite: true,
          color: '#abc',
          cheats: [
            { id: 'infinite-lives', name: 'Infinite lives', code: '1234 5678', enabled: true },
          ],
        },
        rom,
        battery: new Uint8Array([1, 2, 3]),
        states: [
          {
            id: `${id}:0`,
            gameId: id,
            slot: 0,
            data: new Uint8Array([4, 5, 6]),
            screenshot: PNG,
            createdAt: 88,
            coreVersion: 'test-core@1',
          },
          { id: `${id}:2`, gameId: id, slot: 2, data: new Uint8Array([7, 8, 9]), createdAt: 77 },
        ],
      },
    ],
  }
}

async function packed(platform: GamePlatform = 'gba'): Promise<Uint8Array> {
  return createBackup(await fixture(platform), { includeRoms: true })
}

function mutateManifest(
  bytes: Uint8Array,
  work: (manifest: any, files: Record<string, Uint8Array>) => void,
): Uint8Array {
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['manifest.json']))
  work(manifest, files)
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  return zipSync(files)
}

function centralOffsets(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = bytes.length - 22
  const records: number[] = []
  let cursor = view.getUint32(eocd + 16, true)
  for (let count = view.getUint16(eocd + 10, true); count > 0; count--) {
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
  const central = centralOffsets(copy)[index]
  patch(view, central, view.getUint32(central + 42, true))
  return copy
}

test('full export round-trips metadata, ROM, battery and known/unknown state core versions', async () => {
  const data = await fixture()
  const progress: string[] = []
  const bytes = await createBackup(data, {
    includeRoms: true,
    onProgress: (message) => progress.push(message),
  })
  assert.deepEqual(await parseBackup(archive(bytes)), data)
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['manifest.json']))
  assert.equal(manifest.format, 'advance-gba-backup')
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.games[0].states[1].coreVersion, undefined)
  for (const file of manifest.files) {
    assert.equal(file.size, files[file.path].length)
    assert.equal(file.sha256, await sha256(files[file.path]))
  }
  assert.equal(progress.length, 2)
})

test('GB and GBC exports round-trip platform metadata and platform-specific ROM paths', async () => {
  for (const platform of ['gb', 'gbc'] as const) {
    const data = await fixture(platform)
    const bytes = await createBackup(data, { includeRoms: true })
    const files = unzipSync(bytes)
    const manifest = JSON.parse(strFromU8(files['manifest.json']))
    const romPath = `games/${data.games[0].game.id}/rom.${platform}`
    assert.ok(files[romPath])
    assert.equal(manifest.games[0].game.platform, platform)
    assert.equal(manifest.games[0].rom, romPath)
    assert.equal(
      manifest.files.find((file: any) => file.path === romPath).sha256,
      await sha256(data.games[0].rom!),
    )
    assert.notEqual(manifest.games[0].game.id, await sha256(data.games[0].rom!))
    assert.deepEqual(await parseBackup(archive(bytes)), data)
  }
})

test('keeps legacy GBA IDs and separates identical GB and GBC ROM bytes', async () => {
  const rom = Uint8Array.from({ length: 32 * 1024 }, (_, index) => index % 251)
  const raw = await sha256(rom)
  const gba = await gameIdForRom('gba', rom)
  const gb = await gameIdForRom('gb', rom)
  const gbc = await gameIdForRom('gbc', rom)
  assert.equal(gba, raw)
  assert.match(gb, /^[0-9a-f]{64}$/)
  assert.match(gbc, /^[0-9a-f]{64}$/)
  assert.notEqual(gb, raw)
  assert.notEqual(gbc, raw)
  assert.notEqual(gb, gbc)
})

test('reads legacy v1 GBA manifests without platform but does not infer newer platforms', async () => {
  const expected = await fixture('gba')
  const legacy = mutateManifest(await packed('gba'), (manifest) => {
    delete manifest.games[0].game.platform
  })
  assert.deepEqual(await parseBackup(archive(legacy)), expected)

  const ambiguous = mutateManifest(await packed('gb'), (manifest) => {
    delete manifest.games[0].game.platform
  })
  await assert.rejects(parseBackup(archive(ambiguous)), /游戏信息无效/)
})

test('rejects unsupported platforms, filename mismatches and wrong platform ROM payload paths', async () => {
  const unsupported = mutateManifest(await packed('gba'), (manifest) => {
    manifest.games[0].game.platform = 'nes'
  })
  await assert.rejects(parseBackup(archive(unsupported)), /游戏信息无效/)

  const wrongExtension = mutateManifest(await packed('gb'), (manifest) => {
    manifest.games[0].game.filename = 'test.gbc'
  })
  await assert.rejects(parseBackup(archive(wrongExtension)), /游戏信息无效/)

  const wrongPayload = mutateManifest(await packed('gb'), (manifest, files) => {
    const original = manifest.games[0].rom
    const replacement = original.replace(/rom\.gb$/, 'rom.gbc')
    files[replacement] = files[original]
    delete files[original]
    manifest.games[0].rom = replacement
    manifest.files.find((file: any) => file.path === original).path = replacement
  })
  await assert.rejects(parseBackup(archive(wrongPayload)), /文件引用.*内容标识/)
})

test('default exports omit every ROM and support metadata-only games', async () => {
  const data = await fixture()
  const result = await parseBackup(archive(await createBackup(data)))
  assert.equal(result.games[0].rom, undefined)
  assert.deepEqual(result.games[0].battery, data.games[0].battery)
  assert.equal(
    Object.keys(unzipSync(await createBackup(data))).some((path) =>
      /\/rom\.(?:gba|gb|gbc)$/.test(path),
    ),
    false,
  )
  delete data.games[0].battery
  data.games[0].states = []
  const metadata = await parseBackup(archive(await createBackup(data)))
  assert.deepEqual(metadata.games[0].states, [])
  await assert.rejects(createBackup(metadata, { includeRoms: true }), /缺少 ROM/)
})

test('preserves battery-first startup semantics across backup round trips', async () => {
  for (const skipAutoState of [undefined, false, true]) {
    const data = await fixture()
    if (skipAutoState !== undefined) data.games[0].game.skipAutoState = skipAutoState
    const result = await parseBackup(archive(await createBackup(data, { includeRoms: true })))
    assert.equal(result.games[0].game.skipAutoState, skipAutoState)
    assert.deepEqual(result, data)
  }
  const invalid = mutateManifest(await packed(), (manifest) => {
    manifest.games[0].game.skipAutoState = 'true'
  })
  await assert.rejects(parseBackup(archive(invalid)), /游戏信息无效/)

  const localPreference = await fixture()
  localPreference.games[0].game.resumeAutoSaveSlot = 6
  const exported = await parseBackup(
    archive(await createBackup(localPreference, { includeRoms: true })),
  )
  assert.equal(exported.games[0].game.resumeAutoSaveSlot, undefined)
})

test('round-trips per-game launch preferences and rejects invalid values', async () => {
  const data = await fixture()
  data.games[0].game.launchMode = 'state'
  data.games[0].game.launchStateSlot = 2
  const bytes = await createBackup(data, { includeRoms: true })
  assert.deepEqual(await parseBackup(archive(bytes)), data)

  const badMode = mutateManifest(bytes, (manifest) => {
    manifest.games[0].game.launchMode = 'surprise'
  })
  await assert.rejects(parseBackup(archive(badMode)), /游戏信息无效/)

  const badSlot = mutateManifest(bytes, (manifest) => {
    manifest.games[0].game.launchStateSlot = 8
  })
  await assert.rejects(parseBackup(archive(badSlot)), /游戏信息无效/)
})

test('snapshot bytes cannot be changed by a caller while asynchronous export hashes them', async () => {
  const data = await fixture()
  const original = new Uint8Array(data.games[0].battery!)
  const pending = createBackup(data)
  data.games[0].battery!.fill(100)
  data.games[0].game.title = 'changed'
  const restored = await parseBackup(archive(await pending))
  assert.deepEqual(restored.games[0].battery, original)
  assert.equal(restored.games[0].game.title, '原创测试游戏')
})

test('rejects old/future/absent versions with a no-write explanation', async () => {
  for (const version of [0, 2, undefined, '1']) {
    const bytes = mutateManifest(await packed(), (manifest) => {
      manifest.formatVersion = version
    })
    await assert.rejects(parseBackup(archive(bytes)), /不支持备份格式版本.*未写入/)
  }
})

test('validates filenames, finite metadata, dates, content identifiers and PNG-only screenshots', async () => {
  const changes = [
    (data: BackupData) => {
      data.games[0].game.filename = '../test.gba'
    },
    (data: BackupData) => {
      data.games[0].game.playTime = NaN
    },
    (data: BackupData) => {
      data.games[0].game.id = 'not-a-content-hash'
    },
    (data: BackupData) => {
      data.exportedAt = '2026-02-31T00:00:00.000Z'
    },
    (data: BackupData) => {
      data.games[0].states[0].screenshot = 'data:image/svg+xml,<svg/>'
    },
    (data: BackupData) => {
      data.games[0].states[0].screenshot = PNG + 'A'.repeat(BACKUP_LIMITS.screenshotCharacters)
    },
    (data: BackupData) => {
      data.games[0].states[0].coreVersion = ''
    },
  ]
  for (const change of changes) {
    const data = await fixture()
    change(data)
    assert.throws(() => validateBackupData(data), /备份/)
  }
})

test('rejects duplicate games/slots, foreign state IDs and slots outside 0..7', async () => {
  const data = await fixture()
  data.games.push(data.games[0])
  assert.throws(() => validateBackupData(data), /重复.*游戏/)
  data.games.pop()
  data.games[0].states.push(data.games[0].states[0])
  assert.throws(() => validateBackupData(data), /重复.*槽位/)
  data.games[0].states.pop()
  data.games[0].states[0].id = 'foreign:0'
  assert.throws(() => validateBackupData(data), /存档信息无效/)
  const invalidSlot = mutateManifest(await packed(), (manifest) => {
    manifest.games[0].states[0].slot = 8
  })
  await assert.rejects(parseBackup(archive(invalidSlot)), /槽位仅支持/)
})

test('rejects ROM bytes belonging to another game on export and import', async () => {
  const data = await fixture()
  data.games[0].rom![0] ^= 1
  await assert.rejects(createBackup(data, { includeRoms: true }), /ROM 内容标识/)
  const bytes = mutateManifest(await packed(), (manifest, files) => {
    const original = manifest.games[0].game.id
    const replacement = '0'.repeat(64)
    manifest.games[0].game.id = replacement
    const rename = (path: string) => path.replace(original, replacement)
    manifest.games[0].rom = rename(manifest.games[0].rom)
    manifest.games[0].battery = rename(manifest.games[0].battery)
    for (const state of manifest.games[0].states) {
      state.id = `${replacement}:${state.slot}`
      state.gameId = replacement
      state.path = rename(state.path)
    }
    for (const file of manifest.files) {
      const originalPath = file.path
      file.path = rename(originalPath)
      files[file.path] = files[originalPath]
      delete files[originalPath]
    }
  })
  await assert.rejects(parseBackup(archive(bytes)), /ROM 内容标识/)
})

test('rejects SHA-256 corruption even if the ZIP CRC has been recomputed', async () => {
  const bytes = mutateManifest(await packed(), (_manifest, files) => {
    const battery = Object.keys(files).find((path) => path.endsWith('battery.sav'))!
    files[battery][0] ^= 1
  })
  await assert.rejects(parseBackup(archive(bytes)), /SHA-256 校验失败/)
})

test('rejects missing references, duplicate declarations and metadata/file size mismatch', async () => {
  const changes = [
    (manifest: any) => {
      manifest.games[0].battery = `games/${'0'.repeat(64)}/battery.sav`
    },
    (manifest: any) => {
      manifest.files.push(manifest.files[0])
    },
    (manifest: any) => {
      manifest.files[0].size++
    },
    (manifest: any) => {
      manifest.games[0].game.size++
    },
    (manifest: any) => {
      manifest.files[0].sha256 = 'x'
    },
  ]
  for (const change of changes)
    await assert.rejects(parseBackup(archive(mutateManifest(await packed(), change))), /备份/)
})

test('rejects undeclared and unreferenced payloads', async () => {
  const extra = mutateManifest(await packed(), (manifest, files) => {
    files[`games/${manifest.games[0].game.id}/state-5.bin`] = new Uint8Array([1])
  })
  await assert.rejects(parseBackup(archive(extra)), /未声明.*额外负载/)
  const unused = mutateManifest(await packed(), (manifest) => {
    delete manifest.games[0].battery
  })
  await assert.rejects(parseBackup(archive(unused)), /未引用.*额外负载/)
})

test('rejects path traversal, backslashes, absolute paths, directories and unrelated entries', async () => {
  for (const path of [
    '../manifest.json',
    '/manifest.json',
    'games\\rom.gba',
    'games/',
    'README.txt',
  ]) {
    const files = unzipSync(await packed())
    files[path] = new Uint8Array([1])
    await assert.rejects(parseBackup(archive(zipSync(files))), /非法路径.*路径穿越/)
  }
})

test('rejects duplicate ZIP paths rather than letting the latter replace a verified file', async () => {
  const files = unzipSync(await packed())
  const first = Object.keys(files).find((path) => path.endsWith('state-0.bin'))!
  const second = first.replace('state-0.bin', 'state-2.bin')
  let bytes = zipSync({
    [first]: files[first],
    [second]: files[second],
    'manifest.json': files['manifest.json'],
  })
  bytes = patchEntry(bytes, 1, (view, central, local) => {
    const name = strToU8(first)
    new Uint8Array(view.buffer).set(name, central + 46)
    new Uint8Array(view.buffer).set(name, local + 30)
  })
  await assert.rejects(parseBackup(archive(bytes)), /重复文件条目/)
})

test('rejects hidden local files omitted from the central directory', async () => {
  const bytes = await packed()
  const offsets = centralOffsets(bytes)
  const first = offsets[0]
  const next = offsets[1]
  const removed = next - first
  const copy = new Uint8Array(bytes.length - removed)
  copy.set(bytes.subarray(0, first))
  copy.set(bytes.subarray(next), first)
  const view = new DataView(copy.buffer)
  const eocd = copy.length - 22
  view.setUint16(eocd + 8, offsets.length - 1, true)
  view.setUint16(eocd + 10, offsets.length - 1, true)
  view.setUint32(eocd + 12, view.getUint32(eocd + 12, true) - removed, true)
  await assert.rejects(parseBackup(archive(copy)), /ZIP 已损坏.*边界/)
})

test('accepts stored and streaming ZIPs with checked data descriptors', async () => {
  const files = unzipSync(await packed())
  assert.equal((await parseBackup(archive(zipSync(files, { level: 0 })))).games.length, 1)
  const chunks: Uint8Array[] = []
  const writer = new Zip((error, bytes) => {
    if (error) throw error
    chunks.push(bytes)
  })
  for (const [path, payload] of Object.entries(files)) {
    const file = new ZipDeflate(path)
    writer.add(file)
    file.push(payload, true)
  }
  writer.end()
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  assert.equal((await parseBackup(archive(bytes))).games.length, 1)
  const corrupt = patchEntry(bytes, 0, (view, central, local) => {
    const end =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true) +
      view.getUint32(central + 20, true)
    view.setUint32(end + 4, 0, true)
  })
  await assert.rejects(parseBackup(archive(corrupt)), /ZIP 已损坏/)
})

test('rejects truncation, malformed JSON, local-header conflicts and CRC corruption', async () => {
  const bytes = await packed()
  for (const bad of [
    new Uint8Array(),
    bytes.subarray(0, bytes.length - 1),
    new Uint8Array([1, 2, 3]),
  ])
    await assert.rejects(parseBackup(archive(bad)), /ZIP 已损坏/)
  const files = unzipSync(bytes)
  files['manifest.json'] = strToU8('{broken')
  await assert.rejects(parseBackup(archive(zipSync(files))), /manifest.json 无法读取/)
  const local = patchEntry(bytes, 0, (view, _central, offset) =>
    view.setUint16(offset + 8, 99, true),
  )
  await assert.rejects(parseBackup(archive(local)), /ZIP 已损坏/)
  const stored = zipSync(unzipSync(bytes), { level: 0 })
  const corrupt = patchEntry(stored, 0, (view, _central, offset) => {
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true)
    view.setUint8(start, view.getUint8(start) ^ 1)
  })
  await assert.rejects(parseBackup(archive(corrupt)), /完整性校验失败/)
})

test('rejects encrypted, unsupported-method, split and ZIP64 archives', async () => {
  const bytes = await packed()
  const flags = patchEntry(bytes, 0, (view, central, local) => {
    view.setUint16(central + 8, 1, true)
    view.setUint16(local + 6, 1, true)
  })
  await assert.rejects(parseBackup(archive(flags)), /加密/)
  const method = patchEntry(bytes, 0, (view, central, local) => {
    view.setUint16(central + 10, 12, true)
    view.setUint16(local + 8, 12, true)
  })
  await assert.rejects(parseBackup(archive(method)), /压缩方式/)
  for (const zip64 of [true, false]) {
    const copy = new Uint8Array(bytes)
    const view = new DataView(copy.buffer)
    if (zip64) view.setUint32(bytes.length - 22 + 16, 0xffffffff, true)
    else view.setUint16(bytes.length - 22 + 4, 1, true)
    await assert.rejects(parseBackup(archive(copy)), zip64 ? /ZIP64/ : /分卷/)
  }
})

test('checks archive, game count, single-item and cumulative size limits before inflate', async () => {
  const file = archive(new Uint8Array())
  Object.defineProperty(file, 'size', { value: BACKUP_LIMITS.archiveBytes + 1 })
  await assert.rejects(parseBackup(file), /72 MiB/)
  const data = await fixture()
  data.games = Array.from({ length: 17 }, () => data.games[0])
  assert.throws(() => validateBackupData(data), /1 至 16/)
  const bytes = await packed()
  const tooMany = new Uint8Array(bytes)
  const view = new DataView(tooMany.buffer)
  view.setUint16(bytes.length - 22 + 8, 162, true)
  view.setUint16(bytes.length - 22 + 10, 162, true)
  await assert.rejects(parseBackup(archive(tooMany)), /161 项/)
  const oversized = patchEntry(bytes, 0, (view, central, local) => {
    view.setUint32(central + 24, BACKUP_LIMITS.romBytes + 1, true)
    view.setUint32(local + 22, BACKUP_LIMITS.romBytes + 1, true)
  })
  await assert.rejects(parseBackup(archive(oversized)), /声明大小.*单项限制/)
  const id = data.games[0].game.id
  let cumulative = zipSync(
    Object.fromEntries([
      ['manifest.json', strToU8('{}')],
      ...Array.from({ length: 5 }, (_, index) => [
        `games/${id}/state-${index}.bin`,
        new Uint8Array([1]),
      ]),
    ]),
  )
  for (let index = 1; index <= 5; index++)
    cumulative = patchEntry(cumulative, index, (view, central, local) => {
      view.setUint32(central + 24, 16 * MiB, true)
      view.setUint32(local + 22, 16 * MiB, true)
    })
  await assert.rejects(parseBackup(archive(cumulative)), /总大小.*64 MiB/)
})

test('stops expansion beyond a forged declared size', async () => {
  const data = await fixture()
  const id = data.games[0].game.id
  const path = `games/${id}/battery.sav`
  const files = unzipSync(await packed())
  files[path] = new Uint8Array(MiB)
  let bytes = zipSync(files)
  const paths = Object.keys(files)
  bytes = patchEntry(bytes, paths.indexOf(path), (view, central, local) => {
    view.setUint32(central + 24, 3, true)
    view.setUint32(local + 22, 3, true)
  })
  await assert.rejects(parseBackup(archive(bytes)), /实际解压大小.*声明限制/)
})

test('synchronous validation enforces battery/state/ROM limits without hashing or database writes', async () => {
  for (const kind of ['battery', 'state', 'rom'] as const) {
    const data = await fixture()
    if (kind === 'battery') data.games[0].battery = new Uint8Array(BACKUP_LIMITS.batteryBytes + 1)
    if (kind === 'state')
      data.games[0].states[0].data = new Uint8Array(BACKUP_LIMITS.stateBytes + 1)
    if (kind === 'rom') data.games[0].rom = new Uint8Array(BACKUP_LIMITS.romBytes + 1)
    assert.throws(() => validateBackupData(data), /大小无效.*单项限制/)
  }
})

test('counts manifest and screenshots toward synchronous metadata and total limits', async () => {
  const data = await fixture()
  const largeScreenshot = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(240 * 1024)
  data.games = Array.from({ length: 2 }, (_, gameIndex) => {
    const id = String(gameIndex).repeat(64)
    return {
      game: { ...data.games[0].game, id },
      states: Array.from({ length: 6 }, (_, slot) => ({
        id: `${id}:${slot}`,
        gameId: id,
        slot,
        createdAt: 1,
        data: new Uint8Array([1]),
        screenshot: largeScreenshot,
      })),
    }
  })
  assert.throws(() => validateBackupData(data), /清单超过 2 MiB/)
  await assert.rejects(createBackup(data), /清单超过 2 MiB/)
  const total = await fixture()
  total.games[0].rom = new Uint8Array(BACKUP_LIMITS.romBytes)
  total.games[0].game.size = BACKUP_LIMITS.romBytes
  total.games[0].battery = undefined
  total.games[0].states = [0, 1].map((slot) => ({
    id: `${total.games[0].game.id}:${slot}`,
    gameId: total.games[0].game.id,
    slot,
    data: new Uint8Array(BACKUP_LIMITS.stateBytes),
    createdAt: 1,
  }))
  assert.throws(() => validateBackupData(total), /关联 ROM 与存档超过 64 MiB/)
})

test('omitted ROMs still count toward the same 64 MiB restore working-set limit', async () => {
  const data = await fixture()
  data.games = Array.from({ length: 3 }, (_, index) => ({
    game: { ...data.games[0].game, id: String(index).repeat(64), size: 32 * MiB },
    states: [],
  }))
  assert.throws(() => validateBackupData(data), /关联 ROM 与存档超过 64 MiB.*分批备份/)
  await assert.rejects(createBackup(data), /关联 ROM 与存档超过 64 MiB.*分批备份/)
  const bytes = mutateManifest(await packed(), (manifest, files) => {
    manifest.games = data.games
    manifest.files = []
    for (const path of Object.keys(files)) if (path !== 'manifest.json') delete files[path]
  })
  await assert.rejects(parseBackup(archive(bytes)), /关联 ROM 与存档超过 64 MiB.*分批备份/)
})
