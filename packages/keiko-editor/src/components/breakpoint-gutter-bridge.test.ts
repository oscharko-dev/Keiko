import { describe, expect, it, vi } from "vitest";
import type { SourceBreakpoint } from "@oscharko-dev/keiko-contracts";

import {
  registerEditorBreakpointGutter,
  type MonacoBreakpointGutterEditor,
} from "./breakpoint-gutter-bridge.js";
import {
  BLAME_GLYPH_MARGIN_LANE,
  DEBUG_GLYPH_MARGIN_LANE,
  GIT_GUTTER_GLYPH_MARGIN_LANE,
} from "./glyph-margin-lanes.js";

const LABELS = {
  toggle: "Toggle Breakpoint",
  conditional: "Toggle Conditional Breakpoint",
  logpoint: "Edit Logpoint",
  enable: "Enable Breakpoint",
  disable: "Disable Breakpoint",
};

function breakpoint(
  overrides: Partial<{
    readonly line: number;
    readonly kind: "line" | "conditional" | "logpoint";
    readonly enabled: boolean;
    readonly verification: "pending" | "verified" | "rejected";
  }> = {},
): SourceBreakpoint {
  return {
    id: "bp",
    fileId: "src/a.ts",
    line: 3,
    kind: "line" as const,
    enabled: true,
    verification: "verified" as const,
    ...overrides,
  };
}

function fixture(): {
  readonly editor: MonacoBreakpointGutterEditor;
  readonly decorationCalls: readonly (readonly unknown[])[];
  readonly actions: Map<string, () => void>;
  readonly labels: Map<string, string>;
  mouse(line: number, rightButton: boolean): void;
  moveCursor(line: number): void;
} {
  let listener: Parameters<MonacoBreakpointGutterEditor["onMouseDown"]>[0] = (): void => undefined;
  let position = 3;
  const decorationCalls: (readonly unknown[])[] = [];
  const actions = new Map<string, () => void>();
  const labels = new Map<string, string>();
  return {
    editor: {
      deltaDecorations: (oldIds, decorations): string[] => {
        decorationCalls.push([oldIds, decorations]);
        return decorations.map((_, index) => `id-${String(index)}`);
      },
      onMouseDown: (next): { dispose: () => void } => {
        listener = next;
        return { dispose: (): void => undefined };
      },
      getPosition: (): { readonly lineNumber: number; readonly column: number } => ({
        lineNumber: position,
        column: 1,
      }),
      addAction: (descriptor): { dispose: () => void } => {
        actions.set(descriptor.id, descriptor.run);
        labels.set(descriptor.id, descriptor.label);
        return { dispose: (): void => undefined };
      },
    },
    decorationCalls,
    actions,
    labels,
    mouse: (line, rightButton): void => {
      position = line;
      listener({
        event: { rightButton },
        target: { type: 7, position: { lineNumber: line } },
      });
    },
    moveCursor: (line): void => {
      position = line;
    },
  };
}

