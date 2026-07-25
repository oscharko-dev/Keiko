import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EDITOR_M7_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";

import {
  createEditorSettingsStore,
  editorSettingsRootRecordPath,
  editorSettingsUserRecordPath,
  editorSettingsWorkspaceRecordPath,
  emptyEditorSettingsUserRecord,
  emptyEditorSettingsRootRecord,
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

    expect(() => {
      store.commitWorkspace(rootB, foreignRecord);
    }).toThrow(/workspace identity mismatch/u);
  });

  it("rejects commitWorkspace when the state directory is nested inside the workspace root", () => {
    const root = temporaryDirectory("editor-settings-store-commit-nested");
    const stateDir = join(root, "state");
    const store = createEditorSettingsStore({ stateDir });
    const record = emptyEditorSettingsWorkspaceRecord(root);

    expect(() => {
      store.commitWorkspace(root, record);
    }).toThrow(/state directory must remain outside the workspace/u);
  });

  it("persists root records independently from legacy workspace records", () => {
    const stateDir = temporaryDirectory("editor-settings-store-root-state");
    const root = temporaryDirectory("editor-settings-store-root");
    const store = createEditorSettingsStore({ stateDir });
    store.commitWorkspace(root, {
      ...emptyEditorSettingsWorkspaceRecord(root),
      revision: 2,
      values: { fontSize: 14 },
    });
    store.commitRoot(root, {
      ...emptyEditorSettingsRootRecord(root),
      revision: 3,
      values: { fontSize: 18 },
    });

    expect(store.loadWorkspace(root)).toMatchObject({
      state: "ready",
      record: { revision: 2, values: { fontSize: 14 } },
    });
    expect(store.loadRoot(root)).toMatchObject({
      state: "ready",
      record: { revision: 3, values: { fontSize: 18 } },
    });
    expect(editorSettingsRootRecordPath(stateDir, root)).not.toBe(
      editorSettingsWorkspaceRecordPath(stateDir, root),
    );
  });

  it("stops applying a root record once a different directory occupies the same path", () => {
    // #2620: the record was keyed on sha256(realRoot) alone, so settings written for one directory
    // were re-applied to whatever directory later occupied that path — the ADR-0147 "root
    // replacement at the same path" threat. The record now binds the root's filesystem identity.
    const stateDir = temporaryDirectory("editor-settings-store-root-replaced-state");
    const parent = temporaryDirectory("editor-settings-store-root-replaced");
    const root = join(parent, "root");
    mkdirSync(root);
    const store = createEditorSettingsStore({ stateDir });
    store.commitRoot(root, {
      ...emptyEditorSettingsRootRecord(root),
      revision: 3,
      values: { fontSize: 18 },
    });
    expect(store.loadRoot(root)).toMatchObject({
      state: "ready",
      record: { values: { fontSize: 18 } },
    });

    // Same path, different filesystem object.
    replaceDirectory(root);

    const reloaded = store.loadRoot(root);
    expect(reloaded.state).toBe("absent");
    expect(reloaded.record.values).toEqual({});
  });

  it("reports a foreign or unbound root record as absent, never as unavailable", () => {
    // `unavailable` is the I/O-failure tag, and editorSettingsControl rejects EVERY settings
    // mutation carrying a root whose record is unavailable — user and workspace scope included —
    // with no way back through the API. A record belonging to the directory that used to stand at
    // this path is not unreadable, it simply does not apply here, so it must read as `absent`:
    // contributing nothing while letting the next write supersede it (#2620, ADR-0147 D9).
    const stateDir = temporaryDirectory("editor-settings-store-root-absent-state");
    const parent = temporaryDirectory("editor-settings-store-root-absent");
    const root = join(parent, "root");
    mkdirSync(root);
    const store = createEditorSettingsStore({ stateDir });
    store.commitRoot(root, {
      ...emptyEditorSettingsRootRecord(root),
      revision: 3,
      values: { fontSize: 18 },
    });

    replaceDirectory(root);

    expect(store.loadRoot(root).state).toBe("absent");

    // Self-healing: the next write supersedes the stale record with a correctly bound one.
    store.commitRoot(root, { ...emptyEditorSettingsRootRecord(root), revision: 1 });
    expect(store.loadRoot(root)).toMatchObject({ state: "ready", record: { revision: 1 } });
  });

  it("never applies a root record for a symlink alias, whose identity is denied by design", () => {
    // Identity inspection rejects a symlink alias outright, so its live digest is unreadable. If
    // "unreadable" aliased with "claims no identity", a symlink path would gain a stable, matchable
    // binding — and re-pointing the link at another directory would carry the settings across.
    // Readiness demands a readable live identity, so it cannot (Qodo review, PR #2714).
    const stateDir = temporaryDirectory("editor-settings-store-root-symlink-state");
    const parent = temporaryDirectory("editor-settings-store-root-symlink");
    const target = join(parent, "target");
    const alias = join(parent, "alias");
    mkdirSync(target);
    symlinkSync(target, alias);
    const store = createEditorSettingsStore({ stateDir });

    // The alias can only ever hold the unreadable sentinel, and that never loads as ready.
    store.commitRoot(alias, { ...emptyEditorSettingsRootRecord(alias), values: { fontSize: 18 } });
    expect(store.loadRoot(alias).state).toBe("absent");
    expect(store.loadRoot(alias).record.values).toEqual({});
  });

  it("refuses to commit a root record bound to a root that is no longer the one on disk", () => {
    // A mutation racing a root replacement must not write the new directory's file with the old
    // directory's binding, which would re-create exactly the carry-over the binding prevents.
    const stateDir = temporaryDirectory("editor-settings-store-root-stale-commit-state");
    const parent = temporaryDirectory("editor-settings-store-root-stale-commit");
    const root = join(parent, "root");
    mkdirSync(root);
    const store = createEditorSettingsStore({ stateDir });
    const stale = { ...emptyEditorSettingsRootRecord(root), revision: 1, values: { fontSize: 18 } };

    replaceDirectory(root);

    expect(() => {
      store.commitRoot(root, stale);
    }).toThrow(/root identity mismatch/u);
  });

  it("reports a root record that carries no identity binding at all as absent", () => {
    // A hand-written or pre-binding record must not fall through as `ready` with an empty binding.
    // It reads as absent for the same reason a foreign binding does: it belongs to no root standing
    // here, and treating it as unreadable would brick this root's settings-write surface.
    const stateDir = temporaryDirectory("editor-settings-store-root-unbound-state");
    const root = temporaryDirectory("editor-settings-store-root-unbound");
    writeFileSync(
      editorSettingsRootRecordPath(stateDir, root),
      JSON.stringify({
        kind: "root",
        schemaVersion: EDITOR_M7_SCHEMA_VERSION,
        rootFingerprint: emptyEditorSettingsRootRecord(root).rootFingerprint,
        revision: 4,
        values: { fontSize: 18 },
        idempotency: [],
        events: [],
      }),
      "utf8",
    );

    expect(createEditorSettingsStore({ stateDir }).loadRoot(root)).toMatchObject({
      state: "absent",
      record: { values: {} },
    });

    // And it must not become `ready` when the live identity is unreadable either: "claims no
    // identity" and "identity cannot be read" are different facts, and a record that claims none
    // applies to nothing (CodeRabbit review, PR #2714).
    rmSync(root, { recursive: true, force: true });
    expect(createEditorSettingsStore({ stateDir }).loadRoot(root).state).toBe("absent");
  });
});
