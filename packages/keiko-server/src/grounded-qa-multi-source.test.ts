import { reliableCitationRuntime } from "../../../tests/support/reliable-citation-runtime.js";
import { citationBehaviourFor } from "./grounded-citation-capability.js";
// Tests for the multi-source (1+N) grounded path (Epic #532). Pure helpers are exercised directly;
// the handler branch is driven through handleGroundedAsk with an injected MultiSourceSeam (a
// deterministic retriever + answerer) so no real workspace is spun up. AC5 — a single connected
// scope must produce the same answer shape as the legacy single-source runner — is asserted by
// routing one scope through both seams and comparing the wire object minus volatile ids.

import { failInvalidOmissionAssembly } from "../../../tests/support/invalid-context-assembly.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import type { ContextLaneId } from "@oscharko-dev/keiko-contracts";
import {
  CONTEXT_LANE_IDS,
  DEFAULT_CONTEXT_PROFILE,
  deriveContextProfile,
  maxUtf8BytesForTokenBudget,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  connectedContextOmittedCounts,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
  type ContextCoverageDiagnostics,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type {
  ChatConnectedScope,
  GroundedAnswer,
  GroundedAnswerContextPackSummary,
  GroundedAnswerContextSummary,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import {
  buildAnswerCitations,
  buildSelectedScopeFrom,
  handleGroundedAsk,
  modelWindowAwareBudget,
  modelInputPromptByteLimit,
  withPromptExcerptByteLimit,
  promptByteLength,
  type GroundedRunner,
  type MultiSourceSeam,
} from "./grounded-qa.js";
import { GROUNDED_PACK_VALIDATION_MESSAGE } from "./grounded-pack-validation.js";
import { sentPromptContext } from "./grounded-prompt-context.js";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import {
  buildLabeledAnswerCitations,
  groundedSourceScopeFingerprint,
  buildConnectedScopes,
  buildMultiSourceGatewayMessages,
  fittedMultiSourcePrompt,
  createMultiSourceAnswerer,
  mergeContextPackSummaries,
  runMultiSourceAsk,
  sourceLabels,
  splitExplorationBudget,
  splitExplorationBudgets,
  type LabeledPack,
  type GroundedRetriever,
  type MultiSourceAnswerer,
} from "./grounded-qa-multi-source.js";
import { buildGroundedAnswerContextPackSummary } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  groundedSynthesisAttemptUsage,
  normalizeGroundedAnswerPayload,
} from "./grounded-answer.js";
import { attachContextBudgetDiagnostics } from "./grounded-context-diagnostics.js";
import { createInMemoryUiStore, type Chat, type UiStore } from "./store/index.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { adoptReportedContextWindow } from "./gateway-context-window.js";
import { defaultServerDiagnosticSink, type ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  closeFileServerLogSinks,
  createServerLogger,
  setServerLogger,
} from "./observability/index.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { RouteContext } from "./routes.js";
import type { OrchestratorInput, OrchestratorOutput } from "./grounded-orchestrator.js";
import type { EntailmentStage } from "./grounded-entailment-stage.js";
import {
  PathDeniedError,
  RepoSearchUnsupportedFileError,
  WorkspaceNotFoundError,
} from "@oscharko-dev/keiko-workspace";
import {
  assumedChatCapability,
  ContextOverflowError,
  parseGatewayConfig,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

const NOW = 1_700_000_000_000;
const CHAT_MODEL = "example-chat-model";

let store: UiStore;
let tmp: string;

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface PutCall {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly sourceScopeFingerprint: string | undefined;
  readonly citationCount: number | undefined;
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
    correlationId: undefined,
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
        const parsed = JSON.parse(json) as {
          context?: { workspaceRoot?: string };
          connectedContext?: {
            scope: { sourceScopeFingerprint?: string };
            summary: { citationCount?: number };
          };
        };
        puts.push({
          runId,
          workspaceRoot: parsed.context?.workspaceRoot ?? "",
          sourceScopeFingerprint: parsed.connectedContext?.scope.sourceScopeFingerprint,
          citationCount: parsed.connectedContext?.summary.citationCount,
        });
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
    truncated: false,
    ignoredByDiscovery: 0,
    deniedByDiscovery: 0,
    depthPrunedByDiscovery: 0,
    maxFilesPrunedByDiscovery: 0,
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

function projectedBudget(
  budget: ConnectedContextPack["budget"],
): GroundedAnswerContextPackSummary["budget"] {
  return buildGroundedAnswerContextPackSummary(
    { ...scopePack("src/fixture.ts", 1, "budget"), budget },
    0,
    0,
  ).budget;
}

function budgetSum(
  budgets: readonly ConnectedContextPack["budget"][],
): ConnectedContextPack["budget"] {
  return mergeContextPackSummaries(
    budgets.map((budget, index) => {
      const pack = { ...scopePack("src/fixture.ts", 1, String(index)), budget };
      return buildGroundedAnswerContextPackSummary(pack, 1, 0);
    }),
  ).budget;
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

function concurrentTimedRetriever(clock: { now: number }): GroundedRetriever {
  const ready = deferred<boolean>();
  let started = 0;
  return async (input) => {
    started += 1;
    if (started === 2) {
      clock.now += 1_000;
      ready.resolve(true);
    }
    await ready.promise;
    return {
      pack: scopePack(input.scope.relativePaths[0] ?? "src/fallback.ts", 0.8, "evidence"),
      elapsedMs: 1_000,
      plan: { state: "ready" } as never,
    };
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

function aliasRelativePaths(kind: ChatConnectedScope["kind"], index: number): readonly string[] {
  if (kind === "workspace-root") return [];
  return kind === "files" ? [index === 0 ? "src/a.ts" : "src/b.ts"] : ["src"];
}

function modelBudgetDeps(configured: boolean): UiHandlerDeps {
  if (!configured) return recordingDeps([]);
  return recordingDeps([], {
    configPresent: true,
    config: parseGatewayConfig({
      providers: [
        {
          modelId: CHAT_MODEL,
          baseUrl: "https://provider.example.invalid/v1",
          apiKey: "fixture-only-key",
          timeoutMs: 30_000,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ],
      capabilities: [
        { ...assumedChatCapability(CHAT_MODEL), contextWindow: 128_000, maxOutputTokens: 8_000 },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
    }),
  });
}

function budgetReflectingRetriever(observed: ConnectedContextPack["budget"][]): GroundedRetriever {
  return (input) => {
    if (input.budget === undefined) throw new Error("Expected an allocated source budget");
    observed.push(input.budget);
    const path = input.scope.relativePaths[0] ?? "src/fallback.ts";
    const pack = { ...scopePack(path, 0.8, path), budget: input.budget };
    return Promise.resolve({ pack, elapsedMs: 1, plan: { state: "ready" } as never });
  };
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
  const query = {
    kind: "natural-language",
    text: "debug payments refund api",
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: NOW,
  } as const;

  const scopes: readonly ChatConnectedScope[] = [
    {
      kind: "directory",
      relativePaths: ["services/payments-api"],
      connectedAtMs: NOW,
      root: "/repo/services/payments-api",
    },
    {
      kind: "directory",
      relativePaths: ["web"],
      connectedAtMs: NOW,
      root: "/repo/web",
    },
    {
      kind: "directory",
      relativePaths: ["docs"],
      connectedAtMs: NOW,
      root: "/repo/docs",
    },
  ];

  it("returns the base unchanged for one scope", () => {
    const firstScope = scopes[0];
    if (firstScope === undefined) {
      throw new Error("expected first scope fixture");
    }
    expect(splitExplorationBudgets(DEFAULT_EXPLORATION_BUDGET, [firstScope], query)).toStrictEqual([
      DEFAULT_EXPLORATION_BUDGET,
    ]);
  });

  it("weights fan-out budgets toward query-relevant sources while preserving total caps", () => {
    const budgets = splitExplorationBudgets(DEFAULT_EXPLORATION_BUDGET, scopes, query);

    expect(budgets).toHaveLength(3);
    expect(budgetSum(budgets)).toStrictEqual(projectedBudget(DEFAULT_EXPLORATION_BUDGET));
    expect(budgets.every((budget) => budget.filesReadMax === null)).toBe(true);
    expect(budgets[0]?.excerptBytesMax).toBeGreaterThan(budgets[1]?.excerptBytesMax ?? 0);
    expect(budgets[1]?.excerptBytesMax).toBeGreaterThanOrEqual(budgets[2]?.excerptBytesMax ?? 0);
    expect(budgets.filter((budget) => budget.rerankCallsMax > 0)).toHaveLength(1);
  });

  it("does not multiply tiny dimensions when there are more sources than units", () => {
    const base = { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 1 };
    const budgets = splitExplorationBudgets(base, scopes, query);
    expect(budgetSum(budgets).filesReadMax).toBe(1);
    expect(
      budgets.filter((budget) => budget.filesReadMax !== null && budget.filesReadMax > 0),
    ).toHaveLength(1);
  });

  it("keeps the legacy equal split helper deterministic", () => {
    const split = splitExplorationBudget(DEFAULT_EXPLORATION_BUDGET, 3);
    expect(split.searchCallsMax).toBe(6);
    expect(split.filesReadMax).toBeNull();
    expect(
      splitExplorationBudget({ ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 32 }, 3).filesReadMax,
    ).toBe(11);
  });
});

describe("splitExplorationBudgets", () => {
  it("allocates more retrieval budget to a strongly referenced source", () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "directory", relativePaths: ["src/api.ts"], connectedAtMs: NOW, root: "/repo/api" },
      { kind: "directory", relativePaths: ["src/web.ts"], connectedAtMs: NOW, root: "/repo/web" },
      { kind: "directory", relativePaths: ["src/docs.ts"], connectedAtMs: NOW, root: "/repo/docs" },
    ];
    const budgets = splitExplorationBudgets(
      { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 30 },
      scopes,
      {
        kind: "natural-language",
        text: "Trace the api payment flow",
        caseSensitive: false,
        maxResults: 5,
        emittedAtMs: NOW,
      },
    );

    expect(budgets[0]?.filesReadMax).toBeGreaterThan(budgets[1]?.filesReadMax ?? 0);
    expect(budgets[0]?.searchCallsMax).toBeGreaterThan(budgets[2]?.searchCallsMax ?? 0);
    expect(budgets.every((budget) => budget.filesReadMax !== null)).toBe(true);
    expect(budgets.reduce((sum, budget) => sum + (budget.filesReadMax ?? 0), 0)).toBe(30);
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

  it("redacts a selected source label at the citation projection boundary", () => {
    const secret = "tenantcredentialvalue987";
    const redact = (value: unknown): unknown =>
      typeof value === "string" ? value.replaceAll(secret, "[REDACTED]") : value;

    const citations = buildLabeledAnswerCitations(
      scopePack("src/a.ts", 0.8, "a"),
      "Grounded [src/a.ts].",
      secret,
      redact,
    );

    expect(citations).toHaveLength(1);
    expect(citations[0]?.source).toBe("[REDACTED]");
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
  it("attributes unavailable counts and original line offsets to the correct source", () => {
    const base = scopePack("handbook/service.html", 1, "first");
    const first: ConnectedContextPack = {
      ...base,
      files: base.files.map((file) => ({
        ...file,
        excerpts: file.excerpts.map((excerpt) => ({
          ...excerpt,
          atom: { ...excerpt.atom, lineRange: { startLine: 182, endLine: 182 } },
          content: "Maintenance: 731 hours.",
        })),
      })),
      omittedCounts: { ...connectedContextOmittedCounts({ omitted: [] }), "tool-unavailable": 3 },
    };
    const messages = buildMultiSourceGatewayMessages(
      "Document the intervals",
      [
        { label: "manuals", pack: first },
        { label: "app", pack: scopePack("src/app.ts", 1, "second") },
      ],
      buildRedactor({}),
    );
    const [manuals, app] = (messages[1]?.content ?? "").split("### Source 2");
    expect(manuals).toContain("182 | Maintenance: 731 hours.");
    expect(manuals).toContain("- tool-unavailable: 3");
    expect(manuals).toContain("Candidate file evidence unavailable for reading/retrieval: 3.");
    expect(app).not.toContain("tool-unavailable: 3");
    expect(app).not.toContain("Candidate file evidence unavailable");
  });
  it("keeps exact aggregate omission counts attributed to their own source", () => {
    const first: ConnectedContextPack = {
      ...scopePack("src/a.ts", 1, "first"),
      omitted: [{ scopePath: "manuals/above.txt", reason: "size-exceeded", omittedAtMs: NOW }],
      omittedCounts: { ...connectedContextOmittedCounts({ omitted: [] }), "size-exceeded": 5000 },
    };
    const messages = buildMultiSourceGatewayMessages(
      "Explain size exclusions",
      [
        { label: "handbook", pack: first },
        { label: "app", pack: scopePack("src/b.ts", 1, "second") },
      ],
      buildRedactor({}),
    );
    const prompt = messages[1]?.content ?? "";
    const [handbook, app] = prompt.split("### Source 2");
    expect(handbook).toContain("omitted files: 5000");
    expect(handbook).toContain("Files excluded by file-size policy: 5000");
    expect(handbook).toContain("Additional excluded paths not listed: 4999");
    expect(app).not.toContain("5000");
    const summary = mergeContextPackSummaries([
      buildGroundedAnswerContextPackSummary(first, 1, 0),
      buildGroundedAnswerContextPackSummary(scopePack("src/b.ts", 1, "second"), 1, 0),
    ]);
    expect(summary.omittedCount).toBe(5001);
    expect(summary.omittedCounts["size-exceeded"]).toBe(5000);
  });

  it("keeps size-exclusion metadata inside its source and redacts sensitive path text", () => {
    const secret = "tenantcredentialvalue987";
    const first: ConnectedContextPack = {
      ...scopePack("src/a.ts", 1, "first"),
      omitted: [{ scopePath: `manuals/${secret}.html`, reason: "size-exceeded", omittedAtMs: NOW }],
    };
    const messages = buildMultiSourceGatewayMessages(
      "Which files exceeded the text size limit?",
      [
        { label: "handbook", pack: first },
        { label: "app", pack: scopePack("src/b.ts", 1, "second") },
      ],
      buildRedactor({ KEIKO_DEFAULT_API_KEY: secret }),
    );
    const prompt = messages[1]?.content ?? "";
    expect(prompt).toContain("reason=size-exceeded");
    expect(prompt).toContain("not file-content evidence");
    expect(prompt).not.toContain(secret);
    expect(prompt.indexOf("reason=size-exceeded")).toBeLessThan(prompt.indexOf("### Source 2"));
  });

  it("prunes prompt-only excerpt content to fit the summed model input budget", () => {
    const packA = scopePack("src/a.ts", 0.3, "low");
    const packB = scopePack("src/b.ts", 0.9, "high");
    const [budgetedA, budgetedB] = [packA, packB].map((pack) => ({
      ...pack,
      budget: { ...pack.budget, modelInputTokensMax: 1024 },
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
    expect(promptByteLength(messages)).toBeLessThanOrEqual(maxUtf8BytesForTokenBudget(1024 + 1024));
    expect(messages[1]?.content).toContain("Source 1: api");
    expect(messages[1]?.content).toContain("Source 2: web");
    expect(messages[1]?.content).toContain("[source:1|src/file.ts:10-20]");
    // PR #3678 review: the meter's share is that of the fitted prompt, never the unfitted packs.
    const sent = fittedMultiSourcePrompt(
      "explain both",
      [
        { label: "api", pack: budgetedA ?? packA },
        { label: "web", pack: budgetedB ?? packB },
      ],
      buildRedactor({}, undefined),
    );
    expect(sent.messages).toEqual(messages);
    const context = sentPromptContext(sent, 0, undefined);
    expect(context.promptTokens).toBe(countGatewayPromptTokens({ messages }));
    expect(context.sourceTokens).toBeLessThan(context.promptTokens);
  });

  // PR #3678 review: per-source budgets add up, so three sources could send three windows' worth
  // of excerpts to one model. The merged prompt must also fit the answering model's input budget.
  it("fits the merged prompt to the model's input budget, not the summed pack budgets", () => {
    const labeledPacks = ["a", "b", "c"].map((name) => {
      const pack = scopePack(`src/${name}.ts`, 0.5, name);
      return {
        label: name,
        pack: {
          ...pack,
          budget: { ...pack.budget, modelInputTokensMax: 64_000 },
          files: pack.files.map((file) => ({
            ...file,
            excerpts: file.excerpts.map((excerpt) => ({
              ...excerpt,
              content: `${name} evidence `.repeat(4_000),
              contentBytes: 44_000,
            })),
          })),
        },
      };
    });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const sent = fittedMultiSourcePrompt(
      "explain all",
      labeledPacks,
      buildRedactor({}),
      { modelInputTokensMax: 6_000 },
      "corr-ms-window-fit",
    );

    expect(countGatewayPromptTokens({ messages: sent.messages })).toBeLessThanOrEqual(6_000);
    expect(sent.availableReferenceCount).toBe(3);
    expect(JSON.stringify(sent.messages)).toContain("a evidence");
    // The fit decision lands on the existing window-fit port, on the request's correlation.
    const trimmed = expectActivityLogProof(
      "search.prompt.window-fitted.line",
      formatActivityLogProofLine(sink.events[0] ?? {}),
    );
    expect(trimmed).toMatchObject({
      correlationId: "corr-ms-window-fit",
      state: "trimmed",
      referenceCount: 3,
      sentReferenceCount: sent.sentReferenceCount,
      inputBudget: 6_000,
    });
    expect(() =>
      fittedMultiSourcePrompt(
        "explain all",
        labeledPacks,
        buildRedactor({}),
        { modelInputTokensMax: 16 },
        "corr-ms-window-refused",
      ),
    ).toThrow(ContextOverflowError);
    expect(sink.events.at(-1)).toMatchObject({
      correlationId: "corr-ms-window-refused",
      extra: { state: "refused", sentReferenceCount: 0, inputBudget: 16 },
    });
    resetServerLogger();
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

function omissionHeavySources(): readonly LabeledPack[] {
  return ["alpha", "beta"].map((label) => ({
    label,
    pack: {
      ...scopePack(`src/${label}.ts`, 0.7, label),
      omitted: Array.from({ length: 300 }, (_, index) => ({
        scopePath: `manuals/${label}/${"section-".repeat(20)}${String(index)}.html`,
        reason: "size-exceeded" as const,
        omittedAtMs: NOW,
      })),
      omittedCounts: { ...connectedContextOmittedCounts({ omitted: [] }), "size-exceeded": 300 },
    },
  }));
}

describe("multi-source minimal prompt admission", () => {
  afterEach(resetServerLogger);

  it.each([0, 16])("refuses zero-excerpt overhead above a %i token window", (budget) => {
    const packs = omissionHeavySources().map((entry) => ({
      ...entry,
      pack: { ...entry.pack, files: [] },
    }));
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    expect(() =>
      fittedMultiSourcePrompt(
        "Explain",
        packs,
        buildRedactor({}),
        { modelInputTokensMax: budget },
        "empty-overflow",
      ),
    ).toThrow(ContextOverflowError);
    expect(sink.events.at(-1)).toMatchObject({
      correlationId: "empty-overflow",
      extra: { state: "refused", referenceCount: 0, sentReferenceCount: 0, inputBudget: budget },
    });
  });

  it("measures refused overhead with omitted paths removed and exact counts retained", () => {
    const packs = omissionHeavySources();
    const minimal = packs.map((entry) => ({
      ...entry,
      pack: { ...withPromptExcerptByteLimit(entry.pack, 0), omitted: [] },
    }));
    const expected = fittedMultiSourcePrompt("Explain", minimal, buildRedactor({}));
    const expectedTokens = countGatewayPromptTokens({ messages: expected.messages });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    expect(() =>
      fittedMultiSourcePrompt(
        "Explain",
        packs,
        buildRedactor({}),
        { modelInputTokensMax: 16 },
        "minimal-refusal",
      ),
    ).toThrow(ContextOverflowError);
    expect(sink.events.at(-1)).toMatchObject({
      correlationId: "minimal-refusal",
      extra: { state: "refused", promptTokens: expectedTokens, inputBudget: 16 },
    });
  });

  it("distinguishes metadata-only reduction while preserving both evidence sources", () => {
    const packs = omissionHeavySources();
    const withoutPaths = packs.map((entry) => ({ ...entry, pack: { ...entry.pack, omitted: [] } }));
    const baseline = fittedMultiSourcePrompt("Explain", withoutPaths, buildRedactor({}));
    const inputBudget = countGatewayPromptTokens({ messages: baseline.messages }) + 100;
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const fitted = fittedMultiSourcePrompt(
      "Explain",
      packs,
      buildRedactor({}),
      { modelInputTokensMax: inputBudget },
      "metadata-fit",
    );
    expect(fitted.sentReferenceCount).toBe(2);
    expect(countGatewayPromptTokens({ messages: fitted.messages })).toBeLessThanOrEqual(
      inputBudget,
    );
    const prompt = fitted.messages[1]?.content ?? "";
    expect(prompt).toContain("body of src/alpha.ts");
    expect(prompt).toContain("body of src/beta.ts");
    expect(prompt.match(/Files excluded by file-size policy: 300\./gu)).toHaveLength(2);
    expect((prompt.match(/omitted path:/gu) ?? []).length).toBeLessThan(600);
    expect(sink.events.at(-1)).toMatchObject({
      correlationId: "metadata-fit",
      extra: { state: "metadata-trimmed", referenceCount: 2, sentReferenceCount: 2, inputBudget },
    });
    expectActivityLogProof(
      "search.prompt.window-fitted.line",
      formatActivityLogProofLine(sink.events.at(-1) ?? {}),
    );
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
    expect(merged.budget.filesReadMax).toBeNull();
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
  it("forwards validated assistant continuity hints to every source retriever", async () => {
    const scopes: ChatConnectedScope[] = ["a", "b"].map((name) => ({
      kind: "directory",
      root: tempRoot(name),
      relativePaths: [`src/${name}.ts`],
      connectedAtMs: NOW,
    }));
    const chat = store.findChatById(makeChat(scopes));
    if (chat === undefined) throw new TypeError("expected chat");
    const continuity = {
      assistantReferents: [{ path: "src/a.ts", line: 4, origin: "assistant" as const }],
      previousRetrievalIntent: "targeted-code-search" as const,
      continuityReferentSource: "assistant-paths" as const,
    };
    const retriever = vi.fn(
      packPerScope(
        new Map([
          ["src/a.ts", scopePack("src/a.ts", 0.5, "a")],
          ["src/b.ts", scopePack("src/b.ts", 0.5, "b")],
        ]),
      ),
    );
    const result = await runMultiSourceAsk({
      chat,
      scopes,
      content: "What about now?",
      modelId: CHAT_MODEL,
      contextProfile: undefined,
      deps: recordingDeps([]),
      signal: new AbortController().signal,
      retriever,
      answerer: () => Promise.resolve("ok"),
      ...continuity,
    });
    expect(result.status).toBe(200);
    expect(retriever).toHaveBeenCalledTimes(2);
    for (const [input] of retriever.mock.calls) expect(input).toMatchObject(continuity);
  });

  it.each([
    ["please paste validation.ts", "clarification", false],
    ["Missing evidence: [src/unread.ts]", "insufficiency", false],
    ["No evidence found in the connected scope.", "refusal", false],
    ["The service uses OAuth2. Which version do you mean?", "answer", true],
  ] as const)("projects conservative multi-source kind %s", async (content, kind, warns) => {
    const scopes: ChatConnectedScope[] = ["a", "b"].map((name) => ({
      kind: "directory",
      root: tempRoot(name),
      relativePaths: [`src/${name}.ts`],
      connectedAtMs: NOW,
    }));
    const chat = store.findChatById(makeChat(scopes));
    if (chat === undefined) throw new TypeError("expected chat");
    const result = await runMultiSourceAsk({
      chat,
      scopes,
      content: "Explain both files",
      modelId: CHAT_MODEL,
      contextProfile: undefined,
      deps: recordingDeps([]),
      signal: new AbortController().signal,
      insufficiencyScopeIndex: new Map([["src/unread.ts", "unread-in-scope"]]),
      retriever: packPerScope(
        new Map([
          ["src/a.ts", scopePack("src/a.ts", 0.5, "a")],
          ["src/b.ts", scopePack("src/b.ts", 0.5, "b")],
        ]),
      ),
      answerer: () => Promise.resolve(content),
    });
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.answerKind).toBe(kind);
    expect(answer.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(warns);
    expect(answer.uncertainty.some((marker) => marker.kind === "unsupported-citation")).toBe(false);
    if (kind === "insufficiency")
      expect(answer.insufficiencyDeclarations).toEqual([
        { scopePath: "src/unread.ts", state: "unread-in-scope" },
      ]);
  });

  it("removes unverified multi-source declaration text before wire and stored history", async () => {
    const scopes: ChatConnectedScope[] = ["a", "b"].map((name) => ({
      kind: "directory",
      root: tempRoot(name),
      relativePaths: [`src/${name}.ts`],
      connectedAtMs: NOW,
    }));
    const chat = store.findChatById(makeChat(scopes));
    if (chat === undefined) throw new TypeError("expected chat");
    const result = await runMultiSourceAsk({
      chat,
      scopes,
      content: "Explain both files",
      modelId: CHAT_MODEL,
      contextProfile: undefined,
      deps: recordingDeps([]),
      signal: new AbortController().signal,
      retriever: packPerScope(
        new Map([
          ["src/a.ts", scopePack("src/a.ts", 0.5, "a")],
          ["src/b.ts", scopePack("src/b.ts", 0.5, "b")],
        ]),
      ),
      answerer: () =>
        Promise.resolve({
          content:
            "I need the missing file to answer this question.\nMissing evidence: [private/outside.ts]",
          usage: { promptTokens: 0, completionTokens: 0 },
          insufficiencyDeclarations: [
            { scopePath: "private/outside.ts", state: "unread-in-scope" },
          ],
        }),
    });
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).not.toContain("private/outside.ts");
    expect(answer.insufficiencyDeclarations).toBeUndefined();
    expect(
      store.listMessages(chat.id).find((message) => message.role === "assistant")?.content,
    ).not.toContain("private/outside.ts");
  });
  it.each(["workspace-root", "directory", "files"] as const)(
    "attributes %s citations to selected aliases while reads use the canonical root",
    async (kind): Promise<void> => {
      const canonicalRoot = tempRoot("canonical-source");
      const scopes = ["FirstAlias", "second-alias"].map((name, index): ChatConnectedScope => {
        const root = join(tmp, name);
        symlinkSync(canonicalRoot, root, "dir");
        return {
          root,
          kind,
          relativePaths: aliasRelativePaths(kind, index),
          connectedAtMs: NOW,
        };
      });
      const chatId = makeChat(scopes);
      const chat = store.findChatById(chatId);
      if (chat === undefined) throw new TypeError("Missing alias fixture chat");
      const observed: string[] = [];
      const retriever: GroundedRetriever = (input) => {
        observed.push(input.scope.workspaceRoot);
        const path = observed.length === 1 ? "src/a.ts" : "src/b.ts";
        return Promise.resolve({
          pack: scopePack(path, 1, path),
          elapsedMs: 1,
          plan: { state: "ready" } as never,
        });
      };
      const result = await handleGroundedAsk(
        ctx(JSON.stringify({ chatId, content: "Explain both definitions" })),
        recordingDeps([]),
        undefined,
        seam(
          retriever,
          constAnswerer("First [src/a.ts:1-5]. Second [src/b.ts:1-5].", { count: 0 }),
        ),
      );
      expect(result.status).toBe(200);
      expect(observed).toEqual([realpathSync(canonicalRoot), realpathSync(canonicalRoot)]);
      expect(store.findChatById(chatId)?.connectedScopes).toEqual(scopes);
      const answer = asConnectedAnswer(result.body as GroundedAnswer);
      expect(answer.citations.map((citation) => citation.sourceScopeFingerprint)).toEqual(
        scopes.map((scope, index) =>
          groundedSourceScopeFingerprint(
            buildSelectedScopeFrom(chat, scope, `selected-${String(index)}`),
          ),
        ),
      );
      expect(
        new Set(answer.citations.map((citation) => citation.sourceScopeFingerprint)).size,
      ).toBe(2);
    },
  );

  it.each([false, true])(
    "projects the active model budget through two source allocations (configured=%s)",
    async (configured): Promise<void> => {
      const scopes: ChatConnectedScope[] = [
        { kind: "directory", relativePaths: ["src/a.ts"], connectedAtMs: NOW, root: tempRoot("a") },
        { kind: "directory", relativePaths: ["src/b.ts"], connectedAtMs: NOW, root: tempRoot("b") },
      ];
      const chat = store.findChatById(makeChat(scopes));
      if (chat === undefined) throw new Error("Expected a fixture chat");
      const deps = modelBudgetDeps(configured);
      const expected = projectedBudget(modelWindowAwareBudget(deps, CHAT_MODEL));
      const observed: ConnectedContextPack["budget"][] = [];
      const result = await runMultiSourceAsk({
        chat,
        scopes,
        content: "Explain both files",
        modelId: CHAT_MODEL,
        contextProfile: undefined,
        deps,
        retriever: budgetReflectingRetriever(observed),
        answerer: constAnswerer("The first file [src/a.ts:1-5].", { count: 0 }),
        signal: new AbortController().signal,
      });
      expect(result.status).toBe(200);
      expect(observed).toHaveLength(2);
      expect.soft(budgetSum(observed)).toEqual(expected);
      const answer = asConnectedAnswer(result.body as GroundedAnswer);
      expect(answer.contextPack.budget).toEqual(expected);
    },
  );

  // PR #3678 review: a local window refusal reached the error mapping without the request's
  // correlation, so its structured diagnostic fell back to the unknown correlation.
  it("joins an answer overflow's diagnostic to the ask's correlation", async () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "directory", relativePaths: ["src/a.ts"], connectedAtMs: NOW, root: tempRoot("x") },
      { kind: "directory", relativePaths: ["src/b.ts"], connectedAtMs: NOW, root: tempRoot("y") },
    ];
    const chat = store.findChatById(makeChat(scopes));
    if (chat === undefined) throw new Error("chat fixture missing");
    const records: ServerDiagnosticRecord[] = [];
    const packs = new Map<string, ConnectedContextPack>([
      ["src/a.ts", scopePack("src/a.ts", 0.8, "a")],
      ["src/b.ts", scopePack("src/b.ts", 0.7, "b")],
    ]);

    const result = await runMultiSourceAsk({
      chat,
      scopes,
      content: "Where is the handler?",
      modelId: CHAT_MODEL,
      contextProfile: undefined,
      deps: recordingDeps([], { diagnostics: { record: (record) => records.push(record) } }),
      retriever: packPerScope(packs),
      answerer: () => Promise.reject(new ContextOverflowError("prompt overhead exceeds the limit")),
      signal: new AbortController().signal,
      correlationId: "corr-ms-overflow",
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(records.map((record) => record.correlationId)).toContain("corr-ms-overflow");
  });

  it("keeps answer-only memory context out of every source retrieval query", async () => {
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
    const chat = store.findChatById(chatId);
    if (chat === undefined) throw new Error("chat fixture missing");
    const retrievalQueries: string[] = [];
    let answerQuestion = "";
    const packs = new Map<string, ConnectedContextPack>([
      ["src/a.ts", scopePack("src/a.ts", 0.8, "a")],
      ["src/b.ts", scopePack("src/b.ts", 0.7, "b")],
    ]);

    const result = await runMultiSourceAsk({
      chat,
      scopes,
      content: "Where is the handler?",
      answerContent:
        "User question:\nWhere is the handler?\n\nIncluded memory context:\nPrefer concise answers.",
      modelId: CHAT_MODEL,
      contextProfile: undefined,
      deps: recordingDeps([]),
      retriever: (input) => {
        retrievalQueries.push(input.query.text);
        return packPerScope(packs)(input);
      },
      answerer: (question) => {
        answerQuestion = question;
        return Promise.resolve("The handler is defined here [src/a.ts:1-5].");
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe(200);
    expect(retrievalQueries).toEqual(["Where is the handler?", "Where is the handler?"]);
    expect(retrievalQueries.join("\n")).not.toContain("Prefer concise answers");
    expect(answerQuestion).toContain("Prefer concise answers");
  });

  it.each([
    ["Find CompletelyMissingSymbol", "No matching evidence was found for this search."],
    ["Ist CompletelyMissingSymbol vorhanden?", "Keine passenden Belege für diese Suche gefunden."],
  ])(
    "localizes an empty multi-source search without calling the model: %s",
    async (content, expected) => {
      const scopes: ChatConnectedScope[] = ["src/a.ts", "src/b.ts"].map((path, index) => ({
        kind: "directory",
        relativePaths: [path],
        connectedAtMs: NOW,
        root: tempRoot(`empty-search-${String(index)}`),
      }));
      const chat = store.findChatById(makeChat(scopes));
      if (chat === undefined) throw new TypeError("chat fixture missing");
      const packs = new Map(
        scopes.map((scope) => {
          const path = scope.relativePaths[0] ?? "";
          return [path, { ...scopePack(path, 0.5, path), files: [], omitted: [] }] as const;
        }),
      );
      const result = await runMultiSourceAsk({
        chat,
        scopes,
        content,
        modelId: CHAT_MODEL,
        contextProfile: undefined,
        deps: recordingDeps([]),
        retriever: packPerScope(packs),
        answerer: () => {
          throw new TypeError("empty search must not invoke the model");
        },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe(200);
      const body = result.body as GroundedAnswer;
      expect(body.content).toBe(expected);
      expect(body.citations).toHaveLength(0);
      expect(body.evidenceRunId).toBeUndefined();
    },
  );

  it("keeps a memory-only answer ungrounded when every source has no evidence", async () => {
    const scopes: ChatConnectedScope[] = [
      {
        kind: "directory",
        relativePaths: ["src/a.ts"],
        connectedAtMs: NOW,
        root: tempRoot("memory-empty-a"),
      },
      {
        kind: "directory",
        relativePaths: ["src/b.ts"],
        connectedAtMs: NOW,
        root: tempRoot("memory-empty-b"),
      },
    ];
    const chatId = makeChat(scopes);
    const chat = store.findChatById(chatId);
    if (chat === undefined) throw new Error("chat fixture missing");
    const empty = (path: string): ConnectedContextPack => ({
      ...scopePack(path, 0.5, path),
      files: [],
    });
    const packs = new Map<string, ConnectedContextPack>([
      ["src/a.ts", empty("src/a.ts")],
      ["src/b.ts", empty("src/b.ts")],
    ]);
    let answererCalls = 0;

    const result = await runMultiSourceAsk({
      chat,
      scopes,
      content: "What package manager do I prefer?",
      answerContent:
        "User question:\nWhat package manager do I prefer?\n\nIncluded memory context:\nUse pnpm.",
      answerOnlyContextAvailable: true,
      modelId: CHAT_MODEL,
      contextProfile: undefined,
      deps: recordingDeps([]),
      retriever: packPerScope(packs),
      answerer: () => {
        answererCalls += 1;
        return Promise.resolve("You prefer pnpm; see [src/preferences.ts:42].");
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answererCalls).toBe(1);
    expect(answer.content).toContain("src/preferences.ts:42");
    expect(answer.citations).toEqual([]);
    expect(answer.contextPack.citationCount).toBe(0);
    expect(answer.evidenceRunId).toBeUndefined();
    expect(answer.evidenceRunIds).toEqual([]);
    expect(answer.uncertainty.some((marker) => marker.kind === "unsupported-citation")).toBe(true);
  });

  it("maps typed workspace errors safely while retaining the admitted user turn", async () => {
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
    expect(store.listMessages(chatId)).toMatchObject([{ role: "user", content: "explain both" }]);
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
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.contextPack.contextSummary).toBeDefined();
    expect(answer.citations).toEqual([]);
    expect(answer.uncertainty).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "uncited-answer",
          claim: expect.stringContaining("without a supported inline citation") as unknown,
        }),
      ]),
    );
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
      seam(retriever, constAnswerer("partial answer [src/a.ts] [src/c.ts]", answered)),
    );
    // One bad source must NOT abort the whole ask — the two healthy folders still answer.
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("partial answer [src/a.ts] [src/c.ts]");
    expect(answered.count).toBe(2); // answerer receives exactly the 2 healthy source packs
    const labels = answer.citations.map((c) => c.source);
    expect(labels).toContain("api");
    expect(labels).toContain("web");
    expect(labels).not.toContain("gone");
    const identities = answer.citations.map((citation) => citation.sourceScopeFingerprint);
    expect(identities).toHaveLength(2);
    expect(
      identities.every(
        (identity) => typeof identity === "string" && /^[0-9a-f]{64}$/u.test(identity),
      ),
    ).toBe(true);
    expect(new Set(identities).size).toBe(2);
    const skippedClaims = answer.uncertainty
      .filter((u) => u.kind === "source-skipped")
      .map((u) => u.claim)
      .join(" | ");
    expect(skippedClaims).toContain("gone");
    expect(skippedClaims).toContain("not readable");
  });

  it("keeps a skipped source root denial path-free while healthy sources answer", async () => {
    const healthy: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/a.ts"],
      connectedAtMs: NOW,
      root: tempRoot("healthy"),
    };
    const denied: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/denied.ts"],
      connectedAtMs: NOW,
      root: tempRoot("denied"),
    };
    const secondHealthy: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src/c.ts"],
      connectedAtMs: NOW,
      root: tempRoot("second-healthy"),
    };
    const chatId = makeChat([healthy, denied, secondHealthy]);
    const sensitivePath = join(tmp, ".aws", "customer-root");
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/a.ts", scopePack("src/a.ts", 0.8, "a")],
      ["src/c.ts", scopePack("src/c.ts", 0.7, "c")],
    ]);
    const retriever: GroundedRetriever = (input) =>
      input.scope.relativePaths[0] === "src/denied.ts"
        ? Promise.reject(new PathDeniedError(`denied source root: ${sensitivePath}`, sensitivePath))
        : packPerScope(byPath)(input);

    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain all" })),
      recordingDeps([]),
      undefined,
      seam(retriever, constAnswerer("partial answer [src/a.ts] [src/c.ts]", { count: 0 })),
    );

    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    const serialized = JSON.stringify(answer);
    expect(serialized).toContain("The workspace path is denied by policy.");
    expect(serialized).not.toContain(sensitivePath);
    expect(serialized).not.toContain("customer-root");
  });

  it("joins a skipped multi-source root to its request with the actual filesystem cause", async () => {
    const scopes: ChatConnectedScope[] = ["healthy", "gone"].map((name) => ({
      kind: "directory",
      relativePaths: [`src/${name}.ts`],
      connectedAtMs: NOW,
      root: tempRoot(name),
    }));
    const chatId = makeChat(scopes);
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const correlationId = "multi-source-root-failure";
    const failure = new WorkspaceNotFoundError("root disappeared", "/private/customer/root");
    failure.cause = Object.assign(new Error("filesystem-private-canary"), { code: "EACCES" });
    const retriever: GroundedRetriever = (input) =>
      input.scope.relativePaths[0] === "src/gone.ts"
        ? Promise.reject(failure)
        : Promise.resolve({
            pack: scopePack("src/healthy.ts", 0.8, "healthy"),
            elapsedMs: 11,
            plan: { state: "ready" } as never,
          });
    try {
      const result = await handleGroundedAsk(
        { ...ctx(JSON.stringify({ chatId, content: "explain all" })), correlationId },
        recordingDeps([]),
        undefined,
        seam(retriever, constAnswerer("healthy answer [src/healthy.ts]", { count: 0 })),
      );
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).toContain("Connected scope root is not accessible.");
      const failures = sink.events.filter((event) => event.op === "workspace.root.denied");
      expect(failures).toHaveLength(1);
      const line = formatActivityLogProofLine(failures[0] ?? {});
      expect(expectActivityLogProof("workspace.root.denied.line", line)).toMatchObject({
        correlationId,
        failureKind: "EACCES",
        errorKind: "permission-denied",
        causeChain: ["Error"],
      });
      expect(JSON.stringify([result.body, line])).not.toContain("filesystem-private-canary");
      expect(JSON.stringify([result.body, line])).not.toContain("/private/customer/root");
    } finally {
      resetServerLogger();
    }
  });

  it("measures total answer wall time across concurrent retrieval and delayed model response", async () => {
    const scopes: ChatConnectedScope[] = ["a", "b"].map((name) => ({
      kind: "directory",
      relativePaths: [`src/${name}.ts`],
      connectedAtMs: NOW,
      root: tempRoot(name),
    }));
    const clock = { now: NOW };
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    try {
      const answerer: MultiSourceAnswerer = () => {
        clock.now += 35_000;
        return Promise.resolve("evidence [src/a.ts:1-5] [src/b.ts:1-5]");
      };
      const result = await handleGroundedAsk(
        ctx(JSON.stringify({ chatId: makeChat(scopes), content: "explain both" })),
        recordingDeps([]),
        undefined,
        seam(concurrentTimedRetriever(clock), answerer),
      );
      expect(result.status).toBe(200);
      const answer = asConnectedAnswer(result.body as GroundedAnswer);
      expect(answer.elapsedMs).toBe(36_000);
      expect(answer.contextPack.elapsedMs).toBe(36_000);
      expect(answer.contextPack.usage.elapsedMs).toBe(14);
    } finally {
      now.mockRestore();
    }
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
      seam(packPerScope(byPath), constAnswerer("merged answer [src/a.ts] [src/b.ts]", answered)),
    );
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("merged answer [src/a.ts] [src/b.ts]");
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
    expect(answer.contextPack.budget.filesReadMax).toBeNull();
    expect(answer.uncertainty).toHaveLength(2);
  });

  it.each(["[src/shared.ts:1-5]", "`src/shared.ts:1-5`", "src/shared.ts:1-5"])(
    "fails closed for a multi-source ambiguous location: %s",
    async (ambiguous) => {
      const scopeA: ChatConnectedScope = {
        kind: "directory",
        relativePaths: ["source-a"],
        connectedAtMs: NOW,
        root: tempRoot("api"),
      };
      const scopeB: ChatConnectedScope = {
        kind: "directory",
        relativePaths: ["source-b"],
        connectedAtMs: NOW,
        root: tempRoot("web"),
      };
      const result = await handleGroundedAsk(
        ctx(JSON.stringify({ chatId: makeChat([scopeA, scopeB]), content: "explain shared" })),
        recordingDeps([]),
        undefined,
        seam(
          packPerScope(
            new Map([
              ["source-a", scopePack("src/shared.ts", 0.8, "shared-a")],
              ["source-b", scopePack("src/shared.ts", 0.7, "shared-b")],
            ]),
          ),
          constAnswerer(`Ambiguous claim ${ambiguous}.`, { count: 0 }),
        ),
      );

      expect(result.status).toBe(200);
      const answer = asConnectedAnswer(result.body as GroundedAnswer);
      expect(answer.citations).toEqual([]);
      expect(answer.uncertainty.some((marker) => marker.kind === "unsupported-citation")).toBe(
        true,
      );
    },
  );

  it("attributes an identical path only to its explicitly cited source ordinal", async () => {
    const scopeA: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["source-a"],
      connectedAtMs: NOW,
      root: tempRoot("api"),
    };
    const scopeB: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["source-b"],
      connectedAtMs: NOW,
      root: tempRoot("web"),
    };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId: makeChat([scopeA, scopeB]), content: "explain shared" })),
      recordingDeps([]),
      undefined,
      seam(
        packPerScope(
          new Map([
            ["source-a", scopePack("src/shared.ts", 0.8, "shared-a")],
            ["source-b", scopePack("src/shared.ts", 0.7, "shared-b")],
          ]),
        ),
        constAnswerer("Second source [source:2|src/shared.ts:1-5].", { count: 0 }),
      ),
    );

    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("Second source [source:2|src/shared.ts:1-5].");
    expect(answer.citations).toMatchObject([
      { source: "web", stableId: "shared-b", lineRange: { startLine: 1, endLine: 5 } },
    ]);
    expect(answer.uncertainty.some((marker) => marker.kind === "unsupported-citation")).toBe(false);
  });

  it("matches citations after redaction and never exposes an unredacted source label", async () => {
    const secret = "tenantcredentialvalue987";
    const secretPath = `src/${secret}.ts`;
    const source: ChatConnectedScope = {
      kind: "directory",
      relativePaths: [secretPath],
      connectedAtMs: NOW,
      root: tempRoot("source-root"),
    };
    const safePath = "src/safe.ts";
    const safeSource: ChatConnectedScope = {
      kind: "directory",
      relativePaths: [safePath],
      connectedAtMs: NOW,
      root: tempRoot("safe-root"),
    };
    const chatId = makeChat([source, safeSource]);
    const env = { KEIKO_DEFAULT_API_KEY: secret };
    const secretPack = scopePack(secretPath, 0.8, "secret-path");
    const redactor = buildRedactor(env);
    expect(buildAnswerCitations(secretPack, `Grounded [${secretPath}].`, redactor)).toHaveLength(1);
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      recordingDeps([], { env, redactor }),
      undefined,
      seam(
        packPerScope(
          new Map([
            [secretPath, secretPack],
            [safePath, scopePack(safePath, 0.4, "safe-path")],
          ]),
        ),
        constAnswerer(`Grounded [${secretPath}].`, { count: 0 }),
      ),
    );

    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("Grounded [src/[REDACTED].ts].");
    expect(answer.evidenceRunIds).toHaveLength(2);
    expect(answer.citations).toHaveLength(1);
    expect(JSON.stringify(answer.citations)).not.toContain(secret);
    expect(answer.citations[0]?.scopePath).toContain("[REDACTED]");
    expect(answer.citations[0]?.source).toBe("source-root");
  });

  it("passes relevance-weighted budgets to per-source retrievers", async () => {
    const scopePayments: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["services/payments-api"],
      connectedAtMs: NOW,
      root: tempRoot("payments-api"),
    };
    const scopeWeb: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["apps/web"],
      connectedAtMs: NOW,
      root: tempRoot("web"),
    };
    const scopeDocs: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["docs"],
      connectedAtMs: NOW,
      root: tempRoot("docs"),
    };
    const chatId = makeChat([scopePayments, scopeWeb, scopeDocs]);
    const byPath = new Map<string, ConnectedContextPack>([
      ["services/payments-api", scopePack("services/payments-api/src/controller.ts", 0.9, "pay")],
      ["apps/web", scopePack("apps/web/src/client.ts", 0.5, "web")],
      ["docs", scopePack("docs/payments.md", 0.2, "docs")],
    ]);
    const seenBudgets = new Map<string, ConnectedContextPack["budget"]>();
    const retriever: GroundedRetriever = (input) => {
      const key = input.scope.relativePaths[0] ?? "";
      const pack = byPath.get(key);
      if (pack === undefined) throw new Error(`no fixture pack for ${key}`);
      const budget = input.budget ?? DEFAULT_EXPLORATION_BUDGET;
      seenBudgets.set(key, budget);
      const excerptBytes = pack.files.reduce(
        (sum, file) =>
          sum + file.excerpts.reduce((fileSum, excerpt) => fileSum + excerpt.contentBytes, 0),
        0,
      );
      const candidatePack = {
        ...pack,
        scope: input.scope,
        budget,
        usage: { ...pack.usage, excerptBytes },
        omitted: [],
      };
      return Promise.resolve({
        pack: candidatePack,
        elapsedMs: 11,
        plan: { state: "ready" } as never,
      });
    };

    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "debug payments api refund" })),
      recordingDeps([]),
      undefined,
      seam(retriever, constAnswerer("weighted answer", { count: 0 })),
    );

    expect(result.status).toBe(200);
    expect(budgetSum([...seenBudgets.values()])).toStrictEqual(
      projectedBudget(DEFAULT_EXPLORATION_BUDGET),
    );
    expect(seenBudgets.get("services/payments-api")?.excerptBytesMax).toBeGreaterThan(
      seenBudgets.get("apps/web")?.excerptBytesMax ?? 0,
    );
    expect(seenBudgets.get("apps/web")?.excerptBytesMax).toBeGreaterThanOrEqual(
      seenBudgets.get("docs")?.excerptBytesMax ?? 0,
    );
    expect([...seenBudgets.values()].filter((budget) => budget.rerankCallsMax > 0)).toHaveLength(1);
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
    expect(store.listMessages(chatId)).toMatchObject([{ role: "user", content: "explain both" }]);
  });

  it("does not answer after a disconnected multi-source retriever resolves late", async () => {
    const scopes: ChatConnectedScope[] = [
      {
        kind: "directory",
        relativePaths: ["src/a.ts"],
        connectedAtMs: NOW,
        root: tempRoot("late-retriever-a"),
      },
      {
        kind: "directory",
        relativePaths: ["src/b.ts"],
        connectedAtMs: NOW,
        root: tempRoot("late-retriever-b"),
      },
    ];
    const chatId = makeChat(scopes);
    const retrieval = deferred<Awaited<ReturnType<GroundedRetriever>>>();
    const retrievalStarted = deferred<undefined>();
    let retrievalCalls = 0;
    let answerCalls = 0;
    const res = fakeRes();
    const outcome = handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "late retrieval" }), res),
      recordingDeps([]),
      undefined,
      seam(
        () => {
          retrievalCalls += 1;
          if (retrievalCalls === scopes.length) retrievalStarted.resolve(undefined);
          return retrieval.promise;
        },
        () => {
          answerCalls += 1;
          return Promise.resolve("must not answer");
        },
      ),
    );
    await retrievalStarted.promise;

    res.emit("close");

    await expect(outcome).resolves.toMatchObject({ status: 499 });
    retrieval.resolve({
      pack: { ...scopePack("src/a.ts", 0.5, "late"), files: [] },
      elapsedMs: 1,
      plan: { state: "ready" } as never,
    });
    await Promise.resolve();
    expect(answerCalls).toBe(0);
    expect(store.listMessages(chatId)).toMatchObject([{ role: "user", content: "late retrieval" }]);
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
    const chat = store.findChatById(chatId);
    if (chat === undefined) throw new TypeError("expected chat");
    expect(puts.map((entry) => entry.sourceScopeFingerprint)).toEqual(
      [scopeA, scopeB].map((scope) =>
        groundedSourceScopeFingerprint(buildSelectedScopeFrom(chat, scope, "identity")),
      ),
    );
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
      seam(
        packPerScope(byPath),
        constAnswerer(scopes.map((scope) => `[${scope.relativePaths[0] ?? ""}]`).join(" "), {
          count: 0,
        }),
      ),
    );
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.citations).toHaveLength(16);
    expect(puts).toHaveLength(16);
  });

  it("aborts active source siblings and stops queued scopes after a fatal failure", async () => {
    const scopes: ChatConnectedScope[] = Array.from({ length: 8 }, (_, index) => ({
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: NOW,
      root: tempRoot(`fatal-source-${String(index)}`),
    }));
    const chat = store.findChatById(makeChat(scopes));
    if (chat === undefined) throw new Error("Missing fanout chat");
    const parent = new AbortController();
    const release = deferred<undefined>();
    const failure = new TypeError("fatal source fixture");
    const signals: (AbortSignal | undefined)[] = [];
    const run = runMultiSourceAsk({
      chat,
      scopes,
      content: "Trace the handler",
      modelId: CHAT_MODEL,
      contextProfile: undefined,
      deps: recordingDeps([]),
      signal: parent.signal,
      retriever: async (_input, signal) => {
        signals.push(signal);
        if (signals.length === 1) throw failure;
        await release.promise;
        signal?.throwIfAborted();
        throw new Error("sibling should have been cancelled");
      },
      answerer: () => {
        throw new Error("failed retrieval must not answer");
      },
    });
    try {
      await expect(run).rejects.toBe(failure);
      expect(signals).toHaveLength(4);
      expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
      expect(signals.every((signal) => signal?.reason === failure)).toBe(true);
      expect(parent.signal.aborted).toBe(false);
    } finally {
      release.resolve(undefined);
      await setImmediate();
    }
    expect(signals).toHaveLength(4);
  });

  it("persists the original mapped fanout failure once under the actual request", async () => {
    const scopes: ChatConnectedScope[] = ["one", "two"].map((name) => ({
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: NOW,
      root: tempRoot(name),
    }));
    const chat = store.findChatById(makeChat(scopes));
    if (chat === undefined) throw new TypeError("Missing fanout diagnostic chat");
    const stateDir = join(tmp, "fanout-diagnostic");
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new ContextOverflowError("private-fanout-error-canary");
    failure.cause = new TypeError("private-fanout-cause-canary");
    try {
      const result = await runMultiSourceAsk({
        chat,
        scopes,
        content: "Trace",
        modelId: CHAT_MODEL,
        contextProfile: undefined,
        deps: recordingDeps([], { diagnostics: defaultServerDiagnosticSink }),
        signal: new AbortController().signal,
        correlationId: "fanout-original-request",
        retriever: () => Promise.reject(failure),
        answerer: vi.fn<MultiSourceAnswerer>(),
      });
      expect(result.status).toBe(502);
      closeFileServerLogSinks();
      const lines = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "server.diagnostic.failure",
      );
      expect(lines).toHaveLength(1);
      expect(
        expectActivityLogProof("server.diagnostic.failure.activity-log-line", lines[0] ?? ""),
      ).toMatchObject({
        correlationId: "fanout-original-request",
        diagnosticErrorClass: "ContextOverflowError",
        code: "GATEWAY_CONTEXT_OVERFLOW",
        causeChain: ["TypeError"],
      });
      expect(lines.join("\n")).not.toContain("private-fanout-");
    } finally {
      stderr.mockRestore();
      closeFileServerLogSinks();
      vi.unstubAllEnvs();
    }
  });

  it("maps a pre-cancelled fanout to 499 without starting a source", async () => {
    const scopes: ChatConnectedScope[] = [
      {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: NOW,
        root: tempRoot("cancelled-fanout"),
      },
    ];
    const chat = store.findChatById(makeChat(scopes));
    if (chat === undefined) throw new Error("Missing cancellation chat");
    const parent = new AbortController();
    parent.abort();
    const retriever = vi.fn<GroundedRetriever>();
    const answerer = vi.fn<MultiSourceAnswerer>();
    await expect(
      runMultiSourceAsk({
        chat,
        scopes,
        content: "Trace",
        modelId: CHAT_MODEL,
        contextProfile: undefined,
        deps: recordingDeps([]),
        signal: parent.signal,
        retriever,
        answerer,
      }),
    ).resolves.toMatchObject({ status: 499 });
    expect(retriever).not.toHaveBeenCalled();
    expect(answerer).not.toHaveBeenCalled();
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

  it("skips a closed assembler omission failure while preserving a healthy source", async () => {
    const scopes: ChatConnectedScope[] = [
      {
        kind: "directory",
        relativePaths: ["src/a.ts"],
        root: tempRoot("healthy"),
        connectedAtMs: NOW,
      },
      {
        kind: "directory",
        relativePaths: ["src/b.ts"],
        root: tempRoot("broken"),
        connectedAtMs: NOW,
      },
    ];
    const chatId = makeChat(scopes);
    const healthy = packPerScope(new Map([["src/a.ts", scopePack("src/a.ts", 0.7, "healthy")]]));
    const retrieve: GroundedRetriever = (input) =>
      input.scope.relativePaths.includes("src/b.ts")
        ? failInvalidOmissionAssembly(input.scope)
        : healthy(input);
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "Explain both sources" })),
      recordingDeps([]),
      undefined,
      seam(retrieve, constAnswerer("observed [src/a.ts:1]", { count: 0 })),
    );
    expect(result.status).toBe(200);
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.citations.some((citation) => citation.source === "healthy")).toBe(true);
    expect(
      answer.uncertainty.some(
        (marker) => marker.kind === "source-skipped" && marker.claim.includes("broken"),
      ),
    ).toBe(true);
    expect(answer.uncertainty.find((marker) => marker.kind === "source-skipped")?.claim).toContain(
      GROUNDED_PACK_VALIDATION_MESSAGE,
    );
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
    const records: ServerDiagnosticRecord[] = [];
    const correlationId = "multi-pack-validation-review";
    const result = await handleGroundedAsk(
      { ...ctx(JSON.stringify({ chatId, content: "explain all" })), correlationId },
      recordingDeps([], { diagnostics: { record: (record) => records.push(record) } }),
      undefined,
      seam(packPerScope(byPath), constAnswerer("partial answer [src/a.ts] [src/c.ts]", answered)),
    );
    // Must succeed (200), not fail (500)
    expect(result.status).toBe(200);
    const validationRecords = records.filter(
      (record) => record.diagnosticStage === "grounded-pack-validation",
    );
    expect(validationRecords).toHaveLength(1);
    expect(validationRecords[0]).toMatchObject({
      correlationId,
      sourceIndex: 1,
      diagnosticOutcome: "source-skipped",
      validationReasons: ["stable-id"],
      violationCount: 1,
      validatorThrew: false,
    });
    expect(validationRecords[0]).not.toHaveProperty("httpStatus");
    const answer = asConnectedAnswer(result.body as GroundedAnswer);
    expect(answer.content).toBe("partial answer [src/a.ts] [src/c.ts]");
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
    expect(skippedEntries[0]?.claim).toContain(GROUNDED_PACK_VALIDATION_MESSAGE);
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
    const records: ServerDiagnosticRecord[] = [];
    const correlationId = "multi-pack-validation-review";
    const result = await handleGroundedAsk(
      { ...ctx(JSON.stringify({ chatId, content: "explain both" })), correlationId },
      recordingDeps([], { diagnostics: { record: (record) => records.push(record) } }),
      undefined,
      seam(packPerScope(byPath), () => {
        answererCalled = true;
        return Promise.resolve("nope");
      }),
    );
    expect(result).toMatchObject({ status: 500, body: { error: { correlationId } } });
    expect(records.filter((record) => record.diagnosticOutcome === "source-skipped")).toHaveLength(
      2,
    );
    expect(records.at(-1)).toMatchObject({
      correlationId,
      diagnosticOutcome: "request-failed",
      httpStatus: 500,
    });
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

