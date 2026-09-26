#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { format } from "prettier";
import { isMainModule } from "./lib/is-main-module.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import {
  checkToolCatalogInventory,
  scanToolRegistrySource,
  nonDispatchProbeDisposition,
} from "./lib/tool-catalog-inventory.mjs";
import { GOVERNED_TOOL_CONTRACT_PINS } from "./lib/governed-tool-contract-pins.mjs";
import { REQUIRED_INTERFACE_FIELDS } from "./lib/governed-tool-contract-shape.mjs";
import { collectH1OwnedSourcePaths } from "./lib/h1-source-closure.mjs";
import { readGitSourceContent } from "./lib/git-source-content.mjs";

export const TOOL_CATALOG_MANIFEST_PATH = "docs/architecture/tool-catalog-manifest.v1.json";
export const TOOL_CATALOG_MIGRATION_PATH = "docs/architecture/tool-catalog-migration.v1.json";
const RETIRED_BRIDGE_PROBES = Object.freeze([
  {
    id: "generic-gateway",
    path: "packages/keiko-contracts/src/gateway.ts",
    probes: ["readonly tools?: readonly ToolDefinition[]"],
  },
  {
    id: "generic-tool-port",
    path: "packages/keiko-contracts/src/governed-tool-bridge.ts",
    probes: ["LegacyNativeToolSession", "LegacyNamedToolInvocation", "ToolInvocationBridge"],
  },
  {
    id: "generic-tool-port",
    path: "packages/keiko-tool-catalog/src/invocation.ts",
    probes: ["legacySession", 'value.kind === "legacy-name"'],
  },
  {
    id: "generic-gateway",
    path: "packages/keiko-model-gateway/src/toolCatalogBridge.ts",
    probes: ["legacySession", 'object.kind === "legacy-native"'],
  },
  {
    id: "realtime-compatibility",
    path: "packages/keiko-model-gateway/src/realtime-voice-adapter.ts",
    probes: ["RealtimeSessionTool", "RealtimeSessionToolChoice"],
  },
]);

export function retiredBridgeMigrations(sources) {
  const ids = new Set();
  for (const entry of RETIRED_BRIDGE_PROBES) {
    const source = sources[entry.path] ?? "";
    if (entry.probes.some((probe) => source.includes(probe))) ids.add(entry.id);
  }
  return [...ids].sort(compareStrings);
}

export function activeToolCatalogMigrations(root = process.cwd()) {
  return retiredBridgeMigrations(
    Object.fromEntries(
      RETIRED_BRIDGE_PROBES.map((entry) => [
        entry.path,
        readFileSync(join(root, entry.path), "utf8"),
      ]),
    ),
  );
}

export async function toolCatalogMigrationBytes(root = process.cwd()) {
  const sourceContract = "docs/architecture/governed-tool-contract.v1.json";
  const bytes = readFileSync(join(root, sourceContract), "utf8");
  const contract = JSON.parse(bytes);
  const sourceContractDigest = sha256Hex(bytes);
  const migration = {
    schemaVersion: 1,
    ownerIssue: 3406,
    closeoutIssue: 3415,
    sourceContract,
    sourceContractDigest,
    // The 43-row source contract is the immutable architecture census. This generated array is
    // the active compatibility register and is derived from the actual retired bridge symbols.
    // It reaches zero only when the name-only GatewayRequest/normalizer and realtime tool surface
    // are absent; the repository-wide registry scan below independently rejects parallel tables.
    inventory: activeToolCatalogMigrations(root).map((id) => {
      const row = contract.inventory.find((entry) => entry.id === id);
      if (row === undefined) throw new TypeError(`Missing historical inventory row: ${id}`);
      return { id: row.id, ownerIssue: row.ownerIssue, disposition: row.disposition };
    }),
    historicalInventory: {
      rowCount: contract.inventory.length,
      digest: sha256Hex(canonicalise(contract.inventory)),
    },
    nonDispatchProbes: [nonDispatchProbeDisposition()],
  };
  return format(`${JSON.stringify(migration, null, 2)}\n`, {
    parser: "json",
    printWidth: 100,
    tabWidth: 2,
  });
}
export async function loadToolCatalogProducer(root) {
  return import(pathToFileURL(join(root, "packages/keiko-tool-catalog/dist/index.js")).href);
}
export async function generatedToolCatalogManifest(root = process.cwd()) {
  const producer = await loadToolCatalogProducer(root);
  const catalog = producer.createInitialToolCatalog();
  return producer.createCatalogManifest(
    catalog,
    producer.compileToolProjection(catalog, { id: "legacy-native", version: 1 }),
  );
}
export async function toolCatalogManifestBytes(root = process.cwd()) {
  return format(`${JSON.stringify(await generatedToolCatalogManifest(root), null, 2)}\n`, {
    parser: "json",
    printWidth: 100,
    tabWidth: 2,
  });
}
const sortedByName = (values) =>
  [...values].sort((left, right) => compareStrings(left.name, right.name));
/**
 * Pure comparator extracted so the "legacy table reintroduction" attack class can be exercised
 * directly (feed a deliberately mutated/reintroduced legacy table and prove drift is caught)
 * without duplicating this formula in a test-owned copy (AGENTS.md §7 fixture rule).
 */
export function legacyProjectionDiffers(definitions, legacyDefinitions) {
  return canonicalise(sortedByName(definitions)) !== canonicalise(sortedByName(legacyDefinitions));
}
export async function checkToolCatalogConformance(root = process.cwd()) {
  const errors = checkToolCatalogInventory(root);
  const producer = await loadToolCatalogProducer(root);
  const legacy = await import(
    pathToFileURL(join(root, "packages/keiko-tools/dist/schemas.js")).href
  );
  const catalog = producer.createInitialToolCatalog();
  const definitions = producer.gatewayToolDefinitions(catalog, { id: "legacy-native", version: 1 });
  if (legacyProjectionDiffers(definitions, legacy.TOOL_DEFINITIONS))
    errors.push("legacy tool projection differs from existing owner");
  if (
    readFileSync(join(root, TOOL_CATALOG_MANIFEST_PATH), "utf8") !==
    (await toolCatalogManifestBytes(root))
  )
    errors.push("generated tool catalog manifest drift");
  if (
    readFileSync(join(root, TOOL_CATALOG_MIGRATION_PATH), "utf8") !==
    (await toolCatalogMigrationBytes(root))
  )
    errors.push("generated tool catalog migration drift");
  return errors;
}
/**
 * #3415 closeout enforcement: the finite migration inventory must have shrunk to zero rows.
 * Deliberately NOT part of the default `checkToolCatalogConformance` result — the default PR
 * lane keeps accepting a non-empty, in-progress inventory until every owning issue has actually
 * landed its migration and #3415 itself closes out. Callers opt in with `--closeout` (main below)
 * or by calling this directly once every owning migration issue is done.
 */
