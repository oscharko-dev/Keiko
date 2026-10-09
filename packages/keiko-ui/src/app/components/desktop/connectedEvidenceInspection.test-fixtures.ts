import { connectedScopeFingerprint } from "./hooks/workspaceScopeIdentity";
import type { EvidenceManifest } from "@oscharko-dev/keiko-contracts/evidence";
import {
  DEFAULT_EXPLORATION_BUDGET,
  connectedContextOmittedCounts,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedAnswerContextPackSummary, GroundedAnswer } from "@/lib/types";
export const INSPECTION_PACK: GroundedAnswerContextPackSummary = {
  schemaVersion: "1",
  scopeId: "cs-redacted",
  scopeKind: "directory",
  fileCount: 1,
  queryKind: "natural-language",
  filesInPrompt: 1,
  budget: DEFAULT_EXPLORATION_BUDGET,
  usage: {
    searchCalls: 1,
    filesRead: 3,
    excerptBytes: 60,
    modelInputTokens: 20,
    modelOutputTokens: 0,
    elapsedMs: 1,
    rerankCalls: 0,
  },
  citationCount: 1,
  omittedCount: 2,
  omittedCounts: { ...connectedContextOmittedCounts({ omitted: [] }), "low-relevance": 2 },
  uncertaintyCount: 0,
  elapsedMs: 1,
};

const INSPECTION_MANIFEST: EvidenceManifest = {
  evidenceSchemaVersion: "1",
  run: {
    runId: "run-1",
    fingerprint: "hash",
    harnessVersion: "1",
    taskType: "connected-context",
    outcome: "completed",
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
  },
  model: { modelId: "model", costClass: "unknown" },
  usageTotals: { promptTokens: 20, completionTokens: 0, requestCount: 1, totalLatencyMs: 1 },
  stateTransitions: [],
  toolCalls: [],
  commandExecutions: [],
  connectedContext: {
    packSchemaVersion: "1",
    packStableIdHash: "hash",
    chatIdHash: undefined,
    modelRequest: { sentToModel: true, excerptContentPersisted: false },
    scope: {
      schemaVersion: "1",
      scopeIdHash: "hash",
      sourceScopeFingerprint: connectedScopeFingerprint({
        kind: "directory",
        root: "/proj",
        relativePaths: ["src"],
        connectedAtMs: 1,
      }),
      scopeKind: "directory",
      selectedPathCount: 1,
      selectedPaths: ["src/feature"],
    },
    query: {
      kind: "natural-language",
      queryTextHash: "hash",
      queryTextBytes: 3,
      maxResults: 24,
      caseSensitive: false,
    },
    plan: undefined,
    budget: { usage: {}, limits: {} },
    files: [
      {
        scopePath: "src/feature/read.ts",
        role: "primary",
        selectionReason: "explicit",
        excerptCount: 1,
        excerptBytes: 60,
        excerpts: [
          {
            atomStableId: "atom",
            scopePath: "src/feature/read.ts",
            lineRange: { startLine: 4, endLine: 9 },
            score: 1,
            provenanceKind: "repository",
            tool: "read",
            queryFingerprint: "hash",
            redactionState: "redacted",
            contentBytes: 60,
            contentSha256: "hash",
          },
        ],
      },
    ],
    omitted: [{ scopePath: "src/feature/other.ts", reason: "low-relevance" }],
    uncertainty: [],
    toolsUsed: [],
    summary: {
      fileCount: 1,
      citationCount: 1,
      omittedCount: 2,
      uncertaintyCount: 0,
      elapsedMs: 1,
    },
  },
};

export function connectedInspectionManifest(runId = "run-1"): EvidenceManifest {
  return { ...INSPECTION_MANIFEST, run: { ...INSPECTION_MANIFEST.run, runId } };
}

export function connectedInspectionAnswer(
  runId = "run-1",
): Extract<GroundedAnswer, { readonly groundingKind: "connected-context" }> {
  return {
    groundingKind: "connected-context",
    userMessageId: "user",
    assistantMessageId: `answer-${runId}`,
    evidenceRunId: runId,
    content: "Inspect src/feature/read.ts.",
    citations: [],
    uncertainty: [],
    omittedCount: 2,
    elapsedMs: 1,
    contextPack: INSPECTION_PACK,
  };
}
