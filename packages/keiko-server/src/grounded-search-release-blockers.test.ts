import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type EvidenceAtom,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack } from "@oscharko-dev/keiko-workflows";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { withPromptExcerptByteLimit } from "./grounded-qa.js";
import { createFileServerLogSink } from "./observability/index.js";
import {
  expectActivityLogProof,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";

const ROOT = "/workspace/private-release-fixture";
const CORRELATION = "search-release-blocker-proof-0001";
const SCOPE: SelectedScope = {
  schemaVersion: "1",
  scopeId: "release-search-scope",
  workspaceRoot: ROOT,
  kind: "workspace-root",
  relativePaths: [],
  explicitConnection: true,
  conversationId: undefined,
  connectedAtMs: 0,
};
const WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "private-release-fixture",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

function query(text: string): Parameters<typeof retrieveConnectedContextPack>[0]["query"] {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 200, emittedAtMs: 0 };
}

async function recordedRetrieval(
  text: string,
  fs: WorkspaceFs,
): Promise<{
  output: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  events: readonly Record<string, unknown>[];
}> {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-high-search-log-"));
  const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
  try {
    const output = await retrieveConnectedContextPack(
      { workspaceRoot: ROOT, scope: SCOPE, query: query(text) },
      {
        fs,
        activityLog,
        correlationId: CORRELATION,
        nowMs: () => 0,
        detectWorkspace: () => WORKSPACE,
        answerer: { answer: () => Promise.resolve("unused") },
      },
    );
    activityLog.close?.();
    const raw = readPersistedActivityLog(stateDir);
    expect(raw).not.toContain(ROOT);
    expect(raw).not.toContain(text);
    expect(raw).not.toContain("private source content");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const completed = events.find((event) => event.op === "search.connected-context.completed");
    expectActivityLogProof(
      "search.connected-context.completed.line",
      raw.split("\n").find((line) => line.includes('"op":"search.connected-context.completed"')) ??
        "",
    );
    expect(completed).toMatchObject({
      correlationId: CORRELATION,
      activityDetailStatus: "complete",
    });
    expect(events.some((event) => event.op === "search.connected-context.failed")).toBe(false);
    return { output, events };
  } finally {
    activityLog.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function atom(path: string, score: number, edge?: "import" | "call"): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `${path}-${edge ?? "plain"}`,
    scopePath: path,
    lineRange: { startLine: 1, endLine: 1 },
    score,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "query" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
    ...(edge === undefined
      ? {}
      : {
          edge: {
            kind: edge,
            source: { scopePath: path },
            target: { scopePath: "target.ts" },
            confidence: "resolved" as const,
          },
        }),
  };
}

describe("release-critical connected search consumer regressions", () => {
  it("retrieves a late target from a long connected question and persists the actual successful plan", async () => {
    const text = `${"the ".repeat(1500)} Find "LateCrashProbe"`;
    const fs = memFs(ROOT, { "nested/late.txt": "LateCrashProbe private source content" });
    const { output, events } = await recordedRetrieval(text, fs);
    expect(output.pack.files.map((file) => file.scopePath)).toContain("nested/late.txt");
    const completed = events.find((event) => event.op === "search.connected-context.completed");
    expect(completed?.retrievalAnchorCount).toBeGreaterThan(0);
    expect(completed?.selectedFileCount).toBe(1);
  });

  it("preserves sibling evidence and persists incomplete coverage for an inaccessible child", async () => {
    const base = memFs(ROOT, {
      "unavailable/secret.txt": "private source content",
      "stable/fact.txt": "SiblingEvidenceProbe private source content",
    });
    const fs: WorkspaceFs = {
      ...base,
      iterateDirectory: async function* (path) {
        if (path.endsWith("/unavailable"))
          throw Object.assign(new Error("inaccessible fixture directory"), { code: "EACCES" });
        for (const entry of base.readDir(path)) yield await Promise.resolve(entry);
      },
    };
    const { output, events } = await recordedRetrieval('Find "SiblingEvidenceProbe"', fs);
    expect(output.pack.files.map((file) => file.scopePath)).toContain("stable/fact.txt");
    expect(output.pack.uncertainty).toContainEqual(
      expect.objectContaining({ kind: "scope-incomplete" }),
    );
    const completed = events.find((event) => event.op === "search.connected-context.completed");
    expect(completed?.coverageStatus).toBe("incomplete");
    expect(completed?.coverageReasons).toContain("io-error");
  });

  it("keeps the strongest shared source body when the real prompt consumer has a tight budget", async () => {
    const atoms = [
      atom("shared.txt", 0.1, "import"),
      atom("other.txt", 0.5),
      atom("shared.txt", 0.9, "call"),
    ];
    const { pack } = await assembleContextPack(
      {
        scope: SCOPE,
        query: query("Find sources"),
        budget: DEFAULT_EXPLORATION_BUDGET,
        atoms,
        ranked: ["shared.txt", "other.txt"].map((scopePath) => ({
          scopePath,
          score: 1,
          signals: [],
          omitted: undefined,
        })),
        omittedFromRanking: [],
        excerpts: new Map([
          ["shared.txt", "high"],
          ["other.txt", "other"],
        ]),
      },
      { includeSurroundingContext: true, nowMs: () => 0 },
    );
    const admitted = withPromptExcerptByteLimit(pack, 2);
    const shared = admitted.files.find((file) => file.scopePath === "shared.txt");
    expect(shared?.excerpts[0]).toMatchObject({ content: "high", atom: { score: 0.9 } });
    expect(
      admitted.files.flatMap((file) => file.excerpts).every((excerpt) => excerpt.contentBytes > 0),
    ).toBe(true);
    expect(pack.usage.excerptBytes).toBe(Buffer.byteLength("highother"));
  });
});
