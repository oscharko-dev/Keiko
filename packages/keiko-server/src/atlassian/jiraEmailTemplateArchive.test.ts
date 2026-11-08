import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { emailTemplateFixture, emailZipOffsets } from "../../../../tests/support/jira-email-template-fixture.js";
import { zipTextEntries, withArchiveComment } from "../../../../tests/support/zip-fixture.js";
import { inspectJiraEmailTemplateArchive as inspect } from "./jiraEmailTemplateArchive.js";
import { admitAttachmentContent } from "./jiraAttachmentContentPolicy.js";

const OPTIONS = { secrets: [], now: () => 0 };
it("projects only complete sorted metadata through the credential floor", async () => {
  const { bytes, pack } = emailTemplateFixture();
  expect(await inspect(bytes, OPTIONS)).toEqual({ ok: true, value: pack });
  expect(JSON.stringify(await inspect(bytes, OPTIONS))).not.toContain("$issue.summary");
});
it("binds content metadata independently of raw ZIP comments/compression metadata", async () => {
  const { bytes, pack } = emailTemplateFixture();
  const result = await inspect(withArchiveComment(bytes, "synthetic export timestamp metadata"), OPTIONS);
  expect(result).toMatchObject({ ok: true, value: { manifestSha256: pack.manifestSha256 } });
  if (result.ok) expect(result.value.archiveSha256).not.toBe(pack.archiveSha256);
});
it.each(["../escape.vm", "/absolute.vm", "x\\escape.vm", "CON.vm", "dir./x.vm", "dir /x.vm", "a%2fb.vm", "drive:x.vm"])("refuses unsafe portable path %s without filesystem extraction", async (name) => {
  const result = await inspect(zipTextEntries([{ name, content: "safe" }]), OPTIONS);
  expect(result).toMatchObject({ ok: false, reason: "malformed-payload" });
});
it.each([
  ["a.vm", "A.vm"], ["path", "path/child.vm"], ["empty/", "empty"], ["same.vm", "same.vm"],
])("refuses colliding or file-parent paths %s and %s", async (first, second) => {
  expect(await inspect(zipTextEntries([{ name: first, content: "" }, { name: second, content: "" }]), OPTIONS)).toMatchObject({ ok: false, reason: "malformed-payload" });
});
it("refuses Unicode normalization aliases rather than guessing the native extraction name", async () => {
  const bytes = Buffer.from(zipTextEntries([{ name: "cafe\u0301.vm", content: "safe" }]));
  bytes.writeUInt16LE(0x800, 6);
  bytes.writeUInt16LE(0x800, emailZipOffsets(bytes).central + 8);
  expect(await inspect(bytes, OPTIONS)).toMatchObject({ ok: false, reason: "malformed-payload" });
});
it("retains an unambiguous canonical UTF-8 filename exactly", async () => {
  const bytes = Buffer.from(zipTextEntries([{ name: "café.vm", content: "safe" }]));
  bytes.writeUInt16LE(0x800, 6);
  bytes.writeUInt16LE(0x800, emailZipOffsets(bytes).central + 8);
  expect(await inspect(bytes, OPTIONS)).toMatchObject({ ok: true, value: { entries: [{ path: "café.vm" }] } });
});
it("preserves zero-byte files and explicit empty directory entries truthfully", async () => {
  const result = await inspect(zipTextEntries([{ name: "empty/", content: "" }, { name: "empty/a.vm", content: "" }]), OPTIONS);
  expect(result).toMatchObject({ ok: true, value: { entries: [{ path: "empty/", sizeBytes: 0 }, { path: "empty/a.vm", sizeBytes: 0 }] } });
});
it("refuses a compressed configured credential and container metadata credentials", async () => {
  const secret = ["synthetic", "configured", "value", "only"].join("-");
  const body = zipTextEntries([{ name: "a.vm", content: secret }]);
  const options = { secrets: [secret], now: () => 0 };
  expect(await inspect(body, options)).toMatchObject({ ok: false, contentRefusal: "contains-credential" });
  expect(await inspect(withArchiveComment(emailTemplateFixture().bytes, secret), options)).toMatchObject({ ok: false, contentRefusal: "contains-credential" });
});
it("refuses unscannable opaque parts without returning their contents", async () => {
  const result = await inspect(zipTextEntries([{ name: "opaque.bin", content: "\u0000\u0001\u0002" }]), OPTIONS);
  expect(result).toMatchObject({ ok: false, contentRefusal: "unscannable" });
  expect(JSON.stringify(result)).not.toContain("opaque.bin");
});
it("does not admit ordinary generic ZIP attachments as a side effect of this purpose", async () => {
  const { bytes } = emailTemplateFixture();
  expect(await admitAttachmentContent({ bytes, name: "templates.zip", secrets: [] })).toEqual({ ok: false, refusal: "unscannable" });
  expect((await inspect(bytes, OPTIONS)).ok).toBe(true);
});
it("refuses incomplete entry populations instead of truncating a claimed complete manifest", async () => {
  const bytes = zipTextEntries(Array.from({ length: 1001 }, (_, index) => ({ name: `p${String(index)}.vm`, content: "" })));
  expect(await inspect(bytes, OPTIONS)).toEqual({ ok: false, reason: "bounds-exceeded" });
});
it("preserves local cancellation without a native HTTP claim", async () => {
  expect(await inspect(emailTemplateFixture().bytes, { ...OPTIONS, signal: AbortSignal.abort() })).toEqual({ ok: false, reason: "cancelled" });
});
