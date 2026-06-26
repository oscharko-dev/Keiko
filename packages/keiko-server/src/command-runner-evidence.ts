// Issue #1387 — command-run evidence. Each finished run writes a standard EvidenceManifest via the
// existing EvidenceStore.put port so the shared evidence list/detail APIs can parse it. The runner
// data lives in the standard run identity plus one commandExecutions record. It carries COUNTS and
// ENUMS ONLY — never the task argv, never output bytes, never absolute paths (ADR-0048 content-free
// invariant). Mirrors terminal-evidence.ts.

import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import type { EvidenceManifest, EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { EVIDENCE_SCHEMA_VERSION } from "@oscharko-dev/keiko-evidence";
import { HARNESS_VERSION } from "@oscharko-dev/keiko-harness";
import type { RunOutcome } from "@oscharko-dev/keiko-harness";
import type { CommandFailureReason, CommandTaskKind } from "@oscharko-dev/keiko-contracts";

export const COMMAND_RUN_EVIDENCE_KIND = "command-run" as const;

export type CommandRunEvidenceEntry = EvidenceManifest;

export interface CommandRunEvidenceInput {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly kind: CommandTaskKind;
  readonly executable: string;
  readonly argCount: number;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly failureReason: CommandFailureReason;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly startedAt: number;
}

function commandRunOutcome(input: CommandRunEvidenceInput): RunOutcome {
  switch (input.failureReason) {
    case "none":
      return "completed";
    case "timed-out":
      return "limit-exceeded";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

// PURE. Builds the on-disk manifest from a finished run. Identifiers only; args and output excluded.
// The caller supplies runId/startedAt (no clock, no randomness here) so evidence stays deterministic.
export function buildCommandRunEvidenceEntry(
  input: CommandRunEvidenceInput,
): CommandRunEvidenceEntry {
  const runId = input.runId;
  return {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: {
      runId,
      fingerprint: runId,
      harnessVersion: HARNESS_VERSION,
      taskType: COMMAND_RUN_EVIDENCE_KIND,
      outcome: commandRunOutcome(input),
      startedAt: input.startedAt,
      finishedAt: input.startedAt + input.durationMs,
      durationMs: input.durationMs,
    },
    model: { modelId: "command-runner", costClass: "unknown" },
    usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
    context: {
      workspaceRoot: input.projectId,
      totalCandidates: 0,
      usedBytes: 0,
      budgetBytes: 0,
      droppedForBudget: 0,
      entries: [],
    },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [
      {
        seq: 1,
        ts: input.startedAt,
        executable: input.executable,
        argCount: input.argCount,
        exitCode: input.exitCode,
        timedOut: input.timedOut,
        durationMs: input.durationMs,
      },
    ],
  };
}

// Defense in depth: applies the live redactor to every string leaf before serializing. All known
// leaves (executable, projectId, runId, taskId) are structurally safe today; a future schema
// addition inherits the redaction automatically. Mirrors appendTerminalEvidence.
export function appendCommandRunEvidence(
  store: EvidenceStore,
  entry: CommandRunEvidenceEntry,
  redact: (input: string) => string,
): string {
  const safe = deepRedactStrings(entry, redact) as CommandRunEvidenceEntry;
  return store.put(safe.run.runId, JSON.stringify(safe, null, 2));
}
