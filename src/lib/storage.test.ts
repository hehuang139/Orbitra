import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  cacheRom,
  deleteGame,
  deleteState,
  getBatterySave,
  getGames,
  getRom,
  getState,
  getStates,
  importGame,
  saveState,
  setBatterySave,
  updateGame,
  getLibrarySnapshot,
  previewRestore,
  repairImportedTitles,
  restoreLibrary,
  getStorageSummary,
} from './storage.ts'
import type { RestoreChoices, RestorePreview } from './storage.ts'
import type { BackupData } from './backup-format.ts'
import { BUNDLED_CORE_ID, coreIdForPlatform } from './core-version.ts'
import { PLATFORM_REGISTRY, platformFromFilename } from './platforms.ts'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

function rom(name = 'Test_game.gba', seed = 1, size = 1024): File {
  return new File([new Uint8Array(size).fill(seed)], name)
}

function nesRom(name = 'Console.nes'): File {
  const bytes = new Uint8Array(PLATFORM_REGISTRY.nes.minRomSize)
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1])
  return new File([bytes], name)
}

function snesRom(
  name = '123456.sfc',
  title = 'ADVANCE SNES TEST',
  options: { copierHeader?: boolean; hiRom?: boolean } = {},
): File {
  const base = options.copierHeader ? 512 : 0
  const size = options.hiRom ? 64 * 1024 : 32 * 1024
  const bytes = new Uint8Array(base + size).fill(0xff)
  const header = base + (options.hiRom ? 0xffc0 : 0x7fc0)
  bytes.fill(0x20, header, header + 21)
  bytes.set(new TextEncoder().encode(title).subarray(0, 21), header)
  bytes[header + 0x15] = options.hiRom ? 0x21 : 0x20
  bytes[header + 0x1c] = 0xcb
  bytes[header + 0x1d] = 0xed
  bytes[header + 0x1e] = 0x34
  bytes[header + 0x1f] = 0x12
  bytes[header + 0x3c] = 0x00
  bytes[header + 0x3d] = 0x80
  return new File([bytes], name)
}

