// Codec for the Keiko setup bootstrap's appended-overlay format (issue #2992, frozen SPEC v1
// section 1). The final `keiko-windows-x64-setup.exe` is a normal PE32+ image (the "stub", built
// from native/setup-bootstrap/keiko-setup-bootstrap.c) followed immediately by a 64-byte overlay
// header and then the portable ZIP payload, byte for byte:
//
//   [stub PE image][overlay header (64 bytes)][payload bytes]
//
// Authenticode signing appends its own certificate table AFTER this overlay, and may insert up to
// 7 bytes of zero alignment padding before it — so nothing in this module may assume the overlay,
// or the payload inside it, ends at the physical end of the file. The C stub
// (native/setup-bootstrap/keiko-setup-bootstrap.c) parses the IDENTICAL byte layout at run time to
// locate and hash its own payload; the two parsers must stay bit-for-bit compatible, so every
// offset below is a frozen contract, not an implementation detail.
//
// This module is pure and platform-independent — no `win32` gate, no filesystem access beyond the
// Buffer it is handed — so it can be unit-tested on any host and shared by the build script, its
// tests, and (indirectly, by contract) the native stub.

import { Buffer } from "node:buffer";

/** ASCII "KSETUP01" — the first 8 bytes of every overlay header. */
export const SETUP_OVERLAY_MAGIC = Buffer.from("KSETUP01", "ascii");

/**
 * Fixed overlay header size in bytes. Layout (all multi-byte integers little-endian, per frozen
 * SPEC v1 section 1):
 *   [0:8)   magic          ASCII "KSETUP01"
 *   [8:16)  payloadSize    u64 LE byte count of the payload that immediately follows the header
 *   [16:48) payloadSha256  raw (not hex) SHA-256 digest of the payload bytes
 *   [48:64) reserved       zero bytes, reserved for a future schema revision
 */
export const SETUP_OVERLAY_HEADER_BYTES = 64;

const SETUP_OVERLAY_MAGIC_END = 8;
const SETUP_OVERLAY_PAYLOAD_SIZE_OFFSET = 8;
const SETUP_OVERLAY_DIGEST_OFFSET = 16;
const SETUP_OVERLAY_DIGEST_END = 48;
const SETUP_OVERLAY_RESERVED_OFFSET = 48;
const SETUP_OVERLAY_DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Thrown by every codec/parse failure in this module. Kept local (rather than importing the build
 * script's `WindowsPortableSetupError`) so this module has no dependency on its only caller today;
 * the build script maps this into its own error type at the call boundary.
 */
export class PortableSetupOverlayError extends Error {}

function fail(message) {
  throw new PortableSetupOverlayError(`portable-setup-overlay: ${message}`);
}

function assertPayloadSizeBytes(value) {
  // A safe integer (<= 2^53-1) always fits in the header's unsigned 64-bit field with room to
  // spare — nothing this build ever produces (a portable archive of roughly 130 MB) comes
  // remotely close, so safe-integer-ness is the entire bound. Rejecting anything else keeps
  // `BigInt(value)` below from ever being handed a value it would silently round.
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("payload size must be a non-negative safe integer");
  }
}

function assertPayloadSha256Hex(value) {
  if (typeof value !== "string" || !SETUP_OVERLAY_DIGEST_HEX_PATTERN.test(value)) {
    fail("payload sha256 must be 64 lowercase hex characters");
  }
}

function assertFileSizeBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("file size must be a non-negative safe integer");
  }
}

/**
 * Builds the 64-byte overlay header for a payload of the given size and digest — the inverse of
 * the header decode inside `parseSetupOverlay`. Kept as one small pure function so the two can
 * never silently drift apart from the byte layout documented above.
 */
