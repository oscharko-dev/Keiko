/**
 * Public prop and view-state types for {@link import("./KeikoCodeEditor.js").KeikoCodeEditor}
 * (Issue #1194).
 *
 * Pure, type-only module: it imports only contracts (`import type`) and declares the controlled,
 * host-agnostic prop surface. The component owns rendering and lifecycle; the host owns the file
 * model (dirty/version/read-only), the save lifecycle, and all I/O. The component emits intent
 * (`onContentChange`, `onSaveRequested`, `onSelectionChange`, `onCursorChange`) and renders the
 * host-computed state, so it is usable outside `keiko-ui` and never imports {@link
 * import("../host-port.js").EditorHostPort} (ADR-0042).
 */
import type {
  EditorBuffer,
  EditorChangeOrigin,
  EditorCodeActionsResolver,
  EditorCompletionResolver,
  EditorDefinitionResolver,
  EditorDiagnostic,
  EditorDiagnosticsResolver,
  EditorFileModel,
  EditorFormattingResolver,
  EditorHostEditRequest,
  EditorHoverResolver,
  EditorInlineCompletionResolver,
  EditorLocation,
  EditorPosition,
  EditorRange,
  EditorReferencesResolver,
  EditorSaveRequest,
  EditorSignatureHelpResolver,
  EditorSymbolsResolver,
} from "../index.js";
import type { EditorThemeVariant } from "../monaco/theme.js";
import type { InlineCompletionTelemetrySnapshot } from "./inline-completion-telemetry.js";
import type { CallHierarchyPanelLabels } from "./CallHierarchyPanel.js";
import type { EditorCallHierarchyResolver } from "./call-hierarchy-bridge.js";
import type { EditorInlayHintsResolver } from "./inlay-hints-bridge.js";
import type { EditorGitGutterHost } from "./git-gutter-bridge.js";
import type { EditorBlameHost } from "./blame-bridge.js";
import type { ConflictLabels } from "./conflict-bridge.js";
import type { EditorDiagnosticsSummary } from "./status-bar.js";

export interface EditorUriLike {
  toString(): string;
}

export type EditorUriForPath = (path: string, currentModelUri: EditorUriLike) => EditorUriLike;

/**
 * The save lifecycle the host drives and the component renders.
 *
 * `conflict` is a terminal-until-resolved state distinct from `error`: it means the persisted
 * version moved underneath an in-flight save (detected host-side via {@link
 * import("./save-state.js").detectSaveConflict}). It keeps the buffer dirty and surfaces an
 * accessible notice — it never silently overwrites.
 */
export type EditorSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

/**
 * Whether the Monaco runtime is loading, ready, or failed to load (host-owned, render-only). While
 * the state is not `ready` the editor is read-only — a load still in flight or failed has no valid
 * content to edit. `message` is shown verbatim in the accessible error region, so the host must
 * supply a user-facing string (React escapes it; it is never treated as markup).
 */
export type KeikoEditorLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string };

export interface EditorRevealRequest {
  readonly id: string;
  readonly range: EditorRange;
}

/** The next buffer content the component emits on a human edit. */
export interface EditorContentDelta {
  readonly text: string;
  readonly sizeBytes: number;
}

/** The bounded Monaco selection handed to the host by the Ask Keiko command (Issue #2119). */
export interface EditorSelectionCapture {
  /** Fixed discriminator matching the existing agent snapshot text-mode contract. */
  readonly textMode: "selection";
  readonly range: EditorRange;
  /** Text read from `getValueInRange(range)` only; never an implicit active-buffer fallback. */
  readonly text: string;
}

export type AskKeikoAboutSelectionHandler = (selection: EditorSelectionCapture) => void;

/**
 * Controlled, host-agnostic props for {@link import("./KeikoCodeEditor.js").KeikoCodeEditor}.
 *
 * The controlled content is `buffer.content.text`; `fileModel` carries the host-owned
 * dirty/version/read-only bookkeeping. Callbacks are intent emitters, not state mutations.
 */
