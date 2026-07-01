// Tests for the multi-source (1+N) grounded path (Epic #532). Pure helpers are exercised directly;
// the handler branch is driven through handleGroundedAsk with an injected MultiSourceSeam (a
// deterministic retriever + answerer) so no real workspace is spun up. AC5 — a single connected
// scope must produce the same answer shape as the legacy single-source runner — is asserted by
// routing one scope through both seams and comparing the wire object minus volatile ids.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import {
  CONTEXT_LANE_IDS,
  DEFAULT_CONTEXT_PROFILE,
  maxUtf8BytesForTokenBudget,
  type ContextLaneId,
} from "@oscharko-dev/keiko-contracts";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
  type ContextCoverageDiagnostics,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type {
  ChatConnectedScope,
  GroundedAnswer,
  GroundedAnswerContextSummary,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import {
  handleGroundedAsk,
  promptByteLength,
  type GroundedRunner,
  type MultiSourceSeam,
} from "./grounded-qa.js";
import {
  buildConnectedScopes,
  buildMultiSourceGatewayMessages,
  mergeContextPackSummaries,
  sourceLabels,
  splitExplorationBudget,
  type GroundedRetriever,
  type MultiSourceAnswerer,
} from "./grounded-qa-multi-source.js";
import { buildGroundedAnswerContextPackSummary } from "@oscharko-dev/keiko-contracts/bff-wire";
import { attachContextBudgetDiagnostics } from "./grounded-context-diagnostics.js";
import { createInMemoryUiStore, type Chat, type UiStore } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { RouteContext } from "./routes.js";
import type { OrchestratorInput, OrchestratorOutput } from "./grounded-orchestrator.js";
import { RepoSearchUnsupportedFileError } from "@oscharko-dev/keiko-workspace";
import { ContextOverflowError } from "@oscharko-dev/keiko-model-gateway";

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

function ctx(body: string, res: RouteContext["res"] = fakeRes()): RouteContext {
  return {
    req: fakeReq(body),
    res,
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

function recordingDeps(puts: PutCall[], overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
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
    ...overrides,
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

function coverageDiagnostics(
  overrides: Partial<ContextCoverageDiagnostics> = {},
): ContextCoverageDiagnostics {
  return {
    incomplete: false,
    reasons: [],
    filesDiscovered: 3,
    filesAfterPolicy: 3,
    filesScanned: 3,
    filesSkipped: 0,
    ignoredByDiscovery: 0,
    deniedByDiscovery: 0,
    depthPrunedByDiscovery: 0,
    matchesReturned: 1,
    elapsedMs: 10,
    limits: {
      maxFilesScanned: 10,
      maxMatchesReturned: 5,
      elapsedMsMax: 500,
    },
    ...overrides,
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

function tempRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  return root;
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

describe("buildMultiSourceGatewayMessages", () => {
  it("prunes prompt-only excerpt content to fit the summed model input budget", () => {
    const packA = scopePack("src/a.ts", 0.3, "low");
    const packB = scopePack("src/b.ts", 0.9, "high");
    const [budgetedA, budgetedB] = [packA, packB].map((pack) => ({
      ...pack,
      budget: { ...pack.budget, modelInputTokensMax: 512 },
      files: pack.files.map((file) => ({
        ...file,
        excerpts: file.excerpts.map((excerpt) => ({
          ...excerpt,
          content: "x".repeat(20_000),
          contentBytes: 20_000,
        })),
      })),
    }));
    const messages = buildMultiSourceGatewayMessages(
      "explain both",
      [
        { label: "api", pack: budgetedA ?? packA },
        { label: "web", pack: budgetedB ?? packB },
      ],
      buildRedactor({}, undefined),
    );
    expect(promptByteLength(messages)).toBeLessThanOrEqual(
      maxUtf8BytesForTokenBudget(512 + 512),
    );
    expect(messages[1]?.content).toContain("Source 1: api");
    expect(messages[1]?.content).toContain("Source 2: web");
  });

  it("throws ContextOverflowError when a 0-byte combined prompt budget cannot fit framing overhead", () => {
    const baseA = scopePack("src/a.ts", 0.3, "low");
    const baseB = scopePack("src/b.ts", 0.9, "high");
    const packA = { ...baseA, budget: { ...baseA.budget, modelInputTokensMax: 0 } };
    const packB = { ...baseB, budget: { ...baseB.budget, modelInputTokensMax: 0 } };

    expect(() =>
      buildMultiSourceGatewayMessages(
        "explain both",
        [
          { label: "api", pack: packA },
          { label: "web", pack: packB },
        ],
        buildRedactor({}, undefined),
      ),
    ).toThrow(ContextOverflowError);
  });
});

describe("mergeContextPackSummaries", () => {
  function laneCounts(
    overrides: Partial<Record<ContextLaneId, number>> = {},
  ): Record<ContextLaneId, number> {
    const counts = {} as Record<ContextLaneId, number>;
    for (const laneId of CONTEXT_LANE_IDS) {
      counts[laneId] = overrides[laneId] ?? 0;
    }
    return counts;
  }

  function contextSummary(input: {
    readonly totalEstimatedTokens: number;
    readonly budgetPressure: GroundedAnswerContextSummary["budgetPressure"];
    readonly lanes: Partial<Record<ContextLaneId, number>>;
    readonly compactionActive: boolean;
  }): GroundedAnswerContextSummary {
    return {
      totalEstimatedTokens: input.totalEstimatedTokens,
      budgetPressure: input.budgetPressure,
      laneCounts: laneCounts(input.lanes),
      compactionActive: input.compactionActive,
    };
  }

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
    expect("contextSummary" in merged).toBe(false);
  });

  it("aggregates every path-free contextSummary instead of copying the first source", () => {
    const a = {
      ...buildGroundedAnswerContextPackSummary(scopePack("src/a.ts", 0.4, "a"), 1, 11),
      contextSummary: contextSummary({
        totalEstimatedTokens: 100,
        budgetPressure: "moderate",
        lanes: { "repo-evidence": 2, "system-contract": 1 },
        compactionActive: false,
      }),
    };
    const b = {
      ...buildGroundedAnswerContextPackSummary(scopePack("src/b.ts", 0.9, "b"), 1, 13),
      contextSummary: contextSummary({
        totalEstimatedTokens: 250,
        budgetPressure: "exceeded",
        lanes: { "repo-evidence": 3, "tool-observations": 4 },
        compactionActive: true,
      }),
    };

    const merged = mergeContextPackSummaries([a, b]);

    expect(merged.contextSummary).toStrictEqual({
      totalEstimatedTokens: 350,
      budgetPressure: "exceeded",
      laneCounts: laneCounts({
        "repo-evidence": 5,
        "system-contract": 1,
        "tool-observations": 4,
      }),
      compactionActive: true,
    });
    const serialized = JSON.stringify(merged.contextSummary);
    expect(serialized).not.toContain("/");
    expect(serialized).not.toContain("\\");
    expect(serialized).not.toContain("src/");
  });

  it("keeps contextSummary deterministic for identical merged inputs", () => {
    const a = {
      ...buildGroundedAnswerContextPackSummary(scopePack("src/a.ts", 0.4, "a"), 1, 11),
      contextSummary: contextSummary({
        totalEstimatedTokens: 100,
        budgetPressure: "high",
        lanes: { "repo-evidence": 2 },
        compactionActive: true,
      }),
    };
    const b = buildGroundedAnswerContextPackSummary(scopePack("src/b.ts", 0.9, "b"), 1, 13);

    expect(mergeContextPackSummaries([a, b]).contextSummary).toStrictEqual(
      mergeContextPackSummaries([a, b]).contextSummary,
    );
  });

  it("aggregates path-free coverage diagnostics from every source", () => {
    const aPack = {
      ...scopePack("src/a.ts", 0.4, "a"),
      diagnostics: {
        rankedCandidates: [],
        coverage: coverageDiagnostics({
          incomplete: true,
          reasons: ["file-cap"],
          filesScanned: 1,
          filesSkipped: 2,
          limits: { maxFilesScanned: 1, maxMatchesReturned: 5, elapsedMsMax: 500 },
        }),
      },
    };
    const bPack = {
      ...scopePack("src/b.ts", 0.9, "b"),
      diagnostics: {
        rankedCandidates: [],
        coverage: coverageDiagnostics({
          incomplete: true,
          reasons: ["depth-pruned"],
          depthPrunedByDiscovery: 1,
          filesSkipped: 1,
        }),
      },
    };

    const merged = mergeContextPackSummaries([
      buildGroundedAnswerContextPackSummary(aPack, 1, 11),
      buildGroundedAnswerContextPackSummary(bPack, 1, 13),
    ]);

    expect(merged.coverage?.incomplete).toBe(true);
    expect(merged.coverage?.reasons).toStrictEqual(["file-cap", "depth-pruned"]);
    expect(merged.coverage?.filesScanned).toBe(4);
    expect(merged.coverage?.filesSkipped).toBe(3);
    expect(merged.coverage?.depthPrunedByDiscovery).toBe(1);
    expect(merged.coverage?.limits.maxFilesScanned).toBe(11);
    expect(JSON.stringify(merged.coverage)).not.toContain("src/");
  });
});

// ─── Handler branch ───────────────────────────────────────────────────────────

describe("handleGroundedAsk multi-source branch (Epic #532)", () => {
  it("maps typed workspace errors to safe 400 responses before answering or persisting", async () => {
    const scopes: ChatConnectedScope[] = [
      {
        kind: "directory",
        relativePaths: ["src/a.ts"],
        connectedAtMs: NOW,
        root: tempRoot("api"),
      },
      {
        kind: "directory",
        relativePaths: ["src/b.ts"],
        connectedAtMs: NOW,
        root: tempRoot("web"),
      },
    ];
    const chatId = makeChat(scopes);
    let answererCalled = false;
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain both" })),
      recordingDeps([]),
      undefined,
      seam(
        () =>
          Promise.reject(
            new RepoSearchUnsupportedFileError("Connected source is not readable.", "denied"),
          ),
        () => {
          answererCalled = true;
          return Promise.resolve("must not answer");
        },
      ),
    );
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Connected source is not readable.");
    expect(answererCalled).toBe(false);
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("emits merged contextSummary from the active model profile resolver when the singleton profile is absent", async () => {
    const scopes: ChatConnectedScope[] = [
      {
        kind: "directory",
        relativePaths: ["src/a.ts"],
        connectedAtMs: NOW,
        root: tempRoot("api"),
      },
      {
        kind: "directory",
        relativePaths: ["src/b.ts"],
        connectedAtMs: NOW,
        root: tempRoot("web"),
      },
    ];
    const chatId = makeChat(scopes);
    const packs = new Map<string, ConnectedContextPack>([
      [
        "src/a.ts",
        attachContextBudgetDiagnostics(scopePack("src/a.ts", 0.3, "low"), DEFAULT_CONTEXT_PROFILE),
      ],
      [
        "src/b.ts",
        attachContextBudgetDiagnostics(scopePack("src/b.ts", 0.9, "high"), DEFAULT_CONTEXT_PROFILE),
      ],
    ]);
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain both", modelId: CHAT_MODEL })),
      recordingDeps([], {
        contextProfile: undefined,
        contextProfileForModel: () => DEFAULT_CONTEXT_PROFILE,
      }),
      undefined,
      seam(packPerScope(packs), constAnswerer("merged answer", { count: 0 })),
    );

    expect(result.status).toBe(200);
    expect(
      asConnectedAnswer(result.body as GroundedAnswer).contextPack.contextSummary,
    ).toBeDefined();
  });

  it("fail-soft: one inaccessible folder is skipped, healthy sources still answer (GRD-006)", async () => {
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("api"),
    };
    const scopeBad: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/bad.ts"],
      connectedAtMs: NOW,
      root: tempRoot("gone"),
    };
    const scopeC: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/c.ts"],
      connectedAtMs: NOW,
      root: tempRoot("web"),
    };
    const chatId = makeChat([scopeA, scopeBad, scopeC]);
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/a.ts", scopePack("src/a.ts", 0.4, "a")],
      ["src/c.ts", scopePack("src/c.ts", 0.8, "c")],
    ]);
    const answered = { count: 0 };
    const retriever: GroundedRetriever = (input) => {
      if (input.scope.relativePaths[0] === "src/bad.ts") {
        return Promise.reject(
          new RepoSearchUnsupportedFileError("src/bad.ts is not readable.", "denied"),
        );
      }
      return packPerScope(byPath)(input);
    };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain all" })),
      recordingDeps([]),
      undefined,
      seam(retriever, constAnswerer("partial answer", answered)),
    );
    // One bad source must NOT abort the whole ask — the two healthy folders still answer.
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("partial answer");
    expect(answered.count).toBe(2); // answerer receives exactly the 2 healthy source packs
    const labels = answer.citations.map((c) => c.source);
    expect(labels).toContain("api");
    expect(labels).toContain("web");
    expect(labels).not.toContain("gone");
    const skippedClaims = answer.uncertainty
      .filter((u) => u.kind === "source-skipped")
      .map((u) => u.claim)
      .join(" | ");
    expect(skippedClaims).toContain("gone");
    expect(skippedClaims).toContain("not readable");
  });

  it("merges two sources: citations carry BOTH labels, omitted/usage/budget are summed", async () => {
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("api"),
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: tempRoot("web"),
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

  it("does not persist a merged answer when the client disconnects after answering", async () => {
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("api"),
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: tempRoot("web"),
    };
    const chatId = makeChat([scopeA, scopeB]);
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/a.ts", scopePack("src/a.ts", 0.3, "low")],
      ["src/b.ts", scopePack("src/b.ts", 0.9, "high")],
    ]);
    const res = fakeRes();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain both" }), res),
      recordingDeps([]),
      undefined,
      seam(packPerScope(byPath), () => {
        res.emit("close");
        return Promise.resolve("late merged answer");
      }),
    );
    expect(result.status).toBe(499);
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("persists one evidence run per source root and reports all run ids", async () => {
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("api"),
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: tempRoot("web"),
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
    expect(puts.map((p) => p.workspaceRoot)).toStrictEqual([
      expect.stringMatching(/^connected-context-root-[0-9a-f]{16}$/),
      expect.stringMatching(/^connected-context-root-[0-9a-f]{16}$/),
    ]);
    expect(new Set(puts.map((p) => p.workspaceRoot)).size).toBe(2);
    expect(answer.evidenceRunId).toBe(puts[0]?.runId);
    expect(answer.evidenceRunIds).toEqual(puts.map((p) => p.runId));
  });

  it("strips planner scaffolding from merged answers and carries final model usage", async () => {
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("api"),
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: tempRoot("web"),
    };
    const chatId = makeChat([scopeA, scopeB]);
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/a.ts", scopePack("src/a.ts", 0.3, "low")],
      ["src/b.ts", scopePack("src/b.ts", 0.9, "high")],
    ]);
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain both" })),
      recordingDeps([]),
      undefined,
      seam(packPerScope(byPath), () =>
        Promise.resolve({
          content: [
            "We need to call search",
            '{ "query": "explain both", "tool": "repo.searchText" }',
            "Merged grounded answer.",
          ].join("\n"),
          usage: { promptTokens: 13, completionTokens: 4 },
        }),
      ),
    );
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("Merged grounded answer.");
    expect(answer.contextPack.usage.modelInputTokens).toBe(33);
    expect(answer.contextPack.usage.modelOutputTokens).toBe(14);
    const assistant = store
      .listMessages(chatId)
      .find((message) => message.id === answer.assistantMessageId);
    expect(assistant?.content).toBe("Merged grounded answer.");
  });

  it("MAX_CONNECTED_SOURCES: 16 sources all retrieve and merge", async () => {
    const scopes: ChatConnectedScope[] = Array.from({ length: 16 }, (_unused, i) => ({
      kind: "directory" as const,
      relativePaths: [`src/s${String(i)}.ts`],
      connectedAtMs: NOW,
      root: tempRoot(`src${String(i)}`),
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

  it("retrieves connected sources with bounded concurrency", async () => {
    const scopes: ChatConnectedScope[] = Array.from({ length: 4 }, (_unused, i) => ({
      kind: "directory" as const,
      relativePaths: [`src/c${String(i)}.ts`],
      connectedAtMs: NOW,
      root: tempRoot(`concurrent${String(i)}`),
    }));
    const chatId = makeChat(scopes);
    const byPath = new Map<string, ConnectedContextPack>(
      scopes.map((s, i) => [
        s.relativePaths[0] ?? "",
        scopePack(s.relativePaths[0] ?? "", i / 100, `concurrent-${String(i)}`),
      ]),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const retriever: GroundedRetriever = async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      const key = input.scope.relativePaths[0] ?? "";
      const pack = byPath.get(key);
      if (pack === undefined) throw new Error(`no fixture pack for ${key}`);
      return { pack, elapsedMs: 20, plan: { state: "ready" } as never };
    };

    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "scan concurrently" })),
      recordingDeps([]),
      undefined,
      seam(retriever, constAnswerer("done", { count: 0 })),
    );

    expect(result.status).toBe(200);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("AC5: a single connected scope routes through the legacy single-source runner, NOT the merge", async () => {
    const scope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("api"),
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

  // ─── Fail-soft: pack validation failure skips, not aborts ────────────────

  it("fail-soft: 1 bad source + 2 healthy → 200 with answer from healthy sources and skip in uncertainty", async () => {
    // Arrange: 3 scopes — scopeB returns an invalid pack (stableId: ""), the other two are healthy.
    // Before the fix this test was RED (retrieveAllSources returned 500 as soon as scopeB failed).
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("api"),
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: tempRoot("broken"),
    };
    const scopeC: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/c.ts"],
      connectedAtMs: NOW,
      root: tempRoot("web"),
    };
    const chatId = makeChat([scopeA, scopeB, scopeC]);
    const goodPack = scopePack("src/a.ts", 0.7, "good-a");
    const goodPackC = scopePack("src/c.ts", 0.5, "good-c");
    // Invalid pack: stableId is empty, which fails validateConnectedContextPack.
    const badPack: ConnectedContextPack = { ...scopePack("src/b.ts", 0.3, "bad-b"), stableId: "" };
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/a.ts", goodPack],
      ["src/b.ts", badPack],
      ["src/c.ts", goodPackC],
    ]);
    const answered = { count: 0 };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain all" })),
      recordingDeps([]),
      undefined,
      seam(packPerScope(byPath), constAnswerer("partial answer", answered)),
    );
    // Must succeed (200), not fail (500)
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("partial answer");
    // Answerer receives only the 2 healthy packs
    expect(answered.count).toBe(2);
    // Citations only from healthy sources
    const sources = answer.citations.map((c) => c.source);
    expect(sources).toContain("api");
    expect(sources).toContain("web");
    expect(sources).not.toContain("broken");
    // Skip surfaced in uncertainty
    const skippedEntries = answer.uncertainty.filter(
      (u) => u.kind === "source-skipped" && u.claim.includes("broken"),
    );
    expect(skippedEntries.length).toBeGreaterThan(0);
  });

  it("fail-soft: all sources bad → coded error returned (500 internal error)", async () => {
    // All 2 scopes return an invalid pack → no healthy source → must return a coded error.
    // Before the fix this test was GREEN (it already returned 500, but for the wrong reason).
    // After the fix the same path is taken only when ALL sources fail.
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("broken-a"),
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/b.ts"],
      connectedAtMs: NOW,
      root: tempRoot("broken-b"),
    };
    const chatId = makeChat([scopeA, scopeB]);
    const badPack = (path: string, id: string): ConnectedContextPack => ({
      ...scopePack(path, 0.3, id),
      stableId: "",
    });
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/a.ts", badPack("src/a.ts", "bad-a")],
      ["src/b.ts", badPack("src/b.ts", "bad-b")],
    ]);
    let answererCalled = false;
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain both" })),
      recordingDeps([]),
      undefined,
      seam(packPerScope(byPath), () => {
        answererCalled = true;
        return Promise.resolve("nope");
      }),
    );
    expect(result.status).toBe(500);
    expect(answererCalled).toBe(false);
  });
});

