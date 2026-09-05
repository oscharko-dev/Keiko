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
import type {
  GitProcessOptions,
  GitProcessResult,
  GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import type {
  GitChangeSnapshot,
  GitChangeSnapshotResult,
} from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { createRelationshipStorePort } from "./relationship-handlers.js";
import type { RelationshipHandlerDeps } from "./relationship-handlers.js";
import { runMigrations } from "./store/schema.js";
import { createInMemoryUiStore, invalidRequest, type UiStore } from "./store/index.js";
import {
  GIT_CHANGE_ROUTE_GROUP,
  handleGitChangeConnect,
  handleGitChangeRefresh,
} from "./gitChangeRoutes.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { STREAMING } from "./routes.js";
import type { ServerLogEvent } from "./observability/server-log.js";

const connectHandler = handleGitChangeConnect;
const refreshHandler = handleGitChangeRefresh;

function asRouteResult(outcome: RouteResult | typeof STREAMING): RouteResult {
  if (outcome === STREAMING) throw new Error("expected a route result, got STREAMING");
  return outcome;
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

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
  req.resume = (): void => undefined;
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

function fakeRunnerResult(
  args: readonly string[],
  script: RunnerScript,
  repositoryRoot: string,
): GitProcessResult {
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
}

function fakeRunner(script: RunnerScript): GitProcessRunner {
  const repositoryRoot = script.repositoryRoot ?? "/repo";
  return (args: readonly string[], _options: GitProcessOptions): Promise<GitProcessResult> =>
    Promise.resolve(fakeRunnerResult(args, script, repositoryRoot));
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
      kinds: {
        add: 1,
        modify: 2,
        delete: 0,
        rename: 0,
        copy: 0,
        "mode-change": 0,
        binary: 0,
        submodule: 0,
      },
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
    close: (): void => undefined,
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

// Pull-request-mode (contract correction 7) tests never hit the real network or spawn `gh`: the
// GitHub-reader authorization decision and the adapter's `findPullRequestsByHead` read are both
// injected through this slot rather than the real `deps.store` grant + `gh` process.
interface PullRequestByHeadSlot {
  authorized: boolean;
  identities: readonly {
    readonly number: number;
    readonly externalId: string;
    readonly url: string;
    readonly repository: string;
    readonly headRepository: string;
    readonly headRef: string;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly state: "open" | "closed";
    readonly isDraft: boolean;
  }[];
}

const pullRequestByHeadSlot = vi.hoisted<PullRequestByHeadSlot>(() => ({
  authorized: false,
  identities: [],
}));

vi.mock("./coding-context/githubIssueReaderAuthorization.js", () => ({
  isGitHubIssueReaderAuthorized: (): boolean => pullRequestByHeadSlot.authorized,
  githubRemoteOwnerAndRepoFor: (): Promise<string> => Promise.resolve("acme/widgets"),
}));

vi.mock("@oscharko-dev/keiko-tools/internal/git-mutation", async () => {
  const actual = await vi.importActual<
    typeof import("@oscharko-dev/keiko-tools/internal/git-mutation")
  >("@oscharko-dev/keiko-tools/internal/git-mutation");
  return {
    ...actual,
    createNodeGitPullRequestAdapter: (): {
      findPullRequestsByHead: () => Promise<{
        readonly ok: true;
        readonly value: PullRequestByHeadSlot["identities"];
      }>;
    } => ({
      findPullRequestsByHead: (): Promise<{
        readonly ok: true;
        readonly value: PullRequestByHeadSlot["identities"];
      }> => Promise.resolve({ ok: true, value: pullRequestByHeadSlot.identities }),
    }),
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

interface GitChangeScopeBody {
  readonly status: string;
  readonly reason?: string;
  readonly scope?: {
    readonly relationshipId: string;
    readonly remoteDigest: string;
    readonly snapshotDigest: string;
    readonly descriptionStatus: string;
  };
}

function connectRequestBody(chatId: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    chatId,
    mode: "comparison",
    headRef: "feature/x",
    baseRef: "main",
  };
}

describe("POST /api/git-change/connect (Issue #3400)", () => {
  it("blocks with detached-head before any relationship or scope is created", async () => {
    const { deps, chatStore } = buildHarness({
      runnerScript: { detached: true },
      snapshots: [],
    });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx(connectRequestBody(chat.id));
    const result = asRouteResult(await connectHandler(ctx, deps));
    expect(result.body).toEqual({ status: "blocked", reason: "detached-head" });
    expect(chatStore.findChatById(chat.id)?.gitChangeScopes ?? []).toHaveLength(0);
  });

  it("blocks with unborn-head before capture runs", async () => {
    const { deps, chatStore } = buildHarness({ runnerScript: { unborn: true }, snapshots: [] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx(connectRequestBody(chat.id));
    const result = asRouteResult(await connectHandler(ctx, deps));
    expect(result.body).toEqual({ status: "blocked", reason: "unborn-head" });
  });

  it("connects an exact comparison: creates a git-change relationship and persists the chat scope", async () => {
    const snapshot = fixtureSnapshot();
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [snapshot] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx(connectRequestBody(chat.id));
    const result = asRouteResult(await connectHandler(ctx, deps));
    const body = result.body as GitChangeScopeBody;
    expect(body.status).toBe("connected");
    const relationshipId = requireDefined(body.scope, "connect response scope").relationshipId;

    const scopes = chatStore.findChatById(chat.id)?.gitChangeScopes ?? [];
    expect(scopes).toHaveLength(1);
    const persisted = requireDefined(scopes[0], "persisted git-change scope");
    expect(persisted.remoteDigest).toBe(snapshot.remoteDigest);
    expect(persisted.descriptionStatus).toBe("current");

    const store = requireDefined(deps.relationship, "relationship deps").store;
    const relationship = requireDefined(
      store.getRelationship("ws-1", relationshipId),
      "created relationship",
    );
    expect(relationship.type).toBe("reads-context");
    expect(relationship.source).toMatchObject({ kind: "chat", id: chat.id });
    expect(relationship.target.kind).toBe("git-change");
  });

  // Owner audit b3-9 — `persistConnectedScope` used to append the 9th scope without checking the
  // store's cap, and the call sat outside the handler's blocked-outcome `try`, so
  // `validatePatchGitChangeScopes` (store/chats.ts) threw a `UiStoreError` straight out of the
  // route instead of a closed result. Failing-before: `connectHandler` rejected with an uncaught
  // "gitChangeScopes must contain at most 8 entries." error instead of resolving to a 409 result.
  it("rejects a 9th connect with a closed error instead of an uncaught store exception (b3-9)", async () => {
    const snapshots = Array.from({ length: 9 }, (_, index) =>
      fixtureSnapshot({ snapshotDigest: String(index).repeat(64) }),
    );
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");

    for (let index = 0; index < 8; index += 1) {
      const result = asRouteResult(
        await connectHandler(makeCtx(connectRequestBody(chat.id)), deps),
      );
      expect((result.body as GitChangeScopeBody).status).toBe("connected");
    }
    expect(chatStore.findChatById(chat.id)?.gitChangeScopes ?? []).toHaveLength(8);

    const ninth = asRouteResult(await connectHandler(makeCtx(connectRequestBody(chat.id)), deps));
    expect(ninth.status).toBe(409);
    expect(ninth.body).toMatchObject({ error: { code: "GIT_CHANGE_SCOPE_LIMIT_REACHED" } });
    expect(chatStore.findChatById(chat.id)?.gitChangeScopes ?? []).toHaveLength(8);
  });

  it("archives the created relationship and reports a distinct persistence failure", async () => {
    const { deps, chatStore } = buildHarness({
      runnerScript: {},
      snapshots: [fixtureSnapshot()],
    });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    vi.spyOn(chatStore, "updateChat").mockImplementationOnce(() => {
      throw invalidRequest("simulated malformed persisted scope");
    });
    const events: ServerLogEvent[] = [];
    const wiredDeps = {
      ...deps,
      activityLog: { write: (event): void => void events.push(event) },
    } satisfies UiHandlerDeps;

    const result = asRouteResult(
      await connectHandler(makeCtx(connectRequestBody(chat.id)), wiredDeps),
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "GIT_CHANGE_SCOPE_PERSIST_FAILED" } });
    const relationship = requireDefined(deps.relationship, "relationship deps").store;
    expect(relationship.getRelationship("ws-1", "rel-00000001")?.lifecycleState).toBe("archived");
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git-change.chat.blocked",
        extra: { reason: "GIT_CHANGE_SCOPE_PERSIST_FAILED" },
      }),
    );
  });
});

function pullRequestIdentity(
  overrides: Partial<PullRequestByHeadSlot["identities"][number]> = {},
): PullRequestByHeadSlot["identities"][number] {
  return {
    number: 42,
    externalId: "PR_1",
    url: "https://github.com/acme/widgets/pull/42",
    repository: "acme/widgets",
    headRepository: "acme/widgets",
    headRef: "feature/x",
    headSha: "b".repeat(40),
    baseRef: "main",
    baseSha: "a".repeat(40),
    state: "open",
    isDraft: false,
    ...overrides,
  };
}

// Contract correction 7 — "one existing same-repository PR" resolution. Gated by the per-checkout
// GitHub-reader grant; an ambiguous or missing match blocks rather than silently falling back to a
// local comparison the user did not select.
describe("POST /api/git-change/connect — pull-request mode (contract correction 7)", () => {
  afterEach(() => {
    pullRequestByHeadSlot.authorized = false;
    pullRequestByHeadSlot.identities = [];
  });

  it("blocks with reader-unauthorized when the GitHub-reader grant is missing", async () => {
    pullRequestByHeadSlot.authorized = false;
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "pull-request",
      headRef: "feature/x",
    });
    const result = asRouteResult(await connectHandler(ctx, deps));
    expect(result.body).toEqual({ status: "blocked", reason: "reader-unauthorized" });
  });

  it("blocks with no-pull-request when no open PR matches the head branch", async () => {
    pullRequestByHeadSlot.authorized = true;
    pullRequestByHeadSlot.identities = [];
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "pull-request",
      headRef: "feature/x",
    });
    const result = asRouteResult(await connectHandler(ctx, deps));
    expect(result.body).toEqual({ status: "blocked", reason: "no-pull-request" });
  });

  it("blocks with ambiguous-pull-request when more than one open PR matches the head branch", async () => {
    pullRequestByHeadSlot.authorized = true;
    pullRequestByHeadSlot.identities = [
      pullRequestIdentity({ number: 42, externalId: "PR_1" }),
      pullRequestIdentity({ number: 43, externalId: "PR_2" }),
    ];
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "pull-request",
      headRef: "feature/x",
    });
    const result = asRouteResult(await connectHandler(ctx, deps));
    expect(result.body).toEqual({ status: "blocked", reason: "ambiguous-pull-request" });
    expect(chatStore.findChatById(chat.id)?.gitChangeScopes ?? []).toHaveLength(0);
  });

  it("connects the exactly-one matching open PR and records its number on the scope", async () => {
    pullRequestByHeadSlot.authorized = true;
    pullRequestByHeadSlot.identities = [pullRequestIdentity({ number: 42 })];
    const snapshot = fixtureSnapshot();
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [snapshot] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const ctx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      mode: "pull-request",
      headRef: "feature/x",
    });
    const result = asRouteResult(await connectHandler(ctx, deps));
    const body = result.body as GitChangeScopeBody & {
      readonly scope?: { readonly pullRequestNumber?: number; readonly comparisonLabel: string };
    };
    expect(body.status).toBe("connected");
    expect(body.scope?.pullRequestNumber).toBe(42);
    expect(body.scope?.comparisonLabel).toBe("PR #42");
  });
});

