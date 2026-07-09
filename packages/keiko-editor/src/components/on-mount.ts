/**
 * Editor mount wiring (Issue #1194).
 *
 * `wireEditorOnMount` runs inside the `onMount(editor, monaco)` callback. It registers the Keiko
 * theme, adds the save action bound to Cmd/Ctrl+S, installs a capturing keydown backstop that
 * prevents the browser "Save page" dialog, subscribes cursor/selection reporting, and optionally
 * focuses the editor. It returns a single disposer that tears down every subscription, the action,
 * and the DOM listener — so the component's unmount effect is a one-liner.
 *
 * The DOM and Monaco edges are reached only through the injected `editor`/`monaco`/`container`
 * arguments (never module-scope globals), so the module is import-side-effect-free.
 */
import type * as monaco from "monaco-editor";

import type { EditorLanguageId, EditorPosition, EditorRange } from "../index.js";
import { registerKeikoEditorTheme, resolveEditorThemeTokensFromDom } from "../index.js";
import type { EditorThemeVariant, MonacoThemeRegistrar } from "../monaco/theme.js";
import { buildSaveActionDescriptor } from "./keybindings.js";
import { buildGenerateTestsActionDescriptor } from "./command-actions.js";
import { buildRenameSymbolActionDescriptor } from "./rename-bridge.js";
import type { EditorDiagnosticsSummary } from "./status-bar.js";
import {
  COMPLETION_ELIGIBLE_LANGUAGES,
  registerKeikoCompletionProvider,
  type MonacoDisposable,
  type MonacoLanguagesRegistrar,
  type MonacoRange,
} from "./completion-bridge.js";
import {
  INLINE_COMPLETION_ELIGIBLE_LANGUAGES,
  registerKeikoInlineCompletionProvider,
  type MonacoInlineCompletionsRegistrar,
} from "./inline-completion-bridge.js";
import type { InlineCompletionTelemetry } from "./inline-completion-telemetry.js";
import {
  DEFAULT_DIAGNOSTICS_OWNER,
  DIAGNOSTICS_ELIGIBLE_LANGUAGES,
  registerKeikoDiagnostics,
  type DiagnosticsScheduler,
  type MonacoDiagnosticsEditor,
  type MonacoMarkerData,
  type MonacoMarkerEditorNamespace,
  type MonacoMarkerSeverities,
  type RegisterKeikoDiagnosticsArgs,
} from "./diagnostics-bridge.js";
import {
  HOVER_ELIGIBLE_LANGUAGES,
  registerKeikoHoverProvider,
  type MonacoHoverRegistrar,
} from "./hover-bridge.js";
import {
  SYMBOLS_ELIGIBLE_LANGUAGES,
  registerKeikoDocumentSymbolProvider,
  type MonacoDocumentSymbolRegistrar,
} from "./document-symbol-bridge.js";
import {
  FORMATTING_ELIGIBLE_LANGUAGES,
  registerKeikoFormattingProvider,
  type MonacoDocumentFormattingRegistrar,
} from "./formatting-bridge.js";
import {
  DEFINITION_ELIGIBLE_LANGUAGES,
  registerKeikoDefinitionProvider,
  type MonacoDefinitionRegistrar,
  type MonacoUriForPath,
  type MonacoUriLike,
} from "./definition-bridge.js";
import {
  REFERENCES_ELIGIBLE_LANGUAGES,
  registerKeikoReferencesProvider,
  type MonacoReferenceRegistrar,
} from "./references-bridge.js";
import {
  CODE_ACTION_ELIGIBLE_LANGUAGES,
  registerKeikoCodeActionProvider,
  type MonacoCodeActionRegistrar,
} from "./code-action-bridge.js";
import {
  DEFAULT_SIGNATURE_HELP_RETRIGGER_CHARACTERS,
  DEFAULT_SIGNATURE_HELP_TRIGGER_CHARACTERS,
  SIGNATURE_HELP_ELIGIBLE_LANGUAGES,
  registerKeikoSignatureHelpProvider,
  type MonacoSignatureHelpRegistrar,
} from "./signature-help-bridge.js";
import type {
  EditorCodeActionsResolver,
  EditorCompletionResolver,
  EditorDefinitionResolver,
  EditorDiagnosticsResolver,
  EditorFormattingResolver,
  EditorHoverResolver,
  EditorInlineCompletionResolver,
  EditorReferencesResolver,
  EditorSignatureHelpResolver,
  EditorSymbolsResolver,
} from "../types.js";
import {
  monacoPositionToEditorPosition,
  monacoSelectionToEditorRange,
} from "./selection-reporting.js";

