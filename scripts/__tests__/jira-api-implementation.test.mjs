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
const BUILDERS = `
function read(path: string, policy: string, root = "/rest/api/2"): NativeTuple {
  return ["GET", "read", path, policy, root];
}
function write(method: "POST" | "PUT" | "DELETE", path: string, policy: string, root = "/rest/api/2"): NativeTuple {
  return [method, "write", path, policy, root];
}
function issueRead(path: string, root = "/rest/api/2"): NativeTuple {
  return ["GET", "read", path, "visible-issues", root];
}`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-jira-implementation-"));
  temporary.push(directory);
  return jiraInventoryFixture(directory);
}
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("current Jira implementation accounting", () => {
  it("accounts for a closed DELETE write without allowing arbitrary methods", () => {
    const f = fixture();
    writeFileSync(
      f.registryFile,
      `${BUILDERS}\nconst NATIVE = { "jira.unvote": write("DELETE", "/issue/{issueIdOrKey}/votes", "current-user-vote-and-readback") };`,
    );
    expect(readJiraNativeRegistry(f.registryFile).entries).toEqual([
      {
        tool: "jira.unvote",
        identity: "DELETE /rest/api/2/issue/{issueIdOrKey}/votes",
        effect: "write",
        permissionPolicy: "current-user-vote-and-readback",
      },
    ]);
    writeFileSync(
      f.registryFile,
      `${BUILDERS}\nconst NATIVE = { "jira.unvote": write("PATCH", "/issue/{issueIdOrKey}/votes", "current-user-vote-and-readback") };`,
    );
    expect(() => readJiraNativeRegistry(f.registryFile)).toThrow("registry-native-effect");
  });
  it("accounts for issue reads with their fixed permission policy and literal API root", () => {
    const f = fixture();
    writeFileSync(
      f.registryFile,
      `${BUILDERS}\nconst NATIVE = {
      "jira.issue": issueRead("/issue/{issueIdOrKey}"),
      "jira.sprint-issues": issueRead("/sprint/{sprintId}/issue", "/rest/agile/1.0")
    };`,
    );
    expect(readJiraNativeRegistry(f.registryFile).entries).toEqual([
      {
        tool: "jira.issue",
        identity: "GET /rest/api/2/issue/{issueIdOrKey}",
        effect: "read",
        permissionPolicy: "visible-issues",
      },
      {
        tool: "jira.sprint-issues",
        identity: "GET /rest/agile/1.0/sprint/{sprintId}/issue",
        effect: "read",
        permissionPolicy: "visible-issues",
      },
    ]);
  });
  it("accounts for verified closed builders and literal tuples without executing either", () => {
    const f = fixture();
    writeFileSync(
      f.registryFile,
      `${BUILDERS}\nconst NATIVE = {
      "jira.projects": read("/project", "visible-projects"),
      "jira.boards": read("/board", "visible-boards", "/rest/agile/1.0"),
      "jira.create": write("POST", "/issue", "create-and-readback"),
      "jira.edit": write("PUT", "/issue/{id}", "edit-and-readback"),
      "jira.legacy": ["GET", "read", "/legacy", "visible-legacy"]
    };`,
    );
    expect(readJiraNativeRegistry(f.registryFile).entries).toEqual([
      {
        tool: "jira.boards",
        identity: "GET /rest/agile/1.0/board",
        effect: "read",
        permissionPolicy: "visible-boards",
      },
      {
        tool: "jira.create",
        identity: "POST /rest/api/2/issue",
        effect: "write",
        permissionPolicy: "create-and-readback",
      },
      {
        tool: "jira.edit",
        identity: "PUT /rest/api/2/issue/{id}",
        effect: "write",
        permissionPolicy: "edit-and-readback",
      },
      {
        tool: "jira.legacy",
        identity: "GET /rest/api/2/legacy",
        effect: "read",
        permissionPolicy: "visible-legacy",
      },
      {
        tool: "jira.projects",
        identity: "GET /rest/api/2/project",
        effect: "read",
        permissionPolicy: "visible-projects",
      },
    ]);
  });
  it.each([
    [BUILDERS.replace('"GET", "read"', '"POST", "read"'), 'read("/project", "visible-projects")'],
    [BUILDERS.replace('"GET", "read"', '"GET", "write"'), 'read("/project", "visible-projects")'],
    [
      BUILDERS.replace("path, policy, root", "policy, path, root"),
      'read("/project", "visible-projects")',
    ],
    [
      BUILDERS.replace('root = "/rest/api/2"', 'root = "/rest/api/3"'),
      'read("/project", "visible-projects")',
    ],
    [
      BUILDERS.replace('root = "/rest/api/2"', "root = globalThis.untrusted()"),
      'read("/project", "visible-projects")',
    ],
    [
      BUILDERS.replace('return ["GET"', 'globalThis.untrusted(); return ["GET"'),
      'read("/project", "visible-projects")',
    ],
    [
      BUILDERS.replace("function read", "async function read"),
      'read("/project", "visible-projects")',
    ],
    [
      BUILDERS.replace("path: string, policy", 'path: string = "/other", policy'),
      'read("/project", "visible-projects")',
    ],
    [
      BUILDERS + '\nfunction read(a,b,c) { return ["GET","read",a,b,c]; }',
      'read("/project", "visible-projects")',
    ],
    [BUILDERS + "\nread = globalThis.untrusted;", 'read("/project", "visible-projects")'],
    [BUILDERS, 'read(globalThis.untrusted(), "visible-projects")'],
    [BUILDERS, 'read("/project")'],
    [BUILDERS, 'read("/project", "visible-projects", "/rest/api/2", "extra")'],
    [BUILDERS, 'globalThis.read("/project", "visible-projects")'],
    [BUILDERS, 'other("/project", "visible-projects")'],
    [BUILDERS.replace('method, "write"', '"GET", "write"'), 'write("POST", "/issue", "create")'],
    [BUILDERS.replace('method, "write"', 'method, "read"'), 'write("POST", "/issue", "create")'],
    [
      BUILDERS.replace('path, "visible-issues", root', 'path, "other-policy", root'),
      'issueRead("/issue")',
    ],
    [
      BUILDERS.replace('path, "visible-issues", root', 'root, "visible-issues", path'),
      'issueRead("/issue")',
    ],
    [
      BUILDERS.replace(
        '"GET", "read", path, "visible-issues"',
        '"POST", "read", path, "visible-issues"',
      ),
      'issueRead("/issue")',
    ],
    [BUILDERS + "\nissueRead = globalThis.untrusted;", 'issueRead("/issue")'],
    [BUILDERS, 'issueRead("/issue", "/rest/api/3")'],
    [BUILDERS, 'issueRead("/issue", "/rest/api/2", "extra")'],
  ])("refuses changed builder semantics and nonliteral calls (%#)", (builders, call) => {
    const f = fixture();
    writeFileSync(f.registryFile, `${builders}\nconst NATIVE = { "jira.projects": ${call} };`);
    expect(() => readJiraNativeRegistry(f.registryFile)).toThrow(/registry-native-/u);
  });
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
