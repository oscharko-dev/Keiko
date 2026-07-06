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

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { PORTABLE_TARGETS } from "../portable-runtime.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The orchestrator reads the release version from the live root manifest at runtime,
// so the stubs must answer with that same version rather than a hardcoded one. This
// keeps the gate correct across version bumps.
const ROOT_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
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
  const provenanceText = `${target.platformTarget} provenance\n`;
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
    release: { releaseId: 123456789, releaseTag, stable: true, commitSha: HEAD_SHA },
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
    releaseId: 123456789,
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
    "    process.stdout.write(JSON.stringify(state().uploadedAssets || []));",
    "    process.exit(0);",
    "  }",
    '  process.stdout.write(JSON.stringify({ state: "APPROVED", user: { login: "release-owner" } }));',
    "  process.exit(0);",
    "}",
    'if (sub === "release" && argv[1] === "view") { process.exit(1); }',
    'if (sub === "release" && argv[1] === "upload") {',
    "  const tag = argv[2];",
    '  const repoIndex = argv.indexOf("--repo");',
    "  const repo = repoIndex >= 0 ? argv[repoIndex + 1] : 'oscharko-dev/Keiko';",
    "  const files = argv.slice(3).filter((entry, index, entries) => {",
    '    if (entry === "--repo" || entry === "--clobber") return false;',
    '    if (index > 0 && entries[index - 1] === "--repo") return false;',
    "    return !entry.startsWith('--');",
    "  });",
    "  const uploadedAssets = files.map((path, index) => {",
    "    const name = path.split(/[\\\\/]/u).at(-1);",
    "    return {",
    "      id: 100000 + index,",
    "      name,",
    "      size: readFileSync(path).byteLength,",
    "      browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`",
    "    };",
    "  });",
    "  setState({ uploadedAssets });",
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
  return ['log("curl");', "process.exit(0);"].join("\n");
}

function writePortableAssetsFixture(root) {
  const artifacts = PORTABLE_TARGETS.map((target, index) => {
    const targetRoot = join(root, target.platformTarget);
    const archivePath = join(targetRoot, target.assetName);
    const manifestPath = join(targetRoot, "manifest", "portable-manifest.json");
    mkdirSync(join(targetRoot, "evidence"), { recursive: true });
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(archivePath, `portable archive for ${target.platformTarget}\n`);
    const { manifest, provenanceText } = portableManifest(target, archivePath, 1000 + index);
    writePortableEvidence(targetRoot, manifest, provenanceText);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { archivePath, manifestPath, platformTarget: target.platformTarget };
  });
  const manifestPath = join(root, "portable-assets.json");
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, artifacts }, null, 2) + "\n");
  return manifestPath;
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
    JSON.stringify({ status: "verified-production" }) + "\n",
  );
  writeFileSync(join(targetRoot, "evidence", "provenance.intoto.jsonl"), provenanceText);
}

// Run the real scripts/release-publish.mjs with stub npm/gh/git prepended to PATH.
// `npmBody` is the stub-`npm` behaviour under test; `initState` seeds the publish state.
// Returns the exit status, stdout/stderr, and the ordered list of intercepted calls.
function runPublish({ npmBody, initState, portableAssets = true }) {
  const binDir = mkdtempSync(join(tmpdir(), "keiko-release-publish-stub-"));
  const portableDir = mkdtempSync(join(tmpdir(), "keiko-portable-assets-fixture-"));
  const logFile = join(binDir, "calls.log");
  const stateFile = join(binDir, "state.json");
  writeFileSync(logFile, "", "utf8");
  writeFileSync(stateFile, JSON.stringify(initState), "utf8");

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
    KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "release-owner",
    // Deterministic npmrc generation; the stub npm never uses this token.
    NPM_CONFIG_STRICT_SSL: "true",
    NODE_AUTH_TOKEN: "stub-token-never-sent",
  };
  // GH_TOKEN would be forwarded to the stub gh; drop it so nothing real is carried.
  Reflect.deleteProperty(env, "GH_TOKEN");
  if (portableAssets) {
    env.KEIKO_PORTABLE_ASSETS_MANIFEST = writePortableAssetsFixture(portableDir);
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

describe("release-publish pipeline (real orchestrator, stubbed npm/gh/git)", () => {
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
    expect(lastRun.stderr).toContain("stable latest publishes require --portable-assets-manifest");
    expect(lastRun.calls.some((l) => l.startsWith('npm ["publish"'))).toBe(false);
    expect(lastRun.calls.some((l) => l.startsWith('gh ["release","upload"'))).toBe(false);
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

    const uploadLine = lastRun.calls.find((l) => l.startsWith('gh ["release","upload"'));
    expect(uploadLine).toContain("keiko-windows-x64.zip");
    expect(uploadLine).toContain("keiko-macos-arm64.zip");
    expect(uploadLine).toContain("keiko-macos-x64.zip");
    expect(lastRun.calls.filter((l) => l.startsWith("curl [")).length).toBeGreaterThanOrEqual(3);
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
});