/** Minimal `monaco` namespace surface the mount wiring needs (the live `onMount` second arg). */
export interface MountMonaco {
  readonly editor: MonacoThemeRegistrar;
  readonly Uri?: { parse(value: string): MonacoUriLike };
  // `Alt` is needed for the #1205 Generate Tests chord (`Cmd/Ctrl+Alt+T`); `CtrlCmd` for save.
  readonly KeyMod: { readonly CtrlCmd: number; readonly Alt: number };
  // `KeyT` backs Generate Tests, `F2` backs Rename Symbol, and `KeyS` backs save.
  readonly KeyCode: { readonly KeyS: number; readonly KeyT: number; readonly F2: number };
  // The `languages` registry is present on the live `monaco` namespace; it is optional here so the
  // theme-only mount paths (and their tests) need not provide it. Completion registration is skipped
  // when it (or the completion args) is absent.
  readonly languages?: MonacoLanguagesRegistrar | undefined;
  // `MarkerSeverity` lives on the TOP-LEVEL `monaco` namespace (not `monaco.editor`); diagnostics
  // need it to map severities. Optional so theme-only mounts need not provide it.
  readonly MarkerSeverity?: MonacoMarkerSeverities | undefined;
}

/** Host-injected completion wiring (Issue #1199); absent when the host supplies no resolver. */
export interface WireEditorCompletion {
  readonly resolve: EditorCompletionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly triggerCharacters: readonly string[];
  readonly contextBudgetBytes: number;
  readonly streamId: string;
  readonly newRequestId: () => string;
  /** Restrict registration to the governed languages eligible for completion (defaults to TS/JS). */
  readonly languages?: readonly EditorLanguageId[] | undefined;
}

/** Host-injected inline-completion (ghost-text) wiring (Issue #1200); absent when unsupported. */
export interface WireEditorInlineCompletion {
  readonly resolve: EditorInlineCompletionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly contextBudgetBytes: number;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly debounceDelayMs: number;
  /** Content-free acceptance/rejection telemetry sink fed from Monaco's lifecycle callbacks. */
  readonly telemetry?: InlineCompletionTelemetry | undefined;
  /** Restrict registration to the governed inline-eligible languages (defaults to TS/JS). */
  readonly languages?: readonly EditorLanguageId[] | undefined;
}

/** Host-injected diagnostics wiring (Issue #1201); absent when the host supplies no resolver. */
export interface WireEditorDiagnostics {
  readonly resolve: EditorDiagnosticsResolver;
  readonly debounceMs: number;
  readonly streamId: string;
  readonly newRequestId: () => string;
  /** Marker owner key; defaults to the Keiko language-service owner. */
  readonly owner?: string | undefined;
  /** Restrict analysis to the governed diagnostics-eligible languages (defaults to TS/JS). */
  readonly languages?: readonly EditorLanguageId[] | undefined;
  /** Debounce scheduler; defaults to `setTimeout`/`clearTimeout`. */
  readonly scheduler?: DiagnosticsScheduler | undefined;
  /** Content-free diagnostic-count observer for the status bar (Issue #1205). */
  readonly onSummary?: ((summary: EditorDiagnosticsSummary) => void) | undefined;
  readonly onOverviewMarkers?: RegisterKeikoDiagnosticsArgs["onOverviewMarkers"] | undefined;
}

