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
import type {
  CompletionDegradeReason,
  CompletionInteractionMode,
  EditorCompletionSource,
  FileContent,
} from "@oscharko-dev/keiko-contracts";

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
  | "ai-completion"
  | "ai-inline-completion"
  | "generated-test"
  | "applied-patch"
  | "verification";

export interface EditorHostEditRequest {
  readonly id: string;
  readonly text: string;
  readonly origin: EditorChangeOrigin;
}

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
  | { readonly origin: "ai-completion"; readonly model: EditorModelProvenance }
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
  readonly insertAsSnippet?: boolean | undefined;
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

/**
 * Content-free provenance summary for one completion response (Issue #1199, Acceptance Criterion 7).
 * `sources` names which governed tiers/providers contributed — deterministic language intelligence,
 * model-assisted completion, repository context, Local Knowledge, memory — never the retrieved text.
 * `modelMode` echoes the Model Gateway completion-model selection (#1210); `degradeReason` is present
 * only when no governed model produced items. Per-item attribution lives on each
 * {@link EditorCompletionItem}'s `provenance`; this is the response-level rollup.
 */
export interface EditorCompletionProvenance {
  readonly sources: readonly EditorCompletionSource[];
  readonly modelMode: CompletionInteractionMode;
  readonly degradeReason?: CompletionDegradeReason | undefined;
}

export interface EditorCompletionResponse {
  readonly request: EditorRequestIdentity;
  readonly items: readonly EditorCompletionItem[];
  readonly isIncomplete: boolean;
  readonly provenance: EditorCompletionProvenance;
}

/**
 * What the Monaco completion bridge passes to the host resolver (Issue #1199). `request` is the
 * content-free {@link EditorCompletionRequest} (identity, position, trigger). `documentText` is the
 * live editor buffer the bridge reads from the Monaco model — the user's reviewable code, exactly
 * like {@link EditorSaveRequest} `content`, so the host can forward it to the loopback completion BFF
 * without the editor performing any I/O itself (ADR-0042). It is intentionally NOT part of the
 * content-free `EditorCompletionRequest` audit contract.
 */
export interface EditorCompletionQuery {
  readonly request: EditorCompletionRequest;
  readonly documentText: string;
}

/**
 * The host-injected callback the editor calls to resolve completions. The editor computes nothing
 * and routes no model itself; it registers the Monaco provider, hands the host this query, and
 * renders the returned items (ADR-0042 D5). The host owns retrieval, model routing, and the BFF call.
 */
export type EditorCompletionResolver = (
  query: EditorCompletionQuery,
  signal: AbortSignal,
) => Promise<EditorCompletionResponse>;

/**
 * Content-free provenance summary for one inline-completion response (Issue #1200). `sources` names
 * which governed tiers/providers contributed; `modelMode` echoes the Model Gateway completion-model
 * selection (#1210); `degradeReason` is present only when no governed FIM model produced ghost text.
 * Per-item attribution lives on each {@link EditorInlineCompletionItem}'s `provenance`; this is the
 * response-level rollup. Mirrors {@link EditorCompletionProvenance}.
 */
export interface EditorInlineCompletionProvenance {
  readonly sources: readonly EditorCompletionSource[];
  readonly modelMode: CompletionInteractionMode;
  readonly degradeReason?: CompletionDegradeReason | undefined;
}

export interface EditorInlineCompletionResponse {
  readonly request: EditorRequestIdentity;
  readonly items: readonly EditorInlineCompletionItem[];
  /** Optional response-level rollup; absent when the host does not surface a provenance summary. */
  readonly provenance?: EditorInlineCompletionProvenance | undefined;
}

/**
 * What the Monaco inline-completion bridge passes to the host resolver (Issue #1200). `request` is
 * the content-free {@link EditorInlineCompletionRequest} (identity, position, automatic/explicit
 * trigger). `documentText` is the live editor buffer the bridge reads from the Monaco model — the
 * user's reviewable code, exactly like {@link EditorCompletionQuery} `documentText`, so the host can
 * forward it to the loopback inline-completion BFF without the editor performing any I/O itself
 * (ADR-0042). It is intentionally NOT part of the content-free `EditorInlineCompletionRequest`.
 */
