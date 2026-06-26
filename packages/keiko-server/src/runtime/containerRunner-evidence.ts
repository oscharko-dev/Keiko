// Issue #1388 (Epic #1491, ADR-0070, D6) — content-free container-run evidence. Each finished run
// writes a standard EvidenceManifest via the existing EvidenceStore.put port so the shared evidence
// list/detail APIs can parse it. It carries COUNTS and ENUMS ONLY — never the constructed docker/
// podman argv, never the raw image ref free-text (only the closed-catalog image id), never the
// workspace path, never any container output (ADR-0048 content-free invariant). Mirrors
// command-runner-evidence.ts.

import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import type { EvidenceManifest, EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { EVIDENCE_SCHEMA_VERSION } from "@oscharko-dev/keiko-evidence";
import { HARNESS_VERSION } from "@oscharko-dev/keiko-harness";
import type { RunOutcome } from "@oscharko-dev/keiko-harness";
import type {
  ContainerEngineId,
  ContainerFailureReason,
  ContainerTaskKind,
} from "@oscharko-dev/keiko-contracts";

export const CONTAINER_RUN_EVIDENCE_KIND = "container-run" as const;

export type ContainerRunEvidenceEntry = EvidenceManifest;

export interface ContainerRunEvidenceInput {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly kind: ContainerTaskKind;
  readonly engine: ContainerEngineId;
  // The closed-catalog task id of the image (NOT the raw image ref free-text). Counts/enums only.
  readonly imageId: string;
  // The docker/podman argv length, never the argv tokens themselves.
  readonly argCount: number;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly failureReason: ContainerFailureReason;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly startedAt: number;
}

function containerRunOutcome(input: ContainerRunEvidenceInput): RunOutcome {
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

// PURE. Builds the on-disk manifest from a finished run. Identifiers/counts only; the docker argv,
// the raw image ref, the workspace path, and all output are excluded. The caller supplies
// runId/startedAt (no clock, no randomness here) so evidence stays deterministic.
export function buildContainerRunEvidenceEntry(
  input: ContainerRunEvidenceInput,
): ContainerRunEvidenceEntry {
  const runId = input.runId;
  return {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: {
      runId,
      fingerprint: runId,
      harnessVersion: HARNESS_VERSION,
      taskType: CONTAINER_RUN_EVIDENCE_KIND,
      outcome: containerRunOutcome(input),
      startedAt: input.startedAt,
      finishedAt: input.startedAt + input.durationMs,
      durationMs: input.durationMs,
    },
    model: { modelId: "container-runner", costClass: "unknown" },
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
        // The container ENGINE is the executable; the catalog image id rides in argCount/identity,
        // never as a free-text leaf. argCount is the docker argv length, never the argv tokens.
        executable: input.engine,
        argCount: input.argCount,
        exitCode: input.exitCode,
        timedOut: input.timedOut,
        durationMs: input.durationMs,
      },
    ],
  };
}

// Defense in depth: applies the live redactor to every string leaf before serializing. All known
// leaves (engine, projectId, runId, taskId) are structurally safe today; a future schema addition
// inherits the redaction automatically. Mirrors appendCommandRunEvidence. Best-effort at the call
// site: a write hiccup must never corrupt a real run result.
export function appendContainerRunEvidence(
  store: EvidenceStore,
  entry: ContainerRunEvidenceEntry,
  redact: (input: string) => string,
): string {
  const safe = deepRedactStrings(entry, redact) as ContainerRunEvidenceEntry;
  return store.put(safe.run.runId, JSON.stringify(safe, null, 2));
}
