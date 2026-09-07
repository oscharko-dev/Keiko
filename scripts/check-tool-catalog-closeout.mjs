// #3415's final artifact joins existing receipt/artifact pairs and the independently validated
// H1 handoff. It is generated outside the source tree after qualification: committing a manifest
// that claims its own future commit would make exact-head evidence impossible.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readReceipts } from "./check-coding-issue-journey-evidence.mjs";
import {
  checkH1HandoffEvidence,
  checkH1ProducerCheckpoint,
  checkToolCatalogMigrationCloseout,
  H1_PRODUCER_CHECKPOINT_PATH,
} from "./check-tool-catalog-conformance.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import { sha256File } from "./lib/digest.mjs";
import { resolveGithubRepository } from "./lib/github-repository.mjs";
import { REQUIRED_INTERFACE_FIELDS } from "./lib/governed-tool-contract-shape.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import {
  TOOL_CATALOG_QUALIFICATION_COMPONENTS,
  TOOL_CATALOG_QUALIFICATION_PACKAGES,
  validToolCatalogQualificationOutcome,
} from "./lib/tool-catalog-qualification-observation.mjs";

export const CATALOG_CLOSEOUT_CONSUMERS = Object.freeze([
  "native-harness-gateway",
  "cli-server-sdk",
  "managed-opencode",
  "read-only-child",
  "editor",
]);
export const CATALOG_CLOSEOUT_CONSUMER_PROOF_COUNTS = Object.freeze({
  "native-harness-gateway": 1,
  "cli-server-sdk": 3,
  "managed-opencode": 1,
  "read-only-child": 1,
  editor: 1,
});
export const CATALOG_CLOSEOUT_CHECKS = Object.freeze([
  ...CATALOG_CLOSEOUT_CONSUMERS,
  "catalog-conformance",
  "catalog-performance",
  "support-timelines",
  "package-surface",
  "clean-checkout",
  "generated-manifests",
  "release-metadata",
  "types",
  "lint",
  "format",
  "tests",
  "architecture",
  "coverage",
  "sonar",
  "required-ci",
]);
const H1_EVIDENCE_REFS = new Set(["h1-producer-checkpoint.v1", "h1-provenance.v1"]);
const DIGEST = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,254}$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);

