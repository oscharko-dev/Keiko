import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { createMicroIndex, type MicroIndex } from "@oscharko-dev/keiko-workflows";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { WorkspaceReadError } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  retrieveConnectedContextPack,
  type OrchestratorDeps,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function physicalRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-metadata-cache-"));
  roots.push(root);
  return root;
}

function request(root: string, text: string, maxResults = 20): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "metadata-cache",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 0,
      conversationId: undefined,
      explicitConnection: true,
    },
    query: { kind: "natural-language", text, caseSensitive: false, maxResults, emittedAtMs: 0 },
  };
}

function dependencies(root: string, overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    correlationId: undefined,
    nowMs: () => 0,
    answerer: {
      answer: (): Promise<never> => Promise.reject(new TypeError("No model call is permitted.")),
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

function manifestCorpus(root: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const dir = join(root, "packages", `service-${String(index).padStart(3, "0")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: `service-${String(index)}`, notes: "x".repeat(4000) }),
    );
  }
  writeFileSync(join(root, "overview.ts"), "// Package manifests define this workspace.\n");
}

describe("metadata retention and pre-read cache identity", () => {
  it("invalidates cached output when only metadata enumeration uncertainty changes", async () => {
    const root = physicalRoot();
    mkdirSync(join(root, "optional"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["optional/*"] }));
    writeFileSync(join(root, "overview.ts"), "// Package manifests define this workspace.\n");
    writeFileSync(join(root, "noise.txt"), "ordinary prose ".repeat(12_000));
    const iterate = nodeWorkspaceFs.iterateDirectory;
    if (iterate === undefined) throw new TypeError("Physical iteration is required.");
    let visits = 0;
    let failMetadata = false;
    const microIndex = createMicroIndex({ ttlMs: 60_000, maxEntries: 8, nowMs: () => 0 });
    const deps = dependencies(root, {
      microIndex,
      fs: {
        ...nodeWorkspaceFs,
        iterateDirectory: async function* (path) {
          if (path.endsWith("/optional") && ++visits > 1 && failMetadata)
            throw new WorkspaceReadError("controlled metadata failure", "optional");
          yield* iterate(path);
        },
      },
    });
    const input = request(root, "Which package manifests define this workspace?");
    const first = await retrieveConnectedContextPack(input, deps);
    expect(first.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(false);
    visits = 0;
    failMetadata = true;
    const second = await retrieveConnectedContextPack(input, deps);
    expect(second.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(true);
    expect(second.pack.diagnostics?.coverage?.incomplete).toBe(false);
  });
  it("never inserts an assembled pack after caller cancellation during reranking", async () => {
    const root = physicalRoot();
    writeFileSync(join(root, "fact.txt"), "CacheCancelProbe CAUSAL_VALUE\n");
    const controller = new AbortController();
    const microIndex = createMicroIndex({ ttlMs: 60_000, maxEntries: 8, nowMs: () => 0 });
    const deps = dependencies(root, {
      signal: controller.signal,
      microIndex,
      contextPackReranker: {
        name: "controlled-cancel",
        isAvailable: () => Promise.resolve({ available: true, modelLabel: "controlled" }),
        rerank: (candidates) => {
          controller.abort();
          return Promise.resolve(candidates);
        },
      },
    });
    await expect(
      retrieveConnectedContextPack(
        {
          ...request(root, "Which value is recorded for CacheCancelProbe?"),
          budget: { ...DEFAULT_EXPLORATION_BUDGET, rerankCallsMax: 1 },
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(microIndex.size()).toBe(0);
  });
  it.each([80, 2_048])(
    "accounts for all %i manifest candidates beyond retained-output capacity",
    async (count) => {
      const root = physicalRoot();
      manifestCorpus(root, count);
      const result = await retrieveConnectedContextPack(
        request(root, "Which package manifests define this workspace?", 8),
        dependencies(root),
      );
      expect(result.pack.files).toHaveLength(9);
      expect(result.pack.diagnostics?.coverage?.filesDiscovered).toBe(count + 1);
      expect(result.pack.diagnostics?.coverage?.incomplete).toBe(false);
      expect(result.pack.omitted).toHaveLength(count - 8);
      expect(result.pack.omitted.every((entry) => entry.reason === "budget-exhausted")).toBe(true);
      expect(result.pack.uncertainty).toContainEqual(
        expect.objectContaining({ kind: "budget-clipped" }),
      );
      expect(result.pack.uncertainty.some((marker) => marker.kind === "scope-incomplete")).toBe(
        false,
      );
    },
  );

  it("retains primary roots and does not count overlapping workspace patterns twice", async () => {
    const root = physicalRoot();
    manifestCorpus(root, 80);
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(
      join(root, "zproject.csproj"),
      "<Project><TargetFramework>net10.0</TargetFramework></Project>",
    );
    const result = await retrieveConnectedContextPack(
      request(root, "Which package manifests define this workspace?", 8),
      dependencies(root),
    );
    expect(result.pack.files.map((file) => file.scopePath)).toContain("zproject.csproj");
    expect(result.pack.files.map((file) => file.scopePath)).toContain("package.json");
    expect(result.pack.omitted).toHaveLength(74);
    expect(
      result.pack.uncertainty
        .filter((marker) => marker.kind === "budget-clipped")
        .map((marker) => marker.claim)
        .join("\n"),
    ).toContain("74 observed manifest candidates");
    expect(result.pack.diagnostics?.coverage?.filesDiscovered).toBe(83);
  });

  it("reuses byte-clipped packs before excerpt reads and invalidates changed source bytes", async () => {
    const root = physicalRoot();
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(
        join(root, `fact-${String(index).padStart(2, "0")}.txt`),
        `CacheByteProbe VALUE${String(index)}\n${"ordinary body ".repeat(100)}\n`,
      );
    }
    const store = new Map<
      string,
      Awaited<ReturnType<typeof retrieveConnectedContextPack>>["pack"]
    >();
    const index: MicroIndex = {
      get: (key) => store.get(key),
      set: (key, pack) => {
        store.set(key, pack);
      },
      delete: (key) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      size: () => store.size,
    };
    let reads = 0;
    const readFileBytes = nodeWorkspaceFs.readFileBytes;
    if (readFileBytes === undefined) throw new TypeError("Physical byte reads are required.");
    const deps = dependencies(root, {
      microIndex: index,
      fs: {
        ...nodeWorkspaceFs,
        readFileBytes: async (...args) => {
          reads += 1;
          return readFileBytes(...args);
        },
      },
    });
    const input = {
      ...request(root, "Which values are recorded for CacheByteProbe?"),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 80 },
    };
    const first = await retrieveConnectedContextPack(input, deps);
    const firstReads = reads;
    const second = await retrieveConnectedContextPack(input, deps);
    expect(second.pack).toEqual(first.pack);
    expect(reads - firstReads).toBe(12);
    const selected = first.pack.files[0];
    expect(selected).toBeDefined();
    if (selected === undefined) throw new TypeError("Expected a selected source.");
    writeFileSync(join(root, selected.scopePath), "CacheByteProbe CHANGED_VALUE\n");
    const beforeChanged = reads;
    const changed = await retrieveConnectedContextPack(input, deps);
    expect(reads - beforeChanged).toBeGreaterThan(12);
    expect(
      changed.pack.files
        .flatMap((file) => file.excerpts)
        .map((excerpt) => excerpt.content)
        .join("\n"),
    ).toContain("CHANGED_VALUE");
  });
});
