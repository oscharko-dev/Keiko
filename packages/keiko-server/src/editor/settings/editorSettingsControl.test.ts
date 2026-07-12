import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type { WorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import type { ManagedLspControlService } from "../lsp/managedLspControl.js";
import {
  createEditorSettingsControlService,
  type EditorSettingsControlService,
} from "./editorSettingsControl.js";
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

describe("editor settings control service", () => {
  it("resolves current defaults byte-for-byte when no records exist", async () => {
    const root = temporaryDirectory("editor-settings-root");
    const snapshot = await service().read(root);

    expect(snapshot.storeState).toBe("absent");
    expect(snapshot.revision).toBe(0);
    expect(snapshot.etag).toMatch(/^"edm7-0-0-/u);
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
    expect(snapshot.etag).toMatch(/^"edm7-1-1-/u);
    expect(snapshot.settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      value: 17,
      source: "workspace",
    });
    expect(snapshot.settings.find((entry) => entry.id === "tabSize")).toMatchObject({
      value: 4,
      source: "user",
    });
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
    };

    const snapshot = await serviceWithManagedLanguages(managedLspControl).read(root);

    expect(snapshot.managedLanguages).toStrictEqual({
      revision: 7,
      etag: '"lspcfg-7-managed"',
      storeState: "ready",
      settingsCount: 1,
    });
    expect(snapshot.settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      source: "builtInDefault",
    });
  });
});
