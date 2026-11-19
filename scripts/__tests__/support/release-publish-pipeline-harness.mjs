// Shared harness of the release-publish pipeline suites: it drives the real orchestrator
// (scripts/release-publish.mjs) against stubbed npm/gh/git/curl executables. The suites were one
// file; Vitest assigns whole files to coverage shards, and that file had grown to twenty minutes
// on a slow runner (PR #4464). See release-publish-pipeline.test.mjs for the scenarios.

import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  hashDirectoryTree,
  portableVerificationSummaryForManifest,
  PORTABLE_TARGETS,
  WINDOWS_PORTABLE_SETUP_ASSET_NAME,
} from "../../portable-runtime.mjs";
import { readZipArchiveUncompressedSize, writeZipArchiveEntries } from "../../lib/zip-archive.mjs";
import { boundedCommand } from "../../lib/portable-download-bounds.mjs";
import {
  FOLDER_PACKAGES_DIRECTORY,
  FOLDER_PACKAGES_MANIFEST,
  FOLDER_RELEASE_TARGETS,
  folderChecksumText,
  folderPackageArchiveName,
  folderPackagesManifest,
} from "../../lib/folder-package-release.mjs";
import {
  buildPortableEvaluationManifest,
  PORTABLE_EVALUATION_MANIFEST_ASSET_NAME,
  PORTABLE_EVALUATION_TARGET_NAMES,
} from "../../lib/portable-evaluation-manifest.mjs";
import {
  approvedOpenCodeVersion,
  codingRuntimeReleasesForPublishTest,
} from "./coding-runtime-releases-fixture.mjs";
import { expect } from "vitest";

const APPROVED_SIDECAR = JSON.parse(readFileSync("portable-runtime-approvals.json", "utf8"))
  .sidecarRuntimes[0];

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The orchestrator reads the release version from the live root manifest at runtime,
// so the stubs must answer with that same version rather than a hardcoded one. This
// keeps the gate correct across version bumps.
const ROOT_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const RELEASE_IMPACT_CATALOG = JSON.parse(
  readFileSync(join(REPO_ROOT, "release-impact.catalog.json"), "utf8"),
);
export const RELEASE_VERSION = ROOT_MANIFEST.version;
export const APPROVED_OPENCODE_VERSION = approvedOpenCodeVersion();
const EVALUATION_DOWNLOAD_NAMES = [
  ...PORTABLE_TARGETS.filter((target) =>
    PORTABLE_EVALUATION_TARGET_NAMES.includes(target.platformTarget),
  ).map((target) => target.assetName),
  WINDOWS_PORTABLE_SETUP_ASSET_NAME,
];
export const RELEASE_NAME = ROOT_MANIFEST.name;
export const RELEASE_SPEC = `${RELEASE_NAME}@${RELEASE_VERSION}`;
// These cases drive the real orchestrator and its stubbed npm/gh/git/curl child-process graph.
// Full script coverage recorded 19.6 s under the bounded two-worker scheduler. The repository-wide
// default remains 15 s; this subprocess-heavy suite alone uses an evidence-based 60 s deadline.
export const RELEASE_PIPELINE_TEST_TIMEOUT_MS = 60_000;

// A deterministic sha the stub `git` returns for both `rev-parse HEAD` and
// `rev-parse v<version>^{}`, so ensureReleaseTag() sees HEAD === tag and proceeds.
export const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const NODE_VERSION = "24.0.0";
const RELEASE_CREATED_AT = "2026-09-10T08:00:00.000Z";

function digestFor(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portableExecutable(marker = 0) {
  const bytes = Buffer.alloc(128, marker);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0x00, 0x00], 64);
  return bytes;
}

function targetVerificationChecks(target) {
  if (target.nodePlatform === "win32") {
    return { publisherChainVerified: true, timestampVerified: true };
  }
  if (target.nodePlatform === "linux") return { provenanceVerified: true };
  return {
    developerIdVerified: true,
    notarizationVerified: true,
    stapleVerified: true,
    assessmentVerified: true,
  };
}

function targetSupportLaunchers(target) {
  return target.nodePlatform === "win32"
    ? ["support/keiko-support.cmd"]
    : ["support/keiko-support.sh"];
}

function portableManifest(target, archivePath, assetId) {
  const archiveBytes = readFileSync(archivePath);
  const archiveSha256 = digestFor(archiveBytes);
  const archiveSize = statSync(archivePath).size;
  const nativeHelpers = [
    portableNativeHelper(target, "keiko-secure-workspace-read"),
    portableNativeHelper(target, "keiko-runtime-supervisor"),
  ];
  const provenanceText = `${JSON.stringify({
    artifact: target.assetName,
    buildWorkflowAttempt: 1,
    buildWorkflowRunId: 123456789,
    packageVersion: RELEASE_VERSION,
    sourceCommitSha: HEAD_SHA,
    subjectDigest: archiveSha256,
    target: target.platformTarget,
    nativeHelpers: nativeHelpers.map(nativeHelperProvenance),
  })}\n`;
  const provenanceSha256 = digestFor(provenanceText);
  const notarizationRequired = target.nodePlatform === "darwin";
  const verificationChecks = targetVerificationChecks(target);
  return {
    manifest: portableManifestObject(
      target,
      assetId,
      archiveSize,
      archiveSha256,
      provenanceSha256,
      notarizationRequired,
      verificationChecks,
      nativeHelpers,
      readZipArchiveUncompressedSize(archivePath),
    ),
    provenanceText,
  };
}

function portableRuntimeEvidence(target) {
  return {
    runtimeActivation: portableRuntimeActivation(target),
    runtimeAttestation:
      target.nodePlatform === "win32" ? portableRuntimeAttestation(target) : undefined,
    runtimeQualification:
      target.nodePlatform === "darwin" || target.nodePlatform === "linux"
        ? portableRuntimeQualification(target)
        : undefined,
  };
}

function portableEntrypoints(target) {
  return {
    primaryLauncher: target.primaryLauncher,
    supportLaunchers: targetSupportLaunchers(target),
  };
}

function portableManifestObject(
  target,
  assetId,
  archiveSize,
  archiveSha256,
  provenanceSha256,
  notarizationRequired,
  verificationChecks,
  nativeHelpers,
  uncompressedSizeBytes,
) {
  const releaseTag = `v${RELEASE_VERSION}`;
  const security = portableSecurity(target, notarizationRequired, verificationChecks);
  const { runtimeActivation, runtimeAttestation, runtimeQualification } =
    portableRuntimeEvidence(target);
  return {
    schemaVersion: 1,
    product: portableProduct(),
    release: { releaseId: 0, releaseTag, stable: true, commitSha: HEAD_SHA },
    artifact: {
      ...portableArtifact(target, assetId, archiveSize, archiveSha256),
      uncompressedSizeBytes,
    },
    provenance: portableProvenance(provenanceSha256),
    runtime: portableRuntime(target),
    runtimeActivation,
    ...(runtimeAttestation === undefined ? {} : { runtimeAttestation }),
    ...(runtimeQualification === undefined ? {} : { runtimeQualification }),
    nativeHelpers,
    packageSurface: portablePackageSurface(),
    entrypoints: portableEntrypoints(target),
    installLayout: portableInstallLayout(),
    stateExclusion: portableStateExclusion(),
    security,
    evidence: portableEvidence(),
    releaseImpact: portableReleaseImpact(
      target,
      assetId,
      archiveSize,
      archiveSha256,
      provenanceSha256,
      security,
      nativeHelpers,
      runtimeActivation,
      runtimeAttestation,
      runtimeQualification,
    ),
    updateEligibility: portableUpdateEligibility(),
  };
}