describe("POST /api/git-change/refresh (Issue #3400)", () => {
  it("reports current when the re-check matches the stored snapshot", async () => {
    const snapshot = fixtureSnapshot();
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [snapshot, snapshot] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const connected = asRouteResult(
      await connectHandler(makeCtx(connectRequestBody(chat.id)), deps),
    );
    const relationshipId = (connected.body as GitChangeScopeBody).scope?.relationshipId ?? "";

    const refreshCtx = makeCtx({ schemaVersion: "1", chatId: chat.id, relationshipId });
    const refreshed = asRouteResult(await refreshHandler(refreshCtx, deps));
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
    const connected = asRouteResult(
      await connectHandler(makeCtx(connectRequestBody(chat.id)), deps),
    );
    const oldRelationshipId = requireDefined(
      (connected.body as GitChangeScopeBody).scope,
      "connect response scope",
    ).relationshipId;

    const refreshCtx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      relationshipId: oldRelationshipId,
    });
    const refreshed = asRouteResult(await refreshHandler(refreshCtx, deps));
    const body = refreshed.body as GitChangeScopeBody;
    expect(body.status).toBe("stale");
    const staleScope = requireDefined(body.scope, "refresh response scope");
    expect(staleScope.relationshipId).not.toBe(oldRelationshipId);
    expect(staleScope.snapshotDigest).toBe(moved.snapshotDigest);
    expect(staleScope.descriptionStatus).toBe("stale");

    // Correction 4: the OLD relationship is archived, never mutated or deleted.
    const store = requireDefined(deps.relationship, "relationship deps").store;
    const oldRelationship = requireDefined(
      store.getRelationship("ws-1", oldRelationshipId),
      "archived relationship",
    );
    expect(oldRelationship.lifecycleState).toBe("archived");

    const scopes = chatStore.findChatById(chat.id)?.gitChangeScopes ?? [];
    expect(scopes).toHaveLength(1);
    expect(requireDefined(scopes[0], "refreshed persisted scope").relationshipId).toBe(
      staleScope.relationshipId,
    );
  });

  // Owner audit b3-8 — `persistStaleScope` used to archive the old relationship, THEN create the
  // replacement; a failing create (a store-level conflict) left the chat pointing at a relationship
  // that had already been archived out from under it. Failing-before: with the old
  // archive-then-create order, `oldRelationship.lifecycleState` below was "archived" even though
  // the refresh that was supposed to replace it never produced a replacement.
  it("keeps the old relationship active when the replacement create fails (b3-8)", async () => {
    const original = fixtureSnapshot();
    const moved = fixtureSnapshot({ headSha: "f".repeat(40), snapshotDigest: "9".repeat(64) });
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [original, moved] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const connected = asRouteResult(
      await connectHandler(makeCtx(connectRequestBody(chat.id)), deps),
    );
    const oldRelationshipId = requireDefined(
      (connected.body as GitChangeScopeBody).scope,
      "connect response scope",
    ).relationshipId;

    const relationship = requireDefined(deps.relationship, "relationship deps");
    const realStore = relationship.store;
    let createCalls = 0;
    const failingStore: typeof realStore = {
      ...realStore,
      createRelationship: (input, audit) => {
        createCalls += 1;
        if (createCalls === 1) throw new Error("simulated store-level create conflict");
        return realStore.createRelationship(input, audit);
      },
    };
    const wiredDeps: UiHandlerDeps = {
      ...deps,
      relationship: { ...relationship, store: failingStore },
    };

    const refreshCtx = makeCtx({
      schemaVersion: "1",
      chatId: chat.id,
      relationshipId: oldRelationshipId,
    });
    await expect(refreshHandler(refreshCtx, wiredDeps)).rejects.toThrow(
      "simulated store-level create conflict",
    );

    const oldRelationship = requireDefined(
      realStore.getRelationship("ws-1", oldRelationshipId),
      "old relationship",
    );
    expect(oldRelationship.lifecycleState).toBe("active");

    const scopes = chatStore.findChatById(chat.id)?.gitChangeScopes ?? [];
    expect(scopes).toHaveLength(1);
    expect(requireDefined(scopes[0], "unchanged persisted scope").relationshipId).toBe(
      oldRelationshipId,
    );
  });

  it("rolls back the chat and archives the replacement when the old edge loses its etag", async () => {
    const original = fixtureSnapshot();
    const moved = fixtureSnapshot({ headSha: "f".repeat(40), snapshotDigest: "9".repeat(64) });
    const { deps, chatStore } = buildHarness({ runnerScript: {}, snapshots: [original, moved] });
    const chat = chatStore.createChat(projectPath(chatStore), "t", "m");
    const connected = asRouteResult(
      await connectHandler(makeCtx(connectRequestBody(chat.id)), deps),
    );
    const oldRelationshipId = requireDefined(
      (connected.body as GitChangeScopeBody).scope,
      "connect response scope",
    ).relationshipId;
    const relationship = requireDefined(deps.relationship, "relationship deps");
    const realStore = relationship.store;
    const missingOldEtagStore: typeof realStore = {
      ...realStore,
      getEtag: (workspaceId, id) =>
        id === oldRelationshipId ? undefined : realStore.getEtag(workspaceId, id),
    };
    const events: ServerLogEvent[] = [];
    const wiredDeps: UiHandlerDeps = {
      ...deps,
      relationship: { ...relationship, store: missingOldEtagStore },
      activityLog: { write: (event): void => void events.push(event) },
    };

    const result = asRouteResult(
      await refreshHandler(
        makeCtx({ schemaVersion: "1", chatId: chat.id, relationshipId: oldRelationshipId }),
        wiredDeps,
      ),
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "GIT_CHANGE_RELATIONSHIP_CONFLICT" } });
    expect(chatStore.findChatById(chat.id)?.gitChangeScopes?.[0]?.relationshipId).toBe(
      oldRelationshipId,
    );
    expect(realStore.getRelationship("ws-1", oldRelationshipId)?.lifecycleState).toBe("active");
    expect(realStore.getRelationship("ws-1", "rel-00000002")?.lifecycleState).toBe("archived");
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git-change.chat.blocked",
        extra: { reason: "relationship-conflict" },
      }),
    );
  });
});

// Frozen Product Decision 6 / DoD bullet 6 — Chat exposes only draft, refine and preview/apply
// PR-description behavior; no generic Git or GitHub operation. This module is the SOLE surface
// #3400 adds, so the negative proof is structural: exactly two routes, no other verb/pattern.
describe("git-change route surface (Frozen Product Decision 6)", () => {
  it("exposes exactly connect and refresh — no branch/fetch/pull/push/PR-create/merge/close route", () => {
    expect(GIT_CHANGE_ROUTE_GROUP).toHaveLength(2);
    const surface = GIT_CHANGE_ROUTE_GROUP.map((route) => `${route.method} ${route.pattern}`);
    expect(surface.sort()).toEqual([
      "POST /api/git-change/connect",
      "POST /api/git-change/refresh",
    ]);
    for (const forbidden of [
      "branch",
      "fetch",
      "pull",
      "push",
      "create",
      "merge",
      "close",
      "checkout",
      "commit",
    ]) {
      expect(surface.some((entry) => entry.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
});
