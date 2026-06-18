/**
 * `@oscharko-dev/keiko-editor` — public API.
 *
 * Browser-tier editor surface. v1 (Issue #1191) shipped the package identity, the supported-language
 * contract, and the typed host-integration port. Issue #1192 adds the editor contracts, ports,
 * commands, model identities, and host-integration API: pure type declarations plus small pure
 * helpers (range mapping, dirty-state reduction, cancellation identity, command availability). No
 * Monaco runtime, no `keiko-ui` dependency, no Node-domain value imports — see ADR-0042 and the
 * package README.
 */

// ─── Runtime: package identity and language contract ─────────────────────────────
export { KEIKO_EDITOR_PACKAGE } from "./version.js";
export { SUPPORTED_EDITOR_LANGUAGES, isSupportedEditorLanguage } from "./languages.js";
export type { EditorLanguageId } from "./languages.js";

// ─── Types: host port ────────────────────────────────────────────────────────────
export type { EditorBuffer, EditorHostPort } from "./host-port.js";

// ─── Types: geometry, document model, provenance, completion, diagnostics ─────────
export type {
  EditorPosition,
  EditorRange,
  EditorTextEdit,
  EditorChangeOrigin,
  EditorDocumentIdentity,
  EditorFileModel,
  EditorSaveRequest,
  EditorSaveResult,
  EditorModelProvenance,
  EditorOutputProvenance,
  EditorCompletionTriggerKind,
  EditorInlineCompletionTriggerKind,
  EditorRequestIdentity,
  EditorRecentEditSummary,
  EditorRecentEditContext,
  EditorCompletionRequest,
  EditorInlineCompletionRequest,
  EditorCompletionItemKind,
  EditorCompletionItem,
  EditorInlineCompletionItem,
  EditorCompletionResponse,
  EditorInlineCompletionResponse,
  EditorDiagnosticSeverity,
  EditorDiagnosticRelatedInformation,
  EditorDiagnostic,
  EditorSymbolRef,
  EditorTestGenerationContext,
  EditorTestGenerationRequest,
  EditorTestGenerationResult,
  EditorPatchStatus,
  EditorPatchFileChange,
  EditorVerificationOutcome,
  EditorVerificationRef,
  EditorGeneratedPatch,
  EditorPreviewedPatch,
  EditorPreviewPatchResult,
  EditorPatchReviewDecision,
  EditorPatchApplyResult,
  EditorContextPurpose,
  EditorContextRequest,
  EditorContextSourceKind,
  EditorContextEntry,
  EditorContextOmissionReason,
  EditorContextOmission,
  EditorContextPack,
  EditorContextResult,
} from "./types.js";

// ─── Types: file model and command identities ────────────────────────────────────
export type { EditorFileModelAction } from "./file-model.js";
export type {
  EditorCommand,
  EditorCommandId,
  EditorCommandContext,
  EditorHostCapability,
} from "./commands.js";

// ─── Runtime: range mapping ──────────────────────────────────────────────────────
export {
  comparePositions,
  isEmptyRange,
  rangeContainsPosition,
  mapPositionAfterEdit,
  mapRangeAfterEdit,
} from "./range.js";

// ─── Runtime: file-model reducer ─────────────────────────────────────────────────
export { createFileModel, editorFileModelReducer, isDocumentDirty } from "./file-model.js";

// ─── Runtime: cancellation identity ──────────────────────────────────────────────
export {
  completionRequestSupersedes,
  isResponseCurrent,
  shouldDiscardResponse,
} from "./completion-identity.js";

// ─── Runtime: command catalogue and availability ─────────────────────────────────
export { EDITOR_COMMANDS, isCommandAvailable, availableCommands } from "./commands.js";
