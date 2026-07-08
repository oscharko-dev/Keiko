import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// vitest hoists the vi.mock factories below above this import.
import { EditorCommandPalette } from "./EditorCommandPalette";
import { EditorWidget } from "./EditorWidget";
import type { EditorPaletteHost } from "./editorCommands";

// Stub the heavy runtime + next/dynamic so the host chrome + palette can be tested without Monaco.
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    function RuntimeStub(props: { paneId?: string; toolbarExtras?: ReactNode }): ReactNode {
      return (
        <div data-testid="pane-runtime" data-pane={props.paneId ?? "root"}>
          {props.toolbarExtras}
        </div>
      );
    }
    return RuntimeStub;
  },
}));

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(() => Promise.resolve({ projects: [] })),
    fetchFilesTree: vi.fn(() =>
      Promise.resolve({ root: "/repo", path: "", truncated: false, entries: [] }),
    ),
    fetchGitStatus: vi.fn(() => Promise.reject(new Error("no git"))),
    fetchFilesSearch: vi.fn(),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderEditor(onWorkspaceChange = vi.fn()): {
  onWorkspaceChange: ReturnType<typeof vi.fn>;
} {
  render(
    <EditorWidget
      root="/repo"
      file="src/a.ts"
      openFiles={["src/a.ts", "src/b.ts"]}
      onWorkspaceChange={onWorkspaceChange}
    />,
  );
  return { onWorkspaceChange };
}

function pressChord(init: KeyboardEventInit): void {
  // Dispatch on a node inside `.editor-workspace` so the container's capturing keydown listener fires.
  fireEvent.keyDown(screen.getAllByTestId("pane-runtime")[0]!, init);
}

function fakeHost(): EditorPaletteHost {
  return {
    root: "/repo",
    activePaneId: "pane-1",
    paneCount: 1,
    activeFile: "src/a.ts",
    closedTabCount: 0,
    dirtyCount: 0,
    openQuickOpen: vi.fn(),
    openCommandPalette: vi.fn(),
    splitActive: vi.fn(),
    closeActiveSplit: vi.fn(),
    closeActiveTab: vi.fn(),
    nextTab: vi.fn(),
    prevTab: vi.fn(),
    reopenClosed: vi.fn(),
    saveAll: vi.fn(),
  };
}

describe("Editor command palette + keybindings", () => {
  it("does not claim Ctrl/Cmd+P inside the editor after global quick access owns it", () => {
    renderEditor();
    pressChord({ key: "p", ctrlKey: true });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not claim Ctrl/Cmd+Shift+P inside the editor after global quick access owns it", () => {
    renderEditor();
    pressChord({ key: "p", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("keeps non-palette editor chords on the editor-local listener", async () => {
    const { onWorkspaceChange } = renderEditor();
    onWorkspaceChange.mockClear();
    pressChord({ key: "t", ctrlKey: true, altKey: true });
    expect(onWorkspaceChange).not.toHaveBeenCalled();
  });

  it("traps Tab and Shift+Tab inside the dialog (GEN-UI-FOCUS-005)", async () => {
    render(
      <EditorCommandPalette
        mode="commands"
        root="/repo"
        host={fakeHost()}
        onOpenFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = await screen.findByRole("combobox");
    const dialog = screen.getByRole("dialog");
    // The mount effect moves focus into the combobox input.
    await waitFor(() => expect(document.activeElement).toBe(input));

    // Forward Tab: focus must stay inside the dialog subtree (never escape to the editor behind it).
    fireEvent.keyDown(input, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Backward Tab (Shift+Tab): still contained.
    fireEvent.keyDown(document.activeElement ?? input, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // The dialog is still open (Tab did not dismiss it).
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("restores focus to the opener when the palette closes (GEN-UI-FOCUS-006)", async () => {
    function Harness(): ReactNode {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open ? (
            <EditorCommandPalette
              mode="commands"
              root="/repo"
              host={fakeHost()}
              onOpenFile={vi.fn()}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("combobox");

    // Close via Escape — focus must return to the opener, not be lost to <body>.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("cycles tabs with Ctrl/Cmd+Alt+Arrow", async () => {
    const { onWorkspaceChange } = renderEditor();
    onWorkspaceChange.mockClear();
    pressChord({ key: "ArrowRight", ctrlKey: true, altKey: true });
    await waitFor(() =>
      expect(
        onWorkspaceChange.mock.calls.some(
          (call) => (call[0] as { file?: string }).file === "src/b.ts",
        ),
      ).toBe(true),
    );
  });
});
