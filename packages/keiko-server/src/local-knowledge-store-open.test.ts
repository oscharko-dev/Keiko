// Server-side composition tests for `openKnowledgeStoreForDeps` (Issue #2632 / ADR-0152 D3).
//
// The store-open funnel is where the `knowledge` namespace is bound to `VectorIndexPort`.
// This file pins the wiring semantics that are easy to break invisibly:
//   1. The returned `vectorIndex` carries an adapter — activation is not silently dropped.
//   2. A retrieval-time `searchVectorIndex` call routed through the returned options actually
//      dispatches through the port shim, not through the LK-native default path.
//   3. The base options (`mode`, native-runtime path resolution) are preserved when the shim
//      rebinds the adapter.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCapsule,
  listCapsules,
  searchVectorIndex,
} from "@oscharko-dev/keiko-local-knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import {
  openKnowledgeStoreForDeps,
  type OpenKnowledgeStoreForDeps,
} from "./local-knowledge-store-open.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/db.js";

// The default embedding identity used to seed a capsule inside the store. Matches the shipped
// production identity that `text-embedding-3-small` reports so the derived vector partition
// name is stable and predictable across runs.
const DEFAULT_IDENTITY = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
} as const;

interface DepsFixture {
  readonly deps: UiHandlerDeps;
  readonly runtimeDir: string;
  cleanup(): void;
}