export interface EditorInlineCompletionQuery {
  readonly request: EditorInlineCompletionRequest;
  readonly documentText: string;
}

/**
 * The host-injected callback the editor calls to resolve inline (ghost-text) completions. The editor
 * computes nothing and routes no model itself; it registers the Monaco inline-completion provider,
 * hands the host this query, and renders the returned ghost text (ADR-0042 D5). The host owns
 * retrieval, model routing, and the BFF call.
 */
export type EditorInlineCompletionResolver = (
  query: EditorInlineCompletionQuery,
  signal: AbortSignal,
) => Promise<EditorInlineCompletionResponse>;

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

// ─── Language-intelligence resolvers: diagnostics, hover, symbols, formatting (Issue #1201) ────────
//
// Deterministic, model-free language features bridged from the server language service (#1198) into
// Monaco providers. Each request is content-free (a request identity plus document coordinates); the
// live buffer text travels in the `*Query` the bridge hands the host resolver — exactly like
// completion (#1199) — and is intentionally NOT part of the content-free request audit contract. The
// host owns the BFF call to the governed language route; the editor registers Monaco providers,
// renders host-resolved results, and computes nothing (ADR-0042 D4/D5).

/** Content-free diagnostics request: which document/version to analyse. */
export interface EditorDiagnosticsRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
}

/** What the diagnostics bridge passes to the host resolver: the request plus the live buffer. */
export interface EditorDiagnosticsQuery {
  readonly request: EditorDiagnosticsRequest;
  readonly documentText: string;
}

export interface EditorDiagnosticsResponse {
  readonly request: EditorRequestIdentity;
  readonly diagnostics: readonly EditorDiagnostic[];
}

/**
 * The host-injected callback the editor calls to resolve diagnostics. The bridge drives it from
 * buffer-change events, applies stale-response discard, and renders the result as Monaco markers; the
 * host owns the BFF call (ADR-0042 D4).
 */
export type EditorDiagnosticsResolver = (
  query: EditorDiagnosticsQuery,
  signal: AbortSignal,
) => Promise<EditorDiagnosticsResponse>;

/**
 * Plain-text quick info for a position, or `null` when there is none. `contents` is rendered as
 * inert text (no Markdown/HTML sink), matching the server contract (ADR-0042 D3.7/D4).
 */
export interface EditorHover {
  readonly contents: string | null;
  readonly range?: EditorRange | undefined;
}

/** Content-free hover request: a document position to describe. */
export interface EditorHoverRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly position: EditorPosition;
}

export interface EditorHoverQuery {
  readonly request: EditorHoverRequest;
  readonly documentText: string;
}

export interface EditorHoverResponse {
  readonly request: EditorRequestIdentity;
  readonly hover: EditorHover;
}

export type EditorHoverResolver = (
  query: EditorHoverQuery,
  signal: AbortSignal,
) => Promise<EditorHoverResponse>;

/** Monaco-independent subset of document-symbol kinds (LSP-aligned; mirrors the server contract). */
export type EditorSymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "struct"
  | "enumMember"
  | "typeParameter";

/** A document symbol for the editor outline/navigation. */
export interface EditorDocumentSymbol {
  readonly name: string;
  readonly kind: EditorSymbolKind;
  readonly range: EditorRange;
  readonly detail?: string | undefined;
  readonly containerName?: string | undefined;
}

/** Content-free symbols request: which document to outline. */
export interface EditorSymbolsRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
}

export interface EditorSymbolsQuery {
  readonly request: EditorSymbolsRequest;
  readonly documentText: string;
}

export interface EditorSymbolsResponse {
  readonly request: EditorRequestIdentity;
  readonly symbols: readonly EditorDocumentSymbol[];
}

export type EditorSymbolsResolver = (
  query: EditorSymbolsQuery,
  signal: AbortSignal,
) => Promise<EditorSymbolsResponse>;

/** Indentation preferences the editor passes to the formatter (from the Monaco model options). */
export interface EditorFormattingOptions {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
}

