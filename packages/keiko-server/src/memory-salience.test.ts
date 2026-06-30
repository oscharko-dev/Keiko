// Server-side salience capture tests. Exercises captureSalientFromTurn against an in-process
// vault and a fake ModelPort — no network, no real model.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayConfig, GatewayRequest } from "@oscharko-dev/keiko-model-gateway";
import type {
  ConversationId,
  MemoryRecord,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { captureSalientFromTurn } from "./memory-salience.js";
import {
  conversationMemoryScopes,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";

const ATLAS_FACTS = JSON.stringify([
  {
    source: "user",
    body: "The user is building a fintech app called Atlas.",
    type: "fact",
    confidence: 0.7,
    scope: "project",
    tags: ["atlas"],
  },
  {
    source: "user",
    body: "Atlas is written in Rust.",
    type: "fact",
    confidence: 0.8,
    scope: "project",
    tags: ["rust"],
  },
  {
    source: "user",
    body: "The user's team is in Berlin.",
    type: "fact",
    confidence: 0.6,
    scope: "user",
    tags: ["berlin"],
  },
]);

function fakeModel(content: string | (() => never)): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      const resolved = typeof content === "function" ? content() : content;
      return Promise.resolve({
        modelId: request.modelId,
        content: resolved,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "salience-test",
          promptTokens: 7,
          completionTokens: 3,
          latencyMs: 11,
          costClass: "high",
        },
      });
    },
  };
}

let activeVaults: MemoryVaultStore[] = [];
let tmpDirs: string[] = [];

beforeEach(() => {
  activeVaults = [];
  tmpDirs = [];
});

