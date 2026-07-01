// Desktop canvas chat routes: real UI chat persistence with an injected ModelPort, keeping provider
// credentials behind the existing gateway seam and avoiding network calls in tests.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUiServer, UI_HOST } from "./server.js";
import { buildCspHeader } from "./csp.js";
import { composeDiscussionDirectiveBlock } from "./discussion-prompt.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  GatewayConfig,
  GatewayRequest,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import { DEFAULT_CONTEXT_PROFILE } from "@oscharko-dev/keiko-contracts";

const POST_JSON_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const CHAT_MODEL = "example-chat-model";

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
          requestId: "desktop-chat-test",
          promptTokens: 7,
          completionTokens: 3,
          latencyMs: 11,
          costClass: "high",
        },
      });
    },
  };
}

function oversizedHistoryTurn(index: number): string {
  const oversized = "x".repeat(150_000);
  return `history turn ${String(index)} ${oversized}`;
}

function scriptedIdentityRecallModel(): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      seenRequests.push(request);
      const system = request.messages[0]?.content ?? "";
      const latestUser = request.messages.at(-1)?.content ?? "";
      let content = "Hallo!";
      if (system.includes("You extract durable memories from a chat turn")) {
        content = "[]";
      } else if (latestUser.includes("What is my name?")) {
        content = latestUser.includes("The user's name is Paul.") ? "Paul" : "unbekannt";
      }
      return Promise.resolve({
        modelId: request.modelId,
        content,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "desktop-chat-test",
          promptTokens: 7,
          completionTokens: 3,
          latencyMs: 11,
          costClass: "high",
        },
      });
    },
  };
}

function scriptedOliverProfileMemoryModel(): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      seenRequests.push(request);
      const system = request.messages[0]?.content ?? "";
      const content = system.includes("You extract durable memories from a chat turn")
        ? JSON.stringify([
            {
              source: "user",
              body: "The user's name is Oliver.",
              type: "identity",
              confidence: 0.96,
              scope: "user",
              tags: ["identity", "name"],
            },
            {
              source: "user",
              body: "The user is 35 years old.",
              type: "fact",
              confidence: 0.9,
              scope: "user",
              tags: ["identity", "age"],
            },
            {
              source: "user",
              body: "The user is a software developer.",
              type: "fact",
              confidence: 0.9,
              scope: "user",
              tags: ["identity", "profession"],
            },
          ])
        : "Understood.";
      return Promise.resolve({
        modelId: request.modelId,
        content,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "desktop-chat-test",
          promptTokens: 7,
          completionTokens: 3,
          latencyMs: 11,
          costClass: "high",
        },
      });
    },
  };
}

