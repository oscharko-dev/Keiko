// #204 — semantic memory retrieval, end-to-end through the desktop chat route.
//
// Proves the live-verified gap is closed: a memory with ZERO lexical overlap with the query is
// surfaced because its stored embedding is cosine-close to the query embedding. Also pins the two
// graceful-degradation guarantees:
//   - no embedding-capable model configured  -> lexical path, byte-identical to today
//   - query embedding succeeds but a candidate has no stored vector -> that candidate scores 0
//
// The gateway is driven by an injected embedding adapter that returns a controllable vector per
// input string, so the test owns the entire similarity geometry without a network call.

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
  NormalizedResponse,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  createMemoryVault,
  type MemoryEmbeddingInput,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";

const POST_JSON_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const CHAT_MODEL = "example-chat-model";
const EMBEDDING_MODEL = "text-embedding-3-large";
const DIMENSIONS = 8;

let server: Server;
let port: number;
let staticRoot: string;
let tmp: string;
let projectDir: string;
let store: UiStore;

function fakeModel(content: string): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      return Promise.resolve({
        modelId: request.modelId,
        content,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "semantic-test",
          promptTokens: 7,
          completionTokens: 3,
          latencyMs: 11,
          costClass: "high",
        },
      });
    },
  };
}

// Deterministic one-hot vector per "concept" so cosine is exactly 1 for the same concept and 0
// across concepts. The query maps to the same concept as the memory we expect to surface.
const CONCEPT_AXIS = { product: 0, weather: 1, query: 0 } as const;

function vectorFor(text: string): Float32Array {
  const axis =
    text.includes("Produkt") || text.includes("Keiko")
      ? CONCEPT_AXIS.query
      : text.includes("weather")
        ? CONCEPT_AXIS.weather
        : CONCEPT_AXIS.product;
  const v = new Float32Array(DIMENSIONS);
  v[axis] = 1;
  return v;
}

function embeddingAdapter(): (req: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  return (req) =>
    Promise.resolve({
      ok: true as const,
      value: { vector: vectorFor(req.input), modelId: EMBEDDING_MODEL },
    });
}

function countingEmbeddingAdapter(
  calls: string[],
): (req: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  return (req) => {
    calls.push(req.input);
    return Promise.resolve({
      ok: true as const,
      value: { vector: vectorFor(req.input), modelId: EMBEDDING_MODEL },
    });
  };
}

