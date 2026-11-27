import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { hasCurrentWorkspaceRootMembership } from "../workspace-root-membership.js";
import { runMigrations } from "../store/schema.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "./active-store.js";
import { withLocalCheckout } from "./local-checkout.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import type { WorkspaceLifecycleService } from "./types.js";

let parent: string;
let origin: string;
let root: string;
let db: DatabaseSync;

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function cloneInto(): void {
  execFileSync("git", ["clone", "-q", origin, root]);
}

function registeredStore(): UiStore {
  const uiStore = createInMemoryUiStore();
  uiStore.createProject(root, "reclone-fixture");
  return uiStore;
}

function service(uiStore: UiStore = registeredStore()): ReturnType<typeof withLocalCheckout> {
  const managed = {
    list: (): readonly [] => [],
    listAll: (): readonly [] => [],
    getActive: (): undefined => undefined,
    clearActive: (): void => undefined,
  } as unknown as WorkspaceLifecycleService;
  return withLocalCheckout(
    managed,
    buildActiveWorkspacePointerStoreOverDatabase(db),
    uiStore,
    buildWorkspaceInstanceStoreOverDatabase(db),
    {
      evidenceStore: {
        put: (id) => id,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      redactString: (value): string => value,
      now: Date.now,
    },
  );
}

beforeEach(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "keiko-reclone-")));
  origin = join(parent, "origin");
  root = join(parent, "work");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  git(origin, "config", "user.email", "t@example.invalid");
  git(origin, "config", "user.name", "T");
  git(origin, "config", "commit.gpgsign", "false");
  writeFileSync(join(origin, "README.md"), "x\n");
  git(origin, "add", "README.md");
  git(origin, "commit", "-qm", "x");
  cloneInto();
  db = new DatabaseSync(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(parent, { recursive: true, force: true });
});

describe("local checkout re-clone at the same path", () => {
  it("re-selects a deleted and re-cloned checkout after a full fresh validation", () => {
    const first = service();
    const selected = first.selectLocal({ root, branch: "main", requestedBy: "test" });
    expect(first.getActive()?.instance.workspaceId).toBe(selected.instance.workspaceId);
    rmSync(root, { recursive: true, force: true });
    expect(first.getActive()).toBeUndefined();
    cloneInto();
    const again = first.selectLocal({ root, branch: "main", requestedBy: "test" });
    expect(first.getActive()?.instance.workspaceId).toBe(again.instance.workspaceId);
  });

  it("reports the registration as unavailable after the re-clone until the person reconnects it", () => {
    const uiStore = registeredStore();
    const lifecycle = service(uiStore);
    lifecycle.selectLocal({ root, branch: "main", requestedBy: "test" });
    expect(hasCurrentWorkspaceRootMembership(uiStore, root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
    cloneInto();
    // The registration still names the path, but the directory behind it is another one.
    expect(hasCurrentWorkspaceRootMembership(uiStore, root)).toBe(false);
    uiStore.reconnectProject(root);
    expect(hasCurrentWorkspaceRootMembership(uiStore, root)).toBe(true);
    const again = lifecycle.selectLocal({ root, branch: "main", requestedBy: "test" });
    expect(lifecycle.getActive()?.instance.workspaceId).toBe(again.instance.workspaceId);
  });
});
