import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleConfig,
  handleModels,
  handleVoiceCapability,
  handleWorkflows,
  handleWorkspace,
  handleEvidenceList,
  handleEvidenceDetail,
  isVoiceDictationCapable,
  isVoiceRealtimeCapable,
} from "./read-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { DEFAULT_GROUNDING_LIMITS } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { STREAMING } from "./routes.js";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  EvidenceReadError,
  EvidenceSchemaError,
  InvalidRunIdError,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";

function ctx(path: string, params: Record<string, string> = {}): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params,
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function asResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) {
    throw new Error("expected a RouteResult, got STREAMING");
  }
  return outcome;
}

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function redactTopSecret(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll("topsecret", "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactTopSecret(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactTopSecret(entry);
  }
  return out;
}

function createWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-ui-workspace-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "topsecret",
      version: "1.0.0",
      devDependencies: { vitest: "^4.1.7" },
    }),
    "utf8",
  );
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
  writeFileSync(join(root, "tests", "index.test.ts"), "it('ok', () => {});\n", "utf8");
  return root;
}

function depsWith(overrides: Partial<UiHandlerDeps>): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

function depsWithRegisteredProject(
  root: string,
  overrides: Partial<UiHandlerDeps> = {},
): UiHandlerDeps {
  const store = createInMemoryUiStore();
  store.createProject(root);
  return depsWith({ store, ...overrides });
}

const SAMPLE_CONFIG: GatewayConfig = {
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
      throughputHint: "test fixture",
      preferredUseCases: ["UI tests"],
      knownLimitations: [],
      tokenAccounting: {
        source: "calibrated",
        counterId: "ui-test-provider-counter-v1",
        scaleMilli: 1_000,
        offsetTokens: 0,
      },
    },
  ],
};