function nativeHelperBytes(target, name) {
  return Buffer.from(
    target.nodePlatform === "win32"
      ? `release-pipeline-signed-${name}-pe-fixture\n`
      : `#!/bin/sh\n# release-pipeline-signed-${name}-fixture\n`,
  );
}

function nativeHelperExecutablePath(target, name) {
  return `runtime/native/${name}${target.nodePlatform === "win32" ? ".exe" : ""}`;
}

function portableNativeHelper(target, name) {
  const bytes = nativeHelperBytes(target, name);
  const digest = digestFor(bytes);
  const notarizationRequired = target.nodePlatform === "darwin";
  const supervisor = name === "keiko-runtime-supervisor";
  return {
    name,
    kind: supervisor ? "runtime-process-supervisor" : "secure-workspace-text-read",
    platformTarget: target.platformTarget,
    architecture: target.nodeArchitecture,
    executablePath: nativeHelperExecutablePath(target, name),
    protocol: {
      schemaVersion: 1,
      requestMagic: supervisor ? "KRP1" : "KSR1",
      responseMagic: supervisor ? "KRS1" : "KSS1",
    },
    source: {
      commitSha: HEAD_SHA,
      path: supervisor
        ? target.nodePlatform === "linux"
          ? "native/runtime-supervisor"
          : `native/runtime-supervisor/${target.nodePlatform === "win32" ? "windows" : "macos"}`
        : "native/secure-workspace-read",
      treeSha256: digestFor(`${name}\n`),
    },
    unsignedSha256: digest,
    shippedSha256: digest,
    sizeBytes: bytes.length,
    sbomBomRef: `pkg:generic/${name}@${RELEASE_VERSION}?platform=${target.platformTarget}`,
    signing: {
      signatureKind: target.signatureKind,
      verificationStatus: "verified-production",
      signatureVerified: true,
      notarizationRequired,
      notarizationVerified: notarizationRequired,
    },
  };
}

function portableRuntimeActivation(target) {
  return {
    schemaVersion: 1,
    path: ".portable/runtime-activation.json",
    sha256: "d".repeat(64),
    trustAnchor:
      target.nodePlatform === "win32"
        ? "authenticode-attestor"
        : target.nodePlatform === "linux"
          ? "sigstore-qualification-receipt"
          : "developer-id-app-resource-seal",
  };
}

function portableRuntimeAttestation(target) {
  const bytes = Buffer.from("release-pipeline-runtime-attestation-fixture\n");
  return {
    schemaVersion: 1,
    carrierKind: "authenticode-executable",
    executablePath: "runtime/native/keiko-runtime-attestation.exe",
    shippedSha256: digestFor(bytes),
    sizeBytes: bytes.length,
    signing: {
      signatureKind: target.signatureKind,
      verificationStatus: "verified-production",
      signatureVerified: true,
      notarizationRequired: false,
      notarizationVerified: false,
    },
  };
}

function portableRuntimeQualification(target) {
  return {
    schemaVersion: 1,
    path: ".portable/runtime-qualification.json",
    sha256: "e".repeat(64),
    backend:
      target.nodePlatform === "linux" ? "linux-namespace-gateway" : "macos-endpoint-security",
  };
}

function nativeHelperProvenance(helper) {
  return {
    architecture: helper.architecture,
    executablePath: helper.executablePath,
    name: helper.name,
    shippedSha256: helper.shippedSha256,
    signatureKind: helper.signing.signatureKind,
    signatureVerified: helper.signing.signatureVerified,
    notarizationVerified: helper.signing.notarizationVerified,
    sourceTreeSha256: helper.source.treeSha256,
    unsignedSha256: helper.unsignedSha256,
  };
}

function portableProduct() {
  return { name: "Keiko", packageName: RELEASE_NAME, packageVersion: RELEASE_VERSION };
}

function portableArtifact(target, assetId, archiveSize, archiveSha256) {
  return {
    platformTarget: target.platformTarget,
    assetId,
    assetName: target.assetName,
    archiveFormat: "zip",
    sizeBytes: archiveSize,
    sha256: archiveSha256,
  };
}

function portableProvenance(provenanceSha256) {
  return {
    sourceCommitSha: HEAD_SHA,
    rootPackageVersion: RELEASE_VERSION,
    rootPackageTarballSha256: DIGEST_B,
    packagedAppTreeSha256: DIGEST_C,
    buildWorkflowRunId: 123456789,
    buildWorkflowAttempt: 1,
    provenanceStatementPath: "evidence/provenance.intoto.jsonl",
    provenanceStatementSha256: provenanceSha256,
  };
}

function portableRuntime(target) {
  return {
    nodeVersion: NODE_VERSION,
    nodePlatform: target.nodePlatform,
    nodeArchitecture: target.nodeArchitecture,
    nodeDistribution: "official-nodejs-dist",
    nodeArchiveSha256: DIGEST_B,
  };
}

function portablePackageSurface() {
  return {
    source: "root-npm-package-surface",
    packageSurfaceGate: "npm run check:package-surface",
    publishManifestGate: "npm run check:publish-manifests",
    workspaceSupplyChainGate: "npm run check:workspace-supply-chain",
  };
}

function portableInstallLayout() {
  return {
    installMode: "portable-managed",
    bootstrapUpdateEligible: false,
    managedRootKind: "user-local-keiko-owned",
    sameVolumeStagingRequired: true,
    stateRootPolicy: "separate-local-runtime-state",
  };
}

function portableStateExclusion() {
  return {
    excludesDotKeiko: true,
    excludesCustomerData: true,
    excludesSecrets: true,
    excludesRawLogs: true,
    excludesRepositories: true,
  };
}

function portableSecurity(target, notarizationRequired, verificationChecks) {
  return {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: target.signatureKind,
    signatureVerified: true,
    notarizationRequired,
    notarizationVerified: notarizationRequired,
    verificationChecks,
    verificationSummaryPath: "evidence/signing-verification.json",
  };
}

function portableSidecarSigning(target) {
  const signing = portableSecurity(
    target,
    target.nodePlatform === "darwin",
    targetVerificationChecks(target),
  );
  delete signing.verificationSummaryPath;
  return signing;
}

function portableEvidence() {
  return {
    checksumsPath: "evidence/SHA256SUMS.txt",
    sbomPath: "evidence/sbom.cdx.json",
    licenseNoticePath: "evidence/third-party-notices.txt",
  };
}

function portableReleaseImpact(
  target,
  assetId,
  archiveSize,
  archiveSha256,
  provenanceSha256,
  security,
  nativeHelpers,
  runtimeActivation,
  runtimeAttestation,
  runtimeQualification,
) {
  return {
    catalogPath: "app/release-impact.catalog.json",
    entryId: "portable-product-delivery-v2",
    entryPackageVersion: RELEASE_VERSION,
    entryReleaseTag: `v${RELEASE_VERSION}`,
    reviewedBinding: portableReviewedBinding(
      target,
      assetId,
      archiveSize,
      archiveSha256,
      provenanceSha256,
      security,
      nativeHelpers,
      runtimeActivation,
      runtimeAttestation,
      runtimeQualification,
    ),
  };
}

function portableReviewedBinding(
  target,
  assetId,
  archiveSize,
  archiveSha256,
  provenanceSha256,
  security,
  nativeHelpers,
  runtimeActivation,
  runtimeAttestation,
  runtimeQualification,
) {
  return {
    releaseId: 0,
    releaseTag: `v${RELEASE_VERSION}`,
    assetId,
    assetName: target.assetName,
    assetSizeBytes: archiveSize,
    platformTarget: target.platformTarget,
    packageVersion: RELEASE_VERSION,
    nodeRuntimeIdentity: `node-v${NODE_VERSION}-${target.runtimeTarget}`,
    archiveSha256,
    provenanceStatementSha256: provenanceSha256,
    sbomPath: "evidence/sbom.cdx.json",
    licenseNoticePath: "evidence/third-party-notices.txt",
    checksumsPath: "evidence/SHA256SUMS.txt",
    verificationPolicy: security.verificationPolicy,
    verificationStatus: security.verificationStatus,
    verificationReasonCodes: security.verificationReasonCodes,
    platformSignatureLocallyVerified: true,
    signatureKind: security.signatureKind,
    signatureVerified: security.signatureVerified,
    notarizationRequired: security.notarizationRequired,
    notarizationVerified: security.notarizationVerified,
    verificationChecks: security.verificationChecks,
    nativeHelpers,
    runtimeActivation,
    ...(runtimeAttestation === undefined ? {} : { runtimeAttestation }),
    ...(runtimeQualification === undefined ? {} : { runtimeQualification }),
  };
}

