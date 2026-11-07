#!/usr/bin/env node
// Offline provenance and completeness gate for the Jira Software Data Center inventory (#4287).
// Public specification bytes are inputs to coverage accounting, never executable HTTP authority.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { sha256 } from "./lib/digest.mjs";
import { readJsonFile } from "./lib/json.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_DIRECTORY = "docs/local-knowledge/jira-api-coverage";
const RELEASES = new Set(["10.3", "10.4", "11.2", "11.3"]);
const SOURCE_IDS = { 10.3: "10003", 10.4: "10004", 11.2: "11002", 11.3: "11003" };
const METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "trace"]);
const STATES = new Set([
  "not-implemented",
  "partial",
  "implemented",
  "deferred",
  "excluded-by-policy",
]);
const AVAILABILITY = new Set(["unknown", "executable", "denied", "unavailable"]);
const ROOTS = ["/api/2/", "/agile/1.0/", "/auth/1/"];
const CLUSTERS = {
  C0: "configuration field issuetype jql mypermissions permissions priority resolution serverInfo settings status statuscategory terminology groupuserpicker searchLimits",
  C1: "project projectCategory projects projectvalidate",
  C2: "backlog board epic",
  C3: "sprint",
  C4: "search",
  C5: "component version",
  C6: "issue comment issueLink issueLinkType worklog",
  C7: "dashboard filter mypreferences",
  C8: "attachment avatar universal_avatar",
  C9: "customFieldOption customFields issuesecurityschemes issuetypescheme notificationscheme permissionscheme priorityschemes role screens securitylevel workflow workflowscheme",
  C10: "applicationrole group groups myself password session user websudo",
  C11: "application-properties cluster email-templates index index-snapshot licenseValidator monitoring readonly-mode reindex upgrade",
};
const FAMILY_CLUSTER = new Map(
  Object.entries(CLUSTERS).flatMap(([cluster, families]) =>
    families.split(" ").map((family) => [family, cluster]),
  ),
);

class InventoryValidationError extends TypeError {}

function requireValid(condition, code) {
  if (!condition) throw new InventoryValidationError(code);
}

function nonemptyText(value) {
  return typeof value === "string" && value.length > 0;
}

function textList(value) {
  return Array.isArray(value) && value.every(nonemptyText);
}

function loadSource(directory, source) {
  requireValid(RELEASES.has(source.release), "source-release");
  requireValid(source.file === `sources/jira-${source.release}.json.gz`, "source-path");
  requireValid(
    source.url ===
      `https://developer.atlassian.com/server/jira/platform/jira_software_dc_${SOURCE_IDS[source.release]}_swagger.v3.json`,
    "source-url",
  );
  requireValid(/^[0-9a-f]{64}$/u.test(source.sha256), "source-digest-shape");
  requireValid(
    Number.isSafeInteger(source.bytes) && source.bytes > 0 && source.bytes <= 2_000_000,
    "source-byte-bound",
  );
  const bytes = gunzipSync(readFileSync(join(directory, source.file)), {
    maxOutputLength: source.bytes,
  });
  requireValid(bytes.length === source.bytes && sha256(bytes) === source.sha256, "source-digest");
  const spec = JSON.parse(bytes.toString("utf8"));
  requireValid(spec.info.version === source.infoVersion, "source-version");
  requireValid(Object.keys(spec.paths).length === source.pathCount, "source-path-count");
  requireValid(
    Object.keys(spec.components.schemas).length === source.schemaCount,
    "source-schema-count",
  );
  return spec;
}

function collectSource(spec, source, union) {
  let count = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    const root = ROOTS.find((candidate) => path.startsWith(candidate));
    requireValid(root !== undefined, "source-api-root");
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      requireValid(nonemptyText(operation.operationId), "source-operation-id");
      const identity = `${method.toUpperCase()} /rest${path}`;
      const entry = union.get(identity) ?? {
        identity,
        method: method.toUpperCase(),
        path: `/rest${path}`,
        apiRoot: `/rest${root.slice(0, -1)}`,
        family: path.slice(root.length).split("/")[0],
        sources: [],
      };
      entry.sources.push({ release: source.release, operationId: operation.operationId });
      union.set(identity, entry);
      count += 1;
    }
  }
  requireValid(count === source.operationCount, "source-operation-count");
}

