// Tests for the multi-source (1+N) grounded path (Epic #532). Pure helpers are exercised directly;
// the handler branch is driven through handleGroundedAsk with an injected MultiSourceSeam (a
// deterministic retriever + answerer) so no real workspace is spun up. AC5 — a single connected
// scope must produce the same answer shape as the legacy single-source runner — is asserted by
// routing one scope through both seams and comparing the wire object minus volatile ids.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ChatConnectedScope, GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";

import { handleGroundedAsk, type GroundedRunner, type MultiSourceSeam } from "./grounded-qa.js";
import {
  buildConnectedScopes,
  mergeContextPackSummaries,
  sourceLabels,
  splitExplorationBudget,
  type GroundedRetriever,
  type MultiSourceAnswerer,
} from "./grounded-qa-multi-source.js";
import { buildGroundedAnswerContextPackSummary } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryUiStore, type Chat, type UiStore } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { RouteContext } from "./routes.js";
import type { OrchestratorInput, OrchestratorOutput } from "./grounded-orchestrator.js";

const NOW = 1_700_000_000_000;
const CHAT_MODEL = "example-chat-model";

let store: UiStore;
let tmp: string;

interface PutCall {
  readonly runId: string;
  readonly workspaceRoot: string;
}

function asConnectedAnswer(
  answer: GroundedAnswer,
): Extract<GroundedAnswer, { readonly groundingKind: "connected-context" }> {
  expect(answer.groundingKind).toBe("connected-context");
  return answer as Extract<GroundedAnswer, { readonly groundingKind: "connected-context" }>;
}

function fakeReq(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function fakeRes(): RouteContext["res"] {
  const res = new EventEmitter() as RouteContext["res"] & { writableEnded: boolean };
  res.writableEnded = false;
  return res;
}

function ctx(body: string): RouteContext {
  return {
    req: fakeReq(body),
    res: fakeRes(),
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

function recordingDeps(puts: PutCall[]): UiHandlerDeps {
  const env: Record<string, string> = {};
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (runId: string, json: string): string => {
        const parsed = JSON.parse(json) as { context?: { workspaceRoot?: string } };
        puts.push({ runId, workspaceRoot: parsed.context?.workspaceRoot ?? "" });
        return runId;
      },
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    env,
    redactor: buildRedactor(env, undefined),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function scopePack(scopePath: string, score: number, stableId: string): ConnectedContextPack {
  const content = `body of ${scopePath}`;
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `pack-${stableId}`,
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: `cs-${stableId}`,
      workspaceRoot: "/repo",
      kind: "directory",
      relativePaths: ["src"],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "How does it work?",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: { ...DEFAULT_EXPLORATION_BUDGET },
    usage: {
      searchCalls: 1,
      filesRead: 1,
      excerptBytes: 40,
      modelInputTokens: 10,
      modelOutputTokens: 5,
      elapsedMs: 7,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath,
        role: "read-only",
        selectionReason: "ranked",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId,
              scopePath,
              lineRange: { startLine: 1, endLine: 5 },
              score,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: "fp",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content,
            contentBytes: new TextEncoder().encode(content).length,
          },
        ],
      },
    ],
    omitted: [{ scopePath: "src/skipped.ts", reason: "low-relevance", omittedAtMs: NOW }],
    uncertainty: [
      {
        kind: "no-evidence",
        claim: `uncertain about ${scopePath}`,
        impactedAtomIds: [],
        emittedAtMs: NOW,
      },
    ],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

// Retriever that returns a distinct pack per source, keyed by the source's first relativePath, so
// the two merged packs carry distinct evidence/scores and we can assert the merge.
function packPerScope(byPath: ReadonlyMap<string, ConnectedContextPack>): GroundedRetriever {
  return (input: OrchestratorInput) => {
    const key = input.scope.relativePaths[0] ?? "";
    const pack = byPath.get(key);
    if (pack === undefined) throw new Error(`no fixture pack for ${key}`);
    return Promise.resolve({ pack, elapsedMs: 11, plan: { state: "ready" } as never });
  };
}

function constAnswerer(content: string, seen: { count: number }): MultiSourceAnswerer {
  return (_question, labeledPacks) => {
    seen.count = labeledPacks.length;
    return Promise.resolve(content);
  };
}

function seam(retriever: GroundedRetriever, answerer: MultiSourceAnswerer): MultiSourceSeam {
  return { retriever, answerer };
}

function makeChat(scopes: readonly ChatConnectedScope[]): string {
  const project = store.createProject(tmp, "demo");
  const chat = store.createChat(project.path, "Multi", CHAT_MODEL);
  store.updateChat(chat.id, { connectedScopes: scopes });
  return chat.id;
}

beforeEach(() => {
  store = createInMemoryUiStore();
  tmp = mkdtempSync(join(tmpdir(), "keiko-grounded-multi-"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe("splitExplorationBudget", () => {
  it("returns the base unchanged for n=1", () => {
    expect(splitExplorationBudget(DEFAULT_EXPLORATION_BUDGET, 1)).toStrictEqual(
      DEFAULT_EXPLORATION_BUDGET,
    );
  });

  it("floor-divides each bounded dimension for n=3 and leaves rerankCallsMax unchanged", () => {
    const split = splitExplorationBudget(DEFAULT_EXPLORATION_BUDGET, 3);
    expect(split.searchCallsMax).toBe(Math.floor(DEFAULT_EXPLORATION_BUDGET.searchCallsMax / 3));
    expect(split.filesReadMax).toBe(Math.floor(DEFAULT_EXPLORATION_BUDGET.filesReadMax / 3));
    expect(split.excerptBytesMax).toBe(Math.floor(DEFAULT_EXPLORATION_BUDGET.excerptBytesMax / 3));
    expect(split.rerankCallsMax).toBe(DEFAULT_EXPLORATION_BUDGET.rerankCallsMax);
  });

  it("floors a tiny dimension to 1 rather than 0", () => {
    const base = { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 1 };
    expect(splitExplorationBudget(base, 4).filesReadMax).toBe(1);
  });
});

describe("sourceLabels", () => {
  it("uses the root basename and 'project' when root is undefined", () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "directory", relativePaths: ["src"], connectedAtMs: NOW, root: "/home/a/api" },
      { kind: "directory", relativePaths: ["src"], connectedAtMs: NOW },
    ];
    expect(sourceLabels(scopes)).toStrictEqual(["api", "project"]);
  });

  it("disambiguates duplicate basenames with distinct suffixes", () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "directory", relativePaths: ["src"], connectedAtMs: NOW, root: "/home/a/api" },
      { kind: "directory", relativePaths: ["src"], connectedAtMs: NOW, root: "/home/b/api" },
    ];
    const labels = sourceLabels(scopes);
    expect(labels[0]).toMatch(/^api~[0-9a-f]{6}$/);
    expect(labels[1]).toMatch(/^api~[0-9a-f]{6}$/);
    expect(labels[0]).not.toBe(labels[1]);
  });
});

