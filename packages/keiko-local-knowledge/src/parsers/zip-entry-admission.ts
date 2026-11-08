import { Buffer, isUtf8 } from "node:buffer";
import yauzl from "yauzl";
import { regularZipEntry } from "../zip-entry-kind.js";

export interface StrictZipLayout {
  readonly bytes: Buffer;
  readonly centralOffset: number;
  nextOffset: number;
}
const malformed = (): Error =>
  new Error("archive entry representation is ambiguous or unsupported");
/** The library exposes this cursor as a number; its third-party declaration incorrectly says boolean. */
export function strictZipLayout(zip: yauzl.ZipFile, bytes: Uint8Array): StrictZipLayout {
  const cursor: unknown = Reflect.get(zip, "readEntryCursor");
  if (
    typeof cursor !== "number" ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > bytes.length
  )
    throw malformed();
  return { bytes: Buffer.from(bytes), centralOffset: cursor, nextOffset: 0 };
}
function rawName(entry: yauzl.Entry): boolean {
  if (!isUtf8(entry.fileNameRaw) || entry.fileNameRaw.toString("utf8") !== entry.fileName)
    return false;
  // ASCII is the common subset when no UTF-8 flag is present; never guess CP437/Unicode aliases.
  return (
    (entry.generalPurposeBitFlag & 0x800) !== 0 || entry.fileNameRaw.every((byte) => byte < 128)
  );
}
function supported(entry: yauzl.Entry): boolean {
  return (
    regularZipEntry(entry) &&
    !entry.isEncrypted() &&
    rawName(entry) &&
    (entry.generalPurposeBitFlag & ~0x80e) === 0 &&
    (entry.compressionMethod === 0 || entry.compressionMethod === 8) &&
    !entry.extraFields.some((field) => field.id === 0x7075 || field.id === 0x0001)
  );
}
function localMatches(entry: yauzl.Entry, local: yauzl.LocalFileHeader): boolean {
  return (
    local.fileName.equals(entry.fileNameRaw) &&
    local.generalPurposeBitFlag === entry.generalPurposeBitFlag &&
    local.compressionMethod === entry.compressionMethod &&
    !yauzl
      .parseExtraFields(local.extraField)
      .some((field) => field.id === 0x7075 || field.id === 0x0001)
  );
}
function descriptorEnd(layout: StrictZipLayout, entry: yauzl.Entry, offset: number): number {
  const bytes = layout.bytes;
  if (offset + 12 > layout.centralOffset) throw malformed();
  const body = bytes.readUInt32LE(offset) === 0x08074b50 ? offset + 4 : offset;
  if (body + 12 > layout.centralOffset) throw malformed();
  if (
    bytes.readUInt32LE(body) !== entry.crc32 ||
    bytes.readUInt32LE(body + 4) !== entry.compressedSize ||
    bytes.readUInt32LE(body + 8) !== entry.uncompressedSize
  )
    throw malformed();
  return body + 12;
}
function localSizes(entry: yauzl.Entry, local: yauzl.LocalFileHeader): boolean {
  return (
    local.crc32 === entry.crc32 &&
    local.compressedSize === entry.compressedSize &&
    local.uncompressedSize === entry.uncompressedSize
  );
}
function deferredSizes(entry: yauzl.Entry, local: yauzl.LocalFileHeader): boolean {
  return (
    (local.crc32 === 0 || local.crc32 === entry.crc32) &&
    (local.compressedSize === 0 || local.compressedSize === entry.compressedSize) &&
    (local.uncompressedSize === 0 || local.uncompressedSize === entry.uncompressedSize)
  );
}
/** Tighten only explicitly opted-in native ZIP submission, through the same library header reader. */
export async function admitStrictZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  layout: StrictZipLayout,
): Promise<void> {
  if (!supported(entry) || entry.relativeOffsetOfLocalHeader !== layout.nextOffset)
    throw malformed();
  const local = await zip.readLocalFileHeaderPromise(entry);
  if (!localMatches(entry, local)) throw malformed();
  const end = local.fileDataStart + entry.compressedSize;
  if (!Number.isSafeInteger(end) || end > layout.centralOffset) throw malformed();
  if ((entry.generalPurposeBitFlag & 8) !== 0) {
    if (!deferredSizes(entry, local)) throw malformed();
    layout.nextOffset = descriptorEnd(layout, entry, end);
  } else {
    if (!localSizes(entry, local)) throw malformed();
    layout.nextOffset = end;
  }
}
export function completeStrictZipLayout(layout: StrictZipLayout): boolean {
  return layout.nextOffset === layout.centralOffset;
}
