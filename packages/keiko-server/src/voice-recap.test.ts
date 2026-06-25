// Tests for the BFF voice-session-recap route (Issue #504, Epic #491, ADR-0067). Covers AC1 dormancy
// (no-voice deployment + empty committed transcript), the 16 KB body cap (413), AC3 candidate creation
// entering "proposed" status in the existing review queue, AC6 credential rejection (never stored), the
// assistant-text-never-a-candidate invariant (AC5), the content-free audit record (AC4), and proof the
// route table is intact.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { handleVoiceRecapBuild } from "./voice-recap.js";
import { API_ROUTES } from "./routes.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext } from "./routes.js";

// A configured STT-only voice provider (Issue #493/#494): makes the deployment voice-recap-capable.
const VOICE_STT_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "keiko-stt",
      baseUrl: "https://keiko-stt.example.com",
      apiKey: "voice-secret-token-1234567890",
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  capabilities: [
    {
      id: "keiko-stt",
      kind: "voice",
      contextWindow: 0,
      maxOutputTokens: 0,
      toolCalling: false,
      structuredOutput: false,
      streaming: false,
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsSpeechInput: true,
      voiceProviderLocality: "azure-foundry",
      workflowEligible: false,
      costClass: "low",
      latencyClass: "fast",
      throughputHint: "azure foundry stt",
      preferredUseCases: ["Dictation"],
      knownLimitations: [],
    },
  ],
};

// A chat-only (no voice) config — the no-voice baseline for AC1.
const CHAT_ONLY_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "example-chat-model",
      baseUrl: "https://api.example.com",
      apiKey: "example-test-token-1234567890",
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  capabilities: [
    {
      id: "example-chat-model",
      kind: "chat",
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: false,
      costClass: "medium",
      latencyClass: "standard",
      throughputHint: "",
      preferredUseCases: [],
      knownLimitations: [],
    },
  ],
};

let activeVaults: MemoryVaultStore[] = [];
let tmpDirs: string[] = [];

beforeEach(() => {
  activeVaults = [];
  tmpDirs = [];
});

