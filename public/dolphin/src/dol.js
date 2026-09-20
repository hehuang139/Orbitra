const DOL_HEADER_SIZE = 0x100;
const TEXT_SECTION_COUNT = 7;
const DATA_SECTION_COUNT = 11;

export function parseDolHeader(bytes) {
  const view = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.byteLength < DOL_HEADER_SIZE) {
    throw new Error("Boot DOL header is incomplete");
  }

  const textSections = readSections(view, 0x00, 0x48, 0x90, TEXT_SECTION_COUNT, "text");
  const dataSections = readSections(view, 0x1c, 0x64, 0xac, DATA_SECTION_COUNT, "data");
  const sections = [...textSections, ...dataSections].filter((section) => section.size > 0);

  return {
    entryPoint: readU32(view, 0xe0),
    bssAddress: readU32(view, 0xd8),
    bssSize: readU32(view, 0xdc),
    textSections,
    dataSections,
    loadSections: sections,
    totalLoadBytes: sections.reduce((total, section) => total + section.size, 0)
  };
}

function readSections(view, fileOffsetBase, addressBase, sizeBase, count, kind) {
  const sections = [];

  for (let index = 0; index < count; index += 1) {
    sections.push({
      kind,
      index,
      fileOffset: readU32(view, fileOffsetBase + index * 4),
      address: readU32(view, addressBase + index * 4),
      size: readU32(view, sizeBase + index * 4)
    });
  }

  return sections;
}

function readU32(view, offset) {
  return view.getUint32(offset, false);
}
