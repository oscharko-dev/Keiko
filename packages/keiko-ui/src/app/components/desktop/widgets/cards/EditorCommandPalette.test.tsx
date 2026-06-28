import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// vitest hoists the vi.mock factories below above this import.
import { EditorWidget } from "./EditorWidget";
import { fetchFilesSearch } from "../../../../../lib/api";

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

describe("Editor command palette + keybindings", () => {
  it("opens Quick-Open on Ctrl/Cmd+P and opens the picked file", async () => {
    vi.mocked(fetchFilesSearch).mockResolvedValue({
      root: "/repo",
      query: "wid",
      truncated: false,
      scannedFileCount: 1,
      results: [
        {
          root: "/repo",
          path: "src/widget.ts",
          name: "widget.ts",
          directory: "src",
          extension: "ts",
          sizeBytes: 10,
          modifiedAt: 1,
        },
      ],
    });
    const { onWorkspaceChange } = renderEditor();

    pressChord({ key: "p", ctrlKey: true });
    const input = await screen.findByRole("combobox");
    onWorkspaceChange.mockClear();
    await userEvent.type(input, "wid");
    const option = await screen.findByRole("option", { name: /widget\.ts/ });
    await userEvent.click(option);

    await waitFor(() =>
      expect(
        onWorkspaceChange.mock.calls.some(
          (call) =>
            (call[0] as { openFiles?: readonly string[] }).openFiles?.includes("src/widget.ts") ===
            true,
        ),
      ).toBe(true),
    );
    // The palette closed after opening.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("opens the command palette on Ctrl/Cmd+Shift+P and runs a command (split)", async () => {
    renderEditor();
    expect(screen.getAllByTestId("pane-runtime")).toHaveLength(1);

    pressChord({ key: "p", ctrlKey: true, shiftKey: true });
    // Command mode is prefilled with ">".
    const input = (await screen.findByRole("combobox")) as HTMLInputElement;
    expect(input.value).toContain(">");
    await userEvent.click(await screen.findByRole("option", { name: /Split Editor Right/ }));

    await waitFor(() => expect(screen.getAllByTestId("pane-runtime")).toHaveLength(2));
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("reopens the last closed tab via Ctrl/Cmd+Alt+T", async () => {
    const { onWorkspaceChange } = renderEditor();

    // Close the active tab (src/a.ts) through the command palette.
    pressChord({ key: "p", ctrlKey: true, shiftKey: true });
    await userEvent.click(await screen.findByRole("option", { name: /^Close Tab$/ }));
    await waitFor(() =>
      expect(
        onWorkspaceChange.mock.calls.some((call) => {
          const open = (call[0] as { openFiles?: readonly string[] }).openFiles ?? [];
          return !open.includes("src/a.ts") && open.includes("src/b.ts");
        }),
      ).toBe(true),
    );
    onWorkspaceChange.mockClear();

    // Reopen it.
    pressChord({ key: "t", ctrlKey: true, altKey: true });
    await waitFor(() =>
      expect(
        onWorkspaceChange.mock.calls.some(
          (call) =>
            (call[0] as { openFiles?: readonly string[] }).openFiles?.includes("src/a.ts") === true,
        ),
      ).toBe(true),
    );
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
