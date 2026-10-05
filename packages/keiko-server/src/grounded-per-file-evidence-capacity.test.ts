import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { buildGroundedGatewayMessages, buildQuery } from "./grounded-qa.js";
import { selectGroundedEvidenceAtoms } from "./grounded-evidence-selection.js";
import {
  _readKeptExcerptsForTests,
  retrieveConnectedContextPack,
} from "./grounded-orchestrator.js";

const NOW = 1_784_653_600_000;
const COUNT = 40;
const QUESTION =
  "Welche Werte sind für ThermalReadingProbe dokumentiert? Belege jeden gelesenen Wert mit Datei und Zeile.";
let root = "";

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-per-file-capacity-"));
  const lines = Array.from({ length: COUNT * 12 }, (_value, index) =>
    index % 12 === 0 ? `ThermalReadingProbe value-${String(10000 + index / 12)}` : "",
  );
  writeFileSync(join(root, "readings.txt"), `${lines.join("\n")}\n`);
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

function atoms(): readonly EvidenceAtom[] {
  return Array.from({ length: COUNT }, (_value, index) => ({
    schemaVersion: "1",
    stableId: `reading-${String(index)}`,
    scopePath: "readings.txt",
    lineRange: { startLine: index * 12 + 1, endLine: index * 12 + 1 },
    score: 1,
    provenance: {
      kind: "lexical-search",
      tool: "repo.searchText",
      queryFingerprint: "per-file-capacity",
    },
    redactionState: "redacted",
    emittedAtMs: NOW,
    ledgerRef: undefined,
  }));
}

function assertAllValues(content: string): void {
  for (let index = 0; index < COUNT; index += 1)
    expect(content).toContain(`ThermalReadingProbe value-${String(10000 + index)}`);
}

describe("per-file evidence follows accepted total capacity", () => {
  it("keeps every already-admitted distinct source range for the selected path", (): void => {
    expect(
      selectGroundedEvidenceAtoms(atoms(), new Set(["readings.txt"]), "per-file-capacity"),
    ).toHaveLength(COUNT);
  });

  it("puts every admitted separated fact into the actual gateway prompt when it fits", async (): Promise<void> => {
    const { pack } = await retrieveConnectedContextPack(
      {
        workspaceRoot: root,
        scope: {
          schemaVersion: "1",
          scopeId: "per-file-capacity",
          workspaceRoot: root,
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
          conversationId: "chat",
          connectedAtMs: NOW,
        },
        query: buildQuery(QUESTION, () => NOW),
      },
      {
        correlationId: undefined,
        nowMs: () => NOW,
        answerer: {
          answer: (): Promise<string> => Promise.reject(new Error("Unexpected model call")),
        },
      },
    );
    const messages = buildGroundedGatewayMessages(QUESTION, pack, (value) => value);
    assertAllValues(JSON.stringify(messages));
    expect(pack.files).toHaveLength(1);
    expect(pack.diagnostics?.coverage).toMatchObject({ filesScanned: 1, incomplete: false });
    expect(pack.usage.excerptBytes).toBeLessThan(pack.budget.excerptBytesMax);
    expect(countGatewayPromptTokens({ messages })).toBeLessThan(pack.budget.modelInputTokensMax);
    expect(pack.uncertainty).toEqual([]);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("reads every independently selected range within the cumulative byte grant", async (): Promise<void> => {
    const result = await _readKeptExcerptsForTests(["readings.txt"], {
      searchScope: {
        workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
        scopeId: "per-file-capacity",
        relativePaths: [],
      },
      fs: nodeWorkspaceFs,
      budget: DEFAULT_EXPLORATION_BUDGET,
      initialUsage: {
        searchCalls: 0,
        filesRead: 0,
        excerptBytes: 0,
        modelInputTokens: 0,
        modelOutputTokens: 0,
        rerankCalls: 0,
        elapsedMs: 0,
      },
      atomsByPath: new Map([["readings.txt", atoms()]]),
      nowMs: () => NOW,
      deadlineAtMs: Infinity,
    });
    assertAllValues(JSON.stringify(result.excerpts.get("readings.txt")));
    expect(result.readWindowCount).toBe(COUNT);
    expect(result.uncertainty).toEqual([]);
  });
});
