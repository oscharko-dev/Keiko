// Voice session recap route tests (ADR-0109 Artifact B). The route must stay a thin bridge into the
// existing governed capture path: it validates the DEPLOYMENT voice capability, extracts candidates
// from committed spoken spans with `extractCandidatesFromUserText`, persists only persistable
// candidates as `proposed`, rejects secrets, is dormant on empty input, and returns content-free
// counts + proposal ids (never transcript text).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { VOICE_SESSION_RECAP_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/voice-session-recap";
import { createRunRegistry } from "./runs.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore, type Chat, type UiStore } from "./store/index.js";
import { handleBuildVoiceRecap, type RecapResponseBody } from "./voice-recap.js";
import {
  createVoiceRecapContentAttestationStore,
  type VoiceRecapContentAttestationStore,
} from "./voice-recap-provenance.js";

const CHAT_MODEL = "chat-model";
const VOICE_MODEL = "keiko-realtime";

let tmp: string;
let projectPath: string;
let store: UiStore;
let vault: MemoryVaultStore;
let evidenceStore: EvidenceStore;

beforeEach(() => {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), "keiko-voice-recap-"));
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

function speechToTextConfig(): GatewayConfig {
  const config = realtimeConfig();
  const capability = config.capabilities?.[0];
  if (capability === undefined) throw new TypeError("voice test capability is missing");
  return {
    ...config,
    capabilities: [{ ...capability, supportsRealtimeVoice: false }],
  };
}