export function buildSetupOverlayHeader({ payloadSizeBytes, payloadSha256Hex }) {
  assertPayloadSizeBytes(payloadSizeBytes);
  assertPayloadSha256Hex(payloadSha256Hex);
  const header = Buffer.alloc(SETUP_OVERLAY_HEADER_BYTES);
  SETUP_OVERLAY_MAGIC.copy(header, 0);
  header.writeBigUInt64LE(BigInt(payloadSizeBytes), SETUP_OVERLAY_PAYLOAD_SIZE_OFFSET);
  Buffer.from(payloadSha256Hex, "hex").copy(header, SETUP_OVERLAY_DIGEST_OFFSET);
  // Bytes [48:64) stay zero: Buffer.alloc (no fill argument) zero-fills, so the reserved region
  // needs no explicit write.
  return header;
}

// -------------------------------------------------------------------------------------------
// PE32+ parsing. Every offset below is the Microsoft PE/COFF format, and every field is read
// only after a bounds check proves the bytes are physically present in the buffer. This parser
// runs on trusted build output today, but the SAME algorithm is what the native stub trusts at
// install time (frozen SPEC v1 section 1) — a parser that read past EOF here would describe an
// algorithm that could be tricked past EOF there, so "bounds-check everything" is load-bearing,
// not decorative.
// -------------------------------------------------------------------------------------------

const DOS_MAGIC_M = 0x4d; // 'M'
const DOS_MAGIC_Z = 0x5a; // 'Z'
const DOS_E_LFANEW_OFFSET = 0x3c; // offset of the 4-byte "offset of the PE header" field
const DOS_HEADER_MIN_BYTES = DOS_E_LFANEW_OFFSET + 4;

const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00]); // "PE\0\0"
const COFF_HEADER_BYTES = 20;
const COFF_NUMBER_OF_SECTIONS_OFFSET = 2;
const COFF_SIZE_OF_OPTIONAL_HEADER_OFFSET = 16;

const OPTIONAL_HEADER_MAGIC_PE32 = 0x10b; // 32-bit — explicitly unsupported (frozen SPEC v1 §1)
const OPTIONAL_HEADER_MAGIC_PE32_PLUS = 0x20b; // 64-bit — the only supported shape
const OPTIONAL_HEADER_SIZE_OF_HEADERS_OFFSET = 60;
const OPTIONAL_HEADER_DATA_DIRECTORY_OFFSET = 112;
const DATA_DIRECTORY_ENTRY_BYTES = 8;
// Certificate table directory index. For this ONE directory, VirtualAddress is documented by the
// PE spec to hold a FILE offset rather than an RVA, because certificate data is never mapped.
const IMAGE_DIRECTORY_ENTRY_SECURITY = 4;
// Bytes an optional header must physically carry to have a Security (index 4) data directory
// entry at all: the 112 fixed PE32+ fields, plus five 8-byte directory slots (indices 0..4).
const OPTIONAL_HEADER_MIN_BYTES_FOR_SECURITY_DIRECTORY =
  OPTIONAL_HEADER_DATA_DIRECTORY_OFFSET +
  (IMAGE_DIRECTORY_ENTRY_SECURITY + 1) * DATA_DIRECTORY_ENTRY_BYTES;

const SECTION_HEADER_BYTES = 40;
const SECTION_SIZE_OF_RAW_DATA_OFFSET = 16;
const SECTION_POINTER_TO_RAW_DATA_OFFSET = 20;

function assertReadable(fileBuffer, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > fileBuffer.length) {
    fail(`${label} is truncated or out of bounds`);
  }
}

function readDosHeaderPeOffset(fileBuffer) {
  assertReadable(fileBuffer, 0, DOS_HEADER_MIN_BYTES, "DOS header");
  if (fileBuffer[0] !== DOS_MAGIC_M || fileBuffer[1] !== DOS_MAGIC_Z) {
    fail("stub image is missing the MZ DOS header magic");
  }
  return fileBuffer.readUInt32LE(DOS_E_LFANEW_OFFSET);
}

