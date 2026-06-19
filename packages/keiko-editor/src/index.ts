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
  EditorCompletionProvenance,
  EditorCompletionResponse,
  EditorCompletionQuery,
  EditorCompletionResolver,
  EditorInlineCompletionProvenance,
  EditorInlineCompletionResponse,
  EditorInlineCompletionQuery,
  EditorInlineCompletionResolver,
  EditorDiagnosticSeverity,
  EditorDiagnosticRelatedInformation,
  EditorDiagnostic,
  EditorDiagnosticsRequest,
  EditorDiagnosticsQuery,
  EditorDiagnosticsResponse,
  EditorDiagnosticsResolver,
  EditorHover,
  EditorHoverRequest,
  EditorHoverQuery,
  EditorHoverResponse,
  EditorHoverResolver,
  EditorSymbolKind,
  EditorDocumentSymbol,
  EditorSymbolsRequest,
  EditorSymbolsQuery,
  EditorSymbolsResponse,
  EditorSymbolsResolver,
  EditorFormattingOptions,
  EditorFormattingRequest,
  EditorFormattingQuery,
  EditorFormattingResponse,
  EditorFormattingResolver,
  EditorSymbolRef,
  EditorTestGenerationContext,
  EditorTestGenerationRequest,
  EditorTestGenerationResult,
  EditorTestGenerationStatus,
  EditorTestGenerationAssurance,
  EditorTestGenerationGateState,
  EditorTestGenerationFunnel,
  EditorTestGenerationOutcome,
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

// ─── Runtime: Monaco completion-provider bridge (#1199) ───
// Bridges Monaco's completion provider to the host completion resolver: pure mappers plus a provider
// factory and registration helper. The editor renders host-resolved items and computes nothing
// (ADR-0042 D5). Consumed by the KeikoCodeEditor `provideCompletions` prop; the factory/mappers are
// exported for advanced hosts and tests.
export {
  createKeikoCompletionProvider,
  registerKeikoCompletionProvider,
  createEditorRequestId,
  monacoTriggerToEditor,
  monacoPositionToEditor,
  editorKindToMonaco,
  editorRangeToMonaco,
  editorItemToMonacoSuggestion,
  responseToCompletionList,
  wordRangeAt,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
  DEFAULT_COMPLETION_CONTEXT_BUDGET_BYTES,
  COMPLETION_ELIGIBLE_LANGUAGES,
} from "./components/completion-bridge.js";
export type {
  KeikoCompletionProviderDeps,
  RegisterKeikoCompletionProviderArgs,
  MonacoCompletionItemKinds,
  MonacoCompletionTriggerKinds,
  MonacoCompletionItemProvider,
  MonacoLanguagesRegistrar,
  MonacoCompletionModel,
  MonacoCompletionContext,
  MonacoCompletionList,
  MonacoCompletionSuggestion,
  MonacoCancellationToken,
  MonacoDisposable,
  MonacoPositionLike,
  MonacoRange,
} from "./components/completion-bridge.js";

// ─── Runtime: Monaco inline-completion (ghost-text) bridge (#1200) ───
// Bridges Monaco's inline-completion provider to the host inline resolver: pure mappers plus a
// provider factory, registration helper, and a content-free acceptance/rejection telemetry
// accumulator. The editor renders host-resolved ghost text and computes nothing (ADR-0042 D5).
// Consumed by the KeikoCodeEditor `provideInlineCompletions` prop; the factory/mappers/telemetry are
// exported for advanced hosts and tests.
export {
  createKeikoInlineCompletionProvider,
  registerKeikoInlineCompletionProvider,
  monacoInlineTriggerToEditor,
  editorInlineItemToMonaco,
  responseToInlineCompletions,
  endOfLifeReasonToEvent,
  INLINE_COMPLETION_ELIGIBLE_LANGUAGES,
  DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS,
  DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES,
} from "./components/inline-completion-bridge.js";
export type {
  KeikoInlineCompletionProviderDeps,
  RegisterKeikoInlineCompletionProviderArgs,
  MonacoInlineCompletionsProvider,
  MonacoInlineCompletionsRegistrar,
  MonacoInlineCompletionTriggerKinds,
  MonacoInlineCompletionEndOfLifeReasonKinds,
  MonacoInlineCompletionContext,
  MonacoInlineCompletionModel,
  MonacoInlineCompletion,
  MonacoInlineCompletions,
  MonacoInlineCompletionEndOfLifeReason,
} from "./components/inline-completion-bridge.js";
export {
  createInlineCompletionTelemetry,
  inlineCompletionTelemetryReducer,
  EMPTY_INLINE_COMPLETION_TELEMETRY,
} from "./components/inline-completion-telemetry.js";
export type {
  InlineCompletionTelemetry,
  InlineCompletionTelemetrySnapshot,
  InlineCompletionTelemetryEvent,
} from "./components/inline-completion-telemetry.js";

