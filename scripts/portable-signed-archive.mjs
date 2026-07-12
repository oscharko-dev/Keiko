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

function rebindSidecars(manifest, resourceRoot, signedExecutables) {
  for (const sidecar of manifest.sidecarRuntimes ?? []) {
    const root = containedResourcePath(resourceRoot, sidecar.payloadRootPath);
    if (signedExecutables) rebindSidecarExecutable(sidecar, root, resourceRoot);
    sidecar.payloadSha256 = hashDirectoryTree(root);
    sidecar.sizeBytes = treeSize(root);
  }
}

function rebindNativeHelper(stageRoot, manifest, resourceRoot) {
  if (manifest.nativeHelpers === undefined) return;
  if (!Array.isArray(manifest.nativeHelpers) || manifest.nativeHelpers.length !== 1) {
    fail("signed payload must contain exactly one native helper");
  }
  const helper = manifest.nativeHelpers[0];
  const executable = containedResourcePath(resourceRoot, helper.executablePath);
  const entry = lstatSync(executable);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    fail("native helper is not a regular single-link file");
  }
  helper.shippedSha256 = sha256Bytes(readFileSync(executable));
  helper.sizeBytes = entry.size;
  const sbomPath = join(stageRoot, "evidence", "sbom.cdx.json");
  let sbom;
  try {
    sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
  } catch {
    fail("portable SBOM is invalid");
  }
  const matches = (sbom.components ?? []).filter(
    (component) => component?.["bom-ref"] === helper.sbomBomRef,
  );
  if (matches.length !== 1) fail("native helper CycloneDX component is missing or ambiguous");
  matches[0].hashes = [{ alg: "SHA-256", content: helper.shippedSha256 }];
  writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rebindSidecarExecutable(sidecar, sidecarRoot, resourceRoot) {
  if (sidecar.executableTreeAlgorithm !== "keiko-directory-tree-sha256-v1") {
    fail("sidecar executable tree algorithm is unsupported");
  }
  const executablePath = containedResourcePath(resourceRoot, sidecar.executablePath);
  const executableRelativePath = portablePath(sidecarRoot, executablePath);
  if (executableRelativePath.startsWith("../") || posix.isAbsolute(executableRelativePath)) {
    fail("sidecar executable escapes its payload root");
  }
  const shippedExecutableSha256 = sha256Bytes(readFileSync(executablePath));
  const shippedExecutableTreeSha256 = sha256Text(
    `${executableRelativePath}\0${shippedExecutableSha256}\0`,
  );
  rewriteSidecarSbom(sidecar, resourceRoot, shippedExecutableSha256);
  sidecar.signing.shippedExecutableSha256 = shippedExecutableSha256;
  sidecar.signing.shippedExecutableTreeAlgorithm = sidecar.executableTreeAlgorithm;
  sidecar.signing.shippedExecutableTreeSha256 = shippedExecutableTreeSha256;
}

function rewriteSidecarSbom(sidecar, resourceRoot, shippedExecutableSha256) {
  const sbomPath = containedResourcePath(resourceRoot, sidecar.sbomEvidence?.path);
  let sbom;
  try {
    sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
  } catch {
    fail("sidecar SBOM is invalid");
  }
  const component = validatedSidecarSbomComponent(sbom, sidecar);
  component.hashes = [{ alg: "SHA-256", content: shippedExecutableSha256 }];
  assertSidecarSbomExecutableHash(component, shippedExecutableSha256);
  const text = `${JSON.stringify(sbom, null, 2)}\n`;
  writeFileSync(sbomPath, text);
  sidecar.sbomEvidence.sha256 = sha256Text(text);
}

function validatedSidecarSbomComponent(sbom, sidecar) {
  const components = Array.isArray(sbom.components)
    ? sbom.components.filter((candidate) => candidate?.name === sidecar.upstream?.name)
    : [];
  if (!sidecarSbomIdentityMatches(sbom, sidecar) || components.length !== 1) {
    fail("sidecar SBOM identity does not match manifest provenance");
  }
  const component = components[0];
  assertSidecarSbomProvenance(component, sidecar);
  return component;
}

function sidecarSbomIdentityMatches(sbom, sidecar) {
  const metadataComponent = sbom.metadata?.component;
  return (
    sbom.bomFormat === "CycloneDX" &&
    metadataComponent?.name === sidecar.name &&
    metadataComponent?.version === sidecar.upstream?.version
  );
}

