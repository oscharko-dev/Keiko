import { describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import { fingerprintFor, queryIdentityFor } from "./repoSearchMatchers.js";
import {
  createWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceIndexSnapshot,
} from "./workspaceIndex.js";

const query: RetrievalQuery = {
  kind: "natural-language",
  text: "Trace authorization. Cite implementation files and lines.",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};

function scope(): SearchScope {
  return {
    scopeId: "subject-normalization",
    relativePaths: [],
    workspace: {
      root: "/ws",
      selectedRoot: "/ws",
      name: "subject",
      version: "0.0.0",
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}

function priorSubjectRevision(index: WorkspaceIndex): WorkspaceIndex {
  return {
    saveSnapshot: index.saveSnapshot,
    loadSnapshot: async (key, isActive): Promise<WorkspaceIndexSnapshot | undefined> => {
      const snapshot = await index.loadSnapshot(key, isActive);
      if (snapshot === undefined) return undefined;
      return {
        ...snapshot,
        records: snapshot.records.map((record) => ({
          ...record,
          ...(record.queryMatch === undefined
            ? {}
            : {
                // Simulated prior-revision negative with unchanged file metadata.
                queryMatch: {
                  queryIdentitySha256:
                    "f13a70e9a38505674a22501f377a141fac774f6c5cad5f654ff48ae60e898991",
                  best: [],
                  maxScore: 0,
                },
              }),
        })),
      };
    },
  };
}

describe("repository query subject diagnostics", () => {
  it.each([null, 20])(
    "observes removed clauses on streamed and bounded scans: %s",
    async (maxFilesScanned) => {
      const result = await searchText(
        scope(),
        query,
        { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned },
        {
          fs: memFs("/ws", {
            "src/authorization.ts":
              "export function authorizeRequest(policy) { return policy.allowed; }\n",
          }),
        },
      );
      expect(result.diagnostics?.citationDirectiveClauseCount).toBe(1);
    },
  );

  it("does not report normalization for trusted literal matching", async () => {
    const result = await searchText(scope(), query, DEFAULT_SEARCH_LIMITS, {
      fs: memFs("/ws", { "manual.txt": "authorizeRequest\n" }),
      queryInterpretation: { kind: "literal", terms: ["authorizeRequest"] },
    });
    expect(result.diagnostics?.citationDirectiveClauseCount).toBeUndefined();
  });

  it("rereads a prior-revision negative before reusing the corrected persistent match", async () => {
    const fs = memFs("/ws", {
      "src/authorization.ts":
        "export function authorizeRequest(policy) { return policy.allowed; }\n",
    });
    const reads = vi.spyOn(fs, "readFileBytes");
    const index = createWorkspaceIndex();
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null, elapsedMsMax: null };
    const cold = await searchText(scope(), query, limits, {
      fs,
      workspaceIndex: index,
      nowMs: () => 0,
    });
    expect(cold.atoms.length).toBeGreaterThan(0);
    expect(cold.workspaceIndex?.indexedRecords).toBe(1);
    reads.mockClear();
    const migrated = await searchText(scope(), query, limits, {
      fs,
      workspaceIndex: priorSubjectRevision(index),
      nowMs: () => 0,
    });
    expect(migrated.atoms).toEqual(cold.atoms);
    expect(migrated.workspaceIndex).toMatchObject({ indexedRecords: 1, reusedRecords: 0 });
    expect(reads).toHaveBeenCalledOnce();
    reads.mockClear();
    const warm = await searchText(scope(), query, limits, {
      fs,
      workspaceIndex: index,
      nowMs: () => 0,
    });
    expect(warm.atoms).toEqual(cold.atoms);
    expect(warm.workspaceIndex?.reusedRecords).toBe(1);
    expect(reads).not.toHaveBeenCalled();
    expect(warm.diagnostics?.citationDirectiveClauseCount).toBe(1);
  });

  it("invalidates prior persistent natural-language matches while preserving other identities", () => {
    const settings = { effectiveMaxMatchesReturned: 20, policyIntent: "targeted-code-search" };
    // Frozen outputs of the pre-correction compiled producer, not a reimplementation of its hash.
    expect(queryIdentityFor(query, undefined, settings)).not.toBe(
      "6652b0a39a099c340b8c360f9ba784db36d7142fa808d0ce49a62b55751d95ba",
    );
    // Revision 1 compiled producer: compound hints did not receive observed whole-term scoring.
    expect(queryIdentityFor(query, undefined, settings)).not.toBe(
      "f13a70e9a38505674a22501f377a141fac774f6c5cad5f654ff48ae60e898991",
    );
    expect(fingerprintFor(query)).toBe("4db3fdc61744f46d");
    expect(
      queryIdentityFor(
        { ...query, kind: "exact-symbol", text: "authorizeRequest" },
        undefined,
        settings,
      ),
    ).toBe("9494efdcef8aae99d9ea1d2ca51817ed4dfa74e0a5f6b6e9ec69515e98e1063a");
    expect(
      queryIdentityFor(query, { kind: "literal", terms: ["authorizeRequest"] }, settings),
    ).toBe("39d5d759e1ac266817281a6d3598d623adf41444e564323e48d76c7f3f4d80cd");
  });
});
