/** Minimal public-domain-style fixtures generated from documented cartridge formats. */

export function createNesTestRom() {
  const header = Uint8Array.from([
    0x4e,
    0x45,
    0x53,
    0x1a, // iNES magic
    0x01, // one 16 KiB PRG bank
    0x01, // one 8 KiB CHR bank
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ])
  const prg = new Uint8Array(16 * 1024).fill(0xea)
  const code = Uint8Array.from([
    0x78, // SEI
    0xd8, // CLD
    0xa2,
    0xff, // LDX #$ff
    0x9a, // TXS
    0xe8, // INX -> 0
    0x8e,
    0x00,
    0x20, // STX $2000
    0x8e,
    0x01,
    0x20, // STX $2001
    0x2c,
    0x02,
    0x20, // BIT $2002
    0x10,
    0xfb, // BPL wait-vblank
    0xa9,
    0x3f,
    0x8d,
    0x06,
    0x20, // PPUADDR $3f00
    0xa9,
    0x00,
    0x8d,
    0x06,
    0x20,
    0xa9,
    0x21,
    0x8d,
    0x07,
    0x20, // blue backdrop
    0x4c,
    0x20,
    0x80, // JMP $8020
  ])
  prg.set(code)
  for (const offset of [0x3ffa, 0x3ffc, 0x3ffe]) {
    prg[offset] = 0x00
    prg[offset + 1] = 0x80
  }
  const chr = new Uint8Array(8 * 1024)
  const result = new Uint8Array(header.length + prg.length + chr.length)
  result.set(header)
  result.set(prg, header.length)
  result.set(chr, header.length + prg.length)
  return result
}

export function createSnesTestRom() {
  const rom = new Uint8Array(32 * 1024).fill(0xea)
  rom.set(
    Uint8Array.from([
      0x78, // SEI
      0x18, // CLC
      0xfb, // XCE (native mode)
      0xc2,
      0x30, // REP #$30 (16-bit A/X/Y)
      0xa2,
      0xff,
      0x1f, // LDX #$1fff
      0x9a, // TXS
      0xe2,
      0x20, // SEP #$20 (8-bit A)
      0xa9,
      0x80,
      0x8d,
      0x00,
      0x21, // forced blank
      0x9c,
      0x00,
      0x42, // disable interrupts
      0x9c,
      0x21,
      0x21, // CGRAM address 0
      0xa9,
      0x1f,
      0x8d,
      0x22,
      0x21, // red backdrop, low byte
      0x9c,
      0x22,
      0x21, // red backdrop, high byte
      0xa9,
      0x0f,
      0x8d,
      0x00,
      0x21, // display on, full brightness
      0x80,
      0xfe, // BRA forever
    ]),
  )

  const header = 0x7fc0
  const title = new TextEncoder().encode('ADVANCE SNES TEST    ')
  rom.set(title.subarray(0, 21), header)
  rom[header + 0x15] = 0x20 // LoROM, slow ROM
  rom[header + 0x16] = 0x00 // ROM only
  rom[header + 0x17] = 0x05 // 32 KiB
  rom[header + 0x18] = 0x00 // no cartridge RAM
  rom[header + 0x19] = 0x01 // NTSC
  rom[header + 0x1a] = 0x33 // extended developer ID
  rom[header + 0x1b] = 0x00
  for (const offset of [
    0x7fe4, 0x7fe6, 0x7fe8, 0x7fea, 0x7fee, 0x7ff4, 0x7ff8, 0x7ffa, 0x7ffc, 0x7ffe,
  ]) {
    rom[offset] = 0x00
    rom[offset + 1] = 0x80
  }
  let checksum = 0x1fe
  for (let index = 0; index < rom.length; index++) {
    if (index < header + 0x1c || index > header + 0x1f) checksum = (checksum + rom[index]) & 0xffff
  }
  const complement = checksum ^ 0xffff
  rom[header + 0x1c] = complement & 0xff
  rom[header + 0x1d] = complement >>> 8
  rom[header + 0x1e] = checksum & 0xff
  rom[header + 0x1f] = checksum >>> 8
  return rom
}