function portableUpdateEligibility() {
  return {
    stableOnly: true,
    rollbackSupported: false,
    eligibleAfterSetupOnly: true,
    requiredPredicates: {
      managedRootAttested: true,
      artifactShaVerified: true,
      platformSignatureLocallyVerified: true,
      manifestReleaseImpactBound: true,
      sameVolumeCrashSafePromotionAvailable: true,
      relaunchVersionVerificationAvailable: true,
    },
    manualOnlyWhen: [
      "managed-root-cannot-be-attested",
      "signature-or-notarization-cannot-be-verified",
      "crash-safe-promotion-unavailable",
      "admin-or-organization-managed-root",
      "prerelease-beta-downgrade-or-rollback",
    ],
  };
}

// Shared prologue injected into each stub: append-only call log + tiny JSON state file
// so a stub can flip "published"/"tagged" as the orchestrator drives it. The real ZIP writer is
// imported so the artifact-by-id endpoint can answer with archives the production reader
// actually parses.
const ZIP_ARCHIVE_LIB_URL = pathToFileURL(
  resolve(REPO_ROOT, "scripts", "lib", "zip-archive.mjs"),
).href;

function stubPrologue(logFile, stateFile) {
  return [
    'import { Buffer } from "node:buffer";',
    'import { createHash } from "node:crypto";',
    'import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `import { writeZipArchiveEntries } from ${JSON.stringify(ZIP_ARCHIVE_LIB_URL)};`,
    `const LOG = ${JSON.stringify(logFile)};`,
    `const STATE = ${JSON.stringify(stateFile)};`,
    `const VERSION = ${JSON.stringify(RELEASE_VERSION)};`,
    "const argv = process.argv.slice(2);",
    // The `sh` stub already recorded a bounded call (see makeShStub); under its file-size limit a
    // Linux append to the shared log fails with EFBIG, so the limited stub writes no log line.
    `const LOGGED_BY_SH = process.env[${JSON.stringify(LOGGED_BY_SH_ENV)}] === "1";`,
    "function log(bin) { if (!LOGGED_BY_SH) appendFileSync(LOG, bin + ' ' + JSON.stringify(argv) + '\\n'); }",
    "function logCwd(bin) { if (!LOGGED_BY_SH) appendFileSync(LOG, bin + '-cwd ' + JSON.stringify(process.cwd()) + '\\n'); }",
    "function state() { return JSON.parse(readFileSync(STATE, 'utf8')); }",
    "function setState(patch) { writeFileSync(STATE, JSON.stringify({ ...state(), ...patch })); }",
    "",
  ].join("\n");
}

// Stub `gh`: answers the release-owner approval probe (gh api .../reviews/...) with an
// APPROVED review by the allowed owner, reports the GitHub release as absent so the
// create path runs, and accepts create/edit. All offline.
function ghStubBody() {
  return [
    ...ghAttestationAndArtifactStubLines(),
    ...ghReleaseApiStubLines(),
    ...ghDeploymentApiStubLines(),
    ...ghReleaseViewStubLines(),
    ...ghReleaseTransferStubLines(),
    ...ghReleaseUploadRecordStubLines(),
  ].join("\n");
}

// `gh` stub, in run order: the provenance verifier and the workflow-run artifact reads.
function ghAttestationAndArtifactStubLines() {
  return [
    'log("gh");',
    "const sub = argv[0];",
    'if (sub === "attestation" && argv[1] === "verify") {',
    "  if (state().failSetupAttestation) { process.stderr.write('setup provenance verification failed\\n'); process.exit(46); }",
    "  if (state().failFolderAttestation && String(argv[2]).endsWith('.standalone.zip')) { process.stderr.write('folder package provenance verification failed\\n'); process.exit(46); }",
    "  process.exit(0);",
    "}",
    'if (sub === "api") {',
    // Artifact-by-id endpoints: the record probe and the binary zip download. Answered before
    // the generic runs branch, and refusing when the fixture marks the run's artifacts
    // unavailable.
    '  if (argv[1] && argv[1].includes("/actions/artifacts/")) {',
    "    if (state().runArtifactsUnavailable) process.exit(1);",
    "    const artifactId = Number(argv[1].split('/artifacts/')[1].split('/')[0]);",
    "    const listed = (state().runArtifactListing || []).find((entry) => entry.id === artifactId);",
    "    if (!listed) process.exit(1);",
    '    if (argv[1].endsWith("/zip")) {',
    "      const wanted = (state().uploadedAssets || []).filter((asset) => {",
    "        if (listed.name.includes('windows')) return asset.name.startsWith('keiko-windows-');",
    "        if (listed.name.includes('arm64')) return asset.name === 'keiko-macos-arm64.zip';",
    "        return asset.name === 'keiko-macos-x64.zip';",
    "      });",
    "      const prefix = state().nestRunArtifacts ? 'nested/' : '';",
    "      const records = wanted.map((asset) => {",
    "        let bytes = Buffer.from(asset.content || '', 'base64');",
    "        if (state().tamperRunArtifacts) bytes = Buffer.concat([bytes, Buffer.from('x')]);",
    "        return { name: prefix + asset.name, data: bytes };",
    "      });",
    "      const zipPath = LOG + '.artifact-' + artifactId + '.zip';",
    "      writeZipArchiveEntries(zipPath, records);",
    "      writeFileSync(1, readFileSync(zipPath));",
    "      rmSync(zipPath, { force: true });",
    "      process.exit(0);",
    "    }",
    "    writeFileSync(1, JSON.stringify({ name: listed.name, expired: listed.expired === true, workflow_run: { id: Number(state().workflowRunId || 31300595709) } }));",
    "    process.exit(0);",
    "  }",
    '  if (argv[1] && argv[1].includes("/actions/runs/")) {',
    "    writeFileSync(1, JSON.stringify(state().workflowRun || {}));",
    "    process.exit(0);",
    "  }",
  ];
}

// `gh` stub, in run order: the REST release draft, its reads by id, the tag ref and the Latest badge.
function ghReleaseApiStubLines() {
  return [
    // GitHub immutable releases (2026-09-14): the publisher creates its draft through the REST API and
    // takes the id from that answer, then reads the draft by id; the by-tag endpoint cannot see it.
    '  if (argv.includes("--method") && argv.includes("POST") && argv.some((a) => typeof a === "string" && /^repos\\/[^/]+\\/[^/]+\\/releases$/.test(a))) {',
    "    setState({ publisherDraft: true });",
    `    writeFileSync(1, JSON.stringify({ id: 987654321, tag_name: \`v\${VERSION}\`, draft: true, created_at: ${JSON.stringify(RELEASE_CREATED_AT)}, assets: [] }));`,
    "    process.exit(0);",
    "  }",
    '  if (argv[1] && argv[1].endsWith("/releases/987654321")) {',
    `    writeFileSync(1, JSON.stringify({ id: 987654321, created_at: ${JSON.stringify(RELEASE_CREATED_AT)}, draft: state().publisherDraft === true, prerelease: false, assets: state().uploadedAssets || [] }));`,
    "    process.exit(0);",
    "  }",
    '  if (argv[1] && argv[1].includes("/git/ref/tags/")) {',
    `    writeFileSync(1, JSON.stringify({ object: { sha: state().remoteTagSha || ${JSON.stringify(HEAD_SHA)}, type: "commit" } }));`,
    "    process.exit(0);",
    "  }",
    '  if (argv[1] && argv[1].includes("/releases/latest")) {',
    // Which release GitHub presents as Latest. By default the same release the by-tag read
    // answers with; a test can hand the badge to another release to prove the refusal. The
    // release-alignment gate (issue #3252) reads `tag_name` off this same endpoint; a test can
    // point it at a different tag to prove a real, post-publish alignment divergence.
    "    writeFileSync(1, JSON.stringify({ id: state().latestBadgeElsewhere ? 111 : 987654321, tag_name: state().alignmentGithubLatestTag || `v${VERSION}` }));",
    "    process.exit(0);",
    "  }",
  ];
}

