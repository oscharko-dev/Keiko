// German locale coverage for the three shell surfaces a user actually operates windows with.
//
// Before this suite, a user who selected Deutsch got a mixed-language shell: settings, header,
// footer and chat chrome were German, while the Quick Access command palette, the window launcher
// and the New Window dialog stayed English. All three drew their copy from English literals — the
// `WIN_TYPES` title/desc/cta/config-label table, the `New ${title}` / `Open ${title}` template
// literals in the command builder, and inline JSX text — none of which any locale switch could move.
//
// Each test asserts the GERMAN rendering, so it fails the moment a surface falls back to English.
import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFilesSearch,
  fetchProjects,
  fetchWorkspaceSearch,
  fetchWorkspaceSymbols,
} from "@/lib/api";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages, translate } from "@/lib/i18n";
import { translateOptionalWidget } from "@/lib/optional-widget-i18n";
import type { I18nTranslate } from "@/lib/i18n";
import type { WorkspaceUndoStackApi } from "@oscharko-dev/keiko-contracts";
import { buildAppShellCommands } from "./AppShell";
import { buildUnifiedQuickAccessCommands } from "./quickAccessRegistry";
import { Palette } from "./modals/Palette";
import { NewWindowDialog } from "./modals/NewWindowDialog";
import { UnifiedQuickAccessPalette } from "./modals/UnifiedQuickAccessPalette";
import { Workspace } from "./Workspace";
import { WIN_TYPES } from "./windows/WindowsRegistry";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";
import type { UseWorkspaceResult } from "./hooks/useWorkspace.types";
import { cutResult } from "../../../test-utils/workspace-clipboard-fixture";

vi.mock("./WorkspaceShader", () => ({
  WorkspaceShader: (): null => null,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchFilesSearch: vi.fn(),
    fetchWorkspaceSearch: vi.fn(),
    fetchWorkspaceSymbols: vi.fn(),
  };
});

const deTranslate: I18nTranslate = (key, values) => translate("de", key, values);

function germanShell(node: React.ReactNode): void {
  window.localStorage.setItem(I18N_STORAGE_KEY, "de");
  render(<I18nProvider>{node}</I18nProvider>);
}

function undoStack(): WorkspaceUndoStackApi {
  return {
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    push: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    clear: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(fetchProjects).mockResolvedValue({ projects: [] });
  vi.mocked(fetchWorkspaceSearch).mockResolvedValue({
    results: [],
    truncated: false,
    filesScanned: 0,
    elapsedMs: 1,
  });
  vi.mocked(fetchWorkspaceSymbols).mockResolvedValue({
    results: [],
    truncated: false,
    filesScanned: 0,
    elapsedMs: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-locale");
});

describe("window launcher (Palette) under the German locale", () => {
  it("translates its own chrome and every window card it lists", async () => {
    await loadLocaleMessages("de");
    germanShell(
      <Palette
        types={WIN_TYPES}
        order={["chat", "files", "editor"]}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(deTranslate("workspace.newWindow"))).toBeInTheDocument();
    });
    expect(screen.getByText(deTranslate("palette.description"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: deTranslate("common.close") })).toBeInTheDocument();
    // The card names and descriptions come from the registry, which is where the English literals
    // used to live: "Files"/"Browse a folder" instead of "Dateien"/"Ordner durchsuchen".
    expect(screen.getByText(deTranslate("window.type.files.title"))).toBeInTheDocument();
    expect(screen.getByText(deTranslate("window.type.files.desc"))).toBeInTheDocument();
    expect(screen.getByText(deTranslate("window.type.editor.desc"))).toBeInTheDocument();
    expect(screen.queryByText("New window")).not.toBeInTheDocument();
    expect(screen.queryByText("Browse a folder")).not.toBeInTheDocument();
  });
});

