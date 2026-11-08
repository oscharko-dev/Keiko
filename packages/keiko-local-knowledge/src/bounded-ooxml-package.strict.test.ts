import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { emailZipOffsets } from "../../../tests/support/jira-email-template-fixture.js";
import { readBoundedOoxmlPackage } from "./bounded-ooxml-package.js";
import { zipTextEntries } from "./parsers/parser-test-fixtures.js";
import { regularZipEntry, zipEntryKind } from "./zip-entry-kind.js";

const OPTIONS = { maxInputBytes: 4096, maxEntries: 8, maxInflatedBytes: 4096, timeoutMs: 1000, now: () => 0 };
const STRICT = { ...OPTIONS, rejectNonRegularEntries: true };
function one() { return Buffer.from(zipTextEntries([{ name: "template.vm", content: "Safe synthetic $value" }])); }
function withAttributes(attributes: number) {
  const bytes = one();
  bytes.writeUInt32LE(attributes, emailZipOffsets(bytes).central + 38);
  return bytes;
}
it("uses the existing reader for regular files and explicit empty directories", async () => {
  const bytes = zipTextEntries([{ name: "templates/", content: "" }, { name: "templates/issue.vm", content: "Safe" }]);
  const result = await readBoundedOoxmlPackage(bytes, STRICT);
  expect(result.ok).toBe(true);
  if (result.ok) expect([...result.parts.keys()]).toEqual(["templates/", "templates/issue.vm"]);
});
it.each([0o120000, 0o020000, 0o060000, 0o010000, 0o140000])("refuses nonregular Unix mode %i only in explicit strict mode", async (mode) => {
  const bytes = withAttributes((mode << 16) >>> 0);
  expect(await readBoundedOoxmlPackage(bytes, STRICT)).toEqual({ ok: false, reason: "malformed" });
  expect((await readBoundedOoxmlPackage(bytes, OPTIONS)).ok).toBe(true);
});
it.each([0x400, 0x10])("refuses Windows alias attribute %i on a file", async (attribute) => {
  expect(await readBoundedOoxmlPackage(withAttributes(attribute), STRICT)).toEqual({ ok: false, reason: "malformed" });
});
it("retains ordinary portable classification while strict submission refuses disguised links", () => {
  const entry = { fileName: "linked/", externalFileAttributes: (0o120000 << 16) >>> 0 };
  expect(zipEntryKind(entry)).toBe("directory");
  expect(regularZipEntry(entry)).toBe(false);
});
it("refuses local/central filename disagreement", async () => {
  const bytes = one();
  bytes[30] = 0x78;
  expect(await readBoundedOoxmlPackage(bytes, STRICT)).toEqual({ ok: false, reason: "malformed" });
});
it("refuses native encryption even when the stored bytes look like a plain archive", async () => {
  const bytes = one();
  bytes.writeUInt16LE(1, 6);
  bytes.writeUInt16LE(1, emailZipOffsets(bytes).central + 8);
  expect(await readBoundedOoxmlPackage(bytes, STRICT)).toEqual({ ok: false, reason: "malformed" });
});
it("refuses unsupported masked-header flags", async () => {
  const bytes = one();
  bytes.writeUInt16LE(0x2000, 6);
  bytes.writeUInt16LE(0x2000, emailZipOffsets(bytes).central + 8);
  expect(await readBoundedOoxmlPackage(bytes, STRICT)).toEqual({ ok: false, reason: "malformed" });
});
function withExtraField(id: number): Buffer {
  const original = one();
  const { central, end } = emailZipOffsets(original);
  const localNameEnd = 30 + original.readUInt16LE(26);
  const centralNameEnd = central + 46 + original.readUInt16LE(central + 28);
  const extra = Buffer.alloc(5);
  extra.writeUInt16LE(id, 0);
  extra.writeUInt16LE(1, 2);
  const bytes = Buffer.concat([original.subarray(0, localNameEnd), extra,
    original.subarray(localNameEnd, centralNameEnd), extra, original.subarray(centralNameEnd)]);
  bytes.writeUInt16LE(extra.length, 28);
  bytes.writeUInt16LE(extra.length, central + extra.length + 30);
  bytes.writeUInt32LE(original.readUInt32LE(end + 12) + extra.length, bytes.length - 10);
  bytes.writeUInt32LE(central + extra.length, bytes.length - 6);
  return bytes;
}
it.each([0x7075, 0x0001])("refuses alias/ZIP64 extra field %i instead of applying a second filename representation", async (id) => {
  expect(await readBoundedOoxmlPackage(withExtraField(id), STRICT)).toEqual({ ok: false, reason: "malformed" });
});
it("checks the actual inflated CRC rather than trusting matching header values", async () => {
  const bytes = one();
  bytes.writeUInt32LE(0, 14);
  bytes.writeUInt32LE(0, emailZipOffsets(bytes).central + 16);
  expect(await readBoundedOoxmlPackage(bytes, STRICT)).toEqual({ ok: false, reason: "malformed" });
});
it("refuses unaccounted bytes between local files and the central directory", async () => {
  const original = one();
  const { central } = emailZipOffsets(original);
  const bytes = Buffer.concat([original.subarray(0, central), Buffer.from([0]), original.subarray(central)]);
  bytes.writeUInt32LE(central + 1, bytes.length - 6);
  expect(await readBoundedOoxmlPackage(bytes, STRICT)).toEqual({ ok: false, reason: "malformed" });
  expect((await readBoundedOoxmlPackage(bytes, OPTIONS)).ok).toBe(true);
});
function descriptorZip() {
  const original = one();
  const { central } = emailZipOffsets(original);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  original.copy(descriptor, 4, 14, 26);
  const bytes = Buffer.concat([original.subarray(0, central), descriptor, original.subarray(central)]);
  bytes.writeUInt16LE(8, 6);
  bytes.fill(0, 14, 26);
  bytes.writeUInt16LE(8, central + 16 + 8);
  bytes.writeUInt32LE(central + 16, bytes.length - 6);
  return bytes;
}
it("supports a complete standard data descriptor while checking its exact sizes and CRC", async () => {
  const bytes = descriptorZip();
  expect((await readBoundedOoxmlPackage(bytes, STRICT)).ok).toBe(true);
  const { central } = emailZipOffsets(bytes);
  bytes.writeUInt32LE(0, central - 12);
  expect(await readBoundedOoxmlPackage(bytes, STRICT)).toEqual({ ok: false, reason: "malformed" });
});
it("refuses contradictory nonzero local sizes even with a correct data descriptor", async () => {
  const bytes = descriptorZip();
  bytes.writeUInt32LE(1, 18);
  expect(await readBoundedOoxmlPackage(bytes, STRICT)).toEqual({ ok: false, reason: "malformed" });
});
it("retains the existing inflate budget with an explicit strict bounds classification", async () => {
  expect(await readBoundedOoxmlPackage(one(), { ...STRICT, maxInflatedBytes: 8 })).toEqual({ ok: false, reason: "oversized" });
  expect(await readBoundedOoxmlPackage(one(), { ...OPTIONS, maxInflatedBytes: 8 })).toEqual({ ok: false, reason: "malformed" });
});
it("retains cancellation and entry ceilings in the same reader", async () => {
  expect(await readBoundedOoxmlPackage(one(), { ...STRICT, signal: AbortSignal.abort() })).toEqual({ ok: false, reason: "cancelled" });
  expect(await readBoundedOoxmlPackage(one(), { ...STRICT, maxEntries: 0 })).toEqual({ ok: false, reason: "budget" });
});