/**
 * Host-injected command-action wiring (Issue #1205). Each present handler registers a Keiko action
 * into Monaco's native command palette (F1) and context menu with a keybinding. Absent handlers
 * register nothing, so a command whose host capability is off never appears (clean degradation).
 */
export interface WireEditorCommands {
  /** Run the governed test-generation flow (#1202); bound to `Cmd/Ctrl+Alt+T`. */
  readonly generateTests?: (() => void) | undefined;
  /** Run the governed rename-symbol flow (#2105); bound to F2. */
  readonly renameSymbol?: (() => void) | undefined;
}

/** Host-injected hover wiring (Issue #1201); absent when the host supplies no resolver. */
export interface WireEditorHover {
  readonly resolve: EditorHoverResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly languages?: readonly EditorLanguageId[] | undefined;
}

/** Host-injected document-symbol wiring (Issue #1201); absent when the host supplies no resolver. */
export interface WireEditorSymbols {
  readonly resolve: EditorSymbolsResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly languages?: readonly EditorLanguageId[] | undefined;
}

/** Host-injected document-formatting wiring (Issue #1201); absent when the host supplies no resolver. */
export interface WireEditorFormatting {
  readonly resolve: EditorFormattingResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly languages?: readonly EditorLanguageId[] | undefined;
}

/** Host-injected go-to-definition wiring (Epic #2089); absent when unsupported. */
export interface WireEditorDefinition {
  readonly resolve: EditorDefinitionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly uriForPath?: MonacoUriForPath | undefined;
  readonly languages?: readonly EditorLanguageId[] | undefined;
}

/** Host-injected find-references wiring (Epic #2089); absent when unsupported. */
export interface WireEditorReferences {
  readonly resolve: EditorReferencesResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly uriForPath?: MonacoUriForPath | undefined;
  readonly languages?: readonly EditorLanguageId[] | undefined;
}

/** Host-injected code-action wiring (Epic #2089); absent when unsupported. */
export interface WireEditorCodeActions {
  readonly resolve: EditorCodeActionsResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly languages?: readonly EditorLanguageId[] | undefined;
}

/** Host-injected signature-help wiring (Epic #2089); absent when unsupported. */
export interface WireEditorSignatureHelp {
  readonly resolve: EditorSignatureHelpResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly languages?: readonly EditorLanguageId[] | undefined;
  readonly triggerCharacters?: readonly string[] | undefined;
  readonly retriggerCharacters?: readonly string[] | undefined;
}

/** Minimal editor surface the mount wiring needs (the live `onMount` first arg). */
export interface MountEditor {
  addAction(descriptor: monaco.editor.IActionDescriptor): monaco.IDisposable;
  getAction(id: string): { run: () => void | Promise<void> } | null;
  onDidChangeCursorPosition(
    listener: (event: { position: monaco.Position }) => void,
  ): monaco.IDisposable;
  onDidChangeCursorSelection(
    listener: (event: { selection: monaco.Selection }) => void,
  ): monaco.IDisposable;
  focus(): void;
  setSelection(range: MonacoRange): void;
  setPosition(position: { readonly lineNumber: number; readonly column: number }): void;
  revealRangeInCenterIfOutsideViewport(range: MonacoRange): void;
  deltaDecorations(
    oldDecorations: string[],
    newDecorations: monaco.editor.IModelDeltaDecoration[],
  ): string[];
  executeEdits?(
    source: string | null | undefined,
    edits: { readonly range: MonacoRange; readonly text: string }[],
  ): boolean;
  pushUndoStop?(): boolean;
  getModel?(): {
    getLineCount(): number;
    getLineMaxColumn(lineNumber: number): number;
  } | null;
  getContainerDomNode(): HTMLElement;
  saveViewState(): unknown;
  restoreViewState(state: unknown): void;
}

interface DisposableLike {
  dispose(): void;
}

