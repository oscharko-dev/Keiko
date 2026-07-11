import { describe, expect, it, vi } from "vitest";
import {
  buildUnifiedQuickAccessCommands,
  commandIdsForEvidence,
  paletteWindowOrder,
  type Command,
} from "./quickAccessRegistry";
import type { EditorPaletteHost } from "./widgets/cards/editorCommands";
import { EDITOR_PALETTE_COMMANDS } from "./widgets/cards/editorCommands";
import { EDITOR_VERIFICATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";

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
    verificationRunning: false,
    verifiableTarget: "src/app.test.ts",
    verificationCatalog: {
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      projectId: "/repo",
      kinds: [{ kind: "targeted-test", available: true, trustState: "trusted" }],
    },
    splitActive: vi.fn(),
    closeActiveSplit: vi.fn(),
    closeActiveTab: vi.fn(),
    nextTab: vi.fn(),
    prevTab: vi.fn(),
    reopenClosed: vi.fn(),
    saveAll: vi.fn(),
    runFileTests: vi.fn(),
    runWorkspaceVerification: vi.fn(),
    cancelVerification: vi.fn(),
    trustWorkspaceScripts: vi.fn(),
    revokeWorkspaceScriptTrust: vi.fn(),
    openProblems: vi.fn(),
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

  it("localizes every verification editor command through the central catalog", () => {
    const titleKeys = Object.fromEntries(
      EDITOR_PALETTE_COMMANDS.filter(
        (command) =>
          command.id === "editor.openProblems" ||
          command.id.startsWith("run.") ||
          command.id.startsWith("verification."),
      ).map((command) => [command.id, command.titleKey]),
    );

    expect(titleKeys).toEqual({
      "editor.openProblems": "editor.command.openProblems",
      "run.build": "editor.command.runBuild",
      "run.cancel": "editor.command.cancelVerification",
      "run.fileTests": "editor.command.runFileTests",
      "run.lint": "editor.command.runLint",
      "run.typecheck": "editor.command.runTypecheck",
      "verification.revokeWorkspaceScriptTrust": "editor.command.revokeWorkspaceScriptTrust",
      "verification.trustWorkspaceScripts": "editor.command.trustWorkspaceScripts",
    });
    expect(
      buildUnifiedQuickAccessCommands([], host(), (key) => `translated:${key}`).find(
        (command) => command.id === "run.fileTests",
      )?.label,
    ).toBe("translated:editor.command.runFileTests");
  });

  it("collapses an app command that collides with an editor command id, keeping the app definition", () => {
    const commands = buildUnifiedQuickAccessCommands([appCommand("tab.close")], host());
    const matches = commands.filter((command) => command.id === "tab.close");
    const [surviving] = matches;

    expect(matches).toHaveLength(1);
    expect(surviving).toEqual(expect.objectContaining({ group: "App", label: "App tab.close" }));
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
