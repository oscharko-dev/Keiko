import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildSetupOverlayHeader,
  parseSetupOverlay,
  PortableSetupOverlayError,
  portableExecutableOverlayBounds,
  SETUP_OVERLAY_HEADER_BYTES,
  SETUP_OVERLAY_MAGIC,
} from "../lib/portable-setup-overlay.mjs";

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Synthetic PE32+ fixture builder. Lays out a minimal-but-real DOS header, PE signature, COFF
// header, PE32+ optional header (with a certificate-table data directory slot), and a section
// table with one configurable section — everything `portableExecutableOverlayBounds` reads. The
// buffer is deliberately NOT extended to cover a section's declared raw-data range unless
// `includeSectionRawData` is true, so tests can build a header-only file whose sections claim more
// bytes than physically exist (the "past EOF" class of malformed input).
// ---------------------------------------------------------------------------------------------

const DOS_E_LFANEW = 64;
const COFF_OFFSET = DOS_E_LFANEW + 4;
const OPTIONAL_HEADER_OFFSET = COFF_OFFSET + 20;
// Always physically reserve a "standard" 240-byte optional header region (112 fixed fields + 16
// data-directory slots) regardless of the declared SizeOfOptionalHeader field under test, so the
// builder's own field writes never run off the end of a deliberately-small buffer.
const OPTIONAL_HEADER_PHYSICAL_RESERVE = 240;
const SECURITY_DIRECTORY_FIELD_OFFSET = OPTIONAL_HEADER_OFFSET + 112 + 4 * 8;
const DEFAULT_SIZE_OF_HEADERS = 512;
const DEFAULT_SECTION = { pointerToRawData: 512, sizeOfRawData: 512 };
// Physical byte length the default fixture materializes. Chosen explicitly — NOT re-derived from the
// section layout — so the fixture never recomputes production's overlay-start formula (AGENTS.md §7:
// a fixture never restates a formula the code under test owns). It happens to equal the default
// section's raw-data extent (512 + 512) and is the offset at which every default-fixture test
// expects the overlay to begin; a test that needs a larger image passes `physicalImageBytes`.
const DEFAULT_PHYSICAL_IMAGE_BYTES = 1024;

// A plain merged-defaults object (rather than per-field destructuring defaults) keeps this
// fixture builder's own cyclomatic complexity low — each `= fallback` in a destructuring pattern
// is its own branch, and this fixture has eight configurable fields.
const DEFAULT_STUB_OPTIONS = Object.freeze({
  includeSectionRawData: true,
  numberOfSections: 1,
  optionalHeaderMagic: 0x20b,
  securityDirectory: Object.freeze({ size: 0, virtualAddress: 0 }),
  physicalImageBytes: DEFAULT_PHYSICAL_IMAGE_BYTES,
  sections: Object.freeze([DEFAULT_SECTION]),
  sizeOfHeaders: DEFAULT_SIZE_OF_HEADERS,
  sizeOfOptionalHeader: 240,
});

function writeStubSectionHeaders(buffer, sectionTableOffset, sectionHeaderCount, sections) {
  for (let index = 0; index < sectionHeaderCount; index += 1) {
    const section = sections[index];
    const sectionOffset = sectionTableOffset + index * 40;
    buffer.writeUInt32LE(section.sizeOfRawData, sectionOffset + 16);
    buffer.writeUInt32LE(section.pointerToRawData, sectionOffset + 20);
  }
}

