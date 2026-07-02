// Gate 1 (ADR-0056 D8): the additive EvidenceManifest.contextAssembly? and compaction? fields are
// backward-compatible. A manifest without them is a valid EvidenceManifest; a manifest carrying a
// valid ContextAssemblyDiagnostics + ContextCompactionRecord[] is valid and the nested values pass
// the same-package context-engineering validators; an invalid nested value is rejected by those
// validators. EVIDENCE_SCHEMA_VERSION stays "1" — additive optional fields are not a breaking change.

import { describe, expect, it } from "vitest";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  DEFAULT_TOKEN_ESTIMATOR_ID,
} from "./context-engineering.js";
import type {
  ContextAssemblyDiagnostics,
  ContextCompactionRecord,
  ContextLaneDiagnostics,
  ContextProfile,
} from "./context-engineering.js";
import { validateContextAssemblyDiagnostics, validateContextCompactionRecord } from "./index.js";
import { EVIDENCE_SCHEMA_VERSION } from "./evidence.js";
import type { EvidenceManifest } from "./evidence.js";

function happyProfile(): ContextProfile {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    maxInputTokens: 128_000,
    reservedOutputTokens: 8_000,
    safetyMarginTokens: 4_000,
    effectiveInputBudget: 116_000,
    tokenEstimatorId: DEFAULT_TOKEN_ESTIMATOR_ID,
  };
}

function happyLaneDiagnostics(): ContextLaneDiagnostics {
  return {
    laneId: "repo-evidence",
    estimatedTokens: 1_200,
    includedItems: 4,
    excludedItems: 1,
    budgetPressure: "moderate",
  };
}

function happyAssembly(): ContextAssemblyDiagnostics {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile: happyProfile(),
    totalEstimatedTokens: 1_200,
    budgetPressure: "moderate",
    lanes: [happyLaneDiagnostics()],
    orderedForRecency: true,
  };
}

function happyCompactionRecord(): ContextCompactionRecord {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "repo-evidence",
    reason: "budget exceeded",
    itemsBefore: 8,
    itemsAfter: 3,
    tokensBefore: 4_000,
    tokensAfter: 1_200,
  };
}

function legacyManifest(): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId: "run-1",
      fingerprint: "fp",
      harnessVersion: "0.1.5",
      taskType: "explain-plan",
      outcome: "completed",
      startedAt: 100,
      finishedAt: 110,
      durationMs: 10,
    },
    model: { modelId: "m1", costClass: "unknown" },
    usageTotals: { promptTokens: 1, completionTokens: 1, requestCount: 1, totalLatencyMs: 1 },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
  };
}

describe("EvidenceManifest contextAssembly? / compaction? additive fields", () => {
  it("keeps EVIDENCE_SCHEMA_VERSION at 1 (additive, not breaking)", () => {
    expect(EVIDENCE_SCHEMA_VERSION).toBe("1");
  });

  it("a manifest without the new fields is valid and leaves them undefined", () => {
    const manifest = legacyManifest();
    expect(manifest.contextAssembly).toBeUndefined();
    expect(manifest.compaction).toBeUndefined();
    expect(manifest.evidenceSchemaVersion).toBe("1");
  });

  it("a manifest carrying a valid contextAssembly + compaction[] is valid and round-trips", () => {
    const manifest: EvidenceManifest = {
      ...legacyManifest(),
      contextAssembly: happyAssembly(),
      compaction: [happyCompactionRecord()],
    };
    const roundTripped: unknown = JSON.parse(JSON.stringify(manifest));
    expect(roundTripped).toEqual(manifest);
    expect(validateContextAssemblyDiagnostics(manifest.contextAssembly).ok).toBe(true);
    const records = manifest.compaction ?? [];
    expect(records).toHaveLength(1);
    for (const record of records) {
      expect(validateContextCompactionRecord(record).ok).toBe(true);
    }
  });

  it("rejects an invalid contextAssembly via validateContextAssemblyDiagnostics", () => {
    const broken = { ...happyAssembly(), totalEstimatedTokens: -1 };
    expect(validateContextAssemblyDiagnostics(broken).ok).toBe(false);
  });

  it("rejects an invalid compaction element via validateContextCompactionRecord", () => {
    const broken = { ...happyCompactionRecord(), laneId: "not-a-lane" };
    expect(validateContextCompactionRecord(broken).ok).toBe(false);
  });
});