/** Content-free formatting request: which document to reformat and the indentation preferences. */
export interface EditorFormattingRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly options: EditorFormattingOptions;
}

export interface EditorFormattingQuery {
  readonly request: EditorFormattingRequest;
  readonly documentText: string;
}

/** The reviewable reformatting edits the editor applies on an explicit "format document" command. */
export interface EditorFormattingResponse {
  readonly request: EditorRequestIdentity;
  readonly edits: readonly EditorTextEdit[];
}

export type EditorFormattingResolver = (
  query: EditorFormattingQuery,
  signal: AbortSignal,
) => Promise<EditorFormattingResponse>;

/** A workspace-relative editor location returned by navigation operations. */
export interface EditorLocation {
  readonly path: string;
  readonly range: EditorRange;
}

/** Content-free definition request: a document position to resolve. */
export interface EditorDefinitionRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly position: EditorPosition;
}

export interface EditorDefinitionQuery {
  readonly request: EditorDefinitionRequest;
  readonly documentText: string;
}

export interface EditorDefinitionResponse {
  readonly request: EditorRequestIdentity;
  readonly locations: readonly EditorLocation[];
}

export type EditorDefinitionResolver = (
  query: EditorDefinitionQuery,
  signal: AbortSignal,
) => Promise<EditorDefinitionResponse>;

/** Content-free references request: a document position to search from. */
export interface EditorReferencesRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly position: EditorPosition;
  readonly includeDeclaration: boolean;
}

export interface EditorReferencesQuery {
  readonly request: EditorReferencesRequest;
  readonly documentText: string;
}

export interface EditorReferencesResponse {
  readonly request: EditorRequestIdentity;
  readonly locations: readonly EditorLocation[];
  readonly includesDeclaration: boolean;
}

export type EditorReferencesResolver = (
  query: EditorReferencesQuery,
  signal: AbortSignal,
) => Promise<EditorReferencesResponse>;

export type EditorCodeActionKind = "quickfix" | "refactor" | "source";

/** A single Monaco code action. `edits: null` means the action is intentionally non-applicable. */
export interface EditorCodeAction {
  readonly title: string;
  readonly kind: EditorCodeActionKind;
  readonly edits: readonly EditorTextEdit[] | null;
}

/** Content-free code-action request for a selected range and active diagnostics. */
export interface EditorCodeActionsRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly range: EditorRange;
  readonly diagnostics: readonly EditorDiagnostic[];
}

export interface EditorCodeActionsQuery {
  readonly request: EditorCodeActionsRequest;
  readonly documentText: string;
}

export interface EditorCodeActionsResponse {
  readonly request: EditorRequestIdentity;
  readonly actions: readonly EditorCodeAction[];
}

export type EditorCodeActionsResolver = (
  query: EditorCodeActionsQuery,
  signal: AbortSignal,
) => Promise<EditorCodeActionsResponse>;

export interface EditorSignatureParameterInformation {
  readonly label: string;
}

export interface EditorSignatureInformation {
  readonly label: string;
  readonly documentation?: string | undefined;
  readonly parameters: readonly EditorSignatureParameterInformation[];
}

/** Content-free signature-help request for the active call expression position. */
export interface EditorSignatureHelpRequest {
  readonly request: EditorRequestIdentity;
  readonly document: EditorDocumentIdentity;
  readonly position: EditorPosition;
  readonly triggerCharacter?: string | undefined;
}

export interface EditorSignatureHelpQuery {
  readonly request: EditorSignatureHelpRequest;
  readonly documentText: string;
}

export interface EditorSignatureHelpResponse {
  readonly request: EditorRequestIdentity;
  readonly signatures: readonly EditorSignatureInformation[];
  readonly activeSignature: number | null;
  readonly activeParameter: number | null;
}

export type EditorSignatureHelpResolver = (
  query: EditorSignatureHelpQuery,
  signal: AbortSignal,
) => Promise<EditorSignatureHelpResponse>;

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