function assertSidecarSbomProvenance(component, sidecar) {
  const expectedPurl = `pkg:github/${sidecar.upstream.owner}/${sidecar.upstream.repository}@${sidecar.upstream.tag}`;
  const licenseMatches = component.licenses?.some(
    (entry) => entry?.license?.id === sidecar.license?.spdxId,
  );
  const distributionMatches = component.externalReferences?.some(
    (entry) =>
      entry?.type === "distribution" &&
      entry.url === sidecar.archive?.url &&
      entry.hashes?.some(
        (hash) => hash?.alg === "SHA-256" && hash.content === sidecar.archive?.sha256,
      ),
  );
  if (
    component.version !== sidecar.upstream.version ||
    component.purl !== expectedPurl ||
    licenseMatches !== true ||
    distributionMatches !== true
  ) {
    fail("sidecar SBOM provenance does not match manifest");
  }
  assertSidecarSbomExecutableHash(component, sidecar.executableSha256);
}

function assertSidecarSbomExecutableHash(component, expectedSha256) {
  const hashes = component.hashes?.filter((hash) => hash?.alg === "SHA-256") ?? [];
  if (hashes.length !== 1 || hashes[0].content !== expectedSha256) {
    fail("sidecar SBOM executable hash does not match expected bytes");
  }
}

export function rebindSignedPayload(stageRoot, manifest, platformTarget) {
  const resourceRoot = portableResourceRoot(stageRoot, platformTarget);
  rebindSidecars(manifest, resourceRoot, true);
  rebindNativeHelper(stageRoot, manifest, resourceRoot);
  manifest.provenance.packagedAppTreeSha256 = hashDirectoryTree(
    containedResourcePath(resourceRoot, "app"),
  );
}

function rebindReviewedBinding(manifest, archiveSha256) {
  const binding = manifest.releaseImpact.reviewedBinding;
  binding.archiveSha256 = archiveSha256;
  binding.assetSizeBytes = manifest.artifact.sizeBytes;
  binding.provenanceStatementSha256 = manifest.provenance.provenanceStatementSha256;
  if (manifest.sidecarRuntimes !== undefined) {
    binding.sidecarRuntimes = JSON.parse(JSON.stringify(manifest.sidecarRuntimes));
  }
  if (manifest.nativeHelpers !== undefined) {
    binding.nativeHelpers = JSON.parse(JSON.stringify(manifest.nativeHelpers));
  }
}

export async function rebindExistingSignedArchive(
  stageRoot,
  manifest,
  archivePath,
  platformTarget = manifest.artifact?.platformTarget,
  options = {},
) {
  if (options.payloadAlreadyRebound !== true) {
    if (platformTarget === "windows-x64") {
      rebindSignedPayload(stageRoot, manifest, platformTarget);
    } else {
      const resourceRoot = portableResourceRoot(stageRoot, platformTarget);
      rebindSidecars(manifest, resourceRoot, false);
      manifest.provenance.packagedAppTreeSha256 = hashDirectoryTree(
        containedResourcePath(resourceRoot, "app"),
      );
    }
  }
  const archiveSha256 = await sha256File(archivePath);
  const provenancePath = join(stageRoot, "evidence", "provenance.intoto.jsonl");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  provenance.subjectDigest = archiveSha256;
  if (manifest.nativeHelpers !== undefined) {
    provenance.nativeHelpers = manifest.nativeHelpers.map((helper) => ({
      architecture: helper.architecture,
      executablePath: helper.executablePath,
      name: helper.name,
      shippedSha256: helper.shippedSha256,
      signatureKind: helper.signing.signatureKind,
      signatureVerified: helper.signing.signatureVerified,
      notarizationVerified: helper.signing.notarizationVerified,
      sourceTreeSha256: helper.source.treeSha256,
      unsignedSha256: helper.unsignedSha256,
    }));
  }
  const provenanceText = `${JSON.stringify(provenance)}\n`;
  manifest.artifact.sha256 = archiveSha256;
  manifest.artifact.sizeBytes = statSync(archivePath).size;
  manifest.provenance.provenanceStatementSha256 = sha256Text(provenanceText);
  rebindReviewedBinding(manifest, archiveSha256);
  writeFileSync(provenancePath, provenanceText);
  writeFileSync(
    join(stageRoot, "evidence", "SHA256SUMS.txt"),
    `${archiveSha256}  ${basename(archivePath)}\n`,
  );
}
