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

export const TOOL_CATALOG_MANIFEST_PATH = "docs/architecture/tool-catalog-manifest.v1.json";
export const TOOL_CATALOG_MIGRATION_PATH = "docs/architecture/tool-catalog-migration.v1.json";
export async function toolCatalogMigrationBytes(root = process.cwd()) {
  const sourceContract = "docs/architecture/governed-tool-contract.v1.json";
  const bytes = readFileSync(join(root, sourceContract), "utf8");
  const contract = JSON.parse(bytes);
  const migration = {
    schemaVersion: 1,
    ownerIssue: 3406,
    closeoutIssue: 3415,
    sourceContract,
    sourceContractDigest: sha256Hex(bytes),
    inventory: contract.inventory.map(({ id, ownerIssue, disposition }) => ({
      id,
      ownerIssue,
      disposition,
    })),
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
export async function checkToolCatalogConformance(root = process.cwd()) {
  const errors = checkToolCatalogInventory(root);
  const producer = await loadToolCatalogProducer(root);
  const legacy = await import(
    pathToFileURL(join(root, "packages/keiko-tools/dist/schemas.js")).href
  );
  const catalog = producer.createInitialToolCatalog();
  const definitions = producer.gatewayToolDefinitions(catalog, { id: "legacy-native", version: 1 });
  const sorted = (values) =>
    [...values].sort((left, right) => compareStrings(left.name, right.name));
  if (canonicalise(sorted(definitions)) !== canonicalise(sorted(legacy.TOOL_DEFINITIONS)))
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
  const errors = [
    ...(await checkToolCatalogConformance()),
    ...checkToolCatalogConformanceNegatives(),
  ];
  for (const error of errors) console.error(`tool-catalog-conformance: ${error}`);
  console.log(
    `tool-catalog-conformance: ${errors.length === 0 ? "PASS" : "FAIL"} — compiler and finite migration inventory; no runtime qualification`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
