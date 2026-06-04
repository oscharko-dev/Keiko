// Tests for the grounded Q&A BFF handler (Issue #185). Drives `handleGroundedAsk` directly
// with a fake IncomingMessage and an injected orchestrator runner so the wire-shape contracts
// (validation, scope guard, citation ordering, message persistence) are exercised without
// spinning up a real workspace or HTTP server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";

import { handleGroundedAsk, type GroundedRunner } from "./grounded-qa.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { RouteContext, RouteResult } from "./routes.js";
import type { OrchestratorInput, OrchestratorOutput } from "./grounded-orchestrator.js";

const NOW = 1_700_000_000_000;
const CHAT_MODEL = "example-chat-model";

let store: UiStore;
let tmp: string;

function fakeReq(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function ctx(body: string): RouteContext {
  return {
    req: fakeReq(body),
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function emptyPack(): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-test",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "cs-test",
      workspaceRoot: "/repo",
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
      searchCalls: 0,
      filesRead: 0,
      excerptBytes: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    files: [],
    omitted: [],
    uncertainty: [],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function packWithCitations(): ConnectedContextPack {
  const base = emptyPack();
  return {
    ...base,
    usage: {
      ...base.usage,
      filesRead: 2,
      excerptBytes: 68,
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
      {
        scopePath: "src/bar.ts",
        role: "read-only",
        selectionReason: "ranked by alpha",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: "atom-high",
              scopePath: "src/bar.ts",
              lineRange: undefined,
              score: 0.9,
              provenance: {
                kind: "structural",
                tool: "structural.importGraph",
                queryFingerprint: "fp-2",
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content: "import { MyClass } from './foo';",
            contentBytes: 32,
          },
        ],
      },
    ],
    uncertainty: [
      {
        kind: "no-evidence",
        claim: "excerpt unavailable for src/baz.ts",
        impactedAtomIds: [],
        emittedAtMs: NOW,
      },
    ],
    omitted: [{ scopePath: "src/baz.ts", reason: "low-relevance", omittedAtMs: NOW }],
  };
}

function runner(pack: ConnectedContextPack, content = "answered"): GroundedRunner {
  return (input: OrchestratorInput): Promise<OrchestratorOutput> => {
    void input;
    return Promise.resolve({
      pack,
      assistantContent: content,
      elapsedMs: 42,
    });
  };
}

beforeEach(() => {
  store = createInMemoryUiStore();
  tmp = mkdtempSync(join(tmpdir(), "keiko-grounded-qa-"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function setupChatWithScope(): Promise<{ chatId: string; projectPath: string }> {
  const project = store.createProject(tmp, "demo");
  const chat = store.createChat(project.path, "Investigation", CHAT_MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "files", relativePaths: ["src"], connectedAtMs: NOW },
  });
  return Promise.resolve({ chatId: chat.id, projectPath: project.path });
}

async function runHandler(
  body: string,
  customRunner: GroundedRunner = runner(emptyPack()),
): Promise<RouteResult> {
  return handleGroundedAsk(ctx(body), deps(), customRunner);
}

describe("handleGroundedAsk", () => {
  it("rejects body that is not JSON with 400 BAD_REQUEST", async () => {
    const result = await runHandler("not-json");
    expect(result.status).toBe(400);
  });

  it("rejects when chatId is missing", async () => {
    const result = await runHandler(JSON.stringify({ content: "hi" }));
    expect(result.status).toBe(400);
  });

  it("rejects when content is empty", async () => {
    const result = await runHandler(JSON.stringify({ chatId: "abc", content: "  " }));
    expect(result.status).toBe(400);
  });

  it("rejects when chat does not exist with 404 NOT_FOUND", async () => {
    const result = await runHandler(JSON.stringify({ chatId: "missing", content: "hello" }));
    expect(result.status).toBe(404);
  });

  it("rejects when chat has no connected scope with 400 BAD_REQUEST", async () => {
    const project = store.createProject(tmp, "demo");
    const chat = store.createChat(project.path, "No scope", CHAT_MODEL);
    const result = await runHandler(JSON.stringify({ chatId: chat.id, content: "hello" }));
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.message).toContain("connected scope");
  });

  it("passes repository-root connectedScope kind through to the grounded runner", async () => {
    const project = store.createProject(tmp, "demo");
    const chat = store.createChat(project.path, "Repository scope", CHAT_MODEL);
    store.updateChat(chat.id, {
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: NOW },
    });
    let captured: OrchestratorInput | undefined;
    const captureRunner: GroundedRunner = (input): Promise<OrchestratorOutput> => {
      captured = input;
      return Promise.resolve({ pack: emptyPack(), assistantContent: "ok", elapsedMs: 1 });
    };

    const result = await runHandler(
      JSON.stringify({ chatId: chat.id, content: "hello" }),
      captureRunner,
    );

    expect(result.status).toBe(200);
    expect(captured?.scope.kind).toBe("workspace-root");
    expect(captured?.scope.relativePaths).toEqual([]);
  });

  it("fails closed when the runner returns an invalid context pack", async () => {
    const { chatId } = await setupChatWithScope();
    const invalidPack: ConnectedContextPack = {
      ...emptyPack(),
      files: [
        {
          scopePath: ".env",
          role: "read-only",
          selectionReason: "exact-match",
          excerpts: [],
        },
      ],
    };
    const result = await runHandler(
      JSON.stringify({ chatId, content: "hello" }),
      runner(invalidPack),
    );
    expect(result.status).toBe(500);
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("fails closed when the runner returns a malformed pack that would make validation throw", async () => {
    const { chatId } = await setupChatWithScope();
    const malformedRunner: GroundedRunner = () =>
      Promise.resolve({
        pack: { bogus: true } as unknown as ConnectedContextPack,
        assistantContent: "hello",
        elapsedMs: 1,
      } satisfies OrchestratorOutput);
    const result = await runHandler(JSON.stringify({ chatId, content: "hello" }), malformedRunner);
    expect(result.status).toBe(500);
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("happy path: persists user + assistant messages and returns sorted citations", async () => {
    const { chatId } = await setupChatWithScope();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "How does MyClass work?" })),
      deps(),
      runner(packWithCitations(), "Inspected 2 file(s) ..."),
    );
    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    expect(answer.content).toBe("Inspected 2 file(s) ...");
    expect(answer.elapsedMs).toBe(42);
    // Citations sorted by score desc — atom-high before atom-low.
    expect(answer.citations.map((c) => c.stableId)).toEqual(["atom-high", "atom-low"]);
    expect(answer.citations[0]?.scopePath).toBe("src/bar.ts");
    expect(answer.uncertainty[0]?.kind).toBe("no-evidence");
    expect(answer.omittedCount).toBe(1);
    // Both messages persisted with the returned ids.
    const messages = store.listMessages(chatId);
    expect(messages.map((m) => m.id)).toContain(answer.userMessageId);
    expect(messages.map((m) => m.id)).toContain(answer.assistantMessageId);
    const userMsg = messages.find((m) => m.id === answer.userMessageId);
    const assistMsg = messages.find((m) => m.id === answer.assistantMessageId);
    expect(userMsg?.role).toBe("user");
    expect(userMsg?.content).toBe("How does MyClass work?");
    expect(assistMsg?.role).toBe("assistant");
    expect(assistMsg?.content).toBe("Inspected 2 file(s) ...");
  });

  it("returns empty citations + uncertainty when the pack carries none", async () => {
    const { chatId } = await setupChatWithScope();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "hello" })),
      deps(),
      runner(emptyPack(), "ok"),
    );
    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    expect(answer.citations).toEqual([]);
    expect(answer.uncertainty).toEqual([]);
    expect(answer.omittedCount).toBe(0);
  });

  it("maps ClarificationNeededError to a 400 BAD_REQUEST", async () => {
    const { chatId } = await setupChatWithScope();
    const failingRunner: GroundedRunner = async () => {
      const { ClarificationNeededError } = await import("./grounded-orchestrator.js");
      throw new ClarificationNeededError({
        reason: "no-anchors",
        suggestedQuestions: ["Which file?"],
        minimumAnchorCount: 1,
      });
    };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "help" })),
      deps(),
      failingRunner,
    );
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.message).toContain("clarification");
  });

  // ─── Issue #187: contextPack summary on the wire ─────────────────────────────

  it("surfaces a contextPack summary with citation count, omitted count, and elapsedMs", async () => {
    const { chatId } = await setupChatWithScope();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "How does MyClass work?" })),
      deps(),
      runner(packWithCitations(), "ok"),
    );
    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    expect(answer.contextPack).toBeDefined();
    expect(answer.contextPack.schemaVersion).toBe(CONNECTED_CONTEXT_SCHEMA_VERSION);
    // The summary mirrors the orchestrator pack's scope, not the chat-binding scope —
    // the BFF is a thin projection of the in-process pack.
    expect(answer.contextPack.scopeKind).toBe("directory");
    expect(answer.contextPack.queryKind).toBe("natural-language");
    expect(answer.contextPack.citationCount).toBe(answer.citations.length);
    expect(answer.contextPack.omittedCount).toBe(answer.omittedCount);
    expect(answer.contextPack.elapsedMs).toBe(answer.elapsedMs);
    expect(answer.contextPack.uncertaintyCount).toBe(answer.uncertainty.length);
  });

  it("contextPack.fileCount mirrors scope.relativePaths.length (files-scope = 3)", async () => {
    const project = store.createProject(tmp, "demo");
    const chat = store.createChat(project.path, "Three files", CHAT_MODEL);
    store.updateChat(chat.id, {
      connectedScope: {
        kind: "files",
        relativePaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
        connectedAtMs: NOW,
      },
    });
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId: chat.id, content: "explain" })),
      deps(),
      runner(packWithCitations(), "ok"),
    );
    const answer = result.body as GroundedAnswer;
    // The orchestrator-supplied pack in this test carries its own scope (kind: "directory"
    // with one path), which is what wires through. We assert the summary mirrors that pack —
    // never the chat-binding — so the BFF stays a thin projection.
    expect(answer.contextPack.scopeKind).toBe("directory");
    expect(answer.contextPack.fileCount).toBe(1);
  });

  it("contextPack carries usage and budget verbatim from the orchestrator pack", async () => {
    const { chatId } = await setupChatWithScope();
    const pack = packWithCitations();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      runner(pack, "ok"),
    );
    const answer = result.body as GroundedAnswer;
    expect(answer.contextPack.usage).toEqual(pack.usage);
    expect(answer.contextPack.budget).toEqual(pack.budget);
    expect(answer.contextPack.scopeId).toBe(pack.scope.scopeId);
  });

  // ─── Issue #188 regression fixtures ──────────────────────────────────────────

  // Case 1: broad prompt — a multi-file pack yields >= 2 citations.
  // Mutation guard: if buildCitations stops collecting across files (e.g. breaks after
  // the first file), the length assertion fails.
  it("returns multiple citations for a broad natural-language prompt", async () => {
    const { chatId } = await setupChatWithScope();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "How does the whole system work?" })),
      deps(),
      runner(packWithCitations(), "overview"),
    );
    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    expect(answer.citations.length).toBeGreaterThanOrEqual(2);
  });

  // Case 3: no result — orchestrator returns files: [] with a no-evidence uncertainty marker.
  // Mutation guard: if buildCitations emits entries despite an empty files array the
  // citations assertion fails; if buildUncertainty drops the marker the kind check fails.
  it("returns empty citations and a no-evidence uncertainty marker when nothing matches", async () => {
    const { chatId } = await setupChatWithScope();
    const noResultPack: ConnectedContextPack = {
      ...emptyPack(),
      files: [],
      uncertainty: [
        {
          kind: "no-evidence",
          claim: "no match for query in scope",
          impactedAtomIds: [],
          emittedAtMs: NOW,
        },
      ],
    };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "FindMe" })),
      deps(),
      runner(noResultPack, "I found nothing."),
    );
    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    expect(answer.citations.length).toBe(0);
    expect(answer.uncertainty.length).toBe(1);
    expect(answer.uncertainty[0]?.kind).toBe("no-evidence");
  });

  // Case 4: budget exhaustion — pack carries budget-clipped uncertainty and a budget-exhausted
  // omitted entry. Mutation guard: if omitted entries are ignored omittedCount stays 0;
  // if uncertainty is not threaded through the kind assertion fails.
  it("surfaces budget-clipped uncertainty and omitted count when the exploration budget is exhausted", async () => {
    const { chatId } = await setupChatWithScope();
    const budgetExhaustedPack: ConnectedContextPack = {
      ...emptyPack(),
      files: [],
      uncertainty: [
        {
          kind: "budget-clipped",
          claim: "exploration stopped early; budget exhausted",
          impactedAtomIds: [],
          emittedAtMs: NOW,
        },
      ],
      omitted: [{ scopePath: "src/large.ts", reason: "budget-exhausted", omittedAtMs: NOW }],
    };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "deep scan" })),
      deps(),
      runner(budgetExhaustedPack, "Partial results only."),
    );
    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    expect(answer.omittedCount).toBe(1);
    expect(answer.uncertainty[0]?.kind).toBe("budget-clipped");
  });

  // Case 6: safe cleanup — two sequential calls with different content must not share pack
  // state. The proxy: each response's contextPack.elapsedMs must reflect its own runner's
  // returned value, not the other call's. Mutation guard: if runAsk closes over a shared
  // pack reference both elapsedMs values would be equal and the inequality assertion fails.
  it("two independent grounded calls do not share contextPack state", async () => {
    const { chatId } = await setupChatWithScope();

    const runnerA: GroundedRunner = (_input: OrchestratorInput) =>
      Promise.resolve({ pack: emptyPack(), assistantContent: "answer A", elapsedMs: 10 });
    const runnerB: GroundedRunner = (_input: OrchestratorInput) =>
      Promise.resolve({ pack: emptyPack(), assistantContent: "answer B", elapsedMs: 99 });

    const resultA = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "first question" })),
      deps(),
      runnerA,
    );
    const resultB = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "second question" })),
      deps(),
      runnerB,
    );

    expect(resultA.status).toBe(200);
    expect(resultB.status).toBe(200);
    const answerA = resultA.body as GroundedAnswer;
    const answerB = resultB.body as GroundedAnswer;
    expect(answerA.contextPack.elapsedMs).toBe(10);
    expect(answerB.contextPack.elapsedMs).toBe(99);
    expect(answerA.contextPack.elapsedMs).not.toBe(answerB.contextPack.elapsedMs);
    // Neither call borrows the other's persisted message ids.
    expect(answerA.assistantMessageId).not.toBe(answerB.assistantMessageId);
  });
});