function readPeAndCoffHeaders(fileBuffer, peHeaderOffset) {
  assertReadable(
    fileBuffer,
    peHeaderOffset,
    PE_SIGNATURE.length + COFF_HEADER_BYTES,
    "PE/COFF header",
  );
  const signature = fileBuffer.subarray(peHeaderOffset, peHeaderOffset + PE_SIGNATURE.length);
  if (!signature.equals(PE_SIGNATURE)) {
    fail("stub image is missing the PE header signature");
  }
  const coffOffset = peHeaderOffset + PE_SIGNATURE.length;
  return {
    numberOfSections: fileBuffer.readUInt16LE(coffOffset + COFF_NUMBER_OF_SECTIONS_OFFSET),
    optionalHeaderOffset: coffOffset + COFF_HEADER_BYTES,
    sizeOfOptionalHeader: fileBuffer.readUInt16LE(coffOffset + COFF_SIZE_OF_OPTIONAL_HEADER_OFFSET),
  };
}

function readOptionalHeaderMagic(fileBuffer, optionalHeaderOffset) {
  assertReadable(fileBuffer, optionalHeaderOffset, 2, "optional header magic");
  const magic = fileBuffer.readUInt16LE(optionalHeaderOffset);
  if (magic === OPTIONAL_HEADER_MAGIC_PE32) {
    fail("stub image is PE32 (32-bit); only PE32+ (64-bit) is supported");
  }
  if (magic !== OPTIONAL_HEADER_MAGIC_PE32_PLUS) {
    fail("stub image optional header magic is not PE32+");
  }
}

function readOptionalHeader(fileBuffer, optionalHeaderOffset, sizeOfOptionalHeader) {
  readOptionalHeaderMagic(fileBuffer, optionalHeaderOffset);
  if (sizeOfOptionalHeader < OPTIONAL_HEADER_MIN_BYTES_FOR_SECURITY_DIRECTORY) {
    fail("stub image optional header is too small to carry a certificate table directory");
  }
  assertReadable(fileBuffer, optionalHeaderOffset, sizeOfOptionalHeader, "optional header");
  const directoryOffset =
    optionalHeaderOffset +
    OPTIONAL_HEADER_DATA_DIRECTORY_OFFSET +
    IMAGE_DIRECTORY_ENTRY_SECURITY * DATA_DIRECTORY_ENTRY_BYTES;
  return {
    certificateTableFileOffset: fileBuffer.readUInt32LE(directoryOffset),
    certificateTableSize: fileBuffer.readUInt32LE(directoryOffset + 4),
    sizeOfHeaders: fileBuffer.readUInt32LE(
      optionalHeaderOffset + OPTIONAL_HEADER_SIZE_OF_HEADERS_OFFSET,
    ),
  };
}

function computeOverlayStart(
  fileBuffer,
  sectionTableOffset,
  numberOfSections,
  sizeOfHeaders,
  fileSizeBytes,
) {
  let overlayStart = sizeOfHeaders;
  for (let index = 0; index < numberOfSections; index += 1) {
    const sectionOffset = sectionTableOffset + index * SECTION_HEADER_BYTES;
    assertReadable(
      fileBuffer,
      sectionOffset,
      SECTION_HEADER_BYTES,
      `section header [${String(index)}]`,
    );
    const sizeOfRawData = fileBuffer.readUInt32LE(sectionOffset + SECTION_SIZE_OF_RAW_DATA_OFFSET);
    const pointerToRawData = fileBuffer.readUInt32LE(
      sectionOffset + SECTION_POINTER_TO_RAW_DATA_OFFSET,
    );
    overlayStart = Math.max(overlayStart, pointerToRawData + sizeOfRawData);
  }
  if (overlayStart > fileSizeBytes) {
    fail("stub image section data extends past the end of the file");
  }
  return overlayStart;
}

function computeOverlayEnd(
  certificateTableFileOffset,
  certificateTableSize,
  overlayStart,
  fileSizeBytes,
) {
  if (certificateTableSize === 0) return fileSizeBytes;
  if (certificateTableFileOffset < overlayStart || certificateTableFileOffset > fileSizeBytes) {
    fail("stub image certificate table offset is out of bounds");
  }
  return certificateTableFileOffset;
}

