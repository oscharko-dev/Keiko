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
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSendDesktopChatStream } from "./chat-stream-handlers.js";
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

  it("persists the user message but NO assistant message when the stream is cancelled", async () => {
    const chatId = seedChat();
    const res = captureRes();
    // Build the request first so we can abort it from the model's onFirstDelta callback. The
    // generator yields one delta, fires the abort (emitting req "aborted" → controller.abort), then
    // streamConversation sees signal.aborted at the next loop iteration and returns undefined.
    const req = makeReq({
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content: "cancel me",
    });
    const { model } = streamingModel("never persisted", () => {
      req.emit("aborted");
    });
    await handleSendDesktopChatStream(routeContext(req, res.res), deps(model));

    const events = parseSse(res.writes).map((record) => record.event);
    expect(events).toContain("cancelled");
    expect(events).not.toContain("done");

    const persisted = store.listMessages(chatId);
    expect(persisted.map((message) => message.role)).toEqual(["user"]);
    expect(persisted.some((message) => message.role === "assistant")).toBe(false);
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
});
