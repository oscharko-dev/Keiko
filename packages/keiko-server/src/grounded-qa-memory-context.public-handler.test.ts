import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { MemoryUserId } from "@oscharko-dev/keiko-contracts";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createRunRegistry } from "./runs.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import type { RouteContext } from "./routes.js";
import * as multiSourceQa from "./grounded-qa-multi-source.js";
import { mockRequest, mockResponse } from "./_support.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "memory-source-fixture";
const MEMORY = "Use pnpm for package installs.";
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await setImmediate();
  vi.restoreAllMocks();
  resetServerLogger();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function seedMemory(vault: MemoryVaultStore): void {
  const now = Date.now();
  vault.insertMemory({
    id: "memory-source-preference" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "local-operator" as MemoryUserId },
    type: "preference",
    body: MEMORY,
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

function answerModel(calls: GatewayCallRequest[]): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      return Promise.resolve({
        modelId: MODEL,
        content: MEMORY,
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "memory-with-zero-sent-source",
          promptTokens: 30,
          completionTokens: 7,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
}

function fixture(calls: GatewayCallRequest[]): {
  readonly deps: UiHandlerDeps;
  readonly root: string;
  readonly chatId: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-public-memory-source-")));
  const store = createInMemoryUiStore();
  const memoryDir = join(root, "memory");
  mkdirSync(memoryDir);
  const vault = createMemoryVault({ memoryDir, redactString: (text) => text });
  cleanups.push(() => {
    vault.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  seedMemory(vault);
  store.createProject(root, "Memory source exception");
  const chat = store.createChat(root, "Memory source exception", MODEL);
  const scopes = ["first", "second"].map((name) => {
    const workspaceRoot = join(root, name);
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    return {
      kind: "directory" as const,
      root: workspaceRoot,
      relativePaths: ["src"],
      connectedAtMs: 1,
    };
  });
  store.updateChat(chat.id, { connectedScopes: scopes });
  return { root, chatId: chat.id, deps: runtimeDeps(store, vault, calls) };
}

function runtimeDeps(
  store: UiHandlerDeps["store"],
  memoryVault: MemoryVaultStore,
  calls: GatewayCallRequest[],
): UiHandlerDeps {
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://memory.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [createDefaultChatCapability(MODEL)],
  });
  return {
    config,
    configPresent: true,
    env: {},
    store,
    memoryVault,
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: () => answerModel(calls),
  };
}

function memoryRoute(root: string, chatId: string, content: string): RouteContext {
  return {
    correlationId: "public-memory-zero-sent-source",
    req: mockRequest({
      body: JSON.stringify({
        chatId,
        content,
        memory: {
          enabled: true,
          budgetTokens: 1200,
          mode: "governed-assist",
          context: {
            userId: "local-operator",
            workspaceId: root,
            projectId: root,
            conversationId: chatId,
          },
        },
      }),
    }),
    res: mockResponse().res,
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

it("forwards actual governed memory authority through the public plural handler with zero fitted folder evidence", async () => {
  const calls: GatewayCallRequest[] = [];
  const { deps, root, chatId } = fixture(calls);
  const factory = vi.spyOn(multiSourceQa, "createMultiSourceAnswerer");
  const content = "Which package manager should I use for installs?";
  const result = await handleGroundedAsk(memoryRoute(root, chatId, content), deps);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const synthesis = calls.filter(
    (request) => request.logContext?.correlationId === "public-memory-zero-sent-source",
  );
  expect(synthesis).toHaveLength(1);
  expect(factory.mock.calls[0]?.[5]).toEqual({
    currentQuestion: content,
    answerOnlyContextAvailable: true,
  });

  expect(synthesis[0]?.messages.map((message) => message.content).join("\n")).toContain(MEMORY);
  const answer = result.body as GroundedAnswer;
  if (answer.groundingKind !== "connected-context")
    throw new TypeError("Expected connected answer");
  expect(answer.content).toBe(MEMORY);
  expect(answer.promptContext?.sentReferenceCount).toBe(0);
  expect(answer.contextPack.filesInPrompt).toBe(0);
  expect(answer.citations).toEqual([]);
  expect(answer.evidenceRunIds).toEqual([]);
  expect(answer.uncertainty.map((marker) => marker.kind)).toContain("uncited-memory-context");
  for (const runId of deps.evidenceStore.list())
    expect(JSON.parse(deps.evidenceStore.get(runId) ?? "null")).not.toHaveProperty(
      "connectedContext",
    );
});
