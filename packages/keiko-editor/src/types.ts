/**
 * Editor contracts, ports, commands, and model identities (Issue #1192).
 *
 * Content boundary (ADR-0042 D5/D6/D7). Content-bearing fields are confined to the reviewable
 * code artifacts the user owns: buffer/save payloads ({@link EditorSaveRequest}), patch edits
 * ({@link EditorTextEdit} `newText`, {@link EditorPatchFileChange}), and completion response insert
 * text ({@link EditorCompletionItem} / {@link EditorInlineCompletionItem} `insertText`). Completion,
 * inline-completion, and test-generation requests — including recent-edit metadata — are
 * content-free: they carry no raw prompt, no raw model output beyond the reviewable artifact, and no
 * secret, credential, or authorization material. `promptHash`/`citationRef`/`evidenceRef`/`id`
 * fields are opaque references and hashes, never the underlying content.
 *
 * `import type` keeps every contract import a type-only edge (ADR-0042; ADR-0019 direction rule 8):
 * the browser tier may type-import `@oscharko-dev/keiko-contracts` and must never value-import a
 * Node-domain, retrieval, knowledge, memory, workflow, or workspace package. The context port is a
 * string-union plus callback seam; it never names a concrete provider.
 */
import type { FileContent } from "@oscharko-dev/keiko-contracts";

import type { EditorLanguageId } from "./languages.js";

// ─── Geometry ─────────────────────────────────────────────────────────────────

/** A caret location. `line` and `column` are zero-based; `column` counts UTF-16 code units. */
export interface EditorPosition {
  readonly line: number;
  readonly column: number;
}

export interface EditorRange {
  readonly start: EditorPosition;
  readonly end: EditorPosition;
}

/** A single replacement. `newText` is a reviewable code artifact, never a prompt. */
export interface EditorTextEdit {
  readonly range: EditorRange;
  readonly newText: string;
}

// ─── Document model ─────────────────────────────────────────────────────────────

export type EditorChangeOrigin =
  | "human"
  | "deterministic-completion"
  | "ai-inline-completion"
  | "generated-test"
  | "applied-patch"
  | "verification";

/**
 * `uri` is a host-scoped opaque document URI/id, not an absolute filesystem path or
 * credential-bearing URL. `version` is a monotonic host counter; it increments on every edit the
 * host applies.
 */
export interface EditorDocumentIdentity {
  readonly uri: string;
  readonly language: EditorLanguageId;
  readonly version: number;
}

export interface EditorFileModel {
  readonly identity: EditorDocumentIdentity;
  readonly savedVersion: number;
  readonly dirty: boolean;
  readonly readOnly: boolean;
  readonly lastChangeOrigin: EditorChangeOrigin | null;
}

export interface EditorSaveRequest {
  readonly identity: EditorDocumentIdentity;
  /** Saved document version the host should still observe before persisting this content. */
  readonly expectedSavedVersion?: number | undefined;
  readonly content: FileContent;
}

export interface EditorSaveResult {
  readonly identity: EditorDocumentIdentity;
  readonly savedAt: number;
  readonly persistedBytes: number;
}

// ─── Provenance (content-free; aligned with the QI evidence provenance model) ────

/**
 * Content-free model-output provenance for regulated traceability (EU AI Act Reg. (EU) 2024/1689
 * Art. 12 record-keeping), following the same metadata-only shape as the Quality-Intelligence
 * evidence manifest (`modelId` + cost/identity fields, no raw content).
 *
 * The host populates these from the Model Gateway response envelope when AI output is produced
 * (#1199/#1200; the gateway exposes `modelVersion`/`gatewayPolicyVersion` per #1210). `promptHash`
 * is a hash of the prompt for audit correlation — never the raw prompt.
 */
export interface EditorModelProvenance {
  readonly modelId: string;
  readonly modelVersion?: string | undefined;
  readonly gatewayPolicyVersion: string;
  readonly promptHash: string;
  readonly producedAt: number;
}

/** Discriminated by `origin`; AI-backed origins carry model provenance, deterministic ones do not. */
export type EditorOutputProvenance =
  | { readonly origin: "human" }
  | { readonly origin: "deterministic-completion" }
  | { readonly origin: "ai-inline-completion"; readonly model: EditorModelProvenance }
  | { readonly origin: "generated-test"; readonly model: EditorModelProvenance }
  | { readonly origin: "applied-patch"; readonly model?: EditorModelProvenance | undefined }
  | { readonly origin: "verification" };

// ─── Completion request/response ─────────────────────────────────────────────────

export type EditorCompletionTriggerKind = "invoked" | "trigger-character" | "incomplete";

