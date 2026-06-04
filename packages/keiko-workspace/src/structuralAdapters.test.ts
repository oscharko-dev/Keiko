import { describe, expect, it } from "vitest";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { RepoSearchInvalidQueryError } from "./errors.js";
import {
  createDefaultStructuralRegistry,
  runStructuralAdapters,
  type StructuralAdapter,
  type StructuralAdapterRegistry,
} from "./structuralAdapters.js";
import { DEFAULT_SEARCH_LIMITS, type SearchLimits, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW = (): number => 1_700_000_000_000;

function makeScope(): { scope: SearchScope; fs: ReturnType<typeof memFs> } {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
  return { scope: { workspace, scopeId: "scope-1", relativePaths: [] }, fs: memFs(MEM_ROOT, {}) };
}

function nlq(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 100, emittedAtMs: 0 };
}

function fakeAtom(scopePath: string, queryFingerprint: string): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `a-${scopePath}-${queryFingerprint}`,
    scopePath,
    lineRange: undefined,
    score: 0.5,
    provenance: { kind: "structural", tool: "fake-adapter", queryFingerprint },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function fakeAdapter(name: string, atoms: readonly EvidenceAtom[]): StructuralAdapter {
  return {
    name,
    isAvailable: (): Promise<boolean> => Promise.resolve(true),
    lookup: (): Promise<readonly EvidenceAtom[]> => Promise.resolve(atoms),
  };
}

function unavailableAdapter(name: string): StructuralAdapter {
  return {
    name,
    isAvailable: (): Promise<boolean> => Promise.resolve(false),
    lookup: (): Promise<readonly EvidenceAtom[]> => Promise.resolve([]),
  };
}

function throwingAdapter(name: string, err: Error): StructuralAdapter {
  return {
    name,
    isAvailable: (): Promise<boolean> => Promise.resolve(true),
    lookup: (): Promise<readonly EvidenceAtom[]> => Promise.reject(err),
  };
}

describe("createDefaultStructuralRegistry", () => {
  it("contains the three v1 adapters in expected order", () => {
    const registry = createDefaultStructuralRegistry();
    expect(registry.adapters.map((a) => a.name)).toEqual([
      "test-source-pairing",
      "import-graph",
      "git-history",
    ]);
  });
});

describe("runStructuralAdapters", () => {
  it("only invokes available adapters and records unavailable names", async () => {
    const { scope, fs } = makeScope();
    const atom = fakeAtom("src/a.ts", "fp-1");
    const registry: StructuralAdapterRegistry = {
      adapters: [fakeAdapter("alpha", [atom]), unavailableAdapter("beta")],
    };
    const result = await runStructuralAdapters(
      registry,
      scope,
      nlq("x"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    expect(result.atoms.map((a) => a.stableId)).toEqual([atom.stableId]);
    expect(result.unavailable).toEqual(["beta"]);
    expect(result.errored).toEqual([]);
  });

  it("records non-typed errors and continues with other adapters", async () => {
    const { scope, fs } = makeScope();
    const atom = fakeAtom("src/a.ts", "fp-1");
    const registry: StructuralAdapterRegistry = {
      adapters: [throwingAdapter("alpha", new Error("boom")), fakeAdapter("beta", [atom])],
    };
    const result = await runStructuralAdapters(
      registry,
      scope,
      nlq("x"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    expect(result.atoms.map((a) => a.stableId)).toEqual([atom.stableId]);
    expect(result.errored).toEqual([{ name: "alpha", message: "boom" }]);
    expect(result.unavailable).toEqual([]);
  });

  it("propagates typed RepoSearchInvalidQueryError instead of swallowing it", async () => {
    const { scope, fs } = makeScope();
    const registry: StructuralAdapterRegistry = {
      adapters: [throwingAdapter("alpha", new RepoSearchInvalidQueryError("bad"))],
    };
    await expect(
      runStructuralAdapters(registry, scope, nlq("x"), DEFAULT_SEARCH_LIMITS, fs, {
        nowMs: FIXED_NOW,
      }),
    ).rejects.toBeInstanceOf(RepoSearchInvalidQueryError);
  });

  it("dedupes atoms by stableId, keeping the first occurrence", async () => {
    const { scope, fs } = makeScope();
    const shared = fakeAtom("src/a.ts", "fp-1");
    const registry: StructuralAdapterRegistry = {
      adapters: [fakeAdapter("alpha", [shared]), fakeAdapter("beta", [shared])],
    };
    const result = await runStructuralAdapters(
      registry,
      scope,
      nlq("x"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    expect(result.atoms.length).toBe(1);
  });

  it("caps total emitted atoms at limits.maxMatchesReturned", async () => {
    const { scope, fs } = makeScope();
    const atoms = [fakeAtom("a.ts", "fp-1"), fakeAtom("b.ts", "fp-1"), fakeAtom("c.ts", "fp-1")];
    const registry: StructuralAdapterRegistry = {
      adapters: [fakeAdapter("alpha", atoms)],
    };
    const capped: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 2 };
    const result = await runStructuralAdapters(registry, scope, nlq("x"), capped, fs, {
      nowMs: FIXED_NOW,
    });
    expect(result.atoms.length).toBe(2);
  });

  it("records elapsedMs computed from deps.nowMs", async () => {
    const { scope, fs } = makeScope();
    let t = 1_000;
    const clock: () => number = () => {
      const out = t;
      t += 25;
      return out;
    };
    const registry: StructuralAdapterRegistry = { adapters: [fakeAdapter("alpha", [])] };
    const result = await runStructuralAdapters(
      registry,
      scope,
      nlq("x"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: clock,
      },
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(25);
  });

  it("caps atoms at min(limits.maxMatchesReturned, query.maxResults), honoring the tighter bound", async () => {
    const { scope, fs } = makeScope();
    const atoms = [
      fakeAtom("a.ts", "fp-1"),
      fakeAtom("b.ts", "fp-1"),
      fakeAtom("c.ts", "fp-1"),
      fakeAtom("d.ts", "fp-1"),
    ];
    const registry: StructuralAdapterRegistry = { adapters: [fakeAdapter("alpha", atoms)] };
    // limits.maxMatchesReturned = 3, query.maxResults = 2 → effective cap = 2
    const limitsWide: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 3 };
    const queryNarrow = { kind: "natural-language" as const, text: "x", caseSensitive: false, maxResults: 2, emittedAtMs: 0 };
    const result = await runStructuralAdapters(registry, scope, queryNarrow, limitsWide, fs, {
      nowMs: FIXED_NOW,
    });
    expect(result.atoms.length).toBe(2);
    // Also verify the reverse: limits.maxMatchesReturned = 2, query.maxResults = 5 → cap = 2
    const limitsNarrow: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 2 };
    const queryWide = { ...queryNarrow, maxResults: 5 };
    const result2 = await runStructuralAdapters(registry, scope, queryWide, limitsNarrow, fs, {
      nowMs: FIXED_NOW,
    });
    expect(result2.atoms.length).toBe(2);
  });

});