export async function checkToolCatalogMigrationCloseout(
  root = process.cwd(),
  options = {},
  { producerCheckpointFailures = checkH1ProducerCheckpoint } = {},
) {
  const migration = JSON.parse(await toolCatalogMigrationBytes(root));
  const inventoryErrors =
    migration.inventory.length === 0
      ? []
      : [
          `migration inventory not empty at closeout: ${String(migration.inventory.length)} row(s) remain`,
        ];
  return [
    ...inventoryErrors,
    ...(await producerCheckpointFailures(root, options)),
    ...(await checkH1HandoffEvidence(root, GOVERNED_TOOL_CONTRACT_PINS.h1Provenance)),
  ];
}

// #3414 AC7 / #3415 AC5-AC6: the durable, independently-verifiable H1 dev-landing record. #3414
// alone writes it after H1 reaches `dev` (see governed-tool-migration.md). PR #3394's verified
// squash landing is now recorded; nothing is inferred from a branch label or issue status
// (AGENTS.md §7). The fail-closed recheck requires populated
// the stable landing pins to have a durable record that agrees, is reachable
// from `dev`, resolve `sourceHead` against real Git and rebind its declared `treeDigest` to the
// real owned-source content at both `sourceHead` and the consuming `currentHead` commit, and agree
// with the real current producer's own identity — anything missing, stale, unresolvable, or
// mismatched fails qualification rather than passing silently (review 3941891302: a caller could
// otherwise declare a nonexistent `sourceHead` and a fabricated `treeDigest` and pass unchecked).
export const H1_PROVENANCE_PATH = "docs/architecture/h1-provenance.v1.json";
export const H1_PRODUCER_CHECKPOINT_PATH = "docs/architecture/h1-producer-checkpoint.v1.json";
const H1_INTEGRATION_REPOSITORY = "oscharko-dev/Keiko";
const H1_INTEGRATION_PR = 3394;
const H1_OWNER_ISSUE = 3386;
const HEX_64 = /^[a-f0-9]{64}$/u;
const HEX_40 = /^[a-f0-9]{40}$/u;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isCatalogProfileRef(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.version)
  );
}

// The canonical annex seeds the actual first-party runtime dependency closure. Shared execution,
// path admission, regex safety and newly imported helpers are bound without hand-curated omissions.
// Migration ownership remains the separate immutable 43-row census.
export const H1_OWNED_SOURCE_PATHS = Object.freeze(collectH1OwnedSourcePaths());

// One row per H1Provenance field: `test` reads the whole record so a check can span more than one
// field (e.g. sourceHead/currentHead share a message) without growing this table's own branching.
const H1_PROVENANCE_FIELD_CHECKS = Object.freeze([
  {
    test: (r) => Number.isSafeInteger(r.integrationPr) && r.integrationPr > 0,
    message: "integrationPr is not a positive integer",
  },
  {
    test: (r) => HEX_40.test(r.sourceHead) && HEX_40.test(r.currentHead),
    message: "sourceHead/currentHead is not a 40-hex commit SHA",
  },
  {
    test: (r) => HEX_64.test(r.treeDigest) && HEX_64.test(r.projectionDigest),
    message: "treeDigest/projectionDigest is not a 64-hex digest",
  },
  // handlerSetDigest reflects the real SERVER's bound handler set (keiko-server composition, out
  // of this pure-producer script's reach): format-checked here, never value-cross-checked.
  {
    test: (r) => HEX_64.test(r.handlerSetDigest),
    message: "handlerSetDigest is not a 64-hex digest",
  },
  {
    test: (r) => isCatalogProfileRef(r.profile),
    message: "profile is not a {id, version} catalog profile ref",
  },
  {
    test: (r) => isNonEmptyString(r.catalogRevision),
    message: "catalogRevision is not a non-empty string",
  },
  {
    test: (r) => isNonEmptyString(r.verificationRef),
    message: "verificationRef is not a non-empty string",
  },
  { test: (r) => isNonEmptyString(r.reviewRef), message: "reviewRef is not a non-empty string" },
]);

export function h1ProvenanceShapeFailures(record) {
  const fields = REQUIRED_INTERFACE_FIELDS.H1Provenance.split(",");
  const keys = Object.keys(record).sort(compareStrings);
  if (
    keys.length !== fields.length ||
    ![...fields].sort(compareStrings).every((field, i) => field === keys[i])
  )
    return [
      "H1 handoff evidence malformed: durable record does not carry exactly the H1Provenance fields",
    ];
  return H1_PROVENANCE_FIELD_CHECKS.filter((check) => !check.test(record)).map(
    (check) => `H1 handoff evidence malformed: ${check.message}`,
  );
}

function readH1Provenance(root, recordPath = H1_PROVENANCE_PATH) {
  let bytes;
  try {
    bytes = readFileSync(join(root, recordPath), "utf8");
  } catch {
    return {
      record: null,
      shapeFailures: [`H1 handoff evidence missing: no ${recordPath}`],
    };
  }
  try {
    const record = JSON.parse(bytes);
    return { record, shapeFailures: h1ProvenanceShapeFailures(record) };
  } catch {
    return { record: null, shapeFailures: ["H1 handoff evidence malformed: not valid JSON"] };
  }
}

function checkpointAncestorFailures(root, record, execute) {
  try {
    const options = { cwd: root, encoding: "utf8", stdio: "pipe" };
    execute(
      resolveHostExecutable("git"),
      ["merge-base", "--is-ancestor", record.sourceHead, record.currentHead],
      options,
    );
    // Squash/rebase integration rewrites commit identities. Preserve the original reviewed
    // producer-to-consumer ancestry and common repository history; realSourceHeadFailures below
    // independently requires exactly the reviewed owned contents at the actual current HEAD.
    execute(resolveHostExecutable("git"), ["merge-base", record.currentHead, "HEAD"], options);
    return [];
  } catch {
    return ["H1 producer checkpoint unreachable: producer/consumer integration history mismatch"];
  }
}

function acceptedCheckpointReceipt(receipt, record, kind) {
  return (
    typeof receipt === "object" &&
    receipt !== null &&
    receipt.schemaVersion === 1 &&
    receipt.status === (kind === "verification" ? "verified" : "accepted") &&
    receipt.sourceHead === record.sourceHead &&
    receipt.ownedSourceDigest === record.treeDigest
  );
}

