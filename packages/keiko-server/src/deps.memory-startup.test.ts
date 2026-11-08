import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryStorageError, resolveMemoryDbPath } from "@oscharko-dev/keiko-memory-vault";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { buildUiHandlerDeps } from "./deps.js";
import * as memoryHandlers from "./memory-handlers.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { API_ROUTES, type RouteContext } from "./routes.js";
import { handleSendDesktopChat } from "./chat-handlers.js";
import { mockRequest, mockResponse } from "./_support.js";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  seedBrokenV12MemoryVault,
  memoryMigrationSnapshot,
} from "../../../tests/support/memory-migration-fixture.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  resetServerLogger();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "keiko-withheld-memory-")));
  directories.push(path);
  return path;
}

it("withholds a classified Memory migration failure without stopping the dependency graph", async () => {
  vi.spyOn(memoryHandlers, "createBffMemoryVault").mockImplementation(() => {
    throw new MemoryStorageError(
      "vault-migration-failed",
      "The memory vault could not be migrated.",
    );
  });
  const diagnostics: ServerDiagnosticRecord[] = [];
  const deps = buildUiHandlerDeps({
    env: { KEIKO_STATE_DIR: directory() },
    configPath: undefined,
    evidenceDir: directory(),
    diagnostics: {
      record: (event): void => {
        diagnostics.push(event);
      },
    },
    store: createInMemoryUiStore(),
  });
  try {
    expect(deps.memoryVault).toBeUndefined();
    expect(deps.memoryAuthorization).toBeUndefined();
    expect(deps.memoryReadiness).toEqual({
      readiness: "withheld",
      reason: "vault-migration-failed",
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({ source: "memory-vault.open", code: "vault-migration-failed" }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/SELECT|ALTER|no such column/iu);
  } finally {
    await deps.dispose?.();
  }
});

it("propagates an unrelated Memory factory TypeError instead of reporting a withheld vault", () => {
  const failure = new TypeError("Synthetic unrelated factory failure");
  vi.spyOn(memoryHandlers, "createBffMemoryVault").mockImplementation(() => {
    throw failure;
  });
  const store = createInMemoryUiStore();
  try {
    expect(() =>
      buildUiHandlerDeps({
        env: { KEIKO_STATE_DIR: directory() },
        configPath: undefined,
        evidenceDir: directory(),
        store,
      }),
    ).toThrow(failure);
  } finally {
    store.close();
  }
});

it("reports withheld Memory in health and completes a Chat turn after a real V13 migration failure", async () => {
  const root = directory();
  const memoryPath = resolveMemoryDbPath(root);
  seedBrokenV12MemoryVault(memoryPath);
  const before = memoryMigrationSnapshot(memoryPath);
  const deps = buildUiHandlerDeps({
    env: {
      KEIKO_STATE_DIR: root,
      KEIKO_MEMORY_DIR: root,
      KEIKO_MEMORY_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    configPath: undefined,
    evidenceDir: directory(),
    store: createInMemoryUiStore(),
  });
  try {
    const ctx: RouteContext = {
      req: mockRequest(),
      res: mockResponse().res,
      params: {},
      correlationId: "withheld-memory-health",
      url: new URL("http://localhost/api/health"),
    };
    const health = API_ROUTES.find((route) => route.pattern === "/api/health");
    if (health === undefined) throw new TypeError("Missing health route");
    expect(await health.handler(ctx, deps)).toMatchObject({
      status: 200,
      body: {
        status: "ok",
        memory: { readiness: "withheld", reason: "vault-migration-failed" },
      },
    });
    const modelId = "memory-withheld-chat";
    deps.store.createProject(root);
    const chat = deps.store.createChat(root, "Chat without Memory", modelId);
    const config = parseGatewayConfig({
      providers: [
        { modelId, baseUrl: "https://model.example.invalid/v1", apiKey: "synthetic-unused" },
      ],
      capabilities: [{ ...createDefaultChatCapability(modelId), toolCalling: false }],
    });
    const result = await handleSendDesktopChat(
      {
        ...ctx,
        req: mockRequest({
          body: JSON.stringify({ projectPath: root, chatId: chat.id, modelId, content: "Hello" }),
        }),
      },
      {
        ...deps,
        config,
        configPresent: true,
        gatewayConfig: undefined,
        modelPortFactory: (): ModelPort => ({
          call: (request) =>
            Promise.resolve({
              modelId: request.modelId,
              content: "Chat remains available.",
              finishReason: "stop",
              toolCalls: [],
              structuredOutput: null,
              usage: {
                requestId: "withheld-memory-model",
                promptTokens: 1,
                completionTokens: 4,
                latencyMs: 1,
                costClass: "low",
              },
            }),
        }),
      },
    );
    expect(result).toMatchObject({ status: 200 });
    expect(JSON.stringify(result.body)).toContain("Chat remains available.");
    expect(memoryMigrationSnapshot(memoryPath)).toEqual(before);
  } finally {
    await deps.dispose?.();
  }
});
