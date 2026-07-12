import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EDITOR_M7_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";

import {
  createEditorSettingsStore,
  editorSettingsUserRecordPath,
  editorSettingsWorkspaceRecordPath,
  emptyEditorSettingsUserRecord,
  emptyEditorSettingsWorkspaceRecord,
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

describe("editor settings store — direct coverage", () => {
  it.each([
    {
      case: "future-schema-version parses past kind/keys and fails inside parseBase",
      payload: {
        kind: "user" as const,
        schemaVersion: "999",
        revision: 0,
        values: {},
        idempotency: [],
        events: [],
      },
    },
    {
      case: "wrong record kind is rejected at parseUserRecord's discriminator check",
      payload: {
        kind: "workspace" as const,
        schemaVersion: EDITOR_M7_SCHEMA_VERSION,
        revision: 0,
        values: {},
        idempotency: [],
        events: [],
      },
    },
  ])("returns unavailable when the persisted user record is malformed ($case)", ({ payload }) => {
    const stateDir = temporaryDirectory("editor-settings-store-loaduser");
    writeFileSync(editorSettingsUserRecordPath(stateDir), JSON.stringify(payload), "utf8");

    const result = createEditorSettingsStore({ stateDir }).loadUser();

    expect(result).toEqual({ state: "unavailable", record: emptyEditorSettingsUserRecord() });
  });

  it("returns unavailable when the state directory path traverses a symlink", () => {
    const parent = temporaryDirectory("editor-settings-store-symlink");
    const realDir = join(parent, "real");
    const linkDir = join(parent, "link");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);

    const result = createEditorSettingsStore({ stateDir: linkDir }).loadUser();

    expect(result).toEqual({ state: "unavailable", record: emptyEditorSettingsUserRecord() });
  });

  it("returns unavailable when the workspace state dir is nested inside the real root", () => {
    const root = temporaryDirectory("editor-settings-store-nested-root");
    const stateDir = join(root, "state");

    const result = createEditorSettingsStore({ stateDir }).loadWorkspace(root);

    expect(result.state).toBe("unavailable");
    expect(result.record).toEqual(emptyEditorSettingsWorkspaceRecord(root));
  });

  it("returns unavailable when the persisted workspace record file is not valid JSON", () => {
    const stateDir = temporaryDirectory("editor-settings-store-workspace-corrupt");
    const root = temporaryDirectory("editor-settings-store-workspace-corrupt-root");
    writeFileSync(editorSettingsWorkspaceRecordPath(stateDir, root), "{ not valid", "utf8");

    const result = createEditorSettingsStore({ stateDir }).loadWorkspace(root);

    expect(result).toEqual({
      state: "unavailable",
      record: emptyEditorSettingsWorkspaceRecord(root),
    });
  });

  it("rejects commitWorkspace when the record fingerprint belongs to a different real root", () => {
    const stateDir = temporaryDirectory("editor-settings-store-fp-mismatch");
    const rootA = temporaryDirectory("editor-settings-store-fp-a");
    const rootB = temporaryDirectory("editor-settings-store-fp-b");
    const store = createEditorSettingsStore({ stateDir });
    const foreignRecord = emptyEditorSettingsWorkspaceRecord(rootA);

    expect(() => store.commitWorkspace(rootB, foreignRecord)).toThrow(
      /workspace identity mismatch/u,
    );
  });

  it("rejects commitWorkspace when the state directory is nested inside the workspace root", () => {
    const root = temporaryDirectory("editor-settings-store-commit-nested");
    const stateDir = join(root, "state");
    const store = createEditorSettingsStore({ stateDir });
    const record = emptyEditorSettingsWorkspaceRecord(root);

    expect(() => store.commitWorkspace(root, record)).toThrow(
      /state directory must remain outside the workspace/u,
    );
  });
});