interface DepsOverrides {
  readonly uiDbPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

// Full `UiHandlerDeps` fixture built from the same primitives production uses (empty in-memory
// UI store, a bare redactor, a fresh run registry, and a nulled model-port factory). Callers
// override only what they need, keeping the shape typed rather than double-cast. Explicit
// `uiDbPath: undefined` (or `""`) is honoured — the fixture uses `in overrides` so callers can
// distinguish "not passed" from "passed as undefined" and exercise the fail-closed guardrail.
function buildDepsFixture(overrides: DepsOverrides = {}): DepsFixture {
  const runtimeDir = mkdtempSync(join(tmpdir(), "keiko-store-open-"));
  const uiDbPath: string | undefined =
    "uiDbPath" in overrides ? overrides.uiDbPath : join(runtimeDir, "ui.db");
  const deps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: overrides.env ?? {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    // `uiDbPath` on `UiHandlerDeps` is `string | undefined`; the guardrail branch under test is
    // "not usable" — either omitted or empty — so both are represented faithfully here.
    ...(uiDbPath === undefined ? {} : { uiDbPath }),
  };
  return {
    deps,
    runtimeDir,
    cleanup: (): void => {
      deps.store.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

// Adds a real capsule with the default identity so the store-open composition can reach the
// port on a capsule that actually exists. The capsule id is used by callers to build queries.
function seedCapsule(opened: OpenKnowledgeStoreForDeps, capsuleId: string): void {
  createCapsule(opened.store, {
    id: capsuleId as unknown as Parameters<typeof createCapsule>[1]["id"],
    displayName: "port-test-capsule",
    tags: [],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "require-citations",
    embeddingModelIdentity: DEFAULT_IDENTITY,
    lifecycleState: "ready",
    storageReference: "test",
  });
}

describe("openKnowledgeStoreForDeps composes the VectorIndexPort adapter", (): void => {
  let fixture: DepsFixture;

  beforeEach((): void => {
    fixture = buildDepsFixture();
  });

  afterEach((): void => {
    fixture.cleanup();
  });

  it("returns a vectorIndex whose adapter is bound (composition did not silently drop)", (): void => {
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

  it("dispatches retrieval through the shim, not the LK-native default", async (): Promise<void> => {
    // Positive shim-in-chain proof: the shim converts each LK request into a port query whose
    // `partitionKey` is the capsule id. The port then performs an INDEPENDENT capsule lookup
    // by that id in the store — a step the LK-native default path does not run because the LK
    // request already carries the capsule object. So a request with a capsule object whose id
    // is NOT present in the store makes the port emit `status: "port-capsule-absent"` with
    // `reason: "capsule-not-found"`. That status is outside the LK-native
    // `RetrievalVectorIndexDiagnostics.status` enum, so the shim's `toLkStatus` projection
    // rewrites it to the enum's default (`fallback-query-error`) while `reason` survives
    // verbatim. The LK-native default path (no shim) would instead reach the built-in index
    // runtime probe on this same request, so the exact `fallback-query-error / capsule-not-found`
    // pairing is only reachable when the shim is in the call chain.
    const opened = openKnowledgeStoreForDeps(fixture.deps);
    try {
      // Seed a capsule so the store is real, then craft a request against a DIFFERENT capsule
      // id — the shim's lookup by id will not find it and must fail closed. The seeded
      // capsule's identity is reused so the query is otherwise well-formed.
      const seedId = "cap-store-open-real";
      seedCapsule(opened, seedId);
      const [seeded] = listCapsules(opened.store);
      expect(seeded).toBeDefined();
      if (seeded === undefined) return;

      const rogueCapsule = { ...seeded, id: "cap-not-in-store" as typeof seeded.id };
      const result = await searchVectorIndex(
        {
          store: opened.store,
          capsule: rogueCapsule,
          queryVector: new Float32Array(rogueCapsule.embeddingModelIdentity.vectorDimensions).fill(
            1,
          ),
          candidateLimit: 3,
        },
        opened.vectorIndex,
      );
      expect(result.ok).toBe(false);
      expect(result.diagnostics.status).toBe("fallback-query-error");
      expect(result.diagnostics.reason).toBe("capsule-not-found");
    } finally {
      opened.close();
    }
  });

  it("keeps exact search available for a real empty capsule without a native runtime", async (): Promise<void> => {
    // The shim must not silently MASK the underlying LK behaviour when it CAN reach the LK
    // path. On a real capsule with no vectors indexed and no USearch runtime configured,
    // the shim's port call reaches the shared service's deterministic exact crossover. That path
    // does not require the native HNSW runtime and must remain available after composition.
    const opened = openKnowledgeStoreForDeps(fixture.deps);
    try {
      const capsuleId = "cap-store-open-signal";
      seedCapsule(opened, capsuleId);
      const [seeded] = listCapsules(opened.store);
      if (seeded === undefined) return;

      const result = await searchVectorIndex(
        {
          store: opened.store,
          capsule: seeded,
          queryVector: new Float32Array(seeded.embeddingModelIdentity.vectorDimensions).fill(1),
          candidateLimit: 3,
        },
        opened.vectorIndex,
      );
      expect(result.ok).toBe(true);
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics).toMatchObject({
        provider: "usearch",
        status: "available",
        searchMode: "exact",
      });
    } finally {
      opened.close();
    }
  });

  it("preserves mode, clock, and any resolved native-runtime path alongside the adapter", (): void => {
    // If the shim replaced the whole options bag instead of extending it, the `mode` decision,
    // the `now` clock, and any resolved native-runtime path would silently revert to defaults on
    // retrieval. All three must survive because the shim rebinds ONLY the adapter slot.
    const envWithRuntimePath: NodeJS.ProcessEnv = {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "usearch",
      KEIKO_USEARCH_BINARY_PATH: "/opt/keiko/usearch.node",
    };
    const withPath = buildDepsFixture({ env: envWithRuntimePath });
    const opened = openKnowledgeStoreForDeps(withPath.deps);
    try {
      // Values that flowed from `resolveVectorIndexOptions` through the composition: they must
      // appear on the returned options unchanged.
      expect(opened.vectorIndex.mode).toBe("usearch");
      expect(opened.vectorIndex.usearchBinaryPath).toBe("/opt/keiko/usearch.node");
      expect(typeof opened.vectorIndex.now).toBe("function");
    } finally {
      opened.close();
      withPath.cleanup();
    }
  });

  // Both branches of the fail-closed precondition. `undefined` AND `""` must fail closed with
  // the same error, because `uiDbPath` is derived from a broader UI runtime-state resolution
  // that yields either an empty string or nothing when nothing is configured.
  it.each([
    ["undefined", undefined],
    ["empty string", ""],
  ])(
    "throws a `KnowledgeStoreError` when `uiDbPath` is %s, before touching the store",
    (_label, uiDbPath): void => {
      const broken = buildDepsFixture({ uiDbPath });
      try {
        expect(() => openKnowledgeStoreForDeps(broken.deps)).toThrow(
          /runtime-state path is unavailable/u,
        );
      } finally {
        broken.cleanup();
      }
    },
  );
});
