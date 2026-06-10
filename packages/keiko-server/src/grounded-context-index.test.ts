import { describe, expect, it } from "vitest";

import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";

import { createGroundedContextIndexRegistry } from "./grounded-context-index.js";

const NOW = 1_700_000_000_000;

function scope(overrides: Partial<SelectedScope> = {}): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId: "scope-1",
    workspaceRoot: "/workspace",
    kind: "files",
    relativePaths: ["src"],
    conversationId: "chat-1",
    connectedAtMs: NOW,
    ...overrides,
  };
}

describe("createGroundedContextIndexRegistry", () => {
  it("reuses one micro-index for the same connected scope/session", () => {
    const registry = createGroundedContextIndexRegistry({ ttlMs: 60_000, maxScopes: 8 });
    const first = registry.forScope(scope(), () => NOW);
    const second = registry.forScope(scope(), () => NOW + 1_000);
    expect(second).toBe(first);
    expect(registry.size()).toBe(1);
  });

  it("splits indexes when the connected scope changes", () => {
    const registry = createGroundedContextIndexRegistry({ ttlMs: 60_000, maxScopes: 8 });
    const first = registry.forScope(scope(), () => NOW);
    const second = registry.forScope(scope({ connectedAtMs: NOW + 1 }), () => NOW);
    expect(second).not.toBe(first);
    expect(registry.size()).toBe(2);
  });

  it("clears all indexes for a conversation", () => {
    const registry = createGroundedContextIndexRegistry({ ttlMs: 60_000, maxScopes: 8 });
    registry.forScope(scope({ scopeId: "scope-a" }), () => NOW);
    registry.forScope(scope({ scopeId: "scope-b" }), () => NOW);
    registry.forScope(scope({ conversationId: "chat-2" }), () => NOW);
    registry.clearConversation("chat-1");
    expect(registry.size()).toBe(1);
  });

  it("sweeps expired scope indexes", () => {
    const registry = createGroundedContextIndexRegistry({ ttlMs: 100, maxScopes: 8 });
    registry.forScope(scope(), () => NOW);
    registry.sweep(() => NOW + 101);
    expect(registry.size()).toBe(0);
  });
});
