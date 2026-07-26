import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EDITOR_M11_DEFAULT_PROFILE_REF,
  isWorkspaceProfileRef,
  resolveEditorM7Settings,
  type EditorM7SettingId,
  type EditorM11ResolvedSetting,
  type WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";
import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type { WorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type { ManagedLspControlService } from "../lsp/managedLspControl.js";
import type {
  DebugActivationControlService,
  DebugActivationSynchronization,
} from "../dap/debugActivationControl.js";
import { breakpointStoreWorkspaceFingerprint } from "../dap/breakpointStore.js";
import {
  createEditorSettingsControlService,
  type EditorSettingsControlService,
} from "./editorSettingsControl.js";
import type { EditorProfilesControlMutation } from "./editorSettingsControl.js";
import {
  createEditorSettingsStore,
  editorSettingsUserRecordPath,
  editorSettingsWorkspaceRecordPath,
} from "./editorSettingsStore.js";

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

function profileRef(value: string): WorkspaceProfileRef {
  if (!isWorkspaceProfileRef(value)) throw new Error(`invalid profile fixture: ${value}`);
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Replace the directory at `path` with a genuinely different filesystem object. The replacement is
 * created BEFORE the original is removed, so its inode was allocated while the old one was still in
 * use and can never be the recycled one. Deleting and re-creating in place is not deterministic:
 * Linux commonly hands the freed inode straight back, which leaves the root identity digest — path,
 * device, inode, mode, uid — byte-identical and the record still bound.
 */
function replaceDirectory(path: string): void {
  const staged = `${path}.replacement`;
  mkdirSync(staged);
  rmSync(path, { recursive: true, force: true });
  renameSync(staged, path);
}

/**
 * Fields an M11 row carries that M7 never defined. `profileRef`/`rootRef` came with ADR-0147;
 * `layers` came with #2618, which exposes what each layer stores in its own right so a scoped edit
 * can rewrite the layer it targets instead of the resolved view.
 */
const M11_ADDITIVE_ROW_KEYS = new Set(["layers", "profileRef", "rootRef"]);

/**
 * The M7-defined fields of an M11 row, in M7's own key order. The migration pin below asserts
 * byte-identity against the legacy resolver, so it has to compare what M7 actually defines —
 * comparing whole rows would make every additive M11 field look like a resolution change.
 */
function m7Projection(settings: readonly EditorM11ResolvedSetting[]): string {
  return JSON.stringify(
    settings.map((entry) => ({
      id: entry.id,
      value: entry.value,
      source: entry.source,
      scope: entry.scope,
      policyLocked: entry.policyLocked,
      ...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
      effect: entry.effect,
    })),
  );
}

function settingRow(
  settings: readonly EditorM11ResolvedSetting[],
  id: EditorM7SettingId,
): EditorM11ResolvedSetting {
  const row = settings.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`missing resolved setting: ${id}`);
  return row;
}

function service(
  stateDir = temporaryDirectory("editor-settings-state"),
): EditorSettingsControlService {
  return createEditorSettingsControlService({
    store: createEditorSettingsStore({ stateDir }),
    mutex: createWorkspaceMutexRegistry(),
  });
}

function serviceWithManagedLanguages(
  managedLspControl: ManagedLspControlService,
): EditorSettingsControlService {
  return createEditorSettingsControlService({
    store: createEditorSettingsStore({ stateDir: temporaryDirectory("editor-settings-m6-state") }),
    mutex: createWorkspaceMutexRegistry(),
    managedLspControl,
  });
}

async function mutateProfile(
  control: EditorSettingsControlService,
  mutation: EditorProfilesControlMutation,
): Promise<Awaited<ReturnType<NonNullable<EditorSettingsControlService["mutateProfile"]>>>> {
  if (control.mutateProfile === undefined) throw new Error("profile control unavailable");
  return control.mutateProfile(mutation);
}

async function readProfiles(
  control: EditorSettingsControlService,
): Promise<Awaited<ReturnType<NonNullable<EditorSettingsControlService["readProfiles"]>>>> {
  if (control.readProfiles === undefined) throw new Error("profile control unavailable");
  return control.readProfiles();
}

describe("editor settings control service", () => {
  it("resolves current defaults byte-for-byte when no records exist", async () => {
    const root = temporaryDirectory("editor-settings-root");
    const snapshot = await service().read(root);

    expect(snapshot.storeState).toBe("absent");
    expect(snapshot.revision).toBe(0);
    expect(snapshot.etag).toMatch(/^"edm7-0-0-0-/u);
    expect(snapshot.settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      value: 13,
      source: "builtInDefault",
      policyLocked: false,
    });
    expect(snapshot.settings.find((entry) => entry.id === "inlineCompletion")).toMatchObject({
      value: false,
      source: "builtInDefault",
    });
  });

  it("projects an opaque DAP-compatible workspace identity from the server-resolved root", async () => {
    const root = temporaryDirectory("editor-settings-debug-workspace-id");
    const snapshot = await service().read(root);

    expect(snapshot.debugWorkspaceId).toBe(breakpointStoreWorkspaceFingerprint(root));
    expect(snapshot.debugWorkspaceId).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.debugWorkspaceId).not.toContain(root);
    expect((await service().read()).debugWorkspaceId).toBeUndefined();
  });

  it("applies user and permitted workspace precedence with revisioned ETags", async () => {
    const root = temporaryDirectory("editor-settings-precedence");
    const control = service();
    const user = await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "user-font-size",
      scope: "user",
      values: { fontSize: 15, tabSize: 4 },
    });
    const workspace = await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "workspace-font-size",
      realRoot: root,
      scope: "workspace",
      values: { fontSize: 17 },
    });

    expect(user).toMatchObject({ kind: "ok", changed: true });
    expect(workspace).toMatchObject({ kind: "ok", changed: true });
    const snapshot = await control.read(root);
    expect(snapshot.userRevision).toBe(1);
    expect(snapshot.workspaceRevision).toBe(1);
    expect(snapshot.etag).toMatch(/^"edm7-1-1-0-/u);
    expect(snapshot.settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      value: 17,
      source: "workspace",
    });
    expect(snapshot.settings.find((entry) => entry.id === "tabSize")).toMatchObject({
      value: 4,
      source: "user",
    });
  });

  it("creates, renames, duplicates, and switches named profiles", async () => {
    const refs = ["profile-focus", "profile-focus-copy"];
    const control = createEditorSettingsControlService({
      store: createEditorSettingsStore({ stateDir: temporaryDirectory("editor-profile-crud") }),
      mutex: createWorkspaceMutexRegistry(),
      profileRefFactory: () => profileRef(refs.shift() ?? "missing"),
    });
    const created = await mutateProfile(control, {
      action: "create",
      displayName: "Focus",
      expectedRevision: 0,
      idempotencyKey: "create-focus",
    });
    const renamed = await mutateProfile(control, {
      action: "rename",
      displayName: "Deep Focus",
      expectedRevision: 1,
      idempotencyKey: "rename-focus",
      profileRef: profileRef("profile-focus"),
    });
    const duplicated = await mutateProfile(control, {
      action: "duplicate",
      displayName: "Focus Copy",
      expectedRevision: 2,
      idempotencyKey: "duplicate-focus",
      profileRef: profileRef("profile-focus"),
    });
    const switched = await mutateProfile(control, {
      action: "switch",
      expectedRevision: 3,
      idempotencyKey: "switch-focus-copy",
      profileRef: profileRef("profile-focus-copy"),
    });

    expect(created).toMatchObject({ kind: "ok", profileRef: "profile-focus" });
    expect(renamed).toMatchObject({ kind: "ok", profiles: { revision: 2 } });
    expect(duplicated).toMatchObject({ kind: "ok", profileRef: "profile-focus-copy" });
    expect(switched).toMatchObject({
      kind: "ok",
      profiles: { activeProfileRef: "profile-focus-copy" },
    });
  });

  it("refuses conflicting, duplicate-name, built-in, and unknown-ref profile mutations", async () => {
    const refs = ["profile-one", "profile-two"];
    const control = createEditorSettingsControlService({
      store: createEditorSettingsStore({ stateDir: temporaryDirectory("editor-profile-guards") }),
      mutex: createWorkspaceMutexRegistry(),
      profileRefFactory: () => profileRef(refs.shift() ?? "profile-exhausted"),
    });
    await mutateProfile(control, {
      action: "create",
      displayName: "One",
      expectedRevision: 0,
      idempotencyKey: "guards-create-one",
    });

    const staleRevision = await mutateProfile(control, {
      action: "create",
      displayName: "Two",
      expectedRevision: 0,
      idempotencyKey: "guards-create-stale",
    });
    expect(staleRevision).toMatchObject({ kind: "conflict" });

    const duplicateName = await mutateProfile(control, {
      action: "create",
      displayName: "One",
      expectedRevision: 1,
      idempotencyKey: "guards-create-duplicate",
    });
    expect(duplicateName.kind).not.toBe("ok");

    const renameBuiltIn = await mutateProfile(control, {
      action: "rename",
      displayName: "Not Default Anymore",
      expectedRevision: 1,
      idempotencyKey: "guards-rename-builtin",
      profileRef: EDITOR_M11_DEFAULT_PROFILE_REF,
    });
    expect(renameBuiltIn.kind).not.toBe("ok");

    const deleteBuiltIn = await mutateProfile(control, {
      action: "delete",
      expectedRevision: 1,
      idempotencyKey: "guards-delete-builtin",
      profileRef: EDITOR_M11_DEFAULT_PROFILE_REF,
    });
    expect(deleteBuiltIn.kind).not.toBe("ok");

    const unknownRef = await mutateProfile(control, {
      action: "switch",
      expectedRevision: 1,
      idempotencyKey: "guards-switch-unknown",
      profileRef: profileRef("profile-unknown"),
    });
    expect(unknownRef.kind).not.toBe("ok");

    const replayed = await mutateProfile(control, {
      action: "create",
      displayName: "One",
      expectedRevision: 0,
      idempotencyKey: "guards-create-one",
    });
    expect(replayed).toMatchObject({ kind: "ok", profileRef: "profile-one" });

    const reusedKeyDifferentContent = await mutateProfile(control, {
      action: "create",
      displayName: "Different",
      expectedRevision: 1,
      idempotencyKey: "guards-create-one",
    });
    expect(reusedKeyDifferentContent).toMatchObject({ kind: "idempotencyConflict" });
  });

  it("composes active profile settings below user overrides and persists switching", async () => {
    const stateDir = temporaryDirectory("editor-profile-precedence");
    const root = temporaryDirectory("editor-profile-precedence-root");
    const control = createEditorSettingsControlService({
      store: createEditorSettingsStore({ stateDir }),
      mutex: createWorkspaceMutexRegistry(),
      profileRefFactory: () => profileRef("profile-focus"),
    });
    await mutateProfile(control, {
      action: "create",
      displayName: "Focus",
      expectedRevision: 0,
      idempotencyKey: "create-focus",
    });
    await mutateProfile(control, {
      action: "set",
      expectedRevision: 1,
      idempotencyKey: "configure-focus",
      profileRef: profileRef("profile-focus"),
      values: { fontSize: 18, keybindingOverrides: ["1|quick-access.files|CtrlOrMeta+Shift+O"] },
    });
    await mutateProfile(control, {
      action: "switch",
      expectedRevision: 2,
      idempotencyKey: "activate-focus",
      profileRef: profileRef("profile-focus"),
    });
    await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "user-font-wins",
      scope: "user",
      values: { fontSize: 20 },
    });
    const restarted = service(stateDir);
    const snapshot = await restarted.read(root);

    expect(snapshot.profiles?.activeProfileRef).toBe("profile-focus");
    expect(snapshot.settings.find((setting) => setting.id === "fontSize")).toMatchObject({
      value: 20,
      source: "user",
    });
    expect(snapshot.settings.find((setting) => setting.id === "keybindingOverrides")).toMatchObject(
      {
        source: "profile",
      },
    );
  });

  it("deleting the active profile atomically falls back to immutable Default", async () => {
    const control = createEditorSettingsControlService({
      store: createEditorSettingsStore({ stateDir: temporaryDirectory("editor-profile-delete") }),
      mutex: createWorkspaceMutexRegistry(),
      profileRefFactory: () => profileRef("profile-focus"),
    });
    await mutateProfile(control, {
      action: "create",
      displayName: "Focus",
      expectedRevision: 0,
      idempotencyKey: "create-focus",
    });
    await mutateProfile(control, {
      action: "switch",
      expectedRevision: 1,
      idempotencyKey: "activate-focus",
      profileRef: profileRef("profile-focus"),
    });
    const deleted = await mutateProfile(control, {
      action: "delete",
      expectedRevision: 2,
      idempotencyKey: "delete-focus",
      profileRef: profileRef("profile-focus"),
    });
    const rejected = await mutateProfile(control, {
      action: "delete",
      expectedRevision: 3,
      idempotencyKey: "delete-default",
      profileRef: profileRef("profile-default"),
    });

    expect(deleted).toMatchObject({
      kind: "ok",
      profiles: { activeProfileRef: "profile-default" },
    });
    expect(rejected).toEqual({ kind: "invalid", code: "DEFAULT_PROFILE_IMMUTABLE" });
    expect((await readProfiles(control)).profiles).toHaveLength(1);
  });

  it("resolves independent root layers and falls back through workspace then user", async () => {
    const rootA = temporaryDirectory("editor-settings-root-layer-a");
    const rootB = temporaryDirectory("editor-settings-root-layer-b");
    const control = service();
    await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "root-layer-user",
      scope: "user",
      values: { fontSize: 12 },
    });
    await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "root-layer-workspace-a",
      realRoot: rootA,
      scope: "workspace",
      values: { fontSize: 14 },
    });
    for (const [realRoot, value, key] of [
      [rootA, 16, "root-layer-a"],
      [rootB, 18, "root-layer-b"],
    ] as const) {
      await control.mutate({
        action: "set",
        expectedRevision: 0,
        idempotencyKey: key,
        realRoot,
        scope: "root",
        values: { fontSize: value },
      });
    }

    expect(
      (await control.read(rootA)).settings.find((entry) => entry.id === "fontSize"),
    ).toMatchObject({ value: 16, source: "root", scope: "root" });
    expect(
      (await control.read(rootB)).settings.find((entry) => entry.id === "fontSize"),
    ).toMatchObject({ value: 18, source: "root", scope: "root" });

    await control.mutate({
      action: "reset",
      expectedRevision: 1,
      idempotencyKey: "root-layer-reset-a",
      realRoot: rootA,
      scope: "root",
      settingIds: ["fontSize"],
    });
    expect(
      (await control.read(rootA)).settings.find((entry) => entry.id === "fontSize"),
    ).toMatchObject({ value: 14, source: "workspace" });
    await control.mutate({
      action: "reset",
      expectedRevision: 1,
      idempotencyKey: "root-layer-reset-workspace-a",
      realRoot: rootA,
      scope: "workspace",
      settingIds: ["fontSize"],
    });
    expect(
      (await control.read(rootA)).settings.find((entry) => entry.id === "fontSize"),
    ).toMatchObject({ value: 12, source: "user" });
  });

  it("keeps a single-root M7 resolution fixture byte-identical", async () => {
    const root = temporaryDirectory("editor-settings-single-root-migration");
    const control = service();
    await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "m7-regression-user",
      scope: "user",
      values: { fontSize: 15, minimap: true },
    });
    await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "m7-regression-workspace",
      realRoot: root,
      scope: "workspace",
      values: { fontSize: 16, wordWrap: "on" },
    });
    const snapshot = await control.read(root);
    const legacy = resolveEditorM7Settings({
      user: { scope: "user", values: { fontSize: 15, minimap: true } },
      workspace: { scope: "workspace", values: { fontSize: 16, wordWrap: "on" } },
    });

    expect(m7Projection(snapshot.settings)).toBe(JSON.stringify(legacy));
    // Nothing but the known additive fields may appear, in M7's own key order — the original pin
    // caught an unexpected field by byte-comparing the whole row, and that must keep holding.
    for (const entry of snapshot.settings) {
      const legacyRow = legacy.find((row) => row.id === entry.id);
      expect(Object.keys(entry).filter((key) => !M11_ADDITIVE_ROW_KEYS.has(key))).toEqual(
        Object.keys(legacyRow ?? {}),
      );
    }
    // And the additive part reports exactly the layers this fixture wrote — no more, no less.
    expect(settingRow(snapshot.settings, "fontSize").layers).toEqual({ user: 15, workspace: 16 });
    expect(settingRow(snapshot.settings, "minimap").layers).toEqual({ user: true });
    expect(settingRow(snapshot.settings, "wordWrap").layers).toEqual({ workspace: "on" });
    expect(settingRow(snapshot.settings, "tabSize").layers).toEqual({});
  });

  it("rejects a root override that widens a policy-ceiling setting", async () => {
    const root = temporaryDirectory("editor-settings-root-policy");
    const control = service();
    await expect(
      control.mutate({
        action: "set",
        expectedRevision: 0,
        idempotencyKey: "root-policy-widen",
        realRoot: root,
        scope: "root",
        values: { patchApply: true },
      }),
    ).resolves.toEqual({ kind: "invalid", code: "POLICY_LOCKED" });
  });

  it("rejects stale revisions and replays matching idempotency keys", async () => {
    const control = service();
    const mutation = {
      action: "set" as const,
      expectedRevision: 0,
      idempotencyKey: "repeatable",
      scope: "user" as const,
      values: { fontSize: 16 },
    };

    const first = await control.mutate(mutation);
    const replay = await control.mutate(mutation);
    const stale = await control.mutate({ ...mutation, idempotencyKey: "stale" });
    const reused = await control.mutate({
      ...mutation,
      idempotencyKey: "repeatable",
      values: { fontSize: 18 },
    });

    expect(first).toMatchObject({ kind: "ok", changed: true });
    expect(replay).toMatchObject({ kind: "ok", changed: true });
    expect(stale).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
    expect(reused).toMatchObject({ kind: "idempotencyConflict" });
  });

  it("serializes user-scope mutations and idempotency independent of workspace root", async () => {
    const stateDir = temporaryDirectory("editor-settings-user-root-independent");
    const rootA = temporaryDirectory("editor-settings-user-root-a");
    const rootB = temporaryDirectory("editor-settings-user-root-b");
    const lockedKeys: string[][] = [];
    const mutex: WorkspaceMutexRegistry = {
      runExclusive: async (keys, fn) => {
        lockedKeys.push([...keys]);
        return await fn();
      },
    };
    const control = createEditorSettingsControlService({
      store: createEditorSettingsStore({ stateDir }),
      mutex,
    });
    const mutation = {
      action: "set" as const,
      expectedRevision: 0,
      idempotencyKey: "user-root-independent",
      scope: "user" as const,
      values: { fontSize: 16 },
    };

    const first = await control.mutate({ ...mutation, realRoot: rootA });
    const replayFromOtherRoot = await control.mutate({ ...mutation, realRoot: rootB });

    expect(first).toMatchObject({ kind: "ok", changed: true });
    expect(replayFromOtherRoot).toMatchObject({ kind: "ok", changed: true });
    expect(lockedKeys).toEqual([["editor-settings:user:global"], ["editor-settings:user:global"]]);
  });

  it("resets scoped values without leaking workspace-denied settings", async () => {
    const control = service();
    const denied = await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "workspace-minimap-denied",
      realRoot: temporaryDirectory("editor-settings-denied"),
      scope: "workspace",
      values: { minimap: true },
    });
    const set = await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "set-user-font",
      scope: "user",
      values: { fontSize: 20 },
    });
    const reset = await control.mutate({
      action: "reset",
      expectedRevision: 1,
      idempotencyKey: "reset-user-font",
      scope: "user",
      settingIds: ["fontSize"],
    });

    expect(denied).toMatchObject({ kind: "invalid", code: "WORKSPACE_SCOPE_DENIED" });
    expect(set).toMatchObject({ kind: "ok", changed: true });
    expect(reset).toMatchObject({ kind: "ok", changed: true });
    expect((await control.read()).settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      value: 13,
      source: "builtInDefault",
    });
  });

  it("fails closed for corrupt and future-versioned private records", async () => {
    const stateDir = temporaryDirectory("editor-settings-corrupt");
    const root = temporaryDirectory("editor-settings-corrupt-root");
    writeFileSync(editorSettingsUserRecordPath(stateDir), "{", "utf8");
    writeFileSync(
      editorSettingsWorkspaceRecordPath(stateDir, root),
      JSON.stringify({ kind: "workspace", schemaVersion: "99" }),
      "utf8",
    );
    const control = service(stateDir);

    const snapshot = await control.read(root);
    const result = await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "cannot-write-corrupt",
      scope: "user",
      values: { fontSize: 14 },
    });

    expect(snapshot.storeState).toBe("unavailable");
    expect(result).toMatchObject({ kind: "unavailable", code: "STATE_UNAVAILABLE" });
  });

  it("fails closed for oversized private records", async () => {
    const stateDir = temporaryDirectory("editor-settings-oversized");
    const root = temporaryDirectory("editor-settings-oversized-root");
    writeFileSync(editorSettingsUserRecordPath(stateDir), "x".repeat(600 * 1024), "utf8");

    const control = service(stateDir);

    expect(await control.read(root)).toMatchObject({ storeState: "unavailable" });
    await expect(
      control.mutate({
        action: "set",
        expectedRevision: 0,
        idempotencyKey: "cannot-write-oversized",
        scope: "user",
        values: { fontSize: 14 },
      }),
    ).resolves.toMatchObject({ kind: "unavailable", code: "STATE_UNAVAILABLE" });
  });

  it("composes M6 managed-language state without migrating it into editor settings", async () => {
    const root = temporaryDirectory("editor-settings-m6-root");
    const managedLspControl: ManagedLspControlService = {
      stateDir: temporaryDirectory("managed-lsp-owned-state"),
      read: () =>
        Promise.resolve({
          storeState: "ready",
          revision: 7,
          etag: '"lspcfg-7-managed"',
          evidenceCount: 0,
          languages: [],
          settings: [
            {
              language: "python",
              workspaceActivation: "enabled",
              configured: false,
              restartRequired: false,
              restartFields: [],
              provenance: null,
            },
          ],
          configurations: [],
        }),
      readConfiguration: () => Promise.resolve(undefined),
      mutate: () => Promise.resolve({ kind: "invalid", code: "INVALID_REQUEST" }),
      restrict: () => Promise.resolve(),
    };

    const snapshot = await serviceWithManagedLanguages(managedLspControl).read(root);

    expect(snapshot.managedLanguages).toMatchObject({
      revision: 7,
      etag: '"lspcfg-7-managed"',
      storeState: "ready",
      settingsCount: 1,
      languages: [],
      settings: [{ language: "python", workspaceActivation: "enabled" }],
    });
    expect(snapshot.managedLanguages?.rootRef).toBe(snapshot.rootRef);
    expect(snapshot.managedLanguages?.rootIdentityDigest).toBe(snapshot.rootIdentityDigest);
    expect(snapshot.settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      source: "builtInDefault",
    });
  });

  it("attributes managed-language activation to the owning root", async () => {
    const rootA = temporaryDirectory("editor-settings-language-root-a");
    const rootB = temporaryDirectory("editor-settings-language-root-b");
    const managedLspControl: ManagedLspControlService = {
      stateDir: temporaryDirectory("managed-lsp-root-composition"),
      read: (realRoot) =>
        Promise.resolve({
          storeState: "ready",
          revision: 1,
          etag: '"lspcfg-1-managed-root"',
          evidenceCount: 0,
          languages: [
            {
              ok: true,
              schemaVersion: "1",
              language: "python",
              configurationRevision: 1,
              state: realRoot === rootA ? "available" : "disabled",
              reasonCode: realRoot === rootA ? "AVAILABLE" : "WORKSPACE_ACTIVATION_UNSET",
              policyResult: "allowed",
            },
          ],
          settings: [],
          configurations: [],
        }),
      readConfiguration: () => Promise.resolve(undefined),
      mutate: () => Promise.resolve({ kind: "invalid", code: "INVALID_REQUEST" }),
      restrict: () => Promise.resolve(),
    };
    const control = serviceWithManagedLanguages(managedLspControl);
    const [a, b] = await Promise.all([control.read(rootA), control.read(rootB)]);

    expect(a.managedLanguages?.languages?.[0]).toMatchObject({
      language: "python",
      state: "available",
    });
    expect(b.managedLanguages?.languages?.[0]).toMatchObject({
      language: "python",
      state: "disabled",
    });
    expect(a.managedLanguages?.rootRef).toBe(a.rootRef);
    expect(b.managedLanguages?.rootRef).toBe(b.rootRef);
    expect(a.rootRef).not.toBe(b.rootRef);
  });

  it("projects debugging from the derived D7 gate and synchronizes the canonical workspace mutation", async () => {
    const root = temporaryDirectory("editor-settings-debug-root");
    const synchronizations: DebugActivationSynchronization[] = [];
    const synchronize: DebugActivationControlService["synchronize"] = (input) => {
      synchronizations.push(input);
      return Promise.resolve({
        ok: true as const,
        schemaVersion: "1" as const,
        adapterId: "node-typescript" as const,
        revision: input.context.revision,
        state:
          input.context.workspaceActivation === "enabled"
            ? ("available" as const)
            : ("disabled" as const),
        reasonCode:
          input.context.workspaceActivation === "enabled"
            ? ("AVAILABLE" as const)
            : ("WORKSPACE_DISABLED" as const),
        policyResult: "allowed" as const,
      });
    };
    const debugActivation: DebugActivationControlService = {
      isCurrent: () => true,
      resolve: (context) => ({
        ok: true,
        schemaVersion: "1",
        adapterId: "node-typescript",
        revision: context.revision,
        state: context.workspaceActivation === "enabled" ? "available" : "disabled",
        reasonCode:
          context.workspaceActivation === "enabled" ? "AVAILABLE" : "WORKSPACE_ACTIVATION_UNSET",
        policyResult: "allowed",
      }),
      synchronize,
      dispose: () => undefined,
    };
    const control = createEditorSettingsControlService({
      store: createEditorSettingsStore({
        stateDir: temporaryDirectory("editor-settings-debug-control"),
      }),
      mutex: createWorkspaceMutexRegistry(),
      debugActivation,
    });

    expect((await control.read(root)).debugging).toMatchObject({
      reasonCode: "WORKSPACE_ACTIVATION_UNSET",
    });
    const result = await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "enable-debugging",
      realRoot: root,
      scope: "workspace",
      values: { debuggingEnabled: true },
    });

    expect(result).toMatchObject({ kind: "ok", snapshot: { debugging: { state: "available" } } });
    expect(synchronizations).toHaveLength(1);
    expect(synchronizations[0]).toMatchObject({
      action: "activate",
      changed: true,
      context: { realRoot: root, workspaceActivation: "enabled" },
    });
  });

  it("rolls back a debugging mutation when the mandatory synchronous revocation fails", async () => {
    const root = temporaryDirectory("editor-settings-debug-revocation-failure-root");
    const debugActivation: DebugActivationControlService = {
      isCurrent: () => true,
      resolve: (context) => ({
        ok: true,
        schemaVersion: "1",
        adapterId: "node-typescript",
        revision: context.revision,
        state: "disabled",
        reasonCode: "WORKSPACE_ACTIVATION_UNSET",
        policyResult: "allowed",
      }),
      synchronize: () => Promise.reject(new Error("DEBUG_REVOCATION_FAILED")),
      dispose: () => undefined,
    };
    const control = createEditorSettingsControlService({
      store: createEditorSettingsStore({
        stateDir: temporaryDirectory("editor-settings-debug-revocation-failure-control"),
      }),
      mutex: createWorkspaceMutexRegistry(),
      debugActivation,
    });

    await expect(
      control.mutate({
        action: "set",
        expectedRevision: 0,
        idempotencyKey: "debugging-revocation-failure",
        realRoot: root,
        scope: "workspace",
        values: { debuggingEnabled: true },
      }),
    ).rejects.toThrow("DEBUG_REVOCATION_FAILED");

    expect(
      (await control.read(root)).settings.find((entry) => entry.id === "debuggingEnabled"),
    ).toMatchObject({
      value: false,
      source: "builtInDefault",
    });
  });

  it("invalidates only the departed root's settings and keeps the composite revision monotonic", async () => {
    // #2620: a root that leaves its workspace must not keep a per-root settings binding that a
    // later occupant of the same reference could inherit (ADR-0147). Invalidation writes an empty
    // record at the next revision rather than deleting the file, so `rootRevision` never moves
    // backwards and a stale ETag cannot re-match different content later.
    const control = service();
    const departing = temporaryDirectory("editor-settings-invalidate-departing");
    const surviving = temporaryDirectory("editor-settings-invalidate-surviving");
    for (const [realRoot, value, key] of [
      [departing, 18, "invalidate-departing"],
      [surviving, 20, "invalidate-surviving"],
    ] as const) {
      await control.mutate({
        action: "set",
        expectedRevision: 0,
        idempotencyKey: key,
        realRoot,
        scope: "root",
        values: { fontSize: value },
      });
    }
    const before = await control.read(departing);
    expect(before.rootRevision).toBe(1);

    const invalidate = control.invalidateRoot;
    if (invalidate === undefined) throw new Error("missing invalidateRoot");
    await invalidate(departing);

    const after = await control.read(departing);
    expect(after.settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      source: "builtInDefault",
    });
    // Monotonic: the empty record lands at the next revision instead of resetting to 0, so a stale
    // ETag can never re-match different content later.
    expect(after.rootRevision).toBe(2);
    expect(after.etag).not.toBe(before.etag);

    // The sibling root never lost the settings the human set on it.
    expect(
      (await control.read(surviving)).settings.find((entry) => entry.id === "fontSize"),
    ).toMatchObject({ value: 20, source: "root", scope: "root" });
  });

  it("keeps every settings scope writable after the root directory is replaced", async () => {
    // The blast radius of getting the store state wrong: `loadMutationState` rejects EVERY mutation
    // carrying a root whose record is unavailable, so tagging a superseded root record as
    // unavailable instead of absent would leave the human unable to change user-, workspace- OR
    // root-scope settings for that root, with no recovery path through the API (#2620).
    const stateDir = temporaryDirectory("editor-settings-replaced-state");
    const parent = temporaryDirectory("editor-settings-replaced");
    const root = join(parent, "root");
    mkdirSync(root);
    const control = service(stateDir);
    await control.mutate({
      action: "set",
      expectedRevision: 0,
      idempotencyKey: "replaced-before",
      realRoot: root,
      scope: "root",
      values: { fontSize: 18 },
    });

    replaceDirectory(root);

    const snapshot = await control.read(root);
    expect(snapshot.storeState).not.toBe("unavailable");
    expect(snapshot.settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      source: "builtInDefault",
    });

    for (const [scope, key] of [
      ["user", "replaced-after-user"],
      ["workspace", "replaced-after-workspace"],
      ["root", "replaced-after-root"],
    ] as const) {
      // Each scope is at its own revision 0 here: the superseded root record reads as absent, so
      // the empty record — not the stale revision 1 on disk — is what the write builds on.
      await expect(
        control.mutate({
          action: "set",
          expectedRevision: 0,
          idempotencyKey: key,
          realRoot: root,
          scope,
          values: { fontSize: 15 },
        }),
      ).resolves.toMatchObject({ kind: "ok" });
    }
    expect(
      (await control.read(root)).settings.find((entry) => entry.id === "fontSize"),
    ).toMatchObject({ value: 15, source: "root", scope: "root" });
  });

  it("answers a root replaced mid-mutation with a typed outcome, not a raw error", async () => {
    // Losing the race against a root replacement between loading the record and persisting it is a
    // recoverable condition. A raw throw here escapes the settings mutation path and reaches the
    // top-level handler as an opaque 500 (Qodo review, PR #2714).
    const stateDir = temporaryDirectory("editor-settings-race-state");
    const parent = temporaryDirectory("editor-settings-race");
    const root = join(parent, "root");
    mkdirSync(root);
    const store = createEditorSettingsStore({ stateDir });
    const control = createEditorSettingsControlService({
      store: {
        ...store,
        // Swap the directory out after the record has been loaded and before it is persisted.
        commitRoot: (realRoot, record): void => {
          replaceDirectory(root);
          store.commitRoot(realRoot, record);
        },
      },
      mutex: createWorkspaceMutexRegistry(),
    });

    await expect(
      control.mutate({
        action: "set",
        expectedRevision: 0,
        idempotencyKey: "race-root",
        realRoot: root,
        scope: "root",
        values: { fontSize: 18 },
      }),
    ).resolves.toEqual({ kind: "unavailable", code: "STATE_UNAVAILABLE" });
  });

  it("leaves a root that never had per-root settings untouched", async () => {
    // Invalidation must not materialize state for a root that has none — `absent` stays `absent`.
    const control = service();
    const root = temporaryDirectory("editor-settings-invalidate-absent");
    const before = await control.read(root);

    const invalidate = control.invalidateRoot;
    if (invalidate === undefined) throw new Error("missing invalidateRoot");
    await invalidate(root);

    const after = await control.read(root);
    expect(after.rootRevision).toBe(0);
    expect(after.etag).toBe(before.etag);
  });
});
