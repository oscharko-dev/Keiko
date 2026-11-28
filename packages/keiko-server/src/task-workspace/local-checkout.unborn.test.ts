import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { readProductionWorkspaceHead } from "../coding-runtime/productionWorkspaceHeadReader.js";
import {
  productionWorkspaceMatches,
  resolveProductionRuntimeContext,
} from "../coding-runtime/productionRuntimeWorkspaceAuthority.js";
import { createInMemoryUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "./active-store.js";
import { withLocalCheckout } from "./local-checkout.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import type { WorkspaceLifecycleService } from "./types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

// #4491: a fresh `git init` (HEAD symbolic on a branch whose ref does not exist yet) opens in the
// Workbench for its first commit, without an issue binding (owner decision 2026-10-30).
const ZERO = "0".repeat(40);

let unbornRoot: string;
let db: DatabaseSync;

function ugit(...args: readonly string[]): string {
  return execFileSync("git", ["-C", unbornRoot, ...args], { encoding: "utf8" }).trim();
}

function noopEvidenceStore(): EvidenceStore {
  return {
    put: (id): string => id,
    list: (): readonly string[] => [],
    get: (): undefined => undefined,
    delete: (): void => undefined,
  };
}

function unbornFixture(activityLog?: ServerLogSink): ReturnType<typeof withLocalCheckout> {
  const uiStore = createInMemoryUiStore();
  uiStore.createProject(unbornRoot, "unborn-fixture");
  const pointer = buildActiveWorkspacePointerStoreOverDatabase(db);
  const managed = {
    list: (): readonly [] => [],
    listAll: (): readonly [] => [],
    getActive: (): undefined => undefined,
    clearActive: (): void => {
      pointer.clear();
    },
  } as unknown as WorkspaceLifecycleService;
  return withLocalCheckout(managed, pointer, uiStore, buildWorkspaceInstanceStoreOverDatabase(db), {
    activityLog,
    evidenceStore: noopEvidenceStore(),
    redactString: (v): string => v,
    now: Date.now,
  });
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  unbornRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko unborn checkout-")));
  ugit("init", "-q", "-b", "main");
  ugit("config", "user.email", "test@example.invalid");
  ugit("config", "user.name", "Keiko Test");
  ugit("config", "commit.gpgsign", "false");
  writeFileSync(join(unbornRoot, "a.txt"), "a\n");
  writeFileSync(join(unbornRoot, "b.txt"), "b\n");
});

afterEach(() => {
  db.close();
  rmSync(unbornRoot, { recursive: true, force: true });
});

