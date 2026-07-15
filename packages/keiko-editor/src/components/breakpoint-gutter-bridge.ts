import type { SourceBreakpoint } from "@oscharko-dev/keiko-contracts";

import type { MonacoDisposable, MonacoRange } from "./completion-bridge.js";
import { DEBUG_GLYPH_MARGIN_LANE } from "./glyph-margin-lanes.js";

export type EditorDebugBreakpointAction =
  "toggle" | "toggleConditional" | "editLogpoint" | "toggleEnabled";

export interface EditorDebugBreakpointLabels {
  readonly toggle: string;
  readonly conditional: string;
  readonly logpoint: string;
  readonly enable: string;
  readonly disable: string;
  /**
   * Hover/description text for the current-execution-line marker (see {@link DEFAULT_CURRENT_LINE_LABEL}
   * for the fallback). Shown when the session is paused on a line with no breakpoint at all — after
   * Step Over/Into/Out, or an uncaught exception on an unbroken line — so the paused location always
   * has a gutter affordance, not only the (possibly closed) Call Stack panel. Optional so existing
   * label sets built before this marker existed remain valid.
   */
  readonly currentLine?: string | undefined;
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
    readonly glyphMargin: { readonly position: number };
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
      glyphMargin: { position: DEBUG_GLYPH_MARGIN_LANE },
      isWholeLine: true,
    },
  };
}

const DEFAULT_CURRENT_LINE_LABEL = "Current execution line";

// A shape-distinct marker (not merely the -hit ring color; see debug-monaco-styles.ts) for the
// paused execution point. Emitted only when no breakpoint decoration already occupies that line, so
// a step (Step Over/Into/Out) or an uncaught exception on an unbroken line still leaves a gutter
// affordance at the paused location instead of no marker at all (Epic #2096 a11y-sweep finding 4).
function currentLineDecoration(line: number, label: string): MonacoGutterDecoration {
  return {
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: {
      description: label,
      glyphMarginClassName: "keiko-debug-current-line",
      glyphMarginHoverMessage: { value: label },
      glyphMargin: { position: DEBUG_GLYPH_MARGIN_LANE },
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

const TOGGLE_ENABLED_ACTION_ID = "keiko.editor.debugToggleBreakpointEnabled";

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
  ];
}

// Monaco's editor.addAction() descriptor takes a fixed label string; there is no live-relabel
// primitive for an already-registered action. A static "Disable Breakpoint" label would misreport
// the command's actual effect whenever the cursor sits on a currently-disabled breakpoint (it would
// enable it, not disable it) — unlike the right-click context menu, which recomputes its label from
// live state on every open. This action is therefore disposed and re-added (with a freshly computed
// label for the current cursor line) every time the gutter refreshes, which is the same cadence the
// glyph decorations already use to stay in sync with the live breakpoint set.
function toggleEnabledLabel(
  host: EditorDebugBreakpointHost,
  editor: MonacoBreakpointGutterEditor,
): string {
  const line = editor.getPosition()?.lineNumber;
  const breakpoint =
    line === undefined ? undefined : breakpointAtLine(host.resolveBreakpoints(), line);
  return breakpoint?.enabled === false ? host.labels.enable : host.labels.disable;
}

function registerToggleEnabledAction(
  host: EditorDebugBreakpointHost,
  editor: MonacoBreakpointGutterEditor,
): MonacoDisposable {
  return editor.addAction({
    id: TOGGLE_ENABLED_ACTION_ID,
    label: toggleEnabledLabel(host, editor),
    run: (): void => {
      const line = editor.getPosition()?.lineNumber;
      if (line !== undefined) actionForLine(host, line, "toggleEnabled");
    },
  });
}

export function registerEditorBreakpointGutter(
  args: RegisterEditorBreakpointGutterArgs,
): EditorBreakpointGutterBridge {
  let decorationIds: string[] = [];
  let toggleEnabledAction: MonacoDisposable | null = null;
  const refresh = (): void => {
    const breakpoints = args.resolveBreakpoints();
    const pausedLine = args.resolvePausedLine?.() ?? args.pausedLine;
    const decorations = breakpoints.map((breakpoint) =>
      decoration(breakpoint, pausedLine, args.labels),
    );
    if (pausedLine !== undefined && breakpointAtLine(breakpoints, pausedLine) === undefined) {
      decorations.push(
        currentLineDecoration(pausedLine, args.labels.currentLine ?? DEFAULT_CURRENT_LINE_LABEL),
      );
    }
    decorationIds = args.editor.deltaDecorations(decorationIds, decorations);
    toggleEnabledAction?.dispose();
    toggleEnabledAction = registerToggleEnabledAction(args, args.editor);
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
      toggleEnabledAction?.dispose();
      decorationIds = args.editor.deltaDecorations(decorationIds, []);
    },
  };
}
