// Issue #3400 (epic #3384) — gitChangeRoutes.ts connect/refresh route tests.
//
// Strategy: a fake bounded git process runner scripts every membership/head-state check (no real
// `git` invocation needed for THOSE checks), a fake GitChangeSnapshotService scripts the immutable
// snapshot capture, and a REAL in-memory relationship store (backed by real migrations, mirroring
// relationship-handlers.test.ts's own fixture) proves the relationship engine is genuinely
// exercised — not merely mocked. The chat store is the real in-memory UiStore.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { GitProcessOptions, GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";
import type {
  GitChangeSnapshot,
  GitChangeSnapshotResult,
} from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { createRelationshipStorePort } from "./relationship-handlers.js";
import type { RelationshipHandlerDeps } from "./relationship-handlers.js";
import { runMigrations } from "./store/schema.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import { GIT_CHANGE_ROUTE_GROUP } from "./gitChangeRoutes.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";

const [{ handler: connectHandler }, { handler: refreshHandler }] = GIT_CHANGE_ROUTE_GROUP;

interface FakeReq extends EventEmitter {
  headers: Record<string, string>;
  url: string;
  method: string;
  resume(): void;
}

function makeReq(body: unknown): FakeReq {
  const req = new EventEmitter() as FakeReq;
  req.headers = { "content-type": "application/json" };
  req.url = "/";
  req.method = "POST";
  req.resume = (): void => {};
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeCtx(body: unknown): RouteContext {
  return {
    req: makeReq(body) as unknown as IncomingMessage,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://localhost/"),
    correlationId: "corr-1",
  };
}

// ─── Fake git process runner (membership / head-state checks) ─────────────────────────────────

interface RunnerScript {
  readonly detached?: boolean;
  readonly unborn?: boolean;
  readonly repositoryRoot?: string;
}

function fakeRunner(script: RunnerScript): GitProcessRunner {
  const repositoryRoot = script.repositoryRoot ?? "/repo";
  return async (
    args: readonly string[],
    _options: GitProcessOptions,
  ): Promise<GitProcessResult> => {
    void _options;
    const base = (stdout: string, exitCode = 0): GitProcessResult => ({
      exitCode,
      signal: null,
      stdout,
      stderr: "",
      truncated: false,
    });
    if (args.includes("--show-toplevel")) {
      return base(`${repositoryRoot}\n\n`);
    }
    if (args.includes("--verify")) {
      return base("", script.unborn === true ? 1 : 0);
    }
    if (args.includes("status")) {
      const header = script.detached === true ? "# branch.head (detached)\n" : "# branch.head main\n";
      return base(header);
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

// ─── Fake GitChangeSnapshotService ──────────────────────────────────────────────────────────────

function fixtureSnapshot(overrides: Partial<GitChangeSnapshot> = {}): GitChangeSnapshot {
  return {
    schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    repositoryId: "repo_fixture",
    remoteDigest: "d".repeat(64),
    baseRef: "main",
    baseSha: "a".repeat(40),
    headRef: "feature/x",
    headSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    capturedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z",
    outcome: "complete",
    limits: { maxFiles: 400, maxHunksPerFile: 256, maxPatchBytes: 262144, maxTotalBytes: 2097152 },
    completeness: {
      totalFiles: 3,
      files: 3,
      hunks: 5,
      bytes: 1024,
      omittedFiles: 0,
      omittedHunks: 0,
      truncatedFiles: 0,
      kinds: { add: 1, modify: 2, delete: 0, rename: 0, copy: 0, "mode-change": 0, binary: 0, submodule: 0 },
      omissions: [],
    },
    entries: [],
    localDivergence: { stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0 },
    snapshotDigest: "e".repeat(64),
    ...overrides,
  };
}

function fakeSnapshotService(
  results: readonly GitChangeSnapshotResult[],
): UiHandlerDeps["gitChangeSnapshotService"] {
  let index = 0;
  return {
    capture: (): Promise<{ readonly snapshot: GitChangeSnapshotResult }> => {
      const snapshot = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve({ snapshot: snapshot ?? fixtureSnapshot() });
    },
    read: (): undefined => undefined,
    recheck: (): Promise<never> => {
      throw new Error("recheck is not used by gitChangeRoutes.ts");
    },
    close: (): void => {},
  };
}

// ─── Deps assembly ──────────────────────────────────────────────────────────────────────────────

interface Harness {
  readonly deps: UiHandlerDeps;
  readonly chatStore: UiStore;
}

function buildHarness(opts: {
  readonly runnerScript: RunnerScript;
  readonly snapshots: readonly GitChangeSnapshotResult[];
  readonly workspaceId?: string;
}): Harness {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  let t = 1000;
  let n = 0;
  const relationshipStore = createRelationshipStorePort({
    db,
    redactString: (s: string): string => s,
    now: () => ++t,
    newId: () => `rel-${String(++n).padStart(8, "0")}`,
  });
  const relationship: RelationshipHandlerDeps = {
    scopeResolver: (): { readonly workspaceId: string } | undefined =>
      opts.workspaceId === undefined ? { workspaceId: "ws-1" } : { workspaceId: opts.workspaceId },
    store: relationshipStore,
  };
  const chatStore = createInMemoryUiStore();
  const deps = {
    store: chatStore,
    relationship,
    gitChangeSnapshotService: fakeSnapshotService(opts.snapshots),
    redactor: (value: unknown): unknown => value,
    env: process.env,
    activityLog: undefined,
  } as unknown as UiHandlerDeps;
  // gitChangeRoutes.ts builds its own observed runner from `defaultGitProcessRunner` directly
  // (matching every other Git route's module default), so the fake below is installed as that
  // default for the whole test process via the module mock, never routed through `deps`.
  gitRunnerSlot.current = fakeRunner({ repositoryRoot: repoRoot, ...opts.runnerScript });
  return { deps, chatStore };
}

// gitChangeRoutes.ts imports `defaultGitProcessRunner` directly (not through deps), matching every
// other Git route's module-level default. Tests substitute it per-test via this mutable slot.
const gitRunnerSlot = vi.hoisted<{ current: GitProcessRunner | undefined }>(() => ({
  current: undefined,
}));

vi.mock("@oscharko-dev/keiko-git", async () => {
  const actual =
    await vi.importActual<typeof import("@oscharko-dev/keiko-git")>("@oscharko-dev/keiko-git");
  return {
    ...actual,
    defaultGitProcessRunner: (
      args: readonly string[],
      options: GitProcessOptions,
    ): Promise<GitProcessResult> => {
      if (gitRunnerSlot.current === undefined) throw new Error("no runner installed for this test");
      return gitRunnerSlot.current(args, options);
    },
  };
});

let tmpRoot: string;
let repoRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "keiko-git-change-"));
  repoRoot = realpathSync(mkdirRepo(tmpRoot));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkdirRepo(root: string): string {
  const dir = join(root, "repo");
  mkdirSync(dir);
  return dir;
}

function projectPath(chatStore: UiStore): string {
  chatStore.createProject(repoRoot);
  return repoRoot;
}

describe("POST /api/git-change/connect (Issue #3400)", () => {
  it("blocks with detached-head before any relationship or scope is created", async () => {
    const { deps, chatStore } = buildHarness({
      runnerScript: { detached: true },
      snapshots: [],
    });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "comparison",
      headRef: "feature/x",
      baseRef: "main",
    });
    const result = await connectHandler(ctx, deps);
    if (typeof result !== "object" || result === null || !("body" in result)) {
      throw new Error("expected a route result");
    }
    expect(result.body).toEqual({ status: "blocked", reason: "detached-head" });
    expect(chatStore.findChatById(chat.id)?.gitChangeScopes ?? []).toHaveLength(0);
  });

  it("blocks with unborn-head before capture runs", async () => {
    const { deps, chatStore } = buildHarness({ runnerScript: { unborn: true }, snapshots: [] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "comparison",
      headRef: "feature/x",
      baseRef: "main",
    });
    const result = await connectHandler(ctx, deps);
    if (typeof result !== "object" || result === null || !("body" in result)) {
      throw new Error("expected a route result");
    }
    expect(result.body).toEqual({ status: "blocked", reason: "unborn-head" });
  });

  it("connects an exact comparison: creates a git-change relationship and persists the chat scope", async () => {
    const snapshot = fixtureSnapshot();
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [snapshot] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "comparison",
      headRef: "feature/x",
      baseRef: "main",
    });
    const result = await connectHandler(ctx, deps);
    if (typeof result !== "object" || result === null || !("body" in result)) {
      throw new Error("expected a route result");
    }
    const body = result.body as { readonly status: string; readonly scope?: { readonly relationshipId: string } };
    expect(body.status).toBe("connected");
    expect(body.scope?.relationshipId).toBeDefined();

    const fetched = chatStore.findChatById(chat.id);
    expect(fetched?.gitChangeScopes).toHaveLength(1);
    expect(fetched?.gitChangeScopes?.[0]?.remoteDigest).toBe(snapshot.remoteDigest);
    expect(fetched?.gitChangeScopes?.[0]?.descriptionStatus).toBe("current");

    const relationship = deps.relationship?.store.getRelationship(
      "ws-1",
      fetched?.gitChangeScopes?.[0]?.relationshipId ?? "",
    );
    expect(relationship?.type).toBe("reads-context");
    expect(relationship?.source).toMatchObject({ kind: "chat", id: chat.id });
    expect(relationship?.target.kind).toBe("git-change");
  });
});

