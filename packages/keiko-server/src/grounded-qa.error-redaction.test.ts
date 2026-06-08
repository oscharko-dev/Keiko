// Issue #154 (GAP-B) — gateway error redaction on the GROUNDED conversation endpoints.
//
// The desktop chat path (conversation-audit.test.ts) already scrubs every GatewayError /
// UiStoreError message through redact() before it reaches errorBody(). This file is the parity
// guard for the grounded conversation family: the single-source folder path, the multi-source
// merge path, and the hybrid (folders + connector) path. Each one resolves a provider error whose
// message echoes the configured provider base URL — a non-pattern secret that GatewayError's own
// construction-time redaction (patterns only) does NOT scrub, so only the BFF boundary's
// currentRedactionSecrets(deps) scrub can remove it. A one-line revert of that scrub leaks the
// base URL to the wire and fails these tests.

import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import {
  AuthenticationError,
  ProviderError,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  seedCapsuleWithVectors,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";

import {
  handleGroundedAsk,
  type GroundedRunner,
  type HybridSeam,
  type MultiSourceSeam,
} from "./grounded-qa.js";
import { createInMemoryUiStore, type ChatConnectedScope, type UiStore } from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import type { ApiError, RouteContext, RouteResult } from "./routes.js";
import type { OrchestratorInput, OrchestratorOutput } from "./grounded-orchestrator.js";
import type { GroundedRetriever, MultiSourceAnswerer } from "./grounded-qa-multi-source.js";

const NOW = 1_700_000_000_000;
const CHAT_MODEL = "example-chat-model";

// Non-pattern provider URL: it is NOT matched by GatewayError's construction-time pattern
// redactor, so it survives error construction and only the BFF boundary scrub (configured-secret
// based) can remove it. This is the mutation-robust signal.
const PROVIDER_BASE_URL = "https://acme.openai.azure.com";
const CONFIG_API_KEY = "test-config-secret-value-1234567890";
// Pattern-shaped shapes — caught by construction AND the boundary; asserted for completeness.
const SK_LIVE = ["sk", "-LIVE1234567890abcdef1234"].join("");
const BEARER = ["Bear", "er abc.def.ghi.jkl.mno.pqr"].join("");

let store: UiStore;
let tmp: string;

function chatConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: CHAT_MODEL,
        baseUrl: PROVIDER_BASE_URL,
        apiKey: CONFIG_API_KEY,
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: CHAT_MODEL,
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

function fakeReq(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function fakeRes(): RouteContext["res"] {
  const res = new EventEmitter() as RouteContext["res"] & { writableEnded: boolean };
  res.writableEnded = false;
  return res;
}

function ctx(body: string): RouteContext {
  return {
    req: fakeReq(body),
    res: fakeRes(),
    params: {},
    url: new URL("http://localhost/api/chats/messages/grounded"),
  };
}

function deps(): UiHandlerDeps {
  const config = chatConfig();
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    // The grounded paths under test inject their seam, so the model port factory is never reached.
    modelPortFactory: () => undefined,
    store,
    // The hybrid path opens the on-disk KnowledgeStore at this path to resolve connector scopes.
    uiDbPath: join(tmp, "keiko-ui.db"),
  };
}

function errorEnvelope(result: RouteResult): ApiError["error"] {
  return (result.body as ApiError).error;
}

function assertScrubbed(message: string): void {
  expect(message).not.toContain(PROVIDER_BASE_URL);
  expect(message).toContain("[REDACTED]");
}

beforeEach(() => {
  store = createInMemoryUiStore();
  tmp = mkdtempSync(join(tmpdir(), "keiko-grounded-err-redact-"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Folder single-source path ────────────────────────────────────────────────

function singleFolderChat(): string {
  const project = store.createProject(tmp, "demo");
  const chat = store.createChat(project.path, "Single", CHAT_MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "files", relativePaths: ["src"], connectedAtMs: NOW },
  });
  return chat.id;
}

function throwingRunner(error: Error): GroundedRunner {
  return (_input: OrchestratorInput): Promise<OrchestratorOutput> => Promise.reject(error);
}

describe("grounded folder path redacts gateway error messages (#154)", () => {
  it("scrubs the provider base URL echoed in a ProviderError message", async () => {
    const chatId = singleFolderChat();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      throwingRunner(
        new ProviderError(`POST ${PROVIDER_BASE_URL}/chat/completions returned 500`, 502),
      ),
    );
    expect(result.status).toBe(502);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe("GATEWAY_PROVIDER_ERROR");
    assertScrubbed(envelope.message);
  });

  it("scrubs pattern-shaped credentials in an AuthenticationError message", async () => {
    const chatId = singleFolderChat();
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      throwingRunner(
        new AuthenticationError(`401 from ${PROVIDER_BASE_URL}: api-key ${SK_LIVE}; ${BEARER}`),
      ),
    );
    expect(result.status).toBe(401);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe("GATEWAY_AUTHENTICATION");
    assertScrubbed(envelope.message);
    expect(envelope.message).not.toContain(SK_LIVE);
    expect(envelope.message).not.toMatch(/Bearer\s+abc\.def/);
  });
});

// ─── Multi-source merge path ──────────────────────────────────────────────────

function multiFolderChat(): string {
  const project = store.createProject(tmp, "demo");
  const chat = store.createChat(project.path, "Multi", CHAT_MODEL);
  const scopes: readonly ChatConnectedScope[] = [
    { kind: "files", relativePaths: ["a"], connectedAtMs: NOW },
    { kind: "files", relativePaths: ["b"], connectedAtMs: NOW },
  ];
  store.updateChat(chat.id, { connectedScopes: scopes });
  return chat.id;
}

function throwingRetriever(error: Error): GroundedRetriever {
  return (_input: OrchestratorInput) => Promise.reject(error);
}

function unusedAnswerer(): MultiSourceAnswerer {
  return () => Promise.reject(new Error("answerer must not run when retrieval fails"));
}

describe("grounded multi-source path redacts gateway error messages (#154)", () => {
  it("scrubs the provider base URL when retrieval throws a ProviderError", async () => {
    const chatId = multiFolderChat();
    const seam: MultiSourceSeam = {
      retriever: throwingRetriever(
        new ProviderError(`GET ${PROVIDER_BASE_URL}/models failed`, 502),
      ),
      answerer: unusedAnswerer(),
    };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      undefined,
      seam,
    );
    expect(result.status).toBe(502);
    assertScrubbed(errorEnvelope(result).message);
  });
});