// ─── KEIKO-0237 (#2901) ─────────────────────────────────────────────────────
// Pin the second call site the hybrid-side test does not cover: multi-source entailment
// forwards `retrieved.map(source => source.pack)` to the judge. Without an assertion here,
// a regression that passed `[]` or the wrong pack set to the multi-source stage would still
// leave the finding's coverage bar green through the hybrid test alone (Codex, #3201).
describe("multi-source entailment forwards the retrieved packs (KEIKO-0237)", () => {
  it("hands the judge the pack set the retriever returned, in scope order", async () => {
    const scopes: readonly ChatConnectedScope[] = [
      {
        kind: "directory",
        relativePaths: ["src/alpha.ts"],
        connectedAtMs: NOW,
        root: tempRoot("ms-a"),
      },
      {
        kind: "directory",
        relativePaths: ["src/beta.ts"],
        connectedAtMs: NOW,
        root: tempRoot("ms-b"),
      },
    ];
    const chatId = makeChat(scopes);
    const byPath = new Map<string, ConnectedContextPack>([
      ["src/alpha.ts", scopePack("src/alpha.ts", 0.6, "atom-alpha")],
      ["src/beta.ts", scopePack("src/beta.ts", 0.6, "atom-beta")],
    ]);

    const observedPacks: (readonly ConnectedContextPack[])[] = [];
    const observedCapsulesPerCall: number[] = [];
    const seenAnswerer = { count: 0 };

    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "trace packs" })),
      recordingDeps([]),
      undefined,
      {
        retriever: packPerScope(byPath),
        answerer: constAnswerer("multi-source sentinel", seenAnswerer),
        entailmentStageFactory: (input) => {
          observedCapsulesPerCall.push(input.capsules.length);
          return {
            evaluate: (
              _answer: string,
              packs: readonly ConnectedContextPack[],
              _now: number,
            ): Promise<readonly never[]> => {
              observedPacks.push(packs);
              return Promise.resolve([]);
            },
            evaluateNumeric: (): Promise<readonly never[]> => Promise.resolve([]),
          };
        },
      },
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(observedPacks).toHaveLength(1);
    const forwardedIds = (observedPacks[0] ?? []).map((pack) => pack.stableId);
    expect(forwardedIds).toEqual(["pack-atom-alpha", "pack-atom-beta"]);
    // Multi-source is folder-only; the stage always sees an empty capsule list here (folder scopes
    // carry no capsule). Pin that explicitly so a regression that starts forwarding capsules
    // through the multi-source branch is visible.
    expect(observedCapsulesPerCall).toEqual([0]);
  });
});

