// Voice session recap route tests (ADR-0109 Artifact B). The route must stay a thin bridge into the
// existing governed capture path: it validates the DEPLOYMENT voice capability, extracts candidates
// from committed spoken spans with `extractCandidatesFromUserText`, persists only persistable
// candidates as `proposed`, rejects secrets, is dormant on empty input, and returns content-free
// counts + proposal ids (never transcript text).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { createRunRegistry } from "./runs.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore, type Chat, type UiStore } from "./store/index.js";
import { handleBuildVoiceRecap, type RecapResponseBody } from "./voice-recap.js";

const CHAT_MODEL = "chat-model";
const VOICE_MODEL = "keiko-realtime";

let tmp: string;
let projectPath: string;
let store: UiStore;
let vault: MemoryVaultStore;
let evidenceStore: EvidenceStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-voice-recap-"));
  projectPath = join(tmp, "repo");
  mkdirSync(projectPath);
  const memoryDir = join(tmp, "vault");
  mkdirSync(memoryDir);
  store = createInMemoryUiStore();
  vault = createMemoryVault({ memoryDir, redactString: (value) => value });
  evidenceStore = createInMemoryEvidenceStore();
});

afterEach(() => {
  vault.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function realtimeConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: VOICE_MODEL,
        baseUrl: "https://realtime.example.invalid/v1",
        apiKey: "voice-test-token-1234567890",
        timeoutMs: 1_000,
        maxRetries: 0,
        retryBaseDelayMs: 10,
        realtimeAuthMode: "ephemeral-session",
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: VOICE_MODEL,
        kind: "voice",
        contextWindow: 0,
        maxOutputTokens: 0,
        toolCalling: true,
        structuredOutput: false,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        supportsSpeechInput: true,
        supportsRealtimeVoice: true,
        supportedVoicePersonas: ["neutral"],
        voiceProviderLocality: "azure-foundry",
        workflowEligible: false,
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "Realtime voice test provider",
        preferredUseCases: ["Realtime voice"],
        knownLimitations: [],
      },
    ],
  };
}

function chatOnlyConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: CHAT_MODEL,
        baseUrl: "https://chat.example.invalid/v1",
        apiKey: "chat-test-token-1234567890",
        timeoutMs: 1_000,
        maxRetries: 0,
        retryBaseDelayMs: 10,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function deps(options: { config?: GatewayConfig; includeVault?: boolean } = {}): UiHandlerDeps {
  return {
    config: options.config ?? realtimeConfig(),
    configPresent: true,
    evidenceStore,
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    ...(options.includeVault === false ? {} : { memoryVault: vault }),
  };
}

function fakeReq(body: unknown): IncomingMessage {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage;
}

function fakeRes(): RouteContext["res"] {
  const res = new EventEmitter() as RouteContext["res"] & { writableEnded: boolean };
  res.writableEnded = false;
  return res;
}

function ctx(body: unknown): RouteContext {
  return {
    req: fakeReq(body),
    res: fakeRes(),
    params: {},
    url: new URL("http://localhost/api/voice/recap/build"),
  };
}

function createChat(): Chat {
  store.createProject(projectPath, "Voice recap");
  return store.createChat(projectPath, "Voice chat", CHAT_MODEL);
}

function recapBody(chat: Chat, committedSpans: readonly string[]): Record<string, unknown> {
  return { chatId: chat.id, projectPath, committedSpans };
}

function proposedCount(): number {
  const scopes = vault.listMemoryScopes();
  return vault.listMemoriesAcrossScopes(scopes, { status: ["proposed"], includeExpired: true })
    .length;
}