// Release 0.2.0 — ask-path defense-in-depth: a stored over-cap chat (legacy rows, or an operator
// who raised maxConnectedSources and later lowered it) must not fan out unboundedly. The first
// 16 folders (connection order) stay live; the rest surface as source-skipped uncertainty.
describe("handleGroundedAsk folder ask-path source cap (Release 0.2.0)", () => {
  it("explores at most maxConnectedSources folders and skips the rest with a notice", async () => {
    const scopes: ChatConnectedScope[] = Array.from({ length: 18 }, (_unused, i) => ({
      kind: "directory",
      relativePaths: [`src/f${String(i)}.ts`],
      connectedAtMs: NOW,
      root: tempRoot(`d${String(i)}`),
    }));
    const project = store.createProject(tmp, "demo");
    const chat = store.createChat(project.path, "Multi", CHAT_MODEL);
    // Build the over-cap row under a temporarily raised operator limit (the store's combined
    // source cap rejects growth past the default 16 otherwise).
    store.updateChat(chat.id, { connectedScopes: scopes }, { maxConnectedSources: 18 });
    const retrieved: string[] = [];
    const answered = { count: 0 };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId: chat.id, content: "explain all" })),
      recordingDeps([]),
      undefined,
      seam(
        (input) => {
          const key = input.scope.relativePaths[0] ?? "";
          retrieved.push(key);
          return Promise.resolve({
            pack: scopePack(key, 0.5, `body ${key}`),
            elapsedMs: 1,
            plan: { state: "ready" } as never,
          });
        },
        constAnswerer("capped answer", answered),
      ),
    );
    expect(result.status).toBe(200);
    // Only the first 16 folders (connection order) are explored.
    expect(retrieved).toHaveLength(16);
    expect(retrieved).not.toContain("src/f16.ts");
    expect(retrieved).not.toContain("src/f17.ts");
    expect(answered.count).toBe(16);
    // The two over-cap folders surface as source-skipped uncertainty (basename label only).
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    const overCap = answer.uncertainty.filter(
      (u) => u.kind === "source-skipped" && u.claim.includes("over the connected-source limit"),
    );
    expect(overCap).toHaveLength(2);
    expect(overCap.some((u) => u.claim.includes("d16"))).toBe(true);
    expect(overCap.some((u) => u.claim.includes("d17"))).toBe(true);
  });

  it("leaves an exactly-at-cap chat untouched (16 folders, no skip notice)", async () => {
    const scopes: ChatConnectedScope[] = Array.from({ length: 16 }, (_unused, i) => ({
      kind: "directory",
      relativePaths: [`src/f${String(i)}.ts`],
      connectedAtMs: NOW,
      root: tempRoot(`e${String(i)}`),
    }));
    const project = store.createProject(tmp, "demo");
    const chat = store.createChat(project.path, "Multi", CHAT_MODEL);
    store.updateChat(chat.id, { connectedScopes: scopes });
    const retrieved: string[] = [];
    const answered = { count: 0 };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId: chat.id, content: "explain all" })),
      recordingDeps([]),
      undefined,
      seam(
        (input) => {
          const key = input.scope.relativePaths[0] ?? "";
          retrieved.push(key);
          return Promise.resolve({
            pack: scopePack(key, 0.5, `body ${key}`),
            elapsedMs: 1,
            plan: { state: "ready" } as never,
          });
        },
        constAnswerer("full answer", answered),
      ),
    );
    expect(result.status).toBe(200);
    expect(retrieved).toHaveLength(16);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.uncertainty.some((u) => u.kind === "source-skipped")).toBe(false);
  });
});
