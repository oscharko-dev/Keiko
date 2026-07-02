import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_TTL_MS,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import { createEditorHotExitStore } from "./hotExitStore.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const VAULT_KEY = Buffer.alloc(32, 0x71).toString("base64");
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-hot-exit-"));
  tmpDirs.push(dir);
  return dir;
}

function snapshot(overrides: Partial<EditorHotExitSnapshotV1> = {}): EditorHotExitSnapshotV1 {
  return {
    schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
    workspaceRoot: "/repo",
    relativePath: "src/app.ts",
    content: "const token = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n",
    baseVersion: { sizeBytes: 16, modifiedAt: 1, contentHash: "a".repeat(64) },
    contentHash: "b".repeat(64),
    savedContentHash: "a".repeat(64),
    updatedAt: 1_000,
    paneId: "pane-1",
    windowId: "editor-1",
    ...overrides,
  };
}

describe("editor hot-exit server store", () => {
  it("stores recoverable content encrypted at rest under a hashed ref", () => {
    const stateDir = tempStateDir();
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    const stored = snapshot();

    const result = store.write(stored);
    const recovered = store.read(result.snapshotRef, 1_001);

    expect(result.snapshotRef).toMatch(/^hot-exit:[a-f0-9]{64}$/u);
    expect(result.snapshotRef).not.toContain("/repo");
    expect(result.snapshotRef).not.toContain("src/app.ts");
    expect(recovered?.content).toBe(stored.content);
    const vaultBytes = readFileSync(join(stateDir, "editor-hot-exit", "snapshots.vault"), "utf8");
    expect(vaultBytes).not.toContain(stored.content);
    expect(vaultBytes).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("deletes expired entries on read", () => {
    const stateDir = tempStateDir();
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY },
    });
    const result = store.write(snapshot({ updatedAt: 1 }));

    expect(store.read(result.snapshotRef, EDITOR_HOT_EXIT_TTL_MS + 2)).toBeNull();
    expect(store.read(result.snapshotRef, 1_001)).toBeNull();
  });
});