function hasExactFields(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareStrings);
  const sortedExpected = [...expected].sort(compareStrings);
  return (
    actual.length === sortedExpected.length &&
    sortedExpected.every((field, index) => field === actual[index])
  );
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isIsoInstant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  const milliseconds = new Date(value).toISOString();
  return value === milliseconds || value === milliseconds.replace(".000Z", "Z");
}

const VERIFICATION_RECEIPT_FIELDS = Object.freeze([
  "schemaVersion",
  "status",
  "verificationKind",
  "repository",
  "integrationPr",
  "sourceHead",
  "currentHead",
  "sourceTree",
  "currentTree",
  "ownedSourceDigest",
  "baseRef",
  "baseHead",
  "mergedAt",
  "managedVerification",
  "requiredChecks",
]);
const MANAGED_VERIFICATION_FIELDS = Object.freeze(["testFiles", "testCount", "result"]);
const REQUIRED_CHECK_FIELDS = Object.freeze([
  "sourceHead",
  "configured",
  "satisfied",
  "successfulEvidenceRuns",
  "failed",
  "pending",
  "requirementsDigest",
  "evidenceDigest",
  "evidenceRef",
]);
const REVIEW_RECEIPT_FIELDS = Object.freeze([
  "schemaVersion",
  "status",
  "reviewKind",
  "repository",
  "integrationPr",
  "ownerIssue",
  "sourceHead",
  "currentHead",
  "ownedSourceDigest",
  "binding",
  "reviewThreads",
]);
const BINDING_FIELDS = Object.freeze([
  "catalogRevision",
  "profile",
  "projectionDigest",
  "handlerSetDigest",
]);
const REVIEW_THREAD_FIELDS = Object.freeze([
  "total",
  "resolved",
  "unresolved",
  "current",
  "currentResolved",
  "currentUnresolved",
  "evidenceRef",
]);

function validLandingReceiptIdentity(receipt, record, kind) {
  return (
    acceptedCheckpointReceipt(receipt, record, kind) &&
    receipt.repository === H1_INTEGRATION_REPOSITORY &&
    receipt.integrationPr === H1_INTEGRATION_PR &&
    receipt.currentHead === record.currentHead
  );
}

function validManagedVerification(value) {
  return (
    hasExactFields(value, MANAGED_VERIFICATION_FIELDS) &&
    isPositiveInteger(value.testFiles) &&
    isPositiveInteger(value.testCount) &&
    value.result === "passed"
  );
}

function validRequiredCheckCounts(value) {
  return (
    isPositiveInteger(value.configured) &&
    Number.isSafeInteger(value.satisfied) &&
    value.satisfied === value.configured &&
    Number.isSafeInteger(value.successfulEvidenceRuns) &&
    value.successfulEvidenceRuns >= value.satisfied &&
    value.failed === 0 &&
    value.pending === 0
  );
}

function validRequiredChecks(value, sourceHead) {
  const evidenceRef = `github:${H1_INTEGRATION_REPOSITORY}#pull/${String(H1_INTEGRATION_PR)}/checks@${sourceHead}`;
  return (
    hasExactFields(value, REQUIRED_CHECK_FIELDS) &&
    value.sourceHead === sourceHead &&
    validRequiredCheckCounts(value) &&
    HEX_64.test(value.requirementsDigest) &&
    HEX_64.test(value.evidenceDigest) &&
    value.evidenceRef === evidenceRef
  );
}

function validVerificationMetadata(receipt) {
  return (
    receipt.verificationKind === "postmerge-source-head-and-required-ci" &&
    receipt.baseRef === "dev" &&
    HEX_40.test(receipt.baseHead) &&
    isIsoInstant(receipt.mergedAt)
  );
}

function verificationReceiptFailures(receipt, record) {
  if (!hasExactFields(receipt, VERIFICATION_RECEIPT_FIELDS))
    return ["H1 landing verification receipt malformed: unexpected top-level fields"];
  const failures = [];
  if (!validLandingReceiptIdentity(receipt, record, "verification"))
    failures.push("H1 landing verification receipt identity mismatch");
  if (!validVerificationMetadata(receipt))
    failures.push("H1 landing verification receipt integration metadata mismatch");
  if (!HEX_40.test(receipt.sourceTree) || receipt.sourceTree !== receipt.currentTree)
    failures.push("H1 landing verification receipt Git tree identity mismatch");
  if (!validManagedVerification(receipt.managedVerification))
    failures.push("H1 landing verification receipt has no passing managed verification");
  if (!validRequiredChecks(receipt.requiredChecks, record.sourceHead))
    failures.push("H1 landing verification receipt required-check settlement mismatch");
  return failures;
}

function validReviewBinding(value, record) {
  return (
    hasExactFields(value, BINDING_FIELDS) &&
    value.catalogRevision === record.catalogRevision &&
    hasExactFields(value.profile, ["id", "version"]) &&
    value.profile.id === record.profile.id &&
    value.profile.version === record.profile.version &&
    value.projectionDigest === record.projectionDigest &&
    value.handlerSetDigest === record.handlerSetDigest
  );
}

function validReviewThreads(value, sourceHead) {
  const evidenceRef = `github:${H1_INTEGRATION_REPOSITORY}#pull/${String(H1_INTEGRATION_PR)}/review-threads@${sourceHead}`;
  return (
    hasExactFields(value, REVIEW_THREAD_FIELDS) &&
    validReviewThreadCounts(value) &&
    value.evidenceRef === evidenceRef
  );
}

function validReviewThreadCounts(value) {
  return (
    Number.isSafeInteger(value.total) &&
    value.total > 0 &&
    value.resolved === value.total &&
    value.unresolved === 0 &&
    Number.isSafeInteger(value.current) &&
    value.current > 0 &&
    value.current <= value.total &&
    value.currentResolved === value.current &&
    value.currentUnresolved === 0
  );
}

function reviewReceiptFailures(receipt, record) {
  if (!hasExactFields(receipt, REVIEW_RECEIPT_FIELDS))
    return ["H1 landing review receipt malformed: unexpected top-level fields"];
  const failures = [];
  if (!validLandingReceiptIdentity(receipt, record, "review"))
    failures.push("H1 landing review receipt identity mismatch");
  if (receipt.reviewKind !== "postmerge-github-review-settlement")
    failures.push("H1 landing review receipt kind mismatch");
  if (receipt.ownerIssue !== H1_OWNER_ISSUE)
    failures.push("H1 landing review receipt owner mismatch");
  if (!validReviewBinding(receipt.binding, record))
    failures.push("H1 landing review receipt catalog binding mismatch");
  if (!validReviewThreads(receipt.reviewThreads, record.sourceHead))
    failures.push("H1 landing review receipt thread settlement mismatch");
  return failures;
}

