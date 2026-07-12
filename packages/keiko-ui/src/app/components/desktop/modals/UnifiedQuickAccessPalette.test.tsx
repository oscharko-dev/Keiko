import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFilesSearch, fetchWorkspaceSearch, fetchWorkspaceSymbols } from "@/lib/api";
import { UnifiedQuickAccessPalette } from "./UnifiedQuickAccessPalette";
import type { QuickAccessCommand } from "../quickAccessRegistry";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchFilesSearch: vi.fn(),
    fetchWorkspaceSearch: vi.fn(),
    fetchWorkspaceSymbols: vi.fn(),
  };
});

const fetchFilesSearchMock = vi.mocked(fetchFilesSearch);
const fetchWorkspaceSearchMock = vi.mocked(fetchWorkspaceSearch);
const fetchWorkspaceSymbolsMock = vi.mocked(fetchWorkspaceSymbols);

function command(id: string, label: string): QuickAccessCommand {
  return { id, label, group: "Test", run: vi.fn() };
}

beforeEach(() => {
  fetchFilesSearchMock.mockResolvedValue({
    root: "/repo",
    query: "",
    results: [],
    truncated: false,
    scannedFileCount: 0,
  });
  fetchWorkspaceSearchMock.mockResolvedValue({
    results: [],
    truncated: false,
    filesScanned: 0,
    elapsedMs: 1,
  });
  fetchWorkspaceSymbolsMock.mockResolvedValue({
    results: [],
    truncated: false,
    filesScanned: 0,
    elapsedMs: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("UnifiedQuickAccessPalette", () => {
  it("switches to command mode with a leading greater-than and runs the selected command", async () => {
    const run = vi.fn();
    render(
      <UnifiedQuickAccessPalette
        initialMode="files"
        root="/repo"
        commands={[{ ...command("theme", "Toggle light / dark theme"), run }]}
        openEditorFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("combobox"), ">theme");
    await userEvent.click(
      await screen.findByRole("option", { name: /Toggle light \/ dark theme/ }),
    );

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("opens a filename result even when the query is not a content match", async () => {
    fetchFilesSearchMock.mockResolvedValue({
      root: "/repo",
      query: "quick.ts",
      results: [
        {
          root: "/repo",
          path: "src/quick.ts",
          name: "quick.ts",
          directory: "src",
          extension: ".ts",
          sizeBytes: 120,
          modifiedAt: 1,
          fileRole: "source",
          matchQuality: "exact",
          rootKind: "selected-root",
        },
      ],
      truncated: false,
      scannedFileCount: 1,
    });
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <UnifiedQuickAccessPalette
        initialMode="files"
        root="/repo"
        commands={[]}
        openEditorFile={openEditorFile}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("combobox"), "quick.ts");
    await userEvent.click(await screen.findByRole("option", { name: /src\/quick\.ts/ }));

    expect(fetchFilesSearchMock).toHaveBeenCalledWith(
      "/repo",
      "quick.ts",
      expect.any(Number),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/quick.ts",
      lineStart: 1,
      lineEnd: 1,
    });
  });

  it("shows workspace text and symbol results and opens the selected declaration line", async () => {
    fetchWorkspaceSearchMock.mockResolvedValue({
      results: [
        {
          path: "src/app.ts",
          lineRange: { startLine: 12, endLine: 12 },
          snippet: "export function renderApp() {}",
          score: 1,
        },
      ],
      truncated: false,
      filesScanned: 1,
      elapsedMs: 1,
    });
    fetchWorkspaceSymbolsMock.mockResolvedValue({
      results: [
        {
          symbol: "renderApp",
          kind: "function",
          path: "src/app.ts",
          line: 12,
          score: 1,
        },
      ],
      truncated: false,
      filesScanned: 1,
      elapsedMs: 1,
    });
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <UnifiedQuickAccessPalette
        initialMode="files"
        root="/repo"
        commands={[]}
        openEditorFile={openEditorFile}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("combobox"), "render");
    await userEvent.click(await screen.findByRole("option", { name: /renderApp/ }));

    await waitFor(() =>
      expect(openEditorFile).toHaveBeenCalledWith({
        root: "/repo",
        path: "src/app.ts",
        lineStart: 12,
        lineEnd: 12,
      }),
    );
  });

  it("collapses a workspace text match onto an existing filename result for the same path", async () => {
    fetchFilesSearchMock.mockResolvedValue({
      root: "/repo",
      query: "quick",
      results: [
        {
          root: "/repo",
          path: "src/quick.ts",
          name: "quick.ts",
          directory: "src",
          extension: ".ts",
          sizeBytes: 120,
          modifiedAt: 1,
        },
      ],
      truncated: false,
      scannedFileCount: 1,
    });
    fetchWorkspaceSearchMock.mockResolvedValue({
      results: [
        {
          path: "src/quick.ts",
          lineRange: { startLine: 5, endLine: 5 },
          snippet: "export const quick = 1;",
          score: 1,
        },
      ],
      truncated: false,
      filesScanned: 1,
      elapsedMs: 1,
    });
    render(
      <UnifiedQuickAccessPalette
        initialMode="files"
        root="/repo"
        commands={[]}
        openEditorFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("combobox"), "quick");
    await screen.findByRole("option", { name: /src\/quick\.ts/ });

    expect(screen.getAllByRole("option", { name: /src\/quick\.ts/ })).toHaveLength(1);
  });

  it("has no axe violations in file and command modes", async () => {
    fetchFilesSearchMock.mockResolvedValue({
      root: "/repo",
      query: "app",
      results: [
        {
          root: "/repo",
          path: "src/app.ts",
          name: "app.ts",
          directory: "src",
          extension: ".ts",
          sizeBytes: 120,
          modifiedAt: 1,
        },
      ],
      truncated: false,
      scannedFileCount: 1,
    });
    const fileMode = render(
      <UnifiedQuickAccessPalette
        initialMode="files"
        root="/repo"
        commands={[command("theme", "Toggle light / dark theme")]}
        openEditorFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("combobox"), "app");
    await screen.findByRole("option", { name: /src\/app\.ts/ });
    expect(await axe(fileMode.container)).toHaveNoViolations();
    fileMode.unmount();

    const commandMode = render(
      <UnifiedQuickAccessPalette
        initialMode="commands"
        root="/repo"
        commands={[command("theme", "Toggle light / dark theme")]}
        openEditorFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole("option", { name: /Toggle light \/ dark theme/ });
    expect(await axe(commandMode.container)).toHaveNoViolations();
  });
});