describe("New Window dialog under the German locale", () => {
  it("translates the title, description, field label, placeholder and confirm action", async () => {
    await loadLocaleMessages("de");
    germanShell(
      <NewWindowDialog type="editor" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    const expectedTitle = deTranslate("newWindow.title", {
      label: deTranslate("window.type.editor.title"),
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: expectedTitle })).toBeInTheDocument();
    });
    expect(screen.getByText(deTranslate("window.type.editor.desc"))).toBeInTheDocument();
    expect(screen.getByText(deTranslate("window.field.folder"))).toBeInTheDocument();
    expect(screen.getByText(deTranslate("window.field.filePath"))).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(deTranslate("window.placeholder.relativeFilePath")),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: deTranslate("newWindow.open", {
          label: deTranslate("window.type.editor.title"),
        }),
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Folder")).not.toBeInTheDocument();
    expect(screen.queryByText("New Editor window")).not.toBeInTheDocument();
  });

  it("localizes the chat title default that is typed into the created window", async () => {
    await loadLocaleMessages("de");
    germanShell(
      <NewWindowDialog type="chat" types={WIN_TYPES} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue(deTranslate("window.default.chatTitle"))).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("New chat")).not.toBeInTheDocument();
  });
});

describe("Quick Access command palette under the German locale", () => {
  it("translates every command label and group name the palette lists", async () => {
    // `deTranslate` reads the lazily loaded German catalog and falls back to English when it is
    // absent, so without this the whole block below is tautological: both sides of every `toBe`
    // resolve to the same English string and the case passes over a completely untranslated
    // palette. It only ever held because a sibling test above happened to warm the catalog first
    // (#2871) — the precondition belongs in the test that needs it, exactly as the siblings do.
    await loadLocaleMessages("de");
    const commands = buildAppShellCommands(
      {} as WorkspaceApi,
      vi.fn(),
      vi.fn(),
      "dark",
      vi.fn(),
      undoStack(),
      deTranslate,
    );
    const paletteCommands = buildUnifiedQuickAccessCommands(commands, null, deTranslate);
    const byId = new Map(paletteCommands.map((command) => [command.id, command]));

    expect(byId.get("new-files")?.label).toBe(
      deTranslate("command.new", { label: deTranslate("window.type.files.title") }),
    );
    expect(byId.get("new-files")?.group).toBe(deTranslate("command.group.create"));
    expect(byId.get("open-settings")?.label).toBe(
      deTranslate("command.open", { label: deTranslate("window.type.settings.title") }),
    );
    expect(byId.get("open-settings")?.group).toBe(deTranslate("command.group.tools"));
    expect(byId.get("tile")?.label).toBe(deTranslate("header.tileAll"));
    expect(byId.get("tile")?.group).toBe(deTranslate("command.group.layout"));
    expect(byId.get("undo")?.group).toBe(deTranslate("command.group.edit"));
    // The empty-stack undo label is the audit's narrowed, truthful key — the shell only records
    // panel toggles, so the wider `command.undo` wording ("Fenster- und Panel-Änderungen") is no
    // longer used. The invariant under test is unchanged: the label is translated, never English.
    expect(byId.get("undo")?.label).toBe(deTranslate("shell.command.undo.panelOnly"));
    expect(byId.get("undo")?.label).not.toBe(translate("en", "shell.command.undo.panelOnly"));

    const labels = paletteCommands.map((command) => command.label);
    expect(labels).not.toContain("New Files");
    expect(labels).not.toContain("Open Settings");
    expect(labels).not.toContain("Tile all windows");
  });

  it("translates the per-root search failure notice", async () => {
    await loadLocaleMessages("de");
    vi.mocked(fetchFilesSearch).mockRejectedValue(new Error("search backend down"));
    germanShell(
      <UnifiedQuickAccessPalette
        initialMode="files"
        roots={[{ id: "repo", root: "/repo", label: "repo" }]}
        commands={[]}
        openEditorFile={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("combobox"), "abc");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        translateOptionalWidget("de", "quickAccess.searchUnavailable", { roots: "repo" }),
      );
    });
    expect(screen.queryByText(/^Search unavailable for/)).not.toBeInTheDocument();
  });
});

