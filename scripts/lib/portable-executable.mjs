import { Buffer } from "node:buffer";
import { closeSync, openSync, readSync, statSync } from "node:fs";

const DOS_HEADER_BYTES = 64;
const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00]);

export function isPortableExecutableFile(path) {
  let descriptor;
  let valid;
  try {
    const size = statSync(path).size;
    descriptor = openSync(path, "r");
    valid = isPortableExecutableDescriptor(descriptor, size);
  } catch {
    valid = false;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch {
      return false;
    }
  }
  return valid;
}

function isPortableExecutableDescriptor(descriptor, size) {
  if (size < DOS_HEADER_BYTES + PE_SIGNATURE.length) return false;
  const header = readExactFileBytes(descriptor, DOS_HEADER_BYTES, 0);
  if (header?.[0] !== 0x4d || header[1] !== 0x5a) return false;
  const peOffset = header.readUInt32LE(0x3c);
  if (peOffset < DOS_HEADER_BYTES || peOffset > size - PE_SIGNATURE.length) return false;
  return (
    readExactFileBytes(descriptor, PE_SIGNATURE.length, peOffset)?.equals(PE_SIGNATURE) === true
  );
}

function readExactFileBytes(descriptor, length, position) {
  const buffer = Buffer.alloc(length);
  return readSync(descriptor, buffer, 0, length, position) === length ? buffer : undefined;
}
