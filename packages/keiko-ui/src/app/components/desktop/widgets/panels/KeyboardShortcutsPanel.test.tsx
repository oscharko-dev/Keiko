import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
  isWorkspaceProfileRef,
  resolveEditorM11Settings,
  type EditorM11ProfileSettingsLayer,
  type EditorM11SettingsSnapshot,
  type EditorM7ReasonCode,
  type EditorM7SettingId,
  type EditorM7SettingValue,
  type WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { EditorSettingsEditScope, EditorSettingsView } from "../cards/useEditorSettings";

const projectedRefusals = vi.hoisted(() => ({
  current: [] as { commandId: string; reasonCode: EditorM7ReasonCode }[],
}));

vi.mock("../../shellShortcutState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shellShortcutState")>();
  return {
    ...actual,
    projectShellShortcutRefusals: () => projectedRefusals.current,
  };
});

import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel";

type SettingValues = Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;

const USER_OVERRIDE = "1|quick-access.files|CtrlOrMeta+Shift+O";
const PROFILE_OVERRIDE = "1|redo|CtrlOrMeta+Alt+J";

function profileRef(value: string): WorkspaceProfileRef {
  if (!isWorkspaceProfileRef(value)) throw new Error(`invalid profile fixture: ${value}`);
  return value;
}

function profileLayer(values: SettingValues): EditorM11ProfileSettingsLayer {
  return {
    kind: "editor-profile-settings",
    schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
    profileRef: profileRef("profile-focus"),
    revision: 1,
    values,
  };
}

function snapshot(
  values: SettingValues = {},
  profileValues?: SettingValues,
): EditorM11SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 0,
    revision: 1_000_000,
    etag: '"edm7-keyboard-test"',
    root: "/repo",
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM11Settings({
      user: { scope: "user", values },
      ...(profileValues === undefined ? {} : { profile: profileLayer(profileValues) }),
    }),
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
    createProfile: vi.fn(),
    renameProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    switchProfile: vi.fn(),
    resetProfile: vi.fn(),
    ...overrides,
  };
}

function renderPanel(
  currentView: EditorSettingsView,
  root = "/repo",
  scope: EditorSettingsEditScope = "user",
): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <KeyboardShortcutsPanel root={root} scope={scope} view={currentView} />
    </I18nProvider>,
  );
}

function search(term: string): void {
  fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
    target: { value: term },
  });
}

