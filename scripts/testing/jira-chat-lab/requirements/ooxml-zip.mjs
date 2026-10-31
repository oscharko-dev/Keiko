// Minimal deterministic ZIP writer for hand-written OOXML packages (epic #4173, #4174).
// Fixed DOS timestamp and a fixed entry order make the bytes reproducible.
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8_FLAG = 0x0800;
const METHOD_DEFLATE = 8;

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** CRC-32 (IEEE 802.3) of a buffer. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(METHOD_DEFLATE, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.packed.length, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  return header;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(METHOD_DEFLATE, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.packed.length, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function prepare({ name, data }) {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  return {
    name: Buffer.from(name, "utf8"),
    crc: crc32(raw),
    size: raw.length,
    packed: deflateRawSync(raw, { level: 9 }),
    offset: 0,
  };
}

/** Builds a ZIP archive from `[{ name, data }]`, keeping the given entry order. */
export function createZip(entries) {
  const prepared = entries.map(prepare);
  const parts = [];
  let offset = 0;
  for (const entry of prepared) {
    entry.offset = offset;
    const local = [localHeader(entry), entry.name, entry.packed];
    parts.push(...local);
    offset += local.reduce((total, part) => total + part.length, 0);
  }
  const central = prepared.flatMap((entry) => [centralHeader(entry), entry.name]);
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
