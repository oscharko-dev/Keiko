import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_PALETTE_COMMANDS,
  availablePaletteCommands,
  fuzzyScore,
  type EditorPaletteCommand,
  type EditorPaletteHost,
} from "./editorCommands";

function fakeHost(overrides: Partial<EditorPaletteHost> = {}): EditorPaletteHost {
  return {
    root: "/repo",
    activePaneId: "pane-1",
    paneCount: 1,
    activeFile: "src/a.ts",
    closedTabCount: 0,
    dirtyCount: 0,
    splitActive: vi.fn(),
    closeActiveSplit: vi.fn(),
    closeActiveTab: vi.fn(),
    nextTab: vi.fn(),
    prevTab: vi.fn(),
    reopenClosed: vi.fn(),
    saveAll: vi.fn(),
    ...overrides,
  };
}

function commandById(id: string): EditorPaletteCommand {
  const command = EDITOR_PALETTE_COMMANDS.find((candidate) => candidate.id === id);
  if (command === undefined) {
    throw new Error(`Missing editor command ${id}`);
  }
  return command;
}

function score(query: string, target: string): number {
  const result = fuzzyScore(query, target);
  if (result === null) {
    throw new Error(`Expected ${query} to match ${target}`);
  }
  return result;
}

describe("editor command registry", () => {
  it("exposes only commands whose host preconditions are satisfied", () => {
    const emptyHost = fakeHost({ activeFile: null });
    expect(availablePaletteCommands(emptyHost).map((command) => command.id)).toEqual([]);

    const fullHost = fakeHost({ paneCount: 2, closedTabCount: 1, dirtyCount: 1 });
    expect(availablePaletteCommands(fullHost).map((command) => command.id)).toEqual([
      "view.splitRight",
      "view.splitDown",
      "view.closeSplit",
      "tab.next",
      "tab.prev",
      "tab.close",
      "tab.reopenClosed",
      "files.saveAll",
    ]);
  });

  it("dispatches commands to the matching editor host actions", () => {
    const host = fakeHost();

    commandById("view.splitRight").run(host);
    commandById("view.splitDown").run(host);
    commandById("view.closeSplit").run(host);
    commandById("tab.next").run(host);
    commandById("tab.prev").run(host);
    commandById("tab.close").run(host);
    commandById("tab.reopenClosed").run(host);
    commandById("files.saveAll").run(host);

    expect(host.splitActive).toHaveBeenNthCalledWith(1, "row");
    expect(host.splitActive).toHaveBeenNthCalledWith(2, "column");
    expect(host.closeActiveSplit).toHaveBeenCalledTimes(1);
    expect(host.nextTab).toHaveBeenCalledTimes(1);
    expect(host.prevTab).toHaveBeenCalledTimes(1);
    expect(host.closeActiveTab).toHaveBeenCalledTimes(1);
    expect(host.reopenClosed).toHaveBeenCalledTimes(1);
    expect(host.saveAll).toHaveBeenCalledTimes(1);
  });
});

describe("fuzzyScore", () => {
  it("scores empty, boundary, contiguous, and missing matches deterministically", () => {
    expect(fuzzyScore("", "abc")).toBe(3);
    expect(fuzzyScore("zz", "src/SearchPanel.tsx")).toBeNull();
    expect(score("sp", "src/SearchPanel.tsx")).toBeLessThan(score("sp", "workspace/parser.ts"));
    expect(score("FS", "file-search")).toBeLessThan(score("FS", "filesearch"));
  });
});