afterEach(() => {
  for (const v of activeVaults) {
    try {
      v.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-salience-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function makeDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => fakeModel(ATLAS_FACTS),
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

function context(): ConversationMemoryRuntimeContext {
  const path = mkdtempSync(join(tmpdir(), "keiko-salience-proj-"));
  tmpDirs.push(path);
  return {
    userId: "local-operator" as UserId,
    workspaceId: path as WorkspaceId,
    projectId: path as ProjectId,
    conversationId: "chat-1" as ConversationId,
  };
}

const USER_TEXT = "I'm building a fintech app called Atlas in Rust, my team is in Berlin";

function salienceConfig(
  modelId: string,
  supportsResponseFormat: boolean,
  supportsSeeding = false,
): GatewayConfig {
  return {
    providers: [
      {
        modelId,
        baseUrl: "https://provider.example/v1",
        apiKey: "test-config-secret-value-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: modelId,
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "test",
        preferredUseCases: ["Tests"],
        knownLimitations: [],
        supportsResponseFormat,
        supportsSeeding,
      },
    ],
  };
}

function countMemories(vault: MemoryVaultStore, ctx: ConversationMemoryRuntimeContext): number {
  return readMemories(vault, ctx).length;
}

function readMemories(
  vault: MemoryVaultStore,
  ctx: ConversationMemoryRuntimeContext,
): readonly MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  for (const scope of conversationMemoryScopes(ctx)) {
    for (const record of vault.listMemoriesByScope(scope)) {
      byId.set(String(record.id), record);
    }
  }
  return [...byId.values()];
}

describe("captureSalientFromTurn", () => {
  it("persists salient candidates and surfaces them as wire actions", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "Sounds like a great project!",
    );
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.kind === "candidate")).toBe(true);
    expect(countMemories(vault, ctx)).toBe(3);
  });

  it("persists German salience bodies without forcing them through English", async () => {
    const vault = makeVault();
    const deps = makeDeps({
      memoryVault: vault,
      modelPortFactory: () =>
        fakeModel(
          JSON.stringify([
            {
              source: "user",
              body: "Der Nutzer heißt Oliver.",
              type: "identity",
              confidence: 0.9,
              scope: "user",
              tags: ["identity"],
            },
          ]),
        ),
    });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: "Hallo Keiko, ich bin Oliver.", memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toHaveLength(1);
    const records = readMemories(vault, ctx);
    expect(records[0]?.body).toBe("Der Nutzer heißt Oliver.");
  });

  it("uses json_schema responseFormat only when the configured model supports it", async () => {
    const vault = makeVault();
    const seen: (GatewayRequest["responseFormat"] | undefined)[] = [];
    const seenSeeds: (number | undefined)[] = [];
    const port: ModelPort = {
      call(request): Promise<NormalizedResponse> {
        seen.push(request.responseFormat);
        seenSeeds.push(request.seed);
        return Promise.resolve({
          modelId: request.modelId,
          content: ATLAS_FACTS,
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "salience-test",
            promptTokens: 7,
            completionTokens: 3,
            latencyMs: 11,
            costClass: "high",
          },
        });
      },
    };
    const ctx = context();
    await captureSalientFromTurn(
      makeDeps({
        memoryVault: vault,
        config: salienceConfig("gpt-json", true),
        configPresent: true,
        modelPortFactory: () => port,
      }),
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-json",
      "ok",
    );
    await captureSalientFromTurn(
      makeDeps({
        memoryVault: vault,
        config: salienceConfig("gpt-plain", false),
        configPresent: true,
        modelPortFactory: () => port,
      }),
      { content: "I work on Atlas in Rust.", memory: { enabled: true } },
      ctx,
      "gpt-plain",
      "ok",
    );

    expect(seen[0]?.type).toBe("json_schema");
    expect(seen[1]).toBeUndefined();
    expect(seenSeeds).toEqual([undefined, undefined]);
  });

  it("uses the configured salience model alias and deterministic seed when supported", async () => {
    const vault = makeVault();
    const seen: GatewayRequest[] = [];
    const port: ModelPort = {
      call(request): Promise<NormalizedResponse> {
        seen.push(request);
        return Promise.resolve({
          modelId: request.modelId,
          content: ATLAS_FACTS,
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "salience-test",
            promptTokens: 7,
            completionTokens: 3,
            latencyMs: 11,
            costClass: "high",
          },
        });
      },
    };
    const deps = makeDeps({
      memoryVault: vault,
      env: { KEIKO_MEMORY_SALIENCE_MODEL_ID: "salience-small" },
      config: salienceConfig("salience-small", true, true),
      configPresent: true,
      modelPortFactory: (modelId) => (modelId === "salience-small" ? port : undefined),
    });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "chat-heavy",
      "ok",
    );

    expect(actions).toHaveLength(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.modelId).toBe("salience-small");
    expect(seen[0]?.seed).toBe(204);
    expect(seen[0]?.responseFormat?.type).toBe("json_schema");
  });

  it("forwards assistant text to the salience model as context-only", async () => {
    const vault = makeVault();
    let saliencePrompt = "";
    const deps = makeDeps({
      memoryVault: vault,
      modelPortFactory: () => ({
        call(request): Promise<NormalizedResponse> {
          saliencePrompt = request.messages.map((message) => message.content).join("\n");
          return Promise.resolve({
            modelId: request.modelId,
            content: ATLAS_FACTS,
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "salience-test",
              promptTokens: 7,
              completionTokens: 3,
              latencyMs: 11,
              costClass: "high",
            },
          });
        },
      }),
    });
    const ctx = context();
    await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "assistant-context-marker",
    );
    // User text is the extraction subject; assistant text is forwarded as a context-only block so
    // the model can resolve ambiguous affirmative turns (e.g. "yes, exactly that").
    expect(saliencePrompt).toContain(USER_TEXT);
    expect(saliencePrompt).toContain("assistant-context-marker");
  });

  it("persists records that carry tags and the salience captureRationale through validation", async () => {
    // The vault runs gateMemoryRecord on insert, so reading the records back proves the full
    // round-trip (tags + provenance.captureRationale) survives contract validation.
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const ctx = context();
    await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    const records = readMemories(vault, ctx);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.provenance.captureRationale).toBe(
        "Automatically inferred from conversation (salience capture)",
      );
      expect(record.provenance.sourceKind).toBe("system-default");
      expect(record.status).toBe("proposed");
    }
    const atlasRecord = records.find((r) => r.body.includes("Atlas"));
    expect(atlasRecord?.tags).toContain("atlas");
  });

  it("captures nothing when memory is disabled", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: false } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toEqual([]);
    expect(countMemories(vault, ctx)).toBe(0);
  });

  it("captures nothing when memory request is absent", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: undefined },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toEqual([]);
    expect(countMemories(vault, ctx)).toBe(0);
  });

  it("captures nothing when no vault is configured", async () => {
    const deps = makeDeps({ memoryVault: undefined });
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      context(),
      "gpt-test",
      "ok",
    );
    expect(actions).toEqual([]);
  });

  it("returns [] and does not throw when the model call fails", async () => {
    const vault = makeVault();
    const throwingModel: ModelPort = {
      call() {
        return Promise.reject(new Error("model exploded"));
      },
    };
    const deps = makeDeps({ memoryVault: vault, modelPortFactory: () => throwingModel });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toEqual([]);
    expect(countMemories(vault, ctx)).toBe(0);
  });

  it("returns [] when the model returns non-JSON prose (no throw)", async () => {
    const vault = makeVault();
    const deps = makeDeps({
      memoryVault: vault,
      modelPortFactory: () => fakeModel("I could not find anything durable to remember."),
    });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toEqual([]);
    expect(countMemories(vault, ctx)).toBe(0);
  });

  it("dedups a salient candidate against an already-stored body", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const ctx = context();
    vault.insertMemory({
      id: "seed-1" as never,
      schemaVersion: "1",
      scope: { kind: "project", projectId: ctx.projectId },
      type: "semantic-fact",
      body: "The user is building a fintech app called Atlas.",
      tags: [],
      provenance: {
        sourceKind: "system-default",
        capturedAt: 1_700_000_000_000,
        confidence: 0.7,
        sensitivity: "public",
      },
      validity: { validFrom: 1_700_000_000_000 },
      status: "accepted",
      pinned: false,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    } as never);
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    // The Atlas fact is a near-duplicate of the seed → dropped; Rust + Berlin remain.
    expect(actions).toHaveLength(2);
  });

  it("does not dedup salient candidates against superseded memory bodies", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const ctx = context();
    vault.insertMemory({
      id: "seed-1" as never,
      schemaVersion: "1",
      scope: { kind: "project", projectId: ctx.projectId },
      type: "semantic-fact",
      body: "The user is building a fintech app called Atlas.",
      tags: [],
      provenance: {
        sourceKind: "system-default",
        capturedAt: 1_700_000_000_000,
        confidence: 0.7,
        sensitivity: "public",
      },
      validity: { validFrom: 1_700_000_000_000 },
      status: "superseded",
      pinned: false,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    } as never);
    const actions = await captureSalientFromTurn(
      deps,
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toHaveLength(3);
  });

  it("persists confidential salience candidates as masked reviewable proposals", async () => {
    const vault = makeVault();
    const deps = makeDeps({
      memoryVault: vault,
      modelPortFactory: () =>
        fakeModel(
          JSON.stringify([
            {
              source: "user",
              body: "The user's private support email is developer@example.com.",
              type: "fact",
              confidence: 0.8,
              scope: "user",
              tags: ["support"],
            },
          ]),
        ),
    });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: "I prefer issue triage on Monday mornings.", memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: "candidate",
      body: "Sensitive memory pending review.",
      requiresApproval: true,
    });
    const records = readMemories(vault, ctx);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("proposed");
    expect(records[0]?.provenance.sensitivity).toBe("confidential");
    expect(records[0]?.body).toBe("The user's private support email is developer@example.com.");
  });

  it("isPersistableMemoryCandidate guard persists non-restricted sensitive and public candidates", async () => {
    // Model returns two items: one with an email address (confidential → reviewable masked
    // candidate) and one plain public fact. Credential/restricted shapes are still rejected by
    // memory-capture before this persistence layer.
    const vault = makeVault();
    const deps = makeDeps({
      memoryVault: vault,
      modelPortFactory: () =>
        fakeModel(
          JSON.stringify([
            {
              source: "user",
              body: "The user's contact email is private@example.com.",
              type: "fact",
              confidence: 0.7,
              scope: "user",
              tags: ["contact"],
            },
            {
              source: "user",
              body: "The user works in the payments domain.",
              type: "fact",
              confidence: 0.7,
              scope: "user",
              tags: ["payments"],
            },
          ]),
        ),
    });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      // User text is safe (no email/secret) so the egress guard passes; the model response
      // contains one sensitive item (email → confidential) and one public item.
      {
        content: "I work in the payments domain and have a contact address.",
        memory: { enabled: true },
      },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toHaveLength(2);
    const candidates = actions.filter((a) => a.kind === "candidate");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      kind: "candidate",
      body: "Sensitive memory pending review.",
      requiresApproval: true,
    });
    expect(candidates[1]).toMatchObject({
      kind: "candidate",
      body: "The user works in the payments domain.",
      requiresApproval: false,
    });
    expect(countMemories(vault, ctx)).toBe(2);
  });

  it("does not skip salience when the user text contains PII alongside a public fact", async () => {
    const vault = makeVault();
    const deps = makeDeps({
      memoryVault: vault,
      modelPortFactory: () =>
        fakeModel(
          JSON.stringify([
            {
              source: "user",
              body: "Die Telefonnummer des Nutzers ist +49 30 1234567.",
              type: "fact",
              confidence: 0.7,
              scope: "user",
              tags: ["contact"],
            },
            {
              source: "user",
              body: "Der Nutzer bevorzugt Vitest.",
              type: "preference",
              confidence: 0.8,
              scope: "user",
              tags: ["testing"],
            },
          ]),
        ),
    });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      {
        content: "Meine Telefonnummer ist +49 30 1234567 und ich bevorzuge Vitest.",
        memory: { enabled: true },
      },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      kind: "candidate",
      body: "Sensitive memory pending review.",
      requiresApproval: true,
    });
    expect(actions[1]).toMatchObject({
      kind: "candidate",
      body: "Der Nutzer bevorzugt Vitest.",
      requiresApproval: false,
    });
    expect(countMemories(vault, ctx)).toBe(2);
  });

  it("skips the salience model call when the user text contains a credential", async () => {
    const vault = makeVault();
    let called = false;
    const deps = makeDeps({
      memoryVault: vault,
      modelPortFactory: () => ({
        call(): Promise<NormalizedResponse> {
          called = true;
          return Promise.resolve({
            modelId: "gpt-test",
            content: ATLAS_FACTS,
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "salience-test",
              promptTokens: 7,
              completionTokens: 3,
              latencyMs: 11,
              costClass: "high",
            },
          });
        },
      }),
    });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: "I pasted api_key=ZZZ-yyy in the console.", memory: { enabled: true } },
      ctx,
      "gpt-test",
      "assistant text must not be sent to salience",
    );
    expect(actions).toEqual([]);
    expect(called).toBe(false);
    expect(countMemories(vault, ctx)).toBe(0);
  });

  it("threads deployment redaction literals into salience secret rejection", async () => {
    const vault = makeVault();
    const deps = makeDeps({
      memoryVault: vault,
      redactionSecrets: ["CustomerOmega"],
      modelPortFactory: () =>
        fakeModel(
          JSON.stringify([
            {
              source: "user",
              body: "CustomerOmega requires SSO for releases.",
              type: "fact",
              confidence: 0.8,
              scope: "project",
              tags: ["customer"],
            },
          ]),
        ),
    });
    const ctx = context();
    const actions = await captureSalientFromTurn(
      deps,
      { content: "CustomerOmega requires SSO for releases.", memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toEqual([]);
    expect(countMemories(vault, ctx)).toBe(0);
  });
});
