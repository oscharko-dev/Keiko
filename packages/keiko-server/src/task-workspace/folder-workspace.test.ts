import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  FOLDER_WORKSPACE_BRANCH,
  folderWorkspaceHead,
  validateWorkspaceInstance,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";

import { createInMemoryUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import {
  productionWorkspaceMatches,
  resolveProductionRuntimeContext,
} from "../coding-runtime/productionRuntimeWorkspaceAuthority.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "./active-store.js";
import { withLocalCheckout } from "./local-checkout.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import { TaskWorkspaceError } from "./errors.js";
import type { WorkspaceLifecycleService } from "./types.js";

let root: string;
let db: DatabaseSync;
let evidence: string[];

function evidenceStore(): EvidenceStore {
  return {
    put: (id, json): string => {
      evidence.push(json);
      return id;
    },
    list: (): readonly string[] => [],
    get: (): undefined => undefined,
    delete: (): void => undefined,
  };
}

function fixture(
  log = createBufferedServerLogSink(),
  register: string | null = root,
): {
  readonly service: ReturnType<typeof withLocalCheckout>;
  readonly instances: ReturnType<typeof buildWorkspaceInstanceStoreOverDatabase>;
  readonly pointer: ReturnType<typeof buildActiveWorkspacePointerStoreOverDatabase>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
} {
  const uiStore = createInMemoryUiStore();
  if (register !== null) uiStore.createProject(register, "folder-fixture");
  const instances = buildWorkspaceInstanceStoreOverDatabase(db);
  const pointer = buildActiveWorkspacePointerStoreOverDatabase(db);
  const managed = {
    list: (): readonly [] => [],
    listAll: (): readonly [] => [],
    getActive: (): undefined => undefined,
    clearActive: (): void => {
      pointer.clear();
    },
    setActive: (): never => {
      throw new Error("a folder is never activated through the managed lifecycle");
    },
  } as unknown as WorkspaceLifecycleService;
  const service = withLocalCheckout(managed, pointer, uiStore, instances, {
    activityLog: log,
    evidenceStore: evidenceStore(),
    redactString: (value): string => value,
    now: Date.now,
  });
  return { service, instances, pointer, log };
}

beforeEach(() => {
  evidence = [];
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko plain folder-")));
  writeFileSync(join(root, "notes.txt"), "not a repository\n");
  db = new DatabaseSync(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("folder workspace selection (owner decision 2026-10-30)", () => {
  it("binds an ordinary folder in place without a branch, a worktree or a HEAD", () => {
    const { service, instances } = fixture();
    const active = service.selectFolder({ root, requestedBy: "test", correlationId: "folder-1" });
    const { instance, binding } = active;
    expect(instance).toMatchObject({
      workspaceKind: "folder",
      executionLocation: "local",
      baseBranch: FOLDER_WORKSPACE_BRANCH,
      taskBranch: FOLDER_WORKSPACE_BRANCH,
      lifecycleState: "active",
      health: "healthy",
      repositoryRoot: root,
      managedWorktreePath: root,
    });
    expect(instance.lastVerifiedHead).toBe(folderWorkspaceHead(instance.gitdirIdentity));
    expect(binding.activeRoot).toBe(root);
    expect(validateWorkspaceInstance(instance)).toEqual({ ok: true });
    // The stored row reads back as a folder, so a restart keeps the kind.
    expect(instances.getById(instance.workspaceId)?.workspaceKind).toBe("folder");
    expect(service.getActive()?.instance.workspaceId).toBe(instance.workspaceId);
  });

  it("keeps the folder out of the managed worktree inventory", () => {
    const { service } = fixture();
    service.selectFolder({ root, requestedBy: "test" });
    expect(service.list(root)).toEqual([]);
    expect(service.listAll()).toEqual([]);
  });

  it("records the selection on the Activity Log under the request correlation, body-free", () => {
    const { service, log } = fixture();
    service.selectFolder({ root, requestedBy: "test", correlationId: "folder-corr-1" });
    const line = log.events.find((event) => event.extra?.outcome === "activated");
    expect(line).toMatchObject({
      op: "task-workspace.lifecycle",
      correlationId: "folder-corr-1",
      extra: { operation: "activate", outcome: "activated", workspaceKind: "folder" },
    });
    expectActivityLogProof("task-workspace.lifecycle.line", formatActivityLogProofLine(line ?? {}));
    expect(JSON.stringify(line)).not.toContain(root);
    expect(evidence).toHaveLength(1);
  });

  it("is re-activated through setActive without any Git read or lock", async () => {
    const { service } = fixture();
    const first = service.selectFolder({ root, requestedBy: "test" });
    const again = await service.setActive({
      workspaceId: first.instance.workspaceId,
      requestedBy: "test",
      acquireLock: false,
    });
    expect(again.instance.workspaceId).toBe(first.instance.workspaceId);
    expect(() =>
      service.setActive({
        workspaceId: first.instance.workspaceId,
        requestedBy: "test",
        acquireLock: true,
      }),
    ).toThrow(expect.objectContaining({ code: "LOCK_CONTENTION" }));
  });

  it("refuses an unregistered folder, a repository and a symbolic link, each classified and logged", () => {
    const { service, log } = fixture(createBufferedServerLogSink(), null);
    expect(() => service.selectFolder({ root, requestedBy: "test" })).toThrow(TaskWorkspaceError);
    expect(log.events.at(-1)).toMatchObject({
      op: "task-workspace.lifecycle",
      extra: { operation: "activate", workspaceKind: "folder" },
      errorKind: "unavailable",
    });

    const repo = fixture();
    execFileSync("git", ["-C", root, "init", "-q"]);
    expect(() => repo.service.selectFolder({ root, requestedBy: "test" })).toThrow(
      /Git repository/u,
    );
    rmSync(join(root, ".git"), { recursive: true, force: true });

    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      const linked = fixture(createBufferedServerLogSink(), link);
      expect(() => linked.service.selectFolder({ root: link, requestedBy: "test" })).toThrow(
        /canonical directory/u,
      );
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("fails closed when the bound folder is replaced under the same path", () => {
    const { service } = fixture();
    service.selectFolder({ root, requestedBy: "test" });
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    expect(service.getActive()).toBeUndefined();
  });

  it("admits a run on the folder with the folder's own head and no Git read", () => {
    const { service } = fixture();
    const active = service.selectFolder({ root, requestedBy: "test" });
    const input = {
      workspaceLifecycle: service,
      managedTaskWorkspaceRoot: tmpdir(),
      deploymentCeiling: "supervised-coding" as const,
      readWorkspaceHead: (): never => {
        throw new Error("a folder workspace must never read a Git head");
      },
    };
    const context = resolveProductionRuntimeContext(input, {
      runId: "run-folder-1",
      requestId: "request-1",
      taskIntent: "write a note",
      requestedMode: "supervised-coding",
      workspaceId: active.instance.workspaceId,
      workspaceRoot: root,
      serverPrincipal: "operator-1",
    });
    expect(context).toMatchObject({
      workspaceKind: "folder",
      branchRef: FOLDER_WORKSPACE_BRANCH,
      workspaceId: active.instance.workspaceId,
    });
    expect(productionWorkspaceMatches(input, context)).toBe(true);
  });
});
