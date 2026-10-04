import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import { WorkspaceReadError } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  retrieveConnectedContextPack,
  type OrchestratorInput,
  type OrchestratorDeps,
} from "./grounded-orchestrator.js";

const roots: string[] = [];
const invalidMetadataNames = [
  "~x.csproj",
  ...(process.platform === "win32" ? [] : ["x\\y.csproj", "C:old.csproj"]),
];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-metadata-intake-"));
  roots.push(root);
  return root;
}
function input(root: string, maxResults = 1): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "metadata-intake",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 0,
      conversationId: undefined,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: "Which package manifests define this workspace?",
      caseSensitive: false,
      maxResults,
      emittedAtMs: 0,
    },
  };
}
function deps(root: string, overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    correlationId: undefined,
    nowMs: () => 0,
    answerer: {
      answer: (): Promise<never> => Promise.reject(new TypeError("No model call permitted")),
    },
    detectWorkspace: () => ({
      root,
      selectedRoot: root,
      name: "fixture",
      version: "0",
      testFramework: "vitest",
      sourceDirs: [],
      testDirs: [],
      languages: ["typescript"],
      ignoreLines: [],
    }),
    ...overrides,
  };
}

describe("metadata admission before retention", () => {
  it("completes natural workspace retrieval with unsupported portable filename siblings", async () => {
    const root = rootFixture();
    writeFileSync(join(root, "package.json"), "{}");
    for (const name of invalidMetadataNames) writeFileSync(join(root, name), "<Project/>");
    const result = await retrieveConnectedContextPack(input(root), deps(root));
    expect(validateConnectedContextPack(result.pack).ok).toBe(true);
    expect(result.pack.files.map((file) => file.scopePath)).toEqual(["package.json"]);
    expect(result.pack.usage.filesRead).toBe(1);
    expect(result.pack.diagnostics?.coverage).toMatchObject({
      filesDiscovered: 1,
      deniedByDiscovery: invalidMetadataNames.length,
      incomplete: false,
    });
    expect(result.pack.omitted).toEqual([]);
  });

  it("does not retain or count sibling manifests outside an explicit files selection", async () => {
    const root = rootFixture();
    const selected: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const directory = `d${String(index)}`;
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, "selected.ts"), "// selected source\n");
      writeFileSync(join(root, directory, "package.json"), "{}");
      selected.push(`${directory}/selected.ts`);
    }
    const request = input(root);
    let siblingStatCalls = 0;
    const result = await retrieveConnectedContextPack(
      { ...request, scope: { ...request.scope, kind: "files", relativePaths: selected } },
      deps(root, {
        fs: {
          ...nodeWorkspaceFs,
          stat: (path) => {
            if (path.endsWith("/package.json")) siblingStatCalls += 1;
            return nodeWorkspaceFs.stat(path);
          },
        },
      }),
    );
    expect(siblingStatCalls).toBe(0);
    expect(validateConnectedContextPack(result.pack).ok).toBe(true);
    expect(result.pack.files.map((file) => file.scopePath)).toEqual(selected);
    expect(result.pack.usage.filesRead).toBe(4);
    expect(result.pack.omitted.some((entry) => entry.scopePath.endsWith("package.json"))).toBe(
      false,
    );
    expect(
      result.pack.uncertainty.some((marker) =>
        marker.claim.includes("observed manifest candidates"),
      ),
    ).toBe(false);
  });

  it.each(["", "packages/service"])(
    "rejects invalid portable metadata names before retention in %s",
    async (directory) => {
      const root = rootFixture();
      mkdirSync(join(root, directory), { recursive: true });
      const manifest = directory.length === 0 ? "package.json" : `${directory}/package.json`;
      writeFileSync(join(root, manifest), "{}");
      for (const name of invalidMetadataNames)
        writeFileSync(join(root, directory, name), "<Project/>");
      const request = input(root);
      const result = await retrieveConnectedContextPack(
        { ...request, scope: { ...request.scope, kind: "files", relativePaths: [manifest] } },
        deps(root),
      );
      expect(validateConnectedContextPack(result.pack).ok).toBe(true);
      expect(result.pack.files.map((file) => file.scopePath)).toEqual([manifest]);
      expect(result.pack.omitted).toEqual([]);
      expect(
        result.pack.uncertainty.some((marker) =>
          marker.claim.includes("observed manifest candidates"),
        ),
      ).toBe(false);
    },
  );

  it("retains an explicitly selected manifest and legitimate selected-folder metadata", async () => {
    const root = rootFixture();
    mkdirSync(join(root, "project"));
    writeFileSync(join(root, "project", "package.json"), '{"name":"selected"}');
    const request = input(root);
    for (const [kind, relativePaths] of [
      ["files", ["project/package.json"]],
      ["directory", ["project"]],
    ] as const) {
      const result = await retrieveConnectedContextPack(
        { ...request, scope: { ...request.scope, kind, relativePaths } },
        deps(root),
      );
      expect(validateConnectedContextPack(result.pack).ok).toBe(true);
      expect(result.pack.files.map((file) => file.scopePath)).toEqual(["project/package.json"]);
    }
  });

  it("does not admit denied paths or a symlinked manifest outside the selected root", async () => {
    const root = rootFixture();
    const outside = rootFixture();
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(outside, "outside.csproj"), "<Project/>");
    symlinkSync(join(outside, "outside.csproj"), join(root, "linked.csproj"));
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "secret.csproj"), "private");
    const result = await retrieveConnectedContextPack(input(root, 20), deps(root));
    expect(validateConnectedContextPack(result.pack).ok).toBe(true);
    expect(result.pack.files.map((file) => file.scopePath)).toEqual(["package.json"]);
    expect(result.pack.omitted.map((entry) => entry.scopePath)).not.toContain("linked.csproj");
    expect(JSON.stringify(result.pack)).not.toContain("private");
  });
});

it("still probes an explicit workspace manifest after wildcard-parent enumeration fails", async () => {
  const root = rootFixture();
  mkdirSync(join(root, "services", "api"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["services/*", "services/api"] }),
  );
  writeFileSync(join(root, "services", "api", "package.json"), '{"name":"recoverable-api"}');
  const iterate = nodeWorkspaceFs.iterateDirectory;
  if (iterate === undefined) throw new TypeError("Physical iteration is required");
  let parentFailures = 0;
  let parentVisits = 0;
  const result = await retrieveConnectedContextPack(
    input(root, 20),
    deps(root, {
      fs: {
        ...nodeWorkspaceFs,
        iterateDirectory: async function* (path) {
          if (path.endsWith("/services") && ++parentVisits > 1) {
            parentFailures += 1;
            throw new WorkspaceReadError("controlled parent enumeration failure", "services");
          }
          yield* iterate(path);
        },
      },
    }),
  );
  expect(parentFailures).toBeGreaterThan(0);
  expect(result.pack.files.map((file) => file.scopePath)).toContain("services/api/package.json");
  expect(result.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
  expect(validateConnectedContextPack(result.pack).ok).toBe(true);
});