/**
 * Locates the overlay region of a PE32+ file. `overlayStart` is where the stub's own image ends
 * (the max over sections of PointerToRawData + SizeOfRawData, also never less than SizeOfHeaders);
 * `overlayEnd` is the certificate table's file offset when one is declared, else the physical end
 * of the file. Implements frozen SPEC v1 section 1's overlay location algorithm exactly — the
 * native stub performs the identical walk at run time, so a change here must be mirrored there.
 *
 * `fileBuffer` need not hold the WHOLE file: `fileSizeBytes` (default `fileBuffer.length`, the
 * original whole-buffer contract every existing caller relies on) is the file's true total size,
 * checked independently of how much of it `fileBuffer` physically contains. A caller verifying a
 * large file without buffering all of it reads a bounded header prefix into `fileBuffer` and
 * passes the real size (from `fstatSync`) separately — the same split the native stub's
 * `keiko_parse_overlay_bounds(scan, scan_len, file_size, out)` makes between its bounded
 * header-scan window and the file's actual size.
 */
export function portableExecutableOverlayBounds(fileBuffer, fileSizeBytes = fileBuffer?.length) {
  if (!Buffer.isBuffer(fileBuffer)) fail("expected a Buffer of PE file bytes");
  assertFileSizeBytes(fileSizeBytes);
  if (fileSizeBytes < fileBuffer.length) {
    fail("declared file size is smaller than the PE file bytes that were read");
  }
  const peHeaderOffset = readDosHeaderPeOffset(fileBuffer);
  const { numberOfSections, optionalHeaderOffset, sizeOfOptionalHeader } = readPeAndCoffHeaders(
    fileBuffer,
    peHeaderOffset,
  );
  const { certificateTableFileOffset, certificateTableSize, sizeOfHeaders } = readOptionalHeader(
    fileBuffer,
    optionalHeaderOffset,
    sizeOfOptionalHeader,
  );
  const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  const overlayStart = computeOverlayStart(
    fileBuffer,
    sectionTableOffset,
    numberOfSections,
    sizeOfHeaders,
    fileSizeBytes,
  );
  const overlayEnd = computeOverlayEnd(
    certificateTableFileOffset,
    certificateTableSize,
    overlayStart,
    fileSizeBytes,
  );
  return { overlayEnd, overlayStart };
}

// -------------------------------------------------------------------------------------------
// Overlay header + payload decode.
// -------------------------------------------------------------------------------------------

/**
 * Fails closed unless every byte in `buffer` is zero. Exported so both the whole-buffer padding
 * check below and the streaming verifier's small positioned read of the same <=7 trailing bytes
 * (build-windows-portable-setup.mjs) share one implementation and one failure message.
 */
export function assertZeroBytes(buffer, label) {
  for (const byte of buffer) {
    if (byte !== 0) fail(`${label} must be zero`);
  }
}

function readOverlayPayloadSize(header) {
  const raw = header.readBigUInt64LE(SETUP_OVERLAY_PAYLOAD_SIZE_OFFSET);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("setup overlay payload size exceeds the supported range");
  }
  return Number(raw);
}

/**
 * Decodes and validates a 64-byte overlay header buffer: magic, payload size, payload digest, and
 * zero reserved bytes. Takes the header bytes directly rather than a whole file buffer, so it is
 * equally usable after slicing a whole-file buffer (`parseSetupOverlay`) or after a small
 * positioned read of just these 64 bytes (the streaming verifier in
 * build-windows-portable-setup.mjs, mirroring the native stub's `keiko_validate_overlay_header`).
 */
export function readSetupOverlayHeaderFields(header) {
  if (!header.subarray(0, SETUP_OVERLAY_MAGIC_END).equals(SETUP_OVERLAY_MAGIC)) {
    fail("setup overlay magic does not match KSETUP01");
  }
  const payloadSize = readOverlayPayloadSize(header);
  const payloadSha256Hex = header
    .subarray(SETUP_OVERLAY_DIGEST_OFFSET, SETUP_OVERLAY_DIGEST_END)
    .toString("hex");
  assertZeroBytes(header.subarray(SETUP_OVERLAY_RESERVED_OFFSET), "setup overlay reserved bytes");
  return { payloadSha256Hex, payloadSize };
}

