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
    // Non-authorizing pending-H1 handoff record (#3406); see governed-tool-contract-pins.mjs's
    // `pendingH1` comment for what each field means and who may change it. The prerequisite #3411
    // merge identity is this same document's own `sourceContractDigest` -- the #3411 architecture
    // checkpoint this record depends on -- never a second, independently computed digest.
    // landedDevCommit/landedTreeDigest stay null until #3414 records H1's actual dev-reachable
    // merge identity and removes this entry in the same migration.
    pendingH1: {
      owner: GOVERNED_TOOL_CONTRACT_PINS.pendingH1.owner,
      canonicalTool: GOVERNED_TOOL_CONTRACT_PINS.pendingH1.canonicalTool,
      prerequisiteMerge: {
        issue: GOVERNED_TOOL_CONTRACT_PINS.pendingH1.prerequisiteIssue,
        contractDigest: sourceContractDigest,
      },
      removalIssue: GOVERNED_TOOL_CONTRACT_PINS.pendingH1.removalIssue,
      landedDevCommit: null,
      landedTreeDigest: null,
    },
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
export async function checkToolCatalogMigrationCloseout(root = process.cwd()) {
  const migration = JSON.parse(await toolCatalogMigrationBytes(root));
  const inventoryErrors =
    migration.inventory.length === 0
      ? []
      : [
          `migration inventory not empty at closeout: ${String(migration.inventory.length)} row(s) remain`,
        ];
  return [...inventoryErrors, ...(await checkH1HandoffEvidence(root, migration.pendingH1))];
}

// #3414 AC7 / #3415 AC5-AC6: the durable, independently-verifiable H1 dev-landing record. #3414
// alone may write it (once H1 actually reaches `dev` — see governed-tool-migration.md); this repo
// has no such landing on this head, so nothing here fabricates one (AGENTS.md §7). What this DOES
// provide now is the fail-closed RECHECK: if `pendingH1.landedDevCommit`/`landedTreeDigest` are
// ever populated, this record must exist, pass shape validation, agree with them, be reachable
// from `dev`, resolve `sourceHead` against real Git and rebind its declared `treeDigest` to the
// real owned-source content at both `sourceHead` and the consuming `currentHead` commit, and agree
// with the real current producer's own identity — anything missing, stale, unresolvable, or
// mismatched fails qualification rather than passing silently (review 3941891302: a caller could
// otherwise declare a nonexistent `sourceHead` and a fabricated `treeDigest` and pass unchecked).
export const H1_PROVENANCE_PATH = "docs/architecture/h1-provenance.v1.json";
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

// The real, single source of "H1's owned source paths": every currently-registered row of this
// file's own migration inventory (GOVERNED_TOOL_CONTRACT_PINS.inventory) whose ownerIssue matches
// pendingH1.owner (#3386's H1 local repository-search handler). Never a second, hand-authored path
// list — extending or narrowing H1's real ownership means editing that one inventory, and this
// derives from it automatically (AGENTS.md §5).
export const H1_OWNED_SOURCE_PATHS = Object.freeze(
  GOVERNED_TOOL_CONTRACT_PINS.inventory
    .filter((row) => row.ownerIssue === GOVERNED_TOOL_CONTRACT_PINS.pendingH1.owner)
    .map((row) => row.path)
    .sort(),
);

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
  const keys = Object.keys(record).sort();
  if (keys.length !== fields.length || ![...fields].sort().every((field, i) => field === keys[i]))
    return [
      "H1 handoff evidence malformed: durable record does not carry exactly the H1Provenance fields",
    ];
  return H1_PROVENANCE_FIELD_CHECKS.filter((check) => !check.test(record)).map(
    (check) => `H1 handoff evidence malformed: ${check.message}`,
  );
}