describe("multi-source bounded citation repair", () => {
  afterEach(resetServerLogger);
  interface RepairControls {
    readonly failure?: Error;
    readonly inputMax?: number;
    readonly outputMax?: number;
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly gatewayConfig?: UiHandlerDeps["gatewayConfig"];
  }

  interface RepairProof {
    readonly calls: GatewayCallRequest[];
    readonly puts: PutCall[];
    readonly diagnostics: ServerDiagnosticRecord[];
    readonly answer: ReturnType<typeof asConnectedAnswer>;
    readonly logLines: readonly string[];
  }

  function repairModel(
    calls: GatewayCallRequest[],
    repaired: string,
    original: string,
    controls: RepairControls,
  ): ModelPort {
    return {
      call: (request): Promise<NormalizedResponse> => {
        calls.push(request);
        if (calls.length > 1 && controls.failure !== undefined)
          return Promise.reject(controls.failure);
        return Promise.resolve({
          modelId: CHAT_MODEL,
          content: calls.length === 1 ? original : repaired,
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "bounded-repair",
            promptTokens: controls.promptTokens ?? 10,
            completionTokens: controls.completionTokens ?? 4,
            latencyMs: 1,
            costClass: "medium",
          },
        });
      },
    };
  }

  function repairSources(controls: RepairControls): {
    readonly scopes: readonly ChatConnectedScope[];
    readonly retriever: GroundedRetriever;
  } {
    const packs = ["alpha", "beta"].map((name) => {
      const pack = scopePack(`src/${name}.ts`, 0.8, name);
      return {
        ...pack,
        omitted: [],
        usage: { ...pack.usage, modelInputTokens: 0, modelOutputTokens: 0 },
      };
    });
    const scopes = packs.map((pack, index) => ({
      kind: "files" as const,
      relativePaths: [pack.files[0]?.scopePath ?? ""],
      connectedAtMs: NOW,
      root: tempRoot(`repair-${String(index)}`),
    }));
    const first = packs[0];
    if (first === undefined) throw new TypeError("Missing repair source");
    const allocations = splitExplorationBudgets(
      {
        ...DEFAULT_EXPLORATION_BUDGET,
        modelInputTokensMax: controls.inputMax ?? DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax,
        modelOutputTokensMax: controls.outputMax ?? DEFAULT_EXPLORATION_BUDGET.modelOutputTokensMax,
      },
      scopes,
      first.query,
    );
    const allocatedPacks = packs.map((pack, index) => {
      const budget = allocations[index];
      if (budget === undefined) throw new TypeError("Missing repair allocation");
      return { ...pack, budget };
    });
    return {
      scopes,
      retriever: async (input): Promise<OrchestratorOutput> => {
        const retrieved = await packPerScope(
          new Map(allocatedPacks.map((pack) => [pack.files[0]?.scopePath ?? "", pack])),
        )(input);
        return { ...retrieved, pack: { ...retrieved.pack, scope: input.scope } };
      },
    };
  }

  async function repairAsk(
    repaired: string,
    original = "The implementation works.",
    controls: RepairControls = {},
  ): Promise<RepairProof> {
    const calls: GatewayCallRequest[] = [];
    const puts: PutCall[] = [];
    const { scopes, retriever } = repairSources(controls);
    const chat = store.findChatById(makeChat(scopes));
    if (chat === undefined) throw new TypeError("Missing repair chat");
    const diagnostics: ServerDiagnosticRecord[] = [];
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const deps = recordingDeps(puts, {
      diagnostics: { record: (record) => diagnostics.push(record) },
      ...(controls.gatewayConfig === undefined ? {} : { gatewayConfig: controls.gatewayConfig }),
    });
    const signal = new AbortController().signal;
    const model = repairModel(calls, repaired, original, controls);
    const result = await runMultiSourceAsk({
      chat,
      scopes,
      content: "How does the implementation work?",
      modelId: CHAT_MODEL,
      contextProfile: undefined,
      deps,
      signal,
      correlationId: "corr-multi-repair",
      retriever,
      answerer: createMultiSourceAnswerer(deps, model, CHAT_MODEL, signal, "corr-multi-repair"),
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return {
      calls,
      puts,
      diagnostics,
      answer: asConnectedAnswer(result.body as GroundedAnswer),
      logLines: sink.events.map(formatActivityLogProofLine),
    };
  }

  function chargedRepairInput(calls: readonly GatewayCallRequest[]): number {
    return calls.reduce(
      (sum, call) =>
        sum +
        groundedSynthesisAttemptUsage(countGatewayPromptTokens(call), { promptTokens: 10 })
          .promptTokens,
      0,
    );
  }

  it("adds only supported source-two markers in one remaining-budget call", async () => {
    const repaired = "The implementation works [source:2|src/beta.ts:1-5].";
    const { calls, puts, answer, logLines } = await repairAsk(repaired);
    expect(calls).toHaveLength(2);
    const promptLines = logLines.filter((line) => line.includes('"op":"chat.context.selected"'));
    expect(promptLines).toHaveLength(2);
    const prompts = promptLines.map((line) =>
      expectActivityLogProof("chat.context.selected.budget", line),
    );
    expect(prompts[1]).toMatchObject({
      correlationId: "corr-multi-repair",
      inputBudget:
        DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax -
        groundedSynthesisAttemptUsage(countGatewayPromptTokens(calls[0] ?? { messages: [] }), {
          promptTokens: 10,
        }).promptTokens,
    });
    expect(prompts[1]?.promptTokens).toBe(
      countGatewayPromptTokens({ messages: calls[1]?.messages ?? [] }),
    );
    const repairPrompt = calls[1]?.messages.map((message) => message.content).join("\n");
    expect(repairPrompt).toContain("body of src/alpha.ts");
    expect(repairPrompt).toContain("body of src/beta.ts");
    expect(calls[1]?.maxOutputTokens).toBe(DEFAULT_EXPLORATION_BUDGET.modelOutputTokensMax - 4);
    expect(answer.content).toBe(repaired);
    expect(answer.citationBehaviour).toBe("cites-after-repair");
    expect(answer.citations.map((citation) => citation.scopePath)).toEqual(["src/beta.ts"]);
    expect(puts.map((put) => put.citationCount)).toEqual([0, 1]);
    expect(answer.contextPack.usage.modelInputTokens).toBe(chargedRepairInput(calls));
    expect(answer.contextPack.usage.modelOutputTokens).toBe(8);
    const details = logLines.filter((line) =>
      line.includes('"op":"search.connected-context.answer-details"'),
    );
    expect(
      details.map(
        (line) =>
          expectActivityLogProof("search.connected-context.answer-details.line", line)
            .filesInPrompt,
      ),
    ).toEqual([1, 1]);
  });

  it("attributes verified declaration counts only to their actual folder identity", async () => {
    const { calls, logLines } = await repairAsk("unused", "Missing evidence: [src/beta.ts]");
    expect(calls).toHaveLength(1);
    const details = logLines.filter((line) =>
      line.includes('"op":"search.connected-context.answer-details"'),
    );
    const observations = details.map((line) =>
      expectActivityLogProof("search.connected-context.answer-details.line", line),
    );
    expect(observations.map((observation) => observation.insufficiencyDeclaredCount)).toEqual([
      0, 1,
    ]);
    expect(observations.map((observation) => observation.declaredUnreadInScopeCount)).toEqual([
      0, 0,
    ]);
    expect(details.join("\n")).not.toContain("src/beta.ts");
  });

  it("retains original prose after a repair changes its claim and never attempts a third call", async () => {
    const { calls, answer } = await repairAsk(
      "The implementation fails [source:2|src/beta.ts:1-5].",
    );
    expect(calls).toHaveLength(2);
    expect(answer.content).toBe("The implementation works.");
    expect(answer.citationBehaviour).toBe("never");
    expect(answer.citations).toEqual([]);
    expect(answer.uncertainty.map((marker) => marker.kind)).toContain("uncited-answer");
    expect(answer.contextPack.usage.modelInputTokens).toBe(chargedRepairInput(calls));
  });

  it.each(["Which file should I inspect?", "No evidence found."])(
    "does not repair a non-claim answer: %s",
    async (original) => {
      const { calls, answer } = await repairAsk("Changed content.", original);
      expect(calls).toHaveLength(1);
      expect(answer.content).toBe(original);
      expect(answer.citationBehaviour).toBeUndefined();
    },
  );
  it.each([
    { inputMax: 1600, promptTokens: 1500 },
    { outputMax: 10, completionTokens: 10 },
  ])(
    "retains the original response when the shared remaining budget is exhausted: %j",
    async (controls) => {
      const { calls, answer } = await repairAsk(
        "The implementation works [source:2|src/beta.ts:1-5].",
        "The implementation works.",
        controls,
      );
      expect(calls).toHaveLength(1);
      expect(answer.content).toBe("The implementation works.");
      expect(answer.citationBehaviour).toBe("never");
      expect(answer.citations).toEqual([]);
    },
  );
  it("skips repair only for three current reliable citation observations", async () => {
    const configured = reliableCitationRuntime(tmp, CHAT_MODEL);
    try {
      expect(citationBehaviourFor(configured, CHAT_MODEL)).toBe("cites");
      const { calls, answer } = await repairAsk(
        "The implementation works [source:2|src/beta.ts:1-5].",
        "The implementation works.",
        { gatewayConfig: configured.gatewayConfig },
      );
      expect(calls).toHaveLength(1);
      expect(answer.content).toBe("The implementation works.");
      expect(answer.citationBehaviour).toBe("never");
      expect(citationBehaviourFor(configured, CHAT_MODEL)).toBeUndefined();
    } finally {
      await configured.dispose?.();
    }
  });

  it("preserves a failed repair's body-free error frames and cause chain", async () => {
    const failure = new TypeError("private-model-response", {
      cause: new Error("private-provider-detail"),
    });
    const { calls, answer, logLines } = await repairAsk("", "The implementation works.", {
      failure,
    });
    expect(calls).toHaveLength(2);
    expect(answer.content).toBe("The implementation works.");
    const failures = logLines.filter((line) =>
      line.includes('"op":"search.connected-context.answer-details"'),
    );
    expect(failures).toHaveLength(2);
    for (const line of failures) {
      const proof = expectActivityLogProof("search.connected-context.answer-details.line", line);
      expect(proof).toMatchObject({
        correlationId: "corr-multi-repair",
        level: "warn",
        errorKind: "internal",
        failureKind: "TypeError",
      });
      expect(proof.frames).toEqual(expect.arrayContaining([expect.any(String)]));
      expect(proof.causeChain).toEqual(["Error"]);
    }
    expect(logLines.join("\n")).not.toContain("private-model-response");
    expect(logLines.join("\n")).not.toContain("private-provider-detail");
  });
});

describe("multi-source final fitted citation authority", () => {
  function sourcePacks(): readonly ConnectedContextPack[] {
    return ["alpha", "beta"].map((name) => {
      const pack = scopePack(`src/${name}.ts`, 0.8, name);
      const content = "first line\nsecond line\nthird line\nfourth line\nfifth line";
      return {
        ...pack,
        usage: { ...pack.usage, excerptBytes: Buffer.byteLength(content) },
        files: pack.files.map((file) => ({
          ...file,
          excerpts: file.excerpts.map((excerpt) => ({
            ...excerpt,
            content,
            contentBytes: Buffer.byteLength(content),
          })),
        })),
      };
    });
  }

  async function fittedAsk(
    packs: readonly ConnectedContextPack[],
    sent: readonly ConnectedContextPack[],
    content: string,
    invocation: { readonly modelInvoked?: boolean; readonly noEvidence?: boolean } = {},
  ): Promise<{
    readonly answer: Extract<GroundedAnswer, { readonly groundingKind: "connected-context" }>;
    readonly puts: readonly PutCall[];
    readonly judged: readonly (readonly ConnectedContextPack[])[];
  }> {
    const puts: PutCall[] = [];
    const judged: (readonly ConnectedContextPack[])[] = [];
    const scopes = packs.map((pack, index) => ({
      kind: "files" as const,
      relativePaths: [pack.files[0]?.scopePath ?? ""],
      connectedAtMs: NOW,
      root: tempRoot(`fitted-${String(index)}`),
    }));
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId: makeChat(scopes), content: "Explain both files" })),
      recordingDeps(puts),
      undefined,
      {
        retriever: packPerScope(
          new Map(packs.map((pack) => [pack.files[0]?.scopePath ?? "", pack])),
        ),
        answerer: () =>
          Promise.resolve({
            content,
            ...invocation,
            usage: { promptTokens: 0, completionTokens: 0 },
            sentEvidencePacks: sent,
            filesInPrompt: sent.reduce((count, pack) => count + pack.files.length, 0),
          }),
        entailmentStageFactory: () => ({
          evaluate: (_answer, evidence): ReturnType<EntailmentStage["evaluate"]> => {
            judged.push(evidence);
            return Promise.resolve([]);
          },
          evaluateNumeric: (): ReturnType<EntailmentStage["evaluateNumeric"]> =>
            Promise.resolve([]),
        }),
      },
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return { answer: asConnectedAnswer(result.body as GroundedAnswer), puts, judged };
  }

  it("does not authenticate an assembled source when the final prompt sent zero excerpts", async () => {
    const packs = sourcePacks();
    const sent = packs.map((pack) => withPromptExcerptByteLimit(pack, 0));
    const { answer, puts, judged } = await fittedAsk(
      packs,
      sent,
      "The implementation works [source:1|src/alpha.ts:1-5].",
    );
    expect(answer.citations).toEqual([]);
    expect(answer.uncertainty.map((marker) => marker.kind)).toContain("unsupported-citation");
    expect(answer.contextPack.filesInPrompt).toBe(0);
    expect(answer.contextPack.fileCount).toBe(2);
    expect(puts.map((put) => put.citationCount)).toEqual([0, 0]);
    expect(judged).toEqual([sent]);
  });

  it("rejects a trimmed-away line while retaining the second source ordinal and actual judge evidence", async () => {
    const packs = sourcePacks();
    const sent = packs.map((pack, index) =>
      withPromptExcerptByteLimit(pack, index === 0 ? 11 : 100),
    );
    expect(sent[0]?.files[0]?.excerpts[0]?.atom.lineRange).toEqual({ startLine: 1, endLine: 1 });
    const { answer, puts, judged } = await fittedAsk(
      packs,
      sent,
      "First [source:1|src/alpha.ts:5]. Second [source:2|src/beta.ts:1-5].",
    );
    expect(answer.citations.map((citation) => citation.scopePath)).toEqual(["src/beta.ts"]);
    expect(answer.uncertainty.map((marker) => marker.kind)).toContain("unsupported-citation");
    expect(puts.map((put) => put.citationCount)).toEqual([0, 1]);
    expect(answer.contextPack.filesInPrompt).toBe(2);
    expect(judged).toEqual([sent]);
  });

  it("retains physical reads but attaches no manifest or entailment after final-fit abstention", async () => {
    const packs = sourcePacks();
    const sent = packs.map((pack) => withPromptExcerptByteLimit(pack, 0));
    const { answer, puts, judged } = await fittedAsk(packs, sent, "No evidence found.", {
      modelInvoked: false,
      noEvidence: true,
    });
    expect(puts).toEqual([]);
    expect(judged).toEqual([]);
    expect(answer.citations).toEqual([]);
    expect(answer.evidenceRunIds).toEqual([]);
    expect(answer.contextPack.usage.filesRead).toBe(2);
    expect(answer.contextPack.filesInPrompt).toBe(0);
  });

  it("keeps source two attributable when source one has no sent file", async () => {
    const packs = sourcePacks();
    const sent = packs.map((pack, index) =>
      withPromptExcerptByteLimit(pack, index === 0 ? 0 : 100),
    );
    const { answer, puts } = await fittedAsk(packs, sent, "Second [source:2|src/beta.ts:1-5].");
    expect(answer.citations.map((citation) => citation.scopePath)).toEqual(["src/beta.ts"]);
    expect(answer.uncertainty.map((marker) => marker.kind)).not.toContain("unsupported-citation");
    expect(answer.contextPack.filesInPrompt).toBe(1);
    expect(puts.map((put) => put.citationCount)).toEqual([0, 1]);
  });
});

