import { Inflate } from 'fflate'
import {
  PLATFORM_REGISTRY,
  platformFromFilename,
  ROM_FILE_EXTENSIONS,
  type GamePlatform,
} from './platforms.ts'

const MiB = 1024 * 1024
const MAX_ARCHIVE_SIZE = 64 * MiB
const MAX_TOTAL_SIZE = 128 * MiB
const MAX_ROM_COUNT = 32
const ZIP_ERROR = 'ZIP 文件已损坏或格式不完整，请重新压缩后导入。'
const ROM_TYPES = ROM_FILE_EXTENSIONS.join('、')
const ZIP64_ERROR = '暂不支持 ZIP64 压缩包，请解压后导入游戏 ROM，或使用普通 ZIP 重新压缩。'

export function importableRomFiles(files: Iterable<File>): File[] {
  return Array.from(files).filter((file) => {
    const path = file.webkitRelativePath || file.name
    const parts = path.replaceAll('\\', '/').split('/')
    if (file.name.startsWith('._') || parts.some((part) => part.toLowerCase() === '__macosx'))
      return false
    return Boolean(platformFromFilename(file.name)) || /\.zip$/i.test(file.name)
  })
}

interface RomEntry {
  name: string
  platform: GamePlatform
  flags: number
  method: number
  checksum: number
  compressedSize: number
  size: number
  offset: number
  rawName: Uint8Array
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(bytes: Uint8Array, previous: number): number {
  let crc = previous
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return crc
}

function formatSize(size: number): string {
  if (size >= MiB && size % MiB === 0) return `${size / MiB} MiB`
  if (size >= 1024 && size % 1024 === 0) return `${size / 1024} KiB`
  return `${size} 字节`
}

function decodeName(bytes: Uint8Array, flags: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    if (flags & 0x800) throw new Error(ZIP_ERROR)
    // Legacy ZIP encodings still preserve ASCII extensions and path separators.
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  }
}

function checkExtra(bytes: Uint8Array, start: number, size: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = start + size
  while (start < end) {
    if (start + 4 > end) throw new Error(ZIP_ERROR)
    const tag = view.getUint16(start, true)
    const length = view.getUint16(start + 2, true)
    if (tag === 1) throw new Error(ZIP64_ERROR)
    start += 4 + length
    if (start > end) throw new Error(ZIP_ERROR)
  }
}

function readDirectory(bytes: Uint8Array): { entries: RomEntry[]; directoryOffset: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  // A ZIP comment is at most 65,535 bytes; its length must reach the real EOF.
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error(ZIP_ERROR)
  const count = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryOffset = view.getUint32(end + 16, true)
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50)
  )
    throw new Error(ZIP64_ERROR)
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count
  ) {
    throw new Error('暂不支持分卷 ZIP，请合并压缩包后导入，或直接导入游戏 ROM。')
  }
  const directoryEnd = directoryOffset + directorySize
  if (directoryEnd !== end) throw new Error(ZIP_ERROR)
  let cursor = directoryOffset
  let totalSize = 0
  const entries: RomEntry[] = []
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error(ZIP_ERROR)
    const flags = view.getUint16(cursor + 8, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > directoryEnd) throw new Error(ZIP_ERROR)
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const path = decodeName(rawName, flags).replaceAll('\\', '/')
    const parts = path.split('/')
    const name = parts.at(-1) ?? ''
    const platform = platformFromFilename(name)
    // Never inflate documents, nested archives, directories, or macOS resource forks.
    if (
      platform &&
      !name.startsWith('._') &&
      !parts.some((part) => part.toLowerCase() === '__macosx')
    ) {
      if (flags & 0x2041) throw new Error(`「${name}」已加密，请先用密码解压，再导入游戏 ROM。`)
      const method = view.getUint16(cursor + 10, true)
      if (method !== 0 && method !== 8)
        throw new Error(`「${name}」使用了暂不支持的 ZIP 压缩方式，请解压后导入游戏 ROM。`)
      const checksum = view.getUint32(cursor + 16, true)
      const compressedSize = view.getUint32(cursor + 20, true)
      const size = view.getUint32(cursor + 24, true)
      const offset = view.getUint32(cursor + 42, true)
      if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff)
        throw new Error(ZIP64_ERROR)
      checkExtra(bytes, cursor + 46 + nameLength, extraLength)
      if (view.getUint16(cursor + 34, true) !== 0)
        throw new Error('暂不支持分卷 ZIP，请解压后导入游戏 ROM。')
      const { label, minRomSize, maxRomSize } = PLATFORM_REGISTRY[platform]
      if (size < minRomSize || size > maxRomSize)
        throw new Error(
          `「${name}」大小无效，每个 ${label} ROM 须为 ${formatSize(minRomSize)}至 ${formatSize(maxRomSize)}。`,
        )
      if (entries.length >= MAX_ROM_COUNT)
        throw new Error('一个 ZIP 最多导入 32 个游戏，请拆分压缩包后重试。')
      totalSize += size
      if (totalSize > MAX_TOTAL_SIZE)
        throw new Error('ZIP 内游戏解压后的总大小不能超过 128 MiB，请拆分压缩包后重试。')
      entries.push({
        name,
        platform,
        flags,
        method,
        checksum,
        compressedSize,
        size,
        offset,
        rawName,
      })
    }
    cursor = next
  }
  if (cursor !== directoryEnd) throw new Error(ZIP_ERROR)
  if (!entries.length)
    throw new Error(
      `ZIP 中没有找到 ${ROM_TYPES} 游戏文件，请选择包含游戏 ROM 的压缩包；不支持压缩包内再嵌套 ZIP。`,
    )
  return { entries, directoryOffset }
}