function buildSyntheticStub(overrides = {}) {
  const options = { ...DEFAULT_STUB_OPTIONS, ...overrides };
  // Not part of the merged defaults object: its own default depends on ANOTHER field
  // (numberOfSections), which a flat object merge cannot express.
  const sectionHeaderCount = overrides.sectionHeaderCount ?? options.numberOfSections;

  const sectionTableOffset = OPTIONAL_HEADER_OFFSET + options.sizeOfOptionalHeader;
  const headerRegionEnd = sectionTableOffset + sectionHeaderCount * 40;
  // `physicalImageBytes` is an explicit, independently chosen fixture input (default 1024), never a
  // re-derivation of production's overlay-start formula. When `includeSectionRawData` is false the
  // buffer stops at the header region, so a section can claim raw-data bytes that do not physically
  // exist (the "past EOF" malformed-input class).
  const bufferLength = Math.max(
    headerRegionEnd,
    OPTIONAL_HEADER_OFFSET + OPTIONAL_HEADER_PHYSICAL_RESERVE,
    options.includeSectionRawData ? options.physicalImageBytes : 0,
  );

  const buffer = Buffer.alloc(bufferLength);
  buffer[0] = 0x4d; // 'M'
  buffer[1] = 0x5a; // 'Z'
  buffer.writeUInt32LE(DOS_E_LFANEW, 0x3c);
  buffer.write("PE\0\0", DOS_E_LFANEW, "latin1");
  buffer.writeUInt16LE(options.numberOfSections, COFF_OFFSET + 2);
  buffer.writeUInt16LE(options.sizeOfOptionalHeader, COFF_OFFSET + 16);
  buffer.writeUInt16LE(options.optionalHeaderMagic, OPTIONAL_HEADER_OFFSET);
  buffer.writeUInt32LE(options.sizeOfHeaders, OPTIONAL_HEADER_OFFSET + 60);
  buffer.writeUInt32LE(options.securityDirectory.virtualAddress, SECURITY_DIRECTORY_FIELD_OFFSET);
  buffer.writeUInt32LE(options.securityDirectory.size, SECURITY_DIRECTORY_FIELD_OFFSET + 4);
  writeStubSectionHeaders(buffer, sectionTableOffset, sectionHeaderCount, options.sections);
  return buffer;
}

const SAMPLE_DIGEST_HEX = "0123456789abcdef".repeat(4);

function buildCompleteFile(stub, payload, { paddingBytes = 0, corruptPaddingByte = false } = {}) {
  const header = buildSetupOverlayHeader({
    payloadSha256Hex: sha256Hex(payload),
    payloadSizeBytes: payload.byteLength,
  });
  const padding = Buffer.alloc(paddingBytes);
  if (corruptPaddingByte && paddingBytes > 0) padding[0] = 0x01;
  return Buffer.concat([stub, header, payload, padding]);
}

describe("buildSetupOverlayHeader", () => {
  it("lays out magic, size, digest, and zero reserved bytes at the frozen offsets", () => {
    const payload = Buffer.from("keiko portable payload fixture", "utf8");
    const header = buildSetupOverlayHeader({
      payloadSha256Hex: sha256Hex(payload),
      payloadSizeBytes: payload.byteLength,
    });
    expect(header.byteLength).toBe(SETUP_OVERLAY_HEADER_BYTES);
    expect(header.subarray(0, 8).equals(SETUP_OVERLAY_MAGIC)).toBe(true);
    expect(header.readBigUInt64LE(8)).toBe(BigInt(payload.byteLength));
    expect(header.subarray(16, 48).toString("hex")).toBe(sha256Hex(payload));
    expect(header.subarray(48, 64).equals(Buffer.alloc(16))).toBe(true);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "12", undefined, Number.NaN])(
    "rejects an invalid payload size %j",
    (payloadSizeBytes) => {
      expect(() =>
        buildSetupOverlayHeader({ payloadSha256Hex: SAMPLE_DIGEST_HEX, payloadSizeBytes }),
      ).toThrow(PortableSetupOverlayError);
    },
  );

  it.each([
    "short",
    SAMPLE_DIGEST_HEX.toUpperCase(),
    `${SAMPLE_DIGEST_HEX.slice(0, 63)}g`,
    undefined,
    123,
  ])("rejects an invalid payload digest %j", (payloadSha256Hex) => {
    expect(() => buildSetupOverlayHeader({ payloadSha256Hex, payloadSizeBytes: 10 })).toThrow(
      PortableSetupOverlayError,
    );
  });
});

