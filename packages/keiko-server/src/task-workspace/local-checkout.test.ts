import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInMemoryUiStore } from "../store/index.js";
import { createBufferedServerLogSink, type ServerLogSink } from "../observability/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
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

function fixture(
  activityLog?: ServerLogSink,
  registeredRoot = root,
): ReturnType<typeof withLocalCheckout> {
  const uiStore = createInMemoryUiStore();
  uiStore.createProject(registeredRoot, "local-checkout-fixture");
  const instances = buildWorkspaceInstanceStoreOverDatabase(db);
  const pointer = buildActiveWorkspacePointerStoreOverDatabase(db);
  const managed = {
    list: (): readonly [] => [],
    listAll: (): readonly [] => [],
    getActive: (): undefined => undefined,
    clearActive: (): void => {
      pointer.clear();
    },
  } as unknown as WorkspaceLifecycleService;
  return withLocalCheckout(managed, pointer, uiStore, instances, { activityLog });
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
  rmSync(`${root}-hook-marker`, { force: true });
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

  it("invalidates a local binding when Git switches branches outside the Workbench", () => {
    const activityLog = createBufferedServerLogSink();
    const service = fixture(activityLog);
    service.selectLocal({ root, branch: "main", requestedBy: "test" });
    git("switch", "feature");

    expect(service.getActive("corr-local-drift")).toBeUndefined();
    expect(service.getActive("corr-local-drift")).toBeUndefined();
    const refusals = activityLog.events.filter(
      (event) =>
        event.op === "task-workspace.lifecycle" && event.extra?.outcome === "retry-required",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      correlationId: "corr-local-drift",
      extra: { operation: "activate", failureKind: "POINTER_DRIFT" },
    });
  });

  it("logs a successful local selection under the request correlation", () => {
    const activityLog = createBufferedServerLogSink();
    const service = fixture(activityLog);
    service.selectLocal({
      root,
      branch: "feature",
      requestedBy: "test",
      correlationId: "corr-local-selection",
    });

    const activated = activityLog.events.find(
      (event) => event.op === "task-workspace.lifecycle" && event.extra?.outcome === "activated",
    );
    expect(activated).toMatchObject({
      correlationId: "corr-local-selection",
      extra: { operation: "activate", outcome: "activated" },
    });
  });

  it("restores a persisted Local workspace through the ordinary active-workspace action", async () => {
    const service = fixture();
    const selected = service.selectLocal({ root, branch: "feature", requestedBy: "test" });
    service.clearActive();
    expect(service.getActive()).toBeUndefined();

    const restored = await service.setActive({
      workspaceId: selected.instance.workspaceId,
      requestedBy: "history",
      acquireLock: false,
    });
    expect(restored.instance.workspaceId).toBe(selected.instance.workspaceId);
    expect(restored.binding.activeRoot).toBe(root);
    expect(service.getActive()?.instance.taskBranch).toBe("feature");
  });

  it("verifies a registered linked checkout against its owning repository", () => {
    const linkedRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-linked-checkout-")));
    try {
      git("worktree", "add", "-q", "-b", "linked", linkedRoot);
      const service = fixture(undefined, linkedRoot);

      const selected = service.selectLocal({
        root: linkedRoot,
        branch: "linked",
        requestedBy: "test",
      });
      expect(selected.binding.activeRoot).toBe(linkedRoot);
      expect(selected.instance.lastVerifiedHead).toBe(git("rev-parse", "linked"));
      expect(service.getActive()?.instance.workspaceId).toBe(selected.instance.workspaceId);
    } finally {
      git("worktree", "remove", "--force", linkedRoot);
      rmSync(linkedRoot, { recursive: true, force: true });
    }
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

  it("refuses a partial target tree before switching or replacing the active binding", () => {
    const service = fixture();
    const active = service.selectLocal({ root, branch: "main", requestedBy: "test" });
    git("switch", "feature");
    writeFileSync(join(root, "feature.txt"), "must be present\n");
    git("add", "feature.txt");
    git("commit", "-qm", "add feature file");
    const blob = git("rev-parse", "feature:feature.txt");
    git("switch", "main");
    git("config", "remote.origin.promisor", "true");
    rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

    expect(() => service.selectLocal({ root, branch: "feature", requestedBy: "test" })).toThrow(
      "unavailable Git objects",
    );
    expect(git("branch", "--show-current")).toBe("main");
    expect(service.getActive()?.instance.workspaceId).toBe(active.instance.workspaceId);
  });

  it("inspects the branch rather than a same-named complete tag", () => {
    const service = fixture();
    git("switch", "feature");
    writeFileSync(join(root, "feature.txt"), "branch-only file\n");
    git("add", "feature.txt");
    git("commit", "-qm", "feature tree");
    const blob = git("rev-parse", "refs/heads/feature:feature.txt");
    git("switch", "main");
    git("tag", "feature", "main");
    git("config", "remote.origin.promisor", "true");
    rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

    expect(() => service.selectLocal({ root, branch: "feature", requestedBy: "test" })).toThrow(
      "unavailable Git objects",
    );
    expect(git("branch", "--show-current")).toBe("main");
  });

  it("classifies an inventory failure with elapsed time and a body-free trace", () => {
    const activityLog = createBufferedServerLogSink();
    const service = fixture(activityLog);
    git("switch", "feature");
    writeFileSync(join(root, "feature.txt"), "feature tree\n");
    git("add", "feature.txt");
    git("commit", "-qm", "feature tree");
    const tree = git("rev-parse", "refs/heads/feature^{tree}");
    git("switch", "main");
    rmSync(join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

    expect(() =>
      service.selectLocal({
        root,
        branch: "feature",
        requestedBy: "test",
        correlationId: "corr-inventory",
      }),
    ).toThrow("could not be inspected");
    expect(git("branch", "--show-current")).toBe("main");
    const line = activityLog.events.find((event) => event.op === "task-workspace.lifecycle");
    expect(line).toMatchObject({
      correlationId: "corr-inventory",
      errorKind: "unavailable",
      extra: {
        operation: "activate",
        failureKind: "REPOSITORY_UNREACHABLE",
        outcome: "retry-required",
      },
    });
    expect(line?.durationMs).toBeGreaterThanOrEqual(0);
    expect(line?.extra?.causeChain).toBeDefined();
    expectActivityLogProof("task-workspace.lifecycle.line", formatActivityLogProofLine(line ?? {}));
  });

  it.skipIf(process.platform === "win32")(
    "does not execute a repository post-checkout hook",
    () => {
      const marker = `${root}-hook-marker`;
      const hook = join(root, ".git", "hooks", "post-checkout");
      writeFileSync(hook, `#!/bin/sh\nprintf reached > '${marker}'\n`);
      chmodSync(hook, 0o755);
      const service = fixture();
      service.selectLocal({ root, branch: "feature", requestedBy: "test" });
      expect(() => readFileSync(marker, "utf8")).toThrow();
    },
  );

  it("refuses branch switching when checkout filters could execute", () => {
    git("config", "filter.unsafe.smudge", "echo unsafe");
    const service = fixture();
    expect(() => service.selectLocal({ root, branch: "feature", requestedBy: "test" })).toThrow();
    expect(git("branch", "--show-current")).toBe("main");
  });

  it("recovers a detached checkout by selecting an existing local branch", () => {
    git("checkout", "--detach", "-q");
    const service = fixture();
    const selected = service.selectLocal({ root, branch: "main", requestedBy: "test" });
    expect(git("branch", "--show-current")).toBe("main");
    expect(selected.instance.taskBranch).toBe("main");
  });
});