async function corrupt(store: string, record: object): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('advance-gba', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(record)
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

test('imports content once even when concurrent imports use different filenames', async () => {
  assert.deepEqual(await getGames(), [])
  const [a, b] = await Promise.all([importGame(rom()), importGame(rom('Renamed.GBA'))])
  assert.equal(a.id, b.id)
  assert.match(a.id, /^[0-9a-f]{64}$/)
  assert.equal((await getGames()).length, 1)
  assert.deepEqual(await getRom(a.id), new Uint8Array(1024).fill(1))
  await updateGame(a.id, { favorite: true, playTime: 34, title: 'My game' })
  const again = await importGame(rom('Third.gba'))
  assert.equal(again.title, 'My game')
  assert.equal(again.playTime, 34)
  assert.equal(again.favorite, true)
})

test('validates ROM file type and hardware size bounds before storing', async () => {
  await assert.rejects(importGame(rom('wrong.zip')), /\.gba/)
  await assert.rejects(importGame(rom('small.gba', 1, 191)), /大小无效/)
  await assert.rejects(importGame(rom('large.gba', 1, 32 * 1024 * 1024 + 1)), /大小无效/)
  assert.deepEqual(await getGames(), [])
  assert.equal((await importGame(rom('minimum.gba', 1, 192))).size, 192)
})

test('imports GB and GBC metadata with platform-specific size bounds', async () => {
  assert.equal(platformFromFilename('Pocket.GB'), 'gb')
  assert.equal(platformFromFilename('Color.gBc'), 'gbc')
  assert.equal(platformFromFilename('Advance.GBA'), 'gba')
  assert.equal(platformFromFilename('readme.txt'), undefined)

  const gb = await importGame(rom('Pocket_game.GB', 2, PLATFORM_REGISTRY.gb.minRomSize))
  const gbc = await importGame(rom('Color_game.gbc', 3, PLATFORM_REGISTRY.gbc.minRomSize))
  assert.deepEqual(
    [gb, gbc].map(({ title, platform, size }) => ({ title, platform, size })),
    [
      { title: 'Pocket game', platform: 'gb', size: 32 * 1024 },
      { title: 'Color game', platform: 'gbc', size: 32 * 1024 },
    ],
  )
  await assert.rejects(importGame(rom('small.gb', 1, 32 * 1024 - 1)), /GB.*32 KiB.*8 MiB/)
  await assert.rejects(importGame(rom('large.gbc', 1, 8 * 1024 * 1024 + 1)), /GBC.*32 KiB.*8 MiB/)
})

test('imports FC and SFC metadata, validates headers and records platform core IDs', async () => {
  assert.equal(platformFromFilename('Mario.NES'), 'nes')
  assert.equal(platformFromFilename('Zelda.SFC'), 'snes')
  assert.equal(platformFromFilename('Header.SMC'), 'snes')
  await assert.rejects(
    importGame(rom('invalid.nes', 1, PLATFORM_REGISTRY.nes.minRomSize)),
    /iNES|NES 2\.0/,
  )
  const nes = await importGame(nesRom())
  const snes = await importGame(rom('Super.sfc', 4, PLATFORM_REGISTRY.snes.minRomSize))
  assert.deepEqual(
    [nes, snes].map(({ title, platform }) => ({ title, platform })),
    [
      { title: 'Console', platform: 'nes' },
      { title: 'Super', platform: 'snes' },
    ],
  )
  assert.equal(
    (await saveState(nes.id, 1, new Uint8Array([1]))).coreVersion,
    coreIdForPlatform('nes'),
  )
  assert.equal(
    (await saveState(snes.id, 1, new Uint8Array([2]))).coreVersion,
    coreIdForPlatform('snes'),
  )
})

test('uses validated SFC internal titles and repairs older filename-derived metadata', async () => {
  const loRom = await importGame(snesRom())
  const hiRom = await importGame(snesRom('987654.sfc', 'HIROM ADVENTURE', { hiRom: true }))
  const copierHeader = await importGame(
    snesRom('000001.smc', 'HEADERED SFC GAME', { copierHeader: true }),
  )
  assert.deepEqual(
    [loRom, hiRom, copierHeader].map((game) => game.title),
    ['ADVANCE SNES TEST', 'HIROM ADVENTURE', 'HEADERED SFC GAME'],
  )

  await corrupt('games', { ...loRom, title: '123456' })
  assert.equal(await repairImportedTitles(), 1)
  assert.equal((await getGames()).find((game) => game.id === loRom.id)?.title, 'ADVANCE SNES TEST')
  assert.equal(await repairImportedTitles(), 0)

  await updateGame(loRom.id, { title: '我的自定义标题' })
  assert.equal(await repairImportedTitles(), 0)
  assert.equal((await importGame(snesRom())).title, '我的自定义标题')
})

test('isolates identical ROM bytes imported for different platforms', async () => {
  const gb = await importGame(rom('Same.gb', 9, PLATFORM_REGISTRY.gb.minRomSize))
  const gbc = await importGame(rom('Same.gbc', 9, PLATFORM_REGISTRY.gbc.minRomSize))
  assert.notEqual(gb.id, gbc.id)
  assert.equal((await getGames()).length, 2)
  await setBatterySave(gb.id, new Uint8Array([1]))
  await setBatterySave(gbc.id, new Uint8Array([2]))
  assert.deepEqual(await getBatterySave(gb.id), new Uint8Array([1]))
  assert.deepEqual(await getBatterySave(gbc.id), new Uint8Array([2]))
})

test('reads legacy GBA records without platform metadata and validates explicit platforms', async () => {
  const game = await importGame(rom())
  const { platform: _platform, ...legacy } = game
  await corrupt('games', legacy)
  assert.equal((await getGames())[0].platform, 'gba')
  assert.equal((await updateGame(game.id, { title: 'Legacy game' })).platform, 'gba')

  await corrupt('games', { ...game, platform: 'gb' })
  await assert.rejects(getGames(), /游戏信息已损坏/)
})

test('rejects GB and GBC records without platform metadata', async () => {
  for (const [filename, seed] of [
    ['Missing.gb', 2],
    ['Missing.gbc', 3],
  ] as const) {
    const game = await importGame(rom(filename, seed, 32 * 1024))
    const { platform: _platform, ...missingPlatform } = game
    await corrupt('games', missingPlatform)
    await assert.rejects(getGames(), /游戏信息已损坏/)
    await corrupt('games', game)
  }
})

test('updates merge metadata, preserve identity, and serialize concurrent edits', async () => {
  const game = await importGame(rom())
  await Promise.all([
    updateGame(game.id, { favorite: true }),
    updateGame(game.id, { playTime: 125 }),
  ])
  const unsafeChanges: Partial<typeof game> = {
    id: 'different-id',
    filename: 'Different.gb',
    platform: 'gb',
    size: 32 * 1024,
    addedAt: 0,
    lastPlayed: Date.now(),
  }
  const updated = await updateGame(game.id, unsafeChanges)
  assert.equal(updated.id, game.id)
  assert.equal(updated.filename, game.filename)
  assert.equal(updated.platform, game.platform)
  assert.equal(updated.size, game.size)
  assert.equal(updated.addedAt, game.addedAt)
  assert.equal(updated.favorite, true)
  assert.equal(updated.playTime, 125)
  assert.equal(updated.filename, game.filename)
  await assert.rejects(updateGame(game.id, { playTime: -1 }), /游戏信息已损坏/)
  assert.equal((await getGames())[0].playTime, 125)
  await assert.rejects(updateGame('missing', { favorite: true }), /游戏不存在/)
})

test('save slots overwrite atomically and do not expose stored byte buffers', async () => {
  const game = await importGame(rom())
  const bytes = new Uint8Array([1, 2, 3])
  await saveState(game.id, 2, bytes, 'data:image/png;base64,test')
  bytes[0] = 99
  const first = await getState(game.id, 2)
  assert.deepEqual(first?.data, new Uint8Array([1, 2, 3]))
  first!.data[1] = 99
  assert.equal((await getState(game.id, 2))?.data[1], 2)
  await saveState(game.id, 2, new Uint8Array([4, 5]))
  await saveState(game.id, 0, new Uint8Array([8]))
  const states = await getStates(game.id)
  assert.deepEqual(
    states.map((state) => state.slot),
    [0, 2],
  )
  assert.deepEqual(states[1].data, new Uint8Array([4, 5]))
  assert.equal(states[1].screenshot, undefined)
  await deleteState(game.id, 2)
  assert.equal(await getState(game.id, 2), undefined)
  await assert.rejects(saveState(game.id, -1, bytes), /槽位无效/)
  await assert.rejects(saveState(game.id, 1, new Uint8Array()), /存档已损坏/)
})

test('deleting a game removes ROM, battery, and states without affecting another game', async () => {
  const a = await importGame(rom())
  const b = await importGame(rom('Other.gba', 2))
  for (const game of [a, b]) {
    await setBatterySave(game.id, new Uint8Array([6, 7]))
    await saveState(game.id, 0, new Uint8Array([3, 4]))
    await saveState(game.id, 1, new Uint8Array([5, 6]))
  }
  await deleteGame(a.id)
  assert.deepEqual(
    (await getGames()).map((game) => game.id),
    [b.id],
  )
  assert.equal(await getRom(a.id), undefined)
  assert.equal(await getBatterySave(a.id), undefined)
  assert.deepEqual(await getStates(a.id), [])
  assert.equal((await getStates(b.id)).length, 2)
  assert.deepEqual(await getBatterySave(b.id), new Uint8Array([6, 7]))
  assert.equal((await getRom(b.id))?.length, 1024)
  await deleteGame(a.id)
  await assert.rejects(saveState(a.id, 1, new Uint8Array([1])), /游戏不存在/)
  await assert.rejects(setBatterySave(a.id, new Uint8Array([1])), /游戏不存在/)
})

test('detects corrupted persisted ROMs and repairs bytes on reimport', async () => {
  const game = await importGame(rom())
  await corrupt('roms', { id: game.id, data: new Uint8Array([1]) })
  await assert.rejects(getRom(game.id), /ROM 数据已损坏/)
  await importGame(rom())
  assert.equal((await getRom(game.id))?.length, 1024)
  await corrupt('roms', { id: game.id, data: 'invalid bytes' })
  await assert.rejects(getRom(game.id), /ROM 数据已损坏/)
})

test('rejects corrupted state, battery, and library metadata with actionable errors', async () => {
  const game = await importGame(rom())
  await corrupt('states', {
    id: `${game.id}:1`,
    gameId: game.id,
    slot: 1,
    createdAt: Date.now(),
    data: [1, 2],
  })
  await assert.rejects(getState(game.id, 1), /即时存档已损坏/)
  await assert.rejects(getStates(game.id), /即时存档已损坏/)
  await corrupt('batteries', { gameId: game.id, data: 'invalid' })
  await assert.rejects(getBatterySave(game.id), /电池存档已损坏/)
  await corrupt('games', { ...game, playTime: Number.NaN })
  await assert.rejects(getGames(), /游戏信息已损坏/)
  // Deletion remains available even when the metadata cannot be parsed.
  await deleteGame(game.id)
  assert.deepEqual(await getGames(), [])
})

test('explains unavailable browser storage in Chinese', async () => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: undefined,
    writable: true,
    configurable: true,
  })
  await assert.rejects(getGames(), /不支持本地游戏库/)
})

