import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceProfileManifest } from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_M11_DEFAULT_PROFILE_REF,
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/editor-m11-settings";
import { WORKSPACE_PROFILE_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-profile";

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

describe("persisted profile identity (#2618)", () => {
  function storedRecord(profiles: readonly WorkspaceProfileManifest[], stateDir: string): void {
    writeFileSync(
      editorProfilesRecordPath(stateDir),
      JSON.stringify({ ...emptyEditorProfilesRecord(), revision: 1, profiles }),
      "utf8",
    );
  }

  function named(ref: string, displayName: string): WorkspaceProfileManifest {
    const base = focusProfile();
    const profileRef = ref as WorkspaceProfileManifest["profileRef"];
    return { ...base, profileRef, displayName, settings: { ...base.settings, profileRef } };
  }

  // The reserved-name and collision checks only lower-cased, while the key that decides when two
  // display names are the same name to a reader also TRIMS. A persisted profile named " Default "
  // therefore passed both and shadowed the built-in one: two entries reading "Default" in the
  // picker, with nothing saying which is built in.
  it("rejects a persisted profile that claims the reserved name with padding", () => {
    const stateDir = temporaryDirectory("editor-profiles-reserved-padded");
    storedRecord([named("profile-a", " Default ")], stateDir);

    expect(createEditorProfilesStore({ stateDir }).load()).toEqual({
      state: "unavailable",
      record: emptyEditorProfilesRecord(),
    });
  });

  it("rejects two persisted profiles whose names differ only by padding", () => {
    const stateDir = temporaryDirectory("editor-profiles-padded-collision");
    storedRecord([named("profile-a", "Focus"), named("profile-b", " Focus ")], stateDir);

    expect(createEditorProfilesStore({ stateDir }).load()).toEqual({
      state: "unavailable",
      record: emptyEditorProfilesRecord(),
    });
  });
});