// `gh` stub, in run order: the npm-publish deployment record, the release by tag and the approval.
function ghDeploymentApiStubLines() {
  return [
    // The npm-publish deployment record (issue #3252): POST creates (deployment, then its
    // success status), GET lists — the idempotency check (scoped by `ref=`) always reports
    // nothing recorded yet so the create path runs and can be asserted on; a fixture can force
    // either write to fail closed the same way a 403/404 token would.
    '  if (argv.includes("--method") && argv.includes("POST")) {',
    '    const apiPath = argv.find((a) => typeof a === "string" && a.startsWith("repos/"));',
    '    if (apiPath && apiPath.endsWith("/statuses")) {',
    "      if (state().failDeploymentStatus) {",
    '        process.stderr.write("HTTP 403: Resource not accessible by integration\\n");',
    "        process.exit(1);",
    "      }",
    '      writeFileSync(1, JSON.stringify({ id: 900001, state: "success" }));',
    "      process.exit(0);",
    "    }",
    '    if (apiPath && apiPath.endsWith("/deployments")) {',
    "      if (state().failDeploymentCreate) {",
    '        process.stderr.write("HTTP 403: Resource not accessible by integration\\n");',
    "        process.exit(1);",
    "      }",
    "      writeFileSync(1, JSON.stringify({ id: 900000 }));",
    "      process.exit(0);",
    "    }",
    "  }",
    '  if (argv[1] && argv[1].includes("/deployments?ref=")) {',
    // The idempotency listing (npm-publish-deployment.mjs): always reports nothing recorded
    // yet, so the create path runs every time and can be asserted on directly.
    '    writeFileSync(1, "[]");',
    "    process.exit(0);",
    "  }",
    '  if (argv[1] && argv[1].includes("/deployments?")) {',
    // The newest-deployment-in-the-environment read (check-release-alignment.mjs): reports the
    // ref this run's own create call just recorded, unless a fixture overrides it to prove a
    // stale-deployment divergence.
    "    writeFileSync(1, JSON.stringify([{ ref: state().alignmentDeploymentRef || `v${VERSION}` }]));",
    "    process.exit(0);",
    "  }",
    '  if (argv[1] && argv[1].includes("/releases/tags/")) {',
    "    if (state().publisherDraft === true) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }",
    // The release-by-tag endpoint always reports both flags; the prepublished gate requires the
    // published stable shape, so the double states it the way the real API does.
    `    writeFileSync(1, JSON.stringify({ id: 987654321, created_at: ${JSON.stringify(RELEASE_CREATED_AT)}, draft: state().releaseDraft === true, prerelease: state().releasePrerelease === true, assets: state().uploadedAssets || [] }));`,
    "    process.exit(0);",
    "  }",
    '  process.stdout.write(JSON.stringify({ state: "APPROVED", user: { login: "release-owner" } }));',
    "  process.exit(0);",
    "}",
  ];
}

// `gh` stub, in run order: `gh release view`, `create` and `edit`.
function ghReleaseViewStubLines() {
  return [
    // An existing release answers the isDraft,assets probe. An interrupted evaluation publish
    // leaves a resumable stable-tag DRAFT; a completed one leaves a published release carrying
    // the evidence manifest — the qualified upload path must refuse to edit over either.
    'if (sub === "release" && argv[1] === "view") {',
    "  if (state().existingReleaseIsDraft) { writeFileSync(1, JSON.stringify({ isDraft: true, assets: [] })); process.exit(0); }",
    "  if (state().existingEvaluationRelease) { writeFileSync(1, JSON.stringify({ isDraft: false, assets: [{ name: 'keiko-portable-evaluation-manifest.json' }] })); process.exit(0); }",
    "  if (state().releasePublished) { writeFileSync(1, JSON.stringify({ isDraft: false, assets: state().uploadedAssets || [] })); process.exit(0); }",
    // A draft an interrupted run of this publisher left behind: resumed under its own title and id.
    "  if (state().resumableDraft) { writeFileSync(1, JSON.stringify({ isDraft: true, name: 'Keiko ' + VERSION, databaseId: 987654321, assets: state().uploadedAssets || [] })); process.exit(0); }",
    "  if (state().publisherDraft) { writeFileSync(1, JSON.stringify({ isDraft: true, assets: state().uploadedAssets || [] })); process.exit(0); }",
    "  process.exit(1);",
    "}",
    'if (sub === "release" && argv[1] === "create") {',
    "  setState(argv.includes('--draft') ? { publisherDraft: true } : { releasePublished: true });",
    "  process.exit(0);",
    "}",
    'if (sub === "release" && argv[1] === "edit") {',
    "  if (argv.includes('--draft=false')) setState({ publisherDraft: false, releasePublished: true });",
    "  process.exit(0);",
    "}",
  ];
}

// `gh` stub, in run order: `gh release download`, and `upload` up to its file loop.
function ghReleaseTransferStubLines() {
  return [
    // The authenticated download a rerun over a published release reads each signed manifest with.
    'if (sub === "release" && argv[1] === "download") {',
    '  const pattern = argv[argv.indexOf("--pattern") + 1];',
    '  const dir = argv[argv.indexOf("--dir") + 1];',
    "  const asset = (state().uploadedAssets || []).find((entry) => entry.name === pattern);",
    "  if (!asset) { process.stderr.write('no assets match the file pattern\\n'); process.exit(1); }",
    "  writeFileSync(join(dir, asset.name), Buffer.from(asset.content, 'base64'));",
    "  process.exit(0);",
    "}",
    'if (sub === "release" && argv[1] === "upload") {',
    "  const current = state();",
    "  if (current.immutableReleases && current.releasePublished) { process.stderr.write('HTTP 422: Cannot upload assets to an immutable release.\\n'); process.exit(1); }",
    "  if (current.failGhUpload) { process.stderr.write('portable upload failed\\n'); process.exit(42); }",
    "  const tag = argv[2];",
    '  const repoIndex = argv.indexOf("--repo");',
    "  const repo = repoIndex >= 0 ? argv[repoIndex + 1] : 'oscharko-dev/Keiko';",
    "  const files = argv.slice(3).filter((entry, index, entries) => {",
    '    if (entry === "--repo" || entry === "--clobber") return false;',
    '    if (index > 0 && entries[index - 1] === "--repo") return false;',
    "    return !entry.startsWith('--');",
    "  });",
    "  const byName = new Map((current.uploadedAssets || []).map((asset) => [asset.name, asset]));",
    "  function nextId() { return 100000 + byName.size; }",
  ];
}

