// Authored test documents, not copied Atlassian schemas or responses.
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { sha256 } from "../lib/digest.mjs";
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

export function jiraInventoryFixture(directory, { cacheSources = true } = {}) {
  const provenance = JSON.parse(readFileSync(PROVENANCE, "utf8"));
  const sourceBytes = new Map();
  const cacheDirectory = join(directory, "cache");
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
    schemaVersion: 1,
    baselineRevision: "1".repeat(40),
    baselineCapabilities: {},
    operations,
  };
  writeFileSync(join(directory, "provenance.json"), JSON.stringify(provenance));
  writeFileSync(join(directory, "operations.json"), JSON.stringify(ledger));
  return { directory, provenance, ledger, cacheDirectory, sourceBytes };
}
