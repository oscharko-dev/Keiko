#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { format } from "prettier";
import { isMainModule } from "./lib/is-main-module.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import {
  checkToolCatalogInventory,
  scanToolRegistrySource,
  nonDispatchProbeDisposition,
} from "./lib/tool-catalog-inventory.mjs";
import { GOVERNED_TOOL_CONTRACT_PINS } from "./lib/governed-tool-contract-pins.mjs";

export const TOOL_CATALOG_MANIFEST_PATH = "docs/architecture/tool-catalog-manifest.v1.json";
export const TOOL_CATALOG_MIGRATION_PATH = "docs/architecture/tool-catalog-migration.v1.json";
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
    inventory: contract.inventory.map(({ id, ownerIssue, disposition }) => ({
      id,
      ownerIssue,
      disposition,
    })),
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
  return migration.inventory.length === 0
    ? []
    : [
        `migration inventory not empty at closeout: ${String(migration.inventory.length)} row(s) remain`,
      ];
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
