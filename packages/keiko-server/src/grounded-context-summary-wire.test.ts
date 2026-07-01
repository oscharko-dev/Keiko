// ADR-0057 D1 (integration): the path-free GroundedAnswerContextSummary projection on the BFF
// wire summary. When a ContextProfile is active AND the observer ran (pack.diagnostics?.contextBudget
// present), buildGroundedAnswerContextPackSummary receives the shared assembly diagnostics via
// groundedContextSummaryInput and emits a counts-only contextSummary. With no profile the field is
// omitted and the summary is byte-identical to today (AC5: prompt/pack/wire-answer bytes unaffected
// — this only touches the path-free summary projection). The path-free guarantee is asserted
// structurally: no '/' or '\\' appears anywhere in the serialized contextSummary.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  buildGroundedAnswerContextPackSummary,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PROFILE,
  type ConnectedContextPack,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { attachContextBudgetDiagnostics } from "./grounded-context-diagnostics.js";
import {
  groundedContextSummaryInput,
  handleGroundedAsk,
  type GroundedRunner,
} from "./grounded-qa.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayConfig, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

const NOW = 1_700_000_000_000;

function basePack(): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-d1",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "cs-test",
      workspaceRoot: "/repo/secret/path",
      kind: "directory",
      relativePaths: ["src"],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: "How does MyClass work?",
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: {
      searchCallsMax: 1,
      filesReadMax: 4,
      excerptBytesMax: 1024,
      modelInputTokensMax: 1024,
      modelOutputTokensMax: 256,
      elapsedMsMax: 1000,
      rerankCallsMax: 0,
    },
    usage: {
      searchCalls: 1,
      filesRead: 1,
      excerptBytes: 36,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 5,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: "src/foo.ts",
        role: "read-only",
        selectionReason: "ranked by alpha",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "atom-low",
              scopePath: "src/foo.ts",
              lineRange: { startLine: 10, endLine: 20 },
              score: 0.3,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: "fp-1",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content: "function MyClass() { return 'foo'; }",
            contentBytes: 36,
          },
        ],
      },
    ],
    omitted: [],
    uncertainty: [],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function depsWith(profile: ContextProfile | undefined): Pick<UiHandlerDeps, "contextProfile"> {
  return { contextProfile: profile };
}

describe("grounded wire summary — path-free contextSummary (ADR-0057 D1)", () => {
  it("projects a path-free contextSummary when a profile is active and the observer ran", () => {
    const pack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    const summary = buildGroundedAnswerContextPackSummary(
      pack,
      1,
      5,
      groundedContextSummaryInput(depsWith(DEFAULT_CONTEXT_PROFILE), pack),
    );
    expect(summary.contextSummary).toBeDefined();
    const ctx = summary.contextSummary;
    if (ctx === undefined) throw new Error("expected contextSummary");
    expect(typeof ctx.totalEstimatedTokens).toBe("number");
    expect(typeof ctx.budgetPressure).toBe("string");
    expect(typeof ctx.compactionActive).toBe("boolean");
    // Path-free structural gate: no path separators anywhere in the serialized projection.
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("/");
    expect(serialized).not.toContain("\\");
  });

  it("carries the active profile's lanes in laneCounts", () => {
    const pack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    const summary = buildGroundedAnswerContextPackSummary(
      pack,
      1,
      5,
      groundedContextSummaryInput(depsWith(DEFAULT_CONTEXT_PROFILE), pack),
    );
    expect(summary.contextSummary?.laneCounts["repo-evidence"]).toBeGreaterThanOrEqual(0);
  });

  it("omits contextSummary with no profile — byte-identical to the three-arg summary (AC5)", () => {
    const pack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    const wired = buildGroundedAnswerContextPackSummary(
      pack,
      1,
      5,
      groundedContextSummaryInput(depsWith(undefined), pack),
    );
    const legacy = buildGroundedAnswerContextPackSummary(pack, 1, 5);
    expect(wired.contextSummary).toBeUndefined();
    expect("contextSummary" in wired).toBe(false);
    expect(JSON.stringify(wired)).toBe(JSON.stringify(legacy));
  });

  it("omits contextSummary when the observer did not run (no contextBudget on the pack)", () => {
    const pack = basePack();
    const summary = buildGroundedAnswerContextPackSummary(
      pack,
      1,
      5,
      groundedContextSummaryInput(depsWith(DEFAULT_CONTEXT_PROFILE), pack),
    );
    expect(summary.contextSummary).toBeUndefined();
  });
});

