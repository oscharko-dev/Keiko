// Realtime grounded voice tool route tests. The route must remain a thin bridge into the existing
// grounded Q&A core: it validates the voice/tool gate, calls the shared grounded pipeline once,
// returns a Realtime-safe tool output, and never duplicates committed chat turns for duplicate
// provider events.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { GatewayConfig, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { createInMemoryUiStore, type Chat, type ChatMessage, type UiStore } from "./store/index.js";

const runGroundedAskInputMock = vi.hoisted(() => vi.fn());

vi.mock("./grounded-qa.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./grounded-qa.js")>();
  return {
    ...actual,
    runGroundedAskInput: runGroundedAskInputMock,
  };
});

import { handleRealtimeGroundedVoiceTool } from "./voice-realtime-grounded-tool.js";

const CHAT_MODEL = "chat-model";
const VOICE_MODEL = "keiko-realtime";

let tmp: string;
let projectPath: string;
let store: UiStore;

function realtimeConfig(toolCalling = true): GatewayConfig {
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
        toolCalling,
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
        workflowEligible: true,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "Chat",
        preferredUseCases: ["Chat"],
        knownLimitations: [],
      },
    ],
  };
}

function deps(config: GatewayConfig = realtimeConfig()): UiHandlerDeps {
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: (value) => value,
    registry: createRunRegistry(),
    modelPortFactory: () => ({
      call: (request): Promise<NormalizedResponse> =>
        Promise.resolve({
          modelId: request.modelId,
          content: "unused",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "voice-grounded-tool-test",
            promptTokens: 1,
            completionTokens: 1,
            latencyMs: 1,
            costClass: "medium",
          },
        }),
    }),
    store,
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
    url: new URL("http://localhost/api/voice/realtime/grounded-tool"),
  };
}

function flushReadableEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function createChat(): Chat {
  store.createProject(projectPath, "Realtime voice tool");
  return store.createChat(projectPath, "Voice chat", CHAT_MODEL);
}

