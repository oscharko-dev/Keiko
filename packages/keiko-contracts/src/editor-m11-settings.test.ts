import { describe, expect, it } from "vitest";
import {
  isWorkspaceProfileRef,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
} from "./workspace-contract-primitives.js";
import { EDITOR_M7_SETTING_REGISTRY } from "./editor-m7.js";
import {
  resolveEditorM11Settings,
  editorM11RootSettingIsMonotonic,
  parseEditorM11SettingsEvent,
  validateEditorM11ProfileSettingsLayer,
  validateEditorM11RootSettingsLayer,
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
} from "./editor-m11-settings.js";
import type {
  EditorM11ProfileSettingsLayer,
  EditorM11ResolvedSetting,
  EditorM11RootSettingsLayer,
} from "./editor-m11-settings.js";

function checked<Value>(value: string, guard: (input: unknown) => input is Value): Value {
  if (!guard(value)) throw new Error(`invalid fixture: ${value}`);
  return value;
}

/**
 * Everything a resolved row says about the OUTCOME, with the per-layer projection removed. The
 * projection is expected to differ whenever a layer is added; the outcome is not.
 */
function resolution(
  setting: EditorM11ResolvedSetting | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (setting === undefined) return undefined;
  return Object.fromEntries(Object.entries(setting).filter(([key]) => key !== "layers"));
}

const PROFILE = checked("profile-primary", isWorkspaceProfileRef);
const ROOT = checked("root-primary", isWorkspaceRootRef);
const ROOT_DIGEST = checked("a".repeat(64), isWorkspaceRootIdentityDigest);

function profileLayer(): EditorM11ProfileSettingsLayer {
  return {
    kind: "editor-profile-settings",
    schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
    profileRef: PROFILE,
    revision: 2,
    values: { fontSize: 12, minimap: true },
  };
}

function rootLayer(): EditorM11RootSettingsLayer {
  return {
    kind: "editor-root-settings",
    schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
    rootRef: ROOT,
    rootIdentityDigest: ROOT_DIGEST,
    revision: 3,
    values: { fontSize: 16, tabSize: 4 },
  };
}

