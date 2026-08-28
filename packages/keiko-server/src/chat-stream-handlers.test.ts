// Behavioural tests for the desktop chat SSE streaming handler (#152). The regression these guard:
// the streamed prompt previously built the gateway messages BEFORE persisting the current user turn,
// so prompt assembly omitted it — a fresh chat sent `[system]`
// only (the model hallucinated) and a history chat ended on an `assistant` turn (some providers
// reject it 400). The fix mirrors the buffered persistModelChatTurn ordering: persist the user turn
// BEFORE building the prompt. These tests are mutation-robust — each fails on the pre-fix code.
//
// The handler is driven directly (not over HTTP) so the cancel path is deterministic with no timers:
// `req` is a node Readable carrying the JSON body (satisfying readBody's data/end events) that also
// emits "aborted"; `res` captures writeHead/write/end. The fake ModelPort records the prompt it was
// streamed and yields a `delta` then a `done` chunk.

import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleSendDesktopChatStream,
  MAX_ACTIVE_CHAT_STREAMS_ENV,
  _resetActiveChatStreamsForTests,
} from "./chat-stream-handlers.js";
import { handleRegenerateDesktopChat, handleSendDesktopChat } from "./chat-handlers.js";
import {
  canonicalChatTurnGroundingScopeIdentity,
  canonicalChatTurnIdentityContent,
  canonicalChatTurnMemorySemantics,
} from "./chat-turn-identity.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import { composeDiscussionDirectiveBlock } from "./discussion-prompt.js";
import { STREAMING, type RouteContext } from "./routes.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "./observability/index.js";
import type { RuntimeGatewayConfig } from "./deps.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  GatewayCallRequest,
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  NormalizedResponse,
  OpenAIEmbeddingOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  Chat,
  ConversationMemoryRequestWire,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import type { ConversationId, ProjectId, WorkspaceId } from "@oscharko-dev/keiko-contracts/memory";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";

const CHAT_MODEL = "example-chat-model";
const ALTERNATE_CHAT_MODEL = "alternate-chat-model";

let tmp: string;
let projectDir: string;
let store: UiStore;

interface SseRecord {
  readonly event: string;
  readonly data: unknown;
}

interface CapturedRes {
  readonly res: ServerResponse;
  readonly writes: string[];
  status?: number;
  ended: boolean;
}

// A capturing ServerResponse double: records the status from writeHead, every write chunk, and end.
// Only the surface the handler touches is implemented; the rest is unused at runtime.
function captureRes(): CapturedRes {
  const writes: string[] = [];
  const captured: CapturedRes = {
    res: undefined as unknown as ServerResponse,
    writes,
    ended: false,
  };
  const res = {
    writeHead(status: number): ServerResponse {
      captured.status = status;
      return res as unknown as ServerResponse;
    },
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    end(): ServerResponse {
      captured.ended = true;
      return res as unknown as ServerResponse;
    },
    on(): ServerResponse {
      return res as unknown as ServerResponse;
    },
    once(): ServerResponse {
      return res as unknown as ServerResponse;
    },
    off(): ServerResponse {
      return res as unknown as ServerResponse;
    },
  };
  return { ...captured, res: res as unknown as ServerResponse, writes };
}

interface CapturedResWithEvents {
  res: ServerResponse;
  readonly writes: string[];
  status?: number | undefined;
  ended: boolean;
  destroyed: boolean;
  // Emits "close" on the response so abortOnDisconnect fires — simulates a client disconnect.
  emitClose: () => void;
  // Controls what res.write() returns (default true; set false to simulate backpressure).
  writeReturns: boolean;
}

// Like captureRes but backed by an EventEmitter so res.on("close") listeners actually fire.
// Used for the cancel (disconnect) test and the backpressure test.
// NOTE: this function returns the mutable state object directly (no spread) so that mutations to
// `writeReturns` made by the test after construction are visible inside res.write().
function captureResWithEvents(): CapturedResWithEvents {
  const writes: string[] = [];
  const emitter = new EventEmitter();
  const result: CapturedResWithEvents = {
    res: undefined as unknown as ServerResponse,
    writes,
    status: undefined,
    ended: false,
    destroyed: false,
    writeReturns: true,
    emitClose: (): void => {
      emitter.emit("close");
    },
  };
  const res = {
    writeHead(status: number): ServerResponse {
      result.status = status;
      return res as unknown as ServerResponse;
    },
    write(chunk: string): boolean {
      writes.push(chunk);
      return result.writeReturns;
    },
    end(): ServerResponse {
      result.ended = true;
      return res as unknown as ServerResponse;
    },
    destroy(): void {
      result.destroyed = true;
    },
    on(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      emitter.on(event, listener);
      return res as unknown as ServerResponse;
    },
    once(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      emitter.once(event, listener);
      return res as unknown as ServerResponse;
    },
    off(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      emitter.off(event, listener);
      return res as unknown as ServerResponse;
    },
    emit(event: string): boolean {
      return emitter.emit(event);
    },
  };
  result.res = res as unknown as ServerResponse;
  return result;
}

// A request double: a Readable that streams the JSON body (so readBody resolves) and also serves as
// the EventEmitter abortOnDisconnect listens on for "aborted"/"close".
function makeReq(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  return req as unknown as IncomingMessage;
}

function routeContext(req: IncomingMessage, res: ServerResponse): RouteContext {
  return {
    req,
    res,
    params: {},
    url: new URL("http://127.0.0.1/api/desktop/chat/stream"),
  };
}

function parseSse(writes: readonly string[]): SseRecord[] {
  const joined = writes.join("");
  const records: SseRecord[] = [];
  for (const block of joined.split("\n\n")) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    let event = "";
    let data: unknown = undefined;
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data = JSON.parse(line.slice("data: ".length));
    }
    records.push({ event, data });
  }
  return records;
}

function normalizedResponse(content: string, modelId = CHAT_MODEL): NormalizedResponse {
  return {
    modelId,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "desktop-chat-stream-test",
      promptTokens: 7,
      completionTokens: 3,
      latencyMs: 11,
      costClass: "high",
    },
  };
}

function twoChatModelConfig(): GatewayConfig {
  const base = customModelConfig(CHAT_MODEL);
  const provider = base.providers[0];
  const capability = base.capabilities?.[0];
  if (provider === undefined || capability === undefined) throw new Error("missing model fixture");
  return {
    ...base,
    providers: [provider, { ...provider, modelId: ALTERNATE_CHAT_MODEL }],
    capabilities: [capability, { ...capability, id: ALTERNATE_CHAT_MODEL }],
  };
}

function chatAndEmbeddingConfig(): GatewayConfig {
  const base = customModelConfig(CHAT_MODEL);
  const chatCapability = base.capabilities?.[0];
  if (chatCapability === undefined) throw new Error("missing chat capability fixture");
  return {
    ...base,
    providers: [
      ...base.providers,
      {
        modelId: "text-embedding-3-small",
        baseUrl: "https://provider.example/v1",
        apiKey: "test-config-secret-value-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    capabilities: [
      chatCapability,
      {
        ...chatCapability,
        id: "text-embedding-3-small",
        kind: "embedding",
        contextWindow: 8_192,
        maxOutputTokens: 0,
        toolCalling: false,
        structuredOutput: false,
        streaming: false,
        workflowEligible: false,
      },
    ],
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface StreamingModel {
  readonly model: ModelPort;
  readonly recorded: { request: GatewayCallRequest | undefined };
  readonly calls: { count: number };
}

// A streaming ModelPort that records the prompt it is asked to stream, then yields one delta and one
// terminal done chunk. `onFirstDelta` (used by the cancel test) runs after the first delta is yielded
// so the test can abort the controller deterministically before the done chunk arrives.
function streamingModel(content: string, onFirstDelta?: () => void): StreamingModel {
  const recorded: { request: GatewayCallRequest | undefined } = { request: undefined };
  const calls = { count: 0 };
  const model: ModelPort = {
    call(): Promise<NormalizedResponse> {
      return Promise.resolve(normalizedResponse(content));
    },
    async *callStream(request: GatewayCallRequest): AsyncGenerator<GatewayStreamChunk> {
      calls.count += 1;
      recorded.request = request;
      yield { type: "delta", token: "hi" };
      if (onFirstDelta !== undefined) onFirstDelta();
      // Yield to the microtask queue so a synchronous abort fired in onFirstDelta is observed by
      // streamConversation's signal.aborted check before this terminal chunk is consumed.
      await Promise.resolve();
      yield { type: "done", response: normalizedResponse(content) };
    },
  };
  return { model, recorded, calls };
}

function deps(model: ModelPort, overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: customModelConfig(CHAT_MODEL),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => model,
    store,
    ...overrides,
  };
}

function readyRuntimeGatewayConfig(config: GatewayConfig): RuntimeGatewayConfig {
  let current = config;
  let generation = 0;
  const observations = new Map<string, ReturnType<RuntimeGatewayConfig["verifiedCapability"]>>();
  const holder: RuntimeGatewayConfig = {
    storagePath: join(tmp, "gateway.json"),
    current: () => current,
    present: () => true,
    set(next): void {
      if (next === undefined) throw new Error("test runtime config must stay configured");
      current = next;
      generation += 1;
      observations.clear();
    },
    generation: () => generation,
    verification: () => UNVERIFIED_GATEWAY,
    recordVerification: () => undefined,
    verifiedCapability: (modelId) => observations.get(modelId),
    recordVerifiedCapability(modelId, fields, checkedAt, observedGeneration): void {
      if (observedGeneration !== undefined && observedGeneration !== generation) return;
      observations.set(modelId, { modelId, generation, checkedAt, fields: { ...fields } });
    },
    clearVerifiedCapability(modelId, observedGeneration): boolean {
      if (observedGeneration !== undefined && observedGeneration !== generation) return false;
      return observations.delete(modelId);
    },
  };
  holder.recordVerifiedCapability(
    CHAT_MODEL,
    { conversationReady: true },
    "2026-08-16T00:00:00.000Z",
    holder.generation(),
  );
  return holder;
}

function replaceWithReadyRuntimeConfig(holder: RuntimeGatewayConfig): void {
  holder.set(chatAndEmbeddingConfig(), true);
  holder.recordVerifiedCapability(
    CHAT_MODEL,
    { conversationReady: true },
    "2026-08-16T00:01:00.000Z",
    holder.generation(),
  );
}

function customModelConfig(modelId: string): GatewayConfig {
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
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "local endpoint",
        preferredUseCases: ["Local coding workflow"],
        knownLimitations: [],
      },
    ],
  };
}

function makeMemoryId(value: string): MemoryId {
  return value as MemoryId;
}

function makeMemoryUserId(value: string): MemoryUserId {
  const raw: unknown = value;
  return raw as MemoryUserId;
}

