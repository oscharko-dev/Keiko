// #4228 — POST /api/memory/context hands the embedding model's semantic floor to retrieval together
// with the semantic scores it judges, and hands none without scores.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { MemoryId, MemoryRecord, MemoryUserId } from "@oscharko-dev/keiko-contracts";
import type { MemoryRetrievalRequest } from "@oscharko-dev/keiko-memory-retrieval";

import type { UiHandlerDeps } from "./index.js";
import type { RouteContext } from "./routes.js";

const { requests, signalsMock } = vi.hoisted(() => ({
  requests: [] as unknown[],
  signalsMock: vi.fn(),
}));

vi.mock("@oscharko-dev/keiko-memory-retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-memory-retrieval")>();
  return {
    ...actual,
    retrieveMemoryContext: (
      ...args: Parameters<typeof actual.retrieveMemoryContext>
    ): ReturnType<typeof actual.retrieveMemoryContext> => {
      requests.push(args[0]);
      return actual.retrieveMemoryContext(...args);
    },
  };
});

vi.mock("./memory-retrieval-signals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-retrieval-signals.js")>();
  return { ...actual, buildConversationRetrievalSignals: signalsMock };
});

const { handleMemoryRetrieveContext } = await import("./memory-conv-handlers.js");
const { buildRedactor, createRunRegistry } = await import("./index.js");
const { createInMemoryUiStore } = await import("./store/index.js");

const tmpDirs: string[] = [];
const vaults: MemoryVaultStore[] = [];

afterEach(() => {
  requests.length = 0;
  signalsMock.mockReset();
  for (const vault of vaults.splice(0)) vault.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(payload: unknown): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage;
  return {
    correlationId: undefined,
    req,
    res: { socket: new Socket() } as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/memory/context"),
  };
}

function setup(): { readonly deps: UiHandlerDeps; readonly body: unknown } {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-conv-floor-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  vaults.push(vault);
  const deps = {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    memoryVault: vault,
  } as UiHandlerDeps;
  const projectPath = mkdtempSync(join(realpathSync(tmpdir()), "keiko-conv-floor-chat-"));
  tmpDirs.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  deps.store.createProject(projectPath, "floor");
  const chat = deps.store.createChat(projectPath, "floor chat", "example-chat-model");
  const now = Date.now();
  const record: MemoryRecord = {
    id: "mem-floor" as unknown as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "local-operator" as unknown as MemoryUserId },
    type: "preference",
    body: "deploys happen on Tuesdays",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  vault.insertMemory(record);
  return { deps, body: { projectPath, chatId: chat.id, queryText: "Which formatter?" } };
}

function lastRequest(): MemoryRetrievalRequest {
  return requests.at(-1) as MemoryRetrievalRequest;
}

describe("POST /api/memory/context semantic floor (#4228)", () => {
  it("passes the floor with the semantic scores to retrieval", async () => {
    const { deps, body } = setup();
    signalsMock.mockResolvedValue({
      strengthById: new Map(),
      embeddingById: new Map(),
      semanticById: new Map([["mem-floor" as unknown as MemoryId, 0.35]]),
      semanticMinScore: 0.4,
    });
    const result = await handleMemoryRetrieveContext(context(body), deps);
    expect(result.status).toBe(200);
    expect(lastRequest().semanticMinScore).toBe(0.4);
    expect(lastRequest().semanticById?.size).toBe(1);
  });

  it("passes no floor field without semantic scores", async () => {
    const { deps, body } = setup();
    signalsMock.mockResolvedValue({ strengthById: new Map(), embeddingById: new Map() });
    const result = await handleMemoryRetrieveContext(context(body), deps);
    expect(result.status).toBe(200);
    expect("semanticMinScore" in lastRequest()).toBe(false);
    expect("semanticById" in lastRequest()).toBe(false);
  });
});