function createMessage(chatId: string, role: "user" | "assistant", content: string): ChatMessage {
  return store.createMessage({
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

function groundedAnswer(chatId: string, overrides: Partial<GroundedAnswer> = {}): GroundedAnswer {
  const user = createMessage(chatId, "user", "Worum geht es im Fachkonzept?");
  const assistant = createMessage(
    chatId,
    "assistant",
    "Das Fachkonzept beschreibt die Bonitätsprüfung für Ratenkredite.",
  );
  const base = {
    groundingKind: "hybrid",
    userMessageId: user.id,
    assistantMessageId: assistant.id,
    evidenceRunId: "evidence-1",
    content: assistant.content,
    citations: [
      {
        marker: 1,
        scopePath: "docs/fachkonzept.md",
        source: "Repository",
        lineRange: { startLine: 12, endLine: 20 },
        score: 0.94,
        stableId: "repo-docs-fachkonzept",
      },
    ],
    knowledgeCitations: [
      {
        stableId: "knowledge-1",
        marker: "[2]",
        label: "Fachkonzept.pdf",
        score: 0.91,
        source: "Knowledge capsule: test",
        lineage: {
          capsuleId: "cap-1",
          sourceId: "source-1",
          documentId: "doc-1",
          chunkId: "chunk-1",
        },
      },
    ],
    uncertainty: [],
    omittedCount: 0,
    elapsedMs: 37,
    contextPack: {
      kind: "hybrid",
      folderSourceCount: 1,
      connectorSourceCount: 1,
      folder: {},
      knowledge: {},
    },
  };
  return { ...base, ...overrides } as unknown as GroundedAnswer;
}

function requestFor(chat: Chat, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: chat.id,
    projectPath,
    callId: `call-${randomUUID()}`,
    query: "Worum geht es im Fachkonzept?",
    modelId: CHAT_MODEL,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-voice-grounded-tool-"));
  projectPath = join(tmp, "project");
  mkdirSync(projectPath);
  let now = 1_700_000_000_000;
  store = createInMemoryUiStore({ now: () => ++now });
  runGroundedAskInputMock.mockReset();
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("handleRealtimeGroundedVoiceTool", () => {
  it("rejects malformed requests before touching the grounded pipeline", async () => {
    const result = await handleRealtimeGroundedVoiceTool(ctx("{not json"), deps());
    expect(result.status).toBe(400);
    expect(runGroundedAskInputMock).not.toHaveBeenCalled();

    const chat = createChat();
    const badCallId = await handleRealtimeGroundedVoiceTool(
      ctx(requestFor(chat, { callId: "bad call id" })),
      deps(),
    );
    expect(badCallId.status).toBe(400);
    expect(runGroundedAskInputMock).not.toHaveBeenCalled();
  });

  it("fails closed when the deployment is not full realtime voice capable", async () => {
    const chat = createChat();
    const result = await handleRealtimeGroundedVoiceTool(
      ctx(requestFor(chat)),
      deps(chatOnlyConfig()),
    );

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({
      error: { code: "VOICE_TOOL_UNAVAILABLE" },
    });
    expect(runGroundedAskInputMock).not.toHaveBeenCalled();
  });

  it("allows full realtime voice retrieval when the provider lacks tool calling", async () => {
    const chat = createChat();
    const answer = groundedAnswer(chat.id);
    runGroundedAskInputMock.mockResolvedValue({ status: 200, body: answer } satisfies RouteResult);

    const result = await handleRealtimeGroundedVoiceTool(
      ctx(requestFor(chat)),
      deps(realtimeConfig(false)),
    );

    expect(result.status).toBe(200);
    expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
    expect(result.body).toMatchObject({
      groundedAnswer: { content: answer.content },
      toolOutput: {
        status: "ok",
        answer: answer.content,
        persisted: { userMessageId: answer.userMessageId, assistantMessageId: answer.assistantMessageId },
      },
    });
  });

  it("rejects missing or project-mismatched chats before running retrieval", async () => {
    const chat = createChat();
    const result = await handleRealtimeGroundedVoiceTool(
      ctx(requestFor(chat, { projectPath: join(tmp, "other") })),
      deps(),
    );

    expect(result.status).toBe(404);
    expect(runGroundedAskInputMock).not.toHaveBeenCalled();
  });

  it("runs the shared grounded pipeline with the verbatim user transcript and returns a Realtime-safe tool output", async () => {
    const chat = createChat();
    const answer = groundedAnswer(chat.id);
    runGroundedAskInputMock.mockResolvedValue({ status: 200, body: answer } satisfies RouteResult);

    const result = await handleRealtimeGroundedVoiceTool(
      ctx(
        requestFor(chat, {
          query: "modell umgeschriebene retrieval query",
          userTranscript: "Worum\u202e geht es im Fachkonzept?",
        }),
      ),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
    expect(runGroundedAskInputMock).toHaveBeenCalledWith(
      { chatId: chat.id, content: "Worum geht es im Fachkonzept?", modelId: CHAT_MODEL },
      expect.any(Object),
    );
    expect(result.body).toMatchObject({
      groundedAnswer: { content: answer.content, groundingKind: "hybrid" },
      toolOutput: {
        status: "ok",
        answer: answer.content,
        groundingKind: "hybrid",
        elapsedMs: 37,
        persisted: {
          userMessageId: answer.userMessageId,
          assistantMessageId: answer.assistantMessageId,
        },
        instruction:
          "Speak this answer faithfully in a concise voice-friendly way. Do not add facts that are not in the answer.",
      },
    });
    expect((result.body as { toolOutput: { citations: unknown[] } }).toolOutput.citations).toEqual([
      { marker: "[1]", label: "docs/fachkonzept.md", source: "Repository" },
      { marker: "[2]", label: "Fachkonzept.pdf", source: "Knowledge capsule: test" },
    ]);
  });

  it("falls back to the model query when no user transcript is available", async () => {
    const chat = createChat();
    const answer = groundedAnswer(chat.id);
    runGroundedAskInputMock.mockResolvedValue({ status: 200, body: answer } satisfies RouteResult);

    const result = await handleRealtimeGroundedVoiceTool(
      ctx(requestFor(chat, { query: "  Welche\u202e Quellen gelten?  " })),
      deps(),
    );

    expect(result.status).toBe(200);
    expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
    expect(runGroundedAskInputMock).toHaveBeenCalledWith(
      { chatId: chat.id, content: "Welche Quellen gelten?", modelId: CHAT_MODEL },
      expect.any(Object),
    );
  });

  it("deduplicates concurrent duplicate provider function-call events after ownership validation", async () => {
    const chat = createChat();
    const answer = groundedAnswer(chat.id);
    let resolveGrounded: (value: RouteResult) => void = () => undefined;
    runGroundedAskInputMock.mockImplementation(
      () =>
        new Promise<RouteResult>((resolve) => {
          resolveGrounded = resolve;
        }),
    );
    const request = requestFor(chat, { callId: "provider-call-1", query: " Worum   geht es? " });

    const firstPromise = handleRealtimeGroundedVoiceTool(ctx(request), deps());
    await vi.waitFor(() => {
      expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
    });
    const secondPromise = handleRealtimeGroundedVoiceTool(
      ctx({ ...request, query: "worum geht es?" }),
      deps(),
    );
    await flushReadableEvents();
    expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
    resolveGrounded({ status: 200, body: answer } satisfies RouteResult);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
    expect(second.body).toEqual(first.body);
  });

  it("checks realtime capability before returning any duplicate response", async () => {
    const chat = createChat();
    const answer = groundedAnswer(chat.id);
    runGroundedAskInputMock.mockResolvedValue({ status: 200, body: answer } satisfies RouteResult);
    const request = requestFor(chat, { callId: "provider-call-capability" });

    const first = await handleRealtimeGroundedVoiceTool(ctx(request), deps());
    const unavailable = await handleRealtimeGroundedVoiceTool(ctx(request), deps(chatOnlyConfig()));

    expect(first.status).toBe(200);
    expect(unavailable.status).toBe(403);
    expect(unavailable.body).toMatchObject({
      error: { code: "VOICE_TOOL_UNAVAILABLE" },
    });
    expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
  });

  it("checks chat ownership before joining an in-flight duplicate", async () => {
    const chat = createChat();
    const answer = groundedAnswer(chat.id);
    let resolveGrounded: (value: RouteResult) => void = () => undefined;
    runGroundedAskInputMock.mockImplementation(
      () =>
        new Promise<RouteResult>((resolve) => {
          resolveGrounded = resolve;
        }),
    );
    const request = requestFor(chat, {
      callId: "provider-call-ownership",
      query: "Welche Quelle?",
      userTranscript: "Welche Quelle?",
    });

    const firstPromise = handleRealtimeGroundedVoiceTool(ctx(request), deps());
    await vi.waitFor(() => {
      expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
    });
    const mismatchedProject = await handleRealtimeGroundedVoiceTool(
      ctx({ ...request, projectPath: join(tmp, "other-project") }),
      deps(),
    );
    resolveGrounded({ status: 200, body: answer } satisfies RouteResult);
    const first = await firstPromise;

    expect(first.status).toBe(200);
    expect(mismatchedProject.status).toBe(404);
    expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
  });

  it("keeps in-flight dedup scoped by normalized project path", async () => {
    const chat = createChat();
    const otherProjectPath = join(tmp, "other-project");
    mkdirSync(otherProjectPath);
    store.createProject(otherProjectPath, "Other realtime voice tool project");
    let activeProjectPath = projectPath;
    const scopedDeps: UiHandlerDeps = {
      ...deps(),
      store: {
        ...store,
        findChatById: (id) =>
          id === chat.id ? { ...chat, projectPath: activeProjectPath } : store.findChatById(id),
      },
    };
    const resolvers: ((value: RouteResult) => void)[] = [];
    runGroundedAskInputMock.mockImplementation(
      () =>
        new Promise<RouteResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const request = requestFor(chat, {
      callId: "provider-call-project-key",
      query: "Welche Quelle?",
      userTranscript: "Welche Quelle?",
    });

    activeProjectPath = projectPath;
    const firstPromise = handleRealtimeGroundedVoiceTool(ctx(request), scopedDeps);
    await vi.waitFor(() => {
      expect(runGroundedAskInputMock).toHaveBeenCalledTimes(1);
    });
    activeProjectPath = otherProjectPath;
    const secondPromise = handleRealtimeGroundedVoiceTool(
      ctx({ ...request, projectPath: otherProjectPath }),
      scopedDeps,
    );
    await vi.waitFor(() => {
      expect(runGroundedAskInputMock).toHaveBeenCalledTimes(2);
    });
    const firstResolver = resolvers[0];
    const secondResolver = resolvers[1];
    if (firstResolver === undefined || secondResolver === undefined) {
      throw new Error("expected both grounded tool calls to be pending");
    }
    firstResolver({ status: 200, body: groundedAnswer(chat.id) } satisfies RouteResult);
    secondResolver({ status: 200, body: groundedAnswer(chat.id) } satisfies RouteResult);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("keeps in-flight dedup sensitive to the verbatim user transcript", async () => {
    const chat = createChat();
    const resolvers: ((value: RouteResult) => void)[] = [];
    runGroundedAskInputMock.mockImplementation(
      () =>
        new Promise<RouteResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const request = requestFor(chat, {
      callId: "provider-call-transcript",
      query: "modell query",
    });

    const firstPromise = handleRealtimeGroundedVoiceTool(
      ctx({ ...request, userTranscript: "Welche Frist gilt?" }),
      deps(),
    );
    const secondPromise = handleRealtimeGroundedVoiceTool(
      ctx({ ...request, userTranscript: "Welche Gebühr gilt?" }),
      deps(),
    );
    await vi.waitFor(() => {
      expect(runGroundedAskInputMock).toHaveBeenCalledTimes(2);
    });
    expect(runGroundedAskInputMock).toHaveBeenNthCalledWith(
      1,
      { chatId: chat.id, content: "Welche Frist gilt?", modelId: CHAT_MODEL },
      expect.any(Object),
    );
    expect(runGroundedAskInputMock).toHaveBeenNthCalledWith(
      2,
      { chatId: chat.id, content: "Welche Gebühr gilt?", modelId: CHAT_MODEL },
      expect.any(Object),
    );

    const firstResolver = resolvers[0];
    const secondResolver = resolvers[1];
    if (firstResolver === undefined || secondResolver === undefined) {
      throw new Error("expected both grounded tool calls to be pending");
    }
    firstResolver({ status: 200, body: groundedAnswer(chat.id) } satisfies RouteResult);
    secondResolver({ status: 200, body: groundedAnswer(chat.id) } satisfies RouteResult);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("maps non-grounded core responses and missing persisted messages to internal errors", async () => {
    const chat = createChat();
    runGroundedAskInputMock.mockResolvedValueOnce({
      status: 200,
      body: { ok: true },
    } satisfies RouteResult);
    const missingAnswer = groundedAnswer(chat.id, {
      userMessageId: "missing-user",
      assistantMessageId: "missing-assistant",
    });
    runGroundedAskInputMock.mockResolvedValueOnce({
      status: 200,
      body: missingAnswer,
    } satisfies RouteResult);

    const nonGrounded = await handleRealtimeGroundedVoiceTool(
      ctx(requestFor(chat, { callId: "non-grounded" })),
      deps(),
    );
    const missingMessages = await handleRealtimeGroundedVoiceTool(
      ctx(requestFor(chat, { callId: "missing-messages" })),
      deps(),
    );

    expect(nonGrounded.status).toBe(500);
    expect(missingMessages.status).toBe(500);
    expect(runGroundedAskInputMock).toHaveBeenCalledTimes(2);
  });
});
