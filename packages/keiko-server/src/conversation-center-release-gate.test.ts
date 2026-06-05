// Issue #155 (Epic #142 — final child) — Conversation Center release gate.
//
// This test is the GATE on the Conversation Center end-to-end contract. Each `it` block pins one
// of the user-visible release acceptance criteria from epic #142 so that a regression in any
// downstream PR fails CI at this file. The file is intentionally narrow:
//   - It exercises the live desktop chat HTTP path with an in-memory UiStore and an injected
//     ModelPort spy. No real provider call ever happens.
//   - It does not duplicate unit-level coverage that already exists in sibling test files
//     (`conversation-validation.test.ts`, `conversation-audit.test.ts`,
//     `desktop-chat-handlers.test.ts`, etc.). It pins the integrated wire behaviour: the right
//     status code, the right typed error code, the right persisted state, and the right spy
//     observation.
//
// AC coverage mapping (epic #142 / issue #155):
//   AC1 — Text conversation works              → "text happy path"
//   AC2 — Unsupported sends blocked            → "image rejected", "document rejected",
//                                                 "embedding model rejected", "oversized context"
//   AC3 — Model switch persisted               → "model switch persists across reload"
//   AC4 — Long-running progress/recovery       → (UI Streaming.test.tsx — referenced by matrix)
//   AC5 — Repo-aware grounded answers          → (grounded-qa.test.ts — referenced by matrix)
//   AC6 — Indexed document knowledge           → (grounded-qa.test.ts — referenced by matrix)
//   AC7 — Memory-aware questions               → (memory-conv-handlers.test.ts — by matrix)
//   AC8 — Evidence safe for release PRs        → "error message redaction"

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUiServer, UI_HOST } from "./server.js";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  GatewayConfig,
  GatewayRequest,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";

const POST_JSON_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const PATCH_JSON_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const CHAT_MODEL = "release-gate-chat-model";
const ALT_CHAT_MODEL = "release-gate-alt-chat-model";

let server: Server;
let port: number;
let staticRoot: string;
let tmp: string;
let projectDir: string;
let store: UiStore;
let seenRequests: GatewayRequest[];

function fakeModel(content: string): ModelPort {
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
          requestId: "release-gate-test",
          promptTokens: 5,
          completionTokens: 2,
          latencyMs: 9,
          costClass: "high",
        },
      });
    },
  };
}

function chatCapability(id: string): ModelCapability {
  return {
    id,
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
  };
}

function twoModelConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: CHAT_MODEL,
        baseUrl: "https://provider.example/v1",
        apiKey: "release-gate-secret-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
      {
        modelId: ALT_CHAT_MODEL,
        baseUrl: "https://provider.example/v1",
        apiKey: "release-gate-secret-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [chatCapability(CHAT_MODEL), chatCapability(ALT_CHAT_MODEL)],
  };
}

function embeddingOnlyConfig(): GatewayConfig {
  const embedId = "release-gate-embed";
  return {
    providers: [
      {
        modelId: embedId,
        baseUrl: "https://provider.example/v1",
        apiKey: "release-gate-secret-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: embedId,
        kind: "embedding",
        contextWindow: 8_192,
        maxOutputTokens: 0,
        toolCalling: false,
        structuredOutput: false,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "local endpoint",
        preferredUseCases: [],
        knownLimitations: [],
      },
    ],
  };
}

function deps(
  model: ModelPort = fakeModel("release-gate response"),
  overrides: Partial<UiHandlerDeps> = {},
): UiHandlerDeps {
  return {
    config: twoModelConfig(),
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

function base(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

async function restartWithDeps(handlerDeps: UiHandlerDeps): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps,
  });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
}

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-release-gate-static-"));
  tmp = mkdtempSync(join(tmpdir(), "keiko-release-gate-"));
  projectDir = join(tmp, "repo");
  mkdirSync(projectDir);
  store = createInMemoryUiStore();
  store.createProject(projectDir, "repo");
  seenRequests = [];
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: deps(),
  });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

