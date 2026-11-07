import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkJiraApiInventory } from "../check-jira-api-inventory.mjs";
import { jiraInventoryFixture } from "./jira-api-inventory.fixture.mjs";
import { jiraApiManifestDigest, jiraApiSourcePath } from "../lib/jira-api-sources.mjs";

const INVENTORY = new URL("../../docs/local-knowledge/jira-api-coverage/", import.meta.url);
const temporary = [];

function copyInventory() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-jira-api-inventory-"));
  temporary.push(directory);
  cpSync(INVENTORY, directory, { recursive: true });
  return directory;
}

function changeJson(directory, filename, mutate) {
  const path = join(directory, filename);
  const document = JSON.parse(readFileSync(path, "utf8"));
  mutate(document);
  writeFileSync(path, JSON.stringify(document));
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Jira API inventory provenance and completeness", () => {
  it("checks committed factual accounting offline without requiring original source bytes", () => {
    expect(checkJiraApiInventory()).toEqual({
      ok: true,
      verification: "ledger",
      operations: 439,
      paths: 291,
      families: 67,
      errors: [],
    });
  });

  it.each([
    ["missing operation", (ledger) => ledger.operations.pop(), "operation-completeness"],
    [
      "duplicate operation",
      (ledger) => {
        ledger.operations[0] = ledger.operations[1];
      },
      "operation-completeness",
    ],
    [
      "invented path",
      (ledger) => {
        ledger.operations[0].identity = "GET /rest/api/2/not-published";
      },
      "operation-identity",
    ],
    [
      "method drift",
      (ledger) => {
        ledger.operations[0].method = "GET";
      },
      "operation-identity",
    ],
    [
      "wrong cluster",
      (ledger) => {
        ledger.operations[0].cluster = "C11";
      },
      "operation-cluster",
    ],
    [
      "dropped prerequisite",
      (ledger) => {
        ledger.operations[0].dependencies = [];
      },
      "dependency-prerequisite",
    ],
    [
      "fabricated state",
      (ledger) => {
        ledger.operations[0].implementationState = "complete";
      },
      "implementation-state",
    ],
    [
      "unsupported completion",
      (ledger) => {
        ledger.operations[0].implementationState = "implemented";
      },
      "missing-verification",
    ],
    [
      "unsupported availability",
      (ledger) => {
        ledger.operations[0].runtimeAvailability = "executable";
      },
      "missing-verification",
    ],
    [
      "unapproved exclusion",
      (ledger) => {
        ledger.operations[0].implementationState = "excluded-by-policy";
      },
      "missing-owner-decision",
    ],
    [
      "missing source version",
      (ledger) => ledger.operations[0].sources.pop(),
      "operation-provenance",
    ],
    [
      "rewritten operationId",
      (ledger) => {
        ledger.operations[0].sources[0].operationId = "invented";
      },
      "operation-provenance",
    ],
  ])("rejects %s instead of silently reducing or overstating coverage", (_name, mutate, error) => {
    const directory = copyInventory();
    changeJson(directory, "operations.json", mutate);
    expect(checkJiraApiInventory(directory)).toEqual({ ok: false, errors: [error] });
  });

  it("does not identify different operations by a colliding upstream operationId", () => {
    const directory = copyInventory();
    changeJson(directory, "operations.json", (ledger) => {
      const collisions = ledger.operations.filter((row) =>
        row.sources.some((source) => source.operationId === "getIssue"),
      );
      ledger.operations = ledger.operations.filter(
        (row) => row.identity !== collisions[0].identity,
      );
    });
    expect(checkJiraApiInventory(directory).errors).toEqual(["operation-completeness"]);
  });

  it("retains version-specific IDs when upstream renumbers the same avatar operation", () => {
    const directory = copyInventory();
    changeJson(directory, "operations.json", (ledger) => {
      const row = ledger.operations.find((operation) =>
        operation.sources.some((source) => source.operationId !== operation.sources[0].operationId),
      );
      expect(row).toBeDefined();
      for (const source of row.sources) source.operationId = row.sources[0].operationId;
    });
    expect(checkJiraApiInventory(directory).errors).toEqual(["operation-provenance"]);
  });

  it("refuses a constrained tool mapping copied onto an unrelated operation", () => {
    const directory = copyInventory();
    changeJson(directory, "operations.json", (ledger) => {
      ledger.operations[0].baselineCapabilityIds = ["projects"];
    });
    expect(checkJiraApiInventory(directory).errors).toEqual(["capability-identity"]);
  });

  it("refuses a removed source even when the remaining releases describe most operations", () => {
    const directory = copyInventory();
    changeJson(directory, "provenance.json", (provenance) => provenance.sources.pop());
    expect(checkJiraApiInventory(directory).errors).toEqual(["source-completeness"]);
  });

  it("reconciles explicitly provisioned originals independently of the normalized digest", () => {
    const fixture = jiraInventoryFixture(copyInventory());
    expect(
      checkJiraApiInventory(fixture.directory, {
        reconcileSources: true,
        cacheDirectory: fixture.cacheDirectory,
        registryFile: fixture.registryFile,
      }),
    ).toMatchObject({ ok: true, verification: "sources", operations: 2, families: 2 });
  });

  it("fails explicit reconciliation when no originals have been provisioned", () => {
    const fixture = jiraInventoryFixture(copyInventory(), { cacheSources: false });
    expect(
      checkJiraApiInventory(fixture.directory, { registryFile: fixture.registryFile }).ok,
    ).toBe(true);
    expect(
      checkJiraApiInventory(fixture.directory, {
        reconcileSources: true,
        cacheDirectory: fixture.cacheDirectory,
        registryFile: fixture.registryFile,
      }).ok,
    ).toBe(false);
  });

  it("detects source disagreement even when an edited normalized manifest has a matching digest", () => {
    const fixture = jiraInventoryFixture(copyInventory());
    fixture.ledger.operations[0].sources = structuredClone(fixture.ledger.operations[0].sources);
    fixture.ledger.operations[0].sources[0].operationId = "changedAfterCapture";
    fixture.provenance.manifest.sha256 = jiraApiManifestDigest(fixture.ledger.operations);
    writeFileSync(join(fixture.directory, "operations.json"), JSON.stringify(fixture.ledger));
    writeFileSync(join(fixture.directory, "provenance.json"), JSON.stringify(fixture.provenance));
    expect(
      checkJiraApiInventory(fixture.directory, { registryFile: fixture.registryFile }).ok,
    ).toBe(true);
    expect(
      checkJiraApiInventory(fixture.directory, {
        reconcileSources: true,
        cacheDirectory: fixture.cacheDirectory,
        registryFile: fixture.registryFile,
      }).errors,
    ).toEqual(["operation-provenance"]);
  });

  it("refuses altered cached bytes even when valid JSON preserves the operation count", () => {
    const fixture = jiraInventoryFixture(copyInventory());
    const source = fixture.provenance.sources[0];
    const path = jiraApiSourcePath(fixture.cacheDirectory, source);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("fixture-10.3", "fixture-10.4"));
    expect(
      checkJiraApiInventory(fixture.directory, {
        reconcileSources: true,
        cacheDirectory: fixture.cacheDirectory,
        registryFile: fixture.registryFile,
      }).errors,
    ).toEqual(["source-digest"]);
  });

  it("rejects a source-supplied path instead of reading outside the fixed cache", () => {
    const directory = copyInventory();
    changeJson(directory, "provenance.json", (provenance) => {
      provenance.sources[0].file = "../../../../package.json";
    });
    expect(checkJiraApiInventory(directory).errors).toEqual(["source-fields"]);
  });

  it("fails closed on unreadable inventory data", () => {
    const directory = copyInventory();
    writeFileSync(join(directory, "operations.json"), "{");
    expect(checkJiraApiInventory(directory)).toEqual({
      ok: false,
      errors: ["inventory-unreadable"],
    });
  });
});