export type EditorInlineCompletionTriggerKind = "automatic" | "explicit";

/**
 * Cross-boundary request identity. `requestId` is globally unique. Within a `streamId`, a higher
 * `sequence` supersedes a lower one — this is the serializable cancellation/superseding key carried
 * across the host port instead of an in-process AbortSignal.
 */
export interface EditorRequestIdentity {
  readonly requestId: string;
  readonly streamId: string;
  readonly sequence: number;
}

/**
 * Content-free summary of a recent buffer edit. The range identifies the edit coordinate span; the
 * remaining fields are metadata and digests only, never the inserted or deleted text.
 */
export interface EditorRecentEditSummary {
  readonly range: EditorRange;
  readonly insertedBytes: number;
  readonly insertedLineCount: number;
  readonly insertedHash: string;
  readonly netByteDelta?: number | undefined;
  readonly netLineDelta?: number | undefined;
}

/**
 * Recent buffer edits supplied as an additive, optional metadata channel so a later
 * `edit-prediction` mode (#1210, a deferred non-goal) can be introduced without breaking the
 * completion contract. Today's completion providers may ignore it.
 */
export interface EditorRecentEditContext {
  readonly edits: readonly EditorRecentEditSummary[];
  readonly truncated: boolean;
}

export interface EditorCompletionRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly position: EditorPosition;
  readonly triggerKind: EditorCompletionTriggerKind;
  readonly triggerCharacter?: string | undefined;
  readonly contextBudgetBytes: number;
  readonly recentEdits?: EditorRecentEditContext | undefined;
}

export interface EditorInlineCompletionRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly position: EditorPosition;
  readonly triggerKind: EditorInlineCompletionTriggerKind;
  readonly contextBudgetBytes: number;
  readonly recentEdits?: EditorRecentEditContext | undefined;
}

/** Monaco-independent subset of completion item kinds. */
export type EditorCompletionItemKind =
  | "text"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "variable"
  | "class"
  | "interface"
  | "module"
  | "property"
  | "keyword"
  | "snippet";

/** A suggestion-widget item. `insertText` is reviewable code; `provenance` is content-free. */
export interface EditorCompletionItem {
  readonly label: string;
  readonly kind: EditorCompletionItemKind;
  readonly insertText: string;
  readonly range?: EditorRange | undefined;
  readonly sortText?: string | undefined;
  readonly detail?: string | undefined;
  readonly provenance: EditorOutputProvenance;
}

/** An inline ghost-text item. `insertText` is reviewable code; `provenance` is content-free. */
export interface EditorInlineCompletionItem {
  readonly insertText: string;
  readonly range: EditorRange;
  readonly provenance: EditorOutputProvenance;
}

export interface EditorCompletionResponse {
  readonly request: EditorRequestIdentity;
  readonly items: readonly EditorCompletionItem[];
  readonly isIncomplete: boolean;
}

export interface EditorInlineCompletionResponse {
  readonly request: EditorRequestIdentity;
  readonly items: readonly EditorInlineCompletionItem[];
}

// ─── Diagnostics (deterministic; no model provenance) ────────────────────────────

export type EditorDiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface EditorDiagnosticRelatedInformation {
  readonly uri: string;
  readonly range: EditorRange;
  readonly message: string;
}

export interface EditorDiagnostic {
  readonly range: EditorRange;
  readonly severity: EditorDiagnosticSeverity;
  readonly message: string;
  readonly source?: string | undefined;
  readonly code?: string | undefined;
  readonly related?: readonly EditorDiagnosticRelatedInformation[] | undefined;
}

// ─── Test generation ─────────────────────────────────────────────────────────────
//
// Wave-2 surface (ADR-0042 D7): editor-driven test generation/execution/verification is gated
// behind a default-off feature flag that may be enabled only once a deny-by-default egress boundary
// is enforced. These contracts define the shape; no v1 flow executes model-generated code.

export interface EditorSymbolRef {
  readonly name: string;
  readonly container?: string | undefined;
  readonly range: EditorRange;
}

/** Discriminated by `kind`; covers the five governed test-generation contexts. */
export type EditorTestGenerationContext =
  | { readonly kind: "file"; readonly document: EditorDocumentIdentity }
  | {
      readonly kind: "selection";
      readonly document: EditorDocumentIdentity;
      readonly range: EditorRange;
    }
  | {
      readonly kind: "symbol";
      readonly document: EditorDocumentIdentity;
      readonly symbol: EditorSymbolRef;
    }
  | { readonly kind: "changed-file-set"; readonly files: readonly EditorDocumentIdentity[] }
  | {
      readonly kind: "frontend-component";
      readonly document: EditorDocumentIdentity;
      readonly componentName: string;
      readonly range?: EditorRange | undefined;
    };

