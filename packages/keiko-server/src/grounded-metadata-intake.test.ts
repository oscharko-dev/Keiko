import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

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
function workspaceManifestFixture(): string {
  const root = rootFixture();
  mkdirSync(join(root, "services", "api"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "recoverable-workspace", workspaces: ["services/*", "services/api"] }),
  );
  writeFileSync(join(root, "services", "api", "package.json"), '{"name":"recoverable-api"}');
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
      deniedByDiscovery: 0,
      unrepresentablePathsByDiscovery: invalidMetadataNames.length,
      incomplete: true,
      reasons: ["unrepresentable-path"],
    });
    expect(result.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
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
  const root = workspaceManifestFixture();
  const activityLog = createBufferedServerLogSink();
  const iterate = nodeWorkspaceFs.iterateDirectory;
  if (iterate === undefined) throw new TypeError("Physical iteration is required");
  let parentFailures = 0;
  let parentVisits = 0;
  const result = await retrieveConnectedContextPack(
    input(root, 20),
    deps(root, {
      activityLog,
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
  expect(
    activityLog.events.some(
      (event) => event.op === "search.connected-context.metadata-unavailable",
    ),
  ).toBe(true);
  expect(activityLog.lines().join("\n")).not.toContain(root);
  expect(result.pack.files.map((file) => file.scopePath)).toContain("services/api/package.json");
  expect(result.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
  expect(validateConnectedContextPack(result.pack).ok).toBe(true);
});

it("does not repeat explicit manifest metadata after successful wildcard coverage", async () => {
  const root = workspaceManifestFixture();
  const activityLog = createBufferedServerLogSink();
  const result = await retrieveConnectedContextPack(input(root, 20), deps(root, { activityLog }));
  expect(result.pack.files.map((file) => file.scopePath)).toEqual([
    "package.json",
    "services/api/package.json",
  ]);
  const details = activityLog.events.find(
    (event) => event.op === "search.connected-context.source-details",
  );
  expect(details?.extra?.metadataObservedCount).toBe(2);
  expect(details?.extra?.metadataRetainedCount).toBe(2);
  expect(
    activityLog.events.some(
      (event) => event.op === "search.connected-context.metadata-unavailable",
    ),
  ).toBe(false);
  expect(validateConnectedContextPack(result.pack).ok).toBe(true);
});

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "reads an explicitly declared manifest through an execute-only wildcard parent",
  async () => {
    const root = workspaceManifestFixture();
    const activityLog = createBufferedServerLogSink();
    const parent = join(root, "services");
    chmodSync(parent, 0o111);
    try {
      const result = await retrieveConnectedContextPack(
        input(root, 20),
        deps(root, { activityLog }),
      );
      expect(result.pack.files.map((file) => file.scopePath)).toContain(
        "services/api/package.json",
      );
      expect(
        result.pack.files
          .find((file) => file.scopePath === "services/api/package.json")
          ?.excerpts.map((excerpt) => excerpt.content)
          .join("\n"),
      ).toContain("recoverable-api");
      expect(result.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(
        true,
      );
      expect(
        activityLog.events.some(
          (event) =>
            event.op === "search.connected-context.metadata-unavailable" &&
            event.extra?.reason === "permission-denied",
        ),
      ).toBe(true);
      expect(activityLog.lines().join("\n")).not.toContain(root);
      expect(validateConnectedContextPack(result.pack).ok).toBe(true);
    } finally {
      chmodSync(parent, 0o755);
    }
  },
);

const manifestQuestions = [
  "Welche Paketmanifeste definieren diesen verbundenen Workspace? Nenne den Paketnamen aus jedem tatsächlich gelesenen Manifest und belege ihn mit Datei und Zeile.",
  "Which package manifests define this connected workspace? Name the package in each actually read manifest and cite its file and line.",
];
function productionDeps(
  activityLog: ReturnType<typeof createBufferedServerLogSink>,
): OrchestratorDeps {
  return {
    correlationId: undefined,
    nowMs: () => 0,
    activityLog,
    answerer: { answer: () => Promise.reject(new TypeError("No model call permitted")) },
  };
}

async function retrieveManifestQuestion(
  root: string,
  text: string,
  unavailable: boolean,
): Promise<void> {
  const activityLog = createBufferedServerLogSink();
  const request = input(root, 20);
  const result = await retrieveConnectedContextPack(
    { ...request, query: { ...request.query, text } },
    productionDeps(activityLog),
  );
  expect(result.pack.files.map((file) => file.scopePath)).toEqual([
    "package.json",
    "services/api/package.json",
  ]);
  const content = result.pack.files
    .flatMap((file) => file.excerpts.map((excerpt) => excerpt.content))
    .join("\n");
  expect(content).toContain("recoverable-workspace");
  expect(content).toContain("recoverable-api");
  expect(result.pack.usage.filesRead).toBe(2);
  expect(result.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(
    unavailable,
  );
  if (text === manifestQuestions[0])
    expect(result.pack.uncertainty.some((marker) => marker.kind === "tool-unavailable")).toBe(
      unavailable,
    );
  expect(activityLog.events.some((event) => event.op === "search.connected-context.failed")).toBe(
    false,
  );
  if (unavailable)
    expect(
      activityLog.events.some(
        (event) =>
          event.op === "search.connected-context.metadata-unavailable" &&
          event.extra?.reason === "permission-denied",
      ),
    ).toBe(true);
  expect(activityLog.lines().join("\n")).not.toContain(root);
  expect(validateConnectedContextPack(result.pack).ok).toBe(true);
}

it.each(manifestQuestions)(
  "reads declared manifests through the healthy default pipeline: %s",
  async (text) => {
    await retrieveManifestQuestion(workspaceManifestFixture(), text, false);
  },
);
it.runIf(process.platform !== "win32" && process.getuid?.() !== 0).each(manifestQuestions)(
  "reads declared manifests through the default pipeline with an execute-only subtree: %s",
  async (text) => {
    const root = workspaceManifestFixture();
    const parent = join(root, "services");
    chmodSync(parent, 0o111);
    try {
      await retrieveManifestQuestion(root, text, true);
    } finally {
      chmodSync(parent, 0o755);
    }
  },
);

it.each([
  "Where is normalize implemented?",
  "Where is normalizeEmail implemented?",
  'Where is "normalize" implemented?',
  "Why does normalizeEmail fail?",
  'Find the exact literal "Missing failure".',
  "Find isolated/missing.ts",
])("preserves explicit source selectors instead of manifest fallback: %s", async (text) => {
  const root = workspaceManifestFixture();
  const activityLog = createBufferedServerLogSink();
  const request = input(root, 20);
  const result = await retrieveConnectedContextPack(
    { ...request, query: { ...request.query, text } },
    productionDeps(activityLog),
  );
  expect(result.pack.files).toEqual([]);
  expect(
    activityLog.events.find((event) => event.op === "search.connected-context.completion-details")
      ?.extra?.scopeContextState,
  ).toBe("gate-refused");
});

it("retains a real lower-case declaration without admitting unrelated manifest context", async () => {
  const root = workspaceManifestFixture();
  writeFileSync(join(root, "worker.ts"), "export function normalize() { return 31; }\n");
  const activityLog = createBufferedServerLogSink();
  const request = input(root, 20);
  const result = await retrieveConnectedContextPack(
    { ...request, query: { ...request.query, text: "Where is normalize implemented?" } },
    productionDeps(activityLog),
  );
  expect(result.pack.files.map((file) => file.scopePath)).toEqual(["worker.ts"]);
  expect(result.pack.files[0]?.excerpts[0]?.content).toContain("return 31");
  expect(
    activityLog.events.find((event) => event.op === "search.connected-context.completion-details")
      ?.extra?.scopeContextState,
  ).toBe("gate-refused");
});

it.each([
  { path: ".", code: "EACCES" },
  { path: "../outside", code: "EACCES" },
  { path: ".ssh", code: "EACCES" },
  { path: "other", code: "EACCES" },
  { path: "services", code: "EMFILE" },
  { path: "services", code: "UNKNOWN_FAILURE" },
])(
  "propagates structural failures outside the recoverable subtree boundary: $path/$code",
  async ({ path, code }) => {
    const root = workspaceManifestFixture();
    const activityLog = createBufferedServerLogSink();
    const request = input(root, 20);
    const failure = new WorkspaceReadError("Controlled structural failure", path);
    failure.cause = Object.assign(new Error("Controlled filesystem failure"), { code });
    await expect(
      retrieveConnectedContextPack(
        {
          ...request,
          scope:
            path === "other"
              ? { ...request.scope, kind: "directory", relativePaths: ["services"] }
              : request.scope,
          query: { ...request.query, text: manifestQuestions[0] ?? "" },
        },
        {
          ...productionDeps(activityLog),
          fs: {
            ...nodeWorkspaceFs,
            readDir: (absolutePath, limit) => {
              if (absolutePath.endsWith("/services")) throw failure;
              return nodeWorkspaceFs.readDir(absolutePath, limit);
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_READ_FAILED" });
    expect(activityLog.events.some((event) => event.op === "search.connected-context.failed")).toBe(
      true,
    );
    expect(activityLog.lines().join("\n")).not.toContain(root);
  },
);

it("does not recover descendant availability when current root access is lost", async () => {
  const root = workspaceManifestFixture();
  const activityLog = createBufferedServerLogSink();
  const request = input(root, 20);
  let rootUnavailable = false;
  const unavailable = Object.assign(new Error("Controlled root refusal"), { code: "EACCES" });
  await expect(
    retrieveConnectedContextPack(
      { ...request, query: { ...request.query, text: manifestQuestions[0] ?? "" } },
      {
        ...productionDeps(activityLog),
        fs: {
          ...nodeWorkspaceFs,
          readDir: (path, limit) => {
            if (path.endsWith("/services")) rootUnavailable = true;
            if (rootUnavailable) throw unavailable;
            return nodeWorkspaceFs.readDir(path, limit);
          },
        },
      },
    ),
  ).rejects.toBe(unavailable);
  expect(activityLog.events.some((event) => event.op === "search.connected-context.failed")).toBe(
    true,
  );
});
