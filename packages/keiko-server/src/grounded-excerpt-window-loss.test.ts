import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { _readKeptExcerptsForTests } from "./grounded-orchestrator.js";

let root = "";
beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-window-loss-"));
});
afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

function atom(line: number): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `window-${String(line)}`,
    scopePath: "readings.txt",
    lineRange: { startLine: line, endLine: line },
    score: 1,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "windows" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

describe("selected excerpt windows lost to a genuine byte budget", () => {
  it("accounts every selected window skipped after the file consumes its grant", async (): Promise<void> => {
    const row = `documented-value ${"x".repeat(100)}`;
    const lines = Array.from({ length: 24 }, (_value, index) =>
      index % 10 === 0 ? row : "source context",
    );
    writeFileSync(join(root, "readings.txt"), `${lines.join("\n")}\n`);
    const result = await _readKeptExcerptsForTests(["readings.txt"], {
      searchScope: {
        workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
        scopeId: "window-loss",
        relativePaths: [],
      },
      fs: nodeWorkspaceFs,
      budget: { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 64 },
      initialUsage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        rerankCalls: 0,
        elapsedMs: 0,
      },
      atomsByPath: new Map([["readings.txt", [atom(1), atom(11), atom(21)]]]),
      nowMs: () => 0,
      deadlineAtMs: Infinity,
    });
    expect(result.readWindowCount).toBe(1);
    expect(result.excerpts.get("readings.txt")?.[0]?.content).toHaveLength(64);
    expect(result.uncertainty).toHaveLength(1);
    expect(result.uncertainty[0]?.kind).toBe("scope-incomplete");
    expect(result.uncertainty[0]?.claim).toContain("omitted 2 additional matching range(s)");
    expect(result.uncertainty[0]?.claim).toContain("truncated 1 selected range(s)");
  });
});
