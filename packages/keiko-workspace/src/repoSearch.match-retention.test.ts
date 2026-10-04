import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs } from "./fs.js";
import { searchText, type SearchScope } from "./repoSearch.js";

let root = "";

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-local-matches-"));
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "local-matches",
    relativePaths: [],
  };
}

function query(maxResults: number): RetrievalQuery {
  return {
    kind: "exact-symbol",
    text: "ThermalAuditReading",
    maxResults,
    caseSensitive: true,
    emittedAtMs: 0,
  };
}

function putReadings(): void {
  writeFileSync(
    join(root, "readings.txt"),
    Array.from(
      { length: 40 },
      (_value, index) => `ThermalAuditReading value-${String(index)}\n`,
    ).join("\n"),
  );
}

describe("per-file matches use the accepted retained-result budget", () => {
  it("retains all forty independent lines when the request admits them", async (): Promise<void> => {
    putReadings();
    const result = await searchText(scope(), query(50));
    expect(result.atoms).toHaveLength(40);
    expect(result.atoms.map((atom) => atom.lineRange?.startLine)).toEqual(
      Array.from({ length: 40 }, (_value, index) => index * 2 + 1),
    );
    expect(result.coverage).toMatchObject({
      filesScanned: 1,
      matchesReturned: 40,
      incomplete: false,
    });
    expect(result.truncated).toBe(false);
  });

  it("reports actual clipping at an explicitly requested retained-result bound", async (): Promise<void> => {
    putReadings();
    const result = await searchText(scope(), query(5));
    expect(result.atoms).toHaveLength(5);
    expect(result.coverage.filesScanned).toBe(1);
    expect(result.coverage.reasons).toEqual(["match-cap"]);
    expect(result.truncated).toBe(true);
  });

  it("matches trusted literals independently of unrelated natural-language ranking terms", async (): Promise<void> => {
    writeFileSync(join(root, "route.txt"), "a/b\n");
    const result = await searchText(
      scope(),
      { ...query(5), kind: "natural-language", text: "Where is the documented route used?" },
      undefined,
      { fs: nodeWorkspaceFs, queryInterpretation: { kind: "literal", terms: ["a/b"] } },
    );
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["route.txt"]);
    expect(result.coverage.matchesReturned).toBe(1);
  });
});