export interface WireEditorOnMountArgs {
  readonly editor: MountEditor;
  readonly monaco: MountMonaco;
  readonly container: HTMLElement;
  readonly themeVariant: EditorThemeVariant;
  readonly autoFocus: boolean;
  readonly onSave: () => void;
  readonly onCursorChange?: ((position: EditorPosition) => void) | undefined;
  readonly onSelectionChange?: ((selection: EditorRange | null) => void) | undefined;
  /**
   * Reports a non-fatal theme-registration failure (e.g. the #1212 design tokens are not present in
   * the host stylesheet). The editor still mounts and renders with Monaco's base theme; this is a
   * system-boundary edge (DOM token resolution), so it is reported, not swallowed silently.
   */
  readonly onThemeError?: ((message: string) => void) | undefined;
  /** Completion wiring (Issue #1199); absent when the host supplies no completion resolver. */
  readonly completion?: WireEditorCompletion | undefined;
  /** Inline-completion wiring (Issue #1200); absent when the host supplies no inline resolver. */
  readonly inlineCompletion?: WireEditorInlineCompletion | undefined;
  /** Diagnostics wiring (Issue #1201); absent when the host supplies no diagnostics resolver. */
  readonly diagnostics?: WireEditorDiagnostics | undefined;
  /** Hover wiring (Issue #1201); absent when the host supplies no hover resolver. */
  readonly hover?: WireEditorHover | undefined;
  /** Document-symbol wiring (Issue #1201); absent when the host supplies no symbols resolver. */
  readonly symbols?: WireEditorSymbols | undefined;
  /** Document-formatting wiring (Issue #1201); absent when the host supplies no formatting resolver. */
  readonly formatting?: WireEditorFormatting | undefined;
  /** Go-to-definition wiring (Epic #2089); absent when the host supplies no resolver. */
  readonly definition?: WireEditorDefinition | undefined;
  /** Find-references wiring (Epic #2089); absent when the host supplies no resolver. */
  readonly references?: WireEditorReferences | undefined;
  /** Code-action wiring (Epic #2089); absent when the host supplies no resolver. */
  readonly codeActions?: WireEditorCodeActions | undefined;
  /** Signature-help wiring (Epic #2089); absent when the host supplies no resolver. */
  readonly signatureHelp?: WireEditorSignatureHelp | undefined;
  /** Command-action wiring (Issue #1205); registers host commands into the Monaco command palette. */
  readonly commands?: WireEditorCommands | undefined;
}

/** True when a keyboard event is the Cmd/Ctrl+S save chord (regardless of platform modifier). */
export function isSaveChord(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
}

/**
 * (Re)define the Keiko Monaco theme for `themeVariant` from the live DOM tokens and apply it to the
 * running editor — `registerKeikoEditorTheme` calls both `defineTheme` and `setTheme`. Used at mount
 * and again when the app theme switches (Issue 2.2), so a light/dark toggle re-themes the SAME editor
 * instance instead of forcing a remount that would discard the undo stack and view state.
 */
export function reapplyEditorTheme(args: {
  readonly monaco: MountMonaco;
  readonly container: HTMLElement;
  readonly themeVariant: EditorThemeVariant;
  readonly onThemeError?: ((message: string) => void) | undefined;
}): void {
  try {
    const tokens = resolveEditorThemeTokensFromDom(args.container);
    registerKeikoEditorTheme(args.monaco.editor, args.themeVariant, tokens);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Editor theme registration failed";
    args.onThemeError?.(message);
  }
}

function registerTheme(args: WireEditorOnMountArgs): void {
  reapplyEditorTheme({
    monaco: args.monaco,
    container: args.container,
    themeVariant: args.themeVariant,
    onThemeError: args.onThemeError,
  });
}

function installSaveAction(args: WireEditorOnMountArgs): monaco.IDisposable {
  return args.editor.addAction(
    buildSaveActionDescriptor({
      keys: { KeyMod: args.monaco.KeyMod, KeyCode: args.monaco.KeyCode },
      run: args.onSave,
    }),
  );
}