export interface EditorTestGenerationRequest {
  readonly request: EditorRequestIdentity;
  readonly context: EditorTestGenerationContext;
  readonly contextBudgetBytes: number;
}

export interface EditorTestGenerationResult {
  readonly request: EditorRequestIdentity;
  readonly patch: EditorGeneratedPatch;
  readonly provenance: EditorOutputProvenance;
}

// ─── Patches (reviewable; dry-run by default per D7) ─────────────────────────────
//
// Preview is v1; explicit patch apply (status `"applied"`) is the same wave-2, flag-gated,
// egress-bounded path as test generation (ADR-0042 D7). The contract is reviewable-by-construction:
// a patch is a set of explicit text edits, applied only on an explicit host review decision.

export type EditorPatchStatus = "previewed" | "applied" | "rejected";

export interface EditorPatchFileChange {
  readonly uri: string;
  readonly edits: readonly EditorTextEdit[];
  readonly isNewFile: boolean;
  readonly isDeletion: boolean;
}

export type EditorVerificationOutcome = "passed" | "failed" | "skipped" | "not-run";

/** `evidenceRef` is an opaque pointer to evidence held elsewhere; it carries no content. */
export interface EditorVerificationRef {
  readonly verificationId: string;
  readonly outcome: EditorVerificationOutcome;
  readonly evidenceRef?: string | undefined;
}

export interface EditorGeneratedPatch {
  readonly patchId: string;
  readonly changes: readonly EditorPatchFileChange[];
  readonly status: EditorPatchStatus;
  readonly provenance: EditorOutputProvenance;
  readonly verification?: EditorVerificationRef | undefined;
}

export type EditorPreviewedPatch = Omit<EditorGeneratedPatch, "status"> & {
  readonly status: "previewed";
};

export type EditorPreviewPatchResult = EditorPreviewedPatch;

export interface EditorPatchReviewDecision {
  readonly patchId: string;
  readonly decision: "apply" | "reject";
  readonly decidedAt: number;
}

export type EditorPatchApplyResult =
  | {
      readonly patchId: string;
      readonly decision: "apply";
      readonly status: "applied";
      readonly appliedChanges: number;
    }
  | {
      readonly patchId: string;
      readonly decision: "reject";
      readonly status: "rejected";
      readonly appliedChanges: 0;
    };

// ─── Context port (content-free; no concrete provider imports) ────────────────────

export type EditorContextPurpose = "completion" | "inline" | "test-generation";

/** Editor-originated intent and coordinates only; the host resolves and ranks the providers. */
export interface EditorContextRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly cursor?: EditorPosition | undefined;
  readonly selection?: EditorRange | undefined;
  readonly symbol?: EditorSymbolRef | undefined;
  readonly changedFiles?: readonly EditorDocumentIdentity[] | undefined;
  readonly openFiles?: readonly EditorDocumentIdentity[] | undefined;
  readonly focusedWindowId?: string | undefined;
  readonly purpose: EditorContextPurpose;
  readonly budgetBytes: number;
}

export type EditorContextSourceKind =
  | "repo-search"
  | "connected-context"
  | "local-knowledge"
  | "memory"
  | "quality-intelligence"
  | "workflow-context"
  | "files-focus";

/** Content-free provider provenance: a citation pointer and accounting, never the excerpt itself. */
export interface EditorContextEntry {
  readonly sourceKind: EditorContextSourceKind;
  readonly id: string;
  readonly score: number;
  readonly rank: number;
  readonly citationRef?: string | undefined;
  readonly byteCount: number;
  readonly truncated: boolean;
}

export type EditorContextOmissionReason =
  | "unavailable"
  | "not-ready"
  | "denied"
  | "too-expensive"
  | "out-of-budget";

export interface EditorContextOmission {
  readonly sourceKind: EditorContextSourceKind;
  readonly reason: EditorContextOmissionReason;
}

export interface EditorContextPack {
  readonly request: EditorRequestIdentity;
  readonly entries: readonly EditorContextEntry[];
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
  readonly omissions: readonly EditorContextOmission[];
}

/** Discriminated by `status`; `unavailable` carries no pack, only the omission reasons. */
export type EditorContextResult =
  | { readonly status: "ready"; readonly pack: EditorContextPack }
  | { readonly status: "degraded"; readonly pack: EditorContextPack }
  | {
      readonly status: "unavailable";
      readonly request: EditorRequestIdentity;
      readonly omissions: readonly EditorContextOmission[];
    };
