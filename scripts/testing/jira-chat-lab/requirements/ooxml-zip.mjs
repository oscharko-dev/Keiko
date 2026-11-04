// Minimal deterministic ZIP writer for hand-written OOXML packages (epic #4173, #4174).
// Fixed DOS timestamp and a fixed entry order make the bytes reproducible.
import { Buffer } from "node:buffer";
import { crc32, deflateRawSync } from "node:zlib";

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8_FLAG = 0x0800;
const METHOD_DEFLATE = 8;

/** The fields a local and a central header share, written from the general-purpose flag on. */
function writeEntryFields(header, entry, at) {
  header.writeUInt16LE(UTF8_FLAG, at);
  header.writeUInt16LE(METHOD_DEFLATE, at + 2);
  header.writeUInt16LE(DOS_TIME, at + 4);
  header.writeUInt16LE(DOS_DATE, at + 6);
  header.writeUInt32LE(entry.crc, at + 8);
  header.writeUInt32LE(entry.packed.length, at + 12);
  header.writeUInt32LE(entry.size, at + 16);
  header.writeUInt16LE(entry.name.length, at + 20);
}

function localHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  writeEntryFields(header, entry, 6);
  return header;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  writeEntryFields(header, entry, 8);
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