function requireEvidence(condition, message) {
  if (!condition) throw new TypeError(`Catalog closeout: ${message}`);
}
function exactFields(value, fields) {
  requireEvidence(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      isDeepStrictEqual(Object.keys(value).sort(compareStrings), [...fields].sort(compareStrings)),
    "unexpected evidence fields",
  );
}
function validateBinding(binding) {
  exactFields(binding, ["catalogRevision", "profile", "projectionDigest", "handlerSetDigest"]);
  exactFields(binding.profile, ["id", "version"]);
  requireEvidence(
    /^[a-z][a-z0-9-]{0,63}$/u.test(binding.profile.id) &&
      Number.isSafeInteger(binding.profile.version) &&
      binding.profile.version > 0,
    "invalid profile identity",
  );
  for (const key of ["catalogRevision", "projectionDigest", "handlerSetDigest"])
    requireEvidence(DIGEST.test(binding[key]), "invalid binding digest");
}
function validateContext(context) {
  requireEvidence(COMMIT.test(context.currentHead), "invalid current head");
  requireEvidence(DIGEST.test(context.artifactDigest), "invalid artifact digest");
  requireEvidence(DIGEST.test(context.h1EvidenceDigest), "invalid H1 evidence digest");
  requireEvidence(H1_EVIDENCE_REFS.has(context.h1EvidenceRef), "invalid H1 evidence reference");
  requireEvidence(PLATFORMS.has(context.platform), "unsupported qualification platform");
  requireEvidence(
    GITHUB_REPOSITORY.test(context.requiredCiRepository),
    "invalid expected required-CI repository",
  );
  requireEvidence(
    Number.isSafeInteger(context.requiredCiPullRequestNumber) &&
      context.requiredCiPullRequestNumber > 0,
    "invalid expected required-CI pull request number",
  );
  requireEvidence(
    GITHUB_REPOSITORY.test(context.requiredCiHeadRepository),
    "invalid expected required-CI head repository",
  );
  requireEvidence(GIT_REF.test(context.requiredCiHeadRef), "invalid expected required-CI head ref");
  requireEvidence(COMMIT.test(context.requiredCiBaseSha), "invalid expected required-CI base sha");
  validateRuntime(context.runtime);
}
function validateRuntime(runtime) {
  exactFields(runtime, ["node", "product"]);
  requireEvidence(
    Object.values(runtime).every((value) => VERSION.test(value)),
    "invalid runtime",
  );
}
function validateReport(id, report, context) {
  exactFields(report, [
    "schemaVersion",
    "currentHead",
    "artifactDigest",
    "platform",
    "runtime",
    "executionKind",
    "status",
    "passed",
    "failed",
    "skipped",
    "binding",
    "components",
    "packages",
  ]);
  requireEvidence(report.schemaVersion === 1 && report.status === "passed", `${id} did not pass`);
  requireEvidence(report.currentHead === context.currentHead, `${id} has stale currentHead`);
  requireEvidence(
    Number.isSafeInteger(report.passed) &&
      report.passed >= 0 &&
      report.failed === 0 &&
      report.skipped === 0,
    `${id} has incomplete qualification`,
  );
  const consumer = CATALOG_CLOSEOUT_CONSUMERS.includes(id);
  let kind = "qualification-gate";
  if (consumer) kind = "production-composition";
  if (id === "managed-opencode") kind = "real-runtime";
  requireEvidence(report.executionKind === kind, `${id} is not production qualification evidence`);
  if (consumer) {
    for (const field of ["artifactDigest", "platform", "runtime"])
      requireEvidence(isDeepStrictEqual(report[field], context[field]), `${id} has stale ${field}`);
    requireEvidence(
      report.passed === CATALOG_CLOSEOUT_CONSUMER_PROOF_COUNTS[id],
      `${id} has incomplete executed proof`,
    );
    validateBinding(report.binding);
    validateConsumerComponents(id, report.components);
    validateConsumerPackages(id, report.packages);
  } else validateGateReport(id, report, context);
}
function validateConsumerComponents(consumer, components) {
  requireEvidence(Array.isArray(components), `${consumer} has no component proof`);
  const expected = TOOL_CATALOG_QUALIFICATION_COMPONENTS[consumer];
  requireEvidence(expected !== undefined, `${consumer} has no component inventory`);
  requireEvidence(
    isDeepStrictEqual(
      components.map((entry) => entry.component).sort(compareStrings),
      [...expected].sort(compareStrings),
    ),
    `${consumer} has incomplete component proof`,
  );
  for (const entry of components) {
    const fields = ["component", "terminalStatus", "settlementCount", "proof"];
    if (consumer === "managed-opencode") fields.push("runBinding");
    exactFields(entry, fields);
    requireEvidence(
      validToolCatalogQualificationOutcome(
        entry.component,
        entry.terminalStatus,
        entry.settlementCount,
        entry.proof,
      ),
      `${consumer} has invalid component proof`,
    );
    if (consumer === "managed-opencode") validateManagedRunBinding(entry.runBinding);
  }
}
function validateManagedRunBinding(binding) {
  exactFields(binding, ["correlationId", "activityLogSha256"]);
  requireEvidence(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(binding.correlationId) &&
      DIGEST.test(binding.activityLogSha256),
    "managed consumer has invalid run binding",
  );
}
function sameRepository(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}
// A byte-hashed required-ci.artifact can otherwise name any well-formed repository/PR/head/base
// that happens to share this checkout's exact head SHA. Tying repository, pullRequestNumber,
// headRepository, headRef and baseSha to the closeout's own expected identity (never re-derived
// from the artifact itself) closes that gap; headSha is already tied to context.currentHead and
// baseRef to the literal "dev" below.
function validateRequiredCiBinding(binding, context) {
  exactFields(binding, [
    "kind",
    "repository",
    "repositoryId",
    "pullRequestNumber",
    "headRepository",
    "headRef",
    "headSha",
    "baseRef",
    "baseSha",
    "requirementsDigest",
  ]);
  const valid = [
    binding.kind === "required-ci",
    GITHUB_REPOSITORY.test(binding.repository),
    sameRepository(binding.repository, context.requiredCiRepository),
    Number.isSafeInteger(binding.repositoryId),
    binding.repositoryId > 0,
    Number.isSafeInteger(binding.pullRequestNumber),
    binding.pullRequestNumber > 0,
    binding.pullRequestNumber === context.requiredCiPullRequestNumber,
    GITHUB_REPOSITORY.test(binding.headRepository),
    sameRepository(binding.headRepository, context.requiredCiHeadRepository),
    GIT_REF.test(binding.headRef),
    binding.headRef === context.requiredCiHeadRef,
    binding.headSha === context.currentHead,
    binding.baseRef === "dev",
    COMMIT.test(binding.baseSha),
    binding.baseSha === context.requiredCiBaseSha,
    DIGEST.test(binding.requirementsDigest),
  ];
  requireEvidence(valid.every(Boolean), "required-ci has invalid exact identity binding");
}
function validateConsumerPackages(consumer, packages) {
  requireEvidence(Array.isArray(packages), `${consumer} has no packaged proof`);
  const expected = TOOL_CATALOG_QUALIFICATION_PACKAGES[consumer];
  requireEvidence(expected !== undefined, `${consumer} has no packaged inventory`);
  requireEvidence(
    isDeepStrictEqual(
      packages.map((entry) => entry.name),
      expected,
    ),
    `${consumer} has incomplete packaged proof`,
  );
  for (const entry of packages) {
    exactFields(entry, ["name", "archiveDigest", "fileCount", "filesDigest"]);
    requireEvidence(
      DIGEST.test(entry.archiveDigest) &&
        DIGEST.test(entry.filesDigest) &&
        Number.isSafeInteger(entry.fileCount) &&
        entry.fileCount > 0,
      `${consumer} has invalid packaged proof`,
    );
  }
}
function validateGateReport(id, report, context) {
  if (id === "required-ci") validateRequiredCiBinding(report.binding, context);
  else requireEvidence(report.binding === null, `${id} has unexpected binding metadata`);
  requireEvidence(report.components === null, `${id} has unexpected component proof`);
  requireEvidence(report.packages === null, `${id} has unexpected packaged proof`);
  // Hosted Linux checks qualify source. Preserve their actual runtime and platform; never relabel
  // them as a locally tested package or manufacture a package digest they did not inspect.
  requireEvidence(
    report.artifactDigest === null || report.artifactDigest === context.artifactDigest,
    `${id} has stale artifactDigest`,
  );
  requireEvidence(PLATFORMS.has(report.platform), `${id} has unsupported platform`);
  validateRuntime(report.runtime);
  requireEvidence(report.runtime.product === context.runtime.product, `${id} has stale runtime`);
}
function verifiedReports(context, receipts, reports) {
  return CATALOG_CLOSEOUT_CHECKS.map((id) => {
    const receipt = receipts.get(id);
    requireEvidence(receipt !== undefined, `${id} has no receipt`);
    requireEvidence(receipt.testStatus === "passed", `${id} receipt did not pass`);
    requireEvidence(receipt.commitSha === context.currentHead, `${id} receipt has stale head`);
    requireEvidence(DIGEST.test(receipt.digest), `${id} receipt has invalid digest`);
    const report = reports.get(id);
    validateReport(id, report, context);
    requireEvidence(receipt.platform === report.platform, `${id} receipt has wrong platform`);
    const check = {
      id,
      receiptDigest: receipt.digest,
      status: "passed",
      platform: report.platform,
      runtime: report.runtime,
      artifactDigest: report.artifactDigest,
    };
    return id === "required-ci" ? { ...check, binding: report.binding } : check;
  });
}

