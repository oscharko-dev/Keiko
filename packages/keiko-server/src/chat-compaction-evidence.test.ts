// ADR-0057 D3 (integration): the chat send paths persist the discarded ContextCompactionRecord as
// regulated evidence. Drives the REAL buffered (handleSendDesktopChat) and streaming
// (handleSendDesktopChatStream) handlers against an in-memory UI store + a real in-memory evidence
// store. Gates:
//   - budget-triggered slow path WITH an active profile persists a redacted, valid manifest under
//     an assertValidRunId-valid runId; chatId is hashed, never raw;
//   - budget-safe fast path persists NOTHING;
//   - a throwing evidence store does NOT fail the send (best-effort try/catch);
//   - the runId is identical across the buffered and streaming paths for the same turn (no
//     off-by-one).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertValidRunId,
  createInMemoryEvidenceStore,
  listEvidence,
  loadEvidence,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import {
  DEFAULT_CONTEXT_PROFILE,
  validateContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { handleSendDesktopChat } from "./chat-handlers.js";
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

const CHAT_MODEL = "example-chat-model";
const SECRET = "test-config-secret-value-1234567890";

let tmp: string;
let projectDir: string;
let store: UiStore;

function makeReq(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  return req as unknown as IncomingMessage;
}

function captureRes(): { res: ServerResponse; writes: string[] } {
  const writes: string[] = [];
  const res = {
    writeHead(): ServerResponse {
      return res as unknown as ServerResponse;
    },
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    end(): ServerResponse {
      return res as unknown as ServerResponse;
    },
    on(): ServerResponse {
      return res as unknown as ServerResponse;
    },
  };
  return { res: res as unknown as ServerResponse, writes };
}

function routeContext(req: IncomingMessage, res: ServerResponse): RouteContext {
  return { req, res, params: {}, url: new URL("http://127.0.0.1/api/desktop/chat") };
}

function normalizedResponse(content: string): NormalizedResponse {
  return {
    modelId: CHAT_MODEL,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "compaction-evidence-test",
      promptTokens: 7,
      completionTokens: 3,
      latencyMs: 11,
      costClass: "high",
    },
  };
}

function bufferedModel(content: string): ModelPort {
  return {
    call(): Promise<NormalizedResponse> {
      return Promise.resolve(normalizedResponse(content));
    },
  };
}

function streamingModel(content: string): ModelPort {
  return {
    call(): Promise<NormalizedResponse> {
      return Promise.resolve(normalizedResponse(content));
    },
    async *callStream(_request: GatewayRequest): AsyncGenerator<GatewayStreamChunk> {
      yield { type: "delta", token: "hi" };
      await Promise.resolve();
      yield { type: "done", response: normalizedResponse(content) };
    },
  };
}

function customModelConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: CHAT_MODEL,
        baseUrl: "https://provider.example/v1",
        apiKey: SECRET,
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
        throughputHint: "local endpoint",
        preferredUseCases: ["Local coding workflow"],
        knownLimitations: [],
      },
    ],
  };
}

function deps(model: ModelPort, evidenceStore: EvidenceStore, withProfile: boolean): UiHandlerDeps {
  return {
    config: customModelConfig(),
    configPresent: true,
    evidenceStore,
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => model,
    store,
    ...(withProfile ? { contextProfile: DEFAULT_CONTEXT_PROFILE } : {}),
  };
}

function seedChat(): string {
  return store.createChat(projectDir, "Untitled chat", CHAT_MODEL).id;
}

