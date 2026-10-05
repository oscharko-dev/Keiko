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
      value.op === "search.connected-context.completion-details"
    ) {
      expect(value).toHaveProperty("correlationId", CORRELATION);
      Object.assign(joined, value);
    }
  }
  if (!("activityDetailStatus" in joined))
    throw new Error("Expected persisted retrieval completion evidence");
  return joined;
}

async function loggedRetrieval(
  files: Readonly<Record<string, string>>,
  question: string,
  budget: ExplorationBudget,
  maxResults = 200,
): Promise<{ output: RetrievalOnlyOutput; completed: Readonly<Record<string, unknown>> }> {
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
    return { output, completed };
  } finally {
    activityLog.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("persisted retrieval loss counters", () => {
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