function defaultChoices(preview: RestorePreview): RestoreChoices {
  return {
    fingerprint: preview.fingerprint,
    games: Object.fromEntries(preview.games.map((entry) => [entry.game.id, entry.defaults])),
  }
}

async function backupFixture(): Promise<BackupData> {
  const first = await importGame(rom())
  const second = await importGame(rom('Test_game.gba', 2))
  for (const game of [first, second]) {
    await updateGame(game.id, { favorite: true, playTime: 45 })
    await setBatterySave(game.id, new Uint8Array([7, 8, 9]))
    await saveState(game.id, 0, new Uint8Array([10, 11]))
    await saveState(game.id, 1, new Uint8Array([12, 13]))
  }
  return getLibrarySnapshot(undefined, true)
}

async function rawLibrary(): Promise<unknown[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('advance-gba', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const tx = database.transaction(['games', 'roms', 'batteries', 'states'], 'readonly')
    return await Promise.all(
      ['games', 'roms', 'batteries', 'states'].map(
        (store) =>
          new Promise((resolve, reject) => {
            const request = tx.objectStore(store).getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          }),
      ),
    )
  } finally {
    database.close()
  }
}

test('exports selected games from one four-store read transaction and omits ROM by default', async () => {
  const fixture = await backupFixture()
  const id = fixture.games[0].game.id
  const original = IDBDatabase.prototype.transaction
  const calls: { stores: string[]; mode?: IDBTransactionMode }[] = []
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    calls.push({ stores: typeof stores === 'string' ? [stores] : [...stores], mode })
    return original.call(this, stores, mode, options)
  }
  let data: BackupData
  try {
    data = await getLibrarySnapshot([id])
  } finally {
    IDBDatabase.prototype.transaction = original
  }
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { stores: ['games', 'roms', 'states', 'batteries'], mode: 'readonly' })
  assert.equal(data.coreVersion, BUNDLED_CORE_ID)
  assert.equal(data.games.length, 1)
  assert.equal(data.games[0].rom, undefined)
  assert.equal(data.games[0].game.id, id)
  assert.equal(data.games[0].states[0].coreVersion, BUNDLED_CORE_ID)
  data.games[0].battery![0] = 99
  assert.equal((await getBatterySave(id))![0], 7)
  await assert.rejects(getLibrarySnapshot([id, id]), /不重复/)
  await assert.rejects(getLibrarySnapshot(['missing']), /已不存在/)
})

