// Shaped observations for the tool-observations context lane (ADR-0054, PR3-W1). Pure readonly
// contracts, no IO, no clock, no randomness, no sibling @oscharko-dev/keiko-* import (contracts is
// a strict leaf). Produced by keiko-workflows/src/observations/ (PR3-W3); consumed by the lane
// assembler (PR4). Each shape is a bounded, redaction-proven, injection-flagged view of a single
// raw tool result — never the full raw output. The discriminated union ContextToolObservation
// wraps the three concrete shaped types plus the forward-defined browser type.
//
// Validators follow the connected-context.ts isRecord + predicate envelope and live in the sibling
// context-observations-validation.ts to keep both files under the 400-LOC budget (mirrors the
// context-engineering-validation.ts split).

import { CONTEXT_ENGINEERING_SCHEMA_VERSION } from "./context-engineering.js";
import type { ContextLaneId } from "./context-engineering.js";

// ─── Size constants (tunable; not part of the public interface shape) ─────── [PR3]
// Frozen defaults for the shapers. They do not appear in the shaped types themselves so they can
// be re-tuned without a contract change.
export const MAX_OBSERVATION_EXCERPT_BYTES = 4_096; // total across all stream excerpts per observation
export const MAX_FAILING_TEST_NAMES = 16;
export const MAX_OBSERVATION_QUERY_BYTES = 512;
export const MAX_TOP_RANGES = 8;
export const MAX_STACK_FRAME_LINES = 30; // total across all stackFrameExcerpts per observation

// ─── Shaped stream excerpt ──────────────────────────────────────────────────── [PR3]
export interface ShapedStreamExcerpt {
  // Which stream the text came from.
  readonly stream: "stdout" | "stderr";
  // Byte length of this excerpt (UTF-8). Sum across all excerpts <= MAX_OBSERVATION_EXCERPT_BYTES.
  readonly bytes: number;
  // The excerpt text — already redacted (redact() applied by the shaper).
  readonly text: string;
}

// ─── Shaped command observation ────────────────────────────────────── [PR3, additive]
// A bounded, redaction-proven, injection-flagged view of a single run_command result. Preserves
// the exit-code signal and structural stderr/stdout excerpts without dumping the full raw output
// into the context window.
export interface ShapedCommandObservation {
  readonly kind: "command";
  // Stable id correlating this observation to its ContextToolRehydrationHandle.
  readonly observationId: string;
  // Non-null only when the child exited normally; null on signal/timeout.
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  // True when exec.ts replaced the streams with the truncation marker (CommandResult.truncated).
  readonly truncated: boolean;
  // Bytes the child wrote above the cap; undefined when not truncated.
  readonly omittedByteCount?: number | undefined;
  // Bounded excerpts from each stream. The shaper limits the total bytes across all excerpts to
  // MAX_OBSERVATION_EXCERPT_BYTES (4 KiB).
  readonly excerpts: readonly ShapedStreamExcerpt[];
  // Count of PromptInjectionSignal items (content-free). Zero means no signals fired. Present only
  // when the shaper ran detectPromptInjectionSignals; absent on fast paths.
  readonly injectionSignalCount?: number | undefined;
  // True if any signal had severity "critical" (instruction-override / secret-exfiltration / etc.).
  readonly hasCriticalInjectionSignal?: boolean | undefined;
  // Rehydration handle for the full redacted output; absent when output intentionally not persisted.
  readonly rehydration?: ContextToolRehydrationHandle | undefined;
}

// ─── Shaped test observation ────────────────────────────────────────── [PR3, additive]
// A bounded, structured view of a single VerificationResult. Captures the semantically important
// signals (counts, failing names, stack frames) without the full log.
export interface ShapedTestCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ShapedTestObservation {
  readonly kind: "test";
  readonly observationId: string;
  readonly verificationKind: string; // VerificationKind from keiko-contracts/verification.ts
  readonly status: string; // VerificationStatus
  // Non-null only when the underlying run exited normally; null on signal/timeout.
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  // Byte count omitted from the raw output (present when truncated).
  readonly omittedByteCount?: number | undefined;
  // Pass/fail/skip counts (always present).
  readonly counts: ShapedTestCounts;
  // Names of failing tests — capped at MAX_FAILING_TEST_NAMES (16) to bound lane size.
  readonly failingTestNames: readonly string[];
  // Bounded stack frame excerpts (last N lines per failing test) — redacted.
  readonly stackFrameExcerpts: readonly string[];
  // The VerificationResult.outputSummary (already redacted+bounded by the orchestrator).
  readonly outputSummary: string;
  readonly injectionSignalCount?: number | undefined;
  readonly hasCriticalInjectionSignal?: boolean | undefined;
  readonly rehydration?: ContextToolRehydrationHandle | undefined;
}

