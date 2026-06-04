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
      filesReadMax: 1,
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
    connectedScope: { relativePaths: ["src"], connectedAtMs: NOW },
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
});