describe("M11 editor settings", () => {
  it("resolves default < profile < user < workspace < root < policy", () => {
    const resolved = resolveEditorM11Settings({
      profile: profileLayer(),
      user: { scope: "user", values: { fontSize: 13 } },
      workspace: { scope: "workspace", values: { fontSize: 14 } },
      root: rootLayer(),
      ceiling: { locked: { fontSize: "POLICY_LOCKED" } },
    });
    expect(resolved.find((entry) => entry.id === "fontSize")).toMatchObject({
      value: 16,
      source: "root",
      rootRef: ROOT,
      policyLocked: true,
    });
    expect(
      resolveEditorM11Settings({
        profile: profileLayer(),
        user: { scope: "user", values: { fontSize: 13 } },
      }).find((entry) => entry.id === "fontSize"),
    ).toMatchObject({ value: 13, source: "user" });
  });

  it("reports every precedence source and its exact provenance", () => {
    const fontSize = (
      input: Parameters<typeof resolveEditorM11Settings>[0],
    ): EditorM11ResolvedSetting | undefined =>
      resolveEditorM11Settings(input).find((entry) => entry.id === "fontSize");

    expect(fontSize({})).toMatchObject({ value: 13, source: "builtInDefault" });
    expect(fontSize({ profile: profileLayer() })).toMatchObject({
      value: 12,
      source: "profile",
      profileRef: PROFILE,
    });
    expect(
      fontSize({
        profile: profileLayer(),
        user: { scope: "user", values: { fontSize: 13 } },
      }),
    ).toMatchObject({ value: 13, source: "user" });
    expect(
      fontSize({
        user: { scope: "user", values: { fontSize: 13 } },
        workspace: { scope: "workspace", values: { fontSize: 14 } },
      }),
    ).toMatchObject({ value: 14, source: "workspace" });
    expect(fontSize({ root: rootLayer() })).toMatchObject({
      value: 16,
      source: "root",
      rootRef: ROOT,
    });
    expect(
      fontSize({
        root: rootLayer(),
        ceiling: { locked: { fontSize: "POLICY_LOCKED" } },
      }),
    ).toMatchObject({
      value: 16,
      source: "root",
      rootRef: ROOT,
      policyLocked: true,
      reasonCode: "POLICY_LOCKED",
    });
  });

  it("keeps every narrower user value invariant when a profile value is added or removed", () => {
    for (const definition of EDITOR_M7_SETTING_REGISTRY) {
      const user = { scope: "user" as const, values: { [definition.id]: definition.defaultValue } };
      const withoutProfile = resolveEditorM11Settings({ user }).find(
        (setting) => setting.id === definition.id,
      );
      const withProfile = resolveEditorM11Settings({
        profile: {
          ...profileLayer(),
          values: { [definition.id]: definition.defaultValue },
        },
        user,
      }).find((setting) => setting.id === definition.id);

      // A profile layer is the weakest layer: it may only ADD its own entry to the layer
      // projection (#2618) and must leave every resolution field — value, source, scope,
      // provenance, policy — exactly as it was.
      expect(resolution(withProfile), definition.id).toEqual(resolution(withoutProfile));
      expect(withProfile?.layers, definition.id).toEqual({
        ...withoutProfile?.layers,
        profile: definition.defaultValue,
      });
      expect(withProfile?.source, definition.id).toBe("user");
    }
  });

  it("reuses M7 scope and value validation", () => {
    expect(validateEditorM11ProfileSettingsLayer(profileLayer())).toEqual({ ok: true });
    expect(validateEditorM11RootSettingsLayer(rootLayer())).toEqual({ ok: true });
    expect(
      validateEditorM11ProfileSettingsLayer({ ...profileLayer(), values: { fontSize: 1000 } }).ok,
    ).toBe(false);
    expect(
      validateEditorM11RootSettingsLayer({ ...rootLayer(), values: { minimap: true } }).ok,
    ).toBe(false);
    expect(validateEditorM11RootSettingsLayer({ ...rootLayer(), rootRef: undefined }).ok).toBe(
      false,
    );
    expect(
      validateEditorM11ProfileSettingsLayer({
        ...profileLayer(),
        values: { patchApply: true },
      }).ok,
    ).toBe(false);
    expect(validateEditorM11ProfileSettingsLayer({ ...profileLayer(), extra: true }).ok).toBe(
      false,
    );
    expect(validateEditorM11RootSettingsLayer({ ...rootLayer(), revision: -1 }).ok).toBe(false);
  });

  it("keeps layer validators total for hostile input", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile keys");
        },
      },
    );
    expect(() => validateEditorM11ProfileSettingsLayer(hostile)).not.toThrow();
    expect(() => validateEditorM11RootSettingsLayer(hostile)).not.toThrow();
    expect(validateEditorM11ProfileSettingsLayer(hostile).ok).toBe(false);
    expect(validateEditorM11RootSettingsLayer(hostile).ok).toBe(false);
  });

  it("keeps every policy-ceiling root override monotonic", () => {
    for (const definition of EDITOR_M7_SETTING_REGISTRY) {
      if (definition.security !== "policyCeiling") continue;
      expect(definition.type).toBe("boolean");
      expect(editorM11RootSettingIsMonotonic(definition.id, false, true)).toBe(false);
      expect(editorM11RootSettingIsMonotonic(definition.id, true, false)).toBe(true);
      expect(editorM11RootSettingIsMonotonic(definition.id, false, false)).toBe(true);
      expect(editorM11RootSettingIsMonotonic(definition.id, true, true)).toBe(true);
    }
    expect(editorM11RootSettingIsMonotonic("fontSize", 12, 32)).toBe(true);
    expect(
      resolveEditorM11Settings({
        root: { ...rootLayer(), values: { patchApply: true } },
      }).find((setting) => setting.id === "patchApply"),
    ).toMatchObject({ value: false, source: "builtInDefault" });
    expect(
      resolveEditorM11Settings({
        workspace: { scope: "workspace", values: { patchApply: true } },
        root: { ...rootLayer(), values: { patchApply: false } },
      }).find((setting) => setting.id === "patchApply"),
    ).toMatchObject({ value: false, source: "root" });
  });

  it("parses root-scoped settings events and rejects duplicate setting ids", () => {
    const event = {
      schemaVersion: "1",
      sequence: 4,
      kind: "changed",
      revision: 1,
      userRevision: 0,
      workspaceRevision: 0,
      rootRevision: 1,
      scope: "root",
      settingIds: ["fontSize"],
      storeState: "ready",
    };
    expect(parseEditorM11SettingsEvent(event)).toEqual({ ok: true, value: event });
    expect(parseEditorM11SettingsEvent({ ...event, settingIds: ["fontSize", "fontSize"] })).toEqual(
      { ok: false },
    );
  });
});
