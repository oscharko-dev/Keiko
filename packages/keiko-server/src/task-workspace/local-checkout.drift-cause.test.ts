import { execFileSync } from "node:child_process";
import {
  cpSync,
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
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "./active-store.js";
import { withLocalCheckout } from "./local-checkout.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import type { WorkspaceLifecycleService } from "./types.js";

// Which re-proof of the active-pointer read refused a binding is named on the lifecycle line, with
// the request's correlation id, so a pointer that vanished is located from the log alone.
const CORRELATION_ID = "3f2b8a52-0d6e-4c1a-9a57-2f7f0c1e9b21";

let parent: string;
let root: string;
let db: DatabaseSync;
let uiStore: UiStore;
let log: ReturnType<typeof createBufferedServerLogSink>;
let lifecycle: ReturnType<typeof withLocalCheckout>;

function git(...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function driftLines(): readonly { readonly cause: unknown; readonly correlationId: unknown }[] {
  return log.events
    .filter((event) => event.extra?.outcome === "retry-required")
    .map((event) => ({ cause: event.extra?.driftCause, correlationId: event.correlationId }));
}

function expectRefusedAs(cause: string): void {
  expect(lifecycle.getActive(CORRELATION_ID)).toBeUndefined();
  expect(driftLines()).toEqual([{ cause, correlationId: CORRELATION_ID }]);
}

beforeEach(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "keiko-drift-cause-")));
  root = join(parent, "work");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "x\n");
  git("add", "README.md");
  git("commit", "-qm", "x");
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  uiStore = createInMemoryUiStore();
  uiStore.createProject(root, "drift-cause-fixture");
  log = createBufferedServerLogSink();
  const managed = {
    list: (): readonly [] => [],
    listAll: (): readonly [] => [],
    getActive: (): undefined => undefined,
    clearActive: (): void => undefined,
  } as unknown as WorkspaceLifecycleService;
  lifecycle = withLocalCheckout(
    managed,
    buildActiveWorkspacePointerStoreOverDatabase(db),
    uiStore,
    buildWorkspaceInstanceStoreOverDatabase(db),
    {
      activityLog: log,
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
  lifecycle.selectLocal({ root, branch: "main", requestedBy: "test" });
});

afterEach(() => {
  db.close();
  rmSync(parent, { recursive: true, force: true });
});

describe("active-pointer read drift cause", () => {
  it("names a replaced git directory as git-dir-identity-changed", () => {
    renameSync(join(root, ".git"), join(parent, "old-git"));
    cpSync(join(parent, "old-git"), join(root, ".git"), { recursive: true });
    expectRefusedAs("git-dir-identity-changed");
  });

  it("names a moved branch as branch-changed", () => {
    git("checkout", "-q", "-b", "other");
    expectRefusedAs("branch-changed");
  });

  it("names an unreadable git state as git-state-unreadable", () => {
    writeFileSync(join(root, ".git", "HEAD"), "");
    expectRefusedAs("git-state-unreadable");
  });

  it("names a registration that is gone as root-unregistered", () => {
    uiStore.deleteProject(root);
    expectRefusedAs("root-unregistered");
  });

  it("names a record that is no longer a local binding as instance-record-missing", () => {
    db.exec("UPDATE task_workspace_instances SET execution_location = 'worktree'");
    expectRefusedAs("instance-record-missing");
  });

  it("names a root behind a link as root-not-canonical", () => {
    const real = join(parent, "real");
    renameSync(root, real);
    symlinkSync(real, root, "dir");
    expectRefusedAs("root-not-canonical");
  });

  it("names a deleted folder as inspection-failed", () => {
    rmSync(root, { recursive: true, force: true });
    expectRefusedAs("inspection-failed");
  });

  it("names a replaced folder as folder-identity-changed", () => {
    const folder = join(parent, "plain");
    mkdirSync(folder);
    uiStore.createProject(folder, "plain-folder");
    lifecycle.selectFolder({ root: folder, requestedBy: "test" });
    renameSync(folder, join(parent, "plain-old"));
    mkdirSync(folder);
    expectRefusedAs("folder-identity-changed");
  });

  it("logs a proven binding without any refusal line", () => {
    expect(lifecycle.getActive(CORRELATION_ID)).toBeDefined();
    expect(driftLines()).toEqual([]);
  });
});