function embeddingConfig(includeEmbeddingModel: boolean): GatewayConfig {
  const providers = [
    {
      modelId: CHAT_MODEL,
      baseUrl: "https://provider.example/v1",
      apiKey: "test-config-secret-value-1234567890",
      timeoutMs: 30_000,
      maxRetries: 0,
      retryBaseDelayMs: 500,
    },
    ...(includeEmbeddingModel
      ? [
          {
            modelId: EMBEDDING_MODEL,
            baseUrl: "https://provider.example/v1",
            apiKey: "test-config-secret-value-1234567890",
            timeoutMs: 30_000,
            maxRetries: 0,
            retryBaseDelayMs: 500,
          },
        ]
      : []),
  ];
  return {
    providers,
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

function deps(overrides: Partial<UiHandlerDeps>, includeEmbeddingModel: boolean): UiHandlerDeps {
  return {
    config: embeddingConfig(includeEmbeddingModel),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => fakeModel("assistant reply"),
    store,
    ...(includeEmbeddingModel ? { localKnowledgeEmbeddingRequest: embeddingAdapter() } : {}),
    ...overrides,
  };
}

function base(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function memoryUserId(value: string): MemoryUserId {
  const raw: unknown = value;
  return raw as MemoryUserId;
}

function insertAccepted(vault: MemoryVaultStore, id: string, body: string): MemoryRecord {
  const now = Date.now();
  const scope: MemoryScope = { kind: "user", userId: memoryUserId("local-operator") };
  const record: MemoryRecord = {
    id: id as MemoryId,
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
  };
  return vault.insertMemory(record);
}

function storeEmbedding(vault: MemoryVaultStore, id: string, text: string): void {
  const input: MemoryEmbeddingInput = {
    provider: "openai",
    modelId: EMBEDDING_MODEL,
    metric: "cosine",
    vector: vectorFor(text),
  };
  vault.upsertEmbedding(id as MemoryId, input);
}

async function restart(handlerDeps: UiHandlerDeps): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
}

interface SendResult {
  readonly memory?: {
    readonly context: { readonly memories: { readonly memoryId: string }[] };
  };
}

async function sendChat(
  chatId: string,
  content: string,
  memory: Record<string, unknown> = { enabled: true, context: {} },
): Promise<SendResult> {
  const res = await fetch(`${base()}/api/desktop/chat`, {
    method: "POST",
    headers: POST_JSON_HEADERS,
    body: JSON.stringify({
      chatId,
      projectPath: projectDir,
      modelId: CHAT_MODEL,
      content,
      memory,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SendResult;
}

async function createChat(): Promise<string> {
  const res = await fetch(`${base()}/api/desktop/chats`, {
    method: "POST",
    headers: POST_JSON_HEADERS,
    body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
  });
  const body = (await res.json()) as { chat: { id: string } };
  return body.chat.id;
}

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-sem-static-"));
  tmp = mkdtempSync(join(tmpdir(), "keiko-sem-"));
  projectDir = join(tmp, "repo");
  mkdirSync(projectDir);
  store = createInMemoryUiStore();
  store.createProject(projectDir, "repo");
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  port = (server.address() as AddressInfo).port;
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

describe("semantic memory retrieval (#204)", () => {
  it("surfaces a memory by embedding similarity with no lexical overlap with the query", async () => {
    const memoryDir = join(tmp, "vault-semantic");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    // English-canonicalized fact; German query "Wie heißt mein Produkt" shares NO tokens with it.
    insertAccepted(vault, "mem-product", "The user is building a product named Keiko");
    storeEmbedding(vault, "mem-product", "The user is building a product named Keiko");
    insertAccepted(vault, "mem-weather", "a completely unrelated note about the weather");
    storeEmbedding(vault, "mem-weather", "a completely unrelated note about the weather");
    await restart(deps({ memoryVault: vault }, true));

    const chatId = await createChat();
    const result = await sendChat(chatId, "Wie heißt mein Produkt");

    const ids = result.memory?.context.memories.map((m) => m.memoryId) ?? [];
    expect(ids).toContain("mem-product");
    expect(ids[0]).toBe("mem-product");
    vault.close();
  });

  it("ranks purely lexically when no embedding model is configured (graceful degradation)", async () => {
    const memoryDir = join(tmp, "vault-no-model");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    // mem-lexical lexically matches the query "pnpm installs"; mem-semantic is embedding-close to
    // the query concept but has NO lexical overlap. With NO embedding model, embedMemoryText
    // returns null -> semanticById is undefined -> the ranker is byte-identical to the lexical-only
    // ranker, so the LEXICAL match must win even though the other memory holds a stored vector that
    // would have dominated had the embedding path been active.
    insertAccepted(vault, "mem-lexical", "Always use pnpm installs in this repo");
    insertAccepted(vault, "mem-semantic", "The user is building a product named Keiko");
    storeEmbedding(vault, "mem-semantic", "The user is building a product named Keiko");
    await restart(deps({ memoryVault: vault }, false));

    const chatId = await createChat();
    const result = await sendChat(chatId, "pnpm installs");

    const ids = result.memory?.context.memories.map((m) => m.memoryId) ?? [];
    expect(ids[0]).toBe("mem-lexical");
    vault.close();
  });

  it("still records an access for surfaced memories (reinforcement reflex intact)", async () => {
    const memoryDir = join(tmp, "vault-access");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    insertAccepted(vault, "mem-product", "The user is building a product named Keiko");
    storeEmbedding(vault, "mem-product", "The user is building a product named Keiko");
    await restart(deps({ memoryVault: vault }, true));

    const chatId = await createChat();
    await sendChat(chatId, "Wie heißt mein Produkt");

    const stats = vault.getAccessStats(["mem-product" as MemoryId]);
    expect(stats.get("mem-product" as MemoryId)?.accessCount).toBe(1);
    vault.close();
  });

  it("scores a candidate with no stored vector at 0 without throwing", async () => {
    const memoryDir = join(tmp, "vault-missing-vec");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    // Lexically matching memory WITHOUT an embedding — must still be retrievable on the lexical
    // signal without sending the query to an embedding provider that has no stored vector to compare.
    insertAccepted(vault, "mem-lex", "Keiko product name");
    const embeddingCalls: string[] = [];
    await restart(
      deps(
        {
          memoryVault: vault,
          localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(embeddingCalls),
        },
        true,
      ),
    );

    const chatId = await createChat();
    const result = await sendChat(chatId, "Keiko product name");

    const ids = result.memory?.context.memories.map((m) => m.memoryId) ?? [];
    expect(ids).toContain("mem-lex");
    expect(embeddingCalls).toEqual([]);
    vault.close();
  });

  it("does not embed the query when budgetTokens is zero", async () => {
    const memoryDir = join(tmp, "vault-zero-budget");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    insertAccepted(vault, "mem-package-manager", "Use pnpm for installs");
    const embeddingCalls: string[] = [];
    await restart(
      deps(
        {
          memoryVault: vault,
          localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(embeddingCalls),
        },
        true,
      ),
    );

    const chatId = await createChat();
    const result = await sendChat(chatId, "Which package manager should I use?", {
      enabled: true,
      budgetTokens: 0,
      context: {},
    });

    expect(result.memory?.context.memories).toEqual([]);
    expect(embeddingCalls).toEqual([]);
    vault.close();
  });

  it("does not embed sensitive memory-enabled query text for secondary retrieval ranking", async () => {
    const memoryDir = join(tmp, "vault-sensitive-query");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    insertAccepted(vault, "mem-package-manager", "Use pnpm for installs");
    storeEmbedding(vault, "mem-package-manager", "Use pnpm for installs");
    const embeddingCalls: string[] = [];
    await restart(
      deps(
        {
          memoryVault: vault,
          localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(embeddingCalls),
        },
        true,
      ),
    );

    const chatId = await createChat();
    const result = await sendChat(chatId, "My private support email is dev@example.com; use pnpm?");

    const ids = result.memory?.context.memories.map((m) => m.memoryId) ?? [];
    expect(ids).toContain("mem-package-manager");
    expect(embeddingCalls).toEqual([]);
    vault.close();
  });

  it("does not embed the query when scoped vaults are empty", async () => {
    const memoryDir = join(tmp, "vault-empty-semantic");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    const embeddingCalls: string[] = [];
    await restart(
      deps(
        {
          memoryVault: vault,
          localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(embeddingCalls),
        },
        true,
      ),
    );

    const chatId = await createChat();
    const result = await sendChat(chatId, "Which package manager should I use?");

    expect(result.memory?.context.memories).toEqual([]);
    expect(embeddingCalls).toEqual([]);
    vault.close();
  });

  it("does not embed the query when all scoped memories are suppressed", async () => {
    const memoryDir = join(tmp, "vault-suppressed-semantic");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    const record = insertAccepted(vault, "mem-superseded", "Use yarn for installs");
    vault.updateMemory(record.id, { status: "superseded" }, Date.now() + 1);
    const embeddingCalls: string[] = [];
    await restart(
      deps(
        {
          memoryVault: vault,
          localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(embeddingCalls),
        },
        true,
      ),
    );

    const chatId = await createChat();
    const result = await sendChat(chatId, "Which package manager should I use?");

    expect(result.memory?.context.memories).toEqual([]);
    expect(embeddingCalls).toEqual([]);
    vault.close();
  });
});
