// Server-side salience capture tests. Exercises captureSalientFromTurn against an in-process
// vault and a fake ModelPort — no network, no real model.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
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
    body: "The user is building a fintech app called Atlas.",
    type: "fact",
    confidence: 0.7,
    scope: "project",
    tags: ["atlas"],
  },
  {
    body: "Atlas is written in Rust.",
    type: "fact",
    confidence: 0.8,
    scope: "project",
    tags: ["rust"],
  },
  {
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
      status: "proposed",
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
});
