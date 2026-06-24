// Epic #518 / Issue #526–#527 — AppShell command list integration test.
//
// Pins the AppShell-level command palette contract:
//   - Card / Tool / Layout / View commands present per the existing
//     workspace product.
//   - Undo and Redo commands wired from the substrate (#527 / ADR-0028).
//   - Undo/Redo labels reflect the typed undoLabel/redoLabel from the
//     undo stack and fall back to the boundary tooltip when the stack
//     is empty.
//   - Running the Undo command delegates to the undo stack's undo();
//     the Redo command delegates to redo().

import { describe, expect, it, vi } from "vitest";
import type { WorkspaceUndoStackApi } from "@oscharko-dev/keiko-contracts";
import {
  buildAppShellCommands,
  headerStatus,
  normalizeEditorWindowCfg,
  opensDirectlyFromPalette,
} from "./AppShell";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";

function fakeApi(): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unable to open editor." })),
    toggleTool: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    restore: vi.fn(),
    maximize: vi.fn(),
    update: vi.fn(),
    setSnap: vi.fn(),
    commitSnap: vi.fn(),
    tileAll: vi.fn(),
    splitFront: vi.fn(),
    cascade: vi.fn(),
    startConnect: vi.fn(),
    confirmConnect: vi.fn(),
    cancelConnect: vi.fn(),
    removeConn: vi.fn(),
    updateConnBoundScope: vi.fn(),
    connect: vi.fn(),
    linkedFilesRoot: vi.fn(() => null),
    linkedAllFilesRoots: vi.fn(() => []),
    linkedConnectorCapsuleIds: vi.fn(() => []),
    linkedConnectorCapsuleSetIds: vi.fn(() => []),
    linkedFigmaSnapshotRunIds: vi.fn(() => []),
    linkedFilesContext: vi.fn(() => null),
    currentFilesContext: vi.fn(() => null),
    zoomTo: vi.fn(),
    fitView: vi.fn(),
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
  };
}

