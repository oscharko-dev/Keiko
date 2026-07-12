import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  resolveEditorM7Settings,
  type EditorM7SettingsSnapshot,
  type EditorM7SettingId,
  type EditorM7SettingValue,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import { EditorSettingsPanel } from "./EditorSettingsPanel";
import type { EditorSettingsView } from "../cards/useEditorSettings";

const editorSettingsView = vi.hoisted(() => ({
  current: undefined as unknown as EditorSettingsView,
}));

vi.mock("../cards/useEditorSettings", () => ({
  useEditorSettings: (): EditorSettingsView => editorSettingsView.current,
  settingById: (snapshotArg: EditorM7SettingsSnapshot | undefined, id: string) =>
    snapshotArg?.settings.find((setting) => setting.id === id),
}));

function snapshot(
  values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> = {
    fontSize: 16,
    formatOnSave: true,
  },
): EditorM7SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 0,
    revision: 1_000_000,
    etag: '"edm7-1-0-test"',
    root: "/repo",
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM7Settings({
      user: { scope: "user", values },
      ceiling: { locked: { inlineCompletion: "OPERATOR_CEILING_DENIED" } },
    }),
    eventSequence: 1,
  };
}

function view(overrides: Partial<EditorSettingsView> = {}): EditorSettingsView {
  const setValue = vi.fn<EditorSettingsView["setValue"]>();
  const reset = vi.fn<EditorSettingsView["reset"]>();
  return {
    snapshot: snapshot(),
    applied: {
      fontSize: 16,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "off",
      renderWhitespace: "selection",
      minimap: false,
      formatOnSave: true,
      largeFileMode: "default",
      keybindingOverrides: [],
    },
    loading: false,
    mutating: false,
    issue: undefined,
    announcement: "",
    refresh: vi.fn(),
    setValue,
    reset,
    ...overrides,
  };
}

function renderPanel(): void {
  render(
    <I18nProvider>
      <EditorSettingsPanel root="/repo" />
    </I18nProvider>,
  );
}

describe("EditorSettingsPanel", () => {
  beforeEach(() => {
    editorSettingsView.current = view();
  });

  it("renders effective values with source badges from the server snapshot", () => {
    renderPanel();

    expect(screen.getByRole("spinbutton", { name: "Font size" })).toHaveValue(16);
    expect(screen.getAllByText("Source: user").length).toBeGreaterThan(0);
    expect(screen.getByRole("checkbox", { name: "Format on save" })).toBeChecked();
  });

  it("submits settings and resets only through the selected server scope", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), {
      target: { value: "17" },
    });
    const resetButton = screen.getAllByRole("button", { name: "Reset at selected scope" })[0];
    if (resetButton === undefined) throw new Error("missing reset button");
    fireEvent.click(resetButton);

    expect(editorSettingsView.current.setValue).toHaveBeenCalledWith("user", "fontSize", 17);
    expect(editorSettingsView.current.reset).toHaveBeenCalledWith("user", ["fontSize"]);
  });

  it("keeps policy-locked and follow-up-owned controls unavailable", () => {
    renderPanel();

    expect(screen.getByRole("checkbox", { name: "Inline AI completion" })).toBeDisabled();
    expect(screen.getAllByText(/Locked by policy/u).length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "External reload" })).toBeDisabled();
    expect(screen.getByText(/watcher milestone/u)).toBeInTheDocument();
  });

  it("filters to modified settings without inventing local applied state", () => {
    renderPanel();

    const [modifiedOnly] = screen.getAllByRole("checkbox", { name: "Modified only" });
    if (modifiedOnly === undefined) throw new Error("missing modified-only checkbox");
    fireEvent.click(modifiedOnly);

    expect(screen.getByText("Font size")).toBeInTheDocument();
    expect(screen.queryByText("Tab size")).toBeNull();
  });

  it("records, removes, and resets keyboard shortcut overrides through the same settings mutation", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Press shortcut" }), {
      key: "O",
      code: "KeyO",
      metaKey: true,
      shiftKey: true,
    });

    expect(editorSettingsView.current.setValue).toHaveBeenCalledWith(
      "user",
      "keybindingOverrides",
      ["1|quick-access.files|CtrlOrMeta+Shift+O"],
    );
  });

  it("removes and resets existing keyboard shortcut overrides", () => {
    const base = view();
    const keybindingOverrides = ["1|quick-access.files|CtrlOrMeta+Shift+O"];
    editorSettingsView.current = {
      ...base,
      snapshot: snapshot({ fontSize: 16, formatOnSave: true, keybindingOverrides }),
      applied: { ...base.applied, keybindingOverrides },
    };
    renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset keyboard shortcuts" }));

    expect(editorSettingsView.current.setValue).toHaveBeenCalledWith(
      "user",
      "keybindingOverrides",
      [],
    );
    expect(editorSettingsView.current.reset).toHaveBeenCalledWith("user", ["keybindingOverrides"]);
  });

  it("rejects protected and colliding keyboard shortcut overrides without mutating settings", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Save document" },
    });
    expect(screen.getByRole("button", { name: "Protected" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Press shortcut" }), {
      key: "P",
      code: "KeyP",
      metaKey: true,
      shiftKey: true,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("KEYBINDING_COLLISION");
    expect(editorSettingsView.current.setValue).not.toHaveBeenCalledWith(
      "user",
      "keybindingOverrides",
      expect.anything(),
    );
  });
});
