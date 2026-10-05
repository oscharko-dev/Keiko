import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type SelectedScopeKind,
  type ValidationResult,
} from "./connected-context.js";

function largeSelectedPack(kind: SelectedScopeKind): ConnectedContextPack {
  const paths = Array.from({ length: 5_000 }, (_, index) => `records/file-${String(index)}.txt`);
  return {
    schemaVersion: "1",
    stableId: "selected-path-work",
    scope: {
      schemaVersion: "1",
      scopeId: "selected-path-work",
      workspaceRoot: "/synthetic/selected-paths",
      kind,
      relativePaths: kind === "files" ? paths : [],
      conversationId: undefined,
      connectedAtMs: 1,
    },
    query: {
      kind: "natural-language",
      text: "Inspect the selected sources",
      caseSensitive: false,
      maxResults: 1,
      emittedAtMs: 1,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: {
      searchCalls: 0,
      filesRead: paths.length,
      excerptBytes: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    files: paths.map((scopePath) => ({
      scopePath,
      role: "read-only",
      selectionReason: "selected",
      excerpts: [],
    })),
    omitted: [],
    uncertainty: [],
    emittedAtMs: 1,
    ledgerRef: undefined,
  };
}

function measureSelectedPrefixComparisons(pack: ConnectedContextPack): {
  readonly validation: ValidationResult;
  readonly comparisons: number;
} {
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "startsWith");
  if (descriptor === undefined) throw new TypeError("String prefix descriptor missing");
  const original: unknown = descriptor.value;
  if (typeof original !== "function") throw new TypeError("String prefix method missing");
  let comparisons = 0;
  Object.defineProperty(String.prototype, "startsWith", {
    ...descriptor,
    value: function (this: string, search: string, position?: number): boolean {
      if (Reflect.apply(original, search, ["records/"]) === true && search.endsWith("/"))
        comparisons += 1;
      return Reflect.apply(original, this, [search, position]) === true;
    },
  });
  try {
    // Verify the measurement seam without retaining millions of spy argument arrays.
    "records/control/file.txt".startsWith("records/control/");
    return { validation: validateConnectedContextPack(pack), comparisons };
  } finally {
    Object.defineProperty(String.prototype, "startsWith", descriptor);
  }
}

describe("selected-path validation work", () => {
  it.each(["workspace-root", "files"] as const)(
    "avoids pairwise prefix scans for 5000 selected files in %s scope",
    (kind): void => {
      const pack = largeSelectedPack(kind);
      const measured = measureSelectedPrefixComparisons(pack);
      expect(measured.validation).toEqual({ ok: true });
      expect(measured.comparisons).toBeGreaterThan(0);
      expect(measured.comparisons).toBeLessThanOrEqual(pack.files.length * 4);
    },
  );
  it.each([
    ["records/direct/inside.txt", "records/direct", false],
    ["records/direct", "records/direct/nested/inside.txt", true],
    ["records/direct", "records/direct-other/inside.txt", false],
  ] as const)(
    "preserves directional containment from %s to %s",
    (selected, candidate, allowed): void => {
      const base = largeSelectedPack("files");
      const pack: ConnectedContextPack = {
        ...base,
        scope: { ...base.scope, relativePaths: [selected] },
        files: [
          { scopePath: candidate, role: "read-only", selectionReason: "selected", excerpts: [] },
        ],
      };
      const result = validateConnectedContextPack(pack);
      expect(result.ok).toBe(allowed);
      if (!result.ok)
        expect(result.reasons).toContain("pack.files entry falls outside selected scope");
    },
  );
});