describe("POST /api/git-change/refresh (Issue #3400)", () => {
  it("reports current when the re-check matches the stored snapshot", async () => {
    const snapshot = fixtureSnapshot();
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [snapshot, snapshot] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const connectCtx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "comparison",
      headRef: "feature/x",
      baseRef: "main",
    });
    const connected = await connectHandler(connectCtx, deps);
    if (typeof connected !== "object" || connected === null || !("body" in connected)) {
      throw new Error("expected a route result");
    }
    const relationshipId = (connected.body as { readonly scope: { readonly relationshipId: string } })
      .scope.relationshipId;

    const refreshCtx = makeCtx({ schemaVersion: "1", chatId: chat.id, relationshipId });
    const refreshed = await refreshHandler(refreshCtx, deps);
    if (typeof refreshed !== "object" || refreshed === null || !("body" in refreshed)) {
      throw new Error("expected a route result");
    }
    expect(refreshed.body).toMatchObject({ status: "current" });
  });

  it("archives the stale relationship and creates a new one when the head moved", async () => {
    const original = fixtureSnapshot();
    const moved = fixtureSnapshot({
      headSha: "f".repeat(40),
      snapshotDigest: "9".repeat(64),
    });
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [original, moved] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const connectCtx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "comparison",
      headRef: "feature/x",
      baseRef: "main",
    });
    const connected = await connectHandler(connectCtx, deps);
    if (typeof connected !== "object" || connected === null || !("body" in connected)) {
      throw new Error("expected a route result");
    }
    const oldRelationshipId = (
      connected.body as { readonly scope: { readonly relationshipId: string } }
    ).scope.relationshipId;

    const refreshCtx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      relationshipId: oldRelationshipId,
    });
    const refreshed = await refreshHandler(refreshCtx, deps);
    if (typeof refreshed !== "object" || refreshed === null || !("body" in refreshed)) {
      throw new Error("expected a route result");
    }
    const body = refreshed.body as {
      readonly status: string;
      readonly scope: { readonly relationshipId: string; readonly snapshotDigest: string; readonly descriptionStatus: string };
    };
    expect(body.status).toBe("stale");
    expect(body.scope.relationshipId).not.toBe(oldRelationshipId);
    expect(body.scope.snapshotDigest).toBe(moved.snapshotDigest);
    expect(body.scope.descriptionStatus).toBe("stale");

    // Correction 4: the OLD relationship is archived, never mutated or deleted.
    const oldRelationship = deps.relationship?.store.getRelationship("ws-1", oldRelationshipId);
    expect(oldRelationship?.lifecycleState).toBe("archived");

    const fetched = chatStore.findChatById(chat.id);
    expect(fetched?.gitChangeScopes).toHaveLength(1);
    expect(fetched?.gitChangeScopes?.[0]?.relationshipId).toBe(body.scope.relationshipId);
  });
});
