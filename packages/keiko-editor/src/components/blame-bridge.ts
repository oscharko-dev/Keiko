import type { GitEditorBlameLine, GitEditorBlameResponse } from "@oscharko-dev/keiko-contracts";

import type { MonacoDisposable, MonacoRange } from "./completion-bridge.js";

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

export interface MonacoBlameEditor {
  deltaDecorations(oldDecorations: string[], next: readonly MonacoBlameDecoration[]): string[];
  getPosition?(): { readonly lineNumber: number; readonly column: number } | null;
  onMouseDown(listener: (event: MonacoMouseEventLike) => void): MonacoDisposable;
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
}

function clearBlame(state: BlameState, args: RegisterEditorBlameArgs): void {
  state.lineIds = args.editor.deltaDecorations(state.lineIds, []);
  state.truncationIds = args.editor.deltaDecorations(state.truncationIds, []);
  state.lines = new Map();
}

function applyBlame(
  state: BlameState,
  args: RegisterEditorBlameArgs,
  response: GitEditorBlameResponse,
): void {
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

export function registerEditorBlame(args: RegisterEditorBlameArgs): EditorBlameBridge {
  if (args.degraded) return inertBridge();
  const state: BlameState = {
    enabled: false,
    disposed: false,
    sequence: 0,
    lines: new Map(),
    lineIds: [],
    truncationIds: [],
  };
  const mouse = args.editor.onMouseDown((event) => {
    const line = event.target.position?.lineNumber;
    if (state.enabled && event.target.type === args.glyphMarginTargetType && line !== undefined) {
      openBlameLine(state, args, line);
    }
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
      toggleAction.dispose();
      openAction.dispose();
      clearBlame(state, args);
    },
  };
}