// `gh` stub, in run order: the upload's per-file record and its remote rebinding checks.
function ghReleaseUploadRecordStubLines() {
  return [
    "  for (const path of files) {",
    "    let name = path.split(/[\\\\/]/u).at(-1);",
    "    if (current.wrongRemoteAssetName && name === 'keiko-windows-x64.zip') name = 'keiko-windows-renamed.zip';",
    "    const previous = byName.get(name);",
    "    const id = previous?.id || nextId();",
    "    if (name.endsWith('-portable-manifest.json')) {",
    "      const manifest = JSON.parse(readFileSync(path, 'utf8'));",
    "      const archive = byName.get(manifest.artifact.assetName);",
    `      const setup = byName.get(${JSON.stringify(WINDOWS_PORTABLE_SETUP_ASSET_NAME)});`,
    "      if (!archive || manifest.release.releaseId !== 987654321 || manifest.artifact.assetId !== archive.id || manifest.releaseImpact.reviewedBinding.assetId !== archive.id || manifest.releaseImpact.reviewedBinding.releaseId !== 987654321) {",
    "        process.stderr.write('portable manifest was not rebound to the remote GitHub ids\\n');",
    "        process.exit(44);",
    "      }",
    "      if (manifest.artifact.platformTarget === 'windows-x64' && (!setup || manifest.releaseImpact.reviewedBinding.setupAsset?.assetId !== setup.id || manifest.releaseImpact.reviewedBinding.setupAsset?.assetName !== setup.name || manifest.releaseImpact.reviewedBinding.setupAsset?.sizeBytes !== setup.size || manifest.releaseImpact.reviewedBinding.setupAsset?.sha256 !== createHash('sha256').update(Buffer.from(setup.content, 'base64')).digest('hex'))) {",
    "        process.stderr.write('portable setup asset was not rebound to the remote GitHub asset id\\n');",
    "        process.exit(45);",
    "      }",
    "    }",
    "    byName.set(name, {",
    "      content: readFileSync(path).toString('base64'),",
    "      digest: 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex'),",
    "      id,",
    "      name,",
    "      size: readFileSync(path).byteLength,",
    "      browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`",
    "    });",
    "  }",
    '  if (current.mutateSetupAfterArchiveUpload && files.some((path) => path.endsWith("keiko-windows-x64-setup.exe"))) {',
    '    const setupPath = files.find((path) => path.endsWith("keiko-windows-x64-setup.exe"));',
    "    writeFileSync(setupPath, 'mutated locally after verified remote upload');",
    "  }",
    "  setState({ uploadedAssets: [...byName.values()] });",
    "  process.exit(0);",
    "}",
    "process.exit(0);",
  ];
}

// Stub `git`: a clean tree (diff --quiet exits 0) and a matching HEAD/tag sha so the
// pre-publish safety checks pass without touching the real repository state.
function gitStubBody() {
  return [
    'log("git");',
    "const sub = argv[0];",
    'if (sub === "diff") { process.exit(0); }',
    'if (sub === "rev-parse") { process.stdout.write(' +
      JSON.stringify(HEAD_SHA) +
      ' + "\\n"); process.exit(0); }',
    'if (sub === "remote") { process.stdout.write("git@github.com:oscharko-dev/Keiko.git\\n"); process.exit(0); }',
    // The release-alignment gate (issue #3252) lists tags with `git tag --list v*`; a fixture
    // can override the reported newest tag to prove a real, post-publish alignment divergence.
    'if (sub === "tag" && argv[1] === "--list") { process.stdout.write((state().alignmentTags || ["v" + VERSION]).join("\\n") + "\\n"); process.exit(0); }',
    "process.exit(0);",
  ].join("\n");
}

// A bounded download runs as `sh -c '<ulimit wrapper>' sh <blocks> <program> ...` (boundedCommand).
// On Linux the file-size limit also refuses appends to the shared call log beyond the limit, which
// macOS permits, so every download stub failed with EFBIG in CI only. This `sh` stub records the
// bounded call in the stub log format before the limit applies, marks it, and then execs the real
// shell, so the process tree, its exit status and its signals stay those of the real wrapper. The
// wrapper text comes from the production helper, never a copy.
const LOGGED_BY_SH_ENV = "KEIKO_TEST_LOGGED_BY_SH";
const BOUNDED_WRAPPER_SCRIPT = boundedCommand("curl", [], 1, "linux").args[1];

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeShStub(binDir, logFile) {
  const recorder = join(binDir, "record-bounded-call.mjs");
  writeFileSync(
    recorder,
    [
      'import { appendFileSync } from "node:fs";',
      // argv after the recorder: -c, the wrapper, its $0, the block count, the program, its args.
      "const [, , , , bin, ...args] = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(logFile)}, bin + " " + JSON.stringify(args) + "\\n");`,
      "",
    ].join("\n"),
    "utf8",
  );
  const path = join(binDir, "sh");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `if [ "$1" = "-c" ] && [ "$2" = ${shellQuote(BOUNDED_WRAPPER_SCRIPT)} ]; then`,
      `  ${shellQuote(process.execPath)} ${shellQuote(recorder)} "$@" || exit 70`,
      `  ${LOGGED_BY_SH_ENV}=1`,
      `  export ${LOGGED_BY_SH_ENV}`,
      "fi",
      'exec /bin/sh "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
}

function makeStub(binDir, name, body, logFile, stateFile) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${stubPrologue(logFile, stateFile)}${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

// Every call that makes a release visible outside the run: a GitHub release or its assets, a
// pushed tag, or registry state.
const PUBLICATION_CALL_PREFIXES = [
  'gh ["release","create"',
  'gh ["release","edit"',
  'gh ["release","upload"',
  'git ["push"',
  'npm ["publish"',
  'npm ["dist-tag"',
];

export function expectNoPublicationSideEffect(calls) {
  for (const prefix of PUBLICATION_CALL_PREFIXES) {
    expect(calls.filter((line) => line.startsWith(prefix))).toEqual([]);
  }
}

export function registryVersionBody() {
  return [
    "  const s = state();",
    '  if (argv.includes("version")) {',
    '    if (!s.published) { process.stderr.write("npm error code E404\\n"); process.exit(1); }',
    '    process.stdout.write(VERSION + "\\n");',
    "    process.exit(0);",
    "  }",
    '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
  ].join("\n");
}

export function passthroughViewBody() {
  return [
    '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
    '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
  ].join("\n");
}

/**
 * A release that the governed evaluation lane already published: the four downloads with real
 * bytes, and the evaluation manifest that binds them to this tag, commit and workflow run. Digests
 * are measured from the same bytes the stub `curl` serves, so the fixture cannot drift from what
 * the publisher verifies.
 */
function prepublishedDownloads() {
  return EVALUATION_DOWNLOAD_NAMES.map((name, index) => {
    const content = Buffer.from(`prepublished ${name}\n`);
    return {
      id: 500000 + index,
      name,
      size: content.byteLength,
      content: content.toString("base64"),
      sha256: createHash("sha256").update(content).digest("hex"),
      browser_download_url: `https://github.com/oscharko-dev/Keiko/releases/download/v${RELEASE_VERSION}/${name}`,
    };
  });
}

export function prepublishedEvaluationState() {
  const sourceCommitSha = HEAD_SHA;
  const workflowRunId = "31300595709";
  const downloads = prepublishedDownloads();
  const runArtifacts = [
    { name: "portable-stage-windows-x64-evaluation-unsigned", id: 700001 },
    { name: "portable-stage-macos-arm64-evaluation-unsigned", id: 700002 },
    { name: "portable-stage-macos-x64-evaluation-unsigned", id: 700003 },
  ];
  const manifest = buildPortableEvaluationManifest({
    releaseTag: `v${RELEASE_VERSION}`,
    sourceCommitSha,
    repository: "oscharko-dev/Keiko",
    workflowPath: ".github/workflows/portable-assets.yml",
    workflowRunId,
    workflowRunAttempt: 1,
    artifacts: runArtifacts,
    assets: downloads.map((asset) => ({
      assetName: asset.name,
      sizeBytes: asset.size,
      sha256: asset.sha256,
    })),
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`);
  return {
    published: true,
    tagged: true,
    workflowRun: {
      path: ".github/workflows/portable-assets.yml",
      head_sha: sourceCommitSha,
      conclusion: "success",
    },
    runArtifactListing: runArtifacts.map((artifact) => ({ ...artifact, expired: false })),
    uploadedAssets: [
      ...downloads,
      {
        id: 600000,
        name: PORTABLE_EVALUATION_MANIFEST_ASSET_NAME,
        size: manifestBytes.byteLength,
        content: manifestBytes.toString("base64"),
        browser_download_url: `https://github.com/oscharko-dev/Keiko/releases/download/v${RELEASE_VERSION}/${PORTABLE_EVALUATION_MANIFEST_ASSET_NAME}`,
      },
    ],
  };
}