function landingTreeFailures(root, receipt, record, execute) {
  const currentTree = resolveCommitTreeId(record.currentHead, root, execute);
  if (currentTree === null)
    return ["H1 landing verification receipt current Git tree is not resolvable"];
  if (
    !HEX_40.test(receipt.sourceTree) ||
    receipt.sourceTree !== receipt.currentTree ||
    receipt.currentTree !== currentTree
  )
    return ["H1 landing verification receipt Git tree identity mismatch"];
  return [];
}

export function h1LandingReceiptSemanticFailures(receipt, record, kind) {
  return kind === "verification"
    ? verificationReceiptFailures(receipt, record)
    : reviewReceiptFailures(receipt, record);
}

function landingReceiptFailures(root, record, kind, execute) {
  const result = readCheckpointReceipt(root, record, kind);
  if (result.receipt === null || result.failures.length > 0) return result.failures;
  const failures = h1LandingReceiptSemanticFailures(result.receipt, record, kind);
  if (failures.length > 0) return failures;
  return kind === "verification" ? landingTreeFailures(root, result.receipt, record, execute) : [];
}

function readCheckpointReceipt(root, record, kind) {
  const receiptPath = `docs/qa/evidence/h1-${kind}.v1.json`;
  const ref = kind === "verification" ? record.verificationRef : record.reviewRef;
  const prefix = `${receiptPath}#sha256=`;
  if (!ref.startsWith(prefix) || !HEX_64.test(ref.slice(prefix.length)))
    return {
      receipt: null,
      failures: [
        `H1 producer checkpoint invalid ${kind} reference: expected a pinned local receipt`,
      ],
    };
  try {
    const bytes = readFileSync(join(root, receiptPath), "utf8");
    if (sha256Hex(bytes) !== ref.slice(prefix.length))
      return {
        receipt: null,
        failures: [`H1 producer checkpoint stale ${kind} receipt: content digest mismatch`],
      };
    return { receipt: JSON.parse(bytes), failures: [] };
  } catch {
    return {
      receipt: null,
      failures: [`H1 producer checkpoint missing or malformed ${kind} receipt`],
    };
  }
}

function checkpointReceiptFailures(root, record, kind) {
  const result = readCheckpointReceipt(root, record, kind);
  if (result.receipt === null || result.failures.length > 0) return result.failures;
  return acceptedCheckpointReceipt(result.receipt, record, kind)
    ? []
    : [`H1 producer checkpoint invalid ${kind} receipt: source or acceptance mismatch`];
}

function checkpointWorktreeFailures(root, execute, ownedPaths) {
  try {
    execute(resolveHostExecutable("git"), ["diff", "--quiet", "HEAD", "--", ...ownedPaths], {
      cwd: root,
      stdio: "pipe",
    });
    return [];
  } catch {
    return ["H1 producer checkpoint stale: uncommitted owned-source changes"];
  }
}

// Consolidated #3394 delivery requires the reviewed producer BEFORE the final merge can exist.
// Preserve the stricter, separate post-merge recheck below. This checkpoint grants no runtime
// authority and is not an input to any projection digest. Reuse the same H1 record and Git/source
// identity helpers; a real ancestor alone is insufficient if the current owned contents drift.
export async function checkH1ProducerCheckpoint(
  root = process.cwd(),
  { checkpointPath = H1_PRODUCER_CHECKPOINT_PATH } = {},
  {
    execute = execFileSync,
    identityFailures = producerLineageFailures,
    ownedPaths = H1_OWNED_SOURCE_PATHS,
  } = {},
) {
  const { record, shapeFailures } = readH1Provenance(root, checkpointPath);
  if (record === null || shapeFailures.length > 0) return shapeFailures;
  return [
    ...checkpointAncestorFailures(root, record, execute),
    ...checkpointWorktreeFailures(root, execute, ownedPaths),
    ...(await realSourceHeadFailures(root, record, execute, ownedPaths)),
    ...(await realSourceHeadFailures(
      root,
      { ...record, currentHead: "HEAD" },
      execute,
      ownedPaths,
    )),
    ...(await identityFailures(root, record)),
    ...checkpointReceiptFailures(root, record, "verification"),
    ...checkpointReceiptFailures(root, record, "review"),
  ];
}