function deps(
  model: ModelPort = fakeModel("test response"),
  overrides: Partial<UiHandlerDeps> = {},
): UiHandlerDeps {
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

function base(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function customModelConfig(modelId = "example-private-chat"): GatewayConfig {
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
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-ui-desktop-static-"));
  tmp = mkdtempSync(join(tmpdir(), "keiko-ui-desktop-"));
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

describe("desktop chat routes", () => {
  it("creates a GPTOSS chat scoped to a validated local project", async () => {
    const res = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { path: string; available: boolean };
      chat: { projectPath: string; selectedModel: string };
      messages: unknown[];
    };
    expect(body.project).toMatchObject({ path: projectDir, available: true });
    expect(body.chat).toMatchObject({ projectPath: projectDir, selectedModel: CHAT_MODEL });
    expect(body.messages).toEqual([]);
  });

  it("uses the preferred launch project when no projectPath is supplied", async () => {
    const staleDir = join(tmp, "aaa-stale-project");
    mkdirSync(staleDir);
    store.createProject(staleDir, "stale");
    await restartWithDeps(
      deps(fakeModel("preferred response"), { preferredProjectPath: projectDir }),
    );

    const res = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ modelId: CHAT_MODEL }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { path: string };
      chat: { projectPath: string };
    };
    expect(body.project.path).toBe(projectDir);
    expect(body.chat.projectPath).toBe(projectDir);
  });

  it("uses the configured custom chat model as the default when no modelId is supplied", async () => {
    const modelId = "example-private-chat";
    await restartWithDeps(
      deps(fakeModel("custom response"), {
        config: customModelConfig(modelId),
        configPresent: true,
      }),
    );
    const res = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      chat: { projectPath: string; selectedModel: string };
    };
    expect(body.chat).toMatchObject({ projectPath: projectDir, selectedModel: modelId });
  });

  it("persists user and assistant messages while calling the configured model port", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Say hello",
      }),
    });
    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      chat: { id: string; selectedModel: string; title: string };
      messages: {
        role: string;
        content: string;
        runId?: string;
        workflowStatus?: string;
      }[];
      usage: { requestId: string };
    };
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.modelId).toBe(CHAT_MODEL);
    expect(seenRequests[0]?.messages.at(-1)).toEqual({ role: "user", content: "Say hello" });
    expect(body.chat).toMatchObject({ id: created.chat.id, selectedModel: CHAT_MODEL });
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(body.messages[1]).toMatchObject({ content: "test response" });
    expect(body.messages[1]?.runId).toBeUndefined();
    expect(body.messages[1]?.workflowStatus).toBeUndefined();
    expect(body.usage.requestId).toBe("desktop-chat-test");
    const persistedRoles = store.listMessages(created.chat.id).map((message) => message.role);
    expect(persistedRoles).toHaveLength(2);
    expect(persistedRoles).toEqual(expect.arrayContaining(["user", "assistant"]));
  });

  it("compacts long chat history from the active model profile resolver when the singleton profile is absent", async () => {
    await restartWithDeps(
      deps(fakeModel("compacted response"), {
        contextProfile: undefined,
        contextProfileForModel: () => DEFAULT_CONTEXT_PROFILE,
      }),
    );
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };
    const now = Date.now();
    const history = Array.from({ length: 3 }, (_, index) => ({
      chatId: created.chat.id,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: oversizedHistoryTurn(index),
      timestamp: now + index,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    }));
    store.createMessages(history);

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Summarize the latest state",
      }),
    });

    expect(sendRes.status).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.messages[1]?.content).toContain(
      "Automated summary of earlier conversation turns",
    );
    expect(seenRequests[0]?.messages[1]?.content).not.toContain("history turn 2");
  });

  it("appends realtime voice turns without calling the chat model", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string; title: string } };

    const appendRes = await fetch(`${base()}/api/desktop/chat/voice-turn`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        messages: [
          { role: "user", content: "open the deploy log" },
          { role: "assistant", content: "The deploy log is open." },
        ],
      }),
    });

    expect(appendRes.status).toBe(200);
    const body = (await appendRes.json()) as {
      chat: { id: string; title: string };
      messages: { role: string; content: string; runId?: string }[];
    };
    expect(seenRequests).toHaveLength(0);
    expect(body.chat).toMatchObject({
      id: created.chat.id,
      title: "open the deploy log",
    });
    expect(body.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "open the deploy log"],
      ["assistant", "The deploy log is open."],
    ]);
    expect(body.messages.some((message) => message.runId !== undefined)).toBe(false);

    const persisted = store.listMessages(created.chat.id);
    expect(persisted.map((message) => [message.role, message.content])).toEqual([
      ["user", "open the deploy log"],
      ["assistant", "The deploy log is open."],
    ]);
  });

  it("captures MemoriaViva proposals from realtime voice turns without generating a second chat answer", async () => {
    const memoryDir = join(tmp, "voice-turn-memory-vault");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    await restartWithDeps(
      deps(fakeModel("unused"), {
        memoryVault,
        modelPortFactory: () => undefined,
      }),
    );

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string; title: string } };

    const appendRes = await fetch(`${base()}/api/desktop/chat/voice-turn`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        messages: [
          { role: "user", content: "remember that my preferred database is postgres" },
          { role: "assistant", content: "I will remember that preference." },
        ],
        memory: {
          enabled: true,
          budgetTokens: 900,
          context: {},
        },
      }),
    });

    expect(appendRes.status).toBe(200);
    const body = (await appendRes.json()) as {
      messages: { role: string; content: string; runId?: string }[];
      memory?: { actions: { kind: string; proposalId?: string }[] };
    };
    expect(seenRequests).toHaveLength(0);
    expect(body.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "remember that my preferred database is postgres"],
      ["assistant", "I will remember that preference."],
    ]);
    expect(body.memory?.actions[0]?.kind).toBe("candidate");
    const proposalId = body.memory?.actions[0]?.proposalId;
    expect(proposalId).toBeDefined();
    if (proposalId !== undefined) {
      expect(memoryVault.getMemory(proposalId as MemoryId)?.status).toBe("proposed");
    }
    memoryVault.close();
  });

  it("does not capture assistant-only realtime voice turns as user memories", async () => {
    const memoryDir = join(tmp, "voice-turn-assistant-only-memory-vault");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    await restartWithDeps(
      deps(fakeModel("unused"), {
        memoryVault,
        modelPortFactory: () => undefined,
      }),
    );

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const appendRes = await fetch(`${base()}/api/desktop/chat/voice-turn`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        messages: [{ role: "assistant", content: "remember that my preferred shell is fish" }],
        memory: {
          enabled: true,
          budgetTokens: 900,
          context: {},
        },
      }),
    });

    expect(appendRes.status).toBe(200);
    const body = (await appendRes.json()) as {
      memory?: { actions: { kind: string; proposalId?: string }[] };
    };
    expect(body.memory?.actions).toEqual([]);
    expect(memoryVault.listMemories({ includeExpired: true })).toEqual([]);
    expect(seenRequests).toHaveLength(0);
    memoryVault.close();
  });

  it("does not wait for model-assisted salience capture before returning a realtime voice turn", async () => {
    const memoryDir = join(tmp, "voice-turn-async-salience-vault");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const neverResolvingSalienceModel: ModelPort = {
      call(request): Promise<NormalizedResponse> {
        seenRequests.push(request);
        return new Promise<NormalizedResponse>((resolve) => {
          void resolve;
        });
      },
    };
    await restartWithDeps(deps(neverResolvingSalienceModel, { memoryVault }));

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const appendRes = await Promise.race([
      fetch(`${base()}/api/desktop/chat/voice-turn`, {
        method: "POST",
        headers: POST_JSON_HEADERS,
        body: JSON.stringify({
          chatId: created.chat.id,
          projectPath: projectDir,
          messages: [
            { role: "user", content: "remember that my voice IDE is Keiko" },
            { role: "assistant", content: "I will remember that." },
          ],
          memory: {
            enabled: true,
            budgetTokens: 900,
            context: {},
          },
        }),
      }),
      new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("voice-turn response waited for salience capture"));
        }, 250);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);

    expect(appendRes.status).toBe(200);
    const body = (await appendRes.json()) as {
      memory?: { actions: { kind: string; proposalId?: string }[] };
    };
    expect(body.memory?.actions[0]?.kind).toBe("candidate");
    expect(seenRequests).toHaveLength(1);
    memoryVault.close();
  });

  it("rejects an empty model response without persisting a fake assistant message", async () => {
    await restartWithDeps(deps(fakeModel("")));
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Say hello",
      }),
    });

    expect(sendRes.status).toBe(502);
    const body = (await sendRes.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("GATEWAY_PROVIDER_ERROR");
    expect(body.error?.message).toContain("empty assistant response");
    const persisted = store.listMessages(created.chat.id);
    expect(persisted.map((message) => message.role)).toEqual(["user"]);
    expect(persisted.some((message) => message.role === "assistant")).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain("The model returned an empty response.");
  });

  it("does not send legacy empty-response placeholders back to the model as chat context", async () => {
    await restartWithDeps(deps(fakeModel("fresh response")));
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };
    store.createMessage({
      chatId: created.chat.id,
      role: "assistant",
      content: "The model returned an empty response.",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Say hello again",
      }),
    });

    expect(sendRes.status).toBe(200);
    expect(JSON.stringify(seenRequests[0]?.messages)).not.toContain(
      "The model returned an empty response.",
    );
    const body = (await sendRes.json()) as { messages: { role: string; content: string }[] };
    expect(body.messages.map((message) => message.content)).toEqual([
      "Say hello again",
      "fresh response",
    ]);
  });

  // eslint-disable-next-line complexity
  it("does not retrieve unrelated memories before persisting candidate proposals from chat intents", async () => {
    const memoryDir = join(tmp, "memory-vault");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const recalled = insertAcceptedMemory(memoryVault, "Use pnpm instead of npm for installs.");
    await restartWithDeps(deps(fakeModel("memory response"), { memoryVault }));

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "remember that we deploy after the green CI run",
        memory: {
          enabled: true,
          budgetTokens: 900,
          context: {},
        },
      }),
    });

    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      memory?: {
        context: { enabled: boolean; memories: { bodyExcerpt: string }[] };
        actions: { kind: string; proposalId?: string }[];
      };
    };
    expect(seenRequests[0]?.messages.at(-1)?.content).not.toContain("Included memory context:");
    expect(seenRequests[0]?.messages.at(-1)?.content).not.toContain("Use pnpm instead of npm");
    expect(body.memory?.context.enabled).toBe(true);
    expect(body.memory?.context.memories).toHaveLength(0);
    expect(body.memory?.actions[0]?.kind).toBe("candidate");
    const proposalId = body.memory?.actions[0]?.proposalId;
    expect(proposalId).toBeDefined();
    if (proposalId !== undefined) {
      expect(memoryVault.getMemory(proposalId as MemoryId)?.status).toBe("proposed");
    }
    expect(memoryVault.getAccessStats([recalled.id]).get(recalled.id)?.accessCount ?? 0).toBe(0);
    memoryVault.close();
  });

  it("persists confidential chat-intent candidates as masked review proposals", async () => {
    const memoryDir = join(tmp, "memory-vault-confidential");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    await restartWithDeps(deps(fakeModel("memory response"), { memoryVault }));

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "remember that my private support email is developer@example.com",
        memory: { enabled: true, context: {} },
      }),
    });

    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      memory?: {
        actions: {
          kind: string;
          body?: string;
          proposalId?: string;
          requiresApproval?: boolean;
        }[];
      };
    };
    expect(body.memory?.actions[0]).toMatchObject({
      kind: "candidate",
      body: "Sensitive memory pending review.",
      requiresApproval: true,
    });
    const proposalId = body.memory?.actions[0]?.proposalId;
    expect(proposalId).toBeDefined();
    if (proposalId !== undefined) {
      const record = memoryVault.getMemory(proposalId as MemoryId);
      expect(record?.status).toBe("proposed");
      expect(record?.provenance.sensitivity).toBe("confidential");
    }
    memoryVault.close();
  });

  it("threads deployment redaction literals into chat-intent memory rejection", async () => {
    const memoryDir = join(tmp, "memory-vault-customer-identifier");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    await restartWithDeps(
      deps(fakeModel("memory response"), {
        memoryVault,
        redactionSecrets: ["CustomerOmega"],
      }),
    );

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "remember that CustomerOmega requires SSO for releases",
        memory: { enabled: true, context: {} },
      }),
    });

    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      memory?: { actions: { kind: string; reason?: string }[] };
    };
    expect(body.memory?.actions).toEqual([{ kind: "rejected", reason: "customer-identifier" }]);
    expect(memoryVault.listMemories({ includeExpired: true })).toEqual([]);
    memoryVault.close();
  });

  // eslint-disable-next-line complexity
  it("captures an ambient identity statement, requires acceptance, and recalls it in a new chat", async () => {
    const memoryDir = join(tmp, "memory-vault-ambient-identity");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    await restartWithDeps(deps(scriptedIdentityRecallModel(), { memoryVault }));

    const createChatA = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const chatA = (await createChatA.json()) as { chat: { id: string } };

    const introduceRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: chatA.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Hallo Keiko, ich bin Paul.",
        memory: { enabled: true, context: {} },
      }),
    });
    expect(introduceRes.status).toBe(200);
    const introduceBody = (await introduceRes.json()) as {
      memory?: {
        context: { memories: unknown[] };
        actions: { kind: string; proposalId?: string; body?: string }[];
      };
    };
    expect(introduceBody.memory?.context.memories).toHaveLength(0);
    expect(introduceBody.memory?.actions).toHaveLength(1);
    expect(introduceBody.memory?.actions[0]).toMatchObject({
      kind: "candidate",
      body: "The user's name is Paul.",
    });
    const proposalId = introduceBody.memory?.actions[0]?.proposalId;
    expect(typeof proposalId).toBe("string");
    if (proposalId === undefined) {
      throw new Error("expected ambient identity capture to return a proposal id");
    }
    expect(memoryVault.getMemory(proposalId as MemoryId)?.status).toBe("proposed");

    const acceptRes = await fetch(
      `${base()}/api/memory/proposals/${encodeURIComponent(proposalId)}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: "{}",
      },
    );
    expect(acceptRes.status).toBe(200);
    expect(memoryVault.getMemory(proposalId as MemoryId)?.status).toBe("accepted");
    const acceptedMemory = memoryVault.getMemory(proposalId as MemoryId);

    const createChatB = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const chatB = (await createChatB.json()) as { chat: { id: string } };

    const recallRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: chatB.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "What is my name?",
        memory: { enabled: true, context: {} },
      }),
    });
    expect(recallRes.status).toBe(200);
    const recallBody = (await recallRes.json()) as {
      messages: { role: string; content: string }[];
      memory?: {
        context: {
          memories: {
            bodyExcerpt: string;
            sourceKind: string;
            sensitivity: string;
            confidence: number;
            status: string;
            capturedAt: number;
          }[];
        };
      };
    };
    expect(recallBody.memory?.context.memories).toHaveLength(1);
    const recalled = recallBody.memory?.context.memories[0];
    expect(recalled?.bodyExcerpt).toContain("Paul");
    expect(recalled?.sourceKind).toBe(acceptedMemory?.provenance.sourceKind);
    expect(recalled?.sensitivity).toBe(acceptedMemory?.provenance.sensitivity);
    expect(recalled?.confidence).toBe(acceptedMemory?.provenance.confidence);
    expect(recalled?.status).toBe(acceptedMemory?.status);
    expect(recalled?.capturedAt).toBe(acceptedMemory?.provenance.capturedAt);
    expect(recallBody.messages[1]?.content).toBe("Paul");
    expect(seenRequests[2]?.messages.at(-1)?.content).toContain("The user's name is Paul.");
    memoryVault.close();
  });

  it("captures a spoken-profile chat turn as proposed MemoriaViva candidates", async () => {
    const memoryDir = join(tmp, "memory-vault-spoken-profile");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    await restartWithDeps(deps(scriptedOliverProfileMemoryModel(), { memoryVault }));

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Ich heiße Oliver, bin 35 Jahre alt und bin Softwareentwickler.",
        memory: { enabled: true, context: {} },
      }),
    });

    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      memory?: {
        context: { enabled: boolean; memories: unknown[] };
        actions: { kind: string; proposalId?: string; body?: string }[];
      };
    };
    const candidates = body.memory?.actions.filter((action) => action.kind === "candidate") ?? [];
    const candidateBodies = candidates.map((action) => action.body);
    expect(body.memory?.context.enabled).toBe(true);
    expect(body.memory?.context.memories).toHaveLength(0);
    expect(candidateBodies).toEqual(
      expect.arrayContaining([
        "The user's name is Oliver.",
        "The user is 35 years old.",
        "The user is a software developer.",
      ]),
    );
    for (const action of candidates) {
      expect(typeof action.proposalId).toBe("string");
      if (action.proposalId !== undefined) {
        expect(memoryVault.getMemory(action.proposalId as MemoryId)?.status).toBe("proposed");
      }
    }
    expect(
      seenRequests.some((request) => request.messages.at(-1)?.content.includes("Oliver")),
    ).toBe(true);
    memoryVault.close();
  });

  it("returns empty memory result and omits prompt injection when memory.enabled is false", async () => {
    const memoryDir = join(tmp, "memory-vault-off");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    insertAcceptedMemory(memoryVault, "Use pnpm instead of npm for installs.");
    await restartWithDeps(deps(fakeModel("no-memory response"), { memoryVault }));

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const beforeCount = memoryVault.listMemories({ includeExpired: true }).length;
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "remember that we deploy after the green CI run",
        memory: {
          enabled: false,
          budgetTokens: 900,
          context: {},
        },
      }),
    });

    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      memory?: {
        context: { enabled: boolean; memories: unknown[] };
        actions: unknown[];
      };
    };
    expect(seenRequests[0]?.messages.at(-1)?.content).not.toContain("Included memory context:");
    expect(body.memory?.context.enabled).toBe(false);
    expect(body.memory?.context.memories).toHaveLength(0);
    expect(body.memory?.actions).toHaveLength(0);
    expect(memoryVault.listMemories({ includeExpired: true })).toHaveLength(beforeCount);
    memoryVault.close();
  });

  it("includes accepted global memories in desktop chat retrieval", async () => {
    const memoryDir = join(tmp, "memory-vault-global");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    insertAcceptedMemory(memoryVault, "All projects use pnpm for installs.", { kind: "global" });
    await restartWithDeps(deps(fakeModel("global memory response"), { memoryVault }));

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Which package manager should I use?",
        memory: { enabled: true, context: {} },
      }),
    });

    expect(sendRes.status).toBe(200);
    expect(seenRequests[0]?.messages.at(-1)?.content).toContain("All projects use pnpm");
    memoryVault.close();
  });

  it("ignores forged memory.context coordinates and binds memory to the resolved chat context", async () => {
    const memoryDir = join(tmp, "memory-vault-forged-context");
    mkdirSync(memoryDir);
    const memoryVault = createMemoryVault({ memoryDir, redactString: (value) => value });
    insertAcceptedMemory(memoryVault, "Use pnpm instead of npm for installs.");
    await restartWithDeps(deps(fakeModel("forged memory response"), { memoryVault }));

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "remember that we deploy after the green CI run",
        memory: {
          enabled: true,
          context: {
            userId: "forged-user",
            workspaceId: "/tmp/forged-workspace",
            projectId: "/tmp/forged-project",
            conversationId: "forged-chat-id",
          },
        },
      }),
    });

    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      memory?: { actions: { kind: string; proposalId?: string }[] };
    };
    const proposalId = body.memory?.actions[0]?.proposalId;
    expect(proposalId).toBeDefined();
    if (proposalId !== undefined) {
      const proposal = memoryVault.getMemory(proposalId as MemoryId);
      expect(proposal?.scope).toEqual({ kind: "project", projectId: projectDir });
    }
    memoryVault.close();
  });

  // Issue #174 — on native Windows the desktop bootstrap calls validateProjectPath(process.cwd()),
  // and process.cwd() returns a drive-letter form such as `C:\Users\Example\Project`. The previous
  // validator rejected any Windows drive shape regardless of host, returning `invalid_path` even
  // when the directory existed. This test pins the shape-acceptance contract: when no projectPath
  // is supplied and no stored project is available, the bootstrap must not reject solely because
  // the working directory uses a Windows drive letter. On POSIX hosts the validator still reports
  // `path_not_found` (the drive path does not exist), which is the correct host-conditional
  // outcome; on Windows hosts the existing directory passes and a 201 is returned. Either way the
  // failure mode is not `invalid_path`.
  it("does not reject the desktop bootstrap with invalid_path when process.cwd is a Windows drive path", async () => {
    store.deleteProject(projectDir);
    const windowsCwd = "C:\\Users\\Example\\Project";
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(windowsCwd);
    try {
      const res = await fetch(`${base()}/api/desktop/chats`, {
        method: "POST",
        headers: POST_JSON_HEADERS,
        body: JSON.stringify({ modelId: CHAT_MODEL }),
      });
      if (process.platform === "win32") {
        expect(res.status).toBe(201);
      } else {
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("path_not_found");
      }
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // Issue #148 — documentContext on a send payload is projected into a structured prompt block
  // for the model call ONLY. The persisted user-message bubble keeps the raw draft so chat
  // history stays readable. The gateway sees the composed form on the latest user turn.
  it("composes the latest user turn with attached document context for the model call", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Summarise this",
        documentContext: [
          {
            id: "doc-1",
            displayName: "spec.md",
            mimeType: "text/markdown",
            sizeBytes: 1024,
            extractedBytes: 22,
            truncated: false,
            text: "Some document content.",
          },
        ],
      }),
    });
    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      messages: { role: string; content: string }[];
    };
    // The persisted user message keeps the raw draft (chat history stays readable).
    expect(body.messages[0]).toMatchObject({ role: "user", content: "Summarise this" });
    // The gateway received the structured prompt on the latest user turn.
    const lastTurn = seenRequests[0]?.messages.at(-1);
    expect(lastTurn?.role).toBe("user");
    expect(lastTurn?.content).toContain("User message:");
    expect(lastTurn?.content).toContain("Summarise this");
    expect(lastTurn?.content).toContain("Attached document context:");
    expect(lastTurn?.content).toContain("spec.md");
    expect(lastTurn?.content).toContain("Some document content.");
  });

  // Issue #502 — a selected discussion mode threads the additive directive block onto the latest
  // user turn for the model call. The mode is turn-local (never persisted to chat history).
  it("threads the discussion directive block onto the latest user turn for the model call", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Should we ship this?",
        discussionMode: "challenge",
      }),
    });
    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as { messages: { role: string; content: string }[] };
    // The persisted user bubble keeps the raw draft (mode is not part of chat history).
    expect(body.messages[0]).toMatchObject({ role: "user", content: "Should we ship this?" });
    const lastTurn = seenRequests[0]?.messages.at(-1);
    expect(lastTurn?.role).toBe("user");
    // Assert the turn STARTS WITH the exact rendered block (not merely contains a snippet), so a
    // template rewording or a truncated block is caught.
    expect(lastTurn?.content.startsWith(composeDiscussionDirectiveBlock("challenge"))).toBe(true);
    expect(lastTurn?.content).toContain("Should we ship this?");
    // The directive block precedes the draft (additive block, system prompt untouched).
    const headerIdx = lastTurn?.content.indexOf("Discussion mode directives:") ?? -1;
    const draftIdx = lastTurn?.content.indexOf("Should we ship this?") ?? -1;
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(draftIdx).toBeGreaterThan(headerIdx);
  });

  it("ignores an unknown discussionMode value (no block, send still succeeds)", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "plain question",
        discussionMode: "not-a-real-mode",
      }),
    });
    expect(sendRes.status).toBe(200);
    const lastTurn = seenRequests[0]?.messages.at(-1);
    expect(lastTurn?.content).not.toContain("Discussion mode directives:");
    // With no mode, no docs, and no memory the latest turn stays the bare draft (backward-compatible).
    expect(lastTurn).toEqual({ role: "user", content: "plain question" });
  });

  it("sends no directive block when discussionMode is omitted (backward-compatible default)", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "no mode here",
      }),
    });
    expect(sendRes.status).toBe(200);
    const lastTurn = seenRequests[0]?.messages.at(-1);
    expect(lastTurn?.content).not.toContain("Discussion mode directives:");
  });

  // Issue #502 — the directive block is turn-LOCAL: it is composed only onto the latest user turn for
  // the current send. When an earlier history turn has the SAME text as the current draft, only the
  // latest turn may carry the block; the identical earlier turn must stay the bare draft (so a naive
  // text-match projection cannot leak the block onto a prior message).
  it("composes the directive block only onto the latest same-text user turn, never an earlier one", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    // First send: same text, NO mode — becomes a verbatim history turn.
    const first = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Should we ship this?",
      }),
    });
    expect(first.status).toBe(200);

    // Second send: SAME text, WITH a mode.
    const second = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "Should we ship this?",
        discussionMode: "decide",
      }),
    });
    expect(second.status).toBe(200);

    // The gateway request for the SECOND send carries both user turns.
    const secondRequest = seenRequests.at(-1);
    const userTurns = (secondRequest?.messages ?? []).filter((message) => message.role === "user");
    expect(userTurns.length).toBe(2);

    const expectedBlock = composeDiscussionDirectiveBlock("decide");
    // Exactly one user turn carries the block — the latest.
    const turnsWithBlock = userTurns.filter((turn) => turn.content.includes(expectedBlock));
    expect(turnsWithBlock.length).toBe(1);
    expect(userTurns.at(-1)?.content.startsWith(expectedBlock)).toBe(true);
    // The earlier same-text turn is the bare draft (no block, no header).
    expect(userTurns[0]?.content).toBe("Should we ship this?");
    expect(userTurns[0]?.content).not.toContain("Discussion mode directives:");
  });

  it("rejects a send with a truncationMarker exceeding 256 bytes", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "hello",
        documentContext: [
          {
            id: "doc-1",
            displayName: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            extractedBytes: 4,
            truncated: true,
            text: "okay",
            truncationMarker: "x".repeat(257),
          },
        ],
      }),
    });
    // The oversized marker causes the entry to be dropped; with no valid document
    // context the send still succeeds (documentContext is optional), but the model
    // receives no document block — the prompt must not contain the marker payload.
    expect(sendRes.status).toBe(200);
    const lastTurn = seenRequests[0]?.messages.at(-1);
    expect(lastTurn?.content).not.toContain("x".repeat(257));
  });

  // PR #367 review (HIGH): the text-bytes cap previously used `string.length`, which counts
  // UTF-16 code units. A multi-byte UTF-8 payload (each "漢" = 1 unit but 3 bytes) can blow past
  // the 64 KiB MAX_DOCUMENT_CONTEXT_TEXT_BYTES while `length` stays under the cap. The fixed
  // server measures `Buffer.byteLength(..., "utf8")`, so this entry must be dropped.
  it("rejects a documentContext entry whose UTF-8 byte length exceeds the cap despite small string length", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    // "漢字" is 6 UTF-8 bytes but 2 UTF-16 code units. Repeating it 11_000 times yields
    // 22_000 code units (≈ 66 KiB UTF-8) — just over the 64 KiB MAX_DOCUMENT_CONTEXT_TEXT_BYTES
    // cap (so the byte check rejects it), yet `text.length` (22_000) is comfortably below it,
    // and the JSON envelope stays under the 128 KiB request-body limit.
    const multiByteText = "漢字".repeat(11_000);
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "hello",
        documentContext: [
          {
            id: "doc-1",
            displayName: "kanji.txt",
            mimeType: "text/plain",
            sizeBytes: 100_000,
            extractedBytes: 100_000,
            truncated: false,
            text: multiByteText,
          },
        ],
      }),
    });
    // Malformed entry dropped → send still succeeds, but the prompt MUST NOT contain
    // the kanji payload (the document block was not emitted).
    expect(sendRes.status).toBe(200);
    const lastTurn = seenRequests[0]?.messages.at(-1);
    expect(lastTurn?.content).not.toContain("漢字");
  });

  // PR #367 review (HIGH): sizeBytes / extractedBytes were only checked `>= 0`. A non-integer
  // value such as 1.5 survives JSON round-trip and previously slipped through. The fixed server
  // enforces Number.isInteger so the entry is dropped. (NaN/Infinity become null via JSON.stringify
  // and are already rejected by the earlier `typeof value === "number"` gate — this test pins
  // the integer-only guard, which is the missing one.)
  it("rejects a documentContext entry whose extractedBytes is a non-integer (1.5)", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "hello",
        documentContext: [
          {
            id: "doc-bad-bytes",
            displayName: "bad-bytes.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            extractedBytes: 1.5,
            truncated: false,
            text: "okay",
          },
        ],
      }),
    });
    // Entry dropped; send still succeeds without a document block.
    expect(sendRes.status).toBe(200);
    const lastTurn = seenRequests[0]?.messages.at(-1);
    expect(lastTurn?.content).not.toContain("bad-bytes.txt");
  });

  // ─── Issue #149 — server-side modality guardrails ───────────────────────────────
  //
  // The validator runs BEFORE the model adapter is invoked. AC#4 requires that the gateway is
  // never called when validation fails — these tests assert the model port spy receives zero
  // calls on every rejection path. AC#3 requires error messages are safe for browser display;
  // we assert the four typed error codes flow through to the wire shape and contain no value
  // echo from the caller's payload.

  it("rejects a send when the selected model is an embedding model with CONVERSATION_UNAVAILABLE_MODEL", async () => {
    const modelId = "example-embed";
    const embedConfig: GatewayConfig = {
      ...customModelConfig(modelId),
      capabilities: [
        {
          id: modelId,
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
    // Bootstrap a chat that pre-records its selected model as the chat default; we then send
    // with modelId override pointing at the embedding model so the validator catches it.
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    // Restart server with the embedding-only config wired so chatCapability resolves to embedding.
    await restartWithDeps(deps(fakeModel("nope"), { config: embedConfig, configPresent: true }));

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId,
        content: "hi",
      }),
    });
    // modelId rejected at the existing chat-kind check (returns BAD_REQUEST), which already
    // prevents the gateway call. The validator's CONVERSATION_UNAVAILABLE_MODEL surface fires
    // when the embedding model passes the earlier check by being the chat's stored selection —
    // covered by the explicit-modelId path in the next test.
    expect(sendRes.status).toBe(400);
    expect(seenRequests).toHaveLength(0);
  });

  it("rejects a send with an image attachment when the model is text-only with CONVERSATION_UNSUPPORTED_MODALITY", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "look at this",
        attachments: [{ kind: "image", mimeType: "image/png", sizeBytes: 1024 }],
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("CONVERSATION_UNSUPPORTED_MODALITY");
    // AC#4: gateway NEVER called on a failed validation.
    expect(seenRequests).toHaveLength(0);
  });

  it("rejects a send with a document attachment when the model is text-only with CONVERSATION_UNSUPPORTED_MODALITY", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "read this",
        attachments: [{ kind: "document", mimeType: "text/plain", sizeBytes: 100 }],
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("CONVERSATION_UNSUPPORTED_MODALITY");
    expect(seenRequests).toHaveLength(0);
  });

  it("rejects a send when the aggregate documentContext exceeds the 256 KiB budget", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    // The per-entry extraction cap is 64 KiB (MAX_DOCUMENT_CONTEXT_TEXT_BYTES). Aggregate
    // budget is 256 KiB = 262_144 — five 60 KiB entries clear the per-entry cap and exceed
    // the aggregate cap (300 KiB total). text payload itself is small; extractedBytes is the
    // budget metric.
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
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "summarise",
        documentContext: entries,
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("CONVERSATION_OVERSIZED_CONTEXT");
    expect(seenRequests).toHaveLength(0);
  });

  it("returns a validation error message that contains no caller-supplied value (model id, file name)", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const distinctiveFilename = "secret-confidential-attachment-xyz.png";
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "look",
        attachments: [
          { kind: "image", mimeType: "image/png", sizeBytes: 1024, name: distinctiveFilename },
        ],
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("CONVERSATION_UNSUPPORTED_MODALITY");
    expect(body.error?.message ?? "").not.toContain(distinctiveFilename);
    expect(body.error?.message ?? "").not.toContain(CHAT_MODEL);
    expect(seenRequests).toHaveLength(0);
  });

  it("ignores an attachment entry whose sizeBytes is a decimal (non-integer) instead of rejecting the send", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "hello",
        // sizeBytes: 1024.5 is a non-integer — the entry must be silently dropped.
        attachments: [{ kind: "image", mimeType: "image/png", sizeBytes: 1024.5 }],
      }),
    });
    // The malformed entry is dropped; with no valid attachment the send still succeeds.
    expect(sendRes.status).toBe(200);
    // Gateway was called once (the message content went through).
    expect(seenRequests).toHaveLength(1);
  });

  // Issue #623 — POST /api/desktop/chat returned 500 when projectPath failed path validation.
  // The validateProjectPath throw was uncaught; now it is caught and mapped to the typed 400 envelope.
  it("returns 400 with a typed error code (not 500) when projectPath is a traversal path", async () => {
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: "any-chat-id",
        projectPath: "/valid/../traversal",
        modelId: CHAT_MODEL,
        content: "hello",
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_path");
    expect(seenRequests).toHaveLength(0);
  });

  it("returns 400 with a typed error code (not 500) when projectPath is a relative path", async () => {
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: "any-chat-id",
        projectPath: "relative/path",
        modelId: CHAT_MODEL,
        content: "hello",
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_path");
    expect(seenRequests).toHaveLength(0);
  });

  it("returns 400 with a typed error code (not 500) when projectPath is a file:// URL", async () => {
    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: "any-chat-id",
        projectPath: "file:///etc/passwd",
        modelId: CHAT_MODEL,
        content: "hello",
      }),
    });
    expect(sendRes.status).toBe(400);
    const body = (await sendRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_path");
    expect(seenRequests).toHaveLength(0);
  });

  // Issue #631 (CWE-200/209) — model output must be redacted before it is persisted and before
  // it reaches the browser. A model that echoes a secret (e.g. an API key injected via system
  // prompt) MUST NOT appear un-redacted in the persisted assistant message or the response body.
  it("redacts secret-shaped content in the model response before persisting and before returning it", async () => {
    const secretValue = "test-config-secret-value-1234567890";
    await restartWithDeps(
      deps(fakeModel(`Here is your key: ${secretValue} — enjoy!`), {
        // Wire a redactor that replaces the known secret with a placeholder, mirroring
        // buildRedactor behaviour when an apiKey is present in the gateway config.
        redactor: (value: unknown) =>
          typeof value === "string" ? value.replaceAll(secretValue, "[REDACTED]") : value,
      }),
    );

    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "What is my API key?",
      }),
    });

    expect(sendRes.status).toBe(200);
    const body = (await sendRes.json()) as {
      messages: { role: string; content: string }[];
    };

    // Success response body must not expose the secret.
    const assistantBody = body.messages.find((m) => m.role === "assistant");
    expect(assistantBody?.content).not.toContain(secretValue);
    expect(assistantBody?.content).toContain("[REDACTED]");

    // Persisted assistant message must also be redacted.
    const persisted = store.listMessages(created.chat.id);
    const persistedAssistant = persisted.find((m) => m.role === "assistant");
    expect(persistedAssistant?.content).not.toContain(secretValue);
    expect(persistedAssistant?.content).toContain("[REDACTED]");
  });

  it("ignores malformed documentContext entries instead of rejecting the send", async () => {
    const createRes = await fetch(`${base()}/api/desktop/chats`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
    });
    const created = (await createRes.json()) as { chat: { id: string } };

    const sendRes = await fetch(`${base()}/api/desktop/chat`, {
      method: "POST",
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({
        chatId: created.chat.id,
        projectPath: projectDir,
        modelId: CHAT_MODEL,
        content: "hello",
        documentContext: [
          // missing required fields → must be silently dropped
          { id: "bad" },
          // good entry survives
          {
            id: "doc-1",
            displayName: "ok.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            extractedBytes: 4,
            truncated: false,
            text: "okay",
          },
        ],
      }),
    });
    expect(sendRes.status).toBe(200);
    const lastTurn = seenRequests[0]?.messages.at(-1);
    expect(lastTurn?.content).toContain("ok.txt");
    expect(lastTurn?.content).not.toContain("[bad]");
  });
});
