import {
  cpSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findPortableMetadataRedactionFailures,
  hashDirectoryTree,
  portableVerificationSummaryForManifest,
  PORTABLE_TARGETS,
  sha256File,
  validatePortableCandidateManifest,
} from "./portable-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const BUNDLE_MANIFEST_NAME = "portable-assets.json";
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

function fail(message) {
  throw new Error(`assemble-portable-release-assets: ${message}`);
}

function parseArgs(argv) {
  const options = {
    bundleRoot: join(repoRoot, ".portable-release-assets"),
    commitSha: process.env.GITHUB_SHA ?? "",
    releaseTag: process.env.GITHUB_REF_NAME ?? "",
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
    runId: Number(process.env.GITHUB_RUN_ID ?? 0),
    stagePrefix: "portable-stage-",
    version: rootPackage.version,
  };
  const fields = new Map([
    ["--bundle-root", "bundleRoot"],
    ["--commit-sha", "commitSha"],
    ["--release-tag", "releaseTag"],
    ["--run-attempt", "runAttempt"],
    ["--run-id", "runId"],
    ["--stage-prefix", "stagePrefix"],
    ["--version", "version"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const field = fields.get(argv[index]);
    const value = argv[index + 1];
    if (field === undefined || value === undefined || value.startsWith("--"))
      fail("invalid arguments");
    options[field] = ["runAttempt", "runId"].includes(field) ? Number(value) : value;
  }
  options.bundleRoot = resolve(options.bundleRoot);
  return options;
}

function requiredDirectory(path, label) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    fail(`missing ${label}`);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`${label} must be a regular directory`);
  return realpathSync(path);
}

