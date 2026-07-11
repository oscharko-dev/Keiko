import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, posix, relative, resolve } from "node:path";

import { hashDirectoryTree, portableTargetByName, sha256File } from "./portable-runtime.mjs";

export class PortableSignedArchiveError extends Error {}

function fail(message) {
  throw new PortableSignedArchiveError(`portable-signed-archive: ${message}`);
}

function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function portablePath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

export function portableResourceRoot(stageRoot, platformTarget) {
  const target = portableTargetByName(platformTarget);
  if (target === undefined) fail("manifest target is unsupported");
  const payloadRoot = join(stageRoot, "payload", "Keiko");
  return target.nodePlatform === "darwin"
    ? join(payloadRoot, "Keiko.app", "Contents", "Resources")
    : payloadRoot;
}

function treeSize(root) {
  let size = 0;
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const entry = lstatSync(path);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) size += entry.size;
      else fail("signed payload contains an unsupported entry");
    }
  };
  walk(root);
  return size;
}

function containedResourcePath(resourceRoot, relativePath) {
  if (typeof relativePath !== "string" || posix.isAbsolute(relativePath))
    fail("resource path is not canonical");
  const root = resolve(resourceRoot);
  const path = resolve(root, relativePath);
  if (portablePath(root, path) !== relativePath) fail("resource path is not canonical");
  return path;
}

function rebindSidecars(manifest, resourceRoot) {
  for (const sidecar of manifest.sidecarRuntimes ?? []) {
    const root = containedResourcePath(resourceRoot, sidecar.payloadRootPath);
    sidecar.payloadSha256 = hashDirectoryTree(root);
    sidecar.sizeBytes = treeSize(root);
  }
}

function rebindReviewedBinding(manifest, archiveSha256) {
  const binding = manifest.releaseImpact.reviewedBinding;
  binding.archiveSha256 = archiveSha256;
  binding.assetSizeBytes = manifest.artifact.sizeBytes;
  binding.provenanceStatementSha256 = manifest.provenance.provenanceStatementSha256;
  if (manifest.sidecarRuntimes !== undefined) {
    binding.sidecarRuntimes = JSON.parse(JSON.stringify(manifest.sidecarRuntimes));
  }
}

export async function rebindExistingSignedArchive(
  stageRoot,
  manifest,
  archivePath,
  platformTarget = manifest.artifact?.platformTarget,
) {
  const resourceRoot = portableResourceRoot(stageRoot, platformTarget);
  const archiveSha256 = await sha256File(archivePath);
  const provenancePath = join(stageRoot, "evidence", "provenance.intoto.jsonl");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  provenance.subjectDigest = archiveSha256;
  const provenanceText = `${JSON.stringify(provenance)}\n`;
  manifest.artifact.sha256 = archiveSha256;
  manifest.artifact.sizeBytes = statSync(archivePath).size;
  manifest.provenance.packagedAppTreeSha256 = hashDirectoryTree(
    containedResourcePath(resourceRoot, "app"),
  );
  manifest.provenance.provenanceStatementSha256 = sha256Text(provenanceText);
  rebindSidecars(manifest, resourceRoot);
  rebindReviewedBinding(manifest, archiveSha256);
  writeFileSync(provenancePath, provenanceText);
  writeFileSync(
    join(stageRoot, "evidence", "SHA256SUMS.txt"),
    `${archiveSha256}  ${basename(archivePath)}\n`,
  );
}