export interface KeikoCodeEditorProps {
  readonly buffer: EditorBuffer;
  readonly fileModel: EditorFileModel;
  readonly loadState: KeikoEditorLoadState;
  readonly saveStatus: EditorSaveStatus;
  readonly saveError?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly modifiedAt?: number | undefined;
  readonly maxSizeBytes?: number | undefined;
  /**
   * Whether the editor renders its own accessible save/truncation status footer (Issue #1194).
   * Defaults to `true` so standalone reuse keeps a self-contained status region. A host that renders
   * its own unified status bar (e.g. the keiko-ui card with {@link
   * import("./EditorStatusBar.js").EditorStatusBar}, Issue #1205) sets it to `false` to avoid two
   * competing status surfaces and duplicate live-region announcements.
   */
  readonly showStatusFooter?: boolean | undefined;
  readonly themeVariant?: EditorThemeVariant | undefined;
  /** Accessible name for the editor control; hosts may include workspace/root context. */
  readonly ariaLabel?: string | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly onContentChange: (next: EditorContentDelta, origin: EditorChangeOrigin) => void;
  readonly onSaveRequested: (request: EditorSaveRequest) => void;
  readonly onSelectionChange?: ((selection: EditorRange | null) => void) | undefined;
  readonly onCursorChange?: ((position: EditorPosition) => void) | undefined;
  readonly revealRequest?: EditorRevealRequest | undefined;
  readonly hostEditRequest?: EditorHostEditRequest | undefined;
  readonly onRuntimeError?: ((message: string) => void) | undefined;
  /**
   * Host-injected completion resolver (Issue #1199). When present, the editor registers a Monaco
   * completion provider for the governed languages that bridges to this resolver; the host owns the
   * BFF call, retrieval, and model routing (ADR-0042 D5). When absent, no provider is registered.
   */
  readonly provideCompletions?: EditorCompletionResolver | undefined;
  /** Trigger characters for the completion provider; defaults to the TS/JS set when omitted. */
  readonly completionTriggerCharacters?: readonly string[] | undefined;
  /**
   * Host-injected inline-completion (ghost-text) resolver (Issue #1200). When present, the editor
   * registers a Monaco inline-completion provider for the governed languages that bridges to this
   * resolver and enables Monaco's inline-suggest UI; the host owns the BFF call, retrieval, model
   * routing, and the policy gate (ADR-0042 D5). When absent, no inline provider is registered and
   * inline suggestions stay disabled.
   */
  readonly provideInlineCompletions?: EditorInlineCompletionResolver | undefined;
  /** Per-keystroke debounce (ms) for inline completion; defaults to ~75 ms when omitted. */
  readonly inlineCompletionDebounceMs?: number | undefined;
  /**
   * Observer for the content-free inline-completion acceptance/rejection telemetry snapshot
   * (Acceptance Criterion 6). Called with cumulative counts after each lifecycle event; the host
   * forwards them to the governed telemetry route. Never receives buffer text or ghost text.
   */
  readonly onInlineCompletionTelemetry?:
    ((snapshot: InlineCompletionTelemetrySnapshot) => void) | undefined;
  /**
   * Host-injected diagnostics resolver (Issue #1201). When present, the editor drives Monaco markers
   * for the governed languages from buffer-change events through this resolver; the host owns the BFF
   * call (ADR-0042 D4). When absent, no diagnostics run and no markers are written.
   */
  readonly provideDiagnostics?: EditorDiagnosticsResolver | undefined;
  /** Per-change debounce (ms) for diagnostics; defaults to ~400 ms when omitted. */
  readonly diagnosticsDebounceMs?: number | undefined;
  /**
   * Host-injected hover (quick-info) resolver (Issue #1201). When present, the editor registers a
   * Monaco hover provider for the governed languages and enables the hover widget; the host owns the
   * BFF call (ADR-0042 D4). When absent, no hover provider is registered and the hover widget stays
   * disabled.
   */
  readonly provideHover?: EditorHoverResolver | undefined;
  /**
   * Host-injected document-symbol resolver (Issue #1201) backing the editor outline and "Go to
   * Symbol" navigation. When absent, no symbol provider is registered.
   */
  readonly provideSymbols?: EditorSymbolsResolver | undefined;
  /**
   * Host-injected document-formatting resolver (Issue #1201). When present, the editor registers an
   * explicit, cancellable "Format Document" provider for the governed languages; the host owns the
   * BFF call (ADR-0042 D4). When absent, no formatting provider is registered.
   */
  readonly provideFormatting?: EditorFormattingResolver | undefined;
  /**
   * Host-injected definition resolver (Epic #2089). When present, the editor registers Monaco's
   * native go-to-definition provider; the host owns the governed BFF call.
   */
  readonly provideDefinition?: EditorDefinitionResolver | undefined;
  /** Host-injected Go to Type Definition resolver (Issue #2216). */
  readonly provideTypeDefinition?: EditorDefinitionResolver | undefined;
  /** Host-injected Go to Implementation resolver (Issue #2216). */
  readonly provideImplementation?: EditorDefinitionResolver | undefined;
  /** Resolve a workspace-relative location path to the host-owned Monaco model URI. */
  readonly uriForPath?: EditorUriForPath | undefined;
  /**
   * Host-injected references resolver (Epic #2089). When present, the editor registers Monaco's
   * native find-references provider; the host owns the governed BFF call.
   */
  readonly provideReferences?: EditorReferencesResolver | undefined;
  /** Host-injected call-hierarchy resolver and localized tree labels (Issue #2216). */
  readonly provideCallHierarchy?: EditorCallHierarchyResolver | undefined;
  readonly callHierarchyLabels?: CallHierarchyPanelLabels | undefined;
  readonly onRevealCallHierarchyLocation?: ((location: EditorLocation) => void) | undefined;
  /** Host-injected inlay-hints resolver rendered by Monaco's native hint surface (Issue #2216). */
  readonly provideInlayHints?: EditorInlayHintsResolver | undefined;
  /**
   * Host-injected code-action resolver (Epic #2089). When present, the editor registers Monaco's
   * lightbulb provider and enables the lightbulb UI. Edits are limited to the active model.
   */
  readonly provideCodeActions?: EditorCodeActionsResolver | undefined;
  /**
   * Host-injected signature-help resolver (Epic #2089). When present, the editor registers Monaco's
   * parameter-hints provider and enables parameter hints.
   */
  readonly provideSignatureHelp?: EditorSignatureHelpResolver | undefined;
  /**
   * Monotonic host request token for Monaco's built-in "Format Document" action. Incrementing this
   * value asks the mounted editor to invoke the registered formatter for the active buffer.
   */
  readonly formatRequestNonce?: number | undefined;
  /**
   * Content-free diagnostic-count observer for the status bar (Issue #1205). Called with the
   * error/warning/info tally after each analysis; the host renders the problem count. Never receives
   * diagnostic text or ranges. Absent when the host wires no diagnostics.
   */
  readonly onDiagnosticsSummary?: ((summary: EditorDiagnosticsSummary) => void) | undefined;
  /**
   * Issue #2213 (ADR-0126) — the full per-diagnostic list for the active buffer on every non-stale
   * resolve (string severity, no Monaco-numbered leak). Consumed by the workspace Problems panel to
   * aggregate diagnostics across open panes. Absent when the host wires no diagnostics.
   */
  readonly onDiagnostics?: ((diagnostics: readonly EditorDiagnostic[]) => void) | undefined;
  /**
   * Host handler for the "Generate Tests" command (Issue #1205). When present, the editor registers a
   * Keiko action into Monaco's native command palette (F1), the context menu, and the `Cmd/Ctrl+Alt+T`
   * keybinding; the run delegates here, to the host's governed test-generation flow (#1202). Absent
   * when the host offers no test generation (e.g. a non-source buffer), so the action never registers.
   */
  readonly onGenerateTests?: (() => void) | undefined;
  /**
   * Host handler for "Ask Keiko about this selection" (Issue #2119). The command is registered only
   * when this callback exists and is disabled by Monaco when no non-empty selection exists. The
   * payload contains only the live selected range and its text; the host owns chat-session routing.
   */
  readonly onAskKeikoAboutSelection?: AskKeikoAboutSelectionHandler | undefined;
  /** Host handler for the F2 Rename Symbol command (Epic #2089, Issue #2105). */
  readonly onRenameSymbol?: (() => void) | undefined;
  /** Host-owned, read-only Git hunk source for event-driven gutter decorations (ADR-0127). */
  readonly editorGitGutter?: EditorGitGutterHost | undefined;
  /** On-demand, read-only blame source; registration performs no read until toggled. */
  readonly editorBlame?: EditorBlameHost | undefined;
  /** Monotonic save/explicit-refresh trigger; content edits intentionally do not change it. */
  readonly gitGutterRefreshNonce?: number | undefined;
  readonly editorConflicts?:
    | {
        readonly labels: ConflictLabels;
        readonly onChange: (count: number, truncated: boolean) => void;
        readonly onStale?: (() => void) | undefined;
      }
    | undefined;
}
