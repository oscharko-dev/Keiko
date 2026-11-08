#!/usr/bin/env node
// Offline provenance and completeness gate for the Jira Software Data Center inventory (#4287).
// Public specification bytes are inputs to coverage accounting, never executable HTTP authority.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "./lib/json.mjs";
import {
  JIRA_REGISTRY_FILE,
  readJiraNativeRegistry,
  validateJiraImplementation,
} from "./lib/jira-api-implementation.mjs";
import {
  JiraApiInventoryError,
  jiraApiManifestDigest,
  readJiraApiSource,
  requireJiraInventory as requireValid,
  validateJiraApiProvenance,
} from "./lib/jira-api-sources.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_DIRECTORY = "docs/local-knowledge/jira-api-coverage";
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

function nonemptyText(value) {
  return typeof value === "string" && value.length > 0;
}

function textList(value) {
  return Array.isArray(value) && value.every(nonemptyText);
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

function sourceUnion(cacheDirectory, provenance) {
  const union = new Map();
  for (const source of provenance.sources)
    collectSource(readJiraApiSource(cacheDirectory, source), source, union);
  return union;
}

function normalizedUnion(ledger, provenance) {
  requireValid(Array.isArray(ledger.operations), "ledger-operations");
  const union = new Map();
  const releases = new Set(provenance.sources.map((source) => source.release));
  for (const row of ledger.operations) {
    requireValid(typeof row.identity === "string", "operation-identity");
    const [method, path, extra] = row.identity.split(" ");
    const root = ROOTS.find((candidate) => path?.startsWith(`/rest${candidate}`));
    requireValid(
      extra === undefined && METHODS.has(method.toLowerCase()) && root !== undefined,
      "operation-identity",
    );
    requireValid(Array.isArray(row.sources) && row.sources.length > 0, "operation-provenance");
    requireValid(
      row.sources.every(
        (source) => releases.has(source.release) && nonemptyText(source.operationId),
      ),
      "operation-provenance",
    );
    requireValid(
      new Set(row.sources.map((source) => source.release)).size === row.sources.length,
      "operation-provenance",
    );
    union.set(row.identity, {
      method,
      path,
      apiRoot: `/rest${root.slice(0, -1)}`,
      family: path.slice(`/rest${root}`.length).split("/")[0],
      sources: row.sources,
    });
  }
  requireValid(
    ledger.operations.length === provenance.manifest.operationCount &&
      union.size === provenance.manifest.operationCount,
    "operation-completeness",
  );
  return union;
}

function validateManifest(ledger, provenance, union) {
  const entries = [...union.values()];
  requireValid(
    new Set(entries.map((entry) => entry.path)).size === provenance.manifest.pathCount,
    "manifest-path-count",
  );
  requireValid(
    new Set(entries.map((entry) => entry.family)).size === provenance.manifest.familyCount,
    "manifest-family-count",
  );
  requireValid(
    jiraApiManifestDigest(ledger.operations) === provenance.manifest.sha256,
    "operation-provenance",
  );
  for (const source of provenance.sources) {
    const rows = ledger.operations.filter((row) =>
      row.sources.some((reference) => reference.release === source.release),
    );
    requireValid(rows.length === source.operationCount, "source-operation-count");
    requireValid(
      new Set(rows.map((row) => row.path)).size === source.pathCount,
      "source-path-count",
    );
  }
}

function validateState(row) {
  requireValid(STATES.has(row.implementationState), "implementation-state");
  requireValid(AVAILABILITY.has(row.runtimeAvailability), "runtime-availability");
  requireValid(textList(row.verificationReferences), "verification-references");
  if (row.implementationState === "implemented" || row.runtimeAvailability !== "unknown")
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
  requireValid(ledger.schemaVersion === 2, "ledger-schema");
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

/** The default is offline ledger integrity; explicit source reconciliation reads verified cache bytes. */
export function checkJiraApiInventory(
  directory = join(REPO_ROOT, INVENTORY_DIRECTORY),
  {
    reconcileSources = false,
    cacheDirectory = join(REPO_ROOT, ".jira-api-sources"),
    registryFile = JIRA_REGISTRY_FILE,
  } = {},
) {
  try {
    const provenance = readJsonFile(join(directory, "provenance.json"));
    const ledger = readJsonFile(join(directory, "operations.json"));
    validateJiraApiProvenance(provenance);
    const normalized = normalizedUnion(ledger, provenance);
    const union = reconcileSources ? sourceUnion(cacheDirectory, provenance) : normalized;
    validateLedger(ledger, union);
    validateManifest(ledger, provenance, union);
    validateJiraImplementation(ledger, readJiraNativeRegistry(registryFile));
    return {
      ok: true,
      verification: reconcileSources ? "sources" : "ledger",
      operations: union.size,
      paths: new Set([...union.values()].map((entry) => entry.path)).size,
      families: new Set([...union.values()].map((entry) => entry.family)).size,
      errors: [],
    };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof JiraApiInventoryError ? error.message : "inventory-unreadable"],
    };
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const result = args.every((arg) => arg === "--sources")
    ? checkJiraApiInventory(undefined, { reconcileSources: args.includes("--sources") })
    : { ok: false, errors: ["invalid-arguments"] };
  if (result.ok) {
    console.log(
      `jira-api-inventory: PASS ${result.verification} (${result.operations} operations, ${result.paths} paths, ${result.families} families)`,
    );
  } else {
    console.error(`jira-api-inventory: FAIL (${result.errors.join(", ")})`);
    process.exitCode = 1;
  }
}