function select(
  service: ReturnType<typeof withLocalCheckout>,
  branch = "main",
  correlationId?: string,
): ReturnType<ReturnType<typeof withLocalCheckout>["selectLocal"]> {
  return service.selectLocal({
    root: unbornRoot,
    branch,
    requestedBy: "test",
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

describe("an unborn repository", () => {
  it("is selected on its unborn branch without switching, and stays active", () => {
    const log = createBufferedServerLogSink();
    const service = unbornFixture(log);
    vi.mocked(execFileSync).mockClear();
    const selected = select(service, "main", "corr-unborn");
    expect(selected.instance).toMatchObject({
      taskBranch: "main",
      baseBranch: "main",
      lastVerifiedHead: ZERO,
    });
    const switched = vi
      .mocked(execFileSync)
      .mock.calls.some((call) => call[1]?.includes("switch") === true);
    expect(switched).toBe(false);
    expect(service.getActive()?.instance.lastVerifiedHead).toBe(ZERO);
    const activated = log.events.find((event) => event.extra?.outcome === "activated");
    expect(activated).toMatchObject({
      op: "task-workspace.lifecycle",
      correlationId: "corr-unborn",
      extra: { operation: "activate", outcome: "activated", headState: "unborn" },
    });
  });

  it("leaves the lines of a born repository without the unborn marker", () => {
    select(unbornFixture());
    ugit("add", "a.txt");
    ugit("commit", "-qm", "first");
    const log = createBufferedServerLogSink();
    select(unbornFixture(log));
    const activated = log.events.find((event) => event.extra?.outcome === "activated");
    expect(activated).toBeDefined();
    expect(activated?.extra).not.toHaveProperty("headState");
  });

  it("still refuses any other missing branch and keeps the active pointer", () => {
    const service = unbornFixture();
    const original = select(service);
    for (const branch of ["feature", "-main", "bad..name"]) {
      expect(() => select(service, branch)).toThrow();
    }
    expect(ugit("symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(service.getActive()?.instance.workspaceId).toBe(original.instance.workspaceId);
  });

  it("refuses a branch ref that is not an absent file", () => {
    mkdirSync(join(unbornRoot, ".git", "refs", "heads", "main"), { recursive: true });
    expect(() => select(unbornFixture())).toThrow();
  });

  it("keeps an unreadable HEAD as an unreachable repository, not a missing branch", () => {
    writeFileSync(join(unbornRoot, ".git", "HEAD"), "garbage\n");
    expect(() => select(unbornFixture())).toThrow(
      expect.objectContaining({ code: "REPOSITORY_UNREACHABLE" }),
    );
  });

  it("reads a commit made outside as an update of the same checkout, never as drift", () => {
    const service = unbornFixture();
    const selected = select(service);
    ugit("add", "a.txt");
    ugit("commit", "-qm", "first");
    const active = service.getActive();
    expect(active?.instance.workspaceId).toBe(selected.instance.workspaceId);
    expect(active?.instance.lastVerifiedHead).toBe(ugit("rev-parse", "HEAD"));
    expect(service.admitTaskBranch(selected.instance.workspaceId)).toBe("admitted");
  });

  it("admits a task branch from the unborn branch and adopts it with the head still unborn", () => {
    const service = unbornFixture();
    const { instance } = select(service);
    expect(service.admitTaskBranch(instance.workspaceId)).toBe("admitted");
    ugit("symbolic-ref", "HEAD", "refs/heads/feature/first");
    const adopted = service.adoptTaskBranch({
      workspaceId: instance.workspaceId,
      branch: "feature/first",
      baseBranch: "main",
    });
    expect(adopted.instance).toMatchObject({
      taskBranch: "feature/first",
      baseBranch: "main",
      lastVerifiedHead: ZERO,
    });
  });

  it("restores a persisted unborn workspace through the ordinary active-workspace action", async () => {
    const log = createBufferedServerLogSink();
    const service = unbornFixture(log);
    const selected = select(service);
    service.clearActive();
    expect(service.getActive()).toBeUndefined();
    const restored = await service.setActive({
      workspaceId: selected.instance.workspaceId,
      requestedBy: "history",
      acquireLock: false,
    });
    expect(restored.instance).toMatchObject({ taskBranch: "main", lastVerifiedHead: ZERO });
    const marked = log.events.filter(
      (event) => event.extra?.outcome === "activated" && event.extra.headState === "unborn",
    );
    expect(marked).toHaveLength(2);
    expect(service.getActive()?.instance.workspaceId).toBe(selected.instance.workspaceId);
  });

  it("starts a run whose authority matches the unborn workspace", () => {
    const service = unbornFixture();
    const { instance } = select(service);
    const runtime: Parameters<typeof productionWorkspaceMatches>[0] = {
      workspaceLifecycle: service,
      managedTaskWorkspaceRoot: unbornRoot,
      deploymentCeiling: "autonomous-delivery",
      readWorkspaceHead: readProductionWorkspaceHead,
    };
    const context = resolveProductionRuntimeContext(runtime, {
      runId: "run-unborn",
      requestId: "request-unborn",
      taskIntent: "Create the project",
      requestedMode: "autonomous-delivery",
      workspaceId: instance.workspaceId,
      workspaceRoot: unbornRoot,
      serverPrincipal: "test",
    });
    expect(productionWorkspaceMatches(runtime, context)).toBe(true);
  });
});
