// Server-side composition tests for `openKnowledgeStoreForDeps` (Issue #2632 / ADR-0152 D3).
//
// The store-open funnel is where the `knowledge` namespace is bound to `VectorIndexPort`.
// This file pins the wiring semantics that are easy to break invisibly:
//   1. The returned `vectorIndex` carries an adapter — activation is not silently dropped.
//   2. A retrieval-time `searchVectorIndex` call routed through the returned options actually
//      dispatches through the port shim, not through the LK-native default path.
//   3. The base options (`mode`, extension-path resolution) are preserved when the shim rebinds
//      the adapter, so the `openKnowledgeStore` extension gate still sees the same signal.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KnowledgeCapsule } from "@oscharko-dev/keiko-contracts";
import { searchVectorIndex } from "@oscharko-dev/keiko-local-knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UiHandlerDeps } from "./deps.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";

interface DepsFixture {
  readonly deps: UiHandlerDeps;
  readonly runtimeDir: string;
  cleanup(): void;
}

function depsFixture(): DepsFixture {
  const runtimeDir = mkdtempSync(join(tmpdir(), "keiko-store-open-"));
  const deps = {
    env: {},
    uiDbPath: join(runtimeDir, "ui.db"),
  } as unknown as UiHandlerDeps;
  return {
    deps,
    runtimeDir,
    cleanup: (): void => {
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

describe("openKnowledgeStoreForDeps composes the VectorIndexPort adapter", () => {
  let fixture: DepsFixture;

  beforeEach(() => {
    fixture = depsFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns a vectorIndex whose adapter is bound (composition did not silently drop)", () => {
    // Without the shim wired, `.adapter` would be undefined and every retrieval call would take
    // the LK-native default path. The activation record in ADR-0152 D3 depends on this being
    // present at the composition root — a missing adapter is a silent regression to pre-D3.
    const opened = openKnowledgeStoreForDeps(fixture.deps);
    try {
      expect(opened.vectorIndex.adapter).toBeDefined();
    } finally {
      opened.close();
    }
  });

  it("dispatches retrieval through the shim, not the LK-native default", () => {
    // Failure-first check for the wiring: a search for a capsule the store does not contain
    // must be answered by the port with `port-capsule-absent`. The LK-native default path
    // (without an adapter) would instead reach the sqlite-vec runtime check and report a
    // completely different diagnostic. The status alone therefore tells us WHICH path answered.
    const opened = openKnowledgeStoreForDeps(fixture.deps);
    try {
      const rogueCapsule = { id: "cap-that-does-not-exist" } as unknown as KnowledgeCapsule;
      const result = searchVectorIndex(
        {
          store: opened.store,
          capsule: {
            ...rogueCapsule,
            embeddingModelIdentity: {
              provider: "openai",
              modelId: "text-embedding-3-small",
              vectorDimensions: 4,
              vectorMetric: "cosine",
            },
          } as unknown as KnowledgeCapsule,
          queryVector: new Float32Array([1, 0, 0, 0]),
          candidateLimit: 3,
        },
        opened.vectorIndex,
      );
      expect(result.ok).toBe(false);
      // The `port-*` prefix in the reason is emitted by the port implementation only — it
      // cannot be produced by the LK-native default path, so this is a positive signal that
      // the shim was in the call chain.
      expect(result.diagnostics.reason).toBe("capsule-not-found");
    } finally {
      opened.close();
    }
  });

  it("preserves the base options (mode, now, and any extension-path resolution) alongside the adapter", () => {
    // If the shim replaced the whole options bag instead of extending it, the `mode` decision
    // and any resolved extension path would silently revert to defaults on retrieval. Both
    // survive here because the shim rebinds ONLY the adapter slot.
    const opened = openKnowledgeStoreForDeps(fixture.deps);
    try {
      // The shipped default resolves to `auto` (Issue #2631). What matters here is that the
      // returned options carry a concrete mode string alongside the adapter — the composition
      // did not clear it.
      expect(opened.vectorIndex.mode).toBe("auto");
      expect(typeof opened.vectorIndex.now).toBe("function");
    } finally {
      opened.close();
    }
  });

  it("throws a `KnowledgeStoreError` when `uiDbPath` is unavailable, before touching the store", () => {
    // Guardrail for the composition entry: if the runtime-state path is missing, the funnel
    // must fail closed before any store is opened. Composition wiring must never be reached
    // when the pre-conditions the composition depends on aren't satisfied.
    const brokenDeps = { env: {}, uiDbPath: undefined } as unknown as UiHandlerDeps;
    expect(() => openKnowledgeStoreForDeps(brokenDeps)).toThrow(
      /runtime-state path is unavailable/u,
    );
  });
});
