import { describe, expect, it } from "vitest";

import {
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
  WORKSPACE_PROFILE_SCHEMA_VERSION,
  isWorkspaceProfileRef,
  type WorkspaceProfileManifest,
  type WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";

import {
  assembleEditorProfileExport,
  previewEditorProfileImport,
} from "./editorProfilePortability.js";

function profileRef(value: string): WorkspaceProfileRef {
  if (!isWorkspaceProfileRef(value)) throw new Error(`invalid profile fixture: ${value}`);
  return value;
}

function profile(
  values: WorkspaceProfileManifest["settings"]["values"] = {
    fontSize: 18,
    tabSize: 4,
  },
): WorkspaceProfileManifest {
  const ref = profileRef("profile-focus");
  return {
    kind: "workspace-profile",
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    profileRef: ref,
    displayName: "Focus",
    revision: 2,
    settings: {
      kind: "editor-profile-settings",
      schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
      profileRef: ref,
      revision: 2,
      values,
    },
  };
}

describe("editor profile portability", () => {
  it.each([
    "/Users/customer/private/**",
    "~/customer/private/**",
    "C:/customer/private/**",
    "ghp_0123456789abcdefghijklmnop",
    "sk-0123456789abcdefghijklmnop",
  ])("strips path and secret classes deterministically without echoing them (%s)", (hostile) => {
    const input = profile({ watcherExclusions: ["dist/**", hostile], tabSize: 4 });
    const first = assembleEditorProfileExport(input);
    const second = assembleEditorProfileExport(input);

    expect(first.serializedManifest).toBe(second.serializedManifest);
    expect(first.serializedManifest).not.toContain(hostile);
    expect(first.manifest.settings.values).toEqual({ tabSize: 4, watcherExclusions: ["dist/**"] });
    expect(first.redactions).toHaveLength(1);
  });

  it("previews every imported value and keeps rejected rows content-free", () => {
    const importedValues = {
      fontSize: 1000,
      tabSize: 4,
      watcherExclusions: ["/private/customer/**"],
      unknownSetting: "customer-secret-body",
    };
    const imported = profile(importedValues);
    const prepared = previewEditorProfileImport(imported, {
      activeValues: { tabSize: 2 },
      existingNames: [],
      expectedRevision: 7,
    });

    expect(prepared.kind).toBe("ok");
    if (prepared.kind !== "ok") return;
    expect(prepared.preview.rows).toEqual([
      { settingId: "fontSize", disposition: "rejected", reasonCode: "VALUE_OUT_OF_BOUNDS" },
      { settingId: "tabSize", disposition: "change", value: 4 },
      { settingId: "watcherExclusions", disposition: "rejected", reasonCode: "NON_PORTABLE_PATH" },
      { settingId: "unknownSetting", disposition: "rejected", reasonCode: "UNKNOWN_SETTING" },
    ]);
    expect(prepared.values).toEqual({ tabSize: 4 });
    expect(JSON.stringify(prepared.preview)).not.toContain("customer-secret-body");
    expect(prepared.preview.previewDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("round-trips valid current manifests and deterministically renames collisions", () => {
    const prepared = previewEditorProfileImport(profile(), {
      activeValues: { fontSize: 18 },
      existingNames: ["Focus", "Focus (Imported)"],
      expectedRevision: 3,
    });

    expect(prepared.kind).toBe("ok");
    if (prepared.kind !== "ok") return;
    expect(prepared.values).toEqual({ fontSize: 18, tabSize: 4 });
    expect(prepared.preview.proposedDisplayName).toBe("Focus (Imported 2)");
    expect(prepared.preview.collisionRenamed).toBe(true);
    expect(prepared.preview.rows).toMatchObject([
      { settingId: "fontSize", disposition: "noOp" },
      { settingId: "tabSize", disposition: "add" },
    ]);
  });

  it("refuses future versions and excessive JSON depth without partial values", () => {
    expect(
      previewEditorProfileImport(
        { ...profile(), schemaVersion: 2 },
        {
          activeValues: {},
          existingNames: [],
          expectedRevision: 0,
        },
      ),
    ).toEqual({ kind: "invalid", code: "FUTURE_SCHEMA_VERSION" });

    let values: unknown = "leaf";
    for (let index = 0; index < 12; index += 1) values = { nested: values };
    expect(
      previewEditorProfileImport(
        { ...profile(), settings: { ...profile().settings, values } },
        {
          activeValues: {},
          existingNames: [],
          expectedRevision: 0,
        },
      ),
    ).toEqual({ kind: "invalid", code: "IMPORT_TOO_DEEP" });
  });
});
