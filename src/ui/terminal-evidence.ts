// ADR-0018 D6/D11 — terminal-execution evidence entry. Each execution writes one redacted JSON
// payload via the existing EvidenceStore.put port (atomic O_EXCL + realpath-contained, same
// guarantees as the run-evidence path). The shape is additive (`kind: "terminal-execution"`) and
// carries counts only — never command args, never output bytes. The OUTPUT text of an execution
// is returned in the synchronous POST response (already Layer-1 redacted by `runCommand`) and is
// never written to disk; this removes a redaction-at-rest surface entirely.

import { deepRedactStrings } from "../audit/redaction.js";
import type { EvidenceStore } from "../audit/store.js";

export const TERMINAL_EVIDENCE_KIND = "terminal-execution" as const;

export interface TerminalEvidenceEntry {
  readonly kind: typeof TERMINAL_EVIDENCE_KIND;
  readonly evidenceSchemaVersion: "1";
  readonly executionId: string;
  // The bare allowlist-validated executable name (e.g. "git", "grep"). Never includes args.
  readonly command: string;
  // The number of args supplied — used for the audit trail; args themselves may carry paths.
  readonly argCount: number;
  readonly projectId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  // Epoch-ms timestamp captured at the spawn boundary.
  readonly startedAt: number;
}

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

// PURE. Builds the on-disk entry from a finished execution. The executionId and projectId carry
// only opaque identifiers; numeric fields cannot leak secrets.
export function buildTerminalEvidenceEntry(input: TerminalEvidenceInput): TerminalEvidenceEntry {
  return {
    kind: TERMINAL_EVIDENCE_KIND,
    evidenceSchemaVersion: "1",
    executionId: input.executionId,
    command: input.command,
    argCount: input.argCount,
    projectId: input.projectId,
    exitCode: input.exitCode,
    signal: input.signal,
    durationMs: input.durationMs,
    timedOut: input.timedOut,
    truncated: input.truncated,
    stdoutBytes: input.stdoutBytes,
    stderrBytes: input.stderrBytes,
    startedAt: input.startedAt,
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
  return store.put(safe.executionId, JSON.stringify(safe, null, 2));
}