function fakeUndoStack(overrides: Partial<WorkspaceUndoStackApi> = {}): WorkspaceUndoStackApi {
  return {
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    push: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

describe("buildAppShellCommands — command palette contract (epic #518 #526 #527)", () => {
  it("opens Knowledge Connector directly while keeping configured windows behind the dialog", () => {
    expect(opensDirectlyFromPalette("connector")).toBe(true);
    expect(opensDirectlyFromPalette("files")).toBe(false);
    expect(opensDirectlyFromPalette("editor")).toBe(false);
    expect(opensDirectlyFromPalette("agents")).toBe(false);
    expect(opensDirectlyFromPalette("chat")).toBe(false);
  });

  it("includes a New <card-type> command for every CARD_TYPES entry", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const newCommands = commands.filter((c) => c.id.startsWith("new-"));
    expect(newCommands.map((c) => c.id)).toEqual([
      "new-chat",
      "new-connector",
      "new-files",
      "new-editor",
      "new-agents",
    ]);
    expect(newCommands.find((c) => c.id === "new-editor")).toBeDefined();
    expect(newCommands.find((c) => c.id === "new-figma")).toBeUndefined();
  });

  it("includes Tile / Split / Cascade / Theme commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const ids = new Set(commands.map((c) => c.id));
    expect(ids.has("tile")).toBe(true);
    expect(ids.has("split")).toBe(true);
    expect(ids.has("cascade")).toBe(true);
    expect(ids.has("theme")).toBe(true);
  });

  it("surfaces Undo and Redo commands from the substrate", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "undo")).toBeDefined();
    expect(commands.find((c) => c.id === "redo")).toBeDefined();
  });

  it("falls back to the boundary tooltip when the undo stack is empty", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const undo = commands.find((c) => c.id === "undo");
    expect(undo?.label).toBe("Undo (window and panel changes only)");
    const redo = commands.find((c) => c.id === "redo");
    expect(redo?.label).toBe("Redo (window and panel changes only)");
  });

  it("renders the typed action label when the undo stack has an entry", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack({ canUndo: true, undoLabel: "Toggle project panel" }),
    );
    const undo = commands.find((c) => c.id === "undo");
    expect(undo?.label).toBe("Undo: Toggle project panel");
  });

  it("renders the typed action label when the redo stack has an entry", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack({ canRedo: true, redoLabel: "Restore quality panel" }),
    );
    const redo = commands.find((c) => c.id === "redo");
    expect(redo?.label).toBe("Redo: Restore quality panel");
  });

  it("running the Undo command delegates to the undo stack", () => {
    const stack = fakeUndoStack();
    const commands = buildAppShellCommands(fakeApi(), vi.fn(), vi.fn(), "dark", vi.fn(), stack);
    const undo = commands.find((c) => c.id === "undo");
    undo?.run();
    expect(stack.undo).toHaveBeenCalledTimes(1);
  });

  it("running the Redo command delegates to the undo stack", () => {
    const stack = fakeUndoStack();
    const commands = buildAppShellCommands(fakeApi(), vi.fn(), vi.fn(), "dark", vi.fn(), stack);
    const redo = commands.find((c) => c.id === "redo");
    redo?.run();
    expect(stack.redo).toHaveBeenCalledTimes(1);
  });

  it("running layout commands delegates to the workspace API", () => {
    const api = fakeApi();
    const commands = buildAppShellCommands(api, vi.fn(), vi.fn(), "dark", vi.fn(), fakeUndoStack());

    commands.find((c) => c.id === "tile")?.run();
    commands.find((c) => c.id === "split")?.run();
    commands.find((c) => c.id === "cascade")?.run();

    expect(api.tileAll).toHaveBeenCalledTimes(1);
    expect(api.splitFront).toHaveBeenCalledTimes(1);
    expect(api.cascade).toHaveBeenCalledTimes(1);
  });

  it("running the theme command delegates to the theme toggle", () => {
    const toggleTheme = vi.fn();
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      toggleTheme,
      fakeUndoStack(),
    );

    commands.find((c) => c.id === "theme")?.run();

    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("uses the moon icon for the light theme toggle path", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "light",
      vi.fn(),
      fakeUndoStack(),
    );

    expect(commands.find((c) => c.id === "theme")?.icon).toBe("moon");
  });

  it("uses the sun icon for the dark theme toggle path", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );

    expect(commands.find((c) => c.id === "theme")?.icon).toBe("sun");
  });

  it("running card create commands delegates to the palette picker", () => {
    const openPalettePick = vi.fn();
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      openPalettePick,
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );

    commands.find((c) => c.id === "new-chat")?.run();
    commands.find((c) => c.id === "new-files")?.run();

    expect(openPalettePick).toHaveBeenCalledWith("chat");
    expect(openPalettePick).toHaveBeenCalledWith("files");
  });

  it("Edit group commands (undo/redo) are categorised under 'Edit'", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const undo = commands.find((c) => c.id === "undo");
    const redo = commands.find((c) => c.id === "redo");
    expect(undo?.group).toBe("Edit");
    expect(redo?.group).toBe("Edit");
  });

  it("routes tool commands through the shared toggle handler so undo instrumentation stays intact", () => {
    const onTool = vi.fn();
    const commands = buildAppShellCommands(
      fakeApi(),
      onTool,
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const settings = commands.find((c) => c.id === "open-settings");
    settings?.run();
    expect(onTool).toHaveBeenCalledWith("settings");
  });

  // uiux-fix F008 C222 — settings, quality and relationships are registered tool windows
  // with LeftRail buttons but were missing from TOOL_TYPES, making them unreachable from the
  // command palette. Pin the visible singleton tools here.
  it("includes Open commands for MemoriaViva, settings, local knowledge, Figma Snapshot, quality and relationships", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    const ids = new Set(commands.map((c) => c.id));
    expect(ids.has("open-memoria")).toBe(true);
    expect(ids.has("open-settings")).toBe(true);
    expect(ids.has("open-localKnowledge")).toBe(true);
    expect(ids.has("open-figma")).toBe(true);
    expect(ids.has("open-quality")).toBe(true);
    expect(ids.has("open-relationships")).toBe(true);
  });

  it("does not expose the hidden Plugins surface through commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "open-plugins")).toBeUndefined();
  });

  it("does not expose the hidden Search surface through commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "open-search")).toBeUndefined();
  });

  it("does not expose the hidden Project surface through commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "open-project")).toBeUndefined();
  });

  it("does not expose the hidden Keiko Digital Twin surface through commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "open-keiko")).toBeUndefined();
  });

  it("exposes Agents through create commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "new-agents")).toMatchObject({
      label: "New Agents",
      group: "Create",
    });
  });

  it("does not expose the hidden Integrations surface through create commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "new-integ")).toBeUndefined();
  });

  it("does not expose the hidden Browser surface through create commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "new-browser")).toBeUndefined();
  });

  it("does not expose the hidden Terminal surface through create commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "new-terminal")).toBeUndefined();
  });

  it("does not expose the hidden Review surface through create commands", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "new-review")).toBeUndefined();
  });

  // uiux-fix F008 C141 — shortcut discoverability: the undo/redo rows surface their chords.
  it("annotates the Undo/Redo commands with their keyboard chords", () => {
    const commands = buildAppShellCommands(
      fakeApi(),
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      fakeUndoStack(),
    );
    expect(commands.find((c) => c.id === "undo")?.shortcut).toBe("⌘Z");
    expect(commands.find((c) => c.id === "redo")?.shortcut).toBe("⇧⌘Z");
  });
});