describe("GET /api/config", () => {
  it("returns null config when none resolved", () => {
    const result = handleConfig(ctx("/api/config"), depsWith({}));
    expect(result.body).toMatchObject({ config: null, configPresent: false });
  });

  it("returns a safe config that never contains the apiKey or provider endpoint", () => {
    const result = handleConfig(
      ctx("/api/config"),
      depsWith({ config: SAMPLE_CONFIG, configPresent: true }),
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("example-test-token-1234567890");
    expect(json).not.toContain("https://api.example.com");
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("baseUrl");
    expect(result.body).toMatchObject({ configPresent: true });
  });

  it("returns effectiveGroundingLimits with defaults when no config is resolved", () => {
    const result = handleConfig(ctx("/api/config"), depsWith({}));
    const body = result.body as { effectiveGroundingLimits: typeof DEFAULT_GROUNDING_LIMITS };
    expect(body.effectiveGroundingLimits).toEqual(DEFAULT_GROUNDING_LIMITS);
  });

  it("returns effectiveGroundingLimits reflecting file config grounding block", () => {
    const configWithGrounding = {
      ...SAMPLE_CONFIG,
      grounding: { maxConnectedSources: 4, maxLocalKnowledgeSources: 4 },
    };
    const result = handleConfig(
      ctx("/api/config"),
      depsWith({ config: configWithGrounding, configPresent: true }),
    );
    const body = result.body as { effectiveGroundingLimits: { maxConnectedSources: number } };
    expect(body.effectiveGroundingLimits.maxConnectedSources).toBe(4);
  });
});

describe("GET /api/models", () => {
  it("returns only configured models", () => {
    const result = handleModels(
      ctx("/api/models"),
      depsWith({
        config: {
          ...SAMPLE_CONFIG,
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
        },
        configPresent: true,
      }),
    );
    const body = result.body as {
      models: { id: string; tokenAccounting?: { source: string; scaleMilli?: number } }[];
    };
    expect(body.models.map((model) => model.id)).toEqual(["example-chat-model"]);
    expect(body.models[0]?.tokenAccounting).toEqual({
      source: "calibrated",
      scaleMilli: 1_000,
      offsetTokens: 0,
    });
    expect(body.models[0]?.tokenAccounting).not.toHaveProperty("counterId");
  });

  it("returns runtime-declared configured models", () => {
    const result = handleModels(
      ctx("/api/models"),
      depsWith({ config: SAMPLE_CONFIG, configPresent: true }),
    );
    const body = result.body as { models: { id: string }[] };
    expect(body.models.map((model) => model.id)).toEqual(["example-chat-model"]);
  });

  it("returns no models when no config is resolved", () => {
    const result = handleModels(ctx("/api/models"), depsWith({}));
    const body = result.body as { models: unknown[] };
    expect(body.models).toEqual([]);
  });
});

// A configured STT-only voice provider shaped like the existing keiko-stt deployment (Issue #493).
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

describe("GET /api/voice/capability", () => {
  it("reports unavailable (no-voice-provider) when no config is resolved (AC1)", () => {
    const result = handleVoiceCapability(ctx("/api/voice/capability"), depsWith({}));
    expect(result.body).toEqual({
      voice: {
        available: false,
        profile: "none",
        capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
        transport: { websocketControl: false, webrtcMedia: false },
        // Issue #1557, ADR-0094 D2: the resolution always carries availableVoicePersonas (empty when
        // unavailable). The unavailable resolution offers no personas.
        availableVoicePersonas: [],
        reason: "no-voice-provider",
      },
    });
  });

  it("includes availableVoicePersonas (content-free) on every resolution (Issue #1557, AC3)", () => {
    const result = handleVoiceCapability(
      ctx("/api/voice/capability"),
      depsWith({ config: VOICE_STT_CONFIG, configPresent: true }),
    );
    const body = result.body as { voice: { availableVoicePersonas: readonly string[] } };
    // STT-only deployment: personas are OUTPUT voices, so none are available.
    expect(body.voice.availableVoicePersonas).toEqual([]);
  });

  it("reports dictation (speech-to-text) when keiko-stt is configured (AC2/AC6)", () => {
    const result = handleVoiceCapability(
      ctx("/api/voice/capability"),
      depsWith({ config: VOICE_STT_CONFIG, configPresent: true }),
    );
    const body = result.body as { voice: { available: boolean; profile: string } };
    expect(body.voice.available).toBe(true);
    expect(body.voice.profile).toBe("speech-to-text");
  });

  it("never returns the provider base URL, credential, or model id (AC4/AC5)", () => {
    const result = handleVoiceCapability(
      ctx("/api/voice/capability"),
      depsWith({ config: VOICE_STT_CONFIG, configPresent: true }),
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain("voice-secret-token-1234567890");
    expect(json).not.toContain("https://keiko-stt.example.com");
    expect(json).not.toContain("keiko-stt");
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("baseUrl");
  });

  it("reports policy-disabled when KEIKO_VOICE_DISABLED is set, even with a provider", () => {
    const result = handleVoiceCapability(
      ctx("/api/voice/capability"),
      depsWith({
        config: VOICE_STT_CONFIG,
        configPresent: true,
        env: { KEIKO_VOICE_DISABLED: "1" },
      }),
    );
    const body = result.body as { voice: { available: boolean; reason: string } };
    expect(body.voice.available).toBe(false);
    expect(body.voice.reason).toBe("policy-disabled");
  });
});

describe("isVoiceDictationCapable (Issue #495 — Permissions-Policy microphone scoping)", () => {
  it("is false when no config is resolved", () => {
    expect(isVoiceDictationCapable(depsWith({}))).toBe(false);
  });

  it("is false when only a chat provider is configured (no speech-to-text)", () => {
    expect(isVoiceDictationCapable(depsWith({ config: SAMPLE_CONFIG, configPresent: true }))).toBe(
      false,
    );
  });

  it("is true when a speech-to-text voice provider is configured", () => {
    expect(
      isVoiceDictationCapable(depsWith({ config: VOICE_STT_CONFIG, configPresent: true })),
    ).toBe(true);
  });

  it("is false when voice is disabled by policy, even with a voice provider", () => {
    expect(
      isVoiceDictationCapable(
        depsWith({
          config: VOICE_STT_CONFIG,
          configPresent: true,
          env: { KEIKO_VOICE_DISABLED: "1" },
        }),
      ),
    ).toBe(false);
  });
});

// A full-realtime voice provider (advertises realtime voice), the only profile that may open the
// WebSocket control plane (Issue #497).
const VOICE_REALTIME_CONFIG: GatewayConfig = {
  ...VOICE_STT_CONFIG,
  capabilities: (VOICE_STT_CONFIG.capabilities ?? []).map((capability) => ({
    ...capability,
    supportsRealtimeVoice: true,
  })),
};

describe("isVoiceRealtimeCapable (Issue #497 — WebSocket control-plane + microphone gate)", () => {
  it("is false when no config is resolved", () => {
    expect(isVoiceRealtimeCapable(depsWith({}))).toBe(false);
  });

  it("is false for a chat-only deployment", () => {
    expect(isVoiceRealtimeCapable(depsWith({ config: SAMPLE_CONFIG, configPresent: true }))).toBe(
      false,
    );
  });

  it("is false for an STT-only deployment (dictation, not full realtime)", () => {
    expect(
      isVoiceRealtimeCapable(depsWith({ config: VOICE_STT_CONFIG, configPresent: true })),
    ).toBe(false);
  });

  it("is true for a full-realtime voice deployment", () => {
    expect(
      isVoiceRealtimeCapable(depsWith({ config: VOICE_REALTIME_CONFIG, configPresent: true })),
    ).toBe(true);
  });

  it("is false when voice is disabled by policy, even when realtime-capable", () => {
    expect(
      isVoiceRealtimeCapable(
        depsWith({
          config: VOICE_REALTIME_CONFIG,
          configPresent: true,
          env: { KEIKO_VOICE_DISABLED: "1" },
        }),
      ),
    ).toBe(false);
  });
});

describe("GET /api/workflows", () => {
  it("returns both descriptors and the explain-plan inputs", () => {
    const result = handleWorkflows();
    const body = result.body as {
      descriptors: { workflowId: string }[];
      explainPlan: { inputs: { name: string; required: boolean }[] };
    };
    expect(body.descriptors.map((d) => d.workflowId)).toEqual([
      "unit-test-generation",
      "bug-investigation",
    ]);
    expect(body.explainPlan.inputs[0]).toMatchObject({ name: "filePath", required: true });
    expect(body.explainPlan.inputs[1]).toMatchObject({ name: "question", required: false });
  });

  it("exposes a verify synth entry with workspaceRoot required and targetFiles optional", () => {
    const result = handleWorkflows();
    const body = result.body as {
      verify: {
        inputs: { name: string; type: string; required: boolean }[];
        defaultLimits: Record<string, unknown>;
      };
    };
    expect(body.verify.inputs).toHaveLength(2);
    expect(body.verify.inputs[0]).toMatchObject({
      name: "workspaceRoot",
      type: "string",
      required: true,
    });
    expect(body.verify.inputs[1]).toMatchObject({
      name: "targetFiles",
      type: "string[]",
      required: false,
    });
    expect(body.verify.defaultLimits).toEqual(expect.any(Object));
  });
});

describe("GET /api/workspace", () => {
  it("returns a workspace summary and redacts the response body", () => {
    const root = createWorkspaceFixture();
    try {
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(root)}`),
        depsWithRegisteredProject(root, { redactor: redactTopSecret }),
      );
      expect(result.status).toBe(200);
      const body = result.body as {
        summary: {
          root: string;
          name: string;
          context?: { entries: { path: string; excerpt: string }[] };
        };
      };
      expect(body.summary.root).toBe(root);
      expect(body.summary.name).toBe("[REDACTED]");
      expect(body.summary.context).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toContain("topsecret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes a context pack when task or budget is provided", () => {
    const root = createWorkspaceFixture();
    try {
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(root)}&task=src/index.ts&budget=128`),
        depsWithRegisteredProject(root, { redactor: redactTopSecret }),
      );
      expect(result.status).toBe(200);
      const body = result.body as {
        summary: {
          context: {
            budgetBytes: number;
            entries: { path: string; selectionReason: string }[];
            droppedForBudget: number;
          };
        };
      };
      expect(body.summary.context).toBeDefined();
      expect(body.summary.context.entries.length).toBeGreaterThan(0);
      expect(body.summary.context.budgetBytes).toBe(128);
      expect(body.summary.context.entries[0]?.selectionReason).toBe("entrypoint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid budget with BAD_REQUEST", () => {
    const result = handleWorkspace(ctx("/api/workspace?budget=0"), depsWith({}));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects a non-JSON-safe budget with BAD_REQUEST", () => {
    const result = handleWorkspace(ctx("/api/workspace?budget=9007199254740992"), depsWith({}));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("requires an explicit workspace dir", () => {
    const result = handleWorkspace(ctx("/api/workspace"), depsWith({}));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects workspace reads for unregistered projects", () => {
    const root = createWorkspaceFixture();
    try {
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(root)}`),
        depsWith({}),
      );
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "WORKSPACE_NOT_REGISTERED" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-local workspace path forms with BAD_REQUEST", () => {
    const result = handleWorkspace(
      ctx("/api/workspace?dir=https%3A%2F%2Fexample.test"),
      depsWith({}),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("surfaces safe workspace errors for missing workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-ui-missing-"));
    try {
      const deps = depsWithRegisteredProject(root);
      rmSync(root, { recursive: true, force: true });
      const result = handleWorkspace(ctx(`/api/workspace?dir=${encodeURIComponent(root)}`), deps);
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({
        error: {
          code: "WORKSPACE_NOT_FOUND",
          message: "The workspace could not be found.",
        },
      });
      expect(JSON.stringify(result.body)).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a registered nested directory inside a parent workspace", () => {
    const root = createWorkspaceFixture();
    const nested = join(root, "nested");
    mkdirSync(nested, { recursive: true });
    try {
      const result = handleWorkspace(
        ctx(`/api/workspace?dir=${encodeURIComponent(nested)}`),
        depsWithRegisteredProject(nested),
      );
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({
        error: {
          code: "WORKSPACE_NOT_REGISTERED",
          message: "The workspace directory is not a registered project.",
        },
      });
      expect(JSON.stringify(result.body)).not.toContain(root);
      expect(JSON.stringify(result.body)).not.toContain("context");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GET /api/evidence", () => {
  function runIdOf(json: string): string {
    const parsed = JSON.parse(json) as { run: { runId: string } };
    return parsed.run.runId;
  }

  function storeFrom(entries: readonly string[]): EvidenceStore {
    const map = new Map(entries.map((json) => [runIdOf(json), json]));
    return {
      put: () => "",
      list: () => [...map.keys()].sort(),
      get: (runId) => map.get(runId),
      delete: () => undefined,
    };
  }

  function manifestJson(
    runId: string,
    taskType: string,
    outcome: string,
    startedAt: number,
    modelId = "m",
    workspaceRoot?: string,
  ): string {
    return JSON.stringify({
      evidenceSchemaVersion: "1",
      run: {
        runId,
        fingerprint: "fp",
        harnessVersion: "0.1.5",
        taskType,
        outcome,
        startedAt,
        finishedAt: startedAt + 100,
        durationMs: 100,
      },
      model: { modelId, costClass: "low" },
      usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
      ...(workspaceRoot === undefined
        ? {}
        : {
            context: {
              workspaceRoot,
              totalCandidates: 0,
              usedBytes: 0,
              budgetBytes: 0,
              droppedForBudget: 0,
              entries: [],
            },
          }),
      stateTransitions: [],
      toolCalls: [],
      commandExecutions: [],
    });
  }

  it("returns every entry when no filter is given", () => {
    const store = storeFrom([
      manifestJson("run-a", "generate-unit-tests", "completed", Date.parse("2026-05-01T10:00:00Z")),
      manifestJson("run-b", "investigate-bug", "failed", Date.parse("2026-05-02T10:00:00Z")),
    ]);
    const result = handleEvidenceList(ctx("/api/evidence"), depsWith({ evidenceStore: store }));
    expect((result.body as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it("filters by outcome", () => {
    const store = storeFrom([
      manifestJson("run-a", "generate-unit-tests", "completed", Date.parse("2026-05-01T10:00:00Z")),
      manifestJson("run-b", "investigate-bug", "failed", Date.parse("2026-05-02T10:00:00Z")),
    ]);
    const result = handleEvidenceList(
      ctx("/api/evidence?outcome=failed"),
      depsWith({ evidenceStore: store }),
    );
    const entries = (result.body as { entries: { runId: string }[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("run-b");
  });

  it("filters by workflow", () => {
    const store = storeFrom([
      manifestJson("run-a", "generate-unit-tests", "completed", Date.parse("2026-05-01T10:00:00Z")),
      manifestJson("run-b", "investigate-bug", "failed", Date.parse("2026-05-02T10:00:00Z")),
    ]);
    const result = handleEvidenceList(
      ctx("/api/evidence?workflow=generate-unit-tests"),
      depsWith({ evidenceStore: store }),
    );
    const entries = (result.body as { entries: { runId: string }[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("run-a");
  });

  it("filters by started-at calendar day", () => {
    const store = storeFrom([
      manifestJson("run-a", "generate-unit-tests", "completed", Date.parse("2026-05-01T10:00:00Z")),
      manifestJson("run-b", "investigate-bug", "failed", Date.parse("2026-05-02T10:00:00Z")),
    ]);
    const result = handleEvidenceList(
      ctx("/api/evidence?date=2026-05-02"),
      depsWith({ evidenceStore: store }),
    );
    const entries = (result.body as { entries: { runId: string }[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("run-b");
  });

  it("filters by model and workspace metadata", () => {
    const store = storeFrom([
      manifestJson(
        "run-a",
        "generate-unit-tests",
        "completed",
        Date.parse("2026-05-01T10:00:00Z"),
        "model-a",
        "/workspaces/customer-a",
      ),
      manifestJson(
        "run-b",
        "investigate-bug",
        "completed",
        Date.parse("2026-05-02T10:00:00Z"),
        "model-b",
        "/workspaces/customer-b",
      ),
    ]);
    const result = handleEvidenceList(
      ctx("/api/evidence?model=model-b&workspace=customer-b"),
      depsWith({ evidenceStore: store }),
    );
    const entries = (result.body as { entries: { runId: string; modelId: string }[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: "run-b", modelId: "model-b" });
  });
});

describe("GET /api/evidence/:runId", () => {
  it("rejects an invalid runId with 400", () => {
    const result = handleEvidenceDetail(
      ctx("/api/evidence/..%2f", { runId: "../etc" }),
      depsWith({}),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("returns 404 when the manifest is absent", () => {
    const result = handleEvidenceDetail(
      ctx("/api/evidence/run-x", { runId: "run-x" }),
      depsWith({}),
    );
    expect(result.status).toBe(404);
  });

  it("returns 422 on a schema error with a safe message", () => {
    const store: EvidenceStore = {
      put: () => "",
      list: () => ["run-x"],
      get: () => {
        throw new EvidenceSchemaError("manifest schema version mismatch", "0");
      },
      delete: () => undefined,
    };
    const result = handleEvidenceDetail(
      ctx("/api/evidence/run-x", { runId: "run-x" }),
      depsWith({ evidenceStore: store }),
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "EVIDENCE_SCHEMA" } });
  });

  it("returns 422 on a read error", () => {
    const store: EvidenceStore = {
      put: () => "",
      list: () => ["run-x"],
      get: () => {
        throw new EvidenceReadError("manifest could not be read");
      },
      delete: () => undefined,
    };
    const result = handleEvidenceDetail(
      ctx("/api/evidence/run-x", { runId: "run-x" }),
      depsWith({ evidenceStore: store }),
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "EVIDENCE_READ" } });
  });

  it("maps an over-long runId to 400 with no filesystem path leaked (#622)", () => {
    const store: EvidenceStore = {
      put: () => "",
      list: () => [],
      get: () => {
        throw new InvalidRunIdError("runId produces a filename that exceeds the filesystem limit");
      },
      delete: () => undefined,
    };
    const result = handleEvidenceDetail(
      ctx("/api/evidence/run-x", { runId: "run-x" }),
      depsWith({ evidenceStore: store }),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    const message = (result.body as { error: { message: string } }).error.message;
    expect(message).not.toMatch(/[/\\]/);
  });

  it("serves a present manifest as-is", () => {
    const json = JSON.stringify({
      evidenceSchemaVersion: "1",
      run: {
        runId: "run-x",
        fingerprint: "fp",
        harnessVersion: "0.1.5",
        taskType: "explain-plan",
        outcome: "completed",
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
      },
      model: { modelId: "m", costClass: "unknown" },
      usageTotals: {
        promptTokens: 0,
        completionTokens: 0,
        requestCount: 0,
        totalLatencyMs: 0,
      },
      stateTransitions: [],
      toolCalls: [],
      commandExecutions: [],
    });
    const store: EvidenceStore = {
      put: () => "",
      list: () => ["run-x"],
      get: (runId) => (runId === "run-x" ? json : undefined),
      delete: () => undefined,
    };
    const result = asResult(
      handleEvidenceDetail(
        ctx("/api/evidence/run-x", { runId: "run-x" }),
        depsWith({ evidenceStore: store }),
      ),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ manifest: { evidenceSchemaVersion: "1" } });
  });
});
