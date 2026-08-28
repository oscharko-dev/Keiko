import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFilesSearch, fetchWorkspaceSearch, fetchWorkspaceSymbols } from "@/lib/api";
import {
  rootFairMerge,
  UnifiedQuickAccessPalette,
  type FileResult,
} from "./UnifiedQuickAccessPalette";
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
  it("restores the opener captured before the lazy palette mounts", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const capturedOpener = document.activeElement as HTMLElement;
    capturedOpener.blur();

    const { unmount } = render(
      <UnifiedQuickAccessPalette
        initialMode="files"
        root="/repo"
        commands={[]}
        openEditorFile={vi.fn()}
        opener={capturedOpener}
        onClose={vi.fn()}
      />,
    );
    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

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

    await userEvent.type(screen.getByRole("searchbox"), ">theme");
    await userEvent.click(
      await screen.findByRole("button", { name: /Toggle light \/ dark theme/ }),
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

    await userEvent.type(screen.getByRole("searchbox"), "quick.ts");
    await userEvent.click(await screen.findByRole("button", { name: /src\/quick\.ts/ }));

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

    await userEvent.type(screen.getByRole("searchbox"), "render");
    await userEvent.click(await screen.findByRole("button", { name: /renderApp/ }));

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

    await userEvent.type(screen.getByRole("searchbox"), "quick");
    await screen.findByRole("button", { name: /src\/quick\.ts/ });

    expect(screen.getAllByRole("button", { name: /src\/quick\.ts/ })).toHaveLength(1);
  });

  it("disambiguates same-path results across roots and opens the selected root", async () => {
    fetchFilesSearchMock.mockImplementation((root) =>
      Promise.resolve({
        root,
        query: "shared",
        results: [
          {
            root,
            path: "src/shared.ts",
            name: "shared.ts",
            directory: "src",
            extension: ".ts",
            sizeBytes: 120,
            modifiedAt: 1,
          },
        ],
        truncated: false,
        scannedFileCount: 1,
      }),
    );
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor-1" }));
    render(
      <UnifiedQuickAccessPalette
        initialMode="files"
        root="/repo/a"
        roots={[
          { id: "a", root: "/repo/a", label: "Root A" },
          { id: "b", root: "/repo/b", label: "Root B" },
        ]}
        commands={[]}
        openEditorFile={openEditorFile}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("searchbox"), "shared");
    const rootB = await screen.findByRole("button", { name: /Root B · src\/shared\.ts:1/ });
    expect(screen.getByRole("button", { name: /Root A · src\/shared\.ts:1/ })).toBeInTheDocument();
    await userEvent.click(rootB);

    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo/b",
      path: "src/shared.ts",
      lineStart: 1,
      lineEnd: 1,
    });
  });

  it("keeps a second root represented and reports truncation when one root fills the cap (#2768)", async () => {
    function fileFixture(
      root: string,
      index: number,
    ): {
      root: string;
      path: string;
      name: string;
      directory: string;
      extension: string;
      sizeBytes: number;
      modifiedAt: number;
    } {
      const name = `match-${index.toString()}.ts`;
      return {
        root,
        path: `src/${name}`,
        name,
        directory: "src",
        extension: ".ts",
        sizeBytes: 10,
        modifiedAt: 1,
      };
    }
    fetchFilesSearchMock.mockImplementation((root) =>
      Promise.resolve({
        root,
        query: "match",
        // Root A alone fills the SEARCH_LIMIT (30). Root B's indices are double-digit, the same
        // fuzzyScore tier as root A's own 20 double-digit files (`target.length - lastMatch`
        // penalizes the longer "match-NN.ts" tail): a global sort-then-slice ranks all of root A's
        // double-digit matches ahead of root B's on flatMap index alone and cuts root B off
        // entirely, where a fair per-root merge still gives root B its share.
        results:
          root === "/repo/a"
            ? Array.from({ length: 30 }, (_, index) => fileFixture("/repo/a", index))
            : [97, 98, 99].map((index) => fileFixture("/repo/b", index)),
        truncated: false,
        scannedFileCount: 30,
      }),
    );

    render(
      <UnifiedQuickAccessPalette
        initialMode="files"
        root="/repo/a"
        roots={[
          { id: "a", root: "/repo/a", label: "Root A" },
          { id: "b", root: "/repo/b", label: "Root B" },
        ]}
        commands={[]}
        openEditorFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("searchbox"), "match");
    await screen.findAllByRole("button", { name: /Root B/ });

    expect(screen.getAllByRole("button", { name: /Root A/ })).not.toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /Root B/ })).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent(/capped/i);
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

    await userEvent.type(screen.getByRole("searchbox"), "app");
    await screen.findByRole("button", { name: /src\/app\.ts/ });
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

    await screen.findByRole("button", { name: /Toggle light \/ dark theme/ });
    expect(await axe(commandMode.container)).toHaveNoViolations();
  });

  it("renders a command's keyboard shortcut chip when the command defines one", async () => {
    render(
      <UnifiedQuickAccessPalette
        initialMode="commands"
        root="/repo"
        commands={[{ ...command("theme", "Toggle light / dark theme"), shortcut: "⌘K" }]}
        openEditorFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const option = await screen.findByRole("button", { name: /Toggle light \/ dark theme/ });
    expect(within(option).getByText("⌘K")).toBeInTheDocument();
  });
});

describe("rootFairMerge (#2768)", () => {
  function fileResult(root: string, path: string): FileResult {
    return { kind: "file", root, rootLabel: root, path, line: 1, snippet: path };
  }

  it("round-robins one result per root instead of exhausting one root first", () => {
    const rootA = [fileResult("/a", "a0.ts"), fileResult("/a", "a1.ts")];
    const rootB = [fileResult("/b", "b0.ts"), fileResult("/b", "b1.ts")];

    expect(rootFairMerge([rootA, rootB])).toEqual([rootA[0], rootB[0], rootA[1], rootB[1]]);
  });

  it("keeps every root represented even when one root has far more matches", () => {
    const rootA = Array.from({ length: 40 }, (_, index) =>
      fileResult("/a", `a${index.toString()}.ts`),
    );
    const rootB = [fileResult("/b", "b0.ts"), fileResult("/b", "b1.ts"), fileResult("/b", "b2.ts")];

    const merged = rootFairMerge([rootA, rootB]);

    expect(merged).toHaveLength(30);
    // A global sort-then-slice over root A's 40-result lead would have starved every one of root
    // B's results; the fair merge guarantees all three still make it in.
    expect(merged.filter((result) => result.root === "/b")).toHaveLength(3);
  });

  it("returns everything, unmerged-order preserved per root, when nothing needs to be dropped", () => {
    const rootA = [fileResult("/a", "a0.ts")];
    const rootB = [fileResult("/b", "b0.ts"), fileResult("/b", "b1.ts")];

    expect(rootFairMerge([rootA, rootB])).toEqual([rootA[0], rootB[0], rootB[1]]);
  });
});