describe("handleBuildVoiceRecap", () => {
  it("is dormant (503) when the deployment cannot capture voice transcript", async () => {
    const chat = createChat();
    const result = await handleBuildVoiceRecap(
      ctx(recapBody(chat, ["remember that I prefer dark mode"])),
      deps({ config: chatOnlyConfig() }),
    );
    expect(result.status).toBe(503);
  });

  it("returns 409 when MemoriaViva is not wired", async () => {
    const chat = createChat();
    const result = await handleBuildVoiceRecap(
      ctx(recapBody(chat, ["remember that I prefer dark mode"])),
      deps({ includeVault: false }),
    );
    expect(result.status).toBe(409);
  });

  it("is dormant with no side effect on empty committed spans (AC1)", async () => {
    const chat = createChat();
    const result = await handleBuildVoiceRecap(ctx(recapBody(chat, [])), deps());
    expect(result.status).toBe(200);
    const body = result.body as RecapResponseBody;
    expect(body).toMatchObject({ candidatesProposed: 0, candidatesExtracted: 0, proposalIds: [] });
    expect(proposedCount()).toBe(0);
  });

  it("proposes governed candidates from committed spoken spans and reviews them via the queue", async () => {
    const chat = createChat();
    const result = await handleBuildVoiceRecap(
      ctx(
        recapBody(chat, [
          "remember that I prefer dark mode",
          "remember that the deploy target is staging first",
        ]),
      ),
      deps(),
    );
    expect(result.status).toBe(200);
    const body = result.body as RecapResponseBody;
    expect(body.candidatesProposed).toBe(2);
    expect(body.proposalIds).toHaveLength(2);
    // Candidates land as `proposed` in the vault — reachable by the existing review-queue endpoint.
    const scopes = vault.listMemoryScopes();
    const proposed = vault.listMemoriesAcrossScopes(scopes, {
      status: ["proposed"],
      includeExpired: true,
    });
    expect(proposed.length).toBe(2);
    expect(proposed.every((memory) => memory.status === "proposed")).toBe(true);

    // Governance audit (ADR-0109 D1): a content-free recap roll-up is persisted, and a
    // memory:proposed event is recorded per proposed candidate — both content-free (no transcript
    // text). This fails if the put, the recordMemoryAudits call, or the roll-up validation regresses.
    const entries = evidenceStore.list().map((runId) => ({ runId, raw: evidenceStore.get(runId) }));
    const rollupEntry = entries.find((entry) => entry.runId.startsWith("voice-recap-"));
    expect(rollupEntry).toBeDefined();
    const rollup = JSON.parse(rollupEntry?.raw ?? "{}") as Record<string, unknown>;
    expect(rollup.candidatesProposed).toBe(2);
    expect(rollup.triggeredByUser).toBe(true);
    // Content-free: the committed transcript text never enters the audit artifact.
    expect(rollupEntry?.raw ?? "").not.toContain("dark mode");
    expect(rollupEntry?.raw ?? "").not.toContain("staging");

    const proposedEvents = entries
      .filter((entry) => !entry.runId.startsWith("voice-recap-"))
      .flatMap((entry) => {
        const parsed = JSON.parse(entry.raw ?? "[]") as unknown;
        return Array.isArray(parsed) ? (parsed as readonly { kind?: string }[]) : [];
      })
      .filter((event) => event.kind === "memory:proposed");
    expect(proposedEvents).toHaveLength(2);
  });

  it("rejects a secret in committed text before it reaches the vault (AC6)", async () => {
    const chat = createChat();
    const result = await handleBuildVoiceRecap(
      ctx(
        recapBody(chat, [
          "remember that our provider base URL is https://llm.internal.example.com/v1",
        ]),
      ),
      deps(),
    );
    expect(result.status).toBe(200);
    const body = result.body as RecapResponseBody;
    expect(body.candidatesProposed).toBe(0);
    expect(body.candidatesRejected).toBeGreaterThan(0);
    expect(proposedCount()).toBe(0);
  });

  it("rejects an oversize request body with 413", async () => {
    const chat = createChat();
    const huge = "remember that " + "x".repeat(20_000);
    const result = await handleBuildVoiceRecap(ctx(recapBody(chat, [huge])), deps());
    expect(result.status).toBe(413);
  });

  it("rejects an unknown chat with 404", async () => {
    createChat();
    const result = await handleBuildVoiceRecap(
      ctx({ chatId: "missing", projectPath, committedSpans: ["remember that I prefer dark mode"] }),
      deps(),
    );
    expect(result.status).toBe(404);
  });
});
