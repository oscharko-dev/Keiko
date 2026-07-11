import type { GitEditorDiffHunk } from "@oscharko-dev/keiko-contracts";

import type { MonacoDisposable, MonacoRange } from "./completion-bridge.js";

export type EditorGitGutterLayer = "staged" | "unstaged";

export interface EditorGitGutterChanges {
  readonly staged: readonly GitEditorDiffHunk[];
  readonly unstaged: readonly GitEditorDiffHunk[];
}

export type EditorGitGutterResolver = () => Promise<EditorGitGutterChanges>;

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
      isWholeLine: true,
    },
  };
}

function decorationsForHunk(
  hunk: GitEditorDiffHunk,
  layer: EditorGitGutterLayer,
  labels: EditorGitGutterLabels,
): readonly MonacoGutterDecoration[] {
  const kind = changeKind(hunk);
  if (kind === "deleted") return [decoration(Math.max(1, hunk.newStart), kind, layer, labels)];
  const lines = new Set(
    hunk.lines.flatMap((line) =>
      line.kind === "add" && line.newLine !== null ? [line.newLine] : [],
    ),
  );
  return [...lines].map((line) => decoration(line, kind, layer, labels));
}

function containsLine(hunk: GitEditorDiffHunk, line: number): boolean {
  const count = Math.max(1, hunk.newCount);
  return line >= hunk.newStart && line < hunk.newStart + count;
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

export function registerEditorGitGutter(args: RegisterEditorGitGutterArgs): EditorGitGutterBridge {
  if (args.degraded) return degradedBridge();
  let disposed = false;
  let sequence = 0;
  let changes = EMPTY_CHANGES;
  let stagedIds: string[] = [];
  let unstagedIds: string[] = [];

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
  const refresh = (): void => {
    const request = ++sequence;
    void args
      .resolve()
      .then((next) => {
        if (!disposed && request === sequence) apply(next);
      })
      .catch((error: unknown) => {
        if (disposed || request !== sequence) return;
        const message = error instanceof Error ? error.message : "Git gutter refresh failed";
        args.onError?.(message);
      });
  };
  const interactions = installInteractions(args, () => changes, refresh);
  refresh();
  return {
    refresh,
    dispose(): void {
      disposed = true;
      sequence += 1;
      for (const interaction of interactions) interaction.dispose();
      stagedIds = args.editor.deltaDecorations(stagedIds, []);
      unstagedIds = args.editor.deltaDecorations(unstagedIds, []);
      changes = EMPTY_CHANGES;
    },
  };
}