/**
 * The four governed outcomes of a test-generation request, mirroring the server wire status:
 *   - `disabled`  — the feature flag is off (the v1 default); the editor shows the action disabled.
 *   - `deferred`  — enabled, but the assured-execution (egress) boundary is not enforced, so no
 *                   model-generated code is produced or executed; governed discovery still ran.
 *   - `generated` — a reviewable candidate patch was produced (reachable only once the egress boundary
 *                   is enforced, ADR-0042 D7); in v1 `assurance` is always `"unverified"`.
 *   - `failed`    — a content-free, actionable failure; the editor stays usable.
 */
export type EditorTestGenerationStatus = "disabled" | "deferred" | "generated" | "failed";

/** The assurance level of a surfaced candidate; v1 only ever produces `"unverified"` candidates. */
export type EditorTestGenerationAssurance = "unverified" | "assured";

/** One gate of the assured pre-filter funnel. */
export type EditorTestGenerationGateState = "passed" | "failed" | "not-run";

/**
 * The assured pre-filter funnel (Review Addenda): build → pass → stable across `stabilityRunsRequired`
 * (>= 5) runs → coverage increase → mutation/oracle strength → anti-tautology, reported in the run
 * status. In v1 `executionEnabled` is false and every gate is `"not-run"` because the pre-filter
 * executes untrusted model-generated code, deferred behind the enforced egress boundary (ADR-0042 D7).
 */
export interface EditorTestGenerationFunnel {
  readonly executionEnabled: boolean;
  readonly candidatesGenerated: number;
  readonly candidatesSurfaced: number;
  readonly stabilityRunsRequired: number;
  readonly build: EditorTestGenerationGateState;
  readonly pass: EditorTestGenerationGateState;
  readonly stability: EditorTestGenerationGateState;
  readonly coverage: EditorTestGenerationGateState;
  readonly mutation: EditorTestGenerationGateState;
  readonly antiTautology: EditorTestGenerationGateState;
  // Content-free oracle/coverage evidence, present once the pre-filter has executed (wave 2).
  readonly coverageLineDelta?: number | undefined;
  readonly coverageBranchDelta?: number | undefined;
  readonly mutantsKilled?: number | undefined;
  readonly mutantsTotal?: number | undefined;
}

/**
 * Discriminated by `status`. The host resolves the BFF wire response into one of these; the editor
 * renders the diff only for `generated`, and a content-free, actionable message for the others.
 * `reason` is a stable, content-free explanation — never a prompt, model output, or secret.
 */
export type EditorTestGenerationOutcome =
  | {
      readonly status: "disabled";
      readonly request: EditorRequestIdentity;
      readonly reason: string;
    }
  | {
      readonly status: "deferred";
      readonly request: EditorRequestIdentity;
      readonly reason: string;
      readonly funnel: EditorTestGenerationFunnel;
      readonly context?: EditorContextPack | undefined;
    }
  | {
      readonly status: "generated";
      readonly request: EditorRequestIdentity;
      readonly result: EditorTestGenerationResult;
      readonly funnel: EditorTestGenerationFunnel;
      readonly assurance: EditorTestGenerationAssurance;
      // Present when the candidate was surfaced as `unverified` (rejected by a gate or fail-closed): a
      // content-free explanation of why it is not apply-ready.
      readonly reason?: string | undefined;
      readonly context?: EditorContextPack | undefined;
    }
  | { readonly status: "failed"; readonly request: EditorRequestIdentity; readonly reason: string };

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
  | "files-focus"
  | "editor-state"
  | "git-context";

export type EditorContextSourceTier =
  "first-party-workspace" | "indexed-knowledge" | "retained-memory" | "derived-evidence";

/** Content-free provider provenance: a citation pointer and accounting, never the excerpt itself. */
export interface EditorContextEntry {
  readonly sourceKind: EditorContextSourceKind;
  readonly sourceTier: EditorContextSourceTier;
  readonly id: string;
  readonly score: number;
  readonly rank: number;
  readonly citationRef?: string | undefined;
  readonly byteCount: number;
  readonly truncated: boolean;
}

export type EditorContextOmissionReason =
  "unavailable" | "not-ready" | "denied" | "too-expensive" | "out-of-budget";

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
