import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  executeLocalSupportQuery,
} from "@oscharko-dev/keiko-activity-log/reader";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { mockRequest, mockResponse } from "./_support.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "memory-activity-fixture";
const MEMORY = "Use pnpm for package installs.";
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await setImmediate();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

function answerModel(calls: GatewayCallRequest[], markerText: boolean): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      return Promise.resolve({
        modelId: MODEL,
        content: markerText
          ? "The phrase uncited-memory-context is model-authored prose [src/Feature.ts:1]."
          : "Feature returns true [src/Feature.ts:1] [1].",
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

function fixture(
  calls: GatewayCallRequest[],
  scopeCount: number,
  markerText: boolean,
): {
  readonly deps: UiHandlerDeps;
  readonly root: string;
  readonly chatId: string;
  readonly stateDir: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-public-memory-source-")));
  const stateDir = join(root, "activity");
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
  resetServerLogger();
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
  const scopes = Array.from({ length: scopeCount }, (_, index) => String(index)).map((name) => {
    const workspaceRoot = join(root, name);
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "src", "Feature.ts"),
      "export function Feature() { return true; }",
    );
    return {
      kind: "directory" as const,
      root: workspaceRoot,
      relativePaths: ["src"],
      connectedAtMs: 1,
    };
  });
  store.updateChat(chat.id, { connectedScopes: scopes });
  return { root, stateDir, chatId: chat.id, deps: runtimeDeps(store, vault, calls, markerText) };
}

function runtimeDeps(
  store: UiHandlerDeps["store"],
  memoryVault: MemoryVaultStore,
  calls: GatewayCallRequest[],
  markerText: boolean,
): UiHandlerDeps {
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://memory.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      {
        ...createDefaultChatCapability(MODEL),
        contextWindow: 8192,
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
      },
    ],
  });
  return {
    config,
    configPresent: true,
    env: { KEIKO_CONNECTED_FOLLOW_UP_PASSES_MAX: "0" },
    store,
    memoryVault,
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: () => answerModel(calls, markerText),
  };
}

function memoryRoute(root: string, chatId: string, budgetTokens: number | undefined): RouteContext {
  return {
    correlationId: "public-memory-zero-sent-source",
    req: mockRequest({
      body: JSON.stringify({
        chatId,
        content: "Explain Feature and its package manager preference.",
        ...(budgetTokens === undefined
          ? {}
          : {
              memory: {
                enabled: true,
                budgetTokens,
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
    }),
    res: mockResponse().res,
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

async function connectReadyPod(deps: UiHandlerDeps, chatId: string): Promise<UiHandlerDeps> {
  const chat = deps.store.findChatById(chatId);
  if (chat === undefined) throw new TypeError("Missing connected chat");
  const runtimeStateDir = join(chat.projectPath, "runtime");
  const store = openKnowledgeStore({ dbPath: resolveKnowledgeStorePath({ runtimeStateDir }) });
  try {
    const pod = await seedCapsuleWithVectors(store, { displayName: "Declaration membership" });
    updateCapsuleState(store, pod.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
  return { ...deps, uiDbPath: join(runtimeStateDir, "keiko-ui.db") };
}

function persistedMemoryObservation(
  stateDir: string,
  expected: {
    uncitedMemoryContextMarkerCount: number;
    memoryContextDisposition: "included" | "excluded" | "not-requested";
  },
): Record<string, unknown> {
  resetServerLogger();
  const raw = readPersistedActivityLog(stateDir);
  const lines = persistedActivityLogLines(raw, "chat.response.message");
  expect(lines).toHaveLength(1);
  const event = expectActivityLogProof("chat.response.message.causality", lines[0] ?? "");
  const { result } = executeLocalSupportQuery(
    stateDir,
    { kind: "events", queryClass: "operation", filter: { op: "chat.response.message" } },
    DEFAULT_SUPPORT_QUERY_LIMITS,
    { trigger: "query" },
  );
  expect(result.events).toHaveLength(1);
  expect(event).toMatchObject(expected);
  expect(result.events[0]?.parsed.view.extra).toMatchObject(expected);
  expect(raw).not.toContain(MEMORY);
  return event;
}

it.each([
  { scopes: 1, hybrid: false, budget: 1200 },
  { scopes: 2, hybrid: false, budget: 1200 },
  { scopes: 1, hybrid: true, budget: 1200 },
  { scopes: 1, hybrid: false, budget: 1 },
  { scopes: 2, hybrid: false, budget: 1 },
  { scopes: 1, hybrid: true, budget: 1 },
])(
  "logs final governed memory across $scopes scopes (hybrid: $hybrid, budget: $budget)",
  async ({ scopes, hybrid, budget }) => {
    const calls: GatewayCallRequest[] = [];
    const { deps, root, chatId, stateDir } = fixture(calls, scopes, false);
    const result = await handleGroundedAsk(
      memoryRoute(root, chatId, budget),
      hybrid ? await connectReadyPod(deps, chatId) : deps,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const answer = result.body as GroundedAnswer;
    const markers = answer.uncertainty.filter((marker) => marker.kind === "uncited-memory-context");
    expect(markers.length > 0).toBe(budget === 1200);
    persistedMemoryObservation(stateDir, {
      uncitedMemoryContextMarkerCount: markers.length,
      memoryContextDisposition: budget === 1200 ? "included" : "excluded",
    });
  },
);

it("does not mistake model-authored marker prose for governed memory inclusion", async () => {
  const { deps, root, chatId, stateDir } = fixture([], 1, true);
  const result = await handleGroundedAsk(memoryRoute(root, chatId, undefined), deps);
  expect(result.status).toBe(200);
  expect((result.body as GroundedAnswer).content).toContain("uncited-memory-context");
  persistedMemoryObservation(stateDir, {
    uncitedMemoryContextMarkerCount: 0,
    memoryContextDisposition: "not-requested",
  });
});