describe("registerEditorBreakpointGutter", () => {
  it("toggles a breakpoint on glyph click and exposes the complete contextual operation set on right click", () => {
    const view = fixture();
    const onToggleBreakpoint = vi.fn();
    const onOpenContextMenu = vi.fn();
    registerEditorBreakpointGutter({
      editor: view.editor,
      glyphMarginTargetType: 7,
      labels: LABELS,
      resolveBreakpoints: () => [breakpoint()],
      onToggleBreakpoint,
      onToggleConditionalBreakpoint: vi.fn(),
      onEditLogpoint: vi.fn(),
      onToggleBreakpointEnabled: vi.fn(),
      onOpenContextMenu,
    });

    view.mouse(3, false);
    view.mouse(3, true);
    expect(onToggleBreakpoint).toHaveBeenCalledWith(3);
    expect(onOpenContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        line: 3,
        actions: ["toggle", "toggleConditional", "editLogpoint", "toggleEnabled"],
      }),
    );
  });

  it("projects verified, conditional, logpoint, disabled, and hit states with distinct glyph classes", () => {
    const view = fixture();
    registerEditorBreakpointGutter({
      editor: view.editor,
      glyphMarginTargetType: 7,
      labels: LABELS,
      pausedLine: 7,
      resolveBreakpoints: () => [
        breakpoint({ line: 2 }),
        breakpoint({ line: 3, kind: "conditional" }),
        breakpoint({ line: 4, kind: "logpoint" }),
        breakpoint({ line: 5, enabled: false }),
        breakpoint({ line: 7 }),
      ],
      onToggleBreakpoint: vi.fn(),
      onToggleConditionalBreakpoint: vi.fn(),
      onEditLogpoint: vi.fn(),
      onToggleBreakpointEnabled: vi.fn(),
      onOpenContextMenu: vi.fn(),
    });

    const decorations = view.decorationCalls[0]?.[1] as readonly {
      readonly options: { readonly glyphMarginClassName: string };
    }[];
    expect(decorations.map((item) => item.options.glyphMarginClassName)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("-line"),
        expect.stringContaining("-conditional"),
        expect.stringContaining("-logpoint"),
        expect.stringContaining("-ring"),
        expect.stringContaining("-hit"),
      ]),
    );
  });

  it("invokes every gutter operation through an editor action without a pointer event", () => {
    const view = fixture();
    const onToggleBreakpoint = vi.fn();
    const onToggleConditionalBreakpoint = vi.fn();
    const onEditLogpoint = vi.fn();
    const onToggleBreakpointEnabled = vi.fn();
    registerEditorBreakpointGutter({
      editor: view.editor,
      glyphMarginTargetType: 7,
      labels: LABELS,
      resolveBreakpoints: () => [breakpoint()],
      onToggleBreakpoint,
      onToggleConditionalBreakpoint,
      onEditLogpoint,
      onToggleBreakpointEnabled,
      onOpenContextMenu: vi.fn(),
    });

    for (const action of view.actions.values()) action();
    expect(onToggleBreakpoint).toHaveBeenCalledWith(3);
    expect(onToggleConditionalBreakpoint).toHaveBeenCalledWith(3);
    expect(onEditLogpoint).toHaveBeenCalledWith(3);
    expect(onToggleBreakpointEnabled).toHaveBeenCalledWith(expect.objectContaining({ id: "bp" }));
  });

  it("labels the command-palette toggle-enabled action from the current line's live state, not a static 'Disable'", () => {
    const view = fixture();
    let breakpoints: readonly SourceBreakpoint[] = [breakpoint({ line: 3, enabled: false })];
    const bridge = registerEditorBreakpointGutter({
      editor: view.editor,
      glyphMarginTargetType: 7,
      labels: LABELS,
      resolveBreakpoints: () => breakpoints,
      onToggleBreakpoint: vi.fn(),
      onToggleConditionalBreakpoint: vi.fn(),
      onEditLogpoint: vi.fn(),
      onToggleBreakpointEnabled: vi.fn(),
      onOpenContextMenu: vi.fn(),
    });

    // The cursor sits on a currently-DISABLED breakpoint: invoking the action would enable it, so
    // the label must say "Enable", never the static "Disable" the old registration always used.
    expect(view.labels.get("keiko.editor.debugToggleBreakpointEnabled")).toBe(LABELS.enable);

    // Once the breakpoint becomes enabled and the gutter refreshes (the same signal that redraws
    // the glyph decorations), the command-palette label must flip to match the new live state.
    breakpoints = [breakpoint({ line: 3, enabled: true })];
    bridge.refresh();
    expect(view.labels.get("keiko.editor.debugToggleBreakpointEnabled")).toBe(LABELS.disable);

    bridge.dispose();
  });

  it("marks the paused execution line even when it has no breakpoint (Epic #2096 a11y-sweep finding 4)", () => {
    // Stepping (Step Over/Into/Out) or an uncaught exception can pause execution on a line with no
    // breakpoint at all. Before this fix, refresh() only ever emitted one decoration per resolved
    // breakpoint, so that paused line got no gutter marker whatsoever.
    const view = fixture();
    registerEditorBreakpointGutter({
      editor: view.editor,
      glyphMarginTargetType: 7,
      labels: LABELS,
      pausedLine: 9,
      resolveBreakpoints: () => [breakpoint({ line: 2 })],
      onToggleBreakpoint: vi.fn(),
      onToggleConditionalBreakpoint: vi.fn(),
      onEditLogpoint: vi.fn(),
      onToggleBreakpointEnabled: vi.fn(),
      onOpenContextMenu: vi.fn(),
    });

    const decorations = view.decorationCalls[0]?.[1] as readonly {
      readonly range: { readonly startLineNumber: number };
      readonly options: { readonly glyphMarginClassName: string };
    }[];
    const currentLineDecoration = decorations.find(
      (item) => item.options.glyphMarginClassName === "keiko-debug-current-line",
    );
    expect(currentLineDecoration?.range.startLineNumber).toBe(9);
    // The unrelated pre-existing breakpoint at line 2 must still render, untouched, alongside it.
    expect(decorations.some((item) => item.options.glyphMarginClassName.includes("-line"))).toBe(
      true,
    );
  });

  it("never double-marks a paused line that already has its own breakpoint decoration", () => {
    const view = fixture();
    registerEditorBreakpointGutter({
      editor: view.editor,
      glyphMarginTargetType: 7,
      labels: LABELS,
      pausedLine: 3,
      resolveBreakpoints: () => [breakpoint({ line: 3 })],
      onToggleBreakpoint: vi.fn(),
      onToggleConditionalBreakpoint: vi.fn(),
      onEditLogpoint: vi.fn(),
      onToggleBreakpointEnabled: vi.fn(),
      onOpenContextMenu: vi.fn(),
    });

    const decorations = view.decorationCalls[0]?.[1] as readonly {
      readonly options: { readonly glyphMarginClassName: string };
    }[];
    expect(
      decorations.filter(
        (item) => item.options.glyphMarginClassName === "keiko-debug-current-line",
      ),
    ).toHaveLength(0);
  });

  it("renders on its own glyph-margin lane so it never shares a DOM node with git-gutter/blame decorations (Epic #2096, ADR-0136 Target Outcome 5)", () => {
    const view = fixture();
    registerEditorBreakpointGutter({
      editor: view.editor,
      glyphMarginTargetType: 7,
      labels: LABELS,
      resolveBreakpoints: () => [breakpoint()],
      onToggleBreakpoint: vi.fn(),
      onToggleConditionalBreakpoint: vi.fn(),
      onEditLogpoint: vi.fn(),
      onToggleBreakpointEnabled: vi.fn(),
      onOpenContextMenu: vi.fn(),
    });

    const decorations = view.decorationCalls[0]?.[1] as readonly {
      readonly options: { readonly glyphMargin: { readonly position: number } };
    }[];
    expect(decorations[0]?.options.glyphMargin).toEqual({ position: DEBUG_GLYPH_MARGIN_LANE });
    // The three gutter-decoration sources must occupy three distinct lanes, or Monaco's default
    // (Center for every decoration that omits `glyphMargin`) collides them onto one DOM node.
    expect(DEBUG_GLYPH_MARGIN_LANE).not.toBe(GIT_GUTTER_GLYPH_MARGIN_LANE);
    expect(DEBUG_GLYPH_MARGIN_LANE).not.toBe(BLAME_GLYPH_MARGIN_LANE);
    expect(GIT_GUTTER_GLYPH_MARGIN_LANE).not.toBe(BLAME_GLYPH_MARGIN_LANE);
  });
});
