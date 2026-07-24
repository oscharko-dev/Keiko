import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EDITOR_M11_DEFAULT_PROFILE_REF,
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
  WORKSPACE_PROFILE_SCHEMA_VERSION,
  type WorkspaceProfileManifest,
} from "@oscharko-dev/keiko-contracts";

import {
  createEditorProfilesStore,
  editorProfilesRecordPath,
  emptyEditorProfilesRecord,
} from "./editorProfilesStore.js";

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function focusProfile(): WorkspaceProfileManifest {
  const profileRef = "profile-focus" as WorkspaceProfileManifest["profileRef"];
  return {
    kind: "workspace-profile",
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    profileRef,
    displayName: "Focus",
    revision: 1,
    settings: {
      kind: "editor-profile-settings",
      schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
      profileRef,
      revision: 1,
      values: { fontSize: 16, keybindingOverrides: ["1|quick-access.files|CtrlOrMeta+Shift+O"] },
    },
  };
}

describe("editor profiles store", () => {
  it("persists profiles and the active pointer in one aggregate", () => {
    const stateDir = temporaryDirectory("editor-profiles");
    const store = createEditorProfilesStore({ stateDir });
    store.commit({
      ...emptyEditorProfilesRecord(),
      revision: 1,
      activeProfileRef: focusProfile().profileRef,
      profiles: [focusProfile()],
    });

    expect(store.load()).toMatchObject({
      state: "ready",
      record: {
        revision: 1,
        activeProfileRef: "profile-focus",
        profiles: [{ displayName: "Focus" }],
      },
    });
  });

  it("fails closed when the active pointer names no stored profile", () => {
    const stateDir = temporaryDirectory("editor-profiles-dangling");
    writeFileSync(
      editorProfilesRecordPath(stateDir),
      JSON.stringify({
        ...emptyEditorProfilesRecord(),
        activeProfileRef: "profile-missing",
      }),
      "utf8",
    );

    expect(createEditorProfilesStore({ stateDir }).load()).toEqual({
      state: "unavailable",
      record: emptyEditorProfilesRecord(),
    });
    expect(emptyEditorProfilesRecord().activeProfileRef).toBe(EDITOR_M11_DEFAULT_PROFILE_REF);
  });
});
