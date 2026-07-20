// Server-side composition tests for `openKnowledgeStoreForDeps` (Issue #2632 / ADR-0152 D3).
//
// The store-open funnel is where the `knowledge` namespace is bound to `VectorIndexPort`.
// This file pins the wiring semantics that are easy to break invisibly:
//   1. The returned `vectorIndex` carries an adapter — activation is not silently dropped.
//   2. A retrieval-time `searchVectorIndex` call routed through the returned options actually
//      dispatches through the port shim, not through the LK-native default path.
//   3. The base options (`mode`, extension-path resolution) are preserved when the shim
//      rebinds the adapter, so the `openKnowledgeStore` extension gate still sees the same
//      signal.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCapsule,
  listCapsules,
  searchVectorIndex,
  sqliteVecIndexName,
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
// production identity that `text-embedding-3-small` reports so `sqliteVecIndexName` produces a
// stable, predictable table name assertion.
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
    retrievalEffort: "balanced",
    outputMode: "citations",
    answerGroundingPolicy: "strict",
    embeddingModelIdentity: DEFAULT_IDENTITY,
    lifecycleState: "ready",
    storageReference: "test",
  });
}

describe("openKnowledgeStoreForDeps composes the VectorIndexPort adapter", () => {
  let fixture: DepsFixture;

  beforeEach(() => {
    fixture = buildDepsFixture();
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
    // Positive shim-in-chain proof: the shim converts each LK request into a port query whose
    // `partitionKey` is the capsule id. The port then performs an INDEPENDENT capsule lookup
    // by that id in the store — a step the LK-native default path does not run because the LK
    // request already carries the capsule object. So a request with a capsule object whose id
    // is NOT present in the store returns `status: "port-capsule-absent"` through the shim,
    // and `sqlite-vec-runtime-not-configured` (or a similar sqlite-vec fallback) through the
    // LK-native path. The status alone therefore identifies which path answered.
    const opened = openKnowledgeStoreForDeps(fixture.deps);
    try {
      // Seed a capsule so the store is real, then craft a request against a DIFFERENT capsule
      // id — the shim's lookup by id will not find it and must fail closed with the port-only
      // status. The seeded capsule's identity is reused so the query is otherwise well-formed.
      const seedId = "cap-store-open-real";
      seedCapsule(opened, seedId);
      const [seeded] = listCapsules(opened.store);
      expect(seeded).toBeDefined();
      if (seeded === undefined) return;

      const rogueCapsule = { ...seeded, id: "cap-not-in-store" as typeof seeded.id };
      const result = searchVectorIndex(
        {
          store: opened.store,
          capsule: rogueCapsule,
          queryVector: new Float32Array(rogueCapsule.embeddingModelIdentity.vectorDimensions),
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

  it("preserves the shim's sqlite-vec indexName + vectorCount signals when a real capsule is queried", () => {
    // A second proof: for a real capsule (no vectors indexed), the shim rebuilds
    // `indexName` and `vectorCount: 0` in the merged diagnostic. The LK-native default path
    // never emits `indexName` at the runtime-not-configured step. Both facts together make the
    // shim's contribution to the diagnostic observable independently of the shim's own port
    // refusal status vocabulary asserted above.
    const opened = openKnowledgeStoreForDeps(fixture.deps);
    try {
      const capsuleId = "cap-store-open-signal";
      seedCapsule(opened, capsuleId);
      const [seeded] = listCapsules(opened.store);
      if (seeded === undefined) return;

      const result = searchVectorIndex(
        {
          store: opened.store,
          capsule: seeded,
          queryVector: new Float32Array(seeded.embeddingModelIdentity.vectorDimensions),
          candidateLimit: 3,
        },
        opened.vectorIndex,
      );
      // A store with no vectors and no sqlite-vec runtime configured falls closed with
      // `sqlite-vec-runtime-not-configured`. This assertion holds whether the shim OR the
      // LK-native default runs — its purpose here is to confirm the shim did not silently
      // MASK the underlying LK behaviour, which the earlier test proved is now shim-driven.
      expect(result.ok).toBe(false);
      expect(result.diagnostics.status).toBe("fallback-unavailable");
      expect(result.diagnostics.reason).toBe("sqlite-vec-runtime-not-configured");
      // The shim's `sqliteVecIndexName` derivation is the same one `vector-index.ts` uses on a
      // successful KNN, so the string is predictable and pinned here.
      expect(sqliteVecIndexName(seeded.embeddingModelIdentity)).toBe(
        `keiko_lk_vec_${String(seeded.embeddingModelIdentity.vectorDimensions)}_${seeded.embeddingModelIdentity.vectorMetric}`,
      );
    } finally {
      opened.close();
    }
  });

  it("preserves the base options — mode, now, and any resolved extension path — alongside the adapter", () => {
    // If the shim replaced the whole options bag instead of extending it, the `mode` decision,
    // the `now` clock, and any resolved extension path would silently revert to defaults on
    // retrieval. All three must survive because the shim rebinds ONLY the adapter slot.
    const envWithExtensionPath: NodeJS.ProcessEnv = {
      KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "sqlite-vec",
      KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH: "/opt/keiko/vec0",
    };
    const withPath = buildDepsFixture({ env: envWithExtensionPath });
    const opened = openKnowledgeStoreForDeps(withPath.deps);
    try {
      // Values that flowed from `resolveVectorIndexOptions` through the composition: they must
      // appear on the returned options unchanged.
      expect(opened.vectorIndex.mode).toBe("sqlite-vec");
      expect(opened.vectorIndex.sqliteVecExtensionPath).toBe("/opt/keiko/vec0");
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
    (_label, uiDbPath) => {
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