test('preview and cancellation leave all four tables unchanged with defaults preserving local conflicts', async () => {
  const fixture = await backupFixture()
  const before = await rawLibrary()
  const preview = await previewRestore(fixture)
  assert.equal(preview.games.length, 2)
  assert.equal(preview.stateCount, 4)
  for (const entry of preview.games) {
    assert.equal(entry.missingRom, false)
    assert.equal(entry.battery.conflict, true)
    assert.ok(entry.states.every((state) => state.conflict && !state.incompatible))
    assert.deepEqual(entry.defaults, { metadata: false, battery: false, slots: [] })
  }
  assert.deepEqual(await rawLibrary(), before)
  await restoreLibrary(fixture, defaultChoices(preview))
  assert.deepEqual(await rawLibrary(), before)
})

test('restores same-name different-content games into a fresh database and retains original state timestamps', async () => {
  const fixture = await backupFixture()
  globalThis.indexedDB = new IDBFactory()
  const preview = await previewRestore(fixture)
  assert.ok(preview.games.every((entry) => !entry.local && !entry.missingRom))
  await restoreLibrary(fixture, defaultChoices(preview))
  const result = await getLibrarySnapshot(undefined, true)
  assert.deepEqual(result.games, fixture.games)
  assert.equal((await getGames()).length, 2)
})

test('restores only explicitly selected metadata, battery and slots, retaining every unselected record', async () => {
  const fixture = await backupFixture()
  const [first, second] = fixture.games
  await updateGame(first.game.id, { title: 'Keep this title', favorite: false })
  await setBatterySave(first.game.id, new Uint8Array([31]))
  await saveState(first.game.id, 0, new Uint8Array([32]))
  await saveState(first.game.id, 1, new Uint8Array([33]))
  await updateGame(second.game.id, { title: 'Other local title' })
  const before = await getLibrarySnapshot(undefined, true)
  const preview = await previewRestore(fixture)
  const choices: RestoreChoices = {
    fingerprint: preview.fingerprint,
    games: { [first.game.id]: { metadata: false, battery: true, slots: [1] } },
  }
  await restoreLibrary(fixture, choices)
  assert.equal(
    (await getGames()).find((game) => game.id === first.game.id)?.title,
    'Keep this title',
  )
  assert.deepEqual(await getBatterySave(first.game.id), first.battery)
  assert.deepEqual((await getState(first.game.id, 0))?.data, new Uint8Array([32]))
  assert.deepEqual(
    await getState(first.game.id, 1),
    first.states.find((state) => state.slot === 1),
  )
  assert.deepEqual(
    (await getLibrarySnapshot(undefined, true)).games.find(
      (entry) => entry.game.id === second.game.id,
    ),
    before.games.find((entry) => entry.game.id === second.game.id),
  )
  const next = await previewRestore(fixture)
  await restoreLibrary(fixture, {
    fingerprint: next.fingerprint,
    games: { [first.game.id]: { metadata: true, battery: false, slots: [] } },
  })
  assert.deepEqual(
    (await getGames()).find((game) => game.id === first.game.id),
    first.game,
  )
})

