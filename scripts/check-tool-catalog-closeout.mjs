// #3415's final artifact joins existing receipt/artifact pairs and the independently validated
// H1 handoff. It is generated outside the source tree after qualification: committing a manifest
// that claims its own future commit would make exact-head evidence impossible.
import { execFileSync } from "node:child_process";
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
import { REQUIRED_INTERFACE_FIELDS } from "./lib/governed-tool-contract-shape.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

export const CATALOG_CLOSEOUT_CONSUMERS = Object.freeze([
  "native-harness-gateway",
  "cli-server-sdk",
  "managed-opencode",
  "read-only-child",
  "editor",
]);
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
    requireEvidence(report.passed > 0, `${id} has no executed proof`);
    validateBinding(report.binding);
  } else validateGateReport(id, report, context);
}
function validateGateReport(id, report, context) {
  requireEvidence(report.binding === null, `${id} has unexpected binding metadata`);
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
    return {
      id,
      receiptDigest: receipt.digest,
      status: "passed",
      platform: report.platform,
      runtime: report.runtime,
      artifactDigest: report.artifactDigest,
    };
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

export async function checkToolCatalogCloseoutFiles({
  root = process.cwd(),
  artifactPath,
  receiptsDir,
  manifestPath,
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
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  await checkToolCatalogCloseoutFiles({
    artifactPath: requiredPath(argv, "--artifact"),
    receiptsDir: requiredPath(argv, "--receipts"),
    manifestPath: requiredPath(argv, "--manifest"),
    h1Path: requiredPath(argv, "--h1"),
    write: argv.includes("--write"),
  });
  console.log("Tool catalog closeout: PASS");
}
