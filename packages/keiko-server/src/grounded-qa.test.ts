// Tests for the grounded Q&A BFF handler (Issue #185). Drives `handleGroundedAsk` directly
// with a fake IncomingMessage and an injected orchestrator runner so the wire-shape contracts
// (validation, scope guard, citation ordering, message persistence) are exercised without
// spinning up a real workspace or HTTP server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createInMemoryEvidenceStore, loadEvidence } from "@oscharko-dev/keiko-evidence";
import {
  CancelledError,
  type GatewayConfig,
  type GatewayRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";

const NOW = 1_700_000_000_000;
const CHAT_MODEL = "example-chat-model";
const GROUNDED_FIXTURE_QUESTION = "Investigate src/foo.ts behaviour of MyClass";

let store: UiStore;
let tmp: string;

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

function customModelConfig(modelId = CHAT_MODEL): GatewayConfig {
  return {
    providers: [
      {
        modelId,
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
        id: modelId,
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "test endpoint",
        preferredUseCases: ["Grounded repository Q&A"],
        knownLimitations: [],
      },
    ],
  };
}

function deps(model?: ModelPort, env: Record<string, string> = {}): UiHandlerDeps {
  const config = model === undefined ? undefined : customModelConfig(CHAT_MODEL);
  return {
    config,
    configPresent: config !== undefined,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, config),
    registry: createRunRegistry(),
    modelPortFactory: () => model,
    store,
  };
}

function fakeModel(content: string, seenRequests: GatewayRequest[]): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      seenRequests.push(request);
      return Promise.resolve({
        modelId: request.modelId,
        content,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "grounded-qa-test",
          promptTokens: 41,
          completionTokens: 7,
          latencyMs: 13,
          costClass: "medium",
        },
      });
    },
  };
}

function firstGatewayRequest(requests: readonly GatewayRequest[]): GatewayRequest {
  const request = requests[0];
  if (request === undefined) {
    throw new Error("expected a gateway request");
  }
  return request;
}

function expectGroundedGatewayRequest(request: GatewayRequest): void {
  expect(request.modelId).toBe(CHAT_MODEL);
  expect(request.stream).toBe(false);
  const [systemMessage, userMessage] = request.messages;
  if (systemMessage === undefined || userMessage === undefined) {
    throw new Error("expected system and user gateway messages");
  }
  expect(systemMessage.role).toBe("system");
  expect(systemMessage.content).toContain("Use only the supplied repository evidence");
  expect(userMessage.role).toBe("user");
  expect(userMessage.content).toContain("User question:");
  expect(userMessage.content).toContain(GROUNDED_FIXTURE_QUESTION);
  expect(userMessage.content).toContain("Repository evidence excerpts:");
  expect(userMessage.content).toContain("src/foo.ts");
  expect(userMessage.content).toContain("MyClass");
  expect(userMessage.content).toContain("model input tokens");
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
    connectedScope: { kind: "directory", relativePaths: ["src"], connectedAtMs: NOW },
  });
  return Promise.resolve({ chatId: chat.id, projectPath: project.path });
}

