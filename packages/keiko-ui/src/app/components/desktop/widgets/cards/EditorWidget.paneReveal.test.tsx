// Issue #2747 — a line reveal is addressed to the file cfg names alongside it, and `renderPane`
// hands every pane its OWN file. The outline reveal has carried that guard for a long time
// (`outlineRevealRequest?.file === file` in EditorRuntimeWidget); the line reveal did not, so a
// split view moved the cursor, scrolled and stole focus in every pane, each at that line number in
// whatever file it happened to show.
//
// The runtime widget is mocked rather than the Monaco surface: the defect lives in which props each
// pane is handed, so recording exactly that is both the cheapest and the most direct evidence.
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeEditorPane,
  createEditorLayoutStateV2,
  editorLayoutReducer,
  serializeEditorLayoutStateV2,
} from "@oscharko-dev/keiko-contracts";
import { paneLineRevealProps } from "./EditorWidget";
import type { EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import { EditorWidget } from "./EditorWidget";

const panes = vi.hoisted(() => [] as EditorRuntimeWidgetProps[]);

vi.mock("next/dynamic", () => ({
  default: () => {
    function RuntimeProbe(props: EditorRuntimeWidgetProps): ReactElement {
      panes.push(props);
      return <div data-testid={`pane-${props.paneId ?? "none"}`}>{props.file ?? "none"}</div>;
    }
    return RuntimeProbe;
  },
}));

vi.mock("./EditorDiffSurface", () => ({
  default: function DiffProbe(): ReactElement {
    return <div />;
  },
}));

afterEach(() => {
  panes.length = 0;
});

const ROOT = "/repo";
const ADDRESSED = "src/addressed.ts";
const SIBLING = "src/sibling.ts";

// Two panes, each showing a different file — the state the whole guard is about.
function splitLayoutJson(): string {
  const base = createEditorLayoutStateV2({
    root: ROOT,
    file: ADDRESSED,
    openFiles: [ADDRESSED, SIBLING],
    defaultSidebarWidth: 260,
    minSidebarWidth: 180,
    maxSidebarWidth: 440,
  });
  const split = editorLayoutReducer(base, {
    type: "split-pane",
    paneId: activeEditorPane(base).id,
    direction: "row",
    file: SIBLING,
  });
  return serializeEditorLayoutStateV2(split);
}

function revealOf(paneProps: EditorRuntimeWidgetProps): string {
  return `${String(paneProps.revealLineStart ?? "")}:${String(paneProps.revealLineEnd ?? "")}:${paneProps.revealRequestId ?? ""}`;
}

describe("EditorWidget line-reveal addressing across panes (#2747)", () => {
  it("hands the reveal only to the pane showing the addressed file", async () => {
    render(
      <EditorWidget
        root={ROOT}
        file={ADDRESSED}
        openFiles={[ADDRESSED, SIBLING]}
        layoutJson={splitLayoutJson()}
        revealLineStart={7}
        revealLineEnd={10}
        revealRequestId="reveal-1"
      />,
    );
    await screen.findByText(ADDRESSED);

    const byFile = new Map<string, string[]>();
    for (const paneProps of panes) {
      const file = paneProps.file ?? "none";
      byFile.set(file, [...new Set([...(byFile.get(file) ?? []), revealOf(paneProps)])]);
    }

    // Both panes mounted, and only the addressed one ever saw the request.
    expect(byFile.get(ADDRESSED)).toEqual(["7:10:reveal-1"]);
    expect(byFile.get(SIBLING)).toEqual(["::"]);
  });
});

describe("paneLineRevealProps (#2747)", () => {
  it("keeps the request for the addressed pane and withholds it everywhere else", () => {
    // An empty object means "leave what the shared props already carried"; the explicit undefineds
    // are what strip the triple back off a pane that must not act on it.
    expect(paneLineRevealProps(ADDRESSED, ADDRESSED)).toEqual({});
    expect(paneLineRevealProps(ADDRESSED, SIBLING)).toEqual({
      revealLineStart: undefined,
      revealLineEnd: undefined,
      revealRequestId: undefined,
    });
    // No addressee at all cannot mean "everyone" — a pane with no file is not an addressee either.
    expect(paneLineRevealProps(undefined, ADDRESSED)).toEqual({
      revealLineStart: undefined,
      revealLineEnd: undefined,
      revealRequestId: undefined,
    });
    expect(paneLineRevealProps(undefined, "")).toEqual({
      revealLineStart: undefined,
      revealLineEnd: undefined,
      revealRequestId: undefined,
    });
  });
});
