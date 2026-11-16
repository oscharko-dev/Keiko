// Authored test documents, not copied Atlassian schemas or responses.
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { sha256 } from "../lib/digest.mjs";
import {
  readJiraNativeRegistry,
  reconcileJiraImplementation,
  JIRA_REGISTRY_SOURCE,
} from "../lib/jira-api-implementation.mjs";
import { jiraApiManifestDigest, jiraApiSourcePath } from "../lib/jira-api-sources.mjs";

const PROVENANCE = new URL(
  "../../docs/local-knowledge/jira-api-coverage/provenance.json",
  import.meta.url,
);

function operation(path, family, cluster, sources) {
  const apiRoot = family === "project" ? "/rest/api/2" : "/rest/agile/1.0";
  return {
    identity: `GET ${path}`,
    method: "GET",
    path,
    apiRoot,
    family,
    cluster,
    dependencies: ["C0"],
    sources,
    baselineCapabilityIds: [],
    implementationState: "not-implemented",
    runtimeAvailability: "unknown",
    verificationReferences: [],
  };
}

function reference({ release }) {
  return { release, operationId: release === "10.3" ? "fixtureRead" : "fixtureReadRenamed" };
}

function sourceFixtures(provenance, cacheDirectory, cacheSources) {
  const sourceBytes = new Map();
  for (const source of provenance.sources) {
    const operationId = source.release === "10.3" ? "fixtureRead" : "fixtureReadRenamed";
    const spec = {
      info: { version: `fixture-${source.release}` },
      paths: {
        "/api/2/project": { get: { operationId } },
        "/agile/1.0/board": { get: { operationId } },
      },
      components: { schemas: { AuthoredFixture: { type: "object" } } },
    };
    const bytes = Buffer.from(JSON.stringify(spec));
    Object.assign(source, {
      sha256: sha256(bytes),
      bytes: bytes.length,
      infoVersion: spec.info.version,
      operationCount: 2,
      pathCount: 2,
      schemaCount: 1,
    });
    sourceBytes.set(source.url, bytes);
    if (cacheSources) {
      mkdirSync(join(cacheDirectory, source.release), { recursive: true });
      writeFileSync(jiraApiSourcePath(cacheDirectory, source), bytes);
    }
  }
  return sourceBytes;
}

export function jiraInventoryFixture(directory, { cacheSources = true } = {}) {
  const provenance = JSON.parse(readFileSync(PROVENANCE, "utf8"));
  const cacheDirectory = join(directory, "cache");
  const sourceBytes = sourceFixtures(provenance, cacheDirectory, cacheSources);
  const sources = provenance.sources.map(reference);
  const operations = [
    operation("/rest/api/2/project", "project", "C1", sources),
    operation("/rest/agile/1.0/board", "board", "C2", sources),
  ];
  provenance.manifest = {
    sha256: jiraApiManifestDigest(operations),
    operationCount: 2,
    pathCount: 2,
    familyCount: 2,
  };
  const ledger = {
    schemaVersion: 2,
    baselineRevision: "1".repeat(40),
    baselineCapabilities: {},
    currentCapabilities: Object.fromEntries(
      ["jira.projects", "jira.boards"].map((tool) => [
        tool,
        {
          constraints: "Authored constrained fixture only; no runtime qualification.",
          sourceFiles: [JIRA_REGISTRY_SOURCE],
          testFiles: ["scripts/__tests__/check-jira-api-inventory.test.mjs"],
        },
      ]),
    ),
    operations,
  };
  const registryFile = join(directory, "registry.ts");
  writeFileSync(
    registryFile,
    `const NATIVE = {
    "jira.projects": ["GET", "read", "/project", "visible-projects"],
    "jira.boards": ["GET", "read", "/board", "visible-boards", "/rest/agile/1.0"],
  };`,
  );
  const reconciled = reconcileJiraImplementation(ledger, readJiraNativeRegistry(registryFile));
  writeFileSync(join(directory, "provenance.json"), JSON.stringify(provenance));
  writeFileSync(join(directory, "operations.json"), JSON.stringify(reconciled));
  return { directory, provenance, ledger: reconciled, cacheDirectory, sourceBytes, registryFile };
}
