// Behavioural tests for the desktop chat SSE streaming handler (#152). The regression these guard:
// the streamed prompt previously built the gateway messages BEFORE persisting the current user turn,
// so buildGatewayMessages (which reads store.listMessages) omitted it — a fresh chat sent `[system]`
// only (the model hallucinated) and a history chat ended on an `assistant` turn (some providers
// reject it 400). The fix mirrors the buffered persistModelChatTurn ordering: persist the user turn
// BEFORE building the prompt. These tests are mutation-robust — each fails on the pre-fix code.
//
// The handler is driven directly (not over HTTP) so the cancel path is deterministic with no timers:
// `req` is a node Readable carrying the JSON body (satisfying readBody's data/end events) that also
// emits "aborted"; `res` captures writeHead/write/end. The fake ModelPort records the prompt it was
// streamed and yields a `delta` then a `done` chunk.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSendDesktopChatStream } from "./chat-stream-handlers.js";
import { composeDiscussionDirectiveBlock } from "./discussion-prompt.js";
import type { RouteContext } from "./routes.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";

const CHAT_MODEL = "example-chat-model";

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

function normalizedResponse(content: string): NormalizedResponse {
  return {
    modelId: CHAT_MODEL,
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

interface StreamingModel {
  readonly model: ModelPort;
  readonly recorded: { request: GatewayRequest | undefined };
}

// A streaming ModelPort that records the prompt it is asked to stream, then yields one delta and one
// terminal done chunk. `onFirstDelta` (used by the cancel test) runs after the first delta is yielded
// so the test can abort the controller deterministically before the done chunk arrives.
function streamingModel(content: string, onFirstDelta?: () => void): StreamingModel {
  const recorded: { request: GatewayRequest | undefined } = { request: undefined };
  const model: ModelPort = {
    call(): Promise<NormalizedResponse> {
      return Promise.resolve(normalizedResponse(content));
    },
    async *callStream(request: GatewayRequest): AsyncGenerator<GatewayStreamChunk> {
      recorded.request = request;
      yield { type: "delta", token: "hi" };
      if (onFirstDelta !== undefined) onFirstDelta();
      // Yield to the microtask queue so a synchronous abort fired in onFirstDelta is observed by
      // streamConversation's signal.aborted check before this terminal chunk is consumed.
      await Promise.resolve();
      yield { type: "done", response: normalizedResponse(content) };
    },
  };
  return { model, recorded };
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
  tmp = mkdtempSync(join(tmpdir(), "keiko-stream-"));
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

    const done = parseSse(res.writes).find((record) => record.event === "done");
    expect(done).toBeDefined();
    const payload = done?.data as { messages: { role: string }[] };
    expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
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
    const error = records.find((record) => record.event === "error");
    expect(error).toBeDefined();
    expect((error?.data as { code?: string }).code).toBe("GATEWAY_PROVIDER_ERROR");
    const persisted = store.listMessages(chatId);
    expect(persisted.map((message) => message.role)).toEqual(["user"]);
    expect(JSON.stringify(persisted)).not.toContain("The model returned an empty response.");
  });

  it("RB-6: an UNEXPECTED mid-stream throw surfaces INTERNAL (not GATEWAY_ERROR) with a correlation id and a logged cause", async () => {
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

    // The cause is captured server-side, keyed by the same id — no longer an untraceable black box.
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.correlationId).toBe("cid-mid-stream-000001");
    expect(record?.source).toBe("chat.stream");
    expect(record?.message).toContain("boom-unexpected-mid-stream");
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

    const events = parseSse(captured.writes).map((record) => record.event);
    expect(events).toContain("cancelled");
    expect(events).not.toContain("done");

    const persisted = store.listMessages(chatId);
    expect(persisted.map((message) => message.role)).toEqual(["user"]);
    expect(persisted.some((message) => message.role === "assistant")).toBe(false);
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
