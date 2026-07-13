import type { SourceBreakpoint } from "@oscharko-dev/keiko-contracts";

import type { MonacoDisposable, MonacoRange } from "./completion-bridge.js";

export type EditorDebugBreakpointAction =
  "toggle" | "toggleConditional" | "editLogpoint" | "toggleEnabled";

export interface EditorDebugBreakpointLabels {
  readonly toggle: string;
  readonly conditional: string;
  readonly logpoint: string;
  readonly enable: string;
  readonly disable: string;
}

export interface EditorDebugBreakpointContext {
  readonly line: number;
  readonly breakpoint: SourceBreakpoint | undefined;
  readonly actions: readonly EditorDebugBreakpointAction[];
}

export interface EditorDebugBreakpointHost {
  readonly resolveBreakpoints: () => readonly SourceBreakpoint[];
  readonly pausedLine?: number | undefined;
  readonly resolvePausedLine?: (() => number | undefined) | undefined;
  readonly labels: EditorDebugBreakpointLabels;
  readonly onToggleBreakpoint: (line: number) => void;
  readonly onToggleConditionalBreakpoint: (line: number) => void;
  readonly onEditLogpoint: (line: number) => void;
  readonly onToggleBreakpointEnabled: (breakpoint: SourceBreakpoint) => void;
  readonly onOpenContextMenu: (context: EditorDebugBreakpointContext) => void;
}

interface MonacoGutterDecoration {
  readonly range: MonacoRange;
  readonly options: {
    readonly description: string;
    readonly glyphMarginClassName: string;
    readonly glyphMarginHoverMessage: { readonly value: string };
    readonly isWholeLine: true;
  };
}

interface MonacoMouseEventLike {
  readonly event: { readonly rightButton: boolean };
  readonly target: {
    readonly type: number;
    readonly position?: { readonly lineNumber: number } | null | undefined;
  };
}

export interface MonacoBreakpointGutterEditor {
  deltaDecorations(
    oldDecorations: string[],
    newDecorations: readonly MonacoGutterDecoration[],
  ): string[];
  onMouseDown(listener: (event: MonacoMouseEventLike) => void): MonacoDisposable;
  getPosition(): { readonly lineNumber: number; readonly column: number } | null;
  addAction(descriptor: {
    readonly id: string;
    readonly label: string;
    readonly run: () => void;
  }): MonacoDisposable;
}

export interface EditorBreakpointGutterBridge extends MonacoDisposable {
  refresh(): void;
}

export interface RegisterEditorBreakpointGutterArgs extends EditorDebugBreakpointHost {
  readonly editor: MonacoBreakpointGutterEditor;
  readonly glyphMarginTargetType: number;
}

const GUTTER_ACTIONS: readonly EditorDebugBreakpointAction[] = [
  "toggle",
  "toggleConditional",
  "editLogpoint",
  "toggleEnabled",
];

function visualState(breakpoint: SourceBreakpoint): "line" | "conditional" | "logpoint" | "ring" {
  if (!breakpoint.enabled || breakpoint.verification !== "verified") return "ring";
  if (breakpoint.kind === "conditional") return "conditional";
  return breakpoint.kind;
}

function description(breakpoint: SourceBreakpoint, labels: EditorDebugBreakpointLabels): string {
  if (!breakpoint.enabled) return labels.enable;
  if (breakpoint.kind === "conditional") return labels.conditional;
  if (breakpoint.kind === "logpoint") return labels.logpoint;
  return labels.toggle;
}

function decoration(
  breakpoint: SourceBreakpoint,
  pausedLine: number | undefined,
  labels: EditorDebugBreakpointLabels,
): MonacoGutterDecoration {
  const classes = ["keiko-debug-breakpoint", `keiko-debug-breakpoint-${visualState(breakpoint)}`];
  if (pausedLine === breakpoint.line) classes.push("keiko-debug-breakpoint-hit");
  const label = description(breakpoint, labels);
  return {
    range: {
      startLineNumber: breakpoint.line,
      startColumn: 1,
      endLineNumber: breakpoint.line,
      endColumn: 1,
    },
    options: {
      description: label,
      glyphMarginClassName: classes.join(" "),
      glyphMarginHoverMessage: { value: label },
      isWholeLine: true,
    },
  };
}

function breakpointAtLine(
  breakpoints: readonly SourceBreakpoint[],
  line: number,
): SourceBreakpoint | undefined {
  return breakpoints.find((breakpoint) => breakpoint.line === line);
}

function actionForLine(
  host: EditorDebugBreakpointHost,
  line: number,
  action: EditorDebugBreakpointAction,
): void {
  const breakpoint = breakpointAtLine(host.resolveBreakpoints(), line);
  if (action === "toggle") host.onToggleBreakpoint(line);
  if (action === "toggleConditional") host.onToggleConditionalBreakpoint(line);
  if (action === "editLogpoint") host.onEditLogpoint(line);
  if (action === "toggleEnabled" && breakpoint !== undefined)
    host.onToggleBreakpointEnabled(breakpoint);
}

function gutterActionDescriptors(
  host: EditorDebugBreakpointHost,
  editor: MonacoBreakpointGutterEditor,
): readonly MonacoDisposable[] {
  const currentLine = (): number | undefined => editor.getPosition()?.lineNumber;
  const entry = (
    action: EditorDebugBreakpointAction,
    id: string,
    label: string,
  ): MonacoDisposable =>
    editor.addAction({
      id,
      label,
      run: (): void => {
        const line = currentLine();
        if (line !== undefined) actionForLine(host, line, action);
      },
    });
  return [
    entry("toggle", "keiko.editor.debugToggleBreakpoint", host.labels.toggle),
    entry(
      "toggleConditional",
      "keiko.editor.debugToggleConditionalBreakpoint",
      host.labels.conditional,
    ),
    entry("editLogpoint", "keiko.editor.debugEditLogpoint", host.labels.logpoint),
    entry("toggleEnabled", "keiko.editor.debugToggleBreakpointEnabled", host.labels.disable),
  ];
}

export function registerEditorBreakpointGutter(
  args: RegisterEditorBreakpointGutterArgs,
): EditorBreakpointGutterBridge {
  let decorationIds: string[] = [];
  const refresh = (): void => {
    decorationIds = args.editor.deltaDecorations(
      decorationIds,
      args
        .resolveBreakpoints()
        .map((breakpoint) =>
          decoration(breakpoint, args.resolvePausedLine?.() ?? args.pausedLine, args.labels),
        ),
    );
  };
  const mouse = args.editor.onMouseDown((event) => {
    const line = event.target.position?.lineNumber;
    if (event.target.type !== args.glyphMarginTargetType || line === undefined) return;
    if (!event.event.rightButton) {
      args.onToggleBreakpoint(line);
      return;
    }
    args.onOpenContextMenu({
      line,
      breakpoint: breakpointAtLine(args.resolveBreakpoints(), line),
      actions: GUTTER_ACTIONS,
    });
  });
  const actions = gutterActionDescriptors(args, args.editor);
  refresh();
  return {
    refresh,
    dispose(): void {
      mouse.dispose();
      for (const action of actions) action.dispose();
      decorationIds = args.editor.deltaDecorations(decorationIds, []);
    },
  };
}
