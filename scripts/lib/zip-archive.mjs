import { Buffer } from "node:buffer";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
  statSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const ZIP_VERSION = 20;
const UNIX_VERSION = (3 << 8) | ZIP_VERSION;
const MAX_ZIP32 = 0xffffffff;
const DOS_EPOCH_DATE = 0x0021;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function normalizedEntryName(name, allowUnsafeEntryNames) {
  const normalized = name.replaceAll("\\", "/").replace(/^\.\//u, "");
  const segments = new Set(normalized.split("/"));
  const unsafe =
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.includes("\u0000") ||
    segments.has("..") ||
    segments.has("");
  if (unsafe && allowUnsafeEntryNames !== true) {
    throw new Error(`ZIP entry name is unsafe: ${name}`);
  }
  return normalized;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareDirectoryEntries(left, right) {
  return compareCodeUnits(left.name, right.name);
}

function assertZip32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ZIP32) {
    throw new Error(`${label} exceeds the supported ZIP32 range`);
  }
}

function localHeader(entry, compressedSize) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(DEFLATE_METHOD, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(DOS_EPOCH_DATE, 12);
  header.writeUInt32LE(entry.checksum, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(entry.data.byteLength, 22);
  header.writeUInt16LE(entry.nameBytes.byteLength, 26);
  return header;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
  header.writeUInt16LE(UNIX_VERSION, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(DEFLATE_METHOD, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(DOS_EPOCH_DATE, 14);
  header.writeUInt32LE(entry.checksum, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.data.byteLength, 24);
  header.writeUInt16LE(entry.nameBytes.byteLength, 28);
  header.writeUInt32LE((entry.mode & 0xffff) * 0x10000, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function endRecord(entryCount, centralSize, centralOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return end;
}

function writeBuffer(fd, buffer, state) {
  writeSync(fd, buffer);
  state.offset += buffer.byteLength;
  assertZip32(state.offset, "ZIP archive offset");
}

function prepareEntry(record, options) {
  const name = normalizedEntryName(record.name, options.allowUnsafeEntryNames);
  const data = Buffer.isBuffer(record.data) ? record.data : Buffer.from(record.data);
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.byteLength > 0xffff) throw new Error(`ZIP entry name is too long: ${name}`);
  assertZip32(data.byteLength, `ZIP entry ${name} size`);
  return { name, nameBytes, data, mode: record.mode ?? 0o100644, checksum: crc32(data) };
}

function writeEntries(fd, records, options, state) {
  const centralEntries = [];
  for (const record of records) {
    const entry = prepareEntry(record, options);
    const compressed = deflateRawSync(entry.data, { level: 9 });
    assertZip32(compressed.byteLength, `ZIP entry ${entry.name} compressed size`);
    const offset = state.offset;
    writeBuffer(fd, localHeader(entry, compressed.byteLength), state);
    writeBuffer(fd, entry.nameBytes, state);
    writeBuffer(fd, compressed, state);
    centralEntries.push({ ...entry, compressedSize: compressed.byteLength, offset });
  }
  return centralEntries;
}

function writeCentralDirectory(fd, entries, state) {
  const centralOffset = state.offset;
  for (const entry of entries) {
    writeBuffer(fd, centralHeader(entry), state);
    writeBuffer(fd, entry.nameBytes, state);
  }
  const centralSize = state.offset - centralOffset;
  if (entries.length > 0xffff) throw new Error("ZIP archive has too many entries for ZIP32");
  writeBuffer(fd, endRecord(entries.length, centralSize, centralOffset), state);
}

function cleanupFailedArchive(fd, temporaryPath, descriptorOpen) {
  const failures = [];
  if (descriptorOpen) {
    try {
      closeSync(fd);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    rmSync(temporaryPath, { force: true });
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

function symlinkDirectoryEntry(absolutePath, archiveName, options, stat) {
  if (options.preserveSymlinks === true) {
    return {
      kind: "record",
      record: { name: archiveName, data: readlinkSync(absolutePath), mode: stat.mode },
    };
  }
  if (options.followSymlinks !== true) {
    throw new Error(`ZIP source contains an unsupported entry: ${archiveName}`);
  }
  // A followed symlink must resolve INSIDE the tree being archived: without this containment a
  // staged link could embed arbitrary workspace or runner files into a release archive.
  if (options.containmentRoot !== undefined) {
    const resolvedTarget = realpathSync(absolutePath);
    const resolvedRoot = realpathSync(options.containmentRoot);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
      throw new Error(`ZIP source symlink escapes the archive root: ${archiveName}`);
    }
  }
  const targetStat = statSync(absolutePath);
  if (targetStat.isDirectory()) return { kind: "directory" };
  if (targetStat.isFile()) {
    return {
      kind: "record",
      record: { name: archiveName, data: readFileSync(absolutePath), mode: targetStat.mode },
    };
  }
  throw new Error(`ZIP source contains an unsupported symlink target: ${archiveName}`);
}

export function writeZipArchiveEntries(archivePath, records, options = {}) {
  mkdirSync(dirname(archivePath), { recursive: true });
  const temporaryPath = `${archivePath}.tmp-${process.pid}`;
  rmSync(temporaryPath, { force: true });
  const fd = openSync(temporaryPath, "wx", 0o600);
  let descriptorOpen = true;
  try {
    const state = { offset: 0 };
    const entries = writeEntries(fd, records, options, state);
    writeCentralDirectory(fd, entries, state);
    try {
      closeSync(fd);
    } finally {
      descriptorOpen = false;
    }
    rmSync(archivePath, { force: true });
    renameSync(temporaryPath, archivePath);
  } catch (error) {
    const cleanupFailures = cleanupFailedArchive(fd, temporaryPath, descriptorOpen);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "ZIP archive creation and temporary-file cleanup both failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function collectDirectoryEntries(sourceRoot, rootName, options) {
  if (options.followSymlinks === true && options.preserveSymlinks === true) {
    throw new Error(
      "ZIP symlink options preserveSymlinks and followSymlinks are mutually exclusive",
    );
  }
  const records = [];
  const activeDirectories = new Set();
  function visit(directory, relativeDirectory) {
    const realDirectory = realpathSync(directory);
    if (activeDirectories.has(realDirectory)) {
      throw new Error(
        `ZIP source contains a recursive symlinked directory: ${rootName}/${relativeDirectory}`,
      );
    }
    activeDirectories.add(realDirectory);
    try {
      const entries = readdirSync(directory, { withFileTypes: true }).sort(compareDirectoryEntries);
      for (const entry of entries) {
        const absolutePath = join(directory, entry.name);
        const relativePath =
          relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        const archiveName = `${rootName}/${relativePath}`;
        const stat = lstatSync(absolutePath);
        if (stat.isDirectory()) {
          visit(absolutePath, relativePath);
        } else if (stat.isSymbolicLink()) {
          const result = symlinkDirectoryEntry(absolutePath, archiveName, options, stat);
          if (result.kind === "directory") visit(absolutePath, relativePath);
          else records.push(result.record);
        } else if (stat.isFile()) {
          records.push({ name: archiveName, data: readFileSync(absolutePath), mode: stat.mode });
        } else {
          throw new Error(`ZIP source contains an unsupported entry: ${archiveName}`);
        }
      }
    } finally {
      activeDirectories.delete(realDirectory);
    }
  }
  visit(sourceRoot, "");
  return records;
}

export function writeZipArchiveFromDirectory(sourceRoot, archivePath, options) {
  const rootName = normalizedEntryName(options.rootName, false);
  const records = collectDirectoryEntries(sourceRoot, rootName, {
    followSymlinks: options.followSymlinks === true,
    preserveSymlinks: options.preserveSymlinks === true,
    ...(options.containmentRoot === undefined ? {} : { containmentRoot: options.containmentRoot }),
  });
  if (options.requireRegularEntries === true) {
    // Mirror of the read-side refusal: a `:` in an entry name would become an NTFS alternate
    // data stream when the archive is later extracted on Windows.
    for (const record of records) {
      if (record.name.includes(":")) {
        throw new Error(`ZIP entry name contains an NTFS alternate-stream separator: refused`);
      }
    }
  }
  writeZipArchiveEntries(archivePath, records);
}

const END_OF_CENTRAL_DIRECTORY_MIN_BYTES = 22;
const STORE_METHOD = 0;
// No single entry may inflate beyond the portable archive ceiling — a hostile directory could
// declare the uint32 maximum and make maxOutputLength alone admit a 4 GiB allocation.
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The EOCD record sits at the very end, optionally followed by a comment of up to 0xffff bytes —
 * scanned backwards so a comment cannot hide it, and refused outright when absent.
 */
function endOfCentralDirectoryOffset(bytes) {
  const earliest = Math.max(0, bytes.byteLength - END_OF_CENTRAL_DIRECTORY_MIN_BYTES - 0xffff);
  for (
    let offset = bytes.byteLength - END_OF_CENTRAL_DIRECTORY_MIN_BYTES;
    offset >= earliest;
    offset -= 1
  ) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("ZIP archive has no end-of-central-directory record");
}

function readCentralEntry(bytes, offset) {
  if (offset + 46 > bytes.byteLength || bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
    throw new Error("ZIP central directory entry is malformed");
  }
  const nameLength = bytes.readUInt16LE(offset + 28);
  return {
    method: bytes.readUInt16LE(offset + 10),
    checksum: bytes.readUInt32LE(offset + 16),
    compressedSize: bytes.readUInt32LE(offset + 20),
    size: bytes.readUInt32LE(offset + 24),
    localOffset: bytes.readUInt32LE(offset + 42),
    unixMode: bytes.readUInt32LE(offset + 38) >>> 16,
    rawName: bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
    next:
      offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32),
  };
}

/**
 * The entry's bytes, decompressed and PROVEN: declared size and CRC-32 must both agree, so a
 * truncated or tampered stream is a refusal, never partial content.
 */
function centralEntryData(bytes, entry) {
  if (
    entry.localOffset + 30 > bytes.byteLength ||
    bytes.readUInt32LE(entry.localOffset) !== LOCAL_FILE_HEADER
  ) {
    throw new Error(`ZIP entry ${entry.rawName} has a malformed local header`);
  }
  const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
  const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);
  if (compressed.byteLength !== entry.compressedSize) {
    throw new Error(`ZIP entry ${entry.rawName} is truncated`);
  }
  const data = inflatedEntryData(compressed, entry);
  if (data.byteLength !== entry.size || crc32(data) !== entry.checksum) {
    throw new Error(`ZIP entry ${entry.rawName} does not match its declared size or checksum`);
  }
  return data;
}

function inflatedEntryData(compressed, entry) {
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new Error(`ZIP entry ${entry.rawName} declares a size beyond the supported ceiling`);
  }
  if (entry.method === DEFLATE_METHOD) {
    // The declared size is the single-entry memory ceiling: without maxOutputLength a hostile
    // header could make inflate allocate gigabytes before the size check rejects the entry.
    // Node >= 24.18 rejects maxOutputLength 0 outright, and staged artifacts legitimately carry
    // empty files — an empty entry still gets its stream PROVEN empty through a 1-byte ceiling:
    // a stream hiding real content behind a zero declaration overflows and refuses exactly as
    // before (the 0.3.2 latest-promotion outage: every reader path threw ERR_OUT_OF_RANGE on
    // the first empty entry and the refusal surfaced as "artifacts could not be read").
    return inflateRawSync(compressed, { maxOutputLength: Math.max(entry.size, 1) });
  }
  if (entry.method === STORE_METHOD) return Buffer.from(compressed);
  throw new Error(`ZIP entry ${entry.rawName} uses an unsupported compression method`);
}

/** ZIP64 archives signal themselves through sentinel values; both readers refuse them. */
function assertZip32Directory(count, directoryOffset) {
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }
}

/**
 * Every file entry of a ZIP32 archive — the writers above and GitHub's artifact endpoint both
 * produce this shape. Directory markers are skipped; every file name passes the same
 * traversal-safety rule the writer enforces, so a hostile archive cannot name a path outside
 * its extraction root. Any structural disagreement throws: fail closed, never partial content.
 */
// Central-directory Unix type bits: only regular files (or DOS entries carrying no Unix mode)
// are supported payloads. Symlinks, devices, FIFOs, and sockets fail closed when the caller
// requires regular entries — a link materialized as a plain file would silently change meaning.
const UNIX_TYPE_MASK = 0xf000;
const UNIX_TYPE_REGULAR = 0x8000;
const UNIX_TYPE_DIRECTORY = 0x4000;

// A directory marker (trailing `/`) is skipped rather than materialized — but its Unix type
// bits must still agree. A crafted `dir/` entry carrying symlink or device bits is a
// contradiction only a hostile archive produces; refuse it instead of skipping past it.
function assertDirectoryMarkerEntry(entry, requireRegularEntries) {
  if (requireRegularEntries !== true) return;
  const type = entry.unixMode & UNIX_TYPE_MASK;
  if (type !== 0 && type !== UNIX_TYPE_DIRECTORY) {
    throw new Error(`ZIP entry ${entry.rawName} is an unsupported special entry type`);
  }
}

function assertRegularZipEntry(entry, requireRegularEntries) {
  if (requireRegularEntries !== true) return;
  const type = entry.unixMode & UNIX_TYPE_MASK;
  if (type !== 0 && type !== UNIX_TYPE_REGULAR) {
    throw new Error(`ZIP entry ${entry.rawName} is an unsupported special entry type`);
  }
  // On NTFS, `name:stream` materializes an alternate data stream of `name` rather than a file —
  // the Unix type bits still say "regular", so the name itself must be refused before a Windows
  // extraction can hide payload bytes in a stream (the retired 7z checker rejected these too).
  if (entry.rawName.includes(":")) {
    throw new Error("ZIP entry name contains an NTFS alternate-stream separator");
  }
}

export function readZipArchiveEntries(archivePath, options = {}) {
  const bytes = readFileSync(archivePath);
  const end = endOfCentralDirectoryOffset(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const records = [];
  let offset = bytes.readUInt32LE(end + 16);
  assertZip32Directory(count, offset);
  for (let index = 0; index < count; index += 1) {
    const entry = readCentralEntry(bytes, offset);
    if (entry.rawName.endsWith("/")) {
      assertDirectoryMarkerEntry(entry, options.requireRegularEntries);
    } else {
      assertRegularZipEntry(entry, options.requireRegularEntries);
      records.push({
        name: normalizedEntryName(entry.rawName),
        data: centralEntryData(bytes, entry),
      });
    }
    offset = entry.next;
  }
  return records;
}

/** Reads exactly `length` bytes at `position`, refusing a short file as truncation. */
function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const got = readSync(fd, buffer, filled, length - filled, position + filled);
    if (got === 0) throw new Error("ZIP archive is truncated");
    filled += got;
  }
  return buffer;
}

/** The entry's proven bytes, read through the descriptor — never the whole archive. */
function extractEntryData(fd, entry, archiveSize) {
  if (entry.localOffset + 30 > archiveSize) {
    throw new Error(`ZIP entry ${entry.rawName} has a malformed local header`);
  }
  const header = readAt(fd, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    throw new Error(`ZIP entry ${entry.rawName} has a malformed local header`);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  // Bounds before allocation: the declared compressed size comes from the untrusted directory,
  // and a value beyond the file must refuse as truncation instead of allocating gigabytes first.
  if (dataStart + entry.compressedSize > archiveSize) {
    throw new Error(`ZIP entry ${entry.rawName} is truncated`);
  }
  const compressed = readAt(fd, dataStart, entry.compressedSize);
  const data = inflatedEntryData(compressed, entry);
  if (data.byteLength !== entry.size || crc32(data) !== entry.checksum) {
    throw new Error(`ZIP entry ${entry.rawName} does not match its declared size or checksum`);
  }
  return data;
}

/**
 * Extracts every file entry of the archive under the target root through WINDOWED descriptor
 * reads — the end-of-central-directory tail, the central directory, and then one entry's
 * compressed stream at a time. A staged runtime artifact is hundreds of megabytes compressed and
 * gigabytes inflated; neither the whole archive nor more than one inflated entry may live in
 * memory at once (Codex findings on #3055). Same contract as the reader otherwise:
 * traversal-safe names, proven sizes and checksums, fail closed.
 */
export function extractZipArchiveEntries(archivePath, targetRoot, options = {}) {
  const fd = openSync(archivePath, "r");
  try {
    const size = fstatSync(fd).size;
    const tailLength = Math.min(size, END_OF_CENTRAL_DIRECTORY_MIN_BYTES + 0xffff);
    const tail = readAt(fd, size - tailLength, tailLength);
    const eocdInTail = endOfCentralDirectoryOffset(tail);
    const count = tail.readUInt16LE(eocdInTail + 10);
    const directoryOffset = tail.readUInt32LE(eocdInTail + 16);
    assertZip32Directory(count, directoryOffset);
    const directoryLength = size - tailLength + eocdInTail - directoryOffset;
    if (directoryLength < 0) throw new Error("ZIP central directory is malformed");
    const directory = readAt(fd, directoryOffset, directoryLength);
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
      const entry = readCentralEntry(directory, offset);
      if (entry.rawName.endsWith("/")) {
        assertDirectoryMarkerEntry(entry, options.requireRegularEntries);
      } else {
        assertRegularZipEntry(entry, options.requireRegularEntries);
        const path = join(targetRoot, normalizedEntryName(entry.rawName));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, extractEntryData(fd, entry, size));
      }
      offset = entry.next;
    }
  } finally {
    closeSync(fd);
  }
}
