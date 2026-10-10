import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type EvidenceAtom,
  type ExplorationUsage,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack } from "@oscharko-dev/keiko-workflows";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { buildRedactor } from "./deps.js";
import { _readKeptExcerptsForTests, type ExcerptReadSummary } from "./grounded-orchestrator.js";
import { fittedGroundedGatewayPrompt } from "./grounded-qa.js";
import type { SentGroundedPrompt } from "./grounded-prompt-context.js";

const ROOT = "/workspace/read-window-priority";
const PATH = "src/pipeline.ts";
const QUESTION = "Trace source admission and prompt fitting through the request pipeline.";
const WEAK = "export const incidental = 'Unrelated request state';";
const STRONG = "export const admission = 'Selected source validation precedes prompt fitting';";
const SECOND = "export const fitting = 'Only the actually sent source ranges support citations';";

function source(): string {
  const lines = Array.from(
    { length: 340 },
    (_unused, index) => `// incidental filler ${String(index + 1)} ${"x".repeat(24)}`,
  );
  lines[9] = WEAK;
  lines[300] = STRONG;
  lines[320] = SECOND;
  return lines.join("\n");
}

function located(line: number, score: number, tool = "repo.searchText"): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `${tool}-${String(line)}`,
    scopePath: PATH,
    lineRange: { startLine: line, endLine: line },
    score,
    provenance: {
      kind: tool === "repo.searchText" ? "lexical-search" : "structural",
      tool,
      queryFingerprint: "read-window-priority",
    },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function listing(): EvidenceAtom {
  return {
    ...located(1, 1),
    stableId: "path-only-listing",
    lineRange: undefined,
    provenance: {
      kind: "file-listing",
      tool: "repo.findFiles",
      queryFingerprint: "read-window-priority",
    },
  };
}

function scope(): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId: "read-window-priority",
    workspaceRoot: ROOT,
    kind: "workspace-root",
    relativePaths: [],
    connectedAtMs: 0,
    conversationId: undefined,
  };
}

function workspace(): WorkspaceInfo {
  return {
    root: ROOT,
    selectedRoot: ROOT,
    name: "read window fixture",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function zeroUsage(): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    elapsedMs: 0,
    rerankCalls: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
  };
}

interface ReadAndFitResult {
  readonly read: ExcerptReadSummary;
  readonly pack: ConnectedContextPack;
  readonly sent: SentGroundedPrompt;
}

async function readAndFit(
  atoms: readonly EvidenceAtom[],
  excerptBytesMax: number,
): Promise<ReadAndFitResult> {
  const budget = { ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax };
  const read = await _readKeptExcerptsForTests([PATH], {
    searchScope: { workspace: workspace(), scopeId: scope().scopeId, relativePaths: [] },
    fs: memFs(ROOT, { [PATH]: source() }),
    budget,
    initialUsage: zeroUsage(),
    atomsByPath: new Map([[PATH, atoms]]),
    nowMs: () => 0,
    deadlineAtMs: Infinity,
  });
  const { pack } = await assembleContextPack(
    {
      scope: scope(),
      query: {
        kind: "natural-language",
        text: QUESTION,
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: 0,
      },
      budget,
      atoms,
      ranked: [{ scopePath: PATH, score: 1, signals: [], omitted: undefined }],
      omittedFromRanking: read.omitted ?? [],
      excerpts: read.excerpts,
      initialUncertainty: read.uncertainty,
    },
    { includeSurroundingContext: true, nowMs: () => 0 },
  );
  expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  const sent = fittedGroundedGatewayPrompt(QUESTION, pack, buildRedactor({}));
  return { read, pack, sent };
}

function sentText(result: ReadAndFitResult): string {
  return result.sent.messages.map((message) => message.content).join("\n");
}

describe("located window ownership before actual source reads", () => {
  it.each([false, true])(
    "retains the stronger late body despite a higher path-only score: reverse=%s",
    async (reverse) => {
      const atoms = [listing(), located(10, 0.1), located(301, 0.9)];
      if (reverse) atoms.reverse();
      const result = await readAndFit(atoms, 512);
      expect(result.read.excerpts.get(PATH)?.[0]?.startLine).toBeGreaterThan(200);
      expect(sentText(result)).toContain(STRONG);
      expect(result.sent.sentEvidencePacks?.[0]?.files[0]?.excerpts[0]?.atom.score).toBe(0.9);
      expect(result.pack.usage.excerptBytes).toBeLessThanOrEqual(512);
      expect(result.read.observation?.omittedRangeCount).toBeGreaterThan(0);
    },
  );

  it("keeps the same strongest first read when an incidental listing is added", async () => {
    const atoms = [located(10, 0.1), located(301, 0.9)];
    const withoutListing = await readAndFit(atoms, 512);
    const withListing = await readAndFit([listing(), ...atoms], 512);
    expect(withoutListing.read.excerpts.get(PATH)?.[0]).toEqual(
      withListing.read.excerpts.get(PATH)?.[0],
    );
    expect(sentText(withoutListing)).toContain(STRONG);
    expect(sentText(withListing)).toContain(STRONG);
  });

  it("keeps the sole-listing readable header fallback", async () => {
    const result = await readAndFit([listing()], 8192);
    expect(result.read.excerpts.get(PATH)?.[0]?.startLine).toBe(1);
    expect(sentText(result)).toContain(WEAK);
    expect(sentText(result)).not.toContain(STRONG);
    expect(result.sent.sentReferenceCount).toBe(1);
  });

  it("preserves all fitting early and independently located late facts", async () => {
    const result = await readAndFit(
      [listing(), located(10, 0.1), located(301, 0.9), located(321, 0.8)],
      16384,
    );
    expect(sentText(result)).toContain(WEAK);
    expect(sentText(result)).toContain(STRONG);
    expect(sentText(result)).toContain(SECOND);
    expect(result.read.observation?.omittedRangeCount).toBe(0);
    expect(result.pack.usage.excerptBytes).toBeLessThanOrEqual(16384);
  });

  it("retains definition trace priority before a stronger ordinary located hit", async () => {
    const result = await readAndFit(
      [listing(), located(10, 0.99), located(301, 0.1, "discovered-symbol-definition")],
      512,
    );
    expect(result.read.excerpts.get(PATH)?.[0]?.startLine).toBe(301);
    expect(sentText(result)).toContain(STRONG);
    expect(result.pack.usage.excerptBytes).toBeLessThanOrEqual(512);
  });
});