function deps(
  options: {
    config?: GatewayConfig;
    includeVault?: boolean;
    mode?: UiHandlerDeps["codingRuntimeDeploymentCeiling"];
    attestations?: VoiceRecapContentAttestationStore;
  } = {},
): UiHandlerDeps {
  return {
    config: options.config ?? realtimeConfig(),
    configPresent: true,
    evidenceStore,
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    ...(options.mode === undefined ? {} : { codingRuntimeDeploymentCeiling: options.mode }),
    ...(options.attestations === undefined
      ? {}
      : { voiceRecapContentAttestations: options.attestations }),
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
    correlationId: undefined,
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

function attestedRecapBody(
  chat: Chat,
  committedSpans: readonly string[],
  attestations: VoiceRecapContentAttestationStore,
  expiresAtMs?: number,
): Record<string, unknown> {
  const voiceSessionId = "voice-session-1";
  return {
    ...recapBody(chat, committedSpans),
    voiceSessionId,
    contentAttestation: attestations.attest({
      profile: "speech-to-text",
      sessionId: voiceSessionId,
      committedSpans,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    }),
  };
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
    expect(body).toMatchObject({
      provenance: "unattested",
      autoAcceptEligible: false,
      candidatesProposed: 0,
      candidatesAccepted: 0,
      candidatesExtracted: 0,
      proposalIds: [],
      acceptedIds: [],
    });
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
    expect(proposed).toHaveLength(2);
    expect(proposed.every((memory) => memory.status === "proposed")).toBe(true);

    // Governance audit (ADR-0109 D1): a content-free recap roll-up is persisted, and a
    // memory:proposed event is recorded per proposed candidate — both content-free (no transcript
    // text). This fails if the put, the recordMemoryAudits call, or the roll-up validation regresses.
    const entries = evidenceStore.list().map((runId) => ({ runId, raw: evidenceStore.get(runId) }));
    const rollupEntry = entries.find((entry) => entry.runId.startsWith("voice-recap-"));
    expect(rollupEntry).toBeDefined();
    const rollup = JSON.parse(rollupEntry?.raw ?? "{}") as Record<string, unknown>;
    expect(rollup.schemaVersion).toBe(VOICE_SESSION_RECAP_SCHEMA_VERSION);
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

  it("keeps unattested recap memories review-gated even in an auto-accept posture", async () => {
    const chat = createChat();
    store.updateMemoryAutonomyPolicy("supervised-coding", 0);
    const result = await handleBuildVoiceRecap(
      ctx(recapBody(chat, ["remember that I prefer dark mode"])),
      deps({ mode: "supervised-coding" }),
    );

    expect(result.status).toBe(200);
    const body = result.body as RecapResponseBody;
    expect(body).toMatchObject({
      provenance: "unattested",
      autoAcceptEligible: false,
      candidatesAccepted: 0,
      candidatesProposed: 1,
      acceptedIds: [],
    });
    expect(body.proposalIds).toHaveLength(1);
    const proposed = vault.listMemoriesAcrossScopes(vault.listMemoryScopes(), {
      status: ["proposed"],
      includeExpired: true,
    });
    expect(proposed).toHaveLength(1);
    expect(body.proposalIds).toEqual(proposed.map(({ id }) => String(id)));

    const entries = evidenceStore.list().map((runId) => ({ runId, raw: evidenceStore.get(runId) }));
    const rollupEntry = entries.find((entry) => entry.runId.startsWith("voice-recap-"));
    expect(rollupEntry).toBeDefined();
    expect(JSON.parse(rollupEntry?.raw ?? "{}")).toMatchObject({
      candidatesAccepted: 0,
      candidatesProposed: 1,
    });
    const auditEvents = entries
      .filter((entry) => !entry.runId.startsWith("voice-recap-"))
      .flatMap((entry) => {
        const parsed = JSON.parse(entry.raw ?? "[]") as unknown;
        return Array.isArray(parsed) ? (parsed as readonly { kind?: string }[]) : [];
      });
    expect(auditEvents.filter((event) => event.kind === "memory:accepted")).toHaveLength(0);
    expect(auditEvents.filter((event) => event.kind === "memory:proposed")).toHaveLength(1);
  });

  it("auto-accepts only spans attested by the server-observed speech-to-text path", async () => {
    const chat = createChat();
    const attestations = createVoiceRecapContentAttestationStore();
    const spans = ["remember that I prefer dark mode"];
    store.updateMemoryAutonomyPolicy("supervised-coding", 0);

    const result = await handleBuildVoiceRecap(
      ctx(attestedRecapBody(chat, spans, attestations)),
      deps({ config: speechToTextConfig(), mode: "supervised-coding", attestations }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      provenance: "attested",
      autoAcceptEligible: true,
      candidatesAccepted: 1,
      candidatesProposed: 0,
    });
  });

  it("does not consume an attestation before request validation succeeds", async () => {
    const chat = createChat();
    const attestations = createVoiceRecapContentAttestationStore();
    const spans = ["remember that I prefer dark mode"];
    const body = attestedRecapBody(chat, spans, attestations);
    body.projectPath = "../outside";

    expect(
      (await handleBuildVoiceRecap(ctx(body), deps({ config: speechToTextConfig(), attestations })))
        .status,
    ).not.toBe(200);
    body.projectPath = projectPath;
    await expect(
      handleBuildVoiceRecap(ctx(body), deps({ config: speechToTextConfig(), attestations })),
    ).resolves.toMatchObject({ status: 200, body: { provenance: "attested" } });
  });

  it("bounds active attestation retention by evicting the oldest unconsumed proof", () => {
    const attestations = createVoiceRecapContentAttestationStore(() => 1_000);
    const oldest = attestations.attest({
      profile: "speech-to-text",
      sessionId: "oldest",
      committedSpans: ["oldest"],
    });
    let newest = oldest;
    for (let index = 0; index < 1_024; index += 1) {
      newest = attestations.attest({
        profile: "speech-to-text",
        sessionId: `session-${String(index)}`,
        committedSpans: [`span-${String(index)}`],
      });
    }

    expect(
      attestations.consume({
        profile: "speech-to-text",
        sessionId: "oldest",
        committedSpans: ["oldest"],
        proof: oldest,
      }),
    ).toBe("invalid");
    expect(
      attestations.consume({
        profile: "speech-to-text",
        sessionId: "session-1023",
        committedSpans: ["span-1023"],
        proof: newest,
      }),
    ).toBe("attested");
  });

  it("accepts a new attestation after evicting the oldest consumed proof", () => {
    const attestations = createVoiceRecapContentAttestationStore(() => 1_000);
    let oldestProof = "";
    for (let index = 0; index < 1_024; index += 1) {
      const sessionId = `consumed-session-${String(index)}`;
      const committedSpans = [`consumed-span-${String(index)}`];
      const proof = attestations.attest({
        profile: "speech-to-text",
        sessionId,
        committedSpans,
      });
      if (index === 0) oldestProof = proof;
      expect(
        attestations.consume({
          profile: "speech-to-text",
          sessionId,
          committedSpans,
          proof,
        }),
      ).toBe("attested");
    }

    const freshProof = attestations.attest({
      profile: "speech-to-text",
      sessionId: "fresh-session",
      committedSpans: ["fresh-span"],
    });

    expect(
      attestations.consume({
        profile: "speech-to-text",
        sessionId: "consumed-session-0",
        committedSpans: ["consumed-span-0"],
        proof: oldestProof,
      }),
    ).toBe("invalid");
    expect(
      attestations.consume({
        profile: "speech-to-text",
        sessionId: "fresh-session",
        committedSpans: ["fresh-span"],
        proof: freshProof,
      }),
    ).toBe("attested");
  });

  it.each(["forged", "replayed", "expired", "content-substituted"] as const)(
    "rejects %s recap content attestations before capture",
    async (scenario) => {
      let nowMs = 1_000;
      const chat = createChat();
      const attestations = createVoiceRecapContentAttestationStore(() => nowMs);
      const spans = ["remember that I prefer dark mode"];
      const body = attestedRecapBody(
        chat,
        spans,
        attestations,
        scenario === "expired" ? 999 : undefined,
      );
      if (scenario === "forged") body.contentAttestation = "forged-proof";
      if (scenario === "content-substituted") {
        body.committedSpans = ["remember that I prefer light mode"];
      }
      if (scenario === "replayed") {
        const first = await handleBuildVoiceRecap(
          ctx(body),
          deps({ config: speechToTextConfig(), attestations }),
        );
        expect(first.status).toBe(200);
      }
      if (scenario === "expired") nowMs = 1_001;

      const result = await handleBuildVoiceRecap(
        ctx(body),
        deps({ config: speechToTextConfig(), attestations }),
      );

      expect(result.status).toBe(403);
      expect(proposedCount()).toBe(scenario === "replayed" ? 1 : 0);
    },
  );

  it("deduplicates an exact scoped recap candidate before auto-acceptance", async () => {
    const chat = createChat();
    const attestations = createVoiceRecapContentAttestationStore();
    store.updateMemoryAutonomyPolicy("supervised-coding", 0);
    const spans = ["remember that I prefer dark mode"];

    const first = await handleBuildVoiceRecap(
      ctx(attestedRecapBody(chat, spans, attestations)),
      deps({ config: speechToTextConfig(), mode: "supervised-coding", attestations }),
    );
    const repeated = await handleBuildVoiceRecap(
      ctx(attestedRecapBody(chat, spans, attestations)),
      deps({ config: speechToTextConfig(), mode: "supervised-coding", attestations }),
    );

    expect(first.body).toMatchObject({ candidatesAccepted: 1, candidatesRejected: 0 });
    expect(repeated.body).toMatchObject({
      candidatesAccepted: 0,
      candidatesProposed: 0,
      candidatesRejected: 1,
      acceptedIds: [],
      proposalIds: [],
    });
    expect(
      vault.listMemoriesAcrossScopes(vault.listMemoryScopes(), {
        status: ["accepted"],
        includeExpired: true,
      }),
    ).toHaveLength(1);
  });

  it("honors a governed-assist memory posture below the deployment ceiling", async () => {
    const chat = createChat();
    store.updateMemoryAutonomyPolicy("governed-assist", 0);

    const result = await handleBuildVoiceRecap(
      ctx(recapBody(chat, ["remember that release checks use vitest"])),
      deps({ mode: "autonomous-delivery" }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ candidatesAccepted: 0, candidatesProposed: 1 });
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