function installKeydownBackstop(args: WireEditorOnMountArgs): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (isSaveChord(event)) {
      event.preventDefault();
    }
  };
  args.container.addEventListener("keydown", handler, { capture: true });
  return () => {
    args.container.removeEventListener("keydown", handler, { capture: true });
  };
}

function subscribeCursor(args: WireEditorOnMountArgs): monaco.IDisposable | null {
  const handler = args.onCursorChange;
  if (handler === undefined) {
    return null;
  }
  return args.editor.onDidChangeCursorPosition((event) => {
    handler(monacoPositionToEditorPosition(event.position));
  });
}

function subscribeSelection(args: WireEditorOnMountArgs): monaco.IDisposable | null {
  const handler = args.onSelectionChange;
  if (handler === undefined) {
    return null;
  }
  return args.editor.onDidChangeCursorSelection((event) => {
    handler(monacoSelectionToEditorRange(event.selection));
  });
}

// Registers the completion provider when the host supplies a resolver and the live `monaco.languages`
// registry is available. Returns null otherwise, so a theme-only mount stays unchanged (#1199).
function installCompletionProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const completion = args.completion;
  const languages = args.monaco.languages;
  if (completion === undefined || languages === undefined) {
    return null;
  }
  return registerKeikoCompletionProvider({
    languages,
    resolve: completion.resolve,
    isCurrentDocument: completion.isCurrentDocument,
    documentLanguages: completion.languages ?? COMPLETION_ELIGIBLE_LANGUAGES,
    triggerCharacters: completion.triggerCharacters,
    contextBudgetBytes: completion.contextBudgetBytes,
    streamId: completion.streamId,
    newRequestId: completion.newRequestId,
  });
}

// Registers the inline-completion (ghost-text) provider when the host supplies a resolver and the
// live `monaco.languages` registry actually offers `registerInlineCompletionsProvider` (Issue #1200,
// ADR-0042 D5). The narrow cast is the single seam where the structural mount view meets the inline
// registrar surface; the runtime guard degrades cleanly on a Monaco build without inline support.
function installInlineCompletionProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const inlineCompletion = args.inlineCompletion;
  const languages = args.monaco.languages;
  if (inlineCompletion === undefined || languages === undefined) {
    return null;
  }
  const registrar = languages as unknown as MonacoInlineCompletionsRegistrar;
  if (typeof registrar.registerInlineCompletionsProvider !== "function") {
    return null;
  }
  return registerKeikoInlineCompletionProvider({
    languages: registrar,
    resolve: inlineCompletion.resolve,
    isCurrentDocument: inlineCompletion.isCurrentDocument,
    documentLanguages: inlineCompletion.languages ?? INLINE_COMPLETION_ELIGIBLE_LANGUAGES,
    contextBudgetBytes: inlineCompletion.contextBudgetBytes,
    streamId: inlineCompletion.streamId,
    newRequestId: inlineCompletion.newRequestId,
    debounceDelayMs: inlineCompletion.debounceDelayMs,
    ...(inlineCompletion.telemetry === undefined ? {} : { telemetry: inlineCompletion.telemetry }),
  });
}

// Registers the hover provider when the host supplies a resolver and the live `monaco.languages`
// registry offers `registerHoverProvider` (Issue #1201, ADR-0042 D4). The cast is the single seam
// where the structural mount view meets the hover registrar; the runtime guard degrades cleanly on a
// Monaco build without hover support.
function installHoverProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const hover = args.hover;
  const languages = args.monaco.languages;
  if (hover === undefined || languages === undefined) {
    return null;
  }
  const registrar = languages as unknown as MonacoHoverRegistrar;
  if (typeof registrar.registerHoverProvider !== "function") {
    return null;
  }
  return registerKeikoHoverProvider({
    languages: registrar,
    resolve: hover.resolve,
    isCurrentDocument: hover.isCurrentDocument,
    documentLanguages: hover.languages ?? HOVER_ELIGIBLE_LANGUAGES,
    streamId: hover.streamId,
    newRequestId: hover.newRequestId,
  });
}

