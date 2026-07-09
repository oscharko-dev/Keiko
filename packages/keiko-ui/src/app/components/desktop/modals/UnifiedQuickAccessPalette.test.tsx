import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorkspaceSearch, fetchWorkspaceSymbols } from "@/lib/api";
import { UnifiedQuickAccessPalette } from "./UnifiedQuickAccessPalette";
import type { QuickAccessCommand } from "../quickAccessRegistry";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchWorkspaceSearch: vi.fn(),
    fetchWorkspaceSymbols: vi.fn(),
  };
});

function command(id: string, label: string): QuickAccessCommand {
  return { id, label, group: "Test", run: vi.fn() };
}

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

  it("shows workspace text and symbol results and opens the selected declaration line", async () => {
    vi.mocked(fetchWorkspaceSearch).mockResolvedValue({
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
    vi.mocked(fetchWorkspaceSymbols).mockResolvedValue({
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
});
