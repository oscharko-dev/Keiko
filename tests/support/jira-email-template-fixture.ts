import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { zipTextEntries } from "./zip-fixture.js";

export const EMAIL_TEMPLATE_ACTOR = { key: "synthetic-admin-key", name: "synthetic-admin" };
export const EMAIL_TEMPLATE_ENTRIES = [
  { name: "templates/issue.vm", content: "Synthetic issue notification: $issue.summary" },
  { name: "templates/footer.vm", content: "Synthetic footer" },
] as const;
export function emailTemplateHash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
// Mapped alias, not an interface: the value is passed as JSON tool arguments and an interface
// has no implicit index signature.
export type EmailTemplateExpectedFile = Readonly<{
  name: string;
  sizeBytes: number;
  sha256: string;
}>;
export interface EmailTemplateFixture {
  readonly bytes: ReturnType<typeof zipTextEntries>;
  readonly pack: {
    readonly archiveBytes: number;
    readonly archiveSha256: string;
    readonly manifestSha256: string;
    readonly entries: readonly {
      readonly path: string;
      readonly sizeBytes: number;
      readonly sha256: string;
    }[];
  };
  readonly expectedFile: EmailTemplateExpectedFile;
  readonly uploadArgs: {
    readonly expectedActorKey: string;
    readonly source: { readonly kind: string; readonly path: string };
    readonly expectedFile: EmailTemplateExpectedFile;
    readonly acceptStagedTemplateReplacement: boolean;
  };
  readonly applyArgs: {
    readonly expectedActorKey: string;
    readonly expectedActiveManifestSha256: string;
    readonly acceptGlobalTemplateChange: boolean;
    readonly acceptUnverifiedStagedPack: boolean;
  };
  readonly revertArgs: {
    readonly expectedActorKey: string;
    readonly expectedActiveManifestSha256: string;
    readonly acceptGlobalTemplateChange: boolean;
  };
}
export function emailTemplateFixture(): EmailTemplateFixture {
  const bytes = zipTextEntries(EMAIL_TEMPLATE_ENTRIES);
  const entries = EMAIL_TEMPLATE_ENTRIES.map(({ name, content }) => ({
    path: name,
    sizeBytes: Buffer.byteLength(content),
    sha256: emailTemplateHash(content),
  })).sort((left, right) => (left.path < right.path ? -1 : Number(left.path > right.path)));
  const pack = {
    archiveBytes: bytes.byteLength,
    archiveSha256: emailTemplateHash(bytes),
    manifestSha256: emailTemplateHash(JSON.stringify(entries)),
    entries,
  };
  const expectedFile = {
    name: "templates.zip",
    sizeBytes: bytes.byteLength,
    sha256: pack.archiveSha256,
  };
  const uploadArgs = {
    expectedActorKey: EMAIL_TEMPLATE_ACTOR.key,
    source: { kind: "connected-file", path: "docs/templates.zip" },
    expectedFile,
    acceptStagedTemplateReplacement: true,
  };
  const applyArgs = {
    expectedActorKey: EMAIL_TEMPLATE_ACTOR.key,
    expectedActiveManifestSha256: pack.manifestSha256,
    acceptGlobalTemplateChange: true,
    acceptUnverifiedStagedPack: true,
  };
  const revertArgs = {
    expectedActorKey: EMAIL_TEMPLATE_ACTOR.key,
    expectedActiveManifestSha256: pack.manifestSha256,
    acceptGlobalTemplateChange: true,
  };
  return { bytes, pack, expectedFile, uploadArgs, applyArgs, revertArgs };
}
/** Addresses in this synthetic ZIP only, for hostile-header regression sources. */
export function emailZipOffsets(bytes: Buffer): { readonly central: number; readonly end: number } {
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50)
    throw new TypeError("Expected a comment-free synthetic ZIP");
  const central = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(central) !== 0x02014b50)
    throw new TypeError("Expected a synthetic central directory");
  return { central, end };
}