// Route-level gate: proves the single-source CALL SITE in runAsk passes the 4th arg. Dropping the
// wiring at the call site (the mutation probe) fails the "with profile -> present" assertion here,
// which the pure-builder tests above cannot catch (they call the builder directly).
const CHAT_MODEL = "example-chat-model";

let store: UiStore;
let tmp: string;

function fakeReq(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function routeCtx(body: string): RouteContext {
  const res = new EventEmitter() as RouteContext["res"] & { writableEnded: boolean };
  res.writableEnded = false;
  return {
    req: fakeReq(body),
    res,
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

function modelConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: CHAT_MODEL,
        baseUrl: "https://provider.example/v1",
        apiKey: "test-config-secret-value-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: CHAT_MODEL,
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "test endpoint",
        preferredUseCases: ["Grounded repository Q&A"],
        knownLimitations: [],
      },
    ],
  };
}

function fakeModel(): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      return Promise.resolve({
        modelId: request.modelId,
        content: "answered",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "summary-wire-test",
          promptTokens: 41,
          completionTokens: 7,
          latencyMs: 13,
          costClass: "medium",
        },
      });
    },
  };
}

function routeDeps(withProfile: boolean, overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  const config = modelConfig();
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    modelPortFactory: () => fakeModel(),
    store,
    ...(withProfile ? { contextProfile: DEFAULT_CONTEXT_PROFILE } : {}),
    ...overrides,
  };
}

function runner(pack: ConnectedContextPack): GroundedRunner {
  return () => Promise.resolve({ pack, assistantContent: "answered", elapsedMs: 42 });
}

function scopedChat(): string {
  const project = store.createProject(tmp, "demo");
  const chat = store.createChat(project.path, "Investigation", CHAT_MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "directory", relativePaths: ["src"], connectedAtMs: NOW },
  });
  return chat.id;
}

function asConnected(
  result: RouteResult,
): Extract<GroundedAnswer, { readonly groundingKind: "connected-context" }> {
  const answer = result.body as GroundedAnswer;
  if (answer.groundingKind !== "connected-context") {
    throw new Error("expected connected-context answer");
  }
  return answer;
}

describe("handleGroundedAsk wire summary call site (ADR-0057 D1)", () => {
  beforeEach(() => {
    store = createInMemoryUiStore();
    tmp = mkdtempSync(join(tmpdir(), "keiko-summary-wire-"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emits contextSummary on the wire answer when a profile is active (call-site wiring)", async () => {
    const chatId = scopedChat();
    const pack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "investigate MyClass" })),
      routeDeps(true),
      runner(pack),
    );
    expect(result.status).toBe(200);
    const answer = asConnected(result);
    expect(answer.contextPack.contextSummary).toBeDefined();
    expect(JSON.stringify(answer.contextPack.contextSummary)).not.toContain("/");
  });

  it("omits contextSummary on the wire answer when no profile is active", async () => {
    const chatId = scopedChat();
    const pack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "investigate MyClass" })),
      routeDeps(false),
      runner(pack),
    );
    expect(result.status).toBe(200);
    expect(asConnected(result).contextPack.contextSummary).toBeUndefined();
  });

  it("emits contextSummary from the active model profile resolver when the singleton profile is absent", async () => {
    const chatId = scopedChat();
    const pack = attachContextBudgetDiagnostics(basePack(), DEFAULT_CONTEXT_PROFILE);
    const result = await handleGroundedAsk(
      routeCtx(JSON.stringify({ chatId, content: "investigate MyClass", modelId: CHAT_MODEL })),
      routeDeps(false, { contextProfileForModel: () => DEFAULT_CONTEXT_PROFILE }),
      runner(pack),
    );
    expect(result.status).toBe(200);
    expect(asConnected(result).contextPack.contextSummary).toBeDefined();
  });
});