// ─── Correlation threading (ADR-0173 D5) ──────────────────────────────────────
//
// createMultiSourceAnswerer is the real model.call site the tests above bypass via an injected
// MultiSourceSeam.answerer; unit-test it directly against a fake ModelPort that records the request.
function zeroModelUsagePack(pack: ConnectedContextPack): ConnectedContextPack {
  // This fixture derives its exact empty-prompt grant below. Prior model usage is deliberately
  // zero here; nonzero retrieval usage is covered by the configured semantic-refresh handler proof.
  return { ...pack, usage: { ...pack.usage, modelInputTokens: 0, modelOutputTokens: 0 } };
}

function assertFinalMultiSourceProjection(
  result: ReturnType<typeof normalizeGroundedAnswerPayload>,
  sentBody: string | undefined,
): void {
  expect(result.filesInPrompt).toBe(
    result.sentEvidencePacks?.filter((pack) => pack.files.length > 0).length,
  );
  for (const pack of result.sentEvidencePacks ?? []) {
    for (const file of pack.files) {
      for (const excerpt of file.excerpts) expect(sentBody).toContain(excerpt.content);
    }
  }
  for (const name of ["a", "b"]) {
    expect(result.evidenceScopeIndex?.get(`src/${name}.ts`) === "read-in-this-turn").toBe(
      sentBody?.includes(`${name} evidence`),
    );
  }
}