/**
 * Pure size arithmetic for the payload region, shared by the whole-buffer codec
 * (`assertPayloadFitsBeforeOverlayEnd` below) and the streaming verifier in
 * build-windows-portable-setup.mjs: computes where the payload ends and how many trailing padding
 * bytes (if any) sit before `overlayEnd`, and fails closed exactly as this module always has — an
 * oversized payload, or more than the <=7 bytes signing may add for certificate-table alignment
 * (frozen SPEC v1 section 1). Callers still validate the padding bytes themselves are zero, since
 * that requires reading them from wherever the caller's bytes live (a whole buffer or a small
 * positioned file read) — this function only proves how many there should be.
 */
export function setupOverlayPayloadRegion(payloadStart, payloadSize, overlayEnd) {
  const payloadEnd = payloadStart + payloadSize;
  if (payloadEnd > overlayEnd) fail("setup overlay payload does not fit before the overlay end");
  const paddingBytes = overlayEnd - payloadEnd;
  // Signing may insert up to 7 bytes of zero alignment padding before the certificate table it
  // appends (frozen SPEC v1 section 1). 8 or more bytes, or any non-zero byte, means the
  // "padding" is really unaccounted data and the overlay cannot be trusted.
  if (paddingBytes > 7) fail("setup overlay trailing padding exceeds 7 bytes");
  return { paddingBytes, payloadEnd };
}

function assertPayloadFitsBeforeOverlayEnd(fileBuffer, payloadStart, payloadSize, overlayEnd) {
  const { paddingBytes, payloadEnd } = setupOverlayPayloadRegion(
    payloadStart,
    payloadSize,
    overlayEnd,
  );
  if (paddingBytes > 0) {
    assertZeroBytes(fileBuffer.subarray(payloadEnd, overlayEnd), "setup overlay trailing padding");
  }
}

/**
 * Fails closed unless the fixed-size overlay header physically fits before `overlayEnd` once
 * `overlayStart` is known. Factored out of `parseSetupOverlay` so the streaming verifier in
 * build-windows-portable-setup.mjs can enforce the identical bound before ITS OWN small
 * positioned read of just those 64 bytes, instead of requiring a whole-file buffer to slice from.
 */
export function assertSetupOverlayHeaderFitsBeforeEnd(overlayStart, overlayEnd) {
  if (overlayStart + SETUP_OVERLAY_HEADER_BYTES > overlayEnd) {
    fail("setup overlay header does not fit before the overlay end");
  }
}

/**
 * Parses the overlay header at the stub's overlay start and validates that the payload region it
 * describes fits within the overlay end (frozen SPEC v1 section 1). Returns where the payload
 * begins, its declared byte length, and its declared SHA-256 as lowercase hex — never the payload
 * bytes themselves, so callers choose how to stream or buffer them.
 */
export function parseSetupOverlay(fileBuffer) {
  const { overlayEnd, overlayStart } = portableExecutableOverlayBounds(fileBuffer);
  assertReadable(fileBuffer, overlayStart, SETUP_OVERLAY_HEADER_BYTES, "setup overlay header");
  assertSetupOverlayHeaderFitsBeforeEnd(overlayStart, overlayEnd);
  const header = fileBuffer.subarray(overlayStart, overlayStart + SETUP_OVERLAY_HEADER_BYTES);
  const { payloadSha256Hex, payloadSize } = readSetupOverlayHeaderFields(header);
  const payloadStart = overlayStart + SETUP_OVERLAY_HEADER_BYTES;
  assertPayloadFitsBeforeOverlayEnd(fileBuffer, payloadStart, payloadSize, overlayEnd);
  return { payloadSha256Hex, payloadSize, payloadStart };
}
