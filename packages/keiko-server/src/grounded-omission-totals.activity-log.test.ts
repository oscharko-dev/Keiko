import { describe, expect, it } from "vitest";
import {
  CANDIDATE_OMISSION_REASONS,
  DEFAULT_EXPLORATION_BUDGET,
  MAX_OMITTED_CONTEXT_ENTRIES,
  connectedContextOmittedCount,
  connectedContextOmittedCounts,
  type ConnectedContextPack,
  type OmittedContextEntry,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack, type MicroIndex } from "@oscharko-dev/keiko-workflows";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const ROOT = "/private/customer/omission-evidence";
const CORRELATION = "omission-totals-review-0001";

function input(): OrchestratorInput {
  return {
    workspaceRoot: ROOT,
    scope: {
      schemaVersion: "1",
      scopeId: "omission-evidence",
      workspaceRoot: ROOT,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: 'Find exact identifier "PrivateOmissionProbe".',
      maxResults: 20,
      caseSensitive: false,
      emittedAtMs: 0,
    },
  };
}

function omittedEntries(budgetCount: number): readonly OmittedContextEntry[] {
  return CANDIDATE_OMISSION_REASONS.flatMap((reason) =>
    Array.from({ length: reason === "budget-exhausted" ? budgetCount : 1 }, (_, index) => ({
      scopePath: `private-${reason}-${String(index)}.ts`,
      reason,
      omittedAtMs: 0,
    })),
  );
}

async function producedPack(
  omitted: readonly OmittedContextEntry[],
): Promise<ConnectedContextPack> {
  const request = input();
  const result = await assembleContextPack(
    {
      scope: request.scope,
      query: request.query,
      budget: DEFAULT_EXPLORATION_BUDGET,
      atoms: [],
      ranked: [],
      omittedFromRanking: omitted,
      excerpts: new Map(),
    },
    { nowMs: () => 0 },
  );
  return result.pack;
}

function cachedPack(pack: ConnectedContextPack): MicroIndex {
  return {
    get: () => pack,
    set: () => undefined,
    delete: () => undefined,
    clear: () => undefined,
    size: () => 1,
  };
}

async function assertOmissionEvidence(pack: ConnectedContextPack, clipped: boolean): Promise<void> {
  const log = createBufferedServerLogSink();
  const output = await retrieveConnectedContextPack(input(), {
    correlationId: CORRELATION,
    activityLog: log,
    microIndex: cachedPack(pack),
    fs: memFs(ROOT, { "source.ts": "export const PrivateOmissionProbe = 1;" }),
    nowMs: () => 0,
    answerer: { answer: () => Promise.resolve("unused") },
    detectWorkspace: () => ({
      root: ROOT,
      selectedRoot: ROOT,
      name: "fixture",
      version: undefined,
      testFramework: "unknown",
      languages: [],
      sourceDirs: [],
      testDirs: [],
      ignoreLines: [],
    }),
  });
  expect(output.pack).toBe(pack);
  const event = log.events.find((entry) => entry.op === "search.connected-context.source-details");
  const counts = connectedContextOmittedCounts(pack);
  expect(event?.extra).toMatchObject({
    omittedDetailRetainedCount: pack.omitted.length,
    omittedDetailsClipped: clipped,
    omittedOutsideScopeCount: counts["outside-scope"],
    omittedBinaryCount: counts.binary,
    omittedGeneratedCount: counts.generated,
    omittedIgnoredCount: counts.ignored,
    omittedSizeExceededCount: counts["size-exceeded"],
    omittedNearDuplicateCount: counts["near-duplicate"],
    omittedLowRelevanceCount: counts["low-relevance"],
    omittedRedactedOnlyCount: counts["redacted-only"],
    omittedBudgetExhaustedCount: counts["budget-exhausted"],
    omittedToolUnavailableCount: counts["tool-unavailable"],
    omittedUnsupportedFormatCount: counts["unsupported-format"],
    omittedNoTextLayerCount: counts["no-text-layer"],
    omittedMalformedDocumentCount: counts["malformed-document"],
    omittedEncryptedDocumentCount: counts["encrypted-document"],
  });
  expect(
    log.events.find((entry) => entry.op === "search.connected-context.completed")?.extra,
  ).toMatchObject({ omittedCount: connectedContextOmittedCount(pack) });
  const line = expectActivityLogProof(
    "search.connected-context.source-details.line",
    formatActivityLogProofLine(event ?? {}),
  );
  expect(line).toHaveProperty("correlationId", CORRELATION);
  for (const privateValue of [ROOT, "PrivateOmissionProbe", "private-budget-exhausted-0.ts"])
    expect(log.lines().join("\n")).not.toContain(privateValue);
}

describe("connected-context omission totals in completion evidence", () => {
  it("retains exact mixed reason totals when omission details exceed retention", async () => {
    const pack = await producedPack(omittedEntries(5_000));
    expect(pack.omitted).toHaveLength(MAX_OMITTED_CONTEXT_ENTRIES);
    expect(connectedContextOmittedCounts(pack)["budget-exhausted"]).toBe(5_000);
    await assertOmissionEvidence(pack, true);
  });
  it("derives complete reason totals for a legacy pack without aggregate counts", async () => {
    const pack = await producedPack(omittedEntries(1));
    await assertOmissionEvidence({ ...pack, omittedCounts: undefined }, false);
  });
  it("records zero omission reasons without claiming clipped details", async () => {
    await assertOmissionEvidence(await producedPack([]), false);
  });
});