// ─── Hybrid (folders + connector) path ────────────────────────────────────────

// Seeds a REAL ready capsule into the on-disk KnowledgeStore so resolveConnectorScopes passes and
// the hybrid path proceeds to folder retrieval (where our seam throws). Mirrors the seeding in
// grounded-qa-hybrid.test.ts.
async function seedReadyCapsule(displayName: string): Promise<KnowledgeCapsuleId> {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const knowledgeStore = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  const seeded = await seedCapsuleWithVectors(knowledgeStore, {
    displayName,
    capsuleId: `cap-${base}`,
    sourceId: `src-${base}`,
  });
  updateCapsuleState(knowledgeStore, seeded.capsuleId, "ready");
  knowledgeStore.close();
  return seeded.capsuleId;
}

async function hybridChat(): Promise<string> {
  const capsuleId = await seedReadyCapsule("Hybrid Docs");
  const project = store.createProject(tmp, "demo");
  const chat = store.createChat(project.path, "Hybrid", CHAT_MODEL);
  store.updateChat(chat.id, {
    connectedScopes: [{ kind: "files", relativePaths: ["src"], connectedAtMs: NOW }],
  });
  store.updateChat(chat.id, {
    localKnowledgeScopes: [{ kind: "capsule", capsuleId, connectedAtMs: NOW }],
  });
  return chat.id;
}

describe("grounded hybrid path redacts gateway error messages (#154)", () => {
  it("scrubs the provider base URL in a ProviderError raised during folder retrieval", async () => {
    const chatId = await hybridChat();
    const hybrid: HybridSeam = {
      folderRetriever: (_input: OrchestratorInput) =>
        Promise.reject(new ProviderError(`POST ${PROVIDER_BASE_URL}/v1 failed`, 502)),
    };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      undefined,
      undefined,
      hybrid,
    );
    expect(result.status).toBe(502);
    assertScrubbed(errorEnvelope(result).message);
  });

  it("scrubs the provider base URL in a non-gateway Error fallback", async () => {
    const chatId = await hybridChat();
    const hybrid: HybridSeam = {
      folderRetriever: (_input: OrchestratorInput) =>
        Promise.reject(new Error(`connection to ${PROVIDER_BASE_URL} refused`)),
    };
    const result = await handleGroundedAsk(
      ctx(JSON.stringify({ chatId, content: "explain" })),
      deps(),
      undefined,
      undefined,
      hybrid,
    );
    expect(result.status).toBe(500);
    expect(errorEnvelope(result).code).toBe("INTERNAL");
    assertScrubbed(errorEnvelope(result).message);
  });
});

// Note on the local-knowledge (single-connector) path: its scoped-answer catch-all applies the
// SAME redact-the-dynamic-message fix (local-knowledge-grounded-qa.ts, redactText(deps, …)). Its
// state-failure branch already redacted before this change. Driving its model-call catch-all over
// HTTP requires aligning a seeded capsule's embedding model with a configured embedding provider
// (the #532 matching constraint); the redaction pattern itself is the identical one the hybrid
// "non-gateway Error fallback" test above pins as mutation-robust, so it is not re-fixtured here.