// Issue #2150 follow-up / #2710 — the copy/cut/paste outcome pill (Workspace.tsx
// WorkspaceClipboardStatusView) reads its text through t(), same as every other
// surface above; this pins it against the same silent-English-fallback failure
// mode the rest of this suite guards.
describe("Workspace clipboard status pill under the German locale", () => {
  function clipboardApi(patch: Partial<WorkspaceApi> = {}): WorkspaceApi {
    return {
      add: vi.fn(() => null),
      openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unable to open editor." })),
      toggleTool: vi.fn(),
      focus: vi.fn(),
      currentSelection: vi.fn(() => ({ focusedWindowId: null, selectedWindowIds: [] })),
      replaceSelection: vi.fn(),
      toggleWindowSelection: vi.fn(),
      clearSelection: vi.fn(),
      moveSelectedWindowsBy: vi.fn(() => ({ dx: 0, dy: 0 })),
      copySelectedWindows: vi.fn(() => ({ captured: 0, skipped: 0, overflow: 0 })),
      cutSelectedWindows: vi.fn(() => cutResult({ captured: 0, skipped: 0, overflow: 0 })),
      pasteCopiedWindows: vi.fn(() => ({ pasted: 0, limitReached: false })),
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
      currentView: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
      ...patch,
    };
  }

  function clipboardWorkspace(api: WorkspaceApi): UseWorkspaceResult {
    return {
      wins: [],
      winsById: new Map(),
      snapPrev: null,
      palOpen: false,
      setPalOpen: vi.fn(),
      conns: [],
      connecting: null,
      selection: { focusedWindowId: null, selectedWindowIds: [] },
      view: { x: 0, y: 0, zoom: 1 },
      api,
    };
  }

  it("announces a partial copy, a cut, and a paste in German — never the English fallback", async () => {
    await loadLocaleMessages("de");
    const copySelectedWindows = vi.fn(() => ({ captured: 2, skipped: 1, overflow: 0 }));
    const cutSelectedWindows = vi.fn(() => cutResult({ captured: 1, skipped: 0, overflow: 0 }));
    const pasteCopiedWindows = vi.fn(() => ({ pasted: 1, limitReached: false }));
    germanShell(
      <Workspace
        ws={clipboardWorkspace(
          clipboardApi({ copySelectedWindows, cutSelectedWindows, pasteCopiedWindows }),
        )}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = await screen.findByRole("main", { name: deTranslate("workspace.surface") });
    const status = (): HTMLElement => screen.getByTestId("workspace-clipboard-status");

    fireEvent.keyDown(surface, { key: "c", ctrlKey: true });
    expect(status()).toHaveTextContent(
      `${deTranslate("workspace.clipboard.copied.many", { count: 2 })} · ${deTranslate("workspace.clipboard.skipped.one")}`,
    );
    expect(status()).not.toHaveTextContent("2 windows copied");

    // Cut announces from its settled teardown outcome, so this one is awaited.
    fireEvent.keyDown(surface, { key: "x", ctrlKey: true });
    await waitFor(() =>
      expect(status()).toHaveTextContent(deTranslate("workspace.clipboard.cut.one")),
    );
    expect(status()).not.toHaveTextContent("1 window cut");

    fireEvent.keyDown(surface, { key: "v", ctrlKey: true });
    expect(status()).toHaveTextContent(deTranslate("workspace.clipboard.pasted.one"));
    expect(status()).not.toHaveTextContent("1 window pasted");
  });

  it("announces the noneEligible reason in German when nothing could be copied", async () => {
    await loadLocaleMessages("de");
    const copySelectedWindows = vi.fn(() => ({ captured: 0, skipped: 3, overflow: 0 }));
    germanShell(
      <Workspace
        ws={clipboardWorkspace(clipboardApi({ copySelectedWindows }))}
        wsRef={createRef<HTMLDivElement>()}
        openPalette={() => undefined}
      />,
    );
    const surface = await screen.findByRole("main", { name: deTranslate("workspace.surface") });

    fireEvent.keyDown(surface, { key: "c", ctrlKey: true });

    expect(screen.getByTestId("workspace-clipboard-status")).toHaveTextContent(
      deTranslate("workspace.clipboard.noneEligible"),
    );
    expect(screen.queryByText(/can't be duplicated/)).not.toBeInTheDocument();
  });
});