function curlStubBody() {
  return [
    "const url = argv.at(-1);",
    'log("curl");',
    `const versionEndpointSuffix = "/" + VERSION;`,
    "if (url.endsWith(versionEndpointSuffix)) {",
    "  const s = state();",
    "  const attempts = s.versionEndpointAttempts ?? 0;",
    "  const scripted = s.versionEndpointResponses;",
    "  if (Array.isArray(scripted) && scripted.length > 0) {",
    "    const response = scripted[Math.min(attempts, scripted.length - 1)];",
    "    setState({ versionEndpointAttempts: attempts + 1 });",
    "    if (Number.isInteger(response.exitCode)) process.exit(response.exitCode);",
    "    process.stdout.write(String(response.httpStatus));",
    "    process.exit(0);",
    "  }",
    "  if (!s.published) { process.stdout.write('404'); process.exit(0); }",
    "  setState({ versionEndpointAttempts: attempts + 1 });",
    "  const visibleAfter = s.versionVisibleAfterAttempts ?? 0;",
    "  process.stdout.write(attempts >= visibleAfter ? '200' : '404');",
    "  process.exit(0);",
    "}",
    'const outputIndex = argv.indexOf("--output");',
    'const output = outputIndex >= 0 ? argv[outputIndex + 1] : "";',
    'const name = url.split("/").at(-1);',
    "const asset = (state().uploadedAssets || []).find((entry) => entry.name === name);",
    "if (!asset || output.length === 0) process.exit(2);",
    "if ((state().failPublicDownloads || []).includes(name)) { process.stderr.write('curl: (22) The requested URL returned error: 503\\n'); process.exit(22); }",
    "if ((state().hangPublicDownloads || []).includes(name)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);",
    'let bytes = Buffer.from(asset.content, "base64");',
    "if ((state().oversizeRemoteDownloads || []).includes(name)) bytes = Buffer.concat([bytes, Buffer.alloc(2 * 1024 * 1024, 1)]);",
    'if (state().tamperRemoteDownloads && name.endsWith(".zip") && bytes.length > 0) bytes[0] ^= 0xff;',
    "writeFileSync(output, bytes);",
    "process.exit(0);",
  ].join("\n");
}

