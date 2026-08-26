import type { GitEditorDiffHunk } from "@oscharko-dev/keiko-contracts";

import type { MonacoDisposable, MonacoRange } from "./completion-bridge.js";
import { GIT_GUTTER_GLYPH_MARGIN_LANE } from "./glyph-margin-lanes.js";

export type EditorGitGutterLayer = "staged" | "unstaged";

export interface EditorGitGutterChanges {
  readonly staged: readonly GitEditorDiffHunk[];
  readonly unstaged: readonly GitEditorDiffHunk[];
}

// KEIKO-0897: every other host-resolver in this territory threads an AbortSignal wired to a
// Monaco cancellation token / AbortController so the underlying host call can be told to stop early
// rather than merely having its result ignored on arrival. The git-gutter resolver now matches
// that shape; this is a breaking type change on the public host-port surface, so consumers of
// KeikoCodeEditorProps.editorGitGutter must update accordingly.
export type EditorGitGutterResolver = (signal: AbortSignal) => Promise<EditorGitGutterChanges>;

export interface EditorGitGutterPeek {
  readonly hunk: GitEditorDiffHunk;
  readonly layer: EditorGitGutterLayer;
}

export interface EditorGitGutterLabels {
  readonly staged: string;
  readonly unstaged: string;
  readonly added: string;
  readonly modified: string;
  readonly deleted: string;
  readonly openHunk: string;
}

export interface EditorGitGutterHost {
  readonly resolve: EditorGitGutterResolver;
  readonly labels: EditorGitGutterLabels;
  readonly onPeek: (peek: EditorGitGutterPeek) => void;
}

interface MonacoMarkdownStringLike {
  readonly value: string;
}

interface MonacoGutterDecoration {
  readonly range: MonacoRange;
  readonly options: {
    readonly description: string;
    readonly glyphMarginClassName: string;
    readonly glyphMarginHoverMessage: MonacoMarkdownStringLike;
    readonly glyphMargin: { readonly position: number };
    readonly isWholeLine: true;
  };
}

interface MonacoMouseEventLike {
  readonly target: {
    readonly type: number;
    readonly position?: { readonly lineNumber: number } | null | undefined;
  };
}

export interface MonacoGitGutterEditor {
  deltaDecorations(
    oldDecorations: string[],
    newDecorations: readonly MonacoGutterDecoration[],
  ): string[];
  onDidFocusEditorWidget(listener: () => void): MonacoDisposable;
  onMouseDown(listener: (event: MonacoMouseEventLike) => void): MonacoDisposable;
  getPosition?(): { readonly lineNumber: number; readonly column: number } | null;
  addAction?(descriptor: {
    readonly id: string;
    readonly label: string;
    readonly run: () => void;
  }): MonacoDisposable;
}

export interface EditorGitGutterBridge extends MonacoDisposable {
  refresh(): void;
}

export interface RegisterEditorGitGutterArgs {
  readonly editor: MonacoGitGutterEditor;
  readonly resolve: EditorGitGutterResolver;
  readonly labels: EditorGitGutterLabels;
  readonly glyphMarginTargetType: number;
  readonly degraded: boolean;
  readonly onPeek: (peek: EditorGitGutterPeek) => void;
  readonly onError?: ((message: string) => void) | undefined;
}

function changeKind(hunk: GitEditorDiffHunk): "added" | "modified" | "deleted" {
  const additions = hunk.lines.some((line) => line.kind === "add");
  const deletions = hunk.lines.some((line) => line.kind === "del");
  if (additions && !deletions) return "added";
  if (deletions && !additions) return "deleted";
  return "modified";
}

function decoration(
  line: number,
  kind: "added" | "modified" | "deleted",
  layer: EditorGitGutterLayer,
  labels: EditorGitGutterLabels,
): MonacoGutterDecoration {
  const layerLabel = labels[layer];
  const kindLabel = labels[kind];
  const description = `${layerLabel}: ${kindLabel}`;
  return {
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: {
      description,
      glyphMarginClassName: `keiko-git-gutter keiko-git-gutter-${layer} keiko-git-gutter-${kind}`,
      glyphMarginHoverMessage: { value: description },
      glyphMargin: { position: GIT_GUTTER_GLYPH_MARGIN_LANE },
      isWholeLine: true,
    },
  };
}

// Monaco lines are 1-based, but a hunk's unclamped new-file start can be 0 (standard unified-diff
// shape for a deletion with no remaining leading context). Both the rendered decoration and hit
// testing must agree on the same clamped line, or a click can silently miss the hunk it renders.
function effectiveStartLine(hunk: GitEditorDiffHunk): number {
  return Math.max(1, hunk.newStart);
}

function decorationsForHunk(
  hunk: GitEditorDiffHunk,
  layer: EditorGitGutterLayer,
  labels: EditorGitGutterLabels,
): readonly MonacoGutterDecoration[] {
  const kind = changeKind(hunk);
  if (kind === "deleted") return [decoration(effectiveStartLine(hunk), kind, layer, labels)];
  const lines = new Set(
    hunk.lines.flatMap((line) =>
      line.kind === "add" && line.newLine !== null ? [line.newLine] : [],
    ),
  );
  return [...lines].map((line) => decoration(line, kind, layer, labels));
}