test('no-ROM restore creates cloud library entries and ROMs can be cached on demand', async () => {
  const full = await backupFixture()
  const fixture = structuredClone(full)
  for (const entry of fixture.games) delete entry.rom
  globalThis.indexedDB = new IDBFactory()
  const preview = await previewRestore(fixture)
  assert.ok(preview.games.every((entry) => entry.missingRom))
  await restoreLibrary(fixture, defaultChoices(preview))
  assert.equal((await getGames()).length, fixture.games.length)
  assert.equal(await getRom(fixture.games[0].game.id), undefined)
  assert.equal((await getLibrarySnapshot()).games[0].rom, undefined)

  const first = fixture.games[0]
  await cacheRom(first.game.id, full.games[0].rom!)
  assert.deepEqual(await getRom(first.game.id), full.games[0].rom)
  assert.deepEqual((await getLibrarySnapshot([first.game.id], true)).games, [full.games[0]])
  await assert.rejects(cacheRom(first.game.id, full.games[1].rom!), /不匹配/)

  globalThis.indexedDB = new IDBFactory()
  await assert.rejects(
    restoreLibrary(fixture, {
      fingerprint: (await previewRestore(fixture)).fingerprint,
      games: { [fixture.games[1].game.id]: { metadata: false, battery: true, slots: [] } },
    }),
    /游戏信息/,
  )
})

test('no-ROM backup restores progress to an already imported matching ROM', async () => {
  const fixture = await backupFixture()
  const first = fixture.games[0]
  const bytes = first.rom!
  fixture.games = [{ ...first, rom: undefined }]
  globalThis.indexedDB = new IDBFactory()
  await importGame(new File([bytes], 'Renamed.gba'))
  const preview = await previewRestore(fixture)
  assert.equal(preview.games[0].missingRom, false)
  assert.equal(preview.games[0].defaults.metadata, false)
  await restoreLibrary(fixture, defaultChoices(preview))
  assert.equal((await getGames())[0].filename, 'Renamed.gba')
  assert.deepEqual(await getBatterySave(first.game.id), first.battery)
  assert.deepEqual(await getStates(first.game.id), first.states)
})

test('rejects a no-ROM backup that reuses a local content ID for another platform', async () => {
  const game = await importGame(rom('Collision.gba', 4, 32 * 1024))
  await setBatterySave(game.id, new Uint8Array([7]))
  const fixture = await getLibrarySnapshot([game.id])
  const validPreview = await previewRestore(fixture)
  const spoofed = structuredClone(fixture)
  spoofed.games[0].game = {
    ...spoofed.games[0].game,
    filename: 'Collision.gb',
    platform: 'gb',
  }
  const before = await rawLibrary()

  await assert.rejects(previewRestore(spoofed), /游戏平台.*不一致/)
  await assert.rejects(
    restoreLibrary(spoofed, {
      fingerprint: validPreview.fingerprint,
      games: { [game.id]: { metadata: true, battery: true, slots: [] } },
    }),
    /游戏平台.*不一致/,
  )
  assert.deepEqual(await rawLibrary(), before)
})

test('old and different-core states default to excluded and require explicit slot choices', async () => {
  const fixture = await backupFixture()
  fixture.games = [fixture.games[0]]
  delete fixture.games[0].states[0].coreVersion
  fixture.games[0].states[1].coreVersion = 'other-core'
  globalThis.indexedDB = new IDBFactory()
  const preview = await previewRestore(fixture)
  assert.ok(preview.games[0].states.every((state) => state.incompatible))
  assert.deepEqual(preview.games[0].defaults.slots, [])
  await restoreLibrary(fixture, defaultChoices(preview))
  const id = fixture.games[0].game.id
  assert.deepEqual(await getStates(id), [])
  const secondPreview = await previewRestore(fixture)
  await restoreLibrary(fixture, {
    fingerprint: secondPreview.fingerprint,
    games: { [id]: { metadata: false, battery: false, slots: [0, 1] } },
  })
  assert.deepEqual(await getStates(id), fixture.games[0].states)
  assert.equal((await getLibrarySnapshot([id])).games[0].states[0].coreVersion, undefined)
})