function seedScopedRepo(projectPath: string): void {
  writeFileSync(join(projectPath, "package.json"), '{"name":"grounded-fixture"}\n', "utf8");
  mkdirSync(join(projectPath, "src"), { recursive: true });
  writeFileSync(
    join(projectPath, "src", "foo.ts"),
    "export function MyClass() {\n  return 'foo';\n}\n",
    "utf8",
  );
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

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(captured?.scope.kind).toBe("workspace-root");
    expect(captured?.scope.relativePaths).toEqual([]);
  });

  it("production path sends the connected context pack through the configured Model Gateway port", async () => {
    const { chatId, projectPath } = await setupChatWithScope();
    seedScopedRepo(projectPath);
    const seenRequests: GatewayRequest[] = [];
    const result = await handleGroundedAsk(
      ctx(
        JSON.stringify({
          chatId,
          content: GROUNDED_FIXTURE_QUESTION,
          modelId: CHAT_MODEL,
        }),
      ),
      deps(fakeModel("Grounded answer [src/foo.ts:1-3]", seenRequests)),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expectGroundedGatewayRequest(firstGatewayRequest(seenRequests));
    const answer = result.body as GroundedAnswer;
    expect(answer.content).toBe("Grounded answer [src/foo.ts:1-3]");
    expect(store.listMessages(chatId).map((message) => message.content)).toContain(
      "Grounded answer [src/foo.ts:1-3]",
    );
  });

  it("production path redacts secret-shaped user text before building the gateway prompt", async () => {
    const { chatId, projectPath } = await setupChatWithScope();
    seedScopedRepo(projectPath);
    const secret = ["sk", "-fakeGatewayPromptSecret1234567890abcdef"].join("");
    const seenRequests: GatewayRequest[] = [];
    const result = await handleGroundedAsk(
      ctx(
        JSON.stringify({
          chatId,
          content: `${GROUNDED_FIXTURE_QUESTION} ${secret}`,
          modelId: CHAT_MODEL,
        }),
      ),
      deps(fakeModel("Grounded answer [src/foo.ts:1-3]", seenRequests), {
        OPENAI_API_KEY: secret,
      }),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(JSON.stringify(firstGatewayRequest(seenRequests))).not.toContain(secret);
  });

  it("rejects an unconfigured grounded model before calling a provider", async () => {
    const { chatId, projectPath } = await setupChatWithScope();
    seedScopedRepo(projectPath);
    const seenRequests: GatewayRequest[] = [];
    const result = await handleGroundedAsk(
      ctx(
        JSON.stringify({
          chatId,
          content: GROUNDED_FIXTURE_QUESTION,
          modelId: "missing-chat-model",
        }),
      ),
      deps(fakeModel("unused", seenRequests)),
    );

    expect(result.status).toBe(400);
    expect(seenRequests).toEqual([]);
  });

  it("returns NO_MODEL when the selected grounded model has no provider port", async () => {
    const { chatId, projectPath } = await setupChatWithScope();
    seedScopedRepo(projectPath);
    const configuredDeps = {
      ...deps(fakeModel("unused", [])),
      modelPortFactory: (): undefined => undefined,
    } satisfies UiHandlerDeps;
    const result = await handleGroundedAsk(
      ctx(
        JSON.stringify({
          chatId,
          content: GROUNDED_FIXTURE_QUESTION,
          modelId: CHAT_MODEL,
        }),
      ),
      configuredDeps,
    );

    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NO_MODEL");
  });

  it("does not persist messages when the HTTP request is cancelled during the model call", async () => {
    const { chatId, projectPath } = await setupChatWithScope();
    seedScopedRepo(projectPath);
    const res = fakeRes();
    const model: ModelPort = {
      call(_request, signal): Promise<NormalizedResponse> {
        return new Promise<NormalizedResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new CancelledError("aborted in grounded route test"));
            },
            { once: true },
          );
          res.emit("close");
        });
      },
    };

    const result = await handleGroundedAsk(
      ctx(
        JSON.stringify({
          chatId,
          content: GROUNDED_FIXTURE_QUESTION,
          modelId: CHAT_MODEL,
        }),
        res,
      ),
      deps(model),
    );

    expect(result.status).toBe(499);
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("redacts grounded user content before persisting the user message", async () => {
    const { chatId } = await setupChatWithScope();
    const secret = ["sk", "-fakeGroundedUserSecret1234567890abcdef"].join("");
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: `Please explain ${secret}` })),
      deps(undefined, { OPENAI_API_KEY: secret }),
      runner(emptyPack(), "ok"),
    );

    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    const userMsg = store
      .listMessages(chatId)
      .find((message) => message.id === answer.userMessageId);
    expect(userMsg?.role).toBe("user");
    expect(userMsg?.content).not.toContain(secret);
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

  it("persists a connected-context audit evidence manifest for the grounded answer", async () => {
    const { chatId } = await setupChatWithScope();
    const evidenceStore = createInMemoryEvidenceStore();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "How does MyClass work?" })),
      { ...deps(), evidenceStore },
      runner(packWithCitations(), "ok"),
    );
    expect(result.status).toBe(200);
    const answer = result.body as GroundedAnswer;
    expect(answer.evidenceRunId).toMatch(/^grounded-/);
    const manifest = loadEvidence(evidenceStore, answer.evidenceRunId ?? "");
    expect(manifest?.run.taskType).toBe("connected-context");
    expect(manifest?.connectedContext?.scope.scopeKind).toBe("directory");
    expect(manifest?.connectedContext?.summary).toMatchObject({
      citationCount: answer.citations.length,
      omittedCount: answer.omittedCount,
      elapsedMs: answer.elapsedMs,
    });
    expect(manifest?.connectedContext?.modelRequest.excerptContentPersisted).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("function MyClass");
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
    expect(answer.contextPack.scopeId).toMatch(/^scope-[0-9a-f]{8}$/);
    expect(answer.contextPack.scopeId).not.toBe(pack.scope.scopeId);
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
