import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readJiraNativeRegistry,
  reconcileJiraImplementation,
  validateJiraImplementation,
} from "../lib/jira-api-implementation.mjs";
import { jiraInventoryFixture } from "./jira-api-inventory.fixture.mjs";

const temporary = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-jira-implementation-"));
  temporary.push(directory);
  return jiraInventoryFixture(directory);
}
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("current Jira implementation accounting", () => {
  it("reads closed native identities from literal source without importing the runtime", () => {
    const f = fixture();
    const registry = readJiraNativeRegistry(f.registryFile);
    expect(registry.entries).toEqual([
      {
        tool: "jira.boards",
        identity: "GET /rest/agile/1.0/board",
        effect: "read",
        permissionPolicy: "visible-boards",
      },
      {
        tool: "jira.projects",
        identity: "GET /rest/api/2/project",
        effect: "read",
        permissionPolicy: "visible-projects",
      },
    ]);
    expect(registry.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ["const NATIVE = globalThis.untrusted();", "registry-native-shape"],
    [
      'const NATIVE = { "jira.projects": ["GET", "read", globalThis.untrusted(), "visible-projects"] };',
      "registry-native-tuple",
    ],
    ["const NATIVE = { ...globalThis.untrusted() };", "registry-native-property"],
    [
      'const NATIVE = { "jira.projects": ["GET", "read", "/project", "visible-projects", "/rest/api/3"] };',
      "registry-native-path",
    ],
    [
      'const NATIVE = { "jira.projects": ["GET", "read", "/project", "visible-projects"], "jira.projects": ["POST", "write", "/project", "create"] };',
      "registry-native-duplicate",
    ],
  ])("refuses unsupported registry syntax without evaluating it (%s)", (source, reason) => {
    const f = fixture();
    writeFileSync(f.registryFile, source);
    expect(() => readJiraNativeRegistry(f.registryFile)).toThrow(reason);
  });

  it("preserves baseline, dependencies, source IDs and qualification while refreshing implementation", () => {
    const f = fixture();
    const before = structuredClone(f.ledger);
    before.operations[0].implementationState = "not-implemented";
    before.operations[0].runtimeAvailability = "denied";
    before.operations[0].verificationReferences = ["historical-fixture-only"];
    const reconciled = reconcileJiraImplementation(before, readJiraNativeRegistry(f.registryFile));
    expect(before.operations[0].implementationState).toBe("not-implemented");
    expect(reconciled.baselineRevision).toBe(before.baselineRevision);
    expect(reconciled.baselineCapabilities).toEqual(before.baselineCapabilities);
    expect(reconciled.operations[0]).toEqual({
      ...before.operations[0],
      currentCapabilityIds: ["jira.projects"],
      implementationState: "partial",
    });
    expect(reconciled.operations[1]).toEqual(before.operations[1]);
    expect(reconciled.operations.some((row) => row.implementationState === "implemented")).toBe(
      false,
    );
  });

  it.each([
    [
      (ledger) => {
        delete ledger.currentCapabilities["jira.boards"];
      },
      "current-capability-completeness",
    ],
    [
      (ledger) => {
        ledger.currentRegistry.sha256 = "f".repeat(64);
      },
      "current-registry-drift",
    ],
    [
      (ledger) => {
        ledger.currentCapabilities["jira.projects"].identity = "POST /rest/api/2/project";
      },
      "current-capability-drift",
    ],
    [
      (ledger) => {
        ledger.currentCapabilities["jira.projects"].constraints = "";
      },
      "current-capability-constraints",
    ],
    [
      (ledger) => {
        ledger.currentCapabilities["jira.projects"].sourceFiles = ["../outside.ts"];
      },
      "current-capability-path",
    ],
    [
      (ledger) => {
        ledger.operations[0].currentCapabilityIds = [];
      },
      "current-operation-mapping",
    ],
    [
      (ledger) => {
        ledger.operations[0].implementationState = "not-implemented";
      },
      "current-implementation-state",
    ],
  ])("refuses stale or unsupported current mapping (%#)", (mutate, reason) => {
    const f = fixture();
    mutate(f.ledger);
    expect(() =>
      validateJiraImplementation(f.ledger, readJiraNativeRegistry(f.registryFile)),
    ).toThrow(reason);
  });

  it("refuses an unpublished native identity instead of increasing the source denominator", () => {
    const f = fixture();
    const source = readFileSync(f.registryFile, "utf8").replace('"/project"', '"/not-published"');
    writeFileSync(f.registryFile, source);
    expect(() =>
      reconcileJiraImplementation(f.ledger, readJiraNativeRegistry(f.registryFile)),
    ).toThrow("registry-operation-not-published");
  });

  it("notices a registry source revision even when native identities have not changed", () => {
    const f = fixture();
    const source = readFileSync(f.registryFile, "utf8");
    writeFileSync(f.registryFile, `// revised registry contract owner\n${source}`);
    expect(() =>
      validateJiraImplementation(f.ledger, readJiraNativeRegistry(f.registryFile)),
    ).toThrow("current-registry-drift");
  });
});