describe("KeyboardShortcutsPanel", () => {
  beforeEach(() => {
    projectedRefusals.current = [];
    window.localStorage.removeItem("keiko.locale");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem("keiko.locale");
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

  // KEIKO-0345: Escape while recording must cancel, not be captured as an 'Esc' override.
  it("cancels recording when Escape is pressed and does not persist an 'Esc' override", async () => {
    const currentView = view();
    renderPanel(currentView);

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Press shortcut" }), {
      key: "Escape",
      code: "Escape",
    });

    expect(currentView.setValue).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
    });
  });

  // KEIKO-0472: The capture button must receive focus explicitly, not via ambient click-to-focus
  // (Safari does not focus a <button> on click). Blur first, then use fireEvent.click which does
  // not perform the browser's own focus-follows-click side effect, mirroring Safari's behavior.
  it("explicitly focuses the 'Press shortcut' button when entering recording mode", async () => {
    renderPanel(view());

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Quick Access: files" },
    });
    (document.activeElement as HTMLElement | null)?.blur?.();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Press shortcut" })).toHaveFocus();
    });
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

  it("explains a dispatch-refused persisted override on the affected command", async () => {
    projectedRefusals.current = [{ commandId: "undo", reasonCode: "INVALID_INPUT" }];
    const { container } = renderPanel(view());

    const row = screen.getByRole("article", { name: "Undo" });
    const refusal = within(row).getByRole("status");
    expect(refusal).toHaveTextContent(
      "This saved shortcut cannot be used. The default shortcut remains active.",
    );
    expect(refusal).not.toHaveTextContent("INVALID_INPUT");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("localizes a dispatch refusal without exposing the reason code", async () => {
    window.localStorage.setItem("keiko.locale", "de");
    projectedRefusals.current = [{ commandId: "undo", reasonCode: "INVALID_INPUT" }];
    renderPanel(view());

    const row = await screen.findByRole("article", { name: "Rückgängig" });
    const refusal = within(row).getByRole("status");
    expect(refusal).toHaveTextContent(
      "Dieses gespeicherte Tastenkürzel kann nicht verwendet werden. Das Standardkürzel bleibt aktiv.",
    );
    expect(refusal).not.toHaveTextContent("INVALID_INPUT");
  });

  it.each([
    [
      "RESERVED_KEYBINDING",
      "This saved shortcut is reserved by the browser or operating system. The default shortcut remains active.",
    ],
    [
      "KEYBINDING_COLLISION",
      "This saved shortcut conflicts with another active command. The default shortcut remains active.",
    ],
  ] as const)("translates the %s refusal into actionable copy", (reasonCode, expected) => {
    projectedRefusals.current = [{ commandId: "undo", reasonCode }];
    renderPanel(view());

    const refusal = within(screen.getByRole("article", { name: "Undo" })).getByRole("status");
    expect(refusal).toHaveTextContent(expected);
    expect(refusal).not.toHaveTextContent(reasonCode);
  });

  it("keeps non-rebindable protected commands disabled", () => {
    renderPanel(view());

    fireEvent.change(screen.getByRole("textbox", { name: "Search keyboard shortcuts" }), {
      target: { value: "Save document" },
    });

    expect(screen.getByRole("button", { name: "Protected" })).toBeDisabled();
  });

  /**
   * A profile-scope edit rewrites the profile's own layer, so it must be composed from that layer —
   * never from the resolved view. Seeding it from the resolved value copied the user/workspace/root
   * override list into the profile, which then carried other layers' settings to another machine on
   * export (#2618).
   */
  it("writes only the profile's own layer when a profile-scope shortcut is recorded", () => {
    const currentView = view({
      snapshot: snapshot({ keybindingOverrides: [USER_OVERRIDE] }, {}),
    });
    renderPanel(currentView, "/repo", "profile");

    search("Redo");
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Press shortcut" }), {
      key: "J",
      code: "KeyJ",
      metaKey: true,
      altKey: true,
    });

    expect(currentView.setValue).toHaveBeenCalledWith("profile", "keybindingOverrides", [
      PROFILE_OVERRIDE,
    ]);
  });

  it("still shows the binding that is actually in effect while editing the profile layer", () => {
    renderPanel(
      view({ snapshot: snapshot({ keybindingOverrides: [USER_OVERRIDE] }, {}) }),
      "/repo",
      "profile",
    );

    search("Quick Access: files");

    // The row reports the user layer's binding and marks it modified, even though the profile layer
    // being edited holds nothing for it: what you see stays the resolved view.
    const row = screen.getByRole("article", { name: "Quick Access: files" });
    expect(row).toHaveTextContent("Ctrl+Shift+O");
    expect(row).toHaveTextContent("modified");
  });

  it("offers Remove only where the edited scope holds an override of its own", () => {
    renderPanel(
      view({ snapshot: snapshot({ keybindingOverrides: [USER_OVERRIDE] }, {}) }),
      "/repo",
      "profile",
    );

    search("Quick Access: files");

    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("removes a profile override without touching the user layer's list", () => {
    const currentView = view({
      snapshot: snapshot(
        { keybindingOverrides: [USER_OVERRIDE] },
        { keybindingOverrides: [PROFILE_OVERRIDE] },
      ),
    });
    renderPanel(currentView, "/repo", "profile");

    search("Redo");
    const remove = screen.getByRole("button", { name: "Remove" });

    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(currentView.setValue).toHaveBeenCalledWith("profile", "keybindingOverrides", []);
  });
});