describe("buildConnectedScopes", () => {
  it("prefers the canonical list and falls back to the legacy single field", () => {
    const list: ChatConnectedScope[] = [
      { kind: "directory", relativePaths: ["a"], connectedAtMs: NOW },
      { kind: "directory", relativePaths: ["b"], connectedAtMs: NOW },
    ];
    const withList = { connectedScopes: list, connectedScope: list[0] } as unknown as Chat;
    expect(buildConnectedScopes(withList)).toBe(list);
    const legacy = { connectedScope: list[0] } as unknown as Chat;
    expect(buildConnectedScopes(legacy)).toStrictEqual([list[0]]);
    const none = {} as unknown as Chat;
    expect(buildConnectedScopes(none)).toStrictEqual([]);
  });
});

describe("mergeContextPackSummaries", () => {
  it("sums usage/budget/counts and flags fileCount -1 when any source is workspace-root", () => {
    const a = buildGroundedAnswerContextPackSummary(scopePack("src/a.ts", 0.4, "a"), 1, 11);
    const rootPack: ConnectedContextPack = {
      ...scopePack("", 0.9, "b"),
      scope: { ...scopePack("", 0.9, "b").scope, kind: "workspace-root", relativePaths: [] },
    };
    const b = buildGroundedAnswerContextPackSummary(rootPack, 1, 13);
    const merged = mergeContextPackSummaries([a, b]);
    expect(merged.usage.searchCalls).toBe(a.usage.searchCalls + b.usage.searchCalls);
    expect(merged.budget.filesReadMax).toBe(a.budget.filesReadMax + b.budget.filesReadMax);
    expect(merged.citationCount).toBe(2);
    expect(merged.omittedCount).toBe(a.omittedCount + b.omittedCount);
    expect(merged.fileCount).toBe(-1);
  });
});