function writePortableAssetsFixture(root, options = {}) {
  const outsideEvidence = join(root, "..", "outside-portable-evidence.txt");
  writeFileSync(outsideEvidence, "outside evidence must not be uploaded\n");
  const artifacts = PORTABLE_TARGETS.map((target, index) => {
    const targetRoot = join(root, target.platformTarget);
    const archivePath = join(targetRoot, target.assetName);
    const manifestPath = join(targetRoot, "manifest", "portable-manifest.json");
    mkdirSync(join(targetRoot, "evidence"), { recursive: true });
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeZipArchiveEntries(archivePath, [
      {
        name: "Keiko/readme.txt",
        data: Buffer.from(`portable archive for ${target.platformTarget}\n`),
      },
    ]);
    const { manifest, provenanceText } = portableManifest(target, archivePath, 0);
    writeNativeHelperFixture(targetRoot, target);
    addPortableSidecarFixture(
      targetRoot,
      manifest,
      target,
      index === 0 ? (options.sidecarEvidenceKind ?? "safe") : "safe",
    );
    writePortableEvidence(targetRoot, manifest, provenanceText);
    options.mutateManifest?.(manifest, target, index, targetRoot);
    options.mutateEvidence?.(targetRoot, manifest, target, index);
    if (options.symlinkEvidenceOutsideRoot === true && index === 0) {
      const sbomPath = join(targetRoot, "evidence", "sbom.cdx.json");
      rmSync(sbomPath, { force: true });
      symlinkSync(outsideEvidence, sbomPath);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const entry = { archivePath, manifestPath, platformTarget: target.platformTarget };
    if (target.platformTarget === "windows-x64") {
      const setupPath = join(targetRoot, WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      writeFileSync(setupPath, portableExecutable(29));
      entry.setupPath = setupPath;
      entry.setupSha256 = digestFor(readFileSync(setupPath));
      entry.setupSizeBytes = statSync(setupPath).size;
    }
    return entry;
  });
  const manifestPath = join(root, "portable-assets.json");
  const bundle = { schemaVersion: 1, artifacts };
  options.mutateBundle?.(bundle);
  writeFileSync(manifestPath, JSON.stringify(bundle, null, 2) + "\n");
  if (options.folderPackages !== false) writeFolderPackagesFixture(root, options);
  return manifestPath;
}

// The folder packages the stable-tag build writes into the bundle (scripts/build-folder-release-
// assets.mjs): one small package per desktop target, bound to that target's archive.
function writeFolderPackagesFixture(root, options) {
  const directory = join(root, FOLDER_PACKAGES_DIRECTORY);
  mkdirSync(directory);
  const packages = FOLDER_RELEASE_TARGETS.map((platformTarget) => {
    const target = PORTABLE_TARGETS.find((entry) => entry.platformTarget === platformTarget);
    const archivePath = join(root, platformTarget, target.assetName);
    const assetName = folderPackageArchiveName(platformTarget, "standalone");
    const zipPath = join(directory, assetName);
    writeZipArchiveEntries(zipPath, [
      { name: "Keiko/README.txt", data: Buffer.from(`folder package for ${platformTarget}\n`) },
    ]);
    const sha256 = digestFor(readFileSync(zipPath));
    writeFileSync(`${zipPath}.sha256`, folderChecksumText(sha256, assetName));
    return {
      platformTarget,
      form: "standalone",
      assetName,
      sha256,
      sizeBytes: statSync(zipPath).size,
      sourceArchive: { assetName: target.assetName, sha256: digestFor(readFileSync(archivePath)) },
    };
  });
  const manifest = folderPackagesManifest(RELEASE_VERSION, packages);
  options.mutateFolderPackages?.(manifest, directory);
  writeFileSync(
    join(directory, FOLDER_PACKAGES_MANIFEST),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

function writeNativeHelperFixture(targetRoot, target) {
  const resourceRoot =
    target.nodePlatform === "darwin"
      ? join(targetRoot, "payload", "Keiko", "Keiko.app", "Contents", "Resources")
      : join(targetRoot, "payload", "Keiko");
  for (const name of ["keiko-secure-workspace-read", "keiko-runtime-supervisor"]) {
    const path = join(resourceRoot, nativeHelperExecutablePath(target, name));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, nativeHelperBytes(target, name));
  }
}

function addPortableSidecarFixture(targetRoot, manifest, target, unsafeKind) {
  const sidecar = portableSidecarRecord(
    target,
    writePortableSidecarFiles(targetRoot, target, unsafeKind),
  );
  manifest.sidecarRuntimes = [sidecar];
  manifest.releaseImpact.reviewedBinding.sidecarRuntimes = JSON.parse(JSON.stringify([sidecar]));
}

// Writes the sidecar executable, license and SBOM, and measures what the record has to bind.
function writePortableSidecarFiles(targetRoot, target, unsafeKind) {
  const name = "opencode-compatible";
  const payloadRootPath = `runtime/sidecars/${name}`;
  const resourceRoot =
    target.nodePlatform === "darwin"
      ? join(targetRoot, "payload", "Keiko", "Keiko.app", "Contents", "Resources")
      : join(targetRoot, "payload", "Keiko");
  const sidecarRoot = join(resourceRoot, payloadRootPath);
  mkdirSync(join(sidecarRoot, "evidence"), { recursive: true });
  const executablePath = `${payloadRootPath}/bin/opencode${target.nodePlatform === "win32" ? ".exe" : ""}`;
  const executableBytes = Buffer.from(`sidecar executable for ${target.platformTarget}\n`);
  mkdirSync(dirname(join(resourceRoot, executablePath)), { recursive: true });
  writeFileSync(join(resourceRoot, executablePath), executableBytes);
  const licensePath = join(sidecarRoot, "LICENSE.txt");
  const sbomPath = join(sidecarRoot, "evidence", "sbom.cdx.json");
  const licenseBytes = Buffer.from(
    unsafeKind === "license" ? "token=forbidden-secret\n" : "Sidecar license.\n",
  );
  const sbomBytes = Buffer.from(
    unsafeKind === "sbom"
      ? '{"bomFormat":"CycloneDX","rawOutput":"secret"}\n'
      : '{"bomFormat":"CycloneDX"}\n',
  );
  writeFileSync(licensePath, licenseBytes);
  writeFileSync(sbomPath, sbomBytes);
  return {
    name,
    payloadRootPath,
    executablePath,
    executableBytes,
    licenseBytes,
    sbomBytes,
    payloadSha256: hashDirectoryTree(sidecarRoot),
    sizeBytes:
      statSync(join(resourceRoot, executablePath)).size +
      statSync(licensePath).size +
      statSync(sbomPath).size,
  };
}

function portableSidecarRecord(target, files) {
  const { name, payloadRootPath, executablePath, executableBytes, licenseBytes, sbomBytes } = files;
  const executableSha256 = digestFor(executableBytes);
  const executableRelative = executablePath.slice(payloadRootPath.length + 1);
  const executableTreeSha256 = digestFor(`${executableRelative}\0${executableSha256}\0`);
  return {
    name,
    kind: "coding-runtime",
    approvalSchemaVersion: 2,
    upstream: structuredClone(APPROVED_SIDECAR.upstream),
    adapterCompatibility: structuredClone(APPROVED_SIDECAR.adapterCompatibility),
    protocolSchema: structuredClone(APPROVED_SIDECAR.protocolSchema),
    releaseApproval: structuredClone(APPROVED_SIDECAR.releaseApproval),
    license: {
      spdxId: "MIT",
      url: APPROVED_SIDECAR.license.url,
      sha256: digestFor(licenseBytes),
    },
    archive: {
      platformTarget: target.platformTarget,
      url: APPROVED_SIDECAR.archives[target.platformTarget].url,
      sizeBytes: executableBytes.length,
      sha256: "a".repeat(64),
    },
    executableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
    executableTreeSha256,
    executableSha256,
    platformTarget: target.platformTarget,
    payloadRootPath,
    executablePath,
    payloadSha256: files.payloadSha256,
    sizeBytes: files.sizeBytes,
    licenseEvidence: {
      path: `${payloadRootPath}/LICENSE.txt`,
      sha256: digestFor(licenseBytes),
    },
    sbomEvidence: {
      path: `${payloadRootPath}/evidence/sbom.cdx.json`,
      sha256: digestFor(sbomBytes),
    },
    signing: {
      ...portableSidecarSigning(target),
      shippedExecutableSha256: executableSha256,
      shippedExecutableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
      shippedExecutableTreeSha256: executableTreeSha256,
    },
  };
}

function writePortableEvidence(targetRoot, manifest, provenanceText) {
  writeFileSync(
    join(targetRoot, "evidence", "SHA256SUMS.txt"),
    `${manifest.artifact.sha256}  ${manifest.artifact.assetName}\n`,
  );
  writeFileSync(
    join(targetRoot, "evidence", "sbom.cdx.json"),
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      components: manifest.nativeHelpers.map((helper) => ({
        type: "application",
        name: helper.name,
        version: RELEASE_VERSION,
        "bom-ref": helper.sbomBomRef,
        hashes: [{ alg: "SHA-256", content: helper.shippedSha256 }],
      })),
    }) + "\n",
  );
  writeFileSync(
    join(targetRoot, "evidence", "third-party-notices.txt"),
    "Portable fixture notices.\n",
  );
  writeFileSync(
    join(targetRoot, "evidence", "signing-verification.json"),
    JSON.stringify(portableVerificationSummaryForManifest(manifest)) + "\n",
  );
  writeFileSync(join(targetRoot, "evidence", "provenance.intoto.jsonl"), provenanceText);
}

function releaseImpactCatalogForPublishTest() {
  return {
    ...RELEASE_IMPACT_CATALOG,
    entries: RELEASE_IMPACT_CATALOG.entries.map((entry) =>
      entry.packageName === RELEASE_NAME && entry.packageVersion === RELEASE_VERSION
        ? {
            ...entry,
            review: {
              ...entry.review,
              approvalReference: "github-pr-review:oscharko-dev/Keiko#999#888",
            },
          }
        : entry,
    ),
  };
}

// A stub state that cannot be parsed keeps the subprocess diagnostics, which say why.
function readStubState(stateFile, result) {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (cause) {
    throw new Error(
      `stub state.json could not be read (exit ${String(result.status)}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      { cause },
    );
  }
}

// The environment of one orchestrator run: the stubs first on PATH, every gate satisfied offline,
// and nothing real carried from the developer's environment.
function publishEnvironment({
  binDir,
  catalogFile,
  runtimeReleasesFile,
  signingKeyPair,
  qualificationEnv,
}) {
  const { privateKey, publicKey } = signingKeyPair;
  const env = {
    ...process.env,
    PATH: binDir + delimiter + process.env.PATH,
    // Satisfy the release-owner approval gate offline: the repository must match the
    // approval references in the live catalog, and the reviewer login must be allowed.
    GITHUB_REPOSITORY: "oscharko-dev/Keiko",
    KEIKO_PORTABLE_ASSETS_ARTIFACT_NAME: "portable-release-assets",
    KEIKO_PORTABLE_ASSETS_REPOSITORY: "oscharko-dev/Keiko",
    KEIKO_PORTABLE_ASSETS_RUN_ATTEMPT: "1",
    KEIKO_PORTABLE_ASSETS_RUN_ID: "123456789",
    KEIKO_PORTABLE_ASSETS_SOURCE_SHA: HEAD_SHA,
    KEIKO_PORTABLE_ASSETS_TAG: `v${RELEASE_VERSION}`,
    KEIKO_PORTABLE_ASSETS_WORKFLOW_PATH: ".github/workflows/portable-assets.yml",
    KEIKO_RELEASE_IMPACT_CATALOG_PATH: catalogFile,
    KEIKO_CODING_RUNTIME_RELEASES_PATH: runtimeReleasesFile,
    KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "release-owner",
    // This suite's stub npm/gh/git answer only the questions the pre-existing orchestrator asks;
    // the deployment-record and alignment-gate logic added for issue #3252 is covered directly
    // (and hermetically) by npm-publish-deployment.test.mjs and check-release-alignment.test.mjs
    // instead of being re-proven here through five more fabricated endpoints. Same double gate as
    // KEIKO_RELEASE_IMPACT_CATALOG_PATH above: NODE_ENV=test alone (a real publish never has it)
    // cannot trip this on its own.
    KEIKO_RELEASE_SKIP_ALIGNMENT_PROOF: "1",
    // The real orchestrator must never inherit a developer's private registry credential. Tests
    // choose every auth source explicitly through qualificationEnv below.
    KEIKO_RELEASE_DISABLE_DOTENV_TOKEN: "1",
    // Deterministic npmrc generation; the stub npm never uses this token.
    NPM_CONFIG_STRICT_SSL: "true",
    NODE_AUTH_TOKEN: "stub-token-never-sent",
    KEIKO_RELEASE_VERIFY_ATTEMPTS: "3",
    KEIKO_RELEASE_VERIFY_DELAY_MS: "0",
    KEIKO_PORTABLE_RELEASE_SIGNING_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
    KEIKO_PORTABLE_RELEASE_TEST_PUBLIC_KEY: publicKey.export({ format: "pem", type: "spki" }),
    NODE_ENV: "test",
    ...qualificationEnv,
  };
  for (const [key, value] of Object.entries(qualificationEnv)) {
    if (value === undefined) Reflect.deleteProperty(env, key);
  }
  // GH_TOKEN would be forwarded to the stub gh; drop it so nothing real is carried.
  Reflect.deleteProperty(env, "GH_TOKEN");
  return env;
}

// The directory one orchestrator run puts first on PATH: the npm/gh/git/curl/sh stubs, their call
// log and state, and the catalogs the run reads in place of the repository's.
function prepareStubDirectory({ npmBody, initState, codingRuntimeReleases }) {
  const binDir = mkdtempSync(join(tmpdir(), "keiko-release-publish-stub-"));
  const logFile = join(binDir, "calls.log");
  const stateFile = join(binDir, "state.json");
  const catalogFile = join(binDir, "release-impact.catalog.json");
  const runtimeReleasesFile = join(binDir, "coding-runtime-npm-packages.json");
  writeFileSync(logFile, "", "utf8");
  writeFileSync(stateFile, JSON.stringify(initState), "utf8");
  writeFileSync(catalogFile, JSON.stringify(releaseImpactCatalogForPublishTest()), "utf8");
  writeFileSync(runtimeReleasesFile, JSON.stringify(codingRuntimeReleases), "utf8");
  makeStub(binDir, "npm", npmBody, logFile, stateFile);
  makeStub(binDir, "gh", ghStubBody(), logFile, stateFile);
  makeStub(binDir, "git", gitStubBody(), logFile, stateFile);
  makeStub(binDir, "curl", curlStubBody(), logFile, stateFile);
  makeShStub(binDir, logFile);
  return { binDir, logFile, stateFile, catalogFile, runtimeReleasesFile };
}

function runOrchestrator(env, extraArgs, logFile, stateFile) {
  const result = spawnSync(
    process.execPath,
    ["scripts/release-publish.mjs", "--tag", "latest", ...extraArgs],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    },
  );

  const calls = readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const finalState = readStubState(stateFile, result);

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    state: finalState,
  };
}

// Run the real scripts/release-publish.mjs with stub npm/gh/git prepended to PATH.
// `npmBody` is the stub-`npm` behaviour under test; `initState` seeds the publish state.
// Returns the exit status, stdout/stderr, and the ordered list of intercepted calls.
export function runPublish({
  npmBody,
  initState,
  portableAssets = true,
  portableFixtureOptions = {},
  qualificationEnv = {},
  extraArgs = [],
  codingRuntimeReleases = codingRuntimeReleasesForPublishTest(),
  signingKeyPair = generateKeyPairSync("ed25519"),
}) {
  const { binDir, logFile, stateFile, catalogFile, runtimeReleasesFile } = prepareStubDirectory({
    npmBody,
    initState,
    codingRuntimeReleases,
  });
  const portableDir = mkdtempSync(join(tmpdir(), "keiko-portable-assets-fixture-"));
  const env = publishEnvironment({
    binDir,
    catalogFile,
    runtimeReleasesFile,
    signingKeyPair,
    qualificationEnv,
  });
  if (portableAssets) {
    env.KEIKO_PORTABLE_ASSETS_MANIFEST = writePortableAssetsFixture(
      portableDir,
      portableFixtureOptions,
    );
  }

  try {
    return runOrchestrator(env, extraArgs, logFile, stateFile);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(portableDir, { recursive: true, force: true });
  }
}

// A stub `npm` that shares the config/gate scaffolding and lets each scenario plug in the
// `view` behaviour that is actually under test.
export function npmPackStubLines() {
  return [
    'if (sub === "pack") {',
    '  const destinationIndex = argv.indexOf("--pack-destination");',
    "  const destination = destinationIndex === -1 ? process.cwd() : argv[destinationIndex + 1];",
    '  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));',
    '  const archiveName = `${manifest.name.replace(/^@/u, "").replace("/", "-")}-${manifest.version}.tgz`;',
    '  writeFileSync(join(destination, archiveName), "deterministic stub archive\\n");',
    "  process.exit(0);",
    "}",
  ];
}

export function npmStub(viewBody, { failOnPublish = false } = {}) {
  return [
    'log("npm");',
    "const sub = argv[0];",
    // strict-ssl probe from createNpmEnvironment().
    'if (sub === "config" && argv[1] === "get" && argv[2] === "strict-ssl") { process.stdout.write("true\\n"); process.exit(0); }',
    // All `npm run <gate>` invocations (version-consistency, publish-manifests,
    // release-impact, prepack, smoke) succeed so control reaches the publish loop.
    'if (sub === "run") { process.exit(0); }',
    ...npmPackStubLines(),
    'if (sub === "view") {',
    viewBody,
    "}",
    'if (sub === "publish") {',
    '  logCwd("npm");',
    failOnPublish
      ? '  process.stderr.write("stub npm: publish must not run when the version already exists\\n"); process.exit(97);'
      : "  setState({ published: true }); process.exit(0);",
    "}",
    'if (sub === "dist-tag" && argv[1] === "add") { setState({ tagged: true }); process.exit(0); }',
    'process.stderr.write("stub npm: unhandled " + JSON.stringify(argv) + "\\n");',
    "process.exit(3);",
  ].join("\n");
}

export const indexOfCall = (calls, predicate) => calls.findIndex(predicate);
const isView = (line) => line.startsWith('npm ["view"');
export const isVersionView = (line) => isView(line) && line.includes('"version"');
export const isDistTagView = (line) => isView(line) && line.includes("dist-tags.");
export const isVersionEndpointCurl = (line) =>
  line.startsWith("curl [") && line.includes(`/${RELEASE_VERSION}`);

// The pipeline suite drives the real orchestrator against the CURRENT root package version
// and models the stable latest flow (portable uploads, dist-tag resolution). With a prerelease
// root version (release-branch beta stabilization) that flow is rejected up front by design —
// the always-on "proves the latest dist-tag path" test in release-impact-notes.test.mjs pins
// that rejection — so the stable-flow suite runs only on stable versions (dev).
export const RELEASE_VERSION_IS_PRERELEASE = RELEASE_VERSION.includes("-");
// An explicit empty value blocks release-publish's intentional local `.env` fallback, keeping the
// no-token scenarios hermetic even when a developer has registry credentials in the repository.
// These scenarios model CI trusted publishing, and CI always announces its OIDC endpoint — the
// auth preflight refuses a run that has neither a token nor that signal.
export const NO_REGISTRY_TOKEN_ENV = {
  NODE_AUTH_TOKEN: undefined,
  NPM_TOKEN: "",
  // Both values are required for npm's OIDC identity exchange; the URL alone cannot mint a
  // token (CodeRabbit finding on #3055).
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token-request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions-oidc-request-bearer",
};

/** Every case drives the built CLI through the orchestrator; a missing build fails fast. */
export function assertReleaseBuildPresent() {
  if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) {
    throw new Error(
      "release-publish tests require dist/index.js; run `npm run build` before this suite.",
    );
  }
}
