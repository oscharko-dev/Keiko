import { Buffer } from "node:buffer";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";

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
  const segments = normalized.split("/");
  const unsafe =
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.includes("\u0000") ||
    segments.includes("..") ||
    segments.includes("");
  if (unsafe && allowUnsafeEntryNames !== true) {
    throw new Error(`ZIP entry name is unsafe: ${name}`);
  }
  return normalized;
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
      );
    }
    throw error;
  }
}

function collectDirectoryEntries(sourceRoot, rootName, preserveSymlinks) {
  const records = [];
  function visit(directory, relativeDirectory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath =
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const archiveName = `${rootName}/${relativePath}`;
      const stat = lstatSync(absolutePath);
      if (stat.isDirectory()) visit(absolutePath, relativePath);
      else if (stat.isSymbolicLink() && preserveSymlinks === true) {
        records.push({ name: archiveName, data: readlinkSync(absolutePath), mode: stat.mode });
      } else if (stat.isFile()) {
        records.push({ name: archiveName, data: readFileSync(absolutePath), mode: stat.mode });
      } else {
        throw new Error(`ZIP source contains an unsupported entry: ${archiveName}`);
      }
    }
  }
  visit(sourceRoot, "");
  return records;
}

export function writeZipArchiveFromDirectory(sourceRoot, archivePath, options) {
  const rootName = normalizedEntryName(options.rootName, false);
  const records = collectDirectoryEntries(sourceRoot, rootName, options.preserveSymlinks === true);
  writeZipArchiveEntries(archivePath, records);
}