afterEach(() => {
  for (const vault of activeVaults) {
    try {
      vault.close();
    } catch {
      // ignore
    }
  }
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-voice-recap-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function ctx(body: unknown): RouteContext {
  const socket = new Socket();
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage,
    res: { socket } as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/voice/recap/build"),
  };
}

function rawCtx(raw: string): RouteContext {
  const socket = new Socket();
  return {
    req: Readable.from([Buffer.from(raw, "utf8")]) as unknown as IncomingMessage,
    res: { socket } as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/voice/recap/build"),
  };
}

function depsWith(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: createInMemoryEvidenceStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

function recapDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return depsWith({
    config: VOICE_STT_CONFIG,
    configPresent: true,
    memoryVault: makeVault(),
    ...overrides,
  });
}

// The FLAT response shape (ADR-0067 D5): counts at the top level, never nested under `summary`.
interface RecapResponseBody {
  readonly candidatesProposed: number;
  readonly candidatesRejected: number;
  readonly proposalIds: readonly string[];
}

function asRecap(body: unknown): RecapResponseBody {
  return body as RecapResponseBody;
}

// Builds the new request body: a list of per-utterance committed spans + a content-free transcript
// counts roll-up. The server derives `segmentCount` / `committedChars` itself, so the client roll-up
// here only carries the descriptive counts.
function recapBody(
  committedSpans: readonly string[],
  transcript: Record<string, unknown> = {},
): Record<string, unknown> {
  return { committedSpans, transcript };
}

function reviewQueueIds(vault: MemoryVaultStore): readonly string[] {
  return vault
    .listMemories({ status: ["proposed"], includeExpired: true })
    .map((m) => String(m.id));
}

function auditRecords(store: EvidenceStore): readonly Record<string, unknown>[] {
  return store
    .list()
    .filter((id) => id.startsWith("voice-recap-"))
    .map((id) => JSON.parse(store.get(id) ?? "{}") as Record<string, unknown>);
}

describe("POST /api/voice/recap/build — capability gate (AC1)", () => {
  it("returns 503 VOICE_UNAVAILABLE when no config is resolved", async () => {
    const result = await handleVoiceRecapBuild(
      ctx(recapBody(["remember that I prefer dark mode"])),
      depsWith({ memoryVault: makeVault() }),
    );
    expect(result.status).toBe(503);
    expect((result.body as { error: { code: string } }).error.code).toBe("VOICE_UNAVAILABLE");
  });

  it("is dormant for a no-voice (chat-only) deployment: no extraction, no candidate stored (AC1)", async () => {
    const vault = makeVault();
    const result = await handleVoiceRecapBuild(
      ctx(recapBody(["remember that I prefer dark mode"])),
      depsWith({ config: CHAT_ONLY_CONFIG, configPresent: true, memoryVault: vault }),
    );
    expect(result.status).toBe(503);
    expect(reviewQueueIds(vault)).toEqual([]);
  });

  it("is dormant when voice is disabled by policy even with a provider (AC1)", async () => {
    const vault = makeVault();
    const result = await handleVoiceRecapBuild(
      ctx(recapBody(["remember that I prefer dark mode"])),
      depsWith({
        config: VOICE_STT_CONFIG,
        configPresent: true,
        memoryVault: vault,
        env: { KEIKO_VOICE_DISABLED: "1" },
      }),
    );
    expect(result.status).toBe(503);
    expect(reviewQueueIds(vault)).toEqual([]);
  });

  it("does no audit write when the deployment is not voice-recap-capable (AC1)", async () => {
    const store = createInMemoryEvidenceStore();
    await handleVoiceRecapBuild(
      ctx(recapBody(["remember that I prefer dark mode"])),
      depsWith({
        config: CHAT_ONLY_CONFIG,
        configPresent: true,
        memoryVault: makeVault(),
        evidenceStore: store,
      }),
    );
    expect(auditRecords(store)).toEqual([]);
  });
});

describe("POST /api/voice/recap/build — body parsing", () => {
  it("returns 413 when the body exceeds the 16 KB cap", async () => {
    const oversize = "x".repeat(17_000);
    const result = await handleVoiceRecapBuild(ctx(recapBody([oversize])), recapDeps());
    expect(result.status).toBe(413);
    expect((result.body as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 400 on invalid JSON", async () => {
    const result = await handleVoiceRecapBuild(rawCtx("{not json"), recapDeps());
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when the body is a JSON array, not an object", async () => {
    const result = await handleVoiceRecapBuild(rawCtx("[1,2,3]"), recapDeps());
    expect(result.status).toBe(400);
  });

  it("returns 503 MEMORY_UNAVAILABLE when the vault is not configured", async () => {
    const result = await handleVoiceRecapBuild(
      ctx(recapBody(["remember that I prefer dark mode"])),
      depsWith({ config: VOICE_STT_CONFIG, configPresent: true }),
    );
    expect(result.status).toBe(503);
    expect((result.body as { error: { code: string } }).error.code).toBe("MEMORY_UNAVAILABLE");
  });
});

describe("POST /api/voice/recap/build — dormancy on empty transcript (AC1)", () => {
  it("returns zero counts and stores nothing when committedSpans is empty", async () => {
    const vault = makeVault();
    const result = await handleVoiceRecapBuild(
      ctx(recapBody([])),
      recapDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    const recap = asRecap(result.body);
    expect(recap.candidatesProposed).toBe(0);
    expect(recap.candidatesRejected).toBe(0);
    expect(recap.proposalIds).toEqual([]);
    expect(reviewQueueIds(vault)).toEqual([]);
  });

  it("drops whitespace-only spans, leaving nothing to recap (no candidates)", async () => {
    const vault = makeVault();
    const result = await handleVoiceRecapBuild(
      ctx(recapBody(["   \n  ", ""])),
      recapDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    expect(asRecap(result.body).candidatesProposed).toBe(0);
    expect(reviewQueueIds(vault)).toEqual([]);
  });

  it("writes an audit record even on empty committedSpans (user-triggered)", async () => {
    const store = createInMemoryEvidenceStore();
    await handleVoiceRecapBuild(ctx(recapBody([])), recapDeps({ evidenceStore: store }));
    const records = auditRecords(store);
    expect(records).toHaveLength(1);
    expect(records[0]?.triggeredByUser).toBe(true);
    expect(records[0]?.candidatesProposed).toBe(0);
    expect(records[0]?.committedSegmentCount).toBe(0);
    expect(records[0]?.committedChars).toBe(0);
  });
});

describe("POST /api/voice/recap/build — candidate creation enters proposed status (AC3)", () => {
  it("persists a public candidate as a 'proposed' memory in the review queue", async () => {
    const vault = makeVault();
    const result = await handleVoiceRecapBuild(
      ctx(recapBody(["remember that I prefer dark mode"])),
      recapDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    const recap = asRecap(result.body);
    expect(recap.candidatesProposed).toBe(1);
    expect(recap.proposalIds).toHaveLength(1);

    const queued = vault.listMemories({ status: ["proposed"], includeExpired: true });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe("proposed");
    expect(queued[0]?.body).toContain("dark mode");
    // The returned proposal id is exactly the queued record id (UI can fetch it from the review queue).
    expect(recap.proposalIds[0]).toBe(String(queued[0]?.id));
  });

  it("yields MULTIPLE proposed candidates from MULTIPLE committed spans (per-utterance extraction)", async () => {
    const vault = makeVault();
    const result = await handleVoiceRecapBuild(
      ctx(recapBody(["remember that I prefer dark mode", "remember that I live in Berlin"])),
      recapDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    const recap = asRecap(result.body);
    expect(recap.candidatesProposed).toBe(2);
    expect(recap.proposalIds).toHaveLength(2);

    const queued = vault.listMemories({ status: ["proposed"], includeExpired: true });
    expect(queued).toHaveLength(2);
    const bodies = queued.map((m) => m.body).join("\n");
    expect(bodies).toContain("dark mode");
    expect(bodies).toContain("Berlin");
  });

  it("records server-authoritative segment/char counts in the audit without leaking text", async () => {
    const store = createInMemoryEvidenceStore();
    const spans = ["remember that I prefer dark mode", "remember that I live in Berlin"];
    await handleVoiceRecapBuild(ctx(recapBody(spans)), recapDeps({ evidenceStore: store }));
    const record = auditRecords(store)[0] ?? {};
    expect(record.committedSegmentCount).toBe(2);
    expect(record.committedChars).toBe(spans.reduce((total, span) => total + span.length, 0));
    expect(record.triggeredByUser).toBe(true);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("dark mode");
    expect(serialized).not.toContain("Berlin");
  });

  it("ignores a client-inflated transcript.segmentCount: the server derives it from the spans", async () => {
    const store = createInMemoryEvidenceStore();
    await handleVoiceRecapBuild(
      ctx(recapBody(["remember that I prefer dark mode"], { segmentCount: 9_999, highestSeq: 5 })),
      recapDeps({ evidenceStore: store }),
    );
    const record = auditRecords(store)[0] ?? {};
    expect(record.committedSegmentCount).toBe(1);
  });

  it("counts a non-persistable (non-candidate) outcome without storing it", async () => {
    const vault = makeVault();
    // "what is the weather" matches no capture intent → zero outcomes, zero proposals.
    const result = await handleVoiceRecapBuild(
      ctx(recapBody(["what is the weather"])),
      recapDeps({ memoryVault: vault }),
    );
    const recap = asRecap(result.body);
    expect(recap.candidatesProposed).toBe(0);
    expect(reviewQueueIds(vault)).toEqual([]);
  });
});

describe("POST /api/voice/recap/build — secret rejection (AC6)", () => {
  it("rejects a credential string and never stores it as a memory", async () => {
    const vault = makeVault();
    const credential = "AKIA" + "ABCDEFGHIJKLMNOP";
    const result = await handleVoiceRecapBuild(
      ctx(recapBody([`remember that ${credential}`])),
      recapDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    const recap = asRecap(result.body);
    expect(recap.candidatesProposed).toBe(0);
    expect(recap.candidatesRejected).toBe(1);
    expect(recap.proposalIds).toEqual([]);
    // No memory in ANY status carries the credential text.
    const all = vault.listMemories({ includeExpired: true });
    expect(all).toEqual([]);
  });

  it("rejects a provider base URL before any candidate is created (AC6)", async () => {
    const vault = makeVault();
    const result = await handleVoiceRecapBuild(
      ctx(
        recapBody(["remember that our provider base URL is https://llm.internal.example.com/v1"]),
      ),
      recapDeps({ memoryVault: vault }),
    );
    const recap = asRecap(result.body);
    expect(recap.candidatesProposed).toBe(0);
    expect(reviewQueueIds(vault)).toEqual([]);
  });
});

describe("POST /api/voice/recap/build — assistant text is never a candidate (AC5)", () => {
  it("ignores any assistantText field: only committedSpans feed extraction", async () => {
    const vault = makeVault();
    const result = await handleVoiceRecapBuild(
      ctx({
        committedSpans: ["what is the weather"],
        transcript: {},
        // An assistant response that, if mistakenly extracted, would produce a candidate. The request
        // shape carries no assistant text at all, so this stray field is structurally ignored.
        assistantText: "remember that I prefer dark mode",
        assistantTurns: [{ schemaVersion: "1", turnIndex: 0, source: "text-response" }],
      }),
      recapDeps({ memoryVault: vault }),
    );
    expect(result.status).toBe(200);
    expect(asRecap(result.body).candidatesProposed).toBe(0);
    expect(reviewQueueIds(vault)).toEqual([]);
  });
});

describe("POST /api/voice/recap/build — content-free audit record (AC4)", () => {
  it("persists an audit record carrying only counts/enums/bools — no transcript text", async () => {
    const store = createInMemoryEvidenceStore();
    const committed = "remember that I prefer dark mode";
    await handleVoiceRecapBuild(ctx(recapBody([committed])), recapDeps({ evidenceStore: store }));
    const records = auditRecords(store);
    expect(records).toHaveLength(1);
    const record = records[0] ?? {};
    expect(record.schemaVersion).toBe("1");
    expect(record.profile).toBe("speech-to-text");
    expect(record.committedSegmentCount).toBe(1);
    expect(record.committedChars).toBe(committed.length);
    expect(record.candidatesProposed).toBe(1);
    expect(record.triggeredByUser).toBe(true);
    expect(typeof record.durationMs).toBe("number");
    // The serialized audit JSON contains no transcript content.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("dark mode");
    expect(serialized).not.toContain("remember");
  });

  it("never serializes a credential into the audit record (AC4/AC6)", async () => {
    const store = createInMemoryEvidenceStore();
    const credential = "AKIA" + "ABCDEFGHIJKLMNOP";
    await handleVoiceRecapBuild(
      ctx(recapBody([`remember that ${credential}`])),
      recapDeps({ evidenceStore: store }),
    );
    const serialized = JSON.stringify(auditRecords(store)[0] ?? {});
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("AKIA");
  });
});

describe("route registration is additive (AC5)", () => {
  it("registers exactly one POST /api/voice/recap/build route", () => {
    const matches = API_ROUTES.filter(
      (r) => r.pattern === "/api/voice/recap/build" && r.method === "POST",
    );
    expect(matches).toHaveLength(1);
  });

  it("leaves the existing transcribe and capability routes intact", () => {
    expect(
      API_ROUTES.some((r) => r.pattern === "/api/voice/transcribe" && r.method === "POST"),
    ).toBe(true);
    expect(
      API_ROUTES.some((r) => r.pattern === "/api/voice/capability" && r.method === "GET"),
    ).toBe(true);
  });
});