function containsLine(hunk: GitEditorDiffHunk, line: number): boolean {
  const start = effectiveStartLine(hunk);
  const count = Math.max(1, hunk.newCount);
  return line >= start && line < start + count;
}

function peekAtLine(changes: EditorGitGutterChanges, line: number): EditorGitGutterPeek | null {
  for (const layer of ["unstaged", "staged"] as const) {
    const hunk = changes[layer].find((candidate) => containsLine(candidate, line));
    if (hunk !== undefined) return { hunk, layer };
  }
  return null;
}

const EMPTY_CHANGES: EditorGitGutterChanges = { staged: [], unstaged: [] };

function degradedBridge(): EditorGitGutterBridge {
  return {
    refresh(): void {
      // Deliberately inert: degraded mode performs no subscriptions, reads, or decoration work.
    },
    dispose(): void {
      // No resources are acquired in degraded mode.
    },
  };
}

function installInteractions(
  args: RegisterEditorGitGutterArgs,
  currentChanges: () => EditorGitGutterChanges,
  refresh: () => void,
): readonly MonacoDisposable[] {
  const openAtLine = (line: number): void => {
    const peek = peekAtLine(currentChanges(), line);
    if (peek !== null) args.onPeek(peek);
  };
  const focus = args.editor.onDidFocusEditorWidget(refresh);
  const mouse = args.editor.onMouseDown((event) => {
    const line = event.target.position?.lineNumber;
    if (event.target.type === args.glyphMarginTargetType && line !== undefined) openAtLine(line);
  });
  const action = args.editor.addAction?.({
    id: "keiko.editor.openChangeHunk",
    label: args.labels.openHunk,
    run: () => {
      const line = args.editor.getPosition?.()?.lineNumber;
      if (line !== undefined) openAtLine(line);
    },
  });
  return action === undefined ? [focus, mouse] : [focus, mouse, action];
}

// KEIKO-0897: distinguish an aborted resolve() from a real failure — mirrors the pattern in the
// sibling bridges (hover-bridge.ts, inline-completion-bridge.ts) so an in-flight refresh that is
// cancelled by a fresh refresh() or by dispose() does not surface as an error to the host.
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// Per-refresh AbortController: a fresh refresh() aborts any still-active previous one so the host
// resolver can stop early instead of relying purely on a post-hoc sequence/disposed guard. Shared
// as one mutable object (rather than separate closure `let`s) so both the refresh closure built by
// makeGitGutterRefresh and dispose() observe and mutate the same state.
interface GitGutterRefreshState {
  disposed: boolean;
  sequence: number;
  activeController: AbortController | null;
}

/**
 * Builds the refresh() callback: aborts any in-flight resolve, issues a fresh one guarded by a
 * per-call sequence number, and applies the result or reports the error unless a later refresh or
 * dispose() has already superseded this call.
 */
function makeGitGutterRefresh(
  args: RegisterEditorGitGutterArgs,
  apply: (next: EditorGitGutterChanges) => void,
  state: GitGutterRefreshState,
): () => void {
  return (): void => {
    const request = ++state.sequence;
    state.activeController?.abort();
    const controller = new AbortController();
    state.activeController = controller;
    void args
      .resolve(controller.signal)
      .then((next) => {
        if (!state.disposed && request === state.sequence) apply(next);
      })
      .catch((error: unknown) => {
        if (state.disposed || request !== state.sequence || isAbortError(error)) return;
        const message = error instanceof Error ? error.message : "Git gutter refresh failed";
        args.onError?.(message);
      });
  };
}

export function registerEditorGitGutter(args: RegisterEditorGitGutterArgs): EditorGitGutterBridge {
  if (args.degraded) return degradedBridge();
  let changes = EMPTY_CHANGES;
  let stagedIds: string[] = [];
  let unstagedIds: string[] = [];
  const state: GitGutterRefreshState = { disposed: false, sequence: 0, activeController: null };

  const apply = (next: EditorGitGutterChanges): void => {
    changes = next;
    stagedIds = args.editor.deltaDecorations(
      stagedIds,
      next.staged.flatMap((hunk) => decorationsForHunk(hunk, "staged", args.labels)),
    );
    unstagedIds = args.editor.deltaDecorations(
      unstagedIds,
      next.unstaged.flatMap((hunk) => decorationsForHunk(hunk, "unstaged", args.labels)),
    );
  };
  const refresh = makeGitGutterRefresh(args, apply, state);
  const interactions = installInteractions(args, () => changes, refresh);
  refresh();
  return {
    refresh,
    dispose(): void {
      state.disposed = true;
      state.sequence += 1;
      state.activeController?.abort();
      state.activeController = null;
      for (const interaction of interactions) interaction.dispose();
      stagedIds = args.editor.deltaDecorations(stagedIds, []);
      unstagedIds = args.editor.deltaDecorations(unstagedIds, []);
      changes = EMPTY_CHANGES;
    },
  };
}