// ─── Handler branch ───────────────────────────────────────────────────────────

describe("handleGroundedAsk multi-source branch (Epic #532)", () => {
  it("merges two sources: citations carry BOTH labels, omitted/usage/budget are summed", async () => {
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: "/home/u/api",
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: "/home/u/web",
    };
    const chatId = makeChat([scopeA, scopeB]);
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/a.ts", scopePack("src/a.ts", 0.3, "low")],
      ["src/b.ts", scopePack("src/b.ts", 0.9, "high")],
    ]);
    const puts: PutCall[] = [];
    const answered = { count: 0 };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain both" })),
      recordingDeps(puts),
      undefined,
      seam(packPerScope(byPath), constAnswerer("merged answer", answered)),
    );
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("merged answer");
    expect(answered.count).toBe(2);
    const labels = answer.citations.map((c) => c.source);
    expect(labels).toContain("api");
    expect(labels).toContain("web");
    // Higher score sorts first across the merged set.
    expect(answer.citations[0]?.source).toBe("web");
    expect(answer.omittedCount).toBe(2);
    const baseSummary = buildGroundedAnswerContextPackSummary(
      scopePack("src/a.ts", 0.3, "low"),
      1,
      11,
    );
    expect(answer.contextPack.usage.searchCalls).toBe(baseSummary.usage.searchCalls * 2);
    expect(answer.contextPack.budget.filesReadMax).toBe(baseSummary.budget.filesReadMax * 2);
    expect(answer.uncertainty).toHaveLength(2);
  });

  it("persists one evidence run per source root and reports the first run id", async () => {
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: "/home/u/api",
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: "/home/u/web",
    };
    const chatId = makeChat([scopeA, scopeB]);
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/a.ts", scopePack("src/a.ts", 0.3, "low")],
      ["src/b.ts", scopePack("src/b.ts", 0.9, "high")],
    ]);
    const puts: PutCall[] = [];
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain both" })),
      recordingDeps(puts),
      undefined,
      seam(packPerScope(byPath), constAnswerer("ok", { count: 0 })),
    );
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(puts).toHaveLength(2);
    expect(puts.map((p) => p.workspaceRoot)).toStrictEqual(["/home/u/api", "/home/u/web"]);
    expect(answer.evidenceRunId).toBe(puts[0]?.runId);
  });

  it("MAX_CONNECTED_SOURCES: 16 sources all retrieve and merge", async () => {
    const scopes: ChatConnectedScope[] = Array.from({ length: 16 }, (_unused, i) => ({
      kind: "directory" as const,
      relativePaths: [`src/s${String(i)}.ts`],
      connectedAtMs: NOW,
      root: `/home/u/src${String(i)}`,
    }));
    const chatId = makeChat(scopes);
    const byPath = new Map<string, ConnectedContextPack>(
      scopes.map((s, i) => [
        s.relativePaths[0] ?? "",
        scopePack(s.relativePaths[0] ?? "", i / 100, `id${String(i)}`),
      ]),
    );
    const puts: PutCall[] = [];
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "scan all" })),
      recordingDeps(puts),
      undefined,
      seam(packPerScope(byPath), constAnswerer("done", { count: 0 })),
    );
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.citations).toHaveLength(16);
    expect(puts).toHaveLength(16);
  });

  it("AC5: a single connected scope routes through the legacy single-source runner, NOT the merge", async () => {
    const scope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: "/home/u/api",
    };
    const chatId = makeChat([scope]);
    const pack = scopePack("src/a.ts", 0.5, "solo");
    const singleRunner: GroundedRunner = (_input: OrchestratorInput): Promise<OrchestratorOutput> =>
      Promise.resolve({ pack, assistantContent: "single answer", elapsedMs: 9 });
    let multiCalled = false;
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain a" })),
      recordingDeps([]),
      singleRunner,
      seam(
        () => {
          multiCalled = true;
          throw new Error("multi retriever must not run for a single scope");
        },
        () => {
          multiCalled = true;
          return Promise.resolve("nope");
        },
      ),
    );
    expect(result.status).toBe(200);
    expect(multiCalled).toBe(false);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    // Single-source answers carry NO per-source attribution (source is absent).
    expect(answer.content).toBe("single answer");
    expect(answer.citations.every((c) => c.source === undefined)).toBe(true);
  });
});