describe("createMultiSourceAnswerer correlation threading", () => {
  it("refuses a repair deadline that expires between timeout setup and actual dispatch", async () => {
    const call = vi.fn((): Promise<NormalizedResponse> =>
      Promise.resolve({
        modelId: CHAT_MODEL,
        content: "The implementation works.",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "deadline-race",
          promptTokens: 10,
          completionTokens: 4,
          latencyMs: 1,
          costClass: "medium",
        },
      }),
    );
    const packs = ["alpha", "beta"].map((name) => ({
      label: name,
      pack: scopePack(`src/${name}.ts`, 1, name),
    }));
    const answerer = createMultiSourceAnswerer(
      recordingDeps([]),
      { call },
      CHAT_MODEL,
      new AbortController().signal,
      "multi-repair-deadline",
    );
    const main = normalizeGroundedAnswerPayload(
      await answerer("Explain the implementation", packs),
    );
    const repair = answerer.repair;
    const first = packs[0]?.pack;
    if (repair === undefined || first === undefined) throw new TypeError("Missing repair callback");
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(99).mockReturnValue(100);
    try {
      const result = normalizeGroundedAnswerPayload(
        await repair("Explain the implementation", first, main.content, {
          modelInputTokensMax: DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax,
          modelOutputTokensMax: DEFAULT_EXPLORATION_BUDGET.modelOutputTokensMax,
          deadlineAtMs: 100,
        }),
      );
      expect(call).toHaveBeenCalledTimes(1);
      expect(result.modelInvoked).toBe(false);
      expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    } finally {
      now.mockRestore();
    }
  });
  it.each([false, true])(
    "avoids an empty fitted model call unless memory context is available (%s)",
    async (memory) => {
      const redactor = buildRedactor({});
      const labeled = ["alpha", "beta"].map((name) => ({
        label: name,
        pack: zeroModelUsagePack(scopePack(`src/${name}.ts`, 0.8, name)),
      }));
      const question = "What does the repository do?";
      const empty = labeled.map((entry) => ({
        ...entry,
        pack: withPromptExcerptByteLimit(entry.pack, 0),
      }));
      const emptyMessages = buildMultiSourceGatewayMessages(question, empty, redactor);
      let budget = countGatewayPromptTokens({ messages: emptyMessages });
      while (modelInputPromptByteLimit(budget) < promptByteLength(emptyMessages)) budget += 1;
      const first = labeled[0]?.pack;
      if (first === undefined) throw new TypeError("Missing source fixture");
      const allocations = splitExplorationBudgets(
        { ...first.budget, modelInputTokensMax: budget },
        labeled.map((entry) => ({
          root: entry.pack.scope.workspaceRoot,
          kind: "directory",
          relativePaths: ["src"],
          connectedAtMs: NOW,
        })),
        first.query,
      );
      const budgeted = labeled.map((entry, index) => {
        const allocation = allocations[index];
        if (allocation === undefined) throw new TypeError("Missing source allocation");
        return { ...entry, pack: { ...entry.pack, budget: allocation } };
      });
      const fitted = fittedMultiSourcePrompt(question, budgeted, redactor, {
        modelInputTokensMax: budget,
      });
      expect(fitted.sentReferenceCount).toBe(0);
      const profile = deriveContextProfile({
        maxInputTokens: budget + 512 + 64,
        reservedOutputTokens: 512,
        safetyMarginTokens: 64,
      });
      const call = vi.fn((request: GatewayCallRequest): Promise<NormalizedResponse> =>
        Promise.resolve({
          modelId: request.modelId,
          content: "Personal preference.",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "zero-source",
            promptTokens: 1,
            completionTokens: 1,
            latencyMs: 1,
            costClass: "medium",
          },
        }),
      );
      const answerer = createMultiSourceAnswerer(
        recordingDeps([], { redactor, contextProfileForModel: () => profile }),
        { call },
        CHAT_MODEL,
        new AbortController().signal,
        "zero-source",
        { currentQuestion: question, answerOnlyContextAvailable: memory },
      );
      const result = normalizeGroundedAnswerPayload(await answerer(question, budgeted));
      expect(call).toHaveBeenCalledTimes(memory ? 1 : 0);
      expect(result.modelInvoked).toBe(memory);
      expect(result.noEvidence).toBe(true);
      expect(result.filesInPrompt).toBe(0);
      if (memory) expect(result.content).toBe("Personal preference.");
    },
  );

  it("stamps the caller's correlation id into the Gateway double's GatewayCallRequest.logContext", async () => {
    const seenRequests: GatewayCallRequest[] = [];
    const recordingModel: ModelPort = {
      call(request): Promise<NormalizedResponse> {
        seenRequests.push(request);
        return Promise.resolve({
          modelId: request.modelId,
          content: "multi-source answer",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "multi-source-answerer-test",
            promptTokens: 3,
            completionTokens: 2,
            latencyMs: 1,
            costClass: "medium",
          },
        });
      },
    };

    const answerer = createMultiSourceAnswerer(
      recordingDeps([], { redactor: buildRedactor({}) }),
      recordingModel,
      "example-chat-model",
      new AbortController().signal,
      "cid-multi-source-answerer-000001",
      { answerOnlyContextAvailable: true },
    );
    // `MultiSourceAnswerer`'s declared return type is `Promise<GroundedAnswerPayload>` (a
    // `string | GroundedAnswerResult` union), even though `createMultiSourceAnswerer`'s own
    // implementation always resolves the object branch — `normalizeGroundedAnswerPayload` is the
    // SAME narrowing every production caller already applies to this result
    // (grounded-qa-multi-source.ts, grounded-orchestrator.ts), not a test-only cast.
    const empty = { ...scopePack("src/alpha.ts", 0.7, "alpha"), files: [] };
    const result = normalizeGroundedAnswerPayload(
      await answerer("What is alpha?", [{ label: "alpha", pack: empty }]),
    );

    expect(result.content).toBe("multi-source answer");
    expect(result.evidenceScopeIndex?.size).toBe(0);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.logContext?.correlationId).toBe("cid-multi-source-answerer-000001");
    expect(result.sentEvidencePacks).toEqual([empty]);
    expect(result.filesInPrompt).toBe(0);
    // PR #3678 review: the answer reports the share of the prompt it actually sent.
    expect(result.promptContext).toMatchObject({
      promptTokens: 3,
      promptTokensMeasured: true,
      sentReferenceCount: 0,
      availableReferenceCount: 0,
    });
  });

  // PR #3678 review: the multi-source answer never re-planned after the provider's overflow taught
  // Keiko the real window. The second attempt must be re-fitted to the adopted window.
  it("re-fits and sends once more after the provider's overflow taught Keiko the real window", async () => {
    const root = realpathSync(tmp);
    const built = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: join(root, "evidence"),
      uiDbPath: join(root, "ui.db"),
      env: {},
    });
    const holder = built.gatewayConfig;
    if (holder === undefined) throw new Error("expected a runtime gateway config");
    holder.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: "assumed-chat",
            baseUrl: "https://litellm.example.invalid/v1",
            apiKey: "fake-test-key",
            timeoutMs: 5_000,
            maxRetries: 0,
            retryBaseDelayMs: 1,
          },
        ],
        capabilities: [assumedChatCapability("assumed-chat")],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
      }),
      true,
    );
    const labeledPacks = ["a", "b"].map((name) => {
      const pack = scopePack(`src/${name}.ts`, 0.5, name);
      return {
        label: name,
        pack: {
          ...pack,
          budget: { ...pack.budget, modelInputTokensMax: 64_000 },
          files: pack.files.map((file) => ({
            ...file,
            excerpts: file.excerpts.map((excerpt) => ({
              ...excerpt,
              content: `${name} evidence `.repeat(3_000),
              contentBytes: 33_000,
            })),
          })),
        },
      };
    });
    const sentTokens: number[] = [];
    const sentSourceBodies: string[] = [];
    const model: ModelPort = {
      call: (request) => {
        sentTokens.push(countGatewayPromptTokens({ messages: request.messages }));
        sentSourceBodies.push(request.messages.map((message) => message.content).join("\n"));
        if (sentTokens.length === 1) {
          adoptReportedContextWindow(
            built,
            { modelId: "assumed-chat", contextWindowTokens: 8_192, correlationId: "corr-ms-retry" },
            "provider-overflow",
          );
          const error = new ContextOverflowError("provider reported context overflow");
          error.reportedContextWindowTokens = 8_192;
          return Promise.reject(error);
        }
        return Promise.resolve({
          modelId: "assumed-chat",
          content: "answer",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "r",
            promptTokens: 0,
            completionTokens: 1,
            latencyMs: 1,
            costClass: "medium",
          },
        });
      },
    };

    try {
      const answerer = createMultiSourceAnswerer(
        built,
        model,
        "assumed-chat",
        new AbortController().signal,
        "corr-ms-retry",
      );
      const result = normalizeGroundedAnswerPayload(await answerer("explain", labeledPacks));

      expect(result.content).toBe("answer");
      expect(sentTokens).toHaveLength(2);
      expect(sentTokens[1]).toBeLessThan(sentTokens[0] ?? 0);
      expect(sentTokens[1]).toBeLessThanOrEqual(8_192);
      expect(result.promptContext?.contextWindowTokens).toBe(8_192);
      expect(result.evidenceScopeIndex).toBeDefined();
      expect(result.sentEvidencePacks).toBeDefined();
      assertFinalMultiSourceProjection(result, sentSourceBodies.at(-1));
    } finally {
      await built.dispose?.();
    }
  });
});
