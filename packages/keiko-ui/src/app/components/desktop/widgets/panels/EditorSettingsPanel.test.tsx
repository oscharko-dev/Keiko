import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EditorM7AiActivationStatus,
  EditorM7AiState,
  EditorM7SettingId,
  EditorM7SettingValue,
  EditorM11RootSettingsLayer,
  EditorM11ProfileSettingsLayer,
  EditorM11SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
} from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import {
  EDITOR_M11_DEFAULT_PROFILE_REF,
  resolveEditorM11Settings,
} from "@oscharko-dev/keiko-contracts/runtime/editor-m11-settings";
import { I18nProvider } from "@/lib/i18n";
import { EditorSettingsPanel } from "./EditorSettingsPanel";
import type { EditorSettingsIssue, EditorSettingsView } from "../cards/useEditorSettings";

const editorSettingsView = vi.hoisted(() => ({
  current: undefined as unknown as EditorSettingsView,
}));

vi.mock("../cards/useEditorSettings", () => ({
  useEditorSettings: (): EditorSettingsView => editorSettingsView.current,
  settingById: (snapshotArg: EditorM11SettingsSnapshot | undefined, id: string) =>
    snapshotArg?.settings.find((setting) => setting.id === id),
}));

function snapshot(
  values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> = {
    fontSize: 16,
    formatOnSave: true,
  },
): EditorM11SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 0,
    revision: 1_000_000,
    etag: '"edm7-1-0-test"',
    root: "/repo",
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM11Settings({
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
      externalReload: "prompt",
      largeFileMode: "default",
      keybindingOverrides: [],
      modelRetentionCount: 32,
      modelRetentionBytes: 64 * 1024 * 1024,
    },
    loading: false,
    mutating: false,
    issue: undefined,
    announcement: "",
    refresh: vi.fn(),
    setValue,
    reset,
    createProfile: vi.fn(),
    renameProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    switchProfile: vi.fn(),
    resetProfile: vi.fn(),
    ...overrides,
  };
}

