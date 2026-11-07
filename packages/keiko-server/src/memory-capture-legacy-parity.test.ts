// Legacy parity for mode-aware capture (issue #2546, amended by #4206). With deps that carry NO
// codingRuntimeDeploymentCeiling the effective mode still resolves to governed-assist, but a routine
// private fact needs no approval any more: it is accepted at once. A deployment that configured a
// governed-assist ceiling (an operator restriction) keeps the pre-#2546 wire-action vector, every
// candidate "proposed", and a disabled/absent memory request writes nothing in either case.

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
    about: "self",
    body: "I ship releases on a fortnightly cadence.",
    evidence: "I ship releases on a fortnightly cadence.",
    type: "fact",
  },
  {
    about: "self",
    body: "I run the build pipeline on self-hosted runners.",
    evidence: "I run the build pipeline on self-hosted runners.",
    type: "fact",
  },
]);

// Each accepted model body is an exact complete line from this user turn, as required by the
// user-provenance boundary in the real salience extractor.
const USER_TEXT = [
  "I ship releases on a fortnightly cadence.",
  "I run the build pipeline on self-hosted runners.",
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

// Legacy deps: NO codingRuntimeDeploymentCeiling field at all, unless the test names an operator
// restriction.
function legacyDeps(
  vault: MemoryVaultStore,
  restriction: Partial<UiHandlerDeps> = {},
): UiHandlerDeps {
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
    ...restriction,
  };
}

// #4206: only a configured governed-assist ceiling still holds a private fact for review.
const OPERATOR_RESTRICTION: Partial<UiHandlerDeps> = {
  memoryDeploymentCeiling: "governed-assist",
  memoryDeploymentCeilingConfigured: true,
};

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
  it.each([
    ["accepts", {}, "accepted"],
    ["keeps proposed under an operator restriction", OPERATOR_RESTRICTION, "proposed"],
  ] as const)(
    "%s two public facts with the pinned wire-action vector",
    async (_name, deps, status) => {
      const vault = makeVault();
      const ctx = context();
      const actions = await captureSalientFromTurn(
        legacyDeps(vault, deps),
        { content: USER_TEXT, memory: { enabled: true } },
        ctx,
        "gpt-test",
        "ok",
      );
      expect(actions.map(normalizeAction)).toEqual([
        {
          kind: "candidate",
          proposalId: "<uuid>",
          body: "I ship releases on a fortnightly cadence.",
          scopeLabel: "User memory",
          requiresApproval: false,
          status,
        },
        {
          kind: "candidate",
          proposalId: "<uuid>",
          body: "I run the build pipeline on self-hosted runners.",
          scopeLabel: "User memory",
          requiresApproval: false,
          status,
        },
      ]);
      const records = readMemories(vault, ctx);
      expect(records).toHaveLength(2);
      expect(records.every((r) => r.status === status)).toBe(true);
      expect(records.every((r) => r.provenance.sensitivity === "public")).toBe(true);
      expect(records.map((r) => r.scope.kind)).toEqual(["user", "user"]);
    },
  );

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