function readH1Provenance(root) {
  let bytes;
  try {
    bytes = readFileSync(join(root, H1_PROVENANCE_PATH), "utf8");
  } catch {
    return {
      record: null,
      shapeFailures: [`H1 handoff evidence missing: no ${H1_PROVENANCE_PATH}`],
    };
  }
  try {
    const record = JSON.parse(bytes);
    return { record, shapeFailures: h1ProvenanceShapeFailures(record) };
  } catch {
    return { record: null, shapeFailures: ["H1 handoff evidence malformed: not valid JSON"] };
  }
}

export function isAncestorOfDev(commit, root, execute) {
  try {
    execute(resolveHostExecutable("git"), ["merge-base", "--is-ancestor", commit, "dev"], {
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
// (once #3414 lands real H1Provenance) and this recheck — never restated. Reads each owned path's
// exact byte content at `commit` via `git show <commit>:<path>` (fails closed if any path is
// absent from that commit's tree) and hashes the sorted {path, content} pairs with this file's own
// canonical digest primitive (`canonicalise`/`sha256Hex`, keiko-security — this file's own
// `digest-primitives` inventory owner), so the result is bound to real Git object content, never a
// caller-declared string.
export function ownedSourceDigestAt(commit, root, execute, ownedPaths = H1_OWNED_SOURCE_PATHS) {
  const files = ownedPaths.map((path) => ({
    path,
    content: execute(resolveHostExecutable("git"), ["show", `${commit}:${path}`], {
      cwd: root,
      encoding: "utf8",
    }),
  }));
  return sha256Hex(canonicalise(files));
}

/**
 * Review 3941891302 (H1 handoff recheck gap): the recheck previously compared only the two
 * caller-declared tree digests (`record.treeDigest` vs `pendingH1.landedTreeDigest`) and never
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
 * null — the expected state, never a failure). Once EITHER field is populated, every fact below
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
    return ["H1 handoff evidence malformed: pendingH1.landedDevCommit is not a 40-hex commit SHA"];
  if (!HEX_64.test(landedTreeDigest))
    return ["H1 handoff evidence malformed: pendingH1.landedTreeDigest is not a 64-hex digest"];
  return null;
}

function staleRecordFailures(record, landedDevCommit, landedTreeDigest) {
  const failures = [];
  if (record.treeDigest !== landedTreeDigest)
    failures.push(
      "H1 handoff evidence stale: durable record's treeDigest does not match pendingH1.landedTreeDigest",
    );
  if (record.currentHead !== landedDevCommit)
    failures.push(
      "H1 handoff evidence stale: durable record's currentHead does not match pendingH1.landedDevCommit",
    );
  return failures;
}

async function landedEvidenceFailures(root, landedDevCommit, landedTreeDigest, deps) {
  const { record, shapeFailures } = readH1Provenance(root);
  if (record === null || shapeFailures.length > 0) return shapeFailures;
  return [
    ...staleRecordFailures(record, landedDevCommit, landedTreeDigest),
    ...(isAncestorOfDev(landedDevCommit, root, deps.execute)
      ? []
      : [
          `H1 handoff evidence unreachable: landedDevCommit ${landedDevCommit} is not an ancestor of dev`,
        ]),
    ...(await deps.sourceHeadFailures(root, record, deps.execute)),
    ...(await deps.identityFailures(root, record)),
  ];
}

export async function checkH1HandoffEvidence(
  root = process.cwd(),
  pendingH1,
  {
    execute = execFileSync,
    identityFailures = realProducerIdentityFailures,
    sourceHeadFailures = realSourceHeadFailures,
  } = {},
) {
  const migration = pendingH1 ?? JSON.parse(await toolCatalogMigrationBytes(root)).pendingH1;
  const { landedDevCommit, landedTreeDigest } = migration;
  const early = pendingFieldFailures(landedDevCommit, landedTreeDigest);
  if (early !== null) return early;
  return landedEvidenceFailures(root, landedDevCommit, landedTreeDigest, {
    execute,
    identityFailures,
    sourceHeadFailures,
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