function renderPanel(): ReturnType<typeof render> {
  return render(
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

  it("has no axe violations in its normal rendered state", async () => {
    const { container } = renderPanel();
    expect(await axe(container)).toHaveNoViolations();
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

  it("offers the two governed commit-message policy modes through Settings", () => {
    renderPanel();
    const policy = screen.getByRole("combobox", { name: "Commit message policy" });
    expect(policy).toHaveValue("keiko-conventional");

    fireEvent.change(policy, { target: { value: "repository-native" } });
    expect(editorSettingsView.current.setValue).toHaveBeenCalledWith(
      "user",
      "gitCommitMessagePolicy",
      "repository-native",
    );
  });

  it("selects root scope and explains a root-owned effective value", () => {
    const rootLayer: EditorM11RootSettingsLayer = {
      kind: "editor-root-settings",
      schemaVersion: 1,
      rootRef: "root-primary" as EditorM11RootSettingsLayer["rootRef"],
      rootIdentityDigest: "a".repeat(64) as EditorM11RootSettingsLayer["rootIdentityDigest"],
      revision: 1,
      values: { fontSize: 19 },
    };
    editorSettingsView.current = view({
      snapshot: {
        ...snapshot(),
        rootRevision: 1,
        settings: resolveEditorM11Settings({ root: rootLayer }),
      },
    });
    renderPanel();

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), {
      target: { value: "root" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), {
      target: { value: "20" },
    });

    expect(screen.getAllByText("Source: root").length).toBeGreaterThan(0);
    expect(editorSettingsView.current.setValue).toHaveBeenCalledWith("root", "fontSize", 20);
  });

  it("switches and edits a named active profile through the profile control plane", () => {
    const profileRef = "profile-focus" as EditorM11ProfileSettingsLayer["profileRef"];
    const profile: EditorM11ProfileSettingsLayer = {
      kind: "editor-profile-settings",
      schemaVersion: 1,
      profileRef,
      revision: 1,
      values: { fontSize: 18 },
    };
    editorSettingsView.current = view({
      snapshot: {
        ...snapshot(),
        settings: resolveEditorM11Settings({ profile }),
        profiles: {
          schemaVersion: 1,
          storeState: "ready",
          revision: 2,
          etag: '"edp-2"',
          activeProfileRef: profileRef,
          profiles: [
            {
              profileRef: EDITOR_M11_DEFAULT_PROFILE_REF,
              displayName: "Default",
              revision: 0,
              settingCount: 0,
              builtIn: true,
            },
            {
              profileRef,
              displayName: "Focus",
              revision: 1,
              settingCount: 1,
              builtIn: false,
            },
          ],
        },
      },
    });
    renderPanel();

    expect(screen.getByText("Current profile: Focus")).toBeInTheDocument();
    expect(screen.getAllByText("Source: profile").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), {
      target: { value: "profile" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), {
      target: { value: "19" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), {
      target: { value: "Focused" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to Default" }));

    expect(editorSettingsView.current.setValue).toHaveBeenCalledWith("profile", "fontSize", 19);
    expect(editorSettingsView.current.renameProfile).toHaveBeenCalledWith(profileRef, "Focused");
    expect(editorSettingsView.current.resetProfile).toHaveBeenCalledWith(profileRef);
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

  it("announces mutating progress and the applied outcome through the live output", () => {
    editorSettingsView.current = view({ mutating: true, announcement: "Applied" });
    renderPanel();

    expect(screen.getByText(/Applying editor setting/u)).toBeInTheDocument();
    expect(screen.getByText(/Editor setting applied\./u)).toBeInTheDocument();
  });

  it("renders loading copy while the initial snapshot is still resolving", () => {
    editorSettingsView.current = view({ loading: true, snapshot: undefined });
    renderPanel();

    expect(screen.getByText("Loading editor settings...")).toBeInTheDocument();
  });

  it("renders the empty state when the filter matches no editor settings", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("textbox", { name: "Search editor settings" }), {
      target: { value: "__nothing_matches_this_filter__" },
    });

    expect(screen.getByText("No editor settings match the current filter.")).toBeInTheDocument();
  });

  it("resets every currently visible setting through the toolbar action", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Reset visible settings" }));

    expect(editorSettingsView.current.reset).toHaveBeenCalledWith(
      "user",
      expect.arrayContaining(["fontSize", "tabSize", "insertSpaces"]),
    );
    expect(editorSettingsView.current.reset).not.toHaveBeenCalledWith(
      "user",
      expect.arrayContaining(["keybindingOverrides"]),
    );
  });
});

describe("EditorSettingsPanel mutation issues", () => {
  beforeEach(() => {
    editorSettingsView.current = view();
  });

  it.each<{ readonly issue: EditorSettingsIssue; readonly expected: string }>([
    { issue: "load", expected: "Editor settings could not be loaded." },
    { issue: "mutation", expected: "Editor settings could not be saved." },
    {
      issue: "conflict",
      expected: "Editor settings changed elsewhere. The latest snapshot was reloaded.",
    },
  ])("shows the alert copy for a $issue issue", ({ issue, expected }) => {
    editorSettingsView.current = view({ issue });
    renderPanel();

    expect(screen.getByRole("alert")).toHaveTextContent(expected);
  });

  it("invokes refresh when the operator clicks Retry inside the mutation alert", () => {
    const refresh = vi.fn(async () => {});
    editorSettingsView.current = view({ issue: "mutation", refresh });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("EditorSettingsPanel workspace-scope guardrail", () => {
  it("shows the workspace warning when no workspace is open", () => {
    editorSettingsView.current = view();
    render(
      <I18nProvider>
        <EditorSettingsPanel />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), {
      target: { value: "workspace" },
    });

    const messages = screen.getAllByText("Open a workspace to edit workspace-scoped settings.");
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe("EditorSettingsPanel AI activation confirmation", () => {
  function ungoverned(): EditorM11SettingsSnapshot {
    return {
      schemaVersion: EDITOR_M7_SCHEMA_VERSION,
      storeState: "ready",
      userRevision: 1,
      workspaceRevision: 1,
      revision: 1_000_000,
      etag: '"edm7-ai-test"',
      root: "/repo",
      definitions: EDITOR_M7_SETTING_REGISTRY,
      settings: resolveEditorM11Settings({
        user: { scope: "user", values: {} },
        workspace: { scope: "workspace", values: {} },
      }),
      eventSequence: 1,
    };
  }

  beforeEach(() => {
    editorSettingsView.current = { ...view(), snapshot: ungoverned() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has no axe violations while the AI activation confirmation dialog is open", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("checkbox", { name: "Inline AI completion" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.parentElement?.parentElement).toBe(document.body);

    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("applies inline AI completion after the operator accepts the confirmation prompt", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("checkbox", { name: "Inline AI completion" }));

    const dialog = screen.getByRole("alertdialog", { name: "Confirm AI-assist activation" });
    expect(within(dialog).getByText(/inline AI completion/u)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Enable" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(editorSettingsView.current.setValue).toHaveBeenCalledWith(
      "user",
      "inlineCompletion",
      true,
    );
  });

  it("skips the mutation and closes the dialog when the operator declines", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), {
      target: { value: "workspace" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "AI test generation" }));

    const dialog = screen.getByRole("alertdialog", { name: "Confirm AI-assist activation" });
    expect(within(dialog).getByText(/AI test generation/u)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(editorSettingsView.current.setValue).not.toHaveBeenCalledWith(
      "workspace",
      "testGeneration",
      true,
    );
  });

  it("closes the dialog on Escape without mutating the setting", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("checkbox", { name: "Inline AI completion" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(editorSettingsView.current.setValue).not.toHaveBeenCalledWith(
      "user",
      "inlineCompletion",
      true,
    );
  });

  it("traps Tab focus inside the confirmation dialog instead of leaking to the settings behind it", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("checkbox", { name: "Inline AI completion" }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm AI-assist activation" });
    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });
    const enableButton = within(dialog).getByRole("button", { name: "Enable" });

    enableButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(cancelButton);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(enableButton);
  });

  it("prompts with the patch-apply copy for the AI patch apply toggle", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), {
      target: { value: "workspace" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "AI patch apply" }));

    const dialog = screen.getByRole("alertdialog", { name: "Confirm AI-assist activation" });
    expect(within(dialog).getByText(/AI patch apply/u)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Enable" }));

    expect(editorSettingsView.current.setValue).toHaveBeenCalledWith(
      "workspace",
      "patchApply",
      true,
    );
  });
});

describe("EditorSettingsPanel AI status badges", () => {
  function status(
    feature: "inlineCompletion" | "testGeneration" | "patchApply",
    state: EditorM7AiState,
  ): EditorM7AiActivationStatus {
    return {
      schemaVersion: EDITOR_M7_SCHEMA_VERSION,
      feature,
      state,
      reasonCode: state === "active" ? "ACTIVE" : "OPERATOR_CEILING_DENIED",
      policyResult: state === "denied" ? "denied" : "allowed",
    };
  }

  function snapshotWithAiStatuses(): EditorM11SettingsSnapshot {
    return {
      ...snapshot(),
      aiAssistance: {
        revision: 1,
        statuses: [
          status("inlineCompletion", "active"),
          status("testGeneration", "denied"),
          status("patchApply", "available"),
        ],
      },
    };
  }

  beforeEach(() => {
    editorSettingsView.current = { ...view(), snapshot: snapshotWithAiStatuses() };
  });

  it.each<{ readonly needle: RegExp; readonly tone: string }>([
    { needle: /AI status: active/u, tone: "success" },
    { needle: /AI status: denied/u, tone: "danger" },
    { needle: /AI status: available/u, tone: "warning" },
  ])("renders the $tone badge tone", ({ needle, tone }) => {
    renderPanel();

    const badge = screen.getByText(needle);
    expect(badge).toHaveAttribute("data-tone", tone);
  });

  // F-01: the server now reports PROVIDER_UNVERIFIED when no readiness probe has confirmed a model
  // for the feature. The badge has to say that in words — a raw reason code next to the word
  // "degraded" reads like a provider fault, and the operator's action (run the readiness check) is
  // different from the one a real fault implies.
  it("explains an unverified provider instead of printing the raw reason code", () => {
    editorSettingsView.current = {
      ...view(),
      snapshot: {
        ...snapshot(),
        aiAssistance: {
          revision: 1,
          statuses: [
            {
              schemaVersion: EDITOR_M7_SCHEMA_VERSION,
              feature: "inlineCompletion",
              state: "degraded",
              reasonCode: "PROVIDER_UNVERIFIED",
              policyResult: "denied",
            },
          ],
        },
      },
    };
    renderPanel();

    const badge = screen.getByText(/AI status: not verified/u);
    expect(badge).toHaveAttribute("data-tone", "warning");
    expect(badge.textContent).toContain("no gateway readiness check");
    expect(screen.queryByText(/PROVIDER_UNVERIFIED/u)).toBeNull();
  });
});