async function extractEntry(
  bytes: Uint8Array,
  entry: RomEntry,
  directoryOffset: number,
): Promise<File> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const { offset, name, platform, flags, compressedSize, size } = entry
  if (offset + 30 > directoryOffset || view.getUint32(offset, true) !== 0x04034b50)
    throw new Error(ZIP_ERROR)
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  const dataStart = offset + 30 + nameLength + extraLength
  const dataEnd = dataStart + compressedSize
  if (
    dataStart > directoryOffset ||
    dataEnd > directoryOffset ||
    view.getUint16(offset + 6, true) !== flags ||
    view.getUint16(offset + 8, true) !== entry.method ||
    nameLength !== entry.rawName.length ||
    !entry.rawName.every((byte, index) => byte === bytes[offset + 30 + index])
  )
    throw new Error(ZIP_ERROR)
  checkExtra(bytes, offset + 30 + nameLength, extraLength)
  // Data descriptors put CRC/sizes after the payload, so central-directory values take precedence.
  if (
    !(flags & 8) &&
    (view.getUint32(offset + 14, true) !== entry.checksum ||
      view.getUint32(offset + 18, true) !== compressedSize ||
      view.getUint32(offset + 22, true) !== size)
  )
    throw new Error(ZIP_ERROR)
  let written = 0
  let crc = -1
  const output = new Uint8Array(size)
  const maxSize = PLATFORM_REGISTRY[platform].maxRomSize
  const accept = (chunk: Uint8Array) => {
    if (written + chunk.length > size || written + chunk.length > maxSize) {
      throw new Error(
        `「${name}」实际解压大小超出声明或 ${maxSize / MiB} MiB 限制，请检查压缩包后重试。`,
      )
    }
    crc = crc32(chunk, crc)
    output.set(chunk, written)
    written += chunk.length
  }
  try {
    if (entry.method === 0) accept(bytes.subarray(dataStart, dataEnd))
    else {
      const inflate = new Inflate(accept)
      // Small compressed chunks bound transient expansion too, even if ZIP headers lie.
      const chunkSize = 4096
      for (let cursor = dataStart; cursor < dataEnd; cursor += chunkSize) {
        const end = Math.min(cursor + chunkSize, dataEnd)
        inflate.push(bytes.subarray(cursor, end), end === dataEnd)
        if ((cursor - dataStart) % (256 * 1024) === 0)
          await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('实际解压大小')) throw error
    throw new Error(`「${name}」解压失败，文件可能已损坏，请重新压缩后导入。`, { cause: error })
  }
  if (written !== size || (crc ^ -1) >>> 0 !== entry.checksum) {
    throw new Error(`「${name}」完整性校验失败，文件可能已损坏，请重新获取或压缩后导入。`)
  }
  return new File([output], name, { type: 'application/octet-stream' })
}

/** Expand one selected file without storing it; callers import each yielded ROM normally. */
export async function* extractRomFiles(file: File): AsyncGenerator<File> {
  if (platformFromFilename(file.name)) {
    yield file
    return
  }
  if (!/\.zip$/i.test(file.name)) throw new Error(`请选择 ${ROM_TYPES} 游戏文件或 .zip 压缩包。`)
  if (file.size > MAX_ARCHIVE_SIZE)
    throw new Error('ZIP 压缩包不能超过 64 MiB，请拆分压缩包或直接导入游戏 ROM。')
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (error) {
    throw new Error('无法读取 ZIP 文件，请重新选择文件后重试。', { cause: error })
  }
  const { entries, directoryOffset } = readDirectory(bytes)
  for (const entry of entries) yield await extractEntry(bytes, entry, directoryOffset)
}
