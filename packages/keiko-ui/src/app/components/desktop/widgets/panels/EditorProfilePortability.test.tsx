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
  type WorkspaceProfileImportPreview,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { EditorSettingsView } from "../cards/useEditorSettings";
import { EditorProfilePortability } from "./EditorProfilePortability";

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

const profileRef = "profile-focus" as EditorM11ProfileSummary["profileRef"];
const selected: EditorM11ProfileSummary = {
  profileRef,
  displayName: "Focus",
  revision: 1,
  settingCount: 1,
  builtIn: false,
};

const preview: WorkspaceProfileImportPreview = {
  kind: "ok",
  schemaVersion: 1,
  expectedRevision: 3,
  sourceDisplayName: "Focus",
  proposedDisplayName: "Focus (Imported)",
  collisionRenamed: true,
  previewDigest: "a".repeat(64),
  rows: [
    { settingId: "tabSize", disposition: "add", value: 4 },
    { settingId: "fontSize", disposition: "rejected", reasonCode: "VALUE_OUT_OF_BOUNDS" },
  ],
};

function view(): EditorSettingsView {
  const snapshot: EditorM11SettingsSnapshot = {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 0,
    workspaceRevision: 0,
    revision: 0,
    etag: '"edm7-0-0-test"',
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM11Settings({}),
    eventSequence: 0,
    profiles: {
      schemaVersion: 1,
      storeState: "ready",
      revision: 3,
      etag: '"edp-3"',
      activeProfileRef: EDITOR_M11_DEFAULT_PROFILE_REF,
      profiles: [selected],
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

describe("EditorProfilePortability", () => {
  it("requires a server preview before applying a new profile", async () => {
    api.preview.mockResolvedValue(preview);
    api.apply.mockResolvedValue({ kind: "ok" });
    const currentView = view();
    const { container } = render(
      <I18nProvider>
        <EditorProfilePortability root="/repo" selected={selected} view={currentView} />
      </I18nProvider>,
    );
    const manifest = JSON.stringify({ kind: "workspace-profile", schemaVersion: 1 });
    const file = new File([manifest], "focus.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(manifest) });

    fireEvent.change(screen.getByLabelText("Import profile file"), { target: { files: [file] } });
    expect(await screen.findByText("New profile: Focus (Imported)")).toBeInTheDocument();
    expect(screen.getByText("VALUE_OUT_OF_BOUNDS")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply import" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Switch after import" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }));

    await waitFor(() => expect(api.apply).toHaveBeenCalledOnce());
    expect(api.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 3,
        manifest: { kind: "workspace-profile", schemaVersion: 1 },
        previewDigest: "a".repeat(64),
        root: "/repo",
        switchAfterImport: true,
      }),
      '"edp-3"',
      expect.any(String),
    );
    expect(currentView.refresh).toHaveBeenCalledOnce();
    expect(await axe(container)).toHaveNoViolations();
  });
});
