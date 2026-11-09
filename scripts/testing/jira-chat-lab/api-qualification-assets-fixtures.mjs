// Real Files grants and independent native asset observations for the synthetic AC7 lab.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readBoundedOoxmlPackage } from "@oscharko-dev/keiko-local-knowledge";
import { basicAuth, labSessionConnection } from "./lab-client.mjs";
import { connectQualificationFile } from "./api-qualification-fixtures.mjs";
import { createZip } from "./requirements/ooxml-zip.mjs";
import { writeCorpusDocuments } from "./requirements/corpus-documents.mjs";

const assetHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 1000;

export async function assetPack(bytes) {
  const observed = await readBoundedOoxmlPackage(bytes, {
    maxInputBytes: MAX_BYTES,
    maxEntries: MAX_ENTRIES,
    maxInflatedBytes: 64 * 1024 * 1024,
    timeoutMs: 15000,
    now: Date.now,
    rejectNonRegularEntries: true,
  });
  assert.equal(observed.ok, true, "A complete independently readable native ZIP is required");
  const entries = [...observed.parts]
    .map(([path, body]) => ({ path, sizeBytes: body.byteLength, sha256: assetHash(body) }))
    .sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));
  assert.ok(entries.length > 0, "A nonempty native pack is required");
  return {
    archiveBytes: bytes.byteLength,
    archiveSha256: assetHash(bytes),
    manifestSha256: assetHash(JSON.stringify(entries)),
    entries,
  };
}

/** Fixed authenticated GET only. Native ZIP bytes never pass through the product read projection. */
export async function observeEmailPack(context) {
  const origin = labSessionConnection(context.session).origin;
  const response = await globalThis.fetch(`${origin}/rest/api/2/email-templates`, {
    method: "GET",
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(30000),
    headers: {
      Accept: "application/zip",
      Authorization: basicAuth(context.session, context.actor),
    },
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of response.body) {
    byteCount += chunk.byteLength;
    assert.ok(byteCount <= MAX_BYTES, "Native email export exceeds the existing byte limit");
    chunks.push(chunk);
  }
  return assetPack(Buffer.concat(chunks));
}

function assetDirectory(context, f) {
  assert.match(f.runId, /^[A-Za-z0-9-]{1,80}$/u);
  const root = realpathSync(context.projectPath);
  const directory = join(root, "ac7-assets", f.runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(directory), directory, "Synthetic Files sources must stay contained");
  return { root, directory };
}

/** Rebind actual Files authority on every batch's newly created product Chat. */
function connectAsset(context, f, path) {
  return connectQualificationFile(
    context,
    f,
    relative(realpathSync(context.projectPath), path),
    context.qualificationChat,
  );
}

export async function prepareAttachmentSource(context, f) {
  const { directory } = assetDirectory(context, f);
  const [document] = writeCorpusDocuments(directory);
  f.assetAttachmentFile = await connectAsset(context, f, document);
  f.assetArchivePack = await assetPack(readFileSync(document));
}

/** Defaults are an explicit operator fixture from the fresh owned native image, never inferred. */
export async function requireEmailDefault(context, f) {
  if (f.assetEmailDefault !== undefined) {
    assert.equal(f.assetEmailDefaultRelease, context.session.jiraVersion);
    assert.equal(f.assetEmailDefaultImage, context.session.jiraImageDigest);
    return;
  }
  assert.equal(
    typeof context.qualificationEmailDefaultOracle,
    "function",
    "Supply the verified default email pack from the fresh owned native image before changing templates",
  );
  const expected = await context.qualificationEmailDefaultOracle(context);
  const native = await observeEmailPack(context);
  assert.equal(native.manifestSha256, expected.manifestSha256);
  assert.deepEqual(native.entries, expected.entries);
  f.assetEmailDefault = native;
  f.assetEmailDefaultRelease = context.session.jiraVersion;
  f.assetEmailDefaultImage = context.session.jiraImageDigest;
}
export function qualificationEmailZip(prior, f) {
  f.assetEmailSequence = (f.assetEmailSequence ?? 0) + 1;
  const body = `Synthetic AC7 notification ${f.runId} phase ${f.assetEmailSequence}\n`;
  return createZip(
    prior.entries.map((entry) => ({
      name: entry.path,
      data: entry.path.endsWith("/") ? "" : body,
    })),
  );
}
/** Use native paths from a complete export, with synthetic text built by the existing ZIP writer. */
export async function prepareEmailSource(context, f) {
  await requireEmailDefault(context, f);
  const { directory } = assetDirectory(context, f);
  const prior = await observeEmailPack(context);
  const zip = qualificationEmailZip(prior, f);
  const path = join(directory, "email-templates.zip");
  writeFileSync(path, zip, { mode: 0o600 });
  f.assetEmailFile = await connectAsset(context, f, path);
  f.assetEmailPack = await assetPack(zip);
  assert.notEqual(f.assetEmailPack.manifestSha256, prior.manifestSha256);
  f.assetEmailPrior = prior;
}
