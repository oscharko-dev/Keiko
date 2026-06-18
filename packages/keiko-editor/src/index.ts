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

// ─── Runtime: Monaco language inference (#1193) ───
export {
  MONACO_LANGUAGE_IDS,
  inferMonacoLanguageId,
  isMonacoLanguageId,
} from "./monaco/language-inference.js";
export type { MonacoLanguageId } from "./monaco/language-inference.js";

// ─── Runtime: Monaco theme registration (#1193) ───
export {
  EDITOR_THEME_NAME,
  EDITOR_THEME_VARIANTS,
  buildKeikoEditorMonacoTheme,
  registerKeikoEditorTheme,
} from "./monaco/theme.js";
export type {
  EditorThemeVariant,
  MonacoThemeRegistrar,
  ResolvedEditorThemeTokens,
} from "./monaco/theme.js";
export {
  createDomEditorTokenResolverDeps,
  resolveEditorThemeTokens,
  resolveEditorThemeTokensFromDom,
} from "./monaco/theme-resolver.js";
export type { EditorTokenResolverDeps } from "./monaco/theme-resolver.js";

// ─── Runtime: Monaco worker strategy (#1193) ───
export { createMonacoEnvironment, installMonacoEnvironment } from "./monaco/workers.js";
export type {
  MonacoEnvironmentLike,
  MonacoGlobalScope,
  MonacoWorkerEntry,
  MonacoWorkerFactories,
  MonacoWorkerFactory,
} from "./monaco/workers.js";
export { defaultMonacoWorkerFactories } from "./monaco/worker-entries.js";

// ─── Runtime: Monaco loader (no-CDN) and capability detection (#1193) ───
export {
  configureMonacoLoader,
  describeEditorRuntimeError,
  detectEditorRuntimeSupport,
  editorRuntimeLoadFailure,
  isMonacoLoaderConfigured,
  probeEditorRuntime,
} from "./monaco/runtime.js";
export type {
  EditorRuntimeGlobalScope,
  EditorRuntimeProbe,
  EditorRuntimeStatus,
  EditorRuntimeUnsupportedReason,
  MonacoLoaderLike,
} from "./monaco/runtime.js";

// ─── Runtime: KeikoCodeEditor React component (#1194) ───
export { KeikoCodeEditor } from "./components/KeikoCodeEditor.js";
export type {
  KeikoCodeEditorProps,
  EditorSaveStatus,
  KeikoEditorLoadState,
  EditorContentDelta,
} from "./components/types.js";
// The controlled component renders the host-owned save lifecycle; these pure helpers let a host
// (e.g. keiko-ui in #1196) drive `saveStatus` and detect optimistic-concurrency conflicts
// consistently with what the component expects, without re-implementing the FSM.
export { saveStatusReducer, detectSaveConflict } from "./components/save-state.js";
export type { EditorSaveAction } from "./components/save-state.js";