function insertAcceptedMemory(
  vault: MemoryVaultStore,
  body: string,
  scope: MemoryScope = { kind: "user", userId: makeMemoryUserId("local-operator") },
): MemoryRecord {
  const now = Date.now();
  return vault.insertMemory({
    id: makeMemoryId(`mem-${String(now)}`),
    schemaVersion: "1",
    scope,
    type: "preference",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 1,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
}

function seedChat(): string {
  const chat = store.createChat(projectDir, "Untitled chat", CHAT_MODEL);
  return chat.id;
}

interface PlainTurnIdentityOptions {
  readonly modelId?: string;
  readonly expectedGroundingScopeIdentity?: string;
  readonly memory?: Pick<ConversationMemoryRequestWire, "enabled" | "budgetTokens" | "mode">;
}

function requiredChat(chatId: string): Chat {
  const chat = store.findChatById(chatId);
  if (chat === undefined) throw new Error("expected persisted chat");
  return chat;
}

function testMemoryContext(chatId: string): ConversationMemoryRuntimeContext {
  return {
    userId: makeMemoryUserId("local-operator"),
    workspaceId: projectDir as WorkspaceId,
    projectId: projectDir as ProjectId,
    conversationId: chatId as ConversationId,
  };
}

function canonicalPlainTurnIdentity(
  chatId: string,
  content: string,
  options: PlainTurnIdentityOptions = {},
): string {
  const chat = requiredChat(chatId);
  return canonicalChatTurnIdentityContent({
    routeKind: "plain",
    content,
    modelId: options.modelId ?? chat.selectedModel,
    groundingScopeIdentity:
      options.expectedGroundingScopeIdentity ?? canonicalChatTurnGroundingScopeIdentity(chat),
    memory: canonicalChatTurnMemorySemantics(
      options.memory,
      options.memory === undefined ? undefined : testMemoryContext(chatId),
    ),
    documentContext: [],
    attachments: [],
    discussionMode: null,
  });
}

function seedMessage(chatId: string, role: "user" | "assistant", content: string): void {
  store.createMessage({
    chatId,
    role,
    content,
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
}

function lastRecordedRole(recorded: { request: GatewayRequest | undefined }): string | undefined {
  return recorded.request?.messages.at(-1)?.role;
}

function lastRecordedContent(recorded: { request: GatewayRequest | undefined }): string {
  return recorded.request?.messages.at(-1)?.content ?? "";
}

beforeEach(() => {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), "keiko-stream-"));
  projectDir = join(tmp, "repo");
  mkdirSync(projectDir);
  store = createInMemoryUiStore();
  store.createProject(projectDir, "repo");
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("desktop chat SSE streaming handler", () => {
  it("rejects a tokenless plain stream on a grounded chat before admission or SSE", async () => {
    const chatId = seedChat();
    store.updateChat(chatId, {
      connectedScopes: [{ kind: "files", relativePaths: ["src/index.ts"], connectedAtMs: 10 }],
    });
    let streamCalls = 0;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("must not run")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        streamCalls += 1;
        yield { type: "done", response: normalizedResponse("must not run") };
      },
    };
    const captured = captureRes();

    const result = await handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "Do not bypass repository grounding",
        }),
        captured.res,
      ),
      deps(model),
    );

    expect(result).toMatchObject({ status: 409 });
    expect(captured.status).toBeUndefined();
    expect(captured.writes).toEqual([]);
    expect(streamCalls).toBe(0);
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("fails a captured canonical stream closed when the grounding scope changes", async () => {
    const chatId = seedChat();
    const capturedScopeIdentity = store.findChatById(chatId)?.groundingScopeIdentity;
    if (capturedScopeIdentity === undefined) throw new Error("expected a projected scope identity");
    store.updateChat(chatId, {
      connectedScopes: [{ kind: "files", relativePaths: ["src/index.ts"], connectedAtMs: 10 }],
    });
    let streamCalls = 0;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("must not run")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        streamCalls += 1;
        yield { type: "done", response: normalizedResponse("must not run") };
      },
    };
    const captured = captureRes();

    const result = await handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "Keep the final but do not answer against changed scope",
          clientTurnId: "stream-scope-drift",
          expectedGroundingScopeIdentity: capturedScopeIdentity,
        }),
        captured.res,
      ),
      deps(model),
    );

    expect(result).toMatchObject({ status: 409 });
    expect(captured.status).toBeUndefined();
    expect(captured.writes).toEqual([]);
    expect(streamCalls).toBe(0);
    expect(store.listMessages(chatId)).toMatchObject([
      { role: "user", content: "Keep the final but do not answer against changed scope" },
    ]);
  });

  it("rejects a closed stream before admission and admits the same id after restore", async () => {
    const chatId = seedChat();
    store.updateChat(chatId, { status: "closed" });
    let streamCalls = 0;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("must not run")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        streamCalls += 1;
        yield { type: "done", response: normalizedResponse("restored stream answer") };
      },
    };
    const sharedDeps = deps(model);
    const request = {
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "Stream only after restore.",
      clientTurnId: "closed-stream-turn",
    };
    const closedCapture = captureRes();
    const closed = await handleSendDesktopChatStream(
      routeContext(makeReq(request), closedCapture.res),
      sharedDeps,
    );

    expect(closed).toMatchObject({
      status: 409,
      body: { error: { code: "CHAT_CLOSED" } },
    });
    expect(closedCapture.status).toBeUndefined();
    expect(streamCalls).toBe(0);
    expect(store.listMessages(chatId)).toHaveLength(0);

    store.updateChat(chatId, { status: "open" });
    const restoredCapture = captureRes();
    const restored = await handleSendDesktopChatStream(
      routeContext(makeReq(request), restoredCapture.res),
      sharedDeps,
    );
    expect(restored).toBe(STREAMING);
    expect(streamCalls).toBe(1);
    expect(store.listMessages(chatId)).toHaveLength(2);

    store.updateChat(chatId, { status: "closed" });
    const replayCapture = captureRes();
    const replay = await handleSendDesktopChatStream(
      routeContext(makeReq(request), replayCapture.res),
      sharedDeps,
    );
    expect(replay).toBe(STREAMING);
    expect(streamCalls).toBe(1);
    expect(store.listMessages(chatId)).toHaveLength(2);
  });

  it("does not duplicate a legacy Composer user when streaming falls back to buffered", async () => {
    const chatId = seedChat();
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("buffered fallback")),
    };
    const sharedDeps = deps(model);
    const request = {
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "fallback without a client turn id",
    };
    const streamRes = captureRes();

    const streamResult = await handleSendDesktopChatStream(
      routeContext(makeReq(request), streamRes.res),
      sharedDeps,
    );
    expect(streamResult).toMatchObject({ status: 400 });
    expect(store.listMessages(chatId)).toEqual([]);

    const buffered = await handleSendDesktopChat(
      routeContext(makeReq(request), captureRes().res),
      sharedDeps,
    );
    expect(buffered.status).toBe(200);
    expect(store.listMessages(chatId)).toMatchObject([
      { role: "user", content: "fallback without a client turn id" },
      { role: "assistant", content: "buffered fallback" },
    ]);
  });

  it("rejects a legacy buffered send without a provider before persisting", async () => {
    const chatId = seedChat();
    const sharedDeps = deps(
      { call: () => Promise.resolve(normalizedResponse("unused")) },
      { modelPortFactory: () => undefined },
    );

    const result = await handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "legacy buffered without provider",
        }),
        captureRes().res,
      ),
      sharedDeps,
    );

    // NO_MODEL for a legacy request cannot settle a turn (no clientTurnId), so it must be
    // rejected BEFORE admission persists the user message — no orphan in the conversation.
    expect(result).toMatchObject({ status: 400, body: { error: { code: "NO_MODEL" } } });
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("shares one canonical turn identity across SSE fallback and buffered replay", async () => {
    const chatId = seedChat();
    let bufferedCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        bufferedCalls += 1;
        return Promise.resolve(normalizedResponse("canonical buffered answer"));
      },
    };
    const sharedDeps = deps(model);
    const request = {
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "retry this semantic turn through the buffered transport",
      clientTurnId: "cross-transport-canonical-turn",
    };

    const unsupported = await handleSendDesktopChatStream(
      routeContext(makeReq(request), captureRes().res),
      sharedDeps,
    );
    expect(unsupported).toMatchObject({
      status: 400,
      body: { error: { code: "STREAMING_UNSUPPORTED" } },
    });
    expect(store.listMessages(chatId)).toMatchObject([{ role: "user", content: request.content }]);

    await expect(
      handleSendDesktopChat(routeContext(makeReq(request), captureRes().res), sharedDeps),
    ).resolves.toMatchObject({ status: 200 });
    const persistedIds = store.listMessages(chatId).map((message) => message.id);
    expect(bufferedCalls).toBe(1);
    expect(persistedIds).toHaveLength(2);

    const replayCapture = captureRes();
    await expect(
      handleSendDesktopChatStream(routeContext(makeReq(request), replayCapture.res), sharedDeps),
    ).resolves.toBe(STREAMING);
    const replay = parseSse(replayCapture.writes).find((record) => record.event === "done")
      ?.data as { readonly messages: readonly { readonly id: string }[] } | undefined;
    expect(replay?.messages.map((message) => message.id)).toEqual(persistedIds);
    expect(bufferedCalls).toBe(1);
    expect(store.listMessages(chatId)).toHaveLength(2);
  });

  it("serializes buffered and streamed turns that target the same chat", async () => {
    const chatId = seedChat();
    const firstResponse = deferred<NormalizedResponse>();
    const firstStarted = deferred<undefined>();
    let streamCalls = 0;
    let streamedRequest: GatewayRequest | undefined;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        firstStarted.resolve(undefined);
        return firstResponse.promise;
      },
      async *callStream(request): AsyncGenerator<GatewayStreamChunk> {
        streamCalls += 1;
        streamedRequest = request;
        await Promise.resolve();
        yield { type: "done", response: normalizedResponse("second answer") };
      },
    };
    const sharedDeps = deps(model);
    const firstRes = captureRes();
    const first = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "first question",
          clientTurnId: "first-turn",
        }),
        firstRes.res,
      ),
      sharedDeps,
    );
    await firstStarted.promise;

    const secondRes = captureRes();
    const second = handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "second question",
          clientTurnId: "second-turn",
        }),
        secondRes.res,
      ),
      sharedDeps,
    );
    // This is an event-loop barrier, not a timing wait: it lets the fully buffered request body and
    // all resulting promise continuations reach the chat serializer while the first model is gated.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(streamCalls).toBe(0);
    expect(store.listMessages(chatId).map((entry) => entry.content)).toEqual(["first question"]);

    firstResponse.resolve(normalizedResponse("first answer"));
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toBe(STREAMING);
    expect(streamCalls).toBe(1);
    expect(streamedRequest?.messages.map((entry) => entry.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(store.listMessages(chatId).map((entry) => entry.content)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
  });

  it("revalidates the chat title and selected model after waiting for the chat turn lock", async () => {
    const chat = store.createChat(projectDir, "New chat", CHAT_MODEL);
    const firstResponse = deferred<NormalizedResponse>();
    const firstStarted = deferred<undefined>();
    let alternateCalls = 0;
    let defaultCalls = 0;
    const alternateModel: ModelPort = {
      call(): Promise<NormalizedResponse> {
        alternateCalls += 1;
        if (alternateCalls === 1) {
          firstStarted.resolve(undefined);
          return firstResponse.promise;
        }
        return Promise.resolve(normalizedResponse("second answer", ALTERNATE_CHAT_MODEL));
      },
    };
    const defaultModel: ModelPort = {
      call(): Promise<NormalizedResponse> {
        defaultCalls += 1;
        return Promise.resolve(normalizedResponse("stale-model answer"));
      },
    };
    const sharedDeps = deps(defaultModel, {
      config: twoChatModelConfig(),
      modelPortFactory: (modelId) =>
        modelId === ALTERNATE_CHAT_MODEL ? alternateModel : defaultModel,
    });
    const first = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId: chat.id,
          projectPath: projectDir,
          modelId: ALTERNATE_CHAT_MODEL,
          content: "first question",
          clientTurnId: "fresh-chat-first",
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await firstStarted.promise;
    const second = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId: chat.id,
          projectPath: projectDir,
          content: "second question",
          clientTurnId: "fresh-chat-second",
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    firstResponse.resolve(normalizedResponse("first answer", ALTERNATE_CHAT_MODEL));
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });

    expect(alternateCalls).toBe(2);
    expect(defaultCalls).toBe(0);
    expect(store.findChatById(chat.id)).toMatchObject({
      title: "first question",
      selectedModel: ALTERNATE_CHAT_MODEL,
    });
  });

  it("waits before validating an SSE turn against a selected model changed by its predecessor", async () => {
    const chat = store.createChat(projectDir, "Existing chat", "retired-chat-model");
    const firstResponse = deferred<NormalizedResponse>();
    const firstStarted = deferred<undefined>();
    let bufferedCalls = 0;
    let streamCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        bufferedCalls += 1;
        firstStarted.resolve(undefined);
        return firstResponse.promise;
      },
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        streamCalls += 1;
        yield { type: "done", response: normalizedResponse("streamed after model refresh") };
      },
    };
    const sharedDeps = deps(model);
    const first = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId: chat.id,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "select the valid model",
          clientTurnId: "selected-model-first",
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await firstStarted.promise;
    const captured = captureRes();
    const second = handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId: chat.id,
          projectPath: projectDir,
          content: "use the refreshed selected model",
          clientTurnId: "selected-model-second",
        }),
        captured.res,
      ),
      sharedDeps,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(streamCalls).toBe(0);

    firstResponse.resolve(normalizedResponse("selection committed"));
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toBe(STREAMING);
    expect(bufferedCalls).toBe(1);
    expect(streamCalls).toBe(1);
    expect(parseSse(captured.writes).map((record) => record.event)).toContain("done");
  });

  it("does not persist an assistant when a buffered provider resolves after disconnect", async () => {
    const chatId = seedChat();
    const response = deferred<NormalizedResponse>();
    const started = deferred<undefined>();
    let observedSignal: AbortSignal | undefined;
    let modelCalls = 0;
    const modelRequests: GatewayRequest[] = [];
    const model: ModelPort = {
      call(request, signal): Promise<NormalizedResponse> {
        modelCalls += 1;
        modelRequests.push(request);
        observedSignal = signal;
        started.resolve(undefined);
        return response.promise;
      },
    };
    const captured = captureResWithEvents();
    const outcome = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "keep the transcript only",
          clientTurnId: "buffered-disconnect",
        }),
        captured.res,
      ),
      deps(model),
    );
    await started.promise;

    captured.emitClose();
    expect(observedSignal?.aborted).toBe(true);
    await expect(outcome).resolves.toMatchObject({
      status: 499,
      body: { error: { code: "REQUEST_CANCELLED" } },
    });
    const successor = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "successor waits for cancelled provider",
          clientTurnId: "buffered-successor",
        }),
        captureRes().res,
      ),
      deps(model),
    );
    await Promise.resolve();
    expect(modelCalls).toBe(1);
    response.resolve(normalizedResponse("successor answer"));

    await expect(successor).resolves.toMatchObject({ status: 200 });
    expect(modelCalls).toBe(2);
    expect(modelRequests[1]?.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "keep the transcript only" }),
      ]),
    );
    expect(store.listMessages(chatId)).toMatchObject([
      { role: "user", content: "keep the transcript only", turnState: "cancelled" },
      { role: "user", content: "successor waits for cancelled provider" },
      { role: "assistant", content: "successor answer" },
    ]);
    expect(
      store.inspectChatTurn(
        chatId,
        "buffered-disconnect",
        canonicalPlainTurnIdentity(chatId, "keep the transcript only"),
      ).kind,
    ).toBe("conflict");
  });

  it("maps a generic buffered provider abort rejection to a canonical cancellation", async () => {
    const chatId = seedChat();
    const started = deferred<undefined>();
    const model: ModelPort = {
      call(_request, signal): Promise<NormalizedResponse> {
        started.resolve(undefined);
        return new Promise<NormalizedResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("provider emitted a generic abort error"));
            },
            { once: true },
          );
        });
      },
    };
    const captured = captureResWithEvents();
    const outcome = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "generic provider abort",
          clientTurnId: "generic-provider-abort",
        }),
        captured.res,
      ),
      deps(model),
    );
    await started.promise;

    captured.emitClose();

    await expect(outcome).resolves.toMatchObject({ status: 499 });
    expect(store.listMessages(chatId)).toMatchObject([
      { role: "user", content: "generic provider abort", turnState: "cancelled" },
    ]);
    expect(
      store.inspectChatTurn(
        chatId,
        "generic-provider-abort",
        canonicalPlainTurnIdentity(chatId, "generic provider abort"),
      ).kind,
    ).toBe("retryable");
  });

  it.each([
    { label: "legacy turn", clientTurnId: undefined },
    { label: "canonical turn", clientTurnId: "buffered-memory-disconnect" },
  ])(
    "keeps $label assistant-free when cancellation lands during memory preparation",
    async (testCase) => {
      const chatId = seedChat();
      const memoryDir = join(tmp, `memory-${testCase.label.replace(" ", "-")}`);
      mkdirSync(memoryDir);
      const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
      const embedding = deferred<OpenAIEmbeddingOutcome>();
      const embeddingStarted = deferred<undefined>();
      let modelFinished = false;
      let modelCalls = 0;
      const model: ModelPort = {
        call(): Promise<NormalizedResponse> {
          modelCalls += 1;
          modelFinished = true;
          return Promise.resolve(normalizedResponse("assistant must remain uncommitted"));
        },
      };
      const sharedDeps = deps(model, {
        config: chatAndEmbeddingConfig(),
        memoryVault,
        localKnowledgeEmbeddingRequest: () => {
          if (modelFinished) {
            embeddingStarted.resolve(undefined);
            return embedding.promise;
          }
          return Promise.resolve({
            ok: true,
            value: {
              vector: Float32Array.from([1, 0]),
              modelId: "text-embedding-3-small",
            },
          });
        },
      });
      const captured = captureResWithEvents();
      const outcome = handleSendDesktopChat(
        routeContext(
          makeReq({
            chatId,
            projectPath: projectDir,
            content: "Remember that deployment waits for green CI.",
            memory: { enabled: true, budgetTokens: 900, context: {} },
            ...(testCase.clientTurnId === undefined ? {} : { clientTurnId: testCase.clientTurnId }),
          }),
          captured.res,
        ),
        sharedDeps,
      );
      await embeddingStarted.promise;

      captured.emitClose();
      await expect(outcome).resolves.toMatchObject({ status: 499 });
      expect(store.listMessages(chatId)).toMatchObject([
        { role: "user", content: "Remember that deployment waits for green CI." },
      ]);
      const successor = handleSendDesktopChat(
        routeContext(
          makeReq({
            chatId,
            projectPath: projectDir,
            content: `successor after ${testCase.label}`,
            clientTurnId: `successor-${testCase.label.replace(" ", "-")}`,
          }),
          captureRes().res,
        ),
        sharedDeps,
      );
      await Promise.resolve();
      expect(modelCalls).toBe(1);
      embedding.resolve({
        ok: true,
        value: {
          vector: Float32Array.from([1, 0]),
          modelId: "text-embedding-3-small",
        },
      });

      await expect(successor).resolves.toMatchObject({ status: 200 });
      expect(modelCalls).toBe(2);
      expect(store.listMessages(chatId)).toMatchObject([
        { role: "user", content: "Remember that deployment waits for green CI." },
        { role: "user", content: `successor after ${testCase.label}` },
        { role: "assistant", content: "assistant must remain uncommitted" },
      ]);
      if (testCase.clientTurnId !== undefined) {
        expect(
          store.inspectChatTurn(
            chatId,
            testCase.clientTurnId,
            canonicalPlainTurnIdentity(chatId, "Remember that deployment waits for green CI.", {
              memory: { enabled: true, budgetTokens: 900 },
            }),
          ).kind,
        ).toBe("conflict");
      }
      memoryVault.close();
    },
  );

  it("keeps a streamed assistant uncommitted when cancellation lands during memory preparation", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "stream-memory-disconnect");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const embedding = deferred<OpenAIEmbeddingOutcome>();
    const embeddingStarted = deferred<undefined>();
    let streamFinished = false;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        streamFinished = true;
        yield { type: "done", response: normalizedResponse("stream must remain uncommitted") };
      },
    };
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      memoryVault,
      localKnowledgeEmbeddingRequest: () => {
        if (streamFinished) {
          embeddingStarted.resolve(undefined);
          return embedding.promise;
        }
        return Promise.resolve({
          ok: true,
          value: {
            vector: Float32Array.from([1, 0]),
            modelId: "text-embedding-3-small",
          },
        });
      },
    });
    const captured = captureResWithEvents();
    const outcome = handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "Remember that streamed deployment also waits for green CI.",
          clientTurnId: "stream-memory-disconnect",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captured.res,
      ),
      sharedDeps,
    );
    await embeddingStarted.promise;

    captured.emitClose();
    embedding.resolve({
      ok: true,
      value: {
        vector: Float32Array.from([1, 0]),
        modelId: "text-embedding-3-small",
      },
    });

    await expect(outcome).resolves.toBe(STREAMING);
    expect(parseSse(captured.writes).map((record) => record.event)).not.toContain("done");
    expect(store.listMessages(chatId)).toMatchObject([
      {
        role: "user",
        content: "Remember that streamed deployment also waits for green CI.",
      },
    ]);
    expect(
      store.inspectChatTurn(
        chatId,
        "stream-memory-disconnect",
        canonicalPlainTurnIdentity(
          chatId,
          "Remember that streamed deployment also waits for green CI.",
          { memory: { enabled: true, budgetTokens: 900 } },
        ),
      ).kind,
    ).toBe("retryable");
    memoryVault.close();
  });

  it("does not start a provider stream after cancellation during memory retrieval", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "stream-memory-retrieval-disconnect");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(
      memoryVault,
      "retrieve this candidate before streaming",
    );
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    const embedding = deferred<OpenAIEmbeddingOutcome>();
    const embeddingStarted = deferred<undefined>();
    let streamCalls = 0;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        streamCalls += 1;
        yield { type: "done", response: normalizedResponse("must not run") };
      },
    };
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      memoryVault,
      localKnowledgeEmbeddingRequest: () => {
        embeddingStarted.resolve(undefined);
        return embedding.promise;
      },
    });
    const captured = captureResWithEvents();
    const outcome = handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "retrieve memory before streaming",
          clientTurnId: "stream-memory-retrieval-disconnect",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captured.res,
      ),
      sharedDeps,
    );
    await embeddingStarted.promise;

    captured.emitClose();
    embedding.resolve({
      ok: true,
      value: {
        vector: Float32Array.from([1, 0]),
        modelId: "text-embedding-3-small",
      },
    });

    await expect(outcome).resolves.toBe(STREAMING);
    expect(streamCalls).toBe(0);
    expect(store.listMessages(chatId)).toMatchObject([
      { role: "user", content: "retrieve memory before streaming" },
    ]);
    expect(
      store.inspectChatTurn(
        chatId,
        "stream-memory-retrieval-disconnect",
        canonicalPlainTurnIdentity(chatId, "retrieve memory before streaming", {
          memory: { enabled: true, budgetTokens: 900 },
        }),
      ).kind,
    ).toBe("retryable");
    memoryVault.close();
  });

  it("rejects a buffered turn when the gateway generation changes during memory retrieval", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "buffered-readiness-generation-race");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(memoryVault, "buffered generation race candidate");
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    const embedding = deferred<OpenAIEmbeddingOutcome>();
    const embeddingStarted = deferred<undefined>();
    const holder = readyRuntimeGatewayConfig(chatAndEmbeddingConfig());
    let factoryCalls = 0;
    let providerCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        providerCalls += 1;
        return Promise.resolve(normalizedResponse("must not run"));
      },
    };
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: holder,
      memoryVault,
      modelPortFactory: () => {
        factoryCalls += 1;
        return model;
      },
      localKnowledgeEmbeddingRequest: () => {
        embeddingStarted.resolve(undefined);
        return embedding.promise;
      },
    });
    const secretContent = "BUFFERED_GENERATION_RACE_SECRET_7A12";
    const outcome = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: secretContent,
          clientTurnId: "buffered-readiness-generation-race",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await embeddingStarted.promise;
    replaceWithReadyRuntimeConfig(holder);
    embedding.resolve({
      ok: true,
      value: { vector: Float32Array.from([1, 0]), modelId: "text-embedding-3-small" },
    });

    const rejected = await outcome;
    expect(rejected).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(JSON.stringify(rejected.body)).not.toContain(secretContent);
    expect(factoryCalls).toBe(0);
    expect(providerCalls).toBe(0);
    memoryVault.close();
  });

  it("settles the admitted turn when pre-stream memory resolution rejects", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "streamed-memory-rejection-settles");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(memoryVault, "memory rejection settle candidate");
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    const holder = readyRuntimeGatewayConfig(chatAndEmbeddingConfig());
    let providerCalls = 0;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        providerCalls += 1;
        await Promise.resolve();
        yield { type: "done", response: normalizedResponse("retry succeeded") };
      },
    };
    // Retrieval-time vault failure (index/SQLite class): every vault operation throws. The
    // embedding seam is deliberately self-contained, so the vault is the uncontained boundary
    // this regression pins.
    const explodingVault = new Proxy(memoryVault, {
      get(target, prop, receiver): unknown {
        if (prop === "close") return Reflect.get(target, prop, receiver);
        return (): never => {
          throw new Error("vault exploded");
        };
      },
    });
    const embeddingOk = (): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve({
        ok: true,
        value: { vector: Float32Array.from([1, 0]), modelId: "text-embedding-3-small" },
      });
    const failingDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: holder,
      memoryVault: explodingVault,
      localKnowledgeEmbeddingRequest: embeddingOk,
    });
    const healthyDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: holder,
      memoryVault,
      localKnowledgeEmbeddingRequest: embeddingOk,
    });
    const request = {
      chatId,
      projectPath: projectDir,
      content: "memory rejection must settle the turn",
      clientTurnId: "memory-rejection-settles",
      memory: { enabled: true, budgetTokens: 900, context: {} },
    };

    // First attempt: memory retrieval throws AFTER admission. The turn MUST be settled —
    // an unsettled "pending" turn would answer every retry with CHAT_TURN_IN_PROGRESS forever.
    await expect(
      handleSendDesktopChatStream(routeContext(makeReq(request), captureRes().res), failingDeps),
    ).rejects.toThrow("vault exploded");
    expect(providerCalls).toBe(0);

    const retry = await handleSendDesktopChatStream(
      routeContext(makeReq(request), captureRes().res),
      healthyDeps,
    );
    expect(retry).toBe(STREAMING);
    expect(providerCalls).toBe(1);
    memoryVault.close();
  });

  it("rejects a legacy stream on a call-only port before persisting, with a ready gateway", async () => {
    const chatId = seedChat();
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("buffered only")),
    };
    const holder = readyRuntimeGatewayConfig(chatAndEmbeddingConfig());
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: holder,
    });
    const request = {
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "legacy stream with a configured gateway",
    };

    const streamResult = await handleSendDesktopChatStream(
      routeContext(makeReq(request), captureRes().res),
      sharedDeps,
    );

    // A legacy rejection cannot settle a turn (no clientTurnId), so it must happen BEFORE
    // admission persists the user message — otherwise the buffered fallback duplicates it.
    expect(streamResult).toMatchObject({ status: 400 });
    expect(store.listMessages(chatId)).toEqual([]);
  });

  it("rejects a streamed turn when the gateway generation changes during memory retrieval", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "streamed-readiness-generation-race");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(memoryVault, "streamed generation race candidate");
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    const embedding = deferred<OpenAIEmbeddingOutcome>();
    const embeddingStarted = deferred<undefined>();
    const holder = readyRuntimeGatewayConfig(chatAndEmbeddingConfig());
    let factoryCalls = 0;
    let providerCalls = 0;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        providerCalls += 1;
        await Promise.resolve();
        yield { type: "done", response: normalizedResponse("must not run") };
      },
    };
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: holder,
      memoryVault,
      modelPortFactory: () => {
        factoryCalls += 1;
        return model;
      },
      localKnowledgeEmbeddingRequest: () => {
        embeddingStarted.resolve(undefined);
        return embedding.promise;
      },
    });
    const secretContent = "STREAMED_GENERATION_RACE_SECRET_8B23";
    const captured = captureRes();
    const outcome = handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: secretContent,
          clientTurnId: "streamed-readiness-generation-race",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captured.res,
      ),
      sharedDeps,
    );
    await embeddingStarted.promise;
    replaceWithReadyRuntimeConfig(holder);
    embedding.resolve({
      ok: true,
      value: { vector: Float32Array.from([1, 0]), modelId: "text-embedding-3-small" },
    });

    const rejected = await outcome;
    expect(rejected).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(JSON.stringify(rejected)).not.toContain(secretContent);
    expect(captured.status).toBeUndefined();
    expect(captured.writes).toEqual([]);
    expect(factoryCalls).toBe(0);
    expect(providerCalls).toBe(0);
    memoryVault.close();
  });

  it("discards the persisted legacy user row when the stream is rejected after memory retrieval", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "legacy-streamed-readiness-generation-race");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(memoryVault, "legacy streamed race candidate");
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    const embedding = deferred<OpenAIEmbeddingOutcome>();
    const embeddingStarted = deferred<undefined>();
    const holder = readyRuntimeGatewayConfig(chatAndEmbeddingConfig());
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        yield { type: "done", response: normalizedResponse("must not run") };
      },
    };
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: holder,
      memoryVault,
      modelPortFactory: () => model,
      localKnowledgeEmbeddingRequest: () => {
        embeddingStarted.resolve(undefined);
        return embedding.promise;
      },
    });
    const messagesBefore = sharedDeps.store.countMessages(chatId);
    const captured = captureRes();
    // No clientTurnId: the ledger cannot settle this turn, so the post-admission readiness
    // rejection must discard the just-admitted user row — otherwise the rejected request
    // leaves an orphaned message and every client retry duplicates it.
    const outcome = handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "legacy row must not survive rejection",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captured.res,
      ),
      sharedDeps,
    );
    await embeddingStarted.promise;
    replaceWithReadyRuntimeConfig(holder);
    embedding.resolve({
      ok: true,
      value: { vector: Float32Array.from([1, 0]), modelId: "text-embedding-3-small" },
    });

    const rejected = await outcome;
    expect(rejected).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(sharedDeps.store.countMessages(chatId)).toBe(messagesBefore);
    expect(
      sharedDeps.store
        .listMessages(chatId)
        .some((message) => message.content === "legacy row must not survive rejection"),
    ).toBe(false);
    memoryVault.close();
  });

  it("discards the persisted legacy user row when a buffered memory failure rejects the turn", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "legacy-buffered-memory-failure");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const holder = readyRuntimeGatewayConfig(chatAndEmbeddingConfig());
    let providerCalls = 0;
    const model: ModelPort = {
      call: () => {
        providerCalls += 1;
        return Promise.resolve(normalizedResponse("must not run"));
      },
    };
    // Retrieval-time vault failure, same class as the streamed settle pin above — but for a
    // LEGACY request the ledger cannot settle, so the just-admitted user row must be discarded.
    const explodingVault = new Proxy(memoryVault, {
      get(target, prop, receiver): unknown {
        if (prop === "close") return Reflect.get(target, prop, receiver);
        return (): never => {
          throw new Error("vault exploded");
        };
      },
    });
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: holder,
      memoryVault: explodingVault,
      modelPortFactory: () => model,
      localKnowledgeEmbeddingRequest: () =>
        Promise.resolve({
          ok: true,
          value: { vector: Float32Array.from([1, 0]), modelId: "text-embedding-3-small" },
        }),
    });
    const messagesBefore = sharedDeps.store.countMessages(chatId);
    const send = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "legacy buffered row must not survive rejection",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    const outcome = await send.then(
      (result) => result.status,
      () => "rejected" as const,
    );
    expect(outcome === "rejected" || outcome >= 500).toBe(true);
    expect(providerCalls).toBe(0);
    expect(sharedDeps.store.countMessages(chatId)).toBe(messagesBefore);
    memoryVault.close();
  });

  it("discards the legacy user row when cancellation lands during buffered memory retrieval", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "legacy-buffered-cancel-during-memory");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(memoryVault, "legacy buffered cancel candidate");
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    let providerCalls = 0;
    const model: ModelPort = {
      call: () => {
        providerCalls += 1;
        return Promise.resolve(normalizedResponse("must not run"));
      },
    };
    const captured = captureResWithEvents();
    // The client disconnects DURING retrieval, and retrieval then completes NORMALLY: the
    // vault read itself fires the close event and continues, so the abort is guaranteed to
    // land inside the memory window regardless of the semantic-gate embedding path.
    const abortingVault = new Proxy(memoryVault, {
      get(target, property, receiver): unknown {
        const original = Reflect.get(target, property, receiver) as unknown;
        if (property === "listMemoriesByScope" && typeof original === "function") {
          return (...args: unknown[]): unknown => {
            captured.emitClose();
            return (original as (...inner: unknown[]) => unknown).apply(target, args);
          };
        }
        return original;
      },
    });
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: readyRuntimeGatewayConfig(chatAndEmbeddingConfig()),
      memoryVault: abortingVault,
      modelPortFactory: () => model,
      localKnowledgeEmbeddingRequest: () =>
        Promise.resolve({
          ok: true,
          value: { vector: Float32Array.from([1, 0]), modelId: "text-embedding-3-small" },
        }),
    });
    const messagesBefore = sharedDeps.store.countMessages(chatId);
    const result = await handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "legacy cancel during memory must discard the row",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captured.res,
      ),
      sharedDeps,
    );
    expect(result.status).toBe(499);
    expect(providerCalls).toBe(0);
    expect(sharedDeps.store.countMessages(chatId)).toBe(messagesBefore);
    memoryVault.close();
  });

  it("rejects regeneration when the gateway generation changes during memory retrieval", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "original regeneration question");
    seedMessage(chatId, "assistant", "original regeneration answer");
    const assistant = store.listMessages(chatId).at(-1);
    if (assistant === undefined) throw new Error("missing assistant fixture");
    const memoryDir = join(tmp, "regenerate-readiness-generation-race");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(memoryVault, "regeneration generation race candidate");
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    const embedding = deferred<OpenAIEmbeddingOutcome>();
    const embeddingStarted = deferred<undefined>();
    const holder = readyRuntimeGatewayConfig(chatAndEmbeddingConfig());
    let factoryCalls = 0;
    let providerCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        providerCalls += 1;
        return Promise.resolve(normalizedResponse("must not run"));
      },
    };
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      gatewayConfig: holder,
      memoryVault,
      modelPortFactory: () => {
        factoryCalls += 1;
        return model;
      },
      localKnowledgeEmbeddingRequest: () => {
        embeddingStarted.resolve(undefined);
        return embedding.promise;
      },
    });
    const outcome = handleRegenerateDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          assistantMessageId: assistant.id,
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await embeddingStarted.promise;
    replaceWithReadyRuntimeConfig(holder);
    embedding.resolve({
      ok: true,
      value: { vector: Float32Array.from([1, 0]), modelId: "text-embedding-3-small" },
    });

    const rejected = await outcome;
    expect(rejected).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(JSON.stringify(rejected.body)).not.toContain("original regeneration question");
    expect(factoryCalls).toBe(0);
    expect(providerCalls).toBe(0);
    memoryVault.close();
  });

  it("freezes the buffered prompt snapshot before asynchronous memory retrieval", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "buffered-prompt-snapshot");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(memoryVault, "snapshot memory candidate");
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    const embedding = deferred<OpenAIEmbeddingOutcome>();
    const embeddingStarted = deferred<undefined>();
    let recorded: GatewayRequest | undefined;
    const model: ModelPort = {
      call(request): Promise<NormalizedResponse> {
        recorded = request;
        return Promise.resolve(normalizedResponse("snapshot answer"));
      },
    };
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      memoryVault,
      localKnowledgeEmbeddingRequest: () => {
        embeddingStarted.resolve(undefined);
        return embedding.promise;
      },
    });
    const admitted = "ADMITTED_BUFFERED_SNAPSHOT_7F3A";
    const future = "FUTURE_BUFFERED_RAW_WRITER_91BC";
    const outcome = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: admitted,
          clientTurnId: "buffered-prompt-snapshot",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await embeddingStarted.promise;
    seedMessage(chatId, "user", future);
    embedding.resolve({
      ok: true,
      value: {
        vector: Float32Array.from([1, 0]),
        modelId: "text-embedding-3-small",
      },
    });

    await expect(outcome).resolves.toMatchObject({ status: 200 });
    const prompt = recorded?.messages.map((message) => message.content).join("\n") ?? "";
    expect(prompt.split(admitted)).toHaveLength(2);
    expect(prompt).not.toContain(future);
    expect(store.listMessages(chatId).some((message) => message.content === future)).toBe(true);
    memoryVault.close();
  });

  it("freezes the streamed prompt snapshot before asynchronous memory retrieval", async () => {
    const chatId = seedChat();
    const memoryDir = join(tmp, "streamed-prompt-snapshot");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const remembered = insertAcceptedMemory(memoryVault, "streamed snapshot memory candidate");
    memoryVault.upsertEmbedding(remembered.id, {
      provider: "test-provider",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: Float32Array.from([1, 0]),
    });
    const embedding = deferred<OpenAIEmbeddingOutcome>();
    const embeddingStarted = deferred<undefined>();
    let recorded: GatewayRequest | undefined;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      async *callStream(request): AsyncGenerator<GatewayStreamChunk> {
        recorded = request;
        await Promise.resolve();
        yield { type: "done", response: normalizedResponse("streamed snapshot answer") };
      },
    };
    const sharedDeps = deps(model, {
      config: chatAndEmbeddingConfig(),
      memoryVault,
      localKnowledgeEmbeddingRequest: () => {
        embeddingStarted.resolve(undefined);
        return embedding.promise;
      },
    });
    const admitted = "ADMITTED_STREAMED_SNAPSHOT_6D2E";
    const future = "FUTURE_STREAMED_RAW_WRITER_A4C8";
    const captured = captureRes();
    const outcome = handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: admitted,
          clientTurnId: "streamed-prompt-snapshot",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        captured.res,
      ),
      sharedDeps,
    );
    await embeddingStarted.promise;
    seedMessage(chatId, "user", future);
    embedding.resolve({
      ok: true,
      value: {
        vector: Float32Array.from([1, 0]),
        modelId: "text-embedding-3-small",
      },
    });

    await expect(outcome).resolves.toBe(STREAMING);
    const prompt = recorded?.messages.map((message) => message.content).join("\n") ?? "";
    expect(prompt.split(admitted)).toHaveLength(2);
    expect(prompt).not.toContain(future);
    expect(store.listMessages(chatId).some((message) => message.content === future)).toBe(true);
    expect(parseSse(captured.writes).filter((record) => record.event === "done")).toHaveLength(1);
    memoryVault.close();
  });

  it.each(["buffered", "streamed"] as const)(
    "preserves a concurrent title and model patch after a %s turn",
    async (transport) => {
      const chatId = seedChat();
      const response = deferred<NormalizedResponse>();
      const started = deferred<undefined>();
      const model: ModelPort = {
        call(): Promise<NormalizedResponse> {
          started.resolve(undefined);
          return response.promise;
        },
        async *callStream(): AsyncGenerator<GatewayStreamChunk> {
          started.resolve(undefined);
          const final = await response.promise;
          yield { type: "done", response: final };
        },
      };
      const sharedDeps = deps(model, { config: twoChatModelConfig() });
      const request = makeReq({
        chatId,
        projectPath: projectDir,
        content: `${transport} stale chat patch`,
        modelId: CHAT_MODEL,
      });
      const outcome =
        transport === "buffered"
          ? handleSendDesktopChat(routeContext(request, captureRes().res), sharedDeps)
          : handleSendDesktopChatStream(routeContext(request, captureRes().res), sharedDeps);
      await started.promise;

      store.updateChat(chatId, {
        title: "User rename",
        selectedModel: ALTERNATE_CHAT_MODEL,
      });
      response.resolve(normalizedResponse("completed after patch"));

      if (transport === "buffered") await expect(outcome).resolves.toMatchObject({ status: 200 });
      else await expect(outcome).resolves.toBe(STREAMING);
      expect(store.findChatById(chatId)).toMatchObject({
        title: "User rename",
        selectedModel: ALTERNATE_CHAT_MODEL,
      });
    },
  );

  it("captures a buffered disconnect that happens before request body parsing finishes", async () => {
    const chatId = seedChat();
    let modelCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        modelCalls += 1;
        return Promise.resolve(normalizedResponse("must not run"));
      },
    };
    const req = new PassThrough() as unknown as IncomingMessage;
    const captured = captureResWithEvents();
    const outcome = handleSendDesktopChat(routeContext(req, captured.res), deps(model));

    (req as unknown as PassThrough).write(Buffer.from(`{"chatId":"${chatId}",`));
    req.emit("aborted");

    await expect(outcome).resolves.toMatchObject({ status: 499 });
    expect(modelCalls).toBe(0);
    expect(store.listMessages(chatId)).toEqual([]);
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(1);
    expect(req.listenerCount("error")).toBe(1);
    expect(req.listenerCount("close")).toBe(1);
    expect(req.listenerCount("aborted")).toBe(0);
    const closed = new Promise<void>((resolve) => {
      req.once("close", resolve);
    });
    (req as unknown as PassThrough).destroy();
    await closed;
    expect(req.listenerCount("end")).toBe(0);
    expect(req.listenerCount("error")).toBe(0);
    expect(req.listenerCount("close")).toBe(0);
  });

  it("captures an SSE disconnect before body parsing without admission, provider, or headers", async () => {
    const chatId = seedChat();
    let streamCalls = 0;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        streamCalls += 1;
        yield { type: "done", response: normalizedResponse("must not run") };
      },
    };
    const req = new PassThrough() as unknown as IncomingMessage;
    const captured = captureResWithEvents();
    const outcome = handleSendDesktopChatStream(routeContext(req, captured.res), deps(model));

    (req as unknown as PassThrough).write(Buffer.from(`{"chatId":"${chatId}",`));
    captured.emitClose();

    await expect(outcome).resolves.toMatchObject({ status: 499 });
    expect(streamCalls).toBe(0);
    expect(captured.status).toBeUndefined();
    expect(captured.writes).toEqual([]);
    expect(store.listMessages(chatId)).toEqual([]);
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(1);
    expect(req.listenerCount("error")).toBe(1);
    expect(req.listenerCount("close")).toBe(1);
    expect(req.listenerCount("aborted")).toBe(0);
    const closed = new Promise<void>((resolve) => {
      req.once("close", resolve);
    });
    (req as unknown as PassThrough).destroy();
    await closed;
    expect(req.listenerCount("end")).toBe(0);
    expect(req.listenerCount("error")).toBe(0);
    expect(req.listenerCount("close")).toBe(0);
  });

  it("does not write an SSE replay after disconnecting before its body finishes", async () => {
    const chatId = seedChat();
    const clientTurnId = "completed-replay-before-body";
    const content = "completed replay question";
    const identityContent = canonicalPlainTurnIdentity(chatId, content);
    const admission = store.admitChatTurn(
      clientTurnId,
      {
        chatId,
        role: "user",
        content,
        timestamp: 1,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      },
      { identityContent },
    );
    if (admission.kind !== "admitted") throw new Error("expected canonical admission");
    const assistant = store.createTurnAssistant(admission.userMessage.id, {
      chatId,
      role: "assistant",
      content: "completed replay answer",
      timestamp: 2,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(store.completeChatTurn(chatId, clientTurnId, identityContent, assistant.id).kind).toBe(
      "completed",
    );
    let streamCalls = 0;
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        streamCalls += 1;
        yield { type: "done", response: normalizedResponse("must not run") };
      },
    };
    const req = new PassThrough() as unknown as IncomingMessage;
    const captured = captureResWithEvents();
    const outcome = handleSendDesktopChatStream(routeContext(req, captured.res), deps(model));

    (req as unknown as PassThrough).write(Buffer.from(`{"chatId":"${chatId}",`));
    captured.emitClose();

    await expect(outcome).resolves.toMatchObject({ status: 499 });
    expect(streamCalls).toBe(0);
    expect(captured.status).toBeUndefined();
    expect(captured.writes).toEqual([]);
    expect(captured.ended).toBe(false);
    (req as unknown as PassThrough).destroy();
  });

  it("captures a regeneration disconnect before body parsing without calling the model", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "original question");
    seedMessage(chatId, "assistant", "original answer");
    const assistant = store.listMessages(chatId).at(-1);
    if (assistant === undefined) throw new Error("missing assistant fixture");
    let modelCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        modelCalls += 1;
        return Promise.resolve(normalizedResponse("must not run"));
      },
    };
    const req = new PassThrough() as unknown as IncomingMessage;
    const captured = captureResWithEvents();
    const outcome = handleRegenerateDesktopChat(routeContext(req, captured.res), deps(model));

    (req as unknown as PassThrough).write(Buffer.from(`{"chatId":"${chatId}",`));
    req.emit("aborted");

    await expect(outcome).resolves.toMatchObject({ status: 499 });
    expect(modelCalls).toBe(0);
    expect(store.listMessages(chatId).map((message) => message.content)).toEqual([
      "original question",
      "original answer",
    ]);
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(1);
    expect(req.listenerCount("error")).toBe(1);
    expect(req.listenerCount("close")).toBe(1);
    expect(req.listenerCount("aborted")).toBe(0);
    const closed = new Promise<void>((resolve) => {
      req.once("close", resolve);
    });
    (req as unknown as PassThrough).destroy();
    await closed;
    expect(req.listenerCount("end")).toBe(0);
    expect(req.listenerCount("error")).toBe(0);
    expect(req.listenerCount("close")).toBe(0);
  });

  it("maps a generic regeneration provider abort rejection to cancellation", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "original question");
    seedMessage(chatId, "assistant", "original answer");
    const assistant = store.listMessages(chatId).at(-1);
    if (assistant === undefined) throw new Error("missing assistant fixture");
    const started = deferred<undefined>();
    const model: ModelPort = {
      call(_request, signal): Promise<NormalizedResponse> {
        started.resolve(undefined);
        return new Promise<NormalizedResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("provider emitted a generic abort error"));
            },
            { once: true },
          );
        });
      },
    };
    const captured = captureResWithEvents();
    const outcome = handleRegenerateDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          assistantMessageId: assistant.id,
        }),
        captured.res,
      ),
      deps(model),
    );
    await started.promise;

    captured.emitClose();

    await expect(outcome).resolves.toMatchObject({ status: 499 });
    expect(store.listMessages(chatId).map((message) => message.content)).toEqual([
      "original question",
      "original answer",
    ]);
  });

  it("keeps regeneration serialized until an abort-ignoring provider actually settles", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "original question");
    seedMessage(chatId, "assistant", "original answer");
    const assistant = store.listMessages(chatId).at(-1);
    if (assistant === undefined) throw new Error("missing assistant fixture");
    const response = deferred<NormalizedResponse>();
    const started = deferred<undefined>();
    let modelCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        modelCalls += 1;
        started.resolve(undefined);
        return response.promise;
      },
    };
    const sharedDeps = deps(model);
    const captured = captureResWithEvents();
    const regeneration = handleRegenerateDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          assistantMessageId: assistant.id,
        }),
        captured.res,
      ),
      sharedDeps,
    );
    await started.promise;
    captured.emitClose();
    await expect(regeneration).resolves.toMatchObject({ status: 499 });

    const successor = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "successor after regeneration",
          clientTurnId: "regeneration-successor",
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await Promise.resolve();
    expect(modelCalls).toBe(1);
    response.resolve(normalizedResponse("successor answer"));

    await expect(successor).resolves.toMatchObject({ status: 200 });
    expect(modelCalls).toBe(2);
    expect(store.listMessages(chatId).map((message) => message.content)).toEqual([
      "original question",
      "original answer",
      "successor after regeneration",
      "successor answer",
    ]);
  });

  it("rejects regeneration when the target assistant changes during the provider call", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "original question");
    seedMessage(chatId, "assistant", "original answer");
    const assistant = store.listMessages(chatId).at(-1);
    if (assistant === undefined) throw new Error("missing assistant fixture");
    const response = deferred<NormalizedResponse>();
    const started = deferred<undefined>();
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        started.resolve(undefined);
        return response.promise;
      },
    };
    const outcome = handleRegenerateDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          assistantMessageId: assistant.id,
        }),
        captureRes().res,
      ),
      deps(model),
    );
    await started.promise;

    store.createAssistantResponseVersion(assistant.id, "parallel edit", assistant.timestamp + 1);
    response.resolve(normalizedResponse("stale regenerated answer"));

    await expect(outcome).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "NOT_APPLIABLE" } },
    });
    expect(store.listMessages(chatId).map((message) => message.content)).toEqual([
      "original question",
      "parallel edit",
    ]);
  });

  it("rejects regeneration of grounded metadata after the chat scope is detached", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "grounded question");
    seedMessage(chatId, "assistant", "grounded answer");
    const [user, assistant] = store.listMessages(chatId);
    if (user === undefined || assistant === undefined) throw new Error("missing grounded fixture");
    store.attachGroundedAnswer(assistant.id, {
      groundingKind: "connected-context",
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      content: assistant.content,
      citations: [],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 0,
      contextPack: {},
    } as unknown as GroundedAnswer);
    const groundedBeforeDetach = store.findMessageById(assistant.id)?.groundedAnswer;
    store.updateChat(chatId, { connectedScope: null, connectedScopes: null });
    let modelCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        modelCalls += 1;
        return Promise.resolve(normalizedResponse("must not replace grounded answer"));
      },
    };

    const outcome = await handleRegenerateDesktopChat(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, assistantMessageId: assistant.id }),
        captureRes().res,
      ),
      deps(model),
    );

    expect(outcome).toMatchObject({
      status: 409,
      body: { error: { code: "NOT_APPLIABLE" } },
    });
    expect(modelCalls).toBe(0);
    expect(store.findMessageById(assistant.id)?.content).toBe("grounded answer");
    expect(store.findMessageById(assistant.id)?.groundedAnswer).toEqual(groundedBeforeDetach);
    expect(store.findMessageById(assistant.id)?.responseVersions).toBeUndefined();
  });

  it("preserves a concurrent title and model patch after regeneration", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "original question");
    seedMessage(chatId, "assistant", "original answer");
    const assistant = store.listMessages(chatId).at(-1);
    if (assistant === undefined) throw new Error("missing assistant fixture");
    const response = deferred<NormalizedResponse>();
    const started = deferred<undefined>();
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        started.resolve(undefined);
        return response.promise;
      },
    };
    const sharedDeps = deps(model, { config: twoChatModelConfig() });
    const outcome = handleRegenerateDesktopChat(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, assistantMessageId: assistant.id }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await started.promise;

    store.updateChat(chatId, { title: "User rename", selectedModel: ALTERNATE_CHAT_MODEL });
    response.resolve(normalizedResponse("regenerated after patch"));

    await expect(outcome).resolves.toMatchObject({ status: 200 });
    expect(store.findChatById(chatId)).toMatchObject({
      title: "User rename",
      selectedModel: ALTERNATE_CHAT_MODEL,
    });
  });

  it("serializes regeneration with a following canonical send and refreshes its model", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "original question");
    seedMessage(chatId, "assistant", "original answer");
    const assistant = store.listMessages(chatId).at(-1);
    if (assistant === undefined) throw new Error("missing assistant fixture");
    const regenerated = deferred<NormalizedResponse>();
    const regenerateStarted = deferred<undefined>();
    let alternateCalls = 0;
    let defaultCalls = 0;
    const alternateModel: ModelPort = {
      call(): Promise<NormalizedResponse> {
        alternateCalls += 1;
        if (alternateCalls === 1) {
          regenerateStarted.resolve(undefined);
          return regenerated.promise;
        }
        return Promise.resolve(normalizedResponse("following answer", ALTERNATE_CHAT_MODEL));
      },
    };
    const defaultModel: ModelPort = {
      call(): Promise<NormalizedResponse> {
        defaultCalls += 1;
        return Promise.resolve(normalizedResponse("stale following answer"));
      },
    };
    const sharedDeps = deps(defaultModel, {
      config: twoChatModelConfig(),
      modelPortFactory: (modelId) =>
        modelId === ALTERNATE_CHAT_MODEL ? alternateModel : defaultModel,
    });
    const regenerate = handleRegenerateDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          assistantMessageId: assistant.id,
          modelId: ALTERNATE_CHAT_MODEL,
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await regenerateStarted.promise;
    const following = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "following question",
          clientTurnId: "following-canonical-turn",
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const defaultCallsBeforeRelease = defaultCalls;
    const alternateCallsBeforeRelease = alternateCalls;

    regenerated.resolve(normalizedResponse("regenerated answer", ALTERNATE_CHAT_MODEL));
    await expect(regenerate).resolves.toMatchObject({ status: 200 });
    await expect(following).resolves.toMatchObject({ status: 200 });

    expect(defaultCallsBeforeRelease).toBe(0);
    expect(alternateCallsBeforeRelease).toBe(1);
    expect(defaultCalls).toBe(0);
    expect(alternateCalls).toBe(2);
    expect(store.listMessages(chatId).map((entry) => entry.content)).toEqual([
      "original question",
      "regenerated answer",
      "following question",
      "following answer",
    ]);
  });

  it("rejects a queued regeneration when its assistant is no longer the latest turn", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "original question");
    seedMessage(chatId, "assistant", "original answer");
    const target = store.listMessages(chatId).at(-1);
    if (target === undefined) throw new Error("missing assistant fixture");
    const firstResponse = deferred<NormalizedResponse>();
    const firstStarted = deferred<undefined>();
    let modelCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        modelCalls += 1;
        firstStarted.resolve(undefined);
        return firstResponse.promise;
      },
    };
    const sharedDeps = deps(model);
    const newer = handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "newer question",
          clientTurnId: "newer-before-regenerate",
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await firstStarted.promise;
    const regenerate = handleRegenerateDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          assistantMessageId: target.id,
        }),
        captureRes().res,
      ),
      sharedDeps,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(modelCalls).toBe(1);

    firstResponse.resolve(normalizedResponse("newer answer"));
    await expect(newer).resolves.toMatchObject({ status: 200 });
    await expect(regenerate).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "NOT_APPLIABLE" } },
    });
    expect(modelCalls).toBe(1);
    expect(store.listMessages(chatId).map((message) => message.content)).toEqual([
      "original question",
      "original answer",
      "newer question",
      "newer answer",
    ]);
  });

  it("rejects a failed canonical retry after a newer turn has completed", async () => {
    const chatId = seedChat();
    const failed = store.admitChatTurn(
      "failed-old-turn",
      {
        chatId,
        role: "user",
        content: "old question",
        timestamp: Date.now(),
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      },
      {
        identityContent: canonicalPlainTurnIdentity(chatId, "old question"),
      },
    );
    expect(failed.kind).toBe("admitted");
    store.failChatTurn(chatId, "failed-old-turn");
    let modelCalls = 0;
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        modelCalls += 1;
        return Promise.resolve(normalizedResponse("new answer"));
      },
    };
    const sharedDeps = deps(model);
    await expect(
      handleSendDesktopChat(
        routeContext(
          makeReq({
            chatId,
            projectPath: projectDir,
            content: "new question",
            clientTurnId: "newer-turn",
          }),
          captureRes().res,
        ),
        sharedDeps,
      ),
    ).resolves.toMatchObject({ status: 200 });

    const retry = await handleSendDesktopChat(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          content: "old question",
          clientTurnId: "failed-old-turn",
        }),
        captureRes().res,
      ),
      sharedDeps,
    );

    expect(retry).toMatchObject({
      status: 409,
      body: { error: { code: "CHAT_TURN_IDEMPOTENCY_CONFLICT" } },
    });
    expect(modelCalls).toBe(1);
    expect(store.listMessages(chatId).map((entry) => entry.content)).toEqual([
      "old question",
      "new question",
      "new answer",
    ]);
  });

  it("includes the current user turn as the LAST prompt message on a fresh chat", async () => {
    const chatId = seedChat();
    const { model, recorded } = streamingModel("answer");
    const res = captureRes();
    await handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "What is the capital of France?",
        }),
        res.res,
      ),
      deps(model),
    );

    // Pre-fix the prompt was built before the user turn was persisted, so the recorded messages
    // were `[system]` only — the LAST role would be "system". The fix makes the user turn last.
    expect(lastRecordedRole(recorded)).toBe("user");
    expect(lastRecordedContent(recorded)).toContain("What is the capital of France?");
  });

  it("pins compaction accounting before admitting the streamed user turn", async () => {
    const chatId = seedChat();
    const { model } = streamingModel("answer");
    const res = captureRes();
    let countAtAccounting = -1;
    const observingStore: UiStore = {
      ...store,
      countMessages: (id) => {
        countAtAccounting = store.countMessages(id);
        return countAtAccounting;
      },
    };

    await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "fresh turn" }),
        res.res,
      ),
      deps(model, { store: observingStore }),
    );

    expect(countAtAccounting).toBe(0);
  });

  it("ends the prompt on the NEW user turn (not the prior assistant turn) for a history chat", async () => {
    const chatId = seedChat();
    seedMessage(chatId, "user", "earlier question");
    seedMessage(chatId, "assistant", "earlier assistant answer");
    const { model, recorded } = streamingModel("answer");
    const res = captureRes();
    await handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "follow-up question",
        }),
        res.res,
      ),
      deps(model),
    );

    const roles = recorded.request?.messages.map((message) => message.role) ?? [];
    // Pre-fix the array ended on the prior "assistant" turn (the new user turn was missing).
    expect(roles.at(-1)).toBe("user");
    expect(lastRecordedContent(recorded)).toContain("follow-up question");
    // The prior assistant content is still present earlier in the conversation.
    const assistantContents = (recorded.request?.messages ?? [])
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
    expect(assistantContents.some((content) => content.includes("earlier assistant answer"))).toBe(
      true,
    );
  });

  it("persists exactly one user + one assistant message on done (no duplicate user)", async () => {
    const chatId = seedChat();
    const before = store.listMessages(chatId).length;
    const { model } = streamingModel("the answer");
    const res = captureRes();
    await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "hello" }),
        res.res,
      ),
      deps(model),
    );

    const after = store.listMessages(chatId);
    // Exactly two new rows — if persistStreamedTurn ALSO created a user message (the duplicate the
    // fix removes), this would be 3. The single "hello" turn must appear exactly once.
    expect(after.length - before).toBe(2);
    expect(after.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(
      after.filter((message) => message.role === "user" && message.content === "hello"),
    ).toHaveLength(1);

    const terminal = parseSse(res.writes).filter((record) => record.event !== "token");
    expect(terminal).toHaveLength(1);
    const done = terminal.find((record) => record.event === "done");
    expect(done).toBeDefined();
    const payload = done?.data as { messages: { role: string }[] };
    expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("replays a completed stream as the same done payload without a second stream", async () => {
    const chatId = seedChat();
    const streaming = streamingModel("the replayable answer");
    const request = {
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "stream exactly once",
      clientTurnId: "stream-turn-1",
    };
    const first = captureRes();
    await handleSendDesktopChatStream(
      routeContext(makeReq(request), first.res),
      deps(streaming.model),
    );
    const replay = captureRes();
    await handleSendDesktopChatStream(
      routeContext(makeReq(request), replay.res),
      deps(streaming.model, {
        config: customModelConfig("retired-model"),
        modelPortFactory: (): never => {
          throw new Error("completed stream replay reached provider resolution");
        },
      }),
    );

    const firstTerminal = parseSse(first.writes).filter((record) => record.event !== "token");
    const replayTerminal = parseSse(replay.writes).filter((record) => record.event !== "token");
    expect(firstTerminal).toHaveLength(1);
    expect(replayTerminal).toHaveLength(1);
    const firstDone = firstTerminal.find((record) => record.event === "done")?.data as {
      messages: readonly { id: string }[];
    };
    const replayDone = replayTerminal.find((record) => record.event === "done")?.data as {
      messages: readonly { id: string }[];
    };
    expect(replayDone.messages.map((message) => message.id)).toEqual(
      firstDone.messages.map((message) => message.id),
    );
    expect(streaming.calls.count).toBe(1);
    expect(store.listMessages(chatId)).toHaveLength(2);
  });

  it("emits an error and does not persist a fake assistant when done content is empty", async () => {
    const chatId = seedChat();
    const { model } = streamingModel("");
    const res = captureRes();

    await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "hello" }),
        res.res,
      ),
      deps(model),
    );

    const records = parseSse(res.writes);
    expect(records.some((record) => record.event === "done")).toBe(false);
    const terminal = records.filter((record) => record.event !== "token");
    expect(terminal).toHaveLength(1);
    const error = terminal.find((record) => record.event === "error");
    expect(error).toBeDefined();
    expect((error?.data as { code?: string }).code).toBe("GATEWAY_PROVIDER_ERROR");
    const persisted = store.listMessages(chatId);
    expect(persisted.map((message) => message.role)).toEqual(["user"]);
    expect(JSON.stringify(persisted)).not.toContain("The model returned an empty response.");
  });

  it("RB-6: an unexpected mid-stream throw emits INTERNAL with body-free diagnostics", async () => {
    // GEN-OBS-DIAGNOSTICS-602 + STATUS-403: before RB-6 an unexpected (non-gateway) mid-stream throw
    // was silently relabelled GATEWAY_ERROR — falsely blaming the provider — and the cause was
    // dropped with no server-side trace. Now: honest INTERNAL code, a correlation id on the frame,
    // and a redacted diagnostic record.
    const chatId = seedChat();
    const records: {
      correlationId: string;
      source: string;
      message: string;
      errorClass: string;
    }[] = [];
    const throwingModel: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("x")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: "partial" };
        await Promise.resolve();
        throw new Error("boom-unexpected-mid-stream");
      },
    };
    const res = captureRes();
    const ctx: RouteContext = {
      ...routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "hello" }),
        res.res,
      ),
      correlationId: "cid-mid-stream-000001",
    };
    await handleSendDesktopChatStream(
      ctx,
      deps(throwingModel, { diagnostics: { record: (r) => records.push(r) } }),
    );

    const error = parseSse(res.writes).find((record) => record.event === "error");
    expect(error).toBeDefined();
    const data = error?.data as { code?: string; message?: string; correlationId?: string };
    expect(data.code).toBe("INTERNAL");
    expect(data.code).not.toBe("GATEWAY_ERROR");
    expect(data.correlationId).toBe("cid-mid-stream-000001");

    // Body-free metadata is captured server-side, keyed by the same id.
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.correlationId).toBe("cid-mid-stream-000001");
    expect(record?.source).toBe("chat.stream");
    expect(record?.message).toBe("server-operation-failed");
    expect(JSON.stringify(record)).not.toContain("boom-unexpected-mid-stream");
  });

  // ADR-0173 D5: the streaming call site (streamAndPersist) must stamp the request's correlation id
  // into GatewayCallRequest.logContext, mirroring the buffered path, so a gateway retry line for a
  // streamed turn joins the same trail as the rest of the request.
  it("threads the request correlation id into the streaming model gateway call's logContext", async () => {
    const chatId = seedChat();
    const streaming = streamingModel("hi");
    const res = captureRes();
    const ctx: RouteContext = {
      ...routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "hello" }),
        res.res,
      ),
      correlationId: "cid-stream-logcontext-000001",
    };

    await handleSendDesktopChatStream(ctx, deps(streaming.model));

    expect(streaming.calls.count).toBe(1);
    expect(streaming.recorded.request?.logContext?.correlationId).toBe(
      "cid-stream-logcontext-000001",
    );
  });

  it("persists the user message but NO assistant message when the stream is cancelled", async () => {
    const chatId = seedChat();
    // captureResWithEvents is required here so the res.on("close") listener registered by
    // abortOnDisconnect actually fires when emitClose() is called. The deprecated req "aborted"
    // path was removed; res "close" is now the canonical abort trigger.
    const captured = captureResWithEvents();
    const req = makeReq({
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "cancel me",
    });
    // The generator yields one delta, fires emitClose() (res "close" → controller.abort), then
    // streamConversation sees signal.aborted at the next loop iteration and returns undefined.
    const { model } = streamingModel("never persisted", () => {
      captured.emitClose();
    });
    await handleSendDesktopChatStream(routeContext(req, captured.res), deps(model));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const events = parseSse(captured.writes).map((record) => record.event);
    expect(events.filter((event) => event === "cancelled")).toHaveLength(1);
    expect(events.filter((event) => event !== "token")).toEqual(["cancelled"]);
    expect(events).not.toContain("done");

    const persisted = store.listMessages(chatId);
    expect(persisted.map((message) => message.role)).toEqual(["user"]);
    expect(persisted.some((message) => message.role === "assistant")).toBe(false);
  });

  it("closes a successful provider iterator exactly once after its done chunk", async () => {
    const chatId = seedChat();
    const release = vi.fn(() =>
      Promise.resolve({ done: true, value: undefined } as IteratorResult<GatewayStreamChunk>),
    );
    const iterator: AsyncIterator<GatewayStreamChunk> = {
      next: () =>
        Promise.resolve({
          done: false,
          value: { type: "done", response: normalizedResponse("iterator answer") },
        }),
      return: release,
    };
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("buffered")),
      callStream: () => ({ [Symbol.asyncIterator]: () => iterator }),
    };
    const captured = captureRes();

    await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, content: "close normal iterator" }),
        captured.res,
      ),
      deps(model),
    );

    expect(release).toHaveBeenCalledOnce();
    expect(parseSse(captured.writes).filter((record) => record.event !== "token")).toEqual([
      expect.objectContaining({ event: "done" }),
    ]);
  });

  it("keeps the chat lock until a provider iterator that ignored cancellation settles", async () => {
    vi.useFakeTimers();
    try {
      const chatId = seedChat();
      const nextStarted = deferred<undefined>();
      const pendingNext = deferred<IteratorResult<GatewayStreamChunk>>();
      const release = vi.fn(() =>
        Promise.resolve({ done: true, value: undefined } as IteratorResult<GatewayStreamChunk>),
      );
      const iterator: AsyncIterator<GatewayStreamChunk> = {
        next: () => {
          nextStarted.resolve(undefined);
          return pendingNext.promise;
        },
        return: release,
      };
      const model: ModelPort = {
        call: () => Promise.resolve(normalizedResponse("successor answer")),
        callStream: () => ({ [Symbol.asyncIterator]: () => iterator }),
      };
      const sharedDeps = deps(model);
      const captured = captureResWithEvents();
      const first = handleSendDesktopChatStream(
        routeContext(
          makeReq({ chatId, projectPath: projectDir, content: "stuck stream" }),
          captured.res,
        ),
        sharedDeps,
      );
      await nextStarted.promise;
      const successor = handleSendDesktopChat(
        routeContext(
          makeReq({ chatId, projectPath: projectDir, content: "successor turn" }),
          captureRes().res,
        ),
        sharedDeps,
      );

      captured.emitClose();

      await expect(first).resolves.toBe(STREAMING);
      let successorSettled = false;
      void successor.then(() => {
        successorSettled = true;
      });
      await Promise.resolve();
      expect(successorSettled).toBe(false);
      expect(store.listMessages(chatId).map((message) => message.content)).toEqual([
        "stuck stream",
      ]);

      pendingNext.resolve({ done: true, value: undefined });
      await expect(successor).resolves.toMatchObject({ status: 200 });
      expect(release).toHaveBeenCalledOnce();
      expect(captured.status).toBe(200);
      const terminal = parseSse(captured.writes).filter((record) => record.event !== "token");
      expect(terminal).toEqual([expect.objectContaining({ event: "cancelled" })]);
      const writesAfterSettlement = captured.writes.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(captured.writes).toHaveLength(writesAfterSettlement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys the socket and aborts the controller when res.write() returns false (backpressure)", async () => {
    // RED reason: before this fix the token write called ctx.res.write() directly and discarded the
    // return value, so a slow client's backpressure signal was silently ignored.
    // GREEN reason: writeOrDestroy checks the return value and calls controller.abort() + res.destroy().
    const chatId = seedChat();
    const captured = captureResWithEvents();
    // Signal backpressure on the first write so the very first token triggers abort+destroy.
    captured.writeReturns = false;
    const req = makeReq({
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "hello slow client",
    });
    const { model } = streamingModel("answer");
    await handleSendDesktopChatStream(routeContext(req, captured.res), deps(model));

    // The socket must have been destroyed.
    expect(captured.destroyed).toBe(true);
    // After backpressure the controller was aborted, so no "done" event is written.
    const events = parseSse(captured.writes).map((record) => record.event);
    expect(events).not.toContain("done");
  });

  it("does NOT relabel a backpressure kill as a user 'cancelled' event (GEN-PERF-CHAT-006)", async () => {
    // RED reason: pre-fix, a backpressure kill left turn === undefined and the handler unconditionally
    // wrote sseMessage('cancelled') to the already-destroyed socket, so a slow-client termination was
    // indistinguishable downstream from an intentional user cancel.
    // GREEN reason: streamConversation flags termination.backpressure via the writeOrDestroy signal;
    // the caller then skips the 'cancelled' terminal frame, keeping the two terminations distinct.
    const chatId = seedChat();
    const captured = captureResWithEvents();
    captured.writeReturns = false; // backpressure on the first token write
    const req = makeReq({
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "hello slow client",
    });
    const { model } = streamingModel("answer");
    await handleSendDesktopChatStream(routeContext(req, captured.res), deps(model));

    const events = parseSse(captured.writes).map((record) => record.event);
    expect(captured.destroyed).toBe(true);
    // The distinguishing assertion: a backpressure kill is NOT surfaced as a user cancel.
    expect(events).not.toContain("cancelled");
    expect(events).not.toContain("done");
  });

  it("injects retrieved memory text into the streamed prompt's latest user turn", async () => {
    const memoryDir = join(tmp, "memory-vault");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    insertAcceptedMemory(memoryVault, "Use pnpm instead of npm for installs.");

    const chatId = seedChat();
    const { model, recorded } = streamingModel("answer");
    const res = captureRes();
    await handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "Which package manager should I use?",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        res.res,
      ),
      deps(model, { memoryVault }),
    );

    expect(lastRecordedRole(recorded)).toBe("user");
    expect(lastRecordedContent(recorded)).toContain("Included memory context:");
    expect(lastRecordedContent(recorded)).toContain("Use pnpm instead of npm");
    memoryVault.close();
  });

  it("persists the canonical user before a fallible streamed-memory retrieval", async () => {
    const memoryDir = join(tmp, "failing-memory-vault");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const failingMemoryVault = new Proxy(memoryVault, {
      get(target, property, receiver): unknown {
        if (property === "listMemoriesByScope") {
          return (): never => {
            throw new Error("memory retrieval failed");
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const chatId = seedChat();
    const { model, recorded } = streamingModel("must not answer");
    const res = captureRes();

    await handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "Keep this final transcript",
          memory: { enabled: true, budgetTokens: 900, context: {} },
        }),
        res.res,
      ),
      deps(model, { memoryVault: failingMemoryVault }),
    );

    expect(recorded.request).toBeUndefined();
    expect(store.listMessages(chatId)).toMatchObject([
      { role: "user", content: "Keep this final transcript" },
    ]);
    expect(parseSse(res.writes).map((record) => record.event)).toContain("error");
    memoryVault.close();
  });

  // Issue #502 — the streaming send path threads a selected discussion mode onto the latest user turn,
  // exactly like the non-streaming path. Asserting the turn STARTS WITH the rendered block (not merely
  // contains it) catches template rewording, truncation, or block misplacement.
  it("prepends the discussion directive block onto the streamed prompt's latest user turn", async () => {
    const chatId = seedChat();
    const { model, recorded } = streamingModel("answer");
    const res = captureRes();
    await handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "Should we ship this?",
          discussionMode: "challenge",
        }),
        res.res,
      ),
      deps(model),
    );

    expect(lastRecordedRole(recorded)).toBe("user");
    const content = lastRecordedContent(recorded);
    expect(content.startsWith(composeDiscussionDirectiveBlock("challenge"))).toBe(true);
    // The user draft still follows the additive block.
    expect(content).toContain("Should we ship this?");
  });

  it("leaves the streamed prompt unchanged when no discussion mode is selected (backward-compatible)", async () => {
    const chatId = seedChat();
    const { model, recorded } = streamingModel("answer");
    const res = captureRes();
    await handleSendDesktopChatStream(
      routeContext(
        makeReq({
          chatId,
          projectPath: projectDir,
          modelId: CHAT_MODEL,
          content: "Should we ship this?",
        }),
        res.res,
      ),
      deps(model),
    );

    const content = lastRecordedContent(recorded);
    expect(content).not.toContain("Discussion mode directives:");
    // With no mode, docs, or memory the latest turn is the bare draft.
    expect(content).toBe("Should we ship this?");
  });
});

