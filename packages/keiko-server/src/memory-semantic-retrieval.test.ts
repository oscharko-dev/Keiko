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
import {
  buildConversationRetrievalSignals,
  semanticRetrievalGateForText,
} from "./memory-retrieval-signals.js";
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
import { memoryEmbeddingProviderIdentity } from "./memory-embedding.js";

const POST_JSON_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const CHAT_MODEL = "example-chat-model";
const EMBEDDING_MODEL = "text-embedding-3-large";
const DIMENSIONS = 8;
const EXTERNAL_EMBEDDING_BASE_URL = "https://provider.example/v1";
const IN_TENANT_EMBEDDING_BASE_URL = "http://127.0.0.1:11434/v1";

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

function embeddingConfig(
  includeEmbeddingModel: boolean,
  embeddingBaseUrl = EXTERNAL_EMBEDDING_BASE_URL,
): GatewayConfig {
  const providers = [
    {
      modelId: CHAT_MODEL,
      baseUrl: EXTERNAL_EMBEDDING_BASE_URL,
      apiKey: "test-config-secret-value-1234567890",
      timeoutMs: 30_000,
      maxRetries: 0,
      retryBaseDelayMs: 500,
    },
    ...(includeEmbeddingModel
      ? [
          {
            modelId: EMBEDDING_MODEL,
            baseUrl: embeddingBaseUrl,
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

function deps(
  overrides: Partial<UiHandlerDeps>,
  includeEmbeddingModel: boolean,
  embeddingBaseUrl = EXTERNAL_EMBEDDING_BASE_URL,
): UiHandlerDeps {
  return {
    config: embeddingConfig(includeEmbeddingModel, embeddingBaseUrl),
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

function storeEmbedding(
  vault: MemoryVaultStore,
  id: string,
  text: string,
  embeddingBaseUrl = EXTERNAL_EMBEDDING_BASE_URL,
): void {
  const provider = embeddingConfig(true, embeddingBaseUrl).providers.find(
    (configured) => configured.modelId === EMBEDDING_MODEL,
  );
  if (provider === undefined) {
    throw new Error("test embedding provider missing");
  }
  const input: MemoryEmbeddingInput = {
    provider: memoryEmbeddingProviderIdentity(provider),
    modelId: EMBEDDING_MODEL,
    metric: "cosine",
    vector: vectorFor(text),
  };
  vault.upsertEmbedding(id as MemoryId, input);
}

function storeIncompatibleEmbedding(vault: MemoryVaultStore, id: string, text: string): void {
  const input: MemoryEmbeddingInput = {
    provider: "legacy-openai",
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

  it("does not surface a semantic-only memory when its stored embedding identity is incompatible", async () => {
    const memoryDir = join(tmp, "vault-incompatible-semantic");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    insertAccepted(vault, "mem-product", "The user is building a product named Keiko");
    storeIncompatibleEmbedding(vault, "mem-product", "The user is building a product named Keiko");
    await restart(deps({ memoryVault: vault }, true));

    const chatId = await createChat();
    const result = await sendChat(chatId, "Wie heißt mein Produkt");

    const ids = result.memory?.context.memories.map((m) => m.memoryId) ?? [];
    expect(ids).not.toContain("mem-product");
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

  it("records access only after the assistant uses a surfaced memory", async () => {
    const memoryDir = join(tmp, "vault-access");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    insertAccepted(vault, "mem-product", "The user is building a product named Keiko");
    storeEmbedding(vault, "mem-product", "The user is building a product named Keiko");
    await restart(
      deps(
        {
          memoryVault: vault,
          modelPortFactory: () => fakeModel("The product is named Keiko."),
        },
        true,
      ),
    );

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

  it("builds semantic candidates from vault metadata instead of full decrypted records", async () => {
    const memoryDir = join(tmp, "vault-metadata-candidates");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    insertAccepted(vault, "mem-product", "The user is building a product named Keiko");
    storeEmbedding(vault, "mem-product", "The user is building a product named Keiko");
    let metadataCalls = 0;
    let fullRecordCalls = 0;
    const spiedVault: MemoryVaultStore = {
      ...vault,
      listMemoryMetadataByScope: (...args) => {
        metadataCalls += 1;
        return vault.listMemoryMetadataByScope(...args);
      },
      listMemoriesByScope: (...args) => {
        fullRecordCalls += 1;
        return vault.listMemoriesByScope(...args);
      },
    };
    const d = deps(
      {
        memoryVault: spiedVault,
        env: {
          KEIKO_MEMORY_EMBEDDING_CALIBRATION: JSON.stringify({
            [EMBEDDING_MODEL]: { mmrLambda: 0.61 },
          }),
        },
      },
      true,
    );
    const query = "Wie heißt mein Produkt";
    const scope: MemoryScope = { kind: "user", userId: memoryUserId("local-operator") };
    const gate = semanticRetrievalGateForText(d, query, {});

    const signals = await buildConversationRetrievalSignals(
      d,
      spiedVault,
      query,
      [scope],
      Date.now(),
      gate,
    );

    expect(signals.semanticById?.get("mem-product" as MemoryId)).toBe(1);
    expect(signals.mmrLambda).toBe(0.61);
    expect(metadataCalls).toBe(1);
    expect(fullRecordCalls).toBe(0);
    vault.close();
  });

  it("bounds the embedding sweep after metadata prefiltering", async () => {
    const memoryDir = join(tmp, "vault-prefilter-candidates");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    for (let i = 0; i < 170; i += 1) {
      insertAccepted(
        vault,
        `mem-prefilter-${String(i).padStart(3, "0")}`,
        `Candidate ${String(i)}`,
      );
    }
    let requestedIds: readonly MemoryId[] = [];
    const spiedVault: MemoryVaultStore = {
      ...vault,
      getEmbeddings: (ids) => {
        requestedIds = ids;
        return vault.getEmbeddings(ids);
      },
    };
    const d = deps({ memoryVault: spiedVault }, true);
    const scope: MemoryScope = { kind: "user", userId: memoryUserId("local-operator") };
    const query = "Which candidate matters?";
    const gate = semanticRetrievalGateForText(d, query, {});

    await buildConversationRetrievalSignals(d, spiedVault, query, [scope], Date.now(), gate);

    expect(requestedIds).toHaveLength(160);
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

  it("allows sensitive query embedding when the embedding provider is in-tenant", async () => {
    const memoryDir = join(tmp, "vault-in-tenant-sensitive-query");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    insertAccepted(vault, "mem-product", "The user is building a product named Keiko");
    storeEmbedding(
      vault,
      "mem-product",
      "The user is building a product named Keiko",
      IN_TENANT_EMBEDDING_BASE_URL,
    );
    const embeddingCalls: string[] = [];
    await restart(
      deps(
        {
          memoryVault: vault,
          localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(embeddingCalls),
        },
        true,
        IN_TENANT_EMBEDDING_BASE_URL,
      ),
    );

    const chatId = await createChat();
    const query = "My private support email is dev@example.com; Wie heißt mein Produkt?";
    const result = await sendChat(chatId, query);

    const ids = result.memory?.context.memories.map((m) => m.memoryId) ?? [];
    expect(ids[0]).toBe("mem-product");
    expect(embeddingCalls).toEqual([query]);
    vault.close();
  });

  it("allows restricted-default semantic retrieval only for in-tenant embedding providers", async () => {
    const scope: MemoryScope = { kind: "user", userId: memoryUserId("local-operator") };
    const query = "restricted policy query";

    const inTenantDir = join(tmp, "vault-restricted-in-tenant");
    mkdirSync(inTenantDir);
    const inTenantVault = createMemoryVault({ memoryDir: inTenantDir, redactString: (v) => v });
    insertAccepted(inTenantVault, "mem-in-tenant", "The user is building a product named Keiko");
    storeEmbedding(
      inTenantVault,
      "mem-in-tenant",
      "The user is building a product named Keiko",
      IN_TENANT_EMBEDDING_BASE_URL,
    );
    const inTenantCalls: string[] = [];
    const inTenantDeps = deps(
      {
        memoryVault: inTenantVault,
        localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(inTenantCalls),
      },
      true,
      IN_TENANT_EMBEDDING_BASE_URL,
    );
    const allowedGate = semanticRetrievalGateForText(inTenantDeps, query, {
      defaultSensitivity: "restricted",
    });
    expect(allowedGate).toEqual({ allowed: true, reason: "allowed" });
    const allowedSignals = await buildConversationRetrievalSignals(
      inTenantDeps,
      inTenantVault,
      query,
      [scope],
      Date.now(),
      allowedGate,
    );
    expect(allowedSignals.semanticById?.get("mem-in-tenant" as MemoryId)).toBe(1);
    expect(inTenantCalls).toEqual([query]);
    inTenantVault.close();

    const externalDir = join(tmp, "vault-restricted-external");
    mkdirSync(externalDir);
    const externalVault = createMemoryVault({ memoryDir: externalDir, redactString: (v) => v });
    insertAccepted(externalVault, "mem-external", "The user is building a product named Keiko");
    storeEmbedding(externalVault, "mem-external", "The user is building a product named Keiko");
    const externalCalls: string[] = [];
    const externalDeps = deps(
      {
        memoryVault: externalVault,
        localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(externalCalls),
      },
      true,
    );
    const blockedGate = semanticRetrievalGateForText(externalDeps, query, {
      defaultSensitivity: "restricted",
    });
    expect(blockedGate).toEqual({ allowed: false, reason: "blocked-by-policy" });
    const blockedSignals = await buildConversationRetrievalSignals(
      externalDeps,
      externalVault,
      query,
      [scope],
      Date.now(),
      blockedGate,
    );
    expect(blockedSignals.semanticById).toBeUndefined();
    expect(externalCalls).toEqual([]);
    externalVault.close();
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