/** Inputs come from existing receipt files and actual qualified artifacts, never a copied catalog. */
export function buildToolCatalogCloseout(context, receipts, reports) {
  validateContext(context);
  const checks = verifiedReports(context, receipts, reports);
  const bindings = CATALOG_CLOSEOUT_CONSUMERS.map((consumer) => ({
    consumer,
    ...reports.get(consumer).binding,
  }));
  const managed = reports.get("managed-opencode").binding;
  requireEvidence(
    isDeepStrictEqual(managed, context.h1Binding),
    "H1 and managed consumer identities differ",
  );
  return {
    schemaVersion: 1,
    currentHead: context.currentHead,
    artifactDigest: context.artifactDigest,
    catalogRevision: managed.catalogRevision,
    profiles: bindings.map(({ consumer, catalogRevision, profile }) => ({
      consumer,
      catalogRevision,
      profile,
    })),
    projectionDigests: Object.fromEntries(
      bindings.map((binding) => [binding.consumer, binding.projectionDigest]),
    ),
    handlerSetDigests: Object.fromEntries(
      bindings.map((binding) => [binding.consumer, binding.handlerSetDigest]),
    ),
    h1EvidenceRef: context.h1EvidenceRef,
    h1EvidenceDigest: context.h1EvidenceDigest,
    migrationCount: 0,
    checks,
    platform: context.platform,
    runtime: context.runtime,
  };
}
export function validateToolCatalogCloseout(manifest, context, receipts, reports) {
  exactFields(manifest, REQUIRED_INTERFACE_FIELDS.CatalogCloseout.split(","));
  const expected = buildToolCatalogCloseout(context, receipts, reports);
  requireEvidence(
    isDeepStrictEqual(manifest, expected),
    "manifest differs from current qualified evidence",
  );
  return expected;
}

