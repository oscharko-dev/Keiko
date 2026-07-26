import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M11_DEFAULT_PROFILE_REF,
  resolveEditorM11Settings,
  type EditorM11ProfileSummary,
  type EditorM11SettingsSnapshot,
  type WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { EditorSettingsView } from "../cards/useEditorSettings";
import { EditorProfilesPanel } from "./EditorProfilesPanel";

const api = vi.hoisted(() => ({
  apply: vi.fn(),
  export: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("../../../../../lib/api", () => ({
  ApiError: class ApiError extends Error {
    readonly code = "INVALID_MANIFEST";
  },
  applyEditorProfileImport: api.apply,
  exportEditorProfile: api.export,
  previewEditorProfileImport: api.preview,
}));

function profileRef(value: string): WorkspaceProfileRef {
  return value as WorkspaceProfileRef;
}

const DEFAULT_PROFILE: EditorM11ProfileSummary = {
  profileRef: EDITOR_M11_DEFAULT_PROFILE_REF,
  displayName: "Default",
  revision: 0,
  settingCount: 0,
  builtIn: true,
};

const FOCUS: EditorM11ProfileSummary = {
  profileRef: profileRef("profile-focus"),
  displayName: "Focus",
  revision: 1,
  settingCount: 2,
  builtIn: false,
};

const WORK: EditorM11ProfileSummary = {
  profileRef: profileRef("profile-work"),
  displayName: "Work",
  revision: 1,
  settingCount: 3,
  builtIn: false,
};

function view(
  activeProfileRef: WorkspaceProfileRef,
  profiles: readonly EditorM11ProfileSummary[] = [DEFAULT_PROFILE, FOCUS, WORK],
): EditorSettingsView {
  const snapshot: EditorM11SettingsSnapshot = {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 0,
    workspaceRevision: 0,
    revision: 0,
    etag: '"edm7-0-0-profiles"',
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM11Settings({}),
    eventSequence: 0,
    profiles: {
      schemaVersion: 1,
      storeState: "ready",
      revision: 3,
      etag: '"edp-3"',
      activeProfileRef,
      profiles,
    },
  };
  return {
    snapshot,
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
      keybindingOverrides: [],
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
  };
}

function renderPanel(currentView: EditorSettingsView): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <EditorProfilesPanel root="/repo" view={currentView} />
    </I18nProvider>,
  );
}

function rerenderPanel(result: ReturnType<typeof render>, currentView: EditorSettingsView): void {
  result.rerender(
    <I18nProvider>
      <EditorProfilesPanel root="/repo" view={currentView} />
    </I18nProvider>,
  );
}

function selectProfile(name: string): void {
  fireEvent.change(screen.getByLabelText("Profile"), {
    target: { value: name },
  });
}

describe("EditorProfilesPanel", () => {
  it("has no axe violations in its normal rendered state", async () => {
    const { container } = renderPanel(view(EDITOR_M11_DEFAULT_PROFILE_REF));
    expect(await axe(container)).toHaveNoViolations();
  });

  /**
   * The selection the user made is the one that gets exported — a portable artifact that silently
   * contains a different profile than the one on screen is worse than a failed export (#2618). A
   * background switch (a second window, an import with "switch after import", any SSE refresh)
   * moves `activeProfileRef`, and that must not move the selection with it.
   */
  it("keeps the user's selection when the active profile changes underneath it", async () => {
    api.export.mockResolvedValue({
      kind: "ok",
      manifest: { profileRef: WORK.profileRef },
      serializedManifest: "{}",
      redactions: [],
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });
    const result = renderPanel(view(EDITOR_M11_DEFAULT_PROFILE_REF));
    selectProfile(WORK.profileRef);

    rerenderPanel(result, view(FOCUS.profileRef));

    expect(screen.getByLabelText("Profile")).toHaveValue(WORK.profileRef);
    fireEvent.click(screen.getByRole("button", { name: "Export selected profile" }));
    await waitFor(() => expect(api.export).toHaveBeenCalledWith(WORK.profileRef));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a half-typed profile name when the active profile changes underneath it", () => {
    const result = renderPanel(view(EDITOR_M11_DEFAULT_PROFILE_REF));
    selectProfile(WORK.profileRef);
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Deep Work" } });

    rerenderPanel(result, view(FOCUS.profileRef));

    expect(screen.getByLabelText("Profile name")).toHaveValue("Deep Work");
  });

  it("projects the newly selected profile's name over an untouched field", () => {
    renderPanel(view(EDITOR_M11_DEFAULT_PROFILE_REF));

    selectProfile(WORK.profileRef);

    expect(screen.getByLabelText("Profile name")).toHaveValue("Work");
  });

  it("falls back to the active profile once the selected profile is gone", () => {
    const result = renderPanel(view(EDITOR_M11_DEFAULT_PROFILE_REF));
    selectProfile(WORK.profileRef);

    rerenderPanel(result, view(FOCUS.profileRef, [DEFAULT_PROFILE, FOCUS]));

    expect(screen.getByLabelText("Profile")).toHaveValue(FOCUS.profileRef);
  });

  it("refuses a display name create and rename would reject", () => {
    renderPanel(view(FOCUS.profileRef));

    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: " Focus" } });

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeDisabled();
  });

  it("renames the profile the user selected, not the active one", () => {
    const currentView = view(FOCUS.profileRef);
    renderPanel(currentView);
    selectProfile(WORK.profileRef);

    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Deep Work" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(currentView.renameProfile).toHaveBeenCalledWith(WORK.profileRef, "Deep Work");
  });
});
