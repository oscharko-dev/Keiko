import { describe, expect, it, vi } from "vitest";
import type { SourceBreakpoint } from "@oscharko-dev/keiko-contracts";

import {
  registerEditorBreakpointGutter,
  type MonacoBreakpointGutterEditor,
} from "./breakpoint-gutter-bridge.js";

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
  mouse(line: number, rightButton: boolean): void;
} {
  let listener: Parameters<MonacoBreakpointGutterEditor["onMouseDown"]>[0] = (): void => undefined;
  let position = 3;
  const decorationCalls: (readonly unknown[])[] = [];
  const actions = new Map<string, () => void>();
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
        return { dispose: (): void => undefined };
      },
    },
    decorationCalls,
    actions,
    mouse: (line, rightButton): void => {
      position = line;
      listener({
        event: { rightButton },
        target: { type: 7, position: { lineNumber: line } },
      });
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
});