describe("portableExecutableOverlayBounds", () => {
  it("computes overlayStart/overlayEnd for a minimal PE32+ stub with no certificate table", () => {
    const stub = buildSyntheticStub();
    expect(portableExecutableOverlayBounds(stub)).toEqual({ overlayEnd: 1024, overlayStart: 1024 });
  });

  it("rejects a non-Buffer input", () => {
    expect(() => portableExecutableOverlayBounds({})).toThrow(/expected a Buffer/u);
  });

  it("rejects a DOS header that is physically truncated", () => {
    const stub = buildSyntheticStub().subarray(0, 10);
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(/DOS header/u);
  });

  it("rejects a DOS header with the wrong magic", () => {
    const stub = buildSyntheticStub();
    stub[0] = 0x00;
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(/MZ DOS header magic/u);
  });

  it("rejects a physically truncated PE/COFF header", () => {
    const stub = buildSyntheticStub().subarray(0, DOS_E_LFANEW + 10);
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(/PE\/COFF header/u);
  });

  it("rejects a corrupted PE signature", () => {
    const stub = buildSyntheticStub();
    stub[DOS_E_LFANEW] = 0x00;
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(/PE header signature/u);
  });

  it("rejects a physically truncated optional header magic", () => {
    const stub = buildSyntheticStub().subarray(0, OPTIONAL_HEADER_OFFSET + 1);
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(/optional header magic/u);
  });

  it("rejects a PE32 (0x10B) optional header", () => {
    const stub = buildSyntheticStub({ optionalHeaderMagic: 0x10b });
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(/PE32 \(32-bit\)/u);
  });

  it("rejects an optional header with an unrecognized magic", () => {
    const stub = buildSyntheticStub({ optionalHeaderMagic: 0x0000 });
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(/not PE32\+/u);
  });

  it("rejects an optional header too small to carry a certificate table directory", () => {
    const stub = buildSyntheticStub({ sizeOfOptionalHeader: 100 });
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(
      /too small to carry a certificate table/u,
    );
  });

  it("rejects a physically truncated optional header", () => {
    const stub = buildSyntheticStub().subarray(0, OPTIONAL_HEADER_OFFSET + 150);
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(/optional header is truncated/u);
  });

  it("rejects a section header declared beyond the physically present section table", () => {
    const stub = buildSyntheticStub({
      includeSectionRawData: false,
      numberOfSections: 2,
      sectionHeaderCount: 1,
    });
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(
      /section header \[1\] is truncated/u,
    );
  });

  it("rejects section raw data that extends past the end of the file", () => {
    const stub = buildSyntheticStub({
      includeSectionRawData: false,
      sections: [{ pointerToRawData: 512, sizeOfRawData: 99_999 }],
    });
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(
      /section data extends past the end/u,
    );
  });

  it("locates the certificate table as overlayEnd when the security directory is set", () => {
    const stub = buildSyntheticStub({ securityDirectory: { size: 64, virtualAddress: 1024 } });
    // Trailing bytes simulate a certificate table physically present after the overlay boundary,
    // proving overlayEnd is derived from the directory, not simply "file length".
    const withTrailer = Buffer.concat([stub, Buffer.alloc(200)]);
    expect(portableExecutableOverlayBounds(withTrailer)).toEqual({
      overlayEnd: 1024,
      overlayStart: 1024,
    });
  });

  it.each([
    [500, "below overlayStart"],
    [5000, "beyond the physical file length"],
  ])("rejects a certificate table file offset %s", (virtualAddress) => {
    const stub = buildSyntheticStub({ securityDirectory: { size: 16, virtualAddress } });
    expect(() => portableExecutableOverlayBounds(stub)).toThrow(
      /certificate table offset is out of bounds/u,
    );
  });
});