// Registers the document-symbol provider for the editor outline/navigation (Issue #1201).
function installDocumentSymbolProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const symbols = args.symbols;
  const languages = args.monaco.languages;
  if (symbols === undefined || languages === undefined) {
    return null;
  }
  const registrar = languages as unknown as MonacoDocumentSymbolRegistrar;
  if (typeof registrar.registerDocumentSymbolProvider !== "function") {
    return null;
  }
  return registerKeikoDocumentSymbolProvider({
    languages: registrar,
    resolve: symbols.resolve,
    isCurrentDocument: symbols.isCurrentDocument,
    documentLanguages: symbols.languages ?? SYMBOLS_ELIGIBLE_LANGUAGES,
    streamId: symbols.streamId,
    newRequestId: symbols.newRequestId,
  });
}

// Registers the explicit, cancellable document-formatting provider (Issue #1201). Only the document
// formatter is registered (no on-type formatter), so formatting runs solely on the user's command.
function installFormattingProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const formatting = args.formatting;
  const languages = args.monaco.languages;
  if (formatting === undefined || languages === undefined) {
    return null;
  }
  const registrar = languages as unknown as MonacoDocumentFormattingRegistrar;
  if (typeof registrar.registerDocumentFormattingEditProvider !== "function") {
    return null;
  }
  return registerKeikoFormattingProvider({
    languages: registrar,
    resolve: formatting.resolve,
    isCurrentDocument: formatting.isCurrentDocument,
    documentLanguages: formatting.languages ?? FORMATTING_ELIGIBLE_LANGUAGES,
    streamId: formatting.streamId,
    newRequestId: formatting.newRequestId,
  });
}

function normalizeUriForPath(
  uriParser: MountMonaco["Uri"] | undefined,
  uriForPath: MonacoUriForPath | undefined,
): MonacoUriForPath | undefined {
  if (uriForPath === undefined || uriParser === undefined) {
    return uriForPath;
  }
  return (path, currentModelUri): MonacoUriLike =>
    uriParser.parse(uriForPath(path, currentModelUri).toString());
}

// Registers the go-to-definition provider. F12 remains Monaco-native; Keiko adds no keybinding.
function installDefinitionProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const definition = args.definition;
  const languages = args.monaco.languages;
  if (definition === undefined || languages === undefined) {
    return null;
  }
  const registrar = languages as unknown as MonacoDefinitionRegistrar;
  if (typeof registrar.registerDefinitionProvider !== "function") {
    return null;
  }
  return registerKeikoDefinitionProvider({
    languages: registrar,
    resolve: definition.resolve,
    isCurrentDocument: definition.isCurrentDocument,
    documentLanguages: definition.languages ?? DEFINITION_ELIGIBLE_LANGUAGES,
    streamId: definition.streamId,
    newRequestId: definition.newRequestId,
    uriForPath: normalizeUriForPath(args.monaco.Uri, definition.uriForPath),
  });
}

// Registers the find-references provider. Shift+F12 remains Monaco-native; Keiko adds no keybinding.
function installReferencesProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const references = args.references;
  const languages = args.monaco.languages;
  if (references === undefined || languages === undefined) {
    return null;
  }
  const registrar = languages as unknown as MonacoReferenceRegistrar;
  if (typeof registrar.registerReferenceProvider !== "function") {
    return null;
  }
  return registerKeikoReferencesProvider({
    languages: registrar,
    resolve: references.resolve,
    isCurrentDocument: references.isCurrentDocument,
    documentLanguages: references.languages ?? REFERENCES_ELIGIBLE_LANGUAGES,
    streamId: references.streamId,
    newRequestId: references.newRequestId,
    uriForPath: normalizeUriForPath(args.monaco.Uri, references.uriForPath),
  });
}

function installCodeActionProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const codeActions = args.codeActions;
  const languages = args.monaco.languages;
  if (codeActions === undefined || languages === undefined) {
    return null;
  }
  const registrar = languages as unknown as MonacoCodeActionRegistrar;
  if (typeof registrar.registerCodeActionProvider !== "function") {
    return null;
  }
  return registerKeikoCodeActionProvider({
    languages: registrar,
    resolve: codeActions.resolve,
    isCurrentDocument: codeActions.isCurrentDocument,
    documentLanguages: codeActions.languages ?? CODE_ACTION_ELIGIBLE_LANGUAGES,
    streamId: codeActions.streamId,
    newRequestId: codeActions.newRequestId,
  });
}

function installSignatureHelpProvider(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const signatureHelp = args.signatureHelp;
  const languages = args.monaco.languages;
  if (signatureHelp === undefined || languages === undefined) {
    return null;
  }
  const registrar = languages as unknown as MonacoSignatureHelpRegistrar;
  if (typeof registrar.registerSignatureHelpProvider !== "function") {
    return null;
  }
  return registerKeikoSignatureHelpProvider({
    languages: registrar,
    resolve: signatureHelp.resolve,
    isCurrentDocument: signatureHelp.isCurrentDocument,
    documentLanguages: signatureHelp.languages ?? SIGNATURE_HELP_ELIGIBLE_LANGUAGES,
    streamId: signatureHelp.streamId,
    newRequestId: signatureHelp.newRequestId,
    triggerCharacters: signatureHelp.triggerCharacters ?? DEFAULT_SIGNATURE_HELP_TRIGGER_CHARACTERS,
    retriggerCharacters:
      signatureHelp.retriggerCharacters ?? DEFAULT_SIGNATURE_HELP_RETRIGGER_CHARACTERS,
  });
}

// Registers the diagnostics marker lifecycle when the host supplies a resolver and the live editor +
// marker surface are available (Issue #1201). Unlike the providers above, diagnostics drive markers
// from model-change events, so the bridge binds the live editor (getModel/onDidChangeModel) and
// writes through `monaco.editor.setModelMarkers`. The marker surface is SPLIT on the live namespace:
// `setModelMarkers` lives on `monaco.editor` while `MarkerSeverity` lives on the TOP-LEVEL `monaco`,
// so this seam recombines them into the bridge's `MonacoMarkerEditorNamespace`. The runtime guards
// degrade cleanly on a build lacking either part.
interface DiagnosticsInstallContext {
  readonly diagnostics: WireEditorDiagnostics;
  readonly diagnosticsEditor: MonacoDiagnosticsEditor;
  readonly markers: MonacoMarkerEditorNamespace;
}

function resolveDiagnosticsInstallContext(
  args: WireEditorOnMountArgs,
): DiagnosticsInstallContext | null {
  const diagnostics = args.diagnostics;
  if (diagnostics === undefined) {
    return null;
  }
  const editorNamespace = args.monaco.editor as unknown as {
    setModelMarkers?: MonacoMarkerEditorNamespace["setModelMarkers"];
  };
  const markerSeverity = args.monaco.MarkerSeverity;
  const diagnosticsEditor = args.editor as unknown as MonacoDiagnosticsEditor;
  if (
    typeof editorNamespace.setModelMarkers !== "function" ||
    markerSeverity === undefined ||
    typeof diagnosticsEditor.getModel !== "function" ||
    typeof diagnosticsEditor.onDidChangeModel !== "function"
  ) {
    return null;
  }
  const setModelMarkers = editorNamespace.setModelMarkers;
  const markers: MonacoMarkerEditorNamespace = {
    MarkerSeverity: markerSeverity,
    setModelMarkers: (model, owner, markerData: readonly MonacoMarkerData[]): void => {
      setModelMarkers(model, owner, markerData);
    },
  };
  return { diagnostics, diagnosticsEditor, markers };
}

