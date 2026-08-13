// Regression gate for the publish/verify pipeline in scripts/release-publish.mjs
// (finding GEN-TEST-RELEASE-GATE-006). release-publish.mjs is THE production npm
// publish orchestrator invoked by .github/workflows/release.yml. Its publish path —
// the "already published?" E404 heuristic, the publish-then-tag ordering, and the
// post-publish dist-tag verification — is only reachable by shelling out to `npm`,
// `gh`, and `git`, and the module exports nothing. Prior coverage only exercised
// argument validation.
//
// This suite drives the REAL orchestrator as a subprocess (the same seam the existing
// release-impact governance test uses) but prepends a temp dir of stub `npm`/`gh`/`git`
// executables to PATH. Because release-publish.mjs spawns every external tool by name
// (commandResult("npm", ...), gh([...]), commandResult("git", ...)), the stubs intercept
// all of them. The stubs record every invocation to a log file and emit scripted
// stdout/exit codes, so we can assert on the DECISIONS the orchestrator makes and the
// ORDER of the calls — never on source text.
//
// The stubs also gate off the network entirely: `npm view/publish/dist-tag` never touch
// a registry, and the GitHub release-owner approval check (which normally runs
// `gh api repos/.../reviews/...`) is answered by the stub `gh`. The registry stays a
// bogus default and no real credentials are used. Nothing can be published anywhere.
//
// Scenarios exercised against the real code:
//   A. Fresh publish — `npm view <spec> version` returns E404 (unpublished) -> the
//      orchestrator PUBLISHes, then adds the dist-tag, then verifies. Red-on-defect:
//      if the E404 heuristic were broken (treating E404 as "already there"), publish
//      would be skipped and the recorded call sequence would lose the `npm publish`.
//   B. Already published — `npm view <spec> version` already returns the target version
//      -> the orchestrator SKIPs publish but still verifies the dist-tag. Red-on-defect:
//      a broken skip-path would re-invoke `npm publish` (the stub fails hard if it does).
//   C. Dist-tag mismatch — after publish, `npm view <name> dist-tags.<tag>` keeps
//      pointing at the wrong version -> verifyPackage MUST fail the release (exit 1).
//      Red-on-defect: if the dist-tag comparison were dropped, the release would
//      falsely report PASS.
//   D. No npm registry token configured (the OIDC trusted-publishing CI shape) — a fresh
//      publish must still succeed end-to-end on `npm publish` alone even through transient
//      dist-tag read propagation lag (retried, not failed), and a dist-tag repair genuinely
//      needed on an idempotent re-run must fail with an actionable error rather than a bare
//      npm 401, because npm Trusted Publishing does not authorize `npm dist-tag add`.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  hashDirectoryTree,
  portableVerificationSummaryForManifest,
  PORTABLE_TARGETS,
  WINDOWS_PORTABLE_SETUP_ASSET_NAME,
} from "../portable-runtime.mjs";
import {
  buildPortableEvaluationManifest,
  PORTABLE_EVALUATION_MANIFEST_ASSET_NAME,
} from "../lib/portable-evaluation-manifest.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

beforeAll(() => {
  if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) {
    throw new Error(
      "release-publish tests require dist/index.js; run `npm run build` before this suite.",
    );
  }
});

// The orchestrator reads the release version from the live root manifest at runtime,
// so the stubs must answer with that same version rather than a hardcoded one. This
// keeps the gate correct across version bumps.
const ROOT_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const RELEASE_IMPACT_CATALOG = JSON.parse(
  readFileSync(join(REPO_ROOT, "release-impact.catalog.json"), "utf8"),
);
const RELEASE_VERSION = ROOT_MANIFEST.version;
// The exact download set a stable `latest` release must carry, derived from the same target
// table the orchestrator uses — a restated list here could drift past a new target silently.
// Derived from the same target table the orchestrator uses, deduplicated so a target table that
// ever repeats a name cannot silently shorten the expected set.
const PUBLISHED_DOWNLOAD_NAMES = [
  ...new Set([
    ...PORTABLE_TARGETS.map((target) => target.assetName),
    WINDOWS_PORTABLE_SETUP_ASSET_NAME,
  ]),
];
const RELEASE_NAME = ROOT_MANIFEST.name;
const RELEASE_SPEC = `${RELEASE_NAME}@${RELEASE_VERSION}`;