test('rejects invalid identity, versions, references and selections without changing storage', async () => {
  const fixture = await backupFixture()
  const before = await rawLibrary()
  const preview = await previewRestore(fixture)
  const wrongHash = structuredClone(fixture)
  wrongHash.games[0].rom![0] ^= 1
  await assert.rejects(previewRestore(wrongHash), /内容标识/)
  await assert.rejects(restoreLibrary(wrongHash, defaultChoices(preview)), /内容标识/)
  await assert.rejects(
    previewRestore({ ...fixture, formatVersion: 2 } as unknown as BackupData),
    /版本/,
  )
  const wrongReference = structuredClone(fixture)
  wrongReference.games[0].states[0].gameId = fixture.games[1].game.id
  await assert.rejects(previewRestore(wrongReference), /存档信息/)
  const id = fixture.games[0].game.id
  await assert.rejects(
    restoreLibrary(fixture, {
      fingerprint: preview.fingerprint,
      games: { [id]: { metadata: false, battery: false, slots: [5] } },
    }),
    /无效的存档/,
  )
  await assert.rejects(
    restoreLibrary(fixture, {
      fingerprint: preview.fingerprint,
      games: { unknown: { metadata: true, battery: false, slots: [] } },
    }),
    /未知游戏/,
  )
  assert.deepEqual(await rawLibrary(), before)
})

test('rejects stale preview after metadata or byte-only changes, then permits re-preview', async () => {
  const fixture = await backupFixture()
  const first = fixture.games[0]
  let preview = await previewRestore(fixture)
  await updateGame(first.game.id, { title: 'Changed after preview' })
  const before = await rawLibrary()
  await assert.rejects(restoreLibrary(fixture, defaultChoices(preview)), /重新预览/)
  assert.deepEqual(await rawLibrary(), before)
  preview = await previewRestore(fixture)
  await setBatterySave(first.game.id, new Uint8Array([55]))
  await assert.rejects(restoreLibrary(fixture, defaultChoices(preview)), /重新预览/)
  preview = await previewRestore(fixture)
  const choices = defaultChoices(preview)
  choices.games[first.game.id].battery = true
  await restoreLibrary(fixture, choices)
  assert.deepEqual(await getBatterySave(first.game.id), first.battery)
})

for (const failure of ['quota', 'request', 'abort'] as const) {
  test(`rolls back all four tables when a middle restore write encounters ${failure}, and retry succeeds`, async () => {
    const fixture = await backupFixture()
    for (const entry of fixture.games) {
      await updateGame(entry.game.id, { title: 'Local metadata' })
      await setBatterySave(entry.game.id, new Uint8Array([66]))
    }
    const before = await rawLibrary()
    const preview = await previewRestore(fixture)
    const choices = defaultChoices(preview)
    for (const entry of fixture.games)
      choices.games[entry.game.id] = { metadata: true, battery: true, slots: [0, 1] }
    const original = IDBObjectStore.prototype.put
    let writes = 0
    IDBObjectStore.prototype.put = function (value, key) {
      writes++
      if (writes === 3) {
        if (failure === 'quota') throw new DOMException('Disk full', 'QuotaExceededError')
        if (failure === 'request') return this.add(value, key)
        const request = original.call(this, value, key)
        request.addEventListener('success', () => this.transaction.abort())
        return request
      }
      return original.call(this, value, key)
    }
    try {
      await assert.rejects(
        restoreLibrary(fixture, choices),
        failure === 'quota' ? /空间不足/ : /读写失败|取消/,
      )
    } finally {
      IDBObjectStore.prototype.put = original
    }
    assert.equal(writes, 3)
    assert.deepEqual(await rawLibrary(), before)
    await restoreLibrary(fixture, choices)
    assert.deepEqual((await getLibrarySnapshot(undefined, true)).games, fixture.games)
  })
}

test('detaches backup buffers and choices before asynchronous work', async () => {
  const fixture = await backupFixture()
  globalThis.indexedDB = new IDBFactory()
  const preview = await previewRestore(fixture)
  const choices = defaultChoices(preview)
  const expected = structuredClone(fixture)
  const pending = restoreLibrary(fixture, choices)
  fixture.games[0].battery![0] = 88
  fixture.games[0].rom![0] = 99
  choices.games[fixture.games[0].game.id].slots.length = 0
  await pending
  assert.deepEqual((await getLibrarySnapshot(undefined, true)).games, expected.games)
})