function installDiagnostics(args: WireEditorOnMountArgs): MonacoDisposable | null {
  const context = resolveDiagnosticsInstallContext(args);
  if (context === null) {
    return null;
  }
  const { diagnostics, diagnosticsEditor, markers } = context;
  return registerKeikoDiagnostics({
    editor: diagnosticsEditor,
    markers,
    resolve: diagnostics.resolve,
    documentLanguages: diagnostics.languages ?? DIAGNOSTICS_ELIGIBLE_LANGUAGES,
    owner: diagnostics.owner ?? DEFAULT_DIAGNOSTICS_OWNER,
    debounceMs: diagnostics.debounceMs,
    streamId: diagnostics.streamId,
    newRequestId: diagnostics.newRequestId,
    ...(diagnostics.scheduler === undefined ? {} : { scheduler: diagnostics.scheduler }),
    ...(diagnostics.onSummary === undefined ? {} : { onSummary: diagnostics.onSummary }),
    ...(diagnostics.onOverviewMarkers === undefined
      ? {}
      : { onOverviewMarkers: diagnostics.onOverviewMarkers }),
  });
}

// Registers the host-owned command actions into Monaco's native command palette (Issue #1205). Each
// `addAction` makes the command discoverable via F1 / the context menu and binds its keybinding. Only
// host-supplied handlers register; an absent handler registers nothing. Returns the disposables.
function installCommandActions(args: WireEditorOnMountArgs): readonly monaco.IDisposable[] {
  const commands = args.commands;
  if (commands === undefined) {
    return [];
  }
  const disposables: monaco.IDisposable[] = [];
  if (commands.generateTests !== undefined) {
    disposables.push(
      args.editor.addAction(
        buildGenerateTestsActionDescriptor({
          keys: { KeyMod: args.monaco.KeyMod, KeyCode: args.monaco.KeyCode },
          run: commands.generateTests,
        }),
      ),
    );
  }
  if (commands.renameSymbol !== undefined) {
    disposables.push(
      args.editor.addAction(
        buildRenameSymbolActionDescriptor({
          keys: { KeyCode: args.monaco.KeyCode },
          run: commands.renameSymbol,
        }),
      ),
    );
  }
  return disposables;
}

function isDisposable(disposable: DisposableLike | null): disposable is DisposableLike {
  return disposable !== null;
}

function disposeAll(disposables: readonly DisposableLike[]): void {
  for (const disposable of disposables) {
    disposable.dispose();
  }
}

/** Wire the editor on mount and return a disposer that tears everything down on unmount. */
export function wireEditorOnMount(args: WireEditorOnMountArgs): () => void {
  registerTheme(args);
  const action = installSaveAction(args);
  const removeBackstop = installKeydownBackstop(args);
  const cursorSub = subscribeCursor(args);
  const selectionSub = subscribeSelection(args);
  const completionSub = installCompletionProvider(args);
  const inlineCompletionSub = installInlineCompletionProvider(args);
  const diagnosticsSub = installDiagnostics(args);
  const hoverSub = installHoverProvider(args);
  const symbolsSub = installDocumentSymbolProvider(args);
  const formattingSub = installFormattingProvider(args);
  const definitionSub = installDefinitionProvider(args);
  const referencesSub = installReferencesProvider(args);
  const codeActionsSub = installCodeActionProvider(args);
  const signatureHelpSub = installSignatureHelpProvider(args);
  const commandActions = installCommandActions(args);
  const disposables = [
    action,
    cursorSub,
    selectionSub,
    completionSub,
    inlineCompletionSub,
    diagnosticsSub,
    hoverSub,
    symbolsSub,
    formattingSub,
    definitionSub,
    referencesSub,
    codeActionsSub,
    signatureHelpSub,
  ].filter(isDisposable);
  if (args.autoFocus) {
    args.editor.focus();
  }
  return () => {
    removeBackstop();
    disposeAll([...disposables, ...commandActions]);
  };
}
