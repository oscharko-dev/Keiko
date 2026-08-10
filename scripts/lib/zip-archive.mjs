import { Buffer } from "node:buffer";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
  });
  writeZipArchiveEntries(archivePath, records);
}

const END_OF_CENTRAL_DIRECTORY_MIN_BYTES = 22;
const STORE_METHOD = 0;

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
  if (entry.method === DEFLATE_METHOD) return inflateRawSync(compressed);
  if (entry.method === STORE_METHOD) return Buffer.from(compressed);
  throw new Error(`ZIP entry ${entry.rawName} uses an unsupported compression method`);
}

/**
 * Every file entry of a ZIP32 archive — the writers above and GitHub's artifact endpoint both
 * produce this shape. Directory markers are skipped; every file name passes the same
 * traversal-safety rule the writer enforces, so a hostile archive cannot name a path outside
 * its extraction root. Any structural disagreement throws: fail closed, never partial content.
 */
export function readZipArchiveEntries(archivePath) {
  const bytes = readFileSync(archivePath);
  const end = endOfCentralDirectoryOffset(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const records = [];
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const entry = readCentralEntry(bytes, offset);
    if (!entry.rawName.endsWith("/")) {
      records.push({
        name: normalizedEntryName(entry.rawName),
        data: centralEntryData(bytes, entry),
      });
    }
    offset = entry.next;
  }
  return records;
}

/**
 * Extracts every file entry of the archive under the target root, ONE entry in memory at a time —
 * a staged runtime artifact expands to gigabytes, and materialising every inflated entry at once
 * (as readZipArchiveEntries does) holds the whole payload in memory (Codex finding on #3055).
 * Same contract otherwise: traversal-safe names, proven sizes and checksums, fail closed.
 */
export function extractZipArchiveEntries(archivePath, targetRoot) {
  const bytes = readFileSync(archivePath);
  const end = endOfCentralDirectoryOffset(bytes);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const entry = readCentralEntry(bytes, offset);
    if (!entry.rawName.endsWith("/")) {
      const path = join(targetRoot, normalizedEntryName(entry.rawName));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, centralEntryData(bytes, entry));
    }
    offset = entry.next;
  }
}