test('rechecks the library within the write transaction if another tab writes after preflight hashing', async () => {
  const fixture = await backupFixture()
  const first = fixture.games[0]
  const preview = await previewRestore(fixture)
  const choices = defaultChoices(preview)
  choices.games[first.game.id].battery = true
  choices.games[first.game.id].metadata = true
  const original = IDBDatabase.prototype.transaction
  let injected = false
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    if (!injected && mode === 'readwrite') {
      injected = true
      const racing = original.call(this, ['batteries'], 'readwrite')
      racing.objectStore('batteries').put({ gameId: first.game.id, data: new Uint8Array([101]) })
    }
    return original.call(this, stores, mode, options)
  }
  try {
    await assert.rejects(restoreLibrary(fixture, choices), /重新预览/)
  } finally {
    IDBDatabase.prototype.transaction = original
  }
  assert.equal(injected, true)
  assert.deepEqual(await getBatterySave(first.game.id), new Uint8Array([101]))
  assert.deepEqual(
    (await getGames()).find((game) => game.id === first.game.id),
    first.game,
  )
})

test('rechecks platform identity within the write transaction', async () => {
  const game = await importGame(rom('Race.gba', 5, 32 * 1024))
  await setBatterySave(game.id, new Uint8Array([7]))
  const fixture = await getLibrarySnapshot([game.id])
  await setBatterySave(game.id, new Uint8Array([99]))
  const preview = await previewRestore(fixture)
  const original = IDBDatabase.prototype.transaction
  let injected = false
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    if (!injected && mode === 'readwrite') {
      injected = true
      const racing = original.call(this, ['games'], 'readwrite')
      racing.objectStore('games').put({ ...game, filename: 'Race.gb', platform: 'gb' })
    }
    return original.call(this, stores, mode, options)
  }
  try {
    await assert.rejects(
      restoreLibrary(fixture, {
        fingerprint: preview.fingerprint,
        games: { [game.id]: { metadata: false, battery: true, slots: [] } },
      }),
      /游戏平台.*不一致/,
    )
  } finally {
    IDBDatabase.prototype.transaction = original
  }
  assert.equal(injected, true)
  assert.deepEqual(await getBatterySave(game.id), new Uint8Array([99]))
})

test('snapshot metadata and battery share the same read transaction during a concurrent update', async () => {
  const fixture = await backupFixture()
  const first = fixture.games[0]
  const original = IDBDatabase.prototype.transaction
  let pending: Promise<void> | undefined
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    const snapshot = original.call(this, stores, mode, options)
    if (!pending && mode === 'readonly') {
      const update = original.call(this, ['games', 'batteries'], 'readwrite')
      update.objectStore('games').put({ ...first.game, title: 'Concurrent title' })
      update.objectStore('batteries').put({ gameId: first.game.id, data: new Uint8Array([102]) })
      pending = new Promise((resolve, reject) => {
        update.oncomplete = () => resolve()
        update.onabort = () => reject(update.error)
      })
    }
    return snapshot
  }
  let result: BackupData
  try {
    result = await getLibrarySnapshot([first.game.id])
    await pending
  } finally {
    IDBDatabase.prototype.transaction = original
  }
  assert.deepEqual(result.games[0].game, first.game)
  assert.deepEqual(result.games[0].battery, first.battery)
  assert.equal(
    (await getGames()).find((game) => game.id === first.game.id)?.title,
    'Concurrent title',
  )
  assert.deepEqual(await getBatterySave(first.game.id), new Uint8Array([102]))
})

test('omitting ROM uses key reads and declared ROM and game-count limits reject before payload reads', async () => {
  const fixture = await backupFixture()
  const original = IDBObjectStore.prototype.get
  let romReads = 0
  IDBObjectStore.prototype.get = function (query) {
    if (this.name === 'roms') romReads++
    return original.call(this, query)
  }
  try {
    await getLibrarySnapshot()
  } finally {
    IDBObjectStore.prototype.get = original
  }
  assert.equal(romReads, 0)
  await assert.rejects(
    getLibrarySnapshot(Array.from({ length: 17 }, (_, index) => `id-${index}`)),
    /最多选择 16/,
  )
  const third = await importGame(rom('Third.gba', 3))
  for (const game of [...fixture.games.map((entry) => entry.game), third])
    await corrupt('games', { ...game, size: 32 * 1024 * 1024 })
  IDBObjectStore.prototype.get = function (query) {
    if (this.name === 'roms') romReads++
    return original.call(this, query)
  }
  try {
    await assert.rejects(getLibrarySnapshot(undefined, true), /ROM 总大小超过 64 MiB/)
  } finally {
    IDBObjectStore.prototype.get = original
  }
  assert.equal(romReads, 0)
})

