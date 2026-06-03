// ADR-0018 D6/D11 — terminal-execution evidence. Each execution writes a normal
// EvidenceManifest via the existing EvidenceStore.put port, so the shared evidence list/detail
// APIs can parse it. The terminal-specific data lives in the standard run/task identity plus one
// commandExecutions record. It carries counts only — never command args, never output bytes.

import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EvidenceManifest } from "@oscharko-dev/keiko-evidence";
import { EVIDENCE_SCHEMA_VERSION } from "@oscharko-dev/keiko-evidence";
import { HARNESS_VERSION } from "@oscharko-dev/keiko-harness";
import type { RunOutcome } from "@oscharko-dev/keiko-harness";

export const TERMINAL_EVIDENCE_KIND = "terminal-execution" as const;

export type TerminalEvidenceEntry = EvidenceManifest;

export interface TerminalEvidenceInput {
  readonly executionId: string;
  readonly projectId: string;
  readonly command: string;
  readonly argCount: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly startedAt: number;
}

function terminalOutcome(input: TerminalEvidenceInput): RunOutcome {
  if (input.signal !== null) return "cancelled";
  if (input.timedOut) return "limit-exceeded";
  if (input.exitCode === null) return "failed";
  return "completed";
}

// PURE. Builds the on-disk manifest from a finished execution. The executionId and projectId carry
// only identifiers; args and output are deliberately excluded.
export function buildTerminalEvidenceEntry(input: TerminalEvidenceInput): TerminalEvidenceEntry {
  const runId = input.executionId;
  return {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: {
      runId,
      fingerprint: runId,
      harnessVersion: HARNESS_VERSION,
      taskType: TERMINAL_EVIDENCE_KIND,
      outcome: terminalOutcome(input),
      startedAt: input.startedAt,
      finishedAt: input.startedAt + input.durationMs,
      durationMs: input.durationMs,
    },
    model: { modelId: "terminal-tool", costClass: "unknown" },
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
        executable: input.command,
        argCount: input.argCount,
        exitCode: input.exitCode,
        timedOut: input.timedOut,
        durationMs: input.durationMs,
      },
    ],
  };
}

// Defense in depth: applies the live redactor to every string leaf of the entry before serializing.
// All known leaves (command, projectId, executionId) are structurally safe today, but a future
// schema addition would inherit the redaction automatically. Mirrors the persistEvidence pattern.
export function appendTerminalEvidence(
  store: EvidenceStore,
  entry: TerminalEvidenceEntry,
  redact: (input: string) => string,
): string {
  const safe = deepRedactStrings(entry, redact) as TerminalEvidenceEntry;
  return store.put(safe.run.runId, JSON.stringify(safe, null, 2));
}