// A deterministic sha the stub `git` returns for both `rev-parse HEAD` and
// `rev-parse v<version>^{}`, so ensureReleaseTag() sees HEAD === tag and proceeds.
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const NODE_VERSION = "24.0.0";

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
    ),
    provenanceText,
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
) {
  const releaseTag = `v${RELEASE_VERSION}`;
  const security = portableSecurity(target, notarizationRequired, verificationChecks);
  const runtimeActivation = portableRuntimeActivation(target);
  const runtimeAttestation =
    target.nodePlatform === "win32" ? portableRuntimeAttestation(target) : undefined;
  const runtimeQualification =
    target.nodePlatform === "darwin" ? portableRuntimeQualification() : undefined;
  return {
    schemaVersion: 1,
    product: portableProduct(),
    release: { releaseId: 0, releaseTag, stable: true, commitSha: HEAD_SHA },
    artifact: portableArtifact(target, assetId, archiveSize, archiveSha256),
    provenance: portableProvenance(provenanceSha256),
    runtime: portableRuntime(target),
    runtimeActivation,
    ...(runtimeAttestation === undefined ? {} : { runtimeAttestation }),
    ...(runtimeQualification === undefined ? {} : { runtimeQualification }),
    nativeHelpers,
    packageSurface: portablePackageSurface(),
    entrypoints: {
      primaryLauncher: target.primaryLauncher,
      supportLaunchers: targetSupportLaunchers(target),
    },
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
        ? `native/runtime-supervisor/${target.nodePlatform === "win32" ? "windows" : "macos"}`
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
      target.nodePlatform === "win32" ? "authenticode-attestor" : "developer-id-app-resource-seal",
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

function portableRuntimeQualification() {
  return {
    schemaVersion: 1,
    path: ".portable/runtime-qualification.json",
    sha256: "e".repeat(64),
    backend: "macos-endpoint-security",
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
  resolve(fileURLToPath(import.meta.url), "..", "..", "lib", "zip-archive.mjs"),
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
    "function log(bin) { appendFileSync(LOG, bin + ' ' + JSON.stringify(argv) + '\\n'); }",
    "function logCwd(bin) { appendFileSync(LOG, bin + '-cwd ' + JSON.stringify(process.cwd()) + '\\n'); }",
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
    'log("gh");',
    "const sub = argv[0];",
    'if (sub === "attestation" && argv[1] === "verify") {',
    "  if (state().failSetupAttestation) { process.stderr.write('setup provenance verification failed\\n'); process.exit(46); }",
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
    '  if (argv[1] && argv[1].includes("/releases/latest")) {',
    // Which release GitHub presents as Latest. By default the same release the by-tag read
    // answers with; a test can hand the badge to another release to prove the refusal.
    "    writeFileSync(1, JSON.stringify({ id: state().latestBadgeElsewhere ? 111 : 987654321 }));",
    "    process.exit(0);",
    "  }",
    '  if (argv[1] && argv[1].includes("/releases/tags/")) {',
    // The release-by-tag endpoint always reports both flags; the prepublished gate requires the
    // published stable shape, so the double states it the way the real API does.
    "    writeFileSync(1, JSON.stringify({ id: 987654321, draft: state().releaseDraft === true, prerelease: state().releasePrerelease === true, assets: state().uploadedAssets || [] }));",
    "    process.exit(0);",
    "  }",
    '  process.stdout.write(JSON.stringify({ state: "APPROVED", user: { login: "release-owner" } }));',
    "  process.exit(0);",
    "}",
    // An existing release answers the isDraft,assets probe. An interrupted evaluation publish
    // leaves a resumable stable-tag DRAFT; a completed one leaves a published release carrying
    // the evidence manifest — the qualified upload path must refuse to edit over either.
    'if (sub === "release" && argv[1] === "view") {',
    "  if (state().existingReleaseIsDraft) { writeFileSync(1, JSON.stringify({ isDraft: true, assets: [] })); process.exit(0); }",
    "  if (state().existingEvaluationRelease) { writeFileSync(1, JSON.stringify({ isDraft: false, assets: [{ name: 'keiko-portable-evaluation-manifest.json' }] })); process.exit(0); }",
    "  process.exit(1);",
    "}",
    'if (sub === "release" && argv[1] === "upload") {',
    "  const current = state();",
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
  ].join("\n");
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
    "process.exit(0);",
  ].join("\n");
}

function makeStub(binDir, name, body, logFile, stateFile) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${stubPrologue(logFile, stateFile)}${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

function passthroughViewBody() {
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
function prepublishedEvaluationState() {
  const sourceCommitSha = HEAD_SHA;
  const workflowRunId = "31300595709";
  const downloads = PUBLISHED_DOWNLOAD_NAMES.map((name, index) => {
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
    "appendFileSync(LOG, 'curl ' + JSON.stringify([argv.at(-1)]) + '\\n');",
    'const outputIndex = argv.indexOf("--output");',
    'const output = outputIndex >= 0 ? argv[outputIndex + 1] : "";',
    'const name = argv.at(-1).split("/").at(-1);',
    "const asset = (state().uploadedAssets || []).find((entry) => entry.name === name);",
    "if (!asset || output.length === 0) process.exit(2);",
    'const bytes = Buffer.from(asset.content, "base64");',
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
    writeFileSync(archivePath, `portable archive for ${target.platformTarget}\n`);
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
  return manifestPath;
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
  const executableSha256 = digestFor(executableBytes);
  const executableRelative = executablePath.slice(payloadRootPath.length + 1);
  const executableTreeSha256 = digestFor(`${executableRelative}\0${executableSha256}\0`);
  const sidecar = {
    name,
    kind: "coding-runtime",
    approvalSchemaVersion: 2,
    upstream: {
      owner: "anomalyco",
      repository: "opencode",
      name: "opencode",
      version: "1.17.17",
      tag: "v1.17.17",
      commit: "474abdd7ee60f4b67476cfcef7e5311beff4a824",
    },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      transport: "http-sse",
    },
    protocolSchema: {
      path: "packages/sdk/openapi.json",
      url: "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/packages/sdk/openapi.json",
      sha256: "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de",
      hashAlgorithm: "sha256",
      hashEncoding: "lowercase-hex",
      digestInput: "upstream-raw-bytes",
      transport: "http-sse",
    },
    releaseApproval: {
      redistribution: {
        status: "approved",
        reviewReference: "https://github.com/oscharko-dev/Keiko/issues/2253",
      },
      subscriptionAuth: {
        status: "not-applicable",
        reviewReference: "https://github.com/oscharko-dev/Keiko/issues/2253",
      },
    },
    license: {
      spdxId: "MIT",
      url: "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/LICENSE",
      sha256: digestFor(licenseBytes),
    },
    archive: {
      platformTarget: target.platformTarget,
      url: `https://github.com/anomalyco/opencode/releases/download/v1.17.17/opencode-${target.platformTarget}.zip`,
      sizeBytes: executableBytes.length,
      sha256: "a".repeat(64),
    },
    executableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
    executableTreeSha256,
    executableSha256,
    platformTarget: target.platformTarget,
    payloadRootPath,
    executablePath,
    payloadSha256: hashDirectoryTree(sidecarRoot),
    sizeBytes:
      statSync(join(resourceRoot, executablePath)).size +
      statSync(licensePath).size +
      statSync(sbomPath).size,
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
  manifest.sidecarRuntimes = [sidecar];
  manifest.releaseImpact.reviewedBinding.sidecarRuntimes = JSON.parse(JSON.stringify([sidecar]));
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

// Run the real scripts/release-publish.mjs with stub npm/gh/git prepended to PATH.
// `npmBody` is the stub-`npm` behaviour under test; `initState` seeds the publish state.
// Returns the exit status, stdout/stderr, and the ordered list of intercepted calls.
function runPublish({
  npmBody,
  initState,
  portableAssets = true,
  portableFixtureOptions = {},
  qualificationEnv = {},
  extraArgs = [],
}) {
  const binDir = mkdtempSync(join(tmpdir(), "keiko-release-publish-stub-"));
  const portableDir = mkdtempSync(join(tmpdir(), "keiko-portable-assets-fixture-"));
  const logFile = join(binDir, "calls.log");
  const stateFile = join(binDir, "state.json");
  const catalogFile = join(binDir, "release-impact.catalog.json");
  writeFileSync(logFile, "", "utf8");
  writeFileSync(stateFile, JSON.stringify(initState), "utf8");
  writeFileSync(catalogFile, JSON.stringify(releaseImpactCatalogForPublishTest()), "utf8");

  makeStub(binDir, "npm", npmBody, logFile, stateFile);
  makeStub(binDir, "gh", ghStubBody(), logFile, stateFile);
  makeStub(binDir, "git", gitStubBody(), logFile, stateFile);
  makeStub(binDir, "curl", curlStubBody(), logFile, stateFile);

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
    KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "release-owner",
    // Deterministic npmrc generation; the stub npm never uses this token.
    NPM_CONFIG_STRICT_SSL: "true",
    NODE_AUTH_TOKEN: "stub-token-never-sent",
    KEIKO_RELEASE_VERIFY_ATTEMPTS: "3",
    KEIKO_RELEASE_VERIFY_DELAY_MS: "0",
    ...qualificationEnv,
  };
  for (const [key, value] of Object.entries(qualificationEnv)) {
    if (value === undefined) Reflect.deleteProperty(env, key);
  }
  // GH_TOKEN would be forwarded to the stub gh; drop it so nothing real is carried.
  Reflect.deleteProperty(env, "GH_TOKEN");
  if (portableAssets) {
    env.KEIKO_PORTABLE_ASSETS_MANIFEST = writePortableAssetsFixture(
      portableDir,
      portableFixtureOptions,
    );
  }

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
  rmSync(binDir, { recursive: true, force: true });
  rmSync(portableDir, { recursive: true, force: true });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// A stub `npm` that shares the config/gate scaffolding and lets each scenario plug in the
// `view` behaviour that is actually under test.
function npmPackStubLines() {
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

function npmStub(viewBody, { failOnPublish = false } = {}) {
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

const indexOfCall = (calls, predicate) => calls.findIndex(predicate);
const isView = (line) => line.startsWith('npm ["view"');
const isVersionView = (line) => isView(line) && line.includes('"version"');
const isDistTagView = (line) => isView(line) && line.includes("dist-tags.");

// The pipeline suite drives the real orchestrator against the CURRENT root package version
// and models the stable latest flow (portable uploads, dist-tag resolution). With a prerelease
// root version (release-branch beta stabilization) that flow is rejected up front by design —
// the always-on "proves the latest dist-tag path" test in release-impact-notes.test.mjs pins
// that rejection — so the stable-flow suite runs only on stable versions (dev).
const RELEASE_VERSION_IS_PRERELEASE = RELEASE_VERSION.includes("-");
// An explicit empty value blocks release-publish's intentional local `.env` fallback, keeping the
// no-token scenarios hermetic even when a developer has registry credentials in the repository.
// These scenarios model CI trusted publishing, and CI always announces its OIDC endpoint — the
// auth preflight refuses a run that has neither a token nor that signal.
const NO_REGISTRY_TOKEN_ENV = {
  NODE_AUTH_TOKEN: undefined,
  NPM_TOKEN: "",
  // Both values are required for npm's OIDC identity exchange; the URL alone cannot mint a
  // token (CodeRabbit finding on #3055).
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token-request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions-oidc-request-bearer",
};

describe.skipIf(RELEASE_VERSION_IS_PRERELEASE)(
  "release-publish pipeline (real orchestrator, stubbed npm/gh/git)",
  () => {
    let lastRun;

    afterEach(() => {
      lastRun = undefined;
    });

    it("refuses a stable latest publish whose GitHub release carries no downloads", () => {
      // The requirement that a stable `latest` offers customer downloads did not move — WHERE it
      // is answered did. It used to demand a qualified asset MANIFEST as a publish input, which
      // only the Developer-ID/Azure-signed production lane can produce, so it refused every stable
      // release this project can currently build. It is now answered against the release itself,
      // which is strictly stronger: a well-formed manifest input proves nothing about whether the
      // upload actually landed. npm must never learn `latest` for a release with nothing behind it.
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write("0.0.1\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: false, tagged: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("is missing portable downloads");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      // And it leaves nothing customer-visible behind. Creating the release before proving it
      // would publish an empty Latest release advertising downloads that are not there, and the
      // evaluation lane could then no longer create that tag — it refuses a non-draft release.
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","create"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","edit"'))).toBe(false);
    });

    it("previews a stable latest plan without the workflow-only qualification environment", () => {
      // A local `release:plan` has no KEIKO_PORTABLE_ASSETS_* environment — that exists only
      // inside the release workflow. Demanding it here made a preview fail before rendering its
      // notes even with a valid manifest, which is not what a preview is for (Codex finding on
      // #3054). The structural manifest validation still runs.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: true, tagged: true },
        extraArgs: ["--plan-only"],
        qualificationEnv: {
          KEIKO_PORTABLE_ASSETS_ARTIFACT_NAME: undefined,
          KEIKO_PORTABLE_ASSETS_REPOSITORY: undefined,
          KEIKO_PORTABLE_ASSETS_RUN_ATTEMPT: undefined,
          KEIKO_PORTABLE_ASSETS_RUN_ID: undefined,
          KEIKO_PORTABLE_ASSETS_SOURCE_SHA: undefined,
          KEIKO_PORTABLE_ASSETS_TAG: undefined,
          KEIKO_PORTABLE_ASSETS_WORKFLOW_PATH: undefined,
        },
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain("PLAN-ONLY complete");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("publishes a stable latest release whose downloads the evaluation lane already uploaded", () => {
      // The release-owner-scoped path for the first public release: the governed evaluation lane
      // publishes the four unsigned-but-sealed downloads onto the tag with the evidence that
      // binds them, and this run promotes the dist-tag without re-uploading anything. It must
      // actually SUCCEED — an orchestrator that silently skipped publication would satisfy a
      // weaker assertion while shipping nothing.
      // The version is NOT on the registry yet, so this run must genuinely publish it: an
      // orchestrator that skipped publication would otherwise satisfy every other assertion here
      // while shipping nothing.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
        '    process.stdout.write(VERSION + "\\n"); process.exit(0);',
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        '    process.stdout.write((s.published ? VERSION : "0.0.1") + "\\n"); process.exit(0);',
        "  }",
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody),
        initState: { ...prepublishedEvaluationState(), published: false },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain("match their evidence");
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
      // And it leaves the release surface alone. That release already carries the Latest flag and
      // the customer-facing install notes the evaluation lane wrote — first-launch steps,
      // checksums, provenance. Rewriting its body with the generated catalog notes would replace
      // exactly the guidance a non-technical customer needs. This run owns npm, not that release.
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","edit"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","create"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(true);
    });

    it("refuses prepublished downloads that carry no evaluation evidence", () => {
      // A name and a non-zero size authorize nothing: without the manifest that binds these bytes
      // to a tag, a commit and a successful workflow run, a stale or hand-uploaded file could
      // promote the npm latest tag (Codex and CodeRabbit findings on #3054).
      const state = prepublishedEvaluationState();
      state.uploadedAssets = state.uploadedAssets.filter(
        (asset) => asset.name !== PORTABLE_EVALUATION_MANIFEST_ASSET_NAME,
      );

      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: state,
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(PORTABLE_EVALUATION_MANIFEST_ASSET_NAME);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses a prepublished release when another release owns the Latest badge", () => {
      // The npm latest dist-tag and GitHub's Latest release must name the same bytes; a stable
      // release that lost the badge to another release must not promote (Codex finding on #3054).
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), latestBadgeElsewhere: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("does not own the Latest badge");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses a prepublished release that is still marked as a prerelease", () => {
      // The release-by-tag endpoint resolves prereleases with every asset in place, so without
      // this refusal a manually assembled prerelease-flagged release could promote npm latest
      // while GitHub never presents it as the stable Latest release (Codex finding on #3054).
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), releasePrerelease: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("only the published stable release");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses prepublished downloads whose bytes do not match their evidence", () => {
      // The evidence is only a claim until the bytes agree with it. Every download is re-fetched
      // over the same unauthenticated URL a customer uses; one tampered byte must stop the
      // promotion.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), tamperRemoteDownloads: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("downloaded portable asset bytes do not match");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("finds the run's artifacts when gh nests them one directory deep", () => {
      // `gh run download` places files directly in the target or one level deeper depending on how
      // the artifact was uploaded. Reading only the top level would refuse a perfectly good
      // release — the producer resolves them the same way.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), nestRunArtifacts: true },
        portableAssets: false,
      });

      expect(lastRun.stderr).toBe("");
      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain("match their evidence");
    });

    it("refuses prepublished downloads that are not the bytes their workflow run produced", () => {
      // The whole point of the run binding: replacing the downloads AND the manifest that
      // describes them is ONE action for anyone who can write release assets, so the evidence
      // sitting next to the assets can never be its own provenance. Workflow-run artifacts are not
      // writable after the run, so that is where the digests come from.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), tamperRunArtifacts: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("not the bytes their workflow run produced");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses prepublished downloads when the producing run's artifacts cannot be read", () => {
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { ...prepublishedEvaluationState(), runArtifactsUnavailable: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("could not be read");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses prepublished downloads whose evidence names an unsuccessful workflow run", () => {
      // Provenance that does not resolve to a successful run of the canonical workflow at the
      // declared commit is not provenance.
      const state = prepublishedEvaluationState();
      state.workflowRun = { ...state.workflowRun, conclusion: "failure" };

      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: state,
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("must have concluded successfully");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses to skip the GitHub Release when portable assets are supplied", () => {
      // Announcing downloads that are never uploaded is the failure this replaces: supplying a
      // manifest and skipping the release would publish an npm dist-tag whose notes point at
      // assets that do not exist.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableAssets: true,
        extraArgs: ["--skip-github-release"],
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "a publish that supplies portable assets must attach them to the GitHub Release.",
      );
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it.each([
      "KEIKO_PORTABLE_ASSETS_SOURCE_SHA",
      "KEIKO_PORTABLE_ASSETS_TAG",
      "KEIKO_PORTABLE_ASSETS_RUN_ID",
      "KEIKO_PORTABLE_ASSETS_RUN_ATTEMPT",
      "KEIKO_PORTABLE_ASSETS_ARTIFACT_NAME",
      "KEIKO_PORTABLE_ASSETS_REPOSITORY",
      "KEIKO_PORTABLE_ASSETS_WORKFLOW_PATH",
    ])("rejects missing qualified-run provenance %s before publication", (field) => {
      const viewBody = [
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        'if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        qualificationEnv: { [field]: undefined },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("qualified portable run provenance is invalid");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects an inner target relabelled against its outer bundle entry", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateManifest: (candidate, _target, index) => {
            if (index === 1) candidate.artifact.platformTarget = "windows-x64";
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("must match the outer bundle target");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    // portableAssetsFromManifest/normalizePortableAssets (release-publish.mjs) is the
    // publish-time twin of validatePortableReleaseSet: the last check before npm publish,
    // dist-tag mutation, or GitHub release promotion. Each case below shrinks/grows/
    // duplicates `bundle.artifacts` while keeping every remaining entry well-formed, so the
    // only thing that can make the run fail is the specific count/duplicate/missing guard
    // under test — never a same-shape neighbor.
    it("rejects a portable assets manifest missing a target before npm publish or dist-tag mutation", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          // Drop the third (macos-x64) target: only two of the three required artifacts remain.
          mutateBundle: (bundle) => {
            bundle.artifacts = bundle.artifacts.slice(0, 2);
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "portable assets manifest must list exactly three artifacts.",
      );
      expect(lastRun.stderr).toContain("missing portable asset entry for macos-x64.");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects a portable assets manifest with an extra target before npm publish or dist-tag mutation", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          // Append a fourth artifact: the three real targets remain untouched and well-formed.
          mutateBundle: (bundle) => {
            bundle.artifacts.push({ platformTarget: "linux-x64" });
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "portable assets manifest must list exactly three artifacts.",
      );
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects a portable assets manifest with a duplicate platformTarget before npm publish or dist-tag mutation", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          // Replace the macos-arm64 entry with a second copy of windows-x64: the artifact
          // count stays at three, so only the duplicate-target guard can catch this.
          mutateBundle: (bundle) => {
            bundle.artifacts[1] = { ...bundle.artifacts[0] };
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("duplicate portable platformTarget windows-x64.");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it.each([
      ["SBOM", "evidence/sbom.cdx.json", '{"bomFormat":"CycloneDX","tokenValue":"secret"}\n'],
      [
        "SBOM password",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","password":"correct-horse-battery-staple"}\n',
      ],
      [
        "SBOM token",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","token":"sensitive-but-not-prefix-shaped"}\n',
      ],
      [
        "SBOM authorization",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","Authorization":"Bearer sensitive-value"}\n',
      ],
      [
        "SBOM compound token",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","api_token":"opaque"}\n',
      ],
      [
        "SBOM semantic credential property",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","properties":[{"name":"api_token","value":"opaque"}]}\n',
      ],
      [
        "SBOM inline authorization",
        "evidence/sbom.cdx.json",
        '{"bomFormat":"CycloneDX","description":"request header Authorization: Bearer opaque"}\n',
      ],
      ["SBOM terminal credential", "evidence/sbom.cdx.json", '{"apitoken":"opaque"}\n'],
      [
        "SBOM GitHub PAT",
        "evidence/sbom.cdx.json",
        `{"component":"github_pat_${"x".repeat(82)}"}\n`,
      ],
      ["license", "evidence/third-party-notices.txt", "https://user:pass@example.com/private\n"],
      ["signing", "evidence/signing-verification.json", '{"rawOutput":"secret"}\n'],
      ["provenance", "evidence/provenance.intoto.jsonl", '{"privatePath":"/Users/customer"}\n'],
      ["checksum", "evidence/SHA256SUMS.txt", "token=forbidden-secret\n"],
      ["malformed SBOM", "evidence/sbom.cdx.json", '{"bomFormat":'],
    ])("rejects unsafe or malformed %s evidence before publication", (_class, path, content) => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateEvidence: (root, _manifest, _target, index) => {
            if (index === 0) writeFileSync(join(root, path), content);
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it.each([
      '{"password":"correct-horse-battery-staple"}\n',
      '{"Authorization":"Basic c2Vuc2l0aXZlOnZhbHVl"}\n',
      '{"authToken":"opaque"}\n',
      '{"refresh_token":"opaque"}\n',
      '{"authtoken":"opaque"}\n',
      `{"package":"npm_${"a".repeat(36)}"}\n`,
      '{"description":"mirror https://user:password@example.invalid/npm/"}\n',
    ])("rejects credential-bearing optional evidence before publication", (content) => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateBundle: (bundle) => {
            bundle.artifacts[0].evidencePaths = ["evidence/optional.json"];
          },
          mutateEvidence: (root, _manifest, _target, index) => {
            if (index === 0) writeFileSync(join(root, "evidence", "optional.json"), content);
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("is not redacted");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it.each(["license", "sbom"])(
      "rejects unsafe sidecar %s evidence before publication",
      (sidecarEvidenceKind) => {
        const viewBody =
          'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
        lastRun = runPublish({
          npmBody: npmStub(viewBody, { failOnPublish: true }),
          initState: { published: true, tagged: true },
          portableFixtureOptions: { sidecarEvidenceKind },
        });

        expect(lastRun.status).toBe(1);
        expect(lastRun.stderr).toContain("sidecar evidence is not redacted");
        expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
        expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
        expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
      },
    );

    it.each([
      "Authorization: Bearer sensitive-value\n",
      "request header Proxy-Authorization: Basic c2Vuc2l0aXZlOnZhbHVl\n",
      '{"proxy-authorization":"opaque"}\n',
      '{"client-password":"opaque"}\n',
      `npm_${"a".repeat(36)}\n`,
    ])("rejects credential-bearing sidecar evidence before publication", (content) => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          sidecarEvidenceKind: "safe",
          mutateEvidence: (root, _manifest, _target, index) => {
            if (index === 0) {
              writeFileSync(
                join(
                  root,
                  "payload",
                  "Keiko",
                  "runtime",
                  "sidecars",
                  "opencode-compatible",
                  "LICENSE.txt",
                ),
                content,
              );
            }
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("sidecar evidence is not redacted");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("allows benign authentication prose in release evidence", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateEvidence: (root, _manifest, _target, index) => {
            if (index === 0) {
              writeFileSync(
                join(root, "evidence", "third-party-notices.txt"),
                "Basic authentication utilities for local testing.\nThe bearer must retain this notice.\n",
              );
            }
          },
        },
      });

      expect(lastRun.stderr).not.toContain("license evidence is not redacted");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(true);
    });

    it("treats an E404 from `npm view … version` as unpublished and publishes, tags, then verifies", () => {
      // `npm view <spec> version` fails with E404 until a publish has happened; the
      // dist-tag view reports the wrong version until `npm dist-tag add` runs.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) {",
        // Real npm E404 shape; the heuristic scans for "E404" / "No match found".
        '      process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET " + argv[1] + "\\n");',
        "      process.exit(1);",
        "    }",
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        '    process.stdout.write((s.tagged ? VERSION : "0.0.0-stale") + "\\n");',
        "    process.exit(0);",
        "  }",
      ].join("\n");

      lastRun = runPublish({ npmBody: npmStub(viewBody), initState: { published: false } });

      expect(lastRun.status, lastRun.stderr).toBe(0);
      expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain("portable assets uploaded and verified");
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      // It must NOT have short-circuited as already-present.
      expect(lastRun.stdout).not.toContain(`SKIP ${RELEASE_SPEC} already exists`);

      // Decision order: check existence -> publish -> add dist-tag -> re-verify existence -> re-verify dist-tag.
      const firstVersionView = indexOfCall(lastRun.calls, isVersionView);
      const publishCall = indexOfCall(lastRun.calls, (l) => l.startsWith('npm ["publish"'));
      const distTagAdd = indexOfCall(lastRun.calls, (l) => l.startsWith('npm ["dist-tag","add"'));

      expect(firstVersionView).toBeGreaterThanOrEqual(0);
      expect(publishCall).toBeGreaterThan(firstVersionView);
      expect(distTagAdd).toBeGreaterThan(publishCall);

      // Publish carries the release-safety flags on the real command line.
      const publishLine = lastRun.calls.find((l) => l.startsWith('npm ["publish"'));
      expect(publishLine).toBe(
        'npm ["publish",".","--access","public","--tag","latest","--registry","https://registry.npmjs.org/","--ignore-scripts"]',
      );
      const publishCwdLine = lastRun.calls.find((line) => line.startsWith("npm-cwd "));
      expect(publishCwdLine).toBeDefined();
      const publishCwd = JSON.parse(publishCwdLine?.slice("npm-cwd ".length) ?? '""');
      expect(publishCwd).not.toBe(REPO_ROOT);
      expect(publishCwd).toMatch(/keiko-publish-stage-[^/\\]+$/u);
      // A token publish carries no provenance attestation: npm can attest only where an OIDC
      // provider exists, and the unconditional flag killed every local operator publish (0.3.1).

      // The post-publish verification pass re-reads BOTH the version and the dist-tag.
      const versionViews = lastRun.calls.filter(isVersionView).length;
      const distTagViews = lastRun.calls.filter(isDistTagView).length;
      expect(versionViews).toBeGreaterThanOrEqual(2);
      expect(distTagViews).toBeGreaterThanOrEqual(2);

      const uploadLine = lastRun.calls.find(
        (l) => l.startsWith('gh ["release","upload"') && l.includes("keiko-windows-x64.zip"),
      );
      expect(uploadLine).toContain("keiko-windows-x64.zip");
      expect(uploadLine).toContain(WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      expect(uploadLine).toContain("keiko-macos-arm64.zip");
      expect(uploadLine).toContain("keiko-macos-x64.zip");
      const setupAttestation = lastRun.calls.find((line) =>
        line.startsWith('gh ["attestation","verify"'),
      );
      expect(setupAttestation).toContain(WINDOWS_PORTABLE_SETUP_ASSET_NAME);
      expect(setupAttestation).toContain(
        '"--signer-workflow","oscharko-dev/Keiko/.github/workflows/portable-assets.yml"',
      );
      expect(setupAttestation).toContain(`"--source-digest","${HEAD_SHA}"`);
      expect(setupAttestation).toContain(`"--source-ref","refs/tags/v${RELEASE_VERSION}"`);
      expect(
        indexOfCall(lastRun.calls, (l) => l.startsWith('gh ["release","upload"')),
      ).toBeGreaterThan(indexOfCall(lastRun.calls, (l) => l === setupAttestation));
      expect(
        indexOfCall(lastRun.calls, (l) => l.startsWith('gh ["release","upload"')),
      ).toBeLessThan(publishCall);
      const setupDownload = lastRun.calls.find(
        (line) =>
          line.startsWith("curl [") &&
          line.endsWith(
            `"https://github.com/oscharko-dev/Keiko/releases/download/v${RELEASE_VERSION}/${WINDOWS_PORTABLE_SETUP_ASSET_NAME}"]`,
          ),
      );
      expect(setupDownload).toBeDefined();
    });

    it("binds setup evidence to verified remote bytes after local post-upload mutation", () => {
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: {
          mutateSetupAfterArchiveUpload: true,
          published: true,
          tagged: true,
        },
      });

      expect(lastRun.status, lastRun.stderr).toBe(0);
      expect(lastRun.stdout).toContain("portable assets uploaded and verified");
    });

    it("fails before npm publish when portable upload verification fails", () => {
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        '    if (!s.published) { process.stderr.write("npm error code E404\\n"); process.exit(1); }',
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody),
        initState: { failGhUpload: true, published: false },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("portable upload failed");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses to upload qualified assets over a published evaluation release", () => {
      // The evaluation lane's completed release is isDraft:false and carries the evidence
      // manifest; clobbering it with production bytes would leave that evidence beside foreign
      // downloads — a mixed-provenance surface (Codex finding on #3054).
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { existingEvaluationRelease: true, published: false },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("published by the evaluation lane");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","edit"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
    });

    it("refuses to edit over a resumable stable-tag draft left by an interrupted evaluation publish", () => {
      // Editing the draft would keep it private while npm publishes, clobber only same-named
      // assets, and leave the evaluation manifest beside qualified uploads (Codex finding on
      // #3054). The evaluation lane owns resuming or deleting its draft.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { existingReleaseIsDraft: true, published: false },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("exists as a draft");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","edit"'))).toBe(false);
    });

    it("rejects an unattested setup companion before release upload or npm publication", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { failSetupAttestation: true, published: true, tagged: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("setup provenance verification failed");
      expect(lastRun.calls.some((line) => line.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    it("rejects same-size remote tampering before npm publish or dist-tag mutation", () => {
      const viewBody = [
        'if (argv.includes("version")) { process.stderr.write("npm error code E404\\n"); process.exit(1); }',
        'if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody),
        initState: { published: false, tamperRemoteDownloads: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("downloaded portable asset bytes do not match");
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects setup companion bytes that do not match the assembled bundle binding", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateBundle: (bundle) => {
            bundle.artifacts[0].setupSha256 = "0".repeat(64);
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("windows-x64.setupSha256 must match the setup companion");
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    it("rejects a setup companion size that does not match the assembled bundle binding", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: {
          mutateBundle: (bundle) => {
            bundle.artifacts[0].setupSizeBytes += 1;
          },
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("windows-x64.setupSizeBytes must match the setup companion");
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
    });

    it("rejects a wrong remote GitHub asset name before npm publication", () => {
      const viewBody =
        'if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }';
      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true, wrongRemoteAssetName: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("exactly the three first-class ZIP assets");
      expect(lastRun.calls.some((line) => line.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((line) => line.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("rejects symlinked portable evidence before upload or npm publish", () => {
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableFixtureOptions: { symlinkEvidenceOutsideRoot: true },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("must not be a symbolic link");
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("skips publishing when `npm view … version` already reports the target version, yet still verifies the dist-tag", () => {
      // Version is already present and the dist-tag already points at it. A correct
      // orchestrator must NOT publish again; the stub publish path fails hard if it does.
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`SKIP ${RELEASE_SPEC} already exists`);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);

      // Proof the skip actually held: `npm publish` was never invoked.
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);

      // Verification still runs: the dist-tag is re-read even on the skip path.
      expect(lastRun.calls.some(isDistTagView)).toBe(true);
    });

    it("retries post-publish registry visibility before failing the release", () => {
      // Real npm can accept the publish and dist-tag update before every registry view
      // endpoint sees the new version. The release must wait for propagation instead of
      // turning a successful publish into a red workflow.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
        "    const attempts = s.versionVerifyAttempts ?? 0;",
        "    if (attempts === 0) {",
        "      setState({ versionVerifyAttempts: attempts + 1 });",
        "      process.stderr.write('npm error code E404\\n');",
        "      process.exit(1);",
        "    }",
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
      ].join("\n");

      lastRun = runPublish({ npmBody: npmStub(viewBody), initState: { published: false } });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain(`VERIFY pending ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      expect(lastRun.calls.filter(isVersionView).length).toBeGreaterThanOrEqual(3);
    });

    it("fails the release when the dist-tag never resolves to the published version", () => {
      // Version publishes fine, but `npm view <name> dist-tags.latest` keeps pointing at a
      // different version — verifyPackage() must reject this and exit non-zero.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) {',
        '    if (!s.published) { process.stderr.write("npm error code E404\\n"); process.exit(1); }',
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        // Deliberately wrong dist-tag forever, even after `dist-tag add`.
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write("9.9.9-wrong\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({ npmBody: npmStub(viewBody), initState: { published: false } });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(`${RELEASE_NAME}@latest points to 9.9.9-wrong`);
      expect(lastRun.stderr).toContain(`expected ${RELEASE_VERSION}`);
      // It must not have reported success.
      expect(lastRun.stdout).not.toContain("PASS -");
    });

    it("treats a lone OIDC request URL as no auth path", () => {
      // The identity exchange needs BOTH GitHub-issued values; a URL without its bearer cannot
      // mint a token, and counting it as auth would fail twenty minutes later at npm publish.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false },
        portableAssets: false,
        qualificationEnv: {
          NODE_AUTH_TOKEN: undefined,
          NPM_TOKEN: "",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token-request",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("no npm auth path is available");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("refuses before any gate work when neither a token nor an OIDC endpoint exists", () => {
      // The 0.3.1 operator runs discovered missing auth only after the twenty-minute gate chain;
      // the preflight answers the question first.
      lastRun = runPublish({
        npmBody: npmStub(passthroughViewBody(), { failOnPublish: true }),
        initState: { published: false },
        portableAssets: false,
        qualificationEnv: {
          NODE_AUTH_TOKEN: undefined,
          NPM_TOKEN: "",
          ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
        },
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain("no npm auth path is available");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["run","prepack"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    });

    it("publishes with no npm registry token configured, matching OIDC trusted publishing in CI", () => {
      // Unlike the shared npmStub() factory, model `publish` as ALSO fixing the dist-tag —
      // that is what real `npm publish --tag <tag>` does atomically on first publish. This
      // proves the actual CI shape: a fresh publish with zero registry credentials never
      // needs a separate `npm dist-tag add`, because trusted publishing authenticates
      // `npm publish` via OIDC and the tag is already correct once that call returns.
      const npmBody = [
        'log("npm");',
        "const sub = argv[0];",
        'if (sub === "config" && argv[1] === "get" && argv[2] === "strict-ssl") { process.stdout.write("true\\n"); process.exit(0); }',
        'if (sub === "run") { process.exit(0); }',
        ...npmPackStubLines(),
        'if (sub === "view") {',
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        '    process.stdout.write((s.tagged ? VERSION : "0.0.0-stale") + "\\n");',
        "    process.exit(0);",
        "  }",
        "}",
        'if (sub === "publish") { setState({ published: true, tagged: true }); process.exit(0); }',
        'process.stderr.write("stub npm: unhandled " + JSON.stringify(argv) + "\\n");',
        "process.exit(3);",
      ].join("\n");

      lastRun = runPublish({
        npmBody,
        initState: { published: false },
        qualificationEnv: NO_REGISTRY_TOKEN_ENV,
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      const publishLine = lastRun.calls.find((l) => l.startsWith('npm ["publish"'));
      expect(publishLine).toBeDefined();
      // Where the OIDC endpoint exists, the publish attests provenance — and only there.
      expect(publishLine).toContain('"--provenance"');
      // The whole point of this scenario: no dist-tag WRITE was needed or attempted.
      expect(lastRun.calls.some((l) => l.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("retries a transiently stale dist-tag read before failing when no token is configured, so registry propagation lag does not fail an otherwise-successful publish", () => {
      // Same CDN/read-replica propagation lag verifyPackage() already retries for below,
      // but exercised on ensurePackageDistTag()'s tokenless path: `npm view dist-tags.<tag>`
      // reports stale for the first two reads after a fresh, fully successful publish, then
      // resolves. This must NOT fail() — a transient lag is not a real dist-tag problem and
      // must not tell the operator to supply a token for nothing.
      const npmBody = [
        'log("npm");',
        "const sub = argv[0];",
        'if (sub === "config" && argv[1] === "get" && argv[2] === "strict-ssl") { process.stdout.write("true\\n"); process.exit(0); }',
        'if (sub === "run") { process.exit(0); }',
        ...npmPackStubLines(),
        'if (sub === "view") {',
        "  const s = state();",
        '  if (argv.includes("version")) {',
        "    if (!s.published) { process.stderr.write('npm error code E404\\n'); process.exit(1); }",
        '    process.stdout.write(VERSION + "\\n");',
        "    process.exit(0);",
        "  }",
        '  if (argv.some((a) => a.startsWith("dist-tags."))) {',
        "    const attempts = s.distTagViewAttempts ?? 0;",
        "    setState({ distTagViewAttempts: attempts + 1 });",
        '    process.stdout.write((attempts >= 2 ? VERSION : "0.0.0-stale") + "\\n");',
        "    process.exit(0);",
        "  }",
        "}",
        'if (sub === "publish") { setState({ published: true }); process.exit(0); }',
        'process.stderr.write("stub npm: unhandled " + JSON.stringify(argv) + "\\n");',
        "process.exit(3);",
      ].join("\n");

      lastRun = runPublish({
        npmBody,
        initState: { published: false },
        qualificationEnv: NO_REGISTRY_TOKEN_ENV,
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      expect(lastRun.stdout).toContain("TAG pending");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["dist-tag","add"'))).toBe(false);
    });

    it("fails with an actionable error, and never attempts an unauthenticated write, when a dist-tag repair needs a token that is not configured", () => {
      // Already published (idempotent re-run) with a stale dist-tag, and no token: this is
      // exactly the path npm Trusted Publishing does not cover (it authorizes `npm publish`
      // only). The orchestrator must fail before attempting `npm dist-tag add`, not after a
      // bare npm 401.
      const viewBody = [
        "  const s = state();",
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write("0.0.0-stale\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: false },
        qualificationEnv: NO_REGISTRY_TOKEN_ENV,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(`${RELEASE_NAME}@latest points to 0.0.0-stale`);
      expect(lastRun.stderr).toContain("Trusted Publishing does not cover");
      expect(lastRun.stderr).toContain("NODE_AUTH_TOKEN");
      expect(lastRun.calls.some((l) => l.startsWith('npm ["dist-tag","add"'))).toBe(false);
      expect(lastRun.stdout).not.toContain("PASS -");
    });
  },
);

// parseArgs' argv loop mixes three token widths in one pass: a bare boolean flag
// (--dry-run, 1 token), an inline `--flag=value` assignment (1 token), and a
// space-separated value flag (--tag <value>, 2 tokens). Runs standalone (not inside the
// stubbed-orchestrator describe above) so it exercises real argv parsing regardless of
// whether the root version is a prerelease, and fails fast in validateDistTag before any
// npm/gh/git process is spawned.
describe("release-publish argv parsing", () => {
  it("advances the index correctly across a boolean flag, an inline-assignment flag, and a value flag", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-publish.mjs",
        "--dry-run",
        "--registry=https://registry.example.invalid/",
        "--tag",
        "not-a-real-tag",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", env: process.env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported npm dist-tag not-a-real-tag");
  });
});