// GEN-PERF-CHATSTREAM-001 — the chat SSE route was the only stream type without a
// concurrency bulkhead (agent runs cap at 16, QI at 2, voice at 64). Above the cap the
// route must reject with a JSON 429 BEFORE any SSE header (so the client degrades to the
// buffered path) and must free the slot when a stream settles.
describe("concurrent chat stream bulkhead", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetActiveChatStreamsForTests();
  });

  it("releases its active slot when a partial request body disconnects", async () => {
    vi.stubEnv(MAX_ACTIVE_CHAT_STREAMS_ENV, "1");
    const chatId = seedChat();
    const { model, calls } = streamingModel("accepted after disconnect");
    const sharedDeps = deps(model);
    const partialReq = new PassThrough() as unknown as IncomingMessage;
    const disconnected = captureResWithEvents();
    const first = handleSendDesktopChatStream(
      routeContext(partialReq, disconnected.res),
      sharedDeps,
    );
    (partialReq as unknown as PassThrough).write(Buffer.from(`{"chatId":"${chatId}",`));

    disconnected.emitClose();

    await expect(first).resolves.toMatchObject({ status: 499 });
    expect(disconnected.status).toBeUndefined();
    const accepted = captureRes();
    await expect(
      handleSendDesktopChatStream(
        routeContext(
          makeReq({
            chatId,
            projectPath: projectDir,
            modelId: CHAT_MODEL,
            content: "slot must be reusable",
          }),
          accepted.res,
        ),
        sharedDeps,
      ),
    ).resolves.toBe(STREAMING);
    expect(calls.count).toBe(1);
    expect(parseSse(accepted.writes).some((record) => record.event === "done")).toBe(true);
    (partialReq as unknown as PassThrough).destroy();
  });

  it("rejects streams above the cap with 429 and frees the slot after settle", async () => {
    vi.stubEnv(MAX_ACTIVE_CHAT_STREAMS_ENV, "1");
    const chatId = seedChat();
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const model: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("buffered")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: "hi" };
        await gate;
        yield { type: "done", response: normalizedResponse("done") };
      },
    };
    const d = deps(model);
    const first = captureRes();
    const firstOutcome = handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "one" }),
        first.res,
      ),
      d,
    );
    // Wait until the first stream actually holds the slot (its first token frame is out).
    await vi.waitFor(() => {
      expect(first.writes.join("")).toContain("event: token");
    });
    const second = captureRes();
    const rejected = await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "two" }),
        second.res,
      ),
      d,
    );
    expect(rejected).toMatchObject({
      status: 429,
      body: { error: { code: "TOO_MANY_STREAMS" } },
    });
    // The rejection happened before any SSE header/frame reached the second response.
    expect(second.status).toBeUndefined();
    expect(second.writes).toHaveLength(0);
    releaseFirst();
    await expect(firstOutcome).resolves.toBe(STREAMING);
    const third = captureRes();
    const accepted = await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "three" }),
        third.res,
      ),
      d,
    );
    expect(accepted).toBe(STREAMING);
    expect(parseSse(third.writes).some((record) => record.event === "done")).toBe(true);
  });

  it("keeps the slot accounting correct when the stream handler throws", async () => {
    vi.stubEnv(MAX_ACTIVE_CHAT_STREAMS_ENV, "1");
    const chatId = seedChat();
    const failing: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      // The stream failing before its first chunk IS the scenario under test.
      // eslint-disable-next-line require-yield -- fails before any chunk by design
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        throw new Error("upstream exploded");
      },
    };
    const first = captureRes();
    const outcome = await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "boom" }),
        first.res,
      ),
      deps(failing),
    );
    expect(outcome).toBe(STREAMING);
    // The slot must be released by the finally even though the stream errored.
    const { model } = streamingModel("recovered");
    const second = captureRes();
    const accepted = await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "again" }),
        second.res,
      ),
      deps(model),
    );
    expect(accepted).toBe(STREAMING);
    expect(parseSse(second.writes).some((record) => record.event === "done")).toBe(true);
  });
});

