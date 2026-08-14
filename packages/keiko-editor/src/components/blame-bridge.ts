import type { GitEditorBlameLine, GitEditorBlameResponse } from "@oscharko-dev/keiko-contracts";

import type { MonacoDisposable, MonacoRange } from "./completion-bridge.js";
import { BLAME_GLYPH_MARGIN_LANE } from "./glyph-margin-lanes.js";

export interface EditorBlameLabels {
  readonly toggle: string;
  readonly openCommit: string;
  readonly dirtyNotice: string;
  readonly truncated: string;
}

export interface EditorBlameHost {
  readonly resolve: () => Promise<GitEditorBlameResponse | null>;
  readonly labels: EditorBlameLabels;
  readonly describe: (line: GitEditorBlameLine, age: string) => string;
  readonly formatAge: (authorTime: string) => string;
  readonly onCommit: (commitHash: string) => void;
}

interface MonacoBlameDecoration {
  readonly range: MonacoRange;
  readonly options: {
    readonly description: string;
    readonly glyphMarginClassName?: string;
    readonly glyphMarginHoverMessage?: { readonly value: string };
    readonly glyphMargin?: { readonly position: number };
    readonly after?: { readonly content: string };
    readonly isWholeLine: true;
  };
}

interface MonacoMouseEventLike {
  readonly target: {
    readonly type: number;
    readonly position?: { readonly lineNumber: number } | null | undefined;
  };
}

// A Monaco text model exposes its own `deltaDecorations`, independent of whichever editor (if
// any) currently has it attached -- see the KEIKO-0378 follow-up note on `clearTarget` below.
export interface MonacoBlameModel {
  deltaDecorations(oldDecorations: string[], next: readonly MonacoBlameDecoration[]): string[];
  isDisposed?(): boolean;
}

export interface MonacoBlameEditor {
  deltaDecorations(oldDecorations: string[], next: readonly MonacoBlameDecoration[]): string[];
  getPosition?(): { readonly lineNumber: number; readonly column: number } | null;
  getModel?(): MonacoBlameModel | null;
  onMouseDown(listener: (event: MonacoMouseEventLike) => void): MonacoDisposable;
  onDidChangeModel(listener: () => void): MonacoDisposable;
  addAction(descriptor: {
    readonly id: string;
    readonly label: string;
    readonly run: () => void;
  }): MonacoDisposable;
}

export interface EditorBlameBridge extends MonacoDisposable {
  toggle(): void;
}

export interface RegisterEditorBlameArgs extends EditorBlameHost {
  readonly editor: MonacoBlameEditor;
  readonly glyphMarginTargetType: number;
  readonly degraded: boolean;
  readonly dirty: () => boolean;
  readonly onError?: ((message: string) => void) | undefined;
}

const ZERO_HASH = /^(?:0{40}|0{64})$/u;

function lineRange(line: number): MonacoRange {
  return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 };
}

function lineDecoration(
  line: GitEditorBlameLine,
  args: RegisterEditorBlameArgs,
): MonacoBlameDecoration {
  const description = [
    args.describe(line, args.formatAge(line.authorTime)),
    line.summary,
    ...(args.dirty() ? [args.labels.dirtyNotice] : []),
  ]
    .filter((part) => part.length > 0)
    .join(" — ");
  return {
    range: lineRange(line.line),
    options: {
      description,
      glyphMarginClassName: "keiko-blame-gutter",
      glyphMarginHoverMessage: { value: description },
      glyphMargin: { position: BLAME_GLYPH_MARGIN_LANE },
      after: { content: `  ${args.describe(line, args.formatAge(line.authorTime))}` },
      isWholeLine: true,
    },
  };
}

function truncationDecoration(
  response: GitEditorBlameResponse,
  label: string,
): MonacoBlameDecoration {
  const lastLine = response.lines.at(-1)?.line ?? 1;
  return {
    range: lineRange(lastLine),
    options: {
      description: label,
      glyphMarginHoverMessage: { value: label },
      after: { content: `  ${label}` },
      isWholeLine: true,
    },
  };
}

function inertBridge(): EditorBlameBridge {
  return { toggle: () => undefined, dispose: () => undefined };
}

interface BlameState {
  enabled: boolean;
  disposed: boolean;
  sequence: number;
  lines: Map<number, GitEditorBlameLine>;
  lineIds: string[];
  truncationIds: string[];
  // The model `lineIds`/`truncationIds` were applied to, captured at apply time (Codex P2 / KEIKO-0378
  // follow-up). Null when the host doesn't expose `editor.getModel` -- clearing then always falls
  // back to the editor, matching this bridge's original (pre-follow-up) behaviour.
  model: MonacoBlameModel | null;
}

