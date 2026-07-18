import { describe, expect, it } from "vitest";
import { isWorkspaceProfileRef } from "./workspace-contract-primitives.js";
import type { WorkspaceProfileRef } from "./workspace-contract-primitives.js";
import { EDITOR_M11_SETTINGS_SCHEMA_VERSION } from "./editor-m11-settings.js";
import {
  redactWorkspaceProfileForExport,
  validateWorkspaceProfileManifest,
  WORKSPACE_PROFILE_SCHEMA_VERSION,
} from "./workspace-profile.js";
import type { WorkspaceProfileManifest } from "./workspace-profile.js";

function profileRef(value: string): ReturnType<typeof validProfileRef> {
  return validProfileRef(value);
}

function validProfileRef(value: string): WorkspaceProfileRef {
  if (!isWorkspaceProfileRef(value)) throw new Error(`invalid fixture: ${value}`);
  return value;
}

function profile(): WorkspaceProfileManifest {
  const ref = profileRef("profile-regulated");
  return {
    kind: "workspace-profile",
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    profileRef: ref,
    displayName: "Regulated workspace",
    revision: 2,
    settings: {
      kind: "editor-profile-settings",
      schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
      profileRef: ref,
      revision: 2,
      values: { fontSize: 14, minimap: true },
    },
  };
}

describe("workspace profile manifest and export", () => {
  it("accepts portable revalidated personalization", () => {
    expect(validateWorkspaceProfileManifest(profile())).toEqual({ ok: true });
    expect(redactWorkspaceProfileForExport(profile())).toEqual(profile());
  });

  it("rejects authority, roots, absolute paths, secrets, and unknown fields", () => {
    for (const hostile of [
      { ...profile(), workspaceTrust: "trusted" },
      { ...profile(), root: "/private/repo" },
      { ...profile(), apiToken: "ghp_secret" },
      { ...profile(), deploymentCeiling: "autonomous-delivery" },
    ]) {
      expect(validateWorkspaceProfileManifest(hostile).ok).toBe(false);
    }
    expect(
      validateWorkspaceProfileManifest({
        ...profile(),
        settings: {
          ...profile().settings,
          values: { watcherExclusions: ["/private/repo/**"] },
        },
      }).ok,
    ).toBe(false);
  });

  it("allows ordinary display names without pretending to detect secret content", () => {
    expect(
      validateWorkspaceProfileManifest({ ...profile(), displayName: "Secret Garden" }),
    ).toEqual({ ok: true });
  });

  it("rejects schema skew, control text, and settings identity drift", () => {
    expect(validateWorkspaceProfileManifest({ ...profile(), schemaVersion: 2 }).ok).toBe(false);
    expect(
      validateWorkspaceProfileManifest({ ...profile(), displayName: "bad\u0000name" }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceProfileManifest({
        ...profile(),
        settings: { ...profile().settings, profileRef: profileRef("profile-other") },
      }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceProfileManifest({
        ...profile(),
        settings: { ...profile().settings, revision: profile().revision + 1 },
      }).ok,
    ).toBe(false);
  });

  it("redaction is deterministic and idempotent", () => {
    const input = { ...profile(), browserToken: "must-not-export" } as WorkspaceProfileManifest;
    const once = redactWorkspaceProfileForExport(input);
    const twice = redactWorkspaceProfileForExport(once);
    expect(twice).toEqual(once);
    expect(once).not.toHaveProperty("browserToken");
  });

  it("keeps validation total for hostile import state", () => {
    const hostile = Object.defineProperty({}, "settings", {
      get(): never {
        throw new Error("hostile settings");
      },
    });
    expect(() => validateWorkspaceProfileManifest(hostile)).not.toThrow();
    expect(validateWorkspaceProfileManifest(hostile).ok).toBe(false);
  });
});
