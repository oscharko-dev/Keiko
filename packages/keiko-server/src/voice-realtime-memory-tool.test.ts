// Realtime memory recall tool route tests. The route must remain a thin bridge into the shared
// realtime retrieval core (recallRealtimeMemoryBlock): it validates the voice/tool gate, performs
// one recall with the provider-supplied cue, reinforces recalled memories exactly once per session
// window, and answers with a content-safe spoken instruction — persisting nothing to the chat.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { MemoryId, MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { createRunRegistry } from "./runs.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore, type Chat, type UiStore } from "./store/index.js";
import { handleRealtimeMemoryVoiceTool } from "./voice-realtime-memory-tool.js";

const CHAT_MODEL = "chat-model";
const VOICE_MODEL = "keiko-realtime";

let tmp: string;
let projectPath: string;
let store: UiStore;
let vault: MemoryVaultStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-voice-memory-tool-"));
  projectPath = join(tmp, "repo");
  mkdirSync(projectPath);
  const memoryDir = join(tmp, "vault");
  mkdirSync(memoryDir);
  store = createInMemoryUiStore();
  vault = createMemoryVault({ memoryDir, redactString: (value) => value });
});

afterEach(() => {
  vault.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function realtimeConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: VOICE_MODEL,
        baseUrl: "https://realtime.example.invalid/v1",
        apiKey: "voice-test-token-1234567890",
        timeoutMs: 1_000,
        maxRetries: 0,
        retryBaseDelayMs: 10,
        realtimeAuthMode: "ephemeral-session",
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: VOICE_MODEL,
        kind: "voice",
        contextWindow: 0,
        maxOutputTokens: 0,
        toolCalling: true,
        structuredOutput: false,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        supportsSpeechInput: true,
        supportsRealtimeVoice: true,
        supportedVoicePersonas: ["neutral"],
        voiceProviderLocality: "azure-foundry",
        workflowEligible: false,
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "Realtime voice test provider",
        preferredUseCases: ["Realtime voice"],
        knownLimitations: [],
      },
    ],
  };
}

function chatOnlyConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: CHAT_MODEL,
        baseUrl: "https://chat.example.invalid/v1",
        apiKey: "chat-test-token-1234567890",
        timeoutMs: 1_000,
        maxRetries: 0,
        retryBaseDelayMs: 10,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function deps(options: { config?: GatewayConfig; includeVault?: boolean } = {}): UiHandlerDeps {
  return {
    config: options.config ?? realtimeConfig(),
    configPresent: true,
    evidenceStore: createInMemoryEvidenceStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    ...(options.includeVault === false ? {} : { memoryVault: vault }),
  };
}

function fakeReq(body: unknown): IncomingMessage {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage;
}

function fakeRes(): RouteContext["res"] {
  const res = new EventEmitter() as RouteContext["res"] & { writableEnded: boolean };
  res.writableEnded = false;
  return res;
}

function ctx(body: unknown): RouteContext {
  return {
    req: fakeReq(body),
    res: fakeRes(),
    params: {},
    url: new URL("http://localhost/api/voice/realtime/memory-tool"),
  };
}

function createChat(): Chat {
  store.createProject(projectPath, "Realtime memory tool");
  return store.createChat(projectPath, "Voice chat", CHAT_MODEL);
}

function projectScope(): MemoryScope {
  return { kind: "project", projectId: projectPath } as unknown as MemoryScope;
}

function insertMemory(id: string, body: string): MemoryRecord {
  const now = Date.now();
  return vault.insertMemory({
    id: id as MemoryId,
    schemaVersion: "1",
    scope: projectScope(),
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

interface ToolBody {
  readonly status: string;
  readonly memoryCount: number;
  readonly memoryContext: string;
  readonly instruction: string;
}

function requestBody(chat: Chat, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: chat.id,
    projectPath,
    callId: "call-1",
    query: "What is the launch codename?",
    ...overrides,
  };
}

describe("handleRealtimeMemoryVoiceTool", () => {
  it("rejects when realtime voice is not available for the deployment", async () => {
    const chat = createChat();
    const result = await handleRealtimeMemoryVoiceTool(
      ctx(requestBody(chat)),
      deps({ config: chatOnlyConfig() }),
    );
    expect(result.status).toBe(403);
  });

  it("rejects a missing query with 400", async () => {
    const chat = createChat();
    const result = await handleRealtimeMemoryVoiceTool(
      ctx(requestBody(chat, { query: "" })),
      deps(),
    );
    expect(result.status).toBe(400);
  });

  it("rejects an unknown chat with 404", async () => {
    createChat();
    const result = await handleRealtimeMemoryVoiceTool(
      ctx({ chatId: "missing", projectPath, callId: "call-1", query: "anything" }),
      deps(),
    );
    expect(result.status).toBe(404);
  });

  it("answers 409 when MemoriaViva is not wired for the deployment", async () => {
    const chat = createChat();
    const result = await handleRealtimeMemoryVoiceTool(
      ctx(requestBody(chat)),
      deps({ includeVault: false }),
    );
    expect(result.status).toBe(409);
  });

  it("recalls with the live cue, reinforces once, and instructs a faithful spoken use", async () => {
    const chat = createChat();
    const memory = insertMemory("tool-mem-codename", "The launch codename is Wolkenanker.");
    const handlerDeps = deps();

    const first = await handleRealtimeMemoryVoiceTool(ctx(requestBody(chat)), handlerDeps);
    expect(first.status).toBe(200);
    const body = first.body as ToolBody;
    expect(body.status).toBe("ok");
    expect(body.memoryCount).toBeGreaterThan(0);
    expect(body.memoryContext).toContain("Wolkenanker");
    expect(body.instruction).toContain("untrusted");
    expect(vault.getAccessStats([memory.id]).get(memory.id)?.accessCount).toBe(1);

    // A repeated recall of the same memory inside the session window keeps delivering context but
    // reinforces only once (massed repetition damping — shared with the session priming path).
    const second = await handleRealtimeMemoryVoiceTool(
      ctx(requestBody(chat, { callId: "call-2" })),
      handlerDeps,
    );
    expect(second.status).toBe(200);
    expect((second.body as ToolBody).memoryContext).toContain("Wolkenanker");
    expect(vault.getAccessStats([memory.id]).get(memory.id)?.accessCount).toBe(1);
  });

  it("tells the assistant to admit a blank when nothing is recalled", async () => {
    const chat = createChat();
    const result = await handleRealtimeMemoryVoiceTool(ctx(requestBody(chat)), deps());
    expect(result.status).toBe(200);
    const body = result.body as ToolBody;
    expect(body.memoryCount).toBe(0);
    expect(body.memoryContext).toBe("");
    expect(body.instruction).toContain("do not remember");
    expect(body.instruction).toContain("Do not invent a memory");
  });
});
