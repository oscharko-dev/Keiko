import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type ExplorationBudget,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceInfo, WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import {
  _readKeptExcerptsForTests,
  retrieveConnectedContextPack,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";
import { createFileServerLogSink } from "./observability/index.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";

const ROOT = "/private/customer/loss-fixture";
const CORRELATION = "retrieval-loss-fixture-0001";
const WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "fixture",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

function completedLine(raw: string): Readonly<Record<string, unknown>> {
  const joined: Record<string, unknown> = {};
  for (const line of raw.split("\n").filter(Boolean)) {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("op" in value)) continue;
    if (
      value.op === "search.connected-context.completed" ||
      value.op === "search.connected-context.completion-details" ||
      value.op === "search.connected-context.source-details"
    ) {
      expect(value).toHaveProperty("correlationId", CORRELATION);
      Object.assign(joined, value);
    }
  }
  if (!("activityDetailStatus" in joined))
    throw new Error("Expected persisted retrieval completion evidence");
  return joined;
}

function selectionDetailsLine(raw: string): Readonly<Record<string, unknown>> {
  for (const line of raw.split("\n").filter(Boolean)) {
    const value: unknown = JSON.parse(line);
    if (
      typeof value === "object" &&
      value !== null &&
      "op" in value &&
      value.op === "search.connected-context.selection-details"
    ) {
      expect(value).toHaveProperty("correlationId", CORRELATION);
      return value as Readonly<Record<string, unknown>>;
    }
  }
  throw new Error("Expected persisted retrieval selection evidence");
}