function sourceUnion(directory, provenance) {
  requireValid(provenance.schemaVersion === 1, "provenance-schema");
  requireValid(Array.isArray(provenance.sources), "provenance-sources");
  const releases = provenance.sources.map((source) => source.release);
  requireValid(
    releases.length === RELEASES.size && new Set(releases).size === RELEASES.size,
    "source-completeness",
  );
  const union = new Map();
  for (const source of provenance.sources)
    collectSource(loadSource(directory, source), source, union);
  return union;
}

function validateState(row) {
  requireValid(STATES.has(row.implementationState), "implementation-state");
  requireValid(AVAILABILITY.has(row.runtimeAvailability), "runtime-availability");
  requireValid(textList(row.verificationReferences), "verification-references");
  if (row.implementationState === "implemented" || row.runtimeAvailability === "executable")
    requireValid(row.verificationReferences.length > 0, "missing-verification");
  if (row.implementationState === "deferred" || row.implementationState === "excluded-by-policy")
    requireValid(nonemptyText(row.ownerDecision), "missing-owner-decision");
  requireValid(textList(row.dependencies), "dependencies");
  requireValid(
    row.dependencies.every((dependency) => Object.hasOwn(CLUSTERS, dependency)),
    "dependency-cluster",
  );
  requireValid(new Set(row.dependencies).size === row.dependencies.length, "dependency-duplicate");
  requireValid(!row.dependencies.includes(row.cluster), "dependency-cycle");
  requireValid(row.cluster === "C0" || row.dependencies.includes("C0"), "dependency-prerequisite");
}

function validateCapability(row, capabilities) {
  requireValid(textList(row.baselineCapabilityIds), "baseline-capabilities");
  for (const id of row.baselineCapabilityIds) {
    const capability = capabilities[id];
    requireValid(
      capability !== undefined && capability.identity === row.identity,
      "capability-identity",
    );
    requireValid(nonemptyText(capability.constraints), "capability-constraints");
    requireValid(
      textList(capability.sourceFiles) && capability.sourceFiles.length > 0,
      "capability-sources",
    );
  }
}

function validateRow(row, union, capabilities) {
  const expected = union.get(row.identity);
  requireValid(expected !== undefined, "unknown-operation");
  for (const key of ["method", "path", "apiRoot", "family"])
    requireValid(row[key] === expected[key], "operation-identity");
  requireValid(row.cluster === FAMILY_CLUSTER.get(expected.family), "operation-cluster");
  requireValid(
    JSON.stringify(row.sources) === JSON.stringify(expected.sources),
    "operation-provenance",
  );
  validateState(row);
  validateCapability(row, capabilities);
}

function validateLedger(ledger, union) {
  requireValid(ledger.schemaVersion === 1, "ledger-schema");
  requireValid(/^[0-9a-f]{40}$/u.test(ledger.baselineRevision), "baseline-revision");
  requireValid(Array.isArray(ledger.operations), "ledger-operations");
  const identities = ledger.operations.map((row) => row.identity);
  requireValid(
    identities.length === union.size && new Set(identities).size === union.size,
    "operation-completeness",
  );
  for (const row of ledger.operations) validateRow(row, union, ledger.baselineCapabilities);
  for (const [id, capability] of Object.entries(ledger.baselineCapabilities))
    requireValid(
      ledger.operations.some(
        (row) => row.identity === capability.identity && row.baselineCapabilityIds.includes(id),
      ),
      "orphan-capability",
    );
}

/** Tests mutate real committed inputs; the gate independently re-derives identities from sources. */
export function checkJiraApiInventory(directory = join(REPO_ROOT, INVENTORY_DIRECTORY)) {
  try {
    const provenance = readJsonFile(join(directory, "provenance.json"));
    const ledger = readJsonFile(join(directory, "operations.json"));
    const union = sourceUnion(directory, provenance);
    validateLedger(ledger, union);
    return {
      ok: true,
      operations: union.size,
      paths: new Set([...union.values()].map((entry) => entry.path)).size,
      families: new Set([...union.values()].map((entry) => entry.family)).size,
      errors: [],
    };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof InventoryValidationError ? error.message : "inventory-unreadable"],
    };
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkJiraApiInventory();
  if (result.ok) {
    console.log(
      `jira-api-inventory: PASS (${result.operations} operations, ${result.paths} paths, ${result.families} families)`,
    );
  } else {
    console.error(`jira-api-inventory: FAIL (${result.errors.join(", ")})`);
    process.exitCode = 1;
  }
}