// ─── Shaped search observation ──────────────────────────────────────── [PR3, additive]
// A bounded view of a SearchResult. Preserves the top-scoring ranges so the lane assembler can
// render relevant citations without including all raw atom text.
export interface ShapedSearchRange {
  readonly scopePath: string; // relative, deny-checked by the shaper before inclusion
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
}

export interface ShapedSearchObservation {
  readonly kind: "search";
  readonly observationId: string;
  readonly query: string; // verbatim, bounded; the shaper caps at MAX_OBSERVATION_QUERY_BYTES
  readonly searchKind: string; // e.g. "text" | "find-files"
  // Total candidates before any limit was applied.
  readonly candidateCount: number;
  // Top-ranking file ranges included (capped at MAX_TOP_RANGES = 8).
  readonly topRanges: readonly ShapedSearchRange[];
  // Count of candidates that were omitted due to limits.
  readonly omittedCount: number;
  readonly truncated: boolean;
  // Injection signals on the query (untrusted input: user-typed or model-generated).
  readonly injectionSignalCount?: number | undefined;
  readonly hasCriticalInjectionSignal?: boolean | undefined;
  // No rehydration handle: search is re-runnable; the EvidenceAtom scopePath+lineRange is
  // sufficient for a readExcerpt re-fetch (PR2 pattern).
}

// ─── Browser observation (forward-defined, no live shaper in PR3) ─── [PR3, forward]
// Keiko has no live browser-tool result producer. Playwright verification results are
// VerificationResult items and map to ShapedTestObservation. This type is defined now for surface
// stability so PR6 can add a shaper without a contract change. NO live shaper is shipped in PR3 —
// exactly the CompactionRecord/RehydrationHandle precedent from ADR-0052 D8.
export interface ShapedBrowserObservation {
  readonly kind: "browser";
  readonly observationId: string;
  // Short, structured description of the browser check (e.g. route + check type).
  readonly checkDescription: string;
  readonly passed: boolean;
  readonly durationMs: number;
  // Count of accessibility violations if the check was an axe scan.
  readonly a11yViolationCount?: number | undefined;
  // Redacted screenshot path (relative, never absolute). Not persisted in PR3.
  readonly screenshotScopePath?: string | undefined;
  readonly injectionSignalCount?: number | undefined;
  readonly hasCriticalInjectionSignal?: boolean | undefined;
  readonly rehydration?: ContextToolRehydrationHandle | undefined;
}

// ─── Discriminated union for the tool-observations lane ───────────── [PR3, additive]
export type ContextToolObservation =
  | ShapedCommandObservation
  | ShapedTestObservation
  | ShapedSearchObservation
  | ShapedBrowserObservation;

// ─── Tool-result rehydration handle ───────────────────────────────── [PR3, additive]
// An opaque, content-free pointer to the full (pre-shaping) redacted tool output. The artifactId
// is the sha256Hex of the ToolCallResult.toolCallId — stable and reproducible across the same
// session turn. Evidence persistence is PR5.
export interface ContextToolRehydrationHandle {
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly laneId: ContextLaneId;
  readonly kind: "tool-result";
  // Opaque stable key. sha256Hex(toolCallId). PR5 uses this as the EvidenceStore key.
  readonly artifactId: string;
  // Number of original content items (1 for a command, N for a test with N failing cases).
  readonly itemCount: number;
  // Approximate token cost of the full unshaped output (for PR4 lane-budget decisions).
  readonly approxTokens: number;
  // Set when the full output was intentionally not persisted (e.g. output exceeded cap AND the
  // redacted truncation marker is the authoritative content). No PR5 write expected.
  readonly notPersistedReason?: string | undefined;
}
