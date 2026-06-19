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
  EditorCompletionResolver,
  EditorFileModel,
  EditorPosition,
  EditorRange,
  EditorSaveRequest,
} from "../index.js";
import type { EditorThemeVariant } from "../monaco/theme.js";

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

/** The next buffer content the component emits on a human edit. */
export interface EditorContentDelta {
  readonly text: string;
  readonly sizeBytes: number;
}

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
  readonly themeVariant?: EditorThemeVariant | undefined;
  /** Accessible name for the editor control; hosts may include workspace/root context. */
  readonly ariaLabel?: string | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly onContentChange: (next: EditorContentDelta, origin: EditorChangeOrigin) => void;
  readonly onSaveRequested: (request: EditorSaveRequest) => void;
  readonly onSelectionChange?: ((selection: EditorRange | null) => void) | undefined;
  readonly onCursorChange?: ((position: EditorPosition) => void) | undefined;
  readonly onRuntimeError?: ((message: string) => void) | undefined;
  /**
   * Host-injected completion resolver (Issue #1199). When present, the editor registers a Monaco
   * completion provider for the governed languages that bridges to this resolver; the host owns the
   * BFF call, retrieval, and model routing (ADR-0042 D5). When absent, no provider is registered.
   */
  readonly provideCompletions?: EditorCompletionResolver | undefined;
  /** Trigger characters for the completion provider; defaults to the TS/JS set when omitted. */
  readonly completionTriggerCharacters?: readonly string[] | undefined;
}