describe("normalizeEditorWindowCfg", () => {
  it("treats the selected folder itself as an editor workspace without a file target", () => {
    expect(
      normalizeEditorWindowCfg({
        root: "/Users/example/Keiko",
        file: "/Users/example/Keiko",
      }),
    ).toEqual({ root: "/Users/example/Keiko" });
  });

  it("normalizes absolute file paths inside the selected folder to workspace-relative paths", () => {
    expect(
      normalizeEditorWindowCfg({
        root: "/Users/example/Keiko",
        file: "/Users/example/Keiko/packages/keiko-editor/package.json",
      }),
    ).toEqual({
      root: "/Users/example/Keiko",
      file: "packages/keiko-editor/package.json",
      openFiles: ["packages/keiko-editor/package.json"],
    });
  });

  it("normalizes persisted editor tabs and keeps relative tab order stable", () => {
    expect(
      normalizeEditorWindowCfg({
        root: "/Users/example/Keiko",
        file: "/Users/example/Keiko/package.json",
        openFiles: [
          "/Users/example/Keiko/src/app.ts",
          "README.md",
          "/Users/example/Keiko/src/app.ts",
          "/Users/example/Other/outside.ts",
        ],
      }),
    ).toEqual({
      root: "/Users/example/Keiko",
      file: "package.json",
      openFiles: ["src/app.ts", "README.md", "package.json"],
    });
  });

  it("supports the filesystem root as an editor workspace root", () => {
    expect(
      normalizeEditorWindowCfg({
        root: "/",
        file: "/Users/example/Keiko/package.json",
      }),
    ).toEqual({
      root: "/",
      file: "Users/example/Keiko/package.json",
      openFiles: ["Users/example/Keiko/package.json"],
    });
  });
});

// uiux-fix F008 C043/C118 — the header status pill derives from real session state instead of a
// hardcoded "connected" literal that contradicted the footer during outages.
describe("headerStatus — header status pill derivation (F008 C043/C118)", () => {
  const base = {
    loading: false,
    error: undefined,
    hasProject: true,
    projectAvailable: true,
    noEligibleModels: false,
  };

  it("reports Connected/ok when the session is healthy", () => {
    expect(headerStatus(base)).toEqual({ label: "Connected", tone: "ok" });
  });

  it("reports Connecting/warn while the session loads", () => {
    expect(headerStatus({ ...base, loading: true })).toEqual({
      label: "Connecting",
      tone: "warn",
    });
  });

  it("reports Disconnected/danger on a session error", () => {
    expect(headerStatus({ ...base, error: "boom" })).toEqual({
      label: "Disconnected",
      tone: "danger",
    });
  });

  it("reports Disconnected/danger when the active project is unavailable", () => {
    expect(headerStatus({ ...base, projectAvailable: false })).toEqual({
      label: "Disconnected",
      tone: "danger",
    });
  });

  it("reports Setup required/warn when no eligible model is configured", () => {
    expect(headerStatus({ ...base, noEligibleModels: true })).toEqual({
      label: "Setup required",
      tone: "warn",
    });
  });

  it("reports Setup required/warn when no project is selected (not Disconnected)", () => {
    expect(headerStatus({ ...base, hasProject: false, projectAvailable: false })).toEqual({
      label: "Setup required",
      tone: "warn",
    });
  });
});
