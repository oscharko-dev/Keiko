import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  resolveEditorM7Settings,
  type EditorM7SettingId,
  type EditorM7SettingValue,
  type EditorM7SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { EditorSettingsView } from "../cards/useEditorSettings";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel";

function snapshot(
  values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> = {},
): EditorM7SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 0,
    revision: 1_000_000,
    etag: '"edm7-keyboard-test"',
    root: "/repo",
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM7Settings({ user: { scope: "user", values } }),
    eventSequence: 1,
  };
}

function view(overrides: Partial<EditorSettingsView> = {}): EditorSettingsView {
  const keybindingOverrides =
    (overrides.snapshot ?? snapshot()).settings.find((entry) => entry.id === "keybindingOverrides")
      ?.value ?? [];
  return {
    snapshot: snapshot(),
    applied: {
      fontSize: 13,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "off",
      renderWhitespace: "selection",
      minimap: false,
      formatOnSave: false,
      externalReload: "prompt",
      largeFileMode: "default",
      keybindingOverrides: Array.isArray(keybindingOverrides) ? keybindingOverrides : [],
      modelRetentionCount: 32,
      modelRetentionBytes: 64 * 1024 * 1024,
    },
    loading: false,
    mutating: false,
    issue: undefined,
    announcement: "",
    refresh: vi.fn(),
    setValue: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

function renderPanel(currentView: EditorSettingsView, root = "/repo"): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <KeyboardShortcutsPanel root={root} scope="user" view={currentView} />
    </I18nProvider>,
  );
}

describe("KeyboardShortcutsPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has no axe violations in its normal rendered state", async () => {
    const { container } = renderPanel(view());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("records a shortcut via keyboard capture and persists it through the settings mutation", () => {
    const currentView = view();
    renderPanel(currentView);

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));

    expect(screen.getByText("Recording keyboard shortcut.")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Press shortcut" }), {
      key: "O",
      code: "KeyO",
      metaKey: true,
      shiftKey: true,
    });

    expect(currentView.setValue).toHaveBeenCalledWith("user", "keybindingOverrides", [
      "1|quick-access.files|CtrlOrMeta+Shift+O",
    ]);
  });

  it("has no axe violations while recording a shortcut", async () => {
    const { container } = renderPanel(view());

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));

    expect(await axe(container)).toHaveNoViolations();
  });

  it("restores focus to the record button after cancelling", async () => {
    renderPanel(view());

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });
    const recordButton = screen.getByRole("button", { name: "Record" });
    fireEvent.click(recordButton);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Record" })).toHaveFocus();
    });
  });

  it("disables Remove for an unmodified shortcut and enables it once overridden", () => {
    const overriddenView = view({
      snapshot: snapshot({ keybindingOverrides: ["1|quick-access.files|CtrlOrMeta+Shift+O"] }),
    });
    renderPanel(overriddenView);

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });

    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(overriddenView.setValue).toHaveBeenCalledWith("user", "keybindingOverrides", []);
  });

  it("shows a conflict alert and refuses to mutate settings for a colliding binding", () => {
    const currentView = view();
    renderPanel(currentView);

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
    expect(currentView.setValue).not.toHaveBeenCalled();
  });

  it("keeps non-rebindable protected commands disabled", () => {
    renderPanel(view());

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Save document" },
    });

    expect(screen.getByRole("button", { name: "Protected" })).toBeDisabled();
  });
});