// ─── Runtime: Monaco diagnostics / hover / symbols / formatting bridges (#1201) ───
// Bridge the deterministic server language service (#1198) into Monaco's marker, hover, document-
// symbol, and document-formatting surfaces: pure mappers plus a registration helper each. The editor
// renders host-resolved results and computes nothing (ADR-0042 D4). Consumed by the KeikoCodeEditor
// `provideDiagnostics`/`provideHover`/`provideSymbols`/`provideFormatting` props; the mappers and
// registration helpers are exported for advanced hosts and tests.
export {
  registerKeikoDiagnostics,
  severityToMarker,
  editorDiagnosticToMarker,
  diagnosticsToMarkers,
  defaultDiagnosticsScheduler,
  DIAGNOSTICS_ELIGIBLE_LANGUAGES,
  DEFAULT_DIAGNOSTICS_DEBOUNCE_MS,
  DEFAULT_DIAGNOSTICS_OWNER,
} from "./components/diagnostics-bridge.js";
export type {
  RegisterKeikoDiagnosticsArgs,
  DiagnosticsScheduler,
  DiagnosticsTimerHandle,
  MonacoMarkerSeverities,
  MonacoMarkerData,
  MonacoMarkerEditorNamespace,
  MonacoDiagnosticsModel,
  MonacoDiagnosticsEditor,
} from "./components/diagnostics-bridge.js";
export {
  createKeikoHoverProvider,
  registerKeikoHoverProvider,
  hoverResponseToMonaco,
  toInertCodeFence,
  HOVER_ELIGIBLE_LANGUAGES,
} from "./components/hover-bridge.js";
export type {
  KeikoHoverProviderDeps,
  RegisterKeikoHoverProviderArgs,
  MonacoHoverProvider,
  MonacoHoverRegistrar,
  MonacoHoverModel,
  MonacoHover,
  MonacoMarkdownString,
} from "./components/hover-bridge.js";
export {
  createKeikoDocumentSymbolProvider,
  registerKeikoDocumentSymbolProvider,
  editorSymbolKindToMonaco,
  editorSymbolToMonaco,
  symbolsToMonaco,
  SYMBOLS_ELIGIBLE_LANGUAGES,
} from "./components/document-symbol-bridge.js";
export type {
  KeikoDocumentSymbolProviderDeps,
  RegisterKeikoDocumentSymbolProviderArgs,
  MonacoDocumentSymbolProvider,
  MonacoDocumentSymbolRegistrar,
  MonacoDocumentSymbolModel,
  MonacoDocumentSymbol,
  MonacoSymbolKinds,
} from "./components/document-symbol-bridge.js";
export {
  createKeikoFormattingProvider,
  registerKeikoFormattingProvider,
  editorTextEditToMonaco,
  editsToMonaco,
  monacoFormattingOptionsToEditor,
  FORMATTING_ELIGIBLE_LANGUAGES,
} from "./components/formatting-bridge.js";
export type {
  KeikoFormattingProviderDeps,
  RegisterKeikoFormattingProviderArgs,
  MonacoDocumentFormattingEditProvider,
  MonacoDocumentFormattingRegistrar,
  MonacoFormattingModel,
  MonacoFormattingOptions,
  MonacoTextEdit,
} from "./components/formatting-bridge.js";

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