async function createChat(modelId: string = CHAT_MODEL): Promise<string> {
  const res = await fetch(`${base()}/api/desktop/chats`, {
    method: "POST",
    headers: POST_JSON_HEADERS,
    body: JSON.stringify({ projectPath: projectDir, modelId }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { chat: { id: string } };
  return body.chat.id;
}

describe("Conversation Center release gate (#155)", () => {
  // AC1 — Text conversation works against an injected gateway port (the freshly-installed-package
  // scenario is the same wire surface; the test exercises the wire path the binary serves).
  it("AC1: text happy path — chat created, user+assistant persisted, gateway called once", async () => {
    const chatId = await createChat();
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Hello Keiko",
      }),
    });
    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      messages: { role: string; content: string }[];
    };
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.modelId).toBe(CHAT_MODEL);
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(body.messages[1]?.content).toBe("release-gate response");
    const persistedRoles = store.listMessages(chatId).map((message) => message.role);
    expect(persistedRoles).toEqual(expect.arrayContaining(["user", "assistant"]));
  });

  // AC2 — Image blocked on text-only model, gateway untouched.
  it("AC2: image attachment on text-only model → 400 CONVERSATION_UNSUPPORTED_MODALITY, gateway zero calls", async () => {
    const chatId = await createChat();
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "look",
        attachments: [{ kind: "image", mimeType: "image/png", sizeBytes: 1024 }],
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("CONVERSATION_UNSUPPORTED_MODALITY");
    expect(seenRequests).toHaveLength(0);
  });

  // AC2 — Document blocked on text-only model.
  it("AC2: document attachment on text-only model → 400 CONVERSATION_UNSUPPORTED_MODALITY, gateway zero calls", async () => {
    const chatId = await createChat();
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "read",
        attachments: [{ kind: "document", mimeType: "text/plain", sizeBytes: 64 }],
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("CONVERSATION_UNSUPPORTED_MODALITY");
    expect(seenRequests).toHaveLength(0);
  });

  // AC2 — Embedding model is never reachable from the send path.
  it("AC2: embedding model rejected on send → 400, gateway zero calls", async () => {
    // Bootstrap a chat with a chat-capable selectedModel (the only kind the bootstrap accepts).
    const chatId = await createChat();
    // Swap config to one that only knows the embedding model. The send path must reject because
    // the explicit modelId on the send body is not a chat capability.
    await restartWithDeps(
      deps(fakeModel("nope"), {
        config: embeddingOnlyConfig(),
        configPresent: true,
      }),
    );
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId,
        projectPath: projectDir,
        modelId: "release-gate-embed",
        content: "hi",
      }),
    });
    expect(sendRes.status).toBe(400);
    expect(seenRequests).toHaveLength(0);
  });

  // AC2 — Aggregate document context above 256 KiB is rejected before the gateway is reached.
  it("AC2: oversized documentContext (~300 KiB aggregate) → 400 CONVERSATION_OVERSIZED_CONTEXT", async () => {
    const chatId = await createChat();
    const entries = Array.from({ length: 5 }, (_value, i) => ({
      id: `doc-${String(i)}`,
      displayName: `doc-${String(i)}.txt`,
      mimeType: "text/plain",
      sizeBytes: 60_000,
      extractedBytes: 60_000,
      truncated: false,
      text: "x",
    }));
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "summarise",
        documentContext: entries,
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("CONVERSATION_OVERSIZED_CONTEXT");
    expect(seenRequests).toHaveLength(0);
  });

  // AC3 — Model switch persists across reload through PATCH /api/chats.
  it("AC3: PATCH /api/chats updates selectedModel; reload via GET sees the new model", async () => {
    const chatId = await createChat(CHAT_MODEL);
    // Switch via PATCH /api/chats.
    const patchRes = await fetch(`${base()}/api/chats?id=${encodeURIComponent(chatId)}`, {
      method: "PATCH",
      headers: PATCH_JSON_HEADERS,
      body: JSON.stringify({ selectedModel: ALT_CHAT_MODEL }),
    });
    expect(patchRes.status).toBe(200);
    // Reload the chat list — selectedModel must reflect the new value.
    const listRes = await fetch(
      `${base()}/api/chats?projectPath=${encodeURIComponent(projectDir)}`,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      chats: { id: string; selectedModel: string }[];
    };
    const reloaded = listBody.chats.find((chat) => chat.id === chatId);
    expect(reloaded?.selectedModel).toBe(ALT_CHAT_MODEL);
  });

  // AC8 — Validation error messages never echo caller-supplied values (model id, file name).
  // This is the GATE that release-PR evidence carries no customer-side strings.
  it("AC8: validation error redacts caller-supplied model id and file name from the wire message", async () => {
    const chatId = await createChat();
    const filename = "release-gate-secret-filename-xyz.png";
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "look",
        attachments: [{ kind: "image", mimeType: "image/png", sizeBytes: 1024, name: filename }],
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("CONVERSATION_UNSUPPORTED_MODALITY");
    const message = body.error?.message ?? "";
    expect(message).not.toContain(filename);
    expect(message).not.toContain(CHAT_MODEL);
    // AC8 negative-pattern sweep: the wire error envelope must never carry credential-shaped or
    // endpoint-shaped substrings that the matrix doc forbids in release evidence.
    expect(message).not.toMatch(/Bearer /);
    expect(message).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(message).not.toMatch(/https?:\/\//);
    expect(message.toLowerCase()).not.toContain("apikey");
  });
});