export function catalogCloseoutHead(root) {
  const git = resolveHostExecutable("git");
  const status = execFileSync(git, ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  requireEvidence(status.length === 0, "source checkout is not clean");
  return execFileSync(git, ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
async function qualifiedH1(root, h1Path) {
  const evidenceRef = basename(h1Path, ".json");
  requireEvidence(H1_EVIDENCE_REFS.has(evidenceRef), "invalid H1 evidence reference");
  const h1 = readJson(h1Path);
  // Consolidated delivery qualifies #3415 before #3390 and before the final #3394 merge.
  // Both phases retain the independently reviewed producer and real source-content checks.
  const failures = [
    ...(await checkH1ProducerCheckpoint(root)),
    ...(await checkH1ProducerCheckpoint(root, { checkpointPath: relative(root, h1Path) })),
    ...(await checkToolCatalogMigrationCloseout(root)),
  ];
  // A provenance claim additionally requires actual dev-reachable integration. Choosing the
  // checkpoint phase never labels its evidence as landed provenance or authorizes a merge.
  if (evidenceRef === "h1-provenance.v1") {
    failures.push(
      ...(await checkH1HandoffEvidence(
        root,
        { landedDevCommit: h1.currentHead, landedTreeDigest: h1.treeDigest },
        { provenancePath: relative(root, h1Path) },
      )),
    );
  }
  requireEvidence(failures.length === 0, "H1 handoff or migration qualification failed");
  return { h1, evidenceRef };
}

function expectedRequiredCiRepository(root) {
  const repository = resolveGithubRepository({
    env: process.env,
    runGit: (args) =>
      spawnSync(resolveHostExecutable("git"), args, { cwd: root, encoding: "utf8" }),
  });
  requireEvidence(repository !== undefined, "could not determine the expected GitHub repository");
  return repository;
}
// The caller's own known identity for the pull request being closed out — never re-derived from
// the required-ci artifact under validation. See validateRequiredCiBinding for the cross-check.
function requiredCiExpectations(root, { pullRequestNumber, headRepository, headRef, baseSha }) {
  return {
    requiredCiRepository: expectedRequiredCiRepository(root),
    requiredCiPullRequestNumber: positiveInteger(pullRequestNumber),
    requiredCiHeadRepository: headRepository,
    requiredCiHeadRef: headRef,
    requiredCiBaseSha: baseSha,
  };
}

export async function checkToolCatalogCloseoutFiles({
  root = process.cwd(),
  artifactPath,
  receiptsDir,
  manifestPath,
  pullRequestNumber,
  headRepository,
  headRef,
  baseSha,
  h1Path = join(root, H1_PRODUCER_CHECKPOINT_PATH),
  write = false,
}) {
  const head = catalogCloseoutHead(root);
  if (write) requireExternalManifest(root, manifestPath);
  const h1Digest = sha256File(h1Path);
  const { h1, evidenceRef } = await qualifiedH1(root, h1Path);
  const { receipts, reports } = readCatalogCloseoutReceipts(receiptsDir);
  const context = {
    currentHead: head,
    artifactDigest: sha256File(artifactPath),
    h1EvidenceRef: evidenceRef,
    h1EvidenceDigest: h1Digest,
    h1Binding: Object.fromEntries(
      ["catalogRevision", "profile", "projectionDigest", "handlerSetDigest"].map((key) => [
        key,
        h1[key],
      ]),
    ),
    ...requiredCiExpectations(root, { pullRequestNumber, headRepository, headRef, baseSha }),
    platform: `${process.platform}-${process.arch}`,
    runtime: { node: process.versions.node, product: readJson(join(root, "package.json")).version },
  };
  const manifest = buildToolCatalogCloseout(context, receipts, reports);
  requireEvidence(catalogCloseoutHead(root) === head, "source changed during qualification");
  requireEvidence(
    sha256File(artifactPath) === context.artifactDigest,
    "artifact changed during qualification",
  );
  const latest = readCatalogCloseoutReceipts(receiptsDir);
  requireEvidence(
    isDeepStrictEqual({ receipts, reports }, latest),
    "receipts changed during qualification",
  );
  requireEvidence(sha256File(h1Path) === h1Digest, "H1 receipt changed during qualification");
  if (write) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return validateToolCatalogCloseout(readJson(manifestPath), context, receipts, reports);
}
export function readCatalogCloseoutReceipts(receiptsDir) {
  const reports = new Map();
  const receipts = readReceipts(receiptsDir, {
    observeArtifact: (id, bytes) => {
      if (!CATALOG_CLOSEOUT_CHECKS.includes(id)) return;
      requireEvidence(bytes.length <= 65_536, "report exceeds its evidence bound");
      reports.set(id, JSON.parse(bytes.toString("utf8")));
    },
  });
  return { receipts, reports };
}
export function requireExternalManifest(root, manifestPath) {
  const output = existsSync(manifestPath)
    ? realpathSync(manifestPath)
    : join(realpathSync(dirname(manifestPath)), basename(manifestPath));
  const path = relative(realpathSync(root), output);
  requireEvidence(
    isAbsolute(path) || path.startsWith(`..${sep}`),
    "manifest output must be outside the source checkout",
  );
}
function requiredPath(argv, flag) {
  const index = argv.indexOf(flag);
  requireEvidence(index >= 0 && typeof argv[index + 1] === "string", `missing ${flag}`);
  return resolve(argv[index + 1]);
}
function requiredArgument(argv, flag) {
  const index = argv.indexOf(flag);
  requireEvidence(index >= 0 && typeof argv[index + 1] === "string", `missing ${flag}`);
  return argv[index + 1];
}
function positiveInteger(value) {
  const parsed = Number(value);
  requireEvidence(Number.isSafeInteger(parsed) && parsed > 0, "invalid pull request number");
  return parsed;
}
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  await checkToolCatalogCloseoutFiles({
    artifactPath: requiredPath(argv, "--artifact"),
    receiptsDir: requiredPath(argv, "--receipts"),
    manifestPath: requiredPath(argv, "--manifest"),
    h1Path: requiredPath(argv, "--h1"),
    pullRequestNumber: requiredArgument(argv, "--pull-request"),
    headRepository: requiredArgument(argv, "--head-repository"),
    headRef: requiredArgument(argv, "--head-ref"),
    baseSha: requiredArgument(argv, "--base-sha"),
    write: argv.includes("--write"),
  });
  console.log("Tool catalog closeout: PASS");
}
