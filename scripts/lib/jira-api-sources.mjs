// Shared offline provenance and exact-byte checks for the Jira API ledger and source provisioner.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./digest.mjs";
import { compareStrings } from "./compare-strings.mjs";

const SOURCE_IDS = { 10.3: "10003", 10.4: "10004", 11.2: "11002", 11.3: "11003" };
const SOURCE_KEYS = new Set([
  "release",
  "url",
  "sha256",
  "bytes",
  "infoVersion",
  "operationCount",
  "pathCount",
  "schemaCount",
]);
export class JiraApiInventoryError extends TypeError {}

export function requireJiraInventory(condition, code) {
  if (!condition) throw new JiraApiInventoryError(code);
}

function positiveCount(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateSource(source) {
  requireJiraInventory(
    Object.keys(source).every((key) => SOURCE_KEYS.has(key)),
    "source-fields",
  );
  requireJiraInventory(Object.hasOwn(SOURCE_IDS, source.release), "source-release");
  requireJiraInventory(
    source.url ===
      `https://developer.atlassian.com/server/jira/platform/jira_software_dc_${SOURCE_IDS[source.release]}_swagger.v3.json`,
    "source-url",
  );
  requireJiraInventory(/^[0-9a-f]{64}$/u.test(source.sha256), "source-digest-shape");
  requireJiraInventory(
    positiveCount(source.bytes) && source.bytes <= 2_000_000,
    "source-byte-bound",
  );
  requireJiraInventory(
    typeof source.infoVersion === "string" && source.infoVersion.length > 0,
    "source-version",
  );
  requireJiraInventory(
    [source.operationCount, source.pathCount, source.schemaCount].every(positiveCount),
    "source-counts",
  );
}

export function validateJiraApiProvenance(provenance) {
  requireJiraInventory(provenance.schemaVersion === 2, "provenance-schema");
  requireJiraInventory(Array.isArray(provenance.sources), "provenance-sources");
  const releases = provenance.sources.map((source) => source.release);
  requireJiraInventory(
    releases.length === 4 && new Set(releases).size === 4,
    "source-completeness",
  );
  for (const source of provenance.sources) validateSource(source);
  const manifest = provenance.manifest;
  requireJiraInventory(
    manifest !== undefined && /^[0-9a-f]{64}$/u.test(manifest.sha256),
    "manifest-digest-shape",
  );
  requireJiraInventory(
    [manifest.operationCount, manifest.pathCount, manifest.familyCount].every(positiveCount),
    "manifest-counts",
  );
}

/** Canonical factual projection only; implementation state can advance without rewriting provenance. */
export function jiraApiManifestDigest(operations) {
  const entries = operations
    .map((row) => [
      row.identity,
      row.sources
        .map(({ release, operationId }) => [release, operationId])
        .sort((left, right) => compareStrings(left[0], right[0])),
    ])
    .sort((left, right) => compareStrings(left[0], right[0]));
  return sha256(JSON.stringify(entries));
}

export function jiraApiSourcePath(cacheDirectory, source) {
  validateSource(source);
  return join(cacheDirectory, source.release, `${source.sha256}.json`);
}

export function validateJiraApiSourceBytes(source, bytes) {
  validateSource(source);
  requireJiraInventory(
    bytes.length === source.bytes && sha256(bytes) === source.sha256,
    "source-digest",
  );
  const spec = JSON.parse(bytes.toString("utf8"));
  requireJiraInventory(spec.info.version === source.infoVersion, "source-version");
  requireJiraInventory(Object.keys(spec.paths).length === source.pathCount, "source-path-count");
  requireJiraInventory(
    Object.keys(spec.components.schemas).length === source.schemaCount,
    "source-schema-count",
  );
  return spec;
}

export function requireJiraCacheDirectory(directory) {
  const entry = lstatSync(directory);
  requireJiraInventory(entry.isDirectory() && !entry.isSymbolicLink(), "source-cache-directory");
}

export function readJiraApiSource(cacheDirectory, source) {
  const path = jiraApiSourcePath(cacheDirectory, source);
  requireJiraCacheDirectory(cacheDirectory);
  requireJiraCacheDirectory(join(cacheDirectory, source.release));
  const entry = lstatSync(path);
  requireJiraInventory(entry.isFile() && !entry.isSymbolicLink(), "source-cache-file");
  requireJiraInventory(entry.size === source.bytes, "source-digest");
  return validateJiraApiSourceBytes(source, readFileSync(path));
}