export function isAncestorOfDev(commit, root, execute) {
  const git = resolveHostExecutable("git");
  const remoteDev = "refs/remotes/origin/dev";
  const localDev = "refs/heads/dev";
  let devRef = remoteDev;
  try {
    execute(git, ["show-ref", "--verify", "--quiet", remoteDev], { cwd: root, encoding: "utf8" });
  } catch {
    devRef = localDev;
    try {
      execute(git, ["show-ref", "--verify", "--quiet", localDev], { cwd: root, encoding: "utf8" });
    } catch {
      return false;
    }
  }
  try {
    execute(git, ["merge-base", "--is-ancestor", commit, devRef], {
      cwd: root,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

export async function realProducerIdentityFailures(root, record) {
  if (typeof record.profile?.id !== "string") return [];
  try {
    const producer = await loadToolCatalogProducer(root);
    const catalog =
      record.profile.id === "opencode"
        ? producer.createKeikoToolCatalog([producer.opencodeRegistrationSet()])
        : producer.createInitialToolCatalog();
    const projection = producer.compileToolProjection(catalog, record.profile);
    const failures = [];
    if (projection.catalogRevision !== record.catalogRevision)
      failures.push(
        "H1 handoff evidence identity mismatch: catalogRevision does not match the current producer",
      );
    if (projection.projectionDigest !== record.projectionDigest)
      failures.push(
        "H1 handoff evidence identity mismatch: projectionDigest does not match the current producer",
      );
    return failures;
  } catch {
    return [
      "H1 handoff evidence identity mismatch: durable record's profile cannot be compiled by the current producer",
    ];
  }
}

// ADR-0175 amendment (PR #3452, 2026-09-10): a producer change after the H1 landing is admitted by
// an append-only lineage of owner-issued producer checkpoints. Each entry binds the identity it
// introduces to the identity it replaced and to SHA-256-pinned verification and independent-review
// receipts; the durable H1 records keep their historical identity untouched. The current producer
// must equal a record's identity, or be the last identity of a lineage that starts at that record —
// so a producer change without its own checkpoint still fails, now with the reason it failed.
export const TOOL_CATALOG_PRODUCER_LINEAGE_PATH =
  "docs/architecture/tool-catalog-producer-lineage.v1.json";
const LINEAGE_FIELDS = Object.freeze(["schemaVersion", "profile", "entries"]);
const LINEAGE_ENTRY_FIELDS = Object.freeze([
  "sequence",
  "predecessor",
  "catalogRevision",
  "projectionDigest",
  "handlerSetDigest",
  "sourceCommit",
  "integrationPr",
  "reason",
  "verificationRef",
  "reviewRef",
]);
const LINEAGE_IDENTITY_FIELDS = Object.freeze(["catalogRevision", "projectionDigest"]);
const LINEAGE_VERIFICATION_FIELDS = Object.freeze([
  "schemaVersion",
  "status",
  "verificationKind",
  "sequence",
  "sourceCommit",
  "catalogRevision",
  "projectionDigest",
  "command",
  "testFiles",
  "testCount",
  "result",
  "evidenceRef",
]);
const LINEAGE_REVIEW_FIELDS = Object.freeze([
  "schemaVersion",
  "status",
  "reviewKind",
  "sequence",
  "sourceCommit",
  "catalogRevision",
  "projectionDigest",
  "handlerSetDigest",
  "reviewer",
  "criteria",
  "reviewThreads",
  "evidenceRef",
]);
// CodeRabbit's CWE-345 note (3984717984), confirmed live by the owner on this PR: a receipt that
// only had to carry a non-empty `reviewer` string let a criterion be attributed to a reviewer who
// never published it, and nothing here caught it. Resolving `evidenceRef` against GitHub at check
// time is not available -- no gate in this repository reaches the network, and the sandboxed lanes
// have none -- so this binds the claim the way the H1 landing receipt already binds its own review
// evidence: countable, internally consistent settlement figures that a fabricated receipt cannot
// satisfy while still matching the entry it certifies.
const LINEAGE_REVIEW_THREAD_FIELDS = Object.freeze(["attributed", "resolved", "unresolved"]);

// Each criterion must correspond to one attributed, resolved thread: fewer threads than criteria
// means at least one criterion has no thread behind it, and an unresolved thread means the audit it
// claims to record has not settled.
function validLineageReviewThreads(value, criteria) {
  return (
    hasExactFields(value, LINEAGE_REVIEW_THREAD_FIELDS) &&
    isPositiveInteger(value.attributed) &&
    value.attributed >= criteria.length &&
    value.resolved === value.attributed &&
    value.unresolved === 0
  );
}
const LINEAGE_REASON = /^[a-z]+(?:-[a-z]+){0,8}$/u;

async function compiledProducerIdentity(root, profile) {
  const producer = await loadToolCatalogProducer(root);
  const catalog =
    profile.id === "opencode"
      ? producer.createKeikoToolCatalog([producer.opencodeRegistrationSet()])
      : producer.createInitialToolCatalog();
  const projection = producer.compileToolProjection(catalog, profile);
  return {
    catalogRevision: projection.catalogRevision,
    projectionDigest: projection.projectionDigest,
  };
}

function sameProducerIdentity(a, b) {
  return a.catalogRevision === b.catalogRevision && a.projectionDigest === b.projectionDigest;
}

function recordIdentityMismatch(current, record) {
  const failures = [];
  if (current.catalogRevision !== record.catalogRevision)
    failures.push(
      "H1 handoff evidence identity mismatch: catalogRevision does not match the current producer",
    );
  if (current.projectionDigest !== record.projectionDigest)
    failures.push(
      "H1 handoff evidence identity mismatch: projectionDigest does not match the current producer",
    );
  return failures;
}

function readProducerLineage(root, lineagePath) {
  try {
    return { lineage: JSON.parse(readFileSync(join(root, lineagePath), "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { lineage: undefined };
    return { failures: ["tool-catalog producer lineage malformed: not valid JSON"] };
  }
}

function pinnedLineageReceipt(root, ref, sequence, kind) {
  const path = `docs/qa/evidence/tool-catalog-producer-${String(sequence)}-${kind}.v1.json`;
  const prefix = `${path}#sha256=`;
  if (typeof ref !== "string" || !ref.startsWith(prefix) || !HEX_64.test(ref.slice(prefix.length)))
    return {
      failure: `tool-catalog producer lineage entry ${String(sequence)} has an invalid ${kind} reference`,
    };
  try {
    const bytes = readFileSync(join(root, path), "utf8");
    if (sha256Hex(bytes) !== ref.slice(prefix.length))
      return {
        failure: `tool-catalog producer lineage entry ${String(sequence)} has a stale ${kind} receipt`,
      };
    return { receipt: JSON.parse(bytes) };
  } catch {
    return {
      failure: `tool-catalog producer lineage entry ${String(sequence)} has a missing or malformed ${kind} receipt`,
    };
  }
}

function validLineageIdentity(value) {
  return (
    hasExactFields(value, LINEAGE_IDENTITY_FIELDS) &&
    HEX_64.test(value.catalogRevision) &&
    HEX_64.test(value.projectionDigest)
  );
}

function validLineageEntryShape(entry, index) {
  return (
    hasExactFields(entry, LINEAGE_ENTRY_FIELDS) &&
    entry.sequence === index + 1 &&
    validLineageIdentity(entry.predecessor) &&
    HEX_64.test(entry.catalogRevision) &&
    HEX_64.test(entry.projectionDigest) &&
    HEX_64.test(entry.handlerSetDigest) &&
    HEX_40.test(entry.sourceCommit) &&
    isPositiveInteger(entry.integrationPr) &&
    typeof entry.reason === "string" &&
    LINEAGE_REASON.test(entry.reason)
  );
}

// The externally checkable evidence a lineage receipt must point at, in the same form and with the
// same binding as the H1 landing receipts: the integration PR's required checks and its review
// threads, pinned at the entry's own source commit. A receipt without it is a self-assertion.
function lineageEvidenceRef(entry, kind) {
  return `github:${H1_INTEGRATION_REPOSITORY}#pull/${String(entry.integrationPr)}/${kind}@${entry.sourceCommit}`;
}

function receiptBindsEntry(receipt, entry) {
  return (
    receipt.schemaVersion === 1 &&
    receipt.sequence === entry.sequence &&
    receipt.sourceCommit === entry.sourceCommit &&
    receipt.catalogRevision === entry.catalogRevision &&
    receipt.projectionDigest === entry.projectionDigest
  );
}

function validLineageVerificationReceipt(receipt, entry) {
  return (
    hasExactFields(receipt, LINEAGE_VERIFICATION_FIELDS) &&
    receiptBindsEntry(receipt, entry) &&
    receipt.status === "verified" &&
    receipt.verificationKind === "deterministic-production-managed" &&
    isNonEmptyString(receipt.command) &&
    isPositiveInteger(receipt.testFiles) &&
    isPositiveInteger(receipt.testCount) &&
    receipt.result === "passed" &&
    receipt.evidenceRef === lineageEvidenceRef(entry, "checks")
  );
}

function validReviewCriterion(criterion) {
  return (
    hasExactFields(criterion, ["label", "result"]) &&
    isNonEmptyString(criterion.label) &&
    criterion.result === "verified"
  );
}

// The findings half of a review receipt: at least one verified criterion, and every criterion
// attributed to a thread the reviewer actually settled (CWE-345 binding, validLineageReviewThreads).
function validLineageReviewFindings(receipt) {
  return (
    Array.isArray(receipt.criteria) &&
    receipt.criteria.length > 0 &&
    receipt.criteria.every(validReviewCriterion) &&
    validLineageReviewThreads(receipt.reviewThreads, receipt.criteria)
  );
}

function validLineageReviewReceipt(receipt, entry) {
  return (
    hasExactFields(receipt, LINEAGE_REVIEW_FIELDS) &&
    receiptBindsEntry(receipt, entry) &&
    receipt.status === "accepted" &&
    receipt.reviewKind === "independent-source-and-evidence-audit" &&
    receipt.handlerSetDigest === entry.handlerSetDigest &&
    isNonEmptyString(receipt.reviewer) &&
    validLineageReviewFindings(receipt) &&
    receipt.evidenceRef === lineageEvidenceRef(entry, "review-threads")
  );
}

function lineageReceiptFailures(root, entry) {
  const failures = [];
  const verification = pinnedLineageReceipt(
    root,
    entry.verificationRef,
    entry.sequence,
    "verification",
  );
  if (verification.failure !== undefined) failures.push(verification.failure);
  else if (!validLineageVerificationReceipt(verification.receipt, entry))
    failures.push(
      `tool-catalog producer lineage entry ${String(entry.sequence)} verification receipt does not bind it`,
    );
  const review = pinnedLineageReceipt(root, entry.reviewRef, entry.sequence, "review");
  if (review.failure !== undefined) failures.push(review.failure);
  else if (!validLineageReviewReceipt(review.receipt, entry))
    failures.push(
      `tool-catalog producer lineage entry ${String(entry.sequence)} review receipt does not bind it`,
    );
  return failures;
}

// The producer's own source. A lineage entry certifies the producer AT its source commit, so the
// last entry is only valid while this tree is unchanged since that commit.
const TOOL_CATALOG_PRODUCER_SOURCE_DIR = "packages/keiko-tool-catalog/src";

/** Real Git facts about a lineage entry's source commit; injectable so the rules stay testable. */
export function gitLineageCommitFacts(root, execute = execFileSync) {
  const git = resolveHostExecutable("git");
  const succeeds = (args) => {
    try {
      execute(git, args, { cwd: root, encoding: "utf8", stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  return {
    resolves: (commit) => resolveCommitTreeId(commit, root, execute) !== null,
    isAncestorOfHead: (commit) => succeeds(["merge-base", "--is-ancestor", commit, "HEAD"]),
    producerUnchangedSince: (commit) =>
      succeeds(["diff", "--quiet", commit, "HEAD", "--", TOOL_CATALOG_PRODUCER_SOURCE_DIR]),
  };
}

// A source commit that does not resolve, does not precede the commit being checked, or (for the last
// entry) no longer holds the producer being checked cannot certify it. Fails closed: an unresolvable
// commit is a failure, never tolerated.
function lineageCommitFailures(entry, commits, isLast) {
  const label = `tool-catalog producer lineage entry ${String(entry.sequence)}`;
  if (!commits.resolves(entry.sourceCommit))
    return [`${label} sourceCommit is not a resolvable Git commit`];
  const failures = [];
  if (!commits.isAncestorOfHead(entry.sourceCommit))
    failures.push(`${label} sourceCommit is not an ancestor of the consuming commit`);
  if (isLast && !commits.producerUnchangedSince(entry.sourceCommit))
    failures.push(
      "tool-catalog producer lineage stale: the producer source changed after the last entry's sourceCommit",
    );
  return failures;
}

function lineageEntryFailures(root, entry, index, previous, chain) {
  if (!validLineageEntryShape(entry, index))
    return [`tool-catalog producer lineage entry ${String(index + 1)} malformed`];
  return [
    ...(sameProducerIdentity(entry.predecessor, previous)
      ? []
      : [
          `tool-catalog producer lineage broken: entry ${String(entry.sequence)} does not continue the identity before it`,
        ]),
    ...lineageCommitFailures(entry, chain.commits, index === chain.lastIndex),
    ...lineageReceiptFailures(root, entry),
  ];
}

function producerLineageChainFailures(root, lineage, record, current, commits) {
  if (
    !hasExactFields(lineage, LINEAGE_FIELDS) ||
    lineage.schemaVersion !== 1 ||
    !Array.isArray(lineage.entries) ||
    lineage.entries.length === 0
  )
    return ["tool-catalog producer lineage malformed: unexpected shape"];
  if (
    !isCatalogProfileRef(lineage.profile) ||
    lineage.profile.id !== record.profile.id ||
    lineage.profile.version !== record.profile.version
  )
    return ["tool-catalog producer lineage profile does not match the record"];
  const failures = [];
  let previous = record;
  const chain = { commits, lastIndex: lineage.entries.length - 1 };
  lineage.entries.forEach((entry, index) => {
    failures.push(...lineageEntryFailures(root, entry, index, previous, chain));
    previous = entry;
  });
  if (failures.length === 0 && !sameProducerIdentity(previous, current))
    failures.push(
      "tool-catalog producer lineage stale: the current producer is not the lineage's last identity",
    );
  return failures;
}

/**
 * The current producer against a durable H1 record: equal, or reachable through the whole
 * owner-issued lineage. Without a lineage file a mismatch reports exactly what it always did.
 */
function lineageCommitFactsFor(root, options) {
  return options.commits ?? gitLineageCommitFacts(root);
}

async function currentProducerIdentity(root, record, identity) {
  try {
    return { current: await identity(root, record.profile) };
  } catch {
    return {
      failures: [
        "H1 handoff evidence identity mismatch: durable record's profile cannot be compiled by the current producer",
      ],
    };
  }
}

export async function producerLineageFailures(root, record, options = {}) {
  if (typeof record.profile?.id !== "string") return [];
  const { lineagePath = TOOL_CATALOG_PRODUCER_LINEAGE_PATH, identity = compiledProducerIdentity } =
    options;
  const compiled = await currentProducerIdentity(root, record, identity);
  if (compiled.failures !== undefined) return compiled.failures;
  const current = compiled.current;
  if (sameProducerIdentity(current, record)) return [];
  const read = readProducerLineage(root, lineagePath);
  if (read.failures !== undefined) return read.failures;
  if (read.lineage === undefined) return recordIdentityMismatch(current, record);
  return producerLineageChainFailures(
    root,
    read.lineage,
    record,
    current,
    lineageCommitFactsFor(root, options),
  );
}

// Resolves a caller-declared commit against real Git, never trusting the string alone: the commit
// object must exist (`git cat-file -e <sha>^{commit}`) AND resolve a real tree (`git rev-parse
// <sha>^{tree}`). Returns `null` for anything unresolvable — a nonexistent, malformed, or
// non-commit object.
function resolveCommitTreeId(commit, root, execute) {
  try {
    execute(resolveHostExecutable("git"), ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: root,
      encoding: "utf8",
    });
    const treeId = String(
      execute(resolveHostExecutable("git"), ["rev-parse", `${commit}^{tree}`], {
        cwd: root,
        encoding: "utf8",
      }),
    ).trim();
    return HEX_40.test(treeId) ? treeId : null;
  } catch {
    return null;
  }
}

// The one digest formula for "owned source content at a commit", reused by both the producer side
// (the producer checkpoint and durable H1Provenance) and this recheck — never restated. Reads each owned path's
// exact byte content at `commit` via Git's byte-framed batch reader (fails closed if any path is
// absent from that commit's tree) and hashes sorted {path, contentBase64} pairs with this file's own
// canonical digest primitive (`canonicalise`/`sha256Hex`, keiko-security — this file's own
// `digest-primitives` inventory owner), so the result is bound to real Git object content, never a
// caller-declared string.
export function ownedSourceDigestAt(commit, root, execute, ownedPaths = H1_OWNED_SOURCE_PATHS) {
  const files = readGitSourceContent(commit, ownedPaths, root, execute);
  return sha256Hex(canonicalise(files));
}

/**
 * Review 3941891302 (H1 handoff recheck gap): the recheck previously compared only the two
 * caller-declared tree digests (`record.treeDigest` vs the landing pin) and never
 * resolved `sourceHead` against Git or bound its content to the consuming commit — a nonexistent
 * `sourceHead` with a fabricated `treeDigest` repeated in both records passed with no failures.
 * This independently: (1) resolves `sourceHead` as a real, existing Git commit; (2) recomputes the
 * H1-owned-source digest at `sourceHead` and requires it to equal the declared `treeDigest`; (3)
 * resolves `currentHead` (the consuming commit) the same way and requires ITS owned-source digest
 * to equal the same `treeDigest` — binding the reviewed producer content to what actually landed,
 * not merely to another caller-declared string. Fails closed with a precise reason on any
 * unresolvable commit, missing owned path, or digest mismatch.
 */
export async function realSourceHeadFailures(
  root,
  record,
  execute,
  ownedPaths = H1_OWNED_SOURCE_PATHS,
) {
  if (resolveCommitTreeId(record.sourceHead, root, execute) === null) {
    return [
      `H1 handoff evidence unverifiable: sourceHead ${record.sourceHead} is not a resolvable Git commit`,
    ];
  }
  let sourceDigest;
  try {
    sourceDigest = ownedSourceDigestAt(record.sourceHead, root, execute, ownedPaths);
  } catch {
    return [
      `H1 handoff evidence unverifiable: an H1-owned source path is missing from sourceHead ${record.sourceHead}`,
    ];
  }
  if (sourceDigest !== record.treeDigest) {
    return [
      "H1 handoff evidence identity mismatch: treeDigest does not match the real owned source content at sourceHead",
    ];
  }
  if (resolveCommitTreeId(record.currentHead, root, execute) === null) {
    return [
      `H1 handoff evidence unverifiable: currentHead ${record.currentHead} is not a resolvable Git commit`,
    ];
  }
  let currentDigest;
  try {
    currentDigest = ownedSourceDigestAt(record.currentHead, root, execute, ownedPaths);
  } catch {
    return [
      `H1 handoff evidence unverifiable: an H1-owned source path is missing from currentHead ${record.currentHead}`,
    ];
  }
  if (currentDigest !== record.treeDigest) {
    return [
      "H1 handoff evidence identity mismatch: the consuming commit's owned source content does not match the reviewed treeDigest",
    ];
  }
  return [];
}

/**
 * #3414 AC7 / #3415 AC5-AC6. Returns `[]` while H1 has not landed to `dev` (both fields honestly
 * null — the historical expected state, never a failure). Once EITHER field is populated, every fact below
 * must independently check out or this fails closed with a precise reason; nothing here trusts a
 * caller-declared value it has not itself re-derived or cross-checked.
 */
// `null` return means "proceed to the durable-record recheck"; a non-null array is the final,
// already-decided result (nothing landed yet, or the landed fields themselves are malformed).
function pendingFieldFailures(landedDevCommit, landedTreeDigest) {
  if (landedDevCommit === null && landedTreeDigest === null) return [];
  if (landedDevCommit === null || landedTreeDigest === null) {
    return [
      "H1 handoff evidence partially populated: landedDevCommit and landedTreeDigest must be set together",
    ];
  }
  if (!HEX_40.test(landedDevCommit))
    return [
      "H1 handoff evidence malformed: landing pin landedDevCommit is not a 40-hex commit SHA",
    ];
  if (!HEX_64.test(landedTreeDigest))
    return ["H1 handoff evidence malformed: landing pin landedTreeDigest is not a 64-hex digest"];
  return null;
}

function staleRecordFailures(record, landedDevCommit, landedTreeDigest) {
  const failures = [];
  if (record.treeDigest !== landedTreeDigest)
    failures.push(
      "H1 handoff evidence stale: durable record's treeDigest does not match landing pin landedTreeDigest",
    );
  if (record.currentHead !== landedDevCommit)
    failures.push(
      "H1 handoff evidence stale: durable record's currentHead does not match landing pin landedDevCommit",
    );
  return failures;
}

async function landedEvidenceFailures(root, landedDevCommit, landedTreeDigest, deps) {
  const { record, shapeFailures } = readH1Provenance(root, deps.provenancePath);
  if (record === null || shapeFailures.length > 0) return shapeFailures;
  const identityFailures = [
    ...staleRecordFailures(record, landedDevCommit, landedTreeDigest),
    ...(isAncestorOfDev(landedDevCommit, root, deps.execute)
      ? []
      : [
          `H1 handoff evidence unreachable: landedDevCommit ${landedDevCommit} is not an ancestor of dev`,
        ]),
    ...(await deps.sourceHeadFailures(root, record, deps.execute)),
    ...(await deps.identityFailures(root, record)),
  ];
  if (identityFailures.length > 0) return identityFailures;
  return [
    ...deps.receiptFailures(root, record, "verification", deps.execute),
    ...deps.receiptFailures(root, record, "review", deps.execute),
  ];
}

export async function checkH1HandoffEvidence(
  root,
  landingPins,
  {
    execute = execFileSync,
    identityFailures = producerLineageFailures,
    receiptFailures = landingReceiptFailures,
    sourceHeadFailures = realSourceHeadFailures,
    provenancePath = H1_PROVENANCE_PATH,
  } = {},
) {
  const repositoryRoot = root === undefined ? process.cwd() : root;
  const landing = landingPins ?? GOVERNED_TOOL_CONTRACT_PINS.h1Provenance;
  const { landedDevCommit, landedTreeDigest } = landing;
  const early = pendingFieldFailures(landedDevCommit, landedTreeDigest);
  if (early !== null) return early;
  return landedEvidenceFailures(repositoryRoot, landedDevCommit, landedTreeDigest, {
    execute,
    identityFailures,
    receiptFailures,
    sourceHeadFailures,
    provenancePath,
  });
}
const CATALOG_NEGATIVE_FIXTURES_DIR = "tests/architecture/fixtures/tool-catalog-negatives";
// One row per attack class named by #3415 (issue-3415, AC2). Each fixture module derives its
// base data from the real producer (see the shared builder's header comment) and applies exactly
// one named mutation; `cases` lists every exported attempt function on that module together with
// the specific `CatalogFailureReason` the real producer must reject it with, so a fixture that
// stops throwing (a regression in the producer) AND a fixture that throws for the WRONG reason
// (a different, unintended rule catching it) both fail this gate.
const CATALOG_SEMANTIC_NEGATIVE_FIXTURES = Object.freeze([
  { file: "missing-handler.mjs", cases: [{ fn: "attempt", reason: "invalid-shape" }] },
  { file: "orphan-handler.mjs", cases: [{ fn: "attempt", reason: "invalid-identity" }] },
  { file: "duplicate-handler.mjs", cases: [{ fn: "attempt", reason: "duplicate-identity" }] },
  {
    file: "version-mismatched-handler.mjs",
    cases: [{ fn: "attempt", reason: "incompatible-version" }],
  },
  {
    file: "alias-collision-or-confusable.mjs",
    cases: [
      { fn: "attemptCollision", reason: "duplicate-identity" },
      { fn: "attemptConfusable", reason: "invalid-identity" },
    ],
  },
  { file: "projection-drift.mjs", cases: [{ fn: "attempt", reason: "invalid-identity" }] },
  { file: "policy-effect-mismatch.mjs", cases: [{ fn: "attempt", reason: "ambiguous-effects" }] },
  {
    file: "stale-downgraded-compatibility.mjs",
    cases: [
      { fn: "attemptStale", reason: "expired-compatibility" },
      { fn: "attemptDowngraded", reason: "invalid-compatibility" },
    ],
  },
  // #3415 AC3: proves the call-time wire boundary (not the compiler) rejects a request that
  // omits `contractVersion` or spells it "latest" instead of pinning an exact version.
  {
    file: "implicit-latest-resolution.mjs",
    cases: [
      { fn: "attemptOmittedContractVersion", reason: "invalid-shape" },
      { fn: "attemptLatestLiteral", reason: "invalid-shape" },
    ],
  },
]);
async function semanticFixtureFailures(producer, fixturesDir, { file, cases }) {
  const fixture = await import(pathToFileURL(join(fixturesDir, file)).href);
  const errors = [];
  for (const { fn, reason } of cases) {
    try {
      fixture[fn](producer);
      errors.push(`tool catalog negative fixture escaped: ${file}#${fn}`);
    } catch (error) {
      const actual =
        error !== null && typeof error === "object" && "reason" in error ? error.reason : undefined;
      if (actual !== reason)
        errors.push(
          `tool catalog negative fixture ${file}#${fn} rejected with reason ` +
            `"${String(actual)}", expected "${reason}"`,
        );
    }
  }
  return errors;
}
/**
 * Runs the full catalog-semantic negative-fixture matrix (#3415 AC2) against the real producer.
 * Complements `checkToolCatalogConformanceNegatives` (AST-level literal-registry detection):
 * this validates the pure compiler's own invariants (descriptor, profile, projection,
 * compatibility) plus the legacy-table drift comparator this script owns.
 */
export async function checkToolCatalogSemanticNegatives(root = process.cwd()) {
  const producer = await loadToolCatalogProducer(root);
  const fixturesDir = join(root, CATALOG_NEGATIVE_FIXTURES_DIR);
  const errors = [];
  for (const fixtureCase of CATALOG_SEMANTIC_NEGATIVE_FIXTURES)
    errors.push(...(await semanticFixtureFailures(producer, fixturesDir, fixtureCase)));
  const legacyFixture = await import(
    pathToFileURL(join(fixturesDir, "legacy-table-reintroduction.mjs")).href
  );
  const legacyResult = await legacyFixture.attempt(producer, root, legacyProjectionDiffers);
  if (legacyResult.rejectedByComparison !== true)
    errors.push("tool catalog negative fixture escaped: legacy-table-reintroduction.mjs#attempt");
  return errors;
}
export function checkToolCatalogConformanceNegatives() {
  const outside = "packages/keiko-server/src/unregistered-tools.ts";
  const sources = [
    'export const tools = [{name: "read_file", parameters: {type: "object"}}];',
    'export const sources = [{name: "keiko_repo_search", arguments: {query: {type: "string"}}}];',
    'export const ref = {canonicalId: "keiko.repo.search", contractVersion: 1};',
  ];
  return sources.flatMap((source, index) =>
    scanToolRegistrySource(outside, source, new Set()).length === 0
      ? [`tool catalog AST negative ${index} escaped`]
      : [],
  );
}
if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--write")) {
    writeFileSync(
      join(process.cwd(), TOOL_CATALOG_MANIFEST_PATH),
      await toolCatalogManifestBytes(),
    );
    writeFileSync(
      join(process.cwd(), TOOL_CATALOG_MIGRATION_PATH),
      await toolCatalogMigrationBytes(),
    );
  }
  const closeout = process.argv.includes("--closeout");
  const errors = [
    ...(await checkToolCatalogConformance()),
    ...checkToolCatalogConformanceNegatives(),
    ...(await checkToolCatalogSemanticNegatives()),
    ...(closeout ? await checkToolCatalogMigrationCloseout() : []),
  ];
  for (const error of errors) console.error(`tool-catalog-conformance: ${error}`);
  console.log(
    `tool-catalog-conformance: ${errors.length === 0 ? "PASS" : "FAIL"} — compiler and finite migration inventory` +
      `${closeout ? " (closeout: zero rows required)" : ""}; no runtime qualification`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
