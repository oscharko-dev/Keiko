import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CandidateFile, SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import type { RerankerSeam } from "@oscharko-dev/keiko-workflows";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack, type RetrievalOnlyOutput } from "./grounded-orchestrator.js";

const FIRST = "records/current.md";
const SECOND = "records/adjacent.md";
const QUESTION =
  "For the Quiet Harbor transfer depot, how long may a shipment remain on the belt, where must it go afterward, how many staff must witness the journal entry, and which handbook revision governs this? Cite the operating note.";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureFiles(): Readonly<Record<string, string>> {
  const padding = "Unrelated archive material retained for physical scope size.\n".repeat(1_500);
  return {
    [FIRST]:
      [
        "# Quiet Harbor transfer depot operating note",
        "Maximum permitted dwell time: 32 minutes.",
        "After that interval, move the shipment from the belt into the hold cage.",
        "Enter the disposition in the witness journal with 4 authorized staff.",
        "The applicable handbook revision is HB719.",
      ].join("\n") + padding,
    [SECOND]:
      [
        "# Separate freight station operating note",
        "The local shipment waiting period is 63 minutes.",
        "Record disposition after the local dispatch limit is crossed.",
        "Inspection records and witness journals belong only to this station.",
        "Label preparation uses the receipt ledger and local scanner policy.",
      ].join("\n") + padding,
  };
}

function fixtureScope(): SelectedScope {
  const root = mkdtempSync(join(tmpdir(), "keiko-contextual-reranker-"));
  roots.push(root);
  mkdirSync(join(root, "records"));
  for (const [path, body] of Object.entries(fixtureFiles())) writeFileSync(join(root, path), body);
  return {
    schemaVersion: "1",
    scopeId: "contextual-reranker",
    workspaceRoot: root,
    kind: "workspace-root",
    relativePaths: [],
    connectedAtMs: 1,
    conversationId: undefined,
    explicitConnection: true,
  };
}

function retrieve(scope: SelectedScope, reranker?: RerankerSeam): Promise<RetrievalOnlyOutput> {
  return retrieveConnectedContextPack(
    {
      scope,
      workspaceRoot: scope.workspaceRoot,
      query: {
        kind: "natural-language",
        text: QUESTION,
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: 1,
      },
    },
    {
      correlationId: "contextual-fallback-reranker",
      activityLog: createBufferedServerLogSink(),
      nowMs: (): number => 1,
      answerer: { answer: (): Promise<string> => Promise.resolve("") },
      contextPackReranker: reranker,
    },
  );
}

describe("successful reranking owns contextual keep-one fallback ordering", () => {
  it("keeps a reranker's below-floor winner instead of restoring the initial lexical winner", async () => {
    const scope = fixtureScope();
    const baseline = await retrieve(scope);
    const bytes = Object.values(fixtureFiles()).reduce(
      (total, body) => total + Buffer.byteLength(body, "utf8"),
      0,
    );
    expect(bytes).toBeGreaterThan(baseline.pack.budget.excerptBytesMax);
    expect(baseline.pack.diagnostics?.rankedCandidates[0]?.scopePath).toBe(FIRST);
    expect(baseline.pack.files.map((file) => file.scopePath)).toEqual([FIRST]);
    expect(baseline.pack.diagnostics?.selection).toMatchObject({
      keepOneFallbackApplied: true,
      fallbackRankingSource: "lexical-producer",
      selectionConfidence: "low",
      reranked: false,
    });
    let calls = 0;
    const reranker: RerankerSeam = {
      name: "opposing contextual ranking",
      isAvailable: () => Promise.resolve({ available: true, modelLabel: "fixture" }),
      rerank: (candidates): Promise<readonly CandidateFile[]> => {
        calls += 1;
        expect(candidates.map((candidate) => candidate.scopePath)).toContain(SECOND);
        return Promise.resolve(
          candidates.map((candidate) => ({
            ...candidate,
            score: candidate.scopePath === SECOND ? 0.002 : 0.001,
          })),
        );
      },
    };
    const reranked = await retrieve(scope, reranker);
    expect(calls).toBe(1);
    expect(reranked.pack.usage.rerankCalls).toBe(1);
    expect(reranked.pack.diagnostics?.rankedCandidates[0]?.scopePath).toBe(FIRST);
    expect(reranked.pack.files.map((file) => file.scopePath)).toEqual([SECOND]);
    expect(reranked.pack.files[0]?.excerpts.map((excerpt) => excerpt.content).join("\n")).toContain(
      "63 minutes",
    );
    expect(reranked.pack.diagnostics?.selection).toMatchObject({
      keepOneFallbackApplied: true,
      fallbackRankingSource: "candidate-score",
      selectionConfidence: "low",
      rerankerDisposition: "applied",
      reranked: true,
    });
    expect(reranked.pack.uncertainty.map((marker) => marker.kind)).toContain(
      "low-confidence-selection",
    );
  });
});