describe("parseSetupOverlay", () => {
  const stub = buildSyntheticStub();
  const payload = Buffer.from("keiko portable payload fixture bytes", "utf8");

  it("parses a well-formed overlay with the payload butted directly against overlayEnd", () => {
    const file = buildCompleteFile(stub, payload);
    expect(parseSetupOverlay(file)).toEqual({
      payloadSha256Hex: sha256Hex(payload),
      payloadSize: payload.byteLength,
      payloadStart: stub.byteLength + SETUP_OVERLAY_HEADER_BYTES,
    });
  });

  it("parses a zero-length payload (the empty-payload boundary)", () => {
    const emptyPayload = Buffer.alloc(0);
    const file = buildCompleteFile(stub, emptyPayload);
    expect(parseSetupOverlay(file)).toEqual({
      payloadSha256Hex: sha256Hex(emptyPayload),
      payloadSize: 0,
      payloadStart: stub.byteLength + SETUP_OVERLAY_HEADER_BYTES,
    });
  });

  it.each([0, 1, 7])("accepts %i byte(s) of zero trailing padding", (paddingBytes) => {
    const file = buildCompleteFile(stub, payload, { paddingBytes });
    expect(() => parseSetupOverlay(file)).not.toThrow();
  });

  it("rejects 8 bytes of trailing padding", () => {
    const file = buildCompleteFile(stub, payload, { paddingBytes: 8 });
    expect(() => parseSetupOverlay(file)).toThrow(/padding exceeds 7 bytes/u);
  });

  it("rejects non-zero trailing padding", () => {
    const file = buildCompleteFile(stub, payload, { corruptPaddingByte: true, paddingBytes: 3 });
    expect(() => parseSetupOverlay(file)).toThrow(/padding must be zero/u);
  });

  it("rejects a magic mismatch in the overlay header", () => {
    const file = buildCompleteFile(stub, payload);
    file[stub.byteLength] = 0x00;
    expect(() => parseSetupOverlay(file)).toThrow(/magic does not match KSETUP01/u);
  });

  it("rejects non-zero reserved bytes", () => {
    const file = buildCompleteFile(stub, payload);
    file[stub.byteLength + 48] = 0x01;
    expect(() => parseSetupOverlay(file)).toThrow(/reserved bytes must be zero/u);
  });

  it("rejects a declared payload size that does not fit before overlayEnd", () => {
    const header = buildSetupOverlayHeader({
      payloadSha256Hex: sha256Hex(payload),
      payloadSizeBytes: payload.byteLength + 1,
    });
    const file = Buffer.concat([stub, header, payload]);
    expect(() => parseSetupOverlay(file)).toThrow(/payload does not fit before the overlay end/u);
  });

  it("rejects a physically truncated overlay header", () => {
    const file = buildCompleteFile(stub, payload).subarray(0, stub.byteLength + 10);
    expect(() => parseSetupOverlay(file)).toThrow(/setup overlay header is truncated/u);
  });

  it("rejects an overlay header that does not fit before a certificate table", () => {
    // The security directory points inside where the 64-byte header would need to sit, leaving no
    // room for it before overlayEnd, even though the file is physically long enough.
    const tightStub = buildSyntheticStub({ securityDirectory: { size: 16, virtualAddress: 1040 } });
    const file = Buffer.concat([tightStub, Buffer.alloc(80)]);
    expect(() => parseSetupOverlay(file)).toThrow(/header does not fit before the overlay end/u);
  });

  it("rejects a declared payload size beyond the safe integer range", () => {
    const header = Buffer.alloc(SETUP_OVERLAY_HEADER_BYTES);
    SETUP_OVERLAY_MAGIC.copy(header, 0);
    header.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 2n, 8);
    Buffer.from(sha256Hex(payload), "hex").copy(header, 16);
    const file = Buffer.concat([stub, header, payload]);
    expect(() => parseSetupOverlay(file)).toThrow(/payload size exceeds the supported range/u);
  });
});
