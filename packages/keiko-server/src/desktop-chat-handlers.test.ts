// Desktop canvas chat routes: real UI chat persistence with an injected ModelPort, keeping provider
// credentials behind the existing gateway seam and avoiding network calls in tests.

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
import type { GatewayConfig, GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

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
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "local endpoint",
        preferredUseCases: ["Local coding workflow"],
        knownLimitations: [],
      },
    ],
  };
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
});