// Seeds `count` alternating user/assistant turns. The first dropped user turn carries the config
// secret so the redaction gate has something concrete to scrub.
function seedHistory(chatId: string, count: number): void {
  const seedBaseTimestamp = 1_700_000_000_000;
  for (let i = 0; i < count; i += 1) {
    store.createMessage({
      chatId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i === 0 ? `leak ${SECRET} in turn 0` : `turn ${String(i)} content`,
      timestamp: seedBaseTimestamp + i,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
  }
}

function seedOversizedHistory(chatId: string): number {
  const seedBaseTimestamp = 1_700_000_000_000;
  const huge = "x".repeat(150_000);
  const count = 3;
  for (let i = 0; i < count; i += 1) {
    store.createMessage({
      chatId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i === 0 ? `leak ${SECRET} in turn 0 ${huge}` : `turn ${String(i)} content ${huge}`,
      timestamp: seedBaseTimestamp + i,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
  }
  return count;
}

async function sendBuffered(d: UiHandlerDeps, chatId: string): Promise<void> {
  const res = captureRes();
  await handleSendDesktopChat(
    routeContext(
      makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "new question" }),
      res.res,
    ),
    d,
  );
}

async function sendStreaming(d: UiHandlerDeps, chatId: string): Promise<void> {
  const res = captureRes();
  await handleSendDesktopChatStream(
    routeContext(
      makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "new question" }),
      res.res,
    ),
    d,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-compaction-"));
  projectDir = join(tmp, "repo");
  mkdirSync(projectDir);
  store = createInMemoryUiStore();
  store.createProject(projectDir, "repo");
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("chat compaction evidence wiring (ADR-0057 D3)", () => {
  it("buffered slow path persists a valid, redacted compaction manifest with a hashed chatId", async () => {
    const chatId = seedChat();
    const count = seedOversizedHistory(chatId);
    const evidenceStore = createInMemoryEvidenceStore();
    await sendBuffered(deps(bufferedModel("answer"), evidenceStore, true), chatId);

    const entries = listEvidence(evidenceStore);
    expect(entries.length).toBe(1);
    const runId = entries[0]?.runId ?? "";
    expect(() => {
      assertValidRunId(runId);
    }).not.toThrow();
    // runId = chat-<sha256(chatId)[:16]>-t<countBeforeUserMessage>; the user message was stored
    // AFTER the count was pinned, so the count is the seeded oversized-history length.
    expect(runId).toBe(`chat-${sha256Hex(chatId).slice(0, 16)}-t${String(count)}`);

    // loadEvidence parses + structurally validates the manifest; returning without throwing is the
    // schema gate. The compaction record itself is validated explicitly.
    const manifest = loadEvidence(evidenceStore, runId);
    if (manifest === undefined) throw new Error("expected manifest");
    expect(manifest.run.runId).toBe(runId);
    expect(manifest.run.fingerprint.length).toBeGreaterThan(0);
    const record = manifest.compaction?.[0];
    if (record === undefined) throw new Error("expected compaction record");
    expect(validateContextCompactionRecord(record).ok).toBe(true);
    // Path/secret redaction + raw-chatId confidentiality: the manifest carries only the hashed
    // chatId (folded into run.fingerprint), never the raw id or the gateway secret.
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(chatId);
  });

  it("streaming slow path persists the SAME runId as the buffered path (no off-by-one)", async () => {
    const chatId = seedChat();
    const count = seedOversizedHistory(chatId);
    const evidenceStore = createInMemoryEvidenceStore();
    await sendStreaming(deps(streamingModel("answer"), evidenceStore, true), chatId);

    const entries = listEvidence(evidenceStore);
    expect(entries.length).toBe(1);
    expect(entries[0]?.runId).toBe(`chat-${sha256Hex(chatId).slice(0, 16)}-t${String(count)}`);
  });

  it("budget-safe fast path persists NOTHING", async () => {
    const chatId = seedChat();
    seedHistory(chatId, 10);
    const evidenceStore = createInMemoryEvidenceStore();
    await sendBuffered(deps(bufferedModel("answer"), evidenceStore, true), chatId);
    expect(listEvidence(evidenceStore).length).toBe(0);
  });

  it("no profile persists NOTHING even on a long history", async () => {
    const chatId = seedChat();
    seedHistory(chatId, 30);
    const evidenceStore = createInMemoryEvidenceStore();
    await sendBuffered(deps(bufferedModel("answer"), evidenceStore, false), chatId);
    expect(listEvidence(evidenceStore).length).toBe(0);
  });

  it("a throwing evidence store does NOT fail the send (best-effort)", async () => {
    const chatId = seedChat();
    seedHistory(chatId, 30);
    const throwingStore: EvidenceStore = {
      put: () => {
        throw new Error("disk full");
      },
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    };
    const res = captureRes();
    const result = await handleSendDesktopChat(
      routeContext(
        makeReq({ chatId, projectPath: projectDir, modelId: CHAT_MODEL, content: "new question" }),
        res.res,
      ),
      deps(bufferedModel("answer"), throwingStore, true),
    );
    expect(result.status).toBe(200);
    expect(
      store
        .listMessages(chatId)
        .map((m) => m.role)
        .slice(-2),
    ).toEqual(["user", "assistant"]);
  });
});
