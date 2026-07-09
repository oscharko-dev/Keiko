import { describe, expect, it, vi } from "vitest";
import type { Command } from "./modals/CommandPalette";
import {
  buildUnifiedQuickAccessCommands,
  commandIdsForEvidence,
  paletteWindowOrder,
} from "./quickAccessRegistry";
import type { EditorPaletteHost } from "./widgets/cards/editorCommands";
import { EDITOR_PALETTE_COMMANDS } from "./widgets/cards/editorCommands";

function appCommand(id: string): Command {
  return {
    id,
    label: `App ${id}`,
    group: "App",
    icon: "spark",
    run: vi.fn(),
  };
}

function host(): EditorPaletteHost {
  return {
    root: "/repo",
    activePaneId: "pane-1",
    paneCount: 2,
    activeFile: "src/app.ts",
    closedTabCount: 1,
    dirtyCount: 1,
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

describe("quick access registry", () => {
  it("combines app and editor command inventories without dropping ids", () => {
    const appCommands = [appCommand("new-chat"), appCommand("theme")];
    const commands = buildUnifiedQuickAccessCommands(appCommands, host());
    const ids = commands.map((command) => command.id);

    expect(ids).toContain("new-chat");
    expect(ids).toContain("theme");
    expect(ids).toContain("view.splitRight");
    expect(ids).toContain("files.saveAll");
    expect(commandIdsForEvidence(appCommands, EDITOR_PALETTE_COMMANDS)).toContain("tab.close");
  });

  it("keeps the launcher grid sourced from the shared quick-access window order", () => {
    expect(paletteWindowOrder()).toEqual([
      "chat",
      "connector",
      "files",
      "editor",
      "agents",
      "docbrowser",
    ]);
  });
});