function contained(root, candidate) {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

function regularContainedFile(root, relativePath, label, maxBytes = MAX_EVIDENCE_BYTES) {
  const candidate = resolve(root, relativePath);
  if (!contained(root, candidate)) fail(`${label} escapes the target artifact`);
  let entry;
  try {
    entry = lstatSync(candidate);
  } catch {
    fail(`missing ${label}`);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
    fail(`${label} must be a regular unlinked file`);
  if (!contained(root, realpathSync(candidate))) fail(`${label} escapes the target artifact`);
  if (entry.size === 0 || entry.size > maxBytes) fail(`${label} has an invalid bounded size`);
  return candidate;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function field(value, ...keys) {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function commonIdentity(manifest) {
  return canonical({
    packageSurface: manifest.packageSurface,
    packageVersion: field(manifest, "product", "packageVersion"),
    releaseImpact: {
      catalogPath: field(manifest, "releaseImpact", "catalogPath"),
      entryId: field(manifest, "releaseImpact", "entryId"),
      entryPackageVersion: field(manifest, "releaseImpact", "entryPackageVersion"),
      entryReleaseTag: field(manifest, "releaseImpact", "entryReleaseTag"),
    },
    releaseTag: field(manifest, "release", "releaseTag"),
    sourceCommitSha: field(manifest, "release", "commitSha"),
    provenance: {
      buildWorkflowAttempt: field(manifest, "provenance", "buildWorkflowAttempt"),
      buildWorkflowRunId: field(manifest, "provenance", "buildWorkflowRunId"),
      rootPackageTarballSha256: field(manifest, "provenance", "rootPackageTarballSha256"),
      rootPackageVersion: field(manifest, "provenance", "rootPackageVersion"),
      sourceCommitSha: field(manifest, "provenance", "sourceCommitSha"),
    },
    securityState: {
      verificationPolicy: field(manifest, "security", "verificationPolicy"),
      verificationReasonCodes: field(manifest, "security", "verificationReasonCodes"),
      verificationStatus: field(manifest, "security", "verificationStatus"),
    },
    stateExclusion: manifest.stateExclusion,
    updateEligibility: manifest.updateEligibility,
  });
}

function targetFailures(manifest, target, expected) {
  const failures = validatePortableCandidateManifest(manifest);
  const checks = [
    [
      "artifact.platformTarget",
      field(manifest, "artifact", "platformTarget"),
      target.platformTarget,
    ],
    ["artifact.assetName", field(manifest, "artifact", "assetName"), target.assetName],
    ["runtime.nodePlatform", field(manifest, "runtime", "nodePlatform"), target.nodePlatform],
    [
      "runtime.nodeArchitecture",
      field(manifest, "runtime", "nodeArchitecture"),
      target.nodeArchitecture,
    ],
    ["product.packageVersion", field(manifest, "product", "packageVersion"), expected.version],
    ["release.releaseTag", field(manifest, "release", "releaseTag"), expected.releaseTag],
    ["release.commitSha", field(manifest, "release", "commitSha"), expected.commitSha],
    [
      "provenance.sourceCommitSha",
      field(manifest, "provenance", "sourceCommitSha"),
      expected.commitSha,
    ],
    [
      "provenance.rootPackageVersion",
      field(manifest, "provenance", "rootPackageVersion"),
      expected.version,
    ],
    [
      "provenance.buildWorkflowRunId",
      field(manifest, "provenance", "buildWorkflowRunId"),
      expected.runId,
    ],
    [
      "provenance.buildWorkflowAttempt",
      field(manifest, "provenance", "buildWorkflowAttempt"),
      expected.runAttempt,
    ],
  ];
  for (const [path, actual, wanted] of checks)
    if (actual !== wanted) failures.push(`${path}: does not match qualification input`);
  return failures;
}

function collectTargetManifests(manifests, failures) {
  if (!Array.isArray(manifests) || manifests.length !== PORTABLE_TARGETS.length) {
    failures.push("release set must contain exactly three portable targets");
  }
  const byTarget = new Map();
  for (const manifest of manifests ?? []) {
    const name = field(manifest, "artifact", "platformTarget");
    if (
      typeof name !== "string" ||
      !PORTABLE_TARGETS.some((target) => target.platformTarget === name)
    ) {
      failures.push(`unsupported or relabelled portable target ${String(name)}`);
      continue;
    }
    if (byTarget.has(name)) failures.push(`duplicate portable target ${name}`);
    byTarget.set(name, manifest);
  }
  return byTarget;
}

function validateRequiredTargets(byTarget, expected, failures) {
  for (const target of PORTABLE_TARGETS) {
    const manifest = byTarget.get(target.platformTarget);
    if (manifest === undefined) failures.push(`missing portable target ${target.platformTarget}`);
    else
      failures.push(
        ...targetFailures(manifest, target, expected).map(
          (failure) => `${target.platformTarget}.${failure}`,
        ),
      );
  }
}

// Deliberate defense-in-depth: release-publish.mjs (portableAssetsFromManifest) re-enforces this
// same exact-three/qualification-binding invariant at the publish trust boundary; keep in sync.
export function validatePortableReleaseSet(manifests, expected) {
  const failures = [];
  const byTarget = collectTargetManifests(manifests, failures);
  validateRequiredTargets(byTarget, expected, failures);
  const identities = [...byTarget.values()].map((manifest) =>
    JSON.stringify(commonIdentity(manifest)),
  );
  if (new Set(identities).size > 1)
    failures.push("portable targets do not share one release identity");
  return failures;
}

function assertExactDownloadedSet(artifactsRoot, prefix) {
  const expected = new Set(PORTABLE_TARGETS.map((target) => `${prefix}${target.platformTarget}`));
  const actual = readdirSync(artifactsRoot);
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
    fail("downloaded artifacts must be exactly the three canonical target names");
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
}

function assertEvidenceText(path, label) {
  const text = readFileSync(path, "utf8");
  const failures = findPortableMetadataRedactionFailures(text, label);
  if (/\.(?:json|jsonl)$/u.test(path)) {
    try {
      failures.push(...findPortableMetadataRedactionFailures(JSON.parse(text), label));
    } catch {
      fail(`${label} must contain valid JSON`);
    }
  }
  if (failures.length > 0) fail(`${label} contains forbidden metadata`);
  return text;
}

function assertEvidence(stageRoot, manifest, target) {
  assertChecksumEvidence(stageRoot, manifest, target);
  assertSigningAndProvenanceEvidence(stageRoot, manifest, target);
  const sbomPath = regularContainedFile(stageRoot, manifest.evidence.sbomPath, "SBOM evidence");
  assertEvidenceText(sbomPath, "SBOM evidence");
  const sbom = readJson(sbomPath, "SBOM evidence");
  if (sbom.bomFormat !== "CycloneDX") fail(`${target.platformTarget} SBOM evidence is invalid`);
  assertNativeHelperEvidence(stageRoot, manifest, target, sbom);
  assertEvidenceText(
    regularContainedFile(stageRoot, manifest.evidence.licenseNoticePath, "license evidence"),
    "license evidence",
  );
  assertSidecarEvidence(stageRoot, manifest, target);
}

// This release gate deliberately evaluates the complete helper proof in one atomic assertion.
// eslint-disable-next-line complexity
function assertNativeHelperEvidence(stageRoot, manifest, target, sbom) {
  if (!Array.isArray(manifest.nativeHelpers) || manifest.nativeHelpers.length !== 1) {
    fail(`${target.platformTarget} must contain exactly one native helper`);
  }
  const helper = manifest.nativeHelpers[0];
  if (
    helper.signing?.verificationStatus !== "verified-production" ||
    helper.signing?.signatureVerified !== true ||
    (target.nodePlatform === "darwin" && helper.signing?.notarizationVerified !== true)
  ) {
    fail(`${target.platformTarget} native helper is not production verified`);
  }
  const resourceRoot = sidecarPayloadRoot(stageRoot, target);
  const executable = regularContainedFile(resourceRoot, helper.executablePath, "native helper");
  const bytes = readFileSync(executable);
  if (
    createHash("sha256").update(bytes).digest("hex") !== helper.shippedSha256 ||
    bytes.length !== helper.sizeBytes
  ) {
    fail(`${target.platformTarget} native helper bytes do not match the manifest`);
  }
  const components = (sbom.components ?? []).filter(
    (component) => component?.["bom-ref"] === helper.sbomBomRef,
  );
  const hashes = components[0]?.hashes?.filter((hash) => hash?.alg === "SHA-256") ?? [];
  if (
    components.length !== 1 ||
    hashes.length !== 1 ||
    hashes[0].content !== helper.shippedSha256
  ) {
    fail(`${target.platformTarget} native helper SBOM binding is invalid`);
  }
}

function assertChecksumEvidence(stageRoot, manifest, target) {
  const checksum = assertEvidenceText(
    regularContainedFile(stageRoot, manifest.evidence.checksumsPath, "checksum evidence"),
    "checksum evidence",
  );
  if (checksum !== `${manifest.artifact.sha256}  ${manifest.artifact.assetName}\n`)
    fail(`${target.platformTarget} checksum evidence does not bind the archive`);
}

function assertSigningAndProvenanceEvidence(stageRoot, manifest, target) {
  const summaryPath = regularContainedFile(
    stageRoot,
    manifest.security.verificationSummaryPath,
    "signing summary",
  );
  assertEvidenceText(summaryPath, "signing summary");
  if (
    JSON.stringify(readJson(summaryPath, "signing summary")) !==
    JSON.stringify(portableVerificationSummaryForManifest(manifest))
  )
    fail(`${target.platformTarget} signing summary does not match the manifest`);
  const provenancePath = regularContainedFile(
    stageRoot,
    manifest.provenance.provenanceStatementPath,
    "provenance statement",
  );
  const provenanceText = assertEvidenceText(provenancePath, "provenance statement");
  if (
    createHash("sha256").update(provenanceText).digest("hex") !==
    manifest.provenance.provenanceStatementSha256
  )
    fail(`${target.platformTarget} provenance digest does not match`);
  const statement = readJson(provenancePath, "provenance statement");
  const semantics = [
    statement.artifact === manifest.artifact.assetName,
    statement.subjectDigest === manifest.artifact.sha256,
    statement.target === target.platformTarget,
    statement.sourceCommitSha === manifest.release.commitSha,
    statement.packageVersion === manifest.product.packageVersion,
    statement.buildWorkflowRunId === manifest.provenance.buildWorkflowRunId,
    statement.buildWorkflowAttempt === manifest.provenance.buildWorkflowAttempt,
    nativeHelperProvenanceMatches(statement, manifest),
  ];
  if (semantics.some((value) => !value))
    fail(`${target.platformTarget} provenance semantics do not match`);
}

// Exact provenance equality is clearer as one conjunction than as partial mutable checks.
// eslint-disable-next-line complexity
function nativeHelperProvenanceMatches(statement, manifest) {
  const actual = statement.nativeHelpers?.[0];
  const expected = manifest.nativeHelpers?.[0];
  return (
    statement.nativeHelpers?.length === 1 &&
    actual?.unsignedSha256 === expected?.unsignedSha256 &&
    actual?.sourceTreeSha256 === expected?.source?.treeSha256 &&
    actual?.shippedSha256 === expected?.shippedSha256 &&
    actual?.signatureKind === expected?.signing?.signatureKind &&
    actual?.signatureVerified === true &&
    actual?.notarizationVerified === expected?.signing?.notarizationVerified
  );
}

function sidecarPayloadRoot(stageRoot, target) {
  const payload = join(stageRoot, "payload", "Keiko");
  return target.nodePlatform === "darwin"
    ? join(payload, "Keiko.app", "Contents", "Resources")
    : payload;
}

function boundedTreeSize(root) {
  let total = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const entry = lstatSync(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) total += boundedTreeSize(path);
    else if (entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1) total += entry.size;
    else fail("sidecar payload contains an unsafe filesystem entry");
  }
  return total;
}

function assertSidecarEvidence(stageRoot, manifest, target) {
  const resourceRoot = sidecarPayloadRoot(stageRoot, target);
  for (const sidecar of manifest.sidecarRuntimes ?? []) {
    const root = requiredDirectory(
      resolve(resourceRoot, sidecar.payloadRootPath),
      "sidecar payload",
    );
    if (!contained(resourceRoot, root)) fail("sidecar payload escapes the portable resource root");
    if (
      hashDirectoryTree(root) !== sidecar.payloadSha256 ||
      boundedTreeSize(root) !== sidecar.sizeBytes
    ) {
      fail(`${target.platformTarget} sidecar payload does not match its manifest`);
    }
    for (const [evidence, requiresCycloneDx] of [
      [sidecar.licenseEvidence, false],
      [sidecar.sbomEvidence, true],
    ]) {
      const relativePath = relative(sidecar.payloadRootPath, evidence.path);
      const path = regularContainedFile(root, relativePath, "sidecar evidence");
      assertEvidenceText(path, "sidecar evidence");
      if (requiresCycloneDx && readJson(path, "sidecar SBOM evidence").bomFormat !== "CycloneDX") {
        fail(`${target.platformTarget} sidecar SBOM evidence is invalid`);
      }
      if (createHash("sha256").update(readFileSync(path)).digest("hex") !== evidence.sha256) {
        fail(`${target.platformTarget} sidecar evidence digest does not match`);
      }
    }
  }
}

async function loadTarget(options, target) {
  const downloaded = requiredDirectory(
    join(options.bundleRoot, "artifacts", `${options.stagePrefix}${target.platformTarget}`),
    `${target.platformTarget} artifact`,
  );
  const archivePath = regularContainedFile(
    downloaded,
    target.assetName,
    `${target.platformTarget} archive`,
    MAX_ARCHIVE_BYTES,
  );
  const manifestPath = regularContainedFile(
    downloaded,
    "manifest/portable-manifest.json",
    `${target.platformTarget} manifest`,
  );
  const manifest = readJson(manifestPath, `${target.platformTarget} manifest`);
  if (
    statSync(archivePath).size !== manifest.artifact?.sizeBytes ||
    (await sha256File(archivePath)) !== manifest.artifact?.sha256
  )
    fail(`${target.platformTarget} archive bytes do not match the manifest`);
  assertEvidence(downloaded, manifest, target);
  return { downloaded, manifest };
}

export async function assemblePortableReleaseAssets(argv) {
  const options = parseArgs(argv);
  requiredDirectory(options.bundleRoot, "bundle root");
  const artifactsRoot = requiredDirectory(join(options.bundleRoot, "artifacts"), "artifacts root");
  assertExactDownloadedSet(artifactsRoot, options.stagePrefix);
  const loaded = [];
  for (const target of PORTABLE_TARGETS) loaded.push(await loadTarget(options, target));
  const expected = {
    commitSha: options.commitSha,
    releaseTag: options.releaseTag,
    runAttempt: options.runAttempt,
    runId: options.runId,
    version: options.version,
  };
  const failures = validatePortableReleaseSet(
    loaded.map((entry) => entry.manifest),
    expected,
  );
  if (failures.length > 0) fail(`release set is invalid:\n  - ${failures.join("\n  - ")}`);
  const artifacts = PORTABLE_TARGETS.map((target, index) => {
    const finalRoot = join(artifactsRoot, target.platformTarget);
    cpSync(loaded[index].downloaded, finalRoot, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    return {
      platformTarget: target.platformTarget,
      archivePath: `artifacts/${target.platformTarget}/${target.assetName}`,
      manifestPath: `artifacts/${target.platformTarget}/manifest/portable-manifest.json`,
    };
  });
  const manifest = { schemaVersion: 1, artifacts };
  writeFileSync(
    join(options.bundleRoot, BUNDLE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assemblePortableReleaseAssets(process.argv.slice(2)).then(
    (manifest) =>
      console.log(
        `portable release asset bundle assembled: ${manifest.artifacts.map((artifact) => artifact.platformTarget).join(", ")} (${BUNDLE_MANIFEST_NAME})`,
      ),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