// ─── Runtime: patch-preview model adapter (#1195) ───
// Pure, browser-safe projection of a generated patch (the #1192 contract) plus original buffers into
// the render model the diff editor consumes. It applies the patch's text edits in memory and never
// writes to disk or calls a Node-domain patch tool (ADR-0042 D2/D7).
export { buildPatchPreview, DEFAULT_PATCH_PREVIEW_LIMITS } from "./patch-preview.js";
export type {
  BuildPatchPreviewInput,
  PatchPreviewFile,
  PatchPreviewFileStatus,
  PatchPreviewLimits,
  PatchPreviewModel,
  PatchPreviewSource,
} from "./patch-preview.js";

// ─── Runtime: KeikoDiffEditor React component (#1195) ───
export { KeikoDiffEditor } from "./components/KeikoDiffEditor.js";
export type { DiffActionAvailability, KeikoDiffEditorProps } from "./components/diff-types.js";

// ─── Runtime: governed test-generation flow (#1202) ───
// Pure, browser-safe controllers for the editor "Generate Tests" action: target/mode selection (the
// editor half of the workflow request adapter), the flow reducer (run status, stale-response discard,
// failure/cancel keeping the editor usable), and the diff-review projection (reuses #1195
// buildPatchPreview + KeikoDiffEditor with apply disabled — wave 2/#1204 per ADR-0042 D7). No Monaco,
// no I/O, no model: the host owns the gated BFF call to /api/editor/test-generation.
export {
  buildTestGenerationContext,
  buildTestGenerationRequest,
  testGenerationMode,
} from "./test-generation-context.js";
export type {
  BuildTestGenerationRequestArgs,
  TestGenerationComponentTarget,
  TestGenerationMode,
  TestGenerationTargetInput,
} from "./test-generation-context.js";
export {
  IDLE_TEST_GENERATION_STATE,
  describeTestGenerationStatus,
  isTestGenerationBusy,
  isTestGenerationPreviewing,
  testGenerationReducer,
} from "./test-generation-status.js";
export type {
  TestGenerationFlowAction,
  TestGenerationFlowState,
} from "./test-generation-status.js";
export {
  buildTestGenerationPreview,
  TEST_GENERATION_REVIEW_ACTIONS,
} from "./test-generation-preview.js";
export type {
  BuildTestGenerationPreviewArgs,
  TestGenerationPreview,
} from "./test-generation-preview.js";

// ─── Runtime: VS Code-feeling UX — command actions & status bar (#1205) ───
// The command-action descriptors register host-owned commands (Generate Tests) into Monaco's native
// command palette (F1) and context menu; `MONACO_BUILTIN_ACTION_IDS` documents the editor-intrinsic
// commands (find, format, accept/reject suggestion, palette, accessibility help) that ship with
// Monaco. The status-bar module is a pure view-model derivation plus a presentational, host-agnostic
// component. No Monaco runtime value import — the host wires them through KeikoCodeEditor props and
// renders the unified status bar (ADR-0042 D1).
export {
  MONACO_BUILTIN_ACTION_IDS,
  EDITOR_COMMAND_KEYBINDINGS,
  EDITOR_GENERATE_TESTS_ACTION_ID,
  EDITOR_GENERATE_TESTS_ACTION_LABEL,
  buildGenerateTestsKeybinding,
  buildGenerateTestsActionDescriptor,
} from "./components/command-actions.js";
export type {
  KeybindingDisplay,
  CommandActionKeys,
  GenerateTestsActionArgs,
} from "./components/command-actions.js";
export { deriveEditorStatusBar, editorLanguageLabel } from "./components/status-bar.js";
export type {
  EditorDiagnosticsSummary,
  EditorStatusTone,
  EditorStatusRun,
  EditorStatusBarInput,
  EditorStatusField,
  EditorStatusBarViewModel,
} from "./components/status-bar.js";
export { EditorStatusBar } from "./components/EditorStatusBar.js";
export type { EditorStatusBarProps } from "./components/EditorStatusBar.js";