test('battery-only restoration persistently suppresses an older auto state without deleting it', async () => {
  const fixture = await backupFixture()
  const first = fixture.games[0]
  await updateGame(first.game.id, { title: 'Local title' })
  await setBatterySave(first.game.id, new Uint8Array([110]))
  const oldState = await saveState(first.game.id, 0, new Uint8Array([111]))
  const preview = await previewRestore(fixture)
  await restoreLibrary(fixture, {
    fingerprint: preview.fingerprint,
    games: { [first.game.id]: { metadata: false, battery: true, slots: [] } },
  })
  // getGames opens a fresh connection, as it does after a page reload.
  const game = (await getGames()).find((game) => game.id === first.game.id)!
  assert.equal(game.skipAutoState, true)
  assert.equal(game.title, 'Local title')
  assert.deepEqual(await getBatterySave(first.game.id), first.battery)
  assert.deepEqual(await getState(first.game.id, 0), oldState)
  assert.equal((await getLibrarySnapshot([first.game.id])).games[0].game.skipAutoState, true)
  await saveState(first.game.id, 1, new Uint8Array([112]))
  assert.equal((await getGames()).find((game) => game.id === first.game.id)?.skipAutoState, true)
  await saveState(first.game.id, 0, new Uint8Array([113]))
  assert.equal((await getGames()).find((game) => game.id === first.game.id)?.skipAutoState, false)
})

test('restoring automatic state uses the selected backup metadata flag and otherwise clears suppression', async () => {
  const fixture = await backupFixture()
  const first = fixture.games[0]
  first.game.skipAutoState = true
  let preview = await previewRestore(fixture)
  await restoreLibrary(fixture, {
    fingerprint: preview.fingerprint,
    games: { [first.game.id]: { metadata: true, battery: true, slots: [0] } },
  })
  assert.equal((await getGames()).find((game) => game.id === first.game.id)?.skipAutoState, true)
  preview = await previewRestore(fixture)
  await restoreLibrary(fixture, {
    fingerprint: preview.fingerprint,
    games: { [first.game.id]: { metadata: false, battery: false, slots: [0] } },
  })
  assert.equal((await getGames()).find((game) => game.id === first.game.id)?.skipAutoState, false)
  first.game.skipAutoState = false
  preview = await previewRestore(fixture)
  await restoreLibrary(fixture, {
    fingerprint: preview.fingerprint,
    games: { [first.game.id]: { metadata: true, battery: true, slots: [] } },
  })
  assert.equal(
    (await getGames()).find((game) => game.id === first.game.id)?.skipAutoState,
    true,
    'battery without auto state takes precedence over the backup metadata flag',
  )
  preview = await previewRestore(fixture)
  await restoreLibrary(fixture, {
    fingerprint: preview.fingerprint,
    games: { [first.game.id]: { metadata: true, battery: false, slots: [0] } },
  })
  assert.equal((await getGames()).find((game) => game.id === first.game.id)?.skipAutoState, false)
  delete first.game.skipAutoState
  preview = await previewRestore(fixture)
  await restoreLibrary(fixture, {
    fingerprint: preview.fingerprint,
    games: { [first.game.id]: { metadata: true, battery: false, slots: [0] } },
  })
  assert.equal(
    (await getGames()).find((game) => game.id === first.game.id)?.skipAutoState ?? false,
    false,
    'legacy metadata defaults to normal auto-state loading',
  )
})

test('saving slot zero rolls back both the state and its suppression flag if metadata writing fails', async () => {
  const game = await importGame(rom())
  await saveState(game.id, 0, new Uint8Array([120]))
  await updateGame(game.id, { skipAutoState: true })
  const before = await rawLibrary()
  const original = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === 'games') throw new DOMException('Full', 'QuotaExceededError')
    return original.call(this, value, key)
  }
  try {
    await assert.rejects(saveState(game.id, 0, new Uint8Array([121])), /空间不足/)
  } finally {
    IDBObjectStore.prototype.put = original
  }
  assert.deepEqual(await rawLibrary(), before)
})

test('storage summaries count records without reading payloads', async () => {
  const fixture = await backupFixture()
  const originalGet = IDBObjectStore.prototype.get
  const originalGetAll = IDBObjectStore.prototype.getAll
  IDBObjectStore.prototype.get = function () {
    throw new Error('Payload get is forbidden for summaries')
  }
  IDBObjectStore.prototype.getAll = function () {
    throw new Error('Payload getAll is forbidden for summaries')
  }
  try {
    assert.deepEqual(await getStorageSummary(fixture.games[0].game.id), {
      states: 2,
      battery: true,
    })
    assert.deepEqual(await getStorageSummary('missing'), { states: 0, battery: false })
  } finally {
    IDBObjectStore.prototype.get = originalGet
    IDBObjectStore.prototype.getAll = originalGetAll
  }
})