async function loggedRetrieval(
  files: Readonly<Record<string, string>>,
  question: string,
  budget: ExplorationBudget,
  maxResults = 200,
): Promise<{
  output: RetrievalOnlyOutput;
  completed: Readonly<Record<string, unknown>>;
  selection: Readonly<Record<string, unknown>>;
}> {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-retrieval-loss-log-"));
  const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
  try {
    const base = memFs(ROOT, files);
    const fs: WorkspaceFs = {
      ...base,
      iterateDirectory: async function* (path) {
        for (const entry of base.readDir(path)) yield await Promise.resolve(entry);
      },
    };
    const output = await retrieveConnectedContextPack(
      {
        workspaceRoot: ROOT,
        scope: {
          schemaVersion: "1",
          scopeId: "private-scope",
          workspaceRoot: ROOT,
          kind: "workspace-root",
          relativePaths: [],
          conversationId: undefined,
          connectedAtMs: 0,
          explicitConnection: true,
        },
        query: {
          kind: "natural-language",
          text: question,
          maxResults,
          caseSensitive: false,
          emittedAtMs: 0,
        },
        budget,
      },
      {
        correlationId: CORRELATION,
        activityLog,
        fs,
        nowMs: () => 0,
        detectWorkspace: () => WORKSPACE,
        answerer: { answer: () => Promise.resolve("not used") },
      },
    );
    activityLog.close?.();
    const raw = readPersistedActivityLog(stateDir);
    expect(raw).not.toContain(ROOT);
    expect(raw).not.toContain(question);
    expect(raw).not.toContain("private-scope");
    const completed = completedLine(raw);
    expect(completed.correlationId).toBe(CORRELATION);
    return { output, completed, selection: selectionDetailsLine(raw) };
  } finally {
    activityLog.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function loggedRouteFiles(): Readonly<Record<string, string>> {
  const helpers = Array.from({ length: 18 }, (_unused, index) =>
    [
      `function helper${String(index)}() {`,
      ...Array.from(
        { length: 60 },
        (_value, line) => `  const checkpoint${String(line)} = ${String(line)};`,
      ),
      "  return false;",
      "}",
    ].join("\n"),
  );
  return {
    "src/routes.ts":
      'import { handleItem } from "./implementation.js";\nconst routes = [{ method: "POST", path: "/api/items", handler: handleItem }];',
    "src/implementation.ts": [
      "export function handleItem() { return () => processItem(); }",
      "function processItem() {",
      ...helpers.map((_unused, index) => `  helper${String(index)}();`),
      "  return true;",
      "}",
      ...helpers,
      "export class ScopeAdmission {",
      "  scopeAdmissionBudgetAndPromptFittingBudget() {",
      "    const scopeAdmissionBudget = 1024;",
      "    const promptFittingBudget = 2048;",
      "    return scopeAdmissionBudget + promptFittingBudget;",
      "  }",
      "}",
    ].join("\n"),
  };
}

describe("persisted retrieval loss counters", () => {
  it("persists actual ordinary service and deferred definitions on the existing selection event", async () => {
    const { selection, completed, output } = await loggedRetrieval(
      loggedRouteFiles(),
      "Trace POST /api/items and explain scopeAdmissionBudget and promptFittingBudget",
      { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 24576 },
    );
    expect(selection.excerptOrdinaryRangeCount).toBeGreaterThan(0);
    expect(selection.excerptOrdinaryServedRangeCount).toBeGreaterThan(0);
    expect(selection.excerptOrdinaryServedRangeCount).toBeLessThanOrEqual(
      selection.excerptOrdinaryRangeCount,
    );
    expect(selection.excerptDeferredDefinitionRangeCount).toBeGreaterThan(0);
    expect(selection).not.toHaveProperty("_truncatedFieldCount");
    expect(completed.excerptReadWindowCount).toBeGreaterThan(0);
    expect(
      output.pack.files
        .flatMap((file) => file.excerpts)
        .some((excerpt) =>
          excerpt.content.includes("return scopeAdmissionBudget + promptFittingBudget;"),
        ),
    ).toBe(true);
  });

  it("reports per-window clipping without claiming the ample byte grant is exhausted", async () => {
    const { completed } = await loggedRetrieval(
      {
        "large.txt": `WindowLossProbe ${"x".repeat(20_000)}\n${"unrelated line\n".repeat(20_000)}`,
      },
      'Find the exact literal "WindowLossProbe".',
      { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 128 * 1024 },
    );
    expect(completed.excerptTruncatedWindowCount).toBeGreaterThan(0);
    expect(completed).toMatchObject({
      retrievalReadBudgetBlocked: false,
      excerptUnreadFileCount: 0,
      excerptStopReasons: [],
    });
  });

  it("reports an actual byte-grant stop and unread file separately from a clipped window", async () => {
    const { completed, output } = await loggedRetrieval(
      {
        "a.txt": `WindowLossProbe ${"x".repeat(20_000)}`,
        "b.txt": `WindowLossProbe ${"x".repeat(20_000)}`,
      },
      'Find the exact literal "WindowLossProbe".',
      { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 64 },
    );
    expect(completed.excerptReadWindowCount).toBe(1);
    expect(
      output.pack.uncertainty.some((marker) =>
        marker.claim.includes("excerpt byte limit truncated 1"),
      ),
    ).toBe(true);
    expect(completed).toMatchObject({
      retrievalReadBudgetBlocked: true,
      excerptOmittedRangeCount: 0,
      excerptTruncatedWindowCount: 1,
      excerptUnreadFileCount: 1,
      excerptStopReasons: ["byte-grant"],
    });
  });

  it("counts unreturned ranges instead of inferring their loss from one uncertainty marker", async () => {
    const lines = Array.from({ length: 41 * 12 }, (_unused, index) =>
      index % 12 === 0 ? `WindowLossProbe ${"x".repeat(20_000)}` : "",
    ).join("\n");
    const { completed, output } = await loggedRetrieval(
      { "ranges.txt": lines },
      'Find the exact literal "WindowLossProbe".',
      { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 4096 },
    );
    expect(completed.excerptReadWindowCount).toBe(1);
    expect(output.pack.uncertainty.some((marker) => marker.claim.includes("omitted 40"))).toBe(
      true,
    );
    expect(completed).toMatchObject({
      retrievalReadBudgetBlocked: true,
      excerptOmittedRangeCount: 40,
      excerptTruncatedWindowCount: 1,
      excerptUnreadFileCount: 0,
      excerptStopReasons: ["byte-grant"],
    });
  });

  it("reports exact metadata retention loss beyond the representative omission detail cap", async () => {
    const files: Record<string, string> = { "package.json": '{"name":"fixture"}' };
    for (let index = 0; index < 4200; index += 1)
      files[`module-${String(index).padStart(4, "0")}.csproj`] = "<Project />";
    const { completed } = await loggedRetrieval(
      files,
      "Welche Technologien und Abhängigkeiten verwendet dieses Projekt?",
      DEFAULT_EXPLORATION_BUDGET,
      2,
    );
    expect(completed).toMatchObject({
      metadataObservedCount: 4201,
      metadataRetainedCount: 2,
      metadataDiscardedCount: 4199,
      metadataOmittedDetailCount: 4096,
      metadataRetentionLimit: 2,
    });
  });
});

describe("excerpt stop attribution", () => {
  it("does not call an exactly fitting complete read budget-blocked", async () => {
    const result = await _readKeptExcerptsForTests(["a.txt"], {
      searchScope: { workspace: WORKSPACE, scopeId: "exact-fit", relativePaths: [] },
      fs: memFs(ROOT, { "a.txt": "fit" }),
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 3 },
      initialUsage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        rerankCalls: 0,
        elapsedMs: 0,
      },
      atomsByPath: new Map(),
      nowMs: () => 0,
      deadlineAtMs: Infinity,
    });
    expect(result.excerpts.get("a.txt")?.[0]?.content).toBe("fit");
    expect(result.observation).toEqual({
      unreadFileCount: 0,
      omittedRangeCount: 0,
      truncatedWindowCount: 0,
      stopReasons: [],
      readBudgetBlocked: false,
    });
  });

  it.each(["file-grant", "deadline"] as const)(
    "attributes %s after reads have started",
    async (reason) => {
      const base = memFs(ROOT, { "a.txt": "First evidence", "b.txt": "Second evidence" });
      let reads = 0;
      let clock = 0;
      const readBytes = base.readFileBytes;
      if (readBytes === undefined) throw new TypeError("Fixture requires bounded byte reads");
      const fs: WorkspaceFs = {
        ...base,
        readFileBytes: (...args) => {
          reads += 1;
          if (reason === "deadline") clock = 10;
          return readBytes(...args);
        },
      };
      const result = await _readKeptExcerptsForTests(["a.txt", "b.txt"], {
        searchScope: { workspace: WORKSPACE, scopeId: "started-stop", relativePaths: [] },
        fs,
        budget: {
          ...DEFAULT_EXPLORATION_BUDGET,
          filesReadMax: reason === "file-grant" ? 1 : null,
          excerptBytesMax: 8192,
        },
        initialUsage: {
          searchCalls: 0,
          filesRead: 0,
          excerptBytes: 0,
          modelInputTokens: 0,
          modelOutputTokens: 0,
          rerankCalls: 0,
          elapsedMs: 0,
        },
        atomsByPath: new Map(),
        nowMs: () => clock,
        deadlineAtMs: 10,
      });
      expect(reads).toBeGreaterThan(0);
      expect(result.excerpts.size).toBe(reason === "file-grant" ? 1 : 0);
      expect(result.observation).toMatchObject({
        stopReasons: [reason],
        readBudgetBlocked: reason === "file-grant",
        unreadFileCount: reason === "file-grant" ? 1 : 2,
      });
    },
  );

  it.each([
    { files: 0, bytes: 100, deadline: Infinity, reasons: ["file-grant"], blocked: true },
    { files: 3, bytes: 0, deadline: Infinity, reasons: ["byte-grant"], blocked: true },
    { files: 3, bytes: 100, deadline: 0, reasons: ["deadline"], blocked: false },
  ])("attributes unread files to $reasons without inventing unread ranges", async (row) => {
    const result = await _readKeptExcerptsForTests(["a.txt", "b.txt"], {
      searchScope: { workspace: WORKSPACE, scopeId: "stop", relativePaths: [] },
      fs: {
        ...memFs(ROOT, {}),
        readFileUtf8: () => {
          throw new Error("Stopped reads must not access a file");
        },
      },
      budget: {
        ...DEFAULT_EXPLORATION_BUDGET,
        filesReadMax: row.files,
        excerptBytesMax: row.bytes,
      },
      initialUsage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        rerankCalls: 0,
        elapsedMs: 0,
      },
      atomsByPath: new Map(),
      nowMs: () => 0,
      deadlineAtMs: row.deadline,
    });
    expect(result.excerpts.size).toBe(0);
    expect(result.observation).toEqual({
      unreadFileCount: 2,
      omittedRangeCount: 0,
      truncatedWindowCount: 0,
      stopReasons: row.reasons,
      readBudgetBlocked: row.blocked,
    });
  });
});
