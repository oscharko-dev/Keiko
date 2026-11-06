import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { MemoryUserId } from "@oscharko-dev/keiko-contracts";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { PROMPT_COMPACTION_SYSTEM } from "./chat-prompt-compaction.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createRunRegistry } from "./runs.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import type { RouteContext } from "./routes.js";
import { mockRequest, mockResponse } from "./_support.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

// A grounded prompt too long for the model is compacted before the answer: a model summary
// replaces the person's text in the answer prompt. Learning and recall must still read what the
// person wrote, never that summary, or a fact the person did not state could be learned as theirs.

const MODEL = "memory-learning-fixture";
const OWN_WORDS = "Ich arbeite für Tabellen immer mit Numbers.";
const SUMMARY = "Zusammenfassung des Modells: Ich nutze Excel für alle Tabellen.";
const MEMORY = "Numbers ist das Programm der Person.";
// The person's words stand in the middle, where the compacted prompt keeps no original fragment.
const FILLER = "Bitte prüfe den Ordner gründlich und vollständig. ".repeat(300);
const CONTENT = `${FILLER}${OWN_WORDS} ${FILLER}Welche Dateien beschreiben den Ordner?`;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await setImmediate();
  vi.restoreAllMocks();
  resetServerLogger();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function response(content: string): NormalizedResponse {
  return {
    modelId: MODEL,
    content,
    toolCalls: [],
    structuredOutput: null,
    finishReason: "stop",
    usage: {
      requestId: "memory-learning-fixture",
      promptTokens: 30,
      completionTokens: 7,
      latencyMs: 1,
      costClass: "medium",
    },
  };
}

function systemOf(request: GatewayCallRequest): string {
  const system = request.messages.find((message) => message.role === "system")?.content;
  return typeof system === "string" ? system : "";
}

function isSalienceCall(request: GatewayCallRequest): boolean {
  return systemOf(request).startsWith("You extract few durable facts about the person");
}

function scriptedModel(calls: GatewayCallRequest[]): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      if (systemOf(request) === PROMPT_COMPACTION_SYSTEM) return Promise.resolve(response(SUMMARY));
      if (isSalienceCall(request)) return Promise.resolve(response('{"facts":[]}'));
      return Promise.resolve(response("Numbers passt dafür."));
    },
  };
}

function seedMemory(vault: MemoryVaultStore): void {
  const now = Date.now();
  vault.insertMemory({
    id: "memory-numbers" as MemoryId,
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

function fixture(calls: GatewayCallRequest[]): {
  readonly deps: UiHandlerDeps;
  readonly root: string;
  readonly chatId: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-grounded-memory-learning-")));
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
  store.createProject(root, "Grounded memory learning");
  const chat = store.createChat(root, "Grounded memory learning", MODEL);
  const workspaceRoot = join(root, "folder");
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  store.updateChat(chat.id, {
    connectedScopes: [
      { kind: "directory", root: workspaceRoot, relativePaths: ["src"], connectedAtMs: 1 },
    ],
  });
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://memory.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [{ ...createDefaultChatCapability(MODEL), contextWindow: 4_096 }],
  });
  const deps: UiHandlerDeps = {
    config,
    configPresent: true,
    env: {},
    store,
    memoryVault: vault,
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: () => scriptedModel(calls),
  };
  return { root, chatId: chat.id, deps };
}

function groundedRoute(root: string, chatId: string, content: string): RouteContext {
  return {
    correlationId: "grounded-memory-learning",
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

function texts(requests: readonly GatewayCallRequest[], role: "user" | "system"): string {
  return requests
    .flatMap((request) => request.messages.filter((message) => message.role === role))
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
}

it("learns from the person's own words when a long grounded prompt was compacted", async () => {
  const calls: GatewayCallRequest[] = [];
  const { deps, root, chatId } = fixture(calls);
  const result = await handleGroundedAsk(groundedRoute(root, chatId, CONTENT), deps);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(calls.some((request) => systemOf(request) === PROMPT_COMPACTION_SYSTEM)).toBe(true);
  await vi.waitFor(() => {
    expect(calls.some(isSalienceCall)).toBe(true);
  });
  const learner = texts(calls.filter(isSalienceCall), "user");
  expect(learner).toContain(OWN_WORDS);
  expect(learner).not.toContain(SUMMARY);
});

it("recalls memory for the person's own words when a long grounded prompt was compacted", async () => {
  const calls: GatewayCallRequest[] = [];
  const { deps, root, chatId } = fixture(calls);
  const result = await handleGroundedAsk(groundedRoute(root, chatId, CONTENT), deps);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const answering = calls.filter(
    (request) => systemOf(request) !== PROMPT_COMPACTION_SYSTEM && !isSalienceCall(request),
  );
  const prompt = `${texts(answering, "system")}\n${texts(answering, "user")}`;
  expect(prompt).toContain(MEMORY);
});
