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

import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  formatActivityLogProofLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { UI_HOST } from "./server.js";
import { defaultServerDiagnosticSink, type ServerDiagnosticRecord } from "./diagnostics-log.js";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import {
  buildConversationRetrievalSignals,
  semanticRetrievalGateForText,
} from "./memory-retrieval-signals.js";
import { startUiTestServer } from "./ui-test-server/_support.js";
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
  MemoryType,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import { memoryEmbeddingProviderIdentity } from "./memory-embedding.js";
import {
  createActivityLogSink,
  createServerLogger,
  setServerLogger,
} from "./observability/index.js";

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

function insertAccepted(
  vault: MemoryVaultStore,
  id: string,
  body: string,
  type: MemoryType = "semantic-fact",
): MemoryRecord {
  const now = Date.now();
  const scope: MemoryScope = { kind: "user", userId: memoryUserId("local-operator") };
  const record: MemoryRecord = {
    id: id as MemoryId,
    schemaVersion: "1",
    scope,
    // A fact, not a preference: preferences reach every answer through the standing profile
    // (#4228), and this fixture proves retrieval by the question.
    type,
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

async function restart(handlerDeps: UiHandlerDeps): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  const started = await startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    handlerDeps,
  });
  server = started.server;
  port = started.port;
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
  staticRoot = mkdtempSync(join(realpathSync(tmpdir()), "keiko-sem-static-"));
  tmp = mkdtempSync(join(realpathSync(tmpdir()), "keiko-sem-"));
  projectDir = join(tmp, "repo");
  mkdirSync(projectDir);
  store = createInMemoryUiStore();
  store.createProject(projectDir, "repo");
  const started = await startUiTestServer({ staticRoot, csp: buildCspHeader([]) });
  server = started.server;
  port = started.port;
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

  it("uses lexical recall without dispatching a query when the embedding provider changes", async () => {
    const memoryDir = join(tmp, "vault-incompatible-semantic");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
    insertAccepted(vault, "mem-product", "The user is building a product named Keiko");
    storeEmbedding(
      vault,
      "mem-product",
      "The user is building a product named Keiko",
      IN_TENANT_EMBEDDING_BASE_URL,
    );
    insertAccepted(vault, "mem-lexical", "Das Produkt erscheint im Frühling.");
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
    const result = await sendChat(chatId, "Wie heißt mein Produkt");

    const ids = result.memory?.context.memories.map((m) => m.memoryId) ?? [];
    expect(ids).toEqual(["mem-lexical"]);
    expect(embeddingCalls).toEqual([]);
    vault.close();
  });

  it.each([
    { query: "pnpm installs", storedVector: true, expectedEvents: 1 },
    { query: "pnpm installs", storedVector: false, expectedEvents: 0 },
    { query: "pnpm installs for dev@example.com", storedVector: true, expectedEvents: 0 },
  ])(
    "ranks lexically without an embedding model (vector=$storedVector, query=$query)",
    async ({ query, storedVector, expectedEvents }) => {
      const memoryDir = join(tmp, "vault-no-model");
      mkdirSync(memoryDir);
      const vault = createMemoryVault({ memoryDir, redactString: (v) => v });
      const sink = createBufferedServerLogSink();
      try {
        insertAccepted(vault, "mem-lexical", "Always use pnpm installs in this repo");
        const content = "The user is building a product named Keiko";
        insertAccepted(vault, "mem-semantic", content);
        if (storedVector) storeEmbedding(vault, "mem-semantic", content);
        const requests: string[] = [];
        await restart(
          deps(
            {
              memoryVault: vault,
              localKnowledgeEmbeddingRequest: countingEmbeddingAdapter(requests),
            },
            false,
          ),
        );
        setServerLogger(createServerLogger({ sink, level: "debug" }));
        const result = await sendChat(await createChat(), query);

        expect(result.memory?.context.memories.map((m) => m.memoryId)).toEqual(["mem-lexical"]);
        expect(requests).toEqual([]);
        const operation = "embedding.memory.unavailable";
        const events = sink.events.filter((entry) => entry.op === operation);
        expect(events).toHaveLength(expectedEvents);
        if (expectedEvents === 1) {
          const line = formatActivityLogProofLine(events[0] ?? {});
          expect(JSON.parse(line)).toMatchObject({
            op: operation,
            level: "debug",
            reason: "no-embedding-capable-model",
            providerCount: 0,
          });
          expect(line).not.toContain(content);
          expect(line).not.toContain(query);
          expect(analyzeLogText(line).clusters).toContainEqual(
            expect.objectContaining({ op: operation, count: 1 }),
          );
        }
      } finally {
        resetServerLogger();
        vault.close();
      }
    },
  );

  it("records only the use, not a reinforcement, after the assistant uses a surfaced memory (#4212)", async () => {
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

    const stats = vault.getAccessStats(["mem-product" as MemoryId]).get("mem-product" as MemoryId);
    expect(stats?.accessCount).toBe(0);
    expect(stats?.lastUsedAt).toBeGreaterThan(0);
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
    const result = await sendChat(chatId, "Which package manager should I use?", {
      enabled: true,
      budgetTokens: 0,
      context: {},
    });

    expect(result.memory?.context.memories).toEqual([]);
    expect(embeddingCalls).toEqual([]);
    vault.close();
  });

  it.each(["profile-only chat", "memory context API"] as const)(
    "does not dispatch an embedding query when %s has zero recall budget",
    async (surface) => {
      const memoryDir = join(tmp, "vault-zero-recall-budget");
      mkdirSync(memoryDir);
      const vault = createMemoryVault({ memoryDir, redactString: (value) => value });
      try {
        insertAccepted(vault, "mem-preference", "Use tabs", "preference");
        storeEmbedding(vault, "mem-preference", "Use tabs");
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
        const queryText = "Which formatting do I use?";
        if (surface === "profile-only chat") {
          const result = await sendChat(chatId, queryText, {
            enabled: true,
            budgetTokens: 3,
            context: {},
          });
          expect(result.memory?.context).toMatchObject({
            memories: [],
            profile: { entries: [{ text: "Use tabs" }], tokens: 3 },
            budget: { tokens: 0, used: 0 },
          });
        } else {
          const response = await fetch(`${base()}/api/memory/context`, {
            method: "POST",
            headers: POST_JSON_HEADERS,
            body: JSON.stringify({ chatId, projectPath: projectDir, queryText, budgetTokens: 0 }),
          });
          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toMatchObject({
            included: [],
            omitted: [],
            budget: { tokens: 0, used: 0 },
          });
        }
        expect(embeddingCalls).toEqual([]);
      } finally {
        vault.close();
      }
    },
  );

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

  it.each([
    {
      scenario: "sensitive query with the external provider selected",
      preferred: EXTERNAL_EMBEDDING_BASE_URL,
      secondary: IN_TENANT_EMBEDDING_BASE_URL,
      query: "My private support email is dev@example.com; Wie heißt mein Produkt?",
      expectedEndpoints: [],
    },
    {
      scenario: "sensitive query with the in-tenant provider selected",
      preferred: IN_TENANT_EMBEDDING_BASE_URL,
      secondary: EXTERNAL_EMBEDDING_BASE_URL,
      query: "My private support email is dev@example.com; Wie heißt mein Produkt?",
      expectedEndpoints: [IN_TENANT_EMBEDDING_BASE_URL],
    },
    {
      scenario: "public query with the external provider selected",
      preferred: EXTERNAL_EMBEDDING_BASE_URL,
      secondary: IN_TENANT_EMBEDDING_BASE_URL,
      query: "Wie heißt mein Produkt?",
      expectedEndpoints: [EXTERNAL_EMBEDDING_BASE_URL],
    },
    {
      scenario: "credential-shaped query with the in-tenant provider selected",
      preferred: IN_TENANT_EMBEDDING_BASE_URL,
      secondary: EXTERNAL_EMBEDDING_BASE_URL,
      query: `Wie heißt mein Produkt? api_key=${["sk-", "abcdefghijklmnopqrstuvwxyz12345"].join("")}`,
      expectedEndpoints: [],
    },
  ])(
    "honors the embedding egress policy for $scenario",
    async ({ preferred, secondary, query, expectedEndpoints }) => {
      const memoryDir = join(tmp, "vault-mixed-embedding-providers");
      mkdirSync(memoryDir);
      const vault = createMemoryVault({ memoryDir, redactString: (value) => value });
      try {
        const content = "The user is building a product named Keiko";
        insertAccepted(vault, "mem-product", content);
        storeEmbedding(vault, "mem-product", content, preferred);
        const config = embeddingConfig(true, preferred);
        const embeddingProvider = config.providers.find(
          (provider) => provider.modelId === EMBEDDING_MODEL,
        );
        if (embeddingProvider === undefined) throw new Error("test embedding provider missing");
        const endpoints: string[] = [];
        const embed = embeddingAdapter();
        await restart(
          deps(
            {
              memoryVault: vault,
              config: {
                ...config,
                providers: [
                  ...config.providers,
                  { ...embeddingProvider, modelId: "text-embedding-auxiliary", baseUrl: secondary },
                ],
              },
              localKnowledgeEmbeddingRequest: (request) => {
                endpoints.push(request.endpoint);
                return embed(request);
              },
            },
            true,
          ),
        );

        await sendChat(await createChat(), query);

        expect(endpoints).toEqual(expectedEndpoints);
      } finally {
        vault.close();
      }
    },
  );

  it("dispatches only when the requested query matches the bound authorization", async () => {
    const memoryDir = join(tmp, "vault-query-binding");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const stateDir = join(tmp, "query-binding-state");
    mkdirSync(stateDir, { mode: 0o700 });
    const sink = createActivityLogSink(stateDir);
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    try {
      const content = "The user is building a product named Keiko";
      const record = insertAccepted(vault, "mem-product", content);
      storeEmbedding(vault, "mem-product", content);
      const requestEmbedding = vi.fn(embeddingAdapter());
      const diagnostics: ServerDiagnosticRecord[] = [];
      const handlerDeps = deps(
        {
          memoryVault: vault,
          localKnowledgeEmbeddingRequest: requestEmbedding,
          diagnostics: {
            record(entry) {
              diagnostics.push(entry);
              defaultServerDiagnosticSink.record(entry);
            },
          },
        },
        true,
      );
      const query = "Wie heißt mein Produkt?";
      const staleGate = semanticRetrievalGateForText(handlerDeps, "Welche Farbe ist es?", {});
      const noMatch = await buildConversationRetrievalSignals(
        handlerDeps,
        vault,
        query,
        [record.scope],
        Date.now(),
        staleGate,
      );
      expect(noMatch.semanticById).toBeUndefined();
      expect(requestEmbedding).not.toHaveBeenCalled();
      const operation = "memory.retrieval.semantic-disabled";
      const diagnostic = diagnostics.find((entry) => entry.operation === operation);
      expect(diagnostic).toMatchObject({ code: "query-mismatch", semanticCandidateCount: 1 });
      expect(diagnostic?.diagnosticOutcome).toBeUndefined();
      sink.flush?.();
      const log = readPersistedActivityLog(stateDir);
      const lines = persistedActivityLogLines(log, "server.diagnostic.failure");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        correlationId: diagnostic?.correlationId,
        level: "error",
        errorKind: "internal",
        diagnosticOperation: operation,
        code: "query-mismatch",
        semanticCandidateCount: 1,
      });
      expect(log).not.toContain(query);
      expect(log).not.toContain("Welche Farbe ist es?");
      const timeline = analyzeLogText(log).timelines.find(
        (entry) => entry.correlationId === diagnostic?.correlationId,
      );
      const failure = timeline?.lines.find((line) => line.op === "server.diagnostic.failure");
      expect(failure).toMatchObject({
        level: "error",
        errorKind: "internal",
        extra: { diagnosticOperation: operation, code: "query-mismatch" },
      });

      const gate = semanticRetrievalGateForText(handlerDeps, query, {});
      const matched = await buildConversationRetrievalSignals(
        handlerDeps,
        vault,
        query,
        [record.scope],
        Date.now(),
        gate,
      );
      expect(matched.semanticById?.get(record.id)).toBe(1);
      expect(requestEmbedding.mock.calls.map(([request]) => request.input)).toEqual([query]);
      expect(requestEmbedding.mock.calls[0]?.[0].signal).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      sink.close?.();
      vault.close();
    }
  });

  it("cancels the in-flight query adapter with the retrieval signal", async () => {
    const memoryDir = join(tmp, "vault-query-cancellation");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (value) => value });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const controller = new AbortController();
    let complete!: (outcome: OpenAIEmbeddingOutcome) => void;
    const pending = new Promise<OpenAIEmbeddingOutcome>((resolve) => {
      complete = resolve;
    });
    const cancelledAtAdapter = vi.fn(() => {
      complete({ ok: false, kind: "cancelled" });
    });
    const requestEmbedding = vi.fn((request: OpenAIEmbeddingRequest) => {
      request.signal?.addEventListener("abort", cancelledAtAdapter, { once: true });
      return pending;
    });
    const diagnostics: ServerDiagnosticRecord[] = [];
    const handlerDeps = deps(
      {
        localKnowledgeEmbeddingRequest: requestEmbedding,
        diagnostics: { record: (entry) => diagnostics.push(entry) },
      },
      true,
    );
    const content = "The user is building a product named Keiko";
    const record = insertAccepted(vault, "mem-product", content);
    storeEmbedding(vault, "mem-product", content);
    const query = "Wie heißt mein Produkt?";
    const gate = semanticRetrievalGateForText(handlerDeps, query, {});
    const result = buildConversationRetrievalSignals(
      handlerDeps,
      vault,
      query,
      [record.scope],
      Date.now(),
      gate,
      controller.signal,
    );
    try {
      await vi.waitFor(() => {
        expect(requestEmbedding).toHaveBeenCalledTimes(1);
      });
      controller.abort();
      expect(cancelledAtAdapter).toHaveBeenCalledTimes(1);
      expect(requestEmbedding.mock.calls[0]?.[0].signal).toBe(controller.signal);
      await expect(result).rejects.toThrow("memory retrieval aborted");
      expect(diagnostics).toEqual([]);
      const failure = sink.events.find((entry) => entry.op === "embedding.memory.failed");
      const line = formatActivityLogProofLine(failure ?? {});
      expect(JSON.parse(line)).toMatchObject({
        op: "embedding.memory.failed",
        errorKind: "cancelled",
        failureKind: "cancelled",
      });
      expect(line).not.toContain(query);
      expect(line).not.toContain(content);
      expect(analyzeLogText(line).clusters).toContainEqual(
        expect.objectContaining({
          op: "embedding.memory.failed",
          errorKind: "cancelled",
          count: 1,
        }),
      );
    } finally {
      complete({ ok: true, value: { vector: vectorFor(query), modelId: EMBEDDING_MODEL } });
      await result.catch(() => undefined);
      resetServerLogger();
      vault.close();
    }
  });

  it("keeps the routine no-embedder fallback when the adapter fails without cancellation", async () => {
    const memoryDir = join(tmp, "vault-query-adapter-timeout");
    mkdirSync(memoryDir);
    const vault = createMemoryVault({ memoryDir, redactString: (value) => value });
    try {
      const content = "The user is building a product named Keiko";
      const record = insertAccepted(vault, "mem-product", content);
      storeEmbedding(vault, "mem-product", content);
      const requestEmbedding = vi.fn((): Promise<OpenAIEmbeddingOutcome> =>
        Promise.resolve({ ok: false, kind: "timeout" }),
      );
      const diagnostics: ServerDiagnosticRecord[] = [];
      const handlerDeps = deps(
        {
          localKnowledgeEmbeddingRequest: requestEmbedding,
          diagnostics: { record: (entry) => diagnostics.push(entry) },
        },
        true,
      );
      const query = "Wie heißt mein Produkt?";
      const result = await buildConversationRetrievalSignals(
        handlerDeps,
        vault,
        query,
        [record.scope],
        Date.now(),
        semanticRetrievalGateForText(handlerDeps, query, {}),
      );
      expect(requestEmbedding).toHaveBeenCalledTimes(1);
      expect(result.semanticById).toBeUndefined();
      expect(diagnostics).toMatchObject([
        {
          operation: "memory.retrieval.semantic-disabled",
          code: "no-embedder",
          diagnosticOutcome: "routine",
        },
      ]);
    } finally {
      vault.close();
    }
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
    expect(allowedGate).toMatchObject({ allowed: true, reason: "allowed" });
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
