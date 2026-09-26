// Legacy fail-closed parity for mode-aware capture (issue #2546). With deps that carry NO
// codingRuntimeDeploymentCeiling the effective mode resolves to governed-assist, so capture must be
// byte-identical to the pre-#2546 behaviour: every candidate lands as "proposed", the wire-action
// vector is unchanged, and a disabled/absent memory request writes nothing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type { ConversationMemoryActionWire } from "@oscharko-dev/keiko-contracts/bff-wire";
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

// Two durable public facts in a deterministic order: one project-scoped, one user-scoped.
const TWO_PUBLIC_FACTS = JSON.stringify([
  {
    source: "user",
    body: "The platform team ships releases on a fortnightly cadence.",
    type: "fact",
    confidence: 0.7,
    scope: "project",
    tags: ["release"],
  },
  {
    source: "user",
    body: "The build pipeline runs on self-hosted runners.",
    type: "fact",
    confidence: 0.6,
    scope: "user",
    tags: ["ci"],
  },
]);

// Each accepted model body is an exact complete line from this user turn, as required by the
// user-provenance boundary in the real salience extractor.
const USER_TEXT = [
  "The platform team ships releases on a fortnightly cadence.",
  "The build pipeline runs on self-hosted runners.",
].join("\n");

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
          requestId: "parity-test",
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
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-parity-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

// Legacy deps: NO codingRuntimeDeploymentCeiling field at all.
function legacyDeps(vault: MemoryVaultStore): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => fakeModel(TWO_PUBLIC_FACTS),
    store: createInMemoryUiStore(),
    memoryVault: vault,
  };
}

function context(): ConversationMemoryRuntimeContext {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "keiko-parity-proj-"));
  tmpDirs.push(path);
  return {
    userId: "local-operator" as UserId,
    workspaceId: path as WorkspaceId,
    projectId: path as ProjectId,
    conversationId: "chat-1" as ConversationId,
  };
}

// The proposalId of a stored candidate is a freshly-minted UUID; normalise it so the vector can be
// pinned with an inline literal without coupling to a random id.
function normalizeAction(action: ConversationMemoryActionWire): ConversationMemoryActionWire {
  return action.kind === "candidate" ? { ...action, proposalId: "<uuid>" } : action;
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

describe("legacy fail-closed parity for mode-aware capture", () => {
  it("persists two public facts as proposed with an unchanged wire-action vector", async () => {
    const vault = makeVault();
    const ctx = context();
    const actions = await captureSalientFromTurn(
      legacyDeps(vault),
      { content: USER_TEXT, memory: { enabled: true } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions.map(normalizeAction)).toEqual([
      {
        kind: "candidate",
        proposalId: "<uuid>",
        body: "The platform team ships releases on a fortnightly cadence.",
        scopeLabel: "Project memory",
        requiresApproval: false,
        status: "proposed",
      },
      {
        kind: "candidate",
        proposalId: "<uuid>",
        body: "The build pipeline runs on self-hosted runners.",
        scopeLabel: "User memory",
        requiresApproval: false,
        status: "proposed",
      },
    ]);
    const records = readMemories(vault, ctx);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.status === "proposed")).toBe(true);
    expect(records.every((r) => r.provenance.sensitivity === "public")).toBe(true);
    expect([...records].map((r) => r.scope.kind).sort()).toEqual(["project", "user"]);
  });

  it("writes nothing when memory is disabled", async () => {
    const vault = makeVault();
    const ctx = context();
    const actions = await captureSalientFromTurn(
      legacyDeps(vault),
      { content: USER_TEXT, memory: { enabled: false } },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toEqual([]);
    expect(readMemories(vault, ctx)).toHaveLength(0);
  });

  it("writes nothing when the memory request is absent", async () => {
    const vault = makeVault();
    const ctx = context();
    const actions = await captureSalientFromTurn(
      legacyDeps(vault),
      { content: USER_TEXT, memory: undefined },
      ctx,
      "gpt-test",
      "ok",
    );
    expect(actions).toEqual([]);
    expect(readMemories(vault, ctx)).toHaveLength(0);
  });
});