// Decoration ids are scoped to the Monaco model they were applied to, but `editor.deltaDecorations`
// always delegates to the editor's CURRENT model. The KEIKO-0378 swap handler runs `clearBlame`
// AFTER Monaco has already reattached the editor to the new model, so clearing through the editor
// targets the new model (the recorded ids are unknown there: a no-op) while the superseded model --
// retained live in Monaco's model registry -- keeps its decorations, which can resurface as stale
// glyphs (and duplicate on re-enable) if the user returns to it. Target the recorded model's own
// `deltaDecorations` directly whenever it still differs from the current one; fall back to the
// editor when nothing swapped (same model) or the recorded model is gone/disposed, so this never
// throws on a stale handle.
function clearTarget(
  state: BlameState,
  args: RegisterEditorBlameArgs,
): Pick<MonacoBlameEditor, "deltaDecorations"> {
  const stale = state.model;
  const current = args.editor.getModel?.() ?? null;
  if (stale !== null && stale !== current && stale.isDisposed?.() !== true) return stale;
  return args.editor;
}

function clearBlame(state: BlameState, args: RegisterEditorBlameArgs): void {
  const target = clearTarget(state, args);
  state.lineIds = target.deltaDecorations(state.lineIds, []);
  state.truncationIds = target.deltaDecorations(state.truncationIds, []);
  state.lines = new Map();
  state.model = null;
}

function applyBlame(
  state: BlameState,
  args: RegisterEditorBlameArgs,
  response: GitEditorBlameResponse,
): void {
  state.model = args.editor.getModel?.() ?? null;
  state.lines = new Map(response.lines.map((line) => [line.line, line]));
  state.lineIds = args.editor.deltaDecorations(
    state.lineIds,
    response.lines.map((line) => lineDecoration(line, args)),
  );
  state.truncationIds = args.editor.deltaDecorations(
    state.truncationIds,
    response.truncated ? [truncationDecoration(response, args.labels.truncated)] : [],
  );
}

function requestBlame(state: BlameState, args: RegisterEditorBlameArgs, request: number): void {
  void args
    .resolve()
    .then((response) => {
      if (response === null || state.disposed || !state.enabled || request !== state.sequence)
        return;
      applyBlame(state, args, response);
    })
    .catch((error: unknown) => {
      if (state.disposed || !state.enabled || request !== state.sequence) return;
      args.onError?.(error instanceof Error ? error.message : "Blame read failed");
    });
}

function toggleBlame(state: BlameState, args: RegisterEditorBlameArgs): void {
  state.enabled = !state.enabled;
  const request = ++state.sequence;
  if (state.enabled) requestBlame(state, args, request);
  else clearBlame(state, args);
}

function openBlameLine(state: BlameState, args: RegisterEditorBlameArgs, lineNumber: number): void {
  const line = state.lines.get(lineNumber);
  if (line !== undefined && !ZERO_HASH.test(line.commitHash)) args.onCommit(line.commitHash);
}

// KEIKO-0378: a model swap (the host reassigns the editor's active document, e.g. switching files
// in the same pane) must never let a click resolve a commit fetched for the previous file. Bump
// the sequence so the existing `request !== state.sequence` guard in `requestBlame` discards any
// in-flight response for the old model, clear the cache and decorations, and fail closed by
// disabling blame outright -- both call sites of `openBlameLine` gate on `state.enabled`, so
// re-enabling requires an explicit re-toggle that fetches fresh data for the new model (matching
// diagnostics-bridge.ts's model-swap handling).
function handleModelSwap(state: BlameState, args: RegisterEditorBlameArgs): void {
  state.sequence += 1;
  clearBlame(state, args);
  state.enabled = false;
}

function createBlameState(): BlameState {
  return {
    enabled: false,
    disposed: false,
    sequence: 0,
    lines: new Map(),
    lineIds: [],
    truncationIds: [],
    model: null,
  };
}

export function registerEditorBlame(args: RegisterEditorBlameArgs): EditorBlameBridge {
  if (args.degraded) return inertBridge();
  const state: BlameState = createBlameState();
  const mouse = args.editor.onMouseDown((event) => {
    const line = event.target.position?.lineNumber;
    if (state.enabled && event.target.type === args.glyphMarginTargetType && line !== undefined) {
      openBlameLine(state, args, line);
    }
  });
  const modelChange = args.editor.onDidChangeModel(() => {
    handleModelSwap(state, args);
  });
  const toggleAction = args.editor.addAction({
    id: "keiko.editor.toggleBlame",
    label: args.labels.toggle,
    run: () => {
      toggleBlame(state, args);
    },
  });
  const openAction = args.editor.addAction({
    id: "keiko.editor.openBlameCommit",
    label: args.labels.openCommit,
    run: () => {
      const line = args.editor.getPosition?.()?.lineNumber;
      if (state.enabled && line !== undefined) openBlameLine(state, args, line);
    },
  });
  return {
    toggle: (): void => {
      toggleBlame(state, args);
    },
    dispose(): void {
      state.disposed = true;
      state.enabled = false;
      state.sequence += 1;
      mouse.dispose();
      modelChange.dispose();
      toggleAction.dispose();
      openAction.dispose();
      clearBlame(state, args);
    },
  };
}
