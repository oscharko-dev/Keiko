import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInMemoryUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "./active-store.js";
import { withLocalCheckout } from "./local-checkout.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import type { WorkspaceLifecycleService } from "./types.js";

let root: string;
let db: DatabaseSync;

function git(...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function fixture(): ReturnType<typeof withLocalCheckout> {
  const uiStore = createInMemoryUiStore();
  uiStore.createProject(root, "local-checkout-fixture");
  const instances = buildWorkspaceInstanceStoreOverDatabase(db);
  const pointer = buildActiveWorkspacePointerStoreOverDatabase(db);
  const managed = {
    list: (): readonly [] => [],
    listAll: (): readonly [] => [],
    getActive: (): undefined => undefined,
  } as unknown as WorkspaceLifecycleService;
  return withLocalCheckout(managed, pointer, uiStore, instances);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-local-checkout-")));
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Keiko Test");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-qm", "fixture");
  git("branch", "feature");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("local checkout selection", () => {
  it("switches the real checkout and restores a durable active binding", () => {
    const service = fixture();
    const selected = service.selectLocal({ root, branch: "feature", requestedBy: "test" });
    expect(git("branch", "--show-current")).toBe("feature");
    expect(selected.binding.activeRoot).toBe(root);
    expect(selected.instance.executionLocation).toBe("local");
    expect(selected.instance.taskBranch).toBe("feature");
    expect(service.getActive()?.instance.workspaceId).toBe(selected.instance.workspaceId);
    expect(service.list(root)).toEqual([]);
    expect(service.listAll()).toEqual([]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("fixture\n");
  });

  it("rejects unknown branches without changing HEAD or the active pointer", () => {
    const service = fixture();
    const original = service.selectLocal({ root, branch: "main", requestedBy: "test" });
    expect(() => service.selectLocal({ root, branch: "missing", requestedBy: "test" })).toThrow();
    expect(git("branch", "--show-current")).toBe("main");
    expect(service.getActive()?.instance.workspaceId).toBe(original.instance.workspaceId);
  });

  it("rejects a conflicting branch switch and keeps local changes", () => {
    const service = fixture();
    git("switch", "feature");
    writeFileSync(join(root, "README.md"), "feature\n");
    git("add", "README.md");
    git("commit", "-qm", "feature content");
    git("switch", "main");
    service.selectLocal({ root, branch: "main", requestedBy: "test" });
    writeFileSync(join(root, "README.md"), "uncommitted\n");
    expect(() => service.selectLocal({ root, branch: "feature", requestedBy: "test" })).toThrow();
    expect(git("branch", "--show-current")).toBe("main");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("uncommitted\n");
  });
});
