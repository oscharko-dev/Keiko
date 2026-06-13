// Workflow-facing port for the Governed Enterprise Memory Vault (Epic #204, Issue #213).
// Pure type contract — no runtime logic, no IO, no clock, no randomness. Leaf-package rule
// (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports may appear in this module; all
// referenced types come from sibling modules inside @oscharko-dev/keiko-contracts.
//
// Boundary intent: workflow packages (`keiko-workflows`, future `keiko-evaluations`) accept
// an OPTIONAL `MemoryWorkflowPort` so they can compose pre-run memory context and emit
// post-run lifecycle events for the audit ledger and MemoriaViva UI. Memory is READ-ONLY
// from the workflow's perspective — the port cannot grant write/execution authority. Apply
// gates (#6 applyEnabled, patch limits, scope guards) remain the sole write surface
// (epic §Architecture Invariants 1+2). The workflow remains fully backward-compatible when
// the port is absent: the field is optional and every callback is optional.

import type { MemoryId, MemoryScope } from "./memory.js";

// The assembled memory context for a single workflow run. The `text` is plain prompt-ready
// prose the workflow may prepend to its user message; consumers MUST still redact/byte-cap
// at the prompt boundary (defence-in-depth) because the port implementation is injected
// and may not be the in-tree retriever. `includedMemoryIds` is the audit-trail handle:
// the audit ledger (#214) pins exactly these memory IDs to the run.
export interface MemoryWorkflowContext {
  readonly text: string;
  readonly includedMemoryIds: readonly MemoryId[];
}

// Emitted by the port (NOT the workflow) when a context block was successfully assembled.
// `reason` is a short human-readable label (e.g. "scope-match", "pinned-include") used by
// MemoriaViva to explain why a memory was surfaced for this run.
export interface MemoryUsedEvent {
  readonly memoryIds: readonly MemoryId[];
  readonly scopes: readonly MemoryScope[];
  readonly reason: string;
}

// Emitted when a candidate memory was intentionally left out (budget, sensitivity, conflict).
// One event per omitted memory so the UI can render per-item omission reasons.
export interface MemoryOmittedEvent {
  readonly memoryId: MemoryId;
  readonly reason: string;
}

// Emitted after a workflow reaches a terminal SUCCESS state (workflow-success) or after a
// human-confirmed correction (workflow-correction). The caller decides whether to convert
// the candidate into a proposal through the #207 capture pipeline. The `proposalSummary` is
// a one-line redacted lesson; payloads larger than a summary must be assembled by the
// capture pipeline itself, not by the workflow.
export interface MemoryWriteCandidateEvent {
  readonly proposalSummary: string;
  readonly scope: MemoryScope;
  readonly source: "workflow-success" | "workflow-correction";
}

export interface MemoryWorkflowPort {
  // Fetch a scoped memory context for the workflow run. Returns an empty block (text === ""
  // and includedMemoryIds === []) when no memory matches; the workflow MUST treat the empty
  // case identically to "no port injected" so retrieval failures degrade gracefully.
  readonly getContextForWorkflow: (
    scopes: readonly MemoryScope[],
    queryText?: string,
    budgetTokens?: number,
  ) => Promise<MemoryWorkflowContext>;
  // Notify the host that the assembled context was actually USED in a model call. Optional
  // so a port can implement context-only and skip emit hooks. Workflow calls this exactly
  // once per run, AFTER getContextForWorkflow resolves with a non-empty includedMemoryIds.
  readonly onMemoryUsed?: (event: MemoryUsedEvent) => void;
  // Notify the host that a candidate memory was omitted. Optional. Caller may emit zero or
  // more of these per run.
  readonly onMemoryOmitted?: (event: MemoryOmittedEvent) => void;
  // Notify the host that a memory write candidate exists for review. Optional. Emitted at
  // most once per run, and ONLY when the run reached a terminal success or correction.
  readonly onMemoryWriteCandidate?: (event: MemoryWriteCandidateEvent) => void;
}
