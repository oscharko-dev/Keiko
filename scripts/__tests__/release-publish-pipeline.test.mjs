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

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  hashDirectoryTree,
  portableVerificationSummaryForManifest,
  PORTABLE_TARGETS,
} from "../portable-runtime.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The orchestrator reads the release version from the live root manifest at runtime,
// so the stubs must answer with that same version rather than a hardcoded one. This
// keeps the gate correct across version bumps.
const ROOT_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const RELEASE_IMPACT_CATALOG = JSON.parse(
  readFileSync(join(REPO_ROOT, "release-impact.catalog.json"), "utf8"),
);
const RELEASE_VERSION = ROOT_MANIFEST.version;
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
  const provenanceText = `${JSON.stringify({
    artifact: target.assetName,
    buildWorkflowAttempt: 1,
    buildWorkflowRunId: 123456789,
    packageVersion: RELEASE_VERSION,
    sourceCommitSha: HEAD_SHA,
    subjectDigest: archiveSha256,
    target: target.platformTarget,
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
) {
  const releaseTag = `v${RELEASE_VERSION}`;
  const security = portableSecurity(target, notarizationRequired, verificationChecks);
  return {
    schemaVersion: 1,
    product: portableProduct(),
    release: { releaseId: 0, releaseTag, stable: true, commitSha: HEAD_SHA },
    artifact: portableArtifact(target, assetId, archiveSize, archiveSha256),
    provenance: portableProvenance(provenanceSha256),
    runtime: portableRuntime(target),
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
    ),
    updateEligibility: portableUpdateEligibility(),
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
// so a stub can flip "published"/"tagged" as the orchestrator drives it.
function stubPrologue(logFile, stateFile) {
  return [
    'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
    `const LOG = ${JSON.stringify(logFile)};`,
    `const STATE = ${JSON.stringify(stateFile)};`,
    `const VERSION = ${JSON.stringify(RELEASE_VERSION)};`,
    "const argv = process.argv.slice(2);",
    "function log(bin) { appendFileSync(LOG, bin + ' ' + JSON.stringify(argv) + '\\n'); }",
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
    'if (sub === "api") {',
    '  if (argv[1] && argv[1].includes("/releases/tags/")) {',
    "    process.stdout.write(JSON.stringify({ id: 987654321, assets: state().uploadedAssets || [] }));",
    "    process.exit(0);",
    "  }",
    '  process.stdout.write(JSON.stringify({ state: "APPROVED", user: { login: "release-owner" } }));',
    "  process.exit(0);",
    "}",
    'if (sub === "release" && argv[1] === "view") { process.exit(1); }',
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
    "      if (!archive || manifest.release.releaseId !== 987654321 || manifest.artifact.assetId !== archive.id || manifest.releaseImpact.reviewedBinding.assetId !== archive.id || manifest.releaseImpact.reviewedBinding.releaseId !== 987654321) {",
    "        process.stderr.write('portable manifest was not rebound to the remote GitHub ids\\n');",
    "        process.exit(44);",
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

function curlStubBody() {
  return [
    'log("curl");',
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
    if (options.sidecarEvidenceKind !== undefined && index === 0) {
      addPortableSidecarFixture(targetRoot, manifest, target, options.sidecarEvidenceKind);
    }
    writePortableEvidence(targetRoot, manifest, provenanceText);
    options.mutateManifest?.(manifest, target, index, targetRoot);
    options.mutateEvidence?.(targetRoot, manifest, target, index);
    if (options.symlinkEvidenceOutsideRoot === true && index === 0) {
      const sbomPath = join(targetRoot, "evidence", "sbom.cdx.json");
      rmSync(sbomPath, { force: true });
      symlinkSync(outsideEvidence, sbomPath);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { archivePath, manifestPath, platformTarget: target.platformTarget };
  });
  const manifestPath = join(root, "portable-assets.json");
  const bundle = { schemaVersion: 1, artifacts };
  options.mutateBundle?.(bundle);
  writeFileSync(manifestPath, JSON.stringify(bundle, null, 2) + "\n");
  return manifestPath;
}

function addPortableSidecarFixture(targetRoot, manifest, target, unsafeKind) {
  const name = "opencode-compatible";
  const payloadRootPath = `runtime/sidecars/${name}`;
  const resourceRoot = join(targetRoot, "payload", "Keiko");
  const sidecarRoot = join(resourceRoot, payloadRootPath);
  mkdirSync(join(sidecarRoot, "evidence"), { recursive: true });
  const executablePath = `${payloadRootPath}/opencode.cmd`;
  writeFileSync(join(resourceRoot, executablePath), "sidecar executable\n");
  const licensePath = join(sidecarRoot, "LICENSE.txt");
  const sbomPath = join(sidecarRoot, "evidence", "sbom.cdx.json");
  writeFileSync(
    licensePath,
    unsafeKind === "license" ? "token=forbidden-secret\n" : "Sidecar license.\n",
  );
  writeFileSync(
    sbomPath,
    unsafeKind === "sbom"
      ? '{"bomFormat":"CycloneDX","rawOutput":"secret"}\n'
      : '{"bomFormat":"CycloneDX"}\n',
  );
  const sidecar = {
    name,
    kind: "coding-runtime",
    upstream: { name: "OpenCode-compatible", version: "1.0.0" },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      protocolVersion: "coding-sidecar-v1",
    },
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
      sha256: digestFor(readFileSync(licensePath)),
    },
    sbomEvidence: {
      path: `${payloadRootPath}/evidence/sbom.cdx.json`,
      sha256: digestFor(readFileSync(sbomPath)),
    },
    signing: portableSecurity(target, false, targetVerificationChecks(target)),
  };
  manifest.sidecarRuntimes = [sidecar];
  manifest.releaseImpact.reviewedBinding.sidecarRuntimes = JSON.parse(JSON.stringify([sidecar]));
}

function writePortableEvidence(targetRoot, manifest, provenanceText) {
  writeFileSync(
    join(targetRoot, "evidence", "SHA256SUMS.txt"),
    `${manifest.artifact.sha256}  ${manifest.artifact.assetName}\n`,
  );
  writeFileSync(join(targetRoot, "evidence", "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
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

  const result = spawnSync(process.execPath, ["scripts/release-publish.mjs", "--tag", "latest"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });

  const calls = readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  rmSync(binDir, { recursive: true, force: true });
  rmSync(portableDir, { recursive: true, force: true });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// A stub `npm` that shares the config/gate scaffolding and lets each scenario plug in the
// `view` behaviour that is actually under test.
function npmStub(viewBody, { failOnPublish = false } = {}) {
  return [
    'log("npm");',
    "const sub = argv[0];",
    // strict-ssl probe from createNpmEnvironment().
    'if (sub === "config" && argv[1] === "get" && argv[2] === "strict-ssl") { process.stdout.write("true\\n"); process.exit(0); }',
    // All `npm run <gate>` invocations (version-consistency, publish-manifests,
    // release-impact, prepack, smoke) succeed so control reaches the publish loop.
    'if (sub === "run") { process.exit(0); }',
    'if (sub === "view") {',
    viewBody,
    "}",
    'if (sub === "publish") {',
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

describe.skipIf(RELEASE_VERSION_IS_PRERELEASE)(
  "release-publish pipeline (real orchestrator, stubbed npm/gh/git)",
  () => {
    let lastRun;

    afterEach(() => {
      lastRun = undefined;
    });

    it("fails stable latest publishing before npm publish when portable assets are missing", () => {
      const viewBody = [
        '  if (argv.includes("version")) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
        '  if (argv.some((a) => a.startsWith("dist-tags."))) { process.stdout.write(VERSION + "\\n"); process.exit(0); }',
      ].join("\n");

      lastRun = runPublish({
        npmBody: npmStub(viewBody, { failOnPublish: true }),
        initState: { published: true, tagged: true },
        portableAssets: false,
      });

      expect(lastRun.status).toBe(1);
      expect(lastRun.stderr).toContain(
        "stable latest publishes require --portable-assets-manifest",
      );
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
      expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
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

      expect(lastRun.status).toBe(0);
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
      expect(publishLine).toContain('"--access","public"');
      expect(publishLine).toContain('"--tag","latest"');
      expect(publishLine).toContain('"--provenance"');
      expect(publishLine).toContain('"--ignore-scripts"');
      expect(publishLine).not.toContain('"--dry-run"');

      // The post-publish verification pass re-reads BOTH the version and the dist-tag.
      const versionViews = lastRun.calls.filter(isVersionView).length;
      const distTagViews = lastRun.calls.filter(isDistTagView).length;
      expect(versionViews).toBeGreaterThanOrEqual(2);
      expect(distTagViews).toBeGreaterThanOrEqual(2);

      const uploadLine = lastRun.calls.find(
        (l) => l.startsWith('gh ["release","upload"') && l.includes("keiko-windows-x64.zip"),
      );
      expect(uploadLine).toContain("keiko-windows-x64.zip");
      expect(uploadLine).toContain("keiko-macos-arm64.zip");
      expect(uploadLine).toContain("keiko-macos-x64.zip");
      expect(
        indexOfCall(lastRun.calls, (l) => l.startsWith('gh ["release","upload"')),
      ).toBeLessThan(publishCall);
      expect(lastRun.calls.filter((l) => l.startsWith("curl [")).length).toBeGreaterThanOrEqual(3);
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
        qualificationEnv: { NODE_AUTH_TOKEN: undefined, NPM_TOKEN: undefined },
      });

      expect(lastRun.status).toBe(0);
      expect(lastRun.stdout).toContain(`PUBLISH ${RELEASE_SPEC}`);
      expect(lastRun.stdout).toContain(`PASS - ${RELEASE_SPEC} published as latest`);
      expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(true);
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
        qualificationEnv: { NODE_AUTH_TOKEN: undefined, NPM_TOKEN: undefined },
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
        qualificationEnv: { NODE_AUTH_TOKEN: undefined, NPM_TOKEN: undefined },
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