// Finding 0 (#2902 audit): the request-scoped correlationId never reached the terminal
// `sse.stream.closed` line on the desktop chat stream. The heartbeat's own write is deferred to
// its interval timer, so in practice the first model token — written via streamConversation's
// writeOrDestroy call — is the write that actually attaches it first.
describe("desktop chat SSE stream correlationId threading (#2902 audit finding 0)", () => {
  afterEach(() => {
    resetServerLogger();
  });

  it("attaches the supplied correlationId to the sse.stream.closed terminal line", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const chatId = seedChat();
    const captured = captureResWithEvents();
    const { model } = streamingModel("answer");
    const ctx: RouteContext = {
      ...routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "hello" }),
        captured.res,
      ),
      correlationId: "corr-chat-stream-1",
    };

    await handleSendDesktopChatStream(ctx, deps(model));
    captured.emitClose();

    const closed = sink.events.filter((event) => event.op === "sse.stream.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.correlationId).toBe("corr-chat-stream-1");
  });

  it("omits correlationId from the terminal line when none is supplied (unchanged behavior)", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const chatId = seedChat();
    const captured = captureResWithEvents();
    const { model } = streamingModel("answer");

    await handleSendDesktopChatStream(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "hello" }),
        captured.res,
      ),
      deps(model),
    );
    captured.emitClose();

    const closed = sink.events.filter((event) => event.op === "sse.stream.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.correlationId).toBeUndefined();
  });

  it("attaches the correlationId to sse.stream.closed even when the model throws before the first chunk", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const chatId = seedChat();
    const captured = captureResWithEvents();
    const failing: ModelPort = {
      call: () => Promise.resolve(normalizedResponse("unused")),
      // eslint-disable-next-line require-yield -- fails before any chunk by design
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        throw new Error("upstream exploded before first token");
      },
    };
    const ctx: RouteContext = {
      ...routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "hello" }),
        captured.res,
      ),
      correlationId: "corr-chat-stream-early-failure",
    };

    await handleSendDesktopChatStream(ctx, deps(failing));
    captured.emitClose();

    const closed = sink.events.filter((event) => event.op === "sse.stream.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.correlationId).toBe("corr-chat-stream-early-failure");
  });
});
